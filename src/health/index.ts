import { createServer, type Server } from "node:http";
import type { Bot } from "grammy";
import { getConfig } from "../config/index.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("health");

const TELEGRAM_CHECK_MS = 2 * 60_000;        // 2 min
const SDK_CHECK_MS = 5 * 60_000;             // 5 min
const STUCK_CHECK_MS = 30_000;               // 30s
const TELEGRAM_TIMEOUT_MS = 10_000;          // 10s
const SDK_TIMEOUT_MS = 30_000;               // 30s
const STUCK_THRESHOLD_MS = 90_000;           // 90s
const SDK_ALERT_WINDOW_MS = 10 * 60_000;     // 10 min
const SDK_ALERT_THRESHOLD = 3;
const POLLING_STALE_MS = 5 * 60_000;         // 5 min — no-message threshold for watchdog restart
const STALE_RESTART_COOLDOWN_MS = 10 * 60_000; // 10 min — min gap between stale-triggered restarts

type ComponentStatus = "ok" | "error" | "restarting" | "recovering";

export interface HealthState {
  telegram: { status: ComponentStatus; lastCheck: number | null };
  sdk: { status: ComponentStatus; lastCheck: number | null; failCount: number };
  lastMessageAt: number | null;
  lastClassifyAt: number | null;
}

interface HealthMonitorDeps {
  getBot: () => Bot;
  stopBot: () => Promise<void>;
  startBot: () => Promise<void>;
  pingSession: () => Promise<boolean>;
  restartSession: () => Promise<void>;
  alertChatId: number;
}

export class HealthMonitor {
  private state: HealthState = {
    telegram: { status: "ok", lastCheck: null },
    sdk: { status: "ok", lastCheck: null, failCount: 0 },
    lastMessageAt: null,
    lastClassifyAt: null,
  };

  private intervals: ReturnType<typeof setInterval>[] = [];
  private httpServer: Server | null = null;
  private activeMessages = new Map<number, number>(); // messageId -> startTime
  private sdkFailures: number[] = []; // timestamps of recent failures
  private lastStalenessRestartAt: number | null = null;
  private deps: HealthMonitorDeps;

  constructor(deps: HealthMonitorDeps) {
    this.deps = deps;
  }

