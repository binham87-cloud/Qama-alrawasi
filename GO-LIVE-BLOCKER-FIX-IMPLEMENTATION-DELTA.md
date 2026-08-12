# Go-Live Blocker Fix — Implementation Delta

Build: `qama-phase3c-canonical-events-2026-08-11.11-go-live-blocker-fix`

## Scope

This candidate changes only the Hosting client bridge required to invoke the existing canonical structural Function during an authorized reconstruction. Financial formulas, server commands, Rules, indexes, structural schema, and Legacy evidence behavior are unchanged.

## Client behavior

- `CANONICAL_ACTIVE`: structural administration continues through the normal canonical payload and workflow.
- `RECONSTRUCTION_ALLOWED`: the client derives the reconstruction context from the current canonical read model and adds `origin: "reconstruction"` plus the authoritative `reconstructionPlanId`.
- All other gate states: structural administration remains denied.

The reconstruction context is accepted only when the read model proves manager role, matching current month authority, `STAGED` non-activated authority, and exactly one matching DRAFT plan. Missing, ambiguous, wrong-month, inactive, or invalid context fails closed.

## Security retained

The server remains authoritative for manager role, gate state, DRAFT-plan existence, referential integrity, audit, and idempotency. Direct Firestore writes remain denied. Legacy structural persistence remains disabled.

## Changed files

- `BUILD-ID.txt` — new build identity.
- `index.html` — reconstruction-aware structural client bridge and dynamic authoritative-plan resolver.
- `public/index.html` — byte-identical Hosting copy of the same change.
- `package.json` — build version and inclusion of the focused UI bridge test.
- `package-lock.json` — matching package version metadata.
- `tests/canonical_structural_admin_integration.mjs` — focused locked/reconstruction/invalid-plan/employee/idempotency/zero-ledger coverage.
- `tests/reconstruction_structural_ui_bridge.test.mjs` — new client contract coverage.
- `GO-LIVE-BLOCKER-FIX-IMPLEMENTATION-DELTA.md` — this report.
- `GO-LIVE-BLOCKER-FIX-VERIFICATION.md` — verification evidence.

No Production or GitHub resource was changed.
