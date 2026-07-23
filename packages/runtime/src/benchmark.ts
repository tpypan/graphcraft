import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import {
  BenchmarkSuiteSchema,
  BenchmarkScheduleEntrySchema,
  BenchmarkReportSchema,
  BenchmarkReviewPacketSchema,
  BenchmarkSourceIdentitySchema,
  BenchmarkTrialResultSchema,
  BENCHMARK_REVIEW_PATCH_LIMIT_BYTES,
  BENCHMARK_REVIEW_TRANSCRIPT_LIMIT_BYTES,
  ContextCapsuleSchema,
  HostCapabilityAdmissionError,
  HostEventSchema,
  RequiredHostCapabilityDiagnosticSchema,
  aggregateTokenUsage,
  assertRequiredHostCapabilities,
  contentHash,
  createBenchmarkSchedule,
  summarizeBenchmark,
  unavailableTokenUsage,
  type BenchmarkScheduleEntry,
  type BenchmarkReport,
  type BenchmarkPermissionPolicy,
  type BenchmarkReviewPacket,
  type BenchmarkSourceIdentity,
  type BenchmarkSuite,
  type BenchmarkTask,
  type BenchmarkTrialResult,
  type HostAdapter,
  type HostExecutionPolicy,
  type RunEvent,
  type TokenUsage,
} from "@graphcraft/core";
import { runProcess } from "@graphcraft/probes";
import { createRun, executeRun } from "./runner.ts";
import { writeJsonAtomic } from "./json.ts";
import { redactString, redactValue } from "./redaction.ts";

const tokenDimensions = [
  "input",
  "cachedInput",
  "uncachedInput",
  "output",
  "reasoning",
  "total",
] as const;
const scorerPolicy = "fixture_bound_scorers_plus_suite_assertions" as const;
const reviewPolicy = "bounded_redacted_patch_and_transcript_v1" as const;
const PATCH_PROCESS_CAPTURE_LIMIT_BYTES = 2 * BENCHMARK_REVIEW_PATCH_LIMIT_BYTES;
const TRANSCRIPT_OMISSION_MARKER = Buffer.from(
  "\n[GRAPHCRAFT REVIEW EVIDENCE MIDDLE OMITTED]\n",
  "utf8",
);
const TRANSCRIPT_INCOMPLETE_FAILURE =
  "transcript review evidence exceeded its retained bound; review is incomplete";
const reportLimitations = [
  "Stable efficiency claims require at least three jointly accepted reconciled baseline/Graphcraft pairs per task and host.",
  "Each trial retains a bounded redacted patch and transcript packet; blinded reviewer assignment and defect labels remain external.",
];

function persistedCapabilityAdmissionError(
  events: readonly RunEvent[],
): HostCapabilityAdmissionError | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const parsed = RequiredHostCapabilityDiagnosticSchema.safeParse(
      events[index]!.data.capabilityDiagnostic,
    );
    if (parsed.success && !parsed.data.ready) return new HostCapabilityAdmissionError(parsed.data);
  }
  return undefined;
}

function benchmarkPermissionPolicy(host: "codex" | "claude"): BenchmarkPermissionPolicy {
  return host === "codex"
    ? "codex_workspace_write_shell_external_not_graphcraft_enforced"
    : "claude_accept_edits_bash_external_not_graphcraft_enforced";
}

function safeFixturePath(root: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    throw new Error(`Benchmark fixture path is unsafe: ${path}`);
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
    throw new Error(`Benchmark fixture path escapes its repository: ${path}`);
  return resolved;
}

function reviewEvidenceDigest(input: {
  mediaType: "text/x-diff" | "application/x-ndjson";
  text: string;
  observedBytes: number;
  omittedBytes: number;
  truncated: boolean;
}): string {
  return contentHash(input);
}

function utf8Prefix(buffer: Buffer, maximumBytes: number): Buffer {
  const candidate = buffer.subarray(0, Math.min(buffer.length, maximumBytes));
  for (let trim = 0; trim <= Math.min(3, candidate.length); trim += 1) {
    const end = candidate.length - trim;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(candidate.subarray(0, end));
      return candidate.subarray(0, end);
    } catch {
      // A byte boundary can split one UTF-8 code point.
    }
  }
  return candidate;
}

function utf8Suffix(buffer: Buffer, maximumBytes: number): Buffer {
  const start = Math.max(0, buffer.length - maximumBytes);
  const candidate = buffer.subarray(start);
  for (let trim = 0; trim <= Math.min(3, candidate.length); trim += 1) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(candidate.subarray(trim));
      return candidate.subarray(trim);
    } catch {
      // A byte boundary can split one UTF-8 code point.
    }
  }
  return candidate;
}

function boundedReviewEvidence(
  mediaType: "text/x-diff" | "application/x-ndjson",
  value: string,
  capture: { observedBytes?: number; omittedBytes?: number } = {},
) {
  const redacted = redactString(value);
  const source = Buffer.from(redacted, "utf8");
  const limit =
    mediaType === "text/x-diff"
      ? BENCHMARK_REVIEW_PATCH_LIMIT_BYTES
      : BENCHMARK_REVIEW_TRANSCRIPT_LIMIT_BYTES;
  const externallyOmitted = capture.omittedBytes ?? 0;
  let text = redacted;
  let locallyOmitted = 0;
  if (source.length > limit) {
    const marker = Buffer.from("\n[GRAPHCRAFT REVIEW EVIDENCE MIDDLE OMITTED]\n", "utf8");
    const available = limit - marker.length;
    const head = utf8Prefix(source, Math.floor(available / 2));
    const tail = utf8Suffix(source, available - head.length);
    locallyOmitted = Math.max(0, source.length - head.length - tail.length);
    text = Buffer.concat([head, marker, tail]).toString("utf8");
  }
  const retainedBytes = Buffer.byteLength(text);
  const omittedBytes = externallyOmitted + locallyOmitted;
  const observedBytes = Math.max(capture.observedBytes ?? source.length, retainedBytes);
  const truncated = omittedBytes > 0;
  return {
    mediaType,
    text,
    observedBytes,
    retainedBytes,
    omittedBytes,
    truncated,
    digest: reviewEvidenceDigest({ mediaType, text, observedBytes, omittedBytes, truncated }),
  };
}

