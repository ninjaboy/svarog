import { eq, and, sql, desc } from "drizzle-orm";
import { getDb, schema } from "./index.js";
import type { ClassifiedIntent } from "../types/index.js";
import { WorkerState } from "../types/index.js";

// --- Projects ---

export function upsertProject(name: string, path: string) {
  const db = getDb();
  return db
    .insert(schema.projects)
    .values({ name, path })
    .onConflictDoUpdate({ target: schema.projects.path, set: { name } })
    .returning()
    .get();
}

export function getAllProjects() {
  return getDb().select().from(schema.projects).all();
}

export function getProjectByName(name: string) {
  return getDb()
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, name))
    .get();
}

// --- Intents ---

export function insertIntent(intent: ClassifiedIntent) {
  return getDb()
    .insert(schema.intents)
    .values({
      type: intent.type,
      project: intent.project,
      prompt: intent.prompt,
      userSummary: intent.userSummary,
      workerId: intent.workerId,
      questionId: intent.questionId,
      telegramMessageId: intent.telegramMessageId,
      telegramChatId: intent.telegramChatId,
      replyToMessageId: intent.replyToMessageId,
    })
    .returning()
    .get();
}

export function getUnprocessedIntents() {
  return getDb()
    .select()
    .from(schema.intents)
    .where(eq(schema.intents.processed, false))
    .orderBy(schema.intents.id)
    .all();
}

export function markIntentProcessed(id: number) {
  return getDb()
    .update(schema.intents)
    .set({ processed: true })
    .where(eq(schema.intents.id, id))
    .run();
}

// --- Workers ---

export function insertWorker(
  projectId: number,
  prompt: string,
  telegramChatId: number,
  emoji?: string | null
) {
  return getDb()
    .insert(schema.workers)
    .values({ projectId, currentPrompt: prompt, telegramChatId, ...(emoji ? { emoji } : {}) })
    .returning()
    .get();
}

export function updateWorkerState(id: number, state: WorkerState) {
  return getDb()
    .update(schema.workers)
    .set({ state, lastActivityAt: sql`datetime('now')` })
    .where(eq(schema.workers.id, id))
    .run();
}

export function updateWorkerSessionId(id: number, sessionId: string) {
  return getDb()
    .update(schema.workers)
    .set({ sessionId })
    .where(eq(schema.workers.id, id))
    .run();
}

export function updateManagerSessionId(id: number, managerSessionId: string) {
  return getDb()
    .update(schema.workers)
    .set({ managerSessionId })
    .where(eq(schema.workers.id, id))
    .run();
}

export function touchWorkerActivity(id: number) {
  return getDb()
    .update(schema.workers)
    .set({ lastActivityAt: sql`datetime('now')` })
    .where(eq(schema.workers.id, id))
    .run();
}

export function getActiveWorkers() {
  return getDb()
    .select()
    .from(schema.workers)
    .where(
      sql`${schema.workers.state} IN ('starting', 'active', 'waiting_input')`
    )
    .all();
}

export function getWorkerById(id: number) {
  return getDb()
    .select()
    .from(schema.workers)
    .where(eq(schema.workers.id, id))
    .get();
}

export function getWorkerWithProject(id: number) {
  return getDb()
    .select({
      worker: schema.workers,
      project: schema.projects,
    })
    .from(schema.workers)
    .innerJoin(schema.projects, eq(schema.workers.projectId, schema.projects.id))
    .where(eq(schema.workers.id, id))
    .get();
}

export function getIdleWorkers(timeoutSeconds: number) {
  return getDb()
    .select()
    .from(schema.workers)
    .where(
      and(
        eq(schema.workers.state, "active"),
        sql`datetime(${schema.workers.lastActivityAt}, '+' || ${timeoutSeconds} || ' seconds') < datetime('now')`
      )
    )
    .all();
}

