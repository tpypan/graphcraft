import { appendFile, lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertRepositoryFile,
  assertRepositoryPath,
  isRepositoryFileError,
  readRepositoryTextFile,
  runProcess,
} from "@graphcraft/probes";
import {
  SideEffectClaimSchema,
  contentHash,
  type CanonicalHashAlgorithm,
  type RepositoryIdentity,
  type RepositoryPlanningEvidence,
  type RunContract,
  type SideEffectClaim,
  type SideEffectJournalEntry,
} from "@graphcraft/core";
import {
  crossSideEffectBoundary,
  type SideEffectBoundary,
  type SideEffectReconciliation,
} from "./side-effect.ts";
import { parseRunWorkspace, type RunWorkspace } from "./workspace.ts";

export type { RunWorkspace } from "./workspace.ts";

async function gitRaw(
  repositoryPath: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const result = await runProcess("git", args, {
    cwd: repositoryPath,
    timeoutMs: 120_000,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

async function git(repositoryPath: string, args: string[], signal?: AbortSignal): Promise<string> {
  return (await gitRaw(repositoryPath, args, signal)).trim();
}

async function readUtf8(path: string, signal?: AbortSignal): Promise<string> {
  return await readFile(path, {
    encoding: "utf8",
    ...(signal ? { signal } : {}),
  });
}

export async function discoverRepository(
  cwd: string,
  signal?: AbortSignal,
): Promise<RepositoryIdentity> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"], signal);
  const baseSha = await git(root, ["rev-parse", "HEAD"], signal);
  const baseRef =
    (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal).catch(() => {
      signal?.throwIfAborted();
      return "HEAD";
    })) || "HEAD";
  const remote = await git(root, ["remote", "get-url", "origin"], signal).catch(() => {
    signal?.throwIfAborted();
    return undefined;
  });
  await ensureGraphcraftIgnored(root, signal);
  return { root, baseRef, baseSha, ...(remote ? { remote } : {}) };
}

const planningEvidenceNames = new Set([
  "AGENTS.md",
  "Cargo.toml",
  "Makefile",
  "README.md",
  "go.mod",
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "tsconfig.json",
]);

const planningSearchStopWords = new Set([
  "across",
  "adapter",
  "adapters",
  "add",
  "and",
  "audit",
  "changing",
  "code",
  "every",
  "file",
  "files",
  "fix",
  "for",
  "from",
  "identify",
  "implementation",
  "into",
  "migrate",
  "package",
  "path",
  "paths",
  "refactor",
  "repository",
  "results",
  "shared",
  "that",
  "the",
  "their",
  "this",
  "verify",
  "without",
]);

function planningSearchTerms(task: string): string[] {
  const taskTokens = task.match(/[A-Za-z0-9]+/g) ?? [];
  const identifiers = taskTokens
    .filter((word) => /[a-z][A-Z]/.test(word) || /^[A-Z0-9]{2,}$/.test(word))
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 3 && !planningSearchStopWords.has(word));
  return [
    ...new Set([
      ...identifiers,
      ...(
        task
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .match(/[a-z0-9]+/g) ?? []
      )
        .filter((word) => word.length >= 4 && !planningSearchStopWords.has(word))
        .map((word) => {
          if (word.length >= 8 && word.endsWith("ing")) return word.slice(0, -3);
          if (word.length >= 8 && word.endsWith("ed")) return word.slice(0, -2);
          return word.length >= 8 ? word.slice(0, 6) : word;
        }),
    ]),
  ].slice(0, 12);
}

function taskSnippet(content: string, terms: string[], maximumCharacters: number): string {
  const lines = content.split("\n");
  const matchingLines = lines.flatMap((line, index) =>
    terms.some((term) => line.toLowerCase().includes(term)) ? [index] : [],
  );
  const ranges: Array<[number, number]> = [];
  for (const index of matchingLines.slice(0, 8)) {
    const start = Math.max(0, index - 6);
    const end = Math.min(lines.length, index + 7);
    const previous = ranges.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  }
  const snippet = ranges
    .map(([start, end]) => `[lines ${start + 1}-${end}]\n${lines.slice(start, end).join("\n")}`)
    .join("\n\n");
  return snippet.slice(0, maximumCharacters);
}

interface TrackedPath {
  mode: string;
  path: string;
}

const TRACKED_PATH_VALIDATION_CONCURRENCY = 32;

async function trackedRepositoryPaths(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<TrackedPath[]> {
  const records = await gitRaw(repositoryRoot, ["ls-files", "--stage", "-z"], signal);
  return records
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\t");
      const metadata = separator === -1 ? [] : record.slice(0, separator).split(" ");
      const path = separator === -1 ? "" : record.slice(separator + 1);
      if (!metadata[0] || !path) throw new Error("Git returned an invalid tracked-path inventory");
      return { mode: metadata[0], path };
    });
}

