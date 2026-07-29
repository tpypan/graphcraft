import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  SideEffectKindSchema,
  contentHash,
  type CanonicalHashAlgorithm,
  type SideEffectClaim,
  type SideEffectKind,
} from "@graphcraft/core";
import type {
  ManagedProcessLifecycle,
  ManagedProcessReady,
  ManagedProcessSettlement,
} from "@graphcraft/probes";
import {
  ensurePrivateDirectory,
  finalizePrivateDirectoryMutation,
  hardenPrivateFile,
  preparePrivateDirectoryMutation,
  readPrivateFileBounded,
  validatePrivatePath,
} from "./secure-fs.ts";

const SIDE_EFFECT_PROCESS_JOURNAL_MAX_BYTES = 64 * 1024;
export const SIDE_EFFECT_PROCESS_SETTLEMENT_WAIT_MS = process.platform === "win32" ? 12_000 : 6_000;
const SIDE_EFFECT_PROCESS_REMOVAL_RETRY_MS = 2_000;
const WINDOWS_TRANSIENT_REMOVAL_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const sideEffectProcessRunMutationTails = new Map<string, Promise<void>>();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_ID = /^[a-f0-9]{64}$/;

export interface SideEffectProcessDefinition {
  schemaVersion: 1;
  executionId: string;
  actionId: string;
  nodeId: string;
  kind: SideEffectKind;
}

interface PreparedRecord extends SideEffectProcessDefinition {
  ownerToken: string;
  status: "prepared";
  preparedAt: string;
}

interface BrokerRecord {
  schemaVersion: 1;
  executionId: string;
  ownerToken: string;
  brokerPid: number;
  status: "ready" | "starting" | "started" | "settled";
  childPid?: number | null;
  outcome?: ManagedProcessSettlement["outcome"];
  confirmed?: boolean;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  readyAt?: string;
  startingAt?: string;
  startedAt?: string;
  settledAt?: string;
}

export interface SideEffectProcessLease {
  definition: SideEffectProcessDefinition;
  ownerTokenHash: string;
  journalPath: string;
  journalRelativePath: string;
  handle: FileHandle;
  lifecycle(callbacks: {
    onReady: (ready: ManagedProcessReady) => Promise<void>;
    onSettled: (settlement: ManagedProcessSettlement) => Promise<void>;
  }): ManagedProcessLifecycle;
}

export interface SideEffectProcessJournalInspection {
  prepared: PreparedRecord;
  status: "prepared" | "ready" | "starting" | "started" | "settled";
  brokerPid?: number;
  settlement?: ManagedProcessSettlement;
}

export function createSideEffectProcessDefinition(
  claim: Pick<SideEffectClaim, "actionId" | "nodeId" | "kind">,
): SideEffectProcessDefinition {
  if (!ACTION_ID.test(claim.actionId)) throw new Error("Side-effect process action ID is invalid");
  if (claim.nodeId.length === 0) throw new Error("Side-effect process node ID must not be empty");
  const kind = SideEffectKindSchema.parse(claim.kind);
  return {
    schemaVersion: 1,
    executionId: randomUUID(),
    actionId: claim.actionId,
    nodeId: claim.nodeId,
    kind,
  };
}

export function parseSideEffectProcessDefinition(
  value: unknown,
): SideEffectProcessDefinition | undefined {
  const record = strictObject(value);
  if (
    !record ||
    !exactKeys(record, ["schemaVersion", "executionId", "actionId", "nodeId", "kind"]) ||
    record.schemaVersion !== 1 ||
    typeof record.executionId !== "string" ||
    !UUID_V4.test(record.executionId) ||
    typeof record.actionId !== "string" ||
    !ACTION_ID.test(record.actionId) ||
    typeof record.nodeId !== "string" ||
    record.nodeId.length === 0
  )
    return undefined;
  const kind = SideEffectKindSchema.safeParse(record.kind);
  if (!kind.success) return undefined;
  return {
    schemaVersion: 1,
    executionId: record.executionId,
    actionId: record.actionId,
    nodeId: record.nodeId,
    kind: kind.data,
  };
}

function journalPath(graphcraftRoot: string, runId: string, actionId: string): string {
  return join(graphcraftRoot, "locks", "side-effect-processes", runId, `${actionId}.jsonl`);
}

