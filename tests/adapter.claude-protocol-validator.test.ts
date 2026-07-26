import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClaudeIsolationBoundary,
  createClaudeProtocolValidator,
} from "../packages/adapter-claude/src/index.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

async function git(repository: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repository });
}

function initEvent(cwd: string, sessionId: unknown = SESSION_ID): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    tools: ["Read"],
    mcp_servers: [],
    slash_commands: [],
    skills: [],
    plugins: [],
    agents: ["claude", "Explore", "general-purpose", "Plan"],
    plugin_errors: [],
    permissionMode: "dontAsk",
    claude_code_version: "2.1.212",
    output_style: "default",
    model: "claude-test-model",
    uuid: "00000000-0000-4000-8000-000000000002",
    cwd,
    session_id: sessionId,
  };
}

function successfulResult(sessionId: unknown = SESSION_ID): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    session_id: sessionId,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude production protocol validator", () => {
  it("accepts one attested session and one successful terminal result", async () => {
    const cwd = await realpath(await temporaryDirectory("graphcraft-claude-validator-"));
    const validator = createClaudeProtocolValidator({
      cwd,
      allowedTools: ["Read"],
      model: "claude-test-model",
      expectedSessionId: SESSION_ID,
    });

    await expect(validator.observe(initEvent(cwd))).resolves.toBeUndefined();
    await expect(
      validator.observe({ type: "assistant", session_id: SESSION_ID, message: { content: [] } }),
    ).resolves.toBeUndefined();
    await expect(validator.observe(successfulResult())).resolves.toBeUndefined();
    expect(validator.sessionId()).toBe(SESSION_ID);
    expect(validator.completionFailure()).toBeUndefined();
  });

  it.each([42, "", null])(
    "rejects malformed supplied session identity %j on a non-output event",
    async (sessionId) => {
      const cwd = await realpath(await temporaryDirectory("graphcraft-claude-validator-"));
      const validator = createClaudeProtocolValidator({
        cwd,
        allowedTools: ["Read"],
        expectedSessionId: SESSION_ID,
        sessionContext: "worker",
      });
      await expect(validator.observe(initEvent(cwd))).resolves.toBeUndefined();

      await expect(
        validator.observe({ type: "system", subtype: "status", session_id: sessionId }),
      ).resolves.toMatch(/invalid session identity/);
    },
  );

  it("enforces exact worker identity on every supplied event and all model output", async () => {
    const cwd = await realpath(await temporaryDirectory("graphcraft-claude-validator-"));
    const drifted = createClaudeProtocolValidator({
      cwd,
      allowedTools: ["Read"],
      expectedSessionId: SESSION_ID,
      sessionContext: "resumed_worker",
    });
    await drifted.observe(initEvent(cwd));
    await expect(
      drifted.observe({
        type: "system",
        subtype: "status",
        session_id: "00000000-0000-4000-8000-000000000099",
      }),
    ).resolves.toBe(
      "Claude resumed worker reported a different session identity; result was rejected",
    );

    const missing = createClaudeProtocolValidator({
      cwd,
      allowedTools: ["Read"],
      expectedSessionId: SESSION_ID,
      sessionContext: "resumed_worker",
    });
    await missing.observe(initEvent(cwd));
    await expect(missing.observe({ type: "assistant", message: { content: [] } })).resolves.toBe(
      "Claude resumed worker output omitted its session identity; result was rejected",
    );
  });

  it("rejects failed, duplicate, and post-terminal model output", async () => {
    const cwd = await realpath(await temporaryDirectory("graphcraft-claude-validator-"));
    const failed = createClaudeProtocolValidator({ cwd, allowedTools: ["Read"] });
    await failed.observe(initEvent(cwd));
    await expect(
      failed.observe({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "qualification failed",
        session_id: SESSION_ID,
      }),
    ).resolves.toBe("qualification failed");

    const duplicate = createClaudeProtocolValidator({ cwd, allowedTools: ["Read"] });
    await duplicate.observe(initEvent(cwd));
    await duplicate.observe(successfulResult());
    await expect(duplicate.observe(successfulResult())).resolves.toBe(
      "Claude reported duplicate terminal results",
    );

    const lateOutput = createClaudeProtocolValidator({ cwd, allowedTools: ["Read"] });
    await lateOutput.observe(initEvent(cwd));
    await lateOutput.observe(successfulResult());
    await expect(
      lateOutput.observe({
        type: "assistant",
        session_id: SESSION_ID,
        message: { content: [] },
      }),
    ).resolves.toBe("Claude emitted model output after its terminal result");
  });

  it("requires both init attestation and terminal completion", async () => {
    const cwd = await realpath(await temporaryDirectory("graphcraft-claude-validator-"));
    const missingInit = createClaudeProtocolValidator({ cwd, allowedTools: ["Read"] });
    expect(missingInit.completionFailure()).toBe("Claude did not attest system/init");

    const missingResult = createClaudeProtocolValidator({ cwd, allowedTools: ["Read"] });
    await missingResult.observe(initEvent(cwd));
    expect(missingResult.completionFailure()).toBe("Claude did not report a terminal result");
  });
});

describe("Claude isolation boundary factory", () => {
  it("protects tracked, untracked, ignored, and nested repository environment files", async () => {
    const repository = await temporaryDirectory("graphcraft-claude-boundary-");
    const privateTemp = await temporaryDirectory("graphcraft-claude-private-");
    await git(repository, "init", "-b", "main");
    await mkdir(join(repository, "nested"));
    await Promise.all([
      writeFile(join(repository, ".gitignore"), ".env.ignored\n"),
      writeFile(join(repository, ".env"), "TRACKED_FIXTURE=1\n"),
      writeFile(join(repository, ".env.ignored"), "IGNORED_FIXTURE=1\n"),
      writeFile(join(repository, "nested", ".env.local"), "UNTRACKED_FIXTURE=1\n"),
    ]);
    await git(repository, "add", ".gitignore", ".env");

    const boundary = await createClaudeIsolationBoundary(repository, privateTemp);

    expect(boundary.repositoryRealPath).toBe(await realpath(repository));
    expect(boundary.temporaryDirectory).toBe(privateTemp);
    expect(boundary.protectedEnvironmentPaths).toEqual(
      await Promise.all(
        [
          join(repository, ".env"),
          join(repository, ".env.ignored"),
          join(repository, "nested", ".env.local"),
        ].map(async (path) => await realpath(path)),
      ).then((paths) => paths.sort()),
    );
  });
});
