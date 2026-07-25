import { z } from "zod";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  contentHash,
} from "./canonical.ts";
import { TokenUsageSchema } from "./schemas.ts";

export const MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS = 2_147_483_647;

export const BenchmarkTaskFamilySchema = z.enum([
  "bug",
  "feature",
  "migration",
  "refactor",
  "audit",
  "pr_repair",
]);

export const BenchmarkAssertionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("summary_contains"), value: z.string().min(1) }),
  z.strictObject({ kind: z.literal("exists"), path: z.string().min(1) }),
  z.strictObject({ kind: z.literal("absent"), path: z.string().min(1) }),
  z.strictObject({ kind: z.literal("contains"), path: z.string().min(1), value: z.string() }),
  z.strictObject({ kind: z.literal("not_contains"), path: z.string().min(1), value: z.string() }),
  z.strictObject({ kind: z.literal("equals"), path: z.string().min(1), value: z.string() }),
]);

export const BenchmarkCheckSchema = z.strictObject({
  command: z.string().min(1),
  scorerPath: z.string().min(1),
  args: z.array(z.string()).default([]),
  expectedExitCode: z.number().int().default(0),
  timeoutMs: z.number().int().positive().default(300_000),
});

export const BenchmarkTaskSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    family: BenchmarkTaskFamilySchema,
    task: z.string().min(1),
    finishLine: z.literal("local_verified").default("local_verified"),
    initialFiles: z
      .record(z.string().min(1), z.string())
      .refine((value) => Object.keys(value).length > 0),
    checks: z.array(BenchmarkCheckSchema).min(1),
    acceptance: z.array(BenchmarkAssertionSchema).min(1),
    repetitions: z.number().int().positive().default(3),
  })
  .superRefine((task, context) => {
    for (const [index, check] of task.checks.entries()) {
      if (!Object.hasOwn(task.initialFiles, check.scorerPath)) {
        context.addIssue({
          code: "custom",
          path: ["checks", index, "scorerPath"],
          message: "Benchmark scorers must name an immutable initial fixture file",
        });
      }
    }
  });

export const BenchmarkSuiteSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    version: z.number().int().positive(),
    description: z.string().min(1),
    tasks: z.array(BenchmarkTaskSchema).min(1),
  })
  .superRefine((suite, context) => {
    const taskIds = new Set<string>();
    for (const [index, task] of suite.tasks.entries()) {
      if (taskIds.has(task.id)) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "id"],
          message: "Benchmark task IDs must be unique",
        });
      }
      taskIds.add(task.id);
    }
  });

const BenchmarkScheduleEntryShape = {
  trialId: z.string().min(1),
  order: z.number().int().nonnegative(),
  taskId: z.string().min(1),
  family: BenchmarkTaskFamilySchema,
  host: z.enum(["codex", "claude"]),
  mode: z.enum(["baseline", "graphcraft"]),
  repetition: z.number().int().positive(),
  seed: z.string().min(1),
};

export const BenchmarkScheduleEntryV2Schema = z.strictObject(BenchmarkScheduleEntryShape);
export const BenchmarkScheduleEntryV3Schema = z.strictObject(BenchmarkScheduleEntryShape);
export const BenchmarkScheduleEntryV4Schema = z.strictObject(BenchmarkScheduleEntryShape);
export const BenchmarkScheduleEntrySchema = BenchmarkScheduleEntryV3Schema;

export const BenchmarkReportIdentityPolicySchema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({
    schemaVersion: z.literal(2),
    hashAlgorithm: z.literal(LEGACY_CANONICAL_HASH_ALGORITHM),
  }),
  z.strictObject({
    schemaVersion: z.literal(3),
    hashAlgorithm: z.literal(LEGACY_CANONICAL_HASH_ALGORITHM),
  }),
  z.strictObject({
    schemaVersion: z.literal(4),
    hashAlgorithm: z.literal(PORTABLE_CANONICAL_HASH_ALGORITHM),
  }),
]);
export type BenchmarkReportIdentityPolicy = z.infer<typeof BenchmarkReportIdentityPolicySchema>;

export const BenchmarkAssertionResultSchema = z.strictObject({
  path: z.string().min(1),
  passed: z.boolean(),
  summary: z.string().min(1),
});

export const BenchmarkModelPolicySchema = z
  .strictObject({
    codex: z.string().min(1).optional(),
    claude: z.string().min(1).optional(),
  })
  .refine((value) => value.codex !== undefined || value.claude !== undefined, {
    message: "At least one benchmark model policy is required",
  });

const BenchmarkEffortPolicySchema = z.enum(["low", "medium", "high", "xhigh"]);

export const BenchmarkPermissionPolicySchema = z.enum([
  "codex_workspace_write_shell_external_not_graphcraft_enforced",
  "claude_accept_edits_bash_external_not_graphcraft_enforced",
]);

export const BenchmarkPermissionPoliciesSchema = z
  .strictObject({
    codex: BenchmarkPermissionPolicySchema.optional(),
    claude: BenchmarkPermissionPolicySchema.optional(),
  })
  .refine((value) => value.codex !== undefined || value.claude !== undefined, {
    message: "At least one benchmark permission policy is required",
  });

