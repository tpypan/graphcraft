import { createInterface } from "node:readline/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import crossSpawn from "cross-spawn";
import packageMetadata from "../../../package.json" with { type: "json" };
import { CodexAdapter } from "@graphcraft/adapter-codex";
import { ClaudeAdapter } from "@graphcraft/adapter-claude";
import { assertGitHubPushCapability, probeGitHub } from "@graphcraft/github";
import {
  ContextSelectionReceiptSchema,
  terminateChildProcessTree,
  graphPlanShape,
  inferFinishLine,
  probePlanFromGraph,
  tokenCostReport,
  type Graph,
  type GraphAmendment,
  type HostAdapter,
  type HostCapabilities,
  type HostExecutionPolicy,
  type ProbePlan,
  type RunContract,
  type RunState,
} from "@graphcraft/core";
import {
  RunStore,
  amendRunGraph,
  configureRunProbes,
  createRun,
  decideRunControl,
  discoverRepository,
  ensurePrivateDirectory,
  executeRun,
  hardenPrivateFile,
  hardenPrivateTree,
  latestSupervisor,
  listRunIds,
  readPrivateFileBounded,
  readRegularFileBounded,
  requestRunControl,
  redactString,
  redactValue,
  resolveRunId,
  type RunObserver,
  type RunObserverEvent,
} from "@graphcraft/runtime";

const spawn = crossSpawn.spawn;

export type HostName = "codex" | "claude";
export const GRAPHCRAFT_VERSION = packageMetadata.version;

const RUNTIME_MANIFEST = "runtime.json";
const REGISTRATION_RECEIPT_MAX_BYTES = 16 * 1024;
const RUNTIME_MANIFEST_MAX_BYTES = 16 * 1024;
const MANAGED_RUNTIME_MAX_BYTES = 32 * 1024 * 1024;
const RUNTIME_STAGING_RESERVATION_ATTEMPTS = 8;
const HOST_MINIMUM_VERSIONS: Record<HostName, string> = {
  codex: "0.144.6",
  claude: "2.1.212",
};

const LEGACY_GRAPHCRAFT_RUNTIME_SHA256 = new Set([
  // v0.1.0 tagged bundle. This release predates durable runtime staging.
  "9522ea5f77bb680bc057e266fefb8732e5d572b5113f24e64537830f5159a643",
  // v0.1.1 tagged bundle and the public npm bundle produced by its prepack build.
  "b9b431dfd9f7c95620970db978adaea5bc3b574adb492aa072ec03129069ea9e",
  "3292fed342cc27adfe78e5cd90c6ccf00b893934ddd24d31fe4339b5cc0bc342",
]);

export interface HostCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HostCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type HostCommandRunner = (
  command: string,
  args: string[],
  options?: HostCommandOptions,
) => Promise<HostCommandResult>;

interface RuntimeManifest {
  schemaVersion: 1;
  graphcraftVersion: string;
  runtimeFile: "mcp.mjs";
  sha256: string;
  bytes: number;
}

interface BundledMcpRuntime {
  source: Buffer;
  manifest: RuntimeManifest;
}

export type RuntimePublicationBoundary = "after_prepare" | "after_publish";

interface RegistrationReceipt {
  schemaVersion: 1;
  host: HostName;
  graphcraftVersion: string;
  runtimePath: string;
  runtimeSha256: string;
}

export function createAdapter(host: HostName, policy?: HostExecutionPolicy): HostAdapter {
  return host === "claude" ? new ClaudeAdapter(policy) : new CodexAdapter(policy);
}

const HOST_COMMAND_TIMEOUT_MS = 30_000;
const HOST_COMMAND_OUTPUT_BYTES = 512 * 1024;
const HOST_COMMAND_TERMINATION_GRACE_MS = 1_000;

export function createHostCommandRunner(
  spawnCommand: typeof spawn = spawn,
  terminationGraceMs = HOST_COMMAND_TERMINATION_GRACE_MS,
): HostCommandRunner {
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) {
    throw new Error("Host command termination grace must be a positive safe integer");
  }
  return async (command, args, options = {}): Promise<HostCommandResult> => {
    const timeoutMs = options.timeoutMs ?? HOST_COMMAND_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? HOST_COMMAND_OUTPUT_BYTES;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Host command timeout must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new Error("Host command output limit must be a positive safe integer");
    }
    return await new Promise((resolveResult) => {
      const child = spawnCommand(command, args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let capturedBytes = 0;
      let settled = false;
      let terminationReason: string | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let escalation: NodeJS.Timeout | undefined;
      const complete = (exitCode: number, error?: string): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        const capturedStderr = Buffer.concat(stderr).toString("utf8");
        try {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        } catch {
          // Process cleanup must not prevent the bounded command result from resolving.
        }
        resolveResult({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: [capturedStderr, terminationReason, error].filter(Boolean).join("\n"),
        });
      };
      const terminate = (reason: string): void => {
        if (terminationReason || settled) return;
        terminationReason = reason;
        try {
          terminateChildProcessTree(child, "SIGTERM");
        } catch (error) {
          complete(-1, `Unable to terminate host command: ${String(error)}`);
          return;
        }
        escalation = setTimeout(() => {
          try {
            terminateChildProcessTree(child, "SIGKILL");
          } finally {
            complete(-1);
          }
        }, terminationGraceMs);
        escalation.unref();
      };
      const capture = (target: Buffer[], chunk: Buffer | string): void => {
        const value = Buffer.from(chunk);
        const remaining = Math.max(0, maxOutputBytes - capturedBytes);
        if (remaining > 0) {
          const selected = value.subarray(0, remaining);
          target.push(selected);
          capturedBytes += selected.byteLength;
        }
        if (value.byteLength > remaining) {
          terminate(
            `Graphcraft stopped ${command}: combined stdout/stderr exceeded ${String(maxOutputBytes)} bytes; captured output is truncated.`,
          );
        }
      };
      child.stdout.on("data", (chunk: Buffer | string) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer | string) => capture(stderr, chunk));
      child.once("error", (error) => {
        complete(-1, error.message);
      });
      child.once("close", (code) => {
        complete(terminationReason ? -1 : (code ?? 1));
      });
      timeout = setTimeout(
        () =>
          terminate(
            `Graphcraft stopped ${command}: host command timed out after ${String(timeoutMs)} ms.`,
          ),
        timeoutMs,
      );
      timeout.unref();
    });
  };
}

export const defaultHostCommandRunner = createHostCommandRunner();

function hostCommandError(command: string, args: string[], result: HostCommandResult): Error {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  return new Error(detail || `${command} ${args.join(" ")} exited ${String(result.exitCode)}`);
}

