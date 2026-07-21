import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function parseGraphPlan(value: unknown): ReturnType<typeof GraphPlanSchema.parse> | undefined {
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

function codexUsage(value: unknown) {
  const usage = (value ?? {}) as Record<string, unknown>;
  const input = Number(usage.input_tokens ?? 0);
  const cachedInput = Number(usage.cached_input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  const reasoning = Number(usage.reasoning_output_tokens ?? 0);
  return TokenUsageSchema.parse({
    input,
    cachedInput,
    output,
    reasoning,
    total: input + output,
  });
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

  async plan(request: PlanningRequest, signal: AbortSignal): Promise<PlanningResult> {
    const schemaDirectory = await mkdtemp(join(tmpdir(), "graphcraft-codex-plan-"));
    const schemaPath = join(schemaDirectory, "graph-plan.schema.json");
    await writeFile(schemaPath, JSON.stringify(graphPlanJsonSchema), "utf8");
    const child = spawn(
      "codex",
      [
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "-C",
        request.repositoryPath,
        "-s",
        "read-only",
        "--output-schema",
        schemaPath,
        "-",
      ],
      {
        cwd: request.repositoryPath,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exitPromise = new Promise<number>((resolve) =>
      child.once("close", (code) => resolve(code ?? 1)),
    );
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdin.end(renderPlannerPrompt(request));
    let lastMessage = "";
    let stderr = "";
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
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type === "item.completed" && item?.type === "agent_message")
          lastMessage = String(item.text ?? "");
        if (event.type === "turn.completed") usage = codexUsage(event.usage);
      }
      const exitCode = await exitPromise;
      if (signal.aborted) throw new Error("Codex planning invocation aborted");
      const plan = parseGraphPlan(lastMessage);
      if (exitCode !== 0 || !plan) {
        throw new Error(
          stderr.trim() || `Codex exited ${exitCode} without a valid structured graph plan`,
        );
      }
      return { plan, ...(usage ? { usage } : {}) };
    } finally {
      signal.removeEventListener("abort", abort);
      await rm(schemaDirectory, { recursive: true, force: true });
    }
  }

  async *execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent> {
    const schemaDirectory = await mkdtemp(join(tmpdir(), "graphcraft-codex-"));
    const schemaPath = join(schemaDirectory, "worker-result.schema.json");
    await writeFile(schemaPath, JSON.stringify(workerResultJsonSchema), "utf8");
    const args = codexWorkerArgs(request, schemaPath);
    const child = spawn("codex", args, {
      cwd: request.repositoryPath,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) =>
        child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal })),
    );
    const terminationController = new ChildTerminationController(child, signal);
    child.stdin.end(renderWorkerPrompt(request.capsule));

    yield { type: "started", invocationId: request.invocationId };
    let lastMessage = "";
    let stderr = "";
    let observedSessionId: string | undefined;
    let sessionReported = false;
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
        if (type === "thread.started" && typeof event.thread_id === "string")
          observedSessionId = event.thread_id;
        if (!sessionReported && observedSessionId && type.startsWith("item.")) {
          sessionReported = true;
          yield { type: "session", hostSessionId: observedSessionId };
        }
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
          yield {
            type: "usage",
            usage: codexUsage(event.usage),
          };
        }
      }

      const exit = await exitPromise;
      const termination = terminationController.finish(exit.code, exit.signal);
      if (termination) {
        yield { type: "terminated", termination };
        return;
      }
      const result = parseJsonResult(lastMessage);
      if (exit.code !== 0 || !result) {
        yield {
          type: "error",
          message:
            stderr.trim() || `Codex exited ${exit.code ?? 1} without a valid structured result`,
          cause: "host_crash",
        };
        return;
      }
      yield { type: "result", result };
    } finally {
      terminationController.dispose();
      await rm(schemaDirectory, { recursive: true, force: true });
    }
  }

  async reconcile(invocation: InvocationRecord): Promise<ReconciliationResult> {
    return reconcilePersistedInvocation(invocation);
  }
}

export function codexWorkerArgs(request: WorkerRequest, schemaPath: string): string[] {
  if (request.resumeSessionId) {
    return [
      "exec",
      "resume",
      "--json",
      "--ignore-user-config",
      "--output-schema",
      schemaPath,
      request.resumeSessionId,
      "-",
    ];
  }
  return [
    "exec",
    "--json",
    "--ignore-user-config",
    "-C",
    request.repositoryPath,
    "-s",
    request.allowedTools.includes("write") ? "workspace-write" : "read-only",
    "--output-schema",
    schemaPath,
    "-",
  ];
}
