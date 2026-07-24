import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  MAX_ARTIFACT_INVENTORY_BYTES,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  createRunEvent,
  type ArtifactInventory,
} from "@graphcraft/core";
import { RunArtifactStore } from "./artifact-policy.ts";
import { RunLock } from "./lock.ts";
import {
  CURRENT_RUN_STORAGE_VERSION,
  LEGACY_MIGRATION_DESTINATION_LIMITS,
  LEGACY_MIGRATION_RESOURCE_LIMITS,
  assertLegacySnapshotRefreshIsCtimeOnly,
  ensureCurrentRunStorage,
  type LegacySnapshotRefreshEvidence,
  writeCurrentRunStorageManifest,
} from "./migration.ts";
import {
  RUN_BLOCKED_EVENT_RESERVE_BYTES,
  RUN_EVENT_LOG_MAX_BYTES,
  RUN_EVENT_MAX_BYTES,
  RUN_METADATA_MAX_BYTES,
  RUN_STATE_MAX_BYTES,
  RUN_WORKSPACE_MAX_BYTES,
  RunStore,
} from "./store.ts";

const roots: string[] = [];
const migrationFaultTestTimeout = process.platform === "win32" ? 300_000 : 15_000;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

interface LegacyFixture {
  graphcraftRoot: string;
  runRoot: string;
  runId: string;
  largeArtifact: Buffer;
}

const v1Formats = {
  contract: 1,
  graph: 1,
  probePlan: 1,
  heldOutProbes: 1,
  events: 1,
  state: 1,
  workspace: 1,
  capsules: 1,
  invocationEvents: 1,
  semanticReports: 1,
  rawArtifacts: 1,
  controlRequests: 1,
  locks: 1,
} as const;

const v2Formats = {
  ...v1Formats,
  artifactInventory: 1,
  artifactPolicy: 1,
} as const;

async function createLegacyFixture(runId: string, sourceVersion: 0 | 1): Promise<LegacyFixture> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-migration-v2-test-"));
  roots.push(root);
  const graphcraftRoot = join(root, ".graphcraft");
  const runRoot = join(graphcraftRoot, "runs", runId);
  await Promise.all([
    mkdir(join(runRoot, "artifacts", "logs"), { recursive: true, mode: 0o755 }),
    mkdir(join(runRoot, "capsules"), { recursive: true, mode: 0o755 }),
    mkdir(join(runRoot, "reports"), { recursive: true, mode: 0o755 }),
  ]);
  const largeArtifact = Buffer.alloc(2 * 1024 * 1024, "a");
  await Promise.all([
    writeFile(join(runRoot, "events.jsonl"), '{"legacy":true}\n', { mode: 0o644 }),
    writeFile(join(runRoot, "state.json"), '{"legacy":"state"}\n', { mode: 0o644 }),
    writeFile(join(runRoot, "artifacts", "logs", "large.log"), largeArtifact, {
      mode: 0o644,
    }),
    writeFile(join(runRoot, "capsules", "legacy.json"), '{"legacy":"capsule"}\n', {
      mode: 0o644,
    }),
  ]);
  if (sourceVersion === 1)
    await writeFile(
      join(runRoot, "storage.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        runId,
        migratedFrom: 1,
        formats: v1Formats,
      })}\n`,
      { mode: 0o644 },
    );
  if (process.platform !== "win32") {
    await chmod(graphcraftRoot, 0o755);
    await chmod(join(graphcraftRoot, "runs"), 0o755);
    await chmod(runRoot, 0o755);
  }
  return { graphcraftRoot, runRoot, runId, largeArtifact };
}

async function createV2Fixture(runId: string): Promise<LegacyFixture> {
  const fixture = await createLegacyFixture(runId, 1);
  await new RunArtifactStore(fixture.runRoot, fixture.runId).migrateLegacy();
  await writeFile(
    join(fixture.runRoot, "storage.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      runId: fixture.runId,
      migratedFrom: 1,
      formats: v2Formats,
    })}\n`,
    { mode: 0o600 },
  );
  return fixture;
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = relative(root, path).replaceAll("\\", "/");
      if (key === ".backup-complete.json") continue;
      if (entry.isDirectory()) {
        snapshot[key] = "directory";
        await visit(path);
      } else if (entry.isFile()) {
        const contents = await readFile(path);
        snapshot[key] = `file:${contents.length}:${digest(contents)}`;
      }
    }
  };
  await visit(root);
  return snapshot;
}

async function treeSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      const key = relative(root, path);
      if (entry.isDirectory()) {
        snapshot[key] = `directory:${metadata.mode}:${metadata.mtimeMs}`;
        await visit(path);
      } else if (entry.isFile()) {
        const contents = await readFile(path);
        snapshot[key] =
          `file:${metadata.mode}:${metadata.mtimeMs}:${contents.length}:${digest(contents)}`;
      } else {
        snapshot[key] = `other:${metadata.mode}:${metadata.mtimeMs}`;
      }
    }
  };
  await visit(root);
  return snapshot;
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = process.platform === "win32" ? 30_000 : 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for migration state");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function internalLockPath(lock: RunLock): string {
  return (lock as unknown as { path: string }).path;
}

function outerLockPaths(fixture: LegacyFixture): { migration: string; run: string } {
  return {
    migration: join(fixture.graphcraftRoot, "locks", `${fixture.runId}.migration.lock`),
    run: join(fixture.graphcraftRoot, "locks", `${fixture.runId}.lock`),
  };
}

function spyOnOuterLockSignals(input: {
  paths: { migration: string; run: string };
  migration: AbortSignal;
  run: AbortSignal;
}): { observed: string[]; spy: ReturnType<typeof vi.spyOn> } {
  const signalGetter = Object.getOwnPropertyDescriptor(RunLock.prototype, "signal")?.get as
    ((this: RunLock) => AbortSignal) | undefined;
  if (!signalGetter) throw new Error("Expected the RunLock signal getter");
  const observed: string[] = [];
  const spy = vi.spyOn(RunLock.prototype, "signal", "get").mockImplementation(function (
    this: RunLock,
  ): AbortSignal {
    const path = internalLockPath(this);
    observed.push(path);
    if (path === input.paths.migration) return input.migration;
    if (path === input.paths.run) return input.run;
    return signalGetter.call(this);
  });
  return { observed, spy };
}

function spyOnLockReleases(): {
  paths: string[];
  spy: ReturnType<typeof vi.spyOn>;
} {
  const release = RunLock.prototype.release;
  const paths: string[] = [];
  const spy = vi.spyOn(RunLock.prototype, "release").mockImplementation(async function (
    this: RunLock,
  ): Promise<void> {
    paths.push(internalLockPath(this));
    await release.call(this);
  });
  return { paths, spy };
}

async function optionalTreeSnapshot(root: string): Promise<Record<string, string> | undefined> {
  return (await exists(root)) ? await treeSnapshot(root) : undefined;
}

async function migrationDurableSnapshot(fixture: LegacyFixture): Promise<{
  backup: Record<string, string> | undefined;
  run: Record<string, string>;
  temporary: Record<string, string> | undefined;
}> {
  const backupParent = join(fixture.graphcraftRoot, "migration-backups", fixture.runId);
  return {
    backup: await optionalTreeSnapshot(join(backupParent, "1-to-3")),
    run: await treeSnapshot(fixture.runRoot),
    temporary: await optionalTreeSnapshot(join(backupParent, ".1-to-3.tmp")),
  };
}

