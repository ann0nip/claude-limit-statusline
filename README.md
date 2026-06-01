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
🤖 Opus 4.8 (1M context) | 🧠 42k (4%) | ⏳ Session 17% · resets in 0h47m (23:12) | 📅 Week 10% · resets in 2d 21h (Jun 03 19:54)
```

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

Want only the two limits? Pass your display options straight through:

```bash
cc-limits --install --segments=session,week
```

To remove it again:

```bash
cc-limits --uninstall
```

> **Why `--install` instead of editing by hand?** It records an **absolute**
> `node` + script path, so it works even under nvm/Volta where a globally
> installed command isn't on the `PATH` of the non‑login shell Claude Code uses
> for the status line.

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
| `⏳ Session 17% · resets in 0h47m (23:12)` | **Real** 5‑hour limit used + reset | server |
| `📅 Week 10% · resets in 2d 21h (Jun 03 19:54)` | **Real** 7‑day limit used + reset | server |

The percentage **is** your "how close am I to the limit" gauge. Subscription
limits are dynamic, so Anthropic does not expose a fixed token cap — only a
percentage, which is exactly what this surfaces.

Before the first API response (and right after `/compact`) the session segment
shows `⏳ Session --` until fresh data arrives.

## Configuration

Pick **which segments** to show (and their order). The four segments are
`model`, `context`, `session`, `week`.

```jsonc
// Only the two limits, nothing else:
"command": "cc-limits --segments=session,week"

// Everything except the context tokens:
"command": "cc-limits --no-context"
```

Pick **which reset countdowns** to show:

```jsonc
"command": "cc-limits --reset=session"   // session reset only
"command": "cc-limits --no-reset"        // just percentages, no countdowns
```

### Flags

| Flag | Description |
| --- | --- |
| `--segments=a,b,c` | Allowlist + order. Subset of `model,context,session,week` |
| `--no-<segment>` | Hide one segment (e.g. `--no-context`). Repeatable |
| `--reset=both\|session\|week\|none` | Which reset countdowns to show (default `both`) |
| `--no-reset` | Shorthand for `--reset=none` |
| `--no-color` | Disable ANSI colors |
| `--demo` | Print a sample line (no stdin needed) |
| `-h`, `--help` | Show help |

### Environment variables

Equivalent to the flags, handy if you don't want to edit the command string:

| Env var | Default | Description |
| --- | --- | --- |
| `CC_LIMITS_SEGMENTS` | `model,context,session,week` | Segments + order |
| `CC_LIMITS_RESET` | `both` | `both` / `session` / `week` / `none` |
| `CC_LIMITS_WARN` | `70` | % at/above which a limit turns yellow |
| `CC_LIMITS_CRIT` | `90` | % at/above which a limit turns red |
| `CC_LIMITS_SEP` | `" \| "` | Separator between segments |
| `NO_COLOR` | — | Set to disable ANSI colors |

```bash
cc-limits --demo
cc-limits --segments=session,week --reset=session --demo
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
