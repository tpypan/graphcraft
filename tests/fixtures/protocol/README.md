# Versioned protocol fixtures

These fixtures are stable examples of Graphcraft's persisted protocol boundaries.

- `contract.v1.json`, `graph.v1.json`, and `events.v1.jsonl` exercise the version 1 run protocol.
- `benchmark-report.v2.json` exercises the version 2 persisted benchmark report.
- `storage-manifest.v1.json` and `storage-manifest.v2.json` exercise every explicit storage manifest version.

The signed `v0.1.0` and `v0.1.1` pre-manifest storage fixtures remain under
`packages/runtime/src/fixtures/storage/` and cover implicit storage version 0. The protocol
property suite validates both fixture sets. Event hashes are part of the fixture and must be
recomputed through the production canonical hashing path when an event changes.
