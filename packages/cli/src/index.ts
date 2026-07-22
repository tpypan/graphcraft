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
import { assertGitHubPushCapability, probeGitHub } from "@graphcraft/github";
import {
  ContextSelectionReceiptSchema,
  graphPlanShape,
  inferFinishLine,
  probePlanFromGraph,
  tokenCostReport,
  type Graph,
  type GraphAmendment,
  type HostAdapter,
  type HostExecutionPolicy,
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
  latestSupervisor,
  listRunIds,
  requestRunControl,
  redactString,
  redactValue,
  resolveRunId,
  type RunObserver,
  type RunObserverEvent,
} from "@graphcraft/runtime";

export type HostName = "codex" | "claude";
export const GRAPHCRAFT_VERSION = packageMetadata.version;

export function createAdapter(host: HostName, policy?: HostExecutionPolicy): HostAdapter {
  return host === "claude" ? new ClaudeAdapter(policy) : new CodexAdapter(policy);
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

export interface TaskShapeAssessment {
  bypass: boolean;
  score: number;
  signals: {
    actionCount: number;
    pathCount: number;
    localized: boolean;
    broadScope: boolean;
    durableWorkflow: boolean;
    externalWait: boolean;
    multipleSteps: boolean;
  };
}

export function assessTaskShape(task: string): TaskShapeAssessment {
  const value = task.trim();
  const actionPatterns = [
    /\bfix(?:e[sd]?|ing)?\b/i,
    /\bimplement(?:ed|ing)?\b/i,
    /\badd(?:ed|ing)?\b/i,
    /\b(?:updat|chang|remov|renam|migrat|refactor|audit|investigat|verif|test|commit|push)\w*\b/i,
  ];
  const actionCount = actionPatterns.filter((pattern) => pattern.test(value)).length;
  const paths =
    value.match(
      /(?:^|\s)(?:[\w.-]+\/)+(?:[\w.*-]+)|\b(?:README(?:\.md)?|AGENTS\.md|package\.json|tsconfig(?:\.[\w.-]+)?\.json)\b|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json|ya?ml|toml)\b/g,
    ) ?? [];
  const pathCount = new Set(paths.map((path) => path.trim())).size;
  const broadScope =
    /\b(?:all|every|entire|across|repository-wide|codebase|multiple packages?|each)\b/i.test(value);
  const durableWorkflow =
    /\b(?:migrat\w*|refactor\w*|audit\w*|investigat\w*|pull request|pr green|ci|resume|long[- ]running)\b/i.test(
      value,
    );
  const externalWait =
    /\b(?:wait|poll|review feedback|required checks?|github|pull request|\bpr\b|deploy)\b/i.test(
      value,
    );
  const multipleSteps =
    actionCount > 1 || /\b(?:and then|then|followed by|after that)\b|[;,]/i.test(value);
  const localized =
    pathCount === 1 ||
    /\b(?:typo|wording|copy|comment|single file|one file|localized|localised)\b/i.test(value);
  const score =
    actionCount +
    Math.min(pathCount, 3) +
    (broadScope ? 3 : 0) +
    (durableWorkflow ? 4 : 0) +
    (externalWait ? 4 : 0) +
    (multipleSteps ? 2 : 0);
  return {
    bypass:
      localized &&
      actionCount <= 1 &&
      pathCount <= 1 &&
      !broadScope &&
      !durableWorkflow &&
      !externalWait &&
      !multipleSteps,
    score,
    signals: {
      actionCount,
      pathCount,
      localized,
      broadScope,
      durableWorkflow,
      externalWait,
      multipleSteps,
    },
  };
}

export function shouldBypassGraph(task: string): boolean {
  return assessTaskShape(task).bypass;
}

export type ExecutableFinishLine =
  "local_verified" | "committed" | "pushed" | "pr_open" | "pr_green";

export async function prepareFinishLine(
  task: string,
  cwd: string,
  requested?: ExecutableFinishLine,
): Promise<ExecutableFinishLine> {
  if (
    /\b(merge|deploy|force[- ]?push)\b|\brebase\b.{0,40}\b(?:published|remote)\s+branch\b/i.test(
      task,
    )
  )
    throw new Error(
      "Graphcraft supports local_verified, committed, pushed, pr_open, and pr_green finish lines. It will not infer force-push, published-branch rebase, merge, or deployment authority.",
    );
  const inferred = inferFinishLine(task);
  if (["pushed", "pr_open", "pr_green"].includes(inferred) && requested && requested !== inferred)
    throw new Error(
      `The requested task includes a ${inferred} outcome, so Graphcraft will not silently narrow it to ${requested}.`,
    );
  const finishLine = requested ?? inferred;
  if (["pushed", "pr_open", "pr_green"].includes(finishLine))
    await assertGitHubPushCapability({ cwd });
  return finishLine;
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
    ...(probe.kind === "github_snapshot"
      ? {
          pullRequest: probe.pullRequest,
          expectedState: probe.expectedState,
          requiredChecks: probe.requiredChecks,
          reviewThreads: probe.reviewThreads,
        }
      : {}),
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
    tokenReport: tokenCostReport(state.tokenLedger),
    optimizationDecisions: state.optimizationDecisions,
    sideEffects: state.sideEffects,
    waits: state.waits,
    stopReason: state.stopReason,
    updatedAt: state.updatedAt,
  };
}

