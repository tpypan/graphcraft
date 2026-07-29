import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  contentHash,
  type SideEffectClaim,
} from "@graphcraft/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPrivateFileBounded } from "./secure-fs.ts";
import {
  closeSideEffectProcessLease,
  createSideEffectProcessDefinition,
  createSideEffectProcessLease,
  inspectSideEffectProcessJournal,
  removeSideEffectProcessJournal,
  type SideEffectProcessDefinition,
  type SideEffectProcessLease,
  waitForSideEffectProcessSettlement,
} from "./side-effect-process.ts";

vi.mock("./secure-fs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./secure-fs.ts")>();
  return {
    ...actual,
    readPrivateFileBounded: vi.fn(actual.readPrivateFileBounded),
  };
});

const temporaryRoots: string[] = [];

beforeEach(() => {
  vi.mocked(readPrivateFileBounded).mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

const claim: Pick<SideEffectClaim, "actionId" | "nodeId" | "kind"> = {
  actionId: "a".repeat(64),
  nodeId: "commit",
  kind: "git_commit",
};

async function createGraphcraftRoot(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "graphcraft-side-effect-process-"));
  temporaryRoots.push(repository);
  const graphcraftRoot = join(repository, ".graphcraft");
  await mkdir(graphcraftRoot, { mode: 0o700 });
  return graphcraftRoot;
}

function appendRecord(
  lease: SideEffectProcessLease,
  ownerToken: string,
  record: Record<string, unknown>,
): Promise<unknown> {
  return lease.handle.write(
    `${JSON.stringify({
      schemaVersion: 1,
      executionId: lease.definition.executionId,
      ownerToken,
      ...record,
    })}\n`,
  );
}

