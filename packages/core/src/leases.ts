import { contentHash } from "./canonical.ts";
import type { ProbeResult } from "./schemas.ts";

export type ProgressClassification =
  "advanced" | "learning" | "stalled" | "regressed" | "oscillating" | "blocked" | "done";

export interface EvidenceSnapshot {
  digest: string;
  workspaceDigest: string;
  passed: number;
  failed: number;
  failureSignature: string;
  probeResults: ProbeResult[];
}

export function evidenceSnapshot(
  workspaceDigest: string,
  probeResults: ProbeResult[],
): EvidenceSnapshot {
  const failedResults = probeResults.filter((result) => !result.passed);
  return {
    digest: contentHash({ workspaceDigest, probeResults }),
    workspaceDigest,
    passed: probeResults.length - failedResults.length,
    failed: failedResults.length,
    failureSignature: contentHash(
      failedResults.map(({ probeId, signature }) => ({ probeId, signature })),
    ),
    probeResults,
  };
}

export function classifyProgress(
  baseline: EvidenceSnapshot,
  current: EvidenceSnapshot,
  history: EvidenceSnapshot[] = [],
): ProgressClassification {
  if (current.probeResults.length > 0 && current.failed === 0) return "done";
  if (current.passed < baseline.passed || current.failed > baseline.failed) return "regressed";
  if (history.slice(0, -1).some((snapshot) => snapshot.digest === current.digest))
    return "oscillating";
  if (current.passed > baseline.passed || current.workspaceDigest !== baseline.workspaceDigest) {
    return "advanced";
  }
  if (current.failureSignature !== baseline.failureSignature) return "learning";
  return "stalled";
}
