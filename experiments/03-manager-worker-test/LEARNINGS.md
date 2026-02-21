# Experiment #3 Learnings: Manager-Worker Two-Level Hierarchy

## Date: 2026-02-16
## Cost: $4.12 total (Worker: $3.74, Manager: $0.38)
## Result: 4/5 verdicts passed (cost overrun due to worker executing after plan approval)

## What We Tested

Full two-level hierarchy: Manager session mediates between Worker session and simulated user.
- Concurrent `query()` sessions
- Promise-based bridging between worker's `canUseTool` and manager
- Manager filtering (auto-answer technical vs. escalate requirements)
- Plan review loop (reject first, approve second)

## Verdicts

| Test | Result | Detail |
|------|--------|--------|
| Concurrent sessions | PASS | Manager: `962730f4...`, Worker: `bd390a9b...` |
| Question interception + bridge | PASS | 1 question bridged through manager |
| Manager filtering | PASS | 1 escalation to user (requirements question) |
| Plan review loop (reject + approve) | PASS | 2 plan submissions |
| Cost under $3 | FAIL | $4.12 (worker continued into execution) |

## Communication Flow

The Manager and Worker are two separate `query()` processes that can't talk directly.
They're bridged through JavaScript Promises and MCP tools in our script:

```
Worker query()                    Our Script (run.ts)                 Manager query()
─────────────                    ─────────────────                   ──────────────

1. Worker wants to ask user
   → calls AskUserQuestion
   → canUseTool fires ──────→  2. Script creates a Promise
                                  stores resolver in
                                  pendingWorkerResolver

                                3. Script injects event ──────→  4. Manager receives:
                                   into manager queue               "Worker asked: What
                                                                     type of multiplayer?"

                               (Worker is BLOCKED                 5. Manager thinks:
                                waiting on Promise)                  "This is a requirements
                                                                     question, escalate"

                                                                  6. Manager calls ask_user
                                                                     MCP tool (→ simulated
                                                                     user answers)

                                                                  7. Manager calls
                                                                     answer_worker MCP tool
                                                                     with the answer
                                                                          │
                               8. answer_worker handler ←────────────────┘
                                  calls pendingWorkerResolver("Co-op, 2-4 players...")
                                  Promise resolves!
                                          │
9. canUseTool returns      ←──────────────┘
   { deny, message: answer }

10. Worker receives answer
    as if user replied,
    continues working
```

**Three pieces make it work:**

1. **Worker side** -- `canUseTool` is async, `await`s a Promise that keeps the worker paused.
2. **Manager side** -- `answer_worker` MCP tool handler calls the stored resolver, unblocking the worker.
3. **Shared variable** -- module-level `pendingWorkerResolver` connects both sides (same Node.js process).

**Plan review uses the same bridge** but with prefix detection on return:
- `REJECTED:` prefix → `{ deny, message: feedback }` → worker revises
- `APPROVED:` prefix → `{ allow }` → ExitPlanMode goes through

## Key Findings

### 1. Two concurrent query() sessions work
- Manager and Worker sessions ran simultaneously without conflicts.
- Each got its own session ID.
- Manager could be resumed while worker was actively running.
- No shared state issues with the SDK.

### 2. Promise bridging works for async mediation
The pattern:
```typescript
// In worker's canUseTool:
const answer = await new Promise<string>((resolve) => {
  pendingWorkerResolver = resolve;
  managerInjectEvent(questionText); // fire and forget
});
return { behavior: "deny", message: answer };

// In manager's MCP tool:
pendingWorkerResolver(answer); // unblocks worker
```
- Worker blocks in `canUseTool` while waiting for the Promise.
- Manager processes the event asynchronously.
- Manager calls `answer_worker` MCP tool which resolves the Promise.
- Worker unblocks and returns the answer via `deny+message`.

### 3. Session resume latency is the critical bottleneck
- **First resume after bootstrap: ~50-60 seconds.**
- Subsequent resumes: ~4-10 seconds (warm).
- This means the first bridge interaction needs generous timeouts.
- We started with 60s timeout -- too tight. Increased to 180s.
- In production, the manager should be kept warm (not cold-resumed for each interaction).