  start(): void {
    const { HEALTH_PORT } = getConfig();

    // Telegram health check — every 2 min
    this.intervals.push(setInterval(() => this.checkTelegram(), TELEGRAM_CHECK_MS));

    // SDK liveness — every 5 min
    this.intervals.push(setInterval(() => this.checkSdk(), SDK_CHECK_MS));

    // Stuck message check — every 30s
    this.intervals.push(setInterval(() => this.checkStuckMessages(), STUCK_CHECK_MS));

    // HTTP /health endpoint
    this.httpServer = createServer((req, res) => {
      if (req.url === "/health" && req.method === "GET") {
        const body = JSON.stringify({
          ...this.state,
          activeMessages: this.activeMessages.size,
          uptime: process.uptime(),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    // Fix: handle EADDRINUSE on fast restarts (e.g. launchctl kickstart -k)
    this.httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log.warn("Port %d already in use, retrying in 1s...", HEALTH_PORT);
        setTimeout(() => this.httpServer?.listen(HEALTH_PORT), 1000);
      } else {
        log.error({ err }, "Health HTTP server error");
      }
    });
    this.httpServer.listen(HEALTH_PORT, () => {
      log.info("Health endpoint listening on port %d", HEALTH_PORT);
    });

    log.info("Health monitor started");
  }

  stop(): void {
    for (const id of this.intervals) clearInterval(id);
    this.intervals = [];
    if (this.httpServer) {
      // Force-close keep-alive connections so the port is released immediately (Node 18.2+)
      (this.httpServer as any).closeAllConnections?.();
      this.httpServer.close();
      this.httpServer = null;
    }
    log.info("Health monitor stopped");
  }

  trackMessageStart(messageId: number): void {
    this.activeMessages.set(messageId, Date.now());
    this.state.lastMessageAt = Date.now();
  }

  trackMessageEnd(messageId: number): void {
    this.activeMessages.delete(messageId);
  }

  trackClassify(): void {
    this.state.lastClassifyAt = Date.now();
  }

  getState(): HealthState {
    return { ...this.state };
  }

  // --- Telegram health ---

  private async checkTelegram(): Promise<void> {
    const now = Date.now();
    const isPollingStale =
      this.state.lastMessageAt !== null &&
      now - this.state.lastMessageAt > POLLING_STALE_MS;

    try {
      const bot = this.deps.getBot();
      await withTimeout(bot.api.getMe(), TELEGRAM_TIMEOUT_MS);
      this.state.telegram = { status: "ok", lastCheck: now };

      // Watchdog: API reachable but no messages for >5 min — polling loop may have died silently
      if (isPollingStale) {
        const cooldownOk =
          !this.lastStalenessRestartAt ||
          now - this.lastStalenessRestartAt > STALE_RESTART_COOLDOWN_MS;
        if (cooldownOk) {
          log.warn(
            { staleMs: now - this.state.lastMessageAt! },
            "No Telegram messages for >5 min despite healthy API; restarting polling loop"
          );
          this.lastStalenessRestartAt = now;
          try {
            await this.deps.stopBot();
            await this.deps.startBot();
            log.info("Polling loop restarted by staleness watchdog");
          } catch (restartErr) {
            log.error({ err: restartErr }, "Failed to restart polling after staleness detection");
          }
        }
      }
    } catch (err) {
      log.error({ err, isPollingStale }, "Telegram health check failed");
      this.state.telegram = { status: "restarting", lastCheck: now };

      try {
        log.warn("Restarting Telegram bot...");
        await this.deps.stopBot();
        await this.deps.startBot();
        this.state.telegram.status = "ok";
        log.info("Telegram bot restarted successfully");
      } catch (restartErr) {
        log.error({ err: restartErr }, "Failed to restart Telegram bot");
        this.state.telegram.status = "error";
      }
    }
  }

  // --- SDK liveness ---

  private async checkSdk(): Promise<void> {
    try {
      const alive = await withTimeout(this.deps.pingSession(), SDK_TIMEOUT_MS);
      if (alive) {
        this.state.sdk = { status: "ok", lastCheck: Date.now(), failCount: 0 };
        return;
      }
      throw new Error("Ping returned false");
    } catch (err) {
      const now = Date.now();
      log.error({ err }, "SDK health check failed");
      this.sdkFailures.push(now);
      // Prune old failures outside the alert window
      this.sdkFailures = this.sdkFailures.filter((t) => now - t < SDK_ALERT_WINDOW_MS);
      this.state.sdk = {
        status: "recovering",
        lastCheck: now,
        failCount: this.sdkFailures.length,
      };

      // Try to restart the session
      try {
        log.warn("Restarting svarog session...");
        await this.deps.restartSession();
        log.info("Svarog session restarted");
        this.state.sdk.status = "ok";
      } catch (restartErr) {
        log.error({ err: restartErr }, "Failed to restart svarog session");
        this.state.sdk.status = "error";
      }

      // Alert if too many failures in the window
      if (this.sdkFailures.length >= SDK_ALERT_THRESHOLD) {
        await this.sendAlert(
          `SDK health: ${this.sdkFailures.length} failures in last 10 minutes. Session may be unstable.`
        );
      }
    }
  }

  // --- Stuck message detection ---

  private checkStuckMessages(): void {
    const now = Date.now();
    for (const [messageId, startTime] of this.activeMessages) {
      const durationMs = now - startTime;
      if (durationMs > STUCK_THRESHOLD_MS) {
        log.warn(
          { messageId, durationMs, durationS: Math.round(durationMs / 1000) },
          "Message handler stuck for >90s"
        );
      }
    }
  }

  // --- Alert ---

  private async sendAlert(text: string): Promise<void> {
    try {
      const bot = this.deps.getBot();
      await bot.api.sendMessage(this.deps.alertChatId, `[HEALTH] ${text}`);
    } catch (err) {
      log.error({ err }, "Failed to send health alert via Telegram");
    }
  }
}

// --- Helpers ---

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timeoutId!));
}
