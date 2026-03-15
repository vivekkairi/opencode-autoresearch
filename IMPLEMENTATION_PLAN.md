# OpenCode Autoresearch Plugin - Implementation Plan

## Goal

Implement Karpathy-style autonomous experiment loops as an OpenCode plugin, using pi-autoresearch behavior as the reference.

## Scope

1. Build a reusable OpenCode plugin package with custom tools for experiment automation.
2. Preserve session state in `autoresearch.jsonl` so runs survive restarts/compaction.
3. Provide command-based UX for start/resume/status/reset in OpenCode.
4. Add a companion skill and documentation for setup and workflows.

## Step 1 - Project Scaffolding

1. Create plugin package structure (`package.json`, `tsconfig.json`, `src/index.ts`).
2. Add build/typecheck scripts and dependency on `@opencode-ai/plugin`.
3. Set package exports to built `dist/index.js`.

## Step 2 - Core Runtime Model

1. Define experiment state and result types:
   - primary metric config
   - run records
   - segment/config boundaries for re-init
2. Implement JSONL persistence helpers:
   - read existing state on demand
   - append config entries
   - append run entries
   - safely handle malformed lines

## Step 3 - Tool Implementations

Implement the three core tools:

1. `init_experiment`
   - configure name, metric, unit, direction
   - append config entry to `autoresearch.jsonl`
   - reset current segment baseline
2. `run_experiment`
   - execute command with timeout
   - collect duration/exit code/output tail
   - optionally run `autoresearch.checks.sh` with separate timeout
   - return structured status (`passed`, `timedOut`, `checks_failed`)
3. `log_experiment`
   - validate status and metrics
   - block `keep` when checks failed
   - append run result to JSONL
   - auto-commit when status=`keep`

## Step 4 - OpenCode Hooks and Commands

1. Add plugin `config` hook to inject slash commands:
   - `/autoresearch`
   - `/autoresearch-status`
   - `/autoresearch-clear`
2. Add `experimental.chat.system.transform` hook:
   - if autoresearch mode is active, inject lightweight loop guardrails
   - reference `autoresearch.md` when present
3. Add `experimental.session.compacting` hook:
   - preserve loop continuity instructions across compaction
4. Add `event` handling for bounded auto-resume on `session.idle`:
   - cooldown window
   - max auto-resume turns
   - only resume if experiments have run in that session

## Step 5 - Skill and Docs

1. Add `skills/autoresearch-create/SKILL.md` tuned for OpenCode.
2. Write `README.md` with:
   - install instructions
   - tool reference
   - command workflow
   - state files and recovery behavior
   - differences vs pi-autoresearch UI widget model

## Step 6 - Validation

1. Run install/build/typecheck locally.
2. Validate core flows in a sample project:
   - baseline init + run + log
   - keep auto-commit
   - checks-failed gating
   - status/reset commands
3. Verify no cloned reference repos are tracked due to `.gitignore`.
