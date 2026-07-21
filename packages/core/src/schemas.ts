import { z } from "zod";

export const FinishLineSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("local_verified") }),
  z.strictObject({ kind: z.literal("committed") }),
  z.strictObject({ kind: z.literal("pushed") }),
  z.strictObject({ kind: z.literal("pr_open") }),
  z.strictObject({
    kind: z.literal("pr_green"),
    requiredChecks: z.union([z.literal("github_required"), z.array(z.string().min(1))]),
  }),
  z.strictObject({
    kind: z.literal("custom"),
    description: z.string().min(1),
    proof: z.array(z.string().min(1)).min(1),
  }),
]);

export const PermissionSchema = z.enum([
  "read_repository",
  "write_repository",
  "run_commands",
  "create_worktree",
  "commit",
  "push",
  "github_read",
  "github_write",
]);

export const AcceptanceAnchorSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  owner: z.enum(["user", "repository", "github", "held_out_eval"]),
  evidenceSource: z.string().min(1),
  mutationPolicy: z.enum(["immutable", "user_approval"]),
});

export const RunContractSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  task: z.string().min(1),
  outcome: z.string().min(1),
  finishLine: FinishLineSchema,
  repository: z.strictObject({
    root: z.string().min(1),
    remote: z.string().min(1).optional(),
    baseRef: z.string().min(1),
    baseSha: z.string().min(1),
  }),
  scope: z.strictObject({
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  }),
  permissions: z.array(PermissionSchema),
  acceptanceAnchors: z.array(AcceptanceAnchorSchema).min(1),
  optionalCircuitBreakers: z
    .strictObject({
      tokens: z.number().int().positive().optional(),
      minutes: z.number().positive().optional(),
      modelCalls: z.number().int().positive().optional(),
    })
    .optional(),
});

export const CommandProbeSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("command"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  expectedExitCode: z.number().int().default(0),
  timeoutMs: z.number().int().positive().default(120_000),
  platforms: z
    .array(z.enum(["darwin", "linux", "win32"]))
    .min(1)
    .optional(),
});

export const FileProbeSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("file"),
  path: z.string().min(1),
  shouldExist: z.boolean().default(true),
  contains: z.string().min(1).optional(),
});

export const GitDiffProbeSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("git_diff"),
  baseSha: z.string().min(1),
  requireChanges: z.boolean().default(true),
});

export const RepositoryInventoryProbeSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("repository_inventory"),
  paths: z.array(z.string().min(1)).min(1),
  terms: z.array(z.string().min(1)).min(1),
});

export const ProbeSpecSchema = z.discriminatedUnion("kind", [
  CommandProbeSchema,
  FileProbeSchema,
  GitDiffProbeSchema,
  RepositoryInventoryProbeSchema,
]);

export const ProbePlanItemSchema = z.strictObject({
  phase: z.enum(["progress", "completion"]),
  purpose: z.enum(["inventory", "focused", "acceptance", "regression"]),
  source: z.string().min(1),
  probe: ProbeSpecSchema,
});

export const ProbePlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  family: z.enum(["bug", "feature", "migration", "refactor", "audit"]),
  items: z.array(ProbePlanItemSchema).min(1),
});

export const ProbeResultSchema = z.strictObject({
  probeId: z.string().min(1),
  kind: z.enum(["command", "file", "git_diff", "repository_inventory"]),
  passed: z.boolean(),
  signature: z.string().min(1),
  summary: z.string(),
  durationMs: z.number().nonnegative(),
  artifact: z.string().optional(),
});

export const NodeKindSchema = z.enum([
  "investigation",
  "implementation",
  "verification",
  "diagnostic",
  "decision",
  "wait",
  "commit",
]);

export const NodeStatusSchema = z.enum([
  "pending",
  "running",
  "accepted",
  "failed",
  "blocked",
  "stopped",
  "superseded",
]);

export const GraphNodeSchema = z.strictObject({
  id: z.string().min(1),
  kind: NodeKindSchema,
  objective: z.string().min(1),
  dependsOn: z.array(z.string()),
  scope: z.array(z.string()),
  contextSelector: z.strictObject({
    includeRepositoryInstructions: z.boolean(),
    predecessorResults: z.array(z.string()),
    relevantPaths: z.array(z.string()),
  }),
  outputSchema: z.record(z.string(), z.unknown()),
  progressProbes: z.array(ProbeSpecSchema),
  completionProbes: z.array(ProbeSpecSchema),
  sideEffectClass: z.enum(["none", "workspace_write", "git_commit", "external"]),
  status: NodeStatusSchema,
});