function missingRegistration(result: HostCommandResult): boolean {
  return /no mcp server (?:named|found with name)|no mcp server .* in user scope/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function syncDirectory(path: string): Promise<void> {
  if (platform() === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(path: string, value: Uint8Array, mode: number): Promise<void> {
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", mode);
  try {
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await chmod(path, mode);
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function parseRuntimeManifest(value: unknown): RuntimeManifest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const manifest = value as Partial<RuntimeManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.graphcraftVersion !== GRAPHCRAFT_VERSION ||
    manifest.runtimeFile !== "mcp.mjs" ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.bytes) ||
    Number(manifest.bytes) < 0
  )
    return undefined;
  return manifest as RuntimeManifest;
}

async function readRuntimeManifest(path: string): Promise<RuntimeManifest | undefined> {
  try {
    const source = await readRegularFile(
      path,
      0o600,
      RUNTIME_MANIFEST_MAX_BYTES,
      dirname(dirname(path)),
    );
    return source ? parseRuntimeManifest(JSON.parse(source.toString("utf8"))) : undefined;
  } catch {
    return undefined;
  }
}

function sameRuntimeManifest(left: RuntimeManifest | undefined, right: RuntimeManifest): boolean {
  return (
    left?.schemaVersion === right.schemaVersion &&
    left.graphcraftVersion === right.graphcraftVersion &&
    left.runtimeFile === right.runtimeFile &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes
  );
}

async function loadBundledMcpRuntime(sourcePath: string): Promise<BundledMcpRuntime> {
  const source = await readRegularFileBounded(sourcePath, MANAGED_RUNTIME_MAX_BYTES).catch(
    (error) => {
      throw new Error(
        `The bundled Graphcraft MCP runtime must be a regular file no larger than ${String(MANAGED_RUNTIME_MAX_BYTES)} bytes`,
        { cause: error },
      );
    },
  );
  return {
    source,
    manifest: {
      schemaVersion: 1,
      graphcraftVersion: GRAPHCRAFT_VERSION,
      runtimeFile: "mcp.mjs",
      sha256: sha256(source),
      bytes: source.byteLength,
    },
  };
}

async function runtimePairMatches(
  runtimeDirectory: string,
  bundled: BundledMcpRuntime,
): Promise<boolean> {
  const runtimeRoot = dirname(runtimeDirectory);
  if ((await runtimeDirectoryKind(runtimeDirectory)) !== "directory") return false;
  if (!(await managedDirectoryMatches(runtimeDirectory, 0o700))) return false;
  if (!(await runtimePairHasExactEntries(runtimeDirectory, bundled))) return false;
  try {
    await ensurePrivateDirectory(runtimeDirectory, runtimeRoot);
  } catch {
    return false;
  }
  const manifest = await readRuntimeManifest(join(runtimeDirectory, RUNTIME_MANIFEST));
  if (!sameRuntimeManifest(manifest, bundled.manifest)) return false;
  const runtime = await readRegularFile(
    join(runtimeDirectory, bundled.manifest.runtimeFile),
    0o600,
    bundled.manifest.bytes,
    runtimeRoot,
  );
  if (!runtime?.equals(bundled.source)) return false;
  try {
    await hardenPrivateTree(runtimeDirectory, runtimeRoot);
  } catch {
    return false;
  }
  const [hardenedManifest, hardenedRuntime] = await Promise.all([
    readRuntimeManifest(join(runtimeDirectory, RUNTIME_MANIFEST)),
    readRegularFile(
      join(runtimeDirectory, bundled.manifest.runtimeFile),
      0o600,
      bundled.manifest.bytes,
      runtimeRoot,
    ),
  ]);
  return (await runtimePairHasExactEntries(runtimeDirectory, bundled)) &&
    sameRuntimeManifest(hardenedManifest, bundled.manifest) &&
    hardenedRuntime?.equals(bundled.source)
    ? true
    : false;
}

async function runtimePairHasExactEntries(
  runtimeDirectory: string,
  bundled: BundledMcpRuntime,
): Promise<boolean> {
  try {
    const actual = (await readdir(runtimeDirectory)).sort();
    const expected = [RUNTIME_MANIFEST, bundled.manifest.runtimeFile].sort();
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

async function runtimePairContentsMatch(
  runtimeDirectory: string,
  bundled: BundledMcpRuntime,
): Promise<boolean> {
  const runtimeRoot = dirname(runtimeDirectory);
  if ((await runtimeDirectoryKind(runtimeDirectory)) !== "directory") return false;
  if (!(await managedDirectoryMatches(runtimeDirectory, 0o700))) return false;
  if (!(await runtimePairHasExactEntries(runtimeDirectory, bundled))) return false;
  const manifest = await readRuntimeManifest(join(runtimeDirectory, RUNTIME_MANIFEST));
  if (!sameRuntimeManifest(manifest, bundled.manifest)) return false;
  const runtime = await readRegularFile(
    join(runtimeDirectory, bundled.manifest.runtimeFile),
    0o600,
    bundled.manifest.bytes,
    runtimeRoot,
  );
  return runtime?.equals(bundled.source) === true;
}

type RuntimeDirectoryKind = "missing" | "directory" | "other";

async function runtimeDirectoryKind(path: string): Promise<RuntimeDirectoryKind> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink() ? "directory" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function modeMatches(mode: number, expectedMode?: number): boolean {
  return expectedMode === undefined || platform() === "win32" || (mode & 0o777) === expectedMode;
}

async function managedDirectoryMatches(path: string, expectedMode?: number): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return (
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      modeMatches(metadata.mode, expectedMode)
    );
  } catch {
    return false;
  }
}

async function ensurePrivateManagedDirectory(
  path: string,
  label: string,
  ownedRoot = path,
): Promise<void> {
  try {
    await ensurePrivateDirectory(path, ownedRoot);
  } catch (error) {
    throw new Error(`The managed Graphcraft ${label} directory is unsafe`, { cause: error });
  }
  if ((await runtimeDirectoryKind(path)) !== "directory") {
    throw new Error(`The managed Graphcraft ${label} path is not a directory`);
  }
  await chmod(path, 0o700);
  if (!(await managedDirectoryMatches(path, 0o700))) {
    throw new Error(`The managed Graphcraft ${label} directory is unsafe`);
  }
}

async function readRegularFile(
  path: string,
  expectedMode?: number,
  maximumBytes = MANAGED_RUNTIME_MAX_BYTES,
  ownedRoot?: string,
): Promise<Buffer | undefined> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return undefined;
  let pathMetadata;
  try {
    pathMetadata = await lstat(path);
  } catch {
    return undefined;
  }
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.size > maximumBytes ||
    !modeMatches(pathMetadata.mode, expectedMode)
  )
    return undefined;
  try {
    const source = await readPrivateFileBounded(path, maximumBytes, ownedRoot);
    const finalPathMetadata = await lstat(path);
    return finalPathMetadata.isFile() &&
      !finalPathMetadata.isSymbolicLink() &&
      modeMatches(finalPathMetadata.mode, expectedMode) &&
      finalPathMetadata.dev === pathMetadata.dev &&
      finalPathMetadata.ino === pathMetadata.ino &&
      finalPathMetadata.size === source.byteLength
      ? source
      : undefined;
  } catch {
    return undefined;
  }
}

function runtimePublicationPaths(graphcraftHome: string): {
  runtimeRoot: string;
  runtimeDirectory: string;
} {
  const runtimeRoot = join(graphcraftHome, "runtime");
  return {
    runtimeRoot,
    runtimeDirectory: join(runtimeRoot, GRAPHCRAFT_VERSION),
  };
}

interface RuntimeStagingReservation {
  path: string;
  identity: string | undefined;
}

async function runtimeStagingDirectoryIdentity(path: string): Promise<string | undefined> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.ino === 0n) return undefined;
  return `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}`;
}

