# Progressive structural preparation — implementation delta

Build: `qama-phase3c-canonical-events-2026-08-11.7-progressive-structural-preparation`

Baseline: `.11.6-staging-lock`.

## Safe control model

The canonical control state remains `MAINTENANCE_LOCKED`. A separate, explicit, month-scoped `structuralPreparation` permit may allow only:

- `createReconstructionPlan` — owner/manager only;
- `confirmReconstructionStructure` — authenticated active employee/manager, for a DRAFT plan in the permitted month.

Missing, malformed, disabled, or wrong-month preparation permission denies both commands. Every financial command, activation command, operational write, and direct Firestore client write remains denied.

## Progressive obligation model

The staged plan contains immutable reviewed obligations with source lineage and contractual amount. Each obligation requires separate tenant/guest and due-date confirmations. A confirmation records the obligation, unit/partition, previous source value, confirmed value, confirmer, timestamp, source reference, confirmation basis, scope, operation ID, and audit event.

Financial eligibility is per obligation. An unconfirmed obligation is blocked even after a later `RECONSTRUCTION_ALLOWED` transition. Global activation remains blocked until every required confirmation and every other pre-activation invariant passes.

## UI

Locked UI continues to display maintenance mode. When the explicit preparation permit and DRAFT plan exist, it additionally shows per-obligation progress and only tenant/due-date confirmation actions. Contractual amounts and calculated KPIs are display-only.
