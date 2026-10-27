/* Pages: the document model. Pure functions only (no DOM, no storage), so the self-test can prove them.
 *
 * Page   {id, parent, pos, title, icon, cover, font, wide, blocks[], created, updated, trashed, trashRoot, fav}
 * Block  {id, type, indent, dir, ...type props}   blocks are a flat ordered list; children of a block are the
 *        following blocks with a deeper indent (that is how toggles and nested lists work).
 * Spans  rich text: [{t: "text", b, i, u, s, c, h: true, a: url}]; a page mention is {t: "@", p: pageId}.
 * Nothing from the user is ever turned into HTML here except through esc().
 */
(function () {
  "use strict";

  var ID_RE = /^[a-z0-9]{1,24}$/;
  var FLAGS = ["b", "i", "u", "s", "c", "h"];
  var TEXT_TYPES = { p: 1, h1: 1, h2: 1, h3: 1, ul: 1, ol: 1, todo: 1, toggle: 1, quote: 1, callout: 1 };
  var ALL_TYPES = { p: 1, h1: 1, h2: 1, h3: 1, ul: 1, ol: 1, todo: 1, toggle: 1, quote: 1, callout: 1, divider: 1, code: 1, table: 1, image: 1, page: 1 };
  var CALLOUT_COLORS = ["default", "gray", "blue", "green", "yellow", "orange", "red", "purple"];
  var FONTS = ["sans", "serif", "mono"];
  var IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp" };
  var COVERS = [
    "linear-gradient(135deg,#ff9a8b,#ff6a88 55%,#ff99ac)", "linear-gradient(135deg,#a18cd1,#fbc2eb)", "linear-gradient(135deg,#84fab0,#8fd3f4)",
    "linear-gradient(135deg,#3dd6d0,#1f6f8b)", "linear-gradient(135deg,#f6d365,#fda085)", "linear-gradient(135deg,#667eea,#764ba2)",
    "linear-gradient(135deg,#0f2027,#203a43,#2c5364)", "linear-gradient(135deg,#fddb92,#d1fdff)", "linear-gradient(120deg,#e0c3fc,#8ec5fc)",
    "linear-gradient(135deg,#43e97b,#38f9d7)", "linear-gradient(135deg,#fa709a,#fee140)", "linear-gradient(160deg,#30cfd0,#330867)",
    "#e8d5b7", "#c9e4de", "#2d3a4b", "#f4b6c2"
  ];
  var MAX_INDENT = 8, COVER_COUNT = COVERS.length;

  function uid() {
    var a = new Uint8Array(9), s = "";
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += (a[i] % 36).toString(36);
    return s + Date.now().toString(36).slice(-3);
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }
  function num(v, lo, hi, def) { return typeof v === "number" && isFinite(v) && v >= lo && v <= hi ? v : def; }

  // ---------- URLs: only http(s), mailto and tel. Bare domains get an https scheme. Everything else is refused. ----------
  function safeUrl(raw) {
    if (typeof raw !== "string") return null;
    var u = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
    if (!u || u.length > 2048) return null;
    var m = /^([a-z][a-z0-9+.\-]*):/i.exec(u);
    if (m) {
      var sc = m[1].toLowerCase();
      if (sc === "http" || sc === "https") return /^https?:\/\/[^\s\/?#]+/i.test(u) ? u.replace(/ /g, "%20") : null;
      if (sc === "mailto" || sc === "tel") return u.replace(/ /g, "%20");
      // "localhost:3000" style host:port without a scheme
      if (!/^[a-z0-9.-]+:\d+(\/|$)/i.test(u)) return null;
    }
    if (/^[\w.-]+@[\w-]+\.[\w.-]+$/.test(u)) return "mailto:" + u;
    if (/^(www\.)?[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+(:\d+)?([\/?#]\S*)?$/u.test(u)) return "https://" + u;
    return null;
  }

  // ---------- spans ----------
  function sameMarks(a, b) {
    for (var k = 0; k < FLAGS.length; k++) if (!!a[FLAGS[k]] !== !!b[FLAGS[k]]) return false;
    return (a.a || "") === (b.a || "") && !a.p && !b.p;
  }
  function copyMarks(s, t) {
    var o = { t: t };
    FLAGS.forEach(function (f) { if (s[f]) o[f] = true; });
    if (s.a) o.a = s.a;
    if (s.p) o.p = s.p;
    return o;
  }
  function norm(spans) {
    var out = [];
    (spans || []).forEach(function (s) {
      if (!s || (!s.t && !s.p)) return;
      var last = out[out.length - 1];
      if (last && !s.p && sameMarks(last, s)) last.t += s.t;
      else out.push(copyMarks(s, s.p ? "@" : s.t));
    });
    return out;
  }
  function plain(spans) { return (spans || []).map(function (s) { return s.t; }).join(""); }
  function len(spans) { return plain(spans).length; }
  function slice(spans, a, b) {
    var out = [], pos = 0;
    if (b == null) b = Infinity;
    (spans || []).forEach(function (s) {
      var L = s.t.length, s0 = pos, s1 = pos + L;
      pos = s1;
      if (s1 <= a || s0 >= b) return;
      if (s.p) { if (s0 >= a && s1 <= b) out.push(copyMarks(s, "@")); return; }
      out.push(copyMarks(s, s.t.slice(Math.max(0, a - s0), Math.min(L, b - s0))));
    });
    return norm(out);
  }
  function concat(x, y) { return norm((x || []).concat(y || [])); }
  function deleteRange(spans, a, b) { return concat(slice(spans, 0, a), slice(spans, b)); }
  function insertSpans(spans, at, ins) { return norm(slice(spans, 0, at).concat(ins, slice(spans, at))); }
  function insertText(spans, at, text) {
    var before = slice(spans, Math.max(0, at - 1), at)[0], marks = { t: text };
    if (before && !before.p) FLAGS.forEach(function (f) { if (before[f]) marks[f] = true; });
    return insertSpans(spans, at, [marks]);
  }
  function hasMark(spans, a, b, mark) {
    var part = slice(spans, a, b);
    return part.length > 0 && part.every(function (s) { return s.p || (mark === "a" ? !!s.a : !!s[mark]); });
  }
  function setMark(spans, a, b, mark, value) {
    if (a >= b) return norm(spans);
    var mid = slice(spans, a, b).map(function (s) {
      if (s.p) return s;
      var o = copyMarks(s, s.t);
      if (value) o[mark] = value; else delete o[mark];
      if (mark === "c" && value) delete o.a;
      return o;
    });
    return norm(slice(spans, 0, a).concat(mid, slice(spans, b)));
  }
  function toggleMark(spans, a, b, mark) { return setMark(spans, a, b, mark, hasMark(spans, a, b, mark) ? null : true); }
  function cleanSpans(arr) {
    if (!Array.isArray(arr)) return typeof arr === "string" ? norm([{ t: arr.slice(0, 200000) }]) : [];
    var out = [], total = 0;
    for (var k = 0; k < arr.length && k < 5000 && total < 200000; k++) {
      var s = arr[k];
      if (!s || typeof s !== "object") continue;
      if (typeof s.p === "string") { if (ID_RE.test(s.p)) out.push({ t: "@", p: s.p }); total++; continue; }
      var t = str(s.t, 200000 - total);
      if (!t) continue;
      var o = { t: t };
      FLAGS.forEach(function (f) { if (s[f] === true) o[f] = true; });
      var url = s.a != null ? safeUrl(String(s.a)) : null;
      if (url) o.a = url;
      out.push(o); total += t.length;
    }
    return norm(out);
  }

  // ---------- blocks ----------
  function defaults(type) {
    switch (type) {
      case "todo": return { checked: false };
      case "toggle": return { open: true };
      case "callout": return { icon: "💡", color: "default" };
      case "code": return { code: "", lang: "" };
      case "table": return { rows: [["", ""], ["", ""]], header: true };
      case "image": return { blob: "", caption: "", width: 100 };
      case "page": return { page: "" };
      default: return {};
    }
  }
  function newBlock(type, props) {
    type = ALL_TYPES[type] ? type : "p";
    var b = { id: uid(), type: type, indent: 0, dir: "" };
    if (TEXT_TYPES[type]) b.text = [];
    var d = defaults(type), k;
    for (k in d) b[k] = d[k];
    if (props) for (k in props) b[k] = props[k];
    return b;
  }
  function cleanBlock(x) {
    x = x && typeof x === "object" ? x : {};
    var type = typeof x.type === "string" && ALL_TYPES[x.type] ? x.type : "p";
    var b = { id: typeof x.id === "string" && ID_RE.test(x.id) ? x.id : uid(), type: type, indent: Math.floor(num(x.indent, 0, MAX_INDENT, 0)), dir: x.dir === "rtl" || x.dir === "ltr" ? x.dir : "" };
    if (TEXT_TYPES[type]) b.text = cleanSpans(x.text);
    if (type === "todo") b.checked = x.checked === true;
    if (type === "toggle") b.open = x.open !== false;
    if (type === "callout") { b.icon = str(x.icon, 16) || "💡"; b.color = CALLOUT_COLORS.indexOf(x.color) >= 0 ? x.color : "default"; }
    if (type === "code") { b.code = str(x.code, 200000); b.lang = typeof x.lang === "string" && /^[\w+#.\- ]{0,24}$/.test(x.lang) ? x.lang : ""; }
    if (type === "table") {
      var rows = Array.isArray(x.rows) ? x.rows.slice(0, 200) : [];
      var cols = Math.min(20, Math.max.apply(null, [1].concat(rows.map(function (r) { return Array.isArray(r) ? r.length : 0; }))));
      b.rows = rows.map(function (r) {
        var out = [];
        for (var c = 0; c < cols; c++) out.push(Array.isArray(r) ? str(r[c], 5000) : "");
        return out;
      });
      if (!b.rows.length) b.rows = [["", ""], ["", ""]];
      b.header = x.header !== false;
    }
    if (type === "image") { b.blob = typeof x.blob === "string" && ID_RE.test(x.blob) ? x.blob : ""; b.caption = str(x.caption, 1000); b.width = Math.round(num(x.width, 10, 100, 100)); }
    if (type === "page") b.page = typeof x.page === "string" && ID_RE.test(x.page) ? x.page : "";
    return b;
  }
  function blockText(b) {
    if (TEXT_TYPES[b.type]) return plain(b.text);
    if (b.type === "code") return b.code;
    if (b.type === "table") return b.rows.map(function (r) { return r.join(" "); }).join("\n");
    if (b.type === "image") return b.caption;
    return "";
  }

  function subtreeEnd(blocks, i) {
    var j = i + 1;
    while (j < blocks.length && blocks[j].indent > blocks[i].indent) j++;
    return j;
  }
  function fixIndents(blocks) {
    for (var k = 0; k < blocks.length; k++) {
      var max = k === 0 ? 0 : Math.min(MAX_INDENT, blocks[k - 1].indent + 1);
      if (blocks[k].indent > max) blocks[k].indent = max;
      if (blocks[k].indent < 0) blocks[k].indent = 0;
    }
    return blocks;
  }
  function continuation(b) {
    if (b.type === "ul" || b.type === "ol" || b.type === "todo") return newBlock(b.type, { indent: b.indent, dir: b.dir });
    if (b.type === "toggle" && b.open) return newBlock("p", { indent: b.indent + 1, dir: b.dir });
    return newBlock("p", { indent: b.indent, dir: b.dir });
  }
  // Split a text block at offset: the right half becomes a new block right after it. Returns the new index.
  function splitBlock(blocks, i, offset) {
    var b = blocks[i], nb = continuation(b);
    if (TEXT_TYPES[b.type]) {
      var L = len(b.text);
      offset = Math.max(0, Math.min(L, offset));
      nb.text = slice(b.text, offset);
      b.text = slice(b.text, 0, offset);
      // Enter at the very start of a heading keeps the heading and pushes an empty line above it
      if (offset === 0 && L > 0 && b.type !== "p") {
        var top = newBlock("p", { indent: b.indent, dir: b.dir });
        if (b.type === "ul" || b.type === "ol" || b.type === "todo") top = newBlock(b.type, { indent: b.indent, dir: b.dir });
        b.text = nb.text; nb = b; blocks.splice(i, 0, top);
        return i + 1;
      }
    }
    blocks.splice(i + 1, 0, nb);
    return i + 1;
  }
  // Backspace at the start of block i: merge into the previous text block. Returns {index, offset} for the caret.
  function mergeUp(blocks, i) {
    if (i <= 0) return null;
    var cur = blocks[i], prev = blocks[i - 1];
    if (prev.type === "divider" || prev.type === "image" || prev.type === "page") {
      blocks.splice(i - 1, 1);
      return { index: i - 1, offset: 0 };
    }
    if (!TEXT_TYPES[prev.type]) return { index: i - 1, offset: -1, noMerge: true };
    var off = len(prev.text);
    prev.text = concat(prev.text, cur.text || []);
    blocks.splice(i, 1);
    // children of the removed block keep their place but may be too deep now
    fixIndents(blocks);
    return { index: i - 1, offset: off };
  }
  // Move block i (with its children) so it starts at index `to` (an index in the array before the move).
  function moveBlock(blocks, i, to, newIndent) {
    var end = subtreeEnd(blocks, i);
    if (to > i && to <= end) to = i; // dropping inside itself = no move
    var seg = blocks.splice(i, end - i);
    if (to > i) to -= seg.length;
    var delta = (newIndent == null ? seg[0].indent : newIndent) - seg[0].indent;
    seg.forEach(function (b) { b.indent = Math.max(0, Math.min(MAX_INDENT, b.indent + delta)); });
    Array.prototype.splice.apply(blocks, [to, 0].concat(seg));
    fixIndents(blocks);
    return to;
  }
  function indentBlock(blocks, i) {
    if (i <= 0 || blocks[i].indent > blocks[i - 1].indent || blocks[i].indent >= MAX_INDENT) return false;
    var end = subtreeEnd(blocks, i);
    for (var k = i; k < end; k++) blocks[k].indent = Math.min(MAX_INDENT, blocks[k].indent + 1);
    return true;
  }
  function outdentBlock(blocks, i) {
    if (!blocks[i].indent) return false;
    var end = subtreeEnd(blocks, i);
    for (var k = i; k < end; k++) blocks[k].indent--;
    return true;
  }
  function moveUp(blocks, i) {
    if (i <= 0) return -1;
    var t = i - 1, ind = blocks[i].indent;
    while (t > 0 && blocks[t].indent > ind) t--;
    return moveBlock(blocks, i, t, ind);
  }
  function moveDown(blocks, i) {
    var end = subtreeEnd(blocks, i);
    if (end >= blocks.length) return -1;
    var nextEnd = subtreeEnd(blocks, end);
    return moveBlock(blocks, i, nextEnd, blocks[i].indent);
  }
  function convert(b, type) {
    if (!ALL_TYPES[type] || b.type === type) return b;
    var text = TEXT_TYPES[b.type] ? b.text : b.type === "code" ? norm([{ t: b.code }]) : b.type === "image" ? norm([{ t: b.caption }]) : [];
    var nb = newBlock(type, { id: b.id, indent: b.indent, dir: b.dir });
    if (TEXT_TYPES[type]) nb.text = text;
    if (type === "code") nb.code = plain(text);
    if (type === "table") nb.rows = [[plain(text), ""], ["", ""]];
    if (type === "callout" && b.type === "callout") { nb.icon = b.icon; nb.color = b.color; }
    return nb;
  }
  // Which blocks are hidden inside a closed toggle, and the list numbers.
  function layout(blocks) {
    var hidden = [], nums = [], counters = [], closed = Infinity;
    blocks.forEach(function (b, k) {
      var hide = b.indent > closed;
      if (!hide) closed = b.type === "toggle" && !b.open ? b.indent : Infinity;
      hidden[k] = hide;
      counters.length = b.indent + 1;
      if (b.type === "ol") nums[k] = counters[b.indent] = (counters[b.indent] || 0) + 1;
      else counters[b.indent] = 0;
    });
    return { hidden: hidden, nums: nums };
  }
  function olLabel(n, indent) {
    var lvl = indent % 3;
    if (lvl === 1) { var s = ""; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s + "."; }
    if (lvl === 2) {
      var map = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]], r = "";
      map.forEach(function (p) { while (n >= p[0]) { r += p[1]; n -= p[0]; } });
      return r + ".";
    }
    return n + ".";
  }

  // ---------- markdown shortcuts while typing ----------
  // Called when the text of a paragraph is exactly what the user typed so far at the start of the line.
  function mdShortcut(text) {
    var m;
    if (text === "# ") return { type: "h1" };
    if (text === "## ") return { type: "h2" };
    if (text === "### ") return { type: "h3" };
    if (text === "- " || text === "* " || text === "+ ") return { type: "ul" };
    if (/^\d{1,3}[.)] $/.test(text)) return { type: "ol" };
    if (text === "[] " || text === "[ ] ") return { type: "todo" };
    if (text === "[x] " || text === "[X] ") return { type: "todo", props: { checked: true } };
    if (text === ">> ") return { type: "toggle" };
    if (text === "> " || text === '" ') return { type: "quote" };
    if (text === "---" || text === "***" || text === "___") return { type: "divider" };
    if ((m = /^```([\w+#.-]{0,24}) $/.exec(text))) return { type: "code", props: { lang: m[1] } };
    return null;
  }
  var INLINE = [["**", "b"], ["~~", "s"], ["==", "h"], ["`", "c"], ["*", "i"], ["_", "i"]];
  // **bold** / *italic* / `code` / ~~strike~~ / ==highlight== closed right before the caret.
  function inlineShortcut(text, caret) {
    var s = text.slice(0, caret);
    for (var k = 0; k < INLINE.length; k++) {
      var mk = INLINE[k][0], L = mk.length;
      if (s.slice(-L) !== mk) continue;
      var close = s.length - L;
      if (L === 1 && s[close - 1] === mk) continue;
      var open = s.lastIndexOf(mk, close - 1);
      if (open < 0 || open + L >= close) continue;
      if (L === 1 && (s[open - 1] === mk)) continue;
      var inner = s.slice(open + L, close);
      if (/^\s|\s$/.test(inner) || inner.indexOf(mk) >= 0) continue;
      if (mk === "_" && open > 0 && /[\p{L}\p{N}]/u.test(s[open - 1])) continue;
      if (mk !== "`" && inner.indexOf("`") >= 0) continue;
      return { open: open, close: close, size: L, mark: INLINE[k][1] };
    }
    return null;
  }
  function applyInline(spans, hit) {
    var out = deleteRange(spans, hit.close, hit.close + hit.size);
    out = deleteRange(out, hit.open, hit.open + hit.size);
    return setMark(out, hit.open, hit.close - hit.size, hit.mark, true);
  }

  // ---------- slash commands ----------
  var SLASH = [
    { id: "p", label: "Text", hint: "Plain paragraph", keys: "text paragraph plain" },
    { id: "h1", label: "Heading 1", hint: "Big section heading", keys: "h1 heading title #" },
    { id: "h2", label: "Heading 2", hint: "Medium heading", keys: "h2 heading subtitle ##" },
    { id: "h3", label: "Heading 3", hint: "Small heading", keys: "h3 heading ###" },
    { id: "ul", label: "Bulleted list", hint: "Simple bullets", keys: "bullet list ul unordered -" },
    { id: "ol", label: "Numbered list", hint: "1, 2, 3", keys: "numbered list ol ordered 1." },
    { id: "todo", label: "To-do list", hint: "Track tasks", keys: "todo to-do task check checkbox []" },
    { id: "toggle", label: "Toggle list", hint: "Hide content inside", keys: "toggle collapse details fold >>" },
    { id: "quote", label: "Quote", hint: "Capture a quote", keys: "quote blockquote citation >" },
    { id: "callout", label: "Callout", hint: "Make text stand out", keys: "callout note info tip warning box" },
    { id: "divider", label: "Divider", hint: "Separate sections", keys: "divider line hr separator ---" },
    { id: "code", label: "Code", hint: "Code snippet", keys: "code snippet pre ```" },
    { id: "table", label: "Table", hint: "Simple rows and columns", keys: "table grid rows columns" },
    { id: "image", label: "Image", hint: "From a file on this device", keys: "image picture photo img upload" },
    { id: "newpage", label: "Page", hint: "New page inside this one", keys: "page subpage new child" },
    { id: "pagelink", label: "Link to page", hint: "Link an existing page", keys: "link page reference" },
    { id: "mention", label: "Mention page", hint: "Inline link to a page", keys: "mention @ inline page [[" },
    { id: "date", label: "Today's date", hint: "Insert the date", keys: "date today now time" }
  ];
  function slashFilter(q) {
    q = String(q || "").toLowerCase().trim();
    if (!q) return SLASH.slice();
    var scored = [];
    SLASH.forEach(function (c, k) {
      var lab = c.label.toLowerCase(), score = lab.indexOf(q) === 0 ? 3 : lab.indexOf(q) >= 0 ? 2 : (" " + c.keys).indexOf(" " + q) >= 0 ? 1 : 0;
      if (score) scored.push({ c: c, s: score, k: k });
    });
    return scored.sort(function (a, b) { return b.s - a.s || a.k - b.k; }).map(function (x) { return x.c; });
  }
  // Remove "/query" (from..to) from block i, then turn the block into `type` if it is now an empty paragraph,
  // otherwise insert a new block below it. Returns the index of the block to focus.
  function applySlash(blocks, i, from, to, type) {
    var b = blocks[i];
    if (TEXT_TYPES[b.type]) b.text = deleteRange(b.text, from, to);
    var empty = TEXT_TYPES[b.type] && !len(b.text);
    if (empty && (b.type === "p" || type === "p")) { blocks[i] = convert(b, type); return i; }
    var nb = newBlock(type, { indent: b.indent, dir: b.dir });
    blocks.splice(i + 1, 0, nb);
    return i + 1;
  }

  // ---------- search ----------
  function fold(s) {
    return String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g, "")
      .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي");
  }
  function indexPage(p) {
    return { id: p.id, title: fold(p.title || "Untitled"), blocks: p.blocks.map(function (b) { return { id: b.id, raw: blockText(b), f: fold(blockText(b)) }; }), updated: p.updated };
  }
  function search(index, q, limit) {
    var words = fold(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var res = [];
    index.forEach(function (e) {
      var body = e.blocks.map(function (b) { return b.f; }).join("\n"), score = 0;
      for (var k = 0; k < words.length; k++) {
        var w = words[k], inT = e.title.indexOf(w) >= 0;
        if (!inT && body.indexOf(w) < 0) return;
        score += inT ? (e.title.indexOf(w) === 0 ? 12 : 8) : 2;
      }
      if (e.title === fold(q).trim()) score += 20;
      var hit = null;
      if (!words.every(function (w) { return e.title.indexOf(w) >= 0; })) {
        for (var j = 0; j < e.blocks.length; j++) {
          var at = e.blocks[j].f.indexOf(words[0]);
          if (at < 0) at = words.map(function (w) { return e.blocks[j].f.indexOf(w); }).filter(function (x) { return x >= 0; })[0];
          if (at >= 0) {
            var raw = e.blocks[j].raw, from = Math.max(0, at - 40);
            hit = { block: e.blocks[j].id, text: (from ? "…" : "") + raw.slice(from, from + 120).replace(/\s+/g, " ") + (raw.length > from + 120 ? "…" : "") };
            break;
          }
        }
      }
      res.push({ id: e.id, score: score, updated: e.updated, hit: hit });
    });
    return res.sort(function (a, b) { return b.score - a.score || b.updated - a.updated; }).slice(0, limit || 50);
  }

  // ---------- pages, tree, trash ----------
  function cleanPage(x) {
    x = x && typeof x === "object" ? x : {};
    var now = Date.now(), t = function (v) { return num(v, 1, 4e12, now); };
    var blocks = Array.isArray(x.blocks) ? x.blocks.slice(0, 20000).map(cleanBlock) : [];
    var seen = {};
    blocks.forEach(function (b) { if (seen[b.id]) b.id = uid(); seen[b.id] = 1; });
    var p = {
      id: typeof x.id === "string" && ID_RE.test(x.id) ? x.id : uid(),
      parent: typeof x.parent === "string" && ID_RE.test(x.parent) ? x.parent : null,
      pos: num(x.pos, -1e15, 1e15, 0),
      title: str(x.title, 500).replace(/[\r\n]+/g, " "),
      icon: str(x.icon, 16),
      cover: x.cover === null || x.cover === undefined ? null : Math.floor(num(x.cover, 0, COVER_COUNT - 1, -1)),
      font: FONTS.indexOf(x.font) >= 0 ? x.font : "sans",
      wide: x.wide === true,
      blocks: fixIndents(blocks.length ? blocks : [newBlock("p")]),
      created: t(x.created), updated: t(x.updated),
      trashed: num(x.trashed, 0, 4e12, 0),
      trashRoot: typeof x.trashRoot === "string" && ID_RE.test(x.trashRoot) ? x.trashRoot : null,
      fav: num(x.fav, 0, 4e12, 0)
    };
    if (p.cover === -1) p.cover = null;
    if (!p.trashed) p.trashRoot = null;
    if (p.parent === p.id) p.parent = null;
    return p;
  }
  function newPage(props) {
    var p = cleanPage({});
    if (props) for (var k in props) p[k] = props[k];
    return p;
  }
  // Break cycles and dangling parents (for imported or damaged data). pages: {id: page}
  function repairTree(pages) {
    Object.keys(pages).forEach(function (id) {
      var p = pages[id], seen = {}, cur = p;
      seen[id] = 1;
      while (cur.parent) {
        var up = pages[cur.parent];
        if (!up) { cur.parent = null; break; }
        if (seen[up.id]) { p.parent = null; break; }
        seen[up.id] = 1; cur = up;
      }
    });
    return pages;
  }
  function children(pages, parent, includeTrashed) {
    return Object.keys(pages).map(function (k) { return pages[k]; })
      .filter(function (p) { return (p.parent || null) === (parent || null) && (includeTrashed || !p.trashed); })
      .sort(function (a, b) { return a.pos - b.pos || a.created - b.created; });
  }
  function descendants(pages, id) {
    var out = [], stack = [id];
    var kids = {};
    Object.keys(pages).forEach(function (k) { var p = pages[k]; if (p.parent) (kids[p.parent] = kids[p.parent] || []).push(p.id); });
    while (stack.length) {
      var cur = stack.pop();
      (kids[cur] || []).forEach(function (c) { if (out.indexOf(c) < 0 && c !== id) { out.push(c); stack.push(c); } });
    }
    return out;
  }
  function isInside(pages, id, ancestor) {
    var cur = pages[id], guard = 0;
    while (cur && cur.parent && guard++ < 10000) { if (cur.parent === ancestor) return true; cur = pages[cur.parent]; }
    return false;
  }
  function posBetween(a, b) {
    if (a == null && b == null) return 1;
    if (a == null) return b - 1;
    if (b == null) return a + 1;
    return (a + b) / 2;
  }
  // Put page `id` under `parent` (null = top level) before sibling `beforeId` (null = at the end).
  function movePage(pages, id, parent, beforeId) {
    if (parent && (parent === id || isInside(pages, parent, id))) return false;
    var sibs = children(pages, parent).filter(function (p) { return p.id !== id; });
    var at = beforeId ? sibs.map(function (p) { return p.id; }).indexOf(beforeId) : -1;
    if (at < 0) at = sibs.length;
    var a = at > 0 ? sibs[at - 1].pos : null, b = at < sibs.length ? sibs[at].pos : null;
    var pos = posBetween(a, b);
    if (a != null && b != null && !(pos > a && pos < b)) { sibs.forEach(function (p, k) { p.pos = k + 1; }); pos = at + 0.5; }
    pages[id].parent = parent || null;
    pages[id].pos = pos;
    return true;
  }
  function trashPage(pages, id, now) {
    var p = pages[id];
    if (!p || p.trashed) return [];
    var hit = [id].concat(descendants(pages, id)).filter(function (k) { return !pages[k].trashed; });
    hit.forEach(function (k) { pages[k].trashed = now || Date.now(); pages[k].trashRoot = id; });
    return hit;
  }
  function restorePage(pages, id) {
    var p = pages[id];
    if (!p || !p.trashed) return [];
    var hit = Object.keys(pages).filter(function (k) { return pages[k].trashRoot === id; });
    hit.forEach(function (k) { pages[k].trashed = 0; pages[k].trashRoot = null; });
    var par = p.parent && pages[p.parent];
    if (!par || par.trashed) {
      p.parent = null;
      var top = children(pages, null).filter(function (x) { return x.id !== id; });
      p.pos = top.length ? top[top.length - 1].pos + 1 : 1;
    }
    return hit;
  }
  function deleteForever(pages, id) {
    var p = pages[id];
    if (!p || !p.trashed) return [];
    var hit = [id].concat(descendants(pages, id).filter(function (k) { return pages[k].trashRoot === p.trashRoot; }));
    hit.forEach(function (k) { delete pages[k]; });
    return hit;
  }
  function blobRefs(pageList) {
    var refs = {};
    pageList.forEach(function (p) { p.blocks.forEach(function (b) { if (b.type === "image" && b.blob) refs[b.blob] = 1; }); });
    return refs;
  }

  // ---------- markdown export ----------
  function mdEscape(t) { return t.replace(/([\\`*_\[\]<>~|])/g, "\\$1").replace(/==/g, "\\=\\="); }
  function spansToMd(spans, ctx) {
    return (spans || []).map(function (s) {
      if (s.p) { var pt = ctx && ctx.title ? ctx.title(s.p) : "page", href = ctx && ctx.link ? ctx.link(s.p) : ""; return href ? "[" + mdEscape(pt) + "](" + href + ")" : "@" + mdEscape(pt); }
      var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.t), lead = m[1], body = m[2], tail = m[3];
      if (!body) return s.t;
      var out;
      if (s.c) { var run = Math.max.apply(null, [0].concat((body.match(/`+/g) || []).map(function (x) { return x.length; }))) + 1, f = new Array(run + 1).join("`"); out = f + (body[0] === "`" ? " " : "") + body + (body.slice(-1) === "`" ? " " : "") + f; }
      else out = mdEscape(body).replace(/\n/g, "  \n");
      if (s.s) out = "~~" + out + "~~";
      if (s.h) out = "==" + out + "==";
      if (s.i) out = "*" + out + "*";
      if (s.b) out = "**" + out + "**";
      if (s.a) out = "[" + out + "](" + s.a.replace(/[()\s]/g, function (c) { return encodeURIComponent(c); }) + ")";
      return lead + out + tail;
    }).join("");
  }
  // Flat list with indent → tree [{b, kids: []}]
  function treeify(blocks) {
    var root = { kids: [] }, stack = [{ node: root, indent: -1 }];
    blocks.forEach(function (b) {
      while (stack.length > 1 && stack[stack.length - 1].indent >= b.indent) stack.pop();
      var n = { b: b, kids: [] };
      stack[stack.length - 1].node.kids.push(n);
      stack.push({ node: n, indent: b.indent });
    });
    return root.kids;
  }
  function pageToMd(page, ctx) {
    var out = ["# " + (page.icon ? page.icon + " " : "") + mdEscape(page.title || "Untitled"), ""];
    function walk(nodes, pad) {
      var counters = 0;
      nodes.forEach(function (n) {
        var b = n.b, t = TEXT_TYPES[b.type] ? spansToMd(b.text, ctx) : "", line = null, child = pad, cont = pad;
        if (b.type !== "ol") counters = 0;
        switch (b.type) {
          case "h1": line = "## " + t; break; // the page title is the only H1 in the file
          case "h2": line = "### " + t; break;
          case "h3": line = "#### " + t; break;
          case "ul": case "toggle": line = "- " + t; child = cont = pad + "  "; break;
          case "ol": counters++; line = counters + ". " + t; child = cont = pad + "   "; break;
          case "todo": line = "- [" + (b.checked ? "x" : " ") + "] " + t; child = cont = pad + "  "; break;
          case "quote": line = "> " + t.replace(/\n/g, "\n" + pad + "> "); break;
          case "callout": line = "> " + b.icon + " " + t.replace(/\n/g, "\n" + pad + "> "); break;
          case "divider": line = "---"; break;
          case "code":
            var run = Math.max.apply(null, [2].concat((b.code.match(/`+/g) || []).map(function (x) { return x.length; }))) + 1, f = new Array(run + 1).join("`");
            line = f + b.lang + "\n" + b.code.split("\n").map(function (l) { return pad + l; }).join("\n") + "\n" + pad + f; break;
          case "table":
            var cell = function (c) { return c.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " "); };
            var rows = b.rows.map(function (r) { return "| " + r.map(cell).join(" | ") + " |"; });
            rows.splice(1, 0, "|" + b.rows[0].map(function () { return " --- "; }).join("|") + "|");
            if (!b.header) rows.unshift("|" + b.rows[0].map(function () { return "  "; }).join("|") + "|");
            line = rows.join("\n" + pad); break;
          case "image": line = "![" + mdEscape(b.caption || "image") + "](" + (ctx && ctx.img ? ctx.img(b.blob) : "") + ")"; break;
          case "page": line = "[" + mdEscape((ctx && ctx.title ? ctx.title(b.page) : "page")) + "](" + (ctx && ctx.link ? ctx.link(b.page) : "") + ")"; break;
          default:
            line = t;
            if (/^(#{1,6}\s|[-+*]\s|\d+[.)]\s|>)/.test(line)) line = "\\" + line;
        }
        if (b.type !== "quote" && b.type !== "callout" && b.type !== "code" && b.type !== "table") line = line.replace(/\n/g, "\n" + cont);
        out.push(pad + line);
        var inList = b.type === "ul" || b.type === "ol" || b.type === "todo" || b.type === "toggle";
        if (!inList) out.push("");
        if (n.kids.length) { walk(n.kids, child); }
        var next = nodes[nodes.indexOf(n) + 1];
        if (inList && !pad && !(next && /^(ul|ol|todo|toggle)$/.test(next.b.type))) out.push("");
      });
    }
    walk(treeify(page.blocks), "");
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  // ---------- markdown import ----------
  function closing(s, i, mk) {
    for (var j = i; j <= s.length - mk.length; j++) {
      if (s[j] === "\\") { j++; continue; }
      if (s.substr(j, mk.length) === mk && j > i && !/\s/.test(s[j - 1])) return j;
    }
    return -1;
  }
  function mdInline(s, depth) {
    depth = depth || 0;
    var out = [], buf = "", i = 0;
    function flush() { if (buf) { out.push({ t: buf }); buf = ""; } }
    function add(spans, mark, val) { spans.forEach(function (x) { if (!x.p) x[mark] = val || true; out.push(x); }); }
    while (i < s.length) {
      var c = s[i];
      if (c === "\\" && i + 1 < s.length && /[!-\/:-@\[-`{-~]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      if (c === "`") {
        var run = /^`+/.exec(s.slice(i))[0], end = s.indexOf(run, i + run.length);
        if (end > 0) { flush(); var code = s.slice(i + run.length, end); if (/^ .* $/.test(code)) code = code.slice(1, -1); out.push({ t: code, c: true }); i = end + run.length; continue; }
      }
      if (c === "[" && depth < 4) {
        var close = s.indexOf("](", i), endp = -1;
        if (close > 0) for (var q = close + 2, dp = 0; q < s.length; q++) { if (s[q] === "(") dp++; else if (s[q] === ")") { if (!dp) { endp = q; break; } dp--; } }
        if (close > 0 && endp > 0 && s.slice(i + 1, close).indexOf("[") < 0) {
          var url = safeUrl(s.slice(close + 2, endp).trim().replace(/^<|>$/g, ""));
          flush();
          var inner = mdInline(s.slice(i + 1, close), depth + 1);
          if (url) add(inner, "a", url); else inner.forEach(function (x) { out.push(x); });
          i = endp + 1; continue;
        }
      }
      var hit = false;
      if (depth < 6) for (var k = 0; k < INLINE.length; k++) {
        var mk = INLINE[k][0];
        if (s.substr(i, mk.length) !== mk || mk === "`" || /\s/.test(s[i + mk.length] || " ")) continue;
        if (mk === "_" && i > 0 && /[\p{L}\p{N}]/u.test(s[i - 1])) continue;
        var j = closing(s, i + mk.length, mk);
        if (j < 0) continue;
        if (mk.length === 1 && s[j + 1] === mk) continue;
        flush();
        add(mdInline(s.slice(i + mk.length, j), depth + 1), INLINE[k][1]);
        i = j + mk.length; hit = true; break;
      }
      if (hit) continue;
      if (c === "<" && /^<\/?u>/i.test(s.slice(i))) { i += s[i + 1] === "/" ? 4 : 3; continue; }
      buf += c; i++;
    }
    flush();
    return norm(out);
  }
  function mdCells(line) {
    var s = line.trim().replace(/^\|/, "").replace(/(^|[^\\])\|$/, "$1");
    var out = [], cur = "";
    for (var k = 0; k < s.length; k++) {
      if (s[k] === "\\" && (s[k + 1] === "|" || s[k + 1] === "\\")) { cur += s[k + 1]; k++; }
      else if (s[k] === "|") { out.push(cur.trim()); cur = ""; }
      else cur += s[k];
    }
    out.push(cur.trim());
    return out;
  }
  function unresolvedImages(blocks) {
    return blocks.map(function (b) {
      if (b.type !== "image" || b.blob) return b;
      return newBlock("p", { id: b.id, indent: b.indent, text: norm([{ t: "[image: " + (b.caption || b._src || "") + "]" }]) });
    });
  }
  function mdToPage(text, opts) {
    var noTitle = opts && opts.noTitle;
    var lines = String(text || "").replace(/\r\n?/g, "\n").split("\n"), blocks = [], title = "", stack = [], i = 0, m;
    var EMOJI = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s+/u;
    function lead(l) { return l.replace(/\t/g, "    ").search(/\S|$/); }
    function depthFor(L) { while (stack.length && stack[stack.length - 1] >= L) stack.pop(); var d = stack.length; stack.push(L); return Math.min(d, MAX_INDENT); }
    // list items nest by their leading spaces; anything else at column 0 ends the list
    function push(type, props, L, isList) {
      var ind;
      if (!isList && !L) { stack.length = 0; ind = 0; } else ind = depthFor(L);
      var b = newBlock(type, props); b.indent = ind; blocks.push(b); return b;
    }
    while (i < lines.length && lines.length < 200000) {
      var line = lines[i], L = lead(line), t = line.trim();
      if (!t) { i++; continue; }
      if ((m = /^(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(t))) {
        var fence = m[1], code = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(fence) !== 0) { code.push(lines[i].slice(Math.min(L, lead(lines[i])))); i++; }
        i++;
        push("code", { code: code.join("\n"), lang: m[2].slice(0, 24) }, L);
        continue;
      }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(t))) {
        var level = m[1].length;
        if (level === 1 && !noTitle && !title && !blocks.length) { title = m[2].replace(/\\(.)/g, "$1"); i++; continue; }
        push(noTitle ? (level === 1 ? "h1" : level === 2 ? "h2" : "h3") : level <= 2 ? "h1" : level === 3 ? "h2" : "h3", { text: mdInline(m[2]) }, 0);
        i++; continue;
      }
      if (/^([-*_])(\s*\1){2,}$/.test(t)) { push("divider", null, 0); i++; continue; }
      if (t.indexOf("|") >= 0 && i + 1 < lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(lines[i + 1].trim())) {
        var rows = [mdCells(t)];
        i += 2;
        while (i < lines.length && lines[i].indexOf("|") >= 0 && lines[i].trim()) { rows.push(mdCells(lines[i])); i++; }
        var empty = rows[0].every(function (c) { return !c; });
        push("table", { rows: empty ? rows.slice(1) : rows, header: !empty }, L);
        blocks[blocks.length - 1] = cleanBlock(blocks[blocks.length - 1]);
        continue;
      }
      if (t[0] === ">") {
        var q = [];
        while (i < lines.length && lines[i].trim()[0] === ">") { q.push(lines[i].trim().replace(/^>\s?/, "")); i++; }
        var qt = q.join("\n").replace(/ {2}$/gm, ""), em = EMOJI.exec(qt);
        if (em) push("callout", { icon: em[1], text: mdInline(qt.slice(em[0].length)) }, L);
        else push("quote", { text: mdInline(qt) }, L);
        continue;
      }
      if ((m = /^([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(t))) {
        var body = m[2], type = /\d/.test(m[1]) ? "ol" : "ul", props = {};
        var task = /^\[([ xX])\]\s+(.*)$/.exec(body) || /^\[([ xX])\]$/.exec(body);
        if (task && type === "ul") { type = "todo"; props.checked = task[1] !== " "; body = task[2] || ""; }
        props.text = mdInline(body);
        push(type, props, L, true);
        i++; continue;
      }
      // A picture on its own line: an image block that remembers where it pointed (_src); the importer
      // resolves it against files in the same zip, otherwise it becomes a "[image: …]" line.
      if ((m = /^!\[([^\]]*)\]\(<?([^)>]*)>?\)$/.exec(t))) { var ib = push("image", { caption: m[1].slice(0, 1000) }, L); ib._src = m[2]; i++; continue; }
      var para = [t.replace(/ {2}$/, "")];
      i++;
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|```|~~~|[-*+]\s|\d{1,9}[.)]\s|\|)/.test(lines[i].trim()) && !/^([-*_])(\s*\1){2,}$/.test(lines[i].trim())) {
        para.push(lines[i].trim().replace(/ {2}$/, "").replace(/\\$/, "")); i++;
      }
      push("p", { text: mdInline(para.join("\n")) }, L);
    }
    return { title: title, blocks: fixIndents(blocks.length ? blocks : [newBlock("p")]) };
  }

  // ---------- HTML export (standalone file; every user string is escaped) ----------
  function spansToHtml(spans, ctx) {
    return (spans || []).map(function (s) {
      if (s.p) return '<span class="mention">' + esc((ctx && ctx.icon ? ctx.icon(s.p) : "📄") + " " + (ctx && ctx.title ? ctx.title(s.p) : "page")) + "</span>";
      var h = esc(s.t).replace(/\n/g, "<br>");
      if (s.c) h = "<code>" + h + "</code>";
      if (s.h) h = "<mark>" + h + "</mark>";
      if (s.s) h = "<s>" + h + "</s>";
      if (s.u) h = "<u>" + h + "</u>";
      if (s.i) h = "<em>" + h + "</em>";
      if (s.b) h = "<strong>" + h + "</strong>";
      var url = s.a && safeUrl(s.a);
      if (url) h = '<a href="' + esc(url) + '" rel="noopener noreferrer">' + h + "</a>";
      return h;
    }).join("");
  }
  var HTML_CSS = "body{font:16px/1.65 system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans Arabic',sans-serif;color:#1d2228;max-width:760px;margin:40px auto;padding:0 20px}" +
    "h1.title{font-size:2.2em;margin:.4em 0 .6em}h2{font-size:1.6em}h3{font-size:1.3em}h4{font-size:1.1em}.cover{height:180px;border-radius:12px}" +
    "blockquote{border-inline-start:3px solid #444;margin:0;padding:2px 14px}.callout{display:flex;gap:10px;padding:14px 16px;border-radius:10px;background:#f2f3f5;margin:6px 0}" +
    ".todo{list-style:none;padding-inline-start:4px}.todo li.done>span{text-decoration:line-through;color:#888}pre{background:#f4f5f7;padding:14px;border-radius:10px;overflow:auto}" +
    "code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em}p code,li code{background:#eef0f3;padding:1px 5px;border-radius:5px}mark{background:#fff3a3}" +
    "table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #d5d9df;padding:6px 10px;text-align:start}th{background:#f4f5f7}img{max-width:100%;border-radius:8px}" +
    "figure{margin:10px 0}figcaption{color:#777;font-size:.9em}hr{border:0;border-top:1px solid #ddd;margin:18px 0}.mention{background:#eef0f3;border-radius:5px;padding:0 4px}" +
    "details>summary{cursor:pointer}.kids{margin-inline-start:24px}.font-serif{font-family:Georgia,'Times New Roman',serif}.font-mono{font-family:ui-monospace,Menlo,Consolas,monospace}";
  function pageToHtml(page, ctx) {
    function nodesHtml(nodes) {
      var html = "", k = 0;
      while (k < nodes.length) {
        var n = nodes[k], b = n.b, t = TEXT_TYPES[b.type] ? spansToHtml(b.text, ctx) : "";
        var dir = ' dir="' + (b.dir || "auto") + '"';
        var kids = n.kids.length ? nodesHtml(n.kids) : "";
        if (b.type === "ul" || b.type === "ol" || b.type === "todo") {
          var tag = b.type === "ol" ? "ol" : "ul", items = "";
          while (k < nodes.length && nodes[k].b.type === b.type) {
            var it = nodes[k], ik = it.kids.length ? nodesHtml(it.kids) : "";
            items += b.type === "todo"
              ? '<li class="' + (it.b.checked ? "done" : "") + '"' + ' dir="' + (it.b.dir || "auto") + '">' + (it.b.checked ? "☑ " : "☐ ") + "<span>" + spansToHtml(it.b.text, ctx) + "</span>" + ik + "</li>"
              : '<li dir="' + (it.b.dir || "auto") + '">' + spansToHtml(it.b.text, ctx) + ik + "</li>";
            k++;
          }
          html += "<" + tag + (b.type === "todo" ? ' class="todo"' : "") + ">" + items + "</" + tag + ">";
          continue;
        }
        switch (b.type) {
          case "h1": html += "<h2" + dir + ">" + t + "</h2>"; break;
          case "h2": html += "<h3" + dir + ">" + t + "</h3>"; break;
          case "h3": html += "<h4" + dir + ">" + t + "</h4>"; break;
          case "toggle": html += "<details open><summary" + dir + ">" + t + "</summary>" + '<div class="kids">' + kids + "</div></details>"; kids = ""; break;
          case "quote": html += "<blockquote" + dir + ">" + t + "</blockquote>"; break;
          case "callout": html += '<div class="callout"' + dir + "><span>" + esc(b.icon) + "</span><div>" + t + "</div></div>"; break;
          case "divider": html += "<hr>"; break;
          case "code": html += "<pre><code>" + esc(b.code) + "</code></pre>"; break;
          case "table":
            html += "<table>" + b.rows.map(function (r, ri) { var c = ri === 0 && b.header ? "th" : "td"; return "<tr>" + r.map(function (x) { return "<" + c + ' dir="auto">' + esc(x) + "</" + c + ">"; }).join("") + "</tr>"; }).join("") + "</table>"; break;
          case "image":
            var src = ctx && ctx.img ? ctx.img(b.blob) : "";
            html += "<figure>" + (src ? '<img src="' + esc(src) + '" alt="' + esc(b.caption) + '" style="width:' + b.width + '%">' : "<p>[missing image]</p>") + (b.caption ? "<figcaption" + dir + ">" + esc(b.caption) + "</figcaption>" : "") + "</figure>"; break;
          case "page": html += '<p><span class="mention">' + esc((ctx && ctx.icon ? ctx.icon(b.page) : "📄") + " " + (ctx && ctx.title ? ctx.title(b.page) : "page")) + "</span></p>"; break;
          default: html += "<p" + dir + ">" + (t || "<br>") + "</p>";
        }
        if (kids) html += '<div class="kids">' + kids + "</div>";
        k++;
      }
      return html;
    }
    var title = (page.icon ? page.icon + " " : "") + (page.title || "Untitled");
    return '<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">" +
      "<title>" + esc(title) + "</title><style>" + HTML_CSS + "</style></head><body class=\"font-" + esc(page.font) + "\">" +
      (ctx && ctx.cover ? '<div class="cover" style="background:' + esc(ctx.cover) + '"></div>' : "") +
      '<h1 class="title" dir="auto">' + esc(title) + "</h1>" + nodesHtml(treeify(page.blocks)) + "</body></html>\n";
  }

  // ---------- file names ----------
  function fileName(s, fallback) {
    var n = String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).replace(/[. ]+$/, "");
    return n || fallback || "Untitled";
  }

  window.PG = {
    COVERS: COVERS, unresolvedImages: unresolvedImages, ID_RE: ID_RE, TEXT_TYPES: TEXT_TYPES, ALL_TYPES: ALL_TYPES, CALLOUT_COLORS: CALLOUT_COLORS, FONTS: FONTS, IMAGE_TYPES: IMAGE_TYPES, COVER_COUNT: COVER_COUNT, MAX_INDENT: MAX_INDENT,
    uid: uid, esc: esc, safeUrl: safeUrl,
    norm: norm, plain: plain, len: len, slice: slice, concat: concat, deleteRange: deleteRange, insertText: insertText, insertSpans: insertSpans,
    hasMark: hasMark, setMark: setMark, toggleMark: toggleMark, cleanSpans: cleanSpans,
    newBlock: newBlock, cleanBlock: cleanBlock, blockText: blockText, subtreeEnd: subtreeEnd, fixIndents: fixIndents,
    splitBlock: splitBlock, mergeUp: mergeUp, moveBlock: moveBlock, indentBlock: indentBlock, outdentBlock: outdentBlock, moveUp: moveUp, moveDown: moveDown,
    convert: convert, layout: layout, olLabel: olLabel,
    mdShortcut: mdShortcut, inlineShortcut: inlineShortcut, applyInline: applyInline, SLASH: SLASH, slashFilter: slashFilter, applySlash: applySlash,
    fold: fold, indexPage: indexPage, search: search,
    cleanPage: cleanPage, newPage: newPage, repairTree: repairTree, children: children, descendants: descendants, isInside: isInside, movePage: movePage,
    trashPage: trashPage, restorePage: restorePage, deleteForever: deleteForever, blobRefs: blobRefs,
    spansToMd: spansToMd, pageToMd: pageToMd, mdInline: mdInline, mdToPage: mdToPage, spansToHtml: spansToHtml, pageToHtml: pageToHtml, treeify: treeify, fileName: fileName
  };
})();
