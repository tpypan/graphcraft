import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BenchmarkSuiteSchema,
  REQUIRED_HOST_PROTOCOL_CAPABILITIES,
  assertRequiredHostCapabilities,
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
import { runBenchmark } from "./benchmark.ts";

const temporaryRoots: string[] = [];

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

class BenchmarkAdapter implements HostAdapter {
  readonly id = "codex" as const;
  readonly graphcraftRepositories: string[] = [];
  readonly workerRequests: WorkerRequest[] = [];
  probeCalls = 0;

  constructor(
    private readonly options: {
      failureMessage?: string;
      usageReceipt?: TokenUsage;
      weakenBaselineScorer?: boolean;
      makeBaselineAcceptancePathDirectory?: boolean;
      capabilities?: Partial<HostCapabilities>;
      capabilitySequence?: HostCapabilities[];
      revalidatePlan?: boolean;
      revalidateExecute?: boolean;
    } = {},
  ) {}

  private usage(input: number, output: number): TokenUsage {
    return this.options.usageReceipt ?? usage(input, output);
  }

  async probe(): Promise<HostCapabilities> {
    const capabilities = {
      ...hostCapabilitiesFromProtocolProfile("codex", {
        installed: true,
        authenticated: true,
        version: "codex-cli 0.144.6",
      }),
      ...this.options.capabilities,
    };
    const sequenced = this.options.capabilitySequence?.[this.probeCalls];
    this.probeCalls += 1;
    return sequenced ?? capabilities;
  }

  async plan(request: PlanningRequest): Promise<PlanningResult> {
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

  async *execute(request: WorkerRequest): AsyncIterable<HostEvent> {
    if (this.options.revalidateExecute) assertRequiredHostCapabilities(this.id, await this.probe());
    this.workerRequests.push(request);
    yield { type: "started", invocationId: request.invocationId };
    yield { type: "session", hostSessionId: request.invocationId };
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
    await writeFile(
      join(request.repositoryPath, "source.js"),
      "export const value = 'implemented';\n",
      "utf8",
    );
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

  async verify(_request: SemanticVerificationRequest): Promise<SemanticVerificationResult> {
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

  it.each(REQUIRED_HOST_PROTOCOL_CAPABILITIES)(
    "rejects benchmark admission before fixture or report creation when %s is unavailable",
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
      await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

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
      results: [],
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
        results: [],
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
      expect(persisted.modelPolicy).toEqual({ codex: "gpt-benchmark-fixture" });
      expect(persisted.effortPolicy).toBe("high");
      expect(persisted.permissionPolicy).toEqual({
        codex: "codex_workspace_write_shell_external_not_graphcraft_enforced",
      });
      expect(persisted.environment.graphcraftVersion).toBe(graphcraftVersion);
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
        if (process.platform !== "win32")
          expect((await stat(redactedOutputPath)).mode & 0o777).toBe(0o600);
      } finally {
        if (previousSecret === undefined) delete process.env.GRAPHCRAFT_BENCHMARK_API_KEY;
        else process.env.GRAPHCRAFT_BENCHMARK_API_KEY = previousSecret;
      }

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

      persisted.results[0]!.acceptanceScorerDigest = "tampered-scorer";
      persisted.summary = summarizeBenchmark(persisted.results, persisted.schedule);
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
    process.platform === "win32" ? 120_000 : process.platform === "darwin" ? 60_000 : 15_000,
  );
});
