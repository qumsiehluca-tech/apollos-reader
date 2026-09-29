/* ==========================================================================
   Apollo's Reader
   Plain JavaScript, no build step, no framework: the site is just files that
   GitHub Pages can serve.
   ========================================================================== */
(function () {
  "use strict";

  var WORK = "plato-apology";
  var STORE = "apollos-reader:";
  var PHONE = "(max-width: 760px)";
  var DRAWER = "(max-width: 1100px)";

  /* --- Greek helpers ----------------------------------------------------- */
  // Kept byte-for-byte in step with tools/greek.py.
  var LETTERS = "\\u0370-\\u03ff\\u1f00-\\u1fff\\u0300-\\u036f";
  var APOS = "\\u02bc\\u2019\\u1fbd\\u1ffd'";
  var WORD_RE = new RegExp("[" + LETTERS + "]+[" + APOS + "]?", "g");
  var APOS_SET = "ʼ’᾽´'";

  function normaliseKey(word) {
    var w = word.normalize("NFC");
    if (w && APOS_SET.indexOf(w[w.length - 1]) >= 0) w = w.slice(0, -1);
    return w.toLowerCase();
  }
  function stripAccents(s) {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC").toLowerCase();
  }
  // Morpheus returns homonym numbers and capitals (le/gw1, *)aqhnai=os) that
  // the lexicon manifest does not carry.
  function lemmaKey(l) {
    return l.normalize("NFC").replace(/\d+$/, "").replace(/-/g, "").toLowerCase();
  }
  function lemmaLabel(l) { return l.normalize("NFC").replace(/\d+$/, ""); }

  /* --- parse abbreviations ----------------------------------------------- */
  var ABBR = {
    present: "pres", imperfect: "impf", future: "fut", aorist: "aor",
    perfect: "perf", pluperfect: "plpf", futureperfect: "fut perf",
    active: "act", middle: "mid", passive: "pass", mediopassive: "mid/pass",
    indicative: "ind", subjunctive: "subj", optative: "opt",
    imperative: "impv", infinitive: "inf", participle: "ptcp",
    singular: "sg", plural: "pl", dual: "du",
    nominative: "nom", genitive: "gen", dative: "dat",
    accusative: "acc", vocative: "voc",
    masculine: "masc", feminine: "fem", neuter: "neut",
    comparative: "compar", superlative: "superl"
  };
  function abbreviate(parse) {
    if (!parse) return "";
    return parse.split(/\s+/).map(function (w) { return ABBR[w] || w; }).join(" ");
  }

  /* --- DOM helpers ------------------------------------------------------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function $(id) { return document.getElementById(id); }
  function txt(s) { return document.createTextNode(s); }
  function mq(q) { return window.matchMedia(q).matches; }

  /* --- settings ---------------------------------------------------------- */
  var DEFAULTS = {
    mode: "parallel", theme: "obsidian", accent: "terracotta",
    grcFont: "cardo", grcSize: 21, lead: 1.95, measure: 38, engSize: 17,
    gloss: "always", glossType: "gloss",
    showRefs: true, showVocab: false, showCitations: false,
    swapSides: false, justify: false, sidebar: true
  };
  var S = Object.assign({}, DEFAULTS);

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORE + "settings");
      if (raw) Object.assign(S, JSON.parse(raw));
    } catch (e) { /* storage blocked */ }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE + "settings", JSON.stringify(S)); } catch (e) {}
  }
  function applySettings() {
    var r = document.documentElement;
    r.dataset.theme = S.theme;
    r.dataset.accent = S.accent;
    r.dataset.grcFont = S.grcFont;
    r.dataset.gloss = S.gloss;
    r.dataset.refs = S.showRefs ? "on" : "off";
    r.dataset.vocab = S.showVocab ? "on" : "off";
    r.dataset.citations = S.showCitations ? "on" : "off";
    r.dataset.swap = S.swapSides ? "on" : "off";
    r.dataset.justify = S.justify ? "on" : "off";
    r.style.setProperty("--grc-size", S.grcSize + "px");
    r.style.setProperty("--eng-size", S.engSize + "px");
    r.style.setProperty("--lead", S.lead);
    r.style.setProperty("--measure", S.measure + "rem");
    if (!mq(DRAWER)) {
      if (S.sidebar) delete document.body.dataset.nav;
      else document.body.dataset.nav = "shut";
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", getComputedStyle(document.body).backgroundColor || "#141210");
  }

  /* --- state ------------------------------------------------------------- */
  var text = null, morph = null, lex = null;
  var reader = $("reader");
  var chunkByRef = {};
  var commonLemmas = {}, lemmaFreq = {}, corpusFreq = {};
  var entryCache = {};
  var suppressed = {};
  var currentRef = null;
  var openWord = null;
  var popLemmas = [], popLemma = null, popAnchor = null;

  function lexRow(lemma) { return lex.lex[lemmaKey(lemma)] || null; }
  function glossFor(l) { var h = lexRow(l); return h ? h[1] : ""; }
  function shortFor(l) { var h = lexRow(l); return h ? (h[3] || h[1]) : ""; }
  function isEditorial(l) { var h = lexRow(l); return !!h && h[2] === 1; }
  function noteFor(l) { return (lex.note || {})[lemmaKey(l)] || ""; }
  function hasEntry(l) { var h = lexRow(l); return !!h && h[0] >= 0; }

  // Morpheus often returns several headwords for one form and the first is not
  // always the plausible one (doko= gives doko/s "beam" beside doke/w "seem").
  // An uninflected word is nearly always itself, so a headword identical to the
  // form outranks one the lexicon merely happens to gloss.
  function scoreAnalysis(a, key) {
    var k = lemmaKey(a.lemma);
    if (suppressed[k]) return 0;
    if (key && (lex.prefer || {})[key] === k) return 20;
    var s = glossFor(a.lemma) ? 2 : 1;
    if (key && stripAccents(k) === stripAccents(key)) s += 3;
    return s;
  }
  function analysesFor(key) {
    var rows = morph.forms[key];
    if (!rows) return null;
    return rows.map(function (r) {
      return { lemma: morph.lemmas[r[0]], pos: r[1], parse: r[2] };
    }).sort(function (x, y) {
      var d = scoreAnalysis(y, key) - scoreAnalysis(x, key);
      if (d) return d;
      // Tie: the headword this dialogue actually uses wins. EI)/H is a form of
      // both EI)MI/ and E)A/W, and only one of them is everywhere in the text.
      return (corpusFreq[lemmaKey(y.lemma)] || 0) - (corpusFreq[lemmaKey(x.lemma)] || 0);
    });
  }

  // Counted from forms that admit only one headword, so it is a fact about the
  // text rather than a product of the ranking it then feeds.
  function computeCorpusFreq() {
    text.chunks.forEach(function (c) {
      c.grc.forEach(function (b) {
        WORD_RE.lastIndex = 0;
        var m;
        while ((m = WORD_RE.exec(b.s)) !== null) {
          var rows = morph.forms[normaliseKey(m[0])];
          if (!rows) continue;
          var first = lemmaKey(morph.lemmas[rows[0][0]]);
          var single = true;
          for (var i = 1; i < rows.length; i++) {
            if (lemmaKey(morph.lemmas[rows[i][0]]) !== first) { single = false; break; }
          }
          if (single) corpusFreq[first] = (corpusFreq[first] || 0) + 1;
        }
      });
    });
  }
  function bestLemma(key) {
    var an = analysesFor(key);
    return an ? an[0].lemma : null;
  }

  /* --- rendering --------------------------------------------------------- */
  function wordSpan(surface) {
    var key = normaliseKey(surface);
    var s = el("span", morph.forms[key] ? "w" : "w unknown", surface);
    s.dataset.k = key;
    return s;
  }

  function glossNode(key) {
    var gl = el("span", "gl");
    var an = analysesFor(key);
    if (!an) return gl;
    if (S.glossType === "gloss" || S.glossType === "both") {
      gl.append(txt(shortFor(an[0].lemma) || ""));
    }
    if (S.glossType === "parse" || S.glossType === "both") {
      gl.append(el("span", "pr", abbreviate(an[0].parse) || an[0].pos || ""));
    }
    return gl;
  }

  function renderRun(parent, str, interlinear) {
    WORD_RE.lastIndex = 0;
    var toks = [], m;
    while ((m = WORD_RE.exec(str)) !== null) toks.push(m);
    if (!toks.length) { parent.append(txt(str)); return; }

    var pos = 0;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.index > pos) parent.append(txt(str.slice(pos, t.index)));
      var end = t.index + t[0].length;

      if (!interlinear) {
        parent.append(wordSpan(t[0]));
        pos = end;
        continue;
      }
      // Punctuation that hugs the word travels in the same column.
      var limit = (i + 1 < toks.length) ? toks[i + 1].index : str.length;
      var tight = end;
      while (tight < limit && !/\s/.test(str[tight])) tight++;

      // The word and any punctuation clinging to it share one line; the gloss
      // sits on the line below. Without the wrapper the comma after a word
      // would drop onto its own line between the two.
      var unit = el("span", "iw");
      var line = el("span", "w-line");
      line.append(wordSpan(t[0]));
      if (tight > end) line.append(txt(str.slice(end, tight)));
      unit.append(line);
      unit.append(glossNode(normaliseKey(t[0])));
      parent.append(unit);
      pos = tight;
    }
    if (pos < str.length) parent.append(txt(str.slice(pos)));
  }

  function renderBlocks(host, blocks, lang, interlinear) {
    blocks.forEach(function (b) {
      var p = el("p", b.t === "verse" ? "verse" : null);
      if (lang === "grc") renderRun(p, b.s, interlinear);
      else p.append(txt(b.s));
      host.append(p);
    });
  }

  function vocabFor(chunk) {
    var seen = {}, items = [];
    chunk.grc.forEach(function (b) {
      WORD_RE.lastIndex = 0;
      var m;
      while ((m = WORD_RE.exec(b.s)) !== null) {
        var lemma = bestLemma(normaliseKey(m[0]));
        if (!lemma) continue;
        var k = lemmaKey(lemma);
        if (seen[k] || commonLemmas[k]) continue;
        seen[k] = 1;
        var g = glossFor(lemma);
        if (g) items.push([lemmaLabel(lemma), g]);
      }
    });
    return items;
  }

  function vocabNode(chunk) {
    var items = vocabFor(chunk);
    if (!items.length) return null;
    var d = el("details", "vocab");
    d.append(el("summary", null, "Vocabulary · " + items.length));
    var ul = el("ul", "vocab-list");
    items.forEach(function (it) {
      var li = el("li");
      li.append(el("b", "gk", it[0]), txt(" — " + it[1]));
      ul.append(li);
    });
    d.append(ul);
    return d;
  }

  function render() {
    var interlinear = S.mode === "interlinear";
    reader.className = "reader mode-" + S.mode;
    reader.textContent = "";

    var head = el("div", "work-head");
    head.append(el("div", "wh-grc gk", text.titleGrc));
    head.append(el("div", "wh-eng", text.author + ", " + text.title));
    head.append(el("div", "wh-meta", "Greek: Burnet 1905 · English: Fowler 1914"));
    reader.append(head);

    var lastSpeech = null;
    text.chunks.forEach(function (c) {
      if (c.speech && c.speech !== lastSpeech) {
        lastSpeech = c.speech;
        var title = (text.speeches || {})[c.speech];
        if (title) {
          var sh = el("div", "speech-head");
          sh.append(el("div", "sh-rule"));
          var h2 = el("h2");
          h2.append(el("span", null, title));
          sh.append(h2);
          reader.append(sh);
        }
      }

      var sec = el("section", "sec");
      sec.id = "s-" + c.ref;
      sec.dataset.ref = c.ref;

      var ref = el("button", "sec-ref", c.ref);
      ref.type = "button";
      ref.title = "Copy a link to " + c.ref;
      sec.append(ref);

      var grc = el("div", "sec-grc");
      var gt = el("div", "grc-text gk");
      renderBlocks(gt, c.grc, "grc", interlinear);
      grc.append(gt);
      sec.append(grc);

      var eng = el("div", "sec-eng");
      var et = el("div", "eng-text");
      renderBlocks(et, c.eng, "eng", false);
      if (c.notes && c.notes.length) {
        et.append(el("p", "eng-note", c.notes.join(" · ")));
      }
      eng.append(et);
      sec.append(eng);

      if (S.showVocab) {
        var v = vocabNode(c);
        if (v) sec.append(v);
      }
      reader.append(sec);
    });

    observeSections();
  }

  /* --- current section --------------------------------------------------- */
  var observer = null;
  function observeSections() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var ref = e.target.dataset.ref;
        if (ref && ref !== currentRef) setCurrent(ref, false);
      });
    }, { rootMargin: "-80px 0px -70% 0px", threshold: 0 });
    reader.querySelectorAll(".sec").forEach(function (s) { observer.observe(s); });
  }

  function setCurrent(ref, scroll) {
    currentRef = ref;
    $("sectionNav").querySelectorAll("button").forEach(function (b) {
      if (b.dataset.ref === ref) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
    var sub = $("brandSub");
    if (sub) sub.textContent = "Plato · Apology · " + ref;
    try { localStorage.setItem(STORE + "pos", ref); } catch (e) {}
    history.replaceState(null, "", "#" + ref);
    if (scroll) {
      var node = $("s-" + ref);
      if (node) node.scrollIntoView({ block: "start" });
    }
  }

  function buildNav() {
    var host = $("sectionNav");
    host.textContent = "";
    var groups = [], last = null;
    text.chunks.forEach(function (c) {
      if (c.speech !== last) { last = c.speech; groups.push({ speech: c.speech, refs: [] }); }
      groups[groups.length - 1].refs.push(c.ref);
    });
    groups.forEach(function (g) {
      var wrap = el("div", "speech-group");
      var title = (text.speeches || {})[g.speech];
      if (title) wrap.append(el("div", "speech-label", title));
      var grid = el("div", "ref-grid");
      g.refs.forEach(function (ref) {
        var b = el("button", null, ref);
        b.dataset.ref = ref;
        b.addEventListener("click", function () {
          setCurrent(ref, true);
          if (mq(DRAWER)) closeOverlays();
        });
        grid.append(b);
      });
      wrap.append(grid);
      host.append(wrap);
    });
  }

  /* ========================================================================
     Word lookup popover
     ======================================================================== */
  function positionPop() {
    var pop = $("pop");
    if (mq(PHONE) || !popAnchor) {
      pop.removeAttribute("data-dir");
      pop.style.maxHeight = "";
      return;
    }

    var r = popAnchor.getBoundingClientRect();
    var vw = document.documentElement.clientWidth;
    var vh = window.innerHeight;
    var gap = 10, edge = 12;

    // Take whichever side has room, then cap the height to that room. Without
    // the cap, expanding the entry next to a word halfway down the screen
    // pushes the popover off the bottom.
    var below = vh - r.bottom - gap - edge;
    var above = r.top - gap - edge;
    var up = below < 260 && above > below;
    pop.style.maxHeight = Math.max(180, Math.min(540, up ? above : below)) + "px";

    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.max(edge, Math.min(r.left + r.width / 2 - w / 2, vw - w - edge));
    var top = up ? r.top - h - gap : r.bottom + gap;
    top = Math.max(edge, Math.min(top, vh - h - edge));

    pop.dataset.dir = up ? "up" : "down";
    pop.style.left = (left + window.scrollX) + "px";
    pop.style.top = (top + window.scrollY) + "px";
    var ax = r.left + r.width / 2 - left;
    pop.style.setProperty("--arrow-x", Math.max(16, Math.min(ax, w - 16)) + "px");
  }

  function clearOpenWord() {
    if (!openWord) return;
    openWord.classList.remove("is-open");
    if (openWord.parentElement) openWord.parentElement.classList.remove("is-open");
    openWord = null;
  }

  function closePop() {
    $("pop").hidden = true;
    popAnchor = null;
    clearOpenWord();
  }

  function fillEntry(lemma) {
    var host = $("pop").querySelector(".lex-target");
    if (!host) return;
    var hit = lexRow(lemma);
    if (!hit || hit[0] < 0) {
      host.textContent = "";
      host.append(el("p", "wp-empty",
        "Liddell-Scott-Jones has no separate entry under this headword — it is " +
        "usually a proper name, or a word the lexicon files under another. The " +
        "links below will look it up in full."));
      positionPop();
      return;
    }
    var id = hit[0];
    if (entryCache[id]) { host.innerHTML = entryCache[id]; positionPop(); return; }
    host.textContent = "";
    host.append(el("p", "lex-loading", "Fetching the entry…"));
    fetch("data/lex/e/" + id + ".json")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        entryCache[id] = d.html;
        host.innerHTML = d.html;
        positionPop();
      })
      .catch(function () {
        host.textContent = "";
        host.append(el("p", "wp-empty", "The entry could not be loaded."));
      });
  }

  function setPopLemma(lemma) {
    popLemma = lemma;
    $("pop").querySelectorAll(".pop-lemma-tabs button").forEach(function (b) {
      b.setAttribute("aria-checked", b.dataset.lemma === lemma ? "true" : "false");
    });
    buildLinks(lemma);
    var body = $("pop").querySelector(".lex-target");
    if (body && !body.closest("[hidden]")) fillEntry(lemma);
    else if (body) body.textContent = "";
  }

  function buildLinks(lemma) {
    var foot = $("popLinks");
    foot.textContent = "";
    function add(label, href) {
      var a = el("a", null, label);
      a.href = href; a.target = "_blank"; a.rel = "noopener";
      foot.append(a);
    }
    var form = $("popForm").textContent;
    if (lemma) add("Logeion", "https://logeion.uchicago.edu/" + encodeURIComponent(lemmaLabel(lemma)));
    add("Perseus parse", "https://www.perseus.tufts.edu/hopper/morph?l=" +
      encodeURIComponent(form) + "&la=greek");
    if (lemma) add("Wiktionary", "https://en.wiktionary.org/wiki/" +
      encodeURIComponent(lemmaLabel(lemma)) + "#Ancient_Greek");
  }

  function openPop(span) {
    var key = span.dataset.k;
    var sec = span.closest(".sec");
    var pop = $("pop");

    clearOpenWord();
    openWord = span;
    span.classList.add("is-open");
    if (span.parentElement.classList.contains("iw")) span.parentElement.classList.add("is-open");
    popAnchor = span;

    $("popForm").textContent = span.textContent;
    $("popRef").textContent = sec ? "Apology " + sec.dataset.ref : "";

    var body = $("popBody");
    body.textContent = "";
    var an = analysesFor(key);
    var more = $("popMore");

    if (!an) {
      body.append(el("p", "wp-empty",
        "This form is not in the parsed index — usually a proper name the " +
        "parser does not carry. Try the lookups below."));
      more.hidden = true;
      buildLinks(null);
      pop.hidden = false;
      positionPop();
      return;
    }

    an.forEach(function (a) {
      var row = el("div", "an");
      var top = el("div", "an-top");
      top.append(el("span", "an-lemma gk", lemmaLabel(a.lemma)));
      if (a.pos) top.append(el("span", "an-pos", a.pos));
      if (suppressed[lemmaKey(a.lemma)]) top.append(el("span", "an-flag", "unlikely here"));
      row.append(top);
      if (a.parse) row.append(el("div", "an-parse", abbreviate(a.parse)));
      var g = glossFor(a.lemma);
      if (g) {
        var gl = el("div", "an-gloss", g);
        if (isEditorial(a.lemma)) gl.append(el("span", "an-ed", "editorial"));
        row.append(gl);
      }
      body.append(row);
    });

    popLemmas = [];
    an.forEach(function (a) { if (popLemmas.indexOf(a.lemma) < 0) popLemmas.push(a.lemma); });
    popLemmas.sort(function (x, y) { return (hasEntry(y) ? 1 : 0) - (hasEntry(x) ? 1 : 0); });

    for (var i = 0; i < popLemmas.length; i++) {
      var note = noteFor(popLemmas[i]);
      if (note) {
        var nb = el("div", "an-note");
        nb.append(el("span", "an-note-tag", "Note"));
        nb.append(txt(note));
        body.append(nb);
        break;
      }
    }

    var block = el("div", "lex-block");
    block.hidden = true;
    block.append(el("h4", null, "Liddell · Scott · Jones"));
    if (popLemmas.length > 1) {
      var tabs = el("div", "pop-lemma-tabs");
      popLemmas.forEach(function (l) {
        var b = el("button", "gk", lemmaLabel(l));
        b.dataset.lemma = l;
        b.addEventListener("click", function () { setPopLemma(l); });
        tabs.append(b);
      });
      block.append(tabs);
    }
    block.append(el("div", "lex-target"));
    body.append(block);

    more.hidden = false;
    more.setAttribute("aria-expanded", "false");
    more.textContent = "Full dictionary entry";

    popLemma = popLemmas[0];
    $("pop").querySelectorAll(".pop-lemma-tabs button").forEach(function (b) {
      b.setAttribute("aria-checked", b.dataset.lemma === popLemma ? "true" : "false");
    });
    buildLinks(popLemma);

    pop.hidden = false;
    positionPop();

    // Nothing useful to show up top? Then open the entry straight away.
    if (!glossFor(popLemma) && hasEntry(popLemma)) toggleEntry(true);
  }

  function toggleEntry(force) {
    var block = $("pop").querySelector(".lex-block");
    var more = $("popMore");
    if (!block) return;
    var show = (force === undefined) ? block.hidden : force;
    block.hidden = !show;
    more.setAttribute("aria-expanded", show ? "true" : "false");
    more.textContent = show ? "Hide dictionary entry" : "Full dictionary entry";
    if (show) fillEntry(popLemma);
    positionPop();
  }

  /* --- search ------------------------------------------------------------ */
  var searchIndex = null;
  function buildSearchIndex() {
    searchIndex = text.chunks.map(function (c) {
      var g = c.grc.map(function (b) { return b.s; }).join(" ");
      var e = c.eng.map(function (b) { return b.s; }).join(" ");
      return { ref: c.ref, g: g, gs: stripAccents(g), e: e, es: e.toLowerCase() };
    });
  }

  function runSearch(q) {
    var host = $("searchResults");
    host.textContent = "";
    q = q.trim();
    if (q.length < 2) return;
    if (!searchIndex) buildSearchIndex();

    var greek = /[Ͱ-Ͽἀ-῿]/.test(q);
    var needle = greek ? stripAccents(q) : q.toLowerCase();
    var rows = [];

    for (var i = 0; i < searchIndex.length; i++) {
      var row = searchIndex[i];
      var hay = greek ? row.gs : row.es;
      var at = hay.indexOf(needle);
      if (at < 0) continue;
      rows.push({ row: row, at: at });
    }

    host.append(el("p", "sr-count",
      rows.length ? rows.length + (rows.length === 1 ? " section" : " sections") : ""));
    if (!rows.length) {
      host.textContent = "";
      host.append(el("p", "sr-none", "Nothing found for “" + q + "”."));
      return;
    }

    rows.slice(0, 80).forEach(function (hit) {
      var source = greek ? hit.row.g : hit.row.e;
      var from = Math.max(0, hit.at - 42);
      var snippet = (from > 0 ? "…" : "") +
        source.slice(from, hit.at + needle.length + 60).trim() + "…";
      var b = el("button");
      b.append(el("div", "sr-ref", "Apology " + hit.row.ref));
      b.append(el("div", "sr-txt" + (greek ? " gk" : ""), snippet));
      b.addEventListener("click", function () {
        closeOverlays();
        setCurrent(hit.row.ref, true);
        highlight(hit.row.ref, needle, greek);
      });
      host.append(b);
    });
  }

  function highlight(ref, needle, greek) {
    reader.querySelectorAll(".hit").forEach(function (n) { n.classList.remove("hit"); });
    var sec = $("s-" + ref);
    if (!sec) return;
    if (greek) {
      sec.querySelectorAll(".sec-grc .w").forEach(function (w) {
        if (stripAccents(w.textContent).indexOf(needle) >= 0) w.classList.add("hit");
      });
    } else {
      sec.querySelectorAll(".sec-eng p").forEach(function (p) {
        if (p.textContent.toLowerCase().indexOf(needle) >= 0) p.classList.add("hit");
      });
    }
  }

  /* --- overlays ---------------------------------------------------------- */
  function closeOverlays() {
    ["settings", "search"].forEach(function (id) { $(id).hidden = true; });
    $("scrim").hidden = true;
    if (mq(DRAWER)) delete document.body.dataset.nav;
    $("navToggle").setAttribute("aria-expanded", "false");
    $("settingsBtn").setAttribute("aria-expanded", "false");
  }
  function openSheet(id) {
    closeOverlays();
    $(id).hidden = false;
    $("scrim").hidden = false;
    if (id === "settings") $("settingsBtn").setAttribute("aria-expanded", "true");
    if (id === "search") setTimeout(function () { $("searchInput").focus(); }, 30);
  }
  function toggleNav() {
    if (mq(DRAWER)) {
      var open = document.body.dataset.nav === "open";
      closeOverlays();
      if (!open) {
        document.body.dataset.nav = "open";
        $("navToggle").setAttribute("aria-expanded", "true");
        $("scrim").hidden = false;
      }
      return;
    }
    S.sidebar = !S.sidebar;
    saveSettings();
    applySettings();
    $("navToggle").setAttribute("aria-expanded", S.sidebar ? "true" : "false");
  }

  /* --- settings wiring --------------------------------------------------- */
  function wireChips(id, prop, after) {
    $(id).querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        S[prop] = b.dataset.v;
        syncChips(id, prop);
        applySettings();
        saveSettings();
        if (after) after();
      });
    });
  }
  function syncChips(id, prop) {
    $(id).querySelectorAll("button").forEach(function (b) {
      b.setAttribute("aria-checked", b.dataset.v === String(S[prop]) ? "true" : "false");
    });
  }
  function wireRange(id, prop, out, fmt) {
    var input = $(id);
    input.addEventListener("input", function () {
      S[prop] = parseFloat(input.value);
      $(out).textContent = fmt(S[prop]);
      applySettings();
      saveSettings();
    });
  }
  function wireToggle(id, prop, after) {
    $(id).addEventListener("change", function () {
      S[prop] = $(id).checked;
      applySettings();
      saveSettings();
      if (after) after();
    });
  }
  function syncAllControls() {
    [["setTheme","theme"],["setAccent","accent"],["setGrcFont","grcFont"],
     ["setGloss","gloss"],["setGlossType","glossType"]].forEach(function (p) {
      syncChips(p[0], p[1]);
    });
    $("setGrcSize").value = S.grcSize; $("outGrcSize").textContent = S.grcSize + "px";
    $("setLead").value = S.lead; $("outLead").textContent = Number(S.lead).toFixed(2);
    $("setMeasure").value = S.measure; $("outMeasure").textContent = S.measure + "rem";
    $("setEngSize").value = S.engSize; $("outEngSize").textContent = S.engSize + "px";
    $("setShowRefs").checked = S.showRefs;
    $("setShowVocab").checked = S.showVocab;
    $("setShowCitations").checked = S.showCitations;
    $("setSwapSides").checked = S.swapSides;
    $("setJustify").checked = S.justify;
  }

  function setMode(mode) {
    if (S.mode === mode) return;
    S.mode = mode;
    saveSettings();
    closePop();
    $("modes").querySelectorAll("button").forEach(function (b) {
      b.setAttribute("aria-selected", b.dataset.mode === mode ? "true" : "false");
    });
    var keep = currentRef;
    render();
    if (keep) {
      var node = $("s-" + keep);
      if (node) node.scrollIntoView({ block: "start" });
    }
  }

  /* --- progress ---------------------------------------------------------- */
  var ticking = false;
  function updateProgress() {
    var d = document.documentElement;
    var max = d.scrollHeight - window.innerHeight;
    var pct = max > 0 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 0;
    $("progress").firstElementChild.style.width = pct + "%";
    ticking = false;
  }

  /* --- boot -------------------------------------------------------------- */
  function wireEvents() {
    $("modes").querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () { setMode(b.dataset.mode); });
    });
    $("navToggle").addEventListener("click", toggleNav);
    $("navClose").addEventListener("click", closeOverlays);
    $("settingsBtn").addEventListener("click", function () { openSheet("settings"); });
    $("settingsClose").addEventListener("click", closeOverlays);
    $("searchBtn").addEventListener("click", function () { openSheet("search"); });
    $("searchClose").addEventListener("click", closeOverlays);
    $("scrim").addEventListener("click", closeOverlays);
    $("popClose").addEventListener("click", closePop);
    $("popMore").addEventListener("click", function () { toggleEntry(); });

    $("resetSettings").addEventListener("click", function () {
      var mode = S.mode;
      S = Object.assign({}, DEFAULTS);
      S.mode = mode;
      applySettings();
      saveSettings();
      syncAllControls();
      render();
    });

    // One delegated listener rather than thousands of per-word handlers.
    reader.addEventListener("click", function (e) {
      var ref = e.target.closest(".sec-ref");
      if (ref) {
        var url = location.origin + location.pathname + "#" + ref.textContent;
        var done = function () {
          ref.classList.add("copied");
          setTimeout(function () { ref.classList.remove("copied"); }, 900);
        };
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, done);
        else done();
        return;
      }
      var w = e.target.closest(".w");
      if (w) { openPop(w); return; }
    });

    // Clicking away closes the lookup; clicking inside it does not.
    document.addEventListener("pointerdown", function (e) {
      if ($("pop").hidden) return;
      if (e.target.closest("#pop") || e.target.closest(".w")) return;
      closePop();
    });

    window.addEventListener("hashchange", function () {
      var ref = (location.hash.match(/#(\d+[a-e])/) || [])[1];
      if (ref && chunkByRef[ref] && ref !== currentRef) setCurrent(ref, true);
    });

    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(updateProgress); }
    }, { passive: true });

    window.addEventListener("resize", function () {
      applySettings();
      if (!$("pop").hidden) positionPop();
    });

    var timer = null;
    $("searchInput").addEventListener("input", function () {
      clearTimeout(timer);
      var v = this.value;
      timer = setTimeout(function () { runSearch(v); }, 140);
    });

    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = (e.target.tagName || "").toLowerCase();
      var typing = tag === "input" || tag === "textarea";
      if (e.key === "Escape") {
        if (!$("pop").hidden) closePop();
        closeOverlays();
        return;
      }
      if (typing) return;
      if (e.key === "/") { e.preventDefault(); openSheet("search"); return; }
      if (e.key === ",") { e.preventDefault(); openSheet("settings"); return; }
      if (e.key === "s") { e.preventDefault(); toggleNav(); return; }
      if (e.key === "1") { setMode("parallel"); return; }
      if (e.key === "2") { setMode("interlinear"); return; }
      if (e.key === "3") { setMode("greek"); return; }
      if (e.key === "n" || e.key === "p") {
        var refs = text.chunks.map(function (c) { return c.ref; });
        var i = refs.indexOf(currentRef);
        if (i < 0) i = 0;
        setCurrent(refs[e.key === "n" ? Math.min(i + 1, refs.length - 1) : Math.max(i - 1, 0)], true);
      }
    });

    wireChips("setTheme", "theme");
    wireChips("setAccent", "accent");
    wireChips("setGrcFont", "grcFont");
    wireChips("setGloss", "gloss");
    wireChips("setGlossType", "glossType", render);
    wireRange("setGrcSize", "grcSize", "outGrcSize", function (v) { return v + "px"; });
    wireRange("setLead", "lead", "outLead", function (v) { return Number(v).toFixed(2); });
    wireRange("setMeasure", "measure", "outMeasure", function (v) { return v + "rem"; });
    wireRange("setEngSize", "engSize", "outEngSize", function (v) { return v + "px"; });
    wireToggle("setShowRefs", "showRefs");
    wireToggle("setShowVocab", "showVocab", render);
    wireToggle("setShowCitations", "showCitations");
    wireToggle("setSwapSides", "swapSides");
    wireToggle("setJustify", "justify");
  }

  function computeFrequencies() {
    text.chunks.forEach(function (c) {
      c.grc.forEach(function (b) {
        WORD_RE.lastIndex = 0;
        var m;
        while ((m = WORD_RE.exec(b.s)) !== null) {
          var lemma = bestLemma(normaliseKey(m[0]));
          if (!lemma) continue;
          var k = lemmaKey(lemma);
          lemmaFreq[k] = (lemmaFreq[k] || 0) + 1;
        }
      });
    });
    // The 45 commonest words are not what a student needs on a vocabulary list.
    Object.keys(lemmaFreq)
      .sort(function (a, b) { return lemmaFreq[b] - lemmaFreq[a]; })
      .slice(0, 45)
      .forEach(function (k) { commonLemmas[k] = 1; });
  }

  function fail(msg) {
    reader.textContent = "";
    var box = el("div", "loading");
    box.append(el("div", "loading-mark", "❖"));
    box.append(el("p", null, msg));
    reader.append(box);
  }

  function boot() {
    loadSettings();
    var m = (location.hash.match(/mode=(parallel|interlinear|greek)/) || [])[1];
    if (m) S.mode = m;
    applySettings();
    $("modes").querySelectorAll("button").forEach(function (b) {
      b.setAttribute("aria-selected", b.dataset.mode === S.mode ? "true" : "false");
    });

    Promise.all([
      fetch("data/works/" + WORK + "/text.json").then(function (r) { return r.json(); }),
      fetch("data/works/" + WORK + "/morph.json").then(function (r) { return r.json(); }),
      fetch("data/lex/manifest.json").then(function (r) { return r.json(); })
    ]).then(function (res) {
      text = res[0]; morph = res[1]; lex = res[2];
      (lex.suppress || []).forEach(function (k) { suppressed[k] = 1; });
      text.chunks.forEach(function (c) { chunkByRef[c.ref] = c; });
      computeCorpusFreq();
      computeFrequencies();
      syncAllControls();
      buildNav();
      render();
      wireEvents();
      updateProgress();

      var want = (location.hash.match(/#(\d+[a-e])/) || [])[1];
      if (!want) { try { want = localStorage.getItem(STORE + "pos"); } catch (e) {} }
      if (want && chunkByRef[want]) {
        setCurrent(want, false);
        var node = $("s-" + want);
        if (node) node.scrollIntoView({ block: "start" });
      } else {
        setCurrent(text.chunks[0].ref, false);
      }
      // Web fonts land after first paint and shift the text, so settle again.
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () {
          if (currentRef) {
            var n = $("s-" + currentRef);
            if (n) n.scrollIntoView({ block: "start" });
          }
          updateProgress();
        });
      }
    }).catch(function (err) {
      fail(location.protocol === "file:"
        ? "Open this through a web server rather than as a local file — browsers block data requests on file:// URLs."
        : "The text could not be loaded. " + err);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
