# Graphcraft research and product scope

Research snapshot: July 21, 2026

Status: background research retained for product and architecture decisions.

## Executive conclusion

Token-efficient support for long-running coding agents is attainable, but only if Graphcraft is intentionally **anti-chat**.

Graphcraft should not be another agent framework, task tracker, multi-agent manager, or collection of large prompt files. It should be a lightweight, portable execution layer that:

1. Compiles a substantial coding task into a small, inspectable execution graph.
2. Stores orchestration, state, and intermediate artifacts outside the model context.
3. Gives each model invocation only the context required for its current node.
4. Applies hard budgets to tokens, fan-out, retries, and elapsed time.
5. Persists checkpoints across process and coding-agent restarts.
6. Uses an existing coding agent, such as Codex or Claude Code, as the worker.
7. Measures whether the graph used fewer tokens than the host agent's default behavior.

The strongest positioning is:

> Make coding agents safe and economical to leave running.

The strongest technical description is:

> An optimizing compiler and durable execution kernel for coding-agent workflows.

Graphs are the mechanism. Durable, efficient autonomy is the product.

## Is lower token use realistic?

Yes for substantial tasks. Probably not for small tasks.

Graphcraft can save tokens when a default agent would otherwise:

- repeatedly scan the same repository;
- carry raw command output through many turns;
- keep irrelevant investigation history in its main context;
- re-explain completed work after compaction or restart;
- delegate too broadly to several full-context agents;
- retry without new evidence;
- use a strong model for mechanical work;
- pass every intermediate result back through an orchestrator model.

Graphcraft adds planning and runtime overhead. It should therefore bypass itself for short, well-scoped tasks. "No graph needed" must be a successful outcome.

The product should promise measured efficiency, not universal savings. A sensible initial target is:

> On representative tasks lasting more than 30 minutes, reduce quality-adjusted token use by 25–40% relative to the same coding agent and model operating normally.

That is a benchmark target, not a claim to publish before it has been demonstrated.

## What the current landscape already provides

### Coding-agent skills and plugins

