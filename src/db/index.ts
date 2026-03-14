import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "../config/index.js";
import * as schema from "./schema.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("db");

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database.Database | null = null;

export function initDb() {
  const config = getConfig();
  mkdirSync(dirname(config.DB_PATH), { recursive: true });

  _sqlite = new Database(config.DB_PATH);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");

  _db = drizzle(_sqlite, { schema });

  // Create tables
  createTables(_sqlite);

  log.info("Database initialized at %s", config.DB_PATH);
  return _db;
}

function createTables(sqlite: Database.Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      session_id TEXT,
      haiku_session_id TEXT,
      state TEXT NOT NULL DEFAULT 'starting',
      current_prompt TEXT NOT NULL,
      telegram_chat_id INTEGER NOT NULL,
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      project TEXT,
      prompt TEXT NOT NULL,
      worker_id INTEGER REFERENCES workers(id),
      question_id INTEGER,
      telegram_message_id INTEGER NOT NULL,
      telegram_chat_id INTEGER NOT NULL,
      reply_to_message_id INTEGER,
      processed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id INTEGER REFERENCES workers(id),
      type TEXT NOT NULL,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS svarog_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS pending_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id INTEGER NOT NULL REFERENCES workers(id),
      question TEXT NOT NULL,
      tool_use_id TEXT NOT NULL,
      telegram_message_id INTEGER,
      answered INTEGER NOT NULL DEFAULT 0,
      answer TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      prompt TEXT NOT NULL,
      user_summary TEXT NOT NULL,
      emoji TEXT,
      telegram_chat_id INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      run_once INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      error_count INTEGER NOT NULL DEFAULT 0,
      max_errors INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ];

  for (const stmt of statements) {
    sqlite.prepare(stmt).run();
  }

  // Migrations for existing DBs
  try {
    sqlite.prepare("ALTER TABLE intents ADD COLUMN user_summary TEXT").run();
  } catch {
    // Column already exists — ignore
  }

  try {
    sqlite.prepare("ALTER TABLE workers ADD COLUMN emoji TEXT").run();
  } catch {
    // Column already exists — ignore
  }

  try {
    sqlite.prepare("ALTER TABLE workers ADD COLUMN haiku_session_id TEXT").run();
  } catch {
    // Column already exists — ignore
  }

  try {
    sqlite.prepare("ALTER TABLE workers ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'plan'").run();
  } catch {
    // Column already exists — ignore
  }

  // Migrate old worker states to new 4-state enum
  // idle → active, waiting_approval → waiting_input, paused → active, completed → errored
  // "stopped" kept as-is (DB-only audit value)
  sqlite.prepare("UPDATE workers SET state = 'active' WHERE state IN ('idle', 'paused')").run();
  sqlite.prepare("UPDATE workers SET state = 'waiting_input' WHERE state = 'waiting_approval'").run();
  sqlite.prepare("UPDATE workers SET state = 'stopped' WHERE state = 'completed'").run();
}

export function getDb() {
  if (!_db) throw new Error("DB not initialized. Call initDb() first.");
  return _db;
}

export function closeDb() {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
}

export { schema };
