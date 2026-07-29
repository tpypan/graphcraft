import crossSpawn from "cross-spawn";
import { z } from "zod";
import {
  ProcessOutputLimitError,
  ProcessSettlementError,
  runProcess,
  type ManagedProcessLifecycle,
} from "@graphcraft/probes";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  contentHash,
  resolveTrustedExecutable,
  terminateChildProcessTree,
  type CanonicalHashAlgorithm,
} from "@graphcraft/core";

export const GITHUB_COMMAND_TERMINATION_GRACE_MS = 2_000;
export const GITHUB_COMMAND_SETTLEMENT_GRACE_MS = 2_000;
const GITHUB_COMMAND_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

const PermissionSchema = z.enum(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ", "NONE"]);

const RequiredStatusCheckSchema = z.strictObject({
  context: z.string().min(1),
  appId: z.number().int().optional(),
});

export const GitHubBranchProtectionSchema = z.strictObject({
  status: z.enum(["protected", "unprotected", "unknown"]),
  branch: z.string().min(1),
  requiredStatusChecks: z.array(RequiredStatusCheckSchema),
  requiresApprovingReviews: z.boolean().optional(),
  requiredApprovingReviewCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

export const GitHubCapabilityReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  installed: z.boolean(),
  authenticated: z.boolean(),
  repositoryAccessible: z.boolean(),
  readyForSnapshot: z.boolean(),
  commandVersion: z.string().optional(),
  host: z.string().optional(),
  nameWithOwner: z.string().optional(),
  url: z.string().url().optional(),
  defaultBranch: z.string().optional(),
  viewerPermission: PermissionSchema.optional(),
  canRead: z.boolean(),
  canWrite: z.boolean(),
  branchProtection: GitHubBranchProtectionSchema.optional(),
  errors: z.array(z.string()),
});

const LatestThreadCommentSchema = z.strictObject({
  id: z.string().min(1),
  author: z.string().optional(),
  body: z.string(),
  url: z.string().url(),
  createdAt: z.iso.datetime(),
});

const ReviewThreadSchema = z.strictObject({
  id: z.string().min(1),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  commentCount: z.number().int().nonnegative(),
  latestComment: LatestThreadCommentSchema.optional(),
});

const PullRequestReviewSchema = z.strictObject({
  id: z.string().min(1),
  state: z.string().min(1),
  author: z.string().optional(),
  commitSha: z.string().optional(),
  submittedAt: z.iso.datetime().optional(),
});

const CheckObservationSchema = z.strictObject({
  id: z.string().min(1),
  databaseId: z.number().int().positive().optional(),
  kind: z.enum(["check_run", "status_context"]),
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().optional(),
  detailsUrl: z.string().url().optional(),
  appId: z.number().int().optional(),
});

const RequiredCheckObservationSchema = z.strictObject({
  context: z.string().min(1),
  appId: z.number().int().optional(),
  state: z.enum(["success", "pending", "failure", "missing", "unknown"]),
  matchingCheckIds: z.array(z.string()),
});

const RateLimitResourceSchema = z.strictObject({
  limit: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  resetAt: z.iso.datetime(),
});

export const GitHubPullRequestSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  contentTrust: z.literal("untrusted_external"),
  repository: z.strictObject({
    nameWithOwner: z.string().min(3),
    url: z.string().url(),
    host: z.string().min(1),
    viewerPermission: PermissionSchema,
  }),
  pullRequest: z.strictObject({
    number: z.number().int().positive(),
    url: z.string().url(),
    title: z.string(),
    state: z.string().min(1),
    isDraft: z.boolean(),
    headRefName: z.string().min(1),
    baseRefName: z.string().min(1),
    headSha: z.string().min(7),
    baseSha: z.string().min(7),
    mergeable: z.string().min(1),
    reviewDecision: z.string().optional(),
    updatedAt: z.iso.datetime(),
  }),
  binding: z.strictObject({
    headSha: z.string().min(7),
    baseSha: z.string().min(7),
    capturedAt: z.iso.datetime(),
  }),
  branchProtection: GitHubBranchProtectionSchema,
  requiredChecks: z.array(RequiredCheckObservationSchema),
  checks: z.array(CheckObservationSchema),
  reviewThreads: z.array(ReviewThreadSchema),
  reviews: z.array(PullRequestReviewSchema),
  rateLimit: z.strictObject({
    core: RateLimitResourceSchema,
    graphql: RateLimitResourceSchema,
  }),
});

export const GitHubPullRequestBindingExpectationSchema = z.strictObject({
  host: z.string().min(1),
  nameWithOwner: z.string().min(3),
  number: z.number().int().positive(),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
  headSha: z.string().min(7),
  baseSha: z.string().min(7),
});

export const GitHubLifecycleStatusSchema = z.enum([
  "green",
  "waiting",
  "review_required",
  "actionable_failure",
  "infrastructure_failure",
  "cancelled",
  "human_decision",
  "stale",
  "blocked",
]);

export const GitHubPullRequestLifecycleClassificationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  status: GitHubLifecycleStatusSchema,
  counts: z.strictObject({
    requiredChecksTotal: z.number().int().nonnegative(),
    requiredChecksSucceeded: z.number().int().nonnegative(),
    requiredChecksPending: z.number().int().nonnegative(),
    requiredChecksActionableFailure: z.number().int().nonnegative(),
    requiredChecksInfrastructureFailure: z.number().int().nonnegative(),
    requiredChecksCancelled: z.number().int().nonnegative(),
    requiredChecksMissingOrUnknown: z.number().int().nonnegative(),
    unresolvedReviewThreads: z.number().int().nonnegative(),
    currentApprovals: z.number().int().nonnegative(),
    requiredApprovals: z.number().int().nonnegative(),
  }),
  checkIds: z.strictObject({
    actionable: z.array(z.string().min(1)),
    infrastructure: z.array(z.string().min(1)),
    cancelled: z.array(z.string().min(1)),
    pending: z.array(z.string().min(1)),
  }),
  unresolvedThreadIds: z.array(z.string().min(1)),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: z.array(z.string().min(1)),
});

export type GitHubCapabilityReport = z.infer<typeof GitHubCapabilityReportSchema>;
export type GitHubBranchProtection = z.infer<typeof GitHubBranchProtectionSchema>;
export type GitHubPullRequestSnapshot = z.infer<typeof GitHubPullRequestSnapshotSchema>;
export type GitHubPullRequestBindingExpectation = z.infer<
  typeof GitHubPullRequestBindingExpectationSchema
>;
export type GitHubLifecycleStatus = z.infer<typeof GitHubLifecycleStatusSchema>;
export type GitHubPullRequestLifecycleClassification = z.infer<
  typeof GitHubPullRequestLifecycleClassificationSchema
>;

export interface GitHubCommandOptions {
  cwd: string;
  command?: string;
  commandArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  lifecycle?: ManagedProcessLifecycle;
}

export type GitHubCommandCancellationOutcome =
  "cancelled_before_spawn" | "terminated" | "unconfirmed";

export class GitHubCommandCancellationError extends Error {
  constructor(readonly outcome: GitHubCommandCancellationOutcome) {
    super(
      outcome === "cancelled_before_spawn"
        ? "GitHub command was cancelled before spawn"
        : outcome === "terminated"
          ? "GitHub command was cancelled and its child settled"
          : "GitHub command was cancelled without confirmed child settlement",
    );
    this.name = "GitHubCommandCancellationError";
  }
}

export class GitHubCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly childSettlement: "confirmed" | "unconfirmed" = "confirmed",
  ) {
    super(message);
    this.name = "GitHubCommandError";
  }
}

export class GitHubCommandResultError extends Error {
  readonly childSettlement = "confirmed" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubCommandResultError";
  }
}

