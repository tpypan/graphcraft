import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const MEBIBYTE = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export const REPOSITORY_FILE_MAX_BYTES = 8 * MEBIBYTE;

export type RepositoryFileErrorKind =
  | "outside_repository"
  | "missing"
  | "not_file"
  | "not_directory"
  | "unsupported_type"
  | "too_large"
  | "changed"
  | "unreadable";

export class RepositoryFileError extends Error {
  readonly kind: RepositoryFileErrorKind;
  readonly repositoryPath: string;

  constructor(kind: RepositoryFileErrorKind, repositoryPath: string, detail: string) {
    super(`Repository path ${JSON.stringify(repositoryPath)} ${detail}`);
    this.name = "RepositoryFileError";
    this.kind = kind;
    this.repositoryPath = repositoryPath;
  }
}

export function isRepositoryFileError(
  error: unknown,
  ...kinds: RepositoryFileErrorKind[]
): error is RepositoryFileError {
  return error instanceof RepositoryFileError && (kinds.length === 0 || kinds.includes(error.kind));
}

function sanitizedPath(candidate: string): string {
  return candidate.slice(0, 4_096);
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function assertUnresolvedPathInsideRepository(
  canonicalRoot: string,
  candidate: string,
  displayPath: string,
  signal?: AbortSignal,
): Promise<void> {
  let current = candidate;
  const visited = new Set<string>();
  for (let hop = 0; hop < 64; hop += 1) {
    signal?.throwIfAborted();
    if (visited.has(current))
      throw new RepositoryFileError("unreadable", displayPath, "could not be resolved safely");
    visited.add(current);

    let details: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      details = await lstat(current);
    } catch (error) {
      signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR")
        throw new RepositoryFileError("unreadable", displayPath, "could not be resolved safely");
    }
    if (details?.isSymbolicLink()) {
      try {
        current = resolve(dirname(current), await readlink(current));
      } catch {
        signal?.throwIfAborted();
        throw new RepositoryFileError("unreadable", displayPath, "could not be resolved safely");
      }
      continue;
    }

    try {
      const canonicalExistingPath = await realpath(current);
      if (!inside(canonicalRoot, canonicalExistingPath))
        throw new RepositoryFileError(
          "outside_repository",
          displayPath,
          "resolves outside the repository boundary",
        );
      return;
    } catch (error) {
      signal?.throwIfAborted();
      if (isRepositoryFileError(error)) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR")
        throw new RepositoryFileError("unreadable", displayPath, "could not be resolved safely");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new RepositoryFileError("unreadable", displayPath, "could not be resolved safely");
}

function validateMaximumBytes(maximumBytes: number): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0)
    throw new Error("Repository file read limit must be a positive safe integer");
}

async function canonicalRepositoryPath(
  repositoryRoot: string,
  candidate: string,
  signal?: AbortSignal,
): Promise<{ canonicalRoot: string; canonicalPath: string; displayPath: string }> {
  signal?.throwIfAborted();
  const displayPath = sanitizedPath(candidate);
  if (candidate.includes("\0") || isAbsolute(candidate))
    throw new RepositoryFileError(
      "outside_repository",
      displayPath,
      "is outside the repository boundary",
    );
  const root = resolve(repositoryRoot);
  const lexicalPath = resolve(root, candidate);
  if (!inside(root, lexicalPath))
    throw new RepositoryFileError(
      "outside_repository",
      displayPath,
      "is outside the repository boundary",
    );
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    signal?.throwIfAborted();
    throw new RepositoryFileError("unreadable", ".", "could not establish the repository boundary");
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch (error) {
    signal?.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      await assertUnresolvedPathInsideRepository(canonicalRoot, lexicalPath, displayPath, signal);
    throw new RepositoryFileError(
      code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
      displayPath,
      code === "ENOENT" || code === "ENOTDIR" ? "does not exist" : "could not be resolved safely",
    );
  }
  signal?.throwIfAborted();
  if (!inside(canonicalRoot, canonicalPath))
    throw new RepositoryFileError(
      "outside_repository",
      displayPath,
      "resolves outside the repository boundary",
    );
  return { canonicalRoot, canonicalPath, displayPath };
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0n && right.ino !== 0n && left.ino !== right.ino) return false;
  return true;
}

