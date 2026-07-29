import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import crossSpawn from "cross-spawn";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROCESS_INPUT_BYTES,
  PROCESS_SETTLEMENT_GRACE_MS,
  PROCESS_TERMINATION_GRACE_MS,
  WINDOWS_PROCESS_SETTLEMENT_GRACE_MS,
  managedProcessBrokerSource,
  managedProcessSettlementGraceMs,
  runProcess,
  type ManagedProcessSettlement,
} from "./process.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for managed process evidence");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function exerciseWindowsBrokerTermination(
  taskkill: "success" | "nonzero" | "missing",
): Promise<{
  settlement: ManagedProcessSettlement;
  brokerCode: number | null;
  taskkillCompletedBeforeSettlement: boolean;
}> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-windows-broker-"));
  const journal = await open(join(root, "journal.jsonl"), "a+", 0o600);
  const completionMarker = join(root, "taskkill-complete.txt");
  const taskkillExecutable =
    taskkill === "missing" ? join(root, "missing-taskkill.exe") : process.execPath;
  const taskkillArgumentPrefix =
    taskkill === "missing"
      ? []
      : [
          "-e",
          `const fs = require("node:fs");
const pidIndex = process.argv.indexOf("/pid");
const pid = Number(process.argv[pidIndex + 1]);
try { process.kill(pid, "SIGKILL"); } catch {}
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(completionMarker)}, "complete\\n");
  process.exit(${taskkill === "success" ? 0 : 1});
}, 75);`,
        ];

  let targetPid: number | undefined;
  const broker = crossSpawn.spawn(
    process.execPath,
    [
      "-e",
      managedProcessBrokerSource("win32", taskkillExecutable, taskkillArgumentPrefix),
      `windows-broker-${taskkill}`,
      `windows-owner-${taskkill}`,
      "100",
      "1000",
    ],
    {
      cwd: root,
      env: { ...process.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc", journal.fd],
    },
  );
  let stderr = "";
  broker.stderr!.setEncoding("utf8");
  broker.stderr!.on("data", (chunk: string) => (stderr += chunk));
  const brokerExit = new Promise<number | null>((resolve) =>
    broker.once("close", (code) => resolve(code)),
  );
  const waitForMessage = <T extends { type: string }>(type: T["type"]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out waiting for broker ${type}: ${stderr}`)),
        5_000,
      );
      const receive = (message: unknown): void => {
        if (!message || typeof message !== "object" || !("type" in message)) return;
        if ((message as { type: unknown }).type !== type) return;
        clearTimeout(timeout);
        broker.off("message", receive);
        resolve(message as T);
      };
      broker.on("message", receive);
    });

  try {
    await waitForMessage<{ type: "ready" }>("ready");
    broker.send({
      type: "start",
      executable: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1_000)"],
      cwd: root,
      env: { ...process.env },
    });
    await waitFor(async () =>
      (await readFile(join(root, "journal.jsonl"), "utf8")).includes('"status":"started"'),
    );
    const journalText = await readFile(join(root, "journal.jsonl"), "utf8");
    targetPid = Number(journalText.match(/"childPid":(\d+)/u)?.[1]);
    const settled = waitForMessage<ManagedProcessSettlement & { type: "settled" }>("settled");
    broker.send({ type: "terminate" });
    const settlement = await settled;
    const taskkillCompletedBeforeSettlement = await stat(completionMarker).then(
      () => true,
      () => false,
    );
    const brokerCode = await brokerExit;
    return { settlement, brokerCode, taskkillCompletedBeforeSettlement };
  } finally {
    try {
      broker.kill("SIGKILL");
    } catch {
      // Best-effort cleanup for a failed broker assertion.
    }
    if (targetPid && Number.isSafeInteger(targetPid)) {
      try {
        process.kill(targetPid, "SIGKILL");
      } catch {
        // The broker normally settles the target before this cleanup path.
      }
    }
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe("bounded subprocess output capture", () => {
  it("allows a bounded Windows tree-settlement window without slowing other platforms", () => {
    expect(managedProcessSettlementGraceMs("win32")).toBe(WINDOWS_PROCESS_SETTLEMENT_GRACE_MS);
    expect(WINDOWS_PROCESS_SETTLEMENT_GRACE_MS).toBeGreaterThan(PROCESS_SETTLEMENT_GRACE_MS);
    expect(PROCESS_TERMINATION_GRACE_MS + managedProcessSettlementGraceMs("win32")).toBe(10_000);
    expect(managedProcessSettlementGraceMs("linux")).toBe(PROCESS_SETTLEMENT_GRACE_MS);
    expect(managedProcessSettlementGraceMs("darwin")).toBe(PROCESS_SETTLEMENT_GRACE_MS);
  });

  it("confirms Windows termination only after taskkill succeeds and the child closes", async () => {
    const observed = await exerciseWindowsBrokerTermination("success");

    expect(observed).toMatchObject({
      settlement: { outcome: "terminated", confirmed: true },
      brokerCode: 0,
      taskkillCompletedBeforeSettlement: true,
    });
  });

  it.each(["nonzero", "missing"] as const)(
    "keeps Windows termination unconfirmed when taskkill is %s",
    async (taskkill) => {
      const observed = await exerciseWindowsBrokerTermination(taskkill);

      expect(observed).toMatchObject({
        settlement: { outcome: "unconfirmed", confirmed: false },
        brokerCode: 1,
        taskkillCompletedBeforeSettlement: taskkill === "nonzero",
      });
    },
  );

  it("does not start a managed command until its ownership checkpoint is durable", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-managed-process-"));
    const marker = join(root, "started.txt");
    const journal = await open(join(root, "journal.jsonl"), "a+", 0o600);
    let release!: () => void;
    const durable = new Promise<void>((resolve) => (release = resolve));
    let ready = false;
    const settlements: unknown[] = [];
    try {
      const result = runProcess(
        process.execPath,
        ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started\\n")`],
        {
          cwd: root,
          lifecycle: {
            executionId: "managed-gate",
            ownerToken: "managed-gate-token",
            journalFd: journal.fd,
            onReady: async () => {
              ready = true;
              await durable;
            },
            onSettled: async (settlement) => {
              settlements.push(settlement);
            },
          },
        },
      );
      await waitFor(() => ready);
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      release();

      await expect(result).resolves.toMatchObject({ exitCode: 0, timedOut: false });
      await expect(readFile(marker, "utf8")).resolves.toBe("started\n");
      expect(settlements).toEqual([
        expect.objectContaining({
          executionId: "managed-gate",
          outcome: "exited",
          confirmed: true,
          exitCode: 0,
        }),
      ]);
      expect(await readFile(join(root, "journal.jsonl"), "utf8")).toContain('"status":"settled"');
    } finally {
      release();
      await journal.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists managed settlement only after the ready checkpoint finishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-managed-settlement-order-"));
    const marker = join(root, "must-not-start.txt");
    const journal = await open(join(root, "journal.jsonl"), "a+", 0o600);
    const controller = new AbortController();
    let release!: () => void;
    const durable = new Promise<void>((resolve) => (release = resolve));
    let ready = false;
    let readyFinished = false;
    const settlementReadyStates: boolean[] = [];
    const result = runProcess(
      process.execPath,
      ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started\\n")`],
      {
        cwd: root,
        signal: controller.signal,
        lifecycle: {
          executionId: "managed-settlement-order",
          ownerToken: "managed-settlement-order-token",
          journalFd: journal.fd,
          onReady: async () => {
            ready = true;
            await durable;
            readyFinished = true;
          },
          onSettled: async () => {
            settlementReadyStates.push(readyFinished);
          },
        },
      },
    );

    try {
      await waitFor(() => ready);
      controller.abort();
      await waitFor(async () =>
        (await readFile(join(root, "journal.jsonl"), "utf8")).includes('"status":"settled"'),
      );
      expect(settlementReadyStates).toEqual([]);
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

      release();
      await expect(result).resolves.toMatchObject({
        exitCode: 1,
        timedOut: false,
        childSettlement: "confirmed",
      });
      expect(settlementReadyStates).toEqual([true]);
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release();
      controller.abort();
      await result.catch(() => undefined);
      await journal.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails before launch when a managed ownership checkpoint cannot be persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphcraft-managed-process-failure-"));
    const marker = join(root, "must-not-start.txt");
    const journal = await open(join(root, "journal.jsonl"), "a+", 0o600);
    try {
      await expect(
        runProcess(
          process.execPath,
          ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe\\n")`],
          {
            cwd: root,
            lifecycle: {
              executionId: "managed-refusal",
              ownerToken: "managed-refusal-token",
              journalFd: journal.fd,
              onReady: async () => {
                throw new Error("ownership checkpoint refused");
              },
              onSettled: async () => undefined,
            },
          },
        ),
      ).rejects.toThrow("ownership checkpoint refused");
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "journal.jsonl"), "utf8")).toContain(
        '"outcome":"cancelled_before_start"',
      );
    } finally {
      await journal.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects empty or NUL-bearing invocations before spawning", async () => {
    await expect(runProcess("", [], { cwd: process.cwd() })).rejects.toThrow(
      "Subprocess command must not be empty",
    );
    await expect(runProcess(" \t", [], { cwd: process.cwd() })).rejects.toThrow(
      "Subprocess command must not be empty",
    );
    await expect(runProcess(`node\0hostile`, [], { cwd: process.cwd() })).rejects.toThrow(
      "Subprocess command must not contain NUL bytes",
    );
    await expect(
      runProcess(process.execPath, ["safe", `hostile\0argument`], { cwd: process.cwd() }),
    ).rejects.toThrow("Subprocess argument 1 must not contain NUL bytes");
  });

  it("preserves stdout and stderr exactly below the capture limit", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", 'process.stdout.write("hello\\n"); process.stderr.write("warning\\n");'],
      { cwd: process.cwd(), maxOutputBytesPerStream: 1_024 },
    );

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "hello\n",
      stderr: "warning\n",
      timedOut: false,
      capture: {
        stdout: {
          limitBytes: 1_024,
          observedBytes: 6,
          retainedBytes: 6,
          omittedBytes: 0,
          truncated: false,
          digest: createHash("sha256").update("hello\n").digest("hex"),
        },
        stderr: {
          limitBytes: 1_024,
          observedBytes: 8,
          retainedBytes: 8,
          omittedBytes: 0,
          truncated: false,
          digest: createHash("sha256").update("warning\n").digest("hex"),
        },
      },
    });
  });

  it("delivers bounded stdin bytes and rejects oversized input before launch", async () => {
    const result = await runProcess(
      process.execPath,
      [
        "-e",
        "const chunks = []; process.stdin.on('data', (chunk) => chunks.push(chunk)); process.stdin.on('end', () => process.stdout.write(Buffer.concat(chunks)));",
      ],
      { cwd: process.cwd(), input: Buffer.from("validated bytes\n") },
    );

    expect(result).toMatchObject({ exitCode: 0, stdout: "validated bytes\n" });
    await expect(
      runProcess(process.execPath, ["-e", "process.exit(0)"], {
        cwd: process.cwd(),
        input: Buffer.alloc(DEFAULT_PROCESS_INPUT_BYTES + 1),
      }),
    ).rejects.toThrow(`${DEFAULT_PROCESS_INPUT_BYTES}-byte bounded input limit`);
  });

  it("drains stdout and stderr while retaining bounded valid UTF-8 with exact metadata", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", 'process.stdout.write("é".repeat(1_024)); process.stderr.write("界".repeat(1_024));'],
      {
        cwd: process.cwd(),
        maxOutputBytesPerStream: 257,
        outputOverflow: "truncate",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.capture).toEqual({
      stdout: {
        limitBytes: 257,
        observedBytes: 2_048,
        retainedBytes: 256,
        omittedBytes: 1_792,
        truncated: true,
        digest: createHash("sha256").update("é".repeat(1_024)).digest("hex"),
      },
      stderr: {
        limitBytes: 257,
        observedBytes: 3_072,
        retainedBytes: 255,
        omittedBytes: 2_817,
        truncated: true,
        digest: createHash("sha256").update("界".repeat(1_024)).digest("hex"),
      },
    });
    expect(result.stdout).not.toContain("�");
    expect(result.stderr).not.toContain("�");
    expect(result.stdout).toContain("[GRAPHCRAFT STDOUT TRUNCATED: retained 256 of 2048 bytes]\n");
    expect(result.stderr).toContain("[GRAPHCRAFT STDERR TRUNCATED: retained 255 of 3072 bytes]\n");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(400);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(400);
  });

  it("fails closed by default when either stream exceeds its limit", async () => {
    const promise = runProcess(
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(16_384));'],
      { cwd: process.cwd(), maxOutputBytesPerStream: 1_024 },
    );

    await expect(promise).rejects.toMatchObject({
      name: "ProcessOutputLimitError",
      stream: "stdout",
      capture: {
        stdout: {
          limitBytes: 1_024,
          truncated: true,
        },
      },
    });
  });

  it("enforces an optional combined output limit without reducing either stream limit", async () => {
    const accepted = await runProcess(
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(1_200));'],
      {
        cwd: process.cwd(),
        maxOutputBytesPerStream: 2_000,
        maxOutputBytesTotal: 1_500,
      },
    );
    expect(accepted).toMatchObject({ exitCode: 0, stdout: "x".repeat(1_200) });

    const rejected = runProcess(
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(800)); process.stderr.write("y".repeat(800));'],
      {
        cwd: process.cwd(),
        maxOutputBytesPerStream: 2_000,
        maxOutputBytesTotal: 1_500,
      },
    );
    await expect(rejected).rejects.toMatchObject({
      name: "ProcessOutputLimitError",
      scope: "combined",
      limitBytes: 1_500,
      childSettlement: "confirmed",
    });
  });

  it("bounds combined retention when total overflow is truncated", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(800)); process.stderr.write("y".repeat(800));'],
      {
        cwd: process.cwd(),
        maxOutputBytesPerStream: 2_000,
        maxOutputBytesTotal: 1_000,
        outputOverflow: "truncate",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.capture.stdout.observedBytes + result.capture.stderr.observedBytes).toBe(1_600);
    expect(result.capture.stdout.retainedBytes + result.capture.stderr.retainedBytes).toBe(1_000);
    expect(result.capture.stdout.truncated || result.capture.stderr.truncated).toBe(true);
  });

  it("normalizes a child close code after the timeout boundary", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.spyOn(crossSpawn, "spawn").mockReturnValue(child as never);

    const result = runProcess(process.execPath, [], {
      cwd: process.cwd(),
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    child.emit("close", 1, null);

    await expect(result).resolves.toMatchObject({
      exitCode: 124,
      timedOut: true,
      childSettlement: "confirmed",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("settles after escalation when a timed-out child never emits close", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough({ highWaterMark: 1 }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.spyOn(crossSpawn, "spawn").mockReturnValue(child as never);

    const result = runProcess(process.execPath, [], {
      cwd: process.cwd(),
      timeoutMs: 10,
      input: Buffer.from("backpressured input"),
    });
    await vi.advanceTimersByTimeAsync(
      10 + PROCESS_TERMINATION_GRACE_MS + PROCESS_SETTLEMENT_GRACE_MS + 1,
    );

    await expect(result).resolves.toMatchObject({
      exitCode: 124,
      timedOut: true,
      childSettlement: "unconfirmed",
    });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("retains unconfirmed child settlement on rejected output overflow", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.spyOn(crossSpawn, "spawn").mockReturnValue(child as never);

    const result = runProcess(process.execPath, [], {
      cwd: process.cwd(),
      maxOutputBytesPerStream: 1,
    });
    const observedResult = result.then(
      () => undefined,
      (error: unknown) => error,
    );
    child.stdout.write("overflow");
    await vi.advanceTimersByTimeAsync(
      PROCESS_TERMINATION_GRACE_MS + PROCESS_SETTLEMENT_GRACE_MS + 1,
    );

    await expect(observedResult).resolves.toMatchObject({
      name: "ProcessOutputLimitError",
      stream: "stdout",
      childSettlement: "unconfirmed",
    });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
