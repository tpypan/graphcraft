import { spawn } from "node:child_process";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { syncDirectory, writeJsonAtomic, type AtomicFilePublication } from "./json.ts";
import {
  encodeWindowsAclRequest,
  parseWindowsAclResponse,
  PersistentWindowsAclHelper,
  planWindowsAclRequest,
  runWindowsAclVerificationAttempts,
  WINDOWS_ACL_REQUEST_LIMITS,
  WindowsAclRequestIds,
} from "./windows-acl-helper.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const WINDOWS_ACL_TIMEOUT_MS = 120_000;
const WINDOWS_ACL_OUTPUT_LIMIT_BYTES = 64 * 1024;
const WINDOWS_ACL_CACHE_LIMIT = 4_096;
const WINDOWS_ACL_VERIFICATION_ATTEMPTS = 3;
const DARWIN_ACL_TIMEOUT_MS = 30_000;
const DARWIN_ACL_BATCH_MAX_ENTRIES = 256;
const DARWIN_ACL_BATCH_MAX_ARGUMENT_BYTES = 64 * 1024;
const DARWIN_ACL_CACHE_LIMIT = 4_096;
const supportsPosixModes = process.platform !== "win32";

interface PrivateEntry {
  kind: "directory" | "file";
  path: string;
}

const hardenedWindowsIdentities = new Map<string, string>();
const hardenedDarwinEntries = new Map<string, string>();
const privatePathMutationTails = new Map<string, Promise<void>>();
let windowsAclWorkTail = Promise.resolve();
const windowsAclRequestIds = new WindowsAclRequestIds();

/*
 * Requests and paths are base64-encoded on stdin rather than interpolated into
 * this script. One trusted helper serves a serialized sequence of transactions.
 * Every bounded chunk is validated and retained before COMMIT can mutate an
 * ACL, preserving whole-request preflight without one giant request line.
 */
