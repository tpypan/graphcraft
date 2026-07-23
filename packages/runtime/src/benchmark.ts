import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import {
  BenchmarkSuiteSchema,
  BenchmarkReportSchema,
  BenchmarkTrialResultSchema,
  ContextCapsuleSchema,
  HostCapabilityAdmissionError,
  RequiredHostCapabilityDiagnosticSchema,
  aggregateTokenUsage,
  assertRequiredHostCapabilities,
  contentHash,
  createBenchmarkSchedule,
  summarizeBenchmark,
  unavailableTokenUsage,
  type BenchmarkScheduleEntry,
  type BenchmarkReport,
  type BenchmarkPermissionPolicy,
  type BenchmarkSuite,
  type BenchmarkTask,
  type BenchmarkTrialResult,
  type HostAdapter,
  type HostExecutionPolicy,
  type RunEvent,
  type TokenUsage,
} from "@graphcraft/core";
import { runProcess } from "@graphcraft/probes";
import { createRun, executeRun } from "./runner.ts";
import { writeJsonAtomic } from "./json.ts";
import { redactValue } from "./redaction.ts";

const tokenDimensions = [
  "input",
  "cachedInput",
  "uncachedInput",
  "output",
  "reasoning",
  "total",
] as const;
const scorerPolicy = "fixture_bound_scorers_plus_suite_assertions" as const;
const reportLimitations = [
  "Stable efficiency claims require at least three jointly accepted reconciled baseline/Graphcraft pairs per task and host.",
  "Blinded human defect review remains outside this deterministic harness slice.",
];

function persistedCapabilityAdmissionError(
  events: readonly RunEvent[],
): HostCapabilityAdmissionError | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const parsed = RequiredHostCapabilityDiagnosticSchema.safeParse(
      events[index]!.data.capabilityDiagnostic,
    );
    if (parsed.success && !parsed.data.ready) return new HostCapabilityAdmissionError(parsed.data);
  }
  return undefined;
}

function benchmarkPermissionPolicy(host: "codex" | "claude"): BenchmarkPermissionPolicy {
  return host === "codex"
    ? "codex_workspace_write_shell_external_not_graphcraft_enforced"
    : "claude_accept_edits_bash_external_not_graphcraft_enforced";
}

function safeFixturePath(root: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    throw new Error(`Benchmark fixture path is unsafe: ${path}`);
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
    throw new Error(`Benchmark fixture path escapes its repository: ${path}`);
  return resolved;
}

export async function loadBenchmarkSuite(path: string): Promise<BenchmarkSuite> {
  return BenchmarkSuiteSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
}

