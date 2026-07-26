import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("cross-spawn", () => ({
  default: Object.assign(spawnMock, { spawn: spawnMock, sync: vi.fn() }),
}));

import { ClaudeAdapter } from "../packages/adapter-claude/src/index.ts";
import { CodexAdapter } from "../packages/adapter-codex/src/index.ts";
import {
  HOST_PROTOCOL_PROFILES,
  resolveHostProtocolProfile,
  stripSingleHostVersionLineEnding,
  type HostEvent,
  type WorkerRequest,
} from "../packages/core/src/index.ts";
import {
  buildSanitizedLiveProtocolEvidence,
  protocolEventsJsonl,
  type LiveQualificationEvidenceBinding,
} from "./live-qualification-protocol-evidence.ts";

type Host = "codex" | "claude";

interface ProtocolFixtureManifest {
  schemaVersion: 1;
  kind: "graphcraft-host-protocol-fixture";
  host: Host;
  profileId: string;
  reportedVersion: string;
  sessionPlaceholder: string;
  provenance: {
    kind: "synthetic-contract";
    liveCapture: false;
    basis: string;
    sanitization: string;
  };
  acceptance: {
    qualifiesVersion: false;
    mayUpdateAdmission: false;
  };
  captures: {
    version: string;
    interruptedWorker: string;
    resumedWorker: string;
  };
  integrity: {
    algorithm: "sha256";
    files: Record<string, string>;
  };
  expected: {
    normalizedUsage: {
      input: number;
      cachedInput: number;
      uncachedInput: number;
      output: number;
      reasoning: number;
      total: number;
    };
    resultStatus: "completed";
  };
}

interface ProtocolFixture {
  directory: string;
  manifest: ProtocolFixtureManifest;
  versionOutput: string;
  interruptedWorker: string;
  resumedWorker: string;
}

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "host-protocol");
const fixtureCases = [
  ["codex-cli-0.144.6", "codex", "codex-cli@0.144.6"],
  ["claude-code-2.1.212", "claude", "claude-code@2.1.212"],
] as const;
let fixtureRepositoryPath = process.cwd();

class FakeChild extends EventEmitter {
  readonly stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly unref = vi.fn();
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
}

function queueSettledChild(stdout: string): FakeChild {
  const child = new FakeChild();
  spawnMock.mockImplementationOnce(() => {
    setImmediate(() => {
      child.stdout.end(stdout);
      child.stderr.end();
      setImmediate(() => child.emit("close", 0, null));
    });
    return child as unknown as ChildProcess;
  });
  return child;
}

function queueInterruptedChild(stdout: string, afterWrite?: () => void): FakeChild {
  const child = new FakeChild();
  let closed = false;
  child.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
    if (closed) return false;
    closed = true;
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", null, typeof signal === "string" ? signal : null);
    });
    return true;
  });
  spawnMock.mockImplementationOnce(() => {
    setImmediate(() => {
      child.stdout.write(stdout);
      afterWrite?.();
    });
    return child as unknown as ChildProcess;
  });
  return child;
}

function queueReadyCapabilityProbe(fixture: ProtocolFixture): void {
  queueSettledChild(fixture.versionOutput);
  queueSettledChild(fixture.manifest.host === "codex" ? "Logged in\n" : '{"loggedIn":true}\n');
}

function adapterFor(host: Host): CodexAdapter | ClaudeAdapter {
  return host === "codex" ? new CodexAdapter() : new ClaudeAdapter();
}

