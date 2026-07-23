import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  contentHash,
  createHeldOutProbePlan,
  type HeldOutProbeIntegrity,
  type HeldOutProbePlan,
  type ProbePlan,
  type ProbeResult,
} from "@graphcraft/core";
import { runProcess } from "@graphcraft/probes";

const execFileAsync = promisify(execFile);

function relativeRepositoryPath(repositoryRoot: string, candidate: string): string | undefined {
  const root = resolve(repositoryRoot);
  const path = resolve(repositoryRoot, candidate);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return undefined;
  const result = relative(root, path);
  return result && !isAbsolute(result) ? result.split(sep).join("/") : undefined;
}

async function gitObjectValueHash(
  repositoryRoot: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const args = [
    "hash-object",
    `--path=${path.replaceAll("\\", "/")}`,
    resolve(repositoryRoot, path),
  ];
  const stdout = signal
    ? await runProcess("git", args, {
        cwd: repositoryRoot,
        signal,
        timeoutMs: 120_000,
        maxOutputBytesPerStream: 1024 * 1024,
      }).then((result) => {
        signal.throwIfAborted();
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `git hash-object failed for ${path}`);
        return result.stdout;
      })
    : (
        await execFileAsync("git", args, {
          cwd: repositoryRoot,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
  signal?.throwIfAborted();
  const objectHash = stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(objectHash))
    throw new Error(`Unable to establish held-out integrity for ${path}`);
  return contentHash({ path, objectHash });
}

async function fileValueHash(
  repositoryRoot: string,
  path: string,
  algorithm: "git_hash_object" | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (algorithm === "git_hash_object") {
    const details = await stat(resolve(repositoryRoot, path)).catch(() => undefined);
    signal?.throwIfAborted();
    return details?.isFile()
      ? await gitObjectValueHash(repositoryRoot, path, signal)
      : contentHash({ missing: true, path, algorithm });
  }
  const contents = await readFile(resolve(repositoryRoot, path), {
    ...(signal ? { signal } : {}),
  }).catch(() => {
    signal?.throwIfAborted();
    return undefined;
  });
  return contents
    ? contentHash({ path, contents: contents.toString("base64") })
    : contentHash({ missing: true, path });
}

function possibleFileArguments(values: string[]): string[] {
  return values
    .map((value) => value.replace(/^["']|["']$/g, "").replace(/[;&|]+$/g, ""))
    .filter(
      (value) =>
        !value.startsWith("-") &&
        (value.startsWith(".") || value.includes("/") || /\.[a-z0-9]{1,8}$/i.test(value)),
    );
}

async function fileIntegrity(
  repositoryRoot: string,
  cwd: string | undefined,
  values: string[],
  signal?: AbortSignal,
): Promise<HeldOutProbeIntegrity[]> {
  const result: HeldOutProbeIntegrity[] = [];
  for (const value of possibleFileArguments(values)) {
    signal?.throwIfAborted();
    const path = relativeRepositoryPath(repositoryRoot, resolve(repositoryRoot, cwd ?? ".", value));
    if (!path) continue;
    const details = await stat(resolve(repositoryRoot, path)).catch(() => undefined);
    signal?.throwIfAborted();
    if (!details?.isFile()) continue;
    result.push({
      kind: "file",
      path,
      algorithm: "git_hash_object",
      valueHash: await fileValueHash(repositoryRoot, path, "git_hash_object", signal),
    });
  }
  return result;
}

export async function createRuntimeHeldOutProbePlan(
  runId: string,
  probePlan: ProbePlan,
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<HeldOutProbePlan> {
  const integrity: Record<string, HeldOutProbeIntegrity[]> = {};
  for (const item of probePlan.items.filter(({ phase }) => phase === "completion")) {
    signal?.throwIfAborted();
    if (item.probe.kind === "held_out")
      throw new Error("An approved probe plan cannot contain held-out references");
    const protectedValues: HeldOutProbeIntegrity[] = [];
    if (item.probe.kind === "command") {
      protectedValues.push(
        ...(await fileIntegrity(repositoryRoot, item.probe.cwd, item.probe.args, signal)),
      );
    }
    const match = /^(.*package\.json) script (.+)$/.exec(item.source);
    if (!match) {
      integrity[item.probe.id] = protectedValues;
      continue;
    }
    const path = match[1]!;
    const script = match[2]!;
    const manifestPath = relativeRepositoryPath(repositoryRoot, path);
    if (!manifestPath) throw new Error(`Completion script ${script} escapes the repository`);
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, manifestPath), {
        encoding: "utf8",
        ...(signal ? { signal } : {}),
      }),
    ) as { scripts?: Record<string, string> };
    signal?.throwIfAborted();
    const value = manifest.scripts?.[script];
    if (!value) throw new Error(`Completion script ${script} is missing from ${manifestPath}`);
    protectedValues.push({
      kind: "package_script",
      path: manifestPath,
      script,
      valueHash: contentHash({ path: manifestPath, script, value }),
    });
    const scriptDirectory = manifestPath.includes("/")
      ? manifestPath.slice(0, manifestPath.lastIndexOf("/"))
      : undefined;
    protectedValues.push(
      ...(await fileIntegrity(repositoryRoot, scriptDirectory, value.split(/\s+/), signal)),
    );
    const unique = new Map(
      protectedValues.map((entry) => [
        `${entry.kind}:${entry.path}${entry.kind === "package_script" ? `:${entry.script}` : ""}`,
        entry,
      ]),
    );
    integrity[item.probe.id] = [...unique.values()];
  }
  return createHeldOutProbePlan(runId, probePlan, integrity);
}

export async function heldOutIntegrityFailures(
  plan: HeldOutProbePlan,
  repositoryPath: string,
): Promise<ProbeResult[]> {
  const failures: ProbeResult[] = [];
  for (const entry of plan.probes) {
    const changedKinds = new Set<string>();
    let signature = "";
    for (const integrity of entry.integrity) {
      let actualHash: string;
      if (integrity.kind === "package_script") {
        const manifest = await readFile(resolve(repositoryPath, integrity.path), "utf8")
          .then(
            (value) =>
              JSON.parse(value) as {
                scripts?: Record<string, string>;
              },
          )
          .catch(() => undefined);
        const value = manifest?.scripts?.[integrity.script];
        actualHash = value
          ? contentHash({ path: integrity.path, script: integrity.script, value })
          : contentHash({ missing: true, path: integrity.path, script: integrity.script });
      } else {
        actualHash = await fileValueHash(repositoryPath, integrity.path, integrity.algorithm);
      }
      if (actualHash === integrity.valueHash) continue;
      changedKinds.add(integrity.kind);
      signature += actualHash;
    }
    if (changedKinds.size > 0) {
      const detail = [
        changedKinds.has("package_script") ? "package script definition" : undefined,
        changedKinds.has("file") ? "protected measurement file" : undefined,
      ]
        .filter(Boolean)
        .join(" and ");
      failures.push({
        probeId: `${entry.probe.id}-integrity`,
        kind: "file",
        passed: false,
        signature: contentHash(signature),
        summary: `Approved completion check ${entry.probe.id} changed or was removed; restore its ${detail}`,
        durationMs: 0,
      });
    }
  }
  return failures;
}

export function actionableHeldOutFailures(results: ProbeResult[]): ProbeResult[] {
  return results.map((result) => {
    if (result.probeId.endsWith("-integrity")) return result;
    const separator = result.summary.indexOf(":");
    const detail = separator >= 0 ? result.summary.slice(separator + 1).trim() : "";
    return {
      ...result,
      summary: `Completion check ${result.probeId} failed${detail ? `: ${detail}` : ""}`,
    };
  });
}
