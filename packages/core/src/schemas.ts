import { z } from "zod";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  contentHash,
} from "./canonical.ts";

export const CanonicalHashAlgorithmSchema = z.enum([
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
]);

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

export const GitHubSnapshotProbeSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("github_snapshot"),
  pullRequest: z.literal("run_branch"),
  expectedState: z.literal("open"),
  requiredChecks: z.enum(["observe", "success"]),
  reviewThreads: z.enum(["observe", "resolved"]),
});

export const ExecutableProbeSchema = z.union([
  CommandProbeSchema,
  FileProbeSchema,
  GitDiffProbeSchema,
  RepositoryInventoryProbeSchema,
  GitHubSnapshotProbeSchema,
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
    algorithm: z.literal("git_hash_object").optional(),
    valueHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("directory"),
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

export const HeldOutProbePlanV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  family: z.enum(["bug", "feature", "migration", "refactor", "audit"]),
  probes: z.array(HeldOutProbeEntrySchema).min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export const HeldOutProbePlanV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  hashAlgorithm: z.literal(PORTABLE_CANONICAL_HASH_ALGORITHM),
  runId: z.uuid(),
  family: z.enum(["bug", "feature", "migration", "refactor", "audit"]),
  probes: z.array(HeldOutProbeEntrySchema).min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export const HeldOutProbePlanSchema = z.discriminatedUnion("schemaVersion", [
  HeldOutProbePlanV1Schema,
  HeldOutProbePlanV2Schema,
]);

export const ProbeResultSchema = z.strictObject({
  probeId: z.string().min(1),
  kind: z.enum(["command", "file", "git_diff", "repository_inventory", "github_snapshot"]),
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
  "push",
  "pull_request",
]);

export const NodeStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "accepted",
  "failed",
  "blocked",
  "stopped",
  "superseded",
]);

export const WaitConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("time"), wakeAt: z.iso.datetime() }),
  z.strictObject({
    kind: z.literal("file_exists"),
    path: z.string().min(1),
    pollIntervalMs: z.number().int().min(250).max(300_000),
    timeoutAt: z.iso.datetime().optional(),
  }),
  z.strictObject({
    kind: z.literal("file_changed"),
    path: z.string().min(1),
    pollIntervalMs: z.number().int().min(250).max(300_000),
    timeoutAt: z.iso.datetime().optional(),
  }),
  z.strictObject({
    kind: z.literal("github_pull_request"),
    pollIntervalMs: z.number().int().min(1_000).max(300_000),
    timeoutAt: z.iso.datetime().optional(),
  }),
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
  waitCondition: WaitConditionSchema.optional(),
  status: NodeStatusSchema,
});

const MAX_MODEL_GRAPH_PLAN_CHARACTERS = 1024 * 1024;
const MAX_MODEL_GRAPH_NODES = 64;
const MAX_MODEL_NODE_IDENTIFIER_CHARACTERS = 128;
const MAX_MODEL_NODE_OBJECTIVE_CHARACTERS = 16 * 1024;
const MAX_MODEL_NODE_REFERENCES = 64;
const MAX_MODEL_NODE_PATHS = 256;
const MAX_MODEL_PATH_CHARACTERS = 4 * 1024;
const MAX_MODEL_NODE_PROBES = 64;
const MAX_MODEL_PROBE_COMMAND_CHARACTERS = 4 * 1024;
const MAX_MODEL_PROBE_ARGUMENTS = 256;
const MAX_MODEL_PROBE_ARGUMENT_CHARACTERS = 4 * 1024;
const MAX_MODEL_PROBE_TERMS = 256;
const MAX_MODEL_PROBE_TERM_CHARACTERS = 1024;

const ModelOutputProbeSpecSchema = z.union([
  CommandProbeSchema.extend({
    id: z.string().min(1).max(MAX_MODEL_NODE_IDENTIFIER_CHARACTERS),
    command: z.string().min(1).max(MAX_MODEL_PROBE_COMMAND_CHARACTERS),
    args: z
      .array(z.string().max(MAX_MODEL_PROBE_ARGUMENT_CHARACTERS))
      .max(MAX_MODEL_PROBE_ARGUMENTS)
      .default([]),
    cwd: z.string().max(MAX_MODEL_PATH_CHARACTERS).optional(),
    platforms: z
      .array(z.enum(["darwin", "linux", "win32"]))
      .min(1)
      .max(3)
      .optional(),
  }),
  FileProbeSchema.extend({
    id: z.string().min(1).max(MAX_MODEL_NODE_IDENTIFIER_CHARACTERS),
    path: z.string().min(1).max(MAX_MODEL_PATH_CHARACTERS),
    contains: z.string().min(1).max(MAX_MODEL_PROBE_COMMAND_CHARACTERS).optional(),
  }),
  GitDiffProbeSchema.extend({
    id: z.string().min(1).max(MAX_MODEL_NODE_IDENTIFIER_CHARACTERS),
    baseSha: z.string().min(1).max(MAX_MODEL_NODE_IDENTIFIER_CHARACTERS),
  }),
  RepositoryInventoryProbeSchema.extend({
    id: z.string().min(1).max(MAX_MODEL_NODE_IDENTIFIER_CHARACTERS),
    paths: z
      .array(z.string().min(1).max(MAX_MODEL_PATH_CHARACTERS))
      .min(1)
      .max(MAX_MODEL_NODE_PATHS),
    terms: z
      .array(z.string().min(1).max(MAX_MODEL_PROBE_TERM_CHARACTERS))
      .min(1)
      .max(MAX_MODEL_PROBE_TERMS),
  }),
  GitHubSnapshotProbeSchema.extend({
    id: z.string().min(1).max(MAX_MODEL_NODE_IDENTIFIER_CHARACTERS),
  }),
  HeldOutProbeReferenceSchema.extend({
    id: z.string().min(1).max(MAX_MODEL_NODE_IDENTIFIER_CHARACTERS),
  }),
]);

const ModelOutputWaitConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("time"), wakeAt: z.iso.datetime() }),
  z.strictObject({
    kind: z.literal("file_exists"),
    path: z.string().min(1).max(MAX_MODEL_PATH_CHARACTERS),
    pollIntervalMs: z.number().int().min(250).max(300_000),
    timeoutAt: z.iso.datetime().optional(),
  }),
  z.strictObject({
    kind: z.literal("file_changed"),
    path: z.string().min(1).max(MAX_MODEL_PATH_CHARACTERS),
    pollIntervalMs: z.number().int().min(250).max(300_000),
    timeoutAt: z.iso.datetime().optional(),
  }),
  z.strictObject({
    kind: z.literal("github_pull_request"),
    pollIntervalMs: z.number().int().min(1_000).max(300_000),
    timeoutAt: z.iso.datetime().optional(),
  }),
]);

export const PlannedGraphNodeSchema = GraphNodeSchema.omit({
  outputSchema: true,
  status: true,
}).extend({
  id: z.string().min(1).max(MAX_MODEL_NODE_IDENTIFIER_CHARACTERS),
  objective: z.string().min(1).max(MAX_MODEL_NODE_OBJECTIVE_CHARACTERS),
  dependsOn: z
    .array(z.string().max(MAX_MODEL_NODE_IDENTIFIER_CHARACTERS))
    .max(MAX_MODEL_NODE_REFERENCES),
  scope: z.array(z.string().max(MAX_MODEL_PATH_CHARACTERS)).max(MAX_MODEL_NODE_PATHS),
  contextSelector: z.strictObject({
    includeRepositoryInstructions: z.boolean(),
    predecessorResults: z
      .array(z.string().max(MAX_MODEL_NODE_IDENTIFIER_CHARACTERS))
      .max(MAX_MODEL_NODE_REFERENCES),
    relevantPaths: z.array(z.string().max(MAX_MODEL_PATH_CHARACTERS)).max(MAX_MODEL_NODE_PATHS),
  }),
  progressProbes: z.array(ModelOutputProbeSpecSchema).max(MAX_MODEL_NODE_PROBES),
  completionProbes: z.array(ModelOutputProbeSpecSchema).max(MAX_MODEL_NODE_PROBES),
  waitCondition: ModelOutputWaitConditionSchema.optional(),
});