const WINDOWS_OWNER_ONLY_ACL_SCRIPT = String.raw`
try {
  $ErrorActionPreference = 'Stop'
  Set-StrictMode -Version 3.0
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $sid) { throw 'The current Windows identity has no SID' }
  $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
  $activeRequestId = $null
  $expectedTargetCount = 0
  $expectedChunkCount = 0
  $nextChunkIndex = 0
  $targetPaths = $null
  $targetDirectoryFlags = $null

  while ($null -ne ($requestLine = [Console]::In.ReadLine())) {
    $responseRequestId = if ($null -eq $activeRequestId) { '0' } else { $activeRequestId }
    try {
      if ([System.Text.Encoding]::UTF8.GetByteCount($requestLine) + 1 -gt __GRAPHCRAFT_ACL_MAX_LINE_BYTES__) {
        throw 'Graphcraft ACL request line exceeds its encoded byte limit'
      }
      $requestParts = @($requestLine -split [char]9)
      if ($null -eq $activeRequestId) {
        if ($requestParts.Count -ne 4 -or $requestParts[0] -cne 'GRAPHCRAFT_ACL_BEGIN') {
          throw 'Malformed Graphcraft ACL BEGIN frame'
        }
        if ($requestParts[1] -notmatch '^[1-9][0-9]*$') {
          throw 'Malformed Graphcraft ACL request identifier'
        }
        $responseRequestId = $requestParts[1]
        $parsedTargetCount = 0
        $parsedChunkCount = 0
        if (
          $requestParts[2] -notmatch '^[1-9][0-9]*$' -or
          -not [int]::TryParse($requestParts[2], [ref]$parsedTargetCount) -or
          $parsedTargetCount -gt __GRAPHCRAFT_ACL_MAX_TARGETS__
        ) { throw 'Malformed Graphcraft ACL target count' }
        if (
          $requestParts[3] -notmatch '^[1-9][0-9]*$' -or
          -not [int]::TryParse($requestParts[3], [ref]$parsedChunkCount) -or
          $parsedChunkCount -gt $parsedTargetCount
        ) { throw 'Malformed Graphcraft ACL chunk count' }
        $activeRequestId = $requestParts[1]
        $expectedTargetCount = $parsedTargetCount
        $expectedChunkCount = $parsedChunkCount
        $nextChunkIndex = 0
        $targetPaths = [System.Collections.Generic.List[string]]::new($expectedTargetCount)
        $targetDirectoryFlags = [System.Collections.Generic.List[bool]]::new($expectedTargetCount)
        continue
      }

      $responseRequestId = $activeRequestId
      if ($requestParts.Count -gt 0 -and $requestParts[0] -ceq 'GRAPHCRAFT_ACL_CHUNK') {
        if ($requestParts.Count -ne 5 -or $requestParts[1] -cne $activeRequestId) {
          throw 'Malformed Graphcraft ACL CHUNK frame'
        }
        $chunkIndex = 0
        $chunkTargetCount = 0
        if (
          $requestParts[2] -notmatch '^(?:0|[1-9][0-9]*)$' -or
          -not [int]::TryParse($requestParts[2], [ref]$chunkIndex) -or
          $chunkIndex -ne $nextChunkIndex -or
          $chunkIndex -ge $expectedChunkCount
        ) { throw 'Malformed Graphcraft ACL chunk index' }
        if (
          $requestParts[3] -notmatch '^[1-9][0-9]*$' -or
          -not [int]::TryParse($requestParts[3], [ref]$chunkTargetCount) -or
          $chunkTargetCount -gt ($expectedTargetCount - $targetPaths.Count)
        ) { throw 'Malformed Graphcraft ACL chunk target count' }
        $chunkBytes = [System.Convert]::FromBase64String($requestParts[4])
        if ([System.Convert]::ToBase64String($chunkBytes) -cne $requestParts[4]) {
          throw 'Non-canonical Graphcraft ACL chunk payload'
        }
        $targetLines = @($strictUtf8.GetString($chunkBytes) -split [char]10)
        if ($targetLines.Count -ne $chunkTargetCount) {
          throw 'Graphcraft ACL chunk count does not match its payload'
        }
        $chunkPaths = [System.Collections.Generic.List[string]]::new($chunkTargetCount)
        $chunkDirectoryFlags = [System.Collections.Generic.List[bool]]::new($chunkTargetCount)
        foreach ($targetLine in $targetLines) {
          $targetParts = @($targetLine -split [char]9)
          if ($targetParts.Count -ne 2) { throw 'Malformed Graphcraft ACL target record' }
          $kind = $targetParts[0]
          if ($kind -cne 'D' -and $kind -cne 'F') {
            throw 'Unsupported Graphcraft ACL target kind'
          }
          $pathBytes = [System.Convert]::FromBase64String($targetParts[1])
          if ([System.Convert]::ToBase64String($pathBytes) -cne $targetParts[1]) {
            throw 'Non-canonical Graphcraft ACL target path'
          }
          $path = $strictUtf8.GetString($pathBytes)
          if ([String]::IsNullOrEmpty($path) -or $path.IndexOf([char]0) -ge 0) {
            throw 'Empty or invalid Graphcraft ACL target path'
          }
          $attributes = [System.IO.File]::GetAttributes($path)
          if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Graphcraft private tree contains a reparse point'
          }
          $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
          if (($kind -ceq 'D') -ne $isDirectory) {
            throw 'Graphcraft ACL target changed filesystem kind'
          }
          $chunkPaths.Add($path)
          $chunkDirectoryFlags.Add($isDirectory)
        }
        for ($chunkOffset = 0; $chunkOffset -lt $chunkPaths.Count; $chunkOffset += 1) {
          $targetPaths.Add($chunkPaths[$chunkOffset])
          $targetDirectoryFlags.Add($chunkDirectoryFlags[$chunkOffset])
        }
        $nextChunkIndex += 1
        continue
      }

      if ($requestParts.Count -ne 4 -or $requestParts[0] -cne 'GRAPHCRAFT_ACL_COMMIT' -or $requestParts[1] -cne $activeRequestId) {
        throw 'Malformed Graphcraft ACL COMMIT frame'
      }
      $commitChunkCount = 0
      $commitTargetCount = 0
      if (
        $requestParts[2] -notmatch '^[1-9][0-9]*$' -or
        -not [int]::TryParse($requestParts[2], [ref]$commitChunkCount) -or
        $commitChunkCount -ne $expectedChunkCount -or
        $nextChunkIndex -ne $expectedChunkCount
      ) { throw 'Graphcraft ACL COMMIT chunk count does not match BEGIN' }
      if (
        $requestParts[3] -notmatch '^[1-9][0-9]*$' -or
        -not [int]::TryParse($requestParts[3], [ref]$commitTargetCount) -or
        $commitTargetCount -ne $expectedTargetCount -or
        $targetPaths.Count -ne $expectedTargetCount
      ) { throw 'Graphcraft ACL COMMIT target count does not match BEGIN' }

      for ($targetIndex = 0; $targetIndex -lt $targetPaths.Count; $targetIndex += 1) {
        $path = $targetPaths[$targetIndex]
        $expectedDirectory = $targetDirectoryFlags[$targetIndex]
        $attributes = [System.IO.File]::GetAttributes($path)
        if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
          throw 'Graphcraft ACL target became a reparse point'
        }
        $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
        if ($isDirectory -ne $expectedDirectory) {
          throw 'Graphcraft ACL target changed filesystem kind'
        }

        if ($isDirectory) {
          $item = [System.IO.DirectoryInfo]::new($path)
          $security = [System.Security.AccessControl.DirectorySecurity]::new()
          $inheritance = ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit)
        } else {
          $item = [System.IO.FileInfo]::new($path)
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
        $failures = [System.Collections.Generic.List[string]]::new()
        if (-not $verified.AreAccessRulesProtected) { [void]$failures.Add('protection') }
        if ($owner.Value -ne $sid.Value) { [void]$failures.Add('owner') }
        if ($rules.Count -ne 1) {
          [void]$failures.Add('rule_count')
        } else {
          if ($rules[0].IsInherited) { [void]$failures.Add('inherited') }
          if ($rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { [void]$failures.Add('type') }
          if ($rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { [void]$failures.Add('rights') }
          if ($rules[0].InheritanceFlags -ne $inheritance) { [void]$failures.Add('inheritance') }
          if ($rules[0].PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { [void]$failures.Add('propagation') }
          if ($rules[0].IdentityReference.Value -ne $sid.Value) { [void]$failures.Add('identity') }
        }
        if ($failures.Count -gt 0) {
          $kind = if ($isDirectory) { 'D' } else { 'F' }
          $ownerClass = if ($owner.Value -eq $sid.Value) { 'current' } else { 'other' }
          $protection = if ($verified.AreAccessRulesProtected) { 'protected' } else { 'unprotected' }
          $aceDiagnostics = [System.Collections.Generic.List[string]]::new()
          foreach ($rule in $rules) {
            $identityClass = if ($rule.IdentityReference.Value -eq $sid.Value) { 'current' } else { 'other' }
            $inherited = $rule.IsInherited.ToString().ToLowerInvariant()
            [void]$aceDiagnostics.Add(
              "identity=$identityClass,type=$([int]($rule.AccessControlType)),rights=$([int]($rule.FileSystemRights)),inherited=$inherited,inheritance=$([int]($rule.InheritanceFlags)),propagation=$([int]($rule.PropagationFlags))"
            )
          }
          $displayIndex = $targetIndex + 1
          throw "Graphcraft owner-only ACL verification failed for target $displayIndex ($kind): $($failures -join ','); protection=$protection;owner=$ownerClass;aces=[$($aceDiagnostics -join '|')]"
        }
      }
      $completedRequestId = $activeRequestId
      $completedTargetCount = $targetPaths.Count
      $activeRequestId = $null
      $expectedTargetCount = 0
      $expectedChunkCount = 0
      $nextChunkIndex = 0
      $targetPaths = $null
      $targetDirectoryFlags = $null
      [Console]::Out.WriteLine("GRAPHCRAFT_ACL_OK$([char]9)$completedRequestId$([char]9)$completedTargetCount")
      [Console]::Out.Flush()
    } catch {
      $errorBytes = [System.Text.Encoding]::UTF8.GetBytes($_.Exception.Message)
      $errorPayload = [System.Convert]::ToBase64String($errorBytes)
      [Console]::Out.WriteLine("GRAPHCRAFT_ACL_ERROR$([char]9)$responseRequestId$([char]9)$errorPayload")
      [Console]::Out.Flush()
      exit 1
    }
  }
} catch {
  [Console]::Error.WriteLine("Graphcraft Windows ACL enforcement failed: $($_.Exception.Message)")
  exit 1
}
`
  .replace("__GRAPHCRAFT_ACL_MAX_LINE_BYTES__", `${WINDOWS_ACL_REQUEST_LIMITS.maximumLineBytes}`)
  .replace("__GRAPHCRAFT_ACL_MAX_TARGETS__", `${WINDOWS_ACL_REQUEST_LIMITS.maximumTargets}`);