async function plannerVisibleTrackedPaths(
  repositoryRoot: string,
  tracked: TrackedPath[],
  signal?: AbortSignal,
): Promise<TrackedPath[]> {
  const distinct = [...new Map(tracked.map((entry) => [entry.path, entry])).values()];
  const visible: TrackedPath[] = [];
  for (let index = 0; index < distinct.length; index += TRACKED_PATH_VALIDATION_CONCURRENCY) {
    signal?.throwIfAborted();
    const batch = await Promise.all(
      distinct
        .slice(index, index + TRACKED_PATH_VALIDATION_CONCURRENCY)
        .map(async (entry): Promise<TrackedPath | undefined> => {
          try {
            if (entry.mode === "120000" || entry.mode === "160000")
              await assertRepositoryPath(repositoryRoot, entry.path, signal);
            else await assertRepositoryFile(repositoryRoot, entry.path, signal);
            return entry;
          } catch (error) {
            signal?.throwIfAborted();
            if (isRepositoryFileError(error, "missing")) return undefined;
            throw error;
          }
        }),
    );
    visible.push(...batch.filter((entry): entry is TrackedPath => entry !== undefined));
  }
  return visible;
}

export async function discoverPlanningEvidence(
  repositoryRoot: string,
  task: string,
  signal?: AbortSignal,
): Promise<RepositoryPlanningEvidence> {
  const tracked = await plannerVisibleTrackedPaths(
    repositoryRoot,
    await trackedRepositoryPaths(repositoryRoot, signal),
    signal,
  );
  const trackedPaths = tracked.map(({ path }) => path);
  const trackedPathSet = new Set(trackedPaths);
  const files: RepositoryPlanningEvidence["files"] = [];
  let remainingCharacters = 24_000;
  const searchTerms = planningSearchTerms(task);
  const searchPattern = searchTerms.join("|");
  const matchedPaths = searchPattern
    ? (
        await git(
          repositoryRoot,
          ["grep", "-l", "-I", "-i", "-E", searchPattern, "--"],
          signal,
        ).catch(() => {
          signal?.throwIfAborted();
          return "";
        })
      )
        .split("\n")
        .filter(
          (path) =>
            path.length > 0 &&
            trackedPathSet.has(path) &&
            !path.startsWith("dist/") &&
            !path.endsWith(".map") &&
            !path.endsWith(".lock"),
        )
    : [];
  const taskMatches = await Promise.all(
    matchedPaths.map(async (path) => {
      signal?.throwIfAborted();
      const content = await readRepositoryTextFile(repositoryRoot, path, {
        ...(signal ? { signal } : {}),
      });
      const normalized = content.toLowerCase();
      const score = searchTerms.filter((term) => normalized.includes(term)).length;
      const pathScore = searchTerms.filter((term) => path.toLowerCase().includes(term)).length;
      const source = /(?:^|\/)(?:src|test|tests)\//.test(path) ? 1 : 0;
      return { path, content, score, pathScore, source };
    }),
  );
  signal?.throwIfAborted();
  taskMatches.sort(
    (left, right) =>
      right.source - left.source ||
      right.pathScore - left.pathScore ||
      right.score - left.score ||
      left.path.localeCompare(right.path),
  );
  for (const { path, content } of taskMatches.slice(0, 3)) {
    signal?.throwIfAborted();
    const selected = taskSnippet(content, searchTerms, Math.min(3_000, remainingCharacters));
    if (!selected) continue;
    files.push({ path, content: selected, truncated: selected.length < content.length });
    remainingCharacters -= selected.length;
  }

  const baselinePaths = trackedPaths
    .filter((path) => planningEvidenceNames.has(path.split("/").at(-1) ?? ""))
    .sort((left, right) => {
      const leftDepth = left.split("/").length;
      const rightDepth = right.split("/").length;
      return leftDepth - rightDepth || left.localeCompare(right);
    });
  for (const path of baselinePaths) {
    signal?.throwIfAborted();
    if (remainingCharacters <= 0 || files.length >= 7) break;
    if (files.some((file) => file.path === path)) continue;
    const content = await readRepositoryTextFile(repositoryRoot, path, {
      ...(signal ? { signal } : {}),
    });
    const limit = Math.min(2_000, remainingCharacters);
    const selected = content.slice(0, limit);
    files.push({ path, content: selected, truncated: selected.length < content.length });
    remainingCharacters -= selected.length;
  }
  const trackedPathLimit = 2_000;
  return {
    contentTrust: "untrusted_repository",
    trackedPathCount: trackedPaths.length,
    trackedPaths: trackedPaths.slice(0, trackedPathLimit),
    trackedPathsTruncated: trackedPaths.length > trackedPathLimit,
    files,
  };
}

async function ensureGraphcraftIgnored(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const rawExcludePath = await git(
    repositoryRoot,
    ["rev-parse", "--git-path", "info/exclude"],
    signal,
  );
  const excludePath = isAbsolute(rawExcludePath)
    ? rawExcludePath
    : resolve(repositoryRoot, rawExcludePath);
  let content = "";
  try {
    content = await readUtf8(excludePath, signal);
  } catch {
    signal?.throwIfAborted();
    await mkdir(dirname(excludePath), { recursive: true });
  }
  signal?.throwIfAborted();
  if (!content.split("\n").includes(".graphcraft/"))
    await appendFile(excludePath, "\n.graphcraft/\n", {
      encoding: "utf8",
      ...(signal ? { signal } : {}),
    });
  signal?.throwIfAborted();
}

export type RunWorkspaceCreationBoundary =
  "after_parent_prepare" | "after_reconciliation" | "before_worktree_add" | "after_worktree_add";

export interface RunWorkspaceCreationOptions {
  signal?: AbortSignal;
  boundary?: (point: RunWorkspaceCreationBoundary) => void | Promise<void>;
}

