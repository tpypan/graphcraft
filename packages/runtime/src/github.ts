import { runProcess, type ExecutedProbe } from "@graphcraft/probes";
import {
  SideEffectClaimSchema,
  WaitRuntimeStateSchema,
  contentHash,
  type ExecutableProbe,
  type GraphNode,
  type RunContract,
  type RunState,
  type SideEffectClaim,
} from "@graphcraft/core";
import {
  addGitHubReviewThreadReply,
  assertGitHubSnapshotCurrent,
  assertGitHubPushCapability,
  captureGitHubPullRequestSnapshot,
  classifyGitHubPullRequestLifecycle,
  createGitHubPullRequest,
  listGitHubPullRequestsForHead,
  readGitHubReviewThread,
  readGitHubPullRequestIdentity,
  rerequestGitHubCheckRun,
  resolveGitHubReviewThread,
  type GitHubCommandOptions,
  type GitHubPullRequestLifecycleClassification,
  type GitHubPullRequestCandidate,
} from "@graphcraft/github";
import {
  crossSideEffectBoundary,
  executeSideEffect,
  type SideEffectBoundary,
  type SideEffectReconciliation,
} from "./side-effect.ts";
import type { RunWorkspace } from "./repository.ts";
import { RunStore } from "./store.ts";

export type GitHubExecutionOptions = Omit<GitHubCommandOptions, "cwd">;

interface RemotePullRequestBinding {
  host: string;
  nameWithOwner: string;
  remote: string;
  remoteUrl: string;
  headRefName: string;
  baseRefName: string;
  headSha: string;
  baseSha: string;
}

interface PullRequestPrecondition extends RemotePullRequestBinding {
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
  expected: RemotePullRequestBinding,
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
    throw new Error("A pull-request finish line requires a named base branch");
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

type GitHubSnapshotProbe = Extract<ExecutableProbe, { kind: "github_snapshot" }>;

export interface CapturedPullRequestLifecycle extends ExecutedProbe {
  classification: GitHubPullRequestLifecycleClassification;
  reviewFeedback: GitHubReviewFeedback[];
  reviewFeedbackSignature: string;
  ciFailures: GitHubCheckFailureEvidence[];
  ciFailureSignature: string;
  rerunnableChecks: GitHubCheckRerunEvidence[];
  pullRequestDecision: { isDraft: boolean; reviewDecision?: string };
}

export interface GitHubReviewFeedback {
  contentTrust: "untrusted_external";
  threadId: string;
  path?: string;
  line?: number;
  commentCount: number;
  latestComment?: {
    id: string;
    author?: string;
    body: string;
    url: string;
    createdAt: string;
  };
}

export interface GitHubCheckFailureEvidence {
  contentTrust: "untrusted_external";
  id: string;
  databaseId?: number;
  kind: "check_run" | "status_context";
  name: string;
  status: string;
  conclusion?: string;
  appId?: number;
  detailsUrl?: string;
}

export interface GitHubCheckRerunEvidence extends GitHubCheckFailureEvidence {
  kind: "check_run";
  databaseId: number;
}

interface ReviewReplyPrecondition extends RemotePullRequestBinding {
  number: number;
  threadId: string;
  feedbackCommentId: string | null;
  feedbackBodyHash: string | null;
  replyBodyHash: string;
}

interface ReviewResolutionPrecondition extends RemotePullRequestBinding {
  number: number;
  threadId: string;
  replyIdempotencyKey: string;
  replyCommentId: string;
  replyBodyHash: string;
}

interface CheckRerunPrecondition extends RemotePullRequestBinding {
  number: number;
  checkId: string;
  databaseId: number;
  checkName: string;
  checkStatus: string;
  checkConclusion: string | null;
  appId: number | null;
}

function currentReviewFeedback(
  snapshot: Awaited<ReturnType<typeof captureGitHubPullRequestSnapshot>>,
): GitHubReviewFeedback[] {
  return snapshot.reviewThreads
    .filter(({ isResolved, isOutdated }) => !isResolved && !isOutdated)
    .slice(0, 20)
    .map(({ id, path, line, commentCount, latestComment }) => ({
      contentTrust: "untrusted_external" as const,
      threadId: id,
      ...(path ? { path } : {}),
      ...(line !== undefined ? { line } : {}),
      commentCount,
      ...(latestComment
        ? {
            latestComment: {
              id: latestComment.id,
              ...(latestComment.author ? { author: latestComment.author } : {}),
              body: latestComment.body.replaceAll("\0", "�").slice(0, 4_000),
              url: latestComment.url,
              createdAt: latestComment.createdAt,
            },
          }
        : {}),
    }));
}

function lifecycleBinding(
  state: RunState,
  node: GraphNode,
): {
  pullRequestClaim: SideEffectClaim;
  pullRequestResult: Record<string, unknown>;
  expected: PullRequestPrecondition;
  number: number;
} {
  const pullRequests = state.sideEffects.filter(
    ({ claim, status, result }) =>
      claim.kind === "github_pr_create" && status === "confirmed" && result !== undefined,
  );
  if (pullRequests.length !== 1 || !pullRequests[0]?.result)
    throw new Error("The GitHub lifecycle requires one confirmed pull-request binding");
  const pullRequest = pullRequests[0];
  const pullRequestResult = pullRequest.result;
  if (!pullRequestResult)
    throw new Error("The confirmed pull-request binding has no durable result");
  const originalExpected = pullRequestPrecondition(pullRequest.claim);
  const number = pullRequestResult.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0)
    throw new Error("The confirmed pull-request binding has no valid number");
  let expected = originalExpected;
  const boundaryNodeId = node.dependsOn[0];
  if (!boundaryNodeId) throw new Error("The GitHub lifecycle has no remote dependency");
  if (boundaryNodeId !== pullRequest.claim.nodeId) {
    const pushed = state.sideEffects.find(
      ({ claim }) => claim.nodeId === boundaryNodeId && claim.kind === "git_push",
    );
    if (pushed?.status !== "confirmed" || !pushed.result)
      throw new Error(`The GitHub lifecycle has no confirmed push for ${boundaryNodeId}`);
    const branch = pushed.claim.precondition.branch;
    const remote = pushed.claim.precondition.remote;
    const remoteUrl = pushed.claim.precondition.remoteUrl;
    const sha = pushed.result.sha;
    if (
      branch !== originalExpected.headRefName ||
      remote !== originalExpected.remote ||
      remoteUrl !== originalExpected.remoteUrl ||
      typeof sha !== "string"
    )
      throw new Error(`The repair push ${boundaryNodeId} does not preserve the pull-request head`);
    expected = { ...originalExpected, headSha: sha };
  }
  const wait = state.waits.find(({ nodeId }) => nodeId === node.id);
  if (wait?.bindingBaseSha) expected = { ...expected, baseSha: wait.bindingBaseSha };
  return {
    pullRequestClaim: pullRequest.claim,
    pullRequestResult,
    expected,
    number,
  };
}

