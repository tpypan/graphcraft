import type {
  ContextCapsule,
  GraphPlan,
  HostCapabilities,
  HostEvent,
  ProbePlan,
  ProbeSpec,
  RunContract,
  SemanticVerifierContext,
  SemanticVerdict,
  TokenUsage,
  WorkerResult,
} from "./schemas.ts";
import type { EvidenceSnapshot } from "./schemas.ts";

export interface PlanningRequest {
  contract: RunContract;
  repositoryPath: string;
  repositoryEvidence: RepositoryPlanningEvidence;
  probePlan: ProbePlan;
  verificationProbes: ProbeSpec[];
}

export interface RepositoryEvidenceFile {
  path: string;
  content: string;
  truncated: boolean;
}

export interface RepositoryPlanningEvidence {
  trackedPathCount: number;
  trackedPaths: string[];
  trackedPathsTruncated: boolean;
  files: RepositoryEvidenceFile[];
}

export interface PlanningResult {
  plan: GraphPlan;
  usage?: TokenUsage;
}

export interface GraphPlanner {
  readonly id: "codex" | "claude" | "test";
  probe(): Promise<HostCapabilities>;
  plan(request: PlanningRequest, signal: AbortSignal): Promise<PlanningResult>;
}

export interface WorkerRequest {
  invocationId: string;
  repositoryPath: string;
  capsule: ContextCapsule;
  allowedTools: string[];
  resumeSessionId?: string;
}

export interface SemanticVerificationRequest {
  invocationId: string;
  repositoryPath: string;
  context: SemanticVerifierContext;
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
