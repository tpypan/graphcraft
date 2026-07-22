import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createRun } from "../packages/runtime/src/index.ts";
import type { GraphAmendment } from "../packages/core/src/index.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

describe("graph amendment CLI", () => {
  it("records explicit user approval and exposes durable revision history", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft amend cli "));
    temporaryRoots.push(root);
    const repository = join(root, "repo with spaces");
    await mkdir(repository);
    await git(repository, "init", "-b", "main");
    await git(repository, "config", "user.name", "Graphcraft Test");
    await git(repository, "config", "user.email", "graphcraft@example.test");
    await git(repository, "config", "commit.gpgSign", "false");
    await writeFile(
      join(repository, "package.json"),
      JSON.stringify({ name: "amend-cli-fixture", scripts: { test: "node verify.mjs" } }),
    );
    await writeFile(join(repository, "verify.mjs"), "process.exit(0);\n");
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "fixture");

    const created = await createRun("Implement a substantial fixture feature", {
      cwd: repository,
    });
    await created.store.append("user", "run.approved", { approved: true });
    await created.store.append("runtime", "node.started", { nodeId: "implement" });
    await created.store.append("worker", "node.failed", {
      nodeId: "implement",
      reason: "The original strategy was disproved",
    });
    await created.store.append("runtime", "run.blocked", {
      reason: "The original strategy was disproved",
    });
    const implement = created.graph.nodes.find(({ id }) => id === "implement")!;
    const amendment: GraphAmendment = {
      schemaVersion: 1,
      amendmentId: randomUUID(),
      operations: [
        {
          operation: "supersede",
          targetId: "implement",
          replacement: {
            id: "implement-revised",
            kind: implement.kind,
            objective: "Implement the feature using the revised evidence boundary",
            dependsOn: implement.dependsOn,
            scope: implement.scope,
            contextSelector: implement.contextSelector,
            progressProbes: implement.progressProbes,
            completionProbes: implement.completionProbes,
            sideEffectClass: implement.sideEffectClass,
          },
        },
      ],
      evidence: ["A failed run disproved the original strategy"],
      rationale: "The remaining implementation objective must change",
      changedStrategy: "Use the revised repository boundary",
      falsifiableExpectation: "The unchanged completion probe will pass",
    };
    const amendmentPath = join(root, "amendment.json");
    await writeFile(amendmentPath, JSON.stringify(amendment));
    const cli = join(process.cwd(), "node_modules", ".bin", "tsx");
    const applied = JSON.parse(
      (
        await execFileAsync(cli, [
          "packages/cli/src/bin.ts",
          "amend",
          created.contract.runId,
          "-C",
          repository,
          "--set",
          amendmentPath,
          "--approve",
        ])
      ).stdout,
    ) as {
      graph: { revision: number };
      amendment: { actor: string; proposal: { amendmentId: string } };
      graphHistory: unknown[];
    };

    expect(applied.graph.revision).toBe(1);
    expect(applied.amendment.actor).toBe("user");
    expect(applied.amendment.proposal.amendmentId).toBe(amendment.amendmentId);
    expect(applied.graphHistory).toHaveLength(1);

    const inspected = JSON.parse(
      (
        await execFileAsync(cli, [
          "packages/cli/src/bin.ts",
          "inspect",
          created.contract.runId,
          "-C",
          repository,
        ])
      ).stdout,
    ) as { graphHistory: unknown[]; state: { nodes: Record<string, { status: string }> } };
    expect(inspected.graphHistory).toHaveLength(1);
    expect(inspected.state.nodes.implement?.status).toBe("superseded");
  });
});
