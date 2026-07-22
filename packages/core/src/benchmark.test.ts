import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  BenchmarkReportSchema,
  BenchmarkSuiteSchema,
  BenchmarkTrialResultSchema,
  createBenchmarkSchedule,
  summarizeBenchmark,
  unavailableTokenUsage,
  type BenchmarkScheduleEntry,
  type BenchmarkTrialResult,
} from "./index.ts";

const execFileAsync = promisify(execFile);

const suite = BenchmarkSuiteSchema.parse({
  schemaVersion: 2,
  id: "fixture-suite",
  version: 1,
  description: "Deterministic schedule fixture",
  tasks: [
    {
      id: "feature-one",
      family: "feature",
      task: "Implement the fixture feature",
      initialFiles: { "package.json": "{}\n", "score.mjs": "\n" },
      checks: [{ command: "node", scorerPath: "score.mjs" }],
      acceptance: [{ kind: "exists", path: "result.js" }],
      repetitions: 2,
    },
  ],
});

function reportedTrial(
  trial: BenchmarkScheduleEntry,
  total: number,
  accepted = true,
): BenchmarkTrialResult {
  return BenchmarkTrialResultSchema.parse({
    trial,
    hostVersion: "fixture",
    modelPolicy: "gpt-benchmark-fixture",
    effortPolicy: "high",
    permissionPolicy: "codex_workspace_write_shell_external_not_graphcraft_enforced",
    acceptanceScorerDigest: "fixture-scorer",
    observedScorerDigest: "fixture-scorer",
    scorerVerified: true,
    repositoryDigest: "same-fixture",
    baseSha: "same-base-sha",
    executionStatus: accepted ? "completed" : "failed",
    accepted,
    acceptance: [{ path: "result.js", passed: accepted, summary: "fixture score" }],
    usage: {
      input: total,
      cachedInput: 0,
      uncachedInput: total,
      output: 0,
      reasoning: 0,
      total,
      availability: {
        input: "reported",
        cachedInput: "reported",
        uncachedInput: "derived",
        output: "reported",
        reasoning: "reported",
        total: "reported",
      },
    },
    usageReconciled: true,
    limitations: [],
    durationMs: 1,
    humanInterventions: 0,
    failureTrace: accepted ? [] : ["held-out scorer failed"],
  });
}

function reportValue(
  schedule: BenchmarkScheduleEntry[],
  results: BenchmarkTrialResult[],
  status: "running" | "complete" = "running",
) {
  return {
    schemaVersion: 2 as const,
    status,
    suite: { id: suite.id, version: suite.version, digest: "fixture-suite-digest" },
    startedAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
    seed: "report-schema-seed",
    randomized: true as const,
    modelPolicy: { codex: "gpt-benchmark-fixture" },
    effortPolicy: "high" as const,
    permissionPolicy: {
      codex: "codex_workspace_write_shell_external_not_graphcraft_enforced" as const,
    },
    scorerPolicy: "fixture_bound_scorers_plus_suite_assertions" as const,
    environment: {
      platform: "fixture",
      architecture: "fixture",
      nodeVersion: "fixture",
      graphcraftVersion: "0.1.2-fixture",
    },
    limitations: [],
    schedule,
    results,
    summary: summarizeBenchmark(results, schedule),
  };
}

