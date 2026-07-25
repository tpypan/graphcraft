import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  compileRunContract,
  contentHash,
  type HostAdapter,
  type RunContract,
} from "@graphcraft/core";
import {
  createAtomicCommitClaim,
  createAtomicPushClaim,
  createRunWorkspace,
  discoverRepository,
  reconcileAtomicCommit,
  RunWorkspaceReconciliationError,
  type RunWorkspaceCreationBoundary,
} from "./repository.ts";
import { createRun, executeRun } from "./runner.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createFixture(): Promise<{ repository: string; contract: RunContract }> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-repository-test-"));
  temporaryRoots.push(root);
  const repository = join(root, "repo");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Graphcraft Test");
  await git(repository, "config", "user.email", "graphcraft@example.test");
  await git(repository, "config", "commit.gpgSign", "false");
  await writeFile(join(repository, "feature.txt"), "base\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "fixture");
  const contract = compileRunContract("Implement worktree", await discoverRepository(repository));
  return { repository, contract };
}

function intendedWorkspace(contract: RunContract): { path: string; branch: string } {
  const branch = `graphcraft/${contract.runId.slice(0, 8)}-implement-worktree`;
  return {
    branch,
    path: join(
      dirname(contract.repository.root),
      `.${basename(contract.repository.root)}-graphcraft-worktrees`,
      contract.runId,
    ),
  };
}

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}

async function branchTarget(repository: string, branch: string): Promise<string | undefined> {
  return await gitOutput(repository, "rev-parse", "--verify", `refs/heads/${branch}`)
    .then((value) => value)
    .catch(() => undefined);
}

function comparablePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

