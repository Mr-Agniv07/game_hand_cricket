# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cric Flick — a real-time 2-player hand-cricket game. Two browsers join a room with a
short code, do a toss, then bat/bowl across two innings by each picking a number 1–6
per ball; matching numbers = OUT. All game rules and state live on the server; the
client is a thin renderer driven by socket events.

## Package manager

Use **pnpm**, not npm (both packages declare `packageManager: pnpm@10.33.0`).

## Layout & commands

Two independent packages with their own `node_modules` — there is no root workspace.
Run each in its own terminal from its own directory.

- **server/** — Node + Express + Socket.io, ES modules (`"type": "module"`).
  - `pnpm install`
  - `pnpm dev` — nodemon, auto-restart (use this while developing)
  - `pnpm start` — plain `node index.js`
  - Listens on `PORT` env or `3001`.
- **client/** — React 19 + Vite.
  - `pnpm install`
  - `pnpm dev` — Vite dev server
  - `pnpm build`, `pnpm preview`
  - Server URL comes from `VITE_SERVER_URL` (defaults to `http://localhost:3001`), see `client/src/socket.js`.

There are no tests, linters, or typecheck scripts configured.

## Architecture

**The server (`server/index.js`) is the single source of truth.** It holds every
room's full `gameState` in an in-memory `Map` (`rooms`) — nothing is persisted, so a
server restart drops all in-progress games. The client mirrors state purely by
listening to socket events; it never computes scores, winners, or whose turn it is.

Phase machine (`room.phase`): `waiting → toss_call → bat_bowl → innings → result`.
The client's `App.jsx` has a parallel `phase` state driven entirely by server events,
and renders one screen component per phase (`Lobby`, `TossScreen`, `BatBowlScreen`,
`GameScreen`, `ResultScreen`, plus the `InningsEndOverlay`).

Per-ball flow: both players emit `play_move`; the server buffers them in
`room.pendingMoves` and only resolves the ball once **both** have submitted, then emits
`ball_played` and either a fresh `state` or an innings/game transition. Roles swap and
`currentInnings` flips to 1 at the innings break (`endInnings`). Player/innings score
alignment at game-over is deliberately un-obvious because roles are swapped by then —
see the comments in `endInnings`.

### Socket event vocabulary (server → client)

`room_created`, `state` (authoritative snapshot via `publicState`), `toss_start`,
`toss_result`, `innings_start`, `ball_played`, `move_received`, `innings_end`,
`game_over`, `opponent_disconnected`, `error`. Client → server: `create_room`,
`join_room`, `toss_call`, `bat_bowl_choice`, `play_move`.

## Realtime/React gotchas (these are load-bearing — don't "simplify" them away)

These patterns exist because of bugs that were fixed; reverting them reintroduces
freezes:

- **Bind socket listeners exactly once and never disconnect on effect cleanup.**
  `App.jsx` guards binding with a `bound` ref and intentionally omits cleanup. React
  StrictMode (dev) double-invokes effects and Vite HMR remounts; disconnecting on
  cleanup drops the player from their room and triggers the server's disconnect
  teardown mid-match.
- **Drive UI unlock/reset off authoritative server state, never off a transient
  prop set-then-null.** `GameScreen.jsx` resets the numpad lock (`myMove`) on
  `useEffect(..., [balls, currentInnings])`, *not* inside the `lastBall` effect. At the
  innings break the server emits `ball_played → innings_start → state` back-to-back, so
  `lastBall` is set then nulled in one React batch — a `lastBall`-keyed reset would be
  skipped and freeze the numpad for the entire 2nd innings, for both players.
- **Guard stale `setTimeout` phase transitions.** The toss-result timer only advances
  `toss_call → bat_bowl` if still in `toss_call`, so a fast opponent can't get clobbered
  back to an earlier phase.
- **Server keeps rooms alive through brief disconnects.** `disconnect` starts an 8s
  grace timer before tearing down the room, so HMR/StrictMode blips don't end games.

## Cruft to ignore

`client/src/counter.ts`, `client/src/main.ts`, and `client/src/style.css` are leftover
Vite-template starter files and are not part of the app (entry is `main.jsx`).
