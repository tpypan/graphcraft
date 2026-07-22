import { canonicalJson } from "./canonical.ts";
import type { PlanningRequest } from "./adapter.ts";
import { classifyTask } from "./graph.ts";

export function renderPlannerPrompt(request: PlanningRequest): string {
  return [
    "You are the read-only planning phase of a Graphcraft run.",
    "Graphcraft has already inspected the repository. Use only the bounded repository evidence below and do not assume unlisted files exist.",
    "Return a task-specific, dependency-complete graph for the approved contract below.",
    "Make the topology and node kinds meaningfully task-specific; do not reuse one generic investigate/implement/verify chain for every task family.",
    "For bugs, localize the failure from reproduction or regression evidence before a repair and terminal verification.",
    "For features, establish the acceptance or interface decision before implementation and terminal verification.",
    "For migrations, inventory authoritative old usage before scoped migration work converges on terminal verification.",
    "For refactors, capture a behavior-preservation and structural baseline before the change and terminal verification.",
    "For audits, remain read-only, gather independently scoped evidence where possible, and converge on a terminal verification of coverage and unresolved unknowns.",
    "Use investigation nodes when repository evidence must be gathered before writes.",
    "End local_verified work in one verification node with executable completion probes.",
    "End committed work in one commit node that directly depends on a verification node.",
    "Use only repository-relative scopes. Never propose external side effects.",
    "Use a wait node only when the task explicitly requires time or filesystem state before downstream reasoning. Wait nodes must be read-only, have no probes, and declare one time, file_exists, or file_changed condition. Use a bounded 250-300000ms polling interval for filesystem conditions and an explicit timeout when the request provides one.",
    "Use the supplied task family. Every node must keep repository instructions enabled.",
    "A node may select predecessorResults only from its direct dependsOn list; do not repeat transitive predecessors.",
    "Select at least one existing tracked repository path for every non-commit node. Every relevantPaths value must be copied exactly from repositoryEvidence.trackedPaths; relevant paths are evidence inputs, not files the worker might create. A wait-condition path may identify a future repository-relative file even when it is not yet tracked.",
    "Investigation, decision, verification, and wait nodes must use sideEffectClass none. Implementation and repair/diagnostic nodes that edit files use workspace_write. Commit nodes alone use git_commit.",
    "Use the supplied probe plan exactly: assign completion probes to the terminal verification node and progress probes to the node where they measure change.",
    "Only the terminal verification node may contain completionProbes. Every other node must have an empty completionProbes array.",
    "Do not invent, weaken, omit, or replace probes. Graphcraft will deterministically reattach the approved probe plan after validating the topology.",
    "Keep node IDs short, stable, lowercase, and unique. Return only the required structured plan.",
    "",
    canonicalJson({
      contract: request.contract,
      taskFamily: classifyTask(request.contract.task),
      repositoryEvidence: request.repositoryEvidence,
      probePlan: request.probePlan,
    }),
  ].join("\n");
}
