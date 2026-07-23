import { lstat, readdir, rm, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  RunEventSchema,
  RunStateSchema,
  contentHash,
  reduceEvents,
  verifyRunEvent,
  type RunState,
} from "@graphcraft/core";
import { syncDirectory, writeJsonAtomic } from "./json.ts";
import { RunLock } from "./lock.ts";
import { redactString } from "./redaction.ts";
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  readPrivateFileBounded,
  validatePrivatePath,
} from "./secure-fs.ts";
import {
  RUN_EVENT_LOG_MAX_BYTES,
  RUN_EVENT_MAX_BYTES,
  RUN_STATE_MAX_BYTES,
  listRunIds,
  resolveRunId,
} from "./store.ts";
import { inspectSupervisorRecord, listSupervisorRecords } from "./supervisor.ts";

export interface PreservedRunWorkspace {
  path: string;
  branch: string;
}

export interface RunRetentionStateIdentity {
  runId: string;
  status: RunState["status"];
  lastEventSequence: number;
  updatedAt: string;
  hash: string;
}

export interface RunRetentionPlan {
  schemaVersion: 1;
  action: "delete_run_state";
  repositoryRoot: string;
  runId: string;
  state: RunRetentionStateIdentity;
  preservedWorkspace: PreservedRunWorkspace;
  deletePaths: string[];
}

export interface RunRetentionResult {
  schemaVersion: 1;
  runId: string;
  deletedPaths: string[];
  preservedWorkspace: PreservedRunWorkspace;
}

export interface CompletedRunPrunePlan {
  schemaVersion: 1;
  action: "prune_completed_run_state";
  repositoryRoot: string;
  completedBefore: string;
  keepNewest: number;
  candidateRunIds: string[];
  keptRunIds: string[];
  deletionPlans: RunRetentionPlan[];
}

export type RunRetentionFaultBoundary =
  | "after_journal"
  | "after_auxiliary"
  | "before_run"
  | "during_run"
  | "after_run"
  | "before_journal_cleanup";

export interface RunRetentionCheckpoint {
  boundary: RunRetentionFaultBoundary;
  runId: string;
}

export type RunRetentionHook = (checkpoint: RunRetentionCheckpoint) => Promise<void> | void;

type RetentionTargetId = "run" | "control" | "supervisor" | "migration_backup";

interface RetentionTarget {
  id: RetentionTargetId;
  path: string;
  kind: "file" | "directory";
}

interface RunRetentionJournalPayload {
  schemaVersion: 1;
  kind: "graphcraft_run_retention";
  runId: string;
  state: RunRetentionStateIdentity;
  preservedWorkspace: PreservedRunWorkspace;
  existingTargetIds: RetentionTargetId[];
  createdAt: string;
}

interface RunRetentionJournal extends RunRetentionJournalPayload {
  integrityHash: string;
}

const DELETABLE_RUN_STATUSES = new Set<RunState["status"]>(["completed", "stopped", "blocked"]);
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RETENTION_JOURNAL_MAX_BYTES = 64 * 1024;
const RETENTION_JOURNAL_MAX_COUNT = 4_096;
const RETENTION_WORKSPACE_PATH_MAX_CHARACTERS = 16 * 1024;
const RETENTION_WORKSPACE_BRANCH_MAX_CHARACTERS = 4 * 1024;
const RETENTION_WORKSPACE_FILE_MAX_BYTES = 64 * 1024;
const RETENTION_TARGET_IDS: readonly RetentionTargetId[] = [
  "run",
  "control",
  "supervisor",
  "migration_backup",
];

function retentionTargets(repositoryRoot: string, runId: string): RetentionTarget[] {
  const graphcraftRoot = join(repositoryRoot, ".graphcraft");
  return [
    { id: "run", path: join(graphcraftRoot, "runs", runId), kind: "directory" },
    { id: "control", path: join(graphcraftRoot, "controls", `${runId}.json`), kind: "file" },
    { id: "supervisor", path: join(graphcraftRoot, "supervisors", runId), kind: "directory" },
    {
      id: "migration_backup",
      path: join(graphcraftRoot, "migration-backups", runId),
      kind: "directory",
    },
  ];
}

function refusal(runId: string, reason: string): Error {
  return new Error(`Retention refused for run ${runId}: ${reason}`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function exactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} is not an object`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} has unexpected fields`);
  return record;
}

