import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { open, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { writeJsonAtomic } from "./json.ts";
import { ensurePrivateDirectory, hardenPrivateFile, readPrivateFileBounded } from "./secure-fs.ts";

const LOCK_RECORD_MAX_BYTES = 64 * 1024;

interface LockRecord {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockOwnedRoot(path: string): string {
  let candidate = dirname(path);
  while (true) {
    if (basename(candidate) === ".graphcraft") return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return dirname(path);
    candidate = parent;
  }
}

async function readLockRecord(path: string, ownedRoot: string): Promise<string> {
  return (await readPrivateFileBounded(path, LOCK_RECORD_MAX_BYTES, ownedRoot)).toString("utf8");
}

export class RunLock {
  private readonly path: string;
  private readonly ownedRoot: string;
  private readonly token = randomUUID();
  private heartbeat?: NodeJS.Timeout;
  private heartbeatWrite: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
    this.ownedRoot = lockOwnedRoot(path);
  }

  async acquire(staleAfterMs = 30_000): Promise<void> {
    await ensurePrivateDirectory(this.ownedRoot);
    await ensurePrivateDirectory(dirname(this.path), this.ownedRoot);
    await hardenPrivateFile(this.path, this.ownedRoot);
    try {
      const handle = await open(this.path, "wx", 0o600);
      const acquiredAt = new Date().toISOString();
      try {
        await handle.writeFile(
          `${JSON.stringify({
            token: this.token,
            pid: process.pid,
            hostname: hostname(),
            acquiredAt,
            heartbeatAt: acquiredAt,
          })}\n`,
          "utf8",
        );
      } finally {
        await handle.close();
      }
      await hardenPrivateFile(this.path, this.ownedRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let record: LockRecord | undefined;
      let observed = "";
      try {
        observed = await readLockRecord(this.path, this.ownedRoot);
        record = JSON.parse(observed) as LockRecord;
      } catch {
        // A malformed lock is only recoverable after the stale window.
      }
      const heartbeatAge = record
        ? Math.max(0, Date.now() - Date.parse(record.heartbeatAt))
        : await stat(this.path)
            .then(({ mtimeMs }) => Math.max(0, Date.now() - mtimeMs))
            .catch(() => Number.POSITIVE_INFINITY);
      const sameHost = record !== undefined && record.hostname === hostname();
      const liveLocalProcess = record !== undefined && sameHost && processExists(record.pid);
      if (liveLocalProcess || (!sameHost && heartbeatAge < staleAfterMs))
        throw new Error("Graphcraft run is already active");
      const current = await readLockRecord(this.path, this.ownedRoot).catch(
        (readError: NodeJS.ErrnoException) => {
          if (readError.code === "ENOENT") return undefined;
          throw readError;
        },
      );
      if (current !== undefined && current !== observed) return await this.acquire(staleAfterMs);
      await unlink(this.path).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
      return await this.acquire(staleAfterMs);
    }
    this.heartbeat = setInterval(() => {
      this.heartbeatWrite = this.heartbeatWrite
        .then(() => this.writeRecord(new Date().toISOString()))
        .catch(() => undefined);
    }, 5_000);
    this.heartbeat.unref();
  }

  async release(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.heartbeatWrite.catch(() => undefined);
    await hardenPrivateFile(this.path, this.ownedRoot);
    try {
      const current = JSON.parse(await readLockRecord(this.path, this.ownedRoot)) as LockRecord;
      if (current.token === this.token) await unlink(this.path);
    } catch {
      // The lock is already gone or no longer ours.
    }
  }

  private async writeRecord(heartbeatAt: string): Promise<void> {
    await ensurePrivateDirectory(this.ownedRoot);
    await ensurePrivateDirectory(dirname(this.path), this.ownedRoot);
    await hardenPrivateFile(this.path, this.ownedRoot);
    const record: LockRecord = {
      token: this.token,
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: heartbeatAt,
      heartbeatAt,
    };
    try {
      const current = JSON.parse(await readLockRecord(this.path, this.ownedRoot)) as LockRecord;
      record.acquiredAt = current.token === this.token ? current.acquiredAt : heartbeatAt;
    } catch {
      // First write.
    }
    await writeJsonAtomic(this.path, record);
    await hardenPrivateFile(this.path, this.ownedRoot);
  }
}
