import { existsSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface EnvValues {
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ALLOWED_USERS: string;
  PROJECTS_DIR?: string;
  DB_PATH?: string;
  HEALTH_PORT?: number;
  LOG_LEVEL?: string;
  USER_TIMEZONE?: string;
}

/**
 * Write a .env file from collected configuration values.
 * Backs up existing .env to .env.backup if present.
 */
export function writeEnvFile(values: EnvValues, envPath = ".env"): void {
  const resolved = resolve(envPath);

  // Backup existing .env
  if (existsSync(resolved)) {
    const backupPath = resolved + ".backup";
    renameSync(resolved, backupPath);
  }

  const lines: string[] = [];

  // Authentication
  if (values.ANTHROPIC_AUTH_TOKEN) {
    lines.push("# Authentication (OAuth token)");
    lines.push(`ANTHROPIC_AUTH_TOKEN=${values.ANTHROPIC_AUTH_TOKEN}`);
  } else if (values.ANTHROPIC_API_KEY) {
    lines.push("# Authentication (API key)");
    lines.push(`ANTHROPIC_API_KEY=${values.ANTHROPIC_API_KEY}`);
  }
  lines.push("");

  // Telegram
  lines.push("# Telegram Bot token");
  lines.push(`TELEGRAM_BOT_TOKEN=${values.TELEGRAM_BOT_TOKEN}`);
  lines.push("");
  lines.push("# Allowed Telegram user IDs (comma-separated)");
  lines.push(`TELEGRAM_ALLOWED_USERS=${values.TELEGRAM_ALLOWED_USERS}`);
  lines.push("");

  // Projects
  if (values.PROJECTS_DIR && values.PROJECTS_DIR !== "~/projects") {
    lines.push("# Projects directory");
    lines.push(`PROJECTS_DIR=${values.PROJECTS_DIR}`);
    lines.push("");
  }

  // Database
  if (values.DB_PATH && values.DB_PATH !== "./data/conciergon.db") {
    lines.push("# Database path");
    lines.push(`DB_PATH=${values.DB_PATH}`);
    lines.push("");
  }

  // Optional settings
  if (values.HEALTH_PORT && values.HEALTH_PORT !== 3847) {
    lines.push(`HEALTH_PORT=${values.HEALTH_PORT}`);
  }
  if (values.LOG_LEVEL && values.LOG_LEVEL !== "info") {
    lines.push(`LOG_LEVEL=${values.LOG_LEVEL}`);
  }
  if (values.USER_TIMEZONE && values.USER_TIMEZONE !== "UTC") {
    lines.push(`USER_TIMEZONE=${values.USER_TIMEZONE}`);
  }
  // Write atomically: tmp then rename
  const tmpPath = resolved + ".tmp";
  writeFileSync(tmpPath, lines.join("\n") + "\n", { mode: 0o600 });
  renameSync(tmpPath, resolved);
}
