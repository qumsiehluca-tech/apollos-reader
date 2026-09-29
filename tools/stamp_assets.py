#!/usr/bin/env python3
"""
Version the site's own files so a browser fetches them again when they change.

GitHub Pages serves assets/app.js, assets/styles.css and everything under
data/ under the same names forever, with a cache lifetime of its own choosing.
Without a stamp, someone who has read the site before can run yesterday's
script against today's data, or today's script against yesterday's lexicon,
for as long as their cache holds. Both have happened here.

Two stamps, applied in this order because the second depends on the first:

  1. DATA_V in assets/app.js  <- hash of the JSON the page fetches
  2. ?v= in index.html        <- hash of assets/styles.css and assets/app.js

Run after changing anything in assets/ or rebuilding data/, before committing.
Idempotent.
"""
import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "index.html")
APP = os.path.join(ROOT, "assets", "app.js")
ASSETS = ["assets/styles.css", "assets/app.js"]


def file_digest(path, h=None):
    h = h or hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h


def data_version():
    """Hash every JSON the page can fetch, in a stable order."""
    h = hashlib.sha256()
    data_dir = os.path.join(ROOT, "data")
    paths = []
    for base, _dirs, files in os.walk(data_dir):
        for name in files:
            if name.endswith(".json"):
                paths.append(os.path.join(base, name))
    for path in sorted(paths):
        h.update(os.path.relpath(path, ROOT).replace(os.sep, "/").encode())
        file_digest(path, h)
    return h.hexdigest()[:10], len(paths)


def main():
    version, count = data_version()
    with open(APP, encoding="utf-8") as f:
        app = f.read()
    stamped, n = re.subn(r'var DATA_V = "[^"]*";',
                         'var DATA_V = "%s";' % version, app, count=1)
    if not n:
        sys.stderr.write("ERROR: DATA_V is not declared in assets/app.js\n")
        return 1
    if stamped != app:
        with open(APP, "w", encoding="utf-8", newline="\n") as f:
            f.write(stamped)
    sys.stderr.write("data    %d files -> %s\n" % (count, version))

    with open(PAGE, encoding="utf-8") as f:
        html = f.read()
    for rel in ASSETS:
        v = file_digest(os.path.join(ROOT, rel)).hexdigest()[:10]
        pattern = re.compile(re.escape(rel) + r'(?:\?v=[0-9a-f]+)?')
        html, hits = pattern.subn("%s?v=%s" % (rel, v), html)
        if not hits:
            sys.stderr.write("WARNING: %s is not referenced in index.html\n" % rel)
        sys.stderr.write("stamped %s -> %s\n" % (rel, v))
    with open(PAGE, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    return 0


if __name__ == "__main__":
    sys.exit(main())
