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

export const ExecutableProbeSchema = z.union([
  CommandProbeSchema,
  FileProbeSchema,
  GitDiffProbeSchema,
  RepositoryInventoryProbeSchema,
]);

export const HeldOutProbeReferenceSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("held_out"),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  probeHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ProbeSpecSchema = z.union([ExecutableProbeSchema, HeldOutProbeReferenceSchema]);

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

export const HeldOutProbeIntegritySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("package_script"),
    path: z.string().min(1),
    script: z.string().min(1),
    valueHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("file"),
    path: z.string().min(1),
    valueHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);

export const HeldOutProbeEntrySchema = z.strictObject({
  probe: ExecutableProbeSchema,
  probeHash: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.string().min(1),
  integrity: z.array(HeldOutProbeIntegritySchema),
});

export const HeldOutProbePlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  family: z.enum(["bug", "feature", "migration", "refactor", "audit"]),
  probes: z.array(HeldOutProbeEntrySchema).min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ProbeResultSchema = z.strictObject({
  probeId: z.string().min(1),
  kind: z.enum(["command", "file", "git_diff", "repository_inventory"]),
  passed: z.boolean(),
  signature: z.string().min(1),
  summary: z.string(),
  durationMs: z.number().nonnegative(),
  artifact: z.string().optional(),
  metrics: z.record(z.string(), z.number().finite()).optional(),
});

export const ProgressClassificationSchema = z.enum([
  "advanced",
  "learning",
  "stalled",
  "regressed",
  "oscillating",
  "blocked",
  "done",
]);

export const ProgressVectorSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  passedProbeIds: z.array(z.string()),
  failingProbeIds: z.array(z.string()),
  metrics: z.record(z.string(), z.number().finite()),
});

export const EvidenceSnapshotSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceDigest: z.string().min(1),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failureSignature: z.string().regex(/^[a-f0-9]{64}$/),
  probeResults: z.array(ProbeResultSchema),
  vector: ProgressVectorSchema,
});

export const ProgressTrajectoryEntrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  attemptId: z.string().min(1),
  nodeId: z.string().min(1),
  family: z.enum(["bug", "feature", "migration", "refactor", "audit"]),
  strategy: z.string().min(1),
  classification: ProgressClassificationSchema,
  baseline: EvidenceSnapshotSchema,
  current: EvidenceSnapshotSchema,
  recordedAt: z.iso.datetime(),
});

export const ProgressDecisionPacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  packetId: z.uuid(),
  nodeId: z.string().min(1),
  invariant: z.string().min(1),
  attemptedStrategies: z.array(z.string().min(1)).min(1),
  evidence: z.array(z.string()),
  blocker: z.string().min(1),
  choices: z
    .array(
      z.strictObject({
        action: z.enum(["amend_strategy", "provide_evidence", "stop"]),
        description: z.string().min(1),
      }),
    )
    .min(1),
  createdAt: z.iso.datetime(),
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

export const GraphAmendmentOperationSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("add"),
    node: PlannedGraphNodeSchema,
    authoritySourceIds: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    operation: z.literal("supersede"),
    targetId: z.string().min(1),
    replacement: PlannedGraphNodeSchema,
  }),
  z.strictObject({
    operation: z.literal("split"),
    targetId: z.string().min(1),
    replacements: z.array(PlannedGraphNodeSchema).min(2),
  }),
  z.strictObject({
    operation: z.literal("fuse"),
    targetIds: z.array(z.string().min(1)).min(2),
    replacement: PlannedGraphNodeSchema,
  }),
  z.strictObject({
    operation: z.literal("dependency_change"),
    targetId: z.string().min(1),
    dependsOn: z.array(z.string()),
  }),
]);

export const GraphAmendmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  amendmentId: z.uuid(),
  operations: z.array(GraphAmendmentOperationSchema).min(1),
  evidence: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(1),
  changedStrategy: z.string().min(1),
  falsifiableExpectation: z.string().min(1),
});

export const GraphAmendmentDiffSchema = z.strictObject({
  addedNodeIds: z.array(z.string()),
  removedNodeIds: z.array(z.string()),
  changedNodeIds: z.array(z.string()),
});

export const GraphAmendmentRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  proposal: GraphAmendmentSchema,
  actor: z.enum(["runtime", "user"]),
  previousRevision: z.number().int().nonnegative(),
  nextRevision: z.number().int().positive(),
  diff: GraphAmendmentDiffSchema,
});

export const GraphRevisionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventSequence: z.number().int().positive(),
  timestamp: z.iso.datetime(),
  actor: z.enum(["user", "runtime", "worker", "probe", "host"]),
  previousRevision: z.number().int().nonnegative(),
  nextRevision: z.number().int().positive(),
  rationale: z.string().min(1),
  evidence: z.array(z.string()),
  diff: GraphAmendmentDiffSchema,
  amendment: GraphAmendmentRecordSchema.optional(),
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