async function runCommand(
  options: GitHubCommandOptions,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw new GitHubCommandCancellationError("cancelled_before_spawn");
  const command =
    options.command ??
    (await resolveTrustedExecutable("gh", {
      environment: options.env ?? process.env,
      untrustedCwd: options.cwd,
    }));
  if (options.signal?.aborted) throw new GitHubCommandCancellationError("cancelled_before_spawn");
  const commandArgs = [...(options.commandArgs ?? []), ...args];
  if (options.lifecycle) {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const lifecycle = options.lifecycle;
    let targetSettled = false;
    let abortedBeforeTargetSettlement = options.signal?.aborted ?? false;
    const recordAbort = (): void => {
      if (!targetSettled) abortedBeforeTargetSettlement = true;
    };
    options.signal?.addEventListener("abort", recordAbort, { once: true });
    let result: Awaited<ReturnType<typeof runProcess>>;
    try {
      result = await runProcess(command, commandArgs, {
        cwd: options.cwd,
        timeoutMs,
        maxOutputBytesPerStream: GITHUB_COMMAND_OUTPUT_LIMIT_BYTES,
        maxOutputBytesTotal: GITHUB_COMMAND_OUTPUT_LIMIT_BYTES,
        outputOverflow: "reject",
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        lifecycle: {
          ...lifecycle,
          onSettled: async (settlement) => {
            targetSettled = true;
            await lifecycle.onSettled(settlement);
          },
        },
      });
    } catch (error) {
      if (error instanceof ProcessOutputLimitError)
        throw new GitHubCommandError(
          "gh output exceeded the 16MiB safety limit",
          1,
          error.childSettlement,
        );
      if (error instanceof ProcessSettlementError) {
        if (error.timedOut)
          throw new GitHubCommandError(
            `gh exceeded its ${timeoutMs}ms timeout`,
            124,
            "unconfirmed",
          );
        if (error.outputLimit)
          throw new GitHubCommandError(
            "gh output exceeded the 16MiB safety limit",
            1,
            "unconfirmed",
          );
        if (abortedBeforeTargetSettlement) throw new GitHubCommandCancellationError("unconfirmed");
        throw new GitHubCommandError(error.message, 1, "unconfirmed");
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", recordAbort);
    }
    if (result.timedOut)
      throw new GitHubCommandError(
        `gh exceeded its ${timeoutMs}ms timeout`,
        result.exitCode,
        result.childSettlement,
      );
    if (abortedBeforeTargetSettlement)
      throw new GitHubCommandCancellationError(
        result.childSettlement === "confirmed" ? "terminated" : "unconfirmed",
      );
    if (
      result.capture.stdout.observedBytes + result.capture.stderr.observedBytes >
      GITHUB_COMMAND_OUTPUT_LIMIT_BYTES
    )
      throw new GitHubCommandError(
        "gh output exceeded the 16MiB safety limit",
        result.exitCode,
        result.childSettlement,
      );
    if (result.exitCode !== 0)
      throw new GitHubCommandError(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `${command} ${commandArgs[0] ?? ""} exited ${result.exitCode}`,
        result.exitCode,
        result.childSettlement,
      );
    return { stdout: result.stdout, stderr: result.stderr };
  }
  return await new Promise((resolve, reject) => {
    const child = crossSpawn.spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let settlementTimer: NodeJS.Timeout | undefined;
    const timeoutMs = options.timeoutMs ?? 60_000;
    let timeout: NodeJS.Timeout | undefined;
    let termination: { kind: "failure"; message: string } | { kind: "cancellation" } | undefined;

    const abortFromCaller = (): void => terminate({ kind: "cancellation" });

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    };
    const complete = (
      exitCode: number | null,
      error?: Error,
      cancellationOutcome: "terminated" | "unconfirmed" = "terminated",
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      } catch {
        // Cleanup must not hide the bounded GitHub command outcome.
      }
      if (termination?.kind === "cancellation") {
        reject(new GitHubCommandCancellationError(cancellationOutcome));
        return;
      }
      if (termination?.kind === "failure") {
        reject(
          new GitHubCommandError(
            termination.message,
            exitCode ?? 1,
            cancellationOutcome === "unconfirmed" ? "unconfirmed" : "confirmed",
          ),
        );
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      const code = exitCode ?? 1;
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new GitHubCommandError(
            stderr.trim() || stdout.trim() || `${command} ${commandArgs[0] ?? ""} exited ${code}`,
            code,
          ),
        );
    };
    function terminate(
      reason: { kind: "failure"; message: string } | { kind: "cancellation" },
    ): void {
      if (termination || settled) return;
      termination = reason;
      if (timeout) clearTimeout(timeout);
      try {
        terminateChildProcessTree(child, "SIGTERM");
      } catch {
        // Escalation and bounded settlement still apply when graceful delivery fails.
      }
      if (settled) return;
      forceTimer = setTimeout(() => {
        try {
          terminateChildProcessTree(child, "SIGKILL");
        } catch {
          // Bounded settlement below prevents an unresponsive child from hanging the caller.
        }
        if (settled) return;
        settlementTimer = setTimeout(
          () => complete(null, undefined, "unconfirmed"),
          GITHUB_COMMAND_SETTLEMENT_GRACE_MS,
        );
        settlementTimer.unref();
      }, GITHUB_COMMAND_TERMINATION_GRACE_MS);
      forceTimer.unref();
    }
    timeout = setTimeout(
      () => terminate({ kind: "failure", message: `gh exceeded its ${timeoutMs}ms timeout` }),
      timeoutMs,
    );
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > GITHUB_COMMAND_OUTPUT_LIMIT_BYTES)
        return terminate({ kind: "failure", message: "gh output exceeded the 16MiB safety limit" });
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > GITHUB_COMMAND_OUTPUT_LIMIT_BYTES)
        return terminate({ kind: "failure", message: "gh output exceeded the 16MiB safety limit" });
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (!termination) complete(null, error);
    });
    child.once("close", (exitCode) => complete(exitCode));
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (options.signal?.aborted) abortFromCaller();
  });
}

async function jsonCommand(options: GitHubCommandOptions, args: string[]): Promise<unknown> {
  const { stdout } = await runCommand(options, args);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new GitHubCommandResultError(
      `gh returned invalid JSON for ${args.slice(0, 2).join(" ")}`,
      { cause: error },
    );
  }
}

const RepoViewSchema = z.object({
  nameWithOwner: z.string().min(3),
  url: z.string().url(),
  viewerPermission: PermissionSchema,
  defaultBranchRef: z.object({ name: z.string().min(1) }),
});