export const BenchmarkSourceIdentitySchema = z
  .strictObject({
    commitSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    dirty: z.boolean(),
    dirtyStatusDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .superRefine((identity, context) => {
    if (identity.dirty !== (identity.dirtyStatusDigest !== null)) {
      context.addIssue({
        code: "custom",
        path: ["dirtyStatusDigest"],
        message: "Dirty benchmark source identity must include a status digest",
      });
    }
  });

export const BENCHMARK_REVIEW_PATCH_LIMIT_BYTES = 128 * 1024;
export const BENCHMARK_REVIEW_TRANSCRIPT_LIMIT_BYTES = 64 * 1024;

export interface BenchmarkReviewEvidenceDigestInput {
  mediaType: "text/x-diff" | "application/x-ndjson";
  text: string;
  observedBytes: number;
  omittedBytes: number;
  truncated: boolean;
}

export function benchmarkReviewEvidenceDigest(
  evidence: BenchmarkReviewEvidenceDigestInput,
  packetSchemaVersion: 1 | 2 = 1,
): string {
  const identity = {
    mediaType: evidence.mediaType,
    text: evidence.text,
    observedBytes: evidence.observedBytes,
    omittedBytes: evidence.omittedBytes,
    truncated: evidence.truncated,
  };
  if (packetSchemaVersion === 1) return contentHash(identity, LEGACY_CANONICAL_HASH_ALGORITHM);
  if (packetSchemaVersion === 2)
    return contentHash(
      {
        namespace: "graphcraft-benchmark-review-evidence-v2",
        schemaVersion: 2,
        hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
        ...identity,
      },
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );
  throw new Error(`Unsupported benchmark review packet schema version: ${packetSchemaVersion}`);
}

function benchmarkReviewEvidenceSchema(packetSchemaVersion: 1 | 2) {
  return z
    .strictObject({
      mediaType: z.enum(["text/x-diff", "application/x-ndjson"]),
      text: z.string(),
      observedBytes: z.number().int().nonnegative(),
      retainedBytes: z.number().int().nonnegative(),
      omittedBytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .superRefine((evidence, context) => {
      const retainedBytes = new TextEncoder().encode(evidence.text).byteLength;
      const limit =
        evidence.mediaType === "text/x-diff"
          ? BENCHMARK_REVIEW_PATCH_LIMIT_BYTES
          : BENCHMARK_REVIEW_TRANSCRIPT_LIMIT_BYTES;
      if (retainedBytes > limit) {
        context.addIssue({
          code: "custom",
          path: ["retainedBytes"],
          message: `Benchmark review evidence exceeds its ${limit}-byte retained limit`,
        });
      }
      if (retainedBytes !== evidence.retainedBytes) {
        context.addIssue({
          code: "custom",
          path: ["retainedBytes"],
          message: "Benchmark review evidence retained-byte count does not match its text",
        });
      }
      if (evidence.truncated !== evidence.omittedBytes > 0) {
        context.addIssue({
          code: "custom",
          path: ["truncated"],
          message: "Benchmark review evidence truncation metadata is inconsistent",
        });
      }
      if (evidence.digest !== benchmarkReviewEvidenceDigest(evidence, packetSchemaVersion)) {
        context.addIssue({
          code: "custom",
          path: ["digest"],
          message: "Benchmark review evidence digest does not match its retained content",
        });
      }
    });
}

const BenchmarkReviewEvidenceV1Schema = benchmarkReviewEvidenceSchema(1);
const BenchmarkReviewEvidenceV2Schema = benchmarkReviewEvidenceSchema(2);

export const BenchmarkReviewPacketV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  patch: BenchmarkReviewEvidenceV1Schema,
  transcript: BenchmarkReviewEvidenceV1Schema,
  captureFailures: z.array(z.string().min(1)),
});

export const BenchmarkReviewPacketV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  hashAlgorithm: z.literal(PORTABLE_CANONICAL_HASH_ALGORITHM),
  patch: BenchmarkReviewEvidenceV2Schema,
  transcript: BenchmarkReviewEvidenceV2Schema,
  captureFailures: z.array(z.string().min(1)),
});

export const BenchmarkReviewPacketSchema = z.discriminatedUnion("schemaVersion", [
  BenchmarkReviewPacketV1Schema,
  BenchmarkReviewPacketV2Schema,
]);

export const BenchmarkTrialResultV2Schema = z
  .strictObject({
    trial: BenchmarkScheduleEntryV2Schema,
    hostVersion: z.string().min(1),
    modelPolicy: z.string().min(1),
    effortPolicy: BenchmarkEffortPolicySchema,
    permissionPolicy: BenchmarkPermissionPolicySchema,
    acceptanceScorerDigest: z.string().min(1),
    observedScorerDigest: z.string().min(1),
    scorerVerified: z.boolean(),
    repositoryDigest: z.string().min(1),
    baseSha: z.string().min(1),
    executionStatus: z.enum(["completed", "blocked", "failed", "error"]),
    accepted: z.boolean(),
    acceptance: z.array(BenchmarkAssertionResultSchema),
    usage: TokenUsageSchema,
    usageReconciled: z.boolean(),
    limitations: z.array(z.string()),
    durationMs: z.number().int().nonnegative(),
    humanInterventions: z.number().int().nonnegative(),
    failureTrace: z.array(z.string()),
    reviewPacket: BenchmarkReviewPacketV1Schema.optional(),
  })
  .superRefine((result, context) => {
    if (result.accepted && (result.reviewPacket?.captureFailures.length ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        path: ["accepted"],
        message:
          "A trial with review-packet capture failures cannot be accepted as review-complete",
      });
    }
    if (result.accepted && result.reviewPacket?.patch.truncated) {
      context.addIssue({
        code: "custom",
        path: ["accepted"],
        message: "A trial with truncated patch evidence cannot be accepted as review-complete",
      });
    }
    if (result.accepted && result.reviewPacket?.transcript.truncated) {
      context.addIssue({
        code: "custom",
        path: ["accepted"],
        message: "A trial with truncated transcript evidence cannot be accepted as review-complete",
      });
    }
  });

