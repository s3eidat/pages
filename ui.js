/* Pages: small UI helpers: floating menus, popovers and modals (keyboard friendly, text via textContent only). */
(function () {
  "use strict";
  var h = S3.h, open = null;

  function place(el, anchor) {
    var r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    el.style.left = "0px"; el.style.top = "0px";
    document.body.appendChild(el);
    var w = el.offsetWidth, ht = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    var x = Math.min(Math.max(8, r.left), vw - w - 8), y = r.bottom + 6;
    if (y + ht > vh - 8) y = Math.max(8, r.top - ht - 6);
    if (y + ht > vh - 8) y = Math.max(8, vh - ht - 8);
    el.style.left = Math.round(x) + "px"; el.style.top = Math.round(y) + "px";
  }
  function close() {
    if (!open) return;
    var o = open; open = null;
    o.el.remove();
    document.removeEventListener("pointerdown", o.outside, true);
    document.removeEventListener("keydown", o.keys, true);
    window.removeEventListener("resize", close);
    if (o.onClose) o.onClose();
    if (o.restore && document.contains(o.restore)) try { o.restore.focus({ preventScroll: true }); } catch (e) { /* gone */ }
  }
  // items: [{label, icon, kbd, hint, danger, checked, onClick}] | {section: "Title"} | {sep: true}
  function menu(anchor, items, opts) {
    close();
    opts = opts || {};
    var el = h("div", { "class": "pg-menu" + (opts.cls ? " " + opts.cls : ""), role: "menu" });
    var buttons = [];
    items.forEach(function (it) {
      if (!it) return;
      if (it.sep) { el.appendChild(h("div", { "class": "pg-menu-sep", role: "separator" })); return; }
      if (it.section) { el.appendChild(h("div", { "class": "pg-menu-sec", text: it.section })); return; }
      if (it.node) { el.appendChild(it.node); return; }
      var b = h("button", { type: "button", "class": "pg-menu-it" + (it.danger ? " danger" : "") + (it.checked ? " on" : ""), role: it.checked != null ? "menuitemcheckbox" : "menuitem" }, [
        h("span", { "class": "pg-menu-ic", text: it.icon || "" }),
        h("span", { "class": "pg-menu-lb" }, [h("span", { text: it.label }), it.hint ? h("small", { text: it.hint }) : null]),
        it.kbd ? h("kbd", { text: it.kbd }) : it.checked ? h("span", { "class": "pg-menu-ck", text: "✓" }) : null
      ]);
      if (it.checked != null) b.setAttribute("aria-checked", String(!!it.checked));
      b.addEventListener("click", function () { if (!it.keep) close(); it.onClick && it.onClick(); });
      buttons.push(b); el.appendChild(b);
    });
    var active = -1;
    function hl(k) { buttons.forEach(function (b, j) { b.classList.toggle("is-active", j === k); }); active = k; if (buttons[k]) buttons[k].scrollIntoView({ block: "nearest" }); }
    var o = {
      el: el, onClose: opts.onClose, restore: opts.restore || document.activeElement,
      outside: function (e) { if (!el.contains(e.target) && !(opts.ignore && opts.ignore.contains(e.target))) close(); },
      keys: function (e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          if (document.activeElement && document.activeElement.tagName === "INPUT" && !opts.navInput) return;
          e.preventDefault(); e.stopPropagation();
          hl((active + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length);
          if (!opts.navInput) buttons[active].focus();
        } else if (e.key === "Enter" && opts.navInput && active >= 0) { e.preventDefault(); e.stopPropagation(); buttons[active].click(); }
      }
    };
    open = o;
    place(el, anchor);
    setTimeout(function () { document.addEventListener("pointerdown", o.outside, true); }, 0);
    document.addEventListener("keydown", o.keys, true);
    window.addEventListener("resize", close);
    if (!opts.noFocus && buttons[0]) { hl(0); buttons[0].focus({ preventScroll: true }); }
    return el;
  }
  // A popover with arbitrary content (icon picker, cover picker, link editor).
  function popover(anchor, content, opts) {
    return menu(anchor, [{ node: content }], Object.assign({ noFocus: true }, opts || {}));
  }
  // Modal dialog. Returns {el, close}. Esc and backdrop click close it.
  function modal(title, body, opts) {
    close();
    opts = opts || {};
    var back = h("div", { "class": "s3-modal pg-modal", role: "dialog", "aria-modal": "true", "aria-label": title });
    var sheet = h("div", { "class": "s3-sheet pg-sheet" + (opts.wide ? " wide" : "") });
    var x = h("button", { "class": "btn ghost icon", type: "button", "aria-label": "Close", html: S3.icon("x") });
    sheet.appendChild(h("div", { "class": "row between pg-sheet-top" }, [h("h2", { text: title }), x]));
    sheet.appendChild(body);
    back.appendChild(sheet);
    var prev = document.activeElement;
    function shut() { back.remove(); document.removeEventListener("keydown", onKey, true); if (opts.onClose) opts.onClose(); if (prev && document.contains(prev)) try { prev.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    function onKey(e) { if (e.key === "Escape" && !open) { e.preventDefault(); e.stopPropagation(); shut(); } }
    back.addEventListener("pointerdown", function (e) { if (e.target === back) shut(); });
    x.addEventListener("click", shut);
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(back);
    var f = body.querySelector("input,button,[tabindex]");
    if (f) f.focus();
    return { el: back, close: shut };
  }

  window.PUI = { menu: menu, popover: popover, modal: modal, close: close, isOpen: function () { return !!open; }, place: place };
})();
