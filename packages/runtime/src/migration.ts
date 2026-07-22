import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RunStorageManifestSchema, type RunStorageManifest } from "@graphcraft/core";
import { writeJsonAtomic } from "./json.ts";
import { RunLock } from "./lock.ts";

export const CURRENT_RUN_STORAGE_VERSION = 1;

function manifest(runId: string, migratedFrom: 0 | 1): RunStorageManifest {
  return RunStorageManifestSchema.parse({
    schemaVersion: CURRENT_RUN_STORAGE_VERSION,
    runId,
    migratedFrom,
    formats: {
      contract: 1,
      graph: 1,
      probePlan: 1,
      events: 1,
      state: 1,
      workspace: 1,
      capsules: 1,
      invocationEvents: 1,
      semanticReports: 1,
      rawArtifacts: 1,
      controlRequests: 1,
      locks: 1,
    },
  });
}

export function runStorageManifestPath(runRoot: string): string {
  return join(runRoot, "storage.json");
}

export async function writeCurrentRunStorageManifest(
  runRoot: string,
  runId: string,
  migratedFrom: 0 | 1,
): Promise<RunStorageManifest> {
  const value = manifest(runId, migratedFrom);
  await writeJsonAtomic(runStorageManifestPath(runRoot), value);
  return value;
}

export async function ensureCurrentRunStorage(input: {
  graphcraftRoot: string;
  runRoot: string;
  runId: string;
}): Promise<RunStorageManifest> {
  const path = runStorageManifestPath(input.runRoot);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        `Run ${input.runId} has an unreadable storage manifest: ${(error as Error).message}`,
      );
  }
  if (raw !== undefined) {
    const version =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>).schemaVersion
        : undefined;
    if (typeof version === "number" && version > CURRENT_RUN_STORAGE_VERSION)
      throw new Error(
        `Run ${input.runId} uses future storage schema ${version}; this Graphcraft supports through ${CURRENT_RUN_STORAGE_VERSION}. No files were changed.`,
      );
    if (version !== CURRENT_RUN_STORAGE_VERSION)
      throw new Error(
        `Run ${input.runId} uses unsupported storage schema ${String(version)}; no migration path is available. No files were changed.`,
      );
    const parsed = RunStorageManifestSchema.parse(raw);
    if (parsed.runId !== input.runId)
      throw new Error(`Run storage manifest belongs to ${parsed.runId}, not ${input.runId}`);
    return parsed;
  }

  await readFile(join(input.runRoot, "events.jsonl"), "utf8").catch((error) => {
    throw new Error(
      `Legacy run ${input.runId} cannot migrate because events.jsonl is unavailable: ${(error as Error).message}`,
    );
  });
  const lock = new RunLock(join(input.graphcraftRoot, "locks", `${input.runId}.migration.lock`));
  try {
    await lock.acquire();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already active")) throw error;
    const deadline = Date.now() + 5_000;
    while (Date.now() <= deadline) {
      const migrated = await readFile(path, "utf8")
        .then((value) => RunStorageManifestSchema.parse(JSON.parse(value)))
        .catch(() => undefined);
      if (migrated) return migrated;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for storage migration of run ${input.runId}`);
  }
  try {
    const migrated = await readFile(path, "utf8")
      .then((value) => RunStorageManifestSchema.parse(JSON.parse(value)))
      .catch(() => undefined);
    if (migrated) return migrated;
    const backupRoot = join(input.graphcraftRoot, "migration-backups", input.runId, "0-to-1");
    await cp(input.runRoot, backupRoot, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
    return await writeCurrentRunStorageManifest(input.runRoot, input.runId, 0);
  } finally {
    await lock.release();
  }
}
