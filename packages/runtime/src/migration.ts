import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  RunStorageManifestSchema,
  type ArtifactInventory,
  type RunStorageManifest,
} from "@graphcraft/core";
import {
  DEFAULT_ARTIFACT_POLICY,
  RunArtifactStore,
  readBoundedArtifactInventory,
} from "./artifact-policy.ts";
import { syncDirectory, writeJsonAtomic } from "./json.ts";
import { RunLock } from "./lock.ts";
import { redactTextBytes } from "./redaction.ts";
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  hardenPrivateTree,
  readPrivateFileBounded,
  validatePrivatePath,
} from "./secure-fs.ts";

export const CURRENT_RUN_STORAGE_VERSION = 2;
const BACKUP_COMPLETION_FILE = ".backup-complete.json";
const ARTIFACT_INVENTORY_FILE = "artifact-inventory.json";
const MIB = 1024 * 1024;
const MIGRATION_DESCRIPTOR_MAX_BYTES = 64 * 1024;
const MIGRATION_COPY_CHUNK_BYTES = 64 * 1024;

/**
 * Mirrored from store.ts instead of imported because RunStore imports this
 * migration module. The focused drift test keeps these publication limits in
 * lockstep without introducing a runtime dependency cycle.
 */
export const LEGACY_MIGRATION_DESTINATION_LIMITS = Object.freeze({
  maximumEventBytes: 4 * MIB,
  maximumEventLogBytes: 64 * MIB,
  blockedEventReserveBytes: 64 * 1024,
  maximumStateBytes: 16 * MIB,
  maximumMetadataBytes: 4 * MIB,
  maximumWorkspaceBytes: 64 * 1024,
});

/**
 * Legacy migration duplicates the complete pre-migration tree. Bound metadata
 * traversal, content scanning, and backup amplification before reading file
 * contents or creating a backup. These limits cover the entire run tree, not
 * only artifacts and capsules; the lower artifact limit separately preserves
 * current-format recovery capacity.
 */
export const LEGACY_MIGRATION_RESOURCE_LIMITS = Object.freeze({
  maximumFileBytes: 64 * MIB,
  maximumRunBytes: 128 * MIB,
  maximumFileCount: 4 * 1024,
  maximumEntryCount: 8 * 1024,
});

type LegacyStorageVersion = 0 | 1;
type CurrentRunStorageManifest = Extract<RunStorageManifest, { schemaVersion: 2 }>;

interface LegacyStorage {
  version: LegacyStorageVersion;
}

interface CurrentStorage {
  version: 2;
  manifest: CurrentRunStorageManifest;
}

type StorageInspection = LegacyStorage | CurrentStorage;

function manifest(runId: string, migratedFrom: 0 | 1 | 2): CurrentRunStorageManifest {
  return RunStorageManifestSchema.parse({
    schemaVersion: CURRENT_RUN_STORAGE_VERSION,
    runId,
    migratedFrom,
    formats: {
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
      artifactInventory: 1,
      artifactPolicy: 1,
    },
  }) as CurrentRunStorageManifest;
}

export function runStorageManifestPath(runRoot: string): string {
  return join(runRoot, "storage.json");
}

async function validateRunStorageRoot(input: {
  graphcraftRoot: string;
  runRoot: string;
}): Promise<void> {
  const graphcraftRoot = resolve(input.graphcraftRoot);
  const runRoot = resolve(input.runRoot);
  const validated = await validatePrivatePath(graphcraftRoot, relative(graphcraftRoot, runRoot));
  if (validated !== runRoot)
    throw new Error(`Run storage path escaped the Graphcraft state directory: ${input.runRoot}`);
}

async function persistCurrentRunStorageManifest(
  runRoot: string,
  runId: string,
  migratedFrom: 0 | 1 | 2,
): Promise<CurrentRunStorageManifest> {
  const value = manifest(runId, migratedFrom);
  await ensurePrivateDirectory(runRoot);
  const path = runStorageManifestPath(runRoot);
  await writeJsonAtomic(path, value);
  await hardenPrivateFile(path, runRoot);
  return value;
}

/** Fresh-run storage publication. Legacy migrations must use the backed-up migration path. */
export async function writeCurrentRunStorageManifest(
  runRoot: string,
  runId: string,
  migratedFrom: 0 | 1 | 2,
): Promise<CurrentRunStorageManifest> {
  if (migratedFrom !== CURRENT_RUN_STORAGE_VERSION)
    throw new Error(
      "Legacy storage manifests can only be published after verified backup migration",
    );
  return await persistCurrentRunStorageManifest(runRoot, runId, migratedFrom);
}

async function readRawManifest(runRoot: string, runId: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(
      (
        await readPrivateFileBounded(
          runStorageManifestPath(runRoot),
          MIGRATION_DESCRIPTOR_MAX_BYTES,
          runRoot,
        )
      ).toString("utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Run ${runId} has an unreadable storage manifest: ${error instanceof Error ? error.message : String(error)}. No files were changed.`,
    );
  }
}

