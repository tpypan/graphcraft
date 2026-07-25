import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BenchmarkSuiteSchema,
  BenchmarkReportV3Schema,
  BenchmarkReportV4Schema,
  LEGACY_CANONICAL_HASH_ALGORITHM,
  MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  REQUIRED_HOST_PROTOCOL_CAPABILITIES,
  assertRequiredHostCapabilities,
  contentHash,
  createBenchmarkSchedule,
  hostCapabilitiesFromProtocolProfile,
  reconcilePersistedInvocation,
  summarizeBenchmark,
  type HostAdapter,
  type BenchmarkSuite,
  type HostCapabilities,
  type HostEvent,
  type InvocationRecord,
  type PlanningRequest,
  type PlanningResult,
  type ReconciliationResult,
  type SemanticVerificationRequest,
  type SemanticVerificationResult,
  type TokenUsage,
  type WorkerRequest,
} from "@graphcraft/core";
import { runProcess } from "@graphcraft/probes";
import {
  DEFAULT_BENCHMARK_MODEL_CALL_TIMEOUT_MS,
  inspectBenchmarkSourceIdentity,
  runBenchmark as runBenchmarkRuntime,
} from "./benchmark.ts";
import { BENCHMARK_REPORT_LIMITATIONS } from "./benchmark-validation.ts";

const temporaryRoots: string[] = [];
const cleanBenchmarkSource = {
  commitSha: "a".repeat(40),
  dirty: false,
  dirtyStatusDigest: null,
} as const;

