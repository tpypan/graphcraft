import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileGraph, compileRunContract, createRunEvent, reduceEvents } from "@graphcraft/core";
import type { ProbePlan } from "@graphcraft/core";
import { DEFAULT_ARTIFACT_POLICY } from "@graphcraft/runtime";
import {
  GRAPHCRAFT_VERSION,
  assessTaskShape,
  consoleObserver,
  contractView,
  prepareFinishLine,
  recoveryHint,
  renderContract,
  renderRunInspection,
  renderRunList,
  renderRunStatus,
  resolveGraphcraftHome,
  stageBundledMcp,
  stateView,
  supervisorView,
} from "./index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
  it("redacts secret-like observer output before writing to the terminal", () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));

    consoleObserver(false)({
      type: "host",
      message:
        "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz from https://user:password@example.test/path?token=query-secret",
    });

    expect(output.join("\n")).toContain("[REDACTED]");
    expect(output.join("\n")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(output.join("\n")).not.toContain("user:password");
    expect(output.join("\n")).not.toContain("query-secret");
  });

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
      prepareFinishLine("Implement the feature and get the PR green", "/tmp/unused", "pr_open"),
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

  it("shows pr_green as a token-free terminal wait without merge authority", () => {
    const contract = compileRunContract("Implement the feature and get the PR green", {
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
    const rendered = renderContract(contract, graph);

    expect(rendered).toContain("Finish line    pr_green");
    expect(rendered).toContain("github_read");
    expect(rendered).not.toContain("merge");
    expect(contractView(contract, graph)).toMatchObject({
      planShape: "implement → verify → commit → push → pull-request → pr-green",
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

    const state = reduceEvents([created, usage]);
    const rendered = renderRunStatus(state, contract, graph);
    expect(rendered).toContain("Finish line   local_verified");
    expect(rendered).toContain("Status        awaiting_approval");
    expect(rendered).toContain("cached 2, uncached 8, output 4, reasoning 1, total 14");
    expect(rendered).toContain(`graphcraft resume ${contract.runId.slice(0, 8)} --yes`);
    expect(
      renderRunInspection({
        state,
        contract,
        graph,
        graphHistory: [],
        artifactInventory: {
          schemaVersion: 1,
          runId: contract.runId,
          policy: DEFAULT_ARTIFACT_POLICY,
          sourceBytes: 0,
          storedBytes: 0,
          omittedBytes: 0,
          entries: [],
          updatedAt: new Date().toISOString(),
        },
      }),
    ).toContain("Governance");
  });

  it("renders stable run selection and actionable recovery hints", () => {
    const runs = renderRunList([
      {
        runId: "11111111-1111-4111-8111-111111111111",
        task: "First task",
        finishLine: "committed",
        status: "completed",
        updatedAt: "2026-07-22T12:00:00.000Z",
      },
      {
        runId: "22222222-2222-4222-8222-222222222222",
        task: "Second task",
        finishLine: "pr_green",
        status: "blocked",
        updatedAt: "2026-07-22T11:00:00.000Z",
      },
    ]);

    expect(runs).toContain("11111111");
    expect(runs).toContain("22222222");
    expect(runs).toContain("Use the displayed run prefix");
    expect(recoveryHint("Run reference abc matched 0 runs")).toContain("graphcraft runs");
    expect(recoveryHint("GitHub snapshot preflight failed: not authenticated")).toContain(
      "graphcraft doctor",
    );
    expect(recoveryHint("Future storage version 999 is unsupported")).toContain("left unchanged");
    expect(recoveryHint("Run event log has invalid JSON in trailing record at byte 42")).toContain(
      "known-good copy",
    );
    expect(recoveryHint("The worktree is locked by another supervisor")).toContain(
      "graphcraft supervisors",
    );
  });
});
