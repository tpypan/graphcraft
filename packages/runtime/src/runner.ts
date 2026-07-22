import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  HostTerminationError,
  OptimizationDecisionSchema,
  SemanticVerifierContextSchema,
  WorkerResultSchema,
  applyProbePlan,
  classifyProgress,
  compileGraph,
  compilePlannedGraph,
  compileRunContract,
  contentHash,
  deterministicTokenUsage,
  evidenceSnapshot,
  interruptionReason,
  optimizeGraph,
  resolveHeldOutProbes,
  unavailableTokenUsage,
  workerVisibleProbePlan,
  type EvidenceSnapshot,
  type ExecutableProbe,
  type Graph,
  type GraphAmendment,
  type GraphPlanner,
  type GraphNode,
  type HostAdapter,
  type HostEvent,
  type HostTermination,
  type HeldOutProbePlan,
  type InvocationRecord,
  type OptimizationDecision,
  type PlannedGraphNode,
  type ProbeResult,
  type ProbePlan,
  type ProgressDecisionPacket,
  type ProgressTrajectoryEntry,
  type RunContract,
  type RunControlRequest,
  type RunState,
  type TokenUsage,
  type SemanticVerdict,
  type WorkerResult,
} from "@graphcraft/core";
import {
  discoverProbePlan,
  runProcess,
  runProbes,
  validateProbePlan,
  workspaceDigest,
  type ExecutedProbe,
} from "@graphcraft/probes";
import { RunLock } from "./lock.ts";
import { applyRunGraphAmendmentLocked } from "./amendment.ts";
import { requestRunControl, RunControlChannel } from "./control.ts";
import {
  evaluateControlAcceptance,
  evaluateControlScheduling,
  recordRunApprovalDecisions,
  recordRuntimeControlDecision,
  type ControlEvaluation,
} from "./governance.ts";
import {
  createAtomicCommitClaim,
  discoverPlanningEvidence,
  createRunWorkspace,
  discoverRepository,
  performAtomicCommit,
  reconcileAtomicCommit,
  type RunWorkspace,
} from "./repository.ts";
import {
  SideEffectBoundaryInterruption,
  crossSideEffectBoundary,
  executeSideEffect,
  type SideEffectBoundary,
} from "./side-effect.ts";
import { RunStore } from "./store.ts";
import { groundedRelevantPaths, prepareWorkerContext } from "./context.ts";
import {
  actionableHeldOutFailures,
  createRuntimeHeldOutProbePlan,
  heldOutIntegrityFailures,
} from "./held-out.ts";
import { assessRunProgress, createProgressDecisionPacket } from "./trajectory.ts";

export interface CreateRunOptions {
  cwd: string;
  finishLine?: "local_verified" | "committed";
  planner?: GraphPlanner;
  signal?: AbortSignal;
}

export interface RunObserverEvent {
  type: "status" | "host" | "probe";
  message: string;
}

export type RunObserver = (event: RunObserverEvent) => void;

function populateMissingGraphContext(
  graph: Graph,
  repositoryEvidence: Awaited<ReturnType<typeof discoverPlanningEvidence>>,
): Graph {
  const evidencePaths = repositoryEvidence.files.map(({ path }) => path);
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.kind === "commit" || node.contextSelector.relevantPaths.length > 0
        ? node
        : {
            ...node,
            contextSelector: {
              ...node.contextSelector,
              relevantPaths: [
                ...new Set([
                  ...groundedRelevantPaths(evidencePaths, node.objective),
                  ...groundedRelevantPaths(repositoryEvidence.trackedPaths, node.objective),
                ]),
              ].slice(0, 4),
            },
          },
    ),
  };
}

interface RecoverableInvocation {
  adapterId: string;
  nodeId: string;
  record: InvocationRecord;
}

function persistedBaseline(value: unknown, family: Graph["family"]): EvidenceSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<EvidenceSnapshot>;
  if (
    typeof candidate.digest !== "string" ||
    typeof candidate.workspaceDigest !== "string" ||
    typeof candidate.passed !== "number" ||
    typeof candidate.failed !== "number" ||
    typeof candidate.failureSignature !== "string" ||
    !Array.isArray(candidate.probeResults)
  )
    return undefined;
  return evidenceSnapshot(
    candidate.workspaceDigest,
    candidate.probeResults as ProbeResult[],
    family,
  );
}

async function recoverableInvocation(
  store: RunStore,
  nodeId: string,
  repositoryPath: string,
  family: Graph["family"],
): Promise<RecoverableInvocation | undefined> {
  const events = await store.loadEvents();
  const started = events.findLast(
    ({ type, data }) =>
      type === "invocation.started" &&
      data.nodeId === nodeId &&
      typeof data.invocationId === "string",
  );
  if (!started) return undefined;
  const invocationId = String(started.data.invocationId);
  const finished = events.findLast(
    ({ type, data }) => type === "invocation.finished" && data.invocationId === invocationId,
  );
  if (finished && finished.data.success !== true && finished.data.interrupted !== true)
    return undefined;
  const session = events.findLast(
    ({ type, data }) =>
      type === "invocation.session" &&
      data.invocationId === invocationId &&
      typeof data.hostSessionId === "string",
  );
  const transcript = await store.loadInvocationEvents(invocationId).catch(() => []);
  const transcriptSession = transcript.findLast((event) => event.type === "session");
  const hostSessionId = session
    ? String(session.data.hostSessionId)
    : transcriptSession?.type === "session"
      ? transcriptSession.hostSessionId
      : typeof started.data.reusedHostSessionId === "string"
        ? started.data.reusedHostSessionId
        : undefined;
  const baseline = persistedBaseline(started.data.baseline, family);
  return {
    adapterId: String(started.data.adapter ?? ""),
    nodeId,
    record: {
      invocationId,
      repositoryPath,
      startedAt: started.timestamp,
      ...(hostSessionId ? { hostSessionId } : {}),
      ...(baseline ? { baseline } : {}),
      transcript,
    },
  };
}

async function recordMissingUsage(
  store: RunStore,
  invocation: InvocationRecord,
  node: GraphNode,
  host: string,
): Promise<void> {
  const transcriptUsage = (invocation.transcript ?? []).filter(
    (event): event is Extract<HostEvent, { type: "usage" }> => event.type === "usage",
  );
  const events = await store.loadEvents();
  const recordedCount = events.filter(
    ({ type, causationId, data }) =>
      type === "tokens.recorded" &&
      causationId === invocation.invocationId &&
      data.missing !== true,
  ).length;
  const phase = node.id.startsWith("repair-") ? "repair" : "worker";
  for (const event of transcriptUsage.slice(recordedCount))
    await store.append(
      "host",
      "tokens.recorded",
      { usage: event.usage, recovered: true, phase, nodeId: node.id, host },
      invocation.invocationId,
    );
  if (
    transcriptUsage.length === 0 &&
    (invocation.transcript ?? []).some(({ type }) => type === "result") &&
    !events.some(
      ({ type, causationId }) =>
        type === "tokens.recorded" && causationId === invocation.invocationId,
    )
  )
    await store.append(
      "host",
      "tokens.recorded",
      {
        usage: unavailableTokenUsage(),
        phase,
        nodeId: node.id,
        host,
        missing: true,
        recovered: true,
      },
      invocation.invocationId,
    );
}

async function validatePlannedContext(graph: Graph, repositoryPath: string): Promise<void> {
  for (const node of graph.nodes) {
    if (node.kind === "commit") continue;
    if (node.contextSelector.relevantPaths.length === 0)
      throw new Error(`Planned node ${node.id} did not select repository evidence`);
    for (const relevantPath of node.contextSelector.relevantPaths) {
      const result = await runProcess("git", ["ls-files", "--", relevantPath], {
        cwd: repositoryPath,
        timeoutMs: 30_000,
      });
      if (result.exitCode !== 0 || result.stdout.trim().length === 0)
        throw new Error(
          `Planned node ${node.id} selected nonexistent or untracked context path ${relevantPath}`,
        );
    }
  }
}

