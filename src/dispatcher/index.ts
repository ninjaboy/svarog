import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type SDKResultMessage } from "@anthropic-ai/claude-code";

import { notifyConcierg } from "../concierg/index.js";
import {
  answerQuestion,
  getActiveWorkers,
  getAllProjects,
  getProjectByName,
  getQuestionById,
  getResumableWorkers,
  getUnansweredQuestions,
  getWorkerById,
  getWorkerWithProject,
  hasCompletionEvent,
  insertEvent,
  insertPendingQuestion,
  insertWorker,
  markIntentProcessed,
  markWorkerStopped,
  updateWorkerState,
} from "../db/queries.js";
import { getConfig } from "../config/index.js";
import { ManagerLLM } from "../manager-llm/index.js";
import { WorkerState } from "../types/index.js";
import type { AskUserQuestionItem } from "../types/index.js";
import { createChildLogger } from "../utils/logger.js";
import { WorkerLLM, WorkerPool } from "../worker/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERAL_WORKER_DIR = join(__dirname, "..", "..", "concierg-workspace", "general-worker");

const log = createChildLogger("dispatcher");

function sanitizeResult(text: string): string {
  return text.replace(/\/Users\/[^\s"'<>)}\]]+/g, "[path hidden]");
}

// In-memory map of pending question resolvers (fallback for non-ManagerLLM workers)
const questionResolvers = new Map<number, (answer: string) => void>();

export class Dispatcher {
  private pool: WorkerPool;
  private managerLLMs = new Map<number, ManagerLLM>();
  private mllmInitiatedFollowUps = new Set<number>();
  private completionRounds = new Map<number, number>();

  constructor() {
    this.pool = new WorkerPool();
  }

  getPool(): WorkerPool {
    return this.pool;
  }

  hasManagerLLM(workerId: number): boolean {
    return this.managerLLMs.has(workerId);
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
          );
          break;

        case "follow_up":
          await this.followUp(intent.workerId, intent.prompt, intent.telegramChatId);
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
          await this.resume(intent.workerId, intent.telegramChatId);
          break;

        case "status":
          // Concierg handles status via get_system_state + send_telegram_message (Concierg's own tool)
          break;

        case "general":
          break;

        default:
          log.warn({ type: intent.type }, "Unknown intent type");
      }
    } catch (err) {
      log.error({ err, intentId: intent.id }, "Error handling intent");
      notifyConcierg(`[ERROR] Intent processing failed: ${(err as Error).message}`);
    }
  }

  // --- ManagerLLM creation helper ---

  private createManagerLLM(
    workerId: number,
    projectName: string,
    taskPrompt: string,
    userMessage: string,
    userSummary: string,
    chatId: number,
    workerEmoji?: string,
  ): ManagerLLM {
    return new ManagerLLM({
      workerId,
      workerEmoji: workerEmoji || "🔵",
      getWorkerPhase: () => {
        const session = this.pool.get(workerId);
        return session?.phase ?? 'planning';
      },
      projectName,
      taskPrompt,
      userMessage,
      userSummary,
      notifyConcierg,
      insertQuestion: (wId: number, question: string) => {
        const row = insertPendingQuestion(wId, question, "");
        return row.id;
      },
      getWorkerFollowUp: () => async (message: string) => {
        const session = this.pool.get(workerId);
        if (!session) throw new Error(`Worker #${workerId} not found`);
        this.mllmInitiatedFollowUps.add(workerId);
        await session.followUp(message);
      },
      getWorkerStatus: () => {
        const output = this.getWorkerOutput(workerId);
        if (!output) return null;
        return {
          state: output.state,
          recentEvents: output.events,
        };
      },
    });
  }

  // --- Wire worker callbacks through ManagerLLM ---

  private wireWorkerCallbacks(
    session: WorkerLLM,
    mllm: ManagerLLM | null,
    chatId: number,
  ): void {
    const workerId = session.id;

    if (mllm) {
      // Route through ManagerLLM
      session.onQuestion = async (_wId, question, _toolUseId, structuredQuestions) => {
        return new Promise<string>((resolve) => {
          mllm.setQuestionResolver(resolve);

          // Include structured options so ManagerLLM can pass them to ask_user_question
          let eventText = `Worker asked: ${question}`;
          if (structuredQuestions && structuredQuestions.length > 0) {
            const hasOptions = structuredQuestions.some(q => q.options.length > 0);
            if (hasOptions) {
              eventText += `\n\nStructured options (pass these to ask_user_question's options parameter):\n`;
              eventText += JSON.stringify(
                structuredQuestions.flatMap(q => q.options.map(o => ({
                  label: o.label,
                  ...(o.description ? { description: o.description } : {}),
                }))),
                null,
                2
              );
            }
          }

          mllm.injectEvent(eventText);
        });
      };

      // Plan review via ExitPlanMode interception (exp #1 + #3 learning)
      session.onPlanReview = async (_wId, plan) => {
        return new Promise<string>((resolve) => {
          mllm.setPlanResolver(resolve);
          mllm.injectEvent(
            `Worker #${workerId} submitted a plan for review:\n${plan}\n\n` +
            `IMPORTANT: Send a concise summary of this plan to the user via report_progress. ` +
            `Add your assessment. Wait for the user to confirm. ` +
            `Then use answer_worker_plan with APPROVED: or REJECTED: prefix.`
          );
        });
      };

      session.onNotification = (_wId, message, title) => {
        const event = title
          ? `Worker notification (${title}): ${message}`
          : `Worker notification: ${message}`;
        mllm.injectEvent(event);
      };

      session.onCompletion = (_wId, result) => {
        this.handleCompletionWithMLLM(workerId, result, mllm, chatId);
      };
    } else {
      // Fallback: direct communication through Concierg (no ManagerLLM)
      session.onQuestion = async (_wId, question, _toolUseId, structuredQuestions) => {
        return this.handleWorkerQuestionDirect(workerId, question, structuredQuestions);
      };

      // Fallback: auto-approve plan
      session.onPlanReview = async (_wId, _plan) => {
        return "APPROVED: Auto-approved (no ManagerLLM)";
      };

      session.onNotification = (_wId, message, title) => {
        const prefix = title ? `${title}: ` : "";
        notifyConcierg(`[NOTIFICATION | Worker #${workerId}] ${prefix}${message}`);
      };

      session.onCompletion = (_wId, result) => {
        this.handleWorkerCompletionDirect(workerId, result);
      };
    }
  }

  // --- Spawn ---

  private async spawnWorker(
    projectName: string | null,
    prompt: string,
    chatId: number,
    userSummary?: string,
    emoji?: string | null,
  ): Promise<void> {
    if (!projectName) {
      notifyConcierg("[ERROR] No project specified for spawn");
      return;
    }

    // Resolve project from DB
    let projectPath: string;
    let projectId: number;
    let resolvedProjectName: string;

    if (projectName === "general") {
      const generalProject = getProjectByName("general");
      if (!generalProject) {
        notifyConcierg("[ERROR] General worker project not found in database");
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
        notifyConcierg(`[ERROR] Project "${projectName}" not found. Available: ${names || "(none)"}`);
        return;
      }
      projectPath = project.path;
      projectId = project.id;
      resolvedProjectName = project.name;
    }

    const workerRow = insertWorker(projectId, prompt, chatId, emoji);

    // ManagerLLM bootstrap tells the user the task started via report_progress.
    // No direct notifyConcierg here — that would create a duplicate.

    // Enrich prompt with evidence instructions
    const enrichedPrompt = prompt + '\n\n' +
      'When you complete your task, include evidence of success: test results, ' +
      'file contents, or command output that proves the work is done correctly. ' +
      'If you are unsure about anything, use AskUserQuestion to ask.';

    const session = new WorkerLLM(workerRow.id, projectPath, enrichedPrompt);

    let mllm: ManagerLLM | null = null;
    try {
      mllm = this.createManagerLLM(
        workerRow.id,
        resolvedProjectName,
        prompt,
        userSummary || prompt,
        userSummary || prompt,
        chatId,
        emoji || undefined,
      );
      this.pool.add(session); // Add to pool before starting MLLM (getWorkerFollowUp needs it)
      await mllm.start();
      this.managerLLMs.set(workerRow.id, mllm);
      log.info({ workerId: workerRow.id }, "ManagerLLM started");
    } catch (err) {
      log.error({ err, workerId: workerRow.id }, "ManagerLLM failed to start, using fallback");
      mllm = null;
      notifyConcierg(`[SPAWN | Worker #${workerRow.id} | project: ${resolvedProjectName}] Task: "${userSummary || prompt}" (ManagerLLM unavailable)`);
      if (!this.pool.get(workerRow.id)) {
        this.pool.add(session);
      }
    }

    // Wire callbacks
    this.wireWorkerCallbacks(session, mllm, chatId);

    // Start worker in background
    session.start().catch((err) => {
      log.error({ err, workerId: workerRow.id }, "Worker start failed");
      updateWorkerState(workerRow.id, WorkerState.Errored);
      if (mllm) {
        mllm.injectEvent(`Worker #${workerRow.id} failed to start: ${(err as Error).message}`);
      } else {
        notifyConcierg(`[ERROR | Worker #${workerRow.id}] Failed to start: ${(err as Error).message}`);
      }
      this.removeWorkerFromPool(workerRow.id);
    });
  }

  // --- Completion handling ---

  private handleCompletionWithMLLM(
    workerId: number,
    result: SDKResultMessage,
    mllm: ManagerLLM,
    chatId: number,
  ): void {
    const resultText = result.subtype === "success"
      ? result.result || "(no output)"
      : `(error: ${result.subtype})`;
    const cost = result.total_cost_usd.toFixed(4);

    // Get cumulative cost from worker session
    const session = this.pool.get(workerId);
    const totalCost = session ? session.totalCostUsd.toFixed(4) : cost;

    // Track completion rounds and whether this was an MLLM-initiated follow-up
    const round = (this.completionRounds.get(workerId) ?? 0) + 1;
    this.completionRounds.set(workerId, round);
    const wasMLLMFollowUp = this.mllmInitiatedFollowUps.delete(workerId);

    let eventText: string;

    if (round > 3) {
      // Hard safety cap
      eventText =
        `Worker #${workerId} completed round ${round}. Result: ${resultText}\n` +
        `Cost: $${cost} | Total: $${totalCost}\n` +
        `Maximum rounds reached. Send the final result to the user now. Do NOT send further follow-ups.`;
    } else if (wasMLLMFollowUp) {
      // Response to MLLM's own challenge — just report, don't re-challenge
      eventText =
        `Worker #${workerId} responded to your verification request (${result.subtype}).\n` +
        `Result: ${resultText}\n` +
        `Cost: $${cost} | Total: $${totalCost}\n` +
        `Review the evidence. If sufficient, notify the user with the final result. ` +
        `Only send another follow-up if something is clearly wrong or missing.`;
    } else {
      // First completion or user-initiated follow-up — evaluate
      eventText =
        `Worker #${workerId} reports completion (${result.subtype}).\n` +
        `Result: ${resultText}\n` +
        `This round cost: $${cost} | Total cost: $${totalCost}\n\n` +
        `Review this result against the original task. ` +
        `If the worker included test results, file contents, or other evidence of success — accept it and notify the user. ` +
        `Only challenge for proof if the result is clearly incomplete, vague, or unverified.`;
    }

    mllm.injectEvent(eventText).catch((err) => {
      log.error({ err, workerId }, "ManagerLLM completion event failed, using fallback");
      this.handleWorkerCompletionDirect(workerId, result);
    });

    // DB event only — ManagerLLM handles user notification via notifyConcierg
    insertEvent(workerId, "result", {
      subtype: result.subtype,
      cost: result.total_cost_usd,
      turns: result.num_turns,
    });
  }

  // --- Direct communication (fallback, no ManagerLLM) ---

  private async handleWorkerQuestionDirect(
    workerId: number,
    question: string,
    structuredQuestions?: AskUserQuestionItem[]
  ): Promise<string> {
    const questionRow = insertPendingQuestion(workerId, question, "");

    let eventText = `[QUESTION #${questionRow.id} | Worker #${workerId}]\n${question}`;
    if (structuredQuestions?.length) {
      const withOptions = structuredQuestions.find(q => q.options.length > 0);
      if (withOptions) {
        eventText += '\nOptions:\n' + withOptions.options
          .map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ' — ' + o.description : ''}`)
          .join('\n');
      }
    }
    notifyConcierg(eventText);

    return new Promise<string>((resolve) => {
      questionResolvers.set(questionRow.id, resolve);
    });
  }

  resolveQuestion(questionId: number, answer: string): void {
    const resolver = questionResolvers.get(questionId);
    if (resolver) {
      answerQuestion(questionId, answer);
      resolver(answer);
      questionResolvers.delete(questionId);
      log.info({ questionId, answer }, "Question resolved (direct)");
    } else {
      log.warn({ questionId }, "No resolver found for question");
    }
  }

  private handleWorkerCompletionDirect(
    workerId: number,
    result: SDKResultMessage,
  ): void {
    const cost = result.total_cost_usd.toFixed(4);
    const resultSnippet = result.subtype === "success"
      ? sanitizeResult(result.result?.slice(0, 500) || "(no output)")
      : "(error)";

    notifyConcierg(
      `[RESULT | Worker #${workerId} | ${result.subtype}] ${resultSnippet} | Cost: $${cost}`
    );

    insertEvent(workerId, "result", {
      subtype: result.subtype,
      cost: result.total_cost_usd,
      turns: result.num_turns,
    });
  }

  // --- Answer handling ---

  private async handleAnswer(
    questionId: number | null,
    answer: string,
  ): Promise<void> {
    if (questionId) {
      // Try to route through ManagerLLM
      const question = getQuestionById(questionId);
      if (question) {
        const mllm = this.managerLLMs.get(question.workerId);
        if (mllm) {
          answerQuestion(questionId, answer);
          mllm.injectEvent(`User answered question #${questionId}: ${answer}`);
          return;
        }
      }

      // Fallback: direct resolve
      this.resolveQuestion(questionId, answer);
      return;
    }

    // Try to find a single unanswered question
    const pending = getUnansweredQuestions();
    if (pending.length === 1) {
      const mllm = this.managerLLMs.get(pending[0].workerId);
      if (mllm) {
        answerQuestion(pending[0].id, answer);
        mllm.injectEvent(`User answered question #${pending[0].id}: ${answer}`);
        return;
      }
      this.resolveQuestion(pending[0].id, answer);
    } else if (pending.length > 1) {
      notifyConcierg("[ERROR] Multiple pending questions. Reply to the specific question.");
    } else {
      notifyConcierg("[ERROR] No pending questions to answer.");
    }
  }

  // --- Follow-up ---

  private async followUp(
    workerId: number | null,
    message: string,
    chatId: number
  ): Promise<void> {
    let targetId = workerId;
    if (!targetId) {
      const active = getActiveWorkers();
      if (active.length === 1) {
        targetId = active[0].id;
      } else {
        notifyConcierg("[ERROR] Multiple workers active. Specify which one.");
        return;
      }
    }

    const session = this.pool.get(targetId);
    if (!session) {
      notifyConcierg(`[ERROR | Worker #${targetId}] Worker not found or not running.`);
      return;
    }

    // Cold worker — warm it up with the follow-up as prompt
    if (session.isCold()) {
      const worker = getWorkerById(targetId);
      if (worker?.sessionId) {
        log.info({ workerId: targetId }, "Warming up cold worker via follow-up");
        notifyConcierg(`[SYSTEM | Worker #${targetId}] Resuming cold worker...`);
        session.warmUp(worker.sessionId).catch((err) => {
          log.error({ err, workerId: targetId }, "Cold worker warm-up failed");
          updateWorkerState(targetId, WorkerState.Errored);
          notifyConcierg(`[ERROR | Worker #${targetId}] Resume failed: ${(err as Error).message}`);
          this.removeWorkerFromPool(targetId);
        });
        return;
      }
    }

    // Try to route through ManagerLLM
    const mllm = this.managerLLMs.get(targetId);
    if (mllm) {
      mllm.injectEvent(`User says: ${message}`);
      return;
    }

    // Fallback: direct follow-up
    try {
      await session.followUp(message);
    } catch (err) {
      log.error({ err, workerId: targetId }, "Failed to send follow-up");
      notifyConcierg(`[ERROR | Worker #${targetId}] Worker not found or not running.`);
    }
  }

  // --- Stop / Pause / Resume / Restore ---

  private async stopWorker(
    workerId: number | null,
  ): Promise<void> {
    let targetId = workerId;
    if (!targetId) {
      const active = getActiveWorkers();
      if (active.length === 1) {
        targetId = active[0].id;
      } else {
        notifyConcierg("[ERROR] Specify which worker to stop.");
        return;
      }
    }

    const session = this.pool.get(targetId);
    if (session) {
      session.abort();
      this.cleanupWorker(targetId);
      notifyConcierg(`[STOPPED | Worker #${targetId}]`);
    } else {
      markWorkerStopped(targetId);
      notifyConcierg(`[STOPPED | Worker #${targetId}] Marked stopped in DB.`);
    }
  }

  private async pauseWorker(
    workerId: number | null,
  ): Promise<void> {
    if (!workerId) {
      notifyConcierg("[ERROR] Specify which worker to pause.");
      return;
    }

    const session = this.pool.get(workerId);
    if (!session) {
      notifyConcierg(`[ERROR | Worker #${workerId}] Worker not found.`);
      return;
    }

    if (session.state === WorkerState.WaitingInput) {
      log.warn({ workerId }, "Cannot pause worker in WaitingInput state");
      notifyConcierg(`[ERROR | Worker #${workerId}] Worker is waiting for input — can't be paused. Answer the pending question or stop it.`);
      return;
    }

    await session.interrupt();
    notifyConcierg(`[PAUSED | Worker #${workerId}]`);
  }

  /**
   * Unified resume: handles both "resume" and "restore" intents.
   * Returns a result that Concierg LLM can act on (e.g. suggest spawning new worker).
   */
  async resume(
    workerId: number | null,
    chatId: number
  ): Promise<{ success: boolean; reason?: string }> {
    if (!workerId) {
      notifyConcierg("[ERROR] Specify which worker to resume.");
      return { success: false, reason: "no_worker_id" };
    }

    // Already in pool and running — send follow-up instead of duplicating
    const existingSession = this.pool.get(workerId);
    if (existingSession && !existingSession.isCold()) {
      const workerData = getWorkerWithProject(workerId);
      const taskContext = workerData?.worker.currentPrompt || "your previous task";
      await this.followUp(workerId, `Continue working. Your task was: "${taskContext}"`, chatId);
      return { success: true };
    }

    // In pool but cold — warm it up
    if (existingSession && existingSession.isCold()) {
      const worker = getWorkerById(workerId);
      if (worker?.sessionId) {
        notifyConcierg(`[RESUMING | Worker #${workerId}]`);
        existingSession.warmUp(worker.sessionId).catch((err) => {
          log.error({ err, workerId }, "Resume (warm-up) failed");
          updateWorkerState(workerId, WorkerState.Errored);
          notifyConcierg(`[ERROR | Worker #${workerId}] Resume failed: ${(err as Error).message}`);
          this.removeWorkerFromPool(workerId);
        });
        return { success: true };
      }
    }

    // Not in pool — load from DB
    const workerData = getWorkerWithProject(workerId);
    if (!workerData) {
      notifyConcierg(`[ERROR | Worker #${workerId}] Worker not found.`);
      return { success: false, reason: "not_found" };
    }

    const { worker, project } = workerData;

    if (!worker.sessionId) {
      return { success: false, reason: "no_session" };
    }

    const session = new WorkerLLM(worker.id, project.path, worker.currentPrompt);
    await this.addSessionWithMLLM(session, {
      managerSessionId: worker.managerSessionId,
      projectName: project.name,
      currentPrompt: worker.currentPrompt,
      chatId,
      emoji: worker.emoji || undefined,
    });

    notifyConcierg(
      `[RESUMING | Worker #${workerId} | project: ${project.name}] Task: "${worker.currentPrompt}"`
    );

    session.start(worker.sessionId).catch((err) => {
      log.error({ err, workerId }, "Resume failed");
      updateWorkerState(worker.id, WorkerState.Errored);
      notifyConcierg(`[ERROR | Worker #${workerId}] Resume failed: ${(err as Error).message}`);
      this.removeWorkerFromPool(workerId);
    });

    return { success: true };
  }

  // --- Idle ---

  async handleIdleWorker(workerId: number): Promise<void> {
    notifyConcierg(`[IDLE | Worker #${workerId}] Worker seems idle.`);
    insertEvent(workerId, "idle_alert", {});
  }

  // --- Session bootstrap (shared by resume / restore / DB recovery) ---

  /**
   * Add a worker session to the pool, optionally resuming its ManagerLLM.
   * Returns the ManagerLLM instance (or null if unavailable/failed).
   */
  private async addSessionWithMLLM(
    session: WorkerLLM,
    opts: {
      managerSessionId?: string | null;
      projectName: string;
      currentPrompt: string;
      chatId: number;
      emoji?: string;
    },
  ): Promise<ManagerLLM | null> {
    let mllm: ManagerLLM | null = null;

    if (opts.managerSessionId) {
      try {
        mllm = this.createManagerLLM(
          session.id, opts.projectName, opts.currentPrompt, "", "", opts.chatId, opts.emoji,
        );
        this.pool.add(session);
        await mllm.start(opts.managerSessionId);
        this.managerLLMs.set(session.id, mllm);
      } catch (err) {
        log.error({ err, workerId: session.id }, "Failed to resume ManagerLLM");
        mllm = null;
        if (!this.pool.get(session.id)) this.pool.add(session);
      }
    } else {
      this.pool.add(session);
    }

    this.wireWorkerCallbacks(session, mllm, opts.chatId);
    return mllm;
  }

  // --- Cleanup ---

  /** Remove worker from in-memory pool and stop ManagerLLM. Does NOT touch DB state. */
  private removeWorkerFromPool(workerId: number): void {
    const session = this.pool.get(workerId);
    if (session) session.abort();
    this.pool.remove(workerId);
    const mllm = this.managerLLMs.get(workerId);
    if (mllm) {
      mllm.stop();
      this.managerLLMs.delete(workerId);
    }
    this.completionRounds.delete(workerId);
    this.mllmInitiatedFollowUps.delete(workerId);
  }

  /** Intentional stop: remove from pool + mark as stopped in DB. */
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
    for (const [, mllm] of this.managerLLMs) {
      mllm.stop();
    }
    this.managerLLMs.clear();
    this.completionRounds.clear();
    this.mllmInitiatedFollowUps.clear();
    await this.pool.stopAll();
  }

  // --- Cold Resume from DB ---

  /**
   * Cold-register recent workers into pool on startup.
   * No SDK sessions are started — workers sit dormant until user sends a follow-up or "resume".
   */
  async coldResumeWorkersFromDb(): Promise<void> {
    const MAX_COLD_REGISTRATIONS = 10;
    const { WORKER_RESUME_MAX_AGE_S } = getConfig();

    // Mark all stale active workers as stopped
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

    // Filter resumable workers
    const toColdRegister: typeof resumable = [];
    for (const worker of resumable) {
      if (!worker.sessionId) {
        log.info({ workerId: worker.id }, "Skipping resume — no session ID");
        updateWorkerState(worker.id, WorkerState.Errored);
        insertEvent(worker.id, "skipped_resume", { reason: "no_session_id" });
        continue;
      }

      if (hasCompletionEvent(worker.id)) {
        log.info({ workerId: worker.id }, "Skipping resume — worker already completed");
        markWorkerStopped(worker.id);
        insertEvent(worker.id, "skipped_resume", { reason: "already_completed" });
        continue;
      }

      toColdRegister.push(worker);
    }

    // Cap registrations
    if (toColdRegister.length > MAX_COLD_REGISTRATIONS) {
      log.warn({ total: toColdRegister.length, cap: MAX_COLD_REGISTRATIONS }, "Too many workers to cold-register, capping");
      const skipped = toColdRegister.slice(MAX_COLD_REGISTRATIONS);
      for (const worker of skipped) {
        markWorkerStopped(worker.id);
        insertEvent(worker.id, "skipped_resume", { reason: "resume_cap_exceeded" });
      }
      toColdRegister.length = MAX_COLD_REGISTRATIONS;
    }

    // Cold-register: add to pool without starting SDK sessions
    for (const worker of toColdRegister) {
      const workerData = getWorkerWithProject(worker.id);
      if (!workerData) continue;

      log.info(
        { workerId: worker.id, sessionId: worker.sessionId },
        "Cold-registering worker from DB"
      );

      const session = new WorkerLLM(worker.id, workerData.project.path, worker.currentPrompt);
      await this.addSessionWithMLLM(session, {
        managerSessionId: worker.managerSessionId,
        projectName: workerData.project.name,
        currentPrompt: worker.currentPrompt,
        chatId: worker.telegramChatId,
        emoji: worker.emoji || undefined,
      });
      // Note: session.start() is NOT called — worker is cold
    }

    log.info(
      { coldRegistered: toColdRegister.length, staleMarked: allActive.length - resumable.length },
      "Cold resume complete"
    );
  }
}
