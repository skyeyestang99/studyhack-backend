import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { catalogRoutes } from "./routes/catalog.js";
import { apiRoutes } from "./routes/api.js";
import { materialsRoutes } from "./routes/materials.js";
import { chatRoutes } from "./routes/chat.js";

/** Build the configured Fastify app without listening (used by server + tests). */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.nodeEnv !== "test" });

  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  await app.register(healthRoutes);
  await app.register(catalogRoutes);
  await app.register(apiRoutes);
  await app.register(materialsRoutes);
  await app.register(chatRoutes);

  return app;
}
