/**
 * Experiment: Observe SDK plan mode behavior (automated)
 *
 * Runs a single query() in plan mode against finflow project.
 * Logs every canUseTool call and message.
 * Auto-answers questions, rejects first plan with feedback, approves second.
 *
 * Usage: npx tsx experiments/plan-mode-test.ts
 */

import { query, type CanUseTool } from "@anthropic-ai/claude-code";
import { appendFileSync, writeFileSync } from "node:fs";

const PROJECT_DIR = "/Users/germangurov/projects/finflow";
const CLAUDE_BIN = "/Users/germangurov/.local/bin/claude";
const LOG_FILE = "/Users/germangurov/projects/conciergon/experiments/plan-mode-test.log";

const PROMPT =
  "Understand the difference between native and web approaches in this project " +
  "and suggest a plan for full separation";

// Auto-responses for questions
const AUTO_ANSWER =
  "The project has a Python backend with FastAPI and a web frontend in the /web folder. " +
  "Native refers to the Python CLI/desktop tooling, web refers to the React frontend. " +
  "I want them fully separated into independent deployable units.";

// Feedback for first plan rejection
const PLAN_FEEDBACK =
  "The plan is missing details about how shared data models will be handled. " +
  "Also add a section about API contract between native and web. Revise.";

let toolCallCount = 0;
let exitPlanModeCount = 0;
let askQuestionCount = 0;

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
  toolCallCount++;
  const inputSummary = JSON.stringify(input).slice(0, 300);
  log(`[canUseTool #${toolCallCount}] ${toolName} | ${inputSummary}`);

  // --- AskUserQuestion: auto-answer ---
  if (toolName === "AskUserQuestion") {
    askQuestionCount++;
    const questions = (input as any).questions;
    if (Array.isArray(questions)) {
      for (const q of questions) {
        log(`  QUESTION: ${q.question}`);
        if (q.options) {
          for (let i = 0; i < q.options.length; i++) {
            log(`    ${i + 1}. ${q.options[i].label} — ${q.options[i].description || ""}`);
          }
        }
      }
    } else {
      log(`  QUESTION (raw): ${JSON.stringify(input)}`);
    }

    log(`  AUTO-ANSWER: ${AUTO_ANSWER.slice(0, 200)}`);
    return { behavior: "deny" as const, message: AUTO_ANSWER };
  }

  // --- ExitPlanMode: reject first, approve second ---
  if (toolName === "ExitPlanMode") {
    exitPlanModeCount++;
    const plan = (input as any).plan || JSON.stringify(input);

    log(`\n========== PLAN #${exitPlanModeCount} ==========`);
    log(plan);
    log(`========== END PLAN #${exitPlanModeCount} ==========\n`);

    if (exitPlanModeCount === 1) {
      log(`  -> REJECTING plan #1 with feedback: "${PLAN_FEEDBACK}"`);
      return { behavior: "deny" as const, message: PLAN_FEEDBACK };
    } else {
      log(`  -> APPROVING plan #${exitPlanModeCount}`);
      return { behavior: "allow" as const, updatedInput: input };
    }
  }

  // --- Everything else: log and allow ---
  return { behavior: "allow" as const, updatedInput: input };
};

async function main() {
  writeFileSync(LOG_FILE, ""); // Clear log file
  log("=== Plan Mode Experiment (Automated) ===");
  log(`Project: ${PROJECT_DIR}`);
  log(`Prompt: ${PROMPT}`);
  log(`Mode: plan`);
  log(`Auto-answer: ${AUTO_ANSWER.slice(0, 100)}...`);
  log(`Plan feedback: ${PLAN_FEEDBACK.slice(0, 100)}...`);
  log("");

  // Build clean env like the worker does
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "ANTHROPIC_AUTH_TOKEN" || k === "ANTHROPIC_API_KEY" || k === "CLAUDECODE") continue;
    if (v !== undefined) env[k] = v;
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
  }

  log(`Auth token set: ${!!env.CLAUDE_CODE_OAUTH_TOKEN}`);

  const conversation = query({
    prompt: PROMPT,
    options: {
      cwd: PROJECT_DIR,
      permissionMode: "plan",
      canUseTool,
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      env,
      maxTurns: 40,
      hooks: {
        PreToolUse: [{
          hooks: [async (input) => {
            log(`  [PreToolUse] ${input.tool_name}`);
            return {};
          }],
        }],
        PostToolUse: [{
          hooks: [async (input) => {
            log(`  [PostToolUse] ${input.tool_name}`);
            return {};
          }],
        }],
        Notification: [{
          hooks: [async (input) => {
            log(`  [Notification] ${input.message}`);
            return {};
          }],
        }],
      },
    },
  });

  for await (const message of conversation) {
    // --- System init ---
    if (message.type === "system" && message.subtype === "init") {
      log(`\n[INIT] Session: ${message.session_id}`);
      log(`  Permission mode: ${message.permissionMode}`);
      log(`  Tools (${message.tools.length}): ${message.tools.join(", ")}`);
      log(`  MCP servers: ${message.mcp_servers.map((s) => `${s.name}(${s.status})`).join(", ") || "(none)"}`);
    }

    // --- Assistant messages ---
    if (message.type === "assistant") {
      const content = (message as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            log(`\n[ASSISTANT] ${block.text.slice(0, 500)}`);
          }
          if (block.type === "tool_use") {
            log(`\n[TOOL_USE] ${block.name} (id: ${block.id})`);
          }
        }
      }
    }

    // --- Result ---
    if (message.type === "result") {
      log(`\n========== RESULT ==========`);
      log(`  Subtype: ${message.subtype}`);
      log(`  Turns: ${message.num_turns}`);
      log(`  Cost: $${message.total_cost_usd.toFixed(4)}`);
      if (message.subtype === "success") {
        log(`  Result text:\n${(message as any).result?.slice(0, 3000) || "(empty)"}`);
      }
      if ((message as any).permission_denials?.length > 0) {
        log(`  Permission denials: ${JSON.stringify((message as any).permission_denials)}`);
      }
      log(`========== END RESULT ==========`);
    }

    // --- Compact boundary ---
    if (message.type === "system" && (message as any).subtype === "compact_boundary") {
      log(`\n[COMPACT] Context compacted (trigger: ${(message as any).compact_metadata?.trigger})`);
    }
  }

  log(`\n=== SUMMARY ===`);
  log(`Total canUseTool calls: ${toolCallCount}`);
  log(`AskUserQuestion calls: ${askQuestionCount}`);
  log(`ExitPlanMode calls: ${exitPlanModeCount}`);
  log("Experiment complete.");
}

main().catch((err) => {
  log(`EXPERIMENT FAILED: ${err.message}`);
  console.error(err);
  process.exit(1);
});
