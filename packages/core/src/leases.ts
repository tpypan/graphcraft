import { contentHash } from "./canonical.ts";
import type {
  EvidenceSnapshot,
  Graph,
  ProbeResult,
  ProgressClassification,
  ProgressVector,
} from "./schemas.ts";

function progressVector(probeResults: ProbeResult[], family?: Graph["family"]): ProgressVector {
  const passedProbeIds = probeResults
    .filter(({ passed }) => passed)
    .map(({ probeId }) => probeId)
    .sort();
  const failingProbeIds = probeResults
    .filter(({ passed }) => !passed)
    .map(({ probeId }) => probeId)
    .sort();
  const metrics: Record<string, number> = { failingProbes: failingProbeIds.length };
  for (const result of probeResults)
    for (const [key, value] of Object.entries(result.metrics ?? {}))
      metrics[key] = (metrics[key] ?? 0) + value;
  if (family === "migration" && metrics.inventoryMatches !== undefined)
    metrics.remainingInventory = metrics.inventoryMatches;
  const probes = probeResults
    .map(({ probeId, kind, passed, signature, metrics: resultMetrics }) => ({
      probeId,
      kind,
      passed,
      signature,
      metrics: resultMetrics ?? {},
    }))
    .sort((left, right) => left.probeId.localeCompare(right.probeId));
  return {
    digest: contentHash({ probes, metrics }),
    passedProbeIds,
    failingProbeIds,
    metrics,
  };
}

export function evidenceSnapshot(
  workspaceDigest: string,
  probeResults: ProbeResult[],
  family?: Graph["family"],
): EvidenceSnapshot {
  const failedResults = probeResults.filter((result) => !result.passed);
  const vector = progressVector(probeResults, family);
  return {
    digest: contentHash({ workspaceDigest, vector: vector.digest }),
    workspaceDigest,
    passed: probeResults.length - failedResults.length,
    failed: failedResults.length,
    failureSignature: contentHash(
      failedResults
        .map(({ probeId, signature }) => ({ probeId, signature }))
        .sort((left, right) => left.probeId.localeCompare(right.probeId)),
    ),
    probeResults,
    vector,
  };
}

function metricDirection(key: string): "higher" | "lower" | undefined {
  if (/remaining|fail|unresolved|error|missing|todo/i.test(key)) return "lower";
  if (/coverage|completed|passed|resolved/i.test(key)) return "higher";
  return undefined;
}

function metricTrend(
  baseline: EvidenceSnapshot,
  current: EvidenceSnapshot,
): "improved" | "regressed" | "unchanged" {
  let improved = false;
  for (const key of new Set([
    ...Object.keys(baseline.vector.metrics),
    ...Object.keys(current.vector.metrics),
  ])) {
    const direction = metricDirection(key);
    const before = baseline.vector.metrics[key];
    const after = current.vector.metrics[key];
    if (!direction || before === undefined || after === undefined || before === after) continue;
    const better = direction === "higher" ? after > before : after < before;
    if (!better) return "regressed";
    improved = true;
  }
  return improved ? "improved" : "unchanged";
}

export function classifyProgress(
  baseline: EvidenceSnapshot,
  current: EvidenceSnapshot,
  history: EvidenceSnapshot[] = [],
): ProgressClassification {
  const remainingInventory = current.vector.metrics.remainingInventory;
  if (
    current.probeResults.length > 0 &&
    current.failed === 0 &&
    (remainingInventory === undefined || remainingInventory === 0)
  )
    return "done";
  const earlier = history.at(-1)?.digest === current.digest ? history.slice(0, -1) : history;
  if (earlier.some((snapshot) => snapshot.vector.digest === current.vector.digest))
    return "oscillating";
  const metrics = metricTrend(baseline, current);
  if (
    current.passed < baseline.passed ||
    current.failed > baseline.failed ||
    metrics === "regressed"
  )
    return "regressed";
  if (
    current.passed > baseline.passed ||
    current.failed < baseline.failed ||
    metrics === "improved" ||
    current.workspaceDigest !== baseline.workspaceDigest
  ) {
    return "advanced";
  }
  if (current.failureSignature !== baseline.failureSignature) return "learning";
  return "stalled";
}
