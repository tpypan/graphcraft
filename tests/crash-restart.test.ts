import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { configureRunProbes, createRun, RunStore } from "../packages/runtime/src/index.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const tsxLoader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
const runnerPath = resolve("tests/fixtures/crash-restart-runner.ts");

type HostId = "codex" | "claude";
type FaultBoundary =
  "session" | "usage" | "result" | "probe_scope" | "probe_scope_forged" | "probe_cleanup";
type ProbeScopeStage = "progress_baseline" | "progress_current" | "verification";

interface ProbeScopeMarker {
  boundary: "probe_scope";
  brokerPid: number;
  descendantPid: number;
  mutated: boolean;
  probePid: number;
  stage: ProbeScopeStage;
  startedAt: string;
}

interface ProbeLaunch {
  brokerPid: number;
  probePid: number;
  stage: ProbeScopeStage;
  startedAt: string;
  target: boolean;
}

const probeScopeProbe = `
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const markerPath = process.argv[1];
const mutated = process.argv[2] === "mutate";
const stage = process.argv[3];
const attemptPath = markerPath + ".attempt";
const target = stage !== "progress_current" || existsSync(attemptPath);
const startedAt = new Date().toISOString();
appendFileSync(markerPath + ".launches.jsonl", JSON.stringify({
  brokerPid: process.ppid,
  probePid: process.pid,
  stage,
  startedAt,
  target,
}) + "\\n");
if (existsSync(markerPath)) process.exit(0);
if (!target) {
  writeFileSync(attemptPath, "progress_baseline completed\\n");
  process.exit(0);
}
if (mutated) writeFileSync(join(process.cwd(), "feature.txt"), "probe mutation before crash\\n");
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
writeFileSync(markerPath, JSON.stringify({
  boundary: "probe_scope",
  brokerPid: process.ppid,
  descendantPid: descendant.pid,
  mutated,
  probePid: process.pid,
  stage,
  startedAt,
}) + "\\n");
process.on("SIGTERM", () => {});
setInterval(() => {
  process.stdout.write("probe stdout after runtime loss\\n");
  process.stderr.write("probe stderr after runtime loss\\n");
}, 10);
`;

