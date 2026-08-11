# Legacy Structural Bootstrap Verification

Build ID: `qama-phase3c-canonical-events-2026-08-12.1-legacy-structural-bootstrap`

## Scope

This candidate adds one reconstruction-only, manager-authorized structural bootstrap command. It reads preserved Legacy evidence server-side and creates only canonical `properties`, `units`, and `rentableSpaces`. It does not create tenants, tenancies, rental cycles, financial events, ledger movements, custody movements, deposits, expenses, installments, reserve transfers, refunds, or account-balance changes.

## Production preflight (GET-only)

- Captured at: `2026-08-11T20:32:55.858Z`
- Production documents observed: 629
- Snapshot SHA-256: `bb8b3cb24a418a6b5674f648c054dd05b05cf5f0c654984ffc68abc4089dc24c`
- Legacy structural subset SHA-256: `bbe1eb5c7dbef8d55146d8c227909b291df0ed3257eee6b8ebaed84cee94e1a9`
- Existing canonical structural counts: all zero
- Deterministic mapping: 1 property, 21 units, 94 rentable spaces
- Skipped structural items: 0
- Ambiguities/conflicts: 0

The preflight was read-only. The Production bootstrap was not executed.

## Safety and idempotency

- IDs are deterministic hashes of normalized Legacy structural source references.
- Each canonical record contains source provenance, source hash, bootstrap key, and evidence classification.
- Financial and contractual fields are excluded by an explicit allowlist-based mapping.
- Existing deterministic IDs are accepted only when their canonical structural hash matches exactly; otherwise the transaction fails closed.
- Replaying the same operation returns its stored result.
- Running a distinct operation over the same unchanged evidence creates zero duplicate structural entities.
- The command requires an owner/manager, `RECONSTRUCTION_ALLOWED`, the authoritative DRAFT reconstruction plan, matching source month, and a matching expected source hash.

## Tests actually executed

Environment: Node `v22.23.2`, Java 21 Firestore emulator.

Commands:

```text
npm run test:phase2-clean
npm run test:canonical-events
npm run test:phase3c-bootstrap
npm run test:reconstruction
npm run test:staging-lock
npm run test:structural-preparation
npm run test:dynamic-cycles
```

Final results:

- Baseline: 242 passed
- Canonical/static suite, including structural mapper: 220 passed
- Rules: 29 passed
- Staging Functions: 13 passed
- Financial Functions: 16 passed
- Operational Functions: 8 passed
- Structural Functions, including bootstrap integration: 35 passed
- Concurrency/idempotency: 4 passed
- Existing browser journeys: 8 passed
- Reconstruction browser journeys: 8 passed
- Canonical-active browser journeys: 10 passed
- Financial invariants: 30 passed
- Opening state: 20 passed
- Reconstruction: 13 passed
- Staging lock: 6 passed
- Structural preparation: 7 passed
- Dynamic cycles: 13 passed
- PIN and document-size checks: passed
- Complete command chain exit: 0

## Rollback

No Production state was changed. Before any future Production execution, capture a fresh backup and require the source structural hash to match this reviewed evidence. If execution fails, the transaction creates no partial registry. Before dependent canonical records exist, an explicitly authorized rollback can remove only records carrying the exact bootstrap key after verifying their hashes. Once dependent records exist, use controlled forward repair rather than destructive deletion.

## Restrictions

This verification does not authorize deployment or Production execution. `CANONICAL_ACTIVE` was not activated, `financialTruthVersion` was not changed, Legacy was not modified, and GitHub was untouched.
