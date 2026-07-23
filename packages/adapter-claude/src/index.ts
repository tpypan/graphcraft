import crossSpawn from "cross-spawn";
import {
  ChildTerminationController,
  GraphPlanSchema,
  HOST_CAPABILITY_PROBE_SETTLE_GRACE_MS,
  HOST_CAPABILITY_PROBE_TIMEOUT_MS,
  HostTerminationError,
  SemanticVerdictSchema,
  WorkerResultSchema,
  assertRequiredHostCapabilities,
  discoverRepositoryTrustRoots,
  graphPlanJsonSchema,
  hostCapabilitiesFromProtocolProfile,
  normalizeTokenUsage,
  reconcilePersistedInvocation,
  resolveTrustedExecutable,
  renderPlannerPrompt,
  renderSemanticVerifierPrompt,
  renderWorkerPrompt,
  stripSingleHostVersionLineEnding,
  workerResultJsonSchema,
  semanticVerdictJsonSchema,
  type HostAdapter,
  type HostExecutionPolicy,
  type HostEvent,
  type InvocationRecord,
  type PlanningRequest,
  type PlanningResult,
  type ReconciliationResult,
  type SemanticVerificationRequest,
  type SemanticVerificationResult,
  type WorkerRequest,
} from "@graphcraft/core";
import {
  ADAPTER_STDERR_LIMIT_BYTES,
  BoundedTextCapture,
  captureStderr,
  protocolLineLimitError,
  readBoundedProtocolLines,
  structuredOutputExceedsLimit,
  structuredOutputLimitError,
} from "./protocol.ts";

const spawn = crossSpawn.spawn;

