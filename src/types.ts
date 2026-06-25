// SSE event schema — matches Doc 3 §4.6 / Doc 2 §5.6.
export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "tool"; name: string; arg?: string }
  | { type: "citation"; source: string; kind: "personal" | "shared" }
  | { type: "done" }
  | { type: "error"; message: string };