async function inspectStorage(runRoot: string, runId: string): Promise<StorageInspection> {
  const raw = await readRawManifest(runRoot, runId);
  if (raw === undefined) return { version: 0 };
  const version =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>).schemaVersion
      : undefined;
  if (typeof version === "number" && version > CURRENT_RUN_STORAGE_VERSION)
    throw new Error(
      `Run ${runId} uses future storage schema ${version}; this Graphcraft supports through ${CURRENT_RUN_STORAGE_VERSION}. No files were changed.`,
    );
  if (version !== 1 && version !== CURRENT_RUN_STORAGE_VERSION)
    throw new Error(
      `Run ${runId} uses unsupported storage schema ${String(version)}; no migration path is available. No files were changed.`,
    );

  let parsed: RunStorageManifest;
  try {
    parsed = RunStorageManifestSchema.parse(raw);
  } catch (error) {
    throw new Error(
      `Run ${runId} has an invalid storage schema ${version}: ${error instanceof Error ? error.message : String(error)}. No files were changed.`,
    );
  }
  if (parsed.runId !== runId)
    throw new Error(
      `Run storage manifest belongs to ${parsed.runId}, not ${runId}. No files were changed.`,
    );
  if (parsed.schemaVersion !== CURRENT_RUN_STORAGE_VERSION) return { version: 1 };
  try {
    await validatePrivatePath(runRoot, ARTIFACT_INVENTORY_FILE);
    const inventory = await readBoundedArtifactInventory(join(runRoot, ARTIFACT_INVENTORY_FILE));
    if (inventory.runId !== runId)
      throw new Error(`artifact inventory belongs to ${inventory.runId}`);
  } catch (error) {
    throw new Error(
      `Run ${runId} has an invalid schema-v2 artifact inventory: ${error instanceof Error ? error.message : String(error)}. No files were changed.`,
    );
  }
  return { version: 2, manifest: parsed };
}

function isActiveLockError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("already active");
}

