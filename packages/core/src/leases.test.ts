import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_CANONICAL_HASH_ALGORITHM, PORTABLE_CANONICAL_HASH_ALGORITHM } from "./canonical.ts";
import { evidenceSnapshot, parseEvidenceSnapshot } from "./leases.ts";
import type { ProbeResult } from "./schemas.ts";

const probeResults: ProbeResult[] = [
  {
    probeId: "Z-probe",
    kind: "command",
    passed: false,
    signature: "Z-signature",
    summary: "failed",
    durationMs: 1,
    metrics: { Z: 2, a: 3 },
  },
  {
    probeId: "a-probe",
    kind: "file",
    passed: true,
    signature: "a-signature",
    summary: "passed",
    durationMs: 2,
    metrics: { a: 5, Z: 7 },
  },
];

function reverseCodeUnits(this: string, other: string): number {
  const left = String(this);
  return left < other ? 1 : left > other ? -1 : 0;
}

afterEach(() => vi.restoreAllMocks());

describe("versioned probe evidence", () => {
  it("retains the legacy evidence identity and validates every recomputed field", () => {
    vi.spyOn(String.prototype, "localeCompare").mockImplementation(reverseCodeUnits);

    const snapshot = evidenceSnapshot("workspace-Z-a", probeResults, "feature");

    expect(snapshot).toMatchObject({
      digest: "9c0280746f797d544b460feb982785eaef05a99307cf85724d3d24be012ad193",
      failureSignature: "3a0d37a87f7ae0fe96aec3dee60ae6c8d3fa7875db3ac01406a1c52e53217142",
      vector: {
        digest: "5b95ad97fbded72b4658df8c30787cd699bf004b7d0d44fbbf07ad35b005a347",
      },
    });
    expect(snapshot).toEqual(
      evidenceSnapshot("workspace-Z-a", probeResults, "feature", LEGACY_CANONICAL_HASH_ALGORITHM),
    );
    expect(parseEvidenceSnapshot(snapshot, "feature")).toEqual(snapshot);

    for (const tampered of [
      { ...snapshot, digest: "0".repeat(64) },
      { ...snapshot, failureSignature: "0".repeat(64) },
      { ...snapshot, passed: snapshot.passed + 1 },
      { ...snapshot, vector: { ...snapshot.vector, digest: "0".repeat(64) } },
      {
        ...snapshot,
        vector: {
          ...snapshot.vector,
          metrics: { ...snapshot.vector.metrics, failingProbes: 0 },
        },
      },
    ])
      expect(parseEvidenceSnapshot(tampered, "feature")).toBeUndefined();
  });

  it("keeps portable evidence independent from ambient collation and rejects policy relabelling", () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("portable probe evidence used ambient locale ordering");
    });

    const portable = evidenceSnapshot(
      "workspace-Z-a",
      probeResults,
      "feature",
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );

    expect(localeCompare).not.toHaveBeenCalled();
    expect(portable).toMatchObject({
      digest: "c8f59f4af55d008469deb0cb9bdcc0a269af947dc7162483fd2cc33e8695bc46",
      failureSignature: "93e3a146cdcdecf00a46674d9fb8302ceb0c4a3f23ec8bf466c4de7e6e761166",
      vector: {
        digest: "bb0c2be6e78cf25a7a93574a21bc46342b5605638bb851cd4b5edec911cebb37",
      },
    });
    expect(parseEvidenceSnapshot(portable, "feature", PORTABLE_CANONICAL_HASH_ALGORITHM)).toEqual(
      portable,
    );

    localeCompare.mockRestore();
    vi.spyOn(String.prototype, "localeCompare").mockImplementation(reverseCodeUnits);
    const legacy = evidenceSnapshot("workspace-Z-a", probeResults, "feature");
    expect(
      parseEvidenceSnapshot(legacy, "feature", PORTABLE_CANONICAL_HASH_ALGORITHM),
    ).toBeUndefined();
    expect(
      parseEvidenceSnapshot(portable, "feature", LEGACY_CANONICAL_HASH_ALGORITHM),
    ).toBeUndefined();
  });

  it("recomputes migration-only evidence fields under the declared family", () => {
    const result: ProbeResult = {
      probeId: "remaining-v2-usage",
      kind: "repository_inventory",
      passed: true,
      signature: "inventory-3",
      summary: "three matches",
      durationMs: 1,
      metrics: { inventoryMatches: 3 },
    };
    const snapshot = evidenceSnapshot(
      "workspace-migration",
      [result],
      "migration",
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );

    expect(snapshot.vector.metrics.remainingInventory).toBe(3);
    expect(parseEvidenceSnapshot(snapshot, "migration", PORTABLE_CANONICAL_HASH_ALGORITHM)).toEqual(
      snapshot,
    );
    expect(
      parseEvidenceSnapshot(snapshot, "feature", PORTABLE_CANONICAL_HASH_ALGORITHM),
    ).toBeUndefined();
  });
});
