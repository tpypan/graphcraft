import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runProcess } from "./process.ts";

describe("bounded subprocess output capture", () => {
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
});
