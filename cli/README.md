# Cric Flick CLI

A terminal client for [Cric Flick](https://crickflick.netlify.app) — play the full
game (auth, lobby, 1v1, vs-bot, tournaments, friends/challenges) from a terminal. It
connects to the production server by default, so there's nothing to configure.

## Install

Download the binary for your platform from the
[latest release](https://github.com/Mr-Agniv07/game_hand_cricket/releases/latest),
then run it.

**macOS (Apple Silicon)**
```sh
curl -L -o cricflick-cli https://github.com/Mr-Agniv07/game_hand_cricket/releases/latest/download/cricflick-cli-macos-arm64
chmod +x cricflick-cli
xattr -d com.apple.quarantine cricflick-cli   # unsigned binary — otherwise Gatekeeper blocks it
./cricflick-cli
```

**macOS (Intel)**
```sh
curl -L -o cricflick-cli https://github.com/Mr-Agniv07/game_hand_cricket/releases/latest/download/cricflick-cli-macos-x64
chmod +x cricflick-cli
xattr -d com.apple.quarantine cricflick-cli
./cricflick-cli
```

**Linux (x64)**
```sh
curl -L -o cricflick-cli https://github.com/Mr-Agniv07/game_hand_cricket/releases/latest/download/cricflick-cli-linux-x64
chmod +x cricflick-cli
./cricflick-cli
```

**Windows (x64)**

Download
[`cricflick-cli-windows-x64.exe`](https://github.com/Mr-Agniv07/game_hand_cricket/releases/latest/download/cricflick-cli-windows-x64.exe)
and run it from a terminal (or double-click it). Windows SmartScreen will likely warn
that it's from an unknown publisher the first time — click "More info" → "Run anyway".
This is expected for an unsigned binary; the source is this repo.

## Pointing it at a different server

By default the CLI talks to the production backend. To point it at a local dev server
instead:

```sh
CRIC_SERVER_URL=http://localhost:3001 ./cricflick-cli
```

(On Windows, set the environment variable first: `set CRIC_SERVER_URL=http://localhost:3001`
in cmd, or `$env:CRIC_SERVER_URL="http://localhost:3001"` in PowerShell.)

## Running from source

```sh
git clone https://github.com/Mr-Agniv07/game_hand_cricket
cd game_hand_cricket
pnpm install
cd cli
pnpm start
```

## Releasing a new binary build (maintainers)

Push a tag matching `cli-v*` and GitHub Actions builds and attaches binaries for all
four platforms automatically:

```sh
git tag cli-v1.0.0
git push origin cli-v1.0.0
```
