#!/usr/bin/env node
import { Command, Option } from "commander";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import stableBenchmarkSuite from "../../../benchmarks/stable-v1.json" with { type: "json" };
import {
  askForApproval,
  assessTaskShape,
  consoleObserver,
  contractView,
  createAdapter,
  GRAPHCRAFT_VERSION,
  handleAction,
  installHost,
  loadRunList,
  prepareFinishLine,
  recoveryHint,
  renderContract,
  renderRunInspection,
  renderRunList,
  renderRunStatus,
  stateView,
  storeFor,
  supervisorView,
  uninstallHost,
  updateHost,
  validateLocalViewerUrl,
  type HostName,
  type ExecutableFinishLine,
} from "./index.ts";
import {
  createRun,
  DEFAULT_BENCHMARK_MODEL_CALL_TIMEOUT_MS,
  applyCompletedRunPrune,
  applyRunRetention,
  discoverRepository,
  executeRun,
  exportBlindedBenchmarkReview,
  inspectSupervisorRecord,
  listSupervisorRecords,
  loadBenchmarkSuite,
  inspectBenchmarkSourceIdentity,
  planCompletedRunPrune,
  planRunRetention,
  readBenchmarkBlindingKeyFromStdin,
  redactString,
  redactValue,
  renderBenchmarkPublicationReport,
  runBenchmark,
  startDetachedSupervisor,
  startRunViewer,
  superviseRun,
  type SupervisorLauncher,
} from "@graphcraft/runtime";
import {
  BenchmarkSuiteSchema,
  BenchmarkSourceIdentitySchema,
  MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  createBenchmarkSchedule,
  type BenchmarkSourceIdentity,
  type GraphAmendment,
  type HostExecutionPolicy,
  type ProbePlan,
} from "@graphcraft/core";
import { captureGitHubPullRequestSnapshot } from "@graphcraft/github";

const program = new Command()
  .name("graphcraft")
  .description("Progress-aware execution for durable coding agents")
  .version(GRAPHCRAFT_VERSION)
  .showSuggestionAfterError();

declare const __GRAPHCRAFT_SOURCE_SHA__: string | undefined;
declare const __GRAPHCRAFT_SOURCE_DIRTY__: boolean | undefined;
declare const __GRAPHCRAFT_SOURCE_STATUS_DIGEST__: string | null | undefined;

