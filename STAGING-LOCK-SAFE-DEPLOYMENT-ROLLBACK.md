# Safe deployment, backup and rollback prerequisites

No commands below were executed against Production.

Before any later deployment authorization:

1. Establish a documented write-freeze window and notify users.
2. Create a native Firestore managed export to a versioned, access-restricted Cloud Storage location, plus a separately hashed read-only logical inventory of every required collection.
3. Record export operation ID, bucket/object generations, timestamps, project/database IDs, document counts, IAM retention policy, and SHA-256 hashes for all locally hashable inventory/metadata files.
4. Verify the export completed successfully and perform a restore rehearsal into a separate non-Production project/database. A mere command start is not a backup.
5. Export/record current Functions, Rules, indexes, Hosting release/version, Auth user count (no PIN hashes or secrets), and current source fingerprints.
6. Require owner sign-off on backup verification because PITR is disabled.

Coordinated future deployment sequence:

1. Reconfirm snapshot hashes and freeze; abort on any drift.
2. Deploy Functions first. Missing `config/canonicalControl` means all canonical/operational writes remain locked while existing Legacy remains available.
3. Under separate Production-write authorization, create `config/canonicalControl` as `STAGED_READ_ONLY` only; verify the read model reports it.
4. Deploy indexes and wait until ready.
5. Deploy locked Hosting and verify PIN/read-only behavior.
6. Deploy Rules in the same freeze window, disabling direct Legacy financial writes only after the locked replacement UI and callable reads are verified.
7. Run the post-deployment/pre-reconstruction smoke test. Do not change the state or create financial events.
8. End the deployment gate and await separate authorization for reviewed reconstruction-plan creation and later `RECONSTRUCTION_ALLOWED`.

Rollback before reconstruction: keep/revert the control state to `MAINTENANCE_LOCKED`, restore the previous Hosting/Rules/Functions/index versions as approved, verify no canonical financial operation exists, and retain all Legacy evidence. Rollback must never delete audit evidence. Any unexpected write, failed PIN/read model, Rules mismatch, missing backup proof, source drift, or authority ambiguity aborts deployment.
