import { appendFile, lstat, mkdir, readFile, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { runProcess } from "@graphcraft/probes";
import {
  SideEffectClaimSchema,
  contentHash,
  type RepositoryIdentity,
  type RepositoryPlanningEvidence,
  type RunContract,
  type SideEffectClaim,
} from "@graphcraft/core";
import {
  crossSideEffectBoundary,
  type SideEffectBoundary,
  type SideEffectReconciliation,
} from "./side-effect.ts";

async function gitRaw(repositoryPath: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd: repositoryPath, timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  return (await gitRaw(repositoryPath, args)).trim();
}

export async function discoverRepository(cwd: string): Promise<RepositoryIdentity> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const baseSha = await git(root, ["rev-parse", "HEAD"]);
  const baseRef =
    (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "HEAD")) || "HEAD";
  const remote = await git(root, ["remote", "get-url", "origin"]).catch(() => undefined);
  await ensureGraphcraftIgnored(root);
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

export async function discoverPlanningEvidence(
  repositoryRoot: string,
  task: string,
): Promise<RepositoryPlanningEvidence> {
  const trackedPaths = (await git(repositoryRoot, ["ls-files"])).split("\n").filter(Boolean);
  const files: RepositoryPlanningEvidence["files"] = [];
  let remainingCharacters = 24_000;
  const searchTerms = planningSearchTerms(task);
  const searchPattern = searchTerms.join("|");
  const matchedPaths = searchPattern
    ? (
        await git(repositoryRoot, ["grep", "-l", "-I", "-i", "-E", searchPattern, "--"]).catch(
          () => "",
        )
      )
        .split("\n")
        .filter(
          (path) =>
            path.length > 0 &&
            !path.startsWith("dist/") &&
            !path.endsWith(".map") &&
            !path.endsWith(".lock"),
        )
    : [];
  const taskMatches = await Promise.all(
    matchedPaths.map(async (path) => {
      const content = await readFile(join(repositoryRoot, path), "utf8").catch(() => "");
      const normalized = content.toLowerCase();
      const score = searchTerms.filter((term) => normalized.includes(term)).length;
      const pathScore = searchTerms.filter((term) => path.toLowerCase().includes(term)).length;
      const source = /(?:^|\/)(?:src|test|tests)\//.test(path) ? 1 : 0;
      return { path, content, score, pathScore, source };
    }),
  );
  taskMatches.sort(
    (left, right) =>
      right.source - left.source ||
      right.pathScore - left.pathScore ||
      right.score - left.score ||
      left.path.localeCompare(right.path),
  );
  for (const { path, content } of taskMatches.slice(0, 3)) {
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
    if (remainingCharacters <= 0 || files.length >= 7) break;
    if (files.some((file) => file.path === path)) continue;
    const content = await readFile(join(repositoryRoot, path), "utf8").catch(() => "");
    const limit = Math.min(2_000, remainingCharacters);
    const selected = content.slice(0, limit);
    files.push({ path, content: selected, truncated: selected.length < content.length });
    remainingCharacters -= selected.length;
  }
  const trackedPathLimit = 2_000;
  return {
    trackedPathCount: trackedPaths.length,
    trackedPaths: trackedPaths.slice(0, trackedPathLimit),
    trackedPathsTruncated: trackedPaths.length > trackedPathLimit,
    files,
  };
}

async function ensureGraphcraftIgnored(repositoryRoot: string): Promise<void> {
  const rawExcludePath = await git(repositoryRoot, ["rev-parse", "--git-path", "info/exclude"]);
  const excludePath = isAbsolute(rawExcludePath)
    ? rawExcludePath
    : resolve(repositoryRoot, rawExcludePath);
  let content = "";
  try {
    content = await readFile(excludePath, "utf8");
  } catch {
    await mkdir(dirname(excludePath), { recursive: true });
  }
  if (!content.split("\n").includes(".graphcraft/"))
    await appendFile(excludePath, "\n.graphcraft/\n", "utf8");
}

export interface RunWorkspace {
  path: string;
  branch: string;
  created: boolean;
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

export async function createRunWorkspace(contract: RunContract): Promise<RunWorkspace> {
  const branch = `graphcraft/${contract.runId.slice(0, 8)}-${slug(contract.task)}`;
  const parent = join(
    dirname(contract.repository.root),
    `.${basename(contract.repository.root)}-graphcraft-worktrees`,
  );
  const path = join(parent, contract.runId);
  await mkdir(parent, { recursive: true });
  const registered = await git(contract.repository.root, ["worktree", "list", "--porcelain"]);
  if (registered.includes(`worktree ${path}`)) return { path, branch, created: false };

  const branchExists = await git(contract.repository.root, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ])
    .then(() => true)
    .catch(() => false);
  await git(
    contract.repository.root,
    branchExists
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, contract.repository.baseSha],
  );
  return { path, branch, created: true };
}

interface CommitPrecondition {
  expectedHead: string;
  branch: string;
  contentDigest: string;
}

async function commitContentDigest(repositoryPath: string): Promise<string> {
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
  return contentHash(changes);
}

async function captureCommitPrecondition(workspace: RunWorkspace): Promise<CommitPrecondition> {
  const [expectedHead, branch, contentDigest] = await Promise.all([
    git(workspace.path, ["rev-parse", "HEAD"]),
    git(workspace.path, ["branch", "--show-current"]),
    commitContentDigest(workspace.path),
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
): Promise<SideEffectClaim> {
  const precondition = await captureCommitPrecondition(workspace);
  const actionId = contentHash({ schemaVersion: 1, runId, nodeId, kind: "git_commit" });
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
  boundary?: (point: SideEffectBoundary) => void | Promise<void>,
): Promise<Record<string, unknown>> {
  if (claim.kind !== "git_commit") throw new Error(`Side effect ${claim.actionId} is not a commit`);
  const expected = commitPrecondition(claim);
  const current = await captureCommitPrecondition(workspace);
  if (
    current.expectedHead !== expected.expectedHead ||
    current.branch !== expected.branch ||
    current.contentDigest !== expected.contentDigest
  )
    throw new Error(`Commit precondition changed for side effect ${claim.actionId}`);
  const status = await git(workspace.path, ["status", "--porcelain=v1"]);
  if (!status) throw new Error("No accepted changes are available to commit");
  await git(workspace.path, ["add", "-A"]);
  await crossSideEffectBoundary(boundary, "after_action_prepare");
  const summary = task.replace(/\s+/g, " ").slice(0, 64);
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
    const currentDigest = await commitContentDigest(workspace.path);
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
