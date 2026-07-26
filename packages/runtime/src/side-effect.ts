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

export type SideEffectReconciliation =
  | { status: "applied"; result: Record<string, unknown>; evidence: string[] }
  | { status: "not_applied"; evidence: string[] }
  | { status: "unknown"; evidence: string[] };

export interface ExecuteSideEffectInput {
  store: RunStore;
  claim: SideEffectClaim;
  authorize?: () => Promise<void>;
  reconcile: (claim: SideEffectClaim) => Promise<SideEffectReconciliation>;
  act: (
    claim: SideEffectClaim,
    markDispatched: () => Promise<void>,
  ) => Promise<Record<string, unknown>>;
  dispatchPolicy: SideEffectDispatchPolicy;
  boundary?: (point: SideEffectBoundary) => void | Promise<void>;
  revalidateConfirmed?: boolean;
  deferError?: (error: unknown) => boolean;
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

function journalEntry(
  entries: SideEffectJournalEntry[],
  actionId: string,
): SideEffectJournalEntry | undefined {
  return entries.find(({ claim }) => claim.actionId === actionId);
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
): Promise<SideEffectReconciliation> {
  await input.authorize?.();
  let reconciliation: SideEffectReconciliation;
  try {
    reconciliation = await input.reconcile(claim);
  } catch (error) {
    if (input.deferError?.(error)) throw error;
    const reason = `Unable to reconcile ${claim.kind} ${claim.actionId}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await input.store.append(
      "runtime",
      "side_effect.failed",
      { actionId: claim.actionId, reason, retryable: false, uncertain: true },
      claim.actionId,
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
  if (entry.status === "confirmed") {
    if (!entry.result) throw new Error(`Confirmed side effect ${claim.actionId} has no result`);
    if (!input.revalidateConfirmed) return entry.result;
    const confirmed = await reconcileAndRecord(input, claim, "after_precondition_reconcile");
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

  const before = await reconcileAndRecord(input, claim, "after_precondition_reconcile");
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
  await input.authorize?.();
  let dispatched = entry.dispatchedAt !== undefined;
  let markedThisAttempt = false;
  const markDispatched = async (): Promise<void> => {
    await input.authorize?.();
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
    if (!markedThisAttempt && input.deferError?.(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const afterFailure = await reconcileAndRecord(input, claim, "after_confirmation_reconcile");
    if (afterFailure.status === "applied") return await confirm(input, claim, afterFailure);
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
    throw new Error(
      uncertain
        ? `${reason}; the side-effect outcome is uncertain and will not be retried blindly`
        : reason,
    );
  }
  if (!markedThisAttempt)
    throw new Error(`${claim.kind} ${claim.actionId} acted without a dispatch checkpoint`);
  await crossSideEffectBoundary(input.boundary, "after_act");

  const after = await reconcileAndRecord(input, claim, "after_confirmation_reconcile");
  if (after.status === "applied") return await confirm(input, claim, after);
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
  throw new Error(reason);
}
