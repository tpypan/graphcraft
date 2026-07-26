import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  contentHash,
  type CanonicalHashAlgorithm,
  type ProbeSpec,
} from "@graphcraft/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPrivateFileBounded } from "./secure-fs.ts";
import {
  closeProbeProcessLease,
  createProbeProcessLease,
  inspectProbeProcessJournal,
  probeProcessDefinitions,
  type ProbeProcessLease,
  waitForProbeProcessSettlement,
} from "./probe-process.ts";

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

const commandProbe: Extract<ProbeSpec, { kind: "command" }> = {
  id: "portable-command",
  kind: "command",
  command: "node",
  args: ["verify.mjs", "Ångström"],
  cwd: "fixture",
  expectedExitCode: 0,
  timeoutMs: 30_000,
};

function expectedCommandHash(algorithm: CanonicalHashAlgorithm): string {
  return contentHash(
    {
      schemaVersion: 1,
      command: commandProbe.command,
      args: commandProbe.args,
      cwd: commandProbe.cwd,
      expectedExitCode: commandProbe.expectedExitCode,
      timeoutMs: commandProbe.timeoutMs,
    },
    algorithm,
  );
}

describe("probe-process hashing", () => {
  it("preserves legacy definition hashing by default", () => {
    const checkpointId = "legacy-checkpoint";
    const probes: ProbeSpec[] = [
      { id: "ignored-file", kind: "file", path: "README.md", shouldExist: true },
      commandProbe,
    ];
    const commandHash = expectedCommandHash(LEGACY_CANONICAL_HASH_ALGORITHM);
    const expected = [
      {
        schemaVersion: 1 as const,
        executionId: contentHash(
          {
            schemaVersion: 1,
            kind: "probe_process",
            checkpointId,
            probeId: commandProbe.id,
            index: 1,
            commandHash,
          },
          LEGACY_CANONICAL_HASH_ALGORITHM,
        ),
        probeId: commandProbe.id,
        commandHash,
      },
    ];

    expect(probeProcessDefinitions(checkpointId, probes)).toEqual(expected);
    expect(probeProcessDefinitions(checkpointId, probes, LEGACY_CANONICAL_HASH_ALGORITHM)).toEqual(
      expected,
    );
  });

  it("keeps portable command and execution identities independent of ambient collation", () => {
    const checkpointId = "portable-checkpoint";
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("portable probe-process hashing used ambient collation");
    });

    const [definition] = probeProcessDefinitions(
      checkpointId,
      [commandProbe],
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );
    const commandHash = expectedCommandHash(PORTABLE_CANONICAL_HASH_ALGORITHM);

    expect(definition).toEqual({
      schemaVersion: 1,
      executionId: contentHash(
        {
          schemaVersion: 1,
          kind: "probe_process",
          checkpointId,
          probeId: commandProbe.id,
          index: 0,
          commandHash,
        },
        PORTABLE_CANONICAL_HASH_ALGORITHM,
      ),
      probeId: commandProbe.id,
      commandHash,
    });
    expect(localeCompare).not.toHaveBeenCalled();
  });

  it("binds and recovers journal ownership with the selected algorithm", async () => {
    const repository = await mkdtemp(join(tmpdir(), "graphcraft-probe-process-hash-"));
    temporaryRoots.push(repository);
    const graphcraftRoot = join(repository, ".graphcraft");
    await mkdir(graphcraftRoot, { mode: 0o700 });
    const runId = randomUUID();
    const checkpointId = "portable-journal-checkpoint";
    const [definition] = probeProcessDefinitions(
      checkpointId,
      [commandProbe],
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );
    if (!definition) throw new Error("Expected one command-process definition");
    let lease: ProbeProcessLease | undefined;
    try {
      lease = await createProbeProcessLease({
        graphcraftRoot,
        runId,
        checkpointId,
        nodeId: "verify",
        stage: "verification",
        definition,
        hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      });
      const inspected = await inspectProbeProcessJournal({
        graphcraftRoot,
        runId,
        checkpointId,
        nodeId: "verify",
        stage: "verification",
        definition,
        ownerTokenHash: lease.ownerTokenHash,
        hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      });

      expect(inspected).toBeDefined();
      expect(lease.ownerTokenHash).toBe(
        contentHash(inspected!.prepared.ownerToken, PORTABLE_CANONICAL_HASH_ALGORITHM),
      );
      await expect(
        inspectProbeProcessJournal({
          graphcraftRoot,
          runId,
          checkpointId,
          nodeId: "verify",
          stage: "verification",
          definition,
          ownerTokenHash: "0".repeat(64),
          hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
        }),
      ).rejects.toThrow(/ambiguous ownership metadata/i);
    } finally {
      if (lease) await closeProbeProcessLease(lease);
    }
  });
});

