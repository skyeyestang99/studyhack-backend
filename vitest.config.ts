import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Test FILES run one at a time, for two reasons — one practical, one correctness.
     *
     * Practical: every DB-backed suite opens its own pool against a single Postgres
     * instance. Ten in parallel exhausted the connection budget and beforeAll started
     * timing out ("Hook timed out in 10000ms"), which looks exactly like a broken test
     * and is really contention.
     *
     * Correctness: the quota suite mutates plan_limits, which is GLOBAL pricing state.
     * Run concurrently with anything that reads a limit, that is a race whose failures
     * would be intermittent and blamed on the wrong code.
     *
     * The suites are fast (~20s total), so serializing costs little and removes a
     * class of flake we would otherwise spend hours chasing.
     */
    fileParallelism: false,

    /**
     * beforeAll runs migrations and builds the app. Against a Neon instance that
     * scales to zero, the first connection can take several seconds of cold start —
     * well past vitest's 10s default.
     */
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
