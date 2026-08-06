import crossSpawn from "cross-spawn";
import { execFile, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
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
  interruptionReason,
  normalizeTokenUsage,
  reconcilePersistedInvocation,
  resolveTrustedExecutable,
  renderPlannerPrompt,
  recordedHostProtocolVersions,
  renderSemanticVerifierPrompt,
  renderWorkerPrompt,
  stripSingleHostVersionLineEnding,
  validateRepositoryInstructionSelection,
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
  malformedProtocolLineError,
  protocolLineLimitError,
  readBoundedProtocolLines,
  structuredOutputExceedsLimit,
  structuredOutputLimitError,
} from "./protocol.ts";

const spawn = crossSpawn.spawn;
const execFileAsync = promisify(execFile);
export const CLAUDE_CONTAINMENT_PROFILE = "claude-code@2.1.212/graphcraft-containment-v1";

export interface ClaudeInvocationEnvironment {
  directory: string;
  env: NodeJS.ProcessEnv;
}

const CLAUDE_AUTH_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
];

const CLAUDE_RUNTIME_ENV_NAMES = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "AWS_CA_BUNDLE",
];

const CLAUDE_SENSITIVE_ENV_NAMES = [
  "CLAUDE_CONFIG_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  ...CLAUDE_AUTH_ENV_NAMES,
];

const CLAUDE_ENV_NAMES = [...CLAUDE_RUNTIME_ENV_NAMES, ...CLAUDE_SENSITIVE_ENV_NAMES];

const CLAUDE_CREDENTIAL_PATHS = [
  "~/.ssh",
  "~/.aws",
  "~/.config/gcloud",
  "~/.azure",
  "~/.claude",
  "~/.git-credentials",
  "~/.netrc",
  "~/.config/gh",
];

