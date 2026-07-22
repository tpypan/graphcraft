import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));

if (packageMetadata.name !== "@tpypan/graphcraft") {
  throw new Error("The public package name must remain @tpypan/graphcraft");
}
if (packageMetadata.private === true) throw new Error("The public package cannot be private");
if (packageMetadata.bin?.graphcraft !== "dist/graphcraft.mjs") {
  throw new Error("The package must expose the graphcraft executable");
}
if (packageMetadata.publishConfig?.access !== "public") {
  throw new Error("The scoped package must publish with public access");
}

const windows = process.platform === "win32";
const npmCommand = windows ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmArguments = windows
  ? ["/d", "/s", "/c", "npm pack --dry-run --json --ignore-scripts"]
  : ["pack", "--dry-run", "--json", "--ignore-scripts"];
const { stdout } = await execFileAsync(npmCommand, npmArguments, {
  maxBuffer: 10 * 1024 * 1024,
});
const [pack] = JSON.parse(stdout);
const actualFiles = pack.files.map(({ path }) => path).sort();
const expectedFiles = [
  "LICENSE",
  "README.md",
  "benchmarks/stable-v1.json",
  "dist/graphcraft.mjs",
  "dist/mcp.mjs",
  "package.json",
].sort();

if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(`Unexpected npm package contents: ${actualFiles.join(", ")}`);
}

for (const path of ["dist/graphcraft.mjs", "dist/mcp.mjs"]) {
  const source = await readFile(path, "utf8");
  if (!source.startsWith("#!/usr/bin/env node\n")) {
    throw new Error(`${path} must retain its executable shebang`);
  }
}

console.log(
  `Package ${pack.name}@${pack.version}: ${pack.files.length} files, ${pack.size} packed bytes`,
);
