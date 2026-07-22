import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChildTerminationController,
  GraphPlanSchema,
  HostTerminationError,
  HostCapabilitiesSchema,
  SemanticVerdictSchema,
  WorkerResultSchema,
  codexGraphPlanJsonSchema,
  codexSemanticVerdictJsonSchema,
  codexWorkerResultJsonSchema,
  normalizeTokenUsage,
  reconcilePersistedInvocation,
  renderPlannerPrompt,
  renderSemanticVerifierPrompt,
  renderWorkerPrompt,
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

function omitNullObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => omitNullObjectProperties(item));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, omitNullObjectProperties(item)]),
  );
}

function parseJsonResult(value: unknown): ReturnType<typeof WorkerResultSchema.parse> | undefined {
  if (typeof value === "object" && value !== null) {
    const parsed = WorkerResultSchema.safeParse(omitNullObjectProperties(value));
    if (parsed.success) return parsed.data;
  }
  if (typeof value !== "string") return undefined;
  try {
    return WorkerResultSchema.parse(omitNullObjectProperties(JSON.parse(value)));
  } catch {
    return undefined;
  }
}

function parseGraphPlan(value: unknown): ReturnType<typeof GraphPlanSchema.parse> | undefined {
  if (typeof value === "object" && value !== null) {
    const parsed = GraphPlanSchema.safeParse(omitNullObjectProperties(value));
    if (parsed.success) return parsed.data;
  }
  if (typeof value !== "string") return undefined;
  try {
    return GraphPlanSchema.parse(omitNullObjectProperties(JSON.parse(value)));
  } catch {
    return undefined;
  }
}

