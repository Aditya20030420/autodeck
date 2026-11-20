# AutoDeck: Product Requirements Document

| | |
|---|---|
| **Product** | AutoDeck, "Your workflow, on autopilot." |
| **Version described** | 1.0.44 (20 Nov 2026) |
| **Owner** | Aditya Ganjoo |
| **Status** | Released on Web, Windows and Android; in active iteration |
| **Repository** | github.com/Aditya20030420/autodeck (public) |

---

## 1. Summary

AutoDeck is a single-user daily to-do app built around one idea: **the list is about today**. It resets every day, rolls unfinished work forward, clears away finished work (into an Archive), and makes sure you are told about the things that matter at the exact time they matter. It runs as a web page, a Windows desktop app and an Android app from one codebase, keeps all data on the device, and needs no account or server.

## 2. Problem and opportunity

Typical to-do apps pile up: old completed tasks clutter the list, unfinished ones get lost, and reminders are late, silent, or missing when the app is closed. People who plan their day (and report on it to a manager) want a list that stays small, a reminder system they can trust to the second, and a record of what they did.

**Opportunity:** a private, fast, offline-capable planner whose reminders are reliable on every platform and whose daily reset, archive and daily report remove the housekeeping.

## 3. Goals and non-goals

### Goals
1. **Focus on today.** Show only today's tasks; roll unfinished tasks forward; clear finished ones automatically without losing them.
2. **Fast capture.** Add a task in one line with natural language (`Email Sam at 5pm tomorrow #work !high`).
3. **Reminders you can trust.** Alerts fire at the scheduled time (target: under 1 second late) while the app is open, minimized, hidden in the tray, or in a background browser tab, and (Android) with the app closed.
4. **Never lose work.** Anything that leaves the list (deleted, cleared by the daily reset, replaced by an import) goes to a searchable Archive.
5. **Private by default.** All data is stored on the device. No account, no tracking, no backend.
6. **One product on three platforms**, updating itself.

### Non-goals (for now)
- Accounts, cloud sync, or sharing tasks between people or devices.
- Push notifications when the browser is fully closed (web) or on iOS.
- Collaboration, assignment, comments, attachments.
- Calendar integrations, location or email-based tasks.
- Long-horizon project planning (the Week view is the furthest horizon; everything else is "today").

## 4. Users

| Persona | Needs |
|---|---|
| **The daily planner** (primary) | A clean list for today; quick add; reminders on desktop and phone; ticks things off and moves on. |
| **The reporting professional** | A shareable end-of-day report (goals, done, remaining, blockers, notes) and a history of past days. |
| **The routine keeper** | Repeating tasks (daily / weekdays / weekly) with their own reminders and sub-steps. |

## 5. Platforms and distribution

| Platform | Technology | How it is obtained | Updates |
|---|---|---|---|
| Web | Vite + React, hosted on GitHub Pages | aditya20030420.github.io/autodeck | Instant (reload) |
| Windows | Electron, NSIS installer | GitHub Releases (`AutoDeck-Setup-x.y.z.exe`) | Automatic in the background; installs and restarts |
| Android | Capacitor, signed APK | GitHub Releases (`AutoDeck-x.y.z.apk`) | In-app update banner; downloads, verifies and hands to the installer |

Releases are cut by pushing a version tag; GitHub builds and publishes the Windows installer, the Android APK is built locally with the fixed signing key and attached to the same release.

## 6. Functional requirements

Priority: **P0** = core, **P1** = important, **P2** = nice to have. All items below are implemented in 1.0.44.

