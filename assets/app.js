/* ==========================================================================
   Apollo's Reader
   Plain ES modules-free JavaScript: no build step, no framework, so the site is
   just files that GitHub Pages can serve.
   ========================================================================== */
(function () {
  "use strict";

  var WORK = "plato-apology";
  var STORE = "apollos-reader:";

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

  // Dictionary keys are normalised the same way the build does it: Morpheus
  // returns homonym numbers and capitals (le/gw1, *)aqhnai=os) that the
  // manifest does not carry.
  function lemmaKey(lemma) {
    return lemma.normalize("NFC").replace(/\d+$/, "").replace(/-/g, "").toLowerCase();
  }
  function lemmaLabel(lemma) {
    return lemma.normalize("NFC").replace(/\d+$/, "");
  }

  /* --- parse abbreviations ----------------------------------------------- */
  var ABBR = {
    present: "pres", imperfect: "impf", future: "fut", aorist: "aor",
    perfect: "perf", pluperfect: "plpf", futureperfect: "fut perf",
    active: "act", middle: "mid", passive: "pass", mediopassive: "mid/pass",
    indicative: "ind", subjunctive: "subj", optative: "opt",
    imperative: "impv", infinitive: "inf", participle: "ptcp", gerundive: "gerundive",
    "1st": "1st", "2nd": "2nd", "3rd": "3rd",
    singular: "sg", plural: "pl", dual: "du",
    nominative: "nom", genitive: "gen", dative: "dat",
    accusative: "acc", vocative: "voc",
    masculine: "masc", feminine: "fem", neuter: "neut",
    comparative: "compar", superlative: "superl",
    adjective: "adj", adverb: "adv", pronoun: "pron", preposition: "prep",
    conjunction: "conj", particle: "particle", article: "art",
    numeral: "num", interjection: "interj", exclamation: "excl",
    noun: "noun", verb: "verb"
  };
  function abbreviate(parse) {
    if (!parse) return "";
    return parse.split(/\s+/).map(function (w) { return ABBR[w] || w; }).join(" ");
  }

  /* --- tiny DOM helpers -------------------------------------------------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function $(id) { return document.getElementById(id); }
  function txt(s) { return document.createTextNode(s); }

  /* --- settings ---------------------------------------------------------- */
  var DEFAULTS = {
    mode: "parallel", theme: "obsidian", accent: "terracotta",
    grcFont: "cardo", grcSize: 21, lead: 1.95, measure: 38, engSize: 17,
    gloss: "always", glossType: "gloss",
    showRefs: true, showVocab: false, showCitations: true,
    swapSides: false, justify: false
  };
  var S = Object.assign({}, DEFAULTS);

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORE + "settings");
      if (raw) Object.assign(S, JSON.parse(raw));
    } catch (e) { /* private mode, or storage blocked */ }
    var m = (location.hash.match(/mode=(parallel|interlinear|greek)/) || [])[1];
    if (m) S.mode = m;
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
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content",
        getComputedStyle(document.body).backgroundColor || "#14120f");
    }
  }

  /* --- state ------------------------------------------------------------- */
  var text = null, morph = null, lex = null;
  var reader = $("reader");
  var chunkByRef = {};
  var lemmaFreq = {};        // lemma id -> corpus frequency, for the stoplist
  var commonLemmas = {};     // lemma ids too frequent to list as vocabulary
  var entryCache = {};
  var currentRef = null;
  var openWord = null;

  var suppressed = {};       // headwords Morpheus offers that are wrong here

  function analysesFor(key) {
    var rows = morph.forms[key];
    if (!rows) return null;
    var out = rows.map(function (r) {
      return { lemma: morph.lemmas[r[0]], pos: r[1], parse: r[2] };
    });
    return rankAnalyses(out, key);
  }

  // Morpheus often returns several headwords for one form, and the first is not
  // always the plausible one: doko= yields doko/s "beam" beside doke/w "seem".
  // Preferring a headword that the lexicon can actually gloss, and demoting the
  // ones listed as wrong for this text, picks the right one nearly every time.
  // An uninflected word is nearly always itself rather than a rare inflection of
  // something else: hO/TI is the conjunction, not neuter hO/STIS, and O= is the
  // interjection, not the subjunctive of EIMI. So a headword identical to the
  // form on the page outranks one the lexicon merely happens to gloss.
  function scoreAnalysis(a, key) {
    var k = lemmaKey(a.lemma);
    if (suppressed[k]) return 0;
    var score = glossFor(a.lemma) ? 2 : 1;
    if (key && stripAccents(k) === stripAccents(key)) score += 3;
    return score;
  }
  function rankAnalyses(an, key) {
    return an.slice().sort(function (x, y) {
      return scoreAnalysis(y, key) - scoreAnalysis(x, key);
    });
  }

  function lexRow(lemma) { return lex.lex[lemmaKey(lemma)] || null; }
  function glossFor(lemma) {
    var hit = lexRow(lemma);
    return hit ? hit[1] : "";
  }
  function isEditorial(lemma) {
    var hit = lexRow(lemma);
    return !!hit && hit[2] === 1;
  }
  function noteFor(lemma) {
    return (lex.note || {})[lemmaKey(lemma)] || "";
  }
  function hasEntry(lemma) {
    var hit = lexRow(lemma);
    return !!hit && hit[0] >= 0;
  }

  /* --- rendering: words -------------------------------------------------- */
  function wordSpan(surface) {
    var key = normaliseKey(surface);
    var s = el("span", "w", surface);
    s.dataset.k = key;
    if (!morph.forms[key]) s.className = "w unknown";
    return s;
  }

  function glossText(key) {
    var an = analysesFor(key);
    if (!an) return "";
    var parts = [];
    if (S.glossType === "gloss" || S.glossType === "both") {
      for (var i = 0; i < an.length; i++) {
        var g = glossFor(an[i].lemma);
        if (g) { parts.push(g.length > 28 ? g.slice(0, 27) + "…" : g); break; }
      }
    }
    return parts.join("");
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

      // Keep punctuation that hugs the word inside the same column.
      var limit = (i + 1 < toks.length) ? toks[i + 1].index : str.length;
      var tight = end;
      while (tight < limit && !/\s/.test(str[tight])) tight++;

      var unit = el("span", "iw");
      unit.append(wordSpan(t[0]));
      if (tight > end) unit.append(txt(str.slice(end, tight)));
      var key = normaliseKey(t[0]);
      var gl = el("span", "gl");
      if (S.glossType === "parse" || S.glossType === "both") {
        var an = analysesFor(key);
        if (an) {
          if (S.glossType === "both") {
            var g = glossText(key);
            if (g) gl.append(txt(g));
          }
          var pr = el("span", "pr", abbreviate(an[0].parse) || an[0].pos);
          gl.append(pr);
        }
      } else {
        gl.textContent = glossText(key);
      }
      unit.append(gl);
      parent.append(unit);
      pos = tight;
    }
    if (pos < str.length) parent.append(txt(str.slice(pos)));
  }

  function renderBlocks(host, blocks, lang, interlinear) {
    blocks.forEach(function (b) {
      var p = el(b.t === "verse" ? "p" : "p", b.t === "verse" ? "verse" : null);
      if (lang === "grc") renderRun(p, b.s, interlinear);
      else p.append(txt(b.s));
      host.append(p);
    });
  }

  /* --- rendering: vocabulary -------------------------------------------- */
  function bestLemma(key) {
    var an = analysesFor(key);
    return an ? an[0].lemma : null;
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
    var sum = el("summary", null, "Vocabulary · " + items.length);
    d.append(sum);
    var ul = el("ul", "vocab-list");
    items.forEach(function (it) {
      var li = el("li");
      li.append(el("b", "gk", it[0]), txt(" — " + it[1]));
      ul.append(li);
    });
    d.append(ul);
    return d;
  }

  /* --- rendering: the whole work ---------------------------------------- */
  function render() {
    var interlinear = S.mode === "interlinear";
    reader.className = "reader mode-" + S.mode;
    reader.textContent = "";

    var head = el("div", "work-head");
    head.append(el("div", "wh-grc gk", text.titleGrc));
    head.append(el("div", "wh-eng", text.author + ", " + text.title));
    var meta = el("div", "wh-meta");
    meta.append(txt("Greek: Burnet 1905 · English: Fowler 1914"));
    head.append(meta);
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

      var ref = el("div", "sec-ref", c.ref);
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
        var n = el("p", "eng-note");
        n.style.cssText = "font-size:.85em;color:var(--text-faint);margin-top:.6em";
        n.append(txt(c.notes.join(" · ")));
        et.append(n);
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

  /* --- section observation ---------------------------------------------- */
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
      if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* --- section navigator ------------------------------------------------- */
  function buildNav() {
    var host = $("sectionNav");
    host.textContent = "";
    var groups = [], lastSpeech = null;
    text.chunks.forEach(function (c) {
      if (c.speech !== lastSpeech) {
        lastSpeech = c.speech;
        groups.push({ speech: c.speech, refs: [] });
      }
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
          if (window.matchMedia("(max-width:1100px)").matches) closeAll();
        });
        grid.append(b);
      });
      wrap.append(grid);
      host.append(wrap);
    });
  }

  /* --- word panel -------------------------------------------------------- */
  function linkRow(surface, lemma) {
    var foot = $("wpFoot");
    foot.textContent = "";
    function add(label, href) {
      var a = el("a", null, label);
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      foot.append(a);
    }
    if (lemma) add("Logeion", "https://logeion.uchicago.edu/" + encodeURIComponent(lemma));
    add("Perseus parse", "https://www.perseus.tufts.edu/hopper/morph?l=" +
      encodeURIComponent(surface) + "&la=greek");
    if (lemma) add("Wiktionary", "https://en.wiktionary.org/wiki/" +
      encodeURIComponent(lemma) + "#Ancient_Greek");
  }

  function showEntry(lemma) {
    var host = $("wpBody").querySelector(".lex-block");
    if (!host) return;
    var body = host.querySelector(".lex-target");
    var hit = lexRow(lemma);
    if (!hit || hit[0] < 0) {
      body.textContent = "";
      body.append(el("p", "wp-empty",
        "Liddell-Scott-Jones has no separate entry under this headword — it is " +
        "usually a proper name, or a word the lexicon files under another. " +
        "The links below will look it up in full."));
      return;
    }
    var id = hit[0];
    if (entryCache[id]) { body.innerHTML = entryCache[id]; return; }
    body.textContent = "";
    body.append(el("p", "wp-empty", "Fetching the entry…"));
    fetch("data/lex/e/" + id + ".json")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        entryCache[id] = d.html;
        body.innerHTML = d.html;
      })
      .catch(function () {
        body.textContent = "";
        body.append(el("p", "wp-empty", "The entry could not be loaded."));
      });
  }

  function openPanel(span) {
    var surface = span.textContent;
    var key = span.dataset.k;
    var sec = span.closest(".sec");

    if (openWord) openWord.classList.remove("is-open");
    if (openWord) openWord.parentElement.classList.remove("is-open");
    openWord = span;
    span.classList.add("is-open");
    if (span.parentElement.classList.contains("iw")) {
      span.parentElement.classList.add("is-open");
    }

    $("wpForm").textContent = surface;
    $("wpWhere").textContent = sec ? "Apology " + sec.dataset.ref : "";

    var body = $("wpBody");
    body.textContent = "";
    var an = analysesFor(key);

    if (!an) {
      body.append(el("p", "wp-empty",
        "This form is not in the parsed index — it is usually a proper name " +
        "the parser does not carry. Try the lookups below."));
      linkRow(surface, null);
      showPanel();
      return;
    }

    // One row per analysis, so ambiguity is visible rather than hidden.
    an.forEach(function (a) {
      var row = el("div", "an");
      row.append(el("span", "an-lemma gk", lemmaLabel(a.lemma)));
      if (a.pos) row.append(el("span", "an-pos", a.pos));
      if (suppressed[lemmaKey(a.lemma)]) {
        row.append(el("span", "an-flag", "unlikely here"));
      }
      if (a.parse) row.append(el("div", "an-parse", abbreviate(a.parse)));
      var g = glossFor(a.lemma);
      if (g) {
        var gl = el("div", "an-gloss", g);
        if (isEditorial(a.lemma)) gl.append(el("span", "an-ed", "editorial"));
        row.append(gl);
      }
      body.append(row);
    });

    var lemmas = [];
    an.forEach(function (a) { if (lemmas.indexOf(a.lemma) < 0) lemmas.push(a.lemma); });

    // A note about a person or place named in the dialogue, where there is one.
    for (var ni = 0; ni < lemmas.length; ni++) {
      var note = noteFor(lemmas[ni]);
      if (note) {
        var nb = el("div", "an-note");
        nb.append(el("span", "an-note-tag", "Note"));
        nb.append(txt(note));
        body.append(nb);
        break;
      }
    }

    var block = el("div", "lex-block");
    var h = el("h4", null, "Liddell · Scott · Jones");
    block.append(h);
    // Headwords the lexicon can actually show come first.
    lemmas.sort(function (x, y) { return (hasEntry(y) ? 1 : 0) - (hasEntry(x) ? 1 : 0); });

    if (lemmas.length > 1) {
      var chips = el("div", "chips");
      chips.style.marginBottom = "10px";
      lemmas.forEach(function (l, i) {
        var b = el("button", "gk", lemmaLabel(l));
        b.setAttribute("aria-checked", i === 0 ? "true" : "false");
        b.addEventListener("click", function () {
          chips.querySelectorAll("button").forEach(function (x) {
            x.setAttribute("aria-checked", "false");
          });
          b.setAttribute("aria-checked", "true");
          showEntry(l);
          linkRow(surface, l);
        });
        chips.append(b);
      });
      block.append(chips);
    }
    block.append(el("div", "lex-target"));
    body.append(block);

    showEntry(lemmas[0]);
    linkRow(surface, lemmas[0]);
    showPanel();
  }

  function showPanel() {
    $("wordPanel").hidden = false;
    document.body.dataset.panel = "open";
  }
  function closePanel() {
    $("wordPanel").hidden = true;
    delete document.body.dataset.panel;
    if (openWord) {
      openWord.classList.remove("is-open");
      if (openWord.parentElement) openWord.parentElement.classList.remove("is-open");
      openWord = null;
    }
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
    var hits = 0;

    for (var i = 0; i < searchIndex.length && hits < 60; i++) {
      var row = searchIndex[i];
      var hay = greek ? row.gs : row.es;
      var at = hay.indexOf(needle);
      if (at < 0) continue;
      hits++;
      var source = greek ? row.g : row.e;
      var from = Math.max(0, at - 42);
      var snippet = (from > 0 ? "…" : "") +
        source.slice(from, at + needle.length + 58).trim() + "…";
      var b = el("button");
      b.append(el("div", "sr-ref", "Apology " + row.ref));
      b.append(el("div", "sr-txt" + (greek ? " gk" : ""), snippet));
      b.dataset.ref = row.ref;
      b.addEventListener("click", function () {
        var ref = this.dataset.ref;
        closeAll();
        setCurrent(ref, true);
        highlight(ref, needle, greek);
      });
      host.append(b);
    }
    if (!hits) host.append(el("p", "sr-none", "Nothing found for “" + q + "”."));
  }

  function highlight(ref, needle, greek) {
    reader.querySelectorAll(".hit").forEach(function (n) { n.classList.remove("hit"); });
    var sec = $("s-" + ref);
    if (!sec) return;
    var sel = greek ? ".sec-grc .w" : ".sec-eng";
    if (greek) {
      sec.querySelectorAll(sel).forEach(function (w) {
        if (stripAccents(w.textContent).indexOf(needle) >= 0) w.classList.add("hit");
      });
    } else {
      sec.querySelectorAll(".sec-eng p").forEach(function (p) {
        if (p.textContent.toLowerCase().indexOf(needle) >= 0) p.classList.add("hit");
      });
    }
  }

  /* --- overlays ---------------------------------------------------------- */
  function closeAll() {
    ["settings", "search"].forEach(function (id) { $(id).hidden = true; });
    $("scrim").hidden = true;
    delete document.body.dataset.nav;
    $("navToggle").setAttribute("aria-expanded", "false");
    $("settingsBtn").setAttribute("aria-expanded", "false");
  }
  function openSheet(id) {
    closeAll();
    $(id).hidden = false;
    $("scrim").hidden = false;
    if (id === "search") setTimeout(function () { $("searchInput").focus(); }, 30);
  }
  function toggleNav() {
    var open = document.body.dataset.nav === "open";
    if (open) { closeAll(); return; }
    closeAll();
    document.body.dataset.nav = "open";
    $("navToggle").setAttribute("aria-expanded", "true");
    if (window.matchMedia("(max-width:1100px)").matches) $("scrim").hidden = false;
  }

  /* --- settings wiring --------------------------------------------------- */
  function wireChips(id, prop, after) {
    var host = $(id);
    host.querySelectorAll("button").forEach(function (b) {
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
  function wireRange(id, prop, out, fmt, after) {
    var input = $(id);
    input.value = S[prop];
    $(out).textContent = fmt(S[prop]);
    input.addEventListener("input", function () {
      S[prop] = parseFloat(input.value);
      $(out).textContent = fmt(S[prop]);
      applySettings();
      saveSettings();
      if (after) after();
    });
  }
  function wireToggle(id, prop, after) {
    var input = $(id);
    input.checked = !!S[prop];
    input.addEventListener("change", function () {
      S[prop] = input.checked;
      applySettings();
      saveSettings();
      if (after) after();
    });
  }

  function syncAllControls() {
    ["setTheme:theme", "setAccent:accent", "setGrcFont:grcFont",
     "setGloss:gloss", "setGlossType:glossType"].forEach(function (pair) {
      var p = pair.split(":");
      syncChips(p[0], p[1]);
    });
    $("setGrcSize").value = S.grcSize; $("outGrcSize").textContent = S.grcSize + "px";
    $("setLead").value = S.lead; $("outLead").textContent = S.lead.toFixed(2);
    $("setMeasure").value = S.measure; $("outMeasure").textContent = S.measure + "rem";
    $("setEngSize").value = S.engSize; $("outEngSize").textContent = S.engSize + "px";
    $("setShowRefs").checked = S.showRefs;
    $("setShowVocab").checked = S.showVocab;
    $("setShowCitations").checked = S.showCitations;
    $("setSwapSides").checked = S.swapSides;
    $("setJustify").checked = S.justify;
  }

  function setMode(mode) {
    S.mode = mode;
    saveSettings();
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

  /* --- boot -------------------------------------------------------------- */
  function wireEvents() {
    $("modes").querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () { setMode(b.dataset.mode); });
    });
    $("navToggle").addEventListener("click", toggleNav);
    $("navClose").addEventListener("click", closeAll);
    $("settingsBtn").addEventListener("click", function () { openSheet("settings"); });
    $("settingsClose").addEventListener("click", closeAll);
    $("searchBtn").addEventListener("click", function () { openSheet("search"); });
    $("searchClose").addEventListener("click", closeAll);
    $("scrim").addEventListener("click", closeAll);
    $("wpClose").addEventListener("click", closePanel);

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
      var w = e.target.closest(".w");
      if (w) { openPanel(w); return; }
    });

    // Shared links and the back button: setCurrent uses replaceState, which
    // does not fire this, so only real navigation reaches here.
    window.addEventListener("hashchange", function () {
      var ref = (location.hash.match(/#(\d+[a-e])/) || [])[1];
      if (ref && chunkByRef[ref] && ref !== currentRef) setCurrent(ref, true);
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
        if (!$("wordPanel").hidden) closePanel();
        closeAll();
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
        var j = e.key === "n" ? Math.min(i + 1, refs.length - 1) : Math.max(i - 1, 0);
        setCurrent(refs[j], true);
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
      computeFrequencies();
      syncAllControls();
      buildNav();
      render();
      wireEvents();

      var want = (location.hash.match(/#(\d+[a-e])/) || [])[1];
      if (!want) { try { want = localStorage.getItem(STORE + "pos"); } catch (e) {} }
      if (want && chunkByRef[want]) {
        setCurrent(want, false);
        var node = $("s-" + want);
        if (node) node.scrollIntoView({ block: "start" });
      } else {
        setCurrent(text.chunks[0].ref, false);
      }
    }).catch(function (err) {
      fail(location.protocol === "file:"
        ? "Open this through a web server rather than as a local file — browsers block data requests on file:// URLs."
        : "The text could not be loaded. " + err);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
