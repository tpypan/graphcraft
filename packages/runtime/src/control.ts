import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { RunControlRequestSchema, type RunControlRequest, type RunState } from "@graphcraft/core";
import { writeJsonAtomic } from "./json.ts";
import { RunLock } from "./lock.ts";
import type { RunStore } from "./store.ts";

export class RunControlChannel {
  readonly path: string;

  constructor(
    private readonly graphcraftRoot: string,
    private readonly runId: string,
  ) {
    this.path = join(graphcraftRoot, "controls", `${runId}.json`);
  }

  async request(action: "pause" | "stop", reason: string): Promise<RunControlRequest> {
    const existing = await this.read();
    if (existing?.action === "stop" && action === "pause") return existing;
    const request = RunControlRequestSchema.parse({
      schemaVersion: 1,
      requestId: randomUUID(),
      runId: this.runId,
      action,
      cause: action === "pause" ? "user_pause" : "user_stop",
      reason,
      requestedAt: new Date().toISOString(),
      requestedByPid: process.pid,
    });
    await writeJsonAtomic(this.path, request);
    return request;
  }

  async read(): Promise<RunControlRequest | undefined> {
    try {
      return RunControlRequestSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      return undefined;
    }
  }

  watch(onRequest: (request: RunControlRequest) => void, intervalMs = 100): () => Promise<void> {
    let stopped = false;
    let lastRequestId: string | undefined;
    let inFlight = Promise.resolve();
    const poll = (): void => {
      if (stopped) return;
      inFlight = inFlight.then(async () => {
        const request = await this.read();
        if (request && request.requestId !== lastRequestId) {
          lastRequestId = request.requestId;
          onRequest(request);
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
    };
  }

  async clear(requestId: string): Promise<void> {
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
  let state = await store.loadState();
  if (targetReached(action, state)) return state;
  const channel = new RunControlChannel(store.graphcraftRoot, store.runId);
  const request = await channel.request(action, reason);
  const lockPath = join(store.graphcraftRoot, "locks", `${store.runId}.lock`);
  const deadline = Date.now() + waitMs;

  while (Date.now() <= deadline) {
    const lock = new RunLock(lockPath);
    try {
      await lock.acquire();
      try {
        state = await store.loadState();
        if (!targetReached(action, state)) {
          await store.append("runtime", "control.applied", {
            request,
            outcome: "owner_unavailable",
            termination: null,
          });
          await store.append("user", action === "pause" ? "run.paused" : "run.stopped", {
            reason,
            requestId: request.requestId,
            cause: request.cause,
          });
          state = await store.loadState();
        }
        await channel.clear(request.requestId);
        return state;
      } finally {
        await lock.release();
      }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Graphcraft run is already active")
        throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `The active Graphcraft process did not acknowledge ${action} within ${waitMs}ms; the durable request remains pending`,
  );
}
