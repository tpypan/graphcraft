import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createRun, recordRunApprovalDecisions } from "../packages/runtime/src/index.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

describe("control decision CLI", () => {
  it("records a sticky replacement and exposes it through inspect and trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft decision cli "));
    temporaryRoots.push(root);
    const repository = join(root, "repo with spaces");
    await mkdir(repository);
    await git(repository, "init", "-b", "main");
    await git(repository, "config", "user.name", "Graphcraft Test");
    await git(repository, "config", "user.email", "graphcraft@example.test");
    await git(repository, "config", "commit.gpgSign", "false");
    await writeFile(
      join(repository, "package.json"),
      JSON.stringify({
        name: "decision-cli-fixture",
        private: true,
        scripts: { test: "node verify.mjs" },
      }),
    );
    await writeFile(join(repository, "verify.mjs"), "process.exit(0);\n");
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "fixture");

    const created = await createRun("Implement a substantial feature across the fixture", {
      cwd: repository,
    });
    const repositoryInstructions = await created.store.loadRepositoryInstructionManifest();
    expect(repositoryInstructions).toMatchObject({
      policy: "tracked-shared-v1",
      entries: [],
    });
    await created.store.append("user", "run.approved", { approved: true });
    await recordRunApprovalDecisions(created.store, created.graph);
    const approval = (await created.store.loadState()).controlDecisions.find(
      ({ sourceId }) => sourceId === "user-outcome",
    )!;
    const cli = process.execPath;
    const common = [
      tsxCli,
      "packages/cli/src/bin.ts",
      "decide",
      created.contract.runId,
      "-C",
      repository,
      "--source",
      "user-outcome",
      "--target",
      "verify",
      "--verdict",
      "veto",
      "--reason",
      "Hold finish-line verification for review",
      "--replace",
      approval.decisionId,
      "--evidence",
      "Manual review is pending",
    ];
    const decided = JSON.parse((await execFileAsync(cli, common)).stdout) as {
      controlDecisions: Array<Record<string, unknown>>;
    };

    expect(decided.controlDecisions).toEqual([
      expect.objectContaining({
        sourceId: "user-outcome",
        targetId: "verify",
        verdict: "veto",
        rationale: "Hold finish-line verification for review",
        evidence: ["Manual review is pending"],
        sticky: true,
        replaces: approval.decisionId,
      }),
    ]);

    const status = JSON.parse(
      (
        await execFileAsync(cli, [
          tsxCli,
          "packages/cli/src/bin.ts",
          "status",
          created.contract.runId,
          "-C",
          repository,
          "--json",
        ])
      ).stdout,
    ) as { status: string; repositoryInstructions: Record<string, unknown> };
    const inspected = JSON.parse(
      (
        await execFileAsync(cli, [
          tsxCli,
          "packages/cli/src/bin.ts",
          "inspect",
          created.contract.runId,
          "-C",
          repository,
          "--json",
        ])
      ).stdout,
    ) as {
      graph: { controlEdges: unknown[] };
      state: { controlDecisions: unknown[] };
      repositoryInstructions: Record<string, unknown>;
    };
    const traced = JSON.parse(
      (
        await execFileAsync(cli, [
          tsxCli,
          "packages/cli/src/bin.ts",
          "trace",
          created.contract.runId,
          "-C",
          repository,
          "--json",
        ])
      ).stdout,
    ) as Array<{ type: string; data: Record<string, unknown> }>;

    expect(inspected.graph.controlEdges.length).toBeGreaterThan(0);
    expect(inspected.state.controlDecisions).toEqual(decided.controlDecisions);
    expect(status).toMatchObject({
      repositoryInstructions: {
        state: "pinned",
        policy: "tracked-shared-v1",
        digest: repositoryInstructions?.digest,
        count: 0,
        paths: [],
      },
    });
    expect(inspected.repositoryInstructions).toEqual({
      state: "pinned",
      policy: "tracked-shared-v1",
      digest: repositoryInstructions?.digest,
      count: 0,
      paths: [],
      manifest: repositoryInstructions,
    });
    expect(traced[0]?.data.repositoryInstructions).toEqual(repositoryInstructions);
    expect(traced.map(({ type }) => type)).not.toEqual(
      expect.arrayContaining(["context.selected", "node.started", "invocation.started"]),
    );
    expect(traced).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "control.decision",
          data: expect.objectContaining({
            decision: expect.objectContaining({
              sourceId: "user-outcome",
              verdict: "veto",
              evidence: ["Manual review is pending"],
            }),
          }),
        }),
      ]),
    );
  });
});