async function reserveRuntimeStagingDirectory(
  runtimeRoot: string,
  forceIdentityUnavailable = false,
  forceIdentityInspectionFailure = false,
): Promise<RuntimeStagingReservation> {
  // fs.mkdtemp can report ENOENT once a valid Windows runtime path exceeds
  // MAX_PATH. An exclusive mkdir preserves collision safety on those paths.
  for (let attempt = 0; attempt < RUNTIME_STAGING_RESERVATION_ATTEMPTS; attempt += 1) {
    const candidate = join(
      runtimeRoot,
      `.${GRAPHCRAFT_VERSION}.staged-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    );
    try {
      await mkdir(candidate, { mode: 0o700 });
      try {
        if (forceIdentityInspectionFailure)
          throw new Error("Injected runtime staging identity inspection failure");
        return {
          path: candidate,
          identity: forceIdentityUnavailable
            ? undefined
            : await runtimeStagingDirectoryIdentity(candidate),
        };
      } catch (error) {
        // Identity was never established, so only attempt a non-recursive
        // removal of the still-empty reservation. Preserve replacements or
        // populated paths and surface the original inspection failure.
        await rmdir(candidate).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to reserve a private Graphcraft runtime staging directory");
}

async function cleanupRuntimeStagingDirectory(
  reservation: RuntimeStagingReservation,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(reservation.path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  // Replacement entries are left untouched. Recursive cleanup is permitted
  // only while the path still names the exact directory this process created.
  // When the filesystem cannot provide a stable identity, publication stops
  // before writing any entries, so only remove the reservation if it is still
  // an empty real directory. Never recurse through an unidentified path.
  if (reservation.identity === undefined) {
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    try {
      await rmdir(reservation.path);
    } catch (error) {
      if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
        return;
      throw error;
    }
    return;
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await runtimeStagingDirectoryIdentity(reservation.path)) !== reservation.identity
  )
    return;
  await rm(reservation.path, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 25,
  });
}

async function stageBundledMcpRuntime(
  bundled: BundledMcpRuntime,
  graphcraftHome: string,
  boundary?: (point: RuntimePublicationBoundary) => void | Promise<void>,
  forceIdentityUnavailable = false,
  forceIdentityInspectionFailure = false,
): Promise<{ path: string; manifest: RuntimeManifest }> {
  const paths = runtimePublicationPaths(graphcraftHome);
  await ensurePrivateDirectory(graphcraftHome);
  await ensurePrivateManagedDirectory(paths.runtimeRoot, "runtime root", graphcraftHome);
  const runtimePath = join(paths.runtimeDirectory, bundled.manifest.runtimeFile);
  const previousKind = await runtimeDirectoryKind(paths.runtimeDirectory);
  if (previousKind === "directory") {
    if (await runtimePairMatches(paths.runtimeDirectory, bundled)) {
      return { path: runtimePath, manifest: bundled.manifest };
    }
    throw new Error(
      `The managed Graphcraft runtime for version ${GRAPHCRAFT_VERSION} already exists with different or unsafe contents; versioned runtimes are immutable.`,
    );
  }
  if (previousKind === "other") {
    throw new Error("The managed Graphcraft runtime path is not a directory");
  }
  const stagingReservation = await reserveRuntimeStagingDirectory(
    paths.runtimeRoot,
    forceIdentityUnavailable,
    forceIdentityInspectionFailure,
  );
  const stagedDirectory = stagingReservation.path;
  let published = false;
  try {
    if (stagingReservation.identity === undefined) {
      throw new Error(
        "The Graphcraft runtime staging directory has no stable filesystem identity; publication was refused.",
      );
    }
    await ensurePrivateDirectory(stagedDirectory, paths.runtimeRoot);
    await writeAtomic(join(stagedDirectory, bundled.manifest.runtimeFile), bundled.source, 0o600);
    await writeAtomic(
      join(stagedDirectory, RUNTIME_MANIFEST),
      Buffer.from(`${JSON.stringify(bundled.manifest, null, 2)}\n`),
      0o600,
    );
    if (!(await runtimePairMatches(stagedDirectory, bundled))) {
      throw new Error("The prepared Graphcraft MCP runtime failed verification");
    }
    await syncDirectory(stagedDirectory);
    await boundary?.("after_prepare");
    if (
      !(await runtimePairContentsMatch(stagedDirectory, bundled)) ||
      (await runtimeStagingDirectoryIdentity(stagedDirectory)) !== stagingReservation.identity
    ) {
      throw new Error("The prepared Graphcraft MCP runtime changed before publication");
    }
    try {
      await rename(stagedDirectory, paths.runtimeDirectory);
      published = true;
    } catch (error) {
      const winnerKind = await runtimeDirectoryKind(paths.runtimeDirectory);
      if (
        winnerKind === "directory" &&
        (await runtimePairMatches(paths.runtimeDirectory, bundled))
      ) {
        await syncDirectory(paths.runtimeRoot);
        return { path: runtimePath, manifest: bundled.manifest };
      }
      if (winnerKind !== "missing") {
        throw new Error(
          `A concurrent Graphcraft installer published different or unsafe contents for immutable version ${GRAPHCRAFT_VERSION}; the existing runtime was left unchanged.`,
          { cause: error },
        );
      }
      throw error;
    }
    await syncDirectory(paths.runtimeRoot);
    await boundary?.("after_publish");
    if (!(await runtimePairMatches(paths.runtimeDirectory, bundled))) {
      throw new Error("The published Graphcraft MCP runtime failed verification");
    }
    return { path: runtimePath, manifest: bundled.manifest };
  } finally {
    if (!published) await cleanupRuntimeStagingDirectory(stagingReservation);
  }
}

export async function resolveBundledMcpPath(moduleUrl = import.meta.url): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(moduleDirectory, "mcp.mjs"),
    resolve(moduleDirectory, "../../../dist/mcp.mjs"),
    resolve(process.cwd(), "dist/mcp.mjs"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next source or bundled layout.
    }
  }
  throw new Error("dist/mcp.mjs is missing; run pnpm build before installing Graphcraft");
}

export function resolveGraphcraftHome(configuredHome = process.env.GRAPHCRAFT_HOME): string {
  return configuredHome?.trim() ? resolve(configuredHome) : join(homedir(), ".graphcraft");
}

async function ensureGraphcraftHomeIfPresent(graphcraftHome: string): Promise<boolean> {
  if ((await runtimeDirectoryKind(graphcraftHome)) === "missing") return false;
  await ensurePrivateDirectory(graphcraftHome);
  return true;
}

export async function stageBundledMcp(
  sourcePath: string,
  graphcraftHome = resolveGraphcraftHome(),
): Promise<string> {
  return (await stageBundledMcpRuntime(await loadBundledMcpRuntime(sourcePath), graphcraftHome))
    .path;
}

function removeArguments(host: HostName): string[] {
  return host === "codex"
    ? ["mcp", "remove", "graphcraft"]
    : ["mcp", "remove", "--scope", "user", "graphcraft"];
}

function addArguments(host: HostName, runtimePath: string): string[] {
  return addRegistrationArguments(host, { command: "node", args: [runtimePath] });
}

interface HostRegistration {
  command: string;
  args: string[];
}

interface HostRegistrationInspection {
  status: "current" | "stale" | "missing" | "unavailable" | "unknown";
  detail?: string;
  registration?: HostRegistration;
}

function addRegistrationArguments(host: HostName, registration: HostRegistration): string[] {
  return host === "codex"
    ? ["mcp", "add", "graphcraft", "--", registration.command, ...registration.args]
    : [
        "mcp",
        "add",
        "--scope",
        "user",
        "graphcraft",
        "--",
        registration.command,
        ...registration.args,
      ];
}

function commandFor(host: HostName): string {
  return host;
}

async function withPrivateHostCommandCwd<T>(
  operation: (cwd: string) => Promise<T>,
  createdBoundary?: (cwd: string) => void | Promise<void>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "graphcraft-host-config-"));
  try {
    await createdBoundary?.(cwd);
    await ensurePrivateDirectory(cwd);
    if ((await readdir(cwd)).length !== 0) {
      throw new Error(
        "Refusing to run a host command from a temporary directory populated before it was secured",
      );
    }
    return await operation(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function removeHostRegistration(
  host: HostName,
  runner: HostCommandRunner,
  cwd: string,
): Promise<boolean> {
  const args = removeArguments(host);
  const result = await runner(commandFor(host), args, { cwd });
  if (result.exitCode === 0) return true;
  if (missingRegistration(result)) return false;
  throw hostCommandError(commandFor(host), args, result);
}

function sameRuntimePath(left: string, right: string): boolean {
  if (!isAbsolute(left) || !isAbsolute(right)) return false;
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return platform() === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function inspectHostRegistration(
  host: HostName,
  expected: HostRegistration,
  runner: HostCommandRunner,
  cwd: string,
  knownSingleArguments: readonly string[] = [],
): Promise<HostRegistrationInspection> {
  const args =
    host === "codex" ? ["mcp", "get", "graphcraft", "--json"] : ["mcp", "get", "graphcraft"];
  const result = await runner(commandFor(host), args, { cwd });
  if (result.exitCode !== 0) {
    if (missingRegistration(result)) return { status: "missing" };
    if (result.exitCode === -1)
      return { status: "unavailable", detail: result.stderr || result.stdout };
    return { status: "unknown", detail: result.stderr || result.stdout };
  }

  let command: string | undefined;
  let registeredArgs: string[] | undefined;
  if (host === "codex") {
    try {
      const value = JSON.parse(result.stdout) as {
        command?: unknown;
        args?: unknown;
        transport?: {
          type?: unknown;
          command?: unknown;
          args?: unknown;
          env?: unknown;
          env_vars?: unknown;
          cwd?: unknown;
        };
      };
      const transport = (value.transport ?? value) as {
        type?: unknown;
        command?: unknown;
        args?: unknown;
        env?: unknown;
        env_vars?: unknown;
        cwd?: unknown;
      };
      const environmentIsEmpty =
        transport.env === null ||
        (typeof transport.env === "object" &&
          transport.env !== null &&
          !Array.isArray(transport.env) &&
          Object.keys(transport.env).length === 0);
      const inheritedEnvironmentIsEmpty =
        transport.env_vars === undefined ||
        (Array.isArray(transport.env_vars) && transport.env_vars.length === 0);
      const cwdIsEmpty = transport.cwd === null || transport.cwd === "";
      if (
        transport.type !== "stdio" ||
        !environmentIsEmpty ||
        !inheritedEnvironmentIsEmpty ||
        !cwdIsEmpty
      ) {
        return {
          status: "unknown",
          detail: "Codex exposed a non-stdio or authority-bearing MCP transport",
        };
      }
      if (typeof transport.command === "string") command = transport.command;
      if (
        Array.isArray(transport.args) &&
        transport.args.every((argument) => typeof argument === "string")
      )
        registeredArgs = transport.args as string[];
    } catch {
      return { status: "unknown", detail: "Codex returned invalid MCP registration JSON" };
    }
  } else {
    const scope = /^[ \t]*Scope:[ \t]*(.+?)[ \t]*$/mu.exec(result.stdout)?.[1];
    if (scope !== "User config (available in all your projects)") {
      return {
        status: "unknown",
        detail: "Claude did not expose the exact user-scoped MCP registration",
      };
    }
    const type = /^[ \t]*Type:[ \t]*(.+?)[ \t]*$/mu.exec(result.stdout)?.[1];
    const environment = /^[ \t]*Environment:[ \t]*(.*?)[ \t]*$/mu.exec(result.stdout)?.[1];
    const cwd = /^[ \t]*(?:Cwd|Working directory):[ \t]*(.*?)[ \t]*$/imu.exec(result.stdout)?.[1];
    if (type !== "stdio" || environment === undefined || environment !== "" || cwd) {
      return {
        status: "unknown",
        detail: "Claude exposed a non-stdio or authority-bearing MCP transport",
      };
    }
    command = /^[ \t]*Command:[ \t]*(.+?)[ \t]*$/mu.exec(result.stdout)?.[1];
    const renderedArgs = /^[ \t]*Args:[ \t]*(.*?)[ \t]*$/mu.exec(result.stdout)?.[1];
    if (renderedArgs !== undefined) {
      if (!renderedArgs) {
        registeredArgs = [];
      } else if (
        command === expected.command &&
        expected.args.length === 1 &&
        sameRuntimePath(renderedArgs, expected.args[0]!)
      ) {
        registeredArgs = [renderedArgs];
      } else if (
        command === "node" &&
        knownSingleArguments.some((argument) => sameRuntimePath(renderedArgs, argument))
      ) {
        registeredArgs = [renderedArgs];
      } else if (/\s/u.test(renderedArgs)) {
        return {
          status: "unknown",
          detail: "Claude returned arguments that cannot be reconstructed losslessly",
        };
      } else {
        registeredArgs = [renderedArgs];
      }
    }
  }

  if (!command || !registeredArgs) {
    return { status: "unknown", detail: `${host} did not expose the MCP command and arguments` };
  }
  const registration = { command, args: registeredArgs };
  const current =
    command === expected.command &&
    registeredArgs.length === expected.args.length &&
    registeredArgs.every((argument, index) => {
      const expectedArgument = expected.args[index]!;
      return command === "node" && registeredArgs.length === 1
        ? sameRuntimePath(argument, expectedArgument)
        : argument === expectedArgument;
    });
  return {
    status: current ? "current" : "stale",
    registration,
    ...(current ? {} : { detail: `${host} is registered to a different MCP runtime` }),
  };
}

async function restoreHostRegistration(
  host: HostName,
  previous: HostRegistrationInspection,
  runner: HostCommandRunner,
  cwd: string,
): Promise<string> {
  const problems: string[] = [];
  try {
    await removeHostRegistration(host, runner, cwd);
  } catch (error) {
    problems.push(`partial-registration cleanup failed: ${String(error)}`);
  }
  if (previous.status === "missing") {
    return problems.length === 0
      ? "No previous registration existed; any partial replacement was removed."
      : `No previous registration existed; ${problems.join("; ")}`;
  }
  if (!previous.registration) {
    return `The previous registration could not be reconstructed; ${problems.join("; ") || "no restoration was attempted"}.`;
  }

  const restoreArgs = addRegistrationArguments(host, previous.registration);
  const restored = await runner(commandFor(host), restoreArgs, { cwd });
  if (restored.exitCode !== 0) {
    problems.push(
      `restore command failed: ${hostCommandError(commandFor(host), restoreArgs, restored).message}`,
    );
  } else {
    const verification = await inspectHostRegistration(host, previous.registration, runner, cwd);
    if (verification.status !== "current") {
      problems.push(`restored registration could not be verified (${verification.status})`);
    }
  }
  return problems.length === 0
    ? "The previous registration was restored and verified."
    : `Best-effort restoration was incomplete: ${problems.join("; ")}`;
}

async function writeRegistrationReceipt(
  graphcraftHome: string,
  host: HostName,
  runtimePath: string,
  runtimeSha256: string,
): Promise<void> {
  const directory = join(graphcraftHome, "registrations");
  await ensurePrivateDirectory(graphcraftHome);
  await ensurePrivateManagedDirectory(directory, "registration receipts", graphcraftHome);
  const receipt: RegistrationReceipt = {
    schemaVersion: 1,
    host,
    graphcraftVersion: GRAPHCRAFT_VERSION,
    runtimePath,
    runtimeSha256,
  };
  const receiptPath = join(directory, `${host}.json`);
  await writeAtomic(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), 0o600);
  await hardenPrivateFile(receiptPath, graphcraftHome);
}

async function readRegistrationReceiptSnapshot(
  graphcraftHome: string,
  host: HostName,
): Promise<Uint8Array | undefined> {
  return await readRegistrationReceiptBytes(graphcraftHome, host);
}

async function restoreRegistrationReceipt(
  graphcraftHome: string,
  host: HostName,
  previous: Uint8Array | undefined,
): Promise<string> {
  const path = join(graphcraftHome, "registrations", `${host}.json`);
  if (previous === undefined) {
    const directory = dirname(path);
    const directoryKind = await runtimeDirectoryKind(directory);
    if (directoryKind === "missing") {
      return "The previous registration receipt was absent and remains absent.";
    }
    if (!(await managedDirectoryMatches(directory, 0o700))) {
      throw new Error("The managed Graphcraft registration receipts directory is unsafe");
    }
    await rm(path, { force: true });
    return "The previous registration receipt was absent and remains absent.";
  }
  const directory = dirname(path);
  await ensurePrivateDirectory(graphcraftHome);
  await ensurePrivateManagedDirectory(directory, "registration receipts", graphcraftHome);
  await writeAtomic(path, previous, 0o600);
  await hardenPrivateFile(path, graphcraftHome);
  return "The previous registration receipt was restored.";
}

async function readRegistrationReceiptBytes(
  graphcraftHome: string,
  host: HostName,
): Promise<Buffer | undefined> {
  const directory = join(graphcraftHome, "registrations");
  const directoryKind = await runtimeDirectoryKind(directory);
  if (directoryKind === "missing") return undefined;
  await ensurePrivateManagedDirectory(directory, "registration receipts", graphcraftHome);
  if (!(await managedDirectoryMatches(directory, 0o700))) {
    throw new Error("The managed Graphcraft registration receipts directory is unsafe");
  }
  const path = join(directory, `${host}.json`);
  await hardenPrivateFile(path, graphcraftHome);
  const source = await readRegularFile(path, 0o600, REGISTRATION_RECEIPT_MAX_BYTES, graphcraftHome);
  if (source) return source;
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  throw new Error(`The managed Graphcraft ${host} registration receipt is unsafe`);
}

async function readRegistrationReceipt(
  graphcraftHome: string,
  host: HostName,
): Promise<RegistrationReceipt | undefined> {
  const source = await readRegistrationReceiptBytes(graphcraftHome, host);
  if (!source) return undefined;
  let value: Partial<RegistrationReceipt>;
  try {
    value = JSON.parse(source.toString("utf8")) as Partial<RegistrationReceipt>;
  } catch {
    return undefined;
  }
  if (
    value.schemaVersion !== 1 ||
    value.host !== host ||
    typeof value.graphcraftVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.graphcraftVersion) ||
    typeof value.runtimePath !== "string" ||
    typeof value.runtimeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.runtimeSha256)
  )
    return undefined;
  return value as RegistrationReceipt;
}

async function verifiedReceiptRuntimePath(
  graphcraftHome: string,
  receipt: RegistrationReceipt | undefined,
): Promise<string | undefined> {
  const expectedPath = receiptRuntimePath(graphcraftHome, receipt);
  if (!expectedPath || !receipt) return undefined;
  const source = await readManagedRuntimeFile(graphcraftHome, expectedPath);
  if (!source || sha256(source) !== receipt.runtimeSha256) return undefined;
  await hardenPrivateFile(expectedPath, graphcraftHome);
  const hardened = await readManagedRuntimeFile(graphcraftHome, expectedPath, 0o600);
  return hardened && sha256(hardened) === receipt.runtimeSha256 ? expectedPath : undefined;
}

export function isLegacyGraphcraftRuntimeSha256(value: string): boolean {
  return LEGACY_GRAPHCRAFT_RUNTIME_SHA256.has(value);
}

export function isManagedLegacyGraphcraftRuntime(
  graphcraftHome: string,
  runtimePath: string,
  runtimeSha256: string,
): boolean {
  return (
    isAbsolute(runtimePath) &&
    legacyStagedRuntimePaths(graphcraftHome).some((candidate) =>
      sameRuntimePath(runtimePath, candidate),
    ) &&
    isLegacyGraphcraftRuntimeSha256(runtimeSha256)
  );
}

async function verifiedLegacyRuntimePath(
  graphcraftHome: string,
  registration: HostRegistration | undefined,
): Promise<string | undefined> {
  if (
    registration?.command !== "node" ||
    registration.args.length !== 1 ||
    !isAbsolute(registration.args[0]!)
  )
    return undefined;
  const runtimePath = resolve(registration.args[0]!);
  if (
    !legacyStagedRuntimePaths(graphcraftHome).some((candidate) =>
      sameRuntimePath(runtimePath, candidate),
    )
  )
    return undefined;
  const source = await readManagedRuntimeFile(graphcraftHome, runtimePath);
  if (!source || !isManagedLegacyGraphcraftRuntime(graphcraftHome, runtimePath, sha256(source)))
    return undefined;
  await hardenPrivateFile(runtimePath, graphcraftHome);
  const hardened = await readManagedRuntimeFile(graphcraftHome, runtimePath, 0o600);
  return hardened && isManagedLegacyGraphcraftRuntime(graphcraftHome, runtimePath, sha256(hardened))
    ? runtimePath
    : undefined;
}

function registrationUsesRuntime(
  registration: HostRegistration | undefined,
  runtimePath: string | undefined,
): boolean {
  return (
    runtimePath !== undefined &&
    registration?.command === "node" &&
    registration.args.length === 1 &&
    sameRuntimePath(registration.args[0]!, runtimePath)
  );
}

function legacyStagedRuntimePaths(graphcraftHome: string): string[] {
  return ["0.1.0", "0.1.1"].map((version) => join(graphcraftHome, "runtime", version, "mcp.mjs"));
}

async function readManagedRuntimeFile(
  graphcraftHome: string,
  runtimePath: string,
  expectedMode?: number,
): Promise<Buffer | undefined> {
  const runtimeRoot = join(graphcraftHome, "runtime");
  const runtimeDirectory = dirname(runtimePath);
  if (
    (await runtimeDirectoryKind(runtimeRoot)) !== "directory" ||
    (await runtimeDirectoryKind(runtimeDirectory)) !== "directory"
  )
    return undefined;
  try {
    await ensurePrivateDirectory(runtimeRoot, graphcraftHome);
    await ensurePrivateDirectory(runtimeDirectory, runtimeRoot);
  } catch {
    return undefined;
  }
  if (
    !(await managedDirectoryMatches(runtimeRoot, 0o700)) ||
    !(await managedDirectoryMatches(runtimeDirectory, 0o700))
  )
    return undefined;
  return await readRegularFile(
    runtimePath,
    expectedMode,
    MANAGED_RUNTIME_MAX_BYTES,
    graphcraftHome,
  );
}

function receiptRuntimePath(
  graphcraftHome: string,
  receipt: RegistrationReceipt | undefined,
): string | undefined {
  if (!receipt) return undefined;
  const expectedPath = join(graphcraftHome, "runtime", receipt.graphcraftVersion, "mcp.mjs");
  return sameRuntimePath(receipt.runtimePath, expectedPath) ? expectedPath : undefined;
}

async function verifiedCurrentBundledRuntimePath(
  graphcraftHome: string,
  bundled: BundledMcpRuntime,
): Promise<string | undefined> {
  const { runtimeRoot, runtimeDirectory } = runtimePublicationPaths(graphcraftHome);
  return (await managedDirectoryMatches(runtimeRoot, 0o700)) &&
    (await runtimePairMatches(runtimeDirectory, bundled))
    ? join(runtimeDirectory, bundled.manifest.runtimeFile)
    : undefined;
}

export interface HostLifecycleOptions {
  graphcraftHome?: string;
  runner?: HostCommandRunner;
  /** @internal Fault boundary used by the installer transaction tests. */
  runtimePublicationBoundary?: (point: RuntimePublicationBoundary) => void | Promise<void>;
  /** @internal Simulates unavailable filesystem identity in installer fault tests. */
  runtimeStagingIdentityUnavailableForTest?: boolean;
  /** @internal Simulates a post-reservation identity inspection failure. */
  runtimeStagingIdentityInspectionFailureForTest?: boolean;
  /** @internal Fault boundary used to simulate pre-hardening host-cwd injection. */
  hostCommandCwdCreatedBoundary?: (cwd: string) => void | Promise<void>;
}

export interface HostInstallationResult {
  host: HostName;
  graphcraftVersion: string;
  runtimePath: string;
  runtimeSha256: string;
}

async function configureHost(
  host: HostName,
  mcpPath: string | undefined,
  options: HostLifecycleOptions,
): Promise<HostInstallationResult> {
  const graphcraftHome = resolveGraphcraftHome(options.graphcraftHome);
  await ensurePrivateDirectory(graphcraftHome);
  const runner = options.runner ?? defaultHostCommandRunner;
  const bundledMcpPath = mcpPath ?? (await resolveBundledMcpPath());
  const bundledRuntime = await loadBundledMcpRuntime(bundledMcpPath);
  const runtimePath = join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "mcp.mjs");
  const expectedRegistration = { command: "node", args: [runtimePath] };
  const previousReceipt = await readRegistrationReceipt(graphcraftHome, host);
  const knownPreviousRuntimePath = await verifiedReceiptRuntimePath(
    graphcraftHome,
    previousReceipt,
  );
  const knownInspectionPaths = [
    ...(knownPreviousRuntimePath ? [knownPreviousRuntimePath] : []),
    ...legacyStagedRuntimePaths(graphcraftHome),
  ];
  return await withPrivateHostCommandCwd(async (cwd) => {
    const previous = await inspectHostRegistration(
      host,
      expectedRegistration,
      runner,
      cwd,
      knownInspectionPaths,
    );
    if (!["current", "stale", "missing"].includes(previous.status)) {
      throw new Error(
        `The existing ${host} MCP registration could not be inspected safely (${previous.status}); it was left unchanged.`,
      );
    }
    const legacyRuntimePath = await verifiedLegacyRuntimePath(
      graphcraftHome,
      previous.registration,
    );
    const recoverableCurrentRuntimePath =
      previous.status === "current"
        ? await verifiedCurrentBundledRuntimePath(graphcraftHome, bundledRuntime)
        : undefined;
    const ownedRuntimePath = registrationUsesRuntime(
      previous.registration,
      knownPreviousRuntimePath,
    )
      ? knownPreviousRuntimePath
      : (legacyRuntimePath ?? recoverableCurrentRuntimePath);
    if (previous.status !== "missing" && !ownedRuntimePath) {
      throw new Error(
        `The existing ${host} MCP registration has no verifiable Graphcraft ownership receipt or recognized legacy runtime, and it is not an exact current bundled runtime; it was left unchanged. Remove or rename it explicitly before installing Graphcraft.`,
      );
    }
    const previousReceiptSnapshot = await readRegistrationReceiptSnapshot(graphcraftHome, host);
    const runtime = await stageBundledMcpRuntime(
      bundledRuntime,
      graphcraftHome,
      options.runtimePublicationBoundary,
      options.runtimeStagingIdentityUnavailableForTest === true,
      options.runtimeStagingIdentityInspectionFailureForTest === true,
    );
    if (previous.status === "current") {
      const current = await inspectHostRegistration(host, expectedRegistration, runner, cwd, [
        runtime.path,
      ]);
      if (current.status !== "current") {
        throw new Error(
          `The ${host} MCP registration changed during installation (${current.status}); it was left unchanged.`,
        );
      }
      await writeRegistrationReceipt(graphcraftHome, host, runtime.path, runtime.manifest.sha256);
      return {
        host,
        graphcraftVersion: GRAPHCRAFT_VERSION,
        runtimePath: runtime.path,
        runtimeSha256: runtime.manifest.sha256,
      };
    }
    const current = previous.registration
      ? await inspectHostRegistration(host, previous.registration, runner, cwd, [
          ...(ownedRuntimePath ? [ownedRuntimePath] : []),
          ...knownInspectionPaths,
        ])
      : await inspectHostRegistration(host, expectedRegistration, runner, cwd, [runtime.path]);
    if (
      (previous.status === "missing" && current.status !== "missing") ||
      (previous.status !== "missing" && current.status !== "current")
    ) {
      throw new Error(
        `The ${host} MCP registration changed during installation (${current.status}); it was left unchanged.`,
      );
    }
    try {
      await removeHostRegistration(host, runner, cwd);
      const args = addArguments(host, runtime.path);
      const added = await runner(commandFor(host), args, { cwd });
      if (added.exitCode !== 0) throw hostCommandError(commandFor(host), args, added);
      const registration = await inspectHostRegistration(host, expectedRegistration, runner, cwd);
      if (registration.status !== "current") {
        throw new Error(
          `The ${host} MCP registration could not be verified after installation (${registration.status})`,
        );
      }
      await writeRegistrationReceipt(graphcraftHome, host, runtime.path, runtime.manifest.sha256);
    } catch (error) {
      const restoration = await restoreHostRegistration(host, previous, runner, cwd).catch(
        (restoreError) => `Best-effort restoration failed: ${String(restoreError)}`,
      );
      const receiptRestoration = await restoreRegistrationReceipt(
        graphcraftHome,
        host,
        previousReceiptSnapshot,
      ).catch((restoreError) => `Receipt restoration failed: ${String(restoreError)}`);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} ${restoration} ${receiptRestoration}`, { cause: error });
    }
    return {
      host,
      graphcraftVersion: GRAPHCRAFT_VERSION,
      runtimePath: runtime.path,
      runtimeSha256: runtime.manifest.sha256,
    };
  }, options.hostCommandCwdCreatedBoundary);
}