const CLAUDE_DYNAMIC_CREDENTIAL_PATH_ENV_NAMES = [
  "CLAUDE_CONFIG_DIR",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

const CLAUDE_DEFAULT_WRITABLE_PATHS = [
  "/tmp/claude",
  "/private/tmp/claude",
  "~/.npm/_logs",
  "~/.claude/debug",
];

export interface ClaudeIsolationBoundary {
  repositoryRealPath: string;
  temporaryDirectory: string;
  protectedEnvironmentPaths?: readonly string[];
}

export async function createClaudeIsolationBoundary(
  repositoryPath: string,
  temporaryDirectory: string,
  signal?: AbortSignal,
): Promise<ClaudeIsolationBoundary> {
  signal?.throwIfAborted();
  const repositoryRealPath = await realpath(repositoryPath);
  const protectedEnvironmentPaths = await repositoryEnvironmentPaths(repositoryRealPath, signal);
  signal?.throwIfAborted();
  return {
    repositoryRealPath,
    temporaryDirectory,
    protectedEnvironmentPaths,
  };
}

export async function createClaudeInvocationEnvironment(): Promise<ClaudeInvocationEnvironment> {
  const directory = await mkdtemp(join(tmpdir(), "graphcraft-claude-tmp-"));
  const env: NodeJS.ProcessEnv = {};
  for (const name of CLAUDE_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    directory,
    env: {
      ...env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
      CLAUDE_CODE_TMPDIR: directory,
    },
  };
}

async function repositoryEnvironmentPaths(
  repositoryRealPath: string,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const executable = await resolveTrustedExecutable("git", {
    untrustedRoots: await claudeUntrustedRoots(repositoryRealPath),
  });
  const pathspecs = [
    ":(glob).env",
    ":(glob).env.*",
    ":(glob)**/.env",
    ":(glob)**/.env.*",
    ":(glob)**/.env/**",
    ":(glob)**/.env.*/**",
  ];
  const inventories = [
    ["--cached", "--others", "--exclude-standard"],
    ["--others", "--ignored", "--exclude-standard"],
  ];
  const outputs: string[] = [];
  for (const inventory of inventories) {
    try {
      const { stdout } = await execFileAsync(
        executable,
        [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "ls-files",
          "-z",
          "--no-recurse-submodules",
          ...inventory,
          "--",
          ...pathspecs,
        ],
        {
          cwd: repositoryRealPath,
          encoding: "utf8",
          maxBuffer: 1_048_576,
          timeout: 30_000,
          ...(signal ? { signal } : {}),
          env: {
            PATH: process.env.PATH,
            Path: process.env.Path,
            PATHEXT: process.env.PATHEXT,
            SystemRoot: process.env.SystemRoot,
            SYSTEMROOT: process.env.SYSTEMROOT,
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      );
      outputs.push(stdout);
    } catch (error) {
      if (signal?.aborted) throw abortedCapabilityProbeError(signal);
      throw new Error("Claude containment could not inventory repository environment files", {
        cause: error,
      });
    }
  }
  const relativePaths = [
    ...new Set(outputs.flatMap((output) => output.split("\0").filter(Boolean))),
  ].sort();
  if (relativePaths.length > 1_024)
    throw new Error("Claude containment found too many repository environment files");
  const protectedPaths: string[] = [];
  for (const path of relativePaths) {
    signal?.throwIfAborted();
    const parts = path.replaceAll("\\", "/").split("/");
    if (
      isAbsolute(path) ||
      parts.some((part) => !part || part === "." || part === "..") ||
      !parts.some((part) => part === ".env" || part.startsWith(".env."))
    )
      throw new Error("Claude containment received an unsafe environment-file path from Git");
    const candidate = join(repositoryRealPath, ...parts);
    let canonical: string;
    try {
      const details = await lstat(candidate);
      if (!details.isFile() || details.isSymbolicLink())
        throw new Error("Claude containment rejected a non-file repository environment path");
      canonical = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Claude containment could not resolve a repository environment file");
    }
    const relation = relative(repositoryRealPath, canonical);
    if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation))
      throw new Error("Claude containment rejected an external repository environment file");
    protectedPaths.push(canonical);
  }
  return [...new Set(protectedPaths)].sort();
}

async function prepareClaudeInvocation(
  repositoryPath: string,
  signal: AbortSignal,
): Promise<{
  boundary: ClaudeIsolationBoundary;
  invocationEnvironment: ClaudeInvocationEnvironment;
}> {
  const invocationEnvironment = await createClaudeInvocationEnvironment();
  try {
    const boundary = await createClaudeIsolationBoundary(
      repositoryPath,
      invocationEnvironment.directory,
      signal,
    );
    return { boundary, invocationEnvironment };
  } catch (error) {
    await rm(invocationEnvironment.directory, { recursive: true, force: true });
    if (signal.aborted) throw abortedCapabilityProbeError(signal);
    throw error;
  }
}

interface ClaudeInvocationLifecycle {
  abort: AbortController;
  controller: ChildTerminationController;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  signal: AbortSignal;
  settled: boolean;
}

function createClaudeInvocationLifecycle(
  child: ChildProcess,
  callerSignal: AbortSignal,
): ClaudeInvocationLifecycle {
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

async function finishClaudeInvocation(lifecycle: ClaudeInvocationLifecycle): Promise<{
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

async function cleanupClaudeInvocation(
  lifecycle: ClaudeInvocationLifecycle | undefined,
): Promise<void> {
  if (!lifecycle) return;
  if (!lifecycle.settled) {
    if (!lifecycle.signal.aborted)
      lifecycle.abort.abort({
        cause: "cancellation",
        reason: "Claude invocation consumer stopped before child settlement",
      });
    const exit = await lifecycle.controller.waitForExit(lifecycle.exit);
    lifecycle.settled = true;
    lifecycle.controller.finish(exit.code, exit.signal);
    return;
  }
  lifecycle.controller.dispose();
}

function claudeDynamicCredentialPaths(repositoryPath: string): string[] {
  return [
    ...new Set(
      CLAUDE_DYNAMIC_CREDENTIAL_PATH_ENV_NAMES.flatMap((name) => {
        const value = process.env[name]?.trim();
        if (!value) return [];
        return [
          value.startsWith("~") || isAbsolute(value) ? value : resolve(repositoryPath, value),
        ];
      }),
    ),
  ];
}

function claudeIsolationSettings(boundary: ClaudeIsolationBoundary, writable: boolean): object {
  const dynamicCredentialPaths = claudeDynamicCredentialPaths(boundary.repositoryRealPath);
  const credentialPaths = [...new Set([...CLAUDE_CREDENTIAL_PATHS, ...dynamicCredentialPaths])];
  const home = resolve(process.env.HOME ?? homedir());
  const dynamicCredentialPathsOutsideHome = dynamicCredentialPaths.filter((path) => {
    if (path.startsWith("~")) return false;
    const relation = relative(home, resolve(path));
    return relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation);
  });
  const repositoryEnvironmentPaths = [
    "./.env",
    "./.env.*",
    "./**/.env",
    "./**/.env.*",
    ...(boundary.protectedEnvironmentPaths ?? []),
  ];
  const permissionDeniedPaths = [
    ...credentialPaths.flatMap((path) => [path, `${path}/**`]),
    ...repositoryEnvironmentPaths,
  ];
  return {
    permissions: {
      deny: permissionDeniedPaths.flatMap((path) =>
        ["Read", "Edit", "Write"].map((tool) => `${tool}(${path})`),
      ),
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
      allowPty: false,
      filesystem: {
        denyRead: ["~", ...dynamicCredentialPathsOutsideHome, ...repositoryEnvironmentPaths],
        allowRead: [boundary.repositoryRealPath],
        allowWrite: [
          boundary.temporaryDirectory,
          ...(writable ? [boundary.repositoryRealPath] : []),
        ],
        denyWrite: [
          ...CLAUDE_DEFAULT_WRITABLE_PATHS,
          ...credentialPaths,
          ...repositoryEnvironmentPaths,
        ],
      },
      credentials: {
        files: [...credentialPaths, ...repositoryEnvironmentPaths].map((path) => ({
          path,
          mode: "deny",
        })),
        envVars: CLAUDE_SENSITIVE_ENV_NAMES.map((name) => ({ name, mode: "deny" })),
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
        allowMachLookup: [],
      },
    },
  };
}

function claudeIsolationArgs(boundary: ClaudeIsolationBoundary, writable: boolean): string[] {
  return [
    "--safe-mode",
    "--no-chrome",
    "--include-hook-events",
    "--settings",
    JSON.stringify(claudeIsolationSettings(boundary, writable)),
  ];
}

function claudeHookProtocolFailure(event: Record<string, unknown>): string | undefined {
  const type = String(event.type ?? "");
  const subtype = String(event.subtype ?? "");
  if (!type.startsWith("hook_") && !(type === "system" && subtype.startsWith("hook_")))
    return undefined;
  return "Claude reported a configured hook event; Graphcraft does not authorize host hooks, so the result was rejected";
}

function claudeErrorDetail(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "object" && value !== null) {
    const detail = (value as Record<string, unknown>).message;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
  }
  return undefined;
}

interface ClaudeProtocolState {
  terminalResultObserved: boolean;
}

function claudeProtocolFailure(
  event: Record<string, unknown>,
  state: ClaudeProtocolState,
): string | undefined {
  const hookFailure = claudeHookProtocolFailure(event);
  if (hookFailure) return hookFailure;
  const type = String(event.type ?? "");
  const subtype = String(event.subtype ?? "");
  if (state.terminalResultObserved && type === "result")
    return "Claude reported duplicate terminal results";
  if (state.terminalResultObserved && (type === "assistant" || type === "user"))
    return "Claude emitted model output after its terminal result";
  if (type === "assistant" && event.error !== undefined)
    return claudeErrorDetail(event.error) ?? "Claude reported an assistant protocol error";
  if (type === "result") {
    state.terminalResultObserved = true;
    if (subtype !== "success" || event.is_error !== false)
      return (
        claudeErrorDetail(event.error) ??
        claudeErrorDetail(event.result) ??
        `Claude reported ${subtype || "an invalid terminal result"}`
      );
    if (event.error !== undefined && event.error !== null)
      return claudeErrorDetail(event.error) ?? "Claude reported an error terminal reason";
    if (event.api_error_status !== undefined && event.api_error_status !== null)
      return "Claude reported an API error status";
    if (event.terminal_reason !== undefined && event.terminal_reason !== "completed")
      return `Claude reported terminal reason ${String(event.terminal_reason)}`;
  }
  return undefined;
}

interface ClaudeInitState {
  observed: boolean;
  sessionId?: string;
}

export interface ClaudeProtocolValidationOptions {
  cwd: string;
  allowedTools: readonly string[];
  model?: string;
  expectedSessionId?: string;
  sessionContext?: "model" | "worker" | "resumed_worker";
  /**
   * Claude Code versions the stream may attest. Defaults to the admitted
   * protocol profiles; the live qualification harness passes its candidate
   * version instead so an unadmitted version can be qualified.
   */
  claudeCodeVersions?: readonly string[];
}

export interface ClaudeProtocolValidator {
  observe(event: Record<string, unknown>): Promise<string | undefined>;
  completionFailure(): string | undefined;
  sessionId(): string | undefined;
}

function claudeSessionIdentityFailure(
  context: ClaudeProtocolValidationOptions["sessionContext"],
  kind: "different" | "invalid" | "missing",
): string {
  if (context === "worker" || context === "resumed_worker") {
    const worker = context === "resumed_worker" ? "resumed worker" : "worker";
    if (kind === "missing")
      return `Claude ${worker} output omitted its session identity; result was rejected`;
    return `Claude ${worker} reported a${kind === "invalid" ? "n invalid" : " different"} session identity; result was rejected`;
  }
  if (kind === "missing") return "Claude model output omitted its session identity";
  return `Claude protocol event reported a${kind === "invalid" ? "n invalid" : " different"} session identity`;
}

async function claudeInitFailure(
  event: Record<string, unknown>,
  state: ClaudeInitState,
  expected: {
    cwd: string;
    allowedTools: readonly string[];
    claudeCodeVersions: readonly string[];
    model?: string;
    sessionId?: string;
    sessionContext?: ClaudeProtocolValidationOptions["sessionContext"];
  },
): Promise<string | undefined> {
  const type = String(event.type ?? "");
  const subtype = String(event.subtype ?? "");
  if (type === "system" && subtype === "init") {
    if (state.observed) return "Claude reported duplicate system/init events";
    state.observed = true;
    const tools = Array.isArray(event.tools)
      ? event.tools.filter((tool): tool is string => typeof tool === "string")
      : undefined;
    if (!tools || tools.length !== (event.tools as unknown[]).length)
      return "Claude system/init reported an invalid tool inventory";
    // Claude Code 2.1.222+ surfaces a StructuredOutput tool whenever
    // --json-schema is passed; 2.1.212 does not. Every managed invocation
    // requests structured output, so exactly one such entry may appear.
    const inventory = tools.filter((tool) => tool !== "StructuredOutput");
    if (
      tools.length - inventory.length > 1 ||
      inventory.length !== expected.allowedTools.length ||
      new Set(inventory).size !== inventory.length ||
      inventory.some((tool) => !expected.allowedTools.includes(tool))
    )
      return "Claude system/init reported an unexpected tool inventory";
    if (!Array.isArray(event.mcp_servers) || event.mcp_servers.length !== 0)
      return "Claude system/init reported an MCP server";
    for (const field of ["slash_commands", "skills", "plugins"])
      if (!Array.isArray(event[field]) || (event[field] as unknown[]).length !== 0)
        return `Claude system/init reported a nonempty ${field} inventory`;
    const agents = Array.isArray(event.agents)
      ? event.agents.filter((agent): agent is string => typeof agent === "string")
      : undefined;
    const expectedAgents = ["claude", "Explore", "general-purpose", "Plan"];
    if (
      !agents ||
      agents.length !== expectedAgents.length ||
      new Set(agents).size !== agents.length ||
      agents.some((agent) => !expectedAgents.includes(agent))
    )
      return "Claude system/init reported an unexpected agent inventory";
    for (const field of ["plugin_errors"])
      if (event[field] !== undefined && (!Array.isArray(event[field]) || event[field].length !== 0))
        return `Claude system/init reported a nonempty ${field} inventory`;
    if (event.permissionMode !== "dontAsk")
      return "Claude system/init reported an unexpected permission mode";
    if (
      typeof event.claude_code_version !== "string" ||
      !expected.claudeCodeVersions.includes(event.claude_code_version)
    )
      return "Claude system/init reported an unsupported protocol version";
    if (event.output_style !== "default")
      return "Claude system/init reported a customized output style";
    if (typeof event.model !== "string" || event.model.length === 0)
      return "Claude system/init omitted its model identity";
    if (expected.model && event.model !== expected.model)
      return "Claude system/init reported a different model identity";
    if (typeof event.uuid !== "string" || event.uuid.length === 0)
      return "Claude system/init omitted its event identity";
    let eventCwd: string;
    try {
      eventCwd = typeof event.cwd === "string" ? await realpath(event.cwd) : "";
    } catch {
      eventCwd = "";
    }
    if (!eventCwd || eventCwd !== expected.cwd)
      return "Claude system/init reported an unexpected working directory";
    if (typeof event.session_id !== "string" || event.session_id.length === 0)
      return "Claude system/init omitted its session identity";
    state.sessionId = event.session_id;
    if (expected.sessionId && state.sessionId !== expected.sessionId)
      return "Claude system/init reported a different session identity";
    return undefined;
  }
  if (!state.observed) return "Claude protocol did not begin with system/init attestation";
  if (
    event.session_id !== undefined &&
    (typeof event.session_id !== "string" || event.session_id.length === 0)
  )
    return claudeSessionIdentityFailure(expected.sessionContext, "invalid");
  if (event.session_id !== undefined && event.session_id !== state.sessionId)
    return claudeSessionIdentityFailure(expected.sessionContext, "different");
  if ((type === "assistant" || type === "result") && event.session_id === undefined)
    return claudeSessionIdentityFailure(expected.sessionContext, "missing");
  return undefined;
}

export function createClaudeProtocolValidator(
  options: ClaudeProtocolValidationOptions,
): ClaudeProtocolValidator {
  const protocol: ClaudeProtocolState = { terminalResultObserved: false };
  const init: ClaudeInitState = { observed: false };
  return {
    async observe(event) {
      return (
        claudeProtocolFailure(event, protocol) ??
        (await claudeInitFailure(event, init, {
          cwd: options.cwd,
          allowedTools: options.allowedTools,
          claudeCodeVersions: options.claudeCodeVersions ?? recordedHostProtocolVersions("claude"),
          ...(options.model ? { model: options.model } : {}),
          ...(options.expectedSessionId ? { sessionId: options.expectedSessionId } : {}),
          ...(options.sessionContext ? { sessionContext: options.sessionContext } : {}),
        }))
      );
    },
    completionFailure() {
      if (!init.observed) return "Claude did not attest system/init";
      if (!protocol.terminalResultObserved) return "Claude did not report a terminal result";
      return undefined;
    },
    sessionId() {
      return init.sessionId;
    },
  };
}

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
  signal?: AbortSignal,
): Promise<{ code: number | null; output: string; overflowed: boolean; terminated: boolean }> {
  if (signal?.aborted) throw abortedCapabilityProbeError(signal);
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "ignore"] });
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
        child.unref?.();
        complete(null, null);
      }, HOST_CAPABILITY_PROBE_SETTLE_GRACE_MS);
      settlement.unref();
    };
    child.stdout.on("data", (chunk: Buffer | string) => output.append(chunk));
    child.once("error", () => complete(null, null));
    child.once("close", complete);
    probeAbort.signal.addEventListener("abort", scheduleSettlement, { once: true });
    timeout = setTimeout(() => {
      requestAbort("timeout", {
        cause: "timeout",
        reason: "claude capability probe timed out",
      });
    }, HOST_CAPABILITY_PROBE_TIMEOUT_MS);
    timeout.unref();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (signal?.aborted) abortFromCaller();
  });
}

