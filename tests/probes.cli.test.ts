import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createRun } from "../packages/runtime/src/index.ts";

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

describe("probe plan CLI", () => {
  it("shows and durably replaces probes before approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft probe cli "));
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
        name: "probe-cli-fixture",
        scripts: { test: "node verify.mjs", "test:acceptance": "node verify.mjs" },
      }),
    );
    await writeFile(join(repository, "verify.mjs"), "process.exit(0);\n");
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "fixture");

    const created = await createRun("Implement a substantial fixture acceptance scenario", {
      cwd: repository,
    });
    const cli = join(process.cwd(), "node_modules", ".bin", "tsx");
    const args = ["packages/cli/src/bin.ts", "probes", created.contract.runId, "-C", repository];
    const shown = JSON.parse((await execFileAsync(cli, args)).stdout) as typeof created.probePlan;
    expect(shown.items).toEqual(created.probePlan.items);

    const edited = {
      ...shown,
      items: shown.items.filter(
        ({ phase, probe }) => phase === "progress" || probe.id === "package-root-test-acceptance",
      ),
    };
    const planPath = join(root, "approved-probes.json");
    await writeFile(planPath, JSON.stringify(edited));
    const configured = JSON.parse(
      (await execFileAsync(cli, [...args, "--set", planPath])).stdout,
    ) as { graph: { revision: number }; probePlan: typeof edited };

    expect(configured.graph.revision).toBe(1);
    expect(
      configured.probePlan.items
        .filter(({ phase }) => phase === "completion")
        .map(({ probe }) => probe.id),
    ).toEqual(["package-root-test-acceptance"]);
    expect((await created.store.loadGraph()).revision).toBe(1);
  });
});
