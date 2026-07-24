import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "../packages/core/src/canonical.ts";
import {
  buildSanitizedLiveProtocolEvidence,
  contentAddressedEvidenceFile,
  verifyLiveQualificationEvidenceBinding,
  writeSanitizedLiveProtocolEvidence,
  type LiveQualificationEvidenceBinding,
  type LiveQualificationHost,
  type LiveQualificationUsage,
  type SanitizedLiveProtocolEvidence,
} from "./live-qualification-protocol-evidence.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function binding(host: LiveQualificationHost): LiveQualificationEvidenceBinding {
  return {
    hashAlgorithms: {
      qualificationReport: "sha256-exact-bytes-v1",
      hostQualification: "graphcraft-canonical-json-sha256-v1",
    },
    qualificationReportSha256: "a".repeat(64),
    hostQualificationSha256: "b".repeat(64),
    qualificationReportSchemaVersion: 1,
    qualificationReportKind: "graphcraft-live-host-qualification",
    qualificationCompletedAt: "2026-07-24T00:00:00.000Z",
    source: {
      graphcraftPackageVersion: "0.1.2",
      sourceGitHead: "c".repeat(40),
      sourceGitStatus: "clean",
      platform: "linux",
      arch: "x64",
      node: "v22.17.0",
      fixtureGitHead: "d".repeat(40),
      fixtureTreeSha256: "e".repeat(64),
      taskSha256: "f".repeat(64),
      fixtureTaskSha256: "1".repeat(64),
    },
    control: {
      rawVersion: host === "codex" ? "codex-cli 0.145.0" : "2.1.218 (Claude Code)",
      model: host === "codex" ? "gpt-5.6-codex" : "claude-opus-4-1-20250805",
      effort: "high",
    },
  };
}

const usage = {
  input: 41,
  cachedInput: 11,
  uncachedInput: 30,
  output: 9,
  reasoning: 3,
  total: 50,
};

const sanitizedResult = {
  status: "completed",
  summary: "Sanitized live qualification result.",
  changedPaths: [],
  evidence: ["Sanitized host protocol replay evidence."],
};

function rawEvents(host: LiveQualificationHost): {
  interruptedWorker: Record<string, unknown>[];
  resumedWorker: Record<string, unknown>[];
  prohibitedValues: string[];
} {
  const session = "raw-session-7f17e03b";
  const continuity = "graphcraft-continuity-raw-secret";
  const repository = "/Users/example/private/repository";
  const credential = "sk-live-secret-credential";
  if (host === "codex") {
    return {
      interruptedWorker: [
        { type: "thread.started", thread_id: session },
        { type: "turn.started" },
        {
          type: "item.started",
          item: {
            id: "raw-item-one",
            type: "command_execution",
            command: `cat ${repository}/qualification.json --credential ${credential}`,
            aggregated_output: continuity,
            exit_code: null,
            status: "in_progress",
          },
        },
      ],
      resumedWorker: [
        { type: "thread.started", thread_id: session },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: {
            id: "raw-reasoning",
            type: "reasoning",
            text: `Prompt and private reasoning: ${continuity}`,
          },
        },
        {
          type: "item.completed",
          item: {
            id: "raw-message",
            type: "agent_message",
            text: JSON.stringify({
              status: "completed",
              summary: `Read ${repository} with ${credential}`,
              changedPaths: [],
              evidence: [continuity],
            }),
          },
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 41,
            cached_input_tokens: 11,
            output_tokens: 9,
            reasoning_output_tokens: 3,
          },
        },
      ],
      prohibitedValues: [session, continuity, repository, credential],
    };
  }
  return {
    interruptedWorker: [
      {
        type: "system",
        subtype: "init",
        cwd: repository,
        session_id: session,
        tools: ["Read", "PrivateMcpTool"],
        mcp_servers: [{ name: "private-server", authorization: `Bearer ${credential}` }],
        model: "raw-model-value",
        permissionMode: "dontAsk",
        claude_code_version: "raw-version-value",
        output_style: "private-output-style",
        uuid: "raw-system-uuid",
      },
      {
        type: "assistant",
        message: {
          model: "raw-model-value",
          id: "raw-message-id",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "raw-tool-id",
              name: "Read",
              input: {
                file_path: `${repository}/qualification.json`,
                api_key: credential,
                numeric_secret: 8_675_309,
              },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 8, output_tokens: 5 },
        },
        parent_tool_use_id: null,
        session_id: session,
        uuid: "raw-assistant-uuid",
      },
    ],
    resumedWorker: [
      {
        type: "system",
        subtype: "init",
        cwd: repository,
        session_id: session,
        tools: ["Read"],
        mcp_servers: [],
        model: "raw-model-value",
        permissionMode: "dontAsk",
        claude_code_version: "raw-version-value",
        output_style: "private-output-style",
        uuid: "raw-resume-system-uuid",
      },
      {
        type: "assistant",
        message: {
          model: "raw-model-value",
          id: "raw-resume-message-id",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `Arbitrary model text ${continuity} ${credential}` }],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, cache_read_input_tokens: 10, output_tokens: 8 },
        },
        parent_tool_use_id: null,
        session_id: session,
        uuid: "raw-resume-assistant-uuid",
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1200,
        duration_api_ms: 900,
        num_turns: 1,
        result: JSON.stringify({
          status: "completed",
          summary: `Read ${repository}`,
          changedPaths: [],
          evidence: [continuity, credential],
        }),
        session_id: session,
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 30,
          cache_creation_input_tokens: 11,
          cache_read_input_tokens: 11,
          output_tokens: 9,
        },
        permission_denials: [],
        uuid: "raw-result-uuid",
        structured_output: {
          status: "completed",
          summary: continuity,
          changedPaths: [],
          evidence: [credential],
        },
      },
    ],
    prohibitedValues: [session, continuity, repository, credential],
  };
}

