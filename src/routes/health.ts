import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({
    status: "UP",
    timestamp: new Date().toISOString(),
    mockAuth: config.mockAuth,
    mockAgent: config.useMockAgent,
  }));
}
