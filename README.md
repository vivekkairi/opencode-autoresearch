# opencode-autoresearch

Autonomous experiment loop plugin for OpenCode, inspired by:

- `karpathy/autoresearch`
- `davebcn87/pi-autoresearch`

This plugin adds reusable experiment tools for OpenCode:

- `init_experiment`
- `run_experiment`
- `log_experiment`
- `autoresearch_status`
- `autoresearch_clear`

It also injects helper slash commands:

- `/autoresearch`
- `/autoresearch-status`
- `/autoresearch-clear`

State is persisted to `autoresearch.jsonl` in the current project directory.

## Install

1. Install dependencies and build:

```bash
npm install
npm run build
npm run smoke
```

2. Publish to npm (or use local linking) and add to OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-autoresearch"]
}
```

3. (Optional) copy the included skill:

```bash
mkdir -p ~/.config/opencode/skills/autoresearch-create
cp skills/autoresearch-create/SKILL.md ~/.config/opencode/skills/autoresearch-create/SKILL.md
```

## Workflow

1. Start with `/autoresearch <goal>`.
2. Agent calls `init_experiment` once.
3. Each run uses `run_experiment` then `log_experiment`.
4. Keep improvements with `status=keep` (auto-commit enabled).
5. Use `/autoresearch-status` to inspect progress.

## Notes

- `keep` is blocked when `autoresearch.checks.sh` fails.
- Plugin supports bounded auto-resume on `session.idle`.
- OpenCode does not expose pi-style always-on widgets, so status is command/tool based.
