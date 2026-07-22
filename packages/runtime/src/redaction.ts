const secretKey =
  /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential)/i;

const quotedJsonMemberPattern = /("(?:\\.|[^"\\])*")(\s*:\s*)("(?:\\.|[^"\\])*")/g;

const quotedAssignmentPatterns = [
  /\b((?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*)("(?:\\.|[^"\\])*")/g,
  /\b((?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*)('(?:\\.|[^'\\])*')/g,
];

const unquotedAssignmentPattern =
  /\b((?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*)([^\s,;"']+)/g;

const secretPatterns: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s,;"'\])}]+/gi,
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
  /([?&](?:access_token|refresh_token|token|api[_-]?key|password|secret)=)(?:\[REDACTED\]|[^&#\s"'\])}]+)/gi,
];

function configuredSensitiveValues(): string[] {
  return [
    ...new Set(
      Object.entries(process.env)
        .filter(([name, value]) => secretKey.test(name) && typeof value === "string")
        .map(([, value]) => value!)
        .filter((value) => value.length >= 6),
    ),
  ].sort((left, right) => right.length - left.length);
}

export function redactString(value: string, configured = configuredSensitiveValues()): string {
  let result = value;
  for (const sensitive of configured) result = result.split(sensitive).join("[REDACTED]");
  result = result.replace(
    quotedJsonMemberPattern,
    (match, encodedKey: string, separator: string, encodedValue: string) => {
      try {
        const key = JSON.parse(encodedKey) as string;
        if (!secretKey.test(key) || JSON.parse(encodedValue) === "[REDACTED]") return match;
      } catch {
        return match;
      }
      return `${encodedKey}${separator}"[REDACTED]"`;
    },
  );
  for (const pattern of quotedAssignmentPatterns)
    result = result.replace(pattern, (match, prefix: string, key: string, encodedValue: string) =>
      !secretKey.test(key) || encodedValue === '"[REDACTED]"' || encodedValue === "'[REDACTED]'"
        ? match
        : `${prefix}${encodedValue[0]}[REDACTED]${encodedValue[0]}`,
    );
  for (const pattern of secretPatterns)
    result = result.replace(pattern, (match, schemeOrPrefix: string | undefined) => {
      if (match.includes("://") && schemeOrPrefix) return `${schemeOrPrefix}[REDACTED]@`;
      if ((match.startsWith("?") || match.startsWith("&")) && schemeOrPrefix)
        return `${schemeOrPrefix}[REDACTED]`;
      return "[REDACTED]";
    });
  result = result.replace(
    unquotedAssignmentPattern,
    (match, prefix: string, key: string, assignmentValue: string) =>
      !secretKey.test(key) || assignmentValue === "[REDACTED]" ? match : `${prefix}[REDACTED]`,
  );
  return result;
}

const MAX_STRUCTURED_REDACTION_DEPTH = 512;

function redact(value: unknown, key: string, configured: string[], depth = 0): unknown {
  if (depth > MAX_STRUCTURED_REDACTION_DEPTH)
    throw new Error("Structured value exceeds the safe redaction depth");
  if (secretKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value, configured);
  if (Array.isArray(value)) return value.map((item) => redact(item, "", configured, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        redact(item, name, configured, depth + 1),
      ]),
    );
  return value;
}

export function redactValue(value: unknown): unknown {
  return redact(value, "", configuredSensitiveValues());
}

interface StructuredRedaction {
  matched: boolean;
  value: string;
}

interface JsonReplacement {
  start: number;
  end: number;
  value: string;
}

function skipJsonWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /[\t\n\r ]/u.test(source[index]!)) index += 1;
  return index;
}

function scanJsonString(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === '"') return index + 1;
    index += 1;
  }
  throw new Error("Validated JSON string was unexpectedly unterminated");
}

/**
 * JSON.parse intentionally collapses duplicate object keys. Scan the already
 * validated source as well so an earlier sensitive member cannot be hidden by
 * a later duplicate while harmless JSON remains byte-for-byte unchanged.
 */
