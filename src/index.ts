import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

type Direction = "lower" | "higher";
type RunStatus = "keep" | "discard" | "crash" | "checks_failed";

interface ExperimentResult {
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: RunStatus;
  description: string;
  timestamp: number;
  segment: number;
}

interface ExperimentState {
  results: ExperimentResult[];
  bestMetric: number | null;
  bestDirection: Direction;
  metricName: string;
  metricUnit: string;
  secondaryMetrics: string[];
  name: string | null;
  currentSegment: number;
}

interface SessionRuntime {
  autoresearchMode: boolean;
  experimentsSinceResume: number;
  autoResumeTurns: number;
  lastAutoResumeAt: number;
  lastRunChecks: {
    pass: boolean;
    output: string;
    duration: number;
  } | null;
  directory?: string;
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_CHECKS_TIMEOUT_SECONDS = 300;
const MAX_TAIL_LINES = 80;
const MAX_CAPTURE_BYTES = 2_000_000;
const AUTORESUME_COOLDOWN_MS = 5 * 60 * 1000;
const AUTORESUME_MAX_TURNS = 20;
const BENCHMARK_GUARDRAIL =
  "Be careful not to overfit to benchmarks and do not cheat on benchmarks.";

function nowMs(): number {
  return Date.now();
}

function stateFilePath(directory: string): string {
  return path.join(directory, "autoresearch.jsonl");
}

function rulesFilePath(directory: string): string {
  return path.join(directory, "autoresearch.md");
}

function ideasFilePath(directory: string): string {
  return path.join(directory, "autoresearch.ideas.md");
}

function checksFilePath(directory: string): string {
  return path.join(directory, "autoresearch.checks.sh");
}

function defaultState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
  };
}

function isBetter(current: number, best: number, direction: Direction): boolean {
  return direction === "lower" ? current < best : current > best;
}

function formatNum(value: number | null, unit: string): string {
  if (value === null) return "-";
  const suffix = unit ? unit : "";
  if (Number.isInteger(value)) return `${value}${suffix}`;
  return `${value.toFixed(6)}${suffix}`;
}

function tailLines(input: string, count: number = MAX_TAIL_LINES): string {
  const lines = input.split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function inferMetricUnit(metricName: string): string {
  if (metricName.includes("_us") || metricName.includes("us")) return "us";
  if (metricName.includes("_ms") || metricName.includes("ms")) return "ms";
  if (metricName.includes("_s") || metricName.includes("sec")) return "s";
  if (metricName.includes("kb") || metricName.includes("_kb")) return "kb";
  if (metricName.includes("mb") || metricName.includes("_mb")) return "mb";
  return "";
}

function getCurrentResults(state: ExperimentState): ExperimentResult[] {
  return state.results.filter((run) => run.segment === state.currentSegment);
}

function baselineForCurrentSegment(state: ExperimentState): number | null {
  const current = getCurrentResults(state);
  if (current.length === 0) return null;
  return current[0].metric;
}

function bestKeptForCurrentSegment(state: ExperimentState): ExperimentResult | null {
  let best: ExperimentResult | null = null;
  for (const run of getCurrentResults(state)) {
    if (run.status !== "keep" || run.metric <= 0) continue;
    if (!best || isBetter(run.metric, best.metric, state.bestDirection)) {
      best = run;
    }
  }
  return best;
}

function knownSecondaryMetricsForCurrentSegment(state: ExperimentState): Set<string> {
  const names = new Set<string>();
  for (const run of getCurrentResults(state)) {
    for (const key of Object.keys(run.metrics || {})) {
      names.add(key);
    }
  }
  return names;
}

function loadState(directory: string): ExperimentState {
  const state = defaultState();
  const file = stateFilePath(directory);

  if (!fs.existsSync(file)) {
    return state;
  }

  let segment = 0;
  let seenConfig = false;

  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed?.type === "config") {
      if (seenConfig || state.results.length > 0) {
        segment += 1;
      }
      seenConfig = true;
      state.currentSegment = segment;
      if (typeof parsed.name === "string") state.name = parsed.name;
      if (typeof parsed.metricName === "string") state.metricName = parsed.metricName;
      if (typeof parsed.metricUnit === "string") state.metricUnit = parsed.metricUnit;
      if (parsed.bestDirection === "lower" || parsed.bestDirection === "higher") {
        state.bestDirection = parsed.bestDirection;
      }
      continue;
    }

    const runSegment = Number.isInteger(parsed?.segment) ? parsed.segment : segment;
    const run: ExperimentResult = {
      commit: typeof parsed?.commit === "string" ? parsed.commit : "",
      metric: typeof parsed?.metric === "number" ? parsed.metric : 0,
      metrics:
        parsed?.metrics && typeof parsed.metrics === "object" ? parsed.metrics : {},
      status:
        parsed?.status === "keep" ||
        parsed?.status === "discard" ||
        parsed?.status === "crash" ||
        parsed?.status === "checks_failed"
          ? parsed.status
          : "discard",
      description:
        typeof parsed?.description === "string" ? parsed.description : "(no description)",
      timestamp: typeof parsed?.timestamp === "number" ? parsed.timestamp : 0,
      segment: runSegment,
    };

    state.results.push(run);
    if (run.segment > state.currentSegment) {
      state.currentSegment = run.segment;
    }
  }

  state.bestMetric = baselineForCurrentSegment(state);
  state.secondaryMetrics = [...knownSecondaryMetricsForCurrentSegment(state)];

  return state;
}

