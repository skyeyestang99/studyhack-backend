import * as Sentry from "@sentry/node";
import { config } from "./config.js";

/**
 * Initialize Sentry error tracking. Must be called before any other imports
 * that should be instrumented (top of server.ts). No-op if SENTRY_DSN is unset
 * (e.g. local dev), so this is always safe to call.
 */
export function initSentry(): void {
  if (!config.sentryDsn) return;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.appEnv,
    tracesSampleRate: 0.1,
  });
}

export { Sentry };
