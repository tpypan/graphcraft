import type { RunContract, RunEvent, RunState, TokenUsage } from "./schemas.ts";
import { RunContractSchema, RunStateSchema, TokenUsageSchema } from "./schemas.ts";
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
        tokens: { ...emptyTokens },
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
        for (const nodeId of addedNodeIds) {
          state.nodes[nodeId] ??= { status: "pending", attempts: 0 };
        }
        break;
      }
      case "invocation.started":
      case "invocation.session":
      case "invocation.resumed":
      case "invocation.finished":
      case "control.applied":
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
