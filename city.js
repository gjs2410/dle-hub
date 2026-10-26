// DLE City — a pixel-art isometric city that grows from your play history.
//
// Every solved game adds a building whose kind depends on the game's category (Words ->
// library, Geography -> lighthouse, Music -> concert hall, ...); a failed game adds a tree,
// so a bad day still grows something. Your streak powers the city: while it's alive the
// windows and street lamps light up at night and cars drive around; when it breaks, the
// city goes dark (never destroyed) until you play again. Milestones swap the landmark in
// the central plaza. Nothing is stored — the city is rebuilt from history every time.
//
// Everything is drawn into a small low-resolution canvas and scaled up with
// nearest-neighbour sampling, which is what gives it the pixel look.
//
// API (window.DLECity):
//   build(events, { streak, playedToday }) -> model
//       events: [{ id, name, category, date, solved, label, firstTime }] oldest first
//   mount(canvas, model, { onPick(info|null) }) -> { fit(), zoomBy(n), destroy(), png() }
//   preview(canvas, model)   static, fitted render (front-page card)
(function () {
  "use strict";

  var TW = 16, TH = 8;   // tile size in low-res pixels (2:1 isometric)
  var BLOCK = 3;         // lots per block side
  var PERIOD = BLOCK + 1; // + one road tile between blocks
  var FLOOR = 4;         // px per floor

  // ---------- colour helpers ----------
  function hexToRgb(h) {
    var n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }
  // f < 1 darkens, f > 1 lightens (towards white)
  function shade(hex, f) {
    var c = hexToRgb(hex);
    return rgb(c.map(function (v) {
      return Math.max(0, Math.min(255, Math.round(f <= 1 ? v * f : v + (255 - v) * (f - 1))));
    }));
  }
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // ---------- building kinds, by category ----------
  // body: wall colour; roof: "hip" | "flat" | "dome" | "spire" | "battle" | "glass";
  // floors: [min, max]; f: footprint (fraction of the tile); extra: a signature detail.
  var KINDS = {
    "Words":            { label: "Library",       body: "#b5533c", roof: "hip",    roofC: "#6b2f22", floors: [2, 3], f: .82 },
    "Math/Logic":       { label: "Clock tower",   body: "#5b5bd6", roof: "spire",  roofC: "#2e2e7a", floors: [4, 7], f: .5, extra: "clock" },
    "Geography":        { label: "Lighthouse",    body: "#f4efe3", roof: "dome",   roofC: "#c2593a", floors: [5, 7], f: .42, extra: "stripes" },
    "Video Games":      { label: "Arcade",        body: "#2f3a2f", roof: "flat",   roofC: "#1d241d", floors: [2, 3], f: .82, extra: "neon" },
    "Movies/TV":        { label: "Cinema",        body: "#7c3aed", roof: "flat",   roofC: "#4c1d95", floors: [2, 3], f: .86, extra: "marquee" },
    "Music":            { label: "Concert hall",  body: "#0e7490", roof: "dome",   roofC: "#67e8f9", floors: [2, 3], f: .8 },
    "Sports":           { label: "Stadium",       body: "#d6d3d1", roof: "field",  roofC: "#3f9142", floors: [1, 1], f: .96 },
    "Trivia":           { label: "Museum",        body: "#e7dcc6", roof: "hip",    roofC: "#9a7b4f", floors: [2, 3], f: .86, extra: "columns" },
    "Estimation":       { label: "Market",        body: "#059669", roof: "flat",   roofC: "#065f46", floors: [1, 2], f: .8, extra: "awning" },
    "Shapes/Patterns":  { label: "Gallery",       body: "#0284c7", roof: "flat",   roofC: "#0c4a6e", floors: [3, 5], f: .66, extra: "cube" },
    "History":          { label: "Keep",          body: "#a8a29e", roof: "battle", roofC: "#78716c", floors: [3, 5], f: .7 },
    "Card/Board Games": { label: "Game house",    body: "#ca8a04", roof: "dome",   roofC: "#fde047", floors: [2, 3], f: .78 },
    "Science/Nature":   { label: "Greenhouse",    body: "#a7f3d0", roof: "glass",  roofC: "#34d399", floors: [1, 2], f: .86 },
    "Colors":           { label: "Paint studio",  body: "#c026d3", roof: "hip",    roofC: "#facc15", floors: [2, 3], f: .74, extra: "rainbow" },
    "Food":             { label: "Café",          body: "#b45309", roof: "flat",   roofC: "#78350f", floors: [1, 2], f: .78, extra: "awning" },
    "Vehicles":         { label: "Garage",        body: "#64748b", roof: "flat",   roofC: "#334155", floors: [1, 2], f: .9, extra: "door" },
    "Novelty":          { label: "Funhouse",      body: "#e11d48", roof: "spire",  roofC: "#fbbf24", floors: [2, 4], f: .6 },
  };
  var HOUSE = { label: "House", body: "#d6c7b0", roof: "hip", roofC: "#9c442a", floors: [1, 3], f: .7 };
  var HOUSE_COLORS = ["#d6c7b0", "#e8d5c4", "#c9b79c", "#f1e3c8", "#bfae95"];

  // Central-plaza landmark by total solved games.
  var LANDMARKS = [
    { at: 0,   label: "Flagpole",    kind: "flag" },
    { at: 5,   label: "Fountain",    kind: "fountain" },
    { at: 25,  label: "Town hall",   kind: "hall" },
    { at: 100, label: "Castle",      kind: "castle" },
    { at: 250, label: "DLE Tower",   kind: "tower" },
  ];

  // ---------- layout ----------
  // Blocks spiral out from the plaza at (0,0), ring by ring, in angle order; lots fill
  // each block front-to-back. Event n goes on lot n.
  function blockOrder(count) {
    var out = [], r = 1;
    while (out.length < count) {
      var ring = [];
      for (var bx = -r; bx <= r; bx++) for (var by = -r; by <= r; by++) {
        if (Math.max(Math.abs(bx), Math.abs(by)) === r) ring.push([bx, by]);
      }
      ring.sort(function (a, b) { return Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]); });
      out = out.concat(ring);
      r++;
    }
    return out.slice(0, count);
  }

  function build(events, opts) {
    opts = opts || {};
    var lotsPerBlock = BLOCK * BLOCK;
    var blocks = blockOrder(Math.max(1, Math.ceil(events.length / lotsPerBlock)));
    var items = [];
    var solvedCount = 0;
    events.forEach(function (ev, i) {
      var b = blocks[Math.floor(i / lotsPerBlock)];
      var lot = i % lotsPerBlock;
      var x = b[0] * PERIOD + (lot % BLOCK), y = b[1] * PERIOD + Math.floor(lot / BLOCK);
      var h = hash(ev.id + "|" + ev.date);
      if (ev.solved) {
        solvedCount++;
        var k = KINDS[ev.category] || HOUSE;
        var floors = k.floors[0] + (h % (k.floors[1] - k.floors[0] + 1));
        items.push({ type: "building", x: x, y: y, kind: k, floors: floors, h: h, ev: ev,
          body: k === HOUSE ? HOUSE_COLORS[h % HOUSE_COLORS.length] : k.body });
      } else {
        items.push({ type: "tree", x: x, y: y, h: h, ev: ev });
      }
    });
    var landmark = LANDMARKS[0];
    LANDMARKS.forEach(function (l) { if (solvedCount >= l.at) landmark = l; });
    var next = null;
    for (var i = 0; i < LANDMARKS.length; i++) if (LANDMARKS[i].at > solvedCount) { next = LANDMARKS[i]; break; }

    // The developed area: every block used, plus the plaza, plus a one-block margin.
    var minB = [0, 0], maxB = [0, 0];
    blocks.forEach(function (b) {
      minB = [Math.min(minB[0], b[0]), Math.min(minB[1], b[1])];
      maxB = [Math.max(maxB[0], b[0]), Math.max(maxB[1], b[1])];
    });
    return {
      items: items,
      bounds: { x0: (minB[0] - 1) * PERIOD - 1, y0: (minB[1] - 1) * PERIOD - 1, x1: (maxB[0] + 2) * PERIOD - 1, y1: (maxB[1] + 2) * PERIOD - 1 },
      usedBlocks: blocks,
      landmark: landmark,
      nextLandmark: next,
      solved: solvedCount,
      failed: events.length - solvedCount,
      districts: Object.keys(events.reduce(function (m, e) { if (e.solved) m[e.category] = 1; return m; }, {})).length,
      streak: opts.streak || 0,
      powered: (opts.streak || 0) > 0 || !!opts.playedToday,
    };
  }

  // ---------- drawing primitives (low-res context) ----------
  var ORIGIN = { x: 0, y: 0 }; // set per render so all coordinates are positive
  function tileTop(x, y) {
    return { x: ORIGIN.x + (x - y) * TW / 2, y: ORIGIN.y + (x + y) * TH / 2 };
  }
  function poly(ctx, pts, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(Math.round(pts[0][0]), Math.round(pts[0][1]));
    for (var i = 1; i < pts.length; i++) ctx.lineTo(Math.round(pts[i][0]), Math.round(pts[i][1]));
    ctx.closePath();
    ctx.fill();
  }
  function px(ctx, x, y, c, w, h) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w || 1, h || 1); }

  // Ground tiles overlap their neighbours by a pixel, or anti-aliased edges leave light seams.
  function diamond(ctx, x, y, fill, edge) {
    var t = tileTop(x, y);
    poly(ctx, [[t.x, t.y - 0.5], [t.x + TW / 2 + 1, t.y + TH / 2], [t.x, t.y + TH + 0.5], [t.x - TW / 2 - 1, t.y + TH / 2]], fill);
    if (edge) { px(ctx, t.x - 1, t.y + TH - 1, edge, 2, 1); }
  }

  // A box on tile (x, y): footprint f of the tile, height hgt px. Returns its corners.
  function box(ctx, x, y, f, hgt, top, left, right) {
    var t = tileTop(x, y);
    var cx = t.x, cy = t.y + TH / 2, a = TW / 2 * f, b = TH / 2 * f;
    var T = [cx, cy - b], R = [cx + a, cy], B = [cx, cy + b], L = [cx - a, cy];
    var up = function (p) { return [p[0], p[1] - hgt]; };
    poly(ctx, [L, B, up(B), up(L)], left);
    poly(ctx, [B, R, up(R), up(B)], right);
    poly(ctx, [up(T), up(R), up(B), up(L)], top);
    return { T: T, R: R, B: B, L: L, cx: cx, cy: cy, a: a, b: b, top: cy - b - hgt };
  }

  // Windows: one pixel per window, on both visible faces, per floor.
  function windows(ctx, c, floors, color, step) {
    step = step || 0.34;
    for (var fl = 0; fl < floors; fl++) {
      var dy = fl * FLOOR + 2;
      for (var t = 0.25; t < 0.9; t += step) {
        px(ctx, c.L[0] + (c.B[0] - c.L[0]) * t, c.L[1] + (c.B[1] - c.L[1]) * t - dy - 1, color);
        px(ctx, c.B[0] + (c.R[0] - c.B[0]) * t, c.B[1] + (c.R[1] - c.B[1]) * t - dy - 1, color);
      }
    }
  }

  function drawBuilding(ctx, it, theme) {
    var k = it.kind, hgt = it.floors * FLOOR + 2;
    var body = it.body;
    var night = theme.night, lit = night && theme.powered;
    var dim = night ? 0.55 : 1;
    var c = box(ctx, it.x, it.y, k.f, hgt, shade(body, 1.18 * dim), shade(body, 0.92 * dim), shade(body, 0.72 * dim));

    // signature details
    if (k.extra === "stripes") {
      for (var fl = 1; fl < it.floors; fl += 2) {
        var yy = fl * FLOOR + 2;
        poly(ctx, [[c.L[0], c.L[1] - yy], [c.B[0], c.B[1] - yy], [c.B[0], c.B[1] - yy - FLOOR], [c.L[0], c.L[1] - yy - FLOOR]], shade("#c2593a", 0.95 * dim));
        poly(ctx, [[c.B[0], c.B[1] - yy], [c.R[0], c.R[1] - yy], [c.R[0], c.R[1] - yy - FLOOR], [c.B[0], c.B[1] - yy - FLOOR]], shade("#c2593a", 0.75 * dim));
      }
    }
    if (k.extra === "awning") {
      poly(ctx, [[c.L[0], c.L[1] - 3], [c.B[0], c.B[1] - 3], [c.B[0], c.B[1] - 5], [c.L[0], c.L[1] - 5]], shade((it.h & 1) ? "#fde68a" : "#fecaca", dim));
      poly(ctx, [[c.B[0], c.B[1] - 3], [c.R[0], c.R[1] - 3], [c.R[0], c.R[1] - 5], [c.B[0], c.B[1] - 5]], shade((it.h & 1) ? "#f59e0b" : "#ef4444", dim));
    }
    if (k.extra === "rainbow") {
      ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6"].forEach(function (col, i) {
        px(ctx, c.B[0] - 2 + i, c.B[1] - hgt + 2, shade(col, dim));
      });
    }
    if (k.extra === "columns") {
      for (var t = 0.15; t < 1; t += 0.28) px(ctx, c.L[0] + (c.B[0] - c.L[0]) * t, c.L[1] + (c.B[1] - c.L[1]) * t - hgt + 1, shade("#fffaf0", dim), 1, hgt - 2);
    }
    if (k.extra === "door") {
      poly(ctx, [[c.B[0] + 1, c.B[1] - 0.5], [c.R[0] - 1, c.R[1] + 0.5], [c.R[0] - 1, c.R[1] - 4], [c.B[0] + 1, c.B[1] - 5]], shade("#1f2937", dim));
    }

    // windows
    if (k.roof !== "field" && k.roof !== "glass" && k.extra !== "columns") {
      windows(ctx, c, it.floors, lit ? ((it.h >> 3) % 5 ? "#fde68a" : "#fca5a5") : shade("#1c1917", night ? 0.9 : 1.6), k.f < 0.6 ? 0.5 : 0.34);
    }

    // roofs
    var top = [c.cx, c.top + c.b];
    if (k.roof === "hip") {
      var apex = [c.cx, c.cy - hgt - c.b - 4];
      poly(ctx, [[c.L[0], c.L[1] - hgt], [c.B[0], c.B[1] - hgt], apex], shade(k.roofC, 0.95 * dim));
      poly(ctx, [[c.B[0], c.B[1] - hgt], [c.R[0], c.R[1] - hgt], apex], shade(k.roofC, 0.75 * dim));
    } else if (k.roof === "spire") {
      var sp = [c.cx, c.cy - hgt - 12];
      poly(ctx, [[c.L[0], c.L[1] - hgt], [c.B[0], c.B[1] - hgt], sp], shade(k.roofC, 1.0 * dim));
      poly(ctx, [[c.B[0], c.B[1] - hgt], [c.R[0], c.R[1] - hgt], sp], shade(k.roofC, 0.78 * dim));
      if (k.extra === "clock") { px(ctx, c.cx - 2, c.cy - hgt + 2, shade("#f4efe3", dim), 2, 2); }
    } else if (k.roof === "dome") {
      ctx.fillStyle = shade(k.roofC, dim);
      ctx.beginPath();
      ctx.ellipse(Math.round(c.cx), Math.round(c.cy - hgt), Math.max(2, Math.round(c.a * 0.8)), Math.max(2, Math.round(c.a * 0.7)), 0, Math.PI, 0);
      ctx.fill();
      if (k.extra === "stripes") px(ctx, c.cx - 1, c.cy - hgt - 3, lit || !night ? "#fde047" : "#57534e", 2, 2); // the lamp
    } else if (k.roof === "battle") {
      [c.L, c.B, c.R].forEach(function (p) { px(ctx, p[0] - 1, p[1] - hgt - 2, shade(k.roofC, dim), 2, 2); });
      px(ctx, c.cx - 1, c.cy - hgt - c.b - 2, shade(k.roofC, dim), 2, 2);
    } else if (k.roof === "field") {
      var g = tileTop(it.x, it.y);
      poly(ctx, [[g.x, g.y + TH / 2 - 2.6 - hgt + 1], [g.x + 5, g.y + TH / 2 - hgt + 1], [g.x, g.y + TH / 2 + 2.6 - hgt + 1], [g.x - 5, g.y + TH / 2 - hgt + 1]], shade(k.roofC, dim));
      px(ctx, g.x, g.y + TH / 2 - hgt, shade("#ffffff", dim));
    } else if (k.roof === "glass") {
      var ap = [c.cx, c.cy - hgt - c.b - 3];
      poly(ctx, [[c.L[0], c.L[1] - hgt], [c.B[0], c.B[1] - hgt], ap], shade(k.roofC, 1.2 * dim));
      poly(ctx, [[c.B[0], c.B[1] - hgt], [c.R[0], c.R[1] - hgt], ap], shade(k.roofC, 0.95 * dim));
    }
    if (k.extra === "neon") px(ctx, c.L[0] + 2, c.L[1] - hgt + 3, lit ? "#4ade80" : shade("#4ade80", dim * 0.7), 3, 1);
    if (k.extra === "marquee") px(ctx, c.B[0] + 1, c.B[1] - 7, lit || !night ? "#fde047" : "#a16207", 4, 2);
    if (k.extra === "cube") box(ctx, it.x, it.y, 0.3, hgt + 4, shade("#f472b6", dim), shade("#db2777", dim), shade("#9d174d", dim));

    // first time playing this game: a little pennant
    if (it.ev.firstTime) {
      var pole = [c.cx + 2, c.cy - hgt - c.b - 1];
      px(ctx, pole[0], pole[1] - 5, shade("#44403c", dim), 1, 5);
      px(ctx, pole[0] + 1, pole[1] - 5, shade("#c2593a", dim), 3, 2);
    }
    it.bbox = { x0: c.cx - c.a - 1, x1: c.cx + c.a + 1, y0: c.cy - hgt - c.b - 12, y1: c.cy + c.b + 1 };
  }

  function drawTree(ctx, it, theme) {
    var t = tileTop(it.x, it.y);
    var dim = theme.night ? 0.55 : 1;
    var ox = ((it.h % 5) - 2), oy = ((it.h >> 4) % 3) - 1;
    var cx = t.x + ox, cy = t.y + TH / 2 + oy;
    px(ctx, cx, cy - 3, shade("#6b4423", dim), 1, 3);
    var leaf = ["#3f9142", "#4d7c0f", "#15803d"][it.h % 3];
    ctx.fillStyle = shade(leaf, dim);
    ctx.beginPath(); ctx.arc(Math.round(cx), Math.round(cy - 5), 2.6, 0, Math.PI * 2); ctx.fill();
    px(ctx, cx - 1, cy - 7, shade(leaf, 1.25 * dim));
    it.bbox = { x0: cx - 4, x1: cx + 4, y0: cy - 9, y1: cy + 1 };
  }

  function drawLandmark(ctx, model, theme) {
    var dim = theme.night ? 0.55 : 1, lit = theme.night && theme.powered;
    var kind = model.landmark.kind;
    // the plaza block (0,0) is paved
    for (var x = 0; x < BLOCK; x++) for (var y = 0; y < BLOCK; y++) diamond(ctx, x, y, shade(((x + y) & 1) ? "#d6cbb8" : "#cbbfa9", dim));
    var info = { type: "landmark", label: model.landmark.label };
    var c;
    if (kind === "flag") {
      var t = tileTop(1, 1);
      px(ctx, t.x, t.y - 8, shade("#44403c", dim), 1, 12);
      px(ctx, t.x + 1, t.y - 8, shade("#c2593a", dim), 5, 3);
      info.bbox = { x0: t.x - 4, x1: t.x + 8, y0: t.y - 10, y1: t.y + 6 };
    } else if (kind === "fountain") {
      c = box(ctx, 1, 1, 0.9, 2, shade("#7dd3fc", dim), shade("#a8a29e", dim), shade("#78716c", dim));
      px(ctx, c.cx, c.cy - 8, shade("#bae6fd", dim), 1, 6);
      px(ctx, c.cx - 1, c.cy - 9, shade("#e0f2fe", dim), 3, 1);
      info.bbox = { x0: c.cx - 9, x1: c.cx + 9, y0: c.cy - 11, y1: c.cy + 5 };
    } else if (kind === "hall") {
      c = box(ctx, 1, 1, 2.2, 14, shade("#f4efe3", dim), shade("#e7dcc6", dim), shade("#cbbd9f", dim));
      windows(ctx, c, 3, lit ? "#fde68a" : shade("#57534e", dim), 0.16);
      var ap = [c.cx, c.cy - 14 - c.b - 8];
      poly(ctx, [[c.L[0], c.L[1] - 14], [c.B[0], c.B[1] - 14], ap], shade("#9c442a", dim));
      poly(ctx, [[c.B[0], c.B[1] - 14], [c.R[0], c.R[1] - 14], ap], shade("#6b2f22", dim));
      px(ctx, ap[0], ap[1] - 6, shade("#44403c", dim), 1, 6);
      px(ctx, ap[0] + 1, ap[1] - 6, shade("#c2593a", dim), 4, 2);
      info.bbox = { x0: c.cx - c.a, x1: c.cx + c.a, y0: ap[1] - 6, y1: c.cy + c.b };
    } else if (kind === "castle" || kind === "tower") {
      var tall = kind === "tower" ? 46 : 22;
      c = box(ctx, 1, 1, 2.3, 10, shade("#a8a29e", dim), shade("#8b8580", dim), shade("#6b6560", dim));
      [[0, 0], [2, 0], [0, 2], [2, 2]].forEach(function (p) {
        var tc = box(ctx, p[0], p[1], 0.5, 16, shade("#b8b2ad", dim), shade("#8b8580", dim), shade("#6b6560", dim));
        px(ctx, tc.cx - 2, tc.cy - 18, shade("#78716c", dim), 4, 2);
      });
      var k = box(ctx, 1, 1, 0.9, tall, shade(kind === "tower" ? "#c2593a" : "#d6d3d1", dim), shade(kind === "tower" ? "#9c442a" : "#a8a29e", dim), shade(kind === "tower" ? "#6b2f22" : "#78716c", dim));
      windows(ctx, k, Math.floor(tall / FLOOR), lit ? "#fde68a" : shade("#292524", dim), 0.5);
      var spire = [k.cx, k.cy - tall - 12];
      poly(ctx, [[k.L[0], k.L[1] - tall], [k.B[0], k.B[1] - tall], spire], shade("#1c1917", dim));
      poly(ctx, [[k.B[0], k.B[1] - tall], [k.R[0], k.R[1] - tall], spire], shade("#0c0a09", dim));
      if (kind === "tower") px(ctx, spire[0] - 1, spire[1] - 2, lit || !theme.night ? "#ef4444" : "#7f1d1d", 2, 2);
      info.bbox = { x0: c.cx - c.a, x1: c.cx + c.a, y0: spire[1] - 4, y1: c.cy + c.b };
    }
    return info;
  }

  // ---------- full static render ----------
  function isRoad(x, y) {
    var mx = ((x % PERIOD) + PERIOD) % PERIOD, my = ((y % PERIOD) + PERIOD) % PERIOD;
    return mx === BLOCK || my === BLOCK;
  }
  function blockOf(x, y) { return [Math.floor(x / PERIOD), Math.floor(y / PERIOD)]; }

  function theme(model) {
    var hr = new Date().getHours();
    return { night: hr >= 20 || hr < 6, dusk: hr >= 18 && hr < 20, hour: hr, powered: model.powered };
  }

  // Draws the whole city into an offscreen canvas; returns it with the pick list.
  function renderStatic(model, th) {
    var b = model.bounds;
    // screen extent of the bounds diamond
    var w = (b.x1 - b.x0 + b.y1 - b.y0 + 2) * TW / 2 + TW;
    var h = (b.x1 - b.x0 + b.y1 - b.y0 + 2) * TH / 2 + 90;
    ORIGIN = { x: (b.y1 - b.x0 + 1) * TW / 2 + TW / 2, y: -(b.x0 + b.y0) * TH / 2 + 80 };
    var cv = document.createElement("canvas");
    cv.width = Math.ceil(w); cv.height = Math.ceil(h);
    var ctx = cv.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    var dim = th.night ? 0.55 : 1;

    var used = {};
    model.usedBlocks.concat([[0, 0]]).forEach(function (bk) { used[bk[0] + "," + bk[1]] = 1; });
    var byTile = {};
    model.items.forEach(function (it) { byTile[it.x + "," + it.y] = it; });

    var picks = [];
    var roads = [];
    // Painter's order: back (small x+y) to front.
    for (var s = b.x0 + b.y0; s <= b.x1 + b.y1; s++) {
      for (var x = b.x0; x <= b.x1; x++) {
        var y = s - x;
        if (y < b.y0 || y > b.y1) continue;
        var bk = blockOf(x, y);
        var near = used[bk[0] + "," + bk[1]];
        var road = isRoad(x, y);
        // only roads that touch a developed block
        var roadNear = road && (used[blockOf(x - 1, y).join(",")] || used[blockOf(x + 1, y).join(",")] || used[blockOf(x, y - 1).join(",")] || used[blockOf(x, y + 1).join(",")]);
        if (roadNear) {
          diamond(ctx, x, y, shade("#57534e", dim));
          roads.push([x, y]);
          var mx = ((x % PERIOD) + PERIOD) % PERIOD, my = ((y % PERIOD) + PERIOD) % PERIOD;
          var t = tileTop(x, y);
          if (mx === BLOCK && my === BLOCK) { // crossing: a street lamp
            px(ctx, t.x, t.y + 1, shade("#44403c", dim), 1, 4);
            px(ctx, t.x - 1, t.y, th.night && th.powered ? "#fde68a" : shade("#a8a29e", dim), 3, 1);
            if (th.night && th.powered) { ctx.fillStyle = "rgba(253,230,138,.18)"; ctx.beginPath(); ctx.ellipse(t.x, t.y + TH / 2 + 1, 6, 3, 0, 0, Math.PI * 2); ctx.fill(); }
          } else if ((mx === BLOCK) !== (my === BLOCK)) { // lane markings
            px(ctx, t.x, t.y + TH / 2, shade("#d6d3d1", dim * 0.8));
          }
        } else {
          // grass everywhere else (outskirts slightly darker), except the paved plaza
          var plaza = bk[0] === 0 && bk[1] === 0 && !road;
          if (!plaza) diamond(ctx, x, y, shade(((x * 7 + y * 3) % 5 === 0) ? "#86b26a" : "#7aa65f", near && !road ? dim : dim * 0.86));
        }
        var it = byTile[x + "," + y];
        if (it) {
          if (it.type === "building") drawBuilding(ctx, it, th); else drawTree(ctx, it, th);
          picks.push(it);
        }
        // the plaza landmark is drawn once its far corner has been reached
        if (x === BLOCK - 1 && y === BLOCK - 1) {
          var lm = drawLandmark(ctx, model, th);
          picks.push(lm);
        }
      }
    }
    return { canvas: cv, picks: picks, roads: roads };
  }

  // ---------- sky ----------
  function sky(ctx, w, h, th) {
    var g = ctx.createLinearGradient(0, 0, 0, h);
    if (th.night) { g.addColorStop(0, "#0b1026"); g.addColorStop(1, "#27284a"); }
    else if (th.dusk) { g.addColorStop(0, "#f6b48a"); g.addColorStop(1, "#fbe3c6"); }
    else { g.addColorStop(0, "#bfe3f5"); g.addColorStop(1, "#f6efe2"); }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (th.night) {
      ctx.fillStyle = "rgba(255,255,255,.7)";
      for (var i = 0; i < 70; i++) {
        var sx = (hash("s" + i) % 1000) / 1000 * w, sy = (hash("t" + i) % 1000) / 1000 * h * 0.6;
        ctx.fillRect(Math.round(sx), Math.round(sy), 1, 1);
      }
    }
  }

  // ---------- interactive mount ----------
  function mount(canvas, model, opts) {
    opts = opts || {};
    var th = theme(model);
    var scene = renderStatic(model, th);
    var ctx = canvas.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var view = { zoom: 2, x: 0, y: 0 };
    var cars = makeCars(scene.roads, model);
    var raf = 0, lastT = 0, destroyed = false;

    function resize() {
      var r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    }
    function fit() {
      resize();
      var z = Math.min(canvas.width / scene.canvas.width, canvas.height / scene.canvas.height);
      view.zoom = Math.max(1, Math.floor(z * 0.95 * 2) / 2) || 1;
      if (z < 1) view.zoom = Math.max(0.5, Math.floor(z * 10) / 10);
      view.x = (canvas.width - scene.canvas.width * view.zoom) / 2;
      view.y = (canvas.height - scene.canvas.height * view.zoom) / 2;
      draw();
    }
    function draw() {
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      sky(ctx, canvas.width, canvas.height, th);
      ctx.setTransform(view.zoom, 0, 0, view.zoom, Math.round(view.x), Math.round(view.y));
      ctx.drawImage(scene.canvas, 0, 0);
      cars.forEach(function (car) { drawCar(ctx, car, th); });
      if (selected && selected.bbox) {
        var bb = selected.bbox;
        ctx.strokeStyle = "#fde047"; ctx.lineWidth = 1 / view.zoom * dpr;
        ctx.strokeRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0);
      }
    }
    function loop(t) {
      if (destroyed || !canvas.isConnected) return;
      raf = requestAnimationFrame(loop);
      if (t - lastT < 50) return; // ~20 fps is plenty for pixel cars
      var dt = Math.min(100, t - lastT); lastT = t;
      cars.forEach(function (car) { stepCar(car, dt); });
      draw();
    }

    // pan / zoom / pick
    var drag = null, moved = false, selected = null;
    canvas.addEventListener("pointerdown", function (e) {
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; moved = false;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var dx = (e.clientX - drag.x) * dpr, dy = (e.clientY - drag.y) * dpr;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      view.x = drag.vx + dx; view.y = drag.vy + dy;
      draw();
    });
    canvas.addEventListener("pointerup", function (e) {
      if (drag && !moved) pick(e);
      drag = null;
    });
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.offsetX * dpr, e.offsetY * dpr);
    }, { passive: false });

    function zoomAt(f, cx, cy) {
      var nz = Math.max(0.5, Math.min(8, view.zoom * f));
      view.x = cx - (cx - view.x) * (nz / view.zoom);
      view.y = cy - (cy - view.y) * (nz / view.zoom);
      view.zoom = nz;
      draw();
    }
    function pick(e) {
      var r = canvas.getBoundingClientRect();
      var lx = ((e.clientX - r.left) * dpr - view.x) / view.zoom;
      var ly = ((e.clientY - r.top) * dpr - view.y) / view.zoom;
      selected = null;
      for (var i = scene.picks.length - 1; i >= 0; i--) {
        var bb = scene.picks[i].bbox;
        if (bb && lx >= bb.x0 && lx <= bb.x1 && ly >= bb.y0 && ly <= bb.y1) { selected = scene.picks[i]; break; }
      }
      draw();
      if (opts.onPick) opts.onPick(selected ? describe(selected) : null);
    }

    window.addEventListener("resize", fit);
    fit();
    if (cars.length) raf = requestAnimationFrame(loop);

    return {
      fit: fit,
      zoomBy: function (f) { zoomAt(f, canvas.width / 2, canvas.height / 2); },
      destroy: function () { destroyed = true; cancelAnimationFrame(raf); window.removeEventListener("resize", fit); },
      png: function () { return scene.canvas; },
    };
  }

  function describe(it) {
    if (it.type === "landmark") return { title: it.label, sub: "Your city's landmark — it grows as you solve more games." };
    var ev = it.ev;
    var when = new Date(ev.date + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    if (it.type === "tree") return { title: "A tree for " + ev.name, sub: "Planted " + when + " · not solved that day, but it still grew something", id: ev.id };
    return {
      title: it.kind.label + " · " + ev.name,
      sub: "Built " + when + " · solved" + (ev.label ? " " + ev.label : "") + (ev.firstTime ? " · your first time playing it" : ""),
      id: ev.id,
    };
  }

  // ---------- cars ----------
  var CAR_COLORS = ["#ef4444", "#3b82f6", "#facc15", "#f4efe3", "#22c55e", "#f97316"];
  function makeCars(roads, model) {
    if (!model.powered || !roads.length) return [];
    var n = Math.min(24, Math.max(2, Math.floor(roads.length / 10)));
    var cars = [];
    for (var i = 0; i < n; i++) {
      var r = roads[hash("car" + i) % roads.length];
      var horiz = ((r[1] % PERIOD) + PERIOD) % PERIOD === BLOCK;
      // a car drives along one road line, back and forth over its developed stretch
      var line = roads.filter(function (q) { return horiz ? q[1] === r[1] : q[0] === r[0]; });
      if (line.length < 2) continue;
      var vals = line.map(function (q) { return horiz ? q[0] : q[1]; });
      cars.push({ horiz: horiz, fixed: horiz ? r[1] : r[0], min: Math.min.apply(null, vals), max: Math.max.apply(null, vals),
        pos: horiz ? r[0] : r[1], dir: (i & 1) ? 1 : -1, speed: 0.0018 + (hash("v" + i) % 10) / 6000, color: CAR_COLORS[i % CAR_COLORS.length] });
    }
    return cars;
  }
  function stepCar(car, dt) {
    car.pos += car.dir * car.speed * dt;
    if (car.pos > car.max) { car.pos = car.max; car.dir = -1; }
    if (car.pos < car.min) { car.pos = car.min; car.dir = 1; }
  }
  function drawCar(ctx, car, th) {
    var x = car.horiz ? car.pos : car.fixed, y = car.horiz ? car.fixed : car.pos;
    var t = tileTop(x, y);
    var lane = car.dir > 0 ? 1 : -1;
    var cx = t.x + (car.horiz ? lane : -lane), cy = t.y + TH / 2 - 1;
    px(ctx, cx - 1, cy, car.color, 3, 2);
    if (th.night) px(ctx, cx + (car.dir > 0 === car.horiz ? 2 : -2), cy, "#fef9c3", 1, 1);
  }

  // ---------- static preview ----------
  function preview(canvas, model) {
    var th = theme(model);
    var scene = renderStatic(model, th);
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    sky(ctx, canvas.width, canvas.height, th);
    // Fill the card: a fractional scale is fine for a small preview.
    var z = Math.min(canvas.width / scene.canvas.width, canvas.height / scene.canvas.height) * 1.15;
    ctx.drawImage(scene.canvas, (canvas.width - scene.canvas.width * z) / 2, (canvas.height - scene.canvas.height * z) / 2, scene.canvas.width * z, scene.canvas.height * z);
  }

  window.DLECity = { build: build, mount: mount, preview: preview, LANDMARKS: LANDMARKS };
})();
