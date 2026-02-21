import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-code";
import { buildCleanEnv } from "../utils/env.js";
import { createChildLogger } from "../utils/logger.js";
import { updateManagerSessionId } from "../db/queries.js";
import {
  createManagerLLMMcpServer,
  type ManagerLLMToolContext,
} from "./mcp-tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = join(__dirname, "..", "..", "concierg-workspace", "manager-llm");

const QUERY_TIMEOUT_MS = 180_000;
const CLAUDE_BINARY = "/Users/germangurov/.local/bin/claude";

const log = createChildLogger("manager-llm-session");

export interface ManagerLLMConfig {
  workerId: number;
  workerEmoji: string;
  getWorkerPhase: () => 'planning' | 'executing';
  projectName: string;
  taskPrompt: string;
  userMessage: string;
  userSummary: string;
  /** Route messages through Concierg — only Concierg talks to the user */
  notifyConcierg: (text: string) => void;
  insertQuestion: (workerId: number, question: string) => number;
  getWorkerFollowUp: () => (message: string) => Promise<void>;
  getWorkerStatus: () => {
    state: string;
    recentEvents: Array<{ timestamp: Date; type: string; content: string }>;
  } | null;
}

export class ManagerLLM {
  readonly workerId: number;
  private sessionId: string | null = null;
  private busy = false;
  private eventQueue: string[] = [];
  private processing = false;
  private stopped = false;

  /** Holds the resolver for the current pending worker question */
  private questionResolver: ((answer: string) => void) | null = null;
  /** Holds the resolver for the current pending plan review */
  private planResolver: ((decision: string) => void) | null = null;

  private config: ManagerLLMConfig;
  private mcpServer: ReturnType<typeof createManagerLLMMcpServer>;
  private pendingNotifications: string[] = [];

