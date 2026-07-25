import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  BENCHMARK_DEFECT_CATEGORIES,
  BENCHMARK_DEFECT_SEVERITIES,
  BENCHMARK_REVIEW_PATCH_LIMIT_BYTES,
  BENCHMARK_REVIEW_TRANSCRIPT_LIMIT_BYTES,
  BenchmarkBlindedReviewExportV1Schema,
  BenchmarkBlindedReviewExportV2Schema,
  BenchmarkBlindedReviewPacketV1Schema,
  BenchmarkBlindedReviewPacketV2Schema,
  BenchmarkReportV3Schema,
  BenchmarkReportV4Schema,
  BenchmarkReviewLabelsV1Schema,
  BenchmarkReviewLabelsV2Schema,
  BenchmarkReviewPacketV1Schema,
  BenchmarkReviewPacketV2Schema,
  BenchmarkSuiteSchema,
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  benchmarkBlindingKeyDigest,
  benchmarkReviewEvidenceDigest,
  benchmarkReviewOpaqueId,
  benchmarkReviewOpaqueIdV2,
  contentHash,
  summarizeBenchmark,
  type BenchmarkBlindedReviewExportV1,
  type BenchmarkBlindedReviewExportV2,
  type BenchmarkReportV3,
  type BenchmarkReportV4,
  type BenchmarkReviewLabelsV1,
  type BenchmarkReviewLabelsV2,
  type BenchmarkReviewPacketV1,
  type BenchmarkReviewPacketV2,
  type BenchmarkSuite,
  type BenchmarkTrialResultV3,
  type BenchmarkTrialResultV4,
  type CanonicalHashAlgorithm,
} from "@graphcraft/core";
import { syncDirectory } from "./json.ts";
import { redactString } from "./redaction.ts";
import { readPrivateFileBounded } from "./secure-fs.ts";
import { assertBenchmarkReportEvidence } from "./benchmark-validation.ts";

const LEGACY_REVIEW_POLICY = "bounded_redacted_patch_and_transcript_v1" as const;
const PORTABLE_REVIEW_POLICY = "bounded_redacted_patch_and_transcript_v2" as const;
const LEGACY_BLINDED_REVIEW_POLICY = "opaque_blinded_review_v1" as const;
const PORTABLE_BLINDED_REVIEW_POLICY = "opaque_blinded_review_v2" as const;
const WILSON_Z_95 = 1.959963984540054;
export const BENCHMARK_PUBLICATION_REPORT_MAX_BYTES = 64 * 1024 * 1024;
export const BENCHMARK_PUBLICATION_LABELS_MAX_BYTES = 16 * 1024 * 1024;
export const BENCHMARK_BLINDING_KEY_STDIN_MAX_BYTES = 66;

export interface LoadedBenchmarkReport {
  path: string;
  rawReportSha256: string;
  report: BenchmarkReportV3;
}

export interface LoadedBenchmarkReportV4 {
  path: string;
  rawReportSha256: string;
  report: BenchmarkReportV4;
}

export type LoadedVersionedBenchmarkReport = LoadedBenchmarkReport | LoadedBenchmarkReportV4;

interface LoadedBenchmarkReviewLabelsV1 {
  path: string;
  labelsSha256: string;
  labels: BenchmarkReviewLabelsV1;
}

interface LoadedBenchmarkReviewLabelsV2 {
  path: string;
  labelsSha256: string;
  labels: BenchmarkReviewLabelsV2;
}

type LoadedVersionedBenchmarkReviewLabels =
  LoadedBenchmarkReviewLabelsV1 | LoadedBenchmarkReviewLabelsV2;

type BenchmarkPublicationReport = BenchmarkReportV3 | BenchmarkReportV4;
type BenchmarkPublicationResult = BenchmarkTrialResultV3 | BenchmarkTrialResultV4;
type BenchmarkPublicationReviewPacket = BenchmarkReviewPacketV1 | BenchmarkReviewPacketV2;
type BenchmarkPublicationExport = BenchmarkBlindedReviewExportV1 | BenchmarkBlindedReviewExportV2;
type BenchmarkPublicationLabels = BenchmarkReviewLabelsV1 | BenchmarkReviewLabelsV2;

export interface WilsonScoreInterval {
  method: "wilson_score";
  confidenceLevel: 0.95;
  lower: number;
  upper: number;
}

export interface ExactMedianInterval {
  method: "exact_binomial_order_statistic";
  requestedConfidenceLevel: 0.95;
  achievedConfidenceLevel: number;
  requestedConfidenceAchieved: boolean;
  lower: number;
  upper: number;
  sampleSize: number;
}

const PUBLICATION_SECRET_KEY =
  /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential)/iu;
const MAX_PUBLICATION_REDACTION_DEPTH = 64;

function publicationRedactString(value: string): string {
  // Publication artifacts must be reproducible from their bound inputs. The
  // shared redactor normally includes current secret-valued environment
  // variables, so explicitly use only its environment-independent patterns.
  return redactString(value, []);
}

function publicationRedactValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > MAX_PUBLICATION_REDACTION_DEPTH)
    throw new Error("Benchmark publication value exceeds the safe redaction depth");
  if (PUBLICATION_SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return publicationRedactString(value);
  if (Array.isArray(value))
    return value.map((entry) => publicationRedactValue(entry, "", depth + 1));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [
      name,
      publicationRedactValue(entry, name, depth + 1),
    ]),
  );
}

function rawSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseJson(path: string, source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`Benchmark artifact is not valid JSON: ${path}`);
  }
}

function declaredSchemaVersion(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { schemaVersion?: unknown }).schemaVersion
    : undefined;
}

async function readBenchmarkReportArtifact(path: string): Promise<{
  path: string;
  rawReportSha256: string;
  value: unknown;
}> {
  const absolute = resolve(path);
  const source = await readPrivateFileBounded(absolute, BENCHMARK_PUBLICATION_REPORT_MAX_BYTES);
  return {
    path: absolute,
    rawReportSha256: rawSha256(source),
    value: parseJson(absolute, source.toString("utf8")),
  };
}

export async function loadBenchmarkReportForPublication(
  path: string,
): Promise<LoadedBenchmarkReport> {
  const loaded = await readBenchmarkReportArtifact(path);
  return {
    path: loaded.path,
    rawReportSha256: loaded.rawReportSha256,
    report: BenchmarkReportV3Schema.parse(loaded.value),
  };
}

export async function loadBenchmarkReportForPublicationV4(
  path: string,
): Promise<LoadedBenchmarkReportV4> {
  const loaded = await readBenchmarkReportArtifact(path);
  return {
    path: loaded.path,
    rawReportSha256: loaded.rawReportSha256,
    report: BenchmarkReportV4Schema.parse(loaded.value),
  };
}

export async function loadVersionedBenchmarkReportForPublication(
  path: string,
): Promise<LoadedVersionedBenchmarkReport> {
  const loaded = await readBenchmarkReportArtifact(path);
  const schemaVersion = declaredSchemaVersion(loaded.value);
  if (schemaVersion === 3)
    return {
      path: loaded.path,
      rawReportSha256: loaded.rawReportSha256,
      report: BenchmarkReportV3Schema.parse(loaded.value),
    };
  if (schemaVersion === 4)
    return {
      path: loaded.path,
      rawReportSha256: loaded.rawReportSha256,
      report: BenchmarkReportV4Schema.parse(loaded.value),
    };
  throw new Error("Benchmark publication supports only declared report schema versions 3 and 4");
}

async function readBenchmarkReviewLabelsArtifact(path: string): Promise<{
  path: string;
  labelsSha256: string;
  value: unknown;
}> {
  const absolute = resolve(path);
  const source = await readPrivateFileBounded(absolute, BENCHMARK_PUBLICATION_LABELS_MAX_BYTES);
  return {
    path: absolute,
    labelsSha256: rawSha256(source),
    value: parseJson(absolute, source.toString("utf8")),
  };
}

