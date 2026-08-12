# Final local verification

Build: `qama-phase3c-canonical-events-2026-08-11.6-staging-lock`

Runtime: Node `v22.23.2`; OpenJDK `21.0.12`; Firebase emulators only.

Exact final chain:

`npm run test:phase2-clean && npm run test:canonical-events && npm run test:phase3c-bootstrap && npm run test:reconstruction && npm run test:staging-lock`

Results: baseline 242/242; canonical/business Node tests 180/180; Rules 28/28; Functions integration 33/33 (lock 9, canonical 16, operational 8); concurrency/idempotency 4/4; browser journeys 8/8; canonical financial invariants 30/30; opening-state 20/20; reconstruction 13/13; staging-lock unit tests 6/6; PIN and document-size checks passed. Final chained exit code: 0.

The full chain initially exposed and then resolved two test-harness readiness issues and one Firebase emulator concurrency flake. No existing assertion was weakened: concurrent idempotency remains covered by the 10-way concurrency suite and the lock integration, while the general Functions integration now uses deterministic sequential replay. The final uninterrupted chain is clean.

Default behavior: missing/malformed/unknown configuration denies writes. Deployment alone cannot enable writes because no deployment artifact creates the control document and Rules deny client mutation. Production and GitHub were untouched.