function benchmarkSettledTrialResultSchema<
  TTrial extends z.ZodType,
  TReviewPacket extends z.ZodType<
    | z.infer<typeof BenchmarkReviewPacketV1Schema>
    | z.infer<typeof BenchmarkReviewPacketV2Schema>
    | undefined
  >,
>(trial: TTrial, reviewPacket: TReviewPacket) {
  return z
    .strictObject({
      trial,
      hostVersion: z.string().min(1),
      modelPolicy: z.string().min(1),
      effortPolicy: BenchmarkEffortPolicySchema,
      permissionPolicy: BenchmarkPermissionPolicySchema,
      acceptanceScorerDigest: z.string().min(1),
      observedScorerDigest: z.string().min(1),
      scorerVerified: z.boolean(),
      repositoryDigest: z.string().min(1),
      baseSha: z.string().min(1),
      executionStatus: z.enum([
        "completed",
        "blocked",
        "failed",
        "error",
        "interrupted",
        "timed_out",
      ]),
      attemptCheckpoint: z.enum(["provisional", "settled"]),
      interruption: z
        .strictObject({
          cause: z.enum(["cancellation", "runtime_shutdown", "timeout"]),
          reason: z.string().min(1),
          childSettlement: z.enum(["confirmed", "unconfirmed"]),
        })
        .optional(),
      recovery: z
        .strictObject({
          disposition: z.literal("preserved"),
          fixtureRepository: z.string().min(1),
          lastKnownRepository: z.string().min(1),
          requiredAction: z.literal("reconcile_child_before_cleanup_or_resume"),
        })
        .optional(),
      accepted: z.boolean(),
      acceptance: z.array(BenchmarkAssertionResultSchema),
      usage: TokenUsageSchema,
      usageReconciled: z.boolean(),
      limitations: z.array(z.string()),
      durationMs: z.number().int().nonnegative(),
      humanInterventions: z.number().int().nonnegative(),
      failureTrace: z.array(z.string()),
      reviewPacket,
    })
    .superRefine((result, context) => {
      const reviewPacket = (
        result as {
          reviewPacket?:
            | z.infer<typeof BenchmarkReviewPacketV1Schema>
            | z.infer<typeof BenchmarkReviewPacketV2Schema>;
        }
      ).reviewPacket;
      const interrupted = ["interrupted", "timed_out"].includes(result.executionStatus);
      if (interrupted !== (result.interruption !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["interruption"],
          message: "Interrupted benchmark results must retain their interruption evidence",
        });
      }
      if (result.executionStatus === "timed_out" && result.interruption?.cause !== "timeout") {
        context.addIssue({
          code: "custom",
          path: ["interruption", "cause"],
          message: "Timed-out benchmark results must retain a timeout cause",
        });
      }
      if (result.executionStatus === "interrupted" && result.interruption?.cause === "timeout") {
        context.addIssue({
          code: "custom",
          path: ["interruption", "cause"],
          message: "Timeout interruptions must use the timed_out execution status",
        });
      }
      if (result.attemptCheckpoint === "provisional" && result.accepted) {
        context.addIssue({
          code: "custom",
          path: ["accepted"],
          message: "A provisional benchmark attempt cannot be accepted",
        });
      }
      if (
        result.attemptCheckpoint === "provisional" &&
        result.interruption?.childSettlement !== "unconfirmed"
      ) {
        context.addIssue({
          code: "custom",
          path: ["interruption"],
          message: "A provisional benchmark attempt must retain unconfirmed settlement evidence",
        });
      }
      const unconfirmed = result.interruption?.childSettlement === "unconfirmed";
      if (unconfirmed !== (result.recovery !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["recovery"],
          message:
            "Unconfirmed benchmark calls must retain the preserved workspace recovery receipt",
        });
      }
      if (unconfirmed && result.accepted) {
        context.addIssue({
          code: "custom",
          path: ["accepted"],
          message: "A benchmark attempt with unconfirmed child settlement cannot be accepted",
        });
      }
      if (result.accepted && (reviewPacket?.captureFailures.length ?? 0) > 0) {
        context.addIssue({
          code: "custom",
          path: ["accepted"],
          message:
            "A trial with review-packet capture failures cannot be accepted as review-complete",
        });
      }
      if (result.accepted && reviewPacket?.patch.truncated) {
        context.addIssue({
          code: "custom",
          path: ["accepted"],
          message: "A trial with truncated patch evidence cannot be accepted as review-complete",
        });
      }
      if (result.accepted && reviewPacket?.transcript.truncated) {
        context.addIssue({
          code: "custom",
          path: ["accepted"],
          message:
            "A trial with truncated transcript evidence cannot be accepted as review-complete",
        });
      }
    });
}