/** Mark a worker as "stopped" in DB (audit-only value, not in WorkerState enum). */
export function markWorkerStopped(id: number) {
  return getDb()
    .update(schema.workers)
    .set({ state: "stopped", lastActivityAt: sql`datetime('now')` })
    .where(eq(schema.workers.id, id))
    .run();
}

/** Get resumable workers: active states within age threshold, ordered by most recently active. */
export function getResumableWorkers(maxAgeSec: number) {
  return getDb()
    .select()
    .from(schema.workers)
    .where(
      and(
        sql`${schema.workers.state} IN ('active', 'waiting_input')`,
        sql`datetime(${schema.workers.lastActivityAt}, '+' || ${maxAgeSec} || ' seconds') >= datetime('now')`
      )
    )
    .orderBy(desc(schema.workers.lastActivityAt))
    .all();
}

/** Check if a worker has any completion event (result or result_delivered). */
export function hasCompletionEvent(workerId: number): boolean {
  const row = getDb()
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.workerId, workerId),
        sql`${schema.events.type} IN ('result_delivered', 'result')`
      )
    )
    .limit(1)
    .get();
  return !!row;
}

// --- Events ---

export function insertEvent(
  workerId: number | null,
  type: string,
  data?: unknown
) {
  return getDb()
    .insert(schema.events)
    .values({
      workerId,
      type,
      data: data ? JSON.stringify(data) : null,
    })
    .run();
}

// --- Pending Questions ---

export function insertPendingQuestion(
  workerId: number,
  question: string,
  toolUseId: string
) {
  return getDb()
    .insert(schema.pendingQuestions)
    .values({ workerId, question, toolUseId })
    .returning()
    .get();
}

export function updateQuestionTelegramMessageId(
  id: number,
  telegramMessageId: number
) {
  return getDb()
    .update(schema.pendingQuestions)
    .set({ telegramMessageId })
    .where(eq(schema.pendingQuestions.id, id))
    .run();
}

export function answerQuestion(id: number, answer: string) {
  return getDb()
    .update(schema.pendingQuestions)
    .set({ answered: true, answer })
    .where(eq(schema.pendingQuestions.id, id))
    .run();
}

export function getUnansweredQuestions() {
  return getDb()
    .select()
    .from(schema.pendingQuestions)
    .where(eq(schema.pendingQuestions.answered, false))
    .all();
}

export function getQuestionByTelegramMessageId(telegramMessageId: number) {
  return getDb()
    .select()
    .from(schema.pendingQuestions)
    .where(
      eq(schema.pendingQuestions.telegramMessageId, telegramMessageId)
    )
    .get();
}

export function getQuestionById(id: number) {
  return getDb()
    .select()
    .from(schema.pendingQuestions)
    .where(eq(schema.pendingQuestions.id, id))
    .get();
}

// --- Concierg Sessions ---

export function getActiveConciergSessionId(): string | null {
  const row = getDb()
    .select()
    .from(schema.conciergSessions)
    .where(eq(schema.conciergSessions.state, "active"))
    .orderBy(desc(schema.conciergSessions.id))
    .limit(1)
    .get();
  return row?.sessionId ?? null;
}

export function saveConciergSessionId(sessionId: string) {
  const db = getDb();
  // Mark all existing active sessions as stopped
  db.update(schema.conciergSessions)
    .set({ state: "stopped", updatedAt: sql`datetime('now')` })
    .where(eq(schema.conciergSessions.state, "active"))
    .run();
  // Insert new active session
  return db
    .insert(schema.conciergSessions)
    .values({ sessionId })
    .returning()
    .get();
}

export function stopConciergSessions() {
  return getDb()
    .update(schema.conciergSessions)
    .set({ state: "stopped", updatedAt: sql`datetime('now')` })
    .where(eq(schema.conciergSessions.state, "active"))
    .run();
}

// --- Context for Concierg ---

export function getConciergContext() {
  const projectList = getAllProjects();
  const activeWorkerList = getActiveWorkers();
  const pendingQs = getUnansweredQuestions();
  return { projects: projectList, activeWorkers: activeWorkerList, pendingQuestions: pendingQs };
}
