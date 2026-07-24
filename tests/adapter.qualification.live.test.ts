/**
 * Opt in by setting GRAPHCRAFT_LIVE_QUALIFICATION_HOSTS and
 * GRAPHCRAFT_LIVE_QUALIFICATION_OUTPUT_PATH. For every selected host, also set
 * GRAPHCRAFT_LIVE_QUALIFICATION_<HOST>_RAW_VERSION, _MODEL, and _EFFORT.
 * Optionally set GRAPHCRAFT_LIVE_QUALIFICATION_PROTOCOL_EVIDENCE_PATH to an
 * absolute, normalized, not-yet-existing directory outside the source repository.
 * Setting any variable in this namespace activates fail-closed configuration validation.
 * Run this file with `pnpm vitest run tests/adapter.qualification.live.test.ts`.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import crossSpawn from "cross-spawn";
import { describe, expect, it } from "vitest";
import {
  claudePlannerArgs,
  claudeSemanticVerifierArgs,
  claudeUsage,
  claudeWorkerArgs,
  probeClaudeExecutable,
} from "../packages/adapter-claude/src/index.ts";
import {
  codexPlannerArgs,
  codexSemanticVerifierArgs,
  codexUsage,
  codexWorkerArgs,
  probeCodexExecutable,
} from "../packages/adapter-codex/src/index.ts";
import {
  captureStderr,
  readBoundedProtocolLines,
  structuredOutputExceedsLimit,
} from "../packages/adapter-codex/src/protocol.ts";
import {
  ChildTerminationController,
  ContextCapsuleSchema,
  GraphPlanSchema,
  HostEventSchema,
  ProbePlanSchema,
  SemanticVerdictSchema,
  SemanticVerifierContextSchema,
  TokenUsageSchema,
  WorkerResultSchema,
  codexGraphPlanJsonSchema,
  codexSemanticVerdictJsonSchema,
  codexWorkerResultJsonSchema,
  compilePlannedGraph,
  compileRunContract,
  contentHash,
  discoverRepositoryTrustRoots,
  renderPlannerPrompt,
  renderSemanticVerifierPrompt,
  renderWorkerPrompt,
  resolveTrustedExecutable,
  type GraphPlan,
  type HostEvent,
  type HostExecutionPolicy,
  type HostTermination,
  type PlanningRequest,
  type SemanticVerificationRequest,
  type SemanticVerdict,
  type TokenUsage,
  type WorkerRequest,
} from "../packages/core/src/index.ts";
import { runProbe } from "../packages/probes/src/index.ts";
import { writeJsonAtomic } from "../packages/runtime/src/json.ts";
import {
  buildSanitizedLiveProtocolEvidence,
  verifyLiveQualificationEvidenceBinding,
  writeSanitizedLiveProtocolEvidence,
  type SanitizedLiveProtocolEvidence,
} from "./live-qualification-protocol-evidence.ts";

const execFileAsync = promisify(execFile);
const QUALIFICATION_PREFIX = "GRAPHCRAFT_LIVE_QUALIFICATION_";
const PROCESS_TIMEOUT_MS = 5 * 60_000;
const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;
const MAX_PROTOCOL_LINES = 10_000;
const qualificationRequested = Object.keys(process.env).some((name) =>
  name.startsWith(QUALIFICATION_PREFIX),
);

type Host = "codex" | "claude";
type Effort = HostExecutionPolicy["effort"];

interface HostConfiguration {
  host: Host;
  rawVersion: string;
  model: string;
  effort: Effort;
}

interface QualificationConfiguration {
  hosts: HostConfiguration[];
  outputPath: string;
  protocolEvidencePath?: string;
}

interface UsageNumbers {
  input: number;
  cachedInput: number;
  uncachedInput: number;
  output: number;
  reasoning: number;
  total: number;
}

interface HostQualification {
  control: {
    rawVersion: string;
    model: string;
    effort: Effort;
  };
  identity: {
    installed: true;
    authenticated: true;
  };
  sessionIdSha256: string;
  continuityTokenSha256: string;
  capabilityOutcomes: {
    structuredPlanning: { passed: true; family: "audit"; nodeCount: number };
    streamingSession: { passed: true; nativeEventCount: number };
    explicitCancellation: {
      passed: true;
      cause: "user_pause";
      outcome: Exclude<HostTermination["outcome"], "already_exited">;
    };
    exactSessionResume: {
      passed: true;
      resultStatus: "completed";
      fixtureEvidenceMatched: true;
      conversationContinuityMatched: true;
    };
    tokenReporting: {
      passed: true;
      phases: ["planning", "session_seed", "resumed_worker", "semantic_verification"];
    };
    semanticVerification: { passed: true; verdict: "supported" };
    byteCleanWorktree: { passed: true };
  };
  usageSummary: {
    planning: UsageNumbers;
    sessionSeed: UsageNumbers;
    resumedWorker: UsageNumbers;
    semanticVerification: UsageNumbers;
    aggregate: UsageNumbers;
  };
  startedAt: string;
  completedAt: string;
}

interface QualificationControls {
  graphcraftPackageVersion: string;
  sourceGitHead: string;
  sourceGitStatus: "clean" | "dirty";
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  fixtureGitHead: string;
  fixtureTreeSha256: string;
  taskSha256: string;
  fixtureTaskSha256: string;
}

interface QualificationReport {
  schemaVersion: 1;
  kind: "graphcraft-live-host-qualification";
  controls: QualificationControls;
  hosts: Partial<Record<Host, HostQualification>>;
  startedAt: string;
  completedAt: string;
}

interface NativeProcessResult {
  exitCode: number | null;
  termination?: HostTermination;
}

interface NativeWorkerResult {
  events: HostEvent[];
  nativeEvents: Record<string, unknown>[];
  nativeEventCount: number;
  streamingEvidence: boolean;
  sessionId?: string;
}

const FIXTURE_README = `# Graphcraft live qualification fixture

This repository contains one immutable JSON record used to qualify a candidate host protocol.
The qualification task is read-only.
`;
const FIXTURE_RECORD = `${JSON.stringify(
  {
    schemaVersion: 1,
    marker: "graphcraft-live-qualification",
    values: [2, 3, 5],
    expectedSum: 10,
  },
  null,
  2,
)}\n`;
const QUALIFICATION_TASK =
  "Audit qualification.json, report its marker, and verify that values sum to expectedSum without changing any repository byte.";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`Missing required live qualification environment variable ${name}`);
  if (value !== value.trim())
    throw new Error(`Live qualification environment variable ${name} has surrounding whitespace`);
  return value;
}

function parseConfiguration(): QualificationConfiguration {
  const hostNames = requiredEnvironment(`${QUALIFICATION_PREFIX}HOSTS`).split(",");
  if (hostNames.some((host) => host.length === 0))
    throw new Error(`${QUALIFICATION_PREFIX}HOSTS contains an empty host`);
  const unknown = hostNames.filter((host) => host !== "codex" && host !== "claude");
  if (unknown.length > 0)
    throw new Error(
      `${QUALIFICATION_PREFIX}HOSTS contains unsupported hosts: ${unknown.join(", ")}`,
    );
  if (new Set(hostNames).size !== hostNames.length)
    throw new Error(`${QUALIFICATION_PREFIX}HOSTS must not contain duplicates`);

  const efforts = new Set<Effort>(["low", "medium", "high", "xhigh"]);
  const shorthandModels = new Set([
    "default",
    "latest",
    "recommended",
    "codex",
    "opus",
    "sonnet",
    "haiku",
  ]);
  const hosts = (hostNames as Host[]).sort().map((host): HostConfiguration => {
    const stem = `${QUALIFICATION_PREFIX}${host.toUpperCase()}_`;
    const rawVersion = requiredEnvironment(`${stem}RAW_VERSION`);
    const model = requiredEnvironment(`${stem}MODEL`);
    const effortValue = requiredEnvironment(`${stem}EFFORT`);
    if (!efforts.has(effortValue as Effort))
      throw new Error(`${stem}EFFORT must be low, medium, high, or xhigh`);
    if (
      shorthandModels.has(model.toLowerCase()) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/u.test(model)
    ) {
      throw new Error(`${stem}MODEL must be an explicit full model ID, not an alias`);
    }
    return { host, rawVersion, model, effort: effortValue as Effort };
  });
  const configuredOutputPath = requiredEnvironment(`${QUALIFICATION_PREFIX}OUTPUT_PATH`);
  const protocolEvidencePath = process.env[`${QUALIFICATION_PREFIX}PROTOCOL_EVIDENCE_PATH`];
  if (protocolEvidencePath !== undefined) {
    if (
      protocolEvidencePath.length === 0 ||
      protocolEvidencePath !== protocolEvidencePath.trim() ||
      !isAbsolute(protocolEvidencePath) ||
      resolve(protocolEvidencePath) !== protocolEvidencePath
    ) {
      throw new Error(
        `${QUALIFICATION_PREFIX}PROTOCOL_EVIDENCE_PATH must be an absolute normalized path`,
      );
    }
  }
  return {
    hosts,
    outputPath: isAbsolute(configuredOutputPath)
      ? configuredOutputPath
      : resolve(process.cwd(), configuredOutputPath),
    ...(protocolEvidencePath ? { protocolEvidencePath } : {}),
  };
}

async function git(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: environment,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

async function createFixture(): Promise<{ root: string; gitHead: string; treeSha256: string }> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-live-qualification-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await git(root, ["config", "core.filemode", "false"]);
  await git(root, ["config", "commit.gpgSign", "false"]);
  await Promise.all([
    writeFile(join(root, "README.md"), FIXTURE_README, "utf8"),
    writeFile(join(root, "qualification.json"), FIXTURE_RECORD, "utf8"),
  ]);
  await git(root, ["add", "README.md", "qualification.json"]);
  const commitEnvironment = {
    ...process.env,
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_AUTHOR_EMAIL: "graphcraft@example.test",
    GIT_AUTHOR_NAME: "Graphcraft Qualification",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_EMAIL: "graphcraft@example.test",
    GIT_COMMITTER_NAME: "Graphcraft Qualification",
  };
  await git(
    root,
    ["commit", "-m", "Create deterministic qualification fixture"],
    commitEnvironment,
  );
  const gitHead = (await git(root, ["rev-parse", "HEAD"])).trim();
  const treeSha256 = await worktreeByteDigest(root);
  await assertFixtureClean(root, treeSha256);
  return { root, gitHead, treeSha256 };
}

async function worktreeByteDigest(repository: string): Promise<string> {
  const tracked = (await git(repository, ["ls-files", "-z"])).split("\0").filter(Boolean).sort();
  const digest = createHash("sha256");
  for (const path of tracked) {
    const bytes = await readFile(join(repository, path));
    digest.update(`${Buffer.byteLength(path)}:`);
    digest.update(path);
    digest.update(`:${bytes.length}:`);
    digest.update(bytes);
  }
  return digest.digest("hex");
}

async function assertFixtureClean(repository: string, expectedTreeSha256: string): Promise<void> {
  const [status, diff, treeSha256] = await Promise.all([
    git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(repository, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]),
    worktreeByteDigest(repository),
  ]);
  if (status !== "" || diff !== "" || treeSha256 !== expectedTreeSha256)
    throw new Error("The live qualification fixture is not byte-clean and unchanged");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} is not a JSON object`);
  return value as Record<string, unknown>;
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

function parseStructuredString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizedUsage(host: Host, value: unknown): TokenUsage {
  return TokenUsageSchema.parse(host === "codex" ? codexUsage(value) : claudeUsage(value));
}

function requireNonzeroUsage(value: TokenUsage | undefined, phase: string): TokenUsage {
  if (!value || value.total <= 0) throw new Error(`${phase} did not report nonzero token usage`);
  return value;
}

function usageNumbers(usage: TokenUsage): UsageNumbers {
  return {
    input: usage.input,
    cachedInput: usage.cachedInput,
    uncachedInput: usage.uncachedInput,
    output: usage.output,
    reasoning: usage.reasoning,
    total: usage.total,
  };
}

function aggregateUsage(usages: UsageNumbers[]): UsageNumbers {
  const result: UsageNumbers = {
    input: 0,
    cachedInput: 0,
    uncachedInput: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
  for (const usage of usages) {
    result.input += usage.input;
    result.cachedInput += usage.cachedInput;
    result.uncachedInput += usage.uncachedInput;
    result.output += usage.output;
    result.reasoning += usage.reasoning;
    result.total += usage.total;
  }
  return result;
}

async function runNativeProcess(
  executable: string,
  host: Host,
  args: string[],
  cwd: string,
  input: string | undefined,
  onEvent: (
    event: Record<string, unknown>,
    abort: (reason: { cause: "user_pause" | "cancellation"; reason: string }) => void,
  ) => void,
): Promise<NativeProcessResult> {
  const cancellation = new AbortController();
  const child = crossSpawn.spawn(executable, args, {
    cwd,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    shell: false,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr)
    throw new Error(`${host} live qualification could not open protocol streams`);
  if (input !== undefined) child.stdin?.end(input);

  let spawnError: Error | undefined;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      let settled = false;
      const complete = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        resolveExit({ code, signal });
      };
      child.once("error", (error) => {
        spawnError = error;
        complete(null, null);
      });
      child.once("close", complete);
    },
  );
  const terminationController = new ChildTerminationController(child, cancellation.signal);
  const stderr = captureStderr(child.stderr);
  const timeout = setTimeout(() => {
    cancellation.abort({ cause: "timeout", reason: `${host} live qualification timed out` });
  }, PROCESS_TIMEOUT_MS);
  timeout.unref();

  let protocolBytes = 0;
  let protocolLines = 0;
  let protocolError: Error | undefined;
  try {
    for await (const line of readBoundedProtocolLines(child.stdout, cancellation.signal)) {
      protocolBytes += line.observedBytes;
      protocolLines += 1;
      if (
        line.overflowed ||
        protocolBytes > MAX_PROTOCOL_BYTES ||
        protocolLines > MAX_PROTOCOL_LINES
      ) {
        protocolError = new Error(`${host} live qualification protocol exceeded its bounds`);
        cancellation.abort({ cause: "cancellation", reason: protocolError.message });
        break;
      }
      if (!line.text?.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line.text);
      } catch {
        protocolError = new Error(`${host} emitted a non-JSON protocol line`);
        cancellation.abort({ cause: "cancellation", reason: protocolError.message });
        break;
      }
      try {
        onEvent(record(event, `${host} protocol event`), (reason) => cancellation.abort(reason));
      } catch (error) {
        protocolError = error instanceof Error ? error : new Error(String(error));
        cancellation.abort({ cause: "cancellation", reason: protocolError.message });
        break;
      }
    }
    const outcome = await terminationController.waitForExit(exit);
    const termination = terminationController.finish(outcome.code, outcome.signal);
    if (spawnError) throw spawnError;
    if (protocolError) throw protocolError;
    if (stderr.overflowed) throw new Error(`${host} stderr exceeded its qualification bound`);
    if (termination?.cause === "timeout") throw new Error(`${host} live qualification timed out`);
    return {
      exitCode: outcome.code,
      ...(termination ? { termination } : {}),
    };
  } finally {
    clearTimeout(timeout);
    terminationController.dispose();
  }
}

async function withCodexSchema<T>(
  host: Host,
  schema: unknown,
  action: (schemaPath: string | undefined) => Promise<T>,
): Promise<T> {
  if (host === "claude") return await action(undefined);
  const directory = await mkdtemp(join(tmpdir(), "graphcraft-live-qualification-schema-"));
  try {
    const path = join(directory, "result.schema.json");
    await writeFile(path, JSON.stringify(schema), "utf8");
    return await action(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function qualifyPlanning(
  configuration: HostConfiguration,
  request: PlanningRequest,
  executable: string,
): Promise<{ plan: GraphPlan; usage: TokenUsage }> {
  return await withCodexSchema(configuration.host, codexGraphPlanJsonSchema, async (schemaPath) => {
    const policy = { model: configuration.model, effort: configuration.effort };
    const args =
      configuration.host === "codex"
        ? codexPlannerArgs(request, schemaPath!, policy)
        : claudePlannerArgs(request, policy);
    let plan: GraphPlan | undefined;
    let usage: TokenUsage | undefined;
    const processResult = await runNativeProcess(
      executable,
      configuration.host,
      args,
      request.repositoryPath,
      configuration.host === "codex" ? renderPlannerPrompt(request) : undefined,
      (event) => {
        if (configuration.host === "codex") {
          const item = record(event.item ?? {}, "Codex planner item");
          if (event.type === "item.completed" && item.type === "agent_message") {
            if (structuredOutputExceedsLimit(item.text))
              throw new Error("Codex planner structured output exceeded its bound");
            plan = GraphPlanSchema.parse(
              omitNullObjectProperties(parseStructuredString(item.text)),
            );
          }
          if (event.type === "turn.completed") usage = normalizedUsage("codex", event.usage);
        } else if (event.type === "result") {
          const candidate = event.structured_output ?? event.result;
          if (structuredOutputExceedsLimit(candidate))
            throw new Error("Claude planner structured output exceeded its bound");
          plan = GraphPlanSchema.parse(parseStructuredString(candidate));
          usage = normalizedUsage("claude", event.usage);
        }
      },
    );
    if (processResult.termination || processResult.exitCode !== 0 || !plan)
      throw new Error(`${configuration.host} did not return a valid structured graph plan`);
    return { plan, usage: requireNonzeroUsage(usage, `${configuration.host} planning`) };
  });
}

async function runWorker(
  configuration: HostConfiguration,
  request: WorkerRequest,
  abortAfterSession: boolean,
  executable: string,
  captureNativeEvents = false,
): Promise<NativeWorkerResult> {
  return await withCodexSchema(
    configuration.host,
    codexWorkerResultJsonSchema,
    async (schemaPath) => {
      const policy = { model: configuration.model, effort: configuration.effort };
      const args =
        configuration.host === "codex"
          ? codexWorkerArgs(request, schemaPath!, policy)
          : claudeWorkerArgs(request, policy);
      const events: HostEvent[] = [
        HostEventSchema.parse({ type: "started", invocationId: request.invocationId }),
      ];
      const nativeEvents: Record<string, unknown>[] = [];
      let nativeEventCount = 0;
      let observedSessionId: string | undefined;
      let sessionReported = false;
      let streamingEvidence = false;
      const processResult = await runNativeProcess(
        executable,
        configuration.host,
        args,
        request.repositoryPath,
        configuration.host === "codex" ? renderWorkerPrompt(request.capsule) : undefined,
        (event, abort) => {
          if (captureNativeEvents) nativeEvents.push(event);
          nativeEventCount += 1;
          const type = String(event.type ?? "");
          if (configuration.host === "codex") {
            if (type === "item.started" || type === "item.completed") streamingEvidence = true;
            if (type === "thread.started" && typeof event.thread_id === "string") {
              if (observedSessionId && observedSessionId !== event.thread_id)
                throw new Error("Codex changed session identity within one invocation");
              observedSessionId = event.thread_id;
            }
            const item = record(event.item ?? {}, "Codex worker item");
            if (!sessionReported && observedSessionId && type.startsWith("item.")) {
              sessionReported = true;
              events.push(
                HostEventSchema.parse({ type: "session", hostSessionId: observedSessionId }),
              );
              if (abortAfterSession)
                abort({ cause: "user_pause", reason: "Live qualification interruption" });
            }
            if (type === "item.completed" && item.type === "agent_message") {
              if (structuredOutputExceedsLimit(item.text))
                throw new Error("Codex worker structured output exceeded its bound");
              const text = String(item.text ?? "");
              events.push(HostEventSchema.parse({ type: "message", text }));
              const parsed = WorkerResultSchema.safeParse(
                omitNullObjectProperties(parseStructuredString(text)),
              );
              if (parsed.success)
                events.push(HostEventSchema.parse({ type: "result", result: parsed.data }));
            } else if ((type === "item.started" || type === "item.completed") && item.type) {
              events.push(
                HostEventSchema.parse({
                  type: "tool",
                  name: String(item.type),
                  summary: String(item.command ?? item.name ?? ""),
                }),
              );
            } else if (type === "turn.completed") {
              events.push(
                HostEventSchema.parse({
                  type: "usage",
                  usage: normalizedUsage("codex", event.usage),
                }),
              );
            }
          } else {
            if (type === "assistant") streamingEvidence = true;
            if (typeof event.session_id === "string") {
              if (observedSessionId && observedSessionId !== event.session_id)
                throw new Error("Claude changed session identity within one invocation");
              observedSessionId = event.session_id;
            }
            if (
              !sessionReported &&
              observedSessionId &&
              (type === "assistant" || type === "result")
            ) {
              sessionReported = true;
              events.push(
                HostEventSchema.parse({ type: "session", hostSessionId: observedSessionId }),
              );
              if (abortAfterSession)
                abort({ cause: "user_pause", reason: "Live qualification interruption" });
            }
            if (type === "assistant") {
              const message = record(event.message ?? {}, "Claude assistant message");
              const blocks = Array.isArray(message.content) ? message.content : [];
              for (const value of blocks) {
                const block = record(value, "Claude content block");
                if (block.type === "text")
                  events.push(
                    HostEventSchema.parse({ type: "message", text: String(block.text ?? "") }),
                  );
                if (block.type === "tool_use")
                  events.push(
                    HostEventSchema.parse({
                      type: "tool",
                      name: String(block.name ?? "tool"),
                      summary: "tool call",
                    }),
                  );
              }
            }
            if (type === "result") {
              const candidate = event.structured_output ?? event.result;
              if (structuredOutputExceedsLimit(candidate))
                throw new Error("Claude worker structured output exceeded its bound");
              const result = WorkerResultSchema.safeParse(parseStructuredString(candidate));
              events.push(
                HostEventSchema.parse({
                  type: "usage",
                  usage: normalizedUsage("claude", event.usage),
                }),
              );
              if (result.success)
                events.push(HostEventSchema.parse({ type: "result", result: result.data }));
              else if (!abortAfterSession)
                throw new Error("Claude worker did not return a valid structured result");
            }
          }
        },
      );
      if (processResult.termination) {
        events.push(
          HostEventSchema.parse({ type: "terminated", termination: processResult.termination }),
        );
      } else if (processResult.exitCode !== 0) {
        throw new Error(`${configuration.host} worker exited without a valid result`);
      }
      return {
        events,
        nativeEvents,
        nativeEventCount,
        streamingEvidence,
        ...(observedSessionId ? { sessionId: observedSessionId } : {}),
      };
    },
  );
}

async function qualifySemanticVerification(
  configuration: HostConfiguration,
  request: SemanticVerificationRequest,
  executable: string,
): Promise<{ verdict: SemanticVerdict; usage: TokenUsage }> {
  return await withCodexSchema(
    configuration.host,
    codexSemanticVerdictJsonSchema,
    async (schemaPath) => {
      const policy = { model: configuration.model, effort: configuration.effort };
      const args =
        configuration.host === "codex"
          ? codexSemanticVerifierArgs(request, schemaPath!, policy)
          : claudeSemanticVerifierArgs(request, policy);
      let verdict: SemanticVerdict | undefined;
      let usage: TokenUsage | undefined;
      const processResult = await runNativeProcess(
        executable,
        configuration.host,
        args,
        request.repositoryPath,
        configuration.host === "codex" ? renderSemanticVerifierPrompt(request.context) : undefined,
        (event) => {
          if (configuration.host === "codex") {
            const item = record(event.item ?? {}, "Codex verifier item");
            if (event.type === "item.completed" && item.type === "agent_message") {
              if (structuredOutputExceedsLimit(item.text))
                throw new Error("Codex verifier structured output exceeded its bound");
              verdict = SemanticVerdictSchema.parse(parseStructuredString(item.text));
            }
            if (event.type === "turn.completed") usage = normalizedUsage("codex", event.usage);
          } else if (event.type === "result") {
            const candidate = event.structured_output ?? event.result;
            if (structuredOutputExceedsLimit(candidate))
              throw new Error("Claude verifier structured output exceeded its bound");
            verdict = SemanticVerdictSchema.parse(parseStructuredString(candidate));
            usage = normalizedUsage("claude", event.usage);
          }
        },
      );
      if (processResult.termination || processResult.exitCode !== 0 || !verdict)
        throw new Error(`${configuration.host} did not return a valid semantic verdict`);
      return {
        verdict,
        usage: requireNonzeroUsage(usage, `${configuration.host} semantic verification`),
      };
    },
  );
}

async function probeQualificationExecutable(host: Host, executable: string) {
  return host === "codex"
    ? await probeCodexExecutable(executable)
    : await probeClaudeExecutable(executable);
}

async function qualifyHost(
  configuration: HostConfiguration,
  request: PlanningRequest,
  workerRequest: WorkerRequest,
  fixtureTreeSha256: string,
  captureProtocolEvidence: boolean,
): Promise<{
  report: HostQualification;
  rawSessionId: string;
  rawContinuityToken: string;
  protocolCapture?: {
    interruptedWorker: Record<string, unknown>[];
    resumedWorker: Record<string, unknown>[];
  };
}> {
  const startedAt = new Date().toISOString();
  const repositoryPaths = [
    ...new Set([process.cwd(), request.repositoryPath, workerRequest.repositoryPath]),
  ];
  const discoveredRoots = await Promise.all(repositoryPaths.map(discoverRepositoryTrustRoots));
  const untrustedRoots = [...new Set([...repositoryPaths, ...discoveredRoots.flat()])];
  const executable = await resolveTrustedExecutable(configuration.host, { untrustedRoots });
  const identity = await probeQualificationExecutable(configuration.host, executable);
  expect(identity.installed, `${configuration.host} is not installed`).toBe(true);
  expect(identity.authenticated, `${configuration.host} is not authenticated`).toBe(true);
  expect(identity.version, `${configuration.host} raw version mismatch`).toBe(
    configuration.rawVersion,
  );

  const planning = await qualifyPlanning(configuration, request, executable);
  const graph = compilePlannedGraph(
    request.contract,
    planning.plan,
    request.verificationProbes,
    request.probePlan.items.map(({ probe }) => probe),
  );
  if (graph.family !== "audit")
    throw new Error(`${configuration.host} planning changed the qualification task family`);
  await assertFixtureClean(request.repositoryPath, fixtureTreeSha256);

  const rawContinuityToken = `graphcraft-continuity-${randomUUID()}`;
  const seeded = await runWorker(
    configuration,
    {
      ...workerRequest,
      invocationId: randomUUID(),
      capsule: ContextCapsuleSchema.parse({
        ...workerRequest.capsule,
        objective:
          `Memorize the exact continuity token ${rawContinuityToken}. ` +
          "Return a completed read-only result whose evidence contains that exact token.",
        constraints: [
          "Do not modify the repository.",
          "Include the exact continuity token in the structured result summary or evidence.",
        ],
      }),
    },
    false,
    executable,
  );
  const rawSessionId = seeded.sessionId;
  if (!rawSessionId) throw new Error(`${configuration.host} did not stream a session ID`);
  const seededResult = seeded.events.findLast((event) => event.type === "result");
  if (
    seededResult?.type !== "result" ||
    seededResult.result.status !== "completed" ||
    ![seededResult.result.summary, ...seededResult.result.evidence]
      .join("\n")
      .includes(rawContinuityToken) ||
    seededResult.result.changedPaths.length !== 0
  ) {
    throw new Error(`${configuration.host} did not seed the exact continuity token`);
  }
  const seedUsageEvent = seeded.events.findLast((event) => event.type === "usage");
  const seedUsage = requireNonzeroUsage(
    seedUsageEvent?.type === "usage" ? seedUsageEvent.usage : undefined,
    `${configuration.host} session seed`,
  );
  await assertFixtureClean(request.repositoryPath, fixtureTreeSha256);

  const interruptionRequest: WorkerRequest = {
    ...workerRequest,
    invocationId: randomUUID(),
    resumeSessionId: rawSessionId,
    capsule: ContextCapsuleSchema.parse({
      ...workerRequest.capsule,
      objective:
        "Continue the existing session and begin a second read-only turn. " +
        "Wait to report the earlier continuity token until the next turn.",
      constraints: ["Do not modify the repository."],
    }),
  };
  if (JSON.stringify(interruptionRequest).includes(rawContinuityToken))
    throw new Error("The interruption request leaked the continuity token");
  const interrupted = await runWorker(
    configuration,
    interruptionRequest,
    true,
    executable,
    captureProtocolEvidence,
  );
  if (interrupted.sessionId !== rawSessionId)
    throw new Error(`${configuration.host} changed session identity before interruption`);
  const terminated = interrupted.events.findLast((event) => event.type === "terminated");
  if (terminated?.type !== "terminated" || terminated.termination.cause !== "user_pause")
    throw new Error(`${configuration.host} did not emit the explicit terminated event`);
  if (terminated.termination.outcome === "already_exited")
    throw new Error(`${configuration.host} exited before the explicit interruption took effect`);
  if (!interrupted.streamingEvidence) {
    throw new Error(`${configuration.host} did not stream native session evidence`);
  }
  await assertFixtureClean(request.repositoryPath, fixtureTreeSha256);

  const resumeRequest: WorkerRequest = {
    ...workerRequest,
    invocationId: randomUUID(),
    resumeSessionId: rawSessionId,
    capsule: ContextCapsuleSchema.parse({
      ...workerRequest.capsule,
      objective:
        `${QUALIFICATION_TASK} Also report the exact continuity token from the earlier ` +
        "completed turn; that token is intentionally absent from this request and repository.",
      constraints: [
        ...workerRequest.capsule.constraints,
        "Recall the exact continuity token from conversation state without guessing.",
      ],
    }),
  };
  if (JSON.stringify(resumeRequest).includes(rawContinuityToken))
    throw new Error("The resume request leaked the continuity token");
  const resumed = await runWorker(
    configuration,
    resumeRequest,
    false,
    executable,
    captureProtocolEvidence,
  );
  if (resumed.sessionId !== rawSessionId)
    throw new Error(`${configuration.host} did not resume the exact interrupted session`);
  const resultEvent = resumed.events.findLast((event) => event.type === "result");
  if (resultEvent?.type !== "result" || resultEvent.result.status !== "completed")
    throw new Error(`${configuration.host} exact-session resume did not complete`);
  const fixtureEvidence = [resultEvent.result.summary, ...resultEvent.result.evidence].join("\n");
  if (
    !fixtureEvidence.includes("graphcraft-live-qualification") ||
    !/(?:^|\D)10(?:\D|$)/u.test(fixtureEvidence) ||
    !fixtureEvidence.includes(rawContinuityToken) ||
    resultEvent.result.changedPaths.length !== 0
  ) {
    throw new Error(
      `${configuration.host} resumed result did not report the deterministic fixture evidence`,
    );
  }
  const workerUsageEvent = resumed.events.findLast((event) => event.type === "usage");
  const workerUsage = requireNonzeroUsage(
    workerUsageEvent?.type === "usage" ? workerUsageEvent.usage : undefined,
    `${configuration.host} resumed worker`,
  );
  await assertFixtureClean(request.repositoryPath, fixtureTreeSha256);

  const probe = await runProbe(request.verificationProbes[0]!, request.repositoryPath);
  if (!probe.result.passed) throw new Error("The deterministic qualification probe failed");
  const verification = await qualifySemanticVerification(
    configuration,
    {
      invocationId: randomUUID(),
      repositoryPath: request.repositoryPath,
      context: SemanticVerifierContextSchema.parse({
        schemaVersion: 1,
        phase: "completion",
        runId: request.contract.runId,
        nodeId: "qualification-audit",
        objective: QUALIFICATION_TASK,
        finishLine: { kind: "local_verified" },
        acceptanceAnchors: request.contract.acceptanceAnchors,
        relevantPaths: ["qualification.json"],
        workerSummary: resultEvent.result.summary,
        workerEvidence: resultEvent.result.evidence,
        baselineProbeEvidence: [],
        currentProbeEvidence: [probe.result],
      }),
    },
    executable,
  );
  if (verification.verdict.verdict !== "supported" || verification.verdict.evidence.length === 0)
    throw new Error(`${configuration.host} semantic verification was not grounded and supported`);
  await assertFixtureClean(request.repositoryPath, fixtureTreeSha256);

  const finalIdentity = await probeQualificationExecutable(configuration.host, executable);
  expect(finalIdentity.installed, `${configuration.host} disappeared during qualification`).toBe(
    true,
  );
  expect(
    finalIdentity.authenticated,
    `${configuration.host} lost authentication during qualification`,
  ).toBe(true);
  expect(finalIdentity.version, `${configuration.host} changed version during qualification`).toBe(
    configuration.rawVersion,
  );

  const completedAt = new Date().toISOString();
  return {
    rawSessionId,
    rawContinuityToken,
    ...(captureProtocolEvidence
      ? {
          protocolCapture: {
            interruptedWorker: interrupted.nativeEvents,
            resumedWorker: resumed.nativeEvents,
          },
        }
      : {}),
    report: {
      control: {
        rawVersion: configuration.rawVersion,
        model: configuration.model,
        effort: configuration.effort,
      },
      identity: { installed: true, authenticated: true },
      sessionIdSha256: sha256(rawSessionId),
      continuityTokenSha256: sha256(rawContinuityToken),
      capabilityOutcomes: {
        structuredPlanning: { passed: true, family: graph.family, nodeCount: graph.nodes.length },
        streamingSession: {
          passed: true,
          nativeEventCount: interrupted.nativeEventCount,
        },
        explicitCancellation: {
          passed: true,
          cause: "user_pause",
          outcome: terminated.termination.outcome,
        },
        exactSessionResume: {
          passed: true,
          resultStatus: "completed",
          fixtureEvidenceMatched: true,
          conversationContinuityMatched: true,
        },
        tokenReporting: {
          passed: true,
          phases: ["planning", "session_seed", "resumed_worker", "semantic_verification"],
        },
        semanticVerification: { passed: true, verdict: "supported" },
        byteCleanWorktree: { passed: true },
      },
      usageSummary: {
        planning: usageNumbers(planning.usage),
        sessionSeed: usageNumbers(seedUsage),
        resumedWorker: usageNumbers(workerUsage),
        semanticVerification: usageNumbers(verification.usage),
        aggregate: aggregateUsage([planning.usage, seedUsage, workerUsage, verification.usage]),
      },
      startedAt,
      completedAt,
    },
  };
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label} does not match qualification report schema version 1`);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseUsageNumbers(value: unknown, label: string): void {
  const usage = record(value, label);
  exactKeys(
    usage,
    ["input", "cachedInput", "uncachedInput", "output", "reasoning", "total"],
    label,
  );
  for (const [name, amount] of Object.entries(usage)) {
    if (!Number.isSafeInteger(amount) || (amount as number) < 0)
      throw new Error(`${label}.${name} is not a nonnegative safe integer`);
  }
  if ((usage.total as number) <= 0) throw new Error(`${label} has no reported tokens`);
}

function parseHostQualification(value: unknown, host: Host): HostQualification {
  const entry = record(value, `${host} qualification`);
  exactKeys(
    entry,
    [
      "control",
      "identity",
      "sessionIdSha256",
      "continuityTokenSha256",
      "capabilityOutcomes",
      "usageSummary",
      "startedAt",
      "completedAt",
    ],
    `${host} qualification`,
  );
  const control = record(entry.control, `${host} qualification control`);
  exactKeys(control, ["rawVersion", "model", "effort"], `${host} qualification control`);
  if (
    !nonemptyString(control.rawVersion) ||
    !nonemptyString(control.model) ||
    !["low", "medium", "high", "xhigh"].includes(String(control.effort)) ||
    typeof entry.sessionIdSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.sessionIdSha256) ||
    typeof entry.continuityTokenSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.continuityTokenSha256) ||
    !validTimestamp(entry.startedAt) ||
    !validTimestamp(entry.completedAt) ||
    entry.startedAt > entry.completedAt
  ) {
    throw new Error(`${host} qualification report entry is invalid`);
  }

  const identity = record(entry.identity, `${host} qualification identity`);
  exactKeys(identity, ["installed", "authenticated"], `${host} qualification identity`);
  if (identity.installed !== true || identity.authenticated !== true)
    throw new Error(`${host} qualification identity did not pass`);

  const outcomes = record(entry.capabilityOutcomes, `${host} qualification outcomes`);
  exactKeys(
    outcomes,
    [
      "structuredPlanning",
      "streamingSession",
      "explicitCancellation",
      "exactSessionResume",
      "tokenReporting",
      "semanticVerification",
      "byteCleanWorktree",
    ],
    `${host} qualification outcomes`,
  );
  const structuredPlanning = record(
    outcomes.structuredPlanning,
    `${host} structured planning outcome`,
  );
  exactKeys(
    structuredPlanning,
    ["passed", "family", "nodeCount"],
    `${host} structured planning outcome`,
  );
  if (
    structuredPlanning.passed !== true ||
    structuredPlanning.family !== "audit" ||
    !Number.isSafeInteger(structuredPlanning.nodeCount) ||
    (structuredPlanning.nodeCount as number) <= 0
  ) {
    throw new Error(`${host} structured planning outcome did not pass`);
  }
  const streamingSession = record(outcomes.streamingSession, `${host} streaming session outcome`);
  exactKeys(streamingSession, ["passed", "nativeEventCount"], `${host} streaming session outcome`);
  if (
    streamingSession.passed !== true ||
    !Number.isSafeInteger(streamingSession.nativeEventCount) ||
    (streamingSession.nativeEventCount as number) <= 0
  ) {
    throw new Error(`${host} streaming session outcome did not pass`);
  }
  const cancellation = record(outcomes.explicitCancellation, `${host} cancellation outcome`);
  exactKeys(cancellation, ["passed", "cause", "outcome"], `${host} cancellation outcome`);
  if (
    cancellation.passed !== true ||
    cancellation.cause !== "user_pause" ||
    !["graceful", "forced"].includes(String(cancellation.outcome))
  ) {
    throw new Error(`${host} cancellation outcome did not pass`);
  }
  const resume = record(outcomes.exactSessionResume, `${host} resume outcome`);
  exactKeys(
    resume,
    ["passed", "resultStatus", "fixtureEvidenceMatched", "conversationContinuityMatched"],
    `${host} resume outcome`,
  );
  if (
    resume.passed !== true ||
    resume.resultStatus !== "completed" ||
    resume.fixtureEvidenceMatched !== true ||
    resume.conversationContinuityMatched !== true
  )
    throw new Error(`${host} resume outcome did not pass`);
  const tokens = record(outcomes.tokenReporting, `${host} token outcome`);
  exactKeys(tokens, ["passed", "phases"], `${host} token outcome`);
  if (
    tokens.passed !== true ||
    JSON.stringify(tokens.phases) !==
      JSON.stringify(["planning", "session_seed", "resumed_worker", "semantic_verification"])
  ) {
    throw new Error(`${host} token outcome did not pass`);
  }
  const semantic = record(outcomes.semanticVerification, `${host} semantic outcome`);
  exactKeys(semantic, ["passed", "verdict"], `${host} semantic outcome`);
  if (semantic.passed !== true || semantic.verdict !== "supported")
    throw new Error(`${host} semantic outcome did not pass`);
  const clean = record(outcomes.byteCleanWorktree, `${host} clean-worktree outcome`);
  exactKeys(clean, ["passed"], `${host} clean-worktree outcome`);
  if (clean.passed !== true) throw new Error(`${host} clean-worktree outcome did not pass`);

  const usage = record(entry.usageSummary, `${host} qualification usage`);
  exactKeys(
    usage,
    ["planning", "sessionSeed", "resumedWorker", "semanticVerification", "aggregate"],
    `${host} qualification usage`,
  );
  parseUsageNumbers(usage.planning, `${host} planning usage`);
  parseUsageNumbers(usage.sessionSeed, `${host} session seed usage`);
  parseUsageNumbers(usage.resumedWorker, `${host} resumed worker usage`);
  parseUsageNumbers(usage.semanticVerification, `${host} semantic verification usage`);
  parseUsageNumbers(usage.aggregate, `${host} aggregate usage`);
  const expectedAggregate = aggregateUsage([
    usage.planning as UsageNumbers,
    usage.sessionSeed as UsageNumbers,
    usage.resumedWorker as UsageNumbers,
    usage.semanticVerification as UsageNumbers,
  ]);
  if (JSON.stringify(usage.aggregate) !== JSON.stringify(expectedAggregate))
    throw new Error(`${host} aggregate usage does not match its phase totals`);
  return entry as unknown as HostQualification;
}

function parseExistingReport(value: unknown): QualificationReport {
  const report = record(value, "Qualification report");
  exactKeys(
    report,
    ["schemaVersion", "kind", "controls", "hosts", "startedAt", "completedAt"],
    "Qualification report",
  );
  if (report.schemaVersion !== 1 || report.kind !== "graphcraft-live-host-qualification")
    throw new Error("Qualification report has an unsupported schema or kind");
  if (!validTimestamp(report.startedAt) || !validTimestamp(report.completedAt))
    throw new Error("Qualification report has invalid timestamps");
  if (report.startedAt > report.completedAt)
    throw new Error("Qualification report timestamps are out of order");
  const controls = record(report.controls, "Qualification report controls");
  exactKeys(
    controls,
    [
      "graphcraftPackageVersion",
      "sourceGitHead",
      "sourceGitStatus",
      "platform",
      "arch",
      "node",
      "fixtureGitHead",
      "fixtureTreeSha256",
      "taskSha256",
      "fixtureTaskSha256",
    ],
    "Qualification report controls",
  );
  if (
    !nonemptyString(controls.graphcraftPackageVersion) ||
    typeof controls.sourceGitHead !== "string" ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(controls.sourceGitHead) ||
    (controls.sourceGitStatus !== "clean" && controls.sourceGitStatus !== "dirty") ||
    !nonemptyString(controls.platform) ||
    !nonemptyString(controls.arch) ||
    !nonemptyString(controls.node) ||
    typeof controls.fixtureGitHead !== "string" ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(controls.fixtureGitHead) ||
    typeof controls.fixtureTreeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(controls.fixtureTreeSha256) ||
    typeof controls.taskSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(controls.taskSha256) ||
    typeof controls.fixtureTaskSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(controls.fixtureTaskSha256)
  ) {
    throw new Error("Qualification report controls are invalid");
  }
  const hosts = record(report.hosts, "Qualification report hosts");
  if (Object.keys(hosts).length === 0)
    throw new Error("Qualification report contains no successful host qualification");
  for (const [host, candidate] of Object.entries(hosts)) {
    if (host !== "codex" && host !== "claude")
      throw new Error(`Qualification report contains unsupported host ${host}`);
    parseHostQualification(candidate, host);
  }
  return report as unknown as QualificationReport;
}

async function existingReport(path: string): Promise<QualificationReport | undefined> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink())
      throw new Error("Live qualification output must be a regular file");
    return parseExistingReport(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertReportControls(
  existing: QualificationReport | undefined,
  controls: QualificationControls,
  configurations: HostConfiguration[],
): void {
  if (!existing) return;
  if (JSON.stringify(existing.controls) !== JSON.stringify(controls))
    throw new Error("Existing qualification report controls do not match this run");
  for (const configuration of configurations) {
    const previous = existing.hosts[configuration.host];
    const expected = {
      rawVersion: configuration.rawVersion,
      model: configuration.model,
      effort: configuration.effort,
    };
    if (previous && JSON.stringify(previous.control) !== JSON.stringify(expected))
      throw new Error(`Existing ${configuration.host} report controls do not match this run`);
  }
}

describe.skipIf(!qualificationRequested)("candidate host live qualification", () => {
  it(
    "qualifies exact candidate versions without pre-granting a production protocol profile",
    async () => {
      const configuration = parseConfiguration();
      const qualificationStartedAt = new Date().toISOString();
      const sourceRoot = (await git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim();
      const packageMetadata = JSON.parse(
        await readFile(join(sourceRoot, "package.json"), "utf8"),
      ) as {
        version?: unknown;
      };
      if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0)
        throw new Error("Graphcraft package version is missing");
      const sourceGitHead = (await git(sourceRoot, ["rev-parse", "HEAD"])).trim();
      const sourceGitStatus =
        (await git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"])) === ""
          ? "clean"
          : "dirty";
      const fixture = await createFixture();
      try {
        const taskSha256 = sha256(QUALIFICATION_TASK);
        const fixtureTaskSha256 = sha256(
          JSON.stringify({
            readme: FIXTURE_README,
            record: FIXTURE_RECORD,
            taskSha256,
          }),
        );
        const controls: QualificationControls = {
          graphcraftPackageVersion: packageMetadata.version,
          sourceGitHead,
          sourceGitStatus,
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          fixtureGitHead: fixture.gitHead,
          fixtureTreeSha256: fixture.treeSha256,
          taskSha256,
          fixtureTaskSha256,
        };
        const previous = await existingReport(configuration.outputPath);
        assertReportControls(previous, controls, configuration.hosts);

        const contract = compileRunContract(
          QUALIFICATION_TASK,
          {
            root: fixture.root,
            baseRef: "main",
            baseSha: fixture.gitHead,
          },
          { finishLine: "local_verified", include: ["qualification.json", "README.md"] },
        );
        const probePlan = ProbePlanSchema.parse({
          schemaVersion: 1,
          family: "audit",
          items: [
            {
              phase: "completion",
              purpose: "acceptance",
              source: "Deterministic immutable qualification record",
              probe: {
                id: "qualification-record",
                kind: "file",
                path: "qualification.json",
                shouldExist: true,
                contains: '"expectedSum": 10',
              },
            },
          ],
        });
        const verificationProbes = probePlan.items.map(({ probe }) => probe);
        const planningRequest: PlanningRequest = {
          contract,
          repositoryPath: fixture.root,
          repositoryEvidence: {
            contentTrust: "untrusted_repository",
            trackedPathCount: 2,
            trackedPaths: ["README.md", "qualification.json"],
            trackedPathsTruncated: false,
            files: [
              { path: "README.md", content: FIXTURE_README, truncated: false },
              { path: "qualification.json", content: FIXTURE_RECORD, truncated: false },
            ],
          },
          probePlan,
          verificationProbes,
        };
        const workerRequest: WorkerRequest = {
          invocationId: randomUUID(),
          repositoryPath: fixture.root,
          capsule: ContextCapsuleSchema.parse({
            schemaVersion: 1,
            runId: contract.runId,
            nodeId: "qualification-audit",
            objective: QUALIFICATION_TASK,
            finishLine: { kind: "local_verified" },
            constraints: [
              "Read only; do not modify the repository.",
              "Report the marker and the arithmetic check using qualification.json as evidence.",
            ],
            acceptanceAnchors: contract.acceptanceAnchors,
            predecessorEvidence: [],
            relevantPaths: ["qualification.json"],
            probeEvidence: [],
          }),
          allowedTools: ["read"],
        };

        const results: Partial<Record<Host, HostQualification>> = {};
        const protocolCaptures: Partial<
          Record<
            Host,
            {
              interruptedWorker: Record<string, unknown>[];
              resumedWorker: Record<string, unknown>[];
            }
          >
        > = {};
        const rawSessionIds: string[] = [];
        const rawContinuityTokens: string[] = [];
        for (const host of configuration.hosts) {
          const result = await qualifyHost(
            host,
            planningRequest,
            workerRequest,
            fixture.treeSha256,
            configuration.protocolEvidencePath !== undefined,
          );
          results[host.host] = result.report;
          if (result.protocolCapture) protocolCaptures[host.host] = result.protocolCapture;
          rawSessionIds.push(result.rawSessionId);
          rawContinuityTokens.push(result.rawContinuityToken);
        }
        await assertFixtureClean(fixture.root, fixture.treeSha256);

        const report: QualificationReport = {
          schemaVersion: 1,
          kind: "graphcraft-live-host-qualification",
          controls,
          hosts: { ...previous?.hosts, ...results },
          startedAt: previous?.startedAt ?? qualificationStartedAt,
          completedAt: new Date().toISOString(),
        };
        const serialized = JSON.stringify(report);
        if (
          serialized.includes(QUALIFICATION_TASK) ||
          rawSessionIds.some((sessionId) => serialized.includes(sessionId)) ||
          rawContinuityTokens.some((token) => serialized.includes(token))
        ) {
          throw new Error(
            "Qualification report contains prohibited prompt, raw session, or continuity data",
          );
        }
        await writeJsonAtomic(configuration.outputPath, report);
        const persisted = parseExistingReport(
          JSON.parse(await readFile(configuration.outputPath, "utf8")),
        );
        assertReportControls(persisted, controls, configuration.hosts);
        if (configuration.protocolEvidencePath) {
          const reportBytes = await readFile(configuration.outputPath);
          const evidence: SanitizedLiveProtocolEvidence[] = configuration.hosts.map(
            (hostConfiguration) => {
              const hostReport = persisted.hosts[hostConfiguration.host];
              const capture = protocolCaptures[hostConfiguration.host];
              if (!hostReport || !capture)
                throw new Error(
                  `${hostConfiguration.host} protocol evidence lacks a successful qualification binding`,
                );
              const binding = {
                hashAlgorithms: {
                  qualificationReport: "sha256-exact-bytes-v1" as const,
                  hostQualification: "graphcraft-canonical-json-sha256-v1" as const,
                },
                qualificationReportSha256: sha256(reportBytes),
                hostQualificationSha256: contentHash(hostReport),
                qualificationReportSchemaVersion: persisted.schemaVersion,
                qualificationReportKind: persisted.kind,
                qualificationCompletedAt: persisted.completedAt,
                source: controls,
                control: hostReport.control,
              };
              verifyLiveQualificationEvidenceBinding({
                host: hostConfiguration.host,
                binding,
                qualificationReportBytes: reportBytes,
              });
              return buildSanitizedLiveProtocolEvidence({
                host: hostConfiguration.host,
                binding,
                interruptedWorker: capture.interruptedWorker,
                resumedWorker: capture.resumedWorker,
                expectedUsage: hostReport.usageSummary.resumedWorker,
                prohibitedValues: [
                  QUALIFICATION_TASK,
                  sourceRoot,
                  fixture.root,
                  configuration.outputPath,
                  ...rawSessionIds,
                  ...rawContinuityTokens,
                ],
              });
            },
          );
          await writeSanitizedLiveProtocolEvidence({
            outputPath: configuration.protocolEvidencePath,
            evidence,
            forbiddenRoots: [sourceRoot, fixture.root],
          });
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    45 * 60_000,
  );
});
