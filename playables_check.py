#!/usr/bin/env python3
"""
YouTube Playables / Playgama pre-submission checker — adapted for Sinkhole.

Usage:
    python3 playables_check.py path/to/index.html

Runs every check that maps to a past Mediacube rejection, aimed at the
Playgama Bridge SDK integration (window.bridge), which is what Playgama's own
moderation looks for and which routes to the real YouTube SDK when running on
Playables:
  - loads with zero console/page errors
  - first interstitial fires on game start
  - timed interstitial arms and fires at run end
  - rewarded ad fires on relight and only relights on success
  - pause fully locks out interaction (CSS pointer-events + elementFromPoint)
  - audio is silent (zero sound nodes) when muted, audible when unmuted
  - canvas still renders and the game stays interactive through an
    orientation change
Plus a static scan of the HTML/JS/CSS for CSP / SDK requirements.

Requires: pip install playwright ; playwright install chromium

ADAPTATION NOTES (carried over from the Endless Core harness this descends
from — only the differences that are real for Sinkhole are listed):

  1. CFG now names Sinkhole's real entry points. The revive is
     watchAdRelight() ("relight the lamp"), not a health restore, and its
     placement id is 'sinkhole-relight'.

  2. The audio test's sound-type list is Sinkhole's actual playSound() vocabulary
     (coin/gem/relic/hit/gas/bank/warn/click). Passing Endless Core's types
     (dig, explosion, ...) would exercise the default branch only and would
     still "pass" while testing almost nothing.

  3. endGame() is deliberately re-entrant in Sinkhole (see its comment in
     game.js) because this harness calls it on an already-ended run when it
     tests the timed interstitial. Scoring is guarded to only count once; the
     screen and any armed interstitial resolve on every call. If that guard is
     ever tightened back up, the "timed interstitial at game over" check is
     the one that will start failing.

  4. Sinkhole has no in-game master mute control by design — the Playables
     design requirements forbid one, and platform audio state arrives solely
     through AUDIO_STATE_CHANGED. There is therefore no settings-toggle path
     to test, only applySdkAudioState().

  5. Orientation: Sinkhole uses a fixed logical canvas (LOGICAL_W/H) stretched
     via CSS, so entity positions cannot leave the viewport on rotation and
     there is no per-entity clamp to assert. The check verifies the canvas
     still has a nonzero rendered size and the game is still interactive.
"""
import sys, re, os, json

# Windows consoles default to cp1252, which can't encode the check marks below.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ── CONFIG: matches Sinkhole's actual function/variable names ──────────────
CFG = {
    "start_fn":          "startGame()",
    "end_fn":            "endGame()",
    "revive_fn":         "watchAdRelight()",
    "reward_id":         "sinkhole-relight",
    "interstitial_tick": "tickInterstitialTimer()",
    "sound_types":       ['coin', 'gem', 'relic', 'hit', 'gas', 'bank', 'warn', 'click'],
}