function evidence(host: LiveQualificationHost): SanitizedLiveProtocolEvidence {
  const events = rawEvents(host);
  return buildSanitizedLiveProtocolEvidence({
    host,
    binding: binding(host),
    interruptedWorker: events.interruptedWorker,
    resumedWorker: events.resumedWorker,
    expectedUsage: usage,
    prohibitedValues: events.prohibitedValues,
  });
}

describe("sanitized live qualification protocol evidence", () => {
  it.each(["codex", "claude"] as const)(
    "sanitizes %s captures deterministically without retaining sensitive values",
    (host) => {
      const first = evidence(host);
      const second = evidence(host);
      expect(second).toEqual(first);
      expect(first.acceptance).toEqual({
        qualifiesVersion: false,
        mayUpdateAdmission: false,
        authorizesAdmission: false,
        requiresIndependentQualificationReport: true,
      });
      expect(first.provenance.rawNativeEventsPersisted).toBe(false);
      expect(first.rawVersion).toBe(binding(host).control.rawVersion);
      expect(first.binding.control).toEqual(binding(host).control);
      expect(first.expected.normalizedUsage).toEqual(usage);
      expect(first.captures.interruptedWorker.map(({ type }) => type)).toEqual(
        rawEvents(host).interruptedWorker.map(({ type }) => type),
      );
      expect(first.captures.resumedWorker.map(({ type }) => type)).toEqual(
        rawEvents(host).resumedWorker.map(({ type }) => type),
      );

      const serialized = JSON.stringify(first);
      for (const value of rawEvents(host).prohibitedValues) expect(serialized).not.toContain(value);
      expect(serialized).not.toMatch(/(?:\/Users\/|bearer\s+|sk-live-secret)/iu);
      expect(serialized).not.toContain("8675309");
      expect(serialized).toContain(first.sessionPlaceholder);

      const resultEvent = first.captures.resumedWorker.find((event) =>
        host === "codex"
          ? event.type === "item.completed" &&
            (event.item as Record<string, unknown> | undefined)?.type === "agent_message"
          : event.type === "result",
      );
      expect(resultEvent).toBeDefined();
      if (host === "codex") {
        const item = resultEvent?.item as Record<string, unknown>;
        expect(JSON.parse(String(item.text))).toEqual(sanitizedResult);
        const completion = first.captures.resumedWorker.find(
          (event) => event.type === "turn.completed",
        );
        expect((completion?.usage as Record<string, unknown>).input_tokens).toBe(41);
      } else {
        expect(JSON.parse(String(resultEvent?.result))).toEqual(sanitizedResult);
        expect(resultEvent?.structured_output).toEqual(sanitizedResult);
        expect((resultEvent?.usage as Record<string, unknown>).input_tokens).toBe(30);
        expect(resultEvent).not.toHaveProperty("duration_ms");
        expect(resultEvent).not.toHaveProperty("duration_api_ms");
        expect(resultEvent).not.toHaveProperty("num_turns");
        expect(resultEvent).not.toHaveProperty("total_cost_usd");
      }
    },
  );

  it("fails closed on unsupported event types, unsafe keys, and unsafe bindings", () => {
    const events = rawEvents("codex");
    const rawErrorSecret = "sk-live-error-secret";
    const base = {
      host: "codex" as const,
      binding: binding("codex"),
      interruptedWorker: events.interruptedWorker,
      resumedWorker: events.resumedWorker,
      expectedUsage: usage,
    };
    expect(() =>
      buildSanitizedLiveProtocolEvidence({
        ...base,
        interruptedWorker: [{ type: "unrecognized.native.event" }],
      }),
    ).toThrow(/unsupported live worker event type/iu);
    expect(() =>
      buildSanitizedLiveProtocolEvidence({
        ...base,
        interruptedWorker: [
          { type: "thread.started", thread_id: "session", "unsafe key": "value" },
        ],
      }),
    ).toThrow(/unsafe field name/iu);
    expect(() =>
      buildSanitizedLiveProtocolEvidence({
        ...base,
        binding: {
          ...base.binding,
          control: { ...base.binding.control, rawVersion: "unsafe\nversion" },
        },
      }),
    ).toThrow(/unsafe source or host controls/iu);
    expect(() =>
      buildSanitizedLiveProtocolEvidence({
        ...base,
        interruptedWorker: [
          {
            type: "item.started",
            item: {
              id: "raw-item",
              type: "command_execution",
              command: "read qualification.json",
              status: "in_progress",
              account_id: 8675309,
            },
          },
        ],
      }),
    ).toThrow(/unsupported field/iu);
    expect(() =>
      buildSanitizedLiveProtocolEvidence({
        ...base,
        binding: {
          ...base.binding,
          rawTranscript: rawErrorSecret,
        } as LiveQualificationEvidenceBinding,
      }),
    ).toThrow(/binding contains unsupported or missing fields/iu);
    expect(() =>
      buildSanitizedLiveProtocolEvidence({
        ...base,
        binding: {
          ...base.binding,
          source: {
            ...base.binding.source,
            graphcraftPackageVersion: 8_675_309 as unknown as string,
          },
        },
      }),
    ).toThrow(/unsafe source or host controls/iu);
    expect(() =>
      buildSanitizedLiveProtocolEvidence({
        ...base,
        expectedUsage: {
          ...usage,
          privateNumericMetadata: 8_675_309,
        } as LiveQualificationUsage,
      }),
    ).toThrow(/normalized usage contains unsupported or missing fields/iu);
    expect(() =>
      buildSanitizedLiveProtocolEvidence({
        ...base,
        binding: {
          ...base.binding,
          source: {
            ...base.binding.source,
            graphcraftPackageVersion: 'release-"private"',
          },
        },
        prohibitedValues: ['release-"private"'],
      }),
    ).toThrow(/retained a prohibited raw value/iu);

    for (const interruptedWorker of [
      [
        {
          type: "item.started",
          item: {
            id: "raw-item",
            type: "command_execution",
            command: "read qualification.json",
            status: rawErrorSecret,
          },
        },
      ],
      [{ type: "thread.started", thread_id: "session", [rawErrorSecret]: "value" }],
    ]) {
      let message = "";
      try {
        buildSanitizedLiveProtocolEvidence({ ...base, interruptedWorker });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/unsupported literal|unsupported field|unsafe field name/iu);
      expect(message).not.toContain(rawErrorSecret);
    }
  });

  it("canonically binds a host entry and rejects report or host tampering", () => {
    const baseBinding = binding("codex");
    const hostQualification = {
      control: baseBinding.control,
      usage: { input: 41, output: 9 },
    };
    const reorderedHostQualification = {
      usage: { output: 9, input: 41 },
      control: {
        effort: baseBinding.control.effort,
        model: baseBinding.control.model,
        rawVersion: baseBinding.control.rawVersion,
      },
    };
    const qualificationReportBytes = `${JSON.stringify({
      schemaVersion: 1,
      kind: "graphcraft-live-host-qualification",
      controls: baseBinding.source,
      hosts: { codex: reorderedHostQualification },
      startedAt: "2026-07-23T23:59:00.000Z",
      completedAt: baseBinding.qualificationCompletedAt,
    })}\n`;
    const bound: LiveQualificationEvidenceBinding = {
      ...baseBinding,
      qualificationReportSha256: sha256(qualificationReportBytes),
      hostQualificationSha256: contentHash(hostQualification),
    };

    expect(() =>
      verifyLiveQualificationEvidenceBinding({
        host: "codex",
        binding: bound,
        qualificationReportBytes,
      }),
    ).not.toThrow();
    expect(() =>
      verifyLiveQualificationEvidenceBinding({
        host: "codex",
        binding: bound,
        qualificationReportBytes: `${qualificationReportBytes}tampered`,
      }),
    ).toThrow(/qualification report hash does not match/iu);

    const hostTamperedReportBytes = `${JSON.stringify({
      schemaVersion: 1,
      kind: "graphcraft-live-host-qualification",
      controls: baseBinding.source,
      hosts: {
        codex: { ...hostQualification, usage: { input: 42, output: 9 } },
      },
      startedAt: "2026-07-23T23:59:00.000Z",
      completedAt: baseBinding.qualificationCompletedAt,
    })}\n`;
    expect(() =>
      verifyLiveQualificationEvidenceBinding({
        host: "codex",
        binding: {
          ...bound,
          qualificationReportSha256: sha256(hostTamperedReportBytes),
        },
        qualificationReportBytes: hostTamperedReportBytes,
      }),
    ).toThrow(/host qualification hash does not match/iu);

    expect(() =>
      verifyLiveQualificationEvidenceBinding({
        host: "codex",
        binding: {
          ...bound,
          qualificationCompletedAt: "2026-07-24T00:00:01.000Z",
        },
        qualificationReportBytes,
      }),
    ).toThrow(/report metadata does not match/iu);
    expect(() =>
      verifyLiveQualificationEvidenceBinding({
        host: "codex",
        binding: {
          ...bound,
          source: { ...bound.source, sourceGitStatus: "dirty" },
        },
        qualificationReportBytes,
      }),
    ).toThrow(/report controls do not match/iu);
    expect(() =>
      verifyLiveQualificationEvidenceBinding({
        host: "claude",
        binding: bound,
        qualificationReportBytes,
      }),
    ).toThrow(/omitted claude/iu);
    expect(() =>
      verifyLiveQualificationEvidenceBinding({
        host: "codex",
        binding: {
          ...bound,
          control: { ...bound.control, model: "gpt-5.6-codex-tampered" },
        },
        qualificationReportBytes,
      }),
    ).toThrow(/host qualification control does not match/iu);
  });

  it("content-addresses every emitted file and refuses unsafe paths or collisions", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "graphcraft-live-evidence-test-")));
    temporaryRoots.push(root);
    const outputPath = join(root, "evidence");
    const bundle = evidence("codex");
    const expected = contentAddressedEvidenceFile(bundle);

    const files = await writeSanitizedLiveProtocolEvidence({
      outputPath,
      evidence: [bundle],
      forbiddenRoots: [],
    });
    expect(files).toEqual([expected]);
    expect(await readdir(outputPath)).toEqual([expected.fileName]);
    const persisted = await readFile(join(outputPath, expected.fileName));
    expect(sha256(persisted)).toBe(expected.sha256);
    expect(expected.fileName).toContain(expected.sha256);
    expect(sha256(`${expected.bytes}tampered`)).not.toBe(expected.sha256);

    await expect(
      writeSanitizedLiveProtocolEvidence({
        outputPath,
        evidence: [bundle],
        forbiddenRoots: [],
      }),
    ).rejects.toThrow(/already exists/iu);
    await expect(
      writeSanitizedLiveProtocolEvidence({
        outputPath: "relative-evidence",
        evidence: [bundle],
        forbiddenRoots: [],
      }),
    ).rejects.toThrow(/absolute normalized path/iu);

    const forbidden = join(root, "forbidden");
    await mkdir(forbidden);
    await expect(
      writeSanitizedLiveProtocolEvidence({
        outputPath: join(forbidden, "evidence"),
        evidence: [bundle],
        forbiddenRoots: [forbidden],
      }),
    ).rejects.toThrow(/overlaps a forbidden repository root/iu);

    const forbiddenAlias = join(root, "forbidden-alias");
    await symlink(forbidden, forbiddenAlias, process.platform === "win32" ? "junction" : "dir");
    await expect(
      writeSanitizedLiveProtocolEvidence({
        outputPath: join(forbidden, "aliased-evidence"),
        evidence: [bundle],
        forbiddenRoots: [forbiddenAlias],
      }),
    ).rejects.toThrow(/overlaps a forbidden repository root/iu);
  });

  it("preserves a replacement directory instead of recursively cleaning it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "graphcraft-live-evidence-swap-")));
    temporaryRoots.push(root);
    const outputPath = join(root, "evidence");
    const displacedPath = join(root, "original-evidence-directory");
    const markerPath = join(outputPath, "replacement-marker.txt");

    await expect(
      writeSanitizedLiveProtocolEvidence({
        outputPath,
        evidence: [evidence("codex")],
        forbiddenRoots: [],
        async publicationBoundaryForTest(point) {
          if (point !== "after_directory_creation") return;
          await rename(outputPath, displacedPath);
          await mkdir(outputPath, { mode: 0o700 });
          await writeFile(markerPath, "preserve replacement\n", { mode: 0o600 });
        },
      }),
    ).rejects.toThrow(/changed filesystem identity/iu);

    await expect(readFile(markerPath, "utf8")).resolves.toBe("preserve replacement\n");
    await expect(readdir(displacedPath)).resolves.toEqual([]);
  });

  it("only removes an exact empty reservation and preserves partial evidence", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "graphcraft-live-evidence-cleanup-")));
    temporaryRoots.push(root);
    const emptyOutputPath = join(root, "empty-evidence");
    await expect(
      writeSanitizedLiveProtocolEvidence({
        outputPath: emptyOutputPath,
        evidence: [evidence("codex")],
        forbiddenRoots: [],
        publicationBoundaryForTest(point) {
          if (point === "after_directory_creation") throw new Error("injected empty failure");
        },
      }),
    ).rejects.toThrow(/injected empty failure/iu);
    await expect(lstat(emptyOutputPath)).rejects.toMatchObject({ code: "ENOENT" });

    const partialOutputPath = join(root, "partial-evidence");
    await expect(
      writeSanitizedLiveProtocolEvidence({
        outputPath: partialOutputPath,
        evidence: [evidence("codex")],
        forbiddenRoots: [],
        publicationBoundaryForTest(point) {
          if (point === "after_file_write") throw new Error("injected partial failure");
        },
      }),
    ).rejects.toThrow(/injected partial failure/iu);
    await expect(readdir(partialOutputPath)).resolves.toHaveLength(1);
  });
});
