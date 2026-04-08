# Glia — Self-Healing Pipeline Organ

## Identity

- **Organ:** Glia (#130)
- **Profile:** Probabilistic
- **MP-3 deliverable:** data plane (ticket database + HTTP API with state machine)
- **MP-4 deliverable:** organ-boot refactor, Glia pipeline (L1/L2/L3), Spine connectivity

## Current State (MP-4)

Full organ implementation: SQLite database, strict ticket state machine, three-layer Glia pipeline (L1 deterministic handlers, L2 smart dispatch via Lobe at port 4010, L3 fix proposals), Spine-connected live loop.

**Pipeline capabilities:**
- **Intake:** Spine broadcast subscription for `verification_result` failures, deduplication, repeat failure escalation
- **L1 (deterministic):** 8 handlers — capture_processor, symlink_redeploy, launchagent_reload, radiant_boot_cache, radiant_dream, pg_restart, backup_retry, custom. Pattern matching on test_id with wildcard support.
- **L2 (smart dispatch):** Directed OTM to Lobe for probabilistic classification. 120s timeout → human_required. Max 2 concurrent. Confidence threshold 0.6.
- **L3 (fixer):** Handler execution for operational, fix proposal request for logic_bug. Cooldown tracking per handler.
- **Escalator:** Unified escalation to human_required with reason tracking.
- **Spine handlers:** classify_result, fix_result, approve_fix, reject_fix, query_tickets

**Pending (future):**
- Fix-history knowledge base
- Stale classification detection (re-emit after 30 min)
- Handler auto-discovery
- L2 caching

## Running

```bash
npm start       # Start server (port 4016 AOS / 3916 SAAS)
npm test        # Run unit tests (70 tests)
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

- **Ticket state machine enforces strict transitions.** `pending` → `classifying` → `dispatched` → `healing` → `solved | human_required`. Escalation to `human_required` is always valid.
- **All code fixes require human approval.** Fixes are never auto-applied.
- **Deduplication.** Open ticket for same test_id returns existing.
- **organ-boot factory** (`createOrgan()`) for lifecycle management.

## Conventions

- ES modules (`import`/`export`)
- Node.js built-in test runner (`node:test`, `node:assert/strict`)
- Router factory functions with dependency injection
- In-memory SQLite (`:memory:`) for test isolation
- Structured JSON logging to stdout
- URN format: `urn:glia:ticket:<ISO8601>-<test_id>`
