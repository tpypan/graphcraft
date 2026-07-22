import { lstat, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunLock } from "./lock.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("run lock persistence", () => {
  it("refuses an oversized stale lock instead of reading or deleting ambiguous state", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-bounds-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    await writeFile(path, "{");
    await truncate(path, 64 * 1024 + 1);

    await expect(new RunLock(path).acquire(0)).rejects.toThrow(/65536-byte bounded read limit/);
    expect((await lstat(path)).size).toBe(64 * 1024 + 1);
  });
});