function safeRetentionString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${label} is missing or exceeds its bounded length`);
  if (value.includes("\0")) throw new Error(`${label} contains an invalid null byte`);
  return redactString(value);
}

function safePreservedWorkspace(value: unknown): PreservedRunWorkspace {
  const record = exactRecord(value, "retention workspace", ["path", "branch"]);
  return {
    path: safeRetentionString(
      record.path,
      "retention workspace path",
      RETENTION_WORKSPACE_PATH_MAX_CHARACTERS,
    ),
    branch: safeRetentionString(
      record.branch,
      "retention workspace branch",
      RETENTION_WORKSPACE_BRANCH_MAX_CHARACTERS,
    ),
  };
}

function preservedWorkspaceProjection(value: unknown): PreservedRunWorkspace {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("persisted workspace is not an object");
  const record = value as Record<string, unknown>;
  return safePreservedWorkspace({ path: record.path, branch: record.branch });
}

function validTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error(`${label} is not an ISO date-time`);
  return value;
}

function parseRetentionStateIdentity(
  value: unknown,
  expectedRunId: string,
): RunRetentionStateIdentity {
  const record = exactRecord(value, "retention state identity", [
    "runId",
    "status",
    "lastEventSequence",
    "updatedAt",
    "hash",
  ]);
  if (record.runId !== expectedRunId)
    throw new Error("retention state identity belongs to a different run");
  if (
    typeof record.status !== "string" ||
    !DELETABLE_RUN_STATUSES.has(record.status as RunState["status"])
  )
    throw new Error("retention state identity is not terminal and deletable");
  if (!Number.isSafeInteger(record.lastEventSequence) || Number(record.lastEventSequence) < 1)
    throw new Error("retention state identity has an invalid event sequence");
  if (typeof record.hash !== "string" || !HASH_PATTERN.test(record.hash))
    throw new Error("retention state identity has an invalid hash");
  return {
    runId: expectedRunId,
    status: record.status as RunState["status"],
    lastEventSequence: Number(record.lastEventSequence),
    updatedAt: validTimestamp(record.updatedAt, "retention state update time"),
    hash: record.hash,
  };
}

function retentionJournalPayload(journal: RunRetentionJournal): RunRetentionJournalPayload {
  return {
    schemaVersion: journal.schemaVersion,
    kind: journal.kind,
    runId: journal.runId,
    state: journal.state,
    preservedWorkspace: journal.preservedWorkspace,
    existingTargetIds: journal.existingTargetIds,
    createdAt: journal.createdAt,
  };
}

function parseRetentionJournal(value: unknown, expectedRunId: string): RunRetentionJournal {
  const record = exactRecord(value, "retention journal", [
    "schemaVersion",
    "kind",
    "runId",
    "state",
    "preservedWorkspace",
    "existingTargetIds",
    "createdAt",
    "integrityHash",
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "graphcraft_run_retention" ||
    record.runId !== expectedRunId
  )
    throw new Error("retention journal identity does not match this run");
  if (!Array.isArray(record.existingTargetIds))
    throw new Error("retention journal target identifiers are invalid");
  const existingTargetIds = record.existingTargetIds.map((value) => {
    if (typeof value !== "string" || !RETENTION_TARGET_IDS.includes(value as RetentionTargetId))
      throw new Error("retention journal contains an unknown target identifier");
    return value as RetentionTargetId;
  });
  if (
    existingTargetIds.length === 0 ||
    existingTargetIds.length !== new Set(existingTargetIds).size ||
    !existingTargetIds.includes("run")
  )
    throw new Error("retention journal target identifiers are incomplete or duplicated");
  if (typeof record.integrityHash !== "string" || !HASH_PATTERN.test(record.integrityHash))
    throw new Error("retention journal integrity hash is invalid");

  const rawWorkspace = safePreservedWorkspace(record.preservedWorkspace);
  const journal: RunRetentionJournal = {
    schemaVersion: 1,
    kind: "graphcraft_run_retention",
    runId: expectedRunId,
    state: parseRetentionStateIdentity(record.state, expectedRunId),
    preservedWorkspace: rawWorkspace,
    existingTargetIds,
    createdAt: validTimestamp(record.createdAt, "retention journal creation time"),
    integrityHash: record.integrityHash,
  };
  if (contentHash(retentionJournalPayload(journal)) !== journal.integrityHash)
    throw new Error("retention journal integrity hash does not match its contents");
  return journal;
}

function retentionJournalRoot(repositoryRoot: string): string {
  return join(repositoryRoot, ".graphcraft", "retention");
}

function retentionJournalPath(repositoryRoot: string, runId: string): string {
  return join(retentionJournalRoot(repositoryRoot), `${runId}.json`);
}

async function readRetentionJournal(
  repositoryRoot: string,
  runId: string,
): Promise<RunRetentionJournal | undefined> {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid Graphcraft run ID: ${runId}`);
  const graphcraftRoot = join(repositoryRoot, ".graphcraft");
  const path = retentionJournalPath(repositoryRoot, runId);
  let source: Buffer;
  try {
    source = await readPrivateFileBounded(path, RETENTION_JOURNAL_MAX_BYTES, graphcraftRoot);
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (error instanceof Error && error.message.includes("bounded read limit"))
      throw refusal(runId, "retention journal exceeds its bounded size");
    throw refusal(runId, "retention journal is not a stable private regular file");
  }

  try {
    return parseRetentionJournal(JSON.parse(source.toString("utf8")), runId);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Retention refused")) throw error;
    throw refusal(runId, "retention journal is invalid or has been modified");
  }
}

