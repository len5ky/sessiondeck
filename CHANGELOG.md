# Changelog

User-facing changes to SessionDeck and the SessionDeck Bridge companion. Both
packages share one version number.

## [Unreleased]

## [0.42.8] - 2026-10-07

### Fixed
- Clicking a terminal session whose process has ended now says at once that
  the session is no longer running, instead of waiting about two seconds.
- A toast for a session on another machine now says whether it needs your
  input or your approval, as local toasts do, when that machine runs
  SessionDeck 0.42.7 or later. Sessions from older versions still say "needs
  you".
- A Claude Code tab session opened with a file or a selection, or with a
  terminal or browser attachment, is now titled by your prompt, not by the
  editor's "The user opened the file …" note or the attachment's contents.
- A window that lost its connection could keep its machine's sessions from
  being published, so the machine showed as offline in other windows for up
  to three hours (in v0.42.6 and v0.42.7 too). Such a window now gives up
  publishing within about 90 seconds and another window on that machine takes
  over. Diagnostics says when a window can't reach the Bridge.

## [0.42.7] - 2026-10-05

### Fixed
- With two windows open on the same folder, clicking a Claude session
  (including from another machine) no longer opens a second tab in the window
  that does not have it; the window that runs the session shows it.
- Clicking a terminal session from another machine when two windows have its
  folder open now switches to the window whose terminal runs it, instead of
  sometimes reporting "no integrated terminal there is running the session".
- After updating, reload every editor window. Windows on different versions of
  SessionDeck on one machine can disagree about which window handles a click
  or publishes the machine's sessions.
- The floating window now shows the ↗ badge on sessions that run outside the
  editor, after the account letter, as the tree and Column View do.
- Show Last Message on a Codex or Cursor session from another machine now says
  the message is only available on the machine that runs it, instead of "No
  message text."
- Column View gives titles more room in a narrow sidebar: below 260 px the
  time moves to the line under the title.
- On native Windows, a session waiting on a question or a permission prompt now
  shows under Needs you and raises its alert. Claude Code doesn't write the
  question to the transcript until it is answered, so SessionDeck now also
  reads the status Claude Code keeps in its session registry.
- A session that needs you on another machine now raises one alert per
  question or permission prompt, within a few seconds. Before, in v0.42.6 too
  and for hook approvals as well, the alert could arrive late, repeat every 15
  seconds, turn into a "1 sessions just blocked" notice, and then hide later
  alerts for up to a minute. A question on another machine is now labelled as
  a question, not as an approval.
- A session waiting on a question or a permission prompt now stays under Needs
  you while its subagents or background tasks keep working. Before, it could
  drop back to "working" after about a minute, in v0.42.6 too on machines with
  hooks.
- A question in a session with hooks now raises one alert and stays labelled
  as a question, instead of getting a second "Claude needs your permission"
  alert a few seconds later, as v0.42.6 did. An approval no longer gets a
  second alert after you approve it.
- On Windows, the result of stopping a session from another machine could be
  lost, leaving the other machine saying it had not heard back.
- On Windows and macOS, questions and approvals from the session registry no
  longer stay hidden when the process table can't be read. After 15 seconds
  of failed reads they show anyway, and Diagnostics explains why.
- A sandboxed command asking for network access, or a worker asking for
  permission, now shows as an approval instead of a question.
- Closing the editor tab of a session you moved into the editor ends the
  session. SessionDeck now says so and offers to resume it.

## [0.42.6] - 2026-10-05

### Added
- **Stop Session** ends a running Claude Code or Codex session without moving
  it. It sits inline next to Move, in the row's right-click menu, and in the
  offer you get when you click a row marked ↗. It asks first and says when a
  turn will be cut off or an app may start the session again; Leave It Running
  is the default. It stops the process the way Move into Editor does and
  resumes nothing. Rows from another host can be stopped too, once you confirm
  in the window on that host. That needs this version of SessionDeck on both
  hosts and of the Bridge on your desktop.
- Sessions running outside the editor (another terminal, SSH, or an app using
  the Agent SDK) get a small ↗ badge at the end of the row, and the hover
  says where they run. Sessions in tmux or in this editor are not marked.
  Works on Linux, macOS and Windows.
- **Move into Editor** on a marked row stops that process and resumes the
  session here, in a Claude Code tab or in a terminal tab in the editor area
  running `claude --resume`. It asks first, warns when a turn is in progress,
  and never resumes while the old process is still running. The new
  `sessionDeck.moveTarget` setting picks where it lands. Codex sessions resume
  with `codex resume` and can be moved on Linux only.
