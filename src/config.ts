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
    // Adaptive polling — see the comment on loop() in worker.ts. A fixed short
    // interval keeps the DB compute permanently awake, which exhausted the Neon
    // quota twice. activeMs applies while the queue is draining; idle backs off
    // by doubling between idleMinMs and idleMaxMs.
    activeMs: Number(process.env.STUDY_GUIDE_WORKER_ACTIVE_POLL_MS ?? 2_000),
    idleMinMs: Number(process.env.STUDY_GUIDE_WORKER_IDLE_MIN_POLL_MS ?? 5_000),
    // Bounded at 60s: a student is watching a spinner, so cold-queue latency
    // matters here far more than it does for the embed worker (30 min).
    idleMaxMs: Number(process.env.STUDY_GUIDE_WORKER_IDLE_MAX_POLL_MS ?? 60_000),
    concurrency: Number(process.env.STUDY_GUIDE_WORKER_CONCURRENCY ?? 2),
    leaseMs: Number(process.env.STUDY_GUIDE_WORKER_LEASE_MS ?? 120_000),
    heartbeatMs: Number(process.env.STUDY_GUIDE_WORKER_HEARTBEAT_MS ?? 30_000),
  },
} as const;
