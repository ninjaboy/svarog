import {
  query,
  type Query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type CanUseTool,
  type HookCallback,
} from "@anthropic-ai/claude-code";
import {
  updateWorkerState,
  updateWorkerSessionId,
  touchWorkerActivity,
  insertEvent,
} from "../db/queries.js";
import { WorkerState } from "../types/index.js";
import type { AskUserQuestionItem } from "../types/index.js";
import { createChildLogger } from "../utils/logger.js";
import { buildCleanEnv } from "../utils/env.js";

const log = createChildLogger("worker");

export type QuestionHandler = (
  workerId: number,
  question: string,
  toolUseId: string,
  structuredQuestions?: AskUserQuestionItem[]
) => Promise<string>;

export type PlanReviewHandler = (
  workerId: number,
  plan: string
) => Promise<string>;

export type NotificationHandler = (
  workerId: number,
  message: string,
  title?: string
) => void;

export type CompletionHandler = (
  workerId: number,
  result: SDKResultMessage
) => void;

/**
 * Parse AskUserQuestion structured input into readable text + structured items.
 * Handles both { questions: [...] } and legacy { question: string }.
 */
function parseAskUserQuestion(input: unknown): { text: string; questions: AskUserQuestionItem[] } {
  const inp = input as Record<string, unknown>;

  if (Array.isArray(inp.questions)) {
    const questions: AskUserQuestionItem[] = (inp.questions as any[]).map((q) => ({
      question: String(q.question || ""),
      header: String(q.header || ""),
      multiSelect: Boolean(q.multiSelect),
      options: Array.isArray(q.options)
        ? q.options.map((o: any) => ({
            label: String(o.label || ""),
            description: String(o.description || ""),
          }))
        : [],
    }));

    const textParts = questions.map((q) => {
      let text = "";
      if (q.header) text += `${q.header}: `;
      text += q.question;
      if (q.options.length > 0) {
        text += "\n" + q.options
          .map((o, j) => `  ${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`)
          .join("\n");
      }
      if (q.multiSelect) text += "\n  (multiple selections allowed)";
      return text;
    });

    return { text: textParts.join("\n\n"), questions };
  }

  if (typeof inp.question === "string") {
    return { text: inp.question, questions: [] };
  }

  return { text: JSON.stringify(input), questions: [] };
}

interface WorkerEvent {
  timestamp: Date;
  type: 'stdout' | 'stderr' | 'tool' | 'state' | 'message' | 'error';
  content: string;
}

/** Extract a short text preview from an SDK assistant message's content field. */
function extractContentPreview(content: unknown): string {
  if (typeof content === "string") {
    return content.slice(0, 200);
  }
  if (Array.isArray(content)) {
    const textParts = content
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text);
    return textParts.length > 0 ? textParts.join(" ").slice(0, 200) : "(using tools)";
  }
  return "(unknown content)";
}

function summarizeToolUse(toolName: string, input: unknown): string {
  const inp = input as Record<string, unknown>;
  switch (toolName) {
    case 'Read':   return `Reading ${inp.file_path || 'file'}`;
    case 'Write':  return `Writing ${inp.file_path || 'file'}`;
    case 'Edit':   return `Editing ${inp.file_path || 'file'}`;
    case 'Grep':   return `Searching for "${inp.pattern}" in ${inp.path || 'codebase'}`;
    case 'Glob':   return `Finding files matching ${inp.pattern || '*'}`;
    case 'Bash':   return `Running: ${String(inp.command || '').slice(0, 80)}`;
    case 'Task':   return `Delegating subtask`;
    default:       return `Using ${toolName}`;
  }
}

export class WorkerLLM {
  readonly id: number;
  readonly projectPath: string;
  readonly prompt: string;

  private query: Query | null = null;
  private abortController = new AbortController();
  private sessionId: string | null = null;
  private _state: WorkerState = WorkerState.Starting;
  private pendingFollowUp: string | null = null;
  private followUpSignal: { resolve: (msg: string) => void } | null = null;
  private _totalCostUsd = 0;
  private planApproved = false;

  private eventBuffer: WorkerEvent[] = [];
  private readonly MAX_EVENTS = 100;
  private lastStdout = "";
  private lastStderr = "";

  onQuestion: QuestionHandler | null = null;
  onPlanReview: PlanReviewHandler | null = null;
  onNotification: NotificationHandler | null = null;
  onCompletion: CompletionHandler | null = null;

  constructor(id: number, projectPath: string, prompt: string) {
    this.id = id;
    this.projectPath = projectPath;
    this.prompt = prompt;
  }

  get state(): WorkerState {
    return this._state;
  }

  get phase(): 'planning' | 'executing' {
    return this.planApproved ? 'executing' : 'planning';
  }

  private setState(state: WorkerState) {
    this._state = state;
    updateWorkerState(this.id, state);
    insertEvent(this.id, "status_change", { state });
    this.addEvent('state', `State changed to: ${state}`);
  }

