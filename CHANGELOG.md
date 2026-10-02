# Changelog

User-facing changes to SessionDeck and the SessionDeck Bridge companion. Both
packages share one version number.

## [Unreleased]

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