export const TokenAvailabilityStatusSchema = z.enum([
  "reported",
  "derived",
  "estimated",
  "unavailable",
  "legacy_unknown",
]);

const legacyTokenAvailability = {
  input: "legacy_unknown" as const,
  cachedInput: "legacy_unknown" as const,
  uncachedInput: "legacy_unknown" as const,
  output: "legacy_unknown" as const,
  reasoning: "legacy_unknown" as const,
  total: "legacy_unknown" as const,
};

export const TokenAvailabilitySchema = z
  .strictObject({
    input: TokenAvailabilityStatusSchema,
    cachedInput: TokenAvailabilityStatusSchema,
    uncachedInput: TokenAvailabilityStatusSchema,
    output: TokenAvailabilityStatusSchema,
    reasoning: TokenAvailabilityStatusSchema,
    total: TokenAvailabilityStatusSchema,
  })
  .default(legacyTokenAvailability);

export const TokenUsageSchema = z.strictObject({
  input: z.number().int().nonnegative().default(0),
  cachedInput: z.number().int().nonnegative().default(0),
  uncachedInput: z.number().int().nonnegative().default(0),
  output: z.number().int().nonnegative().default(0),
  reasoning: z.number().int().nonnegative().default(0),
  total: z.number().int().nonnegative().default(0),
  availability: TokenAvailabilitySchema,
});

export const TokenAttributionPhaseSchema = z.enum([
  "planning",
  "worker",
  "repair",
  "semantic_verification",
  "graphcraft_overhead",
]);

export const TokenLedgerEntrySchema = z.strictObject({
  sequence: z.number().int().positive(),
  phase: TokenAttributionPhaseSchema,
  usage: TokenUsageSchema,
  causationId: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  recovered: z.boolean().default(false),
  missing: z.boolean().default(false),
});

export const OptimizationDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  decisionId: z.string().min(1),
  kind: z.enum(["graph_shape", "concurrency", "host_context"]),
  choice: z.enum(["fuse", "split", "preserve", "parallel", "sequential", "reuse", "fresh"]),
  nodeIds: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(1),
  evidence: z.array(z.string().min(1)),
  estimate: z.strictObject({
    modelCallsDelta: z.number().int(),
    contextCharactersDelta: z.number().int(),
    latencyTurnsDelta: z.number().int(),
  }),
  costBasis: z.enum(["deterministic_static", "durable_receipts"]),
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

export const ContextSelectionReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  nodeId: z.string().min(1),
  capsule: z.strictObject({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    path: z.string().min(1),
    characters: z.number().int().nonnegative(),
  }),
  selected: z.strictObject({
    repositoryPaths: z.array(z.string()),
    predecessorNodeIds: z.array(z.string()),
    predecessorEvidenceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
    probeIds: z.array(z.string()),
    probeSignatures: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
    acceptanceAnchorIds: z.array(z.string()),
  }),
  omitted: z.strictObject({
    repositoryPathCount: z.number().int().nonnegative(),
    declaredRepositoryPaths: z.array(z.string()),
    predecessorNodeIds: z.array(z.string()),
    probeIds: z.array(z.string()),
    repositoryInventory: z.strictObject({
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      artifact: z.string().min(1),
      totalPathCount: z.number().int().nonnegative(),
    }),
    rawHostTranscripts: z.literal(true),
    rawProbeOutputs: z.literal(true),
  }),
  reused: z.strictObject({
    capsule: z.boolean(),
    repositoryInventory: z.boolean(),
    artifacts: z.array(z.string()),
  }),
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
  "context.selected",
  "held_out.checked",
  "semantic.verdict",
  "tokens.recorded",
  "optimizer.decided",
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
  progressTrajectory: z.array(ProgressTrajectoryEntrySchema).default([]),
  progressDecision: ProgressDecisionPacketSchema.optional(),
  tokens: TokenUsageSchema,
  tokenLedger: z.array(TokenLedgerEntrySchema).default([]),
  optimizationDecisions: z.array(OptimizationDecisionSchema).default([]),
  controlDecisions: z.array(ControlDecisionSchema),
  pendingDecision: ControlDecisionPacketSchema.optional(),
  stopReason: z.string().optional(),
  updatedAt: z.iso.datetime(),
});

export const RunStorageManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  migratedFrom: z.union([z.literal(0), z.literal(1)]),
  formats: z.strictObject({
    contract: z.literal(1),
    graph: z.literal(1),
    probePlan: z.literal(1),
    heldOutProbes: z.literal(1).default(1),
    events: z.literal(1),
    state: z.literal(1),
    workspace: z.literal(1),
    capsules: z.literal(1),
    invocationEvents: z.literal(1),
    semanticReports: z.literal(1),
    rawArtifacts: z.literal(1),
    controlRequests: z.literal(1),
    locks: z.literal(1),
  }),
});

