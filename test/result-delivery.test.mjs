import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  containsToolCall,
  DelegatedTaskTracker,
  TerminalResultCorrelations,
  messageFilename,
  resolveAutomaticResultTask,
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

test("linked replies do not replace the active task completion destination", async () => {
  // A reply may be the last user message when the worker reaches its final
  // answer. Completion must still return to the original task sender.
  const tracker = new DelegatedTaskTracker();
  assert.equal(tracker.enqueue(activeTask), true);
  assert.deepEqual(
    tracker.beginPrompt(
      `--- Message from "orchestrator" (type: task) ---\n\nWork\n\n---\n` +
        taskCompletionInstructions(activeTask),
    ),
    activeTask,
  );
  assert.deepEqual(resolveAutomaticResultTask(tracker), activeTask);

  // The agent_end integration must use that stored task, rather than parsing
  // only the last user message (which is a linked reply in this scenario).
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const extensionSource = await readFile(join(projectRoot, "src", "index.ts"), "utf8");
  assert.match(extensionSource, /resolveAutomaticResultTask\(delegatedTaskTracker\)/);
  assert.doesNotMatch(extensionSource, /Find the last user message/);
});

test("queued tasks bind their own agent run instead of overwriting each other", () => {
  const tracker = new DelegatedTaskTracker();
  const first = { from: "orchestrator", correlationId: "first-task" };
  const second = { from: "reviewer", correlationId: "second-task" };

  assert.equal(tracker.enqueue(first), true);
  assert.equal(tracker.enqueue(second), true);
  assert.equal(tracker.enqueue(first), false, "duplicate task correlation is rejected");

  assert.deepEqual(
    tracker.beginPrompt(
      `--- Message from "orchestrator" (type: task) ---\n\nDo first\n\n---\n` +
        taskCompletionInstructions(first),
    ),
    first,
  );
  assert.deepEqual(tracker.runningTask(), first);

  // A linked update gets its own run but must never take ownership of the
  // first task's automatic result.
  assert.equal(
    tracker.beginPrompt(
      `--- Message from "orchestrator" (type: reply) ---\n\nStatus update\n\n---\nCorrelation: first-task`,
    ),
    null,
  );
  assert.equal(tracker.runningTask(), null);
  assert.equal(tracker.complete(first.correlationId), true);

  assert.deepEqual(
    tracker.beginPrompt(
      `--- Message from "reviewer" (type: task) ---\n\nDo second\n\n---\n` +
        taskCompletionInstructions(second),
    ),
    second,
  );
  assert.equal(tracker.complete(second.correlationId), true);
  assert.deepEqual(tracker.unresolvedTasks(), []);
});

test("terminal text turns return before queued follow-ups; tool turns do not", async () => {
  assert.equal(containsToolCall({ content: [{ type: "text", text: "NO-GO" }] }), false);
  assert.equal(containsToolCall({ content: [{ type: "toolCall", name: "read" }] }), true);

  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const extensionSource = await readFile(join(projectRoot, "src", "index.ts"), "utf8");
  const turnEnd = extensionSource.slice(
    extensionSource.indexOf('pi.on("turn_end"'),
    extensionSource.indexOf('// ── send_to tool'),
  );
  assert.match(turnEnd, /!containsToolCall\(assistantMessage\)/);
  assert.match(turnEnd, /autoReturnDelegatedTask\(extractTextContent\(assistantMessage\)\)/);
});

test("message filenames remain unique for repeated same-correlation sends", () => {
  const first = messageFilename(123, correlationId, "nonce-one");
  const second = messageFilename(123, correlationId, "nonce-two");

  assert.notEqual(first, second);
  assert.match(first, /^123-8d0f0fd5-nonce-one\.json$/);
});

test("watching begins before backlog processing and accepted task results survive manual mode", async () => {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const extensionSource = await readFile(join(projectRoot, "src", "index.ts"), "utf8");
  const watcherStart = extensionSource.indexOf("mailboxWatcher = fs.watch(dir");
  const backlogStart = extensionSource.indexOf("processBacklog(dir, pi);");
  assert.ok(watcherStart >= 0 && watcherStart < backlogStart);

  const autoResultBlock = extensionSource.slice(
    extensionSource.indexOf('pi.on("agent_end"'),
    extensionSource.indexOf("// ── Turn end", extensionSource.indexOf('pi.on("agent_end"')),
  );
  assert.doesNotMatch(autoResultBlock, /isManualMode\(\)/);
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
