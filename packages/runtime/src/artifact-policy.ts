import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ArtifactInventorySchema,
  ArtifactMutationJournalSchema,
  ArtifactPolicySchema,
  HostEventSchema,
  MAX_ARTIFACT_INVENTORY_BYTES,
  artifactInventorySerializedBytes,
  artifactPathCanonicalKey,
  contentHash,
  type ArtifactFormat,
  type ArtifactInventory,
  type ArtifactInventoryEntry,
  type ArtifactInventoryReason,
  type ArtifactKind,
  type ArtifactMutationJournal,
  type HostEvent,
} from "@graphcraft/core";
import { redactTextBytes, redactValue } from "./redaction.ts";
import { replacePathAtomic, syncDirectory, type AtomicFilePublication } from "./json.ts";
import { RunLock } from "./lock.ts";
import {
  ensurePrivateDirectory,
  finalizePrivateDirectoryMutation,
  hardenPrivateTree,
  preparePrivateDirectoryMutation,
  publishPrivateFileAtomic,
  readPrivateFileBounded,
  validatePrivatePath,
} from "./secure-fs.ts";

const MIB = 1024 * 1024;
const ATOMIC_STAGING_DIRECTORY = ".artifact-staging";
const MUTATION_JOURNAL_PATH = "artifact-mutation.json";
const MUTATION_PAYLOAD_PATH = "artifact-mutation.payload";

export const DEFAULT_ARTIFACT_POLICY = Object.freeze({
  ordinaryArtifactBytes: MIB,
  identityArtifactBytes: MIB,
  capsuleBytes: MIB,
  invocationTranscriptBytes: 8 * MIB,
  invocationReservedBytes: 2 * MIB,
  runArtifactBytes: 64 * MIB,
  runReservedBytes: 8 * MIB,
});

export type ArtifactPolicy = ArtifactInventory["policy"];

export interface ArtifactWriteResult {
  path: string;
  stored: boolean;
  truncated: boolean;
  sourceBytes: number;
  storedBytes: number;
}

export interface IdentityArtifactWriteResult extends ArtifactWriteResult {
  reused: boolean;
}

export interface ArtifactPreview {
  bytes: Buffer;
  originalBytes: number;
  truncated: boolean;
}

export type ArtifactPublicationBoundary =
  "after_payload" | "after_journal" | "after_target" | "after_inventory";

export interface ArtifactPublicationCheckpoint {
  phase: "publication" | "recovery";
  boundary: ArtifactPublicationBoundary;
  mutationId: string;
  path: string;
  action: ArtifactMutationJournal["action"];
}

export type ArtifactPublicationHook = (
  checkpoint: ArtifactPublicationCheckpoint,
) => void | Promise<void>;

interface ArtifactLeaseContext {
  assertHeld(): void;
  recordFailure(error: unknown): unknown;
  observe<T>(operation: () => T | PromiseLike<T>): Promise<T>;
}

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function now(): string {
  return new Date().toISOString();
}

function bytesHash(bytes: Uint8Array): string {
  return contentHash({ contents: Buffer.from(bytes).toString("base64") });
}

function formatForPath(path: string): ArtifactFormat {
  const extension = posix.extname(path).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".jsonl") return "jsonl";
  if ([".log", ".txt", ".md", ".diff", ".patch"].includes(extension)) return "text";
  return "binary";
}

function validatePortableRelativePath(path: string): string[] {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /^[a-z]:/i.test(path) ||
    path.startsWith("\\\\") ||
    path.includes("\\")
  )
    throw new Error(`Artifact path must be a portable relative path: ${path}`);
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".."))
    throw new Error(`Artifact path contains an unsafe segment: ${path}`);
  return parts;
}

function validateNewRelativePath(path: string): string[] {
  const parts = validatePortableRelativePath(path);
  if (redactTextBytes(path).toString("utf8") !== path)
    throw new Error("Artifact path contains sensitive content and cannot be persisted");
  return parts;
}

function validateNewArtifactPath(path: string): string {
  validateNewRelativePath(path);
  const key = artifactPathCanonicalKey(path);
  if (key === undefined)
    throw new Error("Artifact path must be a normalized portable artifact-owned path");
  return key;
}

function assertNoArtifactPathAlias(inventory: ArtifactInventory, path: string): void {
  const key = artifactPathCanonicalKey(path);
  if (key === undefined)
    throw new Error("Artifact path must be a normalized portable artifact-owned path");
  const alias = inventory.entries.find(
    (entry) => entry.path !== path && artifactPathCanonicalKey(entry.path) === key,
  );
  if (alias) throw new Error("Artifact path aliases an existing portable artifact path");
}

export function validateArtifactInventory(value: unknown): ArtifactInventory {
  return ArtifactInventorySchema.parse(value);
}

