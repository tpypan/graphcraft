import { join } from "node:path";
import {
  GraphAmendmentRecordSchema,
  GraphAmendmentSchema,
  applyGraphAmendment,
  type Graph,
  type GraphAmendment,
  type GraphAmendmentRecord,
} from "@graphcraft/core";
import { RunLock } from "./lock.ts";
import { RunStore } from "./store.ts";

export interface RunGraphAmendmentResult {
  graph: Graph;
  amendment: GraphAmendmentRecord;
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

  const [graph, contract, state, probePlan] = await Promise.all([
    store.loadGraph(),
    store.loadContract(),
    store.loadState(),
    store.loadProbePlan(),
  ]);
  if (["awaiting_approval", "completed", "stopped"].includes(state.status))
    throw new Error(`Graph amendments are not allowed while a run is ${state.status}`);
  const completionProbes = probePlan.items
    .filter(({ phase }) => phase === "completion")
    .map(({ probe }) => probe);
  const applied = applyGraphAmendment({
    graph,
    contract,
    amendment: proposal,
    actor,
    nodeStatuses: state.nodes,
    requiredVerificationProbes: completionProbes,
    approvedProbes: probePlan.items.map(({ probe }) => probe),
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
  const lock = new RunLock(join(store.graphcraftRoot, "locks", `${store.runId}.lock`));
  await lock.acquire();
  try {
    return await applyRunGraphAmendmentLocked(store, input, actor);
  } finally {
    await lock.release();
  }
}
