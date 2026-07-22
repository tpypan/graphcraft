# Marketplace distribution

Graphcraft ships one local MCP runtime for both Codex and Claude Code, with host-specific launch
declarations. The root `package.json` is the release-version source of truth; generated host
manifests and marketplace catalogs must never be versioned independently.

## Shipped artifacts

| Artifact                           | Purpose                                     |
| ---------------------------------- | ------------------------------------------- |
| `.codex-plugin/plugin.json`        | Codex plugin manifest and MCP launch        |
| `.agents/plugins/marketplace.json` | Codex repository marketplace catalog        |
| `.claude-plugin/plugin.json`       | Claude Code plugin manifest                 |
| `.claude-plugin/marketplace.json`  | Claude Code marketplace catalog             |
| `.mcp.json`                        | Claude local-stdio MCP launch configuration |

Both catalogs resolve the exact `@tpypan/graphcraft` package version from the public npm registry.
The package contains the manifests, catalogs, `.mcp.json`, CLI bundle, and MCP bundle, so a
marketplace install does not depend on the source checkout.

Generate and verify the artifacts with:

```bash
pnpm generate:plugins
pnpm check:plugins
pnpm build
pnpm check:package
```

`check:plugins` fails when any generated file differs from `package.json`. `check:package` creates
the real npm tarball, verifies its exact allowlist, installs it without lifecycle scripts in a clean
temporary prefix, checks the CLI version, and completes MCP initialize and tool-list handshakes both
directly and through the package-local command and working directory declared in the Codex manifest.

Before a release, also run the installed vendor validators:

```bash
claude plugin validate --strict .
codex plugin marketplace add .
codex plugin list --marketplace graphcraft --available --json
codex plugin marketplace remove graphcraft
```

The Codex commands temporarily add the checkout as a local marketplace and remove it after the
check. The catalog is valid only when the listing reports the expected npm package and exact
release version.

## Distribution boundary

The Codex repository catalog and Claude marketplace catalog support Graphcraft's intentional local
stdio runtime. They are release artifacts, not evidence that either vendor has reviewed, approved,
or publicly listed Graphcraft.

OpenAI's hosted public Plugins Directory uses a separate submission portal. An MCP-backed public
submission requires a public production HTTPS MCP endpoint and domain verification. Graphcraft has
no hosted service and intentionally runs its durable state and MCP process locally, so that public
submission path is not compatible with the current product design. Adding hosting would require an
explicit product and privacy decision; it must not be inferred from the presence of the repository
marketplace catalog.

## Permanent direct-install fallback

Marketplace availability is optional. The supported direct path remains:

```bash
npm install --global @tpypan/graphcraft
graphcraft install --host codex
```

or:

```bash
pnpm add --global @tpypan/graphcraft
graphcraft install --host claude
```

One-shot `npx` and `pnpm dlx` installation remains supported because the installer copies the MCP
bundle into a versioned directory under `~/.graphcraft/runtime/` before registering it. The GitHub
tarball path documented in the README remains the registry-independent fallback.
