import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { canonicalJson, contentHash } from "../packages/core/src/canonical.ts";

export type LiveQualificationHost = "codex" | "claude";
export type LiveQualificationEffort = "low" | "medium" | "high" | "xhigh";

export interface LiveQualificationEvidenceSource {
  graphcraftPackageVersion: string;
  sourceGitHead: string;
  sourceGitStatus: "clean" | "dirty";
  platform: string;
  arch: string;
  node: string;
  fixtureGitHead: string;
  fixtureTreeSha256: string;
  taskSha256: string;
  fixtureTaskSha256: string;
}

export interface LiveQualificationEvidenceBinding {
  hashAlgorithms: {
    qualificationReport: "sha256-exact-bytes-v1";
    hostQualification: "graphcraft-canonical-json-sha256-v1";
  };
  qualificationReportSha256: string;
  hostQualificationSha256: string;
  qualificationReportSchemaVersion: 1;
  qualificationReportKind: "graphcraft-live-host-qualification";
  qualificationCompletedAt: string;
  source: LiveQualificationEvidenceSource;
  control: {
    rawVersion: string;
    model: string;
    effort: LiveQualificationEffort;
  };
}

export interface LiveQualificationUsage {
  input: number;
  cachedInput: number;
  uncachedInput: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface SanitizedLiveProtocolEvidence {
  schemaVersion: 1;
  kind: "graphcraft-sanitized-live-host-protocol-evidence";
  host: LiveQualificationHost;
  rawVersion: string;
  sessionPlaceholder: string;
  provenance: {
    kind: "sanitized-live-qualification";
    liveCapture: true;
    rawNativeEventsPersisted: false;
    sanitization: string;
  };
  acceptance: {
    qualifiesVersion: false;
    mayUpdateAdmission: false;
    authorizesAdmission: false;
    requiresIndependentQualificationReport: true;
  };
  binding: LiveQualificationEvidenceBinding;
  captures: {
    interruptedWorker: Record<string, unknown>[];
    resumedWorker: Record<string, unknown>[];
  };
  expected: {
    normalizedUsage: LiveQualificationUsage;
    resultStatus: "completed";
  };
}

export interface ContentAddressedEvidenceFile {
  fileName: string;
  sha256: string;
  bytes: string;
}

interface SanitizerState {
  host: LiveQualificationHost;
  binding: LiveQualificationEvidenceBinding;
  sessionPlaceholder: string;
  identifiers: Map<string, string>;
  strings: Map<string, string>;
}

interface EvidenceDirectoryReservation {
  path: string;
  identity: string | undefined;
}

type EvidencePublicationBoundary =
  "after_directory_creation" | "before_file_write" | "after_file_write";

const SESSION_PLACEHOLDERS: Record<LiveQualificationHost, string> = {
  codex: "00000000-0000-4000-8000-000000000001",
  claude: "00000000-0000-4000-8000-000000000002",
};

const SAFE_WORKER_RESULT = {
  status: "completed",
  summary: "Sanitized live qualification result.",
  changedPaths: [],
  evidence: ["Sanitized host protocol replay evidence."],
} as const;

const SAFE_PROTOCOL_LITERALS = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "item.started",
  "item.completed",
  "agent_message",
  "reasoning",
  "command_execution",
  "mcp_tool_call",
  "file_change",
  "web_search",
  "todo_list",
  "system",
  "assistant",
  "user",
  "result",
  "rate_limit_event",
  "tool_progress",
  "message",
  "text",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "server_tool_use",
  "web_search_tool_result",
  "init",
  "success",
  "error",
  "compact_boundary",
  "in_progress",
  "completed",
  "failed",
  "pending",
  "running",
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "refusal",
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
]);

const UNSAFE_KEY = /^(?:__proto__|constructor|prototype)$/u;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

const CODEX_EVENT_FIELDS: Record<string, ReadonlySet<string>> = {
  "thread.started": new Set(["type", "thread_id"]),
  "turn.started": new Set(["type"]),
  "turn.completed": new Set(["type", "usage"]),
  "item.started": new Set(["type", "item"]),
  "item.completed": new Set(["type", "item"]),
};

