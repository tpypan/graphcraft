import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BenchmarkSuiteSchema,
  reconcilePersistedInvocation,
  type HostAdapter,
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
  readonly id = "test" as const;

  constructor(private readonly failureMessage?: string) {}

  async probe(): Promise<HostCapabilities> {
    return {
      installed: true,
      authenticated: true,
      version: "benchmark-fixture",
      structuredOutput: true,
      streamingEvents: true,
      tokenReporting: true,
    };
  }

  async plan(request: PlanningRequest): Promise<PlanningResult> {
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
      usage: usage(5, 2),
    };
  }

  async *execute(request: WorkerRequest): AsyncIterable<HostEvent> {
    yield { type: "started", invocationId: request.invocationId };
    yield { type: "session", hostSessionId: request.invocationId };
    if (this.failureMessage) {
      yield { type: "error", message: this.failureMessage };
      return;
    }
    await writeFile(
      join(request.repositoryPath, "source.js"),
      "export const value = 'implemented';\n",
      "utf8",
    );
    yield { type: "usage", usage: usage(10, 4) };
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
      usage: usage(2, 1),
    };
  }

  async reconcile(invocation: InvocationRecord): Promise<ReconciliationResult> {
    return reconcilePersistedInvocation(invocation);
  }
}

describe("benchmark harness", () => {
  it("runs matched fresh fixtures and persists baseline plus Graphcraft receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-report-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "report.json");
    const suite = BenchmarkSuiteSchema.parse({
      schemaVersion: 1,
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
          },
          checks: [{ command: "node", args: ["verify.mjs"] }],
          acceptance: [{ kind: "contains", path: "source.js", value: "implemented" }],
          repetitions: 1,
        },
      ],
    });
    const adapter = new BenchmarkAdapter();
    const policies = { codex: { model: "gpt-benchmark-fixture", effort: "high" as const } };

    const { report } = await runBenchmark({
      suite,
      hosts: ["codex"],
      adapters: { codex: adapter },
      policies,
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
    expect(results.every(({ modelPolicy }) => modelPolicy === "gpt-benchmark-fixture")).toBe(true);
    expect(results.every(({ effortPolicy }) => effortPolicy === "high")).toBe(true);
    expect(persisted.modelPolicy).toEqual({ codex: "gpt-benchmark-fixture" });
    expect(persisted.effortPolicy).toBe("high");
    expect(persisted.summary).toMatchObject({
      codex: {
        baseline: { trials: 1, accepted: 1 },
        graphcraft: { trials: 1, accepted: 1 },
      },
    });

    const resumed = await runBenchmark({
      suite,
      hosts: ["codex"],
      adapters: {},
      policies,
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
          codex: new BenchmarkAdapter(
            `Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz configured=${configuredSecret}`,
          ),
        },
        policies,
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

    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: {},
        policies: { codex: { model: "different-model", effort: "high" } },
        seed: "runtime-seed",
        repetitions: 1,
        outputPath,
      }),
    ).rejects.toThrow("does not match this suite and schedule");

    persisted.results[0]!.acceptanceScorerDigest = "tampered-scorer";
    await writeFile(outputPath, JSON.stringify(persisted), "utf8");
    await expect(
      runBenchmark({
        suite,
        hosts: ["codex"],
        adapters: {},
        policies,
        seed: "runtime-seed",
        repetitions: 1,
        outputPath,
      }),
    ).rejects.toThrow("mismatched trial controls");
  });
});
