import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  contentHash,
  createHeldOutProbePlan,
  heldOutProbePlanHashAlgorithm,
  validateHeldOutProbePlan,
  type CanonicalHashAlgorithm,
  type HeldOutProbeIntegrity,
  type HeldOutProbePlan,
  type ProbePlan,
  type ProbeResult,
} from "@graphcraft/core";
import {
  assertRepositoryDirectory,
  assertRepositoryInventoryPaths,
  isRepositoryFileError,
  readRepositoryFile,
  readRepositoryTextFile,
  runProcess,
} from "@graphcraft/probes";

function relativeRepositoryPath(repositoryRoot: string, candidate: string): string | undefined {
  const root = resolve(repositoryRoot);
  const path = resolve(repositoryRoot, candidate);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return undefined;
  const result = relative(root, path);
  return result && !isAbsolute(result) ? result.split(sep).join("/") : undefined;
}

function relativeRepositoryDirectoryPath(
  repositoryRoot: string,
  candidate: string,
): string | undefined {
  const root = resolve(repositoryRoot);
  const path = resolve(repositoryRoot, candidate);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return undefined;
  const result = relative(root, path);
  return result && !isAbsolute(result) ? result.split(sep).join("/") : ".";
}

async function directoryValueHash(
  repositoryRoot: string,
  path: string,
  algorithm: CanonicalHashAlgorithm,
  signal?: AbortSignal,
): Promise<string> {
  const [canonicalRoot, canonicalPath] = await Promise.all([
    assertRepositoryDirectory(repositoryRoot, ".", signal),
    assertRepositoryDirectory(repositoryRoot, path, signal),
  ]);
  signal?.throwIfAborted();
  const target = relative(canonicalRoot, canonicalPath);
  if (isAbsolute(target) || target === ".." || target.startsWith(`..${sep}`))
    throw new Error(`Completion working directory ${path} escapes the repository`);
  return contentHash(
    {
      path,
      target: target ? target.split(sep).join("/") : ".",
    },
    algorithm,
  );
}

async function gitObjectValueHash(
  repositoryRoot: string,
  path: string,
  contents: Buffer,
  algorithm: CanonicalHashAlgorithm,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const result = await runProcess(
    "git",
    ["hash-object", "--stdin", `--path=${path.replaceAll("\\", "/")}`],
    {
      cwd: repositoryRoot,
      input: contents,
      timeoutMs: 120_000,
      maxOutputBytesPerStream: 1024 * 1024,
      ...(signal ? { signal } : {}),
    },
  );
  signal?.throwIfAborted();
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `git hash-object failed for ${path}`);
  const objectHash = result.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(objectHash))
    throw new Error(`Unable to establish held-out integrity for ${path}`);
  return contentHash({ path, objectHash }, algorithm);
}