[Agent Skills](https://agentskills.io/home) already defines a portable, progressively disclosed skill format. Codex initially loads skill metadata and reads full instructions only when a skill activates. Claude Code behaves similarly: descriptions are available for discovery, while full skill instructions enter context only when invoked.

This makes a lightweight plugin possible. It also means a large always-loaded Graphcraft prompt would be an avoidable design failure.

[Superpowers](https://github.com/obra/superpowers) packages a software-development methodology as cross-harness skills. It validates the distribution model, but it does not provide a durable, token-governed execution kernel.

### Native long-running features

[Codex long-running work](https://learn.chatgpt.com/docs/long-running-work.md) provides Goal mode, pause/resume, persistent chats, verification-oriented completion criteria, and subagent workflows. Its documentation explicitly notes that comparable subagent workflows consume more tokens than single-agent runs and recommends isolating noisy exploration and tool output.

[Claude Code goals](https://code.claude.com/docs/en/goal) continue across turns until a separate evaluator decides the completion condition holds. An active goal can be restored when its session is resumed.

[Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows) are especially important competition. Claude writes JavaScript orchestration scripts whose intermediate values stay outside the main conversation. They run in the background, can use many subagents, expose token totals, and resume completed phases within the same session. Current limitations leave an opening:

- exiting Claude Code causes a workflow to start fresh in the next session;
- workflows can use materially more tokens than normal conversation;
- the large-workflow token warning is advisory rather than a hard budget;
- the implementation is Claude-specific;
- the default orientation is fan-out rather than minimum sufficient model work.

Graphcraft cannot win by merely generating workflow scripts. It must provide cross-session durability, cross-agent portability, hard resource governance, and a measured optimizer.

### Agent runtimes and orchestration systems

[LangGraph](https://github.com/langchain-ai/langgraph) provides durable execution, checkpointing, interrupts, and graph state for developers building agent applications. Its documentation emphasizes deterministic replay and idempotent nodes because a resumed node can re-execute from a checkpoint. Graphcraft should borrow these semantics, not compete as another application framework.

[Ralph](https://github.com/snarktank/ralph) demonstrates the token and reliability benefits of fresh context per iteration, with durable progress stored in Git, JSON, and a progress file. It remains a loop rather than a general execution graph.

[Beads](https://github.com/gastownhall/beads) already provides a persistent dependency-aware task graph and compactable memory for coding agents. [Gas Town](https://github.com/gastownhall/gastown) provides persistent multi-agent orchestration, workflow templates, watchdogs, scheduling, and recovery. Graphcraft should integrate with or coexist with these tools rather than build another issue tracker or large multi-agent workspace manager.

[OpenHands](https://github.com/OpenHands/OpenHands) and [SWE-agent](https://github.com/SWE-agent/SWE-agent) are full coding-agent systems. Graphcraft should remain a layer over existing agents.

## The product boundary

Graphcraft should be:

- a thin Agent Skills plugin;
- a deterministic local CLI/runtime;
- a portable graph intermediate representation;
- an artifact and checkpoint store;
- adapters for existing coding-agent CLIs;
- a token governor and graph optimizer;
- a trace and comparison tool.

Graphcraft should not be:

- a model provider or chat application;
- a replacement for Codex or Claude Code;
- a LangGraph competitor;
- a general issue tracker;
- a large multi-agent workspace manager;
- a drag-and-drop graph canvas;
- an always-active system prompt;
- a reason to spawn several agents by default.

## Proposed user experience

```text
$ graphcraft plan "Migrate this package from REST client v2 to v3"

Graph recommended: 7 nodes, 1 bounded repair cycle
Estimated budget: 180k tokens
Concurrency: 1 (2 only during independent discovery)
Approval required before repository writes

$ graphcraft run
$ graphcraft status
$ graphcraft pause
$ graphcraft resume
$ graphcraft trace
$ graphcraft compare baseline.json graphcraft.json
```

The coding-agent plugin should make those commands natural:

1. Detect whether the task is large enough to benefit from a graph.
2. Ask the host agent to produce a graph contract through structured output.
3. Validate and persist the graph outside the conversation.
4. Launch the deterministic runtime.
5. Give each worker a compact node context packet.
6. Return only status changes, approvals, blockers, and the final evidence packet to the main conversation.

## Architecture

```text
User / coding-agent conversation
             |
      thin Graphcraft skill
             |
     Graphcraft CLI/runtime
      /       |        \
 graph IR  artifact   token ledger
           store
             |
      host adapter layer
       /             \
  codex exec       claude -p
```

### Thin plugin

The plugin should contain one short discovery skill and optional references. Its job is to decide when to call the CLI, not to carry the entire methodology in model context.

### Portable graph IR

The graph should store:

- outcome, constraints, and evidence-based definition of done;
- typed state fields;
- node input and output schemas;
- explicit dependencies and routing conditions;
- allowed tools and repository scope;
- model and effort policy;
- retry, token, and time budgets;
- checkpoint and side-effect semantics;
- human approval requirements;
- validation commands;
- artifact references rather than large embedded text.

### Pull-based runner

The runtime selects the next ready node, creates a context packet, invokes the configured coding-agent backend, validates the structured result, records usage, and advances the graph. The model should not decide the outer loop one conversational turn at a time.

Codex is a practical first backend because `codex exec --json` exposes JSONL lifecycle events and token usage, supports JSON-schema-constrained final output, and can resume a saved thread. Claude Code can be added through `claude -p` and stream JSON, with its native workflows used where they provide a better executor.

### Context capsules

Every node receives only:

- its objective;
- applicable constraints;
- selected state fields;
- relevant predecessor results;
- artifact paths and hashes;
- scoped repository paths;
- its output schema and completion test.

It should not receive the entire graph trace, full parent conversation, or raw outputs from unrelated nodes.

### Artifact passing

Large outputs belong on disk. Models exchange compact structured summaries and artifact references. Test logs, searches, diffs, and documentation dumps should be filtered deterministically before entering model context.

## Token-efficiency contract

These should be explicit acceptance criteria for the project:

1. **Idle footprint:** no more than roughly 300 tokens of Graphcraft discovery metadata in the host context.
2. **Activation footprint:** core skill instructions under roughly 1,200 tokens; detailed material loaded only on demand.
3. **Small-task bypass:** Graphcraft does not generate or execute a graph for a task expected to fit comfortably in one focused agent turn.
4. **Single-worker default:** concurrency starts at one. Parallelism requires independent work and an estimated quality or latency benefit.
5. **Hard run budget:** every run has a maximum token budget. At 90%, the runtime checkpoints and stops or asks for authorization.
6. **Per-node budgets:** each node has limits on tokens, turns, retries, and wall time.
7. **Bounded cycles:** every cycle has a deterministic attempt limit and a condition requiring new evidence before retry.
8. **Output filtering:** raw tool output does not enter a model context beyond a configurable cap; full output is stored as an artifact.
9. **Structured handoffs:** node results use schemas rather than narrative transcripts.
10. **Stable cache prefixes:** avoid changing models, effort levels, tools, or standing instructions within a context lifetime. Prompt caches match exact prefixes, so stable instructions should precede node-specific data.
11. **Selective context lifetimes:** use fresh sessions for noisy independent work; reuse a session only where dependent reasoning or code state makes that cheaper.
12. **Deterministic work stays deterministic:** parsing, graph traversal, validation, filtering, hashing, budgeting, and status calculation use code rather than model calls.
13. **No redundant reads:** record file and artifact hashes so unchanged material is not repeatedly summarized.
14. **Measured overhead:** graph planning and governance must be included in reported token totals.

## Graph optimization passes

The differentiating layer should behave like a query planner or compiler:

- **Bypass:** decide that no graph is needed.
- **State slicing:** compute the minimum state fields needed by each node.
- **Context deduplication:** prevent several workers from receiving the same broad repository dump.
- **Deterministic extraction:** replace a model node with a script when possible.
- **Node fusion:** combine adjacent small nodes when separation would duplicate context.
- **Node isolation:** split verbose exploration or logs away from the implementation context.
- **Fan-out control:** parallelize only independent work with a justified benefit.
- **Model routing:** assign inexpensive models and low effort to mechanical nodes while keeping stable model/cache groups.
- **Retry elimination:** retry only after inputs, environment, or strategy changed.
- **Early stopping:** stop research once evidence thresholds are met.
- **Artifact reuse:** reuse unchanged scans, summaries, and test results across resumed runs.

## Benchmark and proof

Token efficiency must be part of the repository from the first day.

For every evaluation task, run:

1. The default host agent with the same model, effort, permissions, and repository state.
2. The Graphcraft-enabled agent.
3. Multiple repetitions where nondeterminism matters.

Measure:

- task success and acceptance-test pass rate;
- human-review acceptance or defect count;
- uncached input tokens;
- cached input/cache-write tokens;
- output and reasoning tokens;
- total model calls;
- peak context size;
- number of repeated file reads;
- compaction count;
- wall-clock time;
- recovery after interruption;
- tokens spent on Graphcraft itself.

The primary metric should be **tokens to accepted completion**, not raw token count. A cheap failed run is not efficient.

Initial task families:

- focused bug fix with failing regression test;
- medium feature spanning several files;
- library or API migration;
- repository-wide audit with structured findings;
- interrupted run resumed after process restart;
- injected tool failure followed by bounded recovery.

## Four-day MVP

### Day 1: prove the measurement loop

- Define the graph IR and token-efficiency contract.
- Create three representative evaluation tasks.
- Capture baseline Codex runs and their JSONL usage.
- Implement graph validation for cycles, budgets, and missing routes.

### Day 2: build the deterministic kernel

- Implement graph state, ready-node selection, checkpoints, pause, and resume.
- Store events as append-only JSONL and current state as compact JSON.
- Implement hard run and per-node budgets.
- Add an artifact store and output-size enforcement.

### Day 3: make one backend excellent

- Implement the Codex `exec --json` adapter.
- Generate schema-constrained node outputs.
- Implement context capsules and one bounded repair cycle.
- Package a minimal Codex/Agent Skills plugin.

### Day 4: benchmark and demonstrate

- Run default-versus-Graphcraft comparisons.
- Fix the largest sources of token overhead.
- Demonstrate interruption and cross-process resume.
- Publish the trace, token ledger, example graph, and honest benchmark report.
- Document Claude Code as the next adapter rather than claiming complete support.

The MVP should be sequential by default, support at most two parallel workers, and avoid a graphical UI.

## Immediate post-MVP roadmap

1. Claude Code adapter and optional compilation to native dynamic workflows.
2. Pause, inspect, edit, and resume an active graph.
3. Pluggable graph planners and optimizer policies.
4. GitHub Issues and Beads adapters rather than a new task database.
5. Framework-neutral trace format and viewer.
6. Model-routing policies calibrated from benchmark data.
7. Community graph templates only after repeated runs reveal genuine reusable shapes.

## Principal risks

- **Native feature pressure:** Codex and Claude Code are rapidly adding goals, workflows, subagents, and token controls. Portability, durability, and measurable optimization must remain the wedge.
- **Orchestration overhead:** a graph can consume more tokens than it saves. Small-task bypass and node fusion are essential.
- **Recursive-agent complexity:** invoking coding-agent CLIs from a coding-agent plugin can create confusing permissions and nested sessions. The runtime needs explicit ownership and clear traces.
- **False economy:** aggressively reducing context can lower quality. Optimize tokens to accepted completion, not tokens alone.
- **Prompt-cache mistakes:** switching models or changing stable prefixes can make ostensibly efficient routing more expensive.
- **Graph drift:** unrestricted replanning can turn the graph back into an opaque loop. Amendments must be explicit, bounded, and recorded.
- **Overlap with Beads/Gas Town:** do not recreate persistent issue graphs or large-scale agent management.

## Naming recommendations

`Graphcraft` is a good conceptual working name, but it is already used by several GitHub projects and an npm package. A different distribution name would reduce confusion. Package-name checks below are only a July 21, 2026 snapshot, not trademark or domain clearance.

### 1. Runwright

Best memorable product name.

> Long-running coding agents, done right.

It emphasizes the outcome rather than the graph implementation. npm and PyPI appeared unclaimed, although small GitHub projects already use the name.

### 2. Flowsteward

Best trust-oriented name.

> Durable, economical supervision for autonomous agent work.

It suggests governance without sounding like another agent. GitHub name search, npm, and PyPI appeared clear in the snapshot.

### 3. Graphwarden

Best technical name.

> Guardrails, budgets, and recovery for agent graphs.

It retains the graph concept while emphasizing enforcement. npm and PyPI appeared clear in the snapshot.

### 4. Longlight

Best efficiency-oriented name.

> Long-running agents with a light context footprint.

It is distinctive and maps directly to the two requirements, though an existing GitHub organization uses the word.

### 5. Taskrail

Best approachable infrastructure name.

> Put autonomous coding tasks on durable rails.

npm and PyPI appeared clear; a few small GitHub repositories use the name.

### Recommendation

Use **Runwright** if the goal is a memorable open-source brand. Use **Flowsteward** if the goal is a serious reliability/control-plane identity. Keep **Graphcraft** as the name of the graph methodology or IR if desired.

## Recommended final thesis

> Runwright is a lightweight, portable execution layer that turns substantial coding tasks into durable, token-budgeted workflows. It stores progress outside model context, gives each worker only the context it needs, survives interruption, and proves its efficiency against the host coding agent's default behavior.

That thesis is meaningfully differentiated from Superpowers, Ralph, Beads, Gas Town, LangGraph, and native coding-agent workflows while composing with all of them.

## Primary sources

- [Codex: multi-agent operations](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)
- [Codex: skills and progressive disclosure](https://learn.chatgpt.com/docs/build-skills.md)
- [Codex: long-running work](https://learn.chatgpt.com/docs/long-running-work.md)
- [Codex: non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode.md)
- [Claude Code: dynamic workflows](https://code.claude.com/docs/en/workflows)
- [Claude Code: goals](https://code.claude.com/docs/en/goal)
- [Claude Code: cost and context guidance](https://code.claude.com/docs/en/costs)
- [Claude Code: prompt caching](https://code.claude.com/docs/en/prompt-caching)
- [Claude Code: skills](https://code.claude.com/docs/en/skills)
- [Agent Skills specification and progressive disclosure](https://agentskills.io/home)
- [LangGraph](https://github.com/langchain-ai/langgraph)
- [Superpowers](https://github.com/obra/superpowers)
- [Ralph](https://github.com/snarktank/ralph)
- [Beads](https://github.com/gastownhall/beads)
- [Gas Town](https://github.com/gastownhall/gastown)
- [OpenHands](https://github.com/OpenHands/OpenHands)
- [SWE-agent](https://github.com/SWE-agent/SWE-agent)
