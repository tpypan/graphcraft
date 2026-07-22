import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { open, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  SupervisorRecordSchema,
  type HostAdapter,
  type RunState,
  type SupervisorRecord,
} from "@graphcraft/core";
import { writeJsonAtomic } from "./json.ts";
import { redactString } from "./redaction.ts";
import { RunLock } from "./lock.ts";
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  readPrivateFileBounded,
  validatePrivatePath,
} from "./secure-fs.ts";
import { executeRun, type RunObserver } from "./runner.ts";
import { RunStore } from "./store.ts";

export interface SupervisorLauncher {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface SupervisorInspection extends SupervisorRecord {
  alive: boolean;
  heartbeatAgeMs: number;
  health: "starting" | "running" | "exited" | "failed" | "stale";
}

const KIB = 1024;
export const SUPERVISOR_LOG_MAX_BYTES = 64 * KIB;
const SUPERVISOR_LOG_RETAIN_BYTES = 32 * KIB;
const SUPERVISOR_RECORD_MAX_BYTES = 64 * KIB;
const SUPERVISOR_MESSAGE_MAX_BYTES = 16 * KIB;
const SUPERVISOR_LOG_TRUNCATION_MARKER = Buffer.from(
  `[Graphcraft supervisor log truncated; retaining the most recent ${SUPERVISOR_LOG_RETAIN_BYTES} bytes]\n`,
);

function graphcraftRoot(repositoryRoot: string): string {
  return join(repositoryRoot, ".graphcraft");
}

function supervisorRoot(repositoryRoot: string, runId: string): string {
  return join(graphcraftRoot(repositoryRoot), "supervisors", runId);
}

function supervisorRecordPath(repositoryRoot: string, runId: string, supervisorId: string): string {
  return join(supervisorRoot(repositoryRoot, runId), `${supervisorId}.json`);
}

function compactSupervisorLog(logPath: string): void {
  const before = lstatSync(logPath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1)
    throw new Error("Supervisor log is not a private regular file");
  if (before.size <= SUPERVISOR_LOG_MAX_BYTES) return;
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const descriptor = openSync(logPath, fsConstants.O_RDWR | noFollow);
  try {
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink > 1 ||
      status.dev !== before.dev ||
      status.ino !== before.ino
    )
      throw new Error("Supervisor log changed while being opened");
    if (status.size <= SUPERVISOR_LOG_MAX_BYTES) return;

    const retainedBytes = Math.min(status.size, SUPERVISOR_LOG_RETAIN_BYTES);
    const retained = Buffer.allocUnsafe(retainedBytes);
    let readBytes = 0;
    while (readBytes < retained.length) {
      const count = readSync(
        descriptor,
        retained,
        readBytes,
        retained.length - readBytes,
        status.size - retained.length + readBytes,
      );
      if (count === 0) break;
      readBytes += count;
    }
    let start = 0;
    while (start < readBytes && (retained[start]! & 0xc0) === 0x80) start += 1;
    const payload = Buffer.concat([
      SUPERVISOR_LOG_TRUNCATION_MARKER,
      retained.subarray(start, readBytes),
    ]);

    ftruncateSync(descriptor, 0);
    let written = 0;
    while (written < payload.length)
      written += writeSync(descriptor, payload, written, payload.length - written, written);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function enforceSupervisorLogLimit(logPath: string): void {
  compactSupervisorLog(logPath);
}

function maintainSupervisorLog(logPath: string): void {
  try {
    enforceSupervisorLogLimit(logPath);
  } catch (error) {
    console.error(`Supervisor log maintenance failed: ${redactString(String(error))}`);
  }
}

function processOutputTargetsLog(logPath: string): boolean {
  try {
    const output = fstatSync(process.stdout.fd);
    const log = lstatSync(logPath);
    return output.dev === log.dev && output.ino === log.ino;
  } catch {
    return false;
  }
}

async function readSupervisorRecord(path: string, ownedRoot: string): Promise<SupervisorRecord> {
  const source = await readPrivateFileBounded(path, SUPERVISOR_RECORD_MAX_BYTES, ownedRoot);
  return SupervisorRecordSchema.parse(JSON.parse(source.toString("utf8")));
}

function boundedSupervisorMessage(message: string): string {
  const redacted = redactString(message);
  if (Buffer.byteLength(redacted) <= SUPERVISOR_MESSAGE_MAX_BYTES) return redacted;
  const marker = "\n[Graphcraft supervisor message truncated]";
  const available = SUPERVISOR_MESSAGE_MAX_BYTES - Buffer.byteLength(marker);
  let prefix = "";
  let bytes = 0;
  for (const character of redacted) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > available) break;
    prefix += character;
    bytes += characterBytes;
  }
  return `${prefix}${marker}`;
}