function redactJsonTokens(source: string, configured: string[]): string {
  const replacements: JsonReplacement[] = [];
  let scanValue: (start: number, collect: boolean) => number;

  const scanObject = (start: number, collect: boolean): number => {
    let index = skipJsonWhitespace(source, start + 1);
    if (source[index] === "}") return index + 1;
    while (index < source.length) {
      const keyStart = index;
      const keyEnd = scanJsonString(source, keyStart);
      const key = JSON.parse(source.slice(keyStart, keyEnd)) as string;
      const redactedKey = redactString(key, configured);
      if (collect && redactedKey !== key)
        replacements.push({ start: keyStart, end: keyEnd, value: JSON.stringify(redactedKey) });
      index = skipJsonWhitespace(source, keyEnd);
      index = skipJsonWhitespace(source, index + 1);
      const valueStart = index;
      const sensitive = collect && secretKey.test(key);
      const valueEnd = scanValue(valueStart, collect && !sensitive);
      if (sensitive && JSON.parse(source.slice(valueStart, valueEnd)) !== "[REDACTED]")
        replacements.push({ start: valueStart, end: valueEnd, value: '"[REDACTED]"' });
      index = skipJsonWhitespace(source, valueEnd);
      if (source[index] === "}") return index + 1;
      index = skipJsonWhitespace(source, index + 1);
    }
    throw new Error("Validated JSON object was unexpectedly unterminated");
  };

  const scanArray = (start: number, collect: boolean): number => {
    let index = skipJsonWhitespace(source, start + 1);
    if (source[index] === "]") return index + 1;
    while (index < source.length) {
      index = skipJsonWhitespace(source, scanValue(index, collect));
      if (source[index] === "]") return index + 1;
      index = skipJsonWhitespace(source, index + 1);
    }
    throw new Error("Validated JSON array was unexpectedly unterminated");
  };

  scanValue = (start: number, collect: boolean): number => {
    const index = skipJsonWhitespace(source, start);
    if (source[index] === "{") return scanObject(index, collect);
    if (source[index] === "[") return scanArray(index, collect);
    if (source[index] === '"') {
      const end = scanJsonString(source, index);
      if (collect) {
        const value = JSON.parse(source.slice(index, end)) as string;
        const redacted = redactString(value, configured);
        if (redacted !== value)
          replacements.push({ start: index, end, value: JSON.stringify(redacted) });
      }
      return end;
    }
    let end = index;
    while (end < source.length && !/[\t\n\r ,\]}]/u.test(source[end]!)) end += 1;
    return end;
  };

  scanValue(source.startsWith("\uFEFF") ? 1 : 0, true);
  if (replacements.length === 0) return source;
  const chunks: string[] = [];
  let cursor = 0;
  for (const replacement of replacements.sort((left, right) => left.start - right.start)) {
    if (replacement.start < cursor)
      throw new Error("Validated JSON produced overlapping redaction ranges");
    chunks.push(source.slice(cursor, replacement.start), replacement.value);
    cursor = replacement.end;
  }
  chunks.push(source.slice(cursor));
  return chunks.join("");
}

function replaceJsonValue(source: string, value: unknown, configured: string[]): string {
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? source.slice(1) : source;
  const leading = body.match(/^[\t\n\r ]*/u)?.[0] ?? "";
  const trailing = body.match(/[\t\n\r ]*$/u)?.[0] ?? "";
  const tokenRedacted = redactJsonTokens(JSON.stringify(value), configured);
  const serialized =
    redactString(tokenRedacted, configured) === tokenRedacted
      ? tokenRedacted
      : JSON.stringify("[REDACTED]");
  return `${bom}${leading}${serialized}${trailing}`;
}

function redactJsonDocument(source: string, configured: string[]): StructuredRedaction {
  const bom = source.startsWith("\uFEFF") ? source.slice(1) : source;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bom);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { matched: false, value: source };
  }

  const redacted = redact(parsed, "", configured);
  if (JSON.stringify(redacted) !== JSON.stringify(parsed))
    return { matched: true, value: replaceJsonValue(source, redacted, configured) };

  const tokenRedacted = redactJsonTokens(source, configured);
  return {
    matched: true,
    value:
      redactString(tokenRedacted, configured) === tokenRedacted
        ? tokenRedacted
        : replaceJsonValue(source, "[REDACTED]", configured),
  };
}

function redactJsonLines(source: string, configured: string[]): StructuredRedaction {
  const parts = source.split(/(\r\n|\n|\r)/u);
  let records = 0;
  let changed = false;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    if (/^[\t ]*$/u.test(line)) continue;
    const redacted = redactJsonDocument(line, configured);
    if (!redacted.matched) return { matched: false, value: source };
    records += 1;
    if (redacted.value !== line) {
      parts[index] = redacted.value;
      changed = true;
    }
  }
  return {
    matched: records > 0,
    value: changed ? parts.join("") : source,
  };
}

export function redactTextBytes(value: string | Uint8Array): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return Buffer.from(redactString(bytes.toString("latin1")), "latin1");
  }
  try {
    const configured = configuredSensitiveValues();
    const document = redactJsonDocument(text, configured);
    if (document.matched) return Buffer.from(document.value);
    const lines = redactJsonLines(text, configured);
    if (!lines.matched) return Buffer.from(redactString(text, configured));
    if (redactString(lines.value, configured) === lines.value) return Buffer.from(lines.value);
    const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
    const ending = text.endsWith("\r\n") ? "\r\n" : text.endsWith("\r") ? "\r" : "\n";
    return Buffer.from(`${bom}"[REDACTED]"${ending}`);
  } catch (error) {
    throw new Error("Text could not be redacted safely", { cause: error });
  }
}

export function assertPersistenceSafe(value: unknown, label: string): void {
  if (JSON.stringify(redactValue(value)) !== JSON.stringify(value))
    throw new Error(`${label} contains secret-like material and cannot be persisted or executed`);
}