export const BenchmarkTrialResultV3Schema = benchmarkSettledTrialResultSchema(
  BenchmarkScheduleEntryV3Schema,
  BenchmarkReviewPacketV1Schema.optional(),
);

export const BenchmarkTrialResultV4Schema = benchmarkSettledTrialResultSchema(
  BenchmarkScheduleEntryV4Schema,
  BenchmarkReviewPacketV2Schema,
);

export const BenchmarkTrialResultSchema = BenchmarkTrialResultV3Schema;
const BenchmarkLegacyTrialResultSchema = z.union([
  BenchmarkTrialResultV2Schema,
  BenchmarkTrialResultV3Schema,
]);

export const BenchmarkHostPreflightCheckpointSchema = z.strictObject({
  host: z.enum(["codex", "claude"]),
  phase: z.literal("capability_probe"),
  attemptCheckpoint: z.enum(["provisional", "settled"]),
  interruption: z.strictObject({
    cause: z.enum(["cancellation", "runtime_shutdown", "timeout"]),
    reason: z.string().min(1),
    childSettlement: z.literal("unconfirmed"),
  }),
  requiredAction: z.literal("reconcile_host_child_before_resume"),
});

function benchmarkTrialId(
  suite: { id: string; version: number },
  seed: string,
  trial: Pick<BenchmarkScheduleEntry, "taskId" | "family" | "host" | "mode" | "repetition">,
  identity: BenchmarkReportIdentityPolicy,
): string {
  const value = {
    suite: suite.id,
    version: suite.version,
    seed,
    taskId: trial.taskId,
    family: trial.family,
    host: trial.host,
    mode: trial.mode,
    repetition: trial.repetition,
  };
  if (identity.schemaVersion !== 4) return contentHash(value, LEGACY_CANONICAL_HASH_ALGORITHM);
  return contentHash(
    {
      namespace: "graphcraft-benchmark-trial-id-v4",
      reportSchemaVersion: identity.schemaVersion,
      hashAlgorithm: identity.hashAlgorithm,
      ...value,
    },
    identity.hashAlgorithm,
  );
}

type BenchmarkSettledReportIdentity = Extract<
  BenchmarkReportIdentityPolicy,
  { schemaVersion: 3 | 4 }
>;

type BenchmarkSettledReportForRefinement = {
  status: "running" | "complete";
  suite: { id: string; version: number };
  seed: string;
  reviewPolicy?:
    "bounded_redacted_patch_and_transcript_v1" | "bounded_redacted_patch_and_transcript_v2";
  environment: {
    graphcraftSource?: z.infer<typeof BenchmarkSourceIdentitySchema>;
  };
  schedule: z.infer<typeof BenchmarkScheduleEntryV3Schema>[];
  results: Array<
    z.infer<typeof BenchmarkTrialResultV3Schema> | z.infer<typeof BenchmarkTrialResultV4Schema>
  >;
  summary: Record<string, unknown>;
  hostPreflightCheckpoint?: z.infer<typeof BenchmarkHostPreflightCheckpointSchema>;
};

function benchmarkSettledReportSchema<TSchema extends z.ZodType>(
  schema: TSchema,
  identity: BenchmarkSettledReportIdentity,
) {
  return schema.superRefine((value, context) => {
    const report = value as BenchmarkSettledReportForRefinement;
    const evidenceBacked = identity.schemaVersion === 4 || report.reviewPolicy !== undefined;
    if (
      identity.schemaVersion === 3 &&
      evidenceBacked &&
      report.environment.graphcraftSource === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["environment", "graphcraftSource"],
        message: "Evidence-backed benchmark reports must bind an exact Graphcraft source identity",
      });
    }
    if (evidenceBacked && report.environment.graphcraftSource?.dirty) {
      context.addIssue({
        code: "custom",
        path: ["environment", "graphcraftSource", "dirty"],
        message: "Evidence-backed benchmark reports require a clean Graphcraft source tree",
      });
    }

    const scheduleByTrialId = new Map<string, z.infer<typeof BenchmarkScheduleEntryV3Schema>>();
    for (const [index, trial] of report.schedule.entries()) {
      if (
        identity.schemaVersion === 4 &&
        (trial.seed !== report.seed ||
          trial.trialId !== benchmarkTrialId(report.suite, report.seed, trial, identity))
      ) {
        context.addIssue({
          code: "custom",
          path: ["schedule", index, "trialId"],
          message: "Benchmark trial ID does not match the declared report identity",
        });
      }
      if (scheduleByTrialId.has(trial.trialId)) {
        context.addIssue({
          code: "custom",
          path: ["schedule", index, "trialId"],
          message: "Benchmark schedule trial IDs must be unique",
        });
      }
      scheduleByTrialId.set(trial.trialId, trial);
    }

    const resultTrialIds = new Set<string>();
    for (const [index, result] of report.results.entries()) {
      const { trial } = result;
      if (resultTrialIds.has(trial.trialId)) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "trial", "trialId"],
          message: "Benchmark result trial IDs must be unique",
        });
      }
      resultTrialIds.add(trial.trialId);

      const scheduled = scheduleByTrialId.get(trial.trialId);
      if (
        scheduled === undefined ||
        contentHash(scheduled, identity.hashAlgorithm) !==
          contentHash(trial, identity.hashAlgorithm)
      ) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "trial"],
          message: "Benchmark result trials must exactly match a scheduled trial",
        });
      }
      if (
        identity.schemaVersion === 3 &&
        report.reviewPolicy !== undefined &&
        result.reviewPacket === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "reviewPacket"],
          message: "Every evidence-backed benchmark result must retain a review packet",
        });
      }
    }

    if (
      report.status === "complete" &&
      (report.results.length !== report.schedule.length ||
        resultTrialIds.size !== scheduleByTrialId.size ||
        [...scheduleByTrialId].some(([trialId]) => !resultTrialIds.has(trialId)))
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "The complete benchmark report does not cover the exact current schedule",
      });
    }
    if (
      report.status === "complete" &&
      report.results.some((result) => result.attemptCheckpoint === "provisional")
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A complete benchmark report cannot retain an in-flight provisional attempt",
      });
    }
    if (
      report.status === "complete" &&
      report.results.some((result) => result.interruption?.childSettlement === "unconfirmed")
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A complete benchmark report cannot retain unconfirmed child settlement",
      });
    }
    if (report.status === "complete" && report.hostPreflightCheckpoint !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A complete benchmark report cannot retain an unfinished host preflight",
      });
    }

    if (
      contentHash(report.summary, identity.hashAlgorithm) !==
      contentHash(
        summarizeBenchmark(report.results, report.schedule, identity),
        identity.hashAlgorithm,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message: "The benchmark report summary does not match its trial evidence",
      });
    }
  });
}

