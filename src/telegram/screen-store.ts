import type { TelegramButton } from "./index.js";

export interface Screen {
  text: string;
  buttons: TelegramButton[][];
  html?: boolean;
  createdAt: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * In-memory store for navigation screens.
 * A screen = text + buttons, keyed by ID. When user presses a "nav:<screenId>"
 * button, the router looks up the screen here and calls editMessageWithButtons
 * to update the message in-place — creating navigation illusion.
 */
export class ScreenStore {
  private screens = new Map<string, Screen>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private ttlMs = DEFAULT_TTL_MS) {
    // Auto-cleanup every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  set(id: string, screen: Omit<Screen, "createdAt">): void {
    this.screens.set(id, { ...screen, createdAt: Date.now() });
  }

  /** Register multiple screens at once (e.g. from MCP tool) */
  setMany(screens: Record<string, Omit<Screen, "createdAt">>): void {
    for (const [id, screen] of Object.entries(screens)) {
      this.set(id, screen);
    }
  }

  get(id: string): Screen | undefined {
    const screen = this.screens.get(id);
    if (!screen) return undefined;
    // Check TTL
    if (Date.now() - screen.createdAt > this.ttlMs) {
      this.screens.delete(id);
      return undefined;
    }
    return screen;
  }

  delete(id: string): void {
    this.screens.delete(id);
  }

  /** Remove screens older than TTL */
  cleanup(): void {
    const now = Date.now();
    for (const [id, screen] of this.screens) {
      if (now - screen.createdAt > this.ttlMs) {
        this.screens.delete(id);
      }
    }
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
