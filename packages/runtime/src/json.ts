import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { redactValue } from "./redaction.ts";

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(redactValue(value), null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replacePathAtomic(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Persist directory-entry changes where POSIX exposes directory fsync. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Windows can transiently deny replacement while another process or scanner
 * has the destination open. Retrying the same atomic rename preserves the
 * old-or-new visibility guarantee without unlinking the destination first.
 */
export async function replacePathAtomic(temporaryPath: string, path: string): Promise<void> {
  const retryable = new Set(["EACCES", "EBUSY", "EPERM"]);
  const deadline = Date.now() + 2_000;
  let delayMs = 5;
  while (true) {
    try {
      await rename(temporaryPath, path);
      break;
    } catch (error) {
      if (!retryable.has((error as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline)
        throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(100, delayMs * 2);
    }
  }
  const sourceDirectory = dirname(temporaryPath);
  const targetDirectory = dirname(path);
  await syncDirectory(targetDirectory);
  if (sourceDirectory !== targetDirectory) await syncDirectory(sourceDirectory);
}
