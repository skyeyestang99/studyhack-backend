import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { apiRoutes } from "./routes/api.js";
import { materialsRoutes } from "./routes/materials.js";
import { chatRoutes } from "./routes/chat.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: config.corsOrigins, credentials: true });
await app.register(healthRoutes);
await app.register(apiRoutes);
await app.register(materialsRoutes);
await app.register(chatRoutes);

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(
    `StudyHack backend up on :${config.port} (mockAuth=${config.mockAuth}, mockAgent=${config.useMockAgent})`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