const CODEX_ITEM_FIELDS: Record<string, ReadonlySet<string>> = {
  agent_message: new Set(["id", "type", "text"]),
  reasoning: new Set(["id", "type", "text"]),
  command_execution: new Set(["id", "type", "command", "aggregated_output", "exit_code", "status"]),
  mcp_tool_call: new Set([
    "id",
    "type",
    "server",
    "tool",
    "name",
    "arguments",
    "result",
    "error",
    "status",
  ]),
  file_change: new Set(["id", "type", "changes", "status"]),
  web_search: new Set(["id", "type", "query", "status"]),
  todo_list: new Set(["id", "type", "items"]),
};

const CLAUDE_EVENT_FIELDS: Record<string, ReadonlySet<string>> = {
  system: new Set([
    "type",
    "subtype",
    "cwd",
    "session_id",
    "tools",
    "mcp_servers",
    "model",
    "permissionMode",
    "permission_mode",
    "claude_code_version",
    "output_style",
    "slash_commands",
    "agents",
    "skills",
    "plugins",
    "apiKeySource",
    "fast_mode_state",
    "uuid",
  ]),
  assistant: new Set(["type", "message", "parent_tool_use_id", "session_id", "uuid"]),
  user: new Set(["type", "message", "parent_tool_use_id", "session_id", "uuid", "tool_use_result"]),
  result: new Set([
    "type",
    "subtype",
    "is_error",
    "duration_ms",
    "duration_api_ms",
    "num_turns",
    "result",
    "session_id",
    "total_cost_usd",
    "usage",
    "permission_denials",
    "uuid",
    "structured_output",
  ]),
  rate_limit_event: new Set(["type", "rate_limit_info", "session_id", "uuid"]),
  tool_progress: new Set([
    "type",
    "tool_use_id",
    "tool_name",
    "elapsed_time_seconds",
    "session_id",
    "uuid",
  ]),
};

const CLAUDE_MESSAGE_FIELDS = new Set([
  "model",
  "id",
  "type",
  "role",
  "content",
  "stop_reason",
  "stop_sequence",
  "usage",
]);

const CLAUDE_CONTENT_FIELDS: Record<string, ReadonlySet<string>> = {
  text: new Set(["type", "text", "citations"]),
  tool_use: new Set(["type", "id", "name", "input"]),
  tool_result: new Set(["type", "tool_use_id", "content", "is_error"]),
  thinking: new Set(["type", "thinking", "signature"]),
  redacted_thinking: new Set(["type", "data"]),
  server_tool_use: new Set(["type", "id", "name", "input"]),
  web_search_tool_result: new Set(["type", "tool_use_id", "content"]),
};

