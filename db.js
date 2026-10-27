/* Pages: storage. IndexedDB on this device only ("pages" = page objects, "blobs" = images as Blobs).
 * If IndexedDB is blocked (some private modes), everything still works in memory and the app says so. */
(function () {
  "use strict";
  var NAME = "s3-pages", db = null, mem = null;

  function open() {
    return new Promise(function (res) {
      var done = false;
      function fallback() { if (done) return; done = true; mem = { pages: {}, blobs: {} }; res(false); }
      try {
        var r = indexedDB.open(NAME, 1);
        r.onupgradeneeded = function () {
          var d = r.result;
          if (!d.objectStoreNames.contains("pages")) d.createObjectStore("pages", { keyPath: "id" });
          if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "id" });
        };
        r.onsuccess = function () {
          if (done) return; done = true; db = r.result;
          db.onversionchange = function () { db.close(); };
          res(true);
        };
        r.onerror = fallback;
        r.onblocked = fallback;
        setTimeout(fallback, 4000);
      } catch (e) { fallback(); }
    });
  }
  function req(store, mode, fn) {
    if (mem) return Promise.resolve(fn(null, mem[store]));
    return new Promise(function (res, rej) {
      var t = db.transaction(store, mode), s = t.objectStore(store), out;
      var r = fn(s, null);
      if (r && "onsuccess" in r) r.onsuccess = function () { out = r.result; };
      t.oncomplete = function () { res(out); };
      t.onerror = t.onabort = function () { rej(t.error || new Error("Storage error")); };
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var DB = {
    open: open,
    persistent: function () { return !mem; },
    allPages: function () {
      return req("pages", "readonly", function (s, m) { return m ? Object.keys(m).map(function (k) { return clone(m[k]); }) : s.getAll(); }).then(function (r) { return r || []; });
    },
    getPage: function (id) {
      return req("pages", "readonly", function (s, m) { return m ? (m[id] ? clone(m[id]) : undefined) : s.get(id); });
    },
    putPages: function (arr) {
      return req("pages", "readwrite", function (s, m) { arr.forEach(function (p) { if (m) m[p.id] = clone(p); else s.put(p); }); });
    },
    deletePages: function (ids) {
      return req("pages", "readwrite", function (s, m) { ids.forEach(function (id) { if (m) delete m[id]; else s.delete(id); }); });
    },
    getBlob: function (id) {
      return req("blobs", "readonly", function (s, m) { return m ? m[id] : s.get(id); });
    },
    putBlob: function (rec) {
      return req("blobs", "readwrite", function (s, m) { if (m) m[rec.id] = rec; else s.put(rec); });
    },
    blobKeys: function () {
      return req("blobs", "readonly", function (s, m) { return m ? Object.keys(m) : s.getAllKeys(); }).then(function (r) { return r || []; });
    },
    deleteBlobs: function (ids) {
      return req("blobs", "readwrite", function (s, m) { ids.forEach(function (id) { if (m) delete m[id]; else s.delete(id); }); });
    },
    clear: function () {
      return req("pages", "readwrite", function (s, m) { if (m) mem.pages = {}; else s.clear(); })
        .then(function () { return req("blobs", "readwrite", function (s, m) { if (m) mem.blobs = {}; else s.clear(); }); });
    }
  };
  window.PDB = DB;
})();
