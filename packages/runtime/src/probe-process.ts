import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, join, relative } from "node:path";
import { contentHash, type ProbeSpec, type RunEvent } from "@graphcraft/core";
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

const PROBE_PROCESS_JOURNAL_MAX_BYTES = 64 * 1024;
export const PROBE_PROCESS_SETTLEMENT_WAIT_MS = 6_000;
const PROBE_PROCESS_REMOVAL_RETRY_MS = 2_000;
const WINDOWS_TRANSIENT_REMOVAL_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const probeProcessRunMutationTails = new Map<string, Promise<void>>();

export type ProbeScopeStage = "progress_baseline" | "progress_current" | "verification";

export interface ProbeProcessDefinition {
  schemaVersion: 1;
  executionId: string;
  probeId: string;
  commandHash: string;
}

interface PreparedRecord {
  schemaVersion: 1;
  executionId: string;
  ownerToken: string;
  status: "prepared";
  checkpointId: string;
  nodeId: string;
  stage: ProbeScopeStage;
  probeId: string;
  commandHash: string;
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

export interface ProbeProcessLease {
  definition: ProbeProcessDefinition;
  ownerTokenHash: string;
  journalPath: string;
  journalRelativePath: string;
  handle: FileHandle;
  lifecycle(callbacks: {
    onReady: (ready: ManagedProcessReady) => Promise<void>;
    onSettled: (settlement: ManagedProcessSettlement) => Promise<void>;
  }): ManagedProcessLifecycle;
}

export interface ProbeProcessJournalInspection {
  prepared: PreparedRecord;
  brokerPid?: number;
  settlement?: ManagedProcessSettlement;
}

function commandHash(probe: Extract<ProbeSpec, { kind: "command" }>): string {
  return contentHash({
    schemaVersion: 1,
    command: probe.command,
    args: probe.args,
    cwd: probe.cwd ?? ".",
    expectedExitCode: probe.expectedExitCode,
    timeoutMs: probe.timeoutMs,
  });
}

export function probeProcessDefinitions(
  checkpointId: string,
  probes: readonly ProbeSpec[],
): ProbeProcessDefinition[] {
  return probes.flatMap((probe, index) => {
    if (probe.kind !== "command") return [];
    const digest = commandHash(probe);
    return [
      {
        schemaVersion: 1 as const,
        executionId: contentHash({
          schemaVersion: 1,
          kind: "probe_process",
          checkpointId,
          probeId: probe.id,
          index,
          commandHash: digest,
        }),
        probeId: probe.id,
        commandHash: digest,
      },
    ];
  });
}

export function parseProbeProcessDefinitions(value: unknown): ProbeProcessDefinition[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const definitions: ProbeProcessDefinition[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    const candidate = item as Partial<ProbeProcessDefinition>;
    if (
      !exactKeys(record, ["schemaVersion", "executionId", "probeId", "commandHash"]) ||
      candidate.schemaVersion !== 1 ||
      typeof candidate.executionId !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.executionId) ||
      typeof candidate.probeId !== "string" ||
      candidate.probeId.length === 0 ||
      typeof candidate.commandHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.commandHash)
    )
      return undefined;
    definitions.push(candidate as ProbeProcessDefinition);
  }
  if (
    new Set(definitions.map(({ executionId }) => executionId)).size !== definitions.length ||
    new Set(definitions.map(({ probeId }) => probeId)).size !== definitions.length
  )
    return undefined;
  return definitions;
}

export function probeProcessLifecycleExecutionId(event: RunEvent): string | undefined {
  if (event.type === "probe.process.started") {
    const definition = event.data.definition;
    if (definition === null || typeof definition !== "object" || Array.isArray(definition))
      return undefined;
    const executionId = (definition as { executionId?: unknown }).executionId;
    return typeof executionId === "string" ? executionId : undefined;
  }
  return typeof event.data.executionId === "string" ? event.data.executionId : undefined;
}

