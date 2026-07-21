import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { runProcess } from "@graphcraft/probes";
import type { RepositoryIdentity, RepositoryPlanningEvidence, RunContract } from "@graphcraft/core";

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd: repositoryPath, timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
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

export async function createAtomicCommit(workspace: RunWorkspace, task: string): Promise<string> {
  const status = await git(workspace.path, ["status", "--porcelain=v1"]);
  if (!status) throw new Error("No accepted changes are available to commit");
  await git(workspace.path, ["add", "-A"]);
  const summary = task.replace(/\s+/g, " ").slice(0, 64);
  await git(workspace.path, ["commit", "-m", `graphcraft: ${summary}`]);
  return await git(workspace.path, ["rev-parse", "HEAD"]);
}
