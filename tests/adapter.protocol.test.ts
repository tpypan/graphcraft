import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexPlannerArgs,
  codexSemanticVerifierArgs,
  codexUsage,
  codexWorkerArgs,
} from "../packages/adapter-codex/src/index.ts";
import {
  claudePlannerArgs,
  claudeSemanticVerifierArgs,
  claudeUsage,
  claudeWorkerArgs,
} from "../packages/adapter-claude/src/index.ts";
import {
  reconcilePersistedInvocation,
  ChildTerminationController,
  resolveTrustedExecutable,
  type InvocationRecord,
  type HostExecutionPolicy,
  type PlanningRequest,
  type SemanticVerificationRequest,
  type WorkerRequest,
} from "../packages/core/src/index.ts";

function request(
  resumeSessionId?: string,
  allowedTools = ["read", "write", "shell"],
): WorkerRequest {
  return {
    invocationId: randomUUID(),
    repositoryPath: "/tmp/graphcraft fixture",
    capsule: {} as WorkerRequest["capsule"],
    allowedTools,
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}

function semanticRequest(): SemanticVerificationRequest {
  return {
    invocationId: randomUUID(),
    repositoryPath: "/tmp/graphcraft fixture",
    context: {} as SemanticVerificationRequest["context"],
  };
}

function planningRequest(): PlanningRequest {
  return {
    repositoryPath: "/tmp/graphcraft fixture",
    contract: { task: "Plan the benchmark fixture" } as PlanningRequest["contract"],
    repositoryEvidence: {
      contentTrust: "untrusted_repository",
      trackedPathCount: 1,
      trackedPaths: ["source.js"],
      trackedPathsTruncated: false,
      files: [],
    },
    probePlan: { schemaVersion: 1, family: "feature", items: [] },
    verificationProbes: [],
  };
}

describe("native host continuation protocol", () => {
  it("resolves Windows PATH commands outside an untrusted working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-trusted-command-"));
    const untrusted = join(root, "repository");
    const trusted = join(root, "installed tools");
    await Promise.all([mkdir(untrusted), mkdir(trusted)]);
    await Promise.all([
      writeFile(join(untrusted, "codex.cmd"), "@echo hostile\r\n", "utf8"),
      writeFile(join(trusted, "codex.cmd"), "@echo trusted\r\n", "utf8"),
    ]);
    try {
      const trustedExecutable = await realpath(join(trusted, "codex.cmd"));
      await expect(
        resolveTrustedExecutable("codex", {
          platform: "win32",
          environment: { Path: `${untrusted};${trusted}`, PATHEXT: ".cmd;.exe" },
          untrustedCwd: untrusted,
        }),
      ).resolves.toBe(trustedExecutable);
      await expect(
        resolveTrustedExecutable("codex", {
          platform: "win32",
          environment: { Path: untrusted, PATHEXT: ".cmd;.exe" },
          untrustedCwd: untrusted,
        }),
      ).rejects.toThrow("Unable to resolve trusted Windows executable");
      await expect(
        resolveTrustedExecutable("node", {
          platform: "win32",
          environment: { Path: untrusted, PATHEXT: ".cmd;.exe" },
          untrustedCwd: untrusted,
        }),
      ).resolves.toBe(process.execPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "resolves POSIX PATH commands without trusting repository-controlled entries",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "graphcraft-trusted-command-"));
      const untrusted = join(root, "repository");
      const untrustedBin = join(untrusted, "node_modules", ".bin");
      const redirectedTools = join(root, "redirected tools");
      const nonExecutableTools = join(root, "non-executable tools");
      const trustedTools = join(root, "trusted tools");
      const decoyTarget = join(root, "decoy codex");
      const hostileTarget = join(untrusted, "hostile codex");
      const trustedTarget = join(root, "installed codex");
      await Promise.all([
        mkdir(untrustedBin, { recursive: true }),
        mkdir(redirectedTools),
        mkdir(nonExecutableTools),
        mkdir(trustedTools),
      ]);
      await Promise.all([
        writeFile(decoyTarget, "#!/bin/sh\nexit 11\n", "utf8"),
        writeFile(hostileTarget, "#!/bin/sh\nexit 12\n", "utf8"),
        writeFile(join(nonExecutableTools, "codex"), "#!/bin/sh\nexit 13\n", "utf8"),
        writeFile(trustedTarget, "#!/bin/sh\nexit 0\n", "utf8"),
      ]);
      await Promise.all([
        chmod(decoyTarget, 0o755),
        chmod(hostileTarget, 0o755),
        chmod(trustedTarget, 0o755),
      ]);
      await Promise.all([
        symlink(decoyTarget, join(untrustedBin, "codex")),
        symlink(hostileTarget, join(redirectedTools, "codex")),
        symlink(trustedTarget, join(trustedTools, "codex")),
      ]);

      try {
        const untrustedPath = ["", "relative-bin", untrustedBin, redirectedTools].join(":");
        await expect(
          resolveTrustedExecutable("codex", {
            platform: process.platform,
            environment: { PATH: untrustedPath },
            untrustedCwd: untrusted,
          }),
        ).rejects.toThrow("Unable to resolve trusted executable");

        const trustedExecutable = await realpath(trustedTarget);
        await expect(
          resolveTrustedExecutable("codex", {
            platform: process.platform,
            environment: { PATH: `${untrustedPath}:${nonExecutableTools}:${trustedTools}` },
            untrustedCwd: untrusted,
          }),
        ).resolves.toBe(trustedExecutable);
        await expect(
          resolveTrustedExecutable("node", {
            platform: process.platform,
            environment: { PATH: untrustedBin },
            untrustedCwd: untrusted,
          }),
        ).resolves.toBe(process.execPath);
        await expect(
          resolveTrustedExecutable(join(untrustedBin, "codex"), {
            platform: process.platform,
            environment: { PATH: trustedTools },
            untrustedCwd: untrusted,
          }),
        ).resolves.toBe(join(untrustedBin, "codex"));
        await expect(
          resolveTrustedExecutable("./node_modules/.bin/codex", {
            platform: process.platform,
            environment: { PATH: trustedTools },
            untrustedCwd: untrusted,
          }),
        ).resolves.toBe("./node_modules/.bin/codex");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("normalizes provider token dimensions without fabricating missing values", () => {
    expect(
      codexUsage({
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      }),
    ).toMatchObject({
      input: 100,
      cachedInput: 40,
      uncachedInput: 60,
      output: 20,
      reasoning: 5,
      total: 120,
      availability: { uncachedInput: "derived", total: "derived" },
    });
    expect(
      claudeUsage({
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 20,
        output_tokens: 4,
      }),
    ).toMatchObject({
      input: 35,
      cachedInput: 20,
      uncachedInput: 15,
      output: 4,
      reasoning: 0,
      total: 39,
      availability: { reasoning: "unavailable", total: "derived" },
    });
    expect(codexUsage({ input_tokens: 10, output_tokens: 2 })).toMatchObject({
      cachedInput: 0,
      uncachedInput: 0,
      availability: { cachedInput: "unavailable", uncachedInput: "unavailable" },
    });
  });

  it("persists Codex worker sessions and resumes an exact thread without ephemeral mode", () => {
    const fresh = codexWorkerArgs(request(), "/tmp/schema.json");
    expect(fresh).not.toContain("--ephemeral");
    expect(fresh).toContain("workspace-write");
    expect(fresh).toContain("/tmp/graphcraft fixture");

    const resumed = codexWorkerArgs(request("codex-thread"), "/tmp/schema.json");
    expect(resumed.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(resumed).toContain("codex-thread");
    expect(resumed).not.toContain("-C");
    expect(resumed).not.toContain("--ephemeral");
  });

  it("assigns a Claude session ID and resumes the exact persisted conversation", () => {
    const freshRequest = request();
    const fresh = claudeWorkerArgs(freshRequest);
    expect(fresh.slice(fresh.indexOf("--session-id"), fresh.indexOf("--session-id") + 2)).toEqual([
      "--session-id",
      freshRequest.invocationId,
    ]);

    const resumed = claudeWorkerArgs(request("claude-session"));
    expect(resumed).toContain("--resume");
    expect(resumed).toContain("claude-session");
    expect(resumed).not.toContain("--session-id");
  });

  it("enforces read-only host profiles for non-writing graph nodes", () => {
    const codex = codexWorkerArgs(request(undefined, ["read"]), "/tmp/schema.json");
    expect(codex.slice(codex.indexOf("-s"), codex.indexOf("-s") + 2)).toEqual(["-s", "read-only"]);

    const claude = claudeWorkerArgs(request(undefined, ["read"]));
    expect(
      claude.slice(claude.indexOf("--permission-mode"), claude.indexOf("--permission-mode") + 2),
    ).toEqual(["--permission-mode", "dontAsk"]);
    expect(claude[claude.indexOf("--allowedTools") + 1]).toBe("Read,Glob,Grep");
  });

  it("uses fresh read-only profiles for isolated semantic verification", () => {
    const codex = codexSemanticVerifierArgs(semanticRequest(), "/tmp/verdict.schema.json");
    expect(codex).toContain("--ephemeral");
    expect(codex.slice(codex.indexOf("-s"), codex.indexOf("-s") + 2)).toEqual(["-s", "read-only"]);
    expect(codex).not.toContain("resume");

    const claude = claudeSemanticVerifierArgs(semanticRequest());
    expect(claude.slice(claude.indexOf("--effort"), claude.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "low",
    ]);
    expect(claude[claude.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(claude[claude.indexOf("--allowedTools") + 1]).toBe("Read,Glob,Grep");
    expect(claude.join(" ")).not.toMatch(/Bash|Edit|Write|--resume|--session-id/);
  });

  it("applies explicit model and effort policies to every host invocation path", () => {
    const policy: HostExecutionPolicy = { model: "benchmark-model", effort: "xhigh" };
    const codexInvocations = [
      codexPlannerArgs(planningRequest(), "/tmp/plan.schema.json", policy),
      codexWorkerArgs(request(), "/tmp/worker.schema.json", policy),
      codexWorkerArgs(request("codex-thread"), "/tmp/worker.schema.json", policy),
      codexSemanticVerifierArgs(semanticRequest(), "/tmp/verdict.schema.json", policy),
    ];
    for (const args of codexInvocations) {
      expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
        "--model",
        "benchmark-model",
      ]);
      expect(args).toContain('model_reasoning_effort="xhigh"');
    }

    const claudeInvocations = [
      claudePlannerArgs(planningRequest(), policy),
      claudeWorkerArgs(request(), policy),
      claudeWorkerArgs(request("claude-session"), policy),
      claudeSemanticVerifierArgs(semanticRequest(), policy),
    ];
    for (const args of claudeInvocations) {
      expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
        "--model",
        "benchmark-model",
      ]);
      expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual([
        "--effort",
        "xhigh",
      ]);
    }
  });

  it("reconciles durable results before resumable or repository-recovery states", () => {
    const base: InvocationRecord = {
      invocationId: randomUUID(),
      repositoryPath: "/tmp/repository",
      startedAt: new Date().toISOString(),
    };
    expect(reconcilePersistedInvocation(base).state).toBe("not_started");
    expect(reconcilePersistedInvocation({ ...base, hostSessionId: "session" }).state).toBe(
      "in_progress",
    );
    expect(
      reconcilePersistedInvocation({
        ...base,
        hostSessionId: "session",
        transcript: [
          {
            type: "result",
            result: {
              status: "completed",
              summary: "done",
              changedPaths: [],
              evidence: ["proof"],
            },
          },
        ],
      }).state,
    ).toBe("completed");
  });

  it("records first-stage termination and escalates an unresponsive child", async () => {
    const terminate = async (script: string, graceMs: number) => {
      const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
      await once(child, "spawn");
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
      );
      const abort = new AbortController();
      const controller = new ChildTerminationController(child, abort.signal, graceMs);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      abort.abort({ cause: "user_pause", reason: "test pause" });
      const exit = await closed;
      return controller.finish(exit.code, exit.signal);
    };

    const firstStage = await terminate("setInterval(() => {}, 1000)", 500);
    expect(firstStage).toMatchObject(
      process.platform === "win32"
        ? {
            cause: "user_pause",
            outcome: "forced",
            requestedSignal: "SIGTERM",
          }
        : {
            cause: "user_pause",
            outcome: "graceful",
            requestedSignal: "SIGTERM",
          },
    );

    const forced = await terminate(
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      50,
    );
    expect(forced).toMatchObject(
      process.platform === "win32"
        ? {
            cause: "user_pause",
            outcome: "forced",
            requestedSignal: "SIGTERM",
          }
        : {
            cause: "user_pause",
            outcome: "forced",
            requestedSignal: "SIGKILL",
          },
    );
  });
});