- On Windows the move ends the session and the programs it started at once,
  since Windows has no gentle stop for a terminal program. It ends only that
  session's own processes, and stops nothing if they include this editor. If
  the session can't be resumed, the message gives the command to run in
  PowerShell.
- Clicking a session goes to its integrated terminal on macOS and Windows too.
- Diagnostics has a "Session start times" line: does the start time Claude Code
  records for each running session match what the operating system reports?
  If it says no on your Mac or PC, please report that line.
- Rows from other hosts carry the mark too. Clicking one offers the
  move in the window attached to that host. Needs this version on both sides;
  older versions just show no mark.
- With several windows open on one host, only one of them publishes that
  host's sessions to your other windows, so rows and their marks no longer
  come and go as the windows overwrite each other. Reload any window still on
  an older version after updating; until then it keeps publishing too.

### Changed
- `sessionDeck.editorCliPath`, `sessionDeck.cursorCliPath` and
  `sessionDeck.extraConfigDirs` can only be set in user (or remote machine)
  settings, not in a workspace's `.vscode/settings.json`, so a cloned
  repository can't choose a program SessionDeck runs. If you set one of them
  only in workspace settings, that value no longer applies: move it to your
  user or remote settings.

### Fixed
- The ↗ badge reads the same in the list and in Column View: the account
  letter first, then ↗ ("S↗"). The hover on a row running outside the editor
  now mentions Stop Session as well as Move into Editor.
- Rows no longer jump under the pointer the moment a session turns busy or
  starts needing you, where a click on an inline button could land on the
  row next to it. The row's own icon and text change at once; it moves up
  within 15 seconds. A row entering "Needs you" shows at once, below the rows
  already there, and takes its place by urgency within 15 seconds.
- Switching Column View on and back off no longer leaves a second, out-of-date
  list drawn over the Sessions list, with rows overlapping and clicks landing
  on rows that were gone.
- Stop Session now shows up on rows from a host whose publishing window was on
  an older SessionDeck: that window kept publishing the host's sessions without
  saying which rows can be stopped. A window on this version now takes over
  publishing from it. Stopping a row from another host needs this version in
  the window you click from as well. Rows from a host whose windows are all on
  an older build show no Stop, only Show Last Message.
- On Windows, switching windows no longer leaves an empty folder in the
  editor's `logs` directory each time. The editor command line now writes its
  log to one reused folder in your temp directory.
- After a click switches to a session on another host, the "Switched to …"
  note now stays in the clicking window's status bar for 30 seconds instead of
  5, so it is still there when you come back to that window. A hand-off is
  reported as switched once the window that has the session confirms it.
- Clicking a session that lives on another host now switches to it when that
  host has several editor windows open. The click goes to the window that has
  the session's folder open; if another window gets it first, that window passes
  it on, and the window with the folder shows the session and comes to the
  front. It fails only when no window there has the folder open or the editor
  CLI fails, and the message says which.
- If part of SessionDeck fails to start (the bridge client, a view, a hooks
  check, the first scan, and so on), the rest still starts. Before, one failure
  early in startup left almost every command unregistered, so every click said
  "command not found". Now you get one notice naming what is missing, Output >
  SessionDeck has the error, Diagnostics lists the failed step, and a command
  that needs the missing part says so when you run it. The Bridge companion
  likewise registers all its commands even when one of its setup steps fails.
- If carrying over state from the extension's former name fails at startup,
  SessionDeck no longer starts a new trial in its place. Before, an ended trial
  could start over; now SessionDeck tries the old trial start again the next
  time it starts.
  If it keeps failing, after five starts SessionDeck stops waiting and counts
  the trial from the first of them, so the trial still ends on time.
- When SessionDeck can't save a setting (a full disk, a damaged editor state
  file), Output > SessionDeck says which one and Diagnostics lists it. If it is
  the trial or a notice SessionDeck shows only once, the startup notice says so.
- Clicking a row in the Sessions view no longer fails now and then with
  "Actual command not found, wanted to execute sessionDeck.focusRemoteSession"
  (or another SessionDeck command). It happened when the list redrew just as
  you clicked, which in a remote window could be every few seconds. If the row
  you clicked is gone by the time the click arrives, SessionDeck now asks you
  to click again. The Control Panel's Buy License row had the same problem and
  is fixed too.
