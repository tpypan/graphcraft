import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunControlChannel } from "./control.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

async function createChannel(): Promise<RunControlChannel> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-control-test-"));
  temporaryRoots.push(root);
  return new RunControlChannel(join(root, ".graphcraft"), randomUUID());
}

describe("run control persistence", () => {
  it("rejects a control request that exceeds its persistence limit", async () => {
    const channel = await createChannel();

    await expect(channel.request("pause", "x".repeat(64 * 1024))).rejects.toThrow(
      /control request exceeds.*65536-byte persistence limit/,
    );
  });

  it("refuses an oversized persisted control request through a bounded descriptor read", async () => {
    const channel = await createChannel();
    await mkdir(dirname(channel.path), { recursive: true });
    await writeFile(channel.path, "{");
    await truncate(channel.path, 64 * 1024 + 1);

    await expect(channel.read()).rejects.toThrow(/65536-byte bounded read limit/);
  });

  it("stops polling after the first read failure and reports it during shutdown", async () => {
    const channel = await createChannel();
    const graphcraftRoot = dirname(dirname(channel.path));
    await channel.read();
    await rm(graphcraftRoot, { recursive: true });
    const read = vi.spyOn(channel, "read");
    const callbackFailure = new Error("failure callback failed");
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    const stopWatching = channel.watch(
      () => undefined,
      1,
      (error) => {
        reportFailure(error);
        throw callbackFailure;
      },
    );

    const watcherFailure = await reportedFailure;
    expect(watcherFailure).toMatchObject({ code: "ENOENT" });

    expect(read).toHaveBeenCalledTimes(1);
    await expect(stopWatching()).rejects.toBe(watcherFailure);
  });
});
