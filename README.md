# codex-jobs

A Claude Code mod that puts the [Codex CLI](https://github.com/openai/codex) jobs Claude starts in a session into a side pane, drawn like Claude Code's native workflow view.

一个 Claude Code mod：Claude 在会话里通过 Bash 调用 `codex` 时，它会把这些 Codex 任务收进一个侧边面板，样式仿照原生的 workflow 视图。

## What it does / 功能

- **Detects Codex jobs**: any Bash call that gives Codex work — `codex exec`, `codex e`, `codex review`, `codex resume` / `fork`, `codex cloud exec`, bare `codex "prompt"`. It also sees through `nohup`, `timeout`, `env`, `npx @openai/codex`, `bash -lc '…'`, pipes and heredoc prompts. Management commands (`login`, `mcp`, `--help`, …) are ignored.
- **Groups jobs by phase**: each user turn that starts jobs becomes a phase, titled after the prompt. A wide pane shows phases and jobs in two columns.
- **Tracks state**: Running / Completed / Failed / Stopped / Unknown, with duration, token count, tool-call count and model, read from Codex's `--json` events or its plain log.
- **Background jobs**: follows `run_in_background` tasks until their completion notice, and tails the live output file while a job card is open.
- **Job card**: prompt, recent activity (commands Codex ran, file changes, MCP tools, web searches) and the final answer; expand/collapse for long text.
- **Controls**: `stop` / `stop all` (through TaskStop), a status filter, and a **Codex workflow** button in the prompt footer to open or close the pane. The `/codex-jobs` command opens it too.

## Install / 安装

In Claude Code:

```
/plugin marketplace add BlackSlience-Reaper/codex-jobs
/plugin install codex-jobs@codex-jobs
```

Then start a new session (or reload plugins). The pane opens on its own the first time Claude runs a Codex job; after you close it by hand, use the footer button or `/codex-jobs` to bring it back.

在 Claude Code 里执行上面两条命令，然后开新会话即可。第一次有 Codex 任务时面板会自动打开；手动关掉之后，用输入框下方的 **Codex workflow** 按钮或 `/codex-jobs` 再打开。

Requirements / 需要：

- A Claude Code build that supports mods (plugins with `hooks/hooks.json` modules).
- The `codex` CLI on the machine, used by Claude through its Bash tool.

Tip: asking Claude to run `codex exec --json …` gives the richest stats (tokens, tool calls, activity).

## Layout / 目录

```
.claude-plugin/marketplace.json   marketplace entry pointing at the plugin
plugins/codex-jobs/
  .claude-plugin/plugin.json      plugin manifest
  hooks/hooks.json                registers hooks/register.tsx
  hooks/register.tsx              hooks, state and the pane UI
  hooks/parse.ts                  command / output / notification parsing (no engine calls)
  types/index.d.ts                state types
  tests/codex-jobs.test.tsx       tests (claude-code/testing)
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, the engine type stubs that Claude Code's mod tooling generates locally; they are not checked in.

## License

MIT
