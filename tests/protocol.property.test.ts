import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  BenchmarkReportSchema,
  GraphSchema,
  RunContractSchema,
  RunEventSchema,
  RunStorageManifestSchema,
  applyGraphAmendment,
  canonicalJson,
  compileGraph,
  compileRunContract,
  contentHash,
  createRunEvent,
  graphPlanShape,
  readyNodes,
  reduceEvents,
  summarizeBenchmark,
  validateGraph,
  verifyRunEvent,
  type ControlDecision,
  type Graph,
  type GraphNode,
  type PlannedGraphNode,
  type ProbeSpec,
  type RunContract,
  type RunEvent,
  type RunState,
} from "../packages/core/src/index.ts";
import { evaluateControlAcceptance, groundedRelevantPaths } from "../packages/runtime/src/index.ts";
import { describe, expect, it } from "vitest";

const protocolFixtures = fileURLToPath(new URL("./fixtures/protocol", import.meta.url));
const releasedStorageFixtures = fileURLToPath(
  new URL("../packages/runtime/src/fixtures/storage", import.meta.url),
);
const completionProbe = {
  id: "protocol-acceptance",
  kind: "file",
  path: "package.json",
  shouldExist: true,
} as const satisfies ProbeSpec;

function generatedUuid(seed: number): string {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const output = [...values];
  const next = random(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [output[index], output[swap]] = [output[swap]!, output[index]!];
  }
  return output;
}

function generatedContract(seed: number): RunContract {
  return RunContractSchema.parse({
    schemaVersion: 1,
    runId: generatedUuid(seed),
    task: `Implement generated protocol case ${seed}`,
    outcome: `Generated protocol case ${seed} is accepted`,
    finishLine: { kind: "local_verified" },
    repository: {
      root: `/fixture/generated-${seed}`,
      baseRef: "main",
      baseSha: seed.toString(16).padStart(40, "a").slice(-40),
    },
    scope: { include: ["**/*"], exclude: [".git/**", ".graphcraft/**"] },
    permissions: ["read_repository", "write_repository", "run_commands", "create_worktree"],
    acceptanceAnchors: [
      {
        id: "user-outcome",
        description: "Generated outcome",
        owner: "user",
        evidenceSource: "generated contract",
        mutationPolicy: "user_approval",
      },
      {
        id: "repository-policy",
        description: "Generated repository policy",
        owner: "repository",
        evidenceSource: "generated repository state",
        mutationPolicy: "immutable",
      },
    ],
  });
}

function generatedNode(id: string, dependsOn: string[]): GraphNode {
  return {
    id,
    kind: "investigation",
    objective: `Inspect ${id}`,
    dependsOn,
    scope: ["src/**"],
    contextSelector: {
      includeRepositoryInstructions: true,
      predecessorResults: dependsOn,
      relevantPaths: [`src/${id}.ts`],
    },
    outputSchema: { type: "object" },
    progressProbes: [],
    completionProbes: [],
    sideEffectClass: "none",
    status: "pending",
  };
}

function generatedDag(seed: number): Graph {
  const count = 4 + (seed % 9);
  const next = random(seed);
  const nodes = Array.from({ length: count }, (_, index) => {
    const preceding = Array.from({ length: index }, (__, dependency) => `node-${dependency}`);
    const selected = preceding
      .filter(() => next() > 0.55)
      .slice(0, 3)
      .sort();
    const dependsOn = index < 2 ? [] : selected.length > 0 ? selected : [preceding[seed % index]!];
    return generatedNode(`node-${index}`, dependsOn);
  });
  return GraphSchema.parse({
    schemaVersion: 1,
    runId: generatedUuid(seed),
    family: "audit",
    nodes,
    anchors: [
      {
        id: "repository-policy",
        description: "Generated repository policy",
        owner: "repository",
        evidenceSource: "generated repository state",
        mutationPolicy: "immutable",
      },
    ],
    controlEdges: nodes.map(({ id }) => ({
      from: "repository-policy",
      to: id,
      relation: "vetoes" as const,
    })),
    revision: 0,
  });
}

function readyLayers(graph: Graph): string[][] {
  const accepted = new Set<string>();
  const layers: string[][] = [];
  while (accepted.size < graph.nodes.length) {
    const ready = readyNodes(graph, accepted)
      .map(({ id }) => id)
      .sort();
    if (ready.length === 0) throw new Error("generated graph stopped before all nodes were ready");
    layers.push(ready);
    ready.forEach((id) => accepted.add(id));
  }
  return layers;
}

