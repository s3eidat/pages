/* Pages: backup, import and export. Uses JSZip (lib/jszip.min.js). Every imported byte is treated as untrusted:
 * pages go through PG.cleanPage, images must be one of a few raster types and are stored as Blobs. */
(function () {
  "use strict";
  var P = window.PG;
  var LIMITS = { file: 1024 * 1024 * 1024, json: 80 * 1024 * 1024, blob: 50 * 1024 * 1024, pages: 20000, md: 5 * 1024 * 1024 };
  var EXT_TYPE = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp" };

  function zipLib() { if (!window.JSZip) throw new Error("Zip support did not load"); return window.JSZip; }
  function extOf(type) { return P.IMAGE_TYPES[type] || "bin"; }
  function sniff(bytes) {
    var b = new Uint8Array(bytes.slice ? bytes.slice(0, 16) : bytes);
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69) return "image/avif";
    if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
    return null;
  }

  // ---------- full backup: workspace.json + blobs/<id>.<ext> ----------
  function backupZip(pages, getBlob) {
    var JSZip = zipLib(), zip = new JSZip(), meta = [];
    var refs = Object.keys(P.blobRefs(pages));
    return Promise.all(refs.map(function (id) {
      return Promise.resolve(getBlob(id)).then(function (rec) {
        if (!rec || !rec.blob) return;
        var file = "blobs/" + id + "." + extOf(rec.type);
        meta.push({ id: id, type: rec.type, name: P.fileName(rec.name, "image").slice(0, 120), size: rec.blob.size, file: file });
        zip.file(file, rec.blob, { compression: "STORE" });
      });
    })).then(function () {
      var doc = { app: "s3-pages", version: 1, exported: new Date().toISOString(), pages: pages, blobs: meta };
      zip.file("workspace.json", JSON.stringify(doc), { compression: "DEFLATE" });
      zip.file("README.txt", "Backup made by Pages (S3eidat Tools). Restore it with Pages > Backup & import > Import.\n" +
        "workspace.json holds every page; blobs/ holds the images.\n");
      return zip.generateAsync({ type: "blob", mimeType: "application/zip" });
    });
  }
  function validateDoc(doc) {
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.pages)) throw new Error("That file is not a Pages backup");
    if (doc.app !== "s3-pages") throw new Error("That file is not a Pages backup");
    if (doc.pages.length > LIMITS.pages) throw new Error("Too many pages in that backup");
    var pages = {};
    doc.pages.forEach(function (raw) { var p = P.cleanPage(raw); if (!pages[p.id]) pages[p.id] = p; });
    P.repairTree(pages);
    return Object.keys(pages).map(function (k) { return pages[k]; });
  }
  // Returns {pages, blobs:[{id,type,name,blob}], kind: "backup"} or throws a readable Error.
  function readBackup(file) {
    if (file.size > LIMITS.file) return Promise.reject(new Error("That file is too large"));
    return file.slice(0, 4).arrayBuffer().then(function (head) {
      var h = new Uint8Array(head);
      if (!(h[0] === 0x50 && h[1] === 0x4b)) {
        if (file.size > LIMITS.json) throw new Error("That file is too large");
        return file.text().then(function (t) {
          var doc; try { doc = JSON.parse(t); } catch (e) { throw new Error("Not valid JSON"); }
          return { pages: validateDoc(doc), blobs: [], kind: "backup" };
        });
      }
      return zipLib().loadAsync(file).then(function (zip) {
        var entry = zip.file("workspace.json");
        if (!entry) return readMdZip(zip);
        return entry.async("string").then(function (t) {
          if (t.length > LIMITS.json) throw new Error("That backup is too large");
          var doc; try { doc = JSON.parse(t); } catch (e) { throw new Error("workspace.json is not valid JSON"); }
          var pages = validateDoc(doc), refs = P.blobRefs(pages), blobs = [];
          var meta = Array.isArray(doc.blobs) ? doc.blobs.slice(0, 50000) : [];
          return Promise.all(meta.map(function (m) {
            if (!m || typeof m.id !== "string" || !P.ID_RE.test(m.id) || !refs[m.id] || typeof m.file !== "string") return;
            var f = zip.file(m.file);
            if (!f || f.dir) return;
            return f.async("uint8array").then(function (bytes) {
              if (bytes.length > LIMITS.blob) return;
              var type = sniff(bytes);
              if (!type) return; // only real raster images get in, whatever the JSON claims
              blobs.push({ id: m.id, type: type, name: typeof m.name === "string" ? m.name.slice(0, 120) : "image", blob: new Blob([bytes], { type: type }) });
            });
          })).then(function () { return { pages: pages, blobs: blobs, kind: "backup" }; });
        });
      });
    });
  }

  // ---------- Markdown files (single .md or a zip of them, e.g. another app's export) ----------
  function titleFromPath(path) {
    var base = path.split("/").pop().replace(/\.(md|markdown|txt)$/i, "");
    return base.replace(/\s+[0-9a-f]{32}$/i, "").trim() || "Untitled";
  }
  function readMdZip(zip) {
    var files = [], imgs = {};
    zip.forEach(function (path, f) {
      if (f.dir || /(^|\/)(__MACOSX|\.)/.test(path)) return;
      if (/\.(md|markdown|txt)$/i.test(path)) files.push({ path: path, f: f });
      else if (EXT_TYPE[(path.split(".").pop() || "").toLowerCase()]) imgs[path] = f;
    });
    if (!files.length) throw new Error("No workspace.json or Markdown files in that zip");
    files = files.slice(0, LIMITS.pages);
    var byFolder = {}, pages = [], blobs = [];
    return Promise.all(files.map(function (x) {
      return x.f.async("string").then(function (t) {
        if (t.length > LIMITS.md) t = t.slice(0, LIMITS.md);
        var r = P.mdToPage(t), p = P.newPage({ title: r.title || titleFromPath(x.path) });
        p.blocks = r.blocks;
        x.page = p;
        byFolder[x.path.replace(/\.(md|markdown|txt)$/i, "")] = p;
        pages.push(p);
      });
    })).then(function () {
      // nest: "A/B.md" goes under "A.md" when it exists
      files.forEach(function (x, k) {
        var dir = x.path.split("/").slice(0, -1).join("/");
        var parent = byFolder[dir];
        if (parent && parent !== x.page) x.page.parent = parent.id;
        x.page.pos = k + 1;
      });
      var jobs = [];
      files.forEach(function (x) {
        var dir = x.path.split("/").slice(0, -1);
        x.page.blocks.forEach(function (b) {
          if (b.type !== "image" || !b._src) return;
          var src; try { src = decodeURIComponent(b._src); } catch (e) { src = b._src; }
          if (/^[a-z]+:/i.test(src)) return;
          var parts = dir.slice();
          src.split("/").forEach(function (seg) { if (seg === "..") parts.pop(); else if (seg && seg !== ".") parts.push(seg); });
          var f = imgs[parts.join("/")];
          if (!f) return;
          jobs.push(f.async("uint8array").then(function (bytes) {
            var type = sniff(bytes);
            if (!type || bytes.length > LIMITS.blob) return;
            var id = P.uid();
            blobs.push({ id: id, type: type, name: parts[parts.length - 1], blob: new Blob([bytes], { type: type }) });
            b.blob = id;
          }));
        });
      });
      return Promise.all(jobs);
    }).then(function () {
      pages.forEach(function (p) { p.blocks = P.unresolvedImages(p.blocks).map(P.cleanBlock); });
      return { pages: pages, blobs: blobs, kind: "markdown" };
    });
  }
  function readMdFile(file) {
    if (file.size > LIMITS.md) return Promise.reject(new Error(file.name + " is too large"));
    return file.text().then(function (t) {
      var r = P.mdToPage(t), p = P.newPage({ title: r.title || titleFromPath(file.name) });
      p.blocks = P.unresolvedImages(r.blocks).map(P.cleanBlock);
      return p;
    });
  }

  // Give everything new ids so an import never overwrites or collides with what is already here.
  function remap(pages, blobs) {
    var pm = {}, bm = {};
    pages.forEach(function (p) { pm[p.id] = P.uid(); });
    blobs.forEach(function (b) { bm[b.id] = P.uid(); });
    var outPages = pages.map(function (p) {
      var q = JSON.parse(JSON.stringify(p));
      q.id = pm[p.id];
      q.parent = p.parent && pm[p.parent] ? pm[p.parent] : null;
      q.trashRoot = p.trashRoot && pm[p.trashRoot] ? pm[p.trashRoot] : null;
      if (!q.trashRoot) q.trashed = 0;
      q.blocks.forEach(function (b) {
        if (b.type === "image" && b.blob) b.blob = bm[b.blob] || "";
        if (b.type === "page" && b.page && pm[b.page]) b.page = pm[b.page];
        if (b.text) b.text.forEach(function (s) { if (s.p && pm[s.p]) s.p = pm[s.p]; });
      });
      return q;
    });
    var outBlobs = blobs.map(function (b) { return { id: bm[b.id], type: b.type, name: b.name, blob: b.blob }; });
    return { pages: outPages, blobs: outBlobs };
  }

  // ---------- exports ----------
  function ctxFor(pagesMap, opts) {
    opts = opts || {};
    return {
      title: function (id) { var p = pagesMap[id]; return p ? (p.title || "Untitled") : "Missing page"; },
      icon: function (id) { var p = pagesMap[id]; return (p && p.icon) || "📄"; },
      link: opts.link || function () { return ""; },
      img: opts.img || function () { return ""; },
      cover: opts.cover
    };
  }
  function imagesOf(page) { return page.blocks.filter(function (b) { return b.type === "image" && b.blob; }).map(function (b) { return b.blob; }); }
  function blobToDataUrl(blob) {
    return new Promise(function (res) { var r = new FileReader(); r.onload = function () { res(String(r.result)); }; r.onerror = function () { res(""); }; r.readAsDataURL(blob); });
  }
  function pageHtml(page, pagesMap, getBlob) {
    var urls = {};
    return Promise.all(imagesOf(page).map(function (id) {
      return Promise.resolve(getBlob(id)).then(function (rec) { return rec && rec.blob ? blobToDataUrl(rec.blob) : ""; }).then(function (u) { if (/^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/.test(u)) urls[id] = u; });
    })).then(function () {
      return P.pageToHtml(page, ctxFor(pagesMap, { img: function (id) { return urls[id] || ""; }, cover: page.cover != null ? P.COVERS[page.cover] : "" }));
    });
  }
  // One page → .md (or .zip with images/ when it has pictures). Resolves {blob, name}.
  function pageMd(page, pagesMap, getBlob) {
    var ids = imagesOf(page), base = P.fileName(page.title);
    if (!ids.length) return Promise.resolve({ blob: new Blob([P.pageToMd(page, ctxFor(pagesMap))], { type: "text/markdown;charset=utf-8" }), name: base + ".md" });
    var zip = new (zipLib())(), types = {};
    return Promise.all(ids.map(function (id) {
      return Promise.resolve(getBlob(id)).then(function (rec) { if (rec && rec.blob) { types[id] = rec.type; zip.file("images/" + id + "." + extOf(rec.type), rec.blob); } });
    })).then(function () {
      zip.file(base + ".md", P.pageToMd(page, ctxFor(pagesMap, { img: function (id) { return types[id] ? "images/" + id + "." + extOf(types[id]) : ""; } })));
      return zip.generateAsync({ type: "blob", mimeType: "application/zip" });
    }).then(function (blob) { return { blob: blob, name: base + ".zip" }; });
  }
  // Every live page as Markdown in folders that mirror the sidebar, plus images/.
  function allMdZip(pagesMap, getBlob) {
    var zip = new (zipLib())(), paths = {}, used = {}, types = {};
    function pathOf(id) {
      if (paths[id]) return paths[id];
      var p = pagesMap[id], dir = p.parent && pagesMap[p.parent] && !pagesMap[p.parent].trashed ? pathOf(p.parent).replace(/\.md$/, "") + "/" : "";
      var name = P.fileName(p.title), out = dir + name + ".md", n = 2;
      while (used[out.toLowerCase()]) out = dir + name + " (" + n++ + ").md";
      used[out.toLowerCase()] = 1;
      return (paths[id] = out);
    }
    var live = Object.keys(pagesMap).map(function (k) { return pagesMap[k]; }).filter(function (p) { return !p.trashed; });
    live.sort(function (a, b) { return a.created - b.created; }).forEach(function (p) { pathOf(p.id); });
    var ids = Object.keys(P.blobRefs(live));
    return Promise.all(ids.map(function (id) {
      return Promise.resolve(getBlob(id)).then(function (rec) { if (rec && rec.blob) { types[id] = rec.type; zip.file("images/" + id + "." + extOf(rec.type), rec.blob); } });
    })).then(function () {
      live.forEach(function (p) {
        var depth = paths[p.id].split("/").length - 1, up = new Array(depth + 1).join("../");
        var rel = function (target) { return up + target.split("/").map(encodeURIComponent).join("/"); };
        zip.file(paths[p.id], P.pageToMd(p, ctxFor(pagesMap, {
          link: function (id) { return paths[id] ? rel(paths[id]) : ""; },
          img: function (id) { return types[id] ? rel("images/" + id + "." + extOf(types[id])) : ""; }
        })));
      });
      return zip.generateAsync({ type: "blob", mimeType: "application/zip" });
    });
  }

  window.PIO = { backupZip: backupZip, readBackup: readBackup, readMdFile: readMdFile, readMdZip: readMdZip, remap: remap, pageHtml: pageHtml, pageMd: pageMd, allMdZip: allMdZip, sniff: sniff, LIMITS: LIMITS };
})();