export function probeProcessEventSettlement(input: {
  event: RunEvent;
  type: "probe.process.finished" | "probe.process.reconciled";
  actor: "probe" | "runtime";
  executionId: string;
  nodeId: string;
  stage: ProbeScopeStage;
  checkpointId: string;
  brokerPid?: number;
  started?: boolean;
}): { confirmed: boolean; brokerPid: number; outcome: string } | undefined {
  if (
    input.event.type !== input.type ||
    input.event.actor !== input.actor ||
    input.event.causationId !== input.executionId ||
    input.event.data.schemaVersion !== 1 ||
    input.event.data.executionId !== input.executionId ||
    input.event.data.nodeId !== input.nodeId ||
    input.event.data.stage !== input.stage ||
    input.event.data.checkpointId !== input.checkpointId ||
    (input.started !== undefined && input.event.data.started !== input.started)
  )
    return undefined;
  const settlement = input.event.data.settlement;
  if (settlement === null || typeof settlement !== "object" || Array.isArray(settlement))
    return undefined;
  const candidate = settlement as Record<string, unknown>;
  if (
    !exactKeys(candidate, [
      "schemaVersion",
      "executionId",
      "brokerPid",
      "childPid",
      "outcome",
      "confirmed",
      "exitCode",
      "exitSignal",
      "settledAt",
    ]) ||
    candidate.schemaVersion !== 1 ||
    candidate.executionId !== input.executionId ||
    !Number.isSafeInteger(candidate.brokerPid) ||
    Number(candidate.brokerPid) <= 0 ||
    (input.brokerPid !== undefined && candidate.brokerPid !== input.brokerPid) ||
    (candidate.childPid !== null &&
      (!Number.isSafeInteger(candidate.childPid) || Number(candidate.childPid) <= 0)) ||
    typeof candidate.confirmed !== "boolean" ||
    !["exited", "terminated", "cancelled_before_start", "failed_to_start", "unconfirmed"].includes(
      String(candidate.outcome),
    ) ||
    (candidate.exitCode !== null && !Number.isInteger(candidate.exitCode)) ||
    (candidate.exitSignal !== null &&
      (typeof candidate.exitSignal !== "string" ||
        !Object.prototype.hasOwnProperty.call(osConstants.signals, candidate.exitSignal))) ||
    typeof candidate.settledAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.settledAt)) ||
    (candidate.confirmed === true && candidate.outcome === "unconfirmed") ||
    (candidate.confirmed === false && candidate.outcome !== "unconfirmed") ||
    (["exited", "terminated"].includes(String(candidate.outcome)) &&
      (!Number.isSafeInteger(candidate.childPid) || Number(candidate.childPid) <= 0)) ||
    (["cancelled_before_start", "failed_to_start"].includes(String(candidate.outcome)) &&
      (candidate.childPid !== null || candidate.exitCode !== null || candidate.exitSignal !== null))
  )
    return undefined;
  return {
    confirmed: candidate.confirmed,
    brokerPid: Number(candidate.brokerPid),
    outcome: String(candidate.outcome),
  };
}

function journalPath(graphcraftRoot: string, runId: string, executionId: string): string {
  return join(graphcraftRoot, "locks", "probe-processes", runId, `${executionId}.jsonl`);
}

async function withProbeProcessRunMutation<T>(
  runRoot: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = probeProcessRunMutationTails.get(runRoot) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => gate);
  probeProcessRunMutationTails.set(runRoot, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (probeProcessRunMutationTails.get(runRoot) === tail)
      probeProcessRunMutationTails.delete(runRoot);
  }
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export async function createProbeProcessLease(input: {
  graphcraftRoot: string;
  runId: string;
  checkpointId: string;
  nodeId: string;
  stage: ProbeScopeStage;
  definition: ProbeProcessDefinition;
}): Promise<ProbeProcessLease> {
  const root = join(input.graphcraftRoot, "locks", "probe-processes", input.runId);
  return await withProbeProcessRunMutation(root, async () => {
    await ensurePrivateDirectory(root, input.graphcraftRoot);
    const path = journalPath(input.graphcraftRoot, input.runId, input.definition.executionId);
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
        schemaVersion: 1,
        executionId: input.definition.executionId,
        ownerToken,
        status: "prepared",
        checkpointId: input.checkpointId,
        nodeId: input.nodeId,
        stage: input.stage,
        probeId: input.definition.probeId,
        commandHash: input.definition.commandHash,
        preparedAt: new Date().toISOString(),
      };
      await handle.write(serialized(prepared));
      await handle.sync();
      await hardenPrivateFile(path, input.graphcraftRoot);
      await finalizePrivateDirectoryMutation(directoryMutation, input.graphcraftRoot);
      return {
        definition: input.definition,
        ownerTokenHash: contentHash(ownerToken),
        journalPath: path,
        journalRelativePath: relative(input.graphcraftRoot, path).replaceAll("\\", "/"),
        handle,
        lifecycle: ({ onReady, onSettled }) => ({
          executionId: input.definition.executionId,
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
      "ownerToken",
      "status",
      "checkpointId",
      "nodeId",
      "stage",
      "probeId",
      "commandHash",
      "preparedAt",
    ]) ||
    record.schemaVersion !== 1 ||
    typeof record.executionId !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.executionId) ||
    typeof record.ownerToken !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.ownerToken,
    ) ||
    record.status !== "prepared" ||
    typeof record.checkpointId !== "string" ||
    record.checkpointId.length === 0 ||
    typeof record.nodeId !== "string" ||
    record.nodeId.length === 0 ||
    !["progress_baseline", "progress_current", "verification"].includes(String(record.stage)) ||
    typeof record.probeId !== "string" ||
    record.probeId.length === 0 ||
    typeof record.commandHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.commandHash) ||
    typeof record.preparedAt !== "string" ||
    !Number.isFinite(Date.parse(record.preparedAt))
  )
    return undefined;
  return record as unknown as PreparedRecord;
}

