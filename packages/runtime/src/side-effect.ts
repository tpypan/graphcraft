import { constants as osConstants } from "node:os";
import {
  SideEffectClaimSchema,
  contentHash,
  type CanonicalHashAlgorithm,
  type RunEvent,
  type SideEffectClaim,
  type SideEffectJournalEntry,
} from "@graphcraft/core";
import type {
  ManagedProcessLifecycle,
  ManagedProcessReady,
  ManagedProcessSettlement,
} from "@graphcraft/probes";
import {
  closeSideEffectProcessLease,
  createSideEffectProcessDefinition,
  createSideEffectProcessLease,
  inspectSideEffectProcessJournal,
  parseSideEffectProcessDefinition,
  readSideEffectProcessDefinition,
  removeSideEffectProcessJournal,
  waitForSideEffectProcessSettlement,
  type SideEffectProcessDefinition,
  type SideEffectProcessJournalInspection,
  type SideEffectProcessLease,
} from "./side-effect-process.ts";
import { RunStore } from "./store.ts";

export type SideEffectBoundary =
  | "before_claim"
  | "after_claim"
  | "after_precondition_reconcile"
  | "before_act"
  | "after_action_prepare"
  | "after_action_dispatch"
  | "after_action_command"
  | "after_act"
  | "after_confirmation_reconcile"
  | "after_confirm"
  | "after_node_acceptance";

export type SideEffectDispatchPolicy = "reconcile_then_retry" | "at_most_once";

export type SideEffectAuthorizationPhase = "precondition" | "dispatch" | "settlement";

export interface SideEffectCancellation {
  outcome: "cancelled_before_spawn" | "terminated" | "unconfirmed" | "failed";
  childSettlement: "confirmed" | "unconfirmed";
}

export interface SideEffectInterruptionReceipt {
  actionId: string;
  kind: SideEffectClaim["kind"];
  dispatchPolicy: SideEffectDispatchPolicy;
  dispatched: boolean;
  childSettlement: "not_started" | "confirmed" | "unconfirmed";
  reconciliation: "not_attempted" | SideEffectReconciliation["status"];
  disposition: "checkpointed" | "confirmed" | "retryable" | "uncertain";
}

export type SideEffectReconciliation =
  | { status: "applied"; result: Record<string, unknown>; evidence: string[] }
  | { status: "not_applied"; evidence: string[] }
  | { status: "unknown"; evidence: string[] };

export interface ExecuteSideEffectInput {
  store: RunStore;
  claim: SideEffectClaim;
  authorize?: (phase: SideEffectAuthorizationPhase) => Promise<void>;
  reconcile: (claim: SideEffectClaim) => Promise<SideEffectReconciliation>;
  act: (
    claim: SideEffectClaim,
    markDispatched: SideEffectDispatch,
  ) => Promise<Record<string, unknown>>;
  dispatchPolicy: SideEffectDispatchPolicy;
  boundary?: (point: SideEffectBoundary) => void | Promise<void>;
  revalidateConfirmed?: boolean;
  deferError?: (error: unknown) => boolean;
  signal?: AbortSignal;
  classifyCancellation?: (error: unknown) => SideEffectCancellation | undefined;
}

export interface SideEffectProcessRequest {
  managedProcess: true;
}

export type SideEffectDispatch = (
  request?: SideEffectProcessRequest,
) => Promise<ManagedProcessLifecycle | void>;

export class SideEffectBoundaryInterruption extends Error {
  constructor(
    readonly point: SideEffectBoundary,
    options?: ErrorOptions,
  ) {
    super(`Side-effect execution interrupted after ${point}`, options);
    this.name = "SideEffectBoundaryInterruption";
  }
}

export class SideEffectInterruption extends Error {
  constructor(readonly receipt: SideEffectInterruptionReceipt) {
    super(`Side-effect ${receipt.kind} ${receipt.actionId} was interrupted safely`);
    this.name = "SideEffectInterruption";
  }
}

class SideEffectProcessCleanupError extends Error {
  constructor(
    message: string,
    readonly childSettlement: "confirmed" | "unconfirmed",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SideEffectProcessCleanupError";
  }
}

function journalEntry(
  entries: SideEffectJournalEntry[],
  actionId: string,
): SideEffectJournalEntry | undefined {
  return entries.find(({ claim }) => claim.actionId === actionId);
}

const sideEffectProcessEventTypes = new Set<RunEvent["type"]>([
  "side_effect.process.started",
  "side_effect.process.finished",
  "side_effect.process.reconciled",
]);

const managedPlatforms = new Set([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
]);

function strictRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function positivePid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function parseManagedReady(value: unknown, executionId: string): ManagedProcessReady | undefined {
  const record = strictRecord(value);
  if (
    !record ||
    !exactKeys(record, [
      "type",
      "schemaVersion",
      "executionId",
      "brokerPid",
      "processGroupId",
      "platform",
      "readyAt",
    ]) ||
    record.type !== "ready" ||
    record.schemaVersion !== 1 ||
    record.executionId !== executionId ||
    !positivePid(record.brokerPid) ||
    (record.processGroupId !== null && !positivePid(record.processGroupId)) ||
    !managedPlatforms.has(String(record.platform)) ||
    typeof record.readyAt !== "string" ||
    !Number.isFinite(Date.parse(record.readyAt))
  )
    return undefined;
  return {
    schemaVersion: 1,
    executionId,
    brokerPid: record.brokerPid,
    processGroupId: record.processGroupId as number | null,
    platform: record.platform as NodeJS.Platform,
    readyAt: record.readyAt,
  };
}

