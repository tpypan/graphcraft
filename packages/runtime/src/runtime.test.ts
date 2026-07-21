import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  evidenceSnapshot,
  interruptionReason,
  reconcilePersistedInvocation,
} from "@graphcraft/core";
import type {
  HostAdapter,
  HostCapabilities,
  HostEvent,
  InvocationRecord,
  PlanningRequest,
  PlanningResult,
  ReconciliationResult,
  WorkerRequest,
} from "@graphcraft/core";
import { createRun, executeRun } from "./runner.ts";
import { requestRunControl } from "./control.ts";
import { RunLock } from "./lock.ts";
import { createRunWorkspace, discoverPlanningEvidence } from "./repository.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepository(requiredFile = "feature.txt"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-runtime-test-"));
  temporaryRoots.push(root);
  const repository = join(root, "repo");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Graphcraft Test");
  await git(repository, "config", "user.email", "graphcraft@example.test");
  await git(repository, "config", "commit.gpgSign", "false");
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      name: "fixture",
      private: true,
      scripts: { test: "node verify.mjs" },
    }),
  );
  await writeFile(
    join(repository, "verify.mjs"),
    `import { access } from "node:fs/promises";\nawait access(new URL("./${requiredFile}", import.meta.url));\n`,
  );
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "fixture");
  return repository;
}

