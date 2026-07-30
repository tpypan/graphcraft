import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RunControlRequestSchema, type RunControlRequest, type RunState } from "@graphcraft/core";
import { writeJsonAtomic } from "./json.ts";
import { bindToRunLockLease, RunLock, withRunLockLease } from "./lock.ts";
import { redactValue } from "./redaction.ts";
import { ensurePrivateDirectory, hardenPrivateFile, readPrivateFileBounded } from "./secure-fs.ts";
import type { RunStore } from "./store.ts";

const CONTROL_REQUEST_MAX_BYTES = 64 * 1024;

export class RunControlChannel {
  readonly path: string;
  private storageReady: Promise<void> | undefined;

  constructor(
    private readonly graphcraftRoot: string,
    private readonly runId: string,
  ) {
    this.path = join(graphcraftRoot, "controls", `${runId}.json`);
  }

  private async ensureStorage(): Promise<void> {
    this.storageReady ??= (async () => {
      await ensurePrivateDirectory(this.graphcraftRoot);
      await ensurePrivateDirectory(dirname(this.path), this.graphcraftRoot);
    })();
    try {
      await this.storageReady;
    } catch (error) {
      this.storageReady = undefined;
      throw error;
    }
  }

  async request(action: "pause" | "stop", reason: string): Promise<RunControlRequest> {
    await this.ensureStorage();
    const existing = await this.read();
    if (existing?.action === "stop" && action === "pause") return existing;
    if (existing?.action === action) return existing;
    const durableReason = redactValue(reason) as string;
    const request = RunControlRequestSchema.parse(
      redactValue({
        schemaVersion: 1,
        requestId: randomUUID(),
        runId: this.runId,
        action,
        cause: action === "pause" ? "user_pause" : "user_stop",
        reason: durableReason,
        requestedAt: new Date().toISOString(),
        requestedByPid: process.pid,
      }),
    );
    if (Buffer.byteLength(`${JSON.stringify(request, null, 2)}\n`) > CONTROL_REQUEST_MAX_BYTES)
      throw new Error(
        `Run control request exceeds its ${CONTROL_REQUEST_MAX_BYTES}-byte persistence limit`,
      );
    await hardenPrivateFile(this.path, this.graphcraftRoot);
    await writeJsonAtomic(this.path, request);
    await hardenPrivateFile(this.path, this.graphcraftRoot);
    return request;
  }

  async read(): Promise<RunControlRequest | undefined> {
    await this.ensureStorage();
    await hardenPrivateFile(this.path, this.graphcraftRoot);
    let serialized: Buffer;
    try {
      serialized = await readPrivateFileBounded(
        this.path,
        CONTROL_REQUEST_MAX_BYTES,
        this.graphcraftRoot,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      return RunControlRequestSchema.parse(JSON.parse(serialized.toString("utf8")));
    } catch {
      return undefined;
    }
  }

  watch(
    onRequest: (request: RunControlRequest) => void,
    intervalMs = 100,
    onFailure?: (error: unknown) => void,
  ): () => Promise<void> {
    let stopped = false;
    let lastRequestId: string | undefined;
    let failed = false;
    let failure: unknown;
    let inFlight = Promise.resolve();
    const poll = (): void => {
      if (stopped) return;
      inFlight = inFlight
        .then(async () => {
          if (stopped) return;
          const request = await this.read();
          if (request && request.requestId !== lastRequestId) {
            lastRequestId = request.requestId;
            onRequest(request);
          }
        })
        .catch((error: unknown) => {
          stopped = true;
          clearInterval(timer);
          if (!failed) {
            failed = true;
            failure = error;
            try {
              onFailure?.(error);
            } catch {
              // Failure notification must not replace the originating watcher failure.
            }
          }
        });
    };
    const timer = setInterval(poll, intervalMs);
    timer.unref();
    poll();
    return async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      if (failed) throw failure;
    };
  }

  async clear(requestId: string): Promise<void> {
    await this.ensureStorage();
    const current = await this.read();
    if (current?.requestId !== requestId) return;
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function targetReached(action: "pause" | "stop", state: RunState): boolean {
  if (action === "pause") return ["paused", "stopped", "completed"].includes(state.status);
  return ["stopped", "completed"].includes(state.status);
}

export async function requestRunControl(
  store: RunStore,
  action: "pause" | "stop",
  reason = action === "pause" ? "Paused by user" : "Stopped by user",
  waitMs = 10_000,
): Promise<RunState> {
  await store.prepareStorage();
  const channel = new RunControlChannel(store.graphcraftRoot, store.runId);
  const lockPath = join(store.graphcraftRoot, "locks", `${store.runId}.lock`);
  const deadline = Date.now() + waitMs;
  const settle = async (lock: RunLock, pending?: RunControlRequest): Promise<RunState> =>
    await withRunLockLease(lock, async (signal) => {
      const ownedStore = bindToRunLockLease(store, signal);
      let state = await ownedStore.loadState();
      if (!pending && targetReached(action, state)) {
        signal.throwIfAborted();
        const existing = await channel.read();
        if (existing && targetReached(existing.action, state)) {
          signal.throwIfAborted();
          await channel.clear(existing.requestId);
        }
        return state;
      }
      if (!pending) signal.throwIfAborted();
      const request = pending ?? (await channel.request(action, reason));
      if (!targetReached(request.action, state)) {
        const events = await ownedStore.loadEvents();
        const alreadyApplied = events.some(
          ({ type, data }) =>
            type === "control.applied" &&
            (data.request as RunControlRequest | null | undefined)?.requestId === request.requestId,
        );
        if (!alreadyApplied)
          await ownedStore.append(
            "runtime",
            "control.applied",
            {
              request,
              outcome: "owner_unavailable",
              termination: null,
            },
            request.requestId,
          );
        const terminalType = request.action === "pause" ? "run.paused" : "run.stopped";
        const alreadyTerminal = events.some(
          ({ type, data }) => type === terminalType && data.requestId === request.requestId,
        );
        if (!alreadyTerminal)
          await ownedStore.append(
            "user",
            terminalType,
            {
              reason: request.reason,
              requestId: request.requestId,
              cause: request.cause,
            },
            request.requestId,
          );
        state = await ownedStore.loadState();
      }
      signal.throwIfAborted();
      await channel.clear(request.requestId);
      return state;
    });

  try {
    return await settle(new RunLock(lockPath));
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Graphcraft run is already active")
      throw error;
  }

  const request = await channel.request(action, reason);
  while (Date.now() <= deadline) {
    try {
      return await settle(new RunLock(lockPath), request);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Graphcraft run is already active")
        throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `The active Graphcraft process did not acknowledge ${request.action} within ${waitMs}ms; the durable request remains pending`,
  );
}
