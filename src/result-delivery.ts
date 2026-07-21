/** Protocol invariants for automatic delegated-task result delivery. */

export interface ActiveDelegatedTask {
  from: string;
  correlationId: string;
}

export interface SendToParameters {
  type: unknown;
  to: unknown;
  correlationId?: unknown;
}

/** A text-only assistant turn is terminal; tool-call turns may continue. */
export function containsToolCall(message: Record<string, unknown>): boolean {
  const content = message.content;
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        ((part as { type?: unknown }).type === "toolCall" ||
          (part as { type?: unknown }).type === "tool_use"),
    )
  );
}

/**
 * Tracks accepted delegated tasks and binds automatic completion to the task
 * prompt that is actually beginning an agent run. This deliberately separates
 * mailbox arrival order from user-message order: linked replies may arrive
 * after a task, and several tasks may be queued before Pi begins the first.
 */
export class DelegatedTaskTracker {
  private readonly unresolved = new Map<string, ActiveDelegatedTask>();
  private running: ActiveDelegatedTask | null = null;

  enqueue(task: ActiveDelegatedTask): boolean {
    if (this.unresolved.has(task.correlationId)) return false;
    this.unresolved.set(task.correlationId, task);
    return true;
  }

  beginPrompt(prompt: string): ActiveDelegatedTask | null {
    this.running = null;
    const header = prompt.match(/^--- Message from "([^"]+)" \(type: task\) ---/);
    const correlation = prompt.match(/correlationId "([^"]+)"/);
    if (!header || !correlation) return null;

    const task = this.unresolved.get(correlation[1]);
    if (!task || task.from !== header[1]) return null;
    this.running = task;
    return task;
  }

  runningTask(): ActiveDelegatedTask | null {
    return this.running;
  }

  complete(correlationId: string): boolean {
    if (!this.unresolved.has(correlationId)) return false;
    this.unresolved.delete(correlationId);
    if (this.running?.correlationId === correlationId) this.running = null;
    return true;
  }

  unresolvedTasks(): ActiveDelegatedTask[] {
    return [...this.unresolved.values()];
  }
}

/**
 * Accept either an already-known task or a tracker for backward-compatible
 * task-completion helpers. A linked reply never supplies a terminal task.
 */
export function resolveAutomaticResultTask(
  taskOrTracker: ActiveDelegatedTask | DelegatedTaskTracker | null,
): ActiveDelegatedTask | null {
  return taskOrTracker instanceof DelegatedTaskTracker
    ? taskOrTracker.runningTask()
    : taskOrTracker;
}

/** Build the task-prompt instruction for automatic, exactly-once completion. */
export function taskCompletionInstructions(task: ActiveDelegatedTask): string {
  return (
    `Your ordinary final response is returned automatically to "${task.from}" ` +
    `with correlationId "${task.correlationId}". Do not use \`send_to\` ` +
    `with type "result" for normal completion; that would duplicate the automatic ` +
    `result. Use \`send_to\` only for linked questions or replies.`
  );
}

/** Return true only for a manual result that duplicates the active task result. */
export function shouldSuppressManualTaskResult(
  activeTask: ActiveDelegatedTask | null,
  parameters: SendToParameters,
): boolean {
  return (
    parameters.type === "result" &&
    activeTask !== null &&
    parameters.to === activeTask.from &&
    (parameters.correlationId === undefined ||
      parameters.correlationId === activeTask.correlationId)
  );
}

/** Track terminal results so duplicate delivery cannot start another task turn. */
export class TerminalResultCorrelations {
  private readonly correlations = new Set<string>();

  has(correlationId: string): boolean {
    return this.correlations.has(correlationId);
  }

  record(correlationId: string): boolean {
    if (this.correlations.has(correlationId)) return false;
    this.correlations.add(correlationId);
    return true;
  }

  values(): string[] {
    return [...this.correlations];
  }

  clear(): void {
    this.correlations.clear();
  }
}

/** Return true when an inbound message is not a repeated terminal result. */
export function shouldAcceptInboundMessage(
  type: unknown,
  correlationId: string,
  receivedResults: TerminalResultCorrelations,
): boolean {
  return type !== "result" || receivedResults.record(correlationId);
}

/** A nonce keeps two same-millisecond same-correlation deliveries distinct. */
export function messageFilename(
  timestamp: number,
  correlationId: string,
  nonce: string,
): string {
  const shortId = correlationId.replace(/-/g, "").slice(0, 8);
  return `${timestamp}-${shortId}-${nonce}.json`;
}
