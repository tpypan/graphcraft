import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  BenchmarkBlindedReviewExportV2Schema,
  BenchmarkReportV3Schema,
  BenchmarkReportV4Schema,
  BenchmarkReviewLabelsSchema,
  BenchmarkReviewLabelsV2Schema,
  BenchmarkSuiteSchema,
  BenchmarkTrialResultSchema,
  BenchmarkTrialResultV4Schema,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  benchmarkBlindingKeyDigest,
  benchmarkReviewEvidenceDigest,
  benchmarkReviewOpaqueId,
  benchmarkReviewOpaqueIdV2,
  contentHash,
  createBenchmarkSchedule,
  summarizeBenchmark,
  type BenchmarkBlindedReviewExportV1,
  type BenchmarkBlindedReviewExportV2,
  type BenchmarkReportV3,
  type BenchmarkReportV4,
  type BenchmarkReviewLabels,
  type BenchmarkReviewLabelsV1,
  type BenchmarkReviewLabelsV2,
  type BenchmarkScheduleEntry,
  type BenchmarkSuite,
} from "@graphcraft/core";
import {
  BENCHMARK_BLINDING_KEY_STDIN_MAX_BYTES,
  BENCHMARK_PUBLICATION_LABELS_MAX_BYTES,
  BENCHMARK_PUBLICATION_REPORT_MAX_BYTES,
  createBlindedBenchmarkReview,
  exactMedianInterval,
  exportBlindedBenchmarkReview,
  loadBenchmarkReportForPublication,
  loadBenchmarkReportForPublicationV4,
  loadBenchmarkReviewLabels,
  loadBenchmarkReviewLabelsV2,
  loadVersionedBenchmarkReportForPublication,
  loadVersionedBenchmarkReviewLabels,
  parseBenchmarkBlindingKeyInput,
  readBenchmarkBlindingKeyFromStdin,
  renderBenchmarkPublicationMarkdown,
  renderBenchmarkPublicationReport,
  validateBenchmarkReviewLabels,
  wilsonScoreInterval,
} from "./benchmark-publication.ts";
import {
  assertBenchmarkReportEvidence,
  BENCHMARK_REPORT_LIMITATIONS,
  expectedBenchmarkScorerDigest,
} from "./benchmark-validation.ts";

const roots: string[] = [];
const blindingKeyHex = "9f".repeat(32);
const blindingKey = Buffer.from(blindingKeyHex, "hex");
const alternateBlindingKey = Buffer.from("a7".repeat(32), "hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const suite: BenchmarkSuite = BenchmarkSuiteSchema.parse({
  schemaVersion: 2,
  id: "publication-fixture",
  version: 1,
  description: "Benchmark publication fixture",
  tasks: [
    {
      id: "feature-one",
      family: "feature",
      task: "Implement the fixture feature",
      initialFiles: { "package.json": "{}\n", "score.mjs": "\n" },
      checks: [{ command: "node", scorerPath: "score.mjs" }],
      acceptance: [{ kind: "exists", path: "result.js" }],
      repetitions: 3,
    },
  ],
});

function reviewEvidence(
  mediaType: "text/x-diff" | "application/x-ndjson",
  text: string,
  packetSchemaVersion: 1 | 2 = 1,
) {
  const observedBytes = Buffer.byteLength(text);
  const identity = { mediaType, text, observedBytes, omittedBytes: 0, truncated: false };
  return {
    ...identity,
    retainedBytes: observedBytes,
    digest: benchmarkReviewEvidenceDigest(identity, packetSchemaVersion),
  };
}

function transcript(trial: BenchmarkScheduleEntry, modelPolicy: string): string {
  return [
    JSON.stringify({
      source: "graphcraft_run_event",
      event: { type: "node.started", text: "control-secret" },
    }),
    JSON.stringify({
      source: `${trial.mode}_host_event`,
      event: { type: "session_started", session_id: "session-secret-123" },
    }),
    JSON.stringify({
      source: `${trial.mode}_host_event`,
      event: { type: "token_usage", model: "gpt-secret-model", total: 98_765 },
    }),
    JSON.stringify({
      source: `${trial.mode}_host_event`,
      event: {
        type: "message",
        host: trial.host,
        mode: trial.mode,
        model_name: modelPolicy,
        provider: "write",
        host_session_id: "session-secret-123",
        uuid: "123e4567-e89b-12d3-a456-426614174000",
        usage: { total: 98_765 },
        text: "retained-evidence",
      },
    }),
    JSON.stringify({
      source: `${trial.mode}_host_event`,
      event: {
        type: "tool",
        name: trial.host === "codex" ? "exec_command" : "Bash",
        summary: "retained-tool-summary REVIEW EVIDENCE MIDDLE OMITTED",
        thread_id: "native-thread-secret",
        cwd: "/private/native-cwd-secret",
      },
    }),
    JSON.stringify({
      source: `${trial.mode}_host_event`,
      event: {
        type: "result",
        result: {
          status: "completed",
          summary: "retained-result-summary",
          evidence: ["retained-result-evidence"],
          changedPaths: ["native-cwd-secret/result.js"],
          nextSuggestedObjective: "native-next-secret",
        },
        thread_id: "native-thread-secret",
      },
    }),
    JSON.stringify({
      source: `${trial.mode}_host_event`,
      event: {
        type: "item.completed",
        thread_id: "native-thread-secret",
        item: { type: "assistant", content: "native-item-secret" },
        version: "native-version-secret",
      },
    }),
    JSON.stringify({
      source: `${trial.mode}_host_event`,
      event: {
        type: "assistant",
        content: "native-assistant-secret",
        cwd: "/private/native-cwd-secret",
      },
    }),
    JSON.stringify({
      type: "result",
      result: { thread_id: "native-thread-secret", content: "native-top-level-secret" },
    }),
    "native-unstructured-fragment-secret",
    "",
  ].join("\n");
}

