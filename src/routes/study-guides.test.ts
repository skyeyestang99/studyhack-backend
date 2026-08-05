import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  applyManualEditMock,
  createRevisionRequestMock,
  listDiscoverGuidesMock,
  MockFeatureError,
  publishStudyGuideMock,
  queryMock,
  requireEnrollmentMock,
  serializePublishedGuideMock,
  serializeVersionMock,
  unpublishStudyGuideMock,
  withTransactionMock,
} = vi.hoisted(() => ({
  applyManualEditMock: vi.fn(),
  createRevisionRequestMock: vi.fn(),
  listDiscoverGuidesMock: vi.fn(),
  MockFeatureError: class MockFeatureError extends Error {
    constructor(
      public statusCode: number,
      message: string,
      public code: string,
      public details?: Record<string, unknown>,
    ) {
      super(message);
    }
  },
  publishStudyGuideMock: vi.fn(),
  queryMock: vi.fn(),
  requireEnrollmentMock: vi.fn(),
  serializePublishedGuideMock: vi.fn(),
  serializeVersionMock: vi.fn(),
  unpublishStudyGuideMock: vi.fn(),
  withTransactionMock: vi.fn((fn: (q: typeof queryMock) => Promise<unknown>) => fn(queryMock)),
}));

vi.mock("../db.js", () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
}));

vi.mock("../plugins/auth.js", () => ({
  requireAuth: vi.fn(async (req: { userId?: string }) => {
    req.userId = "user-1";
  }),
}));

vi.mock("../lib/access.js", () => ({
  isUuid: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  requireEnrollment: requireEnrollmentMock,
}));

vi.mock("../study-guides/service.js", () => ({
  FeatureError: MockFeatureError,
  applyManualEdit: applyManualEditMock,
  createGuideWithJob: vi.fn(),
  createRevisionRequest: createRevisionRequestMock,
  featureErrorBody: (err: { message: string; code: string; details?: Record<string, unknown> }) => ({
    message: err.message,
    code: err.code,
    details: err.details,
  }),
  getRevisionForOwner: vi.fn(),
  listDiscoverGuides: listDiscoverGuidesMock,
  parseCreateBody: vi.fn(),
  publishStudyGuide: publishStudyGuideMock,
  requestHash: vi.fn((value: unknown) => `hash:${JSON.stringify(value)}`),
  requireIdempotencyKey: (headers: Record<string, string | string[] | undefined>) => {
    const value = headers["idempotency-key"];
    const key = Array.isArray(value) ? value[0] : value;
    if (!key) {
      throw new MockFeatureError(400, "Idempotency-Key is required.", "IDEMPOTENCY_KEY_REQUIRED");
    }
    return key;
  },
  serializeGuide: vi.fn(),
  serializePublishedGuide: serializePublishedGuideMock,
  serializeVersion: serializeVersionMock,
  unpublishStudyGuide: unpublishStudyGuideMock,
}));

import { studyGuideRoutes } from "./study-guides.js";

const GUIDE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const REVISION_ID = "33333333-3333-4333-8333-333333333333";
const COURSE_ID = "44444444-4444-4444-8444-444444444444";

async function buildTestApp() {
  const app = Fastify();
  await app.register(studyGuideRoutes);
  await app.ready();
  return app;
}

