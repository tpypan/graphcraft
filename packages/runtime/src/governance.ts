import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ControlDecisionPacketSchema,
  ControlDecisionSchema,
  type ControlDecision,
  type ControlDecisionPacket,
  type Graph,
  type RunState,
} from "@graphcraft/core";
import { RunLock } from "./lock.ts";
import type { RunStore } from "./store.ts";

export interface UserControlDecisionInput {
  sourceId: string;
  targetId: string;
  verdict: "approve" | "veto";
  rationale: string;
  evidence?: string[];
  replaces?: string;
}

export interface ControlEvaluation {
  allowed: boolean;
  reason?: string;
  packet?: ControlDecisionPacket;
}

function decisionFor(
  state: RunState,
  sourceId: string,
  targetId: string,
): ControlDecision | undefined {
  const explicit = state.controlDecisions.findLast(
    (decision) => decision.sourceId === sourceId && decision.targetId === targetId,
  );
  if (explicit) return explicit;
  const sourceState = state.nodes[sourceId];
  if (!sourceState || !["accepted", "failed", "blocked", "stopped"].includes(sourceState.status))
    return undefined;
  return ControlDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: randomUUID(),
    sourceId,
    targetId,
    verdict: sourceState.status === "accepted" ? "approve" : "veto",
    rationale: `Control source node ${sourceId} is ${sourceState.status}`,
    evidence: sourceState.lastSummary ? [sourceState.lastSummary] : [],
    actor: "runtime",
    sticky: false,
    decidedAt: state.updatedAt,
  });
}

async function appendDecision(store: RunStore, decision: ControlDecision): Promise<void> {
  await store.append(
    decision.actor === "user" ? "user" : decision.actor === "verifier" ? "host" : "runtime",
    "control.decision",
    { decision },
    decision.decisionId,
  );
}

function authorityEdge(graph: Graph, sourceId: string, targetId: string): boolean {
  return graph.controlEdges.some(
    (edge) =>
      edge.from === sourceId &&
      edge.to === targetId &&
      ["vetoes", "arbitrates", "owns_target"].includes(edge.relation),
  );
}

export async function recordRuntimeControlDecision(input: {
  store: RunStore;
  graph: Graph;
  sourceId: string;
  targetId: string;
  verdict: "approve" | "veto";
  rationale: string;
  evidence: string[];
  actor: "runtime" | "verifier";
}): Promise<ControlDecision> {
  if (!authorityEdge(input.graph, input.sourceId, input.targetId))
    throw new Error(`Control source ${input.sourceId} has no authority over ${input.targetId}`);
  const anchor = input.graph.anchors.find(({ id }) => id === input.sourceId);
  if (anchor?.owner === "user")
    throw new Error(`Runtime actors cannot impersonate user-owned source ${input.sourceId}`);
  if (input.actor === "verifier" && anchor?.owner !== "held_out_eval")
    throw new Error(`Verifier source ${input.sourceId} is not owned by a held-out evaluator`);
  const decision = ControlDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: randomUUID(),
    sourceId: input.sourceId,
    targetId: input.targetId,
    verdict: input.verdict,
    rationale: input.rationale,
    evidence: input.evidence,
    actor: input.actor,
    sticky: false,
    decidedAt: new Date().toISOString(),
  });
  await appendDecision(input.store, decision);
  return decision;
}

export async function recordRunApprovalDecisions(store: RunStore, graph: Graph): Promise<void> {
  const state = await store.loadState();
  const anchors = new Map(graph.anchors.map((anchor) => [anchor.id, anchor]));
  for (const edge of graph.controlEdges.filter(({ relation }) => relation === "owns_target")) {
    if (anchors.get(edge.from)?.owner !== "user" || decisionFor(state, edge.from, edge.to))
      continue;
    await appendDecision(
      store,
      ControlDecisionSchema.parse({
        schemaVersion: 1,
        decisionId: randomUUID(),
        sourceId: edge.from,
        targetId: edge.to,
        verdict: "approve",
        rationale: "The user approved the displayed run contract, graph, and finish line",
        evidence: ["run.approved"],
        actor: "user",
        sticky: true,
        decidedAt: new Date().toISOString(),
      }),
    );
  }
}

function packet(input: {
  targetId: string;
  conflict: string;
  evidence: string[];
  requiredSources: string[];
}): ControlDecisionPacket {
  return ControlDecisionPacketSchema.parse({
    packetId: randomUUID(),
    targetId: input.targetId,
    invariant: "A controlled node cannot run or be accepted without resolved authority",
    conflict: input.conflict,
    evidence: input.evidence,
    requiredSources: [...new Set(input.requiredSources)],
    choices: ["approve", "veto"],
    createdAt: new Date().toISOString(),
  });
}

