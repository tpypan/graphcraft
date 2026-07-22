import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
  Graph,
  GraphNode,
  GraphPlan,
  GraphAmendment,
  GraphAmendmentDiff,
  Permission,
  AcceptanceAnchor,
  ProbePlan,
  ProbeSpec,
  RunContract,
} from "./schemas.ts";
import {
  GraphAmendmentSchema,
  GraphPlanSchema,
  GraphSchema,
  ProbePlanSchema,
  RunContractSchema,
} from "./schemas.ts";

export type TaskFamily = Graph["family"];

export interface RepositoryIdentity {
  root: string;
  remote?: string;
  baseRef: string;
  baseSha: string;
}

export interface ContractOptions {
  finishLine?: "local_verified" | "committed";
  include?: string[];
  exclude?: string[];
}

export function classifyTask(task: string): TaskFamily {
  const value = task.toLowerCase();
  if (/migrat|upgrade|replace all|deprecat/.test(value)) return "migration";
  if (/\b(?:bug|fix(?:e[sd]?|ing)?|regression|broken|errors?|fail(?:ed|ing|ure|s)?)\b/.test(value))
    return "bug";
  if (/refactor|restructur|cleanup|simplif/.test(value)) return "refactor";
  if (/audit|review|investigat|assess/.test(value)) return "audit";
  return "feature";
}

export function inferFinishLine(task: string): "local_verified" | "committed" {
  return /\bcommit(?:ted)?\b/i.test(task) ? "committed" : "local_verified";
}

export function compileRunContract(
  task: string,
  repository: RepositoryIdentity,
  options: ContractOptions = {},
): RunContract {
  const finishKind = options.finishLine ?? inferFinishLine(task);
  const permissions: Permission[] = [
    "read_repository",
    "write_repository",
    "run_commands",
    "create_worktree",
  ];
  if (finishKind === "committed") permissions.push("commit");

  return RunContractSchema.parse({
    schemaVersion: 1,
    runId: randomUUID(),
    task: task.trim(),
    outcome: task.trim(),
    finishLine: { kind: finishKind },
    repository,
    scope: {
      include: options.include ?? ["**/*"],
      exclude: options.exclude ?? [".graphcraft/**", ".git/**"],
    },
    permissions,
    acceptanceAnchors: [
      {
        id: "user-outcome",
        description: task.trim(),
        owner: "user",
        evidenceSource: "approved run contract",
        mutationPolicy: "user_approval",
      },
      {
        id: "repository-policy",
        description: "Obey repository instructions and preserve unrelated work",
        owner: "repository",
        evidenceSource: "AGENTS.md and repository state",
        mutationPolicy: "immutable",
      },
      {
        id: "runtime-verifier",
        description: "Deterministic and isolated semantic verification may veto unsupported work",
        owner: "held_out_eval",
        evidenceSource: "Graphcraft probe and semantic-verdict events",
        mutationPolicy: "immutable",
      },
      {
        id: "user-arbitrator",
        description: "The user resolves contradictory control decisions without delegating edits",
        owner: "user",
        evidenceSource: "Explicit durable user decision",
        mutationPolicy: "user_approval",
      },
    ],
  });
}

function runtimeControlEdges(
  anchors: AcceptanceAnchor[],
  nodes: GraphNode[],
): Graph["controlEdges"] {
  const terminal = nodes.find(
    (candidate) => !nodes.some((other) => other.dependsOn.includes(candidate.id)),
  );
  if (!terminal) throw new Error("The graph has no terminal control target");
  const known = new Set(anchors.map(({ id }) => id));
  const edges: Graph["controlEdges"] = [];
  const add = (from: string, to: string, relation: Graph["controlEdges"][number]["relation"]) => {
    if (known.has(from)) edges.push({ from, to, relation });
  };
  for (const node of nodes) {
    add("repository-policy", node.id, "vetoes");
    add("runtime-verifier", node.id, "observes");
    add("runtime-verifier", node.id, "vetoes");
    add("user-arbitrator", node.id, "arbitrates");
    for (const anchor of anchors) {
      if (
        !["user-outcome", "repository-policy", "runtime-verifier", "user-arbitrator"].includes(
          anchor.id,
        )
      ) {
        edges.push({ from: anchor.id, to: node.id, relation: "vetoes" });
      }
    }
  }
  add("user-outcome", terminal.id, "owns_target");
  return edges;
}

