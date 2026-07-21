import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  HostCapabilitiesSchema,
  TokenUsageSchema,
  WorkerResultSchema,
  renderWorkerPrompt,
  workerResultJsonSchema,
  type HostAdapter,
  type HostEvent,
  type InvocationRecord,
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

  async *execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent> {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash(*),Edit,Write,Read,Glob,Grep",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--json-schema",
      JSON.stringify(workerResultJsonSchema),
      renderWorkerPrompt(request.capsule),
    ];
    const child = spawn("claude", args, {
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
    yield { type: "started", invocationId: request.invocationId };
    let stderr = "";
    let finalResult: ReturnType<typeof WorkerResultSchema.parse> | undefined;
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
        const usage = (event.usage ?? {}) as Record<string, unknown>;
        const input = Number(usage.input_tokens ?? 0);
        const cachedInput = Number(usage.cache_read_input_tokens ?? 0);
        const output = Number(usage.output_tokens ?? 0);
        yield {
          type: "usage",
          usage: TokenUsageSchema.parse({
            input,
            cachedInput,
            output,
            reasoning: 0,
            total: input + output,
          }),
        };
      }
    }

    const exitCode = await exitPromise;
    signal.removeEventListener("abort", abort);
    if (signal.aborted) {
      yield { type: "error", message: "Claude invocation aborted" };
    } else if (exitCode !== 0 || !finalResult) {
      yield {
        type: "error",
        message: stderr.trim() || `Claude exited ${exitCode} without a valid structured result`,
      };
    } else {
      yield { type: "result", result: finalResult };
    }
  }

  async reconcile(_invocation: InvocationRecord): Promise<ReconciliationResult> {
    return { state: "unknown" };
  }
}