class FakeAdapter implements HostAdapter {
  readonly id = "test" as const;
  readonly calls: string[] = [];
  readonly requests: WorkerRequest[] = [];
  private readonly act: (
    request: WorkerRequest,
    call: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly authenticated: boolean;
  private readonly failureCause: "host_crash" | "timeout" | undefined;

  constructor(
    act: (request: WorkerRequest, call: number, signal: AbortSignal) => Promise<void>,
    authenticated = true,
    failureCause?: "host_crash" | "timeout",
  ) {
    this.act = act;
    this.authenticated = authenticated;
    this.failureCause = failureCause;
  }

  async probe(): Promise<HostCapabilities> {
    return {
      installed: true,
      authenticated: this.authenticated,
      version: "test",
      structuredOutput: true,
      streamingEvents: true,
      tokenReporting: true,
    };
  }

  async plan(request: PlanningRequest, _signal: AbortSignal): Promise<PlanningResult> {
    const nodes: PlanningResult["plan"]["nodes"] = [
      {
        id: "investigate",
        kind: "investigation",
        objective: "Inspect repository evidence and identify the implementation boundary",
        dependsOn: [],
        scope: ["**/*"],
        contextSelector: {
          includeRepositoryInstructions: true,
          predecessorResults: [],
          relevantPaths: ["package.json", "verify.mjs"],
        },
        progressProbes: [],
        completionProbes: [],
        sideEffectClass: "none",
      },
      {
        id: "implement",
        kind: "implementation",
        objective: request.contract.outcome,
        dependsOn: ["investigate"],
        scope: ["**/*"],
        contextSelector: {
          includeRepositoryInstructions: true,
          predecessorResults: ["investigate"],
          relevantPaths: ["package.json"],
        },
        progressProbes: [
          {
            id: "workspace-diff",
            kind: "git_diff",
            baseSha: request.contract.repository.baseSha,
            requireChanges: true,
          },
        ],
        completionProbes: [],
        sideEffectClass: "workspace_write",
      },
      {
        id: "verify",
        kind: "verification",
        objective: `Verify the approved outcome: ${request.contract.outcome}`,
        dependsOn: ["implement"],
        scope: ["**/*"],
        contextSelector: {
          includeRepositoryInstructions: true,
          predecessorResults: ["implement"],
          relevantPaths: ["package.json", "verify.mjs"],
        },
        progressProbes: [],
        completionProbes: request.verificationProbes,
        sideEffectClass: "none",
      },
    ];
    if (request.contract.finishLine.kind === "committed") {
      nodes.push({
        id: "commit",
        kind: "commit",
        objective: "Commit the accepted run changes",
        dependsOn: ["verify"],
        scope: ["**/*"],
        contextSelector: {
          includeRepositoryInstructions: true,
          predecessorResults: ["verify"],
          relevantPaths: [],
        },
        progressProbes: [],
        completionProbes: [],
        sideEffectClass: "git_commit",
      });
    }
    return {
      plan: { schemaVersion: 1, family: "feature", nodes },
      usage: { input: 5, cachedInput: 1, output: 2, reasoning: 0, total: 7 },
    };
  }

  async *execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent> {
    this.calls.push(request.capsule.nodeId);
    this.requests.push(request);
    yield { type: "started", invocationId: request.invocationId };
    yield { type: "session", hostSessionId: request.resumeSessionId ?? request.invocationId };
    if (this.failureCause) {
      yield {
        type: "error",
        message: this.failureCause === "timeout" ? "host exceeded its deadline" : "host exited 1",
        cause: this.failureCause,
      };
      return;
    }
    await this.act(request, this.calls.length, signal);
    if (signal.aborted) {
      const reason = interruptionReason(signal.reason);
      yield {
        type: "terminated",
        termination: {
          cause: reason.cause,
          outcome: "graceful",
          requestedSignal: "SIGTERM",
          exitCode: null,
          exitSignal: "SIGTERM",
        },
      };
      return;
    }
    yield {
      type: "usage",
      usage: { input: 10, cachedInput: 2, output: 4, reasoning: 0, total: 14 },
    };
    yield {
      type: "result",
      result: {
        status: "completed",
        summary: `Completed ${request.capsule.nodeId}`,
        changedPaths: [],
        evidence: ["fixture evidence"],
      },
    };
  }

  async reconcile(invocation: InvocationRecord): Promise<ReconciliationResult> {
    return reconcilePersistedInvocation(invocation);
  }
}

describe("durable runtime", () => {
  it("selects bounded task-matched source snippets for planning evidence", async () => {
    const repository = await createRepository();
    await mkdir(join(repository, "src"));
    await writeFile(
      join(repository, "src", "graph.ts"),
      "export function classifyTask(task: string) { return task.includes('fix') ? 'bug' : 'feature'; }\n",
    );
    await git(repository, "add", "src/graph.ts");
    await git(repository, "commit", "-m", "add classifier");

    const evidence = await discoverPlanningEvidence(
      repository,
      "Fix task classification without matching fixture path substrings",
    );

    expect(evidence.files.map(({ path }) => path)).toContain("src/graph.ts");
    expect(evidence.files.find(({ path }) => path === "src/graph.ts")?.content).toContain(
      "classifyTask",
    );
    expect(evidence.files.map(({ path }) => path)).toContain("package.json");
  });

  it("persists and executes a validated host-planned graph with selected predecessor evidence", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      if (request.capsule.nodeId === "implement")
        await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
      planner: adapter,
    });

    expect(created.graph.nodes.map(({ id }) => id)).toEqual(["investigate", "implement", "verify"]);
    expect((await created.store.loadState()).tokens.total).toBe(7);

    const state = await executeRun({ store: created.store, adapter, approve: true });

    expect(state.status).toBe("completed");
    expect(state.nodes.investigate?.lastProgress).toBe("learning");
    expect(adapter.calls).toEqual(["investigate", "implement"]);
    expect(adapter.requests[1]?.capsule.predecessorEvidence).toEqual([
      "investigate: Completed investigate",
    ]);
    expect(adapter.requests[0]?.allowedTools).toEqual(["read"]);
    expect(adapter.requests[1]?.allowedTools).toEqual(["read", "write", "shell"]);
    expect(state.tokens.total).toBe(35);
  });

  it("completes a local run in an isolated worktree and records tokens", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    const state = await executeRun({ store: created.store, adapter, approve: true });

    expect(state.status).toBe("completed");
    expect(state.tokens.total).toBe(14);
    expect(state.nodes.implement?.status).toBe("accepted");
    expect(state.nodes.verify?.status).toBe("accepted");
    expect(adapter.calls).toEqual(["implement"]);
    expect((await created.store.loadEvents()).map(({ type }) => type)).toContain("run.completed");

    const resumed = await executeRun({ store: created.store, adapter, approve: true });
    expect(resumed.status).toBe("completed");
    expect(adapter.calls).toEqual(["implement"]);
  });

  it("amends the graph once and repairs a deterministic failure", async () => {
    const repository = await createRepository("repair.txt");
    const adapter = new FakeAdapter(async (request) => {
      const file = request.capsule.nodeId.startsWith("repair-") ? "repair.txt" : "feature.txt";
      await writeFile(join(request.repositoryPath, file), "done\n");
    });
    const created = await createRun(
      "Implement and repair a substantial feature across the fixture",
      {
        cwd: repository,
      },
    );
    const state = await executeRun({ store: created.store, adapter, approve: true });
    const graph = await created.store.loadGraph();

    expect(state.status).toBe("completed");
    expect(adapter.calls).toEqual(["implement", "repair-verify-1"]);
    expect(graph.revision).toBe(1);
    expect(graph.nodes.map(({ id }) => id)).toContain("repair-verify-1");
  });

  it("stops safely when a write task makes no measurable progress", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async () => undefined);
    const created = await createRun("Implement a substantial feature across the whole fixture", {
      cwd: repository,
    });
    const state = await executeRun({ store: created.store, adapter, approve: true });

    expect(state.status).toBe("blocked");
    expect(state.stopReason).toMatch(/stalled/);
    expect(state.nodes.implement?.lastProgress).toBe("stalled");
  });

  it("creates an atomic commit only after deterministic verification passes", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "committed\n");
    });
    const created = await createRun(
      "Implement a substantial feature across the fixture and commit the verified result",
      { cwd: repository },
    );
    const state = await executeRun({ store: created.store, adapter, approve: true });
    const workspace = await created.store.loadWorkspace<{ path: string }>();
    const { stdout: worktreeHead } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspace.path,
    });
    const { stdout: mainHead } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
    });

    expect(state.status).toBe("completed");
    expect(state.nodes.commit?.status).toBe("accepted");
    expect(worktreeHead.trim()).not.toBe(mainHead.trim());
  });

  it("rebuilds a corrupted materialized state from hashed events", async () => {
    const repository = await createRepository();
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    await writeFile(join(created.store.runRoot, "state.json"), "not-json\n");

    const state = await created.store.loadState();
    expect(state.status).toBe("awaiting_approval");
    expect(JSON.parse(await readFile(join(created.store.runRoot, "state.json"), "utf8"))).toEqual(
      state,
    );
  });

  it("fails closed before creating a workspace when the selected host is not authenticated", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async () => undefined, false);
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });

    const state = await executeRun({ store: created.store, adapter, approve: true });
    expect(state.status).toBe("blocked");
    expect(state.stopReason).toMatch(/not authenticated/);
    expect(adapter.calls).toHaveLength(0);
    await expect(created.store.loadWorkspace()).rejects.toThrow();
  });

  it("recovers an interrupted running node in the existing worktree", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "recovered\n");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    await created.store.append("user", "run.approved", { approved: true });
    const workspace = await createRunWorkspace(created.contract);
    await created.store.writeWorkspace(workspace);
    await created.store.append("runtime", "node.started", { nodeId: "implement" });

    const state = await executeRun({ store: created.store, adapter });
    expect(state.status).toBe("completed");
    expect(state.nodes.implement?.attempts).toBe(2);
    expect((await created.store.loadEvents()).map(({ type }) => type)).toContain("node.reset");
  });

  it("resumes one persisted native host session with its original progress baseline", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "resumed\n");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    await created.store.append("user", "run.approved", { approved: true });
    const workspace = await createRunWorkspace(created.contract);
    await created.store.writeWorkspace(workspace);
    await created.store.append("runtime", "node.started", { nodeId: "implement" });
    const invocationId = randomUUID();
    const hostSessionId = randomUUID();
    const baseline = evidenceSnapshot("before-interruption", []);
    await created.store.append("runtime", "invocation.started", {
      invocationId,
      nodeId: "implement",
      adapter: "test",
      capsuleHash: "persisted-capsule",
      baseline,
    });
    await created.store.appendInvocationEvent(invocationId, {
      type: "started",
      invocationId,
    });
    await created.store.appendInvocationEvent(invocationId, { type: "session", hostSessionId });
    await writeFile(join(workspace.path, "feature.txt"), "partial\n");

    const state = await executeRun({ store: created.store, adapter });

    expect(state.status).toBe("completed");
    expect(adapter.calls).toEqual(["implement"]);
    expect(adapter.requests[0]?.resumeSessionId).toBe(hostSessionId);
    expect((await created.store.loadEvents()).map(({ type }) => type)).toContain(
      "invocation.resumed",
    );
  });

  it("reuses a durably returned result after takeover without another model call", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(async () => {
      throw new Error("the completed invocation must not execute again");
    });
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    await created.store.append("user", "run.approved", { approved: true });
    const workspace = await createRunWorkspace(created.contract);
    await created.store.writeWorkspace(workspace);
    await created.store.append("runtime", "node.started", { nodeId: "implement" });
    const invocationId = randomUUID();
    const hostSessionId = randomUUID();
    const baseline = evidenceSnapshot("before-interruption", []);
    await created.store.append("runtime", "invocation.started", {
      invocationId,
      nodeId: "implement",
      adapter: "test",
      capsuleHash: "persisted-capsule",
      baseline,
    });
    await created.store.append(
      "host",
      "invocation.session",
      { invocationId, nodeId: "implement", hostSessionId },
      invocationId,
    );
    await created.store.appendInvocationEvent(invocationId, {
      type: "usage",
      usage: { input: 10, cachedInput: 2, output: 4, reasoning: 0, total: 14 },
    });
    await created.store.appendInvocationEvent(invocationId, {
      type: "result",
      result: {
        status: "completed",
        summary: "Completed before the runtime was terminated",
        changedPaths: ["feature.txt"],
        evidence: ["durable result"],
      },
    });
    await created.store.append(
      "runtime",
      "invocation.finished",
      { invocationId, nodeId: "implement", success: true },
      invocationId,
    );
    await writeFile(join(workspace.path, "feature.txt"), "completed\n");

    const state = await executeRun({ store: created.store, adapter });

    expect(state.status).toBe("completed");
    expect(adapter.calls).toEqual([]);
    expect(state.tokens.total).toBe(14);
    expect(
      (await created.store.loadEvents()).find(
        ({ type, data }) => type === "invocation.finished" && data.recovered === true,
      ),
    ).toBeDefined();
  });

  it("coordinates an active pause, checkpoints termination, and resumes the same session", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(
      async (_request, _call, signal) =>
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    );
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    const execution = executeRun({ store: created.store, adapter, approve: true });
    await waitFor(() => adapter.calls.length === 1);

    const [requestedState, pausedState] = await Promise.all([
      requestRunControl(created.store, "pause", "Pause from another terminal", 5_000),
      execution,
    ]);

    expect(requestedState.status).toBe("paused");
    expect(pausedState.status).toBe("paused");
    expect(pausedState.nodes.implement?.status).toBe("running");
    const pausedEvents = await created.store.loadEvents();
    expect(
      pausedEvents.find(
        ({ type, data }) =>
          type === "control.applied" &&
          data.cause === "user_pause" &&
          (data.termination as { outcome?: string } | undefined)?.outcome === "graceful",
      ),
    ).toBeDefined();

    const resumeAdapter = new FakeAdapter(async (request) => {
      await writeFile(join(request.repositoryPath, "feature.txt"), "resumed after pause\n");
    });
    const completed = await executeRun({ store: created.store, adapter: resumeAdapter });
    expect(completed.status).toBe("completed");
    expect(resumeAdapter.requests[0]?.resumeSessionId).toBeTruthy();
  });

  it("coordinates an active stop and leaves no running node state", async () => {
    const repository = await createRepository();
    const adapter = new FakeAdapter(
      async (_request, _call, signal) =>
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    );
    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    const execution = executeRun({ store: created.store, adapter, approve: true });
    await waitFor(() => adapter.calls.length === 1);

    const [requestedState, stoppedState] = await Promise.all([
      requestRunControl(created.store, "stop", "Stop from another terminal", 5_000),
      execution,
    ]);

    expect(requestedState.status).toBe("stopped");
    expect(stoppedState.status).toBe("stopped");
    expect(stoppedState.nodes.implement?.status).toBe("pending");
    expect(stoppedState.stopReason).toBe("Stop from another terminal");
  });

  it("distinguishes cancellation, shutdown, host crashes, and timeouts in durable state", async () => {
    for (const cause of ["cancellation", "runtime_shutdown"] as const) {
      const repository = await createRepository();
      const adapter = new FakeAdapter(
        async (_request, _call, signal) =>
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
      );
      const created = await createRun("Implement a substantial feature across the fixture", {
        cwd: repository,
      });
      const interruption = new AbortController();
      const executing = executeRun({
        store: created.store,
        adapter,
        approve: true,
        signal: interruption.signal,
      });
      await waitFor(() => adapter.calls.length === 1);
      interruption.abort({ cause, reason: `${cause} by test` });
      const state = await executing;
      expect(state.status).toBe("paused");
      expect(state.stopReason).toBe(`${cause} by test`);
      expect(
        (await created.store.loadEvents()).find(
          ({ type, data }) => type === "control.applied" && data.cause === cause,
        ),
      ).toBeDefined();
    }

    for (const cause of ["host_crash", "timeout"] as const) {
      const repository = await createRepository();
      const adapter = new FakeAdapter(async () => undefined, true, cause);
      const created = await createRun("Implement a substantial feature across the fixture", {
        cwd: repository,
      });
      const state = await executeRun({ store: created.store, adapter, approve: true });
      expect(state.status).toBe("blocked");
      expect(state.stopReason).toMatch(cause === "timeout" ? /^Host timeout:/ : /^Host crash:/);
    }
  }, 30_000);

  it("uses an exclusive recoverable run lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const first = new RunLock(path);
    const second = new RunLock(path);
    await first.acquire();
    await expect(second.acquire()).rejects.toThrow(/already active/);
    await first.release();
    await expect(second.acquire()).resolves.toBeUndefined();
    await second.release();
  });

  it("does not steal a freshly created or partially observed run lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-race-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    await writeFile(path, "{");
    const lock = new RunLock(path);
    await expect(lock.acquire()).rejects.toThrow(/already active/);
    await expect(lock.acquire(0)).resolves.toBeUndefined();
    await lock.release();
  });
});
