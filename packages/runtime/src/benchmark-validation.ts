import {
  BenchmarkReportV3Schema,
  BenchmarkSuiteSchema,
  contentHash,
  createBenchmarkSchedule,
  type BenchmarkPermissionPolicy,
  type BenchmarkReportV3,
  type BenchmarkScheduleEntry,
  type BenchmarkSuite,
  type BenchmarkTask,
} from "@graphcraft/core";

export const BENCHMARK_REPORT_LIMITATIONS = [
  "Stable efficiency claims require at least three jointly accepted reconciled baseline/Graphcraft pairs per task and host.",
  "Each trial retains a bounded redacted patch and transcript packet; blinded reviewer assignment and defect labels remain external.",
  "Every model call has a recorded timeout; an interrupted in-flight attempt is retained as unsuccessful evidence instead of being silently retried.",
  "An unconfirmed model-call settlement blocks all later trials and resume until the child is reconciled outside this harness.",
] as const;

export function benchmarkPermissionPolicy(host: "codex" | "claude"): BenchmarkPermissionPolicy {
  return host === "codex"
    ? "codex_workspace_write_shell_external_not_graphcraft_enforced"
    : "claude_accept_edits_bash_external_not_graphcraft_enforced";
}

function expectedScorerFiles(task: BenchmarkTask) {
  return [...new Set(task.checks.map(({ scorerPath }) => scorerPath))].sort().map((path) => ({
    path,
    kind: "regular_file" as const,
    digest: contentHash(task.initialFiles[path]),
  }));
}

export function expectedBenchmarkScorerDigest(task: BenchmarkTask): string {
  return contentHash({
    checks: task.checks,
    acceptance: task.acceptance,
    files: expectedScorerFiles(task),
  });
}

function expectedAcceptancePaths(task: BenchmarkTask): string[] {
  return [
    ...task.checks.map((_, index) => `$check:${index + 1}`),
    ...task.acceptance.map((assertion) =>
      assertion.kind === "summary_contains" ? "$summary" : assertion.path,
    ),
  ];
}

function validTokenEvidence(result: BenchmarkReportV3["results"][number]): boolean {
  const known = (value: string): boolean => value === "reported" || value === "derived";
  const reconciled = known(result.usage.availability.total);
  if (result.usageReconciled !== reconciled) return false;
  if (result.usage.availability.total === "derived") {
    if (!known(result.usage.availability.input) || !known(result.usage.availability.output))
      return false;
    if (result.usage.total !== result.usage.input + result.usage.output) return false;
  }
  if (
    result.usage.availability.uncachedInput === "derived" &&
    known(result.usage.availability.input) &&
    known(result.usage.availability.cachedInput) &&
    result.usage.input !== result.usage.cachedInput + result.usage.uncachedInput
  )
    return false;
  return true;
}

