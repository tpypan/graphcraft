import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  MAX_ARTIFACT_INVENTORY_ENTRIES,
  MAX_ARTIFACT_INVENTORY_PATH_BYTES,
} from "@graphcraft/core";

export interface WindowsAclTarget {
  readonly kind: "directory" | "file";
  readonly path: string;
}

export interface WindowsAclRequestLimits {
  readonly maximumLineBytes: number;
  readonly maximumTargets: number;
}

const LEGACY_TREE_TARGET_CAPACITY = 1 + 8 * 1024;
const CURRENT_TREE_TOPOLOGY_TARGET_CAPACITY =
  MAX_ARTIFACT_INVENTORY_PATH_BYTES + MAX_ARTIFACT_INVENTORY_ENTRIES;
const GRAPHCRAFT_OWNED_STATE_TARGET_RESERVE = 1024;

export const WINDOWS_ACL_REQUEST_LIMITS: WindowsAclRequestLimits = Object.freeze({
  // Every unique artifact parent consumes at least one slash byte in inventory
  // path metadata. Adding the entry count therefore bounds arbitrary parent
  // depth without assuming one parent per artifact. Legacy and core state get
  // independent capacity because hardening includes the owned root itself.
  maximumTargets:
    LEGACY_TREE_TARGET_CAPACITY +
    CURRENT_TREE_TOPOLOGY_TARGET_CAPACITY +
    GRAPHCRAFT_OWNED_STATE_TARGET_RESERVE,
  // BEGIN/CHUNK/COMMIT streams avoid a giant whole-tree line. Each individual
  // line remains small enough for bounded Node and PowerShell allocation.
  maximumLineBytes: 64 * 1024,
});

function base64EncodedLength(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

function assertRequestLimits(limits: WindowsAclRequestLimits): void {
  if (
    !Number.isSafeInteger(limits.maximumLineBytes) ||
    limits.maximumLineBytes <= 0 ||
    !Number.isSafeInteger(limits.maximumTargets) ||
    limits.maximumTargets <= 0
  )
    throw new Error("Windows ACL helper request limits must be positive safe integers");
}

/** Validate the production target boundary without allocating a target array. @internal */
export function assertWindowsAclTargetCount(
  count: number,
  limits: WindowsAclRequestLimits = WINDOWS_ACL_REQUEST_LIMITS,
): void {
  assertRequestLimits(limits);
  if (!Number.isSafeInteger(count) || count <= 0)
    throw new Error("Windows ACL helper request target count must be a positive safe integer");
  if (count > limits.maximumTargets)
    throw new Error(`Windows ACL helper request exceeds its ${limits.maximumTargets}-target limit`);
}

function decodeCanonicalBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error("Windows ACL helper returned malformed base64 output");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value)
    throw new Error("Windows ACL helper returned non-canonical base64 output");
  return decoded;
}

interface WindowsAclRequestChunk {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly targetPayloadBytes: number;
  readonly encodedLineBytes: number;
}

export interface WindowsAclRequestPlan {
  readonly requestId: string;
  readonly targetCount: number;
  readonly chunks: readonly WindowsAclRequestChunk[];
  readonly lineCount: number;
}

function chunkHeader(requestId: string, chunkIndex: number, targetCount: number): string {
  return `GRAPHCRAFT_ACL_CHUNK\t${requestId}\t${chunkIndex}\t${targetCount}\t`;
}

function recordBytes(entry: WindowsAclTarget, index: number): number {
  if (
    (entry.kind !== "directory" && entry.kind !== "file") ||
    entry.path.length === 0 ||
    entry.path.includes("\0")
  )
    throw new Error(`Windows ACL helper target ${index + 1} is invalid`);
  return 2 + base64EncodedLength(Buffer.byteLength(entry.path, "utf8"));
}