export function validateLocalViewerUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error("The local viewer URL is invalid", { cause: error });
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("The local viewer URL must be an exact loopback HTTP origin with a port");
  }
  return parsed.href;
}

export async function installHost(
  host: HostName,
  mcpPath?: string,
  options: HostLifecycleOptions = {},
): Promise<HostInstallationResult> {
  return await configureHost(host, mcpPath, options);
}

export async function updateHost(
  host: HostName,
  mcpPath?: string,
  options: HostLifecycleOptions = {},
): Promise<HostInstallationResult> {
  return await configureHost(host, mcpPath, options);
}

export async function uninstallHost(
  host: HostName,
  options: HostLifecycleOptions = {},
): Promise<{ host: HostName; removed: boolean }> {
  const graphcraftHome = resolveGraphcraftHome(options.graphcraftHome);
  await ensureGraphcraftHomeIfPresent(graphcraftHome);
  const runner = options.runner ?? defaultHostCommandRunner;
  const receipt = await readRegistrationReceipt(graphcraftHome, host);
  const recordedRuntimePath = receiptRuntimePath(graphcraftHome, receipt);
  const inspectionRuntimePath =
    recordedRuntimePath ?? join(graphcraftHome, "runtime", GRAPHCRAFT_VERSION, "mcp.mjs");
  const removed = await withPrivateHostCommandCwd(async (cwd) => {
    const registration = await inspectHostRegistration(
      host,
      { command: "node", args: [inspectionRuntimePath] },
      runner,
      cwd,
      recordedRuntimePath ? [recordedRuntimePath] : [],
    );
    if (registration.status === "missing") return false;
    if (registration.status === "unavailable" || registration.status === "unknown") {
      throw new Error(
        `The existing ${host} MCP registration could not be inspected safely (${registration.status}); it was left unchanged.`,
      );
    }
    if (!receipt || !recordedRuntimePath) {
      throw new Error(
        `The existing ${host} MCP registration has no valid Graphcraft ownership receipt; it was left unchanged.`,
      );
    }
    const verifiedRuntimePath = await verifiedReceiptRuntimePath(graphcraftHome, receipt);
    if (!verifiedRuntimePath) {
      throw new Error(
        `The recorded ${host} Graphcraft runtime failed ownership verification; the registration was left unchanged.`,
      );
    }
    if (registration.status !== "current") {
      throw new Error(
        `The existing ${host} MCP registration is not owned by the verified Graphcraft runtime; it was left unchanged.`,
      );
    }
    const current = await inspectHostRegistration(
      host,
      { command: "node", args: [verifiedRuntimePath] },
      runner,
      cwd,
      [verifiedRuntimePath],
    );
    if (current.status === "missing") return false;
    if (current.status !== "current") {
      throw new Error(
        `The ${host} MCP registration changed during uninstall (${current.status}); it was left unchanged.`,
      );
    }
    return await removeHostRegistration(host, runner, cwd);
  }, options.hostCommandCwdCreatedBoundary);
  await rm(join(graphcraftHome, "registrations", `${host}.json`), { force: true });
  return { host, removed };
}

