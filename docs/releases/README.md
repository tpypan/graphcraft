# Graphcraft release records

Every release tag must have a committed `v<version>.md` record in this directory before the
tag is created. The release workflow validates that the tag, public package, Codex manifest,
Claude manifest, and filename all use the same exact semantic version.

Each record must start with `# Graphcraft v<version>` and contain substantive sections named:

- `## Release notes`
- `## Persisted-format migration`

The migration section must say what happens to runs created by released formats, including when
no manual action is required. The workflow uses the committed record as the GitHub release body;
generated or uncommitted notes cannot replace it.

Before pushing a stable tag, verify that the repository has an active tag ruleset covering
`refs/tags/v*` with both update and deletion restricted and no bypass actor. Initial tag creation
remains allowed. This external repository policy closes the interval in which a tag could otherwise
move after workflow verification but before trusted publication completes. The release workflow
still verifies the signed annotated tag object and peeled commit at every mutation boundary it can
observe.

For this repository, the expected rule is named `Immutable stable release tags` and can be audited
without printing credentials:

```bash
gh api repos/tpypan/graphcraft/rulesets \
  --jq '.[] | select(.name == "Immutable stable release tags") | {target, enforcement, bypass_actors, conditions, rules}'
```

GitHub release immutability must also be enabled before a stable tag is pushed. It protects the
uploaded tarball, manifest, and checksums after the draft release is published and produces a
GitHub release attestation. The workflow's intentionally narrow `contents` token cannot read this
admin-only repository setting, so verify it from an authenticated administrator session before
tagging:

```bash
test "$(gh api repos/tpypan/graphcraft/immutable-releases --jq '.enabled')" = true
```

The release workflow independently requires the resulting published release to report
`immutable: true`; disabling this repository setting therefore fails release acceptance rather
than treating mutable assets as verified.