async function loadBenchmarkReviewLabelsArtifact(
  path: string,
): Promise<LoadedBenchmarkReviewLabelsV1> {
  const loaded = await readBenchmarkReviewLabelsArtifact(path);
  return {
    path: loaded.path,
    labelsSha256: loaded.labelsSha256,
    labels: BenchmarkReviewLabelsV1Schema.parse(loaded.value),
  };
}

async function loadBenchmarkReviewLabelsArtifactV2(
  path: string,
): Promise<LoadedBenchmarkReviewLabelsV2> {
  const loaded = await readBenchmarkReviewLabelsArtifact(path);
  return {
    path: loaded.path,
    labelsSha256: loaded.labelsSha256,
    labels: BenchmarkReviewLabelsV2Schema.parse(loaded.value),
  };
}

async function loadVersionedBenchmarkReviewLabelsArtifact(
  path: string,
): Promise<LoadedVersionedBenchmarkReviewLabels> {
  const loaded = await readBenchmarkReviewLabelsArtifact(path);
  const schemaVersion = declaredSchemaVersion(loaded.value);
  if (schemaVersion === 1)
    return {
      path: loaded.path,
      labelsSha256: loaded.labelsSha256,
      labels: BenchmarkReviewLabelsV1Schema.parse(loaded.value),
    };
  if (schemaVersion === 2)
    return {
      path: loaded.path,
      labelsSha256: loaded.labelsSha256,
      labels: BenchmarkReviewLabelsV2Schema.parse(loaded.value),
    };
  throw new Error(
    "Benchmark publication supports only declared review-label schema versions 1 and 2",
  );
}

export async function loadBenchmarkReviewLabels(path: string): Promise<BenchmarkReviewLabelsV1> {
  return (await loadBenchmarkReviewLabelsArtifact(path)).labels;
}

export async function loadBenchmarkReviewLabelsV2(path: string): Promise<BenchmarkReviewLabelsV2> {
  return (await loadBenchmarkReviewLabelsArtifactV2(path)).labels;
}

export async function loadVersionedBenchmarkReviewLabels(
  path: string,
): Promise<BenchmarkPublicationLabels> {
  return (await loadVersionedBenchmarkReviewLabelsArtifact(path)).labels;
}

function hexNibble(value: number): number | undefined {
  if (value >= 0x30 && value <= 0x39) return value - 0x30;
  if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10;
  return undefined;
}

export function parseBenchmarkBlindingKeyInput(value: Uint8Array): Buffer {
  const encoded = Buffer.from(value);
  try {
    const payloadLength =
      encoded.length === 64
        ? 64
        : encoded.length === 65 && encoded[64] === 0x0a
          ? 64
          : encoded.length === 66 && encoded[64] === 0x0d && encoded[65] === 0x0a
            ? 64
            : 0;
    if (payloadLength !== 64)
      throw new Error(
        "Benchmark blinding key stdin must contain exactly 64 lowercase hexadecimal characters with an optional final LF or CRLF",
      );
    const key = Buffer.alloc(32);
    try {
      for (let index = 0; index < payloadLength; index += 2) {
        const high = hexNibble(encoded[index]!);
        const low = hexNibble(encoded[index + 1]!);
        if (high === undefined || low === undefined)
          throw new Error(
            "Benchmark blinding key stdin must contain exactly 64 lowercase hexadecimal characters with an optional final LF or CRLF",
          );
        key[index / 2] = high * 16 + low;
      }
      return key;
    } catch (error) {
      key.fill(0);
      throw error;
    }
  } finally {
    encoded.fill(0);
  }
}

export async function readBenchmarkBlindingKeyFromStdin(
  input: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const encoded = Buffer.alloc(BENCHMARK_BLINDING_KEY_STDIN_MAX_BYTES);
  let length = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      try {
        if (length + bytes.length > encoded.length)
          throw new Error(
            `Benchmark blinding key stdin exceeds ${BENCHMARK_BLINDING_KEY_STDIN_MAX_BYTES} bytes`,
          );
        bytes.copy(encoded, length);
        length += bytes.length;
      } finally {
        bytes.fill(0);
      }
    }
    return parseBenchmarkBlindingKeyInput(encoded.subarray(0, length));
  } finally {
    encoded.fill(0);
  }
}

function publicationArtifactVersion(report: BenchmarkPublicationReport): 1 | 2 {
  return report.schemaVersion === 4 ? 2 : 1;
}

function publicationHashAlgorithm(
  reportOrVersion: BenchmarkPublicationReport | 1 | 2,
): CanonicalHashAlgorithm {
  const version =
    typeof reportOrVersion === "number"
      ? reportOrVersion
      : publicationArtifactVersion(reportOrVersion);
  return version === 2 ? PORTABLE_CANONICAL_HASH_ALGORITHM : LEGACY_CANONICAL_HASH_ALGORITHM;
}

function publicationOpaqueId(
  report: BenchmarkPublicationReport,
  rawReportSha256: string,
  trialId: string,
  blindingKey: Uint8Array,
): string {
  return report.schemaVersion === 4
    ? benchmarkReviewOpaqueIdV2(rawReportSha256, trialId, blindingKey)
    : benchmarkReviewOpaqueId(rawReportSha256, trialId, blindingKey);
}

function assertPublicationReady(report: BenchmarkPublicationReport): void {
  if (report.status !== "complete")
    throw new Error(
      `Benchmark publication requires a complete schema-${report.schemaVersion} report`,
    );
  const expectedReviewPolicy =
    report.schemaVersion === 4 ? PORTABLE_REVIEW_POLICY : LEGACY_REVIEW_POLICY;
  if (report.reviewPolicy !== expectedReviewPolicy)
    throw new Error("Benchmark publication requires bounded review evidence");
  if (report.results.some(({ attemptCheckpoint }) => attemptCheckpoint !== "settled"))
    throw new Error("Benchmark publication cannot include an unsettled trial");
  if (report.results.some(({ reviewPacket }) => reviewPacket === undefined))
    throw new Error("Every settled benchmark trial must retain a review packet");
}

function assertSuiteMatchesReport(suite: BenchmarkSuite, report: BenchmarkPublicationReport): void {
  if (
    suite.id !== report.suite.id ||
    suite.version !== report.suite.version ||
    contentHash(suite, publicationHashAlgorithm(report)) !== report.suite.digest
  )
    throw new Error("The benchmark suite does not match the raw report identity");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

type IdentityReplacement = {
  value: string;
  replacement: string;
  caseInsensitive?: boolean;
};

const IDENTITY_TOKEN_CHARACTER = /[A-Za-z0-9_.@-]/u;
const IDENTITY_TOKEN_CLASS = "[A-Za-z0-9_.@-]";
const MINIMUM_DISCOVERED_IDENTITY_LENGTH = 6;

function normalizedMetadataKey(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

const IDENTITY_KEYS = new Set([
  "agent",
  "agentid",
  "host",
  "hostname",
  "hostsessionid",
  "hostversion",
  "invocationid",
  "mode",
  "model",
  "modelid",
  "modelname",
  "modelpolicy",
  "nodeid",
  "order",
  "permissionpolicy",
  "provider",
  "repetition",
  "runid",
  "seed",
  "session",
  "sessionid",
  "source",
  "tokenusage",
  "tokens",
  "trial",
  "trialid",
  "usage",
]);

function isIdentityKey(key: string): boolean {
  const normalized = normalizedMetadataKey(key);
  return (
    IDENTITY_KEYS.has(normalized) ||
    normalized.endsWith("sessionid") ||
    normalized.endsWith("invocationid") ||
    normalized.endsWith("modelpolicy") ||
    normalized.endsWith("tokenusage")
  );
}

function collectStrings(value: unknown, output: Set<string>): void {
  if (typeof value === "string") {
    if (value.length > 0) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const entry of Object.values(value)) collectStrings(entry, output);
}

function collectIdentityStrings(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectIdentityStrings(entry, output);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizedMetadataKey(key);
    if (["tokenusage", "tokens", "usage"].includes(normalized)) continue;
    if (isIdentityKey(key)) collectStrings(entry, output);
    else collectIdentityStrings(entry, output);
  }
}

function transcriptIdentityStrings(text: string): Set<string> {
  const identities = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      collectIdentityStrings(JSON.parse(line), identities);
    } catch {
      // Unstructured fragments are scrubbed by the known result identities.
    }
  }
  return identities;
}