function lifecycleProjection(
  snapshot: Awaited<ReturnType<typeof captureGitHubPullRequestSnapshot>>,
  classification: GitHubPullRequestLifecycleClassification,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    contentTrust: snapshot.contentTrust,
    snapshotId: snapshot.snapshotId,
    repository: {
      nameWithOwner: snapshot.repository.nameWithOwner,
      host: snapshot.repository.host,
      viewerPermission: snapshot.repository.viewerPermission,
    },
    pullRequest: {
      number: snapshot.pullRequest.number,
      url: snapshot.pullRequest.url,
      state: snapshot.pullRequest.state,
      isDraft: snapshot.pullRequest.isDraft,
      headRefName: snapshot.pullRequest.headRefName,
      baseRefName: snapshot.pullRequest.baseRefName,
      headSha: snapshot.pullRequest.headSha,
      baseSha: snapshot.pullRequest.baseSha,
      mergeable: snapshot.pullRequest.mergeable,
      ...(snapshot.pullRequest.reviewDecision
        ? { reviewDecision: snapshot.pullRequest.reviewDecision }
        : {}),
      updatedAt: snapshot.pullRequest.updatedAt,
    },
    binding: snapshot.binding,
    branchProtection: snapshot.branchProtection,
    requiredChecks: snapshot.requiredChecks,
    checks: snapshot.checks.map(({ id, databaseId, kind, name, status, conclusion, appId }) => ({
      id,
      ...(databaseId !== undefined ? { databaseId } : {}),
      kind,
      name,
      status,
      ...(conclusion ? { conclusion } : {}),
      ...(appId !== undefined ? { appId } : {}),
    })),
    reviewThreads: snapshot.reviewThreads.map(
      ({ id, isResolved, isOutdated, path, line, commentCount, latestComment }) => ({
        id,
        isResolved,
        isOutdated,
        ...(path ? { path } : {}),
        ...(line !== undefined ? { line } : {}),
        commentCount,
        ...(latestComment
          ? {
              latestComment: {
                id: latestComment.id,
                url: latestComment.url,
                createdAt: latestComment.createdAt,
              },
            }
          : {}),
      }),
    ),
    reviews: snapshot.reviews,
    classification,
    rateLimit: snapshot.rateLimit,
  };
}

export async function capturePullRequestLifecycleProbe(
  workspace: RunWorkspace,
  contract: RunContract,
  claim: SideEffectClaim,
  result: Record<string, unknown>,
  spec: GitHubSnapshotProbe,
  options: GitHubExecutionOptions = {},
): Promise<CapturedPullRequestLifecycle> {
  if (claim.kind !== "github_pr_create")
    throw new Error(`Side effect ${claim.actionId} is not a pull-request creation`);
  const expected = pullRequestPrecondition(claim);
  const number = result.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0)
    throw new Error(`Pull-request result for ${claim.actionId} has no valid number`);
  return await captureExpectedPullRequestLifecycle(
    workspace,
    contract,
    expected,
    number,
    spec,
    result.headSha === expected.headSha && result.baseSha === expected.baseSha,
    options,
  );
}

async function captureExpectedPullRequestLifecycle(
  workspace: RunWorkspace,
  contract: RunContract,
  expected: PullRequestPrecondition,
  number: number,
  spec: GitHubSnapshotProbe,
  resultBindingMatches: boolean,
  options: GitHubExecutionOptions,
): Promise<CapturedPullRequestLifecycle> {
  const started = performance.now();
  const github = commandOptions(workspace, options);
  await assertCurrentRemoteBinding(workspace, expected);
  const snapshot = await captureGitHubPullRequestSnapshot({ ...github, pullRequest: number });
  await assertGitHubSnapshotCurrent(github, snapshot);

  const expectedState = spec.expectedState.toUpperCase();
  const actionBindingMatchesContract =
    (contract.finishLine.kind === "pr_open" || contract.finishLine.kind === "pr_green") &&
    expected.baseRefName === contract.repository.baseRef &&
    resultBindingMatches;
  const classification = classifyGitHubPullRequestLifecycle(snapshot, {
    host: expected.host,
    nameWithOwner: expected.nameWithOwner,
    number,
    headRefName: expected.headRefName,
    baseRefName: expected.baseRefName,
    headSha: expected.headSha,
    baseSha: expected.baseSha,
  });
  const counts = classification.counts;
  const stateMatches = snapshot.pullRequest.state.toUpperCase() === expectedState;
  const checksMatch =
    spec.requiredChecks === "observe" ||
    (counts.requiredChecksSucceeded === counts.requiredChecksTotal &&
      counts.requiredChecksPending === 0 &&
      counts.requiredChecksActionableFailure === 0 &&
      counts.requiredChecksInfrastructureFailure === 0 &&
      counts.requiredChecksCancelled === 0 &&
      counts.requiredChecksMissingOrUnknown === 0);
  const reviewsMatch = spec.reviewThreads === "observe" || counts.unresolvedReviewThreads === 0;
  const passed =
    actionBindingMatchesContract &&
    classification.status !== "stale" &&
    classification.status !== "blocked" &&
    stateMatches &&
    checksMatch &&
    reviewsMatch;
  const summary = classification.evidence.join("; ");
  const reviewFeedback = currentReviewFeedback(snapshot);
  const reviewFeedbackSignature = contentHash(
    reviewFeedback.map(({ threadId, path, line, commentCount, latestComment }) => ({
      threadId,
      path: path ?? null,
      line: line ?? null,
      commentCount,
      latestComment: latestComment
        ? {
            id: latestComment.id,
            author: latestComment.author ?? null,
            bodyHash: contentHash(latestComment.body),
            url: latestComment.url,
            createdAt: latestComment.createdAt,
          }
        : null,
    })),
  );
  const actionableCheckIds = new Set(classification.checkIds.actionable);
  const ciFailures = snapshot.checks
    .filter(({ id }) => actionableCheckIds.has(id))
    .map(({ id, kind, name, status, conclusion, appId, detailsUrl }) => ({
      contentTrust: "untrusted_external" as const,
      id,
      kind,
      name,
      status,
      ...(conclusion ? { conclusion } : {}),
      ...(appId !== undefined ? { appId } : {}),
      ...(detailsUrl ? { detailsUrl } : {}),
    }));
  const ciFailureSignature = contentHash({
    mergeable: snapshot.pullRequest.mergeable,
    failures: ciFailures
      .map(({ kind, name, status, conclusion, appId }) => ({
        kind,
        name,
        status,
        conclusion: conclusion ?? null,
        appId: appId ?? null,
      }))
      .sort((left, right) =>
        `${left.kind}:${left.name}:${left.appId ?? ""}`.localeCompare(
          `${right.kind}:${right.name}:${right.appId ?? ""}`,
        ),
      ),
  });
  const rerunnableCheckIds = new Set([
    ...classification.checkIds.infrastructure,
    ...classification.checkIds.cancelled,
  ]);
  const rerunnableChecks = snapshot.checks
    .filter(
      (check): check is typeof check & { kind: "check_run"; databaseId: number } =>
        rerunnableCheckIds.has(check.id) &&
        check.kind === "check_run" &&
        check.databaseId !== undefined,
    )
    .map(({ id, databaseId, kind, name, status, conclusion, appId, detailsUrl }) => ({
      contentTrust: "untrusted_external" as const,
      id,
      databaseId,
      kind,
      name,
      status,
      ...(conclusion ? { conclusion } : {}),
      ...(appId !== undefined ? { appId } : {}),
      ...(detailsUrl ? { detailsUrl } : {}),
    }));
  return {
    classification,
    reviewFeedback,
    reviewFeedbackSignature,
    ciFailures,
    ciFailureSignature,
    rerunnableChecks,
    pullRequestDecision: {
      isDraft: snapshot.pullRequest.isDraft,
      ...(snapshot.pullRequest.reviewDecision
        ? { reviewDecision: snapshot.pullRequest.reviewDecision }
        : {}),
    },
    result: {
      probeId: spec.id,
      kind: spec.kind,
      passed,
      signature: classification.signature,
      summary,
      durationMs: Math.round(performance.now() - started),
      metrics: {
        requiredChecksTotal: counts.requiredChecksTotal,
        requiredChecksSucceeded: counts.requiredChecksSucceeded,
        requiredChecksPending: counts.requiredChecksPending,
        requiredChecksFailing:
          counts.requiredChecksActionableFailure +
          counts.requiredChecksInfrastructureFailure +
          counts.requiredChecksCancelled +
          counts.requiredChecksMissingOrUnknown,
        requiredChecksActionableFailure: counts.requiredChecksActionableFailure,
        requiredChecksInfrastructureFailure: counts.requiredChecksInfrastructureFailure,
        requiredChecksCancelled: counts.requiredChecksCancelled,
        requiredChecksMissingOrUnknown: counts.requiredChecksMissingOrUnknown,
        unresolvedReviewThreads: counts.unresolvedReviewThreads,
      },
    },
    output: `${JSON.stringify(lifecycleProjection(snapshot, classification), null, 2)}\n`,
  };
}

