import crossSpawn from "cross-spawn";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChildTerminationController,
  GraphPlanSchema,
  HOST_CAPABILITY_PROBE_SETTLE_GRACE_MS,
  HOST_CAPABILITY_PROBE_TIMEOUT_MS,
  HostTerminationError,
  SemanticVerdictSchema,
  WorkerResultSchema,
  assertRequiredHostCapabilities,
  codexGraphPlanJsonSchema,
  codexSemanticVerdictJsonSchema,
  codexWorkerResultJsonSchema,
  discoverRepositoryTrustRoots,
  hostCapabilitiesFromProtocolProfile,
  interruptionReason,
  normalizeTokenUsage,
  reconcilePersistedInvocation,
  resolveTrustedExecutable,
  renderPlannerPrompt,
  renderSemanticVerifierPrompt,
  renderWorkerPrompt,
  stripSingleHostVersionLineEnding,
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

async function codexUntrustedRoots(repositoryPath?: string): Promise<string[]> {
  const paths = [...new Set([process.cwd(), ...(repositoryPath ? [repositoryPath] : [])])];
  const discovered = await Promise.all(paths.map(discoverRepositoryTrustRoots));
  return [...new Set([...paths, ...discovered.flat()])];
}

function abortedCapabilityProbeError(signal: AbortSignal): HostTerminationError {
  const reason = interruptionReason(signal.reason);
  return new HostTerminationError(
    {
      cause: reason.cause,
      outcome: "already_exited",
      requestedSignal: "SIGTERM",
      exitCode: null,
      exitSignal: null,
    },
    true,
  );
}

async function runCapabilityProbe(
  executable: string,
  args: string[],
  captureErrorOutput = false,
  signal?: AbortSignal,
): Promise<{ code: number | null; output: string; overflowed: boolean; terminated: boolean }> {
  if (signal?.aborted) throw abortedCapabilityProbeError(signal);
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const output = new BoundedTextCapture(ADAPTER_STDERR_LIMIT_BYTES);
    const probeAbort = new AbortController();
    const terminationController = new ChildTerminationController(child, probeAbort.signal);
    let abortSource: "caller" | "timeout" | undefined;
    let settled = false;
    let settlement: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const requestAbort = (source: "caller" | "timeout", reason: unknown): void => {
      if (probeAbort.signal.aborted) return;
      abortSource = source;
      probeAbort.abort(reason);
    };
    const abortFromCaller = (): void => requestAbort("caller", signal?.reason);
    const complete = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (settlement) clearTimeout(settlement);
      probeAbort.signal.removeEventListener("abort", scheduleSettlement);
      signal?.removeEventListener("abort", abortFromCaller);
      const termination = terminationController.finish(code, closeSignal);
      const result = {
        code,
        output: output.text(),
        overflowed: output.overflowed,
        terminated: termination !== undefined,
      };
      if (abortSource === "caller" || (abortSource === "timeout" && signal?.aborted)) {
        reject(
          termination
            ? new HostTerminationError(termination, true)
            : abortedCapabilityProbeError(abortSource === "caller" ? signal! : probeAbort.signal),
        );
        return;
      }
      resolve(result);
    };
    const scheduleSettlement = (): void => {
      if (settled || settlement) return;
      settlement = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref?.();
        complete(null, null);
      }, HOST_CAPABILITY_PROBE_SETTLE_GRACE_MS);
      settlement.unref();
    };
    child.stdout.on("data", (chunk: Buffer | string) => output.append(chunk));
    if (captureErrorOutput) {
      child.stderr.on("data", (chunk: Buffer | string) => output.append(chunk));
    }
    child.once("error", () => complete(null, null));
    child.once("close", complete);
    probeAbort.signal.addEventListener("abort", scheduleSettlement, { once: true });
    timeout = setTimeout(() => {
      requestAbort("timeout", {
        cause: "timeout",
        reason: `${executable} capability probe timed out`,
      });
    }, HOST_CAPABILITY_PROBE_TIMEOUT_MS);
    timeout.unref();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (signal?.aborted) abortFromCaller();
  });
}

async function codexVersion(
  executable: string,
  signal?: AbortSignal,
): Promise<{ installed: boolean; version?: string }> {
  const result = await runCapabilityProbe(executable, ["--version"], false, signal);
  return result.code === 0 && !result.overflowed && !result.terminated
    ? { installed: true, version: stripSingleHostVersionLineEnding(result.output) }
    : { installed: false };
}