export const GraphPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    family: z.enum(["bug", "feature", "migration", "refactor", "audit"]),
    nodes: z.array(PlannedGraphNodeSchema).min(1).max(MAX_MODEL_GRAPH_NODES),
  })
  .refine((plan) => JSON.stringify(plan).length <= MAX_MODEL_GRAPH_PLAN_CHARACTERS, {
    message: `Graph plan exceeds ${MAX_MODEL_GRAPH_PLAN_CHARACTERS} characters`,
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

export const SideEffectKindSchema = z.enum([
  "git_commit",
  "git_push",
  "github_pr_create",
  "github_pr_comment",
  "github_review_thread_resolve",
  "github_check_rerun",
]);

export const SideEffectClaimSchema = z.strictObject({
  schemaVersion: z.literal(1),
  actionId: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(1),
  nodeId: z.string().min(1),
  kind: SideEffectKindSchema,
  target: z.string().min(1),
  precondition: z.record(z.string(), z.unknown()),
  claimedAt: z.iso.datetime(),
});

export const SideEffectJournalEntrySchema = z.strictObject({
  claim: SideEffectClaimSchema,
  status: z.enum(["claimed", "confirmed", "failed", "uncertain"]),
  reconciliationAttempts: z.number().int().nonnegative(),
  dispatchedAt: z.iso.datetime().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  evidence: z.array(z.string()).default([]),
  failure: z.string().optional(),
  retryable: z.boolean().optional(),
  childSettlement: z.enum(["confirmed", "unconfirmed"]).optional(),
  updatedAt: z.iso.datetime(),
});

export const WaitRuntimeStateSchema = z.strictObject({
  nodeId: z.string().min(1),
  condition: WaitConditionSchema,
  workspacePath: z.string().min(1),
  status: z.enum(["waiting", "satisfied", "timed_out"]),
  registeredAt: z.iso.datetime(),
  baselineSignature: z.string().optional(),
  bindingBaseSha: z.string().min(7).optional(),
  stickyHumanDecision: z
    .strictObject({
      kind: z.enum(["draft", "changes_requested"]),
      observedAt: z.iso.datetime(),
      snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
      evidence: z.array(z.string().min(1)),
    })
    .optional(),
  lastSignature: z.string().optional(),
  nextWakeAt: z.iso.datetime(),
  observations: z.number().int().nonnegative(),
  evidence: z.array(z.string()).default([]),
  updatedAt: z.iso.datetime(),
});

export const SupervisorRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  supervisorId: z.uuid(),
  runId: z.uuid(),
  repositoryRoot: z.string().min(1),
  pid: z.number().int().positive(),
  host: z.enum(["codex", "claude"]),
  maxWorkers: z.union([z.literal(1), z.literal(2)]),
  status: z.enum(["starting", "running", "exited", "failed"]),
  runStatus: z
    .enum([
      "awaiting_approval",
      "running",
      "waiting",
      "paused",
      "stopped",
      "blocked",
      "completed",
      "failed",
    ])
    .optional(),
  startedAt: z.iso.datetime(),
  heartbeatAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
  logPath: z.string().min(1),
  replacesSupervisorId: z.uuid().optional(),
  message: z.string().optional(),
});

const MAX_HOST_EVENT_TEXT_CHARACTERS = 256 * 1024;
const MAX_HOST_EVENT_DETAIL_CHARACTERS = 16 * 1024;
const MAX_HOST_IDENTIFIER_CHARACTERS = 4 * 1024;
const MAX_WORKER_CHANGED_PATHS = 256;
const MAX_WORKER_PATH_CHARACTERS = 1024;
const MAX_WORKER_EVIDENCE_ITEMS = 64;
const MAX_WORKER_EVIDENCE_CHARACTERS = 4 * 1024;

export const WorkerResultSchema = z.strictObject({
  status: z.enum(["completed", "blocked", "failed"]),
  summary: z.string().max(MAX_HOST_EVENT_DETAIL_CHARACTERS),
  changedPaths: z.array(z.string().max(MAX_WORKER_PATH_CHARACTERS)).max(MAX_WORKER_CHANGED_PATHS),
  evidence: z.array(z.string().max(MAX_WORKER_EVIDENCE_CHARACTERS)).max(MAX_WORKER_EVIDENCE_ITEMS),
  nextSuggestedObjective: z.string().max(MAX_HOST_EVENT_DETAIL_CHARACTERS).optional(),
});

export const MAX_REPOSITORY_INSTRUCTION_FILES = 32;
export const MAX_REPOSITORY_INSTRUCTION_CHARACTERS = 8_000;
export const MAX_REPOSITORY_INSTRUCTION_BYTES = 8_000;
// Keep repository guidance at no more than half of the 24,000-character context capsule.
// The serialized cap includes all path, scope, and import metadata in addition to content.
export const MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS = 12_000;

const UTF8_ENCODER = new TextEncoder();
const RepositoryInstructionPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes("\0"), {
    message: "Repository-instruction metadata cannot contain NUL characters",
  });
const RepositoryInstructionLinkTargetSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"), {
    message: "Repository-instruction metadata cannot contain NUL characters",
  });
const RepositoryInstructionPathListSchema = z
  .array(RepositoryInstructionPathSchema)
  .max(MAX_REPOSITORY_INSTRUCTION_FILES);

function repositoryInstructionContentBytes(value: { entries: Array<{ content: string }> }): number {
  return value.entries.reduce(
    (total, entry) => total + UTF8_ENCODER.encode(entry.content).byteLength,
    0,
  );
}

export const RepositoryInstructionSourceSchema = z.enum([
  "agents",
  "claude",
  "claude_local",
  "claude_project",
  "claude_rule",
  "claude_import",
]);

export function repositoryInstructionSelectionDigest(input: {
  manifestDigest: string;
  selectedPaths: readonly string[];
  omittedPaths: readonly string[];
}): string {
  return contentHash(
    {
      schemaVersion: 1,
      policy: "tracked-shared-v1",
      manifestDigest: input.manifestDigest,
      selectedPaths: input.selectedPaths,
      omittedPaths: input.omittedPaths,
    },
    PORTABLE_CANONICAL_HASH_ALGORITHM,
  );
}

