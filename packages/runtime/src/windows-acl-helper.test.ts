import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWindowsAclTargetCount,
  encodeWindowsAclRequest,
  parseWindowsAclResponse,
  PersistentWindowsAclHelper,
  planWindowsAclRequest,
  runWindowsAclVerificationAttempts,
  type WindowsAclTarget,
  WINDOWS_ACL_REQUEST_LIMITS,
  WindowsAclRequestIds,
} from "./windows-acl-helper.ts";

const activeHelpers = new Set<PersistentWindowsAclHelper>();

type ReferenceableStream<T> = T & {
  ref: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

function referenceable<T extends object>(stream: T): ReferenceableStream<T> {
  return Object.assign(stream, { ref: vi.fn(), unref: vi.fn() });
}

class FakeHelperStdin extends EventEmitter {
  readonly ref = vi.fn();
  readonly unref = vi.fn();
  readonly destroy = vi.fn();

  constructor(private readonly child: FakeHelperProcess) {
    super();
  }

  write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): boolean {
    const line = Buffer.from(chunk).toString("utf8");
    this.child.writes.push(line);
    this.child.onWrite?.(line, this.child.writes.length);
    const error = this.child.nextWriteError;
    this.child.nextWriteError = undefined;
    callback(error);
    return error === undefined;
  }
}

