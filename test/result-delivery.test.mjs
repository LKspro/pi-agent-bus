import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TerminalResultCorrelations,
  taskCompletionInstructions,
  shouldAcceptInboundMessage,
  shouldSuppressManualTaskResult,
} from "../src/result-delivery.ts";

const correlationId = "8d0f0fd5-5ddd-4758-aac9-e0db7fcf4e20";
const activeTask = { from: "orchestrator", correlationId };

test("task completion instructions require a normal final response", () => {
  const instructions = taskCompletionInstructions(activeTask);

  assert.match(instructions, /returned automatically to "orchestrator"/);
  assert.match(instructions, new RegExp(`correlationId "${correlationId}"`));
  assert.match(instructions, /Do not use `send_to` with type "result"/);
});

test("manual completion for the active correlation is suppressed", () => {
  assert.equal(
    shouldSuppressManualTaskResult(
      activeTask,
      { type: "result", to: "orchestrator", correlationId },
    ),
    true,
  );
  assert.equal(
    shouldSuppressManualTaskResult(
      activeTask,
      { type: "result", to: "orchestrator" },
    ),
    true,
  );
});

test("linked questions, tasks, and other result correlations are allowed", () => {
  assert.equal(
    shouldSuppressManualTaskResult(activeTask, { type: "question", to: "orchestrator" }),
    false,
  );
  assert.equal(
    shouldSuppressManualTaskResult(activeTask, { type: "task", to: "other" }),
    false,
  );
  assert.equal(
    shouldSuppressManualTaskResult(
      activeTask,
      { type: "result", to: "orchestrator", correlationId: "different" },
    ),
    false,
  );
});

test("bundled agent personas do not instruct manual normal completion", async () => {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const agentDir = join(projectRoot, "agents");
  const files = (await readdir(agentDir)).filter((file) => file.endsWith(".md"));

  for (const file of files) {
    const prompt = await readFile(join(agentDir, file), "utf8");
    assert.doesNotMatch(prompt, /send (your )?results back using `send_to`/i, file);
    assert.match(prompt, /returns it automatically/i, file);
  }

  const extensionSource = await readFile(join(projectRoot, "src", "index.ts"), "utf8");
  assert.doesNotMatch(extensionSource, /Use `send_to` to report results back to the orchestrator/);
  assert.match(extensionSource, /returns it automatically/);
});

test("repeated inbound terminal results are rejected before a second turn", () => {
  const received = new TerminalResultCorrelations();

  assert.equal(shouldAcceptInboundMessage("result", correlationId, received), true);
  assert.equal(shouldAcceptInboundMessage("result", correlationId, received), false);
  assert.equal(shouldAcceptInboundMessage("reply", correlationId, received), true);
});

test("automatic result delivery is idempotent per correlation", () => {
  const returned = new TerminalResultCorrelations();

  assert.equal(returned.record(correlationId), true);
  assert.equal(returned.record(correlationId), false);
  assert.equal(returned.record("different"), true);
});
