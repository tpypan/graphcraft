import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  ArtifactInventorySchema,
  GraphSchema,
  GraphAmendmentRecordSchema,
  GraphRevisionRecordSchema,
  HeldOutProbePlanSchema,
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  ProbePlanSchema,
  RunContractSchema,
  RunEventSchema,
  RunStateSchema,
  contentHash,
  createRunEvent,
  createHeldOutProbePlan,
  probePlanFromGraph,
  reduceEvents,
  validateHeldOutProbePlan,
  verifyRunEvent,
  type Graph,
  type ArtifactInventory,
  type CanonicalHashAlgorithm,
  type GraphRevisionRecord,
  type HostEvent,
  type HeldOutProbePlan,
  type ProbePlan,
  type RunContract,
  type RunEvent,
  type RunState,
  type RunStorageManifest,
} from "@graphcraft/core";
import { syncDirectory } from "./json.ts";
import {
  ensureCurrentRunStorage,
  writeCurrentRunStorageManifest,
  writeInitializingRunStorageManifest,
} from "./migration.ts";
import { assertPersistenceSafe, redactTextBytes, redactValue } from "./redaction.ts";
import { RunArtifactStore, type ArtifactPreview } from "./artifact-policy.ts";
import { parseWorkspaceScopeSnapshot } from "./scope.ts";
import {
  ensurePrivateDirectory,
  finalizePrivateFileMutation,
  preparePrivateFileMutation,
  readPrivateFileBounded,
  validatePrivatePath,
  writePrivateJsonAtomic,
} from "./secure-fs.ts";

const MEBIBYTE = 1024 * 1024;

export const RUN_EVENT_MAX_BYTES = 4 * MEBIBYTE;
export const RUN_EVENT_LOG_MAX_BYTES = 64 * MEBIBYTE;
export const RUN_STATE_MAX_BYTES = 16 * MEBIBYTE;
export const RUN_BLOCKED_EVENT_RESERVE_BYTES = 64 * 1024;
export const RUN_METADATA_MAX_BYTES = 4 * MEBIBYTE;
export const RUN_WORKSPACE_MAX_BYTES = 64 * 1024;

export interface RunStoreLimits {
  maxEventBytes: number;
  maxEventLogBytes: number;
  maxStateBytes: number;
  blockedEventReserveBytes: number;
}

export type RunStoreLimitKind = "event" | "event_log" | "state";

export class RunStoreLimitError extends Error {
  blockerPersisted = false;

  constructor(
    readonly kind: RunStoreLimitKind,
    readonly attemptedBytes: number,
    readonly limitBytes: number,
  ) {
    super(
      `Run ${kind.replace("_", " ")} would require ${attemptedBytes} serialized bytes, exceeding the ${limitBytes}-byte limit`,
    );
    this.name = "RunStoreLimitError";
  }
}

export class RunStoreEventLogCorruptionError extends Error {
  constructor(
    readonly record: number,
    readonly offsetBytes: number,
    readonly trailing: boolean,
    reason:
      | "encoding"
      | "json"
      | "schema"
      | "hash"
      | "format"
      | "sequence"
      | "scope"
      | "checkpoint"
      | "governance"
      | "repository_side_effect",
  ) {
    const location = trailing ? "trailing record" : `record ${record}`;
    const problem =
      reason === "encoding"
        ? "invalid UTF-8"
        : reason === "json"
          ? "invalid JSON"
          : reason === "schema"
            ? "an invalid event schema"
            : reason === "hash"
              ? "an invalid event hash"
              : reason === "format"
                ? "an event format that disagrees with its storage manifest"
                : reason === "scope"
                  ? "a workspace-scope snapshot that disagrees with its storage manifest"
                  : reason === "checkpoint"
                    ? "a probe-evidence checkpoint format that disagrees with its storage manifest"
                    : reason === "governance"
                      ? "a governance/control identity format that disagrees with its storage manifest"
                      : reason === "repository_side_effect"
                        ? "a repository side-effect identity format that disagrees with its storage manifest"
                        : "an invalid event sequence";
    super(
      `Run event log has ${problem} in ${location} at byte ${offsetBytes}; event log bytes were left unchanged`,
    );
    this.name = "RunStoreEventLogCorruptionError";
  }
}

const PERSISTENCE_LIMIT_BLOCK_REASON =
  "Graphcraft blocked this run before durable run storage exceeded its configured size limit.";

function normalizeLimits(input: Partial<RunStoreLimits>): RunStoreLimits {
  const limits: RunStoreLimits = {
    maxEventBytes: input.maxEventBytes ?? RUN_EVENT_MAX_BYTES,
    maxEventLogBytes: input.maxEventLogBytes ?? RUN_EVENT_LOG_MAX_BYTES,
    maxStateBytes: input.maxStateBytes ?? RUN_STATE_MAX_BYTES,
    blockedEventReserveBytes: input.blockedEventReserveBytes ?? RUN_BLOCKED_EVENT_RESERVE_BYTES,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`RunStore ${name} must be a positive safe integer`);
  }
  if (limits.blockedEventReserveBytes >= limits.maxEventLogBytes)
    throw new Error("RunStore blocked-event reserve must be smaller than the event-log limit");
  return limits;
}

function serializedEvent(event: RunEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function serializedStateBytes(state: RunState): number {
  return Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`);
}

function serializedJsonBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(redactValue(value), null, 2)}\n`);
}

function isPersistenceLimitBlocker(event: RunEvent | undefined): boolean {
  return (
    event?.type === "run.blocked" &&
    ["event", "event_log", "state"].includes(String(event.data.persistenceLimit))
  );
}

function assertEventLogFile(path: string, status: BigIntStats): void {
  if (!status.isFile()) throw new Error(`Run event log is not a regular file: ${path}`);
  if (status.nlink > 1n) throw new Error(`Run event log is multiply linked: ${path}`);
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  if (left.ino !== 0n && right.ino !== 0n) return left.dev === right.dev && left.ino === right.ino;
  return left.dev === right.dev && left.birthtimeNs === right.birthtimeNs;
}

function optionalHeldOutProbePlan(
  value: unknown,
  algorithm: CanonicalHashAlgorithm,
): HeldOutProbePlan | undefined {
  const parsed = HeldOutProbePlanSchema.safeParse(value);
  if (!parsed.success) return undefined;
  try {
    return validateHeldOutProbePlan(parsed.data, algorithm);
  } catch {
    return undefined;
  }
}

