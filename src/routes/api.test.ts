import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("../db.js", () => ({
  query: queryMock,
}));

vi.mock("../plugins/auth.js", () => ({
  requireAuth: vi.fn(async (req: { userId?: string }) => {
    req.userId = "user-1";
  }),
}));

import { apiRoutes } from "./api.js";

async function buildTestApp() {
  const app = Fastify();
  await app.register(apiRoutes);
  await app.ready();
  return app;
}

describe("enrollment API", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("requires a courseId when leaving a course", async () => {
    const app = await buildTestApp();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/enrollments",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "courseId is required" });
    expect(queryMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires courseId to be a UUID when leaving a course", async () => {
    const app = await buildTestApp();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/enrollments?courseId=course-1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "courseId must be a valid UUID" });
    expect(queryMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("deletes only the authenticated user's enrollment", async () => {
    queryMock.mockResolvedValueOnce([{ id: "enrollment-1" }]);
    const app = await buildTestApp();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/enrollments?courseId=33333333-3333-3333-3333-333333333333",
    });

    expect(response.statusCode).toBe(204);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("WHERE user_id = $1 AND course_id = $2"),
      ["user-1", "33333333-3333-3333-3333-333333333333"],
    );
    await app.close();
  });

  it("returns 404 when the user is not enrolled in the course", async () => {
    queryMock.mockResolvedValueOnce([]);
    const app = await buildTestApp();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/enrollments?courseId=33333333-3333-3333-3333-333333333333",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: "Enrollment not found" });
    await app.close();
  });
});
