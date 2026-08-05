/**
 * Scaffold a benchmark review-labels file from a blinded review export.
 *
 * Usage:
 *   pnpm tsx scripts/benchmark-review-scaffold.ts <blinded-review.json> \
 *     --reviewer <id> --output review-labels.json [--packets-dir <dir>]
 *   pnpm tsx scripts/benchmark-review-scaffold.ts --self-check
 *
 * Emits a labels template with every digest prefilled and `verdict` left as a
 * placeholder that fails schema validation, so an unfinished file is rejected
 * fail-closed by `graphcraft benchmark-report`. Optionally dumps each packet's
 * task summary, patch, and transcript into per-packet directories for review.
 * All outputs are create-only. This script is a local reviewer aid and is not
 * part of the published package.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  BenchmarkBlindedReviewExportV2Schema,
  BenchmarkReviewLabelsV2Schema,
} from "../packages/core/src/benchmark-publication.ts";
import { PORTABLE_CANONICAL_HASH_ALGORITHM, contentHash } from "../packages/core/src/canonical.ts";

const VERDICT_PLACEHOLDER = "TODO_no_defect_or_defect";
const REVIEWER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type BlindedReview = ReturnType<typeof BenchmarkBlindedReviewExportV2Schema.parse>;

function buildLabelsTemplate(blindedReview: BlindedReview, reviewerId: string) {
  return {
    schemaVersion: 2 as const,
    hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
    reviewPolicy: "opaque_blinded_review_v2" as const,
    taxonomyVersion: 1 as const,
    rawReportSha256: blindedReview.rawReportSha256,
    blindingKeyDigest: blindedReview.blindingKeyDigest,
    blindedReviewDigest: contentHash(blindedReview, PORTABLE_CANONICAL_HASH_ALGORITHM),
    labels: blindedReview.packets.map((packet) => ({
      opaqueId: packet.opaqueId,
      packetDigest: contentHash(packet, PORTABLE_CANONICAL_HASH_ALGORITHM),
      reviewed: true as const,
      reviewerId,
      verdict: VERDICT_PLACEHOLDER,
      defects: [],
    })),
  };
}

function packetTaskMarkdown(packet: BlindedReview["packets"][number]): string {
  const { task, outcome, reviewPacket } = packet;
  const evidenceNote = (label: string, evidence: { truncated: boolean; omittedBytes: number }) =>
    evidence.truncated ? `${label} truncated: ${evidence.omittedBytes} bytes omitted` : undefined;
  const notes = [
    evidenceNote("patch", reviewPacket.patch),
    evidenceNote("transcript", reviewPacket.transcript),
    ...reviewPacket.captureFailures.map((failure) => `capture failure: ${failure}`),
  ].filter(Boolean);
  return [
    `# ${packet.opaqueId}`,
    ``,
    `- family: ${task.family}`,
    `- executionStatus: ${outcome.executionStatus}`,
    `- accepted: ${outcome.accepted}`,
    `- scorerVerified: ${outcome.scorerVerified}`,
    ``,
    `## Prompt`,
    ``,
    task.prompt,
    ``,
    `## Checks`,
    ``,
    "```json",
    JSON.stringify(task.checks, null, 2),
    "```",
    ``,
    `## Acceptance criteria`,
    ``,
    "```json",
    JSON.stringify(task.acceptanceCriteria, null, 2),
    "```",
    ``,
    `## Outcome`,
    ``,
    "```json",
    JSON.stringify(outcome, null, 2),
    "```",
    ...(notes.length ? [``, `## Evidence notes`, ``, ...notes.map((note) => `- ${note}`)] : []),
    ``,
  ].join("\n");
}

function dumpPackets(blindedReview: BlindedReview, packetsDir: string): void {
  mkdirSync(packetsDir);
  for (const packet of blindedReview.packets) {
    const directory = join(packetsDir, packet.opaqueId);
    mkdirSync(directory);
    writeFileSync(join(directory, "task.md"), packetTaskMarkdown(packet), { flag: "wx" });
    writeFileSync(join(directory, "patch.diff"), packet.reviewPacket.patch.text, { flag: "wx" });
    writeFileSync(join(directory, "transcript.ndjson"), packet.reviewPacket.transcript.text, {
      flag: "wx",
    });
  }
}

function selfCheck(): void {
  const rejected = BenchmarkBlindedReviewExportV2Schema.safeParse({ schemaVersion: 1 });
  if (rejected.success) throw new Error("self-check: non-v2 input was not rejected");
  const fakeBlinded = {
    rawReportSha256: "0".repeat(64),
    blindingKeyDigest: "1".repeat(64),
    packets: [{ opaqueId: `packet-${"a".repeat(32)}` }],
  } as unknown as BlindedReview;
  const template = buildLabelsTemplate(fakeBlinded, "self-check");
  const placeholderAccepted = BenchmarkReviewLabelsV2Schema.safeParse(template);
  if (placeholderAccepted.success)
    throw new Error("self-check: placeholder verdict unexpectedly passed schema validation");
  BenchmarkReviewLabelsV2Schema.parse({
    ...template,
    labels: template.labels.map((label) => ({ ...label, verdict: "no_defect" })),
  });
  console.log("self-check passed");
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    reviewer: { type: "string" },
    output: { type: "string" },
    "packets-dir": { type: "string" },
    "self-check": { type: "boolean" },
  },
});

if (values["self-check"]) {
  selfCheck();
} else {
  const [inputPath] = positionals;
  if (!inputPath || !values.reviewer || !values.output)
    throw new Error(
      "Usage: benchmark-review-scaffold.ts <blinded-review.json> --reviewer <id> --output <labels.json> [--packets-dir <dir>]",
    );
  if (!REVIEWER_ID_PATTERN.test(values.reviewer))
    throw new Error(`Reviewer ID must match ${REVIEWER_ID_PATTERN}`);
  const blindedReview = BenchmarkBlindedReviewExportV2Schema.parse(
    JSON.parse(readFileSync(inputPath, "utf8")),
  );
  const template = buildLabelsTemplate(blindedReview, values.reviewer);
  writeFileSync(values.output, `${JSON.stringify(template, null, 2)}\n`, { flag: "wx" });
  if (values["packets-dir"]) dumpPackets(blindedReview, values["packets-dir"]);
  console.log(
    `Scaffolded ${template.labels.length} labels; replace every "${VERDICT_PLACEHOLDER}" with no_defect or defect (with defects[] entries).`,
  );
}