async function acquireMigrationLock(input: {
  graphcraftRoot: string;
  runRoot: string;
  runId: string;
}): Promise<{ lock?: RunLock; manifest?: CurrentRunStorageManifest }> {
  const lockPath = join(input.graphcraftRoot, "locks", `${input.runId}.migration.lock`);
  while (true) {
    await validateRunStorageRoot(input);
    const storage = await inspectStorage(input.runRoot, input.runId);
    if (storage.version === CURRENT_RUN_STORAGE_VERSION) return { manifest: storage.manifest };
    const lock = new RunLock(lockPath);
    try {
      await lock.acquire();
      return { lock };
    } catch (error) {
      if (!isActiveLockError(error)) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function acquireActiveAwareLock(path: string): Promise<RunLock> {
  while (true) {
    const lock = new RunLock(path);
    try {
      await lock.acquire();
      return lock;
    } catch (error) {
      if (!isActiveLockError(error)) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function status(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

interface LegacyScanDirectory {
  kind: "directory";
  path: string;
  relativePath: string;
  fingerprint: string;
}

interface LegacyScanFile {
  kind: "file";
  path: string;
  relativePath: string;
  bytes: number;
  fingerprint: string;
  hash: string;
}

type LegacyScanEntry = LegacyScanDirectory | LegacyScanFile;
type LegacyMetadataEntry = LegacyScanDirectory | Omit<LegacyScanFile, "hash">;

interface LegacyTreeMetadata {
  rootFingerprint: string;
  entries: LegacyMetadataEntry[];
}

interface LegacyTreeSnapshot {
  rootFingerprint: string;
  entries: LegacyScanEntry[];
  files: LegacyScanFile[];
  digest: string;
}

export type LegacySnapshotRefreshEntryEvidence =
  | {
      kind: "directory";
      relativePath: string;
      fingerprint: string;
    }
  | {
      kind: "file";
      relativePath: string;
      fingerprint: string;
      bytes: number;
      hash: string;
    };

/** Metadata and content evidence used to validate the post-ACL source refresh. @internal */
export interface LegacySnapshotRefreshEvidence {
  rootFingerprint: string;
  entries: LegacySnapshotRefreshEntryEvidence[];
  digest: string;
}

interface LegacyTreeCaptureOptions {
  ignoredRootName?: string;
  rejectBackupMarker?: boolean;
  scanRedaction?: boolean;
  enforceDestinationLimits?: boolean;
}

function legacyMetadataFingerprint(metadata: BigIntStats): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.nlink,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].join(":");
}

function assertLegacyFileMetadata(
  metadata: BigIntStats,
  expected: Omit<LegacyScanFile, "hash"> | LegacyScanFile,
  stage: string,
): void {
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink > 1n)
    throw new Error(
      `Legacy file ${expected.relativePath} became unsafe ${stage}; no backup was created`,
    );
  if (
    metadata.size !== BigInt(expected.bytes) ||
    legacyMetadataFingerprint(metadata) !== expected.fingerprint
  )
    throw new Error(`Legacy file ${expected.relativePath} changed ${stage}; no backup was created`);
}

function assertLegacyDirectoryMetadata(
  metadata: BigIntStats,
  expected: LegacyScanDirectory,
  stage: string,
): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error(
      `Legacy directory ${expected.relativePath} became unsafe ${stage}; no backup was created`,
    );
  if (legacyMetadataFingerprint(metadata) !== expected.fingerprint)
    throw new Error(
      `Legacy directory ${expected.relativePath} changed ${stage}; no backup was created`,
    );
}

function legacyMetadataView(metadata: LegacyTreeMetadata): unknown {
  return {
    rootFingerprint: metadata.rootFingerprint,
    entries: metadata.entries.map((entry) => ({
      kind: entry.kind,
      relativePath: entry.relativePath,
      fingerprint: entry.fingerprint,
      ...(entry.kind === "file" ? { bytes: entry.bytes } : {}),
    })),
  };
}

function legacySnapshotView(snapshot: LegacyTreeSnapshot): unknown {
  return {
    rootFingerprint: snapshot.rootFingerprint,
    entries: snapshot.entries.map((entry) => ({
      kind: entry.kind,
      relativePath: entry.relativePath,
      fingerprint: entry.fingerprint,
      ...(entry.kind === "file" ? { bytes: entry.bytes, hash: entry.hash } : {}),
    })),
    digest: snapshot.digest,
  };
}

function legacySnapshotRefreshEvidence(
  snapshot: LegacyTreeSnapshot,
): LegacySnapshotRefreshEvidence {
  return {
    rootFingerprint: snapshot.rootFingerprint,
    entries: snapshot.entries.map((entry) =>
      entry.kind === "directory"
        ? {
            kind: entry.kind,
            relativePath: entry.relativePath,
            fingerprint: entry.fingerprint,
          }
        : {
            kind: entry.kind,
            relativePath: entry.relativePath,
            fingerprint: entry.fingerprint,
            bytes: entry.bytes,
            hash: entry.hash,
          },
    ),
    digest: snapshot.digest,
  };
}

function legacyMetadataFingerprintWithoutCtime(fingerprint: string): string {
  const fields = fingerprint.split(":");
  if (fields.length !== 7 || fields.some((field) => !/^\d+$/u.test(field)))
    throw new Error("Legacy migration metadata fingerprint is malformed");
  return fields.slice(0, -1).join(":");
}

function legacySnapshotRefreshInvariantView(snapshot: LegacySnapshotRefreshEvidence): unknown {
  return {
    rootFingerprint: legacyMetadataFingerprintWithoutCtime(snapshot.rootFingerprint),
    entries: snapshot.entries.map((entry) => ({
      kind: entry.kind,
      relativePath: entry.relativePath,
      fingerprint: legacyMetadataFingerprintWithoutCtime(entry.fingerprint),
      ...(entry.kind === "file" ? { bytes: entry.bytes, hash: entry.hash } : {}),
    })),
    digest: snapshot.digest,
  };
}

/**
 * Accept a source recapture after owned backup directories have been secured
 * only when Windows ACL inheritance changed ctime and nothing else.
 *
 * @internal
 */
export function assertLegacySnapshotRefreshIsCtimeOnly(
  preflight: LegacySnapshotRefreshEvidence,
  refreshed: LegacySnapshotRefreshEvidence,
): void {
  if (
    !isDeepStrictEqual(
      legacySnapshotRefreshInvariantView(preflight),
      legacySnapshotRefreshInvariantView(refreshed),
    )
  )
    throw new Error(
      "Legacy run tree changed while preparing secure backup storage; no backup was created",
    );
}

function legacySnapshotContents(snapshot: LegacyTreeSnapshot): unknown {
  return {
    entries: snapshot.entries.map((entry) =>
      entry.kind === "directory"
        ? { kind: entry.kind, relativePath: entry.relativePath }
        : {
            kind: entry.kind,
            relativePath: entry.relativePath,
            bytes: entry.bytes,
            hash: entry.hash,
          },
    ),
    digest: snapshot.digest,
  };
}

function legacyTreeDigest(entries: LegacyScanEntry[], ignoredRootName?: string): string {
  const values = entries
    .filter(
      (entry) =>
        ignoredRootName === undefined ||
        entry.relativePath !== ignoredRootName ||
        entry.relativePath.includes("/"),
    )
    .map((entry) =>
      entry.kind === "directory"
        ? `directory:${entry.relativePath}`
        : `file:${entry.relativePath}:${entry.bytes}:${entry.hash}`,
    );
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

async function scanLegacyTreeMetadata(
  root: string,
  options: LegacyTreeCaptureOptions,
): Promise<LegacyTreeMetadata> {
  const rootMetadata = await lstat(root, { bigint: true });
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory())
    throw new Error("Storage migration cannot scan an unsafe legacy run root");
  let entryCount = 0;
  let fileCount = 0;
  const entries: LegacyMetadataEntry[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (relativeDirectory.length === 0 && name === options.ignoredRootName) continue;
      if (
        relativeDirectory.length === 0 &&
        options.rejectBackupMarker &&
        name === BACKUP_COMPLETION_FILE
      )
        throw new Error(
          `Legacy run contains reserved root file ${BACKUP_COMPLETION_FILE}; remove it before retrying`,
        );
      const path = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      entryCount += 1;
      if (entryCount > LEGACY_MIGRATION_RESOURCE_LIMITS.maximumEntryCount)
        throw new Error(
          `Legacy run contains more than the ${LEGACY_MIGRATION_RESOURCE_LIMITS.maximumEntryCount}-entry safe migration limit; prune legacy run state before retrying`,
        );
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink())
        throw new Error("Storage migration cannot scan a symbolic link; no backup was created");
      if (metadata.isDirectory()) {
        entries.push({
          kind: "directory",
          path,
          relativePath,
          fingerprint: legacyMetadataFingerprint(metadata),
        });
        await visit(path, relativePath);
        continue;
      }
      if (!metadata.isFile())
        throw new Error(
          "Storage migration cannot scan an unsupported entry; no backup was created",
        );
      if (metadata.nlink > 1n)
        throw new Error(
          "Storage migration cannot scan a multiply linked file; no backup was created",
        );
      if (fileCount >= LEGACY_MIGRATION_RESOURCE_LIMITS.maximumFileCount)
        throw new Error(
          `Legacy run contains more than the ${LEGACY_MIGRATION_RESOURCE_LIMITS.maximumFileCount}-file safe migration limit; prune legacy run state before retrying`,
        );
      fileCount += 1;
      const bytes = Number(metadata.size);
      if (!Number.isSafeInteger(bytes))
        throw new Error("Legacy run contains a file with an unsafe byte length");
      entries.push({
        kind: "file",
        path,
        relativePath,
        bytes,
        fingerprint: legacyMetadataFingerprint(metadata),
      });
    }
  };
  await visit(root, "");
  return { rootFingerprint: legacyMetadataFingerprint(rootMetadata), entries };
}

function assertLegacyResourceLimits(metadata: LegacyTreeMetadata): void {
  const files = metadata.entries.filter(
    (entry): entry is Omit<LegacyScanFile, "hash"> => entry.kind === "file",
  );
  const artifactLimit =
    DEFAULT_ARTIFACT_POLICY.runArtifactBytes - DEFAULT_ARTIFACT_POLICY.runReservedBytes;

  for (const { relativePath } of metadata.entries)
    if (!redactTextBytes(relativePath).equals(Buffer.from(relativePath, "utf8")))
      throw new Error(
        "Legacy run contains a secret-like path and cannot migrate safely; rename or delete the affected legacy content before retrying",
      );

  const oversized = files.find(
    ({ bytes }) => bytes > LEGACY_MIGRATION_RESOURCE_LIMITS.maximumFileBytes,
  );
  if (oversized)
    throw new Error(
      `Legacy run contains a file larger than the ${LEGACY_MIGRATION_RESOURCE_LIMITS.maximumFileBytes}-byte safe migration scan limit; remove or reduce oversized legacy content before retrying`,
    );
  const runBytes = files.reduce((total, file) => total + BigInt(file.bytes), 0n);
  if (runBytes > BigInt(LEGACY_MIGRATION_RESOURCE_LIMITS.maximumRunBytes))
    throw new Error(
      `Legacy run contains more than the ${LEGACY_MIGRATION_RESOURCE_LIMITS.maximumRunBytes}-byte whole-run safe migration limit; prune legacy run state before retrying`,
    );
  const artifactBytes = files
    .filter(
      ({ relativePath }) =>
        relativePath.startsWith("artifacts/") || relativePath.startsWith("capsules/"),
    )
    .reduce((total, file) => total + BigInt(file.bytes), 0n);
  if (artifactBytes > BigInt(artifactLimit))
    throw new Error(
      `Legacy run contains more than the ${artifactLimit}-byte safe artifact migration limit; prune legacy artifacts before retrying`,
    );
}

function assertLegacyDestinationLimits(metadata: LegacyTreeMetadata): void {
  const files = new Map(
    metadata.entries
      .filter((entry): entry is Omit<LegacyScanFile, "hash"> => entry.kind === "file")
      .map((entry) => [entry.relativePath, entry]),
  );
  const assertFileLimit = (path: string, limit: number, label: string): void => {
    const file = files.get(path);
    if (file && file.bytes > limit)
      throw new Error(
        `Legacy ${label} exceeds the ${limit}-byte current-storage publication limit`,
      );
  };
  const normalEventLogBytes =
    LEGACY_MIGRATION_DESTINATION_LIMITS.maximumEventLogBytes -
    LEGACY_MIGRATION_DESTINATION_LIMITS.blockedEventReserveBytes;
  assertFileLimit("events.jsonl", normalEventLogBytes, "event log");
  assertFileLimit(
    "state.json",
    LEGACY_MIGRATION_DESTINATION_LIMITS.maximumStateBytes,
    "materialized state",
  );
  for (const path of ["contract.json", "graph.json", "probe-plan.json", "held-out-probes.json"])
    assertFileLimit(path, LEGACY_MIGRATION_DESTINATION_LIMITS.maximumMetadataBytes, path);
  assertFileLimit(
    "workspace.json",
    LEGACY_MIGRATION_DESTINATION_LIMITS.maximumWorkspaceBytes,
    "workspace projection",
  );
}

function advanceLegacyEventLineLength(chunk: Buffer, previousLength: number): number {
  let length = previousLength;
  for (const byte of chunk) {
    length += 1;
    if (byte !== 0x0a) continue;
    if (length > LEGACY_MIGRATION_DESTINATION_LIMITS.maximumEventBytes)
      throw new Error(
        `Legacy event log contains a line exceeding the ${LEGACY_MIGRATION_DESTINATION_LIMITS.maximumEventBytes}-byte current-storage publication limit`,
      );
    length = 0;
  }
  return length;
}

async function readLegacySnapshotFile(
  expected: Omit<LegacyScanFile, "hash">,
  options: LegacyTreeCaptureOptions,
): Promise<string> {
  assertLegacyFileMetadata(
    await lstat(expected.path, { bigint: true }),
    expected,
    "before opening",
  );
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(expected.path, fsConstants.O_RDONLY | noFollow);
  const hash = createHash("sha256");
  const redactionChunks: Buffer[] | undefined = options.scanRedaction ? [] : undefined;
  const buffer = Buffer.alloc(Math.min(MIGRATION_COPY_CHUNK_BYTES, Math.max(1, expected.bytes)));
  let position = 0;
  let eventLineLength = 0;
  try {
    assertLegacyFileMetadata(await handle.stat({ bigint: true }), expected, "when opened");
    while (position < expected.bytes) {
      const requested = Math.min(buffer.length, expected.bytes - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0)
        throw new Error(
          `Legacy file ${expected.relativePath} changed while being read; no backup was created`,
        );
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (redactionChunks) redactionChunks.push(Buffer.from(chunk));
      if (options.enforceDestinationLimits && expected.relativePath === "events.jsonl")
        eventLineLength = advanceLegacyEventLineLength(chunk, eventLineLength);
      position += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, position)).bytesRead !== 0)
      throw new Error(
        `Legacy file ${expected.relativePath} changed while being read; no backup was created`,
      );
    assertLegacyFileMetadata(await handle.stat({ bigint: true }), expected, "while being read");
    assertLegacyFileMetadata(
      await lstat(expected.path, { bigint: true }),
      expected,
      "after reading",
    );
  } finally {
    await handle.close();
  }
  if (position !== expected.bytes)
    throw new Error(
      `Legacy file ${expected.relativePath} changed while being read; no backup was created`,
    );
  if (
    options.enforceDestinationLimits &&
    expected.relativePath === "events.jsonl" &&
    eventLineLength > 0 &&
    eventLineLength + 1 > LEGACY_MIGRATION_DESTINATION_LIMITS.maximumEventBytes
  )
    throw new Error(
      `Legacy event log contains a line exceeding the ${LEGACY_MIGRATION_DESTINATION_LIMITS.maximumEventBytes}-byte current-storage publication limit`,
    );
  if (redactionChunks) {
    const source = Buffer.concat(redactionChunks, expected.bytes);
    if (!redactTextBytes(source).equals(source))
      throw new Error(
        "Legacy run contains secret-like material and cannot migrate safely; scrub or delete the affected legacy content before retrying",
      );
  }
  return hash.digest("hex");
}

