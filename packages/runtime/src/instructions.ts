import {
  MAX_REPOSITORY_INSTRUCTION_BYTES,
  MAX_REPOSITORY_INSTRUCTION_FILES,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  RepositoryInstructionManifestSchema,
  contentHash,
  repositoryInstructionSelectionDigest,
  validateRepositoryInstructionSelection,
  type GraphNode,
  type RepositoryInstructionEntry,
  type RepositoryInstructionManifest,
  type RepositoryInstructionSelection,
  type RepositoryInstructionSource,
} from "@graphcraft/core";
import { readRepositoryFile, runProcess } from "@graphcraft/probes";
import { createHash } from "node:crypto";
import { lstat, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { assertPersistenceSafe } from "./redaction.ts";
import { pathMatchesScope } from "./scope.ts";

interface TrackedInstructionPath {
  gitMode: "100644" | "100755" | "120000";
  objectId: string;
  path: string;
}

interface MutableInstructionEntry {
  path: string;
  sources: Set<RepositoryInstructionSource>;
  scopes: Set<string>;
  gitMode: TrackedInstructionPath["gitMode"];
  workingKind: "file" | "symlink";
  workingMode: number;
  linkTarget?: string;
  importedBy: Set<string>;
  content: string;
  contentHash: string;
}

const SOURCE_ORDER: RepositoryInstructionSource[] = [
  "agents",
  "claude",
  "claude_local",
  "claude_project",
  "claude_rule",
  "claude_import",
];

// Entries are presented from broad authority to narrower repository guidance. Codex contributes
// the one active AGENTS file per directory; Claude shared memory precedes local memory and scoped
// rules at the same directory depth. Imports are inserted depth-first immediately after their
// importer in source order. Paths are only a final deterministic tie-breaker.
const PRIMARY_SOURCE_PRECEDENCE: Record<
  Exclude<RepositoryInstructionSource, "claude_import">,
  number
> = {
  agents: 0,
  claude: 1,
  claude_project: 1,
  claude_local: 2,
  claude_rule: 3,
};

function portableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRepositoryPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("Git returned an unsafe repository-instruction path");
  return normalized;
}

function normalizedScope(value: string, prefix = ""): string {
  let normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  )
    throw new Error("A repository-instruction rule declared an unsafe path scope");
  normalized = normalized.replace(/\/$/u, "/**");
  return prefix ? `${prefix}/${normalized}` : normalized;
}

function directoryScope(directory: string): string {
  return directory === "." || directory.length === 0 ? "**/*" : `${directory}/**`;
}

function claudeRulesIndex(parts: string[]): number | undefined {
  for (let index = parts.length - 2; index > 0; index -= 1)
    if (parts[index] === "rules" && parts[index - 1] === ".claude") return index;
  return undefined;
}

function primarySource(path: string): RepositoryInstructionSource | undefined {
  const parts = path.split("/");
  const name = parts.at(-1);
  const ruleIndex = claudeRulesIndex(parts);
  if (name?.endsWith(".md") && ruleIndex !== undefined) return "claude_rule";
  if (name === "AGENTS.md" || name === "AGENTS.override.md") return "agents";
  if (name === "CLAUDE.local.md") return "claude_local";
  if (name === "CLAUDE.md") return parts.at(-2) === ".claude" ? "claude_project" : "claude";
  return undefined;
}

function projectDirectory(path: string, source: RepositoryInstructionSource): string {
  const parts = path.split("/");
  if (source === "claude_project") return parts.slice(0, -2).join("/");
  if (source === "claude_rule") {
    const ruleIndex = claudeRulesIndex(parts);
    if (ruleIndex === undefined)
      throw new Error("A Claude rule path does not live below a .claude/rules directory");
    return parts.slice(0, ruleIndex - 1).join("/");
  }
  const directory = posix.dirname(path);
  return directory === "." ? "" : directory;
}

function stripYamlComment(value: string): string {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && character === "\\") {
      index += 1;
      continue;
    }
    if (quote === "'" && character === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? undefined : (quote ?? character);
      continue;
    }
    if (character === "#" && !quote && (index === 0 || /\s/u.test(value[index - 1]!)))
      return value.slice(0, index);
  }
  return value;
}

function assertSupportedYamlPathScalar(value: string): void {
  const trimmed = stripYamlComment(value).trim();
  if (
    trimmed.length > 0 &&
    !trimmed.startsWith('"') &&
    !trimmed.startsWith("'") &&
    (/^[&*!|>{}\[\]?]/u.test(trimmed) || /^-\s/u.test(trimmed) || /:\s/u.test(trimmed))
  )
    throw new Error("A repository-instruction rule uses unsupported YAML path frontmatter");
}