async function benchmarkSourceIdentity(): Promise<BenchmarkSourceIdentity> {
  if (
    typeof __GRAPHCRAFT_SOURCE_SHA__ === "string" &&
    typeof __GRAPHCRAFT_SOURCE_DIRTY__ === "boolean"
  ) {
    return BenchmarkSourceIdentitySchema.parse({
      commitSha: __GRAPHCRAFT_SOURCE_SHA__,
      dirty: __GRAPHCRAFT_SOURCE_DIRTY__,
      dirtyStatusDigest:
        typeof __GRAPHCRAFT_SOURCE_STATUS_DIGEST__ === "string"
          ? __GRAPHCRAFT_SOURCE_STATUS_DIGEST__
          : null,
    });
  }

  let candidate = dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(join(candidate, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (metadata.name === "@tpypan/graphcraft")
        return await inspectBenchmarkSourceIdentity(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (candidate === parent || candidate === parse(candidate).root) break;
    candidate = parent;
  }
  throw new Error("Unable to locate the Graphcraft source repository for benchmark provenance");
}

const hostOption = new Option("--host <host>", "coding-agent host")
  .choices(["codex", "claude"])
  .default("codex");

async function benchmarkSuite(path: string) {
  return path === "stable-v1"
    ? BenchmarkSuiteSchema.parse(stableBenchmarkSuite)
    : await loadBenchmarkSuite(path);
}

async function withBenchmarkBlindingKey<T>(operation: (key: Buffer) => Promise<T>): Promise<T> {
  const key = await readBenchmarkBlindingKeyFromStdin(process.stdin);
  try {
    return await operation(key);
  } finally {
    key.fill(0);
  }
}

function collectScope(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function executionSignal(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cancel = (): void =>
    controller.abort({ cause: "cancellation", reason: "Cancelled by SIGINT" });
  const shutdown = (): void =>
    controller.abort({ cause: "runtime_shutdown", reason: "Runtime received SIGTERM" });
  process.once("SIGINT", cancel);
  process.once("SIGTERM", shutdown);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", shutdown);
    },
  };
}

function currentSupervisorLauncher(): SupervisorLauncher {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error("Cannot resolve the Graphcraft executable for supervision");
  return {
    command: process.execPath,
    args: [...process.execArgv.filter((argument) => !argument.startsWith("--inspect")), entrypoint],
  };
}

async function openLocalUrl(url: string): Promise<void> {
  const localUrl = validateLocalViewerUrl(url);
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", localUrl] : [localUrl];
  const child = spawn(command, args, { detached: true, shell: false, stdio: "ignore" });
  await new Promise<void>((resolveOpen, reject) => {
    child.once("error", reject);
    child.once("spawn", resolveOpen);
  });
  child.unref();
}

program
  .command("benchmark")
  .description("Run a randomized matched Graphcraft and baseline evaluation suite")
  .argument("<suite>", "versioned benchmark suite JSON")
  .option("-C, --cwd <path>", "repository used to store local reports", process.cwd())
  .addOption(
    new Option("--host <host>", "host or hosts to evaluate")
      .choices(["codex", "claude", "both"])
      .default("both"),
  )
  .option("--repetitions <count>", "override repetitions per task, host, and mode")
  .option("--seed <seed>", "deterministic schedule seed", "graphcraft-stable-v1")
  .option(
    "--model-call-timeout-ms <milliseconds>",
    "maximum duration of each benchmark model call",
    String(DEFAULT_BENCHMARK_MODEL_CALL_TIMEOUT_MS),
  )
  .option("--output <path>", "report path")
  .option("--codex-model <model>", "exact Codex model used for every Codex trial")
  .option("--claude-model <model>", "exact Claude model used for every Claude trial")
  .addOption(
    new Option("--effort <effort>", "shared effort used for every trial").choices([
      "low",
      "medium",
      "high",
      "xhigh",
    ]),
  )
  .option("--dry-run", "validate and print the randomized schedule without model calls")
  .action(
    async (
      suitePath: string,
      options: {
        cwd: string;
        host: "codex" | "claude" | "both";
        repetitions?: string;
        seed: string;
        modelCallTimeoutMs: string;
        output?: string;
        codexModel?: string;
        claudeModel?: string;
        effort?: HostExecutionPolicy["effort"];
        dryRun?: boolean;
      },
    ) => {
      const suite = await benchmarkSuite(suitePath);
      const hosts: Array<"codex" | "claude"> =
        options.host === "both" ? ["codex", "claude"] : [options.host];
      const repetitions = options.repetitions ? Number(options.repetitions) : undefined;
      if (repetitions !== undefined && (!Number.isInteger(repetitions) || repetitions <= 0))
        throw new Error("--repetitions must be a positive integer");
      const schedule = createBenchmarkSchedule({
        suite,
        hosts,
        seed: options.seed,
        ...(repetitions ? { repetitions } : {}),
      });
      if (options.dryRun) {
        console.log(
          JSON.stringify(
            {
              suite: { id: suite.id, version: suite.version, tasks: suite.tasks.length },
              trials: schedule.length,
              seed: options.seed,
              schedule,
            },
            null,
            2,
          ),
        );
        return;
      }
      if (!options.effort) throw new Error("--effort is required for benchmark execution");
      const modelCallTimeoutMs = Number(options.modelCallTimeoutMs);
      if (
        !Number.isSafeInteger(modelCallTimeoutMs) ||
        modelCallTimeoutMs <= 0 ||
        modelCallTimeoutMs > MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS
      )
        throw new Error(
          `--model-call-timeout-ms must be an integer between 1 and ${MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS}`,
        );
      const policies: Partial<Record<HostName, HostExecutionPolicy>> = {};
      for (const host of hosts) {
        const model = host === "codex" ? options.codexModel : options.claudeModel;
        if (!model?.trim()) throw new Error(`--${host}-model is required for ${host} trials`);
        policies[host] = { model: model.trim(), effort: options.effort };
      }
      const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
      const outputPath = resolve(
        options.output ??
          join(options.cwd, ".graphcraft", "benchmarks", suite.id, `${timestamp}.json`),
      );
      const adapters = Object.fromEntries(
        hosts.map((host) => [host, createAdapter(host, policies[host])]),
      );
      const graphcraftSource = await benchmarkSourceIdentity();
      const execution = executionSignal();
      let result;
      try {
        result = await runBenchmark({
          suite,
          hosts,
          adapters,
          policies,
          graphcraftVersion: GRAPHCRAFT_VERSION,
          graphcraftSource,
          seed: options.seed,
          ...(repetitions ? { repetitions } : {}),
          outputPath,
          signal: execution.signal,
          modelCallTimeoutMs,
          observer: (message) => console.log(message),
        });
      } finally {
        execution.dispose();
      }
      console.log(
        JSON.stringify({ outputPath: result.outputPath, summary: result.report.summary }, null, 2),
      );
    },
  );

program
  .command("benchmark-review")
  .description("Export deterministic opaque packets for blinded benchmark defect review")
  .argument("<report>", "complete schema-3 benchmark report")
  .option("--suite <suite>", "exact benchmark suite JSON", "stable-v1")
  .requiredOption(
    "--blinding-key-stdin",
    "read the 32-byte hexadecimal blinding key from standard input",
  )
  .requiredOption("--output <path>", "separate blinded-review JSON path")
  .action(
    async (
      report: string,
      options: {
        suite: string;
        blindingKeyStdin: boolean;
        output: string;
      },
    ) => {
      console.log(
        JSON.stringify(
          await withBenchmarkBlindingKey(
            async (blindingKey) =>
              await exportBlindedBenchmarkReview({
                reportPath: report,
                suite: await benchmarkSuite(options.suite),
                blindingKey,
                outputPath: options.output,
              }),
          ),
          null,
          2,
        ),
      );
    },
  );

program
  .command("benchmark-report")
  .description("Render a validated benchmark report from raw evidence and blinded labels")
  .argument("<report>", "complete schema-3 benchmark report")
  .option("--suite <suite>", "exact benchmark suite JSON", "stable-v1")
  .requiredOption(
    "--blinding-key-stdin",
    "read the same 32-byte hexadecimal blinding key from standard input",
  )
  .requiredOption("--labels <path>", "completed digest-bound review-label JSON")
  .requiredOption("--output <path>", "separate Markdown report path")
  .action(
    async (
      report: string,
      options: {
        suite: string;
        blindingKeyStdin: boolean;
        labels: string;
        output: string;
      },
    ) => {
      console.log(
        JSON.stringify(
          await withBenchmarkBlindingKey(
            async (blindingKey) =>
              await renderBenchmarkPublicationReport({
                reportPath: report,
                suite: await benchmarkSuite(options.suite),
                blindingKey,
                labelsPath: options.labels,
                outputPath: options.output,
              }),
          ),
          null,
          2,
        ),
      );
    },
  );

program
  .command("install")
  .description("Register the bundled Graphcraft MCP server with a coding-agent host")
  .addOption(
    new Option("--host <host>", "host to configure")
      .choices(["codex", "claude"])
      .makeOptionMandatory(),
  )
  .action(async (options: { host: HostName }) => {
    await installHost(options.host);
    console.log(
      `Graphcraft is registered with ${options.host}. Start a new agent session to use it.`,
    );
  });

program
  .command("uninstall")
  .description("Remove Graphcraft MCP registration from a coding-agent host")
  .addOption(
    new Option("--host <host>", "host to configure")
      .choices(["codex", "claude"])
      .makeOptionMandatory(),
  )
  .action(async (options: { host: HostName }) => {
    await uninstallHost(options.host);
    console.log(`Graphcraft was removed from ${options.host}.`);
  });

program
  .command("update")
  .description("Replace the registered Graphcraft MCP runtime with this package version")
  .addOption(
    new Option("--host <host>", "host to configure")
      .choices(["codex", "claude"])
      .makeOptionMandatory(),
  )
  .action(async (options: { host: HostName }) => {
    const result = await updateHost(options.host);
    console.log(
      `Graphcraft ${result.graphcraftVersion} is registered with ${options.host}. Start a new agent session to use it.`,
    );
  });

program
  .command("run")
  .description("Compile and execute a durable task graph")
  .argument("<task>", "task and user-owned finish line")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .option("-y, --yes", "approve the displayed contract non-interactively")
  .option("--force", "force Graphcraft for a small task")
  .option("--json", "emit machine-readable progress")
  .option("--background", "continue under a detached local supervisor")
  .option("--include <glob>", "approved repository path glob (repeatable)", collectScope)
  .option("--exclude <glob>", "excluded repository path glob (repeatable)", collectScope)
  .addOption(
    new Option("--max-workers <count>", "maximum concurrent read-only workers")
      .choices(["1", "2"])
      .default("1"),
  )
  .addOption(hostOption)
  .addOption(
    new Option("--finish-line <finish-line>", "finish line").choices([
      "local_verified",
      "committed",
      "pushed",
      "pr_open",
      "pr_green",
    ]),
  )
  .action(
    async (
      task: string,
      options: {
        cwd: string;
        yes?: boolean;
        force?: boolean;
        json?: boolean;
        background?: boolean;
        include?: string[];
        exclude?: string[];
        host: HostName;
        maxWorkers: "1" | "2";
        finishLine?: ExecutableFinishLine;
      },
    ) => {
      const taskShape = assessTaskShape(task);
      if (!options.force && taskShape.bypass) {
        console.log(
          `Graphcraft is not needed for this localized task (shape score ${taskShape.score}). Use --force to override.`,
        );
        return;
      }
      const finishLine = await prepareFinishLine(task, options.cwd, options.finishLine);
      const adapter = createAdapter(options.host);
      const planning = executionSignal();
      const created = await createRun(task, {
        cwd: options.cwd,
        planner: adapter,
        signal: planning.signal,
        finishLine,
        ...(options.include ? { include: options.include } : {}),
        ...(options.exclude ? { exclude: options.exclude } : {}),
      }).finally(planning.dispose);
      const approved =
        options.yes || (await askForApproval(created.contract, created.graph, created.probePlan));
      if (!approved) {
        console.log(renderContract(created.contract, created.graph, created.probePlan));
        console.log(
          `Run saved for approval. Resume with: graphcraft resume ${created.contract.runId}`,
        );
        return;
      }
      if (options.background) {
        const supervisor = await startDetachedSupervisor({
          repositoryRoot: created.store.repositoryRoot,
          runId: created.store.runId,
          host: options.host,
          maxWorkers: Number(options.maxWorkers) as 1 | 2,
          launcher: currentSupervisorLauncher(),
        });
        console.log(JSON.stringify({ runId: created.store.runId, supervisor }, null, 2));
        return;
      }
      const execution = executionSignal();
      const state = await executeRun({
        store: created.store,
        adapter,
        approve: true,
        observer: consoleObserver(options.json),
        signal: execution.signal,
        maxWorkers: Number(options.maxWorkers) as 1 | 2,
      }).finally(execution.dispose);
      console.log(JSON.stringify(stateView(state, created.contract), null, options.json ? 0 : 2));
      if (state.status !== "completed") process.exitCode = 2;
    },
  );

program
  .command("status")
  .description("Show concise durable run state")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .option("--json", "emit JSON")
  .action(async (run: string | undefined, options: { cwd: string; json?: boolean }) => {
    const store = await storeFor(options.cwd, run);
    const [state, contract, graph] = await Promise.all([
      store.loadState(),
      store.loadContract(),
      store.loadGraph(),
    ]);
    const view = {
      ...stateView(state, contract),
      supervisor: await supervisorView(store.repositoryRoot, store.runId),
    };
    console.log(options.json ? JSON.stringify(view) : renderRunStatus(state, contract, graph));
  });

program
  .command("runs")
  .description("List durable runs in stable updated order")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .option("--json", "emit JSON")
  .action(async (options: { cwd: string; json?: boolean }) => {
    const entries = await loadRunList(options.cwd);
    console.log(options.json ? JSON.stringify(entries) : renderRunList(entries));
  });

program
  .command("delete")
  .description("Plan deletion of one completed, stopped, or blocked run's Graphcraft state")
  .argument("<run>", "explicit run ID or unique prefix for a dry run")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .option("--yes", "apply the plan; requires the exact full run ID")
  .option("--json", "emit JSON")
  .action(async (run: string, options: { cwd: string; yes?: boolean; json?: boolean }) => {
    const repository = await discoverRepository(options.cwd);
    const plan = await planRunRetention({
      repositoryRoot: repository.root,
      runReference: run,
    });
    if (!options.yes) {
      if (options.json) console.log(JSON.stringify({ dryRun: true, plan }));
      else
        console.log(
          [
            "Dry run: no files deleted.",
            `Run            ${plan.runId}`,
            `State          ${plan.state.status}`,
            `Delete         ${plan.deletePaths.join("\n               ")}`,
            `Preserve       ${plan.preservedWorkspace.path}`,
            `Branch         ${plan.preservedWorkspace.branch}`,
            ...(plan.state.status === "completed"
              ? []
              : [`Warning        ${plan.state.status} run state may still be resumable`]),
            `Apply          graphcraft delete ${plan.runId} --yes`,
          ].join("\n"),
        );
      return;
    }
    if (run !== plan.runId)
      throw new Error(
        `Deletion requires the exact run ID. Re-run: graphcraft delete ${plan.runId} --yes`,
      );
    const result = await applyRunRetention({ plan, confirmRunId: run });
    if (options.json) console.log(JSON.stringify({ dryRun: false, result }));
    else
      console.log(
        [
          `Deleted run state ${result.runId}.`,
          `Removed        ${result.deletedPaths.length} Graphcraft paths`,
          `Preserved      ${result.preservedWorkspace.path}`,
          `Branch         ${result.preservedWorkspace.branch}`,
        ].join("\n"),
      );
  });

program
  .command("prune")
  .description("Plan deletion of completed runs older than an ISO date-time")
  .requiredOption("--completed-before <date>", "strict ISO date-time cutoff")
  .option("--keep <count>", "keep the newest eligible runs", "0")
  .option("--confirm-run <id>", "exact run ID from the reviewed dry-run (repeatable)", collectScope)
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .option("--yes", "apply the revalidated completed-run plan")
  .option("--json", "emit JSON")
  .action(
    async (options: {
      completedBefore: string;
      keep: string;
      cwd: string;
      yes?: boolean;
      json?: boolean;
      confirmRun?: string[];
    }) => {
      const keepNewest = Number(options.keep);
      const repository = await discoverRepository(options.cwd);
      const plan = await planCompletedRunPrune({
        repositoryRoot: repository.root,
        completedBefore: options.completedBefore,
        keepNewest,
      });
      if (!options.yes) {
        if (options.json) console.log(JSON.stringify({ dryRun: true, plan }));
        else
          console.log(
            [
              "Dry run: no files deleted.",
              `Cutoff         ${plan.completedBefore}`,
              `Keep newest    ${plan.keepNewest}`,
              `Delete         ${plan.deletionPlans.map(({ runId }) => runId).join(", ") || "none"}`,
              `Preserve       ${plan.keptRunIds.join(", ") || "none"}`,
              `Confirm        ${plan.deletionPlans.map(({ runId }) => `--confirm-run ${runId}`).join("\n               ") || "none"}`,
              "Apply          repeat this command with --yes and every confirmation above",
            ].join("\n"),
          );
        return;
      }
      const result = await applyCompletedRunPrune({
        plan,
        confirmRunIds: options.confirmRun ?? [],
      });
      if (options.json) console.log(JSON.stringify({ dryRun: false, result }));
      else
        console.log(
          result.length === 0
            ? "No completed runs matched the retention plan."
            : `Deleted Graphcraft state for ${result.map(({ runId }) => runId).join(", ")}.`,
        );
    },
  );

program
  .command("inspect")
  .description("Show the contract, graph, anchors, and state")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .option("--json", "emit JSON")
  .action(async (run: string | undefined, options: { cwd: string; json?: boolean }) => {
    if (options.json) {
      console.log(
        JSON.stringify(
          await handleAction({
            action: "inspect",
            repository: options.cwd,
            ...(run ? { run } : {}),
          }),
        ),
      );
      return;
    }
    const store = await storeFor(options.cwd, run);
    const [state, contract, graph, graphHistory, artifactInventory] = await Promise.all([
      store.loadState(),
      store.loadContract(),
      store.loadGraph(),
      store.loadGraphHistory(),
      store.loadArtifactInventory(),
    ]);
    console.log(renderRunInspection({ state, contract, graph, graphHistory, artifactInventory }));
  });

program
  .command("probes")
  .description("Show or replace the deterministic probe plan before approval")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .option("--set <file>", "replace the probe plan from a JSON file")
  .action(async (run: string | undefined, options: { cwd: string; set?: string }) => {
    const probePlan = options.set
      ? (JSON.parse(await readFile(options.set, "utf8")) as ProbePlan)
      : undefined;
    const result = await handleAction({
      action: "probes",
      repository: options.cwd,
      ...(run ? { run } : {}),
      ...(probePlan ? { probePlan } : {}),
    });
    console.log(JSON.stringify(options.set ? result : result.probePlan, null, 2));
  });

program
  .command("amend")
  .description("Apply an evidence-backed amendment to unfinished graph work")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .requiredOption("--set <file>", "graph amendment proposal JSON file")
  .option("--approve", "record explicit user approval for authority expansion")
  .action(
    async (run: string | undefined, options: { cwd: string; set: string; approve?: boolean }) => {
      const amendment = JSON.parse(await readFile(options.set, "utf8")) as GraphAmendment;
      console.log(
        JSON.stringify(
          await handleAction({
            action: "amend",
            repository: options.cwd,
            ...(run ? { run } : {}),
            amendment,
            approve: options.approve ?? false,
          }),
          null,
          2,
        ),
      );
    },
  );

program
  .command("decide")
  .description("Resolve a durable control decision as an authorized user-owned source")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .requiredOption("--source <id>", "user-owned control source")
  .requiredOption("--target <id>", "controlled node")
  .addOption(
    new Option("--verdict <verdict>", "decision")
      .choices(["approve", "veto"])
      .makeOptionMandatory(),
  )
  .requiredOption("--reason <reason>", "decision rationale")
  .option("--evidence <text...>", "supporting evidence")
  .option("--replace <decision>", "explicitly replace a sticky decision")
  .action(
    async (
      run: string | undefined,
      options: {
        cwd: string;
        source: string;
        target: string;
        verdict: "approve" | "veto";
        reason: string;
        evidence?: string[];
        replace?: string;
      },
    ) => {
      console.log(
        JSON.stringify(
          await handleAction({
            action: "decide",
            repository: options.cwd,
            ...(run ? { run } : {}),
            controlSource: options.source,
            controlTarget: options.target,
            controlVerdict: options.verdict,
            rationale: options.reason,
            ...(options.evidence ? { evidence: options.evidence } : {}),
            ...(options.replace ? { replaces: options.replace } : {}),
          }),
          null,
          2,
        ),
      );
    },
  );

program
  .command("resume")
  .description("Resume a checkpointed run without repeating accepted nodes")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .option("-y, --yes", "approve a pending contract")
  .option("--json", "emit machine-readable progress")
  .option("--background", "continue under a detached local supervisor")
  .addOption(
    new Option("--max-workers <count>", "maximum concurrent read-only workers")
      .choices(["1", "2"])
      .default("1"),
  )
  .addOption(hostOption)
  .action(
    async (
      run: string | undefined,
      options: {
        cwd: string;
        yes?: boolean;
        json?: boolean;
        background?: boolean;
        host: HostName;
        maxWorkers: "1" | "2";
      },
    ) => {
      const store = await storeFor(options.cwd, run);
      const contract = await store.loadContract();
      const graph = await store.loadGraph();
      const probePlan = await store.loadProbePlan();
      const state = await store.loadState();
      const finishLine = contract.finishLine.kind;
      if (
        state.status === "awaiting_approval" &&
        (finishLine === "pushed" || finishLine === "pr_open" || finishLine === "pr_green")
      )
        await prepareFinishLine(contract.task, store.repositoryRoot, finishLine);
      const approved =
        state.status !== "awaiting_approval" ||
        options.yes ||
        (await askForApproval(contract, graph, probePlan));
      if (!approved) {
        console.log(
          JSON.stringify(
            { approvalRequired: true, contract: contractView(contract, graph, probePlan) },
            null,
            2,
          ),
        );
        return;
      }
      if (options.background) {
        const supervisor = await startDetachedSupervisor({
          repositoryRoot: store.repositoryRoot,
          runId: store.runId,
          host: options.host,
          maxWorkers: Number(options.maxWorkers) as 1 | 2,
          launcher: currentSupervisorLauncher(),
        });
        console.log(JSON.stringify({ runId: store.runId, supervisor }, null, 2));
        return;
      }
      const execution = executionSignal();
      const resumed = await executeRun({
        store,
        adapter: createAdapter(options.host),
        approve: true,
        observer: consoleObserver(options.json),
        signal: execution.signal,
        maxWorkers: Number(options.maxWorkers) as 1 | 2,
      }).finally(execution.dispose);
      console.log(JSON.stringify(stateView(resumed, contract), null, options.json ? 0 : 2));
      if (resumed.status !== "completed") process.exitCode = 2;
    },
  );

program
  .command("supervisors")
  .description("Show the local supervisor lifecycle for a durable run")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .action(async (run: string | undefined, options: { cwd: string }) => {
    const store = await storeFor(options.cwd, run);
    const records = await listSupervisorRecords(store.repositoryRoot, store.runId);
    console.log(
      JSON.stringify(
        {
          runId: store.runId,
          supervisors: records.map((record) => inspectSupervisorRecord(record)),
        },
        null,
        2,
      ),
    );
  });

program
  .command("supervise", { hidden: true })
  .description("Internal detached supervisor entrypoint")
  .argument("<run>")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .addOption(hostOption)
  .addOption(
    new Option("--max-workers <count>", "maximum concurrent read-only workers")
      .choices(["1", "2"])
      .default("1"),
  )
  .addOption(new Option("--supervisor-id <id>").makeOptionMandatory().hideHelp())
  .action(
    async (
      run: string,
      options: {
        cwd: string;
        host: HostName;
        maxWorkers: "1" | "2";
        supervisorId: string;
      },
    ) => {
      const store = await storeFor(options.cwd, run);
      const execution = executionSignal();
      const state = await superviseRun({
        store,
        adapter: createAdapter(options.host),
        supervisorId: options.supervisorId,
        signal: execution.signal,
        maxWorkers: Number(options.maxWorkers) as 1 | 2,
        observer: consoleObserver(false),
      }).finally(execution.dispose);
      console.log(JSON.stringify(stateView(state, await store.loadContract()), null, 2));
    },
  );

program
  .command("pause")
  .description("Checkpoint and pause a run")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .action(async (run: string | undefined, options: { cwd: string }) => {
    console.log(
      JSON.stringify(
        await handleAction({ action: "pause", repository: options.cwd, ...(run ? { run } : {}) }),
        null,
        2,
      ),
    );
  });

program
  .command("stop")
  .description("Stop safely without claiming completion")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .action(async (run: string | undefined, options: { cwd: string }) => {
    console.log(
      JSON.stringify(
        await handleAction({ action: "stop", repository: options.cwd, ...(run ? { run } : {}) }),
        null,
        2,
      ),
    );
  });

program
  .command("trace")
  .description("Print the append-only event trace")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .option("--json", "emit JSON array")
  .action(async (run: string | undefined, options: { cwd: string; json?: boolean }) => {
    const store = await storeFor(options.cwd, run);
    const events = await store.loadEvents();
    if (options.json) console.log(JSON.stringify(events));
    else
      for (const event of events)
        console.log(`${event.sequence}\t${event.timestamp}\t${event.type}\t${event.actor}`);
  });

program
  .command("view")
  .description("Open a loopback-only read-only graph and trace viewer")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .option("--port <port>", "loopback port (0 selects an available port)", "0")
  .option("--no-open", "print the URL without opening a browser")
  .action(
    async (run: string | undefined, options: { cwd: string; port: string; open: boolean }) => {
      const parsedPort = Number(options.port);
      const store = await storeFor(options.cwd, run);
      const viewer = await startRunViewer({ store, port: parsedPort });
      console.log(`Graphcraft read-only viewer: ${viewer.url}`);
      if (options.open && process.stdout.isTTY)
        await openLocalUrl(viewer.url).catch((error) =>
          console.error(`graphcraft: unable to open a browser: ${(error as Error).message}`),
        );
      await new Promise<void>((resolveStop) => {
        process.once("SIGINT", resolveStop);
        process.once("SIGTERM", resolveStop);
      });
      await viewer.close();
    },
  );

program
  .command("github-snapshot")
  .description("Capture one fully paginated, SHA-bound read-only pull request snapshot")
  .argument("[pull-request]", "pull request number, URL, or branch")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .action(async (pullRequest: string | undefined, options: { cwd: string }) => {
    console.log(
      JSON.stringify(
        redactValue(
          await captureGitHubPullRequestSnapshot(
            {
              cwd: options.cwd,
              ...(pullRequest ? { pullRequest } : {}),
            },
            PORTABLE_CANONICAL_HASH_ALGORITHM,
          ),
        ),
        null,
        2,
      ),
    );
  });

program
  .command("doctor")
  .description("Check repository and host capabilities")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .action(async (options: { cwd: string }) => {
    console.log(
      JSON.stringify(await handleAction({ action: "doctor", repository: options.cwd }), null, 2),
    );
  });

program.parseAsync().catch((error: unknown) => {
  const message = redactString((error as Error).message);
  const hint = recoveryHint(message);
  console.error(`graphcraft: ${message}${hint ? `\nNext: ${hint}` : ""}`);
  process.exitCode = 1;
});