async function claudeVersion(
  executable: string,
  signal?: AbortSignal,
): Promise<{ installed: boolean; version?: string }> {
  const result = await runCapabilityProbe(executable, ["--version"], signal);
  return result.code === 0 && !result.overflowed && !result.terminated
    ? { installed: true, version: stripSingleHostVersionLineEnding(result.output) }
    : { installed: false };
}

async function claudeAuthenticated(executable: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runCapabilityProbe(executable, ["auth", "status", "--json"], signal);
  if (result.code !== 0 || result.overflowed || result.terminated) return false;
  try {
    const status = JSON.parse(result.output) as { loggedIn?: boolean };
    return status.loggedIn === true;
  } catch {
    return false;
  }
}

export async function probeClaudeExecutable(executable: string, signal?: AbortSignal) {
  if (signal?.aborted) throw abortedCapabilityProbeError(signal);
  const result = await claudeVersion(executable, signal);
  if (signal?.aborted) throw abortedCapabilityProbeError(signal);
  const authenticated = result.installed && (await claudeAuthenticated(executable, signal));
  if (signal?.aborted) throw abortedCapabilityProbeError(signal);
  return hostCapabilitiesFromProtocolProfile("claude", {
    installed: result.installed,
    authenticated,
    ...(result.version ? { version: result.version } : {}),
  });
}

