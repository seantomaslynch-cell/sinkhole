# GAME_DESIGN — Sinkhole (v0.1, implemented)

## Identity

- **Title:** Sinkhole
- **Pitch:** You drop into a collapsing sinkhole on a winch line. Deeper is worth
  more. Your lamp is the only clock. Everything you carry slows the climb back.
- **Player fantasy:** "I knew I should have turned around."
- **Audience:** broad casual. Playables users skew adult and arrive by impulse
  tap from a homepage tile, not by deliberate download.
- **Tone:** quiet, tense, unglamorous. No gore, no jump scares — the pressure is
  entirely arithmetic.
- **Portfolio role:** the short-session, high-ad-density entry point that feeds
  Scrapshine and Endless Core through same-developer recommendations.

## Controls

**Hold anywhere to descend. Release to ascend.** One input, nothing else.
Pointer and keyboard (Space / ArrowDown) are both wired; Escape is deliberately
left alone because the platform reserves it.

## The one interesting decision

Weight versus depth.

- Descending is a fixed ~195 px/s, and *faster* the heavier you are.
- Ascending is `168 / (1 + weight × weightFactor)` — *slower* the heavier you are.
- The lamp burns at 1×, or 3× inside gas.

Every pickup simultaneously raises the payout and the cost of collecting it. The
only question the game ever asks is *when to turn around*, and it asks it about
every ten seconds.

## The swing (why one input is enough)

The diver hangs on a line and swings. Swing amplitude derives from vertical
speed, so a single input drives two coupled axes:

- **Falling fast** → wide swing → reaches treasure near the walls, and snags.
- **Hovering** (rapid tapping) → narrow swing → threads the middle safely.

No extra button, no lateral control, and the skill ceiling comes free.

## Pickups

Auto-collected within `COLLECT_RADIUS` 30, with a magnet at radius 64.

**The magnet only works while descending.** This is load-bearing. With the
magnet also live on the climb, the ascent force-fed weight onto the diver, so a
turnaround that looked survivable still failed — every simulated margin from
0.95 down to 0.55 lost. Gating it to the descent is what makes the climb
estimate honest. Anything swung directly into on the way up is still collected.

| Type | Value | Weight | Appears |
| --- | --- | --- | --- |
| Coin | 5 | 1 | everywhere |
| Gem | 18 | 3 | Limestone and below |
| Relic | 70 | 9 | Bone Cathedral and below |

## The climb-home reserve (the key HUD element)

The lamp bar carries a hatched reserve on its right end showing what the climb
home costs *right now*, in seconds. It grows as you descend and as you load up,
and brightens when the climb exceeds the lamp you have left.

Two things make it honest, and both were found by simulation rather than by
reasoning:

1. **The magnet is descent-only** (above), so weight does not balloon mid-climb.
2. **`climbCost()` counts gas.** A plain `depth / speed` estimate ignores that
   gas burns 3× — so it declares a climb through a gas band affordable when it
   costs three times as much, and the player turns around "in time" and dies
   anyway. This reproduced exactly: at upgrade tier 4, where runs bottom out in
   the gas strata, a simulated player reading the naive estimate lost **3 runs
   out of 3**, while the tiers either side survived 3 of 3. Counting the gas
   still between the diver and the surface fixed it to 4 of 4.

Without this readout the core decision is not computable by the player. With it,
compounding cost becomes visible dread instead of an unfair surprise.

## Hazards (three, all dodged with the one input)

1. **Wall snag** — spikes on one wall over a depth band. Costs 2.5s of lamp and
   kills the swing. Avoided by hovering (narrow swing) past it.
2. **Gas pocket** — full-shaft band, burns lamp at 3×. Cross it fast or route
   around the depth entirely.
3. **Falling rock** — telegraphed with a pulsing ring for 0.7s, then falls.
   Costs 3s of lamp and shoves you downward, which is worst on the climb.

## Strata

480 world units (48 m) each. Five authored, then The Deep at 240 m.

1. **Topsoil** — coins only, no hazards. The teaching floor.
2. **Limestone** — gems appear, snags begin.
3. **Crystal Vein** — denser gems, rockfalls begin.
4. **Sulphur Deep** — gas pockets.
5. **Bone Cathedral** — relics, everything at once.
6. **The Deep** — endless, density scales slowly with depth.

The original 900 units per stratum was wrong: a level-0 run bottomed out around
160 m and even max gear could not reach The Deep. Three of five strata and two
of three hazards were content no player would ever see. 480 makes every tier
reveal something, with real margin rather than a knife edge.

