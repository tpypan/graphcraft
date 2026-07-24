import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  RunEventSchema,
  compileGraph,
  compileRunContract,
  createRunEvent,
  reduceEvents,
} from "@graphcraft/core";
import { RunStore } from "@graphcraft/runtime";

const execFileAsync = promisify(execFile);
const binPath = fileURLToPath(new URL("./bin.ts", import.meta.url));
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

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft cli retention "));
  temporaryRoots.push(root);
  const repository = join(root, "repository with spaces");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Graphcraft Test");
  await git(repository, "config", "user.email", "graphcraft@example.test");
  await git(repository, "config", "commit.gpgSign", "false");
  await writeFile(join(repository, "fixture.txt"), "fixture\n");
  await git(repository, "add", "fixture.txt");
  await git(repository, "commit", "-m", "fixture");
  return repository;
}

async function createCompletedRun(repository: string): Promise<{
  store: RunStore;
  workspacePath: string;
}> {
  const contract = compileRunContract(`Retain CLI fixture ${randomUUID()}`, {
    root: repository,
    baseRef: "main",
    baseSha: await git(repository, "rev-parse", "HEAD"),
  });
  const graph = compileGraph(contract, [
    { id: "fixture-file", kind: "file", path: "fixture.txt", shouldExist: true },
  ]);
  const store = await RunStore.create(repository, contract, graph);
  const workspacePath = join(dirname(repository), "preserved workspaces", store.runId);
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "preserved.txt"), `${store.runId}\n`);
  const workspace = {
    path: workspacePath,
    branch: `graphcraft/${store.runId}`,
    created: true,
  };
  await store.writeWorkspace(workspace);
  await store.append("runtime", "run.completed", { workspace });
  return { store, workspacePath };
}

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(process.execPath, ["--import", "tsx", binPath, ...args], {
    encoding: "utf8",
  });
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}