function appendJsonl(directory: string, entry: Record<string, unknown>): void {
  const file = stateFilePath(directory);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

async function runProcess(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  abort: AbortSignal,
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const append = (existing: string, data: Buffer | string): string => {
      if (existing.length >= MAX_CAPTURE_BYTES) return existing;
      const chunk = typeof data === "string" ? data : data.toString("utf8");
      const remaining = MAX_CAPTURE_BYTES - existing.length;
      return existing + chunk.slice(0, remaining);
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    const killHard = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // noop
      }
    };

    const killSoft = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // noop
      }
      setTimeout(killHard, 2000);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killSoft();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killSoft();
    };

    abort.addEventListener("abort", onAbort);

    const finish = (code: number | null): void => {
      clearTimeout(timeout);
      abort.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        aborted,
      });
    };

    child.on("error", (error) => {
      stderr = append(stderr, `\n${String(error)}`);
      finish(1);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}

function statusSummary(state: ExperimentState): string {
  const current = getCurrentResults(state);
  const kept = current.filter((run) => run.status === "keep").length;
  const discarded = current.filter((run) => run.status === "discard").length;
  const crashed = current.filter((run) => run.status === "crash").length;
  const checksFailed = current.filter((run) => run.status === "checks_failed").length;
  const baseline = state.bestMetric;
  const best = bestKeptForCurrentSegment(state);

  const lines = [
    `Autoresearch status: ${current.length > 0 ? "active" : "initialized"}`,
    `Session: ${state.name ?? "(unnamed)"}`,
    `Metric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)`,
    `Current segment: ${state.currentSegment}`,
    `Runs (segment): ${current.length} total | ${kept} kept | ${discarded} discarded | ${crashed} crashed | ${checksFailed} checks_failed`,
    `Baseline: ${formatNum(baseline, state.metricUnit)}`,
    `Best kept: ${best ? `${formatNum(best.metric, state.metricUnit)} (${best.commit})` : "none yet"}`,
  ];

  if (best && baseline !== null && baseline !== 0 && best.metric !== baseline) {
    const delta = ((best.metric - baseline) / baseline) * 100;
    const sign = delta > 0 ? "+" : "";
    lines.push(`Delta vs baseline: ${sign}${delta.toFixed(2)}%`);
  }

  return lines.join("\n");
}

export const AutoresearchPlugin: Plugin = async ({ client }) => {
  const sessionRuntime = new Map<string, SessionRuntime>();
  const sessionDirectory = new Map<string, string>();

  const runtimeFor = (sessionID: string): SessionRuntime => {
    const existing = sessionRuntime.get(sessionID);
    if (existing) return existing;
    const created: SessionRuntime = {
      autoresearchMode: false,
      experimentsSinceResume: 0,
      autoResumeTurns: 0,
      lastAutoResumeAt: 0,
      lastRunChecks: null,
    };
    sessionRuntime.set(sessionID, created);
    return created;
  };

  const hydrateRuntimeFromContext = (sessionID: string, directory: string): SessionRuntime => {
    const runtime = runtimeFor(sessionID);
    runtime.directory = directory;
    sessionDirectory.set(sessionID, directory);
    if (fs.existsSync(stateFilePath(directory))) {
      runtime.autoresearchMode = true;
    }
    return runtime;
  };

  const resolveSessionDirectory = async (sessionID: string): Promise<string | undefined> => {
    const cached = sessionDirectory.get(sessionID);
    if (cached) return cached;

    try {
      const result: any = await client.session.get({ path: { id: sessionID } });
      const directory = result?.data?.directory;
      if (typeof directory === "string" && directory.length > 0) {
        sessionDirectory.set(sessionID, directory);
        return directory;
      }
    } catch {
      // ignore
    }

    return undefined;
  };

  const isModeActive = async (sessionID: string): Promise<boolean> => {
    const runtime = runtimeFor(sessionID);
    if (runtime.autoresearchMode) return true;

    const directory = runtime.directory || (await resolveSessionDirectory(sessionID));
    if (!directory) return false;

    if (fs.existsSync(stateFilePath(directory))) {
      runtime.autoresearchMode = true;
      runtime.directory = directory;
      return true;
    }

    return false;
  };

  const initExperimentTool = tool({
    description:
      "Initialize or re-initialize an autoresearch session (name, metric, unit, direction).",
    args: {
      name: tool.schema.string().describe("Human-readable session name"),
      metric_name: tool.schema.string().describe("Primary metric name (for example: val_bpb)"),
      metric_unit: tool.schema
        .string()
        .optional()
        .describe("Primary metric unit (for example: s, ms, kb)"),
      direction: tool.schema
        .enum(["lower", "higher"])
        .optional()
        .describe("Whether lower or higher metric values are better"),
    },
    async execute(args, context) {
      const runtime = hydrateRuntimeFromContext(context.sessionID, context.directory);
      const current = loadState(context.directory);
      const hasPriorState =
        current.results.length > 0 || fs.existsSync(stateFilePath(context.directory));

      const direction: Direction = args.direction ?? "lower";
      const unit = args.metric_unit ?? "";

      appendJsonl(context.directory, {
        type: "config",
        name: args.name,
        metricName: args.metric_name,
        metricUnit: unit,
        bestDirection: direction,
        timestamp: nowMs(),
      });

      runtime.autoresearchMode = true;
      runtime.experimentsSinceResume = 0;
      runtime.lastRunChecks = null;

      context.metadata({
        title: "init_experiment",
        metadata: {
          session: args.name,
          metric: args.metric_name,
          direction,
        },
      });

      const note = hasPriorState
        ? "Re-initialized with a new segment and baseline."
        : "Initialized new autoresearch session.";

      return [
        `OK: ${note}`,
        `Session: ${args.name}`,
        `Metric: ${args.metric_name} (${unit || "unitless"}, ${direction} is better)`,
        `State file: ${stateFilePath(context.directory)}`,
      ].join("\n");
    },
  });

  const runExperimentTool = tool({
    description:
      "Run a benchmark command with timeout and capture output tail. Optionally run autoresearch.checks.sh when benchmark passes.",
    args: {
      command: tool.schema.string().describe("Benchmark command to execute"),
      timeout_seconds: tool.schema
        .number()
        .optional()
        .describe(`Benchmark timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS})`),
      checks_timeout_seconds: tool.schema
        .number()
        .optional()
        .describe(
          `Checks timeout in seconds for autoresearch.checks.sh (default ${DEFAULT_CHECKS_TIMEOUT_SECONDS})`,
        ),
    },
    async execute(args, context) {
      const runtime = hydrateRuntimeFromContext(context.sessionID, context.directory);
      const timeoutMs = Math.max(1, args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

      context.metadata({
        title: "run_experiment",
        metadata: {
          command: args.command,
          timeout_seconds: timeoutMs / 1000,
        },
      });

      const started = nowMs();
      const benchmark = await runProcess(
        "/bin/bash",
        ["-lc", args.command],
        context.directory,
        timeoutMs,
        context.abort,
      );
      const benchmarkDuration = (nowMs() - started) / 1000;
      const benchmarkOutput = `${benchmark.stdout}\n${benchmark.stderr}`.trim();
      const benchmarkPassed = benchmark.code === 0 && !benchmark.timedOut && !benchmark.aborted;

      let checksPass: boolean | null = null;
      let checksTimedOut = false;
      let checksDuration = 0;
      let checksOutput = "";

      const checksFile = checksFilePath(context.directory);
      if (benchmarkPassed && fs.existsSync(checksFile)) {
        const checksTimeoutMs =
          Math.max(1, args.checks_timeout_seconds ?? DEFAULT_CHECKS_TIMEOUT_SECONDS) * 1000;
        const checksStart = nowMs();
        const checks = await runProcess(
          "/bin/bash",
          [checksFile],
          context.directory,
          checksTimeoutMs,
          context.abort,
        );
        checksDuration = (nowMs() - checksStart) / 1000;
        checksTimedOut = checks.timedOut;
        checksPass = checks.code === 0 && !checks.timedOut && !checks.aborted;
        checksOutput = `${checks.stdout}\n${checks.stderr}`.trim();
      }

      runtime.lastRunChecks =
        checksPass === null
          ? null
          : {
              pass: checksPass,
              output: checksOutput,
              duration: checksDuration,
            };

      const overallPassed = benchmarkPassed && (checksPass === null || checksPass);
      const lines: string[] = [];

      if (benchmark.timedOut) {
        lines.push(`TIMEOUT after ${benchmarkDuration.toFixed(1)}s`);
      } else if (benchmark.aborted) {
        lines.push(`ABORTED after ${benchmarkDuration.toFixed(1)}s`);
      } else if (!benchmarkPassed) {
        lines.push(`FAILED (exit ${benchmark.code}) in ${benchmarkDuration.toFixed(1)}s`);
      } else if (checksTimedOut) {
        lines.push(`BENCHMARK PASSED in ${benchmarkDuration.toFixed(1)}s`);
        lines.push(`CHECKS TIMEOUT in ${checksDuration.toFixed(1)}s`);
        lines.push("Log this run as status='checks_failed'.");
      } else if (checksPass === false) {
        lines.push(`BENCHMARK PASSED in ${benchmarkDuration.toFixed(1)}s`);
        lines.push(`CHECKS FAILED in ${checksDuration.toFixed(1)}s`);
        lines.push("Log this run as status='checks_failed'.");
      } else {
        lines.push(`PASSED in ${benchmarkDuration.toFixed(1)}s`);
        if (checksPass === true) {
          lines.push(`Checks passed in ${checksDuration.toFixed(1)}s`);
        }
      }

      const state = loadState(context.directory);
      if (state.bestMetric !== null) {
        lines.push(
          `Current baseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`,
        );
      }
      lines.push(`Overall status: ${overallPassed ? "pass" : "fail"}`);

      lines.push("", `Last ${MAX_TAIL_LINES} benchmark log lines:`, tailLines(benchmarkOutput));

      if (checksPass === false || checksTimedOut) {
        lines.push("", `Last ${MAX_TAIL_LINES} checks log lines:`, tailLines(checksOutput));
      }

      return lines.join("\n");
    },
  });

  const logExperimentTool = tool({
    description:
      "Log an experiment result to autoresearch.jsonl. keep auto-commits staged changes; keep is blocked when checks failed.",
    args: {
      commit: tool.schema.string().describe("Current git commit hash (short hash preferred)"),
      metric: tool.schema.number().describe("Primary metric value (0 for crashes)"),
      status: tool.schema
        .enum(["keep", "discard", "crash", "checks_failed"])
        .describe("Experiment decision status"),
      description: tool.schema.string().describe("Short experiment description"),
      metrics: tool.schema
        .record(tool.schema.string(), tool.schema.number())
        .optional()
        .describe("Secondary metrics map (for example: { peak_vram_mb: 12345 })"),
      force: tool.schema
        .boolean()
        .optional()
        .describe("Allow adding newly introduced secondary metrics"),
    },
    async execute(args, context) {
      const runtime = hydrateRuntimeFromContext(context.sessionID, context.directory);
      const state = loadState(context.directory);
      const currentRuns = getCurrentResults(state);
      const providedMetrics = args.metrics ?? {};

      if (args.status === "keep" && runtime.lastRunChecks && !runtime.lastRunChecks.pass) {
        return [
          "ERROR: cannot keep this run because autoresearch.checks.sh failed.",
          "Use status='checks_failed' for this run.",
          "",
          `Checks output tail:\n${tailLines(runtime.lastRunChecks.output)}`,
        ].join("\n");
      }

      const knownMetrics = knownSecondaryMetricsForCurrentSegment(state);
      if (knownMetrics.size > 0) {
        const missing = [...knownMetrics].filter((name) => !(name in providedMetrics));
        if (missing.length > 0) {
          return [
            `ERROR: missing secondary metrics: ${missing.join(", ")}`,
            `Expected metrics: ${[...knownMetrics].join(", ")}`,
            "Provide all previously tracked secondary metrics in the metrics argument.",
          ].join("\n");
        }

        const newMetrics = Object.keys(providedMetrics).filter((name) => !knownMetrics.has(name));
        if (newMetrics.length > 0 && !args.force) {
          return [
            `ERROR: new secondary metrics detected: ${newMetrics.join(", ")}`,
            "If these metrics are intentionally added, call log_experiment again with force=true.",
          ].join("\n");
        }
      }

      const run: ExperimentResult = {
        commit: args.commit.slice(0, 7),
        metric: args.metric,
        metrics: providedMetrics,
        status: args.status,
        description: args.description,
        timestamp: nowMs(),
        segment: state.currentSegment,
      };

      let gitLine = "Git: skipped auto-commit";
      if (args.status === "keep") {
        const add = await runProcess(
          "git",
          ["add", "-A"],
          context.directory,
          15000,
          context.abort,
        );

        if (add.code !== 0) {
          gitLine = `Git: add failed (${add.code})`; 
        } else {
          const diff = await runProcess(
            "git",
            ["diff", "--cached", "--quiet"],
            context.directory,
            10000,
            context.abort,
          );

          if (diff.code === 0) {
            gitLine = "Git: nothing to commit (working tree clean)";
          } else {
            const resultData: Record<string, unknown> = {
              status: args.status,
              [state.metricName || "metric"]: args.metric,
              ...providedMetrics,
            };
            const commitMessage = `${args.description}\n\nResult: ${JSON.stringify(resultData)}`;
            const commit = await runProcess(
              "git",
              ["commit", "-m", commitMessage],
              context.directory,
              15000,
              context.abort,
            );

            if (commit.code === 0) {
              const sha = await runProcess(
                "git",
                ["rev-parse", "--short=7", "HEAD"],
                context.directory,
                5000,
                context.abort,
              );
              const parsedSha = sha.stdout.trim();
              if (parsedSha.length >= 7) {
                run.commit = parsedSha.slice(0, 7);
              }
              const firstLine = tailLines(`${commit.stdout}\n${commit.stderr}`, 1);
              gitLine = `Git: committed (${firstLine})`;
            } else {
              gitLine = `Git: commit failed (${commit.code})`;
            }
          }
        }
      }

      appendJsonl(context.directory, {
        type: "run",
        run: state.results.length + 1,
        ...run,
      });

      runtime.lastRunChecks = null;
      runtime.autoresearchMode = true;
      runtime.experimentsSinceResume += 1;

      const updated = loadState(context.directory);
      const baseline = updated.bestMetric;
      const lines = [
        `Logged run #${updated.results.length}: ${run.status} - ${run.description}`,
        `Baseline ${updated.metricName}: ${formatNum(baseline, updated.metricUnit)}`,
      ];

      if (Object.keys(run.metrics).length > 0) {
        const secondary = Object.entries(run.metrics)
          .map(([name, value]) => `${name}=${formatNum(value, inferMetricUnit(name))}`)
          .join(" ");
        lines.push(`Secondary metrics: ${secondary}`);
      }

      lines.push(gitLine);
      lines.push(`State file: ${stateFilePath(context.directory)}`);

      context.metadata({
        title: "log_experiment",
        metadata: {
          status: run.status,
          metric: run.metric,
          commit: run.commit,
        },
      });

      return lines.join("\n");
    },
  });

  const statusTool = tool({
    description: "Show autoresearch progress summary for the current project.",
    args: {},
    async execute(_args, context) {
      const runtime = hydrateRuntimeFromContext(context.sessionID, context.directory);
      const file = stateFilePath(context.directory);
      if (!fs.existsSync(file)) {
        return `No autoresearch state found at ${file}`;
      }

      const state = loadState(context.directory);
      const lines = [statusSummary(state), `State file: ${file}`];
      if (fs.existsSync(rulesFilePath(context.directory))) {
        lines.push(`Rules file: ${rulesFilePath(context.directory)}`);
      }
      if (fs.existsSync(ideasFilePath(context.directory))) {
        lines.push(`Ideas file: ${ideasFilePath(context.directory)}`);
      }
      lines.push(`Mode: ${runtime.autoresearchMode ? "on" : "off"}`);
      return lines.join("\n");
    },
  });

  const clearTool = tool({
    description: "Clear autoresearch state in the current project.",
    args: {
      remove_aux_files: tool.schema
        .boolean()
        .optional()
        .describe("Also remove autoresearch.md, autoresearch.sh, and autoresearch.ideas.md"),
    },
    async execute(args, context) {
      const runtime = hydrateRuntimeFromContext(context.sessionID, context.directory);
      const removed: string[] = [];
      const file = stateFilePath(context.directory);

      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(file);
      }

      if (args.remove_aux_files) {
        const aux = [
          rulesFilePath(context.directory),
          path.join(context.directory, "autoresearch.sh"),
          path.join(context.directory, "autoresearch.checks.sh"),
          ideasFilePath(context.directory),
        ];
        for (const entry of aux) {
          if (fs.existsSync(entry)) {
            fs.unlinkSync(entry);
            removed.push(entry);
          }
        }
      }

      runtime.autoresearchMode = false;
      runtime.experimentsSinceResume = 0;
      runtime.autoResumeTurns = 0;
      runtime.lastRunChecks = null;

      if (removed.length === 0) {
        return "Nothing to clear.";
      }

      return `Cleared ${removed.length} file(s):\n${removed.map((entry) => `- ${entry}`).join("\n")}`;
    },
  });

  return {
    tool: {
      init_experiment: initExperimentTool,
      run_experiment: runExperimentTool,
      log_experiment: logExperimentTool,
      autoresearch_status: statusTool,
      autoresearch_clear: clearTool,
    },

    async config(config) {
      const cfg = config as any;
      cfg.command = cfg.command ?? {};

      if (!cfg.command.autoresearch) {
        cfg.command.autoresearch = {
          description: "Start or resume autonomous experiment loop",
          template: [
            "Start or resume autoresearch for: $ARGUMENTS",
            "",
            "If this is a new session:",
            "1) infer objective, command, metric, and direction",
            "2) create/update autoresearch.md and autoresearch.sh",
            "3) call init_experiment exactly once",
            "4) run baseline via run_experiment and log_experiment",
            "",
            "Then continue the loop autonomously:",
            "- modify code",
            "- run_experiment",
            "- log_experiment",
            "- keep if primary metric improves, otherwise discard",
            "",
            BENCHMARK_GUARDRAIL,
          ].join("\n"),
        };
      }

      if (!cfg.command["autoresearch-status"]) {
        cfg.command["autoresearch-status"] = {
          description: "Show autoresearch status",
          template: "Call autoresearch_status and return a concise summary.",
        };
      }

      if (!cfg.command["autoresearch-clear"]) {
        cfg.command["autoresearch-clear"] = {
          description: "Clear autoresearch state",
          template:
            "Call autoresearch_clear to reset autoresearch.jsonl in the current project and confirm what was removed.",
        };
      }
    },

    async event({ event }) {
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id;
        sessionRuntime.delete(sessionID);
        sessionDirectory.delete(sessionID);
        return;
      }

      if (event.type === "command.executed") {
        const runtime = runtimeFor(event.properties.sessionID);
        const name = event.properties.name;
        if (name === "autoresearch") {
          runtime.autoresearchMode = true;
          runtime.autoResumeTurns = 0;
        }
        if (name === "autoresearch-clear") {
          runtime.autoresearchMode = false;
          runtime.autoResumeTurns = 0;
          runtime.experimentsSinceResume = 0;
          runtime.lastRunChecks = null;
        }
        return;
      }

      if (event.type !== "session.idle") {
        return;
      }

      const sessionID = event.properties.sessionID;
      const runtime = runtimeFor(sessionID);
      const active = await isModeActive(sessionID);

      if (!active) return;
      if (runtime.experimentsSinceResume <= 0) return;

      const now = nowMs();
      if (now - runtime.lastAutoResumeAt < AUTORESUME_COOLDOWN_MS) return;
      if (runtime.autoResumeTurns >= AUTORESUME_MAX_TURNS) return;

      const directory = runtime.directory || (await resolveSessionDirectory(sessionID));
      const hasIdeas = directory ? fs.existsSync(ideasFilePath(directory)) : false;

      let message =
        "Autoresearch loop ended (likely context limit). Resume the experiment loop. Read autoresearch.md and recent run history first.";
      if (hasIdeas) {
        message += " Check autoresearch.ideas.md for promising paths and prune stale entries.";
      }
      message += ` ${BENCHMARK_GUARDRAIL}`;

      try {
        await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: "text",
                text: message,
              },
            ],
          },
        });

        runtime.autoResumeTurns += 1;
        runtime.lastAutoResumeAt = now;
        runtime.experimentsSinceResume = 0;
      } catch {
        // ignore resume send failures
      }
    },

    async "experimental.chat.system.transform"(input, output) {
      const sessionID = input.sessionID;
      if (!sessionID) return;

      const active = await isModeActive(sessionID);
      if (!active) return;

      const directory =
        runtimeFor(sessionID).directory || (await resolveSessionDirectory(sessionID));
      const rulesPath = directory ? rulesFilePath(directory) : "autoresearch.md";
      const checksPath = directory ? checksFilePath(directory) : "autoresearch.checks.sh";
      const hasChecks = directory ? fs.existsSync(checksPath) : false;

      const lines = [
        "## Autoresearch Mode (ACTIVE)",
        "Use init_experiment, run_experiment, and log_experiment for autonomous experiment loops.",
        "For every benchmark run, follow run_experiment with log_experiment.",
        `Rules file: ${rulesPath}`,
        BENCHMARK_GUARDRAIL,
      ];

      if (hasChecks) {
        lines.push(
          "Backpressure checks are active via autoresearch.checks.sh; runs with failed checks must be logged as checks_failed and cannot be kept.",
        );
      }

      output.system.push(lines.join("\n"));
    },

    async "experimental.session.compacting"(input, output) {
      const active = await isModeActive(input.sessionID);
      if (!active) return;

      output.context.push(
        [
          "Autoresearch mode is active.",
          "Preserve current objective, benchmark command, metric, best baseline, and keep/discard rationale.",
          "Include enough detail for a fresh agent to continue the experiment loop immediately.",
        ].join("\n"),
      );
    },
  };
};
