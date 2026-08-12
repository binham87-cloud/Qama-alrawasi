# Deployment and Rollback Procedure

This document is procedural only; this build was not deployed.

## Deployment gates

1. Owner reviews this exact ZIP, SHA-256 and manifest.
2. Capture a fresh Production fingerprint and verified backup; reconfirm restore rehearsal.
3. Confirm Production remains `.11.7`, `MAINTENANCE_LOCKED`, with unchanged Legacy August and zero unauthorized canonical financial events.
4. Verify manifest and run the complete Node 22 suite from the exact extracted archive.
5. Deploy Functions, Rules, indexes and Hosting only under separate explicit authorization, initially fail-closed.
6. Verify PIN roles, direct-write denial, structural gate denial, unchanged balances/ledger and unchanged Legacy evidence.
7. Before reconstruction, create/link canonical structure through audited commands only under the separately authorized reconstruction gate.
8. Do not activate canonical truth without a later pre-activation audit and owner authorization.

## Rollback / stop conditions

Stop and restore the prior locked application configuration if any manifest mismatch, unexpected Production fingerprint delta, role bypass, direct-write success, Legacy mutation, ledger/balance movement, KPI editability, invalid reference acceptance, duplicate lifecycle effect, fixed-list dependency, or projection mismatch occurs.

Before live canonical writes, rollback is the reviewed prior locked Functions/Rules/Hosting release. After any live canonical event, do not delete history or restore Legacy authority blindly; enter maintenance mode and use audited forward repair/export-replay procedures.