### 6.1 Tasks
| ID | Requirement | Pri |
|---|---|---|
| T-1 | Add a task from a single text box; press Enter or the Add button. | P0 |
| T-2 | **Quick-add parsing:** `at 5pm`, `5:30pm`, `@17:00` set a reminder; `tomorrow` (with a time) moves it to the next day; `#category` and `!high / !med / !low` set category and priority. Tags only count at the start of a word. | P0 |
| T-3 | Each task has a title (up to 2000 characters), priority (Low / Medium / High), category, optional reminder, optional repeat, optional subtasks. | P0 |
| T-4 | Complete / un-complete a task. **A completed task stays Completed until the user unchecks or deletes it**; the **Completed** board lists every completed task (newest first, with the day it was completed), not just today's. | P0 |
| T-5 | Inline edit (double-click or pencil), pin to top, duplicate, postpone to tomorrow, delete with **Undo** (5 s). | P0 |
| T-6 | Drag-and-drop manual ordering (pointer and keyboard). | P1 |
| T-7 | Search, status filters (All / Active / Completed / High Priority) and one pill per category, each with a live count. | P1 |
| T-8 | Press **N** anywhere to jump to the new-task box; tappable quick-add hint chips. | P2 |

### 6.2 Subtasks
| ID | Requirement | Pri |
|---|---|---|
| S-1 | Add subtasks when creating a task or later on the card; paste a multi-line list to create one per line. | P0 |
| S-2 | A subtask can have its **own priority, category, repeat and reminder** (empty means "same as the task"). | P1 |
| S-3 | A subtask reminder alerts like a task reminder, shown as "step (in task)"; Done on its alert completes only the step; View opens its task. | P1 |
| S-4 | A repeating subtask starts over on its next matching day. | P1 |

### 6.3 Reminders and alerts
| ID | Requirement | Pri |
|---|---|---|
| R-1 | A reminder has a date, a time, a **lead** (0 to 2 h or custom) and an optional **repeat until done** (5 to 120 min or custom). | P0 |
| R-2 | When due: an always-visible **banner** (ordered and coloured by priority, with an Overdue badge), a sound matched to the priority (loud alarm for High, configurable), and an OS notification where permitted (High stays until dismissed). | P0 |
| R-3 | Per-reminder **Done / Snooze (5 min to 1 h) / Dismiss / View**; **Snooze all / Dismiss all**; **Upcoming reminders** table. | P0 |
| R-4 | **Exact timing:** alerts fire at the scheduled second (measured: 0 to 0.1 s late on Windows minimized and in the tray; 0.1 s in a hidden browser tab). A timer is set for the next due moment; the web version uses a worker so a hidden tab's timers are not slowed; the app checks immediately on window show, tab visible, network back and Windows wake. | P0 |
| R-5 | **Android:** every reminder (task and subtask) is also scheduled with the phone's exact-alarm system, so it fires with the app closed; alarms are re-planned on every change, never overlap, and are cleared when a task is completed. | P0 |
| R-6 | A completed task's reminder never alerts; a delivered notification disappears when its task is completed, deleted or snoozed. | P0 |
| R-7 | Mute notifications; sound on/off and volume; louder alarm for High priority on/off; default lead/repeat for new reminders. | P1 |

### 6.4 Day handling
| ID | Requirement | Pri |
|---|---|---|
| D-1 | **Daily rollover** (local midnight, also while the app stays open and after sleep): unfinished tasks roll to today. **Completed tasks are never archived, moved or reset.** | P0 |
| D-2 | **Repeating tasks** (daily / weekdays / weekly): completing one keeps it Completed; on its next matching day a **new, independent pending occurrence** is created (id `series@date`, created once). Completing an occurrence never touches earlier ones. A weekdays task completed on Friday gets its next occurrence on Monday. | P0 |
| D-3 | **Week view:** 7 days plus a "Later" group; complete, reschedule (date picker, past dates become today) or delete from there. Moving a task to another day un-completes it and moves its reminder. | P1 |