function reviewReplyPrecondition(claim: SideEffectClaim): ReviewReplyPrecondition {
  const value = claim.precondition;
  const fields = {
    host: value.host,
    nameWithOwner: value.nameWithOwner,
    remote: value.remote,
    remoteUrl: value.remoteUrl,
    headRefName: value.headRefName,
    baseRefName: value.baseRefName,
    headSha: value.headSha,
    baseSha: value.baseSha,
    number: value.number,
    threadId: value.threadId,
    feedbackCommentId: value.feedbackCommentId,
    feedbackBodyHash: value.feedbackBodyHash,
    replyBodyHash: value.replyBodyHash,
  };
  if (
    Object.entries(fields)
      .filter(([name]) => !["number", "feedbackCommentId", "feedbackBodyHash"].includes(name))
      .some(([, field]) => typeof field !== "string") ||
    typeof fields.number !== "number" ||
    !Number.isInteger(fields.number) ||
    fields.number <= 0 ||
    (fields.feedbackCommentId !== null && typeof fields.feedbackCommentId !== "string") ||
    (fields.feedbackBodyHash !== null && typeof fields.feedbackBodyHash !== "string")
  )
    throw new Error(`Review-reply claim ${claim.actionId} has an invalid precondition`);
  return fields as ReviewReplyPrecondition;
}

function reviewResolutionPrecondition(claim: SideEffectClaim): ReviewResolutionPrecondition {
  const value = claim.precondition;
  const fields = {
    host: value.host,
    nameWithOwner: value.nameWithOwner,
    remote: value.remote,
    remoteUrl: value.remoteUrl,
    headRefName: value.headRefName,
    baseRefName: value.baseRefName,
    headSha: value.headSha,
    baseSha: value.baseSha,
    number: value.number,
    threadId: value.threadId,
    replyIdempotencyKey: value.replyIdempotencyKey,
    replyCommentId: value.replyCommentId,
    replyBodyHash: value.replyBodyHash,
  };
  if (
    Object.entries(fields)
      .filter(([name]) => name !== "number")
      .some(([, field]) => typeof field !== "string") ||
    typeof fields.number !== "number" ||
    !Number.isInteger(fields.number) ||
    fields.number <= 0
  )
    throw new Error(`Review-resolution claim ${claim.actionId} has an invalid precondition`);
  return fields as ReviewResolutionPrecondition;
}

function reviewReplyBody(headSha: string, idempotencyKey: string): string {
  return [
    `Addressed in ${headSha} and reverified against the approved Graphcraft completion checks.`,
    "",
    `<!-- Graphcraft-Action: ${idempotencyKey} -->`,
  ].join("\n");
}

async function assertPullRequestBinding(
  workspace: RunWorkspace,
  expected: RemotePullRequestBinding,
  number: number,
  options: GitHubExecutionOptions,
): Promise<string[]> {
  const evidence = await assertCurrentRemoteBinding(workspace, expected);
  const current = await readGitHubPullRequestIdentity(commandOptions(workspace, options), {
    nameWithOwner: expected.nameWithOwner,
    number,
  });
  if (
    current.state !== "OPEN" ||
    current.headRefName !== expected.headRefName ||
    current.baseRefName !== expected.baseRefName ||
    current.headSha !== expected.headSha ||
    current.baseSha !== expected.baseSha
  )
    throw new Error(`Pull request #${number} moved before the review-thread mutation`);
  return [
    ...evidence,
    `Pull request #${number} remains ${expected.headRefName}@${expected.headSha}/${expected.baseRefName}@${expected.baseSha}`,
  ];
}

