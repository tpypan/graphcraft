import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileAsync = promisify(execFile);
let trustedCommandDirectory: string | undefined;

vi.mock("cross-spawn", () => ({
  default: Object.assign(spawnMock, { spawn: spawnMock, sync: vi.fn() }),
}));

import { ClaudeAdapter } from "../packages/adapter-claude/src/index.ts";
import {
  ADAPTER_PROTOCOL_LINE_LIMIT_BYTES as CLAUDE_PROTOCOL_LINE_LIMIT_BYTES,
  ADAPTER_STDERR_LIMIT_BYTES as CLAUDE_STDERR_LIMIT_BYTES,
  ADAPTER_STRUCTURED_OUTPUT_LIMIT_BYTES as CLAUDE_STRUCTURED_OUTPUT_LIMIT_BYTES,
  readBoundedProtocolLines as readClaudeProtocolLines,
} from "../packages/adapter-claude/src/protocol.ts";
import { CodexAdapter } from "../packages/adapter-codex/src/index.ts";
import {
  ADAPTER_PROTOCOL_LINE_LIMIT_BYTES as CODEX_PROTOCOL_LINE_LIMIT_BYTES,
  ADAPTER_STDERR_LIMIT_BYTES as CODEX_STDERR_LIMIT_BYTES,
  ADAPTER_STRUCTURED_OUTPUT_LIMIT_BYTES as CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES,
  readBoundedProtocolLines as readCodexProtocolLines,
} from "../packages/adapter-codex/src/protocol.ts";
import type {
  HostEvent,
  PlanningRequest,
  RepositoryInstructionSelection,
  SemanticVerificationRequest,
  WorkerRequest,
} from "../packages/core/src/index.ts";
import {
  HOST_CAPABILITY_PROBE_SETTLE_GRACE_MS,
  HOST_CAPABILITY_PROBE_TIMEOUT_MS,
  HOST_TERMINATION_GRACE_MS,
  HOST_TERMINATION_SETTLE_GRACE_MS,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  ChildTerminationController,
  contentHash,
  repositoryInstructionSelectionDigest,
  terminateChildProcessTree,
} from "../packages/core/src/index.ts";

class FakeChild extends EventEmitter {
  readonly stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
}

interface FakeChildOutput {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  exitCode?: number;
  afterClose?: () => void;
}

function queueChild(output: FakeChildOutput): FakeChild {
  const child = new FakeChild();
  spawnMock.mockImplementationOnce(() => {
    setImmediate(() => {
      child.stdout.end(output.stdout ?? "");
      child.stderr.end(output.stderr ?? "");
      setImmediate(() => {
        child.emit("close", output.exitCode ?? 0, null);
        output.afterClose?.();
      });
    });
    return child as unknown as ChildProcess;
  });
  return child;
}

function queueTerminatingChild(): { child: FakeChild; spawned: Promise<void> } {
  const child = new FakeChild();
  let markSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  child.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", null, typeof signal === "string" ? signal : null);
    });
    return true;
  });
  spawnMock.mockImplementationOnce(() => {
    markSpawned();
    return child as unknown as ChildProcess;
  });
  return { child, spawned };
}

function queueNeverClosingChild(): { child: FakeChild; spawned: Promise<void> } {
  const child = new FakeChild();
  let markSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  spawnMock.mockImplementationOnce(() => {
    markSpawned();
    return child as unknown as ChildProcess;
  });
  return { child, spawned };
}

async function collectEvents(iterable: AsyncIterable<HostEvent>): Promise<HostEvent[]> {
  const events: HostEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function planningRequest(): PlanningRequest {
  return {
    repositoryPath: process.cwd(),
    contract: { task: "Implement the bounded adapter fixture" } as PlanningRequest["contract"],
    repositoryEvidence: {
      contentTrust: "untrusted_repository",
      trackedPathCount: 1,
      trackedPaths: ["fixture.ts"],
      trackedPathsTruncated: false,
      files: [],
    },
    probePlan: { schemaVersion: 1, family: "feature", items: [] },
    verificationProbes: [],
  };
}

function semanticRequest(): SemanticVerificationRequest {
  return {
    invocationId: randomUUID(),
    repositoryPath: process.cwd(),
    context: { phase: "completion" } as SemanticVerificationRequest["context"],
  };
}

function workerRequest(resumeSessionId?: string): WorkerRequest {
  return {
    invocationId: randomUUID(),
    repositoryPath: process.cwd(),
    capsule: {} as WorkerRequest["capsule"],
    allowedTools: ["read"],
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}

function repositoryInstructionSelection(): RepositoryInstructionSelection {
  const content = "Pinned adapter policy.\n";
  const manifestDigest = "a".repeat(64);
  const selectedPaths = ["AGENTS.md"];
  const omittedPaths: string[] = [];
  return {
    schemaVersion: 1,
    policy: "tracked-shared-v1",
    manifestDigest,
    selectionDigest: repositoryInstructionSelectionDigest({
      manifestDigest,
      selectedPaths,
      omittedPaths,
    }),
    entries: [
      {
        path: "AGENTS.md",
        sources: ["agents"],
        scopes: ["**/*"],
        gitMode: "100644",
        workingKind: "file",
        workingMode: 0,
        importedBy: [],
        content,
        contentHash: contentHash(content, PORTABLE_CANONICAL_HASH_ALGORITHM),
      },
    ],
    selectedPaths,
    omittedPaths,
  };
}

function codexStructuredEvent(value: unknown): string {
  return JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: value },
  });
}

function codexSuccessfulProtocol(value: unknown, sessionId: string = randomUUID()): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: sessionId }),
    JSON.stringify({ type: "turn.started" }),
    codexStructuredEvent(value),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
}

function claudeStructuredEvent(value: unknown, sessionId?: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    ...(sessionId ? { session_id: sessionId } : {}),
    structured_output: value,
    usage: {},
  });
}

type InvocationKind = "plan" | "verify" | "worker";

function claudeSuccessfulProtocol(
  value: unknown,
  sessionId?: string,
  kind: InvocationKind = sessionId ? "worker" : "plan",
  cwd = process.cwd(),
): string {
  const tools = kind === "plan" ? [] : ["Read"];
  const protocolSessionId = sessionId ?? randomUUID();
  return [
    JSON.stringify({
      type: "system",
      subtype: "init",
      cwd,
      session_id: protocolSessionId,
      tools,
      mcp_servers: [],
      model: "fixture-model",
      permissionMode: "dontAsk",
      claude_code_version: "2.1.212",
      output_style: "default",
      slash_commands: [],
      agents: ["claude", "Explore", "general-purpose", "Plan"],
      skills: [],
      plugins: [],
      uuid: randomUUID(),
    }),
    claudeStructuredEvent(value, protocolSessionId),
  ].join("\n");
}

function boundWorkerProtocol(
  fixture: AdapterFixture,
  request: WorkerRequest,
  value: unknown,
): string {
  const sessionId =
    fixture.host === "Codex" ? "00000000-0000-4000-8000-000000000001" : request.invocationId;
  return `${fixture.structuredEvent(value, sessionId, "worker")}\n`;
}

type AdapterFixture = {
  host: "Codex" | "Claude";
  adapter: CodexAdapter | ClaudeAdapter;
  structuredEvent(value: unknown, sessionId?: string, kind?: InvocationKind, cwd?: string): string;
};

