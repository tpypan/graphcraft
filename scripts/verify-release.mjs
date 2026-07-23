#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const PUBLIC_PACKAGE = "@tpypan/graphcraft";
const RELEASE_MANIFESTS = [
  "package.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
];
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
const PROVENANCE_STATEMENT = "https://in-toto.io/Statement/v1";
const PROVENANCE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const GITHUB_BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const GITHUB_REPOSITORY_URL = "https://github.com/tpypan/graphcraft";
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
const RELEASE_METHODS = new Set(["npm", "pnpm", "npx", "pnpm-dlx"]);
const TRANSIENT_REGISTRY_STATUSES = new Set([404, 408, 425, 429, 500, 502, 503, 504]);
const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const SMOKE_COMMAND_TIMEOUT_MS = 5 * 60_000;
const SMOKE_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const SMOKE_TERMINATION_GRACE_MS = 1_000;

function fail(message) {
  throw new Error(message);
}

class RegistryPropagationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryPropagationError";
  }
}

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be non-empty`);
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${label} must be a positive integer`);
  return parsed;
}

function delay(milliseconds) {
  return new Promise((accept) => setTimeout(accept, milliseconds));
}

function transientRegistryError(error) {
  return (
    error instanceof RegistryPropagationError ||
    TRANSIENT_REGISTRY_STATUSES.has(error?.status) ||
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    error instanceof TypeError
  );
}

async function readJson(path, label = path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} must contain valid JSON`, { cause: error });
  }
  if (!plainObject(parsed)) fail(`${label} must contain a JSON object`);
  return parsed;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function parseReleaseTag(tag) {
  requiredString(tag, "release tag");
  const match = tag.match(
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
  );
  if (!match) {
    fail(`Release tag must be an exact v-prefixed semantic version: ${tag}`);
  }
  if (match[4]) fail(`Prerelease tags are not supported by the stable npm release channel: ${tag}`);
  if (match[5]) fail(`Build metadata is not supported in Graphcraft release tags: ${tag}`);
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function sectionBody(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`^## ${escaped}\\s*\\n([\\s\\S]*?)(?=^## |\\s*$)`, "m"));
  return match?.[1]?.trim();
}

export function validateReleaseNotes(markdown, tag) {
  const normalized = requiredString(markdown, "release notes").replaceAll("\r\n", "\n");
  const expectedTitle = `# Graphcraft ${tag}`;
  if (normalized.split("\n", 1)[0]?.trim() !== expectedTitle) {
    fail(`Release notes must start with ${expectedTitle}`);
  }

  for (const heading of ["Release notes", "Persisted-format migration"]) {
    const body = sectionBody(normalized, heading);
    if (!body || body.length < 10 || /\b(?:TBD|TODO|PLACEHOLDER)\b/i.test(body)) {
      fail(`Release notes require a substantive \"${heading}\" section`);
    }
  }
  return true;
}

export async function validateReleaseMetadata({ root = process.cwd(), tag }) {
  const version = parseReleaseTag(tag);
  const versions = {};
  for (const relativePath of RELEASE_MANIFESTS) {
    const manifest = await readJson(resolve(root, relativePath), relativePath);
    versions[relativePath] = requiredString(manifest.version, `${relativePath} version`);
  }

  const mismatches = Object.entries(versions).filter(([, actual]) => actual !== version);
  if (mismatches.length > 0) {
    fail(
      `Release version ${version} does not match ${mismatches
        .map(([path, actual]) => `${path} (${actual})`)
        .join(", ")}`,
    );
  }

  const packageMetadata = await readJson(resolve(root, "package.json"), "package.json");
  if (packageMetadata.name !== PUBLIC_PACKAGE) {
    fail(`Public package name must remain ${PUBLIC_PACKAGE}`);
  }
  if (packageMetadata.private === true) fail("Public package must not be private");
  if (packageMetadata.publishConfig?.access !== "public") {
    fail("Public scoped package must set publishConfig.access to public");
  }

  const releaseNotes = `docs/releases/${tag}.md`;
  const releaseNotesSource = await readFile(resolve(root, releaseNotes), "utf8").catch((error) => {
    throw new Error(`Release notes are required at ${releaseNotes}`, { cause: error });
  });
  validateReleaseNotes(releaseNotesSource, tag);

  return {
    packageName: PUBLIC_PACKAGE,
    releaseNotes,
    tag,
    version,
    versions,
  };
}

async function runGit(root, arguments_, description) {
  try {
    const { stdout } = await execFileAsync("git", arguments_, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`Unable to ${description}`, { cause: error });
  }
}

export async function validateTagCheckout({ root = process.cwd(), tag, requireRef }) {
  parseReleaseTag(tag);
  const reference = `refs/tags/${tag}`;
  const tagOid = await runGit(root, ["rev-parse", "--verify", reference], `resolve ${reference}`);
  const objectType = await runGit(root, ["cat-file", "-t", tagOid], `inspect ${reference}`);
  if (objectType !== "tag") {
    fail(`${tag} must be an annotated tag; lightweight tags cannot be released`);
  }

  const commit = await runGit(
    root,
    ["rev-parse", "--verify", `${reference}^{commit}`],
    `resolve the commit for ${reference}`,
  );
  const head = await runGit(root, ["rev-parse", "--verify", "HEAD"], "resolve HEAD");
  if (head !== commit) fail(`${tag} targets ${commit}, but the checked-out commit is ${head}`);

  if (requireRef) {
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", commit, requireRef], {
        cwd: root,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`${tag} must target a commit reachable from ${requireRef}`, { cause: error });
    }
  }

  const status = await runGit(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "inspect the release checkout",
  );
  if (status !== "") fail("Release checkout must be clean before packaging");

  return { commit, tagOid };
}

export function validateGitHubTagPayload(payload, { tag, tagOid, commit }) {
  if (!plainObject(payload)) fail("GitHub tag response must be an object");
  if (payload.sha !== tagOid) fail("GitHub returned a different annotated tag object");
  if (payload.tag !== tag) fail("GitHub returned a different tag name");
  if (
    !plainObject(payload.object) ||
    payload.object.type !== "commit" ||
    payload.object.sha !== commit
  ) {
    fail("GitHub tag verification is not bound to the checked-out release commit");
  }
  if (!plainObject(payload.verification)) fail("GitHub tag verification is missing");
  if (payload.verification.verified !== true || payload.verification.reason !== "valid") {
    fail(
      `GitHub did not verify the annotated tag signature (${String(
        payload.verification.reason ?? "unknown",
      )})`,
    );
  }
  requiredString(payload.verification.signature, "GitHub tag signature");
  return true;
}

