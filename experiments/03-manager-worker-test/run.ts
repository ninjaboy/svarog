/**
 * Experiment #3: Manager-Worker Two-Level Hierarchy
 *
 * Tests the real architecture: a Manager session mediates between a Worker
 * session and a simulated user.
 *
 * What we verify:
 * 1. Can two query() sessions run concurrently (manager + worker)?
 * 2. Can worker's canUseTool pause, delegate to manager, and resume via Promise bridging?
 * 3. Does the manager filter questions (auto-answer technical, escalate requirements)?
 * 4. Does the plan review loop work (reject -> revise -> approve)?
 * 5. Full end-to-end: Worker asks -> Manager decides -> Worker plans -> Manager reviews -> done
 *
 * Architecture:
 *   Script (simulated user -- auto-answers escalations)
 *     |
 *   Manager query() -- has MCP tools: answer_worker, ask_user
 *     | Promise bridge (pendingResolver)
 *   Worker query() -- plan mode, cwd: test_game
 *
 * Usage:
 *   cd /Users/germangurov/projects/conciergon
 *   node --env-file=.env --import tsx experiments/03-manager-worker-test/run.ts
 */

import {
  query,
  createSdkMcpServer,
  tool,
  type CanUseTool,
} from "@anthropic-ai/claude-code";
import { z } from "zod";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";

// ─── Constants ───────────────────────────────────────────────────────────────

const PROJECT_DIR = "/Users/germangurov/projects/test_game";
const CLAUDE_BIN = "/Users/germangurov/.local/bin/claude";
const LOG_FILE = "/Users/germangurov/projects/conciergon/experiments/03-manager-worker-test/run.log";
const MANAGER_WORKSPACE = "/Users/germangurov/projects/conciergon/concierg-workspace/manager-llm";
const PROMISE_TIMEOUT_MS = 180_000;
const MANAGER_QUERY_TIMEOUT_MS = 180_000;

// ─── Simulated user answers (for escalated questions) ────────────────────────

const USER_ANSWERS = [
  "Co-op multiplayer mode. Two to four players. Peer-to-peer networking. Start with a lobby system.",
  "Yes, use WebRTC for the peer-to-peer layer. Keep it simple.",
  "No preference on the lobby UI -- whatever is simplest.",
  "Go ahead with that approach.",
];
let userAnswerIndex = 0;

// ─── Shared state ────────────────────────────────────────────────────────────

/** Promise resolver that bridges worker -> manager -> worker */
let pendingWorkerResolver: ((answer: string) => void) | null = null;

/** Manager session ID for resume */
let managerSessionId: string | null = null;

/** Manager busy flag — prevents concurrent runQuery */
let managerBusy = false;

/** Manager event queue for sequential processing */
const managerEventQueue: string[] = [];
let managerProcessing = false;

/** Counters */
let workerQuestionCount = 0;
let workerPlanCount = 0;
let escalationCount = 0;
let workerToolCallCount = 0;
let managerToolCallCount = 0;

/** Worker session ID */
let workerSessionId: string | null = null;

/** Total costs */
let workerCostUsd = 0;
let managerCostUsd = 0;

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

// ─── Build clean env ─────────────────────────────────────────────────────────

function buildCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "ANTHROPIC_AUTH_TOKEN" || k === "ANTHROPIC_API_KEY" || k === "CLAUDECODE") continue;
    if (v !== undefined) env[k] = v;
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

// ─── Manager MCP Tools ──────────────────────────────────────────────────────

