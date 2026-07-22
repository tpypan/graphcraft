import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import packageMetadata from "../../../package.json" with { type: "json" };
import { CodexAdapter } from "@graphcraft/adapter-codex";
import { ClaudeAdapter } from "@graphcraft/adapter-claude";
import {
  graphPlanShape,
  probePlanFromGraph,
  type Graph,
  type GraphAmendment,
  type HostAdapter,
  type ProbePlan,
  type RunContract,
  type RunState,
} from "@graphcraft/core";
import {
  RunStore,
  amendRunGraph,
  configureRunProbes,
  createRun,
  decideRunControl,
  discoverRepository,
  executeRun,
  requestRunControl,
  resolveRunId,
  type RunObserver,
} from "@graphcraft/runtime";

export type HostName = "codex" | "claude";
export const GRAPHCRAFT_VERSION = packageMetadata.version;

export function createAdapter(host: HostName): HostAdapter {
  return host === "claude" ? new ClaudeAdapter() : new CodexAdapter();
}

async function runHostCommand(
  command: string,
  args: string[],
  allowFailure = false,
): Promise<void> {
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0 && !allowFailure)
    throw new Error(`${command} ${args.join(" ")} exited ${exitCode}`);
}

export async function resolveBundledMcpPath(moduleUrl = import.meta.url): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(moduleDirectory, "mcp.mjs"),
    resolve(moduleDirectory, "../../../dist/mcp.mjs"),
    resolve(process.cwd(), "dist/mcp.mjs"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next source or bundled layout.
    }
  }
  throw new Error("dist/mcp.mjs is missing; run pnpm build before installing Graphcraft");
}

export function resolveGraphcraftHome(configuredHome = process.env.GRAPHCRAFT_HOME): string {
  return configuredHome?.trim() ? resolve(configuredHome) : join(homedir(), ".graphcraft");
}

export async function stageBundledMcp(
  sourcePath: string,
  graphcraftHome = resolveGraphcraftHome(),
): Promise<string> {
  const runtimeDirectory = join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION);
  const runtimePath = join(runtimeDirectory, "mcp.mjs");
  await mkdir(runtimeDirectory, { recursive: true });
  if (resolve(sourcePath) !== resolve(runtimePath)) await copyFile(sourcePath, runtimePath);
  await chmod(runtimePath, 0o755);
  return runtimePath;
}

export async function installHost(host: HostName, mcpPath?: string): Promise<void> {
  const bundledMcpPath = mcpPath ?? (await resolveBundledMcpPath());
  const resolvedMcpPath = await stageBundledMcp(bundledMcpPath);
  if (host === "codex") {
    await runHostCommand("codex", ["mcp", "remove", "graphcraft"], true);
    await runHostCommand("codex", ["mcp", "add", "graphcraft", "--", "node", resolvedMcpPath]);
  } else {
    await runHostCommand("claude", ["mcp", "remove", "--scope", "user", "graphcraft"], true);
    await runHostCommand("claude", [
      "mcp",
      "add",
      "--scope",
      "user",
      "graphcraft",
      "--",
      "node",
      resolvedMcpPath,
    ]);
  }
}

export async function uninstallHost(host: HostName): Promise<void> {
  if (host === "codex") await runHostCommand("codex", ["mcp", "remove", "graphcraft"]);
  else await runHostCommand("claude", ["mcp", "remove", "--scope", "user", "graphcraft"]);
}

export function shouldBypassGraph(task: string): boolean {
  const words = task.trim().split(/\s+/).length;
  const durableSignal =
    /\b(migrat|refactor|across|all |entire|investigat|audit|pull request|\bpr\b|ci|long[- ]running|resume)\b/i.test(
      task,
    );
  return words <= 8 && !durableSignal;
}

function probeView(item: ProbePlan["items"][number]): Record<string, unknown> {
  const probe = item.probe;
  return {
    id: probe.id,
    purpose: item.purpose,
    source: item.source,
    kind: probe.kind,
    ...(probe.kind === "command"
      ? {
          command: [probe.command, ...probe.args].join(" "),
          cwd: probe.cwd ?? ".",
          timeoutMs: probe.timeoutMs,
          platforms: probe.platforms ?? ["all"],
        }
      : {}),
    ...(probe.kind === "file" ? { path: probe.path } : {}),
    ...(probe.kind === "git_diff" ? { baseSha: probe.baseSha } : {}),
    ...(probe.kind === "repository_inventory" ? { paths: probe.paths, terms: probe.terms } : {}),
  };
}