function repositoryParts(nameWithOwner: string): { owner: string; name: string } {
  const [owner, name, ...rest] = nameWithOwner.split("/");
  if (!owner || !name || rest.length > 0)
    throw new Error(`GitHub repository name is invalid: ${nameWithOwner}`);
  return { owner, name };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rethrowCommandCancellation(error: unknown): void {
  if (error instanceof GitHubCommandCancellationError) throw error;
}

async function readBranchProtection(
  options: GitHubCommandOptions,
  input: { host: string; nameWithOwner: string; branch: string },
): Promise<GitHubBranchProtection> {
  const branchPath = encodeURIComponent(input.branch);
  const endpoint = `repos/${input.nameWithOwner}/branches/${branchPath}`;
  let branch: { protected: boolean };
  try {
    branch = z
      .object({ protected: z.boolean() })
      .parse(await jsonCommand(options, ["api", "--hostname", input.host, endpoint]));
  } catch (error) {
    rethrowCommandCancellation(error);
    return GitHubBranchProtectionSchema.parse({
      status: "unknown",
      branch: input.branch,
      requiredStatusChecks: [],
      error: `Cannot inspect base branch protection: ${errorMessage(error)}`,
    });
  }
  if (!branch.protected)
    return GitHubBranchProtectionSchema.parse({
      status: "unprotected",
      branch: input.branch,
      requiredStatusChecks: [],
    });

  try {
    const protection = z
      .object({
        required_status_checks: z
          .object({
            contexts: z.array(z.string()).optional(),
            checks: z
              .array(
                z.object({
                  context: z.string().min(1),
                  app_id: z.number().int().nullable().optional(),
                }),
              )
              .optional(),
          })
          .nullable()
          .optional(),
        required_pull_request_reviews: z
          .object({ required_approving_review_count: z.number().int().nonnegative() })
          .nullable()
          .optional(),
      })
      .parse(
        await jsonCommand(options, ["api", "--hostname", input.host, `${endpoint}/protection`]),
      );
    const checks = protection.required_status_checks?.checks;
    const requiredStatusChecks = checks?.length
      ? checks.map(({ context, app_id }) => ({
          context,
          ...(typeof app_id === "number" && app_id >= 0 ? { appId: app_id } : {}),
        }))
      : (protection.required_status_checks?.contexts ?? []).map((context) => ({ context }));
    return GitHubBranchProtectionSchema.parse({
      status: "protected",
      branch: input.branch,
      requiredStatusChecks,
      requiresApprovingReviews: protection.required_pull_request_reviews != null,
      ...(protection.required_pull_request_reviews
        ? {
            requiredApprovingReviewCount:
              protection.required_pull_request_reviews.required_approving_review_count,
          }
        : {}),
    });
  } catch (error) {
    rethrowCommandCancellation(error);
    return GitHubBranchProtectionSchema.parse({
      status: "unknown",
      branch: input.branch,
      requiredStatusChecks: [],
      error: `Base branch is protected but its rules are unavailable: ${errorMessage(error)}`,
    });
  }
}

export async function probeGitHub(
  options: GitHubCommandOptions & { baseBranch?: string },
): Promise<GitHubCapabilityReport> {
  const errors: string[] = [];
  let commandVersion: string | undefined;
  try {
    commandVersion = (await runCommand(options, ["--version"])).stdout.split("\n")[0]?.trim();
  } catch (error) {
    rethrowCommandCancellation(error);
    errors.push(`GitHub CLI is unavailable: ${errorMessage(error)}`);
    return GitHubCapabilityReportSchema.parse({
      schemaVersion: 1,
      installed: false,
      authenticated: false,
      repositoryAccessible: false,
      readyForSnapshot: false,
      canRead: false,
      canWrite: false,
      errors,
    });
  }

  try {
    await runCommand(options, ["auth", "status", "--active"]);
  } catch (error) {
    rethrowCommandCancellation(error);
    errors.push(`GitHub CLI authentication is unavailable: ${errorMessage(error)}`);
    return GitHubCapabilityReportSchema.parse({
      schemaVersion: 1,
      installed: true,
      authenticated: false,
      repositoryAccessible: false,
      readyForSnapshot: false,
      commandVersion,
      canRead: false,
      canWrite: false,
      errors,
    });
  }

  let repository: z.infer<typeof RepoViewSchema>;
  try {
    repository = RepoViewSchema.parse(
      await jsonCommand(options, [
        "repo",
        "view",
        "--json",
        "nameWithOwner,url,viewerPermission,defaultBranchRef",
      ]),
    );
  } catch (error) {
    rethrowCommandCancellation(error);
    errors.push(`GitHub repository access is unavailable: ${errorMessage(error)}`);
    return GitHubCapabilityReportSchema.parse({
      schemaVersion: 1,
      installed: true,
      authenticated: true,
      repositoryAccessible: false,
      readyForSnapshot: false,
      commandVersion,
      canRead: false,
      canWrite: false,
      errors,
    });
  }

  const host = new URL(repository.url).hostname;
  const branch = options.baseBranch ?? repository.defaultBranchRef.name;
  const branchProtection = await readBranchProtection(options, {
    host,
    nameWithOwner: repository.nameWithOwner,
    branch,
  });
  if (branchProtection.status === "unknown" && branchProtection.error)
    errors.push(branchProtection.error);
  const canRead = repository.viewerPermission !== "NONE";
  const canWrite = ["ADMIN", "MAINTAIN", "WRITE"].includes(repository.viewerPermission);
  if (!canRead) errors.push("The authenticated account has no readable repository permission");
  return GitHubCapabilityReportSchema.parse({
    schemaVersion: 1,
    installed: true,
    authenticated: true,
    repositoryAccessible: true,
    readyForSnapshot: canRead && branchProtection.status !== "unknown",
    commandVersion,
    host,
    nameWithOwner: repository.nameWithOwner,
    url: repository.url,
    defaultBranch: repository.defaultBranchRef.name,
    viewerPermission: repository.viewerPermission,
    canRead,
    canWrite,
    branchProtection,
    errors,
  });
}

export async function assertGitHubPushCapability(
  options: GitHubCommandOptions & { baseBranch?: string },
): Promise<GitHubCapabilityReport> {
  const report = await probeGitHub(options);
  const errors = [...report.errors];
  if (!report.canWrite)
    errors.push("The authenticated account does not have repository write permission");
  if (!report.readyForSnapshot && errors.length === 0)
    errors.push("GitHub repository and branch-protection preflight is incomplete");
  if (!report.readyForSnapshot || !report.canWrite)
    throw new Error(`GitHub push preflight failed: ${errors.join("; ")}`);
  return report;
}

const RateLimitSchema = z.strictObject({
  cost: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  resetAt: z.iso.datetime(),
});

const PageInfoSchema = z.strictObject({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

export const GITHUB_GRAPHQL_OPERATION_COST_BUDGET = 100;
export const GITHUB_GRAPHQL_PAGINATION_PAGE_LIMIT = 32;

class GraphQLPaginationBudget {
  private pages = 0;
  private cost = 0;

  connection(label: string): GraphQLPaginationConnection {
    return new GraphQLPaginationConnection(this, label);
  }

  reservePage(label: string): void {
    if (this.pages >= GITHUB_GRAPHQL_PAGINATION_PAGE_LIMIT)
      throw new Error(
        `GitHub ${label} pagination exceeded its ${GITHUB_GRAPHQL_PAGINATION_PAGE_LIMIT}-page operation limit`,
      );
    this.pages += 1;
  }

  recordCost(label: string, cost: number, hasNextPage: boolean): void {
    this.cost += cost;
    if (
      this.cost > GITHUB_GRAPHQL_OPERATION_COST_BUDGET ||
      (hasNextPage && this.cost >= GITHUB_GRAPHQL_OPERATION_COST_BUDGET)
    )
      throw new Error(
        `GitHub ${label} pagination exhausted its ${GITHUB_GRAPHQL_OPERATION_COST_BUDGET}-point GraphQL operation budget`,
      );
    if (hasNextPage && this.pages >= GITHUB_GRAPHQL_PAGINATION_PAGE_LIMIT)
      throw new Error(
        `GitHub ${label} pagination exceeded its ${GITHUB_GRAPHQL_PAGINATION_PAGE_LIMIT}-page operation limit`,
      );
  }
}

class GraphQLPaginationConnection {
  private readonly requestedCursors = new Set<string>();

  constructor(
    private readonly budget: GraphQLPaginationBudget,
    private readonly label: string,
  ) {}

  reserve(cursor: string | undefined): void {
    if (cursor) {
      if (this.requestedCursors.has(cursor))
        throw new Error(`GitHub ${this.label} pagination repeated cursor ${cursor}`);
      this.requestedCursors.add(cursor);
    }
    this.budget.reservePage(this.label);
  }

  next(pageInfo: z.infer<typeof PageInfoSchema>, cost: number): string | undefined {
    this.budget.recordCost(this.label, cost, pageInfo.hasNextPage);
    if (!pageInfo.hasNextPage) return undefined;
    const cursor = pageInfo.endCursor ?? undefined;
    if (!cursor) throw new Error(`GitHub ${this.label} pagination omitted its next cursor`);
    if (this.requestedCursors.has(cursor))
      throw new Error(`GitHub ${this.label} pagination repeated cursor ${cursor}`);
    return cursor;
  }
}

export class GitHubLifecycleConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubLifecycleConsistencyError";
  }
}

const PullRequestIdentitySchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  state: z.string().min(1),
  isDraft: z.boolean(),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
  headRefOid: z.string().min(7),
  baseRefOid: z.string().min(7),
  mergeable: z.string().min(1),
  reviewDecision: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

const ThreadPageResponseSchema = z.strictObject({
  data: z.strictObject({
    repository: z.strictObject({
      url: z.string().url(),
      viewerPermission: PermissionSchema,
      pullRequest: PullRequestIdentitySchema.extend({
        reviewThreads: z.strictObject({
          nodes: z.array(
            z.strictObject({
              id: z.string().min(1),
              isResolved: z.boolean(),
              isOutdated: z.boolean(),
              path: z.string().nullable(),
              line: z.number().int().positive().nullable(),
              comments: z.strictObject({
                totalCount: z.number().int().nonnegative(),
                nodes: z.array(
                  z.strictObject({
                    id: z.string().min(1),
                    author: z.strictObject({ login: z.string() }).nullable(),
                    body: z.string(),
                    url: z.string().url(),
                    createdAt: z.iso.datetime(),
                  }),
                ),
              }),
            }),
          ),
          pageInfo: PageInfoSchema,
        }),
      }),
    }),
    rateLimit: RateLimitSchema,
  }),
});

const ReviewsPageResponseSchema = z.strictObject({
  data: z.strictObject({
    repository: z.strictObject({
      pullRequest: z.strictObject({
        headRefOid: z.string().min(7),
        baseRefOid: z.string().min(7),
        reviews: z.strictObject({
          nodes: z.array(
            z.strictObject({
              id: z.string().min(1),
              state: z.string().min(1),
              author: z.strictObject({ login: z.string() }).nullable(),
              commit: z.strictObject({ oid: z.string().min(7) }).nullable(),
              submittedAt: z.iso.datetime().nullable(),
            }),
          ),
          pageInfo: PageInfoSchema,
        }),
      }),
    }),
    rateLimit: RateLimitSchema,
  }),
});

const CheckNodeSchema = z.discriminatedUnion("__typename", [
  z.strictObject({
    __typename: z.literal("CheckRun"),
    id: z.string().min(1),
    databaseId: z.number().int().positive().nullable(),
    name: z.string().min(1),
    status: z.string().min(1),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().url().nullable(),
    app: z.strictObject({ databaseId: z.number().int() }).nullable(),
  }),
  z.strictObject({
    __typename: z.literal("StatusContext"),
    id: z.string().min(1),
    context: z.string().min(1),
    state: z.string().min(1),
    targetUrl: z.string().url().nullable(),
  }),
]);

const ChecksPageResponseSchema = z.strictObject({
  data: z.strictObject({
    repository: z.strictObject({
      object: z.strictObject({
        oid: z.string().min(7),
        statusCheckRollup: z
          .strictObject({
            contexts: z.strictObject({
              nodes: z.array(CheckNodeSchema),
              pageInfo: PageInfoSchema,
            }),
          })
          .nullable(),
      }),
    }),
    rateLimit: RateLimitSchema,
  }),
});

const IdentityResponseSchema = z.strictObject({
  data: z.strictObject({
    repository: z.strictObject({
      pullRequest: z.strictObject({
        headRefOid: z.string().min(7),
        baseRefOid: z.string().min(7),
      }),
    }),
    rateLimit: RateLimitSchema,
  }),
});

export const GitHubPullRequestCandidateSchema = z.strictObject({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  body: z.string(),
  state: z.string().min(1),
  isDraft: z.boolean(),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
  headSha: z.string().min(7),
  baseSha: z.string().min(7),
});

export type GitHubPullRequestCandidate = z.infer<typeof GitHubPullRequestCandidateSchema>;

export const GitHubReviewThreadStateSchema = z.strictObject({
  id: z.string().min(1),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  comments: z.array(
    z.strictObject({
      id: z.string().min(1),
      author: z.string().optional(),
      body: z.string(),
      url: z.string().url(),
      createdAt: z.iso.datetime(),
    }),
  ),
});

export type GitHubReviewThreadState = z.infer<typeof GitHubReviewThreadStateSchema>;

const PullRequestsByHeadResponseSchema = z.strictObject({
  data: z.strictObject({
    repository: z.strictObject({
      pullRequests: z.strictObject({
        nodes: z.array(
          z.strictObject({
            number: z.number().int().positive(),
            url: z.string().url(),
            title: z.string(),
            body: z.string(),
            state: z.string().min(1),
            isDraft: z.boolean(),
            headRefName: z.string().min(1),
            baseRefName: z.string().min(1),
            headRefOid: z.string().min(7),
            baseRefOid: z.string().min(7),
          }),
        ),
        pageInfo: PageInfoSchema,
      }),
    }),
    rateLimit: RateLimitSchema,
  }),
});

const PullRequestMutationIdentitySchema = z.strictObject({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  body: z.string(),
  state: z.string().min(1),
  isDraft: z.boolean(),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
  headRefOid: z.string().min(7),
  baseRefOid: z.string().min(7),
});

const ReviewThreadPageResponseSchema = z.strictObject({
  data: z.strictObject({
    node: z
      .strictObject({
        id: z.string().min(1),
        isResolved: z.boolean(),
        isOutdated: z.boolean(),
        path: z.string().nullable(),
        line: z.number().int().positive().nullable(),
        comments: z.strictObject({
          nodes: z.array(
            z.strictObject({
              id: z.string().min(1),
              author: z.strictObject({ login: z.string() }).nullable(),
              body: z.string(),
              url: z.string().url(),
              createdAt: z.iso.datetime(),
            }),
          ),
          pageInfo: PageInfoSchema,
        }),
      })
      .nullable(),
    rateLimit: RateLimitSchema,
  }),
});

const ReviewReplyMutationResponseSchema = z.strictObject({
  data: z.strictObject({
    addPullRequestReviewThreadReply: z
      .strictObject({
        clientMutationId: z.string().nullable(),
        comment: z.strictObject({
          id: z.string().min(1),
          body: z.string(),
          url: z.string().url(),
        }),
      })
      .nullable(),
  }),
});

const ResolveReviewThreadMutationResponseSchema = z.strictObject({
  data: z.strictObject({
    resolveReviewThread: z
      .strictObject({
        clientMutationId: z.string().nullable(),
        thread: z.strictObject({ id: z.string().min(1), isResolved: z.boolean() }),
      })
      .nullable(),
  }),
});

const THREADS_QUERY = `query GraphcraftPullRequestThreads($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){url viewerPermission pullRequest(number:$number){number url title state isDraft headRefName baseRefName headRefOid baseRefOid mergeable reviewDecision updatedAt reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated path line comments(last:1){totalCount nodes{id author{login} body url createdAt}}} pageInfo{hasNextPage endCursor}}}} rateLimit{cost remaining resetAt}}`;
const REVIEWS_QUERY = `query GraphcraftPullRequestReviews($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid reviews(first:100,after:$cursor){nodes{id state author{login} commit{oid} submittedAt} pageInfo{hasNextPage endCursor}}}} rateLimit{cost remaining resetAt}}`;
const CHECKS_QUERY = `query GraphcraftCommitChecks($owner:String!,$name:String!,$head:GitObjectID!,$cursor:String){repository(owner:$owner,name:$name){object(oid:$head){... on Commit{oid statusCheckRollup{contexts(first:100,after:$cursor){nodes{__typename ... on CheckRun{id databaseId name status conclusion detailsUrl app{databaseId}} ... on StatusContext{id context state targetUrl}} pageInfo{hasNextPage endCursor}}}}}} rateLimit{cost remaining resetAt}}`;
const IDENTITY_QUERY = `query GraphcraftPullRequestIdentity($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid}} rateLimit{cost remaining resetAt}}`;
const PULL_REQUESTS_BY_HEAD_QUERY = `query GraphcraftPullRequestsByHead($owner:String!,$name:String!,$head:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$cursor,headRefName:$head,states:[OPEN,CLOSED,MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number url title body state isDraft headRefName baseRefName headRefOid baseRefOid} pageInfo{hasNextPage endCursor}}} rateLimit{cost remaining resetAt}}`;
const REVIEW_THREAD_QUERY = `query GraphcraftReviewThread($threadId:ID!,$cursor:String){node(id:$threadId){... on PullRequestReviewThread{id isResolved isOutdated path line comments(first:100,after:$cursor){nodes{id author{login} body url createdAt} pageInfo{hasNextPage endCursor}}}} rateLimit{cost remaining resetAt}}`;
const ADD_REVIEW_REPLY_MUTATION = `mutation GraphcraftAddReviewReply($threadId:ID!,$body:String!,$clientMutationId:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body,clientMutationId:$clientMutationId}){clientMutationId comment{id body url}}}`;
const RESOLVE_REVIEW_THREAD_MUTATION = `mutation GraphcraftResolveReviewThread($threadId:ID!,$clientMutationId:String!){resolveReviewThread(input:{threadId:$threadId,clientMutationId:$clientMutationId}){clientMutationId thread{id isResolved}}}`;

async function graphql(
  options: GitHubCommandOptions,
  host: string,
  query: string,
  variables: Record<string, string | number | undefined>,
): Promise<unknown> {
  const args = ["api", "graphql", "--hostname", host, "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (value === undefined) continue;
    args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
  }
  return await jsonCommand(options, args);
}

export async function listGitHubPullRequestsForHead(
  options: GitHubCommandOptions,
  input: { host: string; nameWithOwner: string; headRefName: string },
): Promise<GitHubPullRequestCandidate[]> {
  const { owner, name } = repositoryParts(input.nameWithOwner);
  const pullRequests: GitHubPullRequestCandidate[] = [];
  const pagination = new GraphQLPaginationBudget().connection("pull-request");
  let cursor: string | undefined;
  do {
    pagination.reserve(cursor);
    const response = PullRequestsByHeadResponseSchema.parse(
      await graphql(options, input.host, PULL_REQUESTS_BY_HEAD_QUERY, {
        owner,
        name,
        head: input.headRefName,
        cursor,
      }),
    );
    const connection = response.data.repository.pullRequests;
    pullRequests.push(
      ...connection.nodes.map((pullRequest) =>
        GitHubPullRequestCandidateSchema.parse({
          number: pullRequest.number,
          url: pullRequest.url,
          title: pullRequest.title,
          body: pullRequest.body,
          state: pullRequest.state,
          isDraft: pullRequest.isDraft,
          headRefName: pullRequest.headRefName,
          baseRefName: pullRequest.baseRefName,
          headSha: pullRequest.headRefOid,
          baseSha: pullRequest.baseRefOid,
        }),
      ),
    );
    cursor = pagination.next(connection.pageInfo, response.data.rateLimit.cost);
  } while (cursor);
  return pullRequests;
}

export async function readGitHubPullRequestIdentity(
  options: GitHubCommandOptions,
  input: { nameWithOwner: string; number: number },
): Promise<GitHubPullRequestCandidate> {
  const value = PullRequestMutationIdentitySchema.parse(
    await jsonCommand(options, [
      "pr",
      "view",
      String(input.number),
      "--repo",
      input.nameWithOwner,
      "--json",
      "number,url,title,body,state,isDraft,headRefName,baseRefName,headRefOid,baseRefOid",
    ]),
  );
  return GitHubPullRequestCandidateSchema.parse({
    number: value.number,
    url: value.url,
    title: value.title,
    body: value.body,
    state: value.state,
    isDraft: value.isDraft,
    headRefName: value.headRefName,
    baseRefName: value.baseRefName,
    headSha: value.headRefOid,
    baseSha: value.baseRefOid,
  });
}

export async function createGitHubPullRequest(
  options: GitHubCommandOptions,
  input: {
    nameWithOwner: string;
    headRefName: string;
    baseRefName: string;
    title: string;
    body: string;
  },
): Promise<void> {
  await runCommand(options, [
    "pr",
    "create",
    "--repo",
    input.nameWithOwner,
    "--head",
    input.headRefName,
    "--base",
    input.baseRefName,
    "--title",
    input.title,
    "--body",
    input.body,
  ]);
}

export async function readGitHubReviewThread(
  options: GitHubCommandOptions,
  input: { host: string; threadId: string },
): Promise<GitHubReviewThreadState> {
  let cursor: string | undefined;
  let thread: Omit<GitHubReviewThreadState, "comments"> | undefined;
  const comments: GitHubReviewThreadState["comments"] = [];
  const pagination = new GraphQLPaginationBudget().connection("review-thread comment");
  do {
    pagination.reserve(cursor);
    const response = ReviewThreadPageResponseSchema.parse(
      await graphql(options, input.host, REVIEW_THREAD_QUERY, {
        threadId: input.threadId,
        cursor,
      }),
    );
    const node = response.data.node;
    if (!node) throw new Error(`GitHub review thread ${input.threadId} is unavailable`);
    const identity = {
      id: node.id,
      isResolved: node.isResolved,
      isOutdated: node.isOutdated,
      ...(node.path ? { path: node.path } : {}),
      ...(node.line !== null ? { line: node.line } : {}),
    };
    if (thread && JSON.stringify(thread) !== JSON.stringify(identity))
      throw new Error(`GitHub review thread ${input.threadId} changed during pagination`);
    thread = identity;
    comments.push(
      ...node.comments.nodes.map(({ id, author, body, url, createdAt }) => ({
        id,
        ...(author ? { author: author.login } : {}),
        body,
        url,
        createdAt,
      })),
    );
    cursor = pagination.next(node.comments.pageInfo, response.data.rateLimit.cost);
  } while (cursor);
  if (!thread) throw new Error(`GitHub review thread ${input.threadId} is unavailable`);
  return GitHubReviewThreadStateSchema.parse({ ...thread, comments });
}

export async function addGitHubReviewThreadReply(
  options: GitHubCommandOptions,
  input: { host: string; threadId: string; body: string; clientMutationId: string },
): Promise<{ id: string; body: string; url: string }> {
  const rawResponse = await graphql(options, input.host, ADD_REVIEW_REPLY_MUTATION, input);
  let response;
  try {
    response =
      ReviewReplyMutationResponseSchema.parse(rawResponse).data.addPullRequestReviewThreadReply;
  } catch (error) {
    throw new GitHubCommandResultError("GitHub returned an invalid review-reply response", {
      cause: error,
    });
  }
  if (!response || response.clientMutationId !== input.clientMutationId)
    throw new GitHubCommandResultError(
      `GitHub did not confirm review reply ${input.clientMutationId}`,
    );
  return response.comment;
}

export async function resolveGitHubReviewThread(
  options: GitHubCommandOptions,
  input: { host: string; threadId: string; clientMutationId: string },
): Promise<{ id: string; isResolved: boolean }> {
  const rawResponse = await graphql(options, input.host, RESOLVE_REVIEW_THREAD_MUTATION, input);
  let response;
  try {
    response =
      ResolveReviewThreadMutationResponseSchema.parse(rawResponse).data.resolveReviewThread;
  } catch (error) {
    throw new GitHubCommandResultError("GitHub returned an invalid review-resolution response", {
      cause: error,
    });
  }
  if (
    !response ||
    response.clientMutationId !== input.clientMutationId ||
    response.thread.id !== input.threadId ||
    !response.thread.isResolved
  )
    throw new GitHubCommandResultError(
      `GitHub did not confirm review-thread resolution ${input.clientMutationId}`,
    );
  return response.thread;
}

export async function rerequestGitHubCheckRun(
  options: GitHubCommandOptions,
  input: { host: string; nameWithOwner: string; databaseId: number },
): Promise<void> {
  await runCommand(options, [
    "api",
    `repos/${input.nameWithOwner}/check-runs/${input.databaseId}/rerequest`,
    "--hostname",
    input.host,
    "--method",
    "POST",
  ]);
}

function assertBound(
  expected: { headSha: string; baseSha: string },
  actual: { headRefOid: string; baseRefOid: string },
): void {
  if (expected.headSha !== actual.headRefOid || expected.baseSha !== actual.baseRefOid)
    throw new Error(
      `GitHub snapshot became stale: expected ${expected.headSha}/${expected.baseSha}, received ${actual.headRefOid}/${actual.baseRefOid}`,
    );
}

async function pullRequestNumber(
  options: GitHubCommandOptions,
  reference?: string | number,
): Promise<number> {
  const args = ["pr", "view"];
  if (reference !== undefined) args.push(String(reference));
  args.push("--json", "number");
  return z.object({ number: z.number().int().positive() }).parse(await jsonCommand(options, args))
    .number;
}

async function collectThreads(input: {
  options: GitHubCommandOptions;
  host: string;
  owner: string;
  name: string;
  number: number;
  paginationBudget: GraphQLPaginationBudget;
}): Promise<{
  identity: z.infer<typeof PullRequestIdentitySchema>;
  repositoryUrl: string;
  viewerPermission: z.infer<typeof PermissionSchema>;
  threads: z.infer<typeof ReviewThreadSchema>[];
}> {
  let cursor: string | undefined;
  let identity: z.infer<typeof PullRequestIdentitySchema> | undefined;
  let repositoryUrl = "";
  let viewerPermission: z.infer<typeof PermissionSchema> | undefined;
  const threads: z.infer<typeof ReviewThreadSchema>[] = [];
  const pagination = input.paginationBudget.connection("review-thread");
  do {
    pagination.reserve(cursor);
    const response = ThreadPageResponseSchema.parse(
      await graphql(input.options, input.host, THREADS_QUERY, {
        owner: input.owner,
        name: input.name,
        number: input.number,
        cursor,
      }),
    );
    const page = response.data.repository.pullRequest;
    if (!identity) identity = PullRequestIdentitySchema.parse(page);
    else assertBound({ headSha: identity.headRefOid, baseSha: identity.baseRefOid }, page);
    repositoryUrl = response.data.repository.url;
    viewerPermission = response.data.repository.viewerPermission;
    threads.push(
      ...page.reviewThreads.nodes.map((thread) => {
        const latest = thread.comments.nodes[0];
        return ReviewThreadSchema.parse({
          id: thread.id,
          isResolved: thread.isResolved,
          isOutdated: thread.isOutdated,
          ...(thread.path ? { path: thread.path } : {}),
          ...(thread.line ? { line: thread.line } : {}),
          commentCount: thread.comments.totalCount,
          ...(latest
            ? {
                latestComment: {
                  id: latest.id,
                  ...(latest.author ? { author: latest.author.login } : {}),
                  body: latest.body,
                  url: latest.url,
                  createdAt: latest.createdAt,
                },
              }
            : {}),
        });
      }),
    );
    cursor = pagination.next(page.reviewThreads.pageInfo, response.data.rateLimit.cost);
  } while (cursor);
  if (!identity || !viewerPermission) throw new Error("GitHub returned no pull request snapshot");
  return { identity, repositoryUrl, viewerPermission, threads };
}

async function collectReviews(input: {
  options: GitHubCommandOptions;
  host: string;
  owner: string;
  name: string;
  number: number;
  binding: { headSha: string; baseSha: string };
  paginationBudget: GraphQLPaginationBudget;
}): Promise<z.infer<typeof PullRequestReviewSchema>[]> {
  let cursor: string | undefined;
  const reviews: z.infer<typeof PullRequestReviewSchema>[] = [];
  const pagination = input.paginationBudget.connection("review");
  do {
    pagination.reserve(cursor);
    const response = ReviewsPageResponseSchema.parse(
      await graphql(input.options, input.host, REVIEWS_QUERY, {
        owner: input.owner,
        name: input.name,
        number: input.number,
        cursor,
      }),
    );
    const pullRequest = response.data.repository.pullRequest;
    assertBound(input.binding, pullRequest);
    reviews.push(
      ...pullRequest.reviews.nodes.map((review) =>
        PullRequestReviewSchema.parse({
          id: review.id,
          state: review.state,
          ...(review.author ? { author: review.author.login } : {}),
          ...(review.commit ? { commitSha: review.commit.oid } : {}),
          ...(review.submittedAt ? { submittedAt: review.submittedAt } : {}),
        }),
      ),
    );
    cursor = pagination.next(pullRequest.reviews.pageInfo, response.data.rateLimit.cost);
  } while (cursor);
  return reviews;
}

async function collectChecks(input: {
  options: GitHubCommandOptions;
  host: string;
  owner: string;
  name: string;
  headSha: string;
  paginationBudget: GraphQLPaginationBudget;
}): Promise<z.infer<typeof CheckObservationSchema>[]> {
  let cursor: string | undefined;
  const checks: z.infer<typeof CheckObservationSchema>[] = [];
  const pagination = input.paginationBudget.connection("check");
  do {
    pagination.reserve(cursor);
    const response = ChecksPageResponseSchema.parse(
      await graphql(input.options, input.host, CHECKS_QUERY, {
        owner: input.owner,
        name: input.name,
        head: input.headSha,
        cursor,
      }),
    );
    const commit = response.data.repository.object;
    if (commit.oid !== input.headSha)
      throw new Error(`GitHub check rollup moved from ${input.headSha} to ${commit.oid}`);
    const contexts = commit.statusCheckRollup?.contexts;
    for (const check of contexts?.nodes ?? []) {
      checks.push(
        check.__typename === "CheckRun"
          ? CheckObservationSchema.parse({
              id: check.id,
              ...(check.databaseId !== null ? { databaseId: check.databaseId } : {}),
              kind: "check_run",
              name: check.name,
              status: check.status,
              ...(check.conclusion ? { conclusion: check.conclusion } : {}),
              ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {}),
              ...(check.app ? { appId: check.app.databaseId } : {}),
            })
          : CheckObservationSchema.parse({
              id: check.id,
              kind: "status_context",
              name: check.context,
              status: check.state,
              ...(check.targetUrl ? { detailsUrl: check.targetUrl } : {}),
            }),
      );
    }
    cursor = pagination.next(
      contexts?.pageInfo ?? { hasNextPage: false, endCursor: null },
      response.data.rateLimit.cost,
    );
  } while (cursor);
  return checks;
}