function createReviewReplyClaim(input: {
  contract: RunContract;
  nodeId: string;
  binding: ReturnType<typeof lifecycleBinding>;
  feedback: GitHubReviewFeedback;
}): SideEffectClaim {
  const actionId = contentHash({
    schemaVersion: 1,
    runId: input.contract.runId,
    nodeId: input.nodeId,
    kind: "github_pr_comment",
    threadId: input.feedback.threadId,
    headSha: input.binding.expected.headSha,
  });
  const idempotencyKey = `graphcraft-${actionId}`;
  const body = reviewReplyBody(input.binding.expected.headSha, idempotencyKey);
  return SideEffectClaimSchema.parse({
    schemaVersion: 1,
    actionId,
    idempotencyKey,
    nodeId: input.nodeId,
    kind: "github_pr_comment",
    target: `${input.binding.expected.nameWithOwner}#${input.binding.number}:${input.feedback.threadId}`,
    precondition: {
      ...input.binding.expected,
      number: input.binding.number,
      threadId: input.feedback.threadId,
      feedbackCommentId: input.feedback.latestComment?.id ?? null,
      feedbackBodyHash: input.feedback.latestComment
        ? contentHash(input.feedback.latestComment.body)
        : null,
      replyBodyHash: contentHash(body),
    } satisfies ReviewReplyPrecondition,
    claimedAt: new Date().toISOString(),
  });
}

async function reconcileReviewReply(
  workspace: RunWorkspace,
  claim: SideEffectClaim,
  options: GitHubExecutionOptions,
): Promise<SideEffectReconciliation> {
  if (claim.kind !== "github_pr_comment")
    throw new Error(`Side effect ${claim.actionId} is not a review reply`);
  const expected = reviewReplyPrecondition(claim);
  let evidence: string[];
  try {
    evidence = await assertPullRequestBinding(workspace, expected, expected.number, options);
  } catch (error) {
    return {
      status: "unknown",
      evidence: [error instanceof Error ? error.message : String(error)],
    };
  }
  const thread = await readGitHubReviewThread(commandOptions(workspace, options), {
    host: expected.host,
    threadId: expected.threadId,
  });
  const marker = `<!-- Graphcraft-Action: ${claim.idempotencyKey} -->`;
  const replies = thread.comments.filter(({ body }) => body.includes(marker));
  if (replies.length === 1 && contentHash(replies[0]!.body) === expected.replyBodyHash)
    return {
      status: "applied",
      result: { threadId: thread.id, commentId: replies[0]!.id, url: replies[0]!.url },
      evidence: [...evidence, `Review thread ${thread.id} contains the exact action reply`],
    };
  if (replies.length > 0)
    return {
      status: "unknown",
      evidence: [...evidence, `Review thread ${thread.id} has an ambiguous action reply`],
    };
  const latest = thread.comments.at(-1);
  const feedbackMatches =
    (expected.feedbackCommentId === null
      ? latest === undefined
      : latest?.id === expected.feedbackCommentId) &&
    (expected.feedbackBodyHash === null
      ? latest === undefined
      : latest !== undefined && contentHash(latest.body) === expected.feedbackBodyHash);
  if (thread.isResolved || thread.isOutdated || !feedbackMatches)
    return {
      status: "unknown",
      evidence: [
        ...evidence,
        `Review thread ${thread.id} changed before the claimed reply could be confirmed`,
      ],
    };
  return {
    status: "not_applied",
    evidence: [...evidence, `Review thread ${thread.id} has no action reply yet`],
  };
}

async function performReviewReply(
  workspace: RunWorkspace,
  claim: SideEffectClaim,
  options: GitHubExecutionOptions,
  boundary?: (point: SideEffectBoundary) => void | Promise<void>,
): Promise<Record<string, unknown>> {
  const expected = reviewReplyPrecondition(claim);
  await assertPullRequestBinding(workspace, expected, expected.number, options);
  const thread = await readGitHubReviewThread(commandOptions(workspace, options), {
    host: expected.host,
    threadId: expected.threadId,
  });
  const latest = thread.comments.at(-1);
  if (
    thread.isResolved ||
    thread.isOutdated ||
    (expected.feedbackCommentId === null
      ? latest !== undefined
      : latest?.id !== expected.feedbackCommentId) ||
    (expected.feedbackBodyHash !== null &&
      (!latest || contentHash(latest.body) !== expected.feedbackBodyHash))
  )
    throw new Error(`Review thread ${expected.threadId} moved before reply`);
  const body = reviewReplyBody(expected.headSha, claim.idempotencyKey);
  if (contentHash(body) !== expected.replyBodyHash)
    throw new Error(`Review reply body changed for side effect ${claim.actionId}`);
  await crossSideEffectBoundary(boundary, "after_action_prepare");
  const reply = await addGitHubReviewThreadReply(commandOptions(workspace, options), {
    host: expected.host,
    threadId: expected.threadId,
    body,
    clientMutationId: claim.idempotencyKey,
  });
  await crossSideEffectBoundary(boundary, "after_action_command");
  return { threadId: expected.threadId, commentId: reply.id, url: reply.url };
}

function createReviewResolutionClaim(input: {
  contract: RunContract;
  nodeId: string;
  binding: ReturnType<typeof lifecycleBinding>;
  feedback: GitHubReviewFeedback;
  replyClaim: SideEffectClaim;
  replyResult: Record<string, unknown>;
}): SideEffectClaim {
  const commentId = input.replyResult.commentId;
  if (typeof commentId !== "string")
    throw new Error(`Review reply ${input.replyClaim.actionId} has no confirmed comment ID`);
  const actionId = contentHash({
    schemaVersion: 1,
    runId: input.contract.runId,
    nodeId: input.nodeId,
    kind: "github_review_thread_resolve",
    threadId: input.feedback.threadId,
    headSha: input.binding.expected.headSha,
  });
  return SideEffectClaimSchema.parse({
    schemaVersion: 1,
    actionId,
    idempotencyKey: `graphcraft-${actionId}`,
    nodeId: input.nodeId,
    kind: "github_review_thread_resolve",
    target: `${input.binding.expected.nameWithOwner}#${input.binding.number}:${input.feedback.threadId}`,
    precondition: {
      ...input.binding.expected,
      number: input.binding.number,
      threadId: input.feedback.threadId,
      replyIdempotencyKey: input.replyClaim.idempotencyKey,
      replyCommentId: commentId,
      replyBodyHash: reviewReplyPrecondition(input.replyClaim).replyBodyHash,
    } satisfies ReviewResolutionPrecondition,
    claimedAt: new Date().toISOString(),
  });
}

