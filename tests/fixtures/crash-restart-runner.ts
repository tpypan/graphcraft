import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  reconcilePersistedInvocation,
  type HostAdapter,
  type HostCapabilities,
  type HostEvent,
  type InvocationRecord,
  type PlanningRequest,
  type PlanningResult,
  type ReconciliationResult,
  type RunEvent,
  type SemanticVerificationRequest,
  type SemanticVerificationResult,
  type TokenUsage,
  type WorkerRequest,
} from "../../packages/core/src/index.ts";
import {
  RunStore,
  discoverRepository,
  executeRun,
  resolveRunId,
} from "../../packages/runtime/src/index.ts";

type HostId = "codex" | "claude";
type FaultBoundary = "session" | "usage" | "result" | "progress_scope";
type RunnerMode = "crash" | "resume";

function usage(input: number, cachedInput: number, output: number): TokenUsage {
  return {
    input,
    cachedInput,
    uncachedInput: input - cachedInput,
    output,
    reasoning: 0,
    total: input + output,
    availability: {
      input: "reported",
      cachedInput: "reported",
      uncachedInput: "derived",
      output: "reported",
      reasoning: "reported",
      total: "derived",
    },
  };
}

class ColdRestartFaultStore extends RunStore {
  private targetInvocationId?: string;

  constructor(
    repositoryRoot: string,
    runId: string,
    private readonly boundary: FaultBoundary,
    private readonly markerPath: string,
  ) {
    super(repositoryRoot, runId);
  }

  override async append(
    actor: RunEvent["actor"],
    type: RunEvent["type"],
    data: Record<string, unknown>,
    causationId = this.runId,
  ): Promise<RunEvent> {
    const event = await super.append(actor, type, data, causationId);
    if (
      type === "invocation.started" &&
      data.nodeId === "implement" &&
      typeof data.invocationId === "string"
    )
      this.targetInvocationId = data.invocationId;
    return event;
  }

  override async appendInvocationEvent(invocationId: string, event: HostEvent): Promise<string> {
    const artifact = await super.appendInvocationEvent(invocationId, event);
    if (
      this.boundary !== "progress_scope" &&
      invocationId === this.targetInvocationId &&
      event.type === this.boundary
    ) {
      await writeFile(
        this.markerPath,
        `${JSON.stringify({ boundary: this.boundary, invocationId, pid: process.pid })}\n`,
        "utf8",
      );
      await new Promise<never>(() => {
        setInterval(() => undefined, 1_000);
      });
    }
    return artifact;
  }
}

class ColdRestartAdapter implements HostAdapter {
  readonly id: HostId;

  constructor(
    host: HostId,
    private readonly mode: RunnerMode,
    private readonly requestLogPath: string,
  ) {
    this.id = host;
  }

  async probe(): Promise<HostCapabilities> {
    return {
      installed: true,
      authenticated: true,
      version: "cold-restart-fixture",
      structuredOutput: true,
      streamingEvents: true,
      tokenReporting: true,
    };
  }

  async plan(_request: PlanningRequest, _signal: AbortSignal): Promise<PlanningResult> {
    throw new Error("The cold-restart fixture does not plan runs");
  }

  async *execute(request: WorkerRequest, _signal: AbortSignal): AsyncIterable<HostEvent> {
    await appendFile(
      this.requestLogPath,
      `${JSON.stringify({
        host: this.id,
        mode: this.mode,
        pid: process.pid,
        nodeId: request.capsule.nodeId,
        invocationId: request.invocationId,
        resumeSessionId: request.resumeSessionId ?? null,
      })}\n`,
      "utf8",
    );
    yield { type: "started", invocationId: request.invocationId };
    yield {
      type: "session",
      hostSessionId: request.resumeSessionId ?? `${this.id}-cold-restart-${request.invocationId}`,
    };

    if (this.mode === "crash") {
      await writeFile(join(request.repositoryPath, "feature.txt"), "partial before cold restart\n");
      yield { type: "usage", usage: usage(5, 1, 2) };
      await writeFile(
        join(request.repositoryPath, "feature.txt"),
        "completed after cold restart\n",
      );
    } else {
      await writeFile(
        join(request.repositoryPath, "feature.txt"),
        "completed after cold restart\n",
      );
      yield { type: "usage", usage: usage(8, 2, 3) };
    }

    yield {
      type: "result",
      result: {
        status: "completed",
        summary:
          this.mode === "crash"
            ? "Completed before the cold-restart fault"
            : "Completed after cold restart",
        changedPaths: ["feature.txt"],
        evidence: ["cold-restart fixture completion"],
      },
    };
  }

  async reconcile(invocation: InvocationRecord): Promise<ReconciliationResult> {
    return reconcilePersistedInvocation(invocation);
  }

  async verify(
    _request: SemanticVerificationRequest,
    _signal: AbortSignal,
  ): Promise<SemanticVerificationResult> {
    return {
      verdict: {
        verdict: "supported",
        evidence: ["Cold-restart fixture evidence remained durable"],
        rationale: "The deterministic fixture retained its repository evidence",
        uncertainty: 0,
      },
    };
  }
}

const [repositoryPath, host, mode, boundary, markerPath, requestLogPath] = process.argv.slice(2);
if (
  !repositoryPath ||
  (host !== "codex" && host !== "claude") ||
  (mode !== "crash" && mode !== "resume") ||
  (boundary !== "session" &&
    boundary !== "usage" &&
    boundary !== "result" &&
    boundary !== "progress_scope") ||
  !markerPath ||
  !requestLogPath
)
  throw new Error(
    "usage: crash-restart-runner <repository> <codex|claude> <crash|resume> <session|usage|result|progress_scope> <marker> <request-log>",
  );

const repository = await discoverRepository(repositoryPath);
const runId = await resolveRunId(repository.root);
const store =
  mode === "crash"
    ? new ColdRestartFaultStore(repository.root, runId, boundary, markerPath)
    : new RunStore(repository.root, runId);
const state = await executeRun({
  store,
  adapter: new ColdRestartAdapter(host, mode, requestLogPath),
});
process.stdout.write(`${JSON.stringify(state)}\n`);
