import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type SDKResultMessage } from "@anthropic-ai/claude-code";

import { notifySvarog } from "../svarog/index.js";
import {
  getActiveWorkers,
  getAllProjects,
  getProjectByName,
  getResumableWorkers,
  getWorkerById,
  getWorkerWithProject,
  hasCompletionEvent,
  insertEvent,
  insertWorker,
  markIntentProcessed,
  markWorkerStopped,
  updateWorkerState,
} from "../db/queries.js";
import { getConfig } from "../config/index.js";
import { WorkerState } from "../types/index.js";
import { createChildLogger } from "../utils/logger.js";
import { WorkerLLM, WorkerPool } from "../worker/index.js";
import type { WorkerTelegramContext } from "../worker/session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERAL_WORKER_DIR = join(__dirname, "..", "..", "svarog-workspace", "general-worker");

const log = createChildLogger("dispatcher");

function sanitizeResult(text: string): string {
  return text.replace(/\/Users\/[^\s"'<>)}\]]+/g, "[path hidden]");
}

/** Telegram functions injected at startup */
export interface TelegramFunctions {
  sendMessage: (chatId: number, text: string) => Promise<number>;
  sendLongMessage: (chatId: number, text: string) => Promise<number[]>;
  sendQuestionMessage: (
    chatId: number,
    workerId: number,
    questionId: number,
    question: string,
    emoji?: string,
  ) => Promise<number>;
  sendPhoto: (chatId: number, photoPath: string, caption?: string) => Promise<number>;
}

/**
 * In-memory map: telegramMsgId → workerId for reply routing.
 * When a worker sends a message to Telegram, we track it here so that
 * when the user replies to that message, we know which worker to route to.
 */
const messageToWorker = new Map<number, number>();

export function getWorkerIdByTelegramMessage(telegramMsgId: number): number | undefined {
  return messageToWorker.get(telegramMsgId);
}

export class Dispatcher {
  private pool: WorkerPool;
  private telegramFns: TelegramFunctions | null = null;

  constructor() {
    this.pool = new WorkerPool();
  }

  setTelegramFunctions(fns: TelegramFunctions): void {
    this.telegramFns = fns;
  }

  getPool(): WorkerPool {
    return this.pool;
  }

  getWorkerOutput(workerId: number): {
    state: string;
    stdout: string;
    stderr: string;
    events: Array<{ timestamp: Date; type: string; content: string }>;
  } | null {
    const session = this.pool.get(workerId);
    if (!session) {
      const worker = getWorkerById(workerId);
      if (!worker) return null;

      return {
        state: worker.state,
        stdout: '',
        stderr: '',
        events: [{ timestamp: new Date(), type: 'info', content: 'Worker not active in pool' }]
      };
    }

    const output = session.getLastOutput();
    return {
      state: session.state,
      stdout: output.stdout,
      stderr: output.stderr,
      events: output.events
    };
  }

  async handleIntent(intent: {
    id: number;
    type: string;
    project: string | null;
    prompt: string;
    userSummary?: string;
    emoji?: string | null;
    planMode?: boolean;
    workerId: number | null;
    questionId: number | null;
    telegramChatId: number;
    telegramMessageId: number;
  }): Promise<void> {
    log.info({ intentId: intent.id, type: intent.type }, "Handling intent");

    markIntentProcessed(intent.id);

    try {
      switch (intent.type) {
        case "spawn_worker":
          await this.spawnWorker(
            intent.project,
            intent.prompt,
            intent.telegramChatId,
            intent.userSummary,
            intent.emoji,
            intent.planMode ?? true,
          );
          break;

        case "follow_up":
          await this.followUp(intent.workerId, intent.prompt, intent.telegramChatId);
          break;

        case "approve_plan":
          await this.approvePlan(intent.workerId);
          break;

        case "reject_plan":
          await this.rejectPlan(intent.workerId, intent.prompt);
          break;

        case "answer_question":
          await this.handleAnswer(
            intent.questionId,
            intent.prompt,
          );
          break;

        case "stop":
          await this.stopWorker(intent.workerId);
          break;

        case "pause":
          await this.pauseWorker(intent.workerId);
          break;

        case "resume":
        case "restore_worker":
          await this.resolveWorkerSession(intent.workerId, "restore_worker", "Continue your previous task.");
          break;

        case "switch_to_plan":
          await this.switchToPlan(intent.workerId, intent.prompt);
          break;

        case "skip_plan":
          await this.skipPlan(intent.workerId);
          break;

        case "status":
          // Svarog handles status via get_system_state + send_telegram_message
          break;

        case "general":
          break;

        default:
          log.warn({ type: intent.type }, "Unknown intent type");
      }
    } catch (err) {
      log.error({ err, intentId: intent.id }, "Error handling intent");
      notifySvarog(`[ERROR] Intent processing failed: ${(err as Error).message}`);
    }
  }

  // --- Telegram context factory ---

  private makeTelegramContext(chatId: number, emoji: string): WorkerTelegramContext {
    if (!this.telegramFns) throw new Error("Telegram functions not set");
    return {
      chatId,
      emoji,
      sendMessage: this.telegramFns.sendMessage,
      sendLongMessage: this.telegramFns.sendLongMessage,
      sendQuestionMessage: this.telegramFns.sendQuestionMessage,
      sendPhoto: this.telegramFns.sendPhoto,
      trackMessage: (telegramMsgId, workerId) => {
        messageToWorker.set(telegramMsgId, workerId);
      },
    };
  }

  // --- Spawn ---

  private async spawnWorker(
    projectName: string | null,
    prompt: string,
    chatId: number,
    userSummary?: string,
    emoji?: string | null,
    planMode: boolean = true,
  ): Promise<void> {
    if (!projectName) {
      notifySvarog("[ERROR] No project specified for spawn");
      return;
    }

    // Resolve project from DB
    let projectPath: string;
    let projectId: number;
    let resolvedProjectName: string;

    if (projectName === "general") {
      const generalProject = getProjectByName("general");
      if (!generalProject) {
        notifySvarog("[ERROR] General worker project not found in database");
        return;
      }
      projectPath = GENERAL_WORKER_DIR;
      projectId = generalProject.id;
      resolvedProjectName = "general";
    } else {
      const project = getProjectByName(projectName);
      if (!project) {
        const allProjects = getAllProjects();
        const names = allProjects.map((p) => p.name).join(", ");
        notifySvarog(`[ERROR] Project "${projectName}" not found. Available: ${names || "(none)"}`);
        return;
      }
      projectPath = project.path;
      projectId = project.id;
      resolvedProjectName = project.name;
    }

    const workerRow = insertWorker(projectId, prompt, chatId, emoji);
    const workerEmoji = emoji || "🔵";

    // Enrich prompt with evidence instructions
    const enrichedPrompt = prompt + '\n\n' +
      'When you complete your task, include evidence of success: test results, ' +
      'file contents, or command output that proves the work is done correctly. ' +
      'If you are unsure about anything, use AskUserQuestion to ask. ' +
      'When you are ready to propose a plan, use ExitPlanMode.';

    const telegramCtx = this.makeTelegramContext(chatId, workerEmoji);
    const session = new WorkerLLM(
      workerRow.id,
      projectPath,
      enrichedPrompt,
      telegramCtx,
      planMode ? 'plan' : 'default',
    );

    // Wire completion callback
    session.onCompletion = (_wId, _result) => {
      // Completion is handled inside WorkerLLM.handleCompletion() which sends to Telegram directly
      // This callback is for additional cleanup if needed
    };

    this.pool.add(session);

    // Notify user via Svarog
    notifySvarog(
      `[SPAWN | Worker #${workerRow.id} | ${workerEmoji} | project: ${resolvedProjectName} | mode: ${planMode ? 'plan' : 'default'}] Task: "${userSummary || prompt}"`
    );

    // Start worker in background
    session.start().catch((err) => {
      log.error({ err, workerId: workerRow.id }, "Worker start failed");
      updateWorkerState(workerRow.id, WorkerState.Errored);
      notifySvarog(`[ERROR | Worker #${workerRow.id}] Failed to start: ${(err as Error).message}`);
      this.removeWorkerFromPool(workerRow.id);
    });
  }

  // --- Answer handling ---

  private async handleAnswer(
    questionId: number | null,
    answer: string,
  ): Promise<void> {
    if (questionId) {
      // Find the worker that owns this question and resolve it
      for (const session of this.pool.getAll()) {
        if (session.hasQuestion(questionId)) {
          session.resolveQuestion(questionId, answer);
          return;
        }
      }
      log.warn({ questionId }, "No worker found with this question");
      notifySvarog("[ERROR] No worker found with this pending question.");
      return;
    }

    // Try to find a single worker with pending questions
    const workersWithQuestions = this.pool.getAll().filter(
      (w) => w.state === WorkerState.WaitingInput
    );

    if (workersWithQuestions.length === 1) {
      // Auto-route to the only waiting worker — but we don't know the questionId
      notifySvarog("[ERROR] Please reply to the specific question message or tap a button.");
    } else if (workersWithQuestions.length > 1) {
      notifySvarog("[ERROR] Multiple workers waiting. Reply to the specific question.");
    } else {
      notifySvarog("[ERROR] No pending questions to answer.");
    }
  }

  /** Resolve a question by ID — called from callback handler */
  resolveQuestion(questionId: number, answer: string): boolean {
    for (const session of this.pool.getAll()) {
      if (session.resolveQuestion(questionId, answer)) {
        return true;
      }
    }
    log.warn({ questionId }, "No resolver found for question");
    return false;
  }

  /** Resolve a plan review for a worker — called from callback handler */
  resolvePlan(workerId: number, decision: string): boolean {
    const session = this.pool.get(workerId);
    if (session) {
      return session.resolvePlan(decision);
    }
    log.warn({ workerId }, "No worker found for plan resolution");
    return false;
  }

  // --- Session creation from DB ---

  /** Load worker from DB, create cold WorkerLLM, add to pool. Returns null if not found/no sessionId. */
  private createSessionFromDb(workerId: number): WorkerLLM | null {
    const workerData = getWorkerWithProject(workerId);
    if (!workerData?.worker.sessionId) return null;

    const { worker, project } = workerData;
    log.info({ workerId }, "Creating session from DB");
    const telegramCtx = this.makeTelegramContext(worker.telegramChatId, worker.emoji || "🔵");
    const restoredMode = (worker.permissionMode as 'plan' | 'default') || 'plan';
    const session = new WorkerLLM(worker.id, project.path, worker.currentPrompt, telegramCtx, restoredMode);
    session.restorePlanState(restoredMode);
    this.pool.add(session);
    return session;
  }

  // --- Worker session resolver (single path for all intents) ---

  /**
   * Resolve a worker session by ID. Handles auto-detection, DB loading, and cold warm-up.
   * Returns session if warm and ready, null if async warm-up in progress or not found.
   */
  private async resolveWorkerSession(
    workerId: number | null,
    errorContext: string,
    pendingMessage?: string,
  ): Promise<{ session: WorkerLLM; id: number } | null> {
    let targetId = workerId;
    if (!targetId) {
      const active = getActiveWorkers();
      if (active.length === 1) {
        targetId = active[0].id;
      } else {
        notifySvarog(`[ERROR] ${errorContext}: specify which worker.`);
        return null;
      }
    }

    let session: WorkerLLM | undefined = this.pool.get(targetId);

    // Not in pool — try loading from DB (falls through to cold warm-up)
    if (!session) {
      session = this.createSessionFromDb(targetId) ?? undefined;
      if (!session) {
        notifySvarog(`[ERROR | Worker #${targetId}] Worker not found or not running.`);
        return null;
      }
    }

    if (session.isCold()) {
      const worker = getWorkerById(targetId);
      if (worker?.sessionId) {
        const resumeMsg = pendingMessage
          ? `[SYSTEM | Worker #${targetId}] Resuming, delivering your message shortly...`
          : `[SYSTEM | Worker #${targetId}] Resuming...`;
        notifySvarog(resumeMsg);
        session.warmUp(worker.sessionId, pendingMessage)
          .catch((err) => {
            log.error({ err, workerId: targetId }, "Worker warm-up failed");
            updateWorkerState(targetId!, WorkerState.Errored);
            notifySvarog(`[ERROR | Worker #${targetId}] Resume failed: ${(err as Error).message}`);
            this.removeWorkerFromPool(targetId!);
          });
      } else {
        notifySvarog(`[ERROR | Worker #${targetId}] Worker has no session to resume.`);
      }
      return null;
    }

    return { session, id: targetId };
  }

  // --- Follow-up ---

  private async followUp(
    workerId: number | null,
    message: string,
    chatId: number
  ): Promise<void> {
    const resolved = await this.resolveWorkerSession(workerId, "follow_up", message);
    if (!resolved) return;
    const { session, id } = resolved;

    try {
      await session.followUp(message);
    } catch (err) {
      log.error({ err, workerId: id }, "Failed to send follow-up");
      notifySvarog(`[ERROR | Worker #${id}] Worker not found or not running.`);
    }
  }

  // --- Plan approval / rejection ---

  private async approvePlan(workerId: number | null): Promise<void> {
    const resolved = await this.resolveWorkerSession(workerId, "approve_plan");
    if (!resolved) return;
    const { session, id } = resolved;
    if (!session.hasPendingPlan()) {
      notifySvarog(`[ERROR | Worker #${id}] No pending plan to approve.`);
      return;
    }
    session.resolvePlan("APPROVED: User approved the plan.");
  }

  private async rejectPlan(workerId: number | null, feedback: string): Promise<void> {
    const resolved = await this.resolveWorkerSession(workerId, "reject_plan");
    if (!resolved) return;
    const { session, id } = resolved;
    if (!session.hasPendingPlan()) {
      notifySvarog(`[ERROR | Worker #${id}] No pending plan to reject.`);
      return;
    }
    session.resolvePlan(`REJECTED: ${feedback}`);
  }

  // --- Stop / Pause / Resume ---

  private async stopWorker(
    workerId: number | null,
  ): Promise<void> {
    let targetId = workerId;
    if (!targetId) {
      const active = getActiveWorkers();
      if (active.length === 1) {
        targetId = active[0].id;
      } else {
        notifySvarog("[ERROR] Specify which worker to stop.");
        return;
      }
    }

    const session = this.pool.get(targetId);
    if (session) {
      session.abort();
      this.cleanupWorker(targetId);
      notifySvarog(`[STOPPED | Worker #${targetId}]`);
    } else {
      markWorkerStopped(targetId);
      notifySvarog(`[STOPPED | Worker #${targetId}] Marked stopped in DB.`);
    }
  }

  private async pauseWorker(
    workerId: number | null,
  ): Promise<void> {
    if (!workerId) {
      notifySvarog("[ERROR] Specify which worker to pause.");
      return;
    }

    const session = this.pool.get(workerId);
    if (!session) {
      notifySvarog(`[ERROR | Worker #${workerId}] Worker not found.`);
      return;
    }

    if (session.state === WorkerState.WaitingInput) {
      log.warn({ workerId }, "Cannot pause worker in WaitingInput state");
      notifySvarog(`[ERROR | Worker #${workerId}] Worker is waiting for input — can't be paused. Answer the pending question or stop it.`);
      return;
    }

    await session.interrupt();
    notifySvarog(`[PAUSED | Worker #${workerId}]`);
  }

  private async switchToPlan(workerId: number | null, reason: string): Promise<void> {
    const resolved = await this.resolveWorkerSession(workerId, "switch_to_plan");
    if (!resolved) return;
    const { session, id } = resolved;

    if (session.phase === 'planning') {
      notifySvarog(`[ERROR | Worker #${id}] Worker is already in planning mode.`);
      return;
    }

    session.switchToPlanning();

    const followUpMessage = reason
      ? `STOP current work. User wants to go back to planning mode. Reason: ${reason}\n\nRe-evaluate your approach. Create a new plan based on the user's feedback. Use ExitPlanMode when your plan is ready.`
      : `STOP current work. User wants to go back to planning mode.\n\nRe-evaluate your approach and create a new plan. Use ExitPlanMode when your plan is ready.`;

    try {
      await session.followUp(followUpMessage);
      notifySvarog(`[SWITCH_TO_PLAN | Worker #${id}] Switched back to planning mode.`);
    } catch (err) {
      log.error({ err, workerId: id }, "Failed to switch to plan");
      notifySvarog(`[ERROR | Worker #${id}] Failed to switch to plan: ${(err as Error).message}`);
    }
  }

  private async skipPlan(workerId: number | null): Promise<void> {
    const resolved = await this.resolveWorkerSession(workerId, "skip_plan");
    if (!resolved) return;
    const { session, id } = resolved;

    if (session.hasPendingPlan()) {
      session.resolvePlan("APPROVED: User wants to skip plan review and execute directly.");
      notifySvarog(`[SKIP_PLAN | Worker #${id}] Plan review skipped, executing.`);
    } else {
      session.switchToExecution();
      try {
        await session.followUp("STOP planning. User wants to skip the plan review step. Do NOT call ExitPlanMode. Start implementing immediately.");
        notifySvarog(`[SKIP_PLAN | Worker #${id}] Told worker to skip planning and execute.`);
      } catch (err) {
        log.error({ err, workerId: id }, "Failed to skip plan");
        notifySvarog(`[ERROR | Worker #${id}] Failed to skip plan: ${(err as Error).message}`);
      }
    }
  }

  // --- Idle ---

  async handleIdleWorker(workerId: number): Promise<void> {
    notifySvarog(`[IDLE | Worker #${workerId}] Worker seems idle.`);
    insertEvent(workerId, "idle_alert", {});
  }

  // --- Cleanup ---

  private removeWorkerFromPool(workerId: number): void {
    const session = this.pool.get(workerId);
    if (session) session.abort();
    this.pool.remove(workerId);
  }

  cleanupWorker(workerId: number): void {
    this.removeWorkerFromPool(workerId);
    markWorkerStopped(workerId);
    insertEvent(workerId, "removed", { reason: "cleanup" });
  }

  async stopAll(): Promise<void> {
    for (const session of this.pool.getAll()) {
      markWorkerStopped(session.id);
      insertEvent(session.id, "removed", { reason: "shutdown" });
    }
    await this.pool.stopAll();
  }

  // --- Startup cleanup ---

  /** Mark stale/completed workers as stopped. Workers are loaded from DB on demand by resolveWorkerSession. */
  async cleanupStaleWorkers(): Promise<void> {
    const { WORKER_RESUME_MAX_AGE_S } = getConfig();
    const allActive = getActiveWorkers();
    const resumable = getResumableWorkers(WORKER_RESUME_MAX_AGE_S);
    const resumableIds = new Set(resumable.map(w => w.id));

    for (const worker of allActive) {
      if (!resumableIds.has(worker.id)) {
        log.info({ workerId: worker.id, lastActivity: worker.lastActivityAt }, "Marking stale worker as stopped");
        markWorkerStopped(worker.id);
        insertEvent(worker.id, "skipped_resume", { reason: "stale" });
      }
    }

    for (const worker of resumable) {
      if (!worker.sessionId) {
        updateWorkerState(worker.id, WorkerState.Errored);
        insertEvent(worker.id, "skipped_resume", { reason: "no_session_id" });
      } else if (hasCompletionEvent(worker.id)) {
        markWorkerStopped(worker.id);
        insertEvent(worker.id, "skipped_resume", { reason: "already_completed" });
      }
    }

    log.info({ staleMarked: allActive.length - resumable.length }, "Startup cleanup complete");
  }
}
