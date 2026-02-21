import { execSync } from "node:child_process";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("token-refresh");

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // refresh if <1h left
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // check every 30min

interface KeychainCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
    rateLimitTier: string;
  };
  mcpOAuth?: Record<string, unknown>;
}

function readKeychain(): KeychainCredentials | null {
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    return JSON.parse(raw) as KeychainCredentials;
  } catch (err) {
    log.error({ err }, "Failed to read keychain");
    return null;
  }
}

function writeKeychain(data: KeychainCredentials): boolean {
  try {
    const json = JSON.stringify(data);
    // Delete old entry and add new one
    try {
      execSync('security delete-generic-password -s "Claude Code-credentials"', {
        timeout: 5000,
        stdio: "ignore",
      });
    } catch {
      // May not exist
    }
    execSync(
      `security add-generic-password -s "Claude Code-credentials" -a "Claude Code" -w '${json.replace(/'/g, "'\\''")}'`,
      { timeout: 5000, stdio: "ignore" }
    );
    // Also update the oauth token entry
    try {
      execSync('security delete-generic-password -s "claude-oauth-token"', {
        timeout: 5000,
        stdio: "ignore",
      });
    } catch {}
    execSync(
      `security add-generic-password -s "claude-oauth-token" -a "Claude Code" -w '${data.claudeAiOauth.accessToken}'`,
      { timeout: 5000, stdio: "ignore" }
    );
    return true;
  } catch (err) {
    log.error({ err }, "Failed to write keychain");
    return false;
  }
}

async function refreshToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
} | null> {
  try {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      log.error({ status: resp.status, body: text }, "Token refresh failed");
      return null;
    }

    return await resp.json() as any;
  } catch (err) {
    log.error({ err }, "Token refresh request failed");
    return null;
  }
}

export async function ensureFreshToken(): Promise<boolean> {
  const creds = readKeychain();
  if (!creds?.claudeAiOauth) {
    log.debug("No keychain credentials found — using env token (long-lived?)");
    return true; // Assume env token is valid (e.g., setup-token 1yr key)
  }

  const { claudeAiOauth: oauth } = creds;
  if (!oauth.expiresAt) return true; // No expiry = long-lived
  const timeLeft = oauth.expiresAt - Date.now();

  if (timeLeft > REFRESH_THRESHOLD_MS) {
    log.debug({ hoursLeft: +(timeLeft / 3600000).toFixed(1) }, "Token still fresh");
    return true;
  }

  log.info({ hoursLeft: +(timeLeft / 3600000).toFixed(1) }, "Token expiring soon, refreshing");

  const result = await refreshToken(oauth.refreshToken);
  if (!result) {
    log.error("Failed to refresh token");
    return false;
  }

  // Update keychain with new tokens
  creds.claudeAiOauth = {
    ...oauth,
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: Date.now() + result.expires_in * 1000,
  };

  if (writeKeychain(creds)) {
    log.info({ expiryHours: +(result.expires_in / 3600).toFixed(1) }, "Token refreshed successfully");
    return true;
  }

  return false;
}

let refreshInterval: ReturnType<typeof setInterval> | null = null;

export function startTokenRefreshLoop(): void {
  // Initial check
  ensureFreshToken().catch((err) => log.error({ err }, "Initial token check failed"));

  // Periodic check
  refreshInterval = setInterval(() => {
    ensureFreshToken().catch((err) => log.error({ err }, "Periodic token check failed"));
  }, CHECK_INTERVAL_MS);

  log.info("Token refresh loop started (check every %dmin)", CHECK_INTERVAL_MS / 60000);
}

export function stopTokenRefreshLoop(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
