import { z } from "zod";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

function loadFromKeychain(service: string): string | undefined {
  try {
    return execSync(`security find-generic-password -s '${service}' -w`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
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
  USER_TIMEZONE: z.string().default("UTC"),
  HEALTH_PORT: z.coerce.number().default(3847),
});

export type Config = Omit<z.infer<typeof envSchema>, "TELEGRAM_BOT_TOKEN"> & {
  TELEGRAM_BOT_TOKEN: string;
};

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const parsed = envSchema.parse(process.env);

  // Load TELEGRAM_BOT_TOKEN from keychain if not in env
  if (!parsed.TELEGRAM_BOT_TOKEN) {
    parsed.TELEGRAM_BOT_TOKEN = loadFromKeychain("svarog-telegram-token");
  }
  if (!parsed.TELEGRAM_BOT_TOKEN) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN not found in env or keychain (svarog-telegram-token)",
    );
  }

  // Load ANTHROPIC_AUTH_TOKEN from Claude Code keychain if not in env
  if (!process.env.ANTHROPIC_AUTH_TOKEN) {
    const creds = loadFromKeychain("Claude Code-credentials");
    if (creds) {
      try {
        const parsed_creds = JSON.parse(creds);
        const token = parsed_creds?.claudeAiOauth?.accessToken;
        if (token) {
          process.env.ANTHROPIC_AUTH_TOKEN = token;
        }
      } catch {
        // ignore malformed keychain JSON
      }
    }
  }

  _config = parsed as Config;
  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error("Config not loaded. Call loadConfig() first.");
  return _config;
}
