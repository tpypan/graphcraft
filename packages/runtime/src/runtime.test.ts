import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  HostAdapter,
  HostCapabilities,
  HostEvent,
  InvocationRecord,
  ReconciliationResult,
  WorkerRequest,
} from "@graphcraft/core";
import { createRun, executeRun } from "./runner.ts";
import { RunLock } from "./lock.ts";
import { createRunWorkspace } from "./repository.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

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
  private readonly act: (request: WorkerRequest, call: number) => Promise<void>;
  private readonly authenticated: boolean;

  constructor(act: (request: WorkerRequest, call: number) => Promise<void>, authenticated = true) {
    this.act = act;
    this.authenticated = authenticated;
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

  async *execute(request: WorkerRequest, _signal: AbortSignal): AsyncIterable<HostEvent> {
    this.calls.push(request.capsule.nodeId);
    yield { type: "started", invocationId: request.invocationId };
    await this.act(request, this.calls.length);
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

  async reconcile(_invocation: InvocationRecord): Promise<ReconciliationResult> {
    return { state: "unknown" };
  }
}

describe("durable runtime", () => {
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
});
