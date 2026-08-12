# Implementation delta

Baseline: `qama-phase3c-canonical-events-2026-08-11.5-reconstruction`

Candidate: `qama-phase3c-canonical-events-2026-08-11.6-staging-lock`

Implemented a strict server-side state machine, transactional control lookup, fail-closed normalization, reconstruction lineage/review enforcement, separate activation-review gate, extra activation freeze/source prerequisites, Rules defense for the control document, locked UI banner and client-side preflight, read-model state exposure, and auditable tenant/due-date structural confirmations.

Changed source/config/test files:

- `functions/domain/canonical_control.mjs` (new)
- `functions/domain/entity_repositories.mjs`
- `functions/domain/command_processor.mjs`
- `functions/domain/reconstruction.mjs`
- `functions/financial_commands.mjs`
- `functions/operational_commands.mjs`
- `functions/canonical_read_model.mjs`
- `firestore-v11.rules`
- `index.html`
- `public/index.html`
- `package.json`
- `package-lock.json`
- `tests/staging_lock.test.mjs` (new)
- `tests/staging_lock_functions_integration.mjs` (new)
- `tests/august_reconstruction.test.mjs`
- `tests/canonical_functions_integration.mjs`
- `tests/canonical_concurrency_integration.mjs`
- `tests/operational_functions_integration.mjs`
- `tests/browser_user_journeys.mjs`
- `tests/canonical_ui_read_path.test.mjs`
- `tests/rules/canonical_access_matrix.test.mjs`

No financial formula, historical amount, Production datum, PIN secret, or owner-supplied total was added. Emulator logs are runtime artifacts and excluded from delivery.
