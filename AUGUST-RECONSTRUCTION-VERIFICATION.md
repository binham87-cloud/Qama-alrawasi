# Controlled August Reconstruction — Local Verification

Build: `qama-phase3c-canonical-events-2026-08-11.5-reconstruction`

Source: `/Users/salembinham/.openclaw/workspaces/saeed/phase3c-bootstrap-build`

Baseline backup: `/Users/salembinham/.openclaw/workspaces/saeed/backups/phase3c-canonical-events-before-august-reconstruction-20260811-190437-+0400`

## Implemented guarantees

- Legacy month data is evidence-only and has zero canonical projection effect after activation.
- A staged reconstruction boundary rejects untagged financial writes.
- Reconstructed events retain original effective date, later reconstruction timestamp, actor, plan ID, operation ID, and source reference.
- Existing canonical idempotency, concurrency, approvals, cash-lot allocation, ledger, audit, reversal, reserve-transfer, and Bank Installment semantics apply unchanged.
- The UI enters controlled mode from the trusted read model and visibly identifies it.
- Direct client writes to reconstruction plans and month authorities are denied by Rules.
- Activation is gated by an independent completeness and ledger-replay audit.

## Exact final commands

```sh
export PATH=/Users/salembinham/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH
export JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.12/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"
node --version
java -version
npm run test:phase2-clean
npm run test:canonical-events
npm run test:phase3c-bootstrap
npm run test:reconstruction
```

## Final results

- Node: v22.23.2
- Java: OpenJDK 21.0.12
- Baseline logical suite: 242 passed, 0 failed
- Canonical/business suite: 180 passed, 0 failed
- Firestore Rules: 27 passed, 0 failed
- Canonical Functions: 16 passed, 0 failed
- Operational Functions: 8 passed, 0 failed
- Concurrency/idempotency: 4 passed, 0 failed
- Browser journeys: 8 passed, 0 failed
- Canonical financial invariants: 30 passed, 0 failed
- Opening-state suite: 20 passed, 0 failed
- Reconstruction invariants: 13 passed, 0 failed
- PIN Functions smoke: passed
- Document-size check: passed
- Final full chained exit: 0

The first attempted full run used an unavailable Java path and stopped before emulator tests. It was rerun with the installed OpenJDK 21 path above; the final complete run passed. No test was weakened or skipped to obtain a pass.

## Remaining gates

No unresolved financial-policy question remains for the implemented reconstruction mechanics. Production remains blocked pending separate owner approval, a fresh immutable Production snapshot/hash, structural-source review, deployment approval, write-freeze approval, completed employee reconstruction, manager approvals, and a clean Production-side dry-run/audit. No historical headline number was used as an implementation or acceptance target.

Production and GitHub were untouched. No deployment, migration, Bootstrap Apply, activation, Production write, commit, push, merge, or `main` modification occurred.

## Files changed from the `.11.4` backup

- `functions/domain/reconstruction.mjs` — reconstruction boundary, lineage, and completion audit.
- `functions/domain/command_processor.mjs` — plan create/activate/cancel commands and atomic lineage tagging.
- `functions/domain/entity_repositories.mjs` — Firestore repository mappings and referenced-plan loading.
- `functions/domain/financial_engine.mjs` — invariant coverage for reconstruction entities.
- `functions/domain/canonical_selectors.mjs` — exclusive month authority; Legacy projection suppression.
- `functions/financial_commands.mjs` — trusted callable command allowlist.
- `functions/canonical_read_model.mjs` — role-filtered reconstruction plan/authority read model.
- `firestore-v11.rules` — staff reads and denial of direct client writes.
- `public/index.html`, `index.html` — canonical reconstruction payload binding, evidence prompt, and visible controlled-mode banner.
- `tests/august_reconstruction.test.mjs` — 13 reconstruction invariants.
- `tests/rules/canonical_access_matrix.test.mjs` — reconstruction Rules coverage.
- `package.json`, `package-lock.json` — new build identity and reconstruction test command.
- `AUGUST-RECONSTRUCTION-IMPLEMENTATION-PLAN.md` — workflow and authority design.
- `AUGUST-RECONSTRUCTION-CUTOVER-ROLLBACK.md` — staged procedure and rollback gates.
- `AUGUST-RECONSTRUCTION-VERIFICATION.md` — commands, results, and scope evidence.

`firestore-debug.log` changed only through local emulator runtime output and is not delivery source.
