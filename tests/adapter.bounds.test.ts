import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

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
  HostAdapter,
  HostEvent,
  PlanningRequest,
  SemanticVerificationRequest,
  WorkerRequest,
} from "../packages/core/src/index.ts";

class FakeChild extends EventEmitter {
  readonly stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
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
  adapter: HostAdapter;
  structuredEvent(value: unknown, sessionId?: string): string;
};

function adapters(): AdapterFixture[] {
  return [
    { host: "Codex", adapter: new CodexAdapter(), structuredEvent: codexStructuredEvent },
    { host: "Claude", adapter: new ClaudeAdapter(), structuredEvent: claudeStructuredEvent },
  ];
}

describe("bounded adapter streams", () => {
  beforeEach(() => spawnMock.mockReset());

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
      queueChild({ stdout: oversizedLine });
      await expect(adapter.plan(planningRequest(), new AbortController().signal)).rejects.toThrow(
        `${host} protocol line exceeded the ${CODEX_PROTOCOL_LINE_LIMIT_BYTES}-byte limit`,
      );

      queueChild({ stdout: oversizedLine });
      await expect(adapter.verify(semanticRequest(), new AbortController().signal)).rejects.toThrow(
        `${host} protocol line exceeded the ${CODEX_PROTOCOL_LINE_LIMIT_BYTES}-byte limit`,
      );

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
      queueChild({ stdout: `${structuredEvent(oversizedAuthority)}\n` });
      await expect(adapter.plan(planningRequest(), new AbortController().signal)).rejects.toThrow(
        `${host} structured graph plan exceeded the ${CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES}-byte structured-output limit`,
      );

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
    for (const { adapter } of adapters()) {
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
        structuredOutput: true,
      });
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
