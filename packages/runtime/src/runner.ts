import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  GraphSchema,
  HostTerminationError,
  SemanticVerifierContextSchema,
  WorkerResultSchema,
  applyProbePlan,
  classifyProgress,
  compileGraph,
  compilePlannedGraph,
  compileRunContract,
  contentHash,
  createContextCapsule,
  evidenceSnapshot,
  interruptionReason,
  type EvidenceSnapshot,
  type Graph,
  type GraphPlanner,
  type GraphNode,
  type HostAdapter,
  type HostEvent,
  type HostTermination,
  type InvocationRecord,
  type ProbeResult,
  type ProbePlan,
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
import { requestRunControl, RunControlChannel } from "./control.ts";
import {
  createAtomicCommit,
  discoverPlanningEvidence,
  createRunWorkspace,
  discoverRepository,
  type RunWorkspace,
} from "./repository.ts";
import { RunStore } from "./store.ts";

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

interface RecoverableInvocation {
  adapterId: string;
  nodeId: string;
  record: InvocationRecord;
}

function persistedBaseline(value: unknown): EvidenceSnapshot | undefined {
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
  return candidate as EvidenceSnapshot;
}

async function recoverableInvocation(
  store: RunStore,
  nodeId: string,
  repositoryPath: string,
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
      : undefined;
  const baseline = persistedBaseline(started.data.baseline);
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

async function recordMissingUsage(store: RunStore, invocation: InvocationRecord): Promise<void> {
  const transcriptUsage = (invocation.transcript ?? []).filter(
    (event): event is Extract<HostEvent, { type: "usage" }> => event.type === "usage",
  );
  const events = await store.loadEvents();
  const recordedCount = events.filter(
    ({ type, causationId }) =>
      type === "tokens.recorded" && causationId === invocation.invocationId,
  ).length;
  for (const event of transcriptUsage.slice(recordedCount))
    await store.append(
      "host",
      "tokens.recorded",
      { usage: event.usage, recovered: true },
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
  const completionProbes = probePlan.items
    .filter(({ phase }) => phase === "completion")
    .map(({ probe }) => probe);
  const approvedProbes = probePlan.items.map(({ probe }) => probe);
  const contract = compileRunContract(task, repository, {
    ...(options.finishLine ? { finishLine: options.finishLine } : {}),
  });
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
        probePlan,
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
  graph = applyProbePlan(graph, contract, probePlan);
  const store = await RunStore.create(repository.root, contract, graph, probePlan);
  if (planningUsage)
    await store.append("host", "tokens.recorded", { usage: planningUsage, phase: "planning" });
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
    const graph = applyProbePlan(
      { ...existingGraph, revision: existingGraph.revision + 1 },
      contract,
      probePlan,
    );
    await store.append("user", "graph.amended", {
      graph,
      probePlan,
      addedNodeIds: [],
      rationale: "User edited the deterministic probe plan before approval",
      previousProbePlanHash: contentHash(await store.loadProbePlan()),
      probePlanHash: contentHash(probePlan),
    });
    await Promise.all([store.saveGraph(graph), store.saveProbePlan(probePlan)]);
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
}): Promise<{
  result?: WorkerResult;
  error?: string;
  errorCause?: "host_crash" | "timeout";
  termination?: HostTermination;
  artifact: string;
}> {
  const capsule = createContextCapsule({
    contract: input.contract,
    node: input.node,
    ...(input.predecessorEvidence ? { predecessorEvidence: input.predecessorEvidence } : {}),
    ...(input.probeResults ? { probeResults: input.probeResults } : {}),
  });
  const capsuleHash = contentHash(capsule);
  await input.store.writeCapsule(capsuleHash, capsule);
  let invocationId = input.resume?.invocationId ?? randomUUID();
  let resumeSessionId: string | undefined;
  if (input.resume) {
    await recordMissingUsage(input.store, input.resume);
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
      return { result: WorkerResultSchema.parse(reconciliation.result), artifact };
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
  if (!resumeSessionId) {
    await input.store.append("runtime", "invocation.started", {
      invocationId,
      nodeId: input.node.id,
      adapter: input.adapter.id,
      capsuleHash,
      baseline: input.baseline,
    });
  }
  let result: WorkerResult | undefined;
  let error: string | undefined;
  let errorCause: "host_crash" | "timeout" | undefined;
  let termination: HostTermination | undefined;

  let artifact = join(input.store.runRoot, "artifacts", "invocations", `${invocationId}.jsonl`);
  try {
    for await (const event of input.adapter.execute(
      {
        invocationId,
        repositoryPath: input.workspace.path,
        capsule,
        allowedTools:
          input.node.sideEffectClass === "workspace_write" ? ["read", "write", "shell"] : ["read"],
        ...(resumeSessionId ? { resumeSessionId } : {}),
      },
      input.signal,
    )) {
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
        await input.store.append("host", "tokens.recorded", { usage: event.usage }, invocationId);
      }
      if (event.type === "result") result = WorkerResultSchema.parse(event.result);
      if (event.type === "terminated") termination = event.termination;
      if (event.type === "error") {
        error = event.message;
        if (event.cause === "host_crash" || event.cause === "timeout") errorCause = event.cause;
      }
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    errorCause = "host_crash";
    const event: HostEvent = { type: "error", message: error, cause: errorCause };
    artifact = await input.store.appendInvocationEvent(invocationId, event);
  }
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
    if (result.usage)
      await input.store.append(
        "host",
        "tokens.recorded",
        { usage: result.usage, phase: "semantic_verification", nodeId: input.node.id },
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

function nextReadyNode(graph: Graph, state: RunState): GraphNode | undefined {
  const accepted = acceptedNodeIds(state);
  return graph.nodes.find(
    (node) =>
      state.nodes[node.id]?.status === "pending" && node.dependsOn.every((id) => accepted.has(id)),
  );
}

function addRepairNode(graph: Graph, verification: GraphNode, failures: ProbeResult[]): Graph {
  const repairCount = graph.nodes.filter((node) => node.id.startsWith("repair-verify-")).length;
  const id = `repair-verify-${repairCount + 1}`;
  const originalDependencies = verification.dependsOn.filter(
    (dependency) => !dependency.startsWith("repair-verify-"),
  );
  const previousRepair = verification.dependsOn.find((dependency) =>
    dependency.startsWith("repair-verify-"),
  );
  const repair: GraphNode = {
    id,
    kind: "diagnostic",
    objective: [
      "Repair the verification failures without weakening their checks.",
      ...failures.map((failure) => `${failure.probeId}: ${failure.summary}`),
    ].join("\n"),
    dependsOn: previousRepair ? [...originalDependencies, previousRepair] : originalDependencies,
    scope: verification.scope,
    contextSelector: {
      includeRepositoryInstructions: true,
      predecessorResults: verification.dependsOn,
      relevantPaths: [],
    },
    outputSchema: verification.outputSchema,
    progressProbes: verification.completionProbes,
    completionProbes: [],
    sideEffectClass: "workspace_write",
    status: "pending",
  };
  return GraphSchema.parse({
    ...graph,
    nodes: [
      ...graph.nodes.filter((node) => node.id !== verification.id),
      repair,
      { ...verification, dependsOn: [...originalDependencies, id] },
    ],
    revision: graph.revision + 1,
  });
}

export async function executeRun(input: {
  store: RunStore;
  adapter: HostAdapter;
  approve?: boolean;
  observer?: RunObserver;
  signal?: AbortSignal;
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
    const interruptedNodeId =
      state.currentNodeId && state.nodes[state.currentNodeId]?.status === "running"
        ? state.currentNodeId
        : undefined;
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
      nodeId?: string,
      termination?: HostTermination,
      artifact?: string,
    ): Promise<RunState> => {
      const request = controlRequest;
      const reason = request
        ? { cause: request.cause, reason: request.reason }
        : interruptionReason(externalSignal.reason, "runtime_shutdown");
      const action = request?.action ?? "pause";
      const currentState = await input.store.loadState();
      if (action === "stop" && nodeId && currentState.nodes[nodeId]?.status === "running") {
        await input.store.append("runtime", "node.reset", {
          nodeId,
          reason: "Stopped after active child reconciliation",
        });
      }
      await input.store.append("runtime", "control.applied", {
        request: request ?? null,
        action,
        cause: reason.cause,
        reason: reason.reason,
        outcome: termination?.outcome ?? "checkpointed",
        termination: termination ?? null,
        artifact: artifact ?? null,
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
    let recovery = interruptedNodeId
      ? await recoverableInvocation(input.store, interruptedNodeId, workspace.path)
      : undefined;
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
      recovery = undefined;
    }
    if (interruptedNodeId) {
      await input.store.append("runtime", "node.reset", {
        nodeId: interruptedNodeId,
        reason: recovery
          ? "Recovered an interrupted invocation for native host reconciliation"
          : "Recovered from repository evidence; accepted nodes remain immutable",
      });
    }
    if (signal.aborted) return await finishInterruption(interruptedNodeId);
    if (state.status !== "running")
      await input.store.append("runtime", "run.started", { workspace });

    while (!signal.aborted) {
      state = await input.store.loadState();
      graph = await input.store.loadGraph();
      if (["paused", "stopped", "blocked", "failed", "completed"].includes(state.status))
        return state;
      const current = nextReadyNode(graph, state);
      if (!current) {
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

      input.observer?.({ type: "status", message: `${current.kind}: ${current.objective}` });
      await input.store.append("runtime", "node.started", { nodeId: current.id });
      if (signal.aborted) return await finishInterruption(current.id);

      if (current.kind === "verification") {
        if (current.completionProbes.length === 0) {
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
        const executed = await captureProbes(
          input.store,
          current.completionProbes,
          workspace,
          input.observer,
          signal,
        );
        if (signal.aborted) return await finishInterruption(current.id);
        const results = executed.map(({ result }) => result);
        if (results.every(({ passed }) => passed)) {
          let semanticEvidence: string[] = [];
          if (needsSemanticVerification("completion", current.completionProbes)) {
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
              const reason = `Semantic completion verdict was ${semanticVerdict.verdict}: ${semanticVerdict.rationale}`;
              await input.store.append("host", "node.failed", { nodeId: current.id, reason });
              await input.store.append("runtime", "run.blocked", { reason });
              return await input.store.loadState();
            }
          }
          await input.store.append("probe", "node.progress", {
            nodeId: current.id,
            classification: "done",
            evidence: [...results.map(({ summary }) => summary), ...semanticEvidence],
          });
          await input.store.append("probe", "node.accepted", { nodeId: current.id });
          continue;
        }

        const existingRepairs = graph.nodes.filter((node) =>
          node.id.startsWith("repair-verify-"),
        ).length;
        await input.store.append("probe", "node.failed", {
          nodeId: current.id,
          reason: results
            .filter(({ passed }) => !passed)
            .map(({ summary }) => summary)
            .join("\n"),
        });
        if (existingRepairs >= 1) {
          await input.store.append("runtime", "run.blocked", {
            reason: "Verification still fails after a changed repair strategy",
            failures: results.filter(({ passed }) => !passed),
          });
          return await input.store.loadState();
        }
        graph = addRepairNode(
          graph,
          current,
          results.filter(({ passed }) => !passed),
        );
        await input.store.saveGraph(graph);
        await input.store.append("runtime", "graph.amended", {
          graph,
          addedNodeIds: [graph.nodes.find((node) => node.id.startsWith("repair-verify-"))!.id],
          evidence: results.filter(({ passed }) => !passed),
          rationale: "Deterministic completion probes failed; schedule one evidence-driven repair",
        });
        await input.store.append("runtime", "node.reset", {
          nodeId: current.id,
          reason: "Repair scheduled",
        });
        continue;
      }

      if (current.kind === "commit") {
        try {
          const sha = await createAtomicCommit(workspace, contract.task);
          await input.store.append("runtime", "node.accepted", { nodeId: current.id, sha });
        } catch (error) {
          await input.store.append("runtime", "node.failed", {
            nodeId: current.id,
            reason: (error as Error).message,
          });
          await input.store.append("runtime", "run.blocked", { reason: (error as Error).message });
          return await input.store.loadState();
        }
        continue;
      }

      const activeRecovery = recovery?.nodeId === current.id ? recovery : undefined;
      let baseline: EvidenceSnapshot;
      let baselineProbeResults: ProbeResult[];
      if (activeRecovery?.record.baseline) {
        baseline = activeRecovery.record.baseline;
        baselineProbeResults = baseline.probeResults;
      } else {
        const baselineProbes = await runProbes(current.progressProbes, workspace.path, signal);
        if (signal.aborted) return await finishInterruption(current.id);
        baselineProbeResults = baselineProbes.map(({ result }) => result);
        baseline = evidenceSnapshot(await workspaceDigest(workspace.path), baselineProbeResults);
      }
      const worker = await executeWorker({
        adapter: input.adapter,
        store: input.store,
        contract,
        node: current,
        workspace,
        predecessorEvidence: current.contextSelector.predecessorResults.flatMap((nodeId) => {
          const predecessor = state.nodes[nodeId];
          return predecessor?.lastSummary ? [`${nodeId}: ${predecessor.lastSummary}`] : [];
        }),
        ...(baselineProbeResults.length ? { probeResults: baselineProbeResults } : {}),
        ...(input.observer ? { observer: input.observer } : {}),
        signal,
        baseline,
        ...(activeRecovery ? { resume: activeRecovery.record } : {}),
      });
      if (activeRecovery) recovery = undefined;
      if (signal.aborted)
        return await finishInterruption(current.id, worker.termination, worker.artifact);
      if (!worker.result || worker.error || worker.result.status !== "completed") {
        const detail = worker.error ?? worker.result?.summary ?? "Worker did not complete the node";
        const cause = worker.errorCause ?? "host_crash";
        const reason = `${cause === "timeout" ? "Host timeout" : "Host crash"}: ${detail}`;
        await input.store.append("worker", "node.failed", {
          nodeId: current.id,
          reason,
          cause,
        });
        await input.store.append("runtime", "run.blocked", { reason, cause });
        return await input.store.loadState();
      }

      const afterProbes = await captureProbes(
        input.store,
        current.progressProbes,
        workspace,
        input.observer,
        signal,
      );
      if (signal.aborted)
        return await finishInterruption(current.id, worker.termination, worker.artifact);
      const currentEvidence = evidenceSnapshot(
        await workspaceDigest(workspace.path),
        afterProbes.map(({ result }) => result),
      );
      const measuredClassification = classifyProgress(baseline, currentEvidence);
      let classification = measuredClassification;
      let semanticEvidence: string[] = [];
      let semanticStopReason: string | undefined;
      if (
        current.sideEffectClass === "none" &&
        worker.result.evidence.length > 0 &&
        needsSemanticVerification("progress", current.progressProbes, measuredClassification)
      ) {
        let semanticVerdict: SemanticVerdict;
        try {
          semanticVerdict = await runSemanticVerification({
            phase: "progress",
            adapter: input.adapter,
            store: input.store,
            contract,
            node: current,
            workspace,
            workerSummary: worker.result.summary,
            workerEvidence: worker.result.evidence,
            baselineProbeEvidence: baselineProbeResults,
            currentProbeEvidence: afterProbes.map(({ result }) => result),
            signal,
          });
        } catch (error) {
          if (signal.aborted)
            return await finishInterruption(
              current.id,
              error instanceof HostTerminationError ? error.termination : worker.termination,
              worker.artifact,
            );
          const reason = `Semantic progress verification failed: ${(error as Error).message}`;
          await input.store.append("host", "node.failed", { nodeId: current.id, reason });
          await input.store.append("runtime", "run.blocked", { reason });
          return await input.store.loadState();
        }
        semanticEvidence = semanticVerdict.evidence;
        if (semanticVerdict.verdict === "supported") classification = "learning";
        else {
          classification = semanticVerdict.verdict === "unsupported" ? "stalled" : "blocked";
          semanticStopReason = `Semantic progress verdict was ${semanticVerdict.verdict}: ${semanticVerdict.rationale}`;
        }
      }
      await input.store.append("probe", "node.progress", {
        nodeId: current.id,
        classification,
        summary: worker.result.summary,
        evidence: [
          ...worker.result.evidence,
          ...afterProbes.map(({ result }) => result.summary),
          ...semanticEvidence,
        ],
      });
      if (["done", "advanced", "learning"].includes(classification)) {
        await input.store.append("runtime", "node.accepted", {
          nodeId: current.id,
          summary: worker.result.summary,
        });
      } else {
        await input.store.append("runtime", "node.failed", {
          nodeId: current.id,
          reason: semanticStopReason ?? `Progress classified as ${classification}`,
        });
        await input.store.append("runtime", "run.blocked", {
          reason: semanticStopReason ?? `Stopped safely because progress was ${classification}`,
        });
        return await input.store.loadState();
      }
    }

    return await finishInterruption((await input.store.loadState()).currentNodeId);
  } finally {
    await stopWatching();
    await lock.release();
  }
}

export async function stopRun(store: RunStore, reason = "Stopped by user"): Promise<RunState> {
  return await requestRunControl(store, "stop", reason);
}
