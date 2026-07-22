# Graphcraft

**Keep coding agents working as long as they are still making useful progress.**

Graphcraft is a local execution layer for long-running coding agents. It turns a repository task into a durable execution and governance graph, runs bounded workers through Codex or Claude Code, checks progress with repository evidence, survives interruption, and stops safely when a changed strategy is no longer productive.

> [!WARNING]
> Graphcraft v0.1 is an alpha. It supports local verification, atomic commits, and normal non-force pushes. It does not yet open pull requests, monitor CI, merge, or deploy.

## Install the alpha

Requirements: Git, Node.js 22+, and an authenticated Codex or Claude Code CLI.

The public npm package is `@tpypan/graphcraft`; the unscoped `graphcraft` name belongs to an unrelated project. Install it globally with either package manager:

```bash
npm install --global @tpypan/graphcraft
graphcraft install --host codex
```

```bash
pnpm add --global @tpypan/graphcraft
graphcraft install --host claude
```

If the npm registry is unavailable, install the same executable directly from GitHub:

```bash
npm install --global https://github.com/tpypan/graphcraft/archive/refs/heads/main.tar.gz
graphcraft install --host codex
```

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
- Creates an isolated Git worktree without stashing, cleaning, or resetting the current checkout.
- Stores a hashed append-only event log and rebuildable state under the repository's local `.graphcraft/` directory.
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
- Journals atomic commits and normal pushes as durable claim–act–confirm side effects. Commits bind HEAD, branch, and changed content plus an idempotency trailer; pushes bind the origin URL, branch, local SHA, and observed remote SHA, then revalidate remote truth before acceptance.
- Tracks cached, uncached, output, reasoning, and total tokens with explicit provider availability, and reports planning, worker, repair, semantic-verification, and Graphcraft-overhead costs by phase and node.
- Provides an experimental matched benchmark harness with a versioned ten-task public corpus, fresh deterministic fixtures, explicit model/effort controls, executable external scoring, atomic checkpoints, and resumable randomized trials.

## Commands

```text
graphcraft install --host <codex|claude>
graphcraft run <task> [--finish-line <local_verified|committed|pushed>] [--max-workers 2] [--background]
graphcraft status [run]
graphcraft inspect [run]
graphcraft probes [run] [--set probe-plan.json]
graphcraft amend [run] --set amendment.json [--approve]
graphcraft decide [run] --source <id> --target <node> --verdict <approve|veto> --reason <text>
graphcraft pause [run]
graphcraft resume [run] [--background]
graphcraft supervisors [run]
graphcraft stop [run]
graphcraft trace [run]
graphcraft doctor
graphcraft github-snapshot [pull-request]
graphcraft benchmark <suite> --host both --codex-model <model> --claude-model <model> --effort <level>
graphcraft uninstall --host <codex|claude>
```

`--background` detaches only after contract approval. `status` shows the current supervisor and `supervisors` shows every supervisor instance, including stale replacements and local log paths. A machine restart does not auto-launch a process; rerun `graphcraft resume <run> --background` to recover the persisted wait and continue without repeating accepted work. Filesystem wait paths are resolved inside the isolated worktree, whose exact path is exposed with the wait state.

`github-snapshot` itself is read-only. The separate `pushed` finish line performs only an approved normal push after GitHub authentication, permission, repository, and branch-protection preflight. It never force-pushes. Pull-request creation or editing, comments, thread resolution, check reruns, merge, and deployment remain unsupported.

Small localized tasks bypass Graphcraft by default using measured task-shape signals rather than request length. Pass `--force` when you deliberately want a durable graph.

Use `stable-v1` as the bundled benchmark suite name. A dry run validates and prints its schedule without requiring model options. Real trials require an explicit model for every selected host and one shared `low`, `medium`, `high`, or `xhigh` effort policy; reports remain local under `.graphcraft/benchmarks/` unless `--output` is supplied.

## Evidence and scope

The [v0.1 implementation report](docs/V0.1.md) records the acceptance boundary, architecture, tests, real-host dogfood, and known gaps. Research and competitive rationale live under [docs/research](docs/research).

Graphcraft does not yet claim stable reliability or a 20% token-savings gate. The harness and public fixtures exist, but repeated real Codex and Claude trials, blinded defect review, and a passing stable gate remain outstanding.

## Development

```bash
pnpm install
pnpm check
```

`pnpm check` formats, typechecks, tests, bundles both executables, enforces the plugin discovery-context limit, and verifies the exact npm tarball contents.

## License

[MIT](LICENSE)
