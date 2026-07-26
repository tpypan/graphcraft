import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  validateRepositoryInstructionSelection,
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
  malformedProtocolLineError,
  protocolLineLimitError,
  readBoundedProtocolLines,
  structuredOutputExceedsLimit,
  structuredOutputLimitError,
} from "./protocol.ts";

const spawn = crossSpawn.spawn;
export const CODEX_CONTAINMENT_PROFILE = "codex-cli@0.144.6/graphcraft-containment-v1";

interface CodexInvocationEnvironment {
  directory: string;
  env: NodeJS.ProcessEnv;
}

interface PreparedCodexInvocation {
  environment: CodexInvocationEnvironment;
  schemaDirectory: string;
  schemaPath: string;
}

interface CodexInvocationLifecycle {
  abort: AbortController;
  controller: ChildTerminationController;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  signal: AbortSignal;
  settled: boolean;
}

async function createCodexInvocationEnvironment(): Promise<CodexInvocationEnvironment> {
  const directory = await mkdtemp(join(tmpdir(), "graphcraft-codex-tmp-"));
  return {
    directory,
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    },
  };
}

async function cleanupPreparedCodexInvocation(input: PreparedCodexInvocation): Promise<void> {
  await Promise.all([
    rm(input.schemaDirectory, { recursive: true, force: true }),
    rm(input.environment.directory, { recursive: true, force: true }),
  ]);
}

async function prepareCodexInvocation(
  prefix: string,
  schemaName: string,
  schema: unknown,
): Promise<PreparedCodexInvocation> {
  const schemaDirectory = await mkdtemp(join(tmpdir(), prefix));
  let environment: CodexInvocationEnvironment | undefined;
  try {
    environment = await createCodexInvocationEnvironment();
    const schemaPath = join(schemaDirectory, schemaName);
    await writeFile(schemaPath, JSON.stringify(schema), "utf8");
    return { environment, schemaDirectory, schemaPath };
  } catch (error) {
    await Promise.allSettled([
      rm(schemaDirectory, { recursive: true, force: true }),
      ...(environment ? [rm(environment.directory, { recursive: true, force: true })] : []),
    ]);
    throw error;
  }
}

function createCodexInvocationLifecycle(
  child: ChildProcess,
  callerSignal: AbortSignal,
): CodexInvocationLifecycle {
  const abort = new AbortController();
  const signal = AbortSignal.any([callerSignal, abort.signal]);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      let observed = false;
      const complete = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
        if (observed) return;
        observed = true;
        resolveExit({ code, signal: closeSignal });
      };
      child.once("error", () => complete(null, null));
      child.once("close", complete);
    },
  );
  return {
    abort,
    controller: new ChildTerminationController(child, signal),
    exit,
    signal,
    settled: false,
  };
}

async function finishCodexInvocation(lifecycle: CodexInvocationLifecycle): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  termination: ReturnType<ChildTerminationController["finish"]>;
}> {
  const exit = await lifecycle.controller.waitForExit(lifecycle.exit);
  lifecycle.settled = true;
  return {
    ...exit,
    termination: lifecycle.controller.finish(exit.code, exit.signal),
  };
}

async function cleanupCodexInvocation(
  lifecycle: CodexInvocationLifecycle | undefined,
): Promise<void> {
  if (!lifecycle) return;
  if (!lifecycle.settled) {
    if (!lifecycle.signal.aborted)
      lifecycle.abort.abort({
        cause: "cancellation",
        reason: "Codex invocation consumer stopped before child settlement",
      });
    const exit = await lifecycle.controller.waitForExit(lifecycle.exit);
    lifecycle.settled = true;
    lifecycle.controller.finish(exit.code, exit.signal);
    return;
  }
  lifecycle.controller.dispose();
}

async function pathEntryExists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    },
  );
}

async function readBoundedControlFile(path: string): Promise<string> {
  const details = await lstat(path);
  if (!details.isFile() || details.size > 4_096)
    throw new Error("Codex repository metadata is not a bounded regular file");
  return await readFile(path, "utf8");
}

