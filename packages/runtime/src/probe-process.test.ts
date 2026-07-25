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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeProbeProcessLease,
  createProbeProcessLease,
  inspectProbeProcessJournal,
  probeProcessDefinitions,
  type ProbeProcessLease,
} from "./probe-process.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
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