export function validateGitHubTagRefPayload(payload, { tag, tagOid }) {
  if (!plainObject(payload)) fail("GitHub tag ref response must be an object");
  if (payload.ref !== `refs/tags/${tag}`) fail("GitHub returned a different tag ref");
  if (
    !plainObject(payload.object) ||
    payload.object.type !== "tag" ||
    payload.object.sha !== tagOid
  ) {
    fail("GitHub tag ref no longer points to the expected annotated tag object");
  }
  return true;
}

function validateGitObjectId(value, label) {
  const objectId = requiredString(value, label);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(objectId)) {
    fail(`${label} must be a lowercase Git object ID`);
  }
  return objectId;
}

export async function verifyGitHubTagRef({
  repository,
  tag,
  tagOid,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  requestTimeoutMs = HTTP_REQUEST_TIMEOUT_MS,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail("GitHub repository must be in owner/name form");
  }
  requiredString(token, "GitHub token");
  const endpoint = `${apiUrl.replace(/\/$/, "")}/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`;
  const response = await fetchImpl(endpoint, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) fail(`GitHub tag ref request failed with HTTP ${response.status}`);
  const payload = await response.json();
  validateGitHubTagRefPayload(payload, { tag, tagOid });
  return payload;
}

export async function verifyGitHubTag({
  repository,
  tag,
  tagOid,
  commit,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  requestTimeoutMs = HTTP_REQUEST_TIMEOUT_MS,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail("GitHub repository must be in owner/name form");
  }
  requiredString(token, "GitHub token");
  const endpoint = `${apiUrl.replace(/\/$/, "")}/repos/${repository}/git/tags/${tagOid}`;
  const response = await fetchImpl(endpoint, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) fail(`GitHub tag verification request failed with HTTP ${response.status}`);
  const payload = await response.json();
  validateGitHubTagPayload(payload, { tag, tagOid, commit });
  return payload;
}

export async function verifyReleaseIdentity({
  root = process.cwd(),
  tag,
  tagOid,
  commit,
  eventSha,
  requireRef,
  repository,
  token,
  apiUrl,
  fetchImpl,
  requestTimeoutMs,
}) {
  const checkout = await validateTagCheckout({ root, tag, ...(requireRef ? { requireRef } : {}) });
  const expectedTagOid = tagOid
    ? validateGitObjectId(tagOid, "expected tag object")
    : checkout.tagOid;
  const expectedCommit = commit
    ? validateGitObjectId(commit, "expected release commit")
    : checkout.commit;
  if (checkout.tagOid !== expectedTagOid) {
    fail(`${tag} tag object changed from ${expectedTagOid} to ${checkout.tagOid}`);
  }
  if (checkout.commit !== expectedCommit) {
    fail(`${tag} peeled commit changed from ${expectedCommit} to ${checkout.commit}`);
  }
  if (eventSha) {
    const expectedEventSha = validateGitObjectId(eventSha, "release event SHA");
    if (expectedEventSha !== expectedTagOid && expectedEventSha !== expectedCommit) {
      fail("Release event SHA is bound to neither the annotated tag object nor its peeled commit");
    }
  }
  if (repository) {
    const request = {
      repository,
      tag,
      tagOid: expectedTagOid,
      token: requiredString(token, "GitHub token"),
      ...(apiUrl ? { apiUrl } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    };
    await verifyGitHubTagRef(request);
    await verifyGitHubTag({ ...request, commit: expectedCommit });
  }
  return checkout;
}

export function artifactDigests(bytes) {
  return {
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("base64"),
  };
}

export function validateArtifactManifest(manifest) {
  if (!plainObject(manifest) || manifest.schemaVersion !== 1) {
    fail("Release artifact manifest must use schema version 1");
  }
  if (manifest.packageName !== PUBLIC_PACKAGE) fail("Release artifact package name is invalid");
  const version = parseReleaseTag(requiredString(manifest.tag, "artifact tag"));
  if (manifest.version !== version) fail("Artifact tag and version do not match");
  const commit = requiredString(manifest.commit, "artifact commit");
  const tagOid = requiredString(manifest.tagOid, "artifact tag object");
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tagOid)
  ) {
    fail("Artifact commit and tag object must be lowercase Git object IDs");
  }
  const tarball = requiredString(manifest.tarball, "artifact tarball");
  const expectedTarball = `tpypan-graphcraft-${version}.tgz`;
  if (tarball !== basename(tarball) || tarball !== expectedTarball) {
    fail(`Artifact tarball must be the exact npm pack filename ${expectedTarball}`);
  }
  if (!plainObject(manifest.digests)) fail("Artifact digests are missing");
  const sha1 = requiredString(manifest.digests.sha1, "artifact SHA-1");
  const sha256 = requiredString(manifest.digests.sha256, "artifact SHA-256");
  const sha512 = requiredString(manifest.digests.sha512, "artifact SHA-512");
  if (!/^[a-f0-9]{40}$/u.test(sha1) || !/^[a-f0-9]{64}$/u.test(sha256)) {
    fail("Artifact SHA-1 or SHA-256 digest is malformed");
  }
  let sha512Bytes;
  try {
    sha512Bytes = Buffer.from(sha512, "base64");
  } catch {
    fail("Artifact SHA-512 digest is malformed");
  }
  if (sha512Bytes.length !== 64 || sha512Bytes.toString("base64") !== sha512) {
    fail("Artifact SHA-512 digest is malformed");
  }
  if (manifest.integrity !== `sha512-${manifest.digests.sha512}`) {
    fail("Artifact integrity does not match its SHA-512 digest");
  }
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 1) {
    fail("Artifact size must be a positive integer");
  }
  return manifest;
}

export async function verifyArtifactFile({ directory, artifactManifest }) {
  const artifact = validateArtifactManifest(artifactManifest);
  const root = resolve(directory);
  const tarball = resolve(root, artifact.tarball);
  if (dirname(tarball) !== root)
    fail("Verified artifact must remain inside its artifact directory");
  const [bytes, file] = await Promise.all([readFile(tarball), stat(tarball)]).catch((error) => {
    throw new Error(`Unable to read the manifest-bound tarball ${artifact.tarball}`, {
      cause: error,
    });
  });
  if (!file.isFile()) fail(`Manifest-bound artifact is not a file: ${artifact.tarball}`);
  if (file.size !== artifact.size || bytes.byteLength !== artifact.size) {
    fail(`Manifest-bound artifact size does not match ${artifact.tarball}`);
  }
  const actual = artifactDigests(bytes);
  for (const algorithm of ["sha1", "sha256", "sha512"]) {
    if (actual[algorithm] !== artifact.digests[algorithm]) {
      fail(`Manifest-bound artifact ${algorithm.toUpperCase()} does not match ${artifact.tarball}`);
    }
  }
  return tarball;
}

