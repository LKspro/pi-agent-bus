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

/** Track terminal automatic deliveries so retries cannot return a task twice. */
export class AutoReturnedCorrelations {
  private readonly correlations = new Set<string>();

  has(correlationId: string): boolean {
    return this.correlations.has(correlationId);
  }

  record(correlationId: string): boolean {
    if (this.correlations.has(correlationId)) return false;
    this.correlations.add(correlationId);
    return true;
  }

  clear(): void {
    this.correlations.clear();
  }
}
