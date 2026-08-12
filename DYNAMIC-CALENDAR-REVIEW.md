# Dynamic Calendar Review

- Removed the fixed runtime assignment `const CY = 2026`.
- Operational year derives from the current date and record/month keys.
- Month keys remain generic `YYYY_M` values and tests cover 2038, 2042 and 2044.
- April 2026 is represented only by `HISTORICAL_DATA_START` metadata describing the start of available Legacy evidence. It limits backward evidence navigation, not future operation.
- Removed the hard-coded 30 June 2026 / AED 179,294 installment display. Bank Installment reporting now derives from canonical events.
- Runtime scans found no August identifier, fixed obligation count or fixed 2026 operational calculation in Functions or the canonical UI path.

Future months and years require data entry only, not source changes.
