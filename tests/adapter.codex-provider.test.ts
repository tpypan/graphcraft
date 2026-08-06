import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeCodexExecutable,
  readCodexConfiguredProviderOverrides,
} from "../packages/adapter-codex/src/index.ts";

const PROVIDER_CONFIG = `model_provider = "corp-proxy"
model = "gpt-x"

[model_providers.corp-proxy]
name = "Corp Proxy"
base_url = "https://proxy.example.com/v1"
wire_api = "responses"
disable_response_storage = true
http_headers = { X-Header = "abc" }

[model_providers.corp-proxy.auth]
command = "/usr/local/bin/token-helper"
timeout_ms = 5000
refresh_interval_ms = 300000
`;

const cleanups: (() => Promise<void>)[] = [];
const originalCodexHome = process.env.CODEX_HOME;

async function codexHomeWithConfig(config: string | undefined): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "graphcraft-codex-provider-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  if (config !== undefined) await writeFile(join(home, "config.toml"), config, "utf8");
  process.env.CODEX_HOME = home;
  return home;
}

async function fakeCodexExecutable(loginOutput: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "graphcraft-fake-codex-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "codex");
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.144.6"; exit 0; fi
if [ "$1" = "login" ]; then echo "${loginOutput}"; exit 0; fi
exit 1
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  return executable;
}

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("codex custom model-provider forwarding", () => {
  it("returns no overrides without a config file", async () => {
    await codexHomeWithConfig(undefined);
    expect(readCodexConfiguredProviderOverrides()).toBeUndefined();
  });

  it("returns no overrides without a top-level model_provider", async () => {
    await codexHomeWithConfig('model = "gpt-x"\napproval_policy = "never"\n');
    expect(readCodexConfiguredProviderOverrides()).toBeUndefined();
  });

  it("forwards allowlisted provider and auth keys verbatim", async () => {
    await codexHomeWithConfig(PROVIDER_CONFIG);
    expect(readCodexConfiguredProviderOverrides()).toEqual([
      'model_provider="corp-proxy"',
      'model_providers.corp-proxy.name="Corp Proxy"',
      'model_providers.corp-proxy.base_url="https://proxy.example.com/v1"',
      'model_providers.corp-proxy.wire_api="responses"',
      'model_providers.corp-proxy.http_headers={ X-Header = "abc" }',
      'model_providers.corp-proxy.auth.command="/usr/local/bin/token-helper"',
      "model_providers.corp-proxy.auth.timeout_ms=5000",
      "model_providers.corp-proxy.auth.refresh_interval_ms=300000",
    ]);
  });

  it("fails closed when the active provider table is missing", async () => {
    await codexHomeWithConfig('model_provider = "corp-proxy"\n');
    expect(() => readCodexConfiguredProviderOverrides()).toThrow(
      "no [model_providers.corp-proxy] declaration",
    );
  });

  it("fails closed on a provider key outside the allowlist", async () => {
    await codexHomeWithConfig(
      'model_provider = "p"\n[model_providers.p]\nbase_url = "https://x"\nexperimental = true\n',
    );
    expect(() => readCodexConfiguredProviderOverrides()).toThrow(
      "does not support the experimental field",
    );
  });

  it("fails closed on comments, multi-line, or unbalanced values", async () => {
    await codexHomeWithConfig(
      'model_provider = "p"\n[model_providers.p]\nbase_url = "https://x" # inline\n',
    );
    expect(() => readCodexConfiguredProviderOverrides()).toThrow("comments");
    await codexHomeWithConfig(
      'model_provider = "p"\n[model_providers.p]\nhttp_headers = { A = "b"\n',
    );
    expect(() => readCodexConfiguredProviderOverrides()).toThrow("single-line balanced");
  });

  it("fails closed on unsupported provider subtables", async () => {
    await codexHomeWithConfig(
      'model_provider = "p"\n[model_providers.p]\nbase_url = "https://x"\n[model_providers.p.extra]\nkey = "v"\n',
    );
    expect(() => readCodexConfiguredProviderOverrides()).toThrow(
      "does not support the [model_providers.p.extra] table",
    );
  });

  it("treats a configured provider as authentication when login status is negative", async () => {
    await codexHomeWithConfig(PROVIDER_CONFIG);
    const withProvider = await probeCodexExecutable(await fakeCodexExecutable("Not logged in"));
    expect(withProvider.authenticated).toBe(true);
    await codexHomeWithConfig('model = "gpt-x"\n');
    const withoutProvider = await probeCodexExecutable(await fakeCodexExecutable("Not logged in"));
    expect(withoutProvider.authenticated).toBe(false);
  });

  it("keeps positive login status authoritative", async () => {
    await codexHomeWithConfig('model = "gpt-x"\n');
    const loggedIn = await probeCodexExecutable(
      await fakeCodexExecutable("Logged in using ChatGPT"),
    );
    expect(loggedIn.authenticated).toBe(true);
  });

  it("does not authenticate through a malformed provider declaration", async () => {
    await codexHomeWithConfig('model_provider = "p"\n');
    const malformed = await probeCodexExecutable(await fakeCodexExecutable("Not logged in"));
    expect(malformed.authenticated).toBe(false);
  });
});
