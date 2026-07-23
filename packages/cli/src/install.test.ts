import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCapabilities } from "@graphcraft/core";
import {
  GRAPHCRAFT_VERSION,
  createHostCommandRunner,
  defaultHostCommandRunner,
  hostCompatibilityDiagnostic,
  installHost,
  installationDiagnostics,
  isLegacyGraphcraftRuntimeSha256,
  isManagedLegacyGraphcraftRuntime,
  uninstallHost,
  updateHost,
  validateLocalViewerUrl,
  type HostCommandRunner,
  type HostName,
} from "./index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function commandOutput(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

interface FakeRegistration {
  command: string;
  args: string[];
  scope?: string;
  type?: string;
  env?: Record<string, string>;
  envVars?: string[];
  cwd?: string | null;
}

function fakeHostRunner(initial: Partial<Record<HostName, string>> = {}): {
  runner: HostCommandRunner;
  registrations: Map<HostName, FakeRegistration>;
  calls: Array<{ command: string; args: string[]; cwd?: string }>;
} {
  const registrations = new Map<HostName, FakeRegistration>();
  for (const host of ["codex", "claude"] as const) {
    const path = initial[host];
    if (path) registrations.set(host, { command: "node", args: [path] });
  }
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const runner: HostCommandRunner = async (command, args, options) => {
    const host = command as HostName;
    calls.push({ command, args: [...args], ...(options?.cwd ? { cwd: options.cwd } : {}) });
    if (args[0] !== "mcp") return { exitCode: 2, stdout: "", stderr: "unexpected command" };
    if (args[1] === "remove") {
      if (registrations.delete(host)) return { exitCode: 0, stdout: "removed", stderr: "" };
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          host === "codex"
            ? "Error: No MCP server named 'graphcraft' found."
            : 'No MCP server named "graphcraft" in user scope',
      };
    }
    if (args[1] === "add") {
      const separator = args.indexOf("--");
      registrations.set(host, {
        command: args[separator + 1]!,
        args: args.slice(separator + 2),
      });
      return { exitCode: 0, stdout: "added", stderr: "" };
    }
    if (args[1] === "get") {
      const registration = registrations.get(host);
      if (!registration) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `No MCP server named 'graphcraft' found.`,
        };
      }
      if (host === "codex") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            transport: {
              type: registration.type ?? "stdio",
              command: registration.command,
              args: registration.args,
              env: registration.env ?? null,
              env_vars: registration.envVars ?? [],
              cwd: registration.cwd ?? null,
            },
          }),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: [
          "graphcraft:",
          `  Scope: ${registration.scope ?? "User config (available in all your projects)"}`,
          "  Status: ✓ Connected",
          `  Type: ${registration.type ?? "stdio"}`,
          `  Command: ${registration.command}`,
          `  Args: ${registration.args.join(" ")}`,
          `  Environment: ${Object.entries(registration.env ?? {})
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")}`,
          ...(registration.cwd === undefined
            ? []
            : [`  Working directory: ${registration.cwd ?? ""}`]),
        ].join("\n"),
        stderr: "",
      };
    }
    return { exitCode: 2, stdout: "", stderr: "unexpected MCP operation" };
  };
  return { runner, registrations, calls };
}

async function cleanLongPathFixture(): Promise<{
  root: string;
  graphcraftHome: string;
  source: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft install Ω "));
  temporaryRoots.push(root);
  const longSegments = Array.from(
    { length: 4 },
    (_, index) => `long path ${String(index)} ${"x".repeat(24)}`,
  );
  const graphcraftHome = join(root, "clean home with spaces", "工具", ...longSegments);
  const sourceDirectory = join(root, "temporary package cache Ω");
  const source = join(sourceDirectory, "mcp bundle.mjs");
  await mkdir(sourceDirectory, { recursive: true });
  return { root, graphcraftHome, source };
}

async function seedOwnedRegistration(
  fake: ReturnType<typeof fakeHostRunner>,
  host: HostName,
  graphcraftHome: string,
  version = "0.1.1",
): Promise<{ runtimePath: string; source: string }> {
  const runtimePath = join(graphcraftHome, "runtime", version, "mcp.mjs");
  const source = `#!/usr/bin/env node\nconsole.log(${JSON.stringify(`owned ${host} ${version}`)});\n`;
  await mkdir(join(graphcraftHome, "runtime", version), { recursive: true });
  await writeFile(runtimePath, source);
  const registrationsDirectory = join(graphcraftHome, "registrations");
  const receiptPath = join(registrationsDirectory, `${host}.json`);
  await mkdir(registrationsDirectory, { recursive: true });
  await writeFile(
    receiptPath,
    `${JSON.stringify({
      schemaVersion: 1,
      host,
      graphcraftVersion: version,
      runtimePath,
      runtimeSha256: digest(source),
    })}\n`,
  );
  if (process.platform !== "win32") {
    await chmod(registrationsDirectory, 0o700);
    await chmod(receiptPath, 0o600);
  }
  fake.registrations.set(host, { command: "node", args: [runtimePath] });
  return { runtimePath, source };
}

