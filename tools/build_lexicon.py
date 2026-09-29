#!/usr/bin/env python3
"""
Stage 3 - pull the Liddell-Scott-Jones entries this corpus actually needs out of
the Perseus lexicon and convert them from betacode to Unicode.

The full LSJ is ~283 MB of TEI across 27 files, far too much to publish for a
reader covering one dialogue. This keeps only the headwords the morphology stage
asked for and writes:

    data/lex/manifest.json   lemma -> [id, short gloss]   (loaded once, eagerly)
    data/lex/e/<id>.json     one full entry               (fetched on a click)

One file per headword keeps a lookup down to a few kilobytes on a phone.

A tag walker is used rather than an XML parser: the sources declare a DTD, are
very large, and contain markup an off-the-shelf parser chokes on.
"""
import html
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from greek import beta_to_unicode, lemma_key, strip_accents  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LSJ_DIR = os.path.join(ROOT, "cache", "lsj")
LSJ_BASE = ("https://raw.githubusercontent.com/PerseusDL/lexica/master"
            "/CTS_XML_TEI/perseus/pdllex/grc/lsj")
LSJ_FILES = ["grc.lsj.perseus-eng%d.xml" % i for i in range(1, 28)]

GREEK_LANGS = {"greek", "grc"}
MAX_ENTRY_CHARS = 160000

# tag -> (html tag, css class). Tags not listed contribute their text only.
RENDER = {
    "orth": ("span", "lex-orth gk"),
    "itype": ("span", "lex-itype gk"),
    "etym": ("span", "lex-etym gk"),
    "foreign": ("span", "gk"),
    "quote": ("span", "gk"),
    "pron": ("span", "gk"),
    "gramGrp": ("span", "lex-gram"),
    "gram": ("span", "lex-gram"),
    "pos": ("span", "lex-gram"),
    "number": ("span", "lex-gram"),
    "gen": ("span", "lex-gram"),
    "case": ("span", "lex-gram"),
    "mood": ("span", "lex-gram"),
    "tns": ("span", "lex-gram"),
    "per": ("span", "lex-gram"),
    "usg": ("span", "lex-usg"),
    "tr": ("b", "lex-tr"),
    "i": ("i", ""),
    "emph": ("em", ""),
    "hi": ("em", ""),
    "title": ("cite", "lex-cite-title"),
    "author": ("span", "lex-cite-author"),
    "biblScope": ("span", "lex-cite-scope"),
    "bibl": ("span", "lex-cite"),
    "date": ("span", "lex-cite-date"),
    "abbr": ("abbr", ""),
}
DROP = {"pb", "cb", "lb", "figure", "graphic"}
# Content inside these never belongs in a short gloss.
NO_GLOSS = {"etym", "bibl", "cit", "gramGrp", "itype", "orth", "usg", "quote"}

TAG_RE = re.compile(
    r"<(/?)([A-Za-z][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:\"[^\"]*\"|'[^']*'))*)\s*(/?)>")
ATTR_RE = re.compile(r"([\w.:-]+)\s*=\s*(?:\"([^\"]*)\"|'([^']*)')")
ENTRY_RE = re.compile(r"<entryFree\b[^>]*>.*?</entryFree>", re.S)

BAD_GLOSS_RE = re.compile(r"^(v\.|cf\.|see|=|sq\.|Lat\.|dub\.|pl\.|sc\.)\s*", re.I)
CITE_JUNK_RE = re.compile(r"\b[A-Z][a-z]{0,4}\.\s*\d|\d+\.\d+|\bId\.\b|\bib\.\b")
# LSJ tags Indo-European cognates with the same <tr> element it uses for real
# translations, so "nar-, ner-, nr-" arrives looking like a definition. Cognates
# are transliterated with diacritics and bare roots end in a hyphen.
COGNATE_RE = re.compile(r"[^\x00-\x7f]|(?:^|\s)[a-z]{1,6}-(?:\s|$)")


def download_lexicon():
    os.makedirs(LSJ_DIR, exist_ok=True)
    for name in LSJ_FILES:
        path = os.path.join(LSJ_DIR, name)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            continue
        sys.stderr.write("fetching %s\n" % name)
        req = urllib.request.Request("%s/%s" % (LSJ_BASE, name),
                                     headers={"User-Agent": "apollos-reader/1.0"})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)


