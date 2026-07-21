import { describe, expect, it } from "vitest";
import {
  classifyProgress,
  compileGraph,
  compileRunContract,
  createRunEvent,
  evidenceSnapshot,
  reduceEvents,
  validateGraph,
  verifyRunEvent,
  workerResultJsonSchema,
  type ProbeResult,
} from "./index.ts";

const repository = {
  root: "/tmp/example",
  remote: "https://example.test/repo.git",
  baseRef: "main",
  baseSha: "abc123",
};

describe("run contracts and graphs", () => {
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
