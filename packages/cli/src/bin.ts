#!/usr/bin/env node
import { Command, Option } from "commander";
import {
  askForApproval,
  consoleObserver,
  contractView,
  createAdapter,
  GRAPHCRAFT_VERSION,
  handleAction,
  installHost,
  renderContract,
  shouldBypassGraph,
  stateView,
  storeFor,
  uninstallHost,
  type HostName,
} from "./index.ts";
import { createRun, executeRun } from "@graphcraft/runtime";

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
        host: HostName;
        finishLine?: "local_verified" | "committed";
      },
    ) => {
      if (!options.force && shouldBypassGraph(task)) {
        console.log("Graphcraft is not needed for this localized task. Use --force to override.");
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
      const approved = options.yes || (await askForApproval(created.contract, created.graph));
      if (!approved) {
        console.log(renderContract(created.contract, created.graph));
        console.log(
          `Run saved for approval. Resume with: graphcraft resume ${created.contract.runId}`,
        );
        return;
      }
      const execution = executionSignal();
      const state = await executeRun({
        store: created.store,
        adapter,
        approve: true,
        observer: consoleObserver(options.json),
        signal: execution.signal,
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
    const view = stateView(state, contract);
    console.log(options.json ? JSON.stringify(view) : JSON.stringify(view, null, 2));
  });

program
  .command("inspect")
  .description("Show the contract, graph, anchors, and state")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .action(async (run: string | undefined, options: { cwd: string }) => {
    const store = await storeFor(options.cwd, run);
    console.log(
      JSON.stringify(
        {
          contract: await store.loadContract(),
          graph: await store.loadGraph(),
          state: await store.loadState(),
        },
        null,
        2,
      ),
    );
  });

program
  .command("resume")
  .description("Resume a checkpointed run without repeating accepted nodes")
  .argument("[run]")
  .option("-C, --cwd <path>", "repository path", process.cwd())
  .option("-y, --yes", "approve a pending contract")
  .option("--json", "emit machine-readable progress")
  .addOption(hostOption)
  .action(
    async (
      run: string | undefined,
      options: { cwd: string; yes?: boolean; json?: boolean; host: HostName },
    ) => {
      const store = await storeFor(options.cwd, run);
      const contract = await store.loadContract();
      const graph = await store.loadGraph();
      const state = await store.loadState();
      const approved =
        state.status !== "awaiting_approval" ||
        options.yes ||
        (await askForApproval(contract, graph));
      if (!approved) {
        console.log(
          JSON.stringify(
            { approvalRequired: true, contract: contractView(contract, graph) },
            null,
            2,
          ),
        );
        return;
      }
      const execution = executionSignal();
      const resumed = await executeRun({
        store,
        adapter: createAdapter(options.host),
        approve: true,
        observer: consoleObserver(options.json),
        signal: execution.signal,
      }).finally(execution.dispose);
      console.log(JSON.stringify(stateView(resumed, contract), null, options.json ? 0 : 2));
      if (resumed.status !== "completed") process.exitCode = 2;
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
