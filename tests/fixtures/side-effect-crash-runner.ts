import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  contentHash,
  type RunEvent,
  type SideEffectClaim,
} from "../../packages/core/src/index.ts";
import {
  createGitHubPullRequest,
  rerequestGitHubCheckRun,
} from "../../packages/github/src/index.ts";
import {
  RunStore,
  createAtomicCommitClaim,
  executeSideEffect,
  performAtomicCommit,
  type SideEffectDispatchPolicy,
} from "../../packages/runtime/src/index.ts";

const [
  repository,
  runId,
  mode,
  kind,
  markerPath,
  resultPath,
  launchLogPath,
  recoveryFault = "none",
] = process.argv.slice(2);
if (
  !repository ||
  !runId ||
  !["crash", "resume"].includes(mode ?? "") ||
  !["git_commit", "github_pr_create", "github_check_rerun"].includes(kind ?? "") ||
  !markerPath ||
  !resultPath ||
  !launchLogPath ||
  !["none", "replace_journal_after_reconcile"].includes(recoveryFault)
)
  throw new Error("Invalid side-effect crash-runner arguments");

const blockingMutation = String.raw`
const { appendFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const markerPath = process.argv[1];
const launchLogPath = process.argv[2];
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
appendFileSync(launchLogPath, "crash\n");
writeFileSync(markerPath, JSON.stringify({
  childPid: process.pid,
  transportPid: process.pid,
  descendantPid: descendant.pid,
  commandArgs: process.argv.slice(3),
}) + "\n");
process.on("SIGTERM", () => {});
setInterval(() => {
  process.stdout.write("mutation still active\n");
  process.stderr.write("mutation still active\n");
}, 25);
`;
const completingMutation = String.raw`
const { appendFileSync, writeFileSync } = require("node:fs");
appendFileSync(process.argv[2], "resume\n");
writeFileSync(process.argv[1], "applied\n");
`;

class SideEffectCrashStore extends RunStore {
  override async append(
    actor: RunEvent["actor"],
    type: RunEvent["type"],
    data: Record<string, unknown>,
    causationId = this.runId,
  ): Promise<RunEvent> {
    const event = await super.append(actor, type, data, causationId);
    if (
      recoveryFault === "replace_journal_after_reconcile" &&
      type === "side_effect.process.reconciled"
    ) {
      const journalPath = join(
        this.graphcraftRoot,
        "locks",
        "side-effect-processes",
        this.runId,
        `${claim.actionId}.jsonl`,
      );
      rmSync(journalPath, { force: true });
      mkdirSync(journalPath);
    }
    return event;
  }
}

const store = new SideEffectCrashStore(repository, runId);
await store.loadState();
const claim: SideEffectClaim =
  kind === "git_commit"
    ? await createAtomicCommitClaim(
        { path: repository, branch: "main", created: false },
        runId,
        "mutation",
        store.repositorySideEffectIdentityHashAlgorithm,
      )
    : {
        schemaVersion: 1,
        actionId: contentHash(
          { schemaVersion: 1, runId, nodeId: "mutation", kind },
          PORTABLE_CANONICAL_HASH_ALGORITHM,
        ),
        idempotencyKey: `graphcraft-${runId}-${kind}`,
        nodeId: "mutation",
        kind: kind as SideEffectClaim["kind"],
        target: `fixture-${kind}`,
        precondition: { fixture: "side-effect-process-crash" },
        claimedAt: "2026-07-29T12:00:00.000Z",
      };
const dispatchPolicy: SideEffectDispatchPolicy =
  claim.kind === "github_check_rerun" ? "at_most_once" : "reconcile_then_retry";
process.env.GRAPHCRAFT_SIDE_EFFECT_FIXTURE_MODE = mode;
process.env.GRAPHCRAFT_SIDE_EFFECT_FIXTURE_MARKER = markerPath;
process.env.GRAPHCRAFT_SIDE_EFFECT_FIXTURE_RESULT = resultPath;
process.env.GRAPHCRAFT_SIDE_EFFECT_FIXTURE_LOG = launchLogPath;
await executeSideEffect({
  store,
  claim,
  dispatchPolicy,
  reconcile: async () =>
    existsSync(resultPath)
      ? { status: "applied", result: { applied: true }, evidence: ["fixture result exists"] }
      : { status: "not_applied", evidence: ["fixture result is absent"] },
  act: async (_claim, prepareProcess) => {
    if (claim.kind === "git_commit")
      return await performAtomicCommit(
        { path: repository, branch: "main", created: false },
        claim,
        "Exercise crash-safe commit transport",
        store.repositorySideEffectIdentityHashAlgorithm,
        prepareProcess,
      );
    const lifecycle = await prepareProcess({ managedProcess: true });
    if (!lifecycle) throw new Error("Managed side-effect lifecycle was not prepared");
    const commandOptions = {
      cwd: repository,
      command: process.execPath,
      commandArgs: [
        "-e",
        mode === "crash" ? blockingMutation : completingMutation,
        mode === "crash" ? markerPath : resultPath,
        launchLogPath,
      ],
      timeoutMs: 30_000,
      lifecycle,
    };
    if (claim.kind === "github_pr_create")
      await createGitHubPullRequest(commandOptions, {
        nameWithOwner: "fixture/graphcraft",
        headRefName: "graphcraft/fixture",
        baseRefName: "main",
        title: "Graphcraft fixture",
        body: `<!-- ${claim.idempotencyKey} -->`,
      });
    else
      await rerequestGitHubCheckRun(commandOptions, {
        host: "github.example.test",
        nameWithOwner: "fixture/graphcraft",
        databaseId: 701,
      });
    return { applied: true };
  },
});

appendFileSync(launchLogPath, `${mode}-complete\n`);
