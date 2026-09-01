#!/usr/bin/env python3
"""Paste in the Playgama SaaS public token and rebuild the upload ZIP.

The token only exists once the game entry has been created in the Playgama
developer dashboard, so it cannot be committed ahead of time. This exists so
the last mile is one command instead of "hand-edit a JSON file, remember to
rebuild the ZIP, remember that the ZIP had the placeholder baked in".

Usage:
    python set_token.py <public-token>
    python set_token.py --show          # what's currently configured
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "playgama-bridge-config.json")
PLACEHOLDER = "REPLACE_WITH_PLAYGAMA_PUBLIC_TOKEN"


def current_token():
    with open(CONFIG, encoding="utf-8") as f:
        return (json.load(f).get("saas") or {}).get("publicToken")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    arg = sys.argv[1].strip()

    if arg in ("--show", "-s"):
        tok = current_token()
        if tok == PLACEHOLDER:
            print("token: NOT SET (still the placeholder)")
            return 1
        print("token: %s" % tok)
        return 0

    # Playgama tokens are lowercase alphanumeric. Catch the obvious paste
    # mistakes (a whole URL, a quoted string, trailing whitespace) here rather
    # than in moderation two weeks from now.
    token = arg.strip().strip('"').strip("'")
    if not re.fullmatch(r"[A-Za-z0-9_-]{12,80}", token):
        print("ERROR: %r does not look like a Playgama public token." % token)
        print("       Expected 12-80 chars of letters/digits/-/_ .")
        print("       Copy just the token itself, not a URL or a JSON snippet.")
        return 1

    with open(CONFIG, encoding="utf-8") as f:
        raw = f.read()
    cfg = json.loads(raw)  # parse for validation and reporting only
    old = (cfg.get("saas") or {}).get("publicToken")

    # Surgical string replacement rather than json.dump: a round-trip through
    # the parser reformats every compact inline object in the file, so a
    # one-token change would land as a 19-line diff and bury the actual edit.
    new_raw, n = re.subn(
        r'("publicToken"\s*:\s*)"[^"]*"',
        lambda m: m.group(1) + '"' + token + '"',
        raw,
        count=1,
    )
    if n != 1:
        print("ERROR: could not find a publicToken field in %s" % os.path.basename(CONFIG))
        return 1

    # Re-parse the edited text before writing: never leave the config invalid.
    try:
        json.loads(new_raw)
    except ValueError as e:
        print("ERROR: edit produced invalid JSON (%s) — file left unchanged." % e)
        return 1

    with open(CONFIG, "w", encoding="utf-8") as f:
        f.write(new_raw)

    print("token set   : %s%s" % (token, "  (was the placeholder)" if old == PLACEHOLDER else ""))
    print("leaderboard : %s" % ", ".join(l["id"] for l in cfg.get("leaderboards", [])))
    print()

    # Rebuilding here is the whole point — a ZIP built before the token was set
    # still contains the placeholder, and nothing about the file name would
    # tell you that.
    #
    # Flush first: the child writes straight to the terminal while our own
    # prints sit in Python's buffer, so without this the build output appears
    # above the "token set" line it is supposed to follow.
    sys.stdout.flush()
    rc = subprocess.call([sys.executable, os.path.join(HERE, "build_zip.py")])
    if rc != 0:
        return rc

    print()
    print("Ready to upload:")
    print("  ZIP    sinkhole-playgama.zip")
    print("  covers store-assets/playgama-covers/  (3 files)")
    print("  copy   STORE_LISTING.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
