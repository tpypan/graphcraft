# Graphcraft alpha roadmap

Status: v0.1 local alpha implemented; stable milestones remain in progress
Last updated: July 21, 2026
Authority: this document is the durable product and implementation plan for Graphcraft's alpha phase and its path to stable. The files under `docs/research/` provide rationale and historical research; when they conflict with this roadmap, this roadmap wins. A future phase roadmap may explicitly supersede it.

Implementation snapshot: [`docs/V0.1.md`](V0.1.md) records what the first runnable alpha proves and what remains outside its claims.

### Current implementation boundary

Version 0.1 implements the Milestone 0 protocol foundation and a bounded portion of the Milestone 1 local execution slice: versioned contracts and graphs, hashed event replay, materialized-state recovery, worktree isolation, Codex and Claude adapters, deterministic probes, progress leases, one repair amendment, local verification and commit finish lines, CLI controls, a single-tool MCP surface, a package-manager-safe installer, and public npm distribution. It is an alpha, not completion of Milestones 1–5. In particular, dual-host benchmark coverage, full interruption reconciliation, GitHub finish lines, marketplace publication, and the stable 20% token-efficiency gate remain open.

## 1. Product contract

### Product thesis

Graphcraft is a lightweight, progress-aware execution layer for coding agents. It turns substantial repository work into a living execution graph, stores state and evidence outside model context, renews autonomous execution only when task-specific probes show useful progress, survives interruption, and measures tokens to accepted completion.

The public promise is:

> Keep coding agents working as long as they are still making useful progress.

Graphs are the mechanism. Grounded, durable, token-efficient autonomy is the product.

### Confirmed decisions

- **Audience:** individual coding-agent power users first. Team policy, hosted execution, and enterprise administration follow only after the local product is trusted.
- **Hosts:** Codex and Claude Code are required for the first stable release. Development may land Codex first internally, but the public stable release cannot call itself complete with only one host.
- **Activation:** explicit. Users invoke `/graphcraft`, the `graphcraft` CLI, or directly ask the host to use Graphcraft. The plugin may suggest itself for substantial work but never silently starts a run.
- **Task breadth:** repository engineering through the full GitHub PR lifecycle: investigation, implementation, tests, commits, push, PR creation, CI observation, repair, and review-feedback handling.
- **Finish line:** user-defined per run. Graphcraft infers it from the request, shows it in the run contract, and requires contract approval before execution.
- **Stable-release proof:** both reliability and token efficiency. A useful beta may precede this, but stable requires interruption recovery, stall handling, accepted completion, and a lower matched median token cost than default-agent baselines.
- **Primary control:** progress leases. Attempt counts and token or time ceilings trigger scrutiny or act as optional circuit breakers; they do not define productivity.
- **Grounding:** the graph contains execution and governance structures. Workers can amend work plans but cannot silently weaken acceptance anchors, held-out probes, permissions, or the finish line.
- **License:** MIT.

### Success criteria

The first stable release must:

1. Install natively into current Codex and Claude Code releases with one documented path per host.
2. Start from one explicit command or request without requiring users to author graph files.
3. Resume after host-process termination without repeating accepted nodes, losing decisions, or duplicating external side effects.
4. Detect unchanged work, regression, and oscillation using task-specific evidence; diagnose once with a changed strategy before stopping safely.
5. Support the finish lines `local_verified`, `committed`, `pushed`, `pr_open`, and `pr_green`, plus a constrained custom finish line.
6. Complete representative bugs, features, migrations, refactors, audits, and PR-repair tasks through their approved boundaries.
7. Report why each lease renewed, why the graph changed, why a run stopped, and what evidence supports completion.
8. Reduce median total model tokens to accepted completion by at least 20% across the stable benchmark corpus, with no more than a five-percentage-point decrease in accepted-completion rate.
9. Keep the plugin discovery surface below 250 estimated tokens per host and the core activation instructions below 1,000 estimated tokens, measured in CI.
10. Pass supported-platform tests on macOS, Linux, and Windows. GitHub is the only required forge for the first stable release.

