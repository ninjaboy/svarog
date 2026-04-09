import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  query,
  type CanUseTool,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-code";
import { getSvarogContext } from "../db/queries.js";
import { buildCleanEnv } from "../utils/env.js";
import { createChildLogger } from "../utils/logger.js";
import type { TelegramButton } from "../telegram/index.js";
import {
  svarogMcpServer,
  setMcpContext,
  clearMcpContext,
  getRegisteredIntents,
  type RegisteredIntent,
} from "./mcp-tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = join(__dirname, "..", "..", "svarog-workspace");

const log = createChildLogger("svarog-session");

export interface ImageData {
  base64: string;
  mediaType: string;
  localPath: string;
}

const QUERY_TIMEOUT_MS = 600_000;
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

function findClaudeBinary(): string {
  // 1. Env override
  if (process.env.CLAUDE_BINARY_PATH && existsSync(process.env.CLAUDE_BINARY_PATH)) {
    return process.env.CLAUDE_BINARY_PATH;
  }
  // 2. ~/.local/bin/claude (standard install location)
  const localBin = pathJoin(homedir(), ".local", "bin", "claude");
  if (existsSync(localBin)) return localBin;
  // 3. which claude
  try {
    const resolved = execSync("which claude", { encoding: "utf-8" }).trim();
    if (resolved && existsSync(resolved)) return resolved;
  } catch {}
  // 4. Fallback — let SDK try "claude" from PATH
  return "claude";
}

const CLAUDE_BINARY = findClaudeBinary();

// --- SvarogSession ---
// Uses Claude Code SDK with global claude binary.
// Supports resume-per-message: each send() spawns a new query() with resume: sessionId.
// Claude now uses MCP tools to send messages and register intents.

export class SvarogSession {
  private pendingEvents: string[] = [];
  private sessionId: string | null = null;
  private alive = false;
  private busy = false;

