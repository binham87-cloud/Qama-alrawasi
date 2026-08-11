# QAMA Codebase Cleanup — Implementation Delta

Build: `qama-phase3c-canonical-events-2026-08-11.9-codebase-cleanup`

Baseline: `qama-phase3c-canonical-events-2026-08-11.8-generic-cycle-bridge`

## Removed deployment residue

- `.netlify/netlify.toml` and `netlify.toml`: Firebase Hosting is the sole deployment target in `firebase.json`; the generated Netlify file contained an obsolete absolute local path.
- `firestore-debug.log`: transient emulator output with no runtime, recovery, or audit role.

## Removed superseded write paths

The following unreferenced scripts directly changed particular Legacy records, depended on a retired `../../old/index.html`, extracted old PIN material, or bypassed canonical commands. They were not imported by Functions, Hosting, Rules, indexes, tests, backup, or rollback tooling:

- `scripts/add_mizan1_full_unit.mjs`
- `scripts/audit_july_custody_live.mjs`
- `scripts/classify_north_ocean_advance.mjs`
- `scripts/close_legacy_custody.mjs`
- `scripts/remove_july_104_deposit.mjs`
- `scripts/reopen_july_custody.mjs`
- `scripts/provision_pin_users_from_legacy.mjs`
- `scripts/phase2_readonly_audit.mjs`
- `scripts/migrate_financial_v11.mjs`
- `scripts/import_legacy_export.mjs`

The corresponding `migrate:*` and `legacy:import-*` package commands were removed. The replacement is the server-authoritative canonical command/reconstruction workflow; Legacy evidence remains read-only.

## Removed obsolete tests and reports

- Three manual Production/Netlify E2E scripts were removed. They were absent from the automated suite, depended on an external retired host or `../../old/index.html`, and could not provide deterministic local verification.
- Superseded Phase 2/pre-implementation reports and old generated UI inventory were removed. Current reconstruction, staging-lock, structural-preparation, and generic-cycle documentation remains.

## Deliberately retained

- `index.html` and `public/index.html`: intentional byte-identical pair. `public/index.html` is Firebase Hosting runtime; the root copy is the regression-test oracle. A test enforces equality.
- Legacy read/render compatibility inside the UI: required to preserve historical evidence and existing structural views. Financial Legacy writes are guarded by `CANONICAL_BACKEND_REQUIRED` and denied again by Firestore Rules.
- `functions/domain/delta_bridge.mjs` and opening-state tests: test/recovery-only, not imported by Production Functions. They prove no opening-plus-forward-event double counting.
- `scripts/export_firestore.mjs`, `compare_exports.mjs`, `audit_legacy_local.mjs`, and `reconcile_ledger.mjs`: backup, preservation, evidence comparison, and ledger recovery tools.
- `scripts/set_pin.mjs`: interactive administrative recovery tool; it does not expose PIN text in command history.
- Sanitized fixtures and historical regression tests: required to prove backward compatibility; they contain no Production secrets.
- `node_modules`: retained in the working tree for reproducible local testing but excluded from delivery archives and Firebase deployment by configuration.

## Canonical-source verification

- Runtime cycle collection: `rentalCycles` only.
- No runtime reference to a `cycles` Firestore collection remains.
- Firebase runtime entry points resolve from `firebase.json`.
- Direct client financial writes remain denied by Rules; canonical financial effects are server-authoritative.
