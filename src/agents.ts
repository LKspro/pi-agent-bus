/**
 * Agent discovery for the agent-bus extension.
 *
 * Scans ~/.pi/agent/agents/ (user/global) and .pi/agents/ (project)
 * for agent definitions stored as .md files with YAML frontmatter.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

interface RawFrontmatter {
  name?: string;
  description?: string;
  model?: string;
  tools?: string;
}

function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: AgentConfig[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue; // unreadable → skip
    }

    const parsed = parseFrontmatter<RawFrontmatter>(content);
    const fm = parsed.frontmatter;

    if (!fm.name || !fm.description) continue; // mandatory fields missing

    const tools = fm.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    results.push({
      name: fm.name,
      description: fm.description,
      model: fm.model,
      tools,
      systemPrompt: parsed.body,
      source,
      filePath,
    });
  }

  return results;
}

/**
 * Walk up from `cwd` to the filesystem root looking for `.pi/agents/`.
 * Returns the first match, or `null`.
 */
function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = path.resolve(cwd);
  const root = path.parse(current).root;
  while (true) {
    const candidate = path.join(current, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // doesn't exist at this level
    }
    if (current === root) break;
    current = path.dirname(current);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function discoverAgents(cwd: string): AgentConfig[] {
  // 1. User (global) agents
  const userDir = path.join(getAgentDir(), "agents");
  const userAgents = loadAgentsFromDir(userDir, "user");

  // 2. Project agents
  const projectDir = findNearestProjectAgentsDir(cwd);
  const projectAgents = projectDir
    ? loadAgentsFromDir(projectDir, "project")
    : [];

  // 3. Merge — project overrides user by name
  const map = new Map<string, AgentConfig>();
  for (const a of userAgents) map.set(a.name, a);
  for (const a of projectAgents) map.set(a.name, a);

  return Array.from(map.values());
}

export function findAgent(
  cwd: string,
  name: string,
): AgentConfig | undefined {
  return discoverAgents(cwd).find((a) => a.name === name);
}

export function getAgentNames(cwd: string): string[] {
  return discoverAgents(cwd).map((a) => a.name);
}
