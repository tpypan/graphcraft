# Contributing to Graphcraft

Graphcraft is early. Start with an issue or discussion for changes to contracts, persisted schemas, authority rules, or host behavior; these surfaces need evidence and migration thinking before code.

## Development

Use Node.js 22 and pnpm:

```bash
pnpm install
pnpm check
```

Contributions should include the smallest test that proves the intended behavior. Runtime changes involving interruption, side effects, or progress classification should use a temporary real Git repository or a fault-injection fixture, not only mocks.

Do not weaken acceptance probes to make a scenario pass. Do not add raw transcripts or broad repository contents to context capsules. New orchestration must demonstrate either a reliability gain or a measured efficiency reason.

Persisted schema changes require a schema-version decision and replay fixtures. Host adapters must fail closed when authentication or required structured capabilities are unavailable.