async function linkedMainCheckoutRoot(repositoryRoot: string): Promise<string | undefined> {
  const dotGit = join(repositoryRoot, ".git");
  const details = await lstat(dotGit);
  if (details.isDirectory()) return undefined;
  if (!details.isFile())
    throw new Error("Codex repository metadata uses an unsupported Git marker");
  const gitDirValue = (await readBoundedControlFile(dotGit)).match(/^gitdir:\s*(.+?)\s*$/u)?.[1];
  if (!gitDirValue) throw new Error("Codex repository metadata has an invalid gitdir pointer");
  const gitDirectory = resolve(repositoryRoot, gitDirValue);
  const worktreesDirectory = dirname(gitDirectory);
  if (basename(worktreesDirectory) !== "worktrees") return undefined;

  // Codex 0.144.6 derives this path lexically from .../worktrees/<id>; it does not read
  // commondir. Canonicalize only the derived checkout target before inspecting it so a
  // symlink cannot move the boundary away from the location Codex will consult.
  const commonDirectory = dirname(worktreesDirectory);
  const mainCheckout = dirname(commonDirectory);
  if (mainCheckout === commonDirectory)
    throw new Error("Codex linked-worktree metadata did not identify a bounded main checkout");
  let canonicalMainCheckout: string;
  try {
    canonicalMainCheckout = await realpath(mainCheckout);
  } catch {
    throw new Error("Codex linked-worktree main checkout could not be resolved");
  }
  if (!(await stat(canonicalMainCheckout)).isDirectory())
    throw new Error("Codex linked-worktree main checkout is not a directory");
  return canonicalMainCheckout;
}

async function assertNoCodexDirectoryBetween(root: string, cwd: string): Promise<void> {
  const relation = relative(root, cwd);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation))
    throw new Error("Codex repository customization boundary could not be established");
  let current = root;
  const candidates = [current];
  for (const segment of relation.split(sep).filter(Boolean)) {
    current = join(current, segment);
    candidates.push(current);
  }
  for (const candidate of candidates)
    if (await pathEntryExists(join(candidate, ".codex")))
      throw new Error(
        "Codex project customizations are not supported inside Graphcraft-managed invocations",
      );
}

async function codexHomeForInvocation(): Promise<string> {
  const configured = process.env.CODEX_HOME;
  // Codex treats the empty string exactly like an unset variable.
  if (configured === undefined || configured.length === 0) return join(homedir(), ".codex");

  // A relative CODEX_HOME would resolve once for Graphcraft's capability probes and again from
  // the repository cwd for the model child. Refuse that split identity instead of attesting one
  // home and invoking another.
  if (!isAbsolute(configured))
    throw new Error("Codex containment requires CODEX_HOME to be an absolute directory");

  let details;
  try {
    details = await stat(configured);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Codex containment rejected a nonexistent CODEX_HOME");
    throw new Error("Codex containment could not inspect CODEX_HOME");
  }
  if (!details.isDirectory())
    throw new Error("Codex containment requires CODEX_HOME to be a directory");
  try {
    return await realpath(configured);
  } catch {
    throw new Error("Codex containment could not canonicalize CODEX_HOME");
  }
}

export async function assertCodexCustomizationBoundary(repositoryPath: string): Promise<void> {
  const codexHome = await codexHomeForInvocation();
  for (const name of ["AGENTS.override.md", "AGENTS.md"])
    if (await pathEntryExists(join(codexHome, name)))
      throw new Error(
        "Codex home instructions are not supported inside Graphcraft-managed invocations",
      );
  const roots = await discoverRepositoryTrustRoots(repositoryPath);
  if (roots.length === 0)
    throw new Error("Codex repository customization boundary requires a Git repository");
  const repositoryRoot = await realpath(roots[0]!);
  const canonicalCwd = await realpath(repositoryPath);
  await assertNoCodexDirectoryBetween(repositoryRoot, canonicalCwd);
  const mainCheckout = await linkedMainCheckoutRoot(repositoryRoot);
  if (mainCheckout) {
    const mainRoot = await realpath(mainCheckout);
    const relation = relative(repositoryRoot, canonicalCwd);
    await assertNoCodexDirectoryBetween(mainRoot, resolve(mainRoot, relation));
  }
}

