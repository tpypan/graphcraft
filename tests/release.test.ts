import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installHost, uninstallHost, updateHost } from "../packages/cli/src/index.ts";

import {
  artifactDigests,
  cleanSmokeEnvironment,
  compareArtifacts,
  installSmokeHostShims,
  oneShotPackageInvocation,
  parseReleaseTag,
  registryState,
  stableDistTagState,
  terminateSmokeProcessTree,
  validateGitHubTagRefPayload,
  validateGitHubTagPayload,
  validatePublishedMetadata,
  validatePublishedProvenance,
  validateReleaseMetadata,
  validateReleaseNotes,
  validateTagCheckout,
  verifyArtifactFile,
  verifyPublishedPackage,
  verifyStableDistTag,
  verifyStableReleaseOrder,
} from "../scripts/verify-release.mjs";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];
const signedTagBindingTestTimeout =
  process.platform === "win32" ? 60_000 : process.platform === "darwin" ? 300_000 : 15_000;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function artifactManifest() {
  const bytes = Buffer.from("graphcraft release artifact");
  const digests = artifactDigests(bytes);
  return {
    schemaVersion: 1 as const,
    packageName: "@tpypan/graphcraft",
    version: "0.1.2",
    tag: "v0.1.2",
    tagOid: "a".repeat(40),
    commit: "b".repeat(40),
    releaseNotes: "docs/releases/v0.1.2.md",
    tarball: "tpypan-graphcraft-0.1.2.tgz",
    size: bytes.length,
    integrity: `sha512-${digests.sha512}`,
    digests,
  };
}

function publishedMetadata(manifest = artifactManifest()) {
  return {
    name: manifest.packageName,
    version: manifest.version,
    dist: {
      integrity: manifest.integrity,
      shasum: manifest.digests.sha1,
      tarball: "https://registry.npmjs.org/@tpypan/graphcraft/-/graphcraft-0.1.2.tgz",
      signatures: [{ keyid: "SHA256:registry-key", sig: "registry-signature" }],
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/@tpypan/graphcraft@0.1.2",
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
  };
}

function provenanceAttestations(
  manifest = artifactManifest(),
  overrides: {
    commit?: string;
    duplicateSubject?: boolean;
    event?: string;
    payloadType?: string;
    ref?: string;
    repository?: string;
    subjectName?: string;
    subjectSha512?: string;
    workflow?: string;
  } = {},
) {
  const ref = overrides.ref ?? `refs/tags/${manifest.tag}`;
  const subjectName = `pkg:npm/${manifest.packageName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}@${manifest.version}`;
  const subject = {
    name: overrides.subjectName ?? subjectName,
    digest: {
      sha512:
        overrides.subjectSha512 ?? Buffer.from(manifest.digests.sha512, "base64").toString("hex"),
    },
  };
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [subject, ...(overrides.duplicateSubject ? [subject] : [])],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref,
            repository: overrides.repository ?? "https://github.com/tpypan/graphcraft",
            path: overrides.workflow ?? ".github/workflows/release.yml",
          },
        },
        internalParameters: { github: { event_name: overrides.event ?? "push" } },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/tpypan/graphcraft@${ref}`,
            digest: { gitCommit: overrides.commit ?? manifest.commit },
          },
        ],
      },
    },
  };
  return {
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payloadType: overrides.payloadType ?? "application/vnd.in-toto+json",
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
            signatures: [{ sig: "provenance-signature" }],
          },
        },
      },
    ],
  };
}

function publishedFetch(
  manifest = artifactManifest(),
  metadata = publishedMetadata(manifest),
  provenance = provenanceAttestations(manifest),
) {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) =>
    String(input).includes("/-/npm/v1/attestations/")
      ? Response.json(provenance)
      : Response.json(metadata),
  ) as unknown as typeof fetch;
}

describe("release metadata", () => {
  it("accepts exact stable semantic tags and rejects ambiguous release channels", () => {
    expect(parseReleaseTag("v0.1.2")).toBe("0.1.2");
    expect(() => parseReleaseTag("v1.0.0-beta.2")).toThrow(/prerelease tags are not supported/i);
    expect(() => parseReleaseTag("v1.0.0-01")).toThrow(/exact v-prefixed semantic version/i);
    expect(() => parseReleaseTag("v1.0.0+build.1")).toThrow(/build metadata is not supported/i);
    expect(() => parseReleaseTag("0.1.2")).toThrow(/v-prefixed/);
    expect(() => parseReleaseTag("v01.2.3")).toThrow(/semantic version/);
  });

  it("requires persisted release and migration notes", () => {
    const notes = `# Graphcraft v0.1.2

