# Employee Canonical Workspace Fix

Build: `qama-phase3c-canonical-events-2026-08-11.13-employee-canonical-workspace`

## Root cause

The reconstruction workspace state was derived through `authorizedReconstructionStructuralContext()`, which intentionally rejects non-manager roles. Employees therefore received no reconstruction workspace context and the renderer fell back to the Legacy operational dashboard and Units view.

## Minimal correction

- Added a role-neutral, fail-closed `authorizedReconstructionWorkspaceContext()` for display/routing.
- It still requires the authoritative matching `STAGED`, non-activated month authority and exactly one matching `DRAFT` reconstruction plan.
- Manager-only structural administration continues to call `authorizedReconstructionStructuralContext()`, which retains the manager-role check.
- No server, Rules, financial, structural, KPI, Legacy, or data logic changed.

## Verification

- Focused workspace/structural bridge tests: 10 passed.
- Complete local regression chain: passed with final exit 0.
- Direct client Rules denials, roles, PIN, financial invariants, reconstruction, structural administration, concurrency, browser journeys, and dynamic-cycle tests remained clean.

