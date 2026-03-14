import { z } from "zod";
import cron from "node-cron";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-code";
import {
  getSvarogContext,
  getWorkerRecentMessages,
  getProjectByName,
  insertScheduledTask,
  getAllScheduledTasks,
  getScheduledTaskById,
  deleteScheduledTask,
  updateScheduledTaskEnabled,
} from "../db/queries.js";
import { getConfig } from "../config/index.js";
import { INTENT_TYPES, type IntentType } from "../types/index.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("mcp-tools");

// --- Per-call context (safe: SvarogSession enforces sequential via `busy`) ---

export interface RegisteredIntent {
  type: IntentType;
  project: string | null;
  prompt: string;
  userSummary: string;
  workerId: number | null;
  questionId: number | null;
  emoji: string | null;
  planMode: boolean;
}

interface McpContext {
  chatId: number;
  intents: RegisteredIntent[];
  sendMessage: (chatId: number, text: string) => Promise<void>;
  sendPhoto: (chatId: number, photoPath: string, caption?: string) => Promise<void>;
}

let currentCtx: McpContext | null = null;

export function setMcpContext(ctx: McpContext): void {
  currentCtx = ctx;
}

export function clearMcpContext(): void {
  currentCtx = null;
}

// --- Pool info getter (set once at startup from index.ts) ---

export interface WorkerPoolInfo {
  poolStatus: 'warm' | 'cold' | 'not_in_pool';
  phase: 'planning' | 'executing';
  hasPendingPlan: boolean;
}

let poolInfoGetter: ((workerId: number) => WorkerPoolInfo | null) | null = null;

export function setPoolInfoGetter(getter: (workerId: number) => WorkerPoolInfo | null): void {
  poolInfoGetter = getter;
}

// --- Scheduler ref (set once at startup from index.ts) ---

interface SchedulerRef {
  addSchedule(scheduleId: number, cronExpression: string, timezone: string): void;
  removeSchedule(scheduleId: number): void;
}

let schedulerRef: SchedulerRef | null = null;

