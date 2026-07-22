import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const MIB = 1024 * 1024;

export const DEFAULT_PROCESS_OUTPUT_BYTES_PER_STREAM = 8 * MIB;
export const DEFAULT_PROBE_OUTPUT_BYTES_PER_STREAM = MIB;

export type ProcessOutputOverflow = "reject" | "truncate";

export interface ProcessStreamCapture {
  limitBytes: number;
  observedBytes: number;
  retainedBytes: number;
  omittedBytes: number;
  truncated: boolean;
  digest: string;
}

export interface ProcessCaptureMetadata {
  stdout: ProcessStreamCapture;
  stderr: ProcessStreamCapture;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  capture: ProcessCaptureMetadata;
}

export interface RunProcessOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxOutputBytesPerStream?: number;
  outputOverflow?: ProcessOutputOverflow;
}

export class ProcessOutputLimitError extends Error {
  readonly stream: "stdout" | "stderr";
  readonly capture: ProcessCaptureMetadata;

  constructor(stream: "stdout" | "stderr", capture: ProcessCaptureMetadata) {
    const limit = capture[stream].limitBytes;
    super(`Subprocess ${stream} exceeded the ${limit}-byte capture limit; output was rejected`);
    this.name = "ProcessOutputLimitError";
    this.stream = stream;
    this.capture = capture;
  }
}

interface DecodedPrefix {
  bytes: number;
  text: string;
}

function decodeUtf8Prefix(source: Buffer): DecodedPrefix {
  for (let trim = 0; trim <= Math.min(3, source.length); trim += 1) {
    const end = source.length - trim;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(0, end));
      return { bytes: end, text };
    } catch {
      // A bounded capture can end in the middle of one UTF-8 code point.
    }
  }
  return { bytes: source.length, text: source.toString("utf8") };
}

function truncationMarker(stream: "stdout" | "stderr", capture: ProcessStreamCapture): string {
  return `[GRAPHCRAFT ${stream.toUpperCase()} TRUNCATED: retained ${capture.retainedBytes} of ${capture.observedBytes} bytes]`;
}

class BoundedStreamCapture {
  private readonly chunks: Buffer[] = [];
  private readonly digest = createHash("sha256");
  private observedBytes = 0;
  private retainedBytes = 0;

  constructor(private readonly limitBytes: number) {}

  append(chunk: Buffer): boolean {
    this.digest.update(chunk);
    this.observedBytes += chunk.length;
    const available = Math.max(0, this.limitBytes - this.retainedBytes);
    if (available > 0) {
      const retained = Buffer.from(chunk.subarray(0, available));
      this.chunks.push(retained);
      this.retainedBytes += retained.length;
    }
    return this.observedBytes > this.limitBytes;
  }

  finish(stream: "stdout" | "stderr"): {
    text: string;
    metadata: ProcessStreamCapture;
  } {
    const decoded = decodeUtf8Prefix(Buffer.concat(this.chunks, this.retainedBytes));
    const metadata: ProcessStreamCapture = {
      limitBytes: this.limitBytes,
      observedBytes: this.observedBytes,
      retainedBytes: decoded.bytes,
      omittedBytes: Math.max(0, this.observedBytes - decoded.bytes),
      truncated: decoded.bytes < this.observedBytes,
      digest: this.digest.digest("hex"),
    };
    if (!metadata.truncated) return { text: decoded.text, metadata };
    const separator = decoded.text.length > 0 && !decoded.text.endsWith("\n") ? "\n" : "";
    return {
      text: `${decoded.text}${separator}${truncationMarker(stream, metadata)}\n`,
      metadata,
    };
  }
}

export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytesPerStream =
    options.maxOutputBytesPerStream ?? DEFAULT_PROCESS_OUTPUT_BYTES_PER_STREAM;
  const outputOverflow = options.outputOverflow ?? "reject";
  if (!Number.isSafeInteger(maxOutputBytesPerStream) || maxOutputBytesPerStream <= 0)
    throw new Error("Subprocess output capture limit must be a positive safe integer");

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutCapture = new BoundedStreamCapture(maxOutputBytesPerStream);
    const stderrCapture = new BoundedStreamCapture(maxOutputBytesPerStream);
    let timedOut = false;
    let overflowStream: "stdout" | "stderr" | undefined;
    let settled = false;
    let escalationTimer: NodeJS.Timeout | undefined;

    const terminateWithEscalation = (): void => {
      child.kill("SIGTERM");
      if (escalationTimer) return;
      escalationTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      escalationTimer.unref();
    };
    const capture = (
      stream: "stdout" | "stderr",
      target: BoundedStreamCapture,
      chunk: Buffer,
    ): void => {
      const overflowed = target.append(chunk);
      if (overflowed && outputOverflow === "reject" && !overflowStream) {
        overflowStream = stream;
        terminateWithEscalation();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", stdoutCapture, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", stderrCapture, chunk));

    const abort = (): void => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const timer = setTimeout(() => {
      timedOut = true;
      terminateWithEscalation();
    }, timeoutMs);
    timer.unref();

    const cleanup = (): void => {
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      options.signal?.removeEventListener("abort", abort);
    };

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdout = stdoutCapture.finish("stdout");
      const stderr = stderrCapture.finish("stderr");
      const captureMetadata: ProcessCaptureMetadata = {
        stdout: stdout.metadata,
        stderr: stderr.metadata,
      };
      if (overflowStream) {
        reject(new ProcessOutputLimitError(overflowStream, captureMetadata));
        return;
      }
      resolve({
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: Math.round(performance.now() - started),
        timedOut,
        capture: captureMetadata,
      });
    });
  });
}
