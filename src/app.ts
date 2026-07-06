import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { catalogRoutes } from "./routes/catalog.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { apiRoutes } from "./routes/api.js";
import { materialsRoutes } from "./routes/materials.js";
import { chatRoutes } from "./routes/chat.js";
import { conversationRoutes } from "./routes/conversations.js";
import { studyToolRoutes } from "./routes/study-tools.js";
import { adminRoutes } from "./routes/admin.js";
import { syllabusRoutes } from "./routes/syllabus.js";

/** Build the configured Fastify app without listening (used by server + tests). */
export async function buildApp(): Promise<FastifyInstance> {
  // 12MB body limit so chat requests can carry a compressed base64 image
  // (snap-a-problem). Multipart uploads have their own limit below.
  const app = Fastify({
    logger: config.nodeEnv !== "test",
    bodyLimit: 12 * 1024 * 1024,
  });

  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  // Tolerate empty JSON bodies (bodyless DELETE/PUT still send Content-Type:
  // application/json). The default parser throws FST_ERR_CTP_EMPTY_JSON_BODY.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (body === "" || body === undefined || body === null) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch {
        const err = new Error("Invalid JSON body") as Error & {
          statusCode?: number;
        };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  await app.register(healthRoutes);
  await app.register(catalogRoutes);
  await app.register(onboardingRoutes);
  await app.register(apiRoutes);
  await app.register(materialsRoutes);
  await app.register(chatRoutes);
  await app.register(conversationRoutes);
  await app.register(studyToolRoutes);
  await app.register(adminRoutes);
  await app.register(syllabusRoutes);

  return app;
}
