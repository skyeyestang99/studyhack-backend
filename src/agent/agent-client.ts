import type { AgentEvent } from "../types.js";
import { config } from "../config.js";

export interface ChatInput {
  threadId: string;
  message: string;
  courseId: string;
  userId: string;
  history?: { role: "user" | "assistant"; content: string }[];
  imageDataUrl?: string;
}

export interface StudyToolInput {
  kind: "study_guide" | "practice_problems";
  courseId: string;
  userId: string;
  topic?: string;
  count?: number;
}

/**
 * The seam between the backend and the AI agent service. MockAgentClient and
 * RealAgentClient emit the SAME AgentEvent contract (Doc 05 §4) so USE_MOCK_AGENT
 * toggles free-mock vs real-OpenAI transparently to callers.
 */
export interface AgentClient {
  chat(input: ChatInput): AsyncIterable<AgentEvent>;
  studyTool(input: StudyToolInput): AsyncIterable<AgentEvent>;
}

/** POST to an agent SSE endpoint and yield parsed AgentEvents. */
async function* postAgentSSE(path: string, body: unknown): AsyncIterable<AgentEvent> {
  const res = await fetch(`${config.agentUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Shared-secret internal auth (internal JWT is the prod upgrade — Doc 2 §6.2).
      Authorization: `Bearer ${config.internalJwtSecret}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error(`agent responded ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (json) yield JSON.parse(json) as AgentEvent;
    }
  }
}

export class MockAgentClient implements AgentClient {
  async *chat(input: ChatInput): AsyncIterable<AgentEvent> {
    const reply =
      `**Approach** — let's think about "${input.message}" before computing. ` +
      `**Solution** — (mock) the worked steps would stream here. ` +
      `**Key Takeaways** — this is a stubbed response; set USE_MOCK_AGENT=false to use the real agent.`;
    for (const word of reply.split(" ")) {
      yield { type: "token", content: word + " " };
      await new Promise((r) => setTimeout(r, 15));
    }
    yield {
      type: "citation",
      materialId: "00000000-0000-0000-0000-000000000000",
      fileName: "mock-lecture-notes.md",
      score: 0.9,
      kind: "shared",
    };
    yield { type: "done" };
  }

  async *studyTool(input: StudyToolInput): AsyncIterable<AgentEvent> {
    const title = input.kind === "practice_problems" ? "Practice Problems" : "Study Guide";
    const reply = `## ${title} (mock)\n\nStub for "${input.topic ?? "this course"}". Set USE_MOCK_AGENT=false for the real agent.`;
    for (const word of reply.split(" ")) {
      yield { type: "token", content: word + " " };
      await new Promise((r) => setTimeout(r, 8));
    }
    yield { type: "done" };
  }
}

export class RealAgentClient implements AgentClient {
  chat(input: ChatInput): AsyncIterable<AgentEvent> {
    return postAgentSSE("/chat", {
      question: input.message,
      courseId: input.courseId,
      k: 5,
      history: input.history ?? [],
      imageDataUrl: input.imageDataUrl,
    });
  }

  studyTool(input: StudyToolInput): AsyncIterable<AgentEvent> {
    return postAgentSSE("/study-tool", {
      kind: input.kind,
      courseId: input.courseId,
      topic: input.topic,
      count: input.count,
    });
  }
}
