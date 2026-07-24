import {
  BenchmarkReportV3Schema,
  BenchmarkReviewLabelsSchema,
  BenchmarkSuiteSchema,
  BenchmarkTrialResultSchema,
  benchmarkBlindingKeyDigest,
  contentHash,
  createBenchmarkSchedule,
  summarizeBenchmark,
  type BenchmarkReportV3,
  type BenchmarkScheduleEntry,
  type BenchmarkSuite,
  type BenchmarkTask,
} from "@graphcraft/core";
import { describe, expect, it } from "vitest";
import {
  createBlindedBenchmarkReview,
  renderBenchmarkPublicationMarkdown,
} from "./benchmark-publication.ts";
import {
  assertBenchmarkReportEvidence,
  BENCHMARK_REPORT_LIMITATIONS,
  expectedBenchmarkScorerDigest,
} from "./benchmark-validation.ts";

const blindingKey = Buffer.from("6d".repeat(32), "hex");
const rawReportSha256 = "7".repeat(64);
const model = "qualified-model";
const permission = "codex_workspace_write_shell_external_not_graphcraft_enforced" as const;

const suite: BenchmarkSuite = BenchmarkSuiteSchema.parse({
  schemaVersion: 2,
  id: "validation-fixture",
  version: 1,
  description: "Benchmark evidence-validation fixture",
  tasks: [
    {
      id: "favorable-feature",
      family: "feature",
      task: "Implement the favorable feature",
      initialFiles: { "score.mjs": "process.exit(0);\n", "source.js": "export {};\n" },
      checks: [{ command: "node", scorerPath: "score.mjs" }],
      acceptance: [{ kind: "exists", path: "result.js" }],
      repetitions: 3,
    },
    {
      id: "unfavorable-bug",
      family: "bug",
      task: "Repair the unfavorable bug",
      initialFiles: { "score.mjs": "process.exit(0);\n", "bug.js": "throw new Error();\n" },
      checks: [{ command: "node", scorerPath: "score.mjs" }],
      acceptance: [{ kind: "contains", path: "bug.js", value: "fixed" }],
      repetitions: 3,
    },
  ],
});

function reviewEvidence(mediaType: "text/x-diff" | "application/x-ndjson") {
  const text = mediaType === "text/x-diff" ? "+const fixed = true;\n" : "{}\n";
  const observedBytes = Buffer.byteLength(text);
  return {
    mediaType,
    text,
    observedBytes,
    retainedBytes: observedBytes,
    omittedBytes: 0,
    truncated: false,
    digest: contentHash({ mediaType, text, observedBytes, omittedBytes: 0, truncated: false }),
  };
}

function acceptance(task: BenchmarkTask) {
  return [
    ...task.checks.map((_check, index) => ({
      path: `$check:${index + 1}`,
      passed: true,
      summary: "fixture check passed",
    })),
    ...task.acceptance.map((assertion) => ({
      path: assertion.kind === "summary_contains" ? "$summary" : assertion.path,
      passed: true,
      summary: "fixture assertion passed",
    })),
  ];
}

function trialResult(task: BenchmarkTask, trial: BenchmarkScheduleEntry, graphcraftTokens: number) {
  const total = trial.mode === "baseline" ? 100 : graphcraftTokens;
  const scorerDigest = expectedBenchmarkScorerDigest(task);
  return BenchmarkTrialResultSchema.parse({
    trial,
    hostVersion: "codex-cli 0.144.6",
    modelPolicy: model,
    effortPolicy: "high",
    permissionPolicy: permission,
    acceptanceScorerDigest: scorerDigest,
    observedScorerDigest: scorerDigest,
    scorerVerified: true,
    repositoryDigest: contentHash(task.initialFiles),
    baseSha: contentHash({ fixture: task.id }).slice(0, 40),
    executionStatus: "completed",
    attemptCheckpoint: "settled",
    accepted: true,
    acceptance: acceptance(task),
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
        reasoning: "reported",
        total: "derived",
      },
    },
    usageReconciled: true,
    limitations: [],
    durationMs: 1_000,
    humanInterventions: 0,
    failureTrace: [],
    reviewPacket: {
      schemaVersion: 1,
      patch: reviewEvidence("text/x-diff"),
      transcript: reviewEvidence("application/x-ndjson"),
      captureFailures: [],
    },
  });
}

function reportFixture(graphcraftTokens = 70): BenchmarkReportV3 {
  const schedule = createBenchmarkSchedule({
    suite,
    hosts: ["codex"],
    seed: "validation-seed",
  });
  const tasks = new Map(suite.tasks.map((task) => [task.id, task]));
  const results = schedule.map((trial) =>
    trialResult(tasks.get(trial.taskId)!, trial, graphcraftTokens),
  );
  return BenchmarkReportV3Schema.parse({
    schemaVersion: 3,
    status: "complete",
    suite: { id: suite.id, version: suite.version, digest: contentHash(suite) },
    startedAt: "2026-07-23T20:00:00.000Z",
    updatedAt: "2026-07-23T21:00:00.000Z",
    seed: "validation-seed",
    randomized: true,
    modelPolicy: { codex: model },
    effortPolicy: "high",
    permissionPolicy: { codex: permission },
    scorerPolicy: "fixture_bound_scorers_plus_suite_assertions",
    reviewPolicy: "bounded_redacted_patch_and_transcript_v1",
    modelCallTimeoutMs: 900_000,
    environment: {
      platform: "fixture-platform",
      architecture: "fixture-architecture",
      nodeVersion: "v22.17.0",
      graphcraftVersion: "0.1.2",
      graphcraftSource: { commitSha: "a".repeat(40), dirty: false, dirtyStatusDigest: null },
    },
    limitations: [...BENCHMARK_REPORT_LIMITATIONS],
    schedule,
    results,
    summary: summarizeBenchmark(results, schedule),
  });
}

