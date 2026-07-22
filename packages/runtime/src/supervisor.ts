import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  SupervisorRecordSchema,
  type HostAdapter,
  type RunState,
  type SupervisorRecord,
} from "@graphcraft/core";
import { writeJsonAtomic } from "./json.ts";
import { redactString } from "./redaction.ts";
import { RunLock } from "./lock.ts";
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

function supervisorRoot(repositoryRoot: string, runId: string): string {
  return join(repositoryRoot, ".graphcraft", "supervisors", runId);
}

function supervisorRecordPath(repositoryRoot: string, runId: string, supervisorId: string): string {
  return join(supervisorRoot(repositoryRoot, runId), `${supervisorId}.json`);
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
  let entries;
  try {
    entries = await readdir(supervisorRoot(repositoryRoot, runId), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) =>
        SupervisorRecordSchema.parse(
          JSON.parse(
            await readFile(join(supervisorRoot(repositoryRoot, runId), entry.name), "utf8"),
          ),
        ),
      ),
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
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return SupervisorRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
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
  const root = supervisorRoot(input.repositoryRoot, input.runId);
  const logPath = join(root, `${supervisorId}.log`);
  await mkdir(root, { recursive: true });
  const log = await open(logPath, "a", 0o600);
  await chmod(logPath, 0o600);
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
    await writeJsonAtomic(
      supervisorRecordPath(input.repositoryRoot, input.runId, supervisorId),
      record,
    );
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
    return new SupervisorLease(record, supervisorRecordPath(repositoryRoot, runId, supervisorId));
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
        heartbeatAt: patch.heartbeatAt ?? now,
        updatedAt: now,
      });
      await writeJsonAtomic(this.path, this.record);
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
  const heartbeat = setInterval(() => {
    void lease
      .update({ heartbeatAt: new Date().toISOString() })
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
      ...(input.observer ? { observer: input.observer } : {}),
    });
    clearInterval(heartbeat);
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
    await lease.update({
      status: "failed",
      endedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
