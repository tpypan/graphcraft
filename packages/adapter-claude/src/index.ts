import { spawn } from "node:child_process";
import {
  ChildTerminationController,
  GraphPlanSchema,
  HostTerminationError,
  HostCapabilitiesSchema,
  SemanticVerdictSchema,
  WorkerResultSchema,
  graphPlanJsonSchema,
  normalizeTokenUsage,
  reconcilePersistedInvocation,
  renderPlannerPrompt,
  renderSemanticVerifierPrompt,
  renderWorkerPrompt,
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

async function claudeVersion(): Promise<{ installed: boolean; version?: string }> {
  return await new Promise((resolve) => {
    const child = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    const output = new BoundedTextCapture(ADAPTER_STDERR_LIMIT_BYTES);
    child.stdout.on("data", (chunk: Buffer | string) => output.append(chunk));
    child.once("error", () => resolve({ installed: false }));
    child.once("close", (code) =>
      resolve(
        code === 0 && !output.overflowed
          ? { installed: true, version: output.text().trim() }
          : { installed: false },
      ),
    );
  });
}

async function claudeAuthenticated(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("claude", ["auth", "status", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const output = new BoundedTextCapture(ADAPTER_STDERR_LIMIT_BYTES);
    child.stdout.on("data", (chunk: Buffer | string) => output.append(chunk));
    child.once("error", () => resolve(false));
    child.once("close", (code) => {
      if (output.overflowed) {
        resolve(false);
        return;
      }
      try {
        const status = JSON.parse(output.text()) as { loggedIn?: boolean };
        resolve(code === 0 && status.loggedIn === true);
      } catch {
        resolve(false);
      }
    });
  });
}

export class ClaudeAdapter implements HostAdapter {
  readonly id = "claude" as const;

  constructor(private readonly policy?: HostExecutionPolicy) {}

  async probe() {
    const result = await claudeVersion();
    const authenticated = result.installed && (await claudeAuthenticated());
    return HostCapabilitiesSchema.parse({
      ...result,
      authenticated,
      structuredOutput: result.installed,
      streamingEvents: result.installed,
      tokenReporting: result.installed,
    });
  }

  async plan(request: PlanningRequest, signal: AbortSignal): Promise<PlanningResult> {
    const child = spawn("claude", claudePlannerArgs(request, this.policy), {
      cwd: request.repositoryPath,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitPromise = new Promise<number>((resolve) =>
      child.once("close", (code) => resolve(code ?? 1)),
    );
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    signal.addEventListener("abort", abort, { once: true });
    let protocolExceededLimit = false;
    let structuredExceededLimit = false;
    let plan: ReturnType<typeof GraphPlanSchema.parse> | undefined;
    let usage: ReturnType<typeof claudeUsage> | undefined;
    const stderr = captureStderr(child.stderr);
    try {
      for await (const line of readBoundedProtocolLines(child.stdout)) {
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
      const exitCode = await exitPromise;
      if (signal.aborted) throw new Error("Claude planning invocation aborted");
      if (protocolExceededLimit) throw protocolLineLimitError("Claude");
      if (structuredExceededLimit) {
        throw structuredOutputLimitError("Claude", "structured graph plan");
      }
      if (exitCode !== 0 || !plan) {
        throw new Error(
          stderr.text().trim() || `Claude exited ${exitCode} without a valid structured graph plan`,
        );
      }
      return { plan, ...(usage ? { usage } : {}) };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async verify(
    request: SemanticVerificationRequest,
    signal: AbortSignal,
  ): Promise<SemanticVerificationResult> {
    const child = spawn("claude", claudeSemanticVerifierArgs(request, this.policy), {
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
      for await (const line of readBoundedProtocolLines(child.stdout)) {
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
      const exit = await exitPromise;
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
    const args = claudeWorkerArgs(request, this.policy);
    const child = spawn("claude", args, {
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
    const protocolLines = readBoundedProtocolLines(child.stdout)[Symbol.asyncIterator]();
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

      const exit = await exitPromise;
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
    renderWorkerPrompt(request.capsule),
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
    renderSemanticVerifierPrompt(request.context),
  ];
}
