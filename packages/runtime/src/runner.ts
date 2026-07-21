import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  GraphSchema,
  WorkerResultSchema,
  classifyProgress,
  compileGraph,
  compileRunContract,
  contentHash,
  createContextCapsule,
  evidenceSnapshot,
  type Graph,
  type GraphNode,
  type HostAdapter,
  type HostEvent,
  type ProbeResult,
  type RunContract,
  type RunState,
  type WorkerResult,
} from "@graphcraft/core";
import {
  discoverVerificationProbes,
  runProbes,
  workspaceDigest,
  type ExecutedProbe,
} from "@graphcraft/probes";
import { RunLock } from "./lock.ts";
import {
  createAtomicCommit,
  createRunWorkspace,
  discoverRepository,
  type RunWorkspace,
} from "./repository.ts";
import { RunStore } from "./store.ts";

export interface CreateRunOptions {
  cwd: string;
  finishLine?: "local_verified" | "committed";
}

export interface RunObserverEvent {
  type: "status" | "host" | "probe";
  message: string;
}

export type RunObserver = (event: RunObserverEvent) => void;

export async function createRun(
  task: string,
  options: CreateRunOptions,
): Promise<{
  contract: RunContract;
  graph: Graph;
  store: RunStore;
}> {
  const repository = await discoverRepository(options.cwd);
  const probes = await discoverVerificationProbes(repository.root);
  const contract = compileRunContract(task, repository, {
    ...(options.finishLine ? { finishLine: options.finishLine } : {}),
  });
  const graph = compileGraph(contract, probes);
  const store = await RunStore.create(repository.root, contract, graph);
  return { contract, graph, store };
}

async function executeWorker(input: {
  adapter: HostAdapter;
  store: RunStore;
  contract: RunContract;
  node: GraphNode;
  workspace: RunWorkspace;
  probeResults?: ProbeResult[];
  observer?: RunObserver;
  signal: AbortSignal;
}): Promise<{ result?: WorkerResult; error?: string }> {
  const capsule = createContextCapsule({
    contract: input.contract,
    node: input.node,
    ...(input.probeResults ? { probeResults: input.probeResults } : {}),
  });
  const capsuleHash = contentHash(capsule);
  await input.store.writeCapsule(capsuleHash, capsule);
  const invocationId = randomUUID();
  await input.store.append("runtime", "invocation.started", {
    invocationId,
    nodeId: input.node.id,
    adapter: input.adapter.id,
    capsuleHash,
  });
  const transcript: HostEvent[] = [];
  let result: WorkerResult | undefined;
  let error: string | undefined;

  for await (const event of input.adapter.execute(
    {
      invocationId,
      repositoryPath: input.workspace.path,
      capsule,
      allowedTools: ["read", "write", "shell"],
    },
    input.signal,
  )) {
    transcript.push(event);
    if (event.type === "message") input.observer?.({ type: "host", message: event.text });
    if (event.type === "tool")
      input.observer?.({ type: "host", message: `${event.name} ${event.summary}`.trim() });
    if (event.type === "usage") {
      await input.store.append("host", "tokens.recorded", { usage: event.usage }, invocationId);
    }
    if (event.type === "result") result = WorkerResultSchema.parse(event.result);
    if (event.type === "error") error = event.message;
  }
  const artifact = await input.store.writeArtifact(
    `invocations/${invocationId}.jsonl`,
    `${transcript.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  await input.store.append(
    "runtime",
    "invocation.finished",
    { invocationId, nodeId: input.node.id, artifact, success: Boolean(result) && !error },
    invocationId,
  );
  return { ...(result ? { result } : {}), ...(error ? { error } : {}) };
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
  const signal = input.signal ?? new AbortController().signal;
  const contract = await input.store.loadContract();
  let graph = await input.store.loadGraph();
  const lock = new RunLock(join(input.store.graphcraftRoot, "locks", `${contract.runId}.lock`));
  await lock.acquire();
  try {
    let state = await input.store.loadState();
    if (state.status === "awaiting_approval") {
      if (!input.approve) return state;
      await input.store.append("user", "run.approved", { approved: true });
      state = await input.store.loadState();
    }
    if (["completed", "stopped"].includes(state.status)) return state;
    if (state.currentNodeId && state.nodes[state.currentNodeId]?.status === "running") {
      await input.store.append("runtime", "node.reset", {
        nodeId: state.currentNodeId,
        reason: "Recovered an interrupted invocation; accepted nodes remain immutable",
      });
    }
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
        const results = executed.map(({ result }) => result);
        if (results.every(({ passed }) => passed)) {
          await input.store.append("probe", "node.progress", {
            nodeId: current.id,
            classification: "done",
            evidence: results.map(({ summary }) => summary),
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

      const beforeDigest = await workspaceDigest(workspace.path);
      const baselineProbes = await runProbes(current.progressProbes, workspace.path, signal);
      const baseline = evidenceSnapshot(
        beforeDigest,
        baselineProbes.map(({ result }) => result),
      );
      const worker = await executeWorker({
        adapter: input.adapter,
        store: input.store,
        contract,
        node: current,
        workspace,
        ...(baselineProbes.length
          ? { probeResults: baselineProbes.map(({ result }) => result) }
          : {}),
        ...(input.observer ? { observer: input.observer } : {}),
        signal,
      });
      if (!worker.result || worker.error || worker.result.status !== "completed") {
        const reason = worker.error ?? worker.result?.summary ?? "Worker did not complete the node";
        await input.store.append("worker", "node.failed", { nodeId: current.id, reason });
        await input.store.append("runtime", "run.blocked", { reason });
        return await input.store.loadState();
      }

      const afterProbes = await captureProbes(
        input.store,
        current.progressProbes,
        workspace,
        input.observer,
        signal,
      );
      const currentEvidence = evidenceSnapshot(
        await workspaceDigest(workspace.path),
        afterProbes.map(({ result }) => result),
      );
      const classification = classifyProgress(baseline, currentEvidence);
      await input.store.append("probe", "node.progress", {
        nodeId: current.id,
        classification,
        summary: worker.result.summary,
        evidence: [...worker.result.evidence, ...afterProbes.map(({ result }) => result.summary)],
      });
      if (["done", "advanced", "learning"].includes(classification) || graph.family === "audit") {
        await input.store.append("runtime", "node.accepted", {
          nodeId: current.id,
          summary: worker.result.summary,
        });
      } else {
        await input.store.append("runtime", "node.failed", {
          nodeId: current.id,
          reason: `Progress classified as ${classification}`,
        });
        await input.store.append("runtime", "run.blocked", {
          reason: `Stopped safely because progress was ${classification}`,
        });
        return await input.store.loadState();
      }
    }

    await input.store.append("runtime", "run.paused", { reason: "Execution signal aborted" });
    return await input.store.loadState();
  } finally {
    await lock.release();
  }
}

export async function stopRun(store: RunStore, reason = "Stopped by user"): Promise<RunState> {
  const state = await store.loadState();
  if (!["completed", "stopped"].includes(state.status)) {
    await store.append("user", "run.stopped", { reason });
  }
  return await store.loadState();
}