async function seedCurrentRuntimePair(graphcraftHome: string, source: string): Promise<string> {
  const runtimeDirectory = join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION);
  const runtimeRoot = join(graphcraftHome, "runtime");
  const runtimePath = join(runtimeDirectory, "mcp.mjs");
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(runtimePath, source);
  await writeFile(
    join(runtimeDirectory, "runtime.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      graphcraftVersion: GRAPHCRAFT_VERSION,
      runtimeFile: "mcp.mjs",
      sha256: digest(source),
      bytes: Buffer.byteLength(source),
    })}\n`,
  );
  if (process.platform !== "win32") {
    await chmod(runtimeRoot, 0o700);
    await chmod(runtimeDirectory, 0o700);
    await chmod(runtimePath, 0o600);
    await chmod(join(runtimeDirectory, "runtime.json"), 0o600);
  }
  return runtimePath;
}

it.each(["install", "update", "uninstall", "diagnostics"] as const)(
  "rejects a symlinked Graphcraft home before %s can inspect or mutate a host",
  async (operation) => {
    const { root, source } = await cleanLongPathFixture();
    const target = join(root, "graphcraft-home-target");
    const graphcraftHome = join(root, "graphcraft-home-link");
    const fake = fakeHostRunner();
    await mkdir(target);
    await symlink(target, graphcraftHome, process.platform === "win32" ? "junction" : "dir");
    await writeFile(source, "#!/usr/bin/env node\n");

    const attempt =
      operation === "install"
        ? installHost("codex", source, { graphcraftHome, runner: fake.runner })
        : operation === "update"
          ? updateHost("codex", source, { graphcraftHome, runner: fake.runner })
          : operation === "uninstall"
            ? uninstallHost("codex", { graphcraftHome, runner: fake.runner })
            : installationDiagnostics({ graphcraftHome, mcpPath: source, runner: fake.runner });

    await expect(attempt).rejects.toThrow(/refusing to harden symbolic link/i);
    expect(fake.calls).toHaveLength(0);
  },
);

it("rejects an oversized ownership receipt before host inspection", async () => {
  const { graphcraftHome, source } = await cleanLongPathFixture();
  const receiptDirectory = join(graphcraftHome, "registrations");
  const receiptPath = join(receiptDirectory, "codex.json");
  const fake = fakeHostRunner();
  await mkdir(receiptDirectory, { recursive: true });
  await writeFile(receiptPath, "{}");
  await truncate(receiptPath, 16 * 1024 + 1);
  await writeFile(source, "#!/usr/bin/env node\n");

  await expect(
    installHost("codex", source, { graphcraftHome, runner: fake.runner }),
  ).rejects.toThrow(/registration receipt is unsafe/i);
  expect(fake.calls).toHaveLength(0);
});

it("rejects an oversized receipt-bound runtime without mutating its registration", async () => {
  const { graphcraftHome, source } = await cleanLongPathFixture();
  const fake = fakeHostRunner();
  const previous = await seedOwnedRegistration(fake, "codex", graphcraftHome);
  await truncate(previous.runtimePath, 32 * 1024 * 1024 + 1);
  await writeFile(source, "#!/usr/bin/env node\n");

  await expect(
    updateHost("codex", source, { graphcraftHome, runner: fake.runner }),
  ).rejects.toThrow(/no verifiable Graphcraft ownership receipt/i);
  expect(fake.registrations.get("codex")).toEqual({
    command: "node",
    args: [previous.runtimePath],
  });
  expect(fake.calls.filter(({ args }) => ["remove", "add"].includes(args[1]!))).toHaveLength(0);
});

it("accepts a hard-linked package runtime source while staging a private copy", async () => {
  const { root, graphcraftHome, source } = await cleanLongPathFixture();
  const linkedSource = join(root, "hard-linked-package-runtime.mjs");
  const fake = fakeHostRunner();
  await writeFile(source, "#!/usr/bin/env node\n");
  await link(source, linkedSource);

  const installed = await installHost("codex", linkedSource, {
    graphcraftHome,
    runner: fake.runner,
  });

  expect((await stat(linkedSource)).nlink).toBeGreaterThan(1);
  expect((await stat(installed.runtimePath)).nlink).toBe(1);
  await expect(readFile(installed.runtimePath, "utf8")).resolves.toBe("#!/usr/bin/env node\n");
  expect(fake.calls.length).toBeGreaterThan(0);
});

it.skipIf(process.platform !== "darwin")(
  "removes inherited ACLs from the temporary host-command working directory",
  async () => {
    const { root, graphcraftHome, source } = await cleanLongPathFixture();
    const hostTemporaryRoot = join(root, "host temporary root");
    const inheritedProbe = join(hostTemporaryRoot, "inherited probe");
    const fake = fakeHostRunner();
    await mkdir(hostTemporaryRoot);
    await commandOutput("/bin/chmod", [
      "+a",
      "everyone allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit",
      hostTemporaryRoot,
    ]);
    await mkdir(inheritedProbe);
    expect(await commandOutput("/bin/ls", ["-lde", inheritedProbe])).toMatch(/\n \d+:/);
    await writeFile(source, "#!/usr/bin/env node\n");

    const previousTemporaryRoot = process.env.TMPDIR;
    process.env.TMPDIR = hostTemporaryRoot;
    try {
      const runner: HostCommandRunner = async (command, args, options) => {
        if (!options?.cwd) throw new Error("Host command cwd was not supplied");
        expect(await commandOutput("/bin/ls", ["-lde", options.cwd])).not.toMatch(/\n \d+:/);
        return await fake.runner(command, args, options);
      };
      await installHost("codex", source, { graphcraftHome, runner });
    } finally {
      if (previousTemporaryRoot === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTemporaryRoot;
    }
  },
);

it("rejects a temporary host-command directory populated before hardening", async () => {
  const { graphcraftHome, source } = await cleanLongPathFixture();
  const fake = fakeHostRunner();
  await writeFile(source, "#!/usr/bin/env node\n");

  await expect(
    installHost("codex", source, {
      graphcraftHome,
      runner: fake.runner,
      hostCommandCwdCreatedBoundary: async (cwd) => {
        await writeFile(
          join(cwd, ".mcp.json"),
          '{"mcpServers":{"graphcraft":{"command":"hostile"}}}\n',
        );
      },
    }),
  ).rejects.toThrow(/temporary directory populated before it was secured/i);
  expect(fake.calls).toHaveLength(0);
});

describe.each(["codex", "claude"] as const)("%s installation lifecycle", (host) => {
  it("installs, updates, and records the verified runtime", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    const firstRuntime = "#!/usr/bin/env node\nconsole.log('first Ω');\n";
    await writeFile(source, firstRuntime);

    const installed = await installHost(host, source, {
      graphcraftHome,
      runner: fake.runner,
    });

    expect(installed.runtimePath).toBe(
      join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "mcp.mjs"),
    );
    expect(installed.runtimeSha256).toBe(digest(firstRuntime));
    expect(fake.registrations.get(host)).toEqual({
      command: "node",
      args: [installed.runtimePath],
    });

    const manifestPath = join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "runtime.json");
    const receiptPath = join(graphcraftHome, "registrations", `${host}.json`);
    await expect(readFile(manifestPath, "utf8")).resolves.toContain(installed.runtimeSha256);
    await expect(readFile(receiptPath, "utf8")).resolves.toContain(installed.runtimeSha256);

    const updated = await updateHost(host, source, {
      graphcraftHome,
      runner: fake.runner,
    });

    expect(updated.runtimeSha256).toBe(installed.runtimeSha256);
    await expect(readFile(updated.runtimePath, "utf8")).resolves.toBe(firstRuntime);
    const files = await readdir(join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION));
    expect(files.sort()).toEqual(["mcp.mjs", "runtime.json"]);
    if (process.platform !== "win32") {
      await expect(stat(graphcraftHome)).resolves.toMatchObject({ mode: 0o40700 });
      await expect(stat(join(graphcraftHome, "runtime"))).resolves.toMatchObject({ mode: 0o40700 });
      await expect(
        stat(join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION)),
      ).resolves.toMatchObject({ mode: 0o40700 });
      await expect(stat(updated.runtimePath)).resolves.toMatchObject({ mode: 0o100600 });
      await expect(stat(manifestPath)).resolves.toMatchObject({ mode: 0o100600 });
      await expect(stat(join(graphcraftHome, "registrations"))).resolves.toMatchObject({
        mode: 0o40700,
      });
      await expect(stat(receiptPath)).resolves.toMatchObject({ mode: 0o100600 });
    }

    const diagnostics = await installationDiagnostics({
      graphcraftHome,
      mcpPath: source,
      runner: fake.runner,
    });
    expect(diagnostics).toMatchObject({
      runtime: { status: "current", expectedSha256: updated.runtimeSha256 },
      registrations: { [host]: { status: "current", receipt: "current" } },
    });
    await installHost(host, source, { graphcraftHome, runner: fake.runner });
    expect(fake.calls.filter(({ args }) => args[1] === "remove")).toHaveLength(1);
    expect(fake.calls.filter(({ args }) => args[1] === "add")).toHaveLength(1);
  });

  it("does not replace different bytes for an already-published version", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    const publishedSource = "#!/usr/bin/env node\nconsole.log('published');\n";
    await writeFile(source, publishedSource);
    const installed = await installHost(host, source, {
      graphcraftHome,
      runner: fake.runner,
    });
    await writeFile(source, "#!/usr/bin/env node\nconsole.log('different same version');\n");
    const mutationStart = fake.calls.length;

    await expect(updateHost(host, source, { graphcraftHome, runner: fake.runner })).rejects.toThrow(
      /versioned runtimes are immutable/i,
    );

    await expect(readFile(installed.runtimePath, "utf8")).resolves.toBe(publishedSource);
    expect(
      fake.calls.slice(mutationStart).filter(({ args }) => ["remove", "add"].includes(args[1]!)),
    ).toHaveLength(0);
  });

  it("leaves an unrelated stale registration unchanged without an ownership receipt", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const foreign = { command: "node", args: ["/unrelated/mcp.mjs"] };
    const fake = fakeHostRunner();
    fake.registrations.set(host, foreign);
    await writeFile(source, "#!/usr/bin/env node\n");

    await expect(
      installHost(host, source, { graphcraftHome, runner: fake.runner }),
    ).rejects.toThrow(/no verifiable Graphcraft ownership receipt or recognized legacy runtime/i);

    expect(fake.registrations.get(host)).toEqual(foreign);
    expect(fake.calls.filter(({ args }) => ["remove", "add"].includes(args[1]!))).toHaveLength(0);
    await expect(access(join(graphcraftHome, "registrations", `${host}.json`))).rejects.toThrow();
  });

  it("does not follow a registration receipts directory symlink", async () => {
    const { root, graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    const externalDirectory = join(root, "external-registrations");
    const markerPath = join(externalDirectory, "marker.txt");
    await mkdir(externalDirectory, { recursive: true });
    await writeFile(markerPath, "unchanged\n");
    await mkdir(graphcraftHome, { recursive: true });
    await symlink(
      externalDirectory,
      join(graphcraftHome, "registrations"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(source, "#!/usr/bin/env node\n");

    await expect(
      installHost(host, source, { graphcraftHome, runner: fake.runner }),
    ).rejects.toThrow(/registration receipts directory is unsafe/i);

    await expect(readFile(markerPath, "utf8")).resolves.toBe("unchanged\n");
    expect(fake.calls).toHaveLength(0);
  });

  it("does not overwrite an unowned runtime before rejecting its registration", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const runtimePath = join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "mcp.mjs");
    const foreignRuntime = "#!/usr/bin/env node\nconsole.log('foreign');\n";
    const fake = fakeHostRunner();
    fake.registrations.set(host, { command: "node", args: [runtimePath] });
    await mkdir(join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION), { recursive: true });
    await writeFile(runtimePath, foreignRuntime);
    await writeFile(source, "#!/usr/bin/env node\nconsole.log('graphcraft');\n");

    await expect(updateHost(host, source, { graphcraftHome, runner: fake.runner })).rejects.toThrow(
      /no verifiable Graphcraft ownership receipt or recognized legacy runtime/i,
    );

    await expect(readFile(runtimePath, "utf8")).resolves.toBe(foreignRuntime);
    expect(fake.calls.filter(({ args }) => ["remove", "add"].includes(args[1]!))).toHaveLength(0);
  });

  it.each(["absent", "stale"] as const)(
    "recovers an exact current registration after its ownership receipt is %s",
    async (receiptState) => {
      const { graphcraftHome, source } = await cleanLongPathFixture();
      const fake = fakeHostRunner();
      if (receiptState === "stale") await seedOwnedRegistration(fake, host, graphcraftHome);
      const currentSource = "#!/usr/bin/env node\nconsole.log('crash-recovered');\n";
      const runtimePath = await seedCurrentRuntimePair(graphcraftHome, currentSource);
      fake.registrations.set(host, { command: "node", args: [runtimePath] });
      await writeFile(source, currentSource);
      const mutationStart = fake.calls.length;

      const recovered = await installHost(host, source, {
        graphcraftHome,
        runner: fake.runner,
      });
      await updateHost(host, source, { graphcraftHome, runner: fake.runner });

      expect(recovered.runtimePath).toBe(runtimePath);
      expect(recovered.runtimeSha256).toBe(digest(currentSource));
      expect(
        fake.calls.slice(mutationStart).filter(({ args }) => ["remove", "add"].includes(args[1]!)),
      ).toHaveLength(0);
      await expect(
        readFile(join(graphcraftHome, "registrations", `${host}.json`), "utf8"),
      ).resolves.toContain(digest(currentSource));
    },
  );

  it.each([
    "missing manifest",
    "mismatched runtime",
    "symlinked runtime",
    "symlinked manifest",
    "symlinked version directory",
    ...(process.platform === "win32"
      ? []
      : [
          "permissive runtime root",
          "permissive version directory",
          "permissive runtime",
          "permissive manifest",
        ]),
  ])("does not adopt a receipt-less current registration with a %s", async (fault) => {
    const { root, graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    const currentSource = "#!/usr/bin/env node\nconsole.log('exact');\n";
    const runtimePath = await seedCurrentRuntimePair(graphcraftHome, currentSource);
    const runtimeDirectory = join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION);
    const manifestPath = join(runtimeDirectory, "runtime.json");
    if (fault === "missing manifest") {
      await rm(manifestPath);
    } else if (fault === "mismatched runtime") {
      await writeFile(runtimePath, "#!/usr/bin/env node\nconsole.log('different');\n");
    } else if (fault === "symlinked runtime") {
      const linkedRuntime = join(root, "linked-runtime.mjs");
      await writeFile(linkedRuntime, currentSource);
      await rm(runtimePath);
      await symlink(linkedRuntime, runtimePath, "file");
    } else if (fault === "symlinked manifest") {
      const linkedManifest = join(root, "linked-runtime.json");
      await writeFile(linkedManifest, await readFile(manifestPath));
      await rm(manifestPath);
      await symlink(linkedManifest, manifestPath, "file");
    } else if (fault === "symlinked version directory") {
      const linkedHome = join(root, "linked-home");
      await seedCurrentRuntimePair(linkedHome, currentSource);
      await rm(runtimeDirectory, { recursive: true });
      await symlink(
        join(linkedHome, "runtime", GRAPHCRAFT_VERSION),
        runtimeDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } else if (fault === "permissive runtime root") {
      await chmod(join(graphcraftHome, "runtime"), 0o755);
    } else if (fault === "permissive version directory") {
      await chmod(runtimeDirectory, 0o755);
    } else if (fault === "permissive runtime") {
      await chmod(runtimePath, 0o777);
    } else {
      await chmod(manifestPath, 0o644);
    }
    fake.registrations.set(host, { command: "node", args: [runtimePath] });
    await writeFile(source, currentSource);

    const diagnostics = await installationDiagnostics({
      graphcraftHome,
      mcpPath: source,
      runner: fake.runner,
    });
    expect(diagnostics).toMatchObject({ runtime: { status: "stale" } });

    await expect(
      installHost(host, source, { graphcraftHome, runner: fake.runner }),
    ).rejects.toThrow(/not an exact current bundled runtime/i);

    expect(fake.registrations.get(host)).toEqual({ command: "node", args: [runtimePath] });
    expect(fake.calls.filter(({ args }) => ["remove", "add"].includes(args[1]!))).toHaveLength(0);
    await expect(access(join(graphcraftHome, "registrations", `${host}.json`))).rejects.toThrow();
  });

  it.each(["after_prepare", "after_publish"] as const)(
    "recovers an interrupted immutable runtime publication at %s",
    async (faultPoint) => {
      const { graphcraftHome, source } = await cleanLongPathFixture();
      const fake = fakeHostRunner();
      const bundledSource = "#!/usr/bin/env node\nconsole.log('published-atomically');\n";
      await writeFile(source, bundledSource);
      let injected = false;

      await expect(
        installHost(host, source, {
          graphcraftHome,
          runner: fake.runner,
          runtimePublicationBoundary(point) {
            if (point !== faultPoint) return;
            injected = true;
            throw new Error(`Injected process interruption at ${point}`);
          },
        }),
      ).rejects.toThrow(`Injected process interruption at ${faultPoint}`);
      expect(injected).toBe(true);
      const runtimePath = join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "mcp.mjs");
      if (faultPoint === "after_prepare") {
        await expect(access(runtimePath)).rejects.toThrow();
      } else {
        await expect(readFile(runtimePath, "utf8")).resolves.toBe(bundledSource);
      }

      const recovered = await installHost(host, source, {
        graphcraftHome,
        runner: fake.runner,
      });

      await expect(readFile(recovered.runtimePath, "utf8")).resolves.toBe(bundledSource);
      const manifest = JSON.parse(
        await readFile(join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "runtime.json"), "utf8"),
      );
      expect(manifest).toMatchObject({
        graphcraftVersion: GRAPHCRAFT_VERSION,
        sha256: digest(bundledSource),
        bytes: Buffer.byteLength(bundledSource),
      });
      await expect(
        readFile(join(graphcraftHome, "registrations", `${host}.json`), "utf8"),
      ).resolves.toContain(digest(bundledSource));
      expect(fake.calls.filter(({ args }) => args[1] === "add")).toHaveLength(1);
      expect((await readdir(join(graphcraftHome, "runtime"))).sort()).toEqual([GRAPHCRAFT_VERSION]);
      expect((await readdir(join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION))).sort()).toEqual([
        "mcp.mjs",
        "runtime.json",
      ]);
    },
  );

  it("replaces a stale registration only when its receipt and runtime are verified", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    const previous = await seedOwnedRegistration(fake, host, graphcraftHome);
    await writeFile(source, "#!/usr/bin/env node\nconsole.log('current');\n");

    const installed = await updateHost(host, source, { graphcraftHome, runner: fake.runner });

    expect(fake.registrations.get(host)).toEqual({
      command: "node",
      args: [installed.runtimePath],
    });
    expect(installed.runtimePath).not.toBe(previous.runtimePath);
    expect(fake.calls.filter(({ args }) => args[1] === "remove")).toHaveLength(1);
    expect(fake.calls.filter(({ args }) => args[1] === "add")).toHaveLength(1);
  });

  it("rejects a stale registration when its receipt-bound runtime was tampered", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    const previous = await seedOwnedRegistration(fake, host, graphcraftHome);
    const tampered = "tampered legacy runtime\n";
    await writeFile(previous.runtimePath, tampered);
    await writeFile(source, "#!/usr/bin/env node\nconsole.log('current');\n");

    await expect(updateHost(host, source, { graphcraftHome, runner: fake.runner })).rejects.toThrow(
      /no verifiable Graphcraft ownership receipt or recognized legacy runtime/i,
    );

    await expect(readFile(previous.runtimePath, "utf8")).resolves.toBe(tampered);
    expect(fake.registrations.get(host)).toEqual({
      command: "node",
      args: [previous.runtimePath],
    });
    expect(fake.calls.filter(({ args }) => ["remove", "add"].includes(args[1]!))).toHaveLength(0);
  });

  it("rejects a receipt-bound runtime symlink even when its bytes match", async () => {
    const { root, graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    const previous = await seedOwnedRegistration(fake, host, graphcraftHome);
    const linkedRuntime = join(root, "receipt-linked-runtime.mjs");
    await writeFile(linkedRuntime, previous.source);
    await rm(previous.runtimePath);
    await symlink(linkedRuntime, previous.runtimePath, "file");
    await writeFile(source, "#!/usr/bin/env node\nconsole.log('current');\n");

    await expect(updateHost(host, source, { graphcraftHome, runner: fake.runner })).rejects.toThrow(
      /no verifiable Graphcraft ownership receipt or recognized legacy runtime/i,
    );

    expect(fake.registrations.get(host)).toEqual({
      command: "node",
      args: [previous.runtimePath],
    });
    expect(fake.calls.filter(({ args }) => ["remove", "add"].includes(args[1]!))).toHaveLength(0);
  });

  it("restores the previous registration when replacement fails", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    const { runtimePath: previousPath } = await seedOwnedRegistration(fake, host, graphcraftHome);
    await writeFile(source, "#!/usr/bin/env node\n");
    const runner: HostCommandRunner = async (command, args, options) => {
      if (args[1] === "add" && args.at(-1) !== previousPath) {
        return { exitCode: 1, stdout: "", stderr: "injected add failure" };
      }
      return await fake.runner(command, args, options);
    };

    await expect(installHost(host, source, { graphcraftHome, runner })).rejects.toThrow(
      /previous registration was restored and verified/i,
    );
    expect(fake.registrations.get(host)).toEqual({ command: "node", args: [previousPath] });
    await expect(
      readFile(join(graphcraftHome, "registrations", `${host}.json`), "utf8"),
    ).resolves.toContain('"graphcraftVersion":"0.1.1"');
  });

  it("rolls back when post-add verification is inconclusive", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    const { runtimePath: previousPath } = await seedOwnedRegistration(fake, host, graphcraftHome);
    await writeFile(source, "#!/usr/bin/env node\n");
    let injected = false;
    const runner: HostCommandRunner = async (command, args, options) => {
      if (
        args[1] === "get" &&
        fake.registrations.get(host)?.args[0] !== previousPath &&
        !injected
      ) {
        injected = true;
        return { exitCode: 0, stdout: "registration unavailable", stderr: "" };
      }
      return await fake.runner(command, args, options);
    };

    await expect(installHost(host, source, { graphcraftHome, runner })).rejects.toThrow(
      /previous registration was restored and verified/i,
    );
    expect(injected).toBe(true);
    expect(fake.registrations.get(host)).toEqual({ command: "node", args: [previousPath] });
  });

  it("restores the previous registration when receipt publication fails", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    const { runtimePath: previousPath } = await seedOwnedRegistration(fake, host, graphcraftHome);
    const receiptPath = join(graphcraftHome, "registrations", `${host}.json`);
    await writeFile(source, "#!/usr/bin/env node\n");
    const runner: HostCommandRunner = async (command, args, options) => {
      if (args[1] === "add" && args.at(-1) !== previousPath) {
        await rm(receiptPath, { force: true });
        await mkdir(receiptPath, { recursive: true });
      } else if (args[1] === "add" && args.at(-1) === previousPath) {
        await rm(receiptPath, { recursive: true, force: true });
      }
      return await fake.runner(command, args, options);
    };

    await expect(installHost(host, source, { graphcraftHome, runner })).rejects.toThrow(
      /previous registration was restored and verified.*previous registration receipt was restored/i,
    );
    expect(fake.registrations.get(host)).toEqual({ command: "node", args: [previousPath] });
    await expect(readFile(receiptPath, "utf8")).resolves.toContain('"graphcraftVersion":"0.1.1"');
  });

  it("uninstalls idempotently from a clean home", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    await writeFile(source, "#!/usr/bin/env node\n");
    await installHost(host, source, { graphcraftHome, runner: fake.runner });

    await expect(uninstallHost(host, { graphcraftHome, runner: fake.runner })).resolves.toEqual({
      host,
      removed: true,
    });
    await expect(uninstallHost(host, { graphcraftHome, runner: fake.runner })).resolves.toEqual({
      host,
      removed: false,
    });
    await expect(access(join(graphcraftHome, "registrations", `${host}.json`))).rejects.toThrow();
  });

  it("leaves a replaced registration untouched during uninstall", async () => {
    const { root, graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    await writeFile(source, "#!/usr/bin/env node\n");
    await installHost(host, source, { graphcraftHome, runner: fake.runner });
    const foreign = { command: "node", args: [join(root, "foreign", "mcp.mjs")] };
    fake.registrations.set(host, foreign);
    const uninstallStart = fake.calls.length;

    await expect(uninstallHost(host, { graphcraftHome, runner: fake.runner })).rejects.toThrow(
      /left unchanged|not owned by the verified Graphcraft runtime/i,
    );

    expect(fake.registrations.get(host)).toEqual(foreign);
    expect(fake.calls.slice(uninstallStart).some(({ args }) => args[1] === "remove")).toBe(false);
    await expect(access(join(graphcraftHome, "registrations", `${host}.json`))).resolves.toBe(
      undefined,
    );
  });

  it("rechecks ownership immediately before uninstalling", async () => {
    const { root, graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    await writeFile(source, "#!/usr/bin/env node\n");
    await installHost(host, source, { graphcraftHome, runner: fake.runner });
    const foreign = { command: "node", args: [join(root, "foreign", "mcp.mjs")] };
    let uninstalling = false;
    let uninstallInspections = 0;
    const runner: HostCommandRunner = async (command, args, options) => {
      const result = await fake.runner(command, args, options);
      if (uninstalling && args[1] === "get" && ++uninstallInspections === 1) {
        fake.registrations.set(host, foreign);
      }
      return result;
    };
    const uninstallStart = fake.calls.length;
    uninstalling = true;

    await expect(uninstallHost(host, { graphcraftHome, runner })).rejects.toThrow(
      /changed during uninstall.*left unchanged/i,
    );

    expect(uninstallInspections).toBe(2);
    expect(fake.registrations.get(host)).toEqual(foreign);
    expect(fake.calls.slice(uninstallStart).some(({ args }) => args[1] === "remove")).toBe(false);
    await expect(access(join(graphcraftHome, "registrations", `${host}.json`))).resolves.toBe(
      undefined,
    );
  });

  it("rechecks ownership immediately before replacing a registration", async () => {
    const { root, graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    await seedOwnedRegistration(fake, host, graphcraftHome);
    await writeFile(source, "#!/usr/bin/env node\nconsole.log('current');\n");
    const foreign = { command: "node", args: [join(root, "foreign", "mcp.mjs")] };
    let inspections = 0;
    const runner: HostCommandRunner = async (command, args, options) => {
      const result = await fake.runner(command, args, options);
      if (args[1] === "get" && ++inspections === 1) fake.registrations.set(host, foreign);
      return result;
    };

    await expect(updateHost(host, source, { graphcraftHome, runner })).rejects.toThrow(
      /changed during installation.*left unchanged/i,
    );

    expect(inspections).toBe(2);
    expect(fake.registrations.get(host)).toEqual(foreign);
    expect(fake.calls.filter(({ args }) => ["remove", "add"].includes(args[1]!))).toHaveLength(0);
  });

  it("requires a valid ownership receipt before uninstalling a registration", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    await writeFile(source, "#!/usr/bin/env node\n");
    await installHost(host, source, { graphcraftHome, runner: fake.runner });
    const receiptPath = join(graphcraftHome, "registrations", `${host}.json`);
    await rm(receiptPath, { force: true });
    const registration = fake.registrations.get(host);
    const uninstallStart = fake.calls.length;

    await expect(uninstallHost(host, { graphcraftHome, runner: fake.runner })).rejects.toThrow(
      /no valid Graphcraft ownership receipt/i,
    );

    expect(fake.registrations.get(host)).toEqual(registration);
    expect(fake.calls.slice(uninstallStart).some(({ args }) => args[1] === "remove")).toBe(false);
  });

  it("requires the receipt-bound runtime bytes before uninstalling", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    await writeFile(source, "#!/usr/bin/env node\n");
    const installed = await installHost(host, source, {
      graphcraftHome,
      runner: fake.runner,
    });
    await writeFile(installed.runtimePath, "tampered runtime\n");
    const registration = fake.registrations.get(host);
    const uninstallStart = fake.calls.length;

    await expect(uninstallHost(host, { graphcraftHome, runner: fake.runner })).rejects.toThrow(
      /failed ownership verification/i,
    );

    expect(fake.registrations.get(host)).toEqual(registration);
    expect(fake.calls.slice(uninstallStart).some(({ args }) => args[1] === "remove")).toBe(false);
    await expect(access(join(graphcraftHome, "registrations", `${host}.json`))).resolves.toBe(
      undefined,
    );
  });

  it("uses a fresh private cwd for every host configuration transaction", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const fake = fakeHostRunner();
    const observedModes: number[] = [];
    const runner: HostCommandRunner = async (command, args, options) => {
      if (options?.cwd) observedModes.push((await stat(options.cwd)).mode & 0o777);
      return await fake.runner(command, args, options);
    };
    await writeFile(source, "#!/usr/bin/env node\n");

    await installHost(host, source, { graphcraftHome, runner });
    const installCalls = [...fake.calls];
    const installCwds = new Set(installCalls.map(({ cwd }) => cwd));
    expect(installCwds.size).toBe(1);
    const installCwd = installCalls[0]?.cwd;
    expect(installCwd).toBeTruthy();
    if (!installCwd) throw new Error("host configuration cwd was not recorded");
    await expect(access(installCwd)).rejects.toThrow();

    const uninstallStart = fake.calls.length;
    await uninstallHost(host, { graphcraftHome, runner });
    const uninstallCalls = fake.calls.slice(uninstallStart);
    const uninstallCwds = new Set(uninstallCalls.map(({ cwd }) => cwd));
    expect(uninstallCwds.size).toBe(1);
    const uninstallCwd = uninstallCalls[0]?.cwd;
    expect(uninstallCwd).toBeTruthy();
    expect(uninstallCwd).not.toBe(installCwd);
    if (!uninstallCwd) throw new Error("host uninstallation cwd was not recorded");
    await expect(access(uninstallCwd)).rejects.toThrow();
    if (process.platform !== "win32") expect(new Set(observedModes)).toEqual(new Set([0o700]));
  });

  it("never treats or overwrites a relative runtime argument as owned", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-relative-"));
    temporaryRoots.push(root);
    const graphcraftHome = join(root, "home");
    const source = join(root, "mcp.mjs");
    const relativeRuntime = join("relative-registration", GRAPHCRAFT_VERSION, "mcp.mjs");
    const fake = fakeHostRunner();
    fake.registrations.set(host, { command: "node", args: [relativeRuntime] });
    await writeFile(source, "#!/usr/bin/env node\n");

    await expect(
      installHost(host, source, { graphcraftHome, runner: fake.runner }),
    ).rejects.toThrow(/no verifiable Graphcraft ownership receipt or recognized legacy runtime/i);

    expect(isAbsolute(relativeRuntime)).toBe(false);
    expect(fake.registrations.get(host)).toEqual({
      command: "node",
      args: [relativeRuntime],
    });
    expect(fake.calls.filter(({ args }) => args[1] === "remove")).toHaveLength(0);
    expect(fake.calls.filter(({ args }) => args[1] === "add")).toHaveLength(0);
  });

  it.each([
    ["environment", { env: { NODE_OPTIONS: "--require hostile.cjs" } }],
    ["working directory", { cwd: "/hostile/working-directory" }],
  ] as const)("leaves an authority-bearing %s registration unchanged", async (_label, extra) => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const expectedRuntime = join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "mcp.mjs");
    const fake = fakeHostRunner();
    fake.registrations.set(host, {
      command: "node",
      args: [expectedRuntime],
      ...extra,
    });
    await writeFile(source, "#!/usr/bin/env node\n");

    await expect(
      installHost(host, source, { graphcraftHome, runner: fake.runner }),
    ).rejects.toThrow(/could not be inspected safely \(unknown\).*left unchanged/i);
    expect(fake.registrations.get(host)).toMatchObject(extra);
    expect(fake.calls.filter(({ args }) => ["remove", "add"].includes(args[1]!))).toHaveLength(0);
  });

  it("leaves a non-stdio transport unchanged", async () => {
    const { graphcraftHome, source } = await cleanLongPathFixture();
    const expectedRuntime = join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "mcp.mjs");
    const fake = fakeHostRunner();
    fake.registrations.set(host, {
      command: "node",
      args: [expectedRuntime],
      type: "http",
    });
    await writeFile(source, "#!/usr/bin/env node\n");

    await expect(updateHost(host, source, { graphcraftHome, runner: fake.runner })).rejects.toThrow(
      /could not be inspected safely \(unknown\).*left unchanged/i,
    );
    expect(fake.calls.filter(({ args }) => ["remove", "add"].includes(args[1]!))).toHaveLength(0);
  });
});

it("accepts one exact immutable runtime when two host installers publish concurrently", async () => {
  const { graphcraftHome, source } = await cleanLongPathFixture();
  const fake = fakeHostRunner();
  const bundledSource = "#!/usr/bin/env node\nconsole.log('concurrent exact');\n";
  await writeFile(source, bundledSource);
  let prepared = 0;
  let signalPrepared!: () => void;
  let releasePublish!: () => void;
  const bothPrepared = new Promise<void>((resolvePrepared) => {
    signalPrepared = resolvePrepared;
  });
  const publishReleased = new Promise<void>((resolvePublish) => {
    releasePublish = resolvePublish;
  });
  const boundary = async (point: "after_prepare" | "after_publish") => {
    if (point !== "after_prepare") return;
    prepared += 1;
    if (prepared === 2) signalPrepared();
    await publishReleased;
  };

  const codex = installHost("codex", source, {
    graphcraftHome,
    runner: fake.runner,
    runtimePublicationBoundary: boundary,
  });
  const claude = installHost("claude", source, {
    graphcraftHome,
    runner: fake.runner,
    runtimePublicationBoundary: boundary,
  });
  await bothPrepared;
  releasePublish();
  const [codexResult, claudeResult] = await Promise.all([codex, claude]);

  expect(codexResult.runtimeSha256).toBe(digest(bundledSource));
  expect(claudeResult.runtimeSha256).toBe(codexResult.runtimeSha256);
  await expect(readFile(codexResult.runtimePath, "utf8")).resolves.toBe(bundledSource);
  expect((await readdir(join(graphcraftHome, "runtime"))).sort()).toEqual([GRAPHCRAFT_VERSION]);
  expect(fake.registrations.has("codex")).toBe(true);
  expect(fake.registrations.has("claude")).toBe(true);
});

it("leaves a concurrent immutable runtime winner unchanged when bytes differ", async () => {
  const { root, graphcraftHome, source } = await cleanLongPathFixture();
  const competingSource = join(root, "competing-mcp.mjs");
  const fake = fakeHostRunner();
  const winningSource = "#!/usr/bin/env node\nconsole.log('winner');\n";
  const losingSource = "#!/usr/bin/env node\nconsole.log('loser');\n";
  await writeFile(source, winningSource);
  await writeFile(competingSource, losingSource);
  let signalWinnerPrepared!: () => void;
  let signalLoserPrepared!: () => void;
  let releaseWinner!: () => void;
  let releaseLoser!: () => void;
  const winnerPrepared = new Promise<void>((resolvePrepared) => {
    signalWinnerPrepared = resolvePrepared;
  });
  const loserPrepared = new Promise<void>((resolvePrepared) => {
    signalLoserPrepared = resolvePrepared;
  });
  const winnerReleased = new Promise<void>((resolvePublish) => {
    releaseWinner = resolvePublish;
  });
  const loserReleased = new Promise<void>((resolvePublish) => {
    releaseLoser = resolvePublish;
  });

  const winner = installHost("codex", source, {
    graphcraftHome,
    runner: fake.runner,
    async runtimePublicationBoundary(point) {
      if (point !== "after_prepare") return;
      signalWinnerPrepared();
      await winnerReleased;
    },
  });
  const loser = installHost("claude", competingSource, {
    graphcraftHome,
    runner: fake.runner,
    async runtimePublicationBoundary(point) {
      if (point !== "after_prepare") return;
      signalLoserPrepared();
      await loserReleased;
    },
  });
  await Promise.all([winnerPrepared, loserPrepared]);
  releaseWinner();
  const installed = await winner;
  releaseLoser();

  await expect(loser).rejects.toThrow(/concurrent.*different or unsafe contents.*left unchanged/i);
  await expect(readFile(installed.runtimePath, "utf8")).resolves.toBe(winningSource);
  expect(fake.registrations.has("codex")).toBe(true);
  expect(fake.registrations.has("claude")).toBe(false);
  expect((await readdir(join(graphcraftHome, "runtime"))).sort()).toEqual([GRAPHCRAFT_VERSION]);
});

it("leaves a Codex registration with inherited environment authority unchanged", async () => {
  const { graphcraftHome, source } = await cleanLongPathFixture();
  const expectedRuntime = join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "mcp.mjs");
  const fake = fakeHostRunner();
  fake.registrations.set("codex", {
    command: "node",
    args: [expectedRuntime],
    envVars: ["NODE_OPTIONS"],
  });
  await writeFile(source, "#!/usr/bin/env node\n");

  await expect(
    installHost("codex", source, { graphcraftHome, runner: fake.runner }),
  ).rejects.toThrow(/could not be inspected safely \(unknown\).*left unchanged/i);
  expect(fake.calls.filter(({ args }) => ["remove", "add"].includes(args[1]!))).toHaveLength(0);
});

it.each([
  "Project config (shared via .mcp.json)",
  "Dynamic config (from command line)",
  "User config",
])("leaves a Claude %s shadow registration unchanged", async (scope) => {
  const { graphcraftHome, source } = await cleanLongPathFixture();
  const expectedRuntime = join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "mcp.mjs");
  const fake = fakeHostRunner();
  fake.registrations.set("claude", {
    command: "node",
    args: [expectedRuntime],
    scope,
  });
  await writeFile(source, "#!/usr/bin/env node\n");

  await expect(
    installHost("claude", source, { graphcraftHome, runner: fake.runner }),
  ).rejects.toThrow(/could not be inspected safely \(unknown\).*left unchanged/i);
  expect(fake.registrations.get("claude")).toMatchObject({ scope });
  expect(fake.calls.filter(({ args }) => ["remove", "add"].includes(args[1]!))).toHaveLength(0);
});

it("leaves an ambiguous Claude multi-argument registration unchanged", async () => {
  const { graphcraftHome, source } = await cleanLongPathFixture();
  const fake = fakeHostRunner();
  fake.registrations.set("claude", {
    command: "node",
    args: ["--require", "/previous/graphcraft/mcp.mjs"],
  });
  await writeFile(source, "#!/usr/bin/env node\n");

  await expect(
    installHost("claude", source, { graphcraftHome, runner: fake.runner }),
  ).rejects.toThrow(/could not be inspected safely \(unknown\).*left unchanged/i);
  expect(fake.registrations.get("claude")).toEqual({
    command: "node",
    args: ["--require", "/previous/graphcraft/mcp.mjs"],
  });
  expect(fake.calls.filter(({ args }) => args[1] === "remove")).toHaveLength(0);
  expect(fake.calls.filter(({ args }) => args[1] === "add")).toHaveLength(0);
});

it("leaves an uncorroborated stale Claude path containing spaces unchanged", async () => {
  const { graphcraftHome, source } = await cleanLongPathFixture();
  const previousRuntime = "/previous path/graphcraft/mcp.mjs";
  const fake = fakeHostRunner({ claude: previousRuntime });
  await writeFile(source, "#!/usr/bin/env node\n");

  await expect(
    updateHost("claude", source, { graphcraftHome, runner: fake.runner }),
  ).rejects.toThrow(/could not be inspected safely \(unknown\).*left unchanged/i);
  expect(fake.registrations.get("claude")).toEqual({
    command: "node",
    args: [previousRuntime],
  });
  expect(fake.calls.filter(({ args }) => ["remove", "add"].includes(args[1]!))).toHaveLength(0);
});

it("uses a verified prior receipt to replace a stale Claude runtime path containing spaces", async () => {
  const { graphcraftHome, source } = await cleanLongPathFixture();
  const previousVersion = "0.1.1";
  const previousRuntime = join(graphcraftHome, "runtime", previousVersion, "mcp.mjs");
  const previousSource = "#!/usr/bin/env node\nconsole.log('previous');\n";
  await mkdir(join(graphcraftHome, "runtime", previousVersion), { recursive: true });
  await writeFile(previousRuntime, previousSource);
  const registrationsDirectory = join(graphcraftHome, "registrations");
  const receiptPath = join(registrationsDirectory, "claude.json");
  await mkdir(registrationsDirectory, { recursive: true });
  await writeFile(
    receiptPath,
    `${JSON.stringify({
      schemaVersion: 1,
      host: "claude",
      graphcraftVersion: previousVersion,
      runtimePath: previousRuntime,
      runtimeSha256: digest(previousSource),
    })}\n`,
  );
  if (process.platform !== "win32") {
    await chmod(registrationsDirectory, 0o700);
    await chmod(receiptPath, 0o600);
  }
  await writeFile(source, "#!/usr/bin/env node\nconsole.log('current');\n");
  const fake = fakeHostRunner({ claude: previousRuntime });

  const installed = await updateHost("claude", source, {
    graphcraftHome,
    runner: fake.runner,
  });

  expect(previousRuntime).toMatch(/clean home with spaces/u);
  expect(fake.registrations.get("claude")).toEqual({
    command: "node",
    args: [installed.runtimePath],
  });
  expect(fake.calls.filter(({ args }) => args[1] === "remove")).toHaveLength(1);
  expect(fake.calls.filter(({ args }) => args[1] === "add")).toHaveLength(1);
  await expect(
    readFile(join(graphcraftHome, "registrations", "claude.json"), "utf8"),
  ).resolves.toContain(`"graphcraftVersion": "${GRAPHCRAFT_VERSION}"`);
});

describe("legacy installation ownership", () => {
  const releasedRuntimeSha256 = "3292fed342cc27adfe78e5cd90c6ccf00b893934ddd24d31fe4339b5cc0bc342";

  it.each([
    "9522ea5f77bb680bc057e266fefb8732e5d572b5113f24e64537830f5159a643",
    "b9b431dfd9f7c95620970db978adaea5bc3b574adb492aa072ec03129069ea9e",
    "3292fed342cc27adfe78e5cd90c6ccf00b893934ddd24d31fe4339b5cc0bc342",
  ])("recognizes a released receipt-less runtime digest", (runtimeSha256) => {
    expect(isLegacyGraphcraftRuntimeSha256(runtimeSha256)).toBe(true);
  });

  it("does not recognize an arbitrary runtime digest", () => {
    expect(isLegacyGraphcraftRuntimeSha256(digest("unrelated runtime"))).toBe(false);
  });

  it("rejects a known released digest at a foreign absolute path", async () => {
    const { root, graphcraftHome } = await cleanLongPathFixture();

    expect(
      isManagedLegacyGraphcraftRuntime(
        graphcraftHome,
        join(root, "foreign", "mcp.mjs"),
        releasedRuntimeSha256,
      ),
    ).toBe(false);
    expect(
      isManagedLegacyGraphcraftRuntime(
        graphcraftHome,
        join(graphcraftHome, "runtime", "0.1.1", "mcp.mjs"),
        releasedRuntimeSha256,
      ),
    ).toBe(true);
  });
});

describe("host command bounds", () => {
  it("resolves after escalation even when the child never emits close", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const runner = createHostCommandRunner((() => child) as never, 10);

    const result = await runner("fixture-host", [], { maxOutputBytes: 1_024, timeoutMs: 10 });

    expect(result).toMatchObject({ exitCode: -1 });
    expect(result.stderr).toMatch(/timed out after 10 ms/i);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("rejects invalid bounds before spawning", async () => {
    await expect(
      defaultHostCommandRunner(process.execPath, ["--version"], { timeoutMs: 0 }),
    ).rejects.toThrow(/timeout must be a positive safe integer/i);
    await expect(
      defaultHostCommandRunner(process.execPath, ["--version"], { maxOutputBytes: Infinity }),
    ).rejects.toThrow(/output limit must be a positive safe integer/i);
  });

  it("terminates commands that exceed the combined output cap and keeps bounded diagnostics", async () => {
    const result = await defaultHostCommandRunner(
      process.execPath,
      ["-e", 'process.stdout.write("useful-start\\n" + "x".repeat(32 * 1024))'],
      { maxOutputBytes: 1_024, timeoutMs: 5_000 },
    );

    expect(result.exitCode).toBe(-1);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_024);
    expect(result.stdout).toContain("useful-start");
    expect(result.stderr).toMatch(/exceeded 1024 bytes.*truncated/i);
  });

  it("terminates timed-out commands while preserving captured stderr", async () => {
    const result = await defaultHostCommandRunner(
      process.execPath,
      ["-e", 'process.stderr.write("useful-timeout-detail\\n"); setInterval(() => {}, 1_000)'],
      { maxOutputBytes: 1_024, timeoutMs: 1_000 },
    );

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("useful-timeout-detail");
    expect(result.stderr).toMatch(/timed out after 1000 ms/i);
  });

  it("escalates a SIGTERM-resistant command within the fixed grace window", async () => {
    const started = Date.now();
    const result = await defaultHostCommandRunner(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM", () => {}); process.stderr.write("resisting\\n"); setInterval(() => {}, 1_000)',
      ],
      { maxOutputBytes: 1_024, timeoutMs: 1_000 },
    );

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("resisting");
    expect(result.stderr).toMatch(/timed out after 1000 ms/i);
    expect(Date.now() - started).toBeLessThan(3_500);
  });
});

describe("local viewer URL boundary", () => {
  it("canonicalizes only an exact loopback HTTP origin", () => {
    expect(validateLocalViewerUrl("http://127.0.0.1:43123/")).toBe("http://127.0.0.1:43123/");
    for (const value of [
      "https://127.0.0.1:43123/",
      "http://localhost:43123/",
      "http://127.0.0.1/",
      "http://user@127.0.0.1:43123/",
      "http://127.0.0.1:43123/?next=&calc",
      "http://127.0.0.1:43123/#fragment",
      "not-a-url",
    ]) {
      expect(() => validateLocalViewerUrl(value)).toThrow(/local viewer URL/i);
    }
  });
});

describe("host compatibility diagnostics", () => {
  const capabilities = (version?: string, installed = true): HostCapabilities => ({
    installed,
    authenticated: installed,
    ...(version ? { version } : {}),
    structuredOutput: installed,
    streamingEvents: installed,
    tokenReporting: installed,
  });

  it("distinguishes tested, newer, older, missing, and unparseable hosts", () => {
    expect(hostCompatibilityDiagnostic("codex", capabilities("codex-cli 0.144.6"))).toMatchObject({
      status: "compatible",
      exactTestedVersion: true,
    });
    expect(hostCompatibilityDiagnostic("codex", capabilities("codex-cli 0.145.0"))).toMatchObject({
      status: "compatible",
      exactTestedVersion: false,
    });
    expect(hostCompatibilityDiagnostic("codex", capabilities("codex-cli 0.143.9"))).toMatchObject({
      status: "unsupported",
    });
    expect(hostCompatibilityDiagnostic("claude", capabilities(undefined, false))).toMatchObject({
      status: "missing",
    });
    expect(hostCompatibilityDiagnostic("claude", capabilities("development build"))).toMatchObject({
      status: "unknown",
    });
  });
});