function checkState(
  check: z.infer<typeof CheckObservationSchema>,
): "success" | "pending" | "failure" | "unknown" {
  if (check.kind === "status_context") {
    if (check.status === "SUCCESS") return "success";
    if (check.status === "PENDING") return "pending";
    if (["ERROR", "FAILURE"].includes(check.status)) return "failure";
    return "unknown";
  }
  if (check.status !== "COMPLETED") return "pending";
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? "")) return "success";
  if (
    ["ACTION_REQUIRED", "CANCELLED", "FAILURE", "STALE", "STARTUP_FAILURE", "TIMED_OUT"].includes(
      check.conclusion ?? "",
    )
  )
    return "failure";
  return "unknown";
}

function requiredCheckObservations(
  protection: GitHubBranchProtection,
  checks: z.infer<typeof CheckObservationSchema>[],
): z.infer<typeof RequiredCheckObservationSchema>[] {
  return protection.requiredStatusChecks.map((required) => {
    const matching = checks.filter(
      (check) =>
        check.name === required.context &&
        (required.appId === undefined || check.appId === required.appId),
    );
    const states = matching.map(checkState);
    const state =
      matching.length === 0
        ? "missing"
        : states.includes("failure")
          ? "failure"
          : states.includes("pending")
            ? "pending"
            : states.every((candidate) => candidate === "success")
              ? "success"
              : "unknown";
    return RequiredCheckObservationSchema.parse({
      ...required,
      state,
      matchingCheckIds: matching.map(({ id }) => id),
    });
  });
}