function eventWorkspaceScopeSnapshot(event: RunEvent): unknown | undefined {
  if (event.type === "invocation.started" || event.type === "semantic.started")
    return event.data.scopeBaseline;
  if (event.type === "scope.started") return event.data.baseline;
  if (event.type === "scope.checked") return event.data.current;
  return undefined;
}

function workspaceScopeSnapshotUsesDifferentHashPolicy(
  value: unknown,
  selected: CanonicalHashAlgorithm,
): boolean {
  const snapshot = parseWorkspaceScopeSnapshot(value);
  if (!snapshot || parseWorkspaceScopeSnapshot(snapshot, selected)) return false;
  // The alternate policy is only a rejection classifier. It is never used to
  // accept or relabel a snapshot that fails the manifest-selected policy.
  const other =
    selected === PORTABLE_CANONICAL_HASH_ALGORITHM
      ? LEGACY_CANONICAL_HASH_ALGORITHM
      : PORTABLE_CANONICAL_HASH_ALGORITHM;
  return parseWorkspaceScopeSnapshot(snapshot, other) !== undefined;
}

function probeEvidenceCheckpointUsesDifferentFormat(
  event: RunEvent,
  selected: CanonicalHashAlgorithm,
): boolean {
  if (event.type !== "run.created" && event.type !== "scope.started") return false;
  const format = event.data.probeEvidenceCheckpointFormat;
  return selected === PORTABLE_CANONICAL_HASH_ALGORITHM ? format !== 2 : format !== undefined;
}

function governanceControlIdentityUsesDifferentFormat(
  event: RunEvent,
  selected: CanonicalHashAlgorithm,
): boolean {
  if (event.type !== "run.created") return false;
  const format = event.data.governanceControlIdentityFormat;
  return selected === PORTABLE_CANONICAL_HASH_ALGORITHM ? format !== 2 : format !== undefined;
}

function repositorySideEffectIdentityUsesDifferentFormat(
  event: RunEvent,
  selected: CanonicalHashAlgorithm,
): boolean {
  if (event.type !== "run.created") return false;
  const format = event.data.repositorySideEffectIdentityFormat;
  return selected === PORTABLE_CANONICAL_HASH_ALGORITHM ? format !== 2 : format !== undefined;
}

export class RunStore {
  readonly repositoryRoot: string;
  readonly runId: string;
  readonly graphcraftRoot: string;
  readonly runRoot: string;
  readonly limits: RunStoreLimits;
  private artifactStore: RunArtifactStore | undefined;
  private appendTail: Promise<void> = Promise.resolve();
  private initializing = false;
  private storageReady: Promise<RunStorageManifest> | undefined;
  private _canonicalHashAlgorithm: CanonicalHashAlgorithm;
  private _heldOutProbePlanHashAlgorithm: CanonicalHashAlgorithm;
  private _artifactHashAlgorithm: CanonicalHashAlgorithm | undefined;
  private _workspaceScopeHashAlgorithm: CanonicalHashAlgorithm | undefined;
  private _probeEvidenceCheckpointHashAlgorithm: CanonicalHashAlgorithm | undefined;
  private _governanceControlIdentityHashAlgorithm: CanonicalHashAlgorithm | undefined;
  private _repositorySideEffectIdentityHashAlgorithm: CanonicalHashAlgorithm | undefined;

  constructor(
    repositoryRoot: string,
    runId: string,
    limits: Partial<RunStoreLimits> = {},
    canonicalHashAlgorithm: CanonicalHashAlgorithm = LEGACY_CANONICAL_HASH_ALGORITHM,
  ) {
    this.repositoryRoot = repositoryRoot;
    this.runId = runId;
    this.graphcraftRoot = join(repositoryRoot, ".graphcraft");
    this.runRoot = join(this.graphcraftRoot, "runs", runId);
    this.limits = normalizeLimits(limits);
    this._canonicalHashAlgorithm = canonicalHashAlgorithm;
    this._heldOutProbePlanHashAlgorithm = canonicalHashAlgorithm;
    for (const algorithm of [
      LEGACY_CANONICAL_HASH_ALGORITHM,
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    ] as const) {
      const blocker = this.createPersistenceLimitBlocker(1, "event_log", algorithm);
      const blockerBytes = Buffer.byteLength(serializedEvent(blocker));
      if (blockerBytes > this.limits.maxEventBytes)
        throw new Error("RunStore per-event limit cannot fit its durable blocked event");
      if (blockerBytes > this.limits.blockedEventReserveBytes)
        throw new Error("RunStore blocked-event reserve cannot fit its durable blocked event");
    }
  }

  private async validateStorageRoot(): Promise<void> {
    const graphcraftRoot = resolve(this.graphcraftRoot);
    const runRoot = resolve(this.runRoot);
    const validated = await validatePrivatePath(graphcraftRoot, relative(graphcraftRoot, runRoot));
    if (validated !== runRoot)
      throw new Error(`Run storage path escaped the Graphcraft state directory: ${this.runRoot}`);
  }

