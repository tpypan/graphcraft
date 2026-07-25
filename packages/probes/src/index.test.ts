import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  type ProbePlan,
  type ProbeSpec,
} from "@graphcraft/core";
import {
  discoverProbePlan,
  resolvePackageScriptCommand,
  runProbe,
  runProbes,
  validateProbePlan,
  workspaceDigest,
} from "./index.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createRepository(): Promise<{ root: string; sha: string }> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-probes-"));
  temporaryRoots.push(root);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Graphcraft Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "graphcraft@example.test"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "commit.gpgSign", "false"], { cwd: root });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "checkout.ts"), "export const apiVersion = 'v2';\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "probe-fixture",
      packageManager: "pnpm@11.15.1",
      scripts: {
        check: "pnpm test",
        "test:unit": "vitest run unit",
        "test:checkout": "vitest run checkout",
        "test:integration": "vitest run integration",
        "check:migration": "node check-migration.mjs",
        typecheck: "tsc --noEmit",
        lint: "eslint .",
        "audit:static": "node audit.mjs",
      },
    }),
  );
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  return { root, sha: stdout.trim() };
}

function completionIds(plan: ProbePlan): string[] {
  return plan.items.filter(({ phase }) => phase === "completion").map(({ probe }) => probe.id);
}

describe("task-specific probe planning", () => {
  it("constructs Windows package commands only from validated metadata tokens", () => {
    expect(
      resolvePackageScriptCommand("pnpm@11.15.1", "test:unit", {
        platform: "win32",
        comSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "corepack pnpm test:unit"],
      platforms: ["win32"],
    });
    expect(resolvePackageScriptCommand("npm@10.8.2", "test:unit", { platform: "linux" })).toEqual({
      command: "npm",
      args: ["run", "test:unit"],
      platforms: ["darwin", "linux"],
    });

    for (const manager of ["npm & calc", "pnpm\ncalc", "yarn|calc", "bun@1.0.0"])
      expect(resolvePackageScriptCommand(manager, "test:unit", { platform: "win32" })).toBe(
        undefined,
      );
    for (const script of ["test & calc", "%PATH%", "test\ncalc", "test|calc", "../test"])
      expect(resolvePackageScriptCommand("npm@10.8.2", script, { platform: "win32" })).toBe(
        undefined,
      );
  });

  it("skips unsafe repository-controlled package script names", async () => {
    const { root, sha } = await createRepository();
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["test & calc"] = "node hostile.mjs";
    manifest.scripts["test\ncalc"] = "node hostile.mjs";
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));

    const plan = await discoverProbePlan(root, "Fix the unit regression", sha);

    expect(plan.items.map(({ source }) => source)).not.toEqual(
      expect.arrayContaining(["package.json script test & calc", "package.json script test\ncalc"]),
    );
    expect(completionIds(plan)).toContain("package-root-test-unit");
  });

  it.skipIf(process.platform === "win32")(
    "permits internal package symlinks and refuses external package discovery",
    async () => {
      const { root, sha } = await createRepository();
      await mkdir(join(root, "linked"));
      await symlink("../package.json", join(root, "linked", "package.json"), "file");
      await execFileAsync("git", ["add", "linked/package.json"], { cwd: root });
      await expect(discoverProbePlan(root, "Fix the linked unit regression", sha)).resolves.toEqual(
        expect.objectContaining({ family: "bug" }),
      );

      const outside = await mkdtemp(join(tmpdir(), "graphcraft-probes-outside-"));
      temporaryRoots.push(outside);
      const outsideManifest = join(outside, "private-package.json");
      await writeFile(
        outsideManifest,
        JSON.stringify({ name: "private-name", scripts: { test: "node private-test.mjs" } }),
      );
      await rm(join(root, "linked", "package.json"));
      await symlink(outsideManifest, join(root, "linked", "package.json"), "file");

      const error = await discoverProbePlan(root, "Fix the linked unit regression", sha).catch(
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({ kind: "outside_repository" });
      expect((error as Error).message).not.toContain(outside);
      expect((error as Error).message).not.toContain("private-name");
    },
  );

  it("selects distinct focused and regression evidence for every local task family", async () => {
    const { root, sha } = await createRepository();
    const plans = await Promise.all([
      discoverProbePlan(root, "Fix the checkout regression", sha),
      discoverProbePlan(root, "Add a checkout acceptance workflow", sha),
      discoverProbePlan(root, "Migrate API usage from v2 to v3", sha),
      discoverProbePlan(root, "Refactor the checkout module without behavior changes", sha),
      discoverProbePlan(root, "Audit static checkout boundaries", sha),
    ]);

    expect(plans.map(({ family }) => family)).toEqual([
      "bug",
      "feature",
      "migration",
      "refactor",
      "audit",
    ]);
    expect(completionIds(plans[0]!)).toEqual([
      "package-root-test-checkout",
      "package-root-test-unit",
      "package-root-check",
    ]);
    expect(completionIds(plans[1]!)).toEqual([
      "package-root-test-checkout",
      "package-root-test-integration",
      "package-root-check",
    ]);
    expect(completionIds(plans[2]!)).toEqual([
      "package-root-check-migration",
      "package-root-check",
    ]);
    expect(completionIds(plans[3]!)).toEqual([
      "package-root-test-checkout",
      "package-root-test-unit",
      "package-root-check",
    ]);
    expect(completionIds(plans[4]!)).toEqual([
      "package-root-audit-static",
      "package-root-lint",
      "package-root-check",
      "audit-task-inventory",
    ]);
    for (const plan of plans) {
      expect(
        plan.items.some(({ phase, purpose }) => phase === "progress" && purpose === "inventory"),
      ).toBe(true);
      expect(
        plan.items.some(({ phase, purpose }) => phase === "completion" && purpose === "regression"),
      ).toBe(true);
    }
  });

  it("executes bounded repository inventories without shell interpretation", async () => {
    const { root } = await createRepository();
    const first = await runProbe(
      {
        id: "v2-inventory",
        kind: "repository_inventory",
        paths: ["."],
        terms: ["v2"],
      },
      root,
    );
    expect(first.result).toMatchObject({ passed: true, kind: "repository_inventory" });
    expect(first.result.summary).toContain("src/checkout.ts");

    await writeFile(join(root, "src", "checkout.ts"), "export const apiVersion = 'v3';\n");
    const second = await runProbe(
      {
        id: "v2-inventory",
        kind: "repository_inventory",
        paths: ["."],
        terms: ["v2"],
      },
      root,
    );
    expect(second.result.signature).not.toBe(first.result.signature);
    expect(second.result.summary).toContain("No tracked files match");
  });

  it("versions probe and workspace signatures without ambient collation in v2", async () => {
    const { root, sha } = await createRepository();
    const specs: ProbeSpec[] = [
      {
        id: "command-check",
        kind: "command",
        command: process.execPath,
        args: ["-e", 'process.stdout.write("portable probe\\n")'],
        expectedExitCode: 0,
        timeoutMs: 1_000,
      },
      {
        id: "file-check",
        kind: "file",
        path: "package.json",
        shouldExist: true,
        contains: "probe-fixture",
      },
      {
        id: "inventory-check",
        kind: "repository_inventory",
        paths: ["."],
        terms: ["apiVersion"],
      },
      {
        id: "diff-check",
        kind: "git_diff",
        baseSha: sha,
        requireChanges: false,
      },
    ];
    const legacyCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
      this: string,
      other: string,
    ) {
      const left = String(this);
      return left < other ? 1 : left > other ? -1 : 0;
    });
    const legacy = await runProbes(specs, root, undefined, LEGACY_CANONICAL_HASH_ALGORITHM);
    const defaultLegacy = await runProbe(specs[1]!, root);
    const legacyWorkspace = await workspaceDigest(root);
    expect(legacyCompare).toHaveBeenCalled();
    expect(defaultLegacy.result.signature).toBe(legacy[1]?.result.signature);
    legacyCompare.mockRestore();

    const portableCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("portable probe hashing used ambient locale ordering");
    });
    const portable = await runProbes(specs, root, undefined, PORTABLE_CANONICAL_HASH_ALGORITHM);
    const portableWorkspace = await workspaceDigest(root, PORTABLE_CANONICAL_HASH_ALGORITHM);

    expect(portableCompare).not.toHaveBeenCalled();
    expect(portable.map(({ result }) => result.passed)).toEqual([true, true, true, true]);
    expect(portable.slice(0, 3).map(({ result }) => result.signature)).not.toEqual(
      legacy.slice(0, 3).map(({ result }) => result.signature),
    );
    expect(portable[3]?.result.signature).toBe(legacy[3]?.result.signature);
    expect(portableWorkspace).not.toBe(legacyWorkspace);
  });

  it("adds a runtime-owned GitHub lifecycle probe only for a PR finish line", async () => {
    const { root, sha } = await createRepository();
    const local = await discoverProbePlan(root, "Add a checkout workflow", sha);
    const pullRequest = await discoverProbePlan(root, "Add a checkout workflow", sha, {
      finishLine: "pr_open",
    });
    const lifecycle = pullRequest.items.find(({ probe }) => probe.kind === "github_snapshot");

    expect(local.items.some(({ probe }) => probe.kind === "github_snapshot")).toBe(false);
    expect(lifecycle).toMatchObject({
      phase: "progress",
      purpose: "acceptance",
      probe: {
        id: "pull-request-lifecycle",
        kind: "github_snapshot",
        pullRequest: "run_branch",
        expectedState: "open",
        requiredChecks: "observe",
        reviewThreads: "observe",
      },
    });
    if (!lifecycle) throw new Error("Expected a lifecycle probe");
    await expect(runProbe(lifecycle.probe, root)).rejects.toThrow(/executed by the runtime/);
  });

  it("keeps raw command output out of model-visible probe summaries", async () => {
    const { root } = await createRepository();
    await writeFile(join(root, "noisy.mjs"), `console.error("${"failure ".repeat(1_000)}");\n`);

    const executed = await runProbe(
      {
        id: "noisy-check",
        kind: "command",
        command: "node",
        args: ["noisy.mjs"],
        expectedExitCode: 0,
        timeoutMs: 1_000,
      },
      root,
    );

    expect(executed.output.length).toBeGreaterThan(5_000);
    expect(executed.result.summary.length).toBeLessThan(1_100);
    expect(executed.result.summary).toContain("…");
  });

  it("bounds command output without changing exit-code evidence", async () => {
    const { root } = await createRepository();
    const executed = await runProbe(
      {
        id: "flood-check",
        kind: "command",
        command: process.execPath,
        args: [
          "-e",
          'process.stdout.write("x".repeat(1_100_000)); process.stderr.write("y".repeat(1_100_000));',
        ],
        expectedExitCode: 0,
        timeoutMs: 5_000,
      },
      root,
    );

    expect(executed.result.passed).toBe(true);
    expect(executed.result.summary).toContain("Output truncated by Graphcraft");
    expect(executed.output).toContain("GRAPHCRAFT STDOUT TRUNCATED");
    expect(executed.output).toContain("GRAPHCRAFT STDERR TRUNCATED");
    expect(Buffer.byteLength(executed.output)).toBeLessThan(2_100_000);
  });

  it("distinguishes truncated failures with identical retained prefixes and byte counts", async () => {
    const { root } = await createRepository();
    const execute = async (tail: string) =>
      await runProbe(
        {
          id: "truncated-tail-check",
          kind: "command",
          command: process.execPath,
          args: [
            "-e",
            `process.stdout.write("x".repeat(1_100_000) + ${JSON.stringify(tail)}); process.exitCode = 1;`,
          ],
          expectedExitCode: 0,
          timeoutMs: 5_000,
        },
        root,
      );

    const firstTail = "TAIL_ONE_1234567890";
    const secondTail = "TAIL_TWO_1234567890";
    const first = await execute(firstTail);
    const second = await execute(secondTail);

    expect(first.output).not.toContain(firstTail);
    expect(second.output).not.toContain(secondTail);
    expect(Buffer.byteLength(first.output)).toBe(Buffer.byteLength(second.output));
    expect(first.result.signature).not.toBe(second.result.signature);
  });

  it("rejects unsafe or unsupported edited probe plans", async () => {
    const { root } = await createRepository();
    const invalid = {
      schemaVersion: 1,
      family: "feature",
      items: [
        {
          phase: "completion",
          purpose: "regression",
          source: "test",
          probe: {
            id: "unsafe",
            kind: "command",
            command: "npm",
            args: ["test"],
            cwd: "../outside",
            expectedExitCode: 0,
            timeoutMs: 1_000,
          },
        },
      ],
    } as ProbePlan;
    await expect(validateProbePlan(invalid, root)).rejects.toThrow(/working directory/);
  });

  it.skipIf(process.platform === "win32")(
    "revalidates file probes and command working directories at execution",
    async () => {
      const { root } = await createRepository();
      const outside = await mkdtemp(join(tmpdir(), "graphcraft-probe-boundary-outside-"));
      temporaryRoots.push(outside);
      await mkdir(join(root, "safe-cwd"));
      await symlink("safe-cwd", join(root, "probe-cwd"), "dir");
      const plan: ProbePlan = {
        schemaVersion: 1,
        family: "feature",
        items: [
          {
            phase: "completion",
            purpose: "regression",
            source: "validated command",
            probe: {
              id: "validated-command",
              kind: "command",
              command: process.execPath,
              args: ["-e", "process.exit(0)"],
              cwd: "probe-cwd",
              expectedExitCode: 0,
              timeoutMs: 1_000,
            },
          },
        ],
      };
      await expect(validateProbePlan(plan, root)).resolves.toEqual(plan);

      await rm(join(root, "probe-cwd"));
      await symlink(outside, join(root, "probe-cwd"), "dir");
      await expect(runProbe(plan.items[0]!.probe, root)).rejects.toMatchObject({
        kind: "outside_repository",
      });

      const outsideFile = join(outside, "private.txt");
      await writeFile(outsideFile, "private probe value\n");
      await symlink(outsideFile, join(root, "linked-file.txt"), "file");
      const fileError = await runProbe(
        {
          id: "linked-file",
          kind: "file",
          path: "linked-file.txt",
          shouldExist: true,
          contains: "private probe value",
        },
        root,
      ).catch((failure: unknown) => failure);
      expect(fileError).toMatchObject({ kind: "outside_repository" });
      expect((fileError as Error).message).not.toContain(outside);
      expect((fileError as Error).message).not.toContain("private probe value");

      await symlink("probe-cwd/missing.txt", join(root, "chained-missing.txt"), "file");
      await expect(
        runProbe(
          {
            id: "chained-missing",
            kind: "file",
            path: "chained-missing.txt",
            shouldExist: false,
          },
          root,
        ),
      ).rejects.toMatchObject({ kind: "outside_repository" });
    },
  );
});