async function captureLegacyTreeSnapshot(
  root: string,
  options: LegacyTreeCaptureOptions = {},
): Promise<LegacyTreeSnapshot> {
  const metadata = await scanLegacyTreeMetadata(root, options);
  assertLegacyResourceLimits(metadata);
  if (options.enforceDestinationLimits) assertLegacyDestinationLimits(metadata);
  const entries: LegacyScanEntry[] = [];
  const files: LegacyScanFile[] = [];
  for (const entry of metadata.entries) {
    if (entry.kind === "directory") {
      entries.push(entry);
      continue;
    }
    const file = { ...entry, hash: await readLegacySnapshotFile(entry, options) };
    entries.push(file);
    files.push(file);
  }
  const after = await scanLegacyTreeMetadata(root, options);
  if (!isDeepStrictEqual(legacyMetadataView(metadata), legacyMetadataView(after)))
    throw new Error("Legacy run tree changed during migration preflight; no backup was created");
  return {
    rootFingerprint: metadata.rootFingerprint,
    entries,
    files,
    digest: legacyTreeDigest(entries),
  };
}

async function assertLegacyTreeRedactionSafe(root: string): Promise<LegacyTreeSnapshot> {
  return await captureLegacyTreeSnapshot(root, {
    rejectBackupMarker: true,
    scanRedaction: true,
    enforceDestinationLimits: true,
  });
}

