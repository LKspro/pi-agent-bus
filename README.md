# pi-agent-bus

File-based inter-agent communication bus for [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Multiple pi interactive sessions in separate terminal panes communicate via filesystem mailboxes — **the filesystem IS the network.**

## Features

- **send_to tool** — LLM-callable tool for task delegation, results, questions, and replies
- **Auto-result** — agents automatically send results back when completing a task
- **6 commands** — `/agent`, `/agents`, `/agent-bus`, `/peers`, `/delegate`, and the `send_to` tool
- **Manual mode** — kill-switch to block agent-to-agent delegation
- **Agent discovery** — scan `~/.pi/agent/agents/` (global) and `.pi/agents/` (project) for agent .md definitions
- **Atomic delivery** — temp file + rename for crash-safe message delivery
- **Duplicate guard** — `.processing` lock files prevent double-processing in same-agent panes

## Quick Start

```bash
# Install
pi install github:LKspro/pi-agent-bus

# Install companion memory extension (recommended)
pi install pi-hermes-memory
```

For agent memory that survives sessions, install [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) alongside agent-bus.

## Agent Definitions

Create agent `.md` files with YAML frontmatter:

```markdown
---
name: worker
description: Implementation agent — writes and edits code
tools: read, grep, find, ls, bash, edit, write, send_to
---

# Worker Agent

You are a worker agent. Your job is to implement changes.

## Rules
- Follow existing codebase patterns
- Use `send_to` to report results back to the orchestrator
```

**Locations:**
- `~/.pi/agent/agents/*.md` — global (all projects)
- `.pi/agents/*.md` — project-local (overrides globals by name)

## Launching an Agent Team

```bash
# Pane 1 — Orchestrator
pi --name orchestrator

# Pane 2 — Worker
pi --session .pi/sessions/worker.jsonl --name worker

# Pane 3 — Reviewer
pi --session .pi/sessions/reviewer.jsonl --name reviewer
```

Use `/agents` to list all available agents with copy-paste launch commands.

## Commands

| Command | Description |
|---|---|
| `/agent <name>` | Activate this pane as a specific agent |
| `/agents` | List all agents with launch commands |
| `/agent-bus init` | Scaffold project agent structure |
| `/agent-bus manual` | Toggle manual mode (block delegation) |
| `/agent-bus launch` | Generate Windows Terminal multi-pane launch script |
| `/peers` | Show active agents and pending messages |
| `/delegate <agent> <task>` | Send a task to another agent |

## Tools

| Tool | Description |
|---|---|
| `send_to` | Send message: `to=<name>`, `type=<task\|result\|question\|reply>`, `body=<content>` |

## Message Flow

```
Agent A (orchestrator)
  ├─ send_to(to="worker", type="task", body="...")
  │   → writes .pi/mailbox/worker/<ts>-<id>.json
  │
Agent B (worker) — FS watch on own mailbox
  ├─ Detects new .json, processes it
  ├─ LLM executes task
  ├─ agent_end fires → auto-sends result back
  │   → writes .pi/mailbox/orchestrator/<ts>-<id>.json
  │
Agent A receives result, can continue
```

## Manual Mode

```bash
# Block agent-to-agent delegation:
touch .pi/agent-bus-manual

# Re-enable:
rm .pi/agent-bus-manual

# Or toggle via command:
/agent-bus manual
```

## Requirements

- pi coding agent >= 0.74.0
- [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) (recommended for persistent project memory)
