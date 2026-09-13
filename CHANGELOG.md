# Changelog

## 0.4.1 - 2026-09-13

- Added explicit Telegram confirmation for releasing the ChatGPT desktop Codex backend and taking over a selected session.
- Added strict process identity, parent, user, uniqueness, and second-snapshot checks before sending `SIGTERM`.
- Added automatic writer release after task completion and after an unused two-minute takeover reservation.
- Added `/release` for the Bridge's own temporary writer.
- Added direct Telegram document and photo return paths for changed or linked task outputs.
- Kept `workspace-write`, native `auto_review`, explicit directory grants, and exact-host network policy checks.
- Made the launcher portable and changed new installations to trust no network domains by default.

Earlier versions were private development iterations and are not supported as public releases.
