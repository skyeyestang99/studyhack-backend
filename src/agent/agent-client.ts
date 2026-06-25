import type { AgentEvent } from "../types.js";

export interface ChatInput {
  threadId: string;
  message: string;
  userId: string;
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
  // TODO (Doc 2 §6.2): mint a short-lived internal JWT, POST to AGENT_URL /chat,
  // and translate the agent's SSE stream into AgentEvents.
  // eslint-disable-next-line require-yield
  async *chat(_input: ChatInput): AsyncIterable<AgentEvent> {
    throw new Error("RealAgentClient not implemented — agent service not wired yet");
  }
}