### Non-goals for the first stable release

- A new chat application or model provider.
- A general application-agent framework competing with LangGraph.
- A task tracker, issue database, or multi-agent office.
- Deployment, production mutation, or automatic merge unless a later run contract and policy explicitly add them.
- A visual graph editor. A trace viewer may render graphs after the runtime is proven.
- Automatic extraction of reusable skills or prompt modifications from runs.
- GitLab, Bitbucket, or proprietary forge support.
- A cloud control plane, required account, or default telemetry.

## 2. User experience

### Installation and first value

The public distribution layers are:

1. the published npm package `@tpypan/graphcraft`, exposing the `graphcraft` executable;
2. official Codex and Claude plugin marketplaces when their submission gates are met;
3. direct GitHub package installation as a registry-independent fallback path; and
4. clone-and-build installation only for contributors.

The unscoped npm name `graphcraft` is already owned by an unrelated GraphQL package, so the scoped package is the canonical identity while the user-facing command remains `graphcraft`. The installer accepts an explicit host, is idempotent, and has explicit update and uninstall commands. It copies the bundled MCP runtime to `~/.graphcraft/runtime/<version>/` before host registration; this makes `npx` and `pnpm dlx` safe even after their temporary caches are removed. It does not ask users to configure models, graph syntax, concurrency, or budgets before the first run.

### Starting a run

The normal entry points are:

```text
/graphcraft migrate this package from REST client v2 to v3 and get the PR green
```

```bash
graphcraft run "migrate this package from REST client v2 to v3 and get the PR green"
```

Graphcraft inspects the repository and current conversation, then presents one concise contract:

```text
Outcome       All v2 call sites migrated
Finish line   Pull request open and required GitHub checks green
Progress      Remaining call sites, compile errors, focused tests, full suite
Boundaries    This repository and a new worktree; no merge or deployment
Permissions   Local writes, commits, push, PR comments, and CI reruns
Recovery      Checkpoint after each accepted node; resumable after restart
Plan shape    Inventory → migrate in waves → integrate → verify → PR → CI repair

Start? [Y/n]
```

Contract approval authorizes only the displayed boundary and permissions. If the request does not name a finish line, Graphcraft defaults to `local_verified`. If the request says “commit,” “push,” “open a PR,” or “get the PR green,” it selects the corresponding finish line. Ambiguous custom finish lines require the user to resolve the ambiguity before execution.

### Stable controls

The plugin and CLI expose the same small vocabulary:

```text
graphcraft run <task>
graphcraft status [run]
graphcraft inspect [run]
graphcraft pause [run]
graphcraft resume [run]
graphcraft stop [run]
graphcraft trace [run]
graphcraft doctor
graphcraft benchmark <suite>
```

- `status` returns the outcome, finish line, accepted nodes, latest progress evidence, current blocker, token totals, and next action.
- `inspect` returns the run contract, current graph, anchors, probes, and amendments.
- `pause` completes or cancels the current model call, checkpoints, and releases the run lock.
- `resume` reconstructs state from the event log, reconciles unfinished side effects, and schedules only ready work.
- `stop` records a user stop, leaves the repository safe, and creates a final evidence packet without claiming completion.
- `trace` emits human-readable output by default and JSON with `--json`.

### Small-task bypass

Before graph compilation, Graphcraft classifies whether the request benefits from durable orchestration. A task is bypassed when it is localized, has one obvious verification step, needs no external waiting, and is expected to fit in one focused host turn. The result says “Graphcraft is not needed for this task” and returns control to the host. The user can force a graph with `--force`.

### Worktree and Git behavior