async function codexAuthenticated(executable: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runCapabilityProbe(executable, ["login", "status"], true, signal);
  return (
    result.code === 0 &&
    !result.overflowed &&
    !result.terminated &&
    !/(?:^|\r?\n)Not logged in\.?($|\r?\n)/u.test(result.output) &&
    /(?:^|\r?\n)Logged in(?: using [^\r\n]+)?\.?($|\r?\n)/u.test(result.output)
  );
}

export async function probeCodexExecutable(executable: string, signal?: AbortSignal) {
  if (signal?.aborted) throw abortedCapabilityProbeError(signal);
  const result = await codexVersion(executable, signal);
  if (signal?.aborted) throw abortedCapabilityProbeError(signal);
  const authenticated = result.installed && (await codexAuthenticated(executable, signal));
  if (signal?.aborted) throw abortedCapabilityProbeError(signal);
  return hostCapabilitiesFromProtocolProfile("codex", {
    installed: result.installed,
    authenticated,
    ...(result.version ? { version: result.version } : {}),
  });
}

export class CodexAdapter implements HostAdapter {
  readonly id = "codex" as const;

  constructor(private readonly policy?: HostExecutionPolicy) {}

  private async resolveReadyExecutable(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw abortedCapabilityProbeError(signal);
    let executable: string;
    try {
      executable = await resolveTrustedExecutable("codex", {
        untrustedRoots: await codexUntrustedRoots(repositoryPath),
      });
    } catch {
      if (signal?.aborted) throw abortedCapabilityProbeError(signal);
      assertRequiredHostCapabilities(
        this.id,
        hostCapabilitiesFromProtocolProfile("codex", {
          installed: false,
          authenticated: false,
        }),
      );
      throw new Error("Unreachable Codex capability admission state");
    }
    if (signal?.aborted) throw abortedCapabilityProbeError(signal);
    const capabilities = await probeCodexExecutable(executable, signal);
    if (signal?.aborted) throw abortedCapabilityProbeError(signal);
    assertRequiredHostCapabilities(this.id, capabilities);
    return executable;
  }

  async probe(signal?: AbortSignal) {
    if (signal?.aborted) throw abortedCapabilityProbeError(signal);
    let executable: string;
    try {
      executable = await resolveTrustedExecutable("codex", {
        untrustedRoots: await codexUntrustedRoots(),
      });
    } catch {
      if (signal?.aborted) throw abortedCapabilityProbeError(signal);
      return hostCapabilitiesFromProtocolProfile("codex", {
        installed: false,
        authenticated: false,
      });
    }
    if (signal?.aborted) throw abortedCapabilityProbeError(signal);
    return await probeCodexExecutable(executable, signal);
  }