export async function createArtifactManifest({
  root = process.cwd(),
  tag,
  tagOid: expectedTagOid,
  commit: expectedCommit,
  tarball,
}) {
  const metadata = await validateReleaseMetadata({ root, tag });
  const { commit, tagOid } = await validateTagCheckout({ root, tag });
  if (expectedTagOid && tagOid !== validateGitObjectId(expectedTagOid, "expected tag object")) {
    fail(`Artifact tag object changed from ${expectedTagOid} to ${tagOid}`);
  }
  if (expectedCommit && commit !== validateGitObjectId(expectedCommit, "expected release commit")) {
    fail(`Artifact commit changed from ${expectedCommit} to ${commit}`);
  }
  const absoluteTarball = resolve(root, tarball);
  const bytes = await readFile(absoluteTarball);
  const digests = artifactDigests(bytes);
  const file = await stat(absoluteTarball);
  const manifest = {
    schemaVersion: 1,
    packageName: metadata.packageName,
    version: metadata.version,
    tag,
    tagOid,
    commit,
    releaseNotes: metadata.releaseNotes,
    tarball: basename(absoluteTarball),
    size: file.size,
    integrity: `sha512-${digests.sha512}`,
    digests,
  };
  return validateArtifactManifest(manifest);
}

export async function compareArtifacts(left, right) {
  const [leftBytes, rightBytes] = await Promise.all([readFile(left), readFile(right)]);
  const leftDigests = artifactDigests(leftBytes);
  const rightDigests = artifactDigests(rightBytes);
  if (leftBytes.length !== rightBytes.length || leftDigests.sha512 !== rightDigests.sha512) {
    fail(`Release packages are not reproducible (${leftDigests.sha256} != ${rightDigests.sha256})`);
  }
  return leftDigests;
}

export function validatePublishedMetadata(metadata, artifactManifest) {
  const artifact = validateArtifactManifest(artifactManifest);
  if (!plainObject(metadata)) fail("Published package metadata must be an object");
  if (metadata.name !== artifact.packageName || metadata.version !== artifact.version) {
    fail("Published package identity does not match the release artifact");
  }
  if (!plainObject(metadata.dist)) fail("Published package dist metadata is missing");
  if (metadata.dist.integrity !== artifact.integrity) {
    fail("Published package integrity does not match the locally verified tarball");
  }
  if (metadata.dist.shasum !== artifact.digests.sha1) {
    fail("Published package shasum does not match the locally verified tarball");
  }
  if (!Array.isArray(metadata.dist.signatures) || metadata.dist.signatures.length === 0) {
    throw new RegistryPropagationError("Published package has no npm registry signature yet");
  }
  for (const signature of metadata.dist.signatures) {
    if (
      !plainObject(signature) ||
      typeof signature.keyid !== "string" ||
      signature.keyid.trim() === "" ||
      typeof signature.sig !== "string" ||
      signature.sig.trim() === ""
    ) {
      throw new RegistryPropagationError("Published package signature is still incomplete");
    }
  }
  if (
    !plainObject(metadata.dist.attestations) ||
    !plainObject(metadata.dist.attestations.provenance) ||
    metadata.dist.attestations.provenance.predicateType !== PROVENANCE_PREDICATE
  ) {
    throw new RegistryPropagationError(
      "Published package has no SLSA v1 provenance attestation yet",
    );
  }
  const attestationUrl = metadata.dist.attestations.url;
  if (typeof attestationUrl !== "string" || !attestationUrl.startsWith("https://")) {
    throw new RegistryPropagationError("Published package attestation URL is still incomplete");
  }
  const tarballUrl = requiredString(metadata.dist.tarball, "published package tarball URL");
  if (!tarballUrl.startsWith("https://")) {
    fail("Published package tarball URL must use HTTPS");
  }
  return true;
}

export function validatePublishedProvenance(payload, artifactManifest) {
  const artifact = validateArtifactManifest(artifactManifest);
  if (!plainObject(payload) || !Array.isArray(payload.attestations)) {
    throw new RegistryPropagationError("Published package attestations are still incomplete");
  }
  const candidates = payload.attestations.filter(
    (entry) => plainObject(entry) && entry.predicateType === PROVENANCE_PREDICATE,
  );
  if (candidates.length === 0) {
    throw new RegistryPropagationError("Published package has no SLSA v1 provenance bundle yet");
  }
  if (candidates.length !== 1) {
    fail("Published package has an ambiguous set of SLSA v1 provenance bundles");
  }

  const envelope = candidates[0].bundle?.dsseEnvelope;
  if (typeof envelope?.payloadType !== "string" || envelope.payloadType.trim() === "") {
    throw new RegistryPropagationError(
      "Published package provenance payload type is still incomplete",
    );
  }
  if (envelope.payloadType !== PROVENANCE_PAYLOAD_TYPE) {
    fail(`Published package provenance payload type is not ${PROVENANCE_PAYLOAD_TYPE}`);
  }
  const encoded = envelope?.payload;
  if (typeof encoded !== "string" || encoded.trim() === "") {
    throw new RegistryPropagationError("Published package provenance payload is still incomplete");
  }
  let statement;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== encoded) {
      fail("Published package provenance payload is not canonical base64");
    }
    statement = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Published package provenance payload is invalid", { cause: error });
  }
  if (!plainObject(statement)) fail("Published package provenance statement must be an object");
  if (
    statement._type !== PROVENANCE_STATEMENT ||
    statement.predicateType !== PROVENANCE_PREDICATE
  ) {
    fail("Published package provenance statement type is invalid");
  }

  const expectedSubjectName = `pkg:npm/${artifact.packageName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}@${artifact.version}`;
  const expectedSubjectSha512 = Buffer.from(artifact.digests.sha512, "base64").toString("hex");
  if (
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1 ||
    !plainObject(statement.subject[0]) ||
    statement.subject[0].name !== expectedSubjectName
  ) {
    fail(`Published package provenance subject is not exactly ${expectedSubjectName}`);
  }
  if (
    !plainObject(statement.subject[0].digest) ||
    statement.subject[0].digest.sha512 !== expectedSubjectSha512
  ) {
    fail("Published package provenance subject SHA-512 digest does not match the release tarball");
  }

  const buildDefinition = statement.predicate?.buildDefinition;
  if (!plainObject(buildDefinition) || buildDefinition.buildType !== GITHUB_BUILD_TYPE) {
    fail("Published package provenance did not use the GitHub Actions workflow build type");
  }
  const workflow = buildDefinition.externalParameters?.workflow;
  if (!plainObject(workflow) || workflow.repository !== GITHUB_REPOSITORY_URL) {
    fail(`Published package provenance repository is not ${GITHUB_REPOSITORY_URL}`);
  }
  if (workflow.path !== RELEASE_WORKFLOW_PATH) {
    fail(`Published package provenance workflow is not ${RELEASE_WORKFLOW_PATH}`);
  }
  const expectedRef = `refs/tags/${artifact.tag}`;
  if (workflow.ref !== expectedRef) {
    fail(`Published package provenance ref is not ${expectedRef}`);
  }
  if (buildDefinition.internalParameters?.github?.event_name !== "push") {
    fail("Published package provenance event is not push");
  }
  const dependencies = buildDefinition.resolvedDependencies;
  const expectedUri = `git+${GITHUB_REPOSITORY_URL}@${expectedRef}`;
  if (
    !Array.isArray(dependencies) ||
    dependencies.length !== 1 ||
    dependencies[0]?.uri !== expectedUri ||
    dependencies[0]?.digest?.gitCommit !== artifact.commit
  ) {
    fail(`Published package provenance is not bound to release commit ${artifact.commit}`);
  }
  return statement;
}

