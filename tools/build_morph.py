#!/usr/bin/env python3
"""
Stage 2 - resolve every distinct Greek word form in the text to its dictionary
headword(s) and a readable parse, using the Perseus/Tufts Morpheus service.

Results are cached on disk, so re-running is cheap and adding a new text only
queries the forms that text introduces. The published site contains only the
baked JSON: it never calls the morphology service at runtime.

Output: data/works/<slug>/morph.json
"""
import json
import os
import sys
import threading
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from greek import key, tokenize, has_apostrophe, strip_apostrophe  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "cache", "morpheus")
SERVICE = ("https://services.perseids.org/bsp/morphologyservice/analysis/word"
           "?lang=grc&engine=morpheusgrc&word=%s")
WORKERS = 8

# Elision is a closed set in Attic prose, and Morpheus cannot parse an elided
# form, so each apostrophe form is mapped to its full spelling by hand. Keys are
# the lookup key of the elided token (lowercased, apostrophe removed). Anything
# not listed is reported as unresolved rather than guessed at - blind vowel
# probing produces confident nonsense (pa/r' -> phro/s).
ELISION = {
    # particles and conjunctions
    "δ": "δέ",              # d'      de
    "τ": "τε",              # t'      te
    "γ": "γε",              # g'      ge
    "ῥ": "ῥα",              # rh'     rha
    "ἀλλ": "ἀλλά",
    "οὐδ": "οὐδέ",
    "μηδ": "μηδέ",
    "οὔτ": "οὔτε",
    "μήτ": "μήτε",
    "οὔθ": "οὔτε",   # aspirated
    "μήθ": "μήτε",
    "εἴτ": "εἴτε",
    "ἄρ": "ἄρα",
    "ἆρ": "ἆρα",
    "ἄμ": "ἄμα",
    "ποτ": "ποτέ",
    "πώποτ": "πώποτε",
    "ὥστ": "ὥστε",
    "ἵν": "ἵνα",
    "τάχ": "τάχα",
    "τότ": "τότε",
    "εἶτ": "εἶτα",
    "ἐάντ": "ἐάν",   # ea/nt' te -> two words
    # prepositions, including the aspirated forms before a rough breathing
    "ἀπ": "ἀπό",
    "ἀφ": "ἀπό",
    "ἐπ": "ἐπί",
    "ἐφ": "ἐπί",
    "ὑπ": "ὑπό",
    "ὑφ": "ὑπό",
    "μετ": "μετά",
    "μεθ": "μετά",
    "κατ": "κατά",
    "καθ": "κατά",
    "παρ": "παρά",
    "ἀν": "ἀνά",
    "δι": "διά",
    "δί": "διά",
    "ἀμφ": "ἀμφί",
    "ἀντ": "ἀντί",
    "ἀνθ": "ἀντί",
    "ἐναντί": "ἐναντίον",
    # pronouns
    "μ": "με",
    "σ": "σε",
    "ἐμ": "ἐμέ",
    # neuter plurals, demonstratives and other forms in -a / -o
    "ταῦτ": "ταῦτα",
    "τοῦτ": "τοῦτο",
    "τοιαῦτ": "τοιαῦτα",
    "πάντ": "πάντα",
    "πολλ": "πολλά",
    "ἄλλ": "ἄλλα",
    "οἷ": "οἷα",
    "ἐκεῖν": "ἐκεῖνα",
    "πράγματ": "πράγματα",
    # verb forms: elided -i / -o / -e
    "ἐστ": "ἐστί",
    "ἔστ": "ἔστι",
    "ἐσθ": "ἐστί",
    "ἔσθ": "ἔστι",
    "οἶδ": "οἶδα",
    "δέξαιτ": "δέξαιτο",
    "εἴποιμ": "εἴποιμι",
    "θαυμάζοιμ": "θαυμάζοιμι",
    "ἔχοιμ": "ἔχοιμι",
}

# Order in which Morpheus inflection fields are read out, so a parse reads the
# way a student would say it aloud.
FEATURE_ORDER = ["tense", "voice", "mood", "pers", "num", "case", "gend",
                 "comp", "dial", "stemtype"]
SKIP_FEATURES = {"stemtype", "dial"}

_lock = threading.Lock()


def cache_path(word):
    safe = urllib.parse.quote(word, safe="")
    return os.path.join(CACHE, safe + ".json")


def query(word):
    """Fetch (and cache) the raw Morpheus response for one form."""
    path = cache_path(word)
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except ValueError:
            pass
    url = SERVICE % urllib.parse.quote(word)
    req = urllib.request.Request(url, headers={
        "Accept": "application/json", "User-Agent": "apollos-reader/1.0"})
    data = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                data = json.loads(r.read().decode("utf-8"))
            break
        except (urllib.error.URLError, ValueError, OSError) as exc:
            if attempt == 2:
                sys.stderr.write("  ! %s: %s\n" % (word, exc))
                return None
    if data is None:
        return None
    os.makedirs(CACHE, exist_ok=True)
    # Two different lookup keys can resolve to the same query word (an elided
    # form and its full spelling), so the temp name must be per-thread.
    tmp = "%s.%d.tmp" % (path, threading.get_ident())
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        # Another thread cached the same word first; its copy is equivalent.
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return data


def _as_list(x):
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def _val(d, k):
    v = d.get(k)
    if isinstance(v, dict):
        return v.get("$")
    return v


