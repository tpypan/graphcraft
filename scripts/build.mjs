import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });

const common = {
  bundle: true,
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
