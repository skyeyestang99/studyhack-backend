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

export interface FlashcardInput {
  courseId: string;
  userId: string;
  topic?: string;
  count?: number;
}

export interface AgentCard {
  front: string;
  back: string;
}

export interface StructuredStudyGuide {
  title: string;
  summary: string;
  concepts: {
    logicalConceptId?: string;
    title: string;
    category?: string;
    summary: string;
    keyPoints: string[];
    sourceRefs: string[];
  }[];
  sources: {
    ref: string;
    materialId: string;
    page?: number;
    snippet: string;
    score: number;
  }[];
}

export interface GenerateStudyGuideInput {
  userId: string;
  courseId: string;
  target: string;
  retrievalMode: "personal" | "course";
}

export interface ReviseStudyGuideInput {
  userId: string;
  courseId: string;
  retrievalMode: "personal" | "course";
  instruction: string;
  concepts: {
    logicalConceptId: string;
    title: string;
    category?: string;
    summary: string;
    keyPoints: string[];
  }[];
}

/**
 * The seam between the backend and the AI agent service. MockAgentClient and
 * RealAgentClient emit the SAME AgentEvent contract (Doc 05 §4) so USE_MOCK_AGENT
 * toggles free-mock vs real-OpenAI transparently to callers.
 */

export interface ExamInsightSource {
  materialId: string;
  fileName: string;
  page?: number;
}

export interface ExamInsightTopic {
  topic: string;
  /** The observed FORM this instructor tests it in — the differentiated part. */
  howItsTested: string;
  /** Distinct assessment documents the topic appeared in. */
  appearances: number;
  sources: ExamInsightSource[];
}

export interface ExamInsights {
  summary: string;
  topics: ExamInsightTopic[];
  /** How many assessment docs backed the analysis — lets the UI be candid. */
  assessmentCount: number;
  chunkCount: number;
}

export interface AgentClient {
  chat(input: ChatInput): AsyncIterable<AgentEvent>;
  studyTool(input: StudyToolInput): AsyncIterable<AgentEvent>;
  flashcards(input: FlashcardInput): Promise<AgentCard[]>;
  generateStudyGuide(input: GenerateStudyGuideInput): Promise<StructuredStudyGuide>;
  reviseStudyGuide(input: ReviseStudyGuideInput): Promise<StructuredStudyGuide>;
  examInsights(courseId: string): Promise<ExamInsights>;
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

  async flashcards(input: FlashcardInput): Promise<AgentCard[]> {
    return [
      { front: `(mock) Key term for ${input.topic ?? "this course"}`, back: "(mock) definition" },
      { front: "(mock) Concept 2", back: "(mock) explanation" },
    ];
  }

  async examInsights(_courseId: string): Promise<ExamInsights> {
    return {
      summary: "(mock) This instructor emphasises constrained optimisation.",
      topics: [
        {
          topic: "(mock) Lagrange multipliers",
          howItsTested: "(mock) two-constraint optimisation with a geometric setup",
          appearances: 2,
          sources: [],
        },
      ],
      assessmentCount: 2,
      chunkCount: 8,
    };
  }

  async generateStudyGuide(input: GenerateStudyGuideInput): Promise<StructuredStudyGuide> {
    return {
      title: `${input.target} Study Guide`,
      summary: `Mock generated guide for ${input.target}.`,
      concepts: [
        {
          title: "Core definitions",
          category: "Foundations",
          summary: "Know the central terms and how they constrain problem solving.",
          keyPoints: ["Write definitions precisely.", "Connect each term to a worked example."],
          sourceRefs: [],
        },
        {
          title: "Problem strategy",
          category: "Applications",
          summary: "Choose a method by matching the question shape to known patterns.",
          keyPoints: ["Identify givens first.", "Check assumptions before applying a formula."],
          sourceRefs: [],
        },
      ],
      sources: [],
    };
  }

  async reviseStudyGuide(input: ReviseStudyGuideInput): Promise<StructuredStudyGuide> {
    return {
      title: "Revised concepts",
      summary: input.instruction,
      concepts: input.concepts.map((concept) => ({
        ...concept,
        summary: `${concept.summary}\n\nRevision note: ${input.instruction}`,
        sourceRefs: [],
      })),
      sources: [],
    };
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

  async flashcards(input: FlashcardInput): Promise<AgentCard[]> {
    const res = await fetch(`${config.agentUrl}/flashcards`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.internalJwtSecret}`,
      },
      body: JSON.stringify({
        courseId: input.courseId,
        topic: input.topic,
        count: input.count,
      }),
    });
    if (!res.ok) throw new Error(`agent responded ${res.status}`);
    const data = (await res.json()) as { cards?: AgentCard[] };
    return data.cards ?? [];
  }

  async generateStudyGuide(input: GenerateStudyGuideInput): Promise<StructuredStudyGuide> {
    const res = await fetch(`${config.agentUrl}/study-guide/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.internalJwtSecret}`,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`agent responded ${res.status}`);
    return (await res.json()) as StructuredStudyGuide;
  }

  async examInsights(courseId: string): Promise<ExamInsights> {
    const res = await fetch(`${config.agentUrl}/exam-insights`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.internalJwtSecret}`,
      },
      body: JSON.stringify({ courseId }),
    });
    if (!res.ok) throw new Error(`agent responded ${res.status}`);
    return (await res.json()) as ExamInsights;
  }

  async reviseStudyGuide(input: ReviseStudyGuideInput): Promise<StructuredStudyGuide> {
    const res = await fetch(`${config.agentUrl}/study-guide/revise`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.internalJwtSecret}`,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`agent responded ${res.status}`);
    return (await res.json()) as StructuredStudyGuide;
  }
}