class FakeHelperProcess extends EventEmitter {
  readonly writes: string[] = [];
  readonly stdin = new FakeHelperStdin(this);
  readonly stdout = referenceable(new PassThrough());
  readonly stderr = referenceable(new PassThrough());
  readonly ref = vi.fn();
  readonly unref = vi.fn();
  readonly kill = vi.fn(() => true);
  nextWriteError: Error | undefined;
  onWrite: ((line: string, count: number) => void) | undefined;

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

function request(...lines: string[]) {
  return { lines, lineCount: lines.length };
}

function testHelper(
  options: {
    timeoutMs?: number;
    outputLimit?: number;
    lineLimit?: number;
    maximumLines?: number;
  } = {},
) {
  const children: FakeHelperProcess[] = [];
  const helper = new PersistentWindowsAclHelper({
    requestTimeoutMs: options.timeoutMs ?? 1_000,
    outputLimitBytes: options.outputLimit ?? 1_024,
    requestLineLimitBytes: options.lineLimit ?? 1_024,
    maximumRequestLines: options.maximumLines ?? 128,
    spawnProcess: () => {
      const child = new FakeHelperProcess();
      children.push(child);
      return child.asChildProcess();
    },
  });
  activeHelpers.add(helper);
  return { helper, children };
}

function exactResponse(expected: string): (line: string) => Error | undefined {
  return (line) =>
    line === expected ? undefined : new Error(`Unexpected helper response: ${line}`);
}

async function flushWrites(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

afterEach(() => {
  for (const helper of activeHelpers) helper.close();
  activeHelpers.clear();
  vi.useRealTimers();
});

describe("Windows ACL request framing", () => {
  it("plans BEGIN, bounded CHUNK, and COMMIT lines with path-safe encoding", () => {
    const path = "C:\\private Ω ' [x] & $()\tline\nbreak.json";
    const entries = [
      { kind: "directory", path: "C:\\private" },
      { kind: "file", path },
    ] as const;
    const plan = planWindowsAclRequest("42", entries);
    const lines = [...encodeWindowsAclRequest(plan, entries)];

    expect(lines).toHaveLength(plan.lineCount);
    expect(lines[0]).toBe("GRAPHCRAFT_ACL_BEGIN\t42\t2\t1\n");
    expect(lines.at(-1)).toBe("GRAPHCRAFT_ACL_COMMIT\t42\t1\t2\n");
    expect(lines.every((line) => Buffer.byteLength(line) <= 64 * 1024)).toBe(true);

    const [prefix, requestId, chunkIndex, count, payload] = lines[1]!.trimEnd().split("\t");
    expect([prefix, requestId, chunkIndex, count]).toEqual([
      "GRAPHCRAFT_ACL_CHUNK",
      "42",
      "0",
      "2",
    ]);
    const records = Buffer.from(payload!, "base64").toString("utf8").split("\n");
    expect(records[0]).toBe(`D\t${Buffer.from("C:\\private").toString("base64")}`);
    expect(Buffer.from(records[1]!.split("\t")[1]!, "base64").toString("utf8")).toBe(path);

    expect(parseWindowsAclResponse("GRAPHCRAFT_ACL_OK\t42\t2", "42", 2)).toBeUndefined();
    expect(() => parseWindowsAclResponse("GRAPHCRAFT_ACL_OK\t41\t2", "42", 2)).toThrow(
      "did not match",
    );
    expect(() => parseWindowsAclResponse("GRAPHCRAFT_ACL_OK\t42\t02", "42", 2)).toThrow(
      "did not match",
    );
    const diagnostic = "Graphcraft owner-only ACL verification failed";
    expect(
      parseWindowsAclResponse(
        `GRAPHCRAFT_ACL_ERROR\t42\t${Buffer.from(diagnostic).toString("base64")}`,
        "42",
        2,
      ),
    ).toMatchObject({ message: expect.stringContaining(diagnostic) });
    expect(() => parseWindowsAclResponse("GRAPHCRAFT_ACL_ERROR\t42\t!!!!", "42", 2)).toThrow(
      "malformed base64",
    );
    expect(() =>
      parseWindowsAclResponse(
        `GRAPHCRAFT_ACL_ERROR\t42\t${Buffer.from(diagnostic).toString("base64")}\n`,
        "42",
        2,
      ),
    ).toThrow("malformed base64");
  });

  it("enforces an exact 64 KiB chunk-line boundary and the production target cap", () => {
    const exactTarget = [{ kind: "file", path: "x".repeat(36_844) }] as const;
    const exactPlan = planWindowsAclRequest("1", exactTarget, {
      maximumLineBytes: 64 * 1024,
      maximumTargets: 1,
    });
    const exactLines = [...encodeWindowsAclRequest(exactPlan, exactTarget)];

    expect(exactPlan.chunks[0]?.encodedLineBytes).toBe(64 * 1024);
    expect(Buffer.byteLength(exactLines[1]!)).toBe(64 * 1024);
    expect(() =>
      planWindowsAclRequest("1", exactTarget, {
        maximumLineBytes: 64 * 1024 - 1,
        maximumTargets: 1,
      }),
    ).toThrow("65535-byte encoded line limit");

    expect(WINDOWS_ACL_REQUEST_LIMITS).toEqual({
      maximumLineBytes: 64 * 1024,
      maximumTargets: 1_074_177,
    });
    expect(() =>
      assertWindowsAclTargetCount(WINDOWS_ACL_REQUEST_LIMITS.maximumTargets),
    ).not.toThrow();
    expect(() =>
      assertWindowsAclTargetCount(WINDOWS_ACL_REQUEST_LIMITS.maximumTargets + 1),
    ).toThrow(`${WINDOWS_ACL_REQUEST_LIMITS.maximumTargets}-target limit`);

    let inspectedTarget = false;
    const oversizedTargets = new Proxy(
      { length: WINDOWS_ACL_REQUEST_LIMITS.maximumTargets + 1 },
      {
        get(target, property, receiver) {
          if (property === "length") return WINDOWS_ACL_REQUEST_LIMITS.maximumTargets + 1;
          inspectedTarget = true;
          return Reflect.get(target, property, receiver);
        },
      },
    ) as unknown as readonly WindowsAclTarget[];
    expect(() => planWindowsAclRequest("2", oversizedTargets)).toThrow(
      `${WINDOWS_ACL_REQUEST_LIMITS.maximumTargets}-target limit`,
    );
    expect(inspectedTarget).toBe(false);
  });

  it("chunks the valid 45,058-target reviewer topology without a giant live payload", () => {
    const inventoryPaths = Array.from(
      { length: 1_024 },
      (_, index) => `artifacts/${index.toString(36).padStart(4, "0")}/${"a/".repeat(42)}f0`,
    );
    expect(inventoryPaths.every((path) => Buffer.byteLength(path) === 101)).toBe(true);
    expect(inventoryPaths.reduce((bytes, path) => bytes + Buffer.byteLength(path), 0)).toBe(
      103_424,
    );

    const directories = new Set([".", "artifacts"]);
    for (const path of inventoryPaths) {
      const segments = path.split("/");
      for (let length = 2; length < segments.length; length += 1)
        directories.add(segments.slice(0, length).join("/"));
    }
    const targets: WindowsAclTarget[] = [
      ...[...directories].map((path): WindowsAclTarget => ({ kind: "directory", path })),
      ...inventoryPaths.map((path): WindowsAclTarget => ({ kind: "file", path })),
    ];
    expect(targets).toHaveLength(45_058);

    const plan = planWindowsAclRequest("3", targets);
    expect(plan.chunks.length).toBeGreaterThan(1);
    let encodedTargets = 0;
    let encodedLines = 0;
    for (const line of encodeWindowsAclRequest(plan, targets)) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(
        WINDOWS_ACL_REQUEST_LIMITS.maximumLineBytes,
      );
      if (line.startsWith("GRAPHCRAFT_ACL_CHUNK\t")) {
        encodedTargets += Number(line.split("\t")[3]);
        encodedLines += 1;
      }
    }
    expect(encodedLines).toBe(plan.chunks.length);
    expect(encodedTargets).toBe(45_058);
  });

  it("uses a fresh monotonic request ID for every narrow verification retry", async () => {
    const ids = new WindowsAclRequestIds();
    const attempts: string[] = [];
    const waits: number[] = [];

    await runWindowsAclVerificationAttempts(
      async () => {
        const requestId = ids.next();
        attempts.push(requestId);
        const targets = [{ kind: "file", path: "C:\\private\\state.json" }] as const;
        const plan = planWindowsAclRequest(requestId, targets);
        expect([...encodeWindowsAclRequest(plan, targets)][0]).toContain(`\t${requestId}\t`);
        if (attempts.length < 3)
          throw new Error("Graphcraft owner-only ACL verification failed after publication");
      },
      3,
      async (attempt) => {
        waits.push(attempt);
      },
    );

    expect(attempts).toEqual(["1", "2", "3"]);
    expect(waits).toEqual([1, 2]);
    await expect(
      runWindowsAclVerificationAttempts(async () => {
        throw new Error("unrelated transport failure");
      }, 3),
    ).rejects.toThrow("unrelated transport failure");
  });
});

describe("persistent Windows ACL helper transport", () => {
  it("streams multiple lines, reuses one unreferenced helper, and accepts fragmented CRLF", async () => {
    vi.useFakeTimers();
    const { helper, children } = testHelper();

    const first = helper.request(
      request("begin-1\n", "chunk-1\n", "commit-1\n"),
      exactResponse("ok-1"),
    );
    await flushWrites();
    expect(children).toHaveLength(1);
    expect(children[0]!.writes).toEqual(["begin-1\n", "chunk-1\n", "commit-1\n"]);
    children[0]!.stdout.write("ok-");
    children[0]!.stdout.write("1\r");
    children[0]!.stdout.write("\n");
    await expect(first).resolves.toBeUndefined();

    expect(children[0]!.unref).toHaveBeenCalledTimes(1);
    expect(children[0]!.stdin.unref).toHaveBeenCalledTimes(1);
    expect(children[0]!.stdout.unref).toHaveBeenCalledTimes(1);
    expect(children[0]!.stderr.unref).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(365 * 24 * 60 * 60 * 1_000);
    expect(children[0]!.kill).not.toHaveBeenCalled();

    const second = helper.request(request("begin-2\n", "commit-2\n"), exactResponse("ok-2"));
    await flushWrites();
    expect(children).toHaveLength(1);
    expect(children[0]!.ref).toHaveBeenCalledTimes(2);
    expect(children[0]!.writes).toEqual([
      "begin-1\n",
      "chunk-1\n",
      "commit-1\n",
      "begin-2\n",
      "commit-2\n",
    ]);
    children[0]!.stdout.write("ok-2\n");
    await expect(second).resolves.toBeUndefined();
  });

  it("rejects a response before COMMIT dispatch and recovers with a fresh helper", async () => {
    const { helper, children } = testHelper();

    const early = helper.request(request("begin\n", "chunk\n", "commit\n"), exactResponse("ok"));
    const earlyAssertion = expect(early).rejects.toThrow("responded before request commit");
    expect(children[0]!.writes).toEqual(["begin\n"]);
    children[0]!.stdout.write("ok\n");
    await earlyAssertion;
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);

    const recovered = helper.request(request("request-2\n"), exactResponse("ok-2"));
    await flushWrites();
    children[1]!.stdout.write("ok-2\n");
    await expect(recovered).resolves.toBeUndefined();
  });

  it("fails closed and resets after crashes, malformed output, stderr, and write errors", async () => {
    const { helper, children } = testHelper();

    const crashed = helper.request(request("request-1\n"), exactResponse("ok-1"));
    const crashedAssertion = expect(crashed).rejects.toThrow(
      "exited before completing its request",
    );
    children[0]!.emit("close", 23, null);
    await crashedAssertion;

    const malformed = helper.request(request("request-2\n"), exactResponse("ok-2"));
    const malformedAssertion = expect(malformed).rejects.toThrow("malformed multi-line output");
    await flushWrites();
    children[1]!.stdout.write("ok-2\nextra\n");
    await malformedAssertion;
    expect(children[1]!.kill).toHaveBeenCalledTimes(1);

    const unexpectedError = helper.request(request("request-3\n"), exactResponse("ok-3"));
    const stderrAssertion = expect(unexpectedError).rejects.toThrow("unexpected error output");
    children[2]!.stderr.write("unexpected diagnostic");
    await stderrAssertion;

    const emittedWriteFailure = helper.request(request("request-4\n"), exactResponse("ok-4"));
    const emittedWriteAssertion = expect(emittedWriteFailure).rejects.toThrow(
      "Unable to write to trusted Windows ACL enforcement",
    );
    children[3]!.stdin.emit("error", new Error("broken helper pipe"));
    await emittedWriteAssertion;

    const callbackWriteFailure = helper.request(
      request("begin-5\n", "commit-5\n"),
      exactResponse("ok-5"),
    );
    const callbackWriteAssertion = expect(callbackWriteFailure).rejects.toThrow(
      "Unable to write bounded request",
    );
    children[4]!.nextWriteError = new Error("write callback failed");
    await flushWrites();
    await callbackWriteAssertion;

    const asyncSpawnFailure = helper.request(request("request-6\n"), exactResponse("ok-6"));
    const asyncSpawnAssertion = expect(asyncSpawnFailure).rejects.toThrow(
      "Unable to start trusted Windows ACL enforcement",
    );
    children[5]!.emit("error", new Error("async spawn failure"));
    await asyncSpawnAssertion;

    const recovered = helper.request(request("request-7\n"), exactResponse("ok-7"));
    await flushWrites();
    children[6]!.stdout.write("ok-7\n");
    await expect(recovered).resolves.toBeUndefined();
  });

  it("bounds time and output, then resets for the next request", async () => {
    vi.useFakeTimers();
    const { helper, children } = testHelper({ timeoutMs: 50, outputLimit: 16 });

    const timedOut = helper.request(request("request-1\n"), exactResponse("ok-1"));
    const timeoutAssertion = expect(timedOut).rejects.toThrow("timed out");
    await flushWrites();
    await vi.advanceTimersByTimeAsync(50);
    await timeoutAssertion;
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);

    const oversized = helper.request(request("request-2\n"), exactResponse("ok-2"));
    const outputAssertion = expect(oversized).rejects.toThrow("bounded output limit");
    children[1]!.stdout.write("x".repeat(17));
    await outputAssertion;

    const recovered = helper.request(request("request-3\n"), exactResponse("ok-3"));
    await flushWrites();
    children[2]!.stdout.write("ok-3\n");
    await expect(recovered).resolves.toBeUndefined();
  });

