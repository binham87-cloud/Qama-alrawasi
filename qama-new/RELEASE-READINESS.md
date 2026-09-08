# Release readiness

**Status: ready for your acceptance testing on the emulator. Not ready for production.**

## Done

- Financial domain, complete and tested (25 tests)
- Command layer with server-side authorization, strict schemas, idempotency, transactions,
  audit (31 tests including 9 hostile-client and 3 concurrency)
- Read model shared by every screen
- Cloud Functions entry points: `login`, `command`, `read`
- Firestore Rules: clients read by role, clients write nothing
- Firestore indexes for every query the code issues
- Mobile Arabic RTL client covering all required screens
- Emulator configuration and a seed that runs through real commands
- Documentation

## Required external configuration — you must do these

1. **Create a NEW Firebase project.** Do not reuse `qama-alrawasi`. The new system must not
   share a database, Hosting site or Functions namespace with the legacy one.
2. **Upgrade the new project to Blaze.** Cloud Functions require it. Without Functions there
   is no trusted server, and the entire security model collapses back to the browser — the
   weakness this rebuild exists to remove.
3. **Fill `src/frontend/config.mjs`** with the new project's web config and set
   `USE_EMULATOR = false` for a real deployment.
4. **Deploy** `firebase deploy --only firestore:rules,firestore:indexes,functions,hosting`.
5. **Create real users** with real PINs. Delete the demo users. The seed PINs are published
   in this repository and are for the emulator only.
6. **Generate obligations** for the first live month from Settings.

## Acceptance checklist — on your phone, before any real money

- [ ] Log in as each of the three users; each sees only what they should
- [ ] Record a partial cash collection; status becomes جزئي and the amount field stays usable
- [ ] Type an amount without the keyboard closing
- [ ] Tap "استلام المتبقي" twice quickly; exactly one receipt appears
- [ ] Try to collect more than the remaining; a clear refusal, no receipt
- [ ] Submit a bank transfer; nothing moves until you approve it
- [ ] Approve it; Collected and Deposited both rise, custody does not
- [ ] Submit a deposit as an employee; custody does not drop until you approve
- [ ] Approve it; custody drops exactly once
- [ ] Reverse a receipt; the original stays visible, marked
- [ ] Close a rental and vacate the space; last month's report is unchanged
- [ ] Two people collect at the same time on two phones; totals stay correct
- [ ] Reload mid-entry; no duplicate money

## Known limitations

- Partial reversal is not supported; reverse in full and re-record.
- Overpayment is refused outright (D2). If tenants genuinely pay in advance, that needs a
  credit ledger — a deliberate future decision, not an oversight.
- Rules and the emulator have not been executed here (see TEST-REPORT.md).
- No data migration exists, by design.
