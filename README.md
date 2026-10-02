# SessionDeck

A sidebar tree of every Claude Code, Codex and Cursor agent session running on your machine, grouped by project, with a status icon on each row. A red bell means a session is waiting on you. Click the row and you land in its tab.

![SessionDeck: live session tree](media/mission-control.gif)

Status is inferred from transcripts and process state on disk, not reported by the agents themselves, so it can lag or misread an edge case. The rest of this page says where.

It's for people who run many agents at once and lose track of which one stopped to ask.

## Install

**VS Code** (Visual Studio Marketplace):

```sh
code --install-extension len5ky.sessiondeck
```

Or search **SessionDeck** in the Extensions view.

**Cursor** (Open VSX): search **SessionDeck** in the Extensions panel, or run `cursor --install-extension len5ky.sessiondeck`. If Cursor can't find it, download `sessiondeck-<version>.vsix` from [GitHub Releases](https://github.com/len5ky/sessiondeck/releases) and run **Extensions: Install from VSIX...**.

**Remote windows** (WSL, Remote-SSH, dev containers): SessionDeck runs on the workspace side, so it goes into the remote, next to your sessions. The optional bridge for seeing several hosts in one tree goes on your **local desktop** instead, and installing SessionDeck from the Extensions view puts it there for you; see [Other hosts](#other-hosts-the-bridge).

### Platform support

- **Linux and WSL**: full support; this is what it's built and tested on.
- **macOS**: works, minus the `/proc` features. Liveness checks, auto-detected config homes and terminal matching degrade, and discovery is limited to config homes it already knows about.
- **Native Windows**: the tree works on the 3-second poll, without hooks or approval alerts. Install Hooks isn't offered there, and running it from the palette writes a POSIX shell script SessionDeck doesn't support on Windows.

**Run Diagnostics** reports what works on your machine. Trust it over this list.

### First run

1. Click the compass icon in the activity bar. That's the SessionDeck view; your sessions appear under **Sessions**, grouped by project.
2. Run **SessionDeck: Install Hooks (instant updates + approval alerts)** from the command palette. Without hooks the tree still updates on a 3-second poll, but it can't see a session stuck on a permission prompt: that session just looks like it's working. Hooks are written into each Claude config home on the machine where SessionDeck runs, so do this once per machine (once per remote host, too). They apply to sessions started afterwards.
3. If the tree is emptier than you expect, run **SessionDeck: Run Diagnostics**. It prints one line per subsystem and the fix for each problem, and changes nothing.

## What a row tells you

| Icon | Meaning |
|---|---|
| spinning sync, green | working |
| spinning sync, purple | working, with subagents running |
| bell, red | waiting for your approval or an answer |
| bell-dot, yellow | finished, you haven't looked yet |
| check, blue | finished and read |
| circle outline | idle |

A working row carries a short caption of what it's doing (`2m · ⚙3 · Migrating schema`, or just the tool, `2m · Bash`). A finished row you haven't opened shows the start of its last message. If a working session goes quiet far longer than its current tool usually takes (5 minutes for `Read` or `Edit`, 15 for `Bash`), the row keeps spinning but adds `· quiet 12m`. It may be wedged; the status itself never changes on a guess.

The activity-bar icon and a status-bar chip both show how many sessions need you. `Ctrl+Alt+]` (`Cmd+Alt+]` on macOS) jumps to the next one, oldest blocked first; `Ctrl+Alt+[` goes back.

![Click to navigate: jumps to the session's window and tab](media/click-to-navigate.gif)

Clicking a row opens the session: its Claude tab, even in another editor window, or the integrated terminal it runs in. If there's nothing to focus (a session in tmux, say), you get a rendered copy of its last message instead.

**Show Activity Tree** expands each session into its workflows, subagents and tasks.

![Activity tree: workflows, subagents, tasks](media/activity-tree.gif)

## How it works

SessionDeck reads files. Every few seconds it scans each Claude Code config home (`~/.claude`, `CLAUDE_CONFIG_DIR`, any you list in `sessionDeck.extraConfigDirs`, and on Linux any home a running `claude` process points at), reads the tail of each transcript, and checks the process in `/proc` to confirm it's still alive. The turn boundary comes from the transcript's `stop_reason`: `end_turn` means done, an interrupt marker means idle. So sessions started in a terminal, tmux or cron show up too.

Hooks make it faster. **Install Hooks** adds Stop, Notification and UserPromptSubmit entries to `settings.json` in every config home (backed up, safe to run twice) plus a small forwarder script at `~/.local/state/claude-overview/hook.sh` (`claude-overview` is SessionDeck's former name; the folder keeps it so existing installs carry over). Each event appends a line to a spool file SessionDeck watches, so the row flips the moment a session finishes or hits a permission prompt. **Remove Hooks** takes them out.

When a session blocks, you get a VS Code notification naming what it wants ("needs your permission to use Bash", or the question text) with an **Open** button. One notification per incident. Three or more blocks within 45 seconds collapse into one notice with a **Triage** button. Notifications live inside the editor window, which is exactly where you aren't when they fire, so two settings (both off by default) reach you when it's unfocused: `sessionDeck.unfocusedSound` and `sessionDeck.unfocusedOsNotification`. They fire at most once per 30 seconds.

The extension makes no network calls, licensing included.

### Codex and Cursor

Running `codex`, `codex exec` and `cursor-agent` sessions appear under their projects with working, idle and finished-unread states. Cursor's GUI Composer can be added with **SessionDeck: Enable Cursor Monitoring**, which writes a marked section to `~/.cursor/hooks.json`.

None of these tools writes an approval or "waiting for you" state to disk. Their rows never show a red bell or send a notification; a Codex session waiting on approval shows as working or idle.

### Other hosts (the bridge)

![Cross-host: sessions from other machines](media/cross-host.gif)

If you work in remote windows, each remote host can show up as its own section in your local tree. That needs a second, invisible extension, **SessionDeck Bridge** (`len5ky.sessiondeck-bridge`), installed on the local desktop side. Installing SessionDeck from the Marketplace or Open VSX installs it there too. It has no UI and no settings. It relays snapshots over VS Code's own command channel and serves tab titles to remote windows, which can't read local editor storage.

If everything runs in local windows on one machine you don't need it, and you can uninstall it. Without it, remote sessions also show `project-hash` names instead of tab titles.

Remote rows are read-only. A live one focuses the session when clicked; a closed one stays dimmed with a "last seen" age and leaves the tree after 24 hours. VS Code and Cursor each see only their own hosts.

### Floating window

**Open as Floating Window**, in the `...` menu at the top of the Sessions view or from the command palette, puts the same tree in a small always-on-top OS window you can park on a second monitor.

## Install (for agents and scripts)

Run these in a shell on the host where the sessions live. In a remote setup that is the remote (WSL, SSH, container) for steps 1, 3 and 4; step 2 runs on the local desktop. Use `cursor` in place of `code` for Cursor.

```sh
# 1. Main extension (workspace side)
code --install-extension len5ky.sessiondeck
#    Offline: download sessiondeck-<version>.vsix from
#    https://github.com/len5ky/sessiondeck/releases, then
#    code --install-extension ./sessiondeck-<version>.vsix

# 2. Optional, cross-host view only: bridge on the LOCAL desktop.
#    Installing step 1 from the Extensions view brings it along; from a shell, run this on the desktop.
code --install-extension len5ky.sessiondeck-bridge
```

Step 3 is the hooks. Simplest: ask the user to run **SessionDeck: Install Hooks (instant updates + approval alerts)** once from the command palette. To do it from a shell instead, this reproduces what that command writes. It needs `python3`. Add any extra config homes to the `for` list.

```sh
# 3. Hooks: forwarder script, spool file, lease, and settings.json entries
STATE="$HOME/.local/state/claude-overview"
mkdir -p "$STATE"
cat > "$STATE/hook.sh" <<'EOF'
#!/bin/sh
# SessionDeck hook forwarder: appends Claude Code hook events to a spool file
# watched by SessionDeck. Safe to delete; reinstall via the
# "SessionDeck: Install Hooks" command. The claude-overview folder name is
# SessionDeck's former name, kept so existing installs keep working.
payload=$(cat)
lease="__STATE__/monitor.lease"
now=$(date +%s)
ok=0
if [ -f "$lease" ]; then
  lts=$(head -n1 "$lease" 2>/dev/null | tr -dc 0-9)
  [ -n "$lts" ] && [ "$lts" -gt 0 ] && \
    [ $((now - lts)) -lt 604800 ] && [ $((lts - now)) -lt 86400 ] && ok=1
fi
f="__STATE__/events.jsonl"
[ "$ok" = 1 ] && {
  size=$(wc -c < "$f" 2>/dev/null || echo 0)
  [ "$size" -gt 1048576 ] && : > "$f"
  printf '%s\n' "{\"event\":\"${1:-unknown}\",\"ts\":$((now*1000)),\"bridge\":\"${CLAUDE_CODE_BRIDGE_SESSION_ID:-}\",\"payload\":${payload:-null}}" >> "$f"
}
exit 0
EOF
python3 -c 'import sys; p, d = sys.argv[1:]; s = open(p).read(); open(p, "w").write(s.replace("__STATE__", d))' "$STATE/hook.sh" "$STATE"
chmod 755 "$STATE/hook.sh"
[ -e "$STATE/events.jsonl" ] || : > "$STATE/events.jsonl"
date +%s > "$STATE/monitor.lease"
for home in "$HOME/.claude" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"}; do
  [ -d "$home" ] || continue
  python3 - "$home/settings.json" "$STATE/hook.sh" <<'PY'
import json, os, shutil, sys
path, script = sys.argv[1], sys.argv[2]
raw = open(path).read() if os.path.exists(path) else ""
s = json.loads(raw) if raw else {}
if raw and "claude-overview" not in raw:
    shutil.copyfile(path, path + ".claude-overview.bak")
hooks = s.setdefault("hooks", {})
for event, arg in (("Notification", "notification"), ("Stop", "stop"), ("UserPromptSubmit", "prompt")):
    entries = hooks.setdefault(event, [])
    if not any("claude-overview" in json.dumps(e) for e in entries):
        entries.append({"hooks": [{"type": "command", "command": f'"{script}" {arg}', "timeout": 5}]})
open(path, "w").write(json.dumps(s, indent=2, ensure_ascii=False) + "\n")
PY
done
```

The string `claude-overview` in each hook's command path is the marker the extension looks for, so it treats these entries as its own, and **Remove Hooks** cleans them up. The settings entries come out byte-identical to the command's; the script differs in one comment, and the extension swaps in its built-in copy on next start.

```sh
# 4. Verify (each line should print ok)
code --list-extensions | grep -qi '^len5ky\.sessiondeck$' && echo extension ok
grep -q claude-overview ~/.claude/settings.json && echo hooks ok    # repeat per config home
test -x ~/.local/state/claude-overview/hook.sh && echo hook-script ok
```

The end-to-end check is still a human one: start a Claude Code session, run **SessionDeck: Run Diagnostics**, and the config-home line should report at least one live session. A diagnostics file an agent can read from the shell is on the roadmap.

To uninstall cleanly, run **SessionDeck: Remove All Integrations** first (Claude hooks and Cursor monitoring), then uninstall the extension.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `sessionDeck.enableNavigation` | `true` | Click focuses the session; off shows the last message instead |
| `sessionDeck.activityTree` | `false` | Expand sessions into workflows, subagents and tasks |
| `sessionDeck.density` | `"comfortable"` | `compact` folds projects to one line, auto-expanding any that need you |
| `sessionDeck.notifications` | `"urgent"` | Notify when a session needs you; `off` silences them (chip stays) |
| `sessionDeck.unfocusedSound` | `false` | Sound when a session needs you and the window is unfocused |
| `sessionDeck.unfocusedOsNotification` | `false` | OS notification in the same case (`notify-send` on Linux, `osascript` on macOS; none on native Windows) |
| `sessionDeck.showCursorAgents` | `true` | Show Cursor Agent CLI sessions |
| `sessionDeck.showCursorComposer` | `true` | Show Cursor Composer sessions seen through Cursor hooks |
| `sessionDeck.showCodexAgents` | `true` | Show Codex CLI sessions |
| `sessionDeck.crossHost` | `true` | Publish and merge cross-host snapshots via the bridge |
| `sessionDeck.floatAlwaysOnTop` | `true` | Keep the floating window on top |
| `sessionDeck.extraConfigDirs` | `[]` | Extra Claude config homes to scan |
| `sessionDeck.licenseKey` | `""` | License key; validated offline |

## Where it can be wrong

Status is a reading of private, undocumented file formats: Claude transcripts, Codex rollouts, Cursor's `store.db`, and the editor's title storage. A vendor update can change any of them. When that happens, rows go blank or fall back to plain names rather than showing wrong data, so SessionDeck watches for it: Run Diagnostics shows a line per format, and a dim "Format drift suspected" note appears in the tree once a format stops parsing. **SessionDeck: Capture Drift Fixture** saves an anonymized sample of the broken file for a bug report.

A turn killed before it wrote anything just drops off when its process dies.

## Pricing

The first 3 days are unlimited. After that, 3 sessions stay free for good; subagents and remote hosts don't count. Neither needs a key or an account. A license ($5.99/month or $18.99 once, per person, any number of machines) lifts the cap. Buy it at [sessiondeck.dev](https://sessiondeck.dev), then run **SessionDeck: Enter License Key** or set `sessionDeck.licenseKey`. The key is checked offline. The bridge needs no license of its own.

## License

Source-available, not open source. See [LICENSE](LICENSE) for the terms. The bridge companion is MIT.

SessionDeck is an independent tool, not affiliated with or endorsed by Anthropic, OpenAI, or Cursor. Product names belong to their owners.