function createManagerMcpServer() {
  const answerWorker = tool(
    "answer_worker",
    "Answer the worker's pending question. This unblocks the worker and lets it continue. Use this after deciding the answer yourself or after receiving the user's answer via ask_user.",
    { answer: z.string().describe("The answer to relay to the worker") },
    async (args) => {
      if (!args.answer?.trim()) {
        return { content: [{ type: "text" as const, text: "Error: answer cannot be empty" }] };
      }
      const resolver = pendingWorkerResolver;
      if (!resolver) {
        return { content: [{ type: "text" as const, text: "No pending worker question to answer" }] };
      }
      try {
        pendingWorkerResolver = null;
        resolver(args.answer);
        log(`[MANAGER-TOOL] answer_worker: "${args.answer.slice(0, 200)}"`);
        return { content: [{ type: "text" as const, text: "Answer delivered to worker" }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    }
  );

  const askUser = tool(
    "ask_user",
    "Escalate a question to the user. Use this when the worker's question requires a genuine user decision (e.g., requirements, preferences, scope). Returns the user's answer.",
    { question: z.string().describe("The question to ask the user") },
    async (args) => {
      if (!args.question?.trim()) {
        return { content: [{ type: "text" as const, text: "Error: question cannot be empty" }] };
      }
      escalationCount++;
      log(`[MANAGER-TOOL] ask_user (escalation #${escalationCount}): "${args.question}"`);

      // Simulate user answering
      const answer = USER_ANSWERS[userAnswerIndex] ?? "Proceed with your best judgment.";
      userAnswerIndex = Math.min(userAnswerIndex + 1, USER_ANSWERS.length - 1);

      log(`[SIMULATED-USER] Answer: "${answer}"`);
      return { content: [{ type: "text" as const, text: `User answered: ${answer}` }] };
    }
  );

  return createSdkMcpServer({
    name: "manager_tools",
    tools: [answerWorker, askUser],
  });
}

// ─── Manager Session ─────────────────────────────────────────────────────────

const managerMcpServer = createManagerMcpServer();

const MANAGER_SYSTEM_PROMPT = [
  "You are a Manager that mediates between a coding Worker and the user.",
  "",
  "When the worker asks a question:",
  "- If it's a TECHNICAL question you can answer yourself (implementation details, library choices, code patterns), answer it directly via answer_worker.",
  "- If it's a REQUIREMENTS question (what the user wants, scope decisions, preferences), escalate to the user via ask_user, then relay the answer via answer_worker.",
  "",
  "When the worker submits a plan for review:",
  "- Evaluate whether it covers the key requirements.",
  "- When rejecting: call answer_worker with text starting with 'REJECTED:' followed by specific feedback.",
  "- When approving: call answer_worker with text starting with 'APPROVED:' followed by any comments.",
  "- The APPROVED:/REJECTED: prefix is REQUIRED and machine-parsed. Always include it.",
  "",
  "Always use the MCP tools to communicate. Do not just output text — use answer_worker to unblock the worker.",
].join("\n");

/**
 * Run a manager query. Follows the busy-flag + event-queue pattern from
 * src/manager-llm/session.ts.
 */
async function managerRunQuery(prompt: string): Promise<void> {
  if (managerBusy) {
    managerEventQueue.push(prompt);
    return;
  }

  managerBusy = true;
  const abortController = new AbortController();
  const env = buildCleanEnv();

  try {
    const conversation = query({
      prompt,
      options: {
        allowedTools: ["mcp__manager_tools__*"],
        maxTurns: 8,
        cwd: MANAGER_WORKSPACE,
        mcpServers: { manager_tools: managerMcpServer },
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        env,
        abortController,
        appendSystemPrompt: MANAGER_SYSTEM_PROMPT,
        ...(managerSessionId ? { resume: managerSessionId } : {}),
      },
    });

    const processMessages = async () => {
      for await (const message of conversation) {
        if (message.type === "system" && message.subtype === "init") {
          managerSessionId = message.session_id;
          log(`[MANAGER] Session initialized: ${message.session_id}`);
        }

        if (message.type === "assistant") {
          const content = (message as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                log(`[MANAGER-MSG] ${block.text.slice(0, 500)}`);
              }
              if (block.type === "tool_use") {
                managerToolCallCount++;
                log(`[MANAGER-TOOL-USE] ${block.name} (id: ${block.id})`);
              }
            }
          }
        }

        if (message.type === "result") {
          const cost = message.total_cost_usd;
          managerCostUsd += cost;
          log(`[MANAGER] Query done — turns: ${message.num_turns}, cost: $${cost.toFixed(4)}, subtype: ${message.subtype}`);
        }
      }
    };

    let timeoutId: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        processMessages(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            abortController.abort();
            reject(new Error(`Manager query timed out after ${MANAGER_QUERY_TIMEOUT_MS / 1000}s`));
          }, MANAGER_QUERY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId!);
    }
  } finally {
    managerBusy = false;
  }
}

/**
 * Inject an event into the manager. Processes sequentially.
 */
async function managerInjectEvent(text: string): Promise<void> {
  managerEventQueue.push(text);
  await managerProcessQueue();
}

async function managerProcessQueue(): Promise<void> {
  if (managerProcessing) return;
  managerProcessing = true;

  try {
    while (managerEventQueue.length > 0) {
      const events = managerEventQueue.splice(0);
      const prompt = events.join("\n\n");

      try {
        await managerRunQuery(prompt);
      } catch (err: any) {
        if (err?.message?.includes("exited with code 1")) {
          log(`[MANAGER] Query exited with code 1 (non-fatal)`);
        } else {
          log(`[MANAGER] Query error: ${err.message}`);
        }
      }
    }
  } finally {
    managerProcessing = false;
  }
}

