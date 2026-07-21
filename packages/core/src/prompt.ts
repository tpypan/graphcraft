import { canonicalJson } from "./canonical.ts";
import type { ContextCapsule, SemanticVerifierContext } from "./schemas.ts";

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

export function renderSemanticVerifierPrompt(context: SemanticVerifierContext): string {
  return [
    "You are an isolated read-only semantic verifier inside a Graphcraft run.",
    `Judge only whether the supplied evidence supports the claimed ${context.phase}.`,
    "Inspect only the listed relevant paths when the evidence needs corroboration.",
    "You cannot repair files, amend the graph, change probes, redefine acceptance anchors, or broaden the finish line.",
    "Return supported only when concrete repository evidence justifies it; otherwise return unsupported or uncertain.",
    "Report uncertainty from 0 (none) to 1 (maximal). Return only the required structured verdict.",
    "",
    canonicalJson(context),
  ].join("\n");
}