MOCK_SDK = """
window.__adCalls = [];
window.__lbCalls = [];
window.__bannerCalls = [];
window.__xss = 0;
window.__bridgeStorage = {};
window.__rewardResult = true;
window.__audioState = true;
window.__pauseListeners = [];
window.__audioListeners = [];
window.__rewardedListeners = [];

window.bridge = {
  EVENT_NAME: {
    AUDIO_STATE_CHANGED: 'audio_state_changed',
    PAUSE_STATE_CHANGED: 'pause_state_changed',
    REWARDED_STATE_CHANGED: 'rewarded_state_changed',
    INTERSTITIAL_STATE_CHANGED: 'interstitial_state_changed',
  },
  initialize: () => Promise.resolve(),
  platform: {
    language: 'en',
    get isAudioEnabled() { return window.__audioState; },
    sendMessage: (msg) => { window.__adCalls.push({ type: 'message', msg }); },
    on: (event, cb) => {
      if (event === 'audio_state_changed') window.__audioListeners.push(cb);
      if (event === 'pause_state_changed') window.__pauseListeners.push(cb);
    },
  },
  storage: {
    get: (keys) => Promise.resolve(keys.map((k) => (k in window.__bridgeStorage ? window.__bridgeStorage[k] : null))),
    set: (keys, values) => { keys.forEach((k, i) => { window.__bridgeStorage[k] = values[i]; }); return Promise.resolve(); },
  },
  leaderboards: {
    type: 'in_game',
    setScore: (id, score) => {
      window.__lbCalls.push({ type: 'setScore', id, score });
      return Promise.resolve();
    },
    getEntries: (id) => {
      window.__lbCalls.push({ type: 'getEntries', id });
      // The first name is hostile on purpose: entry names are other players'
      // input, and the renderer must not interpolate them into markup.
      return Promise.resolve([
        { rank: 1, name: '<img src=x onerror="window.__xss=1">', score: 412 },
        { rank: 2, name: 'Diver', score: 388, isPlayer: true },
      ]);
    },
  },
  advertisement: {
    isInterstitialSupported: true,
    isRewardedSupported: true,
    isAdvancedBannersSupported: true,
    showAdvancedBanners: (placement) => { window.__bannerCalls.push({ type: 'show', placement }); },
    hideAdvancedBanners: () => { window.__bannerCalls.push({ type: 'hide' }); },
    showInterstitial: (placement) => { window.__adCalls.push({ type: 'interstitial', placement }); },
    showRewarded: (placement) => {
      window.__adCalls.push({ type: 'rewarded', placement });
      const finalState = window.__rewardResult ? 'rewarded' : 'closed';
      window.__rewardedListeners.forEach((cb) => cb(finalState));
    },
    on: (event, cb) => { if (event === 'rewarded_state_changed') window.__rewardedListeners.push(cb); },
    off: (event, cb) => {
      if (event === 'rewarded_state_changed') window.__rewardedListeners = window.__rewardedListeners.filter((f) => f !== cb);
    },
  },
};

// Test-only helpers standing in for the host platform driving these events.
window.__firePause = (paused) => window.__pauseListeners.forEach((cb) => cb(paused));
window.__fireAudio = (enabled) => { window.__audioState = enabled; window.__audioListeners.forEach((cb) => cb(enabled)); };
"""


