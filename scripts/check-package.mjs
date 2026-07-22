import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));
const pluginArtifacts = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".mcp.json",
];

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

async function runNpm(arguments_, options = {}) {
  const npmArguments = windows ? ["/d", "/s", "/c", ["npm", ...arguments_].join(" ")] : arguments_;
  return await execFileAsync(npmCommand, npmArguments, {
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

function parseLines(buffer) {
  const lines = [];
  let boundary;
  while ((boundary = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, boundary).trim();
    buffer = buffer.slice(boundary + 1);
    if (line) lines.push(JSON.parse(line));
  }
  return { lines, remainder: buffer };
}

async function smokeMcpServer({ command, args, cwd, clientName }) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(cwd ? { cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve();
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => {
      finish(new Error(`Installed MCP server did not respond: ${stderr.trim() || "timeout"}`));
    }, 5_000);

    child.on("error", finish);
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(
          new Error(
            `Installed MCP server exited before the smoke test completed (${String(code ?? signal)}): ${stderr.trim()}`,
          ),
        );
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-64 * 1024);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) {
        finish(new Error("Installed MCP server exceeded the 64 KiB smoke-test output limit"));
        return;
      }
      let parsed;
      try {
        parsed = parseLines(stdout);
      } catch (error) {
        finish(new Error(`Installed MCP server returned invalid JSON: ${String(error)}`));
        return;
      }
      stdout = parsed.remainder;
      for (const message of parsed.lines) {
        if (message.id === 1) {
          if (message.error) {
            finish(
              new Error(
                `Installed MCP server rejected initialization: ${JSON.stringify(message.error)}`,
              ),
            );
            return;
          }
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        }
        if (message.id === 2) {
          const tools = message.result?.tools;
          if (!Array.isArray(tools) || !tools.some(({ name }) => name === "graphcraft")) {
            finish(new Error("Installed MCP server did not expose the graphcraft tool"));
            return;
          }
          finish();
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0.0" },
      },
    });
  });
}

function codexPluginMcpCommand(installedRoot, manifest) {
  const server = manifest.mcpServers?.graphcraft;
  if (
    typeof server !== "object" ||
    server === null ||
    server.command !== "node" ||
    !Array.isArray(server.args) ||
    server.args.length !== 1 ||
    server.args[0] !== "dist/mcp.mjs" ||
    server.cwd !== "."
  ) {
    throw new Error("The Codex plugin must declare its package-local Graphcraft MCP command");
  }
  const cwd = resolve(installedRoot, server.cwd);
  const relativeCwd = relative(installedRoot, cwd);
  if (isAbsolute(relativeCwd) || relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)) {
    throw new Error("The Codex plugin MCP working directory escapes the installed package");
  }
  return { command: server.command, args: server.args, cwd };
}

for (const path of ["dist/graphcraft.mjs", "dist/mcp.mjs"]) {
  const source = await readFile(path, "utf8");
  if (!source.startsWith("#!/usr/bin/env node\n")) {
    throw new Error(`${path} must retain its executable shebang`);
  }
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "graphcraft-package-"));
try {
  const { stdout } = await runNpm(["pack", "--json", "--ignore-scripts"], {
    env: { ...process.env, npm_config_pack_destination: temporaryRoot },
  });
  const [pack] = JSON.parse(stdout);
  const actualFiles = pack.files.map(({ path }) => path).sort();
  const expectedFiles = [
    ...pluginArtifacts,
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

  const cleanInstall = join(temporaryRoot, "clean install");
  await mkdir(cleanInstall);
  await copyFile(join(temporaryRoot, pack.filename), join(cleanInstall, "graphcraft.tgz"));
  await runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", ".", "./graphcraft.tgz"],
    { cwd: cleanInstall },
  );

  const installedRoot = join(cleanInstall, "node_modules", "@tpypan", "graphcraft");
  const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  if (installedPackage.version !== packageMetadata.version) {
    throw new Error(
      `Clean install resolved ${installedPackage.version}, expected ${packageMetadata.version}`,
    );
  }
  for (const relativePath of pluginArtifacts) {
    const [source, installed] = await Promise.all([
      readFile(relativePath, "utf8"),
      readFile(join(installedRoot, relativePath), "utf8"),
    ]);
    if (source !== installed) throw new Error(`Packed plugin artifact changed: ${relativePath}`);
  }

  const { stdout: versionOutput } = await execFileAsync(
    process.execPath,
    [join(installedRoot, "dist", "graphcraft.mjs"), "--version"],
    { maxBuffer: 1024 * 1024 },
  );
  if (versionOutput.trim() !== packageMetadata.version) {
    throw new Error(
      `Clean-installed CLI reported ${versionOutput.trim()}, expected ${packageMetadata.version}`,
    );
  }
  await smokeMcpServer({
    command: process.execPath,
    args: [join(installedRoot, "dist", "mcp.mjs")],
    clientName: "graphcraft-package-smoke",
  });
  const codexManifest = JSON.parse(
    await readFile(join(installedRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  await smokeMcpServer({
    ...codexPluginMcpCommand(installedRoot, codexManifest),
    clientName: "graphcraft-codex-plugin-smoke",
  });

  console.log(
    `Package ${pack.name}@${pack.version}: ${pack.files.length} files, ${pack.size} packed bytes; clean CLI, direct MCP, and Codex plugin MCP smoke passed`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
