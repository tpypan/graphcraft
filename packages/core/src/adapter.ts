import type { ContextCapsule, HostCapabilities, HostEvent, WorkerResult } from "./schemas.ts";

export interface WorkerRequest {
  invocationId: string;
  repositoryPath: string;
  capsule: ContextCapsule;
  allowedTools: string[];
}

export interface InvocationRecord {
  invocationId: string;
  repositoryPath: string;
  startedAt: string;
  hostSessionId?: string;
}

export interface ReconciliationResult {
  state: "not_started" | "in_progress" | "completed" | "unknown";
  result?: WorkerResult;
}

export interface HostAdapter {
  readonly id: "codex" | "claude" | "test";
  probe(): Promise<HostCapabilities>;
  execute(request: WorkerRequest, signal: AbortSignal): AsyncIterable<HostEvent>;
  reconcile(invocation: InvocationRecord): Promise<ReconciliationResult>;
}