export async function readSideEffectProcessDefinition(input: {
  graphcraftRoot: string;
  runId: string;
  claim: Pick<SideEffectClaim, "actionId" | "nodeId" | "kind">;
}): Promise<SideEffectProcessDefinition | undefined> {
  if (!ACTION_ID.test(input.claim.actionId))
    throw new Error("Side-effect process action ID is invalid");
  const path = journalPath(input.graphcraftRoot, input.runId, input.claim.actionId);
  let source: Buffer;
  try {
    source = await readPrivateFileBounded(
      path,
      SIDE_EFFECT_PROCESS_JOURNAL_MAX_BYTES,
      input.graphcraftRoot,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const firstLine = source.toString("utf8").split("\n", 1)[0];
  let prepared: PreparedRecord | undefined;
  try {
    prepared = firstLine ? parsePrepared(JSON.parse(firstLine)) : undefined;
  } catch {
    // The ownership error below deliberately excludes private journal content.
  }
  if (
    !prepared ||
    prepared.actionId !== input.claim.actionId ||
    prepared.nodeId !== input.claim.nodeId ||
    prepared.kind !== input.claim.kind
  )
    throw new Error(
      `Side-effect process for ${input.claim.actionId} has ambiguous ownership metadata`,
    );
  return {
    schemaVersion: 1,
    executionId: prepared.executionId,
    actionId: prepared.actionId,
    nodeId: prepared.nodeId,
    kind: prepared.kind,
  };
}

async function withSideEffectProcessRunMutation<T>(
  runRoot: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = sideEffectProcessRunMutationTails.get(runRoot) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => gate);
  sideEffectProcessRunMutationTails.set(runRoot, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (sideEffectProcessRunMutationTails.get(runRoot) === tail)
      sideEffectProcessRunMutationTails.delete(runRoot);
  }
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export async function createSideEffectProcessLease(input: {
  graphcraftRoot: string;
  runId: string;
  definition: SideEffectProcessDefinition;
  hashAlgorithm?: CanonicalHashAlgorithm;
}): Promise<SideEffectProcessLease> {
  const definition = parseSideEffectProcessDefinition(input.definition);
  if (!definition) throw new Error("Side-effect process definition is invalid");
  const root = join(input.graphcraftRoot, "locks", "side-effect-processes", input.runId);
  return await withSideEffectProcessRunMutation(root, async () => {
    await ensurePrivateDirectory(root, input.graphcraftRoot);
    const path = journalPath(input.graphcraftRoot, input.runId, definition.actionId);
    await validatePrivatePath(input.graphcraftRoot, relative(input.graphcraftRoot, path));
    const directoryMutation = await preparePrivateDirectoryMutation(
      dirname(path),
      input.graphcraftRoot,
    );
    const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        path,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_RDWR |
          fsConstants.O_APPEND |
          noFollow,
        0o600,
      );
      const ownerToken = randomUUID();
      const prepared: PreparedRecord = {
        ...definition,
        ownerToken,
        status: "prepared",
        preparedAt: new Date().toISOString(),
      };
      await handle.write(serialized(prepared));
      await handle.sync();
      await hardenPrivateFile(path, input.graphcraftRoot);
      await finalizePrivateDirectoryMutation(directoryMutation, input.graphcraftRoot);
      return {
        definition,
        ownerTokenHash: contentHash(
          ownerToken,
          input.hashAlgorithm ?? LEGACY_CANONICAL_HASH_ALGORITHM,
        ),
        journalPath: path,
        journalRelativePath: relative(input.graphcraftRoot, path).replaceAll("\\", "/"),
        handle,
        lifecycle: ({ onReady, onSettled }) => ({
          executionId: definition.executionId,
          ownerToken,
          journalFd: handle!.fd,
          onReady,
          onSettled,
        }),
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await finalizePrivateDirectoryMutation(directoryMutation, input.graphcraftRoot).catch(
        () => undefined,
      );
      throw error;
    }
  });
}

function strictObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positivePid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function exactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parsePrepared(value: unknown): PreparedRecord | undefined {
  const record = strictObject(value);
  if (
    !record ||
    !exactKeys(record, [
      "schemaVersion",
      "executionId",
      "actionId",
      "nodeId",
      "kind",
      "ownerToken",
      "status",
      "preparedAt",
    ]) ||
    record.ownerToken === undefined ||
    typeof record.ownerToken !== "string" ||
    !UUID_V4.test(record.ownerToken) ||
    record.status !== "prepared" ||
    !validDate(record.preparedAt)
  )
    return undefined;
  const definition = parseSideEffectProcessDefinition({
    schemaVersion: record.schemaVersion,
    executionId: record.executionId,
    actionId: record.actionId,
    nodeId: record.nodeId,
    kind: record.kind,
  });
  if (!definition) return undefined;
  return {
    ...definition,
    ownerToken: record.ownerToken,
    status: "prepared",
    preparedAt: record.preparedAt,
  };
}

function parseBroker(value: unknown): BrokerRecord | undefined {
  const record = strictObject(value);
  if (
    !record ||
    record.schemaVersion !== 1 ||
    typeof record.executionId !== "string" ||
    !UUID_V4.test(record.executionId) ||
    typeof record.ownerToken !== "string" ||
    !UUID_V4.test(record.ownerToken) ||
    !positivePid(record.brokerPid) ||
    !["ready", "starting", "started", "settled"].includes(String(record.status))
  )
    return undefined;
  if (
    (record.status === "ready" &&
      (!exactKeys(record, [
        "schemaVersion",
        "executionId",
        "ownerToken",
        "brokerPid",
        "status",
        "readyAt",
      ]) ||
        !validDate(record.readyAt))) ||
    (record.status === "starting" &&
      (!exactKeys(record, [
        "schemaVersion",
        "executionId",
        "ownerToken",
        "brokerPid",
        "status",
        "startingAt",
      ]) ||
        !validDate(record.startingAt))) ||
    (record.status === "started" &&
      (!exactKeys(record, [
        "schemaVersion",
        "executionId",
        "ownerToken",
        "brokerPid",
        "status",
        "childPid",
        "startedAt",
      ]) ||
        !positivePid(record.childPid) ||
        !validDate(record.startedAt))) ||
    (record.status === "settled" &&
      (!exactKeys(record, [
        "schemaVersion",
        "executionId",
        "ownerToken",
        "brokerPid",
        "status",
        "outcome",
        "confirmed",
        "childPid",
        "exitCode",
        "exitSignal",
        "settledAt",
      ]) ||
        (record.childPid !== null && !positivePid(record.childPid)) ||
        ![
          "exited",
          "terminated",
          "cancelled_before_start",
          "failed_to_start",
          "unconfirmed",
        ].includes(String(record.outcome)) ||
        typeof record.confirmed !== "boolean" ||
        (record.exitCode !== null && !Number.isInteger(record.exitCode)) ||
        (record.exitSignal !== null &&
          (typeof record.exitSignal !== "string" ||
            !Object.prototype.hasOwnProperty.call(osConstants.signals, record.exitSignal))) ||
        !validDate(record.settledAt) ||
        (record.confirmed === true && record.outcome === "unconfirmed") ||
        (record.confirmed === false && record.outcome !== "unconfirmed") ||
        (["exited", "terminated"].includes(String(record.outcome)) &&
          !positivePid(record.childPid)) ||
        (["cancelled_before_start", "failed_to_start"].includes(String(record.outcome)) &&
          (record.childPid !== null || record.exitCode !== null || record.exitSignal !== null))))
  )
    return undefined;
  return record as unknown as BrokerRecord;
}

export async function inspectSideEffectProcessJournal(input: {
  graphcraftRoot: string;
  runId: string;
  definition: SideEffectProcessDefinition;
  ownerTokenHash?: string;
  expectedBrokerPid?: number;
  hashAlgorithm?: CanonicalHashAlgorithm;
}): Promise<SideEffectProcessJournalInspection | undefined> {
  const definition = parseSideEffectProcessDefinition(input.definition);
  if (!definition) throw new Error("Side-effect process definition is invalid");
  const path = journalPath(input.graphcraftRoot, input.runId, definition.actionId);
  let source: Buffer;
  try {
    source = await readPrivateFileBounded(
      path,
      SIDE_EFFECT_PROCESS_JOURNAL_MAX_BYTES,
      input.graphcraftRoot,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const lines = source
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("Side-effect process journal is empty");
  let prepared: PreparedRecord | undefined;
  try {
    prepared = parsePrepared(JSON.parse(lines[0]!));
  } catch {
    // Report malformed content without reflecting private journal bytes.
  }
  if (
    !prepared ||
    prepared.executionId !== definition.executionId ||
    prepared.actionId !== definition.actionId ||
    prepared.nodeId !== definition.nodeId ||
    prepared.kind !== definition.kind ||
    (input.ownerTokenHash !== undefined &&
      contentHash(prepared.ownerToken, input.hashAlgorithm ?? LEGACY_CANONICAL_HASH_ALGORITHM) !==
        input.ownerTokenHash)
  )
    throw new Error(
      `Side-effect process ${definition.executionId} has ambiguous ownership metadata`,
    );

  let previous: BrokerRecord["status"] | "prepared" = "prepared";
  let brokerPid: number | undefined;
  let settlement: ManagedProcessSettlement | undefined;
  for (const line of lines.slice(1)) {
    let record: BrokerRecord | undefined;
    try {
      record = parseBroker(JSON.parse(line));
    } catch {
      // The invalid chain error below is intentionally content-free.
    }
    if (
      !record ||
      record.executionId !== prepared.executionId ||
      record.ownerToken !== prepared.ownerToken ||
      (brokerPid !== undefined && record.brokerPid !== brokerPid)
    )
      throw new Error(`Side-effect process ${definition.executionId} has an invalid journal chain`);
    brokerPid ??= record.brokerPid;
    const allowed =
      (previous === "prepared" && record.status === "ready") ||
      (previous === "ready" && ["starting", "settled"].includes(record.status)) ||
      (previous === "starting" && ["started", "settled"].includes(record.status)) ||
      (previous === "started" && record.status === "settled");
    if (!allowed)
      throw new Error(`Side-effect process ${definition.executionId} has an invalid journal order`);
    previous = record.status;
    if (record.status === "settled") {
      settlement = {
        schemaVersion: 1,
        executionId: prepared.executionId,
        brokerPid: record.brokerPid,
        childPid: positivePid(record.childPid) ? record.childPid : null,
        outcome: record.outcome as ManagedProcessSettlement["outcome"],
        confirmed: record.confirmed as boolean,
        exitCode: Number.isInteger(record.exitCode) ? (record.exitCode as number) : null,
        exitSignal: typeof record.exitSignal === "string" ? record.exitSignal : null,
        settledAt: record.settledAt as string,
      };
    }
  }
  if (input.expectedBrokerPid !== undefined && brokerPid !== input.expectedBrokerPid)
    throw new Error(`Side-effect process ${definition.executionId} broker identity is ambiguous`);
  return {
    prepared,
    status: previous,
    ...(brokerPid ? { brokerPid } : {}),
    ...(settlement ? { settlement } : {}),
  };
}

export async function waitForSideEffectProcessSettlement(
  input: Parameters<typeof inspectSideEffectProcessJournal>[0],
  timeoutMs = SIDE_EFFECT_PROCESS_SETTLEMENT_WAIT_MS,
): Promise<SideEffectProcessJournalInspection | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const inspected = await inspectSideEffectProcessJournal(input);
      if (!inspected || inspected.settlement) return inspected;
      if (Date.now() >= deadline) return inspected;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Private file changed during its bounded read" ||
        Date.now() >= deadline
      )
        throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

export async function closeSideEffectProcessLease(lease: SideEffectProcessLease): Promise<void> {
  await lease.handle.close();
}

async function retryWindowsRemoval(
  action: () => Promise<void>,
  ignoredErrors: ReadonlySet<string>,
): Promise<void> {
  const deadline = Date.now() + SIDE_EFFECT_PROCESS_REMOVAL_RETRY_MS;
  let delayMs = 5;
  while (true) {
    try {
      await action();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (ignoredErrors.has(code)) return;
      if (
        process.platform !== "win32" ||
        !WINDOWS_TRANSIENT_REMOVAL_ERRORS.has(code) ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(100, delayMs * 2);
    }
  }
}

export async function removeSideEffectProcessJournal(input: {
  graphcraftRoot: string;
  runId: string;
  actionId: string;
}): Promise<void> {
  if (!ACTION_ID.test(input.actionId)) throw new Error("Side-effect process action ID is invalid");
  const runRoot = join(input.graphcraftRoot, "locks", "side-effect-processes", input.runId);
  const path = journalPath(input.graphcraftRoot, input.runId, input.actionId);
  await withSideEffectProcessRunMutation(runRoot, async () => {
    const mutation = await preparePrivateDirectoryMutation(dirname(path), input.graphcraftRoot);
    try {
      await retryWindowsRemoval(
        async () => {
          await validatePrivatePath(input.graphcraftRoot, relative(input.graphcraftRoot, path));
          await unlink(path);
        },
        new Set(["ENOENT"]),
      );
    } finally {
      await finalizePrivateDirectoryMutation(mutation, input.graphcraftRoot);
    }

    const parentMutation = await preparePrivateDirectoryMutation(
      dirname(runRoot),
      input.graphcraftRoot,
    );
    try {
      await retryWindowsRemoval(
        async () => await rmdir(runRoot),
        new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]),
      );
    } finally {
      await finalizePrivateDirectoryMutation(parentMutation, input.graphcraftRoot);
    }
  });
}
