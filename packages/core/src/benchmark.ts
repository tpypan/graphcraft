import { z } from "zod";
import { contentHash } from "./canonical.ts";
import { TokenUsageSchema } from "./schemas.ts";

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

export const BenchmarkScheduleEntrySchema = z.strictObject({
  trialId: z.string().min(1),
  order: z.number().int().nonnegative(),
  taskId: z.string().min(1),
  family: BenchmarkTaskFamilySchema,
  host: z.enum(["codex", "claude"]),
  mode: z.enum(["baseline", "graphcraft"]),
  repetition: z.number().int().positive(),
  seed: z.string().min(1),
});

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

export const BenchmarkTrialResultSchema = z.strictObject({
  trial: BenchmarkScheduleEntrySchema,
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
});

export const BenchmarkReportSchema = z
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
    environment: z.strictObject({
      platform: z.string().min(1),
      architecture: z.string().min(1),
      nodeVersion: z.string().min(1),
      graphcraftVersion: z.string().trim().min(1),
    }),
    limitations: z.array(z.string()),
    schedule: z.array(BenchmarkScheduleEntrySchema).min(1),
    results: z.array(BenchmarkTrialResultSchema),
    summary: z.record(z.string(), z.unknown()),
  })
  .superRefine((report, context) => {
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
      if (scheduled === undefined || contentHash(scheduled) !== contentHash(trial)) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "trial"],
          message: "Benchmark result trials must exactly match a scheduled trial",
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
      contentHash(report.summary) !==
      contentHash(summarizeBenchmark(report.results, report.schedule))
    ) {
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message: "The benchmark report summary does not match its trial evidence",
      });
    }
  });

export type BenchmarkTask = z.infer<typeof BenchmarkTaskSchema>;
export type BenchmarkSuite = z.infer<typeof BenchmarkSuiteSchema>;
export type BenchmarkScheduleEntry = z.infer<typeof BenchmarkScheduleEntrySchema>;
export type BenchmarkTrialResult = z.infer<typeof BenchmarkTrialResultSchema>;
export type BenchmarkReport = z.infer<typeof BenchmarkReportSchema>;
export type BenchmarkPermissionPolicy = z.infer<typeof BenchmarkPermissionPolicySchema>;

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(contentHash(seed).slice(0, 8), 16) >>> 0;
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
}): BenchmarkScheduleEntry[] {
  const suite = BenchmarkSuiteSchema.parse(input.suite);
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
      trialId: contentHash({ suite: suite.id, version: suite.version, seed: input.seed, ...entry }),
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

function modeStats(results: BenchmarkTrialResult[], mode: "baseline" | "graphcraft") {
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

function matchedAcceptedTokenStats(results: BenchmarkTrialResult[], expectedTaskIds: string[]) {
  const groups = new Map<string, BenchmarkTrialResult[]>();
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

function matchedTrialControls(results: BenchmarkTrialResult[]): boolean {
  const groups = new Map<string, BenchmarkTrialResult[]>();
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
  results: BenchmarkTrialResult[],
  schedule: BenchmarkScheduleEntry[] = results.map(({ trial }) => trial),
) {
  const parsed = results.map((result) => BenchmarkTrialResultSchema.parse(result));
  const parsedSchedule = schedule.map((entry) => BenchmarkScheduleEntrySchema.parse(entry));
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
