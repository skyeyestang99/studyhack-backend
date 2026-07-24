import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv: process.env.NODE_ENV ?? "development",
  corsOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000").split(","),

  // Postgres (Neon)
  databaseUrl: process.env.DATABASE_URL ?? "",

  // Cloudflare R2 (S3-compatible)
  r2: {
    endpoint: process.env.R2_ENDPOINT ?? "",
    region: process.env.R2_REGION ?? "auto",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: process.env.R2_BUCKET ?? "",
  },

  // Browser -> backend auth (Clerk). Doc 1 Decision 3.5 (Option B).
  clerkSecretKey: process.env.CLERK_SECRET_KEY ?? "",
  mockAuth: process.env.MOCK_AUTH === "true",

  // Admin allowlist (server-side, not client-controllable). Comma-separated emails.
  adminEmails: (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Interim email/password auth (until Clerk): JWT signing secret.
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",

  // Backend -> agent. Mocked until the agent service is wired.
  useMockAgent: process.env.USE_MOCK_AGENT !== "false",
  agentUrl: process.env.AGENT_URL ?? "",
  internalJwtSecret: process.env.INTERNAL_JWT_SECRET ?? "",

  // Error tracking (Sentry). Empty DSN = no-op (e.g. local dev).
  // appEnv distinguishes production/perf (NODE_ENV is "production" on both
  // Railway envs); RAILWAY_ENVIRONMENT_NAME is Railway's auto-injected value.
  sentryDsn: process.env.SENTRY_DSN ?? "",
  appEnv: process.env.APP_ENV ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? "development",

  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 5),
  studyGuideWorker: {
    pollIntervalMs: Number(process.env.STUDY_GUIDE_WORKER_POLL_INTERVAL_MS ?? 2_000),
    concurrency: Number(process.env.STUDY_GUIDE_WORKER_CONCURRENCY ?? 2),
    leaseMs: Number(process.env.STUDY_GUIDE_WORKER_LEASE_MS ?? 120_000),
    heartbeatMs: Number(process.env.STUDY_GUIDE_WORKER_HEARTBEAT_MS ?? 30_000),
  },
} as const;
