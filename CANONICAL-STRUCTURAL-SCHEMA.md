# Canonical Structural Schema

All IDs are stable opaque canonical IDs. Names are descriptive and never financial keys. Every lifecycle document carries status, origin, creator/updater, timestamps, version and schema version.

| Collection | Purpose | Principal references |
|---|---|---|
| `properties` | Property/building registry | stable property ID |
| `units` | Units inside a property | `propertyId` |
| `rentableSpaces` | Full units, partitions, rooms or other rentable spaces | `propertyId`, `unitId` |
| `tenants` | Current and historical tenant identity/contact metadata | stable tenant ID |
| `tenancies` | Time-bounded tenant-to-space relationship | property, unit, space and tenant IDs; start/end dates |
| `rentalCycles` | Sole canonical rental obligation source | property, unit, space, tenant and tenancy IDs; amount, due date and reporting month |
| `structuralOperations` | Idempotency result for structural commands | operation ID, actor, command and payload hash |
| `auditEvents` | Immutable structural and financial lineage | operation, actor, before/after state |

Inactive/ended records remain addressable so historical financial events retain their original references. Deactivation never deletes lineage.

Reconstruction and normal records use the same collections and fields. `origin` is provenance only. A reconstruction plan must link each ready obligation to active canonical entities before `rentalCycles` materialization; the server revalidates the full hierarchy at materialization time.
