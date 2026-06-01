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
const tty = require("tty");

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

// Which reset countdowns are *allowed*: both | session | week | none. This is
// a cap — the adaptive width logic shows them only while they fit, dropping the
// week countdown before the session one. Default both (full line when wide).
let RESET_MODE = (
  getFlagValue("--reset") ||
  process.env.CC_LIMITS_RESET ||
  "both"
).toLowerCase();
if (argv.includes("--no-reset")) RESET_MODE = "none";
function resetAllowed(which) {
  return RESET_MODE === "both" || RESET_MODE === which;
}

const WARN_PCT = numEnv("CC_LIMITS_WARN", 70);
const CRIT_PCT = numEnv("CC_LIMITS_CRIT", 90);
const SEP = process.env.CC_LIMITS_SEP || " | ";
const NO_COLOR =
  argv.includes("--no-color") ||
  (process.env.NO_COLOR != null && process.env.NO_COLOR !== "");

// Adaptive width: progressively shrink the line so it fits the terminal,
// keeping the session/week percentages last to die. On by default; disable
// with --no-adapt or CC_LIMITS_ADAPT=0 to always render the full line.
const ADAPT =
  !argv.includes("--no-adapt") &&
  process.env.CC_LIMITS_ADAPT !== "0" &&
  process.env.CC_LIMITS_ADAPT !== "false";

// Detect the usable terminal width. The status-line JSON payload does NOT
// carry the width, and Claude Code captures our stdout (so stdout.columns is
// undefined), so we ask the controlling terminal directly via /dev/tty — that
// reflects the real width and updates when the user resizes. Falls back
// through stdout/COLUMNS to "unknown" (null => render full line).
function termWidth() {
  const override = getFlagValue("--width") || process.env.CC_LIMITS_WIDTH;
  if (override != null && override !== "") {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n;
    return null; // explicit but invalid width => skip adaptation, full line
  }
  if (process.stdout && process.stdout.columns) return process.stdout.columns;
  let fd;
  try {
    fd = fs.openSync("/dev/tty", "r");
    if (tty.isatty(fd)) {
      // tty.ReadStream takes ownership of fd; destroy() closes it (async).
      // Do NOT also closeSync it below, or we double-close / reuse the fd.
      const s = new tty.ReadStream(fd);
      const c = s.columns;
      s.destroy();
      fd = undefined;
      if (c) return c;
    }
  } catch (_) {
    /* no controlling terminal — fall through */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }
  const env = Number(process.env.COLUMNS);
  if (Number.isFinite(env) && env > 0) return env;
  return null;
}

// Terminal display width of one Unicode code point: emoji / CJK render as 2
// columns, everything else as 1. A small wcwidth-lite so we measure the line
// the way the terminal draws it (e.g. ⏳ is one code unit but two columns).
function isWide(cp) {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f || // Hangul Jamo
      cp === 0x2329 ||
      cp === 0x232a ||
      cp === 0x231a ||
      cp === 0x231b ||
      (cp >= 0x23e9 && cp <= 0x23f3) || // ⏳ and clock/hourglass emoji
      (cp >= 0x2600 && cp <= 0x27bf) || // misc symbols & dingbats
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1faff)) // emoji planes (🤖 🧠 📅 …)
  );
}

// Visible display width of a string, ignoring ANSI color escapes.
function visibleLen(s) {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
}

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
// Each renderer takes a `v` (variant) describing how compact to be:
//   v.reset   2 = "· resets in Xd Yh (clock)", 1 = "· resets in Xd Yh", 0 = none
//   v.short   true => short labels (Session→S, Week→W), trimmed model, no ctx %
function renderModel(data, v) {
  let model = clean(data?.model?.display_name || "Claude");
  // Drop trailing parenthetical (e.g. "Opus 4.8 (1M context)" → "Opus 4.8").
  if (v.short) model = model.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return paint("🤖 " + model, C.cyan);
}
function renderContext(data, v) {
  const cw = data?.context_window || {};
  const tokens =
    (Number(cw.total_input_tokens) || 0) +
    (Number(cw.total_output_tokens) || 0);
  let s = "🧠 " + humanTokens(tokens);
  if (!v.short && cw.used_percentage != null) s += ` (${round(cw.used_percentage)}%)`;
  return paint(s, C.gray);
}
// `reset`: 2 = "· resets in Xd Yh (clock)", 1 = "· resets in Xd Yh", 0 = none.
function renderLimit(limit, { icon, label, shortLabel, withDate }, { short, reset }) {
  const lbl = short ? shortLabel : label;
  if (!limit || limit.used_percentage == null) {
    return paint(`${icon} ${lbl} --`, C.dim);
  }
  const p = round(limit.used_percentage);
  let s = `${icon} ${lbl} ${paint(p + "%", pctColor(p))}`;
  if (limit.resets_at > 0 && reset > 0) {
    const clock = reset >= 2 ? ` (${fmtClock(limit.resets_at, withDate)})` : "";
    s += paint(` · resets in ${fmtCountdown(limit.resets_at)}${clock}`, C.dim);
  }
  return s;
}

