import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BENCHMARK_DEFECT_CATEGORIES,
  BENCHMARK_DEFECT_SEVERITIES,
  BenchmarkBlindedReviewExportSchema,
  BenchmarkBlindedReviewExportV1Schema,
  BenchmarkBlindedReviewExportV2Schema,
  BenchmarkBlindedReviewPacketSchema,
  BenchmarkBlindedReviewPacketV1Schema,
  BenchmarkBlindedReviewPacketV2Schema,
  BenchmarkReviewLabelsSchema,
  BenchmarkReviewLabelsV1Schema,
  BenchmarkReviewLabelsV2Schema,
  BenchmarkReviewPacketV1Schema,
  BenchmarkReviewPacketV2Schema,
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  benchmarkBlindingKeyDigest,
  benchmarkReviewEvidenceDigest,
  benchmarkReviewOpaqueId,
  benchmarkReviewOpaqueIdV1,
  benchmarkReviewOpaqueIdV2,
  contentHash,
} from "./index.ts";

const rawReportSha256 = "ab".repeat(32);
const blindingKey = Uint8Array.from({ length: 32 }, (_, index) => index);

const task = {
  family: "feature" as const,
  prompt: "Implement the portable publication fixture",
  checks: [
    {
      command: "node",
      scorerPath: "score.mjs",
      args: [],
      expectedExitCode: 0,
      timeoutMs: 300_000,
    },
  ],
  acceptanceCriteria: [{ kind: "exists" as const, path: "result.js" }],
};

const outcome = {
  executionStatus: "completed" as const,
  accepted: true,
  scorerVerified: true,
  acceptance: [{ path: "result.js", passed: true, summary: "Fixture passed" }],
  limitations: [],
  failureTrace: [],
};

function reviewEvidence(
  packetSchemaVersion: 1 | 2,
  mediaType: "text/x-diff" | "application/x-ndjson",
  text: string,
) {
  const identity = {
    mediaType,
    text,
    observedBytes: new TextEncoder().encode(text).byteLength,
    omittedBytes: 0,
    truncated: false,
  };
  return {
    ...identity,
    retainedBytes: identity.observedBytes,
    digest: benchmarkReviewEvidenceDigest(identity, packetSchemaVersion),
  };
}

function reviewPacketV1() {
  return BenchmarkReviewPacketV1Schema.parse({
    schemaVersion: 1,
    patch: reviewEvidence(1, "text/x-diff", "diff --git a/result.js b/result.js\n"),
    transcript: reviewEvidence(1, "application/x-ndjson", '{"type":"result"}\n'),
    captureFailures: [],
  });
}

function reviewPacketV2() {
  return BenchmarkReviewPacketV2Schema.parse({
    schemaVersion: 2,
    hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
    patch: reviewEvidence(2, "text/x-diff", "diff --git a/result.js b/result.js\n"),
    transcript: reviewEvidence(2, "application/x-ndjson", '{"type":"result"}\n'),
    captureFailures: [],
  });
}

function blindedPacketV1() {
  return BenchmarkBlindedReviewPacketV1Schema.parse({
    schemaVersion: 1,
    opaqueId: benchmarkReviewOpaqueId(rawReportSha256, "trial-İ-ä", blindingKey),
    task,
    outcome,
    reviewPacket: reviewPacketV1(),
  });
}

function blindedPacketV2() {
  return BenchmarkBlindedReviewPacketV2Schema.parse({
    schemaVersion: 2,
    hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
    opaqueId: benchmarkReviewOpaqueIdV2(rawReportSha256, "trial-İ-ä", blindingKey),
    task,
    outcome,
    reviewPacket: reviewPacketV2(),
  });
}

function blindedExportV1() {
  return BenchmarkBlindedReviewExportV1Schema.parse({
    schemaVersion: 1,
    reviewPolicy: "opaque_blinded_review_v1",
    rawReportSha256,
    blindingKeyDigest: benchmarkBlindingKeyDigest(blindingKey),
    suite: { id: "publication-fixture", version: 1, digest: "suite-digest" },
    taxonomy: {
      version: 1,
      categories: [...BENCHMARK_DEFECT_CATEGORIES],
      severities: [...BENCHMARK_DEFECT_SEVERITIES],
    },
    packets: [blindedPacketV1()],
  });
}

function blindedExportV2() {
  return BenchmarkBlindedReviewExportV2Schema.parse({
    schemaVersion: 2,
    hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
    reviewPolicy: "opaque_blinded_review_v2",
    rawReportSha256,
    blindingKeyDigest: benchmarkBlindingKeyDigest(blindingKey),
    suite: { id: "publication-fixture", version: 1, digest: "suite-digest" },
    taxonomy: {
      version: 1,
      categories: [...BENCHMARK_DEFECT_CATEGORIES],
      severities: [...BENCHMARK_DEFECT_SEVERITIES],
    },
    packets: [blindedPacketV2()],
  });
}

function reviewLabelsV1() {
  const blinded = blindedExportV1();
  return BenchmarkReviewLabelsV1Schema.parse({
    schemaVersion: 1,
    reviewPolicy: "opaque_blinded_review_v1",
    taxonomyVersion: 1,
    rawReportSha256,
    blindingKeyDigest: benchmarkBlindingKeyDigest(blindingKey),
    blindedReviewDigest: contentHash(blinded),
    labels: [
      {
        opaqueId: blinded.packets[0]!.opaqueId,
        packetDigest: contentHash(blinded.packets[0]),
        reviewed: true,
        reviewerId: "reviewer-a",
        verdict: "no_defect",
        defects: [],
      },
    ],
  });
}