async function requireDecision(
  store: RunStore,
  targetId: string,
  conflict: string,
  evidence: string[],
  requiredSources: string[],
): Promise<ControlEvaluation> {
  const required = [...new Set(requiredSources)];
  const existing = (await store.loadState()).pendingDecision;
  if (
    existing?.targetId === targetId &&
    existing.conflict === conflict &&
    JSON.stringify([...existing.requiredSources].sort()) === JSON.stringify([...required].sort())
  ) {
    return { allowed: false, reason: conflict, packet: existing };
  }
  const value = packet({ targetId, conflict, evidence, requiredSources });
  await store.append("runtime", "control.decision_required", { packet: value }, value.packetId);
  return { allowed: false, reason: conflict, packet: value };
}

function decisionsFor(
  state: RunState,
  edges: Graph["controlEdges"],
  targetId: string,
): ControlDecision[] {
  return edges
    .map((edge) => decisionFor(state, edge.from, targetId))
    .filter((decision): decision is ControlDecision => decision !== undefined);
}

function unanimousDecision(decisions: ControlDecision[]): ControlDecision | "conflict" | undefined {
  if (decisions.length === 0) return undefined;
  if (new Set(decisions.map(({ verdict }) => verdict)).size > 1) return "conflict";
  return decisions[0];
}

async function recordOverride(
  store: RunStore,
  targetId: string,
  arbitrator: ControlDecision,
  overridden: ControlDecision[],
  missingSources: string[] = [],
): Promise<void> {
  await store.append(arbitrator.actor === "user" ? "user" : "runtime", "control.override", {
    targetId,
    arbitrator: arbitrator.sourceId,
    arbitratorDecisionId: arbitrator.decisionId,
    rationale: arbitrator.rationale,
    overridden: overridden.map(({ sourceId }) => sourceId),
    overriddenDecisionIds: overridden.map(({ decisionId }) => decisionId),
    missingSources,
    evidence: arbitrator.evidence,
  });
}

async function recordResolution(
  store: RunStore,
  targetId: string,
  outcome: "approved" | "vetoed",
  owners: ControlDecision[],
  evidence: string[],
): Promise<void> {
  await store.append("runtime", "control.resolved", {
    targetId,
    outcome,
    owners: owners.map(({ sourceId }) => sourceId),
    ownerDecisionIds: owners.map(({ decisionId }) => decisionId),
    evidence,
  });
}

export async function evaluateControlScheduling(
  store: RunStore,
  graph: Graph,
  state: RunState,
  targetId: string,
): Promise<ControlEvaluation> {
  const owners = graph.controlEdges.filter(
    (edge) => edge.to === targetId && edge.relation === "owns_target",
  );
  if (owners.length === 0) return { allowed: true };
  const ownerDecisions = decisionsFor(state, owners, targetId);
  const ownerApprovals = ownerDecisions.filter(({ verdict }) => verdict === "approve");
  const ownerVetoes = ownerDecisions.filter(({ verdict }) => verdict === "veto");
  const missing = owners.filter(
    (edge) => !ownerDecisions.some(({ sourceId }) => sourceId === edge.from),
  );
  const arbitratorEdges = graph.controlEdges.filter(
    (edge) => edge.to === targetId && edge.relation === "arbitrates",
  );
  const arbitrators = decisionsFor(state, arbitratorEdges, targetId);
  const arbitrator = unanimousDecision(arbitrators);

  if (arbitrator === "conflict") {
    return await requireDecision(
      store,
      targetId,
      `Arbitrators disagree about scheduling ${targetId}`,
      arbitrators.flatMap(({ evidence }) => evidence),
      arbitratorEdges.map(({ from }) => from),
    );
  }

  if (missing.length > 0) {
    if (arbitrator?.verdict === "approve") {
      await recordOverride(
        store,
        targetId,
        arbitrator,
        ownerVetoes,
        missing.map(({ from }) => from),
      );
      await recordResolution(store, targetId, "approved", ownerApprovals, arbitrator.evidence);
      return { allowed: true };
    }
    if (arbitrator?.verdict === "veto") {
      await recordResolution(store, targetId, "vetoed", ownerDecisions, arbitrator.evidence);
      return {
        allowed: false,
        reason: `Arbitrator vetoed scheduling ${targetId}: ${arbitrator.sourceId}`,
      };
    }
    return await requireDecision(
      store,
      targetId,
      `Control owners have not authorized ${targetId}`,
      ownerDecisions.flatMap(({ evidence }) => evidence),
      arbitratorEdges.length > 0
        ? arbitratorEdges.map(({ from }) => from)
        : missing.map(({ from }) => from),
    );
  }

  if (ownerApprovals.length > 0 && ownerVetoes.length > 0) {
    if (arbitrator?.verdict === "approve") {
      await recordOverride(store, targetId, arbitrator, ownerVetoes);
      await recordResolution(store, targetId, "approved", ownerApprovals, arbitrator.evidence);
      return { allowed: true };
    }
    if (arbitrator?.verdict === "veto") {
      await recordResolution(store, targetId, "vetoed", ownerDecisions, arbitrator.evidence);
      return {
        allowed: false,
        reason: `Arbitrator vetoed scheduling ${targetId}: ${arbitrator.sourceId}`,
      };
    }
    return await requireDecision(
      store,
      targetId,
      `Control owners disagree about scheduling ${targetId}`,
      ownerDecisions.flatMap(({ evidence }) => evidence),
      arbitratorEdges.length > 0
        ? arbitratorEdges.map(({ from }) => from)
        : owners.map(({ from }) => from),
    );
  }

  if (ownerVetoes.length > 0) {
    if (arbitrator?.verdict === "approve") {
      await recordOverride(store, targetId, arbitrator, ownerVetoes);
      await recordResolution(store, targetId, "approved", [], arbitrator.evidence);
      return { allowed: true };
    }
    const reason = `Control owner vetoed ${targetId}: ${ownerVetoes
      .map(({ sourceId }) => sourceId)
      .join(", ")}`;
    await recordResolution(
      store,
      targetId,
      "vetoed",
      ownerVetoes,
      ownerVetoes.flatMap(({ evidence }) => evidence),
    );
    return { allowed: false, reason };
  }
  return { allowed: true };
}