const ApiRateLimitSchema = z.object({
  resources: z.object({
    core: z.object({
      limit: z.number().int().nonnegative(),
      used: z.number().int().nonnegative(),
      remaining: z.number().int().nonnegative(),
      reset: z.number().int().nonnegative(),
    }),
    graphql: z.object({
      limit: z.number().int().nonnegative(),
      used: z.number().int().nonnegative(),
      remaining: z.number().int().nonnegative(),
      reset: z.number().int().nonnegative(),
    }),
  }),
});

export async function readGitHubRateLimits(
  options: GitHubCommandOptions,
  host: string,
): Promise<GitHubPullRequestSnapshot["rateLimit"]> {
  const response = ApiRateLimitSchema.parse(
    await jsonCommand(options, ["api", "--hostname", host, "rate_limit"]),
  );
  const resource = (value: z.infer<typeof ApiRateLimitSchema>["resources"]["core"]) => ({
    limit: value.limit,
    used: value.used,
    remaining: value.remaining,
    resetAt: new Date(value.reset * 1_000).toISOString(),
  });
  return { core: resource(response.resources.core), graphql: resource(response.resources.graphql) };
}

async function currentBinding(input: {
  options: GitHubCommandOptions;
  host: string;
  owner: string;
  name: string;
  number: number;
  paginationBudget: GraphQLPaginationBudget;
}): Promise<{ headSha: string; baseSha: string }> {
  const pagination = input.paginationBudget.connection("pull-request identity");
  pagination.reserve(undefined);
  const response = IdentityResponseSchema.parse(
    await graphql(input.options, input.host, IDENTITY_QUERY, {
      owner: input.owner,
      name: input.name,
      number: input.number,
    }),
  );
  pagination.next({ hasNextPage: false, endCursor: null }, response.data.rateLimit.cost);
  return {
    headSha: response.data.repository.pullRequest.headRefOid,
    baseSha: response.data.repository.pullRequest.baseRefOid,
  };
}