async function reconcileReviewResolution(
  workspace: RunWorkspace,
  claim: SideEffectClaim,
  options: GitHubExecutionOptions,
): Promise<SideEffectReconciliation> {
  if (claim.kind !== "github_review_thread_resolve")
    throw new Error(`Side effect ${claim.actionId} is not a review-thread resolution`);
  const expected = reviewResolutionPrecondition(claim);
  let evidence: string[];
  try {
    evidence = await assertPullRequestBinding(workspace, expected, expected.number, options);
  } catch (error) {
    return {
      status: "unknown",
      evidence: [error instanceof Error ? error.message : String(error)],
    };
  }
  const thread = await readGitHubReviewThread(commandOptions(workspace, options), {
    host: expected.host,
    threadId: expected.threadId,
  });
  const reply = thread.comments.find(
    ({ id, body }) =>
      id === expected.replyCommentId &&
      body.includes(`<!-- Graphcraft-Action: ${expected.replyIdempotencyKey} -->`) &&
      contentHash(body) === expected.replyBodyHash,
  );
  if (!reply)
    return {
      status: "unknown",
      evidence: [...evidence, `Review thread ${thread.id} lost its confirmed action reply`],
    };
  if (!thread.isResolved && thread.comments.at(-1)?.id !== reply.id)
    return {
      status: "unknown",
      evidence: [
        ...evidence,
        `Review thread ${thread.id} received newer feedback after the action reply`,
      ],
    };
  return thread.isResolved
    ? {
        status: "applied",
        result: { threadId: thread.id, resolved: true, replyCommentId: reply.id },
        evidence: [...evidence, `Review thread ${thread.id} is resolved after the action reply`],
      }
    : {
        status: "not_applied",
        evidence: [...evidence, `Review thread ${thread.id} remains unresolved`],
      };
}

async function performReviewResolution(
  workspace: RunWorkspace,
  claim: SideEffectClaim,
  options: GitHubExecutionOptions,
  boundary?: (point: SideEffectBoundary) => void | Promise<void>,
): Promise<Record<string, unknown>> {
  const expected = reviewResolutionPrecondition(claim);
  await assertPullRequestBinding(workspace, expected, expected.number, options);
  const thread = await readGitHubReviewThread(commandOptions(workspace, options), {
    host: expected.host,
    threadId: expected.threadId,
  });
  const reply = thread.comments.find(
    ({ id, body }) =>
      id === expected.replyCommentId &&
      body.includes(`<!-- Graphcraft-Action: ${expected.replyIdempotencyKey} -->`) &&
      contentHash(body) === expected.replyBodyHash,
  );
  if (!reply || thread.isResolved || thread.comments.at(-1)?.id !== reply.id)
    throw new Error(`Review thread ${expected.threadId} is not ready for resolution`);
  await crossSideEffectBoundary(boundary, "after_action_prepare");
  const resolved = await resolveGitHubReviewThread(commandOptions(workspace, options), {
    host: expected.host,
    threadId: expected.threadId,
    clientMutationId: claim.idempotencyKey,
  });
  await crossSideEffectBoundary(boundary, "after_action_command");
  return { threadId: resolved.id, resolved: resolved.isResolved, replyCommentId: reply.id };
}

function checkRerunPrecondition(claim: SideEffectClaim): CheckRerunPrecondition {
  const value = claim.precondition;
  const fields = {
    host: value.host,
    nameWithOwner: value.nameWithOwner,
    remote: value.remote,
    remoteUrl: value.remoteUrl,
    headRefName: value.headRefName,
    baseRefName: value.baseRefName,
    headSha: value.headSha,
    baseSha: value.baseSha,
    number: value.number,
    checkId: value.checkId,
    databaseId: value.databaseId,
    checkName: value.checkName,
    checkStatus: value.checkStatus,
    checkConclusion: value.checkConclusion,
    appId: value.appId,
  };
  if (
    Object.entries(fields)
      .filter(([name]) => !["number", "databaseId", "checkConclusion", "appId"].includes(name))
      .some(([, field]) => typeof field !== "string") ||
    typeof fields.number !== "number" ||
    !Number.isInteger(fields.number) ||
    fields.number <= 0 ||
    typeof fields.databaseId !== "number" ||
    !Number.isInteger(fields.databaseId) ||
    fields.databaseId <= 0 ||
    (fields.checkConclusion !== null && typeof fields.checkConclusion !== "string") ||
    (fields.appId !== null && (typeof fields.appId !== "number" || !Number.isInteger(fields.appId)))
  )
    throw new Error(`Check-rerun claim ${claim.actionId} has an invalid precondition`);
  return fields as CheckRerunPrecondition;
}

async function currentBoundCheck(
  workspace: RunWorkspace,
  expected: CheckRerunPrecondition,
  options: GitHubExecutionOptions,
): Promise<{
  evidence: string[];
  check: Awaited<ReturnType<typeof captureGitHubPullRequestSnapshot>>["checks"][number] | undefined;
}> {
  const evidence = await assertPullRequestBinding(workspace, expected, expected.number, options);
  const github = commandOptions(workspace, options);
  const snapshot = await captureGitHubPullRequestSnapshot({
    ...github,
    pullRequest: expected.number,
  });
  await assertGitHubSnapshotCurrent(github, snapshot);
  if (
    snapshot.repository.host !== expected.host ||
    snapshot.repository.nameWithOwner !== expected.nameWithOwner ||
    snapshot.binding.headSha !== expected.headSha ||
    snapshot.binding.baseSha !== expected.baseSha
  )
    throw new Error(`Check-rerun snapshot moved from ${expected.headSha}/${expected.baseSha}`);
  const check = snapshot.checks.find(
    ({ id, databaseId }) => id === expected.checkId && databaseId === expected.databaseId,
  );
  return { evidence, check };
}

function createCheckRerunClaim(input: {
  contract: RunContract;
  nodeId: string;
  binding: ReturnType<typeof lifecycleBinding>;
  check: GitHubCheckRerunEvidence;
}): SideEffectClaim {
  const actionId = contentHash({
    schemaVersion: 1,
    runId: input.contract.runId,
    nodeId: input.nodeId,
    kind: "github_check_rerun",
    headSha: input.binding.expected.headSha,
    checkId: input.check.id,
    databaseId: input.check.databaseId,
    status: input.check.status,
    conclusion: input.check.conclusion ?? null,
  });
  return SideEffectClaimSchema.parse({
    schemaVersion: 1,
    actionId,
    idempotencyKey: `graphcraft-${actionId}`,
    nodeId: input.nodeId,
    kind: "github_check_rerun",
    target: `${input.binding.expected.nameWithOwner}#${input.binding.number}:${input.check.name}`,
    precondition: {
      ...input.binding.expected,
      number: input.binding.number,
      checkId: input.check.id,
      databaseId: input.check.databaseId,
      checkName: input.check.name,
      checkStatus: input.check.status,
      checkConclusion: input.check.conclusion ?? null,
      appId: input.check.appId ?? null,
    } satisfies CheckRerunPrecondition,
    claimedAt: new Date().toISOString(),
  });
}

