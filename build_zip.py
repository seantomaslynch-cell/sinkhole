#!/usr/bin/env python3
"""Build the Playgama submission ZIP.

Playgama expects a self-contained HTML5 bundle with index.html at the ROOT of
the archive (not inside a folder), under 30 MB initial load. Only the four
shipped files go in — serve.js, the checker and the docs are development
tooling and must not be in the upload.
"""
import os
import re
import sys
import zipfile

# The GitHub Pages build carries social/link-preview metadata with absolute
# URLs. None of that belongs in a bundle whose whole selling point to a
# moderator is that it is self-contained, so it lives inside a marked block in
# index.html and is stripped here on the way into the archive.
PAGES_ONLY = re.compile(
    r"[ \t]*<!--\s*PAGES-ONLY:START.*?PAGES-ONLY:END\s*-->[ \t]*\r?\n?",
    re.DOTALL,
)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sinkhole-playgama.zip")

BUNDLE = [
    "index.html",
    "style.css",
    "game.js",
    "playgama-bridge-config.json",
]

LIMIT_MB = 30


def main():
    missing = [f for f in BUNDLE if not os.path.exists(os.path.join(HERE, f))]
    if missing:
        print("ERROR: missing bundle files: " + ", ".join(missing))
        return 1

    if os.path.exists(OUT):
        os.remove(OUT)

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for f in BUNDLE:
            src = os.path.join(HERE, f)
            # arcname without any directory component — index.html must sit at
            # the archive root or the platform will not find the entry point.
            if f == "index.html":
                html = open(src, encoding="utf-8").read()
                stripped, n = PAGES_ONLY.subn("", html)
                if n:
                    print("  stripped %d Pages-only block(s) from index.html" % n)
                z.writestr(f, stripped)
            else:
                z.write(src, arcname=f)

    size = os.path.getsize(OUT)
    with zipfile.ZipFile(OUT) as z:
        bad = z.testzip()
        names = z.namelist()
        raw = sum(i.file_size for i in z.infolist())
        packed_index = z.read("index.html").decode("utf-8") if "index.html" in names else ""

    print("built %s" % os.path.basename(OUT))
    print("  files:       %s" % ", ".join(names))
    print("  uncompressed %.1f KB" % (raw / 1024))
    print("  zipped       %.1f KB  (limit %d MB)" % (size / 1024, LIMIT_MB))

    ok = True
    if bad is not None:
        print("  FAIL corrupt entry: %s" % bad)
        ok = False
    if "index.html" not in names:
        print("  FAIL index.html is not at the archive root")
        ok = False
    if raw > LIMIT_MB * 1024 * 1024:
        print("  FAIL bundle exceeds the %d MB initial-load limit" % LIMIT_MB)
        ok = False

    # Verify the strip actually worked, rather than trusting that it did. The
    # only URL allowed to leave the bundle is the Bridge SDK itself.
    urls = re.findall(r"https?://[^\"'\s>]+", packed_index)
    foreign = [u for u in urls if "bridge.playgama.com" not in u]
    if foreign:
        print("  FAIL packed index.html still references external URLs:")
        for u in foreign[:5]:
            print("       %s" % u)
        ok = False
    else:
        print("  self-contained: no external URLs beyond the Bridge SDK")

    # The placeholder token produces a perfectly valid ZIP with a dead
    # leaderboard, and nothing about the file would tell you. Warn at the last
    # step before upload rather than letting it reach moderation.
    cfg_path = os.path.join(HERE, "playgama-bridge-config.json")
    if os.path.exists(cfg_path):
        import json
        with open(cfg_path, encoding="utf-8") as f:
            token = (json.load(f).get("saas") or {}).get("publicToken", "")
        if "REPLACE_WITH" in token:
            print()
            print("  !! WARNING: the Playgama SaaS publicToken is still the placeholder.")
            print("     This ZIP is uploadable but its leaderboard will be dead.")
            print("     Fix with:  python set_token.py <token>")

    print("  OK" if ok else "  NOT SHIPPABLE")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