### 6.5 Archive
| ID | Requirement | Pri |
|---|---|---|
| A-1 | Everything the user deletes, and everything an import replaces, is kept: **Deleted** and **Replaced by import** (older saves may also hold **Completed** entries). **Restoring keeps the task's completion status.** | P0 |
| A-2 | Search (including subtask text), filter by reason, category, priority and archived-date range; sort newest / oldest / priority / A-Z; grouped by day. | P1 |
| A-3 | Restore one or many to today (a passed reminder is dropped); delete for good with confirmation; empty the archive with confirmation. | P1 |
| A-4 | Export the shown entries as CSV or JSON; optional automatic clean-up (keep for ever / 30 days / 90 days / 1 year); capped at 3000 entries. | P2 |

### 6.6 Daily Report
| ID | Requirement | Pri |
|---|---|---|
| P-1 | Turn today's tasks into a report: goals, completed, remaining, progress %, blockers, notes, shared-with, Draft or Finalized status. | P1 |
| P-2 | Copy, download as text, or "copy and mark shared"; per-date history snapshotted so past days survive the daily reset. | P1 |

### 6.7 Data, import and export
| ID | Requirement | Pri |
|---|---|---|
| X-1 | Export tasks as **PDF, CSV, Word (.doc) or JSON backup**; CSV neutralises spreadsheet formulas; subtask options are written next to each step. | P1 |
| X-2 | Import a JSON backup: file size limit (5 MB), every field validated and cleaned (priorities, times, repeat values, text length, subtask options); the tasks it replaces go to the Archive. | P0 |
| X-3 | Data lives in the device's local storage; **other windows of the same page stay in sync live**. Older saved formats are upgraded on load so a stale save can never blank the page. | P0 |

### 6.8 Settings, appearance and accessibility
| ID | Requirement | Pri |
|---|---|---|
| U-1 | Light and dark themes; glassmorphic design; fits phone, tablet and wide desktop windows (page grows with the window); no sideways scrolling down to about 347 px. | P0 |
| U-2 | Custom categories (add, recolour, delete; names that clash with the status filters are refused); each category and priority has a symbol (priority: three signal bars; category: a fitting icon). | P1 |
| U-3 | Styled dropdowns everywhere (mouse, touch and keyboard: arrows, Home, End, Enter, Escape, type-ahead); controls have accessible names; Escape closes only the topmost layer. | P1 |
| U-4 | Desktop: "Reminders when closed" keeps the app in the tray and starts it with Windows so reminders arrive with the window closed. | P0 |

## 7. Key behaviours and rules

1. **A task's life:** added today, shown in Pending, completed → Completed board, **stays there for good**. Deleting it moves it to the Archive; restoring brings it back as it was. Only repeating tasks create a new pending occurrence on their next matching day.
2. **Completing is final.** A task stops being completed only when the user unchecks it (an older one then returns to Pending for today). Moving it to another day, restoring, importing, duplicating (which makes a separate pending copy), reminders and restarts never change it.
3. **Reminder precedence:** the manual reminder editor wins over a time parsed from the title; a time of day in the past fires immediately.
4. **Subtask reminders** are separate alert items with their own ids; they stop when the step or its task is completed.
5. **Nothing is silently lost:** delete, daily clear and import-replace all archive; the Archive can be cleaned only by the user (or the optional age limit).

## 8. Data model (stored locally)

- `todo.tasks`: task { id, text, priority, category, reminder { date, time, lead, repeat, lastAlert, snoozeUntil }, recur, done, pinned, day, createdAt, order, subtasks[ { id, text, done, priority?, category?, recur?, reminder?, day? } ] }
- `todo.archive`: task + { archivedAt, reason }
- `todo.reports`: per-date report { blockers, notes, sharedWith, status, snapshot }
- Preferences: categories, theme, sound, volume, high-priority alarm, muted, reminder defaults, archive keep-days.

## 9. Non-functional requirements

