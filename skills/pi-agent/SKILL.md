---
name: pi-agent
description: Delegate work to Pi child agents (Claude and other non-Gemini models) that run in their own Rex panes, using the `pi-agent` command. Use when the user asks you to orchestrate, delegate, or run work in parallel on Claude or other Pi models. For Gemini workers, use your own invoke_subagent instead.
---

# pi-agent: Pi child agents from Antigravity

`pi-agent` starts interactive Pi agents in Rex panes. The user can watch and
steer them. It works only in an Antigravity session inside Pi
(`PI_AG_BRIDGE` is set).

## Rules

- Every child needs `--model` with a non-Antigravity model, for example
  `claude-code/claude-opus-5-5` or `claude-code/claude-sonnet-5`.
  `antigravity/*` models are refused. For Gemini workers, use
  `invoke_subagent`.
- Put everything the child needs in its task. It does not see this
  conversation.
- At most 6 children at once.

## Flow

1. Write the task to a file, then start the child (returns at once):

   ```sh
   pi-agent start tests-a --model claude-code/claude-opus-5-5 --title "Fix auth tests" --task-file /tmp/tests-a.md
   ```

   Add `--worktree` to give the child its own git worktree on branch
   `agent/<name>`.

2. Run the wait **as a background command**, so you get control back and
   are woken when it exits:

   ```sh
   pi-agent wait tests-a
   ```

   It prints the child's final reply. Exit code 3 means it timed out
   (`--timeout` seconds, default 3600) and the child still runs: wait again.

3. Read the reply, then continue: start more children, fix problems, or
   `pi-agent send tests-a "<follow-up>"` and wait again.

4. Stop children you no longer need: `pi-agent stop tests-a`.

`pi-agent status [name]` shows the children and their state. A child that
waits for the user ("blocked") needs the user; tell them.