function generatedEventStream(seed: number): RunEvent[] {
  const contract = generatedContract(seed);
  const nodeIds = Array.from({ length: 1 + (seed % 7) }, (_, index) => `work-${index}`);
  const inputs: Array<Omit<RunEvent, "schemaVersion" | "hash">> = [
    {
      sequence: 1,
      timestamp: "2026-07-22T12:00:00.000Z",
      actor: "runtime",
      causationId: contract.runId,
      type: "run.created",
      data: { contract, nodeIds },
    },
    {
      sequence: 2,
      timestamp: "2026-07-22T12:00:01.000Z",
      actor: "user",
      causationId: contract.runId,
      type: "run.approved",
      data: { approved: true },
    },
  ];
  for (const [index, nodeId] of nodeIds.entries()) {
    const sequence = inputs.length + 1;
    inputs.push(
      {
        sequence,
        timestamp: `2026-07-22T12:01:${String(index * 3).padStart(2, "0")}.000Z`,
        actor: "runtime",
        causationId: contract.runId,
        type: "node.started",
        data: { nodeId },
      },
      {
        sequence: sequence + 1,
        timestamp: `2026-07-22T12:01:${String(index * 3 + 1).padStart(2, "0")}.000Z`,
        actor: "probe",
        causationId: contract.runId,
        type: "node.progress",
        data: {
          nodeId,
          classification: "done",
          summary: `generated-${seed}-${index}`,
          evidence: [`evidence-${seed}-${index}`],
        },
      },
      {
        sequence: sequence + 2,
        timestamp: `2026-07-22T12:01:${String(index * 3 + 2).padStart(2, "0")}.000Z`,
        actor: "runtime",
        causationId: contract.runId,
        type: "node.accepted",
        data: { nodeId, summary: `generated-${seed}-${index}` },
      },
    );
  }
  inputs.push({
    sequence: inputs.length + 1,
    timestamp: "2026-07-22T12:02:00.000Z",
    actor: "runtime",
    causationId: contract.runId,
    type: "run.completed",
    data: {},
  });
  return inputs.map((input) => createRunEvent(input));
}

