/* Pages: app shell. Sidebar tree, search, trash, covers/icons, backup/import, exports, demo, self-test.
 * Data lives in IndexedDB (db.js) on this device. Nothing is sent anywhere. */
(function () {
  "use strict";
  var P = window.PG, IO = window.PIO, DB = window.PDB, UI = window.PUI, $ = S3.$, h = S3.h;
  var TAB = P.uid(), pages = {}, cur = null, editor = null, urls = {}, dirty = {}, idxCache = {}, persistent = true;
  var bc = null;
  try { bc = new BroadcastChannel("s3-pages"); } catch (e) { bc = null; }
  var EMOJI = ("📄 📝 📒 📓 📔 📕 📗 📘 📙 📚 📖 🗂️ 📁 📌 📎 ✏️ 🖊️ 🗒️ ✅ ☑️ 🎯 🚀 💡 🔥 ⭐ 🌟 ✨ 💎 🎨 🎵 🎬 📷 🖼️ 🧠 💼 🏠 🌍 🗺️ ✈️ 🧳 🍳 🍎 ☕ 🎂 🎁 🏆 ⚽ 🏃 🧘 💪 " +
    "❤️ 💚 💙 💜 🧡 💛 🌸 🌿 🌵 🌙 ☀️ ❄️ 🌊 🐱 🐶 🦊 🐼 🦉 🐝 📅 ⏰ ⏳ 📈 📊 💰 🧾 🛒 🔧 ⚙️ 🧪 🔬 💻 📱 🔒 🔑 🕌 📿 👋 🗓️ 🎓 🩺 👁️ 🧩 🛠️ 📣 🤝").split(" ");

  // ---------- helpers ----------
  function list() { return Object.keys(pages).map(function (k) { return pages[k]; }); }
  function live(id) { var p = pages[id]; return p && !p.trashed ? p : null; }
  function titleOf(p) { return p ? (p.title || "Untitled") : "Missing page"; }
  function iconOf(p) { return (p && p.icon) || "📄"; }
  function fmtWhen(t) {
    var d = new Date(t), now = new Date(), diff = (now - d) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + " min ago";
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  }
  function expanded() { return S3.store("pages.open") || {}; }
  function setExpanded(id, v) { var e = expanded(); if (v) e[id] = 1; else delete e[id]; S3.store("pages.open", e); }
  function pathOf(id) { var out = [], p = pages[id], g = 0; while (p && p.parent && g++ < 200) { p = pages[p.parent]; if (p) out.unshift(p); } return out; }
  var ctx = {
    title: function (id) { return titleOf(pages[id]); },
    icon: function (id) { return iconOf(pages[id]); },
    exists: function (id) { return !!live(id); },
    gone: function (id) { return pages[id] ? "“" + titleOf(pages[id]) + "” is in the trash" : "Deleted page"; }
  };

  // ---------- saving ----------
  var statusEl = $("#status");
  function setStatus(t, bad) { statusEl.textContent = t; statusEl.classList.toggle("bad", !!bad); }
  function markDirty(id) { if (id && pages[id]) dirty[id] = 1; setStatus("Saving…"); saveSoon(); }
  function flush() {
    var ids = Object.keys(dirty);
    if (!ids.length) return Promise.resolve();
    dirty = {};
    var arr = ids.map(function (id) { return pages[id]; }).filter(Boolean);
    return DB.putPages(arr).then(function () {
      setStatus(persistent ? "Saved" : "Not saved: this browser blocks storage", !persistent);
      if (bc) bc.postMessage({ from: TAB, ids: ids });
    }, function () {
      ids.forEach(function (id) { dirty[id] = 1; });
      setStatus("Not saved — storage full? Download a backup", true);
      S3.toast("Couldn't save. Free some space or download a backup.", "error");
    });
  }
  var saveSoon = S3.debounce(flush, 350);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", flush);

  // ---------- images ----------
  function addImage(file) {
    if (!P.IMAGE_TYPES[file.type]) { S3.toast("Use a PNG, JPEG, GIF, WebP, AVIF or BMP image", "error"); return Promise.resolve(null); }
    if (file.size > 25 * 1024 * 1024) { S3.toast("Images up to 25 MB, please", "error"); return Promise.resolve(null); }
    return file.slice(0, 16).arrayBuffer().then(function (head) {
      var type = IO.sniff(head);
      if (!type) { S3.toast("That file isn't a readable image", "error"); return null; }
      var id = P.uid(), rec = { id: id, blob: new Blob([file], { type: type }), type: type, name: P.fileName(file.name, "image").slice(0, 120), size: file.size, added: Date.now() };
      return DB.putBlob(rec).then(function () { return id; }, function () { S3.toast("Couldn't store the image (storage full?)", "error"); return null; });
    });
  }
  function blobUrl(id) {
    if (urls[id]) return Promise.resolve(urls[id]);
    return DB.getBlob(id).then(function (rec) { if (!rec || !rec.blob) return null; return (urls[id] = URL.createObjectURL(rec.blob)); }, function () { return null; });
  }
  function downloadBlob(id, caption) {
    DB.getBlob(id).then(function (rec) { if (rec) S3.download(rec.blob, P.fileName(caption || rec.name, "image").replace(/\.\w+$/, "") + "." + (P.IMAGE_TYPES[rec.type] || "img")); });
  }
  function gcBlobs() {
    var refs = P.blobRefs(list());
    return DB.blobKeys().then(function (keys) {
      var stale = keys.filter(function (k) { return !refs[k]; });
      return Promise.all(stale.map(function (k) { return DB.getBlob(k).then(function (r) { return r && Date.now() - (r.added || 0) > 864e5 ? k : null; }); }));
    }).then(function (ks) { ks = ks.filter(Boolean); if (ks.length) return DB.deleteBlobs(ks); }).catch(function () {});
  }

  // ---------- pages ----------
  function createPage(parent, props) {
    var sibs = P.children(pages, parent || null);
    var p = P.newPage({ parent: parent || null, pos: sibs.length ? sibs[sibs.length - 1].pos + 1 : 1 });
    if (props) Object.keys(props).forEach(function (k) { p[k] = props[k]; });
    pages[p.id] = p;
    if (parent) setExpanded(parent, true);
    markDirty(p.id);
    return p;
  }
  function newPageAndOpen(parent) {
    var p = createPage(parent);
    renderTree();
    openPage(p.id, true);
    S3.done();
  }
  function touch(p) { p.updated = Date.now(); markDirty(p.id); }

  // ---------- sidebar ----------
  var treeEl = $("#tree"), favEl = $("#favs");
  function row(p, depth, inFav) {
    var kids = P.children(pages, p.id), open = !inFav && expanded()[p.id];
    var li = h("li", { role: "treeitem", "aria-expanded": kids.length && !inFav ? String(!!open) : false });
    var r = h("div", { "class": "pg-row" + (p.id === cur ? " on" : ""), "data-id": p.id, "data-fav": inFav ? "1" : false, tabindex: "0", "aria-current": p.id === cur ? "page" : false });
    r.style.setProperty("--d", depth);
    r.appendChild(kids.length && !inFav ? h("button", { type: "button", "class": "pg-twisty" + (open ? " open" : ""), "aria-label": open ? "Collapse" : "Expand", tabindex: "-1", text: "▶" }) : h("span", { "class": "pg-twisty none" }));
    r.appendChild(h("span", { "class": "pg-row-ic", text: iconOf(p) }));
    r.appendChild(h("span", { "class": "pg-row-t", dir: "auto", text: titleOf(p) }));
    r.appendChild(h("span", { "class": "pg-row-act" }, [
      h("button", { type: "button", "class": "pg-row-b", "data-act": "more", title: "Delete, duplicate, move…", "aria-label": "Page options", tabindex: "-1", text: "⋯" }),
      inFav ? null : h("button", { type: "button", "class": "pg-row-b", "data-act": "add", title: "Add a page inside", "aria-label": "Add a page inside", tabindex: "-1", text: "+" })
    ]));
    li.appendChild(r);
    if (open) {
      var ul = h("ul", { role: "group" });
      kids.forEach(function (k) { ul.appendChild(row(k, depth + 1, false)); });
      li.appendChild(ul);
    }
    return li;
  }
  function renderTree() {
    var favs = list().filter(function (p) { return p.fav && !p.trashed; }).sort(function (a, b) { return a.fav - b.fav; });
    favEl.textContent = "";
    favs.forEach(function (p) { favEl.appendChild(row(p, 0, true)); });
    $("#fav-sec").hidden = !favs.length;
    treeEl.textContent = "";
    var top = P.children(pages, null);
    top.forEach(function (p) { treeEl.appendChild(row(p, 0, false)); });
    if (!top.length) treeEl.appendChild(h("li", { "class": "pg-tree-empty" }, [h("span", { text: "No pages yet." }), h("button", { type: "button", "class": "btn small primary", "data-act": "first", text: "Create a page" })]));
    var tc = list().filter(function (p) { return p.trashed && p.trashRoot === p.id; }).length;
    $("#trash-count").textContent = tc ? String(tc) : "";
  }
  var renderTreeSoon = S3.debounce(renderTree, 150);
  function onTreeClick(e) {
    var first = e.target.closest("[data-act=first]");
    if (first) { newPageAndOpen(null); return; }
    var r = e.target.closest(".pg-row");
    if (!r || justDragged) return;
    var id = r.dataset.id, act = e.target.closest("[data-act]");
    if (e.target.closest(".pg-twisty")) { setExpanded(id, !expanded()[id]); renderTree(); return; }
    if (act && act.dataset.act === "add") { newPageAndOpen(id); return; }
    if (act && act.dataset.act === "more") { pageMenu(act, id); return; }
    openPage(id);
    closeSide();
  }
  [treeEl, favEl].forEach(function (el) {
    el.addEventListener("click", onTreeClick);
    el.addEventListener("keydown", function (e) {
      var r = e.target.closest(".pg-row");
      if (!r) return;
      var rows = S3.$$(".pg-row", $("#tree-wrap")), k = rows.indexOf(r), id = r.dataset.id;
      if (e.key === "Enter") { e.preventDefault(); openPage(id); }
      else if (e.key === "ArrowDown" && rows[k + 1]) { e.preventDefault(); rows[k + 1].focus(); }
      else if (e.key === "ArrowUp" && rows[k - 1]) { e.preventDefault(); rows[k - 1].focus(); }
      else if (e.key === "ArrowRight" && !r.dataset.fav) { e.preventDefault(); setExpanded(id, true); renderTree(); focusRow(id); }
      else if (e.key === "ArrowLeft" && !r.dataset.fav) { e.preventDefault(); if (expanded()[id]) { setExpanded(id, false); renderTree(); focusRow(id); } else if (pages[id].parent) focusRow(pages[id].parent); }
      else if (e.key === "Delete") { e.preventDefault(); trash(id); }
    });
  });
  function focusRow(id) { var r = $('#tree .pg-row[data-id="' + id + '"]'); if (r) r.focus(); }

  // drag pages in the tree (mouse and pen; on touch use "Move to…")
  var tdrag = null, justDragged = false;
  treeEl.addEventListener("pointerdown", function (e) {
    var r = e.target.closest(".pg-row");
    if (!r || e.button !== 0 || e.pointerType === "touch" || e.target.closest("button")) return;
    tdrag = { id: r.dataset.id, x: e.clientX, y: e.clientY, started: false };
  });
  function clearDrop() { S3.$$(".pg-row.drop-before, .pg-row.drop-after, .pg-row.drop-in", treeEl).forEach(function (x) { x.classList.remove("drop-before", "drop-after", "drop-in"); }); }
  window.addEventListener("pointermove", function (e) {
    if (!tdrag) return;
    if (!tdrag.started) {
      if (Math.hypot(e.clientX - tdrag.x, e.clientY - tdrag.y) < 6) return;
      tdrag.started = true;
      tdrag.ghost = h("div", { "class": "pg-tghost", text: iconOf(pages[tdrag.id]) + " " + titleOf(pages[tdrag.id]) });
      document.body.appendChild(tdrag.ghost);
      document.body.classList.add("pg-dragging");
    }
    tdrag.ghost.style.transform = "translate(" + (e.clientX + 12) + "px," + (e.clientY + 6) + "px)";
    clearDrop();
    tdrag.target = null;
    var el = document.elementFromPoint(e.clientX, e.clientY), r = el && el.closest && el.closest("#tree .pg-row");
    if (!r || r.dataset.id === tdrag.id || P.isInside(pages, r.dataset.id, tdrag.id)) {
      if (el && el.closest && el.closest("#tree") && !r) tdrag.target = { zone: "end" };
      return;
    }
    var rr = r.getBoundingClientRect(), y = (e.clientY - rr.top) / rr.height;
    var zone = y < 0.28 ? "before" : y > 0.72 ? "after" : "in";
    r.classList.add(zone === "before" ? "drop-before" : zone === "after" ? "drop-after" : "drop-in");
    tdrag.target = { id: r.dataset.id, zone: zone };
  });
  window.addEventListener("pointerup", function () {
    if (!tdrag) return;
    var d = tdrag; tdrag = null;
    if (!d.started) return;
    d.ghost.remove(); document.body.classList.remove("pg-dragging"); clearDrop();
    justDragged = true; setTimeout(function () { justDragged = false; }, 50);
    var t = d.target;
    if (!t) return;
    var ok;
    if (t.zone === "end") ok = P.movePage(pages, d.id, null, null);
    else if (t.zone === "in") { ok = P.movePage(pages, d.id, t.id, null); setExpanded(t.id, true); }
    else {
      var tp = pages[t.id], sibs = P.children(pages, tp.parent).filter(function (p) { return p.id !== d.id; }), k = sibs.indexOf(tp);
      ok = P.movePage(pages, d.id, tp.parent, t.zone === "before" ? tp.id : (sibs[k + 1] ? sibs[k + 1].id : null));
    }
    if (!ok) return;
    P.children(pages, pages[d.id].parent).forEach(function (p) { markDirty(p.id); });
    renderTree(); renderHead();
  });

  // ---------- opening a page ----------
  var titleEl = $("#title"), scroller = $("#scroll");
  function openPage(id, focusTitle, blockId) {
    var p = live(id);
    if (!p) return;
    flush();
    cur = id;
    S3.store("pages.last", id);
    var rec = S3.store("pages.recent") || [];
    S3.store("pages.recent", [id].concat(rec.filter(function (x) { return x !== id; })).slice(0, 12));
    editor.open(p);
    renderHead();
    renderTree();
    scroller.scrollTop = 0;
    if (focusTitle) { titleEl.focus(); placeEnd(titleEl); }
    else if (blockId) setTimeout(function () { editor.focusBlock(blockId); }, 30);
    document.title = (p.icon ? p.icon + " " : "") + titleOf(p) + " · Pages";
  }
  function placeEnd(el) { var r = document.createRange(); r.selectNodeContents(el); r.collapse(false); var s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  function renderHead(force) {
    var p = pages[cur];
    if (!p) return;
    var cover = $("#cover");
    cover.hidden = p.cover == null;
    if (p.cover != null) cover.style.background = P.COVERS[p.cover] || P.COVERS[0];
    $("#icon").hidden = !p.icon;
    $("#icon").textContent = p.icon || "";
    $("#add-icon").hidden = !!p.icon;
    $("#add-cover").hidden = p.cover != null;
    if (force === true || document.activeElement !== titleEl) { if (titleEl.textContent !== p.title) titleEl.textContent = p.title; }
    titleEl.classList.toggle("is-empty", !p.title);
    var doc = $("#doc");
    doc.className = "pg-doc font-" + p.font + (p.wide ? " wide" : "") + (p.icon ? " has-icon" : "") + (p.cover != null ? " has-cover" : "");
    $("#fav-btn").setAttribute("aria-pressed", String(!!p.fav));
    $("#fav-btn").textContent = p.fav ? "★" : "☆";
    $("#fav-btn").title = p.fav ? "Remove from favourites" : "Add to favourites";
    var crumbs = $("#crumbs");
    crumbs.textContent = "";
    pathOf(cur).concat([p]).forEach(function (x, k, arr) {
      crumbs.appendChild(h("button", { type: "button", "class": "pg-crumb", "data-id": x.id, dir: "auto", text: iconOf(x) + " " + titleOf(x) }));
      if (k < arr.length - 1) crumbs.appendChild(h("span", { "class": "pg-crumb-sep", text: "/" }));
    });
    var wc = editor.wordCount();
    $("#pfoot").textContent = wc.toLocaleString() + (wc === 1 ? " word" : " words") + " · edited " + fmtWhen(p.updated);
  }
  var renderHeadSoon = S3.debounce(renderHead, 200);
  $("#crumbs").addEventListener("click", function (e) { var b = e.target.closest(".pg-crumb"); if (b) openPage(b.dataset.id); });

  // title (plain text only)
  titleEl.addEventListener("input", function () {
    var p = pages[cur]; if (!p) return;
    var t = titleEl.textContent.replace(/[\r\n]+/g, " ").slice(0, 500);
    if (titleEl.querySelector("*")) { titleEl.textContent = t; placeEnd(titleEl); }
    p.title = t;
    titleEl.classList.toggle("is-empty", !t);
    editor.commit("title");
    document.title = (p.icon ? p.icon + " " : "") + titleOf(p) + " · Pages";
  });
  titleEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || (e.key === "ArrowDown")) { e.preventDefault(); editor.focusStart(); }
    if ((e.ctrlKey || e.metaKey) && /^[biu]$/i.test(e.key)) e.preventDefault();
  });
  titleEl.addEventListener("paste", function (e) {
    e.preventDefault();
    var t = (e.clipboardData && e.clipboardData.getData("text/plain") || "").replace(/[\r\n]+/g, " ");
    document.execCommand("insertText", false, t);
  });
  titleEl.addEventListener("drop", function (e) { e.preventDefault(); });
  titleEl.addEventListener("beforeinput", function (e) {
    if (/^format|^insertFromDrop/.test(e.inputType)) e.preventDefault();
    if (e.inputType === "historyUndo") { e.preventDefault(); editor.undo(); }
    if (e.inputType === "historyRedo") { e.preventDefault(); editor.redo(); }
  });
  $("#tail").addEventListener("click", function () { editor.focusEnd(true); });

  // icon & cover
  function emojiPicker(anchor, cb, allowRemove) {
    var grid = h("div", { "class": "pg-emoji" });
    EMOJI.forEach(function (em) { grid.appendChild(h("button", { type: "button", "class": "pg-em", "data-e": em, text: em, "aria-label": em })); });
    var inp = h("input", { "class": "input", type: "text", placeholder: "Or paste any emoji", "aria-label": "Custom emoji", maxlength: "16" });
    var box = h("div", { "class": "pg-pop" }, [
      h("div", { "class": "row between pg-pop-top" }, [h("b", { text: "Icon" }), h("div", { "class": "row" }, [
        h("button", { type: "button", "class": "btn small ghost", "data-r": "1", text: "🎲 Random" }),
        allowRemove ? h("button", { type: "button", "class": "btn small ghost", "data-x": "1", text: "Remove" }) : null
      ])]),
      inp, grid
    ]);
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-e]");
      if (b) { UI.close(); cb(b.dataset.e); return; }
      if (e.target.closest("[data-r]")) { UI.close(); cb(EMOJI[Math.floor(Math.random() * EMOJI.length)]); return; }
      if (e.target.closest("[data-x]")) { UI.close(); cb(""); }
    });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); var v = inp.value.trim().slice(0, 16); if (v) { UI.close(); cb(v); } }
    });
    UI.popover(anchor, box);
    inp.focus();
  }
  function setIcon(em) { var p = pages[cur]; if (!p) return; p.icon = em; editor.commit("icon"); renderHead(); renderTree(); }
  $("#icon").addEventListener("click", function (e) { emojiPicker(e.currentTarget, setIcon, true); });
  $("#add-icon").addEventListener("click", function () { setIcon(EMOJI[Math.floor(Math.random() * 30)]); });
  function coverPicker(anchor) {
    var grid = h("div", { "class": "pg-covers" });
    P.COVERS.forEach(function (c, k) { var b = h("button", { type: "button", "class": "pg-cv", "data-k": k, "aria-label": "Cover " + (k + 1) }); b.style.background = c; grid.appendChild(b); });
    var box = h("div", { "class": "pg-pop" }, [h("div", { "class": "row between pg-pop-top" }, [h("b", { text: "Cover" }), h("button", { type: "button", "class": "btn small ghost", "data-x": "1", text: "Remove" })]), grid]);
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-k]"), p = pages[cur];
      if (b) { p.cover = +b.dataset.k; editor.commit("cover"); renderHead(); }
      if (e.target.closest("[data-x]")) { UI.close(); p.cover = null; editor.commit("cover"); renderHead(); }
    });
    UI.popover(anchor, box);
  }
  $("#add-cover").addEventListener("click", function () { var p = pages[cur]; p.cover = Math.floor(Math.random() * P.COVERS.length); editor.commit("cover"); renderHead(); });
  $("#cover-change").addEventListener("click", function (e) { coverPicker(e.currentTarget); });
  $("#cover-remove").addEventListener("click", function () { pages[cur].cover = null; editor.commit("cover"); renderHead(); });

  // ---------- page actions ----------
  function toggleFav(id) {
    var p = pages[id];
    p.fav = p.fav ? 0 : Date.now();
    markDirty(id); renderTree(); renderHead();
    S3.toast(p.fav ? "Added to favourites" : "Removed from favourites");
  }
  function trash(id) {
    var p = pages[id];
    if (!p) return;
    var hit = P.trashPage(pages, id, Date.now());
    hit.forEach(markDirty);
    if (hit.indexOf(cur) >= 0) {
      var next = (p.parent && live(p.parent)) || P.children(pages, null)[0];
      if (next) openPage(next.id); else { var np = createPage(null); openPage(np.id, true); }
    }
    renderTree();
    var t = S3.toast("Moved “" + titleOf(p) + "”" + (hit.length > 1 ? " and " + (hit.length - 1) + " inside it" : "") + " to the trash ");
    t.style.pointerEvents = "auto";
    t.appendChild(h("button", { "class": "btn small", type: "button", text: "Undo", onclick: function () { P.restorePage(pages, id).forEach(markDirty); renderTree(); openPage(id); t.remove(); } }));
  }
  function duplicatePage(id) {
    var ids = [id].concat(P.descendants(pages, id).filter(function (k) { return !pages[k].trashed; })), map = {};
    ids.forEach(function (k) { map[k] = P.uid(); });
    var copyRoot = null;
    ids.forEach(function (k) {
      var q = JSON.parse(JSON.stringify(pages[k]));
      q.id = map[k];
      q.parent = k === id ? pages[k].parent : map[pages[k].parent] || pages[k].parent;
      q.created = q.updated = Date.now(); q.fav = 0;
      if (k === id) { q.title = (q.title || "Untitled") + " (copy)"; q.pos = pages[k].pos + 0.0001; copyRoot = q.id; }
      q.blocks.forEach(function (b) { if (b.type === "page" && map[b.page]) b.page = map[b.page]; });
      pages[q.id] = q; markDirty(q.id);
    });
    var sib = P.children(pages, pages[id].parent), k2 = sib.map(function (p) { return p.id; }).indexOf(id);
    P.movePage(pages, copyRoot, pages[id].parent, sib[k2 + 1] && sib[k2 + 1].id !== copyRoot ? sib[k2 + 1].id : (sib[k2 + 2] ? sib[k2 + 2].id : null));
    renderTree(); openPage(copyRoot);
    S3.toast("Duplicated");
  }
  function moveTo(id) {
    pickPage("Move “" + titleOf(pages[id]) + "” to…", function (p) { return p.id !== id && !P.isInside(pages, p.id, id); }, function (target) {
      if (!P.movePage(pages, id, target || null, null)) return;
      if (target) setExpanded(target, true);
      markDirty(id); renderTree(); renderHead();
      S3.toast("Moved to " + (target ? titleOf(pages[target]) : "the top level"));
    }, true);
  }
  function exportPage(id, kind) {
    var p = pages[id];
    flush();
    if (kind === "print") { if (id !== cur) openPage(id); setTimeout(function () { window.print(); }, 60); S3.done(); return; }
    if (kind === "md") IO.pageMd(p, pages, DB.getBlob).then(function (r) { S3.download(r.blob, r.name); S3.done(); }, failed);
    if (kind === "html") IO.pageHtml(p, pages, DB.getBlob).then(function (html) { S3.download(html, P.fileName(p.title) + ".html", "text/html;charset=utf-8"); S3.done(); }, failed);
  }
  function failed(err) { S3.toast((err && err.message) || "Something went wrong", "error"); }
  function pageMenu(anchor, id) {
    var p = pages[id];
    if (!p) return;
    var isCur = id === cur;
    UI.menu(anchor, [
      { label: p.fav ? "Remove from favourites" : "Add to favourites", icon: p.fav ? "★" : "☆", onClick: function () { toggleFav(id); } },
      { label: "Add a page inside", icon: "＋", onClick: function () { newPageAndOpen(id); } },
      { label: "Duplicate", icon: "⧉", onClick: function () { duplicatePage(id); } },
      { label: "Move to…", icon: "↪", onClick: function () { moveTo(id); } },
      isCur ? { section: "Style" } : null,
      isCur ? { label: "Default font", icon: "Ag", checked: p.font === "sans", onClick: function () { p.font = "sans"; editor.commit("style"); renderHead(); } } : null,
      isCur ? { label: "Serif", icon: "Ag", checked: p.font === "serif", onClick: function () { p.font = "serif"; editor.commit("style"); renderHead(); } } : null,
      isCur ? { label: "Mono", icon: "Ag", checked: p.font === "mono", onClick: function () { p.font = "mono"; editor.commit("style"); renderHead(); } } : null,
      isCur ? { label: "Full width", icon: "↔", checked: !!p.wide, onClick: function () { p.wide = !p.wide; editor.commit("style"); renderHead(); } } : null,
      { section: "Export" },
      { label: "Markdown", hint: "A .md file (a .zip when it has images)", icon: "⬇", onClick: function () { exportPage(id, "md"); } },
      { label: "HTML", hint: "One file, images included", icon: "⬇", onClick: function () { exportPage(id, "html"); } },
      { label: "Print or save as PDF", icon: "🖨", onClick: function () { exportPage(id, "print"); } },
      { sep: true },
      { label: "Move to trash", icon: "🗑", danger: true, kbd: "", onClick: function () { trash(id); } },
      { node: h("div", { "class": "pg-menu-foot", text: "Edited " + fmtWhen(p.updated) + " · created " + fmtWhen(p.created) }) }
    ]);
  }
  $("#more-btn").addEventListener("click", function (e) { pageMenu(e.currentTarget, cur); });
  $("#fav-btn").addEventListener("click", function () { toggleFav(cur); });
  $("#undo-btn").addEventListener("click", function () { editor.undo(); });
  $("#redo-btn").addEventListener("click", function () { editor.redo(); });
  $("#new-btn").addEventListener("click", function () { newPageAndOpen(null); });
  $("#add-top").addEventListener("click", function () { newPageAndOpen(null); });

  // ---------- search palette / page picker ----------
  function idx() {
    return list().filter(function (p) { return !p.trashed; }).map(function (p) {
      var c = idxCache[p.id];
      if (!c || c.updated !== p.updated || c.title !== p.title) { c = P.indexPage(p); c.titleRaw = p.title; idxCache[p.id] = c; c.title = P.fold(p.title || "Untitled"); }
      return c;
    });
  }
  function highlight(text, q) {
    var frag = document.createDocumentFragment(), words = q.trim().toLowerCase().split(/\s+/).filter(Boolean), low = text.toLowerCase(), i = 0;
    while (i < text.length && words.length) {
      var best = -1, wl = 0;
      words.forEach(function (w) { var at = low.indexOf(w, i); if (at >= 0 && (best < 0 || at < best)) { best = at; wl = w.length; } });
      if (best < 0) break;
      frag.appendChild(document.createTextNode(text.slice(i, best)));
      frag.appendChild(h("mark", { text: text.slice(best, best + wl) }));
      i = best + wl;
    }
    frag.appendChild(document.createTextNode(text.slice(i)));
    return frag;
  }
  function palette(opts) {
    UI.close();
    var old = $(".pg-pal-back"); if (old) old.remove();
    var back = h("div", { "class": "pg-pal-back" });
    var inp = h("input", { "class": "pg-pal-in", type: "search", placeholder: opts.placeholder || "Search pages…", "aria-label": opts.title || "Search", dir: "auto", spellcheck: "false", autocomplete: "off" });
    var ul = h("div", { "class": "pg-pal-list", role: "listbox" });
    var pal = h("div", { "class": "pg-pal", role: "dialog", "aria-label": opts.title || "Search" }, [
      h("div", { "class": "pg-pal-head" }, [h("span", { "class": "pg-pal-ic", text: opts.mode === "pick" ? "↪" : "🔍" }), inp, h("kbd", { text: "Esc" })]),
      opts.title ? h("div", { "class": "pg-pal-title", text: opts.title }) : null, ul,
      h("div", { "class": "pg-pal-foot" }, [h("span", { text: "↑↓ to move · Enter to open" + (opts.mode === "pick" ? "" : " · Ctrl+K anywhere") })])
    ]);
    back.appendChild(pal);
    var items = [], active = 0, prevFocus = document.activeElement;
    function close() { back.remove(); document.removeEventListener("keydown", keys, true); if (opts.onCancel) opts.onCancel(); }
    function choose(k) {
      var it = items[k];
      if (!it) return;
      back.remove(); document.removeEventListener("keydown", keys, true);
      if (prevFocus && document.contains(prevFocus) && opts.mode === "pick") try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ }
      opts.onPick(it.id, it.hit);
    }
    function draw() {
      var q = inp.value, rows;
      ul.textContent = "";
      items = [];
      if (opts.mode === "pick" && opts.allowTop && !q.trim()) items.push({ id: "", label: "Top level", icon: "⌂", sub: "Not inside another page" });
      if (!q.trim()) {
        var rec = (S3.store("pages.recent") || []).filter(live);
        var rest = list().filter(function (p) { return !p.trashed && rec.indexOf(p.id) < 0; }).sort(function (a, b) { return b.updated - a.updated; }).map(function (p) { return p.id; });
        rows = rec.concat(rest).slice(0, 30).map(function (id) { return { id: id }; });
      } else rows = P.search(idx(), q, 40);
      rows.forEach(function (r) {
        var p = pages[r.id];
        if (!p || (opts.filter && !opts.filter(p))) return;
        var path = pathOf(r.id).map(titleOf).join(" / ");
        items.push({ id: r.id, hit: r.hit, label: titleOf(p), icon: iconOf(p), sub: r.hit ? r.hit.text : path || (q.trim() ? "" : "Edited " + fmtWhen(p.updated)) });
      });
      if (!q.trim() && rows.length) ul.appendChild(h("div", { "class": "pg-menu-sec", text: opts.mode === "pick" ? "Pages" : "Recent" }));
      if (!items.length) ul.appendChild(h("div", { "class": "pg-pal-empty", text: q.trim() ? "No pages match “" + q.trim() + "”" : "No pages yet" }));
      active = Math.min(active, Math.max(0, items.length - 1));
      items.forEach(function (it, k) {
        var t = h("span", { "class": "pg-pal-t", dir: "auto" }); t.appendChild(highlight(it.label, q));
        var s = h("small", { dir: "auto" }); s.appendChild(highlight(it.sub || "", q));
        ul.appendChild(h("button", { type: "button", "class": "pg-pal-it" + (k === active ? " is-active" : ""), role: "option", "aria-selected": String(k === active), "data-k": k }, [
          h("span", { "class": "pg-pal-em", text: it.icon }), h("span", { "class": "pg-pal-txt" }, [t, it.sub ? s : null])
        ]));
      });
    }
    function keys(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); if (prevFocus && document.contains(prevFocus)) try { prevFocus.focus(); } catch (er) { /* gone */ } }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length); draw(); var a = $(".pg-pal-it.is-active", ul); if (a) a.scrollIntoView({ block: "nearest" }); }
      else if (e.key === "Enter") { e.preventDefault(); choose(active); }
    }
    inp.addEventListener("input", function () { active = 0; draw(); });
    ul.addEventListener("click", function (e) { var b = e.target.closest("[data-k]"); if (b) choose(+b.dataset.k); });
    back.addEventListener("pointerdown", function (e) { if (e.target === back) close(); });
    document.addEventListener("keydown", keys, true);
    document.body.appendChild(back);
    draw();
    inp.focus();
  }
  function openSearch() {
    palette({ mode: "search", onPick: function (id, hit) { openPage(id, false, hit && hit.block); closeSide(); } });
  }
  function pickPage(title, filter, cb, allowTop) {
    palette({ mode: "pick", title: title, filter: function (p) { return (!filter || filter(p)); }, allowTop: allowTop, placeholder: "Find a page…", onPick: function (id) { cb(id || null); } });
  }
  $("#search-btn").addEventListener("click", openSearch);

  // ---------- trash ----------
  function openTrash() {
    var inp = h("input", { "class": "input", type: "search", placeholder: "Search the trash", "aria-label": "Search the trash", dir: "auto" });
    var ul = h("div", { "class": "pg-trash" });
    var empty = h("button", { type: "button", "class": "btn small danger", text: "Empty trash" });
    var body = h("div", { "class": "stack" }, [h("p", { "class": "muted", text: "Deleted pages stay here until you remove them. Restoring a page also brings back the pages inside it." }), inp, ul, h("div", { "class": "row between" }, [h("span", { "class": "faint", id: "trash-n" }), empty])]);
    var m = UI.modal("Trash", body, { wide: true });
    function draw() {
      ul.textContent = "";
      var q = P.fold(inp.value.trim());
      var roots = list().filter(function (p) { return p.trashed && p.trashRoot === p.id && (!q || P.fold(p.title).indexOf(q) >= 0); }).sort(function (a, b) { return b.trashed - a.trashed; });
      if (!roots.length) ul.appendChild(h("div", { "class": "empty" }, [h("b", { text: q ? "Nothing matches" : "The trash is empty" })]));
      roots.forEach(function (p) {
        var inside = P.descendants(pages, p.id).filter(function (k) { return pages[k].trashRoot === p.id; }).length;
        ul.appendChild(h("div", { "class": "pg-trash-it", "data-id": p.id }, [
          h("span", { "class": "pg-pal-em", text: iconOf(p) }),
          h("span", { "class": "pg-pal-txt" }, [h("span", { "class": "pg-pal-t", dir: "auto", text: titleOf(p) }), h("small", { text: "Deleted " + fmtWhen(p.trashed) + (inside ? " · " + inside + " page" + (inside === 1 ? "" : "s") + " inside" : "") })]),
          h("button", { type: "button", "class": "btn small", "data-act": "restore", text: "Restore" }),
          h("button", { type: "button", "class": "btn small ghost danger", "data-act": "kill", "aria-label": "Delete forever", title: "Delete forever", html: S3.icon("trash") })
        ]));
      });
      var all = list().filter(function (p) { return p.trashed; }).length;
      $("#trash-n", body).textContent = all ? all + " page" + (all === 1 ? "" : "s") + " in the trash" : "";
      empty.disabled = !all;
    }
    ul.addEventListener("click", function (e) {
      var it = e.target.closest(".pg-trash-it"), act = e.target.closest("[data-act]");
      if (!it || !act) return;
      var id = it.dataset.id;
      if (act.dataset.act === "restore") {
        P.restorePage(pages, id).forEach(markDirty);
        S3.toast("Restored “" + titleOf(pages[id]) + "”");
        renderTree(); draw();
      } else if (confirm("Delete “" + titleOf(pages[id]) + "” forever? This can't be undone.")) {
        forget(P.deleteForever(pages, id)); renderTree(); draw();
      }
    });
    empty.addEventListener("click", function () {
      var all = list().filter(function (p) { return p.trashed; });
      if (!all.length || !confirm("Delete " + all.length + " page" + (all.length === 1 ? "" : "s") + " forever? This can't be undone.")) return;
      var ids = all.map(function (p) { return p.id; });
      ids.forEach(function (k) { delete pages[k]; });
      forget(ids); renderTree(); draw();
    });
    inp.addEventListener("input", draw);
    draw();
    return m;
  }
  function forget(ids) {
    if (!ids.length) return;
    ids.forEach(function (k) { delete dirty[k]; delete idxCache[k]; editor.forget(k); });
    DB.deletePages(ids).then(function () { if (bc) bc.postMessage({ from: TAB, ids: ids }); });
  }
  $("#trash-btn").addEventListener("click", openTrash);

  // ---------- backup & import ----------
  function stamp() { return new Date().toISOString().slice(0, 10); }
  function backup() {
    return flush().then(function () { return IO.backupZip(list(), DB.getBlob); }).then(function (blob) {
      S3.download(blob, "pages-backup-" + stamp() + ".zip");
      S3.store("pages.backup", Date.now());
      S3.toast("Backup downloaded (" + S3.fmtBytes(blob.size) + ")");
      S3.done();
    }, failed);
  }
  function addImported(newPages, blobs) {
    var topNow = P.children(pages, null), pos = topNow.length ? topNow[topNow.length - 1].pos + 1 : 1;
    return Promise.all(blobs.map(function (b) { b.added = Date.now(); b.size = b.blob.size; return DB.putBlob(b); })).then(function () {
      newPages.forEach(function (p) {
        if (!p.parent || !newPages.some(function (q) { return q.id === p.parent; })) { p.parent = null; if (!p.trashed) p.pos = pos++; }
        pages[p.id] = p; dirty[p.id] = 1;
      });
      return flush();
    });
  }
  function afterImport(newPages, blobs) {
    renderTree();
    var first = newPages.filter(function (p) { return !p.parent && !p.trashed; })[0];
    if (first) openPage(first.id);
    S3.toast("Imported " + newPages.length + " page" + (newPages.length === 1 ? "" : "s") + (blobs.length ? " and " + blobs.length + " image" + (blobs.length === 1 ? "" : "s") : ""));
    S3.done();
  }
  function importFiles(files) {
    files = Array.prototype.slice.call(files || []);
    if (!files.length) return;
    var md = files.filter(function (f) { return /\.(md|markdown|txt)$/i.test(f.name); }), other = files.filter(function (f) { return md.indexOf(f) < 0; });
    var chain = Promise.resolve();
    if (md.length) chain = chain.then(function () {
      return Promise.all(md.map(IO.readMdFile)).then(function (ps) { return addImported(ps, []).then(function () { afterImport(ps, []); }); });
    });
    other.forEach(function (f) {
      chain = chain.then(function () { return IO.readBackup(f); }).then(function (res) {
        if (res.kind === "markdown") return addImported(res.pages, res.blobs).then(function () { afterImport(res.pages, res.blobs); });
        return askMode(res);
      });
    });
    chain.catch(failed);
  }
  function askMode(res) {
    return new Promise(function (done) {
      var addBtn = h("button", { type: "button", "class": "btn primary", text: "Add to my pages" });
      var repBtn = h("button", { type: "button", "class": "btn danger", text: "Replace everything" });
      var n = res.pages.length, im = res.blobs.length;
      var body = h("div", { "class": "stack" }, [
        h("p", { text: "This backup has " + n + " page" + (n === 1 ? "" : "s") + " and " + im + " image" + (im === 1 ? "" : "s") + "." }),
        h("p", { "class": "muted", text: "Add keeps everything you have and adds the backup next to it. Replace deletes the pages on this device first." }),
        h("div", { "class": "row" }, [addBtn, repBtn])
      ]);
      var m = UI.modal("Import backup", body, { onClose: done });
      addBtn.addEventListener("click", function () {
        m.close();
        var r = IO.remap(res.pages, res.blobs);
        addImported(r.pages, r.blobs).then(function () { afterImport(r.pages, r.blobs); }, failed);
      });
      repBtn.addEventListener("click", function () {
        if (!confirm("Replace all pages on this device with the backup? Download a backup of the current pages first if you might need them.")) return;
        m.close();
        DB.clear().then(function () {
          Object.keys(pages).forEach(function (k) { editor.forget(k); });
          pages = {}; idxCache = {}; dirty = {};
          return Promise.all(res.blobs.map(function (b) { b.added = Date.now(); b.size = b.blob.size; return DB.putBlob(b); }));
        }).then(function () {
          res.pages.forEach(function (p) { pages[p.id] = p; dirty[p.id] = 1; });
          if (!list().some(function (p) { return !p.trashed; })) { var np = createPage(null, { title: "Untitled" }); dirty[np.id] = 1; }
          return flush();
        }).then(function () {
          if (bc) bc.postMessage({ from: TAB, reload: true });
          renderTree();
          var first = P.children(pages, null)[0];
          if (first) openPage(first.id);
          S3.toast("Restored " + res.pages.length + " pages");
          S3.done();
        }, failed);
      });
    });
  }
  function openData() {
    var file = h("input", { type: "file", accept: ".zip,.json,.md,.markdown,.txt,application/zip,application/json,text/markdown,text/plain", multiple: true, hidden: true });
    var drop = h("div", { "class": "drop pg-drop" }, [h("b", { text: "Import" }), h("span", { "class": "muted", text: "Drop a Pages backup (.zip / .json), Markdown files (.md), or a .zip of Markdown files exported from another notes app." }), file]);
    var info = h("p", { "class": "faint", text: "Counting…" });
    var last = S3.store("pages.backup");
    var persistBtn = h("button", { type: "button", "class": "btn small ghost", hidden: true, text: "Ask the browser to keep this data" });
    var body = h("div", { "class": "stack" }, [
      h("p", { "class": "muted", text: "Your pages live only in this browser. A backup is one .zip with every page, the trash and all images. Import it here, in any browser, to get everything back exactly." }),
      h("div", { "class": "row" }, [
        h("button", { type: "button", "class": "btn primary", "data-act": "backup", html: S3.icon("download") + "Download backup (.zip)" }),
        h("button", { type: "button", "class": "btn", "data-act": "mdall", html: S3.icon("download") + "All pages as Markdown" })
      ]),
      h("p", { "class": "faint", text: last ? "Last backup: " + fmtWhen(last) : "No backup downloaded from this browser yet." }),
      drop, info, persistBtn
    ]);
    var m = UI.modal("Backup & import", body, { wide: true });
    S3.drop(drop, function (files) { m.close(); importFiles(files); }, { accept: ".zip,.json,.md,.markdown,.txt", multiple: true });
    body.addEventListener("click", function (e) {
      var a = e.target.closest("[data-act]");
      if (!a) return;
      if (a.dataset.act === "backup") backup();
      if (a.dataset.act === "mdall") flush().then(function () { return IO.allMdZip(pages, DB.getBlob); }).then(function (blob) { S3.download(blob, "pages-markdown-" + stamp() + ".zip"); S3.done(); }, failed);
    });
    var n = list().filter(function (p) { return !p.trashed; }).length;
    DB.blobKeys().then(function (keys) {
      var line = n + " page" + (n === 1 ? "" : "s") + " · " + keys.length + " image" + (keys.length === 1 ? "" : "s");
      if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (est) { info.textContent = line + " · about " + S3.fmtBytes(est.usage || 0) + " used on this device"; });
      else info.textContent = line;
    });
    if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(function (yes) {
      if (yes) return;
      persistBtn.hidden = false;
      persistBtn.addEventListener("click", function () { navigator.storage.persist().then(function (ok) { S3.toast(ok ? "The browser will keep your pages" : "The browser said no; keep regular backups"); persistBtn.hidden = !!ok; }); });
    });
  }
  $("#data-btn").addEventListener("click", openData);

  function openKeys() {
    var rows = [["/", "Insert a block"], ["# ␣  ## ␣  ### ␣", "Headings"], ["- ␣ or * ␣", "Bulleted list"], ["1. ␣", "Numbered list"], ["[] ␣", "To-do"], [">> ␣", "Toggle"], ["> ␣", "Quote"],
      ["```", "Code block (then Enter)"], ["---", "Divider"], ["[[", "Mention a page"], ["**bold** *italic* `code` ~~strike~~ ==mark==", "Inline formatting as you type"],
      ["Ctrl+B / I / U / E", "Bold, italic, underline, code"], ["Ctrl+Shift+S / H", "Strikethrough, highlight"], ["Ctrl+K", "Link (with text selected) or search"],
      ["Enter / Shift+Enter", "New block / new line"], ["Tab / Shift+Tab", "Nest / un-nest"], ["Ctrl+Shift+↑ ↓", "Move block"], ["Ctrl+D", "Duplicate block"], ["Ctrl+Alt+0…9", "Turn into text, H1–H3, to-do, list…"],
      ["Esc", "Select the block (then ↑↓, Shift, Del, Ctrl+C)"], ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["Alt+N", "New page"], ["Ctrl+\\", "Show / hide sidebar"]];
    var tbl = h("table", { "class": "tbl" });
    rows.forEach(function (r) { tbl.appendChild(h("tr", null, [h("td", null, [h("kbd", { text: r[0] })]), h("td", { text: r[1] })])); });
    UI.modal("Keyboard shortcuts", h("div", { "class": "tbl-wrap" }, [tbl]), { wide: true });
  }
  $("#keys-btn").addEventListener("click", openKeys);

  // ---------- mobile sidebar ----------
  function closeSide() { document.body.classList.remove("pg-side-open"); }
  $("#menu-btn").addEventListener("click", function () { document.body.classList.toggle("pg-side-open"); });
  $("#scrim").addEventListener("click", closeSide);
  function toggleSide() {
    if (window.innerWidth < 820) document.body.classList.toggle("pg-side-open");
    else { var c = !document.body.classList.contains("pg-side-hidden"); document.body.classList.toggle("pg-side-hidden", c); S3.store("pages.sideHidden", c); }
  }
  $("#side-hide").addEventListener("click", toggleSide);
  $("#side-show").addEventListener("click", toggleSide);

  // ---------- global keys ----------
  document.addEventListener("keydown", function (e) {
    var mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey && (k === "k" || k === "p") && !e.defaultPrevented) {
      if (k === "p" && !$(".pg-app").contains(document.activeElement)) return;
      e.preventDefault(); openSearch();
    } else if (e.altKey && !mod && k === "n") { e.preventDefault(); newPageAndOpen(null); }
    else if (mod && e.key === "\\") { e.preventDefault(); toggleSide(); }
    else if (mod && k === "s") { e.preventDefault(); flush().then(function () { S3.toast("Saved ✓"); }); }
    else if (mod && !e.altKey && (k === "z" || k === "y") && !e.defaultPrevented) {
      var a = document.activeElement;
      if (a === titleEl || !a || a === document.body || ($(".pg-view").contains(a) && !/^(INPUT|TEXTAREA)$/.test(a.tagName))) {
        e.preventDefault();
        if (k === "y" || e.shiftKey) editor.redo(); else editor.undo();
      }
    }
  });

  // ---------- other tabs ----------
  if (bc) bc.onmessage = function (ev) {
    var m = ev.data || {};
    if (m.from === TAB) return;
    if (m.reload) { location.reload(); return; }
    var ids = Array.isArray(m.ids) ? m.ids.filter(function (x) { return typeof x === "string" && P.ID_RE.test(x); }) : [];
    Promise.all(ids.map(function (id) { return DB.getPage(id).then(function (raw) { return { id: id, raw: raw }; }); })).then(function (res) {
      var curChanged = false;
      res.forEach(function (r) {
        if (dirty[r.id]) return; // we have newer local edits
        if (r.raw) pages[r.id] = P.cleanPage(r.raw); else delete pages[r.id];
        if (r.id === cur) curChanged = true;
      });
      renderTree();
      if (!curChanged) return;
      if (!live(cur)) { var f = P.children(pages, null)[0]; if (f) openPage(f.id); return; }
      if ($("#doc").contains(document.activeElement)) {
        var t = S3.toast("This page changed in another tab ");
        t.style.pointerEvents = "auto";
        t.appendChild(h("button", { type: "button", "class": "btn small", text: "Show it", onclick: function () { editor.open(pages[cur]); renderHead(); t.remove(); } }));
      } else { editor.open(pages[cur]); renderHead(); }
    });
  };

  // ---------- demo workspace (first run and README screenshot) ----------
  function T(s) { return P.mdInline(s); }
  function demoPages() {
    var B = function (type, md, props) { var b = P.newBlock(type, props); if (b.text && md != null) b.text = T(md); return b; };
    var gs = P.newPage({ title: "Getting started", icon: "👋", cover: 3, pos: 1, fav: 1 });
    var todo = P.newPage({ title: "To-do list", icon: "✅", pos: 2 });
    var read = P.newPage({ title: "Reading list", icon: "📚", cover: 8, pos: 3 });
    var atlas = P.newPage({ title: "Project Atlas", icon: "🚀", cover: 5, pos: 4, fav: 2 });
    var meet = P.newPage({ title: "Meeting notes", icon: "🗓️", parent: atlas.id, pos: 1 });
    var ideas = P.newPage({ title: "Design ideas", icon: "🎨", parent: atlas.id, pos: 2 });
    var arabic = P.newPage({ title: "ملاحظات بالعربية", icon: "📝", pos: 5 });
    var mention = function (id) { return { t: "@", p: id }; };
    gs.blocks = [
      B("p", "Welcome! **Pages** is a private notebook made of blocks. Everything you write stays in this browser: no account, no server, works offline."),
      B("callout", "Make a backup now and then from **Backup & import** in the sidebar. It is one .zip you can restore anywhere.", { icon: "🔒", color: "blue" }),
      B("h2", "Try it"),
      B("todo", "Click anywhere and start typing", { checked: true }),
      B("todo", "Type `/` to add a heading, list, table, image or page"),
      B("todo", "Type `# ` for a heading, `- ` for a list or `[] ` for a to-do"),
      B("todo", "Drag the ⋮⋮ handle to move a block, Tab to nest it"),
      B("todo", "Press **Ctrl+K** to search every page"),
      B("h2", "Good to know"),
      B("toggle", "Where are my pages stored?", { open: false }),
      B("p", "In this browser's storage (IndexedDB), on this device only. Clearing the site's data deletes them, so keep a backup.", { indent: 1 }),
      B("toggle", "Does it work offline?", { open: true }),
      B("p", "Yes. After the first visit the app opens and saves with no connection at all.", { indent: 1 }),
      B("quote", "Small notes, kept well, add up to a second brain."),
      B("code", null, { lang: "js", code: "// code blocks keep your spacing\nconst greet = (name) => `Hello, ${name}!`;" }),
      B("divider"),
      B("p", null, { text: P.norm([{ t: "See also " }, mention(read.id), { t: " and " }, mention(atlas.id), { t: "." }]) })
    ];
    todo.blocks = [
      B("h2", "Today"),
      B("todo", "Reply to Lina about the venue", { checked: true }),
      B("todo", "Buy groceries"),
      B("todo", "Olive oil, za'atar, lemons", { indent: 1 }),
      B("todo", "Fresh bread", { indent: 1, checked: true }),
      B("todo", "Call the dentist before 4 pm"),
      B("h2", "This week"),
      B("todo", "Finish the Atlas draft"),
      B("todo", "Back up my pages", { checked: true }),
      B("todo", "Plan the weekend trip")
    ];
    read.blocks = [
      B("p", "Books I'm reading or want to read. Click a cell to edit, Tab to move between cells."),
      B("table", null, { header: true, rows: [["Title", "Author", "Status", "Notes"], ["The Pragmatic Programmer", "Hunt & Thomas", "Reading", "Chapter 3"], ["Deep Work", "Cal Newport", "Done", "Plan focus blocks"], ["Atomic Habits", "James Clear", "Next", ""], ["Thinking, Fast and Slow", "Daniel Kahneman", "Next", "Borrow from Sam"]] }),
      B("callout", "Tip: type `/table` anywhere to make your own.", { icon: "💡", color: "yellow" })
    ];
    atlas.blocks = [
      B("h2", "Goal"),
      B("p", "Ship an offline-first field app our team can use with *no signal at all*."),
      B("h2", "Milestones"),
      B("ol", "Interview five field workers"),
      B("ol", "Sketch the main screens"),
      B("ol", "Test a paper prototype"),
      B("ol", "Pick two flows to build first", { indent: 1 }),
      B("h2", "Pages inside"),
      B("page", null, { page: meet.id }),
      B("page", null, { page: ideas.id }),
      B("callout", "Status: ==on track== · next review Thursday", { icon: "📌", color: "green" })
    ];
    meet.blocks = [B("h2", "Kick-off"), B("ul", "Everyone agrees: offline first"), B("ul", "Sam owns research, Lina owns design"), B("todo", "Send the summary to the team")];
    ideas.blocks = [B("p", "Big buttons, high contrast, works in sunlight."), B("ul", "One-hand use"), B("ul", "Sync later, never block the user")];
    arabic.blocks = [
      B("p", "كل كتلة تتبع اتجاه النص تلقائيًا، فتكتب بالعربية أو بالإنجليزية بلا إعدادات."),
      B("ul", "اكتب `/` لإضافة عنوان أو قائمة أو جدول"),
      B("ul", "البحث يتجاهل التشكيل وأشكال الألف: «احمد» تجد «أحمد»"),
      B("todo", "جرّب سحب الكتلة من المقبض ⋮⋮")
    ];
    return [gs, todo, read, atlas, meet, ideas, arabic];
  }
  function seed() {
    var ps = demoPages();
    ps.forEach(function (p) { pages[p.id] = p; dirty[p.id] = 1; });
    setExpanded(ps[3].id, true);
    return flush().then(function () { return ps[0].id; });
  }

  // ---------- boot ----------
  function sizeApp() {
    var top = $(".s3-top"), hgt = top ? top.offsetHeight : 58;
    document.documentElement.style.setProperty("--pg-top", hgt + "px");
  }
  window.addEventListener("resize", S3.debounce(sizeApp, 100));
  editor = window.PEditor($("#blocks"), {
    ctx: ctx, scroller: scroller,
    onChange: function (kind) {
      var p = pages[cur];
      if (!p) return;
      markDirty(p.id);
      if (kind !== "type" && kind !== "format" && kind !== "check") renderTreeSoon();
      if (kind === "undo") { renderHead(true); renderTreeSoon(); } else renderHeadSoon();
    },
    openPage: function (id, focusTitle) { openPage(id, focusTitle); },
    createChild: function () { return createPage(cur).id; },
    pickPage: function (title, filter, cb) { pickPage(title, filter, cb, false); },
    pickEmoji: function (anchor, cb) { emojiPicker(anchor, cb, false); },
    addImage: addImage, blobUrl: blobUrl, downloadBlob: downloadBlob,
    mdCtx: function () { return { title: ctx.title }; }
  });
  var ready = DB.open().then(function (ok) {
    persistent = ok;
    if (!ok) S3.toast("This browser blocks storage here. Pages work, but are lost when you close the tab: use Backup.", "error");
    return DB.allPages();
  }).then(function (raw) {
    raw.forEach(function (r) { var p = P.cleanPage(r); pages[p.id] = p; });
    P.repairTree(pages);
    if (!list().some(function (p) { return !p.trashed; })) return list().length ? createPage(null).id : seed();
    return null;
  }).then(function (firstId) {
    sizeApp();
    if (S3.store("pages.sideHidden")) document.body.classList.add("pg-side-hidden");
    var want = firstId || S3.store("pages.last");
    if (!live(want)) want = (P.children(pages, null)[0] || {}).id;
    openPage(want);
    setStatus(persistent ? "Saved" : "Not saved: storage blocked", !persistent);
    setTimeout(gcBlobs, 4000);
  }).catch(function (e) { setStatus("Couldn't open storage", true); failed(e); });

  window.S3_DEMO = function () {
    return ready.then(function () {
      var gs = list().filter(function (p) { return p.title === "Getting started" && !p.trashed; })[0];
      if (!gs) return seed().then(function (id) { openPage(id); });
      list().forEach(function (p) { if (p.title === "Project Atlas") setExpanded(p.id, true); });
      openPage(gs.id);
      if (document.activeElement) document.activeElement.blur();
    });
  };

  // ---------- self-test (pure logic + DOM sanitising; never touches your stored pages) ----------
  window.S3_SELFTEST = function () {
    var fails = [];
    function ok(name, cond) { if (!cond) fails.push(name); }
    function B(type, text, props) { var b = P.newBlock(type, props); if (b.text && text != null) b.text = P.norm([{ t: text }]); return b; }
    function txt(b) { return P.plain(b.text); }

    // document model: split / merge / move / nesting
    var bl = [B("p", "Hello world")];
    var j = P.splitBlock(bl, 0, 5);
    ok("split", j === 1 && bl.length === 2 && txt(bl[0]) === "Hello" && txt(bl[1]) === " world");
    var mr = P.mergeUp(bl, 1);
    ok("merge", bl.length === 1 && txt(bl[0]) === "Hello world" && mr.offset === 5);
    var li = [B("ul", "item")]; P.splitBlock(li, 0, 4);
    ok("list continues", li[1].type === "ul" && txt(li[1]) === "");
    var tg = [B("toggle", "T", { open: true })]; P.splitBlock(tg, 0, 1);
    ok("toggle child", tg[1].indent === 1);
    var mv = [B("p", "A"), B("p", "B"), B("p", "B1", { indent: 1 }), B("p", "C")];
    P.moveBlock(mv, 1, 4, 0);
    ok("move subtree", mv.map(txt).join() === "A,C,B,B1" && mv[3].indent === 1);
    ok("indent", P.indentBlock(mv, 1) && mv[1].indent === 1 && !P.indentBlock(mv, 0));
    ok("outdent", P.outdentBlock(mv, 1) && mv[1].indent === 0);
    P.moveUp(mv, 1);
    ok("move up", mv.map(txt).join() === "C,A,B,B1");
    P.moveDown(mv, 2);
    ok("move down at end", mv.map(txt).join() === "C,A,B,B1");
    var lay = P.layout([B("toggle", "t", { open: false }), B("p", "in", { indent: 1 }), B("ol", "1"), B("ol", "2"), B("ol", "2a", { indent: 1 }), B("ol", "3")]);
    ok("toggle hides", lay.hidden[1] === true && !lay.hidden[2]);
    ok("numbering", lay.nums[2] === 1 && lay.nums[3] === 2 && lay.nums[4] === 1 && lay.nums[5] === 3 && P.olLabel(2, 1) === "b." && P.olLabel(4, 2) === "iv.");
    var sp = P.toggleMark(P.norm([{ t: "Hello world" }]), 0, 5, "b");
    ok("bold on", P.hasMark(sp, 0, 5, "b") && !P.hasMark(sp, 0, 6, "b"));
    sp = P.toggleMark(sp, 0, 5, "b");
    ok("bold off", sp.length === 1 && !sp[0].b);
    ok("fix indents", P.fixIndents([B("p", "x", { indent: 3 })])[0].indent === 0);

    // markdown shortcuts
    ok("md #", P.mdShortcut("# ").type === "h1" && P.mdShortcut("### ").type === "h3" && P.mdShortcut("#x") === null);
    ok("md lists", P.mdShortcut("- ").type === "ul" && P.mdShortcut("1. ").type === "ol" && P.mdShortcut("[] ").type === "todo" && P.mdShortcut("[x] ").props.checked === true);
    ok("md quote/toggle", P.mdShortcut("> ").type === "quote" && P.mdShortcut(">> ").type === "toggle");
    ok("md code/divider", P.mdShortcut("```js ").props.lang === "js" && P.mdShortcut("---").type === "divider");
    var inl = P.inlineShortcut("a **b**", 7);
    ok("inline bold", inl && inl.mark === "b" && JSON.stringify(P.applyInline(P.norm([{ t: "a **b**" }]), inl)) === JSON.stringify([{ t: "a " }, { t: "b", b: true }]));
    ok("inline code", P.inlineShortcut("x `y`", 5).mark === "c" && P.inlineShortcut("snake_case_", 11) === null && P.inlineShortcut("** **", 5) === null);

    // slash commands
    var sl = [B("p", "/head")];
    P.applySlash(sl, 0, 0, 5, "h2");
    ok("slash turns", sl.length === 1 && sl[0].type === "h2" && txt(sl[0]) === "");
    var sl2 = [B("p", "Note /todo")];
    var sj = P.applySlash(sl2, 0, 5, 10, "todo");
    ok("slash inserts", sj === 1 && sl2.length === 2 && sl2[1].type === "todo" && txt(sl2[0]) === "Note ");
    ok("slash filter", P.slashFilter("todo")[0].id === "todo" && P.slashFilter("h2")[0].id === "h2" && P.slashFilter("zzzz").length === 0 && P.slashFilter("").length === P.SLASH.length);

    // search index
    var pa = P.newPage({ title: "Groceries" }), pb = P.newPage({ title: "Weekend" }), pc = P.newPage({ title: "مَدْرَسَة أحمد" });
    pa.blocks = [B("p", "milk and bread")]; pb.blocks = [B("p", "Buy groceries for the trip"), B("p", "the quick brown fox")];
    var ix = [pa, pb, pc].map(P.indexPage);
    var r1 = P.search(ix, "groceries");
    ok("search title first", r1.length === 2 && r1[0].id === pa.id);
    var r2 = P.search(ix, "brown fox");
    ok("search body", r2.length === 1 && r2[0].id === pb.id && r2[0].hit && r2[0].hit.text.indexOf("fox") >= 0);
    ok("search arabic", P.search(ix, "مدرسة احمد").length === 1 && P.search(ix, "nothing here").length === 0);

    // trash / restore / tree
    var tp = {}, A = P.newPage({ title: "A" }), Bp = P.newPage({ title: "B", parent: A.id }), Cp = P.newPage({ title: "C", parent: Bp.id }), D = P.newPage({ title: "D" });
    [A, Bp, Cp, D].forEach(function (p) { tp[p.id] = p; });
    ok("no cycles", !P.movePage(tp, A.id, Cp.id, null) && P.movePage(tp, D.id, A.id, null) && tp[D.id].parent === A.id);
    P.trashPage(tp, Bp.id, 5);
    P.trashPage(tp, A.id, 6);
    ok("trash", tp[A.id].trashed && tp[Cp.id].trashRoot === Bp.id && tp[D.id].trashRoot === A.id);
    P.restorePage(tp, A.id);
    ok("restore", !tp[A.id].trashed && !tp[D.id].trashed && tp[Bp.id].trashed);
    P.restorePage(tp, Bp.id);
    ok("restore child", !tp[Bp.id].trashed && !tp[Cp.id].trashed && tp[Bp.id].parent === A.id);
    P.trashPage(tp, Bp.id, 7);
    var gone = P.deleteForever(tp, Bp.id);
    ok("delete forever", gone.length === 2 && !tp[Bp.id] && !tp[Cp.id] && tp[A.id]);

    // XSS: hostile text, links and titles stay inert
    var evil = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=1</script>';
    var div = document.createElement("div");
    window.PEditorTest.renderSpans(div, P.cleanSpans([{ t: evil, b: true }, { t: "link", a: "javascript:alert(1)" }, { t: "ok", a: "https://s3eidat.github.io/" }]), ctx);
    ok("xss text inert", !div.querySelector("img,script") && div.textContent.indexOf("<img") === 0);
    ok("javascript: blocked", div.querySelectorAll("a").length === 1 && div.querySelector("a").getAttribute("href") === "https://s3eidat.github.io/");
    ok("safeUrl", P.safeUrl("javascript:alert(1)") === null && P.safeUrl(" JaVa\tScRiPt:alert(1)") === null && P.safeUrl("data:text/html,x") === null && P.safeUrl("vbscript:x") === null && P.safeUrl("//evil.example") === null && P.safeUrl("s3eidat.github.io") === "https://s3eidat.github.io" && P.safeUrl("mailto:a@b.co") === "mailto:a@b.co");
    var inert = new DOMParser().parseFromString('<div><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)><b onclick="alert(1)" style="color:red">y</b><span data-page="bad id!">z</span></div>', "text/html").body.firstChild;
    var rs = window.PEditorTest.readSpans(inert);
    ok("dom read sanitises", rs.foreign && P.plain(rs.spans) === "xy" && !rs.spans.some(function (s) { return s.a || s.p; }) && rs.spans.some(function (s) { return s.b; }));
    ok("md link blocked", !P.mdInline("[x](javascript:alert(1))").some(function (s) { return s.a; }));
    var hp = P.cleanPage({ title: "<script>alert(1)</script>", blocks: [{ type: "script", text: [{ t: "<b>hi</b>", a: "javascript:alert(1)" }] }, { type: "image", blob: "../../x", caption: "<svg onload=1>" }] });
    var html = P.pageToHtml(hp, {});
    ok("html export escapes", html.indexOf("<script>alert") < 0 && html.indexOf("&lt;script&gt;") > 0 && html.indexOf("javascript:") < 0 && html.indexOf("<svg") < 0 && hp.blocks[0].type === "p" && hp.blocks[1].blob === "");
    var trow = row(Object.assign(P.newPage({ title: evil }), { icon: "<b>" }), 0, false);
    ok("sidebar title inert", !trow.querySelector("img,script,b") && trow.textContent.indexOf("<img") >= 0);
    var rt = P.norm([{ t: "a" }, { t: "b", b: true, i: true }, { t: "@", p: pa.id }, { t: "c\nd", a: "https://s3eidat.github.io/" }, { t: "e\n" }]);
    var d2 = document.createElement("div");
    window.PEditorTest.renderSpans(d2, rt, ctx);
    ok("dom round trip", JSON.stringify(window.PEditorTest.readSpans(d2).spans) === JSON.stringify(rt) && window.PEditorTest.measure(d2) === P.len(rt));

    // markdown round trip
    var mdPage = P.mdToPage("# Title\n\n- a\n  - b\n- [x] done\n\n> 💡 tip\n\n| A | B |\n| --- | --- |\n| 1 | 2\\|3 |\n\n```js\nx\n```");
    var again = P.mdToPage(P.pageToMd(P.cleanPage({ title: "Title", blocks: mdPage.blocks })));
    ok("markdown round trip", mdPage.title === "Title" && JSON.stringify(again.blocks.map(function (b) { return [b.type, b.indent]; })) === JSON.stringify(mdPage.blocks.map(function (b) { return [b.type, b.indent]; })) && mdPage.blocks.filter(function (b) { return b.type === "table"; })[0].rows[1][1] === "2|3");

    // workspace backup -> import round trip, with an image
    var png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), function (c) { return c.charCodeAt(0); });
    var w1 = P.newPage({ title: "Root <i>", icon: "🚀", cover: 2, fav: 3 }), w2 = P.newPage({ title: "Child", parent: w1.id });
    var blobId = P.uid();
    w1.blocks = [B("p", "Hi"), P.newBlock("image", { blob: blobId, caption: "pixel" }), P.newBlock("page", { page: w2.id })];
    w2.blocks = [B("todo", "x", { checked: true })];
    w2.blocks[0].text = P.norm([{ t: "see " }, { t: "@", p: w1.id }]);
    var store = {}; store[blobId] = { id: blobId, type: "image/png", name: "pixel.png", blob: new Blob([png], { type: "image/png" }) };
    var fake = P.newPage({ title: "fake" }), fakeId = P.uid();
    fake.blocks = [P.newBlock("image", { blob: fakeId })];
    store[fakeId] = { id: fakeId, type: "image/png", blob: new Blob(["<html><script>alert(1)</script>"], { type: "image/png" }) };
    return IO.backupZip([w1, w2, fake], function (id) { return store[id]; }).then(function (zip) {
      return IO.readBackup(zip);
    }).then(function (res) {
      var byId = {}; res.pages.forEach(function (p) { byId[p.id] = p; });
      ok("roundtrip pages", res.pages.length === 3 && JSON.stringify(byId[w1.id]) === JSON.stringify(P.cleanPage(w1)) && JSON.stringify(byId[w2.id]) === JSON.stringify(P.cleanPage(w2)));
      ok("roundtrip fake image refused", res.blobs.length === 1 && res.blobs[0].id === blobId && res.blobs[0].type === "image/png");
      var re = IO.remap(res.pages, res.blobs), n1 = re.pages.filter(function (p) { return p.title === "Root <i>"; })[0], n2 = re.pages.filter(function (p) { return p.title === "Child"; })[0];
      ok("remap", n1.id !== w1.id && n2.parent === n1.id && n1.blocks[1].blob === re.blobs[0].id && n1.blocks[2].page === n2.id && n2.blocks[0].text[1].p === n1.id);
      return res.blobs[0].blob.arrayBuffer();
    }).then(function (buf) {
      var a = new Uint8Array(buf);
      ok("roundtrip image bytes", a.length === png.length && a.every(function (x, k) { return x === png[k]; }));
      return IO.readBackup(new Blob([JSON.stringify({ app: "s3-pages", pages: [{ id: "<x>", title: 5, blocks: "nope", parent: "zz" }] })]));
    }).then(function (res) {
      ok("hostile json cleaned", res.pages.length === 1 && P.ID_RE.test(res.pages[0].id) && res.pages[0].title === "" && res.pages[0].parent === null && res.pages[0].blocks.length === 1);
      return IO.readBackup(new Blob(['{"hello":1}'])).then(function () { ok("rejects foreign json", false); }, function () { ok("rejects foreign json", true); });
    }).then(function () {
      return fails.length ? fails : true;
    });
  };
})();