def attrs_of(s):
    out = {}
    for m in ATTR_RE.finditer(s or ""):
        out[m.group(1)] = m.group(2) if m.group(2) is not None else m.group(3)
    return out


def render_entry(xml):
    """Convert one <entryFree> block.

    Returns (html, glosses, first_sense_text, headword). ``glosses`` holds the
    <tr> translations found inside senses, which is what LSJ uses for the plain
    meaning of a word; citations and etymology are kept out of both gloss
    channels so a study gloss never shows a bibliography reference.
    """
    parts, glosses = [], []
    headword = None
    stack = []                      # [(tag, greek?)]
    open_counts = {}                # tag -> depth, for NO_GLOSS / sense tracking
    tr_buf, sense1_buf = [], []

    def depth(tag):
        return open_counts.get(tag, 0)

    def in_no_gloss():
        return any(depth(t) for t in NO_GLOSS)

    def cur_greek():
        for _tag, greek in reversed(stack):
            if greek is not None:
                return greek
        return False

    def emit(txt):
        if not txt:
            return
        txt = html.unescape(txt)
        if cur_greek():
            txt = beta_to_unicode(txt)
        parts.append(html.escape(txt, quote=False))
        if not in_no_gloss():
            if depth("tr"):
                tr_buf.append(txt)
            elif depth("sense") and not sense1_buf_done[0]:
                sense1_buf.append(txt)

    sense1_buf_done = [False]
    pos = 0

    for m in TAG_RE.finditer(xml):
        emit(xml[pos:m.start()])
        pos = m.end()
        closing, tag, raw, selfclose = m.group(1), m.group(2), m.group(3), m.group(4)

        if tag in DROP:
            continue

        if closing:
            if tag == "tr":
                g = re.sub(r"\s+", " ", "".join(tr_buf)).strip(" ,;:.")
                if g:
                    glosses.append(g)
                tr_buf.clear()
            if tag == "sense" and depth("sense") == 1 and sense1_buf:
                sense1_buf_done[0] = True
            open_counts[tag] = max(0, depth(tag) - 1)
            if stack and stack[-1][0] == tag:
                stack.pop()
            if tag in RENDER:
                parts.append("</%s>" % RENDER[tag][0])
            elif tag == "sense":
                parts.append("</div>")
            continue

        a = attrs_of(raw)
        lang = (a.get("lang") or a.get("xml:lang") or "").lower()
        greek = (lang in GREEK_LANGS) if lang else None

        if tag == "entryFree":
            headword = beta_to_unicode(a.get("key") or "")
            if not selfclose:
                stack.append((tag, greek))
                open_counts[tag] = depth(tag) + 1
            continue

        if tag in NO_GLOSS and depth("tr"):
            # Skipped content still separates words: without this, a <tr> that
            # wraps a citation yields "speakdarkly" instead of "speak darkly".
            tr_buf.append(" ")

        if not selfclose:
            stack.append((tag, greek))
            open_counts[tag] = depth(tag) + 1

        if tag == "sense":
            level = html.escape(a.get("level") or "1")
            n = a.get("n") or ""
            parts.append('<div class="lex-sense" data-level="%s">' % level)
            if n:
                parts.append('<span class="lex-n">%s</span> ' % html.escape(n))
            if selfclose:
                parts.append("</div>")
            continue

        if tag in RENDER:
            el, cls = RENDER[tag]
            parts.append("<%s%s>" % (el, ' class="%s"' % cls if cls else ""))
            if selfclose:
                parts.append("</%s>" % el)

    emit(xml[pos:])

    # Close anything the source left open so the panel markup stays balanced.
    for tag, _greek in reversed(stack):
        if tag in RENDER:
            parts.append("</%s>" % RENDER[tag][0])
        elif tag == "sense":
            parts.append("</div>")

    out = re.sub(r"\s+", " ", "".join(parts))
    out = re.sub(r"\s+([,.;:])", r"\1", out).strip()
    first_sense = re.sub(r"\s+", " ", "".join(sense1_buf)).strip()
    return out, glosses, first_sense, headword


