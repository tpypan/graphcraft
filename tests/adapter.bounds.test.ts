import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
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
  SemanticVerificationRequest,
  WorkerRequest,
} from "../packages/core/src/index.ts";
import {
  HOST_CAPABILITY_PROBE_SETTLE_GRACE_MS,
  HOST_CAPABILITY_PROBE_TIMEOUT_MS,
  HOST_TERMINATION_GRACE_MS,
  HOST_TERMINATION_SETTLE_GRACE_MS,
  ChildTerminationController,
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
}

function queueChild(output: FakeChildOutput): FakeChild {
  const child = new FakeChild();
  spawnMock.mockImplementationOnce(() => {
    setImmediate(() => {
      child.stdout.end(output.stdout ?? "");
      child.stderr.end(output.stderr ?? "");
      setImmediate(() => child.emit("close", output.exitCode ?? 0, null));
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

function codexStructuredEvent(value: unknown): string {
  return JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: value },
  });
}

function claudeStructuredEvent(value: unknown, sessionId?: string): string {
  return JSON.stringify({
    type: "result",
    ...(sessionId ? { session_id: sessionId } : {}),
    structured_output: value,
    usage: {},
  });
}

type AdapterFixture = {
  host: "Codex" | "Claude";
  adapter: CodexAdapter | ClaudeAdapter;
  structuredEvent(value: unknown, sessionId?: string): string;
};

function rawAdapters(): AdapterFixture[] {
  return [
    { host: "Codex", adapter: new CodexAdapter(), structuredEvent: codexStructuredEvent },
    { host: "Claude", adapter: new ClaudeAdapter(), structuredEvent: claudeStructuredEvent },
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

  it("rejects oversized structured authority in planning and semantic verification", async () => {
    expect(CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES).toBe(CLAUDE_STRUCTURED_OUTPUT_LIMIT_BYTES);
    const oversizedAuthority = "x".repeat(CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES + 1);
    for (const { host, adapter, structuredEvent } of adapters()) {
      queueReadyCapabilityProbe(adapter.id);
      queueChild({ stdout: `${structuredEvent(oversizedAuthority)}\n` });
      await expect(adapter.plan(planningRequest(), new AbortController().signal)).rejects.toThrow(
        `${host} structured graph plan exceeded the ${CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES}-byte structured-output limit`,
      );

      queueReadyCapabilityProbe(adapter.id);
      queueChild({ stdout: `${structuredEvent(oversizedAuthority)}\n` });
      await expect(adapter.verify(semanticRequest(), new AbortController().signal)).rejects.toThrow(
        `${host} semantic verdict exceeded the ${CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES}-byte structured-output limit`,
      );
    }
  });

  it("rejects oversized resumed worker authority and cannot reconcile it as completed", async () => {
    const oversizedAuthority = "x".repeat(CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES + 1);
    for (const { host, adapter, structuredEvent } of adapters()) {
      const sessionId = `${host.toLowerCase()}-session`;
      const sessionEvent =
        host === "Codex"
          ? `${JSON.stringify({ type: "thread.started", thread_id: sessionId })}\n`
          : "";
      queueReadyCapabilityProbe(adapter.id);
      queueChild({
        stdout: `${sessionEvent}${structuredEvent(oversizedAuthority, sessionId)}\n`,
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
      vi.stubEnv("PATH", [originalBin, siblingBin, trustedBin].join(delimiter));
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
            `${structuredEvent(JSON.stringify(graphPlan))}\n`,
            async () =>
              await adapter.plan(
                { ...planningRequest(), repositoryPath: siblingWorktree },
                new AbortController().signal,
              ),
          );
          await expectBoundInvocation(
            `${structuredEvent(JSON.stringify(semanticVerdict))}\n`,
            async () =>
              await adapter.verify(
                { ...semanticRequest(), repositoryPath: siblingWorktree },
                new AbortController().signal,
              ),
          );
          await expectBoundInvocation(
            `${structuredEvent(JSON.stringify(workerResult))}\n`,
            async () =>
              await collectEvents(
                adapter.execute(
                  { ...workerRequest(), repositoryPath: siblingWorktree },
                  new AbortController().signal,
                ),
              ),
          );
        }
      } finally {
        cwd.mockRestore();
        vi.stubEnv("PATH", inheritedPath);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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
    for (const { adapter, structuredEvent } of adapters()) {
      queueReadyCapabilityProbe(adapter.id);
      queueChild({ stdout: `${structuredEvent(JSON.stringify(result))}\n` });
      const events = await collectEvents(
        adapter.execute(workerRequest(), new AbortController().signal),
      );
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
    for (const { adapter, structuredEvent } of adapters()) {
      queueReadyCapabilityProbe(adapter.id);
      queueChild({ stdout: `${structuredEvent(JSON.stringify(result))}\n` });
      const iterator = adapter
        .execute(workerRequest(), new AbortController().signal)
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
});