function parseManagedSettlement(
  value: unknown,
  executionId: string,
): ManagedProcessSettlement | undefined {
  const record = strictRecord(value);
  if (
    !record ||
    !exactKeys(record, [
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
    record.schemaVersion !== 1 ||
    record.executionId !== executionId ||
    !positivePid(record.brokerPid) ||
    (record.childPid !== null && !positivePid(record.childPid)) ||
    !["exited", "terminated", "cancelled_before_start", "failed_to_start", "unconfirmed"].includes(
      String(record.outcome),
    ) ||
    typeof record.confirmed !== "boolean" ||
    (record.exitCode !== null && !Number.isInteger(record.exitCode)) ||
    (record.exitSignal !== null &&
      (typeof record.exitSignal !== "string" ||
        !Object.prototype.hasOwnProperty.call(osConstants.signals, record.exitSignal))) ||
    typeof record.settledAt !== "string" ||
    !Number.isFinite(Date.parse(record.settledAt)) ||
    (record.confirmed === true && record.outcome === "unconfirmed") ||
    (record.confirmed === false && record.outcome !== "unconfirmed") ||
    (["exited", "terminated"].includes(String(record.outcome)) && !positivePid(record.childPid)) ||
    (["cancelled_before_start", "failed_to_start"].includes(String(record.outcome)) &&
      (record.childPid !== null || record.exitCode !== null || record.exitSignal !== null))
  )
    return undefined;
  return {
    schemaVersion: 1,
    executionId,
    brokerPid: record.brokerPid,
    childPid: record.childPid as number | null,
    outcome: record.outcome as ManagedProcessSettlement["outcome"],
    confirmed: record.confirmed,
    exitCode: record.exitCode as number | null,
    exitSignal: record.exitSignal as NodeJS.Signals | null,
    settledAt: record.settledAt,
  };
}

interface SideEffectProcessStartEvidence {
  event: RunEvent;
  definition: SideEffectProcessDefinition;
  ownerTokenHash: string;
  journalPath: string;
  ready: ManagedProcessReady;
}

interface SideEffectProcessTerminalEvidence {
  event: RunEvent;
  started: boolean;
  settlement: ManagedProcessSettlement;
}

interface SideEffectProcessEventChain {
  start?: SideEffectProcessStartEvidence;
  terminal?: SideEffectProcessTerminalEvidence;
}

function sideEffectProcessHashAlgorithm(
  store: RunStore,
  claim: SideEffectClaim,
): CanonicalHashAlgorithm {
  return claim.kind === "git_commit" || claim.kind === "git_push"
    ? store.repositorySideEffectIdentityHashAlgorithm
    : store.githubMutationLifecycleIdentityHashAlgorithm;
}

function parseSideEffectProcessEventChains(
  events: RunEvent[],
  claim: SideEffectClaim,
  runId: string,
  options: { allowUnconfirmedTerminal?: boolean } = {},
): Map<string, SideEffectProcessEventChain> {
  const chains = new Map<string, SideEffectProcessEventChain>();
  const expectedJournalPath = `locks/side-effect-processes/${runId}/${claim.actionId}.jsonl`;
  for (const event of events) {
    if (!sideEffectProcessEventTypes.has(event.type) || event.data.actionId !== claim.actionId)
      continue;
    if (
      event.actor !== "runtime" ||
      event.causationId !== claim.actionId ||
      event.data.schemaVersion !== 1 ||
      event.data.nodeId !== claim.nodeId ||
      event.data.kind !== claim.kind
    )
      throw new Error(`Side-effect process lifecycle for ${claim.actionId} is invalid`);
    if (event.type === "side_effect.process.started") {
      if (
        !exactKeys(event.data, [
          "schemaVersion",
          "actionId",
          "nodeId",
          "kind",
          "definition",
          "ownerTokenHash",
          "journalPath",
          "ready",
        ])
      )
        throw new Error(`Side-effect process start for ${claim.actionId} is invalid`);
      const definition = parseSideEffectProcessDefinition(event.data.definition);
      const ownerTokenHash = event.data.ownerTokenHash;
      const journalPath = event.data.journalPath;
      if (
        !definition ||
        definition.actionId !== claim.actionId ||
        definition.nodeId !== claim.nodeId ||
        definition.kind !== claim.kind ||
        typeof ownerTokenHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(ownerTokenHash) ||
        journalPath !== expectedJournalPath
      )
        throw new Error(`Side-effect process start for ${claim.actionId} is invalid`);
      const ready = parseManagedReady(event.data.ready, definition.executionId);
      if (!ready) throw new Error(`Side-effect process start for ${claim.actionId} is invalid`);
      const chain = chains.get(definition.executionId) ?? {};
      if (chain.start)
        throw new Error(`Side-effect process ${definition.executionId} started more than once`);
      chain.start = { event, definition, ownerTokenHash, journalPath, ready };
      chains.set(definition.executionId, chain);
      continue;
    }

    if (
      !exactKeys(event.data, [
        "schemaVersion",
        "actionId",
        "nodeId",
        "kind",
        "executionId",
        "started",
        "settlement",
      ]) ||
      typeof event.data.executionId !== "string" ||
      typeof event.data.started !== "boolean"
    )
      throw new Error(`Side-effect process settlement for ${claim.actionId} is invalid`);
    const settlement = parseManagedSettlement(event.data.settlement, event.data.executionId);
    if (!settlement)
      throw new Error(`Side-effect process settlement for ${claim.actionId} is invalid`);
    const chain = chains.get(event.data.executionId) ?? {};
    if (chain.terminal)
      throw new Error(`Side-effect process ${event.data.executionId} settled more than once`);
    chain.terminal = { event, started: event.data.started, settlement };
    chains.set(event.data.executionId, chain);
  }

  for (const [executionId, chain] of chains) {
    if (!chain.terminal) continue;
    if (!chain.terminal.settlement.confirmed && !options.allowUnconfirmedTerminal)
      throw new Error(`Side-effect process ${executionId} has unconfirmed child settlement`);
    if (chain.terminal.started !== Boolean(chain.start))
      throw new Error(`Side-effect process ${executionId} has inconsistent start evidence`);
    if (
      !chain.start &&
      !["cancelled_before_start", "failed_to_start"].includes(chain.terminal.settlement.outcome)
    )
      throw new Error(`Side-effect process ${executionId} lacks start authorization`);
    if (
      chain.start &&
      (chain.terminal.event.sequence <= chain.start.event.sequence ||
        chain.terminal.settlement.brokerPid !== chain.start.ready.brokerPid)
    )
      throw new Error(`Side-effect process ${executionId} has inconsistent broker evidence`);
  }
  return chains;
}

async function loadSideEffectProcessEventChain(
  store: RunStore,
  claim: SideEffectClaim,
  executionId: string,
  options: { allowUnconfirmedTerminal?: boolean } = {},
): Promise<SideEffectProcessEventChain> {
  return (
    parseSideEffectProcessEventChains(await store.loadEvents(), claim, store.runId, options).get(
      executionId,
    ) ?? {}
  );
}

function exactSideEffectProcessEventData(
  event: RunEvent,
  expected: Record<string, unknown>,
  hashAlgorithm: CanonicalHashAlgorithm,
): boolean {
  return contentHash(event.data, hashAlgorithm) === contentHash(expected, hashAlgorithm);
}

async function failSideEffectProcessRecovery(
  input: ExecuteSideEffectInput,
  claim: SideEffectClaim,
  detail: string,
  childSettlement: "confirmed" | "unconfirmed" = "unconfirmed",
): Promise<never> {
  const reason = `Graphcraft cannot safely recover the owned process for ${claim.kind} ${claim.actionId}: ${detail}`;
  await input.store.append(
    "runtime",
    "side_effect.failed",
    {
      actionId: claim.actionId,
      reason,
      retryable: childSettlement === "confirmed",
      uncertain: childSettlement === "unconfirmed",
      childSettlement,
    },
    claim.actionId,
  );
  throw new Error(reason);
}

async function cleanupSideEffectProcessJournal(
  input: ExecuteSideEffectInput,
  claim: SideEffectClaim,
): Promise<void> {
  try {
    await removeSideEffectProcessJournal({
      graphcraftRoot: input.store.graphcraftRoot,
      runId: input.store.runId,
      actionId: claim.actionId,
    });
  } catch (error) {
    await failSideEffectProcessRecovery(
      input,
      claim,
      `the confirmed settlement journal cannot be removed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "confirmed",
    );
  }
}

async function reconcileSideEffectProcessOwnership(
  input: ExecuteSideEffectInput,
  claim: SideEffectClaim,
): Promise<void> {
  const algorithm = sideEffectProcessHashAlgorithm(input.store, claim);
  let chains = new Map<string, SideEffectProcessEventChain>();
  try {
    chains = parseSideEffectProcessEventChains(
      await input.store.loadEvents(),
      claim,
      input.store.runId,
    );
  } catch (error) {
    await failSideEffectProcessRecovery(
      input,
      claim,
      error instanceof Error ? error.message : String(error),
    );
  }

  let definition: SideEffectProcessDefinition | undefined;
  try {
    definition = await readSideEffectProcessDefinition({
      graphcraftRoot: input.store.graphcraftRoot,
      runId: input.store.runId,
      claim,
    });
  } catch (error) {
    await failSideEffectProcessRecovery(
      input,
      claim,
      error instanceof Error ? error.message : String(error),
    );
  }

  const incomplete = [...chains.entries()].filter(([, chain]) => chain.start && !chain.terminal);
  if (!definition) {
    if (incomplete.length > 0)
      await failSideEffectProcessRecovery(
        input,
        claim,
        `the ownership journal for process ${incomplete[0]![0]} is missing`,
      );
    // A crash can land after the journal unlink but before its now-empty run
    // directory is removed. Re-running the idempotent cleanup keeps retention
    // from being permanently blocked by that partial cleanup boundary.
    await cleanupSideEffectProcessJournal(input, claim);
    return;
  }
  const unexpectedIncomplete = incomplete.find(
    ([executionId]) => executionId !== definition!.executionId,
  );
  if (unexpectedIncomplete)
    await failSideEffectProcessRecovery(
      input,
      claim,
      `the ownership journal for process ${unexpectedIncomplete[0]} is missing`,
    );

  const chain = chains.get(definition.executionId) ?? {};
  let inspection: SideEffectProcessJournalInspection | undefined;
  try {
    const inspectionInput = {
      graphcraftRoot: input.store.graphcraftRoot,
      runId: input.store.runId,
      definition,
      hashAlgorithm: algorithm,
      ...(chain.start
        ? {
            ownerTokenHash: chain.start.ownerTokenHash,
            expectedBrokerPid: chain.start.ready.brokerPid,
          }
        : {}),
    };
    const first = await inspectSideEffectProcessJournal(inspectionInput);
    inspection =
      first && first.status === "prepared" && !chain.start && !chain.terminal
        ? first
        : await waitForSideEffectProcessSettlement(inspectionInput);
  } catch (error) {
    await failSideEffectProcessRecovery(
      input,
      claim,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!inspection)
    return await failSideEffectProcessRecovery(
      input,
      claim,
      `the ownership journal for process ${definition.executionId} disappeared`,
    );

  if (chain.terminal) {
    if (
      !inspection.settlement ||
      contentHash(inspection.settlement, algorithm) !==
        contentHash(chain.terminal.settlement, algorithm)
    )
      await failSideEffectProcessRecovery(
        input,
        claim,
        `process ${definition.executionId} has inconsistent terminal evidence`,
      );
    await cleanupSideEffectProcessJournal(input, claim);
    return;
  }

  if (chain.start) {
    if (!inspection.settlement?.confirmed)
      await failSideEffectProcessRecovery(
        input,
        claim,
        `process ${definition.executionId} and its child tree do not have confirmed settlement`,
      );
    await input.store.append(
      "runtime",
      "side_effect.process.reconciled",
      {
        schemaVersion: 1,
        actionId: claim.actionId,
        nodeId: claim.nodeId,
        kind: claim.kind,
        executionId: definition.executionId,
        started: true,
        settlement: inspection.settlement,
      },
      claim.actionId,
    );
    await cleanupSideEffectProcessJournal(input, claim);
    return;
  }

  if (inspection.status === "starting" || inspection.status === "started")
    await failSideEffectProcessRecovery(
      input,
      claim,
      `process ${definition.executionId} started without durable authorization`,
    );
  if (inspection.status === "ready" && !inspection.settlement)
    await failSideEffectProcessRecovery(
      input,
      claim,
      `process ${definition.executionId} does not have confirmed pre-start settlement`,
    );
  if (inspection.settlement) {
    if (
      !inspection.settlement.confirmed ||
      inspection.settlement.outcome !== "cancelled_before_start"
    )
      await failSideEffectProcessRecovery(
        input,
        claim,
        `process ${definition.executionId} settled without valid start authorization`,
      );
    await input.store.append(
      "runtime",
      "side_effect.process.reconciled",
      {
        schemaVersion: 1,
        actionId: claim.actionId,
        nodeId: claim.nodeId,
        kind: claim.kind,
        executionId: definition.executionId,
        started: false,
        settlement: inspection.settlement,
      },
      claim.actionId,
    );
  }
  await cleanupSideEffectProcessJournal(input, claim);
}

function interruptionReceipt(
  input: ExecuteSideEffectInput,
  claim: SideEffectClaim,
  dispatched: boolean,
  childSettlement: SideEffectInterruptionReceipt["childSettlement"],
  reconciliation: SideEffectInterruptionReceipt["reconciliation"],
  disposition: SideEffectInterruptionReceipt["disposition"],
): SideEffectInterruptionReceipt {
  return {
    actionId: claim.actionId,
    kind: claim.kind,
    dispatchPolicy: input.dispatchPolicy,
    dispatched,
    childSettlement,
    reconciliation,
    disposition,
  };
}

function checkpointInterruption(
  input: ExecuteSideEffectInput,
  claim: SideEffectClaim,
  dispatched: boolean,
): SideEffectInterruption {
  return new SideEffectInterruption(
    interruptionReceipt(input, claim, dispatched, "not_started", "not_attempted", "checkpointed"),
  );
}

async function authorizePhase(
  input: ExecuteSideEffectInput,
  claim: SideEffectClaim,
  phase: SideEffectAuthorizationPhase,
  dispatched: boolean,
): Promise<void> {
  try {
    if (phase !== "settlement" && input.signal?.aborted)
      throw checkpointInterruption(input, claim, dispatched);
    await input.authorize?.(phase);
    if (phase !== "settlement" && input.signal?.aborted)
      throw checkpointInterruption(input, claim, dispatched);
  } catch (error) {
    if (error instanceof SideEffectInterruption) throw error;
    if (phase !== "settlement" && input.signal?.aborted)
      throw checkpointInterruption(input, claim, dispatched);
    throw error;
  }
}

export async function crossSideEffectBoundary(
  boundary: ExecuteSideEffectInput["boundary"],
  point: SideEffectBoundary,
): Promise<void> {
  try {
    await boundary?.(point);
  } catch (error) {
    throw new SideEffectBoundaryInterruption(point, { cause: error });
  }
}

async function reconcileAndRecord(
  input: ExecuteSideEffectInput,
  claim: SideEffectClaim,
  boundary: Extract<
    SideEffectBoundary,
    "after_precondition_reconcile" | "after_confirmation_reconcile"
  >,
  phase: Extract<SideEffectAuthorizationPhase, "precondition" | "settlement">,
  dispatched: boolean,
  options: { childSettlement?: "confirmed"; deferErrors?: boolean } = {},
): Promise<SideEffectReconciliation> {
  if (phase === "precondition") await authorizePhase(input, claim, phase, dispatched);
  let reconciliation: SideEffectReconciliation;
  try {
    if (phase === "settlement") await authorizePhase(input, claim, phase, dispatched);
    reconciliation = await input.reconcile(claim);
  } catch (error) {
    if (phase === "precondition" && input.signal?.aborted)
      throw checkpointInterruption(input, claim, dispatched);
    const interruptedSettlement = phase === "settlement" && input.signal?.aborted === true;
    if (!interruptedSettlement && options.deferErrors !== false && input.deferError?.(error))
      throw error;
    const reason = `Unable to reconcile ${claim.kind} ${claim.actionId}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await input.store.append(
      "runtime",
      "side_effect.failed",
      {
        actionId: claim.actionId,
        reason,
        retryable: false,
        uncertain: true,
        ...(options.childSettlement || interruptedSettlement
          ? { childSettlement: options.childSettlement ?? "confirmed" }
          : {}),
      },
      claim.actionId,
    );
    if (interruptedSettlement)
      throw new SideEffectInterruption(
        interruptionReceipt(input, claim, dispatched, "confirmed", "unknown", "uncertain"),
      );
    throw new Error(reason);
  }
  await input.store.append(
    "runtime",
    "side_effect.reconciled",
    {
      actionId: claim.actionId,
      outcome: reconciliation.status,
      evidence: reconciliation.evidence,
    },
    claim.actionId,
  );
  await crossSideEffectBoundary(input.boundary, boundary);
  return reconciliation;
}

async function confirm(
  input: ExecuteSideEffectInput,
  claim: SideEffectClaim,
  reconciliation: Extract<SideEffectReconciliation, { status: "applied" }>,
): Promise<Record<string, unknown>> {
  await input.store.append(
    "runtime",
    "side_effect.confirmed",
    {
      actionId: claim.actionId,
      result: reconciliation.result,
      evidence: reconciliation.evidence,
    },
    claim.actionId,
  );
  await crossSideEffectBoundary(input.boundary, "after_confirm");
  return reconciliation.result;
}

function unobservableDisposition(
  policy: SideEffectDispatchPolicy,
  dispatched: boolean,
  reconciliation: Exclude<SideEffectReconciliation, { status: "applied" }>,
): { retryable: boolean; uncertain: boolean } {
  const retryable =
    reconciliation.status === "not_applied" && (!dispatched || policy === "reconcile_then_retry");
  return { retryable, uncertain: !retryable };
}

function assertDispatchPolicy(claim: SideEffectClaim, policy: SideEffectDispatchPolicy): void {
  const required = claim.kind === "github_check_rerun" ? "at_most_once" : "reconcile_then_retry";
  if (policy !== required)
    throw new Error(`${claim.kind} side effects require the ${required} dispatch policy`);
}

function classifyCancellation(
  input: ExecuteSideEffectInput,
  error: unknown,
): SideEffectCancellation | undefined {
  const classified = input.classifyCancellation?.(error);
  if (
    classified &&
    (classified.outcome !== "failed" ||
      classified.childSettlement === "unconfirmed" ||
      input.signal?.aborted)
  )
    return classified;
  return undefined;
}

async function recordInterruptionFailure(
  input: ExecuteSideEffectInput,
  claim: SideEffectClaim,
  reason: string,
  retryable: boolean,
  uncertain: boolean,
  childSettlement: "confirmed" | "unconfirmed",
  cancellationOutcome?: "cancelled_before_spawn",
): Promise<void> {
  await input.store.append(
    "runtime",
    "side_effect.failed",
    {
      actionId: claim.actionId,
      reason,
      retryable,
      uncertain,
      childSettlement,
      ...(cancellationOutcome ? { cancellationOutcome } : {}),
    },
    claim.actionId,
  );
}

async function settleCancellation(
  input: ExecuteSideEffectInput,
  claim: SideEffectClaim,
  cancellation: SideEffectCancellation,
  dispatched: boolean,
  reason: string,
  settledReconciliation?: SideEffectReconciliation,
): Promise<never> {
  if (cancellation.childSettlement === "unconfirmed") {
    await recordInterruptionFailure(input, claim, reason, false, true, "unconfirmed");
    throw new SideEffectInterruption(
      interruptionReceipt(input, claim, dispatched, "unconfirmed", "not_attempted", "uncertain"),
    );
  }

  if (cancellation.outcome === "cancelled_before_spawn") {
    await recordInterruptionFailure(
      input,
      claim,
      reason,
      true,
      false,
      "confirmed",
      "cancelled_before_spawn",
    );
    throw new SideEffectInterruption(
      interruptionReceipt(input, claim, dispatched, "not_started", "not_attempted", "retryable"),
    );
  }

  let reconciliation: SideEffectReconciliation;
  try {
    reconciliation =
      settledReconciliation ??
      (await reconcileAndRecord(
        input,
        claim,
        "after_confirmation_reconcile",
        "settlement",
        dispatched,
        { childSettlement: "confirmed", deferErrors: false },
      ));
  } catch (error) {
    if (error instanceof SideEffectBoundaryInterruption) throw error;
    if (error instanceof SideEffectInterruption) throw error;
    throw new SideEffectInterruption(
      interruptionReceipt(input, claim, dispatched, "confirmed", "unknown", "uncertain"),
    );
  }
  if (reconciliation.status === "applied") {
    await confirm(input, claim, reconciliation);
    throw new SideEffectInterruption(
      interruptionReceipt(input, claim, dispatched, "confirmed", "applied", "confirmed"),
    );
  }
  const { retryable, uncertain } = unobservableDisposition(
    input.dispatchPolicy,
    dispatched,
    reconciliation,
  );
  await recordInterruptionFailure(input, claim, reason, retryable, uncertain, "confirmed");
  throw new SideEffectInterruption(
    interruptionReceipt(
      input,
      claim,
      dispatched,
      "confirmed",
      reconciliation.status,
      uncertain ? "uncertain" : "retryable",
    ),
  );
}

export async function executeSideEffect(
  input: ExecuteSideEffectInput,
): Promise<Record<string, unknown>> {
  const proposedClaim = SideEffectClaimSchema.parse(input.claim);
  assertDispatchPolicy(proposedClaim, input.dispatchPolicy);
  let entry = journalEntry((await input.store.loadState()).sideEffects, proposedClaim.actionId);
  let claim = entry?.claim ?? proposedClaim;
  assertDispatchPolicy(claim, input.dispatchPolicy);
  if (!entry) {
    await crossSideEffectBoundary(input.boundary, "before_claim");
    await input.store.append("runtime", "side_effect.claimed", { claim }, claim.actionId);
    await crossSideEffectBoundary(input.boundary, "after_claim");
    entry = journalEntry((await input.store.loadState()).sideEffects, claim.actionId);
  }
  if (!entry) throw new Error(`Side-effect claim ${claim.actionId} was not persisted`);
  claim = entry.claim;
  await reconcileSideEffectProcessOwnership(input, claim);
  entry = journalEntry((await input.store.loadState()).sideEffects, claim.actionId) ?? entry;
  if (entry.childSettlement === "unconfirmed")
    throw new Error(
      `The child settlement for ${claim.kind} ${claim.actionId} is unconfirmed; refusing to reconcile or retry while the mutation process may still be running`,
    );
  if (entry.status === "confirmed") {
    if (!entry.result) throw new Error(`Confirmed side effect ${claim.actionId} has no result`);
    if (!input.revalidateConfirmed) return entry.result;
    const confirmed = await reconcileAndRecord(
      input,
      claim,
      "after_precondition_reconcile",
      "precondition",
      true,
    );
    if (confirmed.status === "applied") return confirmed.result;
    const reason = `Confirmed ${claim.kind} ${claim.actionId} no longer matches external truth`;
    await input.store.append(
      "runtime",
      "side_effect.failed",
      { actionId: claim.actionId, reason, retryable: false, uncertain: true },
      claim.actionId,
    );
    throw new Error(reason);
  }

  const before = await reconcileAndRecord(
    input,
    claim,
    "after_precondition_reconcile",
    "precondition",
    entry.dispatchedAt !== undefined,
  );
  if (before.status === "applied") return await confirm(input, claim, before);
  if (before.status === "unknown") {
    const reason = `The outcome of ${claim.kind} ${claim.actionId} is uncertain; refusing to retry`;
    await input.store.append(
      "runtime",
      "side_effect.failed",
      { actionId: claim.actionId, reason, retryable: false, uncertain: true },
      claim.actionId,
    );
    throw new Error(reason);
  }
  if (input.dispatchPolicy === "at_most_once" && entry.dispatchedAt) {
    const reason = `The dispatched ${claim.kind} ${claim.actionId} is not yet observable; refusing a possibly duplicate retry`;
    await input.store.append(
      "runtime",
      "side_effect.failed",
      { actionId: claim.actionId, reason, retryable: false, uncertain: true },
      claim.actionId,
    );
    throw new Error(reason);
  }

  await crossSideEffectBoundary(input.boundary, "before_act");
  let dispatched = entry.dispatchedAt !== undefined;
  let markedThisAttempt = false;
  let processLease: SideEffectProcessLease | undefined;
  let processStartEventData: Record<string, unknown> | undefined;
  let processStartAppendCompleted = false;
  let processSettlement: ManagedProcessSettlement | undefined;
  await authorizePhase(input, claim, "dispatch", dispatched);
  const checkpointDispatch = async (): Promise<void> => {
    await authorizePhase(input, claim, "dispatch", dispatched);
    if (!dispatched) {
      await input.store.append(
        "runtime",
        "side_effect.dispatched",
        { actionId: claim.actionId },
        claim.actionId,
      );
      dispatched = true;
    }
    markedThisAttempt = true;
    await crossSideEffectBoundary(input.boundary, "after_action_dispatch");
    if (input.signal?.aborted) {
      await recordInterruptionFailure(
        input,
        claim,
        `${claim.kind} ${claim.actionId} was cancelled before its mutation child started`,
        true,
        false,
        "confirmed",
        "cancelled_before_spawn",
      );
      throw new SideEffectInterruption(
        interruptionReceipt(input, claim, true, "not_started", "not_attempted", "retryable"),
      );
    }
  };
  const markDispatched: SideEffectDispatch = async (request) => {
    if (!request) {
      await checkpointDispatch();
      return;
    }
    if (processLease)
      throw new Error(`${claim.kind} ${claim.actionId} prepared more than one mutation process`);
    const definition = createSideEffectProcessDefinition(claim);
    processLease = await createSideEffectProcessLease({
      graphcraftRoot: input.store.graphcraftRoot,
      runId: input.store.runId,
      definition,
      hashAlgorithm: sideEffectProcessHashAlgorithm(input.store, claim),
    });
    return processLease.lifecycle({
      onReady: async (ready) => {
        await checkpointDispatch();
        processStartEventData = {
          schemaVersion: 1,
          actionId: claim.actionId,
          nodeId: claim.nodeId,
          kind: claim.kind,
          definition,
          ownerTokenHash: processLease!.ownerTokenHash,
          journalPath: processLease!.journalRelativePath,
          ready,
        };
        await input.store.append(
          "runtime",
          "side_effect.process.started",
          processStartEventData,
          claim.actionId,
        );
        processStartAppendCompleted = true;
      },
      onSettled: async (settlement) => {
        processSettlement = settlement;
        const chain = await loadSideEffectProcessEventChain(
          input.store,
          claim,
          definition.executionId,
        );
        if (
          (processStartAppendCompleted && !chain.start) ||
          (chain.start &&
            (!processStartEventData ||
              !exactSideEffectProcessEventData(
                chain.start.event,
                processStartEventData,
                sideEffectProcessHashAlgorithm(input.store, claim),
              )))
        )
          throw new Error(
            `Side-effect process ${definition.executionId} has ambiguous durable start evidence`,
          );
        await input.store.append(
          "runtime",
          "side_effect.process.finished",
          {
            schemaVersion: 1,
            actionId: claim.actionId,
            nodeId: claim.nodeId,
            kind: claim.kind,
            executionId: definition.executionId,
            started: Boolean(chain.start),
            settlement,
          },
          claim.actionId,
        );
      },
    });
  };
  try {
    let actionError: unknown;
    try {
      await input.act(claim, markDispatched);
    } catch (error) {
      actionError = error;
      throw error;
    } finally {
      if (processLease) {
        try {
          await closeSideEffectProcessLease(processLease);
          const chain = await loadSideEffectProcessEventChain(
            input.store,
            claim,
            processLease.definition.executionId,
            { allowUnconfirmedTerminal: true },
          );
          const expectedTerminalData = processSettlement
            ? {
                schemaVersion: 1,
                actionId: claim.actionId,
                nodeId: claim.nodeId,
                kind: claim.kind,
                executionId: processLease.definition.executionId,
                started: Boolean(chain.start),
                settlement: processSettlement,
              }
            : undefined;
          const terminalDataMatches =
            chain.terminal !== undefined &&
            expectedTerminalData !== undefined &&
            exactSideEffectProcessEventData(
              chain.terminal.event,
              expectedTerminalData,
              sideEffectProcessHashAlgorithm(input.store, claim),
            );
          const exactTerminal =
            processSettlement !== undefined &&
            chain.terminal !== undefined &&
            chain.terminal.event.type === "side_effect.process.finished" &&
            expectedTerminalData !== undefined &&
            terminalDataMatches;
          const missingTerminalCanRecover =
            processSettlement === undefined &&
            actionError !== undefined &&
            (actionError instanceof SideEffectBoundaryInterruption ||
              actionError instanceof SideEffectInterruption ||
              classifyCancellation(input, actionError)?.childSettlement === "unconfirmed");
          if (!exactTerminal && !missingTerminalCanRecover)
            throw new Error(
              `process ${processLease.definition.executionId} lacks exact durable terminal evidence ` +
                `(settlement=${processSettlement ? "present" : "missing"}, ` +
                `event=${chain.terminal?.event.type ?? "missing"}, exact=${terminalDataMatches})`,
            );
          if (processSettlement?.confirmed)
            await removeSideEffectProcessJournal({
              graphcraftRoot: input.store.graphcraftRoot,
              runId: input.store.runId,
              actionId: claim.actionId,
            });
          else if (!actionError)
            throw new Error(
              `process ${processLease.definition.executionId} has unconfirmed terminal evidence`,
            );
        } catch (cleanupError) {
          throw new SideEffectProcessCleanupError(
            `Unable to clean up the owned mutation process for ${claim.kind} ${claim.actionId}: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
            processSettlement?.confirmed ? "confirmed" : "unconfirmed",
            { cause: actionError ?? cleanupError },
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof SideEffectBoundaryInterruption) throw error;
    if (error instanceof SideEffectInterruption) throw error;
    if (error instanceof SideEffectProcessCleanupError) {
      const confirmed = error.childSettlement === "confirmed";
      await recordInterruptionFailure(
        input,
        claim,
        error.message,
        confirmed,
        !confirmed,
        error.childSettlement,
      );
      throw error;
    }
    let cancellation = classifyCancellation(input, error);
    const reason = error instanceof Error ? error.message : String(error);
    if (
      cancellation?.outcome === "failed" &&
      cancellation.childSettlement === "unconfirmed" &&
      !input.signal?.aborted
    ) {
      await recordInterruptionFailure(input, claim, reason, false, true, "unconfirmed");
      throw error;
    }
    if (!markedThisAttempt) {
      if (cancellation?.childSettlement === "unconfirmed")
        await settleCancellation(input, claim, cancellation, dispatched, reason);
      if (cancellation || input.signal?.aborted)
        throw checkpointInterruption(input, claim, dispatched);
    }
    if (!cancellation && input.signal?.aborted)
      cancellation = { outcome: "unconfirmed", childSettlement: "unconfirmed" };
    if (cancellation) await settleCancellation(input, claim, cancellation, dispatched, reason);
    if (!markedThisAttempt && input.deferError?.(error)) throw error;
    const afterFailure = await reconcileAndRecord(
      input,
      claim,
      "after_confirmation_reconcile",
      "settlement",
      dispatched,
    );
    if (input.signal?.aborted)
      await settleCancellation(
        input,
        claim,
        { outcome: "terminated", childSettlement: "confirmed" },
        dispatched,
        reason,
        afterFailure,
      );
    if (afterFailure.status === "applied") {
      const result = await confirm(input, claim, afterFailure);
      if (input.signal?.aborted)
        throw new SideEffectInterruption(
          interruptionReceipt(input, claim, dispatched, "confirmed", "applied", "confirmed"),
        );
      return result;
    }
    const { retryable, uncertain } = unobservableDisposition(
      input.dispatchPolicy,
      dispatched,
      afterFailure,
    );
    await input.store.append(
      "runtime",
      "side_effect.failed",
      {
        actionId: claim.actionId,
        reason,
        retryable,
        uncertain,
      },
      claim.actionId,
    );
    if (input.signal?.aborted)
      throw new SideEffectInterruption(
        interruptionReceipt(
          input,
          claim,
          dispatched,
          "confirmed",
          afterFailure.status,
          uncertain ? "uncertain" : "retryable",
        ),
      );
    throw new Error(
      uncertain
        ? `${reason}; the side-effect outcome is uncertain and will not be retried blindly`
        : reason,
    );
  }
  if (!markedThisAttempt)
    throw new Error(`${claim.kind} ${claim.actionId} acted without a dispatch checkpoint`);
  await crossSideEffectBoundary(input.boundary, "after_act");

  if (input.signal?.aborted)
    await settleCancellation(
      input,
      claim,
      { outcome: "terminated", childSettlement: "confirmed" },
      dispatched,
      `${claim.kind} ${claim.actionId} settled after cancellation`,
    );

  const after = await reconcileAndRecord(
    input,
    claim,
    "after_confirmation_reconcile",
    "settlement",
    dispatched,
  );
  if (input.signal?.aborted)
    await settleCancellation(
      input,
      claim,
      { outcome: "terminated", childSettlement: "confirmed" },
      dispatched,
      `${claim.kind} ${claim.actionId} settled during reconciliation`,
      after,
    );
  if (after.status === "applied") {
    const result = await confirm(input, claim, after);
    if (input.signal?.aborted)
      throw new SideEffectInterruption(
        interruptionReceipt(input, claim, dispatched, "confirmed", "applied", "confirmed"),
      );
    return result;
  }
  const { retryable, uncertain } = unobservableDisposition(input.dispatchPolicy, dispatched, after);
  const reason = uncertain
    ? `The outcome of ${claim.kind} ${claim.actionId} is uncertain after execution`
    : `${claim.kind} ${claim.actionId} was not observable after execution`;
  await input.store.append(
    "runtime",
    "side_effect.failed",
    { actionId: claim.actionId, reason, retryable, uncertain },
    claim.actionId,
  );
  if (input.signal?.aborted)
    throw new SideEffectInterruption(
      interruptionReceipt(
        input,
        claim,
        dispatched,
        "confirmed",
        after.status,
        uncertain ? "uncertain" : "retryable",
      ),
    );
  throw new Error(reason);
}