function parseResult(value: unknown) {
  if (typeof value === "object" && value !== null) {
    const parsed = WorkerResultSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  if (typeof value !== "string") return undefined;
  try {
    return WorkerResultSchema.parse(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parsePlan(value: unknown) {
  if (typeof value === "object" && value !== null) {
    const parsed = GraphPlanSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  if (typeof value !== "string") return undefined;
  try {
    return GraphPlanSchema.parse(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseSemanticVerdict(value: unknown) {
  if (typeof value === "object" && value !== null) {
    const parsed = SemanticVerdictSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  if (typeof value !== "string") return undefined;
  try {
    return SemanticVerdictSchema.parse(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function claudeUsage(value: unknown) {
  return normalizeTokenUsage("claude", value);
}

async function claudeUntrustedRoots(repositoryPath?: string): Promise<string[]> {
  const paths = [...new Set([process.cwd(), ...(repositoryPath ? [repositoryPath] : [])])];
  const discovered = await Promise.all(paths.map(discoverRepositoryTrustRoots));
  return [...new Set([...paths, ...discovered.flat()])];
}

async function runCapabilityProbe(
  executable: string,
  args: string[],
): Promise<{ code: number | null; output: string; overflowed: boolean; terminated: boolean }> {
  return await new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "ignore"] });
    const output = new BoundedTextCapture(ADAPTER_STDERR_LIMIT_BYTES);
    const timeoutAbort = new AbortController();
    const terminationController = new ChildTerminationController(child, timeoutAbort.signal);
    let settled = false;
    let settlement: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const complete = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (settlement) clearTimeout(settlement);
      const termination = terminationController.finish(code, signal);
      resolve({
        code,
        output: output.text(),
        overflowed: output.overflowed,
        terminated: termination !== undefined,
      });
    };
    child.stdout.on("data", (chunk: Buffer | string) => output.append(chunk));
    child.once("error", () => complete(null, null));
    child.once("close", complete);
    timeout = setTimeout(() => {
      timeoutAbort.abort({
        cause: "timeout",
        reason: "claude capability probe timed out",
      });
      if (settled) return;
      settlement = setTimeout(() => {
        child.stdout.destroy();
        child.unref?.();
        complete(null, null);
      }, HOST_CAPABILITY_PROBE_SETTLE_GRACE_MS);
      settlement.unref();
    }, HOST_CAPABILITY_PROBE_TIMEOUT_MS);
    timeout.unref();
  });
}

async function claudeVersion(
  executable: string,
): Promise<{ installed: boolean; version?: string }> {
  const result = await runCapabilityProbe(executable, ["--version"]);
  return result.code === 0 && !result.overflowed && !result.terminated
    ? { installed: true, version: stripSingleHostVersionLineEnding(result.output) }
    : { installed: false };
}

async function claudeAuthenticated(executable: string): Promise<boolean> {
  const result = await runCapabilityProbe(executable, ["auth", "status", "--json"]);
  if (result.code !== 0 || result.overflowed || result.terminated) return false;
  try {
    const status = JSON.parse(result.output) as { loggedIn?: boolean };
    return status.loggedIn === true;
  } catch {
    return false;
  }
}

export async function probeClaudeExecutable(executable: string) {
  const result = await claudeVersion(executable);
  const authenticated = result.installed && (await claudeAuthenticated(executable));
  return hostCapabilitiesFromProtocolProfile("claude", {
    installed: result.installed,
    authenticated,
    ...(result.version ? { version: result.version } : {}),
  });
}

export class ClaudeAdapter implements HostAdapter {
  readonly id = "claude" as const;

  constructor(private readonly policy?: HostExecutionPolicy) {}

  private async resolveReadyExecutable(repositoryPath: string): Promise<string> {
    let executable: string;
    try {
      executable = await resolveTrustedExecutable("claude", {
        untrustedRoots: await claudeUntrustedRoots(repositoryPath),
      });
    } catch {
      assertRequiredHostCapabilities(
        this.id,
        hostCapabilitiesFromProtocolProfile("claude", {
          installed: false,
          authenticated: false,
        }),
      );
      throw new Error("Unreachable Claude capability admission state");
    }
    assertRequiredHostCapabilities(this.id, await probeClaudeExecutable(executable));
    return executable;
  }

  async probe() {
    let executable: string;
    try {
      executable = await resolveTrustedExecutable("claude", {
        untrustedRoots: await claudeUntrustedRoots(),
      });
    } catch {
      return hostCapabilitiesFromProtocolProfile("claude", {
        installed: false,
        authenticated: false,
      });
    }
    return await probeClaudeExecutable(executable);
  }

  async plan(request: PlanningRequest, signal: AbortSignal): Promise<PlanningResult> {
    const executable = await this.resolveReadyExecutable(request.repositoryPath);
    const child = spawn(executable, claudePlannerArgs(request, this.policy), {
      cwd: request.repositoryPath,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) =>
        child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal })),
    );
    const terminationController = new ChildTerminationController(child, signal);
    let protocolExceededLimit = false;
    let structuredExceededLimit = false;
    let plan: ReturnType<typeof GraphPlanSchema.parse> | undefined;
    let usage: ReturnType<typeof claudeUsage> | undefined;
    const stderr = captureStderr(child.stderr);
    try {
      for await (const line of readBoundedProtocolLines(child.stdout, signal)) {
        if (line.overflowed) {
          protocolExceededLimit = true;
          continue;
        }
        if (protocolExceededLimit || !line.text?.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.text) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.type === "result") {
          const candidate = event.structured_output ?? event.result;
          structuredExceededLimit = structuredOutputExceedsLimit(candidate);
          plan = structuredExceededLimit ? undefined : parsePlan(candidate);
          usage = claudeUsage(event.usage);
        }
      }
      const exit = await terminationController.waitForExit(exitPromise);
      const termination = terminationController.finish(exit.code, exit.signal);
      if (termination) throw new HostTerminationError(termination);
      if (protocolExceededLimit) throw protocolLineLimitError("Claude");
      if (structuredExceededLimit) {
        throw structuredOutputLimitError("Claude", "structured graph plan");
      }
      if (exit.code !== 0 || !plan) {
        throw new Error(
          stderr.text().trim() ||
            `Claude exited ${exit.code ?? 1} without a valid structured graph plan`,
        );
      }
      return { plan, ...(usage ? { usage } : {}) };
    } finally {
      terminationController.dispose();
    }
  }

  async verify(
    request: SemanticVerificationRequest,
    signal: AbortSignal,
  ): Promise<SemanticVerificationResult> {
    const executable = await this.resolveReadyExecutable(request.repositoryPath);
    const child = spawn(executable, claudeSemanticVerifierArgs(request, this.policy), {
      cwd: request.repositoryPath,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) =>
        child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal })),
    );
    const terminationController = new ChildTerminationController(child, signal);
    let protocolExceededLimit = false;
    let structuredExceededLimit = false;
    let verdict: ReturnType<typeof SemanticVerdictSchema.parse> | undefined;
    let usage: ReturnType<typeof claudeUsage> | undefined;
    const stderr = captureStderr(child.stderr);
    try {
      for await (const line of readBoundedProtocolLines(child.stdout, signal)) {
        if (line.overflowed) {
          protocolExceededLimit = true;
          continue;
        }
        if (protocolExceededLimit || !line.text?.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.text) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.type === "result") {
          const candidate = event.structured_output ?? event.result;
          structuredExceededLimit = structuredOutputExceedsLimit(candidate);
          verdict = structuredExceededLimit ? undefined : parseSemanticVerdict(candidate);
          usage = claudeUsage(event.usage);
        }
      }
      const exit = await terminationController.waitForExit(exitPromise);
      const termination = terminationController.finish(exit.code, exit.signal);
      if (termination) throw new HostTerminationError(termination);
      if (protocolExceededLimit) throw protocolLineLimitError("Claude");
      if (structuredExceededLimit) {
        throw structuredOutputLimitError("Claude", "semantic verdict");
      }
      if (exit.code !== 0 || !verdict) {
        throw new Error(
          stderr.text().trim() ||
            `Claude exited ${exit.code ?? 1} without a valid semantic verdict`,
        );
      }
      return { verdict, ...(usage ? { usage } : {}) };
    } finally {
      terminationController.dispose();
    }
  }

  async *execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent> {
    const executable = await this.resolveReadyExecutable(request.repositoryPath);
    const args = claudeWorkerArgs(request, this.policy);
    const child = spawn(executable, args, {
      cwd: request.repositoryPath,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) =>
        child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal })),
    );
    const terminationController = new ChildTerminationController(child, signal);
    let protocolExceededLimit = false;
    let structuredExceededLimit = false;
    let finalResult: ReturnType<typeof WorkerResultSchema.parse> | undefined;
    let observedSessionId: string | undefined;
    let sessionReported = false;
    const stderr = captureStderr(child.stderr);
    const protocolLines = readBoundedProtocolLines(child.stdout, signal)[Symbol.asyncIterator]();
    let nextProtocolLine = protocolLines.next();

    yield { type: "started", invocationId: request.invocationId };

    try {
      while (true) {
        const next = await nextProtocolLine;
        if (next.done) break;
        nextProtocolLine = protocolLines.next();
        const line = next.value;
        if (line.overflowed) {
          protocolExceededLimit = true;
          continue;
        }
        if (protocolExceededLimit || !line.text?.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.text) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = String(event.type ?? "");
        if (typeof event.session_id === "string") observedSessionId = event.session_id;
        if (!sessionReported && observedSessionId && (type === "assistant" || type === "result")) {
          sessionReported = true;
          yield { type: "session", hostSessionId: observedSessionId };
        }
        if (type === "assistant") {
          const message = event.message as Record<string, unknown> | undefined;
          const blocks = Array.isArray(message?.content) ? message.content : [];
          for (const value of blocks) {
            const block = value as Record<string, unknown>;
            if (block.type === "text") yield { type: "message", text: String(block.text ?? "") };
            if (block.type === "tool_use") {
              yield { type: "tool", name: String(block.name ?? "tool"), summary: "tool call" };
            }
          }
        }
        if (type === "result") {
          const candidate = event.structured_output ?? event.result;
          structuredExceededLimit = structuredOutputExceedsLimit(candidate);
          finalResult = structuredExceededLimit ? undefined : parseResult(candidate);
          yield {
            type: "usage",
            usage: claudeUsage(event.usage),
          };
        }
      }

      const exit = await terminationController.waitForExit(exitPromise);
      const termination = terminationController.finish(exit.code, exit.signal);
      if (termination) {
        yield { type: "terminated", termination };
      } else if (protocolExceededLimit) {
        yield { type: "error", message: protocolLineLimitError("Claude").message };
      } else if (structuredExceededLimit) {
        yield {
          type: "error",
          message: structuredOutputLimitError("Claude", "structured result").message,
        };
      } else if (exit.code !== 0 || !finalResult) {
        yield {
          type: "error",
          message:
            stderr.text().trim() ||
            `Claude exited ${exit.code ?? 1} without a valid structured result`,
          cause: "host_crash",
        };
      } else {
        yield { type: "result", result: finalResult };
      }
    } finally {
      terminationController.dispose();
    }
  }

  async reconcile(invocation: InvocationRecord): Promise<ReconciliationResult> {
    return reconcilePersistedInvocation(invocation);
  }
}

