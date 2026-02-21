import { z } from "zod";
import { resolve } from "node:path";
import { homedir } from "node:os";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USERS: z
    .string()
    .transform((s) => s.split(",").map((id) => Number(id.trim()))),
  PROJECTS_DIR: z
    .string()
    .default("~/projects")
    .transform((p) => p.replace(/^~/, homedir())),
  DB_PATH: z
    .string()
    .default("./data/conciergon.db")
    .transform((p) => resolve(p)),
  WATCHDOG_INTERVAL_MS: z.coerce.number().default(1500),
  WORKER_IDLE_TIMEOUT_S: z.coerce.number().default(300),
  WORKER_SESSION_TIMEOUT_S: z.coerce.number().default(7200),
  WORKER_RESUME_MAX_AGE_S: z.coerce.number().default(3600),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  SENTRY_DSN: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;
  _config = envSchema.parse(process.env);
  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error("Config not loaded. Call loadConfig() first.");
  return _config;
}