def analyses(data):
    """Flatten a Morpheus response into [{lemma, pos, parse}]."""
    out = []
    if not isinstance(data, dict):
        return out
    body = data.get("RDF", {}).get("Annotation", {}).get("Body")
    for b in _as_list(body):
        if not isinstance(b, dict):
            continue
        entry = b.get("rest", {}).get("entry", {})
        dct = entry.get("dict") or {}
        if isinstance(dct, list):
            dct = dct[0] if dct else {}
        lemma = _val(dct, "hdwd")
        if not lemma:
            continue
        base_pos = _val(dct, "pofs") or ""
        for infl in _as_list(entry.get("infl")) or [{}]:
            if not isinstance(infl, dict):
                continue
            pos = _val(infl, "pofs") or base_pos
            feats = []
            for fkey in FEATURE_ORDER:
                if fkey in SKIP_FEATURES:
                    continue
                v = _val(infl, fkey)
                if v:
                    feats.append(str(v))
            out.append({
                "lemma": unicodedata.normalize("NFC", lemma),
                "pos": pos or "",
                "parse": " ".join(feats),
            })
    # De-duplicate while preserving order.
    seen, uniq = set(), []
    for a in out:
        sig = (a["lemma"], a["pos"], a["parse"])
        if sig not in seen:
            seen.add(sig)
            uniq.append(a)
    return uniq


def resolve(surface):
    """Resolve one surface form, trying elision and case variants."""
    candidates = []
    bare = strip_apostrophe(surface)
    if has_apostrophe(surface):
        full = ELISION.get(bare.lower())
        if full:
            candidates.append(full)
        else:
            return [], True          # unresolved elision
    else:
        candidates.append(surface)
        low = surface.lower()
        if low != surface:
            candidates.append(low)
        else:
            candidates.append(surface[:1].upper() + surface[1:])

    for cand in candidates:
        got = analyses(query(cand))
        if got:
            return got, False
    return [], False


def collect_forms(text_json):
    """Every distinct surface form in a work, with its frequency."""
    counts = {}
    for chunk in text_json["chunks"]:
        for block in chunk["grc"]:
            for word, _s, _e in tokenize(block["s"]):
                counts[word] = counts.get(word, 0) + 1
    return counts


def main():
    slug = sys.argv[1] if len(sys.argv) > 1 else "plato-apology"
    tpath = os.path.join(ROOT, "data", "works", slug, "text.json")
    with open(tpath, encoding="utf-8") as f:
        text = json.load(f)

    counts = collect_forms(text)
    # Group surface variants under the lookup key the browser will compute.
    by_key = {}
    for surface, n in counts.items():
        by_key.setdefault(key(surface), {})[surface] = n
    keys = sorted(by_key)
    total_tokens = sum(counts.values())
    sys.stderr.write("%s: %d tokens, %d distinct forms, %d lookup keys\n"
                     % (slug, total_tokens, len(counts), len(keys)))

    done = [0]

    def work(k):
        # Prefer the most frequent spelling of this key as the query form.
        variants = sorted(by_key[k].items(), key=lambda kv: -kv[1])
        results, bad_elision = [], False
        for surface, _n in variants:
            got, bad = resolve(surface)
            bad_elision = bad_elision or bad
            if got:
                results = got
                break
        with _lock:
            done[0] += 1
            if done[0] % 250 == 0:
                sys.stderr.write("  %d/%d resolved\n" % (done[0], len(keys)))
        return k, results, bad_elision

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        rows = list(pool.map(work, keys))

    lemmas, lemma_ix = [], {}

    def lemma_id(l):
        if l not in lemma_ix:
            lemma_ix[l] = len(lemmas)
            lemmas.append(l)
        return lemma_ix[l]

    forms, unresolved, bad_elisions = {}, [], []
    for k, results, bad in rows:
        if not results:
            freq = sum(by_key[k].values())
            unresolved.append([k, freq])
            if bad:
                bad_elisions.append(k)
            continue
        forms[k] = [[lemma_id(a["lemma"]), a["pos"], a["parse"]] for a in results]

    unresolved.sort(key=lambda kv: -kv[1])
    resolved_tokens = sum(sum(by_key[k].values()) for k in forms)

    out = {
        "slug": slug,
        "lemmas": lemmas,
        "forms": forms,
        "unresolved": [u[0] for u in unresolved],
        "stats": {
            "tokens": total_tokens,
            "keys": len(keys),
            "resolvedKeys": len(forms),
            "resolvedTokens": resolved_tokens,
            "coverage": round(100.0 * resolved_tokens / max(total_tokens, 1), 2),
        },
    }
    dest = os.path.join(ROOT, "data", "works", slug, "morph.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    sys.stderr.write("resolved %d/%d keys; token coverage %.2f%%\n"
                     % (len(forms), len(keys), out["stats"]["coverage"]))
    sys.stderr.write("distinct lemmas: %d\n" % len(lemmas))
    if bad_elisions:
        sys.stderr.write("UNMAPPED ELISIONS (add to ELISION): %s\n"
                         % " ".join(bad_elisions))
    if unresolved:
        sys.stderr.write("top unresolved: %s\n"
                         % " ".join("%s(%d)" % (u[0], u[1]) for u in unresolved[:40]))


if __name__ == "__main__":
    main()
