import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-code";
import { getConciergContext } from "../db/queries.js";
import { INTENT_TYPES, type IntentType } from "../types/index.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("mcp-tools");

// --- Per-call context (safe: ConciergSession enforces sequential via `busy`) ---

export interface RegisteredIntent {
  type: IntentType;
  project: string | null;
  prompt: string;
  userSummary: string;
  workerId: number | null;
  questionId: number | null;
  emoji: string | null;
}

export interface WorkerDetails {
  state: string;
  stdout: string;
  stderr: string;
  events: Array<{ timestamp: Date; type: string; content: string }>;
  totalCostUsd: number;
  hasManagerLLM: boolean;
}

interface McpContext {
  chatId: number;
  intents: RegisteredIntent[];
  sendMessage: (chatId: number, text: string) => Promise<void>;
  sendPhoto: (chatId: number, photoPath: string, caption?: string) => Promise<void>;
  getWorkerDetails: (workerId: number) => WorkerDetails | null;
}

let currentCtx: McpContext | null = null;

// Global worker details provider — set once at startup from Manager
let workerDetailsProvider: ((workerId: number) => WorkerDetails | null) | null = null;

export function setWorkerDetailsProvider(provider: (workerId: number) => WorkerDetails | null): void {
  workerDetailsProvider = provider;
}

export function setMcpContext(ctx: McpContext): void {
  currentCtx = ctx;
}

export function clearMcpContext(): void {
  currentCtx = null;
}

export function getWorkerDetailsFromProvider(workerId: number): WorkerDetails | null {
  return workerDetailsProvider?.(workerId) ?? null;
}

export function getRegisteredIntents(): RegisteredIntent[] {
  return currentCtx?.intents ?? [];
}

// --- Tool definitions ---