function runBenchmark(input: Parameters<typeof runBenchmarkRuntime>[0]) {
  return runBenchmarkRuntime({ graphcraftSource: cleanBenchmarkSource, ...input });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function usage(input: number, output: number): TokenUsage {
  return {
    input,
    cachedInput: 0,
    uncachedInput: input,
    output,
    reasoning: 0,
    total: input + output,
    availability: {
      input: "reported",
      cachedInput: "reported",
      uncachedInput: "derived",
      output: "reported",
      reasoning: "reported",
      total: "derived",
    },
  };
}

async function canonicalPathIdentity(path: string): Promise<string> {
  const canonical = resolve(await realpath(path));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

class BenchmarkAdapter implements HostAdapter {
  readonly id = "codex" as const;
  readonly graphcraftRepositories: string[] = [];
  readonly workerRequests: WorkerRequest[] = [];
  readonly activeWorkerRepositories = new Set<string>();
  readonly activePlannerRepositories = new Set<string>();
  readonly activeVerifierRepositories = new Set<string>();
  activeProbeCalls = 0;
  probeCalls = 0;
  planCalls = 0;
  verifyCalls = 0;

  constructor(
    private readonly options: {
      failureMessage?: string;
      usageReceipt?: TokenUsage;
      weakenBaselineScorer?: boolean;
      makeBaselineAcceptancePathDirectory?: boolean;
      binaryBaselineSecret?: string;
      ignoredBaselineSecret?: string;
      oversizedGraphcraftPatch?: boolean;
      baselineTranscriptMessageCount?: number;
      oversizedBaselineEvent?: boolean;
      capabilities?: Partial<HostCapabilities>;
      capabilitySequence?: HostCapabilities[];
      expectDeterministicLfFixture?: boolean;
      revalidatePlan?: boolean;
      revalidateExecute?: boolean;
      waitForWorkerAbort?: boolean;
      ignoreProbeAbort?: boolean;
      ignoreProbeAbortOnCall?: number;
      ignoreWorkerAbort?: boolean;
      ignorePlanAbort?: boolean;
      ignoreVerifyAbort?: boolean;
      onWorkerStarted?: () => void;
    } = {},
  ) {}

  private usage(input: number, output: number): TokenUsage {
    return this.options.usageReceipt ?? usage(input, output);
  }

  async probe(): Promise<HostCapabilities> {
    const call = this.probeCalls + 1;
    this.probeCalls = call;
    if (this.options.ignoreProbeAbort || this.options.ignoreProbeAbortOnCall === call) {
      this.activeProbeCalls += 1;
      await new Promise<void>(() => undefined);
    }
    const capabilities = {
      ...hostCapabilitiesFromProtocolProfile("codex", {
        installed: true,
        authenticated: true,
        version: "codex-cli 0.144.6",
      }),
      ...this.options.capabilities,
    };
    const sequenced = this.options.capabilitySequence?.[call - 1];
    return sequenced ?? capabilities;
  }

  async plan(request: PlanningRequest): Promise<PlanningResult> {
    this.planCalls += 1;
    if (this.options.ignorePlanAbort) {
      this.activePlannerRepositories.add(request.contract.repository.root);
      await new Promise<void>(() => undefined);
    }
    if (this.options.revalidatePlan) assertRequiredHostCapabilities(this.id, await this.probe());
    this.graphcraftRepositories.push(request.contract.repository.root);
    return {
      plan: {
        schemaVersion: 1,
        family: "feature",
        nodes: [
          {
            id: "implement",
            kind: "implementation",
            objective: request.contract.outcome,
            dependsOn: [],
            scope: ["**/*"],
            contextSelector: {
              includeRepositoryInstructions: true,
              predecessorResults: [],
              relevantPaths: ["package.json", "source.js", "verify.mjs"],
            },
            progressProbes: [
              {
                id: "workspace-diff",
                kind: "git_diff",
                baseSha: request.contract.repository.baseSha,
                requireChanges: true,
              },
            ],
            completionProbes: [],
            sideEffectClass: "workspace_write",
          },
          {
            id: "verify",
            kind: "verification",
            objective: "Verify the benchmark fixture",
            dependsOn: ["implement"],
            scope: ["**/*"],
            contextSelector: {
              includeRepositoryInstructions: true,
              predecessorResults: ["implement"],
              relevantPaths: ["package.json", "source.js", "verify.mjs"],
            },
            progressProbes: [],
            completionProbes: request.verificationProbes,
            sideEffectClass: "none",
          },
        ],
      },
      usage: this.usage(5, 2),
    };
  }

  async *execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent> {
    if (this.options.revalidateExecute) assertRequiredHostCapabilities(this.id, await this.probe());
    this.workerRequests.push(request);
    this.options.onWorkerStarted?.();
    if (this.options.ignoreWorkerAbort) {
      this.activeWorkerRepositories.add(request.repositoryPath);
      await new Promise<void>(() => undefined);
      return;
    }
    if (this.options.waitForWorkerAbort) {
      if (!signal.aborted)
        await new Promise<void>((resolveAbort) => {
          signal.addEventListener("abort", () => resolveAbort(), { once: true });
        });
      return;
    }
    if (this.options.expectDeterministicLfFixture) {
      const lineEndingPolicy = await runProcess(
        "git",
        ["config", "--local", "--get", "core.autocrlf"],
        { cwd: request.repositoryPath },
      );
      if (lineEndingPolicy.exitCode !== 0 || lineEndingPolicy.stdout.trim() !== "false")
        throw new Error("Benchmark fixture did not pin core.autocrlf=false");
      if ((await readFile(join(request.repositoryPath, "source.js"), "utf8")).includes("\r"))
        throw new Error("Benchmark fixture materialized non-LF line endings");
    }
    yield { type: "started", invocationId: request.invocationId };
    yield { type: "session", hostSessionId: request.invocationId };
    if (
      this.options.baselineTranscriptMessageCount &&
      request.capsule.nodeId.startsWith("baseline-")
    ) {
      for (let index = 0; index < this.options.baselineTranscriptMessageCount; index += 1)
        yield { type: "message", text: `message-${index}:${"x".repeat(64 * 1024)}` };
    }
    if (this.options.oversizedBaselineEvent && request.capsule.nodeId.startsWith("baseline-"))
      yield { type: "message", text: "x".repeat(300 * 1024) };
    if (this.options.failureMessage) {
      yield { type: "error", message: this.options.failureMessage };
      return;
    }
    if (this.options.weakenBaselineScorer && request.capsule.nodeId.startsWith("baseline-")) {
      await writeFile(join(request.repositoryPath, "score.mjs"), "process.exit(0);\n", "utf8");
      yield { type: "usage", usage: this.usage(10, 4) };
      yield {
        type: "result",
        result: {
          status: "completed",
          summary: "Changed the visible check without implementing the task",
          changedPaths: ["score.mjs"],
          evidence: ["mutable visible check passes"],
        },
      };
      return;
    }
    if (
      this.options.makeBaselineAcceptancePathDirectory &&
      request.capsule.nodeId.startsWith("baseline-")
    ) {
      const sourcePath = join(request.repositoryPath, "source.js");
      await rm(sourcePath, { force: true });
      await mkdir(sourcePath);
      yield { type: "usage", usage: this.usage(10, 4) };
      yield {
        type: "result",
        result: {
          status: "completed",
          summary: "Replaced the asserted file with a directory",
          changedPaths: ["source.js"],
          evidence: ["malformed acceptance target"],
        },
      };
      return;
    }
    if (this.options.binaryBaselineSecret && request.capsule.nodeId.startsWith("baseline-")) {
      await writeFile(
        join(request.repositoryPath, "result.bin"),
        Buffer.concat([
          Buffer.from([0]),
          Buffer.from(this.options.binaryBaselineSecret, "utf8"),
          Buffer.from([0xff]),
        ]),
      );
    }
    if (this.options.ignoredBaselineSecret && request.capsule.nodeId.startsWith("baseline-")) {
      await writeFile(join(request.repositoryPath, ".gitignore"), "ignored-result.txt\n", "utf8");
      await writeFile(
        join(request.repositoryPath, "ignored-result.txt"),
        this.options.ignoredBaselineSecret,
        "utf8",
      );
    }
    const source =
      this.options.oversizedGraphcraftPatch && !request.capsule.nodeId.startsWith("baseline-")
        ? `export const value = 'implemented';\n/*${"x".repeat(140 * 1024)}*/\n`
        : "export const value = 'implemented';\n";
    await writeFile(join(request.repositoryPath, "source.js"), source, "utf8");
    yield { type: "usage", usage: this.usage(10, 4) };
    yield {
      type: "result",
      result: {
        status: "completed",
        summary: "Implemented the matched fixture",
        changedPaths: ["source.js"],
        evidence: ["declared checks pass"],
      },
    };
  }

  async verify(request: SemanticVerificationRequest): Promise<SemanticVerificationResult> {
    this.verifyCalls += 1;
    if (this.options.ignoreVerifyAbort) {
      this.activeVerifierRepositories.add(request.repositoryPath);
      await new Promise<void>(() => undefined);
    }
    return {
      verdict: {
        verdict: "supported",
        evidence: ["fixture evidence"],
        rationale: "The deterministic fixture is satisfied",
        uncertainty: 0,
      },
      usage: this.usage(2, 1),
    };
  }

  async reconcile(invocation: InvocationRecord): Promise<ReconciliationResult> {
    return reconcilePersistedInvocation(invocation);
  }
}

describe("benchmark harness", () => {
  function seedStartingWith(suite: BenchmarkSuite, mode: "baseline" | "graphcraft"): string {
    for (let index = 0; index < 100; index += 1) {
      const seed = `start-${mode}-${index}`;
      if (
        createBenchmarkSchedule({ suite, hosts: ["codex"], seed, repetitions: 1 })[0]?.mode === mode
      )
        return seed;
    }
    throw new Error(`Could not construct a benchmark schedule starting with ${mode}`);
  }

  function interruptionSuite(
    id: string,
    options: { withoutVerifyScript?: boolean } = {},
  ): BenchmarkSuite {
    return BenchmarkSuiteSchema.parse({
      schemaVersion: 2,
      id: `${id}-suite`,
      version: 1,
      description: "Benchmark interruption fixture",
      tasks: [
        {
          id: `${id}-task`,
          family: "feature",
          task: "Set the exported value to implemented and verify it",
          initialFiles: {
            "package.json": `${JSON.stringify(
              options.withoutVerifyScript ? {} : { scripts: { verify: "node verify.mjs" } },
            )}\n`,
            "source.js": "export const value = 'pending';\n",
            "verify.mjs":
              "import { value } from './source.js'; if (value !== 'implemented') process.exit(1);\n",
            "score.mjs":
              "import { value } from './source.js'; if (value !== 'implemented') process.exit(1);\n",
          },
          checks: [{ command: "node", scorerPath: "score.mjs" }],
          acceptance: [{ kind: "contains", path: "source.js", value: "implemented" }],
          repetitions: 1,
        },
      ],
    });
  }

  function emptyRunningReport(input: {
    schemaVersion: 3 | 4;
    suite: BenchmarkSuite;
    seed: string;
    model: string;
    effort?: "low" | "medium" | "high" | "xhigh";
    graphcraftVersion: string;
  }) {
    const identity =
      input.schemaVersion === 4
        ? {
            schemaVersion: 4 as const,
            hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
          }
        : {
            schemaVersion: 3 as const,
            hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
          };
    const schedule = createBenchmarkSchedule({
      suite: input.suite,
      hosts: ["codex"],
      seed: input.seed,
      repetitions: 1,
      identity,
    });
    const common = {
      status: "running" as const,
      suite: {
        id: input.suite.id,
        version: input.suite.version,
        digest: contentHash(input.suite, identity.hashAlgorithm),
      },
      startedAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      seed: input.seed,
      randomized: true as const,
      modelPolicy: { codex: input.model },
      effortPolicy: input.effort ?? "low",
      permissionPolicy: {
        codex: "codex_workspace_write_shell_external_not_graphcraft_enforced" as const,
      },
      scorerPolicy: "fixture_bound_scorers_plus_suite_assertions" as const,
      modelCallTimeoutMs: DEFAULT_BENCHMARK_MODEL_CALL_TIMEOUT_MS,
      environment: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        graphcraftVersion: input.graphcraftVersion,
        graphcraftSource: cleanBenchmarkSource,
      },
      limitations: [...BENCHMARK_REPORT_LIMITATIONS],
      schedule,
      results: [],
      summary: summarizeBenchmark([], schedule, identity),
    };
    return input.schemaVersion === 4
      ? BenchmarkReportV4Schema.parse({
          schemaVersion: 4,
          hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
          reviewPolicy: "bounded_redacted_patch_and_transcript_v2",
          ...common,
        })
      : BenchmarkReportV3Schema.parse({
          schemaVersion: 3,
          reviewPolicy: "bounded_redacted_patch_and_transcript_v1",
          ...common,
        });
  }

  function trackPreservedFixture(recovery: {
    fixtureRepository: string;
    lastKnownRepository: string;
  }): void {
    temporaryRoots.push(
      recovery.fixtureRepository,
      join(
        dirname(recovery.fixtureRepository),
        `.${basename(recovery.fixtureRepository)}-graphcraft-worktrees`,
      ),
    );
  }

  it("rejects model-call timeouts that Node would clamp to one millisecond", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-timeout-overflow-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const adapter = new BenchmarkAdapter();

    await expect(
      runBenchmark({
        suite: interruptionSuite("timeout-overflow"),
        hosts: ["codex"],
        adapters: { codex: adapter },
        policies: { codex: { model: "timeout-overflow-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-timeout-overflow-fixture",
        seed: "timeout-overflow-seed",
        repetitions: 1,
        outputPath,
        modelCallTimeoutMs: MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS + 1,
      }),
    ).rejects.toThrow(`between 1 and ${MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS}`);
    expect(adapter.probeCalls).toBe(0);
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves stable v2 reports instead of fabricating v3 settlement controls", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-v2-refusal-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const v2Report = await readFile(
      new URL("../../../tests/fixtures/protocol/benchmark-report.v2.json", import.meta.url),
      "utf8",
    );
    await writeFile(outputPath, v2Report, "utf8");
    const adapter = new BenchmarkAdapter();

    await expect(
      runBenchmark({
        suite: interruptionSuite("v2-refusal"),
        hosts: ["codex"],
        adapters: { codex: adapter },
        policies: { codex: { model: "v2-refusal-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-v2-refusal-fixture",
        seed: "v2-refusal-seed",
        repetitions: 1,
        outputPath,
      }),
    ).rejects.toThrow(/schema version 2 predates model-call settlement evidence/i);
    expect(adapter.probeCalls).toBe(0);
    expect(await readFile(outputPath, "utf8")).toBe(v2Report);
  });

  it("creates fresh schema-v4 reports with portable identities and versioned trial IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-v4-fresh-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = interruptionSuite("v4-fresh");
    const seed = "v4-fresh-seed";
    const adapter = new BenchmarkAdapter();

    const { report } = await runBenchmark({
      suite,
      hosts: ["codex"],
      adapters: { codex: adapter },
      policies: { codex: { model: "v4-fresh-fixture", effort: "low" } },
      graphcraftVersion: "0.1.2-v4-fresh-fixture",
      seed,
      repetitions: 1,
      outputPath,
    });

    expect(report).toMatchObject({
      schemaVersion: 4,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      reviewPolicy: "bounded_redacted_patch_and_transcript_v2",
    });
    expect(report.results).toHaveLength(2);
    expect(
      report.results.every(
        ({ reviewPacket }) =>
          reviewPacket?.schemaVersion === 2 &&
          reviewPacket.hashAlgorithm === PORTABLE_CANONICAL_HASH_ALGORITHM,
      ),
    ).toBe(true);
    const legacySchedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed,
      repetitions: 1,
      identity: {
        schemaVersion: 3,
        hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
      },
    });
    expect(report.schedule.map(({ trialId: _trialId, ...entry }) => entry)).toEqual(
      legacySchedule.map(({ trialId: _trialId, ...entry }) => entry),
    );
    expect(report.schedule.map(({ trialId }) => trialId)).not.toEqual(
      legacySchedule.map(({ trialId }) => trialId),
    );
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
  });

  it("resumes a running schema-v3 report with exact legacy identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-v3-resume-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = interruptionSuite("v3-resume");
    const seed = "v3-resume-seed";
    const model = "v3-resume-fixture";
    const graphcraftVersion = "0.1.2-v3-resume-fixture";
    const running = emptyRunningReport({
      schemaVersion: 3,
      suite,
      seed,
      model,
      graphcraftVersion,
    });
    await writeFile(outputPath, `${JSON.stringify(running, null, 2)}\n`, "utf8");
    const adapter = new BenchmarkAdapter();

    const { report } = await runBenchmark({
      suite,
      hosts: ["codex"],
      adapters: { codex: adapter },
      policies: { codex: { model, effort: "low" } },
      graphcraftVersion,
      seed,
      repetitions: 1,
      outputPath,
    });

    expect(report.schemaVersion).toBe(3);
    expect(report.schedule).toEqual(running.schedule);
    expect(report.results).toHaveLength(2);
    expect(report.results.every(({ reviewPacket }) => reviewPacket?.schemaVersion === 1)).toBe(
      true,
    );
    expect(adapter.probeCalls).toBeGreaterThan(0);
  });

  it("leaves a complete schema-v3 report byte-identical on reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-v3-complete-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = interruptionSuite("v3-complete");
    const seed = "v3-complete-seed";
    const model = "v3-complete-fixture";
    const graphcraftVersion = "0.1.2-v3-complete-fixture";
    const running = emptyRunningReport({
      schemaVersion: 3,
      suite,
      seed,
      model,
      graphcraftVersion,
    });
    await writeFile(outputPath, `${JSON.stringify(running, null, 2)}\n`, "utf8");
    await runBenchmark({
      suite,
      hosts: ["codex"],
      adapters: { codex: new BenchmarkAdapter() },
      policies: { codex: { model, effort: "low" } },
      graphcraftVersion,
      seed,
      repetitions: 1,
      outputPath,
    });
    const completeBytes = await readFile(outputPath);

    const reopened = await runBenchmark({
      suite,
      hosts: ["codex"],
      adapters: {},
      policies: { codex: { model, effort: "low" } },
      graphcraftVersion,
      seed,
      repetitions: 1,
      outputPath,
    });

    expect(reopened.report.schemaVersion).toBe(3);
    expect(await readFile(outputPath)).toEqual(completeBytes);
  });

  it.each([
    { name: "legacy v3 identities relabelled as portable v4", from: 3 as const },
    { name: "portable v4 identities relabelled as legacy v3", from: 4 as const },
  ])("rejects $name before any adapter call", async ({ from }) => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-relabel-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = interruptionSuite(`relabel-${from}`);
    const seed = `relabel-${from}-seed`;
    const model = `relabel-${from}-fixture`;
    const graphcraftVersion = `0.1.2-relabel-${from}-fixture`;
    const original = emptyRunningReport({
      schemaVersion: from,
      suite,
      seed,
      model,
      graphcraftVersion,
    });
    const relabelled =
      from === 3
        ? {
            ...original,
            schemaVersion: 4,
            hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
            reviewPolicy: "bounded_redacted_patch_and_transcript_v2",
          }
        : Object.fromEntries(
            Object.entries({
              ...original,
              schemaVersion: 3,
              reviewPolicy: "bounded_redacted_patch_and_transcript_v1",
            }).filter(([key]) => key !== "hashAlgorithm"),
          );
    const originalBytes = `${JSON.stringify(relabelled, null, 2)}\n`;
    await writeFile(outputPath, originalBytes, "utf8");
    const adapter = new BenchmarkAdapter();

    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: adapter },
        policies: { codex: { model, effort: "low" } },
        graphcraftVersion,
        seed,
        repetitions: 1,
        outputPath,
      }),
    ).rejects.toThrow(/trial ID does not match|does not match this suite and schedule/);
    expect(adapter.probeCalls).toBe(0);
    expect(adapter.planCalls).toBe(0);
    expect(adapter.workerRequests).toHaveLength(0);
    expect(adapter.verifyCalls).toBe(0);
    expect(await readFile(outputPath, "utf8")).toBe(originalBytes);
  });

  it("persists an abort-ignoring host preflight and refuses every probe on resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-unsettled-preflight-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = interruptionSuite("unsettled-preflight");
    const adapter = new BenchmarkAdapter({ ignoreProbeAbort: true });

    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: adapter },
        policies: { codex: { model: "unsettled-preflight-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-unsettled-preflight-fixture",
        seed: "unsettled-preflight-seed",
        repetitions: 1,
        outputPath,
        modelCallTimeoutMs: 25,
      }),
    ).rejects.toThrow(/capability probe exceeded/i);

    expect(adapter.probeCalls).toBe(1);
    expect(adapter.activeProbeCalls).toBe(1);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      schemaVersion: 4,
      status: "running",
      hostPreflightCheckpoint: {
        host: "codex",
        phase: "capability_probe",
        attemptCheckpoint: "settled",
        interruption: { cause: "timeout", childSettlement: "unconfirmed" },
        requiredAction: "reconcile_host_child_before_resume",
      },
      results: [],
    });

    const resumedAdapter = new BenchmarkAdapter();
    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: resumedAdapter },
        policies: { codex: { model: "unsettled-preflight-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-unsettled-preflight-fixture",
        seed: "unsettled-preflight-seed",
        repetitions: 1,
        outputPath,
        modelCallTimeoutMs: 25,
      }),
    ).rejects.toThrow(/host capability probe may still be active/i);
    expect(resumedAdapter.probeCalls).toBe(0);
    expect(resumedAdapter.planCalls).toBe(0);
    expect(resumedAdapter.workerRequests).toHaveLength(0);
    expect(resumedAdapter.verifyCalls).toBe(0);
  }, 30_000);

  it("checkpoints an abort-ignoring per-trial probe before launch and blocks resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-unsettled-trial-probe-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = interruptionSuite("unsettled-trial-probe");
    const adapter = new BenchmarkAdapter({ ignoreProbeAbortOnCall: 2 });

    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: adapter },
        policies: { codex: { model: "unsettled-trial-probe-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-unsettled-trial-probe-fixture",
        seed: "unsettled-trial-probe-seed",
        repetitions: 1,
        outputPath,
        modelCallTimeoutMs: 25,
      }),
    ).rejects.toThrow(/capability probe exceeded/i);

    const checkpoint = JSON.parse(await readFile(outputPath, "utf8"));
    expect(checkpoint.hostPreflightCheckpoint).toBeUndefined();
    expect(checkpoint).toMatchObject({
      schemaVersion: 4,
      status: "running",
      results: [
        {
          hostVersion: "pending-capability-probe",
          executionStatus: "timed_out",
          attemptCheckpoint: "settled",
          interruption: { cause: "timeout", childSettlement: "unconfirmed" },
          recovery: {
            disposition: "preserved",
            requiredAction: "reconcile_child_before_cleanup_or_resume",
          },
          accepted: false,
        },
      ],
    });
    expect(checkpoint.results).toHaveLength(1);
    const recovery = checkpoint.results[0].recovery as {
      fixtureRepository: string;
      lastKnownRepository: string;
    };
    trackPreservedFixture(recovery);
    expect(adapter.probeCalls).toBe(2);
    expect(adapter.activeProbeCalls).toBe(1);
    await expect(access(recovery.fixtureRepository)).resolves.toBeUndefined();

    const resumedAdapter = new BenchmarkAdapter();
    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: resumedAdapter },
        policies: { codex: { model: "unsettled-trial-probe-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-unsettled-trial-probe-fixture",
        seed: "unsettled-trial-probe-seed",
        repetitions: 1,
        outputPath,
        modelCallTimeoutMs: 25,
      }),
    ).rejects.toThrow(/model-call settlement is unconfirmed/i);
    expect(resumedAdapter.probeCalls).toBe(0);
    expect(resumedAdapter.planCalls).toBe(0);
    expect(resumedAdapter.workerRequests).toHaveLength(0);
    expect(resumedAdapter.verifyCalls).toBe(0);
  }, 30_000);

  it("times out each model call and retains settled unsuccessful trial evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-call-timeout-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = interruptionSuite("call-timeout");
    const adapter = new BenchmarkAdapter({ waitForWorkerAbort: true });

    const { report } = await runBenchmark({
      suite,
      hosts: ["codex"],
      adapters: { codex: adapter },
      policies: { codex: { model: "timeout-fixture", effort: "low" } },
      graphcraftVersion: "0.1.2-timeout-fixture",
      seed: "timeout-seed",
      repetitions: 1,
      outputPath,
      modelCallTimeoutMs: 25,
    });

    expect(report).toMatchObject({ status: "complete", modelCallTimeoutMs: 25 });
    expect(report.results).toHaveLength(2);
    expect(
      report.results.map(({ executionStatus, attemptCheckpoint, interruption, accepted }) => ({
        executionStatus,
        attemptCheckpoint,
        interruption,
        accepted,
      })),
    ).toEqual([
      expect.objectContaining({
        executionStatus: "timed_out",
        attemptCheckpoint: "settled",
        interruption: expect.objectContaining({ cause: "timeout", childSettlement: "confirmed" }),
        accepted: false,
      }),
      expect.objectContaining({
        executionStatus: "timed_out",
        attemptCheckpoint: "settled",
        interruption: expect.objectContaining({ cause: "timeout", childSettlement: "confirmed" }),
        accepted: false,
      }),
    ]);
    expect(report.summary.codex).toMatchObject({ gate: { comparable: false, passes: null } });
  });

  it("persists confirmed settlement before removing the trial fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-settlement-order-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = interruptionSuite("settlement-order");
    const seed = seedStartingWith(suite, "baseline");
    let fixtureRepository: string | undefined;
    let observedSettledCheckpoint = false;

    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: new BenchmarkAdapter() },
        policies: { codex: { model: "settlement-order-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-settlement-order-fixture",
        seed,
        repetitions: 1,
        outputPath,
        modelCallTimeoutMs: 5_000,
        trialBoundary: async (point) => {
          const checkpoint = JSON.parse(await readFile(outputPath, "utf8"));
          if (point === "after_provisional_persist") {
            expect(checkpoint.results[0]).toMatchObject({
              attemptCheckpoint: "provisional",
              interruption: { childSettlement: "unconfirmed" },
            });
            const recovery = checkpoint.results[0].recovery as {
              fixtureRepository: string;
              lastKnownRepository: string;
            };
            trackPreservedFixture(recovery);
            fixtureRepository = recovery.fixtureRepository;
            return;
          }

          expect(fixtureRepository).toBeDefined();
          expect(checkpoint).toMatchObject({
            status: "running",
            results: [
              {
                trial: { mode: "baseline" },
                executionStatus: "completed",
                attemptCheckpoint: "settled",
                accepted: true,
              },
            ],
          });
          await expect(access(fixtureRepository!)).resolves.toBeUndefined();
          observedSettledCheckpoint = true;
          throw new Error("simulated process loss after settled persistence");
        },
      }),
    ).rejects.toThrow("simulated process loss after settled persistence");

    expect(observedSettledCheckpoint).toBe(true);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      status: "running",
      results: [{ executionStatus: "completed", attemptCheckpoint: "settled" }],
    });
    await expect(access(fixtureRepository!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["baseline", "graphcraft"] as const)(
    "preserves an abort-ignoring %s child and blocks every later or resumed call",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), `graphcraft-benchmark-unsettled-${mode}-`));
      temporaryRoots.push(root);
      const outputPath = join(root, "report.json");
      const suite = interruptionSuite(`unsettled-${mode}`);
      const seed = seedStartingWith(suite, mode);
      const adapter = new BenchmarkAdapter({ ignoreWorkerAbort: true });

      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: { codex: adapter },
          policies: { codex: { model: "unsettled-fixture", effort: "low" } },
          graphcraftVersion: "0.1.2-unsettled-fixture",
          seed,
          repetitions: 1,
          outputPath,
          modelCallTimeoutMs: 25,
        }),
      ).rejects.toThrow(/model-call settlement was not confirmed/i);

      const checkpoint = JSON.parse(await readFile(outputPath, "utf8"));
      expect(checkpoint).toMatchObject({
        schemaVersion: 4,
        status: "running",
        results: [
          {
            trial: { mode },
            executionStatus: "timed_out",
            attemptCheckpoint: "settled",
            interruption: { cause: "timeout", childSettlement: "unconfirmed" },
            recovery: {
              disposition: "preserved",
              requiredAction: "reconcile_child_before_cleanup_or_resume",
            },
            accepted: false,
          },
        ],
      });
      expect(checkpoint.results).toHaveLength(1);
      const recovery = checkpoint.results[0].recovery as {
        fixtureRepository: string;
        lastKnownRepository: string;
      };
      trackPreservedFixture(recovery);
      expect(adapter.workerRequests).toHaveLength(1);
      expect(adapter.workerRequests[0]!.repositoryPath).toBe(recovery.lastKnownRepository);
      expect(adapter.activeWorkerRepositories.has(recovery.lastKnownRepository)).toBe(true);
      await expect(access(recovery.fixtureRepository)).resolves.toBeUndefined();
      await expect(access(recovery.lastKnownRepository)).resolves.toBeUndefined();

      const resumedAdapter = new BenchmarkAdapter();
      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: { codex: resumedAdapter },
          policies: { codex: { model: "unsettled-fixture", effort: "low" } },
          graphcraftVersion: "0.1.2-unsettled-fixture",
          seed,
          repetitions: 1,
          outputPath,
          modelCallTimeoutMs: 25,
        }),
      ).rejects.toThrow(/model-call settlement is unconfirmed/i);
      expect(resumedAdapter.probeCalls).toBe(0);
      expect(resumedAdapter.planCalls).toBe(0);
      expect(resumedAdapter.workerRequests).toHaveLength(0);
      expect(resumedAdapter.verifyCalls).toBe(0);
    },
    30_000,
  );

  it("preserves an abort-ignoring Graphcraft planner and blocks every later or resumed call", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-unsettled-planner-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = interruptionSuite("unsettled-planner");
    const seed = seedStartingWith(suite, "graphcraft");
    const adapter = new BenchmarkAdapter({ ignorePlanAbort: true });

    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: adapter },
        policies: { codex: { model: "unsettled-planner-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-unsettled-planner-fixture",
        seed,
        repetitions: 1,
        outputPath,
        modelCallTimeoutMs: 25,
      }),
    ).rejects.toThrow(/model-call settlement was not confirmed/i);

    const checkpoint = JSON.parse(await readFile(outputPath, "utf8"));
    expect(checkpoint).toMatchObject({
      schemaVersion: 4,
      status: "running",
      results: [
        {
          trial: { mode: "graphcraft" },
          executionStatus: "timed_out",
          attemptCheckpoint: "settled",
          interruption: { cause: "timeout", childSettlement: "unconfirmed" },
          recovery: { disposition: "preserved" },
          accepted: false,
        },
      ],
    });
    expect(checkpoint.results).toHaveLength(1);
    const recovery = checkpoint.results[0].recovery as {
      fixtureRepository: string;
      lastKnownRepository: string;
    };
    trackPreservedFixture(recovery);
    expect(adapter.planCalls).toBe(1);
    expect(adapter.workerRequests).toHaveLength(0);
    const activePlannerRepositories = [...adapter.activePlannerRepositories];
    expect(activePlannerRepositories).toHaveLength(1);
    expect(await canonicalPathIdentity(activePlannerRepositories[0]!)).toBe(
      await canonicalPathIdentity(recovery.lastKnownRepository),
    );
    await expect(access(recovery.fixtureRepository)).resolves.toBeUndefined();
    await expect(access(recovery.lastKnownRepository)).resolves.toBeUndefined();

    const resumedAdapter = new BenchmarkAdapter();
    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: resumedAdapter },
        policies: { codex: { model: "unsettled-planner-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-unsettled-planner-fixture",
        seed,
        repetitions: 1,
        outputPath,
        modelCallTimeoutMs: 25,
      }),
    ).rejects.toThrow(/model-call settlement is unconfirmed/i);
    expect(resumedAdapter.probeCalls).toBe(0);
    expect(resumedAdapter.planCalls).toBe(0);
    expect(resumedAdapter.workerRequests).toHaveLength(0);
    expect(resumedAdapter.verifyCalls).toBe(0);
  }, 30_000);

  it("preserves an abort-ignoring Graphcraft verifier and blocks every later or resumed call", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-unsettled-verifier-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = interruptionSuite("unsettled-verifier", { withoutVerifyScript: true });
    const seed = seedStartingWith(suite, "graphcraft");
    const adapter = new BenchmarkAdapter({
      ignoreVerifyAbort: true,
    });

    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: adapter },
        policies: { codex: { model: "unsettled-verifier-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-unsettled-verifier-fixture",
        seed,
        repetitions: 1,
        outputPath,
        modelCallTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/model-call settlement was not confirmed/i);

    const checkpoint = JSON.parse(await readFile(outputPath, "utf8"));
    expect(checkpoint).toMatchObject({
      schemaVersion: 4,
      status: "running",
      results: [
        {
          trial: { mode: "graphcraft" },
          executionStatus: "timed_out",
          attemptCheckpoint: "settled",
          interruption: { cause: "timeout", childSettlement: "unconfirmed" },
          recovery: { disposition: "preserved" },
          accepted: false,
        },
      ],
    });
    expect(checkpoint.results).toHaveLength(1);
    const recovery = checkpoint.results[0].recovery as {
      fixtureRepository: string;
      lastKnownRepository: string;
    };
    trackPreservedFixture(recovery);
    expect(adapter.planCalls).toBe(1);
    expect(adapter.workerRequests).toHaveLength(1);
    expect(adapter.verifyCalls).toBe(1);
    expect(adapter.activeVerifierRepositories.has(recovery.lastKnownRepository)).toBe(true);
    await expect(access(recovery.fixtureRepository)).resolves.toBeUndefined();
    await expect(access(recovery.lastKnownRepository)).resolves.toBeUndefined();

    const resumedAdapter = new BenchmarkAdapter();
    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: resumedAdapter },
        policies: { codex: { model: "unsettled-verifier-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-unsettled-verifier-fixture",
        seed,
        repetitions: 1,
        outputPath,
        modelCallTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/model-call settlement is unconfirmed/i);
    expect(resumedAdapter.probeCalls).toBe(0);
    expect(resumedAdapter.planCalls).toBe(0);
    expect(resumedAdapter.workerRequests).toHaveLength(0);
    expect(resumedAdapter.verifyCalls).toBe(0);
  }, 30_000);

  it("checkpoints an externally interrupted trial and resumes without replaying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-signal-resume-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = interruptionSuite("signal-resume");
    const cancellation = new AbortController();
    const interruptedAdapter = new BenchmarkAdapter({
      waitForWorkerAbort: true,
      onWorkerStarted: () =>
        cancellation.abort({ cause: "cancellation", reason: "test-requested interruption" }),
    });
    const seed = seedStartingWith(suite, "baseline");

    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: interruptedAdapter },
        policies: { codex: { model: "signal-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-signal-fixture",
        seed,
        repetitions: 1,
        outputPath,
        signal: cancellation.signal,
        modelCallTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/interrupted trial was checkpointed/i);

    const checkpoint = JSON.parse(await readFile(outputPath, "utf8"));
    expect(checkpoint).toMatchObject({
      status: "running",
      modelCallTimeoutMs: 5_000,
      results: [
        {
          trial: { mode: "baseline" },
          executionStatus: "interrupted",
          attemptCheckpoint: "settled",
          interruption: { cause: "cancellation", childSettlement: "confirmed" },
          accepted: false,
        },
      ],
    });

    const resumedAdapter = new BenchmarkAdapter();
    const resumed = await runBenchmark({
      suite,
      hosts: ["codex"],
      adapters: { codex: resumedAdapter },
      policies: { codex: { model: "signal-fixture", effort: "low" } },
      graphcraftVersion: "0.1.2-signal-fixture",
      seed,
      repetitions: 1,
      outputPath,
      modelCallTimeoutMs: 5_000,
    });
    expect(resumed.report.status).toBe("complete");
    expect(resumed.report.results).toHaveLength(2);
    expect(resumedAdapter.workerRequests).toHaveLength(1);
    expect(resumed.report.results.find(({ trial }) => trial.mode === "baseline")).toMatchObject({
      executionStatus: "interrupted",
      accepted: false,
    });
  });

  it("recovers a provisional checkpoint and refuses to risk replaying an unknown child", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-provisional-resume-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = interruptionSuite("provisional-resume");
    const seed = seedStartingWith(suite, "baseline");

    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: new BenchmarkAdapter() },
        policies: { codex: { model: "provisional-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-provisional-fixture",
        seed,
        repetitions: 1,
        outputPath,
        modelCallTimeoutMs: 5_000,
        trialBoundary: (point) => {
          if (point === "after_provisional_persist") throw new Error("simulated process loss");
        },
      }),
    ).rejects.toThrow("simulated process loss");
    const provisional = JSON.parse(await readFile(outputPath, "utf8"));
    expect(provisional).toMatchObject({
      schemaVersion: 4,
      status: "running",
      results: [
        {
          attemptCheckpoint: "provisional",
          interruption: { childSettlement: "unconfirmed" },
          recovery: {
            disposition: "preserved",
            requiredAction: "reconcile_child_before_cleanup_or_resume",
          },
          accepted: false,
        },
      ],
    });
    const recovery = provisional.results[0].recovery as {
      fixtureRepository: string;
      lastKnownRepository: string;
    };
    trackPreservedFixture(recovery);
    await expect(access(recovery.fixtureRepository)).resolves.toBeUndefined();

    const resumedAdapter = new BenchmarkAdapter();
    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: resumedAdapter },
        policies: { codex: { model: "provisional-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-provisional-fixture",
        seed,
        repetitions: 1,
        outputPath,
        modelCallTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/model-call settlement is unconfirmed/i);

    expect(resumedAdapter.probeCalls).toBe(0);
    expect(resumedAdapter.planCalls).toBe(0);
    expect(resumedAdapter.workerRequests).toHaveLength(0);
    expect(resumedAdapter.verifyCalls).toBe(0);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      status: "running",
      results: [
        {
          executionStatus: "interrupted",
          attemptCheckpoint: "settled",
          interruption: { cause: "runtime_shutdown", childSettlement: "unconfirmed" },
          recovery,
          accepted: false,
          usageReconciled: false,
        },
      ],
    });
  });

  it("binds source provenance to the exact commit and fails evidence closed when dirty", async () => {
    const repository = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-source-identity-"));
    temporaryRoots.push(repository);
    await writeFile(join(repository, "source.js"), "export const value = 1;\n", "utf8");
    expect((await runProcess("git", ["init", "-b", "main"], { cwd: repository })).exitCode).toBe(0);
    expect((await runProcess("git", ["add", "."], { cwd: repository })).exitCode).toBe(0);
    expect(
      (
        await runProcess(
          "git",
          [
            "-c",
            "commit.gpgSign=false",
            "-c",
            "user.name=Graphcraft Benchmark",
            "-c",
            "user.email=benchmark@graphcraft.local",
            "commit",
            "-m",
            "source identity fixture",
          ],
          { cwd: repository },
        )
      ).exitCode,
    ).toBe(0);

    const clean = await inspectBenchmarkSourceIdentity(repository);
    expect(clean).toMatchObject({ dirty: false, dirtyStatusDigest: null });
    expect(clean.commitSha).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(repository, "untracked.txt"), "dirty\n", "utf8");
    const dirty = await inspectBenchmarkSourceIdentity(repository);
    expect(dirty).toMatchObject({ commitSha: clean.commitSha, dirty: true });
    expect(dirty.dirtyStatusDigest).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      runBenchmarkRuntime({
        suite: BenchmarkSuiteSchema.parse({
          schemaVersion: 2,
          id: "dirty-source-suite",
          version: 1,
          description: "Dirty source rejection fixture",
          tasks: [
            {
              id: "dirty-source-task",
              family: "feature",
              task: "Reject a dirty Graphcraft source identity",
              initialFiles: { "score.mjs": "process.exit(0);\n" },
              checks: [{ command: "node", scorerPath: "score.mjs" }],
              acceptance: [{ kind: "exists", path: "score.mjs" }],
              repetitions: 1,
            },
          ],
        }),
        hosts: ["codex"],
        adapters: {},
        policies: { codex: { model: "dirty-source-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-dirty-source-fixture",
        graphcraftSource: dirty,
        seed: "dirty-source-seed",
        repetitions: 1,
        outputPath: join(repository, "report.json"),
      }),
    ).rejects.toThrow("require a clean Graphcraft source tree");
    await expect(access(join(repository, "report.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(REQUIRED_HOST_PROTOCOL_CAPABILITIES)(
    "rejects benchmark admission before fixture creation and clears preflight when %s is unavailable",
    async (capability) => {
      const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-admission-"));
      temporaryRoots.push(root);
      const outputPath = join(root, "report.json");
      const adapter = new BenchmarkAdapter({ capabilities: { [capability]: false } });
      const suite = BenchmarkSuiteSchema.parse({
        schemaVersion: 2,
        id: "admission-suite",
        version: 1,
        description: "Host capability admission fixture",
        tasks: [
          {
            id: "admission-task",
            family: "feature",
            task: "Exercise benchmark host admission",
            initialFiles: {
              "source.js": "export const value = 'pending';\n",
              "score.mjs": "process.exit(0);\n",
            },
            checks: [{ command: "node", scorerPath: "score.mjs", args: ["--version"] }],
            acceptance: [{ kind: "exists", path: "source.js" }],
            repetitions: 1,
          },
        ],
      });

      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: { codex: adapter },
          policies: { codex: { model: "admission-fixture", effort: "low" } },
          graphcraftVersion: "0.1.2-admission-fixture",
          seed: "admission-seed",
          repetitions: 1,
          outputPath,
        }),
      ).rejects.toThrow(capability);
      expect(adapter.graphcraftRepositories).toEqual([]);
      const checkpoint = JSON.parse(await readFile(outputPath, "utf8"));
      expect(checkpoint).toMatchObject({ status: "running", results: [] });
      expect(checkpoint.hostPreflightCheckpoint).toBeUndefined();
    },
  );

  it("pins deterministic LF fixtures when Git inherits core.autocrlf=true", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-autocrlf-"));
    temporaryRoots.push(root);
    const globalConfigPath = join(root, "gitconfig");
    await writeFile(globalConfigPath, "[core]\n\tautocrlf = true\n", "utf8");
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
    try {
      const inherited = await runProcess("git", ["config", "--global", "--get", "core.autocrlf"], {
        cwd: root,
      });
      expect(inherited).toMatchObject({ exitCode: 0 });
      expect(inherited.stdout.trim()).toBe("true");
      const suite = BenchmarkSuiteSchema.parse({
        schemaVersion: 2,
        id: "autocrlf-suite",
        version: 1,
        description: "Deterministic line-ending fixture",
        tasks: [
          {
            id: "autocrlf-task",
            family: "feature",
            task: "Exercise deterministic benchmark line endings",
            initialFiles: {
              "package.json":
                '{"name":"autocrlf-fixture","private":true,"type":"module","scripts":{"test":"node verify.mjs"}}\n',
              "source.js": "export const value = 'pending';\n",
              "verify.mjs":
                "import { value } from './source.js'; if (value !== 'implemented') process.exit(1);\n",
              "score.mjs":
                "import { value } from './source.js'; if (value !== 'implemented') process.exit(1);\n",
            },
            checks: [{ command: "node", scorerPath: "score.mjs" }],
            acceptance: [{ kind: "contains", path: "source.js", value: "implemented" }],
            repetitions: 1,
          },
        ],
      });
      const adapter = new BenchmarkAdapter({ expectDeterministicLfFixture: true });

      const { report } = await runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: adapter },
        policies: { codex: { model: "autocrlf-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-autocrlf-fixture",
        seed: "autocrlf-seed",
        repetitions: 1,
        outputPath: join(root, "report.json"),
      });

      expect(report.results).toHaveLength(2);
      expect(
        report.results.every(({ accepted }) => accepted),
        JSON.stringify(
          report.results.map(({ trial, executionStatus, accepted, acceptance, failureTrace }) => ({
            mode: trial.mode,
            executionStatus,
            accepted,
            acceptance,
            failureTrace,
          })),
        ),
      ).toBe(true);
      expect(adapter.workerRequests).toHaveLength(2);
    } finally {
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    }
  });

  it.each([
    ["authentication loss", "not authenticated"],
    ["unsupported protocol", "no matching recorded protocol profile"],
  ] as const)(
    "revalidates each benchmark trial after %s without persisting a stale host version",
    async (transition, expectedError) => {
      const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-revalidation-"));
      temporaryRoots.push(root);
      const outputPath = join(root, "report.json");
      const ready = hostCapabilitiesFromProtocolProfile("codex", {
        installed: true,
        authenticated: true,
        version: "codex-cli 0.144.6",
      });
      const unavailable =
        transition === "authentication loss"
          ? { ...ready, authenticated: false }
          : hostCapabilitiesFromProtocolProfile("codex", {
              installed: true,
              authenticated: true,
              version: "codex-cli 0.145.0",
            });
      const adapter = new BenchmarkAdapter({ capabilitySequence: [ready, unavailable] });
      const suite = BenchmarkSuiteSchema.parse({
        schemaVersion: 2,
        id: "revalidation-suite",
        version: 1,
        description: "Per-trial host capability revalidation fixture",
        tasks: [
          {
            id: "revalidation-task",
            family: "feature",
            task: "Exercise per-trial host admission",
            initialFiles: {
              "source.js": "export const value = 'pending';\n",
              "score.mjs": "process.exit(0);\n",
            },
            checks: [{ command: "node", scorerPath: "score.mjs" }],
            acceptance: [{ kind: "exists", path: "source.js" }],
            repetitions: 1,
          },
        ],
      });

      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: { codex: adapter },
          policies: { codex: { model: "revalidation-fixture", effort: "low" } },
          graphcraftVersion: "0.1.2-revalidation-fixture",
          seed: "revalidation-seed",
          repetitions: 1,
          outputPath,
        }),
      ).rejects.toThrow(expectedError);

      expect(adapter.probeCalls).toBe(2);
      expect(adapter.workerRequests).toEqual([]);
      expect(adapter.graphcraftRepositories).toEqual([]);
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
        status: "running",
        results: [],
      });
    },
  );

  it("rejects post-trial host identity drift before persisting the completed trial", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-post-trial-drift-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const ready = hostCapabilitiesFromProtocolProfile("codex", {
      installed: true,
      authenticated: true,
      version: "codex-cli 0.144.6",
    });
    const adapter = new BenchmarkAdapter({
      capabilitySequence: [
        ready,
        ready,
        { ...ready, version: "codex-cli 0.145.0", protocolProfile: "codex-cli@0.145.0" },
      ],
    });
    const suite = BenchmarkSuiteSchema.parse({
      schemaVersion: 2,
      id: "post-trial-drift-suite",
      version: 1,
      description: "Post-trial host identity drift fixture",
      tasks: [
        {
          id: "post-trial-drift-task",
          family: "feature",
          task: "Exercise post-trial benchmark host identity validation",
          initialFiles: {
            "source.js": "export const value = 'pending';\n",
            "score.mjs": "process.exit(0);\n",
          },
          checks: [{ command: "node", scorerPath: "score.mjs" }],
          acceptance: [{ kind: "exists", path: "source.js" }],
          repetitions: 1,
        },
      ],
    });

    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: adapter },
        policies: { codex: { model: "post-trial-drift-fixture", effort: "low" } },
        graphcraftVersion: "0.1.2-post-trial-drift-fixture",
        seed: seedStartingWith(suite, "baseline"),
        repetitions: 1,
        outputPath,
      }),
    ).rejects.toThrow("no matching recorded protocol profile");

    expect(adapter.probeCalls).toBe(3);
    expect(adapter.workerRequests).toHaveLength(1);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      status: "running",
      results: [
        {
          hostVersion: "codex-cli 0.144.6",
          executionStatus: "error",
          attemptCheckpoint: "settled",
          accepted: false,
          failureTrace: expect.arrayContaining([
            expect.stringMatching(/no matching recorded protocol profile/),
          ]),
        },
      ],
    });
  });

  it.each([
    ["baseline", "worker", "authentication loss"],
    ["graphcraft", "planner", "unsupported protocol"],
    ["graphcraft", "worker", "authentication loss"],
  ] as const)(
    "does not persist a stale host version when %s %s revalidation catches %s",
    async (mode, stage, transition) => {
      const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-late-admission-"));
      temporaryRoots.push(root);
      const outputPath = join(root, "report.json");
      const ready = hostCapabilitiesFromProtocolProfile("codex", {
        installed: true,
        authenticated: true,
        version: "codex-cli 0.144.6",
      });
      const unavailable =
        transition === "authentication loss"
          ? { ...ready, authenticated: false }
          : hostCapabilitiesFromProtocolProfile("codex", {
              installed: true,
              authenticated: true,
              version: "codex-cli 0.145.0",
            });
      const capabilitySequence = Array.from(
        {
          length: mode === "baseline" ? 2 : stage === "planner" ? 3 : 5,
        },
        () => ready,
      ).concat(unavailable);
      const adapter = new BenchmarkAdapter({
        capabilitySequence,
        revalidatePlan: stage === "planner",
        revalidateExecute: stage === "worker",
      });
      const suite = BenchmarkSuiteSchema.parse({
        schemaVersion: 2,
        id: `late-${mode}-admission-suite`,
        version: 1,
        description: "Invocation-level benchmark host admission fixture",
        tasks: [
          {
            id: `late-${mode}-admission-task`,
            family: "feature",
            task: "Exercise invocation-level benchmark host admission",
            initialFiles: {
              "package.json": `${JSON.stringify({ scripts: { verify: "node verify.mjs" } })}\n`,
              "source.js": "export const value = 'pending';\n",
              "score.mjs": "process.exit(0);\n",
              "verify.mjs": "process.exit(0);\n",
            },
            checks: [{ command: "node", scorerPath: "score.mjs" }],
            acceptance: [{ kind: "exists", path: "source.js" }],
            repetitions: 1,
          },
        ],
      });
      const seed = seedStartingWith(suite, mode);

      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: { codex: adapter },
          policies: { codex: { model: "late-admission-fixture", effort: "low" } },
          graphcraftVersion: "0.1.2-late-admission-fixture",
          seed,
          repetitions: 1,
          outputPath,
        }),
      ).rejects.toThrow(
        transition === "authentication loss"
          ? "not authenticated"
          : "no matching recorded protocol profile",
      );

      expect(adapter.probeCalls).toBe(mode === "baseline" ? 3 : stage === "planner" ? 4 : 6);
      expect(adapter.workerRequests).toEqual([]);
      expect(adapter.graphcraftRepositories).toHaveLength(
        mode === "graphcraft" && stage === "worker" ? 1 : 0,
      );
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
        status: "running",
        results: [
          {
            hostVersion: "codex-cli 0.144.6",
            executionStatus: "error",
            attemptCheckpoint: "settled",
            accepted: false,
            failureTrace: expect.arrayContaining([
              expect.stringMatching(
                transition === "authentication loss"
                  ? /not authenticated/
                  : /no matching recorded protocol profile/,
              ),
            ]),
          },
        ],
      });
    },
  );

  it("removes a temporary fixture when materialization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-cleanup-report-"));
    temporaryRoots.push(root);
    const taskId = "materialization-cleanup";
    const fixturePrefix = `graphcraft-benchmark-${taskId}-`;
    const before = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith(fixturePrefix)),
    );
    const suite = BenchmarkSuiteSchema.parse({
      schemaVersion: 2,
      id: "materialization-cleanup-suite",
      version: 1,
      description: "Fixture setup cleanup regression",
      tasks: [
        {
          id: taskId,
          family: "feature",
          task: "Exercise benchmark fixture setup cleanup",
          initialFiles: {
            collision: "regular file\n",
            "collision/nested.js": "export const nested = true;\n",
            "score.mjs": "process.exit(0);\n",
          },
          checks: [{ command: "node", scorerPath: "score.mjs" }],
          acceptance: [{ kind: "exists", path: "collision" }],
          repetitions: 1,
        },
      ],
    });
    let leaked: string[] = [];
    try {
      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: { codex: new BenchmarkAdapter() },
          policies: { codex: { model: "cleanup-fixture", effort: "high" } },
          graphcraftVersion: "0.1.2-cleanup-fixture",
          seed: "cleanup-seed",
          repetitions: 1,
          outputPath: join(root, "report.json"),
        }),
      ).rejects.toThrow();
    } finally {
      leaked = (await readdir(tmpdir())).filter(
        (name) => name.startsWith(fixturePrefix) && !before.has(name),
      );
      await Promise.all(
        leaked.map((name) => rm(join(tmpdir(), name), { recursive: true, force: true })),
      );
    }
    expect(leaked).toEqual([]);
  });

  it(
    "runs matched fresh fixtures and persists baseline plus Graphcraft receipts",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-report-"));
      temporaryRoots.push(root);
      const outputPath = join(root, "report.json");
      const suite = BenchmarkSuiteSchema.parse({
        schemaVersion: 2,
        id: "runtime-fixture",
        version: 1,
        description: "Runtime benchmark fixture",
        tasks: [
          {
            id: "feature-result",
            family: "feature",
            task: "Implement a substantial result feature and run the declared checks",
            initialFiles: {
              "package.json":
                '{"name":"benchmark-runtime-fixture","private":true,"type":"module","scripts":{"test":"node verify.mjs"}}\n',
              "source.js": "export const value = 'pending';\n",
              "verify.mjs":
                "import { value } from './source.js'; if (value !== 'implemented') process.exit(1);\n",
              "score.mjs":
                "import { value } from './source.js'; if (value !== 'implemented') process.exit(1);\n",
            },
            checks: [{ command: "node", scorerPath: "score.mjs" }],
            acceptance: [{ kind: "contains", path: "source.js", value: "implemented" }],
            repetitions: 1,
          },
        ],
      });
      const adapter = new BenchmarkAdapter();
      const policies = { codex: { model: "gpt-benchmark-fixture", effort: "high" as const } };
      const graphcraftVersion = "0.1.2-benchmark-fixture";

      const { report } = await runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: adapter },
        policies,
        graphcraftVersion,
        seed: "runtime-seed",
        repetitions: 1,
        outputPath,
      });
      const persisted = JSON.parse(await readFile(outputPath, "utf8")) as typeof report;
      const results = persisted.results as Array<Record<string, unknown>>;

      expect(results).toHaveLength(2);
      expect(results.every(({ accepted }) => accepted === true)).toBe(true);
      expect(new Set(results.map(({ repositoryDigest }) => repositoryDigest)).size).toBe(1);
      expect(new Set(results.map(({ baseSha }) => baseSha)).size).toBe(1);
      expect(results.every(({ usageReconciled }) => usageReconciled === true)).toBe(true);
      expect(results.every(({ modelPolicy }) => modelPolicy === "gpt-benchmark-fixture")).toBe(
        true,
      );
      expect(results.every(({ effortPolicy }) => effortPolicy === "high")).toBe(true);
      expect(
        results.every(
          ({ permissionPolicy }) =>
            permissionPolicy === "codex_workspace_write_shell_external_not_graphcraft_enforced",
        ),
      ).toBe(true);
      expect(results.every(({ scorerVerified }) => scorerVerified === true)).toBe(true);
      expect(
        results.every(
          ({ reviewPacket }) =>
            typeof reviewPacket === "object" &&
            reviewPacket !== null &&
            (reviewPacket as { captureFailures?: unknown[] }).captureFailures?.length === 0,
        ),
      ).toBe(true);
      expect(
        persisted.results.every(({ reviewPacket }) =>
          reviewPacket?.patch.text.includes("source.js"),
        ),
      ).toBe(true);
      expect(
        persisted.results.some(({ reviewPacket }) =>
          reviewPacket?.transcript.text.includes("graphcraft_host_event"),
        ),
      ).toBe(true);
      expect(persisted.modelPolicy).toEqual({ codex: "gpt-benchmark-fixture" });
      expect(persisted.effortPolicy).toBe("high");
      expect(persisted.permissionPolicy).toEqual({
        codex: "codex_workspace_write_shell_external_not_graphcraft_enforced",
      });
      expect(persisted.environment.graphcraftVersion).toBe(graphcraftVersion);
      expect(persisted.environment.graphcraftSource?.commitSha).toMatch(
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
      );
      expect(persisted.reviewPolicy).toBe("bounded_redacted_patch_and_transcript_v2");
      expect(persisted.summary).toMatchObject({
        codex: {
          baseline: { trials: 1, accepted: 1 },
          graphcraft: { trials: 1, accepted: 1 },
        },
      });
      expect(adapter.graphcraftRepositories).toHaveLength(1);
      for (const repository of adapter.graphcraftRepositories) {
        const worktreeRoot = join(
          dirname(repository),
          `.${basename(repository)}-graphcraft-worktrees`,
        );
        await expect(stat(repository)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(worktreeRoot)).rejects.toMatchObject({ code: "ENOENT" });
      }

      const resumed = await runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: {},
        policies,
        graphcraftVersion,
        seed: "runtime-seed",
        repetitions: 1,
        outputPath,
      });
      expect(resumed.report.status).toBe("complete");
      expect(resumed.report.results).toHaveLength(2);

      const configuredSecret = "opaque-benchmark-secret-12345";
      const previousSecret = process.env.GRAPHCRAFT_BENCHMARK_API_KEY;
      const redactedOutputPath = join(root, "redacted-report.json");
      process.env.GRAPHCRAFT_BENCHMARK_API_KEY = configuredSecret;
      try {
        const redacted = await runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: {
            codex: new BenchmarkAdapter({
              failureMessage: `Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz configured=${configuredSecret}`,
            }),
          },
          policies,
          graphcraftVersion,
          seed: "redaction-seed",
          repetitions: 1,
          outputPath: redactedOutputPath,
        });
        const reportText = await readFile(redactedOutputPath, "utf8");
        expect(reportText).toContain("[REDACTED]");
        expect(JSON.stringify(redacted.report)).not.toContain(configuredSecret);
        expect(reportText).not.toContain(configuredSecret);
        expect(reportText).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
        expect(redacted.report.results.every(({ accepted }) => !accepted)).toBe(true);
        expect(
          redacted.report.results.every(({ reviewPacket }) => reviewPacket !== undefined),
        ).toBe(true);
        expect(
          redacted.report.results.some(({ reviewPacket }) =>
            reviewPacket?.transcript.text.includes("[REDACTED]"),
          ),
        ).toBe(true);
        if (process.platform !== "win32")
          expect((await stat(redactedOutputPath)).mode & 0o777).toBe(0o600);
      } finally {
        if (previousSecret === undefined) delete process.env.GRAPHCRAFT_BENCHMARK_API_KEY;
        else process.env.GRAPHCRAFT_BENCHMARK_API_KEY = previousSecret;
      }

      const binarySecret = "binary-review-payload-must-not-be-published";
      const ignoredSecret = "ignored-review-payload-must-not-be-published";
      const boundedReview = await runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: {
          codex: new BenchmarkAdapter({
            binaryBaselineSecret: binarySecret,
            ignoredBaselineSecret: ignoredSecret,
            oversizedGraphcraftPatch: true,
          }),
        },
        policies,
        graphcraftVersion,
        seed: "bounded-review-seed",
        repetitions: 1,
        outputPath: join(root, "bounded-review-report.json"),
      });
      const binaryBaseline = boundedReview.report.results.find(
        ({ trial }) => trial.mode === "baseline",
      )!;
      expect(binaryBaseline).toMatchObject({ accepted: false });
      expect(binaryBaseline.reviewPacket?.patch.truncated).toBe(false);
      expect(binaryBaseline.reviewPacket?.captureFailures).toEqual(
        expect.arrayContaining([
          expect.stringContaining("binary patch payload omitted"),
          expect.stringContaining("ignored untracked payload omitted"),
        ]),
      );
      expect(binaryBaseline.reviewPacket?.patch.text).toContain("Binary files");
      expect(binaryBaseline.reviewPacket?.patch.text).not.toContain("GIT binary patch");
      expect(binaryBaseline.reviewPacket?.patch.text).not.toContain(binarySecret);
      expect(binaryBaseline.reviewPacket?.patch.text).not.toContain(ignoredSecret);
      expect(JSON.stringify(boundedReview.report)).not.toContain(ignoredSecret);

      const truncatedGraphcraft = boundedReview.report.results.find(
        ({ trial }) => trial.mode === "graphcraft",
      )!;
      expect(truncatedGraphcraft).toMatchObject({ accepted: false });
      expect(truncatedGraphcraft.reviewPacket?.patch.truncated).toBe(true);
      expect(truncatedGraphcraft.reviewPacket?.captureFailures).toEqual(
        expect.arrayContaining([expect.stringContaining("review is incomplete")]),
      );
      expect(truncatedGraphcraft.failureTrace).toEqual(
        expect.arrayContaining([expect.stringContaining("patch review evidence exceeded")]),
      );

      const truncatedTranscript = await runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: new BenchmarkAdapter({ baselineTranscriptMessageCount: 48 }) },
        policies,
        graphcraftVersion,
        seed: "bounded-transcript-seed",
        repetitions: 1,
        outputPath: join(root, "bounded-transcript-report.json"),
      });
      const transcriptLimitedBaseline = truncatedTranscript.report.results.find(
        ({ trial }) => trial.mode === "baseline",
      )!;
      expect(transcriptLimitedBaseline).toMatchObject({ accepted: false });
      expect(transcriptLimitedBaseline.reviewPacket?.transcript.truncated).toBe(true);
      expect(transcriptLimitedBaseline.reviewPacket?.transcript.observedBytes).toBeGreaterThan(
        3 * 1024 * 1024,
      );
      expect(transcriptLimitedBaseline.reviewPacket?.transcript.retainedBytes).toBeLessThanOrEqual(
        64 * 1024,
      );
      expect(transcriptLimitedBaseline.reviewPacket?.captureFailures).toEqual(
        expect.arrayContaining([expect.stringContaining("transcript review evidence exceeded")]),
      );
      expect(transcriptLimitedBaseline.failureTrace).toEqual(
        expect.arrayContaining([expect.stringContaining("transcript review evidence exceeded")]),
      );

      const legacyOutputPath = join(root, "legacy-truncated-transcript-report.json");
      const legacySeed = "bounded-transcript-seed";
      const legacyRunning = emptyRunningReport({
        schemaVersion: 3,
        suite,
        seed: legacySeed,
        model: policies.codex!.model,
        effort: policies.codex!.effort,
        graphcraftVersion,
      });
      await writeFile(legacyOutputPath, `${JSON.stringify(legacyRunning, null, 2)}\n`, "utf8");
      const legacyCompleted = await runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: new BenchmarkAdapter({ baselineTranscriptMessageCount: 48 }) },
        policies,
        graphcraftVersion,
        seed: legacySeed,
        repetitions: 1,
        outputPath: legacyOutputPath,
      });
      if (legacyCompleted.report.schemaVersion !== 3)
        throw new Error("Expected the legacy benchmark fixture to remain schema v3");
      const legacyReport = structuredClone(legacyCompleted.report);
      const legacyBaseline = legacyReport.results.find(({ trial }) => trial.mode === "baseline")!;
      legacyBaseline.accepted = true;
      legacyBaseline.reviewPacket!.captureFailures = [];
      legacyBaseline.failureTrace = legacyBaseline.failureTrace.filter(
        (entry) => !entry.includes("transcript review evidence exceeded"),
      );
      const legacySummaryResults = structuredClone(legacyReport.results);
      const legacySummaryBaseline = legacySummaryResults.find(
        ({ trial }) => trial.mode === "baseline",
      )!;
      legacySummaryBaseline.accepted = true;
      delete legacySummaryBaseline.reviewPacket;
      legacyReport.summary = summarizeBenchmark(legacySummaryResults, legacyReport.schedule, {
        schemaVersion: 3,
        hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
      });
      await writeFile(legacyOutputPath, `${JSON.stringify(legacyReport, null, 2)}\n`, "utf8");

      const migratedLegacy = await runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: {},
        policies,
        graphcraftVersion,
        seed: "bounded-transcript-seed",
        repetitions: 1,
        outputPath: legacyOutputPath,
      });
      const migratedBaseline = migratedLegacy.report.results.find(
        ({ trial }) => trial.mode === "baseline",
      )!;
      expect(migratedBaseline.accepted).toBe(false);
      expect(migratedBaseline.reviewPacket?.captureFailures).toEqual([
        expect.stringContaining("transcript review evidence exceeded"),
      ]);
      const persistedLegacy = JSON.parse(await readFile(legacyOutputPath, "utf8")) as {
        results: typeof migratedLegacy.report.results;
      };
      expect(persistedLegacy.results.find(({ trial }) => trial.mode === "baseline")).toMatchObject({
        accepted: false,
        reviewPacket: {
          captureFailures: [expect.stringContaining("transcript review evidence exceeded")],
        },
      });

      const tamperedLegacyPath = join(root, "tampered-legacy-transcript-report.json");
      const tamperedLegacy = { ...legacyReport, summary: { tampered: true } };
      const tamperedLegacyBytes = `${JSON.stringify(tamperedLegacy, null, 2)}\n`;
      await writeFile(tamperedLegacyPath, tamperedLegacyBytes, "utf8");
      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: {},
          policies,
          graphcraftVersion,
          seed: "bounded-transcript-seed",
          repetitions: 1,
          outputPath: tamperedLegacyPath,
        }),
      ).rejects.toThrow(/summary does not match its trial evidence/);
      await expect(readFile(tamperedLegacyPath, "utf8")).resolves.toBe(tamperedLegacyBytes);

      const oversizedEvent = await runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: new BenchmarkAdapter({ oversizedBaselineEvent: true }) },
        policies,
        graphcraftVersion,
        seed: "oversized-host-event-seed",
        repetitions: 1,
        outputPath: join(root, "oversized-host-event-report.json"),
      });
      const oversizedEventBaseline = oversizedEvent.report.results.find(
        ({ trial }) => trial.mode === "baseline",
      )!;
      expect(oversizedEventBaseline).toMatchObject({ accepted: false, executionStatus: "error" });
      expect(oversizedEventBaseline.reviewPacket?.transcript.observedBytes).toBeLessThan(16 * 1024);
      expect(oversizedEventBaseline.failureTrace.join("\n")).toMatch(/too_big|too big/i);

      const providerLimited = usage(10, 4);
      providerLimited.availability.reasoning = "unavailable";
      const providerLimitedResult = await runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: new BenchmarkAdapter({ usageReceipt: providerLimited }) },
        policies,
        graphcraftVersion,
        seed: "provider-limited-seed",
        repetitions: 1,
        outputPath: join(root, "provider-limited-report.json"),
      });
      expect(
        providerLimitedResult.report.results.every(({ usageReconciled }) => usageReconciled),
      ).toBe(true);
      expect(
        providerLimitedResult.report.results.every(({ limitations }) =>
          limitations.includes("reasoning:unavailable"),
        ),
      ).toBe(true);
      expect(providerLimitedResult.report.summary).toMatchObject({
        codex: {
          matchedAccepted: {
            pairs: 1,
            minimumPairsPerTask: 3,
            completeTaskCoverage: false,
          },
          gate: { completeSchedule: true, comparable: false, passes: null },
        },
      });

      const weakened = await runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: { codex: new BenchmarkAdapter({ weakenBaselineScorer: true }) },
        policies,
        graphcraftVersion,
        seed: "weakened-scorer-seed",
        repetitions: 1,
        outputPath: join(root, "weakened-scorer-report.json"),
      });
      const weakenedBaseline = weakened.report.results.find(
        ({ trial }) => trial.mode === "baseline",
      )!;
      const protectedGraphcraft = weakened.report.results.find(
        ({ trial }) => trial.mode === "graphcraft",
      )!;
      expect(weakenedBaseline).toMatchObject({ accepted: false, scorerVerified: false });
      expect(weakenedBaseline.observedScorerDigest).not.toBe(
        weakenedBaseline.acceptanceScorerDigest,
      );
      expect(weakenedBaseline.acceptance[0]?.summary).toContain("changed from its fixture bytes");
      expect(weakenedBaseline.reviewPacket?.patch.text).toContain("score.mjs");
      expect(weakenedBaseline.reviewPacket?.transcript.text).toContain("baseline_host_event");
      expect(protectedGraphcraft).toMatchObject({ accepted: true, scorerVerified: true });

      const malformedAcceptance = await runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: {
          codex: new BenchmarkAdapter({ makeBaselineAcceptancePathDirectory: true }),
        },
        policies,
        graphcraftVersion,
        seed: "malformed-acceptance-seed",
        repetitions: 1,
        outputPath: join(root, "malformed-acceptance-report.json"),
      });
      const malformedBaseline = malformedAcceptance.report.results.find(
        ({ trial }) => trial.mode === "baseline",
      )!;
      expect(malformedBaseline).toMatchObject({ executionStatus: "completed", accepted: false });
      expect(malformedBaseline.acceptance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "source.js",
            passed: false,
            summary: expect.stringContaining("could not be evaluated"),
          }),
        ]),
      );

      const incompleteComplete = structuredClone(persisted);
      incompleteComplete.results = [];
      incompleteComplete.summary = { codex: { gate: { passes: true } } };
      const incompletePath = join(root, "incomplete-complete-report.json");
      await writeFile(incompletePath, JSON.stringify(incompleteComplete), "utf8");
      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: {},
          policies,
          graphcraftVersion,
          seed: "runtime-seed",
          repetitions: 1,
          outputPath: incompletePath,
        }),
      ).rejects.toThrow("does not cover the exact current schedule");

      const forgedSummary = structuredClone(persisted);
      forgedSummary.summary = { codex: { gate: { passes: true } } };
      const forgedSummaryPath = join(root, "forged-summary-report.json");
      await writeFile(forgedSummaryPath, JSON.stringify(forgedSummary), "utf8");
      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: {},
          policies,
          graphcraftVersion,
          seed: "runtime-seed",
          repetitions: 1,
          outputPath: forgedSummaryPath,
        }),
      ).rejects.toThrow("summary does not match its trial evidence");

      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: {},
          policies: { codex: { model: "different-model", effort: "high" } },
          graphcraftVersion,
          seed: "runtime-seed",
          repetitions: 1,
          outputPath,
        }),
      ).rejects.toThrow("does not match this suite and schedule");

      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: {},
          policies,
          graphcraftVersion: "0.1.3-different-implementation",
          seed: "runtime-seed",
          repetitions: 1,
          outputPath,
        }),
      ).rejects.toThrow("Graphcraft version identity does not match this execution");

      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: {},
          policies,
          graphcraftVersion,
          graphcraftSource: {
            commitSha: "b".repeat(40),
            dirty: false,
            dirtyStatusDigest: null,
          },
          seed: "runtime-seed",
          repetitions: 1,
          outputPath,
        }),
      ).rejects.toThrow("Graphcraft source identity does not match this execution");

      persisted.results[0]!.acceptanceScorerDigest = "tampered-scorer";
      persisted.summary = summarizeBenchmark(persisted.results, persisted.schedule, {
        schemaVersion: 4,
        hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      });
      await writeFile(outputPath, JSON.stringify(persisted), "utf8");
      await expect(
        runBenchmark({
          suite,
          hosts: ["codex"],
          adapters: {},
          policies,
          graphcraftVersion,
          seed: "runtime-seed",
          repetitions: 1,
          outputPath,
        }),
      ).rejects.toThrow("mismatched trial controls");
    },
    process.platform === "win32" ? 120_000 : 60_000,
  );
});