- Write-capable runs create an isolated Git worktree and `graphcraft/<run-id>-<slug>` branch by default.
- Graphcraft never stashes, resets, or cleans the user's existing checkout.
- If the task explicitly depends on uncommitted changes, Graphcraft requires the user to choose the current checkout and records that exception in the contract.
- Each accepted implementation node may create one atomic commit. Verification-only, audit, wait, and decision nodes do not commit.
- `pushed`, `pr_open`, and `pr_green` authorize normal non-force pushes. Force push, rebase of a published branch, merge, and deployment are never inferred.
- GitHub operations use `gh` in the first stable release. Authentication and repository access are checked before the contract is approved.

## 3. Architecture and interfaces

### Technology choices

- TypeScript, Node.js 22, ESM, and a pnpm workspace.
- No native extensions in the stable path; filesystem, process, locking, and Git operations use portable Node APIs and explicit subprocess argument arrays.
- Zod schemas at untrusted and persisted boundaries, with JSON Schema exports for host structured output.
- Vitest for unit and integration tests; a separate real-host evaluation harness for behavioral tests.
- The public package is `@tpypan/graphcraft` and its executable is `graphcraft`. Internal workspace package names remain private.

Planned package boundaries:

- `core`: graph IR, contracts, scheduler, event reducer, lease policy, and public types;
- `runtime`: workspace, locks, artifacts, Git/worktree operations, and run lifecycle;
- `adapter-codex` and `adapter-claude`: host capability detection and structured execution;
- `probes`: built-in deterministic and semantic probe families;
- `github`: PR snapshots, CI/review events, and idempotent mutations;
- `cli`: commands and rendering;
- `evals`: matched baselines, fault injection, and reports.

### Run contract

`RunContract` is immutable after approval except through a user-approved contract amendment:

```ts
type FinishLine =
  | { kind: "local_verified" }
  | { kind: "committed" }
  | { kind: "pushed" }
  | { kind: "pr_open" }
  | { kind: "pr_green"; requiredChecks: "github_required" | string[] }
  | { kind: "custom"; description: string; proof: ProbeSpec[] };

interface RunContract {
  schemaVersion: 1;
  runId: string;
  task: string;
  outcome: string;
  finishLine: FinishLine;
  repository: { root: string; remote?: string; baseRef: string; baseSha: string };
  scope: { include: string[]; exclude: string[] };
  permissions: Permission[];
  acceptanceAnchors: AcceptanceAnchor[];
  optionalCircuitBreakers?: { tokens?: number; minutes?: number; modelCalls?: number };
}
```

Acceptance anchors identify their owner (`user`, `repository`, `github`, or `held_out_eval`), evidence source, and mutation policy. A worker-authored graph amendment cannot change them.

### Graph IR

One versioned IR contains two linked subgraphs:

- **Work graph:** nodes and dependency edges for investigation, implementation, verification, wait, decision, and repair.
- **Control graph:** acceptance anchors, progress probes, completion probes, audit nodes, vetoes, arbitration, and target ownership.

Required node fields are `id`, `kind`, `objective`, `dependsOn`, `scope`, `contextSelector`, `outputSchema`, `progressProbes`, `completionProbes`, `sideEffectClass`, and `status`. Node IDs are stable across resume. Completed node definitions are immutable.

Control edges use the explicit relations `observes`, `vetoes`, `arbitrates`, and `owns_target`. Dependency edges do not imply authority. A verifier may veto a node without becoming allowed to edit its output.

### Host adapter

Both host adapters implement the same streaming contract:

```ts
interface HostAdapter {
  readonly id: "codex" | "claude";
  probe(): Promise<HostCapabilities>;
  execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent>;
  reconcile(invocation: InvocationRecord): Promise<ReconciliationResult>;
}
```

`WorkerRequest` contains one context capsule, allowed tools, repository path, model policy, and a JSON Schema result contract. `HostEvent` normalizes lifecycle, tool, artifact, final-result, error, and token-usage events. Raw host transcripts are stored as artifacts and are never replayed into another model context by default.

