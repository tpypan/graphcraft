import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertGitHubPushCapability,
  assertGitHubSnapshotCurrent,
  captureGitHubPullRequestSnapshot,
  probeGitHub,
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
  env: NodeJS.ProcessEnv;
  statePath: string;
  logPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "graphcraft-github-test-"));
  temporaryRoots.push(cwd);
  const command = join(cwd, "gh");
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
      ...state,
    })}\n`,
  );
  await writeFile(
    command,
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
if (args[0] === "pr" && args[1] === "view") { send({ number: 42 }); process.exit(0); }
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
          : [{ __typename: "CheckRun", id: "check-1", name: "tests", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/checks/tests", app: { databaseId: 1 } }],
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
  await chmod(command, 0o700);
  return {
    cwd,
    command,
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
});