function rebuiltReport(
  report: BenchmarkReportV3,
  mutate: (copy: BenchmarkReportV3) => void,
): BenchmarkReportV3 {
  const copy = structuredClone(report);
  mutate(copy);
  copy.summary = summarizeBenchmark(copy.results, copy.schedule);
  return BenchmarkReportV3Schema.parse(copy);
}

function reviewLabels(report: BenchmarkReportV3) {
  const blinded = createBlindedBenchmarkReview({ report, rawReportSha256, suite, blindingKey });
  return BenchmarkReviewLabelsSchema.parse({
    schemaVersion: 1,
    reviewPolicy: "opaque_blinded_review_v1",
    taxonomyVersion: 1,
    rawReportSha256,
    blindingKeyDigest: benchmarkBlindingKeyDigest(blindingKey),
    blindedReviewDigest: contentHash(blinded),
    labels: blinded.packets.map((packet) => ({
      opaqueId: packet.opaqueId,
      packetDigest: contentHash(packet),
      reviewed: true,
      reviewerId: "reviewer-a",
      verdict: "no_defect",
      defects: [],
    })),
  });
}

describe("benchmark report evidence validation", () => {
  it("accepts an exact suite-derived schedule and harness-derived controls", () => {
    const report = reportFixture();
    expect(assertBenchmarkReportEvidence({ report, suite })).toEqual(report);
  });

  it("cannot cherry-pick one favorable task and render a false PASS", () => {
    const report = reportFixture();
    const labels = reviewLabels(report);
    const cherryPicked = rebuiltReport(report, (copy) => {
      copy.schedule = copy.schedule.filter(({ taskId }) => taskId === "favorable-feature");
      const retained = new Set(copy.schedule.map(({ trialId }) => trialId));
      copy.results = copy.results.filter(({ trial }) => retained.has(trial.trialId));
    });
    expect(summarizeBenchmark(cherryPicked.results, cherryPicked.schedule).codex!.gate.passes).toBe(
      true,
    );
    expect(() => assertBenchmarkReportEvidence({ report: cherryPicked, suite })).toThrow(
      /schedule does not exactly cover its declared suite/u,
    );
    expect(() =>
      renderBenchmarkPublicationMarkdown({
        report: cherryPicked,
        rawReportSha256,
        suite,
        labels,
        labelsSha256: "8".repeat(64),
        blindingKey,
      }),
    ).toThrow(/schedule does not exactly cover its declared suite/u);
  });

  it("rejects forged host controls, scorer state, acceptance state, and limitations", () => {
    const report = reportFixture();
    const mutations: Array<(copy: BenchmarkReportV3) => void> = [
      (copy) => {
        copy.modelPolicy.codex = "substituted-model";
      },
      (copy) => {
        copy.effortPolicy = "low";
      },
      (copy) => {
        copy.permissionPolicy.codex = "claude_accept_edits_bash_external_not_graphcraft_enforced";
      },
      (copy) => {
        copy.results[0]!.repositoryDigest = "forged-repository-digest";
      },
      (copy) => {
        copy.results[0]!.acceptanceScorerDigest = "forged-scorer-digest";
        copy.results[0]!.observedScorerDigest = "forged-scorer-digest";
      },
      (copy) => {
        copy.results[0]!.acceptance[0]!.path = "$check:999";
      },
      (copy) => {
        copy.results[0]!.accepted = false;
      },
      (copy) => {
        copy.results[0]!.usageReconciled = false;
      },
      (copy) => {
        copy.limitations = ["The harness has no limitations."];
      },
    ];

    for (const mutate of mutations) {
      const forged = rebuiltReport(report, mutate);
      expect(() => assertBenchmarkReportEvidence({ report: forged, suite })).toThrow();
    }
  });

  it("cannot forge a passing token gate by changing only reconciled totals", () => {
    const legitimate = reportFixture(90);
    expect(summarizeBenchmark(legitimate.results, legitimate.schedule).codex!.gate.passes).toBe(
      false,
    );
    expect(assertBenchmarkReportEvidence({ report: legitimate, suite })).toEqual(legitimate);

    const forged = rebuiltReport(legitimate, (copy) => {
      for (const result of copy.results)
        if (result.trial.mode === "graphcraft") result.usage.total = 70;
    });
    expect(summarizeBenchmark(forged.results, forged.schedule).codex!.gate.passes).toBe(true);
    expect(() => assertBenchmarkReportEvidence({ report: forged, suite })).toThrow(
      /mismatched trial controls or evidence/u,
    );
  });

  it("does not let a caller substitute its own expected schedule", () => {
    const report = reportFixture();
    const expectedSchedule = report.schedule.slice(0, -1);
    expect(() => assertBenchmarkReportEvidence({ report, suite, expectedSchedule })).toThrow(
      /expected benchmark schedule does not match the declared suite/u,
    );
  });
});