function identityReplacements(result: BenchmarkPublicationResult): IdentityReplacement[] {
  const distinctive = (value: string): boolean =>
    value.length >= MINIMUM_DISCOVERED_IDENTITY_LENGTH;
  const candidates: IdentityReplacement[] = [
    { value: result.trial.trialId, replacement: "[trial identity omitted]" },
    { value: result.modelPolicy, replacement: "[model omitted]" },
    { value: result.hostVersion, replacement: "[host version omitted]" },
    { value: result.permissionPolicy, replacement: "[permission profile omitted]" },
    { value: result.repositoryDigest, replacement: "[fixture identity omitted]" },
    { value: result.baseSha, replacement: "[fixture identity omitted]" },
    { value: result.acceptanceScorerDigest, replacement: "[scorer identity omitted]" },
    { value: result.observedScorerDigest, replacement: "[scorer identity omitted]" },
    {
      value: result.trial.host,
      replacement: "[host omitted]",
      caseInsensitive: true,
    },
    {
      value: result.trial.mode,
      replacement: "[execution mode omitted]",
      caseInsensitive: true,
    },
    {
      value: "graphcraft",
      replacement: "[execution mode omitted]",
      caseInsensitive: true,
    },
    {
      value: "baseline",
      replacement: "[execution mode omitted]",
      caseInsensitive: true,
    },
    { value: "codex", replacement: "[host omitted]", caseInsensitive: true },
    { value: "claude", replacement: "[host omitted]", caseInsensitive: true },
  ];
  for (const identity of transcriptIdentityStrings(result.reviewPacket?.transcript.text ?? ""))
    if (distinctive(identity))
      candidates.push({ value: identity, replacement: "[identity metadata omitted]" });
  const replacements = new Map<string, IdentityReplacement>();
  for (const candidate of candidates)
    if (candidate.value.length > 0 && !replacements.has(candidate.value))
      replacements.set(candidate.value, candidate);
  return [...replacements.values()].sort((left, right) => right.value.length - left.value.length);
}

function blindText(value: string, replacements: IdentityReplacement[]): string {
  let blinded = value;
  for (const { value: identity, replacement, caseInsensitive } of replacements) {
    const prefix = IDENTITY_TOKEN_CHARACTER.test(identity[0]!)
      ? `(?<!${IDENTITY_TOKEN_CLASS})`
      : "";
    const suffix = IDENTITY_TOKEN_CHARACTER.test(identity.at(-1)!)
      ? `(?!${IDENTITY_TOKEN_CLASS})`
      : "";
    const pattern = new RegExp(
      `${prefix}${escapeRegExp(identity)}${suffix}`,
      caseInsensitive ? "giu" : "gu",
    );
    blinded = blinded.replace(pattern, replacement);
  }
  return publicationRedactString(blinded);
}

function blindValue(value: unknown, replacements: IdentityReplacement[]): unknown {
  if (typeof value === "string") return blindText(value, replacements);
  if (Array.isArray(value)) return value.map((entry) => blindValue(entry, replacements));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isIdentityKey(key))
      .map(([key, entry]) => [key, blindValue(entry, replacements)]),
  );
}

const NEUTRAL_RESULT_STATUSES = new Set(["completed", "blocked", "failed"]);
const NEUTRAL_INTERRUPTION_CAUSES = new Set([
  "user_pause",
  "user_stop",
  "cancellation",
  "host_crash",
  "timeout",
  "runtime_shutdown",
]);
const NEUTRAL_TERMINATION_OUTCOMES = new Set(["graceful", "forced", "already_exited"]);

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function neutralHostEvent(
  value: unknown,
  replacements: IdentityReplacement[],
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (event.type === "message" && typeof event.text === "string")
    return { type: "message", text: blindText(event.text, replacements) };
  if (event.type === "tool" && typeof event.name === "string" && typeof event.summary === "string")
    return {
      type: "tool",
      name: "agent_tool",
      summary: blindText(event.summary, replacements),
    };
  if (event.type === "result") {
    if (event.result === null || typeof event.result !== "object" || Array.isArray(event.result))
      return undefined;
    const result = event.result as Record<string, unknown>;
    if (
      typeof result.status !== "string" ||
      !NEUTRAL_RESULT_STATUSES.has(result.status) ||
      typeof result.summary !== "string" ||
      !stringArray(result.evidence)
    )
      return undefined;
    return {
      type: "result",
      status: result.status,
      summary: blindText(result.summary, replacements),
      evidence: result.evidence.map((entry) => blindText(entry, replacements)),
    };
  }
  if (event.type === "error" && typeof event.message === "string")
    return {
      type: "error",
      reason: blindText(event.message, replacements),
      ...(typeof event.cause === "string" && NEUTRAL_INTERRUPTION_CAUSES.has(event.cause)
        ? { cause: event.cause }
        : {}),
    };
  if (event.type === "terminated") {
    if (
      event.termination === null ||
      typeof event.termination !== "object" ||
      Array.isArray(event.termination)
    )
      return undefined;
    const termination = event.termination as Record<string, unknown>;
    if (
      typeof termination.cause !== "string" ||
      !NEUTRAL_INTERRUPTION_CAUSES.has(termination.cause) ||
      typeof termination.outcome !== "string" ||
      !NEUTRAL_TERMINATION_OUTCOMES.has(termination.outcome)
    )
      return undefined;
    return {
      type: "termination",
      cause: termination.cause,
      outcome: termination.outcome,
    };
  }
  return undefined;
}

