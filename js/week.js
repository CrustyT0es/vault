/* Wefty 1.19: "Your week in Wefty", a picture of the week to keep or share (an Instagram story takes it as it is).

   1080 x 1920 (9:16), drawn on a canvas in Wefty's own look: the dark navy and the iris, the woven W, and the logo's
   thread running under and over the numbers. On it: the cards studied, the minutes spent studying (the study screen
   and the note-taker), the notes made, the tests done and the streak (js/streak.js, when it's on), plus a first name
   only if one is asked for (off unless switched on, per device). Nothing else: no note titles, no folders, no e-mail.

   It's made on this device and goes nowhere by itself: a phone shares it through the share sheet (Web Share with the
   file) or saves it; a Chromebook or a computer downloads it (the PC app saves it in Downloads\Vault). Every Sunday
   and Monday Today has a small card for the week (Sunday: this week, Monday: the one just gone) when there was some
   studying or a test in it; Today's ⋯ has it any day. Each device remembers which week's card it has shown
   (localStorage 'vault-week-seen'), and the name choice ('vault-week-name'). */
'use strict';

V.week = (() => {
  const W = 1080;
  const H = 1920;
  const SEEN = 'vault-week-seen';
  const NAME = 'vault-week-name';
  const NAME_MOST = 20;
  const FONT = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const DISPLAY = '"Inter Display", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const INK = { text: '#f4f4fa', soft: '#cfcfdc', muted: '#a5a5b8', tile: '#1c1c2e', edge: '#35354d', thread: '#a2a2ec' };
  // The logo's own shapes (util.js's MARK), on its 64 grid.
  const MARK = {
    tile: 'M18 0H46C56 0 64 8 64 18V46C64 56 56 64 46 64H18C8 64 0 56 0 46V18C0 8 8 0 18 0Z',
    outer: 'M14 20L23 46M41 46L50 20',
    mid: 'M23 46L32 26L41 46',
    thread: 'M8 35.5Q20 30.5 32 35.5T56 35.5',
  };
  const FLAME = 'M50 4C58 26 84 42 84 76C84 100 68 116 50 116C32 116 16 100 16 78C16 60 26 48 34 38C36 52 42 60 48 62C44 44 44 22 50 4Z';
  const FLAME_IN = 'M50 60C56 72 66 80 66 94C66 106 58 112 50 112C42 112 34 106 34 95C34 84 42 78 46 70C48 76 50 78 52 78C50 72 49 66 50 60Z';

  const plural = (n, one, many = one + 's') => (n === 1 ? one : many);
  const S = () => V.streak;
  const O = () => V.organise;

  /* -- which week, and what was in it */

  /* 'this' (Monday to Sunday, today in it) or 'last': { which, from, to }. */
  function range(which, today = V.today()) {
    const monday = S().mondayOf(today);
    const from = which === 'last' ? V.addDays(monday, -7) : monday;
    return { which, from, to: V.addDays(from, 6) };
  }
  // On demand: the week just gone on a Monday (this one has barely started), else this week so far.
  const usual = (today = V.today()) => (V.parseDate(today).getDay() === 1 ? 'last' : 'this');

  const madeOn = (row) => {
    const at = new Date(row.created_at || row._edited || '');
    return Number.isNaN(at.getTime()) ? '' : V.dateText(at);
  };
  /* A test: a note with a day that says what it covers, or looks like one ("Bio test fri"). */
  function isTest(note) {
    if (!note || note.deleted || note._purge || !note.due || !V.review) return false;
    const exam = note.extra && note.extra.exam;
    return !!((exam && Array.isArray(exam.covers) && exam.covers.length) || V.review.coversOf(note).length || V.review.looksLikeTest(note));
  }

  /* The week's numbers: { from, to, cards, minutes, notes, tests, streak (null when it's off), studied (days) }. */
  function stats({ from, to }) {
    const today = V.today();
    const t = S().totals(from, to);
    // Cards: the answers counted, or (studied on a Wefty from before 1.19) the cards last gone over that week.
    let seen = 0;
    try {
      for (const card of V.review.all()) {
        const m = V.review.memory(card.state);
        if (m && m.last >= from && m.last <= to) seen++;
      }
    } catch (error) { /* (no flash cards here) */ }
    const live = [...V.data.notes.values()].filter((n) => n && !n.deleted && !n._purge && !O().isTemplate(n));
    const made = live.filter((n) => { const day = madeOn(n); return day >= from && day <= to; }).length;
    const last = to < today ? to : today;
    const tests = live.filter((n) => isTest(n) && n.due >= from && n.due <= last).length;
    const seconds = t.seconds + t.recorded;
    return {
      from, to, cards: Math.max(t.cards, seen), minutes: seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 0,
      notes: made, tests, studied: t.days,
      streak: S().on() ? S().run(S().studiedDays(today), last).count : null,
    };
  }

  /* "Oct 26 – Nov 1", "Nov 2 – 8". */
  function rangeWords({ from, to }) {
    const a = V.parseDate(from);
    const b = V.parseDate(to);
    const month = (d) => d.toLocaleDateString([], { month: 'short' });
    return a.getMonth() === b.getMonth() ? `${month(a)} ${a.getDate()} – ${b.getDate()}`
      : `${month(a)} ${a.getDate()} – ${month(b)} ${b.getDate()}`;
  }

  /* "31 cards · 48 min · 2 notes · 🔥 6 days" (what there is of it). */
  function line(s) {
    const parts = [];  // (each part kept on one line: "🔥 6 days" never breaks after its flame)
    if (s.cards) parts.push(`${s.cards} ${plural(s.cards, 'card')}`);
    if (s.minutes) parts.push(`${s.minutes} min`);
    if (s.notes) parts.push(`${s.notes} ${plural(s.notes, 'note')}`);
    if (s.tests) parts.push(`${s.tests} ${plural(s.tests, 'test')}`);
    if (s.streak) parts.push(`🔥 ${s.streak} ${plural(s.streak, 'day')}`);
    return parts.map((part) => part.replace(/ /g, '\u00a0')).join(' · ');
  }

  /* What the picture says, in words (its alt text). */
  const said = (s, name) => [`${name ? `${name}’s` : 'My'} week in Wefty, ${rangeWords(s)}`,
    `${s.cards} ${plural(s.cards, 'card')} studied`, `${s.minutes} ${plural(s.minutes, 'minute')} studying`,
    `${s.notes} ${plural(s.notes, 'note')} made`, `${s.tests} ${plural(s.tests, 'test')} done`,
    s.streak ? `a ${s.streak}-day streak` : ''].filter(Boolean).join(', ') + '.';

  /* -- drawing */

  function words(ctx, text, x, y, font, colour, align = 'left') {
    ctx.font = font;
    ctx.fillStyle = colour;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, y);
  }
  /* Words at the biggest size up to `size` that fits in `most` pixels. */
  function fitted(ctx, text, x, y, most, size, weight, family, colour) {
    let px = size;
    ctx.font = `${weight} ${px}px ${family}`;
    while (px > 24 && ctx.measureText(text).width > most) {
      px -= 4;
      ctx.font = `${weight} ${px}px ${family}`;
    }
    words(ctx, text, x, y, `${weight} ${px}px ${family}`, colour);
    return px;
  }
  function rounded(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  /* The logo's thread as a long wave: `half` a period wide, swinging `swing` (the logo's own proportions at 0.21). */
  function wave(ctx, x0, x1, y, half, swing, colour, width) {
    ctx.beginPath();
    ctx.moveTo(x0, y);
    let up = true;
    for (let x = x0; x < x1; x += half) {
      ctx.quadraticCurveTo(x + half / 2, y + (up ? -swing : swing), x + half, y);
      up = !up;
    }
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  /* The colour mark: the iris tile, the white W, the lavender thread over its outside strokes and under its middle. */
  function mark(ctx, x, y, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 64, size / 64);
    const iris = ctx.createLinearGradient(0, 0, 0, 64);
    iris.addColorStop(0, '#5d50f0');
    iris.addColorStop(1, '#493cdd');
    ctx.fillStyle = iris;
    ctx.fill(new Path2D(MARK.tile));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.stroke(new Path2D(MARK.outer));
    ctx.strokeStyle = iris;  // (the small gap each side of the thread where it goes over)
    ctx.lineWidth = 7;
    ctx.stroke(new Path2D(MARK.thread));
    ctx.strokeStyle = '#e6e3ff';
    ctx.lineWidth = 4.4;
    ctx.stroke(new Path2D(MARK.thread));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.stroke(new Path2D(MARK.mid));
    ctx.restore();
  }
  function flame(ctx, x, y, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 120, size / 120);
    const outer = ctx.createLinearGradient(0, 0, 0, 120);
    outer.addColorStop(0, '#ff6b3d');
    outer.addColorStop(1, '#ffb347');
    ctx.fillStyle = outer;
    ctx.fill(new Path2D(FLAME));
    ctx.fillStyle = '#ffe49a';
    ctx.fill(new Path2D(FLAME_IN));
    ctx.restore();
  }
  function tile(ctx, x, y, w, h) {
    rounded(ctx, x, y, w, h, 40);
    ctx.fillStyle = INK.tile;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK.edge;
    ctx.stroke();
    // (the 1 px highlight along a raised thing's top, as dark mode draws it)
    ctx.save();
    rounded(ctx, x, y, w, h, 40);
    ctx.clip();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(x, y, w, 3);
    ctx.restore();
  }
  function number(ctx, n, label, x, y, w, h) {
    const big = n.toLocaleString('en-CA');
    fitted(ctx, big, x + 44, y + h * 0.55, w - 88, 136, 700, FONT, n ? INK.text : INK.muted);  // (a quiet 0)
    words(ctx, label, x + 44, y + h * 0.55 + 74, `500 42px ${FONT}`, INK.soft);
  }

  /* The picture of week `s` on `canvas` (made W x H). `name`: a first name for the title, or ''. */
  function draw(canvas, s, { name = '' } = {}) {
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const bg = ctx.createLinearGradient(0, 0, W * 0.45, H);
    bg.addColorStop(0, '#1a1638');
    bg.addColorStop(0.55, '#100f20');
    bg.addColorStop(1, '#0b0b14');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    for (const [cx, cy, r, a] of [[900, 280, 780, 0.42], [80, 1660, 620, 0.18]]) {
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      glow.addColorStop(0, `rgba(102, 96, 233, ${a})`);
      glow.addColorStop(1, 'rgba(102, 96, 233, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
    }
    // the loom's threads, faint, behind everything
    for (const [y, a] of [[396, 0.06], [1588, 0.07], [1632, 0.05], [1676, 0.09]]) wave(ctx, -60, W + 60, y, 110, 23, `rgba(162, 162, 236, ${a})`, 3);

    mark(ctx, 96, 232, 104);
    words(ctx, 'wefty', 226, 306, `600 76px ${DISPLAY}`, INK.text);
    fitted(ctx, name ? `${name}’s week in Wefty` : 'My week in Wefty', 96, 512, W - 192, 96, 600, DISPLAY, INK.text);
    words(ctx, rangeWords(s), 96, 584, `500 46px ${FONT}`, INK.muted);

    let y = 660;
    const inner = W - 192;
    if (s.streak) {
      tile(ctx, 96, y, inner, 220);
      flame(ctx, 140, y + 38, 144);
      fitted(ctx, `${s.streak}-day streak`, 300, y + 128, inner - 250, 104, 700, FONT, INK.text);
      words(ctx, 'One rest day a week keeps it going', 300, y + 186, `500 36px ${FONT}`, INK.muted);
      y += 220 + 36;
    }
    const h = s.streak ? 300 : 340;
    const gap = 32;
    const w = (inner - gap) / 2;
    const rows = [y, y + h + gap];
    const middle = rows[1] - gap / 2;
    // the woven thread: under the tiles on the left, over the ones on the right (with the logo's small gap)
    wave(ctx, 40, W - 40, middle, 116, 30, INK.thread, 7);
    const cells = [[s.cards, plural(s.cards, 'card studied', 'cards studied')],
      [s.minutes, plural(s.minutes, 'minute studying', 'minutes studying')],
      [s.notes, plural(s.notes, 'note made', 'notes made')], [s.tests, plural(s.tests, 'test done', 'tests done')]];
    cells.forEach(([n, label], i) => {
      const x = 96 + (i % 2) * (w + gap);
      const top = rows[Math.floor(i / 2)];
      tile(ctx, x, top, w, h);
      number(ctx, n, label, x, top, w, h);
    });
    ctx.save();
    ctx.beginPath();
    ctx.rect(96 + w + gap, 0, w, H);
    ctx.clip();
    wave(ctx, 40, W - 40, middle, 116, 30, '#100f20', 13);
    wave(ctx, 40, W - 40, middle, 116, 30, INK.thread, 7);
    ctx.restore();

    const foot = rows[1] + h + 110;
    mark(ctx, 96, foot - 40, 48);
    words(ctx, 'Made with Wefty', 162, foot, `500 36px ${FONT}`, INK.muted);
    return canvas;
  }

  /* Inter, loaded before drawing (the page may not have used every weight yet); never waits long. */
  async function fonts() {
    if (!document.fonts || !document.fonts.load) return;
    const wanted = [`600 96px ${DISPLAY}`, `700 136px ${FONT}`, `500 42px ${FONT}`];
    await Promise.race([Promise.all(wanted.map((f) => document.fonts.load(f).catch(() => null))),
      new Promise((resolve) => { setTimeout(resolve, 2500); })]);
  }

  /* The week's picture as a PNG Blob. */
  async function render(s, opts = {}) {
    await fonts();
    const canvas = draw(document.createElement('canvas'), s, opts);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The picture couldn\'t be made.'))), 'image/png');
    });
  }

  /* -- handing it over */

  const phone = () => !V.desktop && !!(V.deviceKind.android || V.deviceKind.ios);
  const fileName = (s) => `wefty-week-${s.from}.png`;

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = V.h('a', { href: url, download: name, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    V.toast(V.desktop ? `Saved ${name} in ${(V.prefs && V.prefs.downloads) || 'Downloads'}.`
      : V.deviceKind.chromebook ? `Saved ${name} in Downloads. Find it in the Files app.`
        : V.deviceKind.ios ? `${name}: find it in the Files app, in Downloads.`
          : V.deviceKind.android ? `${name} is in your Downloads.` : `Downloaded ${name}.`, { ms: 6000 });
    return 'downloaded';
  }

  /* The share sheet with the picture (a phone): 'shared', 'cancelled', or a download when the browser won't. */
  async function share(file, blob) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (error) {
      if (error && error.name === 'AbortError') return 'cancelled';
      console.warn('Wefty: sharing the week didn\'t work, so it downloads instead.', error);
      return download(blob, file.name);
    }
  }
  const shareable = (file) => {
    if (!phone() || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
    try { return navigator.canShare({ files: [file] }); } catch (error) { return false; }
  };

  /* -- the sheet: the picture, which week, a first name or not, and Share / Save (a phone) or Download */

  // (the choice is the signed-in person's own: someone else on this device never gets their name on a picture)
  const me = () => (V.data.user && V.data.user.id) || '';
  function nameChoice() {
    try {
      const raw = JSON.parse(localStorage.getItem(NAME) || 'null');
      if (raw && typeof raw === 'object' && raw.user && raw.user === me()) {
        return { on: raw.on === true, name: String(raw.name || '').slice(0, NAME_MOST) };
      }
    } catch (error) { /* a private window */ }
    const first = String((V.data.user && V.data.user.name) || '').trim().split(/\s+/)[0] || '';
    return { on: false, name: first.slice(0, NAME_MOST) };
  }
  function keepName(choice) {
    try { localStorage.setItem(NAME, JSON.stringify({ user: me(), on: choice.on, name: choice.name })); } catch (error) { /* this visit only */ }
  }
  V.on('signing-out', () => { try { localStorage.removeItem(NAME); } catch (error) { /* nothing kept */ } });
  const cleanName = (text) => String(text || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, NAME_MOST);

  let open_ = null;  // the sheet showing now

  function open(which = usual()) {
    if (open_) open_.close();
    let current = which;
    let made = null;   // { blob, file, s, key }
    let url = '';
    let turn = 0;
    const choice = nameChoice();
    const shot = V.h('img.week-shot', { alt: '' });
    const frame = V.h('div.week-frame', { 'aria-busy': 'true' }, shot);
    const weeks = V.h('div.segmented.week-which', { role: 'radiogroup', 'aria-label': 'Which week' },
      [['this', 'This week'], ['last', 'Last week']].map(([value, label]) => V.h('button', { type: 'button', role: 'radio',
        'aria-checked': String(current === value), dataset: { week: value },
        onclick: () => { if (current !== value) { current = value; mark_(); redo(); } } }, V.h('span', { text: label }))));
    const mark_ = () => { for (const b of weeks.children) b.setAttribute('aria-checked', String(b.dataset.week === current)); };
    const nameBox = V.h('input.field.week-name-box', { type: 'text', value: choice.name, maxlength: String(NAME_MOST),
      placeholder: 'Your first name', 'aria-label': 'Your first name', autocomplete: 'given-name', hidden: !choice.on,
      oninput: () => { choice.name = cleanName(nameBox.value); keepName(choice); redoSoon(); } });
    const nameSwitch = V.h('input.switch', { type: 'checkbox', checked: choice.on, 'aria-label': 'Add my first name',
      onchange: () => {
        choice.on = nameSwitch.checked;
        nameBox.hidden = !choice.on;
        keepName(choice);
        if (choice.on) nameBox.focus();
        redo();
      } });
    const nameRow = V.h('div.week-name', {},
      V.h('label.week-name-row', {}, V.h('span.week-name-text', {}, V.h('strong', { text: 'Add my first name' }),
        V.h('span', { text: 'Only on the picture, only if you want it.' })), nameSwitch), nameBox);
    const empty = V.h('p.hint.week-empty', { hidden: true });
    const sheetShown = V.sheet({
      title: 'Your week in Wefty',
      // (wide: the picture on the left, the choices beside it)
      content: [frame, V.h('div.week-controls', {}, empty, weeks, nameRow,
        V.h('p.hint.week-private', { text: 'Only these numbers are on it. It stays on this device unless you share it.' }))],
      actions: phone() ? [
        { label: 'Save', icon: 'download', onClick: () => { if (made) download(made.blob, made.file.name); return true; } },
        { label: 'Share', kind: 'primary', icon: 'share', onClick: async () => {
          if (!made) return true;
          if (!shareable(made.file)) { download(made.blob, made.file.name); return true; }
          const how = await share(made.file, made.blob);
          return how === 'cancelled';
        } },
      ] : [
        { label: 'Download', kind: 'primary', icon: 'download', onClick: () => { if (made) download(made.blob, made.file.name); } },
      ],
      onClose: () => {
        if (open_ && open_.el === sheetShown.el) open_ = null;
        if (url) URL.revokeObjectURL(url);
        url = '';
      },
    });
    sheetShown.el.classList.add('week-sheet');
    const buttons = () => [...sheetShown.el.querySelectorAll('.sheet-actions .btn')];
    open_ = sheetShown;

    async function redo() {
      const mine = ++turn;
      frame.setAttribute('aria-busy', 'true');
      for (const b of buttons()) b.disabled = true;
      const s = stats(range(current));
      const name = choice.on ? cleanName(choice.name) : '';
      const nothing = !s.cards && !s.minutes && !s.notes && !s.tests;
      empty.hidden = !nothing;
      empty.textContent = nothing ? (current === 'this' ? 'Nothing yet this week. Study some cards and it fills up.'
        : 'Nothing in Wefty last week.') : '';
      try {
        const blob = await render(s, { name });
        if (mine !== turn || !sheetShown.el.isConnected) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        made = { blob, s, file: new File([blob], fileName(s), { type: 'image/png' }) };
        shot.src = url;
        shot.alt = said(s, name);
        frame.removeAttribute('aria-busy');
        for (const b of buttons()) b.disabled = false;
      } catch (error) {
        if (mine !== turn) return;
        console.error('Wefty: the week\'s picture:', error);
        empty.hidden = false;
        empty.textContent = 'The picture couldn\'t be made on this device.';
      }
    }
    const redoSoon = V.debounce(() => redo(), 300);
    redo();
    return sheetShown;
  }

  /* -- Today's card, Sundays and Mondays */

  function seen() {
    try { return JSON.parse(localStorage.getItem(SEEN) || 'null') || {}; } catch (error) { return {}; }
  }
  function remember(from) {
    const who = (V.data.user && V.data.user.id) || '';
    try { localStorage.setItem(SEEN, JSON.stringify({ user: who, from })); } catch (error) { /* shown again next time */ }
  }
  const shownAlready = (from) => {
    const was = seen();
    return was.from === from && was.user === ((V.data.user && V.data.user.id) || '');
  };

  function todayCard() {
    const today = V.today();
    const day = V.parseDate(today).getDay();
    if (day !== 0 && day !== 1) return null;
    // (after this page's first sync: a new device would otherwise show a week it doesn't know yet)
    if (!S().synced()) return null;
    const week = range(day === 0 ? 'this' : 'last', today);
    if (shownAlready(week.from)) return null;
    const s = stats(week);
    if (!s.studied && !s.tests) return null;
    const close = () => { remember(week.from); if (V.today.redraw) V.today.redraw(); };
    return V.h('section.today-sec.today-weekly', { dataset: { section: 'week' } },
      V.h('div.today-box.week-card', {},
        V.h('span.week-card-mark', { 'aria-hidden': 'true' }, V.mark(36, '', { colour: true })),
        V.h('div.week-card-text', {}, V.h('h2', { text: day === 0 ? 'Your week in Wefty' : 'Last week in Wefty' }),
          V.h('p', { text: line(s) || rangeWords(s) }),
          V.button('See it', { kind: 'tonal', icon: 'spark', key: 'week:see', onClick: () => {
            remember(week.from);
            open(week.which);
            if (V.today.redraw) V.today.redraw();
          } })),
        V.iconButton('x', 'Not this week', close, 'week-card-x', 'week:x')));
  }

  if (V.today && V.today.addSection && V.streak) {  // (js/streak.js didn't load: no numbers to show)
    V.today.addSection({ id: 'week', order: 16, column: 'left', build: todayCard });
    V.today.addMenuItem({ id: 'week', label: 'Your week in Wefty', icon: 'spark', onClick: () => open() });
  }

  return { open, render, draw, stats, range, rangeWords, line, isTest, todayCard, W, H };
})();
