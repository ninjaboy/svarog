# Claude Code SDK Learnings

Reference for future context when working with `@anthropic-ai/claude-code` SDK.

## Core API

`query({ prompt, options })` returns `Query` — an async iterator of `SDKMessage`.

```typescript
const conversation = query({ prompt: "...", options: { ... } });
for await (const message of conversation) { /* handle */ }
```

## Permission Modes

`permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'`

- `default` — normal, asks user for tool permissions
- `acceptEdits` — auto-accept file edits
- `bypassPermissions` — allow everything
- `plan` — plan mode: injects plan system prompt, makes `ExitPlanMode` tool available

## canUseTool Callback

**IMPORTANT: Does NOT fire for every tool.** Only fires when the SDK's internal permission
system can't resolve the tool on its own (i.e., when a tool "needs permission").

```typescript
canUseTool: async (toolName, input, { signal, suggestions }) => {
  // Allow:
  return { behavior: "allow", updatedInput: input };
  // Deny:
  return { behavior: "deny", message: "reason" };
  // Deny and interrupt (stop execution):
  return { behavior: "deny", message: "reason", interrupt: true };
}
```

## Query Control Methods

```typescript
conversation.interrupt()              // Stop execution
conversation.setPermissionMode(mode)  // Change mode MID-SESSION
conversation.setModel(model)          // Switch model
```

## Key Tools

- `ExitPlanMode({ plan: string })` — model submits plan for approval (plan mode only)
- `AskUserQuestion({ questions: [{ question, header, options, multiSelect }] })` — model asks user
- `Write`, `Edit`, `NotebookEdit` — file modification tools
- `Bash({ command, timeout?, run_in_background? })` — shell commands
- `Read`, `Glob`, `Grep` — read-only exploration

## Message Types

- `system` (subtype `init`) — session start. Has `session_id`, `permissionMode`, `tools[]`
- `assistant` — model output. `message.content` is array of `{ type: 'text', text }` and `{ type: 'tool_use', name, input }`
- `result` — final. Has `subtype` ('success' | 'error_max_turns' | 'error_during_execution'), `result` (text), `num_turns`, `total_cost_usd`
- `system` (subtype `compact_boundary`) — context window compacted

## Hooks

`PreToolUse`, `PostToolUse`, `Notification`, `PreCompact`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStop`, `UserPromptSubmit`

PreToolUse hook can approve/block tools:
```typescript
return {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow' | 'deny' | 'ask'
  }
};
```

## Permission Evaluation Order

1. PreToolUse hooks
2. Deny rules (allowedTools/disallowedTools)
3. Permission mode
4. canUseTool callback

## Session Management

- `resume: sessionId` — resume from session
- `forkSession: true` — fork to new session when resuming
- `continue: true` — continue from session state

## MCP Servers

In-process MCP server (no subprocess):
```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-code";
const server = createSdkMcpServer({
  name: "my_server",
  tools: [tool("name", "desc", zodSchema, handler)]
});
// Pass in options: mcpServers: { my_server: server }
```

## System Prompt

- `appendSystemPrompt: string` — adds to default (plan mode already has its own prompt)
- `customSystemPrompt: string` — replaces entire system prompt

## Experiment #1 Results (plan-mode-test on finflow)

**Setup:** `permissionMode: 'plan'`, prompt about native/web separation, auto-answer questions, reject plan #1 with feedback, approve plan #2.

### canUseTool behavior in plan mode

| # | Tool | Phase | canUseTool fired? |
|---|------|-------|-------------------|
| - | Read, Glob, Grep, Bash, Task | Planning | **NO** — auto-allowed by SDK |
| 1 | ExitPlanMode | Planning | **YES** — full plan text in `input.plan` |
| 2 | ExitPlanMode | Planning (revised) | **YES** — revised plan after rejection |
| 3 | Bash (mkdir) | Executing | **YES** |
| 4-6 | Write (new files) | Executing | **YES** |
| 7-8 | Edit (existing files) | Executing | **YES** |

### Key findings

1. **canUseTool fires for ExitPlanMode** — we can intercept the plan, reject with feedback
2. **Feedback loop works** — deny ExitPlanMode with message → model revises → resubmits (~35s)
3. **Read-only tools bypass canUseTool in plan mode** — Read, Glob, Grep, Bash, Task are auto-allowed
4. **After ExitPlanMode approval, model transitions to execution** — Write/Edit/Bash trigger canUseTool
5. **AskUserQuestion was NOT called** — model went straight to planning. UNKNOWN whether canUseTool fires for it in plan mode
6. **Init message confirmed ExitPlanMode in tools list** (102 tools total including MCP)

### What this means for Conciergon worker

- Remove the broken `writeTools` deny block from canUseTool
- Intercept `ExitPlanMode` in canUseTool → forward plan to ManagerLLM → wait for user approval
- After approval, allow execution (canUseTool fires for Write/Edit/Bash — can gate if needed)
- Still need experiment #2 to verify AskUserQuestion path