function normalizedBlindedTranscript(text: string, replacements: IdentityReplacement[]): string {
  const output: unknown[] = [
    {
      type: "evidence_notice",
      message:
        "Host, model, mode, session, usage, and control-plane metadata were omitted for blinded review.",
    },
  ];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (line.trim() === "[GRAPHCRAFT REVIEW EVIDENCE MIDDLE OMITTED]") {
      output.push({
        type: "evidence_omission",
        message: "The source transcript was truncated before blinded export.",
      });
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.source === "graphcraft_run_event") continue;
    if (record.source === "baseline_host_event" || record.source === "graphcraft_host_event") {
      const event = neutralHostEvent(record.event, replacements);
      if (event) output.push({ type: "agent_event", event });
    }
  }
  return `${output.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function blindedPatch(text: string, replacements: IdentityReplacement[]): string {
  return blindText(text, replacements);
}

function utf8Prefix(value: Buffer, maximumBytes: number): Buffer {
  for (let end = Math.min(maximumBytes, value.length); end >= 0; end -= 1) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(0, end));
      return value.subarray(0, end);
    } catch {
      // A byte boundary can split one UTF-8 code point.
    }
  }
  return Buffer.alloc(0);
}

function utf8Suffix(value: Buffer, maximumBytes: number): Buffer {
  const start = Math.max(0, value.length - maximumBytes);
  for (let offset = start; offset <= value.length; offset += 1) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(offset));
      return value.subarray(offset);
    } catch {
      // A byte boundary can split one UTF-8 code point.
    }
  }
  return Buffer.alloc(0);
}

function blindedEvidence(
  evidence: BenchmarkPublicationReviewPacket["patch"],
  replacements: IdentityReplacement[],
  packetSchemaVersion: 1 | 2,
): BenchmarkPublicationReviewPacket["patch"] {
  const text =
    evidence.mediaType === "application/x-ndjson"
      ? normalizedBlindedTranscript(evidence.text, replacements)
      : blindedPatch(evidence.text, replacements);
  const limit =
    evidence.mediaType === "text/x-diff"
      ? BENCHMARK_REVIEW_PATCH_LIMIT_BYTES
      : BENCHMARK_REVIEW_TRANSCRIPT_LIMIT_BYTES;
  const source = Buffer.from(text, "utf8");
  const marker = Buffer.from("\n[BLINDED REVIEW EVIDENCE MIDDLE OMITTED]\n", "utf8");
  let retained = source;
  let locallyOmittedBytes = 0;
  if (source.length > limit) {
    const available = limit - marker.length;
    const head = utf8Prefix(source, Math.floor(available / 2));
    const tail = utf8Suffix(source, available - head.length);
    locallyOmittedBytes = Math.max(0, source.length - head.length - tail.length);
    retained = Buffer.concat([head, marker, tail]);
  }
  const retainedText = retained.toString("utf8");
  const retainedBytes = retained.length;
  const omittedBytes = evidence.omittedBytes + locallyOmittedBytes;
  const observedBytes = retainedBytes + omittedBytes;
  const truncated = omittedBytes > 0;
  const digestInput = {
    mediaType: evidence.mediaType,
    text: retainedText,
    observedBytes,
    omittedBytes,
    truncated,
  };
  const blinded = {
    ...digestInput,
    retainedBytes,
    digest: benchmarkReviewEvidenceDigest(digestInput, packetSchemaVersion),
  };
  return packetSchemaVersion === 2
    ? BenchmarkReviewPacketV2Schema.shape.patch.parse(blinded)
    : BenchmarkReviewPacketV1Schema.shape.patch.parse(blinded);
}

function blindedReviewPacket(
  reviewPacket: BenchmarkReviewPacketV1,
  replacements: IdentityReplacement[],
  packetSchemaVersion: 1,
): BenchmarkReviewPacketV1;
function blindedReviewPacket(
  reviewPacket: BenchmarkReviewPacketV2,
  replacements: IdentityReplacement[],
  packetSchemaVersion: 2,
): BenchmarkReviewPacketV2;
function blindedReviewPacket(
  reviewPacket: BenchmarkPublicationReviewPacket,
  replacements: IdentityReplacement[],
  packetSchemaVersion: 1 | 2,
): BenchmarkPublicationReviewPacket {
  const evidence = {
    patch: blindedEvidence(reviewPacket.patch, replacements, packetSchemaVersion),
    transcript: blindedEvidence(reviewPacket.transcript, replacements, packetSchemaVersion),
    captureFailures: reviewPacket.captureFailures.map((failure) =>
      blindedPatch(failure, replacements),
    ),
  };
  return packetSchemaVersion === 2
    ? BenchmarkReviewPacketV2Schema.parse({
        schemaVersion: 2,
        hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
        ...evidence,
      })
    : BenchmarkReviewPacketV1Schema.parse({ schemaVersion: 1, ...evidence });
}

type CreateBlindedBenchmarkReviewV1Input = {
  report: BenchmarkReportV3;
  rawReportSha256: string;
  suite: BenchmarkSuite;
  blindingKey: Uint8Array;
};

type CreateBlindedBenchmarkReviewV2Input = {
  report: BenchmarkReportV4;
  rawReportSha256: string;
  suite: BenchmarkSuite;
  blindingKey: Uint8Array;
};

type CreateBlindedBenchmarkReviewInput =
  CreateBlindedBenchmarkReviewV1Input | CreateBlindedBenchmarkReviewV2Input;

function blindedPacketFields(input: {
  report: BenchmarkPublicationReport;
  result: BenchmarkPublicationResult;
  task: BenchmarkSuite["tasks"][number];
  rawReportSha256: string;
  blindingKey: Uint8Array;
  replacements: IdentityReplacement[];
}) {
  const { report, result, task, rawReportSha256, blindingKey, replacements } = input;
  return {
    opaqueId: publicationOpaqueId(report, rawReportSha256, result.trial.trialId, blindingKey),
    task: {
      family: task.family,
      prompt: blindText(task.task, replacements),
      checks: blindValue(task.checks, replacements),
      acceptanceCriteria: blindValue(task.acceptance, replacements),
    },
    outcome: {
      executionStatus: result.executionStatus,
      accepted: result.accepted,
      scorerVerified: result.scorerVerified,
      acceptance: blindValue(result.acceptance, replacements),
      ...(result.interruption
        ? { interruption: blindValue(result.interruption, replacements) }
        : {}),
      limitations: blindValue(result.limitations, replacements),
      failureTrace: blindValue(result.failureTrace, replacements),
    },
  };
}

export function createBlindedBenchmarkReview(
  input: CreateBlindedBenchmarkReviewV2Input,
): BenchmarkBlindedReviewExportV2;
export function createBlindedBenchmarkReview(
  input: CreateBlindedBenchmarkReviewV1Input,
): BenchmarkBlindedReviewExportV1;
export function createBlindedBenchmarkReview(
  input: CreateBlindedBenchmarkReviewInput,
): BenchmarkPublicationExport {
  const suite = BenchmarkSuiteSchema.parse(input.suite);
  const report: BenchmarkPublicationReport =
    input.report.schemaVersion === 4
      ? assertBenchmarkReportEvidence({
          report: BenchmarkReportV4Schema.parse(input.report),
          suite,
        })
      : assertBenchmarkReportEvidence({
          report: BenchmarkReportV3Schema.parse(input.report),
          suite,
        });
  const rawReportSha256 = input.rawReportSha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(rawReportSha256))
    throw new Error("The raw benchmark report SHA-256 digest is invalid");
  const blindingKeyDigest = benchmarkBlindingKeyDigest(input.blindingKey);
  assertPublicationReady(report);
  assertSuiteMatchesReport(suite, report);
  const byTask = new Map(suite.tasks.map((task) => [task.id, task]));
  const taxonomy = {
    version: 1 as const,
    categories: [...BENCHMARK_DEFECT_CATEGORIES],
    severities: [...BENCHMARK_DEFECT_SEVERITIES],
  };
  if (report.schemaVersion === 4) {
    const packets = report.results
      .map((result) => {
        const task = byTask.get(result.trial.taskId);
        if (!task) throw new Error(`Missing suite task for result ${result.trial.taskId}`);
        const replacements = identityReplacements(result);
        return BenchmarkBlindedReviewPacketV2Schema.parse(
          publicationRedactValue({
            schemaVersion: 2,
            hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
            ...blindedPacketFields({
              report,
              result,
              task,
              rawReportSha256,
              blindingKey: input.blindingKey,
              replacements,
            }),
            reviewPacket: blindedReviewPacket(result.reviewPacket, replacements, 2),
          }),
        );
      })
      .sort((left, right) => compareText(left.opaqueId, right.opaqueId));
    return BenchmarkBlindedReviewExportV2Schema.parse({
      schemaVersion: 2,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      reviewPolicy: PORTABLE_BLINDED_REVIEW_POLICY,
      rawReportSha256,
      blindingKeyDigest,
      suite: report.suite,
      taxonomy,
      packets,
    });
  }
  const packets = report.results
    .map((result) => {
      const task = byTask.get(result.trial.taskId);
      if (!task) throw new Error(`Missing suite task for result ${result.trial.taskId}`);
      const replacements = identityReplacements(result);
      return BenchmarkBlindedReviewPacketV1Schema.parse(
        publicationRedactValue({
          schemaVersion: 1,
          ...blindedPacketFields({
            report,
            result,
            task,
            rawReportSha256,
            blindingKey: input.blindingKey,
            replacements,
          }),
          reviewPacket: blindedReviewPacket(
            BenchmarkReviewPacketV1Schema.parse(result.reviewPacket),
            replacements,
            1,
          ),
        }),
      );
    })
    .sort((left, right) => compareText(left.opaqueId, right.opaqueId));
  return BenchmarkBlindedReviewExportV1Schema.parse({
    schemaVersion: 1,
    reviewPolicy: LEGACY_BLINDED_REVIEW_POLICY,
    rawReportSha256,
    blindingKeyDigest,
    suite: report.suite,
    taxonomy,
    packets,
  });
}

type ValidateBenchmarkReviewLabelsV1Input = CreateBlindedBenchmarkReviewV1Input & {
  labels: BenchmarkReviewLabelsV1;
};

type ValidateBenchmarkReviewLabelsV2Input = CreateBlindedBenchmarkReviewV2Input & {
  labels: BenchmarkReviewLabelsV2;
};

type ValidateBenchmarkReviewLabelsInput =
  ValidateBenchmarkReviewLabelsV1Input | ValidateBenchmarkReviewLabelsV2Input;

type BenchmarkReviewLabel = BenchmarkPublicationLabels["labels"][number];

type ValidatedBenchmarkReviewLabelsV1 = {
  blindedReview: BenchmarkBlindedReviewExportV1;
  labels: BenchmarkReviewLabelsV1;
  labelsByOpaqueId: Map<string, BenchmarkReviewLabelsV1["labels"][number]>;
};

type ValidatedBenchmarkReviewLabelsV2 = {
  blindedReview: BenchmarkBlindedReviewExportV2;
  labels: BenchmarkReviewLabelsV2;
  labelsByOpaqueId: Map<string, BenchmarkReviewLabelsV2["labels"][number]>;
};

function validateParsedBenchmarkReviewLabels(
  blindedReview: BenchmarkPublicationExport,
  labels: BenchmarkPublicationLabels,
  hashAlgorithm: CanonicalHashAlgorithm,
): {
  blindedReview: BenchmarkPublicationExport;
  labels: BenchmarkPublicationLabels;
  labelsByOpaqueId: Map<string, BenchmarkReviewLabel>;
} {
  if (labels.rawReportSha256 !== blindedReview.rawReportSha256)
    throw new Error("Review labels do not match the raw benchmark report digest");
  if (labels.blindingKeyDigest !== blindedReview.blindingKeyDigest)
    throw new Error("Review labels do not match the benchmark blinding-key digest");
  if (labels.blindedReviewDigest !== contentHash(blindedReview, hashAlgorithm))
    throw new Error("Review labels do not match the blinded review artifact digest");
  const packets = new Map(blindedReview.packets.map((packet) => [packet.opaqueId, packet]));
  const labelsByOpaqueId = new Map(labels.labels.map((label) => [label.opaqueId, label]));
  if (
    labelsByOpaqueId.size !== packets.size ||
    [...packets].some(([opaqueId]) => !labelsByOpaqueId.has(opaqueId)) ||
    [...labelsByOpaqueId].some(([opaqueId]) => !packets.has(opaqueId))
  )
    throw new Error("Review labels must cover every settled trial exactly once");
  for (const [opaqueId, packet] of packets) {
    if (labelsByOpaqueId.get(opaqueId)!.packetDigest !== contentHash(packet, hashAlgorithm))
      throw new Error(`Review label packet digest does not match ${opaqueId}`);
  }
  return { blindedReview, labels, labelsByOpaqueId };
}

export function validateBenchmarkReviewLabels(
  input: ValidateBenchmarkReviewLabelsV2Input,
): ValidatedBenchmarkReviewLabelsV2;
export function validateBenchmarkReviewLabels(
  input: ValidateBenchmarkReviewLabelsV1Input,
): ValidatedBenchmarkReviewLabelsV1;
export function validateBenchmarkReviewLabels(
  input: ValidateBenchmarkReviewLabelsInput,
): ValidatedBenchmarkReviewLabelsV1 | ValidatedBenchmarkReviewLabelsV2 {
  if (input.report.schemaVersion === 4) {
    if (input.labels.schemaVersion !== 2)
      throw new Error("Schema-4 benchmark reports require schema-2 review labels");
    const labels = BenchmarkReviewLabelsV2Schema.parse(input.labels);
    const blindedReview = createBlindedBenchmarkReview({
      report: input.report,
      rawReportSha256: input.rawReportSha256,
      suite: input.suite,
      blindingKey: input.blindingKey,
    });
    return validateParsedBenchmarkReviewLabels(
      blindedReview,
      labels,
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    ) as ValidatedBenchmarkReviewLabelsV2;
  }
  if (input.labels.schemaVersion !== 1)
    throw new Error("Schema-3 benchmark reports require schema-1 review labels");
  const labels = BenchmarkReviewLabelsV1Schema.parse(input.labels);
  const blindedReview = createBlindedBenchmarkReview({
    report: input.report,
    rawReportSha256: input.rawReportSha256,
    suite: input.suite,
    blindingKey: input.blindingKey,
  });
  return validateParsedBenchmarkReviewLabels(
    blindedReview,
    labels,
    LEGACY_CANONICAL_HASH_ALGORITHM,
  ) as ValidatedBenchmarkReviewLabelsV1;
}

export function wilsonScoreInterval(successes: number, trials: number): WilsonScoreInterval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials < 0)
    throw new Error("Wilson interval inputs must be non-negative integers");
  if (successes < 0 || successes > trials)
    throw new Error("Wilson interval successes must be within the trial count");
  if (trials === 0) return null;
  const proportion = successes / trials;
  const zSquared = WILSON_Z_95 ** 2;
  const denominator = 1 + zSquared / trials;
  const center = (proportion + zSquared / (2 * trials)) / denominator;
  const halfWidth =
    (WILSON_Z_95 / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / trials + zSquared / (4 * trials ** 2));
  return {
    method: "wilson_score",
    confidenceLevel: 0.95,
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
  };
}

function logAddExp(left: number, right: number): number {
  if (left === Number.NEGATIVE_INFINITY) return right;
  if (right === Number.NEGATIVE_INFINITY) return left;
  const maximum = Math.max(left, right);
  return maximum + Math.log(Math.exp(left - maximum) + Math.exp(right - maximum));
}

export function exactMedianInterval(values: number[]): ExactMedianInterval | null {
  if (values.some((value) => !Number.isFinite(value)))
    throw new Error("Median interval values must be finite");
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  let rank = 1;
  let achievedConfidenceLevel = 0;
  let logProbability = -sorted.length * Math.LN2;
  let logCumulativeProbability = Number.NEGATIVE_INFINITY;
  for (let successes = 0; successes < Math.ceil(sorted.length / 2); successes += 1) {
    logCumulativeProbability = logAddExp(logCumulativeProbability, logProbability);
    const coverage = Math.max(0, Math.min(1, 1 - 2 * Math.exp(logCumulativeProbability)));
    const candidate = successes + 1;
    if (candidate === 1) achievedConfidenceLevel = coverage;
    if (coverage < 0.95) break;
    rank = candidate;
    achievedConfidenceLevel = coverage;
    logProbability += Math.log(sorted.length - successes) - Math.log(successes + 1);
  }
  return {
    method: "exact_binomial_order_statistic",
    requestedConfidenceLevel: 0.95,
    achievedConfidenceLevel,
    requestedConfidenceAchieved: achievedConfidenceLevel >= 0.95,
    lower: sorted[rank - 1]!,
    upper: sorted[sorted.length - rank]!,
    sampleSize: sorted.length,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

const MARKDOWN_PUNCTUATION = new Set([
  "!",
  "#",
  "&",
  "(",
  ")",
  "*",
  ".",
  "/",
  ":",
  "<",
  ">",
  "@",
  "[",
  "\\",
  "]",
  "_",
  "`",
  "|",
  "~",
]);