  async prepareStorage(): Promise<void> {
    await this.validateStorageRoot();
    if (this.initializing) return;
    const ready = (this.storageReady ??= ensureCurrentRunStorage({
      graphcraftRoot: this.graphcraftRoot,
      runRoot: this.runRoot,
      runId: this.runId,
    }));
    try {
      const manifest = await ready;
      if (manifest.schemaVersion !== 3)
        throw new Error("Run storage preparation did not return the current schema");
      this._canonicalHashAlgorithm = manifest.canonicalHashAlgorithm;
      this._heldOutProbePlanHashAlgorithm =
        manifest.formats.heldOutProbes === 2
          ? PORTABLE_CANONICAL_HASH_ALGORITHM
          : LEGACY_CANONICAL_HASH_ALGORITHM;
      const artifactHashAlgorithm =
        manifest.formats.artifactInventory === 2
          ? PORTABLE_CANONICAL_HASH_ALGORITHM
          : LEGACY_CANONICAL_HASH_ALGORITHM;
      this.bindArtifactHashAlgorithm(artifactHashAlgorithm);
      const workspaceScopeHashAlgorithm =
        manifest.formats.workspaceScopeSnapshots === 2
          ? PORTABLE_CANONICAL_HASH_ALGORITHM
          : LEGACY_CANONICAL_HASH_ALGORITHM;
      this.bindWorkspaceScopeHashAlgorithm(workspaceScopeHashAlgorithm);
      const probeEvidenceCheckpointHashAlgorithm =
        manifest.formats.probeEvidenceCheckpoints === 2
          ? PORTABLE_CANONICAL_HASH_ALGORITHM
          : LEGACY_CANONICAL_HASH_ALGORITHM;
      this.bindProbeEvidenceCheckpointHashAlgorithm(probeEvidenceCheckpointHashAlgorithm);
      const governanceControlIdentityHashAlgorithm =
        manifest.formats.governanceControlIdentities === 2
          ? PORTABLE_CANONICAL_HASH_ALGORITHM
          : LEGACY_CANONICAL_HASH_ALGORITHM;
      this.bindGovernanceControlIdentityHashAlgorithm(governanceControlIdentityHashAlgorithm);
      const repositorySideEffectIdentityHashAlgorithm =
        manifest.formats.repositorySideEffectIdentities === 2
          ? PORTABLE_CANONICAL_HASH_ALGORITHM
          : LEGACY_CANONICAL_HASH_ALGORITHM;
      this.bindRepositorySideEffectIdentityHashAlgorithm(repositorySideEffectIdentityHashAlgorithm);
      await this.validateStorageRoot();
    } catch (error) {
      if (this.storageReady === ready) this.storageReady = undefined;
      throw error;
    }
  }

  private async ensureStorage(): Promise<void> {
    await this.prepareStorage();
  }

  get canonicalHashAlgorithm(): CanonicalHashAlgorithm {
    return this._canonicalHashAlgorithm;
  }

  get heldOutProbePlanHashAlgorithm(): CanonicalHashAlgorithm {
    return this._heldOutProbePlanHashAlgorithm;
  }

  get artifactHashAlgorithm(): CanonicalHashAlgorithm {
    if (!this._artifactHashAlgorithm)
      throw new Error("Artifact hash policy is unavailable before run storage is prepared");
    return this._artifactHashAlgorithm;
  }

  get workspaceScopeHashAlgorithm(): CanonicalHashAlgorithm {
    if (!this._workspaceScopeHashAlgorithm)
      throw new Error("Workspace-scope hash policy is unavailable before run storage is prepared");
    return this._workspaceScopeHashAlgorithm;
  }

  get probeEvidenceCheckpointHashAlgorithm(): CanonicalHashAlgorithm {
    if (!this._probeEvidenceCheckpointHashAlgorithm)
      throw new Error(
        "Probe-evidence checkpoint hash policy is unavailable before run storage is prepared",
      );
    return this._probeEvidenceCheckpointHashAlgorithm;
  }

  get governanceControlIdentityHashAlgorithm(): CanonicalHashAlgorithm {
    if (!this._governanceControlIdentityHashAlgorithm)
      throw new Error(
        "Governance/control identity hash policy is unavailable before run storage is prepared",
      );
    return this._governanceControlIdentityHashAlgorithm;
  }

  get repositorySideEffectIdentityHashAlgorithm(): CanonicalHashAlgorithm {
    if (!this._repositorySideEffectIdentityHashAlgorithm)
      throw new Error(
        "Repository side-effect identity hash policy is unavailable before run storage is prepared",
      );
    return this._repositorySideEffectIdentityHashAlgorithm;
  }

  private bindArtifactHashAlgorithm(algorithm: CanonicalHashAlgorithm): void {
    if (this.artifactStore && this.artifactStore.hashAlgorithm !== algorithm)
      throw new Error("Artifact store was bound before its storage manifest policy was known");
    this._artifactHashAlgorithm = algorithm;
  }

  private bindWorkspaceScopeHashAlgorithm(algorithm: CanonicalHashAlgorithm): void {
    if (this._workspaceScopeHashAlgorithm && this._workspaceScopeHashAlgorithm !== algorithm)
      throw new Error(
        "Workspace-scope hashing was bound before its storage manifest policy was known",
      );
    this._workspaceScopeHashAlgorithm = algorithm;
  }

  private bindProbeEvidenceCheckpointHashAlgorithm(algorithm: CanonicalHashAlgorithm): void {
    if (
      this._probeEvidenceCheckpointHashAlgorithm &&
      this._probeEvidenceCheckpointHashAlgorithm !== algorithm
    )
      throw new Error(
        "Probe-evidence checkpoint hashing was bound before its storage manifest policy was known",
      );
    this._probeEvidenceCheckpointHashAlgorithm = algorithm;
  }

  private bindGovernanceControlIdentityHashAlgorithm(algorithm: CanonicalHashAlgorithm): void {
    if (
      this._governanceControlIdentityHashAlgorithm &&
      this._governanceControlIdentityHashAlgorithm !== algorithm
    )
      throw new Error(
        "Governance/control identity hashing was bound before its storage manifest policy was known",
      );
    this._governanceControlIdentityHashAlgorithm = algorithm;
  }

  private bindRepositorySideEffectIdentityHashAlgorithm(algorithm: CanonicalHashAlgorithm): void {
    if (
      this._repositorySideEffectIdentityHashAlgorithm &&
      this._repositorySideEffectIdentityHashAlgorithm !== algorithm
    )
      throw new Error(
        "Repository side-effect identity hashing was bound before its storage manifest policy was known",
      );
    this._repositorySideEffectIdentityHashAlgorithm = algorithm;
  }

  private artifacts(): RunArtifactStore {
    return (this.artifactStore ??= new RunArtifactStore(
      this.runRoot,
      this.runId,
      this.artifactHashAlgorithm,
    ));
  }

  contentHash(value: unknown): string {
    return contentHash(value, this._canonicalHashAlgorithm);
  }

  artifactContentHash(value: unknown): string {
    return contentHash(value, this.artifactHashAlgorithm);
  }

  private assertJsonProjectionFits(value: unknown, maximumBytes: number, label: string): void {
    const bytes = serializedJsonBytes(value);
    if (bytes > maximumBytes)
      throw new Error(`${label} requires ${bytes} serialized bytes, exceeding ${maximumBytes}`);
  }

