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
  withTransaction: withTransactionMock,
}));

vi.mock("../plugins/auth.js", () => ({
  requireAuth: vi.fn(async (req: { userId?: string }) => {
    req.userId = "user-1";
  }),
}));

import { onboardingRoutes } from "./onboarding.js";

async function buildTestApp() {
  const app = Fastify();
  await app.register(onboardingRoutes);
  await app.ready();
  return app;
}

const onboardingBody = {
  school: { id: "school-1" },
  semester: "Fall 2026",
  courses: [
    {
      code: "CSE 101",
      name: "Design and Analysis of Algorithms",
      confirmed: true,
      professor: { id: "professor-1" },
    },
    {
      code: "MATH 20C",
      name: "Calculus and Analytic Geometry",
      confirmed: true,
      professor: { id: "professor-2" },
    },
  ],
};

describe("onboarding API", () => {
  beforeEach(() => {
    queryMock.mockReset();
    withTransactionMock.mockClear();
  });

  it("creates missing courses and enrolls the authenticated user", async () => {
    queryMock.mockImplementation(
      async (sql: string, params: unknown[] = []) => {
        if (sql.includes("SELECT id FROM courses")) return [];
        if (sql.includes("INSERT INTO courses")) {
          return [{ id: `course-${String(params[1]).replace(/\s+/g, "")}` }];
        }
        return [];
      },
    );
    const app = await buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding",
      payload: onboardingBody,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      schoolId: "school-1",
      enrolled: [
        {
          courseId: "course-CSE101",
          code: "CSE 101",
          name: "Design and Analysis of Algorithms",
        },
        {
          courseId: "course-MATH20C",
          code: "MATH 20C",
          name: "Calculus and Analytic Geometry",
        },
      ],
    });

    const courseInserts = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO courses"),
    );
    const enrollmentInserts = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO enrollments"),
    );
    expect(courseInserts).toHaveLength(2);
    expect(enrollmentInserts).toHaveLength(2);
    expect(enrollmentInserts[0][1]).toEqual([
      "user-1",
      "course-CSE101",
      "Fall 2026",
    ]);
    expect(enrollmentInserts[1][1]).toEqual([
      "user-1",
      "course-MATH20C",
      "Fall 2026",
    ]);
    await app.close();
  });

  it("reuses a normalized existing course without inserting a duplicate", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM courses")) {
        return [{ id: "course-existing" }];
      }
      return [];
    });
    const app = await buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding",
      payload: {
        ...onboardingBody,
        courses: [onboardingBody.courses[0]],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().enrolled).toEqual([
      {
        courseId: "course-existing",
        code: "CSE 101",
        name: "Design and Analysis of Algorithms",
      },
    ]);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("upper(replace(code,' ',''))=$2"),
      ["school-1", "CSE101"],
    );
    expect(
      queryMock.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO courses"),
      ),
    ).toBe(false);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO enrollments"),
      ["user-1", "course-existing", "Fall 2026"],
    );
    await app.close();
  });
});