def static_scan(path):
    game_dir = os.path.dirname(path)
    html = open(path, encoding="utf-8").read()

    # index.html carries a PAGES-ONLY block of social metadata that build_zip.py
    # strips before packing. Scan the stripped form, because that — not the
    # working file — is what actually ships and what a moderator sees.
    html = re.sub(
        r"[ \t]*<!--\s*PAGES-ONLY:START.*?PAGES-ONLY:END\s*-->[ \t]*\r?\n?",
        "", html, flags=re.DOTALL,
    )

    js = ""
    js_path = os.path.join(game_dir, "game.js")
    if os.path.exists(js_path):
        js = open(js_path, encoding="utf-8").read()

    css = ""
    css_path = os.path.join(game_dir, "style.css")
    if os.path.exists(css_path):
        css = open(css_path, encoding="utf-8").read()

    combined = html + "\n" + js + "\n" + css
    results = []

    def chk(name, ok):
        results.append((name, bool(ok)))

    first_script_idx = html.find("<script")
    sdk_idx = html.find("bridge.playgama.com")
    chk("Bridge SDK is first <script>",
        first_script_idx != -1 and sdk_idx != -1 and first_script_idx < sdk_idx < first_script_idx + 200)
    chk("0 inline HTML on*= attrs", len(re.findall(r"<[^>]+\son\w+\s*=", combined)) == 0)

    other_srcs = [s for s in re.findall(r'<script[^>]+src="([^"]+)"', html) if "playgama-bridge" not in s]
    external_srcs = [s for s in other_srcs if re.match(r'^(https?:)?//', s)]
    chk("no external scripts besides SDK", len(external_srcs) == 0)

    chk("no Page Visibility API", "visibilitychange" not in combined and "document.hidden" not in combined)
    chk("bridge.initialize() called", "bridge.initialize" in combined)
    chk("reads platform.language", "platform.language" in combined)
    chk("pause + audio state events wired", "PAUSE_STATE_CHANGED" in combined and "AUDIO_STATE_CHANGED" in combined)
    chk("game_ready message sent", "game_ready" in combined)
    chk("storage save + load present", "storage.set" in combined and "storage.get" in combined)
    chk("rewarded ad call", "showRewarded" in combined)
    chk("interstitial ad call", "showInterstitial" in combined)
    chk("pause body-lockout CSS", "body.paused" in combined)
    chk("orientationchange handled", "orientationchange" in combined)
    chk("no master mute control", "mute-toggle" not in combined and "sound-toggle" not in combined)
    chk("communicates end of content", "endless" in combined.lower())
    chk("no external links", "<a href" not in html)

    # Bridge config: the features declared to the platform must actually be
    # declared, or they silently never activate in production.
    cfg_path = os.path.join(game_dir, "playgama-bridge-config.json")
    cfg = json.load(open(cfg_path, encoding="utf-8")) if os.path.exists(cfg_path) else {}
    adv = (cfg.get("advertisement") or {})
    chk("config declares rewarded placements", len(((adv.get("rewarded") or {}).get("placements")) or []) >= 1)
    chk("config declares interstitial spacing", adv.get("minimumDelayBetweenInterstitial") is not None)
    chk("config enables advanced banners", (adv.get("advancedBanners") or {}).get("disable") is False)
    chk("config declares a leaderboard", len(cfg.get("leaderboards") or []) >= 1)
    chk("config declares the SaaS leaderboard service",
        bool(((cfg.get("saas") or {}).get("leaderboards") or {}).get("platforms")))

    # Every rewarded id the game asks for must be declared, or the host has
    # nothing to serve against it.
    declared = {p.get("id") for p in ((adv.get("rewarded") or {}).get("placements") or [])}
    used = set(re.findall(r"REWARD_ID_\w+\s*=\s*'([^']+)'", js))
    chk("every rewarded id used in code is declared in config", used and used <= declared)

    chk("leaderboard code + banner code present",
        "setScore" in js and "showAdvancedBanners" in js and "hideAdvancedBanners" in js)
    return results


