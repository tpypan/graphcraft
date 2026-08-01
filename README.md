# Graphcraft

**Keep coding agents working as long as they are still making useful progress.**

Graphcraft turns a repository task into a durable execution graph, runs bounded Codex or Claude Code workers against it, checks progress with repository evidence, survives interruption, and stops safely when work is no longer productive.

> [!WARNING]
> v0.1 is an alpha. It verifies locally, commits, pushes, opens pull requests, and waits for green checks. It does not merge or deploy.

## Install

Requires Git, Node.js 22+, and an authenticated Codex or Claude Code CLI. `graphcraft doctor` reports the exact supported host versions; unqualified versions fail closed.

```bash
npm install --global @tpypan/graphcraft
graphcraft install --host claude   # or --host codex
```

The npm package is `@tpypan/graphcraft`; the unscoped `graphcraft` name is an unrelated project. If the registry is unavailable, install the workflow-verified release asset directly (each release publishes `SHA256SUMS` beside the tarball):

```bash
GRAPHCRAFT_VERSION=0.1.5
npm install --global "https://github.com/tpypan/graphcraft/releases/download/v${GRAPHCRAFT_VERSION}/tpypan-graphcraft-${GRAPHCRAFT_VERSION}.tgz"
```

Installation registers one local MCP tool — no large prompt, no skill. Start a new coding-agent session afterwards.

## Use

```bash
graphcraft run --host claude \
  "migrate every v2 client call to v3 and verify the repository"
```

Graphcraft displays a concise run contract before doing any work. From there:

```bash
graphcraft status            # where the run is
graphcraft view              # read-only local run viewer
graphcraft pause | resume | stop
graphcraft --help            # everything else
```

Remote finish lines (`--finish-line pushed|pr_open|pr_green`) additionally require an authenticated GitHub CLI (`gh`).

## How it works

- The host proposes a task-specific execution graph from repository evidence; you review and approve the plan, finish line, and progress probes before anything runs.
- Workers run in an isolated Git worktree under enforced include/exclude policy — your checkout is never stashed, reset, or cleaned.
- Deterministic probes run outside model context and classify progress as advanced, learning, stalled, regressed, oscillating, blocked, or done. Real progress continues; churn stops with a concise decision packet.
- Every event lands in a hashed append-only log under `.graphcraft/`, so runs survive interruption and resume without repeating accepted work.
- GitHub side effects are journaled claim–act–confirm mutations: normal pushes, idempotent PR opening, bounded review/CI repair, exact review replies. Never a force-push, merge, or deploy.

The [v0.1 implementation report](docs/V0.1.md) records the full acceptance boundary, architecture, tests, and known gaps. Marketplace distribution is documented in [docs/MARKETPLACES.md](docs/MARKETPLACES.md); research rationale lives under [docs/research](docs/research).

## Development

```bash
pnpm install
pnpm check
```

## License

[MIT](LICENSE)