describe("side-effect process ownership journal", () => {
  it("binds a random attempt to one action and validates a confirmed broker settlement", async () => {
    const graphcraftRoot = await createGraphcraftRoot();
    const runId = randomUUID();
    const definition = createSideEffectProcessDefinition(claim);
    const onReady = vi.fn(async () => undefined);
    const onSettled = vi.fn(async () => undefined);
    const lease = await createSideEffectProcessLease({
      graphcraftRoot,
      runId,
      definition,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
    });

    try {
      const lifecycle = lease.lifecycle({ onReady, onSettled });
      const brokerPid = 123;
      const childPid = 456;
      await appendRecord(lease, lifecycle.ownerToken, {
        brokerPid,
        status: "ready",
        readyAt: "2026-07-29T12:00:00.000Z",
      });
      await appendRecord(lease, lifecycle.ownerToken, {
        brokerPid,
        status: "starting",
        startingAt: "2026-07-29T12:00:01.000Z",
      });
      await appendRecord(lease, lifecycle.ownerToken, {
        brokerPid,
        status: "started",
        childPid,
        startedAt: "2026-07-29T12:00:02.000Z",
      });
      await appendRecord(lease, lifecycle.ownerToken, {
        brokerPid,
        status: "settled",
        outcome: "terminated",
        confirmed: true,
        childPid,
        exitCode: null,
        exitSignal: "SIGTERM",
        settledAt: "2026-07-29T12:00:03.000Z",
      });
      await lease.handle.sync();

      const inspected = await inspectSideEffectProcessJournal({
        graphcraftRoot,
        runId,
        definition,
        ownerTokenHash: lease.ownerTokenHash,
        expectedBrokerPid: brokerPid,
        hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      });

      expect(definition.executionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(lease.journalRelativePath).toBe(
        `locks/side-effect-processes/${runId}/${claim.actionId}.jsonl`,
      );
      expect(lifecycle).toMatchObject({
        executionId: definition.executionId,
        journalFd: lease.handle.fd,
        onReady,
        onSettled,
      });
      expect(lease.ownerTokenHash).toBe(
        contentHash(lifecycle.ownerToken, PORTABLE_CANONICAL_HASH_ALGORITHM),
      );
      expect(inspected).toMatchObject({
        prepared: { ...definition, status: "prepared" },
        brokerPid,
        settlement: {
          schemaVersion: 1,
          executionId: definition.executionId,
          brokerPid,
          childPid,
          outcome: "terminated",
          confirmed: true,
          exitSignal: "SIGTERM",
        },
      });
      expect(await readFile(lease.journalPath, "utf8")).not.toMatch(/command|args/);
    } finally {
      await closeSideEffectProcessLease(lease);
    }
  });

  it("rejects forged owner and broker identity without interpreting the PID", async () => {
    const graphcraftRoot = await createGraphcraftRoot();
    const runId = randomUUID();
    const definition = createSideEffectProcessDefinition({
      ...claim,
      kind: "github_check_rerun",
    });
    const lease = await createSideEffectProcessLease({ graphcraftRoot, runId, definition });

    try {
      const lifecycle = lease.lifecycle({
        onReady: async () => undefined,
        onSettled: async () => undefined,
      });
      await appendRecord(lease, lifecycle.ownerToken, {
        brokerPid: 777,
        status: "ready",
        readyAt: "2026-07-29T12:00:00.000Z",
      });
      await lease.handle.sync();

      await expect(
        inspectSideEffectProcessJournal({
          graphcraftRoot,
          runId,
          definition,
          ownerTokenHash: "0".repeat(64),
        }),
      ).rejects.toThrow(/ambiguous ownership metadata/i);
      await expect(
        inspectSideEffectProcessJournal({
          graphcraftRoot,
          runId,
          definition,
          ownerTokenHash: lease.ownerTokenHash,
          expectedBrokerPid: 778,
        }),
      ).rejects.toThrow(/broker identity is ambiguous/i);
    } finally {
      await closeSideEffectProcessLease(lease);
    }
  });

  it("uses the fixed action path exclusively and permits a new attempt only after removal", async () => {
    const graphcraftRoot = await createGraphcraftRoot();
    const runId = randomUUID();
    const firstDefinition = createSideEffectProcessDefinition(claim);
    const first = await createSideEffectProcessLease({
      graphcraftRoot,
      runId,
      definition: firstDefinition,
    });
    const secondDefinition = createSideEffectProcessDefinition(claim);
    expect(secondDefinition.executionId).not.toBe(firstDefinition.executionId);

    await expect(
      createSideEffectProcessLease({
        graphcraftRoot,
        runId,
        definition: secondDefinition,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    await closeSideEffectProcessLease(first);
    await removeSideEffectProcessJournal({
      graphcraftRoot,
      runId,
      actionId: claim.actionId,
    });
    await expect(stat(first.journalPath)).rejects.toMatchObject({ code: "ENOENT" });

    const second = await createSideEffectProcessLease({
      graphcraftRoot,
      runId,
      definition: secondDefinition,
    });
    await closeSideEffectProcessLease(second);
    await removeSideEffectProcessJournal({
      graphcraftRoot,
      runId,
      actionId: claim.actionId,
    });
    await expect(
      inspectSideEffectProcessJournal({ graphcraftRoot, runId, definition: secondDefinition }),
    ).resolves.toBeUndefined();
    await expect(
      removeSideEffectProcessJournal({ graphcraftRoot, runId, actionId: claim.actionId }),
    ).resolves.toBeUndefined();
  });
});

describe("side-effect process settlement polling", () => {
  const definition: SideEffectProcessDefinition = {
    schemaVersion: 1,
    executionId: "00000000-0000-4000-8000-000000000001",
    actionId: "b".repeat(64),
    nodeId: "pull-request",
    kind: "github_pr_create",
  };
  const ownerToken = "00000000-0000-4000-8000-000000000002";
  const input: Parameters<typeof waitForSideEffectProcessSettlement>[0] = {
    graphcraftRoot: "/unused-graphcraft-root",
    runId: "unused-run",
    definition,
  };
  const settledJournal = Buffer.from(
    [
      {
        ...definition,
        ownerToken,
        status: "prepared",
        preparedAt: "2026-07-29T12:00:00.000Z",
      },
      {
        schemaVersion: 1,
        executionId: definition.executionId,
        ownerToken,
        brokerPid: 123,
        status: "ready",
        readyAt: "2026-07-29T12:00:01.000Z",
      },
      {
        schemaVersion: 1,
        executionId: definition.executionId,
        ownerToken,
        brokerPid: 123,
        status: "settled",
        outcome: "cancelled_before_start",
        confirmed: true,
        childPid: null,
        exitCode: null,
        exitSignal: null,
        settledAt: "2026-07-29T12:00:02.000Z",
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );

  it("retries only an in-read coherence race on the existing 25ms poll", async () => {
    vi.useFakeTimers();
    const read = vi.mocked(readPrivateFileBounded);
    read
      .mockRejectedValueOnce(new Error("Private file changed during its bounded read"))
      .mockResolvedValueOnce(settledJournal);

    const settlement = waitForSideEffectProcessSettlement(input, 100);
    await vi.advanceTimersByTimeAsync(24);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(settlement).resolves.toMatchObject({
      settlement: {
        executionId: definition.executionId,
        brokerPid: 123,
        outcome: "cancelled_before_start",
        confirmed: true,
      },
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not retry malformed ownership evidence", async () => {
    vi.useFakeTimers();
    const read = vi.mocked(readPrivateFileBounded);
    const failure = new Error(
      `Side-effect process ${definition.executionId} has ambiguous ownership metadata`,
    );
    read.mockRejectedValueOnce(failure);

    await expect(waitForSideEffectProcessSettlement(input, 100)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
