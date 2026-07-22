import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  ProbePlanSchema,
  classifyTask,
  contentHash,
  type ProbePlan,
  type ProbePlanItem,
  type ProbeResult,
  type ProbeSpec,
} from "@graphcraft/core";
import {
  DEFAULT_PROBE_OUTPUT_BYTES_PER_STREAM,
  runProcess,
  type ProcessResult,
} from "./process.ts";

export interface ExecutedProbe {
  result: ProbeResult;
  output: string;
}

function compactOutput(result: ProcessResult): string {
  const value = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  const truncated = (["stdout", "stderr"] as const).flatMap((stream) => {
    const capture = result.capture[stream];
    return capture.truncated
      ? [`${stream} retained ${capture.retainedBytes} of ${capture.observedBytes} bytes`]
      : [];
  });
  if (truncated.length === 0) return value.length > 1_000 ? `${value.slice(0, 1_000)}\n…` : value;
  const note = `[Output truncated by Graphcraft: ${truncated.join("; ")}]`;
  const available = Math.max(0, 1_000 - note.length - 2);
  const prefix = value.slice(0, available);
  return `${prefix}${value.length > available ? "\n…" : ""}\n${note}`;
}

export async function runProbe(
  spec: ProbeSpec,
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<ExecutedProbe> {
  const started = performance.now();
  if (spec.kind === "held_out")
    throw new Error(`Held-out probe ${spec.id} must be resolved by the runtime`);
  if (spec.kind === "command") {
    const processResult = await runProcess(spec.command, spec.args, {
      cwd: spec.cwd ? resolve(repositoryPath, spec.cwd) : repositoryPath,
      timeoutMs: spec.timeoutMs,
      maxOutputBytesPerStream: DEFAULT_PROBE_OUTPUT_BYTES_PER_STREAM,
      outputOverflow: "truncate",
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
          stdoutDigest: processResult.capture.stdout.digest,
          stderrDigest: processResult.capture.stderr.digest,
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

  if (spec.kind === "repository_inventory") {
    const args = ["grep", "-l", "-I", "-F"];
    for (const term of spec.terms) args.push("-e", term);
    args.push("--", ...spec.paths);
    const inventory = await runProcess("git", args, {
      cwd: repositoryPath,
      ...(signal ? { signal } : {}),
    });
    const matches = inventory.stdout.split("\n").filter(Boolean);
    const passed = inventory.exitCode === 0 || inventory.exitCode === 1;
    const summary = matches.length
      ? `${matches.length} tracked files match ${spec.terms.join(", ")}: ${matches.slice(0, 20).join(", ")}`
      : `No tracked files match ${spec.terms.join(", ")}`;
    return {
      result: {
        probeId: spec.id,
        kind: spec.kind,
        passed,
        signature: contentHash({ matches, terms: spec.terms }),
        summary,
        durationMs: inventory.durationMs,
        metrics: { inventoryMatches: matches.length },
      },
      output: inventory.stdout,
    };
  }

  if (spec.kind === "github_snapshot")
    throw new Error(`GitHub snapshot probe ${spec.id} must be executed by the runtime`);

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

const probeStopWords = new Set([
  "across",
  "add",
  "and",
  "audit",
  "bug",
  "every",
  "feature",
  "files",
  "fix",
  "from",
  "implement",
  "investigate",
  "migration",
  "refactor",
  "repository",
  "review",
  "that",
  "the",
  "this",
  "verify",
  "with",
]);

function taskTerms(task: string): string[] {
  const quoted = [...task.matchAll(/[`"']([^`"']{2,40})[`"']/g)].map((match) => match[1]!);
  const words = task.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g) ?? [];
  return [
    ...new Set(
      [...quoted, ...words]
        .map((value) => value.toLowerCase())
        .filter((value) => !probeStopWords.has(value)),
    ),
  ].slice(0, 10);
}

function stableId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function packageCommand(
  packageManager: string | undefined,
  script: string,
): Pick<Extract<ProbeSpec, { kind: "command" }>, "command" | "args" | "platforms"> {
  const manager = packageManager?.split("@")[0] ?? "npm";
  const direct = manager === "pnpm" || manager === "yarn" ? "corepack" : manager;
  const directArgs = [
    ...(direct === "corepack" ? [manager] : []),
    ...(manager === "npm" ? ["run"] : []),
    script,
  ];
  if (process.platform !== "win32") {
    return { command: direct, args: directArgs, platforms: ["darwin", "linux"] };
  }
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [direct, ...directArgs].join(" ")],
    platforms: ["win32"],
  };
}

function familyScriptPurpose(
  family: ProbePlan["family"],
  name: string,
  terms: string[],
): "focused" | "acceptance" | "regression" | undefined {
  const normalized = name.toLowerCase();
  if (!/test|check|lint|typecheck|build|verify|validate|audit/.test(normalized)) return undefined;
  if (/fix|write|update|generate|deploy|publish|release/.test(normalized)) return undefined;
  if (terms.some((term) => term.length >= 3 && normalized.includes(stableId(term))))
    return "focused";
  if (family === "feature" && /accept|integration|e2e|scenario/.test(normalized))
    return "acceptance";
  const matchedFamily =
    (family === "bug" && /unit|regression|focused/.test(normalized)) ||
    (family === "migration" && /migrat|upgrade|compat/.test(normalized)) ||
    (family === "refactor" && /unit|structur|typecheck/.test(normalized)) ||
    (family === "audit" && /audit|lint|static|typecheck/.test(normalized));
  if (matchedFamily) return "focused";
  if (["check", "test", "typecheck", "lint", "build"].includes(normalized)) return "regression";
  return undefined;
}

interface Candidate {
  item: ProbePlanItem;
  root: boolean;
}

async function packageCandidates(
  repositoryPath: string,
  family: ProbePlan["family"],
  terms: string[],
): Promise<Candidate[]> {
  const tracked = await runProcess("git", ["ls-files"], { cwd: repositoryPath });
  if (tracked.exitCode !== 0) return [];
  const manifests = tracked.stdout
    .split("\n")
    .filter((path) => path === "package.json" || path.endsWith("/package.json"))
    .slice(0, 100);
  const rootManifest = manifests.includes("package.json")
    ? (JSON.parse(await readFile(join(repositoryPath, "package.json"), "utf8")) as {
        packageManager?: string;
      })
    : undefined;
  const candidates: Candidate[] = [];
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await readFile(join(repositoryPath, manifestPath), "utf8")) as {
      name?: string;
      packageManager?: string;
      scripts?: Record<string, string>;
    };
    const directory = dirname(manifestPath) === "." ? undefined : dirname(manifestPath);
    const relevant =
      !directory ||
      terms.some(
        (term) =>
          directory.toLowerCase().includes(term) || manifest.name?.toLowerCase().includes(term),
      );
    if (!relevant) continue;
    for (const name of Object.keys(manifest.scripts ?? {}).sort()) {
      const purpose = familyScriptPurpose(family, name, terms);
      if (!purpose) continue;
      const command = packageCommand(manifest.packageManager ?? rootManifest?.packageManager, name);
      candidates.push({
        root: !directory,
        item: {
          phase: "completion",
          purpose,
          source: `${manifestPath} script ${name}`,
          probe: {
            id: stableId(`package-${directory ?? "root"}-${name}`),
            kind: "command",
            ...command,
            ...(directory ? { cwd: directory } : {}),
            expectedExitCode: 0,
            timeoutMs: /test|e2e|integration/.test(name) ? 300_000 : 180_000,
          },
        },
      });
    }
  }
  return candidates;
}

function selectPackageCandidates(candidates: Candidate[]): ProbePlanItem[] {
  const focused = candidates
    .filter(({ item }) => item.purpose !== "regression")
    .sort((left, right) => Number(right.root) - Number(left.root))
    .slice(0, 2)
    .map(({ item }) => item);
  const rootCheck = candidates.find(
    ({ root, item }) => root && item.purpose === "regression" && item.probe.id.endsWith("-check"),
  );
  const regression = (
    rootCheck
      ? [rootCheck]
      : candidates.filter(({ item }) => item.purpose === "regression").slice(0, 3)
  ).map(({ item }) => item);
  return [...focused, ...regression].filter(
    (item, index, items) => items.findIndex(({ probe }) => probe.id === item.probe.id) === index,
  );
}

function withinRepository(repositoryPath: string, candidate: string): boolean {
  const root = resolve(repositoryPath);
  const path = resolve(repositoryPath, candidate);
  return path === root || path.startsWith(`${root}${sep}`);
}

export async function validateProbePlan(
  input: ProbePlan,
  repositoryPath: string,
): Promise<ProbePlan> {
  const plan = ProbePlanSchema.parse(input);
  if (!plan.items.some(({ phase }) => phase === "completion"))
    throw new Error("A probe plan must contain at least one completion probe");
  const keys = new Set<string>();
  for (const item of plan.items) {
    const key = `${item.phase}:${item.probe.id}`;
    if (keys.has(key)) throw new Error(`Duplicate ${item.phase} probe ID ${item.probe.id}`);
    keys.add(key);
    if (item.probe.kind === "held_out")
      throw new Error("User-editable probe plans cannot contain held-out references");
    if (item.probe.kind === "github_snapshot" && item.phase !== "progress")
      throw new Error(`GitHub snapshot probe ${item.probe.id} must be progress evidence`);
    if (item.probe.kind === "command") {
      if (item.probe.timeoutMs > 1_800_000)
        throw new Error(`Probe ${item.probe.id} exceeds the 30 minute timeout limit`);
      if (item.probe.platforms && !item.probe.platforms.includes(process.platform as never))
        throw new Error(`Probe ${item.probe.id} does not support ${process.platform}`);
      const cwd = item.probe.cwd ?? ".";
      if (!withinRepository(repositoryPath, cwd))
        throw new Error(`Probe ${item.probe.id} escapes the repository working directory`);
      const directory = await stat(resolve(repositoryPath, cwd)).catch(() => undefined);
      if (!directory?.isDirectory())
        throw new Error(`Probe ${item.probe.id} uses missing working directory ${cwd}`);
    }
    if (item.probe.kind === "file" && !withinRepository(repositoryPath, item.probe.path)) {
      throw new Error(`Probe ${item.probe.id} escapes the repository`);
    }
    if (
      item.probe.kind === "repository_inventory" &&
      item.probe.paths.some((path) => !withinRepository(repositoryPath, path))
    ) {
      throw new Error(`Probe ${item.probe.id} escapes the repository inventory scope`);
    }
  }
  return plan;
}

export async function discoverProbePlan(
  repositoryPath: string,
  task: string,
  baseSha: string,
  options: {
    finishLine?: "local_verified" | "committed" | "pushed" | "pr_open";
  } = {},
): Promise<ProbePlan> {
  const family = classifyTask(task);
  const terms = taskTerms(task);
  const inventoryTerms = terms.length ? terms : [family];
  const inventory: Extract<ProbeSpec, { kind: "repository_inventory" }> = {
    id: `${family}-task-inventory`,
    kind: "repository_inventory",
    paths: ["."],
    terms: inventoryTerms,
  };
  const items: ProbePlanItem[] = [
    {
      phase: "progress",
      purpose: "inventory",
      source: "Task terms matched against tracked repository files",
      probe: inventory,
    },
    {
      phase: "progress",
      purpose: "focused",
      source: "Approved base SHA workspace delta",
      probe: {
        id: "workspace-diff",
        kind: "git_diff",
        baseSha,
        requireChanges: family !== "audit",
      },
    },
  ];

  if (options.finishLine === "pr_open") {
    items.push({
      phase: "progress",
      purpose: "acceptance",
      source: "Authoritative SHA-bound GitHub snapshot for the approved run branch",
      probe: {
        id: "pull-request-lifecycle",
        kind: "github_snapshot",
        pullRequest: "run_branch",
        expectedState: "open",
        requiredChecks: "observe",
        reviewThreads: "observe",
      },
    });
  }

  const selected = selectPackageCandidates(
    await packageCandidates(repositoryPath, family, inventoryTerms),
  );
  for (const completion of selected) {
    if (completion.purpose !== "regression") items.push({ ...completion, phase: "progress" });
    items.push(completion);
  }

  try {
    await access(join(repositoryPath, "pyproject.toml"));
    items.push({
      phase: "completion",
      purpose: "regression",
      source: "pyproject.toml",
      probe: {
        id: "python-tests",
        kind: "command",
        command: "python",
        args: ["-m", "pytest", "-q"],
        expectedExitCode: 0,
        timeoutMs: 300_000,
        platforms: ["darwin", "linux", "win32"],
      },
    });
  } catch {
    // Not a Python repository.
  }

  try {
    await access(join(repositoryPath, "go.mod"));
    items.push({
      phase: "completion",
      purpose: "regression",
      source: "go.mod",
      probe: {
        id: "go-tests",
        kind: "command",
        command: "go",
        args: ["test", "./..."],
        expectedExitCode: 0,
        timeoutMs: 300_000,
        platforms: ["darwin", "linux", "win32"],
      },
    });
  } catch {
    // Not a Go repository.
  }

  if (family === "audit" || !items.some(({ phase }) => phase === "completion")) {
    items.push({
      phase: "completion",
      purpose: "inventory",
      source: "Task-term coverage across tracked repository files",
      probe: inventory,
    });
  }

  return await validateProbePlan({ schemaVersion: 1, family, items }, repositoryPath);
}

export async function discoverVerificationProbes(repositoryPath: string): Promise<ProbeSpec[]> {
  const head = await runProcess("git", ["rev-parse", "HEAD"], { cwd: repositoryPath });
  const plan = await discoverProbePlan(
    repositoryPath,
    "Verify the repository with its declared checks",
    head.stdout.trim() || "HEAD",
  );
  return plan.items.filter(({ phase }) => phase === "completion").map(({ probe }) => probe);
}

export {
  DEFAULT_PROCESS_OUTPUT_BYTES_PER_STREAM,
  DEFAULT_PROBE_OUTPUT_BYTES_PER_STREAM,
  ProcessOutputLimitError,
  runProcess,
  type ProcessCaptureMetadata,
  type ProcessOutputOverflow,
  type ProcessResult,
  type ProcessStreamCapture,
  type RunProcessOptions,
} from "./process.ts";