function markdown(value: unknown): string {
  const redacted = publicationRedactString(String(value));
  return [...redacted]
    .map((character) => (MARKDOWN_PUNCTUATION.has(character) ? `\\${character}` : character))
    .join("")
    .replaceAll(/\r\n|\n|\r/gu, "<br>");
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function percentagePoints(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)} pp`;
}

function reduction(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

function duration(value: number): string {
  return `${(value / 1_000).toFixed(2)} s`;
}

function intervalPercentage(interval: WilsonScoreInterval | null): string {
  return interval ? `${percentage(interval.lower)}–${percentage(interval.upper)}` : "n/a";
}

function intervalReduction(interval: ExactMedianInterval | null): string {
  return interval
    ? `${interval.lower.toFixed(1)}%–${interval.upper.toFixed(1)}% (${percentage(
        interval.achievedConfidenceLevel,
      )} exact coverage)`
    : "n/a";
}

const TOKEN_DIMENSIONS = [
  "input",
  "cachedInput",
  "uncachedInput",
  "output",
  "reasoning",
  "total",
] as const;

function tokenDimension(
  results: BenchmarkPublicationResult[],
  dimension: (typeof TOKEN_DIMENSIONS)[number],
): string {
  const reconciled = results.filter(({ usageReconciled }) => usageReconciled);
  if (reconciled.length === 0) return "n/a (0 reconciled)";
  const available = reconciled.filter(
    ({ usage }) => usage.availability[dimension] !== "unavailable",
  );
  const total = available.reduce((sum, { usage }) => sum + usage[dimension], 0);
  return available.length === reconciled.length
    ? String(total)
    : `${total} (${available.length}/${reconciled.length} available)`;
}

function reconciledTokenTotal(results: BenchmarkPublicationResult[]): string {
  const reconciled = results.filter(({ usageReconciled }) => usageReconciled);
  const total = reconciled.reduce((sum, { usage }) => sum + usage.total, 0);
  return `${total} (${reconciled.length}/${results.length} trials)`;
}

function resultKey(result: BenchmarkPublicationResult): string {
  return `${result.trial.host}/${result.trial.mode}/${result.trial.taskId}#${result.trial.repetition}`;
}