Adapters feature-detect the installed CLI and fail closed when required structured-output, unattended-execution, or token-reporting capabilities are unavailable. The runtime never scrapes human terminal formatting as an authoritative protocol.

### Durable state

Each repository uses a gitignored `.graphcraft/` directory:

```text
.graphcraft/
  runs/<run-id>/contract.json
  runs/<run-id>/graph.json
  runs/<run-id>/state.json
  runs/<run-id>/events.jsonl
  runs/<run-id>/artifacts/
  runs/<run-id>/capsules/
  runs/<run-id>/reports/
  locks/
```

- `events.jsonl` is the append-only source of truth.
- `state.json` and `graph.json` are atomically replaced materialized views and can be rebuilt from events.
- Every event has a schema version, monotonically increasing sequence, timestamp, actor, causation ID, and content hash.
- A per-run lock records process identity and heartbeat. Stale recovery validates that the process is gone, then reconciles the last invocation and external side effects before taking ownership.
- Artifacts are content-addressed. Context capsules reference hashes and paths rather than embedding large content.
- Persisted schema migrations are forward-only, idempotent, and tested against fixtures from every released version.

### Graph amendments

An agent may propose an amendment only with:

- the evidence that invalidated or refined the previous path;
- nodes and edges added, removed, or superseded;
- scope and permission impact;
- new or changed probes;
- a rationale and falsifiable expectation.

The runtime rejects amendments that alter completed nodes, weaken or remove anchors, broaden repository scope, add external permissions, change the finish line, or expose held-out probes. Those require a contract amendment approved by the user.

### Progress leases

Every runnable node starts with a baseline evidence snapshot. After one meaningful worker result or repair attempt:

1. Deterministic probes capture current evidence.
2. The runtime compares the task-specific progress vector with the baseline.
3. A semantic verifier runs in an isolated context only if deterministic evidence cannot classify the delta.
4. The result is one of `advanced`, `learning`, `stalled`, `regressed`, `oscillating`, `blocked`, or `done`.
5. `advanced` and decision-relevant `learning` checkpoint and renew execution.
6. `regressed` or the first unchanged failure signature schedules a diagnostic node. The diagnosis must name the invariant, change strategy, and state a falsifier.
7. If post-diagnostic evidence remains materially unchanged, returns to a previously cleared state, or contradicts another control loop, the runtime stops safely with a decision packet. The stop is based on the evidence classification, not the attempt count alone.
8. `done` requires all completion probes and non-overridden vetoes to pass.

The semantic verifier cannot edit the repository or graph. Held-out completion probes are executed outside the worker context, and only their verdict and actionable failure evidence are returned.

### Built-in probe families

- **Bug:** reproduction, regression test, failure signature, targeted tests, broader tests.
- **Feature:** acceptance scenarios, integration contracts, focused behavior, repository checks.
- **Migration:** authoritative inventory, remaining old usage, compile/type errors, slice tests, dependency removal.
- **Refactor:** behavior preservation, target structural measure, affected tests, scope growth.
- **Audit:** required questions, evidence coverage, unresolved unknowns, source credibility.
- **PR lifecycle:** head SHA, required checks, unresolved review threads, mergeability, recurring signatures, base movement.

Probe packages contain schemas and deterministic collectors. Their discovery metadata is not loaded into the host context. Semantic instructions are loaded only for the selected task family.

### GitHub lifecycle

The GitHub module uses one fully paginated snapshot as the source of truth for PR head, base, checks, reviews, threads, and mergeability. It is event-driven where possible and otherwise uses token-free polling with backoff; the model wakes only for actionable changes.

Mutations follow claim → act → confirm:

- persist the exact remote precondition and intended action;
- perform one idempotent or preconditioned mutation;
- confirm remote truth before marking the action complete;
- on interruption, reconcile instead of repeating blindly.