**End of content:** reaching The Deep fires a one-time notice that the descent
is endless from there. Platform MUST, not a nicety.

## Progression — three tracks, five levels each

| Track | Effect | Costs |
| --- | --- | --- |
| **Lamp** | +4s of light per level (22s → 42s) | 40 / 90 / 180 / 340 / 600 |
| **Winch** | −0.003 weight factor per level | 50 / 110 / 220 / 400 / 700 |
| **Satchel** | +15% haul value per level | 60 / 130 / 260 / 460 / 800 |

Winch is the interesting one: it directly buys back the tension the game is
built on, which is why it costs the most per point of relief.

## Measured balance

The game runs on a **fixed 1/60 timestep**, so the simulation harness (which
steps `update(1/60)` directly) measures exactly what a player experiences rather
than an approximation. Determinism is asserted in `playables_check.py`.

### Risk curve at level 0

A player who turns around when the climb needs a given fraction of the lamp:

| Turnaround margin | Turned at | Banked | Run | Outcome |
| --- | --- | --- | --- | --- |
| 0.95 (greedy) | 157 m | **0** | 22.0s | lost |
| 0.85 | 146 m | **139** | 20.6s | surfaced |
| 0.70 | 133 m | 111 | 17.9s | surfaced |
| 0.55 | 116 m | 91 | 15.3s | surfaced |
| 0.40 (timid) | 96 m | 68 | 12.2s | surfaced |

Greed pays right up to a cliff, and the best line sits one notch from death.

### Reachability by upgrade tier (margin 0.8)

| Tier | Lamp | Deepest | Reaches | Run | Banked |
| --- | --- | --- | --- | --- | --- |
| 0 | 22s | 140 m | Crystal Vein | 19.6s | 134 |
| 1 | 26s | 165 m | Sulphur Deep | 23.2s | 190 |
| 2 | 30s | 192 m | Sulphur Deep | 27.4s | 298 |
| 3 | 34s | 216 m | Bone Cathedral | 30.5s | 432 |
| 4 | 38s | 230 m | Bone Cathedral | 30.1s | 464 |
| 5 | 42s | 272 m | **The Deep** | 34.3s | 669 |

Every tier opens something new, and max gear clears the endgame boundary with
margin. Regression-tested.

### Responsiveness

Because the timestep is fixed, these are the real numbers, not estimates:

| Measure | |
| --- | --- |
| Press → half descent speed | 117 ms |
| Press → 90% descent speed | 333 ms |
| Release → direction flip | 117 ms |
| Release → half climb speed | 217 ms |
| Cold start → first pickup | 617 ms (at 9 m) |

The hook pays inside the first second, and control response sits under the
~150 ms threshold where input starts to read as laggy. The slower 333 ms to full
speed is intentional — it is the weight of a diver on a winch.

- **Run length:** 12–22s at level 0, up to ~34s fully outfitted.
- **Collection rate:** ~43% of treasure passed.
- **First upgrade** affordable after one successful run.

## Failure

No permadeath, no game over. A dead lamp costs the current haul only — banked
coins and upgrades are never touched. The relight is offered once per run, and
re-reads the lamp cap so an upgrade bought from the loss screen actually applies.

## Portability

The same bundle ships to hosts with different ad support and to plain web with
no host at all. Both paths are regression-tested: with rewarded ads unsupported
the reward buttons are hidden rather than offered and failed, and with no SDK
present at all the game runs, saves, and completes without throwing.

## Accessibility & UX

One thumb; auto-collection; no timing punishments beyond the telegraphed rock.
Large tabular numerals. Hazards double-coded by colour *and* shape. No master
mute control anywhere — the platform forbids one and audio state arrives solely
from the host.

## Why it stays fun

A run is short enough that a bad call costs almost nothing, and the call recurs
constantly. The reserve marker means every loss is legible as *your*
misjudgement rather than the game's noise — the difference between "again" and
"uninstall". The upgrade tracks then move where the cliff sits without ever
removing it.

## Explicitly out of v1

Multiplayer · IAP · cosmetics · a 4th hazard · a 4th upgrade track · story ·
procedural art · tutorial text beyond one screen.

**In, as of the Playgama pass:** a SaaS leaderboard scored on deepest metres in a
single run (`sinkhole_deepest_dive`), and advanced banners on the menu and result
screens. Depth is the right leaderboard metric rather than coins banked — it is
the direct measure of the only decision the game asks about, and it keeps the
board honest against a player who farms shallow safe runs.