function parseVersion(value: string | undefined): [number, number, number] | undefined {
  const match = value?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! - right[index]!;
  }
  return 0;
}

export function hostCompatibilityDiagnostic(
  host: HostName,
  capabilities: HostCapabilities,
): {
  status: "missing" | "unsupported" | "compatible" | "unknown";
  installedVersion?: string;
  minimumVersion: string;
  authenticated: boolean;
  exactTestedVersion: boolean;
  detail: string;
} {
  const minimumVersion = HOST_MINIMUM_VERSIONS[host];
  if (!capabilities.installed) {
    return {
      status: "missing",
      minimumVersion,
      authenticated: false,
      exactTestedVersion: false,
      detail: `${host} is not installed`,
    };
  }
  const installed = parseVersion(capabilities.version);
  const minimum = parseVersion(minimumVersion)!;
  if (!installed) {
    return {
      status: "unknown",
      ...(capabilities.version ? { installedVersion: capabilities.version } : {}),
      minimumVersion,
      authenticated: capabilities.authenticated,
      exactTestedVersion: false,
      detail: `${host} did not report a parseable semantic version`,
    };
  }
  const exactTestedVersion = compareVersion(installed, minimum) === 0;
  const compatible = compareVersion(installed, minimum) >= 0;
  return {
    status: compatible ? "compatible" : "unsupported",
    ...(capabilities.version ? { installedVersion: capabilities.version } : {}),
    minimumVersion,
    authenticated: capabilities.authenticated,
    exactTestedVersion,
    detail: compatible
      ? exactTestedVersion
        ? `${host} matches the recorded live-test version`
        : `${host} meets the minimum version; this exact version is not in the recorded live-test matrix`
      : `${host} is older than the minimum supported version`,
  };
}