export class RunWorkspaceReconciliationError extends Error {
  constructor(
    readonly workspacePath: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(
      `Graphcraft found unsafe or ambiguous worktree state at ${workspacePath}: ${detail}. Existing Git state was preserved; resolve it before resuming`,
      options,
    );
    this.name = "RunWorkspaceReconciliationError";
  }
}

function slug(task: string): string {
  return (
    task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "run"
  );
}

export function expectedRunWorkspace(contract: RunContract): Pick<RunWorkspace, "path" | "branch"> {
  const branch = `graphcraft/${contract.runId.slice(0, 8)}-${slug(contract.task)}`;
  const parent = join(
    dirname(contract.repository.root),
    `.${basename(contract.repository.root)}-graphcraft-worktrees`,
  );
  return { branch, path: join(parent, contract.runId) };
}

interface WorktreeRegistration {
  path: string;
  head?: string;
  branch?: string;
}

type ReconciledWorkspaceCreationState =
  | { status: "absent" }
  | { status: "branch_only" }
  | { status: "ready"; identity: DirectoryIdentity };

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

function directoryIdentity(
  stats: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">,
): DirectoryIdentity {
  return { dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  if (left.ino !== 0n && right.ino !== 0n) return left.dev === right.dev && left.ino === right.ino;
  return left.dev === right.dev && left.birthtimeNs === right.birthtimeNs;
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  detail: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let stats: BigIntStats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error) {
    signal?.throwIfAborted();
    throw workspaceStateError(path, `${detail} could not be re-inspected`, error);
  }
  signal?.throwIfAborted();
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw workspaceStateError(path, `${detail} is no longer a plain directory`);
  if (!sameDirectoryIdentity(expected, directoryIdentity(stats)))
    throw workspaceStateError(path, `${detail} identity changed during validation`);
}

function comparablePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

async function canonicalComparablePath(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  try {
    const canonical = await realpath(path);
    signal?.throwIfAborted();
    return comparablePath(canonical);
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const canonicalParent = await realpath(dirname(path));
    signal?.throwIfAborted();
    return comparablePath(join(canonicalParent, basename(path)));
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return comparablePath(path);
  }
}

function parseWorktreeRegistrations(output: string): WorktreeRegistration[] {
  const registrations: WorktreeRegistration[] = [];
  let current: WorktreeRegistration | undefined;
  for (const field of output.split("\0")) {
    if (field.length === 0) {
      if (current) registrations.push(current);
      current = undefined;
      continue;
    }
    const separator = field.indexOf(" ");
    const name = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? "" : field.slice(separator + 1);
    if (name === "worktree") {
      if (current) throw new Error("Git returned overlapping worktree records");
      if (!value) throw new Error("Git returned a worktree record without a path");
      current = { path: value };
      continue;
    }
    if (!current) throw new Error("Git returned a worktree field before its path");
    if (name === "HEAD") current.head = value;
    if (name === "branch") current.branch = value;
  }
  if (current) registrations.push(current);
  return registrations;
}

async function branchSha(
  repositoryPath: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const ref = `refs/heads/${branch}`;
  const output = await gitRaw(
    repositoryPath,
    ["for-each-ref", "--format=%(refname)%00%(objectname)", ref],
    signal,
  );
  const matches = output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\0"))
    .filter(([candidate]) => candidate === ref);
  if (matches.length > 1 || matches.some(([, sha]) => !sha))
    throw new Error(`Git returned an ambiguous ref inventory for ${ref}`);
  return matches[0]?.[1];
}

async function canonicalGitCommonDirectory(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const value = await git(repositoryPath, ["rev-parse", "--git-common-dir"], signal);
  signal?.throwIfAborted();
  const path = isAbsolute(value) ? value : resolve(repositoryPath, value);
  const canonical = await realpath(path);
  signal?.throwIfAborted();
  return comparablePath(canonical);
}

function workspaceStateError(
  path: string,
  detail: string,
  cause?: unknown,
): RunWorkspaceReconciliationError {
  return new RunWorkspaceReconciliationError(path, detail, cause ? { cause } : undefined);
}

interface DurableWorkspaceHeadAuthorization {
  confirmedHead: string;
  pendingCommit?: SideEffectClaim;
}

function durableWorkspaceHeadAuthorization(
  contract: RunContract,
  sideEffects: readonly SideEffectJournalEntry[],
): DurableWorkspaceHeadAuthorization {
  const expectedWorkspace = expectedRunWorkspace(contract);
  let confirmedHead = contract.repository.baseSha;
  let pendingCommit: SideEffectClaim | undefined;
  for (const entry of sideEffects) {
    if (entry.claim.kind !== "git_commit") continue;
    if (pendingCommit)
      throw workspaceStateError(
        expectedWorkspace.path,
        "durable run state contains more than one unresolved commit authorization",
      );
    const claim = SideEffectClaimSchema.parse(entry.claim);
    const precondition = commitPrecondition(claim);
    if (
      claim.target !== expectedWorkspace.branch ||
      precondition.branch !== expectedWorkspace.branch ||
      precondition.expectedHead !== confirmedHead
    )
      throw workspaceStateError(
        expectedWorkspace.path,
        "durable commit authorization does not extend the last confirmed run HEAD",
      );
    if (entry.status === "confirmed") {
      const sha = entry.result?.sha;
      const branch = entry.result?.branch;
      if (
        typeof sha !== "string" ||
        !/^[a-f0-9]{40,64}$/u.test(sha) ||
        branch !== expectedWorkspace.branch
      )
        throw workspaceStateError(
          expectedWorkspace.path,
          "a confirmed durable commit has invalid result identity",
        );
      confirmedHead = sha;
    } else if (entry.status === "claimed") {
      pendingCommit = claim;
    }
  }
  return {
    confirmedHead,
    ...(pendingCommit ? { pendingCommit } : {}),
  };
}

