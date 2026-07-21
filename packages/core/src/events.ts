import { contentHash } from "./canonical.ts";
import { RunEventSchema, type RunEvent } from "./schemas.ts";

export type NewRunEvent = Omit<RunEvent, "hash" | "schemaVersion" | "timestamp"> & {
  timestamp?: string;
};

export function createRunEvent(input: NewRunEvent): RunEvent {
  const withoutHash = {
    schemaVersion: 1 as const,
    sequence: input.sequence,
    timestamp: input.timestamp ?? new Date().toISOString(),
    actor: input.actor,
    causationId: input.causationId,
    type: input.type,
    data: input.data,
  };
  return RunEventSchema.parse({ ...withoutHash, hash: contentHash(withoutHash) });
}

export function verifyRunEvent(event: RunEvent): void {
  const parsed = RunEventSchema.parse(event);
  const { hash, ...withoutHash } = parsed;
  if (contentHash(withoutHash) !== hash)
    throw new Error(`Invalid event hash at sequence ${event.sequence}`);
}