export async function createRun(
  task: string,
  options: CreateRunOptions,
): Promise<{
  contract: RunContract;
  graph: Graph;
  store: RunStore;
  probePlan: ProbePlan;
}> {
  const repository = await discoverRepository(options.cwd);
  const [probePlan, repositoryEvidence] = await Promise.all([
    discoverProbePlan(repository.root, task, repository.baseSha),
    discoverPlanningEvidence(repository.root, task),
  ]);
  const contract = compileRunContract(task, repository, {
    ...(options.finishLine ? { finishLine: options.finishLine } : {}),
  });
  const heldOutProbePlan = await createRuntimeHeldOutProbePlan(
    contract.runId,
    probePlan,
    repository.root,
  );
  const graphProbePlan = workerVisibleProbePlan(probePlan, heldOutProbePlan);
  const completionProbes = graphProbePlan.items
    .filter(({ phase }) => phase === "completion")
    .map(({ probe }) => probe);
  const approvedProbes = graphProbePlan.items.map(({ probe }) => probe);
  let graph: Graph;
  let planningUsage: TokenUsage | undefined;
  if (options.planner) {
    const capabilities = await options.planner.probe();
    if (
      !capabilities.installed ||
      !capabilities.authenticated ||
      !capabilities.structuredOutput ||
      !capabilities.streamingEvents
    ) {
      throw new Error(
        `${options.planner.id} is not authenticated or does not provide the required structured unattended interface`,
      );
    }
    const planned = await options.planner.plan(
      {
        contract,
        repositoryPath: repository.root,
        repositoryEvidence,
        probePlan: graphProbePlan,
        verificationProbes: completionProbes,
      },
      options.signal ?? new AbortController().signal,
    );
    graph = compilePlannedGraph(contract, planned.plan, completionProbes, approvedProbes);
    await validatePlannedContext(graph, repository.root);
    planningUsage = planned.usage;
  } else {
    graph = compileGraph(contract, completionProbes);
  }
  graph = applyProbePlan(graph, contract, graphProbePlan);
  graph = populateMissingGraphContext(graph, repositoryEvidence);
  const optimized = optimizeGraph({
    graph,
    contract,
    requiredVerificationProbes: completionProbes,
    approvedProbes,
  });
  graph = optimized.graph;
  await validatePlannedContext(graph, repository.root);
  const store = await RunStore.create(
    repository.root,
    contract,
    graph,
    probePlan,
    heldOutProbePlan,
  );
  for (const decision of optimized.decisions)
    await store.append("runtime", "optimizer.decided", { decision }, decision.decisionId);
  await store.append("runtime", "tokens.recorded", {
    usage: deterministicTokenUsage(),
    phase: "graphcraft_overhead",
  });
  if (options.planner)
    await store.append("host", "tokens.recorded", {
      usage: planningUsage ?? unavailableTokenUsage(),
      phase: "planning",
      host: options.planner.id,
      missing: !planningUsage,
    });
  return { contract, graph, store, probePlan };
}

export async function configureRunProbes(
  store: RunStore,
  input: ProbePlan,
): Promise<{ graph: Graph; probePlan: ProbePlan }> {
  const lock = new RunLock(join(store.graphcraftRoot, "locks", `${store.runId}.lock`));
  await lock.acquire();
  try {
    const state = await store.loadState();
    if (state.status !== "awaiting_approval")
      throw new Error("Probes can only be edited before the run contract is approved");
    const [contract, existingGraph] = await Promise.all([store.loadContract(), store.loadGraph()]);
    const probePlan = await validateProbePlan(input, store.repositoryRoot);
    const heldOutProbePlan = await createRuntimeHeldOutProbePlan(
      contract.runId,
      probePlan,
      store.repositoryRoot,
    );
    const graphProbePlan = workerVisibleProbePlan(probePlan, heldOutProbePlan);
    const graph = applyProbePlan(
      { ...existingGraph, revision: existingGraph.revision + 1 },
      contract,
      graphProbePlan,
    );
    await store.append("user", "graph.amended", {
      graph,
      probePlan,
      heldOutProbePlan,
      addedNodeIds: [],
      rationale: "User edited the deterministic probe plan before approval",
      previousProbePlanHash: contentHash(await store.loadProbePlan()),
      probePlanHash: contentHash(probePlan),
    });
    await Promise.all([
      store.saveGraph(graph),
      store.saveProbePlan(probePlan),
      store.saveHeldOutProbePlan(heldOutProbePlan),
    ]);
    return { graph, probePlan };
  } finally {
    await lock.release();
  }
}

async function executeWorker(input: {
  adapter: HostAdapter;
  store: RunStore;
  contract: RunContract;
  node: GraphNode;
  workspace: RunWorkspace;
  predecessorEvidence?: string[];
  probeResults?: ProbeResult[];
  observer?: RunObserver;
  signal: AbortSignal;
  baseline: EvidenceSnapshot;
  resume?: InvocationRecord;
  reuseSession?: { hostSessionId: string; sourceNodeId: string };
}): Promise<{
  invocationId: string;
  result?: WorkerResult;
  error?: string;
  errorCause?: "host_crash" | "timeout";
  termination?: HostTermination;
  artifact: string;
}> {
  let invocationId = input.resume?.invocationId ?? randomUUID();
  let resumeSessionId = input.reuseSession?.hostSessionId;
  if (input.resume) {
    await recordMissingUsage(input.store, input.resume, input.node, input.adapter.id);
    const reconciliation = await input.adapter.reconcile(input.resume);
    if (reconciliation.state === "completed" && reconciliation.result) {
      const artifact = join(
        input.store.runRoot,
        "artifacts",
        "invocations",
        `${invocationId}.jsonl`,
      );
      await input.store.append(
        "runtime",
        "invocation.finished",
        { invocationId, nodeId: input.node.id, artifact, success: true, recovered: true },
        invocationId,
      );
      return {
        invocationId,
        result: WorkerResultSchema.parse(reconciliation.result),
        artifact,
      };
    }
    if (reconciliation.state === "in_progress" && input.resume.hostSessionId) {
      resumeSessionId = input.resume.hostSessionId;
      await input.store.append(
        "runtime",
        "invocation.resumed",
        { invocationId, nodeId: input.node.id, hostSessionId: resumeSessionId },
        invocationId,
      );
    } else {
      await input.store.append(
        "runtime",
        "invocation.finished",
        {
          invocationId,
          nodeId: input.node.id,
          success: false,
          reason: "Native host continuation was unavailable; using repository recovery",
        },
        invocationId,
      );
      invocationId = randomUUID();
    }
  }
  const { capsule, capsuleHash } = await prepareWorkerContext({
    store: input.store,
    invocationId,
    contract: input.contract,
    node: input.node,
    repositoryPath: input.workspace.path,
    predecessorEvidence: input.predecessorEvidence ?? [],
    probeResults: input.probeResults ?? [],
  });
  if (!input.resume || !resumeSessionId) {
    await input.store.append("runtime", "invocation.started", {
      invocationId,
      nodeId: input.node.id,
      adapter: input.adapter.id,
      capsuleHash,
      baseline: input.baseline,
      ...(input.reuseSession
        ? {
            reusedHostSessionId: input.reuseSession.hostSessionId,
            reusedFromNodeId: input.reuseSession.sourceNodeId,
          }
        : {}),
    });
  }
  let result: WorkerResult | undefined;
  let error: string | undefined;
  let errorCause: "host_crash" | "timeout" | undefined;
  let termination: HostTermination | undefined;
  let usageReceipts = 0;
  const tokenPhase = input.node.id.startsWith("repair-") ? "repair" : "worker";

  let artifact = join(input.store.runRoot, "artifacts", "invocations", `${invocationId}.jsonl`);
  const execution = input.adapter.execute(
    {
      invocationId,
      repositoryPath: input.workspace.path,
      capsule,
      allowedTools:
        input.node.sideEffectClass === "workspace_write" ? ["read", "write", "shell"] : ["read"],
      ...(resumeSessionId ? { resumeSessionId } : {}),
    },
    input.signal,
  );
  const iterator = execution[Symbol.asyncIterator]();
  while (true) {
    let next: IteratorResult<HostEvent>;
    try {
      next = await iterator.next();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      errorCause = "host_crash";
      const event: HostEvent = { type: "error", message: error, cause: errorCause };
      artifact = await input.store.appendInvocationEvent(invocationId, event);
      break;
    }
    if (next.done) break;
    const event = next.value;
    artifact = await input.store.appendInvocationEvent(invocationId, event);
    if (event.type === "session") {
      await input.store.append(
        "host",
        "invocation.session",
        { invocationId, nodeId: input.node.id, hostSessionId: event.hostSessionId },
        invocationId,
      );
    }
    if (event.type === "message") input.observer?.({ type: "host", message: event.text });
    if (event.type === "tool")
      input.observer?.({ type: "host", message: `${event.name} ${event.summary}`.trim() });
    if (event.type === "usage") {
      usageReceipts += 1;
      await input.store.append(
        "host",
        "tokens.recorded",
        {
          usage: event.usage,
          phase: tokenPhase,
          nodeId: input.node.id,
          host: input.adapter.id,
        },
        invocationId,
      );
    }
    if (event.type === "result") result = WorkerResultSchema.parse(event.result);
    if (event.type === "terminated") termination = event.termination;
    if (event.type === "error") {
      error = event.message;
      if (event.cause === "host_crash" || event.cause === "timeout") errorCause = event.cause;
    }
  }
  if (usageReceipts === 0)
    await input.store.append(
      "host",
      "tokens.recorded",
      {
        usage: unavailableTokenUsage(),
        phase: tokenPhase,
        nodeId: input.node.id,
        host: input.adapter.id,
        missing: true,
      },
      invocationId,
    );
  await input.store.append(
    "runtime",
    "invocation.finished",
    {
      invocationId,
      nodeId: input.node.id,
      artifact,
      success: Boolean(result) && !error && !termination,
      interrupted: Boolean(termination),
      ...(termination ? { termination } : {}),
      ...(errorCause ? { errorCause } : {}),
    },
    invocationId,
  );
  return {
    invocationId,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    ...(errorCause ? { errorCause } : {}),
    ...(termination ? { termination } : {}),
    artifact,
  };
}