async function matchesPendingCommitAuthorization(
  repositoryPath: string,
  head: string,
  authorization: DurableWorkspaceHeadAuthorization,
  signal?: AbortSignal,
): Promise<boolean> {
  const pending = authorization.pendingCommit;
  if (!pending) return false;
  const [commitLine, message] = await Promise.all([
    git(repositoryPath, ["rev-list", "--parents", "-n", "1", head], signal),
    git(repositoryPath, ["show", "-s", "--format=%B", head], signal),
  ]);
  const [commit, ...parents] = commitLine.split(" ");
  return (
    commit === head &&
    parents.length === 1 &&
    parents[0] === authorization.confirmedHead &&
    message.split("\n").includes(`Graphcraft-Action: ${pending.idempotencyKey}`)
  );
}

async function reconcileRunWorkspaceCreation(
  contract: RunContract,
  path: string,
  branch: string,
  signal?: AbortSignal,
): Promise<ReconciledWorkspaceCreationState> {
  signal?.throwIfAborted();
  let pathStats: BigIntStats | undefined;
  try {
    pathStats = await lstat(path, { bigint: true });
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw workspaceStateError(path, "the intended path could not be inspected", error);
  }
  signal?.throwIfAborted();

  let registrations: WorktreeRegistration[];
  let expectedBranchSha: string | undefined;
  try {
    [registrations, expectedBranchSha] = await Promise.all([
      gitRaw(contract.repository.root, ["worktree", "list", "--porcelain", "-z"], signal).then(
        parseWorktreeRegistrations,
      ),
      branchSha(contract.repository.root, branch, signal),
    ]);
  } catch (error) {
    signal?.throwIfAborted();
    throw workspaceStateError(path, "Git could not inventory the intended path and branch", error);
  }
  signal?.throwIfAborted();

  let targetPath: string;
  try {
    targetPath = await canonicalComparablePath(path, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw workspaceStateError(path, "the intended path identity could not be resolved", error);
  }
  const targetRegistrations = registrations.filter(
    (registration) => comparablePath(registration.path) === targetPath,
  );
  const expectedRef = `refs/heads/${branch}`;
  const branchRegistrations = registrations.filter(
    (registration) => registration.branch === expectedRef,
  );

  if (!pathStats && targetRegistrations.length === 0) {
    if (branchRegistrations.length > 0)
      throw workspaceStateError(path, "the intended branch is registered at another worktree");
    if (!expectedBranchSha) return { status: "absent" };
    if (expectedBranchSha === contract.repository.baseSha) return { status: "branch_only" };
    throw workspaceStateError(
      path,
      `the unregistered intended branch does not point to approved base ${contract.repository.baseSha}`,
    );
  }

  if (!pathStats)
    throw workspaceStateError(path, "Git registers the intended path, but the path is missing");
  if (!pathStats.isDirectory() || pathStats.isSymbolicLink())
    throw workspaceStateError(path, "the intended path is not a plain directory");
  const pathIdentity = directoryIdentity(pathStats);
  if (targetRegistrations.length !== 1)
    throw workspaceStateError(
      path,
      targetRegistrations.length === 0
        ? "the intended path exists without an exact Git worktree registration"
        : "Git reports duplicate registrations for the intended path",
    );
  if (branchRegistrations.length !== 1 || branchRegistrations[0] !== targetRegistrations[0])
    throw workspaceStateError(path, "the intended branch is missing or registered elsewhere");
  const registration = targetRegistrations[0]!;
  if (registration.branch !== expectedRef)
    throw workspaceStateError(path, "the registered worktree is on a different branch");
  if (registration.head !== contract.repository.baseSha)
    throw workspaceStateError(path, "the registered worktree HEAD differs from the approved base");
  if (expectedBranchSha !== contract.repository.baseSha)
    throw workspaceStateError(path, "the intended branch ref differs from the approved base");

  try {
    const topLevel = await git(path, ["rev-parse", "--show-toplevel"], signal);
    if ((await canonicalComparablePath(topLevel, signal)) !== targetPath)
      throw workspaceStateError(path, "the worktree top level differs from the intended path");
    const currentBranch = await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
    if (currentBranch !== branch)
      throw workspaceStateError(path, "the worktree checkout is on a different branch");
    const head = await git(path, ["rev-parse", "HEAD"], signal);
    if (head !== contract.repository.baseSha)
      throw workspaceStateError(path, "the worktree checkout differs from the approved base");
    const status = await gitRaw(
      path,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
      signal,
    );
    if (status.length > 0)
      throw workspaceStateError(
        path,
        "the worktree contains uncommitted or untracked changes, including ignored content",
      );
    const [sourceCommonDirectory, worktreeCommonDirectory] = await Promise.all([
      canonicalGitCommonDirectory(contract.repository.root, signal),
      canonicalGitCommonDirectory(path, signal),
    ]);
    if (sourceCommonDirectory !== worktreeCommonDirectory)
      throw workspaceStateError(path, "the worktree belongs to a different common Git directory");
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof RunWorkspaceReconciliationError) throw error;
    throw workspaceStateError(path, "the registered worktree could not be validated", error);
  }
  signal?.throwIfAborted();
  await assertDirectoryIdentity(path, pathIdentity, "the intended worktree directory", signal);
  return { status: "ready", identity: pathIdentity };
}

