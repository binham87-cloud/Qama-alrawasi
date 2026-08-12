# Canonical staging/maintenance state machine

Build: `qama-phase3c-canonical-events-2026-08-11.6-staging-lock`

The trusted control document is `config/canonicalControl`. It is read inside every financial transaction and by the operational callable. Missing, malformed, versionless, or unknown configuration normalizes to `MAINTENANCE_LOCKED`. Firestore Rules deny every client write to the control document; no employee or ordinary manager UI exposes a state transition.

| State | Financial/operational writes | Read model/PIN | Reconstruction | Activation |
|---|---|---|---|---|
| `MAINTENANCE_LOCKED` | Denied | Allowed | Denied | Denied |
| `STAGED_READ_ONLY` | Denied | Allowed | Denied | Denied |
| `RECONSTRUCTION_ALLOWED` | Only events linked to one DRAFT, structurally APPROVED reconstruction plan; manager plan create/cancel and auditable structural confirmation | Allowed | Allowed subject to normal command roles, approvals, effective dates, source references, idempotency and duplicate prevention | Denied |
| `ACTIVATION_REVIEW` | All ordinary writes denied | Allowed | Denied | Only `activateReconstructionPlan`; domain audit must also pass |
| `CANONICAL_ACTIVE` | Normal canonical commands allowed; legacy operational patch only for its non-financial allowlist | Allowed | Reconstruction plan control denied | Already active; activation command denied |

Activation audit blockers include incomplete structural confirmation, missing owner pre-activation approval, unverified final write freeze, missing final source SHA-256, pending bank/deposit/expense/handover approvals, unresolved payments, duplicate evidence references, invalid custody, ledger mismatch, and any conflicting active Legacy opening projection.

Deployment never creates or changes the control document. Therefore deployment with no document remains locked. Changing this document is a separately authorized, audited administrative cutover action outside the employee UI.