function codexProtocolFailure(
  event: Record<string, unknown>,
  turnStarted: boolean,
): string | undefined {
  const type = String(event.type ?? "");
  const item = event.item as Record<string, unknown> | undefined;
  const failed =
    type === "turn.failed" ||
    (!turnStarted && (type === "error" || (type === "item.completed" && item?.type === "error")));
  if (!failed) return undefined;
  const detail =
    item?.message ?? event.message ?? (event.error as Record<string, unknown>)?.message;
  return typeof detail === "string" && detail.trim()
    ? detail.trim()
    : "Codex reported a protocol failure";
}

interface CodexProtocolState {
  threadId?: string;
  threadStarted: boolean;
  turnStarted: boolean;
  turnCompleted: boolean;
}

export interface CodexProtocolValidationOptions {
  expectedThreadId?: string;
  sessionContext?: "model" | "worker" | "resumed_worker";
}

export interface CodexProtocolValidator {
  observe(event: Record<string, unknown>): string | undefined;
  completionFailure(): string | undefined;
  threadId(): string | undefined;
}

function codexThreadIdentityFailure(
  context: CodexProtocolValidationOptions["sessionContext"],
  kind: "different" | "invalid",
): string {
  if (context === "worker" || context === "resumed_worker") {
    const worker = context === "resumed_worker" ? "resumed worker" : "worker";
    if (kind === "invalid")
      return `Codex ${worker} did not report its thread identity; result was rejected`;
    return `Codex ${worker} reported a different thread identity; result was rejected`;
  }
  if (kind === "invalid") return "Codex thread.started omitted its thread identity";
  return "Codex protocol event reported a different thread identity";
}

