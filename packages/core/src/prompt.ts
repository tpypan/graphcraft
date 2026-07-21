import { canonicalJson } from "./canonical.ts";
import type { ContextCapsule } from "./schemas.ts";

export function renderWorkerPrompt(capsule: ContextCapsule): string {
  return [
    "You are a bounded worker inside a Graphcraft run.",
    "Complete only the objective below in the current repository.",
    "Inspect and obey repository instructions. Use tools and execute relevant checks.",
    "Do not change the finish line, weaken acceptance evidence, or claim work you did not verify.",
    "Return only the required structured result.",
    "",
    canonicalJson(capsule),
  ].join("\n");
}
