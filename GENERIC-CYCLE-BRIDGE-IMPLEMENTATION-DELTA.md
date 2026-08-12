# Generic Canonical Cycle Bridge — Implementation Delta

Build: `qama-phase3c-canonical-events-2026-08-11.8-generic-cycle-bridge`

## Outcome

The reconstruction-cycle bridge is plan-driven, dynamic, and month-agnostic. Production logic does not assume an August list, a unit list, or any obligation count. Both reconstruction-origin and normal post-cutover obligations use `rentalCycles` and the same financial projection/allocation engine; provenance is metadata only.

## Commands

- `addReconstructionObligation`: adds one reviewed obligation to any editable DRAFT reconstruction plan.
- `cancelReconstructionObligation`: cancels an unmaterialized plan item with reason and audit lineage.
- `materializeReconstructionCycles`: dynamically enumerates the plan's current obligations and creates a cycle only for each structurally ready, non-cancelled item.
- `createRentalCycle`: creates a normal post-cutover cycle in the same canonical collection and schema while `CANONICAL_ACTIVE`.

Materialization is idempotent, creates no ledger entry or balance movement, records plan/source provenance, skips incomplete/cancelled/already-materialized items, and rejects conflicting canonical cycle IDs.

## Safety boundaries

- `MAINTENANCE_LOCKED` remains fail-closed.
- Only the explicitly scoped structural-preparation permit can allow plan editing, structural confirmation, and non-financial materialization while locked.
- Financial reconstruction remains denied until `RECONSTRUCTION_ALLOWED`.
- A financial event still requires both a materialized canonical cycle and a structurally ready matching plan obligation.
- Direct client writes to `rentalCycles` remain denied by Firestore Rules.
- Normal cycle creation is manager-only and requires `CANONICAL_ACTIVE`.
- No activation, migration, Bootstrap Apply, or `financialTruthVersion` change is part of this build.

## UI/read model

- The browser lookup was corrected from the noncanonical `cycles` collection to `rentalCycles`.
- The canonical read model now returns the current month's `rentalCycles` dynamically.
- The structural panel enumerates the plan's current non-cancelled items rather than a fixed list.

## Changed source/config/test files

- `functions/domain/command_processor.mjs`
- `functions/domain/entity_repositories.mjs`
- `functions/domain/canonical_control.mjs`
- `functions/domain/reconstruction.mjs`
- `functions/financial_commands.mjs`
- `functions/canonical_read_model.mjs`
- `index.html`
- `public/index.html`
- `package.json`
- `package-lock.json`
- `tests/staging_lock_functions_integration.mjs`
- `tests/dynamic_reconstruction_cycles.test.mjs` (new)
- `GENERIC-CYCLE-BRIDGE-IMPLEMENTATION-DELTA.md` (new)
- `GENERIC-CYCLE-BRIDGE-VERIFICATION.md` (new)

`firestore-debug.log` changed only as emulator output and is excluded from delivery.

## Baseline snapshot

`/Users/salembinham/.openclaw/workspaces/saeed/backups/phase3c-before-generic-cycle-bridge-20260811-211349-+0400`

No Production or GitHub resource was changed.