async function reconcileCheckRerun(
  workspace: RunWorkspace,
  claim: SideEffectClaim,
  options: GitHubExecutionOptions,
): Promise<SideEffectReconciliation> {
  if (claim.kind !== "github_check_rerun")
    throw new Error(`Side effect ${claim.actionId} is not a check rerun`);
  const expected = checkRerunPrecondition(claim);
  let current: Awaited<ReturnType<typeof currentBoundCheck>>;
  try {
    current = await currentBoundCheck(workspace, expected, options);
  } catch (error) {
    return {
      status: "unknown",
      evidence: [error instanceof Error ? error.message : String(error)],
    };
  }
  const check = current.check;
  if (!check)
    return {
      status: "unknown",
      evidence: [
        ...current.evidence,
        `Check run ${expected.checkId}/${expected.databaseId} is no longer observable`,
      ],
    };
  if (
    check.name !== expected.checkName ||
    (check.appId ?? null) !== expected.appId ||
    check.kind !== "check_run"
  )
    return {
      status: "unknown",
      evidence: [...current.evidence, `Check run ${expected.checkId} changed identity`],
    };
  const unchanged =
    check.status === expected.checkStatus &&
    (check.conclusion ?? null) === expected.checkConclusion;
  return unchanged
    ? {
        status: "not_applied",
        evidence: [...current.evidence, `Check run ${expected.checkId} has not transitioned`],
      }
    : {
        status: "applied",
        result: {
          checkId: check.id,
          databaseId: expected.databaseId,
          headSha: expected.headSha,
          status: check.status,
          conclusion: check.conclusion ?? null,
        },
        evidence: [
          ...current.evidence,
          `Check run ${expected.checkId} transitioned from ${expected.checkStatus}/${expected.checkConclusion ?? "none"} to ${check.status}/${check.conclusion ?? "none"}`,
        ],
      };
}

async function performCheckRerun(
  workspace: RunWorkspace,
  claim: SideEffectClaim,
  options: GitHubExecutionOptions,
  boundary?: (point: SideEffectBoundary) => void | Promise<void>,
): Promise<Record<string, unknown>> {
  const expected = checkRerunPrecondition(claim);
  const current = await currentBoundCheck(workspace, expected, options);
  const check = current.check;
  if (
    !check ||
    check.kind !== "check_run" ||
    check.name !== expected.checkName ||
    check.status !== expected.checkStatus ||
    (check.conclusion ?? null) !== expected.checkConclusion
  )
    throw new Error(`Check run ${expected.checkId} moved before rerun`);
  await crossSideEffectBoundary(boundary, "after_action_prepare");
  await rerequestGitHubCheckRun(commandOptions(workspace, options), {
    host: expected.host,
    nameWithOwner: expected.nameWithOwner,
    databaseId: expected.databaseId,
  });
  await crossSideEffectBoundary(boundary, "after_action_command");
  return { checkId: expected.checkId, databaseId: expected.databaseId };
}

export async function rerunLifecycleChecks(input: {
  store: RunStore;
  node: GraphNode;
  workspace: RunWorkspace;
  contract: RunContract;
  lifecycle: CapturedPullRequestLifecycle;
  options?: GitHubExecutionOptions;
  boundary?: (point: SideEffectBoundary) => void | Promise<void>;
}): Promise<string[]> {
  const classification = input.lifecycle.classification;
  const relevantIds =
    classification.status === "infrastructure_failure"
      ? classification.checkIds.infrastructure
      : classification.status === "cancelled"
        ? classification.checkIds.cancelled
        : [];
  const rerunnableIds = new Set(input.lifecycle.rerunnableChecks.map(({ id }) => id));
  if (
    relevantIds.length === 0 ||
    relevantIds.some((id) => !rerunnableIds.has(id)) ||
    input.lifecycle.rerunnableChecks.some(({ id }) => !relevantIds.includes(id))
  )
    throw new Error(
      "The infrastructure or cancelled required-check state is not fully rerunnable as GitHub check runs",
    );
  const state = await input.store.loadState();
  const alreadyRequested = new Set(
    state.sideEffects
      .filter(
        ({ claim }) =>
          claim.kind === "github_check_rerun" &&
          claim.nodeId === input.node.id &&
          claim.precondition.headSha === lifecycleBinding(state, input.node).expected.headSha,
      )
      .map(
        ({ claim }) =>
          `${String(claim.precondition.checkName)}:${String(claim.precondition.appId ?? "")}`,
      ),
  );
  const pending = input.lifecycle.rerunnableChecks.filter(
    ({ name, appId }) => !alreadyRequested.has(`${name}:${String(appId ?? "")}`),
  );
  if (pending.length === 0)
    throw new Error(
      "The same infrastructure or cancelled required check remained after one justified rerun",
    );
  const binding = lifecycleBinding(state, input.node);
  const options = input.options ?? {};
  const evidence: string[] = [];
  for (const check of pending.sort((left, right) => left.id.localeCompare(right.id))) {
    const claim = createCheckRerunClaim({
      contract: input.contract,
      nodeId: input.node.id,
      binding,
      check,
    });
    const result = await executeSideEffect({
      store: input.store,
      claim,
      reconcile: async (currentClaim) =>
        await reconcileCheckRerun(input.workspace, currentClaim, options),
      act: async (currentClaim) =>
        await performCheckRerun(input.workspace, currentClaim, options, input.boundary),
      durableDispatch: true,
      ...(input.boundary ? { boundary: input.boundary } : {}),
    });
    evidence.push(
      `Justified one rerun for ${check.name} at ${binding.expected.headSha}`,
      `Check ${String(result.checkId)} transitioned to ${String(result.status)}`,
    );
  }
  return evidence;
}

export function hasReviewThreadActions(
  state: RunState,
  lifecycle: CapturedPullRequestLifecycle,
): boolean {
  const threadIds = new Set(lifecycle.reviewFeedback.map(({ threadId }) => threadId));
  return state.sideEffects.some(
    ({ claim }) =>
      ["github_pr_comment", "github_review_thread_resolve"].includes(claim.kind) &&
      typeof claim.precondition.threadId === "string" &&
      threadIds.has(claim.precondition.threadId),
  );
}