function reportFixture(
  options: {
    graphcraftTokens?: number;
    host?: "codex" | "claude";
    modelPolicy?: string;
    unsuccessfulTrialId?: string;
  } = {},
): BenchmarkReportV3 {
  const task = suite.tasks[0]!;
  const scorerDigest = expectedBenchmarkScorerDigest(task);
  const host = options.host ?? "codex";
  const modelPolicy = options.modelPolicy ?? "gpt-secret-model";
  const permissionPolicy =
    host === "codex"
      ? "codex_workspace_write_shell_external_not_graphcraft_enforced"
      : "claude_accept_edits_bash_external_not_graphcraft_enforced";
  const schedule = createBenchmarkSchedule({
    suite,
    hosts: [host],
    repetitions: 3,
    seed: "publication-seed",
  });
  const results = schedule.map((trial) => {
    const accepted = trial.trialId !== options.unsuccessfulTrialId;
    const total = trial.mode === "baseline" ? 100 : (options.graphcraftTokens ?? 70);
    return BenchmarkTrialResultSchema.parse({
      trial,
      hostVersion: host === "codex" ? "codex-cli-secret-0.144.6" : "claude-code-secret-2.1.212",
      modelPolicy,
      effortPolicy: "high",
      permissionPolicy,
      acceptanceScorerDigest: scorerDigest,
      observedScorerDigest: scorerDigest,
      scorerVerified: true,
      repositoryDigest: contentHash(task.initialFiles),
      baseSha: "base-sha-secret",
      executionStatus: accepted ? "completed" : "failed",
      attemptCheckpoint: "settled",
      accepted,
      acceptance: [
        { path: "$check:1", passed: true, summary: "deterministic scorer passed" },
        { path: "result.js", passed: accepted, summary: "deterministic assertion" },
      ],
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
          reasoning: "reported",
          total: "derived",
        },
      },
      usageReconciled: true,
      limitations: [],
      durationMs: trial.repetition * 1_000,
      humanInterventions: trial.repetition === 1 ? 1 : 0,
      failureTrace: accepted ? [] : ["held-out scorer failed"],
      reviewPacket: {
        schemaVersion: 1,
        patch: reviewEvidence(
          "text/x-diff",
          [
            "diff --git a/result.js b/result.js",
            "+host_session_id: session-secret-123",
            `+model_policy: ${modelPolicy}`,
            `+mode: ${trial.mode}`,
            '+const mode = "safe";',
            '+const model = "domain";',
            "+const tokens = 42;",
            '+const source = "application";',
            '+const provider = "service";',
            '+const overwrite = "write a value";',
            "+const fixed = true;",
            "",
          ].join("\n"),
        ),
        transcript: reviewEvidence("application/x-ndjson", transcript(trial, modelPolicy)),
        captureFailures: [],
      },
    });
  });
  return BenchmarkReportV3Schema.parse({
    schemaVersion: 3,
    status: "complete",
    suite: { id: suite.id, version: suite.version, digest: contentHash(suite) },
    startedAt: "2026-07-23T12:00:00.000Z",
    updatedAt: "2026-07-23T13:00:00.000Z",
    seed: "publication-seed",
    randomized: true,
    modelPolicy: { [host]: modelPolicy },
    effortPolicy: "high",
    permissionPolicy: { [host]: permissionPolicy },
    scorerPolicy: "fixture_bound_scorers_plus_suite_assertions",
    reviewPolicy: "bounded_redacted_patch_and_transcript_v1",
    modelCallTimeoutMs: 900_000,
    environment: {
      platform: "fixture-platform",
      architecture: "fixture-architecture",
      nodeVersion: "v24-fixture",
      graphcraftVersion: "0.1.2-fixture",
      graphcraftSource: { commitSha: "a".repeat(40), dirty: false, dirtyStatusDigest: null },
    },
    limitations: [...BENCHMARK_REPORT_LIMITATIONS],
    schedule,
    results,
    summary: summarizeBenchmark(results, schedule),
  });
}

function portableReportFixture(
  options: {
    graphcraftTokens?: number;
    host?: "codex" | "claude";
    modelPolicy?: string;
    unsuccessfulTrialId?: string;
  } = {},
): BenchmarkReportV4 {
  const legacy = reportFixture(options);
  const identity = {
    schemaVersion: 4 as const,
    hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
  };
  const schedule = createBenchmarkSchedule({
    suite,
    hosts: [options.host ?? "codex"],
    repetitions: 3,
    seed: "publication-seed",
    identity,
  });
  const sourceByOrder = new Map(legacy.results.map((result) => [result.trial.order, result]));
  const task = suite.tasks[0]!;
  const scorerDigest = expectedBenchmarkScorerDigest(task, PORTABLE_CANONICAL_HASH_ALGORITHM);
  const results = schedule.map((trial) => {
    const source = sourceByOrder.get(trial.order)!;
    const sourcePacket = source.reviewPacket!;
    return BenchmarkTrialResultV4Schema.parse({
      ...source,
      trial,
      acceptanceScorerDigest: scorerDigest,
      observedScorerDigest: scorerDigest,
      repositoryDigest: contentHash(task.initialFiles, PORTABLE_CANONICAL_HASH_ALGORITHM),
      reviewPacket: {
        schemaVersion: 2,
        hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
        patch: {
          ...sourcePacket.patch,
          digest: benchmarkReviewEvidenceDigest(sourcePacket.patch, 2),
        },
        transcript: {
          ...sourcePacket.transcript,
          digest: benchmarkReviewEvidenceDigest(sourcePacket.transcript, 2),
        },
        captureFailures: sourcePacket.captureFailures,
      },
    });
  });
  return BenchmarkReportV4Schema.parse({
    ...legacy,
    schemaVersion: 4,
    hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
    suite: {
      id: suite.id,
      version: suite.version,
      digest: contentHash(suite, PORTABLE_CANONICAL_HASH_ALGORITHM),
    },
    reviewPolicy: "bounded_redacted_patch_and_transcript_v2",
    schedule,
    results,
    summary: summarizeBenchmark(results, schedule, identity),
  });
}

function reviewLabels(
  report: BenchmarkReportV3,
  rawReportSha256: string,
  critical = false,
  key: Uint8Array = blindingKey,
): BenchmarkReviewLabels {
  const blinded = createBlindedBenchmarkReview({
    report,
    rawReportSha256,
    suite,
    blindingKey: key,
  });
  return BenchmarkReviewLabelsSchema.parse({
    schemaVersion: 1,
    reviewPolicy: "opaque_blinded_review_v1",
    taxonomyVersion: 1,
    rawReportSha256,
    blindingKeyDigest: benchmarkBlindingKeyDigest(key),
    blindedReviewDigest: contentHash(blinded),
    labels: blinded.packets.map((packet, index) => ({
      opaqueId: packet.opaqueId,
      packetDigest: contentHash(packet),
      reviewed: true,
      reviewerId: index % 2 === 0 ? "reviewer-a" : "reviewer-b",
      verdict: critical && index === 0 ? "defect" : "no_defect",
      defects:
        critical && index === 0
          ? [
              {
                category: "correctness",
                severity: "critical",
                summary: "The retained implementation is incorrect",
              },
            ]
          : [],
    })),
  });
}