export function createCodexProtocolValidator(
  options: CodexProtocolValidationOptions = {},
): CodexProtocolValidator {
  const state: CodexProtocolState = {
    threadStarted: false,
    turnStarted: false,
    turnCompleted: false,
  };
  return {
    observe(event) {
      const protocolFailure = codexProtocolFailure(event, state.turnStarted);
      if (protocolFailure) return protocolFailure;
      const type = String(event.type ?? "");
      if (type === "thread.started") {
        if (typeof event.thread_id !== "string" || event.thread_id.length === 0)
          return codexThreadIdentityFailure(options.sessionContext, "invalid");
        if (
          (options.expectedThreadId && event.thread_id !== options.expectedThreadId) ||
          (state.threadId && event.thread_id !== state.threadId)
        )
          return codexThreadIdentityFailure(options.sessionContext, "different");
        if (state.threadStarted || state.turnStarted || state.turnCompleted)
          return "Codex reported a duplicate or out-of-order thread.started event";
        state.threadStarted = true;
        state.threadId = event.thread_id;
        return undefined;
      }
      if (type === "turn.started") {
        if (!state.threadStarted || state.turnStarted || state.turnCompleted)
          return "Codex reported a duplicate or out-of-order turn.started event";
        state.turnStarted = true;
        return undefined;
      }
      if (type === "turn.completed") {
        if (!state.turnStarted || state.turnCompleted)
          return "Codex reported a duplicate or out-of-order turn.completed event";
        state.turnCompleted = true;
        return undefined;
      }
      if (type.startsWith("item.") && !state.turnStarted)
        return "Codex reported item output before turn.started";
      if (type.startsWith("item.") && state.turnCompleted)
        return "Codex reported item output after turn.completed";
      if (type === "error" && state.turnCompleted)
        return "Codex reported an error after turn.completed";
      return undefined;
    },
    completionFailure() {
      if (!state.threadStarted) return "Codex did not attest thread.started";
      if (!state.turnStarted) return "Codex did not attest turn.started";
      if (!state.turnCompleted) return "Codex did not attest turn.completed";
      return undefined;
    },
    threadId() {
      return state.threadId;
    },
  };
}

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
  readonly containmentProfile = CODEX_CONTAINMENT_PROFILE;

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
    await assertCodexCustomizationBoundary(repositoryPath);
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
    if (request.repositoryInstructions)
      validateRepositoryInstructionSelection(request.repositoryInstructions);
    const executable = await this.resolveReadyExecutable(request.repositoryPath, signal);
    const prepared = await prepareCodexInvocation(
      "graphcraft-codex-plan-",
      "graph-plan.schema.json",
      codexGraphPlanJsonSchema,
    );
    let lifecycle: CodexInvocationLifecycle | undefined;
    try {
      if (signal.aborted) throw abortedCapabilityProbeError(signal);
      const child = spawn(executable, codexPlannerArgs(request, prepared.schemaPath, this.policy), {
        cwd: request.repositoryPath,
        env: prepared.environment.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      lifecycle = createCodexInvocationLifecycle(child, signal);
      child.stdin.end(renderPlannerPrompt(request));
      let lastMessage = "";
      let lastMessageExceededLimit = false;
      let protocolExceededLimit = false;
      let protocolFailure: string | undefined;
      const validator = createCodexProtocolValidator();
      let usage: ReturnType<typeof codexUsage> | undefined;
      const stderr = captureStderr(child.stderr);

      for await (const line of readBoundedProtocolLines(child.stdout, lifecycle.signal)) {
        if (line.overflowed) {
          protocolExceededLimit = true;
          continue;
        }
        if (protocolExceededLimit || !line.text?.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.text) as Record<string, unknown>;
        } catch {
          protocolFailure ??= malformedProtocolLineError("Codex").message;
          lifecycle.abort.abort({ cause: "cancellation", reason: protocolFailure });
          continue;
        }
        protocolFailure ??= validator.observe(event);
        if (protocolFailure) {
          lifecycle.abort.abort({ cause: "cancellation", reason: protocolFailure });
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
      const exit = await finishCodexInvocation(lifecycle);
      const termination = exit.termination;
      if (protocolFailure) throw new Error(protocolFailure);
      if (termination) throw new HostTerminationError(termination);
      if (protocolExceededLimit) throw protocolLineLimitError("Codex");
      if (exit.code !== 0) {
        throw new Error(
          stderr.text().trim() || `Codex exited ${exit.code} without a valid structured graph plan`,
        );
      }
      const completionFailure = validator.completionFailure();
      if (completionFailure) throw new Error(completionFailure);
      if (lastMessageExceededLimit) {
        throw structuredOutputLimitError("Codex", "structured graph plan");
      }
      const plan = parseGraphPlan(lastMessage);
      if (!plan) {
        throw new Error(
          stderr.text().trim() ||
            `Codex exited ${exit.code ?? 1} without a valid structured graph plan`,
        );
      }
      return { plan, ...(usage ? { usage } : {}) };
    } finally {
      await cleanupCodexInvocation(lifecycle);
      await cleanupPreparedCodexInvocation(prepared);
    }
  }

  async verify(
    request: SemanticVerificationRequest,
    signal: AbortSignal,
  ): Promise<SemanticVerificationResult> {
    if (request.context.repositoryInstructions)
      validateRepositoryInstructionSelection(request.context.repositoryInstructions);
    const executable = await this.resolveReadyExecutable(request.repositoryPath, signal);
    const prepared = await prepareCodexInvocation(
      "graphcraft-codex-verify-",
      "semantic-verdict.schema.json",
      codexSemanticVerdictJsonSchema,
    );
    let lifecycle: CodexInvocationLifecycle | undefined;
    try {
      if (signal.aborted) throw abortedCapabilityProbeError(signal);
      const child = spawn(
        executable,
        codexSemanticVerifierArgs(request, prepared.schemaPath, this.policy),
        {
          cwd: request.repositoryPath,
          env: prepared.environment.env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      lifecycle = createCodexInvocationLifecycle(child, signal);
      child.stdin.end(renderSemanticVerifierPrompt(request.context, request.authorityBoundary));
      let lastMessage = "";
      let lastMessageExceededLimit = false;
      let protocolExceededLimit = false;
      let protocolFailure: string | undefined;
      const validator = createCodexProtocolValidator();
      let usage: ReturnType<typeof codexUsage> | undefined;
      const stderr = captureStderr(child.stderr);
      for await (const line of readBoundedProtocolLines(child.stdout, lifecycle.signal)) {
        if (line.overflowed) {
          protocolExceededLimit = true;
          continue;
        }
        if (protocolExceededLimit || !line.text?.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.text) as Record<string, unknown>;
        } catch {
          protocolFailure ??= malformedProtocolLineError("Codex").message;
          lifecycle.abort.abort({ cause: "cancellation", reason: protocolFailure });
          continue;
        }
        protocolFailure ??= validator.observe(event);
        if (protocolFailure) {
          lifecycle.abort.abort({ cause: "cancellation", reason: protocolFailure });
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
      const exit = await finishCodexInvocation(lifecycle);
      const termination = exit.termination;
      if (protocolFailure) throw new Error(protocolFailure);
      if (termination) throw new HostTerminationError(termination);
      if (protocolExceededLimit) throw protocolLineLimitError("Codex");
      if (exit.code !== 0) {
        throw new Error(
          stderr.text().trim() || `Codex exited ${exit.code} without a valid semantic verdict`,
        );
      }
      const completionFailure = validator.completionFailure();
      if (completionFailure) throw new Error(completionFailure);
      if (lastMessageExceededLimit) {
        throw structuredOutputLimitError("Codex", "semantic verdict");
      }
      const verdict = parseSemanticVerdict(lastMessage);
      if (!verdict) {
        throw new Error(
          stderr.text().trim() || `Codex exited ${exit.code ?? 1} without a valid semantic verdict`,
        );
      }
      return { verdict, ...(usage ? { usage } : {}) };
    } finally {
      await cleanupCodexInvocation(lifecycle);
      await cleanupPreparedCodexInvocation(prepared);
    }
  }

  async *execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent> {
    if (request.capsule.repositoryInstructions)
      validateRepositoryInstructionSelection(request.capsule.repositoryInstructions);
    const executable = await this.resolveReadyExecutable(request.repositoryPath, signal);
    const prepared = await prepareCodexInvocation(
      "graphcraft-codex-",
      "worker-result.schema.json",
      codexWorkerResultJsonSchema,
    );
    let lifecycle: CodexInvocationLifecycle | undefined;
    try {
      const args = codexWorkerArgs(request, prepared.schemaPath, this.policy);
      if (signal.aborted) throw abortedCapabilityProbeError(signal);
      const child = spawn(executable, args, {
        cwd: request.repositoryPath,
        env: prepared.environment.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      lifecycle = createCodexInvocationLifecycle(child, signal);
      child.stdin.end(renderWorkerPrompt(request.capsule, request.authorityBoundary));
      let lastMessage = "";
      let lastMessageExceededLimit = false;
      let protocolExceededLimit = false;
      let protocolFailure: string | undefined;
      const validator = createCodexProtocolValidator({
        ...(request.resumeSessionId ? { expectedThreadId: request.resumeSessionId } : {}),
        sessionContext: request.resumeSessionId ? "resumed_worker" : "worker",
      });
      let observedSessionId: string | undefined;
      let sessionReported = false;
      const stderr = captureStderr(child.stderr);
      const protocolLines = readBoundedProtocolLines(child.stdout, lifecycle.signal)[
        Symbol.asyncIterator
      ]();
      let nextProtocolLine = protocolLines.next();

      yield { type: "started", invocationId: request.invocationId };

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
          protocolFailure ??= malformedProtocolLineError("Codex").message;
          lifecycle.abort.abort({ cause: "cancellation", reason: protocolFailure });
          continue;
        }
        if (signal.aborted) continue;
        const type = String(event.type ?? "");
        protocolFailure ??= validator.observe(event);
        if (protocolFailure) {
          lifecycle.abort.abort({ cause: "cancellation", reason: protocolFailure });
          continue;
        }
        if (signal.aborted) continue;
        const item = event.item as Record<string, unknown> | undefined;
        observedSessionId = validator.threadId();
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

      const exit = await finishCodexInvocation(lifecycle);
      const termination = exit.termination;
      if (protocolFailure) {
        yield { type: "error", message: protocolFailure };
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
      if (exit.code !== 0) {
        yield {
          type: "error",
          message:
            stderr.text().trim() || `Codex exited ${exit.code} without a valid structured result`,
          cause: "host_crash",
        };
        return;
      }
      const completionFailure = validator.completionFailure();
      if (completionFailure) {
        yield { type: "error", message: completionFailure };
        return;
      }
      if (lastMessageExceededLimit) {
        yield {
          type: "error",
          message: structuredOutputLimitError("Codex", "structured result").message,
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
      await cleanupCodexInvocation(lifecycle);
      await cleanupPreparedCodexInvocation(prepared);
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

function codexIsolationArgs(workspaceWrite: boolean): string[] {
  const profile = `graphcraft-${workspaceWrite ? "write" : "read"}-${randomUUID()}`;
  const workspaceAccess = workspaceWrite ? "write" : "read";
  const disabledFeatures = [
    "hooks",
    "multi_agent",
    "multi_agent_v2",
    "enable_fanout",
    "apps",
    "enable_mcp_apps",
    "tool_suggest",
    "plugins",
    "remote_plugin",
    "plugin_sharing",
    "skill_mcp_dependency_install",
    "in_app_browser",
    "browser_use",
    "browser_use_full_cdp_access",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "memories",
    "chronicle",
    "goals",
    "exec_permission_approvals",
    "request_permissions_tool",
    "guardian_approval",
    "web_search_request",
    "web_search_cached",
    "standalone_web_search",
    "workspace_dependencies",
  ];
  return [
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--config",
    "project_doc_max_bytes=0",
    "--config",
    'project_root_markers=[".git"]',
    "--config",
    "notify=[]",
    ...disabledFeatures.flatMap((feature) => ["--config", `features.${feature}=false`]),
    "--config",
    "memories.generate_memories=false",
    "--config",
    "memories.use_memories=false",
    "--config",
    "memories.dedicated_tools=false",
    "--config",
    "skills.include_instructions=false",
    "--config",
    "skills.bundled.enabled=false",
    "--config",
    "orchestrator.skills.enabled=false",
    "--config",
    "orchestrator.mcp.enabled=false",
    "--config",
    "tools.experimental_request_user_input={enabled=false}",
    "--config",
    'approval_policy="never"',
    "--config",
    "check_for_update_on_startup=false",
    "--config",
    'web_search="disabled"',
    "--config",
    "allow_login_shell=false",
    "--config",
    'shell_environment_policy={inherit="core",ignore_default_excludes=false}',
    "--config",
    'windows.sandbox="elevated"',
    "--config",
    `default_permissions="${profile}"`,
    "--config",
    `permissions.${profile}={filesystem={":minimal"="read",":workspace_roots"="${workspaceAccess}",":tmpdir"="write"},network={enabled=false}}`,
  ];
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
    ...codexIsolationArgs(false),
    ...codexPolicyArgs(policy),
    "-C",
    request.repositoryPath,
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
  const workspaceWrite = request.allowedTools.includes("write");
  return [
    "exec",
    "--json",
    ...codexIsolationArgs(workspaceWrite),
    ...codexPolicyArgs(policy),
    "-C",
    request.repositoryPath,
    "--output-schema",
    schemaPath,
    ...(request.resumeSessionId ? ["resume", request.resumeSessionId] : []),
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
    ...codexIsolationArgs(false),
    ...codexPolicyArgs(policy),
    "-C",
    request.repositoryPath,
    "--output-schema",
    schemaPath,
    "-",
  ];
}