interface BackupCompletion {
  schemaVersion: 1;
  kind: "graphcraft_storage_migration_backup";
  runId: string;
  sourceVersion: LegacyStorageVersion;
  targetVersion: 2;
  treeDigest: string;
}

function parseBackupCompletion(
  value: unknown,
  input: {
    runId: string;
    sourceVersion: LegacyStorageVersion;
  },
): BackupCompletion {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("backup completion marker is not an object");
  const marker = value as Record<string, unknown>;
  if (
    marker.schemaVersion !== 1 ||
    marker.kind !== "graphcraft_storage_migration_backup" ||
    marker.runId !== input.runId ||
    marker.sourceVersion !== input.sourceVersion ||
    marker.targetVersion !== CURRENT_RUN_STORAGE_VERSION ||
    typeof marker.treeDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(marker.treeDigest)
  )
    throw new Error("backup completion marker does not match this migration");
  return marker as unknown as BackupCompletion;
}

async function validateCompleteBackup(
  backupRoot: string,
  input: { runId: string; sourceVersion: LegacyStorageVersion },
): Promise<{ marker: BackupCompletion; snapshot: LegacyTreeSnapshot }> {
  let marker: BackupCompletion;
  try {
    marker = parseBackupCompletion(
      JSON.parse(
        (
          await readPrivateFileBounded(
            join(backupRoot, BACKUP_COMPLETION_FILE),
            MIGRATION_DESCRIPTOR_MAX_BYTES,
            backupRoot,
          )
        ).toString("utf8"),
      ),
      input,
    );
  } catch (error) {
    throw new Error(
      `Existing storage migration backup is incomplete or unverified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const snapshot = await captureLegacyTreeSnapshot(backupRoot, {
    ignoredRootName: BACKUP_COMPLETION_FILE,
  });
  for (const requiredPath of [
    "events.jsonl",
    ...(input.sourceVersion === 1 ? ["storage.json"] : []),
  ]) {
    const entry = snapshot.entries.find(({ relativePath }) => relativePath === requiredPath);
    if (entry?.kind !== "file")
      throw new Error(`Existing storage migration backup lacks required file: ${requiredPath}`);
  }
  if (snapshot.digest !== marker.treeDigest)
    throw new Error("Existing storage migration backup digest does not match its contents");
  return { marker, snapshot };
}

async function hasMigrationOwnedInventory(
  runRoot: string,
  backupSnapshot: LegacyTreeSnapshot,
  runId: string,
): Promise<boolean> {
  const inventoryPath = join(runRoot, ARTIFACT_INVENTORY_FILE);
  const inventoryStatus = await status(inventoryPath);
  if (!inventoryStatus) return false;
  if (inventoryStatus.isSymbolicLink() || !inventoryStatus.isFile())
    throw new Error(`Storage migration intermediate inventory is unsafe: ${inventoryPath}`);
  if (backupSnapshot.entries.some(({ relativePath }) => relativePath === ARTIFACT_INVENTORY_FILE))
    return false;

  let inventory;
  try {
    inventory = await readBoundedArtifactInventory(inventoryPath);
  } catch (error) {
    throw new Error(
      `Storage migration intermediate inventory is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (inventory.runId !== runId)
    throw new Error(
      `Storage migration intermediate inventory belongs to ${inventory.runId}, not ${runId}`,
    );
  if (
    inventory.entries.some(
      (entry) =>
        !entry.legacy ||
        entry.disposition !== "legacy" ||
        entry.reason !== "legacy_migration" ||
        entry.truncated ||
        entry.omittedBytes !== 0 ||
        entry.sourceBytes !== entry.storedBytes,
    )
  )
    throw new Error(
      "Storage migration intermediate inventory was not produced by legacy migration",
    );
  return true;
}

async function validateBackupMatchesLegacyRun(input: {
  runRoot: string;
  runId: string;
  marker: BackupCompletion;
  backupSnapshot: LegacyTreeSnapshot;
  sourceSnapshot: LegacyTreeSnapshot;
}): Promise<void> {
  if (input.sourceSnapshot.digest === input.marker.treeDigest) return;

  if (
    (await hasMigrationOwnedInventory(input.runRoot, input.backupSnapshot, input.runId)) &&
    legacyTreeDigest(input.sourceSnapshot.entries, ARTIFACT_INVENTORY_FILE) ===
      input.marker.treeDigest
  )
    return;

  throw new Error(
    "Existing storage migration backup does not match the current legacy run tree; refusing to reuse a stale protected backup",
  );
}

function backupEntryFingerprint(metadata: Stats): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.nlink,
    metadata.size,
    metadata.mtimeMs,
    metadata.ctimeMs,
  ].join(":");
}