export async function reconcileReviewThreadActions(input: {
  store: RunStore;
  node: GraphNode;
  workspace: RunWorkspace;
  contract: RunContract;
  lifecycle: CapturedPullRequestLifecycle;
  options?: GitHubExecutionOptions;
  boundary?: (point: SideEffectBoundary) => void | Promise<void>;
}): Promise<string[]> {
  const options = input.options ?? {};
  const evidence: string[] = [];
  for (const feedback of [...input.lifecycle.reviewFeedback].sort((left, right) =>
    left.threadId.localeCompare(right.threadId),
  )) {
    let state = await input.store.loadState();
    const binding = lifecycleBinding(state, input.node);
    const existingReply = state.sideEffects.find(
      ({ claim }) =>
        claim.kind === "github_pr_comment" &&
        claim.precondition.threadId === feedback.threadId &&
        claim.precondition.headSha === binding.expected.headSha,
    )?.claim;
    const replyClaim =
      existingReply ??
      createReviewReplyClaim({
        contract: input.contract,
        nodeId: input.node.id,
        binding,
        feedback,
      });
    const replyResult = await executeSideEffect({
      store: input.store,
      claim: replyClaim,
      reconcile: async (claim) => await reconcileReviewReply(input.workspace, claim, options),
      act: async (claim) =>
        await performReviewReply(input.workspace, claim, options, input.boundary),
      revalidateConfirmed: true,
      ...(input.boundary ? { boundary: input.boundary } : {}),
    });
    state = await input.store.loadState();
    const existingResolution = state.sideEffects.find(
      ({ claim }) =>
        claim.kind === "github_review_thread_resolve" &&
        claim.precondition.threadId === feedback.threadId &&
        claim.precondition.headSha === binding.expected.headSha,
    )?.claim;
    const resolutionClaim =
      existingResolution ??
      createReviewResolutionClaim({
        contract: input.contract,
        nodeId: input.node.id,
        binding,
        feedback,
        replyClaim,
        replyResult,
      });
    const resolutionResult = await executeSideEffect({
      store: input.store,
      claim: resolutionClaim,
      reconcile: async (claim) => await reconcileReviewResolution(input.workspace, claim, options),
      act: async (claim) =>
        await performReviewResolution(input.workspace, claim, options, input.boundary),
      revalidateConfirmed: true,
      ...(input.boundary ? { boundary: input.boundary } : {}),
    });
    evidence.push(
      `Replied to and resolved review thread ${feedback.threadId} at ${binding.expected.headSha}`,
      `Reply ${String(replyResult.commentId)}; resolution ${String(resolutionResult.resolved)}`,
    );
  }
  return evidence;
}

export async function reconcilePendingGitHubActions(input: {
  store: RunStore;
  node: GraphNode;
  workspace: RunWorkspace;
  options?: GitHubExecutionOptions;
  boundary?: (point: SideEffectBoundary) => void | Promise<void>;
}): Promise<string[]> {
  const options = input.options ?? {};
  const state = await input.store.loadState();
  const pending = state.sideEffects.filter(
    ({ claim, status }) =>
      claim.nodeId === input.node.id &&
      ["github_pr_comment", "github_review_thread_resolve", "github_check_rerun"].includes(
        claim.kind,
      ) &&
      status !== "confirmed",
  );
  const evidence: string[] = [];
  for (const entry of pending) {
    const result = await executeSideEffect({
      store: input.store,
      claim: entry.claim,
      reconcile: async (claim) => {
        if (claim.kind === "github_pr_comment")
          return await reconcileReviewReply(input.workspace, claim, options);
        if (claim.kind === "github_review_thread_resolve")
          return await reconcileReviewResolution(input.workspace, claim, options);
        return await reconcileCheckRerun(input.workspace, claim, options);
      },
      act: async (claim) => {
        if (claim.kind === "github_pr_comment")
          return await performReviewReply(input.workspace, claim, options, input.boundary);
        if (claim.kind === "github_review_thread_resolve")
          return await performReviewResolution(input.workspace, claim, options, input.boundary);
        return await performCheckRerun(input.workspace, claim, options, input.boundary);
      },
      revalidateConfirmed: true,
      ...(entry.claim.kind === "github_check_rerun" ? { durableDispatch: true } : {}),
      ...(input.boundary ? { boundary: input.boundary } : {}),
    });
    evidence.push(
      `Reconciled pending ${entry.claim.kind} ${entry.claim.actionId}`,
      `External target ${String(result.threadId ?? result.checkId)} is confirmed`,
    );
  }
  return evidence;
}

export type GitHubLifecycleWaitOutcome =
  | {
      status: "satisfied";
      evidence: string[];
      lifecycle?: CapturedPullRequestLifecycle;
    }
  | {
      status: "action_required";
      evidence: string[];
      lifecycle: CapturedPullRequestLifecycle;
    }
  | {
      status: "timed_out";
      evidence: string[];
      lifecycle?: CapturedPullRequestLifecycle;
    }
  | {
      status: "waiting";
      nextWakeAt: string;
      evidence: string[];
      lifecycle?: CapturedPullRequestLifecycle;
    };

