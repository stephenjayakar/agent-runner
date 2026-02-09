# Agent Runner

Multi-agent orchestrator for long-running autonomous coding tasks. A planner breaks your goal into parallel tasks, Claude workers execute them, and a judge evaluates results and spawns follow-ups.

Inspired by [Cursor's "Scaling long-running autonomous coding"](https://cursor.com/blog/scaling-agents).

## Quick Start

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

Open http://localhost:5173, enter a target directory and goal, and hit Launch.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `PORT` | `3111` | Backend port |
