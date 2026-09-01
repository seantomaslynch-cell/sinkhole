# Sinkhole

A one-input press-your-luck descent.

**Hold to fall. Release to climb. Everything you carry slows the way back.**

See [GAME_DESIGN.md](GAME_DESIGN.md) for the design and the measured balance.

## Run it

```bash
node serve.js
```

Then open http://localhost:5178. There is no build step — what you run locally
is byte-for-byte what ships.

## Shipped bundle

| File | Purpose |
| --- | --- |
| `index.html` | markup; loads the Bridge SDK as the first script |
| `style.css` | all styling, including the platform pause lockout |
| `game.js` | the entire game |
| `playgama-bridge-config.json` | ad placements, banner placement, leaderboard + SaaS token |

**Total: 78 KB uncompressed, 24 KB zipped.** All art is canvas-drawn and all
audio synthesised at runtime, so there are no asset files. The platform limit is
30 MB, so there is enormous headroom for later content.

`serve.js`, `build_zip.py`, `make_covers.py` and `playables_check.py` are
development tooling and are deliberately excluded from the bundle.

## Certification

```bash
pip install playwright && playwright install chromium
python playables_check.py index.html
```

Adapted from the Endless Core harness, so it already encodes the requirements
that previously caused Mediacube rejections. Static scan plus a headless run
against a mocked Bridge SDK. Current status: **47/47 passing.**

Beyond the platform requirements it also guards three things specific to this
game, each of which caught a real bug during development:

- **Determinism / fixed timestep.** Two identical scripted runs must produce
  identical numbers. This is what lets the balance harness stand in for real
  play instead of merely approximating it.
- **Graceful degradation.** With rewarded ads unsupported, no reward button may
  be offered; with no SDK present at all, the game must run, save and complete
  without throwing.
- **Content reachability.** Every authored stratum must be reachable at max
  gear. This caught three unreachable strata and two hazards no player would
  ever have seen.

## Where this gets published

**This is an HTML5 web game. It is not an App Store build** — there is no
Capacitor wrapper, no iOS/Android project, and no store assets. See "The App
Store gap" below if that is ever wanted.

Publish through **Playgama**, which is what the Bridge SDK integration is for:

1. Create an account at `developer.playgama.com`.
2. Upload `sinkhole-playgama.zip` (built by `build-zip` below).
3. Playgama runs QA and certification. Typical time to live: **2–4 weeks**.

