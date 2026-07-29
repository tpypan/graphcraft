import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  contentHash,
  type SideEffectClaim,
} from "../packages/core/src/index.ts";
import { createRun, RunStore } from "../packages/runtime/src/index.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const tsxLoader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
const runnerPath = resolve("tests/fixtures/side-effect-crash-runner.ts");
const cases = [
  { kind: "git_commit", retries: true },
  { kind: "github_pr_create", retries: true },
  { kind: "github_check_rerun", retries: false },
] as const satisfies ReadonlyArray<{
  kind: Extract<SideEffectClaim["kind"], "git_commit" | "github_pr_create" | "github_check_rerun">;
  retries: boolean;
}>;
type RecoveryFault = "none" | "replace_journal_after_reconcile";
const journalFaultCases = [
  {
    fault: "missing",
    error: /ownership journal for process .* is missing/i,
    childSettlement: "unconfirmed",
    reconciles: false,
  },
  {
    fault: "malformed",
    error: /ambiguous ownership metadata/i,
    childSettlement: "unconfirmed",
    reconciles: false,
  },
  {
    fault: "unremovable",
    error: /confirmed settlement journal cannot be removed/i,
    childSettlement: "confirmed",
    reconciles: true,
  },
] as const;

interface MutationMarker {
  childPid: number;
  descendantPid: number;
  transportPid: number;
  commandArgs?: string[];
}

interface SpawnedRunner {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  diagnostics: () => string;
}

interface RunnerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function createRepository(): Promise<{ repository: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft side-effect restart "));
  temporaryRoots.push(root);
  const repository = join(root, "repository with spaces");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Graphcraft Test");
  await git(repository, "config", "user.email", "graphcraft@example.test");
  await git(repository, "config", "commit.gpgSign", "false");
  await writeFile(
    join(repository, "package.json"),
    `${JSON.stringify({
      name: "side-effect-restart-fixture",
      private: true,
      scripts: { test: "node verify.mjs" },
    })}\n`,
  );
  await writeFile(join(repository, "verify.mjs"), "process.exit(0);\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "fixture");
  const hooks = join(root, "fixture hooks");
  const preCommit = join(hooks, "pre-commit");
  await mkdir(hooks);
  await writeFile(
    preCommit,
    `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const mode = process.env.GRAPHCRAFT_SIDE_EFFECT_FIXTURE_MODE;
const markerPath = process.env.GRAPHCRAFT_SIDE_EFFECT_FIXTURE_MARKER;
const resultPath = process.env.GRAPHCRAFT_SIDE_EFFECT_FIXTURE_RESULT;
const launchLogPath = process.env.GRAPHCRAFT_SIDE_EFFECT_FIXTURE_LOG;
if (!markerPath || !resultPath || !launchLogPath || !["crash", "resume"].includes(mode || "")) process.exit(2);
if (mode === "resume") {
  appendFileSync(launchLogPath, "resume\\n");
  writeFileSync(resultPath, "applied\\n");
  process.exit(0);
}
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
appendFileSync(launchLogPath, "crash\\n");
writeFileSync(markerPath, JSON.stringify({
  childPid: process.ppid,
  transportPid: process.pid,
  descendantPid: descendant.pid,
}) + "\\n");
let terminating = false;
process.on("SIGTERM", () => {
  if (terminating) return;
  terminating = true;
  descendant.once("close", () => process.exit(143));
  descendant.kill("SIGKILL");
});
setInterval(() => {
  process.stdout.write("commit hook still active\\n");
  process.stderr.write("commit hook still active\\n");
}, 25);
`,
  );
  await chmod(preCommit, 0o755);
  await git(repository, "config", "core.hooksPath", hooks);
  return { repository, root };
}

function actionIdFor(runId: string, kind: (typeof cases)[number]["kind"]): string {
  return contentHash(
    { schemaVersion: 1, runId, nodeId: "mutation", kind },
    PORTABLE_CANONICAL_HASH_ALGORITHM,
  );
}

function runnerArguments(
  repository: string,
  runId: string,
  mode: "crash" | "resume",
  kind: (typeof cases)[number]["kind"],
  markerPath: string,
  resultPath: string,
  launchLogPath: string,
  recoveryFault: RecoveryFault = "none",
): string[] {
  return [
    "--import",
    tsxLoader,
    runnerPath,
    repository,
    runId,
    mode,
    kind,
    markerPath,
    resultPath,
    launchLogPath,
    recoveryFault,
  ];
}

function spawnCrashRunner(
  repository: string,
  runId: string,
  kind: (typeof cases)[number]["kind"],
  markerPath: string,
  resultPath: string,
  launchLogPath: string,
): SpawnedRunner {
  const child = spawn(
    process.execPath,
    runnerArguments(repository, runId, "crash", kind, markerPath, resultPath, launchLogPath),
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => (stdout += chunk));
  child.stderr!.on("data", (chunk: string) => (stderr += chunk));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.once("close", (code, signal) => done({ code, signal })),
  );
  return {
    child,
    closed,
    diagnostics: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
  };
}

