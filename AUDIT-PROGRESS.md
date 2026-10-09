# Audit implementation checkpoint

Updated: 2026-10-10 (Asia/Kolkata)

**Draft, not a release or merge recommendation.** Atlas integrity and the first reliability wave are committed and covered by passing Windows CI. Wider audit remediation and native-game acceptance remain incomplete.

## Repository and delivery boundary

- Repository and PR target: `GODOSTROYER/cities2-agent-bridge:main`.
- Pull request: https://github.com/GODOSTROYER/cities2-agent-bridge/pull/1
- Head branch: `codex/audit-hardening-2026-10-10`.
- Audited baseline: `8c78da5e1ff4f160a032b4bdeb1d7f112af4ff64`, community 0.5.0.
- Latest implementation commit covered by the evidence below: `ca9450ff3a2ff419e7f6721b6430d5db881e4e49`. Subsequent documentation checkpoints do not replace the exact source identity of this test run.
- Keep both draft and eventual final review in this fork. Do not open an upstream PR, merge, rewrite history, or publish a release as part of this checkpoint.

## Changes actually committed

### Atlas integrity and observation quality

`atlas/export.mjs` and `tests/audit-atlas.test.mjs`:

- Reject malformed building/road identities; validate district keys against numeric identities and preserve nonentity categories.
- Validate page/envelope shapes and reject envelope city sessions that disagree with the enclosed snapshot.
- Allowlist snapshot metadata so it cannot overwrite validated layers or change the output prototype.
- Count identified schools even when capacity is unavailable; preserve unknown metrics separately from known zero.
- Report known capacity/enrollment subtotals and unknown-site counts in JSON, Markdown and CSV, including education-level uncertainty.
- Add 38 focused regressions. The original 15 atlas tests also pass with these changes.

### Mailbox fairness, bounded recovery and replay protection

`src/Mailbox.cs`, `tests/MailboxFairnessTests.cs`:

- Preserve scan position across bounded passes: at most 64 scanned entries and four new dispatches per pump.
- Quarantine malformed filenames; defer locked inputs without consuming request IDs or starving readable requests.
- Retain undelivered responses even if their input files disappear. Round-robin retries prevent earlier locked outputs from starving later deliverable results.
- Preserve request-ID tombstones for 120 monotonic seconds independently of response-file retention. Replays in that horizon return `request_already_processed`, not a second dispatch.
- Apply backpressure at 64 pending outputs or 4096 unexpired tombstones instead of discarding protected outcomes.
- Bound input reads to 16 KiB, validate UTF-8/JSON depth/trailing content and reject nonobject arguments.
- Expose the originating request ID only during dispatch and dispose the retained directory enumerator on shutdown.

The horizon is not a permanent or cross-crash exactly-once guarantee. Request/response/quarantine disk retention and a durable recovery API remain separate work.

### Operation identity and outcome semantics

`src/OperationRegistry.cs`, wired through `ConstructionAccess`, `Mod`, road/zone/object/demolition/district tools, tile purchases, saves and simulation:

- Capture bridge session, city session and request ID at acquisition. Status rejects stale origins; batch children retain the initiating batch request ID.
- Distinguish application requested, unverified effects and adapter-verified readback. Submitted/unverified work cannot be marked complete.
- Preserve terminal outcomes as `not_submitted`, `uncertain`, `verified` or `partial`; submitted failures prohibit blind replay.
- Preserve verified district identity/polygon before naming, so a later naming error becomes partial success rather than apparent non-application.
- Guard terminal records from late completion/stop overwrites or accidental release of a newer operation.
- Bound history to 1024 records without silently pruning unresolved submitted work; unresolved saturation refuses new operations.

**Limits:** the adapters still use their existing native readback predicates. These result fields do not prove complete geometry/collateral correctness, accurate relocation transforms, downstream service effects, or that the native naming bug is repaired. Explicit reconciliation/archival and initialization exception safety remain pending.

### Scoped simulation controls and mandatory maintenance

`src/SimulationArguments.cs`, `SimulationControl.cs`, `BridgeTick.cs`, `Workflow.cs`, `NetworkCommands.cs`, `Mod.cs`, `advance.ps1`:

- Validate all supplied simulation bounds and guard types before observations/acquisition/unpausing. Preserve integer precision; reject non-finite numeric values and string-like booleans.
- Require the original operation ID for routine simulation cancellation. Cancelling completed A cannot stop newer B or manual simulation.
- Validate polling IDs. A lost start response does not trigger unscoped cancellation or automatic replay. Emergency STOP remains global.
- Run STOP, simulation watchdogs, save reconciliation and tile/batch deadline cleanup independently of transport publication.
- Keep new tile application and batch dispatch behind healthy transport. Use monotonic scheduling and tile/batch deadlines.
- Advertise scoped cancellation and request replay horizon through capabilities.

Remaining placement-tool and plan/client UTC deadlines, batch cancellation scoping, request-to-operation recovery and apply-time reserve enforcement are not claimed fixed here.

### Reproducible offline validation

- Add Windows `Offline bridge checks` CI with read-only permissions and pinned actions; no installation or release step.
- Remove the game-install requirement for helper tests via a pinned Newtonsoft.Json 13.0.3 fallback. Explicit `GamePath` still selects the installed JSON assembly for MailboxTests.
- Link actual production helpers into the new reliability test executable; isolate each project's build outputs.
- Repair the real PowerShell fixture's hardcoded output-relative path and copy the client to a temporary directory so developer journals cannot be touched.
- Add scoped-client regressions and C# 9 syntax checking. Update the package source allowlist for new helpers/tests.

