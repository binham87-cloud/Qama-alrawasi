# Test report

Command: `npm test` — no emulator, no network, no install. Runtime ~2 seconds.

```
==== DOMAIN: 25 PASS / 0 FAIL ====
==== INTEGRATION+SECURITY+CONCURRENCY: 31 PASS / 0 FAIL ====
==== SCENARIO: 4 PASS / 0 FAIL ====
                                    TOTAL 60 PASS / 0 FAIL
```

## How each suite is classified

| Suite | Class | What it actually exercises |
|---|---|---|
| `tests/domain/finance.test.mjs` | **DOMAIN** | the pure financial module directly |
| `tests/integration/system.test.mjs` | **COMMAND + IN-MEMORY REPOSITORY** | the real `executeCommand`, real schemas, real authorization, against a repository double that models transaction read-set conflicts |
| `tests/integration/scenario.test.mjs` | **COMMAND + READ MODEL** | seeds a building through real commands, then renders it through the real read model |

The repository double is **not** the Firebase emulator. It implements the same facade and
aborts a transaction whose read set changed before commit, which is what makes the
concurrency tests meaningful — but Firestore's own transaction, index and Rules behaviour is
not exercised.

## Mandatory scenarios

| Scenario | Where | Result |
|---|---|---|
| M1 the 9,000 / 9,200 defect | domain + command | PASS — `status:"collected"` rejected as `UNKNOWN_FIELD`, no partial effect |
| M2 two collectors, separate custody | domain + command | PASS — 5,000 / 4,000 stay attributed; deposit approval moves only Yahia's |
| M3 move-out preserves history | domain + command | PASS — receipt and period report unchanged after close + vacate |
| M4 partial payments stay separate | domain | PASS — two receipts, no collapsed total |
| M5 deposit lifecycle | command | PASS — pending inert, approval once, replay once |
| M6 bank workflow (D1) | domain + command | PASS — pending inert; approval adds Collected + Deposited, never Holding |
| M7 reversal | command | PASS — paid and custody reduced, original preserved and linked, second reversal refused |

## Invariants 1–14

All asserted. Notable ones: status can never read `collected` while `Paid < Due` (checked
across a range of paid values); occupancy changes move no money; per-employee holding sums to
total holding; the same `operationId` produces one effect; a mismatched payload on a reused
`operationId` is refused rather than silently replayed.

## Concurrency

| Case | Result |
|---|---|
| J1 two collectors race for the last 200 | PASS — one aborts, paid lands exactly on the obligation, remaining never negative |
| J2 two owners approve the same deposit | PASS — custody reduced once, deposited once |
| J3 deposit approval racing a new collection | PASS — invariants hold, custody never negative |

## Defects found and fixed during this build

1. **Float drift in the numeric money path.** `parseAedToFils(9200.005)` went through
   `value * 100` in binary floating point. Fixed by routing numbers through fixed-precision
   decimal first. The test that caught it had a naive expectation of its own, which is noted
   in the file rather than quietly deleted.

## NOT RUN — requires an emulator or a browser

None of the following were executed. They are listed as work, not as passes.

| Gate | Why not | How to run |
|---|---|---|
| Firestore Rules | needs the emulator; no network to install `firebase-tools` | `npm run test:rules` after `npm install -g firebase-tools` |
| Firestore transactions against the real database | needs the emulator | `npm run emulators` then re-point the integration suite at the real repository |
| Callable Functions end-to-end | needs the emulator | `npm run emulators`, then use the app |
| PIN login through the real Auth emulator | needs the emulator | as above |
| Browser / mobile UI | no browser in the build environment | open `http://127.0.0.1:5000` on a phone |

The UI has **not** been executed. Its logic is small and deliberately free of financial
arithmetic, but no button in this system has been clicked. That is the single largest
untested surface and the acceptance checklist starts there.
