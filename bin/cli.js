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

const fs = require("fs");
const path = require("path");
const os = require("os");

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
const ALL_SEGMENTS = ["model", "context", "session", "week", "lights"];
// "lights" (Claude session traffic lights) is opt-in so existing setups keep
// their exact width. Enable with --lights, CC_LIMITS_LIGHTS=1, or --segments.
const DEFAULT_SEGMENTS = ["model", "context", "session", "week"];

// Which segments to show. --segments / CC_LIMITS_SEGMENTS = allowlist (and order).
// Otherwise the default set minus any --no-<segment> flags.
let SEGMENTS;
const segSel = getFlagValue("--segments") || process.env.CC_LIMITS_SEGMENTS;
if (segSel != null && segSel !== "") {
  SEGMENTS = parseList(segSel).filter((s) => ALL_SEGMENTS.includes(s));
} else {
  SEGMENTS = DEFAULT_SEGMENTS.filter((s) => !argv.includes(`--no-${s}`));
  const lightsEnv = process.env.CC_LIMITS_LIGHTS;
  if (argv.includes("--lights") || (lightsEnv != null && lightsEnv !== "" && lightsEnv !== "0")) {
    SEGMENTS.push("lights");
  }
}

// Size preset: how much detail to show. The user picks the one that fits their
// terminal — predictable, no width guessing. Default "medium".
const SIZES = ["full", "medium", "compact", "mini", "bare"];
let SIZE = (
  getFlagValue("--size") ||
  process.env.CC_LIMITS_SIZE ||
  "medium"
).toLowerCase();
if (!SIZES.includes(SIZE)) SIZE = "medium";

// Which reset countdowns are *allowed*: both | session | week | none. This only
// caps what a preset would show (it can hide a countdown, never add one).
// Default both (no extra cap on top of the chosen preset).
let RESET_MODE = (
  getFlagValue("--reset") ||
  process.env.CC_LIMITS_RESET ||
  "both"
).toLowerCase();
if (argv.includes("--no-reset")) RESET_MODE = "none";
function resetAllowed(which) {
  return RESET_MODE === "both" || RESET_MODE === which;
}

// How a reset is rendered: clock ("resets at 20:02", default), countdown
// ("resets in 0h47m"), or both (countdown + clock where the size preset has
// room). Like --reset, this never adds a reset to a size that doesn't show one.
const RESET_STYLES = ["countdown", "clock", "both"];
let RESET_STYLE = (
  getFlagValue("--reset-style") ||
  process.env.CC_LIMITS_RESET_STYLE ||
  "clock"
).toLowerCase();
if (!RESET_STYLES.includes(RESET_STYLE)) RESET_STYLE = "clock";

// Clock format for reset times: 24 (default, "20:02") or 12 ("8:02pm").
const CLOCK_12H =
  (getFlagValue("--clock") || process.env.CC_LIMITS_CLOCK || "24") === "12";

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
  let time;
  if (CLOCK_12H) {
    const h = ((d.getHours() + 11) % 12) + 1;
    const ap = d.getHours() < 12 ? "am" : "pm";
    time = `${h}:${pad(d.getMinutes())}${ap}`;
  } else {
    time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (withDate) return `${MON[d.getMonth()]} ${pad(d.getDate())} ${time}`;
  return time;
}

// One reset blurb, honoring --reset-style. `level` comes from the size preset
// (2 = room for countdown+clock, 1 = countdown only) so a style never widens
// a size beyond what it already showed.
function fmtReset(epochSec, withDate, level) {
  if (epochSec <= Date.now() / 1000) return "resets now";
  if (RESET_STYLE === "clock") return "resets at " + fmtClock(epochSec, withDate);
  if (RESET_STYLE === "countdown") return "resets in " + fmtCountdown(epochSec);
  const clock = level >= 2 ? ` (${fmtClock(epochSec, withDate)})` : "";
  return `resets in ${fmtCountdown(epochSec)}${clock}`;
}

// ---------- segment renderers ----------
// A `v` (variant) describes how compact to be:
//   v.model  "full" = name as-is | "trim" = drop "(…)" suffix | "off" = hide
//   v.ctx    "pct"  = "🧠 172k (17%)" | "tokens" = "🧠 172k" | "off" = hide
//   v.short  true => short limit labels (Session→S, Week→W)
//   v.rs/v.rw  reset detail for session/week: 2 = "…Xd Yh (clock)", 1 = "…Xd Yh", 0 = none
function renderModel(data, v) {
  let model = clean(data?.model?.display_name || "Claude");
  // Drop trailing parenthetical (e.g. "Opus 4.8 (1M context)" → "Opus 4.8").
  if (v.model === "trim") model = model.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return paint("🤖 " + model, C.cyan);
}
function renderContext(data, v) {
  const cw = data?.context_window || {};
  const tokens =
    (Number(cw.total_input_tokens) || 0) +
    (Number(cw.total_output_tokens) || 0);
  let s = "🧠 " + humanTokens(tokens);
  if (v.ctx === "pct" && cw.used_percentage != null) {
    s += ` (${round(cw.used_percentage)}%)`;
  }
  return paint(s, C.gray);
}
function renderLimit(limit, { icon, label, shortLabel, withDate }, { short, reset }) {
  const lbl = short ? shortLabel : label;
  if (!limit || limit.used_percentage == null) {
    return paint(`${icon} ${lbl} --`, C.dim);
  }
  const p = round(limit.used_percentage);
  let s = `${icon} ${lbl} ${paint(p + "%", pctColor(p))}`;
  if (limit.resets_at > 0 && reset > 0) {
    s += paint(" · " + fmtReset(limit.resets_at, withDate, reset), C.dim);
  }
  return s;
}

