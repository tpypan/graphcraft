import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../packages/adapter-codex/src/index.ts";
import { ClaudeAdapter } from "../packages/adapter-claude/src/index.ts";
import { ContextCapsuleSchema, type HostAdapter } from "../packages/core/src/index.ts";

const execFileAsync = promisify(execFile);
const configuredHosts = (process.env.GRAPHCRAFT_LIVE_RESUME_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter((host): host is "codex" | "claude" => host === "codex" || host === "claude");

function adapterFor(host: "codex" | "claude"): HostAdapter {
  return host === "codex" ? new CodexAdapter() : new ClaudeAdapter();
}

describe.skipIf(configuredHosts.length === 0)("live native host continuation", () => {
  for (const host of configuredHosts) {
    it(
      `${host} resumes one exact session after its first process is terminated`,
      async () => {
        const repository = await mkdtemp(join(tmpdir(), "graphcraft-live-resume-"));
        try {
          await execFileAsync("git", ["init", "-b", "main"], { cwd: repository });
          await writeFile(
            join(repository, "package.json"),
            `${JSON.stringify({ name: "graphcraft-resume-fixture", private: true }, null, 2)}\n`,
          );
          await execFileAsync("git", ["add", "package.json"], { cwd: repository });
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
          const invocationId = randomUUID();
          const capsule = ContextCapsuleSchema.parse({
            schemaVersion: 1,
            runId: randomUUID(),
            nodeId: "inspect-package",
            objective:
              "Read package.json, report the package name as evidence, make no changes, and return completed.",
            finishLine: { kind: "local_verified" },
            constraints: ["Read only; do not modify the repository."],
            acceptanceAnchors: [
              {
                id: "read-only",
                description: "The repository remains unchanged",
                owner: "held_out_eval",
                evidenceSource: "git diff",
                mutationPolicy: "immutable",
              },
            ],
            predecessorEvidence: [],
            relevantPaths: ["package.json"],
            probeEvidence: [],
          });
          const abort = new AbortController();
          let hostSessionId: string | undefined;
          for await (const event of adapter.execute(
            {
              invocationId,
              repositoryPath: repository,
              capsule,
              allowedTools: ["read"],
            },
            abort.signal,
          )) {
            if (event.type === "session") {
              hostSessionId = event.hostSessionId;
              abort.abort();
            }
          }
          expect(hostSessionId).toBeTruthy();

          let resultStatus: string | undefined;
          let resumeError: string | undefined;
          for await (const event of adapter.execute(
            {
              invocationId,
              repositoryPath: repository,
              capsule,
              allowedTools: ["read"],
              resumeSessionId: hostSessionId!,
            },
            new AbortController().signal,
          )) {
            if (event.type === "result") resultStatus = event.result.status;
            if (event.type === "error") resumeError = event.message;
          }
          if (resumeError) throw new Error(resumeError);
          expect(resultStatus).toBe("completed");
          const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], {
            cwd: repository,
          });
          expect(status).toBe("");
          console.log(
            JSON.stringify({ host, version: capabilities.version, hostSessionId, resultStatus }),
          );
        } finally {
          await rm(repository, { recursive: true, force: true });
        }
      },
      5 * 60_000,
    );
  }
});
