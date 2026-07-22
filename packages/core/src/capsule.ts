import type { ContextCapsule, GraphNode, ProbeResult, RunContract } from "./schemas.ts";
import { ContextCapsuleSchema } from "./schemas.ts";

export const MAX_CONTEXT_CAPSULE_CHARACTERS = 24_000;

function compactText(value: string, maximum: number): string {
  const normalized = value.replace(/\0/g, "").trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, Math.max(0, maximum - 14))}\n… [truncated]`;
}

function compactList(
  values: string[],
  maximumItems: number,
  maximumItemCharacters: number,
  maximumTotalCharacters: number,
): string[] {
  const selected: string[] = [];
  let remaining = maximumTotalCharacters;
  for (const value of values.slice(0, maximumItems)) {
    if (remaining <= 0) break;
    const item = compactText(value, Math.min(maximumItemCharacters, remaining));
    selected.push(item);
    remaining -= item.length;
  }
  return selected;
}

function boundedValues(values: string[], maximumItems: number, maximumTotalCharacters: number) {
  const selected: string[] = [];
  let remaining = maximumTotalCharacters;
  for (const value of values) {
    if (selected.length >= maximumItems) break;
    if (value.length > remaining) continue;
    selected.push(value);
    remaining -= value.length;
  }
  return selected;
}

export function contextCapsuleCharacters(capsule: ContextCapsule): number {
  return JSON.stringify(capsule).length;
}

export function createContextCapsule(input: {
  contract: RunContract;
  node: GraphNode;
  predecessorEvidence?: string[];
  probeResults?: ProbeResult[];
}): ContextCapsule {
  const { contract, node } = input;
  const capsule = {
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
    predecessorEvidence: compactList(input.predecessorEvidence ?? [], 8, 1_500, 4_000),
    relevantPaths: boundedValues([...new Set(node.contextSelector.relevantPaths)], 32, 4_000),
    probeEvidence: compactList(
      (input.probeResults ?? []).map(
        (result) => `${result.probeId}: ${result.passed ? "pass" : "fail"} - ${result.summary}`,
      ),
      16,
      1_500,
      5_000,
    ),
  };
  const parsed = ContextCapsuleSchema.parse(capsule);
  const characters = contextCapsuleCharacters(parsed);
  if (characters > MAX_CONTEXT_CAPSULE_CHARACTERS)
    throw new Error(
      `Context capsule for ${node.id} exceeds ${MAX_CONTEXT_CAPSULE_CHARACTERS} characters`,
    );
  return parsed;
}
