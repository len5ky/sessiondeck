# SessionDeck Bridge

Invisible companion for the [SessionDeck](https://github.com/len5ky/sessiondeck)
extension. Install it **locally** (on your desktop) to see sessions from every
host you currently have a VS Code / Cursor window open to — WSL, Remote-SSH, or
local — in a single SessionDeck panel.

## What it does

It has no UI, no views, no settings, and does no network I/O. It registers three
cross-extension-host commands and owns a small aggregation store:

- `sessionDeckBridge.hello()` — availability + version handshake.
- `sessionDeckBridge.publish(doc)` — a main-extension instance publishes its
  host's validated snapshot; the bridge stamps a local-clock `receivedAt` and
  writes one file per host atomically.
- `sessionDeckBridge.list()` — returns every stored host snapshot.

## Where data is stored

Snapshots live only on your local disk, in this extension's `globalStorage`
directory (`hosts/<hostId>.json`). Nothing leaves your own machines or VS Code's
own command channel. Snapshots older than 14 days are pruned automatically.

Because it runs as a `ui` extension, install it once locally — VS Code loads it
on the desktop side of every window. Each remote host still needs the main
SessionDeck extension installed in that remote.

## License

MIT