describe("study guide API", () => {
  beforeEach(() => {
    applyManualEditMock.mockReset();
    createRevisionRequestMock.mockReset();
    listDiscoverGuidesMock.mockReset();
    publishStudyGuideMock.mockReset();
    queryMock.mockReset();
    requireEnrollmentMock.mockReset();
    serializePublishedGuideMock.mockReset();
    serializeVersionMock.mockReset();
    unpublishStudyGuideMock.mockReset();
    withTransactionMock.mockClear();
  });

  it("requires If-Match for manual edits", async () => {
    const app = await buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/study-guides/${GUIDE_ID}/edits`,
      headers: { "Idempotency-Key": "edit-1" },
      payload: { operations: [{ type: "updateGuide", title: "New title" }] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: "If-Match current version is required.",
      code: "IF_MATCH_REQUIRED",
    });
    expect(applyManualEditMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates a manual edit with idempotency and current-version precondition", async () => {
    applyManualEditMock.mockResolvedValueOnce({
      status: 201,
      body: { guideId: GUIDE_ID, versionId: VERSION_ID, status: "ready" },
    });
    const app = await buildTestApp();
    const operations = [{ type: "updateGuide", title: "New title" }];

    const response = await app.inject({
      method: "POST",
      url: `/api/study-guides/${GUIDE_ID}/edits`,
      headers: {
        "Idempotency-Key": "edit-1",
        "If-Match": `"${VERSION_ID}"`,
      },
      payload: { operations },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ guideId: GUIDE_ID, versionId: VERSION_ID, status: "ready" });
    expect(applyManualEditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        guideId: GUIDE_ID,
        ifMatch: VERSION_ID,
        idempotencyKey: "edit-1",
        operations,
      }),
    );
    await app.close();
  });

  it("maps manual edit version conflicts to API errors", async () => {
    applyManualEditMock.mockRejectedValueOnce(
      new MockFeatureError(409, "The guide changed before this update was applied.", "VERSION_CONFLICT", {
        currentVersionId: VERSION_ID,
      }),
    );
    const app = await buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/study-guides/${GUIDE_ID}/edits`,
      headers: {
        "Idempotency-Key": "edit-conflict",
        "If-Match": VERSION_ID,
      },
      payload: { operations: [{ type: "updateGuide", title: "New title" }] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      message: "The guide changed before this update was applied.",
      code: "VERSION_CONFLICT",
      details: { currentVersionId: VERSION_ID },
    });
    await app.close();
  });

  it("creates an AI revision request against the current version", async () => {
    createRevisionRequestMock.mockResolvedValueOnce({
      status: 202,
      body: {
        revisionId: REVISION_ID,
        guideId: GUIDE_ID,
        baseVersionId: VERSION_ID,
        status: "queued",
      },
    });
    const app = await buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/study-guides/${GUIDE_ID}/revisions`,
      headers: { "Idempotency-Key": "revision-1" },
      payload: {
        baseVersionId: VERSION_ID,
        instruction: "Make this easier.",
        conceptIds: ["44444444-4444-4444-8444-444444444444"],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().revisionId).toBe(REVISION_ID);
    expect(createRevisionRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        guideId: GUIDE_ID,
        baseVersionId: VERSION_ID,
        instruction: "Make this easier.",
        idempotencyKey: "revision-1",
      }),
    );
    await app.close();
  });

  it("returns 404 for missing or cross-user historical versions", async () => {
    serializeVersionMock.mockResolvedValueOnce(null);
    const app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/study-guides/${GUIDE_ID}/versions/${VERSION_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: "Not found" });
    expect(serializeVersionMock).toHaveBeenCalledWith(VERSION_ID, GUIDE_ID, "user-1");
    await app.close();
  });

  it("deletes only an owned guide and cascades persisted guide data", async () => {
    queryMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: GUIDE_ID }]);
    const app = await buildTestApp();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/study-guides/${GUIDE_ID}`,
    });

    expect(response.statusCode).toBe(204);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("SET current_version_id=NULL"),
      [GUIDE_ID, "user-1"],
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM study_guides"),
      [GUIDE_ID, "user-1"],
    );
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns 404 when deleting a missing or cross-user guide", async () => {
    queryMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const app = await buildTestApp();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/study-guides/${GUIDE_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: "Not found" });
    await app.close();
  });

  it("publishes an owned ready guide with idempotency", async () => {
    publishStudyGuideMock.mockResolvedValueOnce({
      status: 202,
      body: {
        guideId: GUIDE_ID,
        publishedVersionId: VERSION_ID,
        publicationStatus: "indexing",
      },
    });
    const app = await buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/study-guides/${GUIDE_ID}/publish`,
      headers: { "Idempotency-Key": "publish-1" },
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      guideId: GUIDE_ID,
      publishedVersionId: VERSION_ID,
      publicationStatus: "indexing",
    });
    expect(publishStudyGuideMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        guideId: GUIDE_ID,
        idempotencyKey: "publish-1",
      }),
    );
    await app.close();
  });

  it("lists Discover results only after course enrollment authorization", async () => {
    listDiscoverGuidesMock.mockResolvedValueOnce({ results: [] });
    const app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/courses/${COURSE_ID}/study-guides/discover?q=midterm`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ results: [] });
    expect(requireEnrollmentMock).toHaveBeenCalledWith("user-1", COURSE_ID);
    expect(listDiscoverGuidesMock).toHaveBeenCalledWith({
      userId: "user-1",
      courseId: COURSE_ID,
      q: "midterm",
      limit: undefined,
    });
    await app.close();
  });

  it("returns 404 for unavailable published guide opens", async () => {
    serializePublishedGuideMock.mockResolvedValueOnce(null);
    const app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/study-guides/${GUIDE_ID}/published`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: "Not found" });
    expect(serializePublishedGuideMock).toHaveBeenCalledWith(GUIDE_ID, "user-1");
    await app.close();
  });

  it("lists owner-only version metadata newest first", async () => {
    const createdAt = new Date("2026-07-23T12:00:00.000Z");
    queryMock.mockResolvedValueOnce([
      {
        id: VERSION_ID,
        version_number: 2,
        origin: "user_edit",
        base_version_id: "11111111-2222-4333-8444-555555555555",
        created_at: createdAt,
      },
    ]);
    const app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/study-guides/${GUIDE_ID}/versions`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: VERSION_ID,
        guideId: GUIDE_ID,
        versionNumber: 2,
        origin: "user_edit",
        baseVersionId: "11111111-2222-4333-8444-555555555555",
        createdAt: createdAt.toISOString(),
      },
    ]);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("g.owner_user_id=$2"), [
      GUIDE_ID,
      "user-1",
    ]);
    await app.close();
  });
});