const resultShape = {
  type: "object",
  required: ["status", "summary", "changedPaths", "evidence"],
  properties: {
    status: { enum: ["completed", "blocked", "failed"] },
    summary: { type: "string" },
    changedPaths: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
    nextSuggestedObjective: { type: "string" },
  },
};

function node(input: Partial<GraphNode> & Pick<GraphNode, "id" | "kind" | "objective">): GraphNode {
  return {
    id: input.id,
    kind: input.kind,
    objective: input.objective,
    dependsOn: input.dependsOn ?? [],
    scope: input.scope ?? ["**/*"],
    contextSelector: input.contextSelector ?? {
      includeRepositoryInstructions: true,
      predecessorResults: input.dependsOn ?? [],
      relevantPaths: [],
    },
    outputSchema: input.outputSchema ?? resultShape,
    progressProbes: input.progressProbes ?? [],
    completionProbes: input.completionProbes ?? [],
    sideEffectClass: input.sideEffectClass ?? "none",
    status: "pending",
  };
}

export function compileGraph(contract: RunContract, verificationProbes: ProbeSpec[]): Graph {
  const family = classifyTask(contract.task);
  const nodes: GraphNode[] = [
    node({
      id: "implement",
      kind: family === "audit" ? "investigation" : "implementation",
      objective: contract.outcome,
      progressProbes: [
        {
          id: "workspace-diff",
          kind: "git_diff",
          baseSha: contract.repository.baseSha,
          requireChanges: family !== "audit",
        },
      ],
      sideEffectClass: family === "audit" ? "none" : "workspace_write",
    }),
    node({
      id: "verify",
      kind: "verification",
      objective: `Verify the approved outcome: ${contract.outcome}`,
      dependsOn: ["implement"],
      completionProbes: verificationProbes,
    }),
  ];

  if (contract.finishLine.kind === "committed") {
    nodes.push(
      node({
        id: "commit",
        kind: "commit",
        objective: "Create one atomic commit containing only the accepted Graphcraft run changes",
        dependsOn: ["verify"],
        sideEffectClass: "git_commit",
      }),
    );
  }

  const graph = GraphSchema.parse({
    schemaVersion: 1,
    runId: contract.runId,
    family,
    nodes,
    anchors: contract.acceptanceAnchors,
    controlEdges: runtimeControlEdges(contract.acceptanceAnchors, nodes),
    revision: 0,
  });
  validateGraph(graph);
  return graph;
}

function safeRelativePattern(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    value.length > 0 &&
    !isAbsolute(value) &&
    !/^[a-z]:\//i.test(normalized) &&
    !normalized.split("/").includes("..") &&
    !normalized.split("/").some((part) => part === ".git" || part === ".graphcraft")
  );
}

