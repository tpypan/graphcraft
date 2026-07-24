import { createHash } from "node:crypto";

export const LEGACY_CANONICAL_HASH_ALGORITHM = "graphcraft-canonical-json-sha256-v1" as const;
export const PORTABLE_CANONICAL_HASH_ALGORITHM = "graphcraft-canonical-json-sha256-v2" as const;

export type CanonicalHashAlgorithm =
  typeof LEGACY_CANONICAL_HASH_ALGORITHM | typeof PORTABLE_CANONICAL_HASH_ALGORITHM;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortValue(value: unknown, algorithm: CanonicalHashAlgorithm): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortValue(entry, algorithm));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) =>
          algorithm === LEGACY_CANONICAL_HASH_ALGORITHM
            ? left.localeCompare(right)
            : compareCodeUnits(left, right),
        )
        .map(([key, entry]) => [key, sortValue(entry, algorithm)]),
    );
  }
  return value;
}

/**
 * Canonical JSON v1 is retained only for durable compatibility. Its ordering
 * depends on the process locale, so new persistence formats must opt into v2.
 */
export function canonicalJson(
  value: unknown,
  algorithm: CanonicalHashAlgorithm = LEGACY_CANONICAL_HASH_ALGORITHM,
): string {
  return JSON.stringify(sortValue(value, algorithm));
}

export function contentHash(
  value: unknown,
  algorithm: CanonicalHashAlgorithm = LEGACY_CANONICAL_HASH_ALGORITHM,
): string {
  return createHash("sha256").update(canonicalJson(value, algorithm)).digest("hex");
}

export function canonicalJsonV2(value: unknown): string {
  return canonicalJson(value, PORTABLE_CANONICAL_HASH_ALGORITHM);
}

export function contentHashV2(value: unknown): string {
  return contentHash(value, PORTABLE_CANONICAL_HASH_ALGORITHM);
}

export function contentMatchesHash(
  value: unknown,
  expectedHash: string,
  algorithm: CanonicalHashAlgorithm,
): boolean {
  return contentHash(value, algorithm) === expectedHash;
}
