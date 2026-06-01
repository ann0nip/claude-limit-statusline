#!/usr/bin/env node
"use strict";

/**
 * claude-limit-statusline
 *
 * A Claude Code status line that shows your REAL subscription rate limits
 * (5-hour session + 7-day weekly) with a live reset countdown.
 *
 * Claude Code pipes a JSON payload on stdin. For Claude.ai Pro/Max
 * subscribers it contains a `rate_limits` object sourced from Anthropic's
 * servers — the same numbers you see in `/usage`. This reads those fields
 * and prints a single status line. It does NOT estimate locally.
 *
 * Docs: https://code.claude.com/docs/en/statusline
 */

const argv = process.argv.slice(2);

// ---------- arg / env helpers ----------
function getFlagValue(key) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === key) {
      const next = argv[i + 1];
      return next && !next.startsWith("--") ? next : "";
    }
    if (a.startsWith(key + "=")) return a.slice(key.length + 1);
  }
  return undefined;
}
function parseList(val) {
  return String(val)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
function numEnv(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

// ---------- config ----------
const ALL_SEGMENTS = ["model", "context", "session", "week"];

// Which segments to show. --segments / CC_LIMITS_SEGMENTS = allowlist (and order).
// Otherwise the full set minus any --no-<segment> flags.
let SEGMENTS;
const segSel = getFlagValue("--segments") || process.env.CC_LIMITS_SEGMENTS;
if (segSel != null && segSel !== "") {
  SEGMENTS = parseList(segSel).filter((s) => ALL_SEGMENTS.includes(s));
} else {
  SEGMENTS = ALL_SEGMENTS.filter((s) => !argv.includes(`--no-${s}`));
}

// Which reset countdowns to show: both | session | week | none.
let RESET_MODE = (
  getFlagValue("--reset") ||
  process.env.CC_LIMITS_RESET ||
  "both"
).toLowerCase();
if (argv.includes("--no-reset")) RESET_MODE = "none";
function showReset(which) {
  return RESET_MODE === "both" || RESET_MODE === which;
}

const WARN_PCT = numEnv("CC_LIMITS_WARN", 70);
const CRIT_PCT = numEnv("CC_LIMITS_CRIT", 90);
const SEP = process.env.CC_LIMITS_SEP || " | ";
const NO_COLOR =
  argv.includes("--no-color") ||
  (process.env.NO_COLOR != null && process.env.NO_COLOR !== "");

// ---------- colors ----------
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
function paint(s, color) {
  if (NO_COLOR || !color) return s;
  return color + s + C.reset;
}
function pctColor(p) {
  if (p >= CRIT_PCT) return C.red;
  if (p >= WARN_PCT) return C.yellow;
  return C.green;
}

// ---------- formatters ----------
const MON = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function pad(n) {
  return String(n).padStart(2, "0");
}
// Strip control chars / ANSI escapes from untrusted string fields before
// printing them to the terminal.
function clean(s) {
  return String(s).replace(/[\x00-\x1f\x7f]/g, "");
}
function round(n) {
  return Math.round(Number(n));
}
function humanTokens(n) {
  n = Number(n) || 0;
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}
function fmtCountdown(epochSec) {
  let diff = Math.floor(epochSec - Date.now() / 1000);
  if (diff < 0) diff = 0;
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h${pad(m)}m`;
}
function fmtClock(epochSec, withDate) {
  const d = new Date(epochSec * 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (withDate) return `${MON[d.getMonth()]} ${pad(d.getDate())} ${time}`;
  return time;
}

// ---------- segment renderers ----------
function renderModel(data) {
  const model = clean(data?.model?.display_name || "Claude");
  return paint("🤖 " + model, C.cyan);
}
function renderContext(data) {
  const cw = data?.context_window || {};
  const tokens =
    (Number(cw.total_input_tokens) || 0) +
    (Number(cw.total_output_tokens) || 0);
  let s = "🧠 " + humanTokens(tokens);
  if (cw.used_percentage != null) s += ` (${round(cw.used_percentage)}%)`;
  return paint(s, C.gray);
}
function renderLimit(limit, { icon, label, which, withDate }) {
  if (!limit || limit.used_percentage == null) {
    return paint(`${icon} ${label} --`, C.dim);
  }
  const p = round(limit.used_percentage);
  let s = `${icon} ${label} ${paint(p + "%", pctColor(p))}`;
  if (limit.resets_at > 0 && showReset(which)) {
    s += paint(
      ` · resets in ${fmtCountdown(limit.resets_at)} (${fmtClock(
        limit.resets_at,
        withDate
      )})`,
      C.dim
    );
  }
  return s;
}

function render(data) {
  const rl = data?.rate_limits || {};
  const out = [];
  for (const seg of SEGMENTS) {
    if (seg === "model") out.push(renderModel(data));
    else if (seg === "context") out.push(renderContext(data));
    else if (seg === "session")
      out.push(
        renderLimit(rl.five_hour, {
          icon: "⏳",
          label: "Session",
          which: "session",
          withDate: false,
        })
      );
    else if (seg === "week")
      out.push(
        renderLimit(rl.seven_day, {
          icon: "📅",
          label: "Week",
          which: "week",
          withDate: true,
        })
      );
  }
  return out.join(SEP);
}

// ---------- demo payload ----------
function demoPayload() {
  const now = Math.floor(Date.now() / 1000);
  return {
    model: { display_name: "Opus 4.8 (1M context)" },
    context_window: {
      used_percentage: 4,
      total_input_tokens: 40000,
      total_output_tokens: 2328,
    },
    rate_limits: {
      five_hour: { used_percentage: 17, resets_at: now + 2880 },
      seven_day: { used_percentage: 10, resets_at: now + 250000 },
    },
  };
}

// ---------- main ----------
function out(line) {
  process.stdout.write(line + "\n");
}

if (argv.includes("--help") || argv.includes("-h")) {
  out(
    [
      "claude-limit-statusline (cc-limits)",
      "",
      "Reads Claude Code's JSON status-line payload on stdin and prints your",
      "real Pro/Max rate limits (5h session + 7d week) with reset countdowns.",
      "",
      "Usage in ~/.claude/settings.json:",
      '  "statusLine": { "type": "command", "command": "cc-limits" }',
      "",
      "Segments (default: all, in this order): model, context, session, week",
      "  --segments=session,week   Show only these, in this order",
      "  --no-context              Hide a single segment (repeatable)",
      "  --no-model --no-week      ...",
      "",
      "Reset countdowns:",
      "  --reset=both|session|week|none   Which resets to show (default both)",
      "  --no-reset                       Same as --reset=none",
      "",
      "Other flags: --demo, --no-color, -h/--help",
      "",
      "Env vars:",
      "  CC_LIMITS_SEGMENTS=model,context,session,week",
      "  CC_LIMITS_RESET=both|session|week|none",
      "  CC_LIMITS_WARN=70    yellow threshold (% of a limit)",
      "  CC_LIMITS_CRIT=90    red threshold",
      "  CC_LIMITS_SEP=' | '  segment separator",
      "  NO_COLOR             disable colors",
    ].join("\n")
  );
  process.exit(0);
}

if (argv.includes("--demo")) {
  out(render(demoPayload()));
  process.exit(0);
}

if (process.stdin.isTTY) {
  out(
    render(demoPayload()) +
      "  " +
      paint("(demo — pipe Claude Code JSON in)", C.dim)
  );
  process.exit(0);
}

const MAX_INPUT = 1 << 20; // 1 MB safety cap on stdin
let input = "";
let done = false;

function finish(raw) {
  if (done) return;
  done = true;
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  out(render(data));
}

// Never hang: if no EOF arrives, render with whatever we have after 2s.
const timer = setTimeout(() => finish(input), 2000);
if (timer.unref) timer.unref();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (input.length < MAX_INPUT) input += chunk;
});
process.stdin.on("error", () => {
  clearTimeout(timer);
  finish("");
});
process.stdin.on("end", () => {
  clearTimeout(timer);
  finish(input);
});