class BoundedTranscriptCapture {
  private complete = Buffer.alloc(0);
  private head: Buffer | undefined;
  private tail = Buffer.alloc(0);
  private observedBytes = 0;

  append(entry: unknown): void {
    const serialized = JSON.stringify(redactValue(entry)) ?? "null";
    const chunk = Buffer.from(`${redactString(serialized)}\n`, "utf8");
    this.observedBytes += chunk.length;
    if (
      !this.head &&
      this.complete.length + chunk.length <= BENCHMARK_REVIEW_TRANSCRIPT_LIMIT_BYTES
    ) {
      this.complete = Buffer.concat([this.complete, chunk]);
      return;
    }

    const retainedContentBytes =
      BENCHMARK_REVIEW_TRANSCRIPT_LIMIT_BYTES - TRANSCRIPT_OMISSION_MARKER.length;
    const headBytes = Math.floor(retainedContentBytes / 2);
    if (!this.head) {
      const headSource =
        this.complete.length >= headBytes
          ? this.complete
          : Buffer.concat([this.complete, utf8Prefix(chunk, headBytes - this.complete.length)]);
      this.head = Buffer.from(utf8Prefix(headSource, headBytes));
      const tailSource =
        chunk.length >= retainedContentBytes
          ? chunk
          : Buffer.concat([utf8Suffix(this.complete, retainedContentBytes), chunk]);
      this.tail = Buffer.from(utf8Suffix(tailSource, retainedContentBytes));
      this.complete = Buffer.alloc(0);
      return;
    }

    const tailSource =
      chunk.length >= retainedContentBytes ? chunk : Buffer.concat([this.tail, chunk]);
    this.tail = Buffer.from(utf8Suffix(tailSource, retainedContentBytes));
  }

  evidence() {
    if (!this.head) {
      const text = this.complete.toString("utf8");
      return {
        mediaType: "application/x-ndjson" as const,
        text,
        observedBytes: this.observedBytes,
        retainedBytes: this.complete.length,
        omittedBytes: 0,
        truncated: false,
        digest: reviewEvidenceDigest({
          mediaType: "application/x-ndjson",
          text,
          observedBytes: this.observedBytes,
          omittedBytes: 0,
          truncated: false,
        }),
      };
    }
    const retainedContentBytes =
      BENCHMARK_REVIEW_TRANSCRIPT_LIMIT_BYTES - TRANSCRIPT_OMISSION_MARKER.length;
    const tail = utf8Suffix(this.tail, retainedContentBytes - this.head.length);
    const text = Buffer.concat([this.head, TRANSCRIPT_OMISSION_MARKER, tail]).toString("utf8");
    const retainedBytes = Buffer.byteLength(text);
    const omittedBytes = Math.max(0, this.observedBytes - this.head.length - tail.length);
    return {
      mediaType: "application/x-ndjson" as const,
      text,
      observedBytes: this.observedBytes,
      retainedBytes,
      omittedBytes,
      truncated: true,
      digest: reviewEvidenceDigest({
        mediaType: "application/x-ndjson",
        text,
        observedBytes: this.observedBytes,
        omittedBytes,
        truncated: true,
      }),
    };
  }
}