export const BenchmarkReportV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    status: z.enum(["running", "complete"]),
    suite: z.strictObject({
      id: z.string().min(1),
      version: z.number().int().positive(),
      digest: z.string().min(1),
    }),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    seed: z.string().min(1),
    randomized: z.literal(true),
    modelPolicy: BenchmarkModelPolicySchema,
    effortPolicy: BenchmarkEffortPolicySchema,
    permissionPolicy: BenchmarkPermissionPoliciesSchema,
    scorerPolicy: z.literal("fixture_bound_scorers_plus_suite_assertions"),
    reviewPolicy: z.literal("bounded_redacted_patch_and_transcript_v1").optional(),
    environment: z.strictObject({
      platform: z.string().min(1),
      architecture: z.string().min(1),
      nodeVersion: z.string().min(1),
      graphcraftVersion: z.string().trim().min(1),
      graphcraftSource: BenchmarkSourceIdentitySchema.optional(),
    }),
    limitations: z.array(z.string()),
    schedule: z.array(BenchmarkScheduleEntryV2Schema).min(1),
    results: z.array(BenchmarkTrialResultV2Schema),
    summary: z.record(z.string(), z.unknown()),
  })
  .superRefine((report, context) => {
    if (report.reviewPolicy !== undefined && report.environment.graphcraftSource === undefined) {
      context.addIssue({
        code: "custom",
        path: ["environment", "graphcraftSource"],
        message: "Evidence-backed benchmark reports must bind an exact Graphcraft source identity",
      });
    }
    if (report.reviewPolicy !== undefined && report.environment.graphcraftSource?.dirty) {
      context.addIssue({
        code: "custom",
        path: ["environment", "graphcraftSource", "dirty"],
        message: "Evidence-backed benchmark reports require a clean Graphcraft source tree",
      });
    }

    const scheduleByTrialId = new Map<string, BenchmarkScheduleEntry>();
    for (const [index, trial] of report.schedule.entries()) {
      if (scheduleByTrialId.has(trial.trialId)) {
        context.addIssue({
          code: "custom",
          path: ["schedule", index, "trialId"],
          message: "Benchmark schedule trial IDs must be unique",
        });
      }
      scheduleByTrialId.set(trial.trialId, trial);
    }

    const resultTrialIds = new Set<string>();
    for (const [index, result] of report.results.entries()) {
      const { trial } = result;
      if (resultTrialIds.has(trial.trialId)) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "trial", "trialId"],
          message: "Benchmark result trial IDs must be unique",
        });
      }
      resultTrialIds.add(trial.trialId);

      const scheduled = scheduleByTrialId.get(trial.trialId);
      if (
        scheduled === undefined ||
        contentHash(scheduled, LEGACY_CANONICAL_HASH_ALGORITHM) !==
          contentHash(trial, LEGACY_CANONICAL_HASH_ALGORITHM)
      ) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "trial"],
          message: "Benchmark result trials must exactly match a scheduled trial",
        });
      }
      if (report.reviewPolicy !== undefined && result.reviewPacket === undefined) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "reviewPacket"],
          message: "Every evidence-backed benchmark result must retain a review packet",
        });
      }
    }

    if (
      report.status === "complete" &&
      (report.results.length !== report.schedule.length ||
        resultTrialIds.size !== scheduleByTrialId.size ||
        [...scheduleByTrialId].some(([trialId]) => !resultTrialIds.has(trialId)))
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "The complete benchmark report does not cover the exact current schedule",
      });
    }

    if (
      contentHash(report.summary, LEGACY_CANONICAL_HASH_ALGORITHM) !==
      contentHash(
        summarizeBenchmark(report.results, report.schedule, {
          schemaVersion: 2,
          hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
        }),
        LEGACY_CANONICAL_HASH_ALGORITHM,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message: "The benchmark report summary does not match its trial evidence",
      });
    }
  });