export class ClaudeAdapter implements HostAdapter {
  readonly id = "claude" as const;
  readonly containmentProfile = CLAUDE_CONTAINMENT_PROFILE;

  constructor(private readonly policy?: HostExecutionPolicy) {}

  private async resolveReadyExecutable(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw abortedCapabilityProbeError(signal);
    let executable: string;
    try {
      executable = await resolveTrustedExecutable("claude", {
        untrustedRoots: await claudeUntrustedRoots(repositoryPath),
      });
    } catch {
      if (signal?.aborted) throw abortedCapabilityProbeError(signal);
      assertRequiredHostCapabilities(
        this.id,
        hostCapabilitiesFromProtocolProfile("claude", {
          installed: false,
          authenticated: false,
        }),
      );
      throw new Error("Unreachable Claude capability admission state");
    }
    if (signal?.aborted) throw abortedCapabilityProbeError(signal);
    const capabilities = await probeClaudeExecutable(executable, signal);
    if (signal?.aborted) throw abortedCapabilityProbeError(signal);
    assertRequiredHostCapabilities(this.id, capabilities);
    return executable;
  }

  async probe(signal?: AbortSignal) {
    if (signal?.aborted) throw abortedCapabilityProbeError(signal);
    let executable: string;
    try {
      executable = await resolveTrustedExecutable("claude", {
        untrustedRoots: await claudeUntrustedRoots(),
      });
    } catch {
      if (signal?.aborted) throw abortedCapabilityProbeError(signal);
      return hostCapabilitiesFromProtocolProfile("claude", {
        installed: false,
        authenticated: false,
      });
    }
    if (signal?.aborted) throw abortedCapabilityProbeError(signal);
    return await probeClaudeExecutable(executable, signal);
  }

