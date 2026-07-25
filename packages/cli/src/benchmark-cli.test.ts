import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  BenchmarkSuiteSchema,
  PORTABLE_CANONICAL_HASH_ALGORITHM,
  createBenchmarkSchedule,
  type BenchmarkScheduleEntry,
} from "@graphcraft/core";

const execFileAsync = promisify(execFile);
const binPath = fileURLToPath(new URL("./bin.ts", import.meta.url));
const suitePath = new URL("../../../benchmarks/stable-v1.json", import.meta.url);

describe("benchmark CLI", () => {
  it("prints the same portable-v4 schedule a fresh runtime benchmark uses", async () => {
    const suite = BenchmarkSuiteSchema.parse(JSON.parse(await readFile(suitePath, "utf8")));
    const seed = "cli-portable-v4-parity";
    const repetitions = 2;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        binPath,
        "benchmark",
        "stable-v1",
        "--dry-run",
        "--host",
        "both",
        "--repetitions",
        String(repetitions),
        "--seed",
        seed,
      ],
      { encoding: "utf8" },
    );
    const rendered = JSON.parse(stdout) as {
      trials: number;
      schedule: BenchmarkScheduleEntry[];
    };
    const expected = createBenchmarkSchedule({
      suite,
      hosts: ["codex", "claude"],
      seed,
      repetitions,
      identity: {
        schemaVersion: 4,
        hashAlgorithm: PORTABLE_CANONICAL_HASH_ALGORITHM,
      },
    });

    expect(stderr).toBe("");
    expect(rendered.trials).toBe(expected.length);
    expect(rendered.schedule).toEqual(expected);
  });
});
