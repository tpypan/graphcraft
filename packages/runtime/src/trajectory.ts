import { randomUUID } from "node:crypto";
import {
  ProgressDecisionPacketSchema,
  ProgressTrajectoryEntrySchema,
  classifyProgress,
  parseEvidenceSnapshot,
  type EvidenceSnapshot,
  type Graph,
  type ProgressClassification,
  type ProgressDecisionPacket,
  type ProgressTrajectoryEntry,
  type RunState,
} from "@graphcraft/core";
import type { RunStore } from "./store.ts";

function probeShape(snapshot: EvidenceSnapshot): string {
  return snapshot.probeResults
    .map(({ probeId, kind }) => `${kind}:${probeId}`)
    .sort()
    .join("|");
}

function concise(value: string, limit = 240): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

export async function assessRunProgress(input: {
  store: RunStore;
  attemptId: string;
  nodeId: string;
  family: Graph["family"];
  strategy: string;
  baseline?: EvidenceSnapshot;
  current: EvidenceSnapshot;
  firstObservation?: ProgressClassification;
}): Promise<{ trajectory: ProgressTrajectoryEntry; alreadyRecorded: boolean }> {
  const state = await input.store.loadState();
  const algorithm = input.store.probeEvidenceCheckpointHashAlgorithm;
  const current = parseEvidenceSnapshot(input.current, input.family, algorithm);
  if (!current)
    throw new Error("Graphcraft cannot validate the current progress evidence checkpoint");
  const requestedBaseline = input.baseline
    ? parseEvidenceSnapshot(input.baseline, input.family, algorithm)
    : undefined;
  if (input.baseline && !requestedBaseline)
    throw new Error("Graphcraft cannot validate the baseline progress evidence checkpoint");
  const progressTrajectory = state.progressTrajectory.map((entry) => {
    const baseline = parseEvidenceSnapshot(entry.baseline, entry.family, algorithm);
    const persistedCurrent = parseEvidenceSnapshot(entry.current, entry.family, algorithm);
    if (!baseline || !persistedCurrent)
      throw new Error(
        `Graphcraft cannot validate the durable progress checkpoint for attempt ${entry.attemptId}`,
      );
    return { ...entry, baseline, current: persistedCurrent };
  });
  const existing = progressTrajectory.findLast(({ attemptId }) => attemptId === input.attemptId);
  if (existing) return { trajectory: existing, alreadyRecorded: true };

  const shape = probeShape(current);
  const comparable = progressTrajectory.filter(
    (entry) => entry.family === input.family && probeShape(entry.current) === shape,
  );
  const previousForNode = comparable.findLast(({ nodeId }) => nodeId === input.nodeId);
  const baseline =
    requestedBaseline ?? previousForNode?.current ?? comparable.at(-1)?.current ?? current;
  const latest = comparable.at(-1);
  const historicalEntries =
    latest &&
    latest.nodeId !== input.nodeId &&
    latest.current.vector.digest === current.vector.digest
      ? comparable.slice(0, -1)
      : comparable;
  const history = historicalEntries.flatMap(({ baseline, current }) => [baseline, current]);
  const classification =
    comparable.length === 0 && input.firstObservation
      ? input.firstObservation
      : classifyProgress(baseline, current, [...history, current]);
  return {
    alreadyRecorded: false,
    trajectory: ProgressTrajectoryEntrySchema.parse({
      schemaVersion: 1,
      attemptId: input.attemptId,
      nodeId: input.nodeId,
      family: input.family,
      strategy: concise(input.strategy),
      classification,
      baseline,
      current,
      recordedAt: new Date().toISOString(),
    }),
  };
}

function invariant(classification: ProgressClassification): string {
  if (classification === "oscillating")
    return "Task evidence returned to a previously observed state after that state had been cleared";
  if (classification === "regressed")
    return "The task-specific progress vector moved away from the approved finish line";
  if (classification === "stalled")
    return "The latest strategy left the task-specific progress vector unchanged";
  if (classification === "blocked")
    return "Available evidence cannot authorize another autonomous strategy";
  return `Autonomous progress ended with classification ${classification}`;
}

export function createProgressDecisionPacket(input: {
  state: RunState;
  nodeId: string;
  classification: ProgressClassification;
  strategy: string;
  blocker: string;
  evidence: string[];
  invariant?: string;
}): ProgressDecisionPacket {
  const attemptedStrategies = [
    ...new Set(
      [...input.state.progressTrajectory.map(({ strategy }) => strategy), concise(input.strategy)]
        .filter(Boolean)
        .slice(-5),
    ),
  ];
  const evidence = [
    ...new Set(
      [
        ...input.state.progressTrajectory
          .slice(-3)
          .flatMap(({ current }) => current.probeResults.map(({ summary }) => concise(summary))),
        ...input.evidence.map((item) => concise(item)),
      ].filter(Boolean),
    ),
  ].slice(-8);
  return ProgressDecisionPacketSchema.parse({
    schemaVersion: 1,
    packetId: randomUUID(),
    nodeId: input.nodeId,
    invariant: input.invariant ?? invariant(input.classification),
    attemptedStrategies,
    evidence,
    blocker: concise(input.blocker),
    choices: [
      {
        action: "amend_strategy",
        description: "Approve an amendment whose strategy changes the named invariant",
      },
      {
        action: "provide_evidence",
        description: "Provide new evidence or a decision that changes the progress vector",
      },
      {
        action: "stop",
        description: "Leave the run stopped with this durable evidence packet",
      },
    ],
    createdAt: new Date().toISOString(),
  });
}