export async function evaluateGitHubLifecycleWait(input: {
  store: RunStore;
  node: GraphNode;
  workspace: RunWorkspace;
  contract: RunContract;
  options?: GitHubExecutionOptions;
  now?: number;
}): Promise<GitHubLifecycleWaitOutcome> {
  const condition = input.node.waitCondition;
  if (input.node.kind !== "wait" || condition?.kind !== "github_pull_request")
    throw new Error(`Node ${input.node.id} is not a GitHub lifecycle wait`);
  const now = input.now ?? Date.now();
  let state = await input.store.loadState();
  let binding = lifecycleBinding(state, input.node);
  let wait = state.waits.find(({ nodeId }) => nodeId === input.node.id);
  if (!wait) {
    const registeredAt = new Date(now).toISOString();
    wait = WaitRuntimeStateSchema.parse({
      nodeId: input.node.id,
      condition,
      workspacePath: input.workspace.path,
      status: "waiting",
      registeredAt,
      bindingBaseSha: binding.expected.baseSha,
      nextWakeAt: registeredAt,
      observations: 0,
      evidence: [],
      updatedAt: registeredAt,
    });
    await input.store.append("runtime", "wait.registered", { wait }, input.node.id);
    state = await input.store.loadState();
  }
  if (wait.status === "satisfied") return { status: "satisfied", evidence: wait.evidence };
  if (wait.status === "timed_out") return { status: "timed_out", evidence: wait.evidence };
  if (now < Date.parse(wait.nextWakeAt))
    return { status: "waiting", nextWakeAt: wait.nextWakeAt, evidence: wait.evidence };

  binding = lifecycleBinding(state, input.node);
  const baseMovementEvidence: string[] = [];
  const observedBaseSha = await remoteBranchSha(
    input.workspace,
    binding.expected.remote,
    binding.expected.baseRefName,
  );
  if (!observedBaseSha)
    throw new Error(`Remote base branch ${binding.expected.baseRefName} is absent`);
  if (observedBaseSha !== binding.expected.baseSha) {
    const rebound = { ...binding.expected, baseSha: observedBaseSha };
    const evidence = await assertCurrentRemoteBinding(input.workspace, rebound);
    const pullRequest = await readGitHubPullRequestIdentity(
      commandOptions(input.workspace, input.options),
      {
        nameWithOwner: rebound.nameWithOwner,
        number: binding.number,
      },
    );
    if (
      pullRequest.state !== "OPEN" ||
      pullRequest.headRefName !== rebound.headRefName ||
      pullRequest.baseRefName !== rebound.baseRefName ||
      pullRequest.headSha !== rebound.headSha ||
      pullRequest.baseSha !== rebound.baseSha
    )
      throw new Error(
        `Pull request #${binding.number} did not preserve its exact head while base ${rebound.baseRefName} moved to ${observedBaseSha}`,
      );
    baseMovementEvidence.push(
      `Rebound ${rebound.baseRefName} from ${binding.expected.baseSha} to ${observedBaseSha} without mutating the PR head`,
      ...evidence,
    );
    await input.store.append(
      "runtime",
      "wait.rebound",
      {
        nodeId: input.node.id,
        previousBaseSha: binding.expected.baseSha,
        baseSha: observedBaseSha,
        headSha: rebound.headSha,
        evidence: baseMovementEvidence,
      },
      input.node.id,
    );
    state = await input.store.loadState();
    wait = state.waits.find(({ nodeId }) => nodeId === input.node.id);
    if (!wait) throw new Error(`Wait node ${input.node.id} disappeared after base rebind`);
    binding = lifecycleBinding(state, input.node);
  }
  const originalExpected = pullRequestPrecondition(binding.pullRequestClaim);
  const boundaryNodeId = input.node.dependsOn[0];
  let lifecycle = await captureExpectedPullRequestLifecycle(
    input.workspace,
    input.contract,
    binding.expected,
    binding.number,
    {
      id: `${input.node.id}-lifecycle`,
      kind: "github_snapshot",
      pullRequest: "run_branch",
      expectedState: "open",
      requiredChecks: "success",
      reviewThreads: "resolved",
    },
    binding.pullRequestResult.baseSha === originalExpected.baseSha &&
      (boundaryNodeId !== binding.pullRequestClaim.nodeId ||
        binding.pullRequestResult.headSha === originalExpected.headSha),
    input.options ?? {},
  );
  const observedHumanDecision = lifecycle.pullRequestDecision.isDraft
    ? "draft"
    : lifecycle.pullRequestDecision.reviewDecision === "CHANGES_REQUESTED"
      ? "changes_requested"
      : undefined;
  if (observedHumanDecision && wait.stickyHumanDecision?.kind !== observedHumanDecision) {
    await input.store.append(
      "runtime",
      "wait.human_decision_observed",
      {
        nodeId: input.node.id,
        kind: observedHumanDecision,
        snapshotId: lifecycle.classification.snapshotId,
        evidence: [
          observedHumanDecision === "draft"
            ? "The pull request requires a human to mark it ready"
            : "A human review requested changes",
        ],
      },
      input.node.id,
    );
  } else if (
    wait.stickyHumanDecision &&
    ((wait.stickyHumanDecision.kind === "draft" && !lifecycle.pullRequestDecision.isDraft) ||
      (wait.stickyHumanDecision.kind === "changes_requested" &&
        lifecycle.pullRequestDecision.reviewDecision === "APPROVED"))
  ) {
    await input.store.append(
      "runtime",
      "wait.human_decision_resolved",
      {
        nodeId: input.node.id,
        kind: wait.stickyHumanDecision.kind,
        snapshotId: lifecycle.classification.snapshotId,
      },
      input.node.id,
    );
  }
  state = await input.store.loadState();
  wait = state.waits.find(({ nodeId }) => nodeId === input.node.id);
  if (!wait) throw new Error(`Wait node ${input.node.id} disappeared during lifecycle capture`);
  if (
    wait.stickyHumanDecision?.kind === "changes_requested" &&
    lifecycle.classification.counts.unresolvedReviewThreads === 0 &&
    lifecycle.pullRequestDecision.reviewDecision !== "APPROVED"
  ) {
    const stickyEvidence = [
      ...lifecycle.classification.evidence,
      "The earlier human changes-requested decision remains sticky until an explicit approval",
    ];
    const signature = contentHash({
      snapshotId: lifecycle.classification.snapshotId,
      status: "human_decision",
      stickyHumanDecision: wait.stickyHumanDecision,
    });
    const classification = {
      ...lifecycle.classification,
      status: "human_decision" as const,
      signature,
      evidence: stickyEvidence,
    };
    lifecycle = {
      ...lifecycle,
      classification,
      result: {
        ...lifecycle.result,
        passed: false,
        signature,
        summary: stickyEvidence.join("; "),
      },
      ...(lifecycle.output
        ? {
            output: `${JSON.stringify(
              {
                ...(JSON.parse(lifecycle.output) as Record<string, unknown>),
                stickyHumanDecision: wait.stickyHumanDecision,
                classification,
              },
              null,
              2,
            )}\n`,
          }
        : {}),
    };
  }
  if (lifecycle.output) {
    lifecycle.result.artifact = await input.store.writeArtifact(
      `probes/${lifecycle.result.signature}.log`,
      lifecycle.output,
    );
  }
  const evidence = [...baseMovementEvidence, ...lifecycle.classification.evidence];
  const timedOut = condition.timeoutAt && now >= Date.parse(condition.timeoutAt);
  if (timedOut) {
    const timeoutEvidence = [
      ...evidence,
      `GitHub lifecycle wait timed out at ${condition.timeoutAt}`,
    ];
    await input.store.append(
      "runtime",
      "wait.timed_out",
      {
        nodeId: input.node.id,
        evidence: timeoutEvidence,
        signature: lifecycle.classification.signature,
        probeResult: lifecycle.result,
      },
      input.node.id,
    );
    return { status: "timed_out", evidence: timeoutEvidence, lifecycle };
  }
  if (lifecycle.classification.status === "green") {
    await input.store.append(
      "runtime",
      "wait.satisfied",
      {
        nodeId: input.node.id,
        evidence,
        signature: lifecycle.classification.signature,
        probeResult: lifecycle.result,
      },
      input.node.id,
    );
    return { status: "satisfied", evidence, lifecycle };
  }
  if (lifecycle.classification.status !== "waiting") {
    await input.store.append(
      "runtime",
      "wait.observed",
      {
        nodeId: input.node.id,
        nextWakeAt: new Date(now).toISOString(),
        evidence,
        signature: lifecycle.classification.signature,
        probeResult: lifecycle.result,
      },
      input.node.id,
    );
    return { status: "action_required", evidence, lifecycle };
  }

  const observations = wait.observations + 1;
  const delay = Math.min(
    condition.pollIntervalMs * 2 ** Math.min(Math.max(0, observations - 1), 4),
    300_000,
  );
  const nextWakeAt = new Date(
    condition.timeoutAt ? Math.min(now + delay, Date.parse(condition.timeoutAt)) : now + delay,
  ).toISOString();
  await input.store.append(
    "runtime",
    "wait.observed",
    {
      nodeId: input.node.id,
      nextWakeAt,
      evidence,
      signature: lifecycle.classification.signature,
      probeResult: lifecycle.result,
    },
    input.node.id,
  );
  return { status: "waiting", nextWakeAt, evidence, lifecycle };
}
