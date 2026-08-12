# Command permission matrix

- `MAINTENANCE_LOCKED` and `STAGED_READ_ONLY`: every command in `financialCommand` and every `operationalCommand` write is denied. `canonicalReadModel`, `listPinUsers`, and `pinLogin` remain available.
- `RECONSTRUCTION_ALLOWED`: `createReconstructionPlan`/`cancelReconstructionPlan` are manager-only; `confirmReconstructionStructure` records actor, timestamp, item, confirmed value, source reference, and operation ID. All event commands and their normal approval/reversal commands require lineage to a DRAFT plan whose structural review is approved. Reserve Transfer and Bank Installment are denied unless genuinely linked to that reviewed plan. `activateReconstructionPlan` is denied.
- `ACTIVATION_REVIEW`: only `activateReconstructionPlan` can reach the domain layer. The full completeness/freeze/source/ledger audit remains mandatory. All other commands are denied.
- `CANONICAL_ACTIVE`: normal canonical command role rules apply. Reconstruction creation/cancellation/activation is denied. Direct Firestore writes remain denied.

The matrix covers collections, bank submissions/approvals, deposits, custody, handovers, expenses, refunds, corrections, reversals, reserve transfers, bank installments, month controls, reconstruction controls, and all other registered financial commands.
