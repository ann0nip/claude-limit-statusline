# claude-limit-statusline

[![npm version](https://img.shields.io/npm/v/claude-limit-statusline.svg)](https://www.npmjs.com/package/claude-limit-statusline)
[![npm downloads](https://img.shields.io/npm/dm/claude-limit-statusline.svg)](https://www.npmjs.com/package/claude-limit-statusline)
[![license](https://img.shields.io/npm/l/claude-limit-statusline.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/claude-limit-statusline.svg)](https://nodejs.org)

A [Claude Code](https://code.claude.com/docs) status line that shows your **real
subscription limits** — the 5‑hour session window and the 7‑day weekly window —
with a **live reset countdown**.

📦 [npm](https://www.npmjs.com/package/claude-limit-statusline) ·
🔗 [GitHub](https://github.com/ann0nip/claude-limit-statusline)

```
🤖 Opus 4.8 | 🧠 42k (4%) | 🕔 Session 17% · resets in 0h47m | 📅 Week 10%
```

That's the default (`medium`). Pick the [size](#sizes) that fits your terminal —
from `full` (both reset countdowns) down to `bare` (just the two percentages).

Unlike tools that estimate the 5‑hour block from local logs, this reads the
**official `rate_limits` payload** that Claude Code provides on stdin — the same
numbers you see when you run `/usage`. No guessing, no rounding to the hour.

## Who is this for?

This shows the **subscription rate limits** that Anthropic exposes only to
**Claude.ai Pro/Max** users. If you use the **pay‑as‑you‑go API**, the
`rate_limits` field is not present — you probably want a cost tracker like
[`ccusage`](https://github.com/ryoppippi/ccusage) instead.

| | Pro/Max subscription | Pay‑as‑you‑go API |
| --- | --- | --- |
| `rate_limits` in status line | ✅ yes | ❌ no |
| What this tool shows | 5h + 7d limit % and reset | — |

## Install

```bash
npm install -g claude-limit-statusline
cc-limits --install
```

That's it. `--install` writes the `statusLine` entry into `~/.claude/settings.json`
for you (merging, never clobbering your other settings). Then open a **new**
Claude Code session and send one message — `rate_limits` populates after the
first API response.

Want a different size? Pass your display options straight through:

```bash
cc-limits --install --size=compact
```

To remove it again:

```bash
cc-limits --uninstall
```

> **Why `--install` instead of editing by hand?** It records an **absolute**
> `node` + script path, so it works even under nvm/Volta where a globally
> installed command isn't on the `PATH` of the non‑login shell Claude Code uses
> for the status line.

> **Upgrading from 0.3.x / 0.2.x?** The old adaptive‑width behavior is gone —
> replaced by fixed [sizes](#sizes) (default `medium`). Re‑run `cc-limits
> --install` (optionally with `--size=…`) to refresh the baked‑in command; any
> leftover `--width` / `--no-adapt` flags are now ignored. The session icon also
> changed from ⏳ to 🕔.

<details>
<summary>Manual setup (if you prefer)</summary>

Add this to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "cc-limits"
  }
}
```

If the bar stays blank (nvm/Volta `PATH` issue), use absolute paths instead —
`"command": "/path/to/node /path/to/cli.js"` (find them with `which node` and
`npm root -g`), which is exactly what `cc-limits --install` does automatically.

</details>

## Output

| Segment | Meaning | Source |
| --- | --- | --- |
| `🤖 model` | Active model | local |
| `🧠 42k (4%)` | Tokens in the current context window | local |
| `🕔 Session 17% · resets in 0h47m (23:12)` | **Real** 5‑hour limit used (+ reset) | server |
| `📅 Week 10% · resets in 2d 21h (Jun 03 19:54)` | **Real** 7‑day limit used (+ reset) | server |

The percentage **is** your "how close am I to the limit" gauge. Subscription
limits are dynamic, so Anthropic does not expose a fixed token cap — only a
percentage, which is exactly what this surfaces.

Before the first API response (and right after `/compact`) the session segment
shows `🕔 Session --` until fresh data arrives.

## Sizes

Claude Code shows the status line on a single line and truncates anything past
the terminal width. So instead of guessing, you **pick the size that fits** —
set it once with `--size` (or `CC_LIMITS_SIZE`). The default is `medium`.

```text
full     🤖 Opus 4.8 (1M context) | 🧠 42k (4%) | 🕔 Session 17% · resets in 0h47m (23:12) | 📅 Week 10% · resets in 2d 21h (Jun 03 19:54)
medium   🤖 Opus 4.8 | 🧠 42k (4%) | 🕔 Session 17% · resets in 0h47m | 📅 Week 10%
compact  🤖 Opus 4.8 | 🧠 42k (4%) | 🕔 Session 17% | 📅 Week 10%
mini     🤖 Opus 4.8 | 🧠 42k | 🕔 S 17% | 📅 W 10%
bare     🕔 S 17% | 📅 W 10%
```

| Size | Shows |
| --- | --- |
| `full` | Model (with context length), tokens + %, both limits with reset countdown & clock |
| `medium` | Model, tokens + %, session countdown, both percentages *(default)* |
| `compact` | Model, tokens + %, both percentages — no countdowns |
| `mini` | Model, tokens, short labels |
| `bare` | Just the two limits |

```bash
cc-limits --install --size=compact
```

You can still fine‑tune any size with [`--segments`](#flags) and
[`--reset`](#flags) below.

## Configuration

Pick **which segments** to show (and their order). The segments are
`model`, `context`, `session`, `week`, and the opt-in
[`lights`](#session-traffic-lights-opt-in).

```jsonc
// Only the two limits, nothing else:
"command": "cc-limits --segments=session,week"

// Everything except the context tokens:
"command": "cc-limits --no-context"
```

Cap **which reset countdowns** a size may show (this can hide a countdown,
never add one):

```jsonc
"command": "cc-limits --size=full --reset=session"  // full, but no week countdown
"command": "cc-limits --no-reset"                   // just percentages, no countdowns
```

### Reset display style

By default a reset shows as a countdown (`resets in 0h47m`), with the wall
clock added in parentheses only on `full`. Prefer the local time instead?
Pick a style with `--reset-style` (it re-formats the resets a size already
shows — it never adds one, so your chosen size keeps fitting):

```text
--reset-style=countdown   🕔 Session 17% · resets in 0h47m
--reset-style=clock       🕔 Session 17% · resets at 20:16
--reset-style=both        🕔 Session 17% · resets in 0h47m (20:16)   ← default
```

The weekly reset includes the date in clock style (`resets at Jul 05 16:54`).
Prefer 12-hour times? Add `--clock=12` (`resets at 8:16pm`). When a reset time
has already passed, all styles show `resets now`.

```bash
cc-limits --install --size=medium --reset-style=clock
```

### Session traffic lights (opt-in)

If you also run the [CC Status](https://github.com/ann0nip/claude-status-lights)
widget, its Claude Code plugin writes live per-session state files. Add the
`lights` segment to see all your Claude sessions at a glance, right in the
status line:

```text
🟠1 🟢2 ⚪1        1 waiting for input · 2 working · 1 idle
```

Orange first means **a session somewhere needs your input**. States: 🟠 waiting,
🟢 active, 🔵 compacting, ⚪ idle. On `mini`/`bare` it collapses to the
aggregate dot plus a total (`🟠4`).

```bash
cc-limits --install --lights                 # append the segment
cc-limits --install --segments=lights,session,week   # or place it anywhere
```

It's **off by default** (so existing setups keep their exact width), and it
hides itself entirely when there's no data — no CC Status plugin installed, or
no live sessions — so it never shows a stale or empty segment. Dead sessions
are filtered out by checking the recorded process is still alive.

### Flags

| Flag | Description |
| --- | --- |
| `--size=full\|medium\|compact\|mini\|bare` | How much detail to show (default `medium`) |
| `--segments=a,b,c` | Allowlist + order. Subset of `model,context,session,week,lights` |
| `--no-<segment>` | Hide one segment (e.g. `--no-context`). Repeatable |
| `--lights` | Append the [session traffic lights](#session-traffic-lights-opt-in) segment |
| `--reset=both\|session\|week\|none` | Cap which reset countdowns may show (default `both`) |
| `--no-reset` | Shorthand for `--reset=none` |
| `--reset-style=countdown\|clock\|both` | Countdown, local time, or both (default `both`) |
| `--clock=24\|12` | Clock format for reset times (default `24`) |
| `--no-color` | Disable ANSI colors |
| `--demo` | Print a sample line (no stdin needed) |
| `-h`, `--help` | Show help |

### Environment variables

Equivalent to the flags, handy if you don't want to edit the command string:

| Env var | Default | Description |
| --- | --- | --- |
| `CC_LIMITS_SIZE` | `medium` | `full` / `medium` / `compact` / `mini` / `bare` |
| `CC_LIMITS_SEGMENTS` | `model,context,session,week` | Segments + order (`lights` available) |
| `CC_LIMITS_LIGHTS` | — | Set to `1` to append the session traffic lights |
| `CC_LIMITS_RESET` | `both` | `both` / `session` / `week` / `none` |
| `CC_LIMITS_RESET_STYLE` | `both` | `countdown` / `clock` / `both` |
| `CC_LIMITS_CLOCK` | `24` | `24` / `12` hour clock for reset times |
| `CC_LIMITS_WARN` | `70` | % at/above which a limit turns yellow |
| `CC_LIMITS_CRIT` | `90` | % at/above which a limit turns red |
| `CC_LIMITS_SEP` | `" \| "` | Separator between segments |
| `NO_COLOR` | — | Set to disable ANSI colors |

```bash
cc-limits --demo
cc-limits --size=compact --demo
```

## How it works

Claude Code runs your status-line command on every update and pipes a JSON
[status-line payload](https://code.claude.com/docs/en/statusline) to stdin. This
program parses it and reads:

- `rate_limits.five_hour.used_percentage` / `.resets_at`
- `rate_limits.seven_day.used_percentage` / `.resets_at`
- `context_window.*` for the token/context segment

`resets_at` is Unix epoch seconds; the countdown is computed against the current
time. Everything runs with **zero dependencies** for fast startup.

## License

MIT