async function captureProbes(
  store: RunStore,
  specs: GraphNode["completionProbes"],
  workspace: RunWorkspace,
  observer: RunObserver | undefined,
  signal: AbortSignal,
): Promise<ExecutedProbe[]> {
  const executed = await runProbes(specs, workspace.path, signal);
  for (const probe of executed) {
    observer?.({
      type: "probe",
      message: `${probe.result.passed ? "PASS" : "FAIL"} ${probe.result.probeId}: ${probe.result.summary}`,
    });
    if (probe.output) {
      const artifact = await store.writeArtifact(
        `probes/${probe.result.signature}.log`,
        probe.output,
      );
      probe.result.artifact = artifact;
    }
  }
  return executed;
}

function needsSemanticVerification(
  phase: "progress" | "completion",
  probes: GraphNode["progressProbes"],
  classification?: ReturnType<typeof classifyProgress>,
): boolean {
  const lacksCommandProof = probes.every(({ kind }) => kind !== "command");
  if (!lacksCommandProof) return false;
  if (phase === "completion") return true;
  return classification === "stalled" || classification === "done";
}

async function runSemanticVerification(input: {
  phase: "progress" | "completion";
  adapter: HostAdapter;
  store: RunStore;
  contract: RunContract;
  node: GraphNode;
  workspace: RunWorkspace;
  workerSummary: string;
  workerEvidence: string[];
  baselineProbeEvidence: ProbeResult[];
  currentProbeEvidence: ProbeResult[];
  signal: AbortSignal;
}): Promise<SemanticVerdict> {
  const invocationId = randomUUID();
  const context = SemanticVerifierContextSchema.parse({
    schemaVersion: 1,
    phase: input.phase,
    runId: input.contract.runId,
    nodeId: input.node.id,
    objective: input.node.objective,
    finishLine: input.contract.finishLine,
    acceptanceAnchors: input.contract.acceptanceAnchors,
    relevantPaths: input.node.contextSelector.relevantPaths,
    workerSummary: input.workerSummary,
    workerEvidence: input.workerEvidence,
    baselineProbeEvidence: input.baselineProbeEvidence,
    currentProbeEvidence: input.currentProbeEvidence,
  });
  const beforeDigest = await workspaceDigest(input.workspace.path);
  let verdictPersisted = false;
  try {
    const result = await input.adapter.verify(
      {
        invocationId,
        repositoryPath: input.workspace.path,
        context,
      },
      input.signal,
    );
    const afterDigest = await workspaceDigest(input.workspace.path);
    const policyViolation = beforeDigest !== afterDigest;
    const artifact = await input.store.writeArtifact(
      `semantic/${invocationId}.json`,
      `${JSON.stringify({ schemaVersion: 1, host: input.adapter.id, context, result, beforeDigest, afterDigest }, null, 2)}\n`,
    );
    await input.store.append(
      "host",
      "semantic.verdict",
      {
        invocationId,
        nodeId: input.node.id,
        phase: input.phase,
        host: input.adapter.id,
        verdict: result.verdict,
        usage: result.usage ?? null,
        artifact,
        policyViolation,
      },
      invocationId,
    );
    verdictPersisted = true;
    await input.store.append(
      "host",
      "tokens.recorded",
      {
        usage: result.usage ?? unavailableTokenUsage(),
        phase: "semantic_verification",
        nodeId: input.node.id,
        host: input.adapter.id,
        missing: !result.usage,
      },
      invocationId,
    );
    if (policyViolation)
      throw new Error("The read-only semantic verifier changed the repository workspace");
    return result.verdict;
  } catch (error) {
    if (error instanceof HostTerminationError) throw error;
    if (verdictPersisted) throw error;
    const artifact = await input.store.writeArtifact(
      `semantic/${invocationId}-error.json`,
      `${JSON.stringify({ schemaVersion: 1, host: input.adapter.id, context, error: (error as Error).message }, null, 2)}\n`,
    );
    await input.store.append(
      "host",
      "semantic.verdict",
      {
        invocationId,
        nodeId: input.node.id,
        phase: input.phase,
        host: input.adapter.id,
        error: (error as Error).message,
        artifact,
      },
      invocationId,
    );
    throw error;
  }
}

function acceptedNodeIds(state: RunState): Set<string> {
  return new Set(
    Object.entries(state.nodes)
      .filter(([, value]) => value.status === "accepted")
      .map(([id]) => id),
  );
}

function readyRuntimeNodes(graph: Graph, state: RunState): GraphNode[] {
  const accepted = acceptedNodeIds(state);
  return graph.nodes.filter(
    (node) =>
      state.nodes[node.id]?.status === "pending" && node.dependsOn.every((id) => accepted.has(id)),
  );
}

function scopeRoot(pattern: string): string {
  return pattern
    .replaceAll("\\", "/")
    .split(/[*?[{]/, 1)[0]!
    .replace(/\/$/, "");
}

function scopesOverlap(left: GraphNode, right: GraphNode): boolean {
  return left.scope.some((leftPattern) =>
    right.scope.some((rightPattern) => {
      const leftRoot = scopeRoot(leftPattern);
      const rightRoot = scopeRoot(rightPattern);
      return (
        leftRoot.length === 0 ||
        rightRoot.length === 0 ||
        leftRoot === rightRoot ||
        leftRoot.startsWith(`${rightRoot}/`) ||
        rightRoot.startsWith(`${leftRoot}/`)
      );
    }),
  );
}

function concurrencyConflict(
  graph: Graph,
  left: GraphNode,
  right: GraphNode,
): "control_edge" | "overlapping_scope" | "shared_worktree" | "git_side_effect" | undefined {
  if (
    graph.controlEdges.some(
      ({ from, to }) =>
        (from === left.id && to === right.id) || (from === right.id && to === left.id),
    )
  )
    return "control_edge";
  if (left.sideEffectClass === "git_commit" || right.sideEffectClass === "git_commit")
    return "git_side_effect";
  if (left.sideEffectClass !== "none" || right.sideEffectClass !== "none")
    return scopesOverlap(left, right) ? "overlapping_scope" : "shared_worktree";
  return undefined;
}

function runtimeOptimizationDecision(
  input: Omit<OptimizationDecision, "schemaVersion" | "decisionId">,
): OptimizationDecision {
  return OptimizationDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: randomUUID(),
    ...input,
  });
}