async function crossRunWorkspaceCreationBoundary(
  options: RunWorkspaceCreationOptions,
  point: RunWorkspaceCreationBoundary,
): Promise<void> {
  await options.boundary?.(point);
  options.signal?.throwIfAborted();
}

export async function reconcileRunWorkspace(
  contract: RunContract,
  inputWorkspace: unknown,
  sideEffects: readonly SideEffectJournalEntry[],
  signal?: AbortSignal,
): Promise<RunWorkspace> {
  const expected = expectedRunWorkspace(contract);
  const headAuthorization = durableWorkspaceHeadAuthorization(contract, sideEffects);
  const workspace = parseRunWorkspace(inputWorkspace);
  if (workspace.path !== expected.path)
    throw workspaceStateError(
      expected.path,
      "the durable workspace path differs from the contract-derived path",
    );
  if (workspace.branch !== expected.branch)
    throw workspaceStateError(
      expected.path,
      "the durable workspace branch differs from the contract-derived branch",
    );
  signal?.throwIfAborted();

  let pathStats: BigIntStats;
  let registrations: WorktreeRegistration[];
  let branchHead: string | undefined;
  try {
    [pathStats, registrations, branchHead] = await Promise.all([
      lstat(expected.path, { bigint: true }),
      gitRaw(contract.repository.root, ["worktree", "list", "--porcelain", "-z"], signal).then(
        parseWorktreeRegistrations,
      ),
      branchSha(contract.repository.root, expected.branch, signal),
    ]);
  } catch (error) {
    signal?.throwIfAborted();
    throw workspaceStateError(
      expected.path,
      "the durable workspace and its Git registration could not be inventoried",
      error,
    );
  }
  if (!pathStats.isDirectory() || pathStats.isSymbolicLink())
    throw workspaceStateError(expected.path, "the durable workspace path is not a plain directory");
  const pathIdentity = directoryIdentity(pathStats);

  let targetPath: string;
  try {
    targetPath = await canonicalComparablePath(expected.path, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw workspaceStateError(
      expected.path,
      "the durable workspace path identity could not be resolved",
      error,
    );
  }
  const expectedRef = `refs/heads/${expected.branch}`;
  const targetRegistrations = registrations.filter(
    (registration) => comparablePath(registration.path) === targetPath,
  );
  const branchRegistrations = registrations.filter(
    (registration) => registration.branch === expectedRef,
  );
  if (targetRegistrations.length !== 1)
    throw workspaceStateError(
      expected.path,
      targetRegistrations.length === 0
        ? "the durable workspace lacks an exact Git worktree registration"
        : "Git reports duplicate registrations for the durable workspace",
    );
  if (branchRegistrations.length !== 1 || branchRegistrations[0] !== targetRegistrations[0])
    throw workspaceStateError(
      expected.path,
      "the contract-derived branch is missing or registered at another worktree",
    );
  const registration = targetRegistrations[0]!;
  if (registration.branch !== expectedRef)
    throw workspaceStateError(expected.path, "the registered worktree is on a different branch");

  try {
    const [topLevel, currentBranch, head, sourceCommonDirectory, worktreeCommonDirectory] =
      await Promise.all([
        git(expected.path, ["rev-parse", "--show-toplevel"], signal),
        git(expected.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal),
        git(expected.path, ["rev-parse", "HEAD"], signal),
        canonicalGitCommonDirectory(contract.repository.root, signal),
        canonicalGitCommonDirectory(expected.path, signal),
      ]);
    if ((await canonicalComparablePath(topLevel, signal)) !== targetPath)
      throw workspaceStateError(
        expected.path,
        "the worktree top level differs from the contract-derived path",
      );
    if (currentBranch !== expected.branch)
      throw workspaceStateError(expected.path, "the worktree checkout is on a different branch");
    if (registration.head !== head)
      throw workspaceStateError(
        expected.path,
        "the Git worktree registration HEAD differs from the checkout HEAD",
      );
    if (branchHead !== head)
      throw workspaceStateError(
        expected.path,
        "the contract-derived branch ref differs from the checkout HEAD",
      );
    const mergeBase = await git(
      expected.path,
      ["merge-base", contract.repository.baseSha, head],
      signal,
    );
    if (mergeBase !== contract.repository.baseSha)
      throw workspaceStateError(
        expected.path,
        "the checkout HEAD does not descend from the approved base",
      );
    if (
      head !== headAuthorization.confirmedHead &&
      !(await matchesPendingCommitAuthorization(expected.path, head, headAuthorization, signal))
    )
      throw workspaceStateError(
        expected.path,
        `the checkout HEAD is not authorized by durable run state; expected ${headAuthorization.confirmedHead}`,
      );
    if (sourceCommonDirectory !== worktreeCommonDirectory)
      throw workspaceStateError(
        expected.path,
        "the worktree belongs to a different common Git directory",
      );
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof RunWorkspaceReconciliationError) throw error;
    throw workspaceStateError(expected.path, "the durable workspace could not be validated", error);
  }
  signal?.throwIfAborted();
  await assertDirectoryIdentity(
    expected.path,
    pathIdentity,
    "the durable workspace directory",
    signal,
  );
  return workspace;
}

