import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  ChildTerminationController,
  GraphPlanSchema,
  HostCapabilitiesSchema,
  TokenUsageSchema,
  WorkerResultSchema,
  graphPlanJsonSchema,
  reconcilePersistedInvocation,
  renderPlannerPrompt,
  renderWorkerPrompt,
  workerResultJsonSchema,
  type HostAdapter,
  type HostEvent,
  type InvocationRecord,
  type PlanningRequest,
  type PlanningResult,
  type ReconciliationResult,
  type WorkerRequest,
} from "@graphcraft/core";

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

function claudeUsage(value: unknown) {
  const usage = (value ?? {}) as Record<string, unknown>;
  const input = Number(usage.input_tokens ?? 0);
  const cachedInput = Number(usage.cache_read_input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  return TokenUsageSchema.parse({
    input,
    cachedInput,
    output,
    reasoning: 0,
    total: input + output,
  });
}

async function claudeVersion(): Promise<{ installed: boolean; version?: string }> {
  return await new Promise((resolve) => {
    const child = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", () => resolve({ installed: false }));
    child.once("close", (code) =>
      resolve(code === 0 ? { installed: true, version: output.trim() } : { installed: false }),
    );
  });
}

async function claudeAuthenticated(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("claude", ["auth", "status", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => {
      try {
        const status = JSON.parse(output) as { loggedIn?: boolean };
        resolve(code === 0 && status.loggedIn === true);
      } catch {
        resolve(false);
      }
    });
  });
}

export class ClaudeAdapter implements HostAdapter {
  readonly id = "claude" as const;

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
    const child = spawn(
      "claude",
      [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "dontAsk",
        "--effort",
        "low",
        "--tools",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--json-schema",
        JSON.stringify(graphPlanJsonSchema),
        renderPlannerPrompt(request),
      ],
      {
        cwd: request.repositoryPath,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exitPromise = new Promise<number>((resolve) =>
      child.once("close", (code) => resolve(code ?? 1)),
    );
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    signal.addEventListener("abort", abort, { once: true });
    let stderr = "";
    let plan: ReturnType<typeof GraphPlanSchema.parse> | undefined;
    let usage: ReturnType<typeof TokenUsageSchema.parse> | undefined;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.type === "result") {
          plan = parsePlan(event.structured_output ?? event.result);
          usage = claudeUsage(event.usage);
        }
      }
      const exitCode = await exitPromise;
      if (signal.aborted) throw new Error("Claude planning invocation aborted");
      if (exitCode !== 0 || !plan) {
        throw new Error(
          stderr.trim() || `Claude exited ${exitCode} without a valid structured graph plan`,
        );
      }
      return { plan, ...(usage ? { usage } : {}) };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async *execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent> {
    const args = claudeWorkerArgs(request);
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
    yield { type: "started", invocationId: request.invocationId };
    let stderr = "";
    let finalResult: ReturnType<typeof WorkerResultSchema.parse> | undefined;
    let observedSessionId: string | undefined;
    let sessionReported = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
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
        finalResult = parseResult(event.structured_output ?? event.result);
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
    } else if (exit.code !== 0 || !finalResult) {
      yield {
        type: "error",
        message:
          stderr.trim() || `Claude exited ${exit.code ?? 1} without a valid structured result`,
        cause: "host_crash",
      };
    } else {
      yield { type: "result", result: finalResult };
    }
    terminationController.dispose();
  }

  async reconcile(invocation: InvocationRecord): Promise<ReconciliationResult> {
    return reconcilePersistedInvocation(invocation);
  }
}

export function claudeWorkerArgs(request: WorkerRequest): string[] {
  const writable = request.allowedTools.includes("write");
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    writable ? "acceptEdits" : "dontAsk",
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