function assertSupervisorRecordFits(record: SupervisorRecord): void {
  if (Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`) > SUPERVISOR_RECORD_MAX_BYTES)
    throw new Error(
      `Supervisor record exceeds its ${SUPERVISOR_RECORD_MAX_BYTES}-byte persistence limit`,
    );
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function listSupervisorRecords(
  repositoryRoot: string,
  runId: string,
): Promise<SupervisorRecord[]> {
  const root = supervisorRoot(repositoryRoot, runId);
  const ownedRoot = graphcraftRoot(repositoryRoot);
  let entries;
  try {
    await validatePrivatePath(ownedRoot, relative(ownedRoot, root));
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const path = join(root, entry.name);
        await validatePrivatePath(ownedRoot, relative(ownedRoot, path));
        return await readSupervisorRecord(path, ownedRoot);
      }),
  );
  return records.sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      left.supervisorId.localeCompare(right.supervisorId),
  );
}

export function inspectSupervisorRecord(
  record: SupervisorRecord,
  now = Date.now(),
): SupervisorInspection {
  const alive = isProcessAlive(record.pid);
  const heartbeatAgeMs = Math.max(0, now - Date.parse(record.heartbeatAt));
  const health =
    (record.status === "starting" || record.status === "running") &&
    (!alive || heartbeatAgeMs > 10_000)
      ? "stale"
      : record.status;
  return { ...record, alive, heartbeatAgeMs, health };
}

export async function latestSupervisor(
  repositoryRoot: string,
  runId: string,
): Promise<SupervisorInspection | undefined> {
  const latest = (await listSupervisorRecords(repositoryRoot, runId)).at(-1);
  return latest ? inspectSupervisorRecord(latest) : undefined;
}

async function waitForSupervisorRecord(
  repositoryRoot: string,
  runId: string,
  supervisorId: string,
  timeoutMs = 5_000,
): Promise<SupervisorRecord> {
  const path = supervisorRecordPath(repositoryRoot, runId, supervisorId);
  const ownedRoot = graphcraftRoot(repositoryRoot);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    await hardenPrivateFile(path, ownedRoot);
    try {
      return await readSupervisorRecord(path, ownedRoot);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function launchDetachedSupervisor(input: {
  repositoryRoot: string;
  runId: string;
  host: "codex" | "claude";
  maxWorkers: 1 | 2;
  launcher: SupervisorLauncher;
}): Promise<SupervisorRecord> {
  const previous = await latestSupervisor(input.repositoryRoot, input.runId);
  if (previous && ["starting", "running"].includes(previous.health))
    throw new Error(
      `Run ${input.runId} already has active supervisor ${previous.supervisorId} (PID ${previous.pid})`,
    );

  const supervisorId = randomUUID();
  const ownedRoot = graphcraftRoot(input.repositoryRoot);
  const root = supervisorRoot(input.repositoryRoot, input.runId);
  const logPath = join(root, `${supervisorId}.log`);
  await ensurePrivateDirectory(ownedRoot);
  await ensurePrivateDirectory(root, ownedRoot);
  await hardenPrivateFile(logPath, ownedRoot);
  const log = await open(logPath, "a", 0o600);
  await hardenPrivateFile(logPath, ownedRoot);
  let child;
  try {
    child = spawn(
      input.launcher.command,
      [
        ...input.launcher.args,
        "supervise",
        input.runId,
        "-C",
        input.repositoryRoot,
        "--host",
        input.host,
        "--max-workers",
        String(input.maxWorkers),
        "--supervisor-id",
        supervisorId,
      ],
      {
        cwd: input.repositoryRoot,
        detached: true,
        env: input.launcher.env ?? process.env,
        shell: false,
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    await new Promise<void>((resolve, reject) => {
      child!.once("spawn", resolve);
      child!.once("error", reject);
    });
    if (!child.pid) throw new Error("Detached supervisor did not report a process ID");
    const now = new Date().toISOString();
    const record = SupervisorRecordSchema.parse({
      schemaVersion: 1,
      supervisorId,
      runId: input.runId,
      repositoryRoot: input.repositoryRoot,
      pid: child.pid,
      host: input.host,
      maxWorkers: input.maxWorkers,
      status: "starting",
      startedAt: now,
      heartbeatAt: now,
      updatedAt: now,
      logPath,
      ...(previous ? { replacesSupervisorId: previous.supervisorId } : {}),
    });
    assertSupervisorRecordFits(record);
    const recordPath = supervisorRecordPath(input.repositoryRoot, input.runId, supervisorId);
    await hardenPrivateFile(recordPath, ownedRoot);
    await writeJsonAtomic(recordPath, record);
    await hardenPrivateFile(recordPath, ownedRoot);
    child.unref();
    return record;
  } catch (error) {
    child?.kill("SIGTERM");
    throw error;
  } finally {
    await log.close();
  }
}

export async function startDetachedSupervisor(input: {
  repositoryRoot: string;
  runId: string;
  host: "codex" | "claude";
  maxWorkers: 1 | 2;
  launcher: SupervisorLauncher;
}): Promise<SupervisorRecord> {
  const lock = new RunLock(
    join(input.repositoryRoot, ".graphcraft", "locks", `${input.runId}.supervisor.lock`),
  );
  await lock.acquire();
  try {
    return await launchDetachedSupervisor(input);
  } finally {
    await lock.release();
  }
}

class SupervisorLease {
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    private record: SupervisorRecord,
    private readonly path: string,
    private readonly ownedRoot: string,
  ) {}

  static async open(
    repositoryRoot: string,
    runId: string,
    supervisorId: string,
  ): Promise<SupervisorLease> {
    const record = await waitForSupervisorRecord(repositoryRoot, runId, supervisorId);
    if (record.repositoryRoot !== repositoryRoot || record.runId !== runId)
      throw new Error(`Supervisor ${supervisorId} does not own run ${runId}`);
    if (record.pid !== process.pid)
      throw new Error(
        `Supervisor ${supervisorId} expected PID ${record.pid}, received ${process.pid}`,
      );
    const expectedLogPath = join(supervisorRoot(repositoryRoot, runId), `${supervisorId}.log`);
    if (resolve(record.logPath) !== resolve(expectedLogPath))
      throw new Error(`Supervisor ${supervisorId} has an invalid log path`);
    return new SupervisorLease(
      record,
      supervisorRecordPath(repositoryRoot, runId, supervisorId),
      graphcraftRoot(repositoryRoot),
    );
  }

  logPath(): string {
    return this.record.logPath;
  }

  async update(
    patch: Partial<
      Pick<SupervisorRecord, "status" | "runStatus" | "endedAt" | "message" | "heartbeatAt">
    >,
  ): Promise<void> {
    const operation = this.tail.then(async () => {
      const now = new Date().toISOString();
      this.record = SupervisorRecordSchema.parse({
        ...this.record,
        ...patch,
        ...(patch.message !== undefined
          ? { message: boundedSupervisorMessage(patch.message) }
          : {}),
        heartbeatAt: patch.heartbeatAt ?? now,
        updatedAt: now,
      });
      assertSupervisorRecordFits(this.record);
      await ensurePrivateDirectory(dirname(this.path), this.ownedRoot);
      await hardenPrivateFile(this.path, this.ownedRoot);
      await writeJsonAtomic(this.path, this.record);
      await hardenPrivateFile(this.path, this.ownedRoot);
    });
    this.tail = operation.catch(() => undefined);
    await operation;
  }
}

export async function superviseRun(input: {
  store: RunStore;
  adapter: HostAdapter;
  supervisorId: string;
  signal: AbortSignal;
  maxWorkers?: 1 | 2;
  observer?: RunObserver;
}): Promise<RunState> {
  const lease = await SupervisorLease.open(
    input.store.repositoryRoot,
    input.store.runId,
    input.supervisorId,
  );
  await lease.update({ status: "running", message: "Supervisor owns the run lock lifecycle" });
  const logPath = lease.logPath();
  maintainSupervisorLog(logPath);
  if (processOutputTargetsLog(logPath)) process.once("exit", () => maintainSupervisorLog(logPath));
  const heartbeat = setInterval(() => {
    void lease
      .update({ heartbeatAt: new Date().toISOString() })
      .then(() => maintainSupervisorLog(logPath))
      .catch((error: unknown) =>
        console.error(`Supervisor heartbeat failed: ${redactString(String(error))}`),
      );
  }, 1_000);
  heartbeat.unref();
  try {
    const state = await executeRun({
      store: input.store,
      adapter: input.adapter,
      approve: true,
      signal: input.signal,
      superviseWaits: true,
      maxWorkers: input.maxWorkers ?? 1,
      ...(input.observer
        ? {
            observer: (event) => {
              input.observer!(event);
              maintainSupervisorLog(logPath);
            },
          }
        : {}),
    });
    clearInterval(heartbeat);
    maintainSupervisorLog(logPath);
    const endedAt = new Date().toISOString();
    await lease.update({
      status: "exited",
      runStatus: state.status,
      endedAt,
      message: state.stopReason ?? `Run exited with status ${state.status}`,
    });
    return state;
  } catch (error) {
    clearInterval(heartbeat);
    maintainSupervisorLog(logPath);
    await lease.update({
      status: "failed",
      endedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
