import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-code";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("manager-llm-mcp");

/**
 * Context passed via closure to each ManagerLLM's MCP tools.
 * One instance per ManagerLLM — no shared global state.
 */
export interface ManagerLLMToolContext {
  workerId: number;
  workerEmoji: string;
  getWorkerPhase: () => 'planning' | 'executing';
  /** Route messages through Concierg — only Concierg talks to the user */
  notifyConcierg: (text: string) => void;
  /** Resolve the pending worker question Promise */
  getQuestionResolver: () => ((answer: string) => void) | null;
  /** Resolve the pending worker plan review Promise */
  getPlanResolver: () => ((decision: string) => void) | null;
  /** Insert a pending question row in DB, returns questionId */
  insertQuestion: (workerId: number, question: string) => number;
  /** Send follow-up to the worker session */
  workerFollowUp: (message: string) => Promise<void>;
  /** Get worker status and recent events */
  getWorkerStatus: () => {
    state: string;
    recentEvents: Array<{ timestamp: Date; type: string; content: string }>;
  } | null;
}

/**
 * Factory: creates a per-instance MCP server for a ManagerLLM.
 * Each worker's ManagerLLM gets its own server with closured context.
 */
export function createManagerLLMMcpServer(ctx: ManagerLLMToolContext) {
  const reportProgress = tool(
    "report_progress",
    "Report worker progress, results, or plan summaries to the user. Use for status updates, completion summaries, and plan reviews. Do NOT use for questions — use ask_user_question instead. Metadata (worker ID, emoji, phase) is added automatically.",
    { text: z.string().describe("Progress report text in user's language") },
    async (args) => {
      if (!args.text?.trim()) {
        return { content: [{ type: "text" as const, text: "Error: text cannot be empty" }] };
      }
      const phase = ctx.getWorkerPhase();
      const meta = `[Worker #${ctx.workerId} | ${ctx.workerEmoji} | phase: ${phase}]`;
      ctx.notifyConcierg(`${meta}\n${args.text}`);
      return { content: [{ type: "text" as const, text: "Message delivered" }] };
    }
  );

  const sendTelegramPhoto = tool(
    "send_telegram_photo",
    "Send a photo to the user. The photo notification is routed through the Concierg.",
    {
      photo_path: z.string().describe("Absolute path to the image file"),
      caption: z.string().optional().describe("Optional caption"),
    },
    async (args) => {
      if (!args.photo_path?.trim()) {
        return { content: [{ type: "text" as const, text: "Error: photo_path cannot be empty" }] };
      }
      const phase = ctx.getWorkerPhase();
      const meta = `[Worker #${ctx.workerId} | ${ctx.workerEmoji} | phase: ${phase} | PHOTO]`;
      ctx.notifyConcierg(`${meta}\nPhoto: ${args.photo_path}${args.caption ? '\nCaption: ' + args.caption : ''}`);
      return { content: [{ type: "text" as const, text: "Photo notification sent" }] };
    }
  );

  const answerWorkerQuestion = tool(
    "answer_worker_question",
    "Answer the worker's pending question. This resolves the worker's blocked AskUserQuestion and lets it continue. Use this to auto-answer obvious questions or relay the user's answer.",
    { answer: z.string().describe("The answer to give to the worker") },
    async (args) => {
      if (!args.answer?.trim()) {
        return { content: [{ type: "text" as const, text: "Error: answer cannot be empty" }] };
      }
      const resolver = ctx.getQuestionResolver();
      if (!resolver) {
        return { content: [{ type: "text" as const, text: "No pending question to answer" }] };
      }
      try {
        resolver(args.answer);
        return { content: [{ type: "text" as const, text: "Answer delivered to worker" }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err, workerId: ctx.workerId }, "answer_worker_question failed");
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    }
  );

  const askUserQuestion = tool(
    "ask_user_question",
    "Escalate a question to the user. The question is routed through the Concierg. Use when the worker's question requires a user decision. Rephrase in the user's language. Include options when available.",
    {
      question: z.string().describe("The question to ask the user, in the user's language"),
      options: z.array(z.object({
        label: z.string().describe("Short option label"),
        description: z.string().optional().describe("Additional context"),
      })).optional().describe("Available options for the user to choose from."),
    },
    async (args) => {
      if (!args.question?.trim()) {
        return { content: [{ type: "text" as const, text: "Error: question cannot be empty" }] };
      }
      try {
        const questionId = ctx.insertQuestion(ctx.workerId, args.question);
        const phase = ctx.getWorkerPhase();
        let eventText = `[QUESTION #${questionId} | Worker #${ctx.workerId} | ${ctx.workerEmoji} | phase: ${phase}]\n${args.question}`;
        if (args.options?.length) {
          eventText += '\nOptions:\n' + args.options
            .map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ' — ' + o.description : ''}`)
            .join('\n');
        }
        ctx.notifyConcierg(eventText);
        return {
          content: [{
            type: "text" as const,
            text: `Question #${questionId} sent to user. Waiting for answer.`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err, workerId: ctx.workerId }, "ask_user_question failed");
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    }
  );

  const sendWorkerFollowUp = tool(
    "send_worker_follow_up",
    "Send a follow-up instruction to the worker. Translate user's message into clear English technical instructions.",
    { message: z.string().describe("Technical instruction for the worker (in English)") },
    async (args) => {
      if (!args.message?.trim()) {
        return { content: [{ type: "text" as const, text: "Error: message cannot be empty" }] };
      }
      try {
        await ctx.workerFollowUp(args.message);
        return { content: [{ type: "text" as const, text: "Follow-up sent to worker" }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err, workerId: ctx.workerId }, "send_worker_follow_up failed");
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    }
  );

  const answerWorkerPlan = tool(
    "answer_worker_plan",
    "Approve or reject the worker's plan. MUST start with 'APPROVED:' or 'REJECTED:' prefix — this is machine-parsed. Include feedback after the prefix.",
    { decision: z.string().describe("Must start with APPROVED: or REJECTED: followed by comments") },
    async (args) => {
      if (!args.decision?.trim()) {
        return { content: [{ type: "text" as const, text: "Error: decision cannot be empty" }] };
      }
      const trimmed = args.decision.trimStart();
      if (!trimmed.startsWith("APPROVED:") && !trimmed.startsWith("REJECTED:")) {
        return { content: [{ type: "text" as const, text: "Error: decision must start with APPROVED: or REJECTED:" }] };
      }
      const resolver = ctx.getPlanResolver();
      if (!resolver) {
        return { content: [{ type: "text" as const, text: "No pending plan to review" }] };
      }
      try {
        resolver(args.decision);
        return { content: [{ type: "text" as const, text: "Plan decision delivered to worker" }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err, workerId: ctx.workerId }, "answer_worker_plan failed");
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    }
  );

  const getWorkerStatus = tool(
    "get_worker_status",
    "Check the worker's current state and recent activity events.",
    {},
    async () => {
      const status = ctx.getWorkerStatus();
      if (!status) {
        return { content: [{ type: "text" as const, text: "Worker not found or not active" }] };
      }
      const events = status.recentEvents
        .slice(-10)
        .map((e) => `  [${e.type}] ${e.content}`)
        .join("\n");
      return {
        content: [{
          type: "text" as const,
          text: `State: ${status.state}\nRecent events:\n${events || "  (none)"}`,
        }],
      };
    }
  );

  return createSdkMcpServer({
    name: "manager_llm",
    tools: [
      reportProgress,
      sendTelegramPhoto,
      answerWorkerQuestion,
      answerWorkerPlan,
      askUserQuestion,
      sendWorkerFollowUp,
      getWorkerStatus,
    ],
  });
}
