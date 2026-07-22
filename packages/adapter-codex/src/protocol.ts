import type { Readable } from "node:stream";

const KIB = 1024;
const MIB = 1024 * KIB;

export const ADAPTER_STDERR_LIMIT_BYTES = 8 * KIB;
export const ADAPTER_PROTOCOL_LINE_LIMIT_BYTES = 2 * MIB;
export const ADAPTER_STRUCTURED_OUTPUT_LIMIT_BYTES = MIB;

function decodeUtf8Prefix(source: Buffer): string {
  for (let trim = 0; trim <= Math.min(3, source.length); trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        source.subarray(0, source.length - trim),
      );
    } catch {
      // The retained byte prefix can end in the middle of one UTF-8 code point.
    }
  }
  return source.toString("utf8");
}

export class BoundedTextCapture {
  private readonly chunks: Buffer[] = [];
  private observedBytes = 0;
  private retainedBytes = 0;

  constructor(private readonly limitBytes: number) {}

  append(chunk: Buffer | string): void {
    const source = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.observedBytes += source.length;
    const available = Math.max(0, this.limitBytes - this.retainedBytes);
    if (available === 0) return;
    const retained = Buffer.from(source.subarray(0, available));
    this.chunks.push(retained);
    this.retainedBytes += retained.length;
  }

  get overflowed(): boolean {
    return this.observedBytes > this.limitBytes;
  }

  text(): string {
    const prefix = decodeUtf8Prefix(Buffer.concat(this.chunks, this.retainedBytes));
    if (!this.overflowed) return prefix;
    const separator = prefix.length > 0 && !prefix.endsWith("\n") ? "\n" : "";
    return `${prefix}${separator}[Graphcraft truncated host stderr after ${this.limitBytes} bytes]`;
  }
}

export function captureStderr(stream: Readable): BoundedTextCapture {
  const capture = new BoundedTextCapture(ADAPTER_STDERR_LIMIT_BYTES);
  stream.on("data", (chunk: Buffer | string) => capture.append(chunk));
  return capture;
}

export interface BoundedProtocolLine {
  observedBytes: number;
  overflowed: boolean;
  text?: string;
}

class LineAccumulator {
  private readonly chunks: Buffer[] = [];
  private observedBytes = 0;
  private retainedBytes = 0;

  append(source: Buffer): void {
    this.observedBytes += source.length;
    const available = Math.max(0, ADAPTER_PROTOCOL_LINE_LIMIT_BYTES - this.retainedBytes);
    if (available === 0) return;
    const retained = Buffer.from(source.subarray(0, available));
    this.chunks.push(retained);
    this.retainedBytes += retained.length;
  }

  finish(): BoundedProtocolLine {
    const observedBytes = this.observedBytes;
    const overflowed = observedBytes > ADAPTER_PROTOCOL_LINE_LIMIT_BYTES;
    if (overflowed) return { observedBytes, overflowed };
    let source = Buffer.concat(this.chunks, this.retainedBytes);
    if (source.at(-1) === 0x0d) source = source.subarray(0, -1);
    return { observedBytes, overflowed, text: source.toString("utf8") };
  }

  get empty(): boolean {
    return this.observedBytes === 0;
  }
}

export async function* readBoundedProtocolLines(
  stream: Readable,
  signal?: AbortSignal,
): AsyncIterable<BoundedProtocolLine> {
  let line = new LineAccumulator();
  try {
    for await (const chunk of stream) {
      const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < source.length) {
        const newline = source.indexOf(0x0a, offset);
        if (newline === -1) {
          line.append(source.subarray(offset));
          break;
        }
        line.append(source.subarray(offset, newline));
        yield line.finish();
        line = new LineAccumulator();
        offset = newline + 1;
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
    return;
  }
  if (!line.empty) yield line.finish();
}

export function structuredOutputExceedsLimit(value: unknown): boolean {
  if (typeof value === "string") {
    return Buffer.byteLength(value) > ADAPTER_STRUCTURED_OUTPUT_LIMIT_BYTES;
  }
  try {
    const serialized = JSON.stringify(value);
    return (
      typeof serialized === "string" &&
      Buffer.byteLength(serialized) > ADAPTER_STRUCTURED_OUTPUT_LIMIT_BYTES
    );
  } catch {
    return false;
  }
}

export function protocolLineLimitError(host: "Codex" | "Claude"): Error {
  return new Error(
    `${host} protocol line exceeded the ${ADAPTER_PROTOCOL_LINE_LIMIT_BYTES}-byte limit; output was rejected`,
  );
}

export function structuredOutputLimitError(host: "Codex" | "Claude", kind: string): Error {
  return new Error(
    `${host} ${kind} exceeded the ${ADAPTER_STRUCTURED_OUTPUT_LIMIT_BYTES}-byte structured-output limit; output was rejected`,
  );
}
