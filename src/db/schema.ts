import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  path: text("path").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const intents = sqliteTable("intents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(), // IntentType
  project: text("project"), // project name or null
  prompt: text("prompt").notNull(),
  userSummary: text("user_summary"),
  workerId: integer("worker_id").references(() => workers.id),
  questionId: integer("question_id").references(() => pendingQuestions.id),
  telegramMessageId: integer("telegram_message_id").notNull(),
  telegramChatId: integer("telegram_chat_id").notNull(),
  replyToMessageId: integer("reply_to_message_id"),
  processed: integer("processed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const workers = sqliteTable("workers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  sessionId: text("session_id"),
  haikuSessionId: text("haiku_session_id"),
  state: text("state").notNull().default("starting"), // WorkerState enum: starting | active | waiting_input | errored (+ "stopped" DB-only)
  currentPrompt: text("current_prompt").notNull(),
  emoji: text("emoji"),
  permissionMode: text("permission_mode").notNull().default("plan"), // 'plan' | 'default'
  telegramChatId: integer("telegram_chat_id").notNull(),
  lastActivityAt: text("last_activity_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workerId: integer("worker_id").references(() => workers.id),
  type: text("type").notNull(), // tool_use, status_change, error, notification, etc.
  data: text("data", { mode: "json" }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const svarogSessions = sqliteTable("svarog_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  state: text("state").notNull().default("active"), // active | stopped
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const scheduledTasks = sqliteTable("scheduled_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  cronExpression: text("cron_expression").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  prompt: text("prompt").notNull(),
  userSummary: text("user_summary").notNull(),
  emoji: text("emoji"),
  telegramChatId: integer("telegram_chat_id").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  runOnce: integer("run_once", { mode: "boolean" }).notNull().default(false),
  lastRunAt: text("last_run_at"),
  errorCount: integer("error_count").notNull().default(0),
  maxErrors: integer("max_errors").notNull().default(3),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const pendingQuestions = sqliteTable("pending_questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workerId: integer("worker_id")
    .notNull()
    .references(() => workers.id),
  question: text("question").notNull(),
  toolUseId: text("tool_use_id").notNull(),
  telegramMessageId: integer("telegram_message_id"),
  answered: integer("answered", { mode: "boolean" }).notNull().default(false),
  answer: text("answer"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});