export const PlannedGraphNodeSchema = GraphNodeSchema.omit({
  outputSchema: true,
  status: true,
});

export const GraphPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  family: z.enum(["bug", "feature", "migration", "refactor", "audit"]),
  nodes: z.array(PlannedGraphNodeSchema).min(1),
});

export const ControlEdgeSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  relation: z.enum(["observes", "vetoes", "arbitrates", "owns_target"]),
});

export const ControlDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  decisionId: z.uuid(),
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  verdict: z.enum(["approve", "veto"]),
  rationale: z.string().min(1),
  evidence: z.array(z.string()),
  actor: z.enum(["user", "runtime", "verifier"]),
  sticky: z.boolean(),
  decidedAt: z.iso.datetime(),
  replaces: z.uuid().optional(),
});

export const ControlDecisionPacketSchema = z.strictObject({
  packetId: z.uuid(),
  targetId: z.string().min(1),
  invariant: z.string().min(1),
  conflict: z.string().min(1),
  evidence: z.array(z.string()),
  requiredSources: z.array(z.string().min(1)).min(1),
  choices: z.array(z.enum(["approve", "veto"])).min(1),
  createdAt: z.iso.datetime(),
});

export const GraphSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  family: z.enum(["bug", "feature", "migration", "refactor", "audit"]),
  nodes: z.array(GraphNodeSchema).min(1),
  anchors: z.array(AcceptanceAnchorSchema).min(1),
  controlEdges: z.array(ControlEdgeSchema),
  revision: z.number().int().nonnegative(),
});

export const TokenUsageSchema = z.strictObject({
  input: z.number().int().nonnegative().default(0),
  cachedInput: z.number().int().nonnegative().default(0),
  output: z.number().int().nonnegative().default(0),
  reasoning: z.number().int().nonnegative().default(0),
  total: z.number().int().nonnegative().default(0),
});

export const WorkerResultSchema = z.strictObject({
  status: z.enum(["completed", "blocked", "failed"]),
  summary: z.string(),
  changedPaths: z.array(z.string()),
  evidence: z.array(z.string()),
  nextSuggestedObjective: z.string().optional(),
});

export const ContextCapsuleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  nodeId: z.string().min(1),
  objective: z.string().min(1),
  finishLine: FinishLineSchema,
  constraints: z.array(z.string()),
  acceptanceAnchors: z.array(AcceptanceAnchorSchema),
  predecessorEvidence: z.array(z.string()),
  relevantPaths: z.array(z.string()),
  probeEvidence: z.array(z.string()),
});

export const SemanticVerifierContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  phase: z.enum(["progress", "completion"]),
  runId: z.uuid(),
  nodeId: z.string().min(1),
  objective: z.string().min(1),
  finishLine: FinishLineSchema,
  acceptanceAnchors: z.array(AcceptanceAnchorSchema),
  relevantPaths: z.array(z.string()),
  workerSummary: z.string(),
  workerEvidence: z.array(z.string()),
  baselineProbeEvidence: z.array(ProbeResultSchema),
  currentProbeEvidence: z.array(ProbeResultSchema),
});

export const SemanticVerdictSchema = z.strictObject({
  verdict: z.enum(["supported", "unsupported", "uncertain"]),
  evidence: z.array(z.string()),
  rationale: z.string().min(1),
  uncertainty: z.number().min(0).max(1),
});

export const HostCapabilitiesSchema = z.strictObject({
  installed: z.boolean(),
  authenticated: z.boolean(),
  version: z.string().optional(),
  structuredOutput: z.boolean(),
  streamingEvents: z.boolean(),
  tokenReporting: z.boolean(),
});

export const InterruptionCauseSchema = z.enum([
  "user_pause",
  "user_stop",
  "cancellation",
  "host_crash",
  "timeout",
  "runtime_shutdown",
]);

export const HostTerminationSchema = z.strictObject({
  cause: InterruptionCauseSchema,
  outcome: z.enum(["graceful", "forced", "already_exited"]),
  requestedSignal: z.enum(["SIGTERM", "SIGKILL"]),
  exitCode: z.number().int().nullable(),
  exitSignal: z.string().nullable(),
});

export const RunControlRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  runId: z.uuid(),
  action: z.enum(["pause", "stop"]),
  cause: z.enum(["user_pause", "user_stop"]),
  reason: z.string().min(1),
  requestedAt: z.iso.datetime(),
  requestedByPid: z.number().int().positive(),
});