export async function evaluateControlAcceptance(
  store: RunStore,
  graph: Graph,
  state: RunState,
  targetId: string,
  evidence: string[],
): Promise<ControlEvaluation> {
  const incoming = graph.controlEdges.filter((edge) => edge.to === targetId);
  for (const edge of incoming.filter(({ relation }) => relation === "observes")) {
    await store.append("runtime", "control.observed", {
      observer: edge.from,
      targetId,
      evidence,
    });
  }

  const owners = incoming.filter(({ relation }) => relation === "owns_target");
  const ownerDecisions = decisionsFor(state, owners, targetId);
  const missingOwners = owners.filter(
    (edge) => !ownerDecisions.some(({ sourceId }) => sourceId === edge.from),
  );
  let ownerApprovals = ownerDecisions.filter(({ verdict }) => verdict === "approve");
  let ownerVetoes = ownerDecisions.filter(({ verdict }) => verdict === "veto");
  const arbitratorEdges = incoming.filter(({ relation }) => relation === "arbitrates");
  const arbitrators = decisionsFor(state, arbitratorEdges, targetId);
  const arbitrator = unanimousDecision(arbitrators);

  if (arbitrator === "conflict") {
    return await requireDecision(
      store,
      targetId,
      `Arbitrators disagree about ${targetId}`,
      [...evidence, ...arbitrators.flatMap(({ evidence: value }) => value)],
      arbitratorEdges.map(({ from }) => from),
    );
  }

  if (missingOwners.length > 0) {
    if (arbitrator?.verdict === "approve") {
      await recordOverride(
        store,
        targetId,
        arbitrator,
        ownerVetoes,
        missingOwners.map(({ from }) => from),
      );
      ownerVetoes = [];
    } else if (arbitrator?.verdict === "veto") {
      await recordResolution(store, targetId, "vetoed", ownerDecisions, arbitrator.evidence);
      return { allowed: false, reason: `Arbitrator vetoed ${targetId}: ${arbitrator.sourceId}` };
    } else {
      return await requireDecision(
        store,
        targetId,
        `Control owners have not authorized acceptance of ${targetId}`,
        [...evidence, ...ownerDecisions.flatMap(({ evidence: value }) => value)],
        arbitratorEdges.length > 0
          ? arbitratorEdges.map(({ from }) => from)
          : missingOwners.map(({ from }) => from),
      );
    }
  }

  if (ownerApprovals.length > 0 && ownerVetoes.length > 0) {
    if (!arbitrator)
      return await requireDecision(
        store,
        targetId,
        `Control owners disagree about ${targetId}`,
        [...evidence, ...ownerDecisions.flatMap(({ evidence: value }) => value)],
        arbitratorEdges.length > 0
          ? arbitratorEdges.map(({ from }) => from)
          : owners.map(({ from }) => from),
      );
    if (arbitrator.verdict === "approve") {
      await recordOverride(store, targetId, arbitrator, ownerVetoes);
      ownerVetoes = [];
    } else {
      await recordResolution(store, targetId, "vetoed", ownerDecisions, arbitrator.evidence);
      return { allowed: false, reason: `Arbitrator vetoed ${targetId}: ${arbitrator.sourceId}` };
    }
  }
  if (ownerVetoes.length > 0) {
    if (arbitrator?.verdict === "approve") {
      await recordOverride(store, targetId, arbitrator, ownerVetoes);
      ownerVetoes = [];
      ownerApprovals = [];
    } else if (arbitrator?.verdict === "veto") {
      await recordResolution(store, targetId, "vetoed", ownerVetoes, arbitrator.evidence);
      return { allowed: false, reason: `Arbitrator vetoed ${targetId}: ${arbitrator.sourceId}` };
    }
  }
  if (ownerVetoes.length > 0) {
    const reason = `Control owner vetoed ${targetId}: ${ownerVetoes.map(({ sourceId }) => sourceId).join(", ")}`;
    await recordResolution(store, targetId, "vetoed", ownerVetoes, evidence);
    return { allowed: false, reason };
  }

  const vetoes = incoming
    .filter(({ relation }) => relation === "vetoes")
    .map((edge) => decisionFor(state, edge.from, targetId))
    .filter((decision): decision is ControlDecision => decision?.verdict === "veto");
  if (vetoes.length > 0) {
    if (arbitrator?.verdict === "approve") {
      await recordOverride(store, targetId, arbitrator, vetoes);
    } else if (arbitrator?.verdict === "veto") {
      const reason = `Arbitrator vetoed ${targetId}: ${arbitrator.sourceId}`;
      await recordResolution(store, targetId, "vetoed", ownerApprovals, [
        ...evidence,
        ...arbitrator.evidence,
      ]);
      return { allowed: false, reason };
    } else if (ownerApprovals.length > 0) {
      return await requireDecision(
        store,
        targetId,
        `Owner approval conflicts with a veto on ${targetId}`,
        [...evidence, ...vetoes.flatMap(({ evidence: value }) => value)],
        arbitratorEdges.length > 0
          ? arbitratorEdges.map(({ from }) => from)
          : owners.map(({ from }) => from),
      );
    } else {
      const reason = `Control vetoed ${targetId}: ${vetoes
        .map(({ sourceId, rationale }) => `${sourceId} (${rationale})`)
        .join(", ")}`;
      await recordResolution(
        store,
        targetId,
        "vetoed",
        [],
        [...evidence, ...vetoes.flatMap(({ evidence: value }) => value)],
      );
      return { allowed: false, reason };
    }
  }

  await recordResolution(store, targetId, "approved", ownerApprovals, evidence);
  return { allowed: true };
}

