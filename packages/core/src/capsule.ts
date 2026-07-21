import type { ContextCapsule, GraphNode, ProbeResult, RunContract } from "./schemas.ts";
import { ContextCapsuleSchema } from "./schemas.ts";

export function createContextCapsule(input: {
  contract: RunContract;
  node: GraphNode;
  predecessorEvidence?: string[];
  probeResults?: ProbeResult[];
}): ContextCapsule {
  const { contract, node } = input;
  return ContextCapsuleSchema.parse({
    schemaVersion: 1,
    runId: contract.runId,
    nodeId: node.id,
    objective: node.objective,
    finishLine: contract.finishLine,
    constraints: [
      `Stay inside the approved scope: ${contract.scope.include.join(", ")}`,
      `Do not touch excluded paths: ${contract.scope.exclude.join(", ")}`,
      "Do not weaken tests, repository policy, acceptance anchors, or the finish line.",
      "Preserve unrelated work and report evidence, not confidence.",
    ],
    acceptanceAnchors: contract.acceptanceAnchors,
    predecessorEvidence: input.predecessorEvidence ?? [],
    relevantPaths: node.contextSelector.relevantPaths,
    probeEvidence: (input.probeResults ?? []).map(
      (result) => `${result.probeId}: ${result.passed ? "pass" : "fail"} - ${result.summary}`,
    ),
  });
}