  async plan(request: PlanningRequest, signal: AbortSignal): Promise<PlanningResult> {
    const executable = await this.resolveReadyExecutable(request.repositoryPath, signal);
    const schemaDirectory = await mkdtemp(join(tmpdir(), "graphcraft-codex-plan-"));
    const schemaPath = join(schemaDirectory, "graph-plan.schema.json");
    await writeFile(schemaPath, JSON.stringify(codexGraphPlanJsonSchema), "utf8");
    if (signal.aborted) {
      await rm(schemaDirectory, { recursive: true, force: true });
      throw abortedCapabilityProbeError(signal);
    }
    const child = spawn(executable, codexPlannerArgs(request, schemaPath, this.policy), {
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
    child.stdin.end(renderPlannerPrompt(request));
    let lastMessage = "";
    let lastMessageExceededLimit = false;
    let protocolExceededLimit = false;
    let usage: ReturnType<typeof codexUsage> | undefined;
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
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type === "item.completed" && item?.type === "agent_message") {
          const candidate = String(item.text ?? "");
          lastMessageExceededLimit = structuredOutputExceedsLimit(candidate);
          lastMessage = lastMessageExceededLimit ? "" : candidate;
        }
        if (event.type === "turn.completed") usage = codexUsage(event.usage);
      }
      const exit = await terminationController.waitForExit(exitPromise);
      const termination = terminationController.finish(exit.code, exit.signal);
      if (termination) throw new HostTerminationError(termination);
      if (protocolExceededLimit) throw protocolLineLimitError("Codex");
      if (lastMessageExceededLimit) {
        throw structuredOutputLimitError("Codex", "structured graph plan");
      }
      const plan = parseGraphPlan(lastMessage);
      if (exit.code !== 0 || !plan) {
        throw new Error(
          stderr.text().trim() ||
            `Codex exited ${exit.code ?? 1} without a valid structured graph plan`,
        );
      }
      return { plan, ...(usage ? { usage } : {}) };
    } finally {
      terminationController.dispose();
      await rm(schemaDirectory, { recursive: true, force: true });
    }
  }

  async verify(
    request: SemanticVerificationRequest,
    signal: AbortSignal,
  ): Promise<SemanticVerificationResult> {
    const executable = await this.resolveReadyExecutable(request.repositoryPath, signal);
    const schemaDirectory = await mkdtemp(join(tmpdir(), "graphcraft-codex-verify-"));
    const schemaPath = join(schemaDirectory, "semantic-verdict.schema.json");
    await writeFile(schemaPath, JSON.stringify(codexSemanticVerdictJsonSchema), "utf8");
    if (signal.aborted) {
      await rm(schemaDirectory, { recursive: true, force: true });
      throw abortedCapabilityProbeError(signal);
    }
    const child = spawn(executable, codexSemanticVerifierArgs(request, schemaPath, this.policy), {
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
    child.stdin.end(renderSemanticVerifierPrompt(request.context, request.authorityBoundary));
    let lastMessage = "";
    let lastMessageExceededLimit = false;
    let protocolExceededLimit = false;
    let usage: ReturnType<typeof codexUsage> | undefined;
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
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type === "item.completed" && item?.type === "agent_message") {
          const candidate = String(item.text ?? "");
          lastMessageExceededLimit = structuredOutputExceedsLimit(candidate);
          lastMessage = lastMessageExceededLimit ? "" : candidate;
        }
        if (event.type === "turn.completed") usage = codexUsage(event.usage);
      }
      const exit = await terminationController.waitForExit(exitPromise);
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
    const executable = await this.resolveReadyExecutable(request.repositoryPath, signal);
    const schemaDirectory = await mkdtemp(join(tmpdir(), "graphcraft-codex-"));
    const schemaPath = join(schemaDirectory, "worker-result.schema.json");
    await writeFile(schemaPath, JSON.stringify(codexWorkerResultJsonSchema), "utf8");
    const args = codexWorkerArgs(request, schemaPath, this.policy);
    if (signal.aborted) {
      await rm(schemaDirectory, { recursive: true, force: true });
      throw abortedCapabilityProbeError(signal);
    }
    const child = spawn(executable, args, {
      cwd: request.repositoryPath,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) =>
        child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal })),
    );
    const protocolAbort = new AbortController();
    const executionSignal = AbortSignal.any([signal, protocolAbort.signal]);
    const terminationController = new ChildTerminationController(child, executionSignal);
    child.stdin.end(renderWorkerPrompt(request.capsule, request.authorityBoundary));
    let lastMessage = "";
    let lastMessageExceededLimit = false;
    let protocolExceededLimit = false;
    let observedSessionId: string | undefined;
    let expectedSessionId = request.resumeSessionId;
    let sessionIdentityMismatch = false;
    let sessionReported = false;
    const stderr = captureStderr(child.stderr);
    const protocolLines = readBoundedProtocolLines(child.stdout, executionSignal)[
      Symbol.asyncIterator
    ]();
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
        if (signal.aborted || sessionIdentityMismatch) continue;
        const type = String(event.type ?? "");
        const item = event.item as Record<string, unknown> | undefined;
        if (type === "thread.started" && typeof event.thread_id === "string") {
          expectedSessionId ??= event.thread_id;
          if (event.thread_id !== expectedSessionId) {
            sessionIdentityMismatch = true;
            protocolAbort.abort({
              cause: "cancellation",
              reason: "Codex worker reported a different thread identity",
            });
            continue;
          }
          observedSessionId = event.thread_id;
        }
        if (!observedSessionId) continue;
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

      const exit = await terminationController.waitForExit(exitPromise);
      const termination = terminationController.finish(exit.code, exit.signal);
      if (sessionIdentityMismatch) {
        yield {
          type: "error",
          message: `Codex ${request.resumeSessionId ? "resumed " : ""}worker reported a different thread identity; result was rejected`,
        };
        return;
      }
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
      if (exit.code !== 0) {
        yield {
          type: "error",
          message:
            stderr.text().trim() || `Codex exited ${exit.code} without a valid structured result`,
          cause: "host_crash",
        };
        return;
      }
      if (!observedSessionId) {
        yield {
          type: "error",
          message: `Codex ${request.resumeSessionId ? "resumed " : ""}worker did not report its thread identity; result was rejected`,
        };
        return;
      }
      const result = parseJsonResult(lastMessage);
      if (!result) {
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