export const BenchmarkReportV3Schema = benchmarkSettledReportSchema(
  z.strictObject({
    schemaVersion: z.literal(3),
    status: z.enum(["running", "complete"]),
    suite: z.strictObject({
      id: z.string().min(1),
      version: z.number().int().positive(),
      digest: z.string().min(1),
    }),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    seed: z.string().min(1),
    randomized: z.literal(true),
    modelPolicy: BenchmarkModelPolicySchema,
    effortPolicy: BenchmarkEffortPolicySchema,
    permissionPolicy: BenchmarkPermissionPoliciesSchema,
    scorerPolicy: z.literal("fixture_bound_scorers_plus_suite_assertions"),
    reviewPolicy: z.literal("bounded_redacted_patch_and_transcript_v1").optional(),
    modelCallTimeoutMs: z.number().int().positive().max(MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS),
    hostPreflightCheckpoint: BenchmarkHostPreflightCheckpointSchema.optional(),
    environment: z.strictObject({
      platform: z.string().min(1),
      architecture: z.string().min(1),
      nodeVersion: z.string().min(1),
      graphcraftVersion: z.string().trim().min(1),
      graphcraftSource: BenchmarkSourceIdentitySchema.optional(),
    }),
    limitations: z.array(z.string()),
    schedule: z.array(BenchmarkScheduleEntryV3Schema).min(1),
    results: z.array(BenchmarkTrialResultV3Schema),
    summary: z.record(z.string(), z.unknown()),
  }),
  { schemaVersion: 3, hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM },
);

export const BenchmarkReportV4Schema = benchmarkSettledReportSchema(
  z.strictObject({
    schemaVersion: z.literal(4),
    hashAlgorithm: z.literal(PORTABLE_CANONICAL_HASH_ALGORITHM),
    status: z.enum(["running", "complete"]),
    suite: z.strictObject({
      id: z.string().min(1),
      version: z.number().int().positive(),
      digest: z.string().min(1),
    }),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    seed: z.string().min(1),
    randomized: z.literal(true),
    modelPolicy: BenchmarkModelPolicySchema,
    effortPolicy: BenchmarkEffortPolicySchema,
    permissionPolicy: BenchmarkPermissionPoliciesSchema,
    scorerPolicy: z.literal("fixture_bound_scorers_plus_suite_assertions"),
    reviewPolicy: z.literal("bounded_redacted_patch_and_transcript_v2"),
    modelCallTimeoutMs: z.number().int().positive().max(MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS),
    hostPreflightCheckpoint: BenchmarkHostPreflightCheckpointSchema.optional(),
    environment: z.strictObject({
      platform: z.string().min(1),
      architecture: z.string().min(1),
      nodeVersion: z.string().min(1),
      graphcraftVersion: z.string().trim().min(1),
      graphcraftSource: BenchmarkSourceIdentitySchema,
    }),
    limitations: z.array(z.string()),
    schedule: z.array(BenchmarkScheduleEntryV4Schema).min(1),
    results: z.array(BenchmarkTrialResultV4Schema),
    summary: z.record(z.string(), z.unknown()),
  }),
  { schemaVersion: 4, hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM },
);

export const BenchmarkReportSchema = z.discriminatedUnion("schemaVersion", [
  BenchmarkReportV2Schema,
  BenchmarkReportV3Schema,
  BenchmarkReportV4Schema,
]);

export type BenchmarkTask = z.infer<typeof BenchmarkTaskSchema>;
export type BenchmarkSuite = z.infer<typeof BenchmarkSuiteSchema>;
export type BenchmarkScheduleEntryV2 = z.infer<typeof BenchmarkScheduleEntryV2Schema>;
export type BenchmarkScheduleEntryV3 = z.infer<typeof BenchmarkScheduleEntryV3Schema>;
export type BenchmarkScheduleEntryV4 = z.infer<typeof BenchmarkScheduleEntryV4Schema>;
export type BenchmarkScheduleEntry = z.infer<typeof BenchmarkScheduleEntrySchema>;
export type BenchmarkTrialResultV2 = z.infer<typeof BenchmarkTrialResultV2Schema>;
export type BenchmarkTrialResultV3 = z.infer<typeof BenchmarkTrialResultV3Schema>;
export type BenchmarkTrialResultV4 = z.infer<typeof BenchmarkTrialResultV4Schema>;
export type BenchmarkTrialResult = BenchmarkTrialResultV3;
export type BenchmarkHostPreflightCheckpoint = z.infer<
  typeof BenchmarkHostPreflightCheckpointSchema
>;
export type BenchmarkReportV2 = z.infer<typeof BenchmarkReportV2Schema>;
export type BenchmarkReportV3 = z.infer<typeof BenchmarkReportV3Schema>;
export type BenchmarkReportV4 = z.infer<typeof BenchmarkReportV4Schema>;
export type BenchmarkReport = z.infer<typeof BenchmarkReportSchema>;
export type BenchmarkPermissionPolicy = z.infer<typeof BenchmarkPermissionPolicySchema>;
export type BenchmarkSourceIdentity = z.infer<typeof BenchmarkSourceIdentitySchema>;
export type BenchmarkReviewPacketV1 = z.infer<typeof BenchmarkReviewPacketV1Schema>;
export type BenchmarkReviewPacketV2 = z.infer<typeof BenchmarkReviewPacketV2Schema>;
export type BenchmarkReviewPacket = z.infer<typeof BenchmarkReviewPacketSchema>;