  async plan(request: PlanningRequest, signal: AbortSignal): Promise<PlanningResult> {
    if (request.repositoryInstructions)
      validateRepositoryInstructionSelection(request.repositoryInstructions);
    const executable = await this.resolveReadyExecutable(request.repositoryPath, signal);
    const { boundary, invocationEnvironment } = await prepareClaudeInvocation(
      request.repositoryPath,
      signal,
    );
    let lifecycle: ClaudeInvocationLifecycle | undefined;
    try {
      if (signal.aborted) throw abortedCapabilityProbeError(signal);
      const child = spawn(executable, claudePlannerArgs(request, boundary, this.policy), {
        cwd: request.repositoryPath,
        env: invocationEnvironment.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      lifecycle = createClaudeInvocationLifecycle(child, signal);
      let protocolExceededLimit = false;
      let structuredExceededLimit = false;
      let protocolFailure: string | undefined;
      const validator = createClaudeProtocolValidator({
        cwd: boundary.repositoryRealPath,
        allowedTools: [],
        ...(this.policy ? { model: this.policy.model } : {}),
      });
      let plan: ReturnType<typeof GraphPlanSchema.parse> | undefined;
      let usage: ReturnType<typeof claudeUsage> | undefined;
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
          protocolFailure ??= malformedProtocolLineError("Claude").message;
          lifecycle.abort.abort({ cause: "cancellation", reason: protocolFailure });
          continue;
        }
        protocolFailure ??= await validator.observe(event);
        if (protocolFailure) {
          lifecycle.abort.abort({ cause: "cancellation", reason: protocolFailure });
          continue;
        }
        if (event.type === "result") {
          const candidate = event.structured_output ?? event.result;
          structuredExceededLimit = structuredOutputExceedsLimit(candidate);
          plan = structuredExceededLimit ? undefined : parsePlan(candidate);
          usage = claudeUsage(event.usage);
        }
      }
      const exit = await finishClaudeInvocation(lifecycle);
      const termination = exit.termination;
      if (protocolFailure) throw new Error(protocolFailure);
      if (termination) throw new HostTerminationError(termination);
      if (protocolExceededLimit) throw protocolLineLimitError("Claude");
      if (exit.code !== 0) {
        throw new Error(stderr.text().trim() || `Claude exited ${exit.code}`);
      }
      const completionFailure = validator.completionFailure();
      if (completionFailure) throw new Error(completionFailure);
      if (structuredExceededLimit) {
        throw structuredOutputLimitError("Claude", "structured graph plan");
      }
      if (!plan) {
        throw new Error(
          stderr.text().trim() ||
            `Claude exited ${exit.code ?? 1} without a valid structured graph plan`,
        );
      }
      return { plan, ...(usage ? { usage } : {}) };
    } finally {
      await cleanupClaudeInvocation(lifecycle);
      await rm(invocationEnvironment.directory, { recursive: true, force: true });
    }
  }