async function fileValueHash(
  repositoryRoot: string,
  path: string,
  fileAlgorithm: "git_hash_object" | undefined,
  canonicalHashAlgorithm: CanonicalHashAlgorithm,
  signal?: AbortSignal,
): Promise<string> {
  let contents: Buffer;
  try {
    contents = await readRepositoryFile(repositoryRoot, path, {
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (isRepositoryFileError(error, "missing", "not_file"))
      return contentHash(
        { missing: true, path, ...(fileAlgorithm ? { algorithm: fileAlgorithm } : {}) },
        canonicalHashAlgorithm,
      );
    throw error;
  }
  if (fileAlgorithm === "git_hash_object")
    return await gitObjectValueHash(repositoryRoot, path, contents, canonicalHashAlgorithm, signal);
  return contentHash({ path, contents: contents.toString("base64") }, canonicalHashAlgorithm);
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
  algorithm: CanonicalHashAlgorithm,
  signal?: AbortSignal,
): Promise<HeldOutProbeIntegrity[]> {
  const result: HeldOutProbeIntegrity[] = [];
  for (const value of possibleFileArguments(values)) {
    signal?.throwIfAborted();
    const path = relativeRepositoryPath(repositoryRoot, resolve(repositoryRoot, cwd ?? ".", value));
    if (!path) continue;
    try {
      await readRepositoryFile(repositoryRoot, path, {
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (isRepositoryFileError(error, "missing", "not_file")) continue;
      throw error;
    }
    result.push({
      kind: "file",
      path,
      algorithm: "git_hash_object",
      valueHash: await fileValueHash(repositoryRoot, path, "git_hash_object", algorithm, signal),
    });
  }
  return result;
}

export async function createRuntimeHeldOutProbePlan(
  runId: string,
  probePlan: ProbePlan,
  repositoryRoot: string,
  signal?: AbortSignal,
  algorithm: CanonicalHashAlgorithm = LEGACY_CANONICAL_HASH_ALGORITHM,
): Promise<HeldOutProbePlan> {
  const integrity: Record<string, HeldOutProbeIntegrity[]> = {};
  for (const item of probePlan.items.filter(({ phase }) => phase === "completion")) {
    signal?.throwIfAborted();
    if (item.probe.kind === "held_out")
      throw new Error("An approved probe plan cannot contain held-out references");
    const protectedValues: HeldOutProbeIntegrity[] = [];
    if (item.probe.kind === "command") {
      const cwd = relativeRepositoryDirectoryPath(repositoryRoot, item.probe.cwd ?? ".");
      if (!cwd)
        throw new Error(`Completion probe ${item.probe.id} working directory escapes repository`);
      protectedValues.push({
        kind: "directory",
        path: cwd,
        valueHash: await directoryValueHash(repositoryRoot, cwd, algorithm, signal),
      });
      protectedValues.push(
        ...(await fileIntegrity(
          repositoryRoot,
          item.probe.cwd,
          item.probe.args,
          algorithm,
          signal,
        )),
      );
    }
    if (item.probe.kind === "repository_inventory")
      await assertRepositoryInventoryPaths(repositoryRoot, item.probe.paths, signal);
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
      await readRepositoryTextFile(repositoryRoot, manifestPath, {
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
      valueHash: contentHash({ path: manifestPath, script, value }, algorithm),
    });
    const scriptDirectory = manifestPath.includes("/")
      ? manifestPath.slice(0, manifestPath.lastIndexOf("/"))
      : undefined;
    protectedValues.push(
      ...(await fileIntegrity(
        repositoryRoot,
        scriptDirectory,
        value.split(/\s+/),
        algorithm,
        signal,
      )),
    );
    const unique = new Map(
      protectedValues.map((entry) => [
        `${entry.kind}:${entry.path}${entry.kind === "package_script" ? `:${entry.script}` : ""}`,
        entry,
      ]),
    );
    integrity[item.probe.id] = [...unique.values()];
  }
  return createHeldOutProbePlan(runId, probePlan, integrity, algorithm);
}

export async function heldOutIntegrityFailures(
  plan: HeldOutProbePlan,
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<ProbeResult[]> {
  const heldOutPlan = validateHeldOutProbePlan(plan);
  const algorithm = heldOutProbePlanHashAlgorithm(heldOutPlan);
  const failures: ProbeResult[] = [];
  for (const entry of heldOutPlan.probes) {
    signal?.throwIfAborted();
    const changedKinds = new Set<string>();
    let signature = "";
    if (entry.probe.kind === "repository_inventory") {
      try {
        await assertRepositoryInventoryPaths(repositoryPath, entry.probe.paths, signal);
      } catch (error) {
        signal?.throwIfAborted();
        changedKinds.add("repository_path");
        signature += contentHash(
          {
            probeId: entry.probe.id,
            kind: "repository_path",
            reason: isRepositoryFileError(error) ? error.kind : "invalid",
          },
          algorithm,
        );
      }
    }
    for (const integrity of entry.integrity) {
      signal?.throwIfAborted();
      let actualHash: string;
      try {
        if (integrity.kind === "package_script") {
          const manifest = JSON.parse(
            await readRepositoryTextFile(repositoryPath, integrity.path, {
              ...(signal ? { signal } : {}),
            }),
          ) as {
            scripts?: Record<string, string>;
          };
          const value = manifest.scripts?.[integrity.script];
          actualHash = value
            ? contentHash({ path: integrity.path, script: integrity.script, value }, algorithm)
            : contentHash(
                { missing: true, path: integrity.path, script: integrity.script },
                algorithm,
              );
        } else if (integrity.kind === "directory") {
          actualHash = await directoryValueHash(repositoryPath, integrity.path, algorithm, signal);
        } else {
          actualHash = await fileValueHash(
            repositoryPath,
            integrity.path,
            integrity.algorithm,
            algorithm,
            signal,
          );
        }
      } catch (error) {
        signal?.throwIfAborted();
        actualHash = contentHash(
          {
            unavailable: true,
            path: integrity.path,
            kind: integrity.kind,
            reason: isRepositoryFileError(error) ? error.kind : "invalid",
          },
          algorithm,
        );
      }
      if (actualHash === integrity.valueHash) continue;
      changedKinds.add(integrity.kind);
      signature += actualHash;
    }
    if (changedKinds.size > 0) {
      const detail = [
        changedKinds.has("package_script") ? "package script definition" : undefined,
        changedKinds.has("file") ? "protected measurement file" : undefined,
        changedKinds.has("directory") ? "working directory" : undefined,
        changedKinds.has("repository_path") ? "repository inventory path boundary" : undefined,
      ]
        .filter(Boolean)
        .join(" and ");
      failures.push({
        probeId: `${entry.probe.id}-integrity`,
        kind: "file",
        passed: false,
        signature: contentHash(signature, algorithm),
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
