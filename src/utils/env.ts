/**
 * Build a clean env for Claude Code SDK subprocesses.
 * Strips conflicting auth vars and CLAUDECODE (nested session guard).
 * Sets CLAUDE_CODE_OAUTH_TOKEN as the sole auth mechanism.
 */
export function buildCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "ANTHROPIC_AUTH_TOKEN") continue;
    if (k === "ANTHROPIC_API_KEY") continue;
    if (k === "CLAUDECODE") continue;
    if (v !== undefined) env[k] = v;
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}
