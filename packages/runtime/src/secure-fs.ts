import { spawn } from "node:child_process";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { syncDirectory } from "./json.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const WINDOWS_ACL_TIMEOUT_MS = 120_000;
const WINDOWS_ACL_OUTPUT_LIMIT_BYTES = 64 * 1024;
const WINDOWS_ACL_CACHE_LIMIT = 4_096;
const DARWIN_ACL_TIMEOUT_MS = 30_000;
const DARWIN_ACL_BATCH_MAX_ENTRIES = 256;
const DARWIN_ACL_BATCH_MAX_ARGUMENT_BYTES = 64 * 1024;
const DARWIN_ACL_CACHE_LIMIT = 4_096;
const supportsPosixModes = process.platform !== "win32";

interface PrivateEntry {
  kind: "directory" | "file";
  path: string;
}

const hardenedWindowsEntries = new Map<string, string>();
const hardenedDarwinEntries = new Map<string, string>();

/*
 * Paths are base64-encoded on stdin rather than interpolated into this script.
 * The first pass validates every target before the second pass mutates an ACL,
 * so a reparse point cannot redirect an earlier tree entry outside the owned
 * root after only part of the tree has been hardened.
 */
const WINDOWS_OWNER_ONLY_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $sid) { throw 'The current Windows identity has no SID' }
  $targets = [System.Collections.Generic.List[object]]::new()
  foreach ($rawLine in ([Console]::In.ReadToEnd() -split [char]10)) {
    $line = $rawLine.TrimEnd([char]13)
    if ($line.Length -eq 0) { continue }
    $separator = $line.IndexOf([char]9)
    if ($separator -ne 1) { throw 'Malformed Graphcraft ACL target record' }
    $kind = $line.Substring(0, 1)
    $path = [System.Text.Encoding]::UTF8.GetString(
      [System.Convert]::FromBase64String($line.Substring($separator + 1))
    )
    if ([String]::IsNullOrEmpty($path)) { throw 'Empty Graphcraft ACL target path' }

    $attributes = [System.IO.File]::GetAttributes($path)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Graphcraft private tree contains a reparse point'
    }
    $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
    if (($kind -eq 'D') -ne $isDirectory) {
      throw 'Graphcraft ACL target changed filesystem kind'
    }
    if ($kind -ne 'D' -and $kind -ne 'F') {
      throw 'Unsupported Graphcraft ACL target kind'
    }
    $targets.Add([pscustomobject]@{ Path = $path; IsDirectory = $isDirectory })
  }
  if ($targets.Count -eq 0) { throw 'No Graphcraft ACL targets were supplied' }

  foreach ($target in $targets) {
    $attributes = [System.IO.File]::GetAttributes($target.Path)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Graphcraft ACL target became a reparse point'
    }
    $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
    if ($isDirectory -ne $target.IsDirectory) {
      throw 'Graphcraft ACL target changed filesystem kind'
    }

    if ($isDirectory) {
      $item = [System.IO.DirectoryInfo]::new($target.Path)
      $security = [System.Security.AccessControl.DirectorySecurity]::new()
      $inheritance = ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit)
    } else {
      $item = [System.IO.FileInfo]::new($target.Path)
      $security = [System.Security.AccessControl.FileSecurity]::new()
      $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($sid)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
    $item.SetAccessControl($security)

    $item.Refresh()
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Graphcraft ACL target became a reparse point during enforcement'
    }
    $sections = ([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner)
    $verified = $item.GetAccessControl($sections)
    $owner = $verified.GetOwner([System.Security.Principal.SecurityIdentifier])
    $rules = @($verified.GetAccessRules(
      $true,
      $true,
      [System.Security.Principal.SecurityIdentifier]
    ))
    if (-not $verified.AreAccessRulesProtected -or $owner.Value -ne $sid.Value -or
        $rules.Count -ne 1 -or $rules[0].IsInherited -or
        $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
        $rules[0].InheritanceFlags -ne $inheritance -or
        $rules[0].PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or
        $rules[0].IdentityReference.Value -ne $sid.Value) {
      throw 'Graphcraft owner-only ACL verification failed'
    }
  }
  [Console]::Out.WriteLine("GRAPHCRAFT_ACL_OK:$($targets.Count)")
} catch {
  [Console]::Error.WriteLine("Graphcraft Windows ACL enforcement failed: $($_.Exception.Message)")
  exit 1
}
`;

const WINDOWS_OWNER_ONLY_ACL_COMMAND = Buffer.from(
  WINDOWS_OWNER_ONLY_ACL_SCRIPT,
  "utf16le",
).toString("base64");

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertPrivateRegularFile(
  path: string,
  status: Pick<BigIntStats, "nlink"> & {
    isSymbolicLink(): boolean;
    isFile(): boolean;
  },
): void {
  if (status.isSymbolicLink()) rejectSymbolicLink(path);
  if (!status.isFile()) throw new Error(`Private file path is not a regular file: ${path}`);
  if (status.nlink > 1n) rejectMultiplyLinkedFile(path);
}

function rejectSymbolicLink(path: string): never {
  throw new Error(`Refusing to harden symbolic link: ${path}`);
}

function rejectMultiplyLinkedFile(path: string): never {
  throw new Error(`Refusing to harden multiply linked file: ${path}`);
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || systemRoot.includes("\0") || !win32.isAbsolute(systemRoot))
    throw new Error(
      "Unable to locate the trusted Windows PowerShell runtime for private-state ACL enforcement",
    );
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function rememberWindowsEntry(path: string, fingerprint: string | undefined): void {
  if (fingerprint === undefined) return;
  hardenedWindowsEntries.delete(path);
  hardenedWindowsEntries.set(path, fingerprint);
  while (hardenedWindowsEntries.size > WINDOWS_ACL_CACHE_LIMIT) {
    const oldest = hardenedWindowsEntries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    hardenedWindowsEntries.delete(oldest);
  }
}

function rememberDarwinEntry(path: string, fingerprint: string | undefined): void {
  if (fingerprint === undefined) return;
  hardenedDarwinEntries.delete(path);
  hardenedDarwinEntries.set(path, fingerprint);
  while (hardenedDarwinEntries.size > DARWIN_ACL_CACHE_LIMIT) {
    const oldest = hardenedDarwinEntries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    hardenedDarwinEntries.delete(oldest);
  }
}

async function inspectPrivateEntry(path: string): Promise<{
  entry: PrivateEntry;
  fingerprint: string | undefined;
}> {
  const status = await lstat(path, { bigint: true });
  const fingerprint =
    status.ino === 0n
      ? undefined
      : `${status.dev}:${status.ino}:${status.birthtimeNs}:${status.ctimeNs}`;
  if (status.isSymbolicLink()) rejectSymbolicLink(path);
  if (status.isFile()) {
    if (status.nlink > 1n) rejectMultiplyLinkedFile(path);
    return { entry: { kind: "file", path }, fingerprint };
  }
  if (!status.isDirectory())
    throw new Error(`Private tree contains an unsupported filesystem entry: ${path}`);
  return { entry: { kind: "directory", path }, fingerprint };
}

async function collectPrivateTree(root: string): Promise<PrivateEntry[]> {
  const entries: PrivateEntry[] = [];
  const visit = async (path: string): Promise<void> => {
    const { entry } = await inspectPrivateEntry(path);
    entries.push(entry);
    if (entry.kind === "directory")
      for (const name of await readdir(path)) await visit(join(path, name));
  };
  await visit(root);
  return entries;
}

async function runWindowsAclBatch(entries: PrivateEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const payload = `${entries
    .map(
      ({ kind, path }) =>
        `${kind === "directory" ? "D" : "F"}\t${Buffer.from(path, "utf8").toString("base64")}`,
    )
    .join("\n")}\n`;
  const expectedOutput = `GRAPHCRAFT_ACL_OK:${entries.length}`;
  await new Promise<void>((resolveBatch, rejectBatch) => {
    const child = spawn(
      windowsPowerShellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        WINDOWS_OWNER_ONLY_ACL_COMMAND,
      ],
      {
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const reject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      rejectBatch(error);
    };
    const capture = (target: Buffer[], stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (
        stdoutBytes > WINDOWS_ACL_OUTPUT_LIMIT_BYTES ||
        stderrBytes > WINDOWS_ACL_OUTPUT_LIMIT_BYTES
      ) {
        reject(new Error("Windows ACL helper exceeded its bounded output limit"));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, "stderr", chunk));
    child.stdin.on("error", () => undefined);
    child.once("error", (error) =>
      reject(
        new Error("Unable to start trusted Windows ACL enforcement", {
          cause: error,
        }),
      ),
    );
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0 || output !== expectedOutput) {
        rejectBatch(
          new Error(
            `Unable to enforce owner-only Windows permissions on Graphcraft state${
              errorOutput ? `: ${errorOutput}` : ""
            }`,
          ),
        );
        return;
      }
      resolveBatch();
    });
    const timer = setTimeout(
      () => reject(new Error("Windows ACL enforcement timed out")),
      WINDOWS_ACL_TIMEOUT_MS,
    );
    timer.unref();
    child.stdin.end(payload, "utf8");
  });
}

async function hardenWindowsEntries(entries: PrivateEntry[], force = false): Promise<void> {
  if (supportsPosixModes || entries.length === 0) return;
  const pending: PrivateEntry[] = [];
  for (const entry of entries) {
    const inspected = await inspectPrivateEntry(entry.path);
    if (inspected.entry.kind !== entry.kind)
      throw new Error(`Private ACL target changed filesystem kind: ${entry.path}`);
    if (
      force ||
      inspected.fingerprint === undefined ||
      hardenedWindowsEntries.get(entry.path) !== inspected.fingerprint
    )
      pending.push(entry);
  }
  if (pending.length === 0) return;
  await runWindowsAclBatch(pending);
  for (const entry of pending) {
    const inspected = await inspectPrivateEntry(entry.path);
    if (inspected.entry.kind !== entry.kind)
      throw new Error(`Private ACL target changed filesystem kind: ${entry.path}`);
    rememberWindowsEntry(entry.path, inspected.fingerprint);
  }
}

async function runDarwinAclBatch(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await new Promise<void>((resolveAcl, rejectAcl) => {
    const child = spawn("/bin/chmod", ["-N", ...paths], {
      shell: false,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectAcl(error);
      else resolveAcl();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Timed out removing macOS ACLs from Graphcraft private paths"));
    }, DARWIN_ACL_TIMEOUT_MS);
    timer.unref();
    child.once("error", (error) =>
      finish(
        new Error("Unable to remove macOS ACLs from Graphcraft private paths", { cause: error }),
      ),
    );
    child.once("close", (code) => {
      if (code !== 0)
        finish(new Error("Unable to remove macOS ACLs from Graphcraft private paths"));
      else finish();
    });
  });
}

async function removeDarwinAcls(entries: PrivateEntry[]): Promise<void> {
  if (process.platform !== "darwin") return;
  let batch: string[] = [];
  let argumentBytes = 0;
  for (const { path } of entries) {
    const pathBytes = Buffer.byteLength(path) + 1;
    if (pathBytes > DARWIN_ACL_BATCH_MAX_ARGUMENT_BYTES)
      throw new Error(`macOS ACL target path exceeds its bounded argument limit: ${path}`);
    if (
      batch.length >= DARWIN_ACL_BATCH_MAX_ENTRIES ||
      argumentBytes + pathBytes > DARWIN_ACL_BATCH_MAX_ARGUMENT_BYTES
    ) {
      await runDarwinAclBatch(batch);
      batch = [];
      argumentBytes = 0;
    }
    batch.push(path);
    argumentBytes += pathBytes;
  }
  await runDarwinAclBatch(batch);
}

async function hardenPosixEntries(entries: PrivateEntry[], force = false): Promise<void> {
  let pending = entries;
  if (process.platform === "darwin") {
    pending = [];
    for (const entry of entries) {
      const inspected = await inspectPrivateEntry(entry.path);
      if (inspected.entry.kind !== entry.kind)
        throw new Error(`Private ACL target changed filesystem kind: ${entry.path}`);
      if (
        force ||
        inspected.fingerprint === undefined ||
        hardenedDarwinEntries.get(entry.path) !== inspected.fingerprint
      )
        pending.push(entry);
    }
  }
  await removeDarwinAcls(pending);
  for (const entry of pending)
    await chmod(
      entry.path,
      entry.kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE,
    );
  if (process.platform === "darwin")
    for (const entry of pending) {
      const inspected = await inspectPrivateEntry(entry.path);
      if (inspected.entry.kind !== entry.kind)
        throw new Error(`Private ACL target changed filesystem kind: ${entry.path}`);
      rememberDarwinEntry(entry.path, inspected.fingerprint);
    }
}

function privatePathSegments(relativePath: string): string[] {
  if (isAbsolute(relativePath))
    throw new Error(`Private path must be relative to its owned root: ${relativePath}`);
  const segments = relativePath
    .split(process.platform === "win32" ? /[\\/]/ : /\//)
    .filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === ".."))
    throw new Error(`Private path escapes or aliases its owned root: ${relativePath}`);
  return segments;
}

/**
 * Validate every existing component of a relative path beneath an explicitly
 * trusted Graphcraft-owned directory. Ancestors above ownedRoot are outside
 * this helper's ownership boundary and are not inspected or modified.
 */
export async function validatePrivatePath(
  ownedRoot: string,
  relativePath: string,
): Promise<string> {
  const root = resolve(ownedRoot);
  const segments = privatePathSegments(relativePath);
  const absolute = resolve(root, ...segments);
  const requested = resolve(root, relativePath);
  if (absolute !== requested)
    throw new Error(`Private path validation changed the requested path: ${relativePath}`);
  const relation = relative(root, absolute);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation))
    throw new Error(`Private path escapes its owned root: ${relativePath}`);

  const rootStatus = await lstat(root);
  if (rootStatus.isSymbolicLink()) rejectSymbolicLink(root);
  if (!rootStatus.isDirectory()) throw new Error(`Private root is not a directory: ${root}`);

  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let status;
    try {
      status = await lstat(current);
    } catch (error) {
      if (isMissing(error)) return absolute;
      throw error;
    }
    if (status.isSymbolicLink()) rejectSymbolicLink(current);
    if (status.isFile() && status.nlink > 1) rejectMultiplyLinkedFile(current);
    const final = index === segments.length - 1;
    if (!final && !status.isDirectory())
      throw new Error(`Private path component is not a directory: ${current}`);
    if (final && !status.isDirectory() && !status.isFile())
      throw new Error(`Private path contains an unsupported filesystem entry: ${current}`);
  }
  return absolute;
}

/**
 * Read one private regular file through the descriptor that was validated.
 * The explicit cap is checked before allocation and the descriptor identity is
 * rechecked after the read so path replacement cannot silently change bytes.
 */
export async function readPrivateFileBounded(
  path: string,
  maximumBytes: number,
  ownedRoot?: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new Error("Private file read limit must be a non-negative safe integer");

  const absolute = resolve(path);
  if (ownedRoot !== undefined)
    await validatePrivatePath(ownedRoot, relative(resolve(ownedRoot), absolute));
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  for (let replacementAttempt = 0; ; replacementAttempt += 1) {
    try {
      const observed = await lstat(absolute, { bigint: true });
      assertPrivateRegularFile(absolute, observed);
      if (observed.size > BigInt(maximumBytes))
        throw new Error(`Private file exceeds its ${maximumBytes}-byte bounded read limit`);

      const handle = await open(absolute, fsConstants.O_RDONLY | noFollow);
      try {
        const before = await handle.stat({ bigint: true });
        assertPrivateRegularFile(absolute, before);
        if (!sameFileSnapshot(observed, before))
          throw new Error("Private file changed before its bounded read");
        if (before.size > BigInt(maximumBytes))
          throw new Error(`Private file exceeds its ${maximumBytes}-byte bounded read limit`);

        const expectedBytes = Number(before.size);
        const bytes = Buffer.alloc(expectedBytes);
        let offset = 0;
        while (offset < expectedBytes) {
          const { bytesRead } = await handle.read(bytes, offset, expectedBytes - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        if (offset !== expectedBytes || !sameFileSnapshot(before, after))
          throw new Error("Private file changed during its bounded read");
        return bytes;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (
        replacementAttempt >= 3 ||
        !(error instanceof Error) ||
        error.message !== "Private file changed before its bounded read"
      )
        throw error;
      await new Promise<void>((resolveRetry) => setImmediate(resolveRetry));
    }
  }
}

/** Create a Graphcraft-owned directory and enforce owner-only access. */
export async function ensurePrivateDirectory(path: string, ownedRoot = path): Promise<void> {
  const absolute = resolve(path);
  const root = resolve(ownedRoot);
  const relativePath = relative(root, absolute);
  if (absolute !== root) await validatePrivatePath(root, relativePath);

  const missingDirectories: string[] = [];
  let candidate = absolute;
  while (true) {
    try {
      await lstat(candidate);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      missingDirectories.push(candidate);
      const parent = dirname(candidate);
      if (parent === candidate)
        throw new Error(`Private directory has no existing ancestor: ${absolute}`);
      candidate = parent;
    }
  }
  await mkdir(absolute, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (absolute !== root) await validatePrivatePath(root, relativePath);
  const status = await lstat(absolute);
  if (status.isSymbolicLink()) rejectSymbolicLink(path);
  if (!status.isDirectory()) throw new Error(`Private directory path is not a directory: ${path}`);

  const directories = [root];
  let current = root;
  for (const segment of privatePathSegments(relativePath)) {
    current = join(current, segment);
    directories.push(current);
  }
  if (supportsPosixModes) {
    await hardenPosixEntries(
      directories.map((directory) => ({ kind: "directory", path: directory })),
    );
  } else {
    await hardenWindowsEntries(
      directories.map((directory) => ({ kind: "directory", path: directory })),
    );
  }

  for (const directory of missingDirectories.reverse()) {
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
  }
}

/** Harden a file when it exists. Missing files are intentionally ignored. */
export async function hardenPrivateFile(path: string, ownedRoot?: string): Promise<void> {
  const absolute = resolve(path);
  if (ownedRoot !== undefined)
    await validatePrivatePath(ownedRoot, relative(resolve(ownedRoot), absolute));
  let status;
  try {
    status = await lstat(absolute);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (status.isSymbolicLink()) rejectSymbolicLink(path);
  if (!status.isFile()) throw new Error(`Private file path is not a regular file: ${path}`);
  if (status.nlink > 1) rejectMultiplyLinkedFile(path);
  try {
    if (supportsPosixModes) await hardenPosixEntries([{ kind: "file", path: absolute }]);
    else await hardenWindowsEntries([{ kind: "file", path: absolute }]);
  } catch (error) {
    try {
      await lstat(absolute);
    } catch (inspectionError) {
      if (isMissing(inspectionError)) return;
      throw inspectionError;
    }
    throw error;
  }
}

/** Harden a Graphcraft-owned tree without following symbolic links. */
export async function hardenPrivateTree(root: string, ownedRoot = root): Promise<void> {
  const absoluteRoot = resolve(root);
  await validatePrivatePath(ownedRoot, relative(resolve(ownedRoot), absoluteRoot));
  const entries = await collectPrivateTree(absoluteRoot);
  if (!supportsPosixModes) {
    await hardenWindowsEntries(entries, true);
    return;
  }
  await hardenPosixEntries(entries, true);
}
