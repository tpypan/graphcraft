import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../packages/adapter-claude/src/index.ts";
import { CodexAdapter } from "../packages/adapter-codex/src/index.ts";
import { SemanticVerifierContextSchema, type HostAdapter } from "../packages/core/src/index.ts";

const execFileAsync = promisify(execFile);
const configuredHosts = (process.env.GRAPHCRAFT_LIVE_HOSTS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value): value is "codex" | "claude" => value === "codex" || value === "claude");

function adapterFor(host: "codex" | "claude"): HostAdapter {
  return host === "codex" ? new CodexAdapter() : new ClaudeAdapter();
}

describe.skipIf(configuredHosts.length === 0)("live semantic verifier isolation", () => {
  for (const host of configuredHosts) {
    it(`${host} returns a grounded verdict without changing the fixture`, async () => {
      const repository = await mkdtemp(join(tmpdir(), "graphcraft-semantic-live-"));
      try {
        await execFileAsync("git", ["init", "-b", "main"], { cwd: repository });
        await writeFile(
          join(repository, "package.json"),
          `${JSON.stringify({ name: "semantic-verifier-fixture", private: true }, null, 2)}\n`,
        );
        await execFileAsync("git", ["add", "."], { cwd: repository });
        await execFileAsync(
          "git",
          [
            "-c",
            "commit.gpgSign=false",
            "-c",
            "user.name=Graphcraft Test",
            "-c",
            "user.email=graphcraft@example.test",
            "commit",
            "-m",
            "fixture",
          ],
          { cwd: repository },
        );
        const adapter = adapterFor(host);
        const capabilities = await adapter.probe();
        expect(capabilities).toMatchObject({ installed: true, authenticated: true });
        const runId = randomUUID();
        const verdict = await adapter.verify(
          {
            invocationId: randomUUID(),
            repositoryPath: repository,
            context: SemanticVerifierContextSchema.parse({
              schemaVersion: 1,
              phase: "progress",
              runId,
              nodeId: "inspect-package",
              objective: "Identify the package name from package.json",
              finishLine: { kind: "local_verified" },
              acceptanceAnchors: [
                {
                  id: "package-name",
                  description: "The finding matches the tracked package manifest",
                  owner: "repository",
                  evidenceSource: "package.json",
                  mutationPolicy: "immutable",
                },
              ],
              relevantPaths: ["package.json"],
              workerSummary: "The package is named semantic-verifier-fixture",
              workerEvidence: ["package.json declares name semantic-verifier-fixture"],
              baselineProbeEvidence: [],
              currentProbeEvidence: [],
            }),
          },
          new AbortController().signal,
        );

        expect(verdict.verdict.verdict).toBe("supported");
        expect(verdict.verdict.evidence.length).toBeGreaterThan(0);
        expect(verdict.usage?.total).toBeGreaterThan(0);
        const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], {
          cwd: repository,
        });
        expect(status).toBe("");
        console.log(JSON.stringify({ host, version: capabilities.version, verdict }));
      } finally {
        await rm(repository, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