## Validation actually executed

Successful PR CI: https://github.com/GODOSTROYER/cities2-agent-bridge/actions/runs/37989285474

- Head under test: `ca9450ff3a2ff419e7f6721b6430d5db881e4e49`.
- PR merge checkout: `8d8abcee90ddbff27c41871cf86b5bacb6c2178a`, against the unchanged audited base.
- Job: `114019029297`, completed successfully; every validation step passed.
- Runtime: Windows Server 2025, .NET SDK 10.0.401, PowerShell 7.6.6, Node.js 22.23.3.
- Log timestamps: 2026-10-09 UTC, corresponding to 2026-10-10 in Asia/Kolkata.

| Suite | Executed result |
| --- | --- |
| Existing C# helpers, Windows locking and real PowerShell mailbox checks | 184 checks passed: 11 mailbox, 22 simulation/geometry, 12 pagination, 21 census/assignment, 36 district geometry/preview, 25 terrain, 24 object placement, 23 Windows recovery, 10 real client checks |
| New reliability executable | 87 checks passed: 15 mailbox, 13 maintenance, 19 operation registry, 40 simulation arguments |
| Existing PowerShell client/export script | Four client scenarios and two map-export checks passed |
| Scoped simulation helper | Six scenarios passed: success, rejected start, lost start response, missing ID, poll failure, wrong poll ID |
| Journal regressions | Both existing groups passed, including visible-only extraction and mock bridge delivery preservation |
| Original plus audit atlas tests | 53 passed, 0 failed, 0 skipped; includes real PowerShell export through an isolated synthetic mailbox |
| Native source syntax | 26 source files parsed with C# 9 grammar; 0 syntax errors |

These are check/assertion counts and script scenarios, not hundreds of live-game scenarios. Earlier CI failures exposed a read-lock regression and a test path assumption; both were repaired before the successful run above. No failing test was removed to obtain this result.

**Not validated:** native mod API/type compilation against game assemblies, the exact rebuilt DLL in Cities II, native persistence/interruption scenarios, browser viewer behavior, packaging/installer acceptance for this branch, or large-city frame-time performance. The syntax check is not a substitute for native compilation.

No live game was controlled. No game assemblies, credentials, private saves, screenshots or gameplay journals were included. CI archived the exact public source under `source-checkpoint-37989285474` with seven-day retention; Git commits remain the durable source record.

## Remaining implementation and acceptance work

| Workstream | Required next behavior and evidence |
| --- | --- |
| Shared command preflight | Use the same normalized validators in plans, batches and direct execution; cover road budgets, building alternatives and prohibited simulation-speed steps before any batch action applies. |
| Road/upgrade/demolition effect guards | Validate every affected root and legitimate owned dependencies. Reject unrelated collateral effects; verify requested network geometry and upgrade target. Requires native fixtures and runtime evidence. |
| Relocation transform verification | Replace the existing 16-metre position-only predicate with position/quaternion checks, requested/snapped/observed transforms, quaternion-sign equivalence and explicit no-op handling. |
| Native lifecycle robustness | Make operation acquisition exception-safe; ensure stale tools cannot apply to new worlds; complete save/tile cleanup and disposal verification. |
| District naming | Repair the actual native naming-notification failure and test persistence/readback. Partial-success reporting is implemented, not the underlying naming repair. |
| Spatial performance | Snapshot footprints once, index broad-phase overlaps, compare with exhaustive results and measure allocations/game-thread cost. Make expensive captures bounded/cancellable. |
| Site and curve geometry | Normalize horizontal tangents; handle elevated road and terrain height deliberately; validate actual curve extent rather than endpoint distance alone. |
| Collection completeness | Stable network pagination, diagnostic totals, BFS budget exhaustion as unknown, and consistent snapshot/session handling. |
| Viewer data quality | Show invalid/unknown water distinctly from dry land and completeness for every layer; add browser regression evidence. |
| Timing, reserves and journaling | Convert remaining UTC deadlines, recheck reserves at native spending boundaries and move journal rendering off command delivery. |
| Long-session recovery | Explicit request-to-operation recovery/reconciliation, unresolved-record archival, safe disk-retention policy and concurrent snapshot cache behavior. |
| Native and package acceptance | Compile against authorized compatible game assemblies; test the exact DLL on a disposable city, including interruption, save/reload and negative placement cases; run installer/package tests. |
| Release documentation and licensing | Reconcile all historical version/capability/install text before releasing; no change to licensing without the maintainer's decision. |

MCP, multi-planner orchestration, new transit/routing controls and the proposed dashboard remain future additions; none is claimed implemented by this reliability checkpoint.

## Resume procedure

1. Fetch this fork and branch. Inspect current head and local changes; preserve newer work. Do not reset to the baseline or to an earlier checkpoint.
2. Use committed source, this document and the PR diff as truth. Earlier lost workspace edits are not evidence; the reliability files above have now been reconstructed and committed.
3. Continue with focused commits and regressions on the same fork-only branch. Keep the PR in draft while implementation/native acceptance is incomplete.
4. Update test evidence with exact source/DLL identities. Do not describe syntax/helper passes as game compatibility.
5. Final review remains in this fork; nothing in this document authorizes merge, release or gameplay.
