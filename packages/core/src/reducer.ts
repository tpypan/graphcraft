import type { RunContract, RunEvent, RunState, TokenUsage } from "./schemas.ts";
import {
  ControlDecisionPacketSchema,
  ControlDecisionSchema,
  ProgressDecisionPacketSchema,
  ProgressTrajectoryEntrySchema,
  RunContractSchema,
  RunStateSchema,
  TokenUsageSchema,
} from "./schemas.ts";
import { verifyRunEvent } from "./events.ts";

const emptyTokens: TokenUsage = { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 };

function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Event data.${key} must be a string`);
  return value;
}

function addTokens(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    cachedInput: left.cachedInput + right.cachedInput,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    total: left.total + right.total,
  };
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
        tokens: { ...emptyTokens },
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
      case "tokens.recorded":
        state.tokens = addTokens(state.tokens, TokenUsageSchema.parse(data.usage));
        break;
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
      case "held_out.checked":
      case "semantic.verdict":
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