export function contractView(
  contract: RunContract,
  graph?: Graph,
  inputProbePlan?: ProbePlan,
): Record<string, unknown> {
  const hasGraphProbes = graph?.nodes.some(
    (node) => node.progressProbes.length > 0 || node.completionProbes.length > 0,
  );
  const probePlan =
    inputProbePlan ?? (graph && hasGraphProbes ? probePlanFromGraph(graph) : undefined);
  const completionProbes = probePlan?.items
    .filter(({ phase }) => phase === "completion")
    .map((item) => probeView(item));
  const progressProbes = probePlan?.items
    .filter(({ phase }) => phase === "progress")
    .map((item) => probeView(item));
  return {
    runId: contract.runId,
    outcome: contract.outcome,
    finishLine: contract.finishLine.kind,
    repository: contract.repository.root,
    scope: contract.scope,
    permissions: contract.permissions,
    acceptanceAnchors: contract.acceptanceAnchors.map(({ id, description, owner }) => ({
      id,
      description,
      owner,
    })),
    ...(graph ? { planShape: graphPlanShape(graph) } : {}),
    ...(progressProbes ? { progressProbes } : {}),
    ...(completionProbes ? { completionProbes } : {}),
    recovery: "Checkpoint after every event; accepted nodes are never repeated",
  };
}

export function stateView(state: RunState, contract: RunContract): Record<string, unknown> {
  return {
    runId: state.runId,
    task: contract.task,
    finishLine: contract.finishLine.kind,
    status: state.status,
    currentNode: state.currentNodeId,
    runningNodes: Object.entries(state.nodes)
      .filter(([, nodeState]) => nodeState.status === "running")
      .map(([nodeId]) => nodeId),
    nodes: state.nodes,
    latestProgressEvidence: state.latestProgressEvidence,
    progressTrajectory: state.progressTrajectory.slice(-10).map((entry) => ({
      nodeId: entry.nodeId,
      classification: entry.classification,
      strategy: entry.strategy,
      vector: entry.current.vector,
      recordedAt: entry.recordedAt,
    })),
    progressDecision: state.progressDecision,
    controlDecisions: state.controlDecisions,
    pendingDecision: state.pendingDecision,
    tokens: state.tokens,
    stopReason: state.stopReason,
    updatedAt: state.updatedAt,
  };
}

export function renderContract(contract: RunContract, graph: Graph, probePlan?: ProbePlan): string {
  const view = contractView(contract, graph, probePlan);
  return [
    `Run            ${contract.runId}`,
    `Outcome        ${view.outcome}`,
    `Finish line    ${view.finishLine}`,
    `Repository     ${view.repository}`,
    `Permissions    ${contract.permissions.join(", ")}`,
    `Progress       ${(view.progressProbes as Array<{ id: string }> | undefined)?.map(({ id }) => id).join(", ") ?? "none"}`,
    `Completion     ${(view.completionProbes as Array<{ id: string }> | undefined)?.map(({ id }) => id).join(", ") ?? "none"}`,
    `Recovery       ${view.recovery}`,
    `Plan           ${view.planShape}`,
  ].join("\n");
}

export async function askForApproval(
  contract: RunContract,
  graph: Graph,
  probePlan?: ProbePlan,
): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      `${renderContract(contract, graph, probePlan)}\n\nStart? [Y/n] `,
    );
    return !/^n(?:o)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export function consoleObserver(json = false): RunObserver {
  return (event) => {
    if (json) console.log(JSON.stringify(event));
    else console.log(`[${event.type}] ${event.message}`);
  };
}

export async function storeFor(cwd: string, runReference?: string): Promise<RunStore> {
  const repository = await discoverRepository(cwd);
  const runId = await resolveRunId(repository.root, runReference);
  return new RunStore(repository.root, runId);
}

export interface McpActionInput {
  action:
    | "run"
    | "status"
    | "inspect"
    | "resume"
    | "pause"
    | "stop"
    | "trace"
    | "probes"
    | "amend"
    | "decide"
    | "doctor";
  task?: string | undefined;
  run?: string | undefined;
  repository?: string | undefined;
  host?: HostName | undefined;
  approve?: boolean | undefined;
  finishLine?: "local_verified" | "committed" | undefined;
  force?: boolean | undefined;
  maxWorkers?: 1 | 2 | undefined;
  probePlan?: ProbePlan | undefined;
  amendment?: GraphAmendment | undefined;
  controlSource?: string | undefined;
  controlTarget?: string | undefined;
  controlVerdict?: "approve" | "veto" | undefined;
  rationale?: string | undefined;
  evidence?: string[] | undefined;
  replaces?: string | undefined;
}