function parseSemanticVerdict(
  value: unknown,
): ReturnType<typeof SemanticVerdictSchema.parse> | undefined {
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

export function codexUsage(value: unknown) {
  return normalizeTokenUsage("codex", value);
}

async function commandVersion(command: string): Promise<{ installed: boolean; version?: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
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

async function codexAuthenticated(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("codex", ["login", "status"], { stdio: ["ignore", "pipe", "pipe"] });
    const output = new BoundedTextCapture(ADAPTER_STDERR_LIMIT_BYTES);
    child.stdout.on("data", (chunk: Buffer | string) => output.append(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => output.append(chunk));
    child.once("error", () => resolve(false));
    child.once("close", (code) =>
      resolve(code === 0 && !output.overflowed && !/not logged in/i.test(output.text())),
    );
  });
}

export class CodexAdapter implements HostAdapter {
  readonly id = "codex" as const;

  constructor(private readonly policy?: HostExecutionPolicy) {}

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
    await writeFile(schemaPath, JSON.stringify(codexGraphPlanJsonSchema), "utf8");
    const child = spawn("codex", codexPlannerArgs(request, schemaPath, this.policy), {
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
    child.stdin.end(renderPlannerPrompt(request));
    let lastMessage = "";
    let lastMessageExceededLimit = false;
    let protocolExceededLimit = false;
    let usage: ReturnType<typeof codexUsage> | undefined;
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
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type === "item.completed" && item?.type === "agent_message") {
          const candidate = String(item.text ?? "");
          lastMessageExceededLimit = structuredOutputExceedsLimit(candidate);
          lastMessage = lastMessageExceededLimit ? "" : candidate;
        }
        if (event.type === "turn.completed") usage = codexUsage(event.usage);
      }
      const exitCode = await exitPromise;
      if (signal.aborted) throw new Error("Codex planning invocation aborted");
      if (protocolExceededLimit) throw protocolLineLimitError("Codex");
      if (lastMessageExceededLimit) {
        throw structuredOutputLimitError("Codex", "structured graph plan");
      }
      const plan = parseGraphPlan(lastMessage);
      if (exitCode !== 0 || !plan) {
        throw new Error(
          stderr.text().trim() || `Codex exited ${exitCode} without a valid structured graph plan`,
        );
      }
      return { plan, ...(usage ? { usage } : {}) };
    } finally {
      signal.removeEventListener("abort", abort);
      await rm(schemaDirectory, { recursive: true, force: true });
    }
  }

  async verify(
    request: SemanticVerificationRequest,
    signal: AbortSignal,
  ): Promise<SemanticVerificationResult> {
    const schemaDirectory = await mkdtemp(join(tmpdir(), "graphcraft-codex-verify-"));
    const schemaPath = join(schemaDirectory, "semantic-verdict.schema.json");
    await writeFile(schemaPath, JSON.stringify(codexSemanticVerdictJsonSchema), "utf8");
    const child = spawn("codex", codexSemanticVerifierArgs(request, schemaPath, this.policy), {
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
    child.stdin.end(renderSemanticVerifierPrompt(request.context));
    let lastMessage = "";
    let lastMessageExceededLimit = false;
    let protocolExceededLimit = false;
    let usage: ReturnType<typeof codexUsage> | undefined;
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
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type === "item.completed" && item?.type === "agent_message") {
          const candidate = String(item.text ?? "");
          lastMessageExceededLimit = structuredOutputExceedsLimit(candidate);
          lastMessage = lastMessageExceededLimit ? "" : candidate;
        }
        if (event.type === "turn.completed") usage = codexUsage(event.usage);
      }
      const exit = await exitPromise;
      const termination = terminationController.finish(exit.code, exit.signal);
      if (termination) throw new HostTerminationError(termination);
      if (protocolExceededLimit) throw protocolLineLimitError("Codex");
      if (lastMessageExceededLimit) {
        throw structuredOutputLimitError("Codex", "semantic verdict");
      }
      const verdict = parseSemanticVerdict(lastMessage);
      if (exit.code !== 0 || !verdict) {
        throw new Error(
          stderr.text().trim() || `Codex exited ${exit.code ?? 1} without a valid semantic verdict`,
        );
      }
      return { verdict, ...(usage ? { usage } : {}) };
    } finally {
      terminationController.dispose();
      await rm(schemaDirectory, { recursive: true, force: true });
    }
  }

  async *execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent> {
    const schemaDirectory = await mkdtemp(join(tmpdir(), "graphcraft-codex-"));
    const schemaPath = join(schemaDirectory, "worker-result.schema.json");
    await writeFile(schemaPath, JSON.stringify(codexWorkerResultJsonSchema), "utf8");
    const args = codexWorkerArgs(request, schemaPath, this.policy);
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
    let lastMessage = "";
    let lastMessageExceededLimit = false;
    let protocolExceededLimit = false;
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
        const item = event.item as Record<string, unknown> | undefined;
        if (type === "thread.started" && typeof event.thread_id === "string")
          observedSessionId = event.thread_id;
        if (!sessionReported && observedSessionId && type.startsWith("item.")) {
          sessionReported = true;
          yield { type: "session", hostSessionId: observedSessionId };
        }
        if (type === "item.completed" && item?.type === "agent_message") {
          const candidate = String(item.text ?? "");
          lastMessageExceededLimit = structuredOutputExceedsLimit(candidate);
          lastMessage = lastMessageExceededLimit ? "" : candidate;
          if (!lastMessageExceededLimit) yield { type: "message", text: lastMessage };
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
      if (protocolExceededLimit) {
        yield { type: "error", message: protocolLineLimitError("Codex").message };
        return;
      }
      if (lastMessageExceededLimit) {
        yield {
          type: "error",
          message: structuredOutputLimitError("Codex", "structured result").message,
        };
        return;
      }
      const result = parseJsonResult(lastMessage);
      if (exit.code !== 0 || !result) {
        yield {
          type: "error",
          message:
            stderr.text().trim() ||
            `Codex exited ${exit.code ?? 1} without a valid structured result`,
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

function codexPolicyArgs(policy?: HostExecutionPolicy): string[] {
  return policy
    ? ["--model", policy.model, "--config", `model_reasoning_effort="${policy.effort}"`]
    : [];
}

export function codexPlannerArgs(
  request: PlanningRequest,
  schemaPath: string,
  policy?: HostExecutionPolicy,
): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    ...codexPolicyArgs(policy),
    "-C",
    request.repositoryPath,
    "-s",
    "read-only",
    "--output-schema",
    schemaPath,
    "-",
  ];
}

export function codexWorkerArgs(
  request: WorkerRequest,
  schemaPath: string,
  policy?: HostExecutionPolicy,
): string[] {
  if (request.resumeSessionId) {
    return [
      "exec",
      "resume",
      "--json",
      "--ignore-user-config",
      ...codexPolicyArgs(policy),
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
    ...codexPolicyArgs(policy),
    "-C",
    request.repositoryPath,
    "-s",
    request.allowedTools.includes("write") ? "workspace-write" : "read-only",
    "--output-schema",
    schemaPath,
    "-",
  ];
}

export function codexSemanticVerifierArgs(
  request: SemanticVerificationRequest,
  schemaPath: string,
  policy?: HostExecutionPolicy,
): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    ...codexPolicyArgs(policy),
    "-C",
    request.repositoryPath,
    "-s",
    "read-only",
    "--output-schema",
    schemaPath,
    "-",
  ];
}
