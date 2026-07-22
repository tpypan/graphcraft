const secretKey =
  /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential)/i;

const secretPatterns: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s,;"'\])}]+/gi,
  /\b(?:token|password|passwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*[^\s,;"'\])}]+/gi,
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
  /([?&](?:access_token|refresh_token|token|api[_-]?key|password|secret)=)[^&#\s"'\])}]+/gi,
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
  for (const pattern of secretPatterns)
    result = result.replace(pattern, (match, schemeOrPrefix: string | undefined) => {
      if (match.includes("://") && schemeOrPrefix) return `${schemeOrPrefix}[REDACTED]@`;
      if ((match.startsWith("?") || match.startsWith("&")) && schemeOrPrefix)
        return `${schemeOrPrefix}[REDACTED]`;
      return "[REDACTED]";
    });
  return result;
}

function redact(value: unknown, key: string, configured: string[]): unknown {
  if (secretKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value, configured);
  if (Array.isArray(value)) return value.map((item) => redact(item, "", configured));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redact(item, name, configured)]),
    );
  return value;
}

export function redactValue(value: unknown): unknown {
  return redact(value, "", configuredSensitiveValues());
}

export function redactTextBytes(value: string | Uint8Array): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return Buffer.from(redactString(text));
  } catch {
    return Buffer.from(redactString(bytes.toString("latin1")), "latin1");
  }
}

export function assertPersistenceSafe(value: unknown, label: string): void {
  if (JSON.stringify(redactValue(value)) !== JSON.stringify(value))
    throw new Error(`${label} contains secret-like material and cannot be persisted or executed`);
}