function line(label: string, value: string): string {
  return `${label.padEnd(14)}${value}`;
}

export function recoveryHint(message: string): string | undefined {
  if (/matched (?:0|[2-9]\d*) runs|No Graphcraft runs/i.test(message))
    return "Run `graphcraft runs` to list stable run IDs, or start one with `graphcraft run`.";
  if (/auth|login|credential|permission|GitHub .*preflight/i.test(message))
    return "Run `graphcraft doctor`, then authenticate the reported host or GitHub CLI.";
  if (/future|unsupported.*(?:schema|storage|format)|storage version/i.test(message))
    return "Update Graphcraft before reopening this run; its durable files were left unchanged.";
  if (/probe|completion check|held.out/i.test(message))
    return "Inspect the approved checks with `graphcraft probes [run]` before changing them.";
  if (/worktree|run lock|locked|supervisor/i.test(message))
    return "Inspect ownership with `graphcraft status [run]` and `graphcraft supervisors [run]`.";
  if (/stale|moved|diverg|conflict/i.test(message))
    return "Inspect exact local and remote evidence with `graphcraft inspect [run]`; Graphcraft will not overwrite it.";
  return undefined;
}

export function renderRunStatus(state: RunState, contract: RunContract, graph: Graph): string {
  const accepted = Object.entries(state.nodes)
    .filter(([, value]) => value.status === "accepted")
    .map(([id]) => id);
  const running = Object.entries(state.nodes)
    .filter(([, value]) => value.status === "running")
    .map(([id]) => id);
  const ready = graph.nodes
    .filter(
      (node) =>
        state.nodes[node.id]?.status === "pending" &&
        node.dependsOn.every((id) => state.nodes[id]?.status === "accepted"),
    )
    .map(({ id }) => id);
  const tokenReport = tokenCostReport(state.tokenLedger);
  const nextAction = state.pendingDecision
    ? `Resolve the pending decision with graphcraft decide ${state.runId.slice(0, 8)} ...`
    : state.status === "awaiting_approval"
      ? `graphcraft resume ${state.runId.slice(0, 8)} --yes`
      : state.status === "paused" || state.status === "waiting"
        ? `graphcraft resume ${state.runId.slice(0, 8)} --background`
        : state.status === "completed"
          ? `graphcraft view ${state.runId.slice(0, 8)}`
          : state.stopReason
            ? (recoveryHint(state.stopReason) ??
              `graphcraft inspect ${state.runId.slice(0, 8)} to review the blocker`)
            : `graphcraft inspect ${state.runId.slice(0, 8)}`;
  const evidence = state.latestProgressEvidence.slice(-3);
  return [
    line("Run", state.runId),
    line("Outcome", contract.outcome),
    line("Finish line", contract.finishLine.kind),
    line("Status", state.status),
    line("Accepted", accepted.join(", ") || "none"),
    line("Ready", ready.join(", ") || "none"),
    line("Running", running.join(", ") || "none"),
    line("Evidence", evidence[0] ?? "none"),
    ...evidence.slice(1).map((item) => line("", item)),
    ...(state.stopReason ? [line("Blocker", state.stopReason)] : []),
    line(
      "Tokens",
      `cached ${tokenReport.totals.cachedInput}, uncached ${tokenReport.totals.uncachedInput}, output ${tokenReport.totals.output}, reasoning ${tokenReport.totals.reasoning}, total ${tokenReport.totals.total}`,
    ),
    line("Next", nextAction),
  ].join("\n");
}

