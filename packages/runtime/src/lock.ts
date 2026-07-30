import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AtomicFilePublication } from "./json.ts";
import {
  ensurePrivateDirectory,
  finalizePrivateDirectoryMutation,
  finalizePrivateFileMutation,
  hardenPrivateFile,
  preparePrivateFileMutation,
  preparePrivateDirectoryMutation,
  privateEntryIdentityFingerprint,
  publishPrivateFileAtomic,
  readPrivateFileBounded,
  serializePrivatePathMutation,
} from "./secure-fs.ts";

const LOCK_RECORD_MAX_BYTES = 64 * 1024;
const LOCK_PUBLICATION_CONTENTION_ATTEMPTS = 16;

class RunLockPublicationContentionError extends Error {}

function isPublicationContention(error: unknown, path: string, descriptorOpened: boolean): boolean {
  if (!descriptorOpened) return false;
  if (error instanceof RunLockPublicationContentionError) return true;
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
  return (
    error instanceof Error &&
    (error.message === `Published private file changed filesystem identity: ${path}` ||
      error.message === `Private ACL target changed filesystem identity: ${path}`)
  );
}

async function yieldLockContention(): Promise<void> {
  await new Promise<void>((resolveYield) => setImmediate(resolveYield));
}

interface LockRecord {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
}

function parseLockRecord(value: string): LockRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Partial<LockRecord>;
  if (
    typeof candidate.token !== "string" ||
    candidate.token.length === 0 ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid ?? 0) <= 0 ||
    typeof candidate.hostname !== "string" ||
    candidate.hostname.length === 0 ||
    typeof candidate.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.acquiredAt)) ||
    typeof candidate.heartbeatAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.heartbeatAt))
  )
    return undefined;
  return candidate as LockRecord;
}

function isPrivateLockFile(status: BigIntStats): boolean {
  return status.isFile() && status.nlink === 1n;
}

function sameLockSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink
  );
}