export function setSchedulerRef(ref: SchedulerRef): void {
  schedulerRef = ref;
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
  "Register an actionable intent for the system to process. Use this for spawn_worker, follow_up, answer_question, approve_plan, reject_plan, skip_plan, switch_to_plan, stop, pause, resume, restore_worker, status. Do NOT use this for general chat — use send_telegram_message instead.",
  {
    type: INTENT_TYPE_ENUM.describe("The intent type"),
    project: z.string().optional().describe("Project name (required for spawn_worker)"),
    prompt: z.string().optional().describe("Task description or message (required for spawn_worker and follow_up)"),
    userSummary: z.string().optional().describe("Short user-friendly task summary in user's language, shown in Telegram. No technical details."),
    workerId: z.number().optional().describe("Worker ID (required for follow_up, stop, pause, resume, restore_worker)"),
    questionId: z.number().optional().describe("Question ID (required for answer_question)"),
    emoji: z.string().optional().describe("A single emoji representing the task theme (required for spawn_worker). Be creative and varied."),
    planMode: z.boolean().optional().describe("If true (default), worker starts in plan mode — reviews plan before executing. Set false if user says to skip planning or just do it."),
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

    if (type === "approve_plan" || type === "reject_plan") {
      if (args.workerId == null) {
        return { content: [{ type: "text" as const, text: `${type} requires workerId.` }] };
      }
      if (type === "reject_plan" && (!args.prompt || args.prompt.trim() === "")) {
        return { content: [{ type: "text" as const, text: "reject_plan requires prompt with the feedback." }] };
      }
    }

    if (type === "skip_plan" || type === "switch_to_plan") {
      if (args.workerId == null) {
        return { content: [{ type: "text" as const, text: `${type} requires workerId.` }] };
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
      planMode: args.planMode ?? true,
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
      const context = getSvarogContext();

      const projectNames = context.projects.map((p) => p.name).join(", ");
      const activeWorkers = context.activeWorkers
        .map((w) => {
          let info = `  Worker #${w.id}: project_id=${w.projectId}, state=${w.state}, prompt="${w.currentPrompt}"`;

          // Pool info from dispatcher
          const pInfo = poolInfoGetter?.(w.id);
          if (pInfo) {
            info += `, pool_status=${pInfo.poolStatus}, phase=${pInfo.phase}, has_pending_plan=${pInfo.hasPendingPlan}`;
          } else {
            info += `, pool_status=not_in_pool`;
          }

          if (w.lastActivityAt) {
            const minutes = Math.floor(
              (Date.now() - new Date(w.lastActivityAt + "Z").getTime()) / 60000
            );
            const poolStatus = pInfo?.poolStatus;
            if (poolStatus === 'cold') {
              info += `, idle_for=${minutes}min (worker is cold - waiting for interaction, NOT stuck)`;
            } else {
              info += `, idle_for=${minutes}min`;
            }
          }

          // Recent worker messages from DB
          const recentMsgs = getWorkerRecentMessages(w.id, 3);
          if (recentMsgs.length > 0) {
            const msgLines = recentMsgs.reverse().map((m) => {
              const data = typeof m.data === "string" ? JSON.parse(m.data) : m.data;
              const text = (data as any)?.text || "";
              return `    recent: "${text.slice(0, 150)}"`;
            });
            info += "\n" + msgLines.join("\n");
          }

          return info;
        })
        .join("\n");
      const recoverableWorkers = context.recoverableWorkers
        .map((w) => {
          let info = `  Worker #${w.id}: project_id=${w.projectId}, prompt="${w.currentPrompt}"`;
          if (w.lastActivityAt) {
            const minutes = Math.floor(
              (Date.now() - new Date(w.lastActivityAt + "Z").getTime()) / 60000
            );
            info += `, stopped_for=${minutes}min`;
          }
          return info;
        })
        .join("\n");

      const pendingQs = context.pendingQuestions
        .map((q) => `  Q#${q.id} (worker #${q.workerId}): "${q.question}"`)
        .join("\n");

      // Scheduled tasks summary
      const schedules = getAllScheduledTasks();
      const scheduleLines = schedules.length > 0
        ? schedules.map(({ schedule: s, project: p }) => {
            const status = s.enabled ? "active" : "paused";
            return `  #${s.id} [${status}] ${s.emoji || "⏰"} "${s.userSummary}" — project: ${p.name}, cron: ${s.cronExpression}`;
          }).join("\n")
        : "  (none)";

      const stateText = [
        `Projects: ${projectNames || "(none)"}`,
        `Active workers:`,
        activeWorkers || "  (none)",
        `Recoverable workers (stopped but can be resumed via follow_up or restore_worker):`,
        recoverableWorkers || "  (none)",
        `Pending questions:`,
        pendingQs || "  (none)",
        `Scheduled tasks:`,
        scheduleLines,
      ].join("\n");

      return { content: [{ type: "text" as const, text: stateText }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "get_system_state failed");
      return { content: [{ type: "text" as const, text: `Error getting system state: ${msg}` }] };
    }
  }
);

const manageScheduleTool = tool(
  "manage_schedule",
  "Create, list, delete, enable, or disable scheduled tasks. Scheduled tasks run automatically at specified times, spawning a worker in the correct project directory. Use this for recurring checks, alerts, and automated monitoring.",
  {
    action: z.enum(["create", "list", "delete", "enable", "disable"]).describe(
      "Action to perform: create a new schedule, list all schedules, delete/enable/disable a schedule by ID"
    ),
    scheduleId: z.number().optional().describe("Schedule ID (required for delete/enable/disable)"),
    project: z.string().optional().describe("Project name (required for create)"),
    cronExpression: z.string().optional().describe(
      "Cron expression (required for create). Examples: '0 9 * * *' (daily 9am), '0 8 * * 1' (Mon 8am), '0 */2 * * *' (every 2h)"
    ),
    timezone: z.string().optional().describe("Timezone (e.g. 'America/New_York'). Defaults to config USER_TIMEZONE."),
    prompt: z.string().optional().describe("Detailed task instructions for the worker (required for create)"),
    userSummary: z.string().optional().describe("Short human-readable description (required for create)"),
    emoji: z.string().optional().describe("Emoji for the scheduled task"),
    runOnce: z.boolean().optional().describe("If true, schedule runs once then auto-disables. Default false."),
  },
  async (args) => {
    if (!currentCtx) {
      return { content: [{ type: "text" as const, text: "Error: no active context" }] };
    }

    try {
      switch (args.action) {
        case "create": {
          if (!args.project || !args.cronExpression || !args.prompt || !args.userSummary) {
            return { content: [{ type: "text" as const, text: "create requires: project, cronExpression, prompt, userSummary" }] };
          }

          // Validate cron expression
          if (!cron.validate(args.cronExpression)) {
            return { content: [{ type: "text" as const, text: `Invalid cron expression: "${args.cronExpression}". Use standard 5-field cron syntax.` }] };
          }

          // Resolve project
          const project = getProjectByName(args.project);
          if (!project) {
            return { content: [{ type: "text" as const, text: `Project "${args.project}" not found. Call get_system_state to see available projects.` }] };
          }

          const config = getConfig();
          const timezone = args.timezone || config.USER_TIMEZONE;

          const row = insertScheduledTask({
            projectId: project.id,
            cronExpression: args.cronExpression,
            timezone,
            prompt: args.prompt,
            userSummary: args.userSummary,
            emoji: args.emoji,
            telegramChatId: currentCtx.chatId,
            runOnce: args.runOnce,
          });

          // Register live cron job
          schedulerRef?.addSchedule(row.id, row.cronExpression, row.timezone);

          log.info({ scheduleId: row.id, cron: row.cronExpression, project: args.project }, "Schedule created");

          return {
            content: [{
              type: "text" as const,
              text: `Schedule #${row.id} created:\n` +
                `  Project: ${args.project}\n` +
                `  Cron: ${args.cronExpression}\n` +
                `  Timezone: ${timezone}\n` +
                `  Task: ${args.userSummary}\n` +
                `  ${args.runOnce ? "(one-time)" : "(recurring)"}`
            }],
          };
        }

        case "list": {
          const tasks = getAllScheduledTasks(currentCtx.chatId);
          if (tasks.length === 0) {
            return { content: [{ type: "text" as const, text: "No scheduled tasks found." }] };
          }

          const lines = tasks.map(({ schedule: s, project: p }) => {
            const status = s.enabled ? "active" : "paused";
            const lastRun = s.lastRunAt ? `last run: ${s.lastRunAt}` : "never run";
            const oneTime = s.runOnce ? " (one-time)" : "";
            return `  #${s.id} [${status}] ${s.emoji || "⏰"} "${s.userSummary}" — project: ${p.name}, cron: ${s.cronExpression}, tz: ${s.timezone}, ${lastRun}${oneTime}`;
          });

          return {
            content: [{
              type: "text" as const,
              text: `Scheduled tasks (${tasks.length}):\n${lines.join("\n")}`
            }],
          };
        }

        case "delete": {
          if (args.scheduleId == null) {
            return { content: [{ type: "text" as const, text: "delete requires scheduleId" }] };
          }
          const existing = getScheduledTaskById(args.scheduleId);
          if (!existing) {
            return { content: [{ type: "text" as const, text: `Schedule #${args.scheduleId} not found.` }] };
          }
          schedulerRef?.removeSchedule(args.scheduleId);
          deleteScheduledTask(args.scheduleId);
          log.info({ scheduleId: args.scheduleId }, "Schedule deleted");
          return { content: [{ type: "text" as const, text: `Schedule #${args.scheduleId} deleted: "${existing.schedule.userSummary}"` }] };
        }

        case "enable": {
          if (args.scheduleId == null) {
            return { content: [{ type: "text" as const, text: "enable requires scheduleId" }] };
          }
          const existing = getScheduledTaskById(args.scheduleId);
          if (!existing) {
            return { content: [{ type: "text" as const, text: `Schedule #${args.scheduleId} not found.` }] };
          }
          updateScheduledTaskEnabled(args.scheduleId, true);
          schedulerRef?.addSchedule(args.scheduleId, existing.schedule.cronExpression, existing.schedule.timezone);
          log.info({ scheduleId: args.scheduleId }, "Schedule enabled");
          return { content: [{ type: "text" as const, text: `Schedule #${args.scheduleId} enabled: "${existing.schedule.userSummary}"` }] };
        }

        case "disable": {
          if (args.scheduleId == null) {
            return { content: [{ type: "text" as const, text: "disable requires scheduleId" }] };
          }
          const existing = getScheduledTaskById(args.scheduleId);
          if (!existing) {
            return { content: [{ type: "text" as const, text: `Schedule #${args.scheduleId} not found.` }] };
          }
          updateScheduledTaskEnabled(args.scheduleId, false);
          schedulerRef?.removeSchedule(args.scheduleId);
          log.info({ scheduleId: args.scheduleId }, "Schedule disabled");
          return { content: [{ type: "text" as const, text: `Schedule #${args.scheduleId} paused: "${existing.schedule.userSummary}"` }] };
        }

        default:
          return { content: [{ type: "text" as const, text: `Unknown action: ${args.action}` }] };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "manage_schedule failed");
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
    }
  }
);

// --- MCP server ---

export const svarogMcpServer = createSdkMcpServer({
  name: "svarog",
  tools: [sendTelegramMessageTool, sendTelegramPhotoTool, registerIntentTool, getSystemStateTool, manageScheduleTool],
});
