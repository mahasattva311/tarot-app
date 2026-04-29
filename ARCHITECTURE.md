# ARCHITECTURE.md

> System architecture for the tarot reading app. Describes topology, data flow, key components,
> and technical decisions. For agent definitions, see `AGENTS.md`. For prompt templates,
> see `docs/prompts/`.

---

## System Overview

```
User
 │
 ▼
Frontend (React / Next.js)
 │  WebSocket or SSE for streaming reading output
 ▼
API Layer (Next.js API Routes / Edge Functions)
 │
 ├── Auth & Session Management (Clerk or Auth.js)
 │
 ├── Agent Orchestrator
 │    ├── IntentionClarifier   → LLM call
 │    ├── CardDealer           → Deterministic (no LLM)
 │    ├── CardInterpreter      → LLM call × 3 (one per card, parallelized)
 │    ├── SpreadSynthesizer    → LLM call
 │    ├── ReflectionPrompter   → LLM call
 │    └── SessionArchivist     → Deterministic, async (post-reading)
 │
 ├── Card Reference Data       → Static JSON (loaded at startup)
 │
 └── Database (Postgres via Prisma)
      ├── users
      ├── readings
      ├── cards_drawn
      └── user_themes
```

---

## Reading Session: End-to-End Flow

```
1. User authenticates
2. User opens new reading
3. IntentionClarifier ← user input
   └── Loops until ready_to_draw: true
4. CardDealer draws 3 cards (deterministic)
5. CardInterpreter × 3 (parallelized LLM calls)
   └── Each interpretation streams to frontend as it completes
6. SpreadSynthesizer ← all 3 interpretations (streams narrative to frontend)
7. ReflectionPrompter ← synthesis output (streams prompts to frontend)
   └── Reading is now fully visible to user
8. SessionArchivist persists reading (async, non-blocking, fires after step 7)
```

---

## Key Components

### Agent Orchestrator

Thin orchestration layer — not a framework. Manages:
- Prompt injection (reads from `docs/prompts/` at runtime in dev; bundled in prod)
- LLM call sequencing and parallelization
- Output validation (JSON schema check per agent)
- Error handling and retry logic (see `docs/RELIABILITY.md`)

Does NOT manage:
- Conversation memory (stateless per reading — all context injected explicitly)
- Authentication
- Database writes (delegated to `SessionArchivist`)

### LLM Provider

**Model:** Claude claude-sonnet-4-20250514 (default). Configurable per agent via environment variable.

**Call pattern:**
- All agents use the `/v1/messages` endpoint
- Streaming enabled for `CardInterpreter` and `SpreadSynthesizer` (longest outputs)
- `max_tokens`: 500 for interpreters, 800 for synthesizer, 300 for prompter
- Temperature: 0.7 (balances creativity with consistency)

### Card Reference Data

Static JSON file containing all 78 cards with:
- `card_id`, `card_name`, `arcana`, `suit` (if Minor)
- `keywords`: array of 5–8 archetypal keywords
- `symbolism`: 2–3 sentence description of key imagery
- `shadow_aspect`: brief note on reversed/shadow meaning

Loaded into memory at server startup. Not stored in the database.
Path: `data/cards.json`

### Database Schema

See `docs/generated/db-schema.md` for full schema (auto-generated from Prisma).

**Core tables:**

`users`
- `id`, `email`, `created_at`, `last_read_at`

`readings`
- `id`, `user_id`, `intention`, `spread_type`, `narrative`, `core_tension`,
  `integration_insight`, `reflection_prompts` (JSON), `created_at`

`cards_drawn`
- `id`, `reading_id`, `card_id`, `position`, `orientation`, `interpretation`, `keywords` (JSON)

`user_themes`
- `user_id`, `tag`, `count`, `last_seen_at`
  (upserted by `SessionArchivist` after each reading)

---

## Data Flow: Harness Context Injection

Each LLM agent call injects the following at runtime:

| Data | Source | Injected Into |
|---|---|---|
| System prompt template | `docs/prompts/{agent}.system.md` | `system` param |
| User intention | `IntentionClarifier` output | Template variable |
| Theme tags | `IntentionClarifier` output | Template variable |
| Card definition | `data/cards.json` | Template variable |
| Prior reading themes | `user_themes` DB query | Template variable (optional) |

No agent receives raw database rows or unfiltered user history. Context is always
pre-processed and scoped before injection.

---

## Authentication & Sessions

- Auth provider: Clerk (or Auth.js — TBD)
- Sessions are JWT-based; user ID is the primary key across all tables
- Reading sessions are stateless at the LLM layer; all state lives in the database
- Guest mode (no auth): stateless readings with no persistence — single session only

---

## Streaming

Reading output is streamed to the frontend via Server-Sent Events (SSE):
- `CardInterpreter` outputs stream one card at a time as they complete
- `SpreadSynthesizer` streams the narrative as it generates
- Frontend renders progressively — user sees the reading build in real time

**Streaming + JSON compatibility:** All LLM agents output structured JSON, which cannot be parsed until the full object closes. To reconcile this with streaming, the orchestrator uses a two-phase approach:
1. The raw token stream is forwarded directly to the frontend for progressive rendering (displayed as prose)
2. Once the stream closes, the complete response is validated as JSON and used for internal handoff to the next agent

This means the frontend must handle both the stream (for display) and the final parsed object (for state). The `interpretation` and `narrative` fields are the streamable prose; `keywords`, `core_tension`, and `integration_insight` are only available post-stream.

---

## Error Handling

See `docs/RELIABILITY.md` for full policy. Summary:
- LLM call failures: retry up to 2× with exponential backoff
- JSON parse failure on agent output: retry once with an explicit repair prompt
- `SessionArchivist` failure: log and queue for async retry; does NOT surface to user
- Timeout: 30s per LLM call; surface graceful error to user if exceeded

---

## Environment Variables

```env
LLM_MODEL=claude-sonnet-4-20250514
LLM_TEMPERATURE=0.7
LLM_MAX_TOKENS_INTERPRETER=500
LLM_MAX_TOKENS_SYNTHESIZER=800
LLM_MAX_TOKENS_PROMPTER=300
DATABASE_URL=...
AUTH_SECRET=...
NEXT_PUBLIC_APP_URL=...
```

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| LLM provider | Anthropic Claude | Best performance on nuanced, tonal prose |
| Parallelized interpreters | Yes | 3 sequential LLM calls would be too slow; no inter-card dependency |
| Static card data | JSON file, not DB | Read-only, rarely changes; DB overhead not justified |
| Streaming | SSE, not WebSocket | Unidirectional; simpler infra for this use case |
| Agent orchestration | Custom, not LangChain | Simpler, more auditable, easier to debug for this scope |
| User themes | Upserted tags, not full history passed to LLM | Avoids context bloat; keeps prior history influence lightweight |
