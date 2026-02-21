# Experiment #2 Learnings: AskUserQuestion in Plan Mode

## Date: 2026-02-16
## Cost: $3.18 (40 turns, hit max_turns limit)

## What We Tested

Can `canUseTool` intercept `AskUserQuestion` in plan mode, and does `deny+message` work to inject answers?

## Key Findings

### 1. canUseTool FIRES for AskUserQuestion in plan mode
- **Confirmed.** The model called `AskUserQuestion` and our `canUseTool` hook intercepted it.
- This was the critical unknown -- plan mode auto-allows read-only tools (Read, Glob, Grep) but still routes `AskUserQuestion` through `canUseTool`.

### 2. AskUserQuestion input structure
The `input` parameter contains a well-structured object:
```typescript
{
  questions: [
    {
      question: string,      // The question text
      header: string,        // Short label (e.g., "Game type")
      multiSelect: boolean,  // Whether multiple answers allowed
      options: [
        { label: string, description: string }
      ]
    }
  ]
}
```
- The model sent 3 questions in a single `AskUserQuestion` call (batched).
- Each question had 3-4 options with labels and descriptions.
- `multiSelect` was `false` for all questions.

### 3. deny+message successfully injects answers
- Returning `{ behavior: "deny", message: "..." }` from `canUseTool` makes the model receive the message as if the user answered.
- The model immediately acknowledged the answer: "Great, that's clear! A 2D platformer using TypeScript + Phaser..."
- It then proceeded to plan and call `ExitPlanMode` without issues.

### 4. ExitPlanMode also intercepted by canUseTool
- `canUseTool` fires for `ExitPlanMode` in plan mode.
- The `input` contains `{ plan: string }` with the full plan text.
- Returning `{ behavior: "allow", updatedInput: input }` lets the plan through.
- Returning `{ behavior: "deny", message: "feedback..." }` rejects the plan (tested in experiment #1).

### 5. Permission denials are tracked in result
- The `result` message includes a `permission_denials` array listing each denied tool call.
- This can be used for auditing: which questions were intercepted and what was the original input.

### 6. Model behavior after answer injection
- After receiving the injected answer, the model explored the codebase thoroughly (Task subagents, Bash, Read).
- It researched Phaser patterns via WebSearch and WebFetch.
- Wrote a comprehensive plan file before calling ExitPlanMode.
- After approval, it implemented the full game (hit maxTurns=40 building code + testing with Playwright).

## Implications for Conciergon Architecture

1. **Worker sessions can ask questions via AskUserQuestion** -- our `canUseTool` interceptor reliably fires.
2. **The question format is rich and parseable** -- we get structured questions with options, not just raw text.
3. **deny+message is the correct pattern for injecting answers** -- the model treats it as a user response.
4. **A single AskUserQuestion call can contain multiple questions** -- we need to handle batches (the Telegram UI should present all questions, not just the first).
5. **ExitPlanMode interception works** -- we can implement plan review/approval loops.

## What We Didn't Test
- Multiple rounds of questions (model only asked once)
- Plan rejection loop (approved on first attempt)
- Concurrent sessions (single session only)
- Promise-based async bridging (direct return, no async)

These gaps are addressed in Experiment #3.
