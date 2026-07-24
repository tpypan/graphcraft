import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BenchmarkSuiteSchema } from "./benchmark.ts";
import {
  LEGACY_CANONICAL_HASH_ALGORITHM,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  canonicalJson,
  canonicalJsonV2,
  contentHash,
  contentHashV2,
  contentMatchesHash,
} from "./canonical.ts";
import { createRunEvent, verifyRunEvent } from "./events.ts";

describe("versioned canonical hashing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retains the locale-dependent v1 API for durable compatibility", () => {
    const value = { Z: { b: 2, a: 1 }, a: 3 };

    expect(canonicalJson(value)).toBe(canonicalJson(value, LEGACY_CANONICAL_HASH_ALGORITHM));
    expect(contentHash(value)).toBe(contentHash(value, LEGACY_CANONICAL_HASH_ALGORITHM));
  });

  it("orders every nested object by UTF-16 code units in v2", () => {
    const left = { a: 3, Z: { b: 2, a: 1 } };
    const right = { Z: { a: 1, b: 2 }, a: 3 };

    expect(canonicalJsonV2(left)).toBe('{"Z":{"a":1,"b":2},"a":3}');
    expect(canonicalJsonV2(right)).toBe(canonicalJsonV2(left));
    expect(contentHashV2(right)).toBe(contentHashV2(left));
  });

  it("keeps v2 independent from the ambient locale comparator", () => {
    const value = { a: 1, Z: 2, nested: { z: 3, A: 4 } };
    const portableBefore = canonicalJsonV2(value);
    const legacyBefore = canonicalJson(value);
    vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
      this: string,
      other: string,
    ) {
      return String(this) < other ? 1 : String(this) > other ? -1 : 0;
    });

    expect(canonicalJsonV2(value)).toBe(portableBefore);
    expect(canonicalJson(value)).not.toBe(legacyBefore);
  });

  it("stays portable across adversarial English, Swedish, and Turkish collation", () => {
    const value = { z: 1, ä: 2, å: 3, a: 4, I: 5, ı: 6, i: 7, İ: 8 };
    const portable = canonicalJsonV2(value);
    const legacy = new Set<string>();

    for (const locale of ["en-US", "sv-SE", "tr-TR"]) {
      const collator = new Intl.Collator(locale);
      const localeCompare = vi
        .spyOn(String.prototype, "localeCompare")
        .mockImplementation(function (this: string, other: string) {
          return collator.compare(String(this), other);
        });
      legacy.add(canonicalJson(value));
      expect(canonicalJsonV2(value)).toBe(portable);
      localeCompare.mockRestore();
    }

    expect(legacy.size).toBeGreaterThan(1);
  });

  it("verifies only the explicitly selected algorithm", () => {
    const value = { a: 1, Z: 2 };
    const legacyHash = contentHash(value, LEGACY_CANONICAL_HASH_ALGORITHM);
    const portableHash = contentHash(value, PORTABLE_CANONICAL_HASH_ALGORITHM);

    expect(legacyHash).not.toBe(portableHash);
    expect(contentMatchesHash(value, legacyHash, LEGACY_CANONICAL_HASH_ALGORITHM)).toBe(true);
    expect(contentMatchesHash(value, legacyHash, PORTABLE_CANONICAL_HASH_ALGORITHM)).toBe(false);
    expect(contentMatchesHash(value, portableHash, PORTABLE_CANONICAL_HASH_ALGORITHM)).toBe(true);
  });

  it("self-identifies portable event rows without changing legacy rows", () => {
    const input = {
      sequence: 1,
      timestamp: "2026-07-24T00:00:00.000Z",
      actor: "runtime" as const,
      causationId: "canonical-test",
      type: "run.blocked" as const,
      data: { Z: "first by code unit", a: "first by locale" },
    };
    const legacy = createRunEvent(input);
    const portable = createRunEvent(input, PORTABLE_CANONICAL_HASH_ALGORITHM);

    expect(legacy.schemaVersion).toBe(1);
    expect("hashAlgorithm" in legacy).toBe(false);
    expect(portable).toMatchObject({
      schemaVersion: 2,
      hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
    });
    expect(portable.hash).not.toBe(legacy.hash);
    expect(() => verifyRunEvent(legacy)).not.toThrow();
    expect(() => verifyRunEvent(portable)).not.toThrow();
  });

  it("pins the legacy and portable stable-v1 suite identities", () => {
    const source = JSON.parse(
      readFileSync(new URL("../../../benchmarks/stable-v1.json", import.meta.url), "utf8"),
    ) as unknown;
    const parsed = BenchmarkSuiteSchema.parse(source);

    expect(contentHash(source)).toBe(
      "6ce0f20496e8382544d57636937ac583402831abbc0118a035f17800dfaeb70e",
    );
    expect(contentHashV2(source)).toBe(
      "71f24854cf9e204b797cb04c5466ac5188cab2e5460584e47a1b2230d365f50a",
    );
    expect(contentHash(parsed)).toBe(
      "ad3b673a85c49811d9d661d74a7289bc31c3a42ccb38a44d51ce0f4f4f017fc4",
    );
    expect(contentHashV2(parsed)).toBe(
      "dad4d657c9dc75b129b635d95e48416f43980a1329bff7bcab88b0e94abd65fe",
    );
  });
});