export const RepositoryInstructionEntrySchema = z.strictObject({
  path: RepositoryInstructionPathSchema,
  sources: z.array(RepositoryInstructionSourceSchema).min(1).max(6),
  scopes: z.array(RepositoryInstructionPathSchema).min(1).max(32),
  gitMode: z.string().regex(/^(?:100644|100755|120000)$/),
  workingKind: z.enum(["file", "symlink"]),
  workingMode: z.number().int().nonnegative().max(0o777),
  linkTarget: RepositoryInstructionLinkTargetSchema.optional(),
  importedBy: RepositoryInstructionPathListSchema,
  content: z
    .string()
    .max(MAX_REPOSITORY_INSTRUCTION_CHARACTERS)
    .refine((content) => !content.includes("\0"), {
      message: "Repository instruction content cannot contain NUL characters",
    }),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const RepositoryInstructionManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    policy: z.literal("tracked-shared-v1"),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z.array(RepositoryInstructionEntrySchema).max(MAX_REPOSITORY_INSTRUCTION_FILES),
    coverage: z.strictObject({
      primaryPaths: RepositoryInstructionPathListSchema,
      importedPaths: RepositoryInstructionPathListSchema,
      untrackedSources: z.literal("excluded"),
      userAndManagedSources: z.literal("excluded"),
      externalImports: z.literal("rejected"),
    }),
  })
  .refine(
    (manifest) =>
      JSON.stringify(manifest).length <= MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS,
    {
      message: `Repository-instruction manifest exceeds the ${MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS}-character serialized limit`,
    },
  )
  .refine(
    (manifest) => repositoryInstructionContentBytes(manifest) <= MAX_REPOSITORY_INSTRUCTION_BYTES,
    {
      message: `Repository-instruction manifest exceeds the ${MAX_REPOSITORY_INSTRUCTION_BYTES}-byte content limit`,
    },
  );

export const RepositoryInstructionSelectionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    policy: z.literal("tracked-shared-v1"),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    selectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z.array(RepositoryInstructionEntrySchema).max(MAX_REPOSITORY_INSTRUCTION_FILES),
    selectedPaths: RepositoryInstructionPathListSchema,
    omittedPaths: RepositoryInstructionPathListSchema,
  })
  .refine(
    (selection) =>
      JSON.stringify(selection).length <= MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS,
    {
      message: `Repository-instruction selection exceeds the ${MAX_REPOSITORY_INSTRUCTION_SERIALIZED_CHARACTERS}-character serialized limit`,
    },
  )
  .refine(
    (selection) => repositoryInstructionContentBytes(selection) <= MAX_REPOSITORY_INSTRUCTION_BYTES,
    {
      message: `Repository-instruction selection exceeds the ${MAX_REPOSITORY_INSTRUCTION_BYTES}-byte content limit`,
    },
  )
  .superRefine((selection, context) => {
    for (const [index, entry] of selection.entries.entries())
      if (contentHash(entry.content, PORTABLE_CANONICAL_HASH_ALGORITHM) !== entry.contentHash)
        context.addIssue({
          code: "custom",
          path: ["entries", index, "contentHash"],
          message: `Repository instruction ${entry.path} has an invalid content hash`,
        });

    const entryPaths = selection.entries.map(({ path }) => path);
    if (
      entryPaths.length !== selection.selectedPaths.length ||
      entryPaths.some((path, index) => selection.selectedPaths[index] !== path)
    )
      context.addIssue({
        code: "custom",
        path: ["selectedPaths"],
        message: "Repository-instruction selected paths must exactly match ordered entry paths",
      });
    if (new Set(selection.selectedPaths).size !== selection.selectedPaths.length)
      context.addIssue({
        code: "custom",
        path: ["selectedPaths"],
        message: "Repository-instruction selected paths must be unique",
      });
    if (new Set(selection.omittedPaths).size !== selection.omittedPaths.length)
      context.addIssue({
        code: "custom",
        path: ["omittedPaths"],
        message: "Repository-instruction omitted paths must be unique",
      });
    const omittedPaths = new Set(selection.omittedPaths);
    if (selection.selectedPaths.some((path) => omittedPaths.has(path)))
      context.addIssue({
        code: "custom",
        path: ["omittedPaths"],
        message: "Repository-instruction selected and omitted paths must be disjoint",
      });
    if (repositoryInstructionSelectionDigest(selection) !== selection.selectionDigest)
      context.addIssue({
        code: "custom",
        path: ["selectionDigest"],
        message: "Repository-instruction selection digest is invalid",
      });
  });

export function validateRepositoryInstructionSelection(
  value: unknown,
): z.infer<typeof RepositoryInstructionSelectionSchema> {
  return RepositoryInstructionSelectionSchema.parse(value);
}

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
  repositoryInstructions: RepositoryInstructionSelectionSchema.optional(),
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
  repositoryInstructions: z
    .strictObject({
      manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      selectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
      selectedPaths: RepositoryInstructionPathListSchema,
      omittedPaths: RepositoryInstructionPathListSchema,
    })
    .optional(),
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
  repositoryInstructions: RepositoryInstructionSelectionSchema.optional(),
});

