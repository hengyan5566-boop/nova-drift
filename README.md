[![make.fun](https://make.fun/badge/best-game-01.svg)](https://make.fun/bounty/best-game-01)
[![Rank](https://make.fun/badge/best-game-01/hengyan5566-boop/nova-drift/rank.svg)](https://make.fun/bounty/best-game-01)
[![Reward](https://make.fun/badge/best-game-01/hengyan5566-boop/nova-drift/reward.svg)](https://make.fun/bounty/best-game-01)

# NOVA DRIFT

A neon twin-stick arena shooter, made for the
[make.fun best game bounty](https://make.fun/bounty/best-game-01).

You are the last pilot of the drift fleet. Survive escalating waves of
chasers, snipers and splitters, chain kills to raise your combo multiplier,
grab score orbs, and break the flagship that arrives every 5th wave.
Three lives, one shield pickup at a time, and a dash that makes you briefly
untouchable — spend it well.

## How to play

Open `game/index.html` in desktop Chrome, or serve the folder with any
static server:

```sh
npx serve game
```

- **WASD / arrows** — move
- **Mouse** — aim
- **Hold click or Space** — shoot
- **Shift** — dash (brief invulnerability, 2.2 s cooldown)
- **P** — pause
- **M** — mute
- **R** — restart

All art is drawn in code on a canvas and all sound is synthesised live
with WebAudio — no image, audio or font files, no network requests, no
libraries. Your best score is kept in the browser's local storage.

## Entry

`main.ts` (Node 22, standard library only) copies `game/` and
`screenshots/` to the output directory and writes `dossier.json` with the
kit's vendored library:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Screenshot staging (demo hooks)

The game reads three harmless URL parameters, used only to stage the
screenshots in `screenshots/`. They never affect normal play:

- `game/index.html?demo=1` — start at wave 3 with an autopilot flying the
  ship, so the action shot shows real combat.
- `game/index.html?state=boss` — jump straight into the wave-5 flagship
  fight (autopilot on).
- `game/index.html?state=gameover` — show the game-over screen with a
  plausible score.

## Layout

- `main.ts` — the entry program (copies the game and writes the dossier)
- `vendor/makefun-game.ts` — the kit's library, unchanged
- `game/index.html` — page shell
- `game/game.js` — the whole game: input, audio, waves, combat, rendering
- `game/style.css` — page presentation only
- `screenshots/` — four real renders of the game running in Chrome