Going direct to YouTube is *not* required and is in fact the harder path. The
[Playables Developer Portal](https://developers.google.com/youtube/gaming/playables/developer_portal)
is Private Preview, invitation only, and needs channel-manager permission on a
YouTube channel already onboarded to Playables. But per
[Playgama's own documentation](https://wiki.playgama.com/platforms/how-to-publish-your-game-on-youtube-playables),
**Playgama submits to YouTube Playables on your behalf** and deals with
YouTube's partnership team directly — developers do not need their own portal
access. One upload reaches Playgama's portal, YouTube Playables, and the other
HTML5 destinations Bridge covers.

The game is also fully playable with no SDK present at all (regression-tested),
so self-hosting and other portals are available with the same bundle.

## Submission checklist

| | Status |
| --- | --- |
| HTML5, self-contained, no external calls | done (only the Bridge SDK script) |
| Initial size under 30 MB | done — **24 KB zipped** |
| Playgama Bridge SDK integrated | done |
| Portrait supported (mandatory), landscape optional | done — both regression-tested |
| No embedded analytics (GA4 etc.) | done — none present |
| No external registration/login to play | done |
| Interstitial + rewarded ads wired and declared | done |
| **Advanced banners** (menu placements only) | done |
| **SaaS leaderboard** (submit + in-game render) | done |
| `sinkhole-playgama.zip`, `index.html` at the root | done — `python build_zip.py` |
| Playgama SaaS `publicToken` | **outstanding — needs you** |
| Cover art: 1920×1080, 1080×1920, 800×800 | done — `python make_covers.py` |
| Playgama developer account | **outstanding — needs you** |

`playables_check.py` prints a SUBMISSION READINESS section that tracks the
outstanding items separately from the technical pass/fail, so a missing cover or
an unreplaced token cannot be forgotten on the way to upload.

### Build the ZIP

```bash
python build_zip.py
```

Verifies `index.html` sits at the archive root, the archive is not corrupt, and
the bundle is inside the 30 MB initial-load limit.

### Cover art

```bash
python make_covers.py
```

Writes all three sizes to `store-assets/playgama-covers/`. It is parametric
rather than hand-drawn PNGs: it uses the same palette and the same primitives
the game renders with, so the covers cannot drift from the game's look — re-run
it after any art change instead of editing an image. Layout adapts per aspect
rather than scaling one composition, because a landscape composition becomes an
unreadable letterbox at 1080×1920.

Covers live outside the shipped bundle and are uploaded separately as listing
assets — `build_zip.py` never includes them.

### The public token — the last mile

The SaaS `publicToken` only exists once the game entry has been created in the
Playgama developer dashboard, so it cannot be committed ahead of time. When you
have it:

```bash
python set_token.py <public-token>
```

That writes the token into `playgama-bridge-config.json` (a surgical one-line
edit, not a JSON round-trip that would reformat the file), re-validates the
JSON, and rebuilds the ZIP — because a ZIP built before the token was set still
contains the placeholder and nothing about the filename would tell you. It
rejects obvious paste mistakes (a whole URL, a quoted string) rather than
letting them reach moderation two weeks later.

`python set_token.py --show` reports what is currently configured, and
`build_zip.py` prints a loud warning if you build while the placeholder is
still in place.

Until the token is set the leaderboard reports `type: 'not_available'` and the
game degrades to an "unavailable" toast — verified, not assumed. Nothing else
is affected, so a placeholder build is still uploadable; it just has a dead
leaderboard button.

## The App Store gap

Sinkhole is deliberately web-first. Shipping it to the App Store would need, at
minimum: a Capacitor wrapper and `package.json`, generated `ios/` and `android/`
projects, app icons and launch screens, store screenshots, a privacy policy and
support page, an AdMob path to replace Bridge ads on native, and a CI config for
building without a Mac. Endless Core carries all of that and is the template to
copy from if this game ever earns the port.

## Platform notes

- **Ads.** Pre-roll is handled by the host with no integration. Interstitials
  fire at run end, gated to ~90s apart. Two rewarded placements:
  `sinkhole-relight` (once per run) and `sinkhole-2xhaul`. Reward buttons are
  hidden entirely when the host cannot serve them.
- **Advanced banners.** `menu_idle`, 7% height, pinned to the bottom. Shown only
  on screens that fit one viewport with empty space beneath the buttons — the
  start screen and the two result screens. Hidden during a run, and hidden on
  the Outfit and leaderboard screens because those scroll internally and a fixed
  banner could cover a control the player is reaching for. `body.banner` adds
  matching bottom padding to every overlay so nothing is ever occluded.
- **Leaderboard.** Playgama SaaS, id `sinkhole_deepest_dive`, scored on deepest
  metres reached in a single run and submitted at every run end. Hosts with
  their own leaderboard UI get `showNativePopup`; hosts without one return raw
  entries that the game renders itself. That in-game renderer builds DOM nodes
  and sets `textContent` rather than interpolating an HTML template — entry
  names are other players' input — and deliberately does not render player
  photos, since those are remote URLs and the bundle must make no external
  network calls. Both are regression-tested, injection included.
- **No master mute.** The design requirements forbid an in-game mute control;
  audio state arrives only from the host.
- **Fixed timestep.** The simulation advances in exact 1/60 steps; only
  rendering is tied to frame rate. This keeps physics and feel identical at 30,
  60 and 120 fps, and prevents fast-moving rocks tunnelling through the diver at
  low frame rates.
- **Canvas sizing.** Logical height is fixed at 640; logical *width* tracks the
  live viewport aspect and is recomputed on every resize. Safe only because
  nothing stores an absolute x — treasure, rocks and snags are a depth plus a
  fraction of the shaft half-width, and the diver's x derives from the swing each
  frame. Freezing the width at load and CSS-stretching (the more common pattern)
  renders progressively distorted after any resize.
- **Saves.** `localStorage` is the synchronous store; `bridge.storage` is
  mirrored on top with a synchronously-stamped `savedAt`, so a stale platform
  snapshot can never overwrite fresher local progress.

## Known limitation

Real-time feel has not been observed at 60 fps in a live browser — the
development environment never runs `requestAnimationFrame`. The fixed timestep
means the simulation is provably identical to what the harness measured, and the
responsiveness numbers in GAME_DESIGN.md are real, but **rendering** smoothness
and audio timing on a real device remain unobserved. Play it once on hardware
before building anything on top of it.
