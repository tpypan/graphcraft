import { isDeepStrictEqual } from "node:util";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  contentHash,
  type CanonicalHashAlgorithm,
} from "./canonical.ts";
import {
  EvidenceSnapshotSchema,
  type EvidenceSnapshot,
  type Graph,
  type ProbeResult,
  type ProgressClassification,
  type ProgressVector,
} from "./schemas.ts";

function compareStrings(left: string, right: string, algorithm: CanonicalHashAlgorithm): number {
  if (algorithm === LEGACY_CANONICAL_HASH_ALGORITHM) return left.localeCompare(right);
  return left < right ? -1 : left > right ? 1 : 0;
}

function progressVector(
  probeResults: ProbeResult[],
  family: Graph["family"] | undefined,
  algorithm: CanonicalHashAlgorithm,
): ProgressVector {
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
    .sort((left, right) => compareStrings(left.probeId, right.probeId, algorithm));
  return {
    digest: contentHash({ probes, metrics }, algorithm),
    passedProbeIds,
    failingProbeIds,
    metrics,
  };
}

export function evidenceSnapshot(
  workspaceDigest: string,
  probeResults: ProbeResult[],
  family?: Graph["family"],
  algorithm: CanonicalHashAlgorithm = LEGACY_CANONICAL_HASH_ALGORITHM,
): EvidenceSnapshot {
  const failedResults = probeResults.filter((result) => !result.passed);
  const vector = progressVector(probeResults, family, algorithm);
  return {
    digest: contentHash({ workspaceDigest, vector: vector.digest }, algorithm),
    workspaceDigest,
    passed: probeResults.length - failedResults.length,
    failed: failedResults.length,
    failureSignature: contentHash(
      failedResults
        .map(({ probeId, signature }) => ({ probeId, signature }))
        .sort((left, right) => compareStrings(left.probeId, right.probeId, algorithm)),
      algorithm,
    ),
    probeResults,
    vector,
  };
}

export function parseEvidenceSnapshot(
  value: unknown,
  family?: Graph["family"],
  algorithm: CanonicalHashAlgorithm = LEGACY_CANONICAL_HASH_ALGORITHM,
): EvidenceSnapshot | undefined {
  const parsed = EvidenceSnapshotSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const recomputed = evidenceSnapshot(
    parsed.data.workspaceDigest,
    parsed.data.probeResults,
    family,
    algorithm,
  );
  return isDeepStrictEqual(parsed.data, recomputed) ? parsed.data : undefined;
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
