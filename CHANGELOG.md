# Changelog

## 0.4.4 - 2026-09-13

- Running-task text now becomes a pending message with Steer now, Send next turn and Cancel buttons; `/pending` restores pending cards.
- Uses native `turn/steer` with `expectedTurnId` and exact text, preserving the active task and its policies.
- Explicit next-turn choices run after successful completion and worker release; messages are batched in arrival order. Interrupted/failed tasks and desktop occupation pause the queue.
- Serialized Telegram actions and queue dispatch; protected against duplicate clicks, turn replacement, late responses and ambiguous delivery. Pending text remains memory-only for 30 minutes and is discarded on restart.

## 0.4.3 - 2026-09-13

- Forwarded MCP form confirmations to Telegram with explicit accept, decline and cancel actions, plus buttons for simple boolean/enum fields.
- Added validated `/mcp` replies, request expiry, turn binding, delivery-race cleanup and support for request ID reuse after worker restart.
- Added `/guide`, pending MCP counts and actionable recovery guidance when an operation cannot finish.
- URL flows hide query parameters and require completion on the Mac before acknowledgement. Sensitive or unsupported forms remain declined; browser login and macOS permissions are not changed.

## 0.4.2 - 2026-09-13

- Replaced separate submitted/completed notifications with one Telegram status card that is edited in place.
- Confirmed worker release before displaying that the desktop can take over the session.
- Automatically removes successful completion cards after 30 seconds while retaining interrupted and failed results.
- Prevented very fast turns from leaving a stale submitted notification after completion.

## 0.4.1 - 2026-09-13

- Added explicit Telegram confirmation for releasing the ChatGPT desktop Codex backend and taking over a selected session.
- Added strict process identity, parent, user, uniqueness, and second-snapshot checks before sending `SIGTERM`.
- Added automatic writer release after task completion and after an unused two-minute takeover reservation.
- Added `/release` for the Bridge's own temporary writer.
- Added direct Telegram document and photo return paths for changed or linked task outputs.
- Kept `workspace-write`, native `auto_review`, explicit directory grants, and exact-host network policy checks.
- Made the launcher portable and changed new installations to trust no network domains by default.

Earlier versions were private development iterations and are not supported as public releases.
