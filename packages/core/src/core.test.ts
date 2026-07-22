import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyGraphAmendment,
  classifyProgress,
  classifyTask,
  contextCapsuleCharacters,
  codexGraphPlanJsonSchema,
  codexSemanticVerdictJsonSchema,
  codexWorkerResultJsonSchema,
  compileGraph,
  compilePlannedGraph,
  compileRunContract,
  contentHash,
  createContextCapsule,
  createHeldOutProbePlan,
  createRunEvent,
  evidenceSnapshot,
  graphPlanShape,
  MAX_CONTEXT_CAPSULE_CHARACTERS,
  resolveHeldOutProbes,
  reduceEvents,
  semanticVerdictJsonSchema,
  tokenCostReport,
  validateGraph,
  verifyRunEvent,
  workerVisibleProbePlan,
  workerResultJsonSchema,
  type GraphPlan,
  type GraphAmendment,
  type ProbeResult,
  type ProbePlan,
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

  it("replaces held-out scoring implementations with integrity-bound graph references", () => {
    const runId = randomUUID();
    const hiddenCommand = {
      id: "hidden-acceptance",
      kind: "command" as const,
      command: "node",
      args: ["hidden-scorer.mjs", "--private-rubric"],
      expectedExitCode: 0,
      timeoutMs: 1_000,
    };
    const probePlan: ProbePlan = {
      schemaVersion: 1,
      family: "feature",
      items: [
        {
          phase: "progress",
          purpose: "focused",
          source: "approved base SHA",
          probe: {
            id: "workspace-diff",
            kind: "git_diff",
            baseSha: "abc123",
            requireChanges: true,
          },
        },
        {
          phase: "completion",
          purpose: "acceptance",
          source: "private acceptance scorer",
          probe: hiddenCommand,
        },
      ],
    };
    const heldOut = createHeldOutProbePlan(runId, probePlan);
    const visible = workerVisibleProbePlan(probePlan, heldOut);
    const reference = visible.items.find(({ phase }) => phase === "completion")!.probe;

    expect(reference).toMatchObject({ id: hiddenCommand.id, kind: "held_out" });
    if (reference.kind !== "held_out") throw new Error("Expected a held-out probe reference");
    expect(JSON.stringify(visible)).not.toContain("hidden-scorer.mjs");
    expect(resolveHeldOutProbes([reference], heldOut)).toEqual([hiddenCommand]);
    expect(() =>
      resolveHeldOutProbes([{ ...reference, probeHash: "0".repeat(64) }], heldOut),
    ).toThrow(/substituted/);
    expect(() =>
      createHeldOutProbePlan(runId, { ...probePlan, items: probePlan.items.slice(0, 1) }),
    ).toThrow(/executable held-out proof/);
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

  it("bounds every worker context capsule before host execution", () => {
    const contract = compileRunContract("Implement a substantial context feature", repository);
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
    const capsule = createContextCapsule({
      contract,
      node: {
        ...graph.nodes[0]!,
        objective: "Implement the bounded context feature",
        contextSelector: {
          ...graph.nodes[0]!.contextSelector,
          relevantPaths: Array.from({ length: 100 }, (_, index) => `src/path-${index}.ts`),
        },
      },
      predecessorEvidence: Array.from(
        { length: 20 },
        (_, index) => `predecessor-${index}: ${"raw log ".repeat(1_000)}`,
      ),
      probeResults: Array.from({ length: 30 }, (_, index) => ({
        probeId: `probe-${index}`,
        kind: "command" as const,
        passed: false,
        signature: contentHash(index),
        summary: `failure ${"output ".repeat(1_000)}`,
        durationMs: 1,
      })),
    });

    expect(contextCapsuleCharacters(capsule)).toBeLessThanOrEqual(MAX_CONTEXT_CAPSULE_CHARACTERS);
    expect(capsule.objective).toBe("Implement the bounded context feature");
    expect(capsule.predecessorEvidence[0]).toContain("[truncated]");
    expect(capsule.predecessorEvidence).toHaveLength(3);
    expect(capsule.probeEvidence.length).toBeLessThanOrEqual(16);
    expect(capsule.relevantPaths).toHaveLength(32);
    expect(() =>
      createContextCapsule({
        contract,
        node: { ...graph.nodes[0]!, objective: "x".repeat(MAX_CONTEXT_CAPSULE_CHARACTERS) },
      }),
    ).toThrow(/exceeds.*characters/);
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

  it("replaces a missing usage placeholder when the host receipt is recovered", () => {
    const contract = compileRunContract("Implement a substantial new feature", repository);
    const graph = compileGraph(contract, []);
    const invocationId = randomUUID();
    const created = createRunEvent({
      sequence: 1,
      timestamp: "2026-07-21T12:00:00.000Z",
      actor: "runtime",
      causationId: contract.runId,
      type: "run.created",
      data: { contract, graph, nodeIds: graph.nodes.map(({ id }) => id) },
    });
    const missing = createRunEvent({
      sequence: 2,
      timestamp: "2026-07-21T12:00:01.000Z",
      actor: "host",
      causationId: invocationId,
      type: "tokens.recorded",
      data: {
        phase: "worker",
        nodeId: "implement",
        missing: true,
        usage: {
          input: 0,
          cachedInput: 0,
          uncachedInput: 0,
          output: 0,
          reasoning: 0,
          total: 0,
          availability: {
            input: "unavailable",
            cachedInput: "unavailable",
            uncachedInput: "unavailable",
            output: "unavailable",
            reasoning: "unavailable",
            total: "unavailable",
          },
        },
      },
    });
    const recovered = createRunEvent({
      sequence: 3,
      timestamp: "2026-07-21T12:00:02.000Z",
      actor: "host",
      causationId: invocationId,
      type: "tokens.recorded",
      data: {
        phase: "worker",
        nodeId: "implement",
        recovered: true,
        usage: {
          input: 10,
          cachedInput: 2,
          uncachedInput: 8,
          output: 4,
          reasoning: 1,
          total: 14,
          availability: {
            input: "reported",
            cachedInput: "reported",
            uncachedInput: "derived",
            output: "reported",
            reasoning: "reported",
            total: "derived",
          },
        },
      },
    });

    const state = reduceEvents([created, missing, recovered]);

    expect(state.tokenLedger).toEqual([
      expect.objectContaining({ sequence: 3, recovered: true, missing: false }),
    ]);
    expect(tokenCostReport(state.tokenLedger)).toMatchObject({
      receipts: 1,
      reconciled: true,
      totals: { total: 14 },
    });
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

  it("tracks migration inventory vectors across advancing and oscillating states", () => {
    const inventory = (matches: number): ProbeResult => ({
      probeId: "remaining-v2-usage",
      kind: "repository_inventory",
      passed: true,
      signature: `inventory-${matches}`,
      summary: `${matches} tracked files retain v2 usage`,
      durationMs: 1,
      metrics: { inventoryMatches: matches },
    });
    const stateA = evidenceSnapshot("workspace-a", [inventory(3)], "migration");
    const stateB = evidenceSnapshot("workspace-b", [inventory(1)], "migration");
    const returnedA = evidenceSnapshot("workspace-c", [inventory(3)], "migration");
    const done = evidenceSnapshot("workspace-d", [inventory(0)], "migration");

    expect(stateA.vector.metrics.remainingInventory).toBe(3);
    expect(classifyProgress(stateA, stateB, [stateA, stateB])).toBe("advanced");
    expect(classifyProgress(stateB, returnedA, [stateA, stateB, returnedA])).toBe("oscillating");
    expect(classifyProgress(stateB, done, [stateA, stateB, done])).toBe("done");
    expect(classifyProgress(stateB, stateA)).toBe("regressed");
  });
});
