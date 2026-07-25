import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  HeldOutProbePlanSchema,
  compileGraph,
  compileRunContract,
  contentHash,
  createHeldOutProbePlan,
  createRunEvent,
  type CanonicalHashAlgorithm,
  type RunEvent,
} from "@graphcraft/core";
import { createViewerSnapshot } from "./viewer.ts";
import {
  RUN_BLOCKED_EVENT_RESERVE_BYTES,
  RunStore,
  RunStoreEventLogCorruptionError,
  RunStoreLimitError,
} from "./store.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

async function createStoreFixture(): Promise<{ root: string; store: RunStore; event: RunEvent }> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-store-test-"));
  temporaryRoots.push(root);
  const contract = compileRunContract(
    "Exercise durable event-tail recovery",
    { root, baseRef: "main", baseSha: "a".repeat(40) },
    { finishLine: "local_verified" },
  );
  const graph = compileGraph(contract, [
    { id: "verification-file", kind: "file", path: "verified.txt", shouldExist: true },
  ]);
  const store = await RunStore.create(root, contract, graph);
  const [event] = await store.loadEvents();
  if (!event) throw new Error("Expected the run-created fixture event");
  return { root, store, event };
}

function serializedEvent(event: RunEvent): Buffer {
  return Buffer.from(`${JSON.stringify(event)}\n`);
}

function eventHashAlgorithm(event: RunEvent): CanonicalHashAlgorithm {
  return event.schemaVersion === 2
    ? PORTABLE_CANONICAL_HASH_ALGORITHM
    : LEGACY_CANONICAL_HASH_ALGORITHM;
}

async function rewriteProbeEvidenceCheckpointFormat(store: RunStore, format: 1 | 2): Promise<void> {
  const events = await store.loadEvents();
  const created = events[0];
  if (!created || created.type !== "run.created")
    throw new Error("Expected a run.created fixture event");
  const data = { ...created.data };
  delete data.probeEvidenceCheckpointFormat;
  if (format === 2) data.probeEvidenceCheckpointFormat = 2;
  const rewritten = createRunEvent(
    {
      sequence: created.sequence,
      timestamp: created.timestamp,
      actor: created.actor,
      causationId: created.causationId,
      type: created.type,
      data,
    },
    eventHashAlgorithm(created),
  );
  await writeFile(
    store.eventsPath(),
    Buffer.concat([serializedEvent(rewritten), ...events.slice(1).map(serializedEvent)]),
  );
}

async function rewriteGovernanceControlIdentityFormat(
  store: RunStore,
  format: 1 | 2,
): Promise<void> {
  const events = await store.loadEvents();
  const created = events[0];
  if (!created || created.type !== "run.created")
    throw new Error("Expected a run.created fixture event");
  const data = { ...created.data };
  delete data.governanceControlIdentityFormat;
  if (format === 2) data.governanceControlIdentityFormat = 2;
  const rewritten = createRunEvent(
    {
      sequence: created.sequence,
      timestamp: created.timestamp,
      actor: created.actor,
      causationId: created.causationId,
      type: created.type,
      data,
    },
    eventHashAlgorithm(created),
  );
  await writeFile(
    store.eventsPath(),
    Buffer.concat([serializedEvent(rewritten), ...events.slice(1).map(serializedEvent)]),
  );
}

async function rewriteRepositorySideEffectIdentityFormat(
  store: RunStore,
  format: 1 | 2,
): Promise<void> {
  const events = await store.loadEvents();
  const created = events[0];
  if (!created || created.type !== "run.created")
    throw new Error("Expected a run.created fixture event");
  const data = { ...created.data };
  delete data.repositorySideEffectIdentityFormat;
  if (format === 2) data.repositorySideEffectIdentityFormat = 2;
  const rewritten = createRunEvent(
    {
      sequence: created.sequence,
      timestamp: created.timestamp,
      actor: created.actor,
      causationId: created.causationId,
      type: created.type,
      data,
    },
    eventHashAlgorithm(created),
  );
  await writeFile(
    store.eventsPath(),
    Buffer.concat([serializedEvent(rewritten), ...events.slice(1).map(serializedEvent)]),
  );
}