  private addEvent(type: WorkerEvent['type'], content: string) {
    const event: WorkerEvent = {
      timestamp: new Date(),
      type,
      content: content.slice(0, 500) // Limit content size
    };

    this.eventBuffer.push(event);

    // Keep only last MAX_EVENTS
    if (this.eventBuffer.length > this.MAX_EVENTS) {
      this.eventBuffer.shift();
    }
  }

  getRecentEvents(count: number = 20): WorkerEvent[] {
    return this.eventBuffer.slice(-count);
  }

  getLastOutput(): { stdout: string; stderr: string; events: WorkerEvent[] } {
    return {
      stdout: this.lastStdout,
      stderr: this.lastStderr,
      events: this.getRecentEvents()
    };
  }

  get totalCostUsd(): number {
    return this._totalCostUsd;
  }

  /** Build a synthetic error result for notifying the manager of failures. */
  private makeErrorResult(): SDKResultMessage {
    return {
      type: "result",
      subtype: "error_during_execution",
      total_cost_usd: 0,
      num_turns: 0,
      session_id: this.sessionId || "",
    } as unknown as SDKResultMessage;
  }

  private waitForFollowUp(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.abortController.signal.aborted) {
        reject(new DOMException("Worker dismissed", "AbortError"));
        return;
      }
      this.followUpSignal = { resolve };
      this.abortController.signal.addEventListener('abort', () => {
        this.followUpSignal = null;
        reject(new DOMException("Worker dismissed", "AbortError"));
      }, { once: true });
    });
  }

  async start(resumeSessionId?: string): Promise<void> {
    log.info({ workerId: this.id, project: this.projectPath }, "Starting worker");

    const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
      // Intercept AskUserQuestion — parse structured data, bridge to manager
      if (toolName === "AskUserQuestion" && this.onQuestion) {
        const parsed = parseAskUserQuestion(input);

        this.setState(WorkerState.WaitingInput);

        const answer = await this.onQuestion(
          this.id,
          parsed.text,
          "",
          parsed.questions
        );

        this.setState(WorkerState.Active);

        return {
          behavior: "deny" as const,
          message: answer,
        };
      }

      // Intercept ExitPlanMode — bridge to manager for plan review (exp #1 + #3)
      // SDK fires canUseTool for ExitPlanMode in plan mode.
      // On allow → SDK auto-transitions to execution (Write/Edit/Bash then fire canUseTool).
      // On deny+message → model revises plan and resubmits.
      if (toolName === "ExitPlanMode" && this.onPlanReview) {
        const plan = (input as any).plan || JSON.stringify(input);

        this.setState(WorkerState.WaitingInput);

        const decision = await this.onPlanReview(this.id, plan);

        this.setState(WorkerState.Active);

        const trimmed = decision.trimStart();
        if (trimmed.startsWith("APPROVED:")) {
          this.planApproved = true;
          return { behavior: "allow" as const, updatedInput: input };
        } else {
          const feedback = trimmed.startsWith("REJECTED:")
            ? trimmed.slice("REJECTED:".length).trim()
            : decision;
          return { behavior: "deny" as const, message: feedback };
        }
      }

      // All other tools: allow (SDK handles plan mode restrictions for read-only tools)
      return { behavior: "allow" as const, updatedInput: input };
    };

    const postToolUseHook: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name === "PostToolUse") {
        touchWorkerActivity(this.id);
        insertEvent(this.id, "tool_use", {
          tool: hookInput.tool_name,
          input: hookInput.tool_input,
        });

        // Capture tool usage in event buffer
        this.addEvent('tool', summarizeToolUse(hookInput.tool_name, hookInput.tool_input));

        // If it's a Bash tool, try to capture output
        if (hookInput.tool_name === 'Bash' && hookInput.tool_response) {
          const output = typeof hookInput.tool_response === 'string'
            ? hookInput.tool_response
            : JSON.stringify(hookInput.tool_response);

          // Store last stdout for status queries
          this.lastStdout = output.slice(-2000); // Keep last 2000 chars
          this.addEvent('stdout', output.slice(0, 500));
        }
      }
      return {};
    };

    const notificationHook: HookCallback = async (hookInput) => {
      if (
        hookInput.hook_event_name === "Notification" &&
        this.onNotification
      ) {
        this.onNotification(
          this.id,
          hookInput.message,
          hookInput.title
        );
      }
      return {};
    };

    const preCompactHook: HookCallback = async (hookInput) => {
      if (
        hookInput.hook_event_name === "PreCompact" &&
        this.onNotification
      ) {
        this.onNotification(
          this.id,
          `Worker #${this.id} is hitting context limit (${hookInput.trigger}). Auto-compacting.`,
          "Context Limit"
        );
      }
      return {};
    };

    const workerEnv = buildCleanEnv();

    let currentPrompt = this.prompt;
    let resumeId = resumeSessionId;

    // Outer loop: re-enters when a follow-up interrupts the current query
    while (true) {
      const options: Options = {
        model: "claude-opus-4-6",
        cwd: this.projectPath,
        permissionMode: 'plan',
        canUseTool,
        abortController: this.abortController,
        env: workerEnv,
        pathToClaudeCodeExecutable: "/Users/germangurov/.local/bin/claude",
        hooks: {
          PostToolUse: [{ hooks: [postToolUseHook] }],
          Notification: [{ hooks: [notificationHook] }],
          PreCompact: [{ hooks: [preCompactHook] }],
        },
        ...(resumeId ? { resume: resumeId } : {}),
      };

      this.query = query({ prompt: currentPrompt, options });
      this.setState(WorkerState.Active);

      let followUpToProcess: string | null = null;

      try {
        for await (const message of this.query) {
          touchWorkerActivity(this.id);

          if (message.type === "system" && message.subtype === "init") {
            this.sessionId = message.session_id;
            updateWorkerSessionId(this.id, message.session_id);
            log.info(
              { workerId: this.id, sessionId: message.session_id },
              "Worker session started"
            );
            this.addEvent('message', 'Session initialized');
          }

          if (message.type === "assistant" && (message as any).message?.content) {
            const preview = extractContentPreview((message as any).message.content);
            this.addEvent("message", `Assistant: ${preview}`);
          }

          if (message.type === "result") {
            // Check if a follow-up is pending (interrupt was triggered)
            if (this.pendingFollowUp) {
              followUpToProcess = this.pendingFollowUp;
              this.pendingFollowUp = null;
              log.info(
                { workerId: this.id },
                "Interrupted for follow-up, will resume"
              );
              break;
            }

            const result = message as SDKResultMessage;
            this._totalCostUsd += result.total_cost_usd;

            // Completion — worker stays Active while waiting for follow-up
            touchWorkerActivity(this.id);
            this.onCompletion?.(this.id, result);

            // Mark that result was delivered (prevents re-sending on restart)
            insertEvent(this.id, "result_delivered", { subtype: result.subtype });

            try {
              const nextMsg = await this.waitForFollowUp();
              followUpToProcess = nextMsg;
              break; // outer loop resumes with new query
            } catch (e) {
              if ((e as Error).name === "AbortError") {
                // Caller (Dispatcher.cleanupWorker) handles pool removal — no state change
                return;
              }
              throw e;
            }
          }
        }
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") {
          // Caller (Dispatcher.cleanupWorker) handles pool removal — no state change
          log.info({ workerId: this.id }, "Worker aborted");
          this.addEvent('message', 'Worker aborted by user');
          return;
        }
        this.setState(WorkerState.Errored);
        log.error({ workerId: this.id, err }, "Worker error");
        insertEvent(this.id, "error", {
          message: (err as Error).message,
        });

        const errorMsg = (err as Error).message || 'Unknown error';
        this.lastStderr = errorMsg;
        this.addEvent('error', errorMsg);

        // Notify manager so it can decide to retry or notify user
        this.onCompletion?.(this.id, this.makeErrorResult());

        // Wait for follow-up (manager may push worker to retry)
        try {
          const nextMsg = await this.waitForFollowUp();
          followUpToProcess = nextMsg;
          // Fall through to the follow-up resume logic below
        } catch (e) {
          if ((e as Error).name === "AbortError") {
            // Caller handles pool removal — no state change
            return;
          }
          throw e;
        }
      }

      // If we have a follow-up, resume with it
      if (followUpToProcess && this.sessionId) {
        currentPrompt = followUpToProcess;
        resumeId = this.sessionId;
        continue;
      }

      // No follow-up and no session — guard against silent exit
      if (!followUpToProcess) {
        this.setState(WorkerState.Errored);
        this.onCompletion?.(this.id, this.makeErrorResult());
        return;
      }
    }
  }

  async followUp(message: string): Promise<void> {
    if (this.followUpSignal) {
      // Worker is waiting for follow-up, wake it up
      this.followUpSignal.resolve(message);
      this.followUpSignal = null;
      return;
    }
    if (this.query) {
      // Worker is active, interrupt
      this.pendingFollowUp = message;
      await this.query.interrupt();
      return;
    }
    throw new Error(`Worker #${this.id} cannot accept follow-ups`);
  }

  async interrupt(): Promise<void> {
    if (this.query) {
      await this.query.interrupt();
    }
  }

  abort(): void {
    this.abortController.abort();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** True if start() hasn't been called yet (cold-registered, no active SDK query). */
  isCold(): boolean {
    return this.query === null && this.followUpSignal === null;
  }

  /** Wake a cold worker by starting its SDK session. */
  async warmUp(resumeSessionId: string): Promise<void> {
    if (!this.isCold()) {
      throw new Error(`Worker #${this.id} is already warm`);
    }
    this.sessionId = resumeSessionId;
    await this.start(resumeSessionId);
  }
}