type GitHubSnapshotLifecycleState = Pick<
  GitHubPullRequestSnapshot,
  | "repository"
  | "pullRequest"
  | "branchProtection"
  | "requiredChecks"
  | "checks"
  | "reviewThreads"
  | "reviews"
> & {
  binding: Pick<GitHubPullRequestSnapshot["binding"], "headSha" | "baseSha">;
};

function compareIdentityStrings(
  left: string,
  right: string,
  hashAlgorithm: CanonicalHashAlgorithm,
): number {
  if (hashAlgorithm === LEGACY_CANONICAL_HASH_ALGORITHM) return left.localeCompare(right);
  return left < right ? -1 : left > right ? 1 : 0;
}

function lifecycleFingerprint(
  input: GitHubSnapshotLifecycleState,
  hashAlgorithm: CanonicalHashAlgorithm,
): string {
  const requiredCheckKey = (check: { context: string; appId?: number | undefined }): string =>
    `${check.context}:${check.appId ?? ""}`;
  return contentHash(
    {
      ...input,
      binding: { ...input.binding },
      branchProtection: {
        ...input.branchProtection,
        requiredStatusChecks: [...input.branchProtection.requiredStatusChecks].sort((left, right) =>
          compareIdentityStrings(requiredCheckKey(left), requiredCheckKey(right), hashAlgorithm),
        ),
      },
      requiredChecks: input.requiredChecks
        .map((check) => ({ ...check, matchingCheckIds: [...check.matchingCheckIds].sort() }))
        .sort((left, right) =>
          compareIdentityStrings(requiredCheckKey(left), requiredCheckKey(right), hashAlgorithm),
        ),
      checks: [...input.checks].sort((left, right) =>
        compareIdentityStrings(left.id, right.id, hashAlgorithm),
      ),
      reviewThreads: [...input.reviewThreads].sort((left, right) =>
        compareIdentityStrings(left.id, right.id, hashAlgorithm),
      ),
      reviews: [...input.reviews].sort((left, right) =>
        compareIdentityStrings(left.id, right.id, hashAlgorithm),
      ),
    },
    hashAlgorithm,
  );
}