export const SemanticVerdictSchema = z.strictObject({
  verdict: z.enum(["supported", "unsupported", "uncertain"]),
  evidence: z.array(z.string().max(4 * 1024)).max(64),
  rationale: z
    .string()
    .min(1)
    .max(16 * 1024),
  uncertainty: z.number().min(0).max(1),
});

export const UntrustedInputSourceSchema = z.enum([
  "task_or_issue_text",
  "repository_content",
  "command_output",
  "worker_output",
  "review_comment",
  "external_event",
]);

export const ModelAuthorityBoundarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  contentAuthority: z.literal("none"),
  inputs: z
    .array(
      z.strictObject({
        source: UntrustedInputSourceSchema,
        location: z.string().min(1).max(512),
      }),
    )
    .min(1)
    .max(16),
  protectedAuthority: z.strictObject({
    permissions: z.literal("approved_contract"),
    finishLine: z.literal("approved_contract"),
    acceptanceAnchors: z.literal("approved_contract"),
    probes: z.literal("approved_probe_plan"),
    scope: z.literal("approved_contract"),
  }),
});

export const HostCapabilitiesSchema = z.strictObject({
  installed: z.boolean(),
  authenticated: z.boolean(),
  version: z.string().optional(),
  protocolProfile: z.string().min(1).nullable(),
  structuredOutput: z.boolean(),
  streamingEvents: z.boolean(),
  tokenReporting: z.boolean(),
  cancellation: z.boolean(),
  resume: z.boolean(),
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
  z.strictObject({
    type: z.literal("started"),
    invocationId: z.string().max(MAX_HOST_IDENTIFIER_CHARACTERS),
  }),
  z.strictObject({
    type: z.literal("session"),
    hostSessionId: z.string().min(1).max(MAX_HOST_IDENTIFIER_CHARACTERS),
  }),
  z.strictObject({
    type: z.literal("message"),
    text: z.string().max(MAX_HOST_EVENT_TEXT_CHARACTERS),
  }),
  z.strictObject({
    type: z.literal("tool"),
    name: z.string().max(256),
    summary: z.string().max(MAX_HOST_EVENT_DETAIL_CHARACTERS),
  }),
  z.strictObject({ type: z.literal("result"), result: WorkerResultSchema }),
  z.strictObject({ type: z.literal("usage"), usage: TokenUsageSchema }),
  z.strictObject({ type: z.literal("terminated"), termination: HostTerminationSchema }),
  z.strictObject({
    type: z.literal("error"),
    message: z.string().max(MAX_HOST_EVENT_DETAIL_CHARACTERS),
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
  "semantic.started",
  "semantic.verdict",
  "scope.started",
  "scope.checked",
  "probe.process.started",
  "probe.process.finished",
  "probe.process.reconciled",
  "tokens.recorded",
  "optimizer.decided",
  "side_effect.claimed",
  "side_effect.dispatched",
  "side_effect.process.started",
  "side_effect.process.finished",
  "side_effect.process.reconciled",
  "side_effect.reconciled",
  "side_effect.confirmed",
  "side_effect.failed",
  "run.waiting",
  "wait.registered",
  "wait.rebound",
  "wait.human_decision_observed",
  "wait.human_decision_resolved",
  "wait.observed",
  "wait.rearmed",
  "wait.satisfied",
  "wait.timed_out",
  "graph.amended",
]);

export const RunEventV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime(),
  actor: z.enum(["user", "runtime", "worker", "probe", "host"]),
  causationId: z.string().min(1),
  type: RunEventTypeSchema,
  data: z.record(z.string(), z.unknown()),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const RunEventV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  hashAlgorithm: z.literal(PORTABLE_CANONICAL_HASH_ALGORITHM),
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime(),
  actor: z.enum(["user", "runtime", "worker", "probe", "host"]),
  causationId: z.string().min(1),
  type: RunEventTypeSchema,
  data: z.record(z.string(), z.unknown()),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const RunEventSchema = z.discriminatedUnion("schemaVersion", [
  RunEventV1Schema,
  RunEventV2Schema,
]);

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
    "waiting",
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
  sideEffects: z.array(SideEffectJournalEntrySchema).default([]),
  waits: z.array(WaitRuntimeStateSchema).default([]),
  controlDecisions: z.array(ControlDecisionSchema),
  pendingDecision: ControlDecisionPacketSchema.optional(),
  stopReason: z.string().optional(),
  updatedAt: z.iso.datetime(),
});

const RunStorageFormatsV1Schema = z.strictObject({
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
});