function registryEndpoint(registry, packageName, version) {
  return `${registry.replace(/\/$/, "")}/${encodeURIComponent(packageName)}/${encodeURIComponent(
    version,
  )}`;
}

function registryPackageEndpoint(registry, packageName) {
  return `${registry.replace(/\/$/, "")}/${encodeURIComponent(packageName)}`;
}

async function fetchPackageMetadata({
  packageName,
  registry = "https://registry.npmjs.org",
  fetchImpl = fetch,
  requestTimeoutMs = HTTP_REQUEST_TIMEOUT_MS,
}) {
  const response = await fetchImpl(registryPackageEndpoint(registry, packageName), {
    headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const error = new Error(`npm registry package request failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return await response.json();
}

async function fetchPublishedPackage({
  packageName,
  version,
  registry = "https://registry.npmjs.org",
  fetchImpl = fetch,
  requestTimeoutMs = HTTP_REQUEST_TIMEOUT_MS,
}) {
  const response = await fetchImpl(registryEndpoint(registry, packageName, version), {
    headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status === 404) return { status: "missing" };
  if (!response.ok) {
    const error = new Error(`npm registry request failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return { metadata: await response.json(), status: "published" };
}

async function fetchPublishedProvenance({
  artifactManifest,
  metadata,
  registry = "https://registry.npmjs.org",
  fetchImpl = fetch,
  requestTimeoutMs = HTTP_REQUEST_TIMEOUT_MS,
}) {
  const artifact = validateArtifactManifest(artifactManifest);
  const advertised = new URL(requiredString(metadata.dist.attestations.url, "attestation URL"));
  const registryUrl = new URL(registry);
  let advertisedPath;
  try {
    advertisedPath = decodeURIComponent(advertised.pathname);
  } catch (error) {
    throw new Error("Published package attestation URL path is invalid", { cause: error });
  }
  const expectedPath = `/-/npm/v1/attestations/${artifact.packageName}@${artifact.version}`;
  if (
    advertised.protocol !== "https:" ||
    advertised.origin !== registryUrl.origin ||
    advertised.username !== "" ||
    advertised.password !== "" ||
    advertised.search !== "" ||
    advertised.hash !== "" ||
    advertisedPath !== expectedPath
  ) {
    fail(`Published package attestation URL is not the exact npm registry path ${expectedPath}`);
  }
  const response = await fetchImpl(advertised.href, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status === 404) {
    throw new RegistryPropagationError("Published package provenance bundle is not visible yet");
  }
  if (!response.ok) {
    const error = new Error(`npm attestation request failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return validatePublishedProvenance(await response.json(), artifact);
}

export async function registryState({
  artifactManifest,
  registry,
  fetchImpl = fetch,
  requestTimeoutMs = HTTP_REQUEST_TIMEOUT_MS,
}) {
  const artifact = validateArtifactManifest(artifactManifest);
  const result = await fetchPublishedPackage({
    packageName: artifact.packageName,
    version: artifact.version,
    registry,
    fetchImpl,
    requestTimeoutMs,
  });
  if (result.status === "missing") return "missing";
  try {
    validatePublishedMetadata(result.metadata, artifact);
    await fetchPublishedProvenance({
      artifactManifest: artifact,
      metadata: result.metadata,
      registry,
      fetchImpl,
      requestTimeoutMs,
    });
  } catch (error) {
    if (error instanceof RegistryPropagationError) return "pending";
    throw error;
  }
  return "verified";
}

export async function verifyPublishedPackage({
  artifactManifest,
  attempts = 20,
  delayMs = 15_000,
  registry,
  fetchImpl = fetch,
  requestTimeoutMs = HTTP_REQUEST_TIMEOUT_MS,
}) {
  const artifact = validateArtifactManifest(artifactManifest);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fetchPublishedPackage({
        packageName: artifact.packageName,
        version: artifact.version,
        registry,
        fetchImpl,
        requestTimeoutMs,
      });
      if (result.status === "published") {
        validatePublishedMetadata(result.metadata, artifact);
        await fetchPublishedProvenance({
          artifactManifest: artifact,
          metadata: result.metadata,
          registry,
          fetchImpl,
          requestTimeoutMs,
        });
        return result.metadata;
      }
      lastError = new Error("Published package is not yet visible in the npm registry");
    } catch (error) {
      lastError = error;
      if (!transientRegistryError(error)) throw error;
    }
    if (attempt < attempts) await delay(delayMs);
  }
  throw lastError;
}

export async function stableDistTagState({
  artifactManifest,
  registry,
  fetchImpl = fetch,
  requestTimeoutMs = HTTP_REQUEST_TIMEOUT_MS,
}) {
  const artifact = validateArtifactManifest(artifactManifest);
  const metadata = await fetchPackageMetadata({
    packageName: artifact.packageName,
    registry,
    fetchImpl,
    requestTimeoutMs,
  });
  if (!metadata) return { state: "missing" };
  if (!plainObject(metadata) || !plainObject(metadata["dist-tags"])) {
    throw new RegistryPropagationError("npm package metadata has no dist-tags yet");
  }
  const latest = metadata["dist-tags"].latest;
  if (latest === artifact.version) return { latest, state: "current" };
  return { ...(typeof latest === "string" ? { latest } : {}), state: "stale" };
}

function stableVersionParts(version, label) {
  const match = requiredString(version, label).match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  if (!match) fail(`${label} must be an exact stable semantic version`);
  return match.slice(1).map((part) => BigInt(part));
}

function compareStableVersions(left, right) {
  const leftParts = stableVersionParts(left, "release version");
  const rightParts = stableVersionParts(right, "npm latest dist-tag");
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

export async function verifyStableReleaseOrder({
  artifactManifest,
  registry,
  fetchImpl = fetch,
  requestTimeoutMs = HTTP_REQUEST_TIMEOUT_MS,
}) {
  const artifact = validateArtifactManifest(artifactManifest);
  const metadata = await fetchPackageMetadata({
    packageName: artifact.packageName,
    registry,
    fetchImpl,
    requestTimeoutMs,
  });
  if (!metadata) return { state: "initial" };
  if (!plainObject(metadata) || !plainObject(metadata["dist-tags"])) {
    fail("npm package metadata has no trustworthy dist-tags for release ordering");
  }
  const latest = requiredString(metadata["dist-tags"].latest, "npm latest dist-tag");
  if (compareStableVersions(artifact.version, latest) < 0) {
    fail(
      `Refusing non-monotonic stable release ${artifact.version}: npm latest already points to ${latest}`,
    );
  }
  return { latest, state: latest === artifact.version ? "current" : "forward" };
}

export async function verifyStableDistTag({
  artifactManifest,
  attempts = 20,
  delayMs = 15_000,
  registry,
  fetchImpl = fetch,
  requestTimeoutMs = HTTP_REQUEST_TIMEOUT_MS,
}) {
  const artifact = validateArtifactManifest(artifactManifest);
  let lastState;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      lastState = await stableDistTagState({
        artifactManifest: artifact,
        registry,
        fetchImpl,
        requestTimeoutMs,
      });
      if (lastState.state === "current") return lastState;
      lastError = new Error(
        `npm latest dist-tag is ${lastState.latest ?? lastState.state}; expected ${artifact.version}. Graphcraft will not mutate dist-tags without separately authorized npm credentials.`,
      );
    } catch (error) {
      lastError = error;
      if (!transientRegistryError(error)) throw error;
    }
    if (attempt < attempts) await delay(delayMs);
  }
  throw lastError;
}

export function cleanSmokeEnvironment(root) {
  const environment = {};
  for (const [canonical, variants] of [
    ["PATHEXT", ["PATHEXT", "Pathext"]],
    ["SystemRoot", ["SystemRoot", "SYSTEMROOT"]],
    ["ComSpec", ["ComSpec", "COMSPEC"]],
    ["WINDIR", ["WINDIR", "windir"]],
  ]) {
    const value = variants.map((name) => process.env[name]).find(Boolean);
    if (value) environment[canonical] = value;
  }
  const home = join(root, "home");
  const pnpmHome = join(root, "pnpm-bin");
  const temporary = join(root, "tmp");
  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  return {
    ...environment,
    CI: "true",
    COREPACK_HOME: join(root, "corepack"),
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    NPM_CONFIG_CACHE: join(root, "npm-cache"),
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
    PATH: `${pnpmHome}${delimiter}${inheritedPath}`,
    PNPM_HOME: pnpmHome,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    npm_config_ignore_scripts: "true",
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: join(home, ".npmrc"),
  };
}

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

export function terminateSmokeProcessTree(
  crossSpawn,
  child,
  signal,
  environment,
  platform = process.platform,
) {
  if (platform !== "win32" || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    try {
      child.kill(signal);
    } catch {
      // The command may already have exited.
    }
    return;
  }

  const systemRoot = environment?.SystemRoot ?? environment?.SYSTEMROOT ?? process.env.SystemRoot;
  const taskkill =
    systemRoot && win32.isAbsolute(systemRoot)
      ? win32.join(systemRoot, "System32", "taskkill.exe")
      : "taskkill.exe";
  // A non-forced taskkill can let cmd.exe exit before its descendants, losing
  // the process-tree linkage needed by the later escalation attempt.
  const killer = crossSpawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
    env: environment,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  let fallbackAttempted = false;
  const fallback = () => {
    if (fallbackAttempted) return;
    fallbackAttempted = true;
    try {
      child.kill(signal);
    } catch {
      // The target may already have exited between the tree-kill request and fallback.
    }
  };
  killer.once("error", fallback);
  killer.once("close", (code) => {
    if (code !== 0) fallback();
  });
  killer.unref();
}

export async function runSmokeCommand(command, arguments_, options = {}) {
  const {
    timeoutMs = SMOKE_COMMAND_TIMEOUT_MS,
    maxOutputBytes = SMOKE_COMMAND_OUTPUT_BYTES,
    terminationGraceMs = SMOKE_TERMINATION_GRACE_MS,
    ...spawnOptions
  } = options;
  for (const [value, label] of [
    [timeoutMs, "timeout"],
    [maxOutputBytes, "output limit"],
    [terminationGraceMs, "termination grace"],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(`Clean package smoke command ${label} must be a positive safe integer`);
    }
  }
  const { default: crossSpawn } = await import("cross-spawn");
  const outcome = await new Promise((resolveOutcome) => {
    const child = crossSpawn(command, arguments_, {
      ...spawnOptions,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let settled = false;
    let terminationReason;
    let spawnError;
    let timeout;
    let escalation;
    let forcedCompletion;

    const complete = (exitCode) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (forcedCompletion) clearTimeout(forcedCompletion);
      try {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      } catch {
        // Cleanup must not hide the bounded command outcome.
      }
      resolveOutcome({
        exitCode,
        spawnError,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
        terminationReason,
      });
    };
    const terminate = (reason) => {
      if (terminationReason || settled) return;
      terminationReason = reason;
      terminateSmokeProcessTree(crossSpawn, child, "SIGTERM", spawnOptions.env);
      escalation = setTimeout(() => {
        terminateSmokeProcessTree(crossSpawn, child, "SIGKILL", spawnOptions.env);
        forcedCompletion = setTimeout(() => complete(-1), terminationGraceMs);
        forcedCompletion.unref();
      }, terminationGraceMs);
      escalation.unref();
    };
    const capture = (target, chunk) => {
      const value = Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - capturedBytes);
      if (remaining > 0) {
        const selected = value.subarray(0, remaining);
        target.push(selected);
        capturedBytes += selected.byteLength;
      }
      if (value.byteLength > remaining) {
        terminate(
          `combined stdout/stderr exceeded ${maxOutputBytes} bytes; captured output is truncated`,
        );
      }
    };

    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => {
      spawnError = error;
      complete(-1);
    });
    child.once("close", (code) => complete(terminationReason ? -1 : (code ?? 1)));
    timeout = setTimeout(() => terminate(`timed out after ${timeoutMs}ms`), timeoutMs);
    timeout.unref();
  });

  if (outcome.exitCode === 0 && !outcome.terminationReason && !outcome.spawnError) {
    return { stderr: outcome.stderr, stdout: outcome.stdout };
  }
  const detail = [
    outcome.stderr,
    outcome.stdout,
    outcome.terminationReason,
    outcome.spawnError?.message,
    outcome.exitCode !== 0 ? `exited with code ${outcome.exitCode}` : undefined,
  ]
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .join("\n")
    .trim()
    .slice(-8 * 1024);
  throw new Error(
    `Clean package smoke command failed: ${command} ${arguments_[0] ?? ""}${detail ? `\n${detail}` : ""}`,
    outcome.spawnError ? { cause: outcome.spawnError } : undefined,
  );
}

function pnpmInvocation(pnpmCommand, arguments_) {
  if (basename(pnpmCommand).replace(/\.cmd$/i, "") === "corepack") {
    return { arguments: ["pnpm", ...arguments_], command: pnpmCommand };
  }
  return { arguments: arguments_, command: pnpmCommand };
}

export function oneShotPackageInvocation({
  method,
  source,
  arguments_,
  cacheDirectory,
  pnpmCommand,
  localPackage,
}) {
  if (method === "npx") {
    return {
      command: executable("npx"),
      arguments: [
        "--yes",
        "--cache",
        cacheDirectory,
        ...(localPackage ? ["--package", source, "graphcraft"] : [source]),
        ...arguments_,
      ],
    };
  }
  if (method !== "pnpm-dlx") fail(`Unsupported one-shot smoke method: ${method}`);
  return pnpmInvocation(pnpmCommand ?? executable("pnpm"), [
    "dlx",
    ...(localPackage ? ["--package", source, "graphcraft"] : [source]),
    ...arguments_,
  ]);
}

const SMOKE_HOSTS = ["codex", "claude"];

function smokeHostProgram(host) {
  return `#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const host = ${JSON.stringify(host)};
const args = process.argv.slice(2);
const stateDirectory = process.env.GRAPHCRAFT_SMOKE_HOST_STATE_DIR;
if (!stateDirectory) throw new Error("GRAPHCRAFT_SMOKE_HOST_STATE_DIR is required");

function finish(code, stdout = "", stderr = "") {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
const exact = (expected) =>
  args.length === expected.length && expected.every((value, index) => args[index] === value);

if (host === "gh") {
  if (exact(["--version"])) finish(0, "gh version 2.86.0\\n");
  else if (exact(["auth", "status"])) finish(1, "", "not logged in\\n");
  else finish(2, "", "unexpected gh smoke command\\n");
} else {
  const statePath = join(stateDirectory, host + ".json");
  let state = { registration: null, successfulAdds: 0, successfulRemoves: 0 };
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
  const save = () => {
    mkdirSync(dirname(statePath), { recursive: true });
    const temporary = statePath + "." + process.pid + ".tmp";
    writeFileSync(temporary, JSON.stringify(state) + "\\n", { mode: 0o600 });
    renameSync(temporary, statePath);
  };
  if (exact(["--version"])) {
    finish(0, host === "codex" ? "codex-cli 0.144.6\\n" : "2.1.212 (Claude Code)\\n");
  } else if (host === "codex" && exact(["login", "status"])) {
    finish(0, "Logged in\\n");
  } else if (host === "claude" && exact(["auth", "status", "--json"])) {
    finish(0, JSON.stringify({ loggedIn: true }) + "\\n");
  } else if ((host === "codex" && exact(["mcp", "get", "graphcraft", "--json"])) ||
             (host === "claude" && exact(["mcp", "get", "graphcraft"]))) {
    if (!state.registration) {
      finish(1, "", "No MCP server named 'graphcraft' found.\\n");
    } else if (host === "codex") {
      finish(0, JSON.stringify({
        name: "graphcraft",
        transport: {
          type: "stdio",
          command: state.registration.command,
          args: state.registration.args,
          env: null,
          env_vars: [],
          cwd: null,
        },
      }) + "\\n");
    } else {
      finish(0, [
        "graphcraft:",
        "  Scope: User config (available in all your projects)",
        "  Status: ✓ Connected",
        "  Type: stdio",
        "  Command: " + state.registration.command,
        "  Args: " + state.registration.args.join(" "),
        "  Environment:",
      ].join("\\n") + "\\n");
    }
  } else if ((host === "codex" && exact(["mcp", "remove", "graphcraft"])) ||
             (host === "claude" && exact(["mcp", "remove", "--scope", "user", "graphcraft"]))) {
    if (!state.registration) {
      finish(1, "", host === "codex"
        ? "Error: No MCP server named 'graphcraft' found.\\n"
        : "No MCP server named \\\"graphcraft\\\" in user scope\\n");
    } else {
      state.registration = null;
      state.successfulRemoves += 1;
      save();
      finish(0, "removed\\n");
    }
  } else if (args[0] === "mcp" && args[1] === "add") {
    const separator = host === "codex" ? 3 : 5;
    const valid = host === "codex"
      ? args.length === 6 && args[2] === "graphcraft" && args[3] === "--" && args[4] === "node" && Boolean(args[5])
      : args.length === 8 && args[2] === "--scope" && args[3] === "user" && args[4] === "graphcraft" && args[5] === "--" && args[6] === "node" && Boolean(args[7]);
    if (!valid) {
      finish(2, "", "invalid MCP add command\\n");
    } else {
      state.registration = {
        command: args[separator + 1],
        args: args.slice(separator + 2),
      };
      state.successfulAdds += 1;
      save();
      finish(0, "added\\n");
    }
  } else {
    finish(2, "", "unexpected " + host + " smoke command: " + args.join(" ") + "\\n");
  }
}
`;
}

export async function installSmokeHostShims(environment, platform = process.platform) {
  const binDirectory = environment.PNPM_HOME;
  const stateDirectory = join(dirname(binDirectory), "host-state");
  await Promise.all([
    mkdir(binDirectory, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
  ]);
  environment.GRAPHCRAFT_SMOKE_HOST_STATE_DIR = stateDirectory;
  environment.GRAPHCRAFT_SMOKE_NODE = process.execPath;

  for (const host of [...SMOKE_HOSTS, "gh"]) {
    const program = smokeHostProgram(host);
    const programPath = join(binDirectory, `${host}.mjs`);
    await writeFile(programPath, program, { mode: 0o700 });
    if (platform === "win32") {
      await writeFile(
        join(binDirectory, `${host}.cmd`),
        `@echo off\r\n"%GRAPHCRAFT_SMOKE_NODE%" "%~dp0${host}.mjs" %*\r\n`,
        { mode: 0o700 },
      );
    } else {
      const executablePath = join(binDirectory, host);
      await writeFile(executablePath, program, { mode: 0o700 });
      await chmod(executablePath, 0o700);
    }
  }
  return stateDirectory;
}

async function readSmokeHostState(stateDirectory, host) {
  return await readJson(join(stateDirectory, `${host}.json`), `${host} smoke host state`);
}

async function verifySmokeInstallation({ environment, host, stateDirectory, version }) {
  const runtimePath = join(environment.GRAPHCRAFT_HOME, "runtime", version, "mcp.mjs");
  if (!isAbsolute(runtimePath)) fail("The clean smoke runtime path must be absolute");
  const runtime = await readFile(runtimePath);
  const runtimeSha256 = createHash("sha256").update(runtime).digest("hex");
  const manifest = await readJson(
    join(environment.GRAPHCRAFT_HOME, "runtime", version, "runtime.json"),
    "staged runtime manifest",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.graphcraftVersion !== version ||
    manifest.runtimeFile !== "mcp.mjs" ||
    manifest.sha256 !== runtimeSha256 ||
    manifest.bytes !== runtime.byteLength
  ) {
    fail(`Clean smoke found an invalid staged runtime manifest for ${host}`);
  }
  const receipt = await readJson(
    join(environment.GRAPHCRAFT_HOME, "registrations", `${host}.json`),
    `${host} registration receipt`,
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.host !== host ||
    receipt.graphcraftVersion !== version ||
    receipt.runtimePath !== runtimePath ||
    receipt.runtimeSha256 !== runtimeSha256
  ) {
    fail(`Clean smoke found an invalid ${host} registration receipt`);
  }
  const state = await readSmokeHostState(stateDirectory, host);
  if (
    !plainObject(state.registration) ||
    state.registration.command !== "node" ||
    !Array.isArray(state.registration.args) ||
    state.registration.args.length !== 1 ||
    state.registration.args[0] !== runtimePath
  ) {
    fail(`Clean smoke found an unexpected ${host} MCP registration`);
  }
  return { runtimePath, runtimeSha256, state };
}

function parseSmokeJson(stdout, label) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) fail(`${label} did not return a JSON object`);
  let value;
  try {
    value = JSON.parse(stdout.slice(start, end + 1));
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
  if (!plainObject(value)) fail(`${label} must return a JSON object`);
  return value;
}

async function exercisePackageLifecycle({ environment, invoke, stateDirectory, version }) {
  const installed = {};
  for (const host of SMOKE_HOSTS) {
    await invoke(["install", "--host", host]);
    installed[host] = await verifySmokeInstallation({
      environment,
      host,
      stateDirectory,
      version,
    });
    await invoke(["install", "--host", host]);
    await invoke(["update", "--host", host]);
    const unchanged = await verifySmokeInstallation({
      environment,
      host,
      stateDirectory,
      version,
    });
    if (
      unchanged.runtimeSha256 !== installed[host].runtimeSha256 ||
      unchanged.state.successfulAdds !== 1 ||
      unchanged.state.successfulRemoves !== 0
    ) {
      fail(`Clean smoke ${host} install/update was not idempotent`);
    }
  }

  const doctor = parseSmokeJson((await invoke(["doctor"])).stdout, "graphcraft doctor");
  if (
    doctor.graphcraft?.version !== version ||
    doctor.graphcraft?.installation?.runtime?.status !== "current"
  ) {
    fail("Clean smoke doctor did not verify the staged Graphcraft runtime");
  }
  for (const host of SMOKE_HOSTS) {
    if (
      doctor.graphcraft?.installation?.registrations?.[host]?.status !== "current" ||
      doctor.graphcraft?.installation?.registrations?.[host]?.receipt !== "current" ||
      doctor.graphcraft?.compatibility?.[host]?.status !== "compatible" ||
      doctor.graphcraft?.compatibility?.[host]?.authenticated !== true
    ) {
      fail(`Clean smoke doctor did not verify ${host} compatibility and registration`);
    }
  }

  for (const host of SMOKE_HOSTS) {
    await invoke(["uninstall", "--host", host]);
    await invoke(["uninstall", "--host", host]);
    const state = await readSmokeHostState(stateDirectory, host);
    if (
      state.registration !== null ||
      state.successfulAdds !== 1 ||
      state.successfulRemoves !== 1
    ) {
      fail(`Clean smoke ${host} uninstall was not idempotent`);
    }
    try {
      await stat(join(environment.GRAPHCRAFT_HOME, "registrations", `${host}.json`));
      fail(`Clean smoke ${host} uninstall left a registration receipt`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const retainedRuntime = await readFile(installed[host].runtimePath);
    if (
      createHash("sha256").update(retainedRuntime).digest("hex") !== installed[host].runtimeSha256
    ) {
      fail(`Clean smoke ${host} uninstall changed the versioned runtime`);
    }
  }
}

export async function smokePackage({ source, method, version, pnpmCommand }) {
  if (!RELEASE_METHODS.has(method)) fail(`Unsupported package smoke method: ${method}`);
  parseReleaseTag(`v${version}`);
  const smokeRoot = await mkdtemp(join(tmpdir(), "graphcraft-release-smoke-"));
  const originalSource = source;
  let localPackage = false;
  try {
    const candidate = isAbsolute(source) ? source : resolve(process.cwd(), source);
    try {
      const sourceStat = await stat(candidate);
      if (sourceStat.isFile()) {
        source = candidate;
        localPackage = true;
      }
    } catch {
      source = originalSource;
    }

    const cleanRoot = join(
      smokeRoot,
      "clean package home Ω",
      ...Array.from({ length: 3 }, (_, index) => `long path ${index} ${"x".repeat(24)}`),
    );
    const environment = cleanSmokeEnvironment(cleanRoot);
    environment.GRAPHCRAFT_HOME = join(environment.HOME, "Graphcraft state 工具");
    await Promise.all([
      mkdir(environment.HOME, { recursive: true }),
      mkdir(environment.TMPDIR, { recursive: true }),
    ]);
    const stateDirectory = await installSmokeHostShims(environment);
    await writeFile(environment.NPM_CONFIG_USERCONFIG, "registry=https://registry.npmjs.org/\n", {
      mode: 0o600,
    });
    const cwd = environment.HOME;
    let invoke;

    if (method === "npm") {
      const prefix = join(smokeRoot, "npm-global");
      await runSmokeCommand(
        executable("npm"),
        ["install", "--global", "--ignore-scripts", "--prefix", prefix, source],
        { cwd, env: environment },
      );
      const binary =
        process.platform === "win32"
          ? join(prefix, "graphcraft.cmd")
          : join(prefix, "bin", "graphcraft");
      invoke = async (arguments_) =>
        await runSmokeCommand(binary, arguments_, { cwd, env: environment });
    } else if (method === "pnpm") {
      const globalBin = environment.PNPM_HOME;
      const invocation = pnpmInvocation(pnpmCommand ?? executable("pnpm"), [
        "add",
        "--global",
        "--ignore-scripts",
        "--global-dir",
        join(smokeRoot, "pnpm-global"),
        "--global-bin-dir",
        globalBin,
        "--store-dir",
        join(smokeRoot, "pnpm-store"),
        source,
      ]);
      await runSmokeCommand(invocation.command, invocation.arguments, { cwd, env: environment });
      const binary = join(
        globalBin,
        process.platform === "win32" ? "graphcraft.CMD" : "graphcraft",
      );
      invoke = async (arguments_) =>
        await runSmokeCommand(binary, arguments_, { cwd, env: environment });
    } else if (method === "npx") {
      invoke = async (arguments_) => {
        const invocation = oneShotPackageInvocation({
          method,
          source,
          arguments_,
          cacheDirectory: join(smokeRoot, "npx-cache"),
          localPackage,
        });
        return await runSmokeCommand(invocation.command, invocation.arguments, {
          cwd,
          env: environment,
        });
      };
    } else {
      invoke = async (arguments_) => {
        const invocation = oneShotPackageInvocation({
          method,
          source,
          arguments_,
          cacheDirectory: join(smokeRoot, "unused-pnpm-cache"),
          localPackage,
          pnpmCommand,
        });
        return await runSmokeCommand(invocation.command, invocation.arguments, {
          cwd,
          env: environment,
        });
      };
    }

    const versionResult = await invoke(["--version"]);
    const lines = versionResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.at(-1) !== version) {
      fail(`Clean ${method} smoke returned ${lines.at(-1) ?? "no version"}; expected ${version}`);
    }
    await exercisePackageLifecycle({ environment, invoke, stateDirectory, version });
    return { lifecycleHosts: [...SMOKE_HOSTS], method, version };
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command) fail("A release verification command is required");
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument?.startsWith("--")) fail(`Unexpected release verification argument: ${argument}`);
    const name = argument.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

async function main(argv) {
  const { command, options } = parseArguments(argv);
  const root = resolve(options.root ?? process.cwd());

  if (command === "preflight") {
    const tag = requiredString(options.tag, "--tag");
    const metadata = await validateReleaseMetadata({ root, tag });
    const checkout = await verifyReleaseIdentity({
      root,
      tag,
      ...(options["require-ref"] ? { requireRef: options["require-ref"] } : {}),
      ...(options["tag-oid"] ? { tagOid: options["tag-oid"] } : {}),
      ...(options.commit ? { commit: options.commit } : {}),
      ...(options["event-sha"] ? { eventSha: options["event-sha"] } : {}),
      ...(options["github-repository"]
        ? {
            repository: options["github-repository"],
            token: requiredString(process.env.GITHUB_TOKEN, "GITHUB_TOKEN"),
            ...(options["github-api-url"] ? { apiUrl: options["github-api-url"] } : {}),
          }
        : {}),
    });
    console.log(
      `Release preflight passed: ${metadata.packageName}@${metadata.version} (${checkout.commit})`,
    );
    return;
  }

  if (command === "verify-identity") {
    const tag = requiredString(options.tag, "--tag");
    const checkout = await verifyReleaseIdentity({
      root,
      tag,
      tagOid: requiredString(options["tag-oid"], "--tag-oid"),
      commit: requiredString(options.commit, "--commit"),
      ...(options["event-sha"] ? { eventSha: options["event-sha"] } : {}),
      ...(options["require-ref"] ? { requireRef: options["require-ref"] } : {}),
      ...(options["github-repository"]
        ? {
            repository: options["github-repository"],
            token: requiredString(process.env.GITHUB_TOKEN, "GITHUB_TOKEN"),
            ...(options["github-api-url"] ? { apiUrl: options["github-api-url"] } : {}),
          }
        : {}),
    });
    console.log(
      `Verified immutable release identity: ${tag} (${checkout.tagOid} -> ${checkout.commit})`,
    );
    return;
  }

  if (command === "artifact") {
    const manifest = await createArtifactManifest({
      root,
      tag: requiredString(options.tag, "--tag"),
      ...(options["tag-oid"] ? { tagOid: options["tag-oid"] } : {}),
      ...(options.commit ? { commit: options.commit } : {}),
      tarball: requiredString(options.tarball, "--tarball"),
    });
    const output = resolve(root, requiredString(options.output, "--output"));
    await writeJsonAtomic(output, manifest);
    console.log(`Verified release artifact: ${manifest.tarball} (${manifest.digests.sha256})`);
    return;
  }

  if (command === "compare") {
    const digests = await compareArtifacts(
      requiredString(options.left, "--left"),
      requiredString(options.right, "--right"),
    );
    console.log(`Reproducible package SHA-256: ${digests.sha256}`);
    return;
  }

  if (command === "verify-artifact") {
    const manifestPath = resolve(root, requiredString(options.manifest, "--manifest"));
    const artifact = await readJson(manifestPath, "release artifact manifest");
    const tarball = await verifyArtifactFile({
      artifactManifest: artifact,
      directory: options.directory ? resolve(root, options.directory) : dirname(manifestPath),
    });
    process.stdout.write(`${tarball}\n`);
    return;
  }

  if (
    command === "registry-state" ||
    command === "verify-published" ||
    command === "dist-tag-state" ||
    command === "verify-dist-tag" ||
    command === "verify-release-order"
  ) {
    const artifact = validateArtifactManifest(
      await readJson(requiredString(options.manifest, "--manifest"), "release artifact manifest"),
    );
    if (command === "registry-state") {
      console.log(
        await registryState({
          artifactManifest: artifact,
          ...(options.registry ? { registry: options.registry } : {}),
        }),
      );
      return;
    }
    if (command === "dist-tag-state") {
      const state = await stableDistTagState({
        artifactManifest: artifact,
        ...(options.registry ? { registry: options.registry } : {}),
      });
      console.log(state.state);
      return;
    }
    if (command === "verify-dist-tag") {
      await verifyStableDistTag({
        artifactManifest: artifact,
        attempts: options.attempts ? positiveInteger(options.attempts, "--attempts") : 20,
        delayMs: options["delay-ms"] ? positiveInteger(options["delay-ms"], "--delay-ms") : 15_000,
        ...(options.registry ? { registry: options.registry } : {}),
      });
      console.log(`Verified npm latest dist-tag: ${artifact.packageName}@${artifact.version}`);
      return;
    }
    if (command === "verify-release-order") {
      const state = await verifyStableReleaseOrder({
        artifactManifest: artifact,
        ...(options.registry ? { registry: options.registry } : {}),
      });
      console.log(
        state.state === "initial"
          ? `Verified initial stable release order: ${artifact.packageName}@${artifact.version}`
          : `Verified monotonic stable release order: ${state.latest} -> ${artifact.version}`,
      );
      return;
    }
    await verifyPublishedPackage({
      artifactManifest: artifact,
      attempts: options.attempts ? positiveInteger(options.attempts, "--attempts") : 20,
      delayMs: options["delay-ms"] ? positiveInteger(options["delay-ms"], "--delay-ms") : 15_000,
      ...(options.registry ? { registry: options.registry } : {}),
    });
    console.log(
      `Verified published package integrity, provenance, and registry signature: ${artifact.packageName}@${artifact.version}`,
    );
    return;
  }

  if (command === "smoke") {
    const result = await smokePackage({
      source: requiredString(options.source, "--source"),
      method: requiredString(options.method, "--method"),
      version: requiredString(options.version, "--version"),
      ...(options["pnpm-command"] ? { pnpmCommand: options["pnpm-command"] } : {}),
    });
    console.log(`Clean ${result.method} package smoke passed for ${result.version}`);
    return;
  }

  fail(`Unknown release verification command: ${command}`);
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