function sampleLegacySnapshotRefreshEvidence(): LegacySnapshotRefreshEvidence {
  return {
    rootFingerprint: "10:20:16832:1:0:1000:2000",
    entries: [
      {
        kind: "directory",
        relativePath: "artifacts",
        fingerprint: "10:21:16832:1:0:1001:2001",
      },
      {
        kind: "file",
        relativePath: "events.jsonl",
        fingerprint: "10:22:33152:1:12:1002:2002",
        bytes: 12,
        hash: "a".repeat(64),
      },
    ],
    digest: "b".repeat(64),
  };
}

function replaceLegacyFingerprintField(fingerprint: string, field: number, value: string): string {
  const fields = fingerprint.split(":");
  fields[field] = value;
  return fields.join(":");
}

function sampleLegacyRefreshFile(evidence: LegacySnapshotRefreshEvidence) {
  const entry = evidence.entries[1];
  if (entry?.kind !== "file") throw new Error("Expected the sample legacy file evidence");
  return entry;
}

describe("run storage schema v3 migration", () => {
  it("keeps mirrored migration destination limits aligned with RunStore", () => {
    expect(LEGACY_MIGRATION_DESTINATION_LIMITS).toEqual({
      maximumEventBytes: RUN_EVENT_MAX_BYTES,
      maximumEventLogBytes: RUN_EVENT_LOG_MAX_BYTES,
      blockedEventReserveBytes: RUN_BLOCKED_EVENT_RESERVE_BYTES,
      maximumStateBytes: RUN_STATE_MAX_BYTES,
      maximumMetadataBytes: RUN_METADATA_MAX_BYTES,
      maximumWorkspaceBytes: RUN_WORKSPACE_MAX_BYTES,
    });
  });

  it("accepts a post-backup-parent source refresh with ctime-only metadata drift", () => {
    const preflight = sampleLegacySnapshotRefreshEvidence();
    const refreshed = structuredClone(preflight);
    refreshed.rootFingerprint = replaceLegacyFingerprintField(refreshed.rootFingerprint, 6, "3000");
    refreshed.entries.forEach((entry, index) => {
      entry.fingerprint = replaceLegacyFingerprintField(entry.fingerprint, 6, String(3001 + index));
    });

    expect(() => assertLegacySnapshotRefreshIsCtimeOnly(preflight, refreshed)).not.toThrow();
  });

  it.each([
    [
      "path",
      (evidence: LegacySnapshotRefreshEvidence) => {
        sampleLegacyRefreshFile(evidence).relativePath = "renamed-events.jsonl";
      },
    ],
    [
      "filesystem identity",
      (evidence: LegacySnapshotRefreshEvidence) => {
        const file = sampleLegacyRefreshFile(evidence);
        file.fingerprint = replaceLegacyFingerprintField(file.fingerprint, 1, "99");
      },
    ],
    [
      "mode",
      (evidence: LegacySnapshotRefreshEvidence) => {
        const file = sampleLegacyRefreshFile(evidence);
        file.fingerprint = replaceLegacyFingerprintField(file.fingerprint, 2, "33216");
      },
    ],
    [
      "link count",
      (evidence: LegacySnapshotRefreshEvidence) => {
        const file = sampleLegacyRefreshFile(evidence);
        file.fingerprint = replaceLegacyFingerprintField(file.fingerprint, 3, "2");
      },
    ],
    [
      "size",
      (evidence: LegacySnapshotRefreshEvidence) => {
        const file = sampleLegacyRefreshFile(evidence);
        file.fingerprint = replaceLegacyFingerprintField(file.fingerprint, 4, "13");
        file.bytes = 13;
      },
    ],
    [
      "mtime",
      (evidence: LegacySnapshotRefreshEvidence) => {
        const file = sampleLegacyRefreshFile(evidence);
        file.fingerprint = replaceLegacyFingerprintField(file.fingerprint, 5, "1003");
      },
    ],
    [
      "content hash",
      (evidence: LegacySnapshotRefreshEvidence) => {
        sampleLegacyRefreshFile(evidence).hash = "c".repeat(64);
      },
    ],
  ])("rejects a post-backup-parent source refresh with changed %s", (_label, mutate) => {
    const preflight = sampleLegacySnapshotRefreshEvidence();
    const refreshed = structuredClone(preflight);
    mutate(refreshed);

    expect(() => assertLegacySnapshotRefreshIsCtimeOnly(preflight, refreshed)).toThrow(
      /changed while preparing secure backup storage/,
    );
  });

  it("concurrently migrates manifestless v0 after a complete backup without truncating artifacts", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000001", 0);
    const formattedJson = Buffer.from('{\n  "message": "harmless legacy metadata"\n}\n');
    const formattedPath = join(fixture.runRoot, "artifacts", "logs", "metadata.json");
    await writeFile(formattedPath, formattedJson);
    const before = await fileSnapshot(fixture.runRoot);
    const input = {
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    };

    const [first, second] = await Promise.all([
      ensureCurrentRunStorage(input),
      ensureCurrentRunStorage(input),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: CURRENT_RUN_STORAGE_VERSION,
      runId: fixture.runId,
      migratedFrom: 0,
      formats: { artifactInventory: 1, artifactPolicy: 1 },
    });
    const backupRoot = join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "0-to-3");
    expect(await fileSnapshot(backupRoot)).toEqual(before);
    expect(await readdir(join(fixture.graphcraftRoot, "migration-backups", fixture.runId))).toEqual(
      ["0-to-3"],
    );

    const artifactPath = join(fixture.runRoot, "artifacts", "logs", "large.log");
    const storedArtifact = await readFile(artifactPath);
    expect(storedArtifact).toEqual(fixture.largeArtifact);
    expect(await readFile(formattedPath)).toEqual(formattedJson);
    expect(await readFile(join(backupRoot, "artifacts", "logs", "metadata.json"))).toEqual(
      formattedJson,
    );
    const inventory = JSON.parse(
      await readFile(join(fixture.runRoot, "artifact-inventory.json"), "utf8"),
    ) as ArtifactInventory;
    expect(inventory.entries).toContainEqual(
      expect.objectContaining({
        path: "artifacts/logs/large.log",
        disposition: "legacy",
        sourceBytes: fixture.largeArtifact.length,
        storedBytes: fixture.largeArtifact.length,
        omittedBytes: 0,
        truncated: false,
        legacy: true,
        reason: "legacy_migration",
      }),
    );
    if (process.platform !== "win32") {
      expect((await lstat(fixture.runRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(artifactPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(backupRoot)).mode & 0o777).toBe(0o700);
    }

    const migrated = await treeSnapshot(fixture.graphcraftRoot);
    expect(await ensureCurrentRunStorage(input)).toEqual(first);
    expect(await treeSnapshot(fixture.graphcraftRoot)).toEqual(migrated);
  });

  it("migrates validated v1 through a complete 1-to-3 backup and publishes v3 last", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000002", 1);
    const before = await fileSnapshot(fixture.runRoot);
    const input = {
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    };

    const [migrated, concurrent] = await Promise.all([
      ensureCurrentRunStorage(input),
      ensureCurrentRunStorage(input),
    ]);

    expect(concurrent).toEqual(migrated);
    expect(migrated).toMatchObject({ schemaVersion: 3, migratedFrom: 1 });
    const backupRoot = join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "1-to-3");
    expect(await fileSnapshot(backupRoot)).toEqual(before);
    expect(JSON.parse(await readFile(join(backupRoot, "storage.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      runId: fixture.runId,
    });
    expect(await exists(join(backupRoot, "artifact-inventory.json"))).toBe(false);
    expect(JSON.parse(await readFile(join(fixture.runRoot, "storage.json"), "utf8"))).toMatchObject(
      {
        schemaVersion: 3,
        migratedFrom: 1,
        canonicalHashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
        formats: {
          heldOutProbes: 1,
          events: 1,
          artifactInventory: 1,
          artifactPolicy: 1,
        },
      },
    );
  });

  it("concurrently migrates v2 through an exact 2-to-3 backup without rewriting durable payloads", async () => {
    const fixture = await createV2Fixture("20000000-0000-4000-8000-000000000045");
    const input = {
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    };
    const before = await fileSnapshot(fixture.runRoot);
    const inventoryBefore = await readFile(join(fixture.runRoot, "artifact-inventory.json"));
    const payloadsBefore = { ...before };
    delete payloadsBefore["storage.json"];

    const [migrated, concurrent] = await Promise.all([
      ensureCurrentRunStorage(input),
      ensureCurrentRunStorage(input),
    ]);

    expect(concurrent).toEqual(migrated);
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      runId: fixture.runId,
      migratedFrom: 2,
      canonicalHashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
      formats: {
        heldOutProbes: 1,
        events: 1,
        artifactInventory: 1,
        artifactPolicy: 1,
      },
    });
    const backupRoot = join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "2-to-3");
    expect(await fileSnapshot(backupRoot)).toEqual(before);
    expect(await readdir(join(fixture.graphcraftRoot, "migration-backups", fixture.runId))).toEqual(
      ["2-to-3"],
    );

    const payloadsAfter = await fileSnapshot(fixture.runRoot);
    delete payloadsAfter["storage.json"];
    expect(payloadsAfter).toEqual(payloadsBefore);
    expect(await readFile(join(fixture.runRoot, "artifact-inventory.json"))).toEqual(
      inventoryBefore,
    );
    expect(await readFile(join(fixture.runRoot, "artifacts", "logs", "large.log"))).toEqual(
      fixture.largeArtifact,
    );

    const stable = await treeSnapshot(fixture.graphcraftRoot);
    expect(await ensureCurrentRunStorage(input)).toEqual(migrated);
    expect(await treeSnapshot(fixture.graphcraftRoot)).toEqual(stable);
  });

  it("refuses to downgrade portable events when the v3 manifest is missing", async () => {
    const fixture = await createV2Fixture("20000000-0000-4000-8000-000000000046");
    const portableEvent = createRunEvent(
      {
        sequence: 1,
        timestamp: "2026-07-24T00:00:00.000Z",
        actor: "runtime",
        causationId: fixture.runId,
        type: "run.blocked",
        data: { reason: "portable event must retain its manifest" },
      },
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );
    await writeFile(join(fixture.runRoot, "events.jsonl"), `${JSON.stringify(portableEvent)}\n`, {
      mode: 0o600,
    });
    await rm(join(fixture.runRoot, "storage.json"));
    const before = await treeSnapshot(fixture.graphcraftRoot);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(/schema-v2 events without an intact schema-v3 storage manifest/);

    expect(await treeSnapshot(fixture.graphcraftRoot)).toEqual(before);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups", fixture.runId))).toBe(
      false,
    );
  });

  it("refuses to duplicate or publish a credential-bearing legacy run", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000011", 0);
    const credential = `ghp_${"migrationsecret".repeat(2)}`;
    const secretContents = Buffer.from(`legacy credential: ${credential}\n`);
    const secretPath = join(fixture.runRoot, "artifacts", "logs", "credential.log");
    await writeFile(secretPath, secretContents);
    const before = await treeSnapshot(fixture.runRoot);

    let failure: unknown;
    try {
      await ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Legacy run contains secret-like material and cannot migrate safely; scrub or delete the affected legacy content before retrying",
    );
    expect((failure as Error).message).not.toContain(credential);
    expect(await treeSnapshot(fixture.runRoot)).toEqual(before);
    expect(await readFile(secretPath)).toEqual(secretContents);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "storage.json"))).toBe(false);

    const secretSignature = `file:${secretContents.length}:${digest(secretContents)}`;
    expect(
      Object.values(await fileSnapshot(fixture.graphcraftRoot)).filter(
        (signature) => signature === secretSignature,
      ),
    ).toHaveLength(1);
  });

  it("refuses short credential values nested under sensitive JSON keys", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000013", 0);
    const secretContents = Buffer.from(
      '{\n  "account": { "password": "hunter2" },\n  "api_key": "shortsecret"\n}\n',
    );
    const secretPath = join(fixture.runRoot, "artifacts", "logs", "credentials.json");
    await writeFile(secretPath, secretContents);
    const before = await treeSnapshot(fixture.runRoot);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(
      "Legacy run contains secret-like material and cannot migrate safely; scrub or delete the affected legacy content before retrying",
    );

    expect(await treeSnapshot(fixture.runRoot)).toEqual(before);
    expect(await readFile(secretPath)).toEqual(secretContents);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "storage.json"))).toBe(false);
  });

  it("refuses short credential values in embedded legacy JSON fragments", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000014", 0);
    const secretContents = Buffer.from('prefix {"api_key":"shortsecret"} suffix\n');
    const secretPath = join(fixture.runRoot, "artifacts", "logs", "embedded.log");
    await writeFile(secretPath, secretContents);
    const before = await treeSnapshot(fixture.runRoot);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(/Legacy run contains secret-like material and cannot migrate safely/);

    expect(await treeSnapshot(fixture.runRoot)).toEqual(before);
    expect(await readFile(secretPath)).toEqual(secretContents);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
  });

  it("refuses short credential values in a legacy JSONL stream", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000017", 0);
    const secretContents = Buffer.from('{"message":"safe"}\n{"nested":{"password":"hunter2"}}\n');
    const secretPath = join(fixture.runRoot, "artifacts", "logs", "credentials.jsonl");
    await writeFile(secretPath, secretContents);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(/Legacy run contains secret-like material and cannot migrate safely/);

    expect(await readFile(secretPath)).toEqual(secretContents);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "storage.json"))).toBe(false);
  });

  it("refuses an oversized legacy file before reading or backing it up", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000012", 0);
    const oversizedPath = join(fixture.runRoot, "artifacts", "logs", "oversized.bin");
    await writeFile(oversizedPath, "x");
    await truncate(oversizedPath, 64 * 1024 * 1024 + 1);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(/larger than the 67108864-byte safe migration scan limit/);

    expect((await lstat(oversizedPath)).size).toBe(64 * 1024 * 1024 + 1);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "storage.json"))).toBe(false);
  });

  it("refuses aggregate legacy artifacts that would consume the recovery reserve", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000015", 0);
    const first = join(fixture.runRoot, "artifacts", "logs", "aggregate-a.bin");
    const second = join(fixture.runRoot, "capsules", "aggregate-b.bin");
    await Promise.all([writeFile(first, "x"), writeFile(second, "x")]);
    await Promise.all([truncate(first, 30 * 1024 * 1024), truncate(second, 30 * 1024 * 1024)]);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(/safe artifact migration limit/);

    expect((await lstat(first)).size).toBe(30 * 1024 * 1024);
    expect((await lstat(second)).size).toBe(30 * 1024 * 1024);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "storage.json"))).toBe(false);
  });

  it("refuses excessive non-artifact run bytes before content reads or backup publication", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000020", 1);
    const storagePath = join(fixture.runRoot, "storage.json");
    const storageBefore = await readFile(storagePath);
    const first = join(fixture.runRoot, "legacy-state-a.bin");
    const second = join(fixture.runRoot, "legacy-state-b.bin");
    await Promise.all([
      writeFile(first, '{"password":"hunter2"}\n'),
      writeFile(second, "non-artifact state\n"),
    ]);
    await Promise.all([
      truncate(first, LEGACY_MIGRATION_RESOURCE_LIMITS.maximumFileBytes),
      truncate(second, LEGACY_MIGRATION_RESOURCE_LIMITS.maximumFileBytes),
    ]);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(
      new RegExp(
        `${LEGACY_MIGRATION_RESOURCE_LIMITS.maximumRunBytes}-byte whole-run safe migration limit`,
      ),
    );

    expect((await lstat(first)).size).toBe(LEGACY_MIGRATION_RESOURCE_LIMITS.maximumFileBytes);
    expect((await lstat(second)).size).toBe(LEGACY_MIGRATION_RESOURCE_LIMITS.maximumFileBytes);
    expect(await readFile(storagePath)).toEqual(storageBefore);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
  });

  it("refuses excessive legacy file count before content reads or backup publication", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000021", 1);
    const storagePath = join(fixture.runRoot, "storage.json");
    const storageBefore = await readFile(storagePath);
    const stateRoot = join(fixture.runRoot, "legacy-state-files");
    await mkdir(stateRoot);
    for (
      let offset = 0;
      offset <= LEGACY_MIGRATION_RESOURCE_LIMITS.maximumFileCount;
      offset += 128
    ) {
      await Promise.all(
        Array.from(
          {
            length: Math.min(128, LEGACY_MIGRATION_RESOURCE_LIMITS.maximumFileCount + 1 - offset),
          },
          async (_, index) => {
            const position = offset + index;
            await writeFile(
              join(stateRoot, `${String(position).padStart(5, "0")}.json`),
              position === 0 ? '{"password":"hunter2"}\n' : "",
            );
          },
        ),
      );
    }

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(
      new RegExp(`${LEGACY_MIGRATION_RESOURCE_LIMITS.maximumFileCount}-file safe migration limit`),
    );

    expect(await readFile(join(stateRoot, "00000.json"), "utf8")).toContain("hunter2");
    expect(await readFile(storagePath)).toEqual(storageBefore);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
  }, 30_000);

  it("finishes whole-tree metadata preflight before scanning earlier secret-bearing content", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000018", 0);
    const secretPath = join(fixture.runRoot, "artifacts", "logs", "a-secret.json");
    await writeFile(secretPath, '{"password":"hunter2"}\n');
    const statePath = join(fixture.runRoot, "state.json");
    const outsideState = join(dirname(fixture.graphcraftRoot), "outside-legacy-state.json");
    await rename(statePath, outsideState);
    await link(outsideState, statePath);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(/multiply linked file/i);

    expect(await readFile(secretPath, "utf8")).toContain("hunter2");
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
  });

  it("refuses a secret-bearing legacy path without copying or disclosing it", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000019", 0);
    const credential = `ghp_${"a".repeat(30)}`;
    const secretPath = join(fixture.runRoot, "artifacts", "logs", `${credential}.txt`);
    await writeFile(secretPath, "safe contents\n");

    const failure = await ensureCurrentRunStorage({
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    }).catch((error: unknown) => error);

    expect(String(failure)).toMatch(/secret-like path/);
    expect(String(failure)).not.toContain(credential);
    expect(await readFile(secretPath, "utf8")).toBe("safe contents\n");
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
  });

  it("refuses a multiply linked legacy event log before reading or backing up shared bytes", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000016", 0);
    const eventsPath = join(fixture.runRoot, "events.jsonl");
    const outsideEvents = join(dirname(fixture.graphcraftRoot), "outside-legacy-events.jsonl");
    await rename(eventsPath, outsideEvents);
    await link(outsideEvents, eventsPath);
    const before = await readFile(outsideEvents);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(/multiply linked file/i);

    expect(await readFile(outsideEvents)).toEqual(before);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "storage.json"))).toBe(false);
  });

  it("rejects a reserved backup marker in the legacy root before creating a backup", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000027", 0);
    const markerPath = join(fixture.runRoot, ".backup-complete.json");
    await writeFile(markerPath, '{"untrusted":true}\n');

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(/reserved root file \.backup-complete\.json/);

    expect(await readFile(markerPath, "utf8")).toBe('{"untrusted":true}\n');
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "storage.json"))).toBe(false);
  });

  it("binds backup copying to the exact preflight tree snapshot", async () => {
    const mutations: Array<{
      name: string;
      apply(fixture: LegacyFixture): Promise<void>;
    }> = [
      {
        name: "added entry",
        apply: async (fixture) => {
          await writeFile(join(fixture.runRoot, "added-after-preflight.txt"), "new bytes\n");
        },
      },
      {
        name: "changed entry",
        apply: async (fixture) => {
          await appendFile(join(fixture.runRoot, "state.json"), '{"changed":true}\n');
        },
      },
      {
        name: "removed entry",
        apply: async (fixture) => {
          await rm(join(fixture.runRoot, "state.json"));
        },
      },
    ];

    for (const [index, mutation] of mutations.entries()) {
      const fixture = await createLegacyFixture(
        `20000000-0000-4000-8000-${String(28 + index).padStart(12, "0")}`,
        0,
      );
      let applied = false;
      await expect(
        ensureCurrentRunStorage({
          graphcraftRoot: fixture.graphcraftRoot,
          runRoot: fixture.runRoot,
          runId: fixture.runId,
          onBoundary: async (boundary) => {
            if (boundary !== "after_preflight") return;
            applied = true;
            await mutation.apply(fixture);
          },
        }),
        mutation.name,
      ).rejects.toThrow(/changed after migration preflight|changed during backup copy/);
      expect(applied, mutation.name).toBe(true);
      expect(
        await exists(join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "0-to-3")),
        mutation.name,
      ).toBe(false);
      expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
      expect(await exists(join(fixture.runRoot, "storage.json"))).toBe(false);
    }
  });

  it.each([
    [
      "event line",
      "events.jsonl",
      LEGACY_MIGRATION_DESTINATION_LIMITS.maximumEventBytes + 1,
      /event log contains a line exceeding/,
    ],
    [
      "normal event-log budget",
      "events.jsonl",
      LEGACY_MIGRATION_DESTINATION_LIMITS.maximumEventLogBytes -
        LEGACY_MIGRATION_DESTINATION_LIMITS.blockedEventReserveBytes +
        1,
      /event log exceeds/,
    ],
    [
      "materialized state",
      "state.json",
      LEGACY_MIGRATION_DESTINATION_LIMITS.maximumStateBytes + 1,
      /materialized state exceeds/,
    ],
    [
      "contract metadata",
      "contract.json",
      LEGACY_MIGRATION_DESTINATION_LIMITS.maximumMetadataBytes + 1,
      /contract\.json exceeds/,
    ],
    [
      "graph metadata",
      "graph.json",
      LEGACY_MIGRATION_DESTINATION_LIMITS.maximumMetadataBytes + 1,
      /graph\.json exceeds/,
    ],
    [
      "probe-plan metadata",
      "probe-plan.json",
      LEGACY_MIGRATION_DESTINATION_LIMITS.maximumMetadataBytes + 1,
      /probe-plan\.json exceeds/,
    ],
    [
      "held-out metadata",
      "held-out-probes.json",
      LEGACY_MIGRATION_DESTINATION_LIMITS.maximumMetadataBytes + 1,
      /held-out-probes\.json exceeds/,
    ],
    [
      "workspace projection",
      "workspace.json",
      LEGACY_MIGRATION_DESTINATION_LIMITS.maximumWorkspaceBytes + 1,
      /workspace projection exceeds/,
    ],
  ])("refuses legacy %s beyond the current destination cap", async (_label, path, bytes, error) => {
    const suffix = String(31 + roots.length).padStart(12, "0");
    const fixture = await createLegacyFixture(`20000000-0000-4000-8000-${suffix}`, 0);
    const target = join(fixture.runRoot, path);
    await writeFile(target, "x");
    await truncate(target, bytes);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(error);

    expect((await lstat(target)).size).toBe(bytes);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "storage.json"))).toBe(false);
  });

  it("waits for a legacy writer and includes its final locked event in the backup", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000007", 1);
    const runLockPath = join(fixture.graphcraftRoot, "locks", `${fixture.runId}.lock`);
    const migrationLockPath = join(
      fixture.graphcraftRoot,
      "locks",
      `${fixture.runId}.migration.lock`,
    );
    const backupRoot = join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "1-to-3");
    const writerLock = new RunLock(runLockPath);
    await writerLock.acquire();
    const migrating = ensureCurrentRunStorage({
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    });

    await waitFor(async () => await exists(migrationLockPath));
    try {
      expect(await exists(backupRoot)).toBe(false);
      expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
      await appendFile(join(fixture.runRoot, "events.jsonl"), '{"writer":"final"}\n');
    } finally {
      await writerLock.release();
    }

    await expect(migrating).resolves.toMatchObject({ schemaVersion: 3, migratedFrom: 1 });
    expect(await readFile(join(backupRoot, "events.jsonl"), "utf8")).toContain(
      '{"writer":"final"}',
    );
    expect(await exists(runLockPath)).toBe(false);
    expect(await exists(migrationLockPath)).toBe(false);
  });

  const outerLeaseFaultCases = [
    ["migration", "after_preflight"],
    ["migration", "after_backup"],
    ["migration", "after_inventory"],
    ["migration", "before_manifest"],
    ["run", "after_preflight"],
    ["run", "after_backup"],
    ["run", "after_inventory"],
    ["run", "before_manifest"],
  ] as const;

  it.each(outerLeaseFaultCases)(
    "stops after observed %s lease loss at %s and recovers under fresh locks",
    async (lostLock, faultBoundary) => {
      const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000040", 1);
      await writeFile(
        join(fixture.runRoot, "artifacts", "logs", "large.log"),
        "small matrix artifact\n",
      );
      const legacySnapshot = await fileSnapshot(fixture.runRoot);
      const backupRoot = join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "1-to-3");
      const temporaryRoot = join(dirname(backupRoot), ".1-to-3.tmp");
      const inventoryPath = join(fixture.runRoot, "artifact-inventory.json");
      const paths = outerLockPaths(fixture);
      const controllers = {
        migration: new AbortController(),
        run: new AbortController(),
      };
      const leaseFailure = new Error(`${lostLock} lease lost at ${faultBoundary}`);
      const signal = spyOnOuterLockSignals({
        paths,
        migration: controllers.migration.signal,
        run: controllers.run.signal,
      });
      const release = spyOnLockReleases();
      let snapshotAtLoss: Awaited<ReturnType<typeof migrationDurableSnapshot>> | undefined;

      await expect(
        ensureCurrentRunStorage({
          graphcraftRoot: fixture.graphcraftRoot,
          runRoot: fixture.runRoot,
          runId: fixture.runId,
          onBoundary: async (boundary) => {
            if (boundary !== faultBoundary) return;
            controllers[lostLock].abort(leaseFailure);
            snapshotAtLoss = await migrationDurableSnapshot(fixture);
          },
        }),
      ).rejects.toBe(leaseFailure);

      if (!snapshotAtLoss) throw new Error("Expected a durable migration snapshot at lease loss");
      expect(await migrationDurableSnapshot(fixture)).toEqual(snapshotAtLoss);
      expect(await exists(paths.run)).toBe(false);
      expect(await exists(paths.migration)).toBe(false);
      expect(await exists(temporaryRoot)).toBe(false);
      expect(
        JSON.parse(await readFile(join(fixture.runRoot, "storage.json"), "utf8")),
      ).toMatchObject({ schemaVersion: 1 });

      const backupExpected = faultBoundary !== "after_preflight";
      const inventoryExpected =
        faultBoundary === "after_inventory" || faultBoundary === "before_manifest";
      expect(await exists(backupRoot)).toBe(backupExpected);
      expect(await exists(inventoryPath)).toBe(inventoryExpected);
      if (backupExpected) {
        expect(await exists(join(backupRoot, ".backup-complete.json"))).toBe(true);
        expect(await fileSnapshot(backupRoot)).toEqual(legacySnapshot);
      }

      const expectedReleaseCount = {
        after_preflight: 2,
        after_backup: 2,
        after_inventory: 4,
        before_manifest: 5,
      }[faultBoundary];
      const artifactLockPath = join(
        fixture.graphcraftRoot,
        "locks",
        `${fixture.runId}.artifacts.lock`,
      );
      expect(release.paths).toHaveLength(expectedReleaseCount);
      expect(release.paths.slice(0, -2)).toEqual(
        Array.from({ length: expectedReleaseCount - 2 }, () => artifactLockPath),
      );
      expect(release.paths.slice(-2)).toEqual([paths.run, paths.migration]);

      signal.spy.mockRestore();
      release.spy.mockRestore();
      await expect(
        ensureCurrentRunStorage({
          graphcraftRoot: fixture.graphcraftRoot,
          runRoot: fixture.runRoot,
          runId: fixture.runId,
        }),
      ).resolves.toMatchObject({ schemaVersion: 3, migratedFrom: 1 });
      expect(await exists(temporaryRoot)).toBe(false);
      expect(await fileSnapshot(backupRoot)).toEqual(legacySnapshot);
      expect(await exists(join(backupRoot, "artifact-inventory.json"))).toBe(false);
    },
    migrationFaultTestTimeout,
  );

  it(
    "stops waiting for the run lock when the migration lease is lost",
    async () => {
      const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000041", 1);
      await writeFile(
        join(fixture.runRoot, "artifacts", "logs", "large.log"),
        "small waiting artifact\n",
      );
      const before = await treeSnapshot(fixture.runRoot);
      const paths = outerLockPaths(fixture);
      const writerLock = new RunLock(paths.run);
      await writerLock.acquire();
      const migrationLoss = new AbortController();
      const runLease = new AbortController();
      const leaseFailure = new Error("Migration lease lost while waiting for the run lock");
      const signal = spyOnOuterLockSignals({
        paths,
        migration: migrationLoss.signal,
        run: runLease.signal,
      });
      const release = spyOnLockReleases();
      let settled = false;
      const migrating = ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      });
      const outcome = migrating.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );

      try {
        await waitFor(async () => signal.observed.includes(paths.migration));
        migrationLoss.abort(leaseFailure);
        await waitFor(async () => settled);
        expect(await outcome).toBe(leaseFailure);
        expect(release.paths).toEqual([paths.migration]);
        expect(await exists(paths.migration)).toBe(false);
        expect(await exists(paths.run)).toBe(true);
        expect(await treeSnapshot(fixture.runRoot)).toEqual(before);
        expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
        expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
      } finally {
        signal.spy.mockRestore();
        release.spy.mockRestore();
        await writerLock.release();
        await outcome;
      }

      await expect(
        ensureCurrentRunStorage({
          graphcraftRoot: fixture.graphcraftRoot,
          runRoot: fixture.runRoot,
          runId: fixture.runId,
        }),
      ).resolves.toMatchObject({ schemaVersion: 3, migratedFrom: 1 });
    },
    migrationFaultTestTimeout,
  );

  it(
    "preserves a first-chunk temporary backup after lease loss and rebuilds it fresh",
    async () => {
      const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000042", 1);
      const sourcePath = join(fixture.runRoot, "artifacts", "logs", "large.log");
      const firstChunk = fixture.largeArtifact.subarray(0, 64 * 1024);
      const legacySnapshot = await fileSnapshot(fixture.runRoot);
      const backupParent = join(fixture.graphcraftRoot, "migration-backups", fixture.runId);
      const backupRoot = join(backupParent, "1-to-3");
      const temporaryRoot = join(backupParent, ".1-to-3.tmp");
      const temporaryArtifact = join(temporaryRoot, "artifacts", "logs", "large.log");
      const paths = outerLockPaths(fixture);
      const migrationLoss = new AbortController();
      const runLease = new AbortController();
      const leaseFailure = new Error("Migration lease lost after the first backup chunk");
      const signal = spyOnOuterLockSignals({
        paths,
        migration: migrationLoss.signal,
        run: runLease.signal,
      });
      const release = spyOnLockReleases();
      let temporaryAtLoss: Record<string, string> | undefined;
      let checkpointCount = 0;

      await expect(
        ensureCurrentRunStorage({
          graphcraftRoot: fixture.graphcraftRoot,
          runRoot: fixture.runRoot,
          runId: fixture.runId,
          onBackupCheckpoint: async (checkpoint) => {
            if (
              checkpoint.boundary !== "after_chunk" ||
              checkpoint.relativePath !== "artifacts/logs/large.log" ||
              checkpoint.copiedBytes !== 64 * 1024
            )
              return;
            checkpointCount += 1;
            migrationLoss.abort(leaseFailure);
            expect(await readFile(temporaryArtifact)).toEqual(firstChunk);
            temporaryAtLoss = await treeSnapshot(temporaryRoot);
          },
        }),
      ).rejects.toBe(leaseFailure);

      expect(checkpointCount).toBe(1);
      if (!temporaryAtLoss) throw new Error("Expected the partial migration backup snapshot");
      expect(await treeSnapshot(temporaryRoot)).toEqual(temporaryAtLoss);
      expect(await fileSnapshot(temporaryRoot)).toEqual({
        artifacts: "directory",
        "artifacts/logs": "directory",
        "artifacts/logs/large.log": `file:${firstChunk.length}:${digest(firstChunk)}`,
        capsules: "directory",
        reports: "directory",
      });
      expect(await readFile(temporaryArtifact)).toEqual(firstChunk);
      expect(await exists(join(temporaryRoot, ".backup-complete.json"))).toBe(false);
      expect(await exists(backupRoot)).toBe(false);
      expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
      expect(
        JSON.parse(await readFile(join(fixture.runRoot, "storage.json"), "utf8")),
      ).toMatchObject({ schemaVersion: 1 });
      expect(release.paths).toEqual([paths.run, paths.migration]);
      expect(await exists(paths.run)).toBe(false);
      expect(await exists(paths.migration)).toBe(false);

      signal.spy.mockRestore();
      release.spy.mockRestore();
      await expect(
        ensureCurrentRunStorage({
          graphcraftRoot: fixture.graphcraftRoot,
          runRoot: fixture.runRoot,
          runId: fixture.runId,
        }),
      ).resolves.toMatchObject({ schemaVersion: 3, migratedFrom: 1 });
      expect(await exists(temporaryRoot)).toBe(false);
      expect(await fileSnapshot(backupRoot)).toEqual(legacySnapshot);
      expect(await readFile(join(backupRoot, relative(fixture.runRoot, sourcePath)))).toEqual(
        fixture.largeArtifact,
      );
      expect(await exists(join(backupRoot, "artifact-inventory.json"))).toBe(false);
    },
    migrationFaultTestTimeout,
  );

  it.each(["body", "lease"] as const)(
    "preserves the first migration %s failure when both outer releases fail",
    async (failureKind) => {
      const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000043", 1);
      await writeFile(
        join(fixture.runRoot, "artifacts", "logs", "large.log"),
        "small causal artifact\n",
      );
      const before = await treeSnapshot(fixture.runRoot);
      const paths = outerLockPaths(fixture);
      const migrationLease = new AbortController();
      const runLease = new AbortController();
      const bodyFailure = new Error("Migration body failed first");
      const leaseFailure = new Error("Migration run lease failed first");
      const expectedFailure = failureKind === "body" ? bodyFailure : leaseFailure;
      const runReleaseFailure = new Error("Run lock release failed second");
      const migrationReleaseFailure = new Error("Migration lock release failed third");
      const signal = spyOnOuterLockSignals({
        paths,
        migration: migrationLease.signal,
        run: runLease.signal,
      });
      const realRelease = RunLock.prototype.release;
      const releasePaths: string[] = [];
      const release = vi.spyOn(RunLock.prototype, "release").mockImplementation(async function (
        this: RunLock,
      ): Promise<void> {
        const path = internalLockPath(this);
        releasePaths.push(path);
        await realRelease.call(this);
        if (path === paths.run) throw runReleaseFailure;
        if (path === paths.migration) throw migrationReleaseFailure;
      });

      await expect(
        ensureCurrentRunStorage({
          graphcraftRoot: fixture.graphcraftRoot,
          runRoot: fixture.runRoot,
          runId: fixture.runId,
          onBoundary: (boundary) => {
            if (boundary !== "after_preflight") return;
            if (failureKind === "body") throw bodyFailure;
            runLease.abort(leaseFailure);
          },
        }),
      ).rejects.toBe(expectedFailure);

      expect(releasePaths).toEqual([paths.run, paths.migration]);
      expect(await exists(paths.run)).toBe(false);
      expect(await exists(paths.migration)).toBe(false);
      expect(await treeSnapshot(fixture.runRoot)).toEqual(before);
      expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
      expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);

      signal.spy.mockRestore();
      release.mockRestore();
      await expect(
        ensureCurrentRunStorage({
          graphcraftRoot: fixture.graphcraftRoot,
          runRoot: fixture.runRoot,
          runId: fixture.runId,
        }),
      ).resolves.toMatchObject({ schemaVersion: 3, migratedFrom: 1 });
    },
    migrationFaultTestTimeout,
  );

  it(
    "preserves an earlier release error over later outer lease loss",
    async () => {
      const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000044", 1);
      const paths = outerLockPaths(fixture);
      const migrationLease = new AbortController();
      const runLease = new AbortController();
      const runReleaseFailure = new Error("Run lock release failed first");
      const laterLeaseFailure = new Error("Migration lease failed later");
      const signal = spyOnOuterLockSignals({
        paths,
        migration: migrationLease.signal,
        run: runLease.signal,
      });
      const realRelease = RunLock.prototype.release;
      const outerReleasePaths: string[] = [];
      const release = vi.spyOn(RunLock.prototype, "release").mockImplementation(async function (
        this: RunLock,
      ): Promise<void> {
        const path = internalLockPath(this);
        if (path === paths.run || path === paths.migration) outerReleasePaths.push(path);
        await realRelease.call(this);
        if (path === paths.run) throw runReleaseFailure;
        if (path === paths.migration) migrationLease.abort(laterLeaseFailure);
      });

      try {
        await expect(
          ensureCurrentRunStorage({
            graphcraftRoot: fixture.graphcraftRoot,
            runRoot: fixture.runRoot,
            runId: fixture.runId,
          }),
        ).rejects.toBe(runReleaseFailure);
      } finally {
        signal.spy.mockRestore();
        release.mockRestore();
      }

      expect(outerReleasePaths).toEqual([paths.run, paths.migration]);
      expect(await exists(paths.run)).toBe(false);
      expect(await exists(paths.migration)).toBe(false);
      expect(
        JSON.parse(await readFile(join(fixture.runRoot, "storage.json"), "utf8")),
      ).toMatchObject({
        schemaVersion: 3,
        migratedFrom: 1,
      });
      await expect(
        ensureCurrentRunStorage({
          graphcraftRoot: fixture.graphcraftRoot,
          runRoot: fixture.runRoot,
          runId: fixture.runId,
        }),
      ).resolves.toMatchObject({ schemaVersion: 3, migratedFrom: 1 });
    },
    migrationFaultTestTimeout,
  );

  it("publishes the v3 manifest last and safely retries an interrupted migration", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000008", 1);
    const input = {
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    };
    let observedBoundary = false;

    await expect(
      ensureCurrentRunStorage({
        ...input,
        onBoundary: async (boundary) => {
          if (boundary !== "before_manifest") return;
          expect(
            JSON.parse(await readFile(join(fixture.runRoot, "storage.json"), "utf8")),
          ).toMatchObject({ schemaVersion: 1 });
          expect(
            JSON.parse(await readFile(join(fixture.runRoot, "artifact-inventory.json"), "utf8")),
          ).toMatchObject({ runId: fixture.runId });
          observedBoundary = true;
          throw new Error("Injected interruption before manifest publication");
        },
      }),
    ).rejects.toThrow(/Injected interruption/);

    expect(observedBoundary).toBe(true);
    expect(JSON.parse(await readFile(join(fixture.runRoot, "storage.json"), "utf8"))).toMatchObject(
      { schemaVersion: 1 },
    );
    expect(
      await exists(join(fixture.graphcraftRoot, "locks", `${fixture.runId}.migration.lock`)),
    ).toBe(false);
    expect(await exists(join(fixture.graphcraftRoot, "locks", `${fixture.runId}.lock`))).toBe(
      false,
    );

    await expect(ensureCurrentRunStorage(input)).resolves.toMatchObject({
      schemaVersion: 3,
      migratedFrom: 1,
    });
    expect(
      await fileSnapshot(
        join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "1-to-3"),
      ),
    ).not.toHaveProperty("artifact-inventory.json");
  });

  it("publishes a complete reusable backup before any v3 run projection", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000022", 1);
    const input = {
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    };
    const backupRoot = join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "1-to-3");
    let observedBoundary = false;

    await expect(
      ensureCurrentRunStorage({
        ...input,
        onBoundary: async (boundary) => {
          if (boundary !== "after_backup") return;
          observedBoundary = true;
          expect(await exists(join(backupRoot, ".backup-complete.json"))).toBe(true);
          expect(await fileSnapshot(backupRoot)).toEqual(await fileSnapshot(fixture.runRoot));
          expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
          expect(
            JSON.parse(await readFile(join(fixture.runRoot, "storage.json"), "utf8")),
          ).toMatchObject({ schemaVersion: 1 });
          throw new Error("Injected interruption after durable backup publication");
        },
      }),
    ).rejects.toThrow(/after durable backup publication/);

    expect(observedBoundary).toBe(true);
    expect(await exists(join(backupRoot, ".backup-complete.json"))).toBe(true);
    await expect(ensureCurrentRunStorage(input)).resolves.toMatchObject({
      schemaVersion: 3,
      migratedFrom: 1,
    });
  });

  it("binds manifest publication to the exact durable migrated inventory", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000039", 1);
    const input = {
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    };
    const inventoryPath = join(fixture.runRoot, "artifact-inventory.json");
    let mutated = false;

    await expect(
      ensureCurrentRunStorage({
        ...input,
        onBoundary: async (boundary) => {
          if (boundary !== "after_inventory") return;
          const inventory = JSON.parse(await readFile(inventoryPath, "utf8")) as ArtifactInventory;
          inventory.updatedAt = "2000-01-01T00:00:00.000Z";
          await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
          mutated = true;
        },
      }),
    ).rejects.toThrow(/artifact inventory changed after durable migration/);

    expect(mutated).toBe(true);
    expect(JSON.parse(await readFile(join(fixture.runRoot, "storage.json"), "utf8"))).toMatchObject(
      { schemaVersion: 1 },
    );
    expect(
      await exists(join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "1-to-3")),
    ).toBe(true);

    await expect(ensureCurrentRunStorage(input)).resolves.toMatchObject({
      schemaVersion: 3,
      migratedFrom: 1,
    });
  });

  it("refuses direct legacy-manifest publication without the backed-up migration path", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000026", 1);
    const storageBefore = await readFile(join(fixture.runRoot, "storage.json"));

    await expect(writeCurrentRunStorageManifest(fixture.runRoot, fixture.runId, 1)).rejects.toThrow(
      /only be published after verified backup migration/,
    );

    expect(await readFile(join(fixture.runRoot, "storage.json"))).toEqual(storageBefore);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
  });

  it("rejects a stale protected backup after a post-fault legacy append", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000010", 1);
    const input = {
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    };
    const backupRoot = join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "1-to-3");
    const staleBackupRoot = join(
      fixture.graphcraftRoot,
      "migration-backups",
      fixture.runId,
      "1-to-3.stale",
    );

    await expect(
      ensureCurrentRunStorage({
        ...input,
        onBoundary: (boundary) => {
          if (boundary !== "before_manifest") return;
          throw new Error("Injected interruption after inventory publication");
        },
      }),
    ).rejects.toThrow(/Injected interruption/);
    const protectedBackup = await treeSnapshot(backupRoot);

    await appendFile(join(fixture.runRoot, "events.jsonl"), '{"writer":"post-fault"}\n');
    const changedLegacyRun = await treeSnapshot(fixture.runRoot);

    await expect(ensureCurrentRunStorage(input)).rejects.toThrow(
      /backup does not match the current legacy run tree.*stale protected backup/,
    );
    expect(await treeSnapshot(fixture.runRoot)).toEqual(changedLegacyRun);
    expect(await treeSnapshot(backupRoot)).toEqual(protectedBackup);
    expect(JSON.parse(await readFile(join(fixture.runRoot, "storage.json"), "utf8"))).toMatchObject(
      { schemaVersion: 1 },
    );

    // Model explicit repair by preserving the stale backup elsewhere and
    // removing the migration-owned intermediate. The rebuilt exact backup must
    // include the legacy writer's append.
    await rename(backupRoot, staleBackupRoot);
    await rm(join(fixture.runRoot, "artifact-inventory.json"));
    await expect(ensureCurrentRunStorage(input)).resolves.toMatchObject({
      schemaVersion: 3,
      migratedFrom: 1,
    });
    expect(await readFile(join(backupRoot, "events.jsonl"), "utf8")).toContain(
      '{"writer":"post-fault"}',
    );
    expect(await exists(join(backupRoot, "artifact-inventory.json"))).toBe(false);
    expect(await treeSnapshot(staleBackupRoot)).toEqual(protectedBackup);
  });

  it("refuses an oversized storage manifest before allocating or mutating", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000023", 0);
    const storagePath = join(fixture.runRoot, "storage.json");
    await writeFile(storagePath, "{");
    await truncate(storagePath, 64 * 1024 + 1);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(/unreadable storage manifest.*65536-byte bounded read limit/);

    expect((await lstat(storagePath)).size).toBe(64 * 1024 + 1);
    expect(await exists(join(fixture.graphcraftRoot, "locks"))).toBe(false);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
  });

  it("refuses an oversized current-v3 artifact inventory without reconstructing it", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000024", 0);
    const input = {
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    };
    await ensureCurrentRunStorage(input);
    const storageBefore = await readFile(join(fixture.runRoot, "storage.json"));
    const inventoryPath = join(fixture.runRoot, "artifact-inventory.json");
    await writeFile(inventoryPath, "{");
    await truncate(inventoryPath, MAX_ARTIFACT_INVENTORY_BYTES + 1);

    await expect(ensureCurrentRunStorage(input)).rejects.toThrow(
      new RegExp(
        `invalid schema-v3 artifact inventory.*${MAX_ARTIFACT_INVENTORY_BYTES}-byte read limit`,
      ),
    );

    expect((await lstat(inventoryPath)).size).toBe(MAX_ARTIFACT_INVENTORY_BYTES + 1);
    expect(await readFile(join(fixture.runRoot, "storage.json"))).toEqual(storageBefore);
  });

  it("refuses an oversized backup completion marker without trusting the backup", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000025", 0);
    const backupRoot = join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "0-to-3");
    const completionPath = join(backupRoot, ".backup-complete.json");
    await mkdir(backupRoot, { recursive: true });
    await writeFile(completionPath, "{");
    await truncate(completionPath, 64 * 1024 + 1);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(/backup is incomplete or unverified.*65536-byte bounded read limit/);

    expect((await lstat(completionPath)).size).toBe(64 * 1024 + 1);
    expect(await exists(join(fixture.runRoot, "storage.json"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
  });

  it("accepts a current v3 manifest without changing the owned tree", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000003", 0);
    const input = {
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    };
    const expected = await ensureCurrentRunStorage(input);
    const before = await treeSnapshot(fixture.graphcraftRoot);

    const current = await ensureCurrentRunStorage(input);

    expect(current).toEqual(expected);
    expect(await treeSnapshot(fixture.graphcraftRoot)).toEqual(before);
  });

  it("preserves an independent held-out format in a current manifest", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000046", 0);
    const input = {
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    };
    await ensureCurrentRunStorage(input);
    const storagePath = join(fixture.runRoot, "storage.json");
    const manifest = JSON.parse(await readFile(storagePath, "utf8")) as {
      formats: { heldOutProbes: number };
    };
    manifest.formats.heldOutProbes = 2;
    await writeFile(storagePath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = await treeSnapshot(fixture.graphcraftRoot);

    await expect(ensureCurrentRunStorage(input)).resolves.toMatchObject({
      schemaVersion: 3,
      canonicalHashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
      formats: { heldOutProbes: 2, events: 1 },
    });

    expect(await treeSnapshot(fixture.graphcraftRoot)).toEqual(before);
  });

  it("rejects a symlinked or junctioned runs directory after storage was prepared", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000011", 0);
    const repositoryRoot = dirname(fixture.graphcraftRoot);
    const store = new RunStore(repositoryRoot, fixture.runId);
    await store.prepareStorage();
    const runsRoot = join(fixture.graphcraftRoot, "runs");
    const outsideRuns = join(repositoryRoot, "outside-runs");
    await rename(runsRoot, outsideRuns);
    await symlink(outsideRuns, runsRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(store.prepareStorage()).rejects.toThrow(/symbolic link/i);
    expect(await exists(join(outsideRuns, fixture.runId, "storage.json"))).toBe(true);
  });

  it("refuses a multiply linked event log before reading or appending shared bytes", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000012", 0);
    await ensureCurrentRunStorage({
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    });
    const eventsPath = join(fixture.runRoot, "events.jsonl");
    const outsideEvents = join(dirname(fixture.graphcraftRoot), "outside-events.jsonl");
    await rename(eventsPath, outsideEvents);
    await link(outsideEvents, eventsPath);
    const before = await readFile(outsideEvents, "utf8");
    const store = new RunStore(dirname(fixture.graphcraftRoot), fixture.runId);

    await expect(store.loadEvents()).rejects.toThrow(/multiply linked file/i);
    await expect(
      store.append("runtime", "run.blocked", { reason: "must not be appended" }),
    ).rejects.toThrow(/multiply linked file/i);
    expect(await readFile(outsideEvents, "utf8")).toBe(before);
  });

  it("fails closed on a corrupt current-v3 inventory without reconstructing it", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000006", 0);
    const input = {
      graphcraftRoot: fixture.graphcraftRoot,
      runRoot: fixture.runRoot,
      runId: fixture.runId,
    };
    await ensureCurrentRunStorage(input);
    await writeFile(join(fixture.runRoot, "artifact-inventory.json"), "{}\n");
    const before = await treeSnapshot(fixture.graphcraftRoot);

    await expect(ensureCurrentRunStorage(input)).rejects.toThrow(
      /invalid schema-v3 artifact inventory/,
    );

    expect(await treeSnapshot(fixture.graphcraftRoot)).toEqual(before);
  });

  it("refuses a preseeded backup directory without a valid completion marker and digest", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000005", 0);
    const backupRoot = join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "0-to-3");
    await mkdir(backupRoot, { recursive: true });
    await writeFile(join(backupRoot, "untrusted.txt"), "not a complete backup\n");
    const before = await treeSnapshot(fixture.runRoot);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(/backup is incomplete or unverified/);

    expect(await treeSnapshot(fixture.runRoot)).toEqual(before);
    expect(await exists(join(fixture.runRoot, "storage.json"))).toBe(false);
    expect(await exists(join(fixture.runRoot, "artifact-inventory.json"))).toBe(false);
  });

  it("allows the same store to retry storage preparation after a repairable failure", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000009", 0);
    const backupRoot = join(fixture.graphcraftRoot, "migration-backups", fixture.runId, "0-to-3");
    await mkdir(backupRoot, { recursive: true });
    await writeFile(join(backupRoot, "incomplete.txt"), "repairable test fixture\n");
    const store = new RunStore(dirname(fixture.graphcraftRoot), fixture.runId);

    await expect(store.prepareStorage()).rejects.toThrow(/backup is incomplete or unverified/);
    await rm(backupRoot, { recursive: true });

    await expect(store.prepareStorage()).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(join(fixture.runRoot, "storage.json"), "utf8"))).toMatchObject(
      { schemaVersion: 3, migratedFrom: 0 },
    );
  });

  it("refuses a future manifest before creating locks, backups, or changing run files", async () => {
    const fixture = await createLegacyFixture("20000000-0000-4000-8000-000000000004", 0);
    await writeFile(
      join(fixture.runRoot, "storage.json"),
      `${JSON.stringify({ schemaVersion: 999, runId: fixture.runId })}\n`,
    );
    const before = await treeSnapshot(fixture.graphcraftRoot);

    await expect(
      ensureCurrentRunStorage({
        graphcraftRoot: fixture.graphcraftRoot,
        runRoot: fixture.runRoot,
        runId: fixture.runId,
      }),
    ).rejects.toThrow(/future storage schema 999.*No files were changed/);

    expect(await treeSnapshot(fixture.graphcraftRoot)).toEqual(before);
    expect(await exists(join(fixture.graphcraftRoot, "locks"))).toBe(false);
    expect(await exists(join(fixture.graphcraftRoot, "migration-backups"))).toBe(false);
  });
});