function readyBatch(
  graph: Graph,
  state: RunState,
  maxWorkers: 1 | 2,
): { nodes: GraphNode[]; decision?: OptimizationDecision } {
  const ready = readyRuntimeNodes(graph, state);
  const first = ready[0];
  if (!first) return { nodes: [] };
  if (maxWorkers === 1)
    return {
      nodes: [first],
      decision: runtimeOptimizationDecision({
        kind: "concurrency",
        choice: "sequential",
        nodeIds: [first.id],
        rationale: "The approved worker ceiling is one, so concurrency cannot reduce latency.",
        evidence: ["maxWorkers=1"],
        estimate: { modelCallsDelta: 0, contextCharactersDelta: 0, latencyTurnsDelta: 0 },
        costBasis: "deterministic_static",
      }),
    };
  if (["verification", "commit", "wait"].includes(first.kind))
    return {
      nodes: [first],
      decision: runtimeOptimizationDecision({
        kind: "concurrency",
        choice: "sequential",
        nodeIds: [first.id],
        rationale:
          "Verification, waiting, and Git side effects retain a single authoritative order.",
        evidence: [`${first.kind} nodes are serialized`],
        estimate: { modelCallsDelta: 0, contextCharactersDelta: 0, latencyTurnsDelta: 0 },
        costBasis: "deterministic_static",
      }),
    };
  const second = ready
    .slice(1)
    .find(
      (candidate) =>
        !["verification", "commit", "wait"].includes(candidate.kind) &&
        !concurrencyConflict(graph, first, candidate),
    );
  if (!second)
    return {
      nodes: [first],
      decision: runtimeOptimizationDecision({
        kind: "concurrency",
        choice: "sequential",
        nodeIds: [first.id],
        rationale:
          "No second ready node was both dependency-independent and free of control, scope, workspace, or Git conflicts.",
        evidence: [`${ready.length} ready node${ready.length === 1 ? "" : "s"}`],
        estimate: { modelCallsDelta: 0, contextCharactersDelta: 0, latencyTurnsDelta: 0 },
        costBasis: "deterministic_static",
      }),
    };
  return {
    nodes: [first, second],
    decision: runtimeOptimizationDecision({
      kind: "concurrency",
      choice: "parallel",
      nodeIds: [first.id, second.id],
      rationale:
        "Two ready read-only nodes have independent dependencies and no control or mutation conflict, so overlap reduces one latency turn without adding a model call.",
      evidence: ["sideEffectClass=none", "no dependency or control conflict"],
      estimate: { modelCallsDelta: 0, contextCharactersDelta: 0, latencyTurnsDelta: -1 },
      costBasis: "deterministic_static",
    }),
  };
}

async function hostContextOptimization(
  store: RunStore,
  graph: Graph,
  node: GraphNode,
  adapterId: string,
): Promise<{
  decision: OptimizationDecision;
  reuseSession?: { hostSessionId: string; sourceNodeId: string };
}> {
  const sourceNodeId =
    node.contextSelector.predecessorResults.length === 1
      ? node.contextSelector.predecessorResults[0]
      : undefined;
  const source = sourceNodeId
    ? graph.nodes.find((candidate) => candidate.id === sourceNodeId)
    : undefined;
  const sharedPaths = source
    ? source.contextSelector.relevantPaths.filter((path) =>
        node.contextSelector.relevantPaths.includes(path),
      )
    : [];
  const minimumContext = source
    ? Math.min(
        source.contextSelector.relevantPaths.length,
        node.contextSelector.relevantPaths.length,
      )
    : 0;
  const eligible =
    source !== undefined &&
    source.sideEffectClass === node.sideEffectClass &&
    !["verification", "commit", "wait"].includes(source.kind) &&
    !["verification", "commit", "wait"].includes(node.kind) &&
    minimumContext > 0 &&
    sharedPaths.length / minimumContext >= 0.5;
  const events = eligible ? await store.loadEvents() : [];
  const sourceUsage = eligible
    ? (await store.loadState()).tokenLedger.filter(
        (entry) =>
          entry.nodeId === sourceNodeId &&
          !entry.missing &&
          ["reported", "derived"].includes(entry.usage.availability.total),
      )
    : [];
  const started = eligible
    ? events.findLast(
        ({ type, data }) =>
          type === "invocation.started" &&
          data.nodeId === sourceNodeId &&
          data.adapter === adapterId &&
          typeof data.invocationId === "string",
      )
    : undefined;
  const invocationId = started ? String(started.data.invocationId) : undefined;
  const finished = invocationId
    ? events.findLast(
        ({ type, data }) =>
          type === "invocation.finished" &&
          data.invocationId === invocationId &&
          data.success === true,
      )
    : undefined;
  const session = invocationId
    ? events.findLast(
        ({ type, data }) =>
          type === "invocation.session" &&
          data.invocationId === invocationId &&
          typeof data.hostSessionId === "string",
      )
    : undefined;
  const sourceTokenTotal = sourceUsage.reduce((sum, entry) => sum + entry.usage.total, 0);
  if (eligible && finished && session && sourceNodeId && sourceTokenTotal > 0)
    return {
      decision: runtimeOptimizationDecision({
        kind: "host_context",
        choice: "reuse",
        nodeIds: [sourceNodeId, node.id],
        rationale:
          "The dependent node uses the same authority class and materially overlapping paths, so preserving its exact host reasoning avoids rebuilding equivalent dependency context.",
        evidence: [
          `${sharedPaths.length}/${minimumContext} selected paths overlap`,
          `completed ${adapterId} session is durable`,
          `${sourceTokenTotal} reconciled source tokens across ${sourceUsage.length} receipt${sourceUsage.length === 1 ? "" : "s"}`,
        ],
        estimate: { modelCallsDelta: 0, contextCharactersDelta: 0, latencyTurnsDelta: 0 },
        costBasis: "durable_receipts",
      }),
      reuseSession: {
        hostSessionId: String(session.data.hostSessionId),
        sourceNodeId,
      },
    };
  return {
    decision: runtimeOptimizationDecision({
      kind: "host_context",
      choice: "fresh",
      nodeIds: sourceNodeId ? [sourceNodeId, node.id] : [node.id],
      rationale:
        "A fresh host context keeps unrelated or differently authorized work isolated because no durable dependency session has enough selected-path overlap.",
      evidence: [
        source
          ? `${sharedPaths.length}/${minimumContext || 1} selected paths overlap; ${sourceUsage.length} reconciled source receipts`
          : "no single selected predecessor context",
      ],
      estimate: { modelCallsDelta: 0, contextCharactersDelta: 0, latencyTurnsDelta: 0 },
      costBasis: "deterministic_static",
    }),
  };
}

function repairAmendment(
  graph: Graph,
  verification: GraphNode,
  failures: ProbeResult[],
): GraphAmendment {
  const repairCount = graph.nodes.filter((node) => node.id.startsWith("repair-verify-")).length;
  const id = `repair-verify-${repairCount + 1}`;
  const originalDependencies = verification.dependsOn.filter(
    (dependency) => !dependency.startsWith("repair-verify-"),
  );
  const previousRepair = verification.dependsOn.find((dependency) =>
    dependency.startsWith("repair-verify-"),
  );
  const authoritySources = graph.nodes.filter(({ id }) => originalDependencies.includes(id));
  const failureSignature = failures
    .map(({ signature }) => signature)
    .sort()
    .join("|");
  const repair: PlannedGraphNode = {
    id,
    kind: "diagnostic",
    objective: [
      "Repair the verification failures without weakening their checks.",
      ...failures.map((failure) => `${failure.probeId}: ${failure.summary}`),
    ].join("\n"),
    dependsOn: previousRepair ? [...originalDependencies, previousRepair] : originalDependencies,
    scope: [...new Set(authoritySources.flatMap(({ scope }) => scope))],
    contextSelector: {
      includeRepositoryInstructions: true,
      predecessorResults: verification.dependsOn,
      relevantPaths: verification.contextSelector.relevantPaths,
    },
    progressProbes: [],
    completionProbes: [],
    sideEffectClass: "workspace_write",
  };
  return {
    schemaVersion: 1,
    amendmentId: randomUUID(),
    operations: [
      { operation: "add", node: repair, authoritySourceIds: originalDependencies },
      {
        operation: "dependency_change",
        targetId: verification.id,
        dependsOn: [...originalDependencies, id],
      },
    ],
    evidence: [
      `failure-signature:${failureSignature}`,
      ...failures.map(({ probeId, summary }) => `${probeId}: ${summary}`),
    ],
    rationale: "Deterministic completion probes disproved the current remaining strategy",
    changedStrategy:
      repairCount === 0
        ? "Insert a focused diagnostic repair before retrying finish-line verification"
        : "Target the changed failure signature with a new repair after the previous repair advanced",
    falsifiableExpectation: `The next verification will not report failure signature ${failureSignature}`,
  };
}