async function readLockRecordFromHandle(
  handle: FileHandle,
): Promise<{ record: LockRecord; status: BigIntStats } | undefined> {
  const before = await handle.stat({ bigint: true });
  if (!isPrivateLockFile(before)) return undefined;
  if (before.size > BigInt(LOCK_RECORD_MAX_BYTES))
    throw new Error(`Private file exceeds its ${LOCK_RECORD_MAX_BYTES}-byte bounded read limit`);
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (offset !== bytes.length || !sameLockSnapshot(before, after)) return undefined;
  const record = parseLockRecord(bytes.toString("utf8"));
  return record ? { record, status: after } : undefined;
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

async function pathNamesLockDescriptor(
  path: string,
  ownedRoot: string,
  descriptorStatus: BigIntStats,
  token: string,
): Promise<boolean> {
  let pathStatus: BigIntStats;
  try {
    pathStatus = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!isPrivateLockFile(pathStatus)) return false;
  const descriptorIdentity = privateEntryIdentityFingerprint(descriptorStatus);
  const pathIdentity = privateEntryIdentityFingerprint(pathStatus);
  if (descriptorIdentity !== undefined || pathIdentity !== undefined)
    return descriptorIdentity !== undefined && descriptorIdentity === pathIdentity;
  const current = parseLockRecord(await readLockRecord(path, ownedRoot).catch(() => ""));
  return current?.token === token;
}

export class RunLock {
  private readonly path: string;
  private readonly ownedRoot: string;
  private readonly token = randomUUID();
  private heartbeat?: NodeJS.Timeout;
  private heartbeatWrite: Promise<void> = Promise.resolve();
  private heartbeatFailure?: Error;
  private readonly loss = new AbortController();
  private acquired = false;

  constructor(path: string) {
    this.path = resolve(path);
    this.ownedRoot = lockOwnedRoot(this.path);
  }

  get signal(): AbortSignal {
    return this.loss.signal;
  }

  async acquire(staleAfterMs = 30_000): Promise<void> {
    let contentionAttempts = 0;
    while (true) {
      await ensurePrivateDirectory(this.ownedRoot);
      await ensurePrivateDirectory(dirname(this.path), this.ownedRoot);
      await hardenPrivateFile(this.path, this.ownedRoot);
      let descriptorOpened = false;
      try {
        await publishPrivateFileAtomic({
          path: this.path,
          ownedRoot: this.ownedRoot,
          sourceDirectory: dirname(this.path),
          hardenOnPosix: true,
          publish: async () => {
            const handle = await open(this.path, "wx", 0o600);
            descriptorOpened = true;
            const acquiredAt = new Date().toISOString();
            let publication: AtomicFilePublication;
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
              await handle.sync();
              const status = await handle.stat({ bigint: true });
              if (!status.isFile() || status.nlink > 1n)
                throw new Error(`Run lock is not a private regular file: ${this.path}`);
              if (status.nlink === 0n)
                throw new RunLockPublicationContentionError(
                  `Run lock was unlinked during publication: ${this.path}`,
                );
              publication = {
                path: this.path,
                device: status.dev,
                inode: status.ino,
                birthtimeNs: status.birthtimeNs,
              };
            } finally {
              await handle.close();
            }
            return publication;
          },
        });
        const published = parseLockRecord(await readLockRecord(this.path, this.ownedRoot));
        if (published?.token !== this.token)
          throw new RunLockPublicationContentionError(
            `Run lock was superseded during publication: ${this.path}`,
          );
        this.acquired = true;
        break;
      } catch (error) {
        if (isPublicationContention(error, this.path, descriptorOpened)) {
          contentionAttempts += 1;
          if (contentionAttempts >= LOCK_PUBLICATION_CONTENTION_ATTEMPTS)
            throw new Error("Graphcraft run lock remained contended during publication", {
              cause: error,
            });
          await yieldLockContention();
          continue;
        }
        if (descriptorOpened || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let record: LockRecord | undefined;
        let observed = "";
        let observedStatus: BigIntStats | undefined;
        try {
          observed = await readLockRecord(this.path, this.ownedRoot);
          record = parseLockRecord(observed);
          observedStatus = await lstat(this.path, { bigint: true });
        } catch {
          // A malformed lock is only recoverable after the stale window.
        }
        const heartbeatAge = observedStatus
          ? Math.max(0, Date.now() - Number(observedStatus.mtimeMs))
          : Number.POSITIVE_INFINITY;
        const sameHost = record !== undefined && record.hostname === hostname();
        const liveLocalProcess = record !== undefined && sameHost && processExists(record.pid);
        if (liveLocalProcess || (!sameHost && heartbeatAge < staleAfterMs))
          throw new Error("Graphcraft run is already active");
        const removedObservedLock = await this.mutateLockDirectory(async () => {
          const current = await readLockRecord(this.path, this.ownedRoot).catch(
            (readError: NodeJS.ErrnoException) => {
              if (readError.code === "ENOENT") return undefined;
              throw readError;
            },
          );
          const currentStatus = await lstat(this.path, { bigint: true }).catch(
            (statusError: NodeJS.ErrnoException) => {
              if (statusError.code === "ENOENT") return undefined;
              throw statusError;
            },
          );
          if (current === undefined && currentStatus === undefined) return true;
          if (
            current !== observed ||
            observedStatus === undefined ||
            currentStatus === undefined ||
            !sameLockSnapshot(observedStatus, currentStatus)
          )
            return false;
          await unlink(this.path).catch((unlinkError: NodeJS.ErrnoException) => {
            if (unlinkError.code !== "ENOENT") throw unlinkError;
          });
          return true;
        });
        if (!removedObservedLock) await yieldLockContention();
      }
    }
    this.heartbeat = setInterval(() => {
      this.heartbeatWrite = this.heartbeatWrite
        .then(async () => await this.heartbeatTick())
        .catch((error: unknown) => this.failHeartbeat(error, false));
    }, 5_000);
    this.heartbeat.unref();
  }

  async release(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.heartbeatWrite.catch(() => undefined);
    if (this.acquired) {
      const released = await this.mutateLockDirectory(async () => {
        let observed: string;
        try {
          observed = await readLockRecord(this.path, this.ownedRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
        const current = parseLockRecord(observed);
        if (!current)
          throw new Error(`Graphcraft run lock record is malformed or ambiguous: ${this.path}`);
        if (current.token !== this.token) return false;
        try {
          await unlink(this.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
        return true;
      });
      if (released) this.acquired = false;
      else
        this.failHeartbeat(new Error(`Graphcraft run lock ownership was lost: ${this.path}`), true);
    }
    delete this.heartbeat;
    if (this.heartbeatFailure) throw this.heartbeatFailure;
  }

  private async mutateLockDirectory<T>(operation: () => Promise<T>): Promise<T> {
    return await serializePrivatePathMutation(this.path, async () => {
      const mutation = await preparePrivateDirectoryMutation(dirname(this.path), this.ownedRoot);
      try {
        return await operation();
      } finally {
        await finalizePrivateDirectoryMutation(mutation, this.ownedRoot);
      }
    });
  }

  private failHeartbeat(error: unknown, ownershipLost: boolean): void {
    if (this.heartbeatFailure) return;
    if (ownershipLost) this.acquired = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    delete this.heartbeat;
    this.heartbeatFailure =
      error instanceof Error
        ? error
        : new Error(`Graphcraft run lock heartbeat failed: ${this.path}`, { cause: error });
    this.loss.abort(this.heartbeatFailure);
  }

  private async heartbeatTick(): Promise<void> {
    try {
      if (!this.acquired || (await this.refreshHeartbeat())) return;
      this.failHeartbeat(new Error(`Graphcraft run lock ownership was lost: ${this.path}`), true);
    } catch (error) {
      this.failHeartbeat(error, false);
    }
  }

  private async refreshHeartbeat(): Promise<boolean> {
    try {
      return await serializePrivatePathMutation(this.path, async () => {
        const mutation = await preparePrivateFileMutation(this.path, this.ownedRoot);
        try {
          const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
          let handle: FileHandle;
          try {
            handle = await open(this.path, fsConstants.O_RDWR | noFollow);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
          try {
            const observed = await readLockRecordFromHandle(handle);
            if (!observed || observed.record.token !== this.token) return false;
            if (
              !(await pathNamesLockDescriptor(
                this.path,
                this.ownedRoot,
                observed.status,
                this.token,
              ))
            )
              return false;
            const now = new Date();
            await handle.utimes(now, now);
            await handle.sync();
            const after = await handle.stat({ bigint: true });
            if (!isPrivateLockFile(after)) return false;
            const beforeIdentity = privateEntryIdentityFingerprint(observed.status);
            const afterIdentity = privateEntryIdentityFingerprint(after);
            if (
              (beforeIdentity !== undefined || afterIdentity !== undefined) &&
              beforeIdentity !== afterIdentity
            )
              return false;
            return await pathNamesLockDescriptor(this.path, this.ownedRoot, after, this.token);
          } finally {
            await handle.close();
          }
        } finally {
          await finalizePrivateFileMutation(mutation, this.ownedRoot);
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

/**
 * Prevents a lock-protected owner from starting another operation after its
 * lease has been lost. An operation already in flight may settle, but every
 * later method call fails with the exact lease-loss reason. This internal
 * proxy is only for Graphcraft owner objects without native `#private` fields.
 */
export function bindToRunLockLease<T extends object>(target: T, signal: AbortSignal): T {
  return new Proxy(target, {
    get(value, property, receiver) {
      const member = Reflect.get(value, property, receiver) as unknown;
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        signal.throwIfAborted();
        return Reflect.apply(member, receiver, args);
      };
    },
  });
}

/**
 * Runs one bounded owner operation under a lock and preserves the first body
 * or lease failure over later release failures.
 */
export async function withRunLockLease<T>(
  lock: RunLock,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  await lock.acquire();
  const signal = lock.signal;
  let causalFailure: { error: unknown } | undefined;
  let bodyFailureWasThrown = false;
  const recordLeaseLoss = (): void => {
    causalFailure ??= { error: signal.reason };
  };
  if (signal.aborted) recordLeaseLoss();
  else signal.addEventListener("abort", recordLeaseLoss, { once: true });
  try {
    signal.throwIfAborted();
    const result = await operation(signal);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    bodyFailureWasThrown = true;
    throw (causalFailure ??= { error }).error;
  } finally {
    try {
      await lock.release();
    } catch (error) {
      causalFailure ??= { error };
    }
    signal.removeEventListener("abort", recordLeaseLoss);
    if (!bodyFailureWasThrown && causalFailure) throw causalFailure.error;
  }
}
