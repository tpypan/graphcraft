# Graphcraft

**Keep coding agents working as long as they are still making useful progress.**

Graphcraft is a planned open-source execution layer for long-running coding agents. It will let Codex and Claude Code design and run living task graphs, preserve state across sessions, verify progress against grounded evidence, and stop safely when work stalls or requires a human decision.

> [!NOTE]
> Graphcraft is currently in the architecture and evaluation phase. The plugin manifest is valid, but no runnable skill or execution runtime is published yet.

## Core idea

Graphcraft separates two structures:

- the **execution graph**, which represents work, dependencies, branches, and recovery;
- the **governance graph**, which represents acceptance anchors, progress probes, audits, vetoes, and human-owned decisions.

Agents may amend their execution plan when evidence changes. They may not silently weaken the anchors that define success.

## Project documents

- [Product and implementation plan](docs/PLAN.md)
- [Product, competitive, and adoption research](docs/research/graphcraft-plugin-success-strategy.md)
- [Architecture and token-efficiency research](docs/research/graphcraft-research-scope.md)

## Confirmed direction

- Codex and Claude Code are the first supported hosts.
- Users start Graphcraft explicitly with a command or direct request.
- Each run has a user-visible finish line, inferred from the request and approved in a concise contract.
- The initial audience is individual power users.
- The stable release covers repository work through the GitHub pull-request and CI lifecycle.
- Stability requires both reliable long-running execution and a measured token-efficiency improvement over matched default-agent runs.

## License

[MIT](LICENSE)
