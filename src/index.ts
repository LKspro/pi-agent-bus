/**
 * Agent Bus — File-based inter-agent communication for pi coding agent.
 *
 * Multiple pi interactive sessions in separate terminal panes communicate
 * via filesystem mailboxes in .pi/mailbox/.  Every pane runs this extension.
 * The filesystem IS the network.
 *
 * Requires pi-hermes-memory for persistent memory across agent tasks.
 * Install separately: pi install pi-hermes-memory
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  discoverAgents,
  findAgent,
  getAgentNames,
  type AgentConfig,
} from "./agents";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentAgentName: string | null = null; // null = orchestrator
let currentAgent: AgentConfig | null = null;
let mailboxWatcher: fs.FSWatcher | null = null;
let cwd: string = process.cwd();

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

interface AgentMessage {
  from: string;
  to: string;
  type: "task" | "result" | "question" | "reply";
  correlationId: string;
  body: string;
  timestamp: string;
  inReplyTo?: string;
}

// ---------------------------------------------------------------------------
// Identity detection
// ---------------------------------------------------------------------------

function getMailboxDir(): string {
  return path.join(cwd, ".pi", "mailbox");
}

function getAgentMailboxDir(name: string): string {
  return path.join(getMailboxDir(), name);
}

function activateIdentity(name: string, pi: ExtensionAPI): void {
  currentAgentName = name;
  currentAgent = findAgent(cwd, name) ?? null; // agent config is optional
  ensureMailbox(name);
  startMailboxWatch(pi);
}

function detectIdentity(pi: ExtensionAPI): void {
  // 1. Session name (from pi --name or /agent command setting)
  const sessionName = pi.getSessionName()?.trim();
  if (sessionName) {
    const agent = findAgent(cwd, sessionName);
    if (agent) {
      activateIdentity(sessionName, pi);
      return;
    }
    // Session name set but no matching agent .md — activate anyway (ad-hoc)
    activateIdentity(sessionName, pi);
    return;
  }

  // 2. Environment variable
  const envName = process.env.AGENT_BUS_NAME?.trim();
  if (envName) {
    activateIdentity(envName, pi);
    return;
  }

  // 3. Fallback: orchestrator mode (currentAgentName stays null)
}

function ensureMailbox(name: string): void {
  fs.mkdirSync(getAgentMailboxDir(name), { recursive: true });
}

// ---------------------------------------------------------------------------
// Mailbox watching & message processing
// ---------------------------------------------------------------------------

function startMailboxWatch(pi: ExtensionAPI): void {
  if (!currentAgentName) return;

  const dir = getAgentMailboxDir(currentAgentName);

  // Process any backlog (messages from when we were offline)
  processBacklog(dir, pi);

  // Watch for new files
  mailboxWatcher = fs.watch(dir, (eventType, filename) => {
    if (eventType !== "rename" || !filename || !filename.endsWith(".json")) return;
    const filePath = path.join(dir, filename);
    // Delay to ensure file is fully written
    setTimeout(() => processIncomingMessage(filePath, pi), 150);
  });
}

function processBacklog(dir: string, pi: ExtensionAPI): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort(); // FIFO by filename (timestamp prefix)
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = path.join(dir, file);
    processIncomingMessage(filePath, pi);
  }
}

function processIncomingMessage(filePath: string, pi: ExtensionAPI): void {
  // Lock file pattern: try to rename to .processing first.
  // This prevents two panes of the same agent from double-processing.
  const processingPath = filePath + ".processing";
  try {
    fs.renameSync(filePath, processingPath);
  } catch {
    return; // Another process got it first, or file already deleted
  }

  let msg: AgentMessage;
  try {
    const raw = fs.readFileSync(processingPath, "utf-8");
    msg = JSON.parse(raw) as AgentMessage;
  } catch {
    tryCleanup(processingPath);
    return;
  }

  // Validate
  if (!msg.from || !msg.to || !msg.type || !msg.body) {
    tryCleanup(processingPath);
    return;
  }

  // Verify this message is for us — if not, rename back for the correct agent
  if (msg.to !== currentAgentName) {
    renameBack(processingPath);
    return;
  }

  // Build prompt and queue for next turn (never interrupt)
  const promptText = buildPromptFromMessage(msg);
  pi.sendUserMessage(promptText, { deliverAs: "followUp" });

  // Clean up
  tryCleanup(processingPath);
}

function tryCleanup(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // best-effort
  }
}

function renameBack(processingPath: string): void {
  try {
    const original = processingPath.replace(/\.processing$/, "");
    fs.renameSync(processingPath, original);
  } catch {
    // best-effort — if rename fails, delete to avoid stale lock
    tryCleanup(processingPath);
  }
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPromptFromMessage(msg: AgentMessage): string {
  const header = `--- Message from "${msg.from}" (type: ${msg.type}) ---`;

  switch (msg.type) {
    case "task": {
      return (
        `${header}\n\n` +
        `**Task assigned to you:**\n\n${msg.body}\n\n` +
        `---\n` +
        `When you complete this task, use the \`send_to\` tool to send ` +
        `your results back to "${msg.from}" with type "result" and ` +
        `correlationId "${msg.correlationId}".`
      );
    }

    case "result":
      return (
        `${header}\n\n` +
        `**Result from "${msg.from}":**\n\n${msg.body}\n\n` +
        `---\n` +
        `Correlation: ${msg.correlationId}`
      );

    case "question":
      return (
        `${header}\n\n` +
        `**Question from "${msg.from}":**\n\n${msg.body}\n\n` +
        `---\n` +
        `Use \`send_to\` to reply to "${msg.from}" with type "reply" ` +
        `and correlationId "${msg.correlationId}".`
      );

    case "reply":
      return (
        `${header}\n\n` +
        `**Reply from "${msg.from}":**\n\n${msg.body}\n\n` +
        `---\n` +
        `Correlation: ${msg.correlationId}`
      );

    default:
      return `${header}\n\n${msg.body}`;
  }
}

// ---------------------------------------------------------------------------
// Message delivery
// ---------------------------------------------------------------------------

function deliverMessage(msg: AgentMessage): void {
  const dir = getAgentMailboxDir(msg.to);
  fs.mkdirSync(dir, { recursive: true });

  const ts = Date.now();
  const shortId = msg.correlationId.replace(/-/g, "").slice(0, 8);
  const filename = `${ts}-${shortId}.json`;
  const filePath = path.join(dir, filename);

  // Atomic write: temp file → rename
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(msg, null, 2), {
    encoding: "utf-8",
  });
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Helpers for agent_end auto-send
// ---------------------------------------------------------------------------

function extractTextContent(msg: Record<string, unknown>): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: string; text: string } =>
          typeof c === "object" && c !== null && c.type === "text",
      )
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

function getFinalAssistantOutput(
  messages: Array<Record<string, unknown>>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      return extractTextContent(msg);
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Manual mode toggle — global kill-switch for agent-to-agent delegation
// ---------------------------------------------------------------------------

function isManualMode(): boolean {
  return fs.existsSync(path.join(cwd, ".pi", "agent-bus-manual"));
}

// ---------------------------------------------------------------------------
// Project memory auto-capture (pi-hermes-memory compatible format)
// Writes task→result summaries to projects-memory/<project>/MEMORY.md
// using the same § delimiter and <!-- created=..., last=... --> metadata
// that pi-hermes-memory uses, so entries are treated as first-class.
// ---------------------------------------------------------------------------

const HERMES_DELIM = "\n§\n";

function getProjectMemoryPath(): string {
  return path.join(getAgentDir(), "projects-memory", path.basename(cwd), "MEMORY.md");
}

function appendProjectMemory(entry: string): void {
  const fp = getProjectMemoryPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });

  const today = new Date().toISOString().split("T")[0];
  // pi-hermes-memory compatible: text + metadata comment, § delimited
  const encoded = `${entry} <!-- created=${today}, last=${today} -->`;

  // Read existing to avoid overwriting entries added by pi-hermes-memory
  // between our last read and this write (best-effort).
  let existing = "";
  try {
    existing = fs.readFileSync(fp, "utf-8");
  } catch {
    // file doesn't exist yet — fine
  }

  if (existing.trim()) {
    // Merge: existing entries + our new entry, dedup by content
    const entries = existing.split(HERMES_DELIM).map(e => e.trim()).filter(Boolean);
    const stripped = entries.map(e => e.replace(/\s*<!--.*?-->\s*$/, "").trim());
    if (!stripped.includes(entry)) {
      entries.push(encoded);
    }
    fs.writeFileSync(fp, entries.join(HERMES_DELIM), "utf-8");
  } else {
    fs.writeFileSync(fp, encoded, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Mailbox helpers
// ---------------------------------------------------------------------------

function getPendingCount(): number {
  if (!currentAgentName) return 0;
  const dir = getAgentMailboxDir(currentAgentName);
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Garbage-collect stale .processing files (renamed but never deleted)
// ---------------------------------------------------------------------------

function gcProcessingFiles(): void {
  if (!currentAgentName) return;
  const dir = getAgentMailboxDir(currentAgentName);
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  const STALE_MS = 5 * 60 * 1000; // 5 minutes
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".processing")) continue;
      try {
        const stat = fs.statSync(path.join(dir, f));
        if (now - stat.mtimeMs > STALE_MS) {
          fs.unlinkSync(path.join(dir, f));
        }
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Extension factory (top-level export)
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  // ── Agent start: inject agent persona from discovered .md definition ──
  pi.on("before_agent_start", async (event, ctx) => {
    const sessionCwd = ctx.cwd || process.cwd();
    const sessionName = pi.getSessionName()?.trim() || process.env.AGENT_BUS_NAME?.trim();
    if (!sessionName) return;

    const agent = findAgent(sessionCwd, sessionName);
    const prompt = agent?.systemPrompt?.trim();
    if (!prompt) return;

    if (typeof event.systemPrompt === "string" && event.systemPrompt.startsWith(prompt)) {
      return;
    }

    return {
      systemPrompt: `${prompt}\n\n---\n\n${event.systemPrompt}`,
    };
  });

  // ── Session start: detect identity, watch mailbox ──
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd || process.cwd();
    detectIdentity(pi);

    // GC stale .processing locks from previous runs
    gcProcessingFiles();
  });

  // ── Session shutdown: cleanup ──
  pi.on("session_shutdown", async () => {
    if (mailboxWatcher) {
      mailboxWatcher.close();
      mailboxWatcher = null;
    }
  });

  // ── Agent end: auto-send results ──
  pi.on("agent_end", async (event) => {
    if (!currentAgentName) return;
    if (isManualMode()) return; // manual mode blocks auto-send

    const messages = event.messages as Array<Record<string, unknown>>;

    // Find the last user message
    let lastUserMsg: Record<string, unknown> | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserMsg = messages[i];
        break;
      }
    }
    if (!lastUserMsg) return;

    // Check if it was a task from another agent
    const text = extractTextContent(lastUserMsg);
    const taskMatch = text.match(/^--- Message from "([^"]+)" \(type: task\) ---/);
    if (!taskMatch) return;

    const from = taskMatch[1];

    // Extract correlationId
    const corrMatch = text.match(/correlationId "([^"]+)"/);
    if (!corrMatch) return;
    const correlationId = corrMatch[1];

    // Get the final assistant output
    const finalOutput = getFinalAssistantOutput(messages);
    if (!finalOutput || finalOutput.trim().length === 0) return;

    // Auto-send result
    const msg: AgentMessage = {
      from: currentAgentName,
      to: from,
      type: "result",
      correlationId,
      body: finalOutput,
      timestamp: new Date().toISOString(),
      inReplyTo: correlationId,
    };

    deliverMessage(msg);

    // Auto-capture task result to project memory (pi-hermes-memory compatible)
    try {
      const taskText = extractTextContent(lastUserMsg);
      const taskBodyMatch = taskText.match(/\*\*Task assigned to you:\*\*\n\n([\s\S]*?)\n\n---/);
      if (taskBodyMatch) {
        const taskSnippet = taskBodyMatch[1].trim().slice(0, 200);
        const resultSnippet = finalOutput.trim().slice(0, 200);
        appendProjectMemory(
          `[agent-task] ${currentAgentName}: ${taskSnippet} → ${resultSnippet}`,
        );
      }
    } catch {
      // best-effort — never block agent_end for memory capture failures
    }
  });

  // ── Turn end: update widget ──
  pi.on("turn_end", async (_event, ctx) => {
    if (!currentAgentName) return;

    const pendingCount = getPendingCount();
    const lines = [
      `🤖 ${currentAgentName}`,
      `📬 Pending: ${pendingCount}`,
      `📁 ${currentAgent ? currentAgent.source : "ad-hoc"}`,
    ];

    ctx.ui.setWidget("agent-bus", lines);
  });

  // ── send_to tool ──
  pi.registerTool({
    name: "send_to",
    label: "Send to Agent",
    description:
      "Send a message to another agent via the agent bus. " +
      "Use to report results, ask questions, delegate subtasks, " +
      "or reply to requests. Available agents are discovered from " +
      ".pi/mailbox/ directory listing.",
    promptSnippet:
      "Send message to agent: to=<name>, type=<task|result|question|reply>, body=<content>",
    parameters: Type.Object({
      to: Type.String({
        description:
          "Target agent name. Use 'orchestrator' to report to the coordinator.",
      }),
      type: StringEnum(["task", "result", "question", "reply"] as const),
      body: Type.String({ description: "Message content to send" }),
      correlationId: Type.Optional(
        Type.String({
          description:
            "Correlation ID to link to a previous message. " +
            "If not provided, a new one is generated.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (isManualMode()) {
        return {
          content: [
            {
              type: "text",
              text:
                "🚫 Manual mode is ON. Agent-to-agent delegation is blocked. " +
                "Delete .pi/agent-bus-manual to re-enable, or ask the user to relay the message.",
            },
          ],
        };
      }

      const mailboxDir = getMailboxDir();
      const availableTargets = fs.existsSync(mailboxDir)
        ? fs
            .readdirSync(mailboxDir)
            .filter((f) =>
              fs.statSync(path.join(mailboxDir, f)).isDirectory(),
            )
        : [];

      if (!availableTargets.includes(params.to)) {
        // Target mailbox doesn't exist yet — create it
        fs.mkdirSync(path.join(mailboxDir, params.to), { recursive: true });
      }

      const msg: AgentMessage = {
        from: currentAgentName || "orchestrator",
        to: params.to,
        type: params.type,
        correlationId: params.correlationId || crypto.randomUUID(),
        body: params.body,
        timestamp: new Date().toISOString(),
      };

      deliverMessage(msg);

      return {
        content: [
          {
            type: "text",
            text: `✅ Message sent to "${params.to}" (type: ${params.type}, id: ${msg.correlationId.slice(0, 8)})`,
          },
        ],
        details: { message: msg },
      };
    },
  });

  // ── /agent command ──
  pi.registerCommand("agent", {
    description:
      "Activate this pane as a specific agent. Tab to autocomplete from available agents.",
    getArgumentCompletions: (prefix: string) => {
      const names = getAgentNames(cwd);
      return names
        .filter((n) => n.startsWith(prefix))
        .map((n) => ({ value: n, label: n }));
    },
    handler: async (args, ctx) => {
      if (!args) {
        // No argument: show available agents
        const agents = discoverAgents(cwd);
        if (agents.length === 0) {
          ctx.ui.notify(
            "No agents found. Add .md files to ~/.pi/agent/agents/ or .pi/agents/",
            "warning",
          );
          return;
        }
        const lines = agents
          .map((a) => `  ${a.name} — ${a.description} (${a.source})`)
          .join("\n");
        ctx.ui.notify(`Available agents:\n${lines}`, "info");
        return;
      }

      const agent = findAgent(cwd, args);
      // Agent config is optional — orchestrator and ad-hoc agents may not have .md files
      if (!agent) {
        // Show available agents as a hint, but still allow activation
        const available = getAgentNames(cwd);
        if (available.length > 0) {
          ctx.ui.notify(
            `Agent "${args}" has no .md definition. ` +
              `Available defined agents: ${available.join(", ")}. ` +
              `Activating anyway as ad-hoc agent.`,
            "warning",
          );
        }
      }
      // Set session name
      pi.setSessionName(args);

      // Activate (agent config is optional — works for orchestrator too)
      activateIdentity(args, pi);

      ctx.ui.notify(
        `✅ Activated as "${args}". Mailbox: .pi/mailbox/${args}/`,
        "info",
      );
    },
  });

  // ── /agents command ──
  pi.registerCommand("agents", {
    description:
      "List all available agents with copy-paste launch commands",
    handler: async (_args, ctx) => {
      const agents = discoverAgents(cwd);

      if (agents.length === 0) {
        ctx.ui.notify(
          "No agents found. Add .md files to:\n" +
            "  ~/.pi/agent/agents/  (global)\n" +
            "  .pi/agents/  (project)",
          "warning",
        );
        return;
      }
      const lines: string[] = [];
      lines.push("");
      lines.push("  AGENT              SOURCE    COMMAND");
      lines.push(
        "  ─────────────────  ────────  ─────────────────────────────────────────────",
      );

      for (const agent of agents) {
        const nameCol = agent.name.padEnd(17);
        const sourceCol = agent.source.padEnd(8);
        const cmd = `pi --session .pi/sessions/${agent.name}.jsonl --name ${agent.name}`;
        lines.push(`  ${nameCol}  ${sourceCol}  ${cmd}`);
      }
      lines.push("");
      lines.push(
        `  ${agents.length} agents. Copy a launch command above to a new terminal pane.`,
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /agent-bus command — project init, manual toggle ──
  pi.registerCommand("agent-bus", {
    description:
      "Manage agent-bus: init a project or toggle manual mode. Usage: /agent-bus [init|manual]",
    handler: async (args, ctx) => {
      if (!args || args === "init") {
        // Create project structure
        const agentsDir = path.join(cwd, ".pi", "agents");
        const mailboxDir = getMailboxDir();
        const sessionsDir = path.join(cwd, ".pi", "sessions");
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.mkdirSync(mailboxDir, { recursive: true });
        fs.mkdirSync(sessionsDir, { recursive: true });

        // Scaffold a default project agent if none exist
        const existing = fs
          .readdirSync(agentsDir)
          .filter((f) => f.endsWith(".md"));
        if (existing.length === 0) {
          const projectName = path.basename(cwd);
          const agentMd = [
            "---",
            `name: ${projectName}-dev`,
            `description: Primary developer agent for ${projectName}`,
            "tools: read, grep, find, ls, bash, edit, write, send_to",
            "---",
            "",
            `# ${projectName} Developer Agent`,
            "",
            "You are the primary development agent for this project.",
            "",
            "## Rules",
            "- Follow existing codebase patterns and conventions",
            "- Use `send_to` to report results back to the orchestrator",
            "- Do not make unapproved architectural changes",
            "",
            "## Output Format",
            "```",
            "## Changes Made",
            "- File: path — what and why",
            "",
            "## Validation",
            "- Tests: result",
            "```",
          ].join("\n");
          fs.writeFileSync(
            path.join(agentsDir, `${projectName}-dev.md`),
            agentMd,
            "utf-8",
          );
        }

        const agentCount = discoverAgents(cwd).length;
        ctx.ui.notify(
          `✅ Agent-bus initialized in ${cwd}\n` +
            `  .pi/agents/ — project agent definitions\n` +
            `  .pi/mailbox/ — inter-agent message routing\n` +
            `  .pi/sessions/ — persistent session files\n` +
            `\n` +
            `${agentCount} agents available. Run /agents to see launch commands.\n` +
            `\n` +
            `Manual mode: touch .pi/agent-bus-manual to block agent-to-agent delegation.\n` +
            `            rm .pi/agent-bus-manual to re-enable.`,
          "info",
        );
        return;
      }

      if (args === "manual") {
        const flagFile = path.join(cwd, ".pi", "agent-bus-manual");
        if (fs.existsSync(flagFile)) {
          fs.unlinkSync(flagFile);
          ctx.ui.notify(
            "🟢 Manual mode OFF — agents can delegate to each other.",
            "info",
          );
        } else {
          fs.writeFileSync(flagFile, "", "utf-8");
          ctx.ui.notify(
            "🔴 Manual mode ON — agent-to-agent delegation is blocked.",
            "warning",
          );
        }
        return;
      }

      ctx.ui.notify("Usage: /agent-bus [init|manual]", "warning");
    },
  });

  // ── /peers command ──
  pi.registerCommand("peers", {
    description: "Show active agents by checking mailbox timestamps",
    handler: async (_args, ctx) => {
      const mailboxDir = getMailboxDir();
      if (!fs.existsSync(mailboxDir)) {
        ctx.ui.notify(
          "No agents have been active yet. No mailboxes exist.",
          "info",
        );
        return;
      }

      const entries = fs.readdirSync(mailboxDir, { withFileTypes: true });
      const agentNames = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      if (agentNames.length === 0) {
        ctx.ui.notify("No active agents found.", "info");
        return;
      }

      const now = Date.now();
      const lines: string[] = [];
      lines.push("");
      lines.push("  AGENT            PENDING  LAST ACTIVITY");
      lines.push("  ───────────────  ───────  ─────────────");

      for (const name of agentNames) {
        const dir = path.join(mailboxDir, name);
        let files: string[];
        try {
          files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
        } catch {
          files = [];
        }
        const pendingCount = files.length;

        let lastActivity = "never";
        if (files.length > 0) {
          const latest = files.sort().pop()!;
          try {
            const stat = fs.statSync(path.join(dir, latest));
            const age = Math.round((now - stat.mtimeMs) / 1000);
            if (age < 60) {
              lastActivity = String(age) + "s ago";
            } else if (age < 3600) {
              lastActivity = String(Math.round(age / 60)) + "m ago";
            } else {
              lastActivity = String(Math.round(age / 3600)) + "h ago";
            }
          } catch {
            // file may have been deleted between readdir and stat
          }
        }

        const isMe = name === (currentAgentName || "orchestrator");
        const marker = isMe ? " ← you" : "";
        const nameCol = (name + marker).padEnd(19);
        const pendingCol = String(pendingCount).padEnd(7);
        lines.push(`  ${nameCol}  ${pendingCol}  ${lastActivity}`);
      }

      lines.push("");
      lines.push(
        `  ${agentNames.length} active. Use /delegate <agent> <task> to send work.`,
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /delegate command ──
  pi.registerCommand("delegate", {
    description:
      "Send a task to another agent. Usage: /delegate <agent> <task description>",
    handler: async (args, ctx) => {
      if (!args || !args.includes(" ")) {
        ctx.ui.notify(
          "Usage: /delegate <agent> <task description>",
          "warning",
        );
        return;
      }

      const spaceIndex = args.indexOf(" ");
      const targetAgent = args.slice(0, spaceIndex);
      const taskBody = args.slice(spaceIndex + 1);

      const availableTargets = getAgentNames(cwd);
      const mailboxDir = getMailboxDir();
      const existingMailboxes = fs.existsSync(mailboxDir)
        ? fs
            .readdirSync(mailboxDir)
            .filter((f) =>
              fs.statSync(path.join(mailboxDir, f)).isDirectory(),
            )
        : [];

      const allTargets = [
        ...new Set([...availableTargets, ...existingMailboxes]),
      ];

      if (!allTargets.includes(targetAgent)) {
        ctx.ui.notify(
          `Target "${targetAgent}" not found. Available: ${allTargets.join(", ") || "none"}`,
          "warning",
        );
        return;
      }

      const msg: AgentMessage = {
        from: currentAgentName || "orchestrator",
        to: targetAgent,
        type: "task",
        correlationId: crypto.randomUUID(),
        body: taskBody,
        timestamp: new Date().toISOString(),
      };

      deliverMessage(msg);
      ctx.ui.notify(
        `📤 Task sent to "${targetAgent}" (id: ${msg.correlationId.slice(0, 8)})`,
        "info",
      );
    },
  });
}
