import { spawn } from "node:child_process";
import { z } from "zod";
import { contentHash } from "@graphcraft/core";

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

export type GitHubCapabilityReport = z.infer<typeof GitHubCapabilityReportSchema>;
export type GitHubBranchProtection = z.infer<typeof GitHubBranchProtectionSchema>;
export type GitHubPullRequestSnapshot = z.infer<typeof GitHubPullRequestSnapshotSchema>;

export interface GitHubCommandOptions {
  cwd: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

class GitHubCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "GitHubCommandError";
  }
}

async function runCommand(
  options: GitHubCommandOptions,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const command = options.command ?? "gh";
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure: string | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const terminate = (reason: string): void => {
      if (failure) return;
      failure = reason;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceTimer.unref();
    };
    const timeout = setTimeout(
      () => terminate(`gh exceeded its ${options.timeoutMs ?? 60_000}ms timeout`),
      options.timeoutMs ?? 60_000,
    );
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 16 * 1024 * 1024)
        return terminate("gh output exceeded the 16MiB safety limit");
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 16 * 1024 * 1024)
        return terminate("gh output exceeded the 16MiB safety limit");
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (failure) return reject(new GitHubCommandError(failure, exitCode ?? 1));
      const code = exitCode ?? 1;
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new GitHubCommandError(
            stderr.trim() || stdout.trim() || `${command} ${args[0] ?? ""} exited ${code}`,
            code,
          ),
        );
    });
  });
}

async function jsonCommand(options: GitHubCommandOptions, args: string[]): Promise<unknown> {
  const { stdout } = await runCommand(options, args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`gh returned invalid JSON for ${args.slice(0, 2).join(" ")}`);
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

const THREADS_QUERY = `query GraphcraftPullRequestThreads($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){url viewerPermission pullRequest(number:$number){number url title state isDraft headRefName baseRefName headRefOid baseRefOid mergeable reviewDecision updatedAt reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated path line comments(last:1){totalCount nodes{id author{login} body url createdAt}}} pageInfo{hasNextPage endCursor}}}} rateLimit{cost remaining resetAt}}`;
const REVIEWS_QUERY = `query GraphcraftPullRequestReviews($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid reviews(first:100,after:$cursor){nodes{id state author{login} commit{oid} submittedAt} pageInfo{hasNextPage endCursor}}}} rateLimit{cost remaining resetAt}}`;
const CHECKS_QUERY = `query GraphcraftCommitChecks($owner:String!,$name:String!,$head:GitObjectID!,$cursor:String){repository(owner:$owner,name:$name){object(oid:$head){... on Commit{oid statusCheckRollup{contexts(first:100,after:$cursor){nodes{__typename ... on CheckRun{id name status conclusion detailsUrl app{databaseId}} ... on StatusContext{id context state targetUrl}} pageInfo{hasNextPage endCursor}}}}}} rateLimit{cost remaining resetAt}}`;
const IDENTITY_QUERY = `query GraphcraftPullRequestIdentity($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid}} rateLimit{cost remaining resetAt}}`;

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
  do {
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
    cursor = page.reviewThreads.pageInfo.hasNextPage
      ? (page.reviewThreads.pageInfo.endCursor ?? undefined)
      : undefined;
    if (page.reviewThreads.pageInfo.hasNextPage && !cursor)
      throw new Error("GitHub review-thread pagination omitted its next cursor");
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
}): Promise<z.infer<typeof PullRequestReviewSchema>[]> {
  let cursor: string | undefined;
  const reviews: z.infer<typeof PullRequestReviewSchema>[] = [];
  do {
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
    cursor = pullRequest.reviews.pageInfo.hasNextPage
      ? (pullRequest.reviews.pageInfo.endCursor ?? undefined)
      : undefined;
    if (pullRequest.reviews.pageInfo.hasNextPage && !cursor)
      throw new Error("GitHub review pagination omitted its next cursor");
  } while (cursor);
  return reviews;
}

