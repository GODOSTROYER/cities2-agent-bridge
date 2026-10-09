# Audit implementation checkpoint

Date: 2026-10-10 (Asia/Kolkata)

This is an **incomplete implementation checkpoint**, not a release, merge recommendation, or claim that all audit findings are fixed.

## Repository and delivery boundary

- Working repository and PR target: `GODOSTROYER/cities2-agent-bridge`.
- Pull request: https://github.com/GODOSTROYER/cities2-agent-bridge/pull/1
- Head branch: `codex/audit-hardening-2026-10-10`.
- Base branch: `main`.
- Audited baseline: `8c78da5e1ff4f160a032b4bdeb1d7f112af4ff64`, community 0.5.0.
- First implementation commit: `a0c3d317d0a1abf536dda3d68a1256c5d7bb2919`.
- Keep both the draft and eventual final review in this fork. Do not open an upstream PR, merge, rewrite history, or publish a release as part of this checkpoint.

## Changes actually committed

### Atlas integrity and observation quality

Implemented in `atlas/export.mjs`, with regression coverage in `tests/audit-atlas.test.mjs`:

- [x] Reject malformed building and road identities, including missing, nonnumeric, fractional, negative, and unsafe integer values.
- [x] Validate district identity keys and their consistency with numeric entity identities. Preserve the nonentity `unassigned` and `unlocated` categories.
- [x] Validate page and response-envelope object shapes. Reject response city sessions that disagree with the enclosed snapshot.
- [x] Copy only allowlisted snapshot metadata. Untrusted page fields cannot overwrite validated layer arrays or the result object's prototype/constructor.
- [x] Count an identified school even when its capacity component is unavailable.
- [x] Distinguish unknown capacity/enrollment from known zero. Expose known subtotals and counts of sites with unavailable metrics; complete aggregate totals become null when information is incomplete.
- [x] Carry these distinctions into report and CSV output, including incomplete education-level totals when a school's level is unknown.
- [x] Add 38 focused regression tests for these behaviors and unchanged valid inventory/export behavior.

No native C# implementation changes, PowerShell changes, or compiled game binary are committed in this checkpoint. Earlier uncommitted native edits were not retained after a workspace reset; they must be reconstructed and validated rather than represented as completed fixes.

## Validation evidence and limits

Executed against the atlas changes before the first checkpoint commit:

```text
node --test tests/audit-atlas.test.mjs
Node.js: 22.16.0
Environment: Linux
tests: 38
pass: 38
fail: 0
skipped: 0
```

This is **only the new focused regression suite**. It does not establish a pass for the complete original suite or native game behavior. Historical test counts from the baseline audit must not be reused as validation of these changes.

Still required:

- [ ] Run the complete original atlas suite, including its real PowerShell client against an isolated synthetic mailbox.
- [ ] Run existing client and journal tests after any PowerShell modifications.
- [ ] Compile and run the C# helper tests with the actual new helpers linked into the test project.
- [ ] Run real Windows file-sharing/atomic-replacement recovery tests.
- [ ] Compile the native mod against the user's compatible installed game assemblies.
- [ ] Test the exact newly built DLL in a disposable city, including interruption and save/reload scenarios.
- [ ] Run browser viewer regression tests when viewer behavior changes.
- [ ] Rebuild and validate packaging before claiming a release is ready. Do not reuse the old release DLL as evidence for new source.

No live game was controlled or modified by this checkpoint. No game assemblies, credentials, private saves, screenshots, or gameplay journals are included.

## Remaining implementation work

The following items remain pending. A design or partial local implementation is not a completed fix.

| Workstream | Required behavior and acceptance evidence |
| --- | --- |
| Operation identity and city isolation | Store originating bridge session, city session, and request ID on every operation. Reject stale-city status/cancellation. Test an operation from city A after loading city B. |
| Operation outcomes and recovery | Separate application request, observed effects, and verification. Preserve original operation identity and known effects after partial failure; explicitly prohibit blind replay of an uncertain mutation. |
| Bounded history and deduplication | Bound retained results without silently discarding unresolved current-city effects. Define a replay/deduplication horizon independent of response-file retention and test deletion/replay behavior. |
| Mailbox fairness | Validate/quarantine malformed filenames without letting them consume every dispatch slot. Test at least four malformed entries ahead of a valid request, contention, cleanup, and bounded scanning. |
| Mandatory maintenance during transport faults | Run STOP, simulation deadlines, completed-task reconciliation, cancellation, and cleanup independently of heartbeat/response publication. Do not accidentally move new batch dispatch ahead of those checks. Update Windows recovery expectations. |
| Scoped simulation cancellation | Require the original operation/session for routine cancellation. A delayed cleanup by client A must never cancel client B's new operation. Keep emergency STOP explicitly global. |
| Simulation argument validation | Validate finite numeric limits and guard types before unpausing. Test malformed cash floors, boolean flags, frame counts, and deadlines with no simulation side effects. |
| Shared preflight and execution validation | Normalize command arguments in one place for plans, batches, and direct execution. Cover road budgets, alternative building candidates, and prohibited simulation-speed transitions before any batch step applies. |
| Native preview effect guards | Validate all affected roots for roads, upgrades, and demolition, not just native allow-apply status or presence of the requested target. Permit legitimate owned dependencies while rejecting unrelated root changes. Requires native fixtures. |
| Transform verification | Compare observed position and quaternion with the verified snapped target using documented tolerances. Test unchanged short moves, rotation-only requests, quaternion sign equivalence, and genuine no-ops. |
| Native initialization and terminal-state safety | Make operation acquisition exception-safe. Cleanup and late callbacks must not overwrite a terminal operation or mutate a newly loaded city. |
| District naming and partial success | Preserve a verified district identity/boundary if naming fails. Reconcile the original operation and test name readback without duplicating geometry. |
| Spatial query performance | Capture building footprints once per observation and use a broad-phase spatial index before exact overlap tests. Compare results with exhaustive queries; benchmark allocations and game-thread time. |
| Site and curve geometry | Normalize horizontal road tangents, handle elevated-road/terrain candidates deliberately, and validate actual curve extent rather than endpoint distance alone. |
| Collection completeness | Add stable network pagination and honest diagnostics totals. BFS resource exhaustion must report unknown, not disconnected. Preserve session/snapshot consistency across pages. |
| Viewer data quality | Display unknown/invalid water samples distinctly from dry land and show truncation/completeness for every relevant layer. Add browser tests. |
| Timing, reserves, and long-session operation | Use monotonic elapsed time for scheduling/deadlines. Recheck reserve constraints at the native spending boundary. Separate journal rendering from command delivery and address concurrent snapshot captures. |
| CI, documentation, and compatibility | Add game-independent checks, a separate native acceptance lane, consistent version/capability documentation, and exact-DLL validation records. Licensing decisions remain with the maintainer. |

## Resume procedure

1. Fetch the current fork and this branch. Inspect the current head and working tree; preserve newer commits and local work. Do not reset to the audited baseline.
2. Treat the committed files and the PR diff as the implementation source of truth. Do not assume an earlier temporary workspace or an uncommitted draft is still available.
3. Make focused commits on the same branch, with regression tests for each repaired behavior. Keep mutations constrained to this fork.
4. Update this document and the PR description with what is actually committed, tested, skipped, or blocked. Attach native evidence to the exact DLL and source commit tested.
5. Keep the PR in draft while the wider implementation or required validation is incomplete. The eventual final PR/review remains fork-only.
