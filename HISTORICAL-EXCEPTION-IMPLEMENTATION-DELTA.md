# Historical Exception Implementation Delta

Build: `qama-phase3c-canonical-events-2026-08-12.2-historical-exception`

## Scope

This build adds one explicit, manager-controlled resolution outcome for historical reconstruction items whose evidence is insufficient. It does not classify any item automatically and does not create canonical operational or financial truth.

## Decision model

The current decision is embedded on the applicable reconstruction obligation or historical financial candidate:

```json
{
  "status": "HISTORICAL_EXCEPTION",
  "reason": "owner-supplied reason",
  "decidedBy": "authenticated owner/manager ID",
  "decidedAt": "server command timestamp",
  "reconstructionPlanId": "immutable plan reference",
  "itemType": "obligation | financial_candidate",
  "itemId": "immutable item reference",
  "evidenceReference": "immutable original source reference",
  "evidenceHash": "original evidence hash or null",
  "decisionOperationId": "idempotent operation ID",
  "projectionEffect": "none",
  "immutableEvidence": true
}
```

Every decision is also appended to `historicalExceptionDecisions` and written to the existing immutable audit-event path. Removal appends a `HISTORICAL_EXCEPTION_REMOVED` record containing its reason, actor, timestamp, original evidence reference, prior decision operation ID and removal operation ID. It never rewrites the original history.

## Enforcement

- `classifyHistoricalException` and `removeHistoricalException` are server-authoritative commands.
- Both require an active owner or manager and a DRAFT reconstruction plan.
- Employees are rejected with `MANAGER_REQUIRED`.
- Direct client writes to reconstruction plans and audit events remain denied by Firestore Rules.
- A non-empty reason and original evidence reference are mandatory.
- A canonically represented item cannot be classified as an exception.
- An exception cannot be confirmed or materialized until an audited manager removal occurs.
- Operation ID plus canonical payload hashing preserves exactly-once replay behavior.
- The commands are denied outside the reconstruction control state and after `CANONICAL_ACTIVE`.

## Activation readiness

Before this build, readiness required every active reviewed obligation to complete structural confirmations. After this build, each obligation or historical financial candidate is resolved only when either:

1. it has a valid canonical representation; or
2. it has an explicit authorized `HISTORICAL_EXCEPTION` decision with the same reconstruction plan and `projectionEffect: none`.

Unknown, partial and unreviewed items still produce explicit activation blockers. A generic structural-incomplete blocker is retained for compatibility, with per-item blocker codes added for auditability.

## Zero-effect invariant

Historical exceptions are stored only as reconstruction evidence and audit state. Materialization skips them. Selectors and KPI projections do not read them. Classification and removal do not create or mutate tenants, tenancies, cycles, collections, deposits, expenses, custody, ledger, balances, liquidity, Target, Collected, Deposited, Holding, Arrears, Income, Expenses or Net.

## Read-only visibility

The canonical active evidence tab lists active historical exceptions from the canonical read model. It provides no classification, removal, financial or operational action. Legacy operational rendering remains unreachable.

## Changed files

- `BUILD-ID.txt` — new build identity.
- `functions/domain/canonical_control.mjs` — reconstruction-state manager command allowlist.
- `functions/domain/command_processor.mjs` — explicit classify/remove commands, audit history, skip and confirmation guards.
- `functions/domain/entity_repositories.mjs` — transactional plan/authority loading and existing persistence path.
- `functions/domain/reconstruction.mjs` — per-item two-outcome activation readiness.
- `functions/financial_commands.mjs` — callable command exposure.
- `index.html` and `public/index.html` — identical read-only exception evidence rendering.
- `package.json` and `package-lock.json` — build version and test registration.
- `tests/historical_exception.test.mjs` — new invariant, role, zero-effect, audit, replay, routing and Rules tests.
- `tests/staging_lock.test.mjs` — explicit control-state coverage for the two commands.
- `HISTORICAL-EXCEPTION-IMPLEMENTATION-DELTA.md` — this implementation record.
- `HISTORICAL-EXCEPTION-VERIFICATION.md` — execution evidence and release gate.

## Preserved unchanged

The structural-bootstrap implementation and its deterministic records are byte-identical to the pre-change backup. Legacy evidence, canonical IDs, financial formulas, account balances, Rules policy, PIN roles and rollback material are unchanged.
