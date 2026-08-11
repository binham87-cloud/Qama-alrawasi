# Legacy Structural Path Replacement

The owner-facing add-unit controls now call canonical property/unit/space/tenant/tenancy/cycle workflows. The former Legacy structural persistence boundary, `saveCurData`, always throws `LEGACY_STRUCTURAL_WRITE_DISABLED`.

This disables executable mutation through `registerCustomUnit`, `propagateNewUnit`, `propagateNewFullUnit`, `renewCycle`, departure/edit forms and equivalent helpers because all reached the same disabled persistence boundary. `createRentalCycle` was also removed from the financial callable so there is no second canonical cycle-creation API.

Legacy month documents, `status`, `paid_amount`, historical names, rendering adapters and evidence references remain readable. They are retained solely for historical display, reconciliation and rollback evidence; they cannot become forward structural or financial truth.

Static tests prove:

- no client query uses a competing `cycles` collection;
- `rentalCycles` is the only client cycle collection;
- root and Hosting HTML are byte-identical;
- Legacy mutation is disabled while historical reads remain;
- direct writes to protected canonical collections are rejected by Rules.
