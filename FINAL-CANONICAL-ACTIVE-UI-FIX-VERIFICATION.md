# Final CANONICAL_ACTIVE UI Routing Verification

## Build

`qama-phase3c-canonical-events-2026-08-11.15-canonical-active-ui-routing`

## Root cause

The top-level UI boundary routed `RECONSTRUCTION_ALLOWED` to the canonical reconstruction shell, but did not route `CANONICAL_ACTIVE`. Active operation therefore continued into `getCurData()` and constructed the Legacy dashboard, unit cards, status fields and KPI paths before rendering.

## Implementation

- Added a top-level `CANONICAL_ACTIVE` routing boundary before `getCurData()`.
- Added a permanent, plan-independent canonical operational shell.
- Permanent Dashboard and Units use only the canonical read model, canonical structure, `rentalCycles`, and canonical projections.
- Reconstruction retains its separate reconstruction shell and staged-plan context.
- Canonical collection controls require an explicit canonical cycle ID.
- Added permanent canonical operation controls for collections, bank collection, deposits, expenses, custody, reserve transfers, bank installments, refunds and reversals.
- Added canonical structural administration, requests, reports/KPIs, and a separate read-only Legacy evidence tab.
- The Legacy evidence tab has no mutation or collection action.

## Verification

Executed under Node.js 22.23.2:

- Baseline: 242 passed, 0 failed.
- Canonical/static/UI: 216 passed, 0 failed.
- Firestore Rules: 29 passed, 0 failed.
- Functions integration: staging 13, financial 16, operational 8, structural 31; all passed.
- Concurrency/idempotency: 4 passed.
- Existing canonical browser journey: 8 passed.
- Employee reconstruction browser journey: 8 passed.
- CANONICAL_ACTIVE browser journey: 10 passed.
- Financial invariants: 30 passed.
- Opening state: 20 passed.
- Reconstruction: 13 passed.
- Staging lock: 6 passed.
- Structural preparation: 7 passed.
- Dynamic cycles: 13 passed.
- PIN Functions and size checks passed.
- Final chained exit: 0.

The active browser journey proves both an empty canonical workspace over populated Legacy data and a populated canonical workspace with one valid cycle. Legacy cards/status/paid amounts remain absent, the canonical collection action is cycle-bound, no reconstruction plan is required, the evidence view is read-only, and no financial event is created by rendering.

## Safety state

Local development and testing only. No Production deployment, gate change, activation, Production data entry, Legacy modification, `financialTruthVersion` change, migration, Bootstrap Apply, or GitHub operation occurred.
