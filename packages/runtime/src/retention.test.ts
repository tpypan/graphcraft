import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunEventSchema,
  compileGraph,
  compileRunContract,
  createRunEvent,
  reduceEvents,
  type RunContract,
} from "@graphcraft/core";
import { RunLock } from "./lock.ts";
import { ensureCurrentRunStorage } from "./migration.ts";
import {
  applyCompletedRunPrune,
  applyRunRetention,
  planCompletedRunPrune,
  planRunRetention,
  type RunRetentionFaultBoundary,
} from "./retention.ts";
import { createRunWorkspace, type RunWorkspace } from "./repository.ts";
import { RunStore } from "./store.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function createRepository(): Promise<{ root: string; repository: string }> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-retention-test-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Graphcraft Test");
  await git(repository, "config", "user.email", "graphcraft@example.test");
  await git(repository, "config", "commit.gpgSign", "false");
  await writeFile(join(repository, "fixture.txt"), "repository file\n");
  await git(repository, "add", "fixture.txt");
  await git(repository, "commit", "-m", "fixture");
  return { root, repository };
}

async function createCompletedRun(
  repository: string,
  input: { runId?: string; realWorktree?: boolean } = {},
): Promise<{ store: RunStore; contract: RunContract; workspace: RunWorkspace }> {
  const compiled = compileRunContract(
    `Retain a durable fixture ${input.runId ?? randomUUID()}`,
    {
      root: repository,
      baseRef: "main",
      baseSha: await git(repository, "rev-parse", "HEAD"),
    },
    { finishLine: "local_verified" },
  );
  const contract = { ...compiled, ...(input.runId ? { runId: input.runId } : {}) };
  const graph = compileGraph(contract, [
    { id: "fixture-file", kind: "file", path: "fixture.txt", shouldExist: true },
  ]);
  const store = await RunStore.create(repository, contract, graph);
  let workspace: RunWorkspace;
  if (input.realWorktree) {
    workspace = await createRunWorkspace(contract);
  } else {
    workspace = {
      path: join(dirname(repository), ".preserved-workspaces", contract.runId),
      branch: `graphcraft/${contract.runId}`,
      created: true,
    };
    await mkdir(workspace.path, { recursive: true });
    await writeFile(join(workspace.path, "preserved.txt"), `${contract.runId}\n`);
  }
  await store.writeWorkspace(workspace);
  await store.append("runtime", "run.completed", { workspace });
  return { store, contract, workspace };
}