function exactSchedule(
  report: BenchmarkReportV3,
  suite: BenchmarkSuite,
  expected?: readonly BenchmarkScheduleEntry[],
): BenchmarkScheduleEntry[] {
  const hosts = [...new Set(report.schedule.map(({ host }) => host))].sort() as Array<
    "codex" | "claude"
  >;
  const defaults = createBenchmarkSchedule({ suite, hosts, seed: report.seed });
  let derived: BenchmarkScheduleEntry[] | undefined;
  if (contentHash(defaults) === contentHash(report.schedule)) derived = defaults;

  if (derived === undefined) {
    const counts = new Map<string, number>();
    for (const trial of report.schedule) {
      const key = `${trial.taskId}\0${trial.host}\0${trial.mode}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repetitions = [...new Set(counts.values())];
    if (repetitions.length === 1) {
      const overridden = createBenchmarkSchedule({
        suite,
        hosts,
        seed: report.seed,
        repetitions: repetitions[0]!,
      });
      if (contentHash(overridden) === contentHash(report.schedule)) derived = overridden;
    }
  }
  if (derived === undefined)
    throw new Error("The benchmark report schedule does not exactly cover its declared suite");
  if (expected && contentHash(expected) !== contentHash(derived))
    throw new Error("The expected benchmark schedule does not match the declared suite");
  return expected ? [...expected] : derived;
}

function definedPolicyHosts(value: {
  codex?: string | undefined;
  claude?: string | undefined;
}): string[] {
  return Object.entries(value)
    .filter(([, policy]) => policy !== undefined)
    .map(([host]) => host)
    .sort();
}

/**
 * Revalidate a report against public suite evidence instead of trusting a
 * self-consistent schema object or its derived summary.
 */
export function assertBenchmarkReportEvidence(input: {
  report: BenchmarkReportV3;
  suite: BenchmarkSuite;
  expectedSchedule?: readonly BenchmarkScheduleEntry[];
}): BenchmarkReportV3 {
  const report = BenchmarkReportV3Schema.parse(input.report);
  const suite = BenchmarkSuiteSchema.parse(input.suite);
  if (
    report.suite.id !== suite.id ||
    report.suite.version !== suite.version ||
    report.suite.digest !== contentHash(suite)
  ) {
    throw new Error("The benchmark report does not match its declared suite identity");
  }

  const schedule = exactSchedule(report, suite, input.expectedSchedule);
  if (contentHash(schedule) !== contentHash(report.schedule))
    throw new Error("The benchmark report schedule does not match the expected execution");
  const hosts = [...new Set(schedule.map(({ host }) => host))].sort();
  if (
    contentHash(definedPolicyHosts(report.modelPolicy)) !== contentHash(hosts) ||
    contentHash(definedPolicyHosts(report.permissionPolicy)) !== contentHash(hosts)
  ) {
    throw new Error("The benchmark report host policies do not match its schedule");
  }
  for (const host of hosts as Array<"codex" | "claude">) {
    if (report.permissionPolicy[host] !== benchmarkPermissionPolicy(host))
      throw new Error("The benchmark report permission policy does not match its host");
  }
  if (contentHash(report.limitations) !== contentHash(BENCHMARK_REPORT_LIMITATIONS))
    throw new Error("The benchmark report limitations do not match this harness");

  const scheduleById = new Map(schedule.map((trial) => [trial.trialId, trial]));
  const taskById = new Map(suite.tasks.map((task) => [task.id, task]));
  for (const result of report.results) {
    const scheduled = scheduleById.get(result.trial.trialId);
    const task = taskById.get(result.trial.taskId);
    if (!scheduled || contentHash(scheduled) !== contentHash(result.trial) || !task)
      throw new Error("The benchmark report contains a result outside its exact suite schedule");
    const expectedScorerDigest = expectedBenchmarkScorerDigest(task);
    const scorerVerified = result.acceptanceScorerDigest === result.observedScorerDigest;
    const reviewComplete =
      result.reviewPacket !== undefined &&
      result.reviewPacket.captureFailures.length === 0 &&
      !result.reviewPacket.patch.truncated &&
      !result.reviewPacket.transcript.truncated;
    const accepted =
      result.executionStatus === "completed" &&
      scorerVerified &&
      result.acceptance.every(({ passed }) => passed) &&
      reviewComplete;
    if (
      result.modelPolicy !== report.modelPolicy[result.trial.host] ||
      result.effortPolicy !== report.effortPolicy ||
      result.permissionPolicy !== report.permissionPolicy[result.trial.host] ||
      result.permissionPolicy !== benchmarkPermissionPolicy(result.trial.host) ||
      result.repositoryDigest !== contentHash(task.initialFiles) ||
      result.acceptanceScorerDigest !== expectedScorerDigest ||
      result.scorerVerified !== scorerVerified ||
      !validTokenEvidence(result) ||
      contentHash(result.acceptance.map(({ path }) => path)) !==
        contentHash(expectedAcceptancePaths(task)) ||
      result.accepted !== accepted
    ) {
      throw new Error("The benchmark report contains mismatched trial controls or evidence");
    }
  }
  return report;
}
