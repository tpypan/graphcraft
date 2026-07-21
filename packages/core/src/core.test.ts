import { describe, expect, it } from "vitest";
import {
  classifyProgress,
  classifyTask,
  compileGraph,
  compilePlannedGraph,
  compileRunContract,
  createRunEvent,
  evidenceSnapshot,
  graphPlanShape,
  reduceEvents,
  semanticVerdictJsonSchema,
  validateGraph,
  verifyRunEvent,
  workerResultJsonSchema,
  type GraphPlan,
  type ProbeResult,
} from "./index.ts";

const repository = {
  root: "/tmp/example",
  remote: "https://example.test/repo.git",
  baseRef: "main",
  baseSha: "abc123",
};

describe("run contracts and graphs", () => {
  it("classifies task families without matching keyword substrings", () => {
    expect(classifyTask("Implement a substantial feature across the fixture")).toBe("feature");
    expect(classifyTask("Fix the failing feature")).toBe("bug");
  });

  it("infers an immutable committed contract and a dependency-safe graph", () => {
    const contract = compileRunContract(
      "Migrate every client and commit the verified result",
      repository,
    );
    const graph = compileGraph(contract, [
      {
        id: "tests",
        kind: "command",
        command: "npm",
        args: ["test"],
        expectedExitCode: 0,
        timeoutMs: 1_000,
      },
    ]);

    expect(contract.finishLine.kind).toBe("committed");
    expect(contract.permissions).toContain("commit");
    expect(graph.family).toBe("migration");
    expect(graph.nodes.map(({ id }) => id)).toEqual(["implement", "verify", "commit"]);
    expect(() => validateGraph(graph)).not.toThrow();
  });

  it("rejects a dependency cycle", () => {
    const contract = compileRunContract("Implement a substantial new feature", repository);
    const graph = compileGraph(contract, []);
    graph.nodes[0]!.dependsOn = ["verify"];
    expect(() => validateGraph(graph)).toThrow(/cycle/);
  });

  it("exports a strict worker JSON schema", () => {
    expect(workerResultJsonSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(semanticVerdictJsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });

  it("compiles a host-proposed graph without ceding contract or finish-line control", () => {
    const contract = compileRunContract("Migrate every v2 client to v3", repository);
    const verificationProbe = {
      id: "tests",
      kind: "command" as const,
      command: "npm",
      args: ["test"],
      expectedExitCode: 0,
      timeoutMs: 1_000,
    };
    const plan: GraphPlan = {
      schemaVersion: 1,
      family: "migration",
      nodes: [
        {
          id: "inventory",
          kind: "investigation",
          objective: "Inventory every v2 client call and the applicable repository policy",
          dependsOn: [],
          scope: ["src/**"],
          contextSelector: {
            includeRepositoryInstructions: true,
            predecessorResults: [],
            relevantPaths: ["src"],
          },
          progressProbes: [],
          completionProbes: [],
          sideEffectClass: "none",
        },
        {
          id: "migrate",
          kind: "implementation",
          objective: "Migrate the inventoried v2 call sites",
          dependsOn: ["inventory"],
          scope: ["src/**"],
          contextSelector: {
            includeRepositoryInstructions: true,
            predecessorResults: ["inventory"],
            relevantPaths: ["src"],
          },
          progressProbes: [
            {
              id: "workspace-diff",
              kind: "git_diff",
              baseSha: repository.baseSha,
              requireChanges: true,
            },
          ],
          completionProbes: [],
          sideEffectClass: "workspace_write",
        },
        {
          id: "verify",
          kind: "verification",
          objective: "Verify the complete migration",
          dependsOn: ["migrate"],
          scope: ["**/*"],
          contextSelector: {
            includeRepositoryInstructions: true,
            predecessorResults: ["migrate"],
            relevantPaths: ["src"],
          },
          progressProbes: [],
          completionProbes: [verificationProbe],
          sideEffectClass: "none",
        },
      ],
    };

    const graph = compilePlannedGraph(contract, plan, [verificationProbe]);

    expect(graphPlanShape(graph)).toBe("inventory → migrate → verify");
    expect(graph.anchors).toEqual(contract.acceptanceAnchors);
    expect(graph.nodes.every(({ status }) => status === "pending")).toBe(true);
    expect(graph.controlEdges).toHaveLength(contract.acceptanceAnchors.length * 3);
  });

  it("rejects proposed graphs that weaken required proof or exceed local authority", () => {
    const contract = compileRunContract("Implement a substantial feature", repository);
    const requiredProbe = {
      id: "tests",
      kind: "command" as const,
      command: "npm",
      args: ["test"],
      expectedExitCode: 0,
      timeoutMs: 1_000,
    };
    const plan: GraphPlan = {
      schemaVersion: 1,
      family: "feature",
      nodes: [
        {
          id: "verify",
          kind: "verification",
          objective: "Claim the feature is complete",
          dependsOn: [],
          scope: ["**/*"],
          contextSelector: {
            includeRepositoryInstructions: true,
            predecessorResults: [],
            relevantPaths: [],
          },
          progressProbes: [],
          completionProbes: [],
          sideEffectClass: "external",
        },
      ],
    };

    expect(() => compilePlannedGraph(contract, plan, [requiredProbe])).toThrow(/completion probes/);

    const overreachingPlan: GraphPlan = {
      ...plan,
      nodes: [
        {
          ...plan.nodes[0]!,
          completionProbes: [requiredProbe],
          sideEffectClass: "external",
        },
      ],
    };
    expect(() => compilePlannedGraph(contract, overreachingPlan, [requiredProbe])).toThrow(
      /external side effects/,
    );

    const reclassifiedPlan: GraphPlan = {
      ...overreachingPlan,
      family: "audit",
    };
    expect(() => compilePlannedGraph(contract, reclassifiedPlan, [requiredProbe])).toThrow(
      /task family/,
    );
  });
});

describe("event replay", () => {
  it("hashes events and deterministically rebuilds state", () => {
    const contract = compileRunContract("Implement a substantial new feature", repository);
    const graph = compileGraph(contract, []);
    const created = createRunEvent({
      sequence: 1,
      timestamp: "2026-07-21T12:00:00.000Z",
      actor: "runtime",
      causationId: contract.runId,
      type: "run.created",
      data: { contract, graph, nodeIds: graph.nodes.map(({ id }) => id) },
    });
    const approved = createRunEvent({
      sequence: 2,
      timestamp: "2026-07-21T12:00:01.000Z",
      actor: "user",
      causationId: contract.runId,
      type: "run.approved",
      data: { approved: true },
    });
    const accepted = createRunEvent({
      sequence: 3,
      timestamp: "2026-07-21T12:00:02.000Z",
      actor: "runtime",
      causationId: contract.runId,
      type: "node.accepted",
      data: { nodeId: "implement" },
    });

    const first = reduceEvents([created, approved, accepted]);
    const second = reduceEvents([created, approved, accepted]);
    expect(second).toEqual(first);
    expect(first.nodes.implement?.status).toBe("accepted");

    expect(() => verifyRunEvent({ ...accepted, hash: "0".repeat(64) })).toThrow(/hash/);
  });
});

describe("progress leases", () => {
  const result = (probeId: string, passed: boolean, signature: string): ProbeResult => ({
    probeId,
    kind: "command",
    passed,
    signature,
    summary: signature,
    durationMs: 1,
  });

  it("distinguishes progress, completion, churn, and stalls", () => {
    const baseline = evidenceSnapshot("workspace-a", [result("tests", false, "failure-a")]);
    const advanced = evidenceSnapshot("workspace-b", [result("tests", false, "failure-a")]);
    const learning = evidenceSnapshot("workspace-a", [result("tests", false, "failure-b")]);
    const done = evidenceSnapshot("workspace-b", [result("tests", true, "passed")]);

    expect(classifyProgress(baseline, advanced)).toBe("advanced");
    expect(classifyProgress(baseline, learning)).toBe("learning");
    expect(classifyProgress(baseline, done)).toBe("done");
    expect(classifyProgress(baseline, baseline)).toBe("stalled");
    expect(classifyProgress(advanced, baseline, [baseline, advanced, baseline])).toBe(
      "oscillating",
    );
    expect(
      classifyProgress(
        evidenceSnapshot("workspace-a", [result("tests", true, "passed")]),
        baseline,
      ),
    ).toBe("regressed");
  });
});