function seededRandom(seed: string): () => number {
  let state =
    Number.parseInt(contentHash(seed, LEGACY_CANONICAL_HASH_ALGORITHM).slice(0, 8), 16) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function createBenchmarkSchedule(input: {
  suite: BenchmarkSuite;
  hosts: Array<"codex" | "claude">;
  seed: string;
  repetitions?: number;
  identity?: BenchmarkReportIdentityPolicy;
}): BenchmarkScheduleEntry[] {
  const suite = BenchmarkSuiteSchema.parse(input.suite);
  const identity = BenchmarkReportIdentityPolicySchema.parse(
    input.identity ?? {
      schemaVersion: 3,
      hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
    },
  );
  const hosts = [...new Set(input.hosts)].sort();
  if (hosts.length === 0) throw new Error("A benchmark schedule requires at least one host");
  const entries = suite.tasks.flatMap((task) =>
    hosts.flatMap((host) =>
      (["baseline", "graphcraft"] as const).flatMap((mode) =>
        Array.from({ length: input.repetitions ?? task.repetitions }, (_, index) => ({
          taskId: task.id,
          family: task.family,
          host,
          mode,
          repetition: index + 1,
        })),
      ),
    ),
  );
  const random = seededRandom(`${suite.id}:${suite.version}:${input.seed}`);
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [entries[index], entries[swap]] = [entries[swap]!, entries[index]!];
  }
  return entries.map((entry, order) =>
    BenchmarkScheduleEntrySchema.parse({
      ...entry,
      order,
      seed: input.seed,
      trialId: benchmarkTrialId(suite, input.seed, entry, identity),
    }),
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

const MINIMUM_MATCHED_ACCEPTED_PAIRS_PER_TASK = 3;
const TOKEN_REDUCTION_AGGREGATION =
  "median_pair_reduction_within_task_then_median_across_tasks" as const;

type BenchmarkComparableTrial =
  BenchmarkTrialResultV2 | BenchmarkTrialResultV3 | BenchmarkTrialResultV4;

function modeStats(results: BenchmarkComparableTrial[], mode: "baseline" | "graphcraft") {
  const selected = results.filter((result) => result.trial.mode === mode);
  const accepted = selected.filter((result) => result.accepted);
  const reconciled = selected.filter((result) => result.usageReconciled);
  return {
    trials: selected.length,
    accepted: accepted.length,
    unsuccessful: selected.length - accepted.length,
    acceptanceRate: selected.length ? accepted.length / selected.length : 0,
    reconciledTokenTrials: reconciled.length,
    medianAcceptedTokens: median(
      accepted.filter((result) => result.usageReconciled).map((result) => result.usage.total),
    ),
  };
}

function matchedAcceptedTokenStats(results: BenchmarkComparableTrial[], expectedTaskIds: string[]) {
  const groups = new Map<string, BenchmarkComparableTrial[]>();
  for (const result of results) {
    const key = `${result.trial.taskId}:${result.trial.repetition}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  const taskStats = [...new Set(expectedTaskIds)].sort().flatMap((taskId) => {
    const pairs = [...groups.values()].flatMap((group) => {
      const baseline = group.find(({ trial }) => trial.mode === "baseline");
      const graphcraft = group.find(({ trial }) => trial.mode === "graphcraft");
      return baseline?.trial.taskId === taskId &&
        graphcraft?.trial.taskId === taskId &&
        baseline.accepted &&
        graphcraft.accepted &&
        baseline.usageReconciled &&
        graphcraft.usageReconciled
        ? [{ baseline: baseline.usage.total, graphcraft: graphcraft.usage.total }]
        : [];
    });
    if (pairs.length === 0) return [];
    const baseline = median(pairs.map((pair) => pair.baseline))!;
    const graphcraft = median(pairs.map((pair) => pair.graphcraft))!;
    const zeroBaselinePairs = pairs.filter((pair) => pair.baseline === 0).length;
    const pairReductions = pairs.flatMap((pair) =>
      pair.baseline > 0 ? [((pair.baseline - pair.graphcraft) / pair.baseline) * 100] : [],
    );
    return [
      {
        taskId,
        pairs: pairs.length,
        zeroBaselinePairs,
        baseline,
        graphcraft,
        medianPairReductionPercent: median(pairReductions),
      },
    ];
  });
  const totalTasks = new Set(expectedTaskIds).size;
  const taskReductionPercentages = taskStats.flatMap(({ medianPairReductionPercent }) =>
    medianPairReductionPercent === null ? [] : [medianPairReductionPercent],
  );
  return {
    aggregation: TOKEN_REDUCTION_AGGREGATION,
    pairs: taskStats.reduce((sum, task) => sum + task.pairs, 0),
    zeroBaselinePairs: taskStats.reduce((sum, task) => sum + task.zeroBaselinePairs, 0),
    coveredTasks: taskStats.length,
    totalTasks,
    minimumPairsPerTask: MINIMUM_MATCHED_ACCEPTED_PAIRS_PER_TASK,
    completeTaskCoverage:
      totalTasks > 0 &&
      taskStats.length === totalTasks &&
      taskStats.every(({ pairs }) => pairs >= MINIMUM_MATCHED_ACCEPTED_PAIRS_PER_TASK),
    medianBaselineTokens: median(taskStats.map((task) => task.baseline)),
    medianGraphcraftTokens: median(taskStats.map((task) => task.graphcraft)),
    // Each task contributes one robust median regardless of how many extra
    // accepted repetitions it has, so larger schedules cannot overweight it.
    medianTokenReductionPercent: median(taskReductionPercentages),
    byTask: Object.fromEntries(taskStats.map(({ taskId, ...stats }) => [taskId, stats])),
  };
}

function matchedTrialControls(results: BenchmarkComparableTrial[]): boolean {
  const groups = new Map<string, BenchmarkComparableTrial[]>();
  for (const result of results) {
    const key = `${result.trial.host}:${result.trial.taskId}:${result.trial.repetition}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return [...groups.values()].every((group) => {
    if (group.length !== 2 || new Set(group.map(({ trial }) => trial.mode)).size !== 2)
      return false;
    const [first, second] = group;
    return (
      first!.repositoryDigest === second!.repositoryDigest &&
      first!.baseSha === second!.baseSha &&
      first!.hostVersion === second!.hostVersion &&
      first!.modelPolicy === second!.modelPolicy &&
      first!.effortPolicy === second!.effortPolicy &&
      first!.permissionPolicy === second!.permissionPolicy &&
      first!.acceptanceScorerDigest === second!.acceptanceScorerDigest &&
      first!.observedScorerDigest === second!.observedScorerDigest &&
      first!.scorerVerified === second!.scorerVerified
    );
  });
}

export function summarizeBenchmark(
  results: BenchmarkComparableTrial[],
  schedule: BenchmarkScheduleEntry[] = results.map(({ trial }) => trial),
  inputIdentity?: BenchmarkReportIdentityPolicy,
) {
  const identity =
    inputIdentity === undefined
      ? undefined
      : BenchmarkReportIdentityPolicySchema.parse(inputIdentity);
  const parsed: BenchmarkComparableTrial[] =
    identity === undefined
      ? results.map((result) => BenchmarkLegacyTrialResultSchema.parse(result))
      : identity.schemaVersion === 2
        ? results.map((result) => BenchmarkTrialResultV2Schema.parse(result))
        : identity.schemaVersion === 3
          ? results.map((result) => BenchmarkTrialResultV3Schema.parse(result))
          : results.map((result) => BenchmarkTrialResultV4Schema.parse(result));
  const parsedSchedule = schedule.map((entry) =>
    identity === undefined
      ? BenchmarkScheduleEntrySchema.parse(entry)
      : identity.schemaVersion === 2
        ? BenchmarkScheduleEntryV2Schema.parse(entry)
        : identity.schemaVersion === 3
          ? BenchmarkScheduleEntryV3Schema.parse(entry)
          : BenchmarkScheduleEntryV4Schema.parse(entry),
  );
  return Object.fromEntries(
    (["codex", "claude"] as const).map((host) => {
      const selected = parsed.filter((result) => result.trial.host === host);
      const expected = parsedSchedule.filter((trial) => trial.host === host);
      const baseline = modeStats(selected, "baseline");
      const graphcraft = modeStats(selected, "graphcraft");
      const matchedAccepted = matchedAcceptedTokenStats(
        selected,
        expected.map(({ taskId }) => taskId),
      );
      const stableHostVersion = new Set(selected.map(({ hostVersion }) => hostVersion)).size <= 1;
      const completeSchedule =
        selected.length === expected.length &&
        new Set(selected.map(({ trial }) => trial.trialId)).size === expected.length &&
        selected.every(({ trial }) => expected.some(({ trialId }) => trialId === trial.trialId));
      const matchedControls = matchedTrialControls(selected);
      const comparable =
        completeSchedule &&
        matchedControls &&
        stableHostVersion &&
        baseline.trials > 0 &&
        baseline.trials === graphcraft.trials &&
        baseline.reconciledTokenTrials === baseline.trials &&
        graphcraft.reconciledTokenTrials === graphcraft.trials &&
        matchedAccepted.completeTaskCoverage &&
        matchedAccepted.zeroBaselinePairs === 0 &&
        matchedAccepted.medianBaselineTokens !== null &&
        matchedAccepted.medianBaselineTokens > 0 &&
        matchedAccepted.medianGraphcraftTokens !== null &&
        matchedAccepted.medianTokenReductionPercent !== null;
      const tokenReductionPercent = comparable ? matchedAccepted.medianTokenReductionPercent : null;
      const acceptanceDeltaPoints = comparable
        ? (graphcraft.acceptanceRate - baseline.acceptanceRate) * 100
        : null;
      return [
        host,
        {
          baseline,
          graphcraft,
          matchedAccepted,
          gate: {
            completeSchedule,
            matchedControls,
            stableHostVersion,
            comparable,
            tokenReductionPercent,
            acceptanceDeltaPoints,
            passes:
              comparable && tokenReductionPercent !== null && acceptanceDeltaPoints !== null
                ? tokenReductionPercent >= 20 && acceptanceDeltaPoints >= -5
                : null,
          },
        },
      ];
    }),
  );
}
