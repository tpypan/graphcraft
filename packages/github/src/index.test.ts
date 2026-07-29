import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import crossSpawn from "cross-spawn";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedProcessLifecycle, ManagedProcessSettlement } from "@graphcraft/probes";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  contentHash,
} from "@graphcraft/core";
import {
  GITHUB_COMMAND_SETTLEMENT_GRACE_MS,
  GITHUB_COMMAND_TERMINATION_GRACE_MS,
  GitHubCommandCancellationError,
  GitHubCommandResultError,
  GitHubLifecycleConsistencyError,
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
const GITHUB_IDENTITY_HASH_ALGORITHM = PORTABLE_CANONICAL_HASH_ALGORITHM;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
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
const collectionCount = (operation) => fs.readFileSync(logPath, "utf8")
  .split("\\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((call) =>
    call.some((argument) => argument.includes(operation)) &&
    !call.some((argument) => argument.startsWith("cursor="))
  ).length;
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
      required_pull_request_reviews: {
        required_approving_review_count: state.requiredApprovingReviewCount ?? 1,
      },
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
const rateLimit = { cost: state.graphqlPageCost ?? 1, remaining: 4999, resetAt: "2027-01-15T08:00:00.000Z" };
const identity = {
  number: 42,
  url: "https://github.com/tpypan/graphcraft/pull/42",
  title: "Durable GitHub snapshots",
  state: state.pullRequestState ?? "OPEN",
  isDraft: false,
  headRefName: "snapshot-layer",
  baseRefName: "main",
  headRefOid: state.headSha,
  baseRefOid: state.baseSha,
  mergeable: "MERGEABLE",
  reviewDecision: state.greenLifecycle
    ? (state.reviewVersion === 1 ? "REVIEW_REQUIRED" : "APPROVED")
    : "CHANGES_REQUESTED",
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
        pageInfo: state.repeatReviewCommentCursor
          ? { hasNextPage: true, endCursor: "comment-repeat" }
          : { hasNextPage: next < thread.comments.length, endCursor: next < thread.comments.length ? String(next) : null },
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
      pageInfo: state.repeatPullRequestCursor
        ? { hasNextPage: true, endCursor: "pull-repeat" }
        : state.advancePullRequestCursor
          ? { hasNextPage: true, endCursor: String(start + 1) }
          : { hasNextPage: next < matching.length, endCursor: next < matching.length ? String(next) : null },
    } },
    rateLimit,
  } });
  process.exit(0);
}
if (query.includes("GraphcraftPullRequestThreads")) {
  const second = fields.cursor === "thread-next";
  const threadVersion =
    state.threadVersion === 1 ||
    (state.mutateThreadOnCollection &&
      collectionCount("GraphcraftPullRequestThreads") >= state.mutateThreadOnCollection)
      ? 1
      : 0;
  send({ data: {
    repository: {
      url: "https://github.com/tpypan/graphcraft",
      viewerPermission: state.permission,
      pullRequest: { ...identity, reviewThreads: {
        nodes: [{
          id: second ? "thread-2" : "thread-1",
          isResolved: second || (state.greenLifecycle ? threadVersion !== 1 : threadVersion === 1),
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
        pageInfo: state.repeatSnapshotThreadCursor
          ? { hasNextPage: true, endCursor: "thread-next" }
          : { hasNextPage: !second, endCursor: second ? null : "thread-next" },
      } },
    },
    rateLimit,
  } });
  process.exit(0);
}
if (query.includes("GraphcraftPullRequestReviews")) {
  const second = fields.cursor === "review-next";
  const reviewVersion =
    state.reviewVersion === 1 ||
    (state.mutateReviewOnCollection &&
      collectionCount("GraphcraftPullRequestReviews") >= state.mutateReviewOnCollection)
      ? 1
      : 0;
  send({ data: {
    repository: { pullRequest: {
      headRefOid: state.headSha,
      baseRefOid: state.baseSha,
      reviews: {
        nodes: [{
          id: second ? "review-2" : "review-1",
          state: second
            ? (reviewVersion === 1 ? "DISMISSED" : "APPROVED")
            : "CHANGES_REQUESTED",
          author: { login: second ? "reviewer-b" : "reviewer-a" },
          commit: { oid: state.headSha },
          submittedAt: "2026-07-21T20:00:00.000Z",
        }],
        pageInfo: state.repeatSnapshotReviewCursor
          ? { hasNextPage: true, endCursor: "review-next" }
          : { hasNextPage: !second, endCursor: second ? null : "review-next" },
      },
    } },
    rateLimit,
  } });
  process.exit(0);
}
if (query.includes("GraphcraftCommitChecks")) {
  const second = fields.cursor === "check-next";
  const checkVersion =
    state.checkVersion === 1 ||
    (state.mutateCheckOnCollection &&
      collectionCount("GraphcraftCommitChecks") >= state.mutateCheckOnCollection)
      ? 1
      : 0;
  send({ data: {
    repository: { object: {
      oid: state.headSha,
      statusCheckRollup: { contexts: {
        nodes: second
          ? [{ __typename: "StatusContext", id: "status-1", context: "lint", state: state.greenLifecycle ? "SUCCESS" : "PENDING", targetUrl: "https://github.com/checks/lint" }]
          : [{ __typename: "CheckRun", id: "check-1", databaseId: 101, name: "tests", status: checkVersion === 1 ? "IN_PROGRESS" : "COMPLETED", conclusion: checkVersion === 1 ? null : "SUCCESS", detailsUrl: "https://github.com/checks/tests", app: { databaseId: 1 } }],
        pageInfo: state.repeatSnapshotCheckCursor
          ? { hasNextPage: true, endCursor: "check-next" }
          : { hasNextPage: !second, endCursor: second ? null : "check-next" },
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

async function expectLifecycleConsistency(
  promise: Promise<unknown>,
  message: RegExp,
): Promise<void> {
  let observed: unknown;
  try {
    await promise;
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(GitHubLifecycleConsistencyError);
  expect(observed).toMatchObject({ message: expect.stringMatching(message) });
}

let managedBrokerSequence = 0;

function installManagedBroker(
  callbacks: Partial<Pick<ManagedProcessLifecycle, "onReady" | "onSettled">> = {},
): {
  broker: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    connected: boolean;
    pid: number;
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  lifecycle: ManagedProcessLifecycle;
  spawn: ReturnType<typeof vi.spyOn>;
} {
  managedBrokerSequence += 1;
  const pid = 40_000 + managedBrokerSequence;
  const broker = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: true,
    pid,
    send: vi.fn(() => true),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  const lifecycle: ManagedProcessLifecycle = {
    executionId: `github-managed-${managedBrokerSequence}`,
    ownerToken: `owner-${managedBrokerSequence}`,
    journalFd: 1,
    onReady: callbacks.onReady ?? (async () => undefined),
    onSettled: callbacks.onSettled ?? (async () => undefined),
  };
  const spawn = vi.spyOn(crossSpawn, "spawn").mockReturnValue(broker as never);
  return { broker, lifecycle, spawn };
}

async function authorizeManagedBroker(
  input: ReturnType<typeof installManagedBroker>,
): Promise<void> {
  await vi.waitFor(() => expect(input.spawn).toHaveBeenCalledOnce());
  input.broker.emit("message", {
    type: "ready",
    schemaVersion: 1,
    executionId: input.lifecycle.executionId,
    brokerPid: input.broker.pid,
    processGroupId: null,
    platform: process.platform,
    readyAt: new Date().toISOString(),
  });
  await vi.waitFor(() =>
    expect(input.broker.send).toHaveBeenCalledWith(expect.objectContaining({ type: "start" })),
  );
}

function settleManagedBroker(
  input: ReturnType<typeof installManagedBroker>,
  settlement: Partial<ManagedProcessSettlement> = {},
): void {
  input.broker.emit("message", {
    type: "settled",
    status: "settled",
    schemaVersion: 1,
    executionId: input.lifecycle.executionId,
    brokerPid: input.broker.pid,
    childPid: 50_000 + managedBrokerSequence,
    outcome: "exited",
    confirmed: true,
    exitCode: 0,
    exitSignal: null,
    settledAt: new Date().toISOString(),
    ...settlement,
  });
}

describe("GitHub capability and snapshot layer", () => {
  it("rejects an already-aborted command before spawn without exposing its reason", async () => {
    const abort = new AbortController();
    abort.abort({ cause: "user_stop", reason: "ghp_should_not_escape" });
    const spawn = vi.spyOn(crossSpawn, "spawn").mockImplementation(() => {
      throw new Error("spawn must not be reached");
    });

    const observed = await probeGitHub({
      command: "gh-fixture",
      cwd: process.cwd(),
      signal: abort.signal,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(observed).toBeInstanceOf(GitHubCommandCancellationError);
    expect(observed).toMatchObject({
      name: "GitHubCommandCancellationError",
      outcome: "cancelled_before_spawn",
      message: "GitHub command was cancelled before spawn",
    });
    expect(String(observed)).not.toContain("ghp_should_not_escape");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports confirmed child settlement when an active command is aborted", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.spyOn(crossSpawn, "spawn").mockReturnValue(child as never);
    const abort = new AbortController();

    const command = rerequestGitHubCheckRun(
      { command: "gh-fixture", cwd: process.cwd(), signal: abort.signal },
      { host: "github.com", nameWithOwner: "tpypan/graphcraft", databaseId: 101 },
    );
    abort.abort({ cause: "user_pause", reason: "private pause reason" });
    child.emit("close", null, "SIGTERM");
    const observed = await command.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(
      GITHUB_COMMAND_TERMINATION_GRACE_MS + GITHUB_COMMAND_SETTLEMENT_GRACE_MS + 1,
    );

    expect(observed).toBeInstanceOf(GitHubCommandCancellationError);
    expect(observed).toMatchObject({ outcome: "terminated" });
    expect(String(observed)).not.toContain("private pause reason");
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("reports unconfirmed settlement after bounded abort escalation", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.spyOn(crossSpawn, "spawn").mockReturnValue(child as never);
    const abort = new AbortController();

    const command = rerequestGitHubCheckRun(
      { command: "gh-fixture", cwd: process.cwd(), signal: abort.signal },
      { host: "github.com", nameWithOwner: "tpypan/graphcraft", databaseId: 101 },
    );
    const observedCommand = command.then(
      () => undefined,
      (error: unknown) => error,
    );
    abort.abort(new Error("private abort reason"));
    await vi.advanceTimersByTimeAsync(
      GITHUB_COMMAND_TERMINATION_GRACE_MS + GITHUB_COMMAND_SETTLEMENT_GRACE_MS + 1,
    );
    const observed = await observedCommand;

    expect(observed).toBeInstanceOf(GitHubCommandCancellationError);
    expect(observed).toMatchObject({ outcome: "unconfirmed" });
    expect(String(observed)).not.toContain("private abort reason");
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("preserves timeout precedence when cancellation arrives during settlement", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.spyOn(crossSpawn, "spawn").mockReturnValue(child as never);
    const abort = new AbortController();

    const command = rerequestGitHubCheckRun(
      { command: "gh-fixture", cwd: process.cwd(), signal: abort.signal, timeoutMs: 10 },
      { host: "github.com", nameWithOwner: "tpypan/graphcraft", databaseId: 101 },
    );
    const observedCommand = command.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    abort.abort(new Error("late private abort reason"));
    await vi.advanceTimersByTimeAsync(
      GITHUB_COMMAND_TERMINATION_GRACE_MS + GITHUB_COMMAND_SETTLEMENT_GRACE_MS + 1,
    );
    const observed = await observedCommand;

    expect(observed).not.toBeInstanceOf(GitHubCommandCancellationError);
    expect(observed).toMatchObject({
      name: "GitHubCommandError",
      message: "gh exceeded its 10ms timeout",
      childSettlement: "unconfirmed",
    });
    expect(String(observed)).not.toContain("late private abort reason");
  });

  it("retains unconfirmed settlement when bounded output termination never closes", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.spyOn(crossSpawn, "spawn").mockReturnValue(child as never);

    const command = rerequestGitHubCheckRun(
      { command: "gh-fixture", cwd: process.cwd() },
      { host: "github.com", nameWithOwner: "tpypan/graphcraft", databaseId: 101 },
    );
    const observedCommand = command.then(
      () => undefined,
      (error: unknown) => error,
    );
    child.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1));
    await vi.advanceTimersByTimeAsync(
      GITHUB_COMMAND_TERMINATION_GRACE_MS + GITHUB_COMMAND_SETTLEMENT_GRACE_MS + 1,
    );
    const observed = await observedCommand;

    expect(observed).toMatchObject({
      name: "GitHubCommandError",
      message: "gh output exceeded the 16MiB safety limit",
      childSettlement: "unconfirmed",
    });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("retains confirmed settlement when mutation-response parsing races cancellation", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.spyOn(crossSpawn, "spawn").mockReturnValue(child as never);
    const abort = new AbortController();

    const command = addGitHubReviewThreadReply(
      { command: "gh-fixture", cwd: process.cwd(), signal: abort.signal },
      {
        host: "github.com",
        threadId: "thread-1",
        body: "Reviewed fix",
        clientMutationId: "graphcraft-action",
      },
    );
    child.stdout.write("{invalid-json");
    child.emit("close", 0);
    abort.abort(new Error("pause after command settlement"));
    const observed = await command.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(observed).toBeInstanceOf(GitHubCommandResultError);
    expect(observed).toMatchObject({
      message: "gh returned invalid JSON for api graphql",
      childSettlement: "confirmed",
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("allows a managed GitHub response that uses 10MiB on one stream", async () => {
    const managed = installManagedBroker();
    const command = rerequestGitHubCheckRun(
      { command: process.execPath, cwd: process.cwd(), lifecycle: managed.lifecycle },
      { host: "github.com", nameWithOwner: "tpypan/graphcraft", databaseId: 101 },
    );
    await authorizeManagedBroker(managed);

    managed.broker.stdout.write(Buffer.alloc(10 * 1024 * 1024, "x"));
    settleManagedBroker(managed);
    managed.broker.emit("close", 0);

    await expect(command).resolves.toBeUndefined();
    expect(managed.broker.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "terminate" }),
    );
  });

  it("terminates managed GitHub output at the exact combined 16MiB limit", async () => {
    const abort = new AbortController();
    const managed = installManagedBroker();
    const command = rerequestGitHubCheckRun(
      {
        command: process.execPath,
        cwd: process.cwd(),
        lifecycle: managed.lifecycle,
        signal: abort.signal,
      },
      { host: "github.com", nameWithOwner: "tpypan/graphcraft", databaseId: 101 },
    );
    const observedCommand = command.then(
      () => undefined,
      (error: unknown) => error,
    );
    await authorizeManagedBroker(managed);

    managed.broker.stdout.write(Buffer.alloc(9 * 1024 * 1024, "x"));
    managed.broker.stderr.write(Buffer.alloc(8 * 1024 * 1024, "y"));
    abort.abort(new Error("late private cancellation"));
    managed.broker.emit("close", 1);
    const observed = await observedCommand;

    expect(observed).toMatchObject({
      name: "GitHubCommandError",
      message: "gh output exceeded the 16MiB safety limit",
      childSettlement: "unconfirmed",
    });
    expect(String(observed)).not.toContain("late private cancellation");
    expect(managed.broker.send).toHaveBeenCalledWith({ type: "terminate" });
  });

  it("keeps managed timeout precedence over later output and cancellation", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const managed = installManagedBroker();
    const command = rerequestGitHubCheckRun(
      {
        command: process.execPath,
        cwd: process.cwd(),
        lifecycle: managed.lifecycle,
        signal: abort.signal,
        timeoutMs: 2_000,
      },
      { host: "github.com", nameWithOwner: "tpypan/graphcraft", databaseId: 101 },
    );
    const observedCommand = command.then(
      () => undefined,
      (error: unknown) => error,
    );
    await authorizeManagedBroker(managed);
    await vi.advanceTimersByTimeAsync(2_000);

    managed.broker.stdout.write(Buffer.alloc(9 * 1024 * 1024, "x"));
    managed.broker.stderr.write(Buffer.alloc(8 * 1024 * 1024, "y"));
    abort.abort(new Error("late private cancellation"));
    managed.broker.emit("close", 1);
    const observed = await observedCommand;

    expect(observed).toMatchObject({
      name: "GitHubCommandError",
      message: "gh exceeded its 2000ms timeout",
      childSettlement: "unconfirmed",
    });
    expect(String(observed)).not.toContain("late private cancellation");
  });

  it("reports managed cancellation that occurs before target settlement", async () => {
    const abort = new AbortController();
    const managed = installManagedBroker();
    const command = rerequestGitHubCheckRun(
      {
        command: process.execPath,
        cwd: process.cwd(),
        lifecycle: managed.lifecycle,
        signal: abort.signal,
      },
      { host: "github.com", nameWithOwner: "tpypan/graphcraft", databaseId: 101 },
    );
    await authorizeManagedBroker(managed);

    abort.abort(new Error("private cancellation"));
    settleManagedBroker(managed, { outcome: "terminated", exitCode: null });
    managed.broker.emit("close", 0);

    await expect(command).rejects.toMatchObject({
      name: "GitHubCommandCancellationError",
      outcome: "terminated",
    });
  });

  it("preserves managed response validation after target settlement is durable", async () => {
    let releaseSettlement!: () => void;
    let markSettlementStarted!: () => void;
    const settlementStarted = new Promise<void>((resolve) => (markSettlementStarted = resolve));
    const settlementDurable = new Promise<void>((resolve) => (releaseSettlement = resolve));
    const managed = installManagedBroker({
      onSettled: async () => {
        markSettlementStarted();
        await settlementDurable;
      },
    });
    const abort = new AbortController();
    const command = addGitHubReviewThreadReply(
      {
        command: process.execPath,
        cwd: process.cwd(),
        lifecycle: managed.lifecycle,
        signal: abort.signal,
      },
      {
        host: "github.com",
        threadId: "thread-1",
        body: "Reviewed fix",
        clientMutationId: "graphcraft-action",
      },
    );
    await authorizeManagedBroker(managed);

    managed.broker.stdout.write("{invalid-json");
    settleManagedBroker(managed);
    await settlementStarted;
    managed.broker.emit("close", 0);
    abort.abort(new Error("pause after target settlement"));
    releaseSettlement();
    const observed = await command.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(observed).toBeInstanceOf(GitHubCommandResultError);
    expect(observed).toMatchObject({
      message: "gh returned invalid JSON for api graphql",
      childSettlement: "confirmed",
    });
  });

  it("preserves a child error that occurs before cancellation and removes the abort listener", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.spyOn(crossSpawn, "spawn").mockReturnValue(child as never);
    const abort = new AbortController();
    const failure = new Error("spawn transport failed");

    const command = rerequestGitHubCheckRun(
      { command: "gh-fixture", cwd: process.cwd(), signal: abort.signal },
      { host: "github.com", nameWithOwner: "tpypan/graphcraft", databaseId: 101 },
    );
    child.emit("error", failure);
    abort.abort(new Error("late cancellation"));

    await expect(command).rejects.toBe(failure);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("preserves cancellation precedence over a later child error", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.spyOn(crossSpawn, "spawn").mockReturnValue(child as never);
    const abort = new AbortController();

    const command = rerequestGitHubCheckRun(
      { command: "gh-fixture", cwd: process.cwd(), signal: abort.signal },
      { host: "github.com", nameWithOwner: "tpypan/graphcraft", databaseId: 101 },
    );
    const observedCommand = command.then(
      () => undefined,
      (error: unknown) => error,
    );
    abort.abort(new Error("private cancellation"));
    child.emit("error", new Error("private late child error"));
    await vi.advanceTimersByTimeAsync(
      GITHUB_COMMAND_TERMINATION_GRACE_MS + GITHUB_COMMAND_SETTLEMENT_GRACE_MS + 1,
    );
    const observed = await observedCommand;

    expect(observed).toBeInstanceOf(GitHubCommandCancellationError);
    expect(observed).toMatchObject({ outcome: "unconfirmed" });
    expect(String(observed)).not.toMatch(/private cancellation|private late child error/u);
  });

  it("settles after escalation when a timed-out GitHub child never emits close", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.spyOn(crossSpawn, "spawn").mockReturnValue(child as never);

    const probing = probeGitHub({
      command: "gh-fixture",
      cwd: process.cwd(),
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(
      10 + GITHUB_COMMAND_TERMINATION_GRACE_MS + GITHUB_COMMAND_SETTLEMENT_GRACE_MS + 1,
    );

    await expect(probing).resolves.toMatchObject({
      installed: false,
      errors: [expect.stringMatching(/exceeded its 10ms timeout/i)],
    });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("fully paginates one SHA-bound read-only pull request snapshot", async () => {
    const fixture = await fakeGitHub();
    const snapshot = await captureGitHubPullRequestSnapshot(
      fixture,
      GITHUB_IDENTITY_HASH_ALGORITHM,
    );

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
    ).toHaveLength(4);
    expect(calls.filter((args) => args.includes("cursor=thread-next"))).toHaveLength(2);
    expect(calls.filter((args) => args.includes("cursor=review-next"))).toHaveLength(2);
    expect(calls.filter((args) => args.includes("cursor=check-next"))).toHaveLength(2);
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

  it.each([
    ["legacy-v1", LEGACY_CANONICAL_HASH_ALGORITHM],
    ["portable-v2", PORTABLE_CANONICAL_HASH_ALGORITHM],
  ] as const)("binds a %s snapshot ID to its explicit hash algorithm", async (_name, algorithm) => {
    const fixture = await fakeGitHub();
    const snapshot = await captureGitHubPullRequestSnapshot(fixture, algorithm);
    const { snapshotId, ...value } = snapshot;

    expect(snapshotId).toBe(contentHash(value, algorithm));
  });

  it.each([
    ["review-thread", "mutateThreadOnCollection"],
    ["review", "mutateReviewOnCollection"],
    ["check", "mutateCheckOnCollection"],
  ] as const)("rejects a same-SHA %s mutation during capture", async (_kind, mutationKey) => {
    const fixture = await fakeGitHub({ greenLifecycle: true, [mutationKey]: 2 });

    await expectLifecycleConsistency(
      captureGitHubPullRequestSnapshot(fixture, GITHUB_IDENTITY_HASH_ALGORITHM),
      /mutable lifecycle changed during capture/,
    );
    const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
      headSha: string;
      baseSha: string;
    };
    expect(state).toMatchObject({ headSha: "a".repeat(40), baseSha: "b".repeat(40) });
  });

  it.each([
    ["review-thread", "threadVersion"],
    ["review", "reviewVersion"],
    ["check", "checkVersion"],
  ] as const)(
    "rejects a same-SHA %s mutation before accepting a previously green snapshot",
    async (_kind, versionKey) => {
      const fixture = await fakeGitHub({ greenLifecycle: true });
      const snapshot = await captureGitHubPullRequestSnapshot(
        fixture,
        GITHUB_IDENTITY_HASH_ALGORITHM,
      );
      const expected = {
        host: snapshot.repository.host,
        nameWithOwner: snapshot.repository.nameWithOwner,
        number: snapshot.pullRequest.number,
        headRefName: snapshot.pullRequest.headRefName,
        baseRefName: snapshot.pullRequest.baseRefName,
        headSha: snapshot.binding.headSha,
        baseSha: snapshot.binding.baseSha,
      };
      expect(
        classifyGitHubPullRequestLifecycle(snapshot, expected, GITHUB_IDENTITY_HASH_ALGORITHM)
          .status,
      ).toBe("green");
      const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as Record<
        string,
        unknown
      >;
      state[versionKey] = 1;
      await writeFile(fixture.statePath, `${JSON.stringify(state)}\n`);

      await expectLifecycleConsistency(
        assertGitHubSnapshotCurrent(fixture, snapshot, GITHUB_IDENTITY_HASH_ALGORITHM),
        /lifecycle is stale/,
      );
    },
  );

  it("types a same-SHA mutation between lifecycle revalidation passes as transient", async () => {
    const fixture = await fakeGitHub({ greenLifecycle: true, mutateCheckOnCollection: 4 });
    const snapshot = await captureGitHubPullRequestSnapshot(
      fixture,
      GITHUB_IDENTITY_HASH_ALGORITHM,
    );

    await expectLifecycleConsistency(
      assertGitHubSnapshotCurrent(fixture, snapshot, GITHUB_IDENTITY_HASH_ALGORITHM),
      /mutable lifecycle changed during revalidation/,
    );
  });

  it.each([
    ["pull-request state", "pullRequestState", "CLOSED"],
    ["branch protection", "requiredApprovingReviewCount", 2],
  ] as const)("types same-SHA %s drift as transient", async (_kind, key, value) => {
    const fixture = await fakeGitHub({ greenLifecycle: true });
    const snapshot = await captureGitHubPullRequestSnapshot(
      fixture,
      GITHUB_IDENTITY_HASH_ALGORITHM,
    );
    const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as Record<string, unknown>;
    state[key] = value;
    await writeFile(fixture.statePath, `${JSON.stringify(state)}\n`);

    await expectLifecycleConsistency(
      assertGitHubSnapshotCurrent(fixture, snapshot, GITHUB_IDENTITY_HASH_ALGORITHM),
      /lifecycle is stale/,
    );
  });

  it("normalizes lifecycle collection order during revalidation", async () => {
    const fixture = await fakeGitHub({ greenLifecycle: true });
    const snapshot = await captureGitHubPullRequestSnapshot(
      fixture,
      GITHUB_IDENTITY_HASH_ALGORITHM,
    );
    const reordered = {
      ...snapshot,
      branchProtection: {
        ...snapshot.branchProtection,
        requiredStatusChecks: [...snapshot.branchProtection.requiredStatusChecks].reverse(),
      },
      requiredChecks: [...snapshot.requiredChecks].reverse(),
      checks: [...snapshot.checks].reverse(),
      reviewThreads: [...snapshot.reviewThreads].reverse(),
      reviews: [...snapshot.reviews].reverse(),
    };

    await expect(
      assertGitHubSnapshotCurrent(fixture, reordered, GITHUB_IDENTITY_HASH_ALGORITHM),
    ).resolves.toBeUndefined();
  });

  it("rejects repeated cursors in all five GitHub pagination loops", async () => {
    const headRefName = "graphcraft/repeated-cursor";
    const pullRequests = await fakeGitHub({ repeatPullRequestCursor: true });
    await expect(
      listGitHubPullRequestsForHead(pullRequests, {
        host: "github.com",
        nameWithOwner: "tpypan/graphcraft",
        headRefName,
      }),
    ).rejects.toThrow(/pull-request pagination repeated cursor/);

    const comments = await fakeGitHub({ repeatReviewCommentCursor: true });
    await expect(
      readGitHubReviewThread(comments, { host: "github.com", threadId: "thread-action" }),
    ).rejects.toThrow(/review-thread comment pagination repeated cursor/);

    for (const flag of [
      "repeatSnapshotThreadCursor",
      "repeatSnapshotReviewCursor",
      "repeatSnapshotCheckCursor",
    ]) {
      const snapshot = await fakeGitHub({ [flag]: true });
      await expect(
        captureGitHubPullRequestSnapshot(snapshot, GITHUB_IDENTITY_HASH_ALGORITHM),
      ).rejects.toThrow(/pagination repeated cursor/);
    }
  });

  it("bounds advancing cursors by GraphQL cost and page ceilings", async () => {
    const headRefName = "graphcraft/advancing-cursor";
    const costly = await fakeGitHub({ advancePullRequestCursor: true, graphqlPageCost: 25 });
    await expect(
      listGitHubPullRequestsForHead(costly, {
        host: "github.com",
        nameWithOwner: "tpypan/graphcraft",
        headRefName,
      }),
    ).rejects.toThrow(/100-point GraphQL operation budget/);

    const endless = await fakeGitHub({ advancePullRequestCursor: true, graphqlPageCost: 0 });
    await expect(
      listGitHubPullRequestsForHead(endless, {
        host: "github.com",
        nameWithOwner: "tpypan/graphcraft",
        headRefName,
      }),
    ).rejects.toThrow(/32-page operation limit/);
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
    const snapshot = await captureGitHubPullRequestSnapshot(
      fixture,
      GITHUB_IDENTITY_HASH_ALGORITHM,
    );
    const expected = {
      host: snapshot.repository.host,
      nameWithOwner: snapshot.repository.nameWithOwner,
      number: snapshot.pullRequest.number,
      headRefName: snapshot.pullRequest.headRefName,
      baseRefName: snapshot.pullRequest.baseRefName,
      headSha: snapshot.binding.headSha,
      baseSha: snapshot.binding.baseSha,
    };

    const reviewFirst = classifyGitHubPullRequestLifecycle(
      snapshot,
      expected,
      GITHUB_IDENTITY_HASH_ALGORITHM,
    );
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
    const green = classifyGitHubPullRequestLifecycle(
      greenSnapshot,
      expected,
      GITHUB_IDENTITY_HASH_ALGORITHM,
    );
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
    expect(
      classifyGitHubPullRequestLifecycle(recaptured, expected, GITHUB_IDENTITY_HASH_ALGORITHM)
        .signature,
    ).toBe(reviewFirst.signature);
    expect(
      classifyGitHubPullRequestLifecycle(
        snapshot,
        {
          ...expected,
          baseSha: "e".repeat(40),
        },
        GITHUB_IDENTITY_HASH_ALGORITHM,
      ).status,
    ).toBe("stale");
  });

  it("uses code-unit normalization for portable lifecycle identities only", async () => {
    const fixture = await fakeGitHub();
    const snapshot = await captureGitHubPullRequestSnapshot(
      fixture,
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );
    const expected = {
      host: snapshot.repository.host,
      nameWithOwner: snapshot.repository.nameWithOwner,
      number: snapshot.pullRequest.number,
      headRefName: snapshot.pullRequest.headRefName,
      baseRefName: snapshot.pullRequest.baseRefName,
      headSha: snapshot.binding.headSha,
      baseSha: snapshot.binding.baseSha,
    };
    const portableBefore = classifyGitHubPullRequestLifecycle(
      snapshot,
      expected,
      PORTABLE_CANONICAL_HASH_ALGORITHM,
    );
    const legacyBefore = classifyGitHubPullRequestLifecycle(
      snapshot,
      expected,
      LEGACY_CANONICAL_HASH_ALGORITHM,
    );
    let portableAfter!: ReturnType<typeof classifyGitHubPullRequestLifecycle>;
    let legacyAfter!: ReturnType<typeof classifyGitHubPullRequestLifecycle>;
    const reversedLocale = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
      this: string,
      other: string,
    ) {
      const left = String(this);
      return left < other ? 1 : left > other ? -1 : 0;
    });
    try {
      portableAfter = classifyGitHubPullRequestLifecycle(
        snapshot,
        expected,
        PORTABLE_CANONICAL_HASH_ALGORITHM,
      );
      legacyAfter = classifyGitHubPullRequestLifecycle(
        snapshot,
        expected,
        LEGACY_CANONICAL_HASH_ALGORITHM,
      );
    } finally {
      reversedLocale.mockRestore();
    }

    expect(portableAfter.signature).toBe(portableBefore.signature);
    expect(legacyAfter.signature).not.toBe(legacyBefore.signature);

    const forbiddenLocale = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("portable GitHub identity used ambient locale ordering");
    });
    try {
      const recaptured = await captureGitHubPullRequestSnapshot(
        fixture,
        PORTABLE_CANONICAL_HASH_ALGORITHM,
      );
      await expect(
        assertGitHubSnapshotCurrent(fixture, recaptured, PORTABLE_CANONICAL_HASH_ALGORITHM),
      ).resolves.toBeUndefined();
      expect(
        classifyGitHubPullRequestLifecycle(recaptured, expected, PORTABLE_CANONICAL_HASH_ALGORITHM)
          .signature,
      ).toBe(portableBefore.signature);
    } finally {
      forbiddenLocale.mockRestore();
    }
  });

  it("separates actionable, infrastructure, cancelled, and pending required checks", async () => {
    const fixture = await fakeGitHub();
    const captured = await captureGitHubPullRequestSnapshot(
      fixture,
      GITHUB_IDENTITY_HASH_ALGORITHM,
    );
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
        GITHUB_IDENTITY_HASH_ALGORITHM,
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
    const snapshot = await captureGitHubPullRequestSnapshot(
      fixture,
      GITHUB_IDENTITY_HASH_ALGORITHM,
    );
    const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as Record<string, unknown>;
    state.headSha = "d".repeat(40);
    await writeFile(fixture.statePath, `${JSON.stringify(state)}\n`);

    await expect(
      assertGitHubSnapshotCurrent(fixture, snapshot, GITHUB_IDENTITY_HASH_ALGORITHM),
    ).rejects.toThrow(/is stale/);

    state.headSha = "a".repeat(40);
    state.baseSha = "e".repeat(40);
    await writeFile(fixture.statePath, `${JSON.stringify(state)}\n`);
    await expect(
      assertGitHubSnapshotCurrent(fixture, snapshot, GITHUB_IDENTITY_HASH_ALGORITHM),
    ).rejects.toThrow(/is stale/);
  });

  it("discards a snapshot if the head changes during pagination", async () => {
    const fixture = await fakeGitHub({ changeOnIdentity: true });

    await expect(
      captureGitHubPullRequestSnapshot(fixture, GITHUB_IDENTITY_HASH_ALGORITHM),
    ).rejects.toThrow(/became stale during capture/);
  });

  it("explains missing authentication and protected-branch visibility without mutation", async () => {
    const unauthenticated = await fakeGitHub({ authenticated: false });
    await expect(probeGitHub(unauthenticated)).resolves.toMatchObject({
      installed: true,
      authenticated: false,
      readyForSnapshot: false,
      errors: [expect.stringMatching(/authentication is unavailable/)],
    });
    await expect(
      captureGitHubPullRequestSnapshot(unauthenticated, GITHUB_IDENTITY_HASH_ALGORITHM),
    ).rejects.toThrow(/snapshot preflight failed/);

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
