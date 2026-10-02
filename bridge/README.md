# SessionDeck Bridge

Invisible companion for the [SessionDeck](https://github.com/len5ky/sessiondeck)
extension. Install it **locally** (on your desktop) to see sessions from every
host you currently have a VS Code / Cursor window open to — WSL, Remote-SSH, or
local — in a single SessionDeck panel.

Installing SessionDeck from the Visual Studio Marketplace or Open VSX installs
this companion on your desktop automatically. If you installed SessionDeck from a
`.vsix` file, install this one the same way, on the desktop side.

## What it does

It has no UI, no views, no settings of its own, and does no network I/O. It
registers eight commands that SessionDeck windows call across extension hosts,
and owns a small aggregation store:

- `sessionDeckBridge.hello()` — availability and version handshake.
- `sessionDeckBridge.publish(doc)` — a SessionDeck window publishes its host's
  validated snapshot; the bridge stamps a local-clock `receivedAt` and writes one
  file per host atomically.
- `sessionDeckBridge.list()` — returns every stored host snapshot.
- `sessionDeckBridge.titles()` — reads the desktop editor's own workspace storage
  (read-only) so remote windows can show the real Claude Code tab titles.
- `sessionDeckBridge.cursorSessions()` — reads Cursor's local chat list
  (read-only) so remote windows can list Cursor agent sessions.
- `sessionDeckBridge.license()` — keeps one trial start date for the whole
  desktop, so every remote window sees the same trial, and passes on a license
  key you entered in SessionDeck's settings.
- `sessionDeckBridge.postAction(action)` / `sessionDeckBridge.takeActions(hostId)`
  — a click on a session that lives on another host is queued here and picked up
  by that host's window, which then focuses the session. Queued clicks expire
  after one minute.

## Where data is stored

Snapshots live only on your local disk, in this extension's `globalStorage`
directory (`hosts/<hostId>.json`). Nothing leaves your own machines or VS Code's
own command channel. Snapshots older than 14 days are pruned automatically.

Because it runs as a `ui` extension, install it once locally — VS Code loads it
on the desktop side of every window. Each remote host still needs the main
SessionDeck extension installed in that remote.

## License

MIT