function rawAdapters(): AdapterFixture[] {
  return [
    { host: "Codex", adapter: new CodexAdapter(), structuredEvent: codexSuccessfulProtocol },
    { host: "Claude", adapter: new ClaudeAdapter(), structuredEvent: claudeSuccessfulProtocol },
  ];
}

function adapters(): AdapterFixture[] {
  return rawAdapters();
}

function queueReadyCapabilityProbe(host: "codex" | "claude"): void {
  queueChild({
    stdout: host === "codex" ? "codex-cli 0.144.6\n" : "2.1.212 (Claude Code)\n",
  });
  queueChild({
    stdout: host === "codex" ? "Logged in\n" : '{"loggedIn":true}\n',
  });
}

function queueUnauthenticatedCapabilityProbe(host: "codex" | "claude"): void {
  queueChild({
    stdout: host === "codex" ? "codex-cli 0.144.6\n" : "2.1.212 (Claude Code)\n",
  });
  queueChild({
    stdout: host === "codex" ? "Not logged in\n" : '{"loggedIn":false}\n',
  });
}

describe("bounded adapter streams", () => {
  beforeAll(async () => {
    trustedCommandDirectory = await mkdtemp(join(tmpdir(), "graphcraft-adapter-path-"));
    const codexHome = join(trustedCommandDirectory, "codex-home");
    await mkdir(codexHome);
    const suffix = process.platform === "win32" ? ".cmd" : "";
    await Promise.all(
      ["codex", "claude"].map(async (host) => {
        const executable = join(trustedCommandDirectory!, `${host}${suffix}`);
        await writeFile(
          executable,
          process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
          "utf8",
        );
        if (process.platform !== "win32") await chmod(executable, 0o755);
      }),
    );
    const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
    vi.stubEnv("PATH", `${trustedCommandDirectory}${delimiter}${inheritedPath}`);
    vi.stubEnv("CODEX_HOME", codexHome);
  });
  beforeEach(() => spawnMock.mockReset());
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (trustedCommandDirectory) {
      await rm(trustedCommandDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  it("rejects invalid repository-instruction selections before direct adapter admission", async () => {
    const selection = repositoryInstructionSelection();
    const invalid = { ...selection, selectionDigest: "f".repeat(64) };
    for (const { host, adapter } of rawAdapters()) {
      const signal = new AbortController().signal;
      const callsBefore = spawnMock.mock.calls.length;
      await expect(
        adapter.plan({ ...planningRequest(), repositoryInstructions: invalid }, signal),
        `${host} planner`,
      ).rejects.toThrow(/selection digest is invalid/i);
      await expect(
        adapter.verify(
          {
            ...semanticRequest(),
            context: {
              ...semanticRequest().context,
              repositoryInstructions: invalid,
            },
          },
          signal,
        ),
        `${host} verifier`,
      ).rejects.toThrow(/selection digest is invalid/i);
      const worker = workerRequest();
      await expect(
        collectEvents(
          adapter.execute(
            {
              ...worker,
              capsule: { ...worker.capsule, repositoryInstructions: invalid },
            },
            signal,
          ),
        ),
        `${host} worker`,
      ).rejects.toThrow(/selection digest is invalid/i);
      expect(spawnMock.mock.calls, `${host} child processes`).toHaveLength(callsBefore);
    }
  });

  it("retains no oversized protocol line and continues draining later lines", async () => {
    expect(CODEX_PROTOCOL_LINE_LIMIT_BYTES).toBe(CLAUDE_PROTOCOL_LINE_LIMIT_BYTES);
    for (const readLines of [readCodexProtocolLines, readClaudeProtocolLines]) {
      const stream = new PassThrough();
      const reading = (async () => {
        const lines = [];
        for await (const line of readLines(stream)) lines.push(line);
        return lines;
      })();
      stream.write(Buffer.alloc(CODEX_PROTOCOL_LINE_LIMIT_BYTES, 0x78));
      stream.write(Buffer.from("tail\n{}\n"));
      stream.end();

      await expect(reading).resolves.toEqual([
        {
          observedBytes: CODEX_PROTOCOL_LINE_LIMIT_BYTES + 4,
          overflowed: true,
        },
        { observedBytes: 2, overflowed: false, text: "{}" },
      ]);
    }
  });

  it("does not dispatch buffered or final protocol lines after cancellation", async () => {
    for (const readLines of [readCodexProtocolLines, readClaudeProtocolLines]) {
      const stream = new PassThrough();
      const abort = new AbortController();
      stream.end('{"first":true}\n{"second":true}\n{"final":true}');
      const lines = readLines(stream, abort.signal)[Symbol.asyncIterator]();

      await expect(lines.next()).resolves.toEqual({
        done: false,
        value: {
          observedBytes: 14,
          overflowed: false,
          text: '{"first":true}',
        },
      });
      abort.abort({ cause: "cancellation", reason: "Reject the first protocol event" });
      await expect(lines.next()).resolves.toEqual({ done: true, value: undefined });
    }
  });

  it("rejects an oversized protocol line after draining planner, verifier, and worker streams", async () => {
    const oversizedLine = `${"x".repeat(CODEX_PROTOCOL_LINE_LIMIT_BYTES + 1)}\n{}\n`;
    for (const { host, adapter } of adapters()) {
      queueReadyCapabilityProbe(adapter.id);
      queueChild({ stdout: oversizedLine });
      await expect(adapter.plan(planningRequest(), new AbortController().signal)).rejects.toThrow(
        `${host} protocol line exceeded the ${CODEX_PROTOCOL_LINE_LIMIT_BYTES}-byte limit`,
      );

      queueReadyCapabilityProbe(adapter.id);
      queueChild({ stdout: oversizedLine });
      await expect(adapter.verify(semanticRequest(), new AbortController().signal)).rejects.toThrow(
        `${host} protocol line exceeded the ${CODEX_PROTOCOL_LINE_LIMIT_BYTES}-byte limit`,
      );

      queueReadyCapabilityProbe(adapter.id);
      queueChild({ stdout: oversizedLine });
      const events = await collectEvents(
        adapter.execute(workerRequest(), new AbortController().signal),
      );
      expect(events.at(-1)).toEqual({
        type: "error",
        message: `${host} protocol line exceeded the ${CODEX_PROTOCOL_LINE_LIMIT_BYTES}-byte limit; output was rejected`,
      });
      expect(events).not.toContainEqual(expect.objectContaining({ type: "result" }));
    }
  });

  it("latches malformed JSON ahead of buffered success in every invocation path", async () => {
    const malformedLine = '{"type":';
    const graphPlan = {
      schemaVersion: 1,
      family: "feature",
      nodes: [
        {
          id: "reject-malformed-protocol",
          kind: "implementation",
          objective: "Reject malformed protocol output",
          dependsOn: [],
          scope: ["src/**"],
          contextSelector: {
            includeRepositoryInstructions: true,
            predecessorResults: [],
            relevantPaths: ["src"],
          },
          progressProbes: [],
          completionProbes: [],
          sideEffectClass: "workspace_write",
        },
      ],
    };
    const semanticVerdict = {
      verdict: "supported",
      evidence: ["Buffered success must not erase malformed protocol output."],
      rationale: "The protocol failure remains authoritative.",
      uncertainty: 0,
    };
    const workerResult = {
      status: "completed",
      summary: "buffered success",
      changedPaths: [],
      evidence: ["Buffered success must not erase malformed protocol output."],
    };

    for (const fixture of adapters()) {
      const expectedMessage = `${fixture.host} emitted a malformed JSON protocol line; output was rejected`;
      const expectSettledAndCleaned = async (child: FakeChild): Promise<void> => {
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        const options = spawnMock.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
        const privateTemp = options?.env?.TMPDIR;
        expect(privateTemp).toEqual(expect.any(String));
        await expect(lstat(privateTemp!)).rejects.toMatchObject({ code: "ENOENT" });
      };

      queueReadyCapabilityProbe(fixture.adapter.id);
      let child = queueChild({
        stdout: `${malformedLine}\n${fixture.structuredEvent(JSON.stringify(graphPlan), undefined, "plan")}\n`,
      });
      await expect(
        fixture.adapter.plan(planningRequest(), new AbortController().signal),
      ).rejects.toThrow(expectedMessage);
      await expectSettledAndCleaned(child);

      const verification = semanticRequest();
      queueReadyCapabilityProbe(fixture.adapter.id);
      child = queueChild({
        stdout: `${malformedLine}\n${fixture.structuredEvent(JSON.stringify(semanticVerdict), verification.invocationId, "verify")}\n`,
      });
      await expect(
        fixture.adapter.verify(verification, new AbortController().signal),
      ).rejects.toThrow(expectedMessage);
      await expectSettledAndCleaned(child);

      const freshWorker = workerRequest();
      const freshSessionId = fixture.host === "Claude" ? freshWorker.invocationId : randomUUID();
      queueReadyCapabilityProbe(fixture.adapter.id);
      child = queueChild({
        stdout: `${malformedLine}\n${fixture.structuredEvent(JSON.stringify(workerResult), freshSessionId, "worker")}\n`,
      });
      let events = await collectEvents(
        fixture.adapter.execute(freshWorker, new AbortController().signal),
      );
      expect(events.at(-1)).toEqual({ type: "error", message: expectedMessage });
      expect(events).not.toContainEqual(expect.objectContaining({ type: "result" }));
      await expectSettledAndCleaned(child);

      const resumedSessionId = randomUUID();
      const resumedWorker = workerRequest(resumedSessionId);
      queueReadyCapabilityProbe(fixture.adapter.id);
      child = queueChild({
        stdout: `${malformedLine}\n${fixture.structuredEvent(JSON.stringify(workerResult), resumedSessionId, "worker")}\n`,
      });
      events = await collectEvents(
        fixture.adapter.execute(resumedWorker, new AbortController().signal),
      );
      expect(events.at(-1)).toEqual({ type: "error", message: expectedMessage });
      expect(events).not.toContainEqual(expect.objectContaining({ type: "result" }));
      await expectSettledAndCleaned(child);
    }
  });

  it("continues to ignore blank protocol lines", async () => {
    const graphPlan = {
      schemaVersion: 1,
      family: "feature",
      nodes: [
        {
          id: "ignore-blank-protocol-lines",
          kind: "implementation",
          objective: "Ignore blank protocol lines",
          dependsOn: [],
          scope: ["src/**"],
          contextSelector: {
            includeRepositoryInstructions: true,
            predecessorResults: [],
            relevantPaths: ["src"],
          },
          progressProbes: [],
          completionProbes: [],
          sideEffectClass: "workspace_write",
        },
      ],
    };

    for (const { adapter, structuredEvent } of adapters()) {
      queueReadyCapabilityProbe(adapter.id);
      const child = queueChild({
        stdout: `\n \r\n\t\n${structuredEvent(JSON.stringify(graphPlan), undefined, "plan")}\n\n`,
      });
      await expect(
        adapter.plan(planningRequest(), new AbortController().signal),
      ).resolves.toMatchObject({ plan: graphPlan });
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("rejects oversized structured authority in planning and semantic verification", async () => {
    expect(CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES).toBe(CLAUDE_STRUCTURED_OUTPUT_LIMIT_BYTES);
    const oversizedAuthority = "x".repeat(CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES + 1);
    for (const { host, adapter, structuredEvent } of adapters()) {
      queueReadyCapabilityProbe(adapter.id);
      queueChild({ stdout: `${structuredEvent(oversizedAuthority, undefined, "plan")}\n` });
      await expect(adapter.plan(planningRequest(), new AbortController().signal)).rejects.toThrow(
        `${host} structured graph plan exceeded the ${CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES}-byte structured-output limit`,
      );

      queueReadyCapabilityProbe(adapter.id);
      const verification = semanticRequest();
      queueChild({
        stdout: `${structuredEvent(oversizedAuthority, verification.invocationId, "verify")}\n`,
      });
      await expect(adapter.verify(verification, new AbortController().signal)).rejects.toThrow(
        `${host} semantic verdict exceeded the ${CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES}-byte structured-output limit`,
      );
    }
  });

  it("rejects oversized resumed worker authority and cannot reconcile it as completed", async () => {
    const oversizedAuthority = "x".repeat(CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES + 1);
    for (const { host, adapter, structuredEvent } of adapters()) {
      const sessionId = `${host.toLowerCase()}-session`;
      queueReadyCapabilityProbe(adapter.id);
      queueChild({
        stdout: `${structuredEvent(oversizedAuthority, sessionId, "worker")}\n`,
      });
      const events = await collectEvents(
        adapter.execute(workerRequest(sessionId), new AbortController().signal),
      );

      expect(events).toContainEqual({ type: "session", hostSessionId: sessionId });
      expect(events.at(-1)).toEqual({
        type: "error",
        message: `${host} structured result exceeded the ${CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES}-byte structured-output limit; output was rejected`,
      });
      expect(events).not.toContainEqual(expect.objectContaining({ type: "result" }));
      await expect(
        adapter.reconcile({
          invocationId: randomUUID(),
          repositoryPath: process.cwd(),
          startedAt: new Date().toISOString(),
          hostSessionId: sessionId,
          transcript: events,
        }),
      ).resolves.toEqual({ state: "in_progress" });
    }
  });

  it("retains only a bounded stderr prefix while draining host failures", async () => {
    expect(CODEX_STDERR_LIMIT_BYTES).toBe(CLAUDE_STDERR_LIMIT_BYTES);
    const stderr = "s".repeat(CODEX_STDERR_LIMIT_BYTES * 2);
    for (const { adapter } of adapters()) {
      queueReadyCapabilityProbe(adapter.id);
      queueChild({ stderr, exitCode: 1 });
      const events = await collectEvents(
        adapter.execute(workerRequest(), new AbortController().signal),
      );
      const error = events.at(-1);
      expect(error).toMatchObject({
        type: "error",
        message: expect.stringContaining(
          `[Graphcraft truncated host stderr after ${CODEX_STDERR_LIMIT_BYTES} bytes]`,
        ),
        cause: "host_crash",
      });
      expect(error?.type === "error" ? Buffer.byteLength(error.message) : Infinity).toBeLessThan(
        CODEX_STDERR_LIMIT_BYTES + 100,
      );
    }
  });

  it("fails host capability probes closed when version or authentication output is oversized", async () => {
    for (const { adapter } of rawAdapters()) {
      queueChild({ stdout: "v".repeat(CODEX_STDERR_LIMIT_BYTES + 1) });
      await expect(adapter.probe()).resolves.toMatchObject({
        installed: false,
        authenticated: false,
        structuredOutput: false,
      });

      queueChild({ stdout: "host 1.0\n" });
      queueChild({
        stdout: adapter.id === "claude" ? "x".repeat(CODEX_STDERR_LIMIT_BYTES + 1) : "Logged in\n",
        ...(adapter.id === "codex" ? { stderr: "x".repeat(CODEX_STDERR_LIMIT_BYTES + 1) } : {}),
      });
      await expect(adapter.probe()).resolves.toMatchObject({
        installed: true,
        authenticated: false,
        protocolProfile: null,
        structuredOutput: false,
        cancellation: false,
        resume: false,
      });
    }
  });

  it("requires a positive Codex authentication marker", async () => {
    const adapter = new CodexAdapter();
    for (const authenticationOutput of ["", "Authentication status unavailable\n"]) {
      queueChild({ stdout: "codex-cli 0.144.6\n" });
      queueChild({ stdout: authenticationOutput });
      await expect(adapter.probe()).resolves.toMatchObject({
        installed: true,
        authenticated: false,
        protocolProfile: "codex-cli@0.144.6",
      });
    }
  });

  it("derives protocol capabilities only from exact recorded host versions", async () => {
    for (const { adapter } of rawAdapters()) {
      const version = adapter.id === "codex" ? "codex-cli 0.144.6\n" : "2.1.212 (Claude Code)\n";
      const profile = adapter.id === "codex" ? "codex-cli@0.144.6" : "claude-code@2.1.212";
      const authentication =
        adapter.id === "codex" ? { stdout: "Logged in\n" } : { stdout: '{"loggedIn":true}\n' };
      queueChild({ stdout: version });
      queueChild(authentication);
      await expect(adapter.probe()).resolves.toMatchObject({
        installed: true,
        authenticated: true,
        protocolProfile: profile,
        structuredOutput: true,
        streamingEvents: true,
        tokenReporting: true,
        cancellation: true,
        resume: true,
      });

      queueChild({
        stdout: adapter.id === "codex" ? "codex-cli 0.145.0\n" : "2.1.217 (Claude Code)\n",
      });
      queueChild(authentication);
      await expect(adapter.probe()).resolves.toMatchObject({
        installed: true,
        authenticated: true,
        protocolProfile: null,
        structuredOutput: false,
        streamingEvents: false,
        tokenReporting: false,
        cancellation: false,
        resume: false,
      });

      const recordedVersion =
        adapter.id === "codex" ? "codex-cli 0.144.6" : "2.1.212 (Claude Code)";
      for (const rawVersion of [
        ` ${recordedVersion}\n`,
        `${recordedVersion} \n`,
        `${recordedVersion}\n\n`,
      ]) {
        queueChild({ stdout: rawVersion });
        queueChild(authentication);
        await expect(adapter.probe()).resolves.toMatchObject({
          installed: true,
          authenticated: true,
          protocolProfile: null,
          structuredOutput: false,
          streamingEvents: false,
          tokenReporting: false,
          cancellation: false,
          resume: false,
        });
      }
    }
  });

  it("revalidates direct adapter calls before spawning a host invocation", async () => {
    for (const { adapter } of rawAdapters()) {
      queueUnauthenticatedCapabilityProbe(adapter.id);
      await expect(adapter.plan(planningRequest(), new AbortController().signal)).rejects.toThrow(
        /not authenticated/,
      );
      queueUnauthenticatedCapabilityProbe(adapter.id);
      await expect(adapter.verify(semanticRequest(), new AbortController().signal)).rejects.toThrow(
        /not authenticated/,
      );
      queueUnauthenticatedCapabilityProbe(adapter.id);
      await expect(
        collectEvents(adapter.execute(workerRequest(), new AbortController().signal)),
      ).rejects.toThrow(/not authenticated/);
    }
    expect(spawnMock).toHaveBeenCalledTimes(12);
  });

  it("allowlists Claude environments on every model invocation path", async () => {
    const originalGitHubToken = process.env.GITHUB_TOKEN;
    const originalNpmToken = process.env.NPM_TOKEN;
    process.env.GITHUB_TOKEN = "graphcraft-test-github-token";
    process.env.NPM_TOKEN = "graphcraft-test-npm-token";
    const adapter = new ClaudeAdapter();
    const graphPlan = {
      schemaVersion: 1,
      family: "feature",
      nodes: [
        {
          id: "scrub-environment",
          kind: "implementation",
          objective: "Scrub the subprocess environment",
          dependsOn: [],
          scope: ["src/**"],
          contextSelector: {
            includeRepositoryInstructions: true,
            predecessorResults: [],
            relevantPaths: ["src"],
          },
          progressProbes: [],
          completionProbes: [],
          sideEffectClass: "workspace_write",
        },
      ],
    };
    const semanticVerdict = {
      verdict: "supported",
      evidence: ["The subprocess environment was scrubbed."],
      rationale: "Every Claude model invocation received the scrub policy.",
      uncertainty: 0,
    };
    const workerResult = {
      status: "completed",
      summary: "scrubbed",
      changedPaths: [],
      evidence: ["The subprocess environment was scrubbed."],
    };
    const expectAllowlistedInvocation = async (): Promise<void> => {
      const options = spawnMock.mock.calls.at(-1)?.[2] as
        { env?: NodeJS.ProcessEnv; shell?: boolean } | undefined;
      const privateTemp = options?.env?.TMPDIR;
      expect(options).toMatchObject({
        shell: false,
        env: expect.objectContaining({
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          TEMP: privateTemp,
          TMP: privateTemp,
          TMPDIR: privateTemp,
        }),
      });
      expect(options?.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(options?.env).not.toHaveProperty("NPM_TOKEN");
      expect(options?.env).not.toHaveProperty("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
      expect(privateTemp).toMatch(/graphcraft-claude-tmp-/);
      await expect(lstat(privateTemp!)).rejects.toMatchObject({ code: "ENOENT" });
    };

    try {
      queueReadyCapabilityProbe("claude");
      queueChild({
        stdout: `${claudeSuccessfulProtocol(JSON.stringify(graphPlan))}\n`,
      });
      await adapter.plan(planningRequest(), new AbortController().signal);
      await expectAllowlistedInvocation();

      for (const worker of [workerRequest(), workerRequest("claude-session")]) {
        const sessionId = worker.resumeSessionId ?? worker.invocationId;
        queueReadyCapabilityProbe("claude");
        queueChild({
          stdout: `${claudeSuccessfulProtocol(JSON.stringify(workerResult), sessionId)}\n`,
        });
        await collectEvents(adapter.execute(worker, new AbortController().signal));
        await expectAllowlistedInvocation();
      }

      queueReadyCapabilityProbe("claude");
      const verification = semanticRequest();
      queueChild({
        stdout: `${claudeSuccessfulProtocol(JSON.stringify(semanticVerdict), verification.invocationId, "verify")}\n`,
      });
      await adapter.verify(verification, new AbortController().signal);
      await expectAllowlistedInvocation();
    } finally {
      if (originalGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalGitHubToken;
      if (originalNpmToken === undefined) delete process.env.NPM_TOKEN;
      else process.env.NPM_TOKEN = originalNpmToken;
    }
  });

  it("rejects Claude hook events before buffered model output can be accepted", async () => {
    const adapter = new ClaudeAdapter();
    const hook = `${JSON.stringify({
      type: "system",
      subtype: "hook_started",
      hook_name: "SessionStart",
    })}\n`;
    const graphPlan = {
      schemaVersion: 1,
      family: "feature",
      nodes: [
        {
          id: "reject-hook",
          kind: "implementation",
          objective: "Reject the host hook",
          dependsOn: [],
          scope: ["src/**"],
          contextSelector: {
            includeRepositoryInstructions: true,
            predecessorResults: [],
            relevantPaths: ["src"],
          },
          progressProbes: [],
          completionProbes: [],
          sideEffectClass: "workspace_write",
        },
      ],
    };
    const semanticVerdict = {
      verdict: "supported",
      evidence: ["This buffered verdict must not erase the hook event."],
      rationale: "The hook event is an unapproved side-effect boundary.",
      uncertainty: 0,
    };
    const workerResult = {
      status: "completed",
      summary: "buffered",
      changedPaths: [],
      evidence: ["This buffered result must not erase the hook event."],
    };

    const verification = semanticRequest();
    for (const [invoke, success] of [
      [
        async () => await adapter.plan(planningRequest(), new AbortController().signal),
        claudeSuccessfulProtocol(JSON.stringify(graphPlan)),
      ],
      [
        async () => await adapter.verify(verification, new AbortController().signal),
        claudeSuccessfulProtocol(
          JSON.stringify(semanticVerdict),
          verification.invocationId,
          "verify",
        ),
      ],
    ] as const) {
      queueReadyCapabilityProbe("claude");
      const child = queueChild({ stdout: `${hook}${success}\n` });
      await expect(invoke()).rejects.toThrow(/does not authorize host hooks/);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }

    const request = workerRequest();
    queueReadyCapabilityProbe("claude");
    const child = queueChild({
      stdout: `${hook}${claudeSuccessfulProtocol(JSON.stringify(workerResult), request.invocationId)}\n`,
    });
    const events = await collectEvents(adapter.execute(request, new AbortController().signal));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(events.at(-1)).toEqual({
      type: "error",
      message:
        "Claude reported a configured hook event; Graphcraft does not authorize host hooks, so the result was rejected",
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "result" }));
  });

  it("gives every Codex model invocation a private disposable temp directory", async () => {
    const adapter = new CodexAdapter();
    const result = {
      status: "completed",
      summary: "isolated temp",
      changedPaths: [],
      evidence: ["The invocation used its private temp directory."],
    };

    for (const worker of [workerRequest(), workerRequest("codex-session")]) {
      const sessionId = worker.resumeSessionId ?? randomUUID();
      queueReadyCapabilityProbe("codex");
      queueChild({
        stdout: `${codexSuccessfulProtocol(JSON.stringify(result), sessionId)}\n`,
      });
      await collectEvents(adapter.execute(worker, new AbortController().signal));

      const options = spawnMock.mock.calls.at(-1)?.[2] as
        { env?: NodeJS.ProcessEnv; shell?: boolean } | undefined;
      const privateTemp = options?.env?.TMPDIR;
      expect(options).toMatchObject({
        shell: false,
        env: expect.objectContaining({
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          TEMP: privateTemp,
          TMP: privateTemp,
          TMPDIR: privateTemp,
        }),
      });
      expect(privateTemp).toMatch(/graphcraft-codex-tmp-/);
      await expect(lstat(privateTemp!)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects Codex startup policy warnings before model work can be accepted", async () => {
    const adapter = new CodexAdapter();
    for (const message of [
      "permission_profile rejected; falling back",
      "web_search_mode rejected; falling back",
      "windows.sandbox rejected; falling back",
    ]) {
      const warning = `${JSON.stringify({
        type: "item.completed",
        item: { id: "config-warning", type: "error", message },
      })}\n`;

      for (const invoke of [
        async () => await adapter.plan(planningRequest(), new AbortController().signal),
        async () => await adapter.verify(semanticRequest(), new AbortController().signal),
      ]) {
        queueReadyCapabilityProbe("codex");
        const child = queueChild({ stdout: warning });
        await expect(invoke()).rejects.toThrow(message);
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      }

      for (const worker of [workerRequest(), workerRequest(randomUUID())]) {
        queueReadyCapabilityProbe("codex");
        const child = queueChild({ stdout: warning });
        const events = await collectEvents(adapter.execute(worker, new AbortController().signal));
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        expect(events.at(-1)).toEqual({ type: "error", message });
        expect(events).not.toContainEqual(expect.objectContaining({ type: "result" }));
      }
    }
  });

  it("latches Codex policy and turn failures ahead of buffered success output", async () => {
    const adapter = new CodexAdapter();
    const graphPlan = {
      schemaVersion: 1,
      family: "feature",
      nodes: [
        {
          id: "reject-fallback",
          kind: "implementation",
          objective: "Reject the policy fallback",
          dependsOn: [],
          scope: ["src/**"],
          contextSelector: {
            includeRepositoryInstructions: true,
            predecessorResults: [],
            relevantPaths: ["src"],
          },
          progressProbes: [],
          completionProbes: [],
          sideEffectClass: "workspace_write",
        },
      ],
    };
    const semanticVerdict = {
      verdict: "supported",
      evidence: ["The buffered verdict cannot erase the earlier failure."],
      rationale: "The policy fallback remains authoritative.",
      uncertainty: 0,
    };
    const workerResult = {
      status: "completed",
      summary: "buffered",
      changedPaths: [],
      evidence: ["The buffered result cannot erase the earlier failure."],
    };
    const warning = `${JSON.stringify({
      type: "item.completed",
      item: {
        id: "config-warning",
        type: "error",
        message: "permission profile rejected; falling back",
      },
    })}\n`;
    const turnStarted = `${JSON.stringify({ type: "turn.started" })}\n`;

    const turnFailure = `${JSON.stringify({
      type: "turn.failed",
      error: { message: "turn failed after retries" },
    })}\n`;
    for (const [invoke, success] of [
      [
        async () => await adapter.plan(planningRequest(), new AbortController().signal),
        codexStructuredEvent(JSON.stringify(graphPlan)),
      ],
      [
        async () => await adapter.verify(semanticRequest(), new AbortController().signal),
        codexStructuredEvent(JSON.stringify(semanticVerdict)),
      ],
    ] as const) {
      for (const [failure, message] of [
        [
          `${JSON.stringify({ type: "thread.started", thread_id: randomUUID() })}\n${warning}${turnStarted}`,
          "permission profile rejected; falling back",
        ],
        [
          `${JSON.stringify({ type: "thread.started", thread_id: randomUUID() })}\n${turnStarted}${turnFailure}`,
          "turn failed after retries",
        ],
      ] as const) {
        queueReadyCapabilityProbe("codex");
        const child = queueChild({ stdout: `${failure}${success}\n` });
        await expect(invoke()).rejects.toThrow(message);
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      }
    }

    const sessionId = randomUUID();
    for (const worker of [workerRequest(), workerRequest(sessionId)]) {
      for (const [failure, message] of [
        [`${warning}${turnStarted}`, "permission profile rejected; falling back"],
        [`${turnStarted}${turnFailure}`, "turn failed after retries"],
      ] as const) {
        queueReadyCapabilityProbe("codex");
        const child = queueChild({
          stdout: `${JSON.stringify({ type: "thread.started", thread_id: sessionId })}\n${failure}${codexStructuredEvent(JSON.stringify(workerResult))}\n`,
        });
        const events = await collectEvents(adapter.execute(worker, new AbortController().signal));
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        expect(events.at(-1)).toEqual({ type: "error", message });
        expect(events).not.toContainEqual(expect.objectContaining({ type: "result" }));
      }
    }
  });

  it("allows Codex to recover a transient transport error only after the turn starts", async () => {
    const adapter = new CodexAdapter();
    const graphPlan = {
      schemaVersion: 1,
      family: "feature",
      nodes: [
        {
          id: "recover-transport",
          kind: "implementation",
          objective: "Recover the transient transport error",
          dependsOn: [],
          scope: ["src/**"],
          contextSelector: {
            includeRepositoryInstructions: true,
            predecessorResults: [],
            relevantPaths: ["src"],
          },
          progressProbes: [],
          completionProbes: [],
          sideEffectClass: "workspace_write",
        },
      ],
    };
    const semanticVerdict = {
      verdict: "supported",
      evidence: ["The host recovered and returned a valid verdict."],
      rationale: "The transient error did not terminate the turn.",
      uncertainty: 0,
    };
    const workerResult = {
      status: "completed",
      summary: "recovered",
      changedPaths: [],
      evidence: ["The host recovered and returned a valid result."],
    };
    const turnStarted = `${JSON.stringify({ type: "turn.started" })}\n`;
    const transientError = `${JSON.stringify({
      type: "error",
      message: "transient stream failure; retrying",
    })}\n`;

    queueReadyCapabilityProbe("codex");
    queueChild({
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: randomUUID() })}\n${turnStarted}${transientError}${codexStructuredEvent(JSON.stringify(graphPlan))}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`,
    });
    await expect(
      adapter.plan(planningRequest(), new AbortController().signal),
    ).resolves.toMatchObject({ plan: graphPlan });

    queueReadyCapabilityProbe("codex");
    queueChild({
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: randomUUID() })}\n${turnStarted}${transientError}${codexStructuredEvent(JSON.stringify(semanticVerdict))}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`,
    });
    await expect(
      adapter.verify(semanticRequest(), new AbortController().signal),
    ).resolves.toMatchObject({ verdict: semanticVerdict });

    const sessionId = randomUUID();
    for (const worker of [workerRequest(), workerRequest(sessionId)]) {
      queueReadyCapabilityProbe("codex");
      queueChild({
        stdout: `${JSON.stringify({ type: "thread.started", thread_id: sessionId })}\n${turnStarted}${transientError}${codexStructuredEvent(JSON.stringify(workerResult))}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`,
      });
      await expect(
        collectEvents(adapter.execute(worker, new AbortController().signal)),
      ).resolves.toContainEqual({ type: "result", result: workerResult });
    }
  });

  it("reports an unavailable trusted host as not installed without spawning", async () => {
    const inheritedPath = process.env.PATH ?? "";
    vi.stubEnv("PATH", join(tmpdir(), `graphcraft-missing-host-${randomUUID()}`));
    try {
      for (const { adapter } of rawAdapters()) {
        await expect(adapter.probe()).resolves.toMatchObject({
          installed: false,
          authenticated: false,
          protocolProfile: null,
        });
        const missingCapability = {
          name: "HostCapabilityAdmissionError",
          diagnostic: expect.objectContaining({ status: "missing" }),
        };
        await expect(
          adapter.plan(planningRequest(), new AbortController().signal),
        ).rejects.toMatchObject(missingCapability);
        await expect(
          adapter.verify(semanticRequest(), new AbortController().signal),
        ).rejects.toMatchObject(missingCapability);
        await expect(
          collectEvents(adapter.execute(workerRequest(), new AbortController().signal)),
        ).rejects.toMatchObject(missingCapability);
      }
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      vi.stubEnv("PATH", inheritedPath);
    }
  });

  it.skipIf(process.platform === "win32")(
    "binds every host probe and invocation to one executable outside both worktrees",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "graphcraft-adapter-binding-"));
      const originalRepository = join(root, "original repository");
      const originalCwd = join(originalRepository, "packages", "adapter fixture");
      const siblingWorktree = join(root, "sibling worktree");
      const originalBin = join(originalRepository, "node_modules", ".bin");
      const siblingBin = join(siblingWorktree, "node_modules", ".bin");
      const trustedBin = join(root, "trusted tools");
      await Promise.all(
        [
          originalCwd,
          join(originalRepository, ".git"),
          join(siblingWorktree, ".git"),
          originalBin,
          siblingBin,
          trustedBin,
        ].map((directory) => mkdir(directory, { recursive: true })),
      );
      await Promise.all([
        execFileAsync("git", ["init", "-b", "main"], { cwd: originalRepository }),
        execFileAsync("git", ["init", "-b", "main"], { cwd: siblingWorktree }),
      ]);
      await Promise.all(
        [originalBin, siblingBin, trustedBin].flatMap((directory) =>
          ["codex", "claude"].map(async (host) => {
            const executable = join(directory, host);
            await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
            await chmod(executable, 0o755);
          }),
        ),
      );

      const inheritedPath = process.env.PATH ?? "";
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(originalCwd);
      vi.stubEnv("PATH", [originalBin, siblingBin, trustedBin, inheritedPath].join(delimiter));
      try {
        const graphPlan = {
          schemaVersion: 1,
          family: "feature",
          nodes: [
            {
              id: "bind-executable",
              kind: "implementation",
              objective: "Bind the trusted executable",
              dependsOn: [],
              scope: ["src/**"],
              contextSelector: {
                includeRepositoryInstructions: true,
                predecessorResults: [],
                relevantPaths: ["src"],
              },
              progressProbes: [],
              completionProbes: [],
              sideEffectClass: "workspace_write",
            },
          ],
        };
        const semanticVerdict = {
          verdict: "supported",
          evidence: ["Bound executable observed"],
          rationale: "All subprocesses used the same canonical executable.",
          uncertainty: 0,
        };
        const workerResult = {
          status: "completed",
          summary: "bound",
          changedPaths: [],
          evidence: ["Bound executable observed"],
        };

        for (const { adapter, structuredEvent } of rawAdapters()) {
          const trustedExecutable = await realpath(join(trustedBin, adapter.id));
          const expectBoundInvocation = async (
            output: string,
            invoke: () => Promise<unknown>,
          ): Promise<void> => {
            const callOffset = spawnMock.mock.calls.length;
            queueReadyCapabilityProbe(adapter.id);
            queueChild({ stdout: output });
            await invoke();
            expect(
              spawnMock.mock.calls.slice(callOffset).map(([executable]) => executable),
            ).toEqual([trustedExecutable, trustedExecutable, trustedExecutable]);
          };

          await expectBoundInvocation(
            `${structuredEvent(JSON.stringify(graphPlan), undefined, "plan", siblingWorktree)}\n`,
            async () =>
              await adapter.plan(
                { ...planningRequest(), repositoryPath: siblingWorktree },
                new AbortController().signal,
              ),
          );
          const verification = {
            ...semanticRequest(),
            repositoryPath: siblingWorktree,
          };
          await expectBoundInvocation(
            `${structuredEvent(
              JSON.stringify(semanticVerdict),
              verification.invocationId,
              "verify",
              siblingWorktree,
            )}\n`,
            async () => await adapter.verify(verification, new AbortController().signal),
          );
          const worker = { ...workerRequest(), repositoryPath: siblingWorktree };
          await expectBoundInvocation(
            `${structuredEvent(
              JSON.stringify(workerResult),
              worker.invocationId,
              "worker",
              siblingWorktree,
            )}\n`,
            async () => await collectEvents(adapter.execute(worker, new AbortController().signal)),
          );
        }
      } finally {
        cwd.mockRestore();
        vi.stubEnv("PATH", inheritedPath);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects an already-aborted capability probe without spawning", async () => {
    for (const { adapter } of rawAdapters()) {
      const abort = new AbortController();
      abort.abort({ cause: "user_stop", reason: "Do not start capability discovery" });

      await expect(adapter.probe(abort.signal)).rejects.toMatchObject({
        name: "HostTerminationError",
        beforeModelInvocation: true,
        termination: {
          cause: "user_stop",
          outcome: "already_exited",
          requestedSignal: "SIGTERM",
          exitCode: null,
          exitSignal: null,
        },
      });
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("preserves cancellation that races natural version or authentication settlement", async () => {
    for (const phase of ["version", "authentication"] as const) {
      for (const { adapter } of rawAdapters()) {
        const abort = new AbortController();
        const cancelAfterClose = (): void =>
          abort.abort({ cause: "user_pause", reason: `Pause after ${phase} settlement` });
        if (phase === "version") {
          queueChild({ exitCode: 1, afterClose: cancelAfterClose });
        } else {
          queueChild({
            stdout: adapter.id === "codex" ? "codex-cli 0.144.6\n" : "2.1.212 (Claude Code)\n",
          });
          queueChild({
            stdout: adapter.id === "codex" ? "Not logged in\n" : '{"loggedIn":false}\n',
            afterClose: cancelAfterClose,
          });
        }

        await expect(adapter.probe(abort.signal)).rejects.toMatchObject({
          name: "HostTerminationError",
          beforeModelInvocation: true,
          termination: {
            cause: "user_pause",
            outcome: "already_exited",
            requestedSignal: "SIGTERM",
            exitCode: null,
            exitSignal: null,
          },
        });
      }
    }
  });

  it("cancels hanging capability probes from either adapter before their timeout", async () => {
    for (const { adapter } of rawAdapters()) {
      const callOffset = spawnMock.mock.calls.length;
      const { child, spawned } = queueTerminatingChild();
      const abort = new AbortController();
      const probing = adapter.probe(abort.signal);
      await spawned;
      const rejected = expect(probing).rejects.toMatchObject({
        name: "HostTerminationError",
        beforeModelInvocation: true,
        termination: expect.objectContaining({
          cause: "user_pause",
          outcome: process.platform === "win32" ? "forced" : "graceful",
          requestedSignal: "SIGTERM",
        }),
      });

      abort.abort({ cause: "user_pause", reason: "Cancel capability discovery" });
      await rejected;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(spawnMock.mock.calls).toHaveLength(callOffset + 1);
    }
  });

  it("bounds caller-cancelled capability probes when their child never emits close", async () => {
    vi.useFakeTimers();
    for (const { adapter } of rawAdapters()) {
      const { child, spawned } = queueNeverClosingChild();
      const abort = new AbortController();
      const probing = adapter.probe(abort.signal);
      let settled = false;
      void probing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await spawned;
      const rejected = expect(probing).rejects.toMatchObject({
        name: "HostTerminationError",
        beforeModelInvocation: true,
        termination: expect.objectContaining({
          cause: "user_stop",
          outcome: "forced",
          requestedSignal: process.platform === "win32" ? "SIGTERM" : "SIGKILL",
        }),
      });

      abort.abort({ cause: "user_stop", reason: "Bound capability settlement" });
      await vi.advanceTimersByTimeAsync(HOST_CAPABILITY_PROBE_SETTLE_GRACE_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(child.stdout.destroyed).toBe(true);
    }
  });

  it("keeps the timeout receipt when caller cancellation arrives during settlement", async () => {
    vi.useFakeTimers();
    for (const { adapter } of rawAdapters()) {
      const { child, spawned } = queueNeverClosingChild();
      const abort = new AbortController();
      const probing = adapter.probe(abort.signal);
      await spawned;
      const rejected = expect(probing).rejects.toMatchObject({
        name: "HostTerminationError",
        beforeModelInvocation: true,
        termination: expect.objectContaining({
          cause: "timeout",
          outcome: "forced",
          requestedSignal: process.platform === "win32" ? "SIGTERM" : "SIGKILL",
        }),
      });

      await vi.advanceTimersByTimeAsync(HOST_CAPABILITY_PROBE_TIMEOUT_MS);
      abort.abort({ cause: "user_pause", reason: "Caller arrived after the probe timeout" });
      await vi.advanceTimersByTimeAsync(HOST_CAPABILITY_PROBE_SETTLE_GRACE_MS);

      await rejected;
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    }
  });

  it("threads cancellation through direct adapter admission before model spawn", async () => {
    for (const { adapter } of rawAdapters()) {
      const operations = [
        (signal: AbortSignal) => adapter.plan(planningRequest(), signal),
        (signal: AbortSignal) => adapter.verify(semanticRequest(), signal),
        async (signal: AbortSignal) =>
          await collectEvents(adapter.execute(workerRequest(), signal)),
      ];
      for (const operation of operations) {
        const callOffset = spawnMock.mock.calls.length;
        const { child, spawned } = queueTerminatingChild();
        const abort = new AbortController();
        const running = operation(abort.signal);
        await spawned;
        const rejected = expect(running).rejects.toMatchObject({
          name: "HostTerminationError",
          beforeModelInvocation: true,
          termination: expect.objectContaining({ cause: "cancellation" }),
        });

        abort.abort({ cause: "cancellation", reason: "Cancel direct adapter admission" });
        await rejected;
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        expect(spawnMock.mock.calls).toHaveLength(callOffset + 1);
      }
    }
  });

  it("bounds hanging capability probes and terminates their process tree", async () => {
    vi.useFakeTimers();
    for (const { adapter } of rawAdapters()) {
      const { child, spawned } = queueTerminatingChild();
      const probing = adapter.probe();
      await spawned;
      await vi.advanceTimersByTimeAsync(HOST_CAPABILITY_PROBE_TIMEOUT_MS);
      await expect(probing).resolves.toMatchObject({
        installed: false,
        authenticated: false,
        structuredOutput: false,
      });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }
  });

  it("settles capability probes even when a child never emits close", async () => {
    vi.useFakeTimers();
    for (const { adapter } of rawAdapters()) {
      const { child, spawned } = queueNeverClosingChild();
      const probing = adapter.probe();
      await spawned;
      await vi.advanceTimersByTimeAsync(
        HOST_CAPABILITY_PROBE_TIMEOUT_MS + HOST_CAPABILITY_PROBE_SETTLE_GRACE_MS,
      );
      await expect(probing).resolves.toMatchObject({
        installed: false,
        authenticated: false,
        structuredOutput: false,
      });
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(child.stdout.destroyed).toBe(true);
    }
  });

  it("terminates planner process trees through the shared cancellation controller", async () => {
    for (const { adapter } of adapters()) {
      queueReadyCapabilityProbe(adapter.id);
      const { child, spawned } = queueTerminatingChild();
      const abort = new AbortController();
      const planning = adapter.plan(planningRequest(), abort.signal);
      await spawned;
      const rejected = expect(planning).rejects.toMatchObject({
        name: "HostTerminationError",
        termination: expect.objectContaining({
          cause: "user_pause",
          outcome: process.platform === "win32" ? "forced" : "graceful",
          requestedSignal: "SIGTERM",
        }),
      });
      abort.abort({ cause: "user_pause", reason: "bounded planner cancellation" });
      await rejected;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }
  });

  it("settles operational adapter cancellation when a child never emits close", async () => {
    for (const { adapter } of adapters()) {
      queueReadyCapabilityProbe(adapter.id);
      const { child, spawned } = queueNeverClosingChild();
      const abort = new AbortController();
      const planning = adapter.plan(planningRequest(), abort.signal);
      await spawned;
      const rejected = expect(planning).rejects.toMatchObject({
        name: "HostTerminationError",
        termination: expect.objectContaining({
          cause: "user_pause",
          outcome: "forced",
          requestedSignal: process.platform === "win32" ? "SIGTERM" : "SIGKILL",
        }),
      });
      vi.useFakeTimers();
      abort.abort({ cause: "user_pause", reason: "bounded planner cancellation" });
      await vi.advanceTimersByTimeAsync(
        HOST_TERMINATION_GRACE_MS + HOST_TERMINATION_SETTLE_GRACE_MS + 1,
      );
      await rejected;
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(child.stdout.destroyed).toBe(true);
      vi.useRealTimers();
    }
  });

  it("falls back when Windows taskkill exits nonzero", () => {
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const child = {
      pid: 42,
      kill: vi.fn((_signal?: NodeJS.Signals | number) => true),
    } as unknown as ChildProcess;
    const spawnProcess = vi.fn(() => killer as never);

    expect(
      terminateChildProcessTree(child, "SIGKILL", {
        platform: "win32",
        environment: { SystemRoot: "C:\\Windows" },
        spawnProcess: spawnProcess as never,
      }),
    ).toBe(true);
    killer.emit("close", 1, null);

    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", "42", "/t", "/f"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("forces the full Windows tree when SIGTERM is requested", () => {
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const child = {
      pid: 42,
      kill: vi.fn((_signal?: NodeJS.Signals | number) => true),
    } as unknown as ChildProcess;
    const spawnProcess = vi.fn(() => killer as never);

    expect(
      terminateChildProcessTree(child, "SIGTERM", {
        platform: "win32",
        environment: { SystemRoot: "C:\\Windows" },
        spawnProcess: spawnProcess as never,
      }),
    ).toBe(true);

    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", "42", "/t", "/f"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("keeps the logical Windows termination request stable through escalation", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const abort = new AbortController();
      const controller = new ChildTerminationController(
        child as unknown as ChildProcess,
        abort.signal,
        10,
      );

      abort.abort({ cause: "user_pause", reason: "Windows termination receipt" });
      await vi.advanceTimersByTimeAsync(10);

      expect(controller.finish(null, null)).toMatchObject({
        cause: "user_pause",
        outcome: "forced",
        requestedSignal: "SIGTERM",
      });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
      platform.mockRestore();
    }
  });

  it("still accepts exact small structured worker results", async () => {
    const result = {
      status: "completed",
      summary: "bounded",
      changedPaths: [],
      evidence: ["focused adapter evidence"],
    };
    for (const fixture of adapters()) {
      const { adapter } = fixture;
      const request = workerRequest();
      queueReadyCapabilityProbe(adapter.id);
      queueChild({ stdout: boundWorkerProtocol(fixture, request, JSON.stringify(result)) });
      const events = await collectEvents(adapter.execute(request, new AbortController().signal));
      expect(events.at(-1)).toEqual({ type: "result", result });
    }
  });

  it("starts draining fast host output before the durable started event is consumed", async () => {
    const result = {
      status: "completed" as const,
      summary: "fast host",
      changedPaths: [],
      evidence: ["fast structured result"],
    };
    for (const fixture of adapters()) {
      const { adapter } = fixture;
      const request = workerRequest();
      queueReadyCapabilityProbe(adapter.id);
      queueChild({ stdout: boundWorkerProtocol(fixture, request, JSON.stringify(result)) });
      const iterator = adapter
        .execute(request, new AbortController().signal)
        [Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: expect.objectContaining({ type: "started" }),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));

      const remaining: HostEvent[] = [];
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        remaining.push(next.value);
      }
      expect(remaining.at(-1)).toEqual({ type: "result", result });
    }
  });

  it("terminates an active worker and removes private resources when its consumer returns", async () => {
    for (const fixture of adapters()) {
      const request = workerRequest();
      queueReadyCapabilityProbe(fixture.adapter.id);
      const { child } = queueTerminatingChild();
      const iterator = fixture.adapter
        .execute(request, new AbortController().signal)
        [Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: "started", invocationId: request.invocationId },
      });
      const invocation = spawnMock.mock.calls.at(-1)!;
      const args = invocation[1] as string[];
      const options = invocation[2] as { env: NodeJS.ProcessEnv };
      const privateTemp = options.env.TMPDIR!;
      const schemaPath =
        fixture.host === "Codex" ? args[args.indexOf("--output-schema") + 1] : undefined;
      await expect(lstat(privateTemp)).resolves.toBeDefined();
      if (schemaPath) await expect(lstat(dirname(schemaPath))).resolves.toBeDefined();

      await expect(iterator.return?.()).resolves.toMatchObject({ done: true });

      expect(child.kill, fixture.host).toHaveBeenCalledWith("SIGTERM");
      await expect(lstat(privateTemp), fixture.host).rejects.toMatchObject({ code: "ENOENT" });
      if (schemaPath)
        await expect(lstat(dirname(schemaPath)), fixture.host).rejects.toMatchObject({
          code: "ENOENT",
        });
    }
  });

  it.each(["plan", "verify", "worker"] as const)(
    "removes every private invocation resource when %s spawn throws synchronously",
    async (kind) => {
      for (const fixture of adapters()) {
        queueReadyCapabilityProbe(fixture.adapter.id);
        let privateTemp: string | undefined;
        let schemaPath: string | undefined;
        spawnMock.mockImplementationOnce(
          (_executable: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
            privateTemp = options.env.TMPDIR;
            if (fixture.host === "Codex") schemaPath = args[args.indexOf("--output-schema") + 1];
            throw new Error(`${fixture.host} ${kind} spawn setup failed`);
          },
        );

        const operation =
          kind === "plan"
            ? fixture.adapter.plan(planningRequest(), new AbortController().signal)
            : kind === "verify"
              ? fixture.adapter.verify(semanticRequest(), new AbortController().signal)
              : fixture.adapter
                  .execute(workerRequest(), new AbortController().signal)
                  [Symbol.asyncIterator]()
                  .next();
        await expect(operation).rejects.toThrow(`${fixture.host} ${kind} spawn setup failed`);

        expect(privateTemp, fixture.host).toBeDefined();
        await expect(lstat(privateTemp!), fixture.host).rejects.toMatchObject({ code: "ENOENT" });
        if (schemaPath)
          await expect(lstat(dirname(schemaPath)), fixture.host).rejects.toMatchObject({
            code: "ENOENT",
          });
      }
    },
  );
});
