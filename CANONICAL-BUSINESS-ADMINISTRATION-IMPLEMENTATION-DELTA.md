# Canonical Business Administration — Implementation Delta

Build: `qama-phase3c-canonical-events-2026-08-11.10-canonical-business-administration`

Baseline: `.11.9-codebase-cleanup`. Pre-change byte-preserving backup:
`/Users/salembinham/.openclaw/workspaces/saeed/backups/phase3c-codebase-cleanup-before-canonical-admin-20260811-214032-+0400`.

## Runtime changes

- Added a manager-only, server-authoritative `structuralCommand` callable.
- Added dynamic registries for properties, units, rentable spaces, tenants and tenancies. `rentalCycles` remains the sole canonical obligation source.
- Added create, descriptive update, activation/deactivation, tenancy, replacement/departure, cycle creation/renewal/correction/expiry/cancellation commands.
- Added transactional operation identity, payload hashing, replay-safe idempotency and before/after audit events.
- Added server-side existence, active-state, hierarchy, tenancy and cycle-conflict validation.
- Removed `createRentalCycle` from the general financial callable; cycle creation now has one authoritative structural path.
- Added canonical registry linkage and revalidation before reconstruction-cycle materialization.
- Allowed reconstruction-origin structural creation only for managers while `RECONSTRUCTION_ALLOWED` and only with an existing DRAFT plan. Normal administration still requires `CANONICAL_ACTIVE`.
- Extended the canonical read model and Rules for the new registries. Direct client writes remain denied.
- Replaced the principal owner structural actions with canonical actions. `saveCurData` now rejects every Legacy structural mutation; Legacy remains readable evidence.
- Replaced the fixed operational year with the current date/record-derived calendar. April 2026 remains only as historical availability metadata. Removed the fixed June 2026 installment card.

## Changed files

- `firestore-v11.rules`
- `functions/canonical_read_model.mjs`
- `functions/domain/canonical_control.mjs`
- `functions/domain/command_processor.mjs`
- `functions/domain/entity_repositories.mjs`
- `functions/domain/reconstruction.mjs`
- `functions/financial_commands.mjs`
- `functions/index.mjs`
- `functions/structural_commands.mjs` (new)
- `index.html`
- `public/index.html`
- `package.json`
- `package-lock.json`
- `tests/canonical_structural_admin_integration.mjs` (new)
- `tests/canonical_structural_architecture.test.mjs` (new)
- `tests/dynamic_reconstruction_cycles.test.mjs`
- `tests/rules/canonical_access_matrix.test.mjs`
- `tests/staging_lock_functions_integration.mjs`
- The eight delivery/review reports in this build.

No Production, Legacy evidence, GitHub, authentication data or financial data was changed.
