import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function parseJsonResult(value: unknown): ReturnType<typeof WorkerResultSchema.parse> | undefined {
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

async function commandVersion(command: string): Promise<{ installed: boolean; version?: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
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

async function codexAuthenticated(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("codex", ["login", "status"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0 && !/not logged in/i.test(output)));
  });
}

export class CodexAdapter implements HostAdapter {
  readonly id = "codex" as const;

  async probe() {
    const result = await commandVersion("codex");
    const authenticated = result.installed && (await codexAuthenticated());
    return HostCapabilitiesSchema.parse({
      ...result,
      authenticated,
      structuredOutput: result.installed,
      streamingEvents: result.installed,
      tokenReporting: result.installed,
    });
  }

  async *execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent> {
    const schemaDirectory = await mkdtemp(join(tmpdir(), "graphcraft-codex-"));
    const schemaPath = join(schemaDirectory, "worker-result.schema.json");
    await writeFile(schemaPath, JSON.stringify(workerResultJsonSchema), "utf8");
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "-C",
      request.repositoryPath,
      "-s",
      "workspace-write",
      "--output-schema",
      schemaPath,
      "-",
    ];
    const child = spawn("codex", args, {
      cwd: request.repositoryPath,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exitPromise = new Promise<number>((resolve) =>
      child.once("close", (code) => resolve(code ?? 1)),
    );
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdin.end(renderWorkerPrompt(request.capsule));

    yield { type: "started", invocationId: request.invocationId };
    let lastMessage = "";
    let stderr = "";
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
        const type = String(event.type ?? "");
        const item = event.item as Record<string, unknown> | undefined;
        if (type === "item.completed" && item?.type === "agent_message") {
          lastMessage = String(item.text ?? "");
          yield { type: "message", text: lastMessage };
        } else if ((type === "item.started" || type === "item.completed") && item?.type) {
          yield {
            type: "tool",
            name: String(item.type),
            summary: String(item.command ?? item.name ?? ""),
          };
        } else if (type === "turn.completed") {
          const usage = (event.usage ?? {}) as Record<string, unknown>;
          const input = Number(usage.input_tokens ?? 0);
          const cachedInput = Number(usage.cached_input_tokens ?? 0);
          const output = Number(usage.output_tokens ?? 0);
          const reasoning = Number(usage.reasoning_output_tokens ?? 0);
          yield {
            type: "usage",
            usage: TokenUsageSchema.parse({
              input,
              cachedInput,
              output,
              reasoning,
              total: input + output,
            }),
          };
        }
      }

      const exitCode = await exitPromise;
      if (signal.aborted) {
        yield { type: "error", message: "Codex invocation aborted" };
        return;
      }
      const result = parseJsonResult(lastMessage);
      if (exitCode !== 0 || !result) {
        yield {
          type: "error",
          message: stderr.trim() || `Codex exited ${exitCode} without a valid structured result`,
        };
        return;
      }
      yield { type: "result", result };
    } finally {
      signal.removeEventListener("abort", abort);
      await rm(schemaDirectory, { recursive: true, force: true });
    }
  }

  async reconcile(_invocation: InvocationRecord): Promise<ReconciliationResult> {
    return { state: "unknown" };
  }
}
