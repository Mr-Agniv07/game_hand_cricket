# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cric Flick — a real-time 2-player hand-cricket game. Two browsers join a room with a
short code, do a toss, then bat/bowl across two innings by each picking a number 1–6
per ball; matching numbers = OUT. All game rules and state live on the server; the
client is a thin renderer driven by socket events.

## Package manager

Use **pnpm**, not npm. This is a **pnpm workspace**: the root `package.json` owns the
`packageManager` pin (`pnpm@10.33.0`), and there is a single `pnpm-lock.yaml` at the
root. `pnpm-workspace.yaml` lists three member packages: `server`, `client`, and
`shared/*` (currently just `shared/types`).

The whole codebase is **TypeScript** under `strict` mode. There is **no build/emit
step for types** — the only check is `tsc --noEmit`. `vite build` and a successful boot
do **not** validate types (esbuild/Node strip them blind), so **green `tsc` is the
definition of "it compiles".** Always run `pnpm typecheck` before considering TS work
done.

## Layout & commands

A pnpm workspace with three member packages. Dependencies are installed once from the
root and hoisted into the root `node_modules`.

From the **repo root**:
- `pnpm install` — installs everything.
- `pnpm dev` — runs **both** dev servers in parallel (`pnpm -r --parallel run dev`).
- `pnpm dev:server` / `pnpm dev:client` — run just one (`--filter`).
- `pnpm start` — runs the server.
- `pnpm typecheck` — `tsc --noEmit` across all packages (`pnpm -r run typecheck`).
- `pnpm build` / `pnpm preview` — client production build (`tsc --noEmit && vite build`) / preview.

The member packages keep their own scripts and can still be run from their own
directory (e.g. `cd server && pnpm dev`):

- **shared/types/** — `@cric/types`, a **type-only** package: the socket/API contract
  (`GameState`, event payloads, `ServerToClientEvents` / `ClientToServerEvents`) defined
  once and consumed by both ends via `import type`. Nothing here is loaded at runtime, so
  there's no build — both sides just type-check against it.
- **server/** — Node + Express + Socket.io, ES modules (`"type": "module"`),
  TypeScript run via **tsx**.
  - `pnpm dev` — `tsx watch index.ts`, auto-restart (use this while developing)
  - `pnpm start` — `tsx index.ts`
  - `pnpm typecheck` — `tsc --noEmit`
  - Listens on `PORT` env or `3001`.
  - Imports use explicit `.ts` extensions (`./db.ts`).
- **client/** — React 19 + Vite (`.tsx` handled natively).
  - `pnpm dev` — Vite dev server
  - `pnpm build` (typecheck + build), `pnpm typecheck`, `pnpm preview`
  - Server URL comes from `VITE_SERVER_URL` (defaults to `http://localhost:3001`), see `client/src/socket.ts`.

`verbatimModuleSyntax` is on everywhere, so type-only imports **must** use
`import type { … }` (a plain `import` of a type errors).

There are no tests or linters configured (but `tsc --noEmit` is now a real check — see above).

## Architecture

**The server (`server/index.ts`) is the single source of truth.** It holds every
room's full `gameState` in an in-memory `Map` (`rooms`) — nothing is persisted, so a
server restart drops all in-progress games. The client mirrors state purely by
listening to socket events; it never computes scores, winners, or whose turn it is.

Phase machine (`room.phase`): `waiting → toss_call → bat_bowl → innings → result`.
The client's `App.tsx` has a parallel `phase` state driven entirely by server events,
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
  `App.tsx` guards binding with a `bound` ref and intentionally omits cleanup. React
  StrictMode (dev) double-invokes effects and Vite HMR remounts; disconnecting on
  cleanup drops the player from their room and triggers the server's disconnect
  teardown mid-match.
- **Drive UI unlock/reset off authoritative server state, never off a transient
  prop set-then-null.** `GameScreen.tsx` resets the numpad lock (`myMove`) on
  `useEffect(..., [balls, currentInnings])`, *not* inside the `lastBall` effect. At the
  innings break the server emits `ball_played → innings_start → state` back-to-back, so
  `lastBall` is set then nulled in one React batch — a `lastBall`-keyed reset would be
  skipped and freeze the numpad for the entire 2nd innings, for both players.
- **Guard stale `setTimeout` phase transitions.** The toss-result timer only advances
  `toss_call → bat_bowl` if still in `toss_call`, so a fast opponent can't get clobbered
  back to an earlier phase.
- **Server keeps rooms alive through brief disconnects.** `disconnect` starts an 8s
  grace timer before tearing down the room, so HMR/StrictMode blips don't end games.

## Client entry & types

The client entry is `client/src/main.tsx` (referenced from `client/index.html`).
Client-only types (`ClientUser`, `AppPhase`, `RematchState`) live in
`client/src/types.ts`; everything describing the wire contract lives in `@cric/types`.
The old Vite-template starter cruft (`counter.ts`, `main.ts`, `style.css`) has been
removed.
