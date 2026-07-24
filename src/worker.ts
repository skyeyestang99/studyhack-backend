import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { pool, query, withTransaction } from "./db.js";
import {
  MockAgentClient,
  RealAgentClient,
  type AgentClient,
  type StructuredStudyGuide,
} from "./agent/agent-client.js";
import {
  FeatureError,
  loadSnapshot,
  markInitialGuideFailed,
  persistGeneratedGuide,
  persistRevision,
  type RetrievalMode,
} from "./study-guides/service.js";

const agent: AgentClient = config.useMockAgent ? new MockAgentClient() : new RealAgentClient();
const workerId = `study-guide-worker-${process.pid}-${randomUUID()}`;
let shuttingDown = false;
let active = 0;

type JobRow = {
  id: string;
  type: "generate_guide" | "revise_guide";
  guide_id: string;
  owner_user_id: string;
  payload: {
    guideId: string;
    userId: string;
    courseId?: string;
    target?: string;
    retrievalMode?: RetrievalMode;
    revisionId?: string;
    baseVersionId?: string;
    instruction?: string;
    conceptIds?: string[];
  };
  attempts: number;
  lease_token: string;
  created_at: Date;
};

function backoffMs(attempts: number) {
  return Math.min(5 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

async function reclaimExpiredLeases() {
  await query(
    `UPDATE study_guide_jobs
     SET status='queued', locked_at=NULL, lease_expires_at=NULL, lease_token=NULL,
         locked_by=NULL, updated_at=now()
     WHERE status='running' AND lease_expires_at < now()`,
  );
}

async function claimJob(): Promise<JobRow | null> {
  return withTransaction(async (q) => {
    const rows = await q<JobRow>(
      `WITH candidate AS (
         SELECT id
         FROM study_guide_jobs
         WHERE type IN ('generate_guide', 'revise_guide')
           AND status='queued'
           AND run_after <= now()
         ORDER BY priority DESC, run_after, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE study_guide_jobs j
       SET status='running',
           attempts=attempts + 1,
           locked_at=now(),
           lease_expires_at=now() + ($1 || ' milliseconds')::interval,
           lease_token=gen_random_uuid(),
           locked_by=$2,
           updated_at=now()
       FROM candidate
       WHERE j.id = candidate.id
       RETURNING j.id, j.type, j.guide_id, j.owner_user_id, j.payload, j.attempts,
                 j.lease_token, j.created_at`,
      [config.studyGuideWorker.leaseMs, workerId],
    );
    return rows[0] ?? null;
  });
}

async function heartbeat(job: JobRow) {
  await query(
    `UPDATE study_guide_jobs
     SET lease_expires_at=now() + ($3 || ' milliseconds')::interval, updated_at=now()
     WHERE id=$1 AND lease_token=$2 AND status='running'`,
    [job.id, job.lease_token, config.studyGuideWorker.leaseMs],
  );
}

async function completeJob(job: JobRow) {
  await query(
    `UPDATE study_guide_jobs
     SET status='completed', completed_at=now(), updated_at=now()
     WHERE id=$1 AND lease_token=$2 AND status='running'`,
    [job.id, job.lease_token],
  );
}

async function failOrRetryJob(job: JobRow, code: string) {
  const terminal = job.attempts >= 3;
  await query(
    `UPDATE study_guide_jobs
     SET status=$3,
         run_after=CASE WHEN $3='queued' THEN now() + ($4 || ' milliseconds')::interval ELSE run_after END,
         lease_expires_at=NULL,
         lease_token=NULL,
         locked_by=NULL,
         locked_at=NULL,
         last_error_code=$5,
         updated_at=now(),
         completed_at=CASE WHEN $3='failed' THEN now() ELSE completed_at END
     WHERE id=$1 AND lease_token=$2 AND status='running'`,
    [job.id, job.lease_token, terminal ? "failed" : "queued", backoffMs(job.attempts), code],
  );
  if (terminal && job.type === "generate_guide") {
    await markInitialGuideFailed(job.guide_id, code, "Study guide generation failed.");
  }
  if (terminal && job.type === "revise_guide" && job.payload.revisionId) {
    await query(
      `UPDATE study_guide_revision_requests
       SET status='failed', error_code=$3, completed_at=now()
       WHERE id=$1 AND guide_id=$2 AND status <> 'completed'`,
      [job.payload.revisionId, job.guide_id, code],
    );
  }
}

async function writeRunStart(job: JobRow) {
  await query(
    `INSERT INTO study_guide_job_runs
       (guide_id, job_id, attempt, status, queue_wait_ms, started_at)
     VALUES ($1,$2,$3,'running',
       GREATEST(0, EXTRACT(EPOCH FROM (now() - $4::timestamptz)) * 1000)::int,
       now())
     ON CONFLICT (job_id, attempt) DO NOTHING`,
    [job.guide_id, job.id, job.attempts, job.created_at],
  );
}

async function writeRunEnd(job: JobRow, status: "completed" | "failed", errorCode?: string) {
  await query(
    `UPDATE study_guide_job_runs
     SET status=$3, completed_at=now(),
         total_ms=GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int,
         error_code=$4,
         error_stage=CASE WHEN $3='failed' THEN 'worker' ELSE NULL END
     WHERE job_id=$1 AND attempt=$2`,
    [job.id, job.attempts, status, errorCode ?? null],
  );
}

async function runGenerate(job: JobRow) {
  const { guideId, userId, courseId, target, retrievalMode } = job.payload;
  if (!courseId || !target || (retrievalMode !== "personal" && retrievalMode !== "course")) {
    throw new FeatureError(422, "Invalid generation job payload.", "INVALID_JOB_PAYLOAD");
  }
  await query(`UPDATE study_guides SET status='generating', updated_at=now() WHERE id=$1`, [guideId]);
  const guide = await agent.generateStudyGuide({ userId, courseId, target, retrievalMode });
  await persistGeneratedGuide({
    guideId,
    userId,
    courseId,
    retrievalMode,
    guide,
    jobId: job.id,
    leaseToken: job.lease_token,
  });
}

async function runRevision(job: JobRow) {
  const { guideId, userId, revisionId, baseVersionId, instruction, conceptIds } = job.payload;
  if (!revisionId || !baseVersionId || !instruction || !Array.isArray(conceptIds)) {
    throw new FeatureError(422, "Invalid revision job payload.", "INVALID_JOB_PAYLOAD");
  }
  const [guide] = await query<{ course_id: string; retrieval_mode: RetrievalMode }>(
    `SELECT course_id, retrieval_mode
     FROM study_guides
     WHERE id=$1 AND owner_user_id=$2`,
    [guideId, userId],
  );
  if (!guide) throw new FeatureError(404, "Not found", "NOT_FOUND");
  await query(
    `UPDATE study_guide_revision_requests
     SET status='running', started_at=COALESCE(started_at, now())
     WHERE id=$1 AND guide_id=$2`,
    [revisionId, guideId],
  );
  const snapshot = await withTransaction((q) => loadSnapshot(q, baseVersionId, guideId));
  const selected = snapshot.concepts
    .filter((concept) => conceptIds.includes(concept.logicalConceptId))
    .map(({ logicalConceptId, title, category, summary, keyPoints }) => ({
      logicalConceptId,
      title,
      category,
      summary,
      keyPoints,
    }));
  const revised: StructuredStudyGuide = await agent.reviseStudyGuide({
    userId,
    courseId: guide.course_id,
    retrievalMode: guide.retrieval_mode,
    instruction,
    concepts: selected,
  });
  await persistRevision({
    revisionId,
    guideId,
    userId,
    baseVersionId,
    guide: revised,
    jobId: job.id,
    leaseToken: job.lease_token,
  });
}

async function processJob(job: JobRow) {
  await writeRunStart(job);
  const heartbeatId = setInterval(() => {
    void heartbeat(job).catch(() => {});
  }, config.studyGuideWorker.heartbeatMs);
  try {
    if (job.type === "generate_guide") await runGenerate(job);
    else await runRevision(job);
    await completeJob(job);
    await writeRunEnd(job, "completed");
  } catch (err) {
    const code = err instanceof FeatureError ? err.code : "WORKER_ERROR";
    await failOrRetryJob(job, code);
    await writeRunEnd(job, "failed", code);
  } finally {
    clearInterval(heartbeatId);
  }
}

async function loop() {
  while (!shuttingDown) {
    await reclaimExpiredLeases();
    while (!shuttingDown && active < config.studyGuideWorker.concurrency) {
      const job = await claimJob();
      if (!job) break;
      active += 1;
      void processJob(job).finally(() => {
        active -= 1;
      });
    }
    await new Promise((resolve) => setTimeout(resolve, config.studyGuideWorker.pollIntervalMs));
  }
  while (active > 0) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
  });
}

console.log(
  `Study Guide worker started (id=${workerId}, concurrency=${config.studyGuideWorker.concurrency})`,
);
loop()
  .catch((err) => {
    console.error("Study Guide worker crashed", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
