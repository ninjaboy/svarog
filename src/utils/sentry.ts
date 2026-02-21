import * as Sentry from "@sentry/node";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("sentry");

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    log.info("SENTRY_DSN not set, Sentry disabled");
    return;
  }

  Sentry.init({
    dsn,
    tracesSampleRate: 0,
    environment: "production",
  });

  initialized = true;
  log.info("Sentry initialized");
}

export function captureException(err: unknown): void {
  if (!initialized) return;
  Sentry.captureException(err);
}
