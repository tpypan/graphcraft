# Graphcraft

**Keep coding agents working as long as they are still making useful progress.**

Graphcraft is a local execution layer for long-running coding agents. It turns a repository task into a durable execution and governance graph, runs bounded workers through Codex or Claude Code, checks progress with repository evidence, survives interruption, and stops safely when a changed strategy is no longer productive.

> [!WARNING]
> Graphcraft v0.1 is an alpha. It supports local verification, atomic commits, normal non-force pushes, idempotent pull-request opening, token-free waiting for an exact pull request to reach required-check green, bounded review-first or actionable-CI repair pushes, journaled review replies and resolutions, and justified infrastructure or cancellation reruns. It does not merge or deploy.

## Install the alpha

Requirements: Git, Node.js 22+, and an authenticated, protocol-qualified Codex or Claude Code CLI.
The current exact profiles are Codex CLI 0.144.6 and Claude Code 2.1.212; other versions fail
closed until their structured output, streaming, usage, cancellation, and resume behavior is
qualified. `graphcraft doctor` reports the supported versions without invoking a model.
Remote `pushed`, `pr_open`, and `pr_green` finish lines additionally require an authenticated GitHub CLI (`gh`).

The public npm package is `@tpypan/graphcraft`; the unscoped `graphcraft` name belongs to an unrelated project. Install it globally with either package manager:

```bash
npm install --global @tpypan/graphcraft
graphcraft install --host codex
```

```bash
pnpm add --global @tpypan/graphcraft
graphcraft install --host claude
```

If the npm registry is unavailable, install the versioned package asset from the matching
workflow-verified GitHub release:

```bash
GRAPHCRAFT_VERSION=0.1.2
npm install --global "https://github.com/tpypan/graphcraft/releases/download/v${GRAPHCRAFT_VERSION}/tpypan-graphcraft-${GRAPHCRAFT_VERSION}.tgz"
graphcraft install --host codex
```

Each release publishes `SHA256SUMS` beside the tarball for independent verification before install.