  it("rejects invalid line counts and line framing without retaining a poisoned helper", async () => {
    const { helper, children } = testHelper({ lineLimit: 8, maximumLines: 2 });

    await expect(
      helper.request({ lines: ["a\n", "b\n", "c\n"], lineCount: 3 }, exactResponse("unused")),
    ).rejects.toThrow("bounded line-count limit");
    expect(children).toHaveLength(0);

    const oversized = helper.request(request("oversized\n"), exactResponse("unused"));
    await expect(oversized).rejects.toThrow("Unable to write bounded request");
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);

    const short = helper.request({ lines: ["one\n"], lineCount: 2 }, exactResponse("unused"));
    await expect(short).rejects.toMatchObject({
      message: "Unable to write bounded request to trusted Windows ACL enforcement",
      cause: { message: "Windows ACL helper request line count changed during encoding" },
    });

    const long = helper.request(
      { lines: ["one\n", "two\n"], lineCount: 1 },
      exactResponse("unused"),
    );
    await expect(long).rejects.toMatchObject({
      message: "Unable to write bounded request to trusted Windows ACL enforcement",
      cause: { message: "Windows ACL helper request line count changed during encoding" },
    });

    const carriageReturn = helper.request(request("bad\r\n"), exactResponse("unused"));
    await expect(carriageReturn).rejects.toMatchObject({
      message: "Unable to write bounded request to trusted Windows ACL enforcement",
      cause: { message: "Windows ACL helper request contains an invalid bounded line" },
    });

    const recovered = helper.request(request("ok\n"), exactResponse("done"));
    await flushWrites();
    children[4]!.stdout.write("done\n");
    await expect(recovered).resolves.toBeUndefined();
  });

  it("can start cleanly after a synchronous spawn failure or an idle helper exit", async () => {
    let attempts = 0;
    const children: FakeHelperProcess[] = [];
    const helper = new PersistentWindowsAclHelper({
      requestTimeoutMs: 1_000,
      outputLimitBytes: 1_024,
      requestLineLimitBytes: 1_024,
      maximumRequestLines: 4,
      spawnProcess: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("spawn failed");
        const child = new FakeHelperProcess();
        children.push(child);
        return child.asChildProcess();
      },
    });
    activeHelpers.add(helper);

    await expect(helper.request(request("request-1\n"), exactResponse("ok-1"))).rejects.toThrow(
      "Unable to start trusted Windows ACL enforcement",
    );
    const first = helper.request(request("request-2\n"), exactResponse("ok-2"));
    await flushWrites();
    children[0]!.stdout.write("ok-2\n");
    await expect(first).resolves.toBeUndefined();

    children[0]!.emit("close", 0, null);
    const afterEof = helper.request(request("request-3\n"), exactResponse("ok-3"));
    await flushWrites();
    expect(children).toHaveLength(2);
    children[1]!.stdout.write("ok-3\n");
    await expect(afterEof).resolves.toBeUndefined();
  });
});
