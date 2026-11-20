# AutoDeck: Full Product Requirements Document (functional and technical)

Version described: **1.0.44** (20 Nov 2026) · Platforms: **Web, Windows (Electron), Android (Capacitor)** · Source: single React component `src/TodoApp.jsx` plus `src/androidReminders.js`, `src/androidUpdate.js`, `public/sw.js`, `public/timer-worker.js`, `electron/main.cjs`, `electron/preload.cjs`, and the native `ApkUpdatePlugin.java`.

This document is the exhaustive companion to the shorter `PRD.md`. It follows the seven-part structure requested (value proposition, roles, flows, per-module feature breakdown with UI / logic / edge cases, data, integrations, non-functional requirements). Numbers in brackets are the exact limits and timings the code uses.

---

## 1. Core value proposition and target audience

**Problem.** Ordinary to-do apps accumulate clutter (old completed tasks), lose unfinished work, and deliver reminders late, silently, or not at all when the app is closed or minimized.

**Value proposition.** A private planner whose list is always *today*: finished work clears itself (into a searchable Archive), unfinished work rolls forward, repeating work starts over by itself, and reminders fire at the scheduled second on desktop, in a browser tab (even hidden) and on a phone (even with the app closed). Everything is stored on the device; there is no account, server or tracking.

**Primary user.** One person managing their own day (knowledge worker, student, professional who reports progress to a manager). **Secondary needs:** a shareable end-of-day report; routine/repeating tasks with sub-steps.

**Success criteria.** Reminder lateness under 1 s (measured 0 to 0.1 s on Windows minimized/in tray and in a hidden Edge tab); zero silently lost tasks; zero blank-screen crashes from old/corrupt saved data; a one-off completed task never reappearing as pending.

---

## 2. User roles and permissions

AutoDeck is single-user and local; there is **one application role**. The table lists the effective roles and what each controls.

| Role | Access | Can do | Cannot do |
|---|---|---|---|
| **Device owner (the user)** | Everything in the app on their device/profile | Create, edit, complete, pin, postpone, duplicate, delete, archive, restore, import, export, configure settings, create reports | Share data with other users or devices (no sync, no accounts) |
| **Another window of the same page** (web) | Same storage | Sees changes live (storage sync) | n/a (not a separate role) |
| **OS permission layer** | Granted by the user | *Notifications* (web, Windows, Android 13+), *Exact alarms* (Android: `USE_EXACT_ALARM`, `SCHEDULE_EXACT_ALARM`), *Install unknown apps* (Android self-update), *Start with Windows / run in tray* (Windows, toggle in Settings) | Camera, microphone, location, USB: all refused by the Windows shell |
| **Maintainer (developer)** | GitHub repo, Actions, Releases, local signing key | Tag a version to build and publish the Windows installer; build and attach the signed Android APK | n/a |

Guest, Registered User and Admin roles do not exist. There is no authentication, no per-record ownership and no server-side authorization.

---

## 3. End-to-end user flows

