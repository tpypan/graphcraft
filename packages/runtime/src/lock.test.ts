import {
  access,
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunLock } from "./lock.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("run lock persistence", () => {
  it("publishes, excludes, releases, and reacquires the same lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-lifecycle-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const first = new RunLock(path);
    await first.acquire();

    await expect(new RunLock(path).acquire()).rejects.toThrow("Graphcraft run is already active");
    await first.release();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });

    const second = new RunLock(path);
    await second.acquire();
    await second.release();
  });

  it("refreshes heartbeat metadata without rewriting the lock record", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-heartbeat-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const lock = new RunLock(path);
    await lock.acquire();
    const record = await readFile(path);
    await utimes(path, new Date(0), new Date(0));
    const refreshHeartbeat = (
      lock as unknown as { refreshHeartbeat(): Promise<boolean> }
    ).refreshHeartbeat.bind(lock);

    await expect(refreshHeartbeat()).resolves.toBe(true);
    expect(await readFile(path)).toEqual(record);
    expect((await lstat(path)).mtimeMs).toBeGreaterThan(0);
    await lock.release();
  });

  it("does not let a stale heartbeat overwrite a successor lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-heartbeat-race-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const first = new RunLock(path);
    await first.acquire();
    const probePath = join(root, "utimes-prototype-probe");
    const probe = await open(probePath, "w", 0o600);
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      utimes(atime: Date, mtime: Date): Promise<void>;
    };
    const originalUtimes = fileHandlePrototype.utimes;
    await probe.close();
    await unlink(probePath);
    const timestamp = new Date().toISOString();
    const successor = `${JSON.stringify({
      token: "successor-lock",
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
    })}\n`;
    let intercepted = false;
    const utimes = vi.spyOn(fileHandlePrototype, "utimes").mockImplementation(async function (
      this: { utimes(atime: Date, mtime: Date): Promise<void> },
      atime: Date,
      mtime: Date,
    ) {
      if (!intercepted) {
        intercepted = true;
        await unlink(path);
        await writeFile(path, successor, { mode: 0o600 });
      }
      await originalUtimes.call(this, atime, mtime);
    });
    const heartbeatTick = (
      first as unknown as { heartbeatTick(): Promise<void> }
    ).heartbeatTick.bind(first);

    try {
      await heartbeatTick();
      expect(first.signal.aborted).toBe(true);
      expect(first.signal.reason).toEqual(
        new Error(`Graphcraft run lock ownership was lost: ${path}`),
      );
      expect(await readFile(path, "utf8")).toBe(successor);
      await expect(first.release()).rejects.toThrow("Graphcraft run lock ownership was lost");
      expect(await readFile(path, "utf8")).toBe(successor);
    } finally {
      utimes.mockRestore();
      await first.release().catch(() => undefined);
    }
  });

  it("fails closed when heartbeat maintenance errors unexpectedly", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-heartbeat-error-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const lock = new RunLock(path);
    await lock.acquire();
    const heartbeatFailure = new Error("heartbeat fsync failed");
    const internal = lock as unknown as {
      refreshHeartbeat(): Promise<boolean>;
      heartbeatTick(): Promise<void>;
    };
    const refresh = vi.spyOn(internal, "refreshHeartbeat").mockRejectedValue(heartbeatFailure);

    try {
      await internal.heartbeatTick();
      expect(lock.signal.aborted).toBe(true);
      expect(lock.signal.reason).toBe(heartbeatFailure);
      await expect(lock.release()).rejects.toBe(heartbeatFailure);
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      refresh.mockRestore();
      await lock.release().catch(() => undefined);
    }
  });

  it("retries an externally unlinked descriptor and observes the competing lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-external-unlink-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const probePath = join(root, "sync-prototype-probe");
    const probe = await open(probePath, "w", 0o600);
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      sync(): Promise<void>;
    };
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    await unlink(probePath);
    let syncStarted!: () => void;
    const publicationIsSyncing = new Promise<void>((resolve) => {
      syncStarted = resolve;
    });
    let resumeSync!: () => void;
    const mayFinishSync = new Promise<void>((resolve) => {
      resumeSync = resolve;
    });
    let intercepted = false;
    const sync = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async function (this: {
      sync(): Promise<void>;
    }) {
      if (!intercepted) {
        intercepted = true;
        syncStarted();
        await mayFinishSync;
      }
      await originalSync.call(this);
    });
    const acquiring = new RunLock(path).acquire();

    try {
      await publicationIsSyncing;
      await unlink(path);
      const timestamp = new Date().toISOString();
      await writeFile(
        path,
        `${JSON.stringify({
          token: "competing-lock",
          pid: process.pid,
          hostname: hostname(),
          acquiredAt: timestamp,
          heartbeatAt: timestamp,
        })}\n`,
        { mode: 0o600 },
      );
      resumeSync();

      await expect(acquiring).rejects.toThrow("Graphcraft run is already active");
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        token: "competing-lock",
      });
    } finally {
      resumeSync();
      await acquiring.catch(() => undefined);
      sync.mockRestore();
    }
  });

  it("rechecks its token when strict publication identity is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-supersession-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const probePath = join(root, "stat-prototype-probe");
    const probe = await open(probePath, "w", 0o600);
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      stat(options?: { bigint?: boolean }): Promise<unknown>;
    };
    const originalStat = fileHandlePrototype.stat;
    await probe.close();
    await unlink(probePath);
    let intercepted = false;
    const stat = vi.spyOn(fileHandlePrototype, "stat").mockImplementation(async function (
      this: { stat(options?: { bigint?: boolean }): Promise<unknown> },
      options?: { bigint?: boolean },
    ) {
      const status = await originalStat.call(this, options);
      if (!intercepted) {
        intercepted = true;
        Object.defineProperty(status as object, "ino", { value: 0n });
        await unlink(path);
        const timestamp = new Date().toISOString();
        await writeFile(
          path,
          `${JSON.stringify({
            token: "superseding-lock",
            pid: process.pid,
            hostname: hostname(),
            acquiredAt: timestamp,
            heartbeatAt: timestamp,
          })}\n`,
          { mode: 0o600 },
        );
      }
      return status;
    });
    const acquiring = new RunLock(path).acquire();

    try {
      await expect(acquiring).rejects.toThrow("Graphcraft run is already active");
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        token: "superseding-lock",
      });
    } finally {
      await acquiring.catch(() => undefined);
      stat.mockRestore();
    }
  });

  it("refuses an oversized stale lock instead of reading or deleting ambiguous state", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-bounds-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    await writeFile(path, "{");
    await truncate(path, 64 * 1024 + 1);

    await expect(new RunLock(path).acquire(0)).rejects.toThrow(/65536-byte bounded read limit/);
    expect((await lstat(path)).size).toBe(64 * 1024 + 1);
  });

  it("does not remove a stale lock whose heartbeat mtime advances before takeover", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-stale-heartbeat-race-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const record = `${JSON.stringify({
      token: "remote-lock",
      pid: process.pid,
      hostname: "remote-host.invalid",
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
    })}\n`;
    await writeFile(path, record, { mode: 0o600 });
    await utimes(path, new Date(0), new Date(0));
    const lock = new RunLock(path);
    const internal = lock as unknown as {
      mutateLockDirectory(operation: () => Promise<unknown>): Promise<unknown>;
    };
    const mutateLockDirectory = internal.mutateLockDirectory.bind(internal);
    const mutation = vi
      .spyOn(internal, "mutateLockDirectory")
      .mockImplementationOnce(async (operation) => {
        const now = new Date();
        await utimes(path, now, now);
        return await mutateLockDirectory(operation);
      });

    try {
      await expect(lock.acquire(1_000)).rejects.toThrow("Graphcraft run is already active");
      expect(await readFile(path, "utf8")).toBe(record);
      expect((await lstat(path)).mtimeMs).toBeGreaterThan(0);
    } finally {
      mutation.mockRestore();
    }
  });

  it("does not remove a replacement lock observed during stale takeover", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-stale-replacement-race-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const replacementPath = join(root, "replacement.lock");
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const record = `${JSON.stringify({
      token: "remote-lock",
      pid: process.pid,
      hostname: "remote-host.invalid",
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
    })}\n`;
    await writeFile(path, record, { mode: 0o600 });
    await utimes(path, new Date(0), new Date(0));
    await writeFile(replacementPath, record, { mode: 0o600 });
    const replacementStatus = await lstat(replacementPath, { bigint: true });
    const lock = new RunLock(path);
    const internal = lock as unknown as {
      mutateLockDirectory(operation: () => Promise<unknown>): Promise<unknown>;
    };
    const mutateLockDirectory = internal.mutateLockDirectory.bind(internal);
    const mutation = vi
      .spyOn(internal, "mutateLockDirectory")
      .mockImplementationOnce(async (operation) => {
        await unlink(path);
        await rename(replacementPath, path);
        return await mutateLockDirectory(operation);
      });

    try {
      await expect(lock.acquire(1_000)).rejects.toThrow("Graphcraft run is already active");
      expect(await readFile(path, "utf8")).toBe(record);
      const currentStatus = await lstat(path, { bigint: true });
      expect(currentStatus.dev).toBe(replacementStatus.dev);
      expect(currentStatus.ino).toBe(replacementStatus.ino);
      expect(currentStatus.birthtimeNs).toBe(replacementStatus.birthtimeNs);
    } finally {
      mutation.mockRestore();
    }
  });

  it("reports ownership loss when the lock disappears before release", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-missing-release-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const lock = new RunLock(path);
    await lock.acquire();
    await unlink(path);

    await expect(lock.release()).rejects.toThrow(`Graphcraft run lock ownership was lost: ${path}`);
    expect(lock.signal.aborted).toBe(true);
    expect(lock.signal.reason).toEqual(
      new Error(`Graphcraft run lock ownership was lost: ${path}`),
    );
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports ownership loss without removing a successor lock during release", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-successor-release-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const lock = new RunLock(path);
    await lock.acquire();
    await unlink(path);
    const timestamp = new Date().toISOString();
    const successor = `${JSON.stringify({
      token: "successor-lock",
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
    })}\n`;
    await writeFile(path, successor, { mode: 0o600 });

    await expect(lock.release()).rejects.toThrow(`Graphcraft run lock ownership was lost: ${path}`);
    expect(lock.signal.aborted).toBe(true);
    expect(await readFile(path, "utf8")).toBe(successor);
  });

  it("keeps malformed release state retryable", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-malformed-release-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const lock = new RunLock(path);
    await lock.acquire();
    const record = await readFile(path);
    await writeFile(path, "{}\n", { mode: 0o600 });

    await expect(lock.release()).rejects.toThrow(
      `Graphcraft run lock record is malformed or ambiguous: ${path}`,
    );
    expect(lock.signal.aborted).toBe(false);
    await writeFile(path, record, { mode: 0o600 });
    await expect(lock.release()).resolves.toBeUndefined();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a failed release retryable", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-release-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    const lock = new RunLock(path);
    await lock.acquire();
    const record = await readFile(path);
    await truncate(path, 64 * 1024 + 1);

    await expect(lock.release()).rejects.toThrow(/65536-byte bounded read limit/);
    await writeFile(path, record, { mode: 0o600 });
    await expect(lock.release()).resolves.toBeUndefined();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not steal fresh JSON with an invalid lock shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-lock-shape-test-"));
    temporaryRoots.push(root);
    const path = join(root, "run.lock");
    await writeFile(path, "{}\n", { mode: 0o600 });

    await expect(new RunLock(path).acquire()).rejects.toThrow("Graphcraft run is already active");
    expect(await readFile(path, "utf8")).toBe("{}\n");
  });
});