interface RunnerRequest {
  host: HostId;
  mode: "crash" | "resume";
  pid: number;
  nodeId: string;
  invocationId: string;
  resumeSessionId: string | null;
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

async function createRepository(): Promise<{ repository: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft cold restart "));
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
      name: "cold-restart-fixture",
      private: true,
      scripts: { test: "node verify.mjs" },
    })}\n`,
  );
  await writeFile(
    join(repository, "verify.mjs"),
    'import { readFile } from "node:fs/promises";\nconst value = await readFile(new URL("./feature.txt", import.meta.url), "utf8");\nif (value !== "completed after cold restart\\n") throw new Error(`unexpected feature: ${JSON.stringify(value)}`);\n',
  );
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "fixture");
  return { repository, root };
}

function runnerArguments(
  repository: string,
  host: HostId,
  mode: "crash" | "resume",
  boundary: FaultBoundary,
  markerPath: string,
  requestLogPath: string,
  forgedBrokerPid?: number,
): string[] {
  return [
    "--import",
    tsxLoader,
    runnerPath,
    repository,
    host,
    mode,
    boundary,
    markerPath,
    requestLogPath,
    forgedBrokerPid === undefined ? "" : String(forgedBrokerPid),
  ];
}

function spawnCrashRunner(
  repository: string,
  host: HostId,
  boundary: FaultBoundary,
  markerPath: string,
  requestLogPath: string,
  forgedBrokerPid?: number,
): {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  diagnostics: () => string;
} {
  const child = spawn(
    process.execPath,
    runnerArguments(
      repository,
      host,
      "crash",
      boundary,
      markerPath,
      requestLogPath,
      forgedBrokerPid,
    ),
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

async function waitForMarker(
  markerPath: string,
  child: ChildProcess,
  diagnostics: () => string,
  timeoutMs = 15_000,
): Promise<{ boundary: FaultBoundary; invocationId: string; pid: number }> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return JSON.parse(await readFile(markerPath, "utf8")) as {
        boundary: FaultBoundary;
        invocationId: string;
        pid: number;
      };
    } catch (error) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Crash runner exited before its marker: ${(error as Error).message}\n${diagnostics()}`,
        );
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for crash marker ${markerPath}\n${diagnostics()}`);
      await new Promise<void>((done) => setTimeout(done, 20));
    }
  }
}

async function waitForProbeScopeMarker(
  markerPath: string,
  child: ChildProcess,
  diagnostics: () => string,
  timeoutMs = 15_000,
): Promise<ProbeScopeMarker> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return JSON.parse(await readFile(markerPath, "utf8")) as ProbeScopeMarker;
    } catch (error) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Crash runner exited before its scope marker: ${(error as Error).message}\n${diagnostics()}`,
        );
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for scope marker ${markerPath}\n${diagnostics()}`);
      await new Promise<void>((done) => setTimeout(done, 20));
    }
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

async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
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

async function probeLaunches(markerPath: string): Promise<ProbeLaunch[]> {
  return (await readFile(`${markerPath}.launches.jsonl`, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProbeLaunch);
}

async function probeJournalDiagnostic(path: string): Promise<unknown> {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          return {
            line: index + 1,
            status: record.status,
            brokerPid: record.brokerPid,
            childPid: record.childPid,
            outcome: record.outcome,
            confirmed: record.confirmed,
            settledAt: record.settledAt,
          };
        } catch {
          return { line: index + 1, status: "invalid_json" };
        }
      });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: code === "ENOENT" ? "removed" : "unreadable", code: code ?? "unknown" };
  }
}

async function configureProbeScopeCrash(
  created: Awaited<ReturnType<typeof createRun>>,
  markerPath: string,
  mutate: boolean,
  stage: ProbeScopeStage,
): Promise<void> {
  const target =
    stage === "verification"
      ? created.probePlan.items.find(({ phase }) => phase === "completion")
      : created.probePlan.items.find(
          ({ phase, purpose }) => phase === "progress" && purpose === "focused",
        );
  if (!target) throw new Error(`Missing ${stage} probe fixture`);
  await configureRunProbes(created.store, {
    ...created.probePlan,
    items: created.probePlan.items.map((item) =>
      item === target
        ? {
            ...item,
            source: `Crash-restart ${stage} scope checkpoint fixture`,
            probe: {
              id: `crash-after-${stage}-scope-start`,
              kind: "command" as const,
              command: process.execPath,
              args: ["-e", probeScopeProbe, markerPath, mutate ? "mutate" : "observe", stage],
              expectedExitCode: 0,
              timeoutMs: 30_000,
              platforms: [process.platform] as Array<"darwin" | "linux" | "win32">,
            },
          }
        : item,
    ),
  });
}

async function configureProbeCleanupCrash(
  created: Awaited<ReturnType<typeof createRun>>,
): Promise<void> {
  const target = created.probePlan.items.find(
    ({ phase, purpose }) => phase === "progress" && purpose === "focused",
  );
  if (!target) throw new Error("Missing progress probe cleanup fixture");
  await configureRunProbes(created.store, {
    ...created.probePlan,
    items: created.probePlan.items.map((item) =>
      item === target
        ? {
            ...item,
            source: "Crash-restart probe journal cleanup fixture",
            probe: {
              id: "crash-after-probe-process-finished",
              kind: "command" as const,
              command: process.execPath,
              args: ["-e", "process.exit(0)"],
              expectedExitCode: 0,
              timeoutMs: 10_000,
              platforms: [process.platform] as Array<"darwin" | "linux" | "win32">,
            },
          }
        : item,
    ),
  });
}

async function runResume(
  repository: string,
  host: HostId,
  boundary: FaultBoundary,
  markerPath: string,
  requestLogPath: string,
  forgedBrokerPid?: number,
): Promise<void> {
  await execFileAsync(
    process.execPath,
    runnerArguments(
      repository,
      host,
      "resume",
      boundary,
      markerPath,
      requestLogPath,
      forgedBrokerPid,
    ),
    { cwd: process.cwd(), timeout: 30_000 },
  );
}

async function requestLog(path: string): Promise<RunnerRequest[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunnerRequest);
}

const cases = (["codex", "claude"] as const).flatMap((host) =>
  (["session", "usage", "result"] as const).map((boundary) => ({ host, boundary })),
);

describe("cold runtime restart fault recovery", () => {
  it.each(cases)(
    "recovers $host after SIGKILL at the artifact-only $boundary boundary",
    async ({ host, boundary }) => {
      const { repository, root } = await createRepository();
      const created = await createRun("Implement a substantial cold-restart feature", {
        cwd: repository,
      });
      await created.store.append("user", "run.approved", { approved: true });
      const markerPath = join(root, `${host}-${boundary}.marker.json`);
      const requestLogPath = join(root, `${host}-${boundary}.requests.jsonl`);
      const lockPath = join(
        created.store.graphcraftRoot,
        "locks",
        `${created.contract.runId}.lock`,
      );
      const crash = spawnCrashRunner(repository, host, boundary, markerPath, requestLogPath);

      try {
        const marker = await waitForMarker(markerPath, crash.child, crash.diagnostics);
        expect(marker.boundary).toBe(boundary);
        expect(marker.pid).toBe(crash.child.pid);
        await expect(stat(lockPath)).resolves.toBeDefined();

        const crashedStore = new RunStore(repository, created.contract.runId);
        const crashState = await crashedStore.loadState();
        const crashEvents = await crashedStore.loadEvents();
        const crashTranscript = await crashedStore.loadInvocationEvents(marker.invocationId);
        expect(crashState.nodes.implement?.status).toBe("running");
        expect(
          crashEvents.filter(
            ({ type, data }) =>
              type === "invocation.finished" && data.invocationId === marker.invocationId,
          ),
        ).toHaveLength(0);
        expect(crashTranscript.some(({ type }) => type === boundary)).toBe(true);

        expect(crash.child.kill("SIGKILL")).toBe(true);
        const exit = await crash.closed;
        expect(exit.signal !== null || exit.code !== 0).toBe(true);

        await runResume(repository, host, boundary, markerPath, requestLogPath);
        const recoveredStore = new RunStore(repository, created.contract.runId);
        const recovered = await recoveredStore.loadState();
        const events = await recoveredStore.loadEvents();
        const transcript = await recoveredStore.loadInvocationEvents(marker.invocationId);
        const requests = await requestLog(requestLogPath);
        const implementationStarts = events.filter(
          ({ type, data }) => type === "invocation.started" && data.nodeId === "implement",
        );
        const invocationTokens = events.filter(
          ({ type, causationId }) =>
            type === "tokens.recorded" && causationId === marker.invocationId,
        );
        const recoveredTokens = invocationTokens.filter(({ data }) => data.recovered === true);
        const acceptedCounts = new Map<string, number>();
        for (const { type, data } of events) {
          if (type !== "node.accepted") continue;
          const nodeId = String(data.nodeId);
          acceptedCounts.set(nodeId, (acceptedCounts.get(nodeId) ?? 0) + 1);
        }

        expect(recovered.status).toBe("completed");
        expect(implementationStarts).toHaveLength(1);
        expect(implementationStarts[0]?.data.invocationId).toBe(marker.invocationId);
        expect([...acceptedCounts.values()].every((count) => count === 1)).toBe(true);
        expect(acceptedCounts.get("implement")).toBe(1);
        expect(invocationTokens.every(({ data }) => data.missing !== true)).toBe(true);
        expect(transcript.filter(({ type }) => type === "result")).toHaveLength(1);
        await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
        const workspace = await recoveredStore.loadWorkspace<{ path: string }>();
        await expect(readFile(join(workspace.path, "feature.txt"), "utf8")).resolves.toBe(
          "completed after cold restart\n",
        );

        if (boundary === "result") {
          expect(requests).toHaveLength(1);
          expect(events.filter(({ type }) => type === "invocation.resumed")).toHaveLength(0);
          expect(invocationTokens).toHaveLength(1);
          expect(recoveredTokens).toHaveLength(0);
        } else {
          expect(requests).toHaveLength(2);
          expect(requests[1]).toMatchObject({
            host,
            mode: "resume",
            invocationId: marker.invocationId,
            resumeSessionId: `${host}-cold-restart-${marker.invocationId}`,
          });
          expect(
            events.filter(
              ({ type, data }) =>
                type === "invocation.resumed" && data.invocationId === marker.invocationId,
            ),
          ).toHaveLength(1);
          expect(invocationTokens).toHaveLength(boundary === "usage" ? 2 : 1);
          expect(recoveredTokens).toHaveLength(boundary === "usage" ? 1 : 0);
        }

        const requestsBeforeIdempotentResume = requests.length;
        const tokensBeforeIdempotentResume = invocationTokens.length;
        await runResume(repository, host, boundary, markerPath, requestLogPath);
        expect(await requestLog(requestLogPath)).toHaveLength(requestsBeforeIdempotentResume);
        expect(
          (await recoveredStore.loadEvents()).filter(
            ({ type, causationId }) =>
              type === "tokens.recorded" && causationId === marker.invocationId,
          ),
        ).toHaveLength(tokensBeforeIdempotentResume);
      } finally {
        if (crash.child.exitCode === null && crash.child.signalCode === null) {
          crash.child.kill("SIGKILL");
          await crash.closed;
        }
      }
    },
    45_000,
  );

  const probeScopeCases = (
    ["progress_baseline", "progress_current", "verification"] as const
  ).flatMap((stage) => [
    { mutate: false, label: "unchanged", stage },
    { mutate: true, label: "changed", stage },
  ]);

  it.each(probeScopeCases)(
    "reconciles an unresolved $stage scope checkpoint when the workspace is $label",
    async ({ mutate, stage }) => {
      const { repository, root } = await createRepository();
      const nodeId = stage === "verification" ? "verify" : "implement";
      const created = await createRun("Implement a substantial scope-recovery feature", {
        cwd: repository,
      });
      const markerPath = join(root, `${stage}-${mutate ? "changed" : "unchanged"}.json`);
      const requestLogPath = join(
        root,
        `${stage}-${mutate ? "changed" : "unchanged"}.requests.jsonl`,
      );
      await configureProbeScopeCrash(created, markerPath, mutate, stage);
      await created.store.append("user", "run.approved", { approved: true });
      const crash = spawnCrashRunner(
        repository,
        "codex",
        "probe_scope",
        markerPath,
        requestLogPath,
      );
      const cleanupPids = new Set<number>();

      try {
        const marker = await waitForProbeScopeMarker(markerPath, crash.child, crash.diagnostics);
        cleanupPids.add(marker.probePid);
        cleanupPids.add(marker.descendantPid);
        cleanupPids.add(marker.brokerPid);
        expect(marker).toMatchObject({
          boundary: "probe_scope",
          mutated: mutate,
          stage,
        });
        expect(marker.brokerPid).not.toBe(crash.child.pid);
        expect(
          [marker.brokerPid, marker.probePid, marker.descendantPid].every(isProcessAlive),
        ).toBe(true);

        const crashedStore = new RunStore(repository, created.contract.runId);
        const beforeRestart = await crashedStore.loadEvents();
        const scopeStart = beforeRestart.findLast(
          ({ type, data }) =>
            type === "scope.started" && data.nodeId === nodeId && data.stage === stage,
        );
        expect(scopeStart).toBeDefined();
        expect(
          beforeRestart.some(
            ({ type, data }) =>
              type === "scope.checked" && data.checkpointId === scopeStart?.data.checkpointId,
          ),
        ).toBe(false);
        const invocationsBeforeRestart = beforeRestart.filter(
          ({ type, data }) => type === "invocation.started" && data.nodeId === "implement",
        );
        expect(invocationsBeforeRestart).toHaveLength(stage === "progress_baseline" ? 0 : 1);
        const processStart = beforeRestart.findLast(
          ({ type, data }) =>
            type === "probe.process.started" &&
            data.nodeId === nodeId &&
            data.stage === stage &&
            data.checkpointId === scopeStart?.data.checkpointId,
        );
        expect(processStart).toMatchObject({
          actor: "probe",
          causationId: scopeStart?.data.checkpointId,
          data: {
            ready: { brokerPid: marker.brokerPid },
          },
        });
        const executionId = (processStart?.data.definition as { executionId?: string })
          ?.executionId;
        expect(executionId).toEqual(expect.any(String));
        const journalPath = join(
          crashedStore.graphcraftRoot,
          String(processStart?.data.journalPath),
        );
        await expect(stat(journalPath)).resolves.toBeDefined();

        expect(crash.child.kill("SIGKILL")).toBe(true);
        const exit = await crash.closed;
        expect(exit.signal !== null || exit.code !== 0).toBe(true);
        const resumed = runResume(repository, "codex", "probe_scope", markerPath, requestLogPath);
        await Promise.all(
          [marker.probePid, marker.descendantPid, marker.brokerPid].map((pid) =>
            waitForProcessExit(pid),
          ),
        );
        cleanupPids.clear();
        await resumed;
        const recoveredStore = new RunStore(repository, created.contract.runId);
        const recovered = await recoveredStore.loadState();
        const events = await recoveredStore.loadEvents();
        const terminalProcessEvents = events.filter(
          ({ type, data }) =>
            ["probe.process.finished", "probe.process.reconciled"].includes(type) &&
            data.executionId === executionId,
        );
        const recoveryDiagnostic = JSON.stringify(
          {
            recovered: {
              status: recovered.status,
              stopReason: recovered.stopReason,
              node: recovered.nodes[nodeId],
            },
            terminalProcessEvents: terminalProcessEvents.map(
              ({ sequence, actor, type, causationId, data }) => ({
                sequence,
                actor,
                type,
                causationId,
                checkpointId: data.checkpointId,
                executionId: data.executionId,
                settlement: data.settlement,
              }),
            ),
            journal: await probeJournalDiagnostic(journalPath),
            recentEventTypes: events.slice(-12).map(({ sequence, type }) => ({ sequence, type })),
          },
          null,
          2,
        );
        const reconciliation = events.find(
          ({ type, data }) =>
            type === "probe.process.reconciled" && data.executionId === executionId,
        );
        expect(
          reconciliation,
          `Missing durable probe-process reconciliation:\n${recoveryDiagnostic}`,
        ).toMatchObject({
          actor: "runtime",
          causationId: executionId,
          data: {
            nodeId,
            stage,
            checkpointId: scopeStart?.data.checkpointId,
            started: true,
            settlement: {
              outcome: "terminated",
              confirmed: true,
              brokerPid: marker.brokerPid,
              childPid: marker.probePid,
            },
          },
        });
        const recoveredScopeCheck = events.find(
          ({ sequence, causationId, type, data }) =>
            sequence > scopeStart!.sequence &&
            type === "scope.checked" &&
            causationId === scopeStart?.data.checkpointId &&
            data.checkpointId === scopeStart?.data.checkpointId &&
            data.nodeId === nodeId &&
            data.stage === stage,
        );
        expect(recoveredScopeCheck?.data).toMatchObject({
          nodeId,
          stage,
          recovered: true,
        });
        expect(recoveredScopeCheck?.data.audit).toMatchObject({ allowed: !mutate });
        const launches = await probeLaunches(markerPath);
        const interruptedLaunchIndex = launches.findIndex(
          ({ probePid }) => probePid === marker.probePid,
        );
        expect(interruptedLaunchIndex).toBeGreaterThanOrEqual(0);
        const laterLaunches = launches.slice(interruptedLaunchIndex + 1);
        const settledAt = String(
          (reconciliation?.data.settlement as { settledAt?: unknown })?.settledAt,
        );
        if (mutate) expect(laterLaunches).toHaveLength(0);
        else {
          expect(laterLaunches.length).toBeGreaterThan(0);
          expect(
            laterLaunches.every(({ startedAt }) => Date.parse(startedAt) >= Date.parse(settledAt)),
          ).toBe(true);
          expect(
            events
              .filter(
                ({ sequence, type, data }) =>
                  type === "probe.process.started" &&
                  sequence > scopeStart!.sequence &&
                  data.checkpointId !== scopeStart?.data.checkpointId,
              )
              .every(
                ({ sequence }) => sequence > (reconciliation?.sequence ?? Number.MAX_SAFE_INTEGER),
              ),
          ).toBe(true);
        }
        await expect(
          stat(
            join(recoveredStore.graphcraftRoot, "locks", "probe-processes", created.contract.runId),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });

        const workspace = await recoveredStore.loadWorkspace<{ path: string }>();
        if (mutate) {
          expect(recovered.status).toBe("blocked");
          expect(recovered.nodes[nodeId]?.status).toBe("failed");
          await expect(readFile(join(workspace.path, "feature.txt"), "utf8")).resolves.toBe(
            "probe mutation before crash\n",
          );
          expect(
            events.filter(
              ({ type, data }) => type === "invocation.started" && data.nodeId === "implement",
            ),
          ).toEqual(invocationsBeforeRestart);
          const checkpointFailures = events.filter(
            ({ sequence, type, data }) =>
              sequence > scopeStart!.sequence &&
              type === "node.failed" &&
              data.nodeId === nodeId &&
              data.scopeCheckpointId === scopeStart?.data.checkpointId,
          );
          expect(checkpointFailures).toHaveLength(1);
          const failure = checkpointFailures[0]!;
          expect(failure?.data).toMatchObject({
            progressProbeStage: stage,
            scopeCheckpointId: scopeStart?.data.checkpointId,
          });
          expect(failure?.data.reason).toMatch(
            stage === "verification"
              ? /completion probe execution changed repository state/i
              : /progress probe execution changed repository state/i,
          );
          expect(failure?.data.runBlocker).toMatchObject({
            reason: failure?.data.reason,
            progressProbeStage: stage,
            scopeCheckpointId: scopeStart?.data.checkpointId,
          });
          const checkpointBlocks = events.filter(
            ({ sequence, type, data }) =>
              sequence > scopeStart!.sequence &&
              type === "run.blocked" &&
              data.scopeCheckpointId === scopeStart?.data.checkpointId,
          );
          expect(checkpointBlocks).toHaveLength(1);
          expect(checkpointBlocks[0]?.data).toMatchObject({
            reason: failure?.data.reason,
            progressProbeStage: stage,
            scopeCheckpointId: scopeStart?.data.checkpointId,
          });

          await runResume(repository, "codex", "probe_scope", markerPath, requestLogPath);
          const idempotentState = await recoveredStore.loadState();
          const idempotentEvents = await recoveredStore.loadEvents();
          expect(idempotentState.status).toBe("blocked");
          expect(
            idempotentEvents.filter(
              ({ type, data }) =>
                type === "node.failed" &&
                data.nodeId === nodeId &&
                data.scopeCheckpointId === scopeStart?.data.checkpointId,
            ),
          ).toHaveLength(1);
          expect(
            idempotentEvents.filter(
              ({ type, data }) =>
                type === "run.blocked" && data.scopeCheckpointId === scopeStart?.data.checkpointId,
            ),
          ).toHaveLength(1);
          expect(
            idempotentEvents.filter(
              ({ type, data }) => type === "invocation.started" && data.nodeId === "implement",
            ),
          ).toEqual(invocationsBeforeRestart);
          await expect(readFile(join(workspace.path, "feature.txt"), "utf8")).resolves.toBe(
            "probe mutation before crash\n",
          );
        } else {
          expect(recovered.status).toBe("completed");
          expect(recovered.nodes[nodeId]?.status).toBe("accepted");
          expect(
            events.filter(
              ({ type, data }) => type === "invocation.started" && data.nodeId === "implement",
            ),
          ).toHaveLength(1);
          await expect(readFile(join(workspace.path, "feature.txt"), "utf8")).resolves.toBe(
            "completed after cold restart\n",
          );
          expect(
            events.filter(({ type, data }) => type === "node.accepted" && data.nodeId === nodeId),
          ).toHaveLength(1);
          expect(events.filter(({ type }) => type === "run.completed")).toHaveLength(1);
          if (stage === "verification")
            expect(
              events.filter(
                ({ type, data }) => type === "held_out.checked" && data.nodeId === "verify",
              ),
            ).toHaveLength(1);

          const launchesBeforeIdempotentResume = launches.length;
          await runResume(repository, "codex", "probe_scope", markerPath, requestLogPath);
          expect(await probeLaunches(markerPath)).toHaveLength(launchesBeforeIdempotentResume);
          const idempotentEvents = await recoveredStore.loadEvents();
          expect(
            idempotentEvents.filter(
              ({ type, data }) => type === "node.accepted" && data.nodeId === nodeId,
            ),
          ).toHaveLength(1);
          expect(idempotentEvents.filter(({ type }) => type === "run.completed")).toHaveLength(1);
          if (stage === "verification")
            expect(
              idempotentEvents.filter(
                ({ type, data }) => type === "held_out.checked" && data.nodeId === "verify",
              ),
            ).toHaveLength(1);
        }
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

  it("settles an owned probe tree before blocking on a missing workspace record", async () => {
    const { repository, root } = await createRepository();
    const created = await createRun("Implement durable missing-workspace probe recovery", {
      cwd: repository,
    });
    const markerPath = join(root, "missing-workspace-probe-scope.json");
    const requestLogPath = join(root, "missing-workspace-probe-scope.requests.jsonl");
    await configureProbeScopeCrash(created, markerPath, false, "progress_baseline");
    await created.store.append("user", "run.approved", { approved: true });
    const crash = spawnCrashRunner(repository, "codex", "probe_scope", markerPath, requestLogPath);
    const cleanupPids = new Set<number>();

    try {
      const marker = await waitForProbeScopeMarker(markerPath, crash.child, crash.diagnostics);
      cleanupPids.add(marker.probePid);
      cleanupPids.add(marker.descendantPid);
      cleanupPids.add(marker.brokerPid);
      expect([marker.brokerPid, marker.probePid, marker.descendantPid].every(isProcessAlive)).toBe(
        true,
      );
      const beforeRestart = await created.store.loadEvents();
      const scopeStart = beforeRestart.findLast(
        ({ type, data }) =>
          type === "scope.started" &&
          data.nodeId === "implement" &&
          data.stage === "progress_baseline",
      );
      const processStart = beforeRestart.findLast(
        ({ type, data }) =>
          type === "probe.process.started" && data.checkpointId === scopeStart?.data.checkpointId,
      );
      const executionId = (processStart?.data.definition as { executionId?: string } | undefined)
        ?.executionId;
      expect(scopeStart).toBeDefined();
      expect(executionId).toEqual(expect.any(String));

      expect(crash.child.kill("SIGKILL")).toBe(true);
      await crash.closed;
      const workspaceRecordPath = join(created.store.runRoot, "workspace.json");
      await rm(workspaceRecordPath);
      const resumed = runResume(repository, "codex", "probe_scope", markerPath, requestLogPath);
      await Promise.all(
        [marker.probePid, marker.descendantPid, marker.brokerPid].map((pid) =>
          waitForProcessExit(pid),
        ),
      );
      cleanupPids.clear();
      await resumed;

      const recoveredStore = new RunStore(repository, created.contract.runId);
      const recovered = await recoveredStore.loadState();
      const events = await recoveredStore.loadEvents();
      const reconciliation = events.find(
        ({ type, data }) => type === "probe.process.reconciled" && data.executionId === executionId,
      );
      const blocker = events.findLast(
        ({ type, data }) =>
          type === "run.blocked" && data.scopeCheckpointId === scopeStart?.data.checkpointId,
      );
      expect(recovered.status).toBe("blocked");
      expect(recovered.stopReason).toMatch(
        /cannot recover progress-probe scope checkpoint.*workspace is unavailable or invalid/i,
      );
      expect(reconciliation?.data).toMatchObject({
        nodeId: "implement",
        stage: "progress_baseline",
        checkpointId: scopeStart?.data.checkpointId,
        started: true,
        settlement: {
          outcome: "terminated",
          confirmed: true,
          brokerPid: marker.brokerPid,
          childPid: marker.probePid,
        },
      });
      expect(reconciliation!.sequence).toBeLessThan(blocker!.sequence);
      expect(
        events.filter(
          ({ type, data }) =>
            type === "scope.checked" && data.checkpointId === scopeStart?.data.checkpointId,
        ),
      ).toHaveLength(0);
      expect(
        events.filter(
          ({ type, data }) => type === "invocation.started" && data.nodeId === "implement",
        ),
      ).toHaveLength(0);
      expect(await probeLaunches(markerPath)).toHaveLength(1);
      await expect(readFile(workspaceRecordPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const failureCount = events.filter(
        ({ type, data }) =>
          type === "node.failed" && data.scopeCheckpointId === scopeStart?.data.checkpointId,
      ).length;
      const blockerCount = events.filter(
        ({ type, data }) =>
          type === "run.blocked" && data.scopeCheckpointId === scopeStart?.data.checkpointId,
      ).length;
      await runResume(repository, "codex", "probe_scope", markerPath, requestLogPath);
      const idempotentEvents = await recoveredStore.loadEvents();
      expect(
        idempotentEvents.filter(
          ({ type, data }) =>
            type === "node.failed" && data.scopeCheckpointId === scopeStart?.data.checkpointId,
        ),
      ).toHaveLength(failureCount);
      expect(
        idempotentEvents.filter(
          ({ type, data }) =>
            type === "run.blocked" && data.scopeCheckpointId === scopeStart?.data.checkpointId,
        ),
      ).toHaveLength(blockerCount);
      expect(await probeLaunches(markerPath)).toHaveLength(1);
      await expect(readFile(workspaceRecordPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (crash.child.exitCode === null && crash.child.signalCode === null) {
        crash.child.kill("SIGKILL");
        await crash.closed;
      }
      await Promise.all([...cleanupPids].map((pid) => killProcessForCleanup(pid)));
    }
  }, 60_000);

  it.each(["forged", "missing"] as const)(
    "blocks on $fault probe ownership evidence without signaling an ambiguous PID",
    async (fault) => {
      const { repository, root } = await createRepository();
      const created = await createRun("Implement a probe-ownership recovery feature", {
        cwd: repository,
      });
      const markerPath = join(root, `${fault}-ownership.json`);
      const requestLogPath = join(root, `${fault}-ownership.requests.jsonl`);
      await configureProbeScopeCrash(created, markerPath, false, "progress_baseline");
      await created.store.append("user", "run.approved", { approved: true });
      const sentinel = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        { stdio: "ignore" },
      );
      const sentinelClosed = new Promise<void>((resolveClosed) =>
        sentinel.once("close", () => resolveClosed()),
      );
      const boundary = fault === "forged" ? "probe_scope_forged" : "probe_scope";
      const crash = spawnCrashRunner(
        repository,
        "codex",
        boundary,
        markerPath,
        requestLogPath,
        fault === "forged" ? sentinel.pid : undefined,
      );
      const cleanupPids = new Set<number>();

      try {
        const marker = await waitForProbeScopeMarker(markerPath, crash.child, crash.diagnostics);
        cleanupPids.add(marker.probePid);
        cleanupPids.add(marker.descendantPid);
        cleanupPids.add(marker.brokerPid);
        const crashedStore = new RunStore(repository, created.contract.runId);
        const beforeRestart = await crashedStore.loadEvents();
        const scopeStart = beforeRestart.findLast(
          ({ type, data }) =>
            type === "scope.started" &&
            data.nodeId === "implement" &&
            data.stage === "progress_baseline",
        );
        const processStart = beforeRestart.findLast(
          ({ type, data }) =>
            type === "probe.process.started" && data.checkpointId === scopeStart?.data.checkpointId,
        );
        expect(scopeStart).toBeDefined();
        expect(processStart).toBeDefined();
        if (fault === "forged") {
          expect(processStart?.data.ready).toMatchObject({ brokerPid: sentinel.pid });
          expect(marker.brokerPid).not.toBe(sentinel.pid);
        }
        const journalPath = join(
          crashedStore.graphcraftRoot,
          String(processStart?.data.journalPath),
        );

        expect(crash.child.kill("SIGKILL")).toBe(true);
        await crash.closed;
        await Promise.all(
          [marker.probePid, marker.descendantPid, marker.brokerPid].map((pid) =>
            waitForProcessExit(pid),
          ),
        );
        cleanupPids.clear();
        if (fault === "missing") await rm(journalPath, { force: true });

        await runResume(repository, "codex", boundary, markerPath, requestLogPath);
        const recoveredStore = new RunStore(repository, created.contract.runId);
        const recovered = await recoveredStore.loadState();
        const events = await recoveredStore.loadEvents();
        const checkpointId = scopeStart?.data.checkpointId;
        const failures = events.filter(
          ({ type, data }) =>
            type === "node.failed" &&
            data.nodeId === "implement" &&
            data.scopeCheckpointId === checkpointId,
        );
        const blockers = events.filter(
          ({ type, data }) => type === "run.blocked" && data.scopeCheckpointId === checkpointId,
        );
        expect(recovered.status).toBe("blocked");
        expect(recovered.stopReason).toMatch(
          fault === "forged"
            ? /broker identity is ambiguous/i
            : /cannot find the ownership journal/i,
        );
        expect(failures).toHaveLength(1);
        expect(blockers).toHaveLength(1);
        expect(isProcessAlive(sentinel.pid!)).toBe(true);
        expect(events.filter(({ type }) => type === "probe.process.reconciled")).toHaveLength(0);
        const launches = await probeLaunches(markerPath);
        const interrupted = launches.findIndex(({ probePid }) => probePid === marker.probePid);
        expect(launches.slice(interrupted + 1)).toHaveLength(0);

        await runResume(repository, "codex", boundary, markerPath, requestLogPath);
        const idempotentEvents = await recoveredStore.loadEvents();
        expect(
          idempotentEvents.filter(
            ({ type, data }) =>
              type === "node.failed" &&
              data.nodeId === "implement" &&
              data.scopeCheckpointId === checkpointId,
          ),
        ).toHaveLength(1);
        expect(
          idempotentEvents.filter(
            ({ type, data }) => type === "run.blocked" && data.scopeCheckpointId === checkpointId,
          ),
        ).toHaveLength(1);
        expect(isProcessAlive(sentinel.pid!)).toBe(true);
      } finally {
        if (crash.child.exitCode === null && crash.child.signalCode === null) {
          crash.child.kill("SIGKILL");
          await crash.closed;
        }
        await Promise.all([...cleanupPids].map((pid) => killProcessForCleanup(pid)));
        if (sentinel.pid && isProcessAlive(sentinel.pid)) sentinel.kill("SIGKILL");
        await sentinelClosed;
      }
    },
    60_000,
  );

  it("persists a precise blocker when a settled probe journal cannot be removed during recovery", async () => {
    const { repository, root } = await createRepository();
    const created = await createRun("Implement durable probe journal cleanup recovery", {
      cwd: repository,
    });
    const markerPath = join(root, "probe-cleanup.marker.json");
    const requestLogPath = join(root, "probe-cleanup.requests.jsonl");
    await configureProbeCleanupCrash(created);
    await created.store.append("user", "run.approved", { approved: true });
    const crash = spawnCrashRunner(
      repository,
      "codex",
      "probe_cleanup",
      markerPath,
      requestLogPath,
    );

    try {
      const marker = await waitForMarker(markerPath, crash.child, crash.diagnostics);
      const crashedStore = new RunStore(repository, created.contract.runId);
      const beforeRestart = await crashedStore.loadEvents();
      const processFinish = beforeRestart.find(
        ({ type, data }) =>
          type === "probe.process.finished" && data.executionId === marker.invocationId,
      );
      const processStart = beforeRestart.find(
        ({ type, data }) =>
          type === "probe.process.started" &&
          typeof data.definition === "object" &&
          data.definition !== null &&
          (data.definition as { executionId?: unknown }).executionId === marker.invocationId,
      );
      const checkpointId = processStart?.data.checkpointId;
      const journalPath = join(crashedStore.graphcraftRoot, String(processStart?.data.journalPath));
      expect(processFinish).toBeDefined();
      expect(checkpointId).toEqual(expect.any(String));
      await expect(stat(journalPath)).resolves.toBeDefined();

      expect(crash.child.kill("SIGKILL")).toBe(true);
      await crash.closed;
      await rm(journalPath);
      await mkdir(journalPath);

      await runResume(repository, "codex", "probe_cleanup", markerPath, requestLogPath);
      const recovered = await crashedStore.loadState();
      const events = await crashedStore.loadEvents();
      const failures = events.filter(
        ({ type, data }) =>
          type === "node.failed" &&
          data.nodeId === "implement" &&
          data.scopeCheckpointId === checkpointId,
      );
      const blockers = events.filter(
        ({ type, data }) => type === "run.blocked" && data.scopeCheckpointId === checkpointId,
      );
      expect(recovered.status).toBe("blocked");
      expect(recovered.stopReason).toMatch(
        /cannot clean up the settled ownership journal for probe process/i,
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.data).toMatchObject({
        progressProbeStage: "progress_baseline",
        scopeCheckpointId: checkpointId,
      });
      expect(blockers).toHaveLength(1);
      expect((await stat(journalPath)).isDirectory()).toBe(true);

      await runResume(repository, "codex", "probe_cleanup", markerPath, requestLogPath);
      const idempotentEvents = await crashedStore.loadEvents();
      expect(
        idempotentEvents.filter(
          ({ type, data }) =>
            type === "node.failed" &&
            data.nodeId === "implement" &&
            data.scopeCheckpointId === checkpointId,
        ),
      ).toHaveLength(1);
      expect(
        idempotentEvents.filter(
          ({ type, data }) => type === "run.blocked" && data.scopeCheckpointId === checkpointId,
        ),
      ).toHaveLength(1);
    } finally {
      if (crash.child.exitCode === null && crash.child.signalCode === null) {
        crash.child.kill("SIGKILL");
        await crash.closed;
      }
    }
  }, 45_000);
});
