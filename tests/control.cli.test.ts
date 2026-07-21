import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createRun, RunStore } from "../packages/runtime/src/index.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft control "));
  temporaryRoots.push(root);
  const repository = join(root, "repo with spaces");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Graphcraft Test");
  await git(repository, "config", "user.email", "graphcraft@example.test");
  await git(repository, "config", "commit.gpgSign", "false");
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      name: "control-fixture",
      private: true,
      scripts: { test: "node verify.mjs" },
    }),
  );
  await writeFile(
    join(repository, "verify.mjs"),
    'import { access } from "node:fs/promises"; await access(new URL("./feature.txt", import.meta.url));\n',
  );
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "fixture");
  return repository;
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runOwner(
  repository: string,
  mode: "wait" | "complete",
  pidPath: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    join(process.cwd(), "node_modules", ".bin", "tsx"),
    ["tests/fixtures/control-runner.ts", repository, mode, pidPath],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return await new Promise((resolve) =>
    child.once("close", (code) => resolve({ code, stdout, stderr })),
  );
}

async function controlCli(repository: string, action: "pause" | "stop"): Promise<void> {
  await execFileAsync(
    join(process.cwd(), "node_modules", ".bin", "tsx"),
    ["packages/cli/src/bin.ts", action, "-C", repository],
    { cwd: process.cwd(), timeout: 10_000 },
  );
}

describe("cross-process run control", () => {
  it("pauses, resumes, and stops from a second CLI process without orphaning children", async () => {
    const repository = await createRepository();
    const pausedRun = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    await pausedRun.store.append("user", "run.approved", { approved: true });
    const pausePidPath = join(repository, "pause-child.pid");
    const owner = runOwner(repository, "wait", pausePidPath);
    await waitForFile(pausePidPath);
    const pausePid = Number((await readFile(pausePidPath, "utf8")).trim());

    await controlCli(repository, "pause");
    const pausedOwner = await owner;
    expect(pausedOwner.code, pausedOwner.stderr).toBe(0);
    expect(processExists(pausePid)).toBe(false);
    const pausedState = await pausedRun.store.loadState();
    expect(pausedState.status).toBe("paused");
    expect(
      (await pausedRun.store.loadEvents()).find(
        ({ type, data }) => type === "control.applied" && data.outcome === "forced",
      ),
    ).toBeDefined();

    const resumedOwner = await runOwner(repository, "complete", pausePidPath);
    expect(resumedOwner.code, resumedOwner.stderr).toBe(0);
    expect((await pausedRun.store.loadState()).status).toBe("completed");

    const stoppedRun = await createRun("Implement another substantial feature in the fixture", {
      cwd: repository,
    });
    await stoppedRun.store.append("user", "run.approved", { approved: true });
    const stopPidPath = join(repository, "stop-child.pid");
    const stoppingOwner = runOwner(repository, "wait", stopPidPath);
    await waitForFile(stopPidPath);
    const stopPid = Number((await readFile(stopPidPath, "utf8")).trim());

    await controlCli(repository, "stop");
    const stoppedOwner = await stoppingOwner;
    expect(stoppedOwner.code, stoppedOwner.stderr).toBe(0);
    expect(processExists(stopPid)).toBe(false);
    const stoppedStore = new RunStore(repository, stoppedRun.contract.runId);
    expect((await stoppedStore.loadState()).status).toBe("stopped");
  }, 30_000);
});
