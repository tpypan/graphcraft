import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyGraphAmendment,
  classifyProgress,
  classifyTask,
  codexGraphPlanJsonSchema,
  codexSemanticVerdictJsonSchema,
  codexWorkerResultJsonSchema,
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
  type GraphAmendment,
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

  it("exports Codex-compatible strict output schemas", () => {
    const assertRequiredProperties = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) assertRequiredProperties(item);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (record.properties && typeof record.properties === "object") {
        expect(new Set(record.required as string[])).toEqual(
          new Set(Object.keys(record.properties as Record<string, unknown>)),
        );
      }
      for (const item of Object.values(record)) assertRequiredProperties(item);
    };
    for (const schema of [
      codexGraphPlanJsonSchema,
      codexWorkerResultJsonSchema,
      codexSemanticVerdictJsonSchema,
    ]) {
      const serialized = JSON.stringify(schema);
      expect(serialized).not.toMatch(
        /"(?:oneOf|default|format|maximum|minimum|minItems|minLength|pattern)"/,
      );
      assertRequiredProperties(schema);
    }
    expect(codexWorkerResultJsonSchema).toMatchObject({
      properties: {
        nextSuggestedObjective: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
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
    expect(new Set(graph.controlEdges.map(({ relation }) => relation))).toEqual(
      new Set(["observes", "vetoes", "arbitrates", "owns_target"]),
    );
    expect(graph.controlEdges).toContainEqual({
      from: "user-outcome",
      to: "verify",
      relation: "owns_target",
    });
  });

  it("applies add, supersede, split, fuse, and dependency amendments under contract policy", () => {
    const contract = compileRunContract("Refactor the src implementation safely", repository);
    const verificationProbe = {
      id: "tests",
      kind: "command" as const,
      command: "npm",
      args: ["test"],
      expectedExitCode: 0,
      timeoutMs: 1_000,
    };
    const plannedNode = (
      id: string,
      dependsOn: string[],
      sideEffectClass: "none" | "workspace_write" = "workspace_write",
    ): GraphPlan["nodes"][number] => ({
      id,
      kind: sideEffectClass === "none" ? "investigation" : "implementation",
      objective: `Complete ${id}`,
      dependsOn,
      scope: ["src/**"],
      contextSelector: {
        includeRepositoryInstructions: true,
        predecessorResults: dependsOn,
        relevantPaths: ["src"],
      },
      progressProbes: [],
      completionProbes: [],
      sideEffectClass,
    });
    const graph = compilePlannedGraph(
      contract,
      {
        schemaVersion: 1,
        family: "refactor",
        nodes: [
          plannedNode("inventory", [], "none"),
          plannedNode("part-a", ["inventory"]),
          plannedNode("part-b", ["inventory"]),
          {
            ...plannedNode("verify", ["part-a", "part-b"], "none"),
            kind: "verification",
            scope: ["**/*"],
            completionProbes: [verificationProbe],
          },
        ],
      },
      [verificationProbe],
    );
    const amendment: GraphAmendment = {
      schemaVersion: 1,
      amendmentId: randomUUID(),
      operations: [
        {
          operation: "fuse",
          targetIds: ["part-a", "part-b"],
          replacement: plannedNode("fused", ["inventory"]),
        },
        {
          operation: "split",
          targetId: "fused",
          replacements: [
            plannedNode("split-a", ["inventory"]),
            plannedNode("split-b", ["inventory"]),
          ],
        },
        {
          operation: "supersede",
          targetId: "split-a",
          replacement: plannedNode("revised-a", ["inventory"]),
        },
        {
          operation: "add",
          node: plannedNode("audit-note", ["inventory"], "none"),
          authoritySourceIds: ["inventory"],
        },
        {
          operation: "dependency_change",
          targetId: "verify",
          dependsOn: ["revised-a", "split-b", "audit-note"],
        },
      ],
      evidence: ["Repository evidence disproves the original file boundary"],
      rationale: "The original parallel split duplicates a shared implementation boundary",
      changedStrategy: "Fuse the duplicate work, then split it along the discovered boundary",
      falsifiableExpectation: "All revised branches converge on the unchanged npm test probe",
    };
    const applied = applyGraphAmendment({
      graph,
      contract,
      amendment,
      actor: "runtime",
      nodeStatuses: Object.fromEntries(
        graph.nodes.map(({ id }) => [id, { status: "pending" as const }]),
      ),
      requiredVerificationProbes: [verificationProbe],
      approvedProbes: [verificationProbe],
    });

    expect(applied.graph.revision).toBe(1);
    expect(applied.graph.nodes.map(({ id }) => id).sort()).toEqual([
      "audit-note",
      "inventory",
      "revised-a",
      "split-b",
      "verify",
    ]);
    expect(applied.graph.nodes.find(({ id }) => id === "verify")?.dependsOn.sort()).toEqual([
      "audit-note",
      "revised-a",
      "split-b",
    ]);
    expect(applied.graph.anchors).toEqual(contract.acceptanceAnchors);
    expect(applied.diff).toEqual({
      addedNodeIds: ["audit-note", "revised-a", "split-b"],
      removedNodeIds: ["part-a", "part-b"],
      changedNodeIds: ["verify"],
    });
  });

  it("rejects unsafe or ungrounded amendments and requires user approval for authority expansion", () => {
    const contract = compileRunContract("Implement a substantial feature", repository);
    const verificationProbe = {
      id: "tests",
      kind: "command" as const,
      command: "npm",
      args: ["test"],
      expectedExitCode: 0,
      timeoutMs: 1_000,
    };
    const graph = compileGraph(contract, [verificationProbe]);
    graph.nodes[0]!.scope = ["src/**"];
    const replacement = {
      id: "implement-broader",
      kind: "implementation" as const,
      objective: "Implement across the approved repository",
      dependsOn: [],
      scope: ["**/*"],
      contextSelector: {
        includeRepositoryInstructions: true,
        predecessorResults: [],
        relevantPaths: ["src"],
      },
      progressProbes: graph.nodes[0]!.progressProbes,
      completionProbes: [],
      sideEffectClass: "workspace_write" as const,
    };
    const amendment: GraphAmendment = {
      schemaVersion: 1,
      amendmentId: randomUUID(),
      operations: [{ operation: "supersede", targetId: "implement", replacement }],
      evidence: ["The implementation crosses the original src boundary"],
      rationale: "The original scope is incomplete",
      changedStrategy: "Use the broader contract scope",
      falsifiableExpectation: "The unchanged completion probe will pass",
    };
    const apply = (actor: "runtime" | "user", status: "pending" | "accepted" = "pending") =>
      applyGraphAmendment({
        graph,
        contract,
        amendment,
        actor,
        nodeStatuses: { implement: { status }, verify: { status: "pending" } },
        requiredVerificationProbes: [verificationProbe],
        approvedProbes: [verificationProbe],
      });

    expect(() => apply("runtime")).toThrow(/without explicit user approval/);
    expect(() => apply("user")).not.toThrow();
    expect(() => apply("user", "accepted")).toThrow(/Accepted node implement is immutable/);
    expect(() =>
      applyGraphAmendment({
        graph,
        contract,
        amendment: {
          ...amendment,
          amendmentId: randomUUID(),
          operations: [
            {
              operation: "supersede",
              targetId: "verify",
              replacement: {
                id: "verify-weakened",
                kind: "verification",
                objective: "Claim completion without the held-out probe",
                dependsOn: ["implement"],
                scope: ["**/*"],
                contextSelector: {
                  includeRepositoryInstructions: true,
                  predecessorResults: ["implement"],
                  relevantPaths: [],
                },
                progressProbes: [],
                completionProbes: [],
                sideEffectClass: "none",
              },
            },
          ],
        },
        actor: "user",
        nodeStatuses: { implement: { status: "pending" }, verify: { status: "pending" } },
        requiredVerificationProbes: [verificationProbe],
        approvedProbes: [verificationProbe],
      }),
    ).toThrow(/verification.*probe/i);
    expect(() =>
      applyGraphAmendment({
        graph,
        contract,
        amendment: {
          ...amendment,
          amendmentId: randomUUID(),
          operations: [
            { operation: "dependency_change", targetId: "implement", dependsOn: ["verify"] },
          ],
        },
        actor: "user",
        nodeStatuses: { implement: { status: "pending" }, verify: { status: "pending" } },
        requiredVerificationProbes: [verificationProbe],
        approvedProbes: [verificationProbe],
      }),
    ).toThrow(/cycle/);
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