function patternWithin(candidate: string, boundary: string): boolean {
  const normalizedCandidate = candidate.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedBoundary = boundary.replaceAll("\\", "/").replace(/^\.\//, "");
  if (["**", "**/*"].includes(normalizedBoundary)) return true;
  if (normalizedCandidate === normalizedBoundary) return true;
  if (!normalizedBoundary.endsWith("/**")) return false;
  const prefix = normalizedBoundary.slice(0, -3).replace(/\/$/, "");
  return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}/`);
}

function sameProbe(left: ProbeSpec, right: ProbeSpec): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateProbePolicy(
  probe: ProbeSpec,
  contract: RunContract,
  approvedProbes: ProbeSpec[],
): void {
  if (probe.kind === "git_diff" && probe.baseSha !== contract.repository.baseSha)
    throw new Error(`Probe ${probe.id} is not bound to the approved base SHA`);
  if (probe.kind === "file" && !safeRelativePattern(probe.path))
    throw new Error(`Probe ${probe.id} contains an unsafe file path`);
  if (probe.kind === "command" && probe.cwd && !safeRelativePattern(probe.cwd))
    throw new Error(`Probe ${probe.id} contains an unsafe working directory`);
  if (
    probe.kind === "repository_inventory" &&
    probe.paths.some((path) => !safeRelativePattern(path))
  ) {
    throw new Error(`Probe ${probe.id} contains an unsafe inventory path`);
  }
  if (
    (probe.kind === "command" || probe.kind === "repository_inventory") &&
    !approvedProbes.some((allowed) => sameProbe(allowed, probe))
  ) {
    throw new Error(`Probe ${probe.id} is not an approved deterministic probe`);
  }
}

export function validateGraphPolicy(
  graph: Graph,
  contract: RunContract,
  requiredVerificationProbes: ProbeSpec[],
  approvedProbes: ProbeSpec[] = requiredVerificationProbes,
): void {
  if (graph.family !== classifyTask(contract.task))
    throw new Error("The planned graph changed the runtime-selected task family");
  const terminalNodes = graph.nodes.filter(
    (candidate) => !graph.nodes.some((other) => other.dependsOn.includes(candidate.id)),
  );
  if (terminalNodes.length !== 1)
    throw new Error("A planned graph must converge on exactly one finish-line node");

  const terminal = terminalNodes[0]!;
  const commitNodes = graph.nodes.filter((candidate) => candidate.kind === "commit");
  if (contract.finishLine.kind === "local_verified") {
    if (commitNodes.length > 0)
      throw new Error("A local_verified plan cannot contain commit nodes");
    if (terminal.kind !== "verification")
      throw new Error("A local_verified plan must end in a verification node");
  } else if (contract.finishLine.kind === "committed") {
    if (commitNodes.length !== 1 || terminal.kind !== "commit")
      throw new Error("A committed plan must end in exactly one commit node");
    if (
      terminal.dependsOn.length !== 1 ||
      graph.nodes.find((candidate) => candidate.id === terminal.dependsOn[0])?.kind !==
        "verification"
    ) {
      throw new Error("The terminal commit node must directly depend on one verification node");
    }
  } else {
    throw new Error(`Finish line ${contract.finishLine.kind} is not executable locally`);
  }

  const finalVerification =
    terminal.kind === "verification"
      ? terminal
      : graph.nodes.find((candidate) => candidate.id === terminal.dependsOn[0]);
  if (!finalVerification || finalVerification.completionProbes.length === 0)
    throw new Error("The terminal verification node must contain executable completion probes");
  for (const required of requiredVerificationProbes) {
    if (!finalVerification.completionProbes.some((candidate) => sameProbe(candidate, required))) {
      throw new Error(`The planned graph omitted required verification probe ${required.id}`);
    }
  }

  for (const item of graph.nodes) {
    if (!/^[a-z][a-z0-9-]*$/.test(item.id))
      throw new Error(`Planned node ID ${item.id} must be lowercase and stable`);
    if (item.kind === "wait")
      throw new Error("Wait nodes are not executable in the local runtime yet");
    if (!item.contextSelector.includeRepositoryInstructions)
      throw new Error(`Planned node ${item.id} attempted to omit repository instructions`);
    if (item.sideEffectClass === "external")
      throw new Error(`Planned node ${item.id} requests unsupported external side effects`);
    if (
      item.sideEffectClass === "workspace_write" &&
      !contract.permissions.includes("write_repository")
    )
      throw new Error(`Planned node ${item.id} exceeds repository write permissions`);
    if (item.sideEffectClass === "git_commit" && !contract.permissions.includes("commit"))
      throw new Error(`Planned node ${item.id} exceeds commit permissions`);
    if (item.kind === "verification" && item.sideEffectClass !== "none")
      throw new Error(`Verification node ${item.id} must be read-only`);
    if (item.kind === "commit" && item.sideEffectClass !== "git_commit")
      throw new Error(`Commit node ${item.id} must use the git_commit side-effect class`);
    if (item.scope.length === 0 || item.scope.some((pattern) => !safeRelativePattern(pattern)))
      throw new Error(`Planned node ${item.id} contains an unsafe repository scope`);
    if (
      item.scope.some(
        (pattern) =>
          !contract.scope.include.some((included) => patternWithin(pattern, included)) ||
          contract.scope.exclude.some((excluded) => patternWithin(pattern, excluded)),
      )
    ) {
      throw new Error(`Planned node ${item.id} exceeds the approved repository scope`);
    }
    if (
      item.contextSelector.relevantPaths.some(
        (path) =>
          !safeRelativePattern(path) ||
          contract.scope.exclude.some((excluded) => patternWithin(path, excluded)),
      )
    ) {
      throw new Error(`Planned node ${item.id} selects an unsafe context path`);
    }
    if (
      item.contextSelector.predecessorResults.some(
        (predecessor) => !item.dependsOn.includes(predecessor),
      )
    ) {
      throw new Error(`Planned node ${item.id} selects evidence outside its dependencies`);
    }
    if (item.kind !== "verification" && item.completionProbes.length > 0)
      throw new Error(`Only verification nodes may contain completion probes`);
    for (const probe of [...item.progressProbes, ...item.completionProbes]) {
      validateProbePolicy(probe, contract, approvedProbes);
    }
  }
  if (
    graph.family !== "audit" &&
    !graph.nodes.some((candidate) => candidate.sideEffectClass === "workspace_write")
  ) {
    throw new Error("A write-capable task plan must contain a workspace-write node");
  }
}

export function compilePlannedGraph(
  contract: RunContract,
  plan: GraphPlan,
  requiredVerificationProbes: ProbeSpec[],
  approvedProbes: ProbeSpec[] = requiredVerificationProbes,
): Graph {
  const parsedPlan = GraphPlanSchema.parse(plan);
  const plannedNodes = parsedPlan.nodes.map((planned) =>
    node({
      ...planned,
      outputSchema: resultShape,
    }),
  );
  const graph = GraphSchema.parse({
    schemaVersion: 1,
    runId: contract.runId,
    family: parsedPlan.family,
    nodes: plannedNodes,
    anchors: contract.acceptanceAnchors,
    controlEdges: runtimeControlEdges(contract.acceptanceAnchors, plannedNodes),
    revision: 0,
  });
  validateGraph(graph);
  validateGraphPolicy(graph, contract, requiredVerificationProbes, approvedProbes);
  return graph;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function edgeKey(edge: Graph["controlEdges"][number]): string {
  return `${edge.from}\0${edge.to}\0${edge.relation}`;
}

function materializeAmendmentNode(
  planned: GraphPlan["nodes"][number],
  outputSchema: GraphNode["outputSchema"] = resultShape,
): GraphNode {
  return node({ ...planned, outputSchema, status: "pending" });
}

function redirectNodeReferences(
  nodes: GraphNode[],
  removedIds: Set<string>,
  replacementIds: string[],
): GraphNode[] {
  const redirect = (values: string[]): string[] =>
    unique(values.flatMap((value) => (removedIds.has(value) ? replacementIds : [value])));
  return nodes
    .filter(({ id }) => !removedIds.has(id))
    .map((item) => ({
      ...item,
      dependsOn: redirect(item.dependsOn),
      contextSelector: {
        ...item.contextSelector,
        predecessorResults: redirect(item.contextSelector.predecessorResults),
      },
    }));
}

function assertReplacementAuthority(
  actor: "runtime" | "user",
  targets: GraphNode[],
  replacements: GraphNode[],
): void {
  if (actor === "user" || targets.length === 0) return;
  const targetScopes = targets.flatMap(({ scope }) => scope);
  const sideEffectRank: Record<GraphNode["sideEffectClass"], number> = {
    none: 0,
    workspace_write: 1,
    git_commit: 2,
    external: 3,
  };
  const maximumSideEffect = Math.max(
    ...targets.map(({ sideEffectClass }) => sideEffectRank[sideEffectClass]),
  );
  for (const replacement of replacements) {
    if (
      replacement.scope.some(
        (candidate) => !targetScopes.some((boundary) => patternWithin(candidate, boundary)),
      )
    )
      throw new Error(
        `Amendment broadens scope for ${replacement.id} without explicit user approval`,
      );
    if (sideEffectRank[replacement.sideEffectClass] > maximumSideEffect)
      throw new Error(
        `Amendment broadens side effects for ${replacement.id} without explicit user approval`,
      );
  }
}

export function applyGraphAmendment(input: {
  graph: Graph;
  contract: RunContract;
  amendment: GraphAmendment;
  actor: "runtime" | "user";
  nodeStatuses: Record<string, { status: GraphNode["status"] }>;
  requiredVerificationProbes: ProbeSpec[];
  approvedProbes?: ProbeSpec[];
}): { graph: Graph; diff: GraphAmendmentDiff } {
  const amendment = GraphAmendmentSchema.parse(input.amendment);
  const original = GraphSchema.parse(input.graph);
  if (JSON.stringify(original.anchors) !== JSON.stringify(input.contract.acceptanceAnchors))
    throw new Error("The graph acceptance anchors differ from the approved run contract");
  let nodes = [...original.nodes];
  const originalById = new Map(original.nodes.map((item) => [item.id, item]));
  const standardEdges = new Set(
    runtimeControlEdges(original.anchors, original.nodes).map((edge) => edgeKey(edge)),
  );
  const customEdges = original.controlEdges.filter((edge) => !standardEdges.has(edgeKey(edge)));
  const removedAcrossOperations = new Set<string>();

  const target = (id: string): GraphNode => {
    const item = nodes.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Amendment references unknown node ${id}`);
    const status = input.nodeStatuses[id]?.status;
    if (status === "accepted") throw new Error(`Accepted node ${id} is immutable`);
    if (status === "running")
      throw new Error(`Running node ${id} must be checkpointed before amendment`);
    return item;
  };
  const replacements = (planned: GraphPlan["nodes"], targets: GraphNode[]): GraphNode[] => {
    const outputSchema = targets[0]?.outputSchema ?? resultShape;
    const values = planned.map((item) => materializeAmendmentNode(item, outputSchema));
    const ids = new Set(values.map(({ id }) => id));
    if (ids.size !== values.length)
      throw new Error("Amendment replacement node IDs must be unique");
    const removed = new Set(targets.map(({ id }) => id));
    for (const value of values) {
      if (removed.has(value.id))
        throw new Error(`Amendment replacement ${value.id} must use a new stable node ID`);
      if (nodes.some((existing) => existing.id === value.id && !removed.has(existing.id)))
        throw new Error(`Amendment node ID ${value.id} already exists`);
    }
    assertReplacementAuthority(input.actor, targets, values);
    return values;
  };
  const replace = (targets: GraphNode[], values: GraphNode[]): void => {
    const removed = new Set(targets.map(({ id }) => id));
    for (const id of removed) removedAcrossOperations.add(id);
    nodes = [
      ...redirectNodeReferences(
        nodes,
        removed,
        values.map(({ id }) => id),
      ),
      ...values,
    ];
  };

  for (const operation of amendment.operations) {
    if (operation.operation === "add") {
      const authoritySourceIds = unique(operation.authoritySourceIds);
      if (authoritySourceIds.length !== operation.authoritySourceIds.length)
        throw new Error("Add authority source IDs must be unique");
      if (authoritySourceIds.some((id) => !operation.node.dependsOn.includes(id)))
        throw new Error("An added node must depend on every declared authority source");
      const authoritySources = authoritySourceIds.map((id) => {
        const source = nodes.find((candidate) => candidate.id === id);
        if (!source) throw new Error(`Amendment references unknown authority source ${id}`);
        return source;
      });
      const value = replacements([operation.node], authoritySources);
      nodes.push(...value);
      continue;
    }
    if (operation.operation === "supersede") {
      const replaced = target(operation.targetId);
      replace([replaced], replacements([operation.replacement], [replaced]));
      continue;
    }
    if (operation.operation === "split") {
      const replaced = target(operation.targetId);
      replace([replaced], replacements(operation.replacements, [replaced]));
      continue;
    }
    if (operation.operation === "fuse") {
      const targetIds = unique(operation.targetIds);
      if (targetIds.length !== operation.targetIds.length)
        throw new Error("Fuse target IDs must be unique");
      const fused = targetIds.map((id) => target(id));
      replace(fused, replacements([operation.replacement], fused));
      continue;
    }
    const changed = target(operation.targetId);
    nodes = nodes.map((item) =>
      item.id === changed.id
        ? {
            ...item,
            dependsOn: unique(operation.dependsOn),
            contextSelector: {
              ...item.contextSelector,
              predecessorResults: item.contextSelector.predecessorResults.filter((id) =>
                operation.dependsOn.includes(id),
              ),
            },
          }
        : item,
    );
  }

  for (const edge of customEdges) {
    if (removedAcrossOperations.has(edge.from) || removedAcrossOperations.has(edge.to))
      throw new Error(
        `Amendment cannot remove control-bound node ${removedAcrossOperations.has(edge.from) ? edge.from : edge.to}`,
      );
  }
  validateGraph(
    GraphSchema.parse({
      ...original,
      nodes,
      controlEdges: [],
      revision: original.revision + 1,
    }),
  );
  const graph = GraphSchema.parse({
    ...original,
    nodes,
    anchors: input.contract.acceptanceAnchors,
    controlEdges: [...runtimeControlEdges(input.contract.acceptanceAnchors, nodes), ...customEdges],
    revision: original.revision + 1,
  });
  validateGraph(graph);
  validateGraphPolicy(
    graph,
    input.contract,
    input.requiredVerificationProbes,
    input.approvedProbes ?? input.requiredVerificationProbes,
  );
  for (const [id, status] of Object.entries(input.nodeStatuses)) {
    if (status.status !== "accepted") continue;
    if (
      JSON.stringify(originalById.get(id)) !==
      JSON.stringify(graph.nodes.find((item) => item.id === id))
    )
      throw new Error(`Accepted node ${id} was changed by the amendment`);
  }
  const finalById = new Map(graph.nodes.map((item) => [item.id, item]));
  const addedNodeIds = [...finalById.keys()].filter((id) => !originalById.has(id)).sort();
  const removedNodeIds = [...originalById.keys()].filter((id) => !finalById.has(id)).sort();
  const changedNodeIds = [...originalById.keys()]
    .filter(
      (id) =>
        finalById.has(id) &&
        JSON.stringify(originalById.get(id)) !== JSON.stringify(finalById.get(id)),
    )
    .sort();
  if (addedNodeIds.length + removedNodeIds.length + changedNodeIds.length === 0)
    throw new Error("Amendment did not change the graph");
  return { graph, diff: { addedNodeIds, removedNodeIds, changedNodeIds } };
}

