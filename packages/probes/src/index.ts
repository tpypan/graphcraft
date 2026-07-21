import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { contentHash, type ProbeResult, type ProbeSpec } from "@graphcraft/core";
import { runProcess, type ProcessResult } from "./process.ts";

export interface ExecutedProbe {
  result: ProbeResult;
  output: string;
}

function compactOutput(result: ProcessResult): string {
  const value = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return value.length > 1_000 ? `${value.slice(0, 1_000)}\n…` : value;
}

export async function runProbe(
  spec: ProbeSpec,
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<ExecutedProbe> {
  const started = performance.now();
  if (spec.kind === "command") {
    const processResult = await runProcess(spec.command, spec.args, {
      cwd: spec.cwd ? resolve(repositoryPath, spec.cwd) : repositoryPath,
      timeoutMs: spec.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    const output = [processResult.stdout, processResult.stderr].filter(Boolean).join("\n");
    const passed = !processResult.timedOut && processResult.exitCode === spec.expectedExitCode;
    return {
      result: {
        probeId: spec.id,
        kind: spec.kind,
        passed,
        signature: contentHash({
          exitCode: processResult.exitCode,
          output: compactOutput(processResult),
        }),
        summary: processResult.timedOut
          ? `Timed out after ${spec.timeoutMs}ms`
          : `${spec.command} exited ${processResult.exitCode}${compactOutput(processResult) ? `: ${compactOutput(processResult)}` : ""}`,
        durationMs: processResult.durationMs,
      },
      output,
    };
  }

  if (spec.kind === "file") {
    const path = resolve(repositoryPath, spec.path);
    let exists = true;
    try {
      await access(path, constants.F_OK);
    } catch {
      exists = false;
    }
    let contains = true;
    if (exists && spec.contains) contains = (await readFile(path, "utf8")).includes(spec.contains);
    const passed = exists === spec.shouldExist && contains;
    const summary = `${spec.path} ${exists ? "exists" : "does not exist"}${spec.contains ? ` and ${contains ? "contains" : "does not contain"} the required text` : ""}`;
    return {
      result: {
        probeId: spec.id,
        kind: spec.kind,
        passed,
        signature: contentHash({ exists, contains }),
        summary,
        durationMs: Math.round(performance.now() - started),
      },
      output: summary,
    };
  }

  const diff = await runProcess(
    "git",
    ["diff", "--no-ext-diff", "--name-status", spec.baseSha, "--"],
    { cwd: repositoryPath, ...(signal ? { signal } : {}) },
  );
  const untracked = await runProcess("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: repositoryPath,
    ...(signal ? { signal } : {}),
  });
  const output = [diff.stdout.trim(), untracked.stdout.trim()].filter(Boolean).join("\n");
  const hasChanges = output.length > 0;
  const passed =
    diff.exitCode === 0 && untracked.exitCode === 0 && (!spec.requireChanges || hasChanges);
  return {
    result: {
      probeId: spec.id,
      kind: spec.kind,
      passed,
      signature: contentHash(output),
      summary: hasChanges ? output.split("\n").slice(0, 20).join(", ") : "No workspace changes",
      durationMs: Math.round(performance.now() - started),
    },
    output,
  };
}

export async function runProbes(
  specs: ProbeSpec[],
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<ExecutedProbe[]> {
  const results: ExecutedProbe[] = [];
  for (const spec of specs) results.push(await runProbe(spec, repositoryPath, signal));
  return results;
}

export async function workspaceDigest(repositoryPath: string): Promise<string> {
  const [status, diff] = await Promise.all([
    runProcess("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repositoryPath,
    }),
    runProcess("git", ["diff", "--no-ext-diff", "--binary", "HEAD", "--"], { cwd: repositoryPath }),
  ]);
  if (status.exitCode !== 0 || diff.exitCode !== 0)
    throw new Error("Unable to capture repository state");
  return contentHash({ status: status.stdout, diff: diff.stdout });
}

export async function discoverVerificationProbes(repositoryPath: string): Promise<ProbeSpec[]> {
  const probes: ProbeSpec[] = [];
  try {
    const packageJson = JSON.parse(await readFile(`${repositoryPath}/package.json`, "utf8")) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    const runner = packageJson.packageManager?.startsWith("pnpm") ? "pnpm" : "npm";
    const commandArgs = (script: string): string[] =>
      runner === "pnpm" ? [script] : ["run", script];
    for (const name of ["typecheck", "test", "build"] as const) {
      if (packageJson.scripts?.[name]) {
        probes.push({
          id: `package-${name}`,
          kind: "command",
          command: runner,
          args: commandArgs(name),
          expectedExitCode: 0,
          timeoutMs: name === "test" ? 300_000 : 180_000,
        });
      }
    }
  } catch {
    // Non-Node repositories continue through language-specific discovery.
  }

  try {
    await access(`${repositoryPath}/pyproject.toml`);
    probes.push({
      id: "python-tests",
      kind: "command",
      command: "python",
      args: ["-m", "pytest", "-q"],
      expectedExitCode: 0,
      timeoutMs: 300_000,
    });
  } catch {
    // Not a Python repository.
  }

  try {
    await access(`${repositoryPath}/go.mod`);
    probes.push({
      id: "go-tests",
      kind: "command",
      command: "go",
      args: ["test", "./..."],
      expectedExitCode: 0,
      timeoutMs: 300_000,
    });
  } catch {
    // Not a Go repository.
  }

  return probes;
}

export { runProcess, type ProcessResult } from "./process.ts";