function plannedSplitNode(id: string): PlannedGraphNode {
  return {
    id,
    kind: "implementation",
    objective: `Implement ${id}`,
    dependsOn: [],
    scope: ["**/*"],
    contextSelector: {
      includeRepositoryInstructions: true,
      predecessorResults: [],
      relevantPaths: [`src/${id}.ts`],
    },
    progressProbes: [],
    completionProbes: [],
    sideEffectClass: "workspace_write",
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("versioned protocol fixtures", () => {
  it("round-trips contracts, graphs, events, reports, and every storage manifest version", async () => {
    const contract = RunContractSchema.parse(
      await readJson(join(protocolFixtures, "contract.v1.json")),
    );
    const graph = GraphSchema.parse(await readJson(join(protocolFixtures, "graph.v1.json")));
    validateGraph(graph);
    expect(graph.runId).toBe(contract.runId);

    const events = (await readFile(join(protocolFixtures, "events.v1.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => RunEventSchema.parse(JSON.parse(line)));
    events.forEach(verifyRunEvent);
    expect(events[0]?.data.contract).toEqual(contract);
    expect(events[0]?.data.graph).toEqual(graph);
    expect(reduceEvents(events)).toMatchObject({ status: "completed", lastEventSequence: 9 });

    const reports = await Promise.all(
      [2, 3].map(async (version) =>
        BenchmarkReportSchema.parse(
          await readJson(join(protocolFixtures, `benchmark-report.v${version}.json`)),
        ),
      ),
    );
    expect(reports.map(({ schemaVersion }) => schemaVersion)).toEqual([2, 3]);
    for (const report of reports) {
      expect(report.environment.graphcraftVersion).toBe("0.1.2");
      expect(report.summary).toEqual(summarizeBenchmark(report.results, report.schedule));
      expect(BenchmarkReportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
    }

    const manifests = await Promise.all(
      [1, 2].map(async (version) =>
        RunStorageManifestSchema.parse(
          await readJson(join(protocolFixtures, `storage-manifest.v${version}.json`)),
        ),
      ),
    );
    expect(manifests.map(({ schemaVersion }) => schemaVersion)).toEqual([1, 2]);
  });

  it("validates every checked-in signed-release storage fixture through current schemas", async () => {
    const releases = (await readdir(releasedStorageFixtures, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name))
      .map(({ name }) => name)
      .sort();
    expect(releases).toEqual(expect.arrayContaining(["v0.1.0", "v0.1.1"]));

    for (const release of releases) {
      const root = join(releasedStorageFixtures, release);
      const metadata = (await readJson(join(root, "fixture.json"))) as Record<string, unknown>;
      expect(metadata).toMatchObject({ tag: release });
      expect(metadata.commit).toMatch(/^[a-f0-9]{40}$/);
      const contract = RunContractSchema.parse(await readJson(join(root, "run", "contract.json")));
      const graph = GraphSchema.parse(await readJson(join(root, "run", "graph.json")));
      validateGraph(graph);
      const events = (await readFile(join(root, "run", "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => RunEventSchema.parse(JSON.parse(line)));
      events.forEach(verifyRunEvent);
      expect(graph.runId).toBe(contract.runId);
      expect(reduceEvents(events).status).toBe("completed");
    }
  });
});

describe("deterministic generated protocol properties", () => {
  it("canonical hashes ignore object insertion order and detect generated mutations", () => {
    for (let seed = 1; seed <= 128; seed += 1) {
      const entries = Array.from(
        { length: 3 + (seed % 8) },
        (_, index) =>
          [
            `field-${index}`,
            {
              enabled: (seed + index) % 2 === 0,
              values: [seed, index, `case-${seed}-${index}`],
            },
          ] as const,
      );
      const left = Object.fromEntries(shuffled(entries, seed));
      const right = Object.fromEntries(shuffled(entries, seed * 17));
      expect(canonicalJson(left)).toBe(canonicalJson(right));
      expect(contentHash(left)).toBe(contentHash(right));
      expect(contentHash({ ...right, mutation: seed })).not.toBe(contentHash(left));
    }

    const first = createRunEvent({
      sequence: 1,
      timestamp: "2026-07-22T12:00:00.000Z",
      actor: "runtime",
      causationId: "hash-order",
      type: "run.blocked",
      data: { alpha: 1, beta: { left: true, right: false } },
    });
    const reordered = createRunEvent({
      sequence: 1,
      timestamp: first.timestamp,
      actor: "runtime",
      causationId: "hash-order",
      type: "run.blocked",
      data: { beta: { right: false, left: true }, alpha: 1 },
    });
    expect(reordered.hash).toBe(first.hash);
    expect(() => verifyRunEvent({ ...first, data: { ...first.data, alpha: 2 } })).toThrow(
      /Invalid event hash/,
    );
  });

  it("replays generated event streams identically and rejects gaps or tampering", () => {
    for (let seed = 1; seed <= 64; seed += 1) {
      const events = generatedEventStream(seed);
      const replayed = reduceEvents(events);
      const reparsed = reduceEvents(JSON.parse(JSON.stringify(events)) as RunEvent[]);
      expect(canonicalJson(reparsed)).toBe(canonicalJson(replayed));
      expect(replayed).toMatchObject({
        status: "completed",
        lastEventSequence: events.length,
      });
      expect(Object.values(replayed.nodes).every(({ status }) => status === "accepted")).toBe(true);

      const missing = events.filter((__, index) => index !== 1);
      expect(() => reduceEvents(missing)).toThrow(/Expected event sequence 2/);
      const tampered = structuredClone(events);
      tampered.at(-2)!.data.summary = `tampered-${seed}`;
      expect(() => reduceEvents(tampered)).toThrow(/Invalid event hash/);
    }
  });

  it("accepts generated DAGs independent of storage order and rejects cycles", () => {
    for (let seed = 1; seed <= 96; seed += 1) {
      const graph = generatedDag(seed);
      validateGraph(graph);
      const reordered = GraphSchema.parse({ ...graph, nodes: shuffled(graph.nodes, seed * 31) });
      validateGraph(reordered);
      expect(readyLayers(reordered)).toEqual(readyLayers(graph));
      expect(graphPlanShape(graph).length).toBeGreaterThan(0);
      expect(readyLayers(graph)[0]).toEqual(["node-0", "node-1"]);

      const cyclic = structuredClone(graph);
      cyclic.nodes[0]!.dependsOn = [cyclic.nodes[1]!.id];
      cyclic.nodes[1]!.dependsOn = [cyclic.nodes[0]!.id];
      expect(() => validateGraph(cyclic)).toThrow(/dependency cycle/);
    }
  });

  it("preserves anchors and accepted work across generated graph amendments", () => {
    for (let seed = 1; seed <= 48; seed += 1) {
      const contract = compileRunContract(`Implement generated amendment ${seed}`, {
        root: `/fixture/amendment-${seed}`,
        baseRef: "main",
        baseSha: "a".repeat(40),
      });
      const graph = compileGraph(contract, [completionProbe]);
      const leftId = `split-${seed}-a`;
      const rightId = `split-${seed}-b`;
      const amendment = {
        schemaVersion: 1 as const,
        amendmentId: generatedUuid(10_000 + seed),
        operations: [
          {
            operation: "split" as const,
            targetId: "implement",
            replacements: [plannedSplitNode(leftId), plannedSplitNode(rightId)],
          },
        ],
        evidence: [`generated evidence ${seed}`],
        rationale: "Generated independent scopes require an explicit split",
        changedStrategy: `Split generated implementation strategy ${seed}`,
        falsifiableExpectation: "Both generated branches become verification dependencies",
      };
      const amended = applyGraphAmendment({
        graph,
        contract,
        amendment,
        actor: "runtime",
        nodeStatuses: { implement: { status: "pending" }, verify: { status: "pending" } },
        requiredVerificationProbes: [completionProbe],
      });
      validateGraph(amended.graph);
      expect(amended.graph.anchors).toEqual(graph.anchors);
      expect(amended.graph.revision).toBe(1);
      expect(amended.diff.addedNodeIds).toEqual([leftId, rightId]);
      expect(amended.diff.removedNodeIds).toEqual(["implement"]);
      expect(amended.graph.nodes.find(({ id }) => id === "verify")?.dependsOn.sort()).toEqual(
        [leftId, rightId].sort(),
      );
      expect(() =>
        applyGraphAmendment({
          graph,
          contract,
          amendment,
          actor: "runtime",
          nodeStatuses: { implement: { status: "accepted" }, verify: { status: "pending" } },
          requiredVerificationProbes: [completionProbe],
        }),
      ).toThrow(/Accepted node implement is immutable/);
    }
  });

  it("enforces generated control vetoes and records observer evidence", async () => {
    for (let seed = 1; seed <= 32; seed += 1) {
      const contract = compileRunContract(`Implement generated control case ${seed}`, {
        root: `/fixture/control-${seed}`,
        baseRef: "main",
        baseSha: "b".repeat(40),
      });
      const graph = compileGraph(contract, [completionProbe]);
      const state = reduceEvents([
        createRunEvent({
          sequence: 1,
          timestamp: "2026-07-22T12:00:00.000Z",
          actor: "runtime",
          causationId: contract.runId,
          type: "run.created",
          data: { contract, nodeIds: graph.nodes.map(({ id }) => id) },
        }),
      ]);
      const verdict = seed % 2 === 0 ? "approve" : "veto";
      const decision: ControlDecision = {
        schemaVersion: 1,
        decisionId: generatedUuid(20_000 + seed),
        sourceId: "runtime-verifier",
        targetId: "implement",
        verdict,
        rationale: `Generated ${verdict}`,
        evidence: [`control-${seed}`],
        actor: "verifier",
        sticky: false,
        decidedAt: "2026-07-22T12:00:01.000Z",
      };
      const generatedState: RunState = { ...state, controlDecisions: [decision] };
      const appended: Array<{ type: string; data: Record<string, unknown> }> = [];
      const store = {
        loadState: async () => generatedState,
        append: async (
          _actor: string,
          type: string,
          data: Record<string, unknown>,
        ): Promise<void> => {
          appended.push({ type, data });
        },
      } as unknown as Parameters<typeof evaluateControlAcceptance>[0];

      const result = await evaluateControlAcceptance(store, graph, generatedState, "implement", [
        `acceptance-${seed}`,
      ]);
      expect(result.allowed).toBe(verdict === "approve");
      expect(appended.filter(({ type }) => type === "control.observed")).toHaveLength(1);
      expect(appended.some(({ type }) => type === "control.resolved")).toBe(true);
    }
  });

  it("selects generated context deterministically across path ordering and duplicates", () => {
    for (let seed = 1; seed <= 128; seed += 1) {
      const paths = [
        `src/widget-${seed}/handler.ts`,
        `tests/widget-${seed}/handler.test.ts`,
        "package.json",
        "src/shared/helpers.ts",
        "docs/notes.md",
        "dist/widget.js",
        "dist/widget.js.map",
        "pnpm-lock.yaml",
        `src/widget-${seed}/handler.ts`,
      ];
      const objective = `Repair widget-${seed} handler behavior`;
      const first = groundedRelevantPaths(shuffled(paths, seed), objective);
      const second = groundedRelevantPaths(shuffled(paths, seed * 43), objective);
      expect(first).toEqual(second);
      expect(first[0]).toBe(`src/widget-${seed}/handler.ts`);
      expect(first.length).toBeLessThanOrEqual(4);
      expect(first).not.toContain("dist/widget.js");
      expect(first).not.toContain("dist/widget.js.map");
      expect(first).not.toContain("pnpm-lock.yaml");
      expect(new Set(first).size).toBe(first.length);
    }
  });
});