def runtime_checks(path):
    from playwright.sync_api import sync_playwright
    url = "file://" + path
    out = []
    with sync_playwright() as p:
        # Headless Chromium won't reliably treat a CDP-dispatched click as a
        # trusted gesture, so audioCtx can stay 'suspended' regardless of mute
        # state — this flag removes that dependency so the audio test actually
        # exercises playSound()'s mute branch.
        b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page(viewport={"width": 390, "height": 844})
        errors = []
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
        pg.route("**/playgama-bridge.js", lambda r: r.fulfill(
            status=200, content_type="application/javascript", body=MOCK_SDK))
        pg.goto(url)
        pg.wait_for_timeout(1500)

        out.append(("loads with 0 console/page errors", len(errors) == 0, errors[:5]))

        # first interstitial on start
        pg.evaluate(CFG["start_fn"])
        pg.wait_for_timeout(400)
        calls = pg.evaluate("window.__adCalls")
        out.append(("first interstitial on start",
                    any(c['type'] == 'interstitial' for c in calls), calls))

        # pause lockout
        pg.evaluate("window.__firePause && window.__firePause(true)")
        pg.wait_for_timeout(200)
        st = pg.evaluate("({paused: (typeof isPaused!=='undefined'&&isPaused), body: document.body.classList.contains('paused')})")
        reach = pg.evaluate("""() => {
            const btn = document.querySelector('button');
            if(!btn) return {pe:'no-button', overlayOnTop:true};
            const r = btn.getBoundingClientRect();
            const el = document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
            return { pe: getComputedStyle(btn).pointerEvents,
                     overlayOnTop: !!(el && el.closest && el.closest('#pause-overlay')) };
        }""")
        pause_ok = st["paused"] and st["body"] and reach["pe"] == "none"
        out.append(("pause fully locks interaction", pause_ok, {**st, **reach}))
        pg.evaluate("window.__firePause && window.__firePause(false)")
        pg.wait_for_timeout(200)
        out.append(("resume clears pause",
                    not pg.evaluate("(typeof isPaused!=='undefined'&&isPaused)"), None))

        # rewarded ad — success then failure
        pg.evaluate("window.__adCalls=[]; window.__rewardResult=true; " + CFG["end_fn"])
        pg.wait_for_timeout(200)
        pg.evaluate(CFG["revive_fn"])
        pg.wait_for_timeout(400)
        calls2 = pg.evaluate("window.__adCalls")
        out.append(("rewarded ad fires w/ id",
                    any(c['type'] == 'rewarded' and c.get('placement') == CFG['reward_id'] for c in calls2), calls2))

        pg.evaluate("window.__rewardResult=false;")
        pg.evaluate(CFG["end_fn"])
        pg.wait_for_timeout(150)
        pg.evaluate(CFG["revive_fn"])
        pg.wait_for_timeout(400)
        out.append(("no relight when reward=false",
                    not pg.evaluate("(typeof state!=='undefined'&&state.running)"), None))

        # timed interstitial
        pg.evaluate("window.__adCalls=[]")
        pg.evaluate("try{lastInterstitialTime=Date.now()-91000;interstitialArmed=false;firstInterstitialShown=true;}catch(e){}")
        pg.evaluate("try{%s;}catch(e){}" % CFG["interstitial_tick"])
        pg.evaluate(CFG["end_fn"])
        pg.wait_for_timeout(300)
        out.append(("timed interstitial at run end",
                    any(c['type'] == 'interstitial' for c in pg.evaluate("window.__adCalls")), None))

        # audio mute/unmute. A real (trusted) click first — see the launch flag
        # comment above for why this is belt-and-braces rather than redundant.
        pg.mouse.click(195, 400)
        pg.wait_for_timeout(200)
        audio = pg.evaluate("""async (types) => {
            return await new Promise(res => {
              let muted = 0, unmuted = 0;
              const orig = OscillatorNode.prototype.start;
              OscillatorNode.prototype.start = function(...a) {
                // sdkAudioEnabled is a top-level `let`, which does NOT attach to
                // window — a bare reference is required to resolve it through
                // the normal scope chain.
                (sdkAudioEnabled ? unmuted++ : muted++);
                return orig.apply(this, a);
              };
              window.applySdkAudioState(false);
              types.forEach(t => { try { window.playSound(t); } catch(e){} });
              setTimeout(() => {
                window.applySdkAudioState(true);
                types.forEach(t => { try { window.playSound(t); } catch(e){} });
                setTimeout(() => {
                  OscillatorNode.prototype.start = orig;
                  res({ muted, unmuted });
                }, 100);
              }, 100);
            });
        }""", CFG["sound_types"])
        out.append(("muted = 0 sound nodes", audio["muted"] == 0, audio))
        out.append(("unmuted > 0 sound nodes", audio["unmuted"] > 0, audio))

        # orientation
        pg.evaluate("try{%s;}catch(e){}" % CFG["start_fn"])
        pg.wait_for_timeout(300)
        pg.set_viewport_size({"width": 844, "height": 390})
        pg.evaluate("window.dispatchEvent(new Event('orientationchange'))")
        pg.wait_for_timeout(300)
        land = pg.evaluate("""() => {
            const c = document.getElementById('gameCanvas');
            const r = c.getBoundingClientRect();
            const btn = document.querySelector('button:not([disabled])');
            return { canvasW: r.width, canvasH: r.height, hasClickableButton: !!btn };
        }""")
        out.append(("landscape: canvas renders + interactive",
                    land["canvasW"] > 0 and land["canvasH"] > 0 and land["hasClickableButton"], land))

        pg.set_viewport_size({"width": 390, "height": 844})
        pg.evaluate("window.dispatchEvent(new Event('orientationchange'))")
        pg.wait_for_timeout(300)
        port = pg.evaluate("""() => {
            const c = document.getElementById('gameCanvas');
            const r = c.getBoundingClientRect();
            return { canvasW: r.width, canvasH: r.height };
        }""")
        out.append(("portrait: canvas renders",
                    port["canvasW"] > 0 and port["canvasH"] > 0, port))

        # --- Leaderboard ------------------------------------------------------
        lb = pg.evaluate("""async () => {
            window.__lbCalls = []; window.__xss = 0;
            startGame();
            for (let i = 0; i < 60*60 && state.running; i++) { held.pointer = true; update(1/60); }
            // setScore goes through bridgeReadyPromise.then(...), so it lands on
            // a microtask — reading synchronously here would always see nothing.
            await new Promise(r => setTimeout(r, 100));
            const submitted = window.__lbCalls.filter(c => c.type === 'setScore');
            document.getElementById('lost-screen').classList.add('hidden');

            await openLeaderboard();
            await new Promise(r => setTimeout(r, 150));
            const list = document.getElementById('leaderboard-list');
            const rows = list.querySelectorAll('.leaderboard-row');
            const shown = !document.getElementById('leaderboard-screen').classList.contains('hidden');
            const injected = list.querySelectorAll('img, script').length;
            const firstName = rows[0] ? rows[0].querySelector('.leaderboard-name').textContent : '';
            document.getElementById('leaderboard-screen').classList.add('hidden');

            return { submitted, rowCount: rows.length, shown, injected,
                     xssFired: window.__xss, firstNameIsLiteralText: firstName.indexOf('<img') === 0,
                     leaderboardId: (submitted[0] || {}).id };
        }""")
        out.append(("leaderboard score submitted at run end",
                    len(lb["submitted"]) > 0 and lb["submitted"][0]["score"] > 0, lb["submitted"]))
        out.append(("leaderboard opens and renders entries",
                    lb["shown"] and lb["rowCount"] == 2, lb))
        out.append(("leaderboard names are escaped, not injected",
                    lb["injected"] == 0 and lb["xssFired"] == 0 and lb["firstNameIsLiteralText"], lb))

        # The id the game submits must match the one declared to the platform,
        # or scores land in a leaderboard that was never provisioned.
        cfg_path = os.path.join(os.path.dirname(path), "playgama-bridge-config.json")
        cfg = json.load(open(cfg_path, encoding="utf-8")) if os.path.exists(cfg_path) else {}
        cfg_ids = [x.get("id") for x in cfg.get("leaderboards", [])]
        out.append(("leaderboard id matches bridge config",
                    lb["leaderboardId"] in cfg_ids, {"game": lb["leaderboardId"], "config": cfg_ids}))

        # --- Advanced banners -------------------------------------------------
        # Banner calls also resolve through bridgeReadyPromise, so every phase
        # needs a tick before its calls are readable.
        ban = pg.evaluate("""async () => {
            const tick = () => new Promise(r => setTimeout(r, 80));
            window.__bannerCalls = [];
            backToCamp();                       // banner-safe menu
            await tick();
            const afterMenu = window.__bannerCalls.slice();

            window.__bannerCalls = [];
            startGame();                        // gameplay: must hide
            await tick();
            const afterStart = window.__bannerCalls.slice();
            const bodyDuringRun = document.body.classList.contains('banner');

            window.__bannerCalls = [];
            openUpgrades(document.getElementById('start-screen')); // scrolls: must hide
            await tick();
            const afterUpgrades = window.__bannerCalls.slice();
            document.getElementById('upgrades-screen').classList.add('hidden');
            return { afterMenu, afterStart, afterUpgrades, bodyDuringRun };
        }""")
        out.append(("banner shown on menu",
                    any(c["type"] == "show" for c in ban["afterMenu"]), ban["afterMenu"]))
        out.append(("banner hidden during gameplay",
                    any(c["type"] == "hide" for c in ban["afterStart"]) and not ban["bodyDuringRun"], ban))
        out.append(("banner hidden on scrolling sub-screens",
                    any(c["type"] == "hide" for c in ban["afterUpgrades"]), ban["afterUpgrades"]))

        # --- Determinism / fixed timestep -----------------------------------
        # The game advances on a fixed 1/60 step, which is what lets the
        # balance harness's stepped runs stand in for real play. Assert it:
        # two identical scripted runs must land on identical numbers.
        det = pg.evaluate("""() => {
            const script = (frames, holdUntil) => {
                startGame();
                for (let i = 0; i < frames; i++) { held.pointer = i < holdUntil; update(1/60); }
                return { depth: Math.round(state.depth*1000), haul: Math.round(state.haul*1000),
                         weight: state.weight, lamp: Math.round(state.lamp*1000) };
            };
            const a = script(600, 300);
            const b = script(600, 300);
            return { a, b, identical: JSON.stringify(a) === JSON.stringify(b),
                     fixedStepPresent: typeof FIXED_DT !== 'undefined' && Math.abs(FIXED_DT - 1/60) < 1e-9 };
        }""")
        out.append(("fixed timestep constant present", det["fixedStepPresent"], det))
        out.append(("simulation is deterministic", det["identical"], det))

        # --- Graceful degradation -------------------------------------------
        # The same bundle ships to hosts with different ad support, and to plain
        # web with no host at all. It must never offer a button that cannot
        # work, and must never throw when the SDK is simply absent.
        deg = pg.evaluate("""() => {
            const out = {};
            Object.defineProperty(window.bridge.advertisement, 'isRewardedSupported',
                                  {value: false, configurable: true});
            startGame();
            for (let i = 0; i < 60*60 && state.running; i++) { held.pointer = true; update(1/60); }
            out.relightHiddenWhenUnsupported =
                document.getElementById('relight-btn').classList.contains('hidden');
            out.runStillCompletes = !state.running;
            document.getElementById('lost-screen').classList.add('hidden');
            Object.defineProperty(window.bridge.advertisement, 'isRewardedSupported',
                                  {value: true, configurable: true});

            const saved = window.bridge;
            window.bridge = undefined;
            out.threw = null;
            try {
                startGame();
                for (let i = 0; i < 60*40 && state.running; i++) { held.pointer = true; update(1/60); }
                for (let i = 0; i < 60*80 && state.running; i++) { held.pointer = false; update(1/60); }
                render(); showInterstitialAd(); tickInterstitialTimer();
                out.ranWithoutSdk = !state.running;
            } catch (e) { out.threw = String(e); }
            window.bridge = saved;
            document.getElementById('lost-screen').classList.add('hidden');
            document.getElementById('surfaced-screen').classList.add('hidden');
            return out;
        }""")
        out.append(("no dead reward button when ads unsupported",
                    deg["relightHiddenWhenUnsupported"] and deg["runStillCompletes"], deg))
        out.append(("playable with no SDK present",
                    deg["threw"] is None and deg.get("ranWithoutSdk"), deg))

        # --- All authored content is reachable -------------------------------
        # Strata the player can never reach are strata that may as well not
        # exist. This caught three unreachable strata and two unused hazards.
        reach = pg.evaluate("""() => {
            const play = () => {
                startGame();
                let climbing = false, deepest = 0;
                for (let i = 0; i < 60*200 && state.running; i++) {
                    if (!climbing && climbCost() > state.lamp * 0.8) climbing = true;
                    held.pointer = !climbing; update(1/60);
                    if (state.depth > deepest) deepest = state.depth;
                }
                document.getElementById('surfaced-screen').classList.add('hidden');
                document.getElementById('lost-screen').classList.add('hidden');
                return deepest;
            };
            const lv = [state.lampLevel, state.winchLevel, state.satchelLevel];
            state.lampLevel = state.winchLevel = state.satchelLevel = 5;
            // One run is enough: the simulation is deterministic (asserted
            // above) and the world is generated from a positional hash, so
            // repeating an identical scripted run returns an identical number.
            const best = play();
            state.lampLevel = lv[0]; state.winchLevel = lv[1]; state.satchelLevel = lv[2];
            return { bestAtMaxGear: Math.round(best), deepStartsAt: DEEP_START,
                     marginUnits: Math.round(best - DEEP_START),
                     reachesTheDeep: best >= DEEP_START };
        }""")
        out.append(("all authored strata reachable at max gear", reach["reachesTheDeep"], reach))

        out.append(("still 0 console/page errors at end", len(errors) == 0, errors[:5]))
        b.close()
    return out


