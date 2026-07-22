#!/usr/bin/env node
import { Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  renderContract,
  stateView,
  storeFor,
  supervisorView,
  uninstallHost,
  type HostName,
} from "./index.ts";
import {
  createRun,
  executeRun,
  inspectSupervisorRecord,
  listSupervisorRecords,
  loadBenchmarkSuite,
  runBenchmark,
  startDetachedSupervisor,
  superviseRun,
  type SupervisorLauncher,
} from "@graphcraft/runtime";
import {
  BenchmarkSuiteSchema,
  createBenchmarkSchedule,
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

const hostOption = new Option("--host <host>", "coding-agent host")
  .choices(["codex", "claude"])
  .default("codex");

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
        output?: string;
        codexModel?: string;
        claudeModel?: string;
        effort?: HostExecutionPolicy["effort"];
        dryRun?: boolean;
      },
    ) => {
      const suite =
        suitePath === "stable-v1"
          ? BenchmarkSuiteSchema.parse(stableBenchmarkSuite)
          : await loadBenchmarkSuite(suitePath);
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
      const result = await runBenchmark({
        suite,
        hosts,
        adapters,
        policies,
        seed: options.seed,
        ...(repetitions ? { repetitions } : {}),
        outputPath,
        observer: (message) => console.log(message),
      });
      console.log(
        JSON.stringify({ outputPath: result.outputPath, summary: result.report.summary }, null, 2),
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
  .command("run")
  .description("Compile and execute a durable task graph")
  .argument("<task>", "task and user-owned finish line")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .option("-y, --yes", "approve the displayed contract non-interactively")
  .option("--force", "force Graphcraft for a small task")
  .option("--json", "emit machine-readable progress")
  .option("--background", "continue under a detached local supervisor")
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
        host: HostName;
        maxWorkers: "1" | "2";
        finishLine?: "local_verified" | "committed";
      },
    ) => {
      const taskShape = assessTaskShape(task);
      if (!options.force && taskShape.bypass) {
        console.log(
          `Graphcraft is not needed for this localized task (shape score ${taskShape.score}). Use --force to override.`,
        );
        return;
      }
      if (/\b(push|open (?:a )?pr|pull request|pr green|merge|deploy)\b/i.test(task)) {
        throw new Error(
          "Graphcraft v0.1 supports local_verified and committed finish lines and will not narrow this remote request.",
        );
      }
      const adapter = createAdapter(options.host);
      const created = await createRun(task, {
        cwd: options.cwd,
        planner: adapter,
        ...(options.finishLine ? { finishLine: options.finishLine } : {}),
      });
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
    const [state, contract] = await Promise.all([store.loadState(), store.loadContract()]);
    const view = {
      ...stateView(state, contract),
      supervisor: await supervisorView(store.repositoryRoot, store.runId),
    };
    console.log(options.json ? JSON.stringify(view) : JSON.stringify(view, null, 2));
  });

program
  .command("inspect")
  .description("Show the contract, graph, anchors, and state")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .action(async (run: string | undefined, options: { cwd: string }) => {
    console.log(
      JSON.stringify(
        await handleAction({
          action: "inspect",
          repository: options.cwd,
          ...(run ? { run } : {}),
        }),
        null,
        2,
      ),
    );
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
  .command("github-snapshot")
  .description("Capture one fully paginated, SHA-bound read-only pull request snapshot")
  .argument("[pull-request]", "pull request number, URL, or branch")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .action(async (pullRequest: string | undefined, options: { cwd: string }) => {
    console.log(
      JSON.stringify(
        await captureGitHubPullRequestSnapshot({
          cwd: options.cwd,
          ...(pullRequest ? { pullRequest } : {}),
        }),
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
  console.error(`graphcraft: ${(error as Error).message}`);
  process.exitCode = 1;
});