export const ArtifactKindSchema = z.enum([
  "artifact",
  "invocation_transcript",
  "invocation_recovery",
  "content_addressed",
  "capsule",
]);

export const ArtifactFormatSchema = z.enum(["binary", "text", "json", "jsonl"]);

export const ArtifactDispositionSchema = z.enum([
  "stored",
  "truncated",
  "omitted",
  "rejected",
  "legacy",
]);

export const ArtifactInventoryReasonSchema = z.enum([
  "artifact_limit",
  "identity_limit",
  "transcript_reserve",
  "run_quota",
  "legacy_migration",
  "missing_on_disk",
]);

const MAX_ARTIFACT_PATH_CHARACTERS = 4 * 1024;
export const MAX_ARTIFACT_INVENTORY_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_INVENTORY_PATH_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_INVENTORY_ENTRIES = 16 * 1024;
const WINDOWS_INVALID_ARTIFACT_SEGMENT = /[\u0000-\u001f<>:"|?*]/u;
const WINDOWS_RESERVED_ARTIFACT_SEGMENT =
  /^(?:aux|clock\$|con|conin\$|conout\$|nul|prn|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const UNPAIRED_SURROGATE = /[\ud800-\udfff]/u;
export function artifactInventorySerializedBytes(value: unknown): number {
  return UTF8_ENCODER.encode(`${JSON.stringify(value, null, 2)}\n`).byteLength;
}

/**
 * Return the platform-independent identity key for an artifact-owned path.
 * Invalid or non-normalized paths have no key and must not be persisted.
 */
export function artifactPathCanonicalKey(path: string): string | undefined {
  if (
    path.length === 0 ||
    path.length > MAX_ARTIFACT_PATH_CHARACTERS ||
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[a-z]:/i.test(path) ||
    UNPAIRED_SURROGATE.test(path)
  )
    return undefined;
  const parts = path.split("/");
  if (
    (parts[0] !== "artifacts" && parts[0] !== "capsules") ||
    parts.length < 2 ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        /[. ]$/u.test(part) ||
        WINDOWS_INVALID_ARTIFACT_SEGMENT.test(part) ||
        WINDOWS_RESERVED_ARTIFACT_SEGMENT.test(part),
    )
  )
    return undefined;
  return parts.map((part) => part.toUpperCase().normalize("NFC")).join("/");
}

export const ArtifactInventoryEntrySchema = z.strictObject({
  path: z.string().min(1).max(MAX_ARTIFACT_PATH_CHARACTERS),
  kind: ArtifactKindSchema,
  format: ArtifactFormatSchema,
  disposition: ArtifactDispositionSchema,
  sourceBytes: z.number().int().nonnegative(),
  storedBytes: z.number().int().nonnegative(),
  omittedBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  legacy: z.boolean(),
  sourceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  storedHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  reason: ArtifactInventoryReasonSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const ArtifactPolicySchema = z
  .strictObject({
    ordinaryArtifactBytes: z.number().int().positive(),
    identityArtifactBytes: z.number().int().positive(),
    capsuleBytes: z.number().int().positive(),
    invocationTranscriptBytes: z.number().int().positive(),
    invocationReservedBytes: z.number().int().positive(),
    runArtifactBytes: z.number().int().positive(),
    runReservedBytes: z.number().int().positive(),
  })
  .superRefine((policy, context) => {
    if (policy.invocationReservedBytes >= policy.invocationTranscriptBytes)
      context.addIssue({
        code: "custom",
        path: ["invocationReservedBytes"],
        message: "invocation reserve is not smaller than its transcript limit",
      });
    if (policy.runReservedBytes >= policy.runArtifactBytes)
      context.addIssue({
        code: "custom",
        path: ["runReservedBytes"],
        message: "run reserve is not smaller than its run quota",
      });
    if (policy.runReservedBytes < policy.invocationReservedBytes)
      context.addIssue({
        code: "custom",
        path: ["runReservedBytes"],
        message: "run reserve is smaller than the invocation recovery reserve",
      });
  });

const ArtifactMutationJournalFields = {
  runId: z.uuid(),
  mutationId: z.uuid(),
  action: z.enum(["write", "delete", "unchanged"]),
  previousInventoryHash: z.string().regex(/^[a-f0-9]{64}$/),
  nextInventoryHash: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().min(1).max(MAX_ARTIFACT_PATH_CHARACTERS),
  previousEntry: ArtifactInventoryEntrySchema.optional(),
  nextEntry: ArtifactInventoryEntrySchema,
  createdAt: z.iso.datetime(),
};

export const ArtifactMutationJournalSchema = z
  .union([
    z.strictObject({
      schemaVersion: z.literal(1),
      ...ArtifactMutationJournalFields,
    }),
    z.strictObject({
      schemaVersion: z.literal(2),
      hashAlgorithm: CanonicalHashAlgorithmSchema,
      ...ArtifactMutationJournalFields,
    }),
  ])
  .superRefine((journal, context) => {
    if (artifactPathCanonicalKey(journal.path) === undefined)
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "mutation path is not a portable artifact-owned path",
      });
    if (journal.nextEntry.path !== journal.path)
      context.addIssue({
        code: "custom",
        path: ["nextEntry", "path"],
        message: "next entry path does not match the mutation path",
      });
    if (journal.previousEntry && journal.previousEntry.path !== journal.path)
      context.addIssue({
        code: "custom",
        path: ["previousEntry", "path"],
        message: "previous entry path does not match the mutation path",
      });
  });

export const ArtifactInventorySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runId: z.uuid(),
    policy: ArtifactPolicySchema,
    sourceBytes: z.number().int().nonnegative(),
    storedBytes: z.number().int().nonnegative(),
    omittedBytes: z.number().int().nonnegative(),
    entries: z.array(ArtifactInventoryEntrySchema).max(MAX_ARTIFACT_INVENTORY_ENTRIES),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((inventory, context) => {
    const paths = new Set<string>();
    let pathBytes = 0;
    let sourceBytes = 0;
    let storedBytes = 0;
    let omittedBytes = 0;
    for (const [index, entry] of inventory.entries.entries()) {
      const issue = (message: string, field?: keyof typeof entry): void =>
        context.addIssue({
          code: "custom",
          path: ["entries", index, ...(field ? [field] : [])],
          message,
        });
      const pathKey = artifactPathCanonicalKey(entry.path);
      if (pathKey === undefined)
        issue(`entry path is not a portable artifact-owned path: ${entry.path}`, "path");
      else if (paths.has(pathKey))
        issue(`entry path aliases another portable path: ${entry.path}`, "path");
      else paths.add(pathKey);
      pathBytes += UTF8_ENCODER.encode(entry.path).byteLength;
      if (entry.sourceBytes !== entry.storedBytes + entry.omittedBytes)
        issue(`entry byte totals do not reconcile: ${entry.path}`);
      if (
        (entry.storedBytes > 0 ||
          entry.disposition === "stored" ||
          entry.disposition === "legacy") &&
        !entry.storedHash
      )
        issue(`stored entry lacks a content hash: ${entry.path}`, "storedHash");
      if (entry.truncated && (entry.omittedBytes === 0 || entry.storedBytes >= entry.sourceBytes))
        issue(`entry truncation metadata is contradictory: ${entry.path}`, "truncated");
      if (
        entry.disposition === "stored" &&
        (entry.storedBytes !== entry.sourceBytes || entry.omittedBytes !== 0 || entry.truncated)
      )
        issue(`stored disposition is contradictory: ${entry.path}`, "disposition");
      if (
        entry.disposition === "truncated" &&
        (entry.storedBytes === 0 || entry.omittedBytes === 0 || !entry.truncated)
      )
        issue(`truncated disposition is contradictory: ${entry.path}`, "disposition");
      if (
        (entry.disposition === "omitted" || entry.disposition === "rejected") &&
        entry.storedBytes !== 0
      )
        issue(`${entry.disposition} disposition stores bytes: ${entry.path}`, "disposition");
      if (
        entry.disposition === "legacy" &&
        (!entry.legacy ||
          entry.reason !== "legacy_migration" ||
          entry.storedBytes !== entry.sourceBytes ||
          entry.omittedBytes !== 0 ||
          entry.truncated)
      )
        issue(`legacy disposition is contradictory: ${entry.path}`, "disposition");
      sourceBytes += entry.sourceBytes;
      storedBytes += entry.storedBytes;
      omittedBytes += entry.omittedBytes;
      if (![sourceBytes, storedBytes, omittedBytes].every(Number.isSafeInteger))
        issue("aggregate byte totals exceed safe integer precision");
    }
    if (pathBytes > MAX_ARTIFACT_INVENTORY_PATH_BYTES)
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "artifact inventory path metadata exceeds its byte limit",
      });
    else if (artifactInventorySerializedBytes(inventory) > MAX_ARTIFACT_INVENTORY_BYTES)
      context.addIssue({
        code: "custom",
        message: "serialized artifact inventory exceeds its byte limit",
      });
    if (
      inventory.sourceBytes !== sourceBytes ||
      inventory.storedBytes !== storedBytes ||
      inventory.omittedBytes !== omittedBytes
    )
      context.addIssue({
        code: "custom",
        message: "aggregate byte totals do not match entries",
      });
    if (inventory.storedBytes > inventory.policy.runArtifactBytes)
      context.addIssue({
        code: "custom",
        path: ["storedBytes"],
        message: "stored bytes exceed the persisted run quota",
      });
  });