/** Plan every bounded chunk before PowerShell can observe a BEGIN line. @internal */
export function planWindowsAclRequest(
  requestId: string,
  entries: readonly WindowsAclTarget[],
  limits: WindowsAclRequestLimits = WINDOWS_ACL_REQUEST_LIMITS,
): WindowsAclRequestPlan {
  if (!/^[1-9][0-9]*$/.test(requestId))
    throw new Error("Windows ACL helper request identifier must be canonical decimal");
  assertWindowsAclTargetCount(entries.length, limits);

  const chunks: WindowsAclRequestChunk[] = [];
  let chunkStart = 0;
  let chunkTargets = 0;
  let targetPayloadBytes = 0;
  for (const [entryIndex, entry] of entries.entries()) {
    const nextRecordBytes = recordBytes(entry, entryIndex);
    const nextTargetCount = chunkTargets + 1;
    const nextPayloadBytes = targetPayloadBytes + (chunkTargets === 0 ? 0 : 1) + nextRecordBytes;
    const nextLineBytes =
      Buffer.byteLength(chunkHeader(requestId, chunks.length, nextTargetCount), "utf8") +
      base64EncodedLength(nextPayloadBytes) +
      1;
    if (nextLineBytes > limits.maximumLineBytes) {
      if (chunkTargets === 0)
        throw new Error(
          `Windows ACL helper target ${entryIndex + 1} exceeds its ${limits.maximumLineBytes}-byte encoded line limit`,
        );
      const encodedLineBytes =
        Buffer.byteLength(chunkHeader(requestId, chunks.length, chunkTargets), "utf8") +
        base64EncodedLength(targetPayloadBytes) +
        1;
      chunks.push({
        index: chunks.length,
        start: chunkStart,
        end: entryIndex,
        targetPayloadBytes,
        encodedLineBytes,
      });
      chunkStart = entryIndex;
      chunkTargets = 1;
      targetPayloadBytes = nextRecordBytes;
      const singleLineBytes =
        Buffer.byteLength(chunkHeader(requestId, chunks.length, 1), "utf8") +
        base64EncodedLength(targetPayloadBytes) +
        1;
      if (singleLineBytes > limits.maximumLineBytes)
        throw new Error(
          `Windows ACL helper target ${entryIndex + 1} exceeds its ${limits.maximumLineBytes}-byte encoded line limit`,
        );
    } else {
      chunkTargets = nextTargetCount;
      targetPayloadBytes = nextPayloadBytes;
    }
  }
  const encodedLineBytes =
    Buffer.byteLength(chunkHeader(requestId, chunks.length, chunkTargets), "utf8") +
    base64EncodedLength(targetPayloadBytes) +
    1;
  chunks.push({
    index: chunks.length,
    start: chunkStart,
    end: entries.length,
    targetPayloadBytes,
    encodedLineBytes,
  });

  const begin = `GRAPHCRAFT_ACL_BEGIN\t${requestId}\t${entries.length}\t${chunks.length}\n`;
  const commit = `GRAPHCRAFT_ACL_COMMIT\t${requestId}\t${chunks.length}\t${entries.length}\n`;
  if (
    Buffer.byteLength(begin, "utf8") > limits.maximumLineBytes ||
    Buffer.byteLength(commit, "utf8") > limits.maximumLineBytes
  )
    throw new Error("Windows ACL helper request metadata exceeds its encoded line limit");
  return { requestId, targetCount: entries.length, chunks, lineCount: chunks.length + 2 };
}