  constructor(config: ManagerLLMConfig) {
    this.workerId = config.workerId;
    this.config = config;

    const toolContext: ManagerLLMToolContext = {
      workerId: config.workerId,
      workerEmoji: config.workerEmoji,
      getWorkerPhase: config.getWorkerPhase,
      notifyConcierg: (text: string) => { this.pendingNotifications.push(text); },
      getQuestionResolver: () => this.questionResolver,
      getPlanResolver: () => this.planResolver,
      insertQuestion: config.insertQuestion,
      workerFollowUp: (message: string) => config.getWorkerFollowUp()(message),
      getWorkerStatus: config.getWorkerStatus,
    };

    this.mcpServer = createManagerLLMMcpServer(toolContext);
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Set the question resolver for the current worker question.
   * Called by Manager code when worker's canUseTool fires.
   */
  setQuestionResolver(resolver: (answer: string) => void): void {
    this.questionResolver = resolver;
  }

  /**
   * Clear the question resolver after it's been used.
   */
  clearQuestionResolver(): void {
    this.questionResolver = null;
  }

  /**
   * Set the plan review resolver. Called when worker's ExitPlanMode fires.
   */
  setPlanResolver(resolver: (decision: string) => void): void {
    this.planResolver = resolver;
  }

  clearPlanResolver(): void {
    this.planResolver = null;
  }

  /**
   * Bootstrap the session or resume from saved sessionId.
   */
  async start(resumeSessionId?: string): Promise<void> {
    if (resumeSessionId) {
      this.sessionId = resumeSessionId;
      log.info(
        { workerId: this.workerId, sessionId: resumeSessionId },
        "ManagerLLM session resumed from DB"
      );
      return;
    }

    // Bootstrap with initial context — keep it simple, QA rules are in appendSystemPrompt
    const bootstrapPrompt = [
      `Project: ${this.config.projectName}`,
      `Task: ${this.config.taskPrompt}`,
      `User's message: ${this.config.userMessage}`,
      ``,
      `Worker #${this.config.workerId} has been spawned. Tell the user the task has started.`,
      `Use the user's language (detected from the message above).`,
    ].join("\n");

    log.info({ workerId: this.workerId }, "Bootstrapping ManagerLLM session");

    try {
      await this.runQuery(bootstrapPrompt);
    } catch (err: any) {
      if (err?.message?.includes("exited with code 1") && this.sessionId) {
        log.warn(
          { workerId: this.workerId },
          "Bootstrap threw code 1, but session ID captured"
        );
      } else {
        throw err;
      }
    } finally {
      // Flush bootstrap notifications
      if (this.pendingNotifications.length > 0) {
        const batch = this.pendingNotifications.splice(0);
        this.config.notifyConcierg(batch.join("\n\n"));
      }
    }

    if (!this.sessionId) {
      throw new Error(
        `ManagerLLM bootstrap failed for worker #${this.workerId} — no session ID`
      );
    }

    log.info(
      { workerId: this.workerId, sessionId: this.sessionId },
      "ManagerLLM session bootstrapped"
    );
  }

  /**
   * Queue an event and process it. Events are processed sequentially.
   */
  async injectEvent(text: string): Promise<void> {
    if (this.stopped) {
      log.warn({ workerId: this.workerId }, "Event injected after stop, ignoring");
      return;
    }

    this.eventQueue.push(text);
    await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return; // Already processing — events will be picked up
    this.processing = true;

    try {
      while (this.eventQueue.length > 0 && !this.stopped) {
        // Drain all queued events into one prompt
        const events = this.eventQueue.splice(0);
        const prompt = events.join("\n\n");

        try {
          await this.runQuery(prompt);
        } catch (err: any) {
          if (err?.message?.includes("exited with code 1")) {
            log.warn(
              { workerId: this.workerId },
              "ManagerLLM query exited with code 1"
            );
          } else {
            log.error(
              { err, workerId: this.workerId },
              "ManagerLLM query failed"
            );
          }
        } finally {
          // Flush buffered notifications as one batch
          if (this.pendingNotifications.length > 0) {
            const batch = this.pendingNotifications.splice(0);
            this.config.notifyConcierg(batch.join("\n\n"));
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async runQuery(prompt: string): Promise<void> {
    if (this.busy) {
      // Queue the prompt as an event instead of dropping it
      this.eventQueue.push(prompt);
      return;
    }

    this.busy = true;
    const abortController = new AbortController();
    const env = buildCleanEnv();

    try {
      const conversation = query({
        prompt,
        options: {
          model: "claude-opus-4-6",
          allowedTools: ["mcp__manager_llm__*", "Read"],
          maxTurns: 12,
          cwd: WORKSPACE_DIR,
          mcpServers: { manager_llm: this.mcpServer },
          pathToClaudeCodeExecutable: CLAUDE_BINARY,
          env,
          abortController,
          appendSystemPrompt: [
            `You are the manager for Worker #${this.config.workerId} on project "${this.config.projectName}".`,
            `You are a proactive technical advisor — guide the worker, give recommendations, and protect the user from unnecessary details.`,
            ``,
            `QUESTIONS from worker:`,
            `- TECHNICAL questions (library choice, architecture pattern, error handling): Answer yourself via answer_worker_question.`,
            `- REQUIREMENTS questions (what to build, business logic, user preferences): Escalate via ask_user_question. Pass structured options if available.`,
            `- When unsure, add your recommendation and escalate: "I suggest X, but let me check with the user."`,
            `- When the user answers, relay it to the worker via answer_worker_question.`,
            ``,
            `PLAN REVIEW:`,
            `- When worker submits a plan: send a concise summary via report_progress.`,
            `- Add your assessment: "This looks solid" or "I have concerns about X".`,
            `- Wait for the user to confirm.`,
            `- Then use answer_worker_plan with APPROVED: or REJECTED: prefix. The prefix is machine-parsed!`,
            `- On rejection, include specific actionable feedback after the REJECTED: prefix.`,
            ``,
            `COMPLETION:`,
            `- Summarize the result for the user via report_progress.`,
            `- If the result is incomplete or vague, ask the worker for proof via send_worker_follow_up.`,
            `- Never challenge more than once for the same issue.`,
            ``,
            `GENERAL:`,
            `- When the user sends a message, relay it to the worker or act on it.`,
            `- Format messages in Markdown. Use the user's language.`,
            `- Be concise but informative — the user is busy.`,
          ].join('\n'),
          ...(this.sessionId ? { resume: this.sessionId } : {}),
        },
      });

      const processMessages = async () => {
        for await (const message of conversation) {
          if (message.type === "system" && message.subtype === "init") {
            this.sessionId = message.session_id;
            updateManagerSessionId(this.workerId, message.session_id);
            log.info(
              { workerId: this.workerId, sessionId: message.session_id },
              "ManagerLLM session initialized"
            );
          }

          if (message.type === "result") {
            if (message.subtype === "success") {
              log.debug(
                {
                  workerId: this.workerId,
                  turns: message.num_turns,
                  cost: message.total_cost_usd.toFixed(4),
                },
                "ManagerLLM query completed"
              );
            } else {
              log.warn(
                { workerId: this.workerId, subtype: message.subtype },
                "ManagerLLM query non-success"
              );
            }
          }
        }
      };

      let timeoutId: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          processMessages(),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              log.warn(
                { workerId: this.workerId },
                "ManagerLLM query timed out, aborting"
              );
              abortController.abort();
              reject(
                new Error(
                  `ManagerLLM query timed out after ${QUERY_TIMEOUT_MS / 1000}s`
                )
              );
            }, QUERY_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timeoutId!);
      }
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.eventQueue = [];
    this.questionResolver = null;
    this.planResolver = null;
    log.info({ workerId: this.workerId }, "ManagerLLM session stopped");
  }
}