  async verify(
    request: SemanticVerificationRequest,
    signal: AbortSignal,
  ): Promise<SemanticVerificationResult> {
    if (request.context.repositoryInstructions)
      validateRepositoryInstructionSelection(request.context.repositoryInstructions);
    const executable = await this.resolveReadyExecutable(request.repositoryPath, signal);
    const { boundary, invocationEnvironment } = await prepareClaudeInvocation(
      request.repositoryPath,
      signal,
    );
    let lifecycle: ClaudeInvocationLifecycle | undefined;
    try {
      if (signal.aborted) throw abortedCapabilityProbeError(signal);
      const child = spawn(executable, claudeSemanticVerifierArgs(request, boundary, this.policy), {
        cwd: request.repositoryPath,
        env: invocationEnvironment.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      lifecycle = createClaudeInvocationLifecycle(child, signal);
      let protocolExceededLimit = false;
      let structuredExceededLimit = false;
      let protocolFailure: string | undefined;
      const validator = createClaudeProtocolValidator({
        cwd: boundary.repositoryRealPath,
        allowedTools: ["Read"],
        ...(this.policy ? { model: this.policy.model } : {}),
        expectedSessionId: request.invocationId,
      });
      let verdict: ReturnType<typeof SemanticVerdictSchema.parse> | undefined;
      let usage: ReturnType<typeof claudeUsage> | undefined;
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
          protocolFailure ??= malformedProtocolLineError("Claude").message;
          lifecycle.abort.abort({ cause: "cancellation", reason: protocolFailure });
          continue;
        }
        protocolFailure ??= await validator.observe(event);
        if (protocolFailure) {
          lifecycle.abort.abort({ cause: "cancellation", reason: protocolFailure });
          continue;
        }
        if (event.type === "result") {
          const candidate = event.structured_output ?? event.result;
          structuredExceededLimit = structuredOutputExceedsLimit(candidate);
          verdict = structuredExceededLimit ? undefined : parseSemanticVerdict(candidate);
          usage = claudeUsage(event.usage);
        }
      }
      const exit = await finishClaudeInvocation(lifecycle);
      const termination = exit.termination;
      if (protocolFailure) throw new Error(protocolFailure);
      if (termination) throw new HostTerminationError(termination);
      if (protocolExceededLimit) throw protocolLineLimitError("Claude");
      if (exit.code !== 0) {
        throw new Error(stderr.text().trim() || `Claude exited ${exit.code}`);
      }
      const completionFailure = validator.completionFailure();
      if (completionFailure) throw new Error(completionFailure);
      if (structuredExceededLimit) {
        throw structuredOutputLimitError("Claude", "semantic verdict");
      }
      if (!verdict) {
        throw new Error(
          stderr.text().trim() ||
            `Claude exited ${exit.code ?? 1} without a valid semantic verdict`,
        );
      }
      return { verdict, ...(usage ? { usage } : {}) };
    } finally {
      await cleanupClaudeInvocation(lifecycle);
      await rm(invocationEnvironment.directory, { recursive: true, force: true });
    }
  }