function snapshotLifecycleState(snapshot: GitHubPullRequestSnapshot): GitHubSnapshotLifecycleState {
  return {
    repository: snapshot.repository,
    pullRequest: snapshot.pullRequest,
    binding: { headSha: snapshot.binding.headSha, baseSha: snapshot.binding.baseSha },
    branchProtection: snapshot.branchProtection,
    requiredChecks: snapshot.requiredChecks,
    checks: snapshot.checks,
    reviewThreads: snapshot.reviewThreads,
    reviews: snapshot.reviews,
  };
}

export async function assertGitHubSnapshotCurrent(
  options: GitHubCommandOptions,
  snapshot: GitHubPullRequestSnapshot,
  hashAlgorithm: CanonicalHashAlgorithm,
): Promise<void> {
  const parsed = GitHubPullRequestSnapshotSchema.parse(snapshot);
  const { owner, name } = repositoryParts(parsed.repository.nameWithOwner);
  const paginationBudget = new GraphQLPaginationBudget();
  const collectionInput = {
    options,
    host: parsed.repository.host,
    nameWithOwner: parsed.repository.nameWithOwner,
    owner,
    name,
    number: parsed.pullRequest.number,
    paginationBudget,
  };
  const first = await collectSnapshotLifecycle(collectionInput);
  const current = await collectSnapshotLifecycle(collectionInput);
  const finalBinding = await currentBinding({
    options,
    host: parsed.repository.host,
    owner,
    name,
    number: parsed.pullRequest.number,
    paginationBudget,
  });
  if (
    first.pullRequest.number !== parsed.pullRequest.number ||
    current.pullRequest.number !== parsed.pullRequest.number ||
    first.binding.headSha !== parsed.binding.headSha ||
    first.binding.baseSha !== parsed.binding.baseSha ||
    current.binding.headSha !== parsed.binding.headSha ||
    current.binding.baseSha !== parsed.binding.baseSha ||
    finalBinding.headSha !== parsed.binding.headSha ||
    finalBinding.baseSha !== parsed.binding.baseSha
  )
    throw new Error(
      `GitHub snapshot ${parsed.snapshotId} is stale: ${parsed.binding.headSha}/${parsed.binding.baseSha} changed during lifecycle revalidation`,
    );
  const expectedFingerprint = lifecycleFingerprint(snapshotLifecycleState(parsed), hashAlgorithm);
  const firstFingerprint = lifecycleFingerprint(first, hashAlgorithm);
  const currentFingerprint = lifecycleFingerprint(current, hashAlgorithm);
  if (currentFingerprint !== firstFingerprint)
    throw new GitHubLifecycleConsistencyError(
      `GitHub snapshot ${parsed.snapshotId} mutable lifecycle changed during revalidation: ${firstFingerprint} changed to ${currentFingerprint}`,
    );
  if (currentFingerprint !== expectedFingerprint)
    throw new GitHubLifecycleConsistencyError(
      `GitHub snapshot ${parsed.snapshotId} lifecycle is stale: ${expectedFingerprint} changed to ${currentFingerprint}`,
    );
}

type RequiredCheckBucket =
  "success" | "pending" | "actionable" | "infrastructure" | "cancelled" | "missing";