async function canonicalComparablePath(path: string): Promise<string> {
  try {
    return comparablePath(await realpath(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return comparablePath(join(await realpath(dirname(path)), basename(path)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return comparablePath(path);
  }
}

async function registrationCount(repository: string, path: string): Promise<number> {
  const output = await gitOutput(repository, "worktree", "list", "--porcelain", "-z");
  const target = await canonicalComparablePath(path);
  return output
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length))
    .filter((registeredPath) => comparablePath(registeredPath) === target).length;
}

async function commonGitDirectory(repository: string): Promise<string> {
  const value = await gitOutput(repository, "rev-parse", "--git-common-dir");
  return await realpath(isAbsolute(value) ? value : resolve(repository, value));
}

describe.sequential("run workspace creation reconciliation", () => {
  it("uses the selected repository side-effect identity algorithm without ambient locale ordering", async () => {
    const { repository, contract } = await createFixture();
    const workspace = await createRunWorkspace(contract);
    const remote = join(dirname(repository), "remote.git");
    await git(repository, "init", "--bare", remote);
    await git(workspace.path, "remote", "add", "origin", remote);
    await writeFile(join(workspace.path, "Ångstrom.txt"), "portable repository identity\n");

    const actionPayload = {
      schemaVersion: 1,
      runId: contract.runId,
      nodeId: "commit",
      kind: "git_commit",
    };
    const changePayload = [
      {
        path: "Ångstrom.txt",
        kind: "file",
        executable: false,
        contents: Buffer.from("portable repository identity\n").toString("base64"),
      },
    ];
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("portable repository side-effect identity used ambient locale ordering");
    });
    try {
      const commit = await createAtomicCommitClaim(
        workspace,
        contract.runId,
        "commit",
        PORTABLE_CANONICAL_HASH_ALGORITHM,
      );
      const push = await createAtomicPushClaim(
        workspace,
        contract.runId,
        "push",
        PORTABLE_CANONICAL_HASH_ALGORITHM,
      );

      expect(commit.actionId).toBe(contentHash(actionPayload, PORTABLE_CANONICAL_HASH_ALGORITHM));
      expect(commit.precondition.contentDigest).toBe(
        contentHash(changePayload, PORTABLE_CANONICAL_HASH_ALGORITHM),
      );
      await expect(
        reconcileAtomicCommit(workspace, commit, PORTABLE_CANONICAL_HASH_ALGORITHM),
      ).resolves.toMatchObject({ status: "not_applied" });
      expect(push.actionId).toBe(
        contentHash(
          { ...actionPayload, nodeId: "push", kind: "git_push" },
          PORTABLE_CANONICAL_HASH_ALGORITHM,
        ),
      );
    } finally {
      localeCompare.mockRestore();
    }

    const reversedLocale = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
      this: string,
      other: string,
    ) {
      const left = String(this);
      return left < other ? 1 : left > other ? -1 : 0;
    });
    try {
      const legacy = await createAtomicCommitClaim(
        workspace,
        contract.runId,
        "commit",
        LEGACY_CANONICAL_HASH_ALGORITHM,
      );
      expect(legacy.actionId).toBe(contentHash(actionPayload, LEGACY_CANONICAL_HASH_ALGORITHM));
      expect(legacy.precondition.contentDigest).toBe(
        contentHash(changePayload, LEGACY_CANONICAL_HASH_ALGORITHM),
      );
      expect(legacy.actionId).not.toBe(
        contentHash(actionPayload, PORTABLE_CANONICAL_HASH_ALGORITHM),
      );
      expect(legacy.precondition.contentDigest).not.toBe(
        contentHash(changePayload, PORTABLE_CANONICAL_HASH_ALGORITHM),
      );
    } finally {
      reversedLocale.mockRestore();
    }
  });

  it("propagates cancellation through repository discovery", async () => {
    const { repository } = await createFixture();
    const controller = new AbortController();
    const interruption = new Error("cancel repository discovery");
    controller.abort(interruption);

    await expect(discoverRepository(repository, controller.signal)).rejects.toBe(interruption);
  });

  it("creates an exact clean worktree once and reuses only that ready state", async () => {
    const { repository, contract } = await createFixture();

    const created = await createRunWorkspace(contract);
    const resumed = await createRunWorkspace(contract);

    expect(created).toMatchObject({ created: true });
    expect(resumed).toEqual({ ...created, created: false });
    expect(await gitOutput(created.path, "symbolic-ref", "--short", "HEAD")).toBe(created.branch);
    expect(await gitOutput(created.path, "rev-parse", "HEAD")).toBe(contract.repository.baseSha);
    expect(await gitOutput(created.path, "status", "--porcelain=v1", "--untracked-files=all")).toBe(
      "",
    );
    expect(await commonGitDirectory(created.path)).toBe(await commonGitDirectory(repository));
    expect(await registrationCount(repository, created.path)).toBe(1);
  });

  it.each<RunWorkspaceCreationBoundary>([
    "after_parent_prepare",
    "after_reconciliation",
    "before_worktree_add",
    "after_worktree_add",
  ])("resumes idempotently after cancellation at %s", async (interruptionPoint) => {
    const { repository, contract } = await createFixture();
    const intended = intendedWorkspace(contract);
    const controller = new AbortController();
    const interruption = new Error(`interrupted at ${interruptionPoint}`);

    await expect(
      createRunWorkspace(contract, {
        signal: controller.signal,
        boundary: (point) => {
          if (point === interruptionPoint) controller.abort(interruption);
        },
      }),
    ).rejects.toBe(interruption);

    const acted = interruptionPoint === "after_worktree_add";
    expect(await pathExists(intended.path)).toBe(acted);
    expect(await branchTarget(repository, intended.branch)).toBe(
      acted ? contract.repository.baseSha : undefined,
    );
    expect(await registrationCount(repository, intended.path)).toBe(acted ? 1 : 0);

    const resumed = await createRunWorkspace(contract);
    expect(resumed).toEqual({ ...intended, created: !acted });
    expect(await registrationCount(repository, intended.path)).toBe(1);
  });

  it("recovers a safe base-SHA branch left before worktree registration", async () => {
    const { repository, contract } = await createFixture();
    const intended = intendedWorkspace(contract);
    await git(repository, "branch", intended.branch, contract.repository.baseSha);

    const workspace = await createRunWorkspace(contract);

    expect(workspace).toEqual({ ...intended, created: true });
    expect(await registrationCount(repository, intended.path)).toBe(1);
  });

  it("preserves a branch-only state that moved away from the approved base", async () => {
    const { repository, contract } = await createFixture();
    const intended = intendedWorkspace(contract);
    await writeFile(join(repository, "later.txt"), "later\n");
    await git(repository, "add", "later.txt");
    await git(repository, "commit", "-m", "later");
    const laterSha = await gitOutput(repository, "rev-parse", "HEAD");
    await git(repository, "branch", intended.branch, laterSha);

    await expect(createRunWorkspace(contract)).rejects.toThrow(
      /intended branch does not point to approved base/,
    );
    expect(await branchTarget(repository, intended.branch)).toBe(laterSha);
    expect(await pathExists(intended.path)).toBe(false);
  });

  it("preserves an unregistered directory at the intended path", async () => {
    const { contract } = await createFixture();
    const intended = intendedWorkspace(contract);
    await mkdir(intended.path, { recursive: true });
    await writeFile(join(intended.path, "preserved.txt"), "preserve me\n");

    await expect(createRunWorkspace(contract)).rejects.toThrow(
      /path exists without an exact Git worktree registration/,
    );
    expect(await pathExists(join(intended.path, "preserved.txt"))).toBe(true);
  });

  it("durably blocks a run when workspace reconciliation finds ambiguous state", async () => {
    const { repository } = await createFixture();
    const created = await createRun("Implement worktree", { cwd: repository });
    const intended = intendedWorkspace(created.contract);
    await mkdir(intended.path, { recursive: true });
    await writeFile(join(intended.path, "preserved.txt"), "preserve me\n");
    const adapter: HostAdapter = {
      id: "test",
      async probe() {
        return {
          installed: true,
          authenticated: true,
          version: "test",
          protocolProfile: "test/fixture",
          structuredOutput: true,
          streamingEvents: true,
          tokenReporting: true,
          cancellation: true,
          resume: true,
        };
      },
      async plan() {
        throw new Error("planning must not run");
      },
      async *execute() {
        throw new Error("execution must not run");
      },
      async verify() {
        throw new Error("verification must not run");
      },
      async reconcile() {
        return { state: "not_started" };
      },
    };

    const state = await executeRun({ store: created.store, adapter, approve: true });

    expect(state.status).toBe("blocked");
    expect(state.stopReason).toContain("path exists without an exact Git worktree registration");
    expect(await pathExists(join(intended.path, "preserved.txt"))).toBe(true);
    expect(
      (await created.store.loadEvents()).filter(({ type }) => type === "run.blocked"),
    ).toHaveLength(1);
  });

  it("preserves a missing path that Git still registers", async () => {
    const { repository, contract } = await createFixture();
    const created = await createRunWorkspace(contract);
    await rm(created.path, { recursive: true });

    await expect(createRunWorkspace(contract)).rejects.toThrow(/path is missing/);
    expect(await registrationCount(repository, created.path)).toBe(1);
    expect(await branchTarget(repository, created.branch)).toBe(contract.repository.baseSha);
  });

  it("rejects an intended branch already registered at another worktree", async () => {
    const { repository, contract } = await createFixture();
    const intended = intendedWorkspace(contract);
    const otherPath = join(dirname(intended.path), "other-worktree");
    await mkdir(dirname(intended.path), { recursive: true });
    await git(
      repository,
      "worktree",
      "add",
      "-b",
      intended.branch,
      otherPath,
      contract.repository.baseSha,
    );

    await expect(createRunWorkspace(contract)).rejects.toThrow(/registered at another worktree/);
    expect(await pathExists(otherPath)).toBe(true);
    expect(await pathExists(intended.path)).toBe(false);
  });

  it("preserves dirty and advanced registered worktrees instead of treating them as ready", async () => {
    const dirtyFixture = await createFixture();
    const dirty = await createRunWorkspace(dirtyFixture.contract);
    await writeFile(join(dirty.path, "untracked.txt"), "preserved\n");
    await expect(createRunWorkspace(dirtyFixture.contract)).rejects.toThrow(
      /uncommitted or untracked changes/,
    );
    expect(await pathExists(join(dirty.path, "untracked.txt"))).toBe(true);

    const advancedFixture = await createFixture();
    const advanced = await createRunWorkspace(advancedFixture.contract);
    await git(advanced.path, "config", "user.name", "Graphcraft Test");
    await git(advanced.path, "config", "user.email", "graphcraft@example.test");
    await git(advanced.path, "config", "commit.gpgSign", "false");
    await writeFile(join(advanced.path, "advanced.txt"), "advanced\n");
    await git(advanced.path, "add", "advanced.txt");
    await git(advanced.path, "commit", "-m", "advanced");
    const advancedSha = await gitOutput(advanced.path, "rev-parse", "HEAD");
    await expect(createRunWorkspace(advancedFixture.contract)).rejects.toThrow(
      /HEAD differs from the approved base/,
    );
    expect(await gitOutput(advanced.path, "rev-parse", "HEAD")).toBe(advancedSha);
  });

  it("preserves ignored content instead of accepting a contaminated registered worktree", async () => {
    const { repository, contract } = await createFixture();
    await writeFile(join(repository, ".git", "info", "exclude"), "ignored.txt\n", "utf8");
    const created = await createRunWorkspace(contract);
    await writeFile(join(created.path, "ignored.txt"), "preserved ignored content\n", "utf8");

    await expect(createRunWorkspace(contract)).rejects.toThrow(/including ignored content/);
    expect(await pathExists(join(created.path, "ignored.txt"))).toBe(true);
    expect(await registrationCount(repository, created.path)).toBe(1);
  });

  it("rejects a registered path rebound to a different common Git directory", async () => {
    const { repository, contract } = await createFixture();
    const created = await createRunWorkspace(contract);
    await unlink(join(created.path, ".git"));
    await git(created.path, "init", "-b", created.branch);
    await git(created.path, "fetch", repository, contract.repository.baseSha);
    await git(created.path, "reset", "--hard", "FETCH_HEAD");

    await expect(createRunWorkspace(contract)).rejects.toBeInstanceOf(
      RunWorkspaceReconciliationError,
    );
    await expect(createRunWorkspace(contract)).rejects.toThrow(/different common Git directory/);
    expect(await gitOutput(created.path, "rev-parse", "HEAD")).toBe(contract.repository.baseSha);
    expect(await pathExists(join(created.path, ".git"))).toBe(true);
  });
});