async function materializeTask(task: BenchmarkTask): Promise<{
  repository: string;
  repositoryDigest: string;
  baseSha: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), `graphcraft-benchmark-${task.id}-`));
  try {
    for (const [path, value] of Object.entries(task.initialFiles)) {
      const target = safeFixturePath(repository, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, value, "utf8");
    }
    const initialized = await runProcess("git", ["init", "-b", "main"], { cwd: repository });
    if (initialized.exitCode !== 0) throw new Error(`Unable to initialize ${task.id}`);
    const configured = await runProcess("git", ["config", "core.autocrlf", "false"], {
      cwd: repository,
    });
    if (configured.exitCode !== 0)
      throw new Error(`Unable to configure deterministic line endings for ${task.id}`);
    const staged = await runProcess("git", ["add", "."], { cwd: repository });
    if (staged.exitCode !== 0) throw new Error(`Unable to stage fixture ${task.id}`);
    const committed = await runProcess(
      "git",
      [
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Graphcraft Benchmark",
        "-c",
        "user.email=benchmark@graphcraft.local",
        "commit",
        "-m",
        `fixture ${task.id}`,
      ],
      {
        cwd: repository,
        env: {
          GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
        },
      },
    );
    if (committed.exitCode !== 0) throw new Error(`Unable to commit fixture ${task.id}`);
    const head = await runProcess("git", ["rev-parse", "HEAD"], { cwd: repository });
    if (head.exitCode !== 0 || !head.stdout.trim())
      throw new Error(`Unable to hash fixture ${task.id}`);
    return {
      repository,
      repositoryDigest: contentHash(task.initialFiles),
      baseSha: head.stdout.trim(),
    };
  } catch (error) {
    try {
      await removeBenchmarkFixture(repository);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Benchmark fixture ${task.id} failed during setup and cleanup`,
      );
    }
    throw error;
  }
}

function benchmarkWorktreeRoot(repository: string): string {
  return join(dirname(repository), `.${basename(repository)}-graphcraft-worktrees`);
}

async function removeBenchmarkFixture(repository: string): Promise<void> {
  const failures: unknown[] = [];
  for (const path of [benchmarkWorktreeRoot(repository), repository]) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, `Unable to remove benchmark fixture ${repository}`);
}

function expectedScorerFiles(task: BenchmarkTask) {
  return [...new Set(task.checks.map(({ scorerPath }) => scorerPath))].sort().map((path) => ({
    path,
    kind: "regular_file" as const,
    digest: contentHash(task.initialFiles[path]),
  }));
}

async function observedScorerFiles(task: BenchmarkTask, repository: string) {
  return await Promise.all(
    [...new Set(task.checks.map(({ scorerPath }) => scorerPath))].sort().map(async (path) => {
      const target = safeFixturePath(repository, path);
      try {
        const status = await lstat(target);
        if (!status.isFile() || status.isSymbolicLink()) {
          return { path, kind: status.isSymbolicLink() ? "symbolic_link" : "not_regular" };
        }
        return {
          path,
          kind: "regular_file" as const,
          digest: contentHash(await readFile(target, "utf8")),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, kind: "missing" };
        throw error;
      }
    }),
  );
}

function scorerDigest(
  task: BenchmarkTask,
  files: Awaited<ReturnType<typeof observedScorerFiles>> | ReturnType<typeof expectedScorerFiles>,
): string {
  return contentHash({ checks: task.checks, acceptance: task.acceptance, files });
}

async function scoreAcceptance(
  task: BenchmarkTask,
  repository: string,
  summaryEvidence = "",
): Promise<{
  results: Array<{ path: string; passed: boolean; summary: string }>;
  expectedScorerDigest: string;
  observedScorerDigest: string;
  scorerVerified: boolean;
}> {
  const results: Array<{ path: string; passed: boolean; summary: string }> = [];
  const expectedScorerDigest = scorerDigest(task, expectedScorerFiles(task));
  const observedScorerDigest = scorerDigest(task, await observedScorerFiles(task, repository));
  const scorerVerified = expectedScorerDigest === observedScorerDigest;
  for (const [index, check] of task.checks.entries()) {
    if (!scorerVerified) {
      results.push({
        path: `$check:${index + 1}`,
        passed: false,
        summary: `immutable scorer ${check.scorerPath} changed from its fixture bytes`,
      });
      continue;
    }
    const scorerSource = task.initialFiles[check.scorerPath]!;
    const sourcePath = safeFixturePath(repository, check.scorerPath);
    const trustedScorerPath = join(
      dirname(sourcePath),
      `.graphcraft-benchmark-scorer-${randomUUID()}${extname(sourcePath)}`,
    );
    try {
      await writeFile(trustedScorerPath, scorerSource, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const result = await runProcess(check.command, [trustedScorerPath, ...check.args], {
        cwd: repository,
        timeoutMs: check.timeoutMs,
      });
      const passed = !result.timedOut && result.exitCode === check.expectedExitCode;
      results.push({
        path: `$check:${index + 1}`,
        passed,
        summary: `${check.command} ${check.args.join(" ")} ${
          result.timedOut ? "timed out" : `exited ${result.exitCode}`
        } (expected ${check.expectedExitCode})`,
      });
    } catch (error) {
      results.push({
        path: `$check:${index + 1}`,
        passed: false,
        summary: `${check.command} could not run: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      await rm(trustedScorerPath, { force: true });
    }
  }
  for (const assertion of task.acceptance) {
    try {
      if (assertion.kind === "summary_contains") {
        const passed = summaryEvidence.includes(assertion.value);
        results.push({
          path: "$summary",
          passed,
          summary: `run summary ${passed ? "contains" : "does not contain"} ${assertion.value}`,
        });
        continue;
      }
      const target = safeFixturePath(repository, assertion.path);
      let exists = true;
      try {
        await access(target);
      } catch {
        exists = false;
      }
      if (assertion.kind === "exists" || assertion.kind === "absent") {
        const passed = assertion.kind === "exists" ? exists : !exists;
        results.push({
          path: assertion.path,
          passed,
          summary: `${assertion.path} ${exists ? "exists" : "is absent"}`,
        });
        continue;
      }
      const value = exists ? await readFile(target, "utf8") : "";
      const passed =
        exists &&
        (assertion.kind === "equals"
          ? value === assertion.value
          : assertion.kind === "not_contains"
            ? !value.includes(assertion.value)
            : value.includes(assertion.value));
      results.push({
        path: assertion.path,
        passed,
        summary: `${assertion.path} ${passed ? "satisfies" : "does not satisfy"} ${assertion.kind}`,
      });
    } catch (error) {
      results.push({
        path: assertion.kind === "summary_contains" ? "$summary" : assertion.path,
        passed: false,
        summary: `acceptance assertion could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { results, expectedScorerDigest, observedScorerDigest, scorerVerified };
}

function usageSummary(usages: TokenUsage[]): {
  usage: TokenUsage;
  reconciled: boolean;
  limitations: string[];
} {
  const usage = aggregateTokenUsage(usages.length ? usages : [unavailableTokenUsage()]);
  const limitations = tokenDimensions
    .filter((dimension) =>
      ["estimated", "unavailable", "legacy_unknown"].includes(usage.availability[dimension]),
    )
    .map((dimension) => `${dimension}:${usage.availability[dimension]}`);
  return {
    usage,
    reconciled: ["reported", "derived"].includes(usage.availability.total),
    limitations,
  };
}

async function runBaselineTrial(input: {
  trial: BenchmarkScheduleEntry;
  task: BenchmarkTask;
  adapter: HostAdapter;
  repository: string;
  repositoryDigest: string;
  baseSha: string;
  hostVersion: string;
  policy: HostExecutionPolicy;
}): Promise<BenchmarkTrialResult> {
  const started = performance.now();
  const usages: TokenUsage[] = [];
  const failureTrace: string[] = [];
  const summaryEvidence: string[] = [];
  let resultStatus: "completed" | "blocked" | "failed" | "error" = "error";
  const capsule = ContextCapsuleSchema.parse({
    schemaVersion: 1,
    runId: randomUUID(),
    nodeId: `baseline-${input.task.id}`,
    objective: input.task.task,
    finishLine: { kind: "local_verified" },
    constraints: [
      "Work only in this repository.",
      "Follow repository instructions and run the declared checks.",
      "Do not commit, push, weaken checks, or claim completion without repository evidence.",
    ],
    acceptanceAnchors: [
      {
        id: "benchmark-outcome",
        description: "The task outcome must satisfy an immutable fixture-bound scorer",
        owner: "held_out_eval",
        evidenceSource: "benchmark harness",
        mutationPolicy: "immutable",
      },
    ],
    predecessorEvidence: [],
    relevantPaths: Object.keys(input.task.initialFiles).sort(),
    probeEvidence: [],
  });
  try {
    for await (const event of input.adapter.execute(
      {
        invocationId: input.trial.trialId,
        repositoryPath: input.repository,
        capsule,
        allowedTools: ["read", "write", "shell"],
      },
      new AbortController().signal,
    )) {
      if (event.type === "usage") usages.push(event.usage);
      if (event.type === "result") {
        resultStatus = event.result.status;
        summaryEvidence.push(event.result.summary, ...event.result.evidence);
      }
      if (event.type === "error") {
        resultStatus = "error";
        failureTrace.push(event.message);
      }
      if (event.type === "terminated") {
        resultStatus = "error";
        failureTrace.push(`${event.termination.cause}: ${event.termination.outcome}`);
      }
    }
  } catch (error) {
    if (error instanceof HostCapabilityAdmissionError) throw error;
    resultStatus = "error";
    failureTrace.push(error instanceof Error ? error.message : String(error));
  }
  const score = await scoreAcceptance(input.task, input.repository, summaryEvidence.join("\n"));
  failureTrace.push(
    ...score.results.filter(({ passed }) => !passed).map(({ summary }) => `acceptance: ${summary}`),
  );
  const tokens = usageSummary(usages);
  return BenchmarkTrialResultSchema.parse({
    trial: input.trial,
    hostVersion: input.hostVersion,
    modelPolicy: input.policy.model,
    effortPolicy: input.policy.effort,
    permissionPolicy: benchmarkPermissionPolicy(input.trial.host),
    acceptanceScorerDigest: score.expectedScorerDigest,
    observedScorerDigest: score.observedScorerDigest,
    scorerVerified: score.scorerVerified,
    repositoryDigest: input.repositoryDigest,
    baseSha: input.baseSha,
    executionStatus: resultStatus,
    accepted:
      resultStatus === "completed" &&
      score.scorerVerified &&
      score.results.every(({ passed }) => passed),
    acceptance: score.results,
    usage: tokens.usage,
    usageReconciled: tokens.reconciled,
    limitations: tokens.limitations,
    durationMs: Math.round(performance.now() - started),
    humanInterventions: 0,
    failureTrace,
  });
}

async function runGraphcraftTrial(input: {
  trial: BenchmarkScheduleEntry;
  task: BenchmarkTask;
  adapter: HostAdapter;
  repository: string;
  repositoryDigest: string;
  baseSha: string;
  hostVersion: string;
  policy: HostExecutionPolicy;
}): Promise<BenchmarkTrialResult> {
  const started = performance.now();
  const failureTrace: string[] = [];
  let executionStatus: "completed" | "blocked" | "failed" | "error" = "error";
  let acceptanceRepository = input.repository;
  let summaryEvidence = "";
  let tokens = usageSummary([]);
  try {
    const created = await createRun(input.task.task, {
      cwd: input.repository,
      planner: input.adapter,
      finishLine: "local_verified",
    });
    const state = await executeRun({ store: created.store, adapter: input.adapter, approve: true });
    const events = await created.store.loadEvents();
    const capabilityError = persistedCapabilityAdmissionError(events);
    if (capabilityError) throw capabilityError;
    executionStatus =
      state.status === "completed"
        ? "completed"
        : state.status === "blocked"
          ? "blocked"
          : "failed";
    const report = usageSummary(state.tokenLedger.map(({ usage }) => usage));
    tokens = report;
    const workspace = await created.store.loadWorkspace<{ path: string }>();
    acceptanceRepository = workspace.path;
    summaryEvidence = [
      ...Object.values(state.nodes)
        .map((node) => node.lastSummary)
        .filter((value): value is string => typeof value === "string"),
      ...state.latestProgressEvidence,
    ].join("\n");
    failureTrace.push(
      ...events
        .filter(({ type }) => type === "node.failed" || type === "run.blocked")
        .map(({ data }) => String(data.reason ?? "run blocked")),
    );
  } catch (error) {
    if (error instanceof HostCapabilityAdmissionError) throw error;
    failureTrace.push(error instanceof Error ? error.message : String(error));
  }
  const score = await scoreAcceptance(input.task, acceptanceRepository, summaryEvidence);
  failureTrace.push(
    ...score.results.filter(({ passed }) => !passed).map(({ summary }) => `acceptance: ${summary}`),
  );
  return BenchmarkTrialResultSchema.parse({
    trial: input.trial,
    hostVersion: input.hostVersion,
    modelPolicy: input.policy.model,
    effortPolicy: input.policy.effort,
    permissionPolicy: benchmarkPermissionPolicy(input.trial.host),
    acceptanceScorerDigest: score.expectedScorerDigest,
    observedScorerDigest: score.observedScorerDigest,
    scorerVerified: score.scorerVerified,
    repositoryDigest: input.repositoryDigest,
    baseSha: input.baseSha,
    executionStatus,
    accepted:
      executionStatus === "completed" &&
      score.scorerVerified &&
      score.results.every(({ passed }) => passed),
    acceptance: score.results,
    usage: tokens.usage,
    usageReconciled: tokens.reconciled,
    limitations: tokens.limitations,
    durationMs: Math.round(performance.now() - started),
    humanInterventions: 0,
    failureTrace,
  });
}

export async function runBenchmark(input: {
  suite: BenchmarkSuite;
  hosts: Array<"codex" | "claude">;
  adapters: Partial<Record<"codex" | "claude", HostAdapter>>;
  policies: Partial<Record<"codex" | "claude", HostExecutionPolicy>>;
  graphcraftVersion: string;
  seed: string;
  repetitions?: number;
  outputPath: string;
  observer?: (message: string) => void;
}): Promise<{ outputPath: string; report: BenchmarkReport }> {
  const suite = BenchmarkSuiteSchema.parse(input.suite);
  const graphcraftVersion = input.graphcraftVersion?.trim();
  if (!graphcraftVersion) throw new Error("A Graphcraft version identity is required");
  const hosts = [...new Set(input.hosts)].sort() as Array<"codex" | "claude">;
  if (hosts.length === 0) throw new Error("A benchmark requires at least one host");
  const policies: Partial<Record<"codex" | "claude", HostExecutionPolicy>> = {};
  for (const host of hosts) {
    const policy = input.policies[host];
    if (!policy?.model.trim()) throw new Error(`An explicit --${host}-model policy is required`);
    if (!["low", "medium", "high", "xhigh"].includes(policy.effort))
      throw new Error(`Unsupported ${host} benchmark effort policy: ${policy.effort}`);
    policies[host] = { model: policy.model.trim(), effort: policy.effort };
  }
  const efforts = new Set(hosts.map((host) => policies[host]!.effort));
  if (efforts.size !== 1)
    throw new Error("Matched cross-host benchmarks require one shared effort policy");
  const effortPolicy = policies[hosts[0]!]!.effort;
  const modelPolicy: { codex?: string; claude?: string } = {};
  for (const host of hosts) modelPolicy[host] = policies[host]!.model;
  const permissionPolicy: Partial<Record<"codex" | "claude", BenchmarkPermissionPolicy>> = {};
  for (const host of hosts) permissionPolicy[host] = benchmarkPermissionPolicy(host);
  const schedule = createBenchmarkSchedule({
    suite,
    hosts,
    seed: input.seed,
    ...(input.repetitions ? { repetitions: input.repetitions } : {}),
  });
  const outputPath = resolve(input.outputPath);
  const suiteDigest = contentHash(suite);
  const environment = {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    graphcraftVersion,
  };
  const byTask = new Map(suite.tasks.map((task) => [task.id, task]));
  let startedAt = new Date().toISOString();
  let results: BenchmarkTrialResult[] = [];
  let existingReport: BenchmarkReport | undefined;
  try {
    const existing = BenchmarkReportSchema.parse(JSON.parse(await readFile(outputPath, "utf8")));
    if (existing.environment.graphcraftVersion !== graphcraftVersion)
      throw new Error(
        "The existing benchmark report Graphcraft version identity does not match this execution",
      );
    if (
      existing.suite.id !== suite.id ||
      existing.suite.version !== suite.version ||
      existing.suite.digest !== suiteDigest ||
      existing.seed !== input.seed ||
      JSON.stringify(existing.modelPolicy) !== JSON.stringify(modelPolicy) ||
      existing.effortPolicy !== effortPolicy ||
      JSON.stringify(existing.permissionPolicy) !== JSON.stringify(permissionPolicy) ||
      JSON.stringify(existing.environment) !== JSON.stringify(environment) ||
      JSON.stringify(existing.schedule) !== JSON.stringify(schedule)
    )
      throw new Error("The existing benchmark report does not match this suite and schedule");
    startedAt = existing.startedAt;
    results = existing.results;
    existingReport = existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof SyntaxError)
        throw new Error(`Benchmark report is not valid JSON: ${outputPath}`);
      if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
    }
  }
  const scheduledIds = new Set(schedule.map(({ trialId }) => trialId));
  if (results.some(({ trial }) => !scheduledIds.has(trial.trialId)))
    throw new Error("The existing benchmark report contains a trial outside the current schedule");
  if (new Set(results.map(({ trial }) => trial.trialId)).size !== results.length)
    throw new Error("The existing benchmark report contains duplicated trial results");
  if (
    results.some(
      ({ trial, modelPolicy: resultModel, effortPolicy: resultEffort, ...result }) =>
        JSON.stringify(trial) !==
          JSON.stringify(schedule.find(({ trialId }) => trialId === trial.trialId)) ||
        resultModel !== policies[trial.host]!.model ||
        resultEffort !== policies[trial.host]!.effort ||
        result.permissionPolicy !== permissionPolicy[trial.host] ||
        result.repositoryDigest !== contentHash(byTask.get(trial.taskId)!.initialFiles) ||
        result.acceptanceScorerDigest !==
          scorerDigest(byTask.get(trial.taskId)!, expectedScorerFiles(byTask.get(trial.taskId)!)) ||
        result.scorerVerified !== (result.acceptanceScorerDigest === result.observedScorerDigest) ||
        result.acceptance.length !==
          byTask.get(trial.taskId)!.checks.length + byTask.get(trial.taskId)!.acceptance.length ||
        result.accepted !==
          (result.executionStatus === "completed" &&
            result.scorerVerified &&
            result.acceptance.every(({ passed }) => passed)),
    )
  )
    throw new Error("The existing benchmark report contains mismatched trial controls");
  if (existingReport?.status === "complete" && results.length !== schedule.length)
    throw new Error("The complete benchmark report does not cover the exact current schedule");
  if (
    existingReport &&
    contentHash(existingReport.summary) !== contentHash(summarizeBenchmark(results, schedule))
  )
    throw new Error("The existing benchmark report summary does not match its trial evidence");
  if (existingReport && contentHash(existingReport.limitations) !== contentHash(reportLimitations))
    throw new Error("The existing benchmark report limitations do not match this harness");
  if (existingReport?.status === "complete") return { outputPath, report: existingReport };
  const persist = async (status: "running" | "complete"): Promise<BenchmarkReport> => {
    const report = BenchmarkReportSchema.parse(
      redactValue({
        schemaVersion: 2,
        status,
        suite: { id: suite.id, version: suite.version, digest: suiteDigest },
        startedAt,
        updatedAt: new Date().toISOString(),
        seed: input.seed,
        randomized: true,
        modelPolicy,
        effortPolicy,
        permissionPolicy,
        scorerPolicy,
        environment,
        limitations: reportLimitations,
        schedule,
        results,
        summary: summarizeBenchmark(results, schedule),
      }),
    );
    await writeJsonAtomic(outputPath, report);
    return report;
  };
  for (const host of hosts) {
    const adapter = input.adapters[host];
    if (!adapter) throw new Error(`No ${host} benchmark adapter was configured`);
    const capabilities = await adapter.probe();
    assertRequiredHostCapabilities(host, capabilities);
  }
  await persist("running");
  const completedTrialIds = new Set(results.map(({ trial }) => trial.trialId));
  for (const trial of schedule) {
    if (completedTrialIds.has(trial.trialId)) continue;
    const task = byTask.get(trial.taskId)!;
    const adapter = input.adapters[trial.host]!;
    input.observer?.(
      `[${trial.order + 1}/${schedule.length}] ${trial.host} ${trial.mode} ${trial.taskId} #${trial.repetition}`,
    );
    const fixture = await materializeTask(task);
    try {
      const capabilities = await adapter.probe();
      assertRequiredHostCapabilities(trial.host, capabilities);
      const hostVersion = capabilities.version ?? "unknown";
      const result =
        trial.mode === "baseline"
          ? await runBaselineTrial({
              trial,
              task,
              adapter,
              repository: fixture.repository,
              repositoryDigest: fixture.repositoryDigest,
              baseSha: fixture.baseSha,
              hostVersion,
              policy: policies[trial.host]!,
            })
          : await runGraphcraftTrial({
              trial,
              task,
              adapter,
              repository: fixture.repository,
              repositoryDigest: fixture.repositoryDigest,
              baseSha: fixture.baseSha,
              hostVersion,
              policy: policies[trial.host]!,
            });
      const finalCapabilities = await adapter.probe();
      assertRequiredHostCapabilities(trial.host, finalCapabilities);
      if (
        finalCapabilities.version !== capabilities.version ||
        finalCapabilities.protocolProfile !== capabilities.protocolProfile
      ) {
        throw new Error(
          `${trial.host} protocol identity changed during benchmark trial ${trial.trialId}; refusing stale host-version evidence`,
        );
      }
      results.push(result);
    } finally {
      await removeBenchmarkFixture(fixture.repository);
    }
    completedTrialIds.add(trial.trialId);
    await persist("running");
  }
  const report = await persist("complete");
  return { outputPath, report };
}
