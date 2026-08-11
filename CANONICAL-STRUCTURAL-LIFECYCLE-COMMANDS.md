# Canonical Structural Lifecycle and Commands

## Properties, units and spaces

- `createProperty`, `updateProperty`, `setPropertyActive`
- `createUnit`, `updateUnit`, `setUnitActive`
- `createRentableSpace`, `updateRentableSpace`, `setRentableSpaceActive`

Creation proves the parent exists and is active. Deactivation is rejected while an active tenancy would be orphaned. Descriptive updates do not alter financial truth.

## Tenants and tenancies

- `createTenant`, `updateTenant`, `setTenantActive`
- `createTenancy`, `endTenancy`, `replaceTenancyTenant`

Only one active tenancy may occupy a rentable space. Replacement ends the old tenancy and creates a new stable tenancy record; it never rewrites the former tenant's identity or financial history.

## Rental cycles

- `createRentalCycle`
- `renewRentalCycle`
- `correctRentalCycle`
- `endRentalCycle`
- `cancelRentalCycle`

Creation/renewal validates the entire canonical hierarchy, tenancy ownership, dates, amount and conflicting cycle scope. An unsettled input mistake can be corrected with a required reason. Settled meaning is not silently rewritten: later terms use a new/renewed cycle or an explicit approved financial adjustment. Cancellation is rejected when settlement exists; expiry/end preserves the record.

## Reconstruction linkage

- `linkReconstructionObligationStructure` attaches a reviewed obligation to canonical property, unit, space, tenant and tenancy IDs.
- The repository proves every referenced document is active and mutually consistent.
- `materializeReconstructionCycles` revalidates those references and creates the same `rentalCycles` schema with `origin: reconstruction`.
- Confirmed but unlinked obligations remain blocked.

Every command is transactional, idempotent by operation ID and payload hash, and emits an audit event containing actor, time and before/after state.
