import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, withTransactionMock } = vi.hoisted(() => {
  const query = vi.fn();
  return {
    queryMock: query,
    withTransactionMock: vi.fn(
      async (operation: (q: typeof query) => Promise<unknown>) =>
        operation(query),
    ),
  };
});

vi.mock("../db.js", () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
}));

vi.mock("../plugins/auth.js", () => ({
  requireAuth: vi.fn(async (req: { userId?: string }) => {
    req.userId = "user-1";
  }),
}));

import { catalogRoutes } from "./catalog.js";

async function buildTestApp() {
  const app = Fastify();
  await app.register(catalogRoutes);
  await app.ready();
  return app;
}

describe("catalog API", () => {
  beforeEach(() => {
    queryMock.mockReset();
    withTransactionMock.mockClear();
  });

  it("returns enrollment counts with scoped course search results", async () => {
    queryMock.mockResolvedValueOnce([
      {
        id: "33333333-3333-3333-3333-333333333333",
        name: "Differential Equations",
        code: "MATH 20D",
        school_id: "11111111-1111-1111-1111-111111111111",
        professor_id: "22222222-2222-2222-2222-222222222222",
        enrollment_count: 42,
        score: 1,
        created_at: new Date("2026-01-08T08:00:00.000Z"),
      },
    ]);
    const app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/schools/11111111-1111-1111-1111-111111111111/courses?q=MATH%2020D",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      matches: [
        {
          item: {
            id: "33333333-3333-3333-3333-333333333333",
            name: "Differential Equations",
            code: "MATH 20D",
            schoolId: "11111111-1111-1111-1111-111111111111",
            professorId: "22222222-2222-2222-2222-222222222222",
            enrollmentCount: 42,
            createdAt: "2026-01-08T08:00:00.000Z",
          },
          score: 1,
          strong: true,
        },
      ],
      canCreate: false,
      threshold: 0.65,
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("COUNT(*)::int AS enrollment_count"),
      [
        "MATH 20D",
        "11111111-1111-1111-1111-111111111111",
        null,
        null,
        5,
      ],
    );
    await app.close();
  });
});