const sendTelegramMessageTool = tool(
  "send_telegram_message",
  "Send a message to the user in Telegram. Use this for all user communication — replies, questions, status updates. You can call this multiple times to send multiple messages.",
  { text: z.string().describe("The message text to send to the user") },
  async (args) => {
    if (!currentCtx) {
      return { content: [{ type: "text" as const, text: "Error: no active context" }] };
    }
    if (!args.text || args.text.trim() === "") {
      return { content: [{ type: "text" as const, text: "Error: text cannot be empty" }] };
    }
    try {
      await currentCtx.sendMessage(currentCtx.chatId, args.text);
      return { content: [{ type: "text" as const, text: "Message sent successfully" }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "send_telegram_message failed");
      return { content: [{ type: "text" as const, text: `Error sending message: ${msg}` }] };
    }
  }
);

const sendTelegramPhotoTool = tool(
  "send_telegram_photo",
  "Send a photo to the user in Telegram. Use this to send images (downloaded files, screenshots, etc.). The photo must be a local file path.",
  {
    photo_path: z.string().describe("Absolute path to the image file on disk"),
    caption: z.string().optional().describe("Optional caption for the photo"),
  },
  async (args) => {
    if (!currentCtx) {
      return { content: [{ type: "text" as const, text: "Error: no active context" }] };
    }
    if (!args.photo_path || args.photo_path.trim() === "") {
      return { content: [{ type: "text" as const, text: "Error: photo_path cannot be empty" }] };
    }
    try {
      await currentCtx.sendPhoto(currentCtx.chatId, args.photo_path, args.caption);
      return { content: [{ type: "text" as const, text: "Photo sent successfully" }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "send_telegram_photo failed");
      return { content: [{ type: "text" as const, text: `Error sending photo: ${msg}` }] };
    }
  }
);

const INTENT_TYPE_ENUM = z.enum(INTENT_TYPES);

const registerIntentTool = tool(
  "register_intent",
  "Register an actionable intent for the system to process. Use this for spawn_worker, follow_up, answer_question, stop, pause, resume, restore_worker, status. Do NOT use this for general chat — use send_telegram_message instead.",
  {
    type: INTENT_TYPE_ENUM.describe("The intent type"),
    project: z.string().optional().describe("Project name (required for spawn_worker)"),
    prompt: z.string().optional().describe("Task description or message (required for spawn_worker and follow_up)"),
    userSummary: z.string().optional().describe("Short user-friendly task summary in user's language, shown in Telegram. No technical details."),
    workerId: z.number().optional().describe("Worker ID (required for follow_up, stop, pause, resume, restore_worker)"),
    questionId: z.number().optional().describe("Question ID (required for answer_question)"),
    emoji: z.string().optional().describe("A single emoji representing the task theme (required for spawn_worker). Be creative and varied."),
  },
  async (args) => {
    if (!currentCtx) {
      return { content: [{ type: "text" as const, text: "Error: no active context" }] };
    }

    const { type } = args;

    // Validation rules per intent type
    if (type === "spawn_worker") {
      if (!args.project || args.project.trim() === "") {
        return { content: [{ type: "text" as const, text: "spawn_worker requires a project name. Call get_system_state to see available projects." }] };
      }
      if (!args.prompt || args.prompt.trim() === "") {
        return { content: [{ type: "text" as const, text: "spawn_worker requires a non-empty prompt describing the task." }] };
      }
      if (!args.emoji) {
        return { content: [{ type: "text" as const, text: "spawn_worker requires an emoji for the task." }] };
      }
    }

    if (type === "follow_up") {
      if (args.workerId == null) {
        return { content: [{ type: "text" as const, text: "follow_up requires workerId. Call get_system_state to see active workers." }] };
      }
      if (!args.prompt || args.prompt.trim() === "") {
        return { content: [{ type: "text" as const, text: "follow_up requires a non-empty prompt describing the task." }] };
      }
    }

    if (type === "answer_question") {
      if (args.questionId == null) {
        return { content: [{ type: "text" as const, text: "answer_question requires questionId. Call get_system_state to see pending questions." }] };
      }
    }

    if (type === "stop" || type === "pause" || type === "resume" || type === "restore_worker") {
      if (args.workerId == null) {
        return { content: [{ type: "text" as const, text: `${type} requires workerId.` }] };
      }
    }

    const intent: RegisteredIntent = {
      type,
      project: args.project ?? null,
      prompt: args.prompt ?? "",
      userSummary: args.userSummary ?? "",
      workerId: args.workerId ?? null,
      questionId: args.questionId ?? null,
      emoji: args.emoji ?? null,
    };

    currentCtx.intents.push(intent);
    log.info({ type, project: intent.project, workerId: intent.workerId }, "Intent registered");

    return { content: [{ type: "text" as const, text: `Intent registered: ${type}` }] };
  }
);

const getSystemStateTool = tool(
  "get_system_state",
  "Get the current system state: registered projects, active workers (with state, prompt, current activity), and pending questions.",
  {},
  async () => {
    try {
      const context = getConciergContext();

      const projectNames = context.projects.map((p) => p.name).join(", ");
      const activeWorkers = context.activeWorkers
        .map((w) => {
          let info = `  Worker #${w.id}: project_id=${w.projectId}, state=${w.state}, prompt="${w.currentPrompt}"`;
          if (w.lastActivityAt) {
            const minutes = Math.floor(
              (Date.now() - new Date(w.lastActivityAt + "Z").getTime()) / 60000
            );
            info += `, last_activity=${minutes}min ago`;
          }
          // Add current activity one-liner from worker events
          if (currentCtx) {
            const details = currentCtx.getWorkerDetails(w.id);
            if (details && details.events.length > 0) {
              const lastAction = [...details.events].reverse().find(e => e.type !== 'state');
              if (lastAction) {
                info += `, doing="${lastAction.content.slice(0, 80)}"`;
              }
            }
          }
          return info;
        })
        .join("\n");
      const pendingQs = context.pendingQuestions
        .map((q) => `  Q#${q.id} (worker #${q.workerId}): "${q.question}"`)
        .join("\n");

      const stateText = [
        `Projects: ${projectNames || "(none)"}`,
        `Active workers:`,
        activeWorkers || "  (none)",
        `Pending questions:`,
        pendingQs || "  (none)",
      ].join("\n");

      return { content: [{ type: "text" as const, text: stateText }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "get_system_state failed");
      return { content: [{ type: "text" as const, text: `Error getting system state: ${msg}` }] };
    }
  }
);

const getWorkerDetailsTool = tool(
  "get_worker_details",
  "Get detailed information about a specific worker: state, recent events (manager-worker interactions), cumulative cost, and time since last activity. Use this when the user asks about a specific worker's progress.",
  {
    workerId: z.number().describe("The worker ID to get details for"),
  },
  async (args) => {
    if (!currentCtx) {
      return { content: [{ type: "text" as const, text: "Error: no active context" }] };
    }

    const details = currentCtx.getWorkerDetails(args.workerId);
    if (!details) {
      return { content: [{ type: "text" as const, text: `Worker #${args.workerId} not found` }] };
    }

    const events = details.events
      .slice(-20)
      .map((e) => {
        const time = e.timestamp instanceof Date
          ? e.timestamp.toISOString().slice(11, 19)
          : String(e.timestamp);
        return `  [${time}] ${e.type}: ${e.content}`;
      })
      .join("\n");

    const text = [
      `Worker #${args.workerId}:`,
      `  State: ${details.state}`,
      `  Total cost: $${details.totalCostUsd.toFixed(4)}`,
      `  Manager LLM: ${details.hasManagerLLM ? "active" : "none"}`,
      `  Last stdout: ${details.stdout ? details.stdout.slice(0, 300) : "(none)"}`,
      details.stderr ? `  Last stderr: ${details.stderr.slice(0, 300)}` : null,
      `\nRecent events (last 20):`,
      events || "  (none)",
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// --- MCP server ---

export const conciergMcpServer = createSdkMcpServer({
  name: "concierg",
  tools: [sendTelegramMessageTool, sendTelegramPhotoTool, registerIntentTool, getSystemStateTool, getWorkerDetailsTool],
});