describe("matched benchmark protocol", () => {
  it("ships ten versioned public tasks across every required family", async () => {
    const publicSuite = BenchmarkSuiteSchema.parse(
      JSON.parse(
        await readFile(new URL("../../../benchmarks/stable-v1.json", import.meta.url), "utf8"),
      ),
    );

    expect(publicSuite.tasks).toHaveLength(10);
    expect(new Set(publicSuite.tasks.map(({ family }) => family))).toEqual(
      new Set(["bug", "feature", "migration", "refactor", "audit", "pr_repair"]),
    );
    expect(publicSuite.tasks.every(({ repetitions }) => repetitions >= 3)).toBe(true);
    expect(publicSuite.tasks.every(({ checks }) => checks.length > 0)).toBe(true);
    const audit = publicSuite.tasks.find(({ id }) => id === "audit-api-boundary")!;
    expect(
      audit.acceptance.flatMap((assertion) =>
        assertion.kind === "summary_contains" ? [assertion.value] : [],
      ),
    ).toEqual(expect.arrayContaining(["JSON.parse", "SyntaxError", "null", "non-string"]));
    expect(audit.acceptance).toContainEqual({
      kind: "equals",
      path: "api.js",
      value: audit.initialFiles["api.js"],
    });

    const repository = await mkdtemp(join(tmpdir(), "graphcraft-audit-benchmark-"));
    try {
      await Promise.all(
        Object.entries(audit.initialFiles).map(([path, value]) =>
          writeFile(join(repository, path), value, "utf8"),
        ),
      );
      const apiBefore = await readFile(join(repository, "api.js"), "utf8");
      await execFileAsync(process.execPath, [join(repository, "score.mjs")], {
        cwd: repository,
      });
      expect(await readFile(join(repository, "api.js"), "utf8")).toBe(apiBefore);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("creates a deterministic randomized schedule with both matched modes", () => {
    const first = createBenchmarkSchedule({
      suite,
      hosts: ["claude", "codex"],
      seed: "fixture-seed",
    });
    const second = createBenchmarkSchedule({
      suite,
      hosts: ["codex", "claude"],
      seed: "fixture-seed",
    });

    expect(second).toEqual(first);
    expect(first).toHaveLength(8);
    expect(new Set(first.map(({ mode }) => mode))).toEqual(new Set(["baseline", "graphcraft"]));
    expect(new Set(first.map(({ host }) => host))).toEqual(new Set(["codex", "claude"]));
    expect(new Set(first.map(({ trialId }) => trialId)).size).toBe(first.length);
  });

  it("rejects duplicate task IDs before they can alias schedule entries", () => {
    const task = suite.tasks[0]!;
    expect(() =>
      BenchmarkSuiteSchema.parse({
        ...suite,
        tasks: [task, { ...task, task: "A different task with the same ID" }],
      }),
    ).toThrow(/task IDs must be unique/);
  });

  it("rejects duplicate schedule and result trial IDs", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const duplicateSchedule = [schedule[0]!, { ...schedule[1]!, trialId: schedule[0]!.trialId }];
    expect(() => BenchmarkReportSchema.parse(reportValue(duplicateSchedule, []))).toThrow(
      /schedule trial IDs must be unique/,
    );

    const result = reportedTrial(schedule[0]!, 100);
    expect(() => BenchmarkReportSchema.parse(reportValue(schedule, [result, result]))).toThrow(
      /result trial IDs must be unique/,
    );
  });

  it("rejects foreign or altered result trials", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const foreign = reportedTrial({ ...schedule[0]!, trialId: "foreign-trial" }, 100);
    expect(() => BenchmarkReportSchema.parse(reportValue(schedule, [foreign]))).toThrow(
      /exactly match a scheduled trial/,
    );

    const altered = reportedTrial({ ...schedule[0]!, taskId: "altered-task" }, 100);
    expect(() => BenchmarkReportSchema.parse(reportValue(schedule, [altered]))).toThrow(
      /exactly match a scheduled trial/,
    );
  });

  it("requires exact result coverage before a report can be complete", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const results = schedule.slice(0, -1).map((trial) => reportedTrial(trial, 100));
    expect(() => BenchmarkReportSchema.parse(reportValue(schedule, results, "complete"))).toThrow(
      /complete benchmark report does not cover the exact current schedule/i,
    );
  });

  it("derives the report summary from its trial evidence", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const valid = reportValue(schedule, []);
    expect(BenchmarkReportSchema.parse(valid).summary).toEqual(
      summarizeBenchmark(valid.results, valid.schedule),
    );
    expect(() => BenchmarkReportSchema.parse({ ...valid, summary: { fixture: true } })).toThrow(
      /summary does not match its trial evidence/,
    );
  });

  it("requires an explicit Graphcraft version identity in benchmark reports", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const valid = reportValue(schedule, []);
    expect(BenchmarkReportSchema.parse(valid).environment.graphcraftVersion).toBe("0.1.2-fixture");
    const { graphcraftVersion: _graphcraftVersion, ...identitylessEnvironment } = valid.environment;
    expect(() =>
      BenchmarkReportSchema.parse({ ...valid, environment: identitylessEnvironment }),
    ).toThrow(/graphcraftVersion/);
  });

  it("keeps unsuccessful and unreconciled trials visible and refuses an incomplete gate", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "summary-seed",
      repetitions: 1,
    });
    const result = (
      mode: "baseline" | "graphcraft",
      accepted: boolean,
      reconciled: boolean,
    ): BenchmarkTrialResult => {
      const trial = schedule.find((entry) => entry.mode === mode)!;
      return BenchmarkTrialResultSchema.parse({
        trial,
        hostVersion: "fixture",
        modelPolicy: "gpt-benchmark-fixture",
        effortPolicy: "high",
        permissionPolicy: "codex_workspace_write_shell_external_not_graphcraft_enforced",
        acceptanceScorerDigest: "fixture-scorer",
        observedScorerDigest: "fixture-scorer",
        scorerVerified: true,
        repositoryDigest: "same-fixture",
        baseSha: "same-base-sha",
        executionStatus: accepted ? "completed" : "failed",
        accepted,
        acceptance: [{ path: "result.js", passed: accepted, summary: "fixture score" }],
        usage: unavailableTokenUsage(),
        usageReconciled: reconciled,
        limitations: reconciled ? [] : ["total:unavailable"],
        durationMs: 1,
        humanInterventions: 0,
        failureTrace: accepted ? [] : ["held-out scorer failed"],
      });
    };

    const summary = summarizeBenchmark(
      [result("baseline", true, true), result("graphcraft", false, false)],
      schedule,
    );

    expect(summary.codex).toMatchObject({
      graphcraft: { trials: 1, accepted: 0, unsuccessful: 1, reconciledTokenTrials: 0 },
      gate: { completeSchedule: true, matchedControls: true, comparable: false, passes: null },
    });

    const mismatched = summarizeBenchmark(
      [
        result("baseline", true, true),
        { ...result("graphcraft", true, true), acceptanceScorerDigest: "different-scorer" },
      ],
      schedule,
    );
    expect(mismatched.codex).toMatchObject({
      gate: { completeSchedule: true, matchedControls: false, comparable: false, passes: null },
    });

    const partial = summarizeBenchmark([result("baseline", true, true)], schedule);
    expect(partial.codex).toMatchObject({
      gate: { completeSchedule: false, comparable: false, passes: null },
    });
  });

  it("refuses token comparisons across disjoint accepted trial pairs", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "disjoint-seed",
    });
    const results = schedule.map((trial) => {
      const accepted =
        (trial.mode === "baseline" && trial.repetition === 1) ||
        (trial.mode === "graphcraft" && trial.repetition === 2);
      return BenchmarkTrialResultSchema.parse({
        trial,
        hostVersion: "fixture",
        modelPolicy: "gpt-benchmark-fixture",
        effortPolicy: "high",
        permissionPolicy: "codex_workspace_write_shell_external_not_graphcraft_enforced",
        acceptanceScorerDigest: "fixture-scorer",
        observedScorerDigest: "fixture-scorer",
        scorerVerified: true,
        repositoryDigest: "same-fixture",
        baseSha: "same-base-sha",
        executionStatus: accepted ? "completed" : "failed",
        accepted,
        acceptance: [{ path: "result.js", passed: accepted, summary: "fixture score" }],
        usage: {
          input: 90,
          cachedInput: 0,
          uncachedInput: 90,
          output: 10,
          reasoning: 0,
          total: 100,
          availability: {
            input: "reported",
            cachedInput: "reported",
            uncachedInput: "derived",
            output: "reported",
            reasoning: "unavailable",
            total: "derived",
          },
        },
        usageReconciled: true,
        limitations: ["reasoning:unavailable"],
        durationMs: 1,
        humanInterventions: 0,
        failureTrace: accepted ? [] : ["held-out scorer failed"],
      });
    });

    expect(summarizeBenchmark(results, schedule).codex).toMatchObject({
      baseline: { accepted: 1 },
      graphcraft: { accepted: 1 },
      matchedAccepted: { pairs: 0, completeTaskCoverage: false },
      gate: { matchedControls: true, comparable: false, passes: null },
    });
  });

  it("requires three jointly accepted pairs per task before evaluating the stable gate", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "minimum-pairs-seed",
      repetitions: 3,
    });
    const results = schedule.map((trial) => {
      const accepted = trial.repetition <= 2;
      const total = trial.mode === "baseline" ? 100 : 70;
      return BenchmarkTrialResultSchema.parse({
        trial,
        hostVersion: "fixture",
        modelPolicy: "gpt-benchmark-fixture",
        effortPolicy: "high",
        permissionPolicy: "codex_workspace_write_shell_external_not_graphcraft_enforced",
        acceptanceScorerDigest: "fixture-scorer",
        observedScorerDigest: "fixture-scorer",
        scorerVerified: true,
        repositoryDigest: "same-fixture",
        baseSha: "same-base-sha",
        executionStatus: accepted ? "completed" : "failed",
        accepted,
        acceptance: [{ path: "result.js", passed: accepted, summary: "fixture score" }],
        usage: {
          input: total - 10,
          cachedInput: 0,
          uncachedInput: total - 10,
          output: 10,
          reasoning: 0,
          total,
          availability: {
            input: "reported",
            cachedInput: "reported",
            uncachedInput: "derived",
            output: "reported",
            reasoning: "unavailable",
            total: "derived",
          },
        },
        usageReconciled: true,
        limitations: ["reasoning:unavailable"],
        durationMs: 1,
        humanInterventions: 0,
        failureTrace: accepted ? [] : ["held-out scorer failed"],
      });
    });

    expect(summarizeBenchmark(results, schedule).codex).toMatchObject({
      matchedAccepted: {
        pairs: 2,
        minimumPairsPerTask: 3,
        completeTaskCoverage: false,
      },
      gate: { completeSchedule: true, matchedControls: true, comparable: false, passes: null },
    });

    const threeAcceptedPairs = results.map((result) =>
      result.trial.repetition === 3
        ? BenchmarkTrialResultSchema.parse({
            ...result,
            executionStatus: "completed",
            accepted: true,
            acceptance: [{ path: "result.js", passed: true, summary: "fixture score" }],
            failureTrace: [],
          })
        : result,
    );
    expect(summarizeBenchmark(threeAcceptedPairs, schedule).codex).toMatchObject({
      matchedAccepted: {
        pairs: 3,
        minimumPairsPerTask: 3,
        completeTaskCoverage: true,
      },
      gate: { completeSchedule: true, matchedControls: true, comparable: true, passes: true },
    });
  });

  it("uses matched per-repetition reductions instead of a ratio of independent medians", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "paired-statistic-seed",
      repetitions: 4,
    });
    const baseline = [1, 2, 1_000, 2_000];
    const graphcraft = [1, 2, 100, 2_000];
    const results = schedule.map((trial) =>
      reportedTrial(
        trial,
        (trial.mode === "baseline" ? baseline : graphcraft)[trial.repetition - 1]!,
      ),
    );

    expect(summarizeBenchmark(results, schedule).codex).toMatchObject({
      matchedAccepted: {
        aggregation: "median_pair_reduction_within_task_then_median_across_tasks",
        zeroBaselinePairs: 0,
        medianTokenReductionPercent: 0,
        byTask: {
          "feature-one": {
            pairs: 4,
            zeroBaselinePairs: 0,
            medianPairReductionPercent: 0,
          },
        },
      },
      gate: { comparable: true, tokenReductionPercent: 0, passes: false },
    });
  });

  it("weights each task median once even when tasks have different accepted pair counts", () => {
    const fixtureTask = suite.tasks[0]!;
    const corpusSuite = BenchmarkSuiteSchema.parse({
      ...suite,
      id: "corpus-aggregation-suite",
      tasks: [
        { ...fixtureTask, id: "task-low", task: "Low reduction task", repetitions: 6 },
        { ...fixtureTask, id: "task-middle", task: "Middle reduction task", repetitions: 6 },
        { ...fixtureTask, id: "task-high", task: "High reduction task", repetitions: 6 },
      ],
    });
    const schedule = createBenchmarkSchedule({
      suite: corpusSuite,
      hosts: ["codex"],
      seed: "corpus-aggregation-seed",
    });
    const results = schedule.map((trial) => {
      const acceptedPairs = trial.taskId === "task-high" ? 6 : 3;
      const graphcraftTotal =
        trial.taskId === "task-low" ? 100 : trial.taskId === "task-middle" ? 50 : 0;
      return reportedTrial(
        trial,
        trial.mode === "baseline" ? 100 : graphcraftTotal,
        trial.repetition <= acceptedPairs,
      );
    });

    expect(summarizeBenchmark(results, schedule).codex).toMatchObject({
      matchedAccepted: {
        aggregation: "median_pair_reduction_within_task_then_median_across_tasks",
        pairs: 12,
        medianTokenReductionPercent: 50,
        byTask: {
          "task-low": { pairs: 3, medianPairReductionPercent: 0 },
          "task-middle": { pairs: 3, medianPairReductionPercent: 50 },
          "task-high": { pairs: 6, medianPairReductionPercent: 100 },
        },
      },
      gate: { comparable: true, tokenReductionPercent: 50, passes: true },
    });
  });

  it("refuses a percentage comparison when an accepted pair has a zero-token baseline", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "zero-baseline-seed",
      repetitions: 3,
    });
    const baseline = [0, 100, 100];
    const graphcraft = [1, 80, 80];
    const results = schedule.map((trial) =>
      reportedTrial(
        trial,
        (trial.mode === "baseline" ? baseline : graphcraft)[trial.repetition - 1]!,
      ),
    );

    expect(summarizeBenchmark(results, schedule).codex).toMatchObject({
      matchedAccepted: {
        pairs: 3,
        zeroBaselinePairs: 1,
        completeTaskCoverage: true,
        medianTokenReductionPercent: 20,
        byTask: {
          "feature-one": { zeroBaselinePairs: 1, medianPairReductionPercent: 20 },
        },
      },
      gate: {
        completeSchedule: true,
        comparable: false,
        tokenReductionPercent: null,
        passes: null,
      },
    });
  });
});