async function writeRetentionJournal(
  repositoryRoot: string,
  journal: RunRetentionJournal,
): Promise<void> {
  const graphcraftRoot = join(repositoryRoot, ".graphcraft");
  const root = retentionJournalRoot(repositoryRoot);
  await ensurePrivateDirectory(graphcraftRoot);
  const rootExisted = await lstat(root)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  await ensurePrivateDirectory(root, graphcraftRoot);
  if (!rootExisted) await syncDirectory(graphcraftRoot);
  const existing = await readRetentionJournal(repositoryRoot, journal.runId);
  if (existing) {
    if (!isDeepStrictEqual(existing, journal))
      throw refusal(journal.runId, "a different retention journal already exists");
    return;
  }
  const entries = await readdir(root);
  if (entries.length >= RETENTION_JOURNAL_MAX_COUNT)
    throw refusal(
      journal.runId,
      `retention journal directory reached its ${RETENTION_JOURNAL_MAX_COUNT}-entry bound`,
    );
  const encoded = `${JSON.stringify(journal, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > RETENTION_JOURNAL_MAX_BYTES)
    throw refusal(journal.runId, "retention journal exceeds its bounded size");
  if (redactString(encoded) !== encoded)
    throw refusal(journal.runId, "retention journal contains sensitive material");
  const path = retentionJournalPath(repositoryRoot, journal.runId);
  await writeJsonAtomic(path, journal);
  await hardenPrivateFile(path, graphcraftRoot);
  const persisted = await readRetentionJournal(repositoryRoot, journal.runId);
  if (!persisted || !isDeepStrictEqual(persisted, journal))
    throw refusal(journal.runId, "retention journal was not persisted exactly");
}

async function removeRetentionJournal(
  repositoryRoot: string,
  runId: string,
  assertLeaseHeld: () => void,
): Promise<void> {
  const existing = await readRetentionJournal(repositoryRoot, runId);
  if (!existing) return;
  const graphcraftRoot = join(repositoryRoot, ".graphcraft");
  const path = retentionJournalPath(repositoryRoot, runId);
  assertLeaseHeld();
  await hardenPrivateFile(path, graphcraftRoot);
  assertLeaseHeld();
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await syncDirectory(retentionJournalRoot(repositoryRoot));
  if (await readRetentionJournal(repositoryRoot, runId))
    throw refusal(runId, "retention journal remained after cleanup");
}

async function listRetentionJournals(repositoryRoot: string): Promise<RunRetentionJournal[]> {
  const graphcraftRoot = join(repositoryRoot, ".graphcraft");
  const root = retentionJournalRoot(repositoryRoot);
  let entries;
  try {
    await validatePrivatePath(graphcraftRoot, relative(graphcraftRoot, root));
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (entries.length > RETENTION_JOURNAL_MAX_COUNT)
    throw new Error(
      `Retention journal directory exceeds its ${RETENTION_JOURNAL_MAX_COUNT}-entry bound`,
    );
  const journalNames = entries
    .map(({ name }) => name)
    .filter((name) => RUN_ID_PATTERN.test(name.slice(0, -5)) && name.endsWith(".json"))
    .sort();
  const journals: RunRetentionJournal[] = [];
  for (const name of journalNames) {
    const runId = name.slice(0, -5);
    const journal = await readRetentionJournal(repositoryRoot, runId);
    if (!journal) throw refusal(runId, "retention journal disappeared while being listed");
    journals.push(journal);
  }
  return journals;
}

function planFromJournal(repositoryRoot: string, journal: RunRetentionJournal): RunRetentionPlan {
  return {
    schemaVersion: 1,
    action: "delete_run_state",
    repositoryRoot,
    runId: journal.runId,
    state: journal.state,
    preservedWorkspace: journal.preservedWorkspace,
    deletePaths: retentionTargets(repositoryRoot, journal.runId).map(({ path }) => path),
  };
}

async function readPersistedState(repositoryRoot: string, runId: string): Promise<RunState> {
  try {
    const graphcraftRoot = join(repositoryRoot, ".graphcraft");
    const runRoot = join(graphcraftRoot, "runs", runId);
    await validatePrivatePath(graphcraftRoot, relative(graphcraftRoot, runRoot));
    await Promise.all([
      validatePrivatePath(runRoot, "events.jsonl"),
      validatePrivatePath(runRoot, "state.json"),
    ]);
    const materialized = RunStateSchema.parse(
      JSON.parse(
        (
          await readPrivateFileBounded(join(runRoot, "state.json"), RUN_STATE_MAX_BYTES, runRoot)
        ).toString("utf8"),
      ),
    );
    if (materialized.runId !== runId)
      throw new Error(`materialized state belongs to run ${materialized.runId}`);

    const events = (
      await readPrivateFileBounded(join(runRoot, "events.jsonl"), RUN_EVENT_LOG_MAX_BYTES, runRoot)
    )
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const bytes = Buffer.byteLength(`${line}\n`);
        if (bytes > RUN_EVENT_MAX_BYTES)
          throw new Error(
            `authoritative event exceeds its ${RUN_EVENT_MAX_BYTES}-byte bounded size`,
          );
        return RunEventSchema.parse(JSON.parse(line));
      });
    if (events.length === 0) throw new Error("authoritative event log is empty");
    for (const [index, event] of events.entries()) {
      verifyRunEvent(event);
      if (event.sequence !== index + 1)
        throw new Error(
          `authoritative event sequence expected ${index + 1}, received ${event.sequence}`,
        );
    }
    const authoritative = RunStateSchema.parse(reduceEvents(events));
    if (Buffer.byteLength(`${JSON.stringify(authoritative, null, 2)}\n`) > RUN_STATE_MAX_BYTES)
      throw new Error(`authoritative state exceeds its ${RUN_STATE_MAX_BYTES}-byte bounded size`);
    if (authoritative.runId !== runId)
      throw new Error(`authoritative events belong to run ${authoritative.runId}`);
    if (contentHash(materialized) !== contentHash(authoritative))
      throw new Error("materialized state does not match the authoritative event log");
    return authoritative;
  } catch (error) {
    throw refusal(
      runId,
      `persisted state is missing or ambiguous (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function retentionStateIdentity(state: RunState): RunRetentionStateIdentity {
  return {
    runId: state.runId,
    status: state.status,
    lastEventSequence: state.lastEventSequence,
    updatedAt: state.updatedAt,
    hash: contentHash(state),
  };
}

async function readPreservedWorkspace(
  repositoryRoot: string,
  runId: string,
): Promise<PreservedRunWorkspace> {
  try {
    const runRoot = join(repositoryRoot, ".graphcraft", "runs", runId);
    await validatePrivatePath(runRoot, "workspace.json");
    return preservedWorkspaceProjection(
      JSON.parse(
        (
          await readPrivateFileBounded(
            join(runRoot, "workspace.json"),
            RETENTION_WORKSPACE_FILE_MAX_BYTES,
            runRoot,
          )
        ).toString("utf8"),
      ),
    );
  } catch (error) {
    throw refusal(
      runId,
      `preserved workspace is missing or ambiguous (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

async function assertNoLiveSupervisor(repositoryRoot: string, runId: string): Promise<void> {
  let records;
  try {
    records = await listSupervisorRecords(repositoryRoot, runId);
  } catch (error) {
    throw refusal(
      runId,
      `supervisor state is ambiguous (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  for (const record of records) {
    if (record.runId !== runId || resolve(record.repositoryRoot) !== repositoryRoot)
      throw refusal(runId, `supervisor ${record.supervisorId} has ambiguous ownership`);
    const supervisor = inspectSupervisorRecord(record);
    if (supervisor.health === "starting" || supervisor.health === "running")
      throw refusal(
        runId,
        `supervisor ${supervisor.supervisorId} is ${supervisor.health} (PID ${supervisor.pid})`,
      );
  }
}

async function assertNoProbeProcessState(repositoryRoot: string, runId: string): Promise<void> {
  const graphcraftRoot = join(repositoryRoot, ".graphcraft");
  const path = join(graphcraftRoot, "locks", "probe-processes", runId);
  try {
    await validatePrivatePath(graphcraftRoot, relative(graphcraftRoot, path));
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new Error("probe-process state is not an ordinary directory");
  } catch (error) {
    if (isMissing(error)) return;
    throw refusal(
      runId,
      `probe-process ownership evidence is ambiguous (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  throw refusal(
    runId,
    "probe-process ownership evidence remains; resume the run so Graphcraft can reconcile it before deletion",
  );
}

async function inspectDeletableRun(
  repositoryRoot: string,
  runId: string,
): Promise<RunRetentionPlan> {
  const state = await readPersistedState(repositoryRoot, runId);
  if (!DELETABLE_RUN_STATUSES.has(state.status))
    throw refusal(runId, `state ${state.status} is active or has an ambiguous terminal outcome`);
  const preservedWorkspace = await readPreservedWorkspace(repositoryRoot, runId);
  await assertNoLiveSupervisor(repositoryRoot, runId);
  await assertNoProbeProcessState(repositoryRoot, runId);
  return {
    schemaVersion: 1,
    action: "delete_run_state",
    repositoryRoot,
    runId,
    state: retentionStateIdentity(state),
    preservedWorkspace,
    deletePaths: retentionTargets(repositoryRoot, runId).map(({ path }) => path),
  };
}

/** Build a read-only deletion plan for one uniquely resolved, quiescent run. */
export async function planRunRetention(input: {
  repositoryRoot: string;
  runReference: string;
}): Promise<RunRetentionPlan> {
  if (!input.runReference.trim())
    throw new Error("Retention requires an explicit, uniquely resolvable run reference");
  const repositoryRoot = resolve(input.repositoryRoot);
  if (RUN_ID_PATTERN.test(input.runReference)) {
    const journal = await readRetentionJournal(repositoryRoot, input.runReference);
    if (journal) {
      await assertNoProbeProcessState(repositoryRoot, journal.runId);
      return planFromJournal(repositoryRoot, journal);
    }
  }
  const runId = await resolveRunId(repositoryRoot, input.runReference);
  return await inspectDeletableRun(repositoryRoot, runId);
}

function validateRetentionPlan(plan: RunRetentionPlan): void {
  const record = exactRecord(plan, "retention plan", [
    "schemaVersion",
    "action",
    "repositoryRoot",
    "runId",
    "state",
    "preservedWorkspace",
    "deletePaths",
  ]);
  if (record.schemaVersion !== 1 || record.action !== "delete_run_state")
    throw new Error("Retention plan has an unsupported schema or action");
  if (typeof record.runId !== "string" || !RUN_ID_PATTERN.test(record.runId))
    throw new Error("Retention plan has an invalid run ID");
  if (
    typeof record.repositoryRoot !== "string" ||
    resolve(record.repositoryRoot) !== record.repositoryRoot
  )
    throw refusal(record.runId, "repository root is not an absolute normalized path");
  parseRetentionStateIdentity(record.state, record.runId);
  const workspace = safePreservedWorkspace(record.preservedWorkspace);
  if (!isDeepStrictEqual(workspace, record.preservedWorkspace))
    throw refusal(record.runId, "workspace metadata contains sensitive material");
  if (!Array.isArray(record.deletePaths)) throw refusal(record.runId, "delete paths are missing");
  const expectedPaths = retentionTargets(record.repositoryRoot, record.runId).map(
    ({ path }) => path,
  );
  if (!isDeepStrictEqual(record.deletePaths, expectedPaths))
    throw refusal(record.runId, "delete paths do not match the repository and run ID");
}

async function validateTarget(graphcraftRoot: string, target: RetentionTarget): Promise<boolean> {
  const expected = resolve(target.path);
  const validated = await validatePrivatePath(
    graphcraftRoot,
    relative(resolve(graphcraftRoot), expected),
  );
  if (validated !== expected)
    throw new Error(`Retention target ${target.path} escaped the Graphcraft state directory`);

  const stats = await lstat(target.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stats) return false;
  const validKind = target.kind === "directory" ? stats.isDirectory() : stats.isFile();
  if (!validKind || stats.isSymbolicLink())
    throw new Error(`Retention target ${target.path} is not an ordinary ${target.kind}`);
  return true;
}

async function validateTargets(
  graphcraftRoot: string,
  targets: RetentionTarget[],
  journaled: boolean,
): Promise<Set<RetentionTargetId>> {
  const existing = new Set<RetentionTargetId>();
  for (const target of targets) {
    try {
      if (await validateTarget(graphcraftRoot, target)) existing.add(target.id);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ${
          journaled
            ? "the recovery journal was preserved and no additional files were deleted"
            : "no files were deleted"
        }`,
      );
    }
  }
  return existing;
}

async function removeTargets(
  graphcraftRoot: string,
  targets: RetentionTarget[],
  runId: string,
  onCheckpoint: RunRetentionHook | undefined,
  assertLeaseHeld: () => void,
): Promise<void> {
  let removedAuxiliary = false;
  for (const target of targets.slice(1)) {
    assertLeaseHeld();
    const exists = await validateTarget(graphcraftRoot, target);
    assertLeaseHeld();
    if (!exists) continue;
    if (target.kind === "directory") await rm(target.path, { recursive: true, force: true });
    else
      await unlink(target.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    assertLeaseHeld();
    removedAuxiliary = true;
  }
  if (removedAuxiliary) await onCheckpoint?.({ boundary: "after_auxiliary", runId });

  const run = targets[0]!;
  assertLeaseHeld();
  const runExists = await validateTarget(graphcraftRoot, run);
  assertLeaseHeld();
  if (!runExists) return;
  await onCheckpoint?.({ boundary: "before_run", runId });
  await onCheckpoint?.({ boundary: "during_run", runId });
  const stillExists = await validateTarget(graphcraftRoot, run);
  assertLeaseHeld();
  if (stillExists) {
    await rm(run.path, { recursive: true, force: true });
    assertLeaseHeld();
  }
  await onCheckpoint?.({ boundary: "after_run", runId });
}

async function syncRetentionTargetParents(
  targets: RetentionTarget[],
  assertLeaseHeld: () => void,
): Promise<void> {
  for (const parent of new Set(targets.map(({ path }) => dirname(path)))) {
    assertLeaseHeld();
    try {
      await syncDirectory(parent);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    assertLeaseHeld();
  }
}

function createRetentionJournal(
  plan: RunRetentionPlan,
  existingTargetIds: Set<RetentionTargetId>,
): RunRetentionJournal {
  const payload: RunRetentionJournalPayload = {
    schemaVersion: 1,
    kind: "graphcraft_run_retention",
    runId: plan.runId,
    state: plan.state,
    preservedWorkspace: plan.preservedWorkspace,
    existingTargetIds: RETENTION_TARGET_IDS.filter((id) => existingTargetIds.has(id)),
    createdAt: new Date().toISOString(),
  };
  return parseRetentionJournal({ ...payload, integrityHash: contentHash(payload) }, plan.runId);
}

async function applyRetention(
  plan: RunRetentionPlan,
  confirmRunId: string,
  validateEligibility?: (current: RunRetentionPlan) => void,
  options: {
    deferJournalCleanup?: boolean;
    onCheckpoint?: RunRetentionHook | undefined;
  } = {},
): Promise<RunRetentionResult> {
  if (confirmRunId !== plan.runId)
    throw new Error(`Retention confirmation must exactly equal run ID ${plan.runId}`);
  validateRetentionPlan(plan);

  const repositoryRoot = resolve(plan.repositoryRoot);
  const graphcraftRoot = join(repositoryRoot, ".graphcraft");
  const retentionLock = new RunLock(join(graphcraftRoot, "locks", "retention.lock"));
  const supervisorLock = new RunLock(
    join(graphcraftRoot, "locks", `${plan.runId}.supervisor.lock`),
  );
  const runLock = new RunLock(join(graphcraftRoot, "locks", `${plan.runId}.lock`));
  const artifactLock = new RunLock(join(graphcraftRoot, "locks", `${plan.runId}.artifacts.lock`));
  const locks = [retentionLock, supervisorLock, runLock, artifactLock];
  const acquiredLocks: RunLock[] = [];
  const observedSignals: Array<{
    signal: AbortSignal;
    recordLoss: () => void;
  }> = [];
  let causalFailure: { error: unknown } | undefined;
  let cleanupFailure: { error: unknown } | undefined;
  let bodyFailureWasThrown = false;
  const rememberCausalFailure = (error: unknown): { error: unknown } =>
    (causalFailure ??= { error });
  const assertLeaseHeld = (): void => {
    if (causalFailure) throw causalFailure.error;
  };
  const checkpoint: RunRetentionHook = async (value) => {
    assertLeaseHeld();
    await options.onCheckpoint?.(value);
    assertLeaseHeld();
  };
  try {
    for (const lock of locks) {
      const signal = lock.signal;
      const recordLoss = (): void => {
        rememberCausalFailure(signal.reason);
      };
      observedSignals.push({ signal, recordLoss });
      if (signal.aborted) recordLoss();
      else signal.addEventListener("abort", recordLoss, { once: true });
      assertLeaseHeld();
      await lock.acquire();
      acquiredLocks.push(lock);
      assertLeaseHeld();
    }

    const targets = retentionTargets(repositoryRoot, plan.runId);
    let journal = await readRetentionJournal(repositoryRoot, plan.runId);
    if (journal) {
      const current = planFromJournal(repositoryRoot, journal);
      validateEligibility?.(current);
      await assertNoLiveSupervisor(repositoryRoot, plan.runId);
      await assertNoProbeProcessState(repositoryRoot, plan.runId);
      await validateTargets(graphcraftRoot, targets, true);
    } else {
      const resolvedRunId = await resolveRunId(repositoryRoot, plan.runId);
      if (resolvedRunId !== plan.runId)
        throw refusal(plan.runId, `exact run ID resolved to ${resolvedRunId}`);
      const current = await inspectDeletableRun(repositoryRoot, plan.runId);
      validateEligibility?.(current);
      const existingTargetIds = await validateTargets(graphcraftRoot, targets, false);
      journal = createRetentionJournal(current, existingTargetIds);
      assertLeaseHeld();
      await writeRetentionJournal(repositoryRoot, journal);
      await checkpoint({ boundary: "after_journal", runId: plan.runId });
    }

    assertLeaseHeld();
    await removeTargets(graphcraftRoot, targets, plan.runId, checkpoint, assertLeaseHeld);
    const remaining = await validateTargets(graphcraftRoot, targets, true);
    assertLeaseHeld();
    if (remaining.size > 0)
      throw refusal(
        plan.runId,
        `targets remained after deletion (${[...remaining].join(", ")}); recovery journal was preserved`,
      );
    if (!options.deferJournalCleanup) {
      await syncRetentionTargetParents(targets, assertLeaseHeld);
      await checkpoint({ boundary: "before_journal_cleanup", runId: plan.runId });
      await removeRetentionJournal(repositoryRoot, plan.runId, assertLeaseHeld);
      assertLeaseHeld();
    }
    return {
      schemaVersion: 1,
      runId: plan.runId,
      deletedPaths: targets
        .filter(({ id }) => journal.existingTargetIds.includes(id))
        .map(({ path }) => path),
      preservedWorkspace: journal.preservedWorkspace,
    };
  } catch (error) {
    bodyFailureWasThrown = true;
    throw rememberCausalFailure(error).error;
  } finally {
    for (let index = acquiredLocks.length - 1; index >= 0; index -= 1) {
      try {
        await acquiredLocks[index]!.release();
      } catch (error) {
        cleanupFailure ??= { error };
      }
    }
    for (const { signal, recordLoss } of observedSignals)
      signal.removeEventListener("abort", recordLoss);
    if (!bodyFailureWasThrown) {
      if (causalFailure) throw causalFailure.error;
      if (cleanupFailure) throw cleanupFailure.error;
    }
  }
}

/** Apply a plan only after an exact run-ID confirmation and an in-lock eligibility check. */
export async function applyRunRetention(input: {
  plan: RunRetentionPlan;
  confirmRunId: string;
  onCheckpoint?: RunRetentionHook;
}): Promise<RunRetentionResult> {
  return await applyRetention(
    input.plan,
    input.confirmRunId,
    (current) => {
      if (
        !isDeepStrictEqual(current.state, input.plan.state) ||
        !isDeepStrictEqual(current.preservedWorkspace, input.plan.preservedWorkspace)
      )
        throw refusal(input.plan.runId, "state changed; create and confirm a new dry-run plan");
    },
    { onCheckpoint: input.onCheckpoint },
  );
}

function isoCutoff(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new Error("Retention cutoff must be an ISO date-time");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Retention cutoff must be an ISO date-time");
  return timestamp;
}

/** Select completed runs strictly older than a cutoff while preserving the newest N candidates. */
export async function planCompletedRunPrune(input: {
  repositoryRoot: string;
  completedBefore: string;
  keepNewest: number;
}): Promise<CompletedRunPrunePlan> {
  if (!Number.isSafeInteger(input.keepNewest) || input.keepNewest < 0)
    throw new Error("Retention keepNewest must be a non-negative integer");
  const cutoff = isoCutoff(input.completedBefore);
  const repositoryRoot = resolve(input.repositoryRoot);
  const journals = await listRetentionJournals(repositoryRoot);
  const journalByRunId = new Map(journals.map((journal) => [journal.runId, journal]));
  const liveStates: Array<{
    runId: string;
    state: RunRetentionStateIdentity;
    journal: undefined;
  }> = [];
  for (const runId of await listRunIds(repositoryRoot)) {
    if (journalByRunId.has(runId)) continue;
    liveStates.push({
      runId,
      state: retentionStateIdentity(await readPersistedState(repositoryRoot, runId)),
      journal: undefined,
    });
  }
  const candidates = [
    ...liveStates,
    ...journals.map((journal) => ({
      runId: journal.runId,
      state: journal.state,
      journal,
    })),
  ]
    .filter(({ state }) => state.status === "completed" && Date.parse(state.updatedAt) < cutoff)
    .sort(
      (left, right) =>
        Date.parse(right.state.updatedAt) - Date.parse(left.state.updatedAt) ||
        left.runId.localeCompare(right.runId),
    );
  const kept = candidates.filter(({ journal }) => journal === undefined).slice(0, input.keepNewest);
  const keptRunIds = new Set(kept.map(({ runId }) => runId));
  const selected = candidates.filter(
    ({ runId, journal }) => journal !== undefined || !keptRunIds.has(runId),
  );
  const deletionPlans: RunRetentionPlan[] = [];
  for (const { runId, journal } of selected) {
    if (journal) await assertNoProbeProcessState(repositoryRoot, runId);
    deletionPlans.push(
      journal
        ? planFromJournal(repositoryRoot, journal)
        : await inspectDeletableRun(repositoryRoot, runId),
    );
  }
  return {
    schemaVersion: 1,
    action: "prune_completed_run_state",
    repositoryRoot,
    completedBefore: input.completedBefore,
    keepNewest: input.keepNewest,
    candidateRunIds: candidates.map(({ runId }) => runId),
    keptRunIds: kept.map(({ runId }) => runId),
    deletionPlans,
  };
}

function sameRunIds(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== new Set(actual).size || actual.length !== expected.length) return false;
  const sortedExpected = [...expected].sort();
  return [...actual].sort().every((runId, index) => runId === sortedExpected[index]);
}

/** Apply a prune plan after exact multi-run confirmation and re-planning. */
export async function applyCompletedRunPrune(input: {
  plan: CompletedRunPrunePlan;
  confirmRunIds: readonly string[];
  onCheckpoint?: RunRetentionHook;
}): Promise<RunRetentionResult[]> {
  const plannedRunIds = input.plan.deletionPlans.map(({ runId }) => runId);
  if (!sameRunIds(input.confirmRunIds, plannedRunIds))
    throw new Error("Prune confirmation must contain every planned run ID exactly once");

  const current = await planCompletedRunPrune({
    repositoryRoot: input.plan.repositoryRoot,
    completedBefore: input.plan.completedBefore,
    keepNewest: input.plan.keepNewest,
  });
  const currentRunIds = current.deletionPlans.map(({ runId }) => runId);
  if (!sameRunIds(currentRunIds, plannedRunIds))
    throw new Error("Prune eligibility changed; create and confirm a new dry-run plan");

  const cutoff = isoCutoff(input.plan.completedBefore);
  const validateCompletedEligibility =
    (plan: RunRetentionPlan) => (revalidated: RunRetentionPlan) => {
      if (revalidated.state.status !== "completed")
        throw refusal(plan.runId, `state changed to ${revalidated.state.status}`);
      if (!isDeepStrictEqual(revalidated.state, plan.state))
        throw refusal(plan.runId, "completed state changed after prune revalidation");
      if (Date.parse(revalidated.state.updatedAt) >= cutoff)
        throw refusal(plan.runId, "completion is no longer strictly before the prune cutoff");
    };
  const results: RunRetentionResult[] = [];
  for (const plan of current.deletionPlans) {
    try {
      results.push(
        await applyRetention(plan, plan.runId, validateCompletedEligibility(plan), {
          deferJournalCleanup: true,
          onCheckpoint: input.onCheckpoint,
        }),
      );
    } catch (error) {
      const deletedRunIds = results.map(({ runId }) => runId);
      const progress =
        deletedRunIds.length === 0
          ? "No planned run state was deleted"
          : `Deleted run state before the failure: ${deletedRunIds.join(", ")}`;
      throw new Error(
        `${progress}. Prune stopped at run ${plan.runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const plan of current.deletionPlans) {
    try {
      await applyRetention(plan, plan.runId, validateCompletedEligibility(plan), {
        onCheckpoint: input.onCheckpoint,
      });
    } catch (error) {
      throw new Error(
        `All planned run state was deleted, but retention journal cleanup stopped at run ${plan.runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return results;
}
