import { randomUUID } from "node:crypto";
import type { Graph, GraphNode, Permission, ProbeSpec, RunContract } from "./schemas.ts";
import { GraphSchema, RunContractSchema } from "./schemas.ts";

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
  if (/bug|fix|regression|broken|error|fail/.test(value)) return "bug";
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
    ],
  });
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
    controlEdges: contract.acceptanceAnchors.flatMap((anchor) =>
      nodes.map((workNode) => ({ from: anchor.id, to: workNode.id, relation: "vetoes" as const })),
    ),
    revision: 0,
  });
  validateGraph(graph);
  return graph;
}

export function validateGraph(graph: Graph): void {
  GraphSchema.parse(graph);
  const ids = new Set(graph.nodes.map(({ id }) => id));
  if (ids.size !== graph.nodes.length) throw new Error("Graph node IDs must be unique");
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
}

export function readyNodes(graph: Graph, accepted: Set<string>): GraphNode[] {
  return graph.nodes.filter(
    (item) =>
      item.status === "pending" && item.dependsOn.every((dependency) => accepted.has(dependency)),
  );
}