function runtimeVerifierControls(graph: Graph, targetId: string): boolean {
  return graph.controlEdges.some(
    ({ from, to, relation }) =>
      from === "runtime-verifier" && to === targetId && relation === "vetoes",
  );
}

async function recordVerifierControl(input: {
  store: RunStore;
  graph: Graph;
  targetId: string;
  verdict: "approve" | "veto";
  rationale: string;
  evidence: string[];
}): Promise<void> {
  if (!runtimeVerifierControls(input.graph, input.targetId)) return;
  await recordRuntimeControlDecision({
    ...input,
    sourceId: "runtime-verifier",
    actor: "verifier",
  });
}

async function evaluateSuccessfulControl(input: {
  store: RunStore;
  graph: Graph;
  node: GraphNode;
  rationale: string;
  evidence: string[];
}): Promise<ControlEvaluation> {
  await recordVerifierControl({
    store: input.store,
    graph: input.graph,
    targetId: input.node.id,
    verdict: "approve",
    rationale: input.rationale,
    evidence: input.evidence,
  });
  return await evaluateControlAcceptance(
    input.store,
    input.graph,
    await input.store.loadState(),
    input.node.id,
    input.evidence,
  );
}

async function strategyForNode(store: RunStore, node: GraphNode): Promise<string> {
  const revision = (await store.loadGraphHistory()).findLast(({ diff }) =>
    diff.addedNodeIds.includes(node.id),
  );
  return revision?.amendment?.proposal.changedStrategy ?? node.objective;
}

async function appendProgressTrajectory(input: {
  store: RunStore;
  trajectory: ProgressTrajectoryEntry;
  alreadyRecorded: boolean;
  summary: string;
  evidence: string[];
}): Promise<void> {
  if (input.alreadyRecorded) return;
  await input.store.append(
    "probe",
    "node.progress",
    {
      nodeId: input.trajectory.nodeId,
      classification: input.trajectory.classification,
      summary: input.summary,
      evidence: input.evidence,
      trajectory: input.trajectory,
    },
    input.trajectory.attemptId,
  );
}

async function progressPacket(input: {
  store: RunStore;
  trajectory: ProgressTrajectoryEntry;
  blocker: string;
  evidence: string[];
  invariant?: string;
}): Promise<ProgressDecisionPacket> {
  return createProgressDecisionPacket({
    state: await input.store.loadState(),
    nodeId: input.trajectory.nodeId,
    classification: input.trajectory.classification,
    strategy: input.trajectory.strategy,
    blocker: input.blocker,
    evidence: input.evidence,
    ...(input.invariant ? { invariant: input.invariant } : {}),
  });
}

type WorkNodeOutcome =
  | { status: "accepted"; nodeId: string }
  | {
      status: "failed";
      nodeId: string;
      reason: string;
      cause?: "host_crash" | "timeout";
      packet?: ControlEvaluation["packet"];
      progressDecision?: ProgressDecisionPacket;
    }
  | {
      status: "interrupted";
      nodeId: string;
      termination?: HostTermination;
      artifact: string;
    };

