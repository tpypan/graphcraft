import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  BenchmarkSuiteSchema,
  BenchmarkReportSchema,
  BenchmarkTrialResultSchema,
  ContextCapsuleSchema,
  aggregateTokenUsage,
  contentHash,
  createBenchmarkSchedule,
  summarizeBenchmark,
  unavailableTokenUsage,
  type BenchmarkScheduleEntry,
  type BenchmarkReport,
  type BenchmarkSuite,
  type BenchmarkTask,
  type BenchmarkTrialResult,
  type HostAdapter,
  type HostExecutionPolicy,
  type TokenUsage,
} from "@graphcraft/core";
import { runProcess } from "@graphcraft/probes";
import { createRun, executeRun } from "./runner.ts";

const tokenDimensions = [
  "input",
  "cachedInput",
  "uncachedInput",
  "output",
  "reasoning",
  "total",
] as const;
const permissionPolicy = "local_read_write_shell_no_external" as const;
const scorerPolicy = "declared_checks_plus_suite_assertions" as const;

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
  for (const [path, value] of Object.entries(task.initialFiles)) {
    const target = safeFixturePath(repository, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value, "utf8");
  }
  const initialized = await runProcess("git", ["init", "-b", "main"], { cwd: repository });
  if (initialized.exitCode !== 0) throw new Error(`Unable to initialize ${task.id}`);
  await runProcess("git", ["add", "."], { cwd: repository });
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
}