function requiredCheckBucket(
  required: GitHubPullRequestSnapshot["requiredChecks"][number],
  checks: Map<string, GitHubPullRequestSnapshot["checks"][number]>,
): RequiredCheckBucket {
  if (required.state === "success") return "success";
  if (required.state === "pending") return "pending";
  if (required.state === "missing" || required.state === "unknown") return "missing";
  const observations = required.matchingCheckIds
    .map((id) => checks.get(id))
    .filter((value): value is GitHubPullRequestSnapshot["checks"][number] => value !== undefined);
  const signals = observations.map(({ conclusion, status }) =>
    (conclusion ?? status).toUpperCase(),
  );
  if (signals.some((value) => ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED"].includes(value)))
    return "actionable";
  if (signals.some((value) => value === "STARTUP_FAILURE")) return "infrastructure";
  if (signals.some((value) => ["CANCELLED", "STALE", "SKIPPED", "NEUTRAL"].includes(value)))
    return "cancelled";
  return "actionable";
}

function latestReviewStates(
  snapshot: GitHubPullRequestSnapshot,
  hashAlgorithm: CanonicalHashAlgorithm,
): Array<{ author: string; state: string }> {
  const latest = new Map<string, { state: string; submittedAt: string; id: string }>();
  for (const review of snapshot.reviews) {
    if (!review.author || review.commitSha !== snapshot.binding.headSha) continue;
    const submittedAt = review.submittedAt ?? "";
    const current = latest.get(review.author);
    if (
      !current ||
      submittedAt > current.submittedAt ||
      (submittedAt === current.submittedAt && review.id > current.id)
    )
      latest.set(review.author, { state: review.state, submittedAt, id: review.id });
  }
  return [...latest.entries()]
    .map(([author, { state }]) => ({ author, state }))
    .sort((left, right) => compareIdentityStrings(left.author, right.author, hashAlgorithm));
}

export function classifyGitHubPullRequestLifecycle(
  snapshotInput: GitHubPullRequestSnapshot,
  expectedInput: GitHubPullRequestBindingExpectation,
  hashAlgorithm: CanonicalHashAlgorithm,
): GitHubPullRequestLifecycleClassification {
  const snapshot = GitHubPullRequestSnapshotSchema.parse(snapshotInput);
  const expected = GitHubPullRequestBindingExpectationSchema.parse(expectedInput);
  const exactBinding =
    snapshot.repository.host === expected.host &&
    snapshot.repository.nameWithOwner === expected.nameWithOwner &&
    snapshot.pullRequest.number === expected.number &&
    snapshot.pullRequest.headRefName === expected.headRefName &&
    snapshot.pullRequest.baseRefName === expected.baseRefName &&
    snapshot.binding.headSha === expected.headSha &&
    snapshot.binding.baseSha === expected.baseSha;
  const checks = new Map(snapshot.checks.map((check) => [check.id, check]));
  const buckets = snapshot.requiredChecks.map((required) => ({
    required,
    bucket: requiredCheckBucket(required, checks),
  }));
  const count = (bucket: RequiredCheckBucket): number =>
    buckets.filter((value) => value.bucket === bucket).length;
  const ids = (bucket: RequiredCheckBucket): string[] =>
    [
      ...new Set(
        buckets
          .filter((value) => value.bucket === bucket)
          .flatMap(({ required }) => required.matchingCheckIds),
      ),
    ].sort();
  const unresolvedThreadIds = snapshot.reviewThreads
    .filter(({ isResolved, isOutdated }) => !isResolved && !isOutdated)
    .map(({ id }) => id)
    .sort();
  const latestReviews = latestReviewStates(snapshot, hashAlgorithm);
  const currentApprovals = latestReviews.filter(({ state }) => state === "APPROVED").length;
  const requiredApprovals = snapshot.branchProtection.requiresApprovingReviews
    ? (snapshot.branchProtection.requiredApprovingReviewCount ?? 1)
    : 0;
  const counts = {
    requiredChecksTotal: snapshot.requiredChecks.length,
    requiredChecksSucceeded: count("success"),
    requiredChecksPending: count("pending"),
    requiredChecksActionableFailure: count("actionable"),
    requiredChecksInfrastructureFailure: count("infrastructure"),
    requiredChecksCancelled: count("cancelled"),
    requiredChecksMissingOrUnknown: count("missing"),
    unresolvedReviewThreads: unresolvedThreadIds.length,
    currentApprovals,
    requiredApprovals,
  };
  const checkIds = {
    actionable: ids("actionable"),
    infrastructure: ids("infrastructure"),
    cancelled: ids("cancelled"),
    pending: [...new Set([...ids("pending"), ...ids("missing")])].sort(),
  };

  let status: GitHubLifecycleStatus;
  if (!exactBinding) status = "stale";
  else if (snapshot.pullRequest.state.toUpperCase() !== "OPEN") status = "blocked";
  else if (snapshot.pullRequest.isDraft) status = "human_decision";
  else if (unresolvedThreadIds.length > 0) status = "review_required";
  else if (snapshot.pullRequest.reviewDecision === "CHANGES_REQUESTED") status = "human_decision";
  else if (snapshot.pullRequest.mergeable.toUpperCase() === "CONFLICTING")
    status = "actionable_failure";
  else if (counts.requiredChecksActionableFailure > 0) status = "actionable_failure";
  else if (counts.requiredChecksInfrastructureFailure > 0) status = "infrastructure_failure";
  else if (counts.requiredChecksCancelled > 0) status = "cancelled";
  else if (
    counts.requiredChecksPending > 0 ||
    counts.requiredChecksMissingOrUnknown > 0 ||
    currentApprovals < requiredApprovals ||
    snapshot.pullRequest.reviewDecision === "REVIEW_REQUIRED" ||
    snapshot.pullRequest.mergeable.toUpperCase() === "UNKNOWN"
  )
    status = "waiting";
  else status = "green";

  const stableEvidence = {
    status,
    binding: {
      host: snapshot.repository.host,
      nameWithOwner: snapshot.repository.nameWithOwner,
      number: snapshot.pullRequest.number,
      headRefName: snapshot.pullRequest.headRefName,
      baseRefName: snapshot.pullRequest.baseRefName,
      headSha: snapshot.binding.headSha,
      baseSha: snapshot.binding.baseSha,
    },
    state: snapshot.pullRequest.state,
    isDraft: snapshot.pullRequest.isDraft,
    mergeable: snapshot.pullRequest.mergeable,
    reviewDecision: snapshot.pullRequest.reviewDecision ?? null,
    counts,
    checkStates: snapshot.requiredChecks
      .map(({ context, appId, state, matchingCheckIds }) => ({
        context,
        appId: appId ?? null,
        state,
        matchingCheckIds: [...matchingCheckIds].sort(),
      }))
      .sort((left, right) =>
        compareIdentityStrings(
          `${left.context}:${left.appId ?? ""}`,
          `${right.context}:${right.appId ?? ""}`,
          hashAlgorithm,
        ),
      ),
    unresolvedThreadIds,
    latestReviews,
  };
  const evidence = [
    `Lifecycle status is ${status} for PR #${snapshot.pullRequest.number} at ${snapshot.binding.headSha}/${snapshot.binding.baseSha}`,
    `${counts.requiredChecksSucceeded}/${counts.requiredChecksTotal} required checks succeeded; ${counts.requiredChecksPending} pending, ${counts.requiredChecksActionableFailure} actionable, ${counts.requiredChecksInfrastructureFailure} infrastructure, ${counts.requiredChecksCancelled} cancelled, ${counts.requiredChecksMissingOrUnknown} missing or unknown`,
    `${counts.unresolvedReviewThreads} unresolved current review threads; ${counts.currentApprovals}/${counts.requiredApprovals} required approvals observed`,
  ];
  return GitHubPullRequestLifecycleClassificationSchema.parse({
    schemaVersion: 1,
    snapshotId: snapshot.snapshotId,
    status,
    counts,
    checkIds,
    unresolvedThreadIds,
    signature: contentHash(stableEvidence, hashAlgorithm),
    evidence,
  });
}

async function collectSnapshotLifecycle(input: {
  options: GitHubCommandOptions;
  host: string;
  nameWithOwner: string;
  owner: string;
  name: string;
  number: number;
  expectedBinding?: { headSha: string; baseSha: string };
  paginationBudget: GraphQLPaginationBudget;
}): Promise<GitHubSnapshotLifecycleState> {
  const collected = await collectThreads(input);
  const binding = {
    headSha: collected.identity.headRefOid,
    baseSha: collected.identity.baseRefOid,
  };
  if (input.expectedBinding) assertBound(input.expectedBinding, collected.identity);
  const [branchProtection, reviews, checks] = await Promise.all([
    readBranchProtection(input.options, {
      host: input.host,
      nameWithOwner: input.nameWithOwner,
      branch: collected.identity.baseRefName,
    }),
    collectReviews({ ...input, binding }),
    collectChecks({ ...input, headSha: binding.headSha }),
  ]);
  if (branchProtection.status === "unknown")
    throw new Error(`GitHub snapshot preflight failed: ${branchProtection.error}`);
  return {
    repository: {
      nameWithOwner: input.nameWithOwner,
      url: collected.repositoryUrl,
      host: input.host,
      viewerPermission: collected.viewerPermission,
    },
    pullRequest: {
      number: collected.identity.number,
      url: collected.identity.url,
      title: collected.identity.title,
      state: collected.identity.state,
      isDraft: collected.identity.isDraft,
      headRefName: collected.identity.headRefName,
      baseRefName: collected.identity.baseRefName,
      headSha: binding.headSha,
      baseSha: binding.baseSha,
      mergeable: collected.identity.mergeable,
      ...(collected.identity.reviewDecision
        ? { reviewDecision: collected.identity.reviewDecision }
        : {}),
      updatedAt: collected.identity.updatedAt,
    },
    binding,
    branchProtection,
    requiredChecks: requiredCheckObservations(branchProtection, checks),
    checks,
    reviewThreads: collected.threads,
    reviews,
  };
}

export async function captureGitHubPullRequestSnapshot(
  options: GitHubCommandOptions & { pullRequest?: string | number },
  hashAlgorithm: CanonicalHashAlgorithm,
): Promise<GitHubPullRequestSnapshot> {
  const capability = await probeGitHub(options);
  if (!capability.readyForSnapshot || !capability.host || !capability.nameWithOwner)
    throw new Error(`GitHub snapshot preflight failed: ${capability.errors.join("; ")}`);
  const number = await pullRequestNumber(options, options.pullRequest);
  const { owner, name } = repositoryParts(capability.nameWithOwner);
  const paginationBudget = new GraphQLPaginationBudget();
  const collectionInput = {
    options,
    host: capability.host,
    nameWithOwner: capability.nameWithOwner,
    owner,
    name,
    number,
    paginationBudget,
  };
  const first = await collectSnapshotLifecycle(collectionInput);
  const [stable, limits] = await Promise.all([
    collectSnapshotLifecycle({ ...collectionInput, expectedBinding: first.binding }),
    readGitHubRateLimits(options, capability.host),
  ]);
  const finalBinding = await currentBinding({
    options,
    host: capability.host,
    owner,
    name,
    number,
    paginationBudget,
  });
  if (
    finalBinding.headSha !== stable.binding.headSha ||
    finalBinding.baseSha !== stable.binding.baseSha
  )
    throw new Error(
      `GitHub snapshot became stale during capture: ${stable.binding.headSha}/${stable.binding.baseSha} changed to ${finalBinding.headSha}/${finalBinding.baseSha}`,
    );
  const firstFingerprint = lifecycleFingerprint(first, hashAlgorithm);
  const stableFingerprint = lifecycleFingerprint(stable, hashAlgorithm);
  if (stableFingerprint !== firstFingerprint)
    throw new GitHubLifecycleConsistencyError(
      `GitHub snapshot mutable lifecycle changed during capture: ${firstFingerprint} changed to ${stableFingerprint}`,
    );
  const capturedAt = new Date().toISOString();
  const value = {
    schemaVersion: 1 as const,
    contentTrust: "untrusted_external" as const,
    ...stable,
    binding: { ...stable.binding, capturedAt },
    rateLimit: limits,
  };
  return GitHubPullRequestSnapshotSchema.parse({
    ...value,
    snapshotId: contentHash(value, hashAlgorithm),
  });
}
