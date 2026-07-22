import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ProbePlan } from "@graphcraft/core";
import { discoverProbePlan, runProbe, validateProbePlan } from "./index.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
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
});