Direct npm, pnpm, and GitHub installation is the permanent supported fallback even when a host
marketplace is unavailable. Graphcraft also ships version-locked Codex and Claude marketplace
catalogs; [marketplace distribution](https://github.com/tpypan/graphcraft/blob/v0.1.2/docs/MARKETPLACES.md) records their validation and the
separate boundary for hosted public-directory submission.

For a one-shot installation, use `npx @tpypan/graphcraft install --host codex` or `pnpm dlx @tpypan/graphcraft install --host claude`. The installer copies its MCP runtime to `~/.graphcraft/runtime/<version>/` before host registration, so clearing the package-manager cache does not break Graphcraft.

Installation registers one local MCP tool; Graphcraft does not inject a large prompt or install a skill. Start a new coding-agent session after installation.

You can also run Graphcraft directly:

```bash
graphcraft run --host claude \
  "migrate every v2 client call to v3 and verify the repository"
```

Graphcraft displays a concise run contract before doing work. Use `--yes` only when you have already reviewed and approved that contract.

## What v0.1 does

- Lets the selected host propose a task-specific execution graph from bounded repository evidence, then validates and displays the actual plan before approval.
- Keeps the finish line, permissions, repository policy, and acceptance anchors outside worker control.
- Creates an isolated Git worktree without stashing, cleaning, or resetting the current checkout. Repeatable `--include` and `--exclude` globs become enforced runtime policy: actual tracked, untracked, and explicitly excluded ignored paths are content-snapshotted around every worker, while unauthorized HEAD, branch, index, read-only, or node-scope changes block acceptance and remain preserved for inspection.
- Stores a hashed append-only event log and rebuildable state under the repository's local `.graphcraft/` directory. Individual events, the event log, and the materialized state have explicit growth limits; Graphcraft reserves enough log capacity to persist one accurate blocker before refusing further appends.
- Applies one durable artifact policy to logs, transcripts, capsules, reports, and content-addressed evidence. Ordinary artifacts are redacted before sizing and safely truncated with source/stored-byte metadata, identity-bound artifacts fail closed instead of changing hashes, and a bounded inventory plus recoverable publication journal keeps run-wide quotas inspectable across interruption.
- Redacts known credential formats, authorization headers, credential-bearing URLs, password assignments, private keys, and configured sensitive environment values before model-visible summaries, durable events/transcripts/artifacts/reports, terminal/MCP output, and viewer/export responses. Integrity-hashed probe definitions reject secret-like content instead of being silently rewritten.
- Gives each worker a grounded, size-bounded context capsule, records what was selected, omitted, and reused, and never replays raw transcripts or probe logs.
- Infers deterministic, task-family-specific progress and completion probes from repository evidence, then lets users inspect or replace the versioned probe plan before approval.
- Keeps executable completion definitions in an integrity-hashed held-out plan, gives planner graphs only opaque references, and blocks omitted, substituted, or weakened checks before acceptance.
- Runs approved probes outside model context and classifies progress as advanced, learning, stalled, regressed, oscillating, blocked, or done.
- Persists task-specific evidence vectors and strategy trajectories across restarts, distinguishes advancing A→B→done work from A→B→A churn, and returns a concise decision packet when autonomous progress stops.
- Uses a fresh read-only semantic verifier only when structural probes cannot ground reported progress or completion, and persists its verdict and cost separately.
- Enforces control edges during scheduling and acceptance: observers record evidence, vetoes block without gaining write authority, target owners must approve, and user-owned arbitrators resolve explicit conflicts through durable decision packets.
- Applies evidence-backed add, supersede, split, fuse, and dependency amendments only to unfinished work, preserves governance anchors and completion probes, and stops repeated repair signatures.
- Runs sequentially by default and can overlap at most two independent read-only branches; all shared-worktree writes and Git side effects remain sequential.
- Optimizes the approved shape deterministically by fusing redundant bounded reads, splitting safely partitionable broad writes, recording concurrency choices, and reusing a durable host context only for tightly dependent same-authority reasoning with reconciled cost evidence.
- Checkpoints host sessions and results during execution, resumes the same host session when safe, and falls back to repository evidence when switching hosts or native continuation is unavailable.
- Accepts pause or stop from another CLI process, terminates the active child with bounded escalation, and records the exact cause and outcome before releasing the run lock.
- Executes explicit time, file-exists, and file-changed wait nodes without a model call while state is unchanged; wake conditions, content baselines, observations, and the next wake time survive restart in the event log.
- Runs approved work under an optional detached local supervisor with atomic PID/heartbeat records, mode-`0600` logs, stale-process replacement, and the same coordinated pause/stop channel. Supervisor files are operational projections; run events remain authoritative.
- Uses the authenticated `gh` CLI for a read-only GitHub preflight and fully paginated pull-request snapshot: exact head/base SHAs, required checks, reviews, review threads, mergeability, permissions, branch protection, and rate limits. Snapshots are marked untrusted and rejected when either SHA moves.
- Journals atomic commits, normal pushes, pull-request creation, review replies, thread resolutions, and check reruns as durable claim–act–confirm side effects. Exact remote preconditions and action markers reconcile mutations where GitHub supports them; reruns use a durable dispatch checkpoint and stop uncertain rather than risk a duplicate request. PR creation binds exact head/base SHAs, fully paginates existing branch PRs, and recovers an existing exact open PR.
- Classifies exact-SHA PR lifecycle state deterministically, giving current review feedback precedence over same-head CI failures and separating pending, actionable, infrastructure, cancelled, stale, human-decision, and green outcomes. `pr_green` waits with persisted bounded backoff and no model calls while checks or approvals are pending. Review and actionable-CI changes receive bounded, fully reverified repair pushes; unchanged signatures stop. Verified review fixes receive an exact reply and resolution, infrastructure or cancelled GitHub check runs receive at most one justified rerun, changes-requested decisions remain sticky until approval, and base movement is durably rebound without inferring rebase or merge authority.
- Serves `graphcraft view [run]` only on `127.0.0.1` as a read-only live projection of verified run files. The accessible local viewer distinguishes dependency and governance edges, exposes node context/probes/evidence, revisions, recovery and side-effect timelines, per-phase/per-node token dimensions, redacted on-demand artifacts, and a redacted self-contained export without writing to the run.
- Tracks cached, uncached, output, reasoning, and total tokens with explicit provider availability, and reports planning, worker, repair, semantic-verification, and Graphcraft-overhead costs by phase and node.
- Provides an experimental matched benchmark harness with a versioned ten-task public corpus, fresh deterministic fixtures, explicit model/effort controls, immutable fixture-bound scoring, atomic checkpoints, resumable randomized trials, deterministic blinded-review packets, and digest-bound Markdown publication.

## Commands

```text
graphcraft install --host <codex|claude>
graphcraft update --host <codex|claude>
graphcraft run <task> [--include <glob>] [--exclude <glob>] [--finish-line <local_verified|committed|pushed|pr_open|pr_green>] [--max-workers 2] [--background]
graphcraft runs [--json]
graphcraft status [run]
graphcraft inspect [run]
graphcraft probes [run] [--set probe-plan.json]
graphcraft amend [run] --set amendment.json [--approve]
graphcraft decide [run] --source <id> --target <node> --verdict <approve|veto> --reason <text>
graphcraft pause [run]
graphcraft resume [run] [--background]
graphcraft supervisors [run]
graphcraft stop [run]
graphcraft delete <run> [--yes]
graphcraft prune --completed-before <date> [--keep <count>] [--confirm-run <id>...] [--yes]
graphcraft trace [run]
graphcraft view [run] [--no-open] [--port <port>]
graphcraft doctor
graphcraft github-snapshot [pull-request]
graphcraft benchmark <suite> --host both --codex-model <model> --claude-model <model> --effort <level>
graphcraft benchmark-review <report> [--suite <suite>] --blinding-key-stdin --output <blinded-review.json>
graphcraft benchmark-report <report> [--suite <suite>] --blinding-key-stdin --labels <review-labels.json> --output <report.md>
graphcraft uninstall --host <codex|claude>
```

`runs`, `status`, `inspect`, and `trace` are concise human-readable views by default. Pass `--json` when a script or another tool needs the stable structured form. `runs` orders durable runs by their last update and prints an unambiguous run prefix that every run-specific command accepts.

`--background` detaches only after contract approval. `status` shows the current supervisor and `supervisors` shows every supervisor instance, including stale replacements and local log paths. A machine restart does not auto-launch a process; rerun `graphcraft resume <run> --background` to recover the persisted wait and continue without repeating accepted work. Filesystem wait paths are resolved inside the isolated worktree, whose exact path is exposed with the wait state.

`delete` and `prune` remove only Graphcraft-owned run state, never the preserved worktree or its branch. Both commands are read-only dry runs unless `--yes` is supplied. Deletion requires the exact reviewed run ID; pruning additionally requires every selected run ID through repeatable `--confirm-run` options and revalidates terminal state, cutoff, locks, and supervisors before removal.

`github-snapshot` itself is read-only. The separate `pushed`, `pr_open`, and `pr_green` finish lines perform only the approved normal push and optional PR creation after GitHub preflight. `pr_green` adds token-free lifecycle polling, bounded reverified repair pushes, exact review replies and resolutions, and one justified rerun for a rerunnable infrastructure or cancelled check. Unchanged repair signatures, non-rerunnable checks, sticky human decisions, uncertain mutations, and base conflicts stop with classified evidence. These finish lines never force-push, reopen, rebase a published branch, merge, deploy, or edit an unrelated PR.

Small localized tasks bypass Graphcraft by default using measured task-shape signals rather than request length. Pass `--force` when you deliberately want a durable graph.

Use `stable-v1` as the bundled benchmark suite name. A dry run validates and prints its schedule without requiring model options. Real trials require an explicit model for every selected host and one shared `low`, `medium`, `high`, or `xhigh` effort policy; reports remain local under `.graphcraft/benchmarks/` unless `--output` is supplied.

`benchmark-review` and `benchmark-report` accept the blinding key only through standard input when `--blinding-key-stdin` is explicit. Supply the same private high-entropy 32-byte key to both commands as exactly 64 lowercase hexadecimal characters, with an optional final LF or CRLF, from a protected external source such as a secret manager. Graphcraft bounds the input, does not accept a key-file path, and does not persist or print the key. Packet IDs use domain-separated HMAC; artifacts contain only the key digest. The review export is separate and create-only, removes explicit host/model/mode/session/usage metadata, and includes packet digests for external review. After every packet has one digest-bound reviewer verdict, `benchmark-report` validates the same key digest and exact packet coverage, then renders a separate create-only report containing raw/blinded/label provenance, per-task and aggregate results, blinded defect findings, uncertainty intervals, unsuccessful trials, and the existing quantitative gate. Neither command modifies the raw report, performs model calls, publishes results, or turns a passing quantitative gate into a stable-release claim.

## Evidence and scope

The [v0.1 implementation report](https://github.com/tpypan/graphcraft/blob/v0.1.2/docs/V0.1.md) records the acceptance boundary, architecture, tests, real-host dogfood, and known gaps. Research and competitive rationale live under [docs/research](https://github.com/tpypan/graphcraft/tree/v0.1.2/docs/research).

Graphcraft does not yet claim stable reliability or a 20% token-savings gate. The harness, public fixtures, and blinded-review/publication tooling exist, but repeated real Codex and Claude trials, completed independent defect review, published evidence, and a passing stable gate remain outstanding.

## Development

```bash
pnpm install
pnpm check
```

`pnpm check` formats, typechecks, tests, bundles both executables, enforces the plugin discovery-context limit, and verifies the exact npm tarball contents.

## License

[MIT](LICENSE)
