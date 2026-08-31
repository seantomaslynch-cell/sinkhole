#!/usr/bin/env python3
"""Build the Playgama submission ZIP.

Playgama expects a self-contained HTML5 bundle with index.html at the ROOT of
the archive (not inside a folder), under 30 MB initial load. Only the four
shipped files go in — serve.js, the checker and the docs are development
tooling and must not be in the upload.
"""
import os
import sys
import zipfile

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
            # arcname without any directory component — index.html must sit at
            # the archive root or the platform will not find the entry point.
            z.write(os.path.join(HERE, f), arcname=f)

    size = os.path.getsize(OUT)
    with zipfile.ZipFile(OUT) as z:
        bad = z.testzip()
        names = z.namelist()
        raw = sum(i.file_size for i in z.infolist())

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

    print("  OK" if ok else "  NOT SHIPPABLE")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