| Area | Requirement | Status |
|---|---|---|
| **Reminder accuracy** | Under 1 s late while the app is open, minimized, in the tray, or in a hidden tab; Android alarms exact (exact-alarm permission, restored after reboot). | Measured on Windows and in Edge; Android verified with a simulated alarm system only |
| **Privacy** | No accounts, analytics or servers; the only network use is checking GitHub for updates (and Google Fonts). | Met |
| **Security** | Strict content-security policy; sandboxed Windows renderer, one trusted page, http(s)-only external links, notification-only permissions; Android: no cloud backup, https only, updater accepts only this project's release URLs with a checksum; imports and CSV are sanitised; pinned dependencies and Actions, Dependabot enabled. | Met |
| **Reliability** | Corrupt or old saved data never crashes the app; cross-window overwrite protection via live sync. | Met (whole-list saves can still overwrite a missed update, see section 12) |
| **Performance** | Instant interaction at normal list sizes; cards update individually. | Tested lightly; hundreds of tasks not measured reliably |
| **Compatibility** | Current Chromium-based browsers; Windows 10 and later; Android 7 (API 24) and later. | Met |
| **Accessibility** | Keyboard operable, accessible names, reduced-motion respected. | Largely met; no formal audit |
| **Quality gate** | Automated tests (`npm test`, 20 checks of the logic) run before every release build; the rest is manual. | Partial |

## 10. Release and operations
- Version in `package.json`; a pushed tag `vX.Y.Z` triggers the release workflow (tests, then installer build, then publish).
- Android APK built locally (`npm run android:apk`, about 2 to 6 minutes) with the fixed signing key; uploaded to the same release.
- Windows installer self-updates every 10 minutes and at start, wake and window focus; the Android app checks every minute while open.
- Rollback = publish a higher version with the fix (updaters only move forward).

## 11. Success metrics (single-user product; measured by use and tests)
| Metric | Target |
|---|---|
| Reminder lateness (open, minimized, tray, hidden tab) | Under 1 s, 99% of alerts |
| A completed one-off task reappearing as Pending | 0 occurrences (guarded by tests) |
| Data loss incidents (task gone with no Archive entry) | 0 |
| Time to add a task | Under 5 s, one line |
| Crash or blank screen on load | 0 |

## 12. Known limitations, risks and open questions
1. **Android on a real phone is untested** by the author's tooling; behaviour under vendor battery savers (Doze, OEM task killers) cannot be guaranteed.
2. **No alerts when the web version's browser is closed** (no push server); the desktop and Android apps cover this.
3. **Whole-list saves:** two windows on the same storage can overwrite each other if one misses an update. Mitigated by live sync; a per-task merge is the proper fix.
4. **Open question:** whether very old completed tasks should eventually be hidden or archived by the user on request (they are kept for ever by design).
5. **Duplicate copies the reminder**, so completing the original leaves the copy's alarm.
6. **A day's report is only saved when you type into it**, so a day with no notes leaves no history.
7. **Single-file UI** (`src/TodoApp.jsx`, about 3000 lines): fast to iterate, increasingly costly to maintain; consider splitting by area.
8. iOS is out of scope (needs a different distribution model and push server).

## 13. Roadmap candidates (not committed)
- Per-task merge on save (fixes limitation 3) and idempotent "mark done".
- Completed-repeating-task labelling and a reset notice; keep-completed option for Postpone / Restore.
- Optional cloud sync with end-to-end encryption.
- Home-screen widget and quick-add share target on Android.
- Wider automated test coverage (UI flows), formal accessibility audit.
- Split the main component into feature modules.

## 14. Test strategy
- **Automated (`npm test`):** quick-add parsing, repeat rules, day rollover (with a fake clock across weekends and week-long gaps), import cleaning, reminder items for subtasks, next-alert timing, archive restore, Android alarm times.
- **Manual / scripted:** browser runs for every UI flow; timing measured on the installed Windows app (minimized, tray) and in a real hidden Edge tab; Android alarm sync checked against a simulated plugin.
- **Release gate:** tests pass in the GitHub build before anything is published.
