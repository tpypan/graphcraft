import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  contentHash,
  type CanonicalHashAlgorithm,
} from "./canonical.ts";
import { RunEventSchema, type RunEvent } from "./schemas.ts";

export type NewRunEvent = Pick<RunEvent, "sequence" | "actor" | "causationId" | "type" | "data"> & {
  timestamp?: string;
};

export function createRunEvent(
  input: NewRunEvent,
  algorithm: CanonicalHashAlgorithm = LEGACY_CANONICAL_HASH_ALGORITHM,
): RunEvent {
  const common = {
    sequence: input.sequence,
    timestamp: input.timestamp ?? new Date().toISOString(),
    actor: input.actor,
    causationId: input.causationId,
    type: input.type,
    data: input.data,
  };
  const withoutHash =
    algorithm === PORTABLE_CANONICAL_HASH_ALGORITHM
      ? {
          schemaVersion: 2 as const,
          hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
          ...common,
        }
      : { schemaVersion: 1 as const, ...common };
  return RunEventSchema.parse({ ...withoutHash, hash: contentHash(withoutHash, algorithm) });
}

export function verifyRunEvent(event: RunEvent): void {
  const parsed = RunEventSchema.parse(event);
  const { hash, ...withoutHash } = parsed;
  const algorithm =
    parsed.schemaVersion === 1
      ? LEGACY_CANONICAL_HASH_ALGORITHM
      : PORTABLE_CANONICAL_HASH_ALGORITHM;
  if (contentHash(withoutHash, algorithm) !== hash)
    throw new Error(`Invalid event hash at sequence ${event.sequence}`);
}
