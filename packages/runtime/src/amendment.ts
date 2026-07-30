import { join } from "node:path";
import {
  GraphAmendmentRecordSchema,
  GraphAmendmentSchema,
  applyGraphAmendment,
  workerVisibleProbePlan,
  type Graph,
  type GraphAmendment,
  type GraphAmendmentRecord,
  type RunEvent,
} from "@graphcraft/core";
import { bindToRunLockLease, RunLock, withRunLockLease } from "./lock.ts";
import { RunStore } from "./store.ts";

export interface RunGraphAmendmentResult {
  graph: Graph;
  amendment: GraphAmendmentRecord;
}

function failureSignatures(proposal: GraphAmendment): Set<string> {
  return new Set(
    proposal.evidence
      .filter((item) => item.startsWith("failure-signature:"))
      .map((item) => item.slice("failure-signature:".length)),
  );
}

function strategyFingerprint(value: string): string {
  return [
    ...new Set(
      value
        .toLowerCase()
        .match(/[a-z0-9]+/g)
        ?.filter((token) => token.length > 2) ?? [],
    ),
  ]
    .sort()
    .join(" ");
}

function requireChangedFailureStrategy(events: RunEvent[], proposal: GraphAmendment): void {
  const signatures = failureSignatures(proposal);
  if (signatures.size === 0) return;
  const fingerprint = strategyFingerprint(proposal.changedStrategy);
  for (const event of events) {
    if (event.type !== "graph.amended" || !event.data.amendment) continue;
    const record = GraphAmendmentRecordSchema.safeParse(event.data.amendment);
    if (!record.success) continue;
    const previous = record.data.proposal;
    if (![...failureSignatures(previous)].some((signature) => signatures.has(signature))) continue;
    if (strategyFingerprint(previous.changedStrategy) === fingerprint)
      throw new Error("A repeated failure signature requires a meaningfully changed strategy");
  }
}

export async function applyRunGraphAmendmentLocked(
  store: RunStore,
  input: GraphAmendment,
  actor: "runtime" | "user",
): Promise<RunGraphAmendmentResult> {
  const proposal = GraphAmendmentSchema.parse(input);
  const events = await store.loadEvents();
  const existing = events.find(({ type, data }) => {
    if (type !== "graph.amended" || !data.amendment) return false;
    const record = GraphAmendmentRecordSchema.safeParse(data.amendment);
    return record.success && record.data.proposal.amendmentId === proposal.amendmentId;
  });
  if (existing) {
    return {
      graph: await store.loadGraph(),
      amendment: GraphAmendmentRecordSchema.parse(existing.data.amendment),
    };
  }
  requireChangedFailureStrategy(events, proposal);

  const graph = await store.loadGraph();
  const contract = await store.loadContract();
  const state = await store.loadState();
  const probePlan = await store.loadProbePlan();
  const heldOutProbePlan = await store.loadHeldOutProbePlan();
  if (["awaiting_approval", "completed", "stopped"].includes(state.status))
    throw new Error(`Graph amendments are not allowed while a run is ${state.status}`);
  const graphProbePlan = workerVisibleProbePlan(probePlan, heldOutProbePlan);
  const completionProbes = graphProbePlan.items
    .filter(({ phase }) => phase === "completion")
    .map(({ probe }) => probe);
  const applied = applyGraphAmendment({
    graph,
    contract,
    amendment: proposal,
    actor,
    nodeStatuses: state.nodes,
    requiredVerificationProbes: completionProbes,
    approvedProbes: graphProbePlan.items.map(({ probe }) => probe),
  });
  const record = GraphAmendmentRecordSchema.parse({
    schemaVersion: 1,
    proposal,
    actor,
    previousRevision: graph.revision,
    nextRevision: applied.graph.revision,
    diff: applied.diff,
  });
  await store.append(
    actor === "user" ? "user" : "runtime",
    "graph.amended",
    {
      graph: applied.graph,
      amendment: record,
      ...applied.diff,
      evidence: proposal.evidence,
      rationale: proposal.rationale,
      changedStrategy: proposal.changedStrategy,
      falsifiableExpectation: proposal.falsifiableExpectation,
    },
    proposal.amendmentId,
  );
  await store.saveGraph(applied.graph);
  return { graph: applied.graph, amendment: record };
}

export async function amendRunGraph(
  store: RunStore,
  input: GraphAmendment,
  actor: "runtime" | "user" = "runtime",
): Promise<RunGraphAmendmentResult> {
  await store.prepareStorage();
  const lock = new RunLock(join(store.graphcraftRoot, "locks", `${store.runId}.lock`));
  return await withRunLockLease(
    lock,
    async (signal) =>
      await applyRunGraphAmendmentLocked(bindToRunLockLease(store, signal), input, actor),
  );
}
