import { runProcess, type ExecutedProbe } from "@graphcraft/probes";
import {
  SideEffectClaimSchema,
  WaitRuntimeStateSchema,
  contentHash,
  type ExecutableProbe,
  type GraphNode,
  type RunContract,
  type SideEffectClaim,
} from "@graphcraft/core";
import {
  assertGitHubSnapshotCurrent,
  assertGitHubPushCapability,
  captureGitHubPullRequestSnapshot,
  classifyGitHubPullRequestLifecycle,
  createGitHubPullRequest,
  listGitHubPullRequestsForHead,
  readGitHubPullRequestIdentity,
  type GitHubCommandOptions,
  type GitHubPullRequestLifecycleClassification,
  type GitHubPullRequestCandidate,
} from "@graphcraft/github";
import {
  crossSideEffectBoundary,
  type SideEffectBoundary,
  type SideEffectReconciliation,
} from "./side-effect.ts";
import type { RunWorkspace } from "./repository.ts";
import { RunStore } from "./store.ts";

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
  kind: "check_run" | "status_context";
  name: string;
  status: string;
  conclusion?: string;
  appId?: number;
  detailsUrl?: string;
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
    checks: snapshot.checks.map(({ id, kind, name, status, conclusion, appId }) => ({
      id,
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
  return {
    classification,
    reviewFeedback,
    reviewFeedbackSignature,
    ciFailures,
    ciFailureSignature,
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
  let wait = state.waits.find(({ nodeId }) => nodeId === input.node.id);
  if (!wait) {
    const registeredAt = new Date(now).toISOString();
    wait = WaitRuntimeStateSchema.parse({
      nodeId: input.node.id,
      condition,
      workspacePath: input.workspace.path,
      status: "waiting",
      registeredAt,
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

  const pullRequests = state.sideEffects.filter(
    ({ claim, status, result }) =>
      claim.kind === "github_pr_create" && status === "confirmed" && result !== undefined,
  );
  if (pullRequests.length !== 1 || !pullRequests[0]?.result)
    throw new Error("The GitHub lifecycle wait requires one confirmed pull-request binding");
  const pullRequest = pullRequests[0];
  const pullRequestResult = pullRequest.result;
  if (!pullRequestResult)
    throw new Error("The confirmed pull-request binding has no durable result");
  const originalExpected = pullRequestPrecondition(pullRequest.claim);
  const number = pullRequestResult.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0)
    throw new Error("The confirmed pull-request binding has no valid number");
  let expected = originalExpected;
  const boundaryNodeId = input.node.dependsOn[0];
  if (boundaryNodeId !== pullRequest.claim.nodeId) {
    const pushed = state.sideEffects.find(
      ({ claim }) => claim.nodeId === boundaryNodeId && claim.kind === "git_push",
    );
    if (pushed?.status !== "confirmed" || !pushed.result)
      throw new Error(`The GitHub lifecycle wait has no confirmed push for ${boundaryNodeId}`);
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
  const lifecycle = await captureExpectedPullRequestLifecycle(
    input.workspace,
    input.contract,
    expected,
    number,
    {
      id: `${input.node.id}-lifecycle`,
      kind: "github_snapshot",
      pullRequest: "run_branch",
      expectedState: "open",
      requiredChecks: "success",
      reviewThreads: "resolved",
    },
    pullRequestResult.baseSha === originalExpected.baseSha &&
      (boundaryNodeId !== pullRequest.claim.nodeId ||
        pullRequestResult.headSha === originalExpected.headSha),
    input.options ?? {},
  );
  if (lifecycle.output) {
    lifecycle.result.artifact = await input.store.writeArtifact(
      `probes/${lifecycle.result.signature}.log`,
      lifecycle.output,
    );
  }
  const evidence = lifecycle.classification.evidence;
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