### 4. Manager correctly classified questions
- Worker asked requirements questions (multiplayer type, player count, networking approach).
- Manager recognized these as user decisions, not technical choices.
- Manager called `ask_user` to escalate, received the simulated user answer, then called `answer_worker` to relay.
- The manager added its own context: "The user didn't explicitly address the deaths question, so I'll make a reasonable default suggestion."

### 5. Structured prefixes are essential for plan review
**Problem discovered:** Free-text regex matching fails. The manager said "before I can approve it" in a rejection, and `/approve/i` matched the wrong word.

**Solution:** Require `APPROVED:` or `REJECTED:` prefix in `answer_worker` calls.
```typescript
const trimmed = answer.trimStart();
const isApproval = trimmed.startsWith("APPROVED:");
```
- The manager system prompt must explicitly instruct this format.
- The instruction "This prefix is machine-parsed" was effective -- the manager consistently used it.

### 6. Plan review loop worked end-to-end
- **Plan #1:** Manager correctly identified gaps (state sync, disconnect handling) and returned `REJECTED:` with specific feedback.
- Worker acknowledged: "Good feedback. Let me address these gaps."
- Worker revised the plan and resubmitted.
- **Plan #2:** Manager noted the plan was still truncated but approved anyway (as instructed): `APPROVED: The plan covers the key architecture well...`
- ExitPlanMode was allowed, worker transitioned to execution.

### 7. Manager is cheap; worker is expensive
- Manager total cost: $0.38 (4 tool calls, ~8 turns across all interactions)
- Worker total cost: $3.74 (18 tool calls, 41 turns including execution)
- The manager overhead is ~9% of total cost -- negligible.
- Worker exploration + plan writing was ~$1.5, execution was ~$2.2.

### 8. Event queue pattern works for sequential manager processing
- Manager uses busy flag + event queue (same as `src/manager-llm/session.ts`).
- Multiple events can queue while manager is processing; they're drained on next cycle.
- No events were dropped during the experiment.

## Iteration History (bugs found and fixed)

### Run 1: 60s timeout too short
- Manager resume took ~54s, leaving only 6s for thinking + tool calls.
- Both Q1 and Plan #1 timed out.
- **Fix:** Increased `PROMISE_TIMEOUT_MS` to 180s.

### Run 2: Auto-approve on timeout
- Plan #1 timeout triggered the error handler which returned `{ behavior: "allow" }`.
- Worker skipped the review loop entirely.
- **Fix:** Changed error handler to return `deny` with feedback, forcing retry.

### Run 3: Regex matched "approve" in rejection text
- Manager said "before I can approve it" while rejecting.
- Regex `/approve/i` matched, treating rejection as approval.
- **Fix:** Switched to structured `APPROVED:`/`REJECTED:` prefix detection.

### Run 4 (final): All tests passed (except cost)
- Clean run with all fixes applied.
- Full flow: Q1 bridged -> Plan #1 rejected -> Plan #2 approved -> Worker executed.

## Implications for Production

### Must-haves
1. **Generous timeouts** (180s+) for the first manager interaction after a cold start.
2. **Structured response formats** for machine-parsed decisions (prefixes, JSON).
3. **Manager warm-keeping** -- avoid cold resumes by keeping the session alive.
4. **Cost controls** -- `maxTurns` must be carefully set; worker hit 41 turns.

### Architecture validation
- The Manager-Worker hierarchy with Promise bridging is viable.
- MCP tools (`createSdkMcpServer` + `tool()`) work cleanly for manager actions.
- `canUseTool` is the correct hook for intercepting both questions and plan submissions.
- The event queue pattern handles concurrent events without dropping messages.

### Open questions for Experiment #4
1. Can the manager handle multiple workers simultaneously?
2. Does host migration work (manager session moves to new worker)?
3. What's the optimal `maxTurns` for plan-only vs. plan+execute modes?
4. Can we reduce first-resume latency with session pre-warming?
