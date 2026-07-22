import { runProcess } from "@graphcraft/probes";
import {
  SideEffectClaimSchema,
  contentHash,
  type RunContract,
  type SideEffectClaim,
} from "@graphcraft/core";
import {
  assertGitHubPushCapability,
  createGitHubPullRequest,
  listGitHubPullRequestsForHead,
  readGitHubPullRequestIdentity,
  type GitHubCommandOptions,
  type GitHubPullRequestCandidate,
} from "@graphcraft/github";
import {
  crossSideEffectBoundary,
  type SideEffectBoundary,
  type SideEffectReconciliation,
} from "./side-effect.ts";
import type { RunWorkspace } from "./repository.ts";

export type GitHubExecutionOptions = Omit<GitHubCommandOptions, "cwd">;

interface PullRequestPrecondition {
  host: string;
  nameWithOwner: string;
  remote: string;
  remoteUrl: string;
  headRefName: string;
  baseRefName: string;
  headSha: string;
  baseSha: string;
  title: string;
  bodyHash: string;
  expectedPullRequestNumber: number | null;
}

function commandOptions(
  workspace: RunWorkspace,
  options: GitHubExecutionOptions = {},
): GitHubCommandOptions {
  return { cwd: workspace.path, ...options };
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd: repositoryPath, timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

async function remoteBranchSha(
  workspace: RunWorkspace,
  remote: string,
  branch: string,
): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const result = await runProcess("git", ["ls-remote", "--exit-code", "--refs", remote, ref], {
    cwd: workspace.path,
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

function pullRequestBody(idempotencyKey: string): string {
  return [
    "Created by Graphcraft after deterministic verification and an accepted normal push.",
    "",
    `<!-- Graphcraft-Action: ${idempotencyKey} -->`,
  ].join("\n");
}

function pullRequestPrecondition(claim: SideEffectClaim): PullRequestPrecondition {
  const host = claim.precondition.host;
  const nameWithOwner = claim.precondition.nameWithOwner;
  const remote = claim.precondition.remote;
  const remoteUrl = claim.precondition.remoteUrl;
  const headRefName = claim.precondition.headRefName;
  const baseRefName = claim.precondition.baseRefName;
  const headSha = claim.precondition.headSha;
  const baseSha = claim.precondition.baseSha;
  const title = claim.precondition.title;
  const bodyHash = claim.precondition.bodyHash;
  const expectedPullRequestNumber = claim.precondition.expectedPullRequestNumber;
  if (
    typeof host !== "string" ||
    typeof nameWithOwner !== "string" ||
    typeof remote !== "string" ||
    typeof remoteUrl !== "string" ||
    typeof headRefName !== "string" ||
    typeof baseRefName !== "string" ||
    typeof headSha !== "string" ||
    typeof baseSha !== "string" ||
    typeof title !== "string" ||
    typeof bodyHash !== "string" ||
    (expectedPullRequestNumber !== null &&
      (typeof expectedPullRequestNumber !== "number" ||
        !Number.isInteger(expectedPullRequestNumber) ||
        expectedPullRequestNumber <= 0))
  )
    throw new Error(`Pull-request claim ${claim.actionId} has an invalid precondition`);
  return {
    host,
    nameWithOwner,
    remote,
    remoteUrl,
    headRefName,
    baseRefName,
    headSha,
    baseSha,
    title,
    bodyHash,
    expectedPullRequestNumber,
  };
}

function exactCandidate(
  candidate: GitHubPullRequestCandidate,
  expected: PullRequestPrecondition,
): boolean {
  return (
    candidate.headRefName === expected.headRefName &&
    candidate.baseRefName === expected.baseRefName &&
    candidate.headSha === expected.headSha &&
    candidate.baseSha === expected.baseSha
  );
}

async function assertCurrentRemoteBinding(
  workspace: RunWorkspace,
  expected: PullRequestPrecondition,
): Promise<string[]> {
  const [remoteUrl, branch, localSha, headSha, baseSha] = await Promise.all([
    git(workspace.path, ["remote", "get-url", expected.remote]),
    git(workspace.path, ["branch", "--show-current"]),
    git(workspace.path, ["rev-parse", "HEAD"]),
    remoteBranchSha(workspace, expected.remote, expected.headRefName),
    remoteBranchSha(workspace, expected.remote, expected.baseRefName),
  ]);
  const evidence = [
    `Remote ${expected.remote} URL is ${remoteUrl}`,
    `Local ${branch || "detached HEAD"} is ${localSha}`,
    `Remote ${expected.remote}/${expected.headRefName} is ${headSha ?? "absent"}`,
    `Remote ${expected.remote}/${expected.baseRefName} is ${baseSha ?? "absent"}`,
  ];
  if (
    remoteUrl !== expected.remoteUrl ||
    branch !== expected.headRefName ||
    localSha !== expected.headSha ||
    headSha !== expected.headSha ||
    baseSha !== expected.baseSha
  )
    throw new Error(
      `Pull-request binding moved from ${expected.headRefName}@${expected.headSha}/${expected.baseRefName}@${expected.baseSha}: ${evidence.join("; ")}`,
    );
  return evidence;
}

async function currentCandidates(
  workspace: RunWorkspace,
  expected: PullRequestPrecondition,
  options: GitHubExecutionOptions,
): Promise<GitHubPullRequestCandidate[]> {
  const github = commandOptions(workspace, options);
  const capability = await assertGitHubPushCapability({
    ...github,
    baseBranch: expected.baseRefName,
  });
  if (capability.host !== expected.host || capability.nameWithOwner !== expected.nameWithOwner)
    throw new Error(
      `GitHub repository identity moved from ${expected.host}/${expected.nameWithOwner} to ${capability.host ?? "unknown"}/${capability.nameWithOwner ?? "unknown"}`,
    );
  return await listGitHubPullRequestsForHead(github, {
    host: expected.host,
    nameWithOwner: expected.nameWithOwner,
    headRefName: expected.headRefName,
  });
}

async function confirmCandidate(
  workspace: RunWorkspace,
  expected: PullRequestPrecondition,
  candidate: GitHubPullRequestCandidate,
  options: GitHubExecutionOptions,
): Promise<GitHubPullRequestCandidate> {
  const current = await readGitHubPullRequestIdentity(commandOptions(workspace, options), {
    nameWithOwner: expected.nameWithOwner,
    number: candidate.number,
  });
  if (current.state !== "OPEN" || !exactCandidate(current, expected))
    throw new Error(`Pull request #${candidate.number} moved before confirmation`);
  return current;
}

export async function createPullRequestClaim(
  workspace: RunWorkspace,
  contract: RunContract,
  nodeId: string,
  options: GitHubExecutionOptions = {},
): Promise<SideEffectClaim> {
  if (contract.repository.baseRef === "HEAD")
    throw new Error("A pr_open finish line requires a named base branch");
  const actionId = contentHash({
    schemaVersion: 1,
    runId: contract.runId,
    nodeId,
    kind: "github_pr_create",
  });
  const idempotencyKey = `graphcraft-${actionId}`;
  const github = commandOptions(workspace, options);
  const capability = await assertGitHubPushCapability({
    ...github,
    baseBranch: contract.repository.baseRef,
  });
  if (!capability.host || !capability.nameWithOwner)
    throw new Error("GitHub PR preflight did not return repository identity");
  const remote = "origin";
  const [remoteUrl, headRefName, headSha, remoteHeadSha, baseSha] = await Promise.all([
    git(workspace.path, ["remote", "get-url", remote]),
    git(workspace.path, ["branch", "--show-current"]),
    git(workspace.path, ["rev-parse", "HEAD"]),
    remoteBranchSha(workspace, remote, workspace.branch),
    remoteBranchSha(workspace, remote, contract.repository.baseRef),
  ]);
  if (!headRefName || headRefName !== workspace.branch)
    throw new Error("The Graphcraft worktree is not on its run branch");
  if (remoteHeadSha !== headSha)
    throw new Error(`The pushed run branch is not bound to local HEAD ${headSha}`);
  if (!baseSha) throw new Error(`Remote base branch ${contract.repository.baseRef} is absent`);
  const title = contract.task.replace(/\s+/g, " ").trim().slice(0, 120);
  const body = pullRequestBody(idempotencyKey);
  const precondition: PullRequestPrecondition = {
    host: capability.host,
    nameWithOwner: capability.nameWithOwner,
    remote,
    remoteUrl,
    headRefName,
    baseRefName: contract.repository.baseRef,
    headSha,
    baseSha,
    title,
    bodyHash: contentHash(body),
    expectedPullRequestNumber: null,
  };
  const candidates = await listGitHubPullRequestsForHead(github, {
    host: precondition.host,
    nameWithOwner: precondition.nameWithOwner,
    headRefName,
  });
  if (candidates.length > 0) {
    const matching = candidates.filter(
      (candidate) => candidate.state === "OPEN" && exactCandidate(candidate, precondition),
    );
    const otherOpen = candidates.filter(
      (candidate) => candidate.state === "OPEN" && candidate.number !== matching[0]?.number,
    );
    if (matching.length !== 1 || otherOpen.length > 0)
      throw new Error(`Cannot recover a unique open pull request for ${headRefName}@${headSha}`);
    precondition.expectedPullRequestNumber = matching[0]!.number;
  }
  return SideEffectClaimSchema.parse({
    schemaVersion: 1,
    actionId,
    idempotencyKey,
    nodeId,
    kind: "github_pr_create",
    target: `${precondition.nameWithOwner}:${headRefName}->${precondition.baseRefName}`,
    precondition,
    claimedAt: new Date().toISOString(),
  });
}

export async function reconcilePullRequest(
  workspace: RunWorkspace,
  claim: SideEffectClaim,
  options: GitHubExecutionOptions = {},
): Promise<SideEffectReconciliation> {
  if (claim.kind !== "github_pr_create")
    throw new Error(`Side effect ${claim.actionId} is not a pull-request creation`);
  const expected = pullRequestPrecondition(claim);
  let bindingEvidence: string[];
  try {
    bindingEvidence = await assertCurrentRemoteBinding(workspace, expected);
  } catch (error) {
    return {
      status: "unknown",
      evidence: [error instanceof Error ? error.message : String(error)],
    };
  }
  const candidates = await currentCandidates(workspace, expected, options);
  if (expected.expectedPullRequestNumber !== null) {
    const candidate = candidates.find(
      (value) =>
        value.number === expected.expectedPullRequestNumber &&
        value.state === "OPEN" &&
        exactCandidate(value, expected),
    );
    const otherOpen = candidates.filter(
      (value) => value.state === "OPEN" && value.number !== expected.expectedPullRequestNumber,
    );
    if (!candidate || otherOpen.length > 0)
      return {
        status: "unknown",
        evidence: [
          ...bindingEvidence,
          `Expected pull request #${expected.expectedPullRequestNumber} is no longer the unique open branch match`,
        ],
      };
    const current = await confirmCandidate(workspace, expected, candidate, options);
    return {
      status: "applied",
      result: {
        number: current.number,
        url: current.url,
        state: current.state,
        headSha: current.headSha,
        baseSha: current.baseSha,
      },
      evidence: [...bindingEvidence, `Recovered existing pull request #${current.number}`],
    };
  }
  if (candidates.length === 0)
    return {
      status: "not_applied",
      evidence: [...bindingEvidence, `No pull request exists for ${expected.headRefName}`],
    };
  const marker = `<!-- Graphcraft-Action: ${claim.idempotencyKey} -->`;
  const matching = candidates.filter(
    (candidate) =>
      candidate.state === "OPEN" &&
      exactCandidate(candidate, expected) &&
      candidate.body.includes(marker),
  );
  const otherOpen = candidates.filter(
    (candidate) => candidate.state === "OPEN" && candidate.number !== matching[0]?.number,
  );
  if (matching.length !== 1 || otherOpen.length > 0)
    return {
      status: "unknown",
      evidence: [
        ...bindingEvidence,
        `Observed ${candidates.length} pull-request candidate(s) without one exact idempotency match`,
      ],
    };
  const current = await confirmCandidate(workspace, expected, matching[0]!, options);
  if (contentHash(current.body) !== expected.bodyHash)
    return {
      status: "unknown",
      evidence: [
        ...bindingEvidence,
        `Pull request #${current.number} body changed before confirmation`,
      ],
    };
  return {
    status: "applied",
    result: {
      number: current.number,
      url: current.url,
      state: current.state,
      headSha: current.headSha,
      baseSha: current.baseSha,
    },
    evidence: [...bindingEvidence, `Pull request #${current.number} carries the action marker`],
  };
}

export async function performPullRequestCreation(
  workspace: RunWorkspace,
  claim: SideEffectClaim,
  options: GitHubExecutionOptions = {},
  boundary?: (point: SideEffectBoundary) => void | Promise<void>,
): Promise<Record<string, unknown>> {
  if (claim.kind !== "github_pr_create")
    throw new Error(`Side effect ${claim.actionId} is not a pull-request creation`);
  const expected = pullRequestPrecondition(claim);
  if (expected.expectedPullRequestNumber !== null)
    throw new Error(
      `Existing pull request #${expected.expectedPullRequestNumber} must be recovered`,
    );
  await assertCurrentRemoteBinding(workspace, expected);
  const candidates = await currentCandidates(workspace, expected, options);
  if (candidates.length > 0)
    throw new Error(`A pull request appeared for ${expected.headRefName} before creation`);
  const body = pullRequestBody(claim.idempotencyKey);
  if (contentHash(body) !== expected.bodyHash)
    throw new Error(`Pull-request body changed for side effect ${claim.actionId}`);
  await crossSideEffectBoundary(boundary, "after_action_prepare");
  await createGitHubPullRequest(commandOptions(workspace, options), {
    nameWithOwner: expected.nameWithOwner,
    headRefName: expected.headRefName,
    baseRefName: expected.baseRefName,
    title: expected.title,
    body,
  });
  await crossSideEffectBoundary(boundary, "after_action_command");
  return { created: true };
}