// ---------- session traffic lights (opt-in) ----------
// Reads the .csl status files written by the CC Status hook plugin
// (https://github.com/ann0nip/claude-status-lights) under ~/.claude/projects/.
// Loose file-format coupling only: if the plugin isn't installed or no
// sessions are live, the segment hides itself entirely.
const LIGHT_STATES = ["waiting", "active", "compacting", "idle"];
const LIGHT_DOT = { waiting: "🟠", active: "🟢", compacting: "🔵", idle: "⚪" };

function pidAlive(pid) {
  if (!(pid > 0)) return true; // no pid recorded — assume alive
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM"; // exists but not ours
  }
}

function scanSessionLights() {
  const root = path.join(os.homedir(), ".claude", "projects");
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const counts = { waiting: 0, active: 0, compacting: 0, idle: 0 };
  let total = 0;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const sub = path.join(root, dir.name);
    let files;
    try {
      files = fs.readdirSync(sub);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".csl")) continue;
      let rec;
      try {
        rec = JSON.parse(fs.readFileSync(path.join(sub, f), "utf8"));
      } catch {
        continue;
      }
      if (!pidAlive(Number(rec.pid))) continue;
      const state = String(rec.state || "idle");
      if (counts[state] == null) continue;
      counts[state]++;
      total++;
    }
  }
  return total > 0 ? { counts, total } : null;
}

// Compact and unambiguous: one dot+count per non-empty state, most urgent
// first ("🟠1 🟢2"). Orange leading = a session is waiting for your input.
// Short variant (mini/bare) collapses to the aggregate dot + total ("🟠3").
function renderLights(v, demo) {
  const scan = demo
    ? { counts: { waiting: 1, active: 2, compacting: 0, idle: 1 }, total: 4 }
    : scanSessionLights();
  if (!scan) return null;
  const { counts, total } = scan;
  if (v.short) {
    const agg = LIGHT_STATES.find((s) => counts[s] > 0) || "idle";
    return LIGHT_DOT[agg] + total;
  }
  const parts = LIGHT_STATES.filter((s) => counts[s] > 0).map(
    (s) => LIGHT_DOT[s] + counts[s]
  );
  return parts.join(" ");
}

// Build one status line at a given variant. Reset levels (rs/rw) are also
// capped by the user's --reset choice (it can hide a countdown, never add one).
function buildLine(data, v) {
  const rl = data?.rate_limits || {};
  const cap = (which, level) => (resetAllowed(which) ? level : 0);
  const out = [];
  for (const seg of SEGMENTS) {
    if (seg === "model") {
      if (v.model !== "off") out.push(renderModel(data, v));
    } else if (seg === "context") {
      if (v.ctx !== "off") out.push(renderContext(data, v));
    } else if (seg === "session") {
      out.push(
        renderLimit(
          rl.five_hour,
          { icon: "🕔", label: "Session", shortLabel: "S", withDate: false },
          { short: v.short, reset: cap("session", v.rs) }
        )
      );
    } else if (seg === "week") {
      out.push(
        renderLimit(
          rl.seven_day,
          { icon: "📅", label: "Week", shortLabel: "W", withDate: true },
          { short: v.short, reset: cap("week", v.rw) }
        )
      );
    } else if (seg === "lights") {
      const lights = renderLights(v, DEMO_MODE);
      if (lights) out.push(lights);
    }
  }
  return out.join(SEP);
}

// Size presets, richest → smallest. The user picks one with --size / CC_LIMITS_SIZE.
const PRESETS = {
  full:    { model: "full", ctx: "pct",    short: false, rs: 2, rw: 2 },
  medium:  { model: "trim", ctx: "pct",    short: false, rs: 1, rw: 0 },
  compact: { model: "trim", ctx: "pct",    short: false, rs: 0, rw: 0 },
  mini:    { model: "trim", ctx: "tokens", short: true,  rs: 0, rw: 0 },
  bare:    { model: "off",  ctx: "off",     short: true,  rs: 0, rw: 0 },
};

function render(data) {
  return buildLine(data, PRESETS[SIZE] || PRESETS.medium);
}