describe("probe-process settlement polling", () => {
  const executionId = "1".repeat(64);
  const commandHash = "2".repeat(64);
  const ownerToken = "00000000-0000-4000-8000-000000000001";
  const input: Parameters<typeof waitForProbeProcessSettlement>[0] = {
    graphcraftRoot: "/unused-graphcraft-root",
    runId: "unused-run",
    checkpointId: "checkpoint",
    nodeId: "verify",
    stage: "verification",
    definition: {
      schemaVersion: 1,
      executionId,
      probeId: "command",
      commandHash,
    },
  };
  const settledJournal = Buffer.from(
    [
      {
        schemaVersion: 1,
        executionId,
        ownerToken,
        status: "prepared",
        checkpointId: input.checkpointId,
        nodeId: input.nodeId,
        stage: input.stage,
        probeId: input.definition.probeId,
        commandHash,
        preparedAt: "2026-07-26T00:00:00.000Z",
      },
      {
        schemaVersion: 1,
        executionId,
        ownerToken,
        brokerPid: 123,
        status: "ready",
        readyAt: "2026-07-26T00:00:01.000Z",
      },
      {
        schemaVersion: 1,
        executionId,
        ownerToken,
        brokerPid: 123,
        status: "settled",
        outcome: "cancelled_before_start",
        confirmed: true,
        childPid: null,
        exitCode: null,
        exitSignal: null,
        settledAt: "2026-07-26T00:00:02.000Z",
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );

  it("retries an in-read coherence race on the existing 25ms poll", async () => {
    vi.useFakeTimers();
    const read = vi.mocked(readPrivateFileBounded);
    read
      .mockRejectedValueOnce(new Error("Private file changed during its bounded read"))
      .mockResolvedValueOnce(settledJournal);

    const settlement = waitForProbeProcessSettlement(input, 100);
    await vi.advanceTimersByTimeAsync(24);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(settlement).resolves.toMatchObject({
      settlement: {
        executionId,
        brokerPid: 123,
        outcome: "cancelled_before_start",
        confirmed: true,
      },
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rethrows the final in-read coherence error at the deadline", async () => {
    vi.useFakeTimers();
    const read = vi.mocked(readPrivateFileBounded);
    const first = new Error("Private file changed during its bounded read");
    const final = new Error("Private file changed during its bounded read");
    read.mockRejectedValueOnce(first).mockRejectedValueOnce(final);

    const settlement = expect(waitForProbeProcessSettlement(input, 25)).rejects.toBe(final);
    await vi.advanceTimersByTimeAsync(25);

    await settlement;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    "Private file changed before its bounded read",
    "Probe process journal is malformed",
    `Probe process ${executionId} has ambiguous ownership metadata`,
    `Probe process ${executionId} has an invalid journal order`,
  ])("does not retry the non-coherence failure: %s", async (message) => {
    vi.useFakeTimers();
    const read = vi.mocked(readPrivateFileBounded);
    const failure = new Error(message);
    read.mockRejectedValueOnce(failure);

    await expect(waitForProbeProcessSettlement(input, 100)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