async function setUpdatedAt(store: RunStore, updatedAt: string): Promise<void> {
  const eventsPath = join(store.runRoot, "events.jsonl");
  const events = (await readFile(eventsPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
  const previous = events.at(-1);
  if (!previous) throw new Error("Expected a terminal event");
  events[events.length - 1] = createRunEvent(
    {
      sequence: previous.sequence,
      timestamp: updatedAt,
      actor: previous.actor,
      causationId: previous.causationId,
      type: previous.type,
      data: previous.data,
    },
    store.canonicalHashAlgorithm,
  );
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeFile(
    join(store.runRoot, "state.json"),
    `${JSON.stringify(reduceEvents(events), null, 2)}\n`,
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
    createRunEvent(
      {
        sequence: previous.sequence + 1,
        actor: "runtime",
        causationId: store.runId,
        type: "run.blocked",
        data: { reason },
      },
      store.canonicalHashAlgorithm,
    ),
  );
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeFile(
    join(store.runRoot, "state.json"),
    `${JSON.stringify(reduceEvents(events), null, 2)}\n`,
  );
}

describe("retention CLI", () => {
  it("keeps delete dry-run read-only and requires the exact ID before preserving the workspace", async () => {
    const repository = await createRepository();
    const { store, workspacePath } = await createCompletedRun(repository);
    const prefix = store.runId.slice(0, 12);

    const dryRun = JSON.parse(
      (await runCli("delete", prefix, "-C", repository, "--json")).stdout,
    ) as Record<string, unknown>;
    expect(dryRun).toMatchObject({ dryRun: true, plan: { runId: store.runId } });
    expect(await exists(store.runRoot)).toBe(true);

    await expect(runCli("delete", prefix, "-C", repository, "--yes")).rejects.toMatchObject({
      stderr: expect.stringContaining("Deletion requires the exact run ID"),
    });
    const applied = JSON.parse(
      (await runCli("delete", store.runId, "-C", repository, "--yes", "--json")).stdout,
    ) as Record<string, unknown>;

    expect(applied).toMatchObject({ dryRun: false, result: { runId: store.runId } });
    expect(await exists(store.runRoot)).toBe(false);
    expect(await readFile(join(workspacePath, "preserved.txt"), "utf8")).toBe(`${store.runId}\n`);
  });

  it("does not print secret-bearing legacy state in JSON or human retention plans", async () => {
    const repository = await createRepository();
    const { store } = await createCompletedRun(repository);
    const seededCredential = `ghp_${"retentionsecret".repeat(2)}`;
    await appendUnredactedLegacyBlock(store, `Legacy failure included ${seededCredential}`);

    const json = await runCli("delete", store.runId, "-C", repository, "--json");
    const rendered = JSON.parse(json.stdout) as {
      plan: { state: Record<string, unknown> };
    };
    const human = await runCli("delete", store.runId, "-C", repository);
    const applied = await runCli("delete", store.runId, "-C", repository, "--yes", "--json");

    expect(
      `${json.stdout}${json.stderr}${human.stdout}${human.stderr}${applied.stdout}${applied.stderr}`,
    ).not.toContain(seededCredential);
    expect(rendered.plan.state).toEqual({
      runId: store.runId,
      status: "blocked",
      lastEventSequence: 3,
      updatedAt: expect.any(String),
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await exists(store.runRoot)).toBe(false);
  });

  it("prunes only the revalidated completed runs selected by cutoff and keep count", async () => {
    const repository = await createRepository();
    const oldest = await createCompletedRun(repository);
    const newest = await createCompletedRun(repository);
    await setUpdatedAt(oldest.store, "2026-01-01T00:00:00.000Z");
    await setUpdatedAt(newest.store, "2026-01-02T00:00:00.000Z");
    const args = [
      "prune",
      "--completed-before",
      "2026-01-03T00:00:00.000Z",
      "--keep",
      "1",
      "-C",
      repository,
      "--json",
    ];

    const dryRun = JSON.parse((await runCli(...args)).stdout) as {
      plan: { deletionPlans: Array<{ runId: string }>; keptRunIds: string[] };
    };
    expect(dryRun.plan.deletionPlans.map(({ runId }) => runId)).toEqual([oldest.store.runId]);
    expect(dryRun.plan.keptRunIds).toEqual([newest.store.runId]);

    const applied = JSON.parse(
      (await runCli(...args, "--yes", "--confirm-run", oldest.store.runId)).stdout,
    ) as {
      result: Array<{ runId: string }>;
    };
    expect(applied.result.map(({ runId }) => runId)).toEqual([oldest.store.runId]);
    expect(await exists(oldest.store.runRoot)).toBe(false);
    expect(await exists(newest.store.runRoot)).toBe(true);
  });

  it("refuses prune when exact reviewed confirmations omit a newly eligible run", async () => {
    const repository = await createRepository();
    const oldest = await createCompletedRun(repository);
    const newest = await createCompletedRun(repository);
    await setUpdatedAt(oldest.store, "2026-01-01T00:00:00.000Z");
    await setUpdatedAt(newest.store, "2026-01-02T00:00:00.000Z");
    const args = [
      "prune",
      "--completed-before",
      "2026-01-03T00:00:00.000Z",
      "--keep",
      "1",
      "-C",
      repository,
      "--json",
    ];
    const reviewed = JSON.parse((await runCli(...args)).stdout) as {
      plan: { deletionPlans: Array<{ runId: string }> };
    };
    expect(reviewed.plan.deletionPlans.map(({ runId }) => runId)).toEqual([oldest.store.runId]);

    const newlyEligible = await createCompletedRun(repository);
    await setUpdatedAt(newlyEligible.store, "2025-12-31T00:00:00.000Z");
    await expect(
      runCli(...args, "--yes", "--confirm-run", oldest.store.runId),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Prune confirmation must contain every planned run ID"),
    });
    expect(await exists(oldest.store.runRoot)).toBe(true);
    expect(await exists(newest.store.runRoot)).toBe(true);
    expect(await exists(newlyEligible.store.runRoot)).toBe(true);

    const refreshed = JSON.parse((await runCli(...args)).stdout) as {
      plan: { deletionPlans: Array<{ runId: string }> };
    };
    const confirmed = refreshed.plan.deletionPlans.map(({ runId }) => runId);
    const applied = JSON.parse(
      (await runCli(...args, "--yes", ...confirmed.flatMap((runId) => ["--confirm-run", runId])))
        .stdout,
    ) as { result: Array<{ runId: string }> };
    expect(applied.result.map(({ runId }) => runId)).toEqual(confirmed);
  });
});