// ---------- demo payload ----------
let DEMO_MODE = false;

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
      "Setup (writes ~/.claude/settings.json for you):",
      "  cc-limits --install                  configure the status line",
      "  cc-limits --install --size=compact   ...at a chosen size",
      "  cc-limits --uninstall                remove it again",
      "",
      "Or set it manually in ~/.claude/settings.json:",
      '  "statusLine": { "type": "command", "command": "cc-limits" }',
      "",
      "Size (pick the one that fits your terminal — default medium):",
      "  --size=full      🤖 Opus 4.8 (1M context) | 🧠 172k (17%) | 🕔 Session 14% · resets at 04:00 | 📅 Week 12% · resets at…",
      "  --size=medium    🤖 Opus 4.8 | 🧠 172k (17%) | 🕔 Session 14% · resets at 04:00 | 📅 Week 12%",
      "  --size=compact   🤖 Opus 4.8 | 🧠 172k (17%) | 🕔 Session 14% | 📅 Week 12%",
      "  --size=mini      🤖 Opus 4.8 | 🧠 172k | 🕔 S 14% | 📅 W 12%",
      "  --size=bare      🕔 S 14% | 📅 W 12%",
      "",
      "Segments (default: model, context, session, week):",
      "  --segments=session,week   Show only these, in this order",
      "  --no-context              Hide a single segment (repeatable)",
      "  --no-model --no-week      ...",
      "  --lights                  Add Claude session traffic lights (🟠1 🟢2).",
      "                            Needs the CC Status plugin's .csl files;",
      "                            hides itself when there's no data.",
      "",
      "Reset countdowns (a preset's countdowns can be hidden, never added):",
      "  --reset=both|session|week|none   Which resets MAY show (default both)",
      "  --no-reset                       Same as --reset=none",
      "  --reset-style=clock|countdown|both   (default clock)",
      "                        clock 'resets at 20:02' | countdown 'resets in",
      "                        0h47m' | both = countdown (+clock on full)",
      "  --clock=24|12         Reset clock format (default 24)",
      "",
      "Other flags: --demo, --no-color, -h/--help",
      "",
      "Env vars:",
      "  CC_LIMITS_SIZE=full|medium|compact|mini|bare",
      "  CC_LIMITS_SEGMENTS=model,context,session,week,lights",
      "  CC_LIMITS_LIGHTS=1   add the session traffic-lights segment",
      "  CC_LIMITS_RESET=both|session|week|none",
      "  CC_LIMITS_RESET_STYLE=countdown|clock|both",
      "  CC_LIMITS_CLOCK=24|12",
      "  CC_LIMITS_WARN=70    yellow threshold (% of a limit)",
      "  CC_LIMITS_CRIT=90    red threshold",
      "  CC_LIMITS_SEP=' | '  segment separator",
      "  NO_COLOR             disable colors",
    ].join("\n")
  );
  process.exit(0);
}

// ---------- install / uninstall into ~/.claude/settings.json ----------
function settingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}
function quoteArg(s) {
  return /[\s"\\]/.test(s) ? '"' + s.replace(/(["\\])/g, "\\$1") + '"' : s;
}
function buildCommand(passthrough) {
  // Absolute node + script path => immune to the non-login-shell PATH issue
  // (e.g. nvm) that can leave a globally-installed `cc-limits` off the PATH.
  return [process.execPath, __filename, ...passthrough].map(quoteArg).join(" ");
}
function readSettings(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { settings: {}, existed: false };
    console.error("cc-limits: cannot read " + p + ": " + e.message);
    process.exit(1);
  }
  try {
    return { settings: raw.trim() ? JSON.parse(raw) : {}, existed: true };
  } catch {
    console.error(
      "cc-limits: " + p + " is not valid JSON — aborting so it isn't clobbered.\n" +
        "Fix or remove it, then re-run, or configure the status line manually."
    );
    process.exit(1);
  }
}
function doInstall(passthrough) {
  const p = settingsPath();
  const { settings, existed } = readSettings(p);
  settings.statusLine = { type: "command", command: buildCommand(passthrough) };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
  console.log("cc-limits: status line " + (existed ? "updated in " : "written to ") + p);
  console.log("→ " + settings.statusLine.command);
  console.log("Open a NEW Claude Code session and send one message to see it.");
}
function doUninstall() {
  const p = settingsPath();
  const { settings, existed } = readSettings(p);
  if (!existed || !settings.statusLine) {
    console.log("cc-limits: no status line configured in " + p + " — nothing to do.");
    return;
  }
  delete settings.statusLine;
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
  console.log("cc-limits: removed status line from " + p);
}

if (argv.includes("--install")) {
  // Bake only persistent display flags into the command — never the one-shot
  // ones (--install/--demo/--help) or the status line would break.
  const TRANSIENT = new Set(["--install", "--uninstall", "--demo", "--help", "-h"]);
  const passthrough = argv.filter((a) => !TRANSIENT.has(a));
  doInstall(passthrough);
  process.exit(0);
}
if (argv.includes("--uninstall")) {
  doUninstall();
  process.exit(0);
}

if (argv.includes("--demo")) {
  DEMO_MODE = true;
  out(render(demoPayload()));
  process.exit(0);
}

if (process.stdin.isTTY) {
  DEMO_MODE = true;
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
