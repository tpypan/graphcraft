import {
  SideEffectClaimSchema,
  type SideEffectClaim,
  type SideEffectJournalEntry,
} from "@graphcraft/core";
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
    markDispatched: () => Promise<void>,
  ) => Promise<Record<string, unknown>>;
  dispatchPolicy: SideEffectDispatchPolicy;
  boundary?: (point: SideEffectBoundary) => void | Promise<void>;
  revalidateConfirmed?: boolean;
  deferError?: (error: unknown) => boolean;
  signal?: AbortSignal;
  classifyCancellation?: (error: unknown) => SideEffectCancellation | undefined;
}

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

function journalEntry(
  entries: SideEffectJournalEntry[],
  actionId: string,
): SideEffectJournalEntry | undefined {
  return entries.find(({ claim }) => claim.actionId === actionId);
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
  await authorizePhase(input, claim, "dispatch", dispatched);
  const markDispatched = async (): Promise<void> => {
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
  };
  try {
    await input.act(claim, markDispatched);
  } catch (error) {
    if (error instanceof SideEffectBoundaryInterruption) throw error;
    if (error instanceof SideEffectInterruption) throw error;
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