async function collectChecks(input: {
  options: GitHubCommandOptions;
  host: string;
  owner: string;
  name: string;
  headSha: string;
}): Promise<z.infer<typeof CheckObservationSchema>[]> {
  let cursor: string | undefined;
  const checks: z.infer<typeof CheckObservationSchema>[] = [];
  do {
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
    cursor = contexts?.pageInfo.hasNextPage
      ? (contexts.pageInfo.endCursor ?? undefined)
      : undefined;
    if (contexts?.pageInfo.hasNextPage && !cursor)
      throw new Error("GitHub check pagination omitted its next cursor");
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

async function rateLimit(
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
}): Promise<{ headSha: string; baseSha: string }> {
  const response = IdentityResponseSchema.parse(
    await graphql(input.options, input.host, IDENTITY_QUERY, {
      owner: input.owner,
      name: input.name,
      number: input.number,
    }),
  );
  return {
    headSha: response.data.repository.pullRequest.headRefOid,
    baseSha: response.data.repository.pullRequest.baseRefOid,
  };
}

export async function assertGitHubSnapshotCurrent(
  options: GitHubCommandOptions,
  snapshot: GitHubPullRequestSnapshot,
): Promise<void> {
  const parsed = GitHubPullRequestSnapshotSchema.parse(snapshot);
  const { owner, name } = repositoryParts(parsed.repository.nameWithOwner);
  const current = await currentBinding({
    options,
    host: parsed.repository.host,
    owner,
    name,
    number: parsed.pullRequest.number,
  });
  if (current.headSha !== parsed.binding.headSha || current.baseSha !== parsed.binding.baseSha)
    throw new Error(
      `GitHub snapshot ${parsed.snapshotId} is stale: ${parsed.binding.headSha}/${parsed.binding.baseSha} changed to ${current.headSha}/${current.baseSha}`,
    );
}

export async function captureGitHubPullRequestSnapshot(
  options: GitHubCommandOptions & { pullRequest?: string | number },
): Promise<GitHubPullRequestSnapshot> {
  const capability = await probeGitHub(options);
  if (!capability.readyForSnapshot || !capability.host || !capability.nameWithOwner)
    throw new Error(`GitHub snapshot preflight failed: ${capability.errors.join("; ")}`);
  const number = await pullRequestNumber(options, options.pullRequest);
  const { owner, name } = repositoryParts(capability.nameWithOwner);
  const collected = await collectThreads({
    options,
    host: capability.host,
    owner,
    name,
    number,
  });
  const binding = {
    headSha: collected.identity.headRefOid,
    baseSha: collected.identity.baseRefOid,
  };
  const branchProtection = await readBranchProtection(options, {
    host: capability.host,
    nameWithOwner: capability.nameWithOwner,
    branch: collected.identity.baseRefName,
  });
  if (branchProtection.status === "unknown")
    throw new Error(`GitHub snapshot preflight failed: ${branchProtection.error}`);
  const [reviews, checks, limits] = await Promise.all([
    collectReviews({ options, host: capability.host, owner, name, number, binding }),
    collectChecks({
      options,
      host: capability.host,
      owner,
      name,
      headSha: binding.headSha,
    }),
    rateLimit(options, capability.host),
  ]);
  const finalBinding = await currentBinding({
    options,
    host: capability.host,
    owner,
    name,
    number,
  });
  if (finalBinding.headSha !== binding.headSha || finalBinding.baseSha !== binding.baseSha)
    throw new Error(
      `GitHub snapshot became stale during capture: ${binding.headSha}/${binding.baseSha} changed to ${finalBinding.headSha}/${finalBinding.baseSha}`,
    );
  const capturedAt = new Date().toISOString();
  const value = {
    schemaVersion: 1 as const,
    contentTrust: "untrusted_external" as const,
    repository: {
      nameWithOwner: capability.nameWithOwner,
      url: collected.repositoryUrl,
      host: capability.host,
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
    binding: { ...binding, capturedAt },
    branchProtection,
    requiredChecks: requiredCheckObservations(branchProtection, checks),
    checks,
    reviewThreads: collected.threads,
    reviews,
    rateLimit: limits,
  };
  return GitHubPullRequestSnapshotSchema.parse({
    ...value,
    snapshotId: contentHash(value),
  });
}