async function runResume(
  repository: string,
  runId: string,
  kind: (typeof cases)[number]["kind"],
  markerPath: string,
  resultPath: string,
  launchLogPath: string,
  recoveryFault: RecoveryFault = "none",
): Promise<RunnerResult> {
  try {
    const result = await execFileAsync(
      process.execPath,
      runnerArguments(
        repository,
        runId,
        "resume",
        kind,
        markerPath,
        resultPath,
        launchLogPath,
        recoveryFault,
      ),
      { cwd: process.cwd(), timeout: 30_000 },
    );
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string };
    return { ok: false, stdout: result.stdout ?? "", stderr: result.stderr ?? result.message };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`Process ${pid} did not settle after runtime loss`);
    await new Promise<void>((done) => setTimeout(done, 20));
  }
}

async function killProcessForCleanup(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  process.kill(pid, "SIGKILL");
  await waitForProcessExit(pid, 2_000);
}

function positivePid(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error(`${label} did not contain a positive PID`);
  return Number(value);
}

async function waitForMarker(
  markerPath: string,
  crash: SpawnedRunner,
  timeoutMs = 15_000,
): Promise<MutationMarker> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as Partial<MutationMarker>;
      return {
        childPid: positivePid(marker.childPid, "mutation marker"),
        descendantPid: positivePid(marker.descendantPid, "mutation descendant marker"),
        transportPid: positivePid(marker.transportPid, "mutation transport marker"),
        ...(Array.isArray(marker.commandArgs) &&
        marker.commandArgs.every((argument) => typeof argument === "string")
          ? { commandArgs: marker.commandArgs }
          : {}),
      };
    } catch (error) {
      if (crash.child.exitCode !== null || crash.child.signalCode !== null)
        throw new Error(
          `Crash runner exited before its marker: ${(error as Error).message}\n${crash.diagnostics()}`,
        );
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting for mutation marker ${markerPath}\n${crash.diagnostics()}`,
        );
      await new Promise<void>((done) => setTimeout(done, 20));
    }
  }
}

async function journalRecords(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function mutationLaunches(path: string): Promise<string[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line === "crash" || line === "resume");
}

describe.skipIf(process.platform === "win32")(
  "side-effect process recovery after a parent SIGKILL",
  () => {
    it.each(cases)(
      "settles the old $kind process tree and enforces its retry policy",
      async ({ kind, retries }) => {
        const { repository, root } = await createRepository();
        const created = await createRun("Implement a substantial side-effect recovery fixture", {
          cwd: repository,
        });
        const runId = created.contract.runId;
        if (kind === "git_commit")
          await writeFile(join(repository, "pending.txt"), "commit after crash recovery\n");
        const baseHead = await gitOutput(repository, "rev-parse", "HEAD");
        const actionId = actionIdFor(runId, kind);
        const markerPath = join(root, `${kind}.marker.json`);
        const resultPath = join(root, `${kind}.result.txt`);
        const launchLogPath = join(root, `${kind}.launches.txt`);
        const crash = spawnCrashRunner(
          repository,
          runId,
          kind,
          markerPath,
          resultPath,
          launchLogPath,
        );
        const cleanupPids = new Set<number>();

        try {
          const marker = await waitForMarker(markerPath, crash);
          cleanupPids.add(marker.childPid);
          cleanupPids.add(marker.descendantPid);
          cleanupPids.add(marker.transportPid);
          const parentPid = positivePid(crash.child.pid, "crash runner");
          const crashedStore = new RunStore(repository, runId);
          const beforeKillEvents = await crashedStore.loadEvents();
          const crashStart = beforeKillEvents.find(
            ({ type, data }) =>
              type === "side_effect.process.started" && data.actionId === actionId,
          );
          if (!crashStart) throw new Error(`Missing durable process start for ${kind}`);
          const definition = crashStart.data.definition as Record<string, unknown>;
          const ready = crashStart.data.ready as Record<string, unknown>;
          const crashExecutionId = definition.executionId;
          if (typeof crashExecutionId !== "string")
            throw new Error(`Missing process execution ID for ${kind}`);
          const brokerPid = positivePid(ready.brokerPid, "process start event");
          cleanupPids.add(brokerPid);
          const journalRelativePath = crashStart.data.journalPath;
          if (typeof journalRelativePath !== "string")
            throw new Error(`Missing process journal path for ${kind}`);
          const journalPath = join(crashedStore.graphcraftRoot, journalRelativePath);
          const dispatched = beforeKillEvents.find(
            ({ type, data }) => type === "side_effect.dispatched" && data.actionId === actionId,
          );
          const beforeKillState = await crashedStore.loadState();
          const entry = beforeKillState.sideEffects.find(
            ({ claim }) => claim.actionId === actionId,
          );
          const startedRecord = (await journalRecords(journalPath)).findLast(
            ({ status }) => status === "started",
          );
          const targetPid = positivePid(startedRecord?.childPid, "process journal");
          cleanupPids.add(targetPid);

          expect(dispatched).toBeDefined();
          expect(dispatched!.sequence).toBeLessThan(crashStart.sequence);
          expect(entry?.dispatchedAt).toEqual(expect.any(String));
          expect(startedRecord).toMatchObject({
            executionId: crashExecutionId,
            brokerPid,
            childPid: targetPid,
            status: "started",
          });
          if (kind !== "git_commit") expect(targetPid).toBe(marker.childPid);
          expect(
            beforeKillEvents.filter(
              ({ type, data }) =>
                type === "side_effect.process.finished" && data.executionId === crashExecutionId,
            ),
          ).toHaveLength(0);
          expect(isProcessAlive(parentPid)).toBe(true);
          expect(isProcessAlive(brokerPid)).toBe(true);
          expect(isProcessAlive(targetPid)).toBe(true);
          expect(isProcessAlive(marker.childPid)).toBe(true);
          expect(isProcessAlive(marker.transportPid)).toBe(true);
          expect(isProcessAlive(marker.descendantPid)).toBe(true);
          if (kind === "github_pr_create")
            expect(marker.commandArgs).toEqual([
              "pr",
              "create",
              "--repo",
              "fixture/graphcraft",
              "--head",
              "graphcraft/fixture",
              "--base",
              "main",
              "--title",
              "Graphcraft fixture",
              "--body",
              `<!-- graphcraft-${runId}-${kind} -->`,
            ]);
          if (kind === "github_check_rerun")
            expect(marker.commandArgs).toEqual([
              "api",
              "repos/fixture/graphcraft/check-runs/701/rerequest",
              "--hostname",
              "github.example.test",
              "--method",
              "POST",
            ]);

          expect(crash.child.kill("SIGKILL")).toBe(true);
          await expect(crash.closed).resolves.toEqual({ code: null, signal: "SIGKILL" });
          await Promise.all(
            [
              ...new Set([
                brokerPid,
                targetPid,
                marker.childPid,
                marker.transportPid,
                marker.descendantPid,
              ]),
            ].map((pid) => waitForProcessExit(pid)),
          );
          cleanupPids.clear();

          const settledRecord = (await journalRecords(journalPath)).findLast(
            ({ status }) => status === "settled",
          );
          expect(settledRecord).toMatchObject({
            executionId: crashExecutionId,
            brokerPid,
            childPid: targetPid,
            status: "settled",
            outcome: "terminated",
            confirmed: true,
          });

          const staleUnconfirmedFailure =
            kind === "github_pr_create"
              ? await crashedStore.append(
                  "runtime",
                  "side_effect.failed",
                  {
                    actionId,
                    reason: "simulated stale unconfirmed settlement before journal recovery",
                    retryable: false,
                    uncertain: true,
                    childSettlement: "unconfirmed",
                  },
                  actionId,
                )
              : undefined;
          if (staleUnconfirmedFailure) {
            const staleEntry = (await crashedStore.loadState()).sideEffects.find(
              ({ claim }) => claim.actionId === actionId,
            );
            expect(staleEntry).toMatchObject({
              status: "uncertain",
              retryable: false,
              childSettlement: "unconfirmed",
            });
          }

          const firstResume = await runResume(
            repository,
            runId,
            kind,
            markerPath,
            resultPath,
            launchLogPath,
          );
          expect(firstResume.ok).toBe(retries);
          if (!retries)
            expect(firstResume.stderr).toMatch(
              /not yet observable; refusing a possibly duplicate retry/i,
            );

          const recoveredEvents = await crashedStore.loadEvents();
          const processStarts = recoveredEvents.filter(
            ({ type, data }) =>
              type === "side_effect.process.started" && data.actionId === actionId,
          );
          const oldReconciliations = recoveredEvents.filter(
            ({ type, data }) =>
              type === "side_effect.process.reconciled" &&
              data.actionId === actionId &&
              data.executionId === crashExecutionId,
          );
          expect(oldReconciliations).toHaveLength(1);
          expect(oldReconciliations[0]!.sequence).toBeGreaterThan(crashStart.sequence);
          if (staleUnconfirmedFailure)
            expect(oldReconciliations[0]!.sequence).toBeGreaterThan(
              staleUnconfirmedFailure.sequence,
            );
          expect(oldReconciliations[0]!.data).toMatchObject({
            started: true,
            settlement: {
              executionId: crashExecutionId,
              brokerPid,
              childPid: targetPid,
              outcome: "terminated",
              confirmed: true,
            },
          });

          if (retries) {
            expect(processStarts).toHaveLength(2);
            const retryStart = processStarts[1]!;
            expect(oldReconciliations[0]!.sequence).toBeLessThan(retryStart.sequence);
            const retryExecutionId = (retryStart.data.definition as Record<string, unknown>)
              .executionId;
            expect(retryExecutionId).toEqual(expect.any(String));
            expect(retryExecutionId).not.toBe(crashExecutionId);
            expect(
              recoveredEvents.filter(
                ({ type, data }) =>
                  type === "side_effect.process.finished" && data.executionId === retryExecutionId,
              ),
            ).toEqual([
              expect.objectContaining({
                data: expect.objectContaining({
                  started: true,
                  settlement: expect.objectContaining({ outcome: "exited", confirmed: true }),
                }),
              }),
            ]);
            await expect(readFile(resultPath, "utf8")).resolves.toBe("applied\n");
            expect(await mutationLaunches(launchLogPath)).toEqual(["crash", "resume"]);
            const confirmedEntry = (await crashedStore.loadState()).sideEffects.find(
              ({ claim }) => claim.actionId === actionId,
            );
            expect(confirmedEntry).toMatchObject({ status: "confirmed" });
            expect(confirmedEntry?.childSettlement).toBeUndefined();
            if (kind === "git_commit") {
              const committedHead = await gitOutput(repository, "rev-parse", "HEAD");
              expect(committedHead).not.toBe(baseHead);
              await expect(
                execFileAsync("git", ["show", "HEAD:pending.txt"], { cwd: repository }),
              ).resolves.toMatchObject({ stdout: "commit after crash recovery\n" });
              expect(await gitOutput(repository, "log", "-1", "--format=%B")).toContain(
                `Graphcraft-Action: graphcraft-${actionId}`,
              );
            }
          } else {
            expect(processStarts).toHaveLength(1);
            await expect(readFile(resultPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
            expect(await mutationLaunches(launchLogPath)).toEqual(["crash"]);
          }
          const headAfterFirstResume = await gitOutput(repository, "rev-parse", "HEAD");
          if (kind !== "git_commit") expect(headAfterFirstResume).toBe(baseHead);

          const secondResume = await runResume(
            repository,
            runId,
            kind,
            markerPath,
            resultPath,
            launchLogPath,
          );
          expect(secondResume.ok).toBe(retries);
          if (!retries)
            expect(secondResume.stderr).toMatch(
              /not yet observable; refusing a possibly duplicate retry/i,
            );
          const idempotentEvents = await crashedStore.loadEvents();
          expect(
            idempotentEvents.filter(
              ({ type, data }) =>
                type === "side_effect.process.started" && data.actionId === actionId,
            ),
          ).toHaveLength(retries ? 2 : 1);
          expect(
            idempotentEvents.filter(
              ({ type, data }) =>
                type === "side_effect.process.reconciled" &&
                data.actionId === actionId &&
                data.executionId === crashExecutionId,
            ),
          ).toHaveLength(1);
          expect(await mutationLaunches(launchLogPath)).toEqual(
            retries ? ["crash", "resume"] : ["crash"],
          );
          expect(await gitOutput(repository, "rev-parse", "HEAD")).toBe(headAfterFirstResume);
          if (retries) await expect(stat(resultPath)).resolves.toBeDefined();
          else await expect(stat(resultPath)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          if (crash.child.exitCode === null && crash.child.signalCode === null) {
            crash.child.kill("SIGKILL");
            await crash.closed;
          }
          await Promise.all([...cleanupPids].map((pid) => killProcessForCleanup(pid)));
        }
      },
      60_000,
    );

    it.each(journalFaultCases)(
      "refuses a retry when settled process evidence is $fault",
      async ({ fault, error: expectedError, childSettlement, reconciles }) => {
        const kind = "git_commit" as const;
        const { repository, root } = await createRepository();
        const created = await createRun("Implement a substantial journal recovery fixture", {
          cwd: repository,
        });
        const runId = created.contract.runId;
        await writeFile(join(repository, "pending.txt"), "must not commit without evidence\n");
        const baseHead = await gitOutput(repository, "rev-parse", "HEAD");
        const actionId = actionIdFor(runId, kind);
        const markerPath = join(root, `${fault}.marker.json`);
        const resultPath = join(root, `${fault}.result.txt`);
        const launchLogPath = join(root, `${fault}.launches.txt`);
        const crash = spawnCrashRunner(
          repository,
          runId,
          kind,
          markerPath,
          resultPath,
          launchLogPath,
        );
        const cleanupPids = new Set<number>();

        try {
          const marker = await waitForMarker(markerPath, crash);
          cleanupPids.add(marker.childPid);
          cleanupPids.add(marker.descendantPid);
          cleanupPids.add(marker.transportPid);
          const store = new RunStore(repository, runId);
          const beforeKillEvents = await store.loadEvents();
          const crashStart = beforeKillEvents.find(
            ({ type, data }) =>
              type === "side_effect.process.started" && data.actionId === actionId,
          );
          if (!crashStart) throw new Error(`Missing durable process start for ${fault} fixture`);
          const crashExecutionId = (crashStart.data.definition as Record<string, unknown>)
            .executionId;
          if (typeof crashExecutionId !== "string")
            throw new Error(`Missing execution ID for ${fault} fixture`);
          const brokerPid = positivePid(
            (crashStart.data.ready as Record<string, unknown>).brokerPid,
            `${fault} process start event`,
          );
          cleanupPids.add(brokerPid);
          const journalRelativePath = crashStart.data.journalPath;
          if (typeof journalRelativePath !== "string")
            throw new Error(`Missing process journal path for ${fault} fixture`);
          const journalPath = join(store.graphcraftRoot, journalRelativePath);
          const startedRecord = (await journalRecords(journalPath)).findLast(
            ({ status }) => status === "started",
          );
          const targetPid = positivePid(startedRecord?.childPid, `${fault} process journal`);
          cleanupPids.add(targetPid);

          expect(crash.child.kill("SIGKILL")).toBe(true);
          await expect(crash.closed).resolves.toEqual({ code: null, signal: "SIGKILL" });
          await Promise.all(
            [
              ...new Set([
                brokerPid,
                targetPid,
                marker.childPid,
                marker.transportPid,
                marker.descendantPid,
              ]),
            ].map((pid) => waitForProcessExit(pid)),
          );
          cleanupPids.clear();
          expect(
            (await journalRecords(journalPath)).findLast(({ status }) => status === "settled"),
          ).toMatchObject({
            executionId: crashExecutionId,
            brokerPid,
            childPid: targetPid,
            status: "settled",
            outcome: "terminated",
            confirmed: true,
          });

          if (fault === "missing") await rm(journalPath);
          if (fault === "malformed") await writeFile(journalPath, "{malformed\n");
          const firstResume = await runResume(
            repository,
            runId,
            kind,
            markerPath,
            resultPath,
            launchLogPath,
            fault === "unremovable" ? "replace_journal_after_reconcile" : "none",
          );
          expect(firstResume.ok).toBe(false);
          expect(firstResume.stderr).toMatch(expectedError);

          const recoveredEvents = await store.loadEvents();
          const starts = recoveredEvents.filter(
            ({ type, data }) =>
              type === "side_effect.process.started" && data.actionId === actionId,
          );
          const processReconciliations = recoveredEvents.filter(
            ({ type, data }) =>
              type === "side_effect.process.reconciled" &&
              data.actionId === actionId &&
              data.executionId === crashExecutionId,
          );
          const failures = recoveredEvents.filter(
            ({ type, data }) => type === "side_effect.failed" && data.actionId === actionId,
          );
          expect(starts).toHaveLength(1);
          expect(processReconciliations).toHaveLength(reconciles ? 1 : 0);
          expect(failures).toHaveLength(1);
          expect(failures[0]!.data).toMatchObject({
            retryable: childSettlement === "confirmed",
            uncertain: childSettlement === "unconfirmed",
            childSettlement,
          });
          if (reconciles) {
            expect(processReconciliations[0]!.data).toMatchObject({
              started: true,
              settlement: {
                executionId: crashExecutionId,
                brokerPid,
                childPid: targetPid,
                outcome: "terminated",
                confirmed: true,
              },
            });
            expect(processReconciliations[0]!.sequence).toBeLessThan(failures[0]!.sequence);
            expect((await stat(journalPath)).isDirectory()).toBe(true);
          } else if (fault === "missing") {
            await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            await expect(readFile(journalPath, "utf8")).resolves.toBe("{malformed\n");
          }
          expect(await mutationLaunches(launchLogPath)).toEqual(["crash"]);
          expect(await gitOutput(repository, "rev-parse", "HEAD")).toBe(baseHead);
          await expect(stat(resultPath)).rejects.toMatchObject({ code: "ENOENT" });

          const secondResume = await runResume(
            repository,
            runId,
            kind,
            markerPath,
            resultPath,
            launchLogPath,
          );
          expect(secondResume.ok).toBe(false);
          const idempotentEvents = await store.loadEvents();
          expect(
            idempotentEvents.filter(
              ({ type, data }) =>
                type === "side_effect.process.started" && data.actionId === actionId,
            ),
          ).toHaveLength(1);
          expect(await mutationLaunches(launchLogPath)).toEqual(["crash"]);
          expect(await gitOutput(repository, "rev-parse", "HEAD")).toBe(baseHead);
          await expect(stat(resultPath)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          if (crash.child.exitCode === null && crash.child.signalCode === null) {
            crash.child.kill("SIGKILL");
            await crash.closed;
          }
          await Promise.all([...cleanupPids].map((pid) => killProcessForCleanup(pid)));
        }
      },
      60_000,
    );
  },
);
