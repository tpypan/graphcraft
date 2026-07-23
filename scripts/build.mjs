import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

async function sourceIdentity() {
  const { stdout: headOutput } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf8" },
  );
  const commitSha = headOutput.trim().toLowerCase();
  if (!commitPattern.test(commitSha))
    throw new Error("Unable to resolve the Graphcraft source SHA");
  const { stdout: status } = await execFileAsync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude)dist/graphcraft.mjs",
      ":(exclude)dist/graphcraft.mjs.map",
      ":(exclude)dist/mcp.mjs",
      ":(exclude)dist/mcp.mjs.map",
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const dirty = status.length > 0;
  return {
    commitSha,
    dirty,
    dirtyStatusDigest: dirty
      ? createHash("sha256").update(JSON.stringify(status)).digest("hex")
      : null,
  };
}

const graphcraftSource = await sourceIdentity();
await mkdir("dist", { recursive: true });

const common = {
  banner: {
    js: 'import { createRequire as __graphcraftBundleCreateRequire } from "node:module";\nconst require = __graphcraftBundleCreateRequire(import.meta.url);',
  },
  bundle: true,
  define: {
    __GRAPHCRAFT_SOURCE_SHA__: JSON.stringify(graphcraftSource.commitSha),
    __GRAPHCRAFT_SOURCE_DIRTY__: JSON.stringify(graphcraftSource.dirty),
    __GRAPHCRAFT_SOURCE_STATUS_DIGEST__: JSON.stringify(graphcraftSource.dirtyStatusDigest),
  },
  format: "esm",
  logLevel: "info",
  minify: false,
  platform: "node",
  sourcemap: true,
  target: "node22",
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["packages/cli/src/bin.ts"],
    outfile: "dist/graphcraft.mjs",
  }),
  build({
    ...common,
    entryPoints: ["packages/mcp/src/bin.ts"],
    outfile: "dist/mcp.mjs",
  }),
]);

for (const path of ["dist/graphcraft.mjs", "dist/mcp.mjs"]) {
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replace(/[\t ]+$/gm, ""), "utf8");
  await chmod(path, 0o755);
}
