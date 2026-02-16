# Agent Runner

> [!WARNING]
> This is deprecated! I had good success with this, but you should probably use something like [Goose](https://block.github.io/goose). It was fun to build this but Goose basically adopts a lot of these paradigms and more.

# Why Deprecated?

I mentioned in [my blog post for decompilation](https://stephenjayakar.com/posts/magic-decomp/) that being able to run an agent non-stop was the key differentiator for decompilation. It turns out that this reduces to two well-known paradigms in LLM scaffolding right now, which Goose supports:
* [Ralph loops](https://block.github.io/goose/docs/tutorials/ralph-loop/): Basically running the AI in a loop over and over again with a PLAN. While I came up with this myself independently, it's not super novel. It's nice to have the tooling that Goose already has.
* Parallel subagents.

# Archive

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
