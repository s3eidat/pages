/* Pages: the block editor. The page's block list (PG model) is the source of truth.
 * Each text block is its own contenteditable. After every edit the DOM is read back through readSpans(), which only
 * understands the inline tags this file writes (strong/em/u/s/code/mark/a/mention). Anything else the browser or a
 * paste slips in is dropped and the block is re-rendered from the model, so foreign HTML never survives. */
(function () {
  "use strict";
  var P = window.PG, h = S3.h;
  var MARK_TAG = { STRONG: "b", B: "b", EM: "i", I: "i", U: "u", S: "s", DEL: "s", STRIKE: "s", CODE: "c", MARK: "h", A: "a" };
  var OWN = { STRONG: 1, EM: 1, U: 1, S: 1, CODE: 1, MARK: 1, A: 1 };
  var WRAP = [["c", "code"], ["h", "mark"], ["s", "s"], ["u", "u"], ["i", "em"], ["b", "strong"]];
  var PH = { p: "Type '/' for commands", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", ul: "List", ol: "List", todo: "To-do", toggle: "Toggle", quote: "Quote", callout: "Write something…" };
  var BULLETS = ["•", "◦", "▪"];
  var TURN = [["p", "Text", "¶"], ["h1", "Heading 1", "H1"], ["h2", "Heading 2", "H2"], ["h3", "Heading 3", "H3"], ["ul", "Bulleted list", "•"], ["ol", "Numbered list", "1."],
    ["todo", "To-do list", "☑"], ["toggle", "Toggle list", "▸"], ["quote", "Quote", "❝"], ["callout", "Callout", "💡"], ["code", "Code", "</>"]];
  var SLASH_ICON = { p: "¶", h1: "H1", h2: "H2", h3: "H3", ul: "•", ol: "1.", todo: "☑", toggle: "▸", quote: "❝", callout: "💡", divider: "—", code: "</>", table: "▦", image: "🖼", newpage: "📄", pagelink: "↗", mention: "@", date: "📅" };

  // ---------- DOM <-> spans ----------
  function lastDeep(n) { while (n && n.lastChild) n = n.lastChild; return n; }
  function readSpans(root) {
    var out = [], foreign = false, last = lastDeep(root);
    (function walk(node, m) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { if (c.data) out.push(Object.assign({}, m, { t: c.data })); continue; }
        if (c.nodeType !== 1) continue;
        var tag = c.nodeName;
        if (c.hasAttribute("data-page")) { var id = c.getAttribute("data-page"); if (P.ID_RE.test(id)) out.push({ t: "@", p: id }); continue; }
        if (tag === "BR") { if (!c.hasAttribute("data-tail") && c !== last) out.push(Object.assign({}, m, { t: "\n" })); continue; }
        if (!OWN[tag] || c.hasAttribute("style")) foreign = true;
        var nm = Object.assign({}, m), k = MARK_TAG[tag];
        if (k === "a") { var u = P.safeUrl(c.getAttribute("href") || ""); if (u) nm.a = u; } else if (k) nm[k] = true;
        if ((tag === "DIV" || tag === "P") && out.length && !/\n$/.test(out[out.length - 1].t)) out.push({ t: "\n" });
        walk(c, nm);
      }
    })(root, {});
    return { spans: P.norm(out), foreign: foreign };
  }
  function measure(n) {
    var L = 0;
    for (var c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) L += c.data.length;
      else if (c.nodeType === 1) {
        if (c.hasAttribute("data-page")) L += 1;
        else if (c.nodeName === "BR") L += c.hasAttribute("data-tail") ? 0 : 1;
        else L += measure(c);
      }
    }
    return L;
  }
  function offsetAt(root, node, off) {
    var r = document.createRange();
    r.selectNodeContents(root);
    try { r.setEnd(node, off); } catch (e) { return 0; }
    return measure(r.cloneContents());
  }
  function caretIn(root) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var r = sel.getRangeAt(0);
    if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
    var a = offsetAt(root, r.startContainer, r.startOffset);
    return { start: a, end: r.collapsed ? a : offsetAt(root, r.endContainer, r.endOffset) };
  }
  function posAt(root, off, right) {
    var acc = 0, res = null;
    (function walk(n) {
      for (var c = n.firstChild; c && !res; c = c.nextSibling) {
        var ix = Array.prototype.indexOf.call(n.childNodes, c);
        if (c.nodeType === 3) { if (off < acc + c.data.length || (off === acc + c.data.length && !right)) { res = { node: c, off: off - acc }; return; } acc += c.data.length; }
        else if (c.nodeType === 1) {
          if (c.nodeName === "BR" && c.hasAttribute("data-tail")) { if (off === acc) { res = { node: n, off: ix }; } return; }
          if (c.hasAttribute("data-page") || c.nodeName === "BR") { if (off === acc) { res = { node: n, off: ix }; return; } acc += 1; if (off === acc && !c.nextSibling) { res = { node: n, off: ix + 1 }; return; } }
          else walk(c);
        }
      }
    })(root);
    return res || { node: root, off: root.childNodes.length };
  }
  function setCaret(root, a, b) {
    var sel = window.getSelection(), r = document.createRange(), p1 = posAt(root, a), p2 = b == null || b === a ? p1 : posAt(root, b);
    try { r.setStart(p1.node, p1.off); r.setEnd(p2.node, p2.off); sel.removeAllRanges(); sel.addRange(r); } catch (e) { /* node gone */ }
  }
  function renderSpans(el, spans, ctx) {
    el.textContent = "";
    spans.forEach(function (s) {
      if (s.p) {
        el.appendChild(h("span", { "class": "pg-mention", contenteditable: "false", "data-page": s.p, title: "Open page", text: ctx.icon(s.p) + " " + ctx.title(s.p) }));
        return;
      }
      var node = document.createTextNode(s.t);
      WRAP.forEach(function (w) { if (s[w[0]]) { var e = document.createElement(w[1]); e.appendChild(node); node = e; } });
      if (s.a) { var a = document.createElement("a"); a.href = s.a; a.title = s.a + "  ·  Ctrl+click to open"; a.rel = "noopener noreferrer"; a.target = "_blank"; a.appendChild(node); node = a; }
      el.appendChild(node);
    });
    if (spans.length && /\n$/.test(spans[spans.length - 1].t || "")) el.appendChild(h("br", { "data-tail": "" }));
  }
  // Direction of a block: its override, else the first strong letter (so Arabic lists put bullets on the right).
  var RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
  function blockDir(b) {
    if (b.dir) return b.dir;
    var m = /\p{L}/u.exec(P.blockText(b));
    return m && RTL_CHAR.test(m[0]) ? "rtl" : "ltr";
  }
  function setPlain(el, text) {
    el.textContent = text;
    if (!text || /\n$/.test(text)) el.appendChild(h("br", { "data-tail": "" }));
  }

  // ---------- the editor ----------
  function Editor(root, opts) {
    var page = null, B = [], els = {}, hist = {}, selIds = [], slash = null, lastCell = null, drag = null, inline = null, pend = null;
    var ctx = opts.ctx;
    root.tabIndex = -1;

    function idx(id) { for (var k = 0; k < B.length; k++) if (B[k].id === id) return k; return -1; }
    function rowOf(n) { var e = n && (n.nodeType === 1 ? n : n.parentElement); var r = e && e.closest(".pg-b"); return r && root.contains(r) ? r : null; }
    function blockOf(n) { var r = rowOf(n); return r ? B[idx(r.dataset.id)] : null; }
    function sig(b) {
      var extra = "";
      if (b.type === "page") extra = ctx.icon(b.page) + ctx.title(b.page);
      if (b.text) b.text.forEach(function (s) { if (s.p) extra += ctx.icon(s.p) + ctx.title(s.p); });
      return JSON.stringify(b) + extra;
    }

    // ----- building rows -----
    function editable(cls, b, ph) {
      return h("div", { "class": cls, contenteditable: "true", spellcheck: "true", dir: b.dir || "auto", "data-ph": ph || "", role: "textbox", "aria-multiline": "true", "aria-label": ph || "Text" });
    }
    function buildRow(b) {
      var r = h("div", { "class": "pg-b pg-t-" + b.type + (b.type === "todo" && b.checked ? " is-done" : "") + (b.type === "toggle" && b.open ? " is-open" : ""), "data-id": b.id, dir: P.TEXT_TYPES[b.type] ? blockDir(b) : "ltr" });
      r.style.setProperty("--ind", b.indent);
      r.appendChild(h("div", { "class": "pg-gut", contenteditable: "false" }, [
        h("button", { type: "button", "class": "pg-add", tabindex: "-1", title: "Add a block below (Alt+click: above)", "aria-label": "Add block", text: "+" }),
        h("button", { type: "button", "class": "pg-grip", tabindex: "-1", title: "Drag to move · Click for options", "aria-label": "Drag or open block options", text: "⋮⋮" })
      ]));
      var body = h("div", { "class": "pg-body" });
      r.appendChild(body);
      if (P.TEXT_TYPES[b.type]) {
        var ed = editable("pg-text", b, PH[b.type]);
        renderSpans(ed, b.text, ctx);
        ed.classList.toggle("is-empty", !b.text.length);
        if (b.type === "ul") body.appendChild(h("span", { "class": "pg-mk", "aria-hidden": "true", text: BULLETS[b.indent % 3] }));
        if (b.type === "ol") { r._num = h("span", { "class": "pg-mk pg-num", "aria-hidden": "true", text: "1." }); body.appendChild(r._num); }
        if (b.type === "todo") body.appendChild(h("button", { type: "button", "class": "pg-check", role: "checkbox", "aria-checked": String(b.checked), "aria-label": b.checked ? "Mark as not done" : "Mark as done", tabindex: "-1" }));
        if (b.type === "toggle") body.appendChild(h("button", { type: "button", "class": "pg-tog", "aria-expanded": String(b.open), "aria-label": b.open ? "Collapse" : "Expand", tabindex: "-1", text: "▶" }));
        if (b.type === "callout") { body.classList.add("pg-callout", "pg-c-" + b.color); body.appendChild(h("button", { type: "button", "class": "pg-cicon", title: "Change icon", tabindex: "-1", text: b.icon })); }
        body.appendChild(ed);
        if (b.type === "toggle") body.appendChild(h("button", { type: "button", "class": "pg-hollow", tabindex: "-1", text: "Empty toggle. Click to add a block inside." }));
      } else if (b.type === "divider") {
        body.appendChild(h("hr", { "class": "pg-hr" }));
      } else if (b.type === "code") {
        var pre = h("pre", { "class": "pg-pre", contenteditable: "true", spellcheck: "false", dir: "ltr", "aria-label": "Code", role: "textbox", "aria-multiline": "true" });
        setPlain(pre, b.code);
        body.appendChild(h("div", { "class": "pg-code" }, [
          h("div", { "class": "pg-codebar", contenteditable: "false" }, [
            h("input", { "class": "pg-lang", value: b.lang, placeholder: "language", "aria-label": "Code language", maxlength: "24", spellcheck: "false" }),
            h("button", { type: "button", "class": "pg-mini pg-copycode", text: "Copy" })
          ]), pre]));
      } else if (b.type === "table") {
        var tb = h("table", { "class": "pg-table" + (b.header ? " has-head" : "") });
        b.rows.forEach(function (row, ri) {
          var tr = h("tr");
          row.forEach(function (cell, ci) {
            var td = h("td", { contenteditable: "true", dir: "auto", "data-r": ri, "data-c": ci, spellcheck: "true", "aria-label": "Row " + (ri + 1) + ", column " + (ci + 1) });
            setPlain(td, cell);
            tr.appendChild(td);
          });
          tb.appendChild(tr);
        });
        body.appendChild(h("div", { "class": "tbl-wrap pg-tblwrap" }, [tb]));
        body.appendChild(h("div", { "class": "pg-tblbar", contenteditable: "false" }, [
          h("button", { type: "button", "class": "pg-mini", "data-t": "row+", text: "+ Row" }),
          h("button", { type: "button", "class": "pg-mini", "data-t": "col+", text: "+ Column" }),
          h("button", { type: "button", "class": "pg-mini", "data-t": "row-", text: "− Row" }),
          h("button", { type: "button", "class": "pg-mini", "data-t": "col-", text: "− Column" }),
          h("button", { type: "button", "class": "pg-mini", "data-t": "head", "aria-pressed": String(b.header), text: "Header row" })
        ]));
      } else if (b.type === "image") {
        if (b.blob) {
          var img = h("img", { "class": "pg-img", alt: b.caption || "Image", draggable: "false" });
          img.style.width = b.width + "%";
          opts.blobUrl(b.blob).then(function (u) { if (u) img.src = u; else img.replaceWith(h("div", { "class": "pg-imgmissing", text: "Image not found in this browser" })); });
          var cap = editable("pg-cap", b, "Add a caption");
          setPlain(cap, b.caption);
          cap.classList.toggle("is-empty", !b.caption);
          body.appendChild(h("figure", { "class": "pg-fig" }, [img, cap]));
        } else {
          body.appendChild(h("button", { type: "button", "class": "pg-imgpick" }, [h("span", { text: "🖼" }), h("b", { text: "Add an image" }), h("small", { text: "Click to choose, or drop or paste a picture here" })]));
        }
      } else if (b.type === "page") {
        var exists = ctx.exists(b.page);
        body.appendChild(h("button", { type: "button", "class": "pg-plink" + (exists ? "" : " is-gone") }, [
          h("span", { "class": "pg-plink-ic", text: exists ? ctx.icon(b.page) : "⌀" }),
          h("span", { "class": "pg-plink-t", dir: "auto", text: exists ? ctx.title(b.page) : ctx.gone(b.page) })
        ]));
      }
      return r;
    }
    function render() {
      var keep = {}, cursor = root.firstChild;
      B.forEach(function (b) {
        var s = sig(b), el = els[b.id];
        if (!el || el._sig !== s) { var nu = buildRow(b); nu._sig = s; if (el && el.parentNode === root) { if (cursor === el) cursor = nu; root.replaceChild(nu, el); } el = nu; }
        keep[b.id] = el;
        if (el === cursor) cursor = cursor.nextSibling; else root.insertBefore(el, cursor);
      });
      while (cursor) { var nx = cursor.nextSibling; root.removeChild(cursor); cursor = nx; }
      els = keep;
      relayout();
    }
    function relayout() {
      var L = P.layout(B);
      B.forEach(function (b, k) {
        var el = els[b.id];
        if (!el) return;
        el.classList.toggle("is-hidden", !!L.hidden[k]);
        el.classList.toggle("is-sel", selIds.indexOf(b.id) >= 0);
        if (el._num) el._num.textContent = P.olLabel(L.nums[k] || 1, b.indent);
        if (b.type === "toggle") el.classList.toggle("is-hollow", b.open && !(B[k + 1] && B[k + 1].indent > b.indent));
      });
    }
    function rebuild() { els = {}; root.textContent = ""; render(); }

    // ----- focus -----
    function editableOf(el, which) {
      if (!el) return null;
      var list = el.querySelectorAll(".pg-text, .pg-pre, td[contenteditable], .pg-cap");
      return list.length ? list[which === "last" ? list.length - 1 : 0] : null;
    }
    function focus(id, off, off2) {
      var el = els[id];
      if (!el) return;
      openAncestors(idx(id));
      var ed = editableOf(el, off === "end" ? "last" : "first");
      if (!ed) { selectBlocks([id]); return; }
      clearSel();
      ed.focus({ preventScroll: true });
      var o = off === "end" ? measure(ed) : typeof off === "number" ? off : 0;
      setCaret(ed, o, typeof off2 === "number" ? off2 : o);
      scrollIntoView(ed);
    }
    function scrollIntoView(el) {
      var sc = opts.scroller, r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
      if (r.bottom > s.bottom - 40) sc.scrollTop += r.bottom - s.bottom + 80;
      else if (r.top < s.top + 20) sc.scrollTop -= s.top - r.top + 60;
    }
    function openAncestors(i) {
      if (i < 0) return;
      var ind = B[i].indent, changed = false;
      for (var k = i - 1; k >= 0 && ind > 0; k--) {
        if (B[k].indent < ind) { if (B[k].type === "toggle" && !B[k].open) { B[k].open = true; changed = true; } ind = B[k].indent; }
      }
      if (changed) render();
    }
    function visibleNeighbour(i, dir, needEditable) {
      var L = P.layout(B);
      for (var k = i + dir; k >= 0 && k < B.length; k += dir) {
        if (L.hidden[k]) continue;
        if (!needEditable || editableOf(els[B[k].id])) return k;
      }
      return -1;
    }

    // ----- history -----
    function snap() { return JSON.stringify({ title: page.title, icon: page.icon, cover: page.cover, font: page.font, wide: page.wide, blocks: B }); }
    function H() { return hist[page.id] || (hist[page.id] = { u: [], r: [], last: snap(), t: 0, t0: 0, kind: "" }); }
    function caretNow() {
      var a = document.activeElement, b = a && blockOf(a);
      if (!b) return null;
      var c = caretIn(a);
      return { id: b.id, start: c ? c.start : 0 };
    }
    function commit(kind) {
      if (!page) return;
      var st = H(), now = Date.now(), s = snap();
      if (s === st.last) return;
      var group = kind === "type" && st.kind === "type" && now - st.t < 1200 && now - st.t0 < 5000;
      if (!group) { st.u.push({ s: st.last, caret: st.caret }); if (st.u.length > 300) st.u.shift(); st.t0 = now; }
      st.r = []; st.last = s; st.t = now; st.kind = kind; st.caret = caretNow();
      page.updated = now;
      opts.onChange(kind);
    }
    function restore(x, into) {
      var st = H();
      into.push({ s: snap(), caret: caretNow() });
      var o = JSON.parse(x.s);
      page.title = o.title; page.icon = o.icon; page.cover = o.cover; page.font = o.font; page.wide = o.wide;
      page.blocks = B = o.blocks.map(P.cleanBlock);
      st.last = snap(); st.kind = "undo"; st.caret = x.caret;
      page.updated = Date.now();
      rebuild();
      opts.onChange("undo");
      if (x.caret && els[x.caret.id]) focus(x.caret.id, x.caret.start); else root.focus({ preventScroll: true });
    }
    function undo() { var st = H(); if (!st.u.length) { S3.toast("Nothing to undo"); return; } restore(st.u.pop(), st.r); }
    function redo() { var st = H(); if (!st.r.length) { S3.toast("Nothing to redo"); return; } restore(st.r.pop(), st.u); }

    // ----- reading edits back -----
    function sync(ed) {
      var b = blockOf(ed);
      if (!b) return null;
      var r;
      if (ed.classList.contains("pg-text")) {
        r = readSpans(ed);
        b.text = r.spans;
        ed.classList.toggle("is-empty", !b.text.length);
        if (r.foreign) { var c = caretIn(ed); renderSpans(ed, b.text, ctx); if (c) setCaret(ed, c.start, c.end); }
      } else if (ed.classList.contains("pg-pre")) {
        r = readSpans(ed);
        b.code = P.plain(r.spans);
        if (r.foreign) { var c2 = caretIn(ed); setPlain(ed, b.code); if (c2) setCaret(ed, c2.start); }
      } else if (ed.tagName === "TD") {
        r = readSpans(ed);
        b.rows[+ed.dataset.r][+ed.dataset.c] = P.plain(r.spans).slice(0, 5000);
        if (r.foreign) setPlain(ed, b.rows[+ed.dataset.r][+ed.dataset.c]);
      } else if (ed.classList.contains("pg-cap")) {
        r = readSpans(ed);
        b.caption = P.plain(r.spans).replace(/\n/g, " ").slice(0, 1000);
        ed.classList.toggle("is-empty", !b.caption);
        if (r.foreign) setPlain(ed, b.caption);
      } else if (ed.classList.contains("pg-lang")) {
        b.lang = ed.value.replace(/[^\w+#.\- ]/g, "").slice(0, 24);
      }
      var row = els[b.id];
      if (row) { row._sig = sig(b); if (P.TEXT_TYPES[b.type]) { var d = blockDir(b); if (row.dir !== d) row.dir = d; } }
      return b;
    }

    // ----- block operations -----
    function replaceBlock(i, nb) { B[i] = nb; }
    function setType(i, type, props) {
      var nb = P.convert(B[i], type);
      if (props) Object.keys(props).forEach(function (k) { nb[k] = props[k]; });
      replaceBlock(i, nb);
      return nb;
    }
    function insertAfter(i, b) { B.splice(i + 1, 0, b); return i + 1; }
    function ensureTrailingText(i) {
      if (!B[i + 1] || !P.TEXT_TYPES[B[i + 1].type]) insertAfter(i, P.newBlock("p", { indent: B[i].indent }));
      return i + 1;
    }
    function removeBlocks(ids) {
      var first = B.length;
      ids.forEach(function (id) { var k = idx(id); if (k >= 0) { first = Math.min(first, k); B.splice(k, 1); } });
      if (!B.length) B.push(P.newBlock("p"));
      P.fixIndents(B);
      return Math.min(first, B.length - 1);
    }
    function duplicate(ids) {
      var lastNew = null;
      ids.slice().sort(function (a, b) { return idx(a) - idx(b); }).reverse().forEach(function (id) {
        var k = idx(id), end = P.subtreeEnd(B, k);
        var copies = B.slice(k, end).map(function (b) { var c = P.cleanBlock(JSON.parse(JSON.stringify(b))); c.id = P.uid(); return c; });
        Array.prototype.splice.apply(B, [end, 0].concat(copies));
        lastNew = lastNew || copies[0].id;
      });
      commit("dup"); render();
      if (lastNew) focus(lastNew, "end");
    }
    function toggleMarkAt(b, ed, mark) {
      var c = caretIn(ed);
      if (!c) return false;
      if (c.start === c.end) {
        // no selection: the next characters typed get (or lose) the mark
        var on = !(c.start > 0 && P.hasMark(b.text, c.start - 1, c.start, mark));
        if (pend && pend.id === b.id && pend.at === c.start && pend.mark === mark) on = !pend.on;
        pend = { id: b.id, at: c.start, mark: mark, on: on };
        return true;
      }
      b.text = P.toggleMark(b.text, c.start, c.end, mark);
      commit("format"); render(); focus(b.id, c.start, c.end);
      return true;
    }
    // A mark switched on/off with no selection (Ctrl+B then type), or the end of a **bold** shortcut.
    function applyPending(b, ed) {
      if (!pend) return;
      if (pend.id !== b.id) { pend = null; return; }
      var c = caretIn(ed);
      if (!c || c.start !== c.end || c.start < pend.at) { pend = null; return; }
      if (c.start === pend.at) return;
      var nt = P.setMark(b.text, pend.at, c.start, pend.mark, pend.on ? true : null);
      if (JSON.stringify(nt) === JSON.stringify(b.text)) return;
      b.text = nt;
      renderSpans(ed, b.text, ctx);
      var p1 = posAt(ed, c.start, !pend.on), r = document.createRange(), sel = window.getSelection();
      try { r.setStart(p1.node, p1.off); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); } catch (err) { /* gone */ }
      if (els[b.id]) els[b.id]._sig = sig(b);
    }
    function insertTextModel(b, ed, str) {
      var c = caretIn(ed) || { start: 0, end: 0 };
      if (ed.classList.contains("pg-text")) {
        b.text = P.insertText(P.deleteRange(b.text, c.start, c.end), c.start, str);
      } else if (ed.classList.contains("pg-pre")) {
        b.code = b.code.slice(0, c.start) + str + b.code.slice(c.end);
      } else if (ed.tagName === "TD") {
        var v = b.rows[+ed.dataset.r][+ed.dataset.c];
        b.rows[+ed.dataset.r][+ed.dataset.c] = v.slice(0, c.start) + str + v.slice(c.end);
      }
      var cellPos = ed.tagName === "TD" ? [ed.dataset.r, ed.dataset.c] : null;
      commit("type"); render();
      var row = els[b.id], target = cellPos ? row.querySelector('td[data-r="' + cellPos[0] + '"][data-c="' + cellPos[1] + '"]') : editableOf(row, ed.classList.contains("pg-pre") ? "first" : "first");
      if (target) { target.focus({ preventScroll: true }); setCaret(target, c.start + str.length); }
    }
    function enter(ed, b) {
      var i = idx(b.id), c = caretIn(ed) || { start: 0, end: 0 }, text = P.plain(b.text), m;
      if (b.type === "p" && (m = /^```([\w+#.-]{0,24})$/.exec(text))) {
        var nb = setType(i, "code", { lang: m[1], code: "" });
        commit("turn"); render(); focus(nb.id, 0); return;
      }
      if (!text.length && /^(ul|ol|todo|toggle|quote|callout)$/.test(b.type)) {
        if (b.indent > 0 && b.type !== "quote" && b.type !== "callout") P.outdentBlock(B, i); else setType(i, "p");
        commit("turn"); render(); focus(b.id, 0); return;
      }
      b.text = P.deleteRange(b.text, c.start, c.end);
      var j = P.splitBlock(B, i, c.start);
      commit("split"); render();
      focus(B[j].id, 0);
    }
    function backspaceAtStart(ed, b) {
      var i = idx(b.id);
      if (b.type !== "p") { setType(i, "p"); commit("turn"); render(); focus(b.id, 0); return; }
      if (b.indent > 0) { P.outdentBlock(B, i); commit("indent"); render(); focus(b.id, 0); return; }
      if (i === 0) return;
      var pk = visibleNeighbour(i, -1, false);
      if (pk < 0) return;
      var prev = B[pk];
      if (!P.len(b.text) && B.length > 1) {
        B.splice(i, 1); P.fixIndents(B); commit("delete"); render();
        if (editableOf(els[prev.id])) focus(prev.id, "end"); else selectBlocks([prev.id]);
        return;
      }
      if (!P.TEXT_TYPES[prev.type]) { selectBlocks([prev.id]); return; }
      if (pk !== i - 1) { // previous visible block is a collapsed toggle: merge into it
        var off = P.len(prev.text);
        prev.text = P.concat(prev.text, b.text); B.splice(i, 1); P.fixIndents(B); commit("merge"); render(); focus(prev.id, off); return;
      }
      var r = P.mergeUp(B, i);
      if (!r) return;
      commit("merge"); render();
      focus(B[r.index].id, r.noMerge ? "end" : r.offset);
    }
    function deleteAtEnd(ed, b) {
      var i = idx(b.id), next = B[i + 1];
      if (!next) return;
      if (!P.TEXT_TYPES[next.type]) { selectBlocks([next.id]); return; }
      var r = P.mergeUp(B, i + 1);
      commit("merge"); render(); focus(b.id, r.offset);
    }
    function onFirstLine(ed) {
      var c = caretIn(ed);
      if (!c || c.start === 0) return true;
      var rr = window.getSelection().getRangeAt(0).getClientRects()[0], er = ed.getBoundingClientRect();
      if (!rr) return c.start === 0;
      var lh = parseFloat(getComputedStyle(ed).lineHeight) || 24;
      return rr.top - er.top < lh * 0.8;
    }
    function onLastLine(ed) {
      var c = caretIn(ed);
      if (!c) return true;
      if (c.end >= measure(ed)) return true;
      var rs = window.getSelection().getRangeAt(0).getClientRects(), rr = rs[rs.length - 1], er = ed.getBoundingClientRect();
      if (!rr) return false;
      var lh = parseFloat(getComputedStyle(ed).lineHeight) || 24;
      return er.bottom - rr.bottom < lh * 0.8;
    }
    function jump(ed, b, dir) {
      var i = idx(b.id), k = visibleNeighbour(i, dir, true);
      if (k < 0) { if (dir > 0 && P.TEXT_TYPES[b.type]) return false; if (dir > 0) { var j = insertAfter(B.length - 1, P.newBlock("p")); commit("insert"); render(); focus(B[j].id, 0); return true; } return false; }
      var x = null, sel = window.getSelection();
      if (sel.rangeCount) { var rr = sel.getRangeAt(0).getClientRects()[0]; if (rr) x = rr.left; }
      var target = editableOf(els[B[k].id], dir < 0 ? "last" : "first");
      target.focus({ preventScroll: true });
      var tr = target.getBoundingClientRect(), placed = false;
      if (x != null && document.caretRangeFromPoint) {
        var y = dir < 0 ? tr.bottom - 6 : tr.top + 6, cr = document.caretRangeFromPoint(Math.min(Math.max(x, tr.left + 1), tr.right - 1), y);
        if (cr && target.contains(cr.startContainer)) { sel.removeAllRanges(); sel.addRange(cr); placed = true; }
      }
      if (!placed) setCaret(target, dir < 0 ? measure(target) : 0);
      scrollIntoView(target);
      return true;
    }

    // ----- slash menu -----
    var slashEl = h("div", { "class": "pg-menu pg-slash", role: "listbox", "aria-label": "Insert block" }), slashItems = [], slashActive = 0;
    function openSlash(b, at) { slash = { id: b.id, from: at }; updateSlash(); }
    function closeSlash() { slash = null; slashEl.remove(); }
    function updateSlash() {
      if (!slash) return;
      var b = B[idx(slash.id)], ed = b && editableOf(els[b.id]);
      var c = ed && caretIn(ed);
      if (!b || !c || c.start <= slash.from || P.plain(b.text)[slash.from] !== "/") { closeSlash(); return; }
      var q = P.plain(b.text).slice(slash.from + 1, c.start);
      if (q.length > 24 || /\s\s|\n/.test(q)) { closeSlash(); return; }
      slashItems = P.slashFilter(q);
      if (!slashItems.length && q.length > 2) { closeSlash(); return; }
      slashActive = Math.min(slashActive, Math.max(0, slashItems.length - 1));
      slashEl.textContent = "";
      slashEl.appendChild(h("div", { "class": "pg-menu-sec", text: slashItems.length ? (q ? "Blocks matching “" + q + "”" : "Basic blocks") : "No results" }));
      slashItems.forEach(function (it, k) {
        var btn = h("button", { type: "button", "class": "pg-menu-it" + (k === slashActive ? " is-active" : ""), role: "option", "aria-selected": String(k === slashActive), "data-k": k }, [
          h("span", { "class": "pg-menu-ic big", text: SLASH_ICON[it.id] || "·" }),
          h("span", { "class": "pg-menu-lb" }, [h("span", { text: it.label }), h("small", { text: it.hint })])
        ]);
        slashEl.appendChild(btn);
      });
      var rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height && !rect.top)) rect = ed.getBoundingClientRect();
      PUI.place(slashEl, rect);
      var act = slashEl.querySelector(".is-active");
      if (act) act.scrollIntoView({ block: "nearest" });
    }
    slashEl.addEventListener("pointerdown", function (e) { e.preventDefault(); });
    slashEl.addEventListener("click", function (e) { var b = e.target.closest("[data-k]"); if (b) runSlash(slashItems[+b.dataset.k]); });
    function slashKey(e) {
      if (!slash) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); slashActive = (slashActive + (e.key === "ArrowDown" ? 1 : -1) + slashItems.length) % Math.max(1, slashItems.length); updateSlash(); return true; }
      if ((e.key === "Enter" || e.key === "Tab") && slashItems.length) { e.preventDefault(); runSlash(slashItems[slashActive]); return true; }
      if (e.key === "Escape") { e.preventDefault(); closeSlash(); return true; }
      return false;
    }
    function runSlash(cmd) {
      if (!slash || !cmd) return;
      var b = B[idx(slash.id)], ed = editableOf(els[b.id]), c = caretIn(ed) || { start: slash.from + 1 }, from = slash.from, to = c.start;
      closeSlash();
      var i = idx(b.id);
      if (cmd.id === "mention" || cmd.id === "date") {
        b.text = P.deleteRange(b.text, from, to);
        if (cmd.id === "date") {
          var d = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
          b.text = P.insertText(b.text, from, d);
          commit("insert"); render(); focus(b.id, from + d.length); return;
        }
        commit("insert"); render(); focus(b.id, from);
        opts.pickPage("Mention a page", null, function (pid) { insertMention(b.id, from, pid); });
        return;
      }
      if (cmd.id === "newpage" || cmd.id === "pagelink") {
        var make = function (pid) {
          var k = idx(b.id);
          if (k < 0) return;
          var j = P.applySlash(B, k, from, to, "page");
          B[j].page = pid;
          ensureTrailingText(j);
          commit("insert"); render();
          return j;
        };
        if (cmd.id === "newpage") { var pid = opts.createChild(); make(pid); opts.openPage(pid, true); }
        else opts.pickPage("Link to a page", function (p) { return p.id !== page.id; }, function (pid2) { var j = make(pid2); if (j != null) focus(B[j + 1].id, 0); });
        return;
      }
      var type = cmd.id, j = P.applySlash(B, i, from, to, type);
      var nb = B[j];
      if (type === "divider") { var t = ensureTrailingText(j); commit("insert"); render(); focus(B[t].id, 0); return; }
      commit("insert"); render();
      if (type === "image") { pickImage(nb.id); return; }
      if (type === "table") { var td = els[nb.id].querySelector("td"); td.focus(); setCaret(td, 0); return; }
      focus(nb.id, 0);
    }
    function insertMention(bid, at, pid) {
      var k = idx(bid);
      if (k < 0 || !pid) return;
      var b = B[k];
      b.text = P.insertSpans(b.text, at, [{ t: "@", p: pid }, { t: " " }]);
      commit("insert"); render(); focus(b.id, at + 2);
    }

    // ----- inline toolbar -----
    var bar = h("div", { "class": "pg-inline", role: "toolbar", "aria-label": "Text formatting" });
    [["b", "B", "Bold (Ctrl+B)"], ["i", "I", "Italic (Ctrl+I)"], ["u", "U", "Underline (Ctrl+U)"], ["s", "S", "Strikethrough (Ctrl+Shift+S)"], ["c", "</>", "Inline code (Ctrl+E)"], ["h", "A", "Highlight (Ctrl+Shift+H)"], ["a", "🔗", "Link (Ctrl+K)"]]
      .forEach(function (x) { bar.appendChild(h("button", { type: "button", "class": "pg-ib pg-ib-" + x[0], "data-m": x[0], title: x[2], "aria-label": x[2], text: x[1] })); });
    var linkBox = h("div", { "class": "pg-linkbox", hidden: true }, [
      h("input", { "class": "input", type: "text", placeholder: "Paste or type a link…", "aria-label": "Link address", spellcheck: "false" }),
      h("button", { type: "button", "class": "btn small primary", "data-act": "apply", text: "Link" }),
      h("button", { type: "button", "class": "btn small ghost", "data-act": "remove", text: "Remove" })
    ]);
    bar.appendChild(linkBox);
    function selInfo() {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
      var ed = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
      ed = ed && ed.closest(".pg-text");
      if (!ed || !root.contains(ed) || !ed.contains(sel.focusNode)) return null;
      var c = caretIn(ed);
      if (!c || c.start === c.end) return null;
      return { ed: ed, b: blockOf(ed), start: c.start, end: c.end, rect: sel.getRangeAt(0).getBoundingClientRect() };
    }
    function showBar(info) {
      inline = info;
      linkBox.hidden = true;
      Array.prototype.forEach.call(bar.querySelectorAll(".pg-ib"), function (btn) {
        btn.classList.toggle("on", P.hasMark(info.b.text, info.start, info.end, btn.dataset.m));
      });
      if (!bar.parentNode) document.body.appendChild(bar);
      var w = bar.offsetWidth, x = Math.min(Math.max(8, info.rect.left + info.rect.width / 2 - w / 2), window.innerWidth - w - 8);
      var y = info.rect.top - bar.offsetHeight - 8;
      if (y < 8) y = info.rect.bottom + 8;
      bar.style.left = Math.round(x) + "px"; bar.style.top = Math.round(y) + "px";
    }
    function hideBar() { if (bar.parentNode && !bar.contains(document.activeElement)) { bar.remove(); inline = null; } }
    function openLink(info) {
      showBar(info);
      linkBox.hidden = false;
      var cur = P.slice(info.b.text, info.start, info.end).filter(function (s) { return s.a; })[0];
      var inp = linkBox.querySelector("input");
      inp.value = cur ? cur.a : "";
      inp.focus(); inp.select();
    }
    function applyLink(remove) {
      if (!inline) return;
      var info = inline, inp = linkBox.querySelector("input"), raw = inp.value.trim();
      var url = remove || !raw ? null : P.safeUrl(raw);
      if (!remove && raw && !url) { S3.toast("Only web (https), email and phone links are allowed", "error"); return; }
      info.b.text = P.setMark(info.b.text, info.start, info.end, "a", url);
      bar.remove(); inline = null;
      commit("format"); render(); focus(info.b.id, info.start, info.end);
    }
    bar.addEventListener("pointerdown", function (e) { if (!e.target.closest(".pg-linkbox")) e.preventDefault(); });
    bar.addEventListener("click", function (e) {
      var btn = e.target.closest(".pg-ib");
      if (btn && inline) {
        if (btn.dataset.m === "a") { openLink(inline); return; }
        var info = inline;
        info.b.text = P.toggleMark(info.b.text, info.start, info.end, btn.dataset.m);
        commit("format"); render(); focus(info.b.id, info.start, info.end);
        var again = selInfo(); if (again) showBar(again);
        return;
      }
      var act = e.target.closest("[data-act]");
      if (act) applyLink(act.dataset.act === "remove");
    });
    linkBox.querySelector("input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); applyLink(false); }
      if (e.key === "Escape") { e.preventDefault(); var info = inline; bar.remove(); inline = null; if (info) focus(info.b.id, info.start, info.end); }
    });
    document.addEventListener("selectionchange", function () {
      if (drag) return;
      var info = selInfo();
      if (info) showBar(info); else hideBar();
    });

    // ----- block selection mode -----
    function selectBlocks(ids) {
      closeSlash();
      selIds = ids.slice();
      if (document.activeElement && root.contains(document.activeElement) && document.activeElement !== root) document.activeElement.blur();
      root.focus({ preventScroll: true });
      var sel = window.getSelection(); if (sel) sel.removeAllRanges();
      relayout();
      if (ids.length && els[ids[ids.length - 1]]) scrollIntoView(els[ids[ids.length - 1]]);
    }
    function clearSel() { if (selIds.length) { selIds = []; relayout(); } }
    function selectedInOrder() { return selIds.map(idx).filter(function (k) { return k >= 0; }).sort(function (a, b) { return a - b; }); }
    function blocksMd(list) { return P.pageToMd({ title: "x", icon: "", blocks: list }, opts.mdCtx()).split("\n").slice(2).join("\n").trim(); }
    function selectionKeys(e) {
      var ks = selectedInOrder(), mod = e.ctrlKey || e.metaKey;
      if (!ks.length) return;
      var first = ks[0], last = ks[ks.length - 1];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        var dir = e.key === "ArrowDown" ? 1 : -1;
        if (mod && e.shiftKey) { var j = dir < 0 ? P.moveUp(B, first) : P.moveDown(B, first); if (j >= 0) { commit("move"); render(); } return; }
        var n = visibleNeighbour(dir > 0 ? last : first, dir, false);
        if (n < 0) return;
        if (e.shiftKey) selectBlocks(selIds.concat([B[n].id])); else selectBlocks([B[n].id]);
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); focus(B[first].id, "end"); return; }
      if (e.key === "Escape") { e.preventDefault(); clearSel(); return; }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        var at = removeBlocks(selIds); selIds = [];
        commit("delete"); render();
        var tgt = B[Math.max(0, at - 1)];
        if (tgt) { if (editableOf(els[tgt.id])) focus(tgt.id, "end"); else selectBlocks([tgt.id]); }
        return;
      }
      if (e.key === "Tab") { e.preventDefault(); ks.forEach(function (k) { if (e.shiftKey) P.outdentBlock(B, k); else P.indentBlock(B, k); }); commit("indent"); render(); return; }
      if (mod && (e.key === "c" || e.key === "x")) {
        e.preventDefault();
        var list = []; ks.forEach(function (k) { list.push(B[k]); });
        S3.copy(blocksMd(list), list.length + (list.length === 1 ? " block" : " blocks") + " copied as Markdown");
        if (e.key === "x") { removeBlocks(selIds); selIds = []; commit("delete"); render(); }
        return;
      }
      if (mod && e.key === "d") { e.preventDefault(); duplicate(selIds); return; }
      if (mod && e.key === "a") { e.preventDefault(); selectBlocks(B.map(function (b) { return b.id; })); }
    }

    // ----- block menu (click on the grip) -----
    function blockMenu(id, anchor) {
      var i = idx(id);
      if (i < 0) return;
      var b = B[i];
      selectBlocks([id]);
      var items = [{ section: "Turn into" }];
      TURN.forEach(function (t) {
        items.push({ label: t[1], icon: t[2], checked: b.type === t[0], onClick: function () { var k = idx(id), nb = setType(k, t[0]); commit("turn"); render(); focus(nb.id, "end"); } });
      });
      if (b.type === "callout") {
        items.push({ section: "Colour" });
        P.CALLOUT_COLORS.forEach(function (c) { items.push({ label: c[0].toUpperCase() + c.slice(1), icon: "●", checked: b.color === c, onClick: function () { b.color = c; commit("style"); render(); } }); });
      }
      if (b.type === "image" && b.blob) {
        items.push({ section: "Width" });
        [[25, "Small"], [50, "Half"], [75, "Large"], [100, "Full"]].forEach(function (w) { items.push({ label: w[1], icon: w[0] + "%", checked: b.width === w[0], onClick: function () { b.width = w[0]; commit("style"); render(); } }); });
        items.push({ label: "Replace image…", icon: "🖼", onClick: function () { pickImage(id); } });
        items.push({ label: "Download image", icon: "⬇", onClick: function () { opts.downloadBlob(b.blob, b.caption); } });
      }
      items.push({ section: "Text direction" });
      [["", "Auto (follows the text)"], ["rtl", "Right to left"], ["ltr", "Left to right"]].forEach(function (d) {
        items.push({ label: d[1], icon: d[0] === "rtl" ? "⇠" : d[0] === "ltr" ? "⇢" : "⇄", checked: b.dir === d[0], onClick: function () { b.dir = d[0]; commit("style"); render(); } });
      });
      items.push({ sep: true });
      items.push({ label: "Duplicate", icon: "⧉", kbd: "Ctrl+D", onClick: function () { duplicate([id]); } });
      items.push({ label: "Copy as Markdown", icon: "⎘", onClick: function () { var k = idx(id); S3.copy(blocksMd(B.slice(k, P.subtreeEnd(B, k))), "Copied as Markdown"); } });
      items.push({ label: "Move up", icon: "↑", kbd: "Ctrl+Shift+↑", onClick: function () { if (P.moveUp(B, idx(id)) >= 0) { commit("move"); render(); selectBlocks([id]); } } });
      items.push({ label: "Move down", icon: "↓", kbd: "Ctrl+Shift+↓", onClick: function () { if (P.moveDown(B, idx(id)) >= 0) { commit("move"); render(); selectBlocks([id]); } } });
      items.push({ label: "Delete", icon: "🗑", kbd: "Del", danger: true, onClick: function () { var at = removeBlocks([id]); selIds = []; commit("delete"); render(); var t = B[Math.max(0, at - 1)]; if (t && editableOf(els[t.id])) focus(t.id, "end"); } });
      PUI.menu(anchor, items, { cls: "pg-bmenu", restore: root });
    }

    // ----- images -----
    function pickImage(id) {
      var inp = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp", hidden: true });
      inp.addEventListener("change", function () {
        var f = inp.files[0]; inp.remove();
        if (!f) return;
        opts.addImage(f).then(function (bid) {
          var k = idx(id);
          if (!bid || k < 0) return;
          if (B[k].type !== "image") B[k] = P.convert(B[k], "image");
          B[k].blob = bid;
          if (!B[k].caption) B[k].caption = "";
          ensureTrailingText(k);
          commit("image"); render();
        });
      });
      document.body.appendChild(inp);
      inp.click();
    }
    function insertImages(files, at) {
      var list = Array.prototype.slice.call(files || []).filter(function (f) { return P.IMAGE_TYPES[f.type]; });
      if (!list.length) { S3.toast("Use a PNG, JPEG, GIF, WebP, AVIF or BMP image", "error"); return Promise.resolve(); }
      if (at == null || at < 0) at = B.length - 1;
      return list.reduce(function (pr, f) {
        return pr.then(function () {
          return opts.addImage(f).then(function (bid) {
            if (!bid) return;
            var nb = P.newBlock("image", { blob: bid, indent: B[at] ? B[at].indent : 0 });
            if (B[at] && P.TEXT_TYPES[B[at].type] && !P.len(B[at].text) && B[at].type === "p") B[at] = Object.assign(nb, { id: B[at].id });
            else { at = insertAfter(at, nb); }
          });
        });
      }, Promise.resolve()).then(function () { ensureTrailingText(at); commit("image"); render(); });
    }

    // ----- events -----
    root.addEventListener("input", function (e) {
      var ed = e.target.closest("[contenteditable=true], .pg-lang");
      if (!ed || !root.contains(ed)) return;
      var b = sync(ed);
      if (!b) return;
      if (ed.classList.contains("pg-text") && !e.isComposing) { applyPending(b, ed); afterTyping(b, ed, e); }
      commit("type");
    });
    function afterTyping(b, ed, e) {
      var c = caretIn(ed);
      if (!c || c.start !== c.end) return;
      var text = P.plain(b.text), i = idx(b.id);
      if (b.type === "p") {
        var hit = P.mdShortcut(text.slice(0, c.start));
        if (hit && (hit.type !== "divider" || text.length === 3)) {
          b.text = P.deleteRange(b.text, 0, c.start);
          var rest = P.plain(b.text);
          var nb = setType(i, hit.type, hit.props);
          if (hit.type === "code") nb.code = rest;
          if (hit.type === "divider") { var t = ensureTrailingText(i); if (rest) B[t].text = P.concat(b.text, B[t].text); commit("turn"); render(); focus(B[t].id, 0); return; }
          commit("turn"); render(); focus(nb.id, 0);
          return;
        }
      }
      if (e.data && /[*`~=_]$/.test(e.data)) {
        var hit2 = P.inlineShortcut(text, c.start);
        if (hit2) { b.text = P.applyInline(b.text, hit2); commit("format"); render(); focus(b.id, c.start - 2 * hit2.size); pend = { id: b.id, at: c.start - 2 * hit2.size, mark: hit2.mark, on: false }; return; }
      }
      if (e.data === "/" && (c.start === 1 || /\s/.test(text[c.start - 2]))) { slashActive = 0; openSlash(b, c.start - 1); return; }
      if (e.data === "[" && text.slice(c.start - 2, c.start) === "[[") {
        var at = c.start - 2, bid = b.id;
        opts.pickPage("Mention a page", null, function (pid) {
          var k = idx(bid); if (k < 0) return;
          if (P.plain(B[k].text).slice(at, at + 2) === "[[") B[k].text = P.deleteRange(B[k].text, at, at + 2);
          insertMention(bid, at, pid);
        });
        return;
      }
      if (slash) updateSlash();
    }
    root.addEventListener("beforeinput", function (e) {
      var t = e.inputType, ed = e.target.closest && e.target.closest("[contenteditable=true]"), b = ed && blockOf(ed);
      if (/^format/.test(t)) {
        e.preventDefault();
        var map = { formatBold: "b", formatItalic: "i", formatUnderline: "u", formatStrikeThrough: "s" };
        if (b && map[t] && ed.classList.contains("pg-text")) toggleMarkAt(b, ed, map[t]);
        return;
      }
      if (t === "historyUndo") { e.preventDefault(); undo(); return; }
      if (t === "historyRedo") { e.preventDefault(); redo(); return; }
      if (t === "insertFromDrop" || t === "deleteByDrag") { e.preventDefault(); return; }
      if (!b) return;
      // Mobile keyboards send these without a usable keydown.
      if (t === "insertParagraph" || t === "insertLineBreak") {
        e.preventDefault();
        if (ed.classList.contains("pg-text") && t === "insertParagraph") enter(ed, b);
        else if (ed.classList.contains("pg-cap")) { var k = idx(b.id), j = insertAfter(k, P.newBlock("p", { indent: b.indent })); commit("insert"); render(); focus(B[j].id, 0); }
        else insertTextModel(b, ed, "\n");
        return;
      }
      if (t === "deleteContentBackward" && ed.classList.contains("pg-text")) {
        var c = caretIn(ed);
        if (c && c.start === 0 && c.end === 0) { e.preventDefault(); backspaceAtStart(ed, b); }
      }
    });
    root.addEventListener("keydown", function (e) {
      var mod = e.ctrlKey || e.metaKey, key = e.key, low = key.length === 1 ? key.toLowerCase() : key;
      if (mod && !e.altKey && low === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && !e.altKey && low === "y") { e.preventDefault(); redo(); return; }
      if (e.target === root) { selectionKeys(e); return; }
      if (slashKey(e)) return;
      if (pend && (key.length > 1 && key !== "Shift" && key !== "Control" && key !== "Meta" && key !== "Alt")) pend = null;
      if (e.target.classList.contains("pg-lang")) { if (key === "Enter" || key === "Escape") { e.preventDefault(); var bb = blockOf(e.target); if (bb) focus(bb.id, 0); } return; }
      var ed = e.target.closest("[contenteditable=true]");
      if (!ed || e.isComposing || e.keyCode === 229) return;
      var b = blockOf(ed);
      if (!b) return;
      var i = idx(b.id), isText = ed.classList.contains("pg-text"), isCode = ed.classList.contains("pg-pre"), isCell = ed.tagName === "TD", isCap = ed.classList.contains("pg-cap");
      if (key === "Escape") { e.preventDefault(); closeSlash(); bar.remove(); selectBlocks([b.id]); return; }
      if (mod && e.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) {
        e.preventDefault();
        var c0 = caretIn(ed), j0 = key === "ArrowUp" ? P.moveUp(B, i) : P.moveDown(B, i);
        if (j0 >= 0) { commit("move"); render(); focus(b.id, c0 ? c0.start : 0); }
        return;
      }
      if (mod && !e.shiftKey && low === "d") { e.preventDefault(); duplicate([b.id]); return; }
      if (mod && e.altKey && /^Digit[0-9]$/.test(e.code || "")) {
        var map = { 0: "p", 1: "h1", 2: "h2", 3: "h3", 4: "todo", 5: "ul", 6: "ol", 7: "toggle", 8: "code", 9: "quote" }, to = map[e.code.slice(5)];
        e.preventDefault(); var nb = setType(i, to); commit("turn"); render(); focus(nb.id, "end"); return;
      }
      if (isText) {
        if (mod && !e.altKey) {
          var mk = !e.shiftKey ? { b: "b", i: "i", u: "u", e: "c" }[low] : { s: "s", x: "s", h: "h" }[low];
          if (mk) { e.preventDefault(); toggleMarkAt(b, ed, mk); return; }
          if (low === "k") { var info = selInfo(); if (info) { e.preventDefault(); e.stopPropagation(); openLink(info); } return; }
        }
        var c = caretIn(ed) || { start: 0, end: 0 };
        if (key === "Enter" && !e.shiftKey) { e.preventDefault(); enter(ed, b); return; }
        if (key === "Enter" && e.shiftKey) { e.preventDefault(); insertTextModel(b, ed, "\n"); return; }
        if (key === "Backspace" && c.start === 0 && c.end === 0) { e.preventDefault(); backspaceAtStart(ed, b); return; }
        if (key === "Delete" && c.start === c.end && c.end >= P.len(b.text)) { e.preventDefault(); deleteAtEnd(ed, b); return; }
        if (key === "Tab") { e.preventDefault(); if (e.shiftKey ? P.outdentBlock(B, i) : P.indentBlock(B, i)) { commit("indent"); render(); focus(b.id, c.start, c.end); } return; }
      }
      if (isCode) {
        if (key === "Tab") { e.preventDefault(); insertTextModel(b, ed, "  "); return; }
        if (key === "Enter" && mod) { e.preventDefault(); var t1 = ensureTrailingText(i); commit("insert"); render(); focus(B[t1].id, 0); return; }
        if (key === "Enter") { e.preventDefault(); insertTextModel(b, ed, "\n"); return; }
        if (key === "Backspace" && !b.code) { e.preventDefault(); setType(i, "p"); commit("turn"); render(); focus(b.id, 0); return; }
      }
      if (isCell) {
        var r = +ed.dataset.r, cc = +ed.dataset.c, rows = b.rows.length, cols = b.rows[0].length;
        if (key === "Tab") {
          e.preventDefault();
          var n = r * cols + cc + (e.shiftKey ? -1 : 1);
          if (n >= rows * cols) { b.rows.push(b.rows[0].map(function () { return ""; })); commit("table"); render(); }
          if (n < 0) return;
          focusCell(b.id, Math.floor(n / cols), n % cols); return;
        }
        if (key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (r + 1 >= rows) { b.rows.push(b.rows[0].map(function () { return ""; })); commit("table"); render(); }
          focusCell(b.id, r + 1, cc); return;
        }
        if (key === "Enter" && e.shiftKey) { e.preventDefault(); insertTextModel(b, ed, "\n"); return; }
        if (key === "ArrowUp" && r > 0 && onFirstLine(ed)) { e.preventDefault(); focusCell(b.id, r - 1, cc); return; }
        if (key === "ArrowDown" && r + 1 < rows && onLastLine(ed)) { e.preventDefault(); focusCell(b.id, r + 1, cc); return; }
      }
      if (isCap && key === "Enter") { e.preventDefault(); var j2 = insertAfter(i, P.newBlock("p", { indent: b.indent })); commit("insert"); render(); focus(B[j2].id, 0); return; }
      if (!e.shiftKey && !mod && !e.altKey) {
        if (key === "ArrowUp" && onFirstLine(ed)) { if (jump(ed, b, -1)) e.preventDefault(); return; }
        if (key === "ArrowDown" && onLastLine(ed)) { if (jump(ed, b, 1)) e.preventDefault(); return; }
        var rtl = getComputedStyle(ed).direction === "rtl", cc2 = caretIn(ed);
        if (cc2 && cc2.start === cc2.end) {
          var back = rtl ? "ArrowRight" : "ArrowLeft", fwd = rtl ? "ArrowLeft" : "ArrowRight";
          if (key === back && cc2.start === 0) { var pk = visibleNeighbour(i, -1, true); if (pk >= 0) { e.preventDefault(); focus(B[pk].id, "end"); } return; }
          if (key === fwd && cc2.end >= measure(ed)) { var nk = visibleNeighbour(i, 1, true); if (nk >= 0) { e.preventDefault(); focus(B[nk].id, 0); } return; }
        }
      }
    });
    function focusCell(id, r, c) {
      var td = els[id] && els[id].querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
      if (td) { td.focus(); setCaret(td, measure(td)); lastCell = { id: id, r: r, c: c }; }
    }
    root.addEventListener("pointerdown", function () { pend = null; }, true);
    root.addEventListener("focusin", function (e) {
      if (e.target === root) return;
      if (selIds.length) clearSel();
      if (e.target.tagName === "TD") { var b = blockOf(e.target); if (b) lastCell = { id: b.id, r: +e.target.dataset.r, c: +e.target.dataset.c }; }
    });
    root.addEventListener("focusout", function (e) { if (slash && !root.contains(e.relatedTarget)) closeSlash(); });
    root.addEventListener("paste", function (e) {
      var ed = e.target.closest && e.target.closest("[contenteditable=true]");
      if (!ed || !root.contains(ed)) return;
      e.preventDefault();
      var cd = e.clipboardData, b = blockOf(ed);
      if (!cd || !b) return;
      var files = Array.prototype.slice.call(cd.files || []).filter(function (f) { return /^image\//.test(f.type); });
      if (files.length) { insertImages(files, idx(b.id)); return; }
      var text = (cd.getData("text/plain") || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
      if (!text) return;
      if (!ed.classList.contains("pg-text")) {
        if (ed.classList.contains("pg-cap")) text = text.replace(/\n+/g, " ");
        insertTextModel(b, ed, text.slice(0, 200000));
        return;
      }
      var c = caretIn(ed) || { start: 0, end: 0 }, one = text.replace(/\n+$/, "");
      if (one.indexOf("\n") < 0) {
        if (c.start !== c.end && /^(https?:\/\/|mailto:|tel:)\S+$/i.test(one.trim()) && P.safeUrl(one.trim())) {
          b.text = P.setMark(b.text, c.start, c.end, "a", P.safeUrl(one.trim())); commit("format"); render(); focus(b.id, c.end); return;
        }
        insertTextModel(b, ed, one);
        return;
      }
      // several lines: read them as Markdown and turn them into blocks
      var i = idx(b.id), parsed = P.unresolvedImages(P.mdToPage(text.slice(0, 2000000), { noTitle: true }).blocks).map(P.cleanBlock);
      parsed.forEach(function (x) { x.indent = Math.min(P.MAX_INDENT, x.indent + b.indent); });
      b.text = P.deleteRange(b.text, c.start, c.end);
      var right = P.slice(b.text, c.start);
      b.text = P.slice(b.text, 0, c.start);
      var at = i;
      if (!P.len(b.text) && b.type === "p") { B.splice(i, 1); at = i - 1; }
      Array.prototype.splice.apply(B, [at + 1, 0].concat(parsed));
      var lastIdx = at + parsed.length, lastB = B[lastIdx], off = P.TEXT_TYPES[lastB.type] ? P.len(lastB.text) : 0;
      if (right.length) { if (P.TEXT_TYPES[lastB.type]) lastB.text = P.concat(lastB.text, right); else insertAfter(lastIdx, P.newBlock("p", { text: right, indent: b.indent })); }
      P.fixIndents(B);
      commit("paste"); render();
      if (P.TEXT_TYPES[lastB.type]) focus(lastB.id, off); else focus(lastB.id, "end");
    });
    root.addEventListener("dragover", function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; root.classList.add("is-drop"); }
    });
    root.addEventListener("dragleave", function (e) { if (!root.contains(e.relatedTarget)) root.classList.remove("is-drop"); });
    root.addEventListener("drop", function (e) {
      e.preventDefault();
      root.classList.remove("is-drop");
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      var row = rowOf(e.target), at = row ? idx(row.dataset.id) : B.length - 1;
      if (row && B[at].type === "image" && !B[at].blob) {
        opts.addImage(files[0]).then(function (bid) { if (bid) { B[at].blob = bid; ensureTrailingText(at); commit("image"); render(); } });
        return;
      }
      insertImages(files, at);
    });
    root.addEventListener("click", function (e) {
      var t = e.target, row = rowOf(t);
      if (!row) return;
      var b = B[idx(row.dataset.id)];
      if (!b) return;
      if (t.closest(".pg-check")) { b.checked = !b.checked; commit("check"); render(); return; }
      if (t.closest(".pg-tog")) { b.open = !b.open; commit("toggle"); render(); return; }
      if (t.closest(".pg-hollow")) { var j = insertAfter(idx(b.id), P.newBlock("p", { indent: b.indent + 1 })); commit("insert"); render(); focus(B[j].id, 0); return; }
      if (t.closest(".pg-add")) {
        var k = idx(b.id), nb = P.newBlock("p", { indent: b.indent });
        if (e.altKey) B.splice(k, 0, nb); else B.splice(P.subtreeEnd(B, k), 0, nb);
        commit("insert"); render(); focus(nb.id, 0);
        var ed = editableOf(els[nb.id]);
        if (ed) { nb.text = [{ t: "/" }]; renderSpans(ed, nb.text, ctx); ed.classList.remove("is-empty"); setCaret(ed, 1); slashActive = 0; openSlash(nb, 0); }
        return;
      }
      if (t.closest(".pg-cicon")) { opts.pickEmoji(t.closest(".pg-cicon"), function (em) { if (em) { b.icon = em; commit("style"); render(); } }); return; }
      if (t.closest(".pg-imgpick")) { pickImage(b.id); return; }
      if (t.closest(".pg-plink")) { if (ctx.exists(b.page)) opts.openPage(b.page); else S3.toast("That page is in the trash or was deleted", "error"); return; }
      if (t.closest(".pg-copycode")) { S3.copy(b.code, "Code copied"); return; }
      var tb = t.closest(".pg-tblbar [data-t]");
      if (tb) { tableAction(b, tb.dataset.t); return; }
      var men = t.closest(".pg-mention");
      if (men) { var pid = men.getAttribute("data-page"); if (ctx.exists(pid)) opts.openPage(pid); else S3.toast("That page is in the trash or was deleted", "error"); return; }
      var a = t.closest("a[href]");
      if (a && row.contains(a)) {
        var url = P.safeUrl(a.getAttribute("href"));
        if (!url) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) { window.open(url, "_blank", "noopener,noreferrer"); return; }
        var info = { ed: a.closest(".pg-text"), b: b };
        PUI.menu(a, [
          { label: "Open link", hint: url.length > 60 ? url.slice(0, 57) + "…" : url, icon: "↗", onClick: function () { window.open(url, "_blank", "noopener,noreferrer"); } },
          { label: "Copy link", icon: "⎘", onClick: function () { S3.copy(url, "Link copied"); } },
          { label: "Remove link", icon: "✕", onClick: function () { removeLinkAt(info.b, a); } }
        ], { noFocus: true });
        return;
      }
      if ((b.type === "divider" || b.type === "page") && !t.closest("button")) selectBlocks([b.id]);
    });
    function removeLinkAt(b, a) {
      var ed = a.closest(".pg-text");
      if (!ed) return;
      var start = offsetAt(ed, a, 0), end = start + measure(a);
      b.text = P.setMark(b.text, start, end, "a", null);
      commit("format"); render(); focus(b.id, end);
    }
    function tableAction(b, t) {
      var cols = b.rows[0].length, cell = lastCell && lastCell.id === b.id ? lastCell : { r: b.rows.length - 1, c: cols - 1 };
      if (t === "row+") b.rows.splice(cell.r + 1, 0, b.rows[0].map(function () { return ""; }));
      else if (t === "col+") { if (cols >= 20) { S3.toast("Up to 20 columns", "error"); return; } b.rows.forEach(function (r) { r.splice(cell.c + 1, 0, ""); }); }
      else if (t === "row-") { if (b.rows.length <= 1) return; b.rows.splice(Math.min(cell.r, b.rows.length - 1), 1); }
      else if (t === "col-") { if (cols <= 1) return; b.rows.forEach(function (r) { r.splice(Math.min(cell.c, cols - 1), 1); }); }
      else if (t === "head") b.header = !b.header;
      if (b.rows.length > 200) b.rows.length = 200;
      lastCell = null;
      commit("table"); render();
    }

    // ----- drag to reorder (pointer events: mouse, pen and touch via the handle) -----
    root.addEventListener("pointerdown", function (e) {
      var g = e.target.closest(".pg-grip");
      if (!g || e.button !== 0) return;
      var row = rowOf(g);
      e.preventDefault();
      drag = { id: row.dataset.id, x0: e.clientX, y0: e.clientY, started: false, grip: g };
      try { g.setPointerCapture(e.pointerId); } catch (err) { /* old browser */ }
    });
    function startDrag(e) {
      var row = els[drag.id], r = row.getBoundingClientRect();
      drag.started = true; drag.dx = e.clientX - r.left; drag.dy = e.clientY - r.top;
      drag.ghost = row.cloneNode(true); drag.ghost.classList.add("pg-ghost"); drag.ghost.style.width = r.width + "px";
      document.body.appendChild(drag.ghost);
      drag.line = h("div", { "class": "pg-dropline" });
      root.appendChild(drag.line);
      var i = idx(drag.id), end = P.subtreeEnd(B, i);
      drag.skip = {};
      for (var k = i; k < end; k++) { drag.skip[B[k].id] = 1; els[B[k].id].classList.add("is-dragging"); }
      document.body.classList.add("pg-dragging");
      bar.remove(); closeSlash(); PUI.close();
    }
    function moveDrag(e) {
      drag.ghost.style.transform = "translate(" + (e.clientX - drag.dx) + "px," + (e.clientY - drag.dy) + "px)";
      var L = P.layout(B), target = B.length, lineY = null, rootR = root.getBoundingClientRect();
      for (var k = 0; k < B.length; k++) {
        if (L.hidden[k] || drag.skip[B[k].id]) continue;
        var rr = els[B[k].id].getBoundingClientRect();
        if (e.clientY < rr.top + rr.height / 2) { target = k; lineY = rr.top - rootR.top; break; }
        lineY = rr.bottom - rootR.top; target = P.subtreeEnd(B, k);
        if (drag.skip[B[target] && B[target].id]) { var j = target; while (j < B.length && drag.skip[B[j].id]) j++; target = j; }
      }
      var prev = null;
      for (var q = target - 1; q >= 0; q--) if (!drag.skip[B[q].id]) { prev = B[q]; break; }
      var unit = 26, rowLeft = e.clientX - drag.dx - rootR.left - 44;
      var want = Math.round(rowLeft / unit), max = prev ? prev.indent + 1 : 0;
      drag.target = target; drag.indent = Math.max(0, Math.min(max, want, P.MAX_INDENT));
      drag.line.style.top = (lineY == null ? 0 : lineY) - 1 + "px";
      drag.line.style.insetInlineStart = 44 + drag.indent * unit + "px";
      var sc = opts.scroller.getBoundingClientRect();
      if (e.clientY < sc.top + 50) opts.scroller.scrollTop -= 14; else if (e.clientY > sc.bottom - 50) opts.scroller.scrollTop += 14;
    }
    function endDrag(ok) {
      var d = drag; drag = null;
      if (!d || !d.started) return;
      d.ghost.remove(); d.line.remove();
      document.body.classList.remove("pg-dragging");
      Object.keys(d.skip).forEach(function (id) { if (els[id]) els[id].classList.remove("is-dragging"); });
      if (!ok || d.target == null) return;
      var i = idx(d.id);
      var before = JSON.stringify(B.map(function (b) { return [b.id, b.indent]; }));
      P.moveBlock(B, i, d.target, d.indent);
      if (JSON.stringify(B.map(function (b) { return [b.id, b.indent]; })) !== before) { commit("move"); render(); }
      selectBlocks([d.id]);
    }
    window.addEventListener("pointermove", function (e) {
      if (!drag) return;
      if (!drag.started) { if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return; startDrag(e); }
      moveDrag(e);
    });
    window.addEventListener("pointerup", function () {
      if (!drag) return;
      if (!drag.started) { var d = drag; drag = null; blockMenu(d.id, d.grip); return; }
      endDrag(true);
    });
    window.addEventListener("pointercancel", function () { endDrag(false); });
    window.addEventListener("keydown", function (e) { if (drag && e.key === "Escape") endDrag(false); });

    // ----- public API -----
    return {
      open: function (p) {
        page = p; B = p.blocks; if (!B.length) B.push(P.newBlock("p"));
        selIds = []; closeSlash(); bar.remove(); H();
        rebuild();
      },
      page: function () { return page; },
      refresh: function () { if (page) { B = page.blocks; rebuild(); } },
      rerender: function () { if (page) render(); },
      commit: commit, undo: undo, redo: redo,
      focusStart: function () { if (B[0]) focus(B[0].id, 0); },
      focusEnd: function (create) {
        var last = B[B.length - 1];
        if (create && (!last || !P.TEXT_TYPES[last.type] || P.len(last.text) || last.type !== "p")) { B.push(P.newBlock("p")); commit("insert"); render(); last = B[B.length - 1]; }
        if (last) focus(last.id, "end");
      },
      focusBlock: function (id) {
        if (!els[id]) return;
        focus(id, 0);
        els[id].classList.add("is-flash");
        setTimeout(function () { if (els[id]) els[id].classList.remove("is-flash"); }, 1600);
      },
      insertImages: function (files) { var a = document.activeElement, b = a && blockOf(a); return insertImages(files, b ? idx(b.id) : B.length - 1); },
      selectAll: function () { selectBlocks(B.map(function (b) { return b.id; })); },
      hasSelection: function () { return selIds.length > 0 || !!inline; },
      forget: function (id) { delete hist[id]; },
      wordCount: function () {
        var t = B.map(P.blockText).join(" ").trim();
        return t ? t.split(/\s+/).length : 0;
      }
    };
  }

  window.PEditor = Editor;
  window.PEditorTest = { readSpans: readSpans, renderSpans: renderSpans, measure: measure };
})();
