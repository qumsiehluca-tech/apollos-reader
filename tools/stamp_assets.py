#!/usr/bin/env python3
"""
Stamp the stylesheet and script references in index.html with a hash of their
contents, so a browser fetches the new file the moment it changes.

GitHub Pages serves assets/app.js and assets/styles.css under the same name
forever, with a cache lifetime of its own choosing. Without a stamp, someone
who has read the site before can get yesterday's script against today's data
for as long as their cache holds it. Run this after changing anything in
assets/, before committing.
"""
import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "index.html")
ASSETS = ["assets/styles.css", "assets/app.js"]


def digest(rel):
    with open(os.path.join(ROOT, rel), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:10]


def main():
    with open(PAGE, encoding="utf-8") as f:
        html = f.read()

    changed = []
    for rel in ASSETS:
        v = digest(rel)
        # Match the path with or without an existing ?v= stamp.
        pattern = re.compile(re.escape(rel) + r'(?:\?v=[0-9a-f]+)?')
        new = "%s?v=%s" % (rel, v)
        html, n = pattern.subn(new, html)
        if not n:
            sys.stderr.write("WARNING: %s is not referenced in index.html\n" % rel)
        changed.append("%s -> %s" % (rel, v))

    with open(PAGE, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    for line in changed:
        sys.stderr.write("stamped %s\n" % line)


if __name__ == "__main__":
    main()