  async *execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent> {
    if (request.capsule.repositoryInstructions)
      validateRepositoryInstructionSelection(request.capsule.repositoryInstructions);
    const executable = await this.resolveReadyExecutable(request.repositoryPath, signal);
    const { boundary, invocationEnvironment } = await prepareClaudeInvocation(
      request.repositoryPath,
      signal,
    );
    let lifecycle: ClaudeInvocationLifecycle | undefined;
    try {
      if (signal.aborted) throw abortedCapabilityProbeError(signal);
      const args = claudeWorkerArgs(request, boundary, this.policy);
      const child = spawn(executable, args, {
        cwd: request.repositoryPath,
        env: invocationEnvironment.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      lifecycle = createClaudeInvocationLifecycle(child, signal);
      let protocolExceededLimit = false;
      let structuredExceededLimit = false;
      let protocolFailure: string | undefined;
      let finalResult: ReturnType<typeof WorkerResultSchema.parse> | undefined;
      let observedSessionId: string | undefined;
      const expectedSessionId = request.resumeSessionId ?? request.invocationId;
      const validator = createClaudeProtocolValidator({
        cwd: boundary.repositoryRealPath,
        allowedTools: request.allowedTools.includes("write")
          ? ["Bash", "Edit", "Write", "Read"]
          : ["Read"],
        ...(this.policy ? { model: this.policy.model } : {}),
        expectedSessionId,
        sessionContext: request.resumeSessionId ? "resumed_worker" : "worker",
      });
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
          protocolFailure ??= malformedProtocolLineError("Claude").message;
          lifecycle.abort.abort({ cause: "cancellation", reason: protocolFailure });
          continue;
        }
        if (signal.aborted) continue;
        protocolFailure ??= await validator.observe(event);
        if (protocolFailure) {
          lifecycle.abort.abort({ cause: "cancellation", reason: protocolFailure });
          continue;
        }
        const type = String(event.type ?? "");
        observedSessionId = validator.sessionId();
        if (request.resumeSessionId && !observedSessionId) continue;
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

      const exit = await finishClaudeInvocation(lifecycle);
      const termination = exit.termination;
      const completionFailure = validator.completionFailure();
      if (protocolFailure) {
        yield { type: "error", message: protocolFailure };
      } else if (termination) {
        yield { type: "terminated", termination };
      } else if (protocolExceededLimit) {
        yield { type: "error", message: protocolLineLimitError("Claude").message };
      } else if (exit.code !== 0) {
        yield {
          type: "error",
          message:
            stderr.text().trim() || `Claude exited ${exit.code} without a valid structured result`,
          cause: "host_crash",
        };
      } else if (completionFailure) {
        yield { type: "error", message: completionFailure };
      } else if (structuredExceededLimit) {
        yield {
          type: "error",
          message: structuredOutputLimitError("Claude", "structured result").message,
        };
      } else if (!observedSessionId) {
        yield {
          type: "error",
          message: `Claude ${request.resumeSessionId ? "resumed " : ""}worker did not report its session identity; result was rejected`,
        };
      } else if (!finalResult) {
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
      await cleanupClaudeInvocation(lifecycle);
      await rm(invocationEnvironment.directory, { recursive: true, force: true });
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
  boundary: ClaudeIsolationBoundary,
  policy?: HostExecutionPolicy,
): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    ...claudeIsolationArgs(boundary, false),
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

export function claudeWorkerArgs(
  request: WorkerRequest,
  boundary: ClaudeIsolationBoundary,
  policy?: HostExecutionPolicy,
): string[] {
  const writable = request.allowedTools.includes("write");
  const tools = writable ? "Bash,Edit,Write,Read" : "Read";
  const allowedTools = writable ? "Bash(*),Read(./**),Edit(./**),Write(./**)" : "Read(./**)";
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    ...claudeIsolationArgs(boundary, writable),
    "--permission-mode",
    "dontAsk",
    ...claudePolicyArgs(policy),
    "--tools",
    tools,
    "--allowedTools",
    allowedTools,
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
  boundary: ClaudeIsolationBoundary,
  policy?: HostExecutionPolicy,
): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    ...claudeIsolationArgs(boundary, false),
    "--permission-mode",
    "dontAsk",
    ...claudePolicyArgs(policy, "low"),
    "--tools",
    "Read",
    "--allowedTools",
    "Read(./**)",
    "--session-id",
    request.invocationId,
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--json-schema",
    JSON.stringify(semanticVerdictJsonSchema),
    renderSemanticVerifierPrompt(request.context, request.authorityBoundary),
  ];
}