def short_gloss(glosses, first_sense):
    """A compact, honest meaning for interlinear mode."""
    picks, seen = [], set()
    for g in glosses:
        g = re.sub(r"\([^)]*\)", "", g)              # parenthetical asides
        g = re.sub(r"\s+", " ", g).strip(" ,;:.-")
        if not g or len(g) > 30 or BAD_GLOSS_RE.match(g) or CITE_JUNK_RE.search(g):
            continue
        if COGNATE_RE.search(g):
            continue
        low = g.lower()
        if low in seen:
            continue
        seen.add(low)
        picks.append(g)
        if len(picks) == 3:
            break
    if picks:
        return ", ".join(picks)

    # No usable <tr>: fall back to the opening of the first sense.
    txt = re.sub(r"\([^)]*\)", "", first_sense)
    txt = re.sub(r"\s+", " ", txt).strip(" ,;:.-")
    txt = re.sub(r"^(A|B|I|II)\s+", "", txt)
    if CITE_JUNK_RE.search(txt):
        txt = CITE_JUNK_RE.split(txt)[0].strip(" ,;:.-")
    if not txt:
        return ""
    if len(txt) > 58:
        cut = txt[:58]
        if "," in cut:
            cut = cut[:cut.rfind(",")]
        txt = cut.rstrip(" ,;:.-") + "…"
    return txt


def tiny_gloss(g):
    """A gloss narrow enough to sit under the word in interlinear mode.

    A column is as wide as the wider of the word and its gloss, so a 71-
    character gloss for PROS shreds the line. Parentheticals and all but the
    first sense are dropped; anything still long is written out by hand in
    supplement.json instead.
    """
    if not g:
        return ""
    g = re.sub(r"\([^)]*\)", " ", g)
    g = re.sub(r"\s+", " ", g).strip(" ,;:.-")
    g = re.split(r";", g)[0]
    parts = [p.strip() for p in g.split(",") if p.strip()]
    if not parts:
        return ""
    out = parts[0]
    if len(parts) > 1 and len(out) + len(parts[1]) + 2 <= 16:
        out += ", " + parts[1]
    if len(out) > 18:
        out = out[:17].rstrip(" ,;:-") + "…"
    return out


