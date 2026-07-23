import { z } from "zod";
import type { RunContract, RunEvent, RunState } from "./schemas.ts";
import {
  ControlDecisionPacketSchema,
  ControlDecisionSchema,
  OptimizationDecisionSchema,
  ProgressDecisionPacketSchema,
  ProgressTrajectoryEntrySchema,
  RunContractSchema,
  RunStateSchema,
  SideEffectClaimSchema,
  SideEffectJournalEntrySchema,
  TokenAttributionPhaseSchema,
  TokenLedgerEntrySchema,
  TokenUsageSchema,
  WaitRuntimeStateSchema,
} from "./schemas.ts";
import { verifyRunEvent } from "./events.ts";
import { aggregateTokenUsage, unavailableTokenUsage } from "./tokens.ts";

function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Event data.${key} must be a string`);
  return value;
}

function requiredRecord(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = data[key];
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Event data.${key} must be an object`);
  return value as Record<string, unknown>;
}

export function reduceEvents(events: RunEvent[]): RunState {
  let state: RunState | undefined;
  let previousSequence = 0;

  for (const event of events) {
    verifyRunEvent(event);
    if (event.sequence !== previousSequence + 1) {
      throw new Error(
        `Expected event sequence ${previousSequence + 1}, received ${event.sequence}`,
      );
    }
    previousSequence = event.sequence;

    if (!state) {
      if (event.type !== "run.created") throw new Error("The first event must be run.created");
      const contract = RunContractSchema.parse(event.data.contract) as RunContract;
      const nodeIds = Array.isArray(event.data.nodeIds)
        ? event.data.nodeIds.map((value) => String(value))
        : [];
      state = {
        schemaVersion: 1,
        runId: contract.runId,
        status: "awaiting_approval",
        lastEventSequence: event.sequence,
        nodes: Object.fromEntries(
          nodeIds.map((id) => [id, { status: "pending" as const, attempts: 0 }]),
        ),
        latestProgressEvidence: [],
        progressTrajectory: [],
        tokens: unavailableTokenUsage(),
        tokenLedger: [],
        optimizationDecisions: [],
        sideEffects: [],
        waits: [],
        controlDecisions: [],
        updatedAt: event.timestamp,
      };
      continue;
    }

    const data = event.data;
    switch (event.type) {
      case "run.approved":
        state.status = "running";
        break;
      case "run.started":
        state.status = "running";
        state.stopReason = undefined;
        state.progressDecision = undefined;
        break;
      case "run.waiting":
        state.status = "waiting";
        state.currentNodeId = undefined;
        state.stopReason = requiredString(data, "reason");
        break;
      case "run.paused":
        state.status = "paused";
        state.stopReason = requiredString(data, "reason");
        break;
      case "run.stopped":
        state.status = "stopped";
        state.stopReason = requiredString(data, "reason");
        break;
      case "run.blocked":
        state.status = "blocked";
        state.stopReason = requiredString(data, "reason");
        state.progressDecision = data.progressDecision
          ? ProgressDecisionPacketSchema.parse(data.progressDecision)
          : undefined;
        break;
      case "run.completed":
        state.status = "completed";
        state.currentNodeId = undefined;
        break;
      case "node.started": {
        const nodeId = requiredString(data, "nodeId");
        const nodeState = state.nodes[nodeId];
        if (!nodeState) throw new Error(`Unknown node ${nodeId}`);
        nodeState.status = "running";
        nodeState.attempts += 1;
        state.currentNodeId = nodeId;
        break;
      }
      case "node.progress": {
        const nodeId = requiredString(data, "nodeId");
        const nodeState = state.nodes[nodeId];
        if (!nodeState) throw new Error(`Unknown node ${nodeId}`);
        const classification = requiredString(data, "classification") as NonNullable<
          (typeof nodeState)["lastProgress"]
        >;
        nodeState.lastProgress = classification;
        nodeState.lastSummary = typeof data.summary === "string" ? data.summary : undefined;
        state.latestProgressEvidence = Array.isArray(data.evidence)
          ? data.evidence.map((value) => String(value))
          : [];
        if (data.trajectory) {
          const entry = ProgressTrajectoryEntrySchema.parse(data.trajectory);
          if (!state.progressTrajectory.some(({ attemptId }) => attemptId === entry.attemptId))
            state.progressTrajectory = [...state.progressTrajectory, entry].slice(-100);
        }
        break;
      }
      case "node.accepted": {
        const nodeId = requiredString(data, "nodeId");
        const nodeState = state.nodes[nodeId];
        if (!nodeState) throw new Error(`Unknown node ${nodeId}`);
        nodeState.status = "accepted";
        nodeState.acceptedAt = event.timestamp;
        state.currentNodeId = undefined;
        break;
      }
      case "node.failed": {
        const nodeId = requiredString(data, "nodeId");
        const nodeState = state.nodes[nodeId];
        if (!nodeState) throw new Error(`Unknown node ${nodeId}`);
        nodeState.status = "failed";
        nodeState.lastSummary = requiredString(data, "reason");
        state.currentNodeId = undefined;
        break;
      }
      case "node.reset": {
        const nodeId = requiredString(data, "nodeId");
        const nodeState = state.nodes[nodeId];
        if (!nodeState) throw new Error(`Unknown node ${nodeId}`);
        if (nodeState.status !== "accepted") nodeState.status = "pending";
        state.currentNodeId = undefined;
        break;
      }
      case "tokens.recorded": {
        const phase = TokenAttributionPhaseSchema.catch("worker").parse(data.phase);
        const entry = TokenLedgerEntrySchema.parse({
          sequence: event.sequence,
          phase,
          usage: TokenUsageSchema.parse(data.usage),
          causationId: event.causationId,
          ...(typeof data.nodeId === "string" ? { nodeId: data.nodeId } : {}),
          ...(typeof data.host === "string" ? { host: data.host } : {}),
          recovered: data.recovered === true,
          missing: data.missing === true,
        });
        if (!entry.missing)
          state.tokenLedger = state.tokenLedger.filter(
            (candidate) =>
              !(
                candidate.missing &&
                candidate.causationId === entry.causationId &&
                candidate.phase === entry.phase
              ),
          );
        state.tokenLedger.push(entry);
        state.tokens = aggregateTokenUsage(state.tokenLedger.map(({ usage }) => usage));
        break;
      }
      case "optimizer.decided":
        state.optimizationDecisions.push(OptimizationDecisionSchema.parse(data.decision));
        state.optimizationDecisions = state.optimizationDecisions.slice(-200);
        break;
      case "side_effect.claimed": {
        const claim = SideEffectClaimSchema.parse(data.claim);
        if (state.sideEffects.some(({ claim: existing }) => existing.actionId === claim.actionId))
          throw new Error(`Side effect ${claim.actionId} was claimed more than once`);
        state.sideEffects.push(
          SideEffectJournalEntrySchema.parse({
            claim,
            status: "claimed",
            reconciliationAttempts: 0,
            updatedAt: event.timestamp,
          }),
        );
        break;
      }
      case "side_effect.dispatched": {
        const actionId = requiredString(data, "actionId");
        const entry = state.sideEffects.find(({ claim }) => claim.actionId === actionId);
        if (!entry) throw new Error(`Unknown side effect ${actionId}`);
        if (entry.dispatchedAt)
          throw new Error(`Side effect ${actionId} was marked dispatched more than once`);
        entry.dispatchedAt = event.timestamp;
        entry.updatedAt = event.timestamp;
        break;
      }
      case "side_effect.reconciled": {
        const actionId = requiredString(data, "actionId");
        const entry = state.sideEffects.find(({ claim }) => claim.actionId === actionId);
        if (!entry) throw new Error(`Unknown side effect ${actionId}`);
        const outcome = requiredString(data, "outcome");
        if (!["applied", "not_applied", "unknown"].includes(outcome))
          throw new Error(`Unsupported side-effect reconciliation outcome ${outcome}`);
        entry.reconciliationAttempts += 1;
        entry.status =
          entry.status === "confirmed" && outcome === "applied"
            ? "confirmed"
            : outcome === "unknown"
              ? "uncertain"
              : "claimed";
        entry.evidence = Array.isArray(data.evidence)
          ? data.evidence.map((value) => String(value))
          : [];
        entry.updatedAt = event.timestamp;
        break;
      }
      case "side_effect.confirmed": {
        const actionId = requiredString(data, "actionId");
        const entry = state.sideEffects.find(({ claim }) => claim.actionId === actionId);
        if (!entry) throw new Error(`Unknown side effect ${actionId}`);
        entry.status = "confirmed";
        entry.result = requiredRecord(data, "result");
        entry.evidence = Array.isArray(data.evidence)
          ? data.evidence.map((value) => String(value))
          : entry.evidence;
        entry.failure = undefined;
        entry.retryable = undefined;
        entry.updatedAt = event.timestamp;
        break;
      }
      case "side_effect.failed": {
        const actionId = requiredString(data, "actionId");
        const entry = state.sideEffects.find(({ claim }) => claim.actionId === actionId);
        if (!entry) throw new Error(`Unknown side effect ${actionId}`);
        entry.status = data.uncertain === true ? "uncertain" : "failed";
        entry.failure = requiredString(data, "reason");
        entry.retryable = data.retryable === true;
        entry.updatedAt = event.timestamp;
        break;
      }
      case "wait.registered": {
        const wait = WaitRuntimeStateSchema.parse(data.wait);
        if (state.waits.some(({ nodeId }) => nodeId === wait.nodeId))
          throw new Error(`Wait node ${wait.nodeId} was registered more than once`);
        const nodeState = state.nodes[wait.nodeId];
        if (!nodeState) throw new Error(`Unknown wait node ${wait.nodeId}`);
        nodeState.status = "waiting";
        state.currentNodeId = undefined;
        state.waits.push(wait);
        break;
      }
      case "wait.rebound": {
        const nodeId = requiredString(data, "nodeId");
        const wait = state.waits.find((candidate) => candidate.nodeId === nodeId);
        if (!wait) throw new Error(`Unknown wait node ${nodeId}`);
        const previousBaseSha = requiredString(data, "previousBaseSha");
        const baseSha = requiredString(data, "baseSha");
        if (wait.bindingBaseSha && wait.bindingBaseSha !== previousBaseSha)
          throw new Error(`Wait node ${nodeId} base binding changed concurrently`);
        wait.bindingBaseSha = baseSha;
        wait.evidence = Array.isArray(data.evidence)
          ? data.evidence.map((value) => String(value))
          : wait.evidence;
        wait.updatedAt = event.timestamp;
        break;
      }
      case "wait.human_decision_observed": {
        const nodeId = requiredString(data, "nodeId");
        const wait = state.waits.find((candidate) => candidate.nodeId === nodeId);
        if (!wait) throw new Error(`Unknown wait node ${nodeId}`);
        wait.stickyHumanDecision = {
          kind: z.enum(["draft", "changes_requested"]).parse(data.kind),
          observedAt: event.timestamp,
          snapshotId: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(data.snapshotId),
          evidence: Array.isArray(data.evidence) ? data.evidence.map((value) => String(value)) : [],
        };
        wait.updatedAt = event.timestamp;
        break;
      }
      case "wait.human_decision_resolved": {
        const nodeId = requiredString(data, "nodeId");
        const wait = state.waits.find((candidate) => candidate.nodeId === nodeId);
        if (!wait) throw new Error(`Unknown wait node ${nodeId}`);
        const kind = requiredString(data, "kind");
        if (wait.stickyHumanDecision?.kind !== kind)
          throw new Error(`Wait node ${nodeId} has no matching sticky human decision`);
        delete wait.stickyHumanDecision;
        wait.updatedAt = event.timestamp;
        break;
      }
      case "wait.observed": {
        const nodeId = requiredString(data, "nodeId");
        const wait = state.waits.find((candidate) => candidate.nodeId === nodeId);
        if (!wait) throw new Error(`Unknown wait node ${nodeId}`);
        wait.observations += 1;
        wait.nextWakeAt = requiredString(data, "nextWakeAt");
        if (typeof data.signature === "string") wait.lastSignature = data.signature;
        wait.evidence = Array.isArray(data.evidence)
          ? data.evidence.map((value) => String(value))
          : [];
        wait.updatedAt = event.timestamp;
        break;
      }
      case "wait.rearmed": {
        const nodeId = requiredString(data, "nodeId");
        const wait = state.waits.find((candidate) => candidate.nodeId === nodeId);
        if (!wait) throw new Error(`Unknown wait node ${nodeId}`);
        const signature = requiredString(data, "signature");
        if (wait.lastSignature !== signature)
          throw new Error(`Wait node ${nodeId} cannot rearm an unobserved signature`);
        wait.nextWakeAt = requiredString(data, "nextWakeAt");
        wait.evidence = Array.isArray(data.evidence)
          ? data.evidence.map((value) => String(value))
          : wait.evidence;
        wait.updatedAt = event.timestamp;
        break;
      }
      case "wait.satisfied": {
        const nodeId = requiredString(data, "nodeId");
        const wait = state.waits.find((candidate) => candidate.nodeId === nodeId);
        if (!wait) throw new Error(`Unknown wait node ${nodeId}`);
        wait.status = "satisfied";
        wait.evidence = Array.isArray(data.evidence)
          ? data.evidence.map((value) => String(value))
          : wait.evidence;
        if (typeof data.signature === "string") wait.lastSignature = data.signature;
        wait.updatedAt = event.timestamp;
        break;
      }
      case "wait.timed_out": {
        const nodeId = requiredString(data, "nodeId");
        const wait = state.waits.find((candidate) => candidate.nodeId === nodeId);
        if (!wait) throw new Error(`Unknown wait node ${nodeId}`);
        wait.status = "timed_out";
        wait.evidence = Array.isArray(data.evidence)
          ? data.evidence.map((value) => String(value))
          : wait.evidence;
        if (typeof data.signature === "string") wait.lastSignature = data.signature;
        wait.updatedAt = event.timestamp;
        break;
      }
      case "graph.amended": {
        const addedNodeIds = Array.isArray(data.addedNodeIds)
          ? data.addedNodeIds.map((value) => String(value))
          : [];
        const removedNodeIds = Array.isArray(data.removedNodeIds)
          ? data.removedNodeIds.map((value) => String(value))
          : [];
        for (const nodeId of addedNodeIds) {
          state.nodes[nodeId] ??= { status: "pending", attempts: 0 };
        }
        for (const nodeId of removedNodeIds) {
          const nodeState = state.nodes[nodeId];
          if (!nodeState) throw new Error(`Unknown superseded node ${nodeId}`);
          if (nodeState.status === "accepted")
            throw new Error(`Accepted node ${nodeId} cannot be superseded`);
          nodeState.status = "superseded";
          if (state.currentNodeId === nodeId) state.currentNodeId = undefined;
        }
        break;
      }
      case "invocation.started":
      case "invocation.session":
      case "invocation.resumed":
      case "invocation.finished":
      case "control.applied":
      case "context.selected":
      case "held_out.checked":
      case "semantic.started":
      case "semantic.verdict":
      case "scope.started":
      case "scope.checked":
      case "probe.process.started":
      case "probe.process.finished":
      case "probe.process.reconciled":
      case "control.observed":
      case "control.override":
        break;
      case "control.decision": {
        const decision = ControlDecisionSchema.parse(data.decision);
        if (decision.replaces) {
          state.controlDecisions = state.controlDecisions.filter(
            ({ decisionId }) => decisionId !== decision.replaces,
          );
        }
        state.controlDecisions = state.controlDecisions.filter(
          ({ sourceId, targetId }) =>
            sourceId !== decision.sourceId || targetId !== decision.targetId,
        );
        state.controlDecisions.push(decision);
        break;
      }
      case "control.decision_required":
        state.pendingDecision = ControlDecisionPacketSchema.parse(data.packet);
        break;
      case "control.resolved":
        if (state.pendingDecision?.targetId === requiredString(data, "targetId"))
          state.pendingDecision = undefined;
        break;
      case "run.created":
        throw new Error("run.created may only appear once");
    }
    state.lastEventSequence = event.sequence;
    state.updatedAt = event.timestamp;
    state = RunStateSchema.parse(state);
  }

  if (!state) throw new Error("Cannot reduce an empty event stream");
  return RunStateSchema.parse(state);
}