- Clicking a session from another host tells you what happened there: it
  switched; it was passed to the window there that has its folder open, which
  can't confirm it; only its last activity could be shown; the session runs
  outside the editor; that host no longer has it; or the switch failed, and
  why. If no window on that host answers within 15 seconds, you're told so
  instead of being left at "Focusing…", and a window there on this version
  won't switch after that. Needs this version on both
  hosts and in the SessionDeck Bridge; with older ones you get a note that the
  request was sent but can't be confirmed.
- On Windows, switching to another Cursor or VS Code window works: the editor
  command (`cursor.cmd`, `code.cmd`) used to fail to start, silently. Folders
  now match even when the drive letter's case or a trailing backslash differs,
  and a folder name with a space is passed whole.
- On macOS and Windows, a session that ended without cleaning up no longer
  stays listed when its process number is reused by another program.
- An editor installed behind a symlink or a Windows junction is recognized as
  the editor, so its sessions don't get the ↗ badge.
- Clicking a session started by an app through the Agent SDK no longer tries to
  open it as a Claude tab; it focuses its terminal or shows the last message.
- Clicking a session whose folder isn't open in any window shows its last
  message instead of opening a new, empty window.
- Move into Editor: with three or more windows open, only one of them can take
  over a move that a closed window left unfinished.
- Move into Editor: when a window closes mid-move, your other windows can move
  that session right away instead of after five minutes. On Linux and Windows,
  a change of the system clock during a move (a time sync, say) no longer lets
  a second window start the same move; on macOS that holds from about a second
  after the change. If the system won't tell SessionDeck when its window
  started, both fall back to the old five-minute rule until it can.
- Each Move into Editor request is noted in the SessionDeck output channel
  (View > Output > SessionDeck): the kind of row and its process id, nothing
  from the conversation. If a click seems to do nothing, that line shows
  whether the request arrived.
- Codex rows offer "Show Last Message" in their right-click menu, in the tree
  and the columns view, as Claude rows do.
- Move into Editor: when you cancel at "Force Stop", the message says the
  session may still exit and gives the command to reopen it.
- Move into Editor on Windows: if a program the session started can't be
  ended, the move still goes ahead and tells you its name and pid.
- Move into Editor on Linux checks the whole machine and namespace a session's
  record names, and refuses a session from another machine.
- Diagnostics' "Session start times" line counts running sessions that have no
  start time recorded, instead of leaving them out.
- Move into Editor: a session moved into a terminal now starts reliably. The
  terminal runs the CLI directly instead of typing the command into a shell,
  where a shell startup prompt (an SSH key passphrase, say) could swallow it.
- Move into Editor resumes with the same `claude` or `codex` program the
  stopped session ran, by its full path. On Windows a bare `claude` was often
  not found in the editor's terminals. When that program can't be identified
  for certain, it uses the one on your PATH. The command it shows for resuming
  by hand is the plain `claude --resume …` or `codex resume …` when that name
  on your PATH is the program the session ran, so it keeps working after the
  CLI updates itself; otherwise it shows that program's full path.
- Move into Editor: for a session run by an app, or one in the middle of a
  turn, Enter now picks "Leave It Running" instead of "Stop and Move". The
  "did not stop" dialog does the same instead of defaulting to "Force Stop".
- Move into Editor from an old offer, after the session already moved or
  stopped, says so straight away in a short note instead of asking to stop a
  process that is gone.
- A finished session's last message shows again in its preview and hover.
  Recent Claude Code versions write a large record after each turn, which hid
  the reply and showed "No assistant message yet." The preview's heading is
  now the session's title, as in the list.
- Clicking a Codex session that isn't in one of this window's terminals opens a
  preview of its last reply, like a Claude session, and still offers Move into
  Editor when it runs outside the editor.
- The ↗ badge sits after the title, so a long title no longer cuts it off. The column view shows it on "Needs you" rows and on rows from other
  hosts too.
- Hover wording for sessions outside the editor: a Codex run says "outside"
  instead of "terminal", and a session run by an app names the app, or says
  "another program" when it isn't known, instead of the shell in between.
- The Move into Editor confirmation says when the session will open in a
  terminal instead of a Claude tab because the Claude Code extension isn't
  installed, and when the terminal opens in a folder this window doesn't have
  open. It also names options the session was started with that the move
  doesn't carry over (such as `--add-dir` or `--mcp-config`), so you can decide
  before it stops anything.
