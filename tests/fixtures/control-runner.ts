import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChildTerminationController,
  HostTerminationError,
  reconcilePersistedInvocation,
  type HostAdapter,
  type HostCapabilities,
  type HostEvent,
  type InvocationRecord,
  type PlanningRequest,
  type PlanningResult,
  type ReconciliationResult,
  type SemanticVerificationRequest,
  type SemanticVerificationResult,
  type WorkerRequest,
} from "../../packages/core/src/index.ts";
import {
  RunStore,
  discoverRepository,
  executeRun,
  resolveRunId,
} from "../../packages/runtime/src/index.ts";

class ControlFixtureAdapter implements HostAdapter {
  readonly id = "test" as const;

  constructor(
    private readonly mode: "wait" | "complete" | "probe",
    private readonly pidPath: string,
  ) {}

  async probe(signal?: AbortSignal): Promise<HostCapabilities> {
    if (this.mode === "probe") {
      if (!signal) throw new Error("The control fixture probe requires a cancellation signal");
      const child = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        { stdio: "ignore" },
      );
      await once(child, "spawn");
      await writeFile(this.pidPath, `${child.pid}\n`);
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) =>
          child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal })),
      );
      const termination = new ChildTerminationController(child, signal, 200);
      const exit = await termination.waitForExit(closed);
      const receipt = termination.finish(exit.code, exit.signal);
      if (receipt) throw new HostTerminationError(receipt);
      throw new Error("Fixture capability child exited unexpectedly");
    }
    return {
      installed: true,
      authenticated: true,
      version: "control-fixture",
      protocolProfile: "test/control-fixture",
      structuredOutput: true,
      streamingEvents: true,
      tokenReporting: true,
      cancellation: true,
      resume: true,
    };
  }

  async plan(_request: PlanningRequest, _signal: AbortSignal): Promise<PlanningResult> {
    throw new Error("The control fixture does not plan runs");
  }

  async *execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent> {
    yield { type: "started", invocationId: request.invocationId };
    yield { type: "session", hostSessionId: request.resumeSessionId ?? request.invocationId };
    if (this.mode === "complete") {
      await writeFile(join(request.repositoryPath, "feature.txt"), "completed after control\n");
      yield {
        type: "result",
        result: {
          status: "completed",
          summary: "Completed after control",
          changedPaths: ["feature.txt"],
          evidence: ["control fixture completion"],
        },
      };
      return;
    }

    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    await once(child, "spawn");
    await writeFile(this.pidPath, `${child.pid}\n`);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal })),
    );
    const termination = new ChildTerminationController(child, signal, 200);
    const exit = await closed;
    const receipt = termination.finish(exit.code, exit.signal);
    if (receipt) yield { type: "terminated", termination: receipt };
    else yield { type: "error", message: "Fixture child exited unexpectedly", cause: "host_crash" };
  }

  async reconcile(invocation: InvocationRecord): Promise<ReconciliationResult> {
    return reconcilePersistedInvocation(invocation);
  }

  async verify(_request: SemanticVerificationRequest): Promise<SemanticVerificationResult> {
    throw new Error("The control fixture does not perform semantic verification");
  }
}

const [repositoryPath, mode, pidPath] = process.argv.slice(2);
if (!repositoryPath || (mode !== "wait" && mode !== "complete" && mode !== "probe") || !pidPath)
  throw new Error("usage: control-runner <repository> <wait|complete|probe> <pid-path>");
const repository = await discoverRepository(repositoryPath);
const runId = await resolveRunId(repository.root);
const store = new RunStore(repository.root, runId);
const state = await executeRun({
  store,
  adapter: new ControlFixtureAdapter(mode, pidPath),
});
process.stdout.write(`${JSON.stringify(state)}\n`);