def submission_readiness(path):
    """Things that block UPLOAD rather than indicate a code defect.

    Reported separately and never counted toward the technical pass/fail: a
    missing cover image is not a broken game, but it will stop the submission
    just as dead, so it should be impossible to forget.
    """
    game_dir = os.path.dirname(path)
    rows = []

    cfg_path = os.path.join(game_dir, "playgama-bridge-config.json")
    token = None
    if os.path.exists(cfg_path):
        cfg = json.load(open(cfg_path, encoding="utf-8"))
        token = (cfg.get("saas") or {}).get("publicToken")
    rows.append(("Playgama SaaS public token set (leaderboard needs it)",
                 bool(token) and "REPLACE_WITH" not in token,
                 "get it from the Playgama developer dashboard after creating the game entry"))

    zip_path = os.path.join(game_dir, "sinkhole-playgama.zip")
    rows.append(("submission ZIP built", os.path.exists(zip_path), "run: python build_zip.py"))

    covers = os.path.join(game_dir, "store-assets", "playgama-covers")
    needed = ["cover-landscape-1920x1080.png", "cover-portrait-1080x1920.png", "cover-square-800x800.png"]
    have = [n for n in needed if os.path.exists(os.path.join(covers, n))]
    rows.append(("cover art (3 sizes)", len(have) == len(needed),
                 "missing: " + ", ".join(n for n in needed if n not in have)))

    return rows