export type FinishLine = z.infer<typeof FinishLineSchema>;
export type Permission = z.infer<typeof PermissionSchema>;
export type AcceptanceAnchor = z.infer<typeof AcceptanceAnchorSchema>;
export type RunContract = z.infer<typeof RunContractSchema>;
export type ProbeSpec = z.infer<typeof ProbeSpecSchema>;
export type ExecutableProbe = z.infer<typeof ExecutableProbeSchema>;
export type ProbePlan = z.infer<typeof ProbePlanSchema>;
export type ProbePlanItem = z.infer<typeof ProbePlanItemSchema>;
export type HeldOutProbeReference = z.infer<typeof HeldOutProbeReferenceSchema>;
export type HeldOutProbeIntegrity = z.infer<typeof HeldOutProbeIntegritySchema>;
export type HeldOutProbeEntry = z.infer<typeof HeldOutProbeEntrySchema>;
export type HeldOutProbePlan = z.infer<typeof HeldOutProbePlanSchema>;
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
export type ProgressClassification = z.infer<typeof ProgressClassificationSchema>;
export type ProgressVector = z.infer<typeof ProgressVectorSchema>;
export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshotSchema>;
export type ProgressTrajectoryEntry = z.infer<typeof ProgressTrajectoryEntrySchema>;
export type ProgressDecisionPacket = z.infer<typeof ProgressDecisionPacketSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type PlannedGraphNode = z.infer<typeof PlannedGraphNodeSchema>;
export type GraphPlan = z.infer<typeof GraphPlanSchema>;
export type GraphAmendmentOperation = z.infer<typeof GraphAmendmentOperationSchema>;
export type GraphAmendment = z.infer<typeof GraphAmendmentSchema>;
export type GraphAmendmentDiff = z.infer<typeof GraphAmendmentDiffSchema>;
export type GraphAmendmentRecord = z.infer<typeof GraphAmendmentRecordSchema>;
export type GraphRevisionRecord = z.infer<typeof GraphRevisionRecordSchema>;
export type Graph = z.infer<typeof GraphSchema>;
export type ControlDecision = z.infer<typeof ControlDecisionSchema>;
export type ControlDecisionPacket = z.infer<typeof ControlDecisionPacketSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type TokenAvailabilityStatus = z.infer<typeof TokenAvailabilityStatusSchema>;
export type TokenAttributionPhase = z.infer<typeof TokenAttributionPhaseSchema>;
export type TokenLedgerEntry = z.infer<typeof TokenLedgerEntrySchema>;
export type OptimizationDecision = z.infer<typeof OptimizationDecisionSchema>;
export type WorkerResult = z.infer<typeof WorkerResultSchema>;
export type ContextCapsule = z.infer<typeof ContextCapsuleSchema>;
export type ContextSelectionReceipt = z.infer<typeof ContextSelectionReceiptSchema>;
export type SemanticVerifierContext = z.infer<typeof SemanticVerifierContextSchema>;
export type SemanticVerdict = z.infer<typeof SemanticVerdictSchema>;
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;
export type InterruptionCause = z.infer<typeof InterruptionCauseSchema>;
export type HostTermination = z.infer<typeof HostTerminationSchema>;
export type RunControlRequest = z.infer<typeof RunControlRequestSchema>;
export type HostEvent = z.infer<typeof HostEventSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
export type RunStorageManifest = z.infer<typeof RunStorageManifestSchema>;

export const workerResultJsonSchema = z.toJSONSchema(WorkerResultSchema, { target: "draft-7" });
export const graphPlanJsonSchema = z.toJSONSchema(GraphPlanSchema, { target: "draft-7" });
export const semanticVerdictJsonSchema = z.toJSONSchema(SemanticVerdictSchema, {
  target: "draft-7",
});

const unsupportedCodexSchemaKeywords = new Set([
  "$schema",
  "default",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "multipleOf",
  "pattern",
  "uniqueItems",
]);

function codexStrictSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => codexStrictSchema(item));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (unsupportedCodexSchemaKeywords.has(key) || key === "properties" || key === "required")
      continue;
    if (key === "oneOf") output.anyOf = codexStrictSchema(item);
    else if (key === "const") output.enum = [item];
    else output[key] = codexStrictSchema(item);
  }
  if (source.properties && typeof source.properties === "object") {
    const properties = source.properties as Record<string, unknown>;
    const originallyRequired = new Set(
      Array.isArray(source.required) ? source.required.map((item) => String(item)) : [],
    );
    output.properties = Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => {
        const transformed = codexStrictSchema(schema);
        return [
          key,
          originallyRequired.has(key) ? transformed : { anyOf: [transformed, { type: "null" }] },
        ];
      }),
    );
    output.required = Object.keys(properties);
  }
  return output;
}

export const codexWorkerResultJsonSchema = codexStrictSchema(workerResultJsonSchema);
export const codexGraphPlanJsonSchema = codexStrictSchema(graphPlanJsonSchema);
export const codexSemanticVerdictJsonSchema = codexStrictSchema(semanticVerdictJsonSchema);
