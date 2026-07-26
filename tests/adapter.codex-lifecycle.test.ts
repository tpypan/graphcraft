import { describe, expect, it } from "vitest";
import {
  createCodexProtocolValidator,
  type CodexProtocolValidationOptions,
} from "../packages/adapter-codex/src/index.ts";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";

function observe(events: Record<string, unknown>[], options?: CodexProtocolValidationOptions) {
  const validator = createCodexProtocolValidator(options);
  let failure: string | undefined;
  for (const event of events) {
    failure = validator.observe(event);
    if (failure) break;
  }
  return { validator, failure };
}

const completeLifecycle = [
  { type: "thread.started", thread_id: THREAD_ID },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: "{}" } },
  { type: "turn.completed", usage: {} },
];

describe("Codex production protocol lifecycle", () => {
  it("accepts one complete thread and turn while exposing the stable thread identity", () => {
    const { validator, failure } = observe(completeLifecycle);

    expect(failure).toBeUndefined();
    expect(validator.threadId()).toBe(THREAD_ID);
    expect(validator.completionFailure()).toBeUndefined();
  });

  it.each([
    [[], "Codex did not attest thread.started"],
    [[completeLifecycle[0]!], "Codex did not attest turn.started"],
    [completeLifecycle.slice(0, 3), "Codex did not attest turn.completed"],
  ])("rejects an incomplete lifecycle %#", (events, expected) => {
    const { validator, failure } = observe(events as Record<string, unknown>[]);

    expect(failure).toBeUndefined();
    expect(validator.completionFailure()).toBe(expected);
  });

  it.each([
    [
      [completeLifecycle[0]!, completeLifecycle[0]!],
      "Codex reported a duplicate or out-of-order thread.started event",
    ],
    [[{ type: "turn.started" }], "Codex reported a duplicate or out-of-order turn.started event"],
    [
      [completeLifecycle[0]!, { type: "turn.started" }, { type: "turn.started" }],
      "Codex reported a duplicate or out-of-order turn.started event",
    ],
    [
      [completeLifecycle[0]!, { type: "turn.completed" }],
      "Codex reported a duplicate or out-of-order turn.completed event",
    ],
    [
      [
        completeLifecycle[0]!,
        { type: "turn.started" },
        { type: "turn.completed" },
        { type: "turn.completed" },
      ],
      "Codex reported a duplicate or out-of-order turn.completed event",
    ],
    [
      [completeLifecycle[0]!, { type: "item.started", item: { type: "agent_message" } }],
      "Codex reported item output before turn.started",
    ],
    [
      [...completeLifecycle, { type: "item.started", item: { type: "agent_message" } }],
      "Codex reported item output after turn.completed",
    ],
    [[...completeLifecycle, { type: "error" }], "Codex reported an error after turn.completed"],
  ])("rejects duplicate or out-of-order lifecycle input %#", (events, expected) => {
    const { failure } = observe(events as Record<string, unknown>[]);

    expect(failure).toBe(expected);
  });

  it("binds resumed workers to the exact expected thread", () => {
    const options = {
      expectedThreadId: THREAD_ID,
      sessionContext: "resumed_worker",
    } as const;
    const accepted = observe(completeLifecycle, options);
    const mismatched = observe(
      [{ type: "thread.started", thread_id: "00000000-0000-4000-8000-ffffffffffff" }],
      options,
    );
    const missing = observe([{ type: "thread.started" }], options);

    expect(accepted.failure).toBeUndefined();
    expect(accepted.validator.completionFailure()).toBeUndefined();
    expect(mismatched.failure).toBe(
      "Codex resumed worker reported a different thread identity; result was rejected",
    );
    expect(missing.failure).toBe(
      "Codex resumed worker did not report its thread identity; result was rejected",
    );
  });

  it("rejects a later thread identity drift before accepting more output", () => {
    const { failure } = observe(
      [
        completeLifecycle[0]!,
        { type: "turn.started" },
        { type: "thread.started", thread_id: "00000000-0000-4000-8000-ffffffffffff" },
      ],
      { sessionContext: "worker" },
    );

    expect(failure).toBe("Codex worker reported a different thread identity; result was rejected");
  });

  it("retains terminal protocol failures while allowing a transient in-turn error", () => {
    const recovered = observe([
      completeLifecycle[0]!,
      { type: "turn.started" },
      { type: "error", message: "transient stream failure; retrying" },
      { type: "turn.completed" },
    ]);
    const failed = observe([
      completeLifecycle[0]!,
      { type: "turn.started" },
      { type: "turn.failed", error: { message: "turn failed after retries" } },
    ]);

    expect(recovered.failure).toBeUndefined();
    expect(recovered.validator.completionFailure()).toBeUndefined();
    expect(failed.failure).toBe("turn failed after retries");
  });
});
