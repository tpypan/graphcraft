import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  BenchmarkReportSchema,
  BenchmarkReportV4Schema,
  BenchmarkReviewPacketSchema,
  BenchmarkReviewPacketV1Schema,
  BenchmarkReviewPacketV2Schema,
  BenchmarkSuiteSchema,
  BenchmarkTrialResultSchema,
  BenchmarkTrialResultV2Schema,
  BenchmarkTrialResultV4Schema,
  LEGACY_CANONICAL_HASH_ALGORITHM,
  MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  benchmarkReviewEvidenceDigest,
  contentHash,
  createBenchmarkSchedule,
  summarizeBenchmark,
  unavailableTokenUsage,
  type BenchmarkScheduleEntry,
  type BenchmarkTrialResult,
} from "./index.ts";

const execFileAsync = promisify(execFile);

const legacyReportIdentity = {
  schemaVersion: 3,
  hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
} as const;
const portableReportIdentity = {
  schemaVersion: 4,
  hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
} as const;

const suite = BenchmarkSuiteSchema.parse({
  schemaVersion: 2,
  id: "fixture-suite",
  version: 1,
  description: "Deterministic schedule fixture",
  tasks: [
    {
      id: "feature-one",
      family: "feature",
      task: "Implement the fixture feature",
      initialFiles: { "package.json": "{}\n", "score.mjs": "\n" },
      checks: [{ command: "node", scorerPath: "score.mjs" }],
      acceptance: [{ kind: "exists", path: "result.js" }],
      repetitions: 2,
    },
  ],
});

function reportedTrial(
  trial: BenchmarkScheduleEntry,
  total: number,
  accepted = true,
): BenchmarkTrialResult {
  return BenchmarkTrialResultSchema.parse({
    trial,
    hostVersion: "fixture",
    modelPolicy: "gpt-benchmark-fixture",
    effortPolicy: "high",
    permissionPolicy: "codex_workspace_write_shell_external_not_graphcraft_enforced",
    acceptanceScorerDigest: "fixture-scorer",
    observedScorerDigest: "fixture-scorer",
    scorerVerified: true,
    repositoryDigest: "same-fixture",
    baseSha: "same-base-sha",
    executionStatus: accepted ? "completed" : "failed",
    attemptCheckpoint: "settled",
    accepted,
    acceptance: [{ path: "result.js", passed: accepted, summary: "fixture score" }],
    usage: {
      input: total,
      cachedInput: 0,
      uncachedInput: total,
      output: 0,
      reasoning: 0,
      total,
      availability: {
        input: "reported",
        cachedInput: "reported",
        uncachedInput: "derived",
        output: "reported",
        reasoning: "reported",
        total: "reported",
      },
    },
    usageReconciled: true,
    limitations: [],
    durationMs: 1,
    humanInterventions: 0,
    failureTrace: accepted ? [] : ["held-out scorer failed"],
  });
}

function reportValue(
  schedule: BenchmarkScheduleEntry[],
  results: BenchmarkTrialResult[],
  status: "running" | "complete" = "running",
) {
  return {
    schemaVersion: 3 as const,
    status,
    suite: { id: suite.id, version: suite.version, digest: "fixture-suite-digest" },
    startedAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
    seed: "report-schema-seed",
    randomized: true as const,
    modelPolicy: { codex: "gpt-benchmark-fixture" },
    effortPolicy: "high" as const,
    permissionPolicy: {
      codex: "codex_workspace_write_shell_external_not_graphcraft_enforced" as const,
    },
    scorerPolicy: "fixture_bound_scorers_plus_suite_assertions" as const,
    modelCallTimeoutMs: 15 * 60_000,
    environment: {
      platform: "fixture",
      architecture: "fixture",
      nodeVersion: "fixture",
      graphcraftVersion: "0.1.2-fixture",
    },
    limitations: [],
    schedule,
    results,
    summary: summarizeBenchmark(results, schedule),
  };
}

function reviewEvidence(
  packetSchemaVersion: 1 | 2,
  mediaType: "text/x-diff" | "application/x-ndjson",
  text: string,
) {
  const identity = {
    mediaType,
    text,
    observedBytes: Buffer.byteLength(text),
    omittedBytes: 0,
    truncated: false,
  };
  return {
    ...identity,
    retainedBytes: Buffer.byteLength(text),
    digest: benchmarkReviewEvidenceDigest(identity, packetSchemaVersion),
  };
}

