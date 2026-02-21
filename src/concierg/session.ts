import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  query,
  type CanUseTool,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-code";
import { getConciergContext } from "../db/queries.js";
import { buildCleanEnv } from "../utils/env.js";
import { createChildLogger } from "../utils/logger.js";
import { captureException } from "../utils/sentry.js";
import {
  conciergMcpServer,
  setMcpContext,
  clearMcpContext,
  getRegisteredIntents,
  getWorkerDetailsFromProvider,
  type RegisteredIntent,
} from "./mcp-tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = join(__dirname, "..", "..", "concierg-workspace");

const log = createChildLogger("concierg-session");

export interface ImageData {
  base64: string;
  mediaType: string;
}

const QUERY_TIMEOUT_MS = 600_000;
const CLAUDE_BINARY = "/Users/germangurov/.local/bin/claude";

// --- ConciergSession ---
// Uses Claude Code SDK with global claude binary.
// Supports resume-per-message: each send() spawns a new query() with resume: sessionId.
// Claude now uses MCP tools to send messages and register intents.

export class ConciergSession {
  private pendingEvents: string[] = [];
  private sessionId: string | null = null;
  private alive = false;
  private busy = false;

  // Persistent send functions for autonomous event processing
  private defaultChatId: number | null = null;
  private defaultSendMessage: ((chatId: number, text: string) => Promise<void>) | null = null;
  private defaultSendPhoto: ((chatId: number, photoPath: string, caption?: string) => Promise<void>) | null = null;
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
      log.info({ sessionId: resumeSessionId }, "Concierg session resumed from DB");
      return;
    }

    // Bootstrap: run one query to get a session ID
    log.info("Bootstrapping concierg session");
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
      log.info({ sessionId: this.sessionId }, "Concierg session bootstrapped");
    } else {
      throw new Error("Failed to bootstrap concierg session — no session ID received");
    }
  }

  async send(
    text: string,
    messageId: number,
    chatId: number,
    replyToMessageId: number | null,
    replyToText: string | null,
    image: ImageData | null = null,
    sendMessageFn: (chatId: number, text: string) => Promise<void>,
    sendPhotoFn: (chatId: number, photoPath: string, caption?: string) => Promise<void>,
  ): Promise<RegisteredIntent[]> {
    if (!this.sessionId) {
      throw new Error("Concierg session not initialized");
    }

    if (this.busy) {
      throw new Error("Concierg session busy — concurrent send not supported");
    }

    // Keep send functions fresh from every user message
    this.defaultChatId = chatId;
    this.defaultSendMessage = sendMessageFn;
    this.defaultSendPhoto = sendPhotoFn;

    this.busy = true;
    try {
      const prompt = this.buildPrompt(text, replyToMessageId, replyToText, image);
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
  ): void {
    this.defaultChatId = chatId;
    this.defaultSendMessage = sendMessageFn;
    this.defaultSendPhoto = sendPhotoFn;
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
    log.info("Stopping concierg session");
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
      getWorkerDetails: (workerId) => getWorkerDetailsFromProvider(workerId),
    });

    const canUseTool: CanUseTool = async (toolName, _input, _options) => {
      // Allow Concierg's own MCP tools and Read (for images)
      if (toolName.startsWith("mcp__concierg__") || toolName === "Read") {
        return { behavior: "allow" as const, updatedInput: _input };
      }
      // Block everything else with guidance to spawn a worker
      log.warn({ toolName }, "Concierg attempted to use blocked tool");
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
          "- User replies to a worker's plan/question/message → register_intent type=follow_up, workerId=<that worker's ID>, prompt=<user's reply>",
          "- User answers a pending question Q#ID → register_intent type=answer_question, questionId=<ID>",
          "- User asks for something completely new → register_intent type=spawn_worker",
          "- User just chatting → send_telegram_message (no intent needed)",
          "- NEVER spawn a new worker for replies to existing workers. Use follow_up instead.",
          "",
          "SYSTEM EVENTS from workers arrive with metadata: [Worker #ID | emoji | phase: planning/executing]",
          "When forwarding worker messages to the user:",
          "- Prefix with the worker emoji and ID, e.g. '🔍 Worker #47'",
          "- Show [plan] for planning phase, omit for executing phase",
          "- For [QUESTION #ID | ...] events: present the question clearly to the user",
          "- For [RESULT | ...] events: summarize the result for the user",
          "- For [SPAWN | ...] events: confirm the worker was started",
          "- De-duplicate: if multiple events describe the same thing, send one message",
        ].join("\n"),
        allowedTools: ["mcp__concierg__*", "Read"],
        maxTurns: 8,
        cwd: WORKSPACE_DIR,
        mcpServers: { concierg: conciergMcpServer },
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
          log.info({ sessionId: message.session_id }, "Concierg session initialized");
        }

        // Final result
        if (message.type === "result") {
          if (message.subtype === "success") {
            log.info(
              { turns: message.num_turns, cost: message.total_cost_usd.toFixed(4) },
              "Concierg query completed"
            );
          } else {
            log.warn(
              { subtype: message.subtype, turns: message.num_turns },
              "Concierg query finished with non-success"
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
        log.error({ err }, "Concierg query error");
        captureException(err);
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
    image: ImageData | null = null
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
      const context = getConciergContext();
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

    // Image reference (saved to disk, path in text — Claude Code can read files)
    if (image && (image as any).localPath) {
      parts.push(`[Image attached: ${(image as any).localPath}]`);
    }

    // User message
    parts.push(text);

    return parts.join("\n\n");
  }
}
