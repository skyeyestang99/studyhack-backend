// SSE event schema — matches Doc 05 §4 (response contract) / Doc 3 §4.6.
export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "tool"; name: string; arg?: string }
  | {
      type: "citation";
      materialId: string;
      fileName: string;
      score?: number;
      page?: number;
      snippet?: string;
      previewUrl?: string;
      kind: "personal" | "shared";
    }
  | { type: "done" }
  | { type: "error"; message: string };