type RenderBenchmarkPublicationMarkdownV1Input = ValidateBenchmarkReviewLabelsV1Input & {
  labelsSha256: string;
};

type RenderBenchmarkPublicationMarkdownV2Input = ValidateBenchmarkReviewLabelsV2Input & {
  labelsSha256: string;
};

type RenderBenchmarkPublicationMarkdownInput =
  RenderBenchmarkPublicationMarkdownV1Input | RenderBenchmarkPublicationMarkdownV2Input;

export function renderBenchmarkPublicationMarkdown(
  input: RenderBenchmarkPublicationMarkdownV2Input,
): string;
export function renderBenchmarkPublicationMarkdown(
  input: RenderBenchmarkPublicationMarkdownV1Input,
): string;
export function renderBenchmarkPublicationMarkdown(
  input: RenderBenchmarkPublicationMarkdownInput,
): string {
  const report: BenchmarkPublicationReport =
    input.report.schemaVersion === 4
      ? BenchmarkReportV4Schema.parse(input.report)
      : BenchmarkReportV3Schema.parse(input.report);
  const suite = BenchmarkSuiteSchema.parse(input.suite);
  if (!/^[0-9a-f]{64}$/u.test(input.labelsSha256))
    throw new Error("The review-label file SHA-256 digest is invalid");
  const validated =
    report.schemaVersion === 4
      ? validateBenchmarkReviewLabels({
          report,
          rawReportSha256: input.rawReportSha256,
          suite,
          labels: input.labels,
          blindingKey: input.blindingKey,
        } as ValidateBenchmarkReviewLabelsV2Input)
      : validateBenchmarkReviewLabels({
          report,
          rawReportSha256: input.rawReportSha256,
          suite,
          labels: input.labels,
          blindingKey: input.blindingKey,
        } as ValidateBenchmarkReviewLabelsV1Input);
  const summary = summarizeBenchmark(
    report.results,
    report.schedule,
    report.schemaVersion === 4
      ? { schemaVersion: 4, hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM }
      : { schemaVersion: 3, hashAlgorithm: LEGACY_CANONICAL_HASH_ALGORITHM },
  );
  const hosts = [...new Set(report.schedule.map(({ host }) => host))].sort() as Array<
    "claude" | "codex"
  >;
  const labelFor = (result: BenchmarkPublicationResult) =>
    validated.labelsByOpaqueId.get(
      publicationOpaqueId(
        report,
        validated.blindedReview.rawReportSha256,
        result.trial.trialId,
        input.blindingKey,
      ),
    )!;
  const allDefects = report.results.flatMap((result) =>
    labelFor(result).defects.map((defect) => ({ result, defect })),
  );
  const criticalDefects = allDefects.filter(({ defect }) => defect.severity === "critical");
  const criticalTrials = new Set(criticalDefects.map(({ result }) => result.trial.trialId)).size;
  const blindedReviewDigest = contentHash(
    validated.blindedReview,
    publicationHashAlgorithm(report),
  );
  const reviewerIds = [
    ...new Set(validated.labels.labels.map(({ reviewerId }) => reviewerId)),
  ].sort();
  const allGatesPass = hosts.every((host) => summary[host]!.gate.passes === true);
  const anyGateFails = hosts.some((host) => summary[host]!.gate.passes === false);
  const lines: string[] = [
    `# Graphcraft benchmark report: ${markdown(report.suite.id)} v${report.suite.version}`,
    "",
    "## Provenance",
    "",
    ...(report.schemaVersion === 4
      ? [
          "Publication artifact schema: `2`  ",
          `Canonical hash algorithm: \`${PORTABLE_CANONICAL_HASH_ALGORITHM}\`  `,
        ]
      : []),
    `Raw report byte SHA-256: \`${validated.blindedReview.rawReportSha256}\`  `,
    `Blinding-key digest: \`${validated.blindedReview.blindingKeyDigest}\`  `,
    `Blinded review canonical SHA-256: \`${blindedReviewDigest}\`  `,
    `Review-label file SHA-256: \`${input.labelsSha256}\`  `,
    `Reviewer IDs: ${reviewerIds.map((reviewerId) => `\`${markdown(reviewerId)}\``).join(", ")}`,
    "",
    `**Quantitative benchmark gate (at least 20% median token reduction with no more than a five-point acceptance regression):** ${
      allGatesPass
        ? "PASS for every evaluated host."
        : anyGateFails
          ? "FAIL for at least one evaluated host."
          : "NOT COMPARABLE for at least one evaluated host."
    }`,
    "",
    `**Critical blinded defects:** ${criticalDefects.length} across ${criticalTrials} trial(s).${
      criticalDefects.length > 0
        ? " A passing quantitative gate does not override these findings."
        : ""
    }`,
    "",
    "The quantitative gate is not a stable-release or broader product claim. Defect review is reported separately from scorer acceptance and does not alter the existing efficiency calculation.",
    "",
    "## Controls",
    "",
    `Suite digest: \`${markdown(report.suite.digest)}\`  `,
    `Graphcraft: ${markdown(report.environment.graphcraftVersion)} at \`${markdown(
      report.environment.graphcraftSource?.commitSha ?? "source identity unavailable",
    )}\`  `,
    `Environment: ${markdown(report.environment.platform)}/${markdown(
      report.environment.architecture,
    )}, Node ${markdown(report.environment.nodeVersion)}  `,
    `Shared effort: ${markdown(report.effortPolicy)}; model-call timeout: ${report.modelCallTimeoutMs} ms`,
    "",
    "| Host | Model | Host version(s) | Permission profile |",
    "| --- | --- | --- | --- |",
  ];
  for (const host of hosts) {
    const selected = report.results.filter(({ trial }) => trial.host === host);
    lines.push(
      `| ${host} | ${markdown(report.modelPolicy[host] ?? "unavailable")} | ${markdown(
        [...new Set(selected.map(({ hostVersion }) => hostVersion))].sort().join(", "),
      )} | ${markdown(report.permissionPolicy[host] ?? "unavailable")} |`,
    );
  }

  lines.push(
    "",
    "## Acceptance",
    "",
    "Unsuccessful trials remain in every denominator.",
    "",
    "| Host | Mode | Trials | Accepted | Unsuccessful | Acceptance rate | 95% Wilson interval |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const host of hosts) {
    for (const mode of ["baseline", "graphcraft"] as const) {
      const selected = report.results.filter(
        ({ trial }) => trial.host === host && trial.mode === mode,
      );
      const accepted = selected.filter((result) => result.accepted).length;
      lines.push(
        `| ${host} | ${mode} | ${selected.length} | ${accepted} | ${
          selected.length - accepted
        } | ${selected.length > 0 ? percentage(accepted / selected.length) : "n/a"} | ${intervalPercentage(
          wilsonScoreInterval(accepted, selected.length),
        )} |`,
      );
    }
  }

  const taskFamily = new Map(suite.tasks.map((task) => [task.id, task.family]));
  lines.push(
    "",
    "## Per-task results",
    "",
    "Unsuccessful trials remain in the task totals; reconciled token totals state their exact trial coverage.",
    "",
    "| Task | Family | Host | Mode | Trials | Accepted | Reconciled total tokens | Median duration | Defects (critical) | Interventions |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const taskId of [...taskFamily.keys()].sort()) {
    for (const host of hosts) {
      for (const mode of ["baseline", "graphcraft"] as const) {
        const selected = report.results.filter(
          ({ trial }) => trial.taskId === taskId && trial.host === host && trial.mode === mode,
        );
        if (selected.length === 0) continue;
        const defects = selected.flatMap((result) => labelFor(result).defects);
        lines.push(
          `| ${markdown(taskId)} | ${taskFamily.get(taskId)} | ${host} | ${mode} | ${
            selected.length
          } | ${selected.filter(({ accepted }) => accepted).length} | ${reconciledTokenTotal(
            selected,
          )} | ${duration(median(selected.map(({ durationMs }) => durationMs))!)} | ${
            defects.length
          } (${defects.filter(({ severity }) => severity === "critical").length}) | ${selected.reduce(
            (sum, { humanInterventions }) => sum + humanInterventions,
            0,
          )} |`,
        );
      }
    }
  }

  lines.push(
    "",
    "## Blinded defect review",
    "",
    `Reviewed trials: ${report.results.length}/${report.results.length}. Trials with defects: ${
      report.results.filter((result) => labelFor(result).verdict === "defect").length
    }. Total defects: ${allDefects.length}.`,
    "",
    "| Severity | Count |",
    "| --- | ---: |",
    ...BENCHMARK_DEFECT_SEVERITIES.map(
      (severity) =>
        `| ${severity} | ${allDefects.filter(({ defect }) => defect.severity === severity).length} |`,
    ),
    "",
    "| Category | Count |",
    "| --- | ---: |",
    ...BENCHMARK_DEFECT_CATEGORIES.map(
      (category) =>
        `| ${category} | ${allDefects.filter(({ defect }) => defect.category === category).length} |`,
    ),
  );
  if (allDefects.length > 0) {
    lines.push(
      "",
      "| Trial | Reviewer | Category | Severity | Finding |",
      "| --- | --- | --- | --- | --- |",
      ...allDefects
        .sort((left, right) => {
          const severityOrder = { critical: 0, major: 1, minor: 2 } as const;
          return (
            severityOrder[left.defect.severity] - severityOrder[right.defect.severity] ||
            compareText(resultKey(left.result), resultKey(right.result))
          );
        })
        .map(
          ({ result, defect }) =>
            `| ${markdown(resultKey(result))} | ${markdown(
              labelFor(result).reviewerId,
            )} | ${defect.category} | ${defect.severity} | ${markdown(defect.summary)} |`,
        ),
    );
  }

  lines.push(
    "",
    "## Reconciled token dimensions",
    "",
    "Only trials whose total usage reconciled are aggregated. A partial availability count is shown instead of silently treating an unavailable dimension as zero.",
    "",
    "| Host | Mode | Reconciled trials | Input | Cached input | Uncached input | Output | Reasoning | Total |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const host of hosts) {
    for (const mode of ["baseline", "graphcraft"] as const) {
      const selected = report.results.filter(
        ({ trial }) => trial.host === host && trial.mode === mode,
      );
      lines.push(
        `| ${host} | ${mode} | ${selected.filter(({ usageReconciled }) => usageReconciled).length}/${
          selected.length
        } | ${TOKEN_DIMENSIONS.map((dimension) => tokenDimension(selected, dimension)).join(
          " | ",
        )} |`,
      );
    }
  }

  lines.push(
    "",
    "## Matched token reduction and existing gate",
    "",
    "| Host | Accepted pairs | Task coverage | Median paired reduction | Exact median interval | Acceptance delta | Existing gate |",
    "| --- | ---: | --- | ---: | --- | ---: | --- |",
  );
  for (const host of hosts) {
    const hostSummary = summary[host]!;
    const taskReductions = Object.values(hostSummary.matchedAccepted.byTask).flatMap(
      ({ medianPairReductionPercent }) =>
        medianPairReductionPercent === null ? [] : [medianPairReductionPercent],
    );
    lines.push(
      `| ${host} | ${hostSummary.matchedAccepted.pairs} | ${
        hostSummary.matchedAccepted.coveredTasks
      }/${hostSummary.matchedAccepted.totalTasks} | ${reduction(
        hostSummary.gate.tokenReductionPercent,
      )} | ${intervalReduction(exactMedianInterval(taskReductions))} | ${percentagePoints(
        hostSummary.gate.acceptanceDeltaPoints,
      )} | ${
        hostSummary.gate.passes === true
          ? "PASS"
          : hostSummary.gate.passes === false
            ? "FAIL"
            : "NOT COMPARABLE"
      } |`,
    );
  }

  lines.push(
    "",
    "## Duration and human intervention",
    "",
    "| Host | Mode | Trials | Total duration | Median duration | Exact median interval | Human interventions |",
    "| --- | --- | ---: | ---: | ---: | --- | ---: |",
  );
  for (const host of hosts) {
    for (const mode of ["baseline", "graphcraft"] as const) {
      const selected = report.results.filter(
        ({ trial }) => trial.host === host && trial.mode === mode,
      );
      const durations = selected.map(({ durationMs }) => durationMs);
      const durationInterval = exactMedianInterval(durations);
      lines.push(
        `| ${host} | ${mode} | ${selected.length} | ${duration(
          durations.reduce((sum, value) => sum + value, 0),
        )} | ${duration(median(durations) ?? 0)} | ${
          durationInterval
            ? `${duration(durationInterval.lower)}–${duration(
                durationInterval.upper,
              )} (${percentage(durationInterval.achievedConfidenceLevel)} exact coverage)`
            : "n/a"
        } | ${selected.reduce((sum, { humanInterventions }) => sum + humanInterventions, 0)} |`,
      );
    }
  }

  const unsuccessful = report.results.filter((result) => !result.accepted);
  lines.push(
    "",
    "## Failures and interruptions",
    "",
    "| Execution status | Count |",
    "| --- | ---: |",
    ...["completed", "blocked", "failed", "error", "interrupted", "timed_out"].map(
      (status) =>
        `| ${status} | ${report.results.filter(({ executionStatus }) => executionStatus === status).length} |`,
    ),
    "",
  );
  if (unsuccessful.length === 0) {
    lines.push("No unsuccessful trials were recorded.");
  } else {
    lines.push(
      "| Trial | Status | Interruption | Failure evidence |",
      "| --- | --- | --- | --- |",
      ...unsuccessful
        .sort((left, right) => compareText(resultKey(left), resultKey(right)))
        .map(
          (result) =>
            `| ${markdown(resultKey(result))} | ${result.executionStatus} | ${markdown(
              result.interruption
                ? `${result.interruption.cause}; ${result.interruption.childSettlement}; ${result.interruption.reason}`
                : "none",
            )} | ${markdown(
              result.failureTrace.length > 0
                ? result.failureTrace.join("; ")
                : "No failure trace recorded",
            )} |`,
        ),
    );
  }

  const limitations = [
    ...report.limitations,
    ...report.results.flatMap(({ limitations: trialLimitations }) => trialLimitations),
    "Human-intervention counts are harness-recorded values and are not an independent observational audit.",
    "Defect labels are blinded adjudications and remain separate from deterministic scorer acceptance.",
  ];
  lines.push(
    "",
    "## Limitations",
    "",
    ...[...new Set(limitations)].sort().map((limitation) => `- ${markdown(limitation)}`),
    "",
    "## Statistical uncertainty",
    "",
    "Acceptance intervals are two-sided 95% Wilson score intervals over all trials in each host/mode cell, including unsuccessful runs.",
    "",
    "Median intervals use the exact two-sided binomial order-statistic method. Task-level paired token reductions are the independent units for the reduction interval; trial durations are the units for duration intervals. The renderer chooses the narrowest interval with at least 95% exact coverage when the sample size permits it, otherwise reports the widest attainable interval and its achieved coverage.",
    "",
    "No p-values or causal claims are inferred from these intervals.",
    "",
  );
  return publicationRedactString(lines.join("\n"));
}

