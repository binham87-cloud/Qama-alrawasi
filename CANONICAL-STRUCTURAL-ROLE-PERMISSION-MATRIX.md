# Canonical Structural Role / Permission Matrix

| Capability | Owner | Manager | Employee | Direct client write |
|---|---:|---:|---:|---:|
| Read canonical structure | Yes | Yes | Yes | Read only under Rules |
| Create/edit/deactivate property, unit or space | Yes | Yes | No | Denied |
| Create/edit/archive tenant | Yes | Yes | No | Denied |
| Start/end/replace tenancy | Yes | Yes | No | Denied |
| Create/renew/correct/end/cancel cycle | Yes | Yes | No | Denied |
| Link reconstruction obligation to canonical structure | Yes | Yes | No | Denied |
| Confirm reconstruction identity/due date | Yes | Yes | Authorized active employee | Via existing server command only |
| Edit calculated KPIs | No | No | No | Denied |

Normal structural administration requires `CANONICAL_ACTIVE`. Reconstruction-origin structural creation requires `RECONSTRUCTION_ALLOWED`, a DRAFT reconstruction plan, manager role, `origin: reconstruction`, and the plan ID. Missing or malformed gates fail closed.