function parseBroker(value: unknown): BrokerRecord | undefined {
  const record = strictObject(value);
  if (
    !record ||
    record.schemaVersion !== 1 ||
    typeof record.executionId !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.executionId) ||
    typeof record.ownerToken !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.ownerToken,
    ) ||
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

export async function inspectProbeProcessJournal(input: {
  graphcraftRoot: string;
  runId: string;
  definition: ProbeProcessDefinition;
  checkpointId: string;
  nodeId: string;
  stage: ProbeScopeStage;
  ownerTokenHash?: string;
  expectedBrokerPid?: number;
}): Promise<ProbeProcessJournalInspection | undefined> {
  const path = journalPath(input.graphcraftRoot, input.runId, input.definition.executionId);
  let source: Buffer;
  try {
    source = await readPrivateFileBounded(
      path,
      PROBE_PROCESS_JOURNAL_MAX_BYTES,
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
  if (lines.length === 0) throw new Error("Probe process journal is empty");
  const prepared = parsePrepared(JSON.parse(lines[0]!));
  if (
    !prepared ||
    prepared.executionId !== input.definition.executionId ||
    prepared.checkpointId !== input.checkpointId ||
    prepared.nodeId !== input.nodeId ||
    prepared.stage !== input.stage ||
    prepared.probeId !== input.definition.probeId ||
    prepared.commandHash !== input.definition.commandHash ||
    (input.ownerTokenHash !== undefined &&
      contentHash(prepared.ownerToken) !== input.ownerTokenHash)
  )
    throw new Error(
      `Probe process ${input.definition.executionId} has ambiguous ownership metadata`,
    );

  let previous: BrokerRecord["status"] | "prepared" = "prepared";
  let brokerPid: number | undefined;
  let settlement: ManagedProcessSettlement | undefined;
  for (const line of lines.slice(1)) {
    const record = parseBroker(JSON.parse(line));
    if (
      !record ||
      record.executionId !== prepared.executionId ||
      record.ownerToken !== prepared.ownerToken ||
      (brokerPid !== undefined && record.brokerPid !== brokerPid)
    )
      throw new Error(`Probe process ${input.definition.executionId} has an invalid journal chain`);
    brokerPid ??= record.brokerPid;
    const allowed =
      (previous === "prepared" && record.status === "ready") ||
      (previous === "ready" && ["starting", "settled"].includes(record.status)) ||
      (previous === "starting" && ["started", "settled"].includes(record.status)) ||
      (previous === "started" && record.status === "settled");
    if (!allowed)
      throw new Error(`Probe process ${input.definition.executionId} has an invalid journal order`);
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
    throw new Error(`Probe process ${input.definition.executionId} broker identity is ambiguous`);
  return { prepared, ...(brokerPid ? { brokerPid } : {}), ...(settlement ? { settlement } : {}) };
}

export async function waitForProbeProcessSettlement(
  input: Parameters<typeof inspectProbeProcessJournal>[0],
  timeoutMs = PROBE_PROCESS_SETTLEMENT_WAIT_MS,
): Promise<ProbeProcessJournalInspection | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const inspected = await inspectProbeProcessJournal(input);
    if (!inspected || inspected.settlement) return inspected;
    if (Date.now() >= deadline) return inspected;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

export async function closeProbeProcessLease(lease: ProbeProcessLease): Promise<void> {
  await lease.handle.close();
}

async function retryWindowsRemoval(
  action: () => Promise<void>,
  ignoredErrors: ReadonlySet<string>,
): Promise<void> {
  const deadline = Date.now() + PROBE_PROCESS_REMOVAL_RETRY_MS;
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

export async function removeProbeProcessJournal(input: {
  graphcraftRoot: string;
  runId: string;
  executionId: string;
}): Promise<void> {
  const runRoot = join(input.graphcraftRoot, "locks", "probe-processes", input.runId);
  const path = journalPath(input.graphcraftRoot, input.runId, input.executionId);
  await withProbeProcessRunMutation(runRoot, async () => {
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