- After a move into a terminal, the session's row shows up on its own. The
  "has not seen it start here yet" warning appears only when the resume really
  failed; if the terminal closes right away, the message says so and gives the
  command to run.
- Clicking a row in the Sessions view, or one of its inline buttons, works the
  first time, also in a window attached to another machine over SSH. The view
  used to redraw itself whole whenever anything in it changed, about every 3
  seconds on a busy machine, and until the editor had fetched the rows again a
  click found nothing ("the list was redrawn as you clicked"). Now only the rows
  that changed are redrawn and every other row stays clickable. A group is
  redrawn only when rows join, leave or change places in it, and the whole view
  only when its top-level groups do.
- An open group's line shows its name, session count, pin and branch; the
  working and unread counts and the newest age show when it is folded. Open,
  the rows under it show those facts, and keeping them on the group's line
  would mean redrawing the group (and briefly losing clicks on its rows) every
  few seconds.
- Sessions last active in the same span (2 minutes, 10 minutes, an hour, a
  day) keep their order instead of trading places each time one of them
  writes. A session still moves up as soon as it becomes active after a quiet
  spell.
- The Control Panel no longer redraws itself every 3 seconds: it redraws only
  the rows that changed, so a click on one of its rows isn't lost to a redraw.
- A session that starts needing you shows in "Needs you" at once. One that
  stops stays there for up to 15 seconds after it last needed you, and rows
  trading places in a group settle for up to 15 seconds before the new order
  shows. Every change to a group's rows briefly makes its rows unclickable,
  and with sessions turning over every few seconds that happened all the time.
- Each row in the Sessions view keeps one identity from refresh to refresh,
  taken from the session (or folder, or host) it shows, never from its place
  in the list. A click or an inline action can only ever reach the row you
  clicked, not one that moved into its place.
- Clicking a row from another machine whose session lives in a different
  window there (for example a window opened on a drive root such as `S:\`)
  said that window "did not confirm it showed the session" even when it had.
  The window that shows the session now answers, and the click reports
  "Switched to …". A window there on an older SessionDeck still can't answer,
  so you get the old message from it.
- When a move can't resume the session, the command it gives you is plain
  `claude --resume <id>` again after Claude Code has updated itself. It used to
  give the full path of the version the session started with, which the
  update had replaced. A full path is still given when `claude` on your PATH
  is a different program.
- Last-message preview tabs are titled with the session's name. They showed
  `%20` in place of spaces for rows from other hosts, and a raw session id for
  the others. The Diagnostics tab is titled "SessionDeck Diagnostics"; in a
  remote window it read `\SessionDeck Diagnostics.txt`.
- In compact density a project or host that comes to need you still opens on
  its own, but no longer redraws the whole list to do it, and it waits while
  the Sessions view is hidden instead of bringing the view back. When it stops
  needing you it stays as it is rather than folding back.
- A Windows folder no longer shows as two projects when sessions report its
  drive letter in different case (`s:\` and `S:\`). Existing pins keep
  working.
- The Bridge no longer leaves stray temporary files in its storage when a
  window's routing record can't be saved.

## [0.42.5] - 2026-10-03

### Changed
- Buy links from the extension, README and marketplace manifests now carry UTM
  parameters for sales attribution.

### Fixed
- Projects on a Windows remote host now show their folder name instead of the
  whole path when the window runs on Linux or WSL, and Sort: Name orders them by
  that name.
- Diagnostics no longer tells you to install SessionDeck Bridge on the Real tab
  titles line while the Bridge line says it is answering. With the bridge
  answering it says to open a Claude tab in a desktop window instead.
- When the trial ends with more than 3 sessions running, you get one notice
  ("Trial ended") instead of two at once. The free-tier reminder about locked
  sessions comes the next day.
- After Enter License Key, the confirmation ("License key cleared.", "Licensed
  — thank you.") appears once the Sessions view and Control Panel show the new
  state, not a moment before.
- Upgrading from the extension's former name in a remote (WSL or SSH) window no
  longer restarts a trial that had already ended. Your pinned projects, filter
  and sort order also carry over to remote windows. Needs SessionDeck Bridge
  0.42.5 or later on the desktop.
- The notice that a monthly key has run out now shows in one window, not in
  every window that was open when it lapsed. With SessionDeck Bridge 0.42.5 or
  later this holds across local and remote windows; without it, across the
  windows on one host.

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
