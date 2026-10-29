/* Vault: school tools, from a note's tools.

   Flash cards: any line written "term :: definition" (or "Question? :: Answer") is a card, and so is each {{blank}}
   in a line ("The {{mitochondria}} makes ATP": "The ____ makes ATP", answer "mitochondria"; with two blanks in a line,
   two cards, each showing the other one filled in). They make the Study and Learn buttons show. Studying flips through
   the ones due (js/review.js schedules them with FSRS, the way Anki does); Learn quizzes them (js/learn.js). Each
   card's progress is kept in the note's extra.cards by a short code: a "term :: definition" card's made from its term
   and a blank's from its hidden word, so changing a definition, or the words round a blank, keeps its progress.

   Focus timer: 25 minutes of work, then a 5 minute break (both can be changed; kept on this device). The screen stays
   on while it runs (where the browser can), and the end buzzes and chimes. The minutes go into the note's
   extra.focus_minutes (by day), and the note says "Focused 50 min this week".

   Repeating checklists: "Repeat: daily" or "weekly" (extra.reset) takes the ticks off by itself when the day (or the
   week, on Monday) turns over: done on this device when the note is next opened or listed, and saved like any edit
   (extra.reset_at says which day or week the ticks belong to). */
'use strict';

V.study = (() => {
  const R = V.reminders;
  const icon = R.icon;
  const pad = (n) => String(n).padStart(2, '0');
  const dayText = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /* -- flash cards */

  const CARD = /^\s*(?:[-*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+|#{1,3}\s+)?(.+?)\s*::\s*(.+?)\s*$/;
  const LEAD = /^\s*(?:[-*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+|#{1,3}\s+)?/;  // a list mark, tick box or heading mark
  const FENCE = /^\s*```/;
  const GAP = '____';
  // #tags at the end of a card's line ("leer :: to read #vocab") file it away; they aren't part of the answer.
  const TAGS_AT_END = /(?:\s+#(?=\p{N}*\p{L})[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*)+$/u;

  /* A short code for a term (FNV-1a), so a card keeps its progress when its definition changes. */
  function code(text) {
    let h = 0x811c9dc5;
    for (const ch of String(text)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  /* The flash cards in a note's words: [{ key, term, answer, line, kind }]. A "term :: definition" card is kind 'qa';
     a blank's ('blank') term is its line with a gap where the blank is (the other blanks filled in), and it also has
     `before` and `after`, the words either side of the gap. Lines in ``` code blocks have no blanks. A card is read
     without its marks (**bold**, ==highlight==...: js/format.js unmark), so marking a word in it keeps its code and
     never shows the marks (or gives the answer away in Learn). `was`: the code a card had when its marks still counted
     as its words (Ctrl+B in a card on the PC could put some in), where its progress may still be kept (see prune). */
  function cards(text) {
    const out = [];
    const namer = () => {
      const keys = new Set();
      return (first, again) => {
        let key = code(first);
        for (let n = 2; keys.has(key); n++) key = code(again + '#' + n);
        keys.add(key);
        return key;
      };
    };
    const named = namer();
    const namedBefore = namer();
    const termKey = (name, term) => name(term.toLowerCase().replace(/\s+/g, ' '), term.toLowerCase());
    const wordKey = (name, word) => {
      const low = word.toLowerCase();
      return name(`{{${low.replace(/\s+/g, ' ')}}}`, `{{${low}}}`);
    };
    const unmark = V.format.unmark;
    const asCard = (line) => {
      const found = CARD.exec(line);
      return found && !/^[a-z][\w+.-]*:\/\/?$/i.test(found[1].trim()) ? found : null;
    };
    let fenced = false;
    let fencedBefore = false;
    String(text || '').split('\n').forEach((line, index) => {
      const holes = line.includes('{{') ? V.format.blanks(line) : [];
      // The line's cards the way they were read before (marks and all): only their codes, `was`.
      let before = { kind: null, keys: [] };
      const old = asCard(line);
      if (old) {
        if (old[1].trim() && old[2].trim().replace(TAGS_AT_END, '')) before = { kind: 'qa', keys: [termKey(namedBefore, old[1].trim())] };
      } else if (FENCE.test(line)) fencedBefore = !fencedBefore;
      else if (!fencedBefore && holes.length) before = { kind: 'blank', keys: holes.map((h) => wordKey(namedBefore, h.word)) };
      const add = (card, i = 0) => {
        const was = before.kind === card.kind ? before.keys[i] : undefined;
        if (was && was !== card.key) card.was = was;
        out.push(card);
      };
      const plain = unmark(line);
      const found = asCard(plain);
      if (found) {
        const term = found[1].trim();
        const answer = found[2].trim().replace(TAGS_AT_END, '');
        if (!term || !answer) return;
        add({ key: termKey(named, term), term, answer, line: index, kind: 'qa' });
        return;
      }
      if (FENCE.test(line)) { fenced = !fenced; return; }
      if (fenced || !holes.length) return;
      const lead = LEAD.exec(line)[0].length;
      holes.forEach((hole, i) => {
        // The line with this blank's word between two markers (the other blanks filled in) without its marks, then cut
        // at the markers: "The **{{mitochondria}}** makes ATP" is "The ____ makes ATP".
        let words = '';
        let at = lead;
        holes.forEach((h, k) => { words += line.slice(at, h.start) + (k === i ? `\u0001${h.word}\u0002` : h.word); at = h.end; });
        words += line.slice(at);
        const cut = (text) => {
          const open = text.indexOf('\u0001');
          const close = text.indexOf('\u0002', open);
          return open >= 0 && close > open ? [text.slice(0, open), text.slice(close + 1)] : null;
        };
        const sides = cut(unmark(words)) || cut(words);
        const answer = unmark(hole.word).trim() || hole.word;
        const [front, back] = [sides[0].replace(/^\s+/, ''), sides[1].replace(/\s+$/, '')];
        add({ key: wordKey(named, answer), term: front + GAP + back, answer, before: front, after: back, line: index,
          kind: 'blank' }, i);
      });
    });
    return out;
  }

  /* Only the cards still in the note keep their progress (a card read with marks before keeps its old code's). */
  function prune(state, list) {
    const out = {};
    for (const c of list) {
      const value = state[c.key] || (c.was ? state[c.was] : undefined);
      if (value) out[c.key] = value;
    }
    return out;
  }

  /* The note's own flash cards, studied (js/review.js): the ones due, else a practice round of them all. */
  function studySheet() {
    const id = V.editor.openId();
    if (!id || !cards(V.editor.words()).length) {
      return V.toast('Write cards as "term :: definition" (or "The {{word}} in a sentence"), one a line, then press Study.');
    }
    return V.review.study(id);
  }

  /* -- focus timer */

  const FOCUS_PREFS = 'vault-focus';
  function prefs() {
    try {
      const kept = JSON.parse(localStorage.getItem(FOCUS_PREFS) || '{}');
      return { work: clampMinutes(kept.work, 25), rest: clampMinutes(kept.rest, 5) };
    } catch (error) {
      return { work: 25, rest: 5 };
    }
  }
  function keepPrefs(values) {
    try { localStorage.setItem(FOCUS_PREFS, JSON.stringify(values)); } catch (error) { /* private browsing */ }
  }
  const clampMinutes = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 1 ? Math.min(120, Math.round(Number(value))) : fallback);

  /* The timer itself, on whatever clock it's given (Date.now, or a test's): work, then a break, then it stops. Each
     tick() says what ended since the last one. */
  function makeTimer({ work = 25, rest = 5, now = () => Date.now() } = {}) {
    let phase = 'idle';   // idle, work or rest
    let running = false;
    let endsAt = 0;
    let left = 0;         // while paused
    const length = (which) => (which === 'work' ? work : rest) * 60000;
    const remaining = () => (phase === 'idle' ? length('work') : running ? Math.max(0, endsAt - now()) : left);
    return {
      get phase() { return phase; },
      get running() { return running; },
      get work() { return work; },
      get rest() { return rest; },
      remaining,
      set(minutes) {
        if (phase !== 'idle') return;
        work = clampMinutes(minutes.work, work);
        rest = clampMinutes(minutes.rest, rest);
      },
      start() { phase = 'work'; running = true; endsAt = now() + length('work'); },
      pause() { if (!running) return; left = remaining(); running = false; },
      resume() { if (running || phase === 'idle') return; endsAt = now() + left; running = true; },
      /* Stopped part way: the whole minutes of work done (a break gives none). */
      stop() {
        const worked = phase === 'work' ? Math.floor((length('work') - remaining()) / 60000) : 0;
        phase = 'idle';
        running = false;
        return worked;
      },
      tick() {
        const ended = [];
        while (running && now() >= endsAt) {
          if (phase === 'work') {
            ended.push({ type: 'work-done', minutes: work });
            phase = 'rest';
            endsAt += length('rest');
          } else {
            ended.push({ type: 'rest-done' });
            phase = 'idle';
            running = false;
          }
        }
        return ended;
      },
    };
  }

  let focus = null;        // { id, timer, ui, wake, sound }
  let ticking = null;

  const chipText = () => `${focus.timer.phase === 'work' ? 'Focus' : 'Break'} ${mmss(focus.timer.remaining())}`
    + (focus.timer.running ? '' : ' (paused)');
  /* The note's bar drawn again (its focus chip comes or goes). */
  const redrawBar = () => { if (V.editor.openId()) V.editor.update(() => {}); };
  const mmss = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
  const minutesText = (n) => (n < 60 ? `${n} min` : `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ''}`);

  /* This week's (from Monday) focus minutes of a note. */
  function weekMinutes(note, now = new Date()) {
    const kept = (note && note.extra && note.extra.focus_minutes) || {};
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const from = dayText(monday);
    const to = dayText(now);
    return Object.entries(kept).reduce((sum, [day, minutes]) => sum + (day >= from && day <= to ? Number(minutes) || 0 : 0), 0);
  }

  /* `minutes` more on `id`'s note today (days over 8 weeks old are let go). */
  function addMinutes(id, minutes, now = new Date()) {
    if (!(minutes > 0)) return Promise.resolve();
    const today = dayText(now);
    const oldest = dayText(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 56));
    return R.change(id, (row) => {
      const kept = {};
      for (const [day, value] of Object.entries(row.extra.focus_minutes || {})) if (day >= oldest) kept[day] = value;
      kept[today] = (Number(kept[today]) || 0) + minutes;
      row.extra.focus_minutes = kept;
    });
  }

  async function keepAwake(on) {
    if (!focus) return;
    if (!on) {
      const lock = focus.wake;
      focus.wake = null;
      if (lock) lock.release().catch(() => {});
      return;
    }
    if (focus.wake || !('wakeLock' in navigator) || document.hidden) return;
    try {
      focus.wake = await navigator.wakeLock.request('screen');
      focus.wake.addEventListener('release', () => { if (focus) focus.wake = null; });
    } catch (error) { /* low battery, or not allowed: the timer runs all the same */ }
  }
  document.addEventListener('visibilitychange', () => { if (focus && focus.timer.running) keepAwake(true); });

  function chime() {
    try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch (error) { /* no buzz */ }
    const sound = focus && focus.sound;
    if (!sound) return;
    try {
      const start = sound.currentTime + 0.02;
      [0, 0.28].forEach((delay, i) => {
        const tone = sound.createOscillator();
        const level = sound.createGain();
        tone.type = 'sine';
        tone.frequency.value = i ? 1046.5 : 784;
        level.gain.setValueAtTime(0.0001, start + delay);
        level.gain.exponentialRampToValueAtTime(0.25, start + delay + 0.02);
        level.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.45);
        tone.connect(level).connect(sound.destination);
        tone.start(start + delay);
        tone.stop(start + delay + 0.5);
      });
    } catch (error) { /* no sound, no matter */ }
  }

  function tick() {
    if (!focus) return;
    const { timer, id } = focus;
    for (const ended of timer.tick()) {
      chime();
      if (ended.type === 'work-done') {
        addMinutes(id, ended.minutes).catch(V.problem);
        const say = `Focus done: ${ended.minutes} min. Take a ${timer.rest} minute break.`;
        V.toast(say, { ms: 8000 });
        if (document.hidden) R.notify('Focus done', { body: say, tag: 'vault-focus' });
      } else {
        V.toast('Break\'s over. Ready for another?', { ms: 8000, action: 'Start', onAction: () => startFocus(id) });
        if (document.hidden) R.notify('Break\'s over', { body: 'Ready for another?', tag: 'vault-focus' });
      }
    }
    if (!timer.running) keepAwake(false);
    if (timer.phase === 'idle' && !timer.running) {
      clearInterval(ticking);
      ticking = null;
      redrawBar();
    }
    drawFocus();
  }

  function startFocus(id) {
    if (!focus || focus.id !== id) {
      if (focus) stopFocus();
      focus = { id, timer: makeTimer(prefs()), wake: null, sound: null, ui: focus && focus.id === id ? focus.ui : null };
    }
    try { focus.sound = focus.sound || new (window.AudioContext || window.webkitAudioContext)(); } catch (error) { focus.sound = null; }
    focus.timer.start();
    keepAwake(true);
    clearInterval(ticking);
    ticking = setInterval(tick, 500);
    redrawBar();
    drawFocus();
  }

  function stopFocus() {
    if (!focus) return;
    const minutes = focus.timer.stop();
    const id = focus.id;
    keepAwake(false);
    clearInterval(ticking);
    ticking = null;
    if (minutes > 0) addMinutes(id, minutes).then(() => V.toast(`${minutesText(minutes)} of focus added to this note.`)).catch(V.problem);
    redrawBar();
    drawFocus();
  }

  /* The timer's sheet and the note's chip, as they are now. */
  function drawFocus() {
    const live = focus && focus.timer.phase !== 'idle';
    for (const chip of document.querySelectorAll('.focus-chip[data-live]')) {
      if (live && chip.dataset.id === focus.id) chip.lastChild.textContent = chipText();
    }
    const ui = focus && focus.ui;
    if (!ui || !ui.time.isConnected) return;
    const { timer } = focus;
    const total = (timer.phase === 'rest' ? timer.rest : timer.work) * 60000;
    ui.phase.textContent = timer.phase === 'work' ? 'Focus' : timer.phase === 'rest' ? 'Break' : 'Ready';
    ui.time.textContent = mmss(timer.remaining());
    ui.fill.style.width = timer.phase === 'idle' ? '0%' : `${(100 * (total - timer.remaining())) / total}%`;
    ui.box.classList.toggle('resting', timer.phase === 'rest');
    ui.settings.hidden = timer.phase !== 'idle';
    ui.workValue.textContent = `${timer.work} min`;
    ui.restValue.textContent = `${timer.rest} min`;
    const id = focus.id;
    V.clear(ui.buttons, timer.phase === 'idle'
      ? V.button('Start', { kind: 'primary wide-btn', icon: 'play', onClick: () => startFocus(id) })
      : [timer.running
        ? V.button('Pause', { onClick: () => { timer.pause(); keepAwake(false); drawFocus(); } })
        : V.button('Resume', { kind: 'primary', onClick: () => { timer.resume(); keepAwake(true); drawFocus(); } }),
      V.button('Stop', { kind: 'danger-quiet', onClick: stopFocus })]);
    const note = R.latest(id);
    ui.week.textContent = note ? `Focused ${minutesText(weekMinutes(note))} this week on this note.` : '';
  }

  function focusSheet() {
    const id = V.editor.openId();
    if (!id) return;
    if (!focus || (focus.id !== id && focus.timer.phase === 'idle')) {
      focus = { id, timer: makeTimer(prefs()), wake: null, sound: null, ui: null };
    } else if (focus.id !== id) {
      return V.toast('A focus timer is running on another note. Stop it there first.', { action: 'Open it',
        onAction: () => R.openNote(focus.id) });
    }
    const timer = focus.timer;
    const step = (which, by) => () => {
      const now = { work: timer.work, rest: timer.rest };
      now[which] = Math.max(1, Math.min(120, now[which] + by));
      timer.set(now);
      keepPrefs(now);
      drawFocus();
    };
    const stepButton = (name, title, onClick) => V.h('button.icon-btn.focus-btn', { type: 'button', title, 'aria-label': title,
      onclick: onClick }, icon(name));
    const stepper = (which, label, value) => V.h('div.focus-step', {},
      V.h('span.focus-step-name', { text: label }),
      stepButton('minus', `Less ${label.toLowerCase()} time`, step(which, which === 'work' ? -5 : -1)),
      value,
      stepButton('plus', `More ${label.toLowerCase()} time`, step(which, which === 'work' ? 5 : 1)));
    const ui = {
      phase: V.h('span.focus-phase'),
      time: V.h('span.focus-time.num', { role: 'timer', 'aria-live': 'off' }),
      fill: V.h('i'),
      buttons: V.h('div.focus-buttons'),
      workValue: V.h('span.focus-value.num'),
      restValue: V.h('span.focus-value.num'),
      week: V.h('p.hint.focus-week'),
    };
    ui.settings = V.h('div.focus-settings', {}, stepper('work', 'Focus', ui.workValue), stepper('rest', 'Break', ui.restValue));
    ui.box = V.h('div.focus-box', {}, ui.phase, ui.time, V.h('span.bar.focus-bar', {}, ui.fill));
    focus.ui = ui;
    V.sheet({
      title: 'Focus timer',
      content: [ui.box, ui.buttons, ui.settings,
        V.h('p.hint.focus-hint', { text: ('wakeLock' in navigator ? 'The screen stays on while it runs. ' : '')
          + 'You can close this: the timer keeps going, and the note shows how long is left.' }),
        ui.week],
    });
    drawFocus();
  }

  /* -- repeating checklists */

  const TICKED = /^(\s*[-*]\s*\[)[xX](\])/;
  const HAS_ITEMS = /^\s*[-*]\s*\[( |x|X)\]/m;

  /* Which day (daily) or week (weekly: its Monday) ticks belong to now. */
  function period(kind, now = new Date()) {
    if (kind === 'weekly') return dayText(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)));
    return dayText(now);
  }

  const untick = (text) => String(text || '').split('\n').map((line) => line.replace(TICKED, '$1 $2')).join('\n');

  /* A repeating note whose day or week has turned over: { body, key } (its ticks off), else null. */
  function resetFor(note, now = new Date()) {
    const kind = note && note.extra && note.extra.reset;
    if (!note || note.locked || note.deleted || (kind !== 'daily' && kind !== 'weekly')) return null;
    const key = period(kind, now);
    if (note.extra.reset_at === key) return null;
    return { body: untick(note.body), key };
  }

  /* Before a note opens (and for the notes in a list): its ticks off when its day or week has turned over. */
  function resetRow(note, now = new Date()) {
    if (!note || V.editor.openId() === note.id) return false;
    const reset = resetFor(note, now);
    if (!reset) return false;
    V.cloud.save('notes', { ...note, body: reset.body, extra: { ...note.extra, reset_at: reset.key } }).catch(V.problem);
    return true;
  }

  const resetDue = (list, now = new Date()) => list.filter((note) => resetRow(note, now)).length;

  /* The note open across midnight (the PC left on): its ticks come off in its boxes, as one Undo step. */
  function resetOpen(now = new Date()) {
    const note = V.editor.current();
    const text = V.editor.words();
    if (!note || text === null) return false;
    const reset = resetFor({ ...note, body: text }, now);
    if (!reset) return false;
    V.editor.setWords(reset.body);
    V.editor.update((row) => { row.extra = { ...(row.extra || {}), reset_at: reset.key }; });
    return true;
  }

  function repeatSheet() {
    const id = V.editor.openId();
    const note = V.editor.current();
    if (!id || !note) return;
    const now = (note.extra && note.extra.reset) || 'off';
    const choose = (kind) => {
      R.change(id, (row) => {
        if (kind === 'off') { delete row.extra.reset; delete row.extra.reset_at; }
        else { row.extra.reset = kind; row.extra.reset_at = period(kind); }
      }).catch(V.problem);
      sheet.close();
      V.toast(kind === 'off' ? 'This checklist doesn\'t repeat any more.'
        : `Repeats ${kind}: the ticks come off ${kind === 'daily' ? 'each morning' : 'each Monday'}.`);
    };
    const option = (kind, title, hint) => V.h('button.repeat-option' + (now === kind ? '.on' : ''), {
      type: 'button', 'aria-pressed': String(now === kind), onclick: () => choose(kind),
    }, V.h('span.repeat-mark', {}, V.icon('check')), V.h('span.repeat-text', {}, V.h('strong', { text: title }), V.h('span', { text: hint })));
    const sheet = V.sheet({
      title: 'Repeat this checklist',
      content: [
        V.h('p', { text: 'For things you do again and again: the ticks come off by themselves, so the list is fresh.' }),
        V.h('div.repeat-options', {},
          option('daily', 'Daily', 'Fresh every morning'),
          option('weekly', 'Weekly', 'Fresh every Monday'),
          option('off', 'Off', 'Ticks stay until you take them off')),
      ],
    });
  }

  /* -- hooked into the note */

  // Not in a locked note: a card's progress is kept by a code made from its words, which would give them away.
  const hasCards = (note, text) => !note.locked && cards(text).length > 0;
  V.editor.addTool({ name: 'study', label: 'Study', icon: () => icon('cards'), keepCaret: false, onClick: studySheet,
    shown: hasCards });
  V.editor.addTool({ name: 'learn', label: 'Learn', icon: () => V.icon('learn'), keepCaret: false, shown: hasCards,
    onClick: () => { const id = V.editor.openId(); if (id) V.learn.forNote(id); } });
  V.editor.addTool({ name: 'focus', label: 'Focus timer', icon: () => icon('timer'), keepCaret: false, onClick: focusSheet });
  V.editor.addTool({ name: 'repeat', label: 'Repeat', icon: () => icon('repeat'), keepCaret: false, onClick: repeatSheet,
    shown: (note, text) => HAS_ITEMS.test(text || '') || !!(note.extra && note.extra.reset) });

  V.editor.addMeta((note) => {
    if (focus && focus.id === note.id && focus.timer.phase !== 'idle') {
      return V.h('button.chip.focus-chip.on-now', { type: 'button', title: 'Focus timer', onclick: focusSheet,
        dataset: { id: note.id, live: '1' } }, icon('timer'), V.h('span', { text: chipText() }));
    }
    const minutes = weekMinutes(note);
    return minutes ? V.h('button.chip.focus-chip', { type: 'button', title: 'Focus timer', onclick: focusSheet },
      icon('timer'), V.h('span', { text: `Focused ${minutesText(minutes)} this week` })) : null;
  });

  V.editor.addMeta((note) => {
    const kind = note.extra && note.extra.reset;
    if (kind !== 'daily' && kind !== 'weekly') return null;
    return V.h('button.chip.repeat-chip', { type: 'button', title: 'Repeat this checklist', onclick: repeatSheet },
      icon('repeat'), V.h('span', { text: kind === 'daily' ? 'Repeats daily' : 'Repeats weekly' }));
  });

  V.editor.onOpen((id) => resetRow(V.data.notes.get(id)));
  V.on('back', () => resetOpen());
  setInterval(() => { if (!V.away()) resetOpen(); }, 5 * 60000);

  return { cards, prune, code, GAP, makeTimer, weekMinutes, addMinutes, period, untick, resetFor, resetDue,
    resetOpen, studySheet, focusSheet, repeatSheet, minutesText, running: () => focus };
})();