function verificationNode(graph: Graph): GraphNode {
  const terminal = graph.nodes.find(
    (candidate) => !graph.nodes.some((other) => other.dependsOn.includes(candidate.id)),
  );
  const verification =
    terminal?.kind === "verification"
      ? terminal
      : graph.nodes.find(
          (candidate) =>
            candidate.kind === "verification" && terminal?.dependsOn.includes(candidate.id),
        );
  if (!verification) throw new Error("The graph has no finish-line verification node");
  return verification;
}

export function applyProbePlan(graph: Graph, contract: RunContract, input: ProbePlan): Graph {
  const plan = ProbePlanSchema.parse(input);
  if (plan.family !== graph.family || plan.family !== classifyTask(contract.task))
    throw new Error("The probe plan does not match the runtime-selected task family");
  const completion = plan.items.filter(({ phase }) => phase === "completion");
  if (completion.length === 0) throw new Error("A probe plan must contain completion evidence");

  const targetVerificationId = verificationNode(graph).id;
  const nodes: GraphNode[] = graph.nodes.map((item) => ({
    ...item,
    progressProbes: [],
    completionProbes: item.id === targetVerificationId ? completion.map(({ probe }) => probe) : [],
  }));
  for (const item of plan.items.filter(({ phase }) => phase === "progress")) {
    const preferred =
      item.purpose === "inventory"
        ? nodes.find((node) => ["investigation", "decision", "diagnostic"].includes(node.kind))
        : nodes.find((node) => node.sideEffectClass === "workspace_write");
    const target =
      preferred ?? nodes.find((node) => !["verification", "commit"].includes(node.kind));
    if (!target) throw new Error(`No executable node can own progress probe ${item.probe.id}`);
    target.progressProbes.push(item.probe);
  }

  const updated = GraphSchema.parse({ ...graph, nodes });
  const approved = plan.items.map(({ probe }) => probe);
  for (const item of updated.nodes)
    for (const probe of [...item.progressProbes, ...item.completionProbes])
      validateProbePolicy(probe, contract, approved);
  validateGraph(updated);
  return updated;
}