function claudePolicyArgs(
  policy?: HostExecutionPolicy,
  fallbackEffort?: HostExecutionPolicy["effort"],
): string[] {
  const effort = policy?.effort ?? fallbackEffort;
  return [...(policy ? ["--model", policy.model] : []), ...(effort ? ["--effort", effort] : [])];
}

export function claudePlannerArgs(
  request: PlanningRequest,
  policy?: HostExecutionPolicy,
): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    ...claudePolicyArgs(policy, "low"),
    "--tools",
    "",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--json-schema",
    JSON.stringify(graphPlanJsonSchema),
    renderPlannerPrompt(request),
  ];
}

export function claudeWorkerArgs(request: WorkerRequest, policy?: HostExecutionPolicy): string[] {
  const writable = request.allowedTools.includes("write");
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    writable ? "acceptEdits" : "dontAsk",
    ...claudePolicyArgs(policy),
    "--allowedTools",
    writable ? "Bash(*),Edit,Write,Read,Glob,Grep" : "Read,Glob,Grep",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    ...(request.resumeSessionId
      ? ["--resume", request.resumeSessionId]
      : ["--session-id", request.invocationId]),
    "--json-schema",
    JSON.stringify(workerResultJsonSchema),
    renderWorkerPrompt(request.capsule, request.authorityBoundary),
  ];
}

export function claudeSemanticVerifierArgs(
  request: SemanticVerificationRequest,
  policy?: HostExecutionPolicy,
): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    ...claudePolicyArgs(policy, "low"),
    "--tools",
    "Read,Glob,Grep",
    "--allowedTools",
    "Read,Glob,Grep",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--json-schema",
    JSON.stringify(semanticVerdictJsonSchema),
    renderSemanticVerifierPrompt(request.context, request.authorityBoundary),
  ];
}