function workerRequest(
  resumeSessionId?: string,
  invocationId: WorkerRequest["invocationId"] = randomUUID(),
): WorkerRequest {
  return {
    invocationId,
    repositoryPath: fixtureRepositoryPath,
    capsule: {} as WorkerRequest["capsule"],
    allowedTools: ["read"],
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}

function bindProtocolToRequest(host: Host, raw: string, request: WorkerRequest): string {
  if (host === "codex") return raw;
  return `${protocolObjects(raw)
    .map((event) =>
      JSON.stringify(
        event.type === "system" && event.subtype === "init"
          ? { ...event, cwd: request.repositoryPath }
          : event,
      ),
    )
    .join("\n")}\n`;
}

async function collectEvents(iterable: AsyncIterable<HostEvent>): Promise<HostEvent[]> {
  const events: HostEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function loadFixture(directory: string): Promise<ProtocolFixture> {
  const root = join(fixtureRoot, directory);
  const manifest = JSON.parse(await readFile(join(root, "fixture.json"), "utf8")) as
    ProtocolFixtureManifest | undefined;
  if (!manifest) throw new Error(`Missing protocol fixture manifest for ${directory}`);
  const [versionOutput, interruptedWorker, resumedWorker] = await Promise.all([
    readFile(join(root, manifest.captures.version), "utf8"),
    readFile(join(root, manifest.captures.interruptedWorker), "utf8"),
    readFile(join(root, manifest.captures.resumedWorker), "utf8"),
  ]);
  return { directory, manifest, versionOutput, interruptedWorker, resumedWorker };
}

function protocolObjects(raw: string): Record<string, unknown>[] {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Protocol fixture line is not a JSON object");
      }
      return value as Record<string, unknown>;
    });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function observedSessionIds(host: Host, events: Record<string, unknown>[]): string[] {
  return events.flatMap((event) => {
    const value = host === "codex" ? event.thread_id : event.session_id;
    return typeof value === "string" ? [value] : [];
  });
}

function replaceSessionIdentity(fixture: ProtocolFixture, replacement: string): string {
  return fixture.resumedWorker.replaceAll(fixture.manifest.sessionPlaceholder, replacement);
}

function liveEvidenceBinding(fixture: ProtocolFixture): LiveQualificationEvidenceBinding {
  return {
    hashAlgorithms: {
      qualificationReport: "sha256-exact-bytes-v1",
      hostQualification: "graphcraft-canonical-json-sha256-v1",
    },
    qualificationReportSha256: "a".repeat(64),
    hostQualificationSha256: "b".repeat(64),
    qualificationReportSchemaVersion: 1,
    qualificationReportKind: "graphcraft-live-host-qualification",
    qualificationCompletedAt: "2026-07-24T00:00:00.000Z",
    source: {
      graphcraftPackageVersion: "0.1.2",
      sourceGitHead: "c".repeat(40),
      sourceGitStatus: "clean",
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      fixtureGitHead: "d".repeat(40),
      fixtureTreeSha256: "e".repeat(64),
      taskSha256: "f".repeat(64),
      fixtureTaskSha256: "1".repeat(64),
    },
    control: {
      rawVersion: fixture.manifest.reportedVersion,
      model: "fixture-model",
      effort: "high",
    },
  };
}

function removeSessionIdentity(host: Host, raw: string): string {
  return `${protocolObjects(raw)
    .map((event) => {
      const { [host === "codex" ? "thread_id" : "session_id"]: _identity, ...retained } = event;
      return JSON.stringify(retained);
    })
    .join("\n")}\n`;
}

function removeClaudeOutputSessionIdentity(raw: string): string {
  return `${protocolObjects(raw)
    .map((event) => {
      if (event.type !== "assistant" && event.type !== "result") return JSON.stringify(event);
      const { session_id: _identity, ...retained } = event;
      return JSON.stringify(retained);
    })
    .join("\n")}\n`;
}

