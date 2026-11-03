/* Wefty 1.19: a gentle study streak. The owner: friends must get past day one and come back, and "really sell this
   notes magic thing": a small flame on Today ("🔥 6 days") and at the end of a study go, never a nag.

   A day counts when you studied on any of your devices: went over flash cards (the study screen's answers, Learn's
   too), had AI make flash cards, or recorded with the note-taker. One missed day a week (Monday to Sunday) is a free
   rest day, so a busy Tuesday never ends it; a second missed day in the same week does. Today never breaks it: it's
   still open. Switched off (Settings > Appearance > Studying, for every device) it shows nowhere, and the week's
   story card (js/week.js) leaves it out.

   What's kept is as small as it can be, in the settings row's extra.streak (changed through V.cloud.changeExtra, the
   compare-and-swap, so two devices writing at once both keep theirs):
     { off?: true,
       log: { '2026-11-02': { '<device>': [seconds studying, cards answered, AI cards made, seconds recorded,
                                           [tests studied for]?] } },   the last LOG_DAYS days in detail
       days: [['2026-08-30', '2026-09-14'], ...] }                        older study days, as runs of days
   Each device writes only its own line for a day, and only ever a bigger one (its own counts only grow within a
   day), so putting two copies together is "the larger of each number" (`merged`): never a lost or doubled count,
   whichever order the writes land in, however often one is sent again. Days are this device's calendar days
   ('YYYY-MM-DD', the local wall clock: DST-safe, V.addDays). A device id is the first letters of its own
   'vault-install' id (js/access.js). Tests are named by the first letters of their note's id, for the check-in after
   one (js/checkin.js: "You studied 31 cards over 4 days").

   Answers are counted here at once (localStorage 'vault-streak', per person, gone when they sign out: Today's flame is
   right even offline) and sent a few seconds later, when Wefty goes to the background, and again when the cloud is
   back. Nothing about what was studied goes anywhere: no words, no card, no note title. */
'use strict';