export function renderRunInspection(input: {
  state: RunState;
  contract: RunContract;
  graph: Graph;
  graphHistory: Awaited<ReturnType<RunStore["loadGraphHistory"]>>;
}): string {
  return [
    renderRunStatus(input.state, input.contract, input.graph),
    "",
    "Plan",
    ...input.graph.nodes.map((node) => {
      const status = input.state.nodes[node.id]?.status ?? node.status;
      return `  [${status}] ${node.id} · ${node.kind} · depends on ${node.dependsOn.join(", ") || "nothing"} · ${node.sideEffectClass}`;
    }),
    "",
    `Governance    ${input.graph.controlEdges.length} control edges; ${input.contract.acceptanceAnchors.length} anchors`,
    `Revisions     ${input.graph.revision}; ${input.graphHistory.length} amendments`,
    `Durable files ${join(input.contract.repository.root, ".graphcraft", "runs", input.state.runId)}`,
  ].join("\n");
}

export interface RunListEntry {
  runId: string;
  task: string;
  finishLine: string;
  status: RunState["status"];
  updatedAt: string;
}

export async function loadRunList(cwd: string): Promise<RunListEntry[]> {
  const repository = await discoverRepository(cwd);
  const runIds = await listRunIds(repository.root);
  const entries = await Promise.all(
    runIds.map(async (runId) => {
      const store = new RunStore(repository.root, runId);
      const [contract, state] = await Promise.all([store.loadContract(), store.loadState()]);
      return {
        runId,
        task: contract.task,
        finishLine: contract.finishLine.kind,
        status: state.status,
        updatedAt: state.updatedAt,
      } satisfies RunListEntry;
    }),
  );
  return entries.sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId),
  );
}

export function renderRunList(entries: RunListEntry[]): string {
  if (entries.length === 0) return "No Graphcraft runs exist in this repository.";
  return [
    "RUN       STATUS              FINISH LINE     UPDATED                   TASK",
    ...entries.map(
      (entry) =>
        `${entry.runId.slice(0, 8).padEnd(10)}${entry.status.padEnd(20)}${entry.finishLine.padEnd(16)}${entry.updatedAt.padEnd(26)}${entry.task}`,
    ),
    "",
    "Use the displayed run prefix with status, inspect, trace, view, resume, pause, or stop.",
  ].join("\n");
}

export async function supervisorView(repositoryRoot: string, runId: string) {
  try {
    return (await latestSupervisor(repositoryRoot, runId)) ?? null;
  } catch (error) {
    return {
      health: "invalid",
      error: `Supervisor projection is unreadable: ${(error as Error).message}`,
    };
  }
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
    const persisted = redactValue(event) as RunObserverEvent;
    if (json) console.log(JSON.stringify(persisted));
    else console.log(`[${persisted.type}] ${redactString(persisted.message)}`);
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
  finishLine?: ExecutableFinishLine | undefined;
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

async function performAction(input: McpActionInput): Promise<Record<string, unknown>> {
  const cwd = input.repository ?? process.cwd();
  if (input.action === "doctor") {
    const [codex, claude, github] = await Promise.all([
      new CodexAdapter().probe(),
      new ClaudeAdapter().probe(),
      probeGitHub({ cwd }),
    ]);
    let repository: Record<string, unknown>;
    try {
      repository = { ...(await discoverRepository(cwd)) };
    } catch (error) {
      repository = { error: (error as Error).message };
    }
    return { node: process.version, codex, claude, github, repository };
  }

  if (input.action === "run") {
    if (!input.task) throw new Error("task is required for action=run");
    const taskShape = assessTaskShape(input.task);
    if (!input.force && taskShape.bypass) {
      return {
        bypassed: true,
        reason: "Graphcraft is not needed for this localized task; use force=true to override",
        taskShape,
      };
    }
    const finishLine = await prepareFinishLine(input.task, cwd, input.finishLine);
    const adapter = createAdapter(input.host ?? "codex");
    const created = await createRun(input.task, {
      cwd,
      planner: adapter,
      finishLine,
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
  if (input.action === "status")
    return {
      ...stateView(state, contract),
      supervisor: await supervisorView(store.repositoryRoot, store.runId),
    };
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
      supervisor: await supervisorView(store.repositoryRoot, store.runId),
      tokenReport: tokenCostReport(state.tokenLedger),
      graphHistory: await store.loadGraphHistory(),
      contextReceipts: (await store.loadEvents())
        .filter(({ type }) => type === "context.selected")
        .map(({ data }) => ContextSelectionReceiptSchema.parse(data.receipt)),
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
    if (
      state.status === "awaiting_approval" &&
      ["pushed", "pr_open", "pr_green"].includes(contract.finishLine.kind)
    )
      await assertGitHubPushCapability({ cwd: store.repositoryRoot });
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

export async function handleAction(input: McpActionInput): Promise<Record<string, unknown>> {
  try {
    return redactValue(await performAction(input)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(redactString(error instanceof Error ? error.message : String(error)));
  }
}