Review fixes precede CI repair for the same head. After any push, stale CI and review snapshots are discarded and refetched. Repeated CI or review signatures feed the same progress-lease trajectory rather than an independent retry loop.

### Token and context policy

- One worker is the default. At most two workers run concurrently in the first stable release, and only for independent nodes whose context capsules do not overlap materially.
- Deterministic code handles graph traversal, polling, filtering, hashing, schemas, Git state, and status rendering.
- Every node receives only its objective, applicable anchors and constraints, selected predecessor results, relevant paths, and artifact references.
- Raw logs and diffs are filtered and stored, not pasted into controller contexts.
- Unchanged repository scans and summaries are reused by content hash.
- Fresh contexts isolate noisy exploration; existing contexts are reused only when dependent reasoning would otherwise require rereading equivalent material.
- Token reporting includes planning, probes, verification, repairs, and Graphcraft overhead. Cached and uncached input are reported separately when the host exposes them.
- Optional circuit breakers checkpoint and request authorization; they do not declare failure or success.

## 4. Delivery sequence

### Milestone 0 — repository and protocol foundation

- Establish the workspace, formatting, typechecking, tests, release automation, and cross-platform CI.
- Formalize the schemas above and publish example run, graph, event, and report fixtures.
- Build the event reducer, atomic persistence, locks, artifact hashing, and state reconstruction.
- Define a benchmark repository corpus and host-version capture format.

**Exit:** fixtures round-trip, corrupted views rebuild from events, and crash/lock tests pass on all supported operating systems.

### Milestone 1 — local execution vertical slice

- Implement the CLI, contract compiler, worktree lifecycle, scheduler, context capsules, and deterministic probe runner.
- Implement the Codex adapter first internally, followed immediately by Claude parity.
- Support `local_verified` and `committed` finish lines for bug, feature, and migration tasks.
- Add pause, resume, stop, inspect, and trace.

**Exit:** both hosts complete the same real repository task, survive a forced process termination, and do not repeat accepted nodes.

### Milestone 2 — grounded control graph

- Implement progress vectors, semantic verifier isolation, diagnostic nodes, amendment validation, held-out probes, vetoes, and decision packets.
- Add refactor and audit probe families.
- Add adversarial behavior evals for metric gaming, weakened tests, false progress, failure migration, and oscillation.

**Exit:** evals distinguish A→B→done from A↔B churn and reject attempts to make completion green by weakening its measurement.

### Milestone 3 — full GitHub finish lines

- Implement `pushed`, `pr_open`, and `pr_green`.
- Add paginated PR snapshots, event-driven waiting, CI reruns, CI repair, review-thread resolution, base movement, and external mutation reconciliation.
- Preserve sticky human decisions across restart and unrelated remote changes.

**Exit:** an interrupted run can open a PR, respond to new CI and review events, reach required-check green, and report unresolved human decisions without duplicate pushes or comments.

### Milestone 4 — efficiency optimizer and matched benchmarks

- Add small-task bypass, node fusion, state slicing, output filtering, scan reuse, and measured concurrency decisions.
- Run matched baselines with identical model, effort, permissions, repository state, and acceptance scorer.
- Delete or simplify orchestration mechanisms that do not improve accepted outcomes.

**Exit:** the stable corpus meets the 20% median token reduction and acceptance-rate gate, with complete public traces and negative results.

### Milestone 5 — stable distribution

- Automate releases for `@tpypan/graphcraft` and continuously verify global npm/pnpm and one-shot npx/pnpm-dlx installation against clean user homes.
- Package native Codex and Claude plugins plus update, uninstall, and doctor flows.
- Publish a first-project tutorial and the migration demonstration.
- Complete security review, threat model, privacy statement, contribution guide, and support policy.
- Apply for official marketplaces.

**Exit:** a new user can install, start, inspect, interrupt, resume, and finish a run on either host without reading architecture documentation.

### Later milestones