// Build one full status line at a given compactness variant. The variant gives
// independent reset levels for session (`rs`) and week (`rw`); each is also
// capped by the user's --reset choice.
function buildLine(data, v) {
  const rl = data?.rate_limits || {};
  const cap = (which, level) => (resetAllowed(which) ? level : 0);
  const out = [];
  for (const seg of SEGMENTS) {
    if (seg === "model") {
      if (!v.dropModel) out.push(renderModel(data, v));
    } else if (seg === "context") {
      if (!v.dropContext) out.push(renderContext(data, v));
    } else if (seg === "session") {
      out.push(
        renderLimit(
          rl.five_hour,
          { icon: "⏳", label: "Session", shortLabel: "S", withDate: false },
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
    }
  }
  return out.join(SEP);
}

// Compactness variants, richest → poorest. We pick the richest one that fits
// the terminal. The week countdown is dropped before the session one, and the
// session/week percentages survive every tier.
const VARIANTS = [
  { rs: 2, rw: 2, short: false },                               // full: both resets + clock
  { rs: 2, rw: 1, short: false },                               // week loses its clock
  { rs: 2, rw: 0, short: false },                               // medium: session reset only
  { rs: 1, rw: 0, short: false },                               // session reset, no clock
  { rs: 0, rw: 0, short: false },                               // plain %, full labels
  { rs: 0, rw: 0, short: true },                                // short labels, trim model/ctx
  { rs: 0, rw: 0, short: true, dropContext: true },             // drop context
  { rs: 0, rw: 0, short: true, dropContext: true, dropModel: true }, // limits only
];

function render(data) {
  const full = buildLine(data, VARIANTS[0]);
  if (!ADAPT) return full;
  const w = termWidth();
  if (w == null) return full; // width unknown — never truncate ourselves
  const usable = w - 1; // small safety margin for emoji width rounding
  if (visibleLen(full) <= usable) return full;
  for (let i = 1; i < VARIANTS.length; i++) {
    const line = buildLine(data, VARIANTS[i]);
    if (visibleLen(line) <= usable) return line;
  }
  return buildLine(data, VARIANTS[VARIANTS.length - 1]);
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
      "Setup (writes ~/.claude/settings.json for you):",
      "  cc-limits --install                      configure the status line",
      "  cc-limits --install --segments=session,week   ...with display options",
      "  cc-limits --uninstall                    remove it again",
      "",
      "Or set it manually in ~/.claude/settings.json:",
      '  "statusLine": { "type": "command", "command": "cc-limits" }',
      "",
      "Segments (default: all, in this order): model, context, session, week",
      "  --segments=session,week   Show only these, in this order",
      "  --no-context              Hide a single segment (repeatable)",
      "  --no-model --no-week      ...",
      "",
      "Reset countdowns:",
      "  --reset=both|session|week|none   Which resets MAY show (default both)",
      "  --no-reset                       Same as --reset=none",
      "",
      "Narrow terminals (on by default):",
      "  The line auto-shrinks to fit the terminal width: it drops the week",
      "  countdown first, then the session countdown, then shortens labels —",
      "  always keeping the session/week %. Width is read from the terminal",
      "  (via /dev/tty) and follows live resizes.",
      "  --no-adapt        Always print the full line (let CC truncate it)",
      "  --width=N         Assume N columns instead of auto-detecting",
      "",
      "Other flags: --demo, --no-color, -h/--help",
      "",
      "Env vars:",
      "  CC_LIMITS_SEGMENTS=model,context,session,week",
      "  CC_LIMITS_RESET=both|session|week|none",
      "  CC_LIMITS_ADAPT=0    disable adaptive width (=--no-adapt)",
      "  CC_LIMITS_WIDTH=N    force a column width",
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
  const passthrough = argv.filter((a) => a !== "--install" && a !== "--uninstall");
  doInstall(passthrough);
  process.exit(0);
}
if (argv.includes("--uninstall")) {
  doUninstall();
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