async function scoreAcceptance(
  task: BenchmarkTask,
  repository: string,
  summaryEvidence = "",
): Promise<Array<{ path: string; passed: boolean; summary: string }>> {
  const results: Array<{ path: string; passed: boolean; summary: string }> = [];
  for (const [index, check] of task.checks.entries()) {
    try {
      const result = await runProcess(check.command, check.args, {
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
    }
  }
  for (const assertion of task.acceptance) {
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
  }
  return results;
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
  return { usage, reconciled: limitations.length === 0, limitations };
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
        description: "The task outcome must satisfy an external deterministic scorer",
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
    resultStatus = "error";
    failureTrace.push(error instanceof Error ? error.message : String(error));
  }
  const acceptance = await scoreAcceptance(
    input.task,
    input.repository,
    summaryEvidence.join("\n"),
  );
  failureTrace.push(
    ...acceptance.filter(({ passed }) => !passed).map(({ summary }) => `acceptance: ${summary}`),
  );
  const tokens = usageSummary(usages);
  return BenchmarkTrialResultSchema.parse({
    trial: input.trial,
    hostVersion: input.hostVersion,
    modelPolicy: input.policy.model,
    effortPolicy: input.policy.effort,
    permissionPolicy,
    acceptanceScorerDigest: contentHash({
      checks: input.task.checks,
      acceptance: input.task.acceptance,
    }),
    repositoryDigest: input.repositoryDigest,
    baseSha: input.baseSha,
    executionStatus: resultStatus,
    accepted: resultStatus === "completed" && acceptance.every(({ passed }) => passed),
    acceptance,
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
    const events = await created.store.loadEvents();
    failureTrace.push(
      ...events
        .filter(({ type }) => type === "node.failed" || type === "run.blocked")
        .map(({ data }) => String(data.reason ?? "run blocked")),
    );
  } catch (error) {
    failureTrace.push(error instanceof Error ? error.message : String(error));
  }
  const acceptance = await scoreAcceptance(input.task, acceptanceRepository, summaryEvidence);
  failureTrace.push(
    ...acceptance.filter(({ passed }) => !passed).map(({ summary }) => `acceptance: ${summary}`),
  );
  return BenchmarkTrialResultSchema.parse({
    trial: input.trial,
    hostVersion: input.hostVersion,
    modelPolicy: input.policy.model,
    effortPolicy: input.policy.effort,
    permissionPolicy,
    acceptanceScorerDigest: contentHash({
      checks: input.task.checks,
      acceptance: input.task.acceptance,
    }),
    repositoryDigest: input.repositoryDigest,
    baseSha: input.baseSha,
    executionStatus,
    accepted: executionStatus === "completed" && acceptance.every(({ passed }) => passed),
    acceptance,
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
  seed: string;
  repetitions?: number;
  outputPath: string;
  observer?: (message: string) => void;
}): Promise<{ outputPath: string; report: BenchmarkReport }> {
  const suite = BenchmarkSuiteSchema.parse(input.suite);
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
  };
  const byTask = new Map(suite.tasks.map((task) => [task.id, task]));
  let startedAt = new Date().toISOString();
  let results: BenchmarkTrialResult[] = [];
  let existingReport: BenchmarkReport | undefined;
  try {
    const existing = BenchmarkReportSchema.parse(JSON.parse(await readFile(outputPath, "utf8")));
    if (
      existing.suite.id !== suite.id ||
      existing.suite.version !== suite.version ||
      existing.suite.digest !== suiteDigest ||
      existing.seed !== input.seed ||
      JSON.stringify(existing.modelPolicy) !== JSON.stringify(modelPolicy) ||
      existing.effortPolicy !== effortPolicy ||
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
        result.repositoryDigest !== contentHash(byTask.get(trial.taskId)!.initialFiles) ||
        result.acceptanceScorerDigest !==
          contentHash({
            checks: byTask.get(trial.taskId)!.checks,
            acceptance: byTask.get(trial.taskId)!.acceptance,
          }) ||
        result.acceptance.length !==
          byTask.get(trial.taskId)!.checks.length + byTask.get(trial.taskId)!.acceptance.length ||
        result.accepted !==
          (result.executionStatus === "completed" &&
            result.acceptance.every(({ passed }) => passed)),
    )
  )
    throw new Error("The existing benchmark report contains mismatched trial controls");
  if (existingReport?.status === "complete") return { outputPath, report: existingReport };
  const limitations = [
    "Stable efficiency claims require at least three complete trials per task and host.",
    "Blinded human defect review remains outside this deterministic harness slice.",
  ];
  const persist = async (status: "running" | "complete"): Promise<BenchmarkReport> => {
    const report = BenchmarkReportSchema.parse({
      schemaVersion: 1,
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
      limitations,
      schedule,
      results,
      summary: summarizeBenchmark(results, schedule),
    });
    await mkdir(dirname(outputPath), { recursive: true });
    const temporary = `${outputPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await rename(temporary, outputPath);
    return report;
  };
  const hostVersions = new Map<string, string>();
  for (const host of hosts) {
    const adapter = input.adapters[host];
    if (!adapter) throw new Error(`No ${host} benchmark adapter was configured`);
    const capabilities = await adapter.probe();
    if (!capabilities.installed || !capabilities.authenticated || !capabilities.structuredOutput)
      throw new Error(`${host} is not ready for structured benchmark execution`);
    hostVersions.set(host, capabilities.version ?? "unknown");
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
      results.push(
        trial.mode === "baseline"
          ? await runBaselineTrial({
              trial,
              task,
              adapter,
              repository: fixture.repository,
              repositoryDigest: fixture.repositoryDigest,
              baseSha: fixture.baseSha,
              hostVersion: hostVersions.get(trial.host)!,
              policy: policies[trial.host]!,
            })
          : await runGraphcraftTrial({
              trial,
              task,
              adapter,
              repository: fixture.repository,
              repositoryDigest: fixture.repositoryDigest,
              baseSha: fixture.baseSha,
              hostVersion: hostVersions.get(trial.host)!,
              policy: policies[trial.host]!,
            }),
      );
    } finally {
      await rm(fixture.repository, { recursive: true, force: true });
    }
    completedTrialIds.add(trial.trialId);
    await persist("running");
  }
  const report = await persist("complete");
  return { outputPath, report };
}
