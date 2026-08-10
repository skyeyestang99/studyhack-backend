import { initSentry } from "./instrument.js";
initSentry();

import { config } from "./config.js";
import { buildApp } from "./app.js";

/**
 * Refuse to start a deployed instance with authentication mocked out.
 *
 * MOCK_AUTH=true makes requireAuth short-circuit every request to one fixed user
 * id and auto-create that user row. In a deployed environment that is a total
 * authentication bypass: every caller becomes the same account, with access to
 * its courses, materials and conversations. Nothing prevented it before — it was
 * a plain env var away, and the mock user row already exists in production.
 *
 * Both deployed environments currently report mockAuth=false. This makes that a
 * guarantee instead of a coincidence.
 */
const isDeployed = config.appEnv === "production" || config.appEnv === "perf";
if (isDeployed && config.mockAuth) {
  console.error(
    `FATAL: MOCK_AUTH=true is not allowed in ${config.appEnv} — it bypasses ` +
      "authentication entirely and makes every request the same mock user. " +
      "Unset MOCK_AUTH and redeploy.",
  );
  process.exit(1);
}

const app = await buildApp();

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(
    `StudyHack backend up on :${config.port} (mockAuth=${config.mockAuth}, mockAgent=${config.useMockAgent})`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