function addLateSessionDrift(host: Host, raw: string, replacement: string): string {
  const events = protocolObjects(raw);
  if (host === "claude") {
    return `${events
      .map((event) =>
        JSON.stringify(event.type === "result" ? { ...event, session_id: replacement } : event),
      )
      .join("\n")}\n`;
  }
  const completion = events.findIndex((event) => event.type === "turn.completed");
  events.splice(completion, 0, { type: "thread.started", thread_id: replacement });
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

describe("versioned host protocol contract fixtures", () => {
  let trustedCommandDirectory: string | undefined;

  beforeAll(async () => {
    trustedCommandDirectory = await mkdtemp(join(tmpdir(), "graphcraft-protocol-fixtures-"));
    fixtureRepositoryPath = await realpath(process.cwd());
    const codexHome = join(trustedCommandDirectory, "codex-home");
    await mkdir(codexHome);
    const suffix = process.platform === "win32" ? ".cmd" : "";
    await Promise.all(
      ["codex", "claude"].map(async (host) => {
        const executable = join(trustedCommandDirectory!, `${host}${suffix}`);
        await writeFile(
          executable,
          process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
          "utf8",
        );
        if (process.platform !== "win32") await chmod(executable, 0o755);
      }),
    );
    vi.stubEnv(
      "PATH",
      `${trustedCommandDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    );
    vi.stubEnv("CODEX_HOME", codexHome);
  });

  afterEach(() => spawnMock.mockReset());

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (trustedCommandDirectory) {
      await rm(trustedCommandDirectory, { recursive: true, force: true });
    }
  });

  it("keeps one explicitly non-qualifying contract fixture for every admitted profile", async () => {
    const fixtures = await Promise.all(
      fixtureCases.map(async ([directory]) => await loadFixture(directory)),
    );
    expect(fixtures.map(({ manifest }) => manifest.profileId).sort()).toEqual(
      HOST_PROTOCOL_PROFILES.map(({ id }) => id).sort(),
    );
    expect(
      fixtures.every(
        ({ manifest }) =>
          !manifest.provenance.liveCapture &&
          !manifest.acceptance.qualifiesVersion &&
          !manifest.acceptance.mayUpdateAdmission,
      ),
    ).toBe(true);
  });

  it.each(fixtureCases)(
    "keeps %s sanitized, non-qualifying, and bound to its exact profile",
    async (directory, host, profileId) => {
      const fixture = await loadFixture(directory);
      const manifest = fixture.manifest;
      expect(Object.keys(manifest).sort()).toEqual(
        [
          "schemaVersion",
          "kind",
          "host",
          "profileId",
          "reportedVersion",
          "sessionPlaceholder",
          "provenance",
          "acceptance",
          "captures",
          "integrity",
          "expected",
        ].sort(),
      );
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        kind: "graphcraft-host-protocol-fixture",
        host,
        profileId,
        provenance: { kind: "synthetic-contract", liveCapture: false },
        acceptance: { qualifiesVersion: false, mayUpdateAdmission: false },
      });
      expect(resolveHostProtocolProfile(host, manifest.reportedVersion)?.id).toBe(profileId);
      expect(stripSingleHostVersionLineEnding(fixture.versionOutput)).toBe(
        manifest.reportedVersion,
      );
      const capturePaths = Object.values(manifest.captures);
      expect(new Set(capturePaths).size).toBe(capturePaths.length);
      for (const path of capturePaths) expect(path).toMatch(/^[a-z0-9][a-z0-9.-]*$/u);
      expect(manifest.integrity).toEqual({
        algorithm: "sha256",
        files: {
          [manifest.captures.version]: sha256(fixture.versionOutput),
          [manifest.captures.interruptedWorker]: sha256(fixture.interruptedWorker),
          [manifest.captures.resumedWorker]: sha256(fixture.resumedWorker),
        },
      });

      const rawProtocol = `${fixture.interruptedWorker}\n${fixture.resumedWorker}`;
      expect(rawProtocol).not.toContain(process.cwd());
      expect(rawProtocol).not.toMatch(
        /(?:\/Users\/|\/home\/|[A-Za-z]:\\\\|authorization["': ]|bearer\s|sk-[A-Za-z0-9])/iu,
      );
      const interrupted = protocolObjects(fixture.interruptedWorker);
      const resumed = protocolObjects(fixture.resumedWorker);
      expect(interrupted.length).toBeGreaterThan(1);
      expect(resumed.length).toBeGreaterThan(1);
      expect(new Set(observedSessionIds(host, [...interrupted, ...resumed]))).toEqual(
        new Set([manifest.sessionPlaceholder]),
      );
    },
  );

  it.each(["codex-cli-0.144.6", "claude-code-2.1.212"])(
    "replays %s through cancellation and exact-session resume",
    async (directory) => {
      const fixture = await loadFixture(directory);
      const adapter = adapterFor(fixture.manifest.host);
      const initialRequest = workerRequest(
        undefined,
        fixture.manifest.sessionPlaceholder as WorkerRequest["invocationId"],
      );

      queueReadyCapabilityProbe(fixture);
      const interruptedChild = queueInterruptedChild(
        bindProtocolToRequest(fixture.manifest.host, fixture.interruptedWorker, initialRequest),
      );
      const cancellation = new AbortController();
      const interruptedEvents: HostEvent[] = [];
      for await (const event of adapter.execute(initialRequest, cancellation.signal)) {
        interruptedEvents.push(event);
        if (event.type === "session" && !cancellation.signal.aborted) {
          cancellation.abort({ cause: "user_pause", reason: "Protocol fixture boundary" });
        }
      }

      expect(interruptedEvents).toContainEqual({
        type: "session",
        hostSessionId: fixture.manifest.sessionPlaceholder,
      });
      expect(interruptedEvents).toContainEqual(expect.objectContaining({ type: "tool" }));
      expect(interruptedEvents).not.toContainEqual(expect.objectContaining({ type: "usage" }));
      expect(interruptedEvents).not.toContainEqual(expect.objectContaining({ type: "result" }));
      expect(interruptedEvents.at(-1)).toMatchObject({
        type: "terminated",
        termination: {
          cause: "user_pause",
          outcome: process.platform === "win32" ? "forced" : "graceful",
          requestedSignal: "SIGTERM",
        },
      });
      expect(interruptedChild.kill).toHaveBeenCalledWith("SIGTERM");

      const resumedRequest = workerRequest(fixture.manifest.sessionPlaceholder);
      queueReadyCapabilityProbe(fixture);
      queueSettledChild(
        bindProtocolToRequest(fixture.manifest.host, fixture.resumedWorker, resumedRequest),
      );
      const resumedEvents = await collectEvents(
        adapter.execute(resumedRequest, new AbortController().signal),
      );

      expect(resumedEvents).toContainEqual({
        type: "session",
        hostSessionId: fixture.manifest.sessionPlaceholder,
      });
      expect(resumedEvents).toContainEqual(expect.objectContaining({ type: "message" }));
      expect(resumedEvents).toContainEqual({
        type: "usage",
        usage: expect.objectContaining(fixture.manifest.expected.normalizedUsage),
      });
      expect(resumedEvents.at(-1)).toMatchObject({
        type: "result",
        result: { status: fixture.manifest.expected.resultStatus, changedPaths: [] },
      });

      const invocationArgs = spawnMock.mock.calls.at(-1)?.[1] as string[] | undefined;
      expect(invocationArgs).toBeDefined();
      if (fixture.manifest.host === "codex") {
        const resumeIndex = invocationArgs?.indexOf("resume") ?? -1;
        expect(invocationArgs?.slice(resumeIndex, resumeIndex + 2)).toEqual([
          "resume",
          fixture.manifest.sessionPlaceholder,
        ]);
        expect(invocationArgs?.indexOf("-C")).toBeLessThan(resumeIndex);
      } else {
        expect(
          invocationArgs?.slice(
            invocationArgs.indexOf("--resume"),
            invocationArgs.indexOf("--resume") + 2,
          ),
        ).toEqual(["--resume", fixture.manifest.sessionPlaceholder]);
      }
    },
  );

  it.each(["codex-cli-0.144.6", "claude-code-2.1.212"])(
    "replays sanitized live qualification evidence derived from %s",
    async (directory) => {
      const fixture = await loadFixture(directory);
      const evidence = buildSanitizedLiveProtocolEvidence({
        host: fixture.manifest.host,
        binding: liveEvidenceBinding(fixture),
        interruptedWorker: protocolObjects(fixture.interruptedWorker),
        resumedWorker: protocolObjects(fixture.resumedWorker),
        expectedUsage: fixture.manifest.expected.normalizedUsage,
        prohibitedValues: [fixture.manifest.sessionPlaceholder],
      });
      const adapter = adapterFor(fixture.manifest.host);
      const initialRequest = workerRequest(
        undefined,
        evidence.sessionPlaceholder as WorkerRequest["invocationId"],
      );

      queueReadyCapabilityProbe(fixture);
      const interruptedChild = queueInterruptedChild(
        bindProtocolToRequest(
          fixture.manifest.host,
          protocolEventsJsonl(evidence.captures.interruptedWorker),
          initialRequest,
        ),
      );
      const cancellation = new AbortController();
      const interruptedEvents: HostEvent[] = [];
      for await (const event of adapter.execute(initialRequest, cancellation.signal)) {
        interruptedEvents.push(event);
        if (event.type === "session" && !cancellation.signal.aborted)
          cancellation.abort({ cause: "user_pause", reason: "Sanitized capture boundary" });
      }
      expect(interruptedEvents).toContainEqual({
        type: "session",
        hostSessionId: evidence.sessionPlaceholder,
      });
      expect(interruptedEvents).toContainEqual(expect.objectContaining({ type: "tool" }));
      expect(interruptedEvents.at(-1)).toMatchObject({
        type: "terminated",
        termination: { cause: "user_pause" },
      });
      expect(interruptedChild.kill).toHaveBeenCalledWith("SIGTERM");

      const resumedRequest = workerRequest(evidence.sessionPlaceholder);
      queueReadyCapabilityProbe(fixture);
      queueSettledChild(
        bindProtocolToRequest(
          fixture.manifest.host,
          protocolEventsJsonl(evidence.captures.resumedWorker),
          resumedRequest,
        ),
      );
      const resumedEvents = await collectEvents(
        adapter.execute(resumedRequest, new AbortController().signal),
      );
      expect(resumedEvents).toContainEqual({
        type: "session",
        hostSessionId: evidence.sessionPlaceholder,
      });
      expect(resumedEvents).toContainEqual({
        type: "usage",
        usage: expect.objectContaining(evidence.expected.normalizedUsage),
      });
      expect(resumedEvents.at(-1)).toMatchObject({
        type: "result",
        result: { status: "completed", changedPaths: [] },
      });
    },
  );

  it.each(["codex-cli-0.144.6", "claude-code-2.1.212"])(
    "rejects mismatched or absent resume identity in %s before accepting a result",
    async (directory) => {
      const fixture = await loadFixture(directory);
      const adapter = adapterFor(fixture.manifest.host);
      const identityName = fixture.manifest.host === "codex" ? "thread" : "session";
      const resumedRequest = workerRequest(fixture.manifest.sessionPlaceholder);

      queueReadyCapabilityProbe(fixture);
      const mismatchedChild = queueInterruptedChild(
        bindProtocolToRequest(
          fixture.manifest.host,
          replaceSessionIdentity(fixture, "00000000-0000-4000-8000-ffffffffffff"),
          resumedRequest,
        ),
      );
      const mismatchedEvents = await collectEvents(
        adapter.execute(resumedRequest, new AbortController().signal),
      );
      expect(mismatchedEvents).toEqual([
        expect.objectContaining({ type: "started" }),
        {
          type: "error",
          message:
            fixture.manifest.host === "codex"
              ? `Codex resumed worker reported a different ${identityName} identity; result was rejected`
              : "Claude system/init reported a different session identity",
        },
      ]);
      expect(mismatchedChild.kill).toHaveBeenCalledWith("SIGTERM");

      queueReadyCapabilityProbe(fixture);
      const driftedChild = queueInterruptedChild(
        bindProtocolToRequest(
          fixture.manifest.host,
          addLateSessionDrift(
            fixture.manifest.host,
            fixture.resumedWorker,
            "00000000-0000-4000-8000-dddddddddddd",
          ),
          resumedRequest,
        ),
      );
      const driftedEvents = await collectEvents(
        adapter.execute(resumedRequest, new AbortController().signal),
      );
      expect(driftedEvents).toContainEqual({
        type: "session",
        hostSessionId: fixture.manifest.sessionPlaceholder,
      });
      expect(driftedEvents).toContainEqual(expect.objectContaining({ type: "message" }));
      expect(driftedEvents).not.toContainEqual(expect.objectContaining({ type: "result" }));
      expect(driftedEvents.at(-1)).toEqual({
        type: "error",
        message: `${fixture.manifest.host === "codex" ? "Codex" : "Claude"} resumed worker reported a different ${identityName} identity; result was rejected`,
      });
      expect(driftedChild.kill).toHaveBeenCalledWith("SIGTERM");

      queueReadyCapabilityProbe(fixture);
      queueSettledChild(
        bindProtocolToRequest(
          fixture.manifest.host,
          removeSessionIdentity(fixture.manifest.host, fixture.resumedWorker),
          resumedRequest,
        ),
      );
      const missingEvents = await collectEvents(
        adapter.execute(resumedRequest, new AbortController().signal),
      );
      expect(missingEvents).toEqual([
        expect.objectContaining({ type: "started" }),
        {
          type: "error",
          message:
            fixture.manifest.host === "codex"
              ? "Codex resumed worker did not report its thread identity; result was rejected"
              : "Claude system/init omitted its session identity",
        },
      ]);

      const callerCancellation = new AbortController();
      queueReadyCapabilityProbe(fixture);
      queueInterruptedChild(
        bindProtocolToRequest(
          fixture.manifest.host,
          addLateSessionDrift(
            fixture.manifest.host,
            fixture.resumedWorker,
            "00000000-0000-4000-8000-eeeeeeeeeeee",
          ),
          resumedRequest,
        ),
        () =>
          callerCancellation.abort({
            cause: "user_stop",
            reason: "Caller cancellation wins the protocol race",
          }),
      );
      const callerCancelledEvents = await collectEvents(
        adapter.execute(resumedRequest, callerCancellation.signal),
      );
      expect(callerCancelledEvents.at(-1)).toMatchObject({
        type: "terminated",
        termination: { cause: "user_stop" },
      });
      expect(callerCancelledEvents).toHaveLength(2);
      expect(callerCancelledEvents).not.toContainEqual(expect.objectContaining({ type: "error" }));

      if (fixture.manifest.host === "claude") {
        queueReadyCapabilityProbe(fixture);
        queueInterruptedChild(
          bindProtocolToRequest(
            fixture.manifest.host,
            removeClaudeOutputSessionIdentity(fixture.resumedWorker),
            resumedRequest,
          ),
        );
        const outputWithoutIdentity = await collectEvents(
          adapter.execute(resumedRequest, new AbortController().signal),
        );
        expect(outputWithoutIdentity).toEqual([
          expect.objectContaining({ type: "started" }),
          {
            type: "error",
            message:
              "Claude resumed worker output omitted its session identity; result was rejected",
          },
        ]);
      }
    },
  );

  it.each(["codex-cli-0.144.6", "claude-code-2.1.212"])(
    "rejects fresh-worker session drift in %s",
    async (directory) => {
      const fixture = await loadFixture(directory);
      const adapter = adapterFor(fixture.manifest.host);
      const request = workerRequest();
      const boundProtocol =
        fixture.manifest.host === "claude"
          ? replaceSessionIdentity(fixture, request.invocationId)
          : fixture.resumedWorker;

      queueReadyCapabilityProbe(fixture);
      const child = queueInterruptedChild(
        bindProtocolToRequest(
          fixture.manifest.host,
          addLateSessionDrift(
            fixture.manifest.host,
            boundProtocol,
            "00000000-0000-4000-8000-cccccccccccc",
          ),
          request,
        ),
      );
      const events = await collectEvents(adapter.execute(request, new AbortController().signal));

      expect(events).not.toContainEqual(expect.objectContaining({ type: "result" }));
      expect(events.at(-1)).toEqual({
        type: "error",
        message: `${fixture.manifest.host === "codex" ? "Codex" : "Claude"} worker reported a different ${fixture.manifest.host === "codex" ? "thread" : "session"} identity; result was rejected`,
      });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    },
  );

  it("binds a fresh Claude worker to its explicit invocation session", async () => {
    const fixture = await loadFixture("claude-code-2.1.212");
    const request = workerRequest();
    queueReadyCapabilityProbe(fixture);
    const child = queueInterruptedChild(
      bindProtocolToRequest(fixture.manifest.host, fixture.resumedWorker, request),
    );

    const events = await collectEvents(
      new ClaudeAdapter().execute(request, new AbortController().signal),
    );

    expect(events).toEqual([
      expect.objectContaining({ type: "started" }),
      {
        type: "error",
        message: "Claude system/init reported a different session identity",
      },
    ]);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
