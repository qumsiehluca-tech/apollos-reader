#!/usr/bin/env python3
"""
Stage 1 - fetch the TEI editions from the Perseus canonical repository and
flatten them into aligned reading chunks, one per Stephanus section.

Both the Greek (Burnet) and the English (Fowler) editions carry an identical
sequence of <milestone unit="section" resp="Stephanus"/> markers, so those
milestones are the alignment key: chunk "24b" of the Greek is the same passage
as chunk "24b" of the translation.

Output: data/works/<slug>/text.json and data/index.json
"""
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

TEI = "{http://www.tei-c.org/ns/1.0}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "sources")
PERSEUS = ("https://raw.githubusercontent.com/PerseusDL/canonical-greekLit"
           "/master/data/tlg0059/tlg002")

WORKS = [{
    "slug": "plato-apology",
    "title": "Apology of Socrates",
    "titleGrc": "Ἀπολογία Σωκράτους",
    "author": "Plato",
    "urn": "urn:cts:greekLit:tlg0059.tlg002",
    "grc": {
        "file": "tlg0059.tlg002.perseus-grc2.xml",
        "editor": "John Burnet",
        "source": "Platonis Opera, vol. 1 (Oxford: Clarendon Press, 1905)",
        "edition": "perseus-grc2",
    },
    "eng": {
        "file": "tlg0059.tlg002.perseus-eng2.xml",
        "translator": "Harold North Fowler",
        "source": ("Plato in Twelve Volumes, vol. 1 (Cambridge, MA: Harvard "
                   "University Press; London: William Heinemann Ltd., 1914)"),
        "edition": "perseus-eng2",
    },
}]

# Greek takes guillemets, English takes curly quotes.
QUOTES = {"grc": ("«", "»"), "eng": ("“", "”")}

# The Apology falls into three speeches, marked by <milestone unit="speech"/>.
SPEECH_TITLES = {
    "1": "The Defence",
    "2": "On the Penalty",
    "3": "Last Words to the Jury",
}


