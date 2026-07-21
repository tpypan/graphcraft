# Graphcraft

**Keep coding agents working as long as they are still making useful progress.**

Graphcraft is a local execution layer for long-running coding agents. It turns a repository task into a durable execution and governance graph, runs bounded workers through Codex or Claude Code, checks progress with repository evidence, survives interruption, and stops safely when a changed strategy is no longer productive.

> [!WARNING]
> Graphcraft v0.1 is an alpha. It supports local verification and atomic-commit finish lines. It does not yet push, open pull requests, monitor CI, merge, or deploy.

## Install the alpha

Requirements: Git, Node.js 22+, and an authenticated Codex or Claude Code CLI.

```bash
git clone https://github.com/tpypan/graphcraft.git
cd graphcraft
node dist/graphcraft.mjs install --host claude
```

Use `--host codex` for Codex. The repository includes the bundled runtime, so users do not need to install JavaScript dependencies. Installation registers one local MCP tool; Graphcraft does not inject a large prompt or install a skill. Start a new coding-agent session after installation.

You can also run Graphcraft directly:

```bash
node dist/graphcraft.mjs run --host claude \
  "migrate every v2 client call to v3 and verify the repository"
```

Graphcraft displays a concise run contract before doing work. Use `--yes` only when you have already reviewed and approved that contract.

## What v0.1 does

- Compiles a user request into linked execution and governance graphs.
- Keeps the finish line, permissions, repository policy, and acceptance anchors outside worker control.
- Creates an isolated Git worktree without stashing, cleaning, or resetting the current checkout.
- Stores a hashed append-only event log and rebuildable state under the repository's local `.graphcraft/` directory.
- Gives each worker a small context capsule instead of replaying raw transcripts.
- Runs deterministic repository probes and classifies progress as advanced, learning, stalled, regressed, oscillating, blocked, or done.
- Schedules one evidence-driven repair when verification fails, then stops if the changed strategy does not clear the failure.
- Resumes interrupted runs without repeating accepted nodes and can switch between Codex and Claude Code.
- Tracks cached, uncached, output, reasoning, and total tokens when the host exposes them.

## Commands

```text
graphcraft install --host <codex|claude>
graphcraft run <task>
graphcraft status [run]
graphcraft inspect [run]
graphcraft pause [run]
graphcraft resume [run]
graphcraft stop [run]
graphcraft trace [run]
graphcraft doctor
graphcraft uninstall --host <codex|claude>
```

Small localized tasks bypass Graphcraft by default. Pass `--force` when you deliberately want a durable graph.

## Evidence and scope

The [v0.1 implementation report](docs/V0.1.md) records the acceptance boundary, architecture, tests, real-host dogfood, and known gaps. The [product plan](docs/PLAN.md) remains authoritative for the path to stable. Research and competitive rationale live under [docs/research](docs/research).

Graphcraft does not yet claim the stable plan's reliability or 20% token-savings gate. Those require the matched multi-task, dual-host benchmark described in the plan.

## Development

```bash
pnpm install
pnpm check
```

`pnpm check` formats, typechecks, tests, bundles both executables, and enforces the plugin discovery-context limit.

## License

[MIT](LICENSE)
