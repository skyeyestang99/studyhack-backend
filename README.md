# StudyHack — Backend

The API service that **manages all backend requests** for StudyHack: auth, catalog/enrollment/project/material CRUD, the upload pipeline trigger, and the chat endpoint. The browser talks to this service; this service talks to the **agent** (`studyhack-agent`) for AI.

**Stack:** Node + TypeScript + Fastify. **Hosting:** Railway.

## Topology (3-tier)
```
Frontend (Vercel)  ->  Backend (Railway, this repo)  ->  Agent (Railway, studyhack-agent)
                          |                                  (mocked for now)
                          +-- Neon Postgres + Cloudflare R2 + Clerk
```
- **Browser → backend auth:** backend validates the Clerk session (design Doc 1 Decision 3.5, Option B).
- **Backend → agent auth:** short-lived internal JWT (Doc 2 §6.2). The agent is currently **mocked** behind `AgentClient`.

## Run locally
```bash
npm install
cp .env.example .env          # MOCK_AUTH=true and USE_MOCK_AGENT=true by default
npm run dev                   # http://localhost:8080
```
Smoke test:
```bash
curl localhost:8080/api/health
curl -N -X POST localhost:8080/api/chat -H 'content-type: application/json' \
  -d '{"threadId":"demo","message":"how do I start problem 3?"}'   # streams mock SSE
```

## Layout
- `src/server.ts` — Fastify app + route registration
- `src/routes/` — `health`, `api` (catalog/enrollment/projects), `materials`, `chat`
- `src/plugins/auth.ts` — Clerk auth preHandler (dev mock + integration TODO)
- `src/agent/agent-client.ts` — `AgentClient` interface + `MockAgentClient` + `RealAgentClient` stub (the swap point)

## TODO (Phase 1)
1. Wire Clerk verification in `plugins/auth.ts` (replace MOCK_AUTH).
2. Implement endpoints per **Doc 2 §5** (Neon + R2 presign + Inngest trigger).
3. Implement `RealAgentClient` to call `studyhack-agent` with the internal JWT, then set `USE_MOCK_AGENT=false`.

Design docs (HLD + LLDs) live in `skyeyestang99/StudyAiApplication`.