V.streak = (() => {
  const KEY = 'vault-streak';
  const LOG_DAYS = 35;      // days kept in detail (the week story and a test's check-in look back this far)
  const KEEP_DAYS = 400;    // study days kept at all (a streak longer than this shows as this long)
  const IDLE = 90 * 1000;   // a longer pause between two answers isn't counted as studying
  const FIRST = 15 * 1000;  // the first card of a go, before there's a pause to measure: about this long
  const MOST = [86400, 100000, 10000, 86400];  // a day's seconds, cards, AI cards, seconds recorded
  const MOST_DEVICES = 12;
  const MOST_TESTS = 6;
  const SEND_AFTER = 4000;
  const TRY_AGAIN = 60 * 1000;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const NOT_CHANGED = 'That wasn\'t changed: Wefty couldn\'t reach your cloud. Check you\'re online and try again.';

  const isDay = (value) => typeof value === 'string' && DAY.test(value);
  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const count = (value, most) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? Math.min(n, most) : 0;
  };
  /* The Monday of a day's week ('YYYY-MM-DD'). */
  const mondayOf = (day) => V.addDays(day, -((V.parseDate(day).getDay() + 6) % 7));
  /* A note's id as the log names it (a test the cards were studied for). */
  const testId = (id) => String(id || '').replace(/[^0-9a-z]/gi, '').slice(0, 10).toLowerCase();

  /* -- the kept record, tidied (whatever an older copy or another device wrote) */

  function tidyRecord(raw) {
    if (!Array.isArray(raw)) return null;
    const rec = MOST.map((most, i) => count(raw[i], most));
    const tests = Array.isArray(raw[4])
      ? [...new Set(raw[4].filter((t) => typeof t === 'string' && /^[0-9a-z]{1,12}$/.test(t)))].slice(0, MOST_TESTS) : [];
    if (tests.length) rec.push(tests);
    return rec;
  }
  const studiedIn = (rec) => !!rec && (rec[0] > 0 || rec[1] > 0 || rec[2] > 0 || rec[3] > 0);
  /* The larger of each number, the tests of both. */
  function larger(a, b) {
    if (!a) return b ? tidyRecord(b) : null;
    if (!b) return tidyRecord(a);
    return tidyRecord([...MOST.map((_, i) => Math.max(a[i] || 0, b[i] || 0)), [...(a[4] || []), ...(b[4] || [])]]);
  }

  function tidy(raw) {
    const r = isObject(raw) ? raw : {};
    const days = [];
    for (const run of Array.isArray(r.days) ? r.days.slice(0, 500) : []) {
      if (Array.isArray(run) && isDay(run[0]) && isDay(run[1]) && run[0] <= run[1]) days.push([run[0], run[1]]);
    }
    const log = {};
    for (const [day, devices] of Object.entries(isObject(r.log) ? r.log : {})) {
      if (!isDay(day) || !isObject(devices)) continue;
      const one = {};
      for (const [device, rec] of Object.entries(devices).slice(0, MOST_DEVICES)) {
        if (!/^[0-9a-z]{1,16}$/i.test(device)) continue;
        const clean = tidyRecord(rec);
        if (studiedIn(clean)) one[device] = clean;
      }
      if (Object.keys(one).length) log[day] = one;
    }
    return { off: r.off === true, days, log };
  }

  /* Runs of days as days (from `from` on: older ones are let go), and back. */
  function daysOf(runs, from) {
    const out = new Set();
    for (const [first, last] of runs) {
      let day = first < from ? from : first;
      for (let guard = 0; day <= last && guard <= KEEP_DAYS + 1; guard++) { out.add(day); day = V.addDays(day, 1); }
    }
    return out;
  }
  function runsOf(days) {
    const out = [];
    for (const day of [...days].sort()) {
      const last = out[out.length - 1];
      if (last && V.addDays(last[1], 1) === day) last[1] = day; else out.push([day, day]);
    }
    return out;
  }

  /* Two copies as one (the cloud's and what this device sends): each device's line for a day the larger of the two,
     days older than LOG_DAYS kept only as study days, and those older than KEEP_DAYS let go. `off` is the first
     copy's (the cloud's): only setOff changes it. Run again on a newer copy, it gives the same: safe for
     changeExtra's tries again. */
  function merged(base, add, today = V.today()) {
    const a = tidy(base);
    const b = tidy(add);
    const cut = V.addDays(today, -LOG_DAYS);
    const keepFrom = V.addDays(today, -KEEP_DAYS);
    const old = new Set([...daysOf(a.days, keepFrom), ...daysOf(b.days, keepFrom)]);
    const log = {};
    for (const source of [a.log, b.log]) {
      for (const [day, devices] of Object.entries(source)) {
        if (day < cut) { if (day >= keepFrom) old.add(day); continue; }
        const into = log[day] || (log[day] = {});
        for (const [device, rec] of Object.entries(devices)) into[device] = larger(into[device], rec);
      }
    }
    for (const day of Object.keys(log)) old.delete(day);  // (in detail already)
    const out = { days: runsOf(old), log };
    if (a.off) out.off = true;
    return out;
  }

  /* -- this device's own lines (sent or not yet) */

  let memory = null;  // (where localStorage can't be used: a private window)
  let ownId = '';
  function device() {
    if (ownId) return ownId;
    const install = V.deviceLog && V.deviceLog.installId ? V.deviceLog.installId() : '';
    ownId = install ? testId(install) : 'p' + V.uuid().replace(/-/g, '').slice(0, 9);
    return ownId;
  }
  const user = () => (V.data.user && V.data.user.id) || '';

  function load() {
    const who = user();
    let raw = memory;
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null') || memory; } catch (error) { /* memory */ }
    if (!raw || raw.user !== who || !isObject(raw.log)) return { user: who, log: {}, sent: {} };
    const log = {};
    for (const [day, rec] of Object.entries(raw.log)) {
      const clean = isDay(day) ? tidyRecord(rec) : null;
      if (studiedIn(clean)) log[day] = clean;
    }
    return { user: who, log, sent: isObject(raw.sent) ? raw.sent : {} };
  }
  function store(state) {
    memory = state;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (error) { /* kept in memory for this visit */ }
  }

  /* The cloud's copy, as this device last read it. */
  const kept = () => tidy(((V.data.settings || {}).extra || {}).streak);
  const on = () => !kept().off;

  /* Every day studied, on any device (this one's not sent yet too). */
  function studiedDays(today = V.today()) {
    const s = kept();
    const days = daysOf(s.days, V.addDays(today, -KEEP_DAYS));
    for (const [day, devices] of Object.entries(s.log)) if (Object.values(devices).some(studiedIn)) days.add(day);
    for (const [day, rec] of Object.entries(load().log)) if (studiedIn(rec)) days.add(day);
    return days;
  }

  /* Each day's lines in [from, to], every device's (this device's own as the larger of what's here and what the cloud
     has): { day: [rec, ...] }. */
  function linesIn(from, to) {
    const s = kept();
    const mine = load().log;
    const me = device();
    const out = {};
    for (const [day, devices] of Object.entries(s.log)) {
      if (day < from || day > to) continue;
      out[day] = Object.entries(devices).map(([who, rec]) => (who === me ? larger(rec, mine[day]) : rec));
    }
    for (const [day, rec] of Object.entries(mine)) {
      if (day >= from && day <= to && !(s.log[day] && s.log[day][me])) (out[day] || (out[day] = [])).push(rec);
    }
    return out;
  }

  /* -- the streak */

  /* The streak on `asOf` from a set of study days: { count (days studied in it), today (studied on asOf), rests (the
     days rested in it, newest first), started (its first day) }. asOf itself never breaks it (it's still going);
     each week (Monday to Sunday) may miss one day, a second miss ends it. */
  function run(days, asOf = V.today()) {
    const studiedToday = days.has(asOf);
    let earliest = '';
    for (const day of days) if (day <= asOf && (!earliest || day < earliest)) earliest = day;
    let day = studiedToday ? asOf : V.addDays(asOf, -1);
    let total = 0;
    let started = '';
    const rested = [];
    const weeks = new Set();
    for (let guard = 0; earliest && day >= earliest && guard <= KEEP_DAYS + 7; guard++) {
      if (days.has(day)) { total++; started = day; } else {
        const week = mondayOf(day);
        if (weeks.has(week)) break;
        weeks.add(week);
        rested.push(day);
      }
      day = V.addDays(day, -1);
    }
    return { count: total, today: studiedToday, rests: started ? rested.filter((d) => d > started) : [], started };
  }
  const now = (asOf = V.today()) => run(studiedDays(asOf), asOf);

  /* -- counting what was studied */

  let lastAt = 0;
  let grew = '';  // the day the streak grew here (this page's first study that day): the end of the go says so once

  /* One line more for today: `s` seconds, `c` cards, `a` AI cards, `r` seconds recorded, `t` tests studied for. */
  function add({ s = 0, c = 0, a = 0, r = 0, t = [] } = {}) {
    const day = V.today();
    const before = studiedDays(day).has(day);
    const state = load();
    const cloudOwn = (kept().log[day] || {})[device()] || null;
    const rec = larger(state.log[day] || [0, 0, 0, 0], cloudOwn) || [0, 0, 0, 0];
    const next = tidyRecord([rec[0] + s, rec[1] + c, rec[2] + a, rec[3] + r, [...(rec[4] || []), ...t]]);
    if (!studiedIn(next)) return;
    state.log[day] = next;
    store(state);
    // (Today's chip changes only when today first counts: never a redraw under the study screen for each card)
    if (!before) { grew = day; V.emit('streak'); }
    sendSoon();
  }

  /* The tests coming up whose cards include this one. (Their plans are looked up once a minute at most: each answer
     changes the cards' state, and working every plan out again after every tap would slow a phone down.) */
  let plansAt = { when: 0, day: '', plans: [] };
  function testsFor(card) {
    if (!card || !V.review) return [];
    try {
      const at = Date.now();
      const day = V.today();
      if (!plansAt.when || at - plansAt.when > 60000 || plansAt.day !== day) plansAt = { when: at, day, plans: V.review.now().plans };
      return plansAt.plans.filter((p) => p.covers(card)).map((p) => testId(p.note.id));
    } catch (error) {
      return [];
    }
  }

  /* A card answered on the study screen (js/review.js, js/learn.js). `graded`: false for Next (passed over: the day
     counts, the card doesn't). The time since the answer before (up to IDLE) is time spent studying. */
  function studied(card = null, { graded = true } = {}) {
    try {
      const at = Date.now();
      const gap = lastAt && at - lastAt < IDLE ? at - lastAt : FIRST;
      lastAt = at;
      add({ s: gap / 1000, c: graded ? 1 : 0, t: testsFor(card) });
    } catch (error) {
      console.error('Wefty: the streak:', error);
    }
  }
  /* AI made `n` flash cards (js/aicards.js). */
  function made(n) {
    try { if (n > 0) add({ a: n }); } catch (error) { console.error('Wefty: the streak:', error); }
  }
  /* The note-taker recorded `seconds` and heard something (js/notetaker.js). */
  function recorded(seconds) {
    try { if (seconds > 0) add({ r: seconds }); } catch (error) { console.error('Wefty: the streak:', error); }
  }

  /* -- sending */

  let sending = null;
  let again = null;
  const sendSoon = V.debounce(() => { send(); }, SEND_AFTER);

  /* This device's lines that the cloud doesn't have yet, merged into its copy (one changeExtra). A failure (offline,
     the cloud asleep) waits: tried again in a minute, when Wefty comes back, or the cloud does. */
  async function send() {
    if (sending) return sending;
    const state = load();
    const me = device();
    const lines = {};
    for (const [day, rec] of Object.entries(state.log)) if (JSON.stringify(rec) !== state.sent[day]) lines[day] = { [me]: rec };
    if (!Object.keys(lines).length || !V.cloud || !V.cloud.sb || !user()) return null;
    clearTimeout(again);
    sending = (async () => {
      try {
        await V.cloud.changeExtra((extra) => ({ ...extra, streak: merged(extra.streak, { log: lines }) }));
        const after = load();
        for (const [day, devices] of Object.entries(lines)) after.sent[day] = JSON.stringify(devices[me]);
        // (what the cloud has and is older than the log's days isn't kept here any more)
        const cut = V.addDays(V.today(), -LOG_DAYS);
        for (const day of Object.keys(after.log)) {
          if (day < cut && after.sent[day] === JSON.stringify(after.log[day])) { delete after.log[day]; delete after.sent[day]; }
        }
        for (const day of Object.keys(after.sent)) if (!after.log[day]) delete after.sent[day];
        store(after);
        if (waiting()) sendSoon();  // (answers given while it was on its way)
        return true;
      } catch (error) {
        again = setTimeout(() => { send(); }, TRY_AGAIN);
        return false;
      } finally {
        sending = null;
      }
    })();
    return sending;
  }
  const waiting = () => {
    const state = load();
    return Object.entries(state.log).some(([day, rec]) => JSON.stringify(rec) !== state.sent[day]);
  };
  V.on('away', () => { if (waiting()) send(); });
  V.on('back', () => { if (waiting()) send(); });
  // (the first sync this page life: what other devices did is known from then on, js/week.js and js/checkin.js wait)
  let syncedOnce = false;
  const synced = () => syncedOnce;
  V.on('status', (value) => {
    if (value === 'synced' || value === 'held') syncedOnce = true;
    if (value === 'synced' && waiting()) sendSoon();
  });
  window.addEventListener('online', () => { if (waiting()) sendSoon(); });
  // (someone else may sign in here next: this person's own days never stay behind for them. A sign-in that only
  // ran out keeps them: they're this person's, and go up once they're signed in again.)
  V.on('signing-out', () => { memory = null; try { localStorage.removeItem(KEY); } catch (error) { /* nothing kept */ } });
  V.on('data', (table) => { if (table === 'settings') V.emit('streak'); });

  /* -- switching it off and on (Settings > Appearance > Studying), for every device */

  let busy = false;
  async function setOff(off) {
    await V.cloud.changeExtra((extra) => {
      const next = merged(extra.streak, {});
      if (off) next.off = true; else delete next.off;
      return { ...extra, streak: next };
    });
    V.emit('streak');
  }
  async function change(off) {
    if (busy) return;
    busy = true;
    if (V.settings) V.settings.draw();
    try {
      await setOff(off);
      V.toast(off ? 'The streak is hidden on every device.' : 'The streak is back on Today.');
    } catch (error) {
      console.warn('Wefty:', error);
      V.toast(NOT_CHANGED, { kind: 'err', ms: 5000 });
    } finally {
      busy = false;
      if (V.settings) V.settings.draw();
    }
  }

  function settingsCard(ui) {
    const toggle = V.h('input.switch', { type: 'checkbox', checked: on(), disabled: busy, 'aria-label': 'Study streak',
      onchange: (event) => change(!event.target.checked) });
    return ui.card('Studying', ui.line('Study streak', 'Days in a row you studied, on Today and after studying. One '
      + 'rest day a week keeps it going. On every device you use.', toggle, 'study-streak'));
  }

  /* -- what shows */

  const fire = () => V.h('span.streak-fire', { text: '🔥', 'aria-hidden': 'true' });

  /* Today's chip ("🔥 6 days"), or null (off, or no streak going). A tap shows how it works. */
  function chip() {
    try {
      if (!on()) return null;
      const s = now();
      if (!s.count) return null;
      return V.h('button.streak-chip', { type: 'button', dataset: { key: 'streak' }, title: 'Your study streak',
        'aria-label': `Study streak: ${plural(s.count, 'day')} in a row`, onclick: () => sheet() },
      fire(), V.h('span', { text: plural(s.count, 'day') }));
    } catch (error) {
      console.error('Wefty: the streak:', error);
      return null;
    }
  }

  /* At the end of a go on the study screen (and Learn's): "🔥 6 days in a row", and on the go that made today count,
     a small moment ("Day 6! That's 6 days in a row."), once. Null when it's off. */
  function endLine() {
    try {
      if (!on()) return null;
      const s = now();
      if (!s.count) return null;
      const fresh = grew === V.today() && s.today;
      grew = '';
      const text = s.count === 1 ? (fresh ? 'Day 1: your streak starts today.' : 'Day 1 of your streak.')
        : fresh ? `Day ${s.count}! That's ${s.count} days in a row.` : `${s.count} days in a row`;
      return V.h('p.study-streak' + (fresh ? '.fresh' : ''), {}, fire(), V.h('span', { text }));
    } catch (error) {
      console.error('Wefty: the streak:', error);
      return null;
    }
  }

  /* The chip's sheet: the streak, the last seven days (studied, rested, today) and how it works. */
  function sheet() {
    const today = V.today();
    const s = now(today);
    const days = studiedDays(today);
    const monday = mondayOf(today);
    const cells = [];
    for (let i = 6; i >= 0; i--) {
      const day = V.addDays(today, -i);
      const name = WEEKDAYS[V.parseDate(day).getDay()];
      const state = days.has(day) ? 'done' : s.rests.includes(day) ? 'rest' : day === today ? 'today' : 'missed';
      const said = { done: 'studied', rest: 'rest day', today: 'today, not yet', missed: 'not studied' }[state];
      cells.push(V.h('li.streak-day', { dataset: { state, day } },
        V.h('span.streak-dot', { 'aria-hidden': 'true' }, state === 'done' ? '🔥' : state === 'rest' ? '☾' : ''),
        V.h('span.streak-name', { text: name.slice(0, 1), 'aria-hidden': 'true' }),
        V.h('span.sr-only', { text: `${name}: ${said}` })));
    }
    const rest = s.rests.find((d) => d >= monday);
    V.sheet({
      title: 'Study streak',
      content: [
        V.h('p.streak-big', {}, fire(), V.h('span', { text: s.count ? `${plural(s.count, 'day')} in a row` : 'No streak yet' })),
        V.h('ul.streak-week', { 'aria-label': 'The last seven days' }, cells),
        V.h('p.hint', { text: 'A day counts when you study flash cards, use Learn, make cards with AI or record a class, on any of your devices.' }),
        V.h('p.hint', { text: rest ? `Missed a day? One rest day a week keeps it going. This week's was ${WEEKDAYS[V.parseDate(rest).getDay()]}.`
          : 'Missed a day? One rest day a week keeps it going.' }),
      ],
      actions: [
        { label: 'Hide it', kind: 'quiet', onClick: () => { change(true); } },
        V.week ? { label: 'Your week', kind: 'primary', icon: 'spark', onClick: () => { V.week.open(); } } : { label: 'Got it', kind: 'primary' },
      ],
    });
  }

  /* -- for the week's story (js/week.js) and a test's check-in (js/checkin.js) */

  /* What was studied in [from, to]: { seconds, cards, made, recorded, days (days studied) }. */
  function totals(from, to) {
    const out = { seconds: 0, cards: 0, made: 0, recorded: 0, days: 0 };
    const days = new Set();
    for (const [day, recs] of Object.entries(linesIn(from, to))) {
      if (recs.some(studiedIn)) days.add(day);
      for (const rec of recs) {
        out.seconds += rec[0] || 0;
        out.cards += rec[1] || 0;
        out.made += rec[2] || 0;
        out.recorded += rec[3] || 0;
      }
    }
    // (older days are only kept as days studied)
    for (const day of daysOf(kept().days, from)) if (day <= to) days.add(day);
    out.days = days.size;
    return out;
  }
  /* The days in [from, to] when cards a test covers were studied. */
  function daysFor(noteId, from, to) {
    const id = testId(noteId);
    const out = new Set();
    for (const [day, recs] of Object.entries(linesIn(from, to))) if (recs.some((r) => (r[4] || []).includes(id))) out.add(day);
    return out;
  }

  return { on, now, run, chip, endLine, sheet, settingsCard, studied, made, recorded, send, totals, daysFor, merged, tidy,
    mondayOf, testId, setOff, studiedDays, synced, LOG_DAYS, waiting };
})();