const RunStorageFormatsV2Schema = RunStorageFormatsV1Schema.extend({
  artifactInventory: z.literal(1),
  artifactPolicy: z.literal(1),
});

export const RunStorageManifestSchema = z.union([
  z.strictObject({
    schemaVersion: z.literal(1),
    runId: z.uuid(),
    migratedFrom: z.union([z.literal(0), z.literal(1)]),
    formats: RunStorageFormatsV1Schema,
  }),
  z.strictObject({
    schemaVersion: z.literal(2),
    runId: z.uuid(),
    migratedFrom: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    formats: RunStorageFormatsV2Schema,
  }),
  z.strictObject({
    schemaVersion: z.literal(3),
    runId: z.uuid(),
    migratedFrom: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    initialization: z.enum(["initializing", "ready"]),
    canonicalHashAlgorithm: CanonicalHashAlgorithmSchema,
    formats: RunStorageFormatsV2Schema.extend({
      heldOutProbes: z.union([z.literal(1), z.literal(2)]),
      events: z.union([z.literal(1), z.literal(2)]),
      artifactInventory: z.union([z.literal(1), z.literal(2)]),
      // Schema v3 predates this independent domain selector. An omitted field
      // is therefore an explicit legacy-v1 declaration, never a v2 inference.
      workspaceScopeSnapshots: z.union([z.literal(1), z.literal(2)]).default(1),
      // Probe-evidence checkpoints were also persisted before their hashing
      // domain became independent. Omission therefore selects legacy v1.
      probeEvidenceCheckpoints: z.union([z.literal(1), z.literal(2)]).default(1),
      // Governance/control checkpoint identities predate their independent
      // selector. Omission therefore preserves the legacy v1 identity domain.
      governanceControlIdentities: z.union([z.literal(1), z.literal(2)]).default(1),
      // Repository side-effect claims and commit-content preconditions also
      // predate an independent selector. Omission preserves their v1 domain.
      repositorySideEffectIdentities: z.union([z.literal(1), z.literal(2)]).default(1),
      // GitHub snapshots, lifecycle signatures, and mutation journal identities
      // also predate an independent selector. Omission preserves their v1 domain.
      githubMutationLifecycleIdentities: z.union([z.literal(1), z.literal(2)]).default(1),
      // Retention plans and journals also predate an independent identity
      // selector. Omission preserves their legacy v1 identity domain.
      retentionJournalIdentities: z.union([z.literal(1), z.literal(2)]).default(1),
    }),
  }),
]);

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
export type WaitCondition = z.infer<typeof WaitConditionSchema>;
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
export type SideEffectKind = z.infer<typeof SideEffectKindSchema>;
export type SideEffectClaim = z.infer<typeof SideEffectClaimSchema>;
export type SideEffectJournalEntry = z.infer<typeof SideEffectJournalEntrySchema>;
export type WaitRuntimeState = z.infer<typeof WaitRuntimeStateSchema>;
export type SupervisorRecord = z.infer<typeof SupervisorRecordSchema>;
export type WorkerResult = z.infer<typeof WorkerResultSchema>;
export type RepositoryInstructionSource = z.infer<typeof RepositoryInstructionSourceSchema>;
export type RepositoryInstructionEntry = z.infer<typeof RepositoryInstructionEntrySchema>;
export type RepositoryInstructionManifest = z.infer<typeof RepositoryInstructionManifestSchema>;
export type RepositoryInstructionSelection = z.infer<typeof RepositoryInstructionSelectionSchema>;
export type ContextCapsule = z.infer<typeof ContextCapsuleSchema>;
export type ContextSelectionReceipt = z.infer<typeof ContextSelectionReceiptSchema>;
export type SemanticVerifierContext = z.infer<typeof SemanticVerifierContextSchema>;
export type SemanticVerdict = z.infer<typeof SemanticVerdictSchema>;
export type UntrustedInputSource = z.infer<typeof UntrustedInputSourceSchema>;
export type ModelAuthorityBoundary = z.infer<typeof ModelAuthorityBoundarySchema>;
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;
export type InterruptionCause = z.infer<typeof InterruptionCauseSchema>;
export type HostTermination = z.infer<typeof HostTerminationSchema>;
export type RunControlRequest = z.infer<typeof RunControlRequestSchema>;
export type HostEvent = z.infer<typeof HostEventSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type ArtifactFormat = z.infer<typeof ArtifactFormatSchema>;
export type ArtifactDisposition = z.infer<typeof ArtifactDispositionSchema>;
export type ArtifactInventoryReason = z.infer<typeof ArtifactInventoryReasonSchema>;
export type ArtifactInventoryEntry = z.infer<typeof ArtifactInventoryEntrySchema>;
export type ArtifactPolicy = z.infer<typeof ArtifactPolicySchema>;
export type ArtifactInventory = z.infer<typeof ArtifactInventorySchema>;
export type ArtifactMutationJournal = z.infer<typeof ArtifactMutationJournalSchema>;
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
