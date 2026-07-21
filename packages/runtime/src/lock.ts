import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { writeJsonAtomic } from "./json.ts";

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

export class RunLock {
  private readonly path: string;
  private readonly token = randomUUID();
  private heartbeat?: NodeJS.Timeout;
  private heartbeatWrite: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async acquire(staleAfterMs = 30_000): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let record: LockRecord | undefined;
      try {
        record = JSON.parse(await readFile(this.path, "utf8")) as LockRecord;
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
      await unlink(this.path);
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
    try {
      const current = JSON.parse(await readFile(this.path, "utf8")) as LockRecord;
      if (current.token === this.token) await unlink(this.path);
    } catch {
      // The lock is already gone or no longer ours.
    }
  }

  private async writeRecord(heartbeatAt: string): Promise<void> {
    const record: LockRecord = {
      token: this.token,
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: heartbeatAt,
      heartbeatAt,
    };
    try {
      const current = JSON.parse(await readFile(this.path, "utf8")) as LockRecord;
      record.acquiredAt = current.token === this.token ? current.acquiredAt : heartbeatAt;
    } catch {
      // First write.
    }
    await writeJsonAtomic(this.path, record);
  }
}
