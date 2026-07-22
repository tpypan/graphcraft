import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  BenchmarkSuiteSchema,
  BenchmarkTrialResultSchema,
  createBenchmarkSchedule,
  summarizeBenchmark,
  unavailableTokenUsage,
  type BenchmarkTrialResult,
} from "./index.ts";

const suite = BenchmarkSuiteSchema.parse({
  schemaVersion: 1,
  id: "fixture-suite",
  version: 1,
  description: "Deterministic schedule fixture",
  tasks: [
    {
      id: "feature-one",
      family: "feature",
      task: "Implement the fixture feature",
      initialFiles: { "package.json": "{}\n" },
      checks: [{ command: "node", args: ["--version"] }],
      acceptance: [{ kind: "exists", path: "result.js" }],
      repetitions: 2,
    },
  ],
});

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
        permissionPolicy: "local_read_write_shell_no_external",
        acceptanceScorerDigest: "fixture-scorer",
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
});