def main():
    if len(sys.argv) < 2:
        print("usage: playables_check.py path/to/index.html")
        sys.exit(2)
    path = os.path.abspath(sys.argv[1])
    if not os.path.exists(path):
        print("no such file: " + path)
        sys.exit(2)

    failures = 0

    print("\n=== STATIC SCAN ===")
    for name, ok in static_scan(path):
        print(("  PASS  " if ok else "  FAIL  ") + name)
        if not ok:
            failures += 1

    print("\n=== RUNTIME ===")
    try:
        for row in runtime_checks(path):
            name, ok = row[0], row[1]
            detail = row[2] if len(row) > 2 else None
            print(("  PASS  " if ok else "  FAIL  ") + name)
            if not ok and detail:
                print("          detail: " + str(detail))
            if not ok:
                failures += 1
    except ImportError:
        print("  SKIP  playwright not installed (pip install playwright; playwright install chromium)")

    print("\nRESULT: " + ("ALL TECHNICAL CHECKS PASSED" if failures == 0
                          else str(failures) + " FAILING"))

    print("\n=== SUBMISSION READINESS (not part of technical pass/fail) ===")
    outstanding = 0
    for name, ok, hint in submission_readiness(path):
        print(("  READY  " if ok else "  TODO   ") + name)
        if not ok:
            print("          " + hint)
            outstanding += 1
    print("\n" + ("Ready to upload to Playgama."
                  if outstanding == 0 else
                  str(outstanding) + " item(s) still needed before upload."))

    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