export async function installationDiagnostics(
  options: HostLifecycleOptions & { mcpPath?: string } = {},
): Promise<Record<string, unknown>> {
  const graphcraftHome = resolveGraphcraftHome(options.graphcraftHome);
  await ensureGraphcraftHomeIfPresent(graphcraftHome);
  const expectedSource = options.mcpPath ?? (await resolveBundledMcpPath());
  const bundled = await loadBundledMcpRuntime(expectedSource);
  const expectedSha256 = bundled.manifest.sha256;
  const runtimeRoot = join(graphcraftHome, "runtime");
  const runtimeDirectory = join(runtimeRoot, GRAPHCRAFT_VERSION);
  const runtimePath = join(runtimeDirectory, "mcp.mjs");
  const runtimeDirectoryState = await runtimeDirectoryKind(runtimeDirectory);
  const safeRuntimeDirectories =
    (await managedDirectoryMatches(runtimeRoot, 0o700)) &&
    (await managedDirectoryMatches(runtimeDirectory, 0o700));
  const manifest = safeRuntimeDirectories
    ? await readRuntimeManifest(join(runtimeDirectory, RUNTIME_MANIFEST))
    : undefined;
  const actualRuntime = safeRuntimeDirectories
    ? await readRegularFile(runtimePath, 0o600, MANAGED_RUNTIME_MAX_BYTES, graphcraftHome)
    : undefined;
  const actualSha256 = actualRuntime ? sha256(actualRuntime) : undefined;
  const runtimeCurrent =
    safeRuntimeDirectories && (await runtimePairMatches(runtimeDirectory, bundled));
  const runtimeStatus = runtimeCurrent
    ? "current"
    : runtimeDirectoryState === "missing"
      ? "missing"
      : "stale";
  const runner = options.runner ?? defaultHostCommandRunner;
  const expectedRegistration = { command: "node", args: [runtimePath] };
  const [codexReceipt, claudeReceipt] = await Promise.all([
    readRegistrationReceipt(graphcraftHome, "codex"),
    readRegistrationReceipt(graphcraftHome, "claude"),
  ]);
  const [knownCodexRuntimePath, knownClaudeRuntimePath] = await Promise.all([
    verifiedReceiptRuntimePath(graphcraftHome, codexReceipt),
    verifiedReceiptRuntimePath(graphcraftHome, claudeReceipt),
  ]);
  const [codex, claude] = await withPrivateHostCommandCwd(
    async (cwd) =>
      await Promise.all([
        inspectHostRegistration(
          "codex",
          expectedRegistration,
          runner,
          cwd,
          knownCodexRuntimePath ? [knownCodexRuntimePath] : [],
        ),
        inspectHostRegistration(
          "claude",
          expectedRegistration,
          runner,
          cwd,
          knownClaudeRuntimePath ? [knownClaudeRuntimePath] : [],
        ),
      ]),
    options.hostCommandCwdCreatedBoundary,
  );
  const withReceipt = (
    host: HostName,
    registration: Awaited<ReturnType<typeof inspectHostRegistration>>,
    receipt: RegistrationReceipt | undefined,
  ) => ({
    ...registration,
    receipt: !receipt
      ? "missing"
      : receipt.host === host &&
          receipt.graphcraftVersion === GRAPHCRAFT_VERSION &&
          sameRuntimePath(receipt.runtimePath, runtimePath) &&
          receipt.runtimeSha256 === expectedSha256 &&
          runtimeCurrent
        ? "current"
        : "stale",
  });
  return {
    graphcraftVersion: GRAPHCRAFT_VERSION,
    graphcraftHome,
    runtime: {
      status: runtimeStatus,
      path: runtimePath,
      expectedSha256,
      ...(actualSha256 ? { actualSha256 } : {}),
      ...(manifest ? { manifest } : {}),
    },
    registrations: {
      codex: withReceipt("codex", codex, codexReceipt),
      claude: withReceipt("claude", claude, claudeReceipt),
    },
  };
}

export interface TaskShapeAssessment {
  bypass: boolean;
  score: number;
  signals: {
    actionCount: number;
    pathCount: number;
    localized: boolean;
    broadScope: boolean;
    durableWorkflow: boolean;
    externalWait: boolean;
    multipleSteps: boolean;
  };
}

export function assessTaskShape(task: string): TaskShapeAssessment {
  const value = task.trim();
  const actionPatterns = [
    /\bfix(?:e[sd]?|ing)?\b/i,
    /\bimplement(?:ed|ing)?\b/i,
    /\badd(?:ed|ing)?\b/i,
    /\b(?:updat|chang|remov|renam|migrat|refactor|audit|investigat|verif|test|commit|push)\w*\b/i,
  ];
  const actionCount = actionPatterns.filter((pattern) => pattern.test(value)).length;
  const paths =
    value.match(
      /(?:^|\s)(?:[\w.-]+\/)+(?:[\w.*-]+)|\b(?:README(?:\.md)?|AGENTS\.md|package\.json|tsconfig(?:\.[\w.-]+)?\.json)\b|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json|ya?ml|toml)\b/g,
    ) ?? [];
  const pathCount = new Set(paths.map((path) => path.trim())).size;
  const broadScope =
    /\b(?:all|every|entire|across|repository-wide|codebase|multiple packages?|each)\b/i.test(value);
  const durableWorkflow =
    /\b(?:migrat\w*|refactor\w*|audit\w*|investigat\w*|pull request|pr green|ci|resume|long[- ]running)\b/i.test(
      value,
    );
  const externalWait =
    /\b(?:wait|poll|review feedback|required checks?|github|pull request|\bpr\b|deploy)\b/i.test(
      value,
    );
  const multipleSteps =
    actionCount > 1 || /\b(?:and then|then|followed by|after that)\b|[;,]/i.test(value);
  const localized =
    pathCount === 1 ||
    /\b(?:typo|wording|copy|comment|single file|one file|localized|localised)\b/i.test(value);
  const score =
    actionCount +
    Math.min(pathCount, 3) +
    (broadScope ? 3 : 0) +
    (durableWorkflow ? 4 : 0) +
    (externalWait ? 4 : 0) +
    (multipleSteps ? 2 : 0);
  return {
    bypass:
      localized &&
      actionCount <= 1 &&
      pathCount <= 1 &&
      !broadScope &&
      !durableWorkflow &&
      !externalWait &&
      !multipleSteps,
    score,
    signals: {
      actionCount,
      pathCount,
      localized,
      broadScope,
      durableWorkflow,
      externalWait,
      multipleSteps,
    },
  };
}

export function shouldBypassGraph(task: string): boolean {
  return assessTaskShape(task).bypass;
}

export type ExecutableFinishLine =
  "local_verified" | "committed" | "pushed" | "pr_open" | "pr_green";