export async function decideRunControl(
  store: RunStore,
  input: UserControlDecisionInput,
): Promise<RunState> {
  const lock = new RunLock(join(store.graphcraftRoot, "locks", `${store.runId}.lock`));
  await lock.acquire();
  try {
    const [graph, state] = await Promise.all([store.loadGraph(), store.loadState()]);
    const anchor = graph.anchors.find(({ id }) => id === input.sourceId);
    if (!anchor || anchor.owner !== "user")
      throw new Error(`Control source ${input.sourceId} is not owned by the user`);
    if (!authorityEdge(graph, input.sourceId, input.targetId))
      throw new Error(`Control source ${input.sourceId} has no authority over ${input.targetId}`);
    if (
      state.pendingDecision?.targetId === input.targetId &&
      !state.pendingDecision.requiredSources.includes(input.sourceId)
    ) {
      throw new Error(
        `Decision for ${input.targetId} requires one of: ${state.pendingDecision.requiredSources.join(", ")}`,
      );
    }
    const previous = state.controlDecisions.findLast(
      ({ sourceId, targetId }) => sourceId === input.sourceId && targetId === input.targetId,
    );
    if (previous?.sticky && input.replaces !== previous.decisionId)
      throw new Error(`Sticky decision ${previous.decisionId} requires explicit replacement`);
    if (input.replaces && previous?.decisionId !== input.replaces)
      throw new Error(`Replacement decision ${input.replaces} is not current`);
    const decision = ControlDecisionSchema.parse({
      schemaVersion: 1,
      decisionId: randomUUID(),
      sourceId: input.sourceId,
      targetId: input.targetId,
      verdict: input.verdict,
      rationale: input.rationale,
      evidence: input.evidence ?? [],
      actor: "user",
      sticky: true,
      decidedAt: new Date().toISOString(),
      ...(input.replaces ? { replaces: input.replaces } : {}),
    });
    await appendDecision(store, decision);
    return await store.loadState();
  } finally {
    await lock.release();
  }
}