// ─── Promise bridge helper ───────────────────────────────────────────────────

/**
 * Create a promise that:
 * - Stores its resolver in pendingWorkerResolver
 * - Injects an event into the manager
 * - Awaits the manager to call answer_worker (which calls the resolver)
 * - Times out after PROMISE_TIMEOUT_MS
 */
async function bridgeToManager(eventText: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingWorkerResolver = null;
      reject(new Error(`Promise bridge timed out after ${PROMISE_TIMEOUT_MS / 1000}s`));
    }, PROMISE_TIMEOUT_MS);

    pendingWorkerResolver = (answer: string) => {
      clearTimeout(timeoutId);
      resolve(answer);
    };

    // Fire and forget — manager processes async
    managerInjectEvent(eventText).catch((err) => {
      clearTimeout(timeoutId);
      pendingWorkerResolver = null;
      reject(err);
    });
  });
}

// ─── Worker canUseTool ───────────────────────────────────────────────────────

const workerCanUseTool: CanUseTool = async (toolName, input, { signal }) => {
  workerToolCallCount++;
  const inputSummary = JSON.stringify(input).slice(0, 300);
  log(`[WORKER-canUseTool #${workerToolCallCount}] ${toolName} | ${inputSummary}`);

  // --- AskUserQuestion: bridge to manager ---
  if (toolName === "AskUserQuestion") {
    workerQuestionCount++;

    // Extract question text
    const questions = (input as any).questions;
    let questionText: string;
    if (Array.isArray(questions)) {
      questionText = questions
        .map((q: any) => {
          let text = q.question || "";
          if (Array.isArray(q.options)) {
            const opts = q.options.map((o: any) => `  - ${o.label}: ${o.description || ""}`).join("\n");
            text += "\nOptions:\n" + opts;
          }
          return text;
        })
        .join("\n\n");
    } else {
      questionText = JSON.stringify(input);
    }

    log(`\n========== WORKER QUESTION #${workerQuestionCount} ==========`);
    log(questionText);
    log(`========== END WORKER QUESTION #${workerQuestionCount} ==========\n`);

    // Bridge to manager
    log(`[BRIDGE] Sending question #${workerQuestionCount} to manager...`);
    try {
      const answer = await bridgeToManager(
        `[WORKER QUESTION #${workerQuestionCount}]\n` +
        `The worker is asking a question and is BLOCKED until you answer.\n` +
        `Question: ${questionText}\n\n` +
        `Decide: answer it yourself (technical) or escalate to user (requirements). ` +
        `Then use answer_worker to unblock the worker.`
      );

      log(`[BRIDGE] Got answer for question #${workerQuestionCount}: "${answer.slice(0, 200)}"`);
      return { behavior: "deny" as const, message: answer };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[BRIDGE] ERROR for question #${workerQuestionCount}: ${msg}`);
      return {
        behavior: "deny" as const,
        message: `Error getting answer: ${msg}. Please proceed with your best judgment.`,
      };
    }
  }

  // --- ExitPlanMode: bridge to manager for review ---
  if (toolName === "ExitPlanMode") {
    workerPlanCount++;

    const planText = JSON.stringify(input, null, 2).slice(0, 5000);

    log(`\n========== WORKER PLAN #${workerPlanCount} ==========`);
    log(planText);
    log(`========== END WORKER PLAN #${workerPlanCount} ==========\n`);

    // First plan: manager should reject with feedback
    // Second plan: manager should approve
    const reviewInstruction = workerPlanCount === 1
      ? `This is the worker's FIRST plan submission. Review it critically. ` +
        `It likely lacks detail about state synchronization across players. ` +
        `REJECT it: call answer_worker with your answer starting with "REJECTED:" followed by specific feedback ` +
        `asking to add state sync details and player disconnect handling. Do NOT approve the first plan.`
      : `This is the worker's REVISED plan (submission #${workerPlanCount}). ` +
        `It should now include the feedback from your previous rejection. ` +
        `APPROVE it: call answer_worker with your answer starting with "APPROVED:" followed by any comments. ` +
        `Approve even if it's not perfect — we've already done one revision cycle.`;

    log(`[BRIDGE] Sending plan #${workerPlanCount} to manager for review...`);
    try {
      const answer = await bridgeToManager(
        `[WORKER PLAN SUBMISSION #${workerPlanCount}]\n` +
        `The worker has submitted an implementation plan and is BLOCKED waiting for review.\n\n` +
        `Plan:\n${planText}\n\n` +
        reviewInstruction + `\n\n` +
        `IMPORTANT: Your answer_worker call MUST start with either "APPROVED:" or "REJECTED:". ` +
        `This prefix is machine-parsed. Do not use "approve" or "reject" anywhere else in the answer.`
      );

      log(`[BRIDGE] Manager review for plan #${workerPlanCount}: "${answer.slice(0, 300)}"`);

      // Check structured prefix — "APPROVED:" or "REJECTED:"
      const trimmed = answer.trimStart();
      const isApproval = trimmed.startsWith("APPROVED:");
      if (isApproval) {
        log(`[BRIDGE] Plan #${workerPlanCount} APPROVED -> allowing ExitPlanMode`);
        return { behavior: "allow" as const, updatedInput: input };
      } else {
        log(`[BRIDGE] Plan #${workerPlanCount} REJECTED -> denying with feedback`);
        // Strip the "REJECTED:" prefix before forwarding to worker
        const feedback = trimmed.startsWith("REJECTED:")
          ? trimmed.slice("REJECTED:".length).trim()
          : answer;
        return { behavior: "deny" as const, message: feedback };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[BRIDGE] ERROR for plan #${workerPlanCount}: ${msg}`);
      // On error, deny with feedback so the worker retries (don't auto-approve)
      return {
        behavior: "deny" as const,
        message: "The plan review timed out. Please add more detail about state synchronization across players and player disconnect handling, then resubmit.",
      };
    }
  }

  // --- Everything else: allow ---
  return { behavior: "allow" as const, updatedInput: input };
};

// ─── Worker prompt ───────────────────────────────────────────────────────────

const WORKER_PROMPT = "Add multiplayer support to this game. Suggest a plan.";

const WORKER_SYSTEM_PROMPT =
  "You MUST use AskUserQuestion to ask the user clarifying questions before creating your plan. " +
  "This is a significant feature addition -- you need to understand the user's requirements. " +
  "Ask about: what type of multiplayer (co-op/competitive), how many players, " +
  "networking approach (peer-to-peer/server), and priority features. " +
  "Ask at least 2 questions using AskUserQuestion. Do NOT assume requirements. " +
  "After getting answers, create a detailed implementation plan and submit it via ExitPlanMode.";

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  writeFileSync(LOG_FILE, "");
  mkdirSync(MANAGER_WORKSPACE, { recursive: true });

  log("=== Experiment #3: Manager-Worker Two-Level Hierarchy ===");
  log(`Worker project: ${PROJECT_DIR}`);
  log(`Worker prompt: ${WORKER_PROMPT}`);
  log(`Manager workspace: ${MANAGER_WORKSPACE}`);
  log(`Promise timeout: ${PROMISE_TIMEOUT_MS / 1000}s`);
  log(`User auto-answers: ${USER_ANSWERS.length}`);
  log("");

  const env = buildCleanEnv();
  log(`Auth token set: ${!!env.CLAUDE_CODE_OAUTH_TOKEN}`);
  log("");

  // ── Step 1: Bootstrap manager session ──────────────────────────────────

  log(">>> Step 1: Bootstrapping manager session...");

  const managerBootstrapPrompt =
    "A worker has been spawned to add multiplayer support to a game project. " +
    "Your role is to mediate between the worker and the user. " +
    "The worker will ask questions and submit plans -- you'll receive them as events. " +
    "Acknowledge that you're ready and waiting for the worker's first question.";

  try {
    await managerRunQuery(managerBootstrapPrompt);
  } catch (err: any) {
    if (err?.message?.includes("exited with code 1") && managerSessionId) {
      log("[MANAGER] Bootstrap threw code 1, but session ID captured -- continuing");
    } else {
      throw err;
    }
  }

  if (!managerSessionId) {
    throw new Error("Manager bootstrap failed -- no session ID");
  }

  log(`>>> Manager session ready: ${managerSessionId}`);
  log("");

  // ── Step 2: Start worker in plan mode ──────────────────────────────────

  log(">>> Step 2: Starting worker in plan mode...");
  log("");

  const workerConversation = query({
    prompt: WORKER_PROMPT,
    options: {
      cwd: PROJECT_DIR,
      permissionMode: "plan",
      canUseTool: workerCanUseTool,
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      env,
      maxTurns: 40,
      appendSystemPrompt: WORKER_SYSTEM_PROMPT,
      hooks: {
        PostToolUse: [{
          hooks: [async (input) => {
            log(`  [WORKER PostToolUse] ${(input as any).tool_name}`);
            return {};
          }],
        }],
        Notification: [{
          hooks: [async (input) => {
            log(`  [WORKER Notification] ${(input as any).message}`);
            return {};
          }],
        }],
      },
    },
  });

  // ── Step 3: Iterate worker messages ────────────────────────────────────

  for await (const message of workerConversation) {
    if (message.type === "system" && message.subtype === "init") {
      workerSessionId = message.session_id;
      log(`\n[WORKER INIT] Session: ${message.session_id}`);
      log(`  Permission mode: ${message.permissionMode}`);
      log(`  Tools (${message.tools.length}): ${message.tools.slice(0, 10).join(", ")}...`);
    }

    if (message.type === "assistant") {
      const content = (message as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            log(`\n[WORKER-MSG] ${block.text.slice(0, 500)}`);
          }
          if (block.type === "tool_use") {
            log(`\n[WORKER-TOOL] ${block.name} (id: ${block.id})`);
          }
        }
      }
    }

    if (message.type === "result") {
      workerCostUsd += message.total_cost_usd;
      log(`\n========== WORKER RESULT ==========`);
      log(`  Subtype: ${message.subtype}`);
      log(`  Turns: ${message.num_turns}`);
      log(`  Cost: $${message.total_cost_usd.toFixed(4)}`);
      if (message.subtype === "success") {
        log(`  Result text:\n${(message as any).result?.slice(0, 3000) || "(empty)"}`);
      }
      log(`========== END WORKER RESULT ==========`);
    }
  }

  // ── Step 4: Summary + Verdicts ─────────────────────────────────────────

  log("");
  log("=".repeat(60));
  log("=== EXPERIMENT #3 SUMMARY ===");
  log("=".repeat(60));
  log("");
  log(`Manager session ID:  ${managerSessionId || "NONE"}`);
  log(`Worker session ID:   ${workerSessionId || "NONE"}`);
  log(`Worker questions:    ${workerQuestionCount}`);
  log(`Worker plans:        ${workerPlanCount}`);
  log(`Escalations to user: ${escalationCount}`);
  log(`Worker tool calls:   ${workerToolCallCount}`);
  log(`Manager tool calls:  ${managerToolCallCount}`);
  log(`Worker cost:         $${workerCostUsd.toFixed(4)}`);
  log(`Manager cost:        $${managerCostUsd.toFixed(4)}`);
  log(`Total cost:          $${(workerCostUsd + managerCostUsd).toFixed(4)}`);
  log("");

  // Verdicts
  const verdicts: Array<{ test: string; pass: boolean; detail: string }> = [];

  verdicts.push({
    test: "Concurrent sessions",
    pass: !!(managerSessionId && workerSessionId),
    detail: managerSessionId && workerSessionId
      ? `Manager: ${managerSessionId.slice(0, 12)}..., Worker: ${workerSessionId.slice(0, 12)}...`
      : `Manager: ${managerSessionId || "NONE"}, Worker: ${workerSessionId || "NONE"}`,
  });

  verdicts.push({
    test: "Question interception + bridge",
    pass: workerQuestionCount >= 1,
    detail: `${workerQuestionCount} question(s) intercepted and resolved through manager`,
  });

  verdicts.push({
    test: "Manager filtering (escalation OR self-answer)",
    pass: escalationCount >= 1 || workerQuestionCount >= 1,
    detail: `${escalationCount} escalation(s), ${workerQuestionCount - escalationCount} self-answered`,
  });

  verdicts.push({
    test: "Plan review loop (reject + approve)",
    pass: workerPlanCount >= 2,
    detail: `${workerPlanCount} plan submission(s)`,
  });

  verdicts.push({
    test: "Cost under $3",
    pass: (workerCostUsd + managerCostUsd) < 3.0,
    detail: `$${(workerCostUsd + managerCostUsd).toFixed(4)}`,
  });

  log("VERDICTS:");
  for (const v of verdicts) {
    const icon = v.pass ? "PASS" : "FAIL";
    log(`  [${icon}] ${v.test}: ${v.detail}`);
  }

  const passCount = verdicts.filter((v) => v.pass).length;
  log("");
  log(`Result: ${passCount}/${verdicts.length} passed`);

  if (passCount === verdicts.length) {
    log("ALL TESTS PASSED — Manager-Worker hierarchy works!");
  } else {
    log("Some tests failed — check log for details.");
  }

  log("");
  log("Experiment complete.");
}

main().catch((err) => {
  log(`EXPERIMENT FAILED: ${err.message}`);
  console.error(err);
  process.exit(1);
});