- Probe SDK and signed community probe packs.
- Importers for external plans and task graphs.
- Read-only graph and trace viewer.
- GitLab adapter.
- Organization policy packs and remote schedulers.
- Explicit, consent-based learning from successful runs.

## 5. Test and release plan

### Automated tests

- **Unit:** schemas, reducers, graph validation, amendment policy, scheduling, progress classification, token accounting, filters, and finish-line resolution.
- **Property:** event replay determinism, graph acyclicity where required, idempotent migrations, content hashes, and no duplicated accepted side effects.
- **Fault injection:** kill before and after checkpoint, truncate materialized views, stale locks, host crash, token stream loss, partial Git push, API timeout, rate limit, and stale PR head.
- **Integration:** real temporary Git repositories, worktrees, commits, resume, and a mocked GitHub API with pagination and concurrent changes.
- **Adapter contracts:** recorded and live smoke tests for supported Codex and Claude versions; unsupported capability combinations fail closed.
- **Behavioral evals:** pressure scenarios that try to skip probes, weaken anchors, expand scope, repeat unchanged work, or claim completion from paperwork rather than executed evidence.
- **Cross-platform:** macOS, Linux, and Windows CI with paths containing spaces, Unicode, long paths, and interrupted child processes.

### Stable benchmark corpus

Use at least ten substantial tasks: two bugs, two features, two migrations, one refactor, one audit, and two PR/CI repair tasks. Run each task at least three times per host with and without Graphcraft. Randomize run order and restore an identical repository snapshot for every trial.

Score:

- accepted completion through tests and task-specific held-out checks;
- defects in blinded review;
- total, cached, uncached, output, and reasoning tokens where exposed;
- Graphcraft planning and verification overhead;
- repeated reads and unchanged failure signatures;
- wall time and human interventions;
- interruption recovery and duplicate side effects.

Publish per-task results, medians, failure traces, host versions, model settings, and the scorer. Do not combine failed cheap runs with accepted runs as if they were equivalent.

### Release channels

- `0.x` development snapshots may break persisted schemas and require documented migration tools.
- Beta begins only after dual-host local execution and resume work.
- Stable `1.0` requires all product success criteria, the benchmark gate, cross-platform support, and a completed security review.
- Persisted format changes after `1.0` require migrations and backward-compatibility fixtures.

## 6. Safety, privacy, and operating assumptions

- All state is local by default. No account or hosted Graphcraft service is required.
- No source code, prompts, logs, diffs, or tokens are transmitted except to the model provider and developer tools the user already authorized.
- Telemetry is absent initially. Any future telemetry must be opt-in and limited to non-content operational metrics with a published schema.
- Secrets are never written to events, artifacts, reports, or model-visible summaries. Redaction occurs before persistence as well as before display.
- Repository instructions and closer-scoped policies outrank Graphcraft plans. The run contract cannot grant authority forbidden by the repository or host.
- External content, issue text, review comments, and command output are untrusted inputs and cannot modify permissions, anchors, or the finish line.
- Graphcraft never claims merge, deployment, or production acceptance from a green local or PR state.
- The implementation remains host-neutral above the adapter boundary, but does not weaken behavior to a lowest-common-denominator abstraction. Unsupported host capabilities are surfaced plainly.

## 7. Open-source and product strategy

- Launch around the migration demo: a run stalls, changes strategy, survives restart, finishes, and shows matched token receipts.
- Keep the README install-first once runnable distribution exists; until then it must accurately state pre-alpha status.
- Dogfood Graphcraft on this repository and attach traces to substantial pull requests.
- Prefer probe-family contributions over arbitrary prompt collections. Require behavioral evidence for new probes.
- Maintain candid release notes, including mechanisms removed for cost or lack of quality benefit.
- Use GitHub Discussions before creating a separate community channel that requires ongoing moderation.
- Keep Graphcraft as the working project name. Revisit the launch brand only after the core demonstration works; naming must not delay runtime proof.