def main():
    slugs = sys.argv[1:] or ["plato-apology"]
    wanted = {}
    for slug in slugs:
        with open(os.path.join(ROOT, "data", "works", slug, "morph.json"),
                  encoding="utf-8") as f:
            for lem in json.load(f)["lemmas"]:
                wanted.setdefault(lemma_key(lem), set()).add(lem)
    loose = {}
    for k in wanted:
        loose.setdefault(strip_accents(k), []).append(k)
    sys.stderr.write("need %d distinct headwords\n" % len(wanted))

    download_lexicon()

    found = {}          # lemma key -> list of rendered entries
    aliased = {}        # lemma key -> LSJ headword it was matched to
    scanned = 0
    for name in LSJ_FILES:
        with open(os.path.join(LSJ_DIR, name), encoding="utf-8", errors="replace") as f:
            blob = f.read()
        start = max(blob.find("<body"), 0)
        for m in ENTRY_RE.finditer(blob, start):
            scanned += 1
            xml = m.group(0)
            km = re.search(r'\bkey="([^"]*)"', xml)
            if not km:
                continue
            lsj_key = lemma_key(beta_to_unicode(km.group(1)))
            targets, exact = [], False
            if lsj_key in wanted:
                targets, exact = [lsj_key], True
            elif len(strip_accents(lsj_key)) >= 3:
                # Accent-insensitive fallback: LSJ writes thnE/|skw where
                # Morpheus returns thnE/skw, and keys TIS once for both ti/s and
                # tis. The length guard keeps single-letter entries (the article
                # O matching the article-shaped entry for the letter omicron)
                # out of the way.
                targets = loose.get(strip_accents(lsj_key)) or []
            if not targets:
                continue
            body, glosses, first_sense, hw = render_entry(xml)
            if not body:
                continue
            entry = {"hw": hw or lsj_key, "html": body,
                     "glosses": glosses, "first": first_sense, "exact": exact}
            for target in targets:
                if not exact:
                    aliased[target] = hw
                found.setdefault(target, []).append(entry)
        sys.stderr.write("  %-28s %6d scanned, %4d matched\n"
                         % (name, scanned, len(found)))

    edir = os.path.join(ROOT, "data", "lex", "e")
    os.makedirs(edir, exist_ok=True)
    for stale in os.listdir(edir):
        os.unlink(os.path.join(edir, stale))

    # Editorial supplement: gloss overrides, orientation notes, and the Morpheus
    # headwords that are wrong for this text.
    with open(os.path.join(ROOT, "tools", "supplement.json"), encoding="utf-8") as f:
        sup = json.load(f)
    sup_gloss = {lemma_key(k): v for k, v in sup.get("gloss", {}).items()}
    sup_short = {lemma_key(k): v for k, v in sup.get("short", {}).items()}
    sup_note = {lemma_key(k): v for k, v in sup.get("note", {}).items()}
    suppress = sorted({lemma_key(k) for k in sup.get("suppress", [])})
    prefer = {k: lemma_key(v) for k, v in sup.get("prefer", {}).items()}
    substantive = sorted({lemma_key(k) for k in sup.get("substantive", [])})

    manifest, truncated = {}, 0
    for i, (k, entries) in enumerate(sorted(found.items())):
        # Entries matched exactly describe this headword; loose matches are only
        # a fallback, and must never supply the gloss when an exact one exists.
        entries = sorted(entries, key=lambda e: not e["exact"])
        pieces = []
        for e in entries:
            pieces.append('<div class="lex-entry"><h4 class="lex-hw gk">%s</h4>%s</div>'
                          % (html.escape(e["hw"]), e["html"]))
        body = "".join(pieces)
        if len(body) > MAX_ENTRY_CHARS:
            body = body[:MAX_ENTRY_CHARS]
            body = body[:body.rfind("<div") if body.rfind("<div") > 0 else len(body)]
            body += ('<p class="lex-cut">This entry is unusually long and has been '
                     'shortened here. Use the links below for the whole of it.</p>')
            truncated += 1
        gloss = short_gloss(entries[0]["glosses"], entries[0]["first"])
        src = 0
        if k in sup_gloss:
            gloss, src = sup_gloss[k], 1
        manifest[k] = [i, gloss, src, sup_short.get(k) or tiny_gloss(gloss)]
        with open(os.path.join(edir, "%d.json" % i), "w", encoding="utf-8") as f:
            json.dump({"hw": entries[0]["hw"], "html": body},
                      f, ensure_ascii=False, separators=(",", ":"))

    # Headwords with no LSJ entry but an editorial gloss still get a manifest
    # row (id -1), so interlinear mode and vocabulary lists are not left blank.
    missing = sorted(set(wanted) - set(found))
    for k in missing:
        if k in sup_gloss or k in sup_note:
            g = sup_gloss.get(k, "")
            manifest[k] = [-1, g, 1, sup_short.get(k) or tiny_gloss(g)]

    notes = {k: v for k, v in sup_note.items() if k in wanted}
    unused = sorted((set(sup_gloss) | set(sup_note)) - set(wanted))

    with open(os.path.join(ROOT, "data", "lex", "manifest.json"), "w",
              encoding="utf-8") as f:
        json.dump({"lex": manifest, "note": notes, "suppress": suppress,
                   "prefer": prefer, "substantive": substantive,
                   "missing": sorted(set(missing) - set(manifest)),
                   "alias": aliased},
                  f, ensure_ascii=False, separators=(",", ":"))

    total = sum(os.path.getsize(os.path.join(edir, n)) for n in os.listdir(edir))
    sizes = sorted(os.path.getsize(os.path.join(edir, n)) for n in os.listdir(edir))
    no_gloss = [k for k, v in manifest.items() if not v[1]]
    sys.stderr.write(
        "matched %d/%d headwords; %.1f MB total, median entry %.1f kB, largest %.0f kB\n"
        % (len(found), len(wanted), total / 1e6,
           sizes[len(sizes) // 2] / 1e3, sizes[-1] / 1e3))
    sys.stderr.write("accent-insensitive matches: %d; truncated: %d; no gloss: %d\n"
                     % (len(aliased), truncated, len(no_gloss)))
    sys.stderr.write("editorial glosses used: %d; notes: %d\n"
                     % (sum(1 for v in manifest.values() if v[2] == 1), len(notes)))
    if unused:
        sys.stderr.write("supplement entries for words not in this text (%d): %s\n"
                         % (len(unused), " ".join(unused)))
    if missing:
        sys.stderr.write("no LSJ entry for %d headwords: %s\n"
                         % (len(missing), " ".join(missing[:30])))


if __name__ == "__main__":
    main()