async function capturePatch(repository: string, baseSha: string) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "graphcraft-benchmark-review-index-"));
  const environment = { GIT_INDEX_FILE: join(temporaryRoot, "index") };
  try {
    const initialized = await runProcess("git", ["read-tree", baseSha], {
      cwd: repository,
      env: environment,
    });
    if (initialized.exitCode !== 0)
      throw new Error(`temporary review index initialization exited ${initialized.exitCode}`);
    const staged = await runProcess("git", ["add", "--all", "--", "."], {
      cwd: repository,
      env: environment,
    });
    if (staged.exitCode !== 0)
      throw new Error(`temporary review index staging exited ${staged.exitCode}`);
    const ignored = await runProcess(
      "git",
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "--no-empty-directory",
        "-z",
        "--",
        ".",
      ],
      {
        cwd: repository,
        env: environment,
        maxOutputBytesPerStream: PATCH_PROCESS_CAPTURE_LIMIT_BYTES,
        outputOverflow: "truncate",
      },
    );
    if (ignored.exitCode !== 0)
      throw new Error(`ignored review inventory exited ${ignored.exitCode}`);
    const ignoredEntries = ignored.stdout.split("\0").filter(Boolean).length;
    const ignoredInventoryTruncated = ignored.capture.stdout.omittedBytes > 0;
    const numstat = await runProcess(
      "git",
      ["diff", "--cached", "--numstat", "-z", "--no-ext-diff", "--no-textconv", baseSha, "--"],
      {
        cwd: repository,
        env: environment,
        maxOutputBytesPerStream: PATCH_PROCESS_CAPTURE_LIMIT_BYTES,
        outputOverflow: "truncate",
      },
    );
    if (numstat.exitCode !== 0) throw new Error(`review diff inventory exited ${numstat.exitCode}`);
    if (numstat.capture.stdout.omittedBytes > 0)
      throw new Error("review diff inventory exceeded its capture bound");
    const binaryChanges = numstat.stdout
      .split("\0")
      .filter((entry) => entry.startsWith("-\t-\t")).length;
    const diff = await runProcess(
      "git",
      ["diff", "--cached", "--full-index", "--no-ext-diff", "--no-textconv", baseSha, "--"],
      {
        cwd: repository,
        env: environment,
        maxOutputBytesPerStream: PATCH_PROCESS_CAPTURE_LIMIT_BYTES,
        outputOverflow: "truncate",
      },
    );
    if (diff.exitCode !== 0) throw new Error(`review diff exited ${diff.exitCode}`);
    const evidence = boundedReviewEvidence("text/x-diff", diff.stdout, {
      observedBytes: diff.capture.stdout.observedBytes,
      omittedBytes: diff.capture.stdout.omittedBytes,
    });
    return {
      evidence,
      captureFailures: [
        ...(ignoredEntries > 0 || ignoredInventoryTruncated
          ? [
              ignoredInventoryTruncated
                ? "ignored untracked payloads were omitted and their inventory exceeded its capture bound; review is incomplete"
                : `ignored untracked payload omitted for ${ignoredEntries} ${ignoredEntries === 1 ? "entry" : "entries"}; review is incomplete`,
            ]
          : []),
        ...(binaryChanges > 0
          ? [
              `binary patch payload omitted for ${binaryChanges} changed ${binaryChanges === 1 ? "file" : "files"}; review is incomplete`,
            ]
          : []),
        ...(evidence.truncated
          ? ["patch review evidence exceeded its retained bound; review is incomplete"]
          : []),
      ],
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function captureReviewPacket(input: {
  repository: string;
  baseSha: string;
  transcript: BoundedTranscriptCapture;
  captureFailures?: string[];
}): Promise<BenchmarkReviewPacket> {
  const captureFailures = [...(input.captureFailures ?? [])];
  let patch;
  try {
    const captured = await capturePatch(input.repository, input.baseSha);
    patch = captured.evidence;
    captureFailures.push(...captured.captureFailures);
  } catch (error) {
    const failure = `patch capture failed: ${error instanceof Error ? error.message : String(error)}`;
    captureFailures.push(failure);
    patch = boundedReviewEvidence("text/x-diff", `[GRAPHCRAFT ${failure}]\n`);
  }
  const transcript = input.transcript.evidence();
  if (transcript.truncated) captureFailures.push(TRANSCRIPT_INCOMPLETE_FAILURE);
  return BenchmarkReviewPacketSchema.parse({
    schemaVersion: 1,
    patch,
    transcript,
    captureFailures: captureFailures.map((failure) => redactString(failure)),
  });
}

export async function inspectBenchmarkSourceIdentity(
  repositoryPath: string,
): Promise<BenchmarkSourceIdentity> {
  const repository = resolve(repositoryPath);
  const head = await runProcess("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: repository,
  });
  const commitSha = head.stdout.trim().toLowerCase();
  if (head.exitCode !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitSha))
    throw new Error("Unable to bind the benchmark to an exact Graphcraft source commit");
  const status = await runProcess(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude)dist/graphcraft.mjs",
      ":(exclude)dist/graphcraft.mjs.map",
      ":(exclude)dist/mcp.mjs",
      ":(exclude)dist/mcp.mjs.map",
    ],
    { cwd: repository },
  );
  if (status.exitCode !== 0) throw new Error("Unable to inspect Graphcraft source dirty state");
  const dirty = status.stdout.length > 0;
  return BenchmarkSourceIdentitySchema.parse({
    commitSha,
    dirty,
    dirtyStatusDigest: dirty ? contentHash(status.stdout) : null,
  });
}

export async function loadBenchmarkSuite(path: string): Promise<BenchmarkSuite> {
  return BenchmarkSuiteSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
}