export const HostEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("started"), invocationId: z.string() }),
  z.strictObject({ type: z.literal("session"), hostSessionId: z.string().min(1) }),
  z.strictObject({ type: z.literal("message"), text: z.string() }),
  z.strictObject({ type: z.literal("tool"), name: z.string(), summary: z.string() }),
  z.strictObject({ type: z.literal("result"), result: WorkerResultSchema }),
  z.strictObject({ type: z.literal("usage"), usage: TokenUsageSchema }),
  z.strictObject({ type: z.literal("terminated"), termination: HostTerminationSchema }),
  z.strictObject({
    type: z.literal("error"),
    message: z.string(),
    cause: InterruptionCauseSchema.optional(),
  }),
]);

export const RunEventTypeSchema = z.enum([
  "run.created",
  "run.approved",
  "run.started",
  "run.paused",
  "run.stopped",
  "run.completed",
  "run.blocked",
  "node.started",
  "node.progress",
  "node.accepted",
  "node.failed",
  "node.reset",
  "invocation.started",
  "invocation.session",
  "invocation.resumed",
  "invocation.finished",
  "control.applied",
  "control.decision",
  "control.observed",
  "control.override",
  "control.decision_required",
  "control.resolved",
  "semantic.verdict",
  "tokens.recorded",
  "graph.amended",
]);

export const RunEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime(),
  actor: z.enum(["user", "runtime", "worker", "probe", "host"]),
  causationId: z.string().min(1),
  type: RunEventTypeSchema,
  data: z.record(z.string(), z.unknown()),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const NodeRuntimeStateSchema = z.strictObject({
  status: NodeStatusSchema,
  attempts: z.number().int().nonnegative(),
  lastSummary: z.string().optional(),
  lastProgress: z
    .enum(["advanced", "learning", "stalled", "regressed", "oscillating", "blocked", "done"])
    .optional(),
  acceptedAt: z.iso.datetime().optional(),
});

export const RunStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  status: z.enum([
    "awaiting_approval",
    "running",
    "paused",
    "stopped",
    "blocked",
    "failed",
    "completed",
  ]),
  lastEventSequence: z.number().int().nonnegative(),
  nodes: z.record(z.string(), NodeRuntimeStateSchema),
  currentNodeId: z.string().optional(),
  latestProgressEvidence: z.array(z.string()),
  tokens: TokenUsageSchema,
  controlDecisions: z.array(ControlDecisionSchema),
  pendingDecision: ControlDecisionPacketSchema.optional(),
  stopReason: z.string().optional(),
  updatedAt: z.iso.datetime(),
});

export type FinishLine = z.infer<typeof FinishLineSchema>;
export type Permission = z.infer<typeof PermissionSchema>;
export type AcceptanceAnchor = z.infer<typeof AcceptanceAnchorSchema>;
export type RunContract = z.infer<typeof RunContractSchema>;
export type ProbeSpec = z.infer<typeof ProbeSpecSchema>;
export type ProbePlan = z.infer<typeof ProbePlanSchema>;
export type ProbePlanItem = z.infer<typeof ProbePlanItemSchema>;
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type PlannedGraphNode = z.infer<typeof PlannedGraphNodeSchema>;
export type GraphPlan = z.infer<typeof GraphPlanSchema>;
export type Graph = z.infer<typeof GraphSchema>;
export type ControlDecision = z.infer<typeof ControlDecisionSchema>;
export type ControlDecisionPacket = z.infer<typeof ControlDecisionPacketSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type WorkerResult = z.infer<typeof WorkerResultSchema>;
export type ContextCapsule = z.infer<typeof ContextCapsuleSchema>;
export type SemanticVerifierContext = z.infer<typeof SemanticVerifierContextSchema>;
export type SemanticVerdict = z.infer<typeof SemanticVerdictSchema>;
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;
export type InterruptionCause = z.infer<typeof InterruptionCauseSchema>;
export type HostTermination = z.infer<typeof HostTerminationSchema>;
export type RunControlRequest = z.infer<typeof RunControlRequestSchema>;
export type HostEvent = z.infer<typeof HostEventSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunState = z.infer<typeof RunStateSchema>;

export const workerResultJsonSchema = z.toJSONSchema(WorkerResultSchema, { target: "draft-7" });
export const graphPlanJsonSchema = z.toJSONSchema(GraphPlanSchema, { target: "draft-7" });
export const semanticVerdictJsonSchema = z.toJSONSchema(SemanticVerdictSchema, {
  target: "draft-7",
});
