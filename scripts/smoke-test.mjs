import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { AutoresearchPlugin } from "../dist/index.js";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Smoke Tester",
      GIT_AUTHOR_EMAIL: "smoke@test.local",
      GIT_COMMITTER_NAME: "Smoke Tester",
      GIT_COMMITTER_EMAIL: "smoke@test.local",
    },
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return result.stdout.trim();
}

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "opencode-autoresearch-smoke-"));
  run("git", ["init"], tempRoot);

  writeFileSync(path.join(tempRoot, "README.md"), "# Smoke test\n", "utf8");
  run("git", ["add", "README.md"], tempRoot);
  run("git", ["commit", "-m", "init"], tempRoot);

  const mockClient = {
    session: {
      get: async () => ({ data: { directory: tempRoot } }),
      promptAsync: async () => ({ data: undefined }),
    },
  };

  const plugin = await AutoresearchPlugin({ client: mockClient });
  assert(plugin.tool, "plugin should expose tools");

  const ctx = {
    sessionID: "smoke-session",
    directory: tempRoot,
    abort: new AbortController().signal,
    metadata() {
      return;
    },
  };

  const initOut = await plugin.tool.init_experiment.execute(
    {
      name: "smoke",
      metric_name: "val_bpb",
      metric_unit: "",
      direction: "lower",
    },
    ctx,
  );
  assert.match(initOut, /Initialized|Re-initialized/);

  const runOut = await plugin.tool.run_experiment.execute(
    {
      command: "node -e \"console.log('benchmark pass')\"",
      timeout_seconds: 30,
    },
    ctx,
  );
  assert.match(runOut, /PASSED/);

  writeFileSync(path.join(tempRoot, "work.txt"), "trial 1\n", "utf8");
  const logKeep = await plugin.tool.log_experiment.execute(
    {
      commit: "0000000",
      metric: 1.234,
      status: "keep",
      description: "smoke keep run",
      metrics: { compile_ms: 42 },
      force: true,
    },
    ctx,
  );
  assert.match(logKeep, /Logged run #/);
  assert.match(logKeep, /Git:/);

  const commitCount = Number.parseInt(run("git", ["rev-list", "--count", "HEAD"], tempRoot), 10);
  assert(commitCount >= 2, "expected keep run to create a commit");

  writeFileSync(
    path.join(tempRoot, "autoresearch.checks.sh"),
    "#!/bin/bash\nset -euo pipefail\necho checks failing\nexit 1\n",
    "utf8",
  );
  run("chmod", ["+x", path.join(tempRoot, "autoresearch.checks.sh")], tempRoot);

  const runFailChecks = await plugin.tool.run_experiment.execute(
    {
      command: "node -e \"console.log('benchmark still passes')\"",
      timeout_seconds: 30,
      checks_timeout_seconds: 30,
    },
    ctx,
  );
  assert.match(runFailChecks, /CHECKS FAILED|checks_failed/i);

  const blockedKeep = await plugin.tool.log_experiment.execute(
    {
      commit: "1111111",
      metric: 1.2,
      status: "keep",
      description: "should be blocked",
      metrics: { compile_ms: 41 },
    },
    ctx,
  );
  assert.match(blockedKeep, /cannot keep this run because autoresearch\.checks\.sh failed/i);

  const logChecksFailed = await plugin.tool.log_experiment.execute(
    {
      commit: "1111111",
      metric: 1.2,
      status: "checks_failed",
      description: "checks failed as expected",
      metrics: { compile_ms: 41 },
    },
    ctx,
  );
  assert.match(logChecksFailed, /Logged run #/);

  const statusOut = await plugin.tool.autoresearch_status.execute({}, ctx);
  assert.match(statusOut, /Autoresearch status:/);
  assert.match(statusOut, /Runs \(segment\):/);

  const statePath = path.join(tempRoot, "autoresearch.jsonl");
  assert(existsSync(statePath), "state file should exist before clear");
  const stateBeforeClear = readFileSync(statePath, "utf8").trim().split("\n");
  assert(stateBeforeClear.length >= 3, "state should include config + runs");

  const clearOut = await plugin.tool.autoresearch_clear.execute({ remove_aux_files: false }, ctx);
  assert.match(clearOut, /Cleared/);
  assert(!existsSync(statePath), "state file should be removed after clear");

  console.log("Smoke test passed");
  console.log(`Workspace: ${tempRoot}`);
}

main().catch((error) => {
  console.error("Smoke test failed");
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
