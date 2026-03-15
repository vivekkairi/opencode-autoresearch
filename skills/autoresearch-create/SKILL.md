---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any optimization target in OpenCode using init_experiment, run_experiment, and log_experiment.
---

# Autoresearch

Autonomous experiment loop: try ideas, keep what works, discard what does not, repeat.

## Tools

- `init_experiment` - configure session name, primary metric, unit, and direction.
- `run_experiment` - run benchmark command with timeout and optional checks.
- `log_experiment` - record outcome and auto-commit when status is `keep`.
- `autoresearch_status` - show current progress summary.
- `autoresearch_clear` - clear state file.

## Setup

1. Infer or ask for objective, benchmark command, primary metric, direction, constraints.
2. Read relevant source files before changing anything.
3. Create/update `autoresearch.md` to capture scope, constraints, and experiments.
4. Create/update `autoresearch.sh` benchmark script that emits stable metric output.
5. Call `init_experiment` once.
6. Run baseline with `run_experiment`, then record with `log_experiment`.

## Loop

Repeat:

1. Implement one experimental idea.
2. Run benchmark with `run_experiment`.
3. Record with `log_experiment`.
4. If primary metric improves, use `keep`; otherwise `discard`.
5. For crashes or failed checks, use `crash` or `checks_failed` and move on.

## Rules

- Primary metric decides keep/discard by default.
- Simpler code wins when metric impact is similar.
- Do not keep runs when checks failed.
- Keep writing high-value deferred ideas to `autoresearch.ideas.md`.
- Resume from `autoresearch.jsonl` and `autoresearch.md` after interruptions.
