import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import {
  BenchmarkAssertionResultSchema,
  BenchmarkAssertionSchema,
  BenchmarkCheckSchema,
  BenchmarkReviewPacketV1Schema,
  BenchmarkReviewPacketV2Schema,
  BenchmarkTaskFamilySchema,
} from "./benchmark.ts";
import { PORTABLE_CANONICAL_HASH_ALGORITHM, canonicalJson, contentHash } from "./canonical.ts";

export const BENCHMARK_DEFECT_CATEGORIES = [
  "correctness",
  "completeness",
  "regression",
  "safety_security",
  "test_quality",
  "maintainability",
  "instruction_adherence",
  "evidence_integrity",
] as const;

export const BENCHMARK_DEFECT_SEVERITIES = ["minor", "major", "critical"] as const;

export const BenchmarkDefectCategorySchema = z.enum(BENCHMARK_DEFECT_CATEGORIES);
export const BenchmarkDefectSeveritySchema = z.enum(BENCHMARK_DEFECT_SEVERITIES);

export const BenchmarkReviewOpaqueIdSchema = z.string().regex(/^packet-[0-9a-f]{32}$/);
export const BenchmarkReviewOpaqueIdV1Schema = BenchmarkReviewOpaqueIdSchema;
export const BenchmarkReviewOpaqueIdV2Schema = z.string().regex(/^packet-[0-9a-f]{32}$/);

const BenchmarkBlindedInterruptionSchema = z.strictObject({
  cause: z.enum(["cancellation", "runtime_shutdown", "timeout"]),
  reason: z.string().min(1),
  childSettlement: z.enum(["confirmed", "unconfirmed"]),
});

export const BenchmarkBlindedReviewPacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  opaqueId: BenchmarkReviewOpaqueIdSchema,
  task: z.strictObject({
    family: BenchmarkTaskFamilySchema,
    prompt: z.string().min(1),
    checks: z.array(BenchmarkCheckSchema).min(1),
    acceptanceCriteria: z.array(BenchmarkAssertionSchema).min(1),
  }),
  outcome: z.strictObject({
    executionStatus: z.enum([
      "completed",
      "blocked",
      "failed",
      "error",
      "interrupted",
      "timed_out",
    ]),
    accepted: z.boolean(),
    scorerVerified: z.boolean(),
    acceptance: z.array(BenchmarkAssertionResultSchema),
    interruption: BenchmarkBlindedInterruptionSchema.optional(),
    limitations: z.array(z.string()),
    failureTrace: z.array(z.string()),
  }),
  reviewPacket: BenchmarkReviewPacketV1Schema,
});
export const BenchmarkBlindedReviewPacketV1Schema = BenchmarkBlindedReviewPacketSchema;

export const BenchmarkBlindedReviewPacketV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  hashAlgorithm: z.literal(PORTABLE_CANONICAL_HASH_ALGORITHM),
  opaqueId: BenchmarkReviewOpaqueIdV2Schema,
  task: BenchmarkBlindedReviewPacketSchema.shape.task,
  outcome: BenchmarkBlindedReviewPacketSchema.shape.outcome,
  reviewPacket: BenchmarkReviewPacketV2Schema,
});

function exactOrderedValues<T extends string>(expected: readonly T[]) {
  return z.array(z.string()).superRefine((values, context) => {
    if (contentHash(values) !== contentHash(expected)) {
      context.addIssue({
        code: "custom",
        message: `Expected the exact ordered values: ${expected.join(", ")}`,
      });
    }
  });
}

function exactPortableOrderedValues<T extends string>(expected: readonly T[]) {
  return z.array(z.string()).superRefine((values, context) => {
    if (
      contentHash(values, PORTABLE_CANONICAL_HASH_ALGORITHM) !==
      contentHash(expected, PORTABLE_CANONICAL_HASH_ALGORITHM)
    ) {
      context.addIssue({
        code: "custom",
        message: `Expected the exact ordered values: ${expected.join(", ")}`,
      });
    }
  });
}

export const BenchmarkBlindedReviewExportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    reviewPolicy: z.literal("opaque_blinded_review_v1"),
    rawReportSha256: z.string().regex(/^[0-9a-f]{64}$/),
    blindingKeyDigest: z.string().regex(/^[0-9a-f]{64}$/),
    suite: z.strictObject({
      id: z.string().min(1),
      version: z.number().int().positive(),
      digest: z.string().min(1),
    }),
    taxonomy: z.strictObject({
      version: z.literal(1),
      categories: exactOrderedValues(BENCHMARK_DEFECT_CATEGORIES),
      severities: exactOrderedValues(BENCHMARK_DEFECT_SEVERITIES),
    }),
    packets: z.array(BenchmarkBlindedReviewPacketSchema).min(1),
  })
  .superRefine((artifact, context) => {
    const ids = artifact.packets.map(({ opaqueId }) => opaqueId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["packets"],
        message: "Blinded benchmark packet IDs must be unique",
      });
    }
    if (ids.some((id, index) => index > 0 && id < ids[index - 1]!)) {
      context.addIssue({
        code: "custom",
        path: ["packets"],
        message: "Blinded benchmark packets must be sorted by opaque ID",
      });
    }
  });
export const BenchmarkBlindedReviewExportV1Schema = BenchmarkBlindedReviewExportSchema;

export const BenchmarkBlindedReviewExportV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    hashAlgorithm: z.literal(PORTABLE_CANONICAL_HASH_ALGORITHM),
    reviewPolicy: z.literal("opaque_blinded_review_v2"),
    rawReportSha256: z.string().regex(/^[0-9a-f]{64}$/),
    blindingKeyDigest: z.string().regex(/^[0-9a-f]{64}$/),
    suite: z.strictObject({
      id: z.string().min(1),
      version: z.number().int().positive(),
      digest: z.string().min(1),
    }),
    taxonomy: z.strictObject({
      version: z.literal(1),
      categories: exactPortableOrderedValues(BENCHMARK_DEFECT_CATEGORIES),
      severities: exactPortableOrderedValues(BENCHMARK_DEFECT_SEVERITIES),
    }),
    packets: z.array(BenchmarkBlindedReviewPacketV2Schema).min(1),
  })
  .superRefine((artifact, context) => {
    const ids = artifact.packets.map(({ opaqueId }) => opaqueId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["packets"],
        message: "Blinded benchmark packet IDs must be unique",
      });
    }
    if (ids.some((id, index) => index > 0 && id < ids[index - 1]!)) {
      context.addIssue({
        code: "custom",
        path: ["packets"],
        message: "Blinded benchmark packets must be sorted by opaque ID",
      });
    }
  });

export const BenchmarkDefectSchema = z.strictObject({
  category: BenchmarkDefectCategorySchema,
  severity: BenchmarkDefectSeveritySchema,
  summary: z.string().trim().min(1).max(4_096),
});

export const BenchmarkTrialReviewLabelSchema = z
  .strictObject({
    opaqueId: BenchmarkReviewOpaqueIdSchema,
    packetDigest: z.string().regex(/^[0-9a-f]{64}$/),
    reviewed: z.literal(true),
    reviewerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    verdict: z.enum(["no_defect", "defect"]),
    defects: z.array(BenchmarkDefectSchema),
  })
  .superRefine((label, context) => {
    if (label.verdict === "no_defect" && label.defects.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["defects"],
        message: "A no-defect review label cannot contain defects",
      });
    }
    if (label.verdict === "defect" && label.defects.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["defects"],
        message: "A defect review label must contain at least one defect",
      });
    }
    const defectKeys = label.defects.map(
      ({ category, severity, summary }) => `${category}\0${severity}\0${summary}`,
    );
    if (new Set(defectKeys).size !== defectKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["defects"],
        message: "A review label cannot repeat the same defect",
      });
    }
  });
export const BenchmarkTrialReviewLabelV1Schema = BenchmarkTrialReviewLabelSchema;
export const BenchmarkTrialReviewLabelV2Schema = BenchmarkTrialReviewLabelSchema;

export const BenchmarkReviewLabelsSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    reviewPolicy: z.literal("opaque_blinded_review_v1"),
    taxonomyVersion: z.literal(1),
    rawReportSha256: z.string().regex(/^[0-9a-f]{64}$/),
    blindingKeyDigest: z.string().regex(/^[0-9a-f]{64}$/),
    blindedReviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
    labels: z.array(BenchmarkTrialReviewLabelSchema).min(1),
  })
  .superRefine((artifact, context) => {
    const ids = artifact.labels.map(({ opaqueId }) => opaqueId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["labels"],
        message: "A benchmark review artifact must contain one label per opaque ID",
      });
    }
  });
export const BenchmarkReviewLabelsV1Schema = BenchmarkReviewLabelsSchema;

