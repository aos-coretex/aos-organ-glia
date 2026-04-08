# Glia — Self-Healing Pipeline Organ

## Identity

- **Organ:** Glia (#130)
- **Profile:** Probabilistic
- **MP-3 deliverable:** data plane (ticket database + HTTP API with state machine)

## Current State (MP-3)

This is the data-plane implementation: SQLite database with graph-native concepts, HTTP API for ticket lifecycle management via a strict state machine. All state transitions are enforced — invalid transitions return 409.

**Pending (MP-4+):**
- L1 handler dispatch (handler lookup table, handler functions)
- L2 probabilistic classification (Claude Code agent spawning, confidence threshold)
- L3 fix execution (handler invocation, code fix proposals, safety guardrails)
- Spine WebSocket connection, mailbox registration, event subscription
- Node.js autoheal consumer process
- Fix-history knowledge base

## Running

```bash
npm start       # Start server (port 4016 AOS / 3916 SAAS)
npm test        # Run unit tests
npm run seed    # Populate glia.db from monolith ai-kb.db
```

## Ports

| Environment | Port |
|---|---|
| AOS (development) | 4016 |
| SAAS (production) | 3916 |

## Database

- **Path:** `data/glia.db` (gitignored)
- **Tables:** `concepts` (graph-native), `op_config` (schema versioning)
- **Indexes:** `idx_concepts_type`, `idx_concepts_state`, `idx_concepts_test_id`
- **WAL mode** with 5000ms busy_timeout

## Key Principles

- **Ticket state machine enforces strict transitions.** Only valid state changes are allowed; invalid transitions return 409 Conflict. The state machine is: `pending` → `classifying` → `dispatched` → `healing` → `solved | human_required`. Escalation to `human_required` is always valid from any non-terminal state.
- **All code fixes require human approval.** Fixes are never auto-applied. The `/approve` endpoint requires a `proposed_fix` to be present on the ticket. The `/reject` endpoint records the rejection reason.
- **Deduplication.** Creating a ticket for a `test_id` that already has an open ticket (not in `solved` or `human_required`) returns the existing ticket.

## Conventions

- ES modules (`import`/`export`)
- Node.js built-in test runner (`node:test`, `node:assert/strict`)
- Router factory functions with dependency injection (no `app.locals`)
- In-memory SQLite (`:memory:`) for test isolation
- Structured JSON logging to stdout
- URN format: `urn:autoheal:ticket:<ISO8601>-<test_id>`
