import { WorkerLLM } from "./session.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("worker-pool");

export class WorkerPool {
  private workers = new Map<number, WorkerLLM>();

  add(worker: WorkerLLM): void {
    this.workers.set(worker.id, worker);
    log.info({ workerId: worker.id }, "Worker added to pool");
  }

  get(id: number): WorkerLLM | undefined {
    return this.workers.get(id);
  }

  remove(id: number): void {
    this.workers.delete(id);
    log.info({ workerId: id }, "Worker removed from pool");
  }

  getAll(): WorkerLLM[] {
    return Array.from(this.workers.values());
  }

  size(): number {
    return this.workers.size;
  }

  async stopAll(): Promise<void> {
    log.info("Stopping all %d workers", this.workers.size);
    const promises = Array.from(this.workers.values()).map((w) => {
      w.abort();
      return Promise.resolve();
    });
    await Promise.all(promises);
    this.workers.clear();
  }
}
