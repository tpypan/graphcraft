import {
  TokenUsageSchema,
  type TokenAvailabilityStatus,
  type TokenAttributionPhase,
  type TokenLedgerEntry,
  type TokenUsage,
} from "./schemas.ts";

const dimensions = [
  "input",
  "cachedInput",
  "uncachedInput",
  "output",
  "reasoning",
  "total",
] as const;

type TokenDimension = (typeof dimensions)[number];

function reported(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? Math.trunc(candidate)
    : undefined;
}

function status(value: number | undefined): TokenAvailabilityStatus {
  return value === undefined ? "unavailable" : "reported";
}

function derivedStatus(
  required: Array<number | undefined>,
  hasAny: boolean,
): TokenAvailabilityStatus {
  if (required.every((value) => value !== undefined)) return "derived";
  return hasAny ? "estimated" : "unavailable";
}

export function unavailableTokenUsage(): TokenUsage {
  return TokenUsageSchema.parse({
    input: 0,
    cachedInput: 0,
    uncachedInput: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    availability: Object.fromEntries(dimensions.map((dimension) => [dimension, "unavailable"])),
  });
}

export function deterministicTokenUsage(): TokenUsage {
  return TokenUsageSchema.parse({
    input: 0,
    cachedInput: 0,
    uncachedInput: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    availability: Object.fromEntries(dimensions.map((dimension) => [dimension, "derived"])),
  });
}

export function normalizeTokenUsage(provider: "codex" | "claude", value: unknown): TokenUsage {
  const usage =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  if (provider === "codex") {
    const input = reported(usage, "input_tokens");
    const cachedInput = reported(usage, "cached_input_tokens");
    const output = reported(usage, "output_tokens");
    const reasoning = reported(usage, "reasoning_output_tokens");
    const uncachedInput =
      input !== undefined && cachedInput !== undefined
        ? Math.max(0, input - cachedInput)
        : undefined;
    const total = input !== undefined && output !== undefined ? input + output : undefined;
    return TokenUsageSchema.parse({
      input: input ?? 0,
      cachedInput: cachedInput ?? 0,
      uncachedInput: uncachedInput ?? 0,
      output: output ?? 0,
      reasoning: reasoning ?? 0,
      total: total ?? (input ?? 0) + (output ?? 0),
      availability: {
        input: status(input),
        cachedInput: status(cachedInput),
        uncachedInput: input !== undefined && cachedInput !== undefined ? "derived" : "unavailable",
        output: status(output),
        reasoning: status(reasoning),
        total: derivedStatus([input, output], input !== undefined || output !== undefined),
      },
    });
  }

  const directInput = reported(usage, "input_tokens");
  const cacheCreation = reported(usage, "cache_creation_input_tokens");
  const cacheRead = reported(usage, "cache_read_input_tokens");
  const output = reported(usage, "output_tokens");
  const reasoning = reported(usage, "reasoning_output_tokens");
  const inputParts = [directInput, cacheCreation, cacheRead];
  const uncachedParts = [directInput, cacheCreation];
  const input = inputParts.reduce<number>((sum, item) => sum + (item ?? 0), 0);
  const uncachedInput = uncachedParts.reduce<number>((sum, item) => sum + (item ?? 0), 0);
  const inputAvailability = derivedStatus(
    inputParts,
    inputParts.some((item) => item !== undefined),
  );
  const uncachedAvailability = derivedStatus(
    uncachedParts,
    uncachedParts.some((item) => item !== undefined),
  );
  return TokenUsageSchema.parse({
    input,
    cachedInput: cacheRead ?? 0,
    uncachedInput,
    output: output ?? 0,
    reasoning: reasoning ?? 0,
    total: input + (output ?? 0),
    availability: {
      input: inputAvailability,
      cachedInput: status(cacheRead),
      uncachedInput: uncachedAvailability,
      output: status(output),
      reasoning: status(reasoning),
      total:
        output === undefined || inputAvailability === "unavailable"
          ? input > 0 || output !== undefined
            ? "estimated"
            : "unavailable"
          : inputAvailability === "estimated"
            ? "estimated"
            : "derived",
    },
  });
}

const availabilityRank: Record<TokenAvailabilityStatus, number> = {
  reported: 0,
  derived: 1,
  estimated: 2,
  unavailable: 3,
  legacy_unknown: 4,
};

export function aggregateTokenUsage(usages: TokenUsage[]): TokenUsage {
  if (usages.length === 0) return unavailableTokenUsage();
  const values = Object.fromEntries(
    dimensions.map((dimension) => [
      dimension,
      usages.reduce((sum, usage) => sum + usage[dimension], 0),
    ]),
  );
  const availability = Object.fromEntries(
    dimensions.map((dimension) => {
      const worst = usages
        .map((usage) => usage.availability[dimension])
        .sort((left, right) => availabilityRank[right] - availabilityRank[left])[0]!;
      return [dimension, usages.length > 1 && worst === "reported" ? "derived" : worst];
    }),
  );
  return TokenUsageSchema.parse({ ...values, availability });
}

function groupedReport(entries: TokenLedgerEntry[], key: "phase" | "nodeId") {
  const groups = new Map<string, TokenUsage[]>();
  for (const entry of entries) {
    const value = entry[key];
    if (!value) continue;
    const group = groups.get(value) ?? [];
    group.push(entry.usage);
    groups.set(value, group);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, usages]) => [name, aggregateTokenUsage(usages)]),
  );
}

export function tokenCostReport(entries: TokenLedgerEntry[]) {
  const totals = aggregateTokenUsage(entries.map(({ usage }) => usage));
  const limitations = new Set<string>();
  for (const entry of entries)
    for (const dimension of dimensions) {
      const availability = entry.usage.availability[dimension];
      if (["unavailable", "legacy_unknown", "estimated"].includes(availability))
        limitations.add(
          `${entry.phase}${entry.nodeId ? `:${entry.nodeId}` : ""}.${dimension}:${availability}`,
        );
    }
  return {
    receipts: entries.length,
    totals,
    byPhase: groupedReport(entries, "phase") as Partial<Record<TokenAttributionPhase, TokenUsage>>,
    byNode: groupedReport(entries, "nodeId"),
    reconciled: limitations.size === 0,
    limitations: [...limitations].sort(),
  };
}
