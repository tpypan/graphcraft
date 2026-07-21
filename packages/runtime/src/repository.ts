import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { runProcess } from "@graphcraft/probes";
import type { RepositoryIdentity, RunContract } from "@graphcraft/core";

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
