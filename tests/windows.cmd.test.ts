import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../packages/adapter-claude/src/index.ts";
import { CodexAdapter } from "../packages/adapter-codex/src/index.ts";
import { createHostCommandRunner } from "../packages/cli/src/index.ts";
import { probeGitHub } from "../packages/github/src/index.ts";
import { runProcess } from "../packages/probes/src/process.ts";
import { runSmokeCommand } from "../scripts/verify-release.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

async function windowsShimFixture(): Promise<{
  bin: string;
  environment: NodeJS.ProcessEnv;
  recordPath: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft cmd Ω &() "));
  temporaryRoots.push(root);
  const bin = join(root, "PATH 工具 & fixtures");
  const recordPath = join(root, "exact argv.jsonl");
  await mkdir(bin, { recursive: true });
  const recorderPath = join(bin, "record-host-argv.mjs");
  await writeFile(
    recorderPath,
    `import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [host, ...args] = process.argv.slice(2);
appendFileSync(process.env.GRAPHCRAFT_WINDOWS_ARGV_RECORD, JSON.stringify({ host, args }) + "\\n");
if (host === "fixture-host") process.stdout.write(JSON.stringify(args) + "\\n");
else if (host === "codex" && args.join("\\0") === "--version") process.stdout.write("codex-cli 0.144.6\\n");
else if (host === "codex" && args.join("\\0") === "login\\0status") process.stdout.write("Logged in\\n");
else if (host === "claude" && args.join("\\0") === "--version") process.stdout.write("2.1.212 (Claude Code)\\n");
else if (host === "claude" && args.join("\\0") === "auth\\0status\\0--json") process.stdout.write(JSON.stringify({ loggedIn: true }) + "\\n");
else if (host === "tree-host") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.GRAPHCRAFT_WINDOWS_DESCENDANT_PID, String(descendant.pid));
  setInterval(() => {}, 1000);
} else {
  process.stderr.write("unexpected shim invocation: " + host + " " + args.join(" ") + "\\n");
  process.exitCode = 2;
}
`,
    "utf8",
  );
  for (const host of ["fixture-host", "codex", "claude", "tree-host"]) {
    await writeFile(
      join(bin, `${host}.cmd`),
      `@echo off\r\n"%GRAPHCRAFT_WINDOWS_FIXTURE_NODE%" "%~dp0record-host-argv.mjs" "${host}" %*\r\n`,
      "utf8",
    );
  }

  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  const path = `${bin}${delimiter}${inheritedPath}`;
  vi.stubEnv("PATH", path);
  vi.stubEnv("GRAPHCRAFT_WINDOWS_ARGV_RECORD", recordPath);
  vi.stubEnv("GRAPHCRAFT_WINDOWS_FIXTURE_NODE", process.execPath);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"),
  );
  environment.PATH = path;
  environment.GRAPHCRAFT_WINDOWS_ARGV_RECORD = recordPath;
  environment.GRAPHCRAFT_WINDOWS_FIXTURE_NODE = process.execPath;
  return { bin, environment, recordPath, root };
}

async function recordedInvocations(path: string) {
  return (await readFile(path, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { host: string; args: string[] });
}

async function expectProcessToExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Windows descendant process ${String(pid)} survived command-tree termination`);
}

describe.skipIf(process.platform !== "win32")("Windows .cmd executable boundaries", () => {
  it("resolves real PATH shims and preserves exact metacharacter argv", async () => {
    const fixture = await windowsShimFixture();
    const arguments_ = [
      "space value",
      "Unicode Ω 工具",
      "amp&ersand",
      "pipe|value",
      "angles<value>",
      "percent%literal",
      "caret^value",
      "bang!value!",
      'quote"value',
      "trailing\\",
    ];

    const hostResult = await createHostCommandRunner()("fixture-host", arguments_, {
      cwd: fixture.root,
      timeoutMs: 5_000,
    });
    expect(hostResult).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(hostResult.stdout)).toEqual(arguments_);

    const smokeResult = await runSmokeCommand("fixture-host", arguments_, {
      cwd: fixture.root,
      env: fixture.environment,
      timeoutMs: 5_000,
    });
    expect(JSON.parse(smokeResult.stdout)).toEqual(arguments_);

    await expect(new CodexAdapter().probe()).resolves.toMatchObject({
      installed: true,
      authenticated: true,
      version: "codex-cli 0.144.6",
    });
    await expect(new ClaudeAdapter().probe()).resolves.toMatchObject({
      installed: true,
      authenticated: true,
      version: "2.1.212 (Claude Code)",
    });

    await expect(recordedInvocations(fixture.recordPath)).resolves.toEqual([
      { host: "fixture-host", args: arguments_ },
      { host: "fixture-host", args: arguments_ },
      { host: "codex", args: ["--version"] },
      { host: "codex", args: ["login", "status"] },
      { host: "claude", args: ["--version"] },
      { host: "claude", args: ["auth", "status", "--json"] },
    ]);
  });

  it("kills the full .cmd descendant tree on bounded-command timeout", async () => {
    const fixture = await windowsShimFixture();
    const cliPidPath = join(fixture.root, "cli descendant.pid");
    vi.stubEnv("GRAPHCRAFT_WINDOWS_DESCENDANT_PID", cliPidPath);
    const cliResult = await createHostCommandRunner()("tree-host", [], {
      cwd: fixture.root,
      timeoutMs: 1_000,
    });
    expect(cliResult.exitCode).toBe(-1);
    await expectProcessToExit(Number(await readFile(cliPidPath, "utf8")));

    const smokePidPath = join(fixture.root, "smoke descendant.pid");
    fixture.environment.GRAPHCRAFT_WINDOWS_DESCENDANT_PID = smokePidPath;
    await expect(
      runSmokeCommand("tree-host", [], {
        cwd: fixture.root,
        env: fixture.environment,
        terminationGraceMs: 300,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/timed out after 1000ms/i);
    await expectProcessToExit(Number(await readFile(smokePidPath, "utf8")));

    const probePidPath = join(fixture.root, "probe descendant.pid");
    vi.stubEnv("GRAPHCRAFT_WINDOWS_DESCENDANT_PID", probePidPath);
    const probeResult = await runProcess(join(fixture.bin, "tree-host.cmd"), [], {
      cwd: fixture.root,
      timeoutMs: 1_000,
    });
    expect(probeResult).toMatchObject({ exitCode: 124, timedOut: true });
    await expectProcessToExit(Number(await readFile(probePidPath, "utf8")));

    const githubPidPath = join(fixture.root, "github descendant.pid");
    const githubEnvironment = {
      ...fixture.environment,
      GRAPHCRAFT_WINDOWS_DESCENDANT_PID: githubPidPath,
    };
    await expect(
      probeGitHub({
        command: "tree-host",
        cwd: fixture.root,
        env: githubEnvironment,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ installed: false });
    await expectProcessToExit(Number(await readFile(githubPidPath, "utf8")));
  });
});
