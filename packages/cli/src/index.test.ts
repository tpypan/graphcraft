import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileGraph, compileRunContract, createRunEvent, reduceEvents } from "@graphcraft/core";
import type { ProbePlan } from "@graphcraft/core";
import {
  GRAPHCRAFT_VERSION,
  assessTaskShape,
  contractView,
  prepareFinishLine,
  renderContract,
  resolveGraphcraftHome,
  stageBundledMcp,
  stateView,
  supervisorView,
} from "./index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("package installation", () => {
  it("stages the MCP runtime outside a temporary package-manager cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-install-test-"));
    temporaryRoots.push(root);
    const packageCache = join(root, "package-cache");
    const source = join(packageCache, "mcp.mjs");
    const graphcraftHome = join(root, "home");
    await mkdir(packageCache);
    await writeFile(source, "#!/usr/bin/env node\nconsole.log('graphcraft');\n");

    const installed = await stageBundledMcp(source, graphcraftHome);

    expect(installed).toBe(join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "mcp.mjs"));
    expect(await readFile(installed, "utf8")).toContain("graphcraft");
    await rm(packageCache, { recursive: true, force: true });
    await expect(readFile(installed, "utf8")).resolves.toContain("graphcraft");
  });

  it("honors an explicit Graphcraft home", () => {
    expect(resolveGraphcraftHome("./custom-home")).toBe(join(process.cwd(), "custom-home"));
  });
});

describe("supervisor projection", () => {
  it("reports an invalid projection without hiding durable run status", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-supervisor-view-test-"));
    temporaryRoots.push(root);
    const runId = "11111111-1111-4111-8111-111111111111";
    const supervisorRoot = join(root, ".graphcraft", "supervisors", runId);
    await mkdir(supervisorRoot, { recursive: true });
    await writeFile(join(supervisorRoot, "broken.json"), '{"schemaVersion":999}\n');

    await expect(supervisorView(root, runId)).resolves.toMatchObject({ health: "invalid" });
  });
});

describe("run approval", () => {
  it("uses task-shape evidence instead of request length for the small-task bypass", () => {
    expect(
      assessTaskShape(
        "Please update the wording in README.md so the installation requirement is clearer",
      ),
    ).toMatchObject({ bypass: true, signals: { pathCount: 1, localized: true } });
    expect(assessTaskShape("Implement OAuth support")).toMatchObject({ bypass: false });
    expect(assessTaskShape("Fix auth.ts and add regression tests")).toMatchObject({
      bypass: false,
      signals: { multipleSteps: true },
    });
    expect(assessTaskShape("Migrate every package and wait for CI")).toMatchObject({
      bypass: false,
      signals: { broadScope: true, durableWorkflow: true, externalWait: true },
    });
  });

  it("does not silently narrow an explicit push outcome", async () => {
    await expect(
      prepareFinishLine(
        "Implement the feature and push the verified changes",
        "/tmp/unused",
        "committed",
      ),
    ).rejects.toThrow(/will not silently narrow/);
    await expect(
      prepareFinishLine("Implement the feature and open a pull request", "/tmp/unused", "pushed"),
    ).rejects.toThrow(/will not silently narrow/);
    await expect(
      prepareFinishLine("Force-push the published branch", "/tmp/unused", "pushed"),
    ).rejects.toThrow(/will not infer/);
  });

  it("shows the persisted graph shape and executable completion proof", () => {
    const contract = compileRunContract("Implement a substantial feature", {
      root: "/tmp/example",
      baseRef: "main",
      baseSha: "abc123",
    });
    const graph = compileGraph(contract, [
      {
        id: "tests",
        kind: "command",
        command: "pnpm",
        args: ["test"],
        expectedExitCode: 0,
        timeoutMs: 1_000,
      },
    ]);

    expect(contractView(contract, graph)).toMatchObject({
      planShape: "implement → verify",
      completionProbes: [{ id: "tests", command: "pnpm test" }],
    });
    expect(renderContract(contract, graph)).toContain("Completion     tests");
  });

  it("shows pushed as a distinct permissioned finish line", () => {
    const contract = compileRunContract(
      "Implement the feature and push the verified changes",
      { root: "/tmp/example", baseRef: "main", baseSha: "abc123" },
      { finishLine: "pushed" },
    );
    const graph = compileGraph(contract, [
      {
        id: "tests",
        kind: "command",
        command: "pnpm",
        args: ["test"],
        expectedExitCode: 0,
        timeoutMs: 1_000,
      },
    ]);
    const rendered = renderContract(contract, graph);

    expect(rendered).toContain("Finish line    pushed");
    expect(rendered).toContain("push");
    expect(rendered).toContain("github_write");
    expect(contractView(contract, graph)).toMatchObject({
      planShape: "implement → verify → commit → push",
    });
  });

  it("shows pr_open as a distinct terminal graph boundary", () => {
    const contract = compileRunContract("Implement the feature and open a pull request", {
      root: "/tmp/example",
      baseRef: "main",
      baseSha: "abc123",
    });
    const graph = compileGraph(contract, [
      {
        id: "tests",
        kind: "command",
        command: "pnpm",
        args: ["test"],
        expectedExitCode: 0,
        timeoutMs: 1_000,
      },
    ]);
    const probePlan: ProbePlan = {
      schemaVersion: 1,
      family: "feature",
      items: [
        {
          phase: "progress",
          purpose: "acceptance",
          source: "GitHub lifecycle",
          probe: {
            id: "pull-request-lifecycle",
            kind: "github_snapshot",
            pullRequest: "run_branch",
            expectedState: "open",
            requiredChecks: "observe",
            reviewThreads: "observe",
          },
        },
      ],
    };
    const rendered = renderContract(contract, graph, probePlan);

    expect(rendered).toContain("Finish line    pr_open");
    expect(rendered).toContain("pull-request-lifecycle");
    expect(contractView(contract, graph, probePlan)).toMatchObject({
      planShape: "implement → verify → commit → push → pull-request",
      progressProbes: [
        {
          id: "pull-request-lifecycle",
          kind: "github_snapshot",
          pullRequest: "run_branch",
          expectedState: "open",
          requiredChecks: "observe",
          reviewThreads: "observe",
        },
      ],
    });
  });

  it("exposes whole-run, phase, and node token costs in status output", () => {
    const contract = compileRunContract("Implement a substantial feature", {
      root: "/tmp/example",
      baseRef: "main",
      baseSha: "abc123",
    });
    const graph = compileGraph(contract, []);
    const created = createRunEvent({
      sequence: 1,
      actor: "runtime",
      causationId: contract.runId,
      type: "run.created",
      data: { contract, graph, nodeIds: graph.nodes.map(({ id }) => id) },
    });
    const usage = createRunEvent({
      sequence: 2,
      actor: "host",
      causationId: "worker-invocation",
      type: "tokens.recorded",
      data: {
        phase: "worker",
        nodeId: "implement",
        usage: {
          input: 10,
          cachedInput: 2,
          uncachedInput: 8,
          output: 4,
          reasoning: 1,
          total: 14,
          availability: {
            input: "reported",
            cachedInput: "reported",
            uncachedInput: "derived",
            output: "reported",
            reasoning: "reported",
            total: "derived",
          },
        },
      },
    });

    expect(stateView(reduceEvents([created, usage]), contract)).toMatchObject({
      tokenReport: {
        receipts: 1,
        totals: { total: 14 },
        byPhase: { worker: { total: 14 } },
        byNode: { implement: { total: 14 } },
        reconciled: true,
      },
    });
  });
});