export async function handleAction(input: McpActionInput): Promise<Record<string, unknown>> {
  const cwd = input.repository ?? process.cwd();
  if (input.action === "doctor") {
    const [codex, claude] = await Promise.all([
      new CodexAdapter().probe(),
      new ClaudeAdapter().probe(),
    ]);
    let repository: Record<string, unknown>;
    try {
      repository = { ...(await discoverRepository(cwd)) };
    } catch (error) {
      repository = { error: (error as Error).message };
    }
    return { node: process.version, codex, claude, repository };
  }

  if (input.action === "run") {
    if (!input.task) throw new Error("task is required for action=run");
    if (!input.force && shouldBypassGraph(input.task)) {
      return {
        bypassed: true,
        reason: "Graphcraft is not needed for this localized task; use force=true to override",
      };
    }
    if (/\b(push|open (?:a )?pr|pull request|pr green|merge|deploy)\b/i.test(input.task)) {
      throw new Error(
        "Graphcraft v0.1 supports local_verified and committed finish lines. It will not silently narrow a requested remote finish line.",
      );
    }
    const adapter = createAdapter(input.host ?? "codex");
    const created = await createRun(input.task, {
      cwd,
      planner: adapter,
      ...(input.finishLine ? { finishLine: input.finishLine } : {}),
    });
    if (!input.approve)
      return {
        approvalRequired: true,
        contract: contractView(created.contract, created.graph, created.probePlan),
      };
    const state = await executeRun({
      store: created.store,
      adapter,
      approve: true,
      maxWorkers: input.maxWorkers ?? 1,
    });
    return stateView(state, created.contract);
  }

  const store = await storeFor(cwd, input.run);
  const [contract, graph, state, probePlan, heldOutProbePlan] = await Promise.all([
    store.loadContract(),
    store.loadGraph(),
    store.loadState(),
    store.loadProbePlan(),
    store.loadHeldOutProbePlan(),
  ]);
  if (input.action === "status") return stateView(state, contract);
  if (input.action === "inspect")
    return {
      contract,
      graph,
      probePlan,
      heldOutProof: {
        digest: heldOutProbePlan.digest,
        probes: heldOutProbePlan.probes.map(({ probe, integrity }) => ({
          id: probe.id,
          integrityProtected: integrity.length > 0,
        })),
      },
      state,
      graphHistory: await store.loadGraphHistory(),
    };
  if (input.action === "trace") return { events: await store.loadEvents() };
  if (input.action === "probes") {
    if (!input.probePlan) return { probePlan };
    return await configureRunProbes(store, input.probePlan);
  }
  if (input.action === "amend") {
    if (!input.amendment) throw new Error("amendment is required for action=amend");
    const result = await amendRunGraph(
      store,
      input.amendment,
      input.approve === true ? "user" : "runtime",
    );
    return { ...result, graphHistory: await store.loadGraphHistory() };
  }
  if (input.action === "decide") {
    if (!input.controlSource || !input.controlTarget || !input.controlVerdict || !input.rationale)
      throw new Error(
        "controlSource, controlTarget, controlVerdict, and rationale are required for action=decide",
      );
    return stateView(
      await decideRunControl(store, {
        sourceId: input.controlSource,
        targetId: input.controlTarget,
        verdict: input.controlVerdict,
        rationale: input.rationale,
        ...(input.evidence ? { evidence: input.evidence } : {}),
        ...(input.replaces ? { replaces: input.replaces } : {}),
      }),
      contract,
    );
  }
  if (input.action === "stop") return stateView(await requestRunControl(store, "stop"), contract);
  if (input.action === "pause") return stateView(await requestRunControl(store, "pause"), contract);
  if (input.action === "resume") {
    if (state.status === "awaiting_approval" && !input.approve) {
      return { approvalRequired: true, contract: contractView(contract, graph, probePlan) };
    }
    const resumed = await executeRun({
      store,
      adapter: createAdapter(input.host ?? "codex"),
      approve: input.approve ?? false,
      maxWorkers: input.maxWorkers ?? 1,
    });
    return stateView(resumed, contract);
  }
  throw new Error(`Unsupported action: ${input.action}`);
}