function reviewLabelsV2() {
  const blinded = blindedExportV2();
  return BenchmarkReviewLabelsV2Schema.parse({
    schemaVersion: 2,
    hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
    reviewPolicy: "opaque_blinded_review_v2",
    taxonomyVersion: 1,
    rawReportSha256,
    blindingKeyDigest: benchmarkBlindingKeyDigest(blindingKey),
    blindedReviewDigest: contentHash(blinded, PORTABLE_CANONICAL_HASH_ALGORITHM),
    labels: [
      {
        opaqueId: blinded.packets[0]!.opaqueId,
        packetDigest: contentHash(blinded.packets[0], PORTABLE_CANONICAL_HASH_ALGORITHM),
        reviewed: true,
        reviewerId: "reviewer-a",
        verdict: "no_defect",
        defects: [],
      },
    ],
  });
}

describe("versioned benchmark publication identities", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps every generic publication export and opaque-ID helper on strict v1", () => {
    expect(BenchmarkBlindedReviewPacketSchema).toBe(BenchmarkBlindedReviewPacketV1Schema);
    expect(BenchmarkBlindedReviewExportSchema).toBe(BenchmarkBlindedReviewExportV1Schema);
    expect(BenchmarkReviewLabelsSchema).toBe(BenchmarkReviewLabelsV1Schema);
    expect(benchmarkReviewOpaqueIdV1).toBe(benchmarkReviewOpaqueId);

    expect(benchmarkReviewOpaqueId(rawReportSha256, "trial-İ-ä", blindingKey)).toBe(
      "packet-8598325007abf8e048cf006772614054",
    );
    expect(benchmarkBlindingKeyDigest(blindingKey)).toBe(
      "1ada9fb4c3f0f1cc5cd98c74d03a70d3c3cb885fc044febca7aa61b14d6bff3d",
    );
    expect(BenchmarkBlindedReviewExportSchema.parse(blindedExportV1())).toEqual(blindedExportV1());
    expect(BenchmarkReviewLabelsSchema.parse(reviewLabelsV1())).toEqual(reviewLabelsV1());
  });

  it("derives deterministic v2 opaque IDs from a distinct portable identity", () => {
    const portable = benchmarkReviewOpaqueIdV2(rawReportSha256, "trial-İ-ä", blindingKey);

    expect(portable).toBe("packet-5bd84b20041b2bf892ceeceacac8b2e2");
    expect(benchmarkReviewOpaqueIdV2(rawReportSha256, "trial-İ-ä", blindingKey)).toBe(portable);
    expect(portable).not.toBe(benchmarkReviewOpaqueId(rawReportSha256, "trial-İ-ä", blindingKey));

    vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
      this: string,
      other: string,
    ) {
      return String(this) < other ? 1 : String(this) > other ? -1 : 0;
    });

    expect(benchmarkReviewOpaqueIdV2(rawReportSha256, "trial-İ-ä", blindingKey)).toBe(portable);
  });

  it("binds v2 packet, export, and label artifacts to portable identities", () => {
    const packet = blindedPacketV2();
    const blinded = blindedExportV2();
    const labels = reviewLabelsV2();

    expect(BenchmarkBlindedReviewPacketV2Schema.parse(packet)).toEqual(packet);
    expect(BenchmarkBlindedReviewExportV2Schema.parse(blinded)).toEqual(blinded);
    expect(BenchmarkReviewLabelsV2Schema.parse(labels)).toEqual(labels);
    expect(blinded).toMatchObject({
      schemaVersion: 2,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      reviewPolicy: "opaque_blinded_review_v2",
      rawReportSha256,
      blindingKeyDigest: benchmarkBlindingKeyDigest(blindingKey),
      taxonomy: { version: 1 },
    });
    expect(labels).toMatchObject({
      schemaVersion: 2,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      reviewPolicy: "opaque_blinded_review_v2",
      taxonomyVersion: 1,
    });
  });

  it("rejects cross-version relabelling, alternate algorithms, and schema growth", () => {
    const packetV1 = blindedPacketV1();
    const packetV2 = blindedPacketV2();
    const exportV1 = blindedExportV1();
    const exportV2 = blindedExportV2();
    const labelsV1 = reviewLabelsV1();
    const labelsV2 = reviewLabelsV2();

    expect(() => BenchmarkBlindedReviewPacketSchema.parse(packetV2)).toThrow();
    expect(() => BenchmarkBlindedReviewPacketV2Schema.parse(packetV1)).toThrow();
    expect(() =>
      BenchmarkBlindedReviewPacketV2Schema.parse({
        ...packetV2,
        reviewPacket: reviewPacketV1(),
      }),
    ).toThrow();
    expect(() => BenchmarkBlindedReviewExportSchema.parse(exportV2)).toThrow();
    expect(() => BenchmarkBlindedReviewExportV2Schema.parse(exportV1)).toThrow();
    expect(() => BenchmarkReviewLabelsSchema.parse(labelsV2)).toThrow();
    expect(() => BenchmarkReviewLabelsV2Schema.parse(labelsV1)).toThrow();
    expect(() =>
      BenchmarkBlindedReviewExportV2Schema.parse({
        ...exportV2,
        hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
      }),
    ).toThrow();
    expect(() =>
      BenchmarkBlindedReviewExportV2Schema.parse({ ...exportV2, unexpected: true }),
    ).toThrow();
    expect(() =>
      BenchmarkBlindedReviewExportV2Schema.parse({
        ...exportV2,
        taxonomy: {
          ...exportV2.taxonomy,
          categories: [...exportV2.taxonomy.categories].reverse(),
        },
      }),
    ).toThrow(/exact ordered values/u);
  });
});