### 3.1 First run / onboarding
There is no onboarding wizard. First launch shows an empty state:
1. Header: greeting (time-of-day), live clock, today's date, text "No tasks yet. Add one to get started."
2. Progress card: ring 0%, "0 / 0 done today", "Add your first task to get going."
3. Add form focused (desktop; not auto-focused on touch devices so the keyboard doesn't pop up).
4. Boards show "All clear / Nothing pending. Enjoy the calm." and "Nothing done yet / Check off a task and it lands here."
5. Notifications are not requested until the user sets a reminder (first reminder triggers the permission request) or clicks the bell.

### 3.2 Core action: capture a task
1. Type in the box, e.g. `Email Sam at 5pm tomorrow #work !high`. A "Detected:" row previews priority, category and time ("Tomorrow 5:00 PM"). While the box is empty (or holds only shortcuts) a "Quick add:" row of tappable chips (`#work`, `#personal`, `!high`, `at 5pm`, `tomorrow`) types shortcuts in.
2. Optionally set Priority, Category, Repeat, Subtasks (panel) and Remind me (date, time, lead, repeat).
3. Press Enter or **Add**. The task appears in Pending; box, reminder editor, repeat and subtasks reset (priority and category keep the last choice).
4. If a reminder was set, the browser/OS notification permission is requested (bonus; in-app alerts work without it).

### 3.3 Completion
1. Click the circle on the card (or the Done button in a reminder banner / notification action).
2. The card moves to Completed, progress ring and chips update, a "complete" chime plays. When the last open task is completed: celebration (party icon, arpeggio, "Everything done. You crushed today.", 2.6 s).
3. Un-complete from the Completed board with the same circle (soft "toggleOff" sound).

### 3.4 Reminder lifecycle
1. **Scheduled** (appears in Upcoming reminders with Due / Next / Frequency / Status). 2. **Due** at (event time − lead): banner appears, sound matched to priority, OS notification, header "next …" chip updates. 3. Per item: **Done**, **Snooze** (5/10/15/30 min, 1 h), **Dismiss** (once = off; repeating = returns after the interval), **View** (scrolls to and pulses the task; for a subtask opens its task). 4. Repeating reminders re-alert every N minutes until done. 5. Completed, deleted, snoozed or removed reminders take down any alert still showing. 6. Android: the same reminder is also an exact system alarm so it rings with the app closed.

### 3.5 Daily rollover (automatic)
At local midnight (also while the app is open, after sleep, or on first open of a new day): unfinished tasks roll to today. **Completed tasks are never archived, moved or reset.** A completed repeating task gets its next occurrence created once, as a separate pending task (id `series@date`); the completed original is only marked `spawned`. Repeating subtasks of unfinished tasks reset. See section 4.12.

### 3.6 Subtask flow
Add steps in the Add form's Subtasks panel (Enter adds; paste a list to split by line) or on a card (pencil/Options). Each step may have its own priority, category, repeat and reminder. A step's reminder alerts as "step (in task)"; its Done completes only the step.

### 3.7 Delete, archive and restore
Delete → task leaves the list, goes to the Archive (reason Deleted), "Task deleted — Undo" toast for 5 s (Undo restores it and removes it from the Archive). Later: Archive tab → search/filter → Restore (to today, undone) or Delete for good (confirmed).

### 3.8 Export / import
Export menu → PDF / CSV / Word / JSON backup ("Exported N tasks to X." toast). Import icon → pick a `.json` file → validated and cleaned → replaces current tasks (the replaced ones go to the Archive unless the backup contains them) → "Imported N tasks." toast.

### 3.9 Daily report
Daily Report tab → add goals (they are tasks) → tick them → write blockers/notes → enter who it is shared with → Copy / Download / "Copy & mark shared" (status becomes Finalized). Past dates are read-only snapshots.

### 3.10 Settings
Gear icon → dialog: notification state/mute, run-in-tray (desktop), sound on/off, volume (+ Test), louder high-priority alarm, default lead/repeat for new reminders, category manager. Escape, ✕ or a backdrop click closes it.

### 3.11 Updates
- **Windows:** checked at start, every 10 min, on wake from sleep (after 15 s) and when the window gains focus. Download shows "Downloading update X… N%"; when done "Update X downloaded — restarting to install…" with **Restart now**; installs automatically after 5 s.
- **Android:** checked at start and every minute while open, and when the app becomes visible; downloads the APK, verifies SHA-256, shows "Update X is ready to install" with **Install** (hands to the system installer).
- **Web:** a reload gets the latest build.

### 3.12 Desktop background flow
Closing the window (X) hides it to the system tray when "Reminders when closed" is on (default). Reminders keep firing. Tray: click or "Open AutoDeck" restores; "Quit AutoDeck" exits. The app also starts hidden with Windows (`--hidden`). Only one copy can run; a second launch focuses the first.

---

## 4. Complete feature breakdown by module

Conventions: **UI** = elements, **Logic** = what happens, **Edge** = empty/invalid/failure handling.

### 4.1 Page shell, header and chrome
**UI:** brand mark (AD icon), "AutoDeck" + version chip (`v1.0.44`), tagline "Your workflow, on autopilot."; greeting pill with icon and live clock (bands: before 5 "Still up?", before 12 "Good morning", before 17 "Good afternoon", before 21 "Good evening", else "Winding down"); big date (weekday, month, day); stat chips "{n} to do", "{n} done", "{n} high priority" (pending High only), "next {time}" (earliest future reminder, with −lead/↻repeat markers); toolbar: **Bell**, **Sound**, **Export**, **Import**, **Settings**, **Theme**.
**Logic:** clock updates every second; chips are derived from today's tasks and reminder items. Page width grows with the window (max 64 rem → 72 → 80 → 96 rem).
**Edge:** no tasks → "No tasks yet. Add one to get started." instead of chips; narrow screens wrap the toolbar (`max-w-full`), no horizontal scroll to ~347 px.

### 4.2 Toolbar controls
| Control | Logic | Edge / messages |
|---|---|---|
| **Bell** (state dot green = on, grey = off/muted) | Not granted → requests permission; granted → toggles in-app mute ("Notifications muted." / "unmuted."); Android: asks the OS via the plugin | Browser without the API: "This browser doesn't support notifications."; denied: "Notifications are blocked. Enable them in your browser site settings."; Android denied: "Notifications are off. Allow them for AutoDeck in the phone settings."; result toasts "Notifications enabled." / "not enabled." Permission is re-synced on focus, visibility and permission change |
| **Sound** | Toggles all UI sounds; plays an "add" blip when turned on | Persisted |
| **Export** | Menu: PDF, CSV, Word, JSON (backup); closes on outside click | Items disabled when there are no tasks |
| **Import** | Opens a file picker (`.json`) | See 4.15 |
| **Settings** | Opens the dialog (4.13) | |
| **Theme** | Light ⇄ dark (class on `<html>`); initial value follows the OS preference | Persisted |

### 4.3 Update banner
**UI:** banner with download icon, text, progress bar, optional button. **Logic:** shown only in the desktop/Android apps while `downloading` or `ready`. **Edge:** errors are silent (state "error", retried later: Android waits 5 min after a failure); web never shows it.

### 4.4 Reminder banner (due reminders)
**UI:** sticky card at the top, bell icon, "{n} reminder(s) due", hint "Enable notifications for desktop alerts" (or "Sound muted"), **Snooze all** menu and **Dismiss all** (only with 2+), **Collapse/Show**; list (max height `max(9rem, 33vh)`, slim scrollbar) of rows: priority tile, full task text, OVERDUE badge (m/h/d), reminder label, priority badge, **Done**, **Snooze** menu, **View** (magnifier), **Dismiss** (✕; tooltip says "returns next interval" for repeating ones).
**Logic:** shows tasks and subtask reminders that are past their trigger (event time − lead), not done, not snoozed; ordered High→Low then by event time; styled by the top priority present; a banner of up to 3 rows sticks to the top, taller ones scroll with the page; a new reminder falling due re-opens a collapsed banner.
**Edge:** row text is never truncated; a subtask row reads "step (in task)"; muted state still shows the banner but silences sound/notifications.

### 4.5 View tabs
**UI:** pill bar **Tasks · Week · Daily Report · Archive** (Archive shows a count badge). On phones "Daily Report" reads "Report" and icons are hidden so all four fit; the bar scrolls inside itself if still too narrow. **Logic:** switches view; state is not persisted (opens on Tasks).

### 4.6 Progress dashboard (Tasks view)
**UI:** gradient ring with % (glow and pulse at 100%), "{done} / {total} done today", message. **Messages:** no tasks "Add your first task to get going."; 0% "Let's make a dent."; <50% "Good start. Keep the momentum."; <100% "More than halfway there!"; 100% "All done. Beautiful."; celebration "Everything done. You crushed today." (2.6 s). **Logic:** counts only today's tasks.

### 4.7 Add task form
**UI:**
- **Task box** (sparkle icon turns blue when typing; max 2000 chars; tooltip "Add a task. Press N anywhere to jump here"); **Add** button (muted when empty, glowing when there is text; tooltip "Add task (Enter)").
- **Pills:** Priority (three-bar symbol, tinted), Category (icon, tinted with its colour), Repeat (No repeat / Every day / Weekdays / Every week), **Subtasks** (count badge), **Remind me** (toggle pill → date, time, lead, repeat; custom minutes boxes).
- **Hints row** (empty box) and **Detected row** (while typing).
- **Subtasks panel:** step list (each with pencil = options, ✕ = remove, chips of its own options), input ("Add a step… (Enter). Paste a list to add several."), the same four pills for the step being typed.
**Logic:**
- *Parsing* (`parseQuickAdd`): categories `#name` (existing categories only, word start); priority `!high|!medium|!med|!low` (case-insensitive, word start); time `at 5pm`, `5:30 pm`, `@7am`, `at 17:30`, `@17:30`; invalid times (`25:99`) are left in the title; `tomorrow` removed from the title and moves the reminder to tomorrow, **only when a time was parsed**.
- *Precedence:* manual reminder editor wins over a parsed time; parsed values win over the dropdowns for priority/category.
- *Submit:* empty/whitespace → nothing. A half-typed subtask is included. Sound "add". Reminder → permission request.
- **N** shortcut focuses the box (ignored inside inputs/textareas/selects/editable areas, when a dialog or open list exists, or with Ctrl/Meta/Alt).
- Reminder editor: checking it without a time creates **no** reminder (nothing shown); custom lead/repeat minutes must be ≥ 1 (native validation blocks submit for invalid numbers); negative values are clamped to 0 in the data.
**Edge:** paste of >200 steps is capped at 200; step text capped at 500; Escape in the step box closes the panel; Backspace on an empty step box removes the last step; `Enter` in the step box never submits the task; category deleted in Settings → form falls back to the first category; a title of only shortcuts (e.g. `#work`) yields empty text and is not added.

### 4.8 Upcoming reminders panel
**UI:** collapsible card (count badge) with a table: Task, Priority, Due, Next, Frequency ("Once" / "N min before" / "Every N min"), Status, **Cancel reminder**, row click = View. **Logic:** future-trigger or snoozed reminders (not dismissed); sorted by when they next surface; includes subtask reminders. **Edge:** hidden when empty; table scrolls horizontally on narrow screens.

### 4.9 Search and filters
**UI:** search box ("Search tasks…"); pills **All, Active, Completed, High Priority** then one per category, each with a live count. **Logic:** status filters first; any other name is a category; search matches title text (case-insensitive) and the counts ignore the search. **Edge:** no match → "No matching tasks / Try a different filter or search."; a filter naming a deleted category shows nothing until "All" is chosen; a category named like a status filter is refused at creation.

### 4.10 Boards and task cards
**Boards:** "Pending" (sortable, drag handles) and "Completed", each with a count; sort = pinned first, undone before done, then manual order.
**Card UI:** drag handle (pending only), completion circle, priority tile (tooltip "High priority"), title (2-line clamp with "more/less"; double-click edits), subtask chip "done/total" with chevron, hover actions (**Subtasks, Add/Edit reminder, Edit, Pin/Unpin, Postpone to tomorrow, Duplicate, Delete**; floating on desktop hover, below the title on phones), badges (priority, category with icon, repeat "Daily/Weekdays/Weekly", "Overdue Nm", reminder label), subtask checklist, inline reminder editor, left border in the category colour, cards lift on hover.
**Logic per action:**
- *Complete:* toggles done (sounds differ); progress and filters update.
- *Edit:* inline input (max 2000); **Enter** saves, **Escape** cancels, blur saves; blank/whitespace keeps the old title.
- *Pin:* pinned cards sort first, subtle ring.
- *Postpone:* moves to tomorrow; reminder date follows; its subtasks' reminders follow; **a completed task becomes pending** (moving to a different day un-completes it).
- *Duplicate:* new task (undone, unpinned, new ids for subtasks, reminders re-armed); the copy keeps the reminder (so it can ring too).
- *Delete:* archived + Undo toast (5 s). Only the latest delete is undoable.
- *Reminder editor:* **Save reminder**, **Remove**, **Cancel**; saving re-arms (clears lastAlert and snooze).
- *Highlight:* "View" scrolls the card to centre and pulses it for 2.4 s.
**Edge:** overdue = reminder event time passed and not done; long unbroken text wraps; ARIA label summarises task, priority, category, reminder, overdue, subtask progress and done.

### 4.11 Subtasks (card and form)
**Row UI:** checkbox, text, chips of the step's own options, pencil (options), ✕ (delete). **Options editor:** the four pills (Same priority / Same category defaults). **Composer:** "Add a subtask…" + **Options** toggle. **Logic:** `done` independent of the parent; own reminders are alert items; own repeat resets the step on its next matching day; editing options re-arms its reminder only when the reminder actually changed. **Edge:** max 200 steps, 500 chars; opening the editor of a step with a reminder never re-arms it; a finished parent silences its steps' alerts.

### 4.12 Day handling rules (`normalizeForToday`)
Runs on load, at every date change, and on import. Applied to the **latest** state (never a stale snapshot) and returns the same objects when nothing changes.
1. **A completed task is untouched** (not archived, moved or reset), whatever its day.
2. A completed **repeating** task whose day has passed gets `spawned: true` and one new pending task `series@nextDate` (daily: today; weekdays: next Monday to Friday; weekly: same weekday), with its reminder and steps moved/refreshed. Never created twice (deterministic id).
3. An unfinished task with a past day gets `day = today`; a future-dated one stays. An unfinished repeating task moves to its next matching day.
4. Repeating **steps** of unfinished tasks reset; the steps of a completed task never do.
5. Legacy string reminders are upgraded; a snooze/dismiss survives restarts.
Pending shows today's unfinished tasks; **Completed shows every completed task (newest first)**; "done today" in the header and ring counts tasks checked off today (`completionDay`).

### 4.13 Reminder engine (shared)
- **Trigger** = event time − lead; **due** = trigger passed, not done, not snoozed/dismissed.
- **Alert** (once per due occurrence; again every `repeat` minutes if set): banner, sound (High → "alarm" unless disabled, Medium → "reminder", Low → "soft"; one sound per tick matched to the highest priority), notification (title "🔴 Reminder · High priority"; body = text + overdue duration; High `requireInteraction`; with the service worker, actions **✓ Done / 💤 Snooze 10m / View**).
- **Timing:** a timer is set for the next future moment (reminder time, snooze end, next repeat) with +15 ms; web uses `timer-worker.js` (a 15 s heartbeat as backup); a 20 s page interval keeps clocks and badges fresh; immediate checks on `visibilitychange`, window `focus`, `online`, and the desktop's `autodeck-wake` (sent on Windows resume).
- **Snooze** sets `snoozeUntil` and clears lastAlert; **Dismiss** sets the "dismissed" sentinel (or now+repeat for repeating); **Done** completes (a notification's Done never un-does).
- **Mute** skips sound/notification and the timers (the banner still shows).
- **Cleanup:** alerts on screen are closed when the item becomes done, deleted, snoozed or loses its reminder.
**Edge:** reminder time in the past fires immediately; max timer 2³¹−1 ms (longer waits rely on the 20 s check); permission denied → in-app alerts only; service worker unavailable (file:// desktop) → plain `Notification`, click restores the window.

### 4.14 Week view
**UI:** 7 day cards (today highlighted, "{n} open"), a "Later" card for tasks beyond day 7, each task row: circle, priority tile, title (2 lines, tap to expand), date, repeat and reminder-time markers; expanded row: **Move to date** (date input, min today), **Move to today** (not today), **Open** (today), **Delete**. **Logic:** groups by scheduled `day`; moving to another day un-completes the task and re-dates its (and its steps') reminders; a past date becomes today; clearing the date input does nothing. **Edge:** empty day shows "—"; the week rebuilds when the date changes.

### 4.15 Daily Report
**UI:** date picker (max today), status chip (Draft/Finalized, "shared <date>"), tiles Goals / Completed / Remaining / Progress + bar, goal input (today only) with **+**, goal list (toggle button, text, status badge Completed / In Progress / Pending), **Challenges / Blockers** and **Additional Notes** text areas, **Share with** input, buttons **Copy report**, **Download** (`daily-report-YYYY-MM-DD.txt`), **Copy & mark shared** (needs a name), history ("Previous reports": date, done/total · %, status).
**Logic:** today's goals are the live tasks of today (adding a goal creates a Medium/Work task); past dates show the saved snapshot (read-only toggles); every edit saves a snapshot of the goals; report text sections: Today's Goals, Progress, Completed Today, Remaining, Challenges/Blockers, Additional Notes, Shared With, Report Status ("- —" for empty parts). Clipboard failure is silent (use Download). **Edge:** clearing the date box is ignored; a day with no typed notes leaves no history entry.

### 4.16 Archive
**UI:** header (count, per-reason counts, **Keep …** menu, **Export CSV**, **Export JSON**), explanatory line, search box, filters (Why archived, Category, Priority, Sort, From, To, Clear filters), selection bar (Select all N shown / "N selected", **Restore selected**, **Delete selected**, **Empty archive**), day-grouped rows (checkbox, priority tile, title, **Restore**, delete-for-good trash; badges: priority, category, reason, "Was done", subtask count, archived time; expand for task day, repeat, reminder, steps).
**Logic:** entries are tasks + `archivedAt` + `reason` (Deleted / Completed / Replaced by import); search covers title and step text; bulk actions act only on **visible selected** rows; destructive actions ask for a second click ("Delete for good", "Delete N for good", "Yes, empty all N"); Restore → today, undone, unpinned, past reminders dropped, repeating reminders moved to today, steps' past reminders dropped; auto-clean by age (30/90/365 days or never) runs on load and daily; cap 3000 (oldest dropped); sorted newest/oldest (grouped by day), priority, A–Z. **Edge:** empty → "Archive is empty / Deleted tasks will appear here, ready to restore."; no match → "Nothing matches"; corrupt entries are filtered on load; CSV cells starting `= + - @` are prefixed with `'`.

### 4.17 Settings dialog
**UI/logic:** Desktop notifications (Currently On/Off/Muted; Enable/Mute/Unmute); Reminders when closed (desktop only; switch; explains tray and Windows start); Sound effects switch; Volume slider (0–100) + **Test** (disabled look when sound is off); Louder alarm for high priority; Defaults for new reminders (Lead, Repeat dropdowns pre-fill the editors); Categories (colour picker, name, ✕; the last category cannot be deleted; add with colour + name, Enter or **Add**; duplicate or blank names ignored). **Edge:** Escape closes only an open dropdown first, then the dialog.

### 4.18 Export and import
- **PDF** (title "Tasks for {weekday, month day}", table Task/Priority/Category/Status/Reminder/Subtasks, lazy-loaded jsPDF), **CSV** (UTF-8 BOM, CRLF, formula-safe), **Word** (.doc HTML, escaped), **JSON** (full backup). File names `today-todo-YYYY-MM-DD.ext`. Exports include every task currently in the list (not the Archive). Toast "Exported N task(s) to X."
- **Import:** `.json` ≤ 5 MB else "Import failed: the file is too large to be a backup."; not valid JSON or not an array → "Import failed: not a valid backup file."; accepts ≤ 5000 entries; each must be an object with a string `text`; text clipped to 2000; invalid priority → Medium; category clipped to 60 (blank → Personal); invalid times → 09:00; negative lead/repeat → 0; unknown repeat values → none; subtasks sanitised (≤ 200, ≤ 500 chars, own options validated); missing ids generated; result toast "Imported N task(s)" (+ "(M entries were not tasks and were skipped)"); the replaced tasks are archived; the result is passed through the day rules (old finished tasks are archived).

### 4.19 Dropdown component
Replaces every native select: button + floating list (body portal, z-70), colour/icon per option, tick on the chosen entry, placeholder entries not selectable, position under the button or above/inside the window as needed; closes on outside press, page scroll, resize, Tab, Escape; keyboard: ↑ ↓ Home End Enter Space and type-ahead (700 ms); roles `combobox`/`listbox`/`option` with `aria-activedescendant`.

### 4.20 Toasts and messages
Undo toast "Task deleted — Undo" (5 s); status toasts (4 s) for exports, imports, notification state, archive restore/delete. Undo and status toasts share the bottom centre.

### 4.21 Desktop (Windows) shell
Single instance lock; window 1100×820 (min 380×560), auto-hide menu bar; hides to tray on close (unless disabled); tray icon with tooltip "AutoDeck: reminders are running" and menu; starts with Windows hidden; remembers preference in `prefs.json`; permissions limited to notifications; links open only if `http(s)`; navigation locked to the bundled page; auto-update via electron-updater with a log file (`update.log`); timers never throttled (renderer backgrounding and native occlusion throttling disabled); sends a wake event on resume from sleep.

### 4.22 Android shell
Capacitor WebView with an "app-like" mode (no tap flash, text selection or overscroll; themed status bar; keyboard not auto-opened); notification channels (High importance 5, Medium 4, Low 3); alarms: each reminder (and repeating occurrences up to 8 ahead; up to 16 per task; recurring tasks 7 future days) as `setExactAndAllowWhileIdle` when permitted; restore after reboot; syncs are coalesced and serial, run 150 ms after a change and immediately when the app is hidden, cancel all pending first, and clear delivered notifications of finished tasks; tapping a notification opens the task; self-update through `ApkUpdatePlugin` (URL allow-list = this repo's releases, SHA-256 check).

---

## 5. Data models and storage logic

All data is JSON in the device's `localStorage` (Android WebView storage; Electron profile). No database, no backend.

| Entity | Key | Attributes |
|---|---|---|
| **Task** (`todo.tasks`) | `id` (uuid) | `text` ≤2000, `priority` (Low/Medium/High), `category` (name), `reminder`?, `recur`? (`daily`/`weekdays`/`weekly`), `done`, `pinned`, `day` (YYYY-MM-DD, local), `createdAt`, `order`, `subtasks[]` |
| **Reminder** (embedded) | n/a | `date`, `time` (HH:MM), `lead` (min ≥0), `repeat` (min ≥0), `lastAlert` (epoch ms or null), `snoozeUntil` (epoch ms, null, or the "dismissed" sentinel 8.64e15) |
| **Subtask** (embedded in Task) | `id` | `text` ≤500, `done`, optional `priority`, `category`, `recur`, `reminder`, `day` |
| **Archive entry** (`todo.archive`) | task `id` | Task fields + `archivedAt`, `reason` (`deleted`/`completed`/`replaced`) |
| **Daily report** (`todo.reports`) | date | `blockers`, `notes`, `sharedWith`, `status`, `sharedAt`, `snapshot[ {id,text,done,priority,subtasks} ]` |
| **Category** (`todo.categories`) | name | `color` (hex); defaults Work (#0ea5e9), Personal (#8b5cf6), Urgent (#f43f5e) |
| **Preferences** | key | `todo.dark`, `todo.sound`, `todo.volume` (0–1), `todo.hpAlarm`, `todo.muted`, `todo.remDefaults {lead,repeat}`, `todo.archiveKeep` (days, 0 = forever); desktop-only `prefs.json {background}` |

**Relationships:** Task 1—* Subtask (embedded); Task/Subtask 0..1 Reminder (embedded); Task *—1 Category (by name; a deleted category leaves a neutral badge); Archive entry is a Task snapshot; Report *snapshots* Tasks by value.
**Derived "reminder items":** every task reminder and every subtask reminder becomes an alert item (subtask items use id = step id, text "step (in task)", own or inherited priority, `done` = step or parent done); alert state is written back to the owning task or step.
**Integrity rules:** unknown/old shapes are sanitised on load (`reviveTasks`); changes from another window are adopted live; saves are whole-list writes (see limitations).
**Service worker / worker state:** none persisted.

---

## 6. Third-party integrations and APIs

| Service / library | Use |
|---|---|
| **GitHub Pages** | Hosts the web app |
| **GitHub Releases** | Windows installer + update metadata (electron-updater), Android APK downloads (checked via the project's release URLs) |
| **GitHub Actions** | Builds the Windows installer, deploys Pages, runs `npm test` before a release |
| **Google Fonts** (Plus Jakarta Sans) | Typography (the only third-party request besides updates) |
| **Web platform APIs** | `localStorage`, Notifications, Service Worker (actionable notifications), Web Worker (exact timer), Web Audio (sounds, no audio files), Clipboard, Blob/URL downloads, File input |
| **Capacitor + @capacitor/local-notifications** | Android alarms, channels, permission, boot restore |
| **Android system** | Exact alarms, notifications, package installer |
| **Electron + electron-updater** | Desktop shell, tray, autostart, updates |
| **UI libraries** | React 18, Tailwind CSS v4, lucide-react (icons), @dnd-kit (drag and drop), jsPDF + jspdf-autotable (PDF) |
No payment, authentication, maps, analytics or push-server services are used or required.

---

## 7. Non-functional requirements

**Performance.** Interactions are immediate at normal list sizes; task cards are memoised so ticking one task doesn't redraw the rest; alert timers are exact (0–0.1 s measured); sounds are generated (no audio files); PDF library is lazy-loaded. Hundreds of tasks were not benchmarked reliably.
**Reliability.** Corrupt/old saved data cannot blank the page; reminder state survives restarts; Android alarms are serialised and rebuilt on each change; cross-window live sync prevents most lost updates.
**Security.** Strict CSP (`default-src 'self'`; scripts and workers `'self'`); Electron: sandbox, context isolation, no node integration, IPC answered only for the app's own page, permission handler allows notifications only, external links http(s) only, webviews and new windows denied; Android: no backup, cleartext disabled, exact network config, update URL allow-list + SHA-256; imports sanitised, size-limited; CSV formula injection neutralised; HTML export escaped; pinned dependencies, pinned GitHub Actions, Dependabot.
**Privacy.** Data never leaves the device; no accounts, analytics or telemetry; the only network traffic is update checks and fonts.
**Platform compatibility.** Web: current Chromium/Firefox/Safari-class browsers (notifications and workers where supported); Windows 10+ (x64 installer); Android 7+ (API 24, target 36). iOS is not supported.
**Accessibility.** Keyboard operable (drag via keyboard, dropdown keys, Escape layering), accessible names on controls and cards, live status roles on the update banner, reduced-motion respected.
**Responsiveness.** Fluid from ~347 px phones to wide desktops; page max width scales up to 96 rem.
**Observability.** Desktop updater log (`update.log`); no remote logging.
**Quality gate.** `npm test` (20 checks: quick-add parsing, repeat rules, rollover across weekends/week-long gaps, import cleaning, reminder items, next-alert timing, archive restore, Android alarm times) runs in CI before any build; browser, timing and Android-simulation checks are manual.

### Known limitations (carried into the roadmap)
Android behaviour under vendor battery savers and on a real phone is unverified; no alerts when the web version's browser is fully closed; saves are whole-list (a window that missed an update can overwrite another's change); repeating tasks reappear by design (can read as "a completed task came back"); Duplicate copies the reminder; a Daily Report day is saved only when notes are typed; the UI lives in one ~3000-line component.
