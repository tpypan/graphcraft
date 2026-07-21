import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../packages/adapter-codex/src/index.ts";
import { ClaudeAdapter } from "../packages/adapter-claude/src/index.ts";
import {
  classifyTask,
  compilePlannedGraph,
  compileRunContract,
  applyProbePlan,
  graphPlanShape,
  type Graph,
  type GraphPlanner,
  type TaskFamily,
} from "../packages/core/src/index.ts";
import { discoverProbePlan } from "../packages/probes/src/index.ts";
import { discoverRepository } from "../packages/runtime/src/repository.ts";
import { discoverPlanningEvidence } from "../packages/runtime/src/repository.ts";

const execFileAsync = promisify(execFile);
const configuredHosts = (process.env.GRAPHCRAFT_LIVE_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter((host): host is "codex" | "claude" => host === "codex" || host === "claude");
const configuredFamilies = new Set(
  (process.env.GRAPHCRAFT_LIVE_FAMILIES ?? "")
    .split(",")
    .map((family) => family.trim())
    .filter(Boolean),
);

const tasks: Array<{ family: TaskFamily; task: string; expectedPaths: string[] }> = [
  {
    family: "bug",
    task: "Fix task-family classification so repository paths containing fix are not misclassified, and verify the regression",
    expectedPaths: ["packages/core/src/graph.ts"],
  },
  {
    family: "feature",
    task: "Extend the CLI renderContract report with human-readable graph shape and completion proof, and verify the package",
    expectedPaths: ["packages/cli/src/index.ts"],
  },
  {
    family: "migration",
    task: "Migrate Codex and Claude adapter process spawning to one shared subprocess helper without changing behavior",
    expectedPaths: ["packages/adapter-codex/src/index.ts", "packages/adapter-claude/src/index.ts"],
  },
  {
    family: "refactor",
    task: "Refactor duplicated token-usage and structured-result parsing across the Codex and Claude adapters",
    expectedPaths: ["packages/adapter-codex/src/index.ts", "packages/adapter-claude/src/index.ts"],
  },
  {
    family: "audit",
    task: "Audit every RunStore persisted run file for schema versioning and identify unsupported future-format boundaries",
    expectedPaths: ["packages/runtime/src/store.ts", "packages/core/src/schemas.ts"],
  },
];
const selectedTasks =
  configuredFamilies.size === 0
    ? tasks
    : tasks.filter(({ family }) => configuredFamilies.has(family));

function adapterFor(host: "codex" | "claude"): GraphPlanner {
  return host === "codex" ? new CodexAdapter() : new ClaudeAdapter();
}

async function pathIsTracked(repositoryPath: string, path: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["ls-files", "--", path], {
    cwd: repositoryPath,
  });
  return stdout.trim().length > 0;
}

describe.skipIf(configuredHosts.length === 0)("live host graph planning", () => {
  for (const host of configuredHosts) {
    it(
      `${host} produces distinct valid repository-grounded plans for every task family`,
      async () => {
        const repository = await discoverRepository(process.cwd());
        const adapter = adapterFor(host);
        const capabilities = await adapter.probe();
        expect(capabilities).toMatchObject({
          installed: true,
          authenticated: true,
          structuredOutput: true,
          streamingEvents: true,
        });

        const structuralSignatures = new Set<string>();
        const report: Array<Record<string, unknown>> = [];
        for (const fixture of selectedTasks) {
          expect(classifyTask(fixture.task)).toBe(fixture.family);
          const contract = compileRunContract(fixture.task, repository);
          const probePlan = await discoverProbePlan(
            repository.root,
            fixture.task,
            repository.baseSha,
          );
          const verificationProbes = probePlan.items
            .filter(({ phase }) => phase === "completion")
            .map(({ probe }) => probe);
          const repositoryEvidence = await discoverPlanningEvidence(repository.root, fixture.task);
          for (const expectedPath of fixture.expectedPaths)
            expect(repositoryEvidence.files.map(({ path }) => path)).toContain(expectedPath);
          const result = await adapter.plan(
            {
              contract,
              repositoryPath: repository.root,
              repositoryEvidence,
              probePlan,
              verificationProbes,
            },
            new AbortController().signal,
          );
          let graph: Graph;
          try {
            graph = applyProbePlan(
              compilePlannedGraph(
                contract,
                result.plan,
                verificationProbes,
                probePlan.items.map(({ probe }) => probe),
              ),
              contract,
              probePlan,
            );
          } catch (error) {
            console.error(
              JSON.stringify({ host, family: fixture.family, plan: result.plan }, null, 2),
            );
            throw error;
          }
          expect(graph.family).toBe(fixture.family);
          const selectedPaths = new Set(
            graph.nodes.flatMap((node) => node.contextSelector.relevantPaths),
          );
          for (const expectedPath of fixture.expectedPaths)
            expect(selectedPaths).toContain(expectedPath);

          for (const node of graph.nodes.filter((candidate) => candidate.kind !== "commit")) {
            expect(node.contextSelector.relevantPaths.length).toBeGreaterThan(0);
            for (const relevantPath of node.contextSelector.relevantPaths) {
              if (!(await pathIsTracked(repository.root, relevantPath)))
                throw new Error(
                  `${host}/${fixture.family} selected untracked context ${relevantPath}: ${JSON.stringify(result.plan)}`,
                );
            }
          }

          const structuralSignature = JSON.stringify(
            graph.nodes.map(({ id, kind, dependsOn, sideEffectClass }) => ({
              id,
              kind,
              dependsOn,
              sideEffectClass,
            })),
          );
          structuralSignatures.add(structuralSignature);
          report.push({
            host,
            family: fixture.family,
            shape: graphPlanShape(graph),
            relevantPaths: graph.nodes.flatMap((node) => node.contextSelector.relevantPaths),
            usage: result.usage,
          });
        }

        console.log(JSON.stringify(report, null, 2));
        expect(structuralSignatures.size).toBe(selectedTasks.length);
      },
      15 * 60_000,
    );
  }
});