async function syncBackupFile(path: string, observed: Stats): Promise<void> {
  if (observed.isSymbolicLink() || !observed.isFile() || observed.nlink > 1)
    throw new Error(`Storage migration backup payload is unsafe: ${path}`);
  const expected = backupEntryFingerprint(observed);
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  // Windows does not permit fsync on a read-only file descriptor.
  const handle = await open(path, fsConstants.O_RDWR | noFollow);
  try {
    const before = await handle.stat();
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink > 1 ||
      backupEntryFingerprint(before) !== expected
    )
      throw new Error(`Storage migration backup payload changed before fsync: ${path}`);
    await handle.sync();
    const after = await handle.stat();
    const current = await lstat(path);
    if (backupEntryFingerprint(after) !== expected || backupEntryFingerprint(current) !== expected)
      throw new Error(`Storage migration backup payload changed during fsync: ${path}`);
  } finally {
    await handle.close();
  }
}

async function syncBackupTree(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const observed = await lstat(directory);
    if (observed.isSymbolicLink() || !observed.isDirectory())
      throw new Error(`Storage migration backup directory is unsafe: ${directory}`);
    const expected = backupEntryFingerprint(observed);
    for (const name of (await readdir(directory)).sort((left, right) =>
      left.localeCompare(right),
    )) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await visit(path);
      else await syncBackupFile(path, metadata);
    }
    if (backupEntryFingerprint(await lstat(directory)) !== expected)
      throw new Error(`Storage migration backup directory changed during fsync: ${directory}`);
    await syncDirectory(directory);
  };
  await visit(root);
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Buffer,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < chunk.length) {
    const result = await handle.write(chunk, written, chunk.length - written, position + written);
    if (result.bytesWritten === 0)
      throw new Error("Storage migration backup destination stopped accepting bytes");
    written += result.bytesWritten;
  }
}

