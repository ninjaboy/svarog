import { getConfig } from "../config/index.js";
import { getIdleWorkers } from "../db/queries.js";
import type { Dispatcher } from "../dispatcher/index.js";
import { createChildLogger } from "../utils/logger.js";
import { captureException } from "../utils/sentry.js";

const log = createChildLogger("watchdog");

export class Watchdog {
  private dispatcher: Dispatcher;
  private intervalMs: number;
  private activeIdleTimeoutS: number;
  private sessionTimeoutS: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private alertedWorkers = new Set<number>();

  constructor(dispatcher: Dispatcher) {
    const config = getConfig();
    this.dispatcher = dispatcher;
    this.intervalMs = config.WATCHDOG_INTERVAL_MS;
    this.activeIdleTimeoutS = config.WORKER_IDLE_TIMEOUT_S;
    this.sessionTimeoutS = config.WORKER_SESSION_TIMEOUT_S;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    log.info(
      "Watchdog started (interval=%dms, idle_timeout=%ds, session_timeout=%ds)",
      this.intervalMs,
      this.activeIdleTimeoutS,
      this.sessionTimeoutS
    );

    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Watchdog stopped");
  }

  private async tick(): Promise<void> {
    try {
      await this.monitorWorkers();
    } catch (err) {
      log.error({ err }, "Watchdog tick error");
      captureException(err);
    }
  }

  private async monitorWorkers(): Promise<void> {
    // Single-tier: monitor active workers that have been idle
    const activeIdleWorkers = getIdleWorkers(this.activeIdleTimeoutS);
    const currentIdleIds = new Set(activeIdleWorkers.map((w) => w.id));

    // Prune workers no longer idle
    for (const id of this.alertedWorkers) {
      if (!currentIdleIds.has(id)) this.alertedWorkers.delete(id);
    }

    for (const worker of activeIdleWorkers) {
      if (this.alertedWorkers.has(worker.id)) {
        // Already alerted — check if past session timeout for cleanup
        const lastActivity = new Date(worker.lastActivityAt + "Z").getTime();
        const idleSeconds = (Date.now() - lastActivity) / 1000;
        if (idleSeconds > this.sessionTimeoutS) {
          log.warn({ workerId: worker.id }, "Worker past session timeout, cleaning up");
          this.dispatcher.cleanupWorker(worker.id);
          this.alertedWorkers.delete(worker.id);
        }
        continue;
      }

      // First time seeing this worker idle — alert
      log.warn({ workerId: worker.id }, "Active worker idle too long");
      await this.dispatcher.handleIdleWorker(worker.id);
      this.alertedWorkers.add(worker.id);
    }
  }
}
