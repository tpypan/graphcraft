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
  args: z.array(z.string()).default([]),
  expectedExitCode: z.number().int().default(0),
  timeoutMs: z.number().int().positive().default(300_000),
});

export const BenchmarkTaskSchema = z.strictObject({
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
});

export const BenchmarkSuiteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: z.number().int().positive(),
  description: z.string().min(1),
  tasks: z.array(BenchmarkTaskSchema).min(1),
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

export const BenchmarkTrialResultSchema = z.strictObject({
  trial: BenchmarkScheduleEntrySchema,
  hostVersion: z.string().min(1),
  modelPolicy: z.string().min(1),
  effortPolicy: BenchmarkEffortPolicySchema,
  permissionPolicy: z.literal("local_read_write_shell_no_external"),
  acceptanceScorerDigest: z.string().min(1),
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

export const BenchmarkReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
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
  permissionPolicy: z.literal("local_read_write_shell_no_external"),
  scorerPolicy: z.literal("declared_checks_plus_suite_assertions"),
  environment: z.strictObject({
    platform: z.string().min(1),
    architecture: z.string().min(1),
    nodeVersion: z.string().min(1),
  }),
  limitations: z.array(z.string()),
  schedule: z.array(BenchmarkScheduleEntrySchema).min(1),
  results: z.array(BenchmarkTrialResultSchema),
  summary: z.record(z.string(), z.unknown()),
});

export type BenchmarkTask = z.infer<typeof BenchmarkTaskSchema>;
export type BenchmarkSuite = z.infer<typeof BenchmarkSuiteSchema>;
export type BenchmarkScheduleEntry = z.infer<typeof BenchmarkScheduleEntrySchema>;
export type BenchmarkTrialResult = z.infer<typeof BenchmarkTrialResultSchema>;
export type BenchmarkReport = z.infer<typeof BenchmarkReportSchema>;

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
      first!.acceptanceScorerDigest === second!.acceptanceScorerDigest
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
        baseline.medianAcceptedTokens !== null &&
        baseline.medianAcceptedTokens > 0 &&
        graphcraft.medianAcceptedTokens !== null;
      const tokenReductionPercent = comparable
        ? ((baseline.medianAcceptedTokens! - graphcraft.medianAcceptedTokens!) /
            baseline.medianAcceptedTokens!) *
          100
        : null;
      const acceptanceDeltaPoints = comparable
        ? (graphcraft.acceptanceRate - baseline.acceptanceRate) * 100
        : null;
      return [
        host,
        {
          baseline,
          graphcraft,
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