async function copyLegacySnapshotFile(
  source: LegacyScanFile,
  destinationPath: string,
): Promise<void> {
  assertLegacyFileMetadata(
    await lstat(source.path, { bigint: true }),
    source,
    "before backup copy",
  );
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const sourceHandle = await open(source.path, fsConstants.O_RDONLY | noFollow);
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    assertLegacyFileMetadata(
      await sourceHandle.stat({ bigint: true }),
      source,
      "when opened for backup copy",
    );
    destinationHandle = await open(
      destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(MIGRATION_COPY_CHUNK_BYTES, Math.max(1, source.bytes)));
    let position = 0;
    while (position < source.bytes) {
      const requested = Math.min(buffer.length, source.bytes - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, requested, position);
      if (bytesRead === 0)
        throw new Error(
          `Legacy file ${source.relativePath} changed during backup copy; no backup was created`,
        );
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await writeAll(destinationHandle, chunk, position);
      position += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await sourceHandle.read(extra, 0, 1, position)).bytesRead !== 0)
      throw new Error(
        `Legacy file ${source.relativePath} changed during backup copy; no backup was created`,
      );
    assertLegacyFileMetadata(
      await sourceHandle.stat({ bigint: true }),
      source,
      "during backup copy",
    );
    assertLegacyFileMetadata(
      await lstat(source.path, { bigint: true }),
      source,
      "after backup copy",
    );
    if (position !== source.bytes || hash.digest("hex") !== source.hash)
      throw new Error(
        `Legacy file ${source.relativePath} content changed during backup copy; no backup was created`,
      );
    await destinationHandle.sync();
    const destination = await destinationHandle.stat({ bigint: true });
    const destinationPathMetadata = await lstat(destinationPath, { bigint: true });
    if (
      destination.isSymbolicLink() ||
      !destination.isFile() ||
      destination.nlink > 1n ||
      destination.size !== BigInt(source.bytes) ||
      legacyMetadataFingerprint(destination) !== legacyMetadataFingerprint(destinationPathMetadata)
    )
      throw new Error(
        `Storage migration backup destination changed while copying ${source.relativePath}`,
      );
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close();
  }
}

async function copyLegacySnapshot(
  sourceRoot: string,
  temporaryRoot: string,
  snapshot: LegacyTreeSnapshot,
): Promise<void> {
  await mkdir(temporaryRoot, { mode: 0o700 });
  for (const entry of snapshot.entries) {
    if (entry.kind !== "directory") continue;
    assertLegacyDirectoryMetadata(
      await lstat(entry.path, { bigint: true }),
      entry,
      "before backup copy",
    );
    await mkdir(join(temporaryRoot, ...entry.relativePath.split("/")), { mode: 0o700 });
  }
  for (const file of snapshot.files)
    await copyLegacySnapshotFile(file, join(temporaryRoot, ...file.relativePath.split("/")));

  const sourceAfterCopy = await captureLegacyTreeSnapshot(sourceRoot, {
    rejectBackupMarker: true,
    enforceDestinationLimits: true,
  });
  if (!isDeepStrictEqual(legacySnapshotView(sourceAfterCopy), legacySnapshotView(snapshot)))
    throw new Error("Legacy run tree changed during backup copy; no backup was created");

  const copied = await captureLegacyTreeSnapshot(temporaryRoot);
  if (!isDeepStrictEqual(legacySnapshotContents(copied), legacySnapshotContents(snapshot)))
    throw new Error("Storage migration backup digest does not match the preflight snapshot");
}

async function ensureCompleteBackup(
  input: {
    graphcraftRoot: string;
    runRoot: string;
    runId: string;
    sourceVersion: LegacyStorageVersion;
  },
  sourceSnapshot: LegacyTreeSnapshot,
): Promise<string> {
  const verifiedSource = await captureLegacyTreeSnapshot(input.runRoot, {
    rejectBackupMarker: true,
    enforceDestinationLimits: true,
  });
  if (!isDeepStrictEqual(legacySnapshotView(verifiedSource), legacySnapshotView(sourceSnapshot)))
    throw new Error("Legacy run tree changed after migration preflight; no backup was created");
  await ensurePrivateDirectory(input.graphcraftRoot);
  await validatePrivatePath(input.graphcraftRoot, relative(input.graphcraftRoot, input.runRoot));

  const backupBase = join(input.graphcraftRoot, "migration-backups");
  const backupParent = join(backupBase, input.runId);
  await ensurePrivateDirectory(backupBase, input.graphcraftRoot);
  await ensurePrivateDirectory(backupParent, input.graphcraftRoot);

  // Securing the owned backup parents can update inherited Windows ACLs on
  // existing descendants and therefore their ctime. Recapture after that
  // bounded mutation, require every stable metadata/content field to match,
  // and use this exact refreshed snapshot for all copy-time checks.
  const refreshedSource = await captureLegacyTreeSnapshot(input.runRoot, {
    rejectBackupMarker: true,
    enforceDestinationLimits: true,
  });
  assertLegacySnapshotRefreshIsCtimeOnly(
    legacySnapshotRefreshEvidence(sourceSnapshot),
    legacySnapshotRefreshEvidence(refreshedSource),
  );

  const step = `${input.sourceVersion}-to-${CURRENT_RUN_STORAGE_VERSION}`;
  const backupRoot = join(backupParent, step);
  const existing = await status(backupRoot);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory())
      throw new Error(`Storage migration backup target is unsafe: ${backupRoot}`);
    const validated = await validateCompleteBackup(backupRoot, input);
    await validateBackupMatchesLegacyRun({
      runRoot: input.runRoot,
      runId: input.runId,
      marker: validated.marker,
      backupSnapshot: validated.snapshot,
      sourceSnapshot: refreshedSource,
    });
    await hardenPrivateTree(backupRoot, input.graphcraftRoot);
    await syncBackupTree(backupRoot);
    await syncDirectory(backupParent);
    return backupRoot;
  }

  const temporaryRoot = join(backupParent, `.${step}.tmp`);
  const staleTemporary = await status(temporaryRoot);
  if (staleTemporary) {
    if (staleTemporary.isSymbolicLink() || !staleTemporary.isDirectory())
      throw new Error(`Storage migration temporary backup target is unsafe: ${temporaryRoot}`);
    await rm(temporaryRoot, { recursive: true, force: true });
    await syncDirectory(backupParent);
  }

  try {
    await copyLegacySnapshot(input.runRoot, temporaryRoot, refreshedSource);
    await hardenPrivateTree(temporaryRoot, input.graphcraftRoot);
    await syncBackupTree(temporaryRoot);
    const completion: BackupCompletion = {
      schemaVersion: 1,
      kind: "graphcraft_storage_migration_backup",
      runId: input.runId,
      sourceVersion: input.sourceVersion,
      targetVersion: CURRENT_RUN_STORAGE_VERSION,
      treeDigest: refreshedSource.digest,
    };
    const completionPath = join(temporaryRoot, BACKUP_COMPLETION_FILE);
    await writeJsonAtomic(completionPath, completion);
    await hardenPrivateFile(completionPath, temporaryRoot);
    await syncBackupFile(completionPath, await lstat(completionPath));
    await syncDirectory(temporaryRoot);
    await rename(temporaryRoot, backupRoot);
    await syncDirectory(backupParent);
    return backupRoot;
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true })
      .then(async () => await syncDirectory(backupParent))
      .catch(() => undefined);
    throw error;
  }
}