const CODEX_USAGE_FIELDS = new Set([
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
]);
const CLAUDE_USAGE_FIELDS = new Set([
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
]);
const NORMALIZED_USAGE_FIELDS = [
  "input",
  "cachedInput",
  "uncachedInput",
  "output",
  "reasoning",
  "total",
] as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} is not a JSON object`);
  return value as Record<string, unknown>;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function safeMetadataString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\r\n\0]/u.test(value)
  );
}

function assertHost(host: unknown): asserts host is LiveQualificationHost {
  if (host !== "codex" && host !== "claude")
    throw new Error("Live protocol evidence has an unsupported host");
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index]))
    throw new Error(`${label} contains unsupported or missing fields`);
}

function safeBinding(binding: LiveQualificationEvidenceBinding): LiveQualificationEvidenceBinding {
  assertExactKeys(
    record(binding, "Live protocol evidence qualification report binding"),
    [
      "hashAlgorithms",
      "qualificationReportSha256",
      "hostQualificationSha256",
      "qualificationReportSchemaVersion",
      "qualificationReportKind",
      "qualificationCompletedAt",
      "source",
      "control",
    ],
    "Live protocol evidence qualification report binding",
  );
  assertExactKeys(
    record(binding.hashAlgorithms, "Live protocol evidence hash algorithms"),
    ["qualificationReport", "hostQualification"],
    "Live protocol evidence hash algorithms",
  );
  assertExactKeys(
    record(binding.source, "Live protocol evidence source"),
    [
      "graphcraftPackageVersion",
      "sourceGitHead",
      "sourceGitStatus",
      "platform",
      "arch",
      "node",
      "fixtureGitHead",
      "fixtureTreeSha256",
      "taskSha256",
      "fixtureTaskSha256",
    ],
    "Live protocol evidence source",
  );
  assertExactKeys(
    record(binding.control, "Live protocol evidence host control"),
    ["rawVersion", "model", "effort"],
    "Live protocol evidence host control",
  );
  if (
    binding.hashAlgorithms?.qualificationReport !== "sha256-exact-bytes-v1" ||
    binding.hashAlgorithms?.hostQualification !== "graphcraft-canonical-json-sha256-v1" ||
    typeof binding.qualificationReportSha256 !== "string" ||
    !SHA256.test(binding.qualificationReportSha256) ||
    typeof binding.hostQualificationSha256 !== "string" ||
    !SHA256.test(binding.hostQualificationSha256) ||
    binding.qualificationReportSchemaVersion !== 1 ||
    binding.qualificationReportKind !== "graphcraft-live-host-qualification" ||
    !validTimestamp(binding.qualificationCompletedAt)
  ) {
    throw new Error("Live protocol evidence has an invalid qualification report binding");
  }
  const { source, control } = binding;
  if (
    !safeMetadataString(source.graphcraftPackageVersion, 128) ||
    typeof source.sourceGitHead !== "string" ||
    !GIT_OBJECT.test(source.sourceGitHead) ||
    typeof source.fixtureGitHead !== "string" ||
    !GIT_OBJECT.test(source.fixtureGitHead) ||
    typeof source.fixtureTreeSha256 !== "string" ||
    !SHA256.test(source.fixtureTreeSha256) ||
    typeof source.taskSha256 !== "string" ||
    !SHA256.test(source.taskSha256) ||
    typeof source.fixtureTaskSha256 !== "string" ||
    !SHA256.test(source.fixtureTaskSha256) ||
    !["clean", "dirty"].includes(source.sourceGitStatus) ||
    [source.platform, source.arch, source.node].some((value) => !safeMetadataString(value, 128)) ||
    !safeMetadataString(control.rawVersion, 256) ||
    typeof control.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/u.test(control.model) ||
    !["low", "medium", "high", "xhigh"].includes(control.effort)
  ) {
    throw new Error("Live protocol evidence has unsafe source or host controls");
  }
  return {
    hashAlgorithms: {
      qualificationReport: binding.hashAlgorithms.qualificationReport,
      hostQualification: binding.hashAlgorithms.hostQualification,
    },
    qualificationReportSha256: binding.qualificationReportSha256,
    hostQualificationSha256: binding.hostQualificationSha256,
    qualificationReportSchemaVersion: binding.qualificationReportSchemaVersion,
    qualificationReportKind: binding.qualificationReportKind,
    qualificationCompletedAt: binding.qualificationCompletedAt,
    source: {
      graphcraftPackageVersion: source.graphcraftPackageVersion,
      sourceGitHead: source.sourceGitHead,
      sourceGitStatus: source.sourceGitStatus,
      platform: source.platform,
      arch: source.arch,
      node: source.node,
      fixtureGitHead: source.fixtureGitHead,
      fixtureTreeSha256: source.fixtureTreeSha256,
      taskSha256: source.taskSha256,
      fixtureTaskSha256: source.fixtureTaskSha256,
    },
    control: {
      rawVersion: control.rawVersion,
      model: control.model,
      effort: control.effort,
    },
  };
}

export function verifyLiveQualificationEvidenceBinding(input: {
  host: LiveQualificationHost;
  binding: LiveQualificationEvidenceBinding;
  qualificationReportBytes: string | Buffer;
}): void {
  assertHost(input.host);
  const binding = safeBinding(input.binding);
  if (sha256(input.qualificationReportBytes) !== binding.qualificationReportSha256)
    throw new Error("Live protocol evidence qualification report hash does not match");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof input.qualificationReportBytes === "string"
        ? input.qualificationReportBytes
        : input.qualificationReportBytes.toString("utf8"),
    );
  } catch {
    throw new Error("Live protocol evidence qualification report is not valid JSON");
  }
  const report = record(parsed, "Bound qualification report");
  if (
    report.schemaVersion !== binding.qualificationReportSchemaVersion ||
    report.kind !== binding.qualificationReportKind ||
    report.completedAt !== binding.qualificationCompletedAt
  ) {
    throw new Error("Live protocol evidence qualification report metadata does not match");
  }
  if (canonicalJson(report.controls) !== canonicalJson(binding.source))
    throw new Error("Live protocol evidence qualification report controls do not match");
  const hosts = record(report.hosts, "Bound qualification report hosts");
  if (!Object.hasOwn(hosts, input.host))
    throw new Error(`Live protocol evidence qualification report omitted ${input.host}`);
  const hostQualification = record(
    hosts[input.host],
    `Bound ${input.host} qualification report entry`,
  );
  if (contentHash(hostQualification) !== binding.hostQualificationSha256)
    throw new Error("Live protocol evidence host qualification hash does not match");
  if (canonicalJson(hostQualification.control) !== canonicalJson(binding.control))
    throw new Error("Live protocol evidence host qualification control does not match");
}

function safeUsage(usage: LiveQualificationUsage): LiveQualificationUsage {
  assertExactKeys(
    record(usage, "Live protocol evidence normalized usage"),
    NORMALIZED_USAGE_FIELDS,
    "Live protocol evidence normalized usage",
  );
  for (const value of NORMALIZED_USAGE_FIELDS.map((field) => usage[field])) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Live protocol evidence usage must contain nonnegative safe integers");
  }
  if (usage.total <= 0) throw new Error("Live protocol evidence has no reported usage");
  return {
    input: usage.input,
    cachedInput: usage.cachedInput,
    uncachedInput: usage.uncachedInput,
    output: usage.output,
    reasoning: usage.reasoning,
    total: usage.total,
  };
}

function placeholder(values: Map<string, string>, value: string, prefix: string): string {
  const existing = values.get(value);
  if (existing) return existing;
  const next = `${prefix}-${String(values.size + 1).padStart(4, "0")}`;
  values.set(value, next);
  return next;
}

function assertAllowedFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!SAFE_KEY.test(key) || UNSAFE_KEY.test(key))
      throw new Error(`${label} contains an unsafe field name`);
    if (!allowed.has(key)) throw new Error(`${label} contains an unsupported field`);
  }
}

function protocolLiteral(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_PROTOCOL_LITERALS.has(value))
    throw new Error(`Live protocol ${field} contains an unsupported literal`);
  return value;
}

function sanitizedIdentifier(value: unknown, state: SanitizerState): string | undefined {
  return typeof value === "string"
    ? placeholder(state.identifiers, value, "fixture-id")
    : undefined;
}

function sanitizeProtocolUsage(
  value: unknown,
  host: LiveQualificationHost,
): Record<string, number> {
  const usage = record(value, `${host} live protocol usage`);
  const allowed = host === "codex" ? CODEX_USAGE_FIELDS : CLAUDE_USAGE_FIELDS;
  assertAllowedFields(usage, allowed, `${host} live protocol usage`);
  const sanitized: Record<string, number> = {};
  for (const [key, amount] of Object.entries(usage)) {
    if (!Number.isSafeInteger(amount) || (amount as number) < 0)
      throw new Error(`${host} live protocol usage contains an invalid numeric field`);
    sanitized[key] = amount as number;
  }
  return sanitized;
}

function sanitizeCodexItem(
  rawItem: Record<string, unknown>,
  eventType: string,
  state: SanitizerState,
): Record<string, unknown> {
  if (typeof rawItem.type !== "string" || !CODEX_ITEM_FIELDS[rawItem.type])
    throw new Error("Codex live worker item has an unsupported protocol type");
  assertAllowedFields(
    rawItem,
    CODEX_ITEM_FIELDS[rawItem.type]!,
    `Codex ${rawItem.type} worker item`,
  );
  const item: Record<string, unknown> = { type: rawItem.type };
  const id = sanitizedIdentifier(rawItem.id, state);
  if (id) item.id = id;
  if (rawItem.type === "agent_message") {
    item.text =
      eventType === "item.completed"
        ? JSON.stringify(SAFE_WORKER_RESULT)
        : "Sanitized live qualification text.";
  } else if (rawItem.type === "reasoning") {
    item.text = "Sanitized live qualification text.";
  } else if (rawItem.type === "command_execution") {
    item.command = "read fixture-repository/qualification.json";
    item.aggregated_output = "Sanitized live qualification text.";
    item.exit_code = null;
    if (rawItem.status !== undefined) item.status = protocolLiteral(rawItem.status, "status");
  } else if (rawItem.type === "mcp_tool_call") {
    const rawName = rawItem.name ?? rawItem.tool ?? rawItem.server;
    item.name =
      typeof rawName === "string"
        ? placeholder(state.strings, rawName, "FixtureTool")
        : "FixtureTool-0000";
    if (rawItem.status !== undefined) item.status = protocolLiteral(rawItem.status, "status");
  }
  return item;
}

function sanitizeCodexEvent(
  event: Record<string, unknown>,
  state: SanitizerState,
): Record<string, unknown> {
  if (typeof event.type !== "string" || !CODEX_EVENT_FIELDS[event.type])
    throw new Error("codex emitted an unsupported live worker event type");
  assertAllowedFields(event, CODEX_EVENT_FIELDS[event.type]!, `Codex ${event.type} event`);
  const sanitized: Record<string, unknown> = { type: event.type };
  if (event.type === "thread.started") {
    if (typeof event.thread_id !== "string")
      throw new Error("Codex live thread event omitted its session identity");
    sanitized.thread_id = state.sessionPlaceholder;
  } else if (event.type === "turn.completed") {
    sanitized.usage = sanitizeProtocolUsage(event.usage, "codex");
  } else if (event.type === "item.started" || event.type === "item.completed") {
    sanitized.item = sanitizeCodexItem(
      record(event.item, "Codex live worker item"),
      event.type,
      state,
    );
  }
  return sanitized;
}

function sanitizeClaudeContent(value: unknown, state: SanitizerState): Record<string, unknown> {
  const block = record(value, "Claude live content block");
  if (typeof block.type !== "string" || !CLAUDE_CONTENT_FIELDS[block.type])
    throw new Error("Claude live content block has an unsupported protocol type");
  assertAllowedFields(
    block,
    CLAUDE_CONTENT_FIELDS[block.type]!,
    `Claude ${block.type} content block`,
  );
  const sanitized: Record<string, unknown> = { type: block.type };
  if (block.type === "text") sanitized.text = "Sanitized live qualification text.";
  if (block.type === "tool_use" || block.type === "server_tool_use") {
    const id = sanitizedIdentifier(block.id, state);
    if (id) sanitized.id = id;
    sanitized.name =
      typeof block.name === "string"
        ? placeholder(state.strings, block.name, "FixtureTool")
        : "FixtureTool-0000";
  }
  if (block.type === "tool_result" || block.type === "web_search_tool_result") {
    const toolUseId = sanitizedIdentifier(block.tool_use_id, state);
    if (toolUseId) sanitized.tool_use_id = toolUseId;
  }
  return sanitized;
}

function sanitizeClaudeAssistant(
  event: Record<string, unknown>,
  state: SanitizerState,
): Record<string, unknown> {
  if (typeof event.session_id !== "string")
    throw new Error("Claude live worker output omitted its session identity");
  const message = record(event.message, "Claude live assistant message");
  assertAllowedFields(message, CLAUDE_MESSAGE_FIELDS, "Claude live assistant message");
  if (message.type !== "message" || message.role !== "assistant" || !Array.isArray(message.content))
    throw new Error("Claude live assistant message has an unsupported shape");
  const sanitizedMessage: Record<string, unknown> = {
    type: "message",
    role: "assistant",
    content: message.content.map((block) => sanitizeClaudeContent(block, state)),
  };
  if (message.usage !== undefined)
    sanitizedMessage.usage = sanitizeProtocolUsage(message.usage, "claude");
  return {
    type: "assistant",
    message: sanitizedMessage,
    session_id: state.sessionPlaceholder,
  };
}

function sanitizeClaudeEvent(
  event: Record<string, unknown>,
  state: SanitizerState,
): Record<string, unknown> {
  if (typeof event.type !== "string" || !CLAUDE_EVENT_FIELDS[event.type])
    throw new Error("claude emitted an unsupported live worker event type");
  assertAllowedFields(event, CLAUDE_EVENT_FIELDS[event.type]!, `Claude ${event.type} event`);
  if (event.type === "assistant") return sanitizeClaudeAssistant(event, state);

  const sanitized: Record<string, unknown> = { type: event.type };
  if (event.session_id !== undefined) {
    if (typeof event.session_id !== "string")
      throw new Error("Claude live protocol event has an invalid session identity");
    sanitized.session_id = state.sessionPlaceholder;
  }
  if (event.type === "system") {
    if (event.subtype !== undefined) sanitized.subtype = protocolLiteral(event.subtype, "subtype");
    sanitized.cwd = "fixture-repository";
    sanitized.model = state.binding.control.model;
    sanitized.claude_code_version = state.binding.control.rawVersion;
  } else if (event.type === "result") {
    if (typeof event.session_id !== "string")
      throw new Error("Claude live worker output omitted its session identity");
    if (event.subtype !== undefined) sanitized.subtype = protocolLiteral(event.subtype, "subtype");
    if (event.is_error !== undefined) {
      if (typeof event.is_error !== "boolean")
        throw new Error("Claude live result has an invalid error marker");
      sanitized.is_error = event.is_error;
    }
    sanitized.usage = sanitizeProtocolUsage(event.usage, "claude");
    if (Object.hasOwn(event, "result")) sanitized.result = JSON.stringify(SAFE_WORKER_RESULT);
    if (Object.hasOwn(event, "structured_output"))
      sanitized.structured_output = { ...SAFE_WORKER_RESULT };
    if (!Object.hasOwn(sanitized, "result") && !Object.hasOwn(sanitized, "structured_output"))
      throw new Error("Claude live result omitted its structured worker result");
  }
  return sanitized;
}

function sanitizeEvent(
  event: Record<string, unknown>,
  state: SanitizerState,
): Record<string, unknown> {
  return state.host === "codex"
    ? sanitizeCodexEvent(event, state)
    : sanitizeClaudeEvent(event, state);
}

function assertNoProhibitedValues(serialized: string, prohibitedValues: readonly string[]): void {
  for (const value of prohibitedValues) {
    const encoded = JSON.stringify(value).slice(1, -1);
    if (value.length > 0 && (serialized.includes(value) || serialized.includes(encoded)))
      throw new Error("Sanitized live protocol evidence retained a prohibited raw value");
  }
  if (
    /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]|bearer\s+|sk-[A-Za-z0-9]|gh[opsu]_[A-Za-z0-9])/iu.test(
      serialized,
    )
  ) {
    throw new Error("Sanitized live protocol evidence retained a path or credential pattern");
  }
}

export function buildSanitizedLiveProtocolEvidence(input: {
  host: LiveQualificationHost;
  binding: LiveQualificationEvidenceBinding;
  interruptedWorker: readonly Record<string, unknown>[];
  resumedWorker: readonly Record<string, unknown>[];
  expectedUsage: LiveQualificationUsage;
  prohibitedValues?: readonly string[];
}): SanitizedLiveProtocolEvidence {
  assertHost(input.host);
  const binding = safeBinding(input.binding);
  const expectedUsage = safeUsage(input.expectedUsage);
  if (input.interruptedWorker.length === 0 || input.resumedWorker.length === 0)
    throw new Error("Live protocol evidence requires interrupted and resumed worker events");
  const state: SanitizerState = {
    host: input.host,
    binding,
    sessionPlaceholder: SESSION_PLACEHOLDERS[input.host],
    identifiers: new Map(),
    strings: new Map(),
  };
  const evidence: SanitizedLiveProtocolEvidence = {
    schemaVersion: 1,
    kind: "graphcraft-sanitized-live-host-protocol-evidence",
    host: input.host,
    rawVersion: binding.control.rawVersion,
    sessionPlaceholder: state.sessionPlaceholder,
    provenance: {
      kind: "sanitized-live-qualification",
      liveCapture: true,
      rawNativeEventsPersisted: false,
      sanitization:
        "In-memory per-host and per-event field allowlists with deterministic session, identifier, path, tool, and model-output placeholders; only allowlisted protocol token-usage numbers are retained",
    },
    acceptance: {
      qualifiesVersion: false,
      mayUpdateAdmission: false,
      authorizesAdmission: false,
      requiresIndependentQualificationReport: true,
    },
    binding,
    captures: {
      interruptedWorker: input.interruptedWorker.map((event) => sanitizeEvent(event, state)),
      resumedWorker: input.resumedWorker.map((event) => sanitizeEvent(event, state)),
    },
    expected: {
      normalizedUsage: expectedUsage,
      resultStatus: "completed",
    },
  };
  assertNoProhibitedValues(JSON.stringify(evidence), input.prohibitedValues ?? []);
  return evidence;
}

export function protocolEventsJsonl(events: readonly Record<string, unknown>[]): string {
  if (events.length === 0) throw new Error("Protocol replay requires at least one event");
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export function contentAddressedEvidenceFile(
  evidence: SanitizedLiveProtocolEvidence,
): ContentAddressedEvidenceFile {
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
  const digest = sha256(bytes);
  return {
    fileName: `host-protocol-evidence-v1-${evidence.host}-${digest}.json`,
    sha256: digest,
    bytes,
  };
}

function pathWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function assertNewEvidenceDirectoryPath(
  outputPath: string,
  forbiddenRoots: readonly string[],
): Promise<{ outputPath: string; parent: string }> {
  if (!isAbsolute(outputPath) || resolve(outputPath) !== outputPath)
    throw new Error("Live protocol evidence path must be an absolute normalized path");
  const parent = dirname(outputPath);
  const parentStatus = await lstat(parent);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink())
    throw new Error("Live protocol evidence parent must be a real directory");
  if ((await realpath(parent)) !== parent)
    throw new Error("Live protocol evidence parent must not resolve through aliases or symlinks");
  for (const value of forbiddenRoots) {
    const root = await realpath(resolve(value));
    if (pathWithin(root, outputPath) || pathWithin(outputPath, root))
      throw new Error("Live protocol evidence path overlaps a forbidden repository root");
  }
  try {
    await lstat(outputPath);
    throw new Error("Live protocol evidence path already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { outputPath, parent };
}

async function evidenceDirectoryIdentity(path: string): Promise<string | undefined> {
  const status = await lstat(path, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink() || status.ino === 0n) return undefined;
  return `${status.dev}:${status.ino}:${status.birthtimeNs}`;
}

async function assertEvidenceDirectoryReservation(
  reservation: EvidenceDirectoryReservation,
): Promise<void> {
  if (
    reservation.identity === undefined ||
    (await realpath(reservation.path)) !== reservation.path ||
    (await evidenceDirectoryIdentity(reservation.path)) !== reservation.identity
  ) {
    throw new Error("Live protocol evidence directory changed filesystem identity");
  }
}

async function cleanupEvidenceDirectoryReservation(
  reservation: EvidenceDirectoryReservation,
): Promise<void> {
  if (reservation.identity === undefined) return;
  let currentIdentity: string | undefined;
  try {
    currentIdentity = await evidenceDirectoryIdentity(reservation.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (currentIdentity !== reservation.identity) return;
  try {
    await rmdir(reservation.path);
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
      return;
    throw error;
  }
}

export async function writeSanitizedLiveProtocolEvidence(input: {
  outputPath: string;
  evidence: readonly SanitizedLiveProtocolEvidence[];
  forbiddenRoots: readonly string[];
  publicationBoundaryForTest?: (
    point: EvidencePublicationBoundary,
    path: string,
  ) => void | Promise<void>;
}): Promise<ContentAddressedEvidenceFile[]> {
  if (input.evidence.length === 0)
    throw new Error("Live protocol evidence output requires at least one host bundle");
  const { outputPath } = await assertNewEvidenceDirectoryPath(
    input.outputPath,
    input.forbiddenRoots,
  );
  const files = input.evidence.map(contentAddressedEvidenceFile);
  if (new Set(files.map(({ fileName }) => fileName)).size !== files.length)
    throw new Error("Live protocol evidence contains a content-address collision");

  let reservation: EvidenceDirectoryReservation | undefined;
  try {
    await mkdir(outputPath, { mode: 0o700 });
    reservation = { path: outputPath, identity: await evidenceDirectoryIdentity(outputPath) };
    await assertEvidenceDirectoryReservation(reservation);
    await input.publicationBoundaryForTest?.("after_directory_creation", outputPath);
    await assertEvidenceDirectoryReservation(reservation);
    for (const file of files) {
      const path = resolve(outputPath, file.fileName);
      if (dirname(path) !== outputPath)
        throw new Error("Live protocol evidence filename escaped its output directory");
      await assertEvidenceDirectoryReservation(reservation);
      await input.publicationBoundaryForTest?.("before_file_write", path);
      await assertEvidenceDirectoryReservation(reservation);
      await writeFile(path, file.bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await input.publicationBoundaryForTest?.("after_file_write", path);
      await assertEvidenceDirectoryReservation(reservation);
      const status = await lstat(path);
      if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1)
        throw new Error("Live protocol evidence output is not a private regular file");
      const persisted = await readFile(path);
      if (sha256(persisted) !== file.sha256)
        throw new Error("Live protocol evidence failed its content-address integrity check");
    }
    return files;
  } catch (error) {
    if (reservation) await cleanupEvidenceDirectoryReservation(reservation).catch(() => undefined);
    throw error;
  }
}