const WINDOWS_OWNER_ONLY_ACL_COMMAND = Buffer.from(
  WINDOWS_OWNER_ONLY_ACL_SCRIPT,
  "utf16le",
).toString("base64");

const windowsAclHelper = new PersistentWindowsAclHelper({
  requestTimeoutMs: WINDOWS_ACL_TIMEOUT_MS,
  outputLimitBytes: WINDOWS_ACL_OUTPUT_LIMIT_BYTES,
  requestLineLimitBytes: WINDOWS_ACL_REQUEST_LIMITS.maximumLineBytes,
  maximumRequestLines: WINDOWS_ACL_REQUEST_LIMITS.maximumTargets + 2,
  spawnProcess: () =>
    spawn(
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
    ),
});

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

function sameFileContentSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function assertPrivateRegularFile(
  path: string,
  status: Pick<BigIntStats, "nlink"> & {
    isSymbolicLink(): boolean;
    isFile(): boolean;
  },
  allowMultipleLinks = false,
): void {
  if (status.isSymbolicLink()) rejectSymbolicLink(path);
  if (!status.isFile()) throw new Error(`Private file path is not a regular file: ${path}`);
  if (!allowMultipleLinks && status.nlink > 1n) rejectMultiplyLinkedFile(path);
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

function rememberWindowsIdentity(
  fingerprint: string | undefined,
  metadataFingerprint: string | undefined,
): void {
  if (fingerprint === undefined || metadataFingerprint === undefined) return;
  hardenedWindowsIdentities.delete(fingerprint);
  hardenedWindowsIdentities.set(fingerprint, metadataFingerprint);
  while (hardenedWindowsIdentities.size > WINDOWS_ACL_CACHE_LIMIT) {
    const oldest = hardenedWindowsIdentities.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    hardenedWindowsIdentities.delete(oldest);
  }
}

/**
 * Return a stable filesystem-object identity for the Windows ACL cache.
 *
 * ACLs follow an object across content writes and renames, while ctime changes
 * for both ordinary writes and ACL updates on Windows. Device, inode, and
 * birth time still change when a path is replaced. Unknown inode identities
 * deliberately remain uncached so enforcement fails closed.
 *
 * @internal
 */
export function privateEntryIdentityFingerprint(
  status: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">,
): string | undefined {
  return status.ino === 0n ? undefined : `${status.dev}:${status.ino}:${status.birthtimeNs}`;
}

/**
 * Return the descriptor-to-path identity used after atomic publication.
 *
 * A device plus a nonzero inode identifies the published object. Birth time is
 * deliberately excluded because Windows may report a different creation time
 * after a valid atomic rename or replacement. Unknown inode identities remain
 * untrusted so callers can fall back to explicit owner-only hardening.
 *
 * @internal
 */
export function privatePublicationIdentityFingerprint(
  status: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">,
): string | undefined {
  return status.ino === 0n ? undefined : `${status.dev}:${status.ino}`;
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
  identityFingerprint: string | undefined;
  publicationIdentityFingerprint: string | undefined;
  metadataFingerprint: string | undefined;
}> {
  const status = await lstat(path, { bigint: true });
  const identityFingerprint = privateEntryIdentityFingerprint(status);
  const publicationIdentityFingerprint = privatePublicationIdentityFingerprint(status);
  const metadataFingerprint =
    identityFingerprint === undefined ? undefined : `${identityFingerprint}:${status.ctimeNs}`;
  if (status.isSymbolicLink()) rejectSymbolicLink(path);
  if (status.isFile()) {
    if (status.nlink > 1n) rejectMultiplyLinkedFile(path);
    return {
      entry: { kind: "file", path },
      identityFingerprint,
      publicationIdentityFingerprint,
      metadataFingerprint,
    };
  }
  if (!status.isDirectory())
    throw new Error(`Private tree contains an unsupported filesystem entry: ${path}`);
  return {
    entry: { kind: "directory", path },
    identityFingerprint,
    publicationIdentityFingerprint,
    metadataFingerprint,
  };
}

async function collectPrivateTree(
  root: string,
  maximumEntries = Number.POSITIVE_INFINITY,
): Promise<PrivateEntry[]> {
  const entries: PrivateEntry[] = [];
  const visit = async (path: string): Promise<void> => {
    if (entries.length >= maximumEntries)
      throw new Error(`Private tree exceeds its ${maximumEntries}-target Windows ACL limit`);
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
  await runWindowsAclVerificationAttempts(async () => {
    // Plan every line before BEGIN reaches PowerShell. Encoding stays lazy and
    // bounded, while the helper still preflights all chunks before COMMIT.
    const requestId = windowsAclRequestIds.next();
    const plan = planWindowsAclRequest(requestId, entries);
    await windowsAclHelper.request(
      {
        lines: encodeWindowsAclRequest(plan, entries),
        lineCount: plan.lineCount,
      },
      (line) => parseWindowsAclResponse(line, requestId, entries.length),
    );
  }, WINDOWS_ACL_VERIFICATION_ATTEMPTS);
}

async function serializeWindowsAclWork<T>(work: () => Promise<T>): Promise<T> {
  if (supportsPosixModes) return await work();
  const previous = windowsAclWorkTail;
  let release!: () => void;
  windowsAclWorkTail = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

/** Serialize one private path-entry mutation without coupling it to ACL work. @internal */
export async function serializePrivatePathMutation<T>(
  path: string,
  work: () => Promise<T>,
): Promise<T> {
  const absolute = resolve(path);
  const previous = privatePathMutationTails.get(absolute);
  let release!: () => void;
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  privatePathMutationTails.set(absolute, turn);
  if (previous) await previous;
  try {
    return await work();
  } finally {
    release();
    // Retain only paths with queued or active mutations. Each gate resolves
    // independently of work success, so a failed operation cannot poison a
    // later mutation for the same target.
    if (privatePathMutationTails.get(absolute) === turn) privatePathMutationTails.delete(absolute);
  }
}

async function hardenWindowsEntriesLocked(entries: PrivateEntry[], force = false): Promise<void> {
  if (entries.length === 0) return;
  const pending: Array<{
    entry: PrivateEntry;
    identityFingerprint: string | undefined;
  }> = [];
  for (const entry of entries) {
    const inspected = await inspectPrivateEntry(entry.path);
    if (inspected.entry.kind !== entry.kind)
      throw new Error(`Private ACL target changed filesystem kind: ${entry.path}`);
    if (
      force ||
      inspected.identityFingerprint === undefined ||
      hardenedWindowsIdentities.get(inspected.identityFingerprint) !== inspected.metadataFingerprint
    )
      pending.push({ entry, identityFingerprint: inspected.identityFingerprint });
    else rememberWindowsIdentity(inspected.identityFingerprint, inspected.metadataFingerprint);
  }
  if (pending.length === 0) return;
  await runWindowsAclBatch(pending.map(({ entry }) => entry));
  for (const { entry, identityFingerprint } of pending) {
    const inspected = await inspectPrivateEntry(entry.path);
    if (inspected.entry.kind !== entry.kind)
      throw new Error(`Private ACL target changed filesystem kind: ${entry.path}`);
    if (identityFingerprint !== undefined && inspected.identityFingerprint !== identityFingerprint)
      throw new Error(`Private ACL target changed filesystem identity: ${entry.path}`);
    if (inspected.identityFingerprint === identityFingerprint)
      rememberWindowsIdentity(identityFingerprint, inspected.metadataFingerprint);
  }
}

async function hardenWindowsEntries(entries: PrivateEntry[], force = false): Promise<void> {
  if (supportsPosixModes || entries.length === 0) return;
  await serializeWindowsAclWork(async () => hardenWindowsEntriesLocked(entries, force));
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
        inspected.metadataFingerprint === undefined ||
        hardenedDarwinEntries.get(entry.path) !== inspected.metadataFingerprint
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
      rememberDarwinEntry(entry.path, inspected.metadataFingerprint);
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

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  options: { allowMultipleLinks: boolean; ownedRoot?: string },
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new Error("Private file read limit must be a non-negative safe integer");

  const absolute = resolve(path);
  if (options.ownedRoot !== undefined)
    await validatePrivatePath(options.ownedRoot, relative(resolve(options.ownedRoot), absolute));
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  for (let replacementAttempt = 0; ; replacementAttempt += 1) {
    try {
      const observed = await lstat(absolute, { bigint: true });
      assertPrivateRegularFile(absolute, observed, options.allowMultipleLinks);
      if (observed.size > BigInt(maximumBytes))
        throw new Error(`Private file exceeds its ${maximumBytes}-byte bounded read limit`);

      const handle = await open(absolute, fsConstants.O_RDONLY | noFollow);
      try {
        const before = await handle.stat({ bigint: true });
        assertPrivateRegularFile(absolute, before, options.allowMultipleLinks);
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
        // Another reader may enforce owner-only mode or remove a macOS ACL on
        // this same descriptor while bytes are being read. Those metadata-only
        // operations change ctime, but not the coherent content snapshot. Keep
        // inode, size, and mtime checks so writes still fail closed while
        // allowing concurrent hardening of an atomically published projection.
        if (offset !== expectedBytes || !sameFileContentSnapshot(before, after))
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

/**
 * Read one external regular file through the descriptor that was validated.
 * Package managers may legitimately hard-link immutable package files, so this
 * boundary permits multiple links while retaining no-follow, size, identity,
 * and coherent-content checks. It does not establish private-state ownership.
 */
export async function readRegularFileBounded(path: string, maximumBytes: number): Promise<Buffer> {
  return await readBoundedRegularFile(path, maximumBytes, { allowMultipleLinks: true });
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
  return await readBoundedRegularFile(path, maximumBytes, {
    allowMultipleLinks: false,
    ...(ownedRoot === undefined ? {} : { ownedRoot }),
  });
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

export interface PrivateDirectoryMutationCheckpoint {
  readonly path: string;
  readonly identityFingerprint: string | undefined;
  readonly metadataFingerprint: string | undefined;
}

const activePrivateDirectoryMutations = new WeakSet<PrivateDirectoryMutationCheckpoint>();

/** Begin one narrow child create, rename, or unlink beneath a private directory. @internal */
export async function preparePrivateDirectoryMutation(
  path: string,
  ownedRoot = path,
): Promise<PrivateDirectoryMutationCheckpoint> {
  const absolute = resolve(path);
  await ensurePrivateDirectory(absolute, ownedRoot);
  const inspected = await inspectPrivateEntry(absolute);
  if (inspected.entry.kind !== "directory")
    throw new Error(`Private mutation parent is not a directory: ${absolute}`);
  const checkpoint = {
    path: absolute,
    identityFingerprint: inspected.identityFingerprint,
    metadataFingerprint: inspected.metadataFingerprint,
  };
  activePrivateDirectoryMutations.add(checkpoint);
  return checkpoint;
}

/** Finish a directory-entry mutation begun by preparePrivateDirectoryMutation. @internal */
export async function finalizePrivateDirectoryMutation(
  checkpoint: PrivateDirectoryMutationCheckpoint,
  ownedRoot = checkpoint.path,
): Promise<void> {
  if (!activePrivateDirectoryMutations.delete(checkpoint)) {
    await ensurePrivateDirectory(checkpoint.path, ownedRoot);
    return;
  }
  if (supportsPosixModes) {
    if (process.platform !== "darwin") return;
    await validatePrivatePath(ownedRoot, relative(resolve(ownedRoot), resolve(checkpoint.path)));
    const inspected = await inspectPrivateEntry(checkpoint.path);
    if (
      inspected.entry.kind === "directory" &&
      checkpoint.identityFingerprint !== undefined &&
      inspected.identityFingerprint === checkpoint.identityFingerprint &&
      hardenedDarwinEntries.get(checkpoint.path) === checkpoint.metadataFingerprint
    ) {
      rememberDarwinEntry(checkpoint.path, inspected.metadataFingerprint);
      return;
    }
    if (inspected.entry.kind !== "directory")
      throw new Error(`Private mutation parent is not a directory: ${checkpoint.path}`);
    await hardenPosixEntries([inspected.entry]);
    return;
  }
  await serializeWindowsAclWork(async () => {
    await validatePrivatePath(ownedRoot, relative(resolve(ownedRoot), resolve(checkpoint.path)));
    const inspected = await inspectPrivateEntry(checkpoint.path);
    if (
      inspected.entry.kind === "directory" &&
      checkpoint.identityFingerprint !== undefined &&
      inspected.identityFingerprint === checkpoint.identityFingerprint &&
      hardenedWindowsIdentities.get(checkpoint.identityFingerprint) ===
        checkpoint.metadataFingerprint
    ) {
      rememberWindowsIdentity(inspected.identityFingerprint, inspected.metadataFingerprint);
      return;
    }
    if (inspected.entry.kind !== "directory")
      throw new Error(`Private mutation parent is not a directory: ${checkpoint.path}`);
    await hardenWindowsEntriesLocked([inspected.entry]);
  });
}

/** Publish one descriptor-identified file beneath verified owner-only parents. @internal */
export async function publishPrivateFileAtomic(input: {
  path: string;
  ownedRoot: string;
  sourceDirectory: string;
  hardenOnPosix: boolean;
  supersessionPolicy?: "strict" | "reconstructable_projection";
  publish: () => Promise<AtomicFilePublication>;
}): Promise<void> {
  const absolute = resolve(input.path);
  const root = resolve(input.ownedRoot);
  const sourceDirectory = resolve(input.sourceDirectory);
  const targetDirectory = dirname(absolute);
  const relativePath = relative(root, absolute);
  await validatePrivatePath(root, relativePath);
  const parentPaths = [...new Set([sourceDirectory, targetDirectory])];
  for (const parent of parentPaths) await validatePrivatePath(root, relative(root, parent));

  if (supportsPosixModes) {
    await serializePrivatePathMutation(absolute, async () => {
      const publication = await input.publish();
      await validatePrivatePath(root, relativePath);
      const fileAfter = await inspectPrivateEntry(absolute);
      const publicationIdentity = privateEntryIdentityFingerprint({
        dev: publication.device,
        ino: publication.inode,
        birthtimeNs: publication.birthtimeNs,
      });
      if (resolve(publication.path) !== absolute || fileAfter.entry.kind !== "file")
        throw new Error(`Published private file changed filesystem identity: ${absolute}`);
      const superseded =
        publicationIdentity !== undefined &&
        fileAfter.identityFingerprint !== undefined &&
        fileAfter.identityFingerprint !== publicationIdentity;
      if (superseded && input.supersessionPolicy !== "reconstructable_projection")
        throw new Error(`Published private file changed filesystem identity: ${absolute}`);
      // Event-reconstructable projections may be rewritten by another runtime
      // process after this writer's atomic rename. Canonicalize that later
      // regular, singly-linked file before accepting the benign supersession.
      if (superseded || input.hardenOnPosix) await hardenPrivateFile(absolute, root);
    });
    return;
  }

  for (const parent of parentPaths) await ensurePrivateDirectory(parent, root);
  await serializePrivatePathMutation(absolute, async () => {
    await serializeWindowsAclWork(async () => {
      await validatePrivatePath(root, relativePath);
      try {
        const existing = await inspectPrivateEntry(absolute);
        if (existing.entry.kind !== "file")
          throw new Error(`Private publication path is not a regular file: ${absolute}`);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await hardenWindowsEntriesLocked(
        parentPaths.map((parent) => ({ kind: "directory", path: parent })),
      );

      const parentsBefore = await Promise.all(parentPaths.map(inspectPrivateEntry));
      for (const parentBefore of parentsBefore) {
        if (parentBefore.entry.kind !== "directory")
          throw new Error(
            `Private publication parent is not a directory: ${parentBefore.entry.path}`,
          );
        if (
          parentBefore.identityFingerprint !== undefined &&
          (parentBefore.metadataFingerprint === undefined ||
            hardenedWindowsIdentities.get(parentBefore.identityFingerprint) !==
              parentBefore.metadataFingerprint)
        )
          throw new Error(
            `Unable to verify owner-only publication parent identity: ${parentBefore.entry.path}`,
          );
      }

      const publication = await input.publish();
      await validatePrivatePath(root, relativePath);
      const [parentsAfter, fileAfter] = await Promise.all([
        Promise.all(parentPaths.map(inspectPrivateEntry)),
        inspectPrivateEntry(absolute),
      ]);
      let requiresParentHardening = false;
      for (const [index, parentAfter] of parentsAfter.entries()) {
        const parentBefore = parentsBefore[index]!;
        if (parentAfter.entry.kind !== "directory")
          throw new Error(
            `Private publication parent changed filesystem identity: ${parentAfter.entry.path}`,
          );
        if (
          parentBefore.identityFingerprint !== undefined &&
          parentAfter.identityFingerprint !== undefined &&
          parentAfter.identityFingerprint !== parentBefore.identityFingerprint
        )
          throw new Error(
            `Private publication parent changed filesystem identity: ${parentAfter.entry.path}`,
          );
        requiresParentHardening ||=
          parentBefore.identityFingerprint === undefined ||
          parentAfter.identityFingerprint === undefined;
      }
      if (fileAfter.entry.kind !== "file")
        throw new Error(`Published private path is not a regular file: ${absolute}`);

      const publicationIdentity = privatePublicationIdentityFingerprint({
        dev: publication.device,
        ino: publication.inode,
        birthtimeNs: publication.birthtimeNs,
      });
      if (resolve(publication.path) !== absolute)
        throw new Error(`Published private file changed filesystem identity: ${absolute}`);
      // Windows inherits a parent's DACL but can assign a different owner SID
      // to the new file. Canonicalize the observed final file before returning
      // or reporting strict supersession. Unknown parent identities also need
      // re-hardening because their pre-publication ACL provenance is unbound.
      await hardenWindowsEntriesLocked(
        requiresParentHardening
          ? [...parentsAfter.map(({ entry }) => entry), fileAfter.entry]
          : [fileAfter.entry],
        true,
      );
      // Rebind the strict decision after path-based ACL hardening. Another
      // Graphcraft process may have atomically replaced the path between the
      // first observation and the hardener's own identity-bound pass.
      const finalFile = await inspectPrivateEntry(absolute);
      if (finalFile.entry.kind !== "file")
        throw new Error(`Published private path is not a regular file: ${absolute}`);
      const superseded =
        publicationIdentity !== undefined &&
        finalFile.publicationIdentityFingerprint !== undefined &&
        finalFile.publicationIdentityFingerprint !== publicationIdentity;
      if (superseded && input.supersessionPolicy !== "reconstructable_projection")
        throw new Error(`Published private file changed filesystem identity: ${absolute}`);
      if (!requiresParentHardening)
        for (const parentAfter of parentsAfter)
          rememberWindowsIdentity(parentAfter.identityFingerprint, parentAfter.metadataFingerprint);
    });
  });
}

/**
 * Atomically replace JSON beneath an owner-only directory. Windows inherits
 * the verified parent ACL, while the descriptor receipt proves that the final
 * path is the file Graphcraft created. The final file is then canonicalized to
 * a protected, non-inherited owner-SID-only ACL because Windows does not inherit
 * file ownership from the parent directory.
 *
 * @internal
 */
export async function writePrivateJsonAtomic(
  path: string,
  value: unknown,
  ownedRoot: string,
  options: {
    supersessionPolicy?: "strict" | "reconstructable_projection";
  } = {},
): Promise<void> {
  const absolute = resolve(path);
  await publishPrivateFileAtomic({
    path: absolute,
    ownedRoot,
    sourceDirectory: dirname(absolute),
    hardenOnPosix: false,
    supersessionPolicy: options.supersessionPolicy ?? "strict",
    publish: async () => await writeJsonAtomic(absolute, value),
  });
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

export interface PrivateFileMutationCheckpoint {
  readonly path: string;
  readonly identityFingerprint: string | undefined;
  readonly metadataFingerprint: string | undefined;
}

const activePrivateFileMutations = new WeakSet<PrivateFileMutationCheckpoint>();

/**
 * Harden an existing private file immediately before a known in-place write.
 * The returned checkpoint lets the matching finalizer advance the Windows ACL
 * cache without treating arbitrary content changes as proof that the ACL is
 * still safe. Callers must not span unrelated work with this checkpoint.
 *
 * @internal
 */
export async function preparePrivateFileMutation(
  path: string,
  ownedRoot?: string,
): Promise<PrivateFileMutationCheckpoint> {
  const absolute = resolve(path);
  await hardenPrivateFile(absolute, ownedRoot);
  try {
    const inspected = await inspectPrivateEntry(absolute);
    if (inspected.entry.kind !== "file")
      throw new Error(`Private mutation path is not a regular file: ${absolute}`);
    const checkpoint = {
      path: absolute,
      identityFingerprint: inspected.identityFingerprint,
      metadataFingerprint: inspected.metadataFingerprint,
    };
    activePrivateFileMutations.add(checkpoint);
    return checkpoint;
  } catch (error) {
    if (!isMissing(error)) throw error;
    const checkpoint = {
      path: absolute,
      identityFingerprint: undefined,
      metadataFingerprint: undefined,
    };
    activePrivateFileMutations.add(checkpoint);
    return checkpoint;
  }
}

/** Finish a private in-place write begun by preparePrivateFileMutation. @internal */
export async function finalizePrivateFileMutation(
  checkpoint: PrivateFileMutationCheckpoint,
  ownedRoot?: string,
): Promise<void> {
  if (
    !activePrivateFileMutations.delete(checkpoint) ||
    supportsPosixModes ||
    checkpoint.identityFingerprint === undefined
  ) {
    await hardenPrivateFile(checkpoint.path, ownedRoot);
    return;
  }
  if (ownedRoot !== undefined)
    await validatePrivatePath(ownedRoot, relative(resolve(ownedRoot), resolve(checkpoint.path)));
  let inspected;
  try {
    inspected = await inspectPrivateEntry(checkpoint.path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (
    inspected.entry.kind === "file" &&
    inspected.identityFingerprint === checkpoint.identityFingerprint &&
    hardenedWindowsIdentities.get(checkpoint.identityFingerprint) === checkpoint.metadataFingerprint
  ) {
    rememberWindowsIdentity(inspected.identityFingerprint, inspected.metadataFingerprint);
    return;
  }
  await hardenPrivateFile(checkpoint.path, ownedRoot);
}

/** Harden a Graphcraft-owned tree without following symbolic links. */
export async function hardenPrivateTree(root: string, ownedRoot = root): Promise<void> {
  const absoluteRoot = resolve(root);
  await validatePrivatePath(ownedRoot, relative(resolve(ownedRoot), absoluteRoot));
  const entries = await collectPrivateTree(
    absoluteRoot,
    supportsPosixModes ? Number.POSITIVE_INFINITY : WINDOWS_ACL_REQUEST_LIMITS.maximumTargets,
  );
  if (!supportsPosixModes) {
    await hardenWindowsEntries(entries, true);
    return;
  }
  await hardenPosixEntries(entries, true);
}
