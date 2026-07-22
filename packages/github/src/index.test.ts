import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addGitHubReviewThreadReply,
  assertGitHubPushCapability,
  assertGitHubSnapshotCurrent,
  captureGitHubPullRequestSnapshot,
  classifyGitHubPullRequestLifecycle,
  createGitHubPullRequest,
  listGitHubPullRequestsForHead,
  probeGitHub,
  readGitHubReviewThread,
  readGitHubPullRequestIdentity,
  rerequestGitHubCheckRun,
  resolveGitHubReviewThread,
} from "./index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fakeGitHub(state: Record<string, unknown> = {}): Promise<{
  cwd: string;
  command: string;
  commandArgs: string[];
  env: NodeJS.ProcessEnv;
  statePath: string;
  logPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "graphcraft-github-test-"));
  temporaryRoots.push(cwd);
  const script = join(cwd, "gh.cjs");
  const statePath = join(cwd, "state.json");
  const logPath = join(cwd, "calls.jsonl");
  await writeFile(
    statePath,
    `${JSON.stringify({
      authenticated: true,
      permission: "WRITE",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      identityCalls: 0,
      pullRequests: [],
      rerunCalls: 0,
      reviewThread: {
        id: "thread-action",
        isResolved: false,
        isOutdated: false,
        path: "src/action.ts",
        line: 12,
        comments: [
          {
            id: "comment-action-1",
            author: "reviewer",
            body: "Please update this behavior",
            url: "https://github.com/tpypan/graphcraft/pull/42#discussion_action_1",
            createdAt: "2026-07-22T02:00:00.000Z",
          },
          {
            id: "comment-action-2",
            author: "reviewer",
            body: "This is the latest request",
            url: "https://github.com/tpypan/graphcraft/pull/42#discussion_action_2",
            createdAt: "2026-07-22T02:01:00.000Z",
          },
        ],
      },
      ...state,
    })}\n`,
  );
  await writeFile(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.GRAPHCRAFT_GH_STATE;
const logPath = process.env.GRAPHCRAFT_GH_LOG;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const fail = (message, code = 1) => { process.stderr.write(message + "\\n"); process.exit(code); };
if (args[0] === "--version") { console.log("gh version 2.80.0"); process.exit(0); }
if (args[0] === "auth") {
  if (state.authenticated) { console.log("github.com authenticated"); process.exit(0); }
  fail("not logged into any GitHub hosts");
}
if (args[0] === "repo" && args[1] === "view") {
  send({
    nameWithOwner: "tpypan/graphcraft",
    url: "https://github.com/tpypan/graphcraft",
    viewerPermission: state.permission,
    defaultBranchRef: { name: "main" },
  });
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const fields = args[args.indexOf("--json") + 1];
  if (fields === "number") { send({ number: 42 }); process.exit(0); }
  const number = Number(args[2]);
  const pullRequest = state.pullRequests.find((candidate) => candidate.number === number);
  if (!pullRequest) fail("pull request not found");
  send({
    number: pullRequest.number,
    url: pullRequest.url,
    title: pullRequest.title,
    body: pullRequest.body,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    headRefName: pullRequest.headRefName,
    baseRefName: pullRequest.baseRefName,
    headRefOid: pullRequest.headSha,
    baseRefOid: pullRequest.baseSha,
  });
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const value = (flag) => args[args.indexOf(flag) + 1];
  const headRefName = value("--head");
  if (state.pullRequests.some((candidate) => candidate.headRefName === headRefName && candidate.state === "OPEN"))
    fail("a pull request for this branch already exists");
  const number = 100 + state.pullRequests.length;
  const pullRequest = {
    number,
    url: "https://github.com/tpypan/graphcraft/pull/" + number,
    title: value("--title"),
    body: value("--body"),
    state: "OPEN",
    isDraft: false,
    headRefName,
    baseRefName: value("--base"),
    headSha: state.headSha,
    baseSha: state.baseSha,
  };
  state.pullRequests.push(pullRequest);
  fs.writeFileSync(statePath, JSON.stringify(state) + "\\n");
  console.log(pullRequest.url);
  process.exit(0);
}
if (args[0] !== "api") fail("unexpected command: " + args.join(" "));
const endpoint = args.find((value, index) => index > 0 && !value.startsWith("-") && args[index - 1] !== "--hostname" && args[index - 1] !== "-f" && args[index - 1] !== "-F");
if (endpoint === "rate_limit") {
  send({ resources: {
    core: { limit: 5000, used: 10, remaining: 4990, reset: 1800000000 },
    graphql: { limit: 5000, used: 20, remaining: 4980, reset: 1800000000 },
  } });
  process.exit(0);
}
if (endpoint && endpoint.startsWith("repos/tpypan/graphcraft/branches/")) {
  if (endpoint.endsWith("/protection")) {
    if (state.protectionDenied) fail("HTTP 403: Resource not accessible by integration");
    send({
      required_status_checks: {
        contexts: ["tests", "lint"],
        checks: [{ context: "tests", app_id: 1 }, { context: "lint", app_id: null }],
      },
      required_pull_request_reviews: { required_approving_review_count: 1 },
    });
  } else send({ protected: state.protected !== false });
  process.exit(0);
}
if (endpoint === "repos/tpypan/graphcraft/check-runs/101/rerequest") {
  state.rerunCalls += 1;
  fs.writeFileSync(statePath, JSON.stringify(state) + "\\n");
  process.exit(0);
}
if (args[1] !== "graphql") fail("unexpected api endpoint: " + endpoint);
const fields = {};
for (let index = 0; index < args.length - 1; index += 1) {
  if (args[index] === "-f" || args[index] === "-F") {
    const [key, ...value] = args[index + 1].split("=");
    fields[key] = value.join("=");
  }
}
const query = fields.query || "";
const rateLimit = { cost: 1, remaining: 4999, resetAt: "2027-01-15T08:00:00.000Z" };
const identity = {
  number: 42,
  url: "https://github.com/tpypan/graphcraft/pull/42",
  title: "Durable GitHub snapshots",
  state: "OPEN",
  isDraft: false,
  headRefName: "snapshot-layer",
  baseRefName: "main",
  headRefOid: state.headSha,
  baseRefOid: state.baseSha,
  mergeable: "MERGEABLE",
  reviewDecision: "CHANGES_REQUESTED",
  updatedAt: "2026-07-21T20:00:00.000Z",
};
if (query.includes("GraphcraftReviewThread")) {
  const thread = state.reviewThread;
  if (!thread || thread.id !== fields.threadId) send({ data: { node: null, rateLimit } });
  else {
    const start = fields.cursor ? Number(fields.cursor) : 0;
    const size = state.paginateReviewThread ? 1 : 100;
    const selected = thread.comments.slice(start, start + size);
    const next = start + selected.length;
    send({ data: { node: {
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      comments: {
        nodes: selected.map((comment) => ({
          id: comment.id,
          author: comment.author ? { login: comment.author } : null,
          body: comment.body,
          url: comment.url,
          createdAt: comment.createdAt,
        })),
        pageInfo: { hasNextPage: next < thread.comments.length, endCursor: next < thread.comments.length ? String(next) : null },
      },
    }, rateLimit } });
  }
  process.exit(0);
}
if (query.includes("GraphcraftAddReviewReply")) {
  const thread = state.reviewThread;
  if (!thread || thread.id !== fields.threadId) fail("review thread not found");
  const comment = {
    id: "comment-action-" + (thread.comments.length + 1),
    author: "graphcraft",
    body: fields.body,
    url: "https://github.com/tpypan/graphcraft/pull/42#discussion_action_" + (thread.comments.length + 1),
    createdAt: "2026-07-22T02:02:00.000Z",
  };
  thread.comments.push(comment);
  fs.writeFileSync(statePath, JSON.stringify(state) + "\\n");
  send({ data: { addPullRequestReviewThreadReply: {
    clientMutationId: fields.clientMutationId,
    comment: { id: comment.id, body: comment.body, url: comment.url },
  } } });
  process.exit(0);
}
if (query.includes("GraphcraftResolveReviewThread")) {
  const thread = state.reviewThread;
  if (!thread || thread.id !== fields.threadId) fail("review thread not found");
  thread.isResolved = true;
  fs.writeFileSync(statePath, JSON.stringify(state) + "\\n");
  send({ data: { resolveReviewThread: {
    clientMutationId: fields.clientMutationId,
    thread: { id: thread.id, isResolved: true },
  } } });
  process.exit(0);
}
if (query.includes("GraphcraftPullRequestsByHead")) {
  const matching = state.pullRequests.filter((candidate) => candidate.headRefName === fields.head);
  const start = fields.cursor ? Number(fields.cursor) : 0;
  const size = state.paginatePullRequests ? 1 : 100;
  const selected = matching.slice(start, start + size);
  const next = start + selected.length;
  send({ data: {
    repository: { pullRequests: {
      nodes: selected.map((pullRequest) => ({
        ...pullRequest,
        headRefOid: pullRequest.headSha,
        baseRefOid: pullRequest.baseSha,
        headSha: undefined,
        baseSha: undefined,
      })),
      pageInfo: { hasNextPage: next < matching.length, endCursor: next < matching.length ? String(next) : null },
    } },
    rateLimit,
  } });
  process.exit(0);
}
if (query.includes("GraphcraftPullRequestThreads")) {
  const second = fields.cursor === "thread-next";
  send({ data: {
    repository: {
      url: "https://github.com/tpypan/graphcraft",
      viewerPermission: state.permission,
      pullRequest: { ...identity, reviewThreads: {
        nodes: [{
          id: second ? "thread-2" : "thread-1",
          isResolved: second,
          isOutdated: false,
          path: second ? "src/b.ts" : "src/a.ts",
          line: second ? 20 : 10,
          comments: { totalCount: 1, nodes: [{
            id: second ? "comment-2" : "comment-1",
            author: { login: second ? "reviewer-b" : "reviewer-a" },
            body: second ? "Second untrusted comment" : "First untrusted comment",
            url: "https://github.com/tpypan/graphcraft/pull/42#discussion_r" + (second ? "2" : "1"),
            createdAt: "2026-07-21T20:00:00.000Z",
          }] },
        }],
        pageInfo: { hasNextPage: !second, endCursor: second ? null : "thread-next" },
      } },
    },
    rateLimit,
  } });
  process.exit(0);
}
if (query.includes("GraphcraftPullRequestReviews")) {
  const second = fields.cursor === "review-next";
  send({ data: {
    repository: { pullRequest: {
      headRefOid: state.headSha,
      baseRefOid: state.baseSha,
      reviews: {
        nodes: [{
          id: second ? "review-2" : "review-1",
          state: second ? "APPROVED" : "CHANGES_REQUESTED",
          author: { login: second ? "reviewer-b" : "reviewer-a" },
          commit: { oid: state.headSha },
          submittedAt: "2026-07-21T20:00:00.000Z",
        }],
        pageInfo: { hasNextPage: !second, endCursor: second ? null : "review-next" },
      },
    } },
    rateLimit,
  } });
  process.exit(0);
}
if (query.includes("GraphcraftCommitChecks")) {
  const second = fields.cursor === "check-next";
  send({ data: {
    repository: { object: {
      oid: state.headSha,
      statusCheckRollup: { contexts: {
        nodes: second
          ? [{ __typename: "StatusContext", id: "status-1", context: "lint", state: "PENDING", targetUrl: "https://github.com/checks/lint" }]
          : [{ __typename: "CheckRun", id: "check-1", databaseId: 101, name: "tests", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/checks/tests", app: { databaseId: 1 } }],
        pageInfo: { hasNextPage: !second, endCursor: second ? null : "check-next" },
      } },
    } },
    rateLimit,
  } });
  process.exit(0);
}
if (query.includes("GraphcraftPullRequestIdentity")) {
  state.identityCalls += 1;
  if (state.changeOnIdentity) state.headSha = "c".repeat(40);
  fs.writeFileSync(statePath, JSON.stringify(state) + "\\n");
  send({ data: {
    repository: { pullRequest: { headRefOid: state.headSha, baseRefOid: state.baseSha } },
    rateLimit,
  } });
  process.exit(0);
}
fail("unknown GraphQL operation");
`,
  );
  return {
    cwd,
    command: process.execPath,
    commandArgs: [script],
    statePath,
    logPath,
    env: { ...process.env, GRAPHCRAFT_GH_STATE: statePath, GRAPHCRAFT_GH_LOG: logPath },
  };
}

describe("GitHub capability and snapshot layer", () => {
  it("fully paginates one SHA-bound read-only pull request snapshot", async () => {
    const fixture = await fakeGitHub();
    const snapshot = await captureGitHubPullRequestSnapshot(fixture);

    expect(snapshot.contentTrust).toBe("untrusted_external");
    expect(snapshot.binding).toMatchObject({
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
    });
    expect(snapshot.reviewThreads.map(({ id }) => id)).toEqual(["thread-1", "thread-2"]);
    expect(snapshot.reviews.map(({ id }) => id)).toEqual(["review-1", "review-2"]);
    expect(snapshot.checks.map(({ id }) => id)).toEqual(["check-1", "status-1"]);
    expect(snapshot.requiredChecks).toEqual([
      expect.objectContaining({ context: "tests", appId: 1, state: "success" }),
      expect.objectContaining({ context: "lint", state: "pending" }),
    ]);
    expect(snapshot.branchProtection).toMatchObject({
      status: "protected",
      requiresApprovingReviews: true,
      requiredApprovingReviewCount: 1,
    });
    expect(snapshot.repository.viewerPermission).toBe("WRITE");
    expect(snapshot.rateLimit.graphql.remaining).toBe(4980);

    const calls = (await readFile(fixture.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[][][number]);
    expect(
      calls.filter((args) =>
        args.some((argument) => argument.includes("GraphcraftPullRequestThreads")),
      ),
    ).toHaveLength(2);
    expect(calls.filter((args) => args.includes("cursor=thread-next"))).toHaveLength(1);
    expect(calls.filter((args) => args.includes("cursor=review-next"))).toHaveLength(1);
    expect(calls.filter((args) => args.includes("cursor=check-next"))).toHaveLength(1);
    expect(
      calls.every(([command]) =>
        ["--version", "auth", "repo", "pr", "api"].includes(command ?? ""),
      ),
    ).toBe(true);
    expect(
      calls.some((args) =>
        args.some((argument) =>
          /^(?:create|close|comment|merge|reopen|rerun|resolve)$/.test(argument),
        ),
      ),
    ).toBe(false);
  });

  it("paginates one review thread and confirms explicit reply and resolution mutations", async () => {
    const fixture = await fakeGitHub({ paginateReviewThread: true });
    const before = await readGitHubReviewThread(fixture, {
      host: "github.com",
      threadId: "thread-action",
    });
    const body = "Addressed and verified.\n\n<!-- Graphcraft-Action: reply-1 -->";
    const reply = await addGitHubReviewThreadReply(fixture, {
      host: "github.com",
      threadId: "thread-action",
      body,
      clientMutationId: "reply-1",
    });
    const afterReply = await readGitHubReviewThread(fixture, {
      host: "github.com",
      threadId: "thread-action",
    });
    const resolved = await resolveGitHubReviewThread(fixture, {
      host: "github.com",
      threadId: "thread-action",
      clientMutationId: "resolve-1",
    });
    const afterResolution = await readGitHubReviewThread(fixture, {
      host: "github.com",
      threadId: "thread-action",
    });

    expect(before.comments.map(({ id }) => id)).toEqual(["comment-action-1", "comment-action-2"]);
    expect(reply).toMatchObject({ id: "comment-action-3", body });
    expect(afterReply.comments.at(-1)).toMatchObject({ id: reply.id, body });
    expect(resolved).toEqual({ id: "thread-action", isResolved: true });
    expect(afterResolution.isResolved).toBe(true);
  });

  it("rerequests one check run through the explicit REST mutation", async () => {
    const fixture = await fakeGitHub();

    await rerequestGitHubCheckRun(fixture, {
      host: "github.com",
      nameWithOwner: "tpypan/graphcraft",
      databaseId: 101,
    });
    const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
      rerunCalls: number;
    };

    expect(state.rerunCalls).toBe(1);
  });

  it("classifies exact-SHA review and CI lifecycle states deterministically", async () => {
    const fixture = await fakeGitHub();
    const snapshot = await captureGitHubPullRequestSnapshot(fixture);
    const expected = {
      host: snapshot.repository.host,
      nameWithOwner: snapshot.repository.nameWithOwner,
      number: snapshot.pullRequest.number,
      headRefName: snapshot.pullRequest.headRefName,
      baseRefName: snapshot.pullRequest.baseRefName,
      headSha: snapshot.binding.headSha,
      baseSha: snapshot.binding.baseSha,
    };

    const reviewFirst = classifyGitHubPullRequestLifecycle(snapshot, expected);
    expect(reviewFirst).toMatchObject({
      status: "review_required",
      counts: {
        requiredChecksSucceeded: 1,
        requiredChecksPending: 1,
        unresolvedReviewThreads: 1,
        currentApprovals: 1,
        requiredApprovals: 1,
      },
      unresolvedThreadIds: ["thread-1"],
    });

    const greenSnapshot = {
      ...snapshot,
      pullRequest: { ...snapshot.pullRequest, reviewDecision: "APPROVED" },
      requiredChecks: snapshot.requiredChecks.map((check) => ({
        ...check,
        state: "success" as const,
      })),
      reviewThreads: snapshot.reviewThreads.map((thread) => ({
        ...thread,
        isResolved: true,
      })),
    };
    const green = classifyGitHubPullRequestLifecycle(greenSnapshot, expected);
    expect(green.status).toBe("green");
    expect(green.counts).toMatchObject({
      requiredChecksSucceeded: 2,
      requiredChecksPending: 0,
      unresolvedReviewThreads: 0,
    });

    const recaptured = {
      ...snapshot,
      binding: { ...snapshot.binding, capturedAt: "2026-07-22T23:00:00.000Z" },
      reviewThreads: snapshot.reviewThreads.map((thread) => ({
        ...thread,
        ...(thread.latestComment
          ? {
              latestComment: {
                ...thread.latestComment,
                body: "Different untrusted review text",
              },
            }
          : {}),
      })),
      rateLimit: {
        core: { ...snapshot.rateLimit.core, remaining: 1 },
        graphql: { ...snapshot.rateLimit.graphql, remaining: 2 },
      },
    };
    expect(classifyGitHubPullRequestLifecycle(recaptured, expected).signature).toBe(
      reviewFirst.signature,
    );
    expect(
      classifyGitHubPullRequestLifecycle(snapshot, {
        ...expected,
        baseSha: "e".repeat(40),
      }).status,
    ).toBe("stale");
  });

  it("separates actionable, infrastructure, cancelled, and pending required checks", async () => {
    const fixture = await fakeGitHub();
    const captured = await captureGitHubPullRequestSnapshot(fixture);
    const expected = {
      host: captured.repository.host,
      nameWithOwner: captured.repository.nameWithOwner,
      number: captured.pullRequest.number,
      headRefName: captured.pullRequest.headRefName,
      baseRefName: captured.pullRequest.baseRefName,
      headSha: captured.binding.headSha,
      baseSha: captured.binding.baseSha,
    };
    const base = {
      ...captured,
      pullRequest: { ...captured.pullRequest, reviewDecision: "APPROVED" },
      branchProtection: {
        ...captured.branchProtection,
        requiresApprovingReviews: false,
        requiredApprovingReviewCount: 0,
      },
      reviewThreads: captured.reviewThreads.map((thread) => ({
        ...thread,
        isResolved: true,
      })),
    };
    const classify = (state: "failure" | "pending", conclusion: string | undefined) =>
      classifyGitHubPullRequestLifecycle(
        {
          ...base,
          requiredChecks: [
            {
              context: "tests",
              state,
              matchingCheckIds: ["check-1"],
            },
          ],
          checks: [
            {
              id: "check-1",
              kind: "check_run",
              name: "tests",
              status: state === "pending" ? "IN_PROGRESS" : "COMPLETED",
              ...(conclusion ? { conclusion } : {}),
            },
          ],
        },
        expected,
      );

    expect(classify("failure", "FAILURE")).toMatchObject({
      status: "actionable_failure",
      checkIds: { actionable: ["check-1"] },
    });
    expect(classify("failure", "STARTUP_FAILURE")).toMatchObject({
      status: "infrastructure_failure",
      checkIds: { infrastructure: ["check-1"] },
    });
    expect(classify("failure", "CANCELLED")).toMatchObject({
      status: "cancelled",
      checkIds: { cancelled: ["check-1"] },
    });
    expect(classify("pending", undefined)).toMatchObject({
      status: "waiting",
      checkIds: { pending: ["check-1"] },
    });
  });

  it("rejects a snapshot after either bound SHA changes", async () => {
    const fixture = await fakeGitHub();
    const snapshot = await captureGitHubPullRequestSnapshot(fixture);
    const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as Record<string, unknown>;
    state.headSha = "d".repeat(40);
    await writeFile(fixture.statePath, `${JSON.stringify(state)}\n`);

    await expect(assertGitHubSnapshotCurrent(fixture, snapshot)).rejects.toThrow(/is stale/);

    state.headSha = "a".repeat(40);
    state.baseSha = "e".repeat(40);
    await writeFile(fixture.statePath, `${JSON.stringify(state)}\n`);
    await expect(assertGitHubSnapshotCurrent(fixture, snapshot)).rejects.toThrow(/is stale/);
  });

  it("discards a snapshot if the head changes during pagination", async () => {
    const fixture = await fakeGitHub({ changeOnIdentity: true });

    await expect(captureGitHubPullRequestSnapshot(fixture)).rejects.toThrow(
      /became stale during capture/,
    );
  });

  it("explains missing authentication and protected-branch visibility without mutation", async () => {
    const unauthenticated = await fakeGitHub({ authenticated: false });
    await expect(probeGitHub(unauthenticated)).resolves.toMatchObject({
      installed: true,
      authenticated: false,
      readyForSnapshot: false,
      errors: [expect.stringMatching(/authentication is unavailable/)],
    });
    await expect(captureGitHubPullRequestSnapshot(unauthenticated)).rejects.toThrow(
      /snapshot preflight failed/,
    );

    const denied = await fakeGitHub({ protectionDenied: true });
    await expect(probeGitHub(denied)).resolves.toMatchObject({
      authenticated: true,
      repositoryAccessible: true,
      readyForSnapshot: false,
      branchProtection: { status: "unknown" },
      errors: [expect.stringMatching(/rules are unavailable/)],
    });

    const unreadable = await fakeGitHub({ permission: "NONE", protected: false });
    await expect(probeGitHub(unreadable)).resolves.toMatchObject({
      authenticated: true,
      repositoryAccessible: true,
      readyForSnapshot: false,
      canRead: false,
      canWrite: false,
      errors: [expect.stringMatching(/no readable repository permission/)],
    });

    const readOnly = await fakeGitHub({ permission: "TRIAGE", protected: false });
    await expect(assertGitHubPushCapability(readOnly)).rejects.toThrow(
      /does not have repository write permission/,
    );
    const writable = await fakeGitHub({ permission: "WRITE", protected: false });
    await expect(assertGitHubPushCapability(writable)).resolves.toMatchObject({
      canWrite: true,
      readyForSnapshot: true,
    });
  });

  it("fully paginates head-branch pull requests and exposes one explicit create mutation", async () => {
    const headRefName = "graphcraft/run-branch";
    const existing = await fakeGitHub({
      paginatePullRequests: true,
      pullRequests: [
        {
          number: 7,
          url: "https://github.com/tpypan/graphcraft/pull/7",
          title: "First",
          body: "first",
          state: "CLOSED",
          isDraft: false,
          headRefName,
          baseRefName: "main",
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
        },
        {
          number: 8,
          url: "https://github.com/tpypan/graphcraft/pull/8",
          title: "Second",
          body: "second",
          state: "OPEN",
          isDraft: false,
          headRefName,
          baseRefName: "main",
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
        },
      ],
    });
    await expect(
      listGitHubPullRequestsForHead(existing, {
        host: "github.com",
        nameWithOwner: "tpypan/graphcraft",
        headRefName,
      }),
    ).resolves.toHaveLength(2);
    const existingCalls = (await readFile(existing.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(
      existingCalls.filter((args) =>
        args.some((argument) => argument.includes("GraphcraftPullRequestsByHead")),
      ),
    ).toHaveLength(2);

    const created = await fakeGitHub();
    await createGitHubPullRequest(created, {
      nameWithOwner: "tpypan/graphcraft",
      headRefName,
      baseRefName: "main",
      title: "Create durable PR",
      body: "<!-- Graphcraft-Action: graphcraft-test -->",
    });
    const candidates = await listGitHubPullRequestsForHead(created, {
      host: "github.com",
      nameWithOwner: "tpypan/graphcraft",
      headRefName,
    });
    expect(candidates).toMatchObject([
      { number: 100, state: "OPEN", headRefName, baseRefName: "main" },
    ]);
    await expect(
      readGitHubPullRequestIdentity(created, {
        nameWithOwner: "tpypan/graphcraft",
        number: 100,
      }),
    ).resolves.toMatchObject({ number: 100, state: "OPEN" });
    const createCalls = (await readFile(created.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(createCalls.filter((args) => args[0] === "pr" && args[1] === "create")).toHaveLength(1);
    expect(
      createCalls.some((args) =>
        args.some((argument) => /^(?:close|comment|merge|reopen|rerun|resolve)$/.test(argument)),
      ),
    ).toBe(false);
  });
});