async function setStateUpdatedAt(store: RunStore, updatedAt: string): Promise<void> {
  const eventsPath = join(store.runRoot, "events.jsonl");
  const events = (await readFile(eventsPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
  const previous = events.at(-1);
  if (!previous) throw new Error("Expected a terminal event");
  events[events.length - 1] = createRunEvent({
    sequence: previous.sequence,
    timestamp: updatedAt,
    actor: previous.actor,
    causationId: previous.causationId,
    type: previous.type,
    data: previous.data,
  });
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    join(store.runRoot, "state.json"),
    `${JSON.stringify(reduceEvents(events), null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

async function appendUnredactedLegacyBlock(store: RunStore, reason: string): Promise<void> {
  const eventsPath = join(store.runRoot, "events.jsonl");
  const events = (await readFile(eventsPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
  const previous = events.at(-1);
  if (!previous) throw new Error("Expected a terminal event");
  events.push(
    createRunEvent({
      sequence: previous.sequence + 1,
      actor: "runtime",
      causationId: store.runId,
      type: "run.blocked",
      data: { reason },
    }),
  );
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    join(store.runRoot, "state.json"),
    `${JSON.stringify(reduceEvents(events), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function treeSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      const key = relative(root, path);
      if (entry.isDirectory()) {
        snapshot[key] = `directory:${stats.mode}:${stats.mtimeMs}`;
        await visit(path);
      } else if (entry.isFile()) {
        snapshot[key] =
          `file:${stats.mode}:${stats.mtimeMs}:${(await readFile(path)).toString("base64")}`;
      } else {
        snapshot[key] = `other:${stats.mode}:${stats.mtimeMs}`;
      }
    }
  };
  await visit(root);
  return snapshot;
}

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}

function journalPath(repository: string, runId: string): string {
  return join(repository, ".graphcraft", "retention", `${runId}.json`);
}

function probeProcessStatePath(repository: string, runId: string): string {
  return join(repository, ".graphcraft", "locks", "probe-processes", runId);
}

async function seedAuxiliaryState(
  repository: string,
  runId: string,
  marker: string,
): Promise<void> {
  const graphcraftRoot = join(repository, ".graphcraft");
  await Promise.all([
    mkdir(join(graphcraftRoot, "controls"), { recursive: true }),
    mkdir(join(graphcraftRoot, "supervisors", runId), { recursive: true }),
    mkdir(join(graphcraftRoot, "migration-backups", runId), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(graphcraftRoot, "controls", `${runId}.json`), `${marker}\n`),
    writeFile(join(graphcraftRoot, "supervisors", runId, "marker.log"), `${marker}\n`),
    writeFile(join(graphcraftRoot, "migration-backups", runId, "marker.json"), `${marker}\n`),
  ]);
}

describe("run-state retention", () => {
  const retentionLeaseNames = ["retention", "supervisor", "run", "artifact"] as const;

  it("builds a read-only plan with durable state and preserved workspace details", async () => {
    const { root, repository } = await createRepository();
    const { store, workspace } = await createCompletedRun(repository);
    const before = await treeSnapshot(root);

    const plan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId.slice(0, 12),
    });

    expect(plan).toMatchObject({
      schemaVersion: 1,
      action: "delete_run_state",
      runId: store.runId,
      state: { runId: store.runId, status: "completed" },
      preservedWorkspace: { path: workspace.path, branch: workspace.branch },
    });
    expect(plan.deletePaths).toEqual([
      join(repository, ".graphcraft", "runs", store.runId),
      join(repository, ".graphcraft", "controls", `${store.runId}.json`),
      join(repository, ".graphcraft", "supervisors", store.runId),
      join(repository, ".graphcraft", "migration-backups", store.runId),
    ]);
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it("refuses a multiply linked workspace projection before reading shared bytes", async () => {
    const { root, repository } = await createRepository();
    const { store } = await createCompletedRun(repository);
    const workspacePath = join(store.runRoot, "workspace.json");
    const outside = join(root, "outside-workspace.json");
    await rename(workspacePath, outside);
    await link(outside, workspacePath);
    const before = await readFile(outside, "utf8");

    await expect(
      planRunRetention({ repositoryRoot: repository, runReference: store.runId }),
    ).rejects.toThrow(/multiply linked file/i);

    expect(await readFile(outside, "utf8")).toBe(before);
    expect(await pathExists(store.runRoot)).toBe(true);
  });

  it("requires exact confirmation and deletes only the resolved run's Graphcraft state", async () => {
    const { repository } = await createRepository();
    const target = await createCompletedRun(repository);
    const other = await createCompletedRun(repository);
    await seedAuxiliaryState(repository, target.store.runId, "target");
    await seedAuxiliaryState(repository, other.store.runId, "other");
    await writeFile(join(repository, "unrelated.txt"), "preserve me\n");
    const plan = await planRunRetention({
      repositoryRoot: repository,
      runReference: target.store.runId,
    });

    await expect(
      applyRunRetention({ plan, confirmRunId: target.store.runId.slice(0, 12) }),
    ).rejects.toThrow(/confirmation must exactly equal/);
    expect(await pathExists(target.store.runRoot)).toBe(true);

    const result = await applyRunRetention({ plan, confirmRunId: target.store.runId });

    expect(result.deletedPaths).toEqual(plan.deletePaths);
    for (const path of plan.deletePaths) expect(await pathExists(path)).toBe(false);
    expect(await readFile(join(repository, "unrelated.txt"), "utf8")).toBe("preserve me\n");
    expect(await pathExists(other.store.runRoot)).toBe(true);
    expect(
      await readFile(
        join(repository, ".graphcraft", "controls", `${other.store.runId}.json`),
        "utf8",
      ),
    ).toBe("other\n");
    expect(
      await readFile(
        join(repository, ".graphcraft", "migration-backups", other.store.runId, "marker.json"),
        "utf8",
      ),
    ).toBe("other\n");
  });

  it.each([
    "after_journal",
    "after_auxiliary",
    "before_run",
    "during_run",
    "after_run",
    "before_journal_cleanup",
  ] satisfies RunRetentionFaultBoundary[])(
    "recovers an exact deletion after a fresh process plan at %s",
    async (boundary) => {
      const { repository } = await createRepository();
      const { store, workspace } = await createCompletedRun(repository);
      await seedAuxiliaryState(repository, store.runId, boundary);
      const plan = await planRunRetention({
        repositoryRoot: repository,
        runReference: store.runId,
      });
      let injected = false;

      await expect(
        applyRunRetention({
          plan,
          confirmRunId: store.runId,
          onCheckpoint: async (checkpoint) => {
            if (injected || checkpoint.boundary !== boundary) return;
            injected = true;
            if (boundary === "during_run") {
              await rm(join(store.runRoot, "state.json"));
              await rm(join(store.runRoot, "events.jsonl"));
              await rm(join(store.runRoot, "capsules"), { recursive: true, force: true });
            }
            throw new Error(`Injected retention fault at ${boundary}`);
          },
        }),
      ).rejects.toThrow(`Injected retention fault at ${boundary}`);

      expect(injected).toBe(true);
      expect(await pathExists(journalPath(repository, store.runId))).toBe(true);
      if (boundary === "during_run") {
        expect(await pathExists(store.runRoot)).toBe(true);
        expect(await pathExists(join(store.runRoot, "state.json"))).toBe(false);
        expect(await pathExists(join(store.runRoot, "events.jsonl"))).toBe(false);
      }
      if (boundary === "after_run" || boundary === "before_journal_cleanup")
        expect(await pathExists(store.runRoot)).toBe(false);

      const recoveryPlan = await planRunRetention({
        repositoryRoot: repository,
        runReference: store.runId,
      });
      const result = await applyRunRetention({
        plan: recoveryPlan,
        confirmRunId: store.runId,
      });

      expect(result.runId).toBe(store.runId);
      expect(await pathExists(journalPath(repository, store.runId))).toBe(false);
      for (const path of recoveryPlan.deletePaths) expect(await pathExists(path)).toBe(false);
      expect(await readFile(join(workspace.path, "preserved.txt"), "utf8")).toBe(
        `${store.runId}\n`,
      );
    },
  );

  it.each(
    retentionLeaseNames.flatMap((lockName) =>
      (["after_journal", "during_run"] as const).map((boundary) => [lockName, boundary] as const),
    ),
  )(
    "preserves recoverable evidence when the %s lease is lost at %s",
    async (lockName, boundary) => {
      const { repository } = await createRepository();
      const { store, workspace } = await createCompletedRun(repository);
      await seedAuxiliaryState(repository, store.runId, `${lockName}:${boundary}`);
      const plan = await planRunRetention({
        repositoryRoot: repository,
        runReference: store.runId,
      });
      const controllers = retentionLeaseNames.map(() => new AbortController());
      const leaseFailure = new Error(
        `Graphcraft ${lockName} retention lease was lost at ${boundary}`,
      );
      let injected = false;
      let journalAtLoss: string | undefined;
      let runAtLoss: Record<string, string> | undefined;
      const signal = vi.spyOn(RunLock.prototype, "signal", "get");
      for (const controller of controllers) signal.mockReturnValueOnce(controller.signal);
      const release = vi.spyOn(RunLock.prototype, "release");

      try {
        await expect(
          applyRunRetention({
            plan,
            confirmRunId: store.runId,
            onCheckpoint: async (checkpoint) => {
              if (injected || checkpoint.boundary !== boundary) return;
              injected = true;
              journalAtLoss = await readFile(journalPath(repository, store.runId), "utf8");
              runAtLoss = await treeSnapshot(store.runRoot);
              controllers[retentionLeaseNames.indexOf(lockName)]!.abort(leaseFailure);
            },
          }),
        ).rejects.toBe(leaseFailure);
        expect(release).toHaveBeenCalledTimes(4);
      } finally {
        signal.mockRestore();
        release.mockRestore();
      }

      expect(injected).toBe(true);
      if (!journalAtLoss || !runAtLoss) throw new Error("Expected lease-loss evidence snapshot");
      const persistedJournal = await readFile(journalPath(repository, store.runId), "utf8");
      expect(persistedJournal).toBe(journalAtLoss);
      expect(
        (JSON.parse(persistedJournal) as { existingTargetIds: string[] }).existingTargetIds,
      ).toEqual(["run", "control", "supervisor", "migration_backup"]);
      expect(await treeSnapshot(store.runRoot)).toEqual(runAtLoss);
      expect(await pathExists(plan.deletePaths[0]!)).toBe(true);
      for (const path of plan.deletePaths.slice(1))
        expect(await pathExists(path)).toBe(boundary === "after_journal");

      const recoveryPlan = await planRunRetention({
        repositoryRoot: repository,
        runReference: store.runId,
      });
      const result = await applyRunRetention({
        plan: recoveryPlan,
        confirmRunId: store.runId,
      });

      expect(result.deletedPaths).toEqual(plan.deletePaths);
      expect(await pathExists(journalPath(repository, store.runId))).toBe(false);
      for (const path of plan.deletePaths) expect(await pathExists(path)).toBe(false);
      expect(await readFile(join(workspace.path, "preserved.txt"), "utf8")).toBe(
        `${store.runId}\n`,
      );
    },
  );

  it.each(["body", "lease"] as const)(
    "attempts every lock release without replacing the original %s failure",
    async (failureKind) => {
      const { repository } = await createRepository();
      const { store } = await createCompletedRun(repository);
      await seedAuxiliaryState(repository, store.runId, failureKind);
      const plan = await planRunRetention({
        repositoryRoot: repository,
        runReference: store.runId,
      });
      const causalFailure = new Error(`original retention ${failureKind} failure`);
      const releaseFailures = retentionLeaseNames.map(
        (lockName) => new Error(`${lockName} release failed`),
      );
      const controllers = retentionLeaseNames.map(() => new AbortController());
      const signal = vi.spyOn(RunLock.prototype, "signal", "get");
      for (const controller of controllers) signal.mockReturnValueOnce(controller.signal);
      const releaseLock = RunLock.prototype.release;
      let releaseCalls = 0;
      const release = vi.spyOn(RunLock.prototype, "release").mockImplementation(async function (
        this: RunLock,
      ) {
        const failure = releaseFailures[releaseCalls]!;
        releaseCalls += 1;
        await releaseLock.call(this);
        throw failure;
      });

      try {
        await expect(
          applyRunRetention({
            plan,
            confirmRunId: store.runId,
            onCheckpoint: ({ boundary }) => {
              if (boundary !== "after_journal") return;
              if (failureKind === "body") throw causalFailure;
              controllers[3]!.abort(causalFailure);
            },
          }),
        ).rejects.toBe(causalFailure);
        expect(release).toHaveBeenCalledTimes(4);
        expect(releaseCalls).toBe(4);
      } finally {
        signal.mockRestore();
        release.mockRestore();
      }

      expect(await pathExists(journalPath(repository, store.runId))).toBe(true);
      for (const path of plan.deletePaths) expect(await pathExists(path)).toBe(true);
    },
  );

  it("requires an exact ID to recover a journal-only run", async () => {
    const { repository } = await createRepository();
    const { store } = await createCompletedRun(repository);
    const plan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId,
    });

    await expect(
      applyRunRetention({
        plan,
        confirmRunId: store.runId,
        onCheckpoint: ({ boundary }) => {
          if (boundary === "after_run") throw new Error("stop after run deletion");
        },
      }),
    ).rejects.toThrow("stop after run deletion");
    expect(await pathExists(store.runRoot)).toBe(false);

    await expect(
      planRunRetention({
        repositoryRoot: repository,
        runReference: store.runId.slice(0, 12),
      }),
    ).rejects.toThrow(/No Graphcraft runs|matched 0 runs/);

    const recoveryPlan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId,
    });
    await applyRunRetention({ plan: recoveryPlan, confirmRunId: store.runId });
    expect(await pathExists(journalPath(repository, store.runId))).toBe(false);
  });

  it("persists only bounded, redacted retention metadata and target identifiers", async () => {
    const { repository } = await createRepository();
    const { store } = await createCompletedRun(repository);
    const seededCredential = `ghp_${"journal-secret".repeat(3)}`;
    await appendUnredactedLegacyBlock(store, `Legacy failure included ${seededCredential}`);
    await seedAuxiliaryState(repository, store.runId, seededCredential);
    const plan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId,
    });

    await expect(
      applyRunRetention({
        plan,
        confirmRunId: store.runId,
        onCheckpoint: ({ boundary }) => {
          if (boundary === "after_journal") throw new Error("inspect journal");
        },
      }),
    ).rejects.toThrow("inspect journal");

    const source = await readFile(journalPath(repository, store.runId), "utf8");
    const journal = JSON.parse(source) as Record<string, unknown>;
    expect(Buffer.byteLength(source)).toBeLessThanOrEqual(64 * 1024);
    expect(source).not.toContain(seededCredential);
    for (const target of plan.deletePaths) expect(source).not.toContain(target);
    expect(journal).not.toHaveProperty("deletePaths");
    expect(journal.existingTargetIds).toEqual(["run", "control", "supervisor", "migration_backup"]);
    if (process.platform !== "win32") {
      expect((await lstat(dirname(journalPath(repository, store.runId)))).mode & 0o777).toBe(0o700);
      expect((await lstat(journalPath(repository, store.runId))).mode & 0o777).toBe(0o600);
    }

    const recoveryPlan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId,
    });
    await applyRunRetention({ plan: recoveryPlan, confirmRunId: store.runId });
  });

  it("refuses modified and oversized retention journals without deleting more state", async () => {
    for (const corruption of ["modified", "oversized"] as const) {
      const { repository } = await createRepository();
      const { store } = await createCompletedRun(repository);
      const plan = await planRunRetention({
        repositoryRoot: repository,
        runReference: store.runId,
      });
      await expect(
        applyRunRetention({
          plan,
          confirmRunId: store.runId,
          onCheckpoint: ({ boundary }) => {
            if (boundary === "after_journal") throw new Error("corrupt journal");
          },
        }),
      ).rejects.toThrow("corrupt journal");

      const path = journalPath(repository, store.runId);
      if (corruption === "modified") {
        const journal = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        journal.createdAt = "2026-01-01T00:00:00.000Z";
        await writeFile(path, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
      } else {
        await writeFile(path, Buffer.alloc(64 * 1024 + 1, "x"), { mode: 0o600 });
      }

      await expect(
        planRunRetention({ repositoryRoot: repository, runReference: store.runId }),
      ).rejects.toThrow(
        corruption === "modified" ? /invalid or has been modified/ : /bounded size/,
      );
      expect(await pathExists(store.runRoot)).toBe(true);
    }
  });

  it.each([
    ["state", "state.json", 16 * 1024 * 1024 + 1],
    ["event log", "events.jsonl", 64 * 1024 * 1024 + 1],
    ["workspace", "workspace.json", 64 * 1024 + 1],
  ] as const)("refuses an oversized %s before planning deletion", async (_label, file, bytes) => {
    const { repository } = await createRepository();
    const { store } = await createCompletedRun(repository);
    await truncate(join(store.runRoot, file), bytes);

    await expect(
      planRunRetention({ repositoryRoot: repository, runReference: store.runId }),
    ).rejects.toThrow(/bounded read limit/);
    expect(await pathExists(store.runRoot)).toBe(true);
  });

  it.each(["stopped", "blocked"] as const)(
    "allows exact deletion of a quiescent %s run while preserving its workspace",
    async (status) => {
      const { repository } = await createRepository();
      const { store, workspace } = await createCompletedRun(repository);
      if (status === "stopped")
        await store.append("user", "run.stopped", { reason: "User stopped the retained run" });
      else
        await store.append("runtime", "run.blocked", { reason: "Retained run needs a decision" });

      const plan = await planRunRetention({
        repositoryRoot: repository,
        runReference: store.runId,
      });
      expect(plan.state.status).toBe(status);

      await applyRunRetention({ plan, confirmRunId: store.runId });

      expect(await pathExists(store.runRoot)).toBe(false);
      expect(await readFile(join(workspace.path, "preserved.txt"), "utf8")).toBe(
        `${store.runId}\n`,
      );
    },
  );

  it("refuses delete and prune plans while probe-process ownership evidence remains", async () => {
    const { repository } = await createRepository();
    const { store } = await createCompletedRun(repository);
    await setStateUpdatedAt(store, "2026-01-01T00:00:00.000Z");
    const processState = probeProcessStatePath(repository, store.runId);
    const evidence = join(processState, `${"a".repeat(64)}.jsonl`);
    await mkdir(processState, { recursive: true });
    await writeFile(evidence, "ambiguous probe ownership evidence\n", { mode: 0o600 });

    await expect(
      planRunRetention({ repositoryRoot: repository, runReference: store.runId }),
    ).rejects.toThrow(/probe-process ownership evidence remains/i);
    await expect(
      planCompletedRunPrune({
        repositoryRoot: repository,
        completedBefore: "2026-02-01T00:00:00.000Z",
        keepNewest: 0,
      }),
    ).rejects.toThrow(/probe-process ownership evidence remains/i);
    expect(await pathExists(store.runRoot)).toBe(true);
    await expect(readFile(evidence, "utf8")).resolves.toBe("ambiguous probe ownership evidence\n");
  });

  it("rechecks probe-process ownership evidence under the run lock before applying deletion", async () => {
    const { repository } = await createRepository();
    const { store } = await createCompletedRun(repository);
    const plan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId,
    });
    const processState = probeProcessStatePath(repository, store.runId);
    const evidence = join(processState, `${"b".repeat(64)}.jsonl`);
    await mkdir(processState, { recursive: true });
    await writeFile(evidence, "appeared after planning\n", { mode: 0o600 });

    await expect(applyRunRetention({ plan, confirmRunId: store.runId })).rejects.toThrow(
      /probe-process ownership evidence remains/i,
    );
    expect(await pathExists(store.runRoot)).toBe(true);
    expect(await pathExists(journalPath(repository, store.runId))).toBe(false);
    await expect(readFile(evidence, "utf8")).resolves.toBe("appeared after planning\n");
  });

  it("preserves malformed probe-process ownership evidence", async () => {
    const { repository } = await createRepository();
    const { store } = await createCompletedRun(repository);
    const processState = probeProcessStatePath(repository, store.runId);
    await mkdir(dirname(processState), { recursive: true });
    await writeFile(processState, "not a directory\n", { mode: 0o600 });

    await expect(
      planRunRetention({ repositoryRoot: repository, runReference: store.runId }),
    ).rejects.toThrow(/probe-process ownership evidence is ambiguous/i);
    expect(await pathExists(store.runRoot)).toBe(true);
    await expect(readFile(processState, "utf8")).resolves.toBe("not a directory\n");
  });

  it.skipIf(process.platform === "win32")(
    "preserves symlinked probe-process ownership evidence",
    async () => {
      const { root, repository } = await createRepository();
      const { store } = await createCompletedRun(repository);
      const processState = probeProcessStatePath(repository, store.runId);
      const outside = join(root, "outside-probe-state");
      await mkdir(dirname(processState), { recursive: true });
      await mkdir(outside);
      await writeFile(join(outside, "must-survive.jsonl"), "outside evidence\n");
      await symlink(outside, processState, "dir");

      await expect(
        planRunRetention({ repositoryRoot: repository, runReference: store.runId }),
      ).rejects.toThrow(/probe-process ownership evidence is ambiguous/i);
      expect(await pathExists(store.runRoot)).toBe(true);
      await expect(readFile(join(outside, "must-survive.jsonl"), "utf8")).resolves.toBe(
        "outside evidence\n",
      );
    },
  );

  it("deletes an explicitly confirmed completed legacy run whose secret-bearing artifact blocks migration", async () => {
    const { repository } = await createRepository();
    const { store, workspace } = await createCompletedRun(repository);
    const storagePath = join(store.runRoot, "storage.json");
    const currentStorage = JSON.parse(await readFile(storagePath, "utf8")) as {
      formats: Record<string, number>;
    };
    const formats = Object.fromEntries(
      Object.entries(currentStorage.formats).filter(
        ([key]) => key !== "artifactInventory" && key !== "artifactPolicy",
      ),
    );
    await writeFile(
      storagePath,
      `${JSON.stringify({
        schemaVersion: 1,
        runId: store.runId,
        migratedFrom: 1,
        formats,
      })}\n`,
    );
    await rm(join(store.runRoot, "artifact-inventory.json"));
    const secretPath = join(store.runRoot, "artifacts", "legacy-secret.json");
    await mkdir(dirname(secretPath), { recursive: true });
    await writeFile(secretPath, '{"password":"hunter2"}\n');

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: store.graphcraftRoot,
        runRoot: store.runRoot,
        runId: store.runId,
      }),
    ).rejects.toThrow(/secret-like material/);
    const plan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId,
    });

    await applyRunRetention({ plan, confirmRunId: store.runId });

    expect(await pathExists(store.runRoot)).toBe(false);
    expect(await readFile(join(workspace.path, "preserved.txt"), "utf8")).toBe(`${store.runId}\n`);
  });

  it("keeps secret-bearing legacy state out of retention plans and results", async () => {
    const { repository } = await createRepository();
    const { store, workspace } = await createCompletedRun(repository);
    const seededCredential = `ghp_${"retentionsecret".repeat(2)}`;
    await appendUnredactedLegacyBlock(store, `Legacy failure included ${seededCredential}`);

    const plan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId,
    });

    expect(plan.state).toEqual({
      runId: store.runId,
      status: "blocked",
      lastEventSequence: 3,
      updatedAt: expect.any(String),
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(plan)).not.toContain(seededCredential);

    const result = await applyRunRetention({ plan, confirmRunId: store.runId });
    expect(JSON.stringify(result)).not.toContain(seededCredential);
    expect(await readFile(join(workspace.path, "preserved.txt"), "utf8")).toBe(`${store.runId}\n`);
  });

  it("preserves a registered worktree, its branch, and its files", async () => {
    const { repository } = await createRepository();
    const { store, workspace } = await createCompletedRun(repository, { realWorktree: true });
    await writeFile(join(workspace.path, "preserved-after-retention.txt"), "still here\n");
    const plan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId,
    });

    await applyRunRetention({ plan, confirmRunId: store.runId });

    expect(await readFile(join(workspace.path, "preserved-after-retention.txt"), "utf8")).toBe(
      "still here\n",
    );
    expect(
      await git(repository, "show-ref", "--verify", `refs/heads/${workspace.branch}`),
    ).not.toBe("");
    expect(await git(repository, "worktree", "list", "--porcelain")).toContain(
      `worktree ${(await realpath(workspace.path)).replaceAll("\\", "/")}`,
    );
  });

  it("refuses a symlinked or junctioned intermediate state directory before deleting anything", async () => {
    const { root, repository } = await createRepository();
    const { store } = await createCompletedRun(repository);
    await seedAuxiliaryState(repository, store.runId, "outside must survive");
    const plan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId,
    });
    const graphcraftRoot = join(repository, ".graphcraft");
    const migrationBackups = join(graphcraftRoot, "migration-backups");
    const outside = join(root, "outside-migration-backups");
    await rename(migrationBackups, outside);
    await symlink(outside, migrationBackups, process.platform === "win32" ? "junction" : "dir");

    await expect(applyRunRetention({ plan, confirmRunId: store.runId })).rejects.toThrow(
      /symbolic link.*no files were deleted/i,
    );

    expect(await readFile(join(outside, store.runId, "marker.json"), "utf8")).toBe(
      "outside must survive\n",
    );
    expect(await pathExists(store.runRoot)).toBe(true);
    expect(await pathExists(join(graphcraftRoot, "controls", `${store.runId}.json`))).toBe(true);
    expect(await pathExists(join(graphcraftRoot, "supervisors", store.runId))).toBe(true);
  });

  it("refuses a live supervisor and a held canonical run lock", async () => {
    const { repository } = await createRepository();
    const { store } = await createCompletedRun(repository);
    const supervisorId = randomUUID();
    const supervisorRoot = join(repository, ".graphcraft", "supervisors", store.runId);
    const now = new Date().toISOString();
    await mkdir(supervisorRoot, { recursive: true });
    await writeFile(
      join(supervisorRoot, `${supervisorId}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        supervisorId,
        runId: store.runId,
        repositoryRoot: repository,
        pid: process.pid,
        host: "codex",
        maxWorkers: 1,
        status: "running",
        startedAt: now,
        heartbeatAt: now,
        updatedAt: now,
        logPath: join(supervisorRoot, `${supervisorId}.log`),
      })}\n`,
    );

    await expect(
      planRunRetention({ repositoryRoot: repository, runReference: store.runId }),
    ).rejects.toThrow(/supervisor .* is running/);

    await rm(supervisorRoot, { recursive: true });
    const plan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId,
    });
    const lock = new RunLock(join(repository, ".graphcraft", "locks", `${store.runId}.lock`));
    await lock.acquire();
    try {
      await expect(applyRunRetention({ plan, confirmRunId: store.runId })).rejects.toThrow(
        /already active/,
      );
      expect(await pathExists(store.runRoot)).toBe(true);
    } finally {
      await lock.release();
    }
  });

  it("coordinates deletion with artifact mutations", async () => {
    const { repository } = await createRepository();
    const { store } = await createCompletedRun(repository);
    const plan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId,
    });
    const artifactLock = new RunLock(
      join(repository, ".graphcraft", "locks", `${store.runId}.artifacts.lock`),
    );
    await artifactLock.acquire();
    try {
      await expect(applyRunRetention({ plan, confirmRunId: store.runId })).rejects.toThrow(
        /already active/,
      );
      expect(await pathExists(store.runRoot)).toBe(true);
    } finally {
      await artifactLock.release();
    }
  });

  it("refuses an ambiguous run reference before selecting a deletion target", async () => {
    const { repository } = await createRepository();
    const firstId = "10000000-0000-4000-8000-000000000001";
    const secondId = "10000000-0000-4000-8000-000000000002";
    await createCompletedRun(repository, { runId: firstId });
    await createCompletedRun(repository, { runId: secondId });

    await expect(
      planRunRetention({
        repositoryRoot: repository,
        runReference: "10000000-0000-4000-8000-00000000000",
      }),
    ).rejects.toThrow(/matched 2 runs/);
  });

  it("prunes only runs strictly before the cutoff after keeping the newest candidates", async () => {
    const { repository } = await createRepository();
    const oldest = await createCompletedRun(repository);
    const middle = await createCompletedRun(repository);
    const newestCandidate = await createCompletedRun(repository);
    const atCutoff = await createCompletedRun(repository);
    await setStateUpdatedAt(oldest.store, "2026-01-01T00:00:00.000Z");
    await setStateUpdatedAt(middle.store, "2026-01-02T00:00:00.000Z");
    await setStateUpdatedAt(newestCandidate.store, "2026-01-03T00:00:00.000Z");
    await setStateUpdatedAt(atCutoff.store, "2026-01-04T00:00:00.000Z");

    const plan = await planCompletedRunPrune({
      repositoryRoot: repository,
      completedBefore: "2026-01-04T00:00:00.000Z",
      keepNewest: 1,
    });

    expect(plan.candidateRunIds).toEqual([
      newestCandidate.store.runId,
      middle.store.runId,
      oldest.store.runId,
    ]);
    expect(plan.keptRunIds).toEqual([newestCandidate.store.runId]);
    expect(plan.deletionPlans.map(({ runId }) => runId)).toEqual([
      middle.store.runId,
      oldest.store.runId,
    ]);

    const results = await applyCompletedRunPrune({
      plan,
      confirmRunIds: plan.deletionPlans.map(({ runId }) => runId),
    });

    expect(results.map(({ runId }) => runId)).toEqual([middle.store.runId, oldest.store.runId]);
    expect(await pathExists(middle.store.runRoot)).toBe(false);
    expect(await pathExists(oldest.store.runRoot)).toBe(false);
    expect(await pathExists(newestCandidate.store.runRoot)).toBe(true);
    expect(await pathExists(atCutoff.store.runRoot)).toBe(true);
  });

  it("reports completed deletions when a later prune target becomes unavailable", async () => {
    const { repository } = await createRepository();
    const older = await createCompletedRun(repository);
    const newer = await createCompletedRun(repository);
    await setStateUpdatedAt(older.store, "2026-01-01T00:00:00.000Z");
    await setStateUpdatedAt(newer.store, "2026-01-02T00:00:00.000Z");
    const plan = await planCompletedRunPrune({
      repositoryRoot: repository,
      completedBefore: "2026-01-03T00:00:00.000Z",
      keepNewest: 0,
    });
    expect(plan.deletionPlans.map(({ runId }) => runId)).toEqual([
      newer.store.runId,
      older.store.runId,
    ]);
    const blocked = plan.deletionPlans[1]!;
    const artifactLock = new RunLock(
      join(repository, ".graphcraft", "locks", `${blocked.runId}.artifacts.lock`),
    );
    await artifactLock.acquire();
    try {
      await expect(
        applyCompletedRunPrune({
          plan,
          confirmRunIds: plan.deletionPlans.map(({ runId }) => runId),
        }),
      ).rejects.toThrow(
        new RegExp(
          `Deleted run state before the failure: ${newer.store.runId}.*stopped at run ${older.store.runId}`,
        ),
      );
    } finally {
      await artifactLock.release();
    }
    expect(await pathExists(newer.store.runRoot)).toBe(false);
    expect(await pathExists(older.store.runRoot)).toBe(true);
  });

  it("resumes a partially completed prune without letting keepNewest preserve journaled work", async () => {
    const { repository } = await createRepository();
    const older = await createCompletedRun(repository);
    const newer = await createCompletedRun(repository);
    await setStateUpdatedAt(older.store, "2026-01-01T00:00:00.000Z");
    await setStateUpdatedAt(newer.store, "2026-01-02T00:00:00.000Z");
    await seedAuxiliaryState(repository, older.store.runId, "older");
    await seedAuxiliaryState(repository, newer.store.runId, "newer");
    const plan = await planCompletedRunPrune({
      repositoryRoot: repository,
      completedBefore: "2026-01-03T00:00:00.000Z",
      keepNewest: 0,
    });
    let injected = false;

    await expect(
      applyCompletedRunPrune({
        plan,
        confirmRunIds: plan.deletionPlans.map(({ runId }) => runId),
        onCheckpoint: ({ boundary, runId }) => {
          if (!injected && runId === older.store.runId && boundary === "after_auxiliary") {
            injected = true;
            throw new Error("stop later prune target");
          }
        },
      }),
    ).rejects.toThrow(
      new RegExp(
        `Deleted run state before the failure: ${newer.store.runId}.*stopped at run ${older.store.runId}`,
      ),
    );

    expect(injected).toBe(true);
    expect(await pathExists(newer.store.runRoot)).toBe(false);
    expect(await pathExists(older.store.runRoot)).toBe(true);
    expect(await pathExists(journalPath(repository, newer.store.runId))).toBe(true);
    expect(await pathExists(journalPath(repository, older.store.runId))).toBe(true);

    const recoveryPlan = await planCompletedRunPrune({
      repositoryRoot: repository,
      completedBefore: "2026-01-03T00:00:00.000Z",
      keepNewest: 2,
    });
    expect(recoveryPlan.keptRunIds).toEqual([]);
    expect(recoveryPlan.deletionPlans.map(({ runId }) => runId)).toEqual([
      newer.store.runId,
      older.store.runId,
    ]);

    const results = await applyCompletedRunPrune({
      plan: recoveryPlan,
      confirmRunIds: recoveryPlan.deletionPlans.map(({ runId }) => runId),
    });
    expect(results.map(({ runId }) => runId)).toEqual([newer.store.runId, older.store.runId]);
    expect(await pathExists(newer.store.runRoot)).toBe(false);
    expect(await pathExists(older.store.runRoot)).toBe(false);
    expect(await pathExists(journalPath(repository, newer.store.runId))).toBe(false);
    expect(await pathExists(journalPath(repository, older.store.runId))).toBe(false);
  });

  it("revalidates terminal eligibility after planning and before deletion", async () => {
    const { repository } = await createRepository();
    const { store, workspace } = await createCompletedRun(repository);
    const plan = await planRunRetention({
      repositoryRoot: repository,
      runReference: store.runId,
    });
    const plannedMaterializedState = await readFile(join(store.runRoot, "state.json"), "utf8");
    await store.append("runtime", "run.started", { workspace });

    await expect(
      planRunRetention({ repositoryRoot: repository, runReference: store.runId }),
    ).rejects.toThrow(/state running is active or has an ambiguous terminal outcome/);
    await expect(applyRunRetention({ plan, confirmRunId: store.runId })).rejects.toThrow(
      /state running is active or has an ambiguous terminal outcome/,
    );
    expect(await pathExists(store.runRoot)).toBe(true);

    await writeFile(join(store.runRoot, "state.json"), plannedMaterializedState);
    await expect(applyRunRetention({ plan, confirmRunId: store.runId })).rejects.toThrow(
      /does not match the authoritative event log/,
    );
    expect(await pathExists(store.runRoot)).toBe(true);

    await writeFile(join(store.runRoot, "state.json"), "{}\n");
    await expect(applyRunRetention({ plan, confirmRunId: store.runId })).rejects.toThrow(
      /persisted state is missing or ambiguous/,
    );
    expect(await readFile(join(workspace.path, "preserved.txt"), "utf8")).toBe(`${store.runId}\n`);
  });
});
