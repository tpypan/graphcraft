import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_CANONICAL_HASH_ALGORITHM, PORTABLE_CANONICAL_HASH_ALGORITHM } from "./canonical.ts";
import {
  createHeldOutProbePlan,
  resolveHeldOutProbes,
  validateHeldOutProbePlan,
  workerVisibleProbePlan,
} from "./held-out.ts";
import { HeldOutProbePlanSchema, type ProbePlan } from "./schemas.ts";

const runId = "40000000-0000-4000-8000-000000000001";
const completionProbe = {
  id: "hidden-acceptance",
  kind: "command" as const,
  command: "node",
  args: ["hidden-scorer.mjs", "--private-rubric"],
  expectedExitCode: 0,
  timeoutMs: 1_000,
};
const probePlan: ProbePlan = {
  schemaVersion: 1,
  family: "feature",
  items: [
    {
      phase: "completion",
      purpose: "acceptance",
      source: "private scorer",
      probe: completionProbe,
    },
  ],
};

describe("versioned held-out completion plans", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retains the exact legacy-v1 format and verifies it only with v1 hashing", () => {
    const legacy = createHeldOutProbePlan(runId, probePlan);

    expect(legacy).toEqual({
      schemaVersion: 1,
      runId,
      family: "feature",
      probes: [
        {
          probe: completionProbe,
          probeHash: "d90b74ad3e0e7947ae7845e67f30643fca0b1d7029c1d73895e4e6175d40d030",
          source: "private scorer",
          integrity: [],
        },
      ],
      digest: "5398c0e7aaea140d35a66f7564e095fe4faac0b0f01e79890394702c50647d75",
    });
    expect(() => validateHeldOutProbePlan(legacy, LEGACY_CANONICAL_HASH_ALGORITHM)).not.toThrow();
    expect(() => validateHeldOutProbePlan(legacy, PORTABLE_CANONICAL_HASH_ALGORITHM)).toThrow(
      /format disagrees with its storage hash algorithm/,
    );
  });

  it("self-identifies portable v2 and never falls back to a relabelled v1 digest", () => {
    const legacy = createHeldOutProbePlan(runId, probePlan);
    const portable = createHeldOutProbePlan(
      runId,
      probePlan,
      {},
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );

    expect(portable).toMatchObject({
      schemaVersion: 2,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      digest: "b4b6a43ee33738a70f42ef11aafd5639ed9b1290ebd73ef027f75a91c531f011",
    });
    expect(() =>
      validateHeldOutProbePlan(portable, PORTABLE_CANONICAL_HASH_ALGORITHM),
    ).not.toThrow();
    expect(() => validateHeldOutProbePlan(portable, LEGACY_CANONICAL_HASH_ALGORITHM)).toThrow(
      /format disagrees with its storage hash algorithm/,
    );

    const relabelledLegacy = HeldOutProbePlanSchema.parse({
      ...legacy,
      schemaVersion: 2,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
    });
    expect(() => validateHeldOutProbePlan(relabelledLegacy)).toThrow(/integrity hash/);
  });

  it("rejects portable probe and plan tampering", () => {
    const portable = createHeldOutProbePlan(
      runId,
      probePlan,
      {},
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );
    const probeTamper = structuredClone(portable);
    const probe = probeTamper.probes[0]?.probe;
    if (probe?.kind !== "command") throw new Error("Expected the held-out command fixture");
    probe.command = "substituted-scorer";
    expect(() => validateHeldOutProbePlan(probeTamper)).toThrow(/probe .* integrity hash/);

    const planTamper = structuredClone(portable);
    planTamper.probes[0]!.source = "substituted source";
    expect(() => validateHeldOutProbePlan(planTamper)).toThrow(/plan failed its integrity hash/);
  });

  it("stays stable under adversarial English, Swedish, and Turkish collation", () => {
    const digests = new Set<string>();
    for (const locale of ["en-US", "sv-SE", "tr-TR"]) {
      const collator = new Intl.Collator(locale);
      const localeCompare = vi
        .spyOn(String.prototype, "localeCompare")
        .mockImplementation(function (this: string, other: string) {
          return collator.compare(String(this), other);
        });
      const portable = createHeldOutProbePlan(
        runId,
        probePlan,
        {},
        PORTABLE_CANONICAL_HASH_ALGORITHM,
      );
      const visible = workerVisibleProbePlan(probePlan, portable);
      const reference = visible.items[0]!.probe;

      digests.add(portable.digest);
      expect(() => validateHeldOutProbePlan(portable)).not.toThrow();
      expect(resolveHeldOutProbes([reference], portable)).toEqual([completionProbe]);
      expect(localeCompare).not.toHaveBeenCalled();
      localeCompare.mockRestore();
    }

    expect(digests).toEqual(
      new Set(["b4b6a43ee33738a70f42ef11aafd5639ed9b1290ebd73ef027f75a91c531f011"]),
    );
  });
});
