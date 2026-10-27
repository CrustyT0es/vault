/* Vault: school tools, from a note's tools.

   Flash cards: any line written "term :: definition" (or "Question? :: Answer") makes a Study button show. Studying
   flips through them: "I knew it" moves a card up a Leitner box (it comes back in 1, 3, 7, then 14 days), "Not yet"
   puts it back in the first (today, and again this time round). The boxes are kept in the note's extra.cards, by a
   short code made from each term, so changing a definition keeps its box.

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
  const INTERVALS = [0, 0, 1, 3, 7, 14];  // days until a card in box 1 to 5 comes back
  const BOXES = 5;

  /* A short code for a term (FNV-1a), so a card keeps its box when its definition changes. */
  function code(text) {
    let h = 0x811c9dc5;
    for (const ch of String(text)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  /* The flash cards in a note's words: [{ key, term, answer, line }]. */
  function cards(text) {
    const out = [];
    const keys = new Set();
    String(text || '').split('\n').forEach((line, index) => {
      const found = CARD.exec(line);
      if (!found || /^[a-z][\w+.-]*:\/\/?$/i.test(found[1].trim())) return;
      const term = found[1].trim();
      const answer = found[2].trim();
      if (!term || !answer) return;
      let key = code(term.toLowerCase().replace(/\s+/g, ' '));
      for (let n = 2; keys.has(key); n++) key = code(term.toLowerCase() + '#' + n);
      keys.add(key);
      out.push({ key, term, answer, line: index });
    });
    return out;
  }

  const boxOf = (state, key) => (Array.isArray(state[key]) ? Number(state[key][0]) || 0 : 0);
  const dueOn = (state, key) => (Array.isArray(state[key]) ? String(state[key][1] || '') : '');

  /* A card answered: up a box (most 5) when known, back to box 1 when not; when it comes back. */
  function answer(state, key, knew, today = V.today()) {
    const box = knew ? Math.min(BOXES, Math.max(1, boxOf(state, key)) + 1) : 1;
    return { ...state, [key]: [box, V.addDays(today, INTERVALS[box])] };
  }

  /* The cards to study today: new ones, and ones whose day has come; fewest-known first. */
  function dueCards(list, state, today = V.today()) {
    return list.filter((c) => !state[c.key] || dueOn(state, c.key) <= today)
      .sort((a, b) => boxOf(state, a.key) - boxOf(state, b.key) || a.line - b.line);
  }

  /* Only the cards still in the note keep a box. */
  function prune(state, list) {
    const out = {};
    for (const c of list) if (state[c.key]) out[c.key] = state[c.key];
    return out;
  }

  function shuffle(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function studySheet() {
    const id = V.editor.openId();
    const note = V.editor.current();
    const list = cards(V.editor.words());
    if (!id || !note || !list.length) return V.toast('Write cards as "term :: definition", one a line, then press Study.');
    let state = prune({ ...((note.extra && note.extra.cards) || {}) }, list);
    let queue = dueCards(list, state);
    let all = !queue.length;  // everything known for today: a practice round of the lot
    if (all) queue = [...list];
    let shuffled = false;
    let flipped = false;
    let knew = 0;
    let missed = 0;
    let total = queue.length;
    const missedKeys = new Set();

    const ui = {
      progress: V.h('p.study-progress', { 'aria-live': 'polite' }),
      fill: V.h('i'),
      card: V.h('button.flash-card', { type: 'button', onclick: () => flip() }),
      actions: V.h('div.study-actions'),
      shuffle: V.h('button.chip.study-shuffle', { type: 'button', 'aria-pressed': 'false', onclick: () => toggleShuffle() },
        icon('shuffle'), 'Shuffle'),
    };
    const known = () => list.filter((c) => boxOf(state, c.key) >= 2).length;

    function save() {
      const kept = prune(state, list);
      R.change(id, (row) => { row.extra.cards = kept; }).catch(V.problem);
    }

    function draw() {
      const card = queue[0];
      const done = total - queue.length;
      ui.fill.style.width = total ? `${(100 * done) / total}%` : '0%';
      if (!card) {
        ui.progress.textContent = `${known()} of ${list.length} cards known`;
        V.clear(ui.card, V.h('span.flash-side', { text: 'All done' }),
          V.h('span.flash-words.end', { text: missed ? `You knew ${knew} of ${knew + missed}. The ones to practise come back first next time.`
            : `You knew all ${knew}. Nice work!` }));
        ui.card.disabled = true;
        V.clear(ui.actions,
          V.button('Study them all again', { onClick: again }),
          V.button('Close', { kind: 'primary', onClick: () => sheet.close() }));
        return;
      }
      ui.card.disabled = false;
      ui.progress.textContent = `Card ${Math.min(done + 1, total)} of ${total} · ${known()} of ${list.length} known`
        + (all ? ' · practice round' : '');
      ui.card.classList.toggle('flipped', flipped);
      ui.card.setAttribute('aria-label', flipped ? `Answer: ${card.answer}. Tap to see the term again` : `${card.term}. Tap to see the answer`);
      V.clear(ui.card,
        V.h('span.flash-side', { text: flipped ? 'Answer' : `Box ${Math.max(1, boxOf(state, card.key))} of ${BOXES}` }),
        V.h('span.flash-words', { text: flipped ? card.answer : card.term }),
        V.h('span.flash-hint', {}, icon('flip'), flipped ? 'Tap to see the term' : 'Tap to see the answer'));
      V.clear(ui.actions, flipped
        ? [V.button('Not yet', { kind: 'not-yet', onClick: () => mark(false) }),
          V.button('I knew it', { kind: 'primary', icon: 'check', onClick: () => mark(true) })]
        : [V.button('Show answer', { kind: 'primary wide-btn', onClick: () => flip() })]);
    }

    function flip() {
      if (!queue.length) return;
      flipped = !flipped;
      draw();
    }

    function mark(itKnew) {
      const card = queue.shift();
      if (!card) return;
      state = answer(state, card.key, itKnew);
      if (itKnew) knew++;
      else if (!missedKeys.has(card.key)) {
        missed++;
        missedKeys.add(card.key);
        queue.push(card);  // once more before the end
        total++;
      }
      flipped = false;
      save();
      draw();
    }

    function toggleShuffle() {
      shuffled = !shuffled;
      ui.shuffle.setAttribute('aria-pressed', String(shuffled));
      ui.shuffle.classList.toggle('on', shuffled);
      queue = shuffled ? shuffle(queue) : [...queue].sort((a, b) => boxOf(state, a.key) - boxOf(state, b.key) || a.line - b.line);
      flipped = false;
      draw();
    }

    function again() {
      queue = shuffled ? shuffle(list) : [...list];
      all = true;
      total = queue.length;
      knew = 0;
      missed = 0;
      missedKeys.clear();
      flipped = false;
      draw();
    }

    const keys = (event) => {
      if (!ui.card.isConnected || event.target.closest('input, textarea, select')) return;
      if (event.key === ' ' && event.target === ui.card) return;  // the card's own click flips it
      if ((event.key === ' ' || event.key === 'Enter') && !event.target.closest('button')) { event.preventDefault(); flip(); }
      else if (flipped && (event.key === 'ArrowRight' || event.key === 'k')) { event.preventDefault(); mark(true); }
      else if (flipped && (event.key === 'ArrowLeft' || event.key === 'n')) { event.preventDefault(); mark(false); }
    };
    document.addEventListener('keydown', keys);
    const sheet = V.sheet({
      title: V.noteTitle({ ...note, body: V.editor.words() || '' }) + ': study',
      wide: true,
      content: [
        V.h('div.study-top', {}, ui.progress, ui.shuffle),
        V.h('span.bar.study-bar', {}, ui.fill),
        ui.card,
        ui.actions,
        V.h('p.hint.study-hint', { text: 'Cards come from lines like "photosynthesis :: how plants make food". Known cards come back after 1, 3, 7 and 14 days.' }),
      ],
      onClose: () => document.removeEventListener('keydown', keys),
    });
    draw();
    requestAnimationFrame(() => ui.card.focus({ preventScroll: true }));
    return sheet;
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

  V.editor.addTool({ name: 'study', label: 'Study', icon: () => icon('cards'), keepCaret: false, onClick: studySheet,
    shown: (note, text) => cards(text).length > 0 });
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

  return { cards, answer, dueCards, prune, code, makeTimer, weekMinutes, addMinutes, period, untick, resetFor, resetDue,
    resetOpen, studySheet, focusSheet, repeatSheet, minutesText, running: () => focus };
})();