async function canonicalTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await realpath(dirname(absolute)).catch(() => resolve(dirname(absolute)));
    return join(parent, basename(absolute));
  }
}

async function assertDistinctOutput(outputPath: string, protectedPaths: string[]): Promise<void> {
  const output = await canonicalTarget(outputPath);
  for (const protectedPath of protectedPaths) {
    if (output === (await canonicalTarget(protectedPath)))
      throw new Error("Derived benchmark output must not replace an input artifact");
  }
}

async function assertCreateOnlyOutput(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Derived benchmark output already exists; refusing to overwrite: ${path}`);
}

async function writeTextCreateOnly(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await assertCreateOnlyOutput(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    let publishedIdentity: { device: bigint; inode: bigint } | undefined;
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
      const status = await handle.stat({ bigint: true });
      if (!status.isFile() || status.nlink !== 1n)
        throw new Error(`Benchmark temporary output is not a private regular file: ${path}`);
      publishedIdentity = { device: status.dev, inode: status.ino };
    } finally {
      await handle.close();
    }
    if (publishedIdentity === undefined)
      throw new Error(`Benchmark temporary output identity is unavailable: ${path}`);
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(`Derived benchmark output already exists; refusing to overwrite: ${path}`);
      throw error;
    }
    await unlink(temporaryPath);
    const published = await lstat(path, { bigint: true });
    if (published.isSymbolicLink() || !published.isFile() || published.nlink !== 1n)
      throw new Error(`Derived benchmark output is not a private regular file: ${path}`);
    if (
      publishedIdentity.inode !== 0n &&
      (published.dev !== publishedIdentity.device || published.ino !== publishedIdentity.inode)
    )
      throw new Error(`Derived benchmark output identity changed during publication: ${path}`);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeJsonCreateOnly(
  path: string,
  value: unknown,
  hashAlgorithm: CanonicalHashAlgorithm,
): Promise<void> {
  const redacted = publicationRedactValue(value);
  if (contentHash(redacted, hashAlgorithm) !== contentHash(value, hashAlgorithm))
    throw new Error("Blinded benchmark artifact changed during final redaction");
  await writeTextCreateOnly(path, `${JSON.stringify(redacted, null, 2)}\n`);
}

export async function exportBlindedBenchmarkReview(input: {
  reportPath: string;
  suite: BenchmarkSuite;
  blindingKey: Uint8Array;
  outputPath: string;
}): Promise<{
  outputPath: string;
  rawReportSha256: string;
  blindingKeyDigest: string;
  blindedReviewDigest: string;
  packetCount: number;
}> {
  const loaded = await loadVersionedBenchmarkReportForPublication(input.reportPath);
  const blindingKey = Buffer.from(input.blindingKey);
  try {
    const outputPath = resolve(input.outputPath);
    await assertDistinctOutput(outputPath, [loaded.path]);
    await assertCreateOnlyOutput(outputPath);
    const artifact =
      loaded.report.schemaVersion === 4
        ? createBlindedBenchmarkReview({
            report: loaded.report,
            rawReportSha256: loaded.rawReportSha256,
            suite: input.suite,
            blindingKey,
          })
        : createBlindedBenchmarkReview({
            report: loaded.report,
            rawReportSha256: loaded.rawReportSha256,
            suite: input.suite,
            blindingKey,
          });
    const hashAlgorithm = publicationHashAlgorithm(loaded.report);
    await writeJsonCreateOnly(outputPath, artifact, hashAlgorithm);
    return {
      outputPath,
      rawReportSha256: loaded.rawReportSha256,
      blindingKeyDigest: benchmarkBlindingKeyDigest(blindingKey),
      blindedReviewDigest: contentHash(artifact, hashAlgorithm),
      packetCount: artifact.packets.length,
    };
  } finally {
    blindingKey.fill(0);
  }
}

export async function renderBenchmarkPublicationReport(input: {
  reportPath: string;
  suite: BenchmarkSuite;
  blindingKey: Uint8Array;
  labelsPath: string;
  outputPath: string;
}): Promise<{
  outputPath: string;
  rawReportSha256: string;
  blindingKeyDigest: string;
  blindedReviewDigest: string;
  labelsSha256: string;
  reportSha256: string;
}> {
  const [loaded, loadedLabels] = await Promise.all([
    loadVersionedBenchmarkReportForPublication(input.reportPath),
    loadVersionedBenchmarkReviewLabelsArtifact(input.labelsPath),
  ]);
  if (loaded.report.schemaVersion === 4 && loadedLabels.labels.schemaVersion !== 2)
    throw new Error("Schema-4 benchmark reports require schema-2 review labels");
  if (loaded.report.schemaVersion === 3 && loadedLabels.labels.schemaVersion !== 1)
    throw new Error("Schema-3 benchmark reports require schema-1 review labels");
  const blindingKey = Buffer.from(input.blindingKey);
  try {
    const outputPath = resolve(input.outputPath);
    await assertDistinctOutput(outputPath, [loaded.path, loadedLabels.path]);
    await assertCreateOnlyOutput(outputPath);
    const rendered =
      loaded.report.schemaVersion === 4 && loadedLabels.labels.schemaVersion === 2
        ? renderBenchmarkPublicationMarkdown({
            report: loaded.report,
            rawReportSha256: loaded.rawReportSha256,
            suite: input.suite,
            labels: loadedLabels.labels,
            labelsSha256: loadedLabels.labelsSha256,
            blindingKey,
          })
        : renderBenchmarkPublicationMarkdown({
            report: BenchmarkReportV3Schema.parse(loaded.report),
            rawReportSha256: loaded.rawReportSha256,
            suite: input.suite,
            labels: BenchmarkReviewLabelsV1Schema.parse(loadedLabels.labels),
            labelsSha256: loadedLabels.labelsSha256,
            blindingKey,
          });
    await writeTextCreateOnly(outputPath, rendered);
    return {
      outputPath,
      rawReportSha256: loaded.rawReportSha256,
      blindingKeyDigest: benchmarkBlindingKeyDigest(blindingKey),
      blindedReviewDigest: loadedLabels.labels.blindedReviewDigest,
      labelsSha256: loadedLabels.labelsSha256,
      reportSha256: rawSha256(rendered),
    };
  } finally {
    blindingKey.fill(0);
  }
}
