import {
  ContextSelectionReceiptSchema,
  contentHash,
  contextCapsuleCharacters,
  createContextCapsule,
  type ContextCapsule,
  type ContextSelectionReceipt,
  type GraphNode,
  type ProbeResult,
  type RunContract,
} from "@graphcraft/core";
import { runProcess } from "@graphcraft/probes";
import { RunStore } from "./store.ts";

const contextStopWords = new Set([
  "acceptance",
  "approved",
  "complete",
  "completion",
  "feature",
  "implement",
  "implementation",
  "repository",
  "substantial",
  "verify",
]);

function contextTerms(objective: string): string[] {
  return [
    ...new Set(
      (objective.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g) ?? []).filter(
        (term) => !contextStopWords.has(term),
      ),
    ),
  ].slice(0, 12);
}

export function groundedRelevantPaths(paths: string[], objective: string): string[] {
  const terms = contextTerms(objective);
  return [...new Set(paths)]
    .filter(
      (path) =>
        path.length > 0 &&
        !path.startsWith("dist/") &&
        !path.endsWith(".map") &&
        !path.endsWith(".lock"),
    )
    .map((path) => {
      const normalized = path.toLowerCase();
      const affinity = terms.filter((term) => normalized.includes(term)).length;
      const source = /(?:^|\/)(?:src|test|tests)\//.test(path) ? 2 : 0;
      const policy = /(?:^|\/)(?:agents\.md|package\.json|pyproject\.toml|go\.mod)$/i.test(path)
        ? 1
        : 0;
      return { path, score: affinity * 4 + source + policy };
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 4)
    .map(({ path }) => path);
}

function selectedTrackedPaths(inventory: string[], selected: string[]): Set<string> {
  const matches = new Set<string>();
  for (const path of inventory)
    if (selected.some((candidate) => path === candidate || path.startsWith(`${candidate}/`)))
      matches.add(path);
  return matches;
}

export async function prepareWorkerContext(input: {
  store: RunStore;
  invocationId: string;
  contract: RunContract;
  node: GraphNode;
  repositoryPath: string;
  predecessorEvidence: string[];
  probeResults: ProbeResult[];
}): Promise<{
  capsule: ContextCapsule;
  capsuleHash: string;
  receipt: ContextSelectionReceipt;
}> {
  const tracked = await runProcess(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    {
      cwd: input.repositoryPath,
      timeoutMs: 30_000,
    },
  );
  if (tracked.exitCode !== 0) throw new Error("Unable to inventory repository context");
  const repositoryPaths = tracked.stdout.split("\n").filter(Boolean).sort();
  const inventory = await input.store.writeContentAddressedArtifact(
    "context-repositories",
    `${JSON.stringify(repositoryPaths)}\n`,
  );
  const relevantPaths = input.node.contextSelector.relevantPaths.length
    ? input.node.contextSelector.relevantPaths
    : groundedRelevantPaths(repositoryPaths, input.node.objective);
  if (
    input.node.kind !== "commit" &&
    input.node.kind !== "push" &&
    input.node.kind !== "pull_request" &&
    relevantPaths.length === 0
  )
    throw new Error(`Node ${input.node.id} has no grounded repository context`);
  const node: GraphNode = {
    ...input.node,
    contextSelector: { ...input.node.contextSelector, relevantPaths },
  };
  const capsule = createContextCapsule({
    contract: input.contract,
    node,
    predecessorEvidence: input.predecessorEvidence,
    probeResults: input.probeResults,
  });
  const capsuleHash = contentHash(capsule);
  const storedCapsule = await input.store.writeCapsule(capsuleHash, capsule);
  const matchedPaths = selectedTrackedPaths(repositoryPaths, capsule.relevantPaths);
  const selectedPredecessorNodeIds = input.node.contextSelector.predecessorResults.filter(
    (nodeId) => capsule.predecessorEvidence.some((value) => value.startsWith(`${nodeId}:`)),
  );
  const selectedProbeResults = input.probeResults.filter(({ probeId }) =>
    capsule.probeEvidence.some((value) => value.startsWith(`${probeId}:`)),
  );
  const reusedArtifacts = [
    ...(storedCapsule.reused ? [storedCapsule.path] : []),
    ...(inventory.reused ? [inventory.path] : []),
  ];
  const receipt = ContextSelectionReceiptSchema.parse({
    schemaVersion: 1,
    runId: input.contract.runId,
    nodeId: input.node.id,
    capsule: {
      hash: capsuleHash,
      path: storedCapsule.path,
      characters: contextCapsuleCharacters(capsule),
    },
    selected: {
      repositoryPaths: capsule.relevantPaths,
      predecessorNodeIds: selectedPredecessorNodeIds,
      predecessorEvidenceHashes: capsule.predecessorEvidence.map((value) => contentHash(value)),
      probeIds: selectedProbeResults.map(({ probeId }) => probeId),
      probeSignatures: selectedProbeResults.map(({ signature }) => signature),
      acceptanceAnchorIds: capsule.acceptanceAnchors.map(({ id }) => id),
    },
    omitted: {
      repositoryPathCount: repositoryPaths.length - matchedPaths.size,
      declaredRepositoryPaths: input.node.contextSelector.relevantPaths.filter(
        (path) => !capsule.relevantPaths.includes(path),
      ),
      predecessorNodeIds: input.node.dependsOn.filter(
        (nodeId) => !selectedPredecessorNodeIds.includes(nodeId),
      ),
      probeIds: input.probeResults
        .filter(({ probeId }) => !selectedProbeResults.some((result) => result.probeId === probeId))
        .map(({ probeId }) => probeId),
      repositoryInventory: {
        digest: inventory.hash,
        artifact: inventory.path,
        totalPathCount: repositoryPaths.length,
      },
      rawHostTranscripts: true,
      rawProbeOutputs: true,
    },
    reused: {
      capsule: storedCapsule.reused,
      repositoryInventory: inventory.reused,
      artifacts: reusedArtifacts,
    },
  });
  await input.store.append("runtime", "context.selected", { receipt }, input.invocationId);
  return { capsule, capsuleHash, receipt };
}