export async function createRunWorkspace(
  contract: RunContract,
  options: RunWorkspaceCreationOptions = {},
): Promise<RunWorkspace> {
  const { path, branch } = expectedRunWorkspace(contract);
  const parent = dirname(path);
  options.signal?.throwIfAborted();
  await mkdir(parent, { recursive: true });
  options.signal?.throwIfAborted();
  let parentStats: BigIntStats;
  try {
    parentStats = await lstat(parent, { bigint: true });
  } catch (error) {
    options.signal?.throwIfAborted();
    throw workspaceStateError(path, "the worktree parent could not be inspected", error);
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink())
    throw workspaceStateError(path, "the worktree parent is not a plain directory");
  const parentIdentity = directoryIdentity(parentStats);
  await crossRunWorkspaceCreationBoundary(options, "after_parent_prepare");
  await assertDirectoryIdentity(
    parent,
    parentIdentity,
    "the worktree parent directory",
    options.signal,
  );

  const before = await reconcileRunWorkspaceCreation(contract, path, branch, options.signal);
  await crossRunWorkspaceCreationBoundary(options, "after_reconciliation");
  await assertDirectoryIdentity(
    parent,
    parentIdentity,
    "the worktree parent directory",
    options.signal,
  );
  if (before.status === "ready") {
    await assertDirectoryIdentity(
      path,
      before.identity,
      "the intended worktree directory",
      options.signal,
    );
    return { path, branch, created: false };
  }

  await crossRunWorkspaceCreationBoundary(options, "before_worktree_add");
  await assertDirectoryIdentity(
    parent,
    parentIdentity,
    "the worktree parent directory",
    options.signal,
  );
  const confirmedBefore = await reconcileRunWorkspaceCreation(
    contract,
    path,
    branch,
    options.signal,
  );
  if (confirmedBefore.status !== before.status)
    throw workspaceStateError(path, "the intended worktree state changed before creation");
  let commandError: unknown;
  try {
    await git(
      contract.repository.root,
      before.status === "branch_only"
        ? ["worktree", "add", path, branch]
        : ["worktree", "add", "-b", branch, path, contract.repository.baseSha],
      options.signal,
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    commandError = error;
  }
  let createdIdentity: DirectoryIdentity | undefined;
  try {
    const createdStats = await lstat(path, { bigint: true });
    if (createdStats.isDirectory() && !createdStats.isSymbolicLink())
      createdIdentity = directoryIdentity(createdStats);
  } catch (error) {
    options.signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw workspaceStateError(path, "the created worktree path could not be inspected", error);
  }
  await crossRunWorkspaceCreationBoundary(options, "after_worktree_add");
  await assertDirectoryIdentity(
    parent,
    parentIdentity,
    "the worktree parent directory",
    options.signal,
  );
  if (createdIdentity)
    await assertDirectoryIdentity(
      path,
      createdIdentity,
      "the created worktree directory",
      options.signal,
    );
  const after = await reconcileRunWorkspaceCreation(contract, path, branch, options.signal);
  if (after.status !== "ready")
    throw workspaceStateError(
      path,
      `worktree creation stopped in the safe ${after.status.replace("_", "-")} state`,
      commandError,
    );
  return { path, branch, created: true };
}

interface CommitPrecondition {
  expectedHead: string;
  branch: string;
  contentDigest: string;
}

async function commitContentDigest(
  repositoryPath: string,
  hashAlgorithm: CanonicalHashAlgorithm,
): Promise<string> {
  const [changedOutput, untrackedOutput] = await Promise.all([
    gitRaw(repositoryPath, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"]),
    gitRaw(repositoryPath, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const paths = [
    ...new Set(
      [changedOutput, untrackedOutput].flatMap((output) => output.split("\0").filter(Boolean)),
    ),
  ].sort();
  const changes = await Promise.all(
    paths.map(async (path) => {
      const absolutePath = join(repositoryPath, path);
      const stats = await lstat(absolutePath).catch(() => undefined);
      if (!stats) return { path, kind: "absent" };
      if (stats.isSymbolicLink())
        return { path, kind: "symlink", target: await readlink(absolutePath) };
      if (stats.isFile())
        return {
          path,
          kind: "file",
          executable: (stats.mode & 0o111) !== 0,
          contents: (await readFile(absolutePath)).toString("base64"),
        };
      return { path, kind: "other" };
    }),
  );
  return contentHash(changes, hashAlgorithm);
}

async function captureCommitPrecondition(
  workspace: RunWorkspace,
  hashAlgorithm: CanonicalHashAlgorithm,
): Promise<CommitPrecondition> {
  const [expectedHead, branch, contentDigest] = await Promise.all([
    git(workspace.path, ["rev-parse", "HEAD"]),
    git(workspace.path, ["branch", "--show-current"]),
    commitContentDigest(workspace.path, hashAlgorithm),
  ]);
  if (!branch) throw new Error("The Graphcraft worktree is not on a named branch");
  return { expectedHead, branch, contentDigest };
}

function commitPrecondition(claim: SideEffectClaim): CommitPrecondition {
  const expectedHead = claim.precondition.expectedHead;
  const branch = claim.precondition.branch;
  const contentDigest = claim.precondition.contentDigest;
  if (
    typeof expectedHead !== "string" ||
    typeof branch !== "string" ||
    typeof contentDigest !== "string"
  )
    throw new Error(`Commit claim ${claim.actionId} has an invalid precondition`);
  return { expectedHead, branch, contentDigest };
}

export async function createAtomicCommitClaim(
  workspace: RunWorkspace,
  runId: string,
  nodeId: string,
  hashAlgorithm: CanonicalHashAlgorithm,
): Promise<SideEffectClaim> {
  const precondition = await captureCommitPrecondition(workspace, hashAlgorithm);
  const actionId = contentHash(
    { schemaVersion: 1, runId, nodeId, kind: "git_commit" },
    hashAlgorithm,
  );
  return SideEffectClaimSchema.parse({
    schemaVersion: 1,
    actionId,
    idempotencyKey: `graphcraft-${actionId}`,
    nodeId,
    kind: "git_commit",
    target: precondition.branch,
    precondition,
    claimedAt: new Date().toISOString(),
  });
}

export async function performAtomicCommit(
  workspace: RunWorkspace,
  claim: SideEffectClaim,
  task: string,
  hashAlgorithm: CanonicalHashAlgorithm,
  markDispatched: () => Promise<void>,
  boundary?: (point: SideEffectBoundary) => void | Promise<void>,
): Promise<Record<string, unknown>> {
  if (claim.kind !== "git_commit") throw new Error(`Side effect ${claim.actionId} is not a commit`);
  const expected = commitPrecondition(claim);
  const current = await captureCommitPrecondition(workspace, hashAlgorithm);
  if (
    current.expectedHead !== expected.expectedHead ||
    current.branch !== expected.branch ||
    current.contentDigest !== expected.contentDigest
  )
    throw new Error(`Commit precondition changed for side effect ${claim.actionId}`);
  const status = await git(workspace.path, ["status", "--porcelain=v1"]);
  if (!status) throw new Error("No accepted changes are available to commit");
  await git(workspace.path, ["add", "-A"]);
  const summary = task.replace(/\s+/g, " ").slice(0, 64);
  await crossSideEffectBoundary(boundary, "after_action_prepare");
  await markDispatched();
  await git(workspace.path, [
    "commit",
    "-m",
    `graphcraft: ${summary}`,
    "-m",
    `Graphcraft-Action: ${claim.idempotencyKey}`,
  ]);
  await crossSideEffectBoundary(boundary, "after_action_command");
  return { sha: await git(workspace.path, ["rev-parse", "HEAD"]), branch: expected.branch };
}

export async function reconcileAtomicCommit(
  workspace: RunWorkspace,
  claim: SideEffectClaim,
  hashAlgorithm: CanonicalHashAlgorithm,
): Promise<SideEffectReconciliation> {
  if (claim.kind !== "git_commit") throw new Error(`Side effect ${claim.actionId} is not a commit`);
  const expected = commitPrecondition(claim);
  const [currentHead, currentBranch] = await Promise.all([
    git(workspace.path, ["rev-parse", "HEAD"]),
    git(workspace.path, ["branch", "--show-current"]),
  ]);
  if (currentBranch !== expected.branch || currentBranch !== claim.target)
    return {
      status: "unknown",
      evidence: [
        `Expected branch ${expected.branch}; observed ${currentBranch || "detached HEAD"}`,
      ],
    };
  if (currentHead === expected.expectedHead) {
    const currentDigest = await commitContentDigest(workspace.path, hashAlgorithm);
    return currentDigest === expected.contentDigest
      ? {
          status: "not_applied",
          evidence: [`HEAD remains ${currentHead} and the claimed content digest is unchanged`],
        }
      : {
          status: "unknown",
          evidence: ["HEAD is unchanged but the claimed repository content changed"],
        };
  }
  const [parent, message] = await Promise.all([
    git(workspace.path, ["rev-parse", `${currentHead}^`]).catch(() => ""),
    git(workspace.path, ["show", "-s", "--format=%B", currentHead]),
  ]);
  if (
    parent === expected.expectedHead &&
    message.split("\n").includes(`Graphcraft-Action: ${claim.idempotencyKey}`)
  )
    return {
      status: "applied",
      result: { sha: currentHead, branch: currentBranch },
      evidence: [
        `Commit ${currentHead} directly follows the claimed HEAD and carries the idempotency trailer`,
      ],
    };
  return {
    status: "unknown",
    evidence: [
      `HEAD moved from ${expected.expectedHead} to ${currentHead} without the claimed commit identity`,
    ],
  };
}

interface PushPrecondition {
  remote: string;
  remoteUrl: string;
  branch: string;
  localSha: string;
  expectedRemoteSha: string | null;
}

async function remoteBranchSha(
  repositoryPath: string,
  remote: string,
  branch: string,
): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const result = await runProcess("git", ["ls-remote", "--exit-code", "--refs", remote, ref], {
    cwd: repositoryPath,
    timeoutMs: 120_000,
  });
  if (result.exitCode === 2 && result.stdout.trim().length === 0) return null;
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `Unable to read ${remote}/${branch}`);
  const matches = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/, 2))
    .filter(([, observedRef]) => observedRef === ref);
  if (matches.length !== 1 || !matches[0]?.[0])
    throw new Error(`Remote ${remote}/${branch} did not resolve to exactly one SHA`);
  return matches[0][0];
}

async function capturePushPrecondition(
  workspace: RunWorkspace,
  remote = "origin",
): Promise<PushPrecondition> {
  const [remoteUrl, branch, localSha] = await Promise.all([
    git(workspace.path, ["remote", "get-url", remote]),
    git(workspace.path, ["branch", "--show-current"]),
    git(workspace.path, ["rev-parse", "HEAD"]),
  ]);
  if (!branch) throw new Error("The Graphcraft worktree is not on a named branch");
  const expectedRemoteSha = await remoteBranchSha(workspace.path, remote, branch);
  return { remote, remoteUrl, branch, localSha, expectedRemoteSha };
}

function pushPrecondition(claim: SideEffectClaim): PushPrecondition {
  const remote = claim.precondition.remote;
  const remoteUrl = claim.precondition.remoteUrl;
  const branch = claim.precondition.branch;
  const localSha = claim.precondition.localSha;
  const expectedRemoteSha = claim.precondition.expectedRemoteSha;
  if (
    typeof remote !== "string" ||
    typeof remoteUrl !== "string" ||
    typeof branch !== "string" ||
    typeof localSha !== "string" ||
    (expectedRemoteSha !== null && typeof expectedRemoteSha !== "string")
  )
    throw new Error(`Push claim ${claim.actionId} has an invalid precondition`);
  return { remote, remoteUrl, branch, localSha, expectedRemoteSha };
}

export async function createAtomicPushClaim(
  workspace: RunWorkspace,
  runId: string,
  nodeId: string,
  hashAlgorithm: CanonicalHashAlgorithm,
): Promise<SideEffectClaim> {
  const precondition = await capturePushPrecondition(workspace);
  const actionId = contentHash(
    { schemaVersion: 1, runId, nodeId, kind: "git_push" },
    hashAlgorithm,
  );
  return SideEffectClaimSchema.parse({
    schemaVersion: 1,
    actionId,
    idempotencyKey: `graphcraft-${actionId}`,
    nodeId,
    kind: "git_push",
    target: `${precondition.remote}/${precondition.branch}`,
    precondition,
    claimedAt: new Date().toISOString(),
  });
}

export async function performAtomicPush(
  workspace: RunWorkspace,
  claim: SideEffectClaim,
  markDispatched: () => Promise<void>,
  boundary?: (point: SideEffectBoundary) => void | Promise<void>,
): Promise<Record<string, unknown>> {
  if (claim.kind !== "git_push") throw new Error(`Side effect ${claim.actionId} is not a push`);
  const expected = pushPrecondition(claim);
  const current = await capturePushPrecondition(workspace, expected.remote);
  if (
    current.remoteUrl !== expected.remoteUrl ||
    current.branch !== expected.branch ||
    current.localSha !== expected.localSha ||
    current.expectedRemoteSha !== expected.expectedRemoteSha
  )
    throw new Error(`Push precondition changed for side effect ${claim.actionId}`);
  await crossSideEffectBoundary(boundary, "after_action_prepare");
  await markDispatched();
  await gitRaw(workspace.path, [
    "push",
    "--porcelain",
    expected.remote,
    `${expected.branch}:refs/heads/${expected.branch}`,
  ]);
  await crossSideEffectBoundary(boundary, "after_action_command");
  return {
    remote: expected.remote,
    remoteUrl: expected.remoteUrl,
    branch: expected.branch,
    sha: expected.localSha,
  };
}

export async function reconcileAtomicPush(
  workspace: RunWorkspace,
  claim: SideEffectClaim,
): Promise<SideEffectReconciliation> {
  if (claim.kind !== "git_push") throw new Error(`Side effect ${claim.actionId} is not a push`);
  const expected = pushPrecondition(claim);
  const [currentRemoteUrl, currentBranch, currentHead, currentRemoteSha] = await Promise.all([
    git(workspace.path, ["remote", "get-url", expected.remote]),
    git(workspace.path, ["branch", "--show-current"]),
    git(workspace.path, ["rev-parse", "HEAD"]),
    remoteBranchSha(workspace.path, expected.remote, expected.branch),
  ]);
  if (
    currentRemoteUrl !== expected.remoteUrl ||
    currentBranch !== expected.branch ||
    currentHead !== expected.localSha
  )
    return {
      status: "unknown",
      evidence: [
        `Push preconditions moved: expected ${expected.remoteUrl} ${expected.branch} ${expected.localSha}; observed ${currentRemoteUrl} ${currentBranch || "detached HEAD"} ${currentHead}`,
      ],
    };
  if (currentRemoteSha === expected.localSha)
    return {
      status: "applied",
      result: {
        remote: expected.remote,
        remoteUrl: expected.remoteUrl,
        branch: expected.branch,
        sha: expected.localSha,
      },
      evidence: [
        `Remote ${expected.remote}/${expected.branch} resolves to the claimed SHA ${expected.localSha}`,
      ],
    };
  if (currentRemoteSha === expected.expectedRemoteSha)
    return {
      status: "not_applied",
      evidence: [
        currentRemoteSha
          ? `Remote ${expected.remote}/${expected.branch} remains at ${currentRemoteSha}`
          : `Remote ${expected.remote}/${expected.branch} remains absent`,
      ],
    };
  return {
    status: "unknown",
    evidence: [
      `Remote ${expected.remote}/${expected.branch} moved from ${expected.expectedRemoteSha ?? "absent"} to ${currentRemoteSha ?? "absent"} without the claimed push`,
    ],
  };
}
