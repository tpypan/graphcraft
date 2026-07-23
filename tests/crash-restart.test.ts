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
type FaultBoundary = "session" | "usage" | "result" | "progress_scope";
type ProgressProbeStage = "progress_baseline" | "progress_current";

interface ProgressScopeMarker {
  boundary: "progress_scope";
  mutated: boolean;
  probePid: number;
  runnerPid: number;
  stage: ProgressProbeStage;
}

const progressScopeProbe = `
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const markerPath = process.argv[1];
const mutated = process.argv[2] === "mutate";
const stage = process.argv[3];
if (existsSync(markerPath)) process.exit(0);
const attemptPath = markerPath + ".attempt";
if (stage === "progress_current" && !existsSync(attemptPath)) {
  writeFileSync(attemptPath, "progress_baseline completed\\n");
  process.exit(0);
}
if (mutated) writeFileSync(join(process.cwd(), "feature.txt"), "probe mutation before crash\\n");
const runnerPid = process.ppid;
writeFileSync(markerPath, JSON.stringify({
  boundary: "progress_scope",
  mutated,
  probePid: process.pid,
  runnerPid,
  stage,
}) + "\\n");
setInterval(() => {
  try {
    process.kill(runnerPid, 0);
  } catch {
    process.exit(0);
  }
}, 25);
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
  ];
}

function spawnCrashRunner(
  repository: string,
  host: HostId,
  boundary: FaultBoundary,
  markerPath: string,
  requestLogPath: string,
): {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  diagnostics: () => string;
} {
  const child = spawn(
    process.execPath,
    runnerArguments(repository, host, "crash", boundary, markerPath, requestLogPath),
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

async function waitForProgressScopeMarker(
  markerPath: string,
  child: ChildProcess,
  diagnostics: () => string,
  timeoutMs = 15_000,
): Promise<ProgressScopeMarker> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return JSON.parse(await readFile(markerPath, "utf8")) as ProgressScopeMarker;
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

async function killProbe(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() > deadline) throw new Error(`Probe process ${pid} did not exit after SIGKILL`);
    await new Promise<void>((done) => setTimeout(done, 20));
  }
}

async function configureProgressScopeCrash(
  created: Awaited<ReturnType<typeof createRun>>,
  markerPath: string,
  mutate: boolean,
  stage: ProgressProbeStage,
): Promise<void> {
  await configureRunProbes(created.store, {
    schemaVersion: 1,
    family: created.probePlan.family,
    items: [
      {
        phase: "progress",
        purpose: "focused",
        source: "Crash-restart scope checkpoint fixture",
        probe: {
          id: "crash-after-progress-scope-start",
          kind: "command",
          command: process.execPath,
          args: ["-e", progressScopeProbe, markerPath, mutate ? "mutate" : "observe", stage],
          expectedExitCode: 0,
          timeoutMs: 30_000,
        },
      },
      ...created.probePlan.items.filter(({ phase }) => phase === "completion"),
    ],
  });
}

async function runResume(
  repository: string,
  host: HostId,
  boundary: FaultBoundary,
  markerPath: string,
  requestLogPath: string,
): Promise<void> {
  await execFileAsync(
    process.execPath,
    runnerArguments(repository, host, "resume", boundary, markerPath, requestLogPath),
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

  const progressScopeCases = (["progress_baseline", "progress_current"] as const).flatMap(
    (stage) => [
      { mutate: false, label: "unchanged", stage },
      { mutate: true, label: "changed", stage },
    ],
  );

  it.each(progressScopeCases)(
    "reconciles an unresolved $stage scope checkpoint when the workspace is $label",
    async ({ mutate, stage }) => {
      const { repository, root } = await createRepository();
      const created = await createRun("Implement a substantial scope-recovery feature", {
        cwd: repository,
      });
      const markerPath = join(root, `${stage}-${mutate ? "changed" : "unchanged"}.json`);
      const requestLogPath = join(
        root,
        `${stage}-${mutate ? "changed" : "unchanged"}.requests.jsonl`,
      );
      await configureProgressScopeCrash(created, markerPath, mutate, stage);
      await created.store.append("user", "run.approved", { approved: true });
      const crash = spawnCrashRunner(
        repository,
        "codex",
        "progress_scope",
        markerPath,
        requestLogPath,
      );
      let probePid: number | undefined;

      try {
        const marker = await waitForProgressScopeMarker(markerPath, crash.child, crash.diagnostics);
        probePid = marker.probePid;
        expect(marker).toMatchObject({
          boundary: "progress_scope",
          mutated: mutate,
          runnerPid: crash.child.pid,
          stage,
        });

        const crashedStore = new RunStore(repository, created.contract.runId);
        const beforeRestart = await crashedStore.loadEvents();
        const scopeStart = beforeRestart.findLast(
          ({ type, data }) =>
            type === "scope.started" && data.nodeId === "implement" && data.stage === stage,
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
        expect(invocationsBeforeRestart).toHaveLength(stage === "progress_current" ? 1 : 0);

        expect(crash.child.kill("SIGKILL")).toBe(true);
        const exit = await crash.closed;
        expect(exit.signal !== null || exit.code !== 0).toBe(true);
        await killProbe(marker.probePid);
        probePid = undefined;

        await runResume(repository, "codex", "progress_scope", markerPath, requestLogPath);
        const recoveredStore = new RunStore(repository, created.contract.runId);
        const recovered = await recoveredStore.loadState();
        const events = await recoveredStore.loadEvents();
        const recoveredScopeCheck = events.find(
          ({ sequence, causationId, type, data }) =>
            sequence > scopeStart!.sequence &&
            type === "scope.checked" &&
            causationId === scopeStart?.data.checkpointId &&
            data.checkpointId === scopeStart?.data.checkpointId &&
            data.nodeId === "implement" &&
            data.stage === stage,
        );
        expect(recoveredScopeCheck?.data).toMatchObject({
          nodeId: "implement",
          stage,
          recovered: true,
        });
        expect(recoveredScopeCheck?.data.audit).toMatchObject({ allowed: !mutate });

        const workspace = await recoveredStore.loadWorkspace<{ path: string }>();
        if (mutate) {
          expect(recovered.status).toBe("blocked");
          expect(recovered.nodes.implement?.status).toBe("failed");
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
              data.nodeId === "implement" &&
              data.scopeCheckpointId === scopeStart?.data.checkpointId,
          );
          expect(checkpointFailures).toHaveLength(1);
          const failure = checkpointFailures[0]!;
          expect(failure?.data).toMatchObject({
            progressProbeStage: stage,
            scopeCheckpointId: scopeStart?.data.checkpointId,
          });
          expect(failure?.data.reason).toMatch(
            /progress probe execution changed repository state/i,
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

          await runResume(repository, "codex", "progress_scope", markerPath, requestLogPath);
          const idempotentState = await recoveredStore.loadState();
          const idempotentEvents = await recoveredStore.loadEvents();
          expect(idempotentState.status).toBe("blocked");
          expect(
            idempotentEvents.filter(
              ({ type, data }) =>
                type === "node.failed" &&
                data.nodeId === "implement" &&
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
          expect(recovered.nodes.implement?.status).toBe("accepted");
          expect(
            events.filter(
              ({ type, data }) => type === "invocation.started" && data.nodeId === "implement",
            ),
          ).toHaveLength(1);
          await expect(readFile(join(workspace.path, "feature.txt"), "utf8")).resolves.toBe(
            "completed after cold restart\n",
          );
        }
      } finally {
        if (crash.child.exitCode === null && crash.child.signalCode === null) {
          crash.child.kill("SIGKILL");
          await crash.closed;
        }
        if (probePid !== undefined) await killProbe(probePid);
      }
    },
    45_000,
  );
});
