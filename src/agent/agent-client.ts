import type { AgentEvent } from "../types.js";

export interface ChatInput {
  threadId: string;
  message: string;
  userId: string;
  history?: { role: "user" | "assistant"; content: string }[];
}

/**
 * The seam between the backend and the AI agent service.
 * Swap MockAgentClient -> RealAgentClient once the agent (studyhack-agent) is wired.
 */
export interface AgentClient {
  chat(input: ChatInput): AsyncIterable<AgentEvent>;
}

export class MockAgentClient implements AgentClient {
  async *chat(input: ChatInput): AsyncIterable<AgentEvent> {
    const reply =
      `**Approach** — let's think about "${input.message}" before computing. ` +
      `**Solution** — (mock) the worked steps would stream here. ` +
      `**Key Takeaways** — this is a stubbed response from the backend; the real agent is not wired yet.`;
    for (const word of reply.split(" ")) {
      yield { type: "token", content: word + " " };
      await new Promise((r) => setTimeout(r, 15));
    }
    yield { type: "citation", source: "/shared/lecture-03.pdf.md", kind: "shared" };
    yield { type: "done" };
  }
}

export class RealAgentClient implements AgentClient {
<<<<<<< Updated upstream
  // TODO (Doc 2 §6.2): mint a short-lived internal JWT, POST to AGENT_URL /chat,
  // and translate the agent's SSE stream into AgentEvents.
  // eslint-disable-next-line require-yield
  async *chat(_input: ChatInput): AsyncIterable<AgentEvent> {
    throw new Error("RealAgentClient not implemented — agent service not wired yet");
=======
  async *chat(input: ChatInput): AsyncIterable<AgentEvent> {
    const res = await fetch(`${config.agentUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Shared-secret internal auth (internal JWT is the prod upgrade — Doc 2 §6.2).
        Authorization: `Bearer ${config.internalJwtSecret}`,
      },
      body: JSON.stringify({
        question: input.message,
        courseId: input.courseId,
        k: 5,
        history: input.history ?? [],
      }),
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
>>>>>>> Stashed changes
  }
}