describe("matched benchmark protocol", () => {
  it("ships ten versioned public tasks across every required family", async () => {
    const publicSuite = BenchmarkSuiteSchema.parse(
      JSON.parse(
        await readFile(new URL("../../../benchmarks/stable-v1.json", import.meta.url), "utf8"),
      ),
    );

    expect(publicSuite.tasks).toHaveLength(10);
    expect(new Set(publicSuite.tasks.map(({ family }) => family))).toEqual(
      new Set(["bug", "feature", "migration", "refactor", "audit", "pr_repair"]),
    );
    expect(publicSuite.tasks.every(({ repetitions }) => repetitions >= 3)).toBe(true);
    expect(publicSuite.tasks.every(({ checks }) => checks.length > 0)).toBe(true);
    const audit = publicSuite.tasks.find(({ id }) => id === "audit-api-boundary")!;
    expect(
      audit.acceptance.flatMap((assertion) =>
        assertion.kind === "summary_contains" ? [assertion.value] : [],
      ),
    ).toEqual(expect.arrayContaining(["JSON.parse", "SyntaxError", "null", "non-string"]));
    expect(audit.acceptance).toContainEqual({
      kind: "equals",
      path: "api.js",
      value: audit.initialFiles["api.js"],
    });

    const repository = await mkdtemp(join(tmpdir(), "graphcraft-audit-benchmark-"));
    try {
      await Promise.all(
        Object.entries(audit.initialFiles).map(([path, value]) =>
          writeFile(join(repository, path), value, "utf8"),
        ),
      );
      const apiBefore = await readFile(join(repository, "api.js"), "utf8");
      await execFileAsync(process.execPath, [join(repository, "score.mjs")], {
        cwd: repository,
      });
      expect(await readFile(join(repository, "api.js"), "utf8")).toBe(apiBefore);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("creates a deterministic randomized schedule with both matched modes", () => {
    const first = createBenchmarkSchedule({
      suite,
      hosts: ["claude", "codex"],
      seed: "fixture-seed",
    });
    const second = createBenchmarkSchedule({
      suite,
      hosts: ["codex", "claude"],
      seed: "fixture-seed",
    });

    expect(second).toEqual(first);
    expect(first).toHaveLength(8);
    expect(new Set(first.map(({ mode }) => mode))).toEqual(new Set(["baseline", "graphcraft"]));
    expect(new Set(first.map(({ host }) => host))).toEqual(new Set(["codex", "claude"]));
    expect(new Set(first.map(({ trialId }) => trialId)).size).toBe(first.length);
    expect(first.map(({ trialId }) => trialId)).toEqual([
      "90cb75ce260094d224577a1af3a1057fafe9df3dfc81f17996823ef1f84d4ba9",
      "04dfc82e498e1a23325972641386a77d67d6baef2c5f9803224e7480a20741a2",
      "99b302bcbb5069c78240cd8ea903136709d2576ee285dd7fcd83236bbc93b34e",
      "a7e5f77fb321a61ab3ed24274c11ef2b1ad8bf0436d416769d6491238a00c5e3",
      "2f266724c4cac00e56cd5d999f697556ac762dacb9edcb81c8262ac57284c14c",
      "4ed74843acde3bcc5fa8655290a03cbdf5543e39993fab49192df90852c130ec",
      "60eb22d4bad517be3c44fdaeb95048a4ab8affe2a5247b60eb6b3610086439ff",
      "492c0ab6207205bcb8cdeadb1c3da07536752cc43250496c07e4187ac80e9d08",
    ]);
  });

  it("keeps the legacy shuffle order while giving portable reports distinct trial IDs", () => {
    const legacy = createBenchmarkSchedule({
      suite,
      hosts: ["claude", "codex"],
      seed: "fixture-seed",
      identity: legacyReportIdentity,
    });
    const portable = createBenchmarkSchedule({
      suite,
      hosts: ["claude", "codex"],
      seed: "fixture-seed",
      identity: portableReportIdentity,
    });
    const withoutTrialIds = (schedule: BenchmarkScheduleEntry[]) =>
      schedule.map(({ trialId: _trialId, ...entry }) => entry);

    expect(withoutTrialIds(portable)).toEqual(withoutTrialIds(legacy));
    expect(portable.map(({ trialId }) => trialId)).not.toEqual(
      legacy.map(({ trialId }) => trialId),
    );
    expect(portable.every((trial, index) => trial.trialId !== legacy[index]!.trialId)).toBe(true);
    expect(() =>
      createBenchmarkSchedule({
        suite,
        hosts: ["codex"],
        seed: "fixture-seed",
        identity: {
          schemaVersion: 4,
          hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
        } as never,
      }),
    ).toThrow();
  });

  it("rejects duplicate task IDs before they can alias schedule entries", () => {
    const task = suite.tasks[0]!;
    expect(() =>
      BenchmarkSuiteSchema.parse({
        ...suite,
        tasks: [task, { ...task, task: "A different task with the same ID" }],
      }),
    ).toThrow(/task IDs must be unique/);
  });

  it("rejects duplicate schedule and result trial IDs", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const duplicateSchedule = [schedule[0]!, { ...schedule[1]!, trialId: schedule[0]!.trialId }];
    expect(() => BenchmarkReportSchema.parse(reportValue(duplicateSchedule, []))).toThrow(
      /schedule trial IDs must be unique/,
    );

    const result = reportedTrial(schedule[0]!, 100);
    expect(() => BenchmarkReportSchema.parse(reportValue(schedule, [result, result]))).toThrow(
      /result trial IDs must be unique/,
    );
  });

  it("rejects foreign or altered result trials", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const foreign = reportedTrial({ ...schedule[0]!, trialId: "foreign-trial" }, 100);
    expect(() => BenchmarkReportSchema.parse(reportValue(schedule, [foreign]))).toThrow(
      /exactly match a scheduled trial/,
    );

    const altered = reportedTrial({ ...schedule[0]!, taskId: "altered-task" }, 100);
    expect(() => BenchmarkReportSchema.parse(reportValue(schedule, [altered]))).toThrow(
      /exactly match a scheduled trial/,
    );
  });

  it("requires exact result coverage before a report can be complete", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const results = schedule.slice(0, -1).map((trial) => reportedTrial(trial, 100));
    expect(() => BenchmarkReportSchema.parse(reportValue(schedule, results, "complete"))).toThrow(
      /complete benchmark report does not cover the exact current schedule/i,
    );
  });

  it("rejects complete reports with unconfirmed child settlement", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const results = schedule.map((trial) => reportedTrial(trial, 100));
    results[0] = BenchmarkTrialResultSchema.parse({
      ...results[0],
      executionStatus: "timed_out",
      interruption: {
        cause: "timeout",
        reason: "fixture child did not settle",
        childSettlement: "unconfirmed",
      },
      recovery: {
        disposition: "preserved",
        fixtureRepository: "/tmp/benchmark-fixture",
        lastKnownRepository: "/tmp/benchmark-fixture",
        requiredAction: "reconcile_child_before_cleanup_or_resume",
      },
      accepted: false,
    });

    expect(() => BenchmarkReportSchema.parse(reportValue(schedule, results, "complete"))).toThrow(
      /cannot retain unconfirmed child settlement/i,
    );
  });

  it("rejects complete reports with an unfinished host preflight", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const results = schedule.map((trial) => reportedTrial(trial, 100));

    expect(() =>
      BenchmarkReportSchema.parse({
        ...reportValue(schedule, results, "complete"),
        hostPreflightCheckpoint: {
          host: "codex",
          phase: "capability_probe",
          attemptCheckpoint: "settled",
          interruption: {
            cause: "timeout",
            reason: "fixture capability probe did not settle",
            childSettlement: "unconfirmed",
          },
          requiredAction: "reconcile_host_child_before_resume",
        },
      }),
    ).toThrow(/cannot retain an unfinished host preflight/i);
  });

  it("rejects model-call timeouts above the Node timer maximum", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const report = reportValue(schedule, []);
    expect(
      BenchmarkReportSchema.parse({
        ...report,
        modelCallTimeoutMs: MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS,
      }),
    ).toMatchObject({ modelCallTimeoutMs: MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS });
    expect(() =>
      BenchmarkReportSchema.parse({
        ...report,
        modelCallTimeoutMs: MAX_BENCHMARK_MODEL_CALL_TIMEOUT_MS + 1,
      }),
    ).toThrow();
  });

  it("derives the report summary from its trial evidence", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const valid = reportValue(schedule, []);
    expect(BenchmarkReportSchema.parse(valid).summary).toEqual(
      summarizeBenchmark(valid.results, valid.schedule),
    );
    expect(() => BenchmarkReportSchema.parse({ ...valid, summary: { fixture: true } })).toThrow(
      /summary does not match its trial evidence/,
    );
  });

  it("preserves the checked legacy v2 and v3 report fixtures byte-for-byte", async () => {
    for (const version of [2, 3] as const) {
      const source = await readFile(
        new URL(
          `../../../tests/fixtures/protocol/benchmark-report.v${version}.json`,
          import.meta.url,
        ),
        "utf8",
      );
      const value = JSON.parse(source) as unknown;
      expect(BenchmarkReportSchema.parse(value)).toEqual(value);
    }
  });

  it("keeps the default summary parser backward-compatible with v2 trials", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "legacy-v2-summary-seed",
      repetitions: 1,
    });
    const {
      attemptCheckpoint: _attemptCheckpoint,
      interruption: _interruption,
      recovery: _recovery,
      ...legacyValue
    } = reportedTrial(schedule[0]!, 100);
    const result = BenchmarkTrialResultV2Schema.parse(legacyValue);

    expect(summarizeBenchmark([result], schedule)).toEqual(
      summarizeBenchmark([result], schedule, {
        schemaVersion: 2,
        hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
      }),
    );
  });

  it("requires an explicit Graphcraft version identity in benchmark reports", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const valid = reportValue(schedule, []);
    expect(BenchmarkReportSchema.parse(valid).environment.graphcraftVersion).toBe("0.1.2-fixture");
    const { graphcraftVersion: _graphcraftVersion, ...identitylessEnvironment } = valid.environment;
    expect(() =>
      BenchmarkReportSchema.parse({ ...valid, environment: identitylessEnvironment }),
    ).toThrow(/graphcraftVersion/);
  });

  it("keeps legacy reports readable while enforcing source-bound review packets when declared", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "report-schema-seed",
    });
    const legacy = reportValue(schedule, []);
    expect(BenchmarkReportSchema.parse(legacy).reviewPolicy).toBeUndefined();

    const evidence = (mediaType: "text/x-diff" | "application/x-ndjson", text: string) => ({
      mediaType,
      text,
      observedBytes: Buffer.byteLength(text),
      retainedBytes: Buffer.byteLength(text),
      omittedBytes: 0,
      truncated: false,
      digest: contentHash({
        mediaType,
        text,
        observedBytes: Buffer.byteLength(text),
        omittedBytes: 0,
        truncated: false,
      }),
    });
    const result = {
      ...reportedTrial(schedule[0]!, 100),
      reviewPacket: {
        schemaVersion: 1 as const,
        patch: evidence("text/x-diff", "diff --git a/result.js b/result.js\n"),
        transcript: evidence("application/x-ndjson", '{"type":"result"}\n'),
        captureFailures: [],
      },
    };
    const evidenceBacked = {
      ...reportValue(schedule, [result]),
      reviewPolicy: "bounded_redacted_patch_and_transcript_v1" as const,
      environment: {
        ...legacy.environment,
        graphcraftSource: {
          commitSha: "a".repeat(40),
          dirty: false,
          dirtyStatusDigest: null,
        },
      },
      summary: summarizeBenchmark([result], schedule),
    };
    expect(BenchmarkReportSchema.parse(evidenceBacked)).toMatchObject({
      reviewPolicy: "bounded_redacted_patch_and_transcript_v1",
      environment: { graphcraftSource: { commitSha: "a".repeat(40), dirty: false } },
    });
    expect(() =>
      BenchmarkReportSchema.parse({
        ...evidenceBacked,
        results: [reportedTrial(schedule[0]!, 100)],
      }),
    ).toThrow(/review packet/);
    expect(() =>
      BenchmarkReportSchema.parse({
        ...evidenceBacked,
        environment: legacy.environment,
      }),
    ).toThrow(/source identity/);
    expect(() =>
      BenchmarkReportSchema.parse({
        ...evidenceBacked,
        environment: {
          ...evidenceBacked.environment,
          graphcraftSource: {
            commitSha: "a".repeat(40),
            dirty: true,
            dirtyStatusDigest: null,
          },
        },
      }),
    ).toThrow(/status digest/);
    expect(() =>
      BenchmarkReportSchema.parse({
        ...evidenceBacked,
        environment: {
          ...evidenceBacked.environment,
          graphcraftSource: {
            commitSha: "a".repeat(40),
            dirty: true,
            dirtyStatusDigest: "b".repeat(64),
          },
        },
      }),
    ).toThrow(/clean Graphcraft source tree/);

    const oversizedText = "x".repeat(64 * 1024 + 1);
    const oversizedTranscript = {
      mediaType: "application/x-ndjson" as const,
      text: oversizedText,
      observedBytes: Buffer.byteLength(oversizedText),
      retainedBytes: Buffer.byteLength(oversizedText),
      omittedBytes: 0,
      truncated: false,
      digest: contentHash({
        mediaType: "application/x-ndjson",
        text: oversizedText,
        observedBytes: Buffer.byteLength(oversizedText),
        omittedBytes: 0,
        truncated: false,
      }),
    };
    expect(() =>
      BenchmarkReportSchema.parse({
        ...evidenceBacked,
        results: [
          {
            ...result,
            reviewPacket: { ...result.reviewPacket, transcript: oversizedTranscript },
          },
        ],
      }),
    ).toThrow(/retained limit/);

    expect(() =>
      BenchmarkTrialResultSchema.parse({
        ...result,
        accepted: true,
        reviewPacket: {
          ...result.reviewPacket,
          patch: {
            ...result.reviewPacket.patch,
            omittedBytes: 1,
            truncated: true,
            digest: contentHash({
              mediaType: result.reviewPacket.patch.mediaType,
              text: result.reviewPacket.patch.text,
              observedBytes: result.reviewPacket.patch.observedBytes,
              omittedBytes: 1,
              truncated: true,
            }),
          },
        },
      }),
    ).toThrow(/cannot be accepted as review-complete/);

    expect(() =>
      BenchmarkTrialResultSchema.parse({
        ...result,
        accepted: true,
        reviewPacket: {
          ...result.reviewPacket,
          transcript: {
            ...result.reviewPacket.transcript,
            omittedBytes: 1,
            truncated: true,
            digest: contentHash({
              mediaType: result.reviewPacket.transcript.mediaType,
              text: result.reviewPacket.transcript.text,
              observedBytes: result.reviewPacket.transcript.observedBytes,
              omittedBytes: 1,
              truncated: true,
            }),
          },
        },
      }),
    ).toThrow(/truncated transcript evidence cannot be accepted as review-complete/);

    expect(() =>
      BenchmarkTrialResultSchema.parse({
        ...result,
        accepted: true,
        reviewPacket: {
          ...result.reviewPacket,
          captureFailures: ["binary patch payload omitted; review is incomplete"],
        },
      }),
    ).toThrow(/capture failures cannot be accepted as review-complete/);
  });

  it("versions review-packet evidence without accepting alternate digest fallbacks", () => {
    const legacyPatch = reviewEvidence(1, "text/x-diff", "diff --git a/result.js b/result.js\n");
    const legacyTranscript = reviewEvidence(1, "application/x-ndjson", '{"type":"result"}\n');
    const portablePatch = reviewEvidence(2, "text/x-diff", "diff --git a/result.js b/result.js\n");
    const portableTranscript = reviewEvidence(2, "application/x-ndjson", '{"type":"result"}\n');
    const legacyPacket = {
      schemaVersion: 1 as const,
      patch: legacyPatch,
      transcript: legacyTranscript,
      captureFailures: [],
    };
    const portablePacket = {
      schemaVersion: 2 as const,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      patch: portablePatch,
      transcript: portableTranscript,
      captureFailures: [],
    };

    expect(legacyPatch.digest).toBe(
      "359dba22ad09afd749caa2b5ea13796414c365e2be292f33d122a9f9943f0d8b",
    );
    expect(portablePatch.digest).not.toBe(legacyPatch.digest);
    expect(BenchmarkReviewPacketV1Schema.parse(legacyPacket)).toEqual(legacyPacket);
    expect(BenchmarkReviewPacketV2Schema.parse(portablePacket)).toEqual(portablePacket);
    expect(BenchmarkReviewPacketSchema.parse(legacyPacket)).toEqual(legacyPacket);
    expect(BenchmarkReviewPacketSchema.parse(portablePacket)).toEqual(portablePacket);
    expect(() =>
      BenchmarkReviewPacketV2Schema.parse({
        ...portablePacket,
        patch: { ...portablePatch, digest: legacyPatch.digest },
      }),
    ).toThrow(/digest does not match/);
    expect(() =>
      BenchmarkReviewPacketV1Schema.parse({
        ...legacyPacket,
        patch: { ...legacyPatch, digest: portablePatch.digest },
      }),
    ).toThrow(/digest does not match/);
    expect(() => benchmarkReviewEvidenceDigest(legacyPatch, 3 as never)).toThrow(
      /unsupported benchmark review packet schema version/i,
    );
  });

  it("accepts only self-identified portable v4 reports and refuses legacy relabelling", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "portable-report-seed",
      identity: portableReportIdentity,
    });
    const reviewPacket = BenchmarkReviewPacketV2Schema.parse({
      schemaVersion: 2,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      patch: reviewEvidence(2, "text/x-diff", "diff --git a/result.js b/result.js\n"),
      transcript: reviewEvidence(2, "application/x-ndjson", '{"type":"result"}\n'),
      captureFailures: [],
    });
    expect(() =>
      BenchmarkTrialResultV4Schema.parse({
        ...reportedTrial(schedule[0]!, 100),
        reviewPacket: {
          schemaVersion: 1,
          patch: reviewEvidence(1, "text/x-diff", "diff --git a/result.js b/result.js\n"),
          transcript: reviewEvidence(1, "application/x-ndjson", '{"type":"result"}\n'),
          captureFailures: [],
        },
      }),
    ).toThrow();
    const result = BenchmarkTrialResultV4Schema.parse({
      ...reportedTrial(schedule[0]!, 100),
      reviewPacket,
    });
    expect(() => summarizeBenchmark([result], schedule)).toThrow();
    const report = {
      schemaVersion: 4 as const,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      status: "running" as const,
      suite: {
        id: suite.id,
        version: suite.version,
        digest: contentHash(suite, PORTABLE_CANONICAL_HASH_ALGORITHM),
      },
      startedAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
      seed: "portable-report-seed",
      randomized: true as const,
      modelPolicy: { codex: "gpt-benchmark-fixture" },
      effortPolicy: "high" as const,
      permissionPolicy: {
        codex: "codex_workspace_write_shell_external_not_graphcraft_enforced" as const,
      },
      scorerPolicy: "fixture_bound_scorers_plus_suite_assertions" as const,
      reviewPolicy: "bounded_redacted_patch_and_transcript_v2" as const,
      modelCallTimeoutMs: 15 * 60_000,
      environment: {
        platform: "fixture",
        architecture: "fixture",
        nodeVersion: "fixture",
        graphcraftVersion: "0.1.2-fixture",
        graphcraftSource: {
          commitSha: "a".repeat(40),
          dirty: false,
          dirtyStatusDigest: null,
        },
      },
      limitations: [],
      schedule,
      results: [result],
      summary: summarizeBenchmark([result], schedule, portableReportIdentity),
    };

    expect(BenchmarkReportV4Schema.parse(report)).toEqual(report);
    expect(BenchmarkReportSchema.parse(report)).toEqual(report);

    const legacySchedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: report.seed,
      identity: legacyReportIdentity,
    });
    expect(() =>
      BenchmarkReportV4Schema.parse({
        ...report,
        schedule: legacySchedule,
        results: [],
        summary: summarizeBenchmark([], legacySchedule, portableReportIdentity),
      }),
    ).toThrow(/trial ID does not match the declared report identity/);
    expect(() =>
      BenchmarkReportV4Schema.parse({
        ...report,
        hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM,
      }),
    ).toThrow();
    const { graphcraftSource: _graphcraftSource, ...identitylessEnvironment } = report.environment;
    expect(() =>
      BenchmarkReportV4Schema.parse({ ...report, environment: identitylessEnvironment }),
    ).toThrow(/graphcraftSource/);
  });

  it("keeps unsuccessful and unreconciled trials visible and refuses an incomplete gate", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "summary-seed",
      repetitions: 1,
    });
    const result = (
      mode: "baseline" | "graphcraft",
      accepted: boolean,
      reconciled: boolean,
    ): BenchmarkTrialResult => {
      const trial = schedule.find((entry) => entry.mode === mode)!;
      return BenchmarkTrialResultSchema.parse({
        trial,
        hostVersion: "fixture",
        modelPolicy: "gpt-benchmark-fixture",
        effortPolicy: "high",
        permissionPolicy: "codex_workspace_write_shell_external_not_graphcraft_enforced",
        acceptanceScorerDigest: "fixture-scorer",
        observedScorerDigest: "fixture-scorer",
        scorerVerified: true,
        repositoryDigest: "same-fixture",
        baseSha: "same-base-sha",
        executionStatus: accepted ? "completed" : "failed",
        attemptCheckpoint: "settled",
        accepted,
        acceptance: [{ path: "result.js", passed: accepted, summary: "fixture score" }],
        usage: unavailableTokenUsage(),
        usageReconciled: reconciled,
        limitations: reconciled ? [] : ["total:unavailable"],
        durationMs: 1,
        humanInterventions: 0,
        failureTrace: accepted ? [] : ["held-out scorer failed"],
      });
    };

    const summary = summarizeBenchmark(
      [result("baseline", true, true), result("graphcraft", false, false)],
      schedule,
    );

    expect(summary.codex).toMatchObject({
      graphcraft: { trials: 1, accepted: 0, unsuccessful: 1, reconciledTokenTrials: 0 },
      gate: { completeSchedule: true, matchedControls: true, comparable: false, passes: null },
    });

    const mismatched = summarizeBenchmark(
      [
        result("baseline", true, true),
        { ...result("graphcraft", true, true), acceptanceScorerDigest: "different-scorer" },
      ],
      schedule,
    );
    expect(mismatched.codex).toMatchObject({
      gate: { completeSchedule: true, matchedControls: false, comparable: false, passes: null },
    });

    const partial = summarizeBenchmark([result("baseline", true, true)], schedule);
    expect(partial.codex).toMatchObject({
      gate: { completeSchedule: false, comparable: false, passes: null },
    });
  });

  it("refuses token comparisons across disjoint accepted trial pairs", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "disjoint-seed",
    });
    const results = schedule.map((trial) => {
      const accepted =
        (trial.mode === "baseline" && trial.repetition === 1) ||
        (trial.mode === "graphcraft" && trial.repetition === 2);
      return BenchmarkTrialResultSchema.parse({
        trial,
        hostVersion: "fixture",
        modelPolicy: "gpt-benchmark-fixture",
        effortPolicy: "high",
        permissionPolicy: "codex_workspace_write_shell_external_not_graphcraft_enforced",
        acceptanceScorerDigest: "fixture-scorer",
        observedScorerDigest: "fixture-scorer",
        scorerVerified: true,
        repositoryDigest: "same-fixture",
        baseSha: "same-base-sha",
        executionStatus: accepted ? "completed" : "failed",
        attemptCheckpoint: "settled",
        accepted,
        acceptance: [{ path: "result.js", passed: accepted, summary: "fixture score" }],
        usage: {
          input: 90,
          cachedInput: 0,
          uncachedInput: 90,
          output: 10,
          reasoning: 0,
          total: 100,
          availability: {
            input: "reported",
            cachedInput: "reported",
            uncachedInput: "derived",
            output: "reported",
            reasoning: "unavailable",
            total: "derived",
          },
        },
        usageReconciled: true,
        limitations: ["reasoning:unavailable"],
        durationMs: 1,
        humanInterventions: 0,
        failureTrace: accepted ? [] : ["held-out scorer failed"],
      });
    });

    expect(summarizeBenchmark(results, schedule).codex).toMatchObject({
      baseline: { accepted: 1 },
      graphcraft: { accepted: 1 },
      matchedAccepted: { pairs: 0, completeTaskCoverage: false },
      gate: { matchedControls: true, comparable: false, passes: null },
    });
  });

  it("requires three jointly accepted pairs per task before evaluating the stable gate", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "minimum-pairs-seed",
      repetitions: 3,
    });
    const results = schedule.map((trial) => {
      const accepted = trial.repetition <= 2;
      const total = trial.mode === "baseline" ? 100 : 70;
      return BenchmarkTrialResultSchema.parse({
        trial,
        hostVersion: "fixture",
        modelPolicy: "gpt-benchmark-fixture",
        effortPolicy: "high",
        permissionPolicy: "codex_workspace_write_shell_external_not_graphcraft_enforced",
        acceptanceScorerDigest: "fixture-scorer",
        observedScorerDigest: "fixture-scorer",
        scorerVerified: true,
        repositoryDigest: "same-fixture",
        baseSha: "same-base-sha",
        executionStatus: accepted ? "completed" : "failed",
        attemptCheckpoint: "settled",
        accepted,
        acceptance: [{ path: "result.js", passed: accepted, summary: "fixture score" }],
        usage: {
          input: total - 10,
          cachedInput: 0,
          uncachedInput: total - 10,
          output: 10,
          reasoning: 0,
          total,
          availability: {
            input: "reported",
            cachedInput: "reported",
            uncachedInput: "derived",
            output: "reported",
            reasoning: "unavailable",
            total: "derived",
          },
        },
        usageReconciled: true,
        limitations: ["reasoning:unavailable"],
        durationMs: 1,
        humanInterventions: 0,
        failureTrace: accepted ? [] : ["held-out scorer failed"],
      });
    });

    expect(summarizeBenchmark(results, schedule).codex).toMatchObject({
      matchedAccepted: {
        pairs: 2,
        minimumPairsPerTask: 3,
        completeTaskCoverage: false,
      },
      gate: { completeSchedule: true, matchedControls: true, comparable: false, passes: null },
    });

    const threeAcceptedPairs = results.map((result) =>
      result.trial.repetition === 3
        ? BenchmarkTrialResultSchema.parse({
            ...result,
            executionStatus: "completed",
            accepted: true,
            acceptance: [{ path: "result.js", passed: true, summary: "fixture score" }],
            failureTrace: [],
          })
        : result,
    );
    expect(summarizeBenchmark(threeAcceptedPairs, schedule).codex).toMatchObject({
      matchedAccepted: {
        pairs: 3,
        minimumPairsPerTask: 3,
        completeTaskCoverage: true,
      },
      gate: { completeSchedule: true, matchedControls: true, comparable: true, passes: true },
    });
  });

  it("uses matched per-repetition reductions instead of a ratio of independent medians", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "paired-statistic-seed",
      repetitions: 4,
    });
    const baseline = [1, 2, 1_000, 2_000];
    const graphcraft = [1, 2, 100, 2_000];
    const results = schedule.map((trial) =>
      reportedTrial(
        trial,
        (trial.mode === "baseline" ? baseline : graphcraft)[trial.repetition - 1]!,
      ),
    );

    expect(summarizeBenchmark(results, schedule).codex).toMatchObject({
      matchedAccepted: {
        aggregation: "median_pair_reduction_within_task_then_median_across_tasks",
        zeroBaselinePairs: 0,
        medianTokenReductionPercent: 0,
        byTask: {
          "feature-one": {
            pairs: 4,
            zeroBaselinePairs: 0,
            medianPairReductionPercent: 0,
          },
        },
      },
      gate: { comparable: true, tokenReductionPercent: 0, passes: false },
    });
  });

  it("weights each task median once even when tasks have different accepted pair counts", () => {
    const fixtureTask = suite.tasks[0]!;
    const corpusSuite = BenchmarkSuiteSchema.parse({
      ...suite,
      id: "corpus-aggregation-suite",
      tasks: [
        { ...fixtureTask, id: "task-low", task: "Low reduction task", repetitions: 6 },
        { ...fixtureTask, id: "task-middle", task: "Middle reduction task", repetitions: 6 },
        { ...fixtureTask, id: "task-high", task: "High reduction task", repetitions: 6 },
      ],
    });
    const schedule = createBenchmarkSchedule({
      suite: corpusSuite,
      hosts: ["codex"],
      seed: "corpus-aggregation-seed",
    });
    const results = schedule.map((trial) => {
      const acceptedPairs = trial.taskId === "task-high" ? 6 : 3;
      const graphcraftTotal =
        trial.taskId === "task-low" ? 100 : trial.taskId === "task-middle" ? 50 : 0;
      return reportedTrial(
        trial,
        trial.mode === "baseline" ? 100 : graphcraftTotal,
        trial.repetition <= acceptedPairs,
      );
    });

    expect(summarizeBenchmark(results, schedule).codex).toMatchObject({
      matchedAccepted: {
        aggregation: "median_pair_reduction_within_task_then_median_across_tasks",
        pairs: 12,
        medianTokenReductionPercent: 50,
        byTask: {
          "task-low": { pairs: 3, medianPairReductionPercent: 0 },
          "task-middle": { pairs: 3, medianPairReductionPercent: 50 },
          "task-high": { pairs: 6, medianPairReductionPercent: 100 },
        },
      },
      gate: { comparable: true, tokenReductionPercent: 50, passes: true },
    });
  });

  it("refuses a percentage comparison when an accepted pair has a zero-token baseline", () => {
    const schedule = createBenchmarkSchedule({
      suite,
      hosts: ["codex"],
      seed: "zero-baseline-seed",
      repetitions: 3,
    });
    const baseline = [0, 100, 100];
    const graphcraft = [1, 80, 80];
    const results = schedule.map((trial) =>
      reportedTrial(
        trial,
        (trial.mode === "baseline" ? baseline : graphcraft)[trial.repetition - 1]!,
      ),
    );

    expect(summarizeBenchmark(results, schedule).codex).toMatchObject({
      matchedAccepted: {
        pairs: 3,
        zeroBaselinePairs: 1,
        completeTaskCoverage: true,
        medianTokenReductionPercent: 20,
        byTask: {
          "feature-one": { zeroBaselinePairs: 1, medianPairReductionPercent: 20 },
        },
      },
      gate: {
        completeSchedule: true,
        comparable: false,
        tokenReductionPercent: null,
        passes: null,
      },
    });
  });
});