def fetch(name):
    path = os.path.join(SRC, name)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(SRC, exist_ok=True)
    url = "%s/%s" % (PERSEUS, name)
    sys.stderr.write("fetching %s\n" % url)
    req = urllib.request.Request(url, headers={"User-Agent": "apollos-reader/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    with open(path, "wb") as f:
        f.write(data)
    return path


def walk(node, lang, out):
    """Depth-first walk of the TEI tree emitting document-order events."""
    tag = node.tag.replace(TEI, "")

    if tag == "milestone":
        unit, n = node.get("unit"), node.get("n")
        if unit == "section" and node.get("resp") == "Stephanus":
            out.append(("section", n))
        elif unit == "page":
            out.append(("page", n))
        elif unit == "para":
            out.append(("para", None))
        elif unit == "speech":
            out.append(("speech", n))
        if node.tail:
            out.append(("text", node.tail))
        return

    if tag == "note":
        out.append(("note", " ".join("".join(node.itertext()).split())))
        if node.tail:
            out.append(("text", node.tail))
        return

    if tag == "del":
        # Editorial deletion, shown in square brackets (Leiden convention).
        out.append(("text", "[" + "".join(node.itertext()) + "]"))
        if node.tail:
            out.append(("text", node.tail))
        return

    if tag == "add":
        # Editorial addition, shown in angle brackets.
        out.append(("text", "⟨" + "".join(node.itertext()) + "⟩"))
        if node.tail:
            out.append(("text", node.tail))
        return

    quoted = tag in ("q", "said", "quote")
    if quoted:
        out.append(("text", QUOTES[lang][0]))
    if tag == "l":
        out.append(("verse", None))

    if node.text:
        out.append(("text", node.text))
    for child in node:
        walk(child, lang, out)

    if tag == "l":
        out.append(("verse_end", None))
    if quoted:
        out.append(("text", QUOTES[lang][1]))
    if tag in ("p", "div"):
        out.append(("para_end", None))
    if node.tail:
        out.append(("text", node.tail))


def tidy(s):
    s = re.sub(r"\s+", " ", s.replace("\n", " ")).strip()
    # Perseus sets em dashes tight against the words on either side, which is
    # hard to see on screen and, in interlinear mode, glues the dash to a word
    # column. Give them room without touching anything else.
    s = re.sub(r"\s*—\s*", " — ", s)
    return s.strip()


def build_side(path, lang):
    """Return an ordered list of chunks, one per Stephanus section."""
    body = ET.parse(path).getroot().find(".//%sbody" % TEI)
    events = []
    walk(body, lang, events)

    chunks, cur, block = [], None, None
    page, speech = None, None
    # Paragraphs run across Stephanus sections, so each block records which
    # paragraph it belongs to. Without this the reader cannot tell a section
    # break that starts a new paragraph from one that lands mid-sentence.
    para_no = [0]

    def flush():
        nonlocal block
        if block is not None:
            text = tidy(block["s"])
            if text and cur is not None:
                cur["blocks"].append({"t": block["t"], "s": text, "g": para_no[0]})
            block = None

    def open_block(kind="p"):
        nonlocal block
        flush()
        block = {"t": kind, "s": ""}

    for kind, val in events:
        if kind == "page":
            page = val
        elif kind == "speech":
            speech = val
        elif kind == "section":
            flush()
            cur = {
                "ref": val,
                "page": page or re.match(r"\d+", val).group(0),
                "speech": speech,
                "blocks": [],
                "notes": [],
            }
            chunks.append(cur)
            open_block("p")
        elif kind == "para":
            para_no[0] += 1
            open_block("p")
        elif kind == "para_end":
            flush()
        elif kind == "verse":
            open_block("verse")
        elif kind == "verse_end":
            flush()
        elif kind == "note":
            if cur is not None and val:
                cur["notes"].append(val)
        elif kind == "text":
            if block is None:
                open_block("p")
            block["s"] += val
    flush()
    return chunks


def main():
    index = []
    for w in WORKS:
        grc = build_side(fetch(w["grc"]["file"]), "grc")
        eng = build_side(fetch(w["eng"]["file"]), "eng")

        gmap = {c["ref"]: c for c in grc}
        emap = {c["ref"]: c for c in eng}
        refs = [c["ref"] for c in grc]

        if len(refs) != len(gmap):
            sys.stderr.write("WARNING: duplicate Stephanus refs in Greek\n")
        missing = [r for r in refs if r not in emap]
        if missing:
            sys.stderr.write("WARNING: untranslated sections: %s\n" % missing)
        extra = [c["ref"] for c in eng if c["ref"] not in gmap]
        if extra:
            sys.stderr.write("WARNING: translation-only sections: %s\n" % extra)

        chunks = []
        for r in refs:
            g = gmap[r]
            e = emap.get(r) or {"blocks": [], "notes": []}
            chunks.append({
                "ref": r,
                "page": g["page"],
                "speech": g["speech"],
                "grc": g["blocks"],
                "eng": e["blocks"],
                "notes": e["notes"],
            })

        out = {
            "slug": w["slug"],
            "title": w["title"],
            "titleGrc": w["titleGrc"],
            "author": w["author"],
            "urn": w["urn"],
            "speeches": SPEECH_TITLES,
            "grcSource": {k: v for k, v in w["grc"].items() if k != "file"},
            "engSource": {k: v for k, v in w["eng"].items() if k != "file"},
            "chunks": chunks,
        }

        dest = os.path.join(ROOT, "data", "works", w["slug"])
        os.makedirs(dest, exist_ok=True)
        with open(os.path.join(dest, "text.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

        gw = sum(len(b["s"].split()) for c in chunks for b in c["grc"])
        ew = sum(len(b["s"].split()) for c in chunks for b in c["eng"])
        sys.stderr.write("%s: %d sections (%s-%s), %d Greek words, %d English words\n"
                         % (w["slug"], len(chunks), refs[0], refs[-1], gw, ew))

        index.append({
            "slug": w["slug"], "title": w["title"], "titleGrc": w["titleGrc"],
            "author": w["author"], "sections": len(chunks),
            "first": refs[0], "last": refs[-1],
        })

    with open(os.path.join(ROOT, "data", "index.json"), "w", encoding="utf-8") as f:
        json.dump({"works": index}, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
