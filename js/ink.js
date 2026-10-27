/* Vault: drawing and handwriting in a note, with the S Pen, a stylus, a mouse or a finger. "Draw" in the note's tools
   opens a page over everything: pressure-sensitive pen lines (pointerType 'pen': the harder it presses, the wider), a
   see-through highlighter, an eraser that takes whole lines away, Undo/Redo, lined/squared/blank paper. Once a pen has
   been seen on this device, only the pen draws and fingers scroll the page, so a palm resting on the screen draws
   nothing (before that, a finger or the mouse draws, and two fingers scroll).

   A drawing is one attachment of the note: { kind: 'ink', path: <id>.ink.json.gz (its lines, gzipped JSON, plain
   JSON where the browser can't gzip), preview: <id>.png (a picture of it, shown in the note like a picture) }. Tapping
   it opens it again; saving it again puts new files in and the old ones leave the cloud. "Mark up" in the picture
   viewer draws over a picture and keeps the result as a new picture (the original stays). Locked notes keep words
   only, so no drawings there. What's drawn and not saved yet is kept on this device as a draft (IndexedDB) until it
   is saved or let go, so a phone closing Vault in the background loses nothing. */
'use strict';

V.ink = (() => {
  const W = 1000;              // a page is 1000 units wide everywhere; it's shown as wide as the screen allows
  const MOST_WIDTH = 760;      // ...and no wider than this (CSS px) on a big screen
  const START_HEIGHT = 1414;   // A4's shape; it grows as the bottom is reached
  const GROW = 700;
  const MOST_HEIGHT = 8000;
  const NEAR_END = 420;
  const LINE_GAP = 80;
  const GRID_GAP = 50;
  const MARGIN = 110;
  const SIZES = { pen: [5, 9, 16], hi: [22, 34, 52], eraser: [16, 32, 64] };
  const SIZE_NAMES = ['Thin', 'Medium', 'Thick'];
  const MOST_FILE = 50 * 1024 * 1024;
  const LET_GO_AFTER = 6000;   // a deleted drawing leaves the cloud once its Undo has gone
  const PREVIEW_WIDTH = 800;
  const PREVIEW_MOST = 4000;   // the preview's longest side, in pixels
  const MARKUP_MOST = 2400;

  /* Six colours each, as they show on a light page and on a dark one (the same line reads on either). */
  const COLOURS = {
    pen: [
      { key: 'ink', light: '#1d1f24', dark: '#eef0f3', name: ['Black', 'White'] },
      { key: 'blue', light: '#2563eb', dark: '#7aa7ff', name: 'Blue' },
      { key: 'red', light: '#d92d20', dark: '#ff8a80', name: 'Red' },
      { key: 'green', light: '#15803d', dark: '#5ad69b', name: 'Green' },
      { key: 'orange', light: '#e8590c', dark: '#ffa94d', name: 'Orange' },
      { key: 'purple', light: '#7c3aed', dark: '#b794ff', name: 'Purple' },
    ],
    hi: [
      { key: 'yellow', light: '#ffd60a', dark: '#ffe14d', name: 'Yellow' },
      { key: 'green', light: '#4ade80', dark: '#5ee38b', name: 'Green' },
      { key: 'blue', light: '#4dabf7', dark: '#74c0fc', name: 'Blue' },
      { key: 'pink', light: '#ff6fae', dark: '#ff8cc0', name: 'Pink' },
      { key: 'orange', light: '#ffa94d', dark: '#ffb86b', name: 'Orange' },
      { key: 'purple', light: '#b197fc', dark: '#c4b0ff', name: 'Purple' },
    ],
  };
  const LOOKS = {
    light: { theme: 'light', page: '#ffffff', line: '#d3dbe8', grid: '#e3e8ef', margin: '#f1c4c1', hiAlpha: 0.38 },
    dark: { theme: 'dark', page: '#17191c', line: '#2f333b', grid: '#262a31', margin: '#4d2c2e', hiAlpha: 0.42 },
  };
  const PAPERS = [['lined', 'Lined paper'], ['grid', 'Squared paper'], ['blank', 'Blank paper']];

  /* -- icons (on util.js's 24 grid) */

  const SVG = 'http://www.w3.org/2000/svg';
  const DRAWINGS = {
    draw: ['M4 18.5c2.2-2.6 3.8-6.9 5.6-6.9 2 0 .4 5.4 2.4 5.4 1.6 0 2.7-2.4 4-2.4', 'M15.6 4.4l3.9 3.9', 'M17.4 2.6a1.7 1.7 0 0 1 2.4 0l1.5 1.5a1.7 1.7 0 0 1 0 2.4l-6.6 6.6-3.6.6.6-3.6z'],
    pen: ['M14.5 5.5l4 4', 'M16.6 3.4a2 2 0 0 1 2.9 0l1.1 1.1a2 2 0 0 1 0 2.9L8 20H4v-4z'],
    hi: ['M9 11.5l3.5 3.5', 'M6.5 16.5l7.8-12a2 2 0 0 1 2.9-.6l1.9 1.4a2 2 0 0 1 .4 2.9L12 17l-3 1.5z', 'M6.5 16.5 4 20.5h5l.6-2'],
    eraser: ['M7.5 20.5h12', 'M4.6 14.6l9.2-9.2a2 2 0 0 1 2.8 0l3 3a2 2 0 0 1 0 2.8L11 19.8H8.4L4.6 16a1 1 0 0 1 0-1.4z', 'M9 10.2l5.8 5.8'],
    clear: ['M5.5 4.5h9l4 4v11h-13z', 'M9.5 11.5l5 5M14.5 11.5l-5 5'],
    lined: ['M5.5 3.5h13v17h-13z', 'M8.5 8.5h7M8.5 12h7M8.5 15.5h7'],
    grid: ['M5.5 3.5h13v17h-13z', 'M5.5 9.2h13M5.5 14.8h13M9.8 3.5v17M14.2 3.5v17'],
    blank: ['M5.5 3.5h13v17h-13z'],
    hand: ['M8.5 12.5V6a1.5 1.5 0 0 1 3 0v5', 'M11.5 10.5V4.5a1.5 1.5 0 0 1 3 0v6', 'M14.5 10.5V6a1.5 1.5 0 0 1 3 0v7.5a6.5 6.5 0 0 1-6.5 6.5c-2.3 0-3.7-.9-5-2.6L3.6 14a1.5 1.5 0 0 1 2.3-1.9l2.6 2.4'],
  };

  function icon(name) {
    if (!DRAWINGS[name]) return V.format && V.format.icon ? V.format.icon(name) : V.icon(name);
    const span = document.createElement('span');
    span.className = 'icon';
    span.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG, 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(key, value);
    for (const d of DRAWINGS[name]) {
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    span.append(svg);
    return span;
  }

  /* -- the lines: { t: 'pen' | 'hi', c: colour key, s: size in units, pr: 1 when p holds pressure, p: [x, y(, pressure)]... } */

  const step = (s) => (s.pr ? 3 : 2);
  const count = (s) => Math.floor(s.p.length / step(s));
  const colourOf = (s, look) => {
    const list = COLOURS[s.t === 'hi' ? 'hi' : 'pen'];
    const found = list.find((c) => c.key === s.c) || list[0];
    return look.theme === 'dark' ? found.dark : found.light;
  };
  // A pen line is as wide as the pen pressed (a light touch about a quarter of its size, a hard one half as much again).
  const widthAt = (s, i) => (s.pr ? s.s * (0.25 + 1.25 * s.p[i * 3 + 2]) : s.s);

  const boxes = new WeakMap();
  function boxOf(s) {
    let box = boxes.get(s);
    if (box) return box;
    const k = step(s);
    box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let i = 0; i < s.p.length; i += k) {
      box.x0 = Math.min(box.x0, s.p[i]); box.x1 = Math.max(box.x1, s.p[i]);
      box.y0 = Math.min(box.y0, s.p[i + 1]); box.y1 = Math.max(box.y1, s.p[i + 1]);
    }
    const pad = s.s * (s.pr ? 1.5 : 1) / 2 + 1;
    box.x0 -= pad; box.y0 -= pad; box.x1 += pad; box.y1 += pad;
    boxes.set(s, box);
    return box;
  }

  /* Segment k (1 .. n-1) of a pen line: from the middle of the points before to the middle of the next ones, curving
     through point k (a smooth line through what the pen reported); the last one ends at the last point. */
  function segment(ctx, s, k) {
    const p = s.p;
    const j = step(s);
    const n = count(s);
    const x = p[k * j];
    const y = p[k * j + 1];
    const fx = k === 1 ? p[0] : (p[(k - 1) * j] + x) / 2;
    const fy = k === 1 ? p[1] : (p[(k - 1) * j + 1] + y) / 2;
    ctx.moveTo(fx, fy);
    if (k === n - 1) ctx.lineTo(x, y);
    else ctx.quadraticCurveTo(x, y, (x + p[(k + 1) * j]) / 2, (y + p[(k + 1) * j + 1]) / 2);
  }

  function dot(ctx, s, look) {
    ctx.fillStyle = colourOf(s, look);
    ctx.globalAlpha = s.t === 'hi' ? look.hiAlpha : 1;
    ctx.beginPath();
    ctx.arc(s.p[0], s.p[1], widthAt(s, 0) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* Pen segments from..to-1 (consecutive ones of the same width go as one path). */
  function penPart(ctx, s, look, from, to) {
    ctx.strokeStyle = colourOf(s, look);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let width = -1;
    for (let k = from; k < to; k++) {
      const w = Math.round(widthAt(s, k) * 4) / 4;
      if (w !== width) {
        if (width >= 0) ctx.stroke();
        ctx.lineWidth = w;
        width = w;
        ctx.beginPath();
      }
      segment(ctx, s, k);
    }
    if (width >= 0) ctx.stroke();
  }

  function drawStroke(ctx, s, look) {
    const n = count(s);
    if (!n) return;
    if (n === 1) return dot(ctx, s, look);
    if (s.t !== 'hi') return penPart(ctx, s, look, 1, n);
    // A highlighter line is one path (see-through: drawn in pieces, its joins would show darker).
    const p = s.p;
    const j = step(s);
    ctx.strokeStyle = colourOf(s, look);
    ctx.globalAlpha = look.hiAlpha;
    ctx.lineWidth = s.s;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let k = 1; k < n - 1; k++) {
      ctx.quadraticCurveTo(p[k * j], p[k * j + 1], (p[k * j] + p[(k + 1) * j]) / 2, (p[k * j + 1] + p[(k + 1) * j + 1]) / 2);
    }
    ctx.lineTo(p[(n - 1) * j], p[(n - 1) * j + 1]);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawPaper(ctx, paper, look, height, top, bottom) {
    ctx.fillStyle = look.page;
    ctx.fillRect(0, top, W, bottom - top);
    ctx.lineWidth = paper === 'grid' ? 1.2 : 1.6;
    if (paper === 'lined') {
      ctx.strokeStyle = look.line;
      ctx.beginPath();
      for (let y = LINE_GAP * 2; y < height; y += LINE_GAP) {
        if (y < top - 2 || y > bottom + 2) continue;
        ctx.moveTo(0, y); ctx.lineTo(W, y);
      }
      ctx.stroke();
      ctx.strokeStyle = look.margin;
      ctx.beginPath();
      ctx.moveTo(MARGIN, top); ctx.lineTo(MARGIN, bottom);
      ctx.stroke();
    } else if (paper === 'grid') {
      ctx.strokeStyle = look.grid;
      ctx.beginPath();
      for (let y = GRID_GAP; y < height; y += GRID_GAP) {
        if (y < top - 2 || y > bottom + 2) continue;
        ctx.moveTo(0, y); ctx.lineTo(W, y);
      }
      for (let x = GRID_GAP; x < W; x += GRID_GAP) { ctx.moveTo(x, top); ctx.lineTo(x, bottom); }
      ctx.stroke();
    }
  }

  /* Whether the eraser at (x, y) with radius r touches line s. */
  function touches(s, x, y, r) {
    const box = boxOf(s);
    if (x < box.x0 - r || x > box.x1 + r || y < box.y0 - r || y > box.y1 + r) return false;
    const j = step(s);
    const n = count(s);
    for (let k = 0; k < n; k++) {
      const ax = s.p[k * j];
      const ay = s.p[k * j + 1];
      const reach = r + widthAt(s, k) / 2;
      const bx = k + 1 < n ? s.p[(k + 1) * j] : ax;
      const by = k + 1 < n ? s.p[(k + 1) * j + 1] : ay;
      const dx = bx - ax;
      const dy = by - ay;
      const length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
      const ex = ax + t * dx - x;
      const ey = ay + t * dy - y;
      if (ex * ex + ey * ey <= reach * reach) return true;
    }
    return false;
  }

  /* -- reading and writing a drawing */

  const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  /* A drawing read from the cloud, made safe to draw (anything odd left out). */
  function clean(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.strokes)) throw new Error('That drawing couldn\'t be read.');
    const strokes = [];
    for (const s of data.strokes) {
      if (!s || !Array.isArray(s.p)) continue;
      const t = s.t === 'hi' ? 'hi' : 'pen';
      const pr = s.pr && t === 'pen' ? 1 : 0;
      const j = pr ? 3 : 2;
      const p = s.p.slice(0, Math.floor(s.p.length / j) * j).map(number);
      if (!p.length) continue;
      strokes.push({ t, c: COLOURS[t].some((c) => c.key === s.c) ? s.c : COLOURS[t][0].key,
        s: Math.max(1, Math.min(120, number(s.s) || SIZES[t][1])), pr, p });
    }
    const height = Math.max(START_HEIGHT, Math.min(MOST_HEIGHT, number(data.h) || START_HEIGHT));
    return { strokes, h: height, paper: PAPERS.some(([key]) => key === data.paper) ? data.paper : 'lined' };
  }

  async function gzip(text) {
    if (window.CompressionStream) {
      try {
        const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
        const blob = await new Response(stream).blob();
        return { blob: new Blob([blob], { type: 'application/gzip' }), gz: true };
      } catch (error) { /* plain JSON then */ }
    }
    return { blob: new Blob([text], { type: 'application/json' }), gz: false };
  }

  async function read(blob) {
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    let text;
    if (head[0] === 0x1f && head[1] === 0x8b) {
      if (!window.DecompressionStream) throw new Error('This browser can\'t open drawings. Try Chrome or Edge.');
      text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else {
      text = await blob.text();
    }
    return clean(JSON.parse(text));
  }

  const toBlob = (canvas, type, quality) => new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob)
    : reject(new Error('The drawing couldn\'t be made into a picture.'))), type, quality));

  /* The lines on light paper, as a PNG: what the note shows (a dark theme shows it with its colours turned round). */
  async function preview(sheet) {
    const k = Math.min(PREVIEW_WIDTH / W, PREVIEW_MOST / sheet.h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(W * k);
    canvas.height = Math.round(sheet.h * k);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawPaper(ctx, sheet.paper, LOOKS.light, sheet.h, 0, sheet.h);
    for (const s of sheet.strokes) drawStroke(ctx, s, LOOKS.light);
    return { blob: await toBlob(canvas, 'image/png'), w: canvas.width, h: canvas.height };
  }

  /* -- the page that's open (one at a time) */

  let ui = null;      // the open drawing's elements and state
  let busy = false;   // saving
  const tryPen = () => { try { return localStorage.getItem('vault-pen') === '1'; } catch (error) { return false; } };
  let penSeen = tryPen();

  function lookNow() {
    if (ui && ui.markup) return { ...LOOKS.light, page: null };
    return V.theme && V.theme.current() === 'dark' ? LOOKS.dark : LOOKS.light;
  }

  /* `what`: { noteId, attachment (a drawing to open again), picture (an attachment to mark up), draft } */
  async function open(what) {
    if (ui) return;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();  // the keyboard goes
    const sheet = { strokes: [], h: START_HEIGHT, paper: 'lined' };
    let bitmap = null;
    const draft = await draftFor(what).catch(() => null);
    try {
      if (what.picture) {
        const blob = await V.cloud.blob(what.picture.path);
        bitmap = await createImageBitmap(blob);
        sheet.h = W * bitmap.height / bitmap.width;
        sheet.paper = 'blank';
      } else if (what.attachment) {
        Object.assign(sheet, await read(await V.cloud.blob(what.attachment.path)));
      } else {
        try { sheet.paper = localStorage.getItem('vault-ink-paper') || 'lined'; } catch (error) { /* private browsing */ }
        if (!PAPERS.some(([key]) => key === sheet.paper)) sheet.paper = 'lined';
      }
    } catch (error) {
      V.toast(navigator.onLine ? (error && error.message) || 'That couldn\'t be opened.' : 'Opening that needs the internet.',
        { kind: 'err', ms: 5000 });
      return;
    }
    if (ui) return;  // (opened twice while the first was loading)
    const start = sheet.strokes;
    if (draft) {
      sheet.strokes = draft.strokes;
      sheet.h = what.picture ? sheet.h : draft.h;
      if (!what.picture) sheet.paper = draft.paper;
    }
    build(what, sheet, bitmap, start);
    if (draft) V.toast('Your drawing from before is back. Tap Done to keep it.', { ms: 5000 });
  }

  function build(what, sheet, bitmap, start) {
    const tool = { name: 'pen', colour: { pen: 'ink', hi: 'yellow' }, size: { pen: 1, hi: 1, eraser: 1 } };
    try {
      const kept = JSON.parse(localStorage.getItem('vault-ink-tool') || 'null');
      if (kept && kept.colour && kept.size) {
        for (const kind of ['pen', 'hi']) if (COLOURS[kind].some((c) => c.key === kept.colour[kind])) tool.colour[kind] = kept.colour[kind];
        for (const kind of ['pen', 'hi', 'eraser']) if ([0, 1, 2].includes(kept.size[kind])) tool.size[kind] = kept.size[kind];
      }
    } catch (error) { /* nothing kept */ }
    ui = {
      what, sheet, bitmap, start, startPaper: sheet.paper, markup: !!what.picture, tool,
      past: [], future: [], y: 0, scale: 1, ox: 0, oy: 0, cssW: 0, cssH: 0, dpr: 1,
      pointers: new Map(),  // pointerId -> { mode: 'draw' | 'erase' | 'pan', ... }
      live: null,           // the line being drawn
      fingerDraws: !penSeen,
      pushed: false,
      frame: 0,
      hintTimer: 0,
    };
    const header = V.h('div.ink-bar', {},
      V.iconButton('x', 'Close', () => leave(), 'ink-close'),
      V.h('h2.ink-title', { text: ui.markup ? 'Mark up' : what.attachment ? 'Drawing' : 'New drawing' }),
      V.h('div.bar-spacer'),
      what.attachment ? V.iconButton('trash', 'Delete this drawing', () => removeDrawing(), 'ink-delete') : null,
      ui.undoBtn = toolButton('undo', 'Undo', undo),
      ui.redoBtn = toolButton('redo', 'Redo', redo),
      ui.doneBtn = V.button('Done', { kind: 'primary', icon: 'check', onClick: () => done() }));
    ui.main = V.h('canvas.ink-main', { 'aria-hidden': 'true' });
    ui.liveCanvas = V.h('canvas.ink-live', { role: 'img', 'aria-label': ui.markup ? 'The picture, to draw on' : 'The page, to draw on' });
    ui.hint = V.h('div.ink-hint', { role: 'status' });
    ui.thumb = V.h('i');
    ui.track = V.h('div.ink-scroll', { 'aria-hidden': 'true' }, ui.thumb);
    ui.stage = V.h('div.ink-stage' + (ui.markup ? '.markup' : ''), {}, ui.main, ui.liveCanvas, ui.track, ui.hint);
    ui.tools = V.h('div.ink-tools', { role: 'toolbar', 'aria-label': 'Drawing tools' });
    ui.el = V.h('div.layer.ink-layer' + (ui.markup ? '.markup' : ''), { role: 'dialog', 'aria-modal': 'true', tabindex: '-1',
      'aria-label': ui.markup ? 'Mark up a picture' : 'Drawing', onkeydown: keys }, header, ui.stage, ui.tools);
    ui.ctx = ui.main.getContext('2d');
    ui.liveCtx = ui.liveCanvas.getContext('2d', { desynchronized: true }) || ui.liveCanvas.getContext('2d');
    const c = ui.liveCanvas;
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('lostpointercapture', up);
    c.addEventListener('pointerover', seen);
    c.addEventListener('contextmenu', (event) => event.preventDefault());  // a long press (or the S Pen's button)
    ui.stage.addEventListener('wheel', wheel, { passive: false });
    drawTools();
    document.getElementById('layers').append(ui.el);
    ui.watch = window.ResizeObserver ? new ResizeObserver(() => layout()) : null;
    if (ui.watch) ui.watch.observe(ui.stage);
    else window.addEventListener('resize', layout);
    layout();
    history.pushState({ vault: 'ink' }, '');
    ui.pushed = true;
    requestAnimationFrame(() => { if (ui) ui.el.classList.add('shown'); });
    hint(firstHint());
    ui.el.focus({ preventScroll: true });
  }

  /* What fingers do now, in words. */
  function fingerWords() {
    if (ui.markup) return ui.fingerDraws ? 'Fingers draw too.' : 'Only the pen draws, so your hand can rest on the screen.';
    return ui.fingerDraws ? 'Fingers draw now. Two fingers scroll.' : 'The pen draws. Fingers scroll the page.';
  }

  function firstHint() {
    if (penSeen && !ui.fingerDraws) return fingerWords();
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      return ui.markup ? 'Draw on the picture with the mouse.' : 'Draw with the mouse. The wheel scrolls the page.';
    }
    return ui.markup ? 'Draw on the picture with your finger or pen.' : 'Draw with your finger or pen. Two fingers scroll.';
  }

  function hint(text, ms = 3500) {
    if (!ui) return;
    ui.hint.textContent = text;
    ui.hint.classList.add('shown');
    clearTimeout(ui.hintTimer);
    ui.hintTimer = setTimeout(() => { if (ui) ui.hint.classList.remove('shown'); }, ms);
  }

  function toolButton(name, label, onClick, cls = '') {
    return V.h('button.tool-btn.ink-btn' + (cls ? '.' + cls : ''), { type: 'button', title: label, 'aria-label': label,
      onclick: (event) => { if (event.currentTarget.getAttribute('aria-disabled') !== 'true') onClick(event); } }, icon(name));
  }

  /* The tools: pen, highlighter, eraser, three sizes, six colours, the paper, fingers (once a pen was seen), clear. */
  function drawTools() {
    if (!ui) return;
    const t = ui.tool;
    const kind = t.name === 'eraser' ? null : t.name;
    const look = lookNow();
    const pick = (name) => { t.name = name; keepTool(); drawTools(); };
    const pressed = (button, on) => { button.setAttribute('aria-pressed', on ? 'true' : 'false'); button.classList.toggle('on', on); return button; };
    const tools = V.h('div.ink-group', {},
      pressed(toolButton('pen', 'Pen', () => pick('pen')), t.name === 'pen'),
      pressed(toolButton('hi', 'Highlighter', () => pick('hi')), t.name === 'hi'),
      pressed(toolButton('eraser', 'Eraser: tap or rub out a whole line', () => pick('eraser')), t.name === 'eraser'),
      V.h('span.tool-sep'),
      [0, 1, 2].map((i) => {
        const shown = [5, 9, 15][i];
        const b = V.h('button.tool-btn.ink-btn.ink-size', { type: 'button', title: `${SIZE_NAMES[i]} ${t.name === 'eraser' ? 'eraser' : 'line'}`,
          'aria-label': `${SIZE_NAMES[i]} ${t.name === 'eraser' ? 'eraser' : 'line'}`,
          onclick: () => { t.size[t.name] = i; keepTool(); drawTools(); } },
        V.h('span.ink-dot' + (t.name === 'eraser' ? '.ring' : ''), { style: { width: shown + 'px', height: shown + 'px',
          background: kind ? swatch(kind, t.colour[kind], look) : '' } }));
        return pressed(b, t.size[t.name] === i);
      }),
      V.h('span.tool-sep'),
      toolButton('clear', 'Clear the page', clearAll));
    const colourKind = kind || 'pen';
    const colours = V.h('div.ink-group.ink-colours', {},
      COLOURS[colourKind].map((c) => {
        const name = Array.isArray(c.name) ? c.name[look.theme === 'dark' ? 1 : 0] : c.name;
        const b = V.h('button.ink-swatch', { type: 'button', title: name, 'aria-label': name,
          onclick: () => { if (t.name === 'eraser') t.name = colourKind; t.colour[t.name] = c.key; keepTool(); drawTools(); } },
        V.h('span', { style: { background: look.theme === 'dark' ? c.dark : c.light } }));
        return pressed(b, !!kind && t.colour[kind] === c.key);
      }),
      V.h('span.tool-sep'),
      ui.markup ? null : toolButton(ui.sheet.paper, PAPERS.find(([key]) => key === ui.sheet.paper)[1], (event) => paperMenu(event.currentTarget)),
      penSeen ? pressed(toolButton('hand', ui.fingerDraws ? 'Fingers draw: tap so only the pen draws' : 'Draw with fingers too', () => {
        ui.fingerDraws = !ui.fingerDraws;
        hint(fingerWords());
        drawTools();
      }), ui.fingerDraws) : null);
    V.clear(ui.tools, tools, colours);
    ui.liveCanvas.classList.toggle('erasing', t.name === 'eraser');
    drawUndo();
  }

  function swatch(kind, key, look) {
    const c = COLOURS[kind].find((x) => x.key === key) || COLOURS[kind][0];
    return look.theme === 'dark' ? c.dark : c.light;
  }

  function keepTool() {
    try { localStorage.setItem('vault-ink-tool', JSON.stringify({ colour: ui.tool.colour, size: ui.tool.size })); } catch (error) { /* private */ }
  }

  function paperMenu(anchor) {
    V.menu(anchor, PAPERS.map(([key, label]) => ({ label, icon: key === ui.sheet.paper ? 'check' : null, onClick: () => {
      if (!ui) return;
      ui.sheet.paper = key;
      try { localStorage.setItem('vault-ink-paper', key); } catch (error) { /* private browsing */ }
      changed();
      drawTools();
      redraw();
    } })));
  }

  function drawUndo() {
    if (!ui) return;
    ui.undoBtn.setAttribute('aria-disabled', ui.past.length ? 'false' : 'true');
    ui.redoBtn.setAttribute('aria-disabled', ui.future.length ? 'false' : 'true');
  }

  /* -- where things are: units on the page <-> CSS px on the stage */

  function layout() {
    if (!ui) return;
    const box = ui.stage.getBoundingClientRect();
    if (!box.width || !box.height) return;
    ui.cssW = box.width;
    ui.cssH = box.height;
    ui.dpr = Math.min(3, window.devicePixelRatio || 1);
    if (ui.markup) {
      const gap = 12;
      ui.scale = Math.min((box.width - gap * 2) / W, (box.height - gap * 2) / ui.sheet.h);
      ui.ox = (box.width - W * ui.scale) / 2;
      ui.oy = (box.height - ui.sheet.h * ui.scale) / 2;
    } else {
      const width = Math.min(box.width, MOST_WIDTH);
      ui.scale = width / W;
      ui.ox = (box.width - width) / 2;
      ui.oy = 0;
      // A new page is at least a screen tall.
      if (!ui.sheet.strokes.length) ui.sheet.h = Math.max(ui.sheet.h, Math.min(MOST_HEIGHT, Math.ceil(box.height / ui.scale)));
    }
    for (const canvas of [ui.main, ui.liveCanvas]) {
      canvas.width = Math.round(box.width * ui.dpr);
      canvas.height = Math.round(box.height * ui.dpr);
    }
    scrollTo(ui.y);
    redraw();
  }

  const viewHeight = () => (ui.markup ? ui.sheet.h : ui.cssH / ui.scale);
  const maxY = () => Math.max(0, ui.sheet.h - viewHeight());

  function scrollTo(y) {
    ui.y = Math.max(0, Math.min(maxY(), y));
    const all = ui.sheet.h;
    const shown = viewHeight();
    ui.track.hidden = ui.markup || shown >= all - 1;
    if (!ui.track.hidden) {
      ui.thumb.style.height = Math.max(8, (shown / all) * 100) + '%';
      ui.thumb.style.top = (ui.y / all) * 100 + '%';
    }
  }

  function toUnits(event) {
    const box = ui.liveCanvas.getBoundingClientRect();
    return [(event.clientX - box.left - ui.ox) / ui.scale, (event.clientY - box.top - ui.oy) / ui.scale + ui.y];
  }

  function placed(ctx) {
    const k = ui.scale * ui.dpr;
    ctx.setTransform(k, 0, 0, k, ui.ox * ui.dpr, (ui.oy - ui.y * ui.scale) * ui.dpr);
  }

  function clip(ctx) {
    ctx.beginPath();
    ctx.rect(0, 0, W, ui.sheet.h);
    ctx.clip();
  }

  function redraw() {
    if (!ui) return;
    cancelAnimationFrame(ui.frame);
    ui.frame = 0;
    const ctx = ui.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ui.main.width, ui.main.height);
    const look = lookNow();
    placed(ctx);
    ctx.save();
    clip(ctx);
    const top = ui.y;
    const bottom = ui.y + viewHeight();
    if (ui.bitmap) ctx.drawImage(ui.bitmap, 0, 0, W, ui.sheet.h);
    else drawPaper(ctx, ui.sheet.paper, look, ui.sheet.h, top, Math.min(bottom, ui.sheet.h));
    for (const s of ui.sheet.strokes) {
      const box = boxOf(s);
      if (box.y1 < top || box.y0 > bottom) continue;
      drawStroke(ctx, s, look);
    }
    ctx.restore();
    if (ui.live) liveDraw(true);
  }

  const redrawSoon = () => { if (ui && !ui.frame) ui.frame = requestAnimationFrame(redraw); };

  /* The line being drawn, on the canvas over the page: a pen line piece by piece as its points come, a highlighter
     line drawn whole each time (see-through). */
  function liveDraw(all = false) {
    const s = ui.live;
    const ctx = ui.liveCtx;
    const look = lookNow();
    if (s.t === 'hi' || all) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ui.liveCanvas.width, ui.liveCanvas.height);
      ui.liveDone = 1;
    }
    placed(ctx);
    ctx.save();
    clip(ctx);
    const n = count(s);
    if (s.t === 'hi') drawStroke(ctx, s, look);
    else if (n === 1 && ui.liveDone === 1) dot(ctx, s, look);
    else if (n - 1 > ui.liveDone) {
      // Segments up to n-2 won't change any more; the last one waits for the next point.
      penPart(ctx, s, look, ui.liveDone, n - 1);
      ui.liveDone = n - 1;
    }
    ctx.restore();
  }

  function clearLive() {
    ui.liveCtx.setTransform(1, 0, 0, 1, 0, 0);
    ui.liveCtx.clearRect(0, 0, ui.liveCanvas.width, ui.liveCanvas.height);
  }

  /* -- pens, fingers and the mouse */

  function seen(event) {
    if (event.pointerType !== 'pen' || penSeen) return;
    penSeen = true;
    try { localStorage.setItem('vault-pen', '1'); } catch (error) { /* private browsing */ }
    if (ui) {
      const drawing = [...ui.pointers.values()].filter((p) => p.mode === 'draw' && p.type === 'touch');
      for (const p of drawing) cancelLine(p);  // a palm that started a line just before the pen came down
      ui.fingerDraws = false;
      hint(ui.markup ? 'Pen found. Now only the pen draws.' : 'Pen found. Now only the pen draws, and fingers scroll the page.', 4500);
      drawTools();
    }
  }

  function down(event) {
    if (!ui || busy) return;
    seen(event);
    const type = event.pointerType || 'mouse';
    if (type === 'mouse' && event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    const pen = type === 'pen';
    const others = [...ui.pointers.values()];
    if (others.some((p) => p.type === 'pen') && !pen) return;  // the pen is down: a palm or finger does nothing
    let mode;
    if (type === 'mouse' && event.button === 1) mode = 'pan';
    else if (type === 'touch' && (!ui.fingerDraws || others.some((p) => p.type === 'touch'))) mode = 'pan';
    else mode = ui.tool.name === 'eraser' || (pen && (event.buttons & 32)) ? 'erase' : 'draw';
    if (type === 'touch' && mode === 'pan') {
      // A second finger: the line the first one began was the start of a scroll.
      for (const p of others) if (p.type === 'touch' && p.mode !== 'pan') { cancelLine(p); p.mode = 'pan'; }
      if (ui.markup) mode = 'none';
    }
    try { ui.liveCanvas.setPointerCapture(event.pointerId); } catch (error) { /* a made-up pointer (tests) */ }
    const [x, y] = toUnits(event);
    // A line starts on the page (or the picture), never in the grey beside it, where it couldn't be seen.
    if (mode === 'draw' && (x < 0 || x > W || y < 0 || y > ui.sheet.h)) mode = type === 'touch' ? 'pan' : 'none';
    const p = { id: event.pointerId, type, mode, lastY: event.clientY, x, y };
    ui.pointers.set(event.pointerId, p);
    if (mode === 'draw') startLine(p, event, x, y);
    else if (mode === 'erase') { p.before = ui.sheet.strokes; p.erased = false; eraseAt(p, x, y); }
  }

  function startLine(p, event, x, y) {
    if (ui.live) finishLine();  // (one line at a time)
    const t = ui.tool.name === 'hi' ? 'hi' : 'pen';
    const pr = t === 'pen' && p.type === 'pen' ? 1 : 0;
    ui.live = { t, c: ui.tool.colour[t], s: SIZES[t][ui.tool.size[t]], pr, p: [] };
    ui.liveOwner = p.id;
    ui.liveDone = 1;
    ui.pressure = null;
    clearLive();
    addPoint(x, y, event.pressure);
    liveDraw();
  }

  function addPoint(x, y, pressure) {
    const s = ui.live;
    const j = step(s);
    const n = count(s);
    x = Math.round(x * 10) / 10;
    y = Math.round(y * 10) / 10;
    if (n) {
      const dx = x - s.p[(n - 1) * j];
      const dy = y - s.p[(n - 1) * j + 1];
      if (dx * dx + dy * dy < 0.6) return;  // the same spot again
    }
    s.p.push(x, y);
    if (s.pr) {
      // Smoothed a little, so a shaky hand doesn't make the line lumpy.
      const raw = Math.max(0.02, Math.min(1, pressure || 0.5));
      ui.pressure = ui.pressure === null ? raw : ui.pressure * 0.55 + raw * 0.45;
      s.p.push(Math.round(ui.pressure * 100) / 100);
    }
  }

  function cancelLine(p) {
    if (ui.live && ui.liveOwner === p.id) { ui.live = null; clearLive(); }
    p.mode = 'none';
  }

  function finishLine() {
    const s = ui.live;
    ui.live = null;
    if (!s || !count(s)) { clearLive(); return; }
    record();
    ui.sheet.strokes = [...ui.sheet.strokes, s];
    // Near the bottom of the page: more page.
    if (!ui.markup && boxOf(s).y1 > ui.sheet.h - NEAR_END && ui.sheet.h < MOST_HEIGHT) {
      ui.sheet.h = Math.min(MOST_HEIGHT, ui.sheet.h + GROW);
      scrollTo(ui.y);
    }
    // Onto the page underneath, then off the one on top (no blink between).
    const ctx = ui.ctx;
    placed(ctx);
    ctx.save();
    clip(ctx);
    drawStroke(ctx, s, lookNow());
    ctx.restore();
    clearLive();
    changed();
  }

  function move(event) {
    if (!ui) return;
    if (event.pointerType === 'pen') seen(event);
    const p = ui.pointers.get(event.pointerId);
    if (!p) return;
    event.preventDefault();
    if (p.mode === 'pan') {
      const dy = event.clientY - p.lastY;
      p.lastY = event.clientY;
      const panning = [...ui.pointers.values()].filter((q) => q.mode === 'pan').length || 1;
      scrollTo(ui.y - dy / ui.scale / panning);
      redrawSoon();
      return;
    }
    const list = event.getCoalescedEvents ? event.getCoalescedEvents() : [];
    const points = list.length ? list : [event];
    if (p.mode === 'draw' && ui.live && ui.liveOwner === p.id) {
      for (const e of points) { const [x, y] = toUnits(e); addPoint(x, y, e.pressure); }
      liveDraw();
    } else if (p.mode === 'erase') {
      for (const e of points) { const [x, y] = toUnits(e); eraseAt(p, x, y); }
    }
  }

  function up(event) {
    if (!ui) return;
    const p = ui.pointers.get(event.pointerId);
    if (!p) return;
    ui.pointers.delete(event.pointerId);
    if (p.mode === 'draw' && ui.live && ui.liveOwner === p.id) {
      if (event.type === 'pointerup' || event.type === 'lostpointercapture' || count(ui.live) > 1) {
        const [x, y] = toUnits(event);
        if (event.type === 'pointerup') addPoint(x, y, event.pressure || (ui.pressure === null ? 0.5 : ui.pressure));
        finishLine();
      } else {
        cancelLine(p);
      }
    } else if (p.mode === 'erase' && p.erased) {
      changed();
    }
  }

  function wheel(event) {
    if (!ui || ui.markup) return;
    event.preventDefault();
    scrollTo(ui.y + (event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY) / ui.scale);
    redrawSoon();
  }

  /* The eraser takes away every line it touches (between its last spot and this one, so a quick rub misses none). */
  function eraseAt(p, x, y) {
    const r = SIZES.eraser[ui.tool.size.eraser] / 2;
    const fromX = p.x;
    const fromY = p.y;
    const length = Math.hypot(x - fromX, y - fromY);
    const steps = Math.max(1, Math.ceil(length / (r / 2)));
    const kept = [];
    let hit = false;
    for (const s of ui.sheet.strokes) {
      let gone = false;
      for (let i = 1; i <= steps && !gone; i++) gone = touches(s, fromX + (x - fromX) * i / steps, fromY + (y - fromY) * i / steps, r);
      if (gone) hit = true;
      else kept.push(s);
    }
    p.x = x;
    p.y = y;
    if (!hit) return;
    if (!p.erased) { record(p.before); p.erased = true; }
    ui.sheet.strokes = kept;
    redrawSoon();
  }

  /* -- Undo, Redo, Clear */

  function record(before = ui.sheet.strokes) {
    ui.past.push(before);
    if (ui.past.length > 300) ui.past.shift();
    ui.future = [];
    drawUndo();
  }

  function undo() {
    if (!ui || !ui.past.length || ui.live) return;
    ui.future.push(ui.sheet.strokes);
    ui.sheet.strokes = ui.past.pop();
    changed();
    redraw();
  }

  function redo() {
    if (!ui || !ui.future.length || ui.live) return;
    ui.past.push(ui.sheet.strokes);
    ui.sheet.strokes = ui.future.pop();
    changed();
    redraw();
  }

  function clearAll() {
    if (!ui || !ui.sheet.strokes.length) return;
    record();
    ui.sheet.strokes = [];
    changed();
    redraw();
    V.toast('Page cleared', { action: 'Undo', onAction: undo });
  }

  function keys(event) {
    if (!ui) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (ctrl && key === 'z' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); undo(); }
    else if (ctrl && (key === 'y' || (key === 'z' && event.shiftKey))) { event.preventDefault(); event.stopPropagation(); redo(); }
    else if (event.key === 'Escape' && !document.querySelector('#layers > .layer:not(.ink-layer)')) {
      event.preventDefault(); event.stopPropagation(); leave();
    } else if (ctrl) event.stopPropagation();  // (Ctrl+N and the like are for the notes behind)
  }

  /* -- what's not saved yet: kept on this device as a draft */

  const dirty = () => !!ui && (ui.sheet.strokes !== ui.start || ui.sheet.paper !== ui.startPaper);
  const draftKey = (what) => [what.noteId, what.attachment ? what.attachment.path : '', what.picture ? what.picture.path : ''].join('|');

  function changed() {
    drawUndo();
    keepDraftSoon();
  }

  const keepDraftSoon = V.debounce(() => keepDraft(), 1500);

  function keepDraft() {
    if (!ui || busy) return;
    const value = dirty() ? { key: draftKey(ui.what), strokes: ui.sheet.strokes, h: ui.sheet.h, paper: ui.sheet.paper, at: Date.now() } : null;
    V.db.meta('ink-draft', value).catch(() => {});
  }

  async function draftFor(what) {
    const kept = await V.db.meta('ink-draft');
    if (!kept || kept.key !== draftKey(what) || !Array.isArray(kept.strokes) || !kept.strokes.length) return null;
    return clean({ strokes: kept.strokes, h: kept.h, paper: kept.paper });
  }

  V.on('away', () => { if (ui) { keepDraftSoon.cancel(); keepDraft(); } });
  V.on('theme', () => { if (ui && !ui.markup) { drawTools(); redraw(); } });

  /* -- leaving */

  function finish() {
    if (!ui) return;
    const gone = ui;
    ui = null;
    keepDraftSoon.cancel();
    V.db.meta('ink-draft', null).catch(() => {});
    if (gone.watch) gone.watch.disconnect();
    else window.removeEventListener('resize', layout);
    cancelAnimationFrame(gone.frame);
    clearTimeout(gone.hintTimer);
    if (gone.bitmap && gone.bitmap.close) gone.bitmap.close();
    gone.el.classList.remove('shown');
    gone.el.classList.add('leaving');
    setTimeout(() => gone.el.remove(), 180);
    if (gone.pushed && history.state && history.state.vault === 'ink') history.back();
  }

  /* Closing with something not saved asks first (nothing is lost by a slip of the finger). */
  function leave() {
    if (!ui || busy) return;
    if (!dirty()) return finish();
    if (ui.asking) return;
    ui.asking = true;
    let choice = null;
    V.sheet({
      title: ui.markup ? 'Keep the marked-up picture?' : 'Save your drawing?',
      content: V.h('p', { text: 'You drew something that isn\'t saved yet.' }),
      actions: [
        { label: 'Don\'t save', kind: 'danger-quiet', onClick: () => { choice = 'drop'; } },
        { label: 'Keep drawing', kind: 'quiet' },
        { label: 'Save', kind: 'primary', onClick: () => { choice = 'save'; } },
      ],
      onClose: () => {
        if (!ui) return;
        ui.asking = false;
        if (choice === 'drop') finish();
        else if (choice === 'save') done();
      },
    });
  }

  window.addEventListener('popstate', () => {
    if (!ui || (history.state && history.state.vault === 'ink')) return;
    ui.pushed = false;
    if (busy || dirty()) {
      // Back with a drawing not saved: it stays, and asks.
      history.pushState({ vault: 'ink' }, '');
      ui.pushed = true;
      if (!busy) leave();
    } else {
      finish();
    }
  });

  /* -- saving */

  function saving(on) {
    busy = on;
    if (!ui) return;
    ui.el.classList.toggle('saving', on);
    ui.doneBtn.disabled = on;
    ui.doneBtn.querySelector('span:last-child').textContent = on ? 'Saving…' : 'Done';
  }

  async function done() {
    if (!ui || busy) return;
    if (ui.live) finishLine();
    const what = ui.what;
    if (!dirty()) return finish();
    if (!ui.sheet.strokes.length) {
      if (!what.attachment) return finish();  // nothing drawn: nothing to keep
      return removeDrawing();
    }
    if (!navigator.onLine) {
      keepDraft();
      V.toast('Saving needs the internet. Your drawing is kept here: tap Done again once you\'re online.', { kind: 'err', ms: 6000 });
      return;
    }
    const user = V.data.user;
    if (!user) return;
    saving(true);
    const made = [];
    try {
      const base = `${user.id}/notes/${what.noteId}/`;
      const id = V.uuid();
      let item;
      if (ui.markup) {
        const picture = await flatten();
        if (picture.blob.size > MOST_FILE) throw new Error('That picture is over 50 MB, the most the free cloud takes.');
        const path = base + id + '.jpg';
        await V.cloud.upload(path, picture.blob, { mime: 'image/jpeg' });
        made.push(path);
        const stem = (what.picture.name || 'Picture').replace(/\.[^.]+$/, '').replace(/ \(marked up\)$/, '');
        item = { path, name: `${stem} (marked up).jpg`, mime: 'image/jpeg', size: picture.blob.size, w: picture.w, h: picture.h };
        V.db.put('files', { key: path, blob: picture.blob, at: Date.now() }).catch(() => {});
      } else {
        const data = { format: 1, app: 'vault-ink', w: W, h: Math.round(ui.sheet.h), paper: ui.sheet.paper, strokes: ui.sheet.strokes };
        const packed = await gzip(JSON.stringify(data));
        const shown = await preview(ui.sheet);
        if (packed.blob.size + shown.blob.size > MOST_FILE) throw new Error('That drawing is too big to save.');
        const path = base + id + (packed.gz ? '.ink.json.gz' : '.ink.json');
        const look = base + id + '.png';
        await V.cloud.upload(path, packed.blob, { mime: packed.gz ? 'application/gzip' : 'application/json' });
        made.push(path);
        await V.cloud.upload(look, shown.blob, { mime: 'image/png' });
        made.push(look);
        V.db.put('files', { key: path, blob: packed.blob, at: Date.now() }).catch(() => {});
        V.db.put('files', { key: look, blob: shown.blob, at: Date.now() }).catch(() => {});
        item = { kind: 'ink', path, preview: look, name: 'Drawing', mime: 'image/vnd.vault-ink',
          size: packed.blob.size + shown.blob.size, w: shown.w, h: shown.h, lines: ui.sheet.strokes.length,
          at: new Date().toISOString() };
      }
      const old = what.attachment;
      const kept = await V.editor.changeAttachments(what.noteId, (list) => {
        const at = old ? list.findIndex((a) => a.path === old.path) : -1;
        if (at < 0) return [...list, item];
        list[at] = item;
        return list;
      });
      if (!kept) {
        V.cloud.remove(made).catch(() => {});
        V.toast('That note was deleted, so the drawing wasn\'t kept.', { kind: 'err' });
      } else if (old) {
        letGo([old.path, old.preview]);  // the old drawing's files: replaced
      }
      saving(false);
      finish();
      if (kept && ui === null && what.picture) V.toast('Saved as a new picture. The original is still there.');
    } catch (error) {
      if (made.length) V.cloud.remove(made).catch(() => {});
      saving(false);
      keepDraft();
      V.toast(error && error.message ? error.message : 'That didn\'t save. Try again.', { kind: 'err', ms: 6000 });
    }
  }

  function letGo(paths) {
    const files = paths.filter(Boolean);
    for (const path of files) V.db.del('files', path).catch(() => {});
    V.cloud.remove(files).catch(() => {});
  }

  /* The picture with what was drawn on it, at the picture's own size (as big as Vault keeps pictures). */
  async function flatten() {
    const bitmap = ui.bitmap;
    const k = Math.min(1, MARKUP_MOST / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * k);
    canvas.height = Math.round(bitmap.height * k);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const units = canvas.width / W;
    ctx.setTransform(units, 0, 0, units, 0, 0);
    for (const s of ui.sheet.strokes) drawStroke(ctx, s, LOOKS.light);
    return { blob: await toBlob(canvas, 'image/jpeg', 0.9), w: canvas.width, h: canvas.height };
  }

  /* Taken out of the note (Undo puts it back); its files leave the cloud a few seconds later. */
  async function removeDrawing() {
    if (!ui || busy || !ui.what.attachment) return;
    const sure = await V.confirm('Delete this drawing?', 'It goes from the note. You can undo it for a few seconds.',
      { ok: 'Delete', danger: true });
    if (!sure || !ui) return;
    const { noteId, attachment } = ui.what;
    const keptPaths = (list) => list.some((a) => a.path === attachment.path);
    saving(true);
    try {
      await V.editor.changeAttachments(noteId, (list) => list.filter((a) => a.path !== attachment.path));
    } catch (error) {
      saving(false);
      V.problem(error);
      return;
    }
    saving(false);
    finish();
    let undone = false;
    V.toast('Drawing deleted', { action: 'Undo', onAction: () => {
      undone = true;
      V.editor.changeAttachments(noteId, (list) => (keptPaths(list) ? list : [...list, attachment])).catch(V.problem);
    } });
    setTimeout(() => {
      const open = V.editor.current();
      const used = [...V.data.notes.values(), open].some((n) => n && keptPaths(n.attachments || []));
      if (!undone && !used) letGo([attachment.path, attachment.preview]);
    }, LET_GO_AFTER);
  }

  /* -- into the note */

  function startDrawing() {
    const note = V.editor.current();
    if (!note) return;
    if (note.locked) return V.toast('Locked notes keep words only, not drawings.');
    open({ noteId: note.id });
  }

  V.editor.addTool({ name: 'draw', label: 'Draw', icon: () => icon('draw'), onClick: startDrawing, keepCaret: false });

  V.editor.addThumb('ink', (a, noteId) => {
    const img = V.h('img', { alt: 'Drawing', loading: 'lazy', draggable: 'false' });
    if (a.preview) V.cloud.blob(a.preview).then((b) => { img.src = URL.createObjectURL(b); }).catch(() => img.classList.add('broken'));
    else img.classList.add('broken');
    return V.h('button.thumb.ink-thumb', { type: 'button', title: 'Open the drawing', 'aria-label': 'Open the drawing',
      onclick: () => open({ noteId, attachment: a }) }, img, V.h('span.ink-badge', {}, icon('pen')));
  });

  V.editor.addPictureAction({ label: 'Mark up', icon: 'image', onClick: (attachment, img, noteId) => {
    const note = V.editor.current();
    if (note && note.locked) return V.toast('Locked notes keep words only, not pictures.');
    open({ noteId, picture: attachment });
  } });

  return {
    open,
    busy: () => busy || !!ui,
    read,
    /* What's open, for the tests: the lines, the paper, whether a pen was seen and whether fingers draw. */
    state: () => (ui ? { strokes: ui.sheet.strokes.map((s) => ({ ...s, p: [...s.p] })), paper: ui.sheet.paper, h: ui.sheet.h,
      y: ui.y, penSeen, fingerDraws: ui.fingerDraws, tool: ui.tool.name, dirty: dirty(), markup: ui.markup } : null),
  };
})();
