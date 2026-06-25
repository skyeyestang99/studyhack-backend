import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv: process.env.NODE_ENV ?? "development",
  corsOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000").split(","),

  // Browser -> backend auth (Clerk). Doc 1 Decision 3.5 (Option B).
  clerkSecretKey: process.env.CLERK_SECRET_KEY ?? "",
  // Local dev convenience: attach a mock user instead of verifying Clerk.
  mockAuth: process.env.MOCK_AUTH === "true",

  // Backend -> agent. Mocked until the agent service is wired.
  useMockAgent: process.env.USE_MOCK_AGENT !== "false", // default: true
  agentUrl: process.env.AGENT_URL ?? "",
  internalJwtSecret: process.env.INTERNAL_JWT_SECRET ?? "",
} as const;