  // Persistent send functions for autonomous event processing
  private defaultChatId: number | null = null;
  private defaultSendMessage: ((chatId: number, text: string) => Promise<void>) | null = null;
  private defaultSendPhoto: ((chatId: number, photoPath: string, caption?: string) => Promise<void>) | null = null;
  private defaultSendDocument: ((chatId: number, filePath: string, caption?: string) => Promise<void>) | null = null;
  private defaultSendMessageWithButtons: ((chatId: number, text: string, buttons: TelegramButton[][], options?: { html?: boolean }) => Promise<number>) | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  isAlive(): boolean {
    return this.alive;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async start(resumeSessionId?: string): Promise<void> {
    if (resumeSessionId) {
      this.sessionId = resumeSessionId;
      this.alive = true;
      log.info({ sessionId: resumeSessionId }, "Svarog session resumed from DB");
      return;
    }

    // Bootstrap: run one query to get a session ID
    log.info("Bootstrapping svarog session");
    try {
      await this.runQuery(
        "System initialized. Send a greeting message to the user saying you are online and ready.",
        async () => {} // no-op sendMessage during bootstrap
      );
    } catch (err) {
      // SDK may exit with code 1 even after successful response - check if we got a session ID
      log.warn({ err }, "Bootstrap query threw, checking if session ID was captured");
    }

    if (this.sessionId) {
      this.alive = true;
      log.info({ sessionId: this.sessionId }, "Svarog session bootstrapped");
    } else {
      throw new Error("Failed to bootstrap svarog session — no session ID received");
    }
  }

  async send(
    text: string,
    messageId: number,
    chatId: number,
    replyToMessageId: number | null,
    replyToText: string | null,
    images: ImageData[] = [],
    sendMessageFn: (chatId: number, text: string) => Promise<void>,
    sendPhotoFn: (chatId: number, photoPath: string, caption?: string) => Promise<void>,
    sendDocumentFn: (chatId: number, filePath: string, caption?: string) => Promise<void>,
    sendMessageWithButtonsFn?: (chatId: number, text: string, buttons: TelegramButton[][], options?: { html?: boolean }) => Promise<number>,
  ): Promise<RegisteredIntent[]> {
    if (!this.sessionId) {
      throw new Error("Svarog session not initialized");
    }

    if (this.busy) {
      throw new Error("Svarog session busy — concurrent send not supported");
    }

    // Keep send functions fresh from every user message
    this.defaultChatId = chatId;
    this.defaultSendMessage = sendMessageFn;
    this.defaultSendPhoto = sendPhotoFn;
    this.defaultSendDocument = sendDocumentFn;
    if (sendMessageWithButtonsFn) this.defaultSendMessageWithButtons = sendMessageWithButtonsFn;

    this.busy = true;
    try {
      const prompt = this.buildPrompt(text, replyToMessageId, replyToText, images);
      return await this.runQuery(prompt, sendMessageFn, sendPhotoFn, chatId);
    } finally {
      this.busy = false;
      // Process any events that came in while busy
      this.scheduleEventProcessing();
    }
  }

  setSendFunctions(
    chatId: number,
    sendMessageFn: (chatId: number, text: string) => Promise<void>,
    sendPhotoFn: (chatId: number, photoPath: string, caption?: string) => Promise<void>,
    sendDocumentFn: (chatId: number, filePath: string, caption?: string) => Promise<void>,
    sendMessageWithButtonsFn?: (chatId: number, text: string, buttons: TelegramButton[][], options?: { html?: boolean }) => Promise<number>,
  ): void {
    this.defaultChatId = chatId;
    this.defaultSendMessage = sendMessageFn;
    this.defaultSendPhoto = sendPhotoFn;
    this.defaultSendDocument = sendDocumentFn;
    if (sendMessageWithButtonsFn) this.defaultSendMessageWithButtons = sendMessageWithButtonsFn;
  }

  notify(eventText: string): void {
    this.pendingEvents.push(eventText);
    this.scheduleEventProcessing();
  }

  private scheduleEventProcessing(): void {
    if (this.notifyTimer || this.busy) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      if (this.pendingEvents.length > 0 && !this.busy) {
        this.processEvents().catch((err) => {
          log.error({ err }, "Event processing failed");
        });
      }
    }, 500);
  }

  private async processEvents(): Promise<void> {
    if (!this.defaultSendMessage || !this.defaultChatId) return;
    const prompt =
      "--- SYSTEM EVENTS ---\n" +
      this.pendingEvents.join("\n\n") +
      "\n--- END EVENTS ---\n\n" +
      "Process these events. Forward important ones to the user via send_telegram_message. " +
      "Preserve worker emoji and phase info. De-duplicate similar events. Be concise.";
    this.pendingEvents = [];
    await this.runQuery(prompt, this.defaultSendMessage, this.defaultSendPhoto!, this.defaultChatId);
  }

  async ping(): Promise<boolean> {
    // Lightweight check — don't spawn a query
    return this.alive && !!this.sessionId;
  }

  async stop(): Promise<void> {
    log.info("Stopping svarog session");
    this.alive = false;
  }

  // --- Internal ---

  private async runQuery(
    prompt: string,
    sendMessageFn: (chatId: number, text: string) => Promise<void>,
    sendPhotoFn?: (chatId: number, photoPath: string, caption?: string) => Promise<void>,
    chatId?: number,
  ): Promise<RegisteredIntent[]> {
    const abortController = new AbortController();
    const env = buildCleanEnv();

    // Set MCP context for this query
    setMcpContext({
      chatId: chatId ?? 0,
      intents: [],
      sendMessage: sendMessageFn,
      sendPhoto: sendPhotoFn ?? (async () => {}),
      sendDocument: this.defaultSendDocument ?? (async () => {}),
      sendMessageWithButtons: this.defaultSendMessageWithButtons ?? (async () => 0),
    });

    const canUseTool: CanUseTool = async (toolName, _input, _options) => {
      // Allow Svarog's own MCP tools and Read (for images)
      if (toolName.startsWith("mcp__svarog__") || toolName === "Read") {
        return { behavior: "allow" as const, updatedInput: _input };
      }
      // Block everything else with guidance to spawn a worker
      log.warn({ toolName }, "Svarog attempted to use blocked tool");
      return {
        behavior: "deny" as const,
        message: `STOP. Do NOT use ${toolName}. You are a dispatcher. Spawn a general worker via register_intent(spawn_worker, project="general") and tell the user you're looking into it.`,
      };
    };

    const conversation = query({
      prompt,
      options: {
        model: "claude-opus-4-6",
        appendSystemPrompt: [
          "Use your MCP tools (send_telegram_message, register_intent, get_system_state) and Read tool to interact. Do NOT output raw JSON.",
          "",
          "ROUTING USER MESSAGES — pick the right intent:",
          "- Worker has has_pending_plan=true AND user approves (yes/go ahead/looks good/start/do it/implement/approve/let's go) →",
          "  register_intent type=approve_plan, workerId=<that worker's ID>",
          "- Worker has has_pending_plan=true AND user gives feedback/changes/corrections →",
          "  register_intent type=reject_plan, workerId=<that worker's ID>, prompt=<user's feedback>",
          "- Worker is executing (phase=executing) AND user wants to go back to planning →",
          "  register_intent type=switch_to_plan, workerId=<that worker's ID>, prompt=<user's reason>",
          "- Worker is executing (phase=executing) AND user sends a normal follow-up →",
          "  register_intent type=follow_up, workerId=<that worker's ID>, prompt=<user's message>",
          "- Worker is planning (phase=planning, has_pending_plan=false) AND user wants to skip plan review →",
          "  register_intent type=skip_plan, workerId=<that worker's ID>",
          "- Worker is planning (phase=planning, has_pending_plan=false) AND user sends a follow-up →",
          "  register_intent type=follow_up, workerId=<that worker's ID>, prompt=<user's message>",
          "- User answers a pending question Q#ID → register_intent type=answer_question, questionId=<ID>",
          "- User references a RECOVERABLE worker (stopped but resumable) → register_intent type=follow_up, workerId=<ID>, prompt=<user's message>",
          "  The system will auto-recover the worker session from DB. Do NOT tell the user the worker is stopped — just route normally.",
          "- User asks for something completely new → register_intent type=spawn_worker",
          "- User just chatting → send_telegram_message (no intent needed)",
          "- NEVER spawn a new worker for replies to existing workers. Use follow_up, approve_plan, reject_plan, skip_plan, or switch_to_plan instead.",
          "- NEVER tell the user a recoverable worker is 'not active' or 'stopped'. Route to it with follow_up and let the system handle recovery.",
          "",
          "PLAN MODE CONTROL:",
          "- By default, set planMode=true when spawning workers (they plan first, then execute after user approval).",
          "- If the user explicitly says to skip planning, just do it, or no plan mode → set planMode=false when spawning.",
          "- If the user says 'go back to planning', 'let me reconsider', 'stop implementing and re-plan' while a worker is executing →",
          "  register_intent type=switch_to_plan, workerId=<ID>, prompt=<user's reason>",
          "- If the user says 'skip planning', 'skip the plan', 'just start', 'start implementing now' while a worker is in planning phase →",
          "  register_intent type=skip_plan, workerId=<ID>",
          "",
          "SCHEDULED TASKS:",
          "- User wants to set up a recurring check/alert/task → use manage_schedule(action='create')",
          "  Convert natural language to cron expressions:",
          "  'every morning at 9am' → '0 9 * * *', 'every Monday at 8am' → '0 8 * * 1'",
          "  'every hour' → '0 * * * *', 'at 3pm today' → compute one-time cron + runOnce=true",
          "- User wants to see scheduled tasks → manage_schedule(action='list')",
          "- User wants to remove a schedule → manage_schedule(action='delete', scheduleId=N)",
          "- User wants to pause/disable → manage_schedule(action='disable', scheduleId=N)",
          "- User wants to re-enable → manage_schedule(action='enable', scheduleId=N)",
          "- Default timezone from config. Override if user specifies one.",
          "",
          "SYSTEM EVENTS from workers arrive with metadata like [SPAWN | #ID (summary) | ...]",
          "When forwarding system events to the user:",
          "- For [SPAWN | ...] events: confirm the worker was started with task summary",
          "- For [ERROR | ...] events: tell the user what went wrong",
          "- For [STOPPED | ...] events: confirm the worker was stopped",
          "- Workers communicate directly with the user via Telegram (questions, plans, progress, results).",
          "- You do NOT need to relay worker questions or results — workers handle that themselves.",
          "- De-duplicate: if multiple events describe the same thing, send one message",
        ].join("\n"),
        allowedTools: ["mcp__svarog__*", "Read"],
        maxTurns: 200,
        cwd: WORKSPACE_DIR,
        mcpServers: { svarog: svarogMcpServer },
        pathToClaudeCodeExecutable: CLAUDE_BINARY,
        env,
        abortController,
        canUseTool,
        ...(this.sessionId ? { resume: this.sessionId } : {}),
      },
    });

    const processMessages = async () => {
      for await (const message of conversation) {
        // Capture session ID on init
        if (message.type === "system" && message.subtype === "init") {
          this.sessionId = message.session_id;
          log.info({ sessionId: message.session_id }, "Svarog session initialized");
        }

        // Final result
        if (message.type === "result") {
          if (message.subtype === "success") {
            log.info(
              { turns: message.num_turns, cost: message.total_cost_usd.toFixed(4) },
              "Svarog query completed"
            );
          } else {
            log.warn(
              { subtype: message.subtype, turns: message.num_turns },
              "Svarog query finished with non-success"
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
            log.warn("SDK query timed out after %dms, aborting", QUERY_TIMEOUT_MS);
            abortController.abort();
            reject(new Error(`Claude Code SDK query timed out after ${QUERY_TIMEOUT_MS / 1000}s`));
          }, QUERY_TIMEOUT_MS);
        }),
      ]);
    } catch (err: any) {
      if (err?.message?.includes("exited with code 1")) {
        log.warn("SDK exited with code 1, continuing with collected intents");
      } else {
        log.error({ err }, "Svarog query error");
        // Send user-friendly message instead of throwing
        try {
          if (chatId) {
            await sendMessageFn(chatId, "Something went wrong processing your message. Please try again.");
          }
        } catch { /* ignore send errors */ }
        // Return whatever intents were collected
      }
    } finally {
      clearTimeout(timeoutId!);
    }

    const intents = getRegisteredIntents();
    clearMcpContext();

    return intents;
  }

  private buildPrompt(
    text: string,
    replyToMessageId: number | null,
    replyToText: string | null,
    images: ImageData[] = []
  ): string {
    const parts: string[] = [];

    // Batched events
    if (this.pendingEvents.length > 0) {
      parts.push("--- RECENT EVENTS ---");
      parts.push(...this.pendingEvents);
      parts.push("--- END EVENTS ---");
      this.pendingEvents = [];
    }

    // Reply context
    if (replyToText) {
      const context = getSvarogContext();
      const matchingQ = context.pendingQuestions.find(
        (q) => q.telegramMessageId === replyToMessageId
      );
      if (matchingQ) {
        parts.push(
          `[Reply to Q#${matchingQ.id} from worker #${matchingQ.workerId}: "${matchingQ.question}"]`
        );
      } else {
        parts.push(
          `[Replying to: "${replyToText.slice(0, 500)}"]`
        );
      }
    }

    // Image reference(s) (saved to disk, path in text — Claude Code can read files)
    if (images.length === 1) {
      parts.push(`[Image attached: ${images[0].localPath}]`);
    } else if (images.length > 1) {
      const paths = images.map((img, i) => `  ${i + 1}. ${img.localPath}`).join("\n");
      parts.push(`[${images.length} images attached:\n${paths}]`);
    }

    // User message
    parts.push(text);

    return parts.join("\n\n");
  }
}