export function probePlanFromGraph(graph: Graph): ProbePlan {
  return ProbePlanSchema.parse({
    schemaVersion: 1,
    family: graph.family,
    items: graph.nodes.flatMap((node) => [
      ...node.progressProbes.map((probe) => ({
        phase: "progress" as const,
        purpose:
          probe.kind === "repository_inventory" ? ("inventory" as const) : ("focused" as const),
        source: `Recovered from graph node ${node.id}`,
        probe,
      })),
      ...node.completionProbes.map((probe) => ({
        phase: "completion" as const,
        purpose: "regression" as const,
        source: `Recovered from graph node ${node.id}`,
        probe,
      })),
    ]),
  });
}

export function validateGraph(graph: Graph): void {
  GraphSchema.parse(graph);
  const ids = new Set(graph.nodes.map(({ id }) => id));
  if (ids.size !== graph.nodes.length) throw new Error("Graph node IDs must be unique");
  const anchorIds = new Set(graph.anchors.map(({ id }) => id));
  if (anchorIds.size !== graph.anchors.length) throw new Error("Graph anchor IDs must be unique");
  if ([...ids].some((id) => anchorIds.has(id)))
    throw new Error("Graph node and anchor IDs must not overlap");
  for (const item of graph.nodes) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency))
        throw new Error(`Node ${item.id} depends on unknown node ${dependency}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(graph.nodes.map((item) => [item.id, item]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Graph contains a dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);

  const targets = new Set([...ids, ...anchorIds]);
  const edgeKeys = new Set<string>();
  for (const edge of graph.controlEdges) {
    if (!targets.has(edge.from) || !targets.has(edge.to))
      throw new Error(`Control edge ${edge.from} -> ${edge.to} references an unknown target`);
    const key = `${edge.from}\0${edge.to}\0${edge.relation}`;
    if (edgeKeys.has(key)) throw new Error(`Control edge ${edge.from} -> ${edge.to} is duplicated`);
    if (!ids.has(edge.to))
      throw new Error(`Control edge ${edge.from} -> ${edge.to} must target a work node`);
    if (edge.from === edge.to)
      throw new Error(`Control edge ${edge.from} -> ${edge.to} cannot control itself`);
    edgeKeys.add(key);
  }
}

export function graphPlanShape(graph: Graph): string {
  const remaining = new Map(graph.nodes.map((item) => [item.id, item]));
  const emitted = new Set<string>();
  const layers: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((item) =>
      item.dependsOn.every((dependency) => emitted.has(dependency)),
    );
    if (ready.length === 0) throw new Error("Cannot render a cyclic graph plan");
    const labels = ready.map(({ id }) => id);
    layers.push(labels.length === 1 ? labels[0]! : `(${labels.join(" + ")})`);
    for (const item of ready) {
      emitted.add(item.id);
      remaining.delete(item.id);
    }
  }
  return layers.join(" → ");
}

export function readyNodes(graph: Graph, accepted: Set<string>): GraphNode[] {
  return graph.nodes.filter(
    (item) =>
      item.status === "pending" && item.dependsOn.every((dependency) => accepted.has(dependency)),
  );
}
