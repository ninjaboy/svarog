/**
 * Experiment #2: Force AskUserQuestion in plan mode
 *
 * Tests whether canUseTool fires for AskUserQuestion in plan mode.
 * Uses an empty project + vague prompt + appendSystemPrompt to force
 * the model to ask clarifying questions before planning.
 *
 * What we verify:
 * 1. Does canUseTool fire for AskUserQuestion? (the critical unknown)
 * 2. What's in the input parameter? (question text, options structure)
 * 3. Does the deny+message response reach the model as the "user's answer"?
 * 4. Does the model then proceed to ExitPlanMode after getting answers?
 *
 * Usage:
 *   cd /Users/germangurov/projects/conciergon
 *   node --env-file=.env --import tsx experiments/02-questions-test/run.ts
 */

import { query, type CanUseTool } from "@anthropic-ai/claude-code";
import { appendFileSync, writeFileSync } from "node:fs";

const PROJECT_DIR = "/Users/germangurov/projects/test_game";
const CLAUDE_BIN = "/Users/germangurov/.local/bin/claude";
const LOG_FILE = "/Users/germangurov/projects/conciergon/experiments/02-questions-test/run.log";

// Intentionally vague prompt — empty project forces questions
const PROMPT = "I want to build a new game. Suggest a plan.";

// System prompt that strongly encourages asking questions first
const SYSTEM_PROMPT_APPEND =
  "You MUST use AskUserQuestion to ask the user clarifying questions before creating your plan. " +
  "The project is empty — you need to understand what the user wants before you can plan anything. " +
  "Ask at least 2 questions. Do NOT skip this step. Do NOT assume anything about the game type, " +
  "platform, tech stack, or gameplay mechanics. Ask the user first.";

// Auto-answer for questions — gives enough info to plan
const QUESTION_ANSWER =
  "I want a simple 2D platformer game using TypeScript and the Phaser framework. " +
  "Target platform is web browser. Single player, with basic physics, " +
  "3-5 levels, and a simple scoring system. No backend needed — pure client-side.";

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
  const inputSummary = JSON.stringify(input).slice(0, 500);
  log(`[canUseTool #${toolCallCount}] ${toolName} | ${inputSummary}`);

  // --- AskUserQuestion: log everything, then auto-answer via deny+message ---
  if (toolName === "AskUserQuestion") {
    askQuestionCount++;
    log(`\n========== ASK USER QUESTION #${askQuestionCount} ==========`);
    log(`  Full input: ${JSON.stringify(input, null, 2)}`);

    const questions = (input as any).questions;
    if (Array.isArray(questions)) {
      for (let qi = 0; qi < questions.length; qi++) {
        const q = questions[qi];
        log(`  Q${qi + 1}: ${q.question}`);
        log(`    header: ${q.header || "(none)"}`);
        log(`    multiSelect: ${q.multiSelect ?? "(not set)"}`);
        if (Array.isArray(q.options)) {
          for (let oi = 0; oi < q.options.length; oi++) {
            log(`    option ${oi + 1}: "${q.options[oi].label}" — ${q.options[oi].description || "(no desc)"}`);
          }
        }
      }
    } else {
      log(`  (questions field is not an array — raw input logged above)`);
    }

    log(`  AUTO-ANSWER via deny+message: "${QUESTION_ANSWER.slice(0, 200)}..."`);
    log(`========== END ASK USER QUESTION #${askQuestionCount} ==========\n`);
    return { behavior: "deny" as const, message: QUESTION_ANSWER };
  }

  // --- ExitPlanMode: approve on first attempt (no rejection loop for this experiment) ---
  if (toolName === "ExitPlanMode") {
    exitPlanModeCount++;
    const planText = JSON.stringify(input, null, 2);

    log(`\n========== PLAN #${exitPlanModeCount} ==========`);
    log(planText);
    log(`========== END PLAN #${exitPlanModeCount} ==========\n`);

    log(`  -> APPROVING plan #${exitPlanModeCount}`);
    return { behavior: "allow" as const, updatedInput: input };
  }

  // --- Everything else: log and allow ---
  return { behavior: "allow" as const, updatedInput: input };
};

async function main() {
  writeFileSync(LOG_FILE, ""); // Clear log file
  log("=== Experiment #2: Force AskUserQuestion in Plan Mode ===");
  log(`Project: ${PROJECT_DIR}`);
  log(`Prompt: ${PROMPT}`);
  log(`appendSystemPrompt: ${SYSTEM_PROMPT_APPEND}`);
  log(`Mode: plan`);
  log(`Auto-answer: ${QUESTION_ANSWER.slice(0, 100)}...`);
  log("");

  // Build clean env (same pattern as experiment #1 / worker sessions)
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
      appendSystemPrompt: SYSTEM_PROMPT_APPEND,
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
  log("");

  // Verdict
  if (askQuestionCount > 0) {
    log(`VERDICT: canUseTool DOES fire for AskUserQuestion in plan mode.`);
    log(`  -> We can intercept questions, extract them, and inject answers via deny+message.`);
  } else {
    log(`VERDICT: canUseTool did NOT fire for AskUserQuestion.`);
    log(`  -> Either the model didn't ask questions (check assistant messages for inline questions),`);
    log(`     or AskUserQuestion is auto-allowed like read-only tools.`);
    log(`  -> Check the log for [ASSISTANT] messages that might contain questions as text.`);
  }

  log("Experiment complete.");
}

main().catch((err) => {
  log(`EXPERIMENT FAILED: ${err.message}`);
  console.error(err);
  process.exit(1);
});