function assertRegularPrivateTarget(
  path: string,
  status: {
    isSymbolicLink(): boolean;
    isFile(): boolean;
    nlink: number | bigint;
  },
): void {
  if (status.isSymbolicLink()) throw new Error(`Refusing symbolic-link artifact target: ${path}`);
  if (!status.isFile()) throw new Error(`Artifact target is not a regular file: ${path}`);
  if (typeof status.nlink === "bigint" ? status.nlink > 1n : status.nlink > 1)
    throw new Error(`Refusing multiply-linked artifact target: ${path}`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function targetStatus(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Read and validate an inventory without ever buffering more than its explicit cap. */
export async function readBoundedArtifactInventory(path: string): Promise<ArtifactInventory> {
  const observed = await lstat(path, { bigint: true });
  assertRegularPrivateTarget(path, observed);
  if (observed.size > BigInt(MAX_ARTIFACT_INVENTORY_BYTES))
    throw new Error(
      `Artifact inventory exceeds its ${MAX_ARTIFACT_INVENTORY_BYTES}-byte read limit`,
    );

  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assertRegularPrivateTarget(path, before);
    if (!sameFileSnapshot(observed, before))
      throw new Error("Artifact inventory changed before its bounded read");
    if (before.size > BigInt(MAX_ARTIFACT_INVENTORY_BYTES))
      throw new Error(
        `Artifact inventory exceeds its ${MAX_ARTIFACT_INVENTORY_BYTES}-byte read limit`,
      );

    const expectedBytes = Number(before.size);
    const bytes = Buffer.alloc(expectedBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(before, after) || length !== expectedBytes)
      throw new Error("Artifact inventory changed during its bounded read");

    return validateArtifactInventory(JSON.parse(bytes.subarray(0, length).toString("utf8")));
  } finally {
    await handle.close();
  }
}

async function resolvePrivatePath(
  root: string,
  relativePath: string,
  createParents: boolean,
  lease: ArtifactLeaseContext,
): Promise<string> {
  const parts = validatePortableRelativePath(relativePath);
  lease.assertHeld();
  await ensurePrivateDirectory(root);
  lease.assertHeld();
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    const existing = await targetStatus(directory);
    lease.assertHeld();
    if (!existing) {
      if (!createParents) throw new Error(`Artifact parent does not exist: ${directory}`);
      lease.assertHeld();
      await ensurePrivateDirectory(directory);
      lease.assertHeld();
      continue;
    }
    if (existing.isSymbolicLink())
      throw new Error(`Refusing symbolic-link artifact parent: ${directory}`);
    if (!existing.isDirectory())
      throw new Error(`Artifact parent is not a directory: ${directory}`);
    lease.assertHeld();
    await ensurePrivateDirectory(directory);
    lease.assertHeld();
  }
  const target = join(root, ...parts);
  const existing = await targetStatus(target);
  lease.assertHeld();
  if (existing) assertRegularPrivateTarget(target, existing);
  return target;
}

async function atomicWrite(
  root: string,
  relativePath: string,
  bytes: Uint8Array,
  lease: ArtifactLeaseContext,
): Promise<string> {
  const path = await resolvePrivatePath(root, relativePath, true, lease);
  const stagingRoot = join(root, ATOMIC_STAGING_DIRECTORY);
  lease.assertHeld();
  await ensurePrivateDirectory(stagingRoot, root);
  lease.assertHeld();
  const temporaryPath = join(stagingRoot, `${randomUUID()}.tmp`);
  try {
    lease.assertHeld();
    await publishPrivateFileAtomic({
      path,
      ownedRoot: root,
      sourceDirectory: stagingRoot,
      hardenOnPosix: true,
      publish: async () => {
        const handle = await open(temporaryPath, "wx", 0o600);
        let publication: AtomicFilePublication;
        try {
          await handle.writeFile(bytes);
          await handle.sync();
          const status = await handle.stat({ bigint: true });
          assertRegularPrivateTarget(temporaryPath, status);
          publication = {
            path,
            device: status.dev,
            inode: status.ino,
            birthtimeNs: status.birthtimeNs,
          };
        } finally {
          await handle.close();
        }
        await validatePrivatePath(root, relative(root, path));
        const existing = await targetStatus(path);
        if (existing) assertRegularPrivateTarget(path, existing);
        await replacePathAtomic(temporaryPath, path);
        return publication;
      },
    });
    lease.assertHeld();
    return path;
  } catch (error) {
    const causalError = lease.recordFailure(error);
    try {
      lease.assertHeld();
      const removed = await unlink(temporaryPath).then(
        () => true,
        (unlinkError) => {
          if (isMissing(unlinkError)) return false;
          throw unlinkError;
        },
      );
      lease.assertHeld();
      if (removed) await syncDirectory(stagingRoot);
    } catch {
      // The publication or lease failure remains causal; a fresh holder cleans staging.
    }
    throw causalError;
  }
}

async function cleanupAtomicStaging(root: string, lease: ArtifactLeaseContext): Promise<void> {
  const stagingRoot = join(root, ATOMIC_STAGING_DIRECTORY);
  const existing = await targetStatus(stagingRoot);
  lease.assertHeld();
  if (!existing) return;
  if (existing.isSymbolicLink())
    throw new Error(`Refusing symbolic-link artifact staging directory: ${stagingRoot}`);
  if (!existing.isDirectory())
    throw new Error(`Artifact staging path is not a directory: ${stagingRoot}`);
  lease.assertHeld();
  await ensurePrivateDirectory(stagingRoot, root);
  lease.assertHeld();
  let removedEntry = false;
  const items = await readdir(stagingRoot, { withFileTypes: true });
  items.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const item of items) {
    lease.assertHeld();
    const path = join(stagingRoot, item.name);
    if (!item.isFile() || item.isSymbolicLink())
      throw new Error(`Unsupported entry in artifact staging directory: ${path}`);
    assertRegularPrivateTarget(path, await lstat(path));
    lease.assertHeld();
    const mutation = await preparePrivateDirectoryMutation(stagingRoot, root);
    let bodyFailureWasThrown = false;
    try {
      lease.assertHeld();
      const removed = await unlink(path).then(
        () => true,
        (error) => {
          if (isMissing(error)) return false;
          throw error;
        },
      );
      lease.assertHeld();
      removedEntry ||= removed;
    } catch (error) {
      bodyFailureWasThrown = true;
      throw lease.recordFailure(error);
    } finally {
      try {
        await finalizePrivateDirectoryMutation(mutation, root);
      } catch (error) {
        if (!bodyFailureWasThrown) throw lease.recordFailure(error);
      }
    }
  }
  lease.assertHeld();
  if (removedEntry) {
    await syncDirectory(stagingRoot);
    lease.assertHeld();
  }
  const parent = dirname(stagingRoot);
  lease.assertHeld();
  const mutation = await preparePrivateDirectoryMutation(parent, root);
  let bodyFailureWasThrown = false;
  try {
    lease.assertHeld();
    const removedDirectory = await rmdir(stagingRoot).then(
      () => true,
      (error) => {
        if (isMissing(error)) return false;
        throw error;
      },
    );
    lease.assertHeld();
    if (removedDirectory) {
      await syncDirectory(parent);
      lease.assertHeld();
    }
  } catch (error) {
    bodyFailureWasThrown = true;
    throw lease.recordFailure(error);
  } finally {
    try {
      await finalizePrivateDirectoryMutation(mutation, root);
    } catch (error) {
      if (!bodyFailureWasThrown) throw lease.recordFailure(error);
    }
  }
}

async function removePrivateFile(
  root: string,
  relativePath: string,
  lease: ArtifactLeaseContext,
): Promise<void> {
  const path = await resolvePrivatePath(root, relativePath, false, lease).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  lease.assertHeld();
  if (path) {
    const parent = dirname(path);
    lease.assertHeld();
    const mutation = await preparePrivateDirectoryMutation(parent, root);
    let bodyFailureWasThrown = false;
    try {
      lease.assertHeld();
      const removed = await unlink(path).then(
        () => true,
        (error) => {
          if (isMissing(error)) return false;
          throw error;
        },
      );
      lease.assertHeld();
      if (removed) {
        await syncDirectory(parent);
        lease.assertHeld();
      }
    } catch (error) {
      bodyFailureWasThrown = true;
      throw lease.recordFailure(error);
    } finally {
      try {
        await finalizePrivateDirectoryMutation(mutation, root);
      } catch (error) {
        if (!bodyFailureWasThrown) throw lease.recordFailure(error);
      }
    }
  }
}

function utf8Prefix(bytes: Buffer, limit: number): Buffer {
  let end = Math.min(bytes.length, Math.max(0, limit));
  while (end > 0) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
      return bytes.subarray(0, end);
    } catch {
      end -= 1;
    }
  }
  return Buffer.alloc(0);
}