describe("storage v3 initialization", () => {
  it("finalizes an event-complete initializing descriptor concurrently without rewriting events", async () => {
    const { root, store } = await createStoreFixture();
    const storagePath = join(store.runRoot, "storage.json");
    const descriptor = JSON.parse(await readFile(storagePath, "utf8")) as Record<string, unknown>;
    descriptor.initialization = "initializing";
    await writeFile(storagePath, `${JSON.stringify(descriptor, null, 2)}\n`);
    const eventsBefore = await readFile(store.eventsPath());

    await Promise.all([
      new RunStore(root, store.runId).prepareStorage(),
      new RunStore(root, store.runId).prepareStorage(),
    ]);

    expect(JSON.parse(await readFile(storagePath, "utf8"))).toMatchObject({
      schemaVersion: 3,
      runId: store.runId,
      migratedFrom: 3,
      initialization: "ready",
      canonicalHashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      formats: {
        heldOutProbes: 2,
        events: 2,
        artifactInventory: 2,
        workspaceScopeSnapshots: 2,
        probeEvidenceCheckpoints: 2,
        governanceControlIdentities: 2,
        repositorySideEffectIdentities: 2,
      },
    });
    expect(await readFile(store.eventsPath())).toEqual(eventsBefore);
  });

  it("binds fresh and reopened artifact identities to portable v2 without ambient locale", async () => {
    const { root, store } = await createStoreFixture();
    const reopened = new RunStore(root, store.runId);
    expect(() => reopened.artifactHashAlgorithm).toThrow(/before run storage is prepared/);
    expect(() => reopened.workspaceScopeHashAlgorithm).toThrow(/before run storage is prepared/);
    expect(() => reopened.probeEvidenceCheckpointHashAlgorithm).toThrow(
      /before run storage is prepared/,
    );
    expect(() => reopened.governanceControlIdentityHashAlgorithm).toThrow(
      /before run storage is prepared/,
    );
    expect(() => reopened.repositorySideEffectIdentityHashAlgorithm).toThrow(
      /before run storage is prepared/,
    );
    expect(() => reopened.artifactContentHash({ pending: true })).toThrow(
      /before run storage is prepared/,
    );
    await reopened.prepareStorage();

    expect(store.artifactHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(reopened.artifactHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(store.workspaceScopeHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(reopened.workspaceScopeHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(store.probeEvidenceCheckpointHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(reopened.probeEvidenceCheckpointHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(store.governanceControlIdentityHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(reopened.governanceControlIdentityHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(store.repositorySideEffectIdentityHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(reopened.repositorySideEffectIdentityHashAlgorithm).toBe(
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );
    expect(JSON.parse(await readFile(join(store.runRoot, "storage.json"), "utf8"))).toMatchObject({
      formats: {
        artifactInventory: 2,
        workspaceScopeSnapshots: 2,
        probeEvidenceCheckpoints: 2,
        governanceControlIdentities: 2,
        repositorySideEffectIdentities: 2,
      },
    });
    expect((await reopened.loadEvents())[0]?.data.repositorySideEffectIdentityFormat).toBe(2);

    const capsule = { z: { a: 1 }, A: { b: 2 } };
    const capsuleHash = contentHash(capsule, PORTABLE_CANONICAL_HASH_ALGORITHM);
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("portable artifact persistence used ambient locale ordering");
    });
    let inventoryPaths: string[] = [];
    try {
      await reopened.writeCapsule(capsuleHash, capsule);
      await reopened.writeArtifact("Ångstrom.txt", "portable\n");
      await reopened.writeArtifact("Zulu.txt", "portable\n");
      inventoryPaths = (await reopened.loadArtifactInventory()).entries.map(({ path }) => path);
    } finally {
      localeCompare.mockRestore();
    }

    expect(inventoryPaths).toEqual([...inventoryPaths].sort());
    expect(inventoryPaths).toEqual(
      expect.arrayContaining([
        `capsules/${capsuleHash}.json`,
        "artifacts/Ångstrom.txt",
        "artifacts/Zulu.txt",
      ]),
    );
  });

  it("keeps a prior ready v3 scope policy legacy without rewriting its descriptor", async () => {
    const { root, store } = await createStoreFixture();
    const storagePath = join(store.runRoot, "storage.json");
    const descriptor = JSON.parse(await readFile(storagePath, "utf8")) as {
      formats: { workspaceScopeSnapshots?: number };
    };
    delete descriptor.formats.workspaceScopeSnapshots;
    await writeFile(storagePath, `${JSON.stringify(descriptor, null, 2)}\n`);
    const descriptorBefore = await readFile(storagePath);

    const reopened = new RunStore(root, store.runId);
    await reopened.prepareStorage();

    expect(reopened.canonicalHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(reopened.workspaceScopeHashAlgorithm).toBe(LEGACY_CANONICAL_HASH_ALGORITHM);
    expect(await readFile(storagePath)).toEqual(descriptorBefore);
  });

  it("keeps a prior ready v3 probe-evidence policy legacy without rewriting its descriptor", async () => {
    const { root, store } = await createStoreFixture();
    const storagePath = join(store.runRoot, "storage.json");
    await rewriteProbeEvidenceCheckpointFormat(store, 1);
    const descriptor = JSON.parse(await readFile(storagePath, "utf8")) as {
      formats: { probeEvidenceCheckpoints?: number };
    };
    delete descriptor.formats.probeEvidenceCheckpoints;
    await writeFile(storagePath, `${JSON.stringify(descriptor, null, 2)}\n`);
    const descriptorBefore = await readFile(storagePath);

    const reopened = new RunStore(root, store.runId);
    await reopened.prepareStorage();

    expect(reopened.canonicalHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(reopened.probeEvidenceCheckpointHashAlgorithm).toBe(LEGACY_CANONICAL_HASH_ALGORITHM);
    await expect(reopened.loadEvents()).resolves.toHaveLength(1);
    expect(await readFile(storagePath)).toEqual(descriptorBefore);
  });

  it("keeps a prior ready v3 governance/control identity policy legacy", async () => {
    const { root, store } = await createStoreFixture();
    const storagePath = join(store.runRoot, "storage.json");
    await rewriteGovernanceControlIdentityFormat(store, 1);
    const descriptor = JSON.parse(await readFile(storagePath, "utf8")) as {
      formats: { governanceControlIdentities?: number };
    };
    delete descriptor.formats.governanceControlIdentities;
    await writeFile(storagePath, `${JSON.stringify(descriptor, null, 2)}\n`);
    const descriptorBefore = await readFile(storagePath);

    const reopened = new RunStore(root, store.runId);
    await reopened.prepareStorage();

    expect(reopened.canonicalHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(reopened.governanceControlIdentityHashAlgorithm).toBe(LEGACY_CANONICAL_HASH_ALGORITHM);
    await expect(reopened.loadEvents()).resolves.toHaveLength(1);
    expect(await readFile(storagePath)).toEqual(descriptorBefore);
  });

  it("keeps a prior ready v3 repository side-effect identity policy legacy", async () => {
    const { root, store } = await createStoreFixture();
    const storagePath = join(store.runRoot, "storage.json");
    await rewriteRepositorySideEffectIdentityFormat(store, 1);
    const descriptor = JSON.parse(await readFile(storagePath, "utf8")) as {
      formats: { repositorySideEffectIdentities?: number };
    };
    delete descriptor.formats.repositorySideEffectIdentities;
    await writeFile(storagePath, `${JSON.stringify(descriptor, null, 2)}\n`);
    const descriptorBefore = await readFile(storagePath);

    const reopened = new RunStore(root, store.runId);
    await reopened.prepareStorage();

    expect(reopened.canonicalHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(reopened.repositorySideEffectIdentityHashAlgorithm).toBe(
      LEGACY_CANONICAL_HASH_ALGORITHM,
    );
    await expect(reopened.loadEvents()).resolves.toHaveLength(1);
    expect(await readFile(storagePath)).toEqual(descriptorBefore);
  });

  it.each(
    [
      {
        name: "legacy v1 checkpoints relabelled as portable v2",
        sourceFormat: 1 as const,
        relabelledFormat: 2 as const,
      },
      {
        name: "portable v2 checkpoints relabelled as legacy v1",
        sourceFormat: 2 as const,
        relabelledFormat: 1 as const,
      },
    ].flatMap((fixture) =>
      (["ready", "initializing"] as const).map((initialization) => ({
        ...fixture,
        initialization,
      })),
    ),
  )(
    "rejects $name from an $initialization descriptor without changing durable bytes",
    async (fixture) => {
      const { root, store } = await createStoreFixture();
      const storagePath = join(store.runRoot, "storage.json");
      const statePath = join(store.runRoot, "state.json");
      await rewriteProbeEvidenceCheckpointFormat(store, fixture.sourceFormat);
      const descriptor = JSON.parse(await readFile(storagePath, "utf8")) as {
        formats: { probeEvidenceCheckpoints?: number };
      };
      if (fixture.sourceFormat === 1) delete descriptor.formats.probeEvidenceCheckpoints;
      else descriptor.formats.probeEvidenceCheckpoints = 2;
      await writeFile(storagePath, `${JSON.stringify(descriptor, null, 2)}\n`);

      const selected = new RunStore(root, store.runId);
      await selected.prepareStorage();
      expect(selected.probeEvidenceCheckpointHashAlgorithm).toBe(
        fixture.sourceFormat === 2
          ? PORTABLE_CANONICAL_HASH_ALGORITHM
          : LEGACY_CANONICAL_HASH_ALGORITHM,
      );
      await expect(new RunStore(root, store.runId).loadEvents()).resolves.toHaveLength(1);

      const relabelled = JSON.parse(await readFile(storagePath, "utf8")) as {
        initialization: string;
        formats: { probeEvidenceCheckpoints?: number };
      };
      if (fixture.relabelledFormat === 1) delete relabelled.formats.probeEvidenceCheckpoints;
      else relabelled.formats.probeEvidenceCheckpoints = 2;
      relabelled.initialization = fixture.initialization;
      await writeFile(storagePath, `${JSON.stringify(relabelled, null, 2)}\n`);
      const beforeRejection = {
        events: await readFile(store.eventsPath()),
        state: await readFile(statePath),
        storage: await readFile(storagePath),
      };

      const wrongPolicy = new RunStore(root, store.runId);
      await expect(wrongPolicy.loadEvents()).rejects.toThrow(
        /probe-evidence checkpoint format that disagrees/,
      );
      expect(await readFile(store.eventsPath())).toEqual(beforeRejection.events);
      expect(await readFile(statePath)).toEqual(beforeRejection.state);
      expect(await readFile(storagePath)).toEqual(beforeRejection.storage);
    },
  );

  it.each(
    [
      {
        name: "legacy v1 identities relabelled as portable v2",
        sourceFormat: 1 as const,
        relabelledFormat: 2 as const,
      },
      {
        name: "portable v2 identities relabelled as legacy v1",
        sourceFormat: 2 as const,
        relabelledFormat: 1 as const,
      },
    ].flatMap((fixture) =>
      (["ready", "initializing"] as const).map((initialization) => ({
        ...fixture,
        initialization,
      })),
    ),
  )(
    "rejects repository side-effect $name from an $initialization descriptor without changing durable bytes",
    async (fixture) => {
      const { root, store } = await createStoreFixture();
      const storagePath = join(store.runRoot, "storage.json");
      const statePath = join(store.runRoot, "state.json");
      await rewriteRepositorySideEffectIdentityFormat(store, fixture.sourceFormat);
      const descriptor = JSON.parse(await readFile(storagePath, "utf8")) as {
        formats: { repositorySideEffectIdentities?: number };
      };
      if (fixture.sourceFormat === 1) delete descriptor.formats.repositorySideEffectIdentities;
      else descriptor.formats.repositorySideEffectIdentities = 2;
      await writeFile(storagePath, `${JSON.stringify(descriptor, null, 2)}\n`);

      const selected = new RunStore(root, store.runId);
      await selected.prepareStorage();
      expect(selected.repositorySideEffectIdentityHashAlgorithm).toBe(
        fixture.sourceFormat === 2
          ? PORTABLE_CANONICAL_HASH_ALGORITHM
          : LEGACY_CANONICAL_HASH_ALGORITHM,
      );
      await expect(selected.loadEvents()).resolves.toHaveLength(1);

      const relabelled = JSON.parse(await readFile(storagePath, "utf8")) as {
        initialization: string;
        formats: { repositorySideEffectIdentities?: number };
      };
      if (fixture.relabelledFormat === 1) delete relabelled.formats.repositorySideEffectIdentities;
      else relabelled.formats.repositorySideEffectIdentities = 2;
      relabelled.initialization = fixture.initialization;
      await writeFile(storagePath, `${JSON.stringify(relabelled, null, 2)}\n`);
      const beforeRejection = {
        events: await readFile(store.eventsPath()),
        state: await readFile(statePath),
        storage: await readFile(storagePath),
      };

      await expect(new RunStore(root, store.runId).loadEvents()).rejects.toThrow(
        /repository side-effect identity format that disagrees/,
      );
      expect(await readFile(store.eventsPath())).toEqual(beforeRejection.events);
      expect(await readFile(statePath)).toEqual(beforeRejection.state);
      expect(await readFile(storagePath)).toEqual(beforeRejection.storage);
    },
  );

  it.each(
    [
      {
        name: "legacy v1 identities relabelled as portable v2",
        sourceFormat: 1 as const,
        relabelledFormat: 2 as const,
      },
      {
        name: "portable v2 identities relabelled as legacy v1",
        sourceFormat: 2 as const,
        relabelledFormat: 1 as const,
      },
    ].flatMap((fixture) =>
      (["ready", "initializing"] as const).map((initialization) => ({
        ...fixture,
        initialization,
      })),
    ),
  )(
    "rejects governance/control $name from an $initialization descriptor without changing durable bytes",
    async (fixture) => {
      const { root, store } = await createStoreFixture();
      const storagePath = join(store.runRoot, "storage.json");
      const statePath = join(store.runRoot, "state.json");
      await rewriteGovernanceControlIdentityFormat(store, fixture.sourceFormat);
      const descriptor = JSON.parse(await readFile(storagePath, "utf8")) as {
        formats: { governanceControlIdentities?: number };
      };
      if (fixture.sourceFormat === 1) delete descriptor.formats.governanceControlIdentities;
      else descriptor.formats.governanceControlIdentities = 2;
      await writeFile(storagePath, `${JSON.stringify(descriptor, null, 2)}\n`);

      const selected = new RunStore(root, store.runId);
      await selected.prepareStorage();
      expect(selected.governanceControlIdentityHashAlgorithm).toBe(
        fixture.sourceFormat === 2
          ? PORTABLE_CANONICAL_HASH_ALGORITHM
          : LEGACY_CANONICAL_HASH_ALGORITHM,
      );
      await expect(selected.loadEvents()).resolves.toHaveLength(1);

      const relabelled = JSON.parse(await readFile(storagePath, "utf8")) as {
        initialization: string;
        formats: { governanceControlIdentities?: number };
      };
      if (fixture.relabelledFormat === 1) delete relabelled.formats.governanceControlIdentities;
      else relabelled.formats.governanceControlIdentities = 2;
      relabelled.initialization = fixture.initialization;
      await writeFile(storagePath, `${JSON.stringify(relabelled, null, 2)}\n`);
      const beforeRejection = {
        events: await readFile(store.eventsPath()),
        state: await readFile(statePath),
        storage: await readFile(storagePath),
      };

      await expect(new RunStore(root, store.runId).loadEvents()).rejects.toThrow(
        /governance\/control identity format that disagrees/,
      );
      expect(await readFile(store.eventsPath())).toEqual(beforeRejection.events);
      expect(await readFile(statePath)).toEqual(beforeRejection.state);
      expect(await readFile(storagePath)).toEqual(beforeRejection.storage);
    },
  );

  it("replays and repairs only portable-v2 held-out plans for fresh storage", async () => {
    const { store, event } = await createStoreFixture();
    const heldOutPath = join(store.runRoot, "held-out-probes.json");
    const portable = await store.loadHeldOutProbePlan();
    const eventPlan = HeldOutProbePlanSchema.parse(event.data.heldOutProbePlan);

    expect(portable).toMatchObject({
      schemaVersion: 2,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
    });
    expect(eventPlan).toEqual(portable);
    expect(JSON.parse(await readFile(heldOutPath, "utf8"))).toEqual(portable);

    const legacy = createHeldOutProbePlan(store.runId, await store.loadProbePlan());
    await writeFile(heldOutPath, `${JSON.stringify(legacy, null, 2)}\n`);
    const legacyBytes = await readFile(heldOutPath);
    await expect(store.saveHeldOutProbePlan(legacy)).rejects.toThrow(
      /format disagrees with its storage hash algorithm/,
    );
    expect(await readFile(heldOutPath)).toEqual(legacyBytes);

    expect(await store.loadHeldOutProbePlan()).toEqual(portable);
    expect(JSON.parse(await readFile(heldOutPath, "utf8"))).toEqual(portable);
    const eventsBeforeRebuild = await readFile(store.eventsPath());
    await writeFile(heldOutPath, "not-json\n");
    await store.rebuildViews();
    expect(JSON.parse(await readFile(heldOutPath, "utf8"))).toEqual(portable);
    expect(await readFile(store.eventsPath())).toEqual(eventsBeforeRebuild);
  });

  it("preserves prior event-v2 and held-out-v1 runs through initialization recovery", async () => {
    const { root, store, event } = await createStoreFixture();
    const storagePath = join(store.runRoot, "storage.json");
    const heldOutPath = join(store.runRoot, "held-out-probes.json");
    const portable = await store.loadHeldOutProbePlan();
    const legacy = createHeldOutProbePlan(store.runId, await store.loadProbePlan());
    const priorData: Record<string, unknown> = { ...event.data, heldOutProbePlan: legacy };
    delete priorData.probeEvidenceCheckpointFormat;
    delete priorData.governanceControlIdentityFormat;
    delete priorData.repositorySideEffectIdentityFormat;
    const priorEvent = createRunEvent(
      {
        sequence: event.sequence,
        timestamp: event.timestamp,
        actor: event.actor,
        causationId: event.causationId,
        type: event.type,
        data: priorData,
      },
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );
    await writeFile(store.eventsPath(), serializedEvent(priorEvent));
    await writeFile(heldOutPath, `${JSON.stringify(legacy, null, 2)}\n`);
    const descriptor = JSON.parse(await readFile(storagePath, "utf8")) as {
      initialization: string;
      formats: {
        heldOutProbes: number;
        artifactInventory: number;
        workspaceScopeSnapshots?: number;
        probeEvidenceCheckpoints?: number;
        governanceControlIdentities?: number;
        repositorySideEffectIdentities?: number;
      };
    };
    descriptor.initialization = "initializing";
    descriptor.formats.heldOutProbes = 1;
    descriptor.formats.artifactInventory = 1;
    delete descriptor.formats.workspaceScopeSnapshots;
    delete descriptor.formats.probeEvidenceCheckpoints;
    delete descriptor.formats.governanceControlIdentities;
    delete descriptor.formats.repositorySideEffectIdentities;
    await writeFile(storagePath, `${JSON.stringify(descriptor, null, 2)}\n`);
    const eventsBeforeRecovery = await readFile(store.eventsPath());

    const reopened = new RunStore(root, store.runId);
    await reopened.prepareStorage();

    expect(reopened.canonicalHashAlgorithm).toBe(PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(reopened.heldOutProbePlanHashAlgorithm).toBe(LEGACY_CANONICAL_HASH_ALGORITHM);
    expect(reopened.artifactHashAlgorithm).toBe(LEGACY_CANONICAL_HASH_ALGORITHM);
    expect(reopened.workspaceScopeHashAlgorithm).toBe(LEGACY_CANONICAL_HASH_ALGORITHM);
    expect(reopened.probeEvidenceCheckpointHashAlgorithm).toBe(LEGACY_CANONICAL_HASH_ALGORITHM);
    expect(reopened.governanceControlIdentityHashAlgorithm).toBe(LEGACY_CANONICAL_HASH_ALGORITHM);
    expect(reopened.repositorySideEffectIdentityHashAlgorithm).toBe(
      LEGACY_CANONICAL_HASH_ALGORITHM,
    );
    expect(JSON.parse(await readFile(storagePath, "utf8"))).toMatchObject({
      initialization: "ready",
      canonicalHashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      formats: {
        heldOutProbes: 1,
        events: 2,
        artifactInventory: 1,
        workspaceScopeSnapshots: 1,
        probeEvidenceCheckpoints: 1,
        governanceControlIdentities: 1,
        repositorySideEffectIdentities: 1,
      },
    });
    expect(await readFile(store.eventsPath())).toEqual(eventsBeforeRecovery);
    expect(await reopened.loadHeldOutProbePlan()).toEqual(legacy);

    await writeFile(heldOutPath, `${JSON.stringify(portable, null, 2)}\n`);
    expect(await reopened.loadHeldOutProbePlan()).toEqual(legacy);
    expect(JSON.parse(await readFile(heldOutPath, "utf8"))).toEqual(legacy);
    expect(
      await reopened.append("runtime", "run.paused", { reason: "continue prior v3 run" }),
    ).toMatchObject({ schemaVersion: 2 });
    expect(await reopened.loadHeldOutProbePlan()).toEqual(legacy);

    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
      this: string,
      other: string,
    ) {
      const left = String(this);
      return left < other ? 1 : left > other ? -1 : 0;
    });
    try {
      const capsule = { z: 1, A: 2 };
      const legacyHash = contentHash(capsule, LEGACY_CANONICAL_HASH_ALGORITHM);
      const portableHash = contentHash(capsule, PORTABLE_CANONICAL_HASH_ALGORITHM);
      expect(legacyHash).not.toBe(portableHash);
      await expect(reopened.writeCapsule(legacyHash, capsule)).resolves.toMatchObject({
        reused: false,
      });
      await expect(reopened.writeCapsule(portableHash, capsule)).rejects.toThrow(
        /redacted before content addressing/,
      );
    } finally {
      localeCompare.mockRestore();
    }
  });

  it("leaves a pre-event initializing descriptor intact with a precise blocker", async () => {
    const { root, store } = await createStoreFixture();
    const storagePath = join(store.runRoot, "storage.json");
    const descriptor = JSON.parse(await readFile(storagePath, "utf8")) as Record<string, unknown>;
    descriptor.initialization = "initializing";
    const initializingBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
    await writeFile(storagePath, initializingBytes);
    await writeFile(store.eventsPath(), "");

    await expect(new RunStore(root, store.runId).prepareStorage()).rejects.toThrow(
      /incomplete schema-v3 initialization before its first durable event/,
    );

    expect(await readFile(storagePath)).toEqual(initializingBytes);
    expect(await readFile(store.eventsPath())).toEqual(Buffer.alloc(0));
  });
});

describe("durable event log tails", () => {
  it("reads a valid unterminated event without mutation and repays the delimiter on append", async () => {
    const { root, store } = await createStoreFixture();
    const eventsPath = store.eventsPath();
    const statePath = join(store.runRoot, "state.json");
    const original = await readFile(eventsPath);
    const unterminated = original.subarray(0, -1);
    const stateBefore = await readFile(statePath);
    await writeFile(eventsPath, unterminated);

    const reopened = new RunStore(root, store.runId);
    expect(await reopened.loadEvents()).toHaveLength(1);
    await reopened.loadState();
    await createViewerSnapshot(reopened);
    expect(await readFile(eventsPath)).toEqual(unterminated);
    expect(await readFile(statePath)).toEqual(stateBefore);

    await reopened.append("runtime", "run.paused", { reason: "delimiter recovery" });
    const recovered = await readFile(eventsPath);
    expect(recovered.subarray(0, unterminated.byteLength + 1)).toEqual(
      Buffer.concat([unterminated, Buffer.from("\n")]),
    );
    expect(recovered.toString("utf8").split("\n").filter(Boolean)).toHaveLength(2);
    expect(
      (await new RunStore(root, store.runId).loadEvents()).map(({ sequence }) => sequence),
    ).toEqual([1, 2]);
  });

  it("rebuilds stale state from a complete unterminated event before the next append", async () => {
    const { root, store, event } = await createStoreFixture();
    const eventsPath = store.eventsPath();
    const original = await readFile(eventsPath);
    const next = createRunEvent(
      {
        sequence: 2,
        timestamp: "2026-07-22T00:00:00.000Z",
        actor: "runtime",
        causationId: event.causationId,
        type: "run.paused",
        data: { reason: "crash after event bytes before delimiter and state" },
      },
      store.canonicalHashAlgorithm,
    );
    const interrupted = Buffer.concat([original, serializedEvent(next).subarray(0, -1)]);
    await writeFile(eventsPath, interrupted);

    const reopened = new RunStore(root, store.runId);
    expect((await reopened.loadEvents()).map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(await readFile(eventsPath)).toEqual(interrupted);
    expect((await reopened.loadState()).lastEventSequence).toBe(2);
    expect(await readFile(eventsPath)).toEqual(interrupted);

    await reopened.append("runtime", "run.started", { reason: "resume after projection rebuild" });
    const recovered = await readFile(eventsPath);
    expect(recovered.toString("utf8").split("\n").filter(Boolean)).toHaveLength(3);
    expect((await reopened.loadEvents()).map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
  });

  it("serializes same-store appends while repaying exactly one delimiter", async () => {
    const { store } = await createStoreFixture();
    const original = await readFile(store.eventsPath());
    const unterminated = original.subarray(0, -1);
    await writeFile(store.eventsPath(), unterminated);

    const appended = await Promise.all([
      store.append("runtime", "run.paused", { reason: "first concurrent append" }),
      store.append("runtime", "run.paused", { reason: "second concurrent append" }),
    ]);

    expect(appended.map(({ sequence }) => sequence).sort()).toEqual([2, 3]);
    const recovered = await readFile(store.eventsPath());
    expect(recovered.subarray(unterminated.byteLength, unterminated.byteLength + 2)).not.toEqual(
      Buffer.from("\n\n"),
    );
    expect(recovered.toString("utf8").split("\n").filter(Boolean)).toHaveLength(3);
  });

  it.each([
    {
      name: "invalid UTF-8",
      expected: /invalid UTF-8/u,
      bytes: () => Buffer.concat([Buffer.from('{"marker":"'), Buffer.from([0xf0, 0x9f])]),
    },
    {
      name: "invalid JSON",
      expected: /invalid JSON/u,
      bytes: () => Buffer.from('{"marker":"tail-secret-must-not-leak"'),
    },
    {
      name: "unexpected UTF-8 BOM",
      expected: /invalid JSON/u,
      bytes: (event: RunEvent) =>
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), serializedEvent(event)]),
    },
    {
      name: "invalid schema",
      expected: /invalid event schema/u,
      bytes: () => Buffer.from('{"schemaVersion":1}\n'),
    },
    {
      name: "invalid hash",
      expected: /invalid event hash/u,
      bytes: (event: RunEvent) => serializedEvent({ ...event, hash: "0".repeat(64) }),
    },
    {
      name: "manifest/event format mismatch",
      expected: /event format that disagrees with its storage manifest/u,
      bytes: (event: RunEvent) =>
        serializedEvent(
          createRunEvent({
            sequence: event.sequence,
            timestamp: event.timestamp,
            actor: event.actor,
            causationId: event.causationId,
            type: event.type,
            data: event.data,
          }),
        ),
    },
    {
      name: "invalid sequence",
      expected: /invalid event sequence/u,
      bytes: (event: RunEvent) =>
        serializedEvent(
          createRunEvent(
            {
              sequence: 2,
              timestamp: event.timestamp,
              actor: event.actor,
              causationId: event.causationId,
              type: event.type,
              data: event.data,
            },
            eventHashAlgorithm(event),
          ),
        ),
    },
  ])("fails closed on $name without leaking or changing durable files", async (fixture) => {
    const { root, store, event } = await createStoreFixture();
    const eventsPath = store.eventsPath();
    const statePath = join(store.runRoot, "state.json");
    const corrupted = fixture.bytes(event);
    const stateBefore = await readFile(statePath);
    await writeFile(eventsPath, corrupted);

    const operations = [
      async (candidate: RunStore) => await candidate.loadEvents(),
      async (candidate: RunStore) => await candidate.loadState(),
      async (candidate: RunStore) =>
        await candidate.append("runtime", "run.paused", { reason: "must not append" }),
      async (candidate: RunStore) => await createViewerSnapshot(candidate),
    ];
    for (const operation of operations) {
      const error = await operation(new RunStore(root, store.runId)).catch((caught) => caught);
      expect(error).toBeInstanceOf(RunStoreEventLogCorruptionError);
      expect((error as Error).message).toMatch(fixture.expected);
      expect((error as Error).message).toContain("event log bytes were left unchanged");
      expect((error as Error).message).not.toContain("durable run files");
      expect((error as Error).message).not.toContain("tail-secret-must-not-leak");
      expect(await readFile(eventsPath)).toEqual(corrupted);
      expect(await readFile(statePath)).toEqual(stateBefore);
    }
  });

  it("preserves valid records before a secret-bearing corrupt trailing append", async () => {
    const { root, store } = await createStoreFixture();
    const eventsPath = store.eventsPath();
    const statePath = join(store.runRoot, "state.json");
    const validPrefix = await readFile(eventsPath);
    const corrupted = Buffer.concat([
      validPrefix,
      Buffer.from('{"marker":"trailing-secret-must-not-leak"'),
    ]);
    const stateBefore = await readFile(statePath);
    await writeFile(eventsPath, corrupted);

    for (const operation of [
      async (candidate: RunStore) => await candidate.loadEvents(),
      async (candidate: RunStore) =>
        await candidate.append("runtime", "run.paused", { reason: "must not append" }),
    ]) {
      const error = await operation(new RunStore(root, store.runId)).catch((caught) => caught);
      expect(error).toBeInstanceOf(RunStoreEventLogCorruptionError);
      if (!(error instanceof RunStoreEventLogCorruptionError))
        throw new Error("Expected event-log corruption");
      expect(error).toMatchObject({
        record: 2,
        offsetBytes: validPrefix.byteLength,
        trailing: true,
      });
      expect(error.message).not.toContain("trailing-secret-must-not-leak");
      expect(await readFile(eventsPath)).toEqual(corrupted);
      expect(await readFile(statePath)).toEqual(stateBefore);
    }
  });

  it("counts delimiter debt at the exact normal-log capacity boundary", async () => {
    const { root, store } = await createStoreFixture();
    const original = await readFile(store.eventsPath());
    const unterminated = original.subarray(0, -1);
    await writeFile(store.eventsPath(), unterminated);
    const data = { reason: "capacity boundary" };
    const candidate = createRunEvent(
      {
        sequence: 2,
        timestamp: "2026-07-22T00:00:00.000Z",
        actor: "runtime",
        causationId: store.runId,
        type: "run.paused",
        data,
      },
      store.canonicalHashAlgorithm,
    );
    const maxEventLogBytes =
      unterminated.byteLength +
      serializedEvent(candidate).byteLength +
      RUN_BLOCKED_EVENT_RESERVE_BYTES;
    const bounded = new RunStore(root, store.runId, { maxEventLogBytes });

    let error: unknown;
    try {
      await bounded.append("runtime", "run.paused", data);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RunStoreLimitError);
    if (!(error instanceof RunStoreLimitError)) throw new Error("Expected a run-store limit error");
    expect(error.kind).toBe("event_log");
    expect(error.blockerPersisted).toBe(true);
    const events = await new RunStore(root, store.runId).loadEvents();
    expect(events.map(({ type }) => type)).toEqual(["run.created", "run.blocked"]);
  });
});