export async function prepareFinishLine(
  task: string,
  cwd: string,
  requested?: ExecutableFinishLine,
): Promise<ExecutableFinishLine> {
  if (
    /\b(merge|deploy|force[- ]?push)\b|\brebase\b.{0,40}\b(?:published|remote)\s+branch\b/i.test(
      task,
    )
  )
    throw new Error(
      "Graphcraft supports local_verified, committed, pushed, pr_open, and pr_green finish lines. It will not infer force-push, published-branch rebase, merge, or deployment authority.",
    );
  const inferred = inferFinishLine(task);
  if (["pushed", "pr_open", "pr_green"].includes(inferred) && requested && requested !== inferred)
    throw new Error(
      `The requested task includes a ${inferred} outcome, so Graphcraft will not silently narrow it to ${requested}.`,
    );
  const finishLine = requested ?? inferred;
  if (["pushed", "pr_open", "pr_green"].includes(finishLine))
    await assertGitHubPushCapability({ cwd });
  return finishLine;
}

function probeView(item: ProbePlan["items"][number]): Record<string, unknown> {
  const probe = item.probe;
  return {
    id: probe.id,
    purpose: item.purpose,
    source: item.source,
    kind: probe.kind,
    ...(probe.kind === "command"
      ? {
          command: [probe.command, ...probe.args].join(" "),
          cwd: probe.cwd ?? ".",
          timeoutMs: probe.timeoutMs,
          platforms: probe.platforms ?? ["all"],
        }
      : {}),
    ...(probe.kind === "file" ? { path: probe.path } : {}),
    ...(probe.kind === "git_diff" ? { baseSha: probe.baseSha } : {}),
    ...(probe.kind === "repository_inventory" ? { paths: probe.paths, terms: probe.terms } : {}),
    ...(probe.kind === "github_snapshot"
      ? {
          pullRequest: probe.pullRequest,
          expectedState: probe.expectedState,
          requiredChecks: probe.requiredChecks,
          reviewThreads: probe.reviewThreads,
        }
      : {}),
  };
}

export function contractView(
  contract: RunContract,
  graph?: Graph,
  inputProbePlan?: ProbePlan,
): Record<string, unknown> {
  const hasGraphProbes = graph?.nodes.some(
    (node) => node.progressProbes.length > 0 || node.completionProbes.length > 0,
  );
  const probePlan =
    inputProbePlan ?? (graph && hasGraphProbes ? probePlanFromGraph(graph) : undefined);
  const completionProbes = probePlan?.items
    .filter(({ phase }) => phase === "completion")
    .map((item) => probeView(item));
  const progressProbes = probePlan?.items
    .filter(({ phase }) => phase === "progress")
    .map((item) => probeView(item));
  return {
    runId: contract.runId,
    outcome: contract.outcome,
    finishLine: contract.finishLine.kind,
    repository: contract.repository.root,
    scope: contract.scope,
    permissions: contract.permissions,
    acceptanceAnchors: contract.acceptanceAnchors.map(({ id, description, owner }) => ({
      id,
      description,
      owner,
    })),
    ...(graph ? { planShape: graphPlanShape(graph) } : {}),
    ...(progressProbes ? { progressProbes } : {}),
    ...(completionProbes ? { completionProbes } : {}),
    recovery: "Checkpoint after every event; accepted nodes are never repeated",
  };
}

export function stateView(state: RunState, contract: RunContract): Record<string, unknown> {
  return {
    runId: state.runId,
    task: contract.task,
    finishLine: contract.finishLine.kind,
    status: state.status,
    currentNode: state.currentNodeId,
    runningNodes: Object.entries(state.nodes)
      .filter(([, nodeState]) => nodeState.status === "running")
      .map(([nodeId]) => nodeId),
    nodes: state.nodes,
    latestProgressEvidence: state.latestProgressEvidence,
    progressTrajectory: state.progressTrajectory.slice(-10).map((entry) => ({
      nodeId: entry.nodeId,
      classification: entry.classification,
      strategy: entry.strategy,
      vector: entry.current.vector,
      recordedAt: entry.recordedAt,
    })),
    progressDecision: state.progressDecision,
    controlDecisions: state.controlDecisions,
    pendingDecision: state.pendingDecision,
    tokens: state.tokens,
    tokenReport: tokenCostReport(state.tokenLedger),
    optimizationDecisions: state.optimizationDecisions,
    sideEffects: state.sideEffects,
    waits: state.waits,
    stopReason: state.stopReason,
    updatedAt: state.updatedAt,
  };
}

function line(label: string, value: string): string {
  return `${label.padEnd(14)}${value}`;
}

export function recoveryHint(message: string): string | undefined {
  if (/matched (?:0|[2-9]\d*) runs|No Graphcraft runs/i.test(message))
    return "Run `graphcraft runs` to list stable run IDs, or start one with `graphcraft run`.";
  if (/Run event log has .* at byte \d+/i.test(message))
    return "Preserve the run's `.graphcraft` files and restore `events.jsonl` only from a known-good copy; Graphcraft left the corrupt bytes unchanged.";
  if (/auth|login|credential|permission|GitHub .*preflight/i.test(message))
    return "Run `graphcraft doctor`, then authenticate the reported host or GitHub CLI.";
  if (/future|unsupported.*(?:schema|storage|format)|storage version/i.test(message))
    return "Update Graphcraft before reopening this run; its durable files were left unchanged.";
  if (/probe|completion check|held.out/i.test(message))
    return "Inspect the approved checks with `graphcraft probes [run]` before changing them.";
  if (/worktree|run lock|locked|supervisor/i.test(message))
    return "Inspect ownership with `graphcraft status [run]` and `graphcraft supervisors [run]`.";
  if (/stale|moved|diverg|conflict/i.test(message))
    return "Inspect exact local and remote evidence with `graphcraft inspect [run]`; Graphcraft will not overwrite it.";
  return undefined;
}

export function renderRunStatus(state: RunState, contract: RunContract, graph: Graph): string {
  const accepted = Object.entries(state.nodes)
    .filter(([, value]) => value.status === "accepted")
    .map(([id]) => id);
  const running = Object.entries(state.nodes)
    .filter(([, value]) => value.status === "running")
    .map(([id]) => id);
  const ready = graph.nodes
    .filter(
      (node) =>
        state.nodes[node.id]?.status === "pending" &&
        node.dependsOn.every((id) => state.nodes[id]?.status === "accepted"),
    )
    .map(({ id }) => id);
  const tokenReport = tokenCostReport(state.tokenLedger);
  const nextAction = state.pendingDecision
    ? `Resolve the pending decision with graphcraft decide ${state.runId.slice(0, 8)} ...`
    : state.status === "awaiting_approval"
      ? `graphcraft resume ${state.runId.slice(0, 8)} --yes`
      : state.status === "paused" || state.status === "waiting"
        ? `graphcraft resume ${state.runId.slice(0, 8)} --background`
        : state.status === "completed"
          ? `graphcraft view ${state.runId.slice(0, 8)}`
          : state.stopReason
            ? (recoveryHint(state.stopReason) ??
              `graphcraft inspect ${state.runId.slice(0, 8)} to review the blocker`)
            : `graphcraft inspect ${state.runId.slice(0, 8)}`;
  const evidence = state.latestProgressEvidence.slice(-3);
  return [
    line("Run", state.runId),
    line("Outcome", contract.outcome),
    line("Finish line", contract.finishLine.kind),
    line("Status", state.status),
    line("Accepted", accepted.join(", ") || "none"),
    line("Ready", ready.join(", ") || "none"),
    line("Running", running.join(", ") || "none"),
    line("Evidence", evidence[0] ?? "none"),
    ...evidence.slice(1).map((item) => line("", item)),
    ...(state.stopReason ? [line("Blocker", state.stopReason)] : []),
    line(
      "Tokens",
      `cached ${tokenReport.totals.cachedInput}, uncached ${tokenReport.totals.uncachedInput}, output ${tokenReport.totals.output}, reasoning ${tokenReport.totals.reasoning}, total ${tokenReport.totals.total}`,
    ),
    line("Next", nextAction),
  ].join("\n");
}

export function renderRunInspection(input: {
  state: RunState;
  contract: RunContract;
  graph: Graph;
  graphHistory: Awaited<ReturnType<RunStore["loadGraphHistory"]>>;
  artifactInventory: Awaited<ReturnType<RunStore["loadArtifactInventory"]>>;
}): string {
  return [
    renderRunStatus(input.state, input.contract, input.graph),
    "",
    "Plan",
    ...input.graph.nodes.map((node) => {
      const status = input.state.nodes[node.id]?.status ?? node.status;
      return `  [${status}] ${node.id} · ${node.kind} · depends on ${node.dependsOn.join(", ") || "nothing"} · ${node.sideEffectClass}`;
    }),
    "",
    `Governance    ${input.graph.controlEdges.length} control edges; ${input.contract.acceptanceAnchors.length} anchors`,
    `Revisions     ${input.graph.revision}; ${input.graphHistory.length} amendments`,
    `Artifacts     ${input.artifactInventory.storedBytes}/${input.artifactInventory.sourceBytes} bytes stored; ${input.artifactInventory.omittedBytes} omitted across ${input.artifactInventory.entries.length} entries`,
    `Durable files ${join(input.contract.repository.root, ".graphcraft", "runs", input.state.runId)}`,
  ].join("\n");
}

export interface RunListEntry {
  runId: string;
  task: string;
  finishLine: string;
  status: RunState["status"];
  updatedAt: string;
}

