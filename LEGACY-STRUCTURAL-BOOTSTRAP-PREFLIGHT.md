# Legacy Physical Structure Bootstrap — Preflight

Build: `qama-phase3c-canonical-events-2026-08-12.1-legacy-structural-bootstrap`

## Read-only Production evidence

- Project: `qama-alrawasi`
- Capture method: Firestore REST GET only
- Captured: `2026-08-11T20:32:55.858Z`
- Production documents: 629
- Production snapshot SHA-256: `bb8b3cb24a418a6b5674f648c054dd05b05cf5f0c654984ffc68abc4089dc24c`
- Structural source: `months/2026_7`
- Source update time: `2026-08-10T09:33:31.457918Z`
- Structural subset SHA-256: `bbe1eb5c7dbef8d55146d8c227909b291df0ed3257eee6b8ebaed84cee94e1a9`
- Canonical structural collections at capture: all empty

## Deterministic mapping

The current Legacy source can be mapped without structural conflict:

| Canonical collection | Proposed records | Source |
|---|---:|---|
| `properties` | 1 | Explicit QAMA business/property identity plus source provenance |
| `units` | 21 | 10 partitioned unit containers plus 11 full units |
| `rentableSpaces` | 94 | 83 partitions plus 11 full-unit rentable spaces |

Skipped items: 0. Structural conflicts: 0.

No tenant, tenancy or `rentalCycles` record is created by this bootstrap. Those require controlled confirmation of the real tenant and contractual facts.

## Excluded fields and records

The mapper has an explicit structural allowlist. It ignores `rent`, `paid_amount`, `status`, `partial`, collector/payment fields, rent type, dates, contract/cycle fields, electrical payment fields, and every Legacy transaction, deposit, expense, handover, installment, balance and KPI field.

Expected financial effect is exactly zero for collection events, deposits, expenses, ledger movements, custody movements, Bank Installments, Reserve Transfers and refunds. Account balances are not read or written by the command.

## Identity, provenance and idempotency

- IDs are deterministic SHA-256-derived IDs from the property/source path and Legacy structural identity.
- Each record contains its Legacy structural ID, exact `sourceReference`, structural record hash, bootstrap key and evidence classification.
- The authoritative source structure hash may be supplied as a precondition; a changed source fails closed.
- Existing exact records are left unchanged.
- An existing deterministic ID with different structural content aborts the transaction.
- Reusing the same operation ID is an idempotent replay; a new operation over the same unchanged source creates zero duplicate entities.
- Ambiguous source items are reported as conflicts and are not guessed.

## Execution and rollback boundary

The future Production command is owner/manager-only, requires `RECONSTRUCTION_ALLOWED`, the authoritative DRAFT plan and matching month scope, and runs atomically in one Firestore transaction. It writes only canonical physical structure, per-entity audit events and one structural operation record.

Before future execution, take a fresh source hash/fingerprint and recovery backup. Before any dependent tenancy/cycle exists, rollback may remove only the records named by that operation under a separately reviewed rollback authorization. After dependent canonical history exists, records must not be deleted; use deactivation/forward correction while preserving references.

No Production bootstrap was executed while producing this report.