function portableReviewLabels(
  report: BenchmarkReportV4,
  rawReportSha256: string,
  critical = false,
  key: Uint8Array = blindingKey,
): BenchmarkReviewLabelsV2 {
  const blinded = createBlindedBenchmarkReview({
    report,
    rawReportSha256,
    suite,
    blindingKey: key,
  });
  return BenchmarkReviewLabelsV2Schema.parse({
    schemaVersion: 2,
    hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
    reviewPolicy: "opaque_blinded_review_v2",
    taxonomyVersion: 1,
    rawReportSha256,
    blindingKeyDigest: benchmarkBlindingKeyDigest(key),
    blindedReviewDigest: contentHash(blinded, PORTABLE_CANONICAL_HASH_ALGORITHM),
    labels: blinded.packets.map((packet, index) => ({
      opaqueId: packet.opaqueId,
      packetDigest: contentHash(packet, PORTABLE_CANONICAL_HASH_ALGORITHM),
      reviewed: true,
      reviewerId: index % 2 === 0 ? "reviewer-a" : "reviewer-b",
      verdict: critical && index === 0 ? "defect" : "no_defect",
      defects:
        critical && index === 0
          ? [
              {
                category: "correctness",
                severity: "critical",
                summary: "The retained implementation is incorrect",
              },
            ]
          : [],
    })),
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function alternateLocaleLegacyContentHash(value: unknown): string {
  const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
    this: string,
    other: string,
  ) {
    const left = String(this);
    return left < other ? 1 : left > other ? -1 : 0;
  });
  try {
    return contentHash(value);
  } finally {
    localeCompare.mockRestore();
  }
}

describe("benchmark blinded review", () => {
  it("preserves legacy utility types while narrowing direct v1 and v2 overloads", () => {
    expectTypeOf<
      Parameters<typeof createBlindedBenchmarkReview>[0]["report"]
    >().toEqualTypeOf<BenchmarkReportV3>();
    expectTypeOf<
      ReturnType<typeof createBlindedBenchmarkReview>
    >().toEqualTypeOf<BenchmarkBlindedReviewExportV1>();
    expectTypeOf<
      Parameters<typeof validateBenchmarkReviewLabels>[0]["report"]
    >().toEqualTypeOf<BenchmarkReportV3>();
    expectTypeOf<
      Parameters<typeof validateBenchmarkReviewLabels>[0]["labels"]
    >().toEqualTypeOf<BenchmarkReviewLabelsV1>();
    expectTypeOf<
      ReturnType<typeof validateBenchmarkReviewLabels>["blindedReview"]
    >().toEqualTypeOf<BenchmarkBlindedReviewExportV1>();
    expectTypeOf<
      Parameters<typeof renderBenchmarkPublicationMarkdown>[0]["report"]
    >().toEqualTypeOf<BenchmarkReportV3>();
    expectTypeOf<
      Parameters<typeof renderBenchmarkPublicationMarkdown>[0]["labels"]
    >().toEqualTypeOf<BenchmarkReviewLabelsV1>();

    if (false) {
      const legacyReport = reportFixture();
      const portableReport = portableReportFixture();
      const rawReportSha256 = "1".repeat(64);
      const legacyLabels = reviewLabels(legacyReport, rawReportSha256);
      const portableLabels = portableReviewLabels(portableReport, rawReportSha256);
      const legacyExport: BenchmarkBlindedReviewExportV1 = createBlindedBenchmarkReview({
        report: legacyReport,
        rawReportSha256,
        suite,
        blindingKey,
      });
      const portableExport: BenchmarkBlindedReviewExportV2 = createBlindedBenchmarkReview({
        report: portableReport,
        rawReportSha256,
        suite,
        blindingKey,
      });
      const legacyValidated = validateBenchmarkReviewLabels({
        report: legacyReport,
        rawReportSha256,
        suite,
        labels: legacyLabels,
        blindingKey,
      });
      const portableValidated = validateBenchmarkReviewLabels({
        report: portableReport,
        rawReportSha256,
        suite,
        labels: portableLabels,
        blindingKey,
      });
      expectTypeOf(legacyExport).toEqualTypeOf<BenchmarkBlindedReviewExportV1>();
      expectTypeOf(portableExport).toEqualTypeOf<BenchmarkBlindedReviewExportV2>();
      expectTypeOf(legacyValidated.blindedReview).toEqualTypeOf<BenchmarkBlindedReviewExportV1>();
      expectTypeOf(portableValidated.blindedReview).toEqualTypeOf<BenchmarkBlindedReviewExportV2>();

      validateBenchmarkReviewLabels({
        // @ts-expect-error schema-4 reports require schema-2 review labels
        report: portableReport,
        rawReportSha256,
        suite,
        labels: legacyLabels,
        blindingKey,
      });
      validateBenchmarkReviewLabels({
        report: legacyReport,
        rawReportSha256,
        suite,
        // @ts-expect-error schema-3 reports require schema-1 review labels
        labels: portableLabels,
        blindingKey,
      });
    }
  });

  it("is deterministic and removes explicit host, mode, model, session, usage, and control metadata", () => {
    const report = reportFixture();
    const rawReportSha256 = "b".repeat(64);
    const first = createBlindedBenchmarkReview({
      report,
      rawReportSha256,
      suite,
      blindingKey,
    });
    const second = createBlindedBenchmarkReview({
      report,
      rawReportSha256,
      suite,
      blindingKey,
    });

    expect(second).toEqual(first);
    expect(contentHash(first)).toBe(
      "3689a7fbef6387b5962cbac8cad7b8aba603ea512191807e600b94fef1a19836",
    );
    expect(first.packets.map(({ opaqueId }) => opaqueId)).toEqual(
      [...first.packets.map(({ opaqueId }) => opaqueId)].sort(),
    );
    const serialized = JSON.stringify(first);
    for (const secret of [
      "codex-cli-secret-0.144.6",
      "gpt-secret-model",
      "session-secret-123",
      "repository-secret",
      "base-sha-secret",
      "control-secret",
      "98765",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('"host_session_id"');
    expect(serialized).not.toContain('"model_name"');
    expect(serialized).not.toContain('"usage"');
    expect(serialized).toContain("retained-evidence");
    expect(serialized).toContain("retained-tool-summary");
    expect(serialized).toContain("REVIEW EVIDENCE MIDDLE OMITTED");
    expect(serialized).toContain("retained-result-summary");
    expect(serialized).toContain("retained-result-evidence");
    expect(serialized).toContain("const fixed = true");
    expect(serialized).toContain('const mode = \\"safe\\";');
    expect(serialized).toContain('const model = \\"domain\\";');
    expect(serialized).toContain("const tokens = 42;");
    expect(serialized).toContain('const source = \\"application\\";');
    expect(serialized).toContain('const provider = \\"service\\";');
    expect(serialized).toContain('const overwrite = \\"write a value\\";');
    const projectedTranscripts = first.packets.map(
      ({ reviewPacket }) => reviewPacket.transcript.text,
    );
    expect(projectedTranscripts.every((text) => text.includes('"name":"agent_tool"'))).toBe(true);
    expect(projectedTranscripts.every((text) => !text.includes('"name":"exec_command"'))).toBe(
      true,
    );
    expect(projectedTranscripts.every((text) => !text.includes('"name":"Bash"'))).toBe(true);
    expect(serialized).not.toContain(blindingKeyHex);
    for (const nativeValue of [
      "item.completed",
      "native-thread-secret",
      "native-cwd-secret",
      "native-version-secret",
      "native-item-secret",
      "native-assistant-secret",
      "native-top-level-secret",
      "native-unstructured-fragment-secret",
      "native-next-secret",
      "123e4567-e89b-12d3-a456-426614174000",
    ])
      expect(serialized).not.toContain(nativeValue);

    const alternate = createBlindedBenchmarkReview({
      report,
      rawReportSha256,
      suite,
      blindingKey: alternateBlindingKey,
    });
    expect(alternate.packets.map(({ opaqueId }) => opaqueId)).not.toEqual(
      first.packets.map(({ opaqueId }) => opaqueId),
    );
    const publiclyReconstructibleOldIds = new Set(
      report.results.map(
        ({ trial }) =>
          `packet-${contentHash({
            namespace: "graphcraft-benchmark-review-v1",
            rawReportSha256,
            trialId: trial.trialId,
          }).slice(0, 32)}`,
      ),
    );
    expect(
      first.packets.every(({ opaqueId }) => !publiclyReconstructibleOldIds.has(opaqueId)),
    ).toBe(true);
  });

  it("emits portable v2 packets with redigested evidence and locale-independent identities", () => {
    const report = portableReportFixture();
    const rawReportSha256 = "4".repeat(64);
    const first = createBlindedBenchmarkReview({ report, rawReportSha256, suite, blindingKey });

    expect(first).toMatchObject({
      schemaVersion: 2,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      reviewPolicy: "opaque_blinded_review_v2",
      rawReportSha256,
      blindingKeyDigest: benchmarkBlindingKeyDigest(blindingKey),
    });
    for (const result of report.results) {
      const opaqueId = benchmarkReviewOpaqueIdV2(
        rawReportSha256,
        result.trial.trialId,
        blindingKey,
      );
      const packet = first.packets.find((candidate) => candidate.opaqueId === opaqueId)!;
      expect(packet).toMatchObject({
        schemaVersion: 2,
        hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
        reviewPacket: {
          schemaVersion: 2,
          hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
        },
      });
      expect(packet.reviewPacket.patch.digest).toBe(
        benchmarkReviewEvidenceDigest(packet.reviewPacket.patch, 2),
      );
      expect(packet.reviewPacket.transcript.digest).toBe(
        benchmarkReviewEvidenceDigest(packet.reviewPacket.transcript, 2),
      );
      expect(packet.reviewPacket.patch.digest).not.toBe(result.reviewPacket.patch.digest);
      expect(opaqueId).not.toBe(
        benchmarkReviewOpaqueId(rawReportSha256, result.trial.trialId, blindingKey),
      );
    }

    const digest = contentHash(first, PORTABLE_CANONICAL_HASH_ALGORITHM);
    expect(digest).toBe("763b22042f3af171d97ac0b29fd34ca7a085fce1b756faa17d140b3b2bf9c108");
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("portable publication used ambient locale ordering");
    });
    try {
      const second = createBlindedBenchmarkReview({ report, rawReportSha256, suite, blindingKey });
      expect(second).toEqual(first);
      expect(contentHash(second, PORTABLE_CANONICAL_HASH_ALGORITHM)).toBe(digest);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it("projects host-specific tool vocabularies to the same review evidence", () => {
    const codex = createBlindedBenchmarkReview({
      report: reportFixture({ host: "codex" }),
      rawReportSha256: "6".repeat(64),
      suite,
      blindingKey,
    });
    const claude = createBlindedBenchmarkReview({
      report: reportFixture({ host: "claude" }),
      rawReportSha256: "6".repeat(64),
      suite,
      blindingKey,
    });
    const codexTranscripts = new Set(
      codex.packets.map(({ reviewPacket }) => reviewPacket.transcript.text),
    );
    const claudeTranscripts = new Set(
      claude.packets.map(({ reviewPacket }) => reviewPacket.transcript.text),
    );
    expect(codexTranscripts.size).toBe(1);
    expect(claudeTranscripts).toEqual(codexTranscripts);
  });

  it("blinds a short explicit model identity without replacing substrings", () => {
    const blinded = createBlindedBenchmarkReview({
      report: reportFixture({ modelPolicy: "o3" }),
      rawReportSha256: "5".repeat(64),
      suite,
      blindingKey,
    });
    const serialized = JSON.stringify(blinded);
    expect(serialized).not.toMatch(/(^|[^A-Za-z0-9_.@-])o3([^A-Za-z0-9_.@-]|$)/u);
    expect(serialized).toContain("[model omitted]");
    expect(serialized).toContain('const overwrite = \\"write a value\\";');
  });

  it("is independent of secret-valued process environment configuration", () => {
    const variable = "GRAPHCRAFT_PUBLICATION_DETERMINISM_SECRET";
    const original = process.env[variable];
    const report = reportFixture();
    const rawReportSha256 = "9".repeat(64);
    try {
      delete process.env[variable];
      const withoutEnvironmentSecret = createBlindedBenchmarkReview({
        report,
        rawReportSha256,
        suite,
        blindingKey,
      });
      process.env[variable] = "retained-evidence";
      const withEnvironmentSecret = createBlindedBenchmarkReview({
        report,
        rawReportSha256,
        suite,
        blindingKey,
      });
      expect(withEnvironmentSecret).toEqual(withoutEnvironmentSecret);
      expect(JSON.stringify(withEnvironmentSecret)).toContain("retained-evidence");
    } finally {
      if (original === undefined) delete process.env[variable];
      else process.env[variable] = original;
    }
  });

  it("requires exact digest-bound one-to-one review coverage", () => {
    const report = reportFixture();
    const rawReportSha256 = "c".repeat(64);
    const labels = reviewLabels(report, rawReportSha256);

    expect(
      validateBenchmarkReviewLabels({ report, rawReportSha256, suite, labels, blindingKey })
        .labelsByOpaqueId.size,
    ).toBe(report.results.length);
    expect(() =>
      validateBenchmarkReviewLabels({
        report,
        rawReportSha256,
        suite,
        blindingKey,
        labels: { ...labels, labels: labels.labels.slice(1) },
      }),
    ).toThrow(/cover every settled trial exactly once/u);
    expect(() =>
      validateBenchmarkReviewLabels({
        report,
        rawReportSha256,
        suite,
        blindingKey,
        labels: {
          ...labels,
          labels: [labels.labels[0]!, labels.labels[0]!, ...labels.labels.slice(2)],
        },
      }),
    ).toThrow(/one label per opaque ID/u);
    expect(() =>
      validateBenchmarkReviewLabels({
        report,
        rawReportSha256,
        suite,
        blindingKey,
        labels: {
          ...labels,
          labels: [
            { ...labels.labels[0]!, opaqueId: `packet-${"0".repeat(32)}` },
            ...labels.labels.slice(1),
          ],
        },
      }),
    ).toThrow(/cover every settled trial exactly once/u);
    expect(() =>
      validateBenchmarkReviewLabels({
        report,
        rawReportSha256,
        suite,
        blindingKey,
        labels: {
          ...labels,
          labels: [
            { ...labels.labels[0]!, packetDigest: "d".repeat(64) },
            ...labels.labels.slice(1),
          ],
        },
      }),
    ).toThrow(/packet digest does not match/u);
    expect(() =>
      validateBenchmarkReviewLabels({
        report,
        rawReportSha256,
        suite,
        blindingKey,
        labels: { ...labels, rawReportSha256: "e".repeat(64) },
      }),
    ).toThrow(/raw benchmark report digest/u);
    expect(() =>
      validateBenchmarkReviewLabels({
        report,
        rawReportSha256,
        suite,
        blindingKey,
        labels: { ...labels, blindingKeyDigest: "e".repeat(64) },
      }),
    ).toThrow(/blinding-key digest/u);
    expect(() =>
      validateBenchmarkReviewLabels({
        report,
        rawReportSha256,
        suite,
        blindingKey: alternateBlindingKey,
        labels,
      }),
    ).toThrow(/blinding-key digest/u);
    expect(() =>
      validateBenchmarkReviewLabels({
        report,
        rawReportSha256,
        suite,
        blindingKey,
        labels: { ...labels, blindedReviewDigest: "f".repeat(64) },
      }),
    ).toThrow(/blinded review artifact digest/u);
  });

  it("validates portable labels with v2 digests and refuses cross-version labels", () => {
    const portable = portableReportFixture();
    const legacy = reportFixture();
    const rawReportSha256 = "a".repeat(64);
    const portableLabels = portableReviewLabels(portable, rawReportSha256);
    const legacyLabels = reviewLabels(legacy, rawReportSha256);
    const portableBlinded = createBlindedBenchmarkReview({
      report: portable,
      rawReportSha256,
      suite,
      blindingKey,
    });

    expect(
      validateBenchmarkReviewLabels({
        report: portable,
        rawReportSha256,
        suite,
        labels: portableLabels,
        blindingKey,
      }).labelsByOpaqueId.size,
    ).toBe(portable.results.length);
    expect(() =>
      validateBenchmarkReviewLabels({
        report: portable,
        rawReportSha256,
        suite,
        labels: {
          ...portableLabels,
          labels: [
            { ...portableLabels.labels[0]!, packetDigest: "f".repeat(64) },
            ...portableLabels.labels.slice(1),
          ],
        },
        blindingKey,
      }),
    ).toThrow(/packet digest does not match/u);
    const legacyPacketDigest = alternateLocaleLegacyContentHash(portableBlinded.packets[0]);
    expect(legacyPacketDigest).not.toBe(portableLabels.labels[0]!.packetDigest);
    expect(() =>
      validateBenchmarkReviewLabels({
        report: portable,
        rawReportSha256,
        suite,
        labels: {
          ...portableLabels,
          labels: [
            { ...portableLabels.labels[0]!, packetDigest: legacyPacketDigest },
            ...portableLabels.labels.slice(1),
          ],
        },
        blindingKey,
      }),
    ).toThrow(/packet digest does not match/u);
    const legacyBlindedReviewDigest = alternateLocaleLegacyContentHash(portableBlinded);
    expect(legacyBlindedReviewDigest).not.toBe(portableLabels.blindedReviewDigest);
    expect(() =>
      validateBenchmarkReviewLabels({
        report: portable,
        rawReportSha256,
        suite,
        labels: { ...portableLabels, blindedReviewDigest: legacyBlindedReviewDigest },
        blindingKey,
      }),
    ).toThrow(/blinded review artifact digest/u);
    expect(() =>
      validateBenchmarkReviewLabels({
        report: portable,
        rawReportSha256,
        suite,
        labels: legacyLabels,
        blindingKey,
      } as never),
    ).toThrow(/schema-2 review labels/iu);
    expect(() =>
      validateBenchmarkReviewLabels({
        report: legacy,
        rawReportSha256,
        suite,
        labels: portableLabels,
        blindingKey,
      } as never),
    ).toThrow(/schema-1 review labels/iu);
  });
});

describe("benchmark publication report", () => {
  it("publishes provenance, per-task evidence, uncertainty, and a narrowly phrased passing gate", () => {
    const report = reportFixture();
    const rawReportSha256 = "1".repeat(64);
    const labels = reviewLabels(report, rawReportSha256, true);
    const markdown = renderBenchmarkPublicationMarkdown({
      report,
      rawReportSha256,
      suite,
      labels,
      labelsSha256: "2".repeat(64),
      blindingKey,
    });

    expect(markdown).toContain(`Raw report byte SHA-256: \`${rawReportSha256}\``);
    expect(markdown).toContain(
      `Blinding-key digest: \`${benchmarkBlindingKeyDigest(blindingKey)}\``,
    );
    expect(markdown).toContain(
      `Blinded review canonical SHA-256: \`${labels.blindedReviewDigest}\``,
    );
    expect(markdown).toContain(`Review-label file SHA-256: \`${"2".repeat(64)}\``);
    expect(markdown).toContain("Reviewer IDs: `reviewer-a`, `reviewer-b`");
    expect(markdown).toContain("Quantitative benchmark gate");
    expect(markdown).toContain("PASS for every evaluated host");
    expect(markdown).not.toContain("Stable 20% token-savings claim");
    expect(markdown).toContain("Critical blinded defects:** 1 across 1 trial(s)");
    expect(markdown).toContain("A passing quantitative gate does not override these findings");
    expect(markdown).toContain("## Per-task results");
    expect(markdown).toContain(
      "| feature-one | feature | codex | baseline | 3 | 3 | 300 (3/3 trials)",
    );
    expect(markdown).toContain(
      "| feature-one | feature | codex | graphcraft | 3 | 3 | 210 (3/3 trials)",
    );
    expect(markdown).toContain("95% Wilson interval");
    expect(markdown).toContain("exact coverage");
    expect(markdown).not.toContain(blindingKeyHex);
    expect(sha256(markdown)).toBe(
      "a8da8504e6116d8f562bac225dbbc835dbc5e21cf612e42df66ff03aae7149f1",
    );
  });

  it("renders portable v2 provenance and the portable blinded-review digest", () => {
    const report = portableReportFixture();
    const rawReportSha256 = "6".repeat(64);
    const labels = portableReviewLabels(report, rawReportSha256, true);
    const markdown = renderBenchmarkPublicationMarkdown({
      report,
      rawReportSha256,
      suite,
      labels,
      labelsSha256: "7".repeat(64),
      blindingKey,
    });

    expect(markdown).toContain("Publication artifact schema: `2`");
    expect(markdown).toContain(
      `Canonical hash algorithm: \`${PORTABLE_CANONICAL_HASH_ALGORITHM}\``,
    );
    expect(markdown).toContain(
      `Blinded review canonical SHA-256: \`${labels.blindedReviewDigest}\``,
    );
    expect(markdown).toContain("PASS for every evaluated host");
    expect(markdown).toContain("Critical blinded defects:** 1 across 1 trial(s)");
    expect(markdown).not.toContain(blindingKeyHex);
    expect(sha256(markdown)).toBe(
      "36c892839b6c5361137fd0e10ca0a0a39a9068ab2ea2238d29f8ff22e759221f",
    );
  });

  it("retains unsuccessful trials in denominators and suppresses the passing claim", () => {
    const base = reportFixture();
    const unsuccessfulTrialId = base.schedule.find(({ mode }) => mode === "graphcraft")!.trialId;
    const report = reportFixture({ unsuccessfulTrialId });
    const rawReportSha256 = "3".repeat(64);
    const labels = reviewLabels(report, rawReportSha256);
    const markdown = renderBenchmarkPublicationMarkdown({
      report,
      rawReportSha256,
      suite,
      labels,
      labelsSha256: "4".repeat(64),
      blindingKey,
    });

    expect(markdown).toContain("| codex | graphcraft | 3 | 2 | 1 | 66.7%");
    expect(markdown).toContain("NOT COMPARABLE for at least one evaluated host");
    expect(markdown).toContain("held-out scorer failed");
    expect(markdown).not.toContain("PASS for every evaluated host");

    const belowTarget = reportFixture({ graphcraftTokens: 90 });
    const belowTargetLabels = reviewLabels(belowTarget, rawReportSha256);
    const belowTargetMarkdown = renderBenchmarkPublicationMarkdown({
      report: belowTarget,
      rawReportSha256,
      suite,
      labels: belowTargetLabels,
      labelsSha256: "5".repeat(64),
      blindingKey,
    });
    expect(belowTargetMarkdown).toContain("FAIL for at least one evaluated host");
    expect(belowTargetMarkdown).not.toContain("PASS for every evaluated host");
  });

  it("uses deterministic Wilson and exact binomial order-statistic fixtures", () => {
    const wilson = wilsonScoreInterval(5, 10)!;
    expect(wilson).toMatchObject({
      method: "wilson_score",
      confidenceLevel: 0.95,
    });
    expect(wilson.lower).toBeCloseTo(0.236593090512564, 15);
    expect(wilson.upper).toBeCloseTo(0.7634069094874361, 15);
    expect(exactMedianInterval([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({
      method: "exact_binomial_order_statistic",
      requestedConfidenceLevel: 0.95,
      achievedConfidenceLevel: 0.978515625,
      requestedConfidenceAchieved: true,
      lower: 2,
      upper: 9,
      sampleSize: 10,
    });
    expect(wilsonScoreInterval(0, 0)).toBeNull();
    expect(exactMedianInterval([])).toBeNull();

    const large = exactMedianInterval(Array.from({ length: 2_000 }, (_, index) => index + 1))!;
    expect(large).toMatchObject({
      requestedConfidenceAchieved: true,
      lower: 956,
      upper: 1_045,
      sampleSize: 2_000,
    });
    expect(large.achievedConfidenceLevel).toBeCloseTo(0.9534471795082168, 14);
    expect(exactMedianInterval(Array.from({ length: 2_000 }, (_, index) => 2_000 - index))).toEqual(
      large,
    );
    expect(() => exactMedianInterval([Number.NaN])).toThrow(/must be finite/u);
    expect(() => exactMedianInterval([Number.POSITIVE_INFINITY])).toThrow(/must be finite/u);
  });

  it("renders untrusted Markdown as inert literal text", () => {
    const report = reportFixture();
    const rawReportSha256 = "8".repeat(64);
    const labels = reviewLabels(report, rawReportSha256, true);
    const malicious =
      "![remote pixel](https://evil.invalid/pixel) [deceptive link](https://evil.invalid/click) `spoofed code` <img src=https://evil.invalid/raw> www.evil.invalid #123";
    labels.labels[0]!.defects[0]!.summary = malicious;
    const markdown = renderBenchmarkPublicationMarkdown({
      report,
      rawReportSha256,
      suite,
      labels,
      labelsSha256: "7".repeat(64),
      blindingKey,
    });

    expect(markdown).not.toContain("![remote pixel](");
    expect(markdown).not.toContain("[deceptive link](");
    expect(markdown).not.toContain("https://evil.invalid");
    expect(markdown).not.toContain("www.evil.invalid");
    expect(markdown).not.toContain("`spoofed code`");
    expect(markdown).not.toMatch(/(^|[^\\])<img/u);
    expect(markdown).not.toMatch(/(^|[^\\])#123/u);
    expect(markdown).toContain("\\!\\[remote pixel\\]");
    expect(markdown).toContain("www\\.evil\\.invalid");
    expect(markdown).toContain("\\#123");
  });

  it("uses code-unit ordering for benchmark result keys", () => {
    const report = reportFixture();
    const rawReportSha256 = "0".repeat(64);
    const labels = reviewLabels(report, rawReportSha256);
    for (const label of labels.labels) {
      label.verdict = "defect";
      label.defects = [{ category: "correctness", severity: "major", summary: "ordering fixture" }];
    }
    const originalLocaleCompare = String.prototype.localeCompare;
    let resultKeyLocaleComparisons = 0;
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
      this: string,
      other: string,
    ) {
      const left = String(this);
      if (left.startsWith("codex/") && other.startsWith("codex/")) {
        resultKeyLocaleComparisons += 1;
        return left < other ? 1 : left > other ? -1 : 0;
      }
      return originalLocaleCompare.call(left, other);
    });
    try {
      const markdown = renderBenchmarkPublicationMarkdown({
        report,
        rawReportSha256,
        suite,
        labels,
        labelsSha256: "1".repeat(64),
        blindingKey,
      });
      expect(markdown.indexOf("codex\\/baseline\\/feature-one\\#1")).toBeLessThan(
        markdown.indexOf("codex\\/graphcraft\\/feature-one\\#1"),
      );
      expect(localeCompare).toHaveBeenCalled();
      expect(resultKeyLocaleComparisons).toBe(0);
    } finally {
      localeCompare.mockRestore();
    }
  });
});

describe("benchmark publication files", () => {
  it("keeps the raw schema-3 report byte-identical and publishes separate create-only artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-publication-"));
    roots.push(root);
    const reportPath = join(root, "raw.json");
    const blindedPath = join(root, "blinded.json");
    const labelsPath = join(root, "labels.json");
    const markdownPath = join(root, "report.md");
    const raw = `${JSON.stringify(reportFixture(), null, 2)}\n`;
    await writeFile(reportPath, raw, { mode: 0o600 });
    await expect(loadBenchmarkReportForPublicationV4(reportPath)).rejects.toThrow(/expected 4/u);

    const exported = await exportBlindedBenchmarkReview({
      reportPath,
      suite,
      blindingKey,
      outputPath: blindedPath,
    });
    const blinded = JSON.parse(await readFile(blindedPath, "utf8")) as ReturnType<
      typeof createBlindedBenchmarkReview
    >;
    expect(contentHash(blinded)).toBe(exported.blindedReviewDigest);
    expect(exported.blindingKeyDigest).toBe(benchmarkBlindingKeyDigest(blindingKey));
    expect(JSON.stringify(blinded)).not.toContain(blindingKeyHex);
    const labels = reviewLabels(reportFixture(), exported.rawReportSha256);
    const labelsSource = `${JSON.stringify(labels, null, 2)}\n`;
    await writeFile(labelsPath, labelsSource, { mode: 0o600 });
    await expect(loadBenchmarkReviewLabelsV2(labelsPath)).rejects.toThrow(/expected 2/u);

    const rendered = await renderBenchmarkPublicationReport({
      reportPath,
      suite,
      blindingKey,
      labelsPath,
      outputPath: markdownPath,
    });
    expect(rendered.labelsSha256).toBe(sha256(labelsSource));
    expect(rendered.blindedReviewDigest).toBe(exported.blindedReviewDigest);
    expect(rendered.blindingKeyDigest).toBe(exported.blindingKeyDigest);
    expect(await readFile(reportPath, "utf8")).toBe(raw);
    expect(await readFile(markdownPath, "utf8")).toContain("## Provenance");

    await expect(
      exportBlindedBenchmarkReview({
        reportPath,
        suite,
        blindingKey,
        outputPath: blindedPath,
      }),
    ).rejects.toThrow(/already exists; refusing to overwrite/u);
    expect(contentHash(JSON.parse(await readFile(blindedPath, "utf8")))).toBe(
      exported.blindedReviewDigest,
    );
    await expect(
      exportBlindedBenchmarkReview({
        reportPath,
        suite,
        blindingKey,
        outputPath: reportPath,
      }),
    ).rejects.toThrow(/must not replace an input artifact/u);
    expect(await readFile(reportPath, "utf8")).toBe(raw);
  });

  it("publishes schema-4 reports as portable v2 artifacts without changing raw byte identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-publication-v2-"));
    roots.push(root);
    const reportPath = join(root, "raw-v4.json");
    const blindedPath = join(root, "blinded-v2.json");
    const labelsPath = join(root, "labels-v2.json");
    const markdownPath = join(root, "report-v2.md");
    const report = portableReportFixture();
    const raw = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(reportPath, raw, { mode: 0o600 });

    await expect(loadBenchmarkReportForPublication(reportPath)).rejects.toThrow(/expected 3/u);
    expect((await loadBenchmarkReportForPublicationV4(reportPath)).report).toEqual(report);
    expect((await loadVersionedBenchmarkReportForPublication(reportPath)).report).toEqual(report);

    const exported = await exportBlindedBenchmarkReview({
      reportPath,
      suite,
      blindingKey,
      outputPath: blindedPath,
    });
    const blindedArtifact = BenchmarkBlindedReviewExportV2Schema.parse(
      JSON.parse(await readFile(blindedPath, "utf8")),
    );
    expect(blindedArtifact).toMatchObject({
      schemaVersion: 2,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      reviewPolicy: "opaque_blinded_review_v2",
    });
    expect(exported.rawReportSha256).toBe(sha256(raw));
    expect(exported.blindedReviewDigest).toBe(
      contentHash(blindedArtifact, PORTABLE_CANONICAL_HASH_ALGORITHM),
    );
    expect(await readFile(reportPath, "utf8")).toBe(raw);

    const labels = portableReviewLabels(report, exported.rawReportSha256);
    const labelsSource = `${JSON.stringify(labels, null, 2)}\n`;
    await writeFile(labelsPath, labelsSource, { mode: 0o600 });
    await expect(loadBenchmarkReviewLabels(labelsPath)).rejects.toThrow(/expected 1/u);
    expect(await loadBenchmarkReviewLabelsV2(labelsPath)).toEqual(labels);
    expect(await loadVersionedBenchmarkReviewLabels(labelsPath)).toEqual(labels);

    const rendered = await renderBenchmarkPublicationReport({
      reportPath,
      suite,
      blindingKey,
      labelsPath,
      outputPath: markdownPath,
    });
    expect(rendered.rawReportSha256).toBe(sha256(raw));
    expect(rendered.labelsSha256).toBe(sha256(labelsSource));
    expect(rendered.blindedReviewDigest).toBe(exported.blindedReviewDigest);
    expect(await readFile(markdownPath, "utf8")).toContain("Publication artifact schema: `2`");
    expect(await readFile(reportPath, "utf8")).toBe(raw);
  });

  it("refuses cross-version relabelling and report-label mismatches before output creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-publication-versions-"));
    roots.push(root);
    const portable = portableReportFixture();
    const portablePath = join(root, "portable.json");
    const legacyPath = join(root, "legacy.json");
    const relabelledPath = join(root, "relabelled.json");
    const legacyLabelsPath = join(root, "legacy-labels.json");
    const portableLabelsPath = join(root, "portable-labels.json");
    const relabelledLabelsPath = join(root, "relabelled-labels.json");
    const outputPath = join(root, "must-not-exist.md");
    const oppositeOutputPath = join(root, "must-also-not-exist.md");
    const portableSource = `${JSON.stringify(portable, null, 2)}\n`;
    const legacySource = `${JSON.stringify(reportFixture(), null, 2)}\n`;
    await writeFile(portablePath, portableSource, { mode: 0o600 });
    await writeFile(legacyPath, legacySource, { mode: 0o600 });

    const relabelled = { ...portable, schemaVersion: 3 };
    await writeFile(relabelledPath, `${JSON.stringify(relabelled)}\n`, { mode: 0o600 });
    await expect(loadVersionedBenchmarkReportForPublication(relabelledPath)).rejects.toThrow();

    const rawReportSha256 = sha256(portableSource);
    const legacyLabels = reviewLabels(reportFixture(), rawReportSha256);
    await writeFile(legacyLabelsPath, `${JSON.stringify(legacyLabels)}\n`, { mode: 0o600 });
    const portableLabels = portableReviewLabels(portable, rawReportSha256);
    await writeFile(portableLabelsPath, `${JSON.stringify(portableLabels)}\n`, { mode: 0o600 });
    await writeFile(
      relabelledLabelsPath,
      `${JSON.stringify({ ...portableLabels, schemaVersion: 1 })}\n`,
      { mode: 0o600 },
    );
    await expect(loadVersionedBenchmarkReviewLabels(relabelledLabelsPath)).rejects.toThrow();
    await expect(
      renderBenchmarkPublicationReport({
        reportPath: portablePath,
        suite,
        blindingKey,
        labelsPath: legacyLabelsPath,
        outputPath,
      }),
    ).rejects.toThrow(/schema-2 review labels/iu);
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      renderBenchmarkPublicationReport({
        reportPath: legacyPath,
        suite,
        blindingKey,
        labelsPath: portableLabelsPath,
        outputPath: oppositeOutputPath,
      }),
    ).rejects.toThrow(/schema-1 review labels/iu);
    await expect(readFile(oppositeOutputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(portablePath, "utf8")).toBe(portableSource);
    expect(await readFile(legacyPath, "utf8")).toBe(legacySource);
  });

  it("refuses oversized or multiply-linked input and preserves an existing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-publication-files-"));
    roots.push(root);
    const reportPath = join(root, "raw.json");
    const outputPath = join(root, "existing.json");
    const report = `${JSON.stringify(reportFixture())}\n`;
    await writeFile(reportPath, report, { mode: 0o600 });
    await writeFile(outputPath, "sentinel\n", { mode: 0o600 });

    await expect(
      exportBlindedBenchmarkReview({ reportPath, suite, blindingKey, outputPath }),
    ).rejects.toThrow(/already exists; refusing to overwrite/u);
    expect(await readFile(outputPath, "utf8")).toBe("sentinel\n");

    const linkedReport = join(root, "raw-hardlink.json");
    await link(reportPath, linkedReport);
    await expect(loadBenchmarkReportForPublication(reportPath)).rejects.toThrow(/multiply linked/u);
    expect(await readFile(reportPath, "utf8")).toBe(report);

    const oversized = join(root, "oversized.json");
    await writeFile(oversized, "", { mode: 0o600 });
    await truncate(oversized, BENCHMARK_PUBLICATION_REPORT_MAX_BYTES + 1);
    await expect(loadBenchmarkReportForPublication(oversized)).rejects.toThrow(
      /bounded read limit/u,
    );
  });

  it("keeps publication v1 restricted to legacy schema-v3 reports", async () => {
    const portableReportPath = fileURLToPath(
      new URL("../../../tests/fixtures/protocol/benchmark-report.v4.json", import.meta.url),
    );
    const portableReport = JSON.parse(await readFile(portableReportPath, "utf8")) as unknown;

    expect(BenchmarkReportV4Schema.parse(portableReport)).toEqual(portableReport);
    await expect(loadBenchmarkReportForPublication(portableReportPath)).rejects.toThrow(
      /expected 3/u,
    );
  });

  it.runIf(process.platform !== "win32")(
    "refuses symbolic-link report, labels, and output aliases without changing inputs",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-publication-links-"));
      roots.push(root);
      const reportPath = join(root, "raw.json");
      const reportLink = join(root, "raw-link.json");
      const outputLink = join(root, "output-link.json");
      const labelsPath = join(root, "labels.json");
      const labelsLink = join(root, "labels-link.json");
      const report = `${JSON.stringify(reportFixture())}\n`;
      await writeFile(reportPath, report, { mode: 0o600 });
      await symlink(reportPath, reportLink);

      await expect(loadBenchmarkReportForPublication(reportLink)).rejects.toThrow(/symbolic link/u);
      await symlink(reportPath, outputLink);
      await expect(
        exportBlindedBenchmarkReview({
          reportPath,
          suite,
          blindingKey,
          outputPath: outputLink,
        }),
      ).rejects.toThrow(/must not replace an input artifact/u);
      const loaded = await loadBenchmarkReportForPublication(reportPath);
      const labels = reviewLabels(loaded.report, loaded.rawReportSha256);
      await writeFile(labelsPath, `${JSON.stringify(labels)}\n`, { mode: 0o600 });
      await symlink(labelsPath, labelsLink);
      await expect(loadBenchmarkReviewLabels(labelsLink)).rejects.toThrow(/symbolic link/u);
      expect(await readFile(reportPath, "utf8")).toBe(report);
    },
  );

  it("refuses oversized review-label files before parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-publication-labels-"));
    roots.push(root);
    const labelsPath = join(root, "labels.json");
    await writeFile(labelsPath, "", { mode: 0o600 });
    await truncate(labelsPath, BENCHMARK_PUBLICATION_LABELS_MAX_BYTES + 1);
    await expect(loadBenchmarkReviewLabels(labelsPath)).rejects.toThrow(/bounded read limit/u);
  });

  it("accepts only one bounded lowercase hexadecimal blinding key from stdin", async () => {
    for (const suffix of ["", "\n", "\r\n"]) {
      const parsed = parseBenchmarkBlindingKeyInput(Buffer.from(`${blindingKeyHex}${suffix}`));
      expect(parsed).toEqual(blindingKey);
      parsed.fill(0);
    }

    const chunks = [
      Buffer.from(blindingKeyHex.slice(0, 17)),
      Buffer.from(blindingKeyHex.slice(17)),
    ];
    const streamed = await readBenchmarkBlindingKeyFromStdin(Readable.from(chunks));
    expect(streamed).toEqual(blindingKey);
    expect(chunks.every((chunk) => chunk.every((byte) => byte === 0))).toBe(true);
    streamed.fill(0);

    for (const invalid of [
      `${"AA".repeat(32)}\n`,
      `${blindingKeyHex}x`,
      `${blindingKeyHex}\r`,
      `${blindingKeyHex}\nextra`,
    ])
      expect(() => parseBenchmarkBlindingKeyInput(Buffer.from(invalid))).toThrow(
        /64 lowercase hexadecimal/u,
      );

    await expect(
      readBenchmarkBlindingKeyFromStdin(
        Readable.from([Buffer.alloc(BENCHMARK_BLINDING_KEY_STDIN_MAX_BYTES + 1, 0x61)]),
      ),
    ).rejects.toThrow(/exceeds 66 bytes/u);
  });
});