export async function loadRunList(cwd: string): Promise<RunListEntry[]> {
  const repository = await discoverRepository(cwd);
  const runIds = await listRunIds(repository.root);
  const entries = await Promise.all(
    runIds.map(async (runId) => {
      const store = new RunStore(repository.root, runId);
      const [contract, state] = await Promise.all([store.loadContract(), store.loadState()]);
      return {
        runId,
        task: contract.task,
        finishLine: contract.finishLine.kind,
        status: state.status,
        updatedAt: state.updatedAt,
      } satisfies RunListEntry;
    }),
  );
  return entries.sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId),
  );
}

export function renderRunList(entries: RunListEntry[]): string {
  if (entries.length === 0) return "No Graphcraft runs exist in this repository.";
  return [
    "RUN       STATUS              FINISH LINE     UPDATED                   TASK",
    ...entries.map(
      (entry) =>
        `${entry.runId.slice(0, 8).padEnd(10)}${entry.status.padEnd(20)}${entry.finishLine.padEnd(16)}${entry.updatedAt.padEnd(26)}${entry.task}`,
    ),
    "",
    "Use the displayed run prefix with status, inspect, trace, view, resume, pause, or stop.",
  ].join("\n");
}

export async function supervisorView(repositoryRoot: string, runId: string) {
  try {
    return (await latestSupervisor(repositoryRoot, runId)) ?? null;
  } catch (error) {
    return {
      health: "invalid",
      error: `Supervisor projection is unreadable: ${(error as Error).message}`,
    };
  }
}

export function renderContract(contract: RunContract, graph: Graph, probePlan?: ProbePlan): string {
  const view = contractView(contract, graph, probePlan);
  return [
    `Run            ${contract.runId}`,
    `Outcome        ${view.outcome}`,
    `Finish line    ${view.finishLine}`,
    `Repository     ${view.repository}`,
    `Permissions    ${contract.permissions.join(", ")}`,
    `Progress       ${(view.progressProbes as Array<{ id: string }> | undefined)?.map(({ id }) => id).join(", ") ?? "none"}`,
    `Completion     ${(view.completionProbes as Array<{ id: string }> | undefined)?.map(({ id }) => id).join(", ") ?? "none"}`,
    `Recovery       ${view.recovery}`,
    `Plan           ${view.planShape}`,
  ].join("\n");
}

export async function askForApproval(
  contract: RunContract,
  graph: Graph,
  probePlan?: ProbePlan,
): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      `${renderContract(contract, graph, probePlan)}\n\nStart? [Y/n] `,
    );
    return !/^n(?:o)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export function consoleObserver(json = false): RunObserver {
  return (event) => {
    const persisted = redactValue(event) as RunObserverEvent;
    if (json) console.log(JSON.stringify(persisted));
    else console.log(`[${persisted.type}] ${redactString(persisted.message)}`);
  };
}

export async function storeFor(cwd: string, runReference?: string): Promise<RunStore> {
  const repository = await discoverRepository(cwd);
  const runId = await resolveRunId(repository.root, runReference);
  return new RunStore(repository.root, runId);
}

export interface McpActionInput {
  action:
    | "run"
    | "status"
    | "inspect"
    | "resume"
    | "pause"
    | "stop"
    | "trace"
    | "probes"
    | "amend"
    | "decide"
    | "doctor";
  task?: string | undefined;
  run?: string | undefined;
  repository?: string | undefined;
  host?: HostName | undefined;
  approve?: boolean | undefined;
  finishLine?: ExecutableFinishLine | undefined;
  force?: boolean | undefined;
  maxWorkers?: 1 | 2 | undefined;
  probePlan?: ProbePlan | undefined;
  amendment?: GraphAmendment | undefined;
  controlSource?: string | undefined;
  controlTarget?: string | undefined;
  controlVerdict?: "approve" | "veto" | undefined;
  rationale?: string | undefined;
  evidence?: string[] | undefined;
  replaces?: string | undefined;
}

async function performAction(input: McpActionInput): Promise<Record<string, unknown>> {
  const cwd = input.repository ?? process.cwd();
  if (input.action === "doctor") {
    const [codex, claude, github] = await Promise.all([
      new CodexAdapter().probe(),
      new ClaudeAdapter().probe(),
      probeGitHub({ cwd }),
    ]);
    let installation: Record<string, unknown>;
    try {
      installation = await installationDiagnostics();
    } catch (error) {
      installation = { error: (error as Error).message };
    }
    let repository: Record<string, unknown>;
    try {
      repository = { ...(await discoverRepository(cwd)) };
    } catch (error) {
      repository = { error: (error as Error).message };
    }
    const nodeVersion = process.versions.node;
    const parsedNodeVersion = parseVersion(nodeVersion);
    return {
      node: process.version,
      graphcraft: {
        version: GRAPHCRAFT_VERSION,
        compatibility: {
          node: {
            status:
              parsedNodeVersion && compareVersion(parsedNodeVersion, [22, 0, 0]) >= 0
                ? "compatible"
                : "unsupported",
            installedVersion: nodeVersion,
            minimumVersion: "22.0.0",
          },
          codex: hostCompatibilityDiagnostic("codex", codex),
          claude: hostCompatibilityDiagnostic("claude", claude),
        },
        installation,
      },
      codex,
      claude,
      github,
      repository,
    };
  }

  if (input.action === "run") {
    if (!input.task) throw new Error("task is required for action=run");
    const taskShape = assessTaskShape(input.task);
    if (!input.force && taskShape.bypass) {
      return {
        bypassed: true,
        reason: "Graphcraft is not needed for this localized task; use force=true to override",
        taskShape,
      };
    }
    const finishLine = await prepareFinishLine(input.task, cwd, input.finishLine);
    const adapter = createAdapter(input.host ?? "codex");
    const created = await createRun(input.task, {
      cwd,
      planner: adapter,
      finishLine,
    });
    if (!input.approve)
      return {
        approvalRequired: true,
        contract: contractView(created.contract, created.graph, created.probePlan),
      };
    const state = await executeRun({
      store: created.store,
      adapter,
      approve: true,
      maxWorkers: input.maxWorkers ?? 1,
    });
    return stateView(state, created.contract);
  }

  const store = await storeFor(cwd, input.run);
  const [contract, graph, state, probePlan, heldOutProbePlan] = await Promise.all([
    store.loadContract(),
    store.loadGraph(),
    store.loadState(),
    store.loadProbePlan(),
    store.loadHeldOutProbePlan(),
  ]);
  if (input.action === "status")
    return {
      ...stateView(state, contract),
      supervisor: await supervisorView(store.repositoryRoot, store.runId),
    };
  if (input.action === "inspect")
    return {
      contract,
      graph,
      probePlan,
      heldOutProof: {
        digest: heldOutProbePlan.digest,
        probes: heldOutProbePlan.probes.map(({ probe, integrity }) => ({
          id: probe.id,
          integrityProtected: integrity.length > 0,
        })),
      },
      state,
      supervisor: await supervisorView(store.repositoryRoot, store.runId),
      tokenReport: tokenCostReport(state.tokenLedger),
      graphHistory: await store.loadGraphHistory(),
      artifactInventory: await store.loadArtifactInventory(),
      contextReceipts: (await store.loadEvents())
        .filter(({ type }) => type === "context.selected")
        .map(({ data }) => ContextSelectionReceiptSchema.parse(data.receipt)),
    };
  if (input.action === "trace") return { events: await store.loadEvents() };
  if (input.action === "probes") {
    if (!input.probePlan) return { probePlan };
    return await configureRunProbes(store, input.probePlan);
  }
  if (input.action === "amend") {
    if (!input.amendment) throw new Error("amendment is required for action=amend");
    const result = await amendRunGraph(
      store,
      input.amendment,
      input.approve === true ? "user" : "runtime",
    );
    return { ...result, graphHistory: await store.loadGraphHistory() };
  }
  if (input.action === "decide") {
    if (!input.controlSource || !input.controlTarget || !input.controlVerdict || !input.rationale)
      throw new Error(
        "controlSource, controlTarget, controlVerdict, and rationale are required for action=decide",
      );
    return stateView(
      await decideRunControl(store, {
        sourceId: input.controlSource,
        targetId: input.controlTarget,
        verdict: input.controlVerdict,
        rationale: input.rationale,
        ...(input.evidence ? { evidence: input.evidence } : {}),
        ...(input.replaces ? { replaces: input.replaces } : {}),
      }),
      contract,
    );
  }
  if (input.action === "stop") return stateView(await requestRunControl(store, "stop"), contract);
  if (input.action === "pause") return stateView(await requestRunControl(store, "pause"), contract);
  if (input.action === "resume") {
    if (state.status === "awaiting_approval" && !input.approve) {
      return { approvalRequired: true, contract: contractView(contract, graph, probePlan) };
    }
    if (
      state.status === "awaiting_approval" &&
      ["pushed", "pr_open", "pr_green"].includes(contract.finishLine.kind)
    )
      await assertGitHubPushCapability({ cwd: store.repositoryRoot });
    const resumed = await executeRun({
      store,
      adapter: createAdapter(input.host ?? "codex"),
      approve: input.approve ?? false,
      maxWorkers: input.maxWorkers ?? 1,
    });
    return stateView(resumed, contract);
  }
  throw new Error(`Unsupported action: ${input.action}`);
}

export async function handleAction(input: McpActionInput): Promise<Record<string, unknown>> {
  try {
    return redactValue(await performAction(input)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(redactString(error instanceof Error ? error.message : String(error)));
  }
}
