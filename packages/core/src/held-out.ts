import { contentHash } from "./canonical.ts";
import {
  HeldOutProbePlanSchema,
  ProbePlanSchema,
  type ExecutableProbe,
  type HeldOutProbeIntegrity,
  type HeldOutProbePlan,
  type ProbePlan,
  type ProbeSpec,
} from "./schemas.ts";

export function createHeldOutProbePlan(
  runId: string,
  input: ProbePlan,
  integrity: Record<string, HeldOutProbeIntegrity[]> = {},
): HeldOutProbePlan {
  const plan = ProbePlanSchema.parse(input);
  if (plan.items.some(({ probe }) => probe.kind === "held_out"))
    throw new Error("An approved probe plan cannot contain held-out references");
  const probes = plan.items
    .filter(({ phase }) => phase === "completion")
    .map(({ probe, source }) => {
      if (probe.kind === "held_out") throw new Error("Unreachable held-out probe reference");
      return {
        probe,
        probeHash: contentHash(probe),
        source,
        integrity: integrity[probe.id] ?? [],
      };
    });
  if (probes.length === 0)
    throw new Error("Every finish line requires at least one executable held-out proof");
  const value = { schemaVersion: 1 as const, runId, family: plan.family, probes };
  return validateHeldOutProbePlan(
    HeldOutProbePlanSchema.parse({ ...value, digest: contentHash(value) }),
  );
}

export function validateHeldOutProbePlan(input: HeldOutProbePlan): HeldOutProbePlan {
  const plan = HeldOutProbePlanSchema.parse(input);
  const ids = new Set<string>();
  for (const entry of plan.probes) {
    if (ids.has(entry.probe.id))
      throw new Error(`Held-out completion probe ID ${entry.probe.id} is duplicated`);
    ids.add(entry.probe.id);
    if (entry.probeHash !== contentHash(entry.probe))
      throw new Error(`Held-out completion probe ${entry.probe.id} failed its integrity hash`);
    for (const integrity of entry.integrity) {
      const normalized = integrity.path.replaceAll("\\", "/");
      if (
        normalized.startsWith("/") ||
        /^[a-z]:\//i.test(normalized) ||
        normalized.split("/").includes("..")
      ) {
        throw new Error(`Held-out completion probe ${entry.probe.id} has an unsafe integrity path`);
      }
    }
  }
  const { digest: _digest, ...value } = plan;
  if (plan.digest !== contentHash(value))
    throw new Error("Held-out completion plan failed its integrity hash");
  return plan;
}

export function workerVisibleProbePlan(
  input: ProbePlan,
  heldOutInput: HeldOutProbePlan,
): ProbePlan {
  const probePlan = ProbePlanSchema.parse(input);
  const heldOut = validateHeldOutProbePlan(heldOutInput);
  if (probePlan.family !== heldOut.family)
    throw new Error("Held-out completion probes do not match the task family");
  const byId = new Map(heldOut.probes.map((entry) => [entry.probe.id, entry]));
  return ProbePlanSchema.parse({
    ...probePlan,
    items: probePlan.items.map((item) => {
      if (item.phase !== "completion") return item;
      const entry = byId.get(item.probe.id);
      if (!entry || entry.probeHash !== contentHash(item.probe))
        throw new Error(`Completion probe ${item.probe.id} is not in the held-out plan`);
      return {
        ...item,
        source: `Runtime-held completion proof ${item.probe.id}`,
        probe: {
          id: item.probe.id,
          kind: "held_out" as const,
          planDigest: heldOut.digest,
          probeHash: entry.probeHash,
        },
      };
    }),
  });
}

export function resolveHeldOutProbes(
  input: ProbeSpec[],
  heldOutInput: HeldOutProbePlan,
): ExecutableProbe[] {
  const heldOut = validateHeldOutProbePlan(heldOutInput);
  if (input.length !== heldOut.probes.length)
    throw new Error("The graph omitted or added a held-out completion check");
  const resolved = input.map((probe) => {
    const entry = heldOut.probes.find(({ probe: candidate }) => candidate.id === probe.id);
    if (!entry) throw new Error(`Unknown held-out completion check ${probe.id}`);
    if (probe.kind === "held_out") {
      if (probe.planDigest !== heldOut.digest || probe.probeHash !== entry.probeHash)
        throw new Error(`Held-out completion reference ${probe.id} was substituted`);
    } else if (contentHash(probe) !== entry.probeHash) {
      throw new Error(`Completion check ${probe.id} was weakened or substituted`);
    }
    return entry.probe;
  });
  if (new Set(resolved.map(({ id }) => id)).size !== heldOut.probes.length)
    throw new Error("The graph duplicated a held-out completion check");
  return resolved;
}