async function closeIgnoringFailure(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  await handle.close().catch(() => undefined);
}

async function inspectRepositoryPath(
  repositoryRoot: string,
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<{
  canonicalPath: string;
  displayPath: string;
  details: BigIntStats;
}> {
  const resolved = await canonicalRepositoryPath(repositoryRoot, repositoryPath, signal);
  let details: BigIntStats;
  try {
    details = await stat(resolved.canonicalPath, { bigint: true });
  } catch (error) {
    signal?.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    throw new RepositoryFileError(
      code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
      resolved.displayPath,
      code === "ENOENT" || code === "ENOTDIR" ? "does not exist" : "could not be inspected",
    );
  }
  signal?.throwIfAborted();
  return {
    canonicalPath: resolved.canonicalPath,
    displayPath: resolved.displayPath,
    details,
  };
}

export async function assertRepositoryPath(
  repositoryRoot: string,
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const inspected = await inspectRepositoryPath(repositoryRoot, repositoryPath, signal);
  if (!inspected.details.isFile() && !inspected.details.isDirectory())
    throw new RepositoryFileError(
      "unsupported_type",
      inspected.displayPath,
      "is not a regular file or repository directory",
    );
  return inspected.canonicalPath;
}

export async function assertRepositoryFile(
  repositoryRoot: string,
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const inspected = await inspectRepositoryPath(repositoryRoot, repositoryPath, signal);
  if (!inspected.details.isFile())
    throw new RepositoryFileError("not_file", inspected.displayPath, "is not a regular file");
  return inspected.canonicalPath;
}

export async function readRepositoryFile(
  repositoryRoot: string,
  repositoryPath: string,
  options: { maximumBytes?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const maximumBytes = options.maximumBytes ?? REPOSITORY_FILE_MAX_BYTES;
  validateMaximumBytes(maximumBytes);
  const inspected = await inspectRepositoryPath(repositoryRoot, repositoryPath, options.signal);
  if (!inspected.details.isFile())
    throw new RepositoryFileError("not_file", inspected.displayPath, "is not a regular file");
  if (inspected.details.size > BigInt(maximumBytes))
    throw new RepositoryFileError(
      "too_large",
      inspected.displayPath,
      `exceeds the ${maximumBytes}-byte bounded read limit`,
    );

  let handle: FileHandle | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = await open(inspected.canonicalPath, constants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new RepositoryFileError("not_file", inspected.displayPath, "is not a regular file");
    if (!sameIdentity(inspected.details, before))
      throw new RepositoryFileError("changed", inspected.displayPath, "changed during validation");
    if (before.size > BigInt(maximumBytes))
      throw new RepositoryFileError(
        "too_large",
        inspected.displayPath,
        `exceeds the ${maximumBytes}-byte bounded read limit`,
      );

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximumBytes) {
      options.signal?.throwIfAborted();
      const remaining = maximumBytes + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
    }
    options.signal?.throwIfAborted();
    if (total > maximumBytes)
      throw new RepositoryFileError(
        "too_large",
        inspected.displayPath,
        `exceeds the ${maximumBytes}-byte bounded read limit`,
      );
    const after = await handle.stat({ bigint: true });
    if (
      !sameIdentity(before, after) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new RepositoryFileError("changed", inspected.displayPath, "changed while being read");
    return Buffer.concat(chunks, total);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (isRepositoryFileError(error)) throw error;
    throw new RepositoryFileError("unreadable", inspected.displayPath, "could not be read safely");
  } finally {
    await closeIgnoringFailure(handle);
  }
}

export async function readRepositoryTextFile(
  repositoryRoot: string,
  repositoryPath: string,
  options: { maximumBytes?: number; signal?: AbortSignal } = {},
): Promise<string> {
  return (await readRepositoryFile(repositoryRoot, repositoryPath, options)).toString("utf8");
}

export async function assertRepositoryDirectory(
  repositoryRoot: string,
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const inspected = await inspectRepositoryPath(repositoryRoot, repositoryPath, signal);
  if (!inspected.details.isDirectory())
    throw new RepositoryFileError(
      "not_directory",
      inspected.displayPath,
      "is not a repository directory",
    );
  return inspected.canonicalPath;
}
