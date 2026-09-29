#!/usr/bin/env python3
"""Shared Greek helpers: tokenising, key normalisation, betacode conversion."""
import re
import unicodedata

# Greek and Coptic, Greek Extended, combining diacritics.
LETTERS = "Ͱ-Ͽἀ-῿̀-ͯ"
# Elision / crasis apostrophes seen in the Perseus texts.
APOS = "ʼ’᾽´'"

WORD_RE = re.compile("[%s]+[%s]?" % (LETTERS, APOS))


def tokenize(text):
    """Yield (word, start, end) for every Greek word in text."""
    for m in WORD_RE.finditer(text):
        yield m.group(0), m.start(), m.end()


def has_apostrophe(w):
    return bool(w) and w[-1] in APOS


def strip_apostrophe(w):
    return w[:-1] if has_apostrophe(w) else w


def key(word):
    """Lookup key for a surface form: NFC, lowercased, apostrophe removed.

    Must stay byte-for-byte identical to normaliseKey() in assets/app.js.
    """
    w = unicodedata.normalize("NFC", word)
    w = strip_apostrophe(w)
    return w.lower()


def strip_accents(word):
    """Drop diacritics entirely - used only for accent-insensitive search."""
    d = unicodedata.normalize("NFD", word)
    d = "".join(c for c in d if not unicodedata.combining(c))
    return unicodedata.normalize("NFC", d).lower()


# --------------------------------------------------------------------------
# Betacode -> Unicode
#
# The Perseus LSJ is encoded in TLG betacode: an optional leading '*' marks a
# capital, diacritics follow the base letter as ) ( / \ = + |.
# --------------------------------------------------------------------------
BETA_LETTERS = {
    "a": "α", "b": "β", "g": "γ", "d": "δ", "e": "ε",
    "z": "ζ", "h": "η", "q": "θ", "i": "ι", "k": "κ",
    "l": "λ", "m": "μ", "n": "ν", "c": "ξ", "o": "ο",
    "p": "π", "r": "ρ", "s": "σ", "t": "τ", "u": "υ",
    "f": "φ", "x": "χ", "y": "ψ", "w": "ω",
    "v": "ϝ",  # digamma
}
BETA_MARKS = {
    ")": "̓",  # smooth breathing
    "(": "̔",  # rough breathing
    "/": "́",  # acute
    "\\": "̀",  # grave
    "=": "͂",  # circumflex
    "+": "̈",  # diaeresis
    "|": "ͅ",  # iota subscript
}
# Perseus dictionary keys annotate vowel quantity (do/ca^ = doxa with a breve).
# These are editorial metadata, not letters, so they are dropped: leaving them
# in silently breaks every headword that carries one.
BETA_QUANTITY = "^_"
# Compose order matters for NFC: breathing/diaeresis, then accent, then iota.
_MARK_ORDER = {"̓": 0, "̔": 0, "̈": 0,
               "́": 1, "̀": 1, "͂": 1,
               "ͅ": 2}


def beta_to_unicode(s):
    """Convert a betacode string to composed Unicode Greek."""
    if not s:
        return ""
    out = []
    i, n = 0, len(s)
    while i < n:
        ch = s[i]
        if ch in BETA_QUANTITY:
            i += 1
            continue
        cap = False
        if ch == "*":
            cap = True
            i += 1
            # Diacritics may precede the letter after '*'.
            pre = []
            while i < n and s[i] in BETA_MARKS:
                pre.append(BETA_MARKS[s[i]])
                i += 1
            if i >= n:
                break
            base = s[i].lower()
            i += 1
            marks = list(pre)
        else:
            base = ch.lower()
            i += 1
            marks = []

        if base not in BETA_LETTERS:
            # Punctuation and latin text pass through untouched.
            out.append(ch)
            continue

        # Sigma variants: s1 = medial, s2/s3 = final/lunate.
        if base == "s" and i < n and s[i] in "123":
            variant = s[i]
            i += 1
            letter = {"1": "σ", "2": "ς", "3": "ϲ"}[variant]
        else:
            letter = BETA_LETTERS[base]

        while i < n and (s[i] in BETA_MARKS or s[i] in BETA_QUANTITY):
            if s[i] in BETA_MARKS:
                marks.append(BETA_MARKS[s[i]])
            i += 1

        if cap:
            letter = letter.upper()
        elif letter == "σ":
            # Final sigma when the next character does not continue the word.
            nxt = s[i] if i < n else ""
            if not (nxt.lower() in BETA_LETTERS or nxt in BETA_MARKS or nxt == "*"):
                letter = "ς"

        marks.sort(key=lambda m: _MARK_ORDER.get(m, 9))
        out.append(unicodedata.normalize("NFC", letter + "".join(marks)))
    return "".join(out)


def lemma_key(lemma):
    """Normalise a dictionary headword for matching.

    Morpheus returns homonym numbers (``ou)do/s1``); LSJ keys carry them too.
    """
    l = unicodedata.normalize("NFC", lemma).strip()
    l = re.sub(r"\d+$", "", l)
    l = l.replace("-", "")
    return l.lower()
