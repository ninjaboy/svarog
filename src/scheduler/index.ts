import cron, { type ScheduledTask } from "node-cron";
import { notifySvarog } from "../svarog/index.js";
import {
  getEnabledScheduledTasks,
  getScheduledTaskById,
  updateScheduledTaskEnabled,
  updateScheduledTaskLastRun,
  incrementScheduleErrorCount,
  resetScheduleErrorCount,
} from "../db/queries.js";
import { createChildLogger } from "../utils/logger.js";

import type { Dispatcher } from "../dispatcher/index.js";

const log = createChildLogger("scheduler");

export class Scheduler {
  private jobs = new Map<number, ScheduledTask>();
  private running = new Set<number>();
  private dispatcher: Dispatcher;

  constructor(dispatcher: Dispatcher) {
    this.dispatcher = dispatcher;
  }

  /** Load all enabled schedules from DB and register cron jobs. */
  start(): void {
    const tasks = getEnabledScheduledTasks();
    for (const { schedule, project } of tasks) {
      this.registerJob(schedule.id, schedule.cronExpression, schedule.timezone);
    }
    log.info({ count: tasks.length }, "Scheduler started with %d schedule(s)", tasks.length);
  }

  stop(): void {
    for (const [id, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
    this.running.clear();
    log.info("Scheduler stopped");
  }

  /** Register a new cron job for a schedule. Call after inserting into DB. */
  addSchedule(scheduleId: number, cronExpression: string, timezone: string): void {
    // Remove existing job if any (e.g., re-enable)
    this.removeSchedule(scheduleId);
    this.registerJob(scheduleId, cronExpression, timezone);
    log.info({ scheduleId, cronExpression, timezone }, "Schedule added");
  }

  /** Remove a cron job. Call after deleting/disabling in DB. */
  removeSchedule(scheduleId: number): void {
    const existing = this.jobs.get(scheduleId);
    if (existing) {
      existing.stop();
      this.jobs.delete(scheduleId);
      log.info({ scheduleId }, "Schedule removed");
    }
  }

  private registerJob(scheduleId: number, cronExpression: string, timezone: string): void {
    const task = cron.schedule(cronExpression, async () => {
      await this.executeSchedule(scheduleId);
    }, { timezone });

    this.jobs.set(scheduleId, task);
  }

  private async executeSchedule(scheduleId: number): Promise<void> {
    // Guard: skip if a worker from this schedule is still running
    if (this.running.has(scheduleId)) {
      log.warn({ scheduleId }, "Skipping scheduled trigger — previous worker still running");
      return;
    }

    const row = getScheduledTaskById(scheduleId);
    if (!row || !row.schedule.enabled) {
      log.info({ scheduleId }, "Schedule disabled or deleted, skipping execution");
      return;
    }

    const { schedule, project } = row;

    log.info(
      { scheduleId, project: project.name, summary: schedule.userSummary },
      "Executing scheduled task"
    );

    // Notify user via Svarog
    notifySvarog(
      `[SCHEDULED | Schedule #${schedule.id} | ${schedule.emoji || "⏰"} | project: ${project.name}] Running: "${schedule.userSummary}"`
    );

    this.running.add(scheduleId);
    try {
      // Build synthetic intent and route through dispatcher
      const syntheticIntent = {
        id: 0, // no DB intent row for scheduled executions
        type: "spawn_worker" as const,
        project: project.name,
        prompt: `[Scheduled task] ${schedule.userSummary}\n\n${schedule.prompt}`,
        userSummary: `${schedule.emoji || "⏰"} [Scheduled] ${schedule.userSummary}`,
        emoji: schedule.emoji,
        planMode: false, // scheduled tasks execute directly
        workerId: null,
        questionId: null,
        telegramChatId: schedule.telegramChatId,
        telegramMessageId: 0, // no originating message
      };

      await this.dispatcher.handleIntent(syntheticIntent);

      // Update last run
      updateScheduledTaskLastRun(schedule.id);
      resetScheduleErrorCount(schedule.id);

      // If run_once, disable after execution
      if (schedule.runOnce) {
        updateScheduledTaskEnabled(schedule.id, false);
        this.removeSchedule(schedule.id);
        log.info({ scheduleId }, "One-time schedule disabled after execution");
      }
    } catch (err) {
      log.error({ err, scheduleId }, "Scheduled task execution failed");

      const updated = incrementScheduleErrorCount(schedule.id);
      if (updated && updated.errorCount >= updated.maxErrors) {
        updateScheduledTaskEnabled(schedule.id, false);
        this.removeSchedule(schedule.id);
        notifySvarog(
          `[SCHEDULE ERROR | Schedule #${schedule.id}] Disabled after ${updated.errorCount} consecutive failures: "${schedule.userSummary}"`
        );
      }
    } finally {
      this.running.delete(scheduleId);
    }
  }
}