async function validateLegacyRun(runRoot: string, runId: string): Promise<void> {
  await validatePrivatePath(runRoot, "events.jsonl").catch((error) => {
    throw new Error(
      `Legacy run ${runId} cannot migrate because events.jsonl is unsafe: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  await lstat(join(runRoot, "events.jsonl")).catch((error) => {
    throw new Error(
      `Legacy run ${runId} cannot migrate because events.jsonl is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

async function assertMigratedInventoryCurrent(
  artifactStore: RunArtifactStore,
  expected: ArtifactInventory,
): Promise<void> {
  const current = await artifactStore.inventory();
  if (!isDeepStrictEqual(current, expected))
    throw new Error(
      "Storage migration artifact inventory changed after durable migration; refusing manifest publication",
    );
}

export async function ensureCurrentRunStorage(input: {
  graphcraftRoot: string;
  runRoot: string;
  runId: string;
  onBoundary?: (
    boundary: "after_preflight" | "after_backup" | "after_inventory" | "before_manifest",
  ) => Promise<void> | void;
}): Promise<RunStorageManifest> {
  await validateRunStorageRoot(input);
  const initial = await inspectStorage(input.runRoot, input.runId);
  if (initial.version === CURRENT_RUN_STORAGE_VERSION) return initial.manifest;
  await validateLegacyRun(input.runRoot, input.runId);

  const acquisition = await acquireMigrationLock(input);
  if (acquisition.manifest) return acquisition.manifest;
  const migrationLock = acquisition.lock!;
  let runLock: RunLock | undefined;
  try {
    // Storage preparation always precedes ordinary run-lock ownership. Taking
    // the locks in this order lets migration wait out legacy writers without
    // racing their final event append into an incomplete backup.
    runLock = await acquireActiveAwareLock(
      join(input.graphcraftRoot, "locks", `${input.runId}.lock`),
    );
    await validateRunStorageRoot(input);
    const storage = await inspectStorage(input.runRoot, input.runId);
    if (storage.version === CURRENT_RUN_STORAGE_VERSION) return storage.manifest;
    await validateLegacyRun(input.runRoot, input.runId);
    const sourceSnapshot = await assertLegacyTreeRedactionSafe(input.runRoot);
    await input.onBoundary?.("after_preflight");
    const backupInput = {
      graphcraftRoot: input.graphcraftRoot,
      runRoot: input.runRoot,
      runId: input.runId,
      sourceVersion: storage.version,
    };
    await ensureCompleteBackup(backupInput, sourceSnapshot);
    await input.onBoundary?.("after_backup");

    const artifactStore = new RunArtifactStore(input.runRoot, input.runId);
    const migratedInventory = await artifactStore.migrateLegacy();
    await assertMigratedInventoryCurrent(artifactStore, migratedInventory);
    await hardenPrivateTree(input.runRoot, input.graphcraftRoot);
    await input.onBoundary?.("after_inventory");
    await assertMigratedInventoryCurrent(artifactStore, migratedInventory);
    await input.onBoundary?.("before_manifest");
    const prePublicationSnapshot = await assertLegacyTreeRedactionSafe(input.runRoot);
    await ensureCompleteBackup(backupInput, prePublicationSnapshot);
    await assertMigratedInventoryCurrent(artifactStore, migratedInventory);
    return await persistCurrentRunStorageManifest(input.runRoot, input.runId, storage.version);
  } finally {
    try {
      if (runLock) await runLock.release();
    } finally {
      await migrationLock.release();
    }
  }
}