export const BenchmarkReviewLabelsV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    hashAlgorithm: z.literal(PORTABLE_CANONICAL_HASH_ALGORITHM),
    reviewPolicy: z.literal("opaque_blinded_review_v2"),
    taxonomyVersion: z.literal(1),
    rawReportSha256: z.string().regex(/^[0-9a-f]{64}$/),
    blindingKeyDigest: z.string().regex(/^[0-9a-f]{64}$/),
    blindedReviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
    labels: z.array(BenchmarkTrialReviewLabelV2Schema).min(1),
  })
  .superRefine((artifact, context) => {
    const ids = artifact.labels.map(({ opaqueId }) => opaqueId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["labels"],
        message: "A benchmark review artifact must contain one label per opaque ID",
      });
    }
  });

function benchmarkBlindingKey(value: Uint8Array): Uint8Array {
  if (value.byteLength !== 32)
    throw new Error("A benchmark blinding key must contain exactly 32 bytes");
  return value;
}

export function benchmarkBlindingKeyDigest(blindingKey: Uint8Array): string {
  return createHash("sha256")
    .update("graphcraft-benchmark-blinding-key-v1\0", "utf8")
    .update(benchmarkBlindingKey(blindingKey))
    .digest("hex");
}

export function benchmarkReviewOpaqueId(
  rawReportSha256: string,
  trialId: string,
  blindingKey: Uint8Array,
): string {
  const digest = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .parse(rawReportSha256);
  const trial = z.string().min(1).parse(trialId);
  return BenchmarkReviewOpaqueIdSchema.parse(
    `packet-${createHmac("sha256", benchmarkBlindingKey(blindingKey))
      .update(
        canonicalJson({
          namespace: "graphcraft-benchmark-review-packet-v1",
          rawReportSha256: digest,
          trialId: trial,
        }),
        "utf8",
      )
      .digest("hex")
      .slice(0, 32)}`,
  );
}

export const benchmarkReviewOpaqueIdV1 = benchmarkReviewOpaqueId;

export function benchmarkReviewOpaqueIdV2(
  rawReportSha256: string,
  trialId: string,
  blindingKey: Uint8Array,
): string {
  const digest = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .parse(rawReportSha256);
  const trial = z.string().min(1).parse(trialId);
  return BenchmarkReviewOpaqueIdV2Schema.parse(
    `packet-${createHmac("sha256", benchmarkBlindingKey(blindingKey))
      .update(
        canonicalJson(
          {
            namespace: "graphcraft-benchmark-review-packet-v2",
            schemaVersion: 2,
            hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
            rawReportSha256: digest,
            trialId: trial,
          },
          PORTABLE_CANONICAL_HASH_ALGORITHM,
        ),
        "utf8",
      )
      .digest("hex")
      .slice(0, 32)}`,
  );
}

export type BenchmarkBlindedReviewPacket = z.infer<typeof BenchmarkBlindedReviewPacketSchema>;
export type BenchmarkBlindedReviewPacketV1 = z.infer<typeof BenchmarkBlindedReviewPacketV1Schema>;
export type BenchmarkBlindedReviewPacketV2 = z.infer<typeof BenchmarkBlindedReviewPacketV2Schema>;
export type BenchmarkBlindedReviewExport = z.infer<typeof BenchmarkBlindedReviewExportSchema>;
export type BenchmarkBlindedReviewExportV1 = z.infer<typeof BenchmarkBlindedReviewExportV1Schema>;
export type BenchmarkBlindedReviewExportV2 = z.infer<typeof BenchmarkBlindedReviewExportV2Schema>;
export type BenchmarkDefect = z.infer<typeof BenchmarkDefectSchema>;
export type BenchmarkTrialReviewLabel = z.infer<typeof BenchmarkTrialReviewLabelSchema>;
export type BenchmarkTrialReviewLabelV1 = z.infer<typeof BenchmarkTrialReviewLabelV1Schema>;
export type BenchmarkTrialReviewLabelV2 = z.infer<typeof BenchmarkTrialReviewLabelV2Schema>;
export type BenchmarkReviewLabels = z.infer<typeof BenchmarkReviewLabelsSchema>;
export type BenchmarkReviewLabelsV1 = z.infer<typeof BenchmarkReviewLabelsV1Schema>;
export type BenchmarkReviewLabelsV2 = z.infer<typeof BenchmarkReviewLabelsV2Schema>;