async function materializeTask(task: BenchmarkTask): Promise<{
  repository: string;
  repositoryDigest: string;
  baseSha: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), `graphcraft-benchmark-${task.id}-`));
  try {
    for (const [path, value] of Object.entries(task.initialFiles)) {
      const target = safeFixturePath(repository, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, value, "utf8");
    }
    const initialized = await runProcess("git", ["init", "-b", "main"], { cwd: repository });
    if (initialized.exitCode !== 0) throw new Error(`Unable to initialize ${task.id}`);
    const configured = await runProcess("git", ["config", "core.autocrlf", "false"], {
      cwd: repository,
    });
    if (configured.exitCode !== 0)
      throw new Error(`Unable to configure deterministic line endings for ${task.id}`);
    const staged = await runProcess("git", ["add", "."], { cwd: repository });
    if (staged.exitCode !== 0) throw new Error(`Unable to stage fixture ${task.id}`);
    const committed = await runProcess(
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
        `fixture ${task.id}`,
      ],
      {
        cwd: repository,
        env: {
          GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
        },
      },
    );
    if (committed.exitCode !== 0) throw new Error(`Unable to commit fixture ${task.id}`);
    const head = await runProcess("git", ["rev-parse", "HEAD"], { cwd: repository });
    if (head.exitCode !== 0 || !head.stdout.trim())
      throw new Error(`Unable to hash fixture ${task.id}`);
    return {
      repository,
      repositoryDigest: contentHash(task.initialFiles),
      baseSha: head.stdout.trim(),
    };
  } catch (error) {
    try {
      await removeBenchmarkFixture(repository);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Benchmark fixture ${task.id} failed during setup and cleanup`,
      );
    }
    throw error;
  }
}

function benchmarkWorktreeRoot(repository: string): string {
  return join(dirname(repository), `.${basename(repository)}-graphcraft-worktrees`);
}

async function removeBenchmarkFixture(repository: string): Promise<void> {
  const failures: unknown[] = [];
  for (const path of [benchmarkWorktreeRoot(repository), repository]) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, `Unable to remove benchmark fixture ${repository}`);
}

function expectedScorerFiles(task: BenchmarkTask) {
  return [...new Set(task.checks.map(({ scorerPath }) => scorerPath))].sort().map((path) => ({
    path,
    kind: "regular_file" as const,
    digest: contentHash(task.initialFiles[path]),
  }));
}

async function observedScorerFiles(task: BenchmarkTask, repository: string) {
  return await Promise.all(
    [...new Set(task.checks.map(({ scorerPath }) => scorerPath))].sort().map(async (path) => {
      const target = safeFixturePath(repository, path);
      try {
        const status = await lstat(target);
        if (!status.isFile() || status.isSymbolicLink()) {
          return { path, kind: status.isSymbolicLink() ? "symbolic_link" : "not_regular" };
        }
        return {
          path,
          kind: "regular_file" as const,
          digest: contentHash(await readFile(target, "utf8")),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, kind: "missing" };
        throw error;
      }
    }),
  );
}

function scorerDigest(
  task: BenchmarkTask,
  files: Awaited<ReturnType<typeof observedScorerFiles>> | ReturnType<typeof expectedScorerFiles>,
): string {
  return contentHash({ checks: task.checks, acceptance: task.acceptance, files });
}

async function scoreAcceptance(
  task: BenchmarkTask,
  repository: string,
  summaryEvidence = "",
): Promise<{
  results: Array<{ path: string; passed: boolean; summary: string }>;
  expectedScorerDigest: string;
  observedScorerDigest: string;
  scorerVerified: boolean;
}> {
  const results: Array<{ path: string; passed: boolean; summary: string }> = [];
  const expectedScorerDigest = scorerDigest(task, expectedScorerFiles(task));
  const observedScorerDigest = scorerDigest(task, await observedScorerFiles(task, repository));
  const scorerVerified = expectedScorerDigest === observedScorerDigest;
  for (const [index, check] of task.checks.entries()) {
    if (!scorerVerified) {
      results.push({
        path: `$check:${index + 1}`,
        passed: false,
        summary: `immutable scorer ${check.scorerPath} changed from its fixture bytes`,
      });
      continue;
    }
    const scorerSource = task.initialFiles[check.scorerPath]!;
    const sourcePath = safeFixturePath(repository, check.scorerPath);
    const trustedScorerPath = join(
      dirname(sourcePath),
      `.graphcraft-benchmark-scorer-${randomUUID()}${extname(sourcePath)}`,
    );
    try {
      await writeFile(trustedScorerPath, scorerSource, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const result = await runProcess(check.command, [trustedScorerPath, ...check.args], {
        cwd: repository,
        timeoutMs: check.timeoutMs,
      });
      const passed = !result.timedOut && result.exitCode === check.expectedExitCode;
      results.push({
        path: `$check:${index + 1}`,
        passed,
        summary: `${check.command} ${check.args.join(" ")} ${
          result.timedOut ? "timed out" : `exited ${result.exitCode}`
        } (expected ${check.expectedExitCode})`,
      });
    } catch (error) {
      results.push({
        path: `$check:${index + 1}`,
        passed: false,
        summary: `${check.command} could not run: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      await rm(trustedScorerPath, { force: true });
    }
  }
  for (const assertion of task.acceptance) {
    try {
      if (assertion.kind === "summary_contains") {
        const passed = summaryEvidence.includes(assertion.value);
        results.push({
          path: "$summary",
          passed,
          summary: `run summary ${passed ? "contains" : "does not contain"} ${assertion.value}`,
        });
        continue;
      }
      const target = safeFixturePath(repository, assertion.path);
      let exists = true;
      try {
        await access(target);
      } catch {
        exists = false;
      }
      if (assertion.kind === "exists" || assertion.kind === "absent") {
        const passed = assertion.kind === "exists" ? exists : !exists;
        results.push({
          path: assertion.path,
          passed,
          summary: `${assertion.path} ${exists ? "exists" : "is absent"}`,
        });
        continue;
      }
      const value = exists ? await readFile(target, "utf8") : "";
      const passed =
        exists &&
        (assertion.kind === "equals"
          ? value === assertion.value
          : assertion.kind === "not_contains"
            ? !value.includes(assertion.value)
            : value.includes(assertion.value));
      results.push({
        path: assertion.path,
        passed,
        summary: `${assertion.path} ${passed ? "satisfies" : "does not satisfy"} ${assertion.kind}`,
      });
    } catch (error) {
      results.push({
        path: assertion.kind === "summary_contains" ? "$summary" : assertion.path,
        passed: false,
        summary: `acceptance assertion could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { results, expectedScorerDigest, observedScorerDigest, scorerVerified };
}

function usageSummary(usages: TokenUsage[]): {
  usage: TokenUsage;
  reconciled: boolean;
  limitations: string[];
} {
  const usage = aggregateTokenUsage(usages.length ? usages : [unavailableTokenUsage()]);
  const limitations = tokenDimensions
    .filter((dimension) =>
      ["estimated", "unavailable", "legacy_unknown"].includes(usage.availability[dimension]),
    )
    .map((dimension) => `${dimension}:${usage.availability[dimension]}`);
  return {
    usage,
    reconciled: ["reported", "derived"].includes(usage.availability.total),
    limitations,
  };
}

async function runBaselineTrial(input: {
  trial: BenchmarkScheduleEntry;
  task: BenchmarkTask;
  adapter: HostAdapter;
  repository: string;
  repositoryDigest: string;
  baseSha: string;
  hostVersion: string;
  policy: HostExecutionPolicy;
}): Promise<BenchmarkTrialResult> {
  const started = performance.now();
  const usages: TokenUsage[] = [];
  const failureTrace: string[] = [];
  const summaryEvidence: string[] = [];
  const transcript = new BoundedTranscriptCapture();
  let resultStatus: "completed" | "blocked" | "failed" | "error" = "error";
  const capsule = ContextCapsuleSchema.parse({
    schemaVersion: 1,
    runId: randomUUID(),
    nodeId: `baseline-${input.task.id}`,
    objective: input.task.task,
    finishLine: { kind: "local_verified" },
    constraints: [
      "Work only in this repository.",
      "Follow repository instructions and run the declared checks.",
      "Do not commit, push, weaken checks, or claim completion without repository evidence.",
    ],
    acceptanceAnchors: [
      {
        id: "benchmark-outcome",
        description: "The task outcome must satisfy an immutable fixture-bound scorer",
        owner: "held_out_eval",
        evidenceSource: "benchmark harness",
        mutationPolicy: "immutable",
      },
    ],
    predecessorEvidence: [],
    relevantPaths: Object.keys(input.task.initialFiles).sort(),
    probeEvidence: [],
  });
  try {
    for await (const candidate of input.adapter.execute(
      {
        invocationId: input.trial.trialId,
        repositoryPath: input.repository,
        capsule,
        allowedTools: ["read", "write", "shell"],
      },
      new AbortController().signal,
    )) {
      const event = HostEventSchema.parse(candidate);
      transcript.append({ source: "baseline_host_event", event });
      if (event.type === "usage") usages.push(event.usage);
      if (event.type === "result") {
        resultStatus = event.result.status;
        summaryEvidence.push(event.result.summary, ...event.result.evidence);
      }
      if (event.type === "error") {
        resultStatus = "error";
        failureTrace.push(event.message);
      }
      if (event.type === "terminated") {
        resultStatus = "error";
        failureTrace.push(`${event.termination.cause}: ${event.termination.outcome}`);
      }
    }
  } catch (error) {
    if (error instanceof HostCapabilityAdmissionError) throw error;
    resultStatus = "error";
    failureTrace.push(error instanceof Error ? error.message : String(error));
  }
  const score = await scoreAcceptance(input.task, input.repository, summaryEvidence.join("\n"));
  failureTrace.push(
    ...score.results.filter(({ passed }) => !passed).map(({ summary }) => `acceptance: ${summary}`),
  );
  const tokens = usageSummary(usages);
  const reviewPacket = await captureReviewPacket({
    repository: input.repository,
    baseSha: input.baseSha,
    transcript,
  });
  failureTrace.push(...reviewPacket.captureFailures.map((failure) => `review packet: ${failure}`));
  const reviewLimitations = [
    ...(reviewPacket.patch.truncated ? ["review_patch:truncated"] : []),
    ...(reviewPacket.transcript.truncated ? ["review_transcript:truncated"] : []),
  ];
  return BenchmarkTrialResultSchema.parse({
    trial: input.trial,
    hostVersion: input.hostVersion,
    modelPolicy: input.policy.model,
    effortPolicy: input.policy.effort,
    permissionPolicy: benchmarkPermissionPolicy(input.trial.host),
    acceptanceScorerDigest: score.expectedScorerDigest,
    observedScorerDigest: score.observedScorerDigest,
    scorerVerified: score.scorerVerified,
    repositoryDigest: input.repositoryDigest,
    baseSha: input.baseSha,
    executionStatus: resultStatus,
    accepted:
      resultStatus === "completed" &&
      score.scorerVerified &&
      score.results.every(({ passed }) => passed) &&
      reviewPacket.captureFailures.length === 0,
    acceptance: score.results,
    usage: tokens.usage,
    usageReconciled: tokens.reconciled,
    limitations: [...tokens.limitations, ...reviewLimitations],
    durationMs: Math.round(performance.now() - started),
    humanInterventions: 0,
    failureTrace,
    reviewPacket,
  });
}

async function runGraphcraftTrial(input: {
  trial: BenchmarkScheduleEntry;
  task: BenchmarkTask;
  adapter: HostAdapter;
  repository: string;
  repositoryDigest: string;
  baseSha: string;
  hostVersion: string;
  policy: HostExecutionPolicy;
}): Promise<BenchmarkTrialResult> {
  const started = performance.now();
  const failureTrace: string[] = [];
  let executionStatus: "completed" | "blocked" | "failed" | "error" = "error";
  let acceptanceRepository = input.repository;
  let summaryEvidence = "";
  let tokens = usageSummary([]);
  let store: Awaited<ReturnType<typeof createRun>>["store"] | undefined;
  const transcript = new BoundedTranscriptCapture();
  const transcriptCaptureFailures: string[] = [];
  try {
    const created = await createRun(input.task.task, {
      cwd: input.repository,
      planner: input.adapter,
      finishLine: "local_verified",
    });
    store = created.store;
    const state = await executeRun({ store: created.store, adapter: input.adapter, approve: true });
    const events = await created.store.loadEvents();
    const capabilityError = persistedCapabilityAdmissionError(events);
    if (capabilityError) throw capabilityError;
    executionStatus =
      state.status === "completed"
        ? "completed"
        : state.status === "blocked"
          ? "blocked"
          : "failed";
    const report = usageSummary(state.tokenLedger.map(({ usage }) => usage));
    tokens = report;
    const workspace = await created.store.loadWorkspace<{ path: string }>();
    acceptanceRepository = workspace.path;
    summaryEvidence = [
      ...Object.values(state.nodes)
        .map((node) => node.lastSummary)
        .filter((value): value is string => typeof value === "string"),
      ...state.latestProgressEvidence,
    ].join("\n");
    failureTrace.push(
      ...events
        .filter(({ type }) => type === "node.failed" || type === "run.blocked")
        .map(({ data }) => String(data.reason ?? "run blocked")),
    );
  } catch (error) {
    if (error instanceof HostCapabilityAdmissionError) throw error;
    failureTrace.push(error instanceof Error ? error.message : String(error));
  }
  if (store) {
    try {
      const workspace = await store.loadWorkspace<{ path: string }>();
      acceptanceRepository = workspace.path;
    } catch (error) {
      transcriptCaptureFailures.push(
        `workspace receipt capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const events = await store.loadEvents();
      for (const event of events) transcript.append({ source: "graphcraft_run_event", event });
      const invocationIds = [
        ...new Set(
          events.flatMap(({ data }) =>
            typeof data.invocationId === "string" ? [data.invocationId] : [],
          ),
        ),
      ];
      for (const invocationId of invocationIds) {
        try {
          const invocationEvents = await store.loadInvocationEvents(invocationId);
          for (const event of invocationEvents)
            transcript.append({
              source: "graphcraft_host_event",
              invocationId,
              event,
            });
        } catch (error) {
          transcriptCaptureFailures.push(
            `invocation transcript ${invocationId} capture failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      transcriptCaptureFailures.push(
        `run transcript capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const score = await scoreAcceptance(input.task, acceptanceRepository, summaryEvidence);
  failureTrace.push(
    ...score.results.filter(({ passed }) => !passed).map(({ summary }) => `acceptance: ${summary}`),
  );
  const reviewPacket = await captureReviewPacket({
    repository: acceptanceRepository,
    baseSha: input.baseSha,
    transcript,
    captureFailures: transcriptCaptureFailures,
  });
  failureTrace.push(...reviewPacket.captureFailures.map((failure) => `review packet: ${failure}`));
  const reviewLimitations = [
    ...(reviewPacket.patch.truncated ? ["review_patch:truncated"] : []),
    ...(reviewPacket.transcript.truncated ? ["review_transcript:truncated"] : []),
  ];
  return BenchmarkTrialResultSchema.parse({
    trial: input.trial,
    hostVersion: input.hostVersion,
    modelPolicy: input.policy.model,
    effortPolicy: input.policy.effort,
    permissionPolicy: benchmarkPermissionPolicy(input.trial.host),
    acceptanceScorerDigest: score.expectedScorerDigest,
    observedScorerDigest: score.observedScorerDigest,
    scorerVerified: score.scorerVerified,
    repositoryDigest: input.repositoryDigest,
    baseSha: input.baseSha,
    executionStatus,
    accepted:
      executionStatus === "completed" &&
      score.scorerVerified &&
      score.results.every(({ passed }) => passed) &&
      reviewPacket.captureFailures.length === 0,
    acceptance: score.results,
    usage: tokens.usage,
    usageReconciled: tokens.reconciled,
    limitations: [...tokens.limitations, ...reviewLimitations],
    durationMs: Math.round(performance.now() - started),
    humanInterventions: 0,
    failureTrace,
    reviewPacket,
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function appendUniqueString(values: unknown, value: string): unknown {
  if (!Array.isArray(values) || !values.every((entry) => typeof entry === "string")) return values;
  return values.includes(value) ? values : [...values, value];
}

function parseBenchmarkReportWithReviewMigration(value: unknown): {
  report: BenchmarkReport;
  migrated: boolean;
} {
  const record = objectRecord(value);
  if (record?.reviewPolicy !== reviewPolicy || !Array.isArray(record.results))
    return { report: BenchmarkReportSchema.parse(value), migrated: false };

  let migrated = false;
  const legacyResults: BenchmarkTrialResult[] = [];
  const results = record.results.map((candidate) => {
    const result = objectRecord(candidate);
    const packet = objectRecord(result?.reviewPacket);
    const transcript = objectRecord(packet?.transcript);
    if (
      result?.accepted !== true ||
      transcript?.truncated !== true ||
      !Array.isArray(packet?.captureFailures) ||
      packet.captureFailures.length !== 0
    ) {
      const parsed = BenchmarkTrialResultSchema.parse(candidate);
      legacyResults.push(parsed);
      return parsed;
    }

    migrated = true;
    const { reviewPacket: _reviewPacket, ...legacyResult } = result;
    legacyResults.push(BenchmarkTrialResultSchema.parse(legacyResult));
    return BenchmarkTrialResultSchema.parse({
      ...result,
      accepted: false,
      limitations: appendUniqueString(result.limitations, "review_transcript:truncated"),
      failureTrace: appendUniqueString(
        result.failureTrace,
        `review packet: ${TRANSCRIPT_INCOMPLETE_FAILURE}`,
      ),
      reviewPacket: {
        ...packet,
        captureFailures: [TRANSCRIPT_INCOMPLETE_FAILURE],
      },
    });
  });
  if (!migrated) return { report: BenchmarkReportSchema.parse(value), migrated: false };
  const schedule = BenchmarkScheduleEntrySchema.array().parse(record.schedule);
  if (contentHash(record.summary) !== contentHash(summarizeBenchmark(legacyResults, schedule)))
    throw new Error("The existing benchmark report summary does not match its trial evidence");
  return {
    report: BenchmarkReportSchema.parse({
      ...record,
      results,
      summary: summarizeBenchmark(results, schedule),
    }),
    migrated: true,
  };
}

export async function runBenchmark(input: {
  suite: BenchmarkSuite;
  hosts: Array<"codex" | "claude">;
  adapters: Partial<Record<"codex" | "claude", HostAdapter>>;
  policies: Partial<Record<"codex" | "claude", HostExecutionPolicy>>;
  graphcraftVersion: string;
  graphcraftSource?: BenchmarkSourceIdentity;
  seed: string;
  repetitions?: number;
  outputPath: string;
  observer?: (message: string) => void;
}): Promise<{ outputPath: string; report: BenchmarkReport }> {
  const suite = BenchmarkSuiteSchema.parse(input.suite);
  const graphcraftVersion = input.graphcraftVersion?.trim();
  if (!graphcraftVersion) throw new Error("A Graphcraft version identity is required");
  const graphcraftSource = input.graphcraftSource
    ? BenchmarkSourceIdentitySchema.parse(input.graphcraftSource)
    : await inspectBenchmarkSourceIdentity(process.cwd());
  if (graphcraftSource.dirty)
    throw new Error(
      "Evidence-backed benchmarks require a clean Graphcraft source tree; dirty source identity is not reproducible",
    );
  const hosts = [...new Set(input.hosts)].sort() as Array<"codex" | "claude">;
  if (hosts.length === 0) throw new Error("A benchmark requires at least one host");
  const policies: Partial<Record<"codex" | "claude", HostExecutionPolicy>> = {};
  for (const host of hosts) {
    const policy = input.policies[host];
    if (!policy?.model.trim()) throw new Error(`An explicit --${host}-model policy is required`);
    if (!["low", "medium", "high", "xhigh"].includes(policy.effort))
      throw new Error(`Unsupported ${host} benchmark effort policy: ${policy.effort}`);
    policies[host] = { model: policy.model.trim(), effort: policy.effort };
  }
  const efforts = new Set(hosts.map((host) => policies[host]!.effort));
  if (efforts.size !== 1)
    throw new Error("Matched cross-host benchmarks require one shared effort policy");
  const effortPolicy = policies[hosts[0]!]!.effort;
  const modelPolicy: { codex?: string; claude?: string } = {};
  for (const host of hosts) modelPolicy[host] = policies[host]!.model;
  const permissionPolicy: Partial<Record<"codex" | "claude", BenchmarkPermissionPolicy>> = {};
  for (const host of hosts) permissionPolicy[host] = benchmarkPermissionPolicy(host);
  const schedule = createBenchmarkSchedule({
    suite,
    hosts,
    seed: input.seed,
    ...(input.repetitions ? { repetitions: input.repetitions } : {}),
  });
  const outputPath = resolve(input.outputPath);
  const suiteDigest = contentHash(suite);
  const environment = {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    graphcraftVersion,
    graphcraftSource,
  };
  const byTask = new Map(suite.tasks.map((task) => [task.id, task]));
  let startedAt = new Date().toISOString();
  let results: BenchmarkTrialResult[] = [];
  let existingReport: BenchmarkReport | undefined;
  let existingReportMigrated = false;
  try {
    const loaded = parseBenchmarkReportWithReviewMigration(
      JSON.parse(await readFile(outputPath, "utf8")),
    );
    const existing = loaded.report;
    existingReportMigrated = loaded.migrated;
    if (existing.environment.graphcraftVersion !== graphcraftVersion)
      throw new Error(
        "The existing benchmark report Graphcraft version identity does not match this execution",
      );
    const { graphcraftSource: _existingSource, ...existingRuntimeEnvironment } =
      existing.environment;
    const { graphcraftSource: _currentSource, ...currentRuntimeEnvironment } = environment;
    if (
      existing.suite.id !== suite.id ||
      existing.suite.version !== suite.version ||
      existing.suite.digest !== suiteDigest ||
      existing.seed !== input.seed ||
      JSON.stringify(existing.modelPolicy) !== JSON.stringify(modelPolicy) ||
      existing.effortPolicy !== effortPolicy ||
      JSON.stringify(existing.permissionPolicy) !== JSON.stringify(permissionPolicy) ||
      existing.reviewPolicy !== reviewPolicy ||
      JSON.stringify(existingRuntimeEnvironment) !== JSON.stringify(currentRuntimeEnvironment) ||
      JSON.stringify(existing.schedule) !== JSON.stringify(schedule)
    )
      throw new Error("The existing benchmark report does not match this suite and schedule");
    if (contentHash(existing.environment.graphcraftSource) !== contentHash(graphcraftSource))
      throw new Error(
        "The existing benchmark report Graphcraft source identity does not match this execution",
      );
    startedAt = existing.startedAt;
    results = existing.results;
    existingReport = existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof SyntaxError)
        throw new Error(`Benchmark report is not valid JSON: ${outputPath}`);
      if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
    }
  }
  const scheduledIds = new Set(schedule.map(({ trialId }) => trialId));
  if (results.some(({ trial }) => !scheduledIds.has(trial.trialId)))
    throw new Error("The existing benchmark report contains a trial outside the current schedule");
  if (new Set(results.map(({ trial }) => trial.trialId)).size !== results.length)
    throw new Error("The existing benchmark report contains duplicated trial results");
  if (
    results.some(
      ({ trial, modelPolicy: resultModel, effortPolicy: resultEffort, ...result }) =>
        JSON.stringify(trial) !==
          JSON.stringify(schedule.find(({ trialId }) => trialId === trial.trialId)) ||
        resultModel !== policies[trial.host]!.model ||
        resultEffort !== policies[trial.host]!.effort ||
        result.permissionPolicy !== permissionPolicy[trial.host] ||
        result.repositoryDigest !== contentHash(byTask.get(trial.taskId)!.initialFiles) ||
        result.acceptanceScorerDigest !==
          scorerDigest(byTask.get(trial.taskId)!, expectedScorerFiles(byTask.get(trial.taskId)!)) ||
        result.scorerVerified !== (result.acceptanceScorerDigest === result.observedScorerDigest) ||
        result.acceptance.length !==
          byTask.get(trial.taskId)!.checks.length + byTask.get(trial.taskId)!.acceptance.length ||
        result.accepted !==
          (result.executionStatus === "completed" &&
            result.scorerVerified &&
            result.acceptance.every(({ passed }) => passed) &&
            result.reviewPacket?.captureFailures.length === 0),
    )
  )
    throw new Error("The existing benchmark report contains mismatched trial controls");
  if (existingReport?.status === "complete" && results.length !== schedule.length)
    throw new Error("The complete benchmark report does not cover the exact current schedule");
  if (
    existingReport &&
    contentHash(existingReport.summary) !== contentHash(summarizeBenchmark(results, schedule))
  )
    throw new Error("The existing benchmark report summary does not match its trial evidence");
  if (existingReport && contentHash(existingReport.limitations) !== contentHash(reportLimitations))
    throw new Error("The existing benchmark report limitations do not match this harness");
  if (existingReportMigrated && existingReport) await writeJsonAtomic(outputPath, existingReport);
  if (existingReport?.status === "complete") return { outputPath, report: existingReport };
  const persist = async (status: "running" | "complete"): Promise<BenchmarkReport> => {
    const report = BenchmarkReportSchema.parse(
      redactValue({
        schemaVersion: 2,
        status,
        suite: { id: suite.id, version: suite.version, digest: suiteDigest },
        startedAt,
        updatedAt: new Date().toISOString(),
        seed: input.seed,
        randomized: true,
        modelPolicy,
        effortPolicy,
        permissionPolicy,
        scorerPolicy,
        reviewPolicy,
        environment,
        limitations: reportLimitations,
        schedule,
        results,
        summary: summarizeBenchmark(results, schedule),
      }),
    );
    await writeJsonAtomic(outputPath, report);
    return report;
  };
  for (const host of hosts) {
    const adapter = input.adapters[host];
    if (!adapter) throw new Error(`No ${host} benchmark adapter was configured`);
    const capabilities = await adapter.probe();
    assertRequiredHostCapabilities(host, capabilities);
  }
  await persist("running");
  const completedTrialIds = new Set(results.map(({ trial }) => trial.trialId));
  for (const trial of schedule) {
    if (completedTrialIds.has(trial.trialId)) continue;
    const task = byTask.get(trial.taskId)!;
    const adapter = input.adapters[trial.host]!;
    input.observer?.(
      `[${trial.order + 1}/${schedule.length}] ${trial.host} ${trial.mode} ${trial.taskId} #${trial.repetition}`,
    );
    const fixture = await materializeTask(task);
    try {
      const capabilities = await adapter.probe();
      assertRequiredHostCapabilities(trial.host, capabilities);
      const hostVersion = capabilities.version ?? "unknown";
      const result =
        trial.mode === "baseline"
          ? await runBaselineTrial({
              trial,
              task,
              adapter,
              repository: fixture.repository,
              repositoryDigest: fixture.repositoryDigest,
              baseSha: fixture.baseSha,
              hostVersion,
              policy: policies[trial.host]!,
            })
          : await runGraphcraftTrial({
              trial,
              task,
              adapter,
              repository: fixture.repository,
              repositoryDigest: fixture.repositoryDigest,
              baseSha: fixture.baseSha,
              hostVersion,
              policy: policies[trial.host]!,
            });
      const finalCapabilities = await adapter.probe();
      assertRequiredHostCapabilities(trial.host, finalCapabilities);
      if (
        finalCapabilities.version !== capabilities.version ||
        finalCapabilities.protocolProfile !== capabilities.protocolProfile
      ) {
        throw new Error(
          `${trial.host} protocol identity changed during benchmark trial ${trial.trialId}; refusing stale host-version evidence`,
        );
      }
      results.push(result);
    } finally {
      await removeBenchmarkFixture(fixture.repository);
    }
    completedTrialIds.add(trial.trialId);
    await persist("running");
  }
  const report = await persist("complete");
  return { outputPath, report };
}
