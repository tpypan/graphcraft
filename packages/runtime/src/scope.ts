import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import {
  contentHash,
  type CanonicalHashAlgorithm,
  type Graph,
  type GraphNode,
  type RunContract,
  type RunState,
} from "@graphcraft/core";
import { runProcess } from "@graphcraft/probes";

export interface WorkspaceScopeSnapshot {
  schemaVersion: 1;
  digest: string;
  headSha: string;
  branch: string;
  indexDigest: string;
  changed: Record<string, string>;
}

export type ScopeViolationKind =
  | "contract_not_included"
  | "contract_excluded"
  | "node_scope"
  | "unowned_change"
  | "read_only_write"
  | "git_head"
  | "git_branch"
  | "git_index";

export interface ScopeViolation {
  kind: ScopeViolationKind;
  path?: string;
  detail: string;
}

export interface WorkspaceScopeAudit {
  schemaVersion: 1;
  nodeId: string;
  allowed: boolean;
  changedPaths: string[];
  touchedPaths: string[];
  reportedChangedPaths: string[];
  violations: ScopeViolation[];
  baselineDigest: string;
  currentDigest: string;
}

const maximumChangedPaths = 10_000;

async function gitOutput(
  repositoryPath: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const result = await runProcess("git", args, {
    cwd: repositoryPath,
    timeoutMs: 120_000,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
  return result.stdout;
}

function nulPaths(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function confinedPath(repositoryPath: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Git reported an absolute workspace path: ${path}`);
  const absolute = resolve(repositoryPath, path);
  const confined = relative(repositoryPath, absolute);
  if (confined === ".." || confined.startsWith(`..${sep}`) || isAbsolute(confined))
    throw new Error(`Git reported a path outside the workspace: ${path}`);
  return absolute;
}

async function fileDigest(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, signal ? { signal } : undefined)) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  signal?.throwIfAborted();
  return hash.digest("hex");
}

async function pathSignature(
  repositoryPath: string,
  path: string,
  hashAlgorithm: CanonicalHashAlgorithm,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const absolute = confinedPath(repositoryPath, path);
  let status;
  try {
    status = await lstat(absolute);
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  signal?.throwIfAborted();
  const mode = status.mode & 0o777;
  if (status.isSymbolicLink()) {
    const target = await readlink(absolute);
    signal?.throwIfAborted();
    return contentHash({ kind: "symlink", mode, target }, hashAlgorithm);
  }
  if (status.isFile())
    return contentHash(
      {
        kind: "file",
        mode,
        size: status.size,
        digest: await fileDigest(absolute, signal),
      },
      hashAlgorithm,
    );
  if (status.isDirectory()) {
    const operations = [
      gitOutput(absolute, ["rev-parse", "HEAD"], signal).catch(() => {
        signal?.throwIfAborted();
        return "not-a-repository";
      }),
      gitOutput(
        absolute,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        signal,
      ).catch(() => {
        signal?.throwIfAborted();
        return "unavailable";
      }),
    ] as const;
    let head: string;
    let state: string;
    try {
      [head, state] = await Promise.all(operations);
    } catch (error) {
      if (signal?.aborted) await Promise.allSettled(operations);
      throw error;
    }
    signal?.throwIfAborted();
    return contentHash({ kind: "directory", mode, head: head.trim(), state }, hashAlgorithm);
  }
  return contentHash({ kind: "other", mode, size: status.size }, hashAlgorithm);
}

export async function captureWorkspaceScopeSnapshot(
  repositoryPath: string,
  inspectedIgnoredPatterns: string[],
  signal: AbortSignal | undefined,
  hashAlgorithm: CanonicalHashAlgorithm,
): Promise<WorkspaceScopeSnapshot> {
  signal?.throwIfAborted();
  const ignored =
    inspectedIgnoredPatterns.length > 0
      ? gitOutput(
          repositoryPath,
          [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
            "--",
            ...inspectedIgnoredPatterns,
          ],
          signal,
        )
      : Promise.resolve("");
  const operations = [
    gitOutput(repositoryPath, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"], signal),
    gitOutput(repositoryPath, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
    ignored,
    gitOutput(repositoryPath, ["rev-parse", "HEAD"], signal),
    gitOutput(repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal).catch(() => {
      signal?.throwIfAborted();
      return "(detached)";
    }),
    gitOutput(
      repositoryPath,
      ["diff", "--cached", "--no-ext-diff", "--binary", "HEAD", "--"],
      signal,
    ),
  ] as const;
  let tracked: string;
  let untracked: string;
  let excludedIgnored: string;
  let head: string;
  let branch: string;
  let index: string;
  try {
    [tracked, untracked, excludedIgnored, head, branch, index] = await Promise.all(operations);
  } catch (error) {
    if (signal?.aborted) await Promise.allSettled(operations);
    throw error;
  }
  signal?.throwIfAborted();
  const paths = [
    ...new Set([...nulPaths(tracked), ...nulPaths(untracked), ...nulPaths(excludedIgnored)]),
  ].sort();
  if (paths.length > maximumChangedPaths)
    throw new Error(
      `Workspace scope inspection refused ${paths.length} changed paths; maximum is ${maximumChangedPaths}`,
    );
  const changed: Record<string, string> = {};
  for (const path of paths) {
    signal?.throwIfAborted();
    changed[path.replaceAll("\\", "/")] = await pathSignature(
      repositoryPath,
      path,
      hashAlgorithm,
      signal,
    );
  }
  signal?.throwIfAborted();
  const core = {
    headSha: head.trim(),
    branch: branch.trim(),
    indexDigest: contentHash(index, hashAlgorithm),
    changed,
  };
  return { schemaVersion: 1, digest: contentHash(core, hashAlgorithm), ...core };
}

export function workspaceScopeSnapshotDigestIsValid(
  snapshot: WorkspaceScopeSnapshot,
  hashAlgorithm: CanonicalHashAlgorithm,
): boolean {
  return (
    snapshot.digest ===
    contentHash(
      {
        headSha: snapshot.headSha,
        branch: snapshot.branch,
        indexDigest: snapshot.indexDigest,
        changed: snapshot.changed,
      },
      hashAlgorithm,
    )
  );
}

export function parseWorkspaceScopeSnapshot(
  value: unknown,
  hashAlgorithm?: CanonicalHashAlgorithm,
): WorkspaceScopeSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Partial<WorkspaceScopeSnapshot>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.digest !== "string" ||
    typeof candidate.headSha !== "string" ||
    typeof candidate.branch !== "string" ||
    typeof candidate.indexDigest !== "string" ||
    typeof candidate.changed !== "object" ||
    candidate.changed === null ||
    Array.isArray(candidate.changed) ||
    Object.entries(candidate.changed).some(
      ([path, signature]) => path.length === 0 || typeof signature !== "string",
    )
  )
    return undefined;
  const snapshot = candidate as WorkspaceScopeSnapshot;
  if (hashAlgorithm && !workspaceScopeSnapshotDigestIsValid(snapshot, hashAlgorithm))
    return undefined;
  return snapshot;
}

function normalizedPattern(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function pathMatchesScope(path: string, patterns: string[]): boolean {
  const normalizedPath = normalizedPattern(path);
  return patterns.some((value) => {
    const pattern = normalizedPattern(value);
    if (pattern === "**" || pattern === "**/*") return true;
    if (normalizedPath === pattern) return true;
    if (pattern.endsWith("/**") && normalizedPath === pattern.slice(0, -3).replace(/\/$/, ""))
      return true;
    return matchesGlob(normalizedPath, pattern);
  });
}

function acceptedWriteScopes(graph: Graph, state: RunState): string[] {
  return graph.nodes
    .filter(
      (candidate) =>
        candidate.sideEffectClass === "workspace_write" &&
        state.nodes[candidate.id]?.status === "accepted",
    )
    .flatMap(({ scope }) => scope);
}

export function auditWorkspaceScope(input: {
  contract: RunContract;
  graph: Graph;
  state: RunState;
  node: GraphNode;
  baseline: WorkspaceScopeSnapshot;
  current: WorkspaceScopeSnapshot;
  reportedChangedPaths?: string[];
}): WorkspaceScopeAudit {
  const currentPaths = Object.keys(input.current.changed).sort();
  const touchedPaths = [...new Set([...Object.keys(input.baseline.changed), ...currentPaths])]
    .filter((path) => input.baseline.changed[path] !== input.current.changed[path])
    .sort();
  const candidatePaths = [...new Set([...currentPaths, ...touchedPaths])].sort();
  const priorScopes = acceptedWriteScopes(input.graph, input.state);
  const violations: ScopeViolation[] = [];
  for (const path of candidatePaths) {
    if (!pathMatchesScope(path, input.contract.scope.include))
      violations.push({
        kind: "contract_not_included",
        path,
        detail: `${path} is outside contract include scope ${input.contract.scope.include.join(", ")}`,
      });
    if (pathMatchesScope(path, input.contract.scope.exclude))
      violations.push({
        kind: "contract_excluded",
        path,
        detail: `${path} matches contract exclude scope ${input.contract.scope.exclude.join(", ")}`,
      });
  }
  for (const path of touchedPaths) {
    if (input.node.sideEffectClass === "none")
      violations.push({
        kind: "read_only_write",
        path,
        detail: `${path} changed during read-only node ${input.node.id}`,
      });
    else if (!pathMatchesScope(path, input.node.scope))
      violations.push({
        kind: "node_scope",
        path,
        detail: `${path} changed outside node ${input.node.id} scope ${input.node.scope.join(", ")}`,
      });
  }
  for (const path of currentPaths)
    if (!pathMatchesScope(path, input.node.scope) && !pathMatchesScope(path, priorScopes))
      violations.push({
        kind: "unowned_change",
        path,
        detail: `${path} is not owned by ${input.node.id} or an accepted write node`,
      });
  if (input.baseline.headSha !== input.current.headSha)
    violations.push({
      kind: "git_head",
      detail: `HEAD changed from ${input.baseline.headSha} to ${input.current.headSha} outside a commit node`,
    });
  if (input.baseline.branch !== input.current.branch)
    violations.push({
      kind: "git_branch",
      detail: `branch changed from ${input.baseline.branch} to ${input.current.branch} outside a runtime boundary`,
    });
  if (input.baseline.indexDigest !== input.current.indexDigest)
    violations.push({
      kind: "git_index",
      detail: "the Git index changed outside a runtime-owned commit boundary",
    });
  const uniqueViolations = violations.filter(
    (violation, index) =>
      violations.findIndex(
        (candidate) =>
          candidate.kind === violation.kind &&
          candidate.path === violation.path &&
          candidate.detail === violation.detail,
      ) === index,
  );
  return {
    schemaVersion: 1,
    nodeId: input.node.id,
    allowed: uniqueViolations.length === 0,
    changedPaths: currentPaths,
    touchedPaths,
    reportedChangedPaths: [...new Set(input.reportedChangedPaths ?? [])].sort(),
    violations: uniqueViolations,
    baselineDigest: input.baseline.digest,
    currentDigest: input.current.digest,
  };
}

export function scopeViolationReason(audit: WorkspaceScopeAudit, workspacePath: string): string {
  const evidence = audit.violations
    .slice(0, 12)
    .map(({ detail }) => detail)
    .join("; ");
  const omitted = audit.violations.length > 12 ? `; ${audit.violations.length - 12} more` : "";
  return `Scope policy rejected node ${audit.nodeId}: ${evidence}${omitted}. Changes were preserved in the isolated workspace at ${workspacePath}`;
}