## Release notes

- Adds trusted release verification.

## Persisted-format migration

- Existing 0.1 runs migrate forward before current runtime access.
`;
    expect(validateReleaseNotes(notes, "v0.1.2")).toBe(true);
    expect(() =>
      validateReleaseNotes(
        "# Graphcraft v0.1.2\n\n## Release notes\n\n- Complete release notes.\n",
        "v0.1.2",
      ),
    ).toThrow(/Persisted-format migration/);
  });

  it("keeps the registry-independent install on an exact release asset", async () => {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    expect(readme).not.toContain("archive/refs/heads/");
    expect(readme).toContain(
      "https://github.com/tpypan/graphcraft/releases/download/v${GRAPHCRAFT_VERSION}/tpypan-graphcraft-${GRAPHCRAFT_VERSION}.tgz",
    );
    expect(readme).toContain(`GRAPHCRAFT_VERSION=${artifactManifest().version}`);
  });

  it("keeps Codex and Claude MCP launch configuration host-specific", async () => {
    const codexManifest = JSON.parse(
      await readFile(join(process.cwd(), ".codex-plugin", "plugin.json"), "utf8"),
    );
    const claudeMcp = JSON.parse(await readFile(join(process.cwd(), ".mcp.json"), "utf8"));

    expect(codexManifest.mcpServers).toEqual({
      graphcraft: { command: "node", args: ["dist/mcp.mjs"], cwd: "." },
    });
    expect(claudeMcp.mcpServers.graphcraft).toEqual({
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/dist/mcp.mjs"],
    });
  });

  it("binds the tag to the public and host manifest versions", async () => {
    const root = await temporaryDirectory("graphcraft-release-metadata-");
    await writeJson(join(root, "package.json"), {
      name: "@tpypan/graphcraft",
      version: "0.1.2",
      publishConfig: { access: "public" },
    });
    await writeJson(join(root, ".codex-plugin", "plugin.json"), {
      name: "graphcraft",
      version: "0.1.2",
    });
    await writeJson(join(root, ".claude-plugin", "plugin.json"), {
      name: "graphcraft",
      version: "0.1.2",
    });
    await mkdir(join(root, "docs", "releases"), { recursive: true });
    await writeFile(
      join(root, "docs", "releases", "v0.1.2.md"),
      "# Graphcraft v0.1.2\n\n## Release notes\n\n- Complete notes.\n\n## Persisted-format migration\n\n- No manual action is required.\n",
    );

    await expect(validateReleaseMetadata({ root, tag: "v0.1.2" })).resolves.toMatchObject({
      packageName: "@tpypan/graphcraft",
      version: "0.1.2",
    });

    const claudeManifestPath = join(root, ".claude-plugin", "plugin.json");
    const claudeManifest = JSON.parse(await readFile(claudeManifestPath, "utf8"));
    claudeManifest.version = "0.1.1";
    await writeJson(claudeManifestPath, claudeManifest);
    await expect(validateReleaseMetadata({ root, tag: "v0.1.2" })).rejects.toThrow(
      /.claude-plugin\/plugin.json \(0.1.1\)/,
    );
  });

  it("pins workflow actions and makes release security checks publication prerequisites", async () => {
    const workflowDirectory = join(process.cwd(), ".github", "workflows");
    const workflowFiles = (await readdir(workflowDirectory)).filter((path) =>
      /\.ya?ml$/u.test(path),
    );
    expect(workflowFiles.length).toBeGreaterThan(0);
    for (const path of workflowFiles) {
      const source = await readFile(join(workflowDirectory, path), "utf8");
      const actionReferences = [...source.matchAll(/\buses:\s+[^\s@]+@([^\s#]+)/gu)].map(
        (match) => match[1],
      );
      expect(actionReferences.length, `${path} has no actions to verify`).toBeGreaterThan(0);
      for (const reference of actionReferences) {
        expect(reference, `${path} contains a mutable action reference`).toMatch(/^[a-f0-9]{40}$/u);
      }
    }

    const ci = await readFile(join(workflowDirectory, "ci.yml"), "utf8");
    const platformCheckTimeout =
      "timeout-minutes: ${{ matrix.os == 'windows-latest' && 180 || 45 }}";
    expect(ci).toContain(platformCheckTimeout);
    expect(ci.match(/\n    timeout-minutes: 10\n/gu)).toHaveLength(2);

    const release = await readFile(join(workflowDirectory, "release.yml"), "utf8");
    expect(release).toContain(platformCheckTimeout);
    expect(release).toContain("group: graphcraft-stable-release");
    expect(release).not.toContain("group: release-${{ github.ref }}");
    expect(release).toContain("needs: [preflight, ci, dependency-audit, secret-scan]");
    expect(release).toContain("needs: [preflight, dependency-audit, secret-scan, tarball-smoke]");
    expect(release).toMatch(/\n  dependency-audit:\n/u);
    expect(release).toMatch(/\n  secret-scan:\n/u);
    expect(release.match(/os: \[ubuntu-latest, macos-latest, windows-latest\]/gu)).toHaveLength(3);
    expect(release.match(/method: \[npm, pnpm, npx, pnpm-dlx\]/gu)).toHaveLength(2);
    expect(release.match(/verify-release\.mjs verify-artifact/gu)).toHaveLength(5);
    expect(release).not.toMatch(/find .*\*\.tgz.*-print -quit/gu);
    expect(release).not.toContain("/release/*.tgz");
    expect(release).not.toContain("npm dist-tag add");
    expect(release).toContain("verify-release.mjs verify-dist-tag");
    expect(release).toContain("verify-release.mjs verify-release-order");
    expect(release).toContain("ref: ${{ github.sha }}");
    expect(release).not.toContain("ref: ${{ github.ref }}");
    expect(release.match(/ref: \$\{\{ needs\.preflight\.outputs\.commit \}\}/gu)).toHaveLength(8);
    expect(release.match(/verify-release\.mjs verify-identity/gu)).toHaveLength(4);
    expect(release).toContain('--tag-oid "${{ needs.preflight.outputs.tag_oid }}"');
    expect(release.match(/\s--latest(?:\s|\\)/gu)).toHaveLength(1);
    expect(release).toContain('gh api "repos/$GITHUB_REPOSITORY/releases/latest"');
    expect(release).toContain("release.draft || release.prerelease");
    expect(release).not.toContain("gh release edit");
    expect(release).not.toContain("gh release upload");
    expect(release).not.toContain("--method DELETE");
    expect(release).not.toContain("--target");
    expect(release).toContain("GitHub release tarball differs");
    expect(release.match(/release\.immutable !== true/gu)).toHaveLength(2);

    const releasePolicy = await readFile(
      join(process.cwd(), "docs", "releases", "README.md"),
      "utf8",
    );
    expect(releasePolicy).toContain("repos/tpypan/graphcraft/immutable-releases");
    expect(releasePolicy).toContain("admin-only repository setting");
  });

  it("qualifies one exact-SHA package candidate across every supported install path", async () => {
    const qualification = await readFile(
      join(process.cwd(), ".github", "workflows", "install-qualification.yml"),
      "utf8",
    );

    expect(qualification).toContain("workflow_dispatch:");
    expect(qualification).toContain("branches: [main]");
    expect(qualification).toContain("permissions:\n  contents: read");
    expect(qualification).toContain(
      "name: graphcraft-install-${{ github.sha }}-${{ github.run_attempt }}",
    );
    expect(qualification).toContain(
      "artifact_id: ${{ steps.candidate_artifact.outputs.artifact-id }}",
    );
    expect(qualification).toContain("artifact-ids: ${{ needs.package.outputs.artifact_id }}");
    expect(qualification.match(/name: graphcraft-install-\$\{\{ github\.sha \}\}/gu)).toHaveLength(
      1,
    );
    expect(qualification.match(/ref: \$\{\{ github\.sha \}\}/gu)).toHaveLength(2);
    expect(qualification).toContain("os: [ubuntu-latest, macos-latest, windows-latest]");
    expect(qualification).toContain("method: [npm, pnpm, npx, pnpm-dlx]");
    expect(qualification).toContain("scripts/verify-release.mjs smoke");
    expect(qualification).toContain("SHA256SUMS");
    expect(qualification).not.toContain("npm publish");
    expect(qualification).not.toContain("gh release");
    expect(qualification).not.toContain("id-token: write");
    expect(qualification).not.toContain("contents: write");
  });
});

describe("signed annotated tag binding", () => {
  it(
    "rejects lightweight and dirty tags while accepting a clean annotated tag",
    async () => {
      const root = await temporaryDirectory("graphcraft-release-git-");
      await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
      await execFileAsync("git", ["config", "user.name", "Graphcraft Test"], { cwd: root });
      await execFileAsync("git", ["config", "user.email", "graphcraft@example.invalid"], {
        cwd: root,
      });
      await writeFile(join(root, "fixture.txt"), "release\n");
      await execFileAsync("git", ["add", "fixture.txt"], { cwd: root });
      await execFileAsync("git", ["-c", "commit.gpgSign=false", "commit", "-m", "fixture"], {
        cwd: root,
      });
      await execFileAsync("git", ["tag", "v0.1.2"], { cwd: root });
      await expect(validateTagCheckout({ root, tag: "v0.1.2" })).rejects.toThrow(/annotated tag/);

      await execFileAsync("git", ["tag", "--delete", "v0.1.2"], { cwd: root });
      await execFileAsync(
        "git",
        ["-c", "tag.gpgSign=false", "tag", "--annotate", "v0.1.2", "--message", "release"],
        { cwd: root },
      );
      await expect(
        validateTagCheckout({ root, tag: "v0.1.2", requireRef: "main" }),
      ).resolves.toEqual({
        commit: expect.stringMatching(/^[a-f0-9]{40,64}$/),
        tagOid: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      });

      await writeFile(join(root, "untracked.txt"), "not part of release\n");
      await expect(validateTagCheckout({ root, tag: "v0.1.2" })).rejects.toThrow(/must be clean/);
    },
    signedTagBindingTestTimeout,
  );

  it("requires GitHub's verified signature to bind the same tag object and commit", () => {
    const expected = {
      tag: "v0.1.2",
      tagOid: "a".repeat(40),
      commit: "b".repeat(40),
    };
    const payload = {
      sha: expected.tagOid,
      tag: expected.tag,
      object: { type: "commit", sha: expected.commit },
      verification: { verified: true, reason: "valid", signature: "signed-tag" },
    };
    expect(validateGitHubTagPayload(payload, expected)).toBe(true);
    expect(
      validateGitHubTagRefPayload(
        {
          ref: `refs/tags/${expected.tag}`,
          object: { type: "tag", sha: expected.tagOid },
        },
        expected,
      ),
    ).toBe(true);
    expect(() =>
      validateGitHubTagPayload(
        { ...payload, verification: { verified: false, reason: "unknown_key" } },
        expected,
      ),
    ).toThrow(/did not verify/);
    expect(() =>
      validateGitHubTagPayload(
        { ...payload, object: { type: "commit", sha: "c".repeat(40) } },
        expected,
      ),
    ).toThrow(/not bound/);
    expect(() =>
      validateGitHubTagRefPayload(
        {
          ref: `refs/tags/${expected.tag}`,
          object: { type: "tag", sha: "c".repeat(40) },
        },
        expected,
      ),
    ).toThrow(/no longer points/);
  });
});

describe("release artifact and registry verification", () => {
  it("uses advertised direct package specs for published one-shot commands", () => {
    const source = "@tpypan/graphcraft@0.1.2";
    const npx = oneShotPackageInvocation({
      method: "npx",
      source,
      arguments_: ["doctor"],
      cacheDirectory: "/isolated/npx-cache",
      localPackage: false,
    });
    expect(npx.arguments).toEqual(["--yes", "--cache", "/isolated/npx-cache", source, "doctor"]);
    const pnpm = oneShotPackageInvocation({
      method: "pnpm-dlx",
      source,
      arguments_: ["doctor"],
      cacheDirectory: "/unused",
      localPackage: false,
      pnpmCommand: "pnpm-fixture",
    });
    expect(pnpm).toEqual({
      command: "pnpm-fixture",
      arguments: ["dlx", source, "doctor"],
    });

    const local = oneShotPackageInvocation({
      method: "npx",
      source: "/tmp/package.tgz",
      arguments_: ["doctor"],
      cacheDirectory: "/isolated/npx-cache",
      localPackage: true,
    });
    expect(local.arguments).toContain("--package");
    expect(local.arguments).toContain("graphcraft");
  });

  it("does not expose ambient CI credentials to package smoke processes", () => {
    vi.stubEnv("GRAPHCRAFT_SENTINEL_TOKEN", "must-not-leak");
    vi.stubEnv("GITHUB_TOKEN", "must-not-leak-either");
    const environment = cleanSmokeEnvironment("/isolated/release-smoke");
    expect(environment.GRAPHCRAFT_SENTINEL_TOKEN).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.HOME).toBe(join("/isolated/release-smoke", "home"));
    expect(environment.NPM_CONFIG_USERCONFIG).toBe(
      join("/isolated/release-smoke", "home", ".npmrc"),
    );
  });

  it("keeps Windows smoke host wrappers ASCII-only and directory-relative", async () => {
    const root = await temporaryDirectory("graphcraft-release-windows-shims-");
    const environment = cleanSmokeEnvironment(join(root, "clean package home Ω"));
    await installSmokeHostShims(environment, "win32");

    for (const host of ["codex", "claude", "gh"]) {
      const wrapper = await readFile(join(environment.PNPM_HOME!, `${host}.cmd`), "utf8");
      expect(wrapper).toBe(`@echo off\r\n"%GRAPHCRAFT_SMOKE_NODE%" "%~dp0${host}.mjs" %*\r\n`);
      expect(Buffer.from(wrapper).every((byte) => byte <= 0x7f)).toBe(true);
      expect(wrapper).not.toContain(environment.PNPM_HOME!);
    }
    expect(environment.GRAPHCRAFT_SMOKE_NODE).toBe(process.execPath);
  });

  it.runIf(process.platform === "win32")(
    "runs the production Codex lifecycle through a Windows shim in the Unicode path",
    async () => {
      const root = await temporaryDirectory("graphcraft-release-windows-host-");
      const environment = cleanSmokeEnvironment(join(root, "clean package home Ω"));
      environment.GRAPHCRAFT_HOME = join(environment.HOME!, "Graphcraft state 工具");
      await Promise.all([
        mkdir(environment.HOME!, { recursive: true }),
        mkdir(environment.TMPDIR!, { recursive: true }),
      ]);
      const stateDirectory = await installSmokeHostShims(environment);
      for (const [name, value] of Object.entries(environment)) {
        if (typeof value === "string") vi.stubEnv(name, value);
      }

      const lifecycleOptions = { graphcraftHome: environment.GRAPHCRAFT_HOME };
      const mcpPath = join(process.cwd(), "dist", "mcp.mjs");
      await installHost("codex", mcpPath, lifecycleOptions);
      await installHost("codex", mcpPath, lifecycleOptions);
      await updateHost("codex", mcpPath, lifecycleOptions);
      await uninstallHost("codex", lifecycleOptions);
      await uninstallHost("codex", lifecycleOptions);

      const state = JSON.parse(await readFile(join(stateDirectory, "codex.json"), "utf8"));
      expect(state).toEqual({ registration: null, successfulAdds: 1, successfulRemoves: 1 });
    },
  );

  it("falls back when Windows smoke taskkill exits nonzero", () => {
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const child = {
      pid: 42,
      kill: vi.fn((_signal?: NodeJS.Signals | number) => true),
    };
    const crossSpawn = vi.fn(() => killer);

    terminateSmokeProcessTree(crossSpawn, child, "SIGKILL", { SystemRoot: "C:\\Windows" }, "win32");
    killer.emit("close", 1, null);

    expect(crossSpawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", "42", "/t", "/f"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("forces the Windows smoke tree during the first termination stage", () => {
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const child = {
      pid: 42,
      kill: vi.fn((_signal?: NodeJS.Signals | number) => true),
    };
    const crossSpawn = vi.fn(() => killer);

    terminateSmokeProcessTree(crossSpawn, child, "SIGTERM", { SystemRoot: "C:\\Windows" }, "win32");

    expect(crossSpawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", "42", "/t", "/f"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("compares package bytes rather than filenames", async () => {
    const root = await temporaryDirectory("graphcraft-release-artifacts-");
    const left = join(root, "left.tgz");
    const right = join(root, "right.tgz");
    await writeFile(left, "same bytes");
    await writeFile(right, "same bytes");
    await expect(compareArtifacts(left, right)).resolves.toMatchObject({
      sha256: artifactDigests(Buffer.from("same bytes")).sha256,
    });
    await writeFile(right, "different bytes");
    await expect(compareArtifacts(left, right)).rejects.toThrow(/not reproducible/);
  });

  it("selects only the manifest-bound tarball and verifies every persisted digest", async () => {
    const root = await temporaryDirectory("graphcraft-release-bound-artifact-");
    const tarball = join(root, "tpypan-graphcraft-0.1.2.tgz");
    const bytes = Buffer.from("manifest-bound package bytes");
    const digests = artifactDigests(bytes);
    const manifest = {
      ...artifactManifest(),
      size: bytes.byteLength,
      integrity: `sha512-${digests.sha512}`,
      digests,
    };
    await writeFile(tarball, bytes);
    await writeFile(join(root, "decoy.tgz"), "untrusted first glob match");

    await expect(verifyArtifactFile({ directory: root, artifactManifest: manifest })).resolves.toBe(
      tarball,
    );

    await writeFile(tarball, Buffer.from("manifest-bound package byteX"));
    await expect(
      verifyArtifactFile({ directory: root, artifactManifest: manifest }),
    ).rejects.toThrow(/SHA1 does not match/i);
    await expect(
      verifyArtifactFile({
        directory: root,
        artifactManifest: { ...manifest, tarball: "../tpypan-graphcraft-0.1.2.tgz" },
      }),
    ).rejects.toThrow(/exact npm pack filename/i);
  });

  it("requires exact integrity, registry signatures, and SLSA provenance", () => {
    const artifact = artifactManifest();
    const published = publishedMetadata(artifact);
    expect(validatePublishedMetadata(published, artifact)).toBe(true);
    expect(() =>
      validatePublishedMetadata(
        { ...published, dist: { ...published.dist, integrity: "sha512-different" } },
        artifact,
      ),
    ).toThrow(/integrity/);
    expect(() =>
      validatePublishedMetadata(
        { ...published, dist: { ...published.dist, signatures: [] } },
        artifact,
      ),
    ).toThrow(/registry signature/);
    expect(() =>
      validatePublishedMetadata(
        { ...published, dist: { ...published.dist, attestations: undefined } },
        artifact,
      ),
    ).toThrow(/provenance/);
  });

  it("binds published provenance to the exact Graphcraft release workflow and commit", () => {
    const artifact = artifactManifest();
    expect(validatePublishedProvenance(provenanceAttestations(artifact), artifact)).toMatchObject({
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              path: ".github/workflows/release.yml",
              ref: "refs/tags/v0.1.2",
              repository: "https://github.com/tpypan/graphcraft",
            },
          },
        },
      },
    });

    for (const [label, provenance] of [
      [
        /repository/i,
        provenanceAttestations(artifact, { repository: "https://github.com/example/graphcraft" }),
      ],
      [/workflow/i, provenanceAttestations(artifact, { workflow: ".github/workflows/other.yml" })],
      [/ref/i, provenanceAttestations(artifact, { ref: "refs/tags/v0.1.1" })],
      [/event/i, provenanceAttestations(artifact, { event: "workflow_dispatch" })],
      [/release commit/i, provenanceAttestations(artifact, { commit: "c".repeat(40) })],
      [
        /subject/i,
        provenanceAttestations(artifact, {
          subjectName: "pkg:npm/%40example/graphcraft@0.1.2",
        }),
      ],
      [/subject/i, provenanceAttestations(artifact, { duplicateSubject: true })],
      [/digest/i, provenanceAttestations(artifact, { subjectSha512: "0".repeat(128) })],
      [/payload type/i, provenanceAttestations(artifact, { payloadType: "application/json" })],
    ] as const) {
      expect(() => validatePublishedProvenance(provenance, artifact)).toThrow(label);
    }
  });

  it("distinguishes an unpublished version from an exact verified rerun", async () => {
    const artifact = artifactManifest();
    let requestSignal: AbortSignal | null | undefined;
    const missingFetch = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requestSignal = init?.signal;
        return new Response(null, { status: 404 });
      },
    ) as typeof fetch;
    await expect(
      registryState({
        artifactManifest: artifact,
        fetchImpl: missingFetch,
        requestTimeoutMs: 1_000,
      }),
    ).resolves.toBe("missing");
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    await expect(
      registryState({
        artifactManifest: artifact,
        fetchImpl: publishedFetch(artifact),
      }),
    ).resolves.toBe("verified");

    await expect(
      registryState({
        artifactManifest: artifact,
        fetchImpl: publishedFetch(
          artifact,
          publishedMetadata(artifact),
          provenanceAttestations(artifact, {
            repository: "https://github.com/example/graphcraft",
          }),
        ),
      }),
    ).rejects.toThrow(/repository/i);
    const completePending = publishedMetadata(artifact);
    const { attestations: _pendingAttestations, ...pendingDist } = completePending.dist;
    const pending = { ...completePending, dist: pendingDist };
    await expect(
      registryState({
        artifactManifest: artifact,
        fetchImpl: vi.fn(async () => Response.json(pending)),
      }),
    ).resolves.toBe("pending");
  });

  it("detects and verifies correction of a stable version published under the wrong dist-tag", async () => {
    const artifact = artifactManifest();
    await expect(
      registryState({
        artifactManifest: artifact,
        fetchImpl: publishedFetch(artifact),
      }),
    ).resolves.toBe("verified");

    await expect(
      stableDistTagState({
        artifactManifest: artifact,
        fetchImpl: vi.fn(async () => Response.json({ "dist-tags": { latest: "0.1.1" } })),
      }),
    ).resolves.toEqual({ latest: "0.1.1", state: "stale" });

    const corrected = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ "dist-tags": { latest: "0.1.1" } }))
      .mockResolvedValueOnce(Response.json({ "dist-tags": { latest: artifact.version } }));
    await expect(
      verifyStableDistTag({
        artifactManifest: artifact,
        attempts: 2,
        delayMs: 1,
        fetchImpl: corrected,
      }),
    ).resolves.toEqual({ latest: artifact.version, state: "current" });
    expect(corrected).toHaveBeenCalledTimes(2);
  });

  it("refuses a stable publish that would regress npm latest", async () => {
    const artifact = artifactManifest();
    await expect(
      verifyStableReleaseOrder({
        artifactManifest: artifact,
        fetchImpl: vi.fn(async () => Response.json({ "dist-tags": { latest: "0.1.1" } })),
      }),
    ).resolves.toEqual({ latest: "0.1.1", state: "forward" });
    await expect(
      verifyStableReleaseOrder({
        artifactManifest: artifact,
        fetchImpl: vi.fn(async () => Response.json({ "dist-tags": { latest: "0.1.2" } })),
      }),
    ).resolves.toEqual({ latest: "0.1.2", state: "current" });
    await expect(
      verifyStableReleaseOrder({
        artifactManifest: artifact,
        fetchImpl: vi.fn(async () => Response.json({ "dist-tags": { latest: "0.2.0" } })),
      }),
    ).rejects.toThrow(/refusing non-monotonic stable release/i);
  });

  it("retries registry propagation but never accepts mismatched existing bytes", async () => {
    const artifact = artifactManifest();
    let propagatedMetadataRequests = 0;
    const propagated = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes("/-/npm/v1/attestations/")) {
        return Response.json(provenanceAttestations(artifact));
      }
      propagatedMetadataRequests += 1;
      return propagatedMetadataRequests === 1
        ? new Response(null, { status: 404 })
        : Response.json(publishedMetadata(artifact));
    }) as typeof fetch;
    await expect(
      verifyPublishedPackage({
        artifactManifest: artifact,
        attempts: 2,
        delayMs: 1,
        fetchImpl: propagated,
      }),
    ).resolves.toMatchObject({ version: "0.1.2" });

    const completeMetadata = publishedMetadata(artifact);
    const { attestations: _incompleteAttestations, ...incompleteDist } = completeMetadata.dist;
    const incomplete = { ...completeMetadata, dist: { ...incompleteDist, signatures: [] } };
    let incompleteMetadataRequests = 0;
    const metadataThenAttestation = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes("/-/npm/v1/attestations/")) {
        return Response.json(provenanceAttestations(artifact));
      }
      incompleteMetadataRequests += 1;
      return Response.json(
        incompleteMetadataRequests === 1 ? incomplete : publishedMetadata(artifact),
      );
    }) as typeof fetch;
    await expect(
      verifyPublishedPackage({
        artifactManifest: artifact,
        attempts: 2,
        delayMs: 1,
        fetchImpl: metadataThenAttestation,
      }),
    ).resolves.toMatchObject({ version: "0.1.2" });
    expect(metadataThenAttestation).toHaveBeenCalledTimes(3);
    expect(propagated).toHaveBeenCalledTimes(3);

    const timedOut = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    let timeoutMetadataRequests = 0;
    const timeoutThenPublished = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes("/-/npm/v1/attestations/")) {
        return Response.json(provenanceAttestations(artifact));
      }
      timeoutMetadataRequests += 1;
      if (timeoutMetadataRequests === 1) throw timedOut;
      return Response.json(publishedMetadata(artifact));
    }) as typeof fetch;
    await expect(
      verifyPublishedPackage({
        artifactManifest: artifact,
        attempts: 2,
        delayMs: 1,
        fetchImpl: timeoutThenPublished,
      }),
    ).resolves.toMatchObject({ version: "0.1.2" });

    const mismatch = publishedMetadata(artifact);
    mismatch.dist.shasum = "0".repeat(40);
    await expect(
      verifyPublishedPackage({
        artifactManifest: artifact,
        attempts: 2,
        delayMs: 1,
        fetchImpl: vi.fn(async () => Response.json(mismatch)),
      }),
    ).rejects.toThrow(/shasum/);
  });
});
