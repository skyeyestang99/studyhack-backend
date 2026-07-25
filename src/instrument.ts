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
    // Prefix the issue title with the env so prod vs perf is visible at a
    // glance in the issue list / alert notifications, not just in the
    // "environment" filter (found this necessary after a prod-only Neon
    // quota outage was easy to mistake for affecting perf too).
    beforeSend(event) {
      const label = `[${config.appEnv.toUpperCase()}]`;
      if (event.exception?.values?.[0] && !event.exception.values[0].value?.startsWith(label)) {
        event.exception.values[0].value = `${label} ${event.exception.values[0].value ?? ""}`;
      }
      if (event.message && !event.message.startsWith(label)) {
        event.message = `${label} ${event.message}`;
      }
      return event;
    },
  });
}

export { Sentry };
