# Changelog

User-facing changes to SessionDeck and the SessionDeck Bridge companion. Both
packages share one version number.

## [Unreleased]

## [0.42.4] - 2026-10-02

### Added
- When a monthly license key runs out, SessionDeck tells you once that the free
  tier is now on and how to get back: paste the new key from your renewal email,
  or have sessiondeck.dev resend it. Before, the switch happened silently.

### Changed
- Installing SessionDeck from the Visual Studio Marketplace or Open VSX now
  installs the SessionDeck Bridge companion on your desktop too, so the
  cross-host view works without a second install.
- When the bridge is missing, Diagnostics and the Control Panel tell you to
  install "SessionDeck Bridge" from the Extensions view instead of pointing at a
  `.vsix` file.
- Enter License Key explains what is wrong with a key in plain terms: a typo, a
  key that has expired (and which month it covered), or text that isn't a key,
  each with what to do next. The prompt now says how to remove a saved key.
- Right-clicking a locked "Not available in free version" row offers Enter
  License Key and Buy License.
- The Control Panel License row and Diagnostics say when your saved monthly key
  has expired.

### Removed
- The "Debug License (temporary)" command is gone from installed builds. It
  could reset the trial and was only ever meant for development.

### Fixed
- If your trial turns out to have started earlier on another of your machines
  (Settings Sync or the desktop companion bring the older date), SessionDeck
  now says so when it ends, instead of switching to the free tier silently
  after promising 3 days.
- With hooks in some Claude config homes but not all, the Control Panel,
  Diagnostics and the tree note say "in 2 of 3 config homes" instead of "not
  installed".
- Upgrading from the extension's former name in a remote window no longer shows
  "full features are free for 3 days" followed minutes later by "Trial ended".
  Returning users skip the first-run welcome, and a new user's welcome waits
  until the desktop companion has confirmed when the trial started.
- With the extension's pre-rename version still installed, SessionDeck no longer
  reports your hooks as out of date and rewrites the hook script on every start.
  It now warns once per window that the old copy is installed and should be
  uninstalled.
- Collapse All works in the list view after you have switched to Column View and
  back. It used to collapse the hidden column table instead.
- Sort: Name orders projects, local and remote, by the folder name the row
  shows. It used to sort by the full path, so worktrees kept elsewhere landed out
  of order.
- Show Hidden Sessions says how long ago you hid each session. It used to show
  the session's last activity, so a session hidden a moment ago read "hidden 2h
  ago".
- Column View is readable in a normal-width sidebar: below 300px it drops the
  Status column (the row icon still shows status) and indents less, and project
  names are no longer upper-cased.
- The Layout setting describes what you will see instead of how it is built.
- The license terms now say where to ask for a refund: email
  support@sessiondeck.dev or use sessiondeck.dev/#refund.
- The SessionDeck Bridge listing links to the public source repository instead
  of a page that does not exist, and describes all eight of its commands.
- The SessionDeck Bridge shows the SessionDeck icon on the Marketplace and
  Open VSX instead of a blank placeholder.
- "What's included" now says what the free tier really does: your 3 covered
  sessions keep alerts, the badge, keyboard triage and the focus-return digest.
  It used to list those as license-only.
- Where SessionDeck shows its state folder (`~/.local/state/claude-overview`),
  it now says that `claude-overview` is its former name, kept so existing
  installs carry over. The hook scripts on disk now say SessionDeck.

## [0.42.3] - 2026-10-02

### Fixed
- Instant updates and approval alerts no longer stop seven days after installing
  hooks when Cursor monitoring is off.

### Changed
- Rewrote the README and listing description.

## [0.42.2] - 2026-10-02

### Fixed
- The last broken image on the Marketplace listing (a CI badge pointing at a
  private workflow) is gone.

## [0.42.1] - 2026-10-02

### Fixed
- Images on the Marketplace listing pages render again. They resolve against the
  public source repository, which now exists at github.com/len5ky/sessiondeck.

## [0.42.0] - 2026-10-02

### Added
- First public release on the Visual Studio Marketplace and Open VSX, under the
  publisher `len5ky`. Until now SessionDeck installed only from local builds.

### Changed
- The extension package now ships only the files it runs: 44 files and about
  360 KB, down from 738 files and 3.1 MB. Earlier packages included repository
  tooling and planning notes by mistake. Nothing you use depended on them.
- Release notes now live in this changelog and appear on the extension's
  Changelog tab.

## [0.41.1] - 2026-09-26

First release under the SessionDeck name. It rolls up the 0.36 to 0.41 work.

### Renamed
- Claude Mission Control (also shipped as Binnacle) is now **SessionDeck**, and
  the companion is **SessionDeck Bridge**. The publisher is now `len5ky`.
- Settings moved from `claudeOverview.*` to `sessionDeck.*`. Values you set are
  copied over once on first start; the old keys are left in place. Read state,
  pins and hidden sessions carry over unchanged.

### Added
- **Codex and Cursor sessions** in the same tree as Claude Code: Codex runs fold
  under the session that launched them, and Cursor Composer and cursor-agent
  CLI sessions show up with their own icons.
- **Agent-type filter.** Hide Claude, Cursor or Codex rows from the filter menu.
  Hidden types drop out of the counts and the badge too.
- **Table view.** A columns layout for the sidebar with status, time, model and
  tokens. It keeps the tree's order and folds columns away on a narrow sidebar.
- **Worktree grouping.** Sessions in a git worktree nest under the main repo,
  labeled with their branch.
- **Session Properties** on Cursor, Composer and Codex rows, not just Claude.
- **Click to open Cursor sessions.** Clicking a Composer or cursor-agent row
  opens its window and tab.
- **Control Panel** section with hooks, bridge and license status and their
  actions in one place.
- Headless `cursor-agent -p` runs are marked as machine-driven, so they never
  raise unread or needs-you alerts. Runs whose folder was deleted collect in
  one collapsed bucket.
- New monochrome activity-bar icon.

### Licensing
- SessionDeck is source-available (see LICENSE). Everything works for 3 days.
  After that, up to 3 top-level sessions stay free forever, active ones first.
  Sessions past the cap show as a locked row until you enter a license key. Keys
  are checked offline; nothing phones home.

### Fixed
- The tree could fail to render when the same session was discovered twice.
- The activity-bar icon rendered blank on some themes.
- Sessions orchestrating subagents show the right status, and click-to-navigate
  matches tabs by name more reliably.

### Removed
- Remote-control session detection and its toggle.