async function executeWorkNode(input: {
  store: RunStore;
  adapter: HostAdapter;
  contract: RunContract;
  graph: Graph;
  node: GraphNode;
  state: RunState;
  workspace: RunWorkspace;
  observer?: RunObserver;
  signal: AbortSignal;
  recovery?: InvocationRecord;
  reuseSession?: { hostSessionId: string; sourceNodeId: string };
}): Promise<WorkNodeOutcome> {
  let baseline: EvidenceSnapshot;
  let baselineProbeResults: ProbeResult[];
  if (input.recovery?.baseline) {
    baseline = input.recovery.baseline;
    baselineProbeResults = baseline.probeResults;
  } else {
    const baselineProbes = await runProbes(
      input.node.progressProbes,
      input.workspace.path,
      input.signal,
    );
    if (input.signal.aborted) return { status: "interrupted", nodeId: input.node.id, artifact: "" };
    baselineProbeResults = baselineProbes.map(({ result }) => result);
    baseline = evidenceSnapshot(
      await workspaceDigest(input.workspace.path),
      baselineProbeResults,
      input.graph.family,
    );
  }
  const worker = await executeWorker({
    adapter: input.adapter,
    store: input.store,
    contract: input.contract,
    node: input.node,
    workspace: input.workspace,
    predecessorEvidence: input.node.contextSelector.predecessorResults.flatMap((nodeId) => {
      const predecessor = input.state.nodes[nodeId];
      return predecessor?.lastSummary ? [`${nodeId}: ${predecessor.lastSummary}`] : [];
    }),
    ...(baselineProbeResults.length ? { probeResults: baselineProbeResults } : {}),
    ...(input.observer ? { observer: input.observer } : {}),
    signal: input.signal,
    baseline,
    ...(input.recovery ? { resume: input.recovery } : {}),
    ...(input.reuseSession ? { reuseSession: input.reuseSession } : {}),
  });
  if (input.signal.aborted)
    return {
      status: "interrupted",
      nodeId: input.node.id,
      ...(worker.termination ? { termination: worker.termination } : {}),
      artifact: worker.artifact,
    };
  if (!worker.result || worker.error || worker.result.status !== "completed") {
    const detail = worker.error ?? worker.result?.summary ?? "Worker did not complete the node";
    const cause = worker.errorCause ?? "host_crash";
    const reason = `${cause === "timeout" ? "Host timeout" : "Host crash"}: ${detail}`;
    await input.store.append("worker", "node.failed", {
      nodeId: input.node.id,
      reason,
      cause,
    });
    return { status: "failed", nodeId: input.node.id, reason, cause };
  }

  const afterProbes = await captureProbes(
    input.store,
    input.node.progressProbes,
    input.workspace,
    input.observer,
    input.signal,
  );
  if (input.signal.aborted)
    return {
      status: "interrupted",
      nodeId: input.node.id,
      ...(worker.termination ? { termination: worker.termination } : {}),
      artifact: worker.artifact,
    };
  const currentEvidence = evidenceSnapshot(
    await workspaceDigest(input.workspace.path),
    afterProbes.map(({ result }) => result),
    input.graph.family,
  );
  if (
    input.node.sideEffectClass === "none" &&
    currentEvidence.workspaceDigest !== baseline.workspaceDigest
  ) {
    const reason = `Read-only node ${input.node.id} mutated the shared run workspace`;
    await input.store.append("runtime", "node.failed", { nodeId: input.node.id, reason });
    return { status: "failed", nodeId: input.node.id, reason };
  }
  const assessed = await assessRunProgress({
    store: input.store,
    attemptId: worker.invocationId,
    nodeId: input.node.id,
    family: input.graph.family,
    strategy: await strategyForNode(input.store, input.node),
    baseline,
    current: currentEvidence,
  });
  const measuredClassification = assessed.trajectory.classification;
  let classification = measuredClassification;
  let semanticEvidence: string[] = [];
  let semanticStopReason: string | undefined;
  if (
    !assessed.alreadyRecorded &&
    input.node.sideEffectClass === "none" &&
    worker.result.evidence.length > 0 &&
    needsSemanticVerification("progress", input.node.progressProbes, measuredClassification)
  ) {
    let semanticVerdict: SemanticVerdict;
    try {
      semanticVerdict = await runSemanticVerification({
        phase: "progress",
        adapter: input.adapter,
        store: input.store,
        contract: input.contract,
        node: input.node,
        workspace: input.workspace,
        workerSummary: worker.result.summary,
        workerEvidence: worker.result.evidence,
        baselineProbeEvidence: baselineProbeResults,
        currentProbeEvidence: afterProbes.map(({ result }) => result),
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted)
        return {
          status: "interrupted",
          nodeId: input.node.id,
          ...(error instanceof HostTerminationError
            ? { termination: error.termination }
            : worker.termination
              ? { termination: worker.termination }
              : {}),
          artifact: worker.artifact,
        };
      const reason = `Semantic progress verification failed: ${(error as Error).message}`;
      await input.store.append("host", "node.failed", { nodeId: input.node.id, reason });
      return { status: "failed", nodeId: input.node.id, reason };
    }
    semanticEvidence = semanticVerdict.evidence;
    if (semanticVerdict.verdict === "supported") classification = "learning";
    else {
      classification = semanticVerdict.verdict === "unsupported" ? "stalled" : "blocked";
      semanticStopReason = `Semantic progress verdict was ${semanticVerdict.verdict}: ${semanticVerdict.rationale}`;
    }
  }
  const progressEvidence = [
    ...worker.result.evidence,
    ...afterProbes.map(({ result }) => result.summary),
    ...semanticEvidence,
  ];
  const trajectory: ProgressTrajectoryEntry = {
    ...assessed.trajectory,
    classification,
  };
  await appendProgressTrajectory({
    store: input.store,
    trajectory,
    alreadyRecorded: assessed.alreadyRecorded,
    summary: worker.result.summary,
    evidence: progressEvidence,
  });
  if (["done", "advanced", "learning"].includes(classification)) {
    const control = await evaluateSuccessfulControl({
      store: input.store,
      graph: input.graph,
      node: input.node,
      rationale: `Progress was classified as ${classification}`,
      evidence: progressEvidence,
    });
    if (!control.allowed) {
      const reason = control.reason ?? `Control graph blocked acceptance of ${input.node.id}`;
      await input.store.append("runtime", "node.failed", { nodeId: input.node.id, reason });
      return {
        status: "failed",
        nodeId: input.node.id,
        reason,
        ...(control.packet ? { packet: control.packet } : {}),
      };
    }
    await input.store.append("runtime", "node.accepted", {
      nodeId: input.node.id,
      summary: worker.result.summary,
    });
    return { status: "accepted", nodeId: input.node.id };
  }

  await recordVerifierControl({
    store: input.store,
    graph: input.graph,
    targetId: input.node.id,
    verdict: "veto",
    rationale: semanticStopReason ?? `Progress classified as ${classification}`,
    evidence: progressEvidence,
  });
  const control = await evaluateControlAcceptance(
    input.store,
    input.graph,
    await input.store.loadState(),
    input.node.id,
    progressEvidence,
  );
  const reason =
    control.reason ?? semanticStopReason ?? `Stopped safely because progress was ${classification}`;
  if (control.allowed) {
    await input.store.append("runtime", "node.accepted", {
      nodeId: input.node.id,
      summary: worker.result.summary,
      controlOverride: true,
    });
    return { status: "accepted", nodeId: input.node.id };
  }
  await input.store.append("runtime", "node.failed", { nodeId: input.node.id, reason });
  const progressDecision = await progressPacket({
    store: input.store,
    trajectory,
    blocker: reason,
    evidence: progressEvidence,
  });
  return {
    status: "failed",
    nodeId: input.node.id,
    reason,
    ...(control.packet ? { packet: control.packet } : {}),
    progressDecision,
  };
}

export async function executeRun(input: {
  store: RunStore;
  adapter: HostAdapter;
  approve?: boolean;
  observer?: RunObserver;
  signal?: AbortSignal;
  maxWorkers?: 1 | 2;
  sideEffectBoundary?: (point: SideEffectBoundary) => void | Promise<void>;
}): Promise<RunState> {
  const externalSignal = input.signal ?? new AbortController().signal;
  const contract = await input.store.loadContract();
  let graph = await input.store.loadGraph();
  const lock = new RunLock(join(input.store.graphcraftRoot, "locks", `${contract.runId}.lock`));
  await lock.acquire();
  const controlChannel = new RunControlChannel(input.store.graphcraftRoot, contract.runId);
  const controlAbort = new AbortController();
  let controlRequest: RunControlRequest | undefined;
  const stopWatching = controlChannel.watch((request) => {
    if (!controlRequest || request.action === "stop") controlRequest = request;
    if (!controlAbort.signal.aborted)
      controlAbort.abort({ cause: request.cause, reason: request.reason });
  });
  const signal = AbortSignal.any([externalSignal, controlAbort.signal]);
  try {
    let state = await input.store.loadState();
    if (state.status === "awaiting_approval") {
      if (!input.approve) return state;
      await input.store.append("user", "run.approved", { approved: true });
      state = await input.store.loadState();
    }
    if (["completed", "stopped"].includes(state.status)) return state;
    await recordRunApprovalDecisions(input.store, graph);
    state = await input.store.loadState();
    const interruptedNodeIds = Object.entries(state.nodes)
      .filter(([, nodeState]) => nodeState.status === "running")
      .map(([nodeId]) => nodeId);
    if (state.status === "blocked") {
      for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
        if (nodeState.status === "failed") {
          await input.store.append("runtime", "node.reset", {
            nodeId,
            reason: "Resume requested after a blocker or environment change",
          });
        }
      }
      state = await input.store.loadState();
    }

    const capabilities = await input.adapter.probe();
    if (
      !capabilities.installed ||
      !capabilities.authenticated ||
      !capabilities.structuredOutput ||
      !capabilities.streamingEvents
    ) {
      await input.store.append("runtime", "run.blocked", {
        reason: `${input.adapter.id} is not authenticated or does not provide the required structured unattended interface`,
      });
      return await input.store.loadState();
    }

    let workspace: RunWorkspace;
    try {
      workspace = await input.store.loadWorkspace<RunWorkspace>();
    } catch {
      workspace = await createRunWorkspace(contract);
      await input.store.writeWorkspace(workspace);
    }
    const finishInterruption = async (
      nodeIds?: string | string[],
      termination?: HostTermination,
      artifact?: string,
    ): Promise<RunState> => {
      const activeNodeIds = nodeIds ? (Array.isArray(nodeIds) ? nodeIds : [nodeIds]) : [];
      const request = controlRequest;
      const reason = request
        ? { cause: request.cause, reason: request.reason }
        : interruptionReason(externalSignal.reason, "runtime_shutdown");
      const action = request?.action ?? "pause";
      const currentState = await input.store.loadState();
      if (action === "stop")
        for (const nodeId of activeNodeIds)
          if (currentState.nodes[nodeId]?.status === "running")
            await input.store.append("runtime", "node.reset", {
              nodeId,
              reason: "Stopped after active child reconciliation",
            });
      await input.store.append("runtime", "control.applied", {
        request: request ?? null,
        action,
        cause: reason.cause,
        reason: reason.reason,
        outcome: termination?.outcome ?? "checkpointed",
        termination: termination ?? null,
        artifact: artifact ?? null,
        nodeIds: activeNodeIds,
      });
      await input.store.append(
        request ? "user" : "runtime",
        action === "stop" ? "run.stopped" : "run.paused",
        {
          reason: reason.reason,
          cause: reason.cause,
          ...(request ? { requestId: request.requestId } : {}),
        },
      );
      if (request) await controlChannel.clear(request.requestId);
      return await input.store.loadState();
    };
    const recoveries = new Map<string, RecoverableInvocation>();
    for (const interruptedNodeId of interruptedNodeIds) {
      const recovery = await recoverableInvocation(
        input.store,
        interruptedNodeId,
        workspace.path,
        graph.family,
      );
      if (
        recovery &&
        (recovery.adapterId !== input.adapter.id || recovery.record.baseline === undefined)
      ) {
        await input.store.append(
          "runtime",
          "invocation.finished",
          {
            invocationId: recovery.record.invocationId,
            nodeId: recovery.nodeId,
            success: false,
            reason:
              recovery.adapterId !== input.adapter.id
                ? "Selected host changed; using repository recovery"
                : "The interrupted invocation predates durable progress baselines",
          },
          recovery.record.invocationId,
        );
      } else if (recovery) recoveries.set(interruptedNodeId, recovery);
      await input.store.append("runtime", "node.reset", {
        nodeId: interruptedNodeId,
        reason: recoveries.has(interruptedNodeId)
          ? "Recovered an interrupted invocation for native host reconciliation"
          : "Recovered from repository evidence; accepted nodes remain immutable",
      });
    }
    if (signal.aborted) return await finishInterruption(interruptedNodeIds);
    if (state.status !== "running")
      await input.store.append("runtime", "run.started", { workspace });

    while (!signal.aborted) {
      state = await input.store.loadState();
      graph = await input.store.loadGraph();
      if (["paused", "stopped", "blocked", "failed", "completed"].includes(state.status))
        return state;
      const batchSelection = readyBatch(graph, state, input.maxWorkers ?? 1);
      const batch = batchSelection.nodes;
      if (batch.length === 0) {
        const allAccepted = graph.nodes.every(
          (node) => state.nodes[node.id]?.status === "accepted",
        );
        if (allAccepted) await input.store.append("runtime", "run.completed", { workspace });
        else {
          await input.store.append("runtime", "run.blocked", {
            reason: "No node is ready and the graph is not complete",
          });
        }
        return await input.store.loadState();
      }
      if (batchSelection.decision)
        await input.store.append(
          "runtime",
          "optimizer.decided",
          { decision: batchSelection.decision },
          batchSelection.decision.decisionId,
        );

      for (const candidate of batch) {
        const scheduling = await evaluateControlScheduling(input.store, graph, state, candidate.id);
        if (!scheduling.allowed) {
          await input.store.append("runtime", "run.blocked", {
            reason: scheduling.reason ?? `Control authority blocked ${candidate.id}`,
            ...(scheduling.packet ? { decisionPacket: scheduling.packet } : {}),
          });
          return await input.store.loadState();
        }
      }

      const reuseSessions = new Map<string, { hostSessionId: string; sourceNodeId: string }>();
      for (const candidate of batch) {
        if (["verification", "commit"].includes(candidate.kind) || recoveries.has(candidate.id))
          continue;
        const contextOptimization = await hostContextOptimization(
          input.store,
          graph,
          candidate,
          input.adapter.id,
        );
        await input.store.append(
          "runtime",
          "optimizer.decided",
          { decision: contextOptimization.decision },
          contextOptimization.decision.decisionId,
        );
        if (contextOptimization.reuseSession)
          reuseSessions.set(candidate.id, contextOptimization.reuseSession);
      }

      const batchId = randomUUID();
      for (const candidate of batch) {
        input.observer?.({
          type: "status",
          message: `${candidate.kind}: ${candidate.objective}`,
        });
        await input.store.append("runtime", "node.started", {
          nodeId: candidate.id,
          batchId,
          batchSize: batch.length,
          maxWorkers: input.maxWorkers ?? 1,
        });
      }
      if (signal.aborted) return await finishInterruption(batch.map(({ id }) => id));

      if (batch.length > 1) {
        const batchAbort = new AbortController();
        const batchSignal = AbortSignal.any([signal, batchAbort.signal]);
        const outcomes = await Promise.all(
          batch.map(async (candidate) => {
            const outcome = await executeWorkNode({
              store: input.store,
              adapter: input.adapter,
              contract,
              graph,
              node: candidate,
              state,
              workspace,
              ...(input.observer ? { observer: input.observer } : {}),
              signal: batchSignal,
              ...(recoveries.get(candidate.id)
                ? { recovery: recoveries.get(candidate.id)!.record }
                : {}),
              ...(reuseSessions.get(candidate.id)
                ? { reuseSession: reuseSessions.get(candidate.id)! }
                : {}),
            });
            if (outcome.status === "failed" && !batchAbort.signal.aborted)
              batchAbort.abort({
                cause: "cancellation",
                reason: `Sibling ${candidate.id} failed; quarantine the remaining batch`,
              });
            recoveries.delete(candidate.id);
            return outcome;
          }),
        );
        const interrupted = outcomes.find(
          (outcome): outcome is Extract<WorkNodeOutcome, { status: "interrupted" }> =>
            outcome.status === "interrupted",
        );
        if (signal.aborted)
          return await finishInterruption(
            batch.map(({ id }) => id),
            interrupted?.termination,
            interrupted?.artifact,
          );
        const failed = outcomes.find(({ status }) => status === "failed");
        if (failed?.status === "failed") {
          const quarantinedSiblingIds = outcomes
            .filter(
              (outcome): outcome is Extract<WorkNodeOutcome, { status: "interrupted" }> =>
                outcome.status === "interrupted",
            )
            .map(({ nodeId }) => nodeId);
          await input.store.append("runtime", "run.blocked", {
            reason: failed.reason,
            ...(failed.cause ? { cause: failed.cause } : {}),
            ...(failed.packet ? { decisionPacket: failed.packet } : {}),
            ...(failed.progressDecision ? { progressDecision: failed.progressDecision } : {}),
            batchId,
            acceptedSiblingIds: outcomes
              .filter(({ status }) => status === "accepted")
              .map(({ nodeId }) => nodeId),
            quarantinedSiblingIds,
          });
          return await input.store.loadState();
        }
        if (interrupted)
          return await finishInterruption(
            batch.map(({ id }) => id),
            interrupted.termination,
            interrupted.artifact,
          );
        continue;
      }

      const current = batch[0]!;

      if (current.kind === "verification") {
        let completionProbes: ExecutableProbe[];
        let heldOutProbePlan: HeldOutProbePlan;
        try {
          heldOutProbePlan = await input.store.loadHeldOutProbePlan();
          completionProbes = resolveHeldOutProbes(current.completionProbes, heldOutProbePlan);
        } catch (error) {
          const reason = `Held-out completion proof is invalid: ${(error as Error).message}`;
          await input.store.append("runtime", "node.failed", { nodeId: current.id, reason });
          await input.store.append("runtime", "run.blocked", { reason });
          return await input.store.loadState();
        }
        if (completionProbes.length === 0) {
          await input.store.append("probe", "node.failed", {
            nodeId: current.id,
            reason: "No deterministic verification commands were discovered",
          });
          await input.store.append("runtime", "run.blocked", {
            reason:
              "Graphcraft cannot prove local_verified because no deterministic verification commands were discovered",
          });
          return await input.store.loadState();
        }
        const integrityFailures = await heldOutIntegrityFailures(heldOutProbePlan, workspace.path);
        const executed = integrityFailures.length
          ? []
          : await captureProbes(input.store, completionProbes, workspace, input.observer, signal);
        if (signal.aborted) return await finishInterruption(current.id);
        const results = integrityFailures.length
          ? integrityFailures
          : executed.map(({ result }) => result);
        await input.store.append("probe", "held_out.checked", {
          nodeId: current.id,
          planDigest: heldOutProbePlan.digest,
          results: results.map(({ probeId, passed, signature, artifact }) => ({
            probeId,
            passed,
            signature,
            artifact: artifact ?? null,
          })),
        });
        const verificationAssessment = await assessRunProgress({
          store: input.store,
          attemptId: batchId,
          nodeId: current.id,
          family: graph.family,
          strategy: await strategyForNode(input.store, current),
          current: evidenceSnapshot(await workspaceDigest(workspace.path), results, graph.family),
          firstObservation: results.every(({ passed }) => passed) ? "done" : "learning",
        });
        if (results.every(({ passed }) => passed)) {
          let semanticEvidence: string[] = [];
          let completionControl: ControlEvaluation | undefined;
          if (needsSemanticVerification("completion", completionProbes)) {
            let semanticVerdict: SemanticVerdict;
            try {
              semanticVerdict = await runSemanticVerification({
                phase: "completion",
                adapter: input.adapter,
                store: input.store,
                contract,
                node: current,
                workspace,
                workerSummary: "Deterministic completion probes passed",
                workerEvidence: current.dependsOn.flatMap((nodeId) => {
                  const predecessor = state.nodes[nodeId];
                  return predecessor?.lastSummary ? [`${nodeId}: ${predecessor.lastSummary}`] : [];
                }),
                baselineProbeEvidence: [],
                currentProbeEvidence: results,
                signal,
              });
            } catch (error) {
              if (signal.aborted)
                return await finishInterruption(
                  current.id,
                  error instanceof HostTerminationError ? error.termination : undefined,
                );
              const reason = `Semantic completion verification failed: ${(error as Error).message}`;
              await input.store.append("host", "node.failed", { nodeId: current.id, reason });
              await input.store.append("runtime", "run.blocked", { reason });
              return await input.store.loadState();
            }
            semanticEvidence = semanticVerdict.evidence;
            if (semanticVerdict.verdict !== "supported") {
              await recordVerifierControl({
                store: input.store,
                graph,
                targetId: current.id,
                verdict: "veto",
                rationale: semanticVerdict.rationale,
                evidence: semanticVerdict.evidence,
              });
              const control = await evaluateControlAcceptance(
                input.store,
                graph,
                await input.store.loadState(),
                current.id,
                semanticVerdict.evidence,
              );
              if (!control.allowed) {
                const reason =
                  control.reason ??
                  `Semantic completion verdict was ${semanticVerdict.verdict}: ${semanticVerdict.rationale}`;
                await input.store.append("host", "node.failed", { nodeId: current.id, reason });
                await input.store.append("runtime", "run.blocked", {
                  reason,
                  ...(control.packet ? { decisionPacket: control.packet } : {}),
                });
                return await input.store.loadState();
              }
              completionControl = control;
            }
          }
          const completionEvidence = [
            ...results.map(({ summary }) => summary),
            ...semanticEvidence,
          ];
          const control =
            completionControl ??
            (await evaluateSuccessfulControl({
              store: input.store,
              graph,
              node: current,
              rationale: "Completion probes and any required semantic verification passed",
              evidence: completionEvidence,
            }));
          if (!control.allowed) {
            const reason = control.reason ?? `Control graph blocked acceptance of ${current.id}`;
            await input.store.append("runtime", "node.failed", { nodeId: current.id, reason });
            await input.store.append("runtime", "run.blocked", {
              reason,
              ...(control.packet ? { decisionPacket: control.packet } : {}),
            });
            return await input.store.loadState();
          }
          await appendProgressTrajectory({
            store: input.store,
            trajectory: { ...verificationAssessment.trajectory, classification: "done" },
            alreadyRecorded: verificationAssessment.alreadyRecorded,
            summary: "Completion probes passed",
            evidence: completionEvidence,
          });
          await input.store.append("probe", "node.accepted", { nodeId: current.id });
          continue;
        }

        const failures = actionableHeldOutFailures(results.filter(({ passed }) => !passed));
        const failureSignature = failures
          .map(({ signature }) => signature)
          .sort()
          .join("|");
        const existingRepairs = graph.nodes.filter((node) =>
          node.id.startsWith("repair-verify-"),
        ).length;
        const failureEvidence = failures.map(({ summary }) => summary);
        await appendProgressTrajectory({
          store: input.store,
          trajectory: verificationAssessment.trajectory,
          alreadyRecorded: verificationAssessment.alreadyRecorded,
          summary: "Completion probes failed",
          evidence: failureEvidence,
        });
        await input.store.append("probe", "node.failed", {
          nodeId: current.id,
          reason: failureEvidence.join("\n"),
        });
        const previousRepair = (await input.store.loadGraphHistory())
          .filter(
            ({ amendment }) =>
              amendment?.actor === "runtime" &&
              amendment.proposal.rationale ===
                "Deterministic completion probes disproved the current remaining strategy",
          )
          .at(-1);
        const previousFailureSignature = previousRepair?.amendment?.proposal.evidence
          .find((item) => item.startsWith("failure-signature:"))
          ?.slice("failure-signature:".length);
        const trajectoryStopped = ["oscillating", "regressed", "stalled", "blocked"].includes(
          verificationAssessment.trajectory.classification,
        );
        if (
          existingRepairs >= 3 ||
          previousFailureSignature === failureSignature ||
          trajectoryStopped
        ) {
          const repeated = previousFailureSignature === failureSignature;
          const rationale = repeated
            ? "Verification repeated the same failure signature after a changed repair strategy"
            : existingRepairs >= 3
              ? "Verification exhausted three distinct repair strategies"
              : `Verification trajectory was ${verificationAssessment.trajectory.classification}`;
          await recordVerifierControl({
            store: input.store,
            graph,
            targetId: current.id,
            verdict: "veto",
            rationale,
            evidence: failureEvidence,
          });
          const control = await evaluateControlAcceptance(
            input.store,
            graph,
            await input.store.loadState(),
            current.id,
            failureEvidence,
          );
          const reason = control.reason ?? rationale;
          const progressDecision = await progressPacket({
            store: input.store,
            trajectory: verificationAssessment.trajectory,
            blocker: reason,
            evidence: failureEvidence,
            ...(repeated
              ? {
                  invariant:
                    "Verification repeated the same failure signature after a changed strategy",
                }
              : {}),
          });
          await input.store.append("runtime", "run.blocked", {
            reason,
            failures,
            ...(control.packet ? { decisionPacket: control.packet } : {}),
            progressDecision,
          });
          return await input.store.loadState();
        }
        const applied = await applyRunGraphAmendmentLocked(
          input.store,
          repairAmendment(graph, current, failures),
          "runtime",
        );
        graph = applied.graph;
        await input.store.append("runtime", "node.reset", {
          nodeId: current.id,
          reason: "Repair scheduled",
        });
        continue;
      }

      if (current.kind === "commit") {
        const control = await evaluateSuccessfulControl({
          store: input.store,
          graph,
          node: current,
          rationale: "All dependencies were accepted before the commit side effect",
          evidence: state.latestProgressEvidence,
        });
        if (!control.allowed) {
          const reason = control.reason ?? `Control graph blocked commit node ${current.id}`;
          await input.store.append("runtime", "node.failed", { nodeId: current.id, reason });
          await input.store.append("runtime", "run.blocked", {
            reason,
            ...(control.packet ? { decisionPacket: control.packet } : {}),
          });
          return await input.store.loadState();
        }
        try {
          const proposedClaim = await createAtomicCommitClaim(
            workspace,
            contract.runId,
            current.id,
          );
          const result = await executeSideEffect({
            store: input.store,
            claim: proposedClaim,
            reconcile: async (claim) => await reconcileAtomicCommit(workspace, claim),
            act: async (claim) =>
              await performAtomicCommit(workspace, claim, contract.task, input.sideEffectBoundary),
            ...(input.sideEffectBoundary ? { boundary: input.sideEffectBoundary } : {}),
          });
          await input.store.append("runtime", "node.accepted", {
            nodeId: current.id,
            sha: result.sha,
            sideEffectActionId: proposedClaim.actionId,
          });
          await crossSideEffectBoundary(input.sideEffectBoundary, "after_node_acceptance");
        } catch (error) {
          if (error instanceof SideEffectBoundaryInterruption) throw error;
          await input.store.append("runtime", "node.failed", {
            nodeId: current.id,
            reason: (error as Error).message,
          });
          await input.store.append("runtime", "run.blocked", { reason: (error as Error).message });
          return await input.store.loadState();
        }
        continue;
      }

      const outcome = await executeWorkNode({
        store: input.store,
        adapter: input.adapter,
        contract,
        graph,
        node: current,
        state,
        workspace,
        ...(input.observer ? { observer: input.observer } : {}),
        signal,
        ...(recoveries.get(current.id) ? { recovery: recoveries.get(current.id)!.record } : {}),
        ...(reuseSessions.get(current.id) ? { reuseSession: reuseSessions.get(current.id)! } : {}),
      });
      recoveries.delete(current.id);
      if (outcome.status === "interrupted")
        return await finishInterruption(current.id, outcome.termination, outcome.artifact);
      if (outcome.status === "failed") {
        await input.store.append("runtime", "run.blocked", {
          reason: outcome.reason,
          ...(outcome.cause ? { cause: outcome.cause } : {}),
          ...(outcome.packet ? { decisionPacket: outcome.packet } : {}),
          ...(outcome.progressDecision ? { progressDecision: outcome.progressDecision } : {}),
        });
        return await input.store.loadState();
      }
    }

    const finalState = await input.store.loadState();
    return await finishInterruption(
      Object.entries(finalState.nodes)
        .filter(([, nodeState]) => nodeState.status === "running")
        .map(([nodeId]) => nodeId),
    );
  } finally {
    await stopWatching();
    await lock.release();
  }
}

export async function stopRun(store: RunStore, reason = "Stopped by user"): Promise<RunState> {
  return await requestRunControl(store, "stop", reason);
}