  private async writeBoundedJson(
    relativePath: string,
    value: unknown,
    maximumBytes: number,
    label: string,
    supersessionPolicy: "strict" | "reconstructable_projection" = "strict",
  ): Promise<void> {
    const persisted = redactValue(value);
    this.assertJsonProjectionFits(persisted, maximumBytes, label);
    await writePrivateJsonAtomic(join(this.runRoot, relativePath), persisted, this.runRoot, {
      supersessionPolicy,
    });
  }

  private async readBoundedJson(relativePath: string, maximumBytes: number): Promise<unknown> {
    const bytes = await readPrivateFileBounded(
      join(this.runRoot, relativePath),
      maximumBytes,
      this.runRoot,
    );
    return JSON.parse(bytes.toString("utf8"));
  }

  private async readOptionalBoundedJson(
    relativePath: string,
    maximumBytes: number,
  ): Promise<unknown | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readPrivateFileBounded(
        join(this.runRoot, relativePath),
        maximumBytes,
        this.runRoot,
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as Error).message.includes("bounded read limit")
      )
        return undefined;
      throw error;
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  static async create(
    repositoryRoot: string,
    contract: RunContract,
    graph: Graph,
    inputProbePlan?: ProbePlan,
    inputHeldOutProbePlan?: HeldOutProbePlan,
    limits: Partial<RunStoreLimits> = {},
  ): Promise<RunStore> {
    const store = new RunStore(
      repositoryRoot,
      contract.runId,
      limits,
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );
    store.initializing = true;
    store.bindArtifactHashAlgorithm(PORTABLE_CANONICAL_HASH_ALGORITHM);
    store.bindWorkspaceScopeHashAlgorithm(PORTABLE_CANONICAL_HASH_ALGORITHM);
    store.bindProbeEvidenceCheckpointHashAlgorithm(PORTABLE_CANONICAL_HASH_ALGORITHM);
    store.bindGovernanceControlIdentityHashAlgorithm(PORTABLE_CANONICAL_HASH_ALGORITHM);
    store.bindRepositorySideEffectIdentityHashAlgorithm(PORTABLE_CANONICAL_HASH_ALGORITHM);
    const persistedContract = RunContractSchema.parse(redactValue(contract));
    const persistedGraph = GraphSchema.parse(redactValue(graph));
    const probePlan = ProbePlanSchema.parse(inputProbePlan ?? probePlanFromGraph(graph));
    const heldOutProbePlan = inputHeldOutProbePlan
      ? validateHeldOutProbePlan(inputHeldOutProbePlan, store.heldOutProbePlanHashAlgorithm)
      : createHeldOutProbePlan(contract.runId, probePlan, {}, store.heldOutProbePlanHashAlgorithm);
    assertPersistenceSafe(probePlan, "Probe plan");
    assertPersistenceSafe(heldOutProbePlan, "Held-out probe plan");
    store.assertJsonProjectionFits(persistedContract, RUN_METADATA_MAX_BYTES, "Run contract");
    store.assertJsonProjectionFits(persistedGraph, RUN_METADATA_MAX_BYTES, "Run graph");
    store.assertJsonProjectionFits(probePlan, RUN_METADATA_MAX_BYTES, "Probe plan");
    await ensurePrivateDirectory(store.graphcraftRoot);
    await Promise.all([
      ensurePrivateDirectory(join(store.graphcraftRoot, "runs")),
      ensurePrivateDirectory(join(store.graphcraftRoot, "locks")),
    ]);
    await ensurePrivateDirectory(store.runRoot);
    await Promise.all([
      ensurePrivateDirectory(join(store.runRoot, "artifacts")),
      ensurePrivateDirectory(join(store.runRoot, "capsules")),
      ensurePrivateDirectory(join(store.runRoot, "reports")),
    ]);
    await store.artifacts().initialize();
    await writeInitializingRunStorageManifest(store.runRoot, store.runId);
    const event = createRunEvent(
      {
        sequence: 1,
        actor: "runtime",
        causationId: contract.runId,
        type: "run.created",
        data: {
          contract: persistedContract,
          graph: persistedGraph,
          probePlan,
          heldOutProbePlan,
          nodeIds: graph.nodes.map(({ id }) => id),
          probeEvidenceCheckpointFormat: 2,
          governanceControlIdentityFormat: 2,
          repositorySideEffectIdentityFormat: 2,
        },
      },
      store.canonicalHashAlgorithm,
    );
    const eventLine = serializedEvent(event);
    store.assertNormalEventCapacity(0, eventLine);
    const state = RunStateSchema.parse(reduceEvents([event]));
    store.assertNormalStateCapacity(state, event.sequence + 1);
    store.assertJsonProjectionFits(heldOutProbePlan, RUN_METADATA_MAX_BYTES, "Held-out probe plan");
    await Promise.all([
      store.saveContract(persistedContract),
      store.saveGraph(persistedGraph),
      store.saveProbePlan(probePlan),
      store.saveHeldOutProbePlan(heldOutProbePlan),
    ]);
    await store.appendEventLine(eventLine, 0);
    await store.writeMaterializedState(state);
    await writeCurrentRunStorageManifest(store.runRoot, store.runId, 3);
    store.initializing = false;
    return store;
  }

  eventsPath(): string {
    return join(this.runRoot, "events.jsonl");
  }

  private createPersistenceLimitBlocker(
    sequence: number,
    kind: RunStoreLimitKind,
    algorithm: CanonicalHashAlgorithm = this.canonicalHashAlgorithm,
  ): RunEvent {
    return createRunEvent(
      {
        sequence,
        actor: "runtime",
        causationId: this.runId,
        type: "run.blocked",
        data: {
          reason: PERSISTENCE_LIMIT_BLOCK_REASON,
          persistenceLimit: kind,
        },
      },
      algorithm,
    );
  }

  private persistenceBlockedState(state: RunState, blocker: RunEvent): RunState {
    const { progressDecision: _progressDecision, ...rest } = state;
    return RunStateSchema.parse({
      ...rest,
      status: "blocked",
      stopReason: PERSISTENCE_LIMIT_BLOCK_REASON,
      lastEventSequence: blocker.sequence,
      updatedAt: blocker.timestamp,
    });
  }

  private assertBlockerEventFits(blockerLine: string): void {
    const bytes = Buffer.byteLength(blockerLine);
    if (bytes > this.limits.maxEventBytes)
      throw new Error("RunStore per-event limit cannot fit its durable blocked event");
    if (bytes > this.limits.blockedEventReserveBytes)
      throw new Error("RunStore blocked-event reserve cannot fit its durable blocked event");
  }

  private assertNormalEventCapacity(currentLogBytes: number, eventLine: string): void {
    const eventBytes = Buffer.byteLength(eventLine);
    if (eventBytes > this.limits.maxEventBytes)
      throw new RunStoreLimitError("event", eventBytes, this.limits.maxEventBytes);
    const normalLogLimit = this.limits.maxEventLogBytes - this.limits.blockedEventReserveBytes;
    const candidateLogBytes = currentLogBytes + eventBytes;
    if (candidateLogBytes > normalLogLimit)
      throw new RunStoreLimitError("event_log", candidateLogBytes, normalLogLimit);
  }

  private assertNormalStateCapacity(state: RunState, blockerSequence: number): void {
    const stateBytes = serializedStateBytes(state);
    if (stateBytes > this.limits.maxStateBytes)
      throw new RunStoreLimitError("state", stateBytes, this.limits.maxStateBytes);

    const blocker = this.createPersistenceLimitBlocker(blockerSequence, "state");
    this.assertBlockerEventFits(serializedEvent(blocker));
    const blockedStateBytes = serializedStateBytes(this.persistenceBlockedState(state, blocker));
    if (blockedStateBytes > this.limits.maxStateBytes)
      throw new RunStoreLimitError("state", blockedStateBytes, this.limits.maxStateBytes);
  }

  private async appendEventLine(line: string, expectedLogBytes: number): Promise<void> {
    await validatePrivatePath(this.runRoot, "events.jsonl");
    const aclMutation = await preparePrivateFileMutation(this.eventsPath(), this.runRoot);
    let created = false;
    let observed: BigIntStats | undefined;
    let handle;
    const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    try {
      handle = await open(
        this.eventsPath(),
        fsConstants.O_WRONLY |
          fsConstants.O_APPEND |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          noFollow,
        0o600,
      );
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await validatePrivatePath(this.runRoot, "events.jsonl");
      observed = await lstat(this.eventsPath(), { bigint: true });
      assertEventLogFile(this.eventsPath(), observed);
      handle = await open(
        this.eventsPath(),
        fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollow,
        0o600,
      );
    }
    try {
      const before = await handle.stat({ bigint: true });
      assertEventLogFile(this.eventsPath(), before);
      if (observed && !sameFileIdentity(observed, before))
        throw new Error("Run event log changed before its append descriptor was opened");
      const pathBefore = await lstat(this.eventsPath(), { bigint: true });
      assertEventLogFile(this.eventsPath(), pathBefore);
      if (!sameFileIdentity(before, pathBefore))
        throw new Error("Run event log path changed before append");
      if (before.size !== BigInt(expectedLogBytes))
        throw new Error("Run event log size changed before append");
      await handle.writeFile(line, "utf8");
      await handle.sync();
      const after = await handle.stat({ bigint: true });
      const pathAfter = await lstat(this.eventsPath(), { bigint: true });
      assertEventLogFile(this.eventsPath(), after);
      assertEventLogFile(this.eventsPath(), pathAfter);
      if (!sameFileIdentity(after, pathAfter))
        throw new Error("Run event log path changed during append");
      if (after.size !== before.size + BigInt(Buffer.byteLength(line)))
        throw new Error("Run event log append did not persist exactly one event line");
    } finally {
      try {
        await handle.close();
      } finally {
        await finalizePrivateFileMutation(aclMutation, this.runRoot);
      }
    }
    if (created) await syncDirectory(this.runRoot);
  }

  async saveContract(contract: RunContract): Promise<void> {
    await this.ensureStorage();
    await this.writeBoundedJson(
      "contract.json",
      RunContractSchema.parse(redactValue(contract)),
      RUN_METADATA_MAX_BYTES,
      "Run contract",
    );
  }

  async loadContract(): Promise<RunContract> {
    await this.ensureStorage();
    return RunContractSchema.parse(
      await this.readBoundedJson("contract.json", RUN_METADATA_MAX_BYTES),
    );
  }

  async saveGraph(graph: Graph): Promise<void> {
    await this.ensureStorage();
    await this.writeBoundedJson(
      "graph.json",
      GraphSchema.parse(redactValue(graph)),
      RUN_METADATA_MAX_BYTES,
      "Run graph",
      "reconstructable_projection",
    );
  }

  async loadGraph(): Promise<Graph> {
    await this.ensureStorage();
    const events = await this.loadEvents();
    const eventGraph = events.findLast(
      (event) =>
        (event.type === "run.created" || event.type === "graph.amended") && event.data.graph,
    )?.data.graph;
    if (eventGraph) {
      const graph = GraphSchema.parse(eventGraph);
      const parsedMaterialized = GraphSchema.safeParse(
        await this.readOptionalBoundedJson("graph.json", RUN_METADATA_MAX_BYTES),
      );
      const materialized = parsedMaterialized.success ? parsedMaterialized.data : undefined;
      if (JSON.stringify(materialized) !== JSON.stringify(graph)) await this.saveGraph(graph);
      return graph;
    }
    return GraphSchema.parse(await this.readBoundedJson("graph.json", RUN_METADATA_MAX_BYTES));
  }

  async saveProbePlan(probePlan: ProbePlan): Promise<void> {
    await this.ensureStorage();
    assertPersistenceSafe(probePlan, "Probe plan");
    await this.writeBoundedJson(
      "probe-plan.json",
      ProbePlanSchema.parse(probePlan),
      RUN_METADATA_MAX_BYTES,
      "Probe plan",
      "reconstructable_projection",
    );
  }

  async loadProbePlan(): Promise<ProbePlan> {
    await this.ensureStorage();
    const events = await this.loadEvents();
    const eventPlan = events.findLast(
      (event) =>
        (event.type === "run.created" || event.type === "graph.amended") && event.data.probePlan,
    )?.data.probePlan;
    if (eventPlan) {
      const probePlan = ProbePlanSchema.parse(eventPlan);
      const parsedMaterialized = ProbePlanSchema.safeParse(
        await this.readOptionalBoundedJson("probe-plan.json", RUN_METADATA_MAX_BYTES),
      );
      const materialized = parsedMaterialized.success ? parsedMaterialized.data : undefined;
      if (JSON.stringify(materialized) !== JSON.stringify(probePlan))
        await this.saveProbePlan(probePlan);
      return probePlan;
    }
    const parsedMaterialized = ProbePlanSchema.safeParse(
      await this.readOptionalBoundedJson("probe-plan.json", RUN_METADATA_MAX_BYTES),
    );
    return parsedMaterialized.success
      ? parsedMaterialized.data
      : probePlanFromGraph(await this.loadGraph());
  }

  async saveHeldOutProbePlan(heldOutProbePlan: HeldOutProbePlan): Promise<void> {
    await this.ensureStorage();
    assertPersistenceSafe(heldOutProbePlan, "Held-out probe plan");
    await this.writeBoundedJson(
      "held-out-probes.json",
      validateHeldOutProbePlan(heldOutProbePlan, this.heldOutProbePlanHashAlgorithm),
      RUN_METADATA_MAX_BYTES,
      "Held-out probe plan",
      "reconstructable_projection",
    );
  }

  async loadHeldOutProbePlan(): Promise<HeldOutProbePlan> {
    await this.ensureStorage();
    const events = await this.loadEvents();
    const eventPlan = events.findLast(
      (event) =>
        (event.type === "run.created" || event.type === "graph.amended") &&
        event.data.heldOutProbePlan,
    )?.data.heldOutProbePlan;
    if (eventPlan) {
      const heldOutProbePlan = validateHeldOutProbePlan(
        HeldOutProbePlanSchema.parse(eventPlan),
        this.heldOutProbePlanHashAlgorithm,
      );
      const materialized = optionalHeldOutProbePlan(
        await this.readOptionalBoundedJson("held-out-probes.json", RUN_METADATA_MAX_BYTES),
        this.heldOutProbePlanHashAlgorithm,
      );
      if (JSON.stringify(materialized) !== JSON.stringify(heldOutProbePlan))
        await this.saveHeldOutProbePlan(heldOutProbePlan);
      return heldOutProbePlan;
    }
    return (
      optionalHeldOutProbePlan(
        await this.readOptionalBoundedJson("held-out-probes.json", RUN_METADATA_MAX_BYTES),
        this.heldOutProbePlanHashAlgorithm,
      ) ??
      createHeldOutProbePlan(
        this.runId,
        await this.loadProbePlan(),
        {},
        this.heldOutProbePlanHashAlgorithm,
      )
    );
  }

  private async loadEventLog(): Promise<{
    events: RunEvent[];
    bytes: number;
    needsDelimiter: boolean;
  }> {
    await this.ensureStorage();
    await validatePrivatePath(this.runRoot, "events.jsonl");
    let contentBytes: Buffer;
    for (let attempt = 0; ; attempt += 1) {
      try {
        contentBytes = await readPrivateFileBounded(
          this.eventsPath(),
          this.limits.maxEventLogBytes,
          this.runRoot,
        );
        break;
      } catch (error) {
        if ((error as Error).message.includes("bounded read limit"))
          throw new RunStoreLimitError(
            "event_log",
            this.limits.maxEventLogBytes + 1,
            this.limits.maxEventLogBytes,
          );
        const message = error instanceof Error ? error.message : "";
        if (
          attempt >= 7 ||
          (message !== "Private file changed before its bounded read" &&
            message !== "Private file changed during its bounded read")
        )
          throw error;
        await new Promise<void>((resolveRetry) => setImmediate(resolveRetry));
      }
    }
    const bytes = contentBytes.byteLength;
    const needsDelimiter = bytes > 0 && contentBytes.at(-1) !== 0x0a;
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const events: RunEvent[] = [];
    let offset = 0;
    while (offset < bytes) {
      const newline = contentBytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes : newline;
      const recordBytes = contentBytes.subarray(offset, end);
      if (recordBytes.byteLength === 0) {
        if (newline === -1) break;
        offset = newline + 1;
        continue;
      }
      const record = events.length + 1;
      const trailing = newline === -1;
      const lineBytes = recordBytes.byteLength + 1;
      if (lineBytes > this.limits.maxEventBytes)
        throw new RunStoreLimitError("event", lineBytes, this.limits.maxEventBytes);
      let decoded: string;
      try {
        decoded = decoder.decode(recordBytes);
      } catch {
        throw new RunStoreEventLogCorruptionError(record, offset, trailing, "encoding");
      }
      let value: unknown;
      try {
        value = JSON.parse(decoded);
      } catch {
        throw new RunStoreEventLogCorruptionError(record, offset, trailing, "json");
      }
      const parsed = RunEventSchema.safeParse(value);
      if (!parsed.success)
        throw new RunStoreEventLogCorruptionError(record, offset, trailing, "schema");
      try {
        verifyRunEvent(parsed.data);
      } catch {
        throw new RunStoreEventLogCorruptionError(record, offset, trailing, "hash");
      }
      const event = parsed.data;
      const expectedEventSchemaVersion =
        this.canonicalHashAlgorithm === PORTABLE_CANONICAL_HASH_ALGORITHM ? 2 : 1;
      if (event.schemaVersion !== expectedEventSchemaVersion)
        throw new RunStoreEventLogCorruptionError(record, offset, trailing, "format");
      if (event.sequence !== record)
        throw new RunStoreEventLogCorruptionError(record, offset, trailing, "sequence");
      if (
        probeEvidenceCheckpointUsesDifferentFormat(event, this.probeEvidenceCheckpointHashAlgorithm)
      )
        throw new RunStoreEventLogCorruptionError(record, offset, trailing, "checkpoint");
      if (
        governanceControlIdentityUsesDifferentFormat(
          event,
          this.governanceControlIdentityHashAlgorithm,
        )
      )
        throw new RunStoreEventLogCorruptionError(record, offset, trailing, "governance");
      if (
        repositorySideEffectIdentityUsesDifferentFormat(
          event,
          this.repositorySideEffectIdentityHashAlgorithm,
        )
      )
        throw new RunStoreEventLogCorruptionError(
          record,
          offset,
          trailing,
          "repository_side_effect",
        );
      const scopeSnapshot = eventWorkspaceScopeSnapshot(event);
      if (
        scopeSnapshot !== undefined &&
        workspaceScopeSnapshotUsesDifferentHashPolicy(
          scopeSnapshot,
          this.workspaceScopeHashAlgorithm,
        )
      )
        throw new RunStoreEventLogCorruptionError(record, offset, trailing, "scope");
      events.push(event);
      if (newline === -1) break;
      offset = newline + 1;
    }
    return { events, bytes, needsDelimiter };
  }

  async loadEvents(): Promise<RunEvent[]> {
    return (await this.loadEventLog()).events;
  }

  async loadState(): Promise<RunState> {
    await this.ensureStorage();
    const events = await this.loadEvents();
    const authoritative = RunStateSchema.parse(reduceEvents(events));
    const authoritativeBytes = serializedStateBytes(authoritative);
    if (authoritativeBytes > this.limits.maxStateBytes)
      throw new RunStoreLimitError("state", authoritativeBytes, this.limits.maxStateBytes);
    const statePath = join(this.runRoot, "state.json");
    let materialized: RunState | undefined;
    let materializedBytes: Buffer | undefined;
    try {
      materializedBytes = await readPrivateFileBounded(
        statePath,
        this.limits.maxStateBytes,
        this.runRoot,
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error as Error).message.includes("bounded read limit")
      )
        throw error;
    }
    if (materializedBytes) {
      try {
        const parsed = RunStateSchema.safeParse(JSON.parse(materializedBytes.toString("utf8")));
        materialized = parsed.success ? parsed.data : undefined;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (!materialized || this.contentHash(materialized) !== this.contentHash(authoritative))
      await this.writeMaterializedState(authoritative);
    return authoritative;
  }

  async append(
    actor: RunEvent["actor"],
    type: RunEvent["type"],
    data: Record<string, unknown>,
    causationId = this.runId,
  ): Promise<RunEvent> {
    await this.ensureStorage();
    const operation = this.appendTail.then(async () => {
      const { events, bytes: currentLogBytes, needsDelimiter } = await this.loadEventLog();
      const previous = events.at(-1);
      if (isPersistenceLimitBlocker(previous)) {
        const kind = String(previous?.data.persistenceLimit) as RunStoreLimitKind;
        const limitBytes =
          kind === "event"
            ? this.limits.maxEventBytes
            : kind === "state"
              ? this.limits.maxStateBytes
              : this.limits.maxEventLogBytes - this.limits.blockedEventReserveBytes;
        const error = new RunStoreLimitError(kind, limitBytes + 1, limitBytes);
        error.blockerPersisted = true;
        throw error;
      }
      const event = createRunEvent(
        {
          sequence: events.length + 1,
          actor,
          causationId,
          type,
          data: redactValue(data) as Record<string, unknown>,
        },
        this.canonicalHashAlgorithm,
      );
      const eventLine = serializedEvent(event);
      let state: RunState;
      try {
        this.assertNormalEventCapacity(currentLogBytes + (needsDelimiter ? 1 : 0), eventLine);
        state = RunStateSchema.parse(reduceEvents([...events, event]));
        this.assertNormalStateCapacity(state, event.sequence + 1);
      } catch (error) {
        if (!(error instanceof RunStoreLimitError)) throw error;
        await this.persistPersistenceLimitBlocker(events, currentLogBytes, error, needsDelimiter);
        throw error;
      }
      await this.appendEventLine(`${needsDelimiter ? "\n" : ""}${eventLine}`, currentLogBytes);
      await this.writeMaterializedState(state);
      return event;
    });
    this.appendTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  private async persistPersistenceLimitBlocker(
    events: RunEvent[],
    currentLogBytes: number,
    limitError: RunStoreLimitError,
    needsDelimiter: boolean,
  ): Promise<void> {
    const previous = events.at(-1);
    if (isPersistenceLimitBlocker(previous)) {
      limitError.blockerPersisted = true;
      return;
    }
    const blocker = this.createPersistenceLimitBlocker(events.length + 1, limitError.kind);
    const blockerLine = serializedEvent(blocker);
    this.assertBlockerEventFits(blockerLine);
    const blockerBytes = Buffer.byteLength(blockerLine);
    const blockedLogBytes = currentLogBytes + (needsDelimiter ? 1 : 0) + blockerBytes;
    if (blockedLogBytes > this.limits.maxEventLogBytes)
      throw new RunStoreLimitError("event_log", blockedLogBytes, this.limits.maxEventLogBytes);
    const state = RunStateSchema.parse(reduceEvents([...events, blocker]));
    const stateBytes = serializedStateBytes(state);
    if (stateBytes > this.limits.maxStateBytes)
      throw new RunStoreLimitError("state", stateBytes, this.limits.maxStateBytes);
    await this.appendEventLine(`${needsDelimiter ? "\n" : ""}${blockerLine}`, currentLogBytes);
    limitError.blockerPersisted = true;
    await this.writeMaterializedState(state);
  }

  async rebuildViews(): Promise<RunState> {
    await this.ensureStorage();
    const events = await this.loadEvents();
    const createdGraph = GraphSchema.parse(events[0]?.data.graph);
    let graph = createdGraph;
    let probePlan = events[0]?.data.probePlan
      ? ProbePlanSchema.parse(events[0].data.probePlan)
      : probePlanFromGraph(createdGraph);
    let heldOutProbePlan = events[0]?.data.heldOutProbePlan
      ? validateHeldOutProbePlan(
          HeldOutProbePlanSchema.parse(events[0].data.heldOutProbePlan),
          this.heldOutProbePlanHashAlgorithm,
        )
      : createHeldOutProbePlan(this.runId, probePlan, {}, this.heldOutProbePlanHashAlgorithm);
    for (const event of events) {
      if (event.type === "graph.amended" && event.data.graph) {
        graph = GraphSchema.parse(event.data.graph);
        if (event.data.probePlan) probePlan = ProbePlanSchema.parse(event.data.probePlan);
        if (event.data.heldOutProbePlan)
          heldOutProbePlan = validateHeldOutProbePlan(
            HeldOutProbePlanSchema.parse(event.data.heldOutProbePlan),
            this.heldOutProbePlanHashAlgorithm,
          );
      }
    }
    await Promise.all([
      this.saveGraph(graph),
      this.saveProbePlan(probePlan),
      this.saveHeldOutProbePlan(heldOutProbePlan),
    ]);
    return await this.materialize(events);
  }

  async writeArtifact(relativePath: string, value: string | Uint8Array): Promise<string> {
    await this.ensureStorage();
    return (await this.artifacts().writeArtifact(relativePath, value)).path;
  }

  async appendInvocationEvent(invocationId: string, event: HostEvent): Promise<string> {
    await this.ensureStorage();
    return (await this.artifacts().appendInvocationEvent(invocationId, event)).path;
  }

  async loadInvocationEvents(invocationId: string): Promise<HostEvent[]> {
    await this.ensureStorage();
    return await this.artifacts().loadInvocationEvents(invocationId);
  }

  async loadGraphHistory(): Promise<GraphRevisionRecord[]> {
    await this.ensureStorage();
    const events = await this.loadEvents();
    let previous = GraphSchema.parse(events[0]?.data.graph);
    const history: GraphRevisionRecord[] = [];
    for (const event of events) {
      if (event.type !== "graph.amended" || !event.data.graph) continue;
      const graph = GraphSchema.parse(event.data.graph);
      if (graph.revision !== previous.revision + 1)
        throw new Error(
          `Expected graph revision ${previous.revision + 1}, received ${graph.revision}`,
        );
      const previousById = new Map(previous.nodes.map((item) => [item.id, item]));
      const nextById = new Map(graph.nodes.map((item) => [item.id, item]));
      const diff = {
        addedNodeIds: [...nextById.keys()].filter((id) => !previousById.has(id)).sort(),
        removedNodeIds: [...previousById.keys()].filter((id) => !nextById.has(id)).sort(),
        changedNodeIds: [...previousById.keys()]
          .filter(
            (id) =>
              nextById.has(id) &&
              JSON.stringify(previousById.get(id)) !== JSON.stringify(nextById.get(id)),
          )
          .sort(),
      };
      const amendment = GraphAmendmentRecordSchema.safeParse(event.data.amendment);
      if (
        amendment.success &&
        (amendment.data.previousRevision !== previous.revision ||
          amendment.data.nextRevision !== graph.revision)
      )
        throw new Error("Graph amendment record does not match its persisted revisions");
      history.push(
        GraphRevisionRecordSchema.parse({
          schemaVersion: 1,
          eventSequence: event.sequence,
          timestamp: event.timestamp,
          actor: event.actor,
          previousRevision: previous.revision,
          nextRevision: graph.revision,
          rationale:
            typeof event.data.rationale === "string"
              ? event.data.rationale
              : "Graph revision persisted without a rationale",
          evidence: Array.isArray(event.data.evidence)
            ? event.data.evidence.map((value) =>
                typeof value === "string" ? value : JSON.stringify(value),
              )
            : [],
          diff,
          ...(amendment.success ? { amendment: amendment.data } : {}),
        }),
      );
      previous = graph;
    }
    return history;
  }

  async writeCapsule(hash: string, value: unknown): Promise<{ path: string; reused: boolean }> {
    await this.ensureStorage();
    const persistedValue = redactValue(value);
    if (this.artifactContentHash(persistedValue) !== hash)
      throw new Error("Context capsule must be redacted before content addressing");
    const result = await this.artifacts().writeIdentityArtifact({
      relativePath: `capsules/${hash}.json`,
      value: `${JSON.stringify(persistedValue, null, 2)}\n`,
      kind: "capsule",
    });
    return { path: result.path, reused: result.reused };
  }

  async writeContentAddressedArtifact(
    category: string,
    value: string | Uint8Array,
    extension = "json",
  ): Promise<{ path: string; hash: string; reused: boolean }> {
    await this.ensureStorage();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(category) || !/^[a-z0-9]+$/.test(extension))
      throw new Error("Content-addressed artifact category or extension is invalid");
    const bytes = redactTextBytes(value);
    const hash = this.artifactContentHash({ contents: bytes.toString("base64") });
    const result = await this.artifacts().writeIdentityArtifact({
      relativePath: `artifacts/${category}/${hash}.${extension}`,
      value: bytes,
      kind: "content_addressed",
    });
    return { path: result.path, hash, reused: result.reused };
  }

  async loadArtifactInventory(): Promise<ArtifactInventory> {
    await this.ensureStorage();
    return ArtifactInventorySchema.parse(await this.artifacts().inventory());
  }

  async readArtifactPreview(relativePath: string, maxBytes: number): Promise<ArtifactPreview> {
    await this.ensureStorage();
    return await this.artifacts().readArtifactPreview(`artifacts/${relativePath}`, maxBytes);
  }

  async writeWorkspace(value: unknown): Promise<void> {
    await this.ensureStorage();
    await this.writeBoundedJson("workspace.json", value, RUN_WORKSPACE_MAX_BYTES, "Run workspace");
  }

  async loadWorkspace<T>(): Promise<T> {
    await this.ensureStorage();
    return (await this.readBoundedJson("workspace.json", RUN_WORKSPACE_MAX_BYTES)) as T;
  }

  private async materialize(events: RunEvent[]): Promise<RunState> {
    const state = RunStateSchema.parse(reduceEvents(events));
    await this.writeMaterializedState(state);
    return state;
  }

  private async writeMaterializedState(state: RunState): Promise<void> {
    const bytes = serializedStateBytes(state);
    if (bytes > this.limits.maxStateBytes)
      throw new RunStoreLimitError("state", bytes, this.limits.maxStateBytes);
    await writePrivateJsonAtomic(join(this.runRoot, "state.json"), state, this.runRoot, {
      supersessionPolicy: "reconstructable_projection",
    });
  }
}

export async function listRunIds(repositoryRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(repositoryRoot, ".graphcraft", "runs"), {
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function resolveRunId(repositoryRoot: string, reference?: string): Promise<string> {
  const ids = await listRunIds(repositoryRoot);
  if (ids.length === 0) throw new Error("No Graphcraft runs exist in this repository");
  if (!reference) {
    const states = await Promise.all(
      ids.map(async (runId) => ({
        runId,
        state: await new RunStore(repositoryRoot, runId).loadState(),
      })),
    );
    states.sort((left, right) => right.state.updatedAt.localeCompare(left.state.updatedAt));
    return states[0]!.runId;
  }
  const matches = ids.filter((id) => id === reference || id.startsWith(reference));
  if (matches.length !== 1)
    throw new Error(`Run reference ${reference} matched ${matches.length} runs`);
  return matches[0]!;
}
