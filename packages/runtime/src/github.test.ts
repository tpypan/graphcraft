import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  SideEffectClaimSchema,
  contentHash,
} from "@graphcraft/core";
import { GitHubCommandCancellationError, GitHubCommandResultError } from "@graphcraft/github";

const githubMocks = vi.hoisted(() => ({
  assertGitHubPushCapability: vi.fn(),
  createGitHubPullRequest: vi.fn(),
  listGitHubPullRequestsForHead: vi.fn(),
}));

vi.mock("@graphcraft/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@graphcraft/github")>()),
  ...githubMocks,
}));

import {
  classifyGitHubCommandCancellation,
  performPullRequestCreation,
  type GitHubExecutionOptions,
} from "./github.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function createPullRequestFixture() {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-runtime-github-cancellation-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "--initial-branch=main", repository]);
  await git(repository, "config", "user.name", "Graphcraft Test");
  await git(repository, "config", "user.email", "graphcraft@example.invalid");
  await git(repository, "config", "commit.gpgsign", "false");
  await writeFile(join(repository, "README.md"), "fixture\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "fixture");
  await git(repository, "remote", "add", "origin", remote);
  await git(repository, "push", "origin", "main");
  await git(repository, "checkout", "-b", "graphcraft/cancellation");
  await writeFile(join(repository, "feature.txt"), "feature\n");
  await git(repository, "add", "feature.txt");
  await git(repository, "commit", "-m", "feature");
  await git(repository, "push", "origin", "graphcraft/cancellation");

  const headSha = await git(repository, "rev-parse", "HEAD");
  const baseSha = await git(repository, "rev-parse", "main");
  const actionId = "a".repeat(64);
  const idempotencyKey = `graphcraft-${actionId}`;
  const body = [
    "Created by Graphcraft after deterministic verification and an accepted normal push.",
    "",
    `<!-- Graphcraft-Action: ${idempotencyKey} -->`,
  ].join("\n");
  const claim = SideEffectClaimSchema.parse({
    schemaVersion: 1,
    actionId,
    idempotencyKey,
    nodeId: "pull-request",
    kind: "github_pr_create",
    target: "tpypan/fixture:graphcraft/cancellation->main",
    precondition: {
      host: "github.com",
      nameWithOwner: "tpypan/fixture",
      remote: "origin",
      remoteUrl: remote,
      headRefName: "graphcraft/cancellation",
      baseRefName: "main",
      headSha,
      baseSha,
      title: "Cancellation fixture",
      bodyHash: contentHash(body, PORTABLE_CANONICAL_HASH_ALGORITHM),
      expectedPullRequestNumber: null,
    },
    claimedAt: "2026-07-26T00:00:00.000Z",
  });
  return {
    claim,
    workspace: { path: repository, branch: "graphcraft/cancellation", created: false },
  };
}

beforeEach(() => {
  githubMocks.assertGitHubPushCapability.mockResolvedValue({
    host: "github.com",
    nameWithOwner: "tpypan/fixture",
  });
  githubMocks.listGitHubPullRequestsForHead.mockResolvedValue([]);
  githubMocks.createGitHubPullRequest.mockResolvedValue({
    number: 100,
    url: "https://github.com/tpypan/fixture/pull/100",
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe("runtime GitHub mutation cancellation", () => {
  it("passes cancellation only to the mutating command", async () => {
    const { claim, workspace } = await createPullRequestFixture();
    const abort = new AbortController();
    const markDispatched = vi.fn(async () => {});

    await performPullRequestCreation(
      workspace,
      claim,
      PORTABLE_CANONICAL_HASH_ALGORITHM,
      markDispatched,
      {},
      undefined,
      abort.signal,
    );

    expect(githubMocks.assertGitHubPushCapability).toHaveBeenCalledWith(
      expect.not.objectContaining({ signal: expect.anything() }),
    );
    expect(githubMocks.listGitHubPullRequestsForHead).toHaveBeenCalledWith(
      expect.not.objectContaining({ signal: expect.anything() }),
      expect.anything(),
    );
    expect(githubMocks.createGitHubPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ signal: abort.signal }),
      expect.anything(),
    );
    expect(markDispatched).toHaveBeenCalledOnce();
  });

  it("finishes read-only preconditions but does not dispatch for a pre-aborted mutation", async () => {
    const { claim, workspace } = await createPullRequestFixture();
    const abort = new AbortController();
    const markDispatched = vi.fn(async () => {});
    abort.abort(new Error("private stop reason"));

    const observed = await performPullRequestCreation(
      workspace,
      claim,
      PORTABLE_CANONICAL_HASH_ALGORITHM,
      markDispatched,
      {},
      undefined,
      abort.signal,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(observed).toBeInstanceOf(GitHubCommandCancellationError);
    expect(observed).toMatchObject({ outcome: "cancelled_before_spawn" });
    expect(String(observed)).not.toContain("private stop reason");
    expect(githubMocks.assertGitHubPushCapability).toHaveBeenCalledOnce();
    expect(githubMocks.listGitHubPullRequestsForHead).toHaveBeenCalledOnce();
    expect(githubMocks.createGitHubPullRequest).not.toHaveBeenCalled();
    expect(markDispatched).not.toHaveBeenCalled();
  });

  it.each([
    ["cancelled_before_spawn", "confirmed"],
    ["terminated", "confirmed"],
    ["unconfirmed", "unconfirmed"],
  ] as const)("classifies %s settlement as %s", (outcome, childSettlement) => {
    expect(classifyGitHubCommandCancellation(new GitHubCommandCancellationError(outcome))).toEqual({
      outcome,
      childSettlement,
    });
  });

  it("does not classify unrelated failures", () => {
    expect(classifyGitHubCommandCancellation(new Error("ordinary failure"))).toBeUndefined();
  });

  it("classifies a settled mutation-response failure without inventing cancellation", () => {
    expect(
      classifyGitHubCommandCancellation(new GitHubCommandResultError("invalid response")),
    ).toEqual({
      outcome: "failed",
      childSettlement: "confirmed",
    });
  });

  it("keeps cancellation out of shared GitHub execution options", () => {
    expectTypeOf<
      "signal" extends keyof GitHubExecutionOptions ? true : false
    >().toEqualTypeOf<false>();
  });
});