function unquoteYamlScalar(value: string): string {
  const trimmed = stripYamlComment(value).trim();
  assertSupportedYamlPathScalar(trimmed);
  if (trimmed.startsWith('"') || trimmed.endsWith('"')) {
    if (!(trimmed.startsWith('"') && trimmed.endsWith('"')))
      throw new Error("A repository-instruction rule has malformed quoted path frontmatter");
    try {
      const decoded = JSON.parse(trimmed) as unknown;
      if (typeof decoded !== "string") throw new Error("not a scalar");
      return decoded;
    } catch {
      throw new Error("A repository-instruction rule has malformed quoted path frontmatter");
    }
  }
  if (trimmed.startsWith("'") || trimmed.endsWith("'")) {
    if (!(trimmed.startsWith("'") && trimmed.endsWith("'")))
      throw new Error("A repository-instruction rule has malformed quoted path frontmatter");
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function inlinePathScopes(value: string): string[] {
  const trimmed = stripYamlComment(value).trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [unquoteYamlScalar(trimmed)];
  const body = trimmed.slice(1, -1);
  const values: string[] = [];
  let quote: "'" | '"' | undefined;
  let start = 0;
  for (let index = 0; index <= body.length; index += 1) {
    const character = body[index];
    if (quote === '"' && character === "\\") {
      index += 1;
      continue;
    }
    if (quote === "'" && character === "'" && body[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'")
      quote = quote === character ? undefined : (quote ?? character);
    if ((character === "," && !quote) || index === body.length) {
      const item = unquoteYamlScalar(body.slice(start, index));
      if (item) values.push(item);
      start = index + 1;
    }
  }
  if (quote) throw new Error("A repository-instruction rule has malformed path frontmatter");
  return values;
}

function flowSequenceDepth(value: string): number {
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && character === "\\") {
      index += 1;
      continue;
    }
    if (quote === "'" && character === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? undefined : (quote ?? character);
      continue;
    }
    if (!quote && character === "[") depth += 1;
    if (!quote && character === "]") depth -= 1;
    if (depth < 0) throw new Error("A repository-instruction rule has malformed path frontmatter");
  }
  return depth;
}

function ruleScopes(path: string, content: string): string[] {
  const lines = content.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return [directoryScope(projectDirectory(path, "claude_rule"))];
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (end === -1) return [directoryScope(projectDirectory(path, "claude_rule"))];
  const frontmatter = lines.slice(1, end + 1);
  const pathsLine = frontmatter.findIndex((line) => /^paths\s*:/u.test(line));
  if (pathsLine === -1) return [directoryScope(projectDirectory(path, "claude_rule"))];
  const rawRemainder = frontmatter[pathsLine]!.replace(/^paths\s*:/u, "");
  let remainder = stripYamlComment(rawRemainder).trim();
  if (remainder.startsWith("[")) {
    for (
      let index = pathsLine + 1;
      flowSequenceDepth(remainder) > 0 && index < frontmatter.length;
      index += 1
    )
      remainder += ` ${stripYamlComment(frontmatter[index]!).trim()}`;
    if (flowSequenceDepth(remainder) !== 0 || !remainder.endsWith("]"))
      throw new Error("A repository-instruction rule has malformed path frontmatter");
  }
  const declared = remainder ? inlinePathScopes(remainder) : [];
  if (!remainder)
    for (const line of frontmatter.slice(pathsLine + 1)) {
      if (stripYamlComment(line).trim().length === 0) continue;
      if (/^[A-Za-z0-9_-]+\s*:/u.test(line)) break;
      const item = line.match(/^\s*-\s*(.+?)\s*$/u)?.[1];
      if (item) declared.push(unquoteYamlScalar(item));
      else throw new Error("A repository-instruction rule has malformed path frontmatter");
    }
  if (declared.length === 0) return [directoryScope(projectDirectory(path, "claude_rule"))];
  if (declared.length > 32)
    throw new Error("A repository-instruction rule exceeds the 32-scope limit");
  const prefix = projectDirectory(path, "claude_rule");
  return [...new Set(declared.map((scope) => normalizedScope(scope, prefix)))].sort(
    portableCompare,
  );
}

function primaryScopes(
  path: string,
  source: RepositoryInstructionSource,
  content: string,
): string[] {
  if (source === "claude_rule") return ruleScopes(path, content);
  return [directoryScope(projectDirectory(path, source))];
}

function backtickRunLength(value: string, start: number): number {
  let length = 0;
  while (value[start + length] === "`") length += 1;
  return length;
}

function hasClosingBacktickRun(
  lines: string[],
  lineIndex: number,
  start: number,
  expectedLength: number,
): boolean {
  for (let candidateLine = lineIndex; candidateLine < lines.length; candidateLine += 1) {
    const line = lines[candidateLine]!;
    for (let index = candidateLine === lineIndex ? start : 0; index < line.length; index += 1) {
      if (line[index] !== "`") continue;
      const length = backtickRunLength(line, index);
      if (length === expectedLength) return true;
      index += length - 1;
    }
  }
  return false;
}

function fenceCandidate(
  line: string,
): { character: "`" | "~"; length: number; remainder: string } | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  const marker = match?.[1];
  if (!marker) return undefined;
  return {
    character: marker[0] as "`" | "~",
    length: marker.length,
    remainder: match[2] ?? "",
  };
}

function claudeImports(content: string): string[] {
  const imports: string[] = [];
  const lines = content.split(/\r?\n/u);
  let fence: { character: "`" | "~"; length: number } | undefined;
  let inlineCodeLength: number | undefined;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const candidate = fenceCandidate(line);
    if (fence) {
      if (
        candidate?.character === fence.character &&
        candidate.length >= fence.length &&
        candidate.remainder.trim().length === 0
      )
        fence = undefined;
      continue;
    }
    if (
      inlineCodeLength === undefined &&
      candidate &&
      !(candidate.character === "`" && candidate.remainder.includes("`"))
    ) {
      fence = { character: candidate.character, length: candidate.length };
      continue;
    }
    if (inlineCodeLength === undefined && /^(?: {4,}|\t)/u.test(line)) continue;
    let visible = "";
    for (let index = 0; index < line.length;) {
      if (line[index] !== "`") {
        if (inlineCodeLength === undefined) visible += line[index];
        index += 1;
        continue;
      }
      const runLength = backtickRunLength(line, index);
      const marker = "`".repeat(runLength);
      if (inlineCodeLength !== undefined) {
        if (runLength === inlineCodeLength) inlineCodeLength = undefined;
        index += runLength;
        continue;
      }
      if (!hasClosingBacktickRun(lines, lineIndex, index + runLength, runLength)) {
        visible += marker;
        index += runLength;
        continue;
      }
      inlineCodeLength = runLength;
      visible += " ".repeat(runLength);
      index += runLength;
    }
    for (const match of visible.matchAll(/(^|[^A-Za-z0-9_.@/\\-])@([^\s`"'<>()[\]{}]+)/gu)) {
      const reference = match[2]?.replace(/[.,;:!?]+$/u, "");
      if (reference) imports.push(reference);
    }
  }
  return imports;
}

function resolveImportPath(importer: string, reference: string): string {
  if (
    isAbsolute(reference) ||
    reference.startsWith("~") ||
    /^[A-Za-z]:[\\/]/u.test(reference) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(reference)
  )
    throw new Error(`Repository instruction ${importer} declares an external import`);
  const joined = posix.normalize(
    posix.join(posix.dirname(importer), reference.replaceAll("\\", "/")),
  );
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/"))
    throw new Error(`Repository instruction ${importer} declares an escaping import`);
  return normalizedRepositoryPath(joined);
}

async function gitOutput(
  repositoryPath: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const result = await runProcess("git", args, {
    cwd: repositoryPath,
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
  return result.stdout;
}

async function trackedInstructionPaths(
  repositoryPath: string,
  signal?: AbortSignal,
  baseSha?: string,
): Promise<Map<string, TrackedInstructionPath>> {
  const output = await gitOutput(
    repositoryPath,
    baseSha
      ? ["ls-tree", "-r", "-z", "--full-tree", baseSha]
      : ["ls-files", "--cached", "--stage", "-z"],
    signal,
  );
  const tracked = new Map<string, TrackedInstructionPath>();
  for (const record of output.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    const metadata = separator === -1 ? [] : record.slice(0, separator).split(" ");
    const path = separator === -1 ? "" : normalizedRepositoryPath(record.slice(separator + 1));
    const mode = metadata[0];
    const objectId = metadata[1] === "blob" ? metadata[2] : metadata[1];
    const stage = baseSha ? undefined : metadata[2];
    if (
      !mode ||
      !objectId ||
      !/^[a-f0-9]{40,64}$/u.test(objectId) ||
      !path ||
      (!baseSha && stage !== "0")
    )
      throw new Error("Git returned an unmerged repository-instruction inventory");
    if (tracked.has(path)) throw new Error("Git returned duplicate tracked-path identities");
    if (mode === "100644" || mode === "100755" || mode === "120000")
      tracked.set(path, { path, gitMode: mode, objectId });
  }
  return tracked;
}

async function readTrackedBlob(input: {
  repositoryPath: string;
  tracked: TrackedInstructionPath;
  maximumBytes: number;
  signal?: AbortSignal;
}): Promise<string> {
  input.signal?.throwIfAborted();
  const result = await runProcess("git", ["cat-file", "blob", input.tracked.objectId], {
    cwd: input.repositoryPath,
    timeoutMs: 30_000,
    maxOutputBytesPerStream: input.maximumBytes,
    outputOverflow: "reject",
    ...(input.signal ? { signal: input.signal } : {}),
  });
  input.signal?.throwIfAborted();
  if (result.exitCode !== 0) throw new Error("Git could not read a repository-instruction object");
  if (result.capture.stdout.truncated)
    throw new Error("Repository instructions must contain valid UTF-8 text");
  const bytes = Buffer.from(result.stdout, "utf8");
  const algorithm = input.tracked.objectId.length === 64 ? "sha256" : "sha1";
  const observedObjectId = createHash(algorithm)
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");
  if (observedObjectId !== input.tracked.objectId)
    throw new Error("Repository instructions must contain valid UTF-8 text");
  return result.stdout;
}

function decodeInstructionText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Repository instructions must contain valid UTF-8 text");
  }
}

function trackedLinkDestination(path: string, linkTarget: string): string {
  if (
    linkTarget.length === 0 ||
    linkTarget.includes("\0") ||
    isAbsolute(linkTarget) ||
    /^[A-Za-z]:[\\/]/u.test(linkTarget)
  )
    throw new Error(`Tracked repository instruction ${path} resolves outside the repository`);
  const joined = posix.normalize(posix.join(posix.dirname(path), linkTarget.replaceAll("\\", "/")));
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/"))
    throw new Error(`Tracked repository instruction ${path} resolves outside the repository`);
  return normalizedRepositoryPath(joined);
}

async function resolveTrackedBlobTarget(input: {
  repositoryPath: string;
  tracked: Map<string, TrackedInstructionPath>;
  path: string;
  signal?: AbortSignal;
}): Promise<{ linkTarget?: string; target: TrackedInstructionPath }> {
  let path = input.path;
  let firstLinkTarget: string | undefined;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(path))
      throw new Error(`Tracked repository instruction ${input.path} contains a symlink cycle`);
    visited.add(path);
    const tracked = input.tracked.get(path);
    if (!tracked)
      throw new Error(`Tracked repository instruction ${input.path} resolves to untracked content`);
    if (tracked.gitMode !== "120000")
      return { target: tracked, ...(firstLinkTarget ? { linkTarget: firstLinkTarget } : {}) };
    if (firstLinkTarget !== undefined)
      throw new Error(
        `Tracked repository instruction ${input.path} uses an unsupported multi-hop symlink chain`,
      );
    const linkTarget = await readTrackedBlob({
      repositoryPath: input.repositoryPath,
      tracked,
      maximumBytes: 4_097,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (Buffer.byteLength(linkTarget) > 4_096)
      throw new Error(`Tracked repository instruction ${input.path} has an oversized link target`);
    firstLinkTarget ??= linkTarget;
    path = trackedLinkDestination(path, linkTarget);
  }
}

async function readInstructionEntry(input: {
  repositoryPath: string;
  repositoryRealPath: string;
  tracked: Map<string, TrackedInstructionPath>;
  path: string;
  readFromGitObjects?: boolean;
  signal?: AbortSignal;
}): Promise<Omit<MutableInstructionEntry, "sources" | "scopes" | "importedBy">> {
  const tracked = input.tracked.get(input.path);
  if (!tracked)
    throw new Error("A repository instruction references a missing or untracked import");
  input.signal?.throwIfAborted();
  if (input.readFromGitObjects) {
    const resolved = await resolveTrackedBlobTarget({
      repositoryPath: input.repositoryPath,
      tracked: input.tracked,
      path: input.path,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const rawContent = await readTrackedBlob({
      repositoryPath: input.repositoryPath,
      tracked: resolved.target,
      maximumBytes: MAX_REPOSITORY_INSTRUCTION_BYTES + 1,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      path: input.path,
      gitMode: tracked.gitMode,
      workingKind: tracked.gitMode === "120000" ? "symlink" : "file",
      workingMode: tracked.gitMode === "100755" ? 0o111 : 0,
      ...(resolved.linkTarget ? { linkTarget: resolved.linkTarget } : {}),
      content: rawContent,
      contentHash: contentHash(rawContent, PORTABLE_CANONICAL_HASH_ALGORITHM),
    };
  }
  const absolute = join(input.repositoryPath, ...input.path.split("/"));
  const details = await lstat(absolute);
  input.signal?.throwIfAborted();
  const workingKind = details.isSymbolicLink() ? "symlink" : details.isFile() ? "file" : undefined;
  if (!workingKind)
    throw new Error(`Tracked repository instruction ${input.path} is not a regular file`);
  if ((tracked.gitMode === "120000") !== (workingKind === "symlink"))
    throw new Error(`Tracked repository instruction ${input.path} changed file kind`);
  let linkTarget: string | undefined;
  if (workingKind === "symlink") {
    linkTarget = await readlink(absolute);
    const directTarget = trackedLinkDestination(input.path, linkTarget);
    const directTrackedTarget = input.tracked.get(directTarget);
    if (!directTrackedTarget)
      throw new Error(`Tracked repository instruction ${input.path} resolves to untracked content`);
    if (directTrackedTarget.gitMode === "120000")
      throw new Error(
        `Tracked repository instruction ${input.path} uses an unsupported multi-hop symlink chain`,
      );
    const target = await realpath(absolute);
    const confined = relative(input.repositoryRealPath, target);
    if (confined === ".." || confined.startsWith(`..${sep}`) || isAbsolute(confined))
      throw new Error(
        `Tracked repository instruction ${input.path} resolves outside the repository`,
      );
    const trackedTarget = confined.split(sep).join("/");
    if (trackedTarget !== directTarget)
      throw new Error(
        `Tracked repository instruction ${input.path} uses an unsupported multi-hop symlink chain`,
      );
  }
  const rawContent = decodeInstructionText(
    await readRepositoryFile(input.repositoryPath, input.path, {
      maximumBytes: MAX_REPOSITORY_INSTRUCTION_BYTES + 1,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  );
  return {
    path: input.path,
    gitMode: tracked.gitMode,
    workingKind,
    workingMode:
      workingKind !== "file"
        ? 0
        : process.platform === "win32"
          ? tracked.gitMode === "100755"
            ? 0o111
            : 0
          : (details.mode & 0o111) !== 0
            ? 0o111
            : 0,
    ...(linkTarget ? { linkTarget } : {}),
    content: rawContent,
    contentHash: contentHash(rawContent, PORTABLE_CANONICAL_HASH_ALGORITHM),
  };
}

function entryIdentity(
  entry: RepositoryInstructionEntry,
): Omit<RepositoryInstructionEntry, "content"> {
  const { content: _content, ...identity } = entry;
  return identity;
}

export function repositoryInstructionManifestDigest(
  manifest: Omit<RepositoryInstructionManifest, "digest">,
): string {
  for (const entry of manifest.entries)
    if (contentHash(entry.content, PORTABLE_CANONICAL_HASH_ALGORITHM) !== entry.contentHash)
      throw new Error(`Repository instruction ${entry.path} has an invalid content hash`);
  return contentHash(
    {
      schemaVersion: manifest.schemaVersion,
      policy: manifest.policy,
      entries: manifest.entries.map(entryIdentity),
      coverage: manifest.coverage,
    },
    PORTABLE_CANONICAL_HASH_ALGORITHM,
  );
}

export async function resolveRepositoryInstructionManifest(input: {
  repositoryPath: string;
  baseSha?: string;
  indexOnly?: boolean;
  signal?: AbortSignal;
}): Promise<RepositoryInstructionManifest> {
  if (input.baseSha && input.indexOnly)
    throw new Error("Repository instructions cannot resolve a base tree and index together");
  const tracked = await trackedInstructionPaths(input.repositoryPath, input.signal, input.baseSha);
  const repositoryRealPath = await realpath(input.repositoryPath);
  const primaryCandidates = [...tracked.keys()]
    .map((path) => ({ path, source: primarySource(path) }))
    .filter(
      (entry): entry is { path: string; source: RepositoryInstructionSource } =>
        entry.source !== undefined,
    )
    .sort((left, right) => portableCompare(left.path, right.path));
  const entryValues = new Map<
    string,
    Omit<MutableInstructionEntry, "sources" | "scopes" | "importedBy">
  >();
  const entries = new Map<string, MutableInstructionEntry>();
  const queued: string[] = [];
  const processedBindings = new Map<string, string>();
  const importDepths = new Map<string, number>();
  const importEdges = new Map<string, string[]>();

  const loadEntryValue = async (
    path: string,
  ): Promise<Omit<MutableInstructionEntry, "sources" | "scopes" | "importedBy">> => {
    const existing = entryValues.get(path);
    if (existing) return existing;
    const value = await readInstructionEntry({
      repositoryPath: input.repositoryPath,
      repositoryRealPath,
      tracked,
      path,
      readFromGitObjects: input.baseSha !== undefined || input.indexOnly === true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    entryValues.set(path, value);
    return value;
  };

  const ensureEntry = async (path: string): Promise<MutableInstructionEntry> => {
    const existing = entries.get(path);
    if (existing) return existing;
    if (entries.size >= MAX_REPOSITORY_INSTRUCTION_FILES)
      throw new Error(
        `Repository instructions exceed the ${MAX_REPOSITORY_INSTRUCTION_FILES}-file limit`,
      );
    const value = await loadEntryValue(path);
    assertPersistenceSafe(value.content, `Repository instruction ${path}`);
    const entry: MutableInstructionEntry = {
      ...value,
      sources: new Set(),
      scopes: new Set(),
      importedBy: new Set(),
    };
    entries.set(path, entry);
    queued.push(path);
    return entry;
  };

  const primary: Array<{ path: string; source: RepositoryInstructionSource }> =
    primaryCandidates.filter(({ source }) => source !== "agents");
  const agentCandidates = new Map<string, Map<string, string>>();
  for (const { path, source } of primaryCandidates) {
    if (source !== "agents") continue;
    const directory = posix.dirname(path);
    const names = agentCandidates.get(directory) ?? new Map<string, string>();
    names.set(posix.basename(path), path);
    agentCandidates.set(directory, names);
  }
  for (const names of [...agentCandidates.values()]) {
    for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
      const path = names.get(name);
      if (!path) continue;
      const value = await loadEntryValue(path);
      if (value.content.trim().length === 0) continue;
      primary.push({ path, source: "agents" });
      break;
    }
  }
  primary.sort((left, right) => portableCompare(left.path, right.path));

  for (const { path, source } of primary) {
    const entry = await ensureEntry(path);
    importDepths.set(path, 0);
    entry.sources.add(source);
    for (const scope of primaryScopes(path, source, entry.content)) entry.scopes.add(scope);
  }

  for (let index = 0; index < queued.length; index += 1) {
    input.signal?.throwIfAborted();
    const importerPath = queued[index]!;
    const importer = entries.get(importerPath)!;
    const binding = JSON.stringify({
      sources: [...importer.sources].sort(portableCompare),
      scopes: [...importer.scopes].sort(portableCompare),
      importDepth: importDepths.get(importerPath) ?? 0,
    });
    if (processedBindings.get(importerPath) === binding) continue;
    processedBindings.set(importerPath, binding);
    if (
      ![...importer.sources].some((source) => source !== "agents") &&
      !importer.sources.has("claude_import")
    )
      continue;
    const references = claudeImports(importer.content);
    const importerDepth = importDepths.get(importerPath) ?? 0;
    if (references.length > 0 && importerDepth >= 4)
      throw new Error(
        `Repository instruction ${importerPath} exceeds the four-hop Claude import limit`,
      );
    const orderedImports: string[] = [];
    for (const reference of references) {
      const importedPath = resolveImportPath(importerPath, reference);
      if (!orderedImports.includes(importedPath)) orderedImports.push(importedPath);
      const imported = await ensureEntry(importedPath);
      const beforeSources = imported.sources.size;
      const beforeScopes = imported.scopes.size;
      const previousDepth = importDepths.get(importedPath);
      const importedDepth = importerDepth + 1;
      if (previousDepth === undefined || importedDepth < previousDepth)
        importDepths.set(importedPath, importedDepth);
      imported.sources.add("claude_import");
      imported.importedBy.add(importerPath);
      for (const scope of importer.scopes) imported.scopes.add(scope);
      if (
        imported.sources.size !== beforeSources ||
        imported.scopes.size !== beforeScopes ||
        previousDepth === undefined ||
        importedDepth < previousDepth
      )
        queued.push(importedPath);
    }
    importEdges.set(importerPath, orderedImports);
  }

  const scopeDepth = (entry: MutableInstructionEntry): number =>
    Math.min(
      ...[...entry.scopes].map(
        (scope) => staticScopePrefix(scope).split("/").filter(Boolean).length,
      ),
    );
  const primaryByPath = new Map(primary.map((item) => [item.path, item.source]));
  const primaryAuthority = (path: string): [number, number] => {
    const entry = entries.get(path)!;
    const source = primaryByPath.get(path)! as Exclude<
      RepositoryInstructionSource,
      "claude_import"
    >;
    return [scopeDepth(entry), PRIMARY_SOURCE_PRECEDENCE[source]];
  };
  const samePrimaryAuthority = (leftPath: string, rightPath: string): boolean => {
    const left = primaryAuthority(leftPath);
    const right = primaryAuthority(rightPath);
    return left[0] === right[0] && left[1] === right[1];
  };
  const comparePrimaryPaths = (leftPath: string, rightPath: string): number => {
    const left = primaryAuthority(leftPath);
    const right = primaryAuthority(rightPath);
    return left[0] - right[0] || left[1] - right[1] || portableCompare(leftPath, rightPath);
  };
  const orderedValues: MutableInstructionEntry[] = [];
  const orderedPaths = new Set<string>();
  const appendWithImports = (path: string, authorityPath: string): void => {
    if (orderedPaths.has(path)) return;
    const entry = entries.get(path);
    if (!entry) return;
    orderedPaths.add(path);
    orderedValues.push(entry);
    for (const importedPath of importEdges.get(path) ?? []) {
      if (primaryByPath.has(importedPath) && !samePrimaryAuthority(authorityPath, importedPath))
        continue;
      appendWithImports(importedPath, authorityPath);
    }
  };
  const sortedPrimaryPaths = [...primaryByPath.keys()].sort(comparePrimaryPaths);
  for (let start = 0; start < sortedPrimaryPaths.length;) {
    const authorityPath = sortedPrimaryPaths[start]!;
    let end = start + 1;
    while (
      end < sortedPrimaryPaths.length &&
      samePrimaryAuthority(authorityPath, sortedPrimaryPaths[end]!)
    )
      end += 1;
    const authorityPaths = sortedPrimaryPaths.slice(start, end);
    const importedPrimaryPaths = new Set<string>();
    const collectImportedPrimaries = (path: string, visited: Set<string>): void => {
      if (visited.has(path)) return;
      visited.add(path);
      for (const importedPath of importEdges.get(path) ?? []) {
        if (primaryByPath.has(importedPath)) {
          if (samePrimaryAuthority(authorityPath, importedPath)) {
            importedPrimaryPaths.add(importedPath);
            collectImportedPrimaries(importedPath, visited);
          }
          continue;
        }
        collectImportedPrimaries(importedPath, visited);
      }
    };
    for (const path of authorityPaths) collectImportedPrimaries(path, new Set());
    for (const path of authorityPaths)
      if (!importedPrimaryPaths.has(path)) appendWithImports(path, authorityPath);
    for (const path of authorityPaths) appendWithImports(path, authorityPath);
    start = end;
  }
  for (const path of [...entries.keys()]
    .filter((path) => !orderedPaths.has(path))
    .sort(portableCompare))
    appendWithImports(path, path);

  const orderedEntries = orderedValues.map((entry): RepositoryInstructionEntry => ({
    path: entry.path,
    sources: SOURCE_ORDER.filter((source) => entry.sources.has(source)),
    scopes: [...entry.scopes].sort(portableCompare),
    gitMode: entry.gitMode,
    workingKind: entry.workingKind,
    workingMode: entry.workingMode,
    ...(entry.linkTarget ? { linkTarget: entry.linkTarget } : {}),
    importedBy: [...entry.importedBy].sort(portableCompare),
    content: entry.content,
    contentHash: entry.contentHash,
  }));
  const totalBytes = orderedEntries.reduce(
    (total, entry) => total + Buffer.byteLength(entry.content),
    0,
  );
  if (totalBytes > MAX_REPOSITORY_INSTRUCTION_BYTES)
    throw new Error(
      `Repository instructions exceed the ${MAX_REPOSITORY_INSTRUCTION_BYTES}-byte limit`,
    );
  const partial = {
    schemaVersion: 1 as const,
    policy: "tracked-shared-v1" as const,
    entries: orderedEntries,
    coverage: {
      primaryPaths: primary.map(({ path }) => path),
      importedPaths: orderedEntries
        .filter(({ sources }) => sources.includes("claude_import"))
        .map(({ path }) => path),
      untrackedSources: "excluded" as const,
      userAndManagedSources: "excluded" as const,
      externalImports: "rejected" as const,
    },
  };
  return RepositoryInstructionManifestSchema.parse({
    ...partial,
    digest: repositoryInstructionManifestDigest(partial),
  });
}

function staticScopePrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?[{]/u);
  if (wildcard === -1) return pattern;
  const beforeWildcard = pattern.slice(0, wildcard);
  if (beforeWildcard.endsWith("/")) return beforeWildcard.slice(0, -1);
  const separator = beforeWildcard.lastIndexOf("/");
  return separator === -1 ? "" : beforeWildcard.slice(0, separator);
}

function scopesOverlap(left: string, right: string): boolean {
  if ([left, right].some((scope) => scope === "**" || scope === "**/*")) return true;
  const leftPrefix = staticScopePrefix(left);
  const rightPrefix = staticScopePrefix(right);
  const prefixesOverlap =
    leftPrefix.length === 0 ||
    rightPrefix.length === 0 ||
    leftPrefix === rightPrefix ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`);
  if (!prefixesOverlap) return false;
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  if (
    leftSegments.includes("**") ||
    rightSegments.includes("**") ||
    leftSegments.length !== rightSegments.length
  )
    return true;
  return leftSegments.every((leftSegment, index) =>
    segmentPatternsMayOverlap(leftSegment, rightSegments[index]!),
  );
}

function segmentPatternsMayOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const wildcard = /[*?[{]/u;
  const leftHasWildcard = wildcard.test(left);
  const rightHasWildcard = wildcard.test(right);
  try {
    if (!leftHasWildcard) return pathMatchesScope(left, [right]);
    if (!rightHasWildcard) return pathMatchesScope(right, [left]);
  } catch {
    return true;
  }
  const leftPrefix = left.slice(0, left.search(wildcard));
  const rightPrefix = right.slice(0, right.search(wildcard));
  if (
    leftPrefix.length > 0 &&
    rightPrefix.length > 0 &&
    !leftPrefix.startsWith(rightPrefix) &&
    !rightPrefix.startsWith(leftPrefix)
  )
    return false;
  return true;
}

function instructionAppliesToNode(
  entry: RepositoryInstructionEntry,
  node: GraphNode,
  relevantPaths: string[],
): boolean {
  return entry.scopes.some(
    (scope) =>
      relevantPaths.some((path) => pathMatchesScope(path, [scope])) ||
      node.scope.some((nodeScope) => scopesOverlap(scope, nodeScope)),
  );
}

export function selectRepositoryInstructions(input: {
  manifest: RepositoryInstructionManifest;
  node?: GraphNode;
  relevantPaths?: string[];
}): RepositoryInstructionSelection {
  const manifest = RepositoryInstructionManifestSchema.parse(input.manifest);
  if (repositoryInstructionManifestDigest(manifest) !== manifest.digest)
    throw new Error("The pinned repository-instruction manifest digest is invalid");
  const filteredEntries = input.node
    ? manifest.entries.filter((entry) =>
        instructionAppliesToNode(entry, input.node!, input.relevantPaths ?? []),
      )
    : manifest.entries;
  const selectedEntries = input.node
    ? orderSelectedRepositoryInstructions(filteredEntries)
    : filteredEntries;
  const selectedPaths = selectedEntries.map(({ path }) => path);
  const selectedSet = new Set(selectedPaths);
  const omittedPaths = manifest.entries
    .map(({ path }) => path)
    .filter((path) => !selectedSet.has(path));
  return validateRepositoryInstructionSelection({
    schemaVersion: 1,
    policy: "tracked-shared-v1",
    manifestDigest: manifest.digest,
    selectionDigest: repositoryInstructionSelectionDigest({
      manifestDigest: manifest.digest,
      selectedPaths,
      omittedPaths,
    }),
    entries: selectedEntries,
    selectedPaths,
    omittedPaths,
  });
}

function orderSelectedRepositoryInstructions(
  entries: RepositoryInstructionEntry[],
): RepositoryInstructionEntry[] {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const originalIndex = new Map(entries.map((entry, index) => [entry.path, index]));
  const importedByPath = new Map(entries.map((entry) => [entry.path, new Set<string>()]));
  for (const entry of entries) {
    for (const importerPath of entry.importedBy) {
      if (importerPath === entry.path || !entryByPath.has(importerPath)) continue;
      importedByPath.get(importerPath)!.add(entry.path);
    }
  }

  // Collapse cyclic Claude imports into strongly connected components. Ordering the resulting
  // acyclic graph keeps every satisfiable importer-before-import edge while preserving manifest
  // order inside a cycle, where no total ordering can satisfy every edge.
  let nextDepth = 0;
  const depth = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (path: string): void => {
    depth.set(path, nextDepth);
    lowLink.set(path, nextDepth);
    nextDepth += 1;
    stack.push(path);
    onStack.add(path);
    for (const importedPath of importedByPath.get(path) ?? []) {
      if (!depth.has(importedPath)) {
        visit(importedPath);
        lowLink.set(path, Math.min(lowLink.get(path)!, lowLink.get(importedPath)!));
      } else if (onStack.has(importedPath)) {
        lowLink.set(path, Math.min(lowLink.get(path)!, depth.get(importedPath)!));
      }
    }
    if (lowLink.get(path) !== depth.get(path)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === path) break;
    }
    component.sort((left, right) => originalIndex.get(left)! - originalIndex.get(right)!);
    components.push(component);
  };
  for (const entry of entries) if (!depth.has(entry.path)) visit(entry.path);

  const componentByPath = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    for (const path of component) componentByPath.set(path, componentIndex);
  });
  const componentEdges = components.map(() => new Set<number>());
  const inDegree = components.map(() => 0);
  for (const [importerPath, importedPaths] of importedByPath) {
    const importerComponent = componentByPath.get(importerPath)!;
    for (const importedPath of importedPaths) {
      const importedComponent = componentByPath.get(importedPath)!;
      if (
        importedComponent === importerComponent ||
        componentEdges[importerComponent]!.has(importedComponent)
      )
        continue;
      componentEdges[importerComponent]!.add(importedComponent);
      inDegree[importedComponent] = inDegree[importedComponent]! + 1;
    }
  }
  const componentRank = components.map((component) => originalIndex.get(component[0]!)!);
  const ready = components.map((_, index) => index).filter((index) => inDegree[index] === 0);
  const ordered: RepositoryInstructionEntry[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => componentRank[left]! - componentRank[right]!);
    const componentIndex = ready.shift()!;
    ordered.push(...components[componentIndex]!.map((path) => entryByPath.get(path)!));
    for (const importedComponent of componentEdges[componentIndex]!) {
      inDegree[importedComponent] = inDegree[importedComponent]! - 1;
      if (inDegree[importedComponent] === 0) ready.push(importedComponent);
    }
  }
  return ordered;
}

export async function assertRepositoryInstructionManifest(input: {
  expected: RepositoryInstructionManifest;
  repositoryPath: string;
  signal?: AbortSignal;
}): Promise<RepositoryInstructionManifest> {
  const expected = RepositoryInstructionManifestSchema.parse(input.expected);
  if (repositoryInstructionManifestDigest(expected) !== expected.digest)
    throw new Error("The pinned repository-instruction manifest digest is invalid");
  const [current, index] = await Promise.all([
    resolveRepositoryInstructionManifest({
      repositoryPath: input.repositoryPath,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
    resolveRepositoryInstructionManifest({
      repositoryPath: input.repositoryPath,
      indexOnly: true,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  ]);
  if (current.digest !== expected.digest || index.digest !== expected.digest)
    throw new Error(
      "Repository instructions changed after the run was planned; start a new run from the updated repository state",
    );
  return current;
}

export async function assertRepositoryInstructionsMatchBase(input: {
  manifest: RepositoryInstructionManifest;
  repositoryPath: string;
  baseSha: string;
  signal?: AbortSignal;
}): Promise<void> {
  const base = await resolveRepositoryInstructionManifest({
    repositoryPath: input.repositoryPath,
    baseSha: input.baseSha,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (base.digest !== input.manifest.digest)
    throw new Error("The repository-instruction manifest does not match the approved base commit");
  try {
    await assertRepositoryInstructionManifest({
      expected: base,
      repositoryPath: input.repositoryPath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    input.signal?.throwIfAborted();
    throw new Error(
      "Tracked repository instructions differ from the approved base commit; commit or restore them before creating a run",
      { cause: error },
    );
  }
}
