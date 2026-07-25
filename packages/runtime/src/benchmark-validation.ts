import {
  BenchmarkReportV3Schema,
  BenchmarkReportV4Schema,
  BenchmarkSuiteSchema,
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  contentHash,
  createBenchmarkSchedule,
  type CanonicalHashAlgorithm,
  type BenchmarkPermissionPolicy,
  type BenchmarkReportV3,
  type BenchmarkReportV4,
  type BenchmarkReportIdentityPolicy,
  type BenchmarkScheduleEntry,
  type BenchmarkSuite,
  type BenchmarkTask,
} from "@graphcraft/core";

type EvidenceBenchmarkReport = BenchmarkReportV3 | BenchmarkReportV4;

function reportIdentity(report: EvidenceBenchmarkReport): BenchmarkReportIdentityPolicy {
  return report.schemaVersion === 4
    ? { schemaVersion: 4, hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM }
    : { schemaVersion: 3, hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM };
}

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

function expectedScorerFiles(task: BenchmarkTask, hashAlgorithm: CanonicalHashAlgorithm) {
  return [...new Set(task.checks.map(({ scorerPath }) => scorerPath))].sort().map((path) => ({
    path,
    kind: "regular_file" as const,
    digest: contentHash(task.initialFiles[path], hashAlgorithm),
  }));
}

export function expectedBenchmarkScorerDigest(
  task: BenchmarkTask,
  hashAlgorithm: CanonicalHashAlgorithm = LEGACY_CANONICAL_HASH_ALGORITHM,
): string {
  return contentHash(
    {
      checks: task.checks,
      acceptance: task.acceptance,
      files: expectedScorerFiles(task, hashAlgorithm),
    },
    hashAlgorithm,
  );
}

function expectedAcceptancePaths(task: BenchmarkTask): string[] {
  return [
    ...task.checks.map((_, index) => `$check:${index + 1}`),
    ...task.acceptance.map((assertion) =>
      assertion.kind === "summary_contains" ? "$summary" : assertion.path,
    ),
  ];
}

function validTokenEvidence(result: EvidenceBenchmarkReport["results"][number]): boolean {
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
  report: EvidenceBenchmarkReport,
  suite: BenchmarkSuite,
  identity: BenchmarkReportIdentityPolicy,
  expected?: readonly BenchmarkScheduleEntry[],
): BenchmarkScheduleEntry[] {
  const hosts = [...new Set(report.schedule.map(({ host }) => host))].sort() as Array<
    "codex" | "claude"
  >;
  const defaults = createBenchmarkSchedule({ suite, hosts, seed: report.seed, identity });
  let derived: BenchmarkScheduleEntry[] | undefined;
  if (
    contentHash(defaults, identity.hashAlgorithm) ===
    contentHash(report.schedule, identity.hashAlgorithm)
  )
    derived = defaults;

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
        identity,
      });
      if (
        contentHash(overridden, identity.hashAlgorithm) ===
        contentHash(report.schedule, identity.hashAlgorithm)
      )
        derived = overridden;
    }
  }
  if (derived === undefined)
    throw new Error("The benchmark report schedule does not exactly cover its declared suite");
  if (
    expected &&
    contentHash(expected, identity.hashAlgorithm) !== contentHash(derived, identity.hashAlgorithm)
  )
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
export function assertBenchmarkReportEvidence<T extends EvidenceBenchmarkReport>(input: {
  report: T;
  suite: BenchmarkSuite;
  expectedSchedule?: readonly BenchmarkScheduleEntry[];
}): T {
  const report: EvidenceBenchmarkReport =
    input.report.schemaVersion === 4
      ? BenchmarkReportV4Schema.parse(input.report)
      : BenchmarkReportV3Schema.parse(input.report);
  const identity = reportIdentity(report);
  const hashAlgorithm = identity.hashAlgorithm;
  const suite = BenchmarkSuiteSchema.parse(input.suite);
  if (
    report.suite.id !== suite.id ||
    report.suite.version !== suite.version ||
    report.suite.digest !== contentHash(suite, hashAlgorithm)
  ) {
    throw new Error("The benchmark report does not match its declared suite identity");
  }

  const schedule = exactSchedule(report, suite, identity, input.expectedSchedule);
  if (contentHash(schedule, hashAlgorithm) !== contentHash(report.schedule, hashAlgorithm))
    throw new Error("The benchmark report schedule does not match the expected execution");
  const hosts = [...new Set(schedule.map(({ host }) => host))].sort();
  if (
    contentHash(definedPolicyHosts(report.modelPolicy), hashAlgorithm) !==
      contentHash(hosts, hashAlgorithm) ||
    contentHash(definedPolicyHosts(report.permissionPolicy), hashAlgorithm) !==
      contentHash(hosts, hashAlgorithm)
  ) {
    throw new Error("The benchmark report host policies do not match its schedule");
  }
  for (const host of hosts as Array<"codex" | "claude">) {
    if (report.permissionPolicy[host] !== benchmarkPermissionPolicy(host))
      throw new Error("The benchmark report permission policy does not match its host");
  }
  if (
    contentHash(report.limitations, hashAlgorithm) !==
    contentHash(BENCHMARK_REPORT_LIMITATIONS, hashAlgorithm)
  )
    throw new Error("The benchmark report limitations do not match this harness");

  const scheduleById = new Map(schedule.map((trial) => [trial.trialId, trial]));
  const taskById = new Map(suite.tasks.map((task) => [task.id, task]));
  for (const result of report.results) {
    const scheduled = scheduleById.get(result.trial.trialId);
    const task = taskById.get(result.trial.taskId);
    if (
      !scheduled ||
      contentHash(scheduled, hashAlgorithm) !== contentHash(result.trial, hashAlgorithm) ||
      !task
    )
      throw new Error("The benchmark report contains a result outside its exact suite schedule");
    const expectedScorerDigest = expectedBenchmarkScorerDigest(task, hashAlgorithm);
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
      result.repositoryDigest !== contentHash(task.initialFiles, hashAlgorithm) ||
      result.acceptanceScorerDigest !== expectedScorerDigest ||
      result.scorerVerified !== scorerVerified ||
      !validTokenEvidence(result) ||
      contentHash(
        result.acceptance.map(({ path }) => path),
        hashAlgorithm,
      ) !== contentHash(expectedAcceptancePaths(task), hashAlgorithm) ||
      result.accepted !== accepted
    ) {
      throw new Error("The benchmark report contains mismatched trial controls or evidence");
    }
  }
  return report as T;
}
