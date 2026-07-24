import { initSentry } from "./instrument.js";
initSentry();

import { config } from "./config.js";
import { buildApp } from "./app.js";

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
