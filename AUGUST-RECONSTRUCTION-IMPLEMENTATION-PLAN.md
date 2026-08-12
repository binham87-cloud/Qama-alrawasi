# Controlled August Reconstruction — Implementation Plan

Build: `qama-phase3c-canonical-events-2026-08-11.5-reconstruction`

## Authority boundary

- Legacy August remains immutable evidence. It is never converted into collection, deposit, custody, expense, or ledger events by this workflow.
- A reconstruction plan begins as `DRAFT`; its month authority is `STAGED` and not active.
- Every reconstructed financial origin command must name the plan and an evidence/source reference. The real effective date must fall in the reconstruction month.
- Canonical reconstruction becomes authoritative only after a completeness audit and a separately authorized activation.
- When the month authority is active, Legacy opening projection for that month is suppressed (`evidence_only_zero`). An active Legacy opening is an activation blocker.

## Structural data retained

Units, verified tenancies/cycles, contractual obligations, due dates, users, roles, and PIN identities may be copied from independently authoritative structural records after snapshot and review. These records establish obligations only; they do not prove payment.

## Financial data not carried forward

Legacy statuses, mutable paid fields, aggregate totals, deposits, expenses, handovers, or balances are not imported as canonical events merely to reproduce an old report. Legacy records remain evidence. Actual collections, methods, deposits, expenses, custody handovers, refunds, and corrections are re-entered through canonical commands.

## Employee workflow

1. An authorized manager stages the reconstruction plan using hashes of the immutable Legacy snapshot and structural source.
2. The UI automatically shows controlled reconstruction mode for the staged month.
3. The employee selects the verified unit/tenant/cycle, enters the actual amount, method, original effective date, and source reference.
4. Cash creates one collection and one cash lot. Bank collection remains pending until manager approval.
5. Deposits allocate actual eligible cash lots; handovers allocate actual custody lots; expenses use the normal request path.
6. The UI never asks for or accepts KPI totals. Target, Collected, Deposited, Holding, arrears, partial, Income, Expenses, Net, balances, reserve transfers, and Bank Installments remain projections.

## Manager workflow

The manager reviews bank payments, deposits, expenses, and other normally controlled events using the same approval commands as forward operations. Reconstruction does not bypass approval. Rejections and reversals preserve history.

## Completion gate

Activation is blocked for pending bank/deposit/expense approvals, unconfirmed handovers, unresolved allocations/overpayments, duplicate evidence references, invalid custody lots, missing method/date, month mismatch, active Legacy opening projection, ledger replay mismatch, or missing obligations. Obligations without collection information are explicitly warned for review.

## Rollback and staged cutover

Before activation, cancel the draft plan; Legacy remains authoritative and no reconstructed record is projected as active month truth. Event records remain auditable and are not deleted. Production sequence, only after separate approval: freeze writes; capture/hash Legacy; preserve immutable snapshot; import reviewed structural records; deploy reviewed Functions/Rules/indexes/Hosting; stage plan; reconstruct and approve events; run audit/replay; owner review; atomically activate month authority; verify first forward transaction. Any invariant mismatch stops activation. After activation, use maintenance mode and compensating events—never delete financial history or fall back to simultaneous Legacy projection.

No production step was executed while creating this plan.
