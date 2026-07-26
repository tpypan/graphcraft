import { ModelAuthorityBoundarySchema } from "./schemas.ts";
import type {
  ContextCapsule,
  GraphPlan,
  HostCapabilities,
  HostEvent,
  ProbePlan,
  ProbeSpec,
  RepositoryInstructionSelection,
  RunContract,
  SemanticVerifierContext,
  SemanticVerdict,
  TokenUsage,
  ModelAuthorityBoundary,
  UntrustedInputSource,
  WorkerResult,
} from "./schemas.ts";
import type { EvidenceSnapshot } from "./schemas.ts";

export interface PlanningRequest {
  contract: RunContract;
  repositoryPath: string;
  repositoryEvidence: RepositoryPlanningEvidence;
  probePlan: ProbePlan;
  verificationProbes: ProbeSpec[];
  repositoryInstructions?: RepositoryInstructionSelection;
  authorityBoundary?: ModelAuthorityBoundary;
}

export interface RepositoryEvidenceFile {
  path: string;
  content: string;
  truncated: boolean;
}

export interface RepositoryPlanningEvidence {
  contentTrust: "untrusted_repository";
  trackedPathCount: number;
  trackedPaths: string[];
  trackedPathsTruncated: boolean;
  files: RepositoryEvidenceFile[];
}

export interface HostExecutionPolicy {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh";
}

export interface PlanningResult {
  plan: GraphPlan;
  usage?: TokenUsage;
}

export interface GraphPlanner {
  readonly id: "codex" | "claude" | "test";
  readonly containmentProfile?: string;
  probe(signal?: AbortSignal): Promise<HostCapabilities>;
  plan(request: PlanningRequest, signal: AbortSignal): Promise<PlanningResult>;
}

export interface WorkerRequest {
  invocationId: string;
  repositoryPath: string;
  capsule: ContextCapsule;
  allowedTools: string[];
  resumeSessionId?: string;
  authorityBoundary?: ModelAuthorityBoundary;
}

export interface SemanticVerificationRequest {
  invocationId: string;
  repositoryPath: string;
  context: SemanticVerifierContext;
  authorityBoundary?: ModelAuthorityBoundary;
}

export function createModelAuthorityBoundary(
  inputs: Array<{ source: UntrustedInputSource; location: string }>,
): ModelAuthorityBoundary {
  const unique = [
    ...new Map(inputs.map((input) => [`${input.source}\0${input.location}`, input])).values(),
  ];
  return ModelAuthorityBoundarySchema.parse({
    schemaVersion: 1,
    contentAuthority: "none",
    inputs: unique,
    protectedAuthority: {
      permissions: "approved_contract",
      finishLine: "approved_contract",
      acceptanceAnchors: "approved_contract",
      probes: "approved_probe_plan",
      scope: "approved_contract",
    },
  });
}

export interface SemanticVerificationResult {
  verdict: SemanticVerdict;
  usage?: TokenUsage;
}

export interface InvocationRecord {
  invocationId: string;
  repositoryPath: string;
  startedAt: string;
  hostSessionId?: string;
  baseline?: EvidenceSnapshot;
  transcript?: HostEvent[];
  capsuleHash?: string;
  repositoryInstructionManifestDigest?: string;
  repositoryInstructionSelectionDigest?: string;
  containmentProfile?: string;
  instructionManifestPinned?: boolean;
}

export interface ReconciliationResult {
  state: "not_started" | "in_progress" | "completed" | "unknown";
  result?: WorkerResult;
}

export interface HostAdapter extends GraphPlanner {
  execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent>;
  verify(
    request: SemanticVerificationRequest,
    signal: AbortSignal,
  ): Promise<SemanticVerificationResult>;
  reconcile(invocation: InvocationRecord): Promise<ReconciliationResult>;
}

export function reconcilePersistedInvocation(invocation: InvocationRecord): ReconciliationResult {
  const result = invocation.transcript?.findLast((event) => event.type === "result");
  if (result?.type === "result") return { state: "completed", result: result.result };
  if (invocation.hostSessionId) return { state: "in_progress" };
  return { state: "not_started" };
}
