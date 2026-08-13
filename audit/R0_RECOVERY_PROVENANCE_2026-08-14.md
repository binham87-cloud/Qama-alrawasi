# R0 Recovery Provenance — Production `qama-unified-final-2026-08-13.6`

**Branch:** `recovery/qama-prod-2026-08-13.6`  
**Purpose:** Make the repository represent what Production is running, to the maximum **provable** extent. No behavioral fixes in R0.

---

## Classification legend

| Label | Meaning |
|---|---|
| **EXACTLY RECOVERED** | Byte source obtained from the deployed artifact itself |
| **PROVABLY IDENTICAL** | Local/repo bytes match a recovered deployed artifact (SHA-256) |
| **PARTIALLY RECOVERABLE** | Behavior/intent known from evidence, but exact file bytes for that runtime not obtained as a single frozen source |
| **NOT RECOVERABLE** | No exact deployed bytes found; must not invent |

---

## 1. Hosting UI

| Artifact | Status | SHA-256 | Provenance |
|---|---|---|---|
| Production `https://qama-alrawasi.web.app/` HTML | EXACTLY RECOVERED | `6711b9a7b26b9ec8db5b81c2ce0146be5e3209babebd377585a76ecbeccaa238` | HTTP GET 2026-08-13; Build ID `qama-unified-final-2026-08-13.6` |
| `index.html` (recovery branch) | PROVABLY IDENTICAL | same | Copied from verified fetch after SHA re-check |
| `public/index.html` (recovery branch) | PROVABLY IDENTICAL | same | Byte-identical to `index.html` |

---

## 2. Cloud Functions source packages (GCS, read-only)

Downloaded via Cloud Functions v2 API → `buildConfig.source.storageSource` (generation pinned).

| Function | updateTime (UTC) | ZIP SHA-256 | generation | Notes |
|---|---|---|---|---|
| **operationalCommand** | 2026-08-13T20:35:04Z | `33ab92035391ef3aa68ed8ced11041aab7863312e286226476770a5fe505eac5` | `1786653189018259` | **`.6` deploy** (Hosting+.6 opCmd only) |
| financialCommand | 2026-08-13T19:33:04Z | `b5e7e8e16a596033a0b480f4e50a9f41f8074921e0ee0a23a9701e4db48ead3a` | `1786649575346483` | `.5`-era package; still live |
| operationalReadModel | 2026-08-13T19:33:04Z | same as financialCommand ZIP | `1786649575278219` | same package bytes as `.5` |
| canonicalReadModel | 2026-08-13T19:33:00Z | same | `1786649515929875` | same |
| listPinUsers | 2026-08-13T19:33:04Z | same | `1786649575341621` | same |
| pinLogin | 2026-08-13T19:33:05Z | same | `1786649575350158` | same |
| structuralCommand | 2026-08-12T22:14:54Z | `5890a6589e74e88a4902d165e0c42e4f8adff9ccec93ee100dafe26347ce40bb` | `1786572885122723` | Older; preserved on purpose during `.5`/`.6` deploys |

**Diff between operationalCommand ZIP vs financialCommand ZIP:** only  
`domain/operational_commands.mjs`  
(`.6` opCmd: `b6cf418f08f83db4…` / 13882 bytes vs `.5`: `1512b23e6c448fad…` / 12229 bytes).

Evidence copies under: `audit/recovered_prod_functions_meta/`.

---

## 3. Files imported into recovery branch (exact)

Imported **entire** `operationalCommand` deploy package → `functions/` (exact bytes):

| Path | SHA-256 | Classification |
|---|---|---|
| `functions/domain/operational_commands.mjs` | `b6cf418f08f83db4fa370b09f428874ae0a3be63aaa94273da2122ff57a747b4` | EXACTLY RECOVERED (`.6` opCmd runtime) |
| `functions/domain/legacy_month_projection.mjs` | `a671dd779cb587ce8ba8f49e365d7b0fe8ed1d25b165cd3694ab10faee0b149f` | EXACTLY RECOVERED (present in `.5`/`.6` packages; was missing on `main`) |
| `functions/domain/command_processor.mjs` | `d4d66c49bca3dcba351e192d1e9dd455d1db57e5db68e8efcee6e1d398285117` | EXACTLY RECOVERED |
| `functions/domain/canonical_selectors.mjs` | `f615e4cbee1f330c9c119ea738d17d411cec6bc10eba5b65ecd27f70a1f8a39e` | EXACTLY RECOVERED |
| `functions/domain/entity_repositories.mjs` | `0ffb7103a5e0364927c951efac055123bb55a037764b396a647128ae9e7fca8d` | EXACTLY RECOVERED |
| `functions/canonical_read_model.mjs` | `9f59b9b0022c897ba283bad8ebc62b126389fea19b09edfe483a3644f44d40e5` | EXACTLY RECOVERED |
| `functions/financial_commands.mjs` | `aec39414123d5b4d3bcbb411756ef0128e2855706b3d4a9fd8dbfcf618125462` | EXACTLY RECOVERED |
| other files in package | (see import verification) | EXACTLY RECOVERED / already identical |

---

## 4. Production split-brain (documented gaps)

| Runtime | What it actually executes | Recovery branch representation |
|---|---|---|
| Hosting | `.6` HTML | Matched |
| `operationalCommand` | `.6` package (`domain/operational_commands.mjs` **new**) | Matched |
| `financialCommand` + read models + PIN | `.5` package (same tree except **old** `domain/operational_commands.mjs`) | Shared modules matched; **op-domain file in repo is `.6` version** — financialCommand’s *uploaded* copy of that file is unused by its entrypoint for collection, but bytes in its GCS zip differ |
| `structuralCommand` | 2026-08-12 package | **NOT overwritten** to that old tree; repo file matches `.5`/`.6` upload trees, **not** the live structuralCommand revision |

**NOT RECOVERABLE as a single mono-repo freeze:** one working tree cannot simultaneously equal every function’s GCS zip when they diverge. R0 prioritizes **Hosting `.6` + operationalCommand `.6` package**, and documents other runtimes.

---

## 5. What was searched and not used as “exact .6 source”

| Source | Result |
|---|---|---|
| Git `main` / tags | Only through `.3` (`b6e27a2`); `.4–.6` never committed |
| `archive/qama-v1-work-2026-08-14` | Same as `.3` + archive commit |
| stash `wip-before-rebuild` | Pre-canonical UI flag tweak only — not `.6` |
| `/tmp/tmp.qWhInSTqSP` | Snapshot of **`.3`** (HTML SHA `85cdcd7b…`) |
| Cursor transcripts | Contain StrReplace *intent* for `.6` op-domain — **PARTIALLY RECOVERABLE narrative only**; not labeled recovered source |
| Local deployment ZIPs | `.1` / `.2` only |

---

## 6. Explicitly not done in R0

No status/KPI/financial behavior edits beyond replacing files with recovered Production bytes. No deploy, push, migration, reconciliation, or data writes.
