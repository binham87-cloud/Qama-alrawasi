# Clean August Start — Implementation Delta

Build: `qama-phase3c-canonical-events-2026-08-12.3-clean-august-start`

This build adds one manager-only, server-authoritative and idempotent transition: `abandonReconstructionAndActivate`.

The transition requires an `ACTIVATION_REVIEW` gate, the expected build ID, a DRAFT reconstruction plan, a reason, an existing canonical physical structure, no canonical tenants or tenancies, and no canonical month-scoped cycles or financial events. It atomically:

- retires the selected plan as `ABANDONED` with `OWNER_CLEAN_START` provenance;
- activates a `CANONICAL_CLEAN_START` month authority with `legacyProjectionEffect: evidence_only_zero`;
- sets `CANONICAL_ACTIVE` and `financialTruthVersion: 3`;
- records one immutable audit event and one idempotency operation;
- creates no tenant, tenancy, cycle, financial event, ledger entry or balance movement.

Legacy records and reconstruction evidence are not modified. Historical exceptions are not fabricated. Existing canonical structure and balances are preserved.