/** Lazily encode one prevalidated request while retaining bounded live buffers. @internal */
export function* encodeWindowsAclRequest(
  plan: WindowsAclRequestPlan,
  entries: readonly WindowsAclTarget[],
): Generator<string> {
  if (entries.length !== plan.targetCount)
    throw new Error("Windows ACL helper target count changed after request planning");
  yield `GRAPHCRAFT_ACL_BEGIN\t${plan.requestId}\t${plan.targetCount}\t${plan.chunks.length}\n`;
  for (const chunk of plan.chunks) {
    const records: string[] = [];
    for (let index = chunk.start; index < chunk.end; index += 1) {
      const entry = entries[index];
      if (entry === undefined)
        throw new Error("Windows ACL helper target disappeared after request planning");
      records.push(
        `${entry.kind === "directory" ? "D" : "F"}\t${Buffer.from(entry.path, "utf8").toString("base64")}`,
      );
    }
    const targets = records.join("\n");
    if (Buffer.byteLength(targets, "utf8") !== chunk.targetPayloadBytes)
      throw new Error("Windows ACL helper target changed after request planning");
    const line = `${chunkHeader(plan.requestId, chunk.index, chunk.end - chunk.start)}${Buffer.from(targets, "utf8").toString("base64")}\n`;
    if (Buffer.byteLength(line, "utf8") !== chunk.encodedLineBytes)
      throw new Error("Windows ACL helper chunk length changed during encoding");
    yield line;
  }
  yield `GRAPHCRAFT_ACL_COMMIT\t${plan.requestId}\t${plan.chunks.length}\t${plan.targetCount}\n`;
}

/** Bind one strict helper response to its serialized request. @internal */
export function parseWindowsAclResponse(
  line: string,
  requestId: string,
  expectedCount: number,
): Error | undefined {
  const parts = line.split("\t");
  if (
    parts.length === 3 &&
    parts[0] === "GRAPHCRAFT_ACL_OK" &&
    parts[1] === requestId &&
    parts[2] === `${expectedCount}`
  )
    return undefined;
  if (parts.length === 3 && parts[0] === "GRAPHCRAFT_ACL_ERROR" && parts[1] === requestId) {
    const diagnostic = new TextDecoder("utf-8", { fatal: true }).decode(
      decodeCanonicalBase64(parts[2] ?? ""),
    );
    if (diagnostic.length === 0)
      throw new Error("Windows ACL helper returned an empty error diagnostic");
    return new Error(
      `Unable to enforce owner-only Windows permissions on Graphcraft state: Graphcraft Windows ACL enforcement failed: ${diagnostic}`,
    );
  }
  throw new Error("Windows ACL helper response did not match its serialized request");
}

/** Monotonic process-local identifiers for serialized helper attempts. @internal */
export class WindowsAclRequestIds {
  #sequence = 0n;

  next(): string {
    this.#sequence += 1n;
    return this.#sequence.toString(10);
  }
}

/** Retry only the narrow post-enforcement verification race. @internal */
export async function runWindowsAclVerificationAttempts(
  work: () => Promise<void>,
  maximumAttempts: number,
  waitForRetry: (attempt: number) => Promise<void> = async (attempt) =>
    await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, attempt * 25)),
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await work();
      return;
    } catch (error) {
      if (
        attempt >= maximumAttempts ||
        !(error instanceof Error) ||
        !error.message.includes("owner-only ACL verification failed")
      )
        throw error;
      await waitForRetry(attempt);
    }
  }
}

interface PendingRequest {
  readonly parseResponse: (line: string) => Error | undefined;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  commitDispatched: boolean;
  allLinesDispatched: boolean;
}

interface HelperState {
  readonly child: ChildProcessWithoutNullStreams;
  stdout: Buffer;
  stderrBytes: number;
  pending: PendingRequest | undefined;
  stopped: boolean;
}

export interface PersistentWindowsAclHelperOptions {
  readonly spawnProcess: () => ChildProcessWithoutNullStreams;
  readonly requestTimeoutMs: number;
  readonly outputLimitBytes: number;
  readonly requestLineLimitBytes: number;
  readonly maximumRequestLines: number;
}

export interface PersistentWindowsAclRequest {
  readonly lines: Iterable<string>;
  readonly lineCount: number;
}

type Referenceable = {
  ref?: () => void;
  unref?: () => void;
};

