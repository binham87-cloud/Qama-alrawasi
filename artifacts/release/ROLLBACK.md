# R2 rollback procedure — prepare only

## Do not execute in the R2 session.

If R2 hosting/functions/rules were deployed (they were not in this session) and must be undone:

1. Stop further writes (announce freeze).
2. Redeploy the previous known-good bundle:
   - git commit `bc34d80` / BUILD `qama-unified-final-2026-08-14.5`
   - `firebase deploy --only firestore:rules,functions,hosting --project qama-alrawasi`
3. Do not restore Firestore by overwriting live months unless an export from immediately before the failed deploy exists.
4. PIN authPins must not be bulk-rewritten.
5. Confirm BUILD_ID in the browser matches the rolled-back meta tag.
6. Re-run PIN login + one financial card read-only check.

R2 introduced no production migration write path. Rolling back code does not require reversing a data migration that was never executed.