function jsonEnvelope(source: Buffer, limit: number): Buffer | undefined {
  const sourceText = source.toString("utf8");
  const render = (preview: string): Buffer =>
    Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        graphcraftArtifact: {
          truncated: true,
          sourceBytes: source.length,
          note: "Content omitted by the local artifact policy; see artifact-inventory.json",
        },
        preview,
      })}\n`,
    );
  if (render("").length > limit) return undefined;
  let low = 0;
  let high = sourceText.length;
  let best = render("");
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let preview = sourceText.slice(0, middle);
    if (/\p{Surrogate}$/u.test(preview)) preview = preview.slice(0, -1);
    const candidate = render(preview);
    if (candidate.length <= limit) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function jsonLinesEnvelope(source: Buffer, limit: number): Buffer | undefined {
  const metadata = JSON.stringify({
    type: "graphcraft.truncation",
    sourceBytes: source.length,
    note: "Records omitted by the local artifact policy; see artifact-inventory.json",
  });
  if (Buffer.byteLength(`${metadata}\n`) > limit) return undefined;
  const kept: string[] = [];
  let used = Buffer.byteLength(`${metadata}\n`);
  for (const line of source.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      JSON.parse(line);
    } catch {
      continue;
    }
    const bytes = Buffer.byteLength(`${line}\n`);
    if (used + bytes > limit) break;
    kept.push(line);
    used += bytes;
  }
  return Buffer.from(`${kept.join("\n")}${kept.length > 0 ? "\n" : ""}${metadata}\n`);
}

function truncateArtifact(
  source: Buffer,
  format: ArtifactFormat,
  limit: number,
): Buffer | undefined {
  if (source.length <= limit) return source;
  if (format === "json") return jsonEnvelope(source, limit);
  if (format === "jsonl") return jsonLinesEnvelope(source, limit);
  if (limit <= 0) return undefined;
  return format === "text" ? utf8Prefix(source, limit) : source.subarray(0, limit);
}

function compactHostEvent(event: HostEvent, limit: number): Buffer | undefined {
  const line = (value: HostEvent): Buffer => Buffer.from(`${JSON.stringify(value)}\n`);
  const original = line(event);
  if (original.length <= limit) return original;
  const marker = "[TRUNCATED BY GRAPHCRAFT ARTIFACT POLICY]";
  const candidates: HostEvent[] = [];
  switch (event.type) {
    case "message":
      candidates.push({ type: "message", text: marker });
      break;
    case "tool":
      candidates.push({ type: "tool", name: event.name.slice(0, 256), summary: marker });
      break;
    case "result":
      candidates.push({
        type: "result",
        result: {
          status: event.result.status,
          summary: `${event.result.summary.slice(0, 16_384)}\n${marker}`,
          changedPaths: event.result.changedPaths
            .slice(0, 256)
            .map((value) => value.slice(0, 4_096)),
          evidence: event.result.evidence.slice(0, 64).map((value) => value.slice(0, 4_096)),
          ...(event.result.nextSuggestedObjective
            ? { nextSuggestedObjective: event.result.nextSuggestedObjective.slice(0, 16_384) }
            : {}),
        },
      });
      candidates.push({
        type: "result",
        result: {
          status: event.result.status,
          summary: marker,
          changedPaths: [],
          evidence: [],
        },
      });
      break;
    case "session":
      candidates.push({ type: "session", hostSessionId: event.hostSessionId.slice(0, 4_096) });
      break;
    case "error":
      candidates.push({
        type: "error",
        message: `${event.message.slice(0, 16_384)}\n${marker}`,
        ...(event.cause ? { cause: event.cause } : {}),
      });
      candidates.push({
        type: "error",
        message: marker,
        ...(event.cause ? { cause: event.cause } : {}),
      });
      break;
    case "started":
      candidates.push({ type: "started", invocationId: event.invocationId.slice(0, 4_096) });
      break;
    case "usage":
    case "terminated":
      candidates.push(event);
      break;
  }
  return candidates.map(line).find((candidate) => candidate.length <= limit);
}

interface InvocationRecoveryCheckpoint {
  schemaVersion: 1;
  invocationId: string;
  session?: Extract<HostEvent, { type: "session" }>;
  usage: Array<Extract<HostEvent, { type: "usage" }>>;
  result?: Extract<HostEvent, { type: "result" }>;
  error?: Extract<HostEvent, { type: "error" }>;
  terminated?: Extract<HostEvent, { type: "terminated" }>;
  updatedAt: string;
}

function hostEventOfType<T extends HostEvent["type"]>(
  value: unknown,
  type: T,
): Extract<HostEvent, { type: T }> {
  const event = HostEventSchema.parse(value);
  if (event.type !== type) throw new Error(`Expected invocation ${type} event`);
  return event as Extract<HostEvent, { type: T }>;
}

function recoveryEvents(checkpoint: InvocationRecoveryCheckpoint): HostEvent[] {
  return [
    ...(checkpoint.session ? [checkpoint.session] : []),
    ...checkpoint.usage,
    ...(checkpoint.result ? [checkpoint.result] : []),
    ...(checkpoint.error ? [checkpoint.error] : []),
    ...(checkpoint.terminated ? [checkpoint.terminated] : []),
  ];
}

function assertInvocationEventIdentity(event: HostEvent, expectedInvocationId: string): void {
  if (event.type === "started" && event.invocationId !== expectedInvocationId)
    throw new Error(
      `Invocation started event belongs to ${event.invocationId}, not ${expectedInvocationId}`,
    );
}

function parseRecoveryCheckpoint(
  value: unknown,
  expectedInvocationId: string,
): InvocationRecoveryCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invocation recovery checkpoint is not an object");
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 1 || typeof source.invocationId !== "string")
    throw new Error("Invocation recovery checkpoint has an unsupported schema");
  if (source.invocationId !== expectedInvocationId)
    throw new Error(
      `Invocation recovery checkpoint belongs to ${source.invocationId}, not ${expectedInvocationId}`,
    );
  if (!Array.isArray(source.usage))
    throw new Error("Invocation recovery checkpoint usage is not an array");
  const events = {
    ...(source.session ? { session: hostEventOfType(source.session, "session") } : {}),
    usage: source.usage.map((event) => hostEventOfType(event, "usage")),
    ...(source.result ? { result: hostEventOfType(source.result, "result") } : {}),
    ...(source.error ? { error: hostEventOfType(source.error, "error") } : {}),
    ...(source.terminated ? { terminated: hostEventOfType(source.terminated, "terminated") } : {}),
  };
  if (typeof source.updatedAt !== "string" || !Number.isFinite(Date.parse(source.updatedAt)))
    throw new Error("Invocation recovery checkpoint timestamp is invalid");
  return {
    schemaVersion: 1,
    invocationId: source.invocationId,
    ...events,
    updatedAt: source.updatedAt,
  };
}

function updateRecoveryCheckpoint(
  invocationId: string,
  previous: InvocationRecoveryCheckpoint | undefined,
  event: HostEvent,
): InvocationRecoveryCheckpoint {
  const checkpoint: InvocationRecoveryCheckpoint = previous ?? {
    schemaVersion: 1,
    invocationId,
    usage: [],
    updatedAt: now(),
  };
  switch (event.type) {
    case "session":
      return { ...checkpoint, session: event, updatedAt: now() };
    case "usage":
      return { ...checkpoint, usage: [...checkpoint.usage, event], updatedAt: now() };
    case "result":
      return { ...checkpoint, result: event, updatedAt: now() };
    case "error":
      return { ...checkpoint, error: event, updatedAt: now() };
    case "terminated":
      return { ...checkpoint, terminated: event, updatedAt: now() };
    default:
      return checkpoint;
  }
}

function boundedRecoveryCheckpoint(
  checkpoint: InvocationRecoveryCheckpoint,
  limit: number,
): { source: Buffer; stored: Buffer } {
  const serialize = (value: InvocationRecoveryCheckpoint): Buffer =>
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const source = serialize(checkpoint);
  if (source.length <= limit) return { source, stored: source };

  const compact = (event: HostEvent | undefined, eventLimit: number): HostEvent | undefined => {
    if (!event) return undefined;
    const line = compactHostEvent(event, eventLimit);
    return line ? HostEventSchema.parse(JSON.parse(line.toString("utf8"))) : undefined;
  };
  const session = compact(checkpoint.session, 8 * 1024) as
    Extract<HostEvent, { type: "session" }> | undefined;
  const result = compact(checkpoint.result, Math.max(256, Math.floor(limit / 2))) as
    Extract<HostEvent, { type: "result" }> | undefined;
  const error = compact(checkpoint.error, Math.max(128, Math.floor(limit / 4))) as
    Extract<HostEvent, { type: "error" }> | undefined;
  let candidate: InvocationRecoveryCheckpoint = {
    schemaVersion: 1,
    invocationId: checkpoint.invocationId,
    ...(session ? { session } : {}),
    usage: checkpoint.usage.slice(-1024),
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    ...(checkpoint.terminated ? { terminated: checkpoint.terminated } : {}),
    updatedAt: checkpoint.updatedAt,
  };
  let stored = serialize(candidate);
  while (stored.length > limit && candidate.usage.length > 0) {
    candidate = { ...candidate, usage: candidate.usage.slice(1) };
    stored = serialize(candidate);
  }
  if (stored.length > limit && candidate.result) {
    const minimal = compactHostEvent(candidate.result, 256);
    if (minimal)
      candidate = {
        ...candidate,
        result: hostEventOfType(JSON.parse(minimal.toString("utf8")), "result"),
      };
    else {
      const { result: _result, ...withoutResult } = candidate;
      candidate = withoutResult;
    }
    stored = serialize(candidate);
  }
  if (stored.length > limit)
    throw new Error("Invocation recovery checkpoint cannot fit its reserved artifact capacity");
  return { source, stored };
}

function inventoryTotals(inventory: ArtifactInventory, updatedAt = now()): ArtifactInventory {
  const entries = [...inventory.entries].sort((left, right) => left.path.localeCompare(right.path));
  return validateArtifactInventory({
    ...inventory,
    sourceBytes: entries.reduce((total, entry) => total + entry.sourceBytes, 0),
    storedBytes: entries.reduce((total, entry) => total + entry.storedBytes, 0),
    omittedBytes: entries.reduce((total, entry) => total + entry.omittedBytes, 0),
    entries,
    updatedAt,
  });
}

function emptyInventory(runId: string, policy: ArtifactPolicy): ArtifactInventory {
  return ArtifactInventorySchema.parse({
    schemaVersion: 1,
    runId,
    policy,
    sourceBytes: 0,
    storedBytes: 0,
    omittedBytes: 0,
    entries: [],
    updatedAt: now(),
  });
}

function entryFor(
  path: string,
  kind: ArtifactKind,
  format: ArtifactFormat,
  source: Buffer,
  stored: Buffer | undefined,
  previous: ArtifactInventoryEntry | undefined,
  reason?: ArtifactInventoryReason,
  disposition?: ArtifactInventoryEntry["disposition"],
): ArtifactInventoryEntry {
  const timestamp = now();
  const hasStoredBytes = stored !== undefined;
  return {
    path,
    kind,
    format,
    disposition:
      disposition ??
      (!hasStoredBytes ? "omitted" : stored.length < source.length ? "truncated" : "stored"),
    sourceBytes: source.length,
    storedBytes: stored?.length ?? 0,
    omittedBytes: Math.max(0, source.length - (stored?.length ?? 0)),
    truncated: Boolean(hasStoredBytes && stored.length < source.length),
    legacy: false,
    sourceHash: bytesHash(source),
    ...(hasStoredBytes ? { storedHash: bytesHash(stored) } : {}),
    ...(reason ? { reason } : {}),
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

export class RunArtifactStore {
  readonly inventoryRelativePath = "artifact-inventory.json";
  private readonly mutationLockPath: string;
  private tail: Promise<void> = Promise.resolve();
  private readonly validatedFiles = new Map<string, string>();

  constructor(
    readonly runRoot: string,
    readonly runId: string,
    readonly policy: ArtifactPolicy = DEFAULT_ARTIFACT_POLICY,
    private readonly publicationHook?: ArtifactPublicationHook,
  ) {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid Graphcraft run ID: ${runId}`);
    ArtifactPolicySchema.parse(policy);
    if (policy.invocationReservedBytes >= policy.invocationTranscriptBytes)
      throw new Error("Invocation artifact reserve must be smaller than the transcript limit");
    if (policy.runReservedBytes >= policy.runArtifactBytes)
      throw new Error("Run artifact reserve must be smaller than the run quota");
    if (policy.runReservedBytes < policy.invocationReservedBytes)
      throw new Error("Run artifact reserve must cover the invocation recovery reserve");
    const runParent = dirname(resolve(runRoot));
    const lockRoot = basename(runParent) === "runs" ? dirname(runParent) : runParent;
    this.mutationLockPath = join(lockRoot, "locks", `${runId}.artifacts.lock`);
  }

  private async acquireMutationLock(): Promise<RunLock> {
    while (true) {
      const lock = new RunLock(this.mutationLockPath);
      try {
        await lock.acquire();
        return lock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (!(error instanceof Error) || !error.message.includes("already active")) throw error;
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
  }

  private serializeMutation<T>(operation: (lease: ArtifactLeaseContext) => Promise<T>): Promise<T> {
    const current = this.tail.then(async () => {
      const lock = await this.acquireMutationLock();
      const signal = lock.signal;
      let causalFailure: { error: unknown } | undefined;
      let leaseFailure: { error: unknown } | undefined;
      let cleanupFailure: { error: unknown } | undefined;
      let bodyFailureWasThrown = false;
      let operationStarted = false;
      const rememberCausalFailure = (error: unknown): { error: unknown } =>
        (causalFailure ??= { error });
      const recordLeaseLoss = (): void => {
        leaseFailure ??= { error: signal.reason };
        rememberCausalFailure(leaseFailure.error);
      };
      const lease: ArtifactLeaseContext = {
        assertHeld: () => {
          if (signal.aborted) recordLeaseLoss();
          if (leaseFailure) throw leaseFailure.error;
        },
        recordFailure: (error) => rememberCausalFailure(error).error,
        observe: <T>(operation: () => T | PromiseLike<T>): Promise<T> => {
          try {
            return Promise.resolve(operation()).catch((error) => {
              throw rememberCausalFailure(error).error;
            });
          } catch (error) {
            return Promise.reject(rememberCausalFailure(error).error);
          }
        },
      };
      if (signal.aborted) recordLeaseLoss();
      else signal.addEventListener("abort", recordLeaseLoss, { once: true });
      try {
        lease.assertHeld();
        await cleanupAtomicStaging(this.runRoot, lease);
        lease.assertHeld();
        await this.recoverPendingMutation(lease);
        lease.assertHeld();
        operationStarted = true;
        const result = await operation(lease);
        lease.assertHeld();
        return result;
      } catch (error) {
        bodyFailureWasThrown = true;
        throw rememberCausalFailure(error).error;
      } finally {
        if (operationStarted) {
          try {
            lease.assertHeld();
            await cleanupAtomicStaging(this.runRoot, lease);
            lease.assertHeld();
          } catch (error) {
            cleanupFailure ??= { error };
          }
        }
        try {
          await lock.release();
        } catch (error) {
          cleanupFailure ??= { error };
        }
        signal.removeEventListener("abort", recordLeaseLoss);
        if (!bodyFailureWasThrown) {
          if (causalFailure) throw causalFailure.error;
          if (cleanupFailure) throw cleanupFailure.error;
        }
      }
    });
    this.tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private async persistInventory(
    inventory: ArtifactInventory,
    lease: ArtifactLeaseContext,
  ): Promise<ArtifactInventory> {
    const value = validateArtifactInventory(inventory);
    if (value.runId !== this.runId)
      throw new Error(`Artifact inventory belongs to ${value.runId}, not ${this.runId}`);
    if (artifactInventorySerializedBytes(value) > MAX_ARTIFACT_INVENTORY_BYTES)
      throw new Error("Serialized artifact inventory exceeds its byte limit");
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    lease.assertHeld();
    await atomicWrite(this.runRoot, this.inventoryRelativePath, bytes, lease);
    lease.assertHeld();
    return value;
  }

  private async rawInventory(lease: ArtifactLeaseContext): Promise<ArtifactInventory> {
    const path = await resolvePrivatePath(
      this.runRoot,
      this.inventoryRelativePath,
      false,
      lease,
    ).catch((error) => {
      if (isMissing(error) || String(error).includes("does not exist")) return undefined;
      throw error;
    });
    lease.assertHeld();
    if (!path) return emptyInventory(this.runId, this.policy);
    const parsed = await readBoundedArtifactInventory(path).catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (parsed === undefined) return emptyInventory(this.runId, this.policy);
    if (parsed.runId !== this.runId)
      throw new Error(`Artifact inventory belongs to ${parsed.runId}, not ${this.runId}`);
    return parsed;
  }

  private async readMutationJournal(
    lease: ArtifactLeaseContext,
  ): Promise<ArtifactMutationJournal | undefined> {
    const path = await resolvePrivatePath(this.runRoot, MUTATION_JOURNAL_PATH, false, lease).catch(
      (error) => {
        if (isMissing(error) || String(error).includes("does not exist")) return undefined;
        throw error;
      },
    );
    lease.assertHeld();
    if (!path) return undefined;
    const source = await readPrivateFileBounded(path, 128 * 1024, this.runRoot).catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!source) return undefined;
    const journal = ArtifactMutationJournalSchema.parse(JSON.parse(source.toString("utf8")));
    if (journal.runId !== this.runId)
      throw new Error(`Artifact mutation journal belongs to ${journal.runId}, not ${this.runId}`);
    if (artifactPathCanonicalKey(journal.path) === undefined)
      throw new Error("Artifact mutation journal path is not portable");
    return journal;
  }

  private expectedTarget(
    entry: ArtifactInventoryEntry | undefined,
  ): { bytes: number; hash: string } | undefined {
    if (
      !entry ||
      (entry.storedBytes === 0 && entry.disposition !== "stored" && entry.disposition !== "legacy")
    )
      return undefined;
    if (!entry.storedHash)
      throw new Error(`Artifact inventory entry lacks a stored hash: ${entry.path}`);
    return { bytes: entry.storedBytes, hash: entry.storedHash };
  }

  private assertMutationAction(journal: ArtifactMutationJournal): void {
    const previous = this.expectedTarget(journal.previousEntry);
    const next = this.expectedTarget(journal.nextEntry);
    if (journal.action === "write" && !next)
      throw new Error("Artifact write mutation does not describe stored target bytes");
    if (journal.action === "delete" && (!previous || next))
      throw new Error("Artifact delete mutation does not describe a stored-to-absent transition");
    if (journal.action === "unchanged" && !isDeepStrictEqual(previous, next))
      throw new Error("Artifact metadata mutation changes target bytes without a write action");
  }

  private async readTarget(
    relativePath: string,
    expectedSizes: ReadonlySet<number>,
    lease: ArtifactLeaseContext,
  ): Promise<{ bytes: number; hash?: string } | undefined> {
    const path = await resolvePrivatePath(this.runRoot, relativePath, false, lease).catch(
      (error) => {
        if (isMissing(error) || String(error).includes("does not exist")) return undefined;
        throw error;
      },
    );
    lease.assertHeld();
    if (!path) return undefined;
    const maximumBytes = Math.max(0, ...expectedSizes);
    const contents = await readPrivateFileBounded(path, maximumBytes, this.runRoot).catch(
      (error) => {
        if (isMissing(error)) return undefined;
        throw error;
      },
    );
    if (!contents) return undefined;
    if (!expectedSizes.has(contents.length)) return { bytes: contents.length };
    return { bytes: contents.length, hash: bytesHash(contents) };
  }

  private targetMatches(
    actual: { bytes: number; hash?: string } | undefined,
    entry: ArtifactInventoryEntry | undefined,
  ): boolean {
    const expected = this.expectedTarget(entry);
    return expected
      ? actual?.bytes === expected.bytes && actual.hash === expected.hash
      : actual === undefined;
  }

  private async assertTargetMatches(
    relativePath: string,
    entry: ArtifactInventoryEntry | undefined,
    expectedSizes: ReadonlySet<number>,
    message: string,
    lease: ArtifactLeaseContext,
  ): Promise<void> {
    const target = await this.readTarget(relativePath, expectedSizes, lease);
    if (!this.targetMatches(target, entry)) throw new Error(message);
  }

  private async cleanupMutationFiles(lease: ArtifactLeaseContext): Promise<void> {
    lease.assertHeld();
    await removePrivateFile(this.runRoot, MUTATION_JOURNAL_PATH, lease);
    lease.assertHeld();
    await removePrivateFile(this.runRoot, MUTATION_PAYLOAD_PATH, lease);
    lease.assertHeld();
  }

  private async checkpointMutation(
    journal: ArtifactMutationJournal,
    phase: ArtifactPublicationCheckpoint["phase"],
    boundary: ArtifactPublicationBoundary,
    lease: ArtifactLeaseContext,
  ): Promise<void> {
    lease.assertHeld();
    await lease.observe(() =>
      this.publicationHook?.({
        phase,
        boundary,
        mutationId: journal.mutationId,
        path: journal.path,
        action: journal.action,
      }),
    );
    lease.assertHeld();
  }

  private async recoverPendingMutation(lease: ArtifactLeaseContext): Promise<void> {
    const journal = await this.readMutationJournal(lease);
    lease.assertHeld();
    if (!journal) {
      await removePrivateFile(this.runRoot, MUTATION_PAYLOAD_PATH, lease);
      return;
    }
    this.assertMutationAction(journal);
    const inventory = await this.rawInventory(lease);
    lease.assertHeld();
    const inventoryHash = contentHash(inventory);
    const currentEntry = inventory.entries.find(({ path }) => path === journal.path);
    const currentIsPrevious =
      inventoryHash === journal.previousInventoryHash &&
      isDeepStrictEqual(currentEntry, journal.previousEntry);
    const currentIsNext =
      inventoryHash === journal.nextInventoryHash &&
      isDeepStrictEqual(currentEntry, journal.nextEntry);
    if (!currentIsPrevious && !currentIsNext)
      throw new Error(
        `Artifact mutation ${journal.mutationId} does not match an exact durable inventory snapshot; recovery stopped without changing files`,
      );
    const expectedSizes = new Set(
      [this.expectedTarget(journal.previousEntry), this.expectedTarget(journal.nextEntry)]
        .filter((value): value is { bytes: number; hash: string } => value !== undefined)
        .map(({ bytes }) => bytes),
    );
    const target = await this.readTarget(journal.path, expectedSizes, lease);
    lease.assertHeld();
    if (currentIsNext) {
      if (!this.targetMatches(target, journal.nextEntry))
        throw new Error(
          `Artifact ${journal.path} does not match its completed mutation; recovery stopped without changing files`,
        );
      await this.checkpointMutation(journal, "recovery", "after_journal", lease);
      await this.checkpointMutation(journal, "recovery", "after_target", lease);
      await this.checkpointMutation(journal, "recovery", "after_inventory", lease);
      await this.cleanupMutationFiles(lease);
      return;
    }
    const targetIsPrevious = this.targetMatches(target, journal.previousEntry);
    const targetIsNext = this.targetMatches(target, journal.nextEntry);
    if (!targetIsPrevious && !targetIsNext)
      throw new Error(
        `Artifact ${journal.path} changed after its mutation was journaled; recovery stopped without changing files`,
      );

    const nextInventory = this.replaceEntry(inventory, journal.nextEntry, journal.createdAt);
    if (contentHash(nextInventory) !== journal.nextInventoryHash)
      throw new Error(
        `Artifact mutation ${journal.mutationId} does not reproduce its next inventory snapshot; recovery stopped without changing files`,
      );
    await this.checkpointMutation(journal, "recovery", "after_journal", lease);
    if (journal.action === "write" && !targetIsNext) {
      const payloadPath = await resolvePrivatePath(
        this.runRoot,
        MUTATION_PAYLOAD_PATH,
        false,
        lease,
      );
      const expected = this.expectedTarget(journal.nextEntry);
      if (!expected) throw new Error("Artifact mutation payload has no journaled target bytes");
      const payload = await readPrivateFileBounded(payloadPath, expected.bytes, this.runRoot);
      lease.assertHeld();
      if (payload.length !== expected.bytes)
        throw new Error("Artifact mutation payload size does not match its journal");
      if (bytesHash(payload) !== expected.hash)
        throw new Error("Artifact mutation payload hash does not match its journal");
      await atomicWrite(this.runRoot, journal.path, payload, lease);
    } else if (journal.action === "delete" && !targetIsNext) {
      await removePrivateFile(this.runRoot, journal.path, lease);
    }
    lease.assertHeld();
    await this.checkpointMutation(journal, "recovery", "after_target", lease);
    if (contentHash(await this.rawInventory(lease)) !== journal.previousInventoryHash)
      throw new Error(
        `Artifact mutation ${journal.mutationId} inventory changed during recovery; recovery stopped without changing inventory metadata`,
      );
    await this.assertTargetMatches(
      journal.path,
      journal.nextEntry,
      expectedSizes,
      `Artifact ${journal.path} changed before its inventory was recovered; recovery stopped without cleaning mutation evidence`,
      lease,
    );
    await lease.observe(() => this.persistInventory(nextInventory, lease));
    if (contentHash(await this.rawInventory(lease)) !== journal.nextInventoryHash)
      throw new Error(
        `Artifact mutation ${journal.mutationId} inventory changed while it was recovered; recovery stopped without cleaning mutation evidence`,
      );
    await this.assertTargetMatches(
      journal.path,
      journal.nextEntry,
      expectedSizes,
      `Artifact ${journal.path} changed while its inventory was recovered; recovery stopped without cleaning mutation evidence`,
      lease,
    );
    if (contentHash(await this.rawInventory(lease)) !== journal.nextInventoryHash)
      throw new Error(
        `Artifact mutation ${journal.mutationId} inventory changed after it was recovered; recovery stopped without cleaning mutation evidence`,
      );
    await this.checkpointMutation(journal, "recovery", "after_inventory", lease);
    await this.cleanupMutationFiles(lease);
  }

  async initialize(): Promise<ArtifactInventory> {
    return await this.serializeMutation(async (lease) => {
      lease.assertHeld();
      await ensurePrivateDirectory(this.runRoot);
      lease.assertHeld();
      const inventory = await this.rawInventory(lease);
      lease.assertHeld();
      return await lease.observe(() => this.persistInventory(inventory, lease));
    });
  }

  async inventory(): Promise<ArtifactInventory> {
    return await this.serializeMutation(
      async (lease) => await this.reconcile(await this.rawInventory(lease)),
    );
  }

  async readArtifactPreview(relativePath: string, maxBytes: number): Promise<ArtifactPreview> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MIB)
      throw new Error(`Artifact preview limit must be an integer from 0 through ${MIB}`);
    return await this.serializeMutation(async (lease) => {
      const parts = validatePortableRelativePath(relativePath);
      if (parts[0] !== "artifacts" || parts.length < 2)
        throw new Error("Artifact preview path is not artifact-owned");
      const inventory = await this.rawInventory(lease);
      const entry = inventory.entries.find(({ path }) => path === relativePath);
      const expected = this.expectedTarget(entry);
      if (!entry || !expected)
        throw new Error("Artifact preview is not represented by stored inventory bytes");

      const path = await resolvePrivatePath(this.runRoot, relativePath, false, lease);
      const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink > 1)
          throw new Error("Artifact preview target is not a private regular file");
        if (!Number.isSafeInteger(before.size) || before.size !== expected.bytes)
          throw new Error("Artifact preview size does not match its durable inventory");

        const preview = Buffer.alloc(Math.min(before.size, maxBytes));
        const chunkBuffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, before.size)));
        const digest = createHash("sha256").update('{"contents":"');
        let carry = Buffer.alloc(0);
        let position = 0;
        while (position < before.size) {
          const requested = Math.min(chunkBuffer.length, before.size - position);
          const { bytesRead } = await handle.read(chunkBuffer, 0, requested, position);
          if (bytesRead === 0)
            throw new Error("Artifact preview ended before its durable inventory size");
          const chunk = chunkBuffer.subarray(0, bytesRead);
          if (position < preview.length)
            chunk.copy(preview, position, 0, Math.min(bytesRead, preview.length - position));
          const base64Input = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
          const completeLength = base64Input.length - (base64Input.length % 3);
          if (completeLength > 0)
            digest.update(base64Input.subarray(0, completeLength).toString("base64"));
          carry = Buffer.from(base64Input.subarray(completeLength));
          position += bytesRead;
        }
        digest.update(carry.toString("base64")).update('"}');

        const after = await handle.stat();
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw new Error("Artifact preview changed while it was being verified");
        if (digest.digest("hex") !== expected.hash)
          throw new Error("Artifact preview hash does not match its durable inventory");
        return {
          bytes: preview,
          originalBytes: before.size,
          truncated: before.size > maxBytes,
        };
      } finally {
        await handle.close();
      }
    });
  }

  async migrateLegacy(): Promise<ArtifactInventory> {
    return await this.serializeMutation(async (lease) => {
      const inventory = await this.scanLegacy(emptyInventory(this.runId, this.policy), lease);
      lease.assertHeld();
      await hardenPrivateTree(this.runRoot);
      lease.assertHeld();
      return await lease.observe(() => this.persistInventory(inventory, lease));
    });
  }

  private async scanFiles(rootRelative: "artifacts" | "capsules"): Promise<
    Array<{
      path: string;
      bytes: number;
      modifiedMs: number;
      changedMs: number;
      inode: number;
    }>
  > {
    const root = join(this.runRoot, rootRelative);
    const exists = await targetStatus(root);
    if (!exists) return [];
    if (exists.isSymbolicLink()) throw new Error(`Refusing symbolic-link artifact root: ${root}`);
    if (!exists.isDirectory()) throw new Error(`Artifact root is not a directory: ${root}`);
    const files: Array<{
      path: string;
      bytes: number;
      modifiedMs: number;
      changedMs: number;
      inode: number;
    }> = [];
    const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, item.name);
        const relativePath = `${relativeDirectory}/${item.name}`;
        if (item.isSymbolicLink())
          throw new Error(`Refusing symbolic link in artifact tree: ${absolute}`);
        if (item.isDirectory()) {
          await visit(absolute, relativePath);
          continue;
        }
        if (!item.isFile()) throw new Error(`Unsupported entry in artifact tree: ${absolute}`);
        const metadata = await lstat(absolute);
        assertRegularPrivateTarget(absolute, metadata);
        files.push({
          path: relativePath,
          bytes: metadata.size,
          modifiedMs: metadata.mtimeMs,
          changedMs: metadata.ctimeMs,
          inode: metadata.ino,
        });
      }
    };
    await visit(root, rootRelative);
    return files;
  }

  private async scanLegacy(
    inventory: ArtifactInventory,
    lease: ArtifactLeaseContext,
  ): Promise<ArtifactInventory> {
    const files = [...(await this.scanFiles("artifacts")), ...(await this.scanFiles("capsules"))];
    const legacyLimit = inventory.policy.runArtifactBytes - inventory.policy.runReservedBytes;
    const legacyBytes = files.reduce((total, file) => total + file.bytes, 0);
    if (legacyBytes > legacyLimit)
      throw new Error(
        `Legacy run contains more than the ${legacyLimit}-byte safe artifact migration limit; prune legacy artifacts before retrying`,
      );
    const byPath = new Map(inventory.entries.map((entry) => [entry.path, entry]));
    for (const file of files) {
      lease.assertHeld();
      validateNewArtifactPath(file.path);
      const absolute = await resolvePrivatePath(this.runRoot, file.path, false, lease);
      const contents = await readPrivateFileBounded(absolute, file.bytes, this.runRoot);
      lease.assertHeld();
      if (contents.length !== file.bytes)
        throw new Error(`Artifact ${file.path} changed while its legacy metadata was scanned`);
      const storedHash = bytesHash(contents);
      const previous = byPath.get(file.path);
      if (previous) {
        if (previous.storedBytes === file.bytes && previous.reason !== "missing_on_disk") {
          if (previous.storedHash && previous.storedHash !== storedHash)
            throw new Error(
              `Artifact ${file.path} hash does not match its legacy inventory; no inventory metadata was changed`,
            );
          if (previous.storedHash) continue;
          byPath.set(file.path, { ...previous, storedHash, updatedAt: now() });
          continue;
        }
        const sourceBytes = Math.max(previous.sourceBytes, file.bytes);
        const restored = previous.reason === "missing_on_disk";
        const { reason: _previousReason, ...previousWithoutReason } = previous;
        byPath.set(file.path, {
          ...(restored ? previousWithoutReason : previous),
          storedBytes: file.bytes,
          storedHash,
          omittedBytes: Math.max(0, sourceBytes - file.bytes),
          truncated: file.bytes < sourceBytes,
          disposition:
            previous.legacy && file.bytes === sourceBytes
              ? "legacy"
              : file.bytes < sourceBytes
                ? "truncated"
                : "stored",
          ...(file.bytes === 0 ? { reason: "missing_on_disk" as const } : {}),
          updatedAt: now(),
        });
        continue;
      }
      const timestamp = now();
      byPath.set(file.path, {
        path: file.path,
        kind: file.path.startsWith("capsules/")
          ? "capsule"
          : file.path.startsWith("artifacts/invocations/")
            ? "invocation_transcript"
            : "artifact",
        format: formatForPath(file.path),
        disposition: "legacy",
        sourceBytes: file.bytes,
        storedBytes: file.bytes,
        storedHash,
        omittedBytes: 0,
        truncated: false,
        legacy: true,
        reason: "legacy_migration",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    const actual = new Set(files.map(({ path }) => path));
    for (const [path, previous] of byPath) {
      if (actual.has(path) || ["rejected", "omitted"].includes(previous.disposition)) continue;
      byPath.set(path, {
        ...previous,
        disposition: "omitted",
        storedBytes: 0,
        omittedBytes: previous.sourceBytes,
        truncated: previous.sourceBytes > 0,
        reason: "missing_on_disk",
        updatedAt: now(),
      });
    }
    return inventoryTotals({ ...inventory, entries: [...byPath.values()] });
  }

  private async reconcile(inventory: ArtifactInventory): Promise<ArtifactInventory> {
    const files = [...(await this.scanFiles("artifacts")), ...(await this.scanFiles("capsules"))];
    const entries = new Map(inventory.entries.map((entry) => [entry.path, entry]));
    const actualPaths = new Set(files.map(({ path }) => path));
    for (const file of files) {
      const entry = entries.get(file.path);
      if (!entry)
        throw new Error(
          `Artifact ${file.path} is not represented in the durable inventory; an interrupted or external write must be resolved before continuing`,
        );
      const expected = this.expectedTarget(entry);
      if (!expected || expected.bytes !== file.bytes || entry.disposition === "rejected")
        throw new Error(
          `Artifact ${file.path} does not match its durable inventory; no inventory metadata was changed`,
        );
      const fingerprint = `${file.bytes}:${file.modifiedMs}:${file.changedMs}:${file.inode}:${expected.hash}`;
      if (this.validatedFiles.get(file.path) === fingerprint) continue;
      const absolute = join(this.runRoot, ...validatePortableRelativePath(file.path));
      if (
        bytesHash(await readPrivateFileBounded(absolute, expected.bytes, this.runRoot)) !==
        expected.hash
      )
        throw new Error(
          `Artifact ${file.path} hash does not match its durable inventory; no inventory metadata was changed`,
        );
      this.validatedFiles.set(file.path, fingerprint);
    }
    for (const entry of inventory.entries) {
      if (
        (entry.storedBytes > 0 ||
          entry.disposition === "stored" ||
          entry.disposition === "legacy") &&
        !actualPaths.has(entry.path)
      )
        throw new Error(
          `Artifact ${entry.path} is missing from disk; no inventory metadata was changed`,
        );
    }
    return inventory;
  }

  private replaceEntry(
    inventory: ArtifactInventory,
    entry: ArtifactInventoryEntry,
    updatedAt = now(),
  ): ArtifactInventory {
    return inventoryTotals(
      {
        ...inventory,
        entries: [...inventory.entries.filter(({ path }) => path !== entry.path), entry],
      },
      updatedAt,
    );
  }

  private async publishEntryMutation(
    input: {
      inventory: ArtifactInventory;
      entry: ArtifactInventoryEntry;
      action: ArtifactMutationJournal["action"];
      bytes?: Buffer;
    },
    lease: ArtifactLeaseContext,
  ): Promise<ArtifactInventory> {
    assertNoArtifactPathAlias(input.inventory, input.entry.path);
    const previousEntry = input.inventory.entries.find(({ path }) => path === input.entry.path);
    const mutationTimestamp = now();
    const nextInventory = this.replaceEntry(input.inventory, input.entry, mutationTimestamp);
    const journal = ArtifactMutationJournalSchema.parse({
      schemaVersion: 1,
      runId: this.runId,
      mutationId: randomUUID(),
      action: input.action,
      previousInventoryHash: contentHash(input.inventory),
      nextInventoryHash: contentHash(nextInventory),
      path: input.entry.path,
      ...(previousEntry ? { previousEntry } : {}),
      nextEntry: input.entry,
      createdAt: mutationTimestamp,
    });
    this.assertMutationAction(journal);
    if (input.action === "write") {
      const expected = this.expectedTarget(input.entry);
      if (!input.bytes || !expected || input.bytes.length !== expected.bytes)
        throw new Error("Artifact mutation bytes do not match the inventory entry size");
      if (bytesHash(input.bytes) !== expected.hash)
        throw new Error("Artifact mutation bytes do not match the inventory entry hash");
      await atomicWrite(this.runRoot, MUTATION_PAYLOAD_PATH, input.bytes, lease);
    } else if (input.bytes) {
      throw new Error("Artifact mutation bytes require a write action");
    }
    await this.checkpointMutation(journal, "publication", "after_payload", lease);
    await atomicWrite(
      this.runRoot,
      MUTATION_JOURNAL_PATH,
      Buffer.from(`${JSON.stringify(journal, null, 2)}\n`),
      lease,
    );
    await this.checkpointMutation(journal, "publication", "after_journal", lease);

    if (contentHash(await this.rawInventory(lease)) !== journal.previousInventoryHash)
      throw new Error(
        `Artifact ${input.entry.path} inventory changed while its mutation was being published; recovery stopped without changing files`,
      );

    const expectedSizes = new Set(
      [this.expectedTarget(previousEntry), this.expectedTarget(input.entry)]
        .filter((value): value is { bytes: number; hash: string } => value !== undefined)
        .map(({ bytes }) => bytes),
    );
    const target = await this.readTarget(input.entry.path, expectedSizes, lease);
    if (!this.targetMatches(target, previousEntry))
      throw new Error(
        `Artifact ${input.entry.path} changed while its mutation was being published; recovery stopped without changing files`,
      );
    if (input.action === "write")
      await atomicWrite(this.runRoot, input.entry.path, input.bytes!, lease);
    else if (input.action === "delete")
      await removePrivateFile(this.runRoot, input.entry.path, lease);
    await this.checkpointMutation(journal, "publication", "after_target", lease);
    if (contentHash(await this.rawInventory(lease)) !== journal.previousInventoryHash)
      throw new Error(
        `Artifact ${input.entry.path} inventory changed before its mutation inventory was published; recovery stopped without changing files`,
      );
    await this.assertTargetMatches(
      input.entry.path,
      input.entry,
      expectedSizes,
      `Artifact ${input.entry.path} changed before its mutation inventory was published; recovery stopped without cleaning mutation evidence`,
      lease,
    );
    const persisted = await lease.observe(() => this.persistInventory(nextInventory, lease));
    if (contentHash(await this.rawInventory(lease)) !== journal.nextInventoryHash)
      throw new Error(
        `Artifact mutation ${journal.mutationId} inventory changed while it was published; recovery stopped without cleaning mutation evidence`,
      );
    await this.assertTargetMatches(
      input.entry.path,
      input.entry,
      expectedSizes,
      `Artifact ${input.entry.path} changed while its mutation inventory was published; recovery stopped without cleaning mutation evidence`,
      lease,
    );
    await this.checkpointMutation(journal, "publication", "after_inventory", lease);
    if (contentHash(await this.rawInventory(lease)) !== journal.nextInventoryHash)
      throw new Error(
        `Artifact mutation ${journal.mutationId} inventory changed after it was published; recovery stopped without cleaning mutation evidence`,
      );
    await this.assertTargetMatches(
      input.entry.path,
      input.entry,
      expectedSizes,
      `Artifact ${input.entry.path} changed after its mutation inventory was published; recovery stopped without cleaning mutation evidence`,
      lease,
    );
    if (contentHash(await this.rawInventory(lease)) !== journal.nextInventoryHash)
      throw new Error(
        `Artifact mutation ${journal.mutationId} inventory changed before mutation evidence cleanup; recovery stopped without cleaning mutation evidence`,
      );
    await this.cleanupMutationFiles(lease);
    return persisted;
  }

  async writeArtifact(
    relativePath: string,
    value: string | Uint8Array,
  ): Promise<ArtifactWriteResult> {
    return await this.serializeMutation(async (lease) => {
      validateNewRelativePath(relativePath);
      const inventoryPath = `artifacts/${relativePath}`;
      validateNewArtifactPath(inventoryPath);
      const inventory = await this.reconcile(await this.rawInventory(lease));
      assertNoArtifactPathAlias(inventory, inventoryPath);
      const previous = inventory.entries.find(({ path }) => path === inventoryPath);
      const source = redactTextBytes(value);
      const format = formatForPath(relativePath);
      const baseStored = inventory.storedBytes - (previous?.storedBytes ?? 0);
      const runAvailable = Math.max(
        0,
        inventory.policy.runArtifactBytes - inventory.policy.runReservedBytes - baseStored,
      );
      const limit = Math.min(inventory.policy.ordinaryArtifactBytes, runAvailable);
      const stored = truncateArtifact(source, format, limit);
      const reason: ArtifactInventoryReason | undefined =
        source.length <= limit
          ? undefined
          : runAvailable < inventory.policy.ordinaryArtifactBytes
            ? "run_quota"
            : "artifact_limit";
      const entry = entryFor(inventoryPath, "artifact", format, source, stored, previous, reason);
      await lease.observe(() =>
        this.publishEntryMutation(
          {
            inventory,
            entry,
            action:
              stored !== undefined
                ? "write"
                : this.expectedTarget(previous)
                  ? "delete"
                  : "unchanged",
            ...(stored !== undefined ? { bytes: stored } : {}),
          },
          lease,
        ),
      );
      return {
        path: join(this.runRoot, ...validatePortableRelativePath(inventoryPath)),
        stored: entry.storedBytes > 0,
        truncated: entry.truncated,
        sourceBytes: entry.sourceBytes,
        storedBytes: entry.storedBytes,
      };
    });
  }

  async writeIdentityArtifact(input: {
    relativePath: string;
    value: string | Uint8Array;
    kind: "content_addressed" | "capsule";
  }): Promise<IdentityArtifactWriteResult> {
    return await this.serializeMutation(async (lease) => {
      validateNewArtifactPath(input.relativePath);
      const inventory = await this.reconcile(await this.rawInventory(lease));
      assertNoArtifactPathAlias(inventory, input.relativePath);
      const previous = inventory.entries.find(({ path }) => path === input.relativePath);
      const source = redactTextBytes(input.value);
      const perFileLimit =
        input.kind === "capsule"
          ? inventory.policy.capsuleBytes
          : inventory.policy.identityArtifactBytes;
      const baseStored = inventory.storedBytes - (previous?.storedBytes ?? 0);
      const runAvailable = Math.max(
        0,
        inventory.policy.runArtifactBytes - inventory.policy.runReservedBytes - baseStored,
      );
      const reason: ArtifactInventoryReason | undefined =
        source.length > perFileLimit
          ? "identity_limit"
          : source.length > runAvailable
            ? "run_quota"
            : undefined;
      if (reason) {
        const message = `${input.kind === "capsule" ? "Context capsule" : "Content-addressed artifact"} exceeds the ${reason === "run_quota" ? "run quota" : `${perFileLimit}-byte identity limit`}; identity-bound data is never truncated`;
        if (previous?.storedBytes)
          throw new Error(`${message}; the existing identity artifact was preserved`);
        const rejected = entryFor(
          input.relativePath,
          input.kind,
          formatForPath(input.relativePath),
          source,
          undefined,
          previous,
          reason,
          "rejected",
        );
        await lease.observe(() =>
          this.publishEntryMutation({ inventory, entry: rejected, action: "unchanged" }, lease),
        );
        throw new Error(message);
      }
      const path = await resolvePrivatePath(this.runRoot, input.relativePath, true, lease);
      const existing = await readPrivateFileBounded(path, perFileLimit, this.runRoot).catch(
        (error) => {
          if (isMissing(error)) return undefined;
          throw error;
        },
      );
      if (existing && Buffer.compare(existing, source) !== 0)
        throw new Error(
          `Identity artifact path already contains different bytes: ${input.relativePath}`,
        );
      const entry = entryFor(
        input.relativePath,
        input.kind,
        formatForPath(input.relativePath),
        source,
        source,
        previous,
      );
      await lease.observe(() =>
        this.publishEntryMutation(
          {
            inventory,
            entry,
            action: existing ? "unchanged" : "write",
            ...(!existing ? { bytes: source } : {}),
          },
          lease,
        ),
      );
      return {
        path,
        reused: Boolean(existing),
        stored: true,
        truncated: false,
        sourceBytes: source.length,
        storedBytes: source.length,
      };
    });
  }

  async appendInvocationEvent(
    invocationId: string,
    event: HostEvent,
  ): Promise<ArtifactWriteResult> {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(invocationId))
      throw new Error(`Invalid invocation ID: ${invocationId}`);
    const persistedEvent = HostEventSchema.parse(redactValue(event));
    assertInvocationEventIdentity(persistedEvent, invocationId);
    return await this.serializeMutation(async (lease) => {
      const sourceLine = Buffer.from(`${JSON.stringify(persistedEvent)}\n`);
      const relativePath = `artifacts/invocations/${invocationId}.jsonl`;
      validateNewArtifactPath(relativePath);
      const recovery = ["session", "result", "usage", "error", "terminated"].includes(
        persistedEvent.type,
      );
      let inventory = await this.reconcile(await this.rawInventory(lease));
      const policy = inventory.policy;
      if (recovery) {
        const checkpointPath = `artifacts/invocations/${invocationId}.recovery.json`;
        validateNewArtifactPath(checkpointPath);
        const previousEntry = inventory.entries.find(({ path }) => path === checkpointPath);
        const checkpointAbsolute = await resolvePrivatePath(
          this.runRoot,
          checkpointPath,
          true,
          lease,
        );
        const previousCheckpoint = await readPrivateFileBounded(
          checkpointAbsolute,
          policy.invocationReservedBytes,
          this.runRoot,
        )
          .then((value) =>
            parseRecoveryCheckpoint(JSON.parse(value.toString("utf8")), invocationId),
          )
          .catch((error) => {
            if (isMissing(error)) return undefined;
            throw error;
          });
        const checkpoint = updateRecoveryCheckpoint(
          invocationId,
          previousCheckpoint,
          persistedEvent,
        );
        const bounded = boundedRecoveryCheckpoint(checkpoint, policy.invocationReservedBytes);
        const baseStored = inventory.storedBytes - (previousEntry?.storedBytes ?? 0);
        if (bounded.stored.length > policy.runArtifactBytes - baseStored)
          throw new Error("Run artifact quota cannot preserve invocation recovery state");
        const checkpointEntry = entryFor(
          checkpointPath,
          "invocation_recovery",
          "json",
          bounded.source,
          bounded.stored,
          previousEntry,
          bounded.source.length > bounded.stored.length ? "artifact_limit" : undefined,
        );
        inventory = await lease.observe(() =>
          this.publishEntryMutation(
            {
              inventory,
              entry: checkpointEntry,
              action: "write",
              bytes: bounded.stored,
            },
            lease,
          ),
        );
      }
      const previous = inventory.entries.find(({ path }) => path === relativePath);
      const path = await resolvePrivatePath(this.runRoot, relativePath, true, lease);
      const existing = await readPrivateFileBounded(
        path,
        policy.invocationTranscriptBytes,
        this.runRoot,
      ).catch((error) => {
        if (isMissing(error)) return Buffer.alloc(0);
        throw error;
      });
      const transcriptLimit = recovery
        ? policy.invocationTranscriptBytes
        : policy.invocationTranscriptBytes - policy.invocationReservedBytes;
      const runLimit = recovery
        ? policy.runArtifactBytes
        : policy.runArtifactBytes - policy.runReservedBytes;
      const baseStored = inventory.storedBytes - (previous?.storedBytes ?? 0);
      const available = Math.max(
        0,
        Math.min(transcriptLimit - existing.length, runLimit - baseStored - existing.length),
      );
      const storedLine = compactHostEvent(persistedEvent, available);
      const stored = storedLine ? Buffer.concat([existing, storedLine]) : existing;
      const timestamp = now();
      const sourceBytes = (previous?.sourceBytes ?? existing.length) + sourceLine.length;
      const omittedBytes = Math.max(0, sourceBytes - stored.length);
      const newlyOmittedBytes = Math.max(0, sourceLine.length - (storedLine?.length ?? 0));
      const reason: ArtifactInventoryReason | undefined =
        omittedBytes === 0
          ? undefined
          : newlyOmittedBytes === 0 && previous?.reason
            ? previous.reason
            : baseStored + existing.length >= runLimit
              ? "run_quota"
              : recovery
                ? "artifact_limit"
                : "transcript_reserve";
      const entry: ArtifactInventoryEntry = {
        path: relativePath,
        kind: "invocation_transcript",
        format: "jsonl",
        disposition: stored.length === 0 ? "omitted" : omittedBytes > 0 ? "truncated" : "stored",
        sourceBytes,
        storedBytes: stored.length,
        omittedBytes,
        truncated: omittedBytes > 0,
        legacy: false,
        storedHash: bytesHash(stored),
        ...(reason ? { reason } : {}),
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      await lease.observe(() =>
        this.publishEntryMutation(
          {
            inventory,
            entry,
            action: storedLine ? "write" : "unchanged",
            ...(storedLine ? { bytes: stored } : {}),
          },
          lease,
        ),
      );
      return {
        path,
        stored: storedLine !== undefined,
        truncated: omittedBytes > 0,
        sourceBytes,
        storedBytes: stored.length,
      };
    });
  }

  async loadInvocationEvents(invocationId: string): Promise<HostEvent[]> {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(invocationId))
      throw new Error(`Invalid invocation ID: ${invocationId}`);
    return await this.serializeMutation(async (lease) => {
      const inventory = await this.reconcile(await this.rawInventory(lease));
      const transcriptPath = `artifacts/invocations/${invocationId}.jsonl`;
      const checkpointPath = `artifacts/invocations/${invocationId}.recovery.json`;
      const transcript = await resolvePrivatePath(this.runRoot, transcriptPath, false, lease)
        .then(async (path) =>
          (
            await readPrivateFileBounded(
              path,
              inventory.policy.invocationTranscriptBytes,
              this.runRoot,
            )
          ).toString("utf8"),
        )
        .then((content) =>
          content
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const event = HostEventSchema.parse(JSON.parse(line));
              assertInvocationEventIdentity(event, invocationId);
              return event;
            }),
        )
        .catch((error) => {
          if (isMissing(error) || String(error).includes("does not exist"))
            return [] as HostEvent[];
          throw error;
        });
      const checkpoint = await resolvePrivatePath(this.runRoot, checkpointPath, false, lease)
        .then(async (path) =>
          parseRecoveryCheckpoint(
            JSON.parse(
              (
                await readPrivateFileBounded(
                  path,
                  inventory.policy.invocationReservedBytes,
                  this.runRoot,
                )
              ).toString("utf8"),
            ),
            invocationId,
          ),
        )
        .catch((error) => {
          if (isMissing(error) || String(error).includes("does not exist")) return undefined;
          throw error;
        });
      if (!checkpoint) return transcript;

      const merged = [...transcript];
      const counts = new Map<string, number>();
      for (const item of transcript) {
        const key = JSON.stringify(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      for (const item of recoveryEvents(checkpoint)) {
        const key = JSON.stringify(item);
        const remaining = counts.get(key) ?? 0;
        if (remaining > 0) {
          counts.set(key, remaining - 1);
          continue;
        }
        merged.push(item);
      }
      return merged;
    });
  }
}