function setReferenced(target: Referenceable, referenced: boolean): void {
  const operation = referenced ? target.ref : target.unref;
  operation?.call(target);
}

/** Own one serialized, bounded, line-oriented Windows ACL helper process. @internal */
export class PersistentWindowsAclHelper {
  readonly #options: PersistentWindowsAclHelperOptions;
  #state: HelperState | undefined;

  constructor(options: PersistentWindowsAclHelperOptions) {
    this.#options = options;
  }

  async request(
    request: PersistentWindowsAclRequest,
    parseResponse: (line: string) => Error | undefined,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(request.lineCount) ||
      request.lineCount <= 0 ||
      request.lineCount > this.#options.maximumRequestLines
    )
      throw new Error("Windows ACL helper request exceeds its bounded line-count limit");

    const state = this.#state ?? this.#start();
    if (state.pending !== undefined)
      throw new Error("Windows ACL helper received concurrent serialized requests");
    this.#setProcessReferenced(state, true);
    state.stdout = Buffer.alloc(0);
    state.stderrBytes = 0;

    return await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.#stop(state, new Error("Windows ACL enforcement timed out")),
        this.#options.requestTimeoutMs,
      );
      timer.unref();
      state.pending = {
        parseResponse,
        resolve,
        reject,
        timer,
        commitDispatched: false,
        allLinesDispatched: false,
      };
      void this.#writeRequest(state, request);
    });
  }

  close(): void {
    const state = this.#state;
    if (state !== undefined) this.#stop(state);
  }

  #start(): HelperState {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#options.spawnProcess();
    } catch (error) {
      throw new Error("Unable to start trusted Windows ACL enforcement", { cause: error });
    }
    const state: HelperState = {
      child,
      stdout: Buffer.alloc(0),
      stderrBytes: 0,
      pending: undefined,
      stopped: false,
    };
    this.#state = state;
    child.stdout.on("data", (chunk: Buffer | string) => this.#acceptStdout(state, chunk));
    child.stderr.on("data", (chunk: Buffer | string) => this.#acceptStderr(state, chunk));
    child.stdin.on("error", (error) => {
      if (!state.stopped)
        this.#stop(
          state,
          new Error("Unable to write to trusted Windows ACL enforcement", { cause: error }),
        );
    });
    child.once("error", (error) => {
      if (!state.stopped)
        this.#stop(
          state,
          new Error("Unable to start trusted Windows ACL enforcement", { cause: error }),
        );
    });
    child.once("close", (code, signal) => {
      if (state.stopped) return;
      this.#stop(
        state,
        state.pending === undefined
          ? undefined
          : new Error(
              `Trusted Windows ACL enforcement exited before completing its request (code=${code === null ? "null" : code}, signal=${signal ?? "null"})`,
            ),
        false,
      );
    });
    return state;
  }

  async #writeRequest(state: HelperState, request: PersistentWindowsAclRequest): Promise<void> {
    try {
      const iterator = request.lines[Symbol.iterator]();
      for (let lineIndex = 0; lineIndex < request.lineCount; lineIndex += 1) {
        if (state.stopped) return;
        const next = iterator.next();
        if (next.done)
          throw new Error("Windows ACL helper request line count changed during encoding");
        const line = next.value;
        if (
          !line.endsWith("\n") ||
          line.slice(0, -1).includes("\n") ||
          line.slice(0, -1).includes("\r") ||
          Buffer.byteLength(line, "utf8") > this.#options.requestLineLimitBytes
        )
          throw new Error("Windows ACL helper request contains an invalid bounded line");
        if (lineIndex === request.lineCount - 1) {
          const pending = state.pending;
          if (pending === undefined) return;
          // A real child cannot observe this line before stdin.write is
          // invoked. Mark that boundary immediately before the call so a
          // fast helper response can be buffered while libuv's write callback
          // is still pending.
          pending.commitDispatched = true;
        }
        await new Promise<void>((resolveWrite, rejectWrite) => {
          state.child.stdin.write(line, "utf8", (error) => {
            if (error) rejectWrite(error);
            else resolveWrite();
          });
        });
      }
      if (!iterator.next().done)
        throw new Error("Windows ACL helper request line count changed during encoding");
      const pending = state.pending;
      if (pending !== undefined) {
        pending.allLinesDispatched = true;
        this.#settleBufferedResponse(state);
      }
    } catch (error) {
      if (!state.stopped)
        this.#stop(
          state,
          new Error("Unable to write bounded request to trusted Windows ACL enforcement", {
            cause: error,
          }),
        );
    }
  }

  #acceptStdout(state: HelperState, chunk: Buffer | string): void {
    if (state.stopped) return;
    if (state.pending === undefined) {
      this.#stop(state, new Error("Windows ACL helper produced output without a pending request"));
      return;
    }
    if (!state.pending.commitDispatched) {
      this.#stop(state, new Error("Windows ACL helper responded before request commit"));
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8");
    if (state.stdout.length + bytes.length > this.#options.outputLimitBytes) {
      this.#stop(state, new Error("Windows ACL helper exceeded its bounded output limit"));
      return;
    }
    state.stdout = Buffer.concat([state.stdout, bytes]);
    this.#settleBufferedResponse(state);
  }

  #settleBufferedResponse(state: HelperState): void {
    if (state.stopped || state.pending === undefined) return;
    const newline = state.stdout.indexOf(0x0a);
    if (newline < 0) return;
    if (newline !== state.stdout.length - 1 || state.stdout.indexOf(0x0a, newline + 1) >= 0) {
      this.#stop(state, new Error("Windows ACL helper produced malformed multi-line output"));
      return;
    }
    if (!state.pending.allLinesDispatched) return;

    let lineBytes = state.stdout.subarray(0, newline);
    if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, -1);
    const line = lineBytes.toString("utf8");
    let responseError: Error | undefined;
    try {
      responseError = state.pending.parseResponse(line);
    } catch (error) {
      responseError = new Error("Windows ACL helper produced an invalid response", {
        cause: error,
      });
    }
    if (responseError !== undefined) {
      this.#stop(state, responseError);
      return;
    }

    const pending = state.pending;
    state.pending = undefined;
    state.stdout = Buffer.alloc(0);
    clearTimeout(pending.timer);
    // Retain the helper for process lifetime without pinning Node. Parent exit
    // closes stdin, so PowerShell observes EOF and exits too.
    this.#setProcessReferenced(state, false);
    pending.resolve();
  }

  #acceptStderr(state: HelperState, chunk: Buffer | string): void {
    if (state.stopped) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    state.stderrBytes += bytes;
    this.#stop(
      state,
      new Error(
        state.stderrBytes > this.#options.outputLimitBytes
          ? "Windows ACL helper exceeded its bounded output limit"
          : "Windows ACL helper produced unexpected error output",
      ),
    );
  }

  #setProcessReferenced(state: HelperState, referenced: boolean): void {
    setReferenced(state.child, referenced);
    setReferenced(state.child.stdin as Referenceable, referenced);
    setReferenced(state.child.stdout as Referenceable, referenced);
    setReferenced(state.child.stderr as Referenceable, referenced);
  }

  #stop(state: HelperState, error?: Error, kill = true): void {
    if (state.stopped) return;
    state.stopped = true;
    if (this.#state === state) this.#state = undefined;
    const pending = state.pending;
    state.pending = undefined;
    if (pending !== undefined) clearTimeout(pending.timer);
    if (kill) {
      state.child.stdin.destroy();
      state.child.kill();
    }
    this.#setProcessReferenced(state, false);
    if (pending !== undefined)
      pending.reject(error ?? new Error("Trusted Windows ACL enforcement stopped"));
  }
}
