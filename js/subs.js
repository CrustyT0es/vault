/* Wefty: subscriptions (1.16, package H). The owner: "a place to keep subscriptions? like higgsfield renews this day
   and it pops up on dashboard".

   What you pay for (a name, a price in CAD or USD, how often, when it next renews, whether it's a free trial), kept
   for every device in the settings row's extra.subscriptions (changed through V.cloud.changeExtra, the
   compare-and-swap, so two devices changing different ones at once both keep theirs). Shown:
   - on Today's days (1.17, through V.today.addDayItems: js/today.js loads just before this file): each renewal on its
     own day ("Higgsfield renews", its price under it), a trial ending (amber, with Cancel here), as far as the days go;
     a tap opens it;
   - on Today's first-run screen, which has no days ("Coming up", through V.today.addSection): a renewal within its
     reminder days ("Higgsfield renews Fri"), a trial ending; nothing when nothing is soon;
   - in its own list (Today's ⋯ > Subscriptions, or "See all"): sorted by the next renewal, the monthly total per
     currency, add / edit / delete in a sheet, and "Cancel here" opening the page where it's cancelled.
   A renewal day that has passed rolls forward by whole periods when shown (`rolled`, keeping the day of the month it
   started on: a 31st is the 30th in April and the 31st again in May, a Feb 29 yearly one is Feb 28 until a leap year),
   and is written back later, quietly. A trial whose end has passed is a paid one from then on.

   Never a card number, a password or anything that looks secret (the shared clipboard's own check, js/clips.js): a
   subscription needs only its name and price. Passwords aren't kept here at all (the list's last line says where).

   Off unless switched on (1.19; the owner: "toggle off but have available, to keep things clean"): Settings > Notes &
   files > Subscriptions, for every device (extra.subscriptions_on, through changeExtra). While off nothing about them
   shows: not on Today (its days, the first-run card, the ⋯ menu), not in Settings' search (only the switch) and not in
   Chat (js/chattools.js offers no subscription tools then, and tells the model it's switched off). An account that
   already keeps some and never chose counts as on, so an update never hides anyone's list; switching off deletes
   nothing. */
'use strict';

V.subs = (() => {
  const EVERY = ['week', 'month', 'year'];
  const CURRENCIES = ['CAD', 'USD'];
  const MOST = 100;          // subscriptions kept
  const NOTE_MOST = 200;
  const NAME_MOST = 60;
  const DAY = 86400000;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const NOT_SAVED = 'That wasn\'t saved: Wefty couldn\'t reach your cloud. Check you\'re online and try again.';
  // How often, as the sheet offers it (an other stored "n" still shows as itself).
  const OFTEN = [['1 week', 'Every week'], ['1 month', 'Every month'], ['3 month', 'Every 3 months'],
    ['6 month', 'Every 6 months'], ['1 year', 'Every year']];
  const REMIND = [[0, 'On the day'], [1, '1 day before'], [3, '3 days before'], [7, '1 week before'], [14, '2 weeks before']];

  /* -- dates (plain 'YYYY-MM-DD', on this device's calendar) */

  const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const daysIn = (year, month) => new Date(year, month + 1, 0).getDate();  // (month 0-11)
  function validDate(text) {
    const m = DATE.exec(String(text || ''));
    if (!m) return false;
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    return y >= 1970 && y <= 9999 && mo >= 0 && mo < 12 && d >= 1 && d <= daysIn(y, mo);
  }
  const between = (from, to) => Math.round((V.parseDate(to) - V.parseDate(from)) / DAY);
  // `months` on from `text`, on the day `day` (1-31) or the month's last day when it's shorter.
  function addMonths(text, months, day) {
    const d = V.parseDate(text);
    const total = d.getFullYear() * 12 + d.getMonth() + months;
    const year = Math.floor(total / 12), month = total - year * 12;
    return V.dateText(new Date(year, month, Math.min(day, daysIn(year, month))));
  }
  // One period on (n of `every`) from `next`.
  const step = (sub, next, times = 1) => (sub.every === 'week' ? V.addDays(next, 7 * sub.n * times)
    : addMonths(next, (sub.every === 'year' ? 12 : 1) * sub.n * times, sub.day));

  /* -- one subscription, tidied (whatever another device or an older copy wrote) */

  function tidy(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || '').trim().slice(0, NAME_MOST);
    const next = validDate(raw.next) ? raw.next : null;
    if (!name || !next) return null;
    const every = EVERY.includes(raw.every) ? raw.every : 'month';
    const n = Math.min(24, Math.max(1, Math.round(Number(raw.n) || 1)));
    const price = Math.max(0, Math.min(100000, Math.round((Number(raw.price) || 0) * 100) / 100));
    const day = Math.round(Number(raw.day)) >= 1 && Math.round(Number(raw.day)) <= 31 ? Math.round(Number(raw.day))
      : V.parseDate(next).getDate();
    const remind = Number(raw.remind_days);
    return {
      id: String(raw.id || V.uuid()).slice(0, 64),
      name,
      price,
      currency: CURRENCIES.includes(raw.currency) ? raw.currency : 'CAD',
      every, n, next, day,
      trial: raw.trial === true,
      remind_days: Number.isFinite(remind) ? Math.min(60, Math.max(0, Math.round(remind))) : 3,
      link: safeLink(raw.link) || '',
      note: String(raw.note || '').trim().slice(0, NOTE_MOST),
      paused: raw.paused === true,
    };
  }
  const tidyAll = (list) => (Array.isArray(list) ? list.map(tidy).filter(Boolean).slice(0, MOST) : []);

  function safeLink(text) {
    const clean = String(text || '').trim();
    if (!clean || clean.length > 500) return '';
    try {
      const url = new URL(clean);
      return url.protocol === 'https:' && url.hostname ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  /* -- what's kept */

  const extraNow = () => (V.data && V.data.settings && V.data.settings.extra) || {};
  const stored = () => tidyAll(extraNow().subscriptions);

  /* -- on or off (1.19): switched on or off in Settings (`subscriptions_on`); never chosen = on only for an account that
     already keeps some (an update never hides someone's list). */
  function on() {
    const extra = extraNow();
    if (typeof extra.subscriptions_on === 'boolean') return extra.subscriptions_on;
    return stored().length > 0;
  }
  const OFF_WORDS = 'Subscriptions are switched off. Turn them on in Settings > Notes & files.';
  // (an old Chat answer's Open, or anything else that asks for them while they're off: said, with the way to the switch)
  function saysOff() {
    V.toast(OFF_WORDS, { action: 'Settings', onAction: () => V.settings.open('notes', { row: 'subscriptions' }) });
  }
  let switching = false;
  /* The switch (Settings > Notes & files): for every device. Nothing is deleted either way. Throws when the cloud
     couldn't be reached (the switch goes back and says so). */
  async function setOn(value) {
    await V.cloud.changeExtra((extra) => ({ ...extra, subscriptions_on: !!value }));
    V.emit('subs', !!value);
  }

  /* Settings > Notes & files' row (js/settings.js): the switch, with what it does in one line. */
  function settingsRow(ui) {
    const now = on();
    const count = stored().length;
    const hint = now ? 'On: renewals and free trials show on Today. The list is in Today\'s ⋯ menu.'
      : count ? `Off: your ${count === 1 ? 'one subscription is' : `${count} subscriptions are`} kept, just hidden.`
        : 'Keep track of what you pay for: Today shows a renewal a few days before, and warns you before a free trial ends.';
    const toggle = V.h('input.switch', { type: 'checkbox', checked: now, disabled: switching, 'aria-label': 'Subscriptions',
      onchange: async (event) => {
        const want = event.target.checked;
        switching = true;
        ui.draw();
        try {
          await setOn(want);
          if (want) V.toast('Subscriptions are on. Add them from Today\'s ⋯ menu.', { action: 'Open', onAction: () => open() });
        } catch (error) {
          console.warn('Wefty: subscriptions:', error);
          V.toast('That setting wasn\'t changed: Wefty couldn\'t reach your cloud. Try again in a moment.', { kind: 'err', ms: 5000 });
        } finally {
          switching = false;
          ui.draw();
        }
      } });
    return ui.line('Subscriptions', hint, toggle, 'subscriptions');
  }

  /* The subscription as it stands on `today`: a renewal day that has passed moved on by whole periods (a trial whose
     end has passed is a paid one from then). Its own day of the month is kept (`day`), so the 31st never drifts. */
  function rolled(sub, today = V.today()) {
    const one = tidy(sub);
    if (!one || one.next >= today) return one;
    // (most of the way at once, for one left alone for years: then one period at a time)
    let next = one.next;
    if (one.every === 'week') {
      const periods = Math.floor(between(next, today) / (7 * one.n));
      if (periods > 0) next = step(one, next, periods);
    } else {
      const start = V.parseDate(next), now = V.parseDate(today);
      const months = (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth();
      const periods = Math.max(0, Math.floor(months / ((one.every === 'year' ? 12 : 1) * one.n)) - 1);
      if (periods > 0) next = step(one, next, periods);
    }
    for (let guard = 0; next < today && guard < 1000; guard++) next = step(one, next);
    return { ...one, next, trial: false };
  }

  // All of them as they stand today: paused ones last, then by the next renewal, then by name.
  function list(today = V.today()) {
    return stored().map((s) => rolled(s, today)).sort((a, b) => (a.paused - b.paused) || (a.next < b.next ? -1
      : a.next > b.next ? 1 : a.name.localeCompare(b.name)));
  }

  /* What's coming up within each one's reminder days (or within `days` when given): [{ sub, days }], soonest first.
     Paused ones never. */
  function soon(days = null, today = V.today()) {
    return list(today).filter((s) => !s.paused).map((sub) => ({ sub, days: between(today, sub.next) }))
      .filter((x) => x.days >= 0 && x.days <= (days == null ? x.sub.remind_days : days))
      .sort((a, b) => a.days - b.days || a.sub.name.localeCompare(b.sub.name));
  }

  /* About how much a month, per currency ({ CAD: 21.99, USD: 29 }): a yearly price over 12 months, a weekly one 52
     weeks over 12. Paused ones and trials not ended yet (nothing paid) aren't counted; `trials` says how much those
     trials will add once they end. */
  function monthly(sub) {
    const per = sub.every === 'week' ? 52 / 12 : sub.every === 'year' ? 1 / 12 : 1;
    return (sub.price * per) / sub.n;
  }
  function totals(today = V.today()) {
    const paying = {}, trials = {};
    for (const sub of list(today)) {
      if (sub.paused) continue;
      const into = sub.trial ? trials : paying;
      into[sub.currency] = Math.round(((into[sub.currency] || 0) + monthly(sub)) * 100) / 100;
    }
    return { ...paying, trials };
  }

  /* -- words */

  const money = (amount, currency) => '$' + Number(amount || 0).toLocaleString('en-CA', { minimumFractionDigits: 2,
    maximumFractionDigits: 2 }) + ' ' + currency;
  function when(next, today = V.today()) {
    const days = between(today, next);
    const d = V.parseDate(next);
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days > 1 && days < 7) return WEEKDAYS[d.getDay()];
    return `${MONTHS[d.getMonth()]} ${d.getDate()}` + (d.getFullYear() !== V.parseDate(today).getFullYear() ? `, ${d.getFullYear()}` : '');
  }
  const oftenWords = (sub) => (sub.n === 1 ? `a ${sub.every}` : `every ${sub.n} ${sub.every}s`);
  const perWords = (sub) => (sub.n === 1 ? `/${sub.every}` : ` every ${sub.n} ${sub.every}s`);
  function line(sub, today = V.today()) {
    if (sub.paused) return 'Paused';
    const days = between(today, sub.next);
    if (sub.trial) {
      return days === 0 ? 'Trial ends today' : days === 1 ? 'Trial ends tomorrow'
        : days < 7 ? `Trial ends in ${days} days` : `Trial ends ${when(sub.next, today)}`;
    }
    return `Renews ${when(sub.next, today)}`;
  }

  /* -- what's never kept: why words can't go in (null when they can) */

  // A card number: 13 to 19 digits on their own (spaces, dots or dashes between) that pass the cards' own check (Luhn),
  // looked for outside web addresses, as the shared clipboard does (js/clips.js): an order number in a cancel link, or
  // "Order 702-1234567-1234567" in a note, isn't one.
  const CARD = /\b\d(?:[ .-]{0,2}\d){12,18}\b/g;
  const LINKS = /(?:https?:\/\/|www\.)\S+/gi;
  const CUE = /\b(?:pass ?words?|passcodes?|pwd|pin)\s*(?:is|:|=|-)\s*\S/i;
  function luhn(number) {
    const digits = number.replace(/\D/g, '').split('').map(Number).reverse();
    if (digits.length < 13 || digits.length > 19) return false;
    return digits.reduce((sum, d, i) => sum + (i % 2 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0) % 10 === 0;
  }
  /* `strict`: the note and the link get the shared clipboard's whole check (passwords, keys, codes); a name only the
     card, security code and "password is..." ones, as product names look like codes ("iCloud+50GB", "Office-365"). */
  function refused(text, strict = true) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    if ((clean.replace(LINKS, ' ').match(CARD) || []).some(luhn)) {
      return 'That looks like a card number. Wefty never keeps those: the name and the price are enough.';
    }
    if (/\b(?:cvv|cvc|security code)\b/i.test(clean)) {
      return 'That looks like a card\'s security code. Wefty never keeps those.';
    }
    // (the shared clipboard's check: passwords, keys, codes; one tidy word or a web address passes)
    const share = V.clips && V.clips.mayShare;
    const secret = CUE.test(clean) || (strict && share && !share(clean) && clean.length <= 20000);
    if (secret) return 'That looks like a password or a code. Wefty doesn\'t keep those here: a password manager is safer.';
    return null;
  }

  /* -- changes, for every device */

  // `change(list)` gives the new list, made on the cloud's newest copy (so another device's change in between stays).
  // (A change made while it was never switched either way says it's on from now: deleting the last one never makes
  // the list vanish.)
  function change(fn) {
    return V.cloud.changeExtra((extra) => ({ ...extra, subscriptions: tidyAll(fn(tidyAll(extra.subscriptions))),
      ...(typeof extra.subscriptions_on === 'boolean' ? {} : { subscriptions_on: true }) }));
  }
  // `check(all)`: looks at the cloud's newest list first and may throw (the Chat tab's add_subscription: no second one
  // of the same name, whatever this device's copy says).
  const save = (sub, check = null) => change((all) => {
    if (check) check(all);
    const one = tidy(sub);
    const at = all.findIndex((s) => s.id === one.id);
    if (at >= 0) all[at] = one; else all.push(one);
    return all;
  });
  const remove = (id) => change((all) => all.filter((s) => s.id !== id));

  /* Renewal days that have passed, written back moved on: quietly, at most once a minute, only once this device has
     read the settings from the cloud, and only for the ones still out of date on the cloud's newest copy. */
  let lastRoll = 0;
  let rolling = false;
  function rollLater() {
    const today = V.today();
    if (rolling || !on() || Date.now() - lastRoll < 60000 || !V.cloud || !V.cloud.settingsRead || !V.cloud.settingsRead()) return;
    if (!stored().some((s) => { const r = rolled(s, today); return r.next !== s.next || r.trial !== s.trial; })) return;
    rolling = true;
    lastRoll = Date.now();
    change((all) => all.map((s) => rolled(s, today))).catch((error) => console.warn('Wefty: subscriptions:', error))
      .finally(() => { rolling = false; });
  }

  /* -- Today's part: "Coming up" */

  function initial(sub) {
    return V.h('span.sub-tile', { 'aria-hidden': 'true', text: (Array.from(sub.name)[0] || '?').toUpperCase() });
  }

  function cancelButton(sub, cls = '') {
    if (!sub.link) return null;
    return V.h('button.btn.sub-cancel' + cls, { type: 'button', onclick: (event) => { event.stopPropagation(); openLink(sub.link); } },
      V.icon('open'), V.h('span', { text: 'Cancel here' }));
  }

  function openLink(href) {
    if (V.desktop && V.pc && V.pc.call) V.pc.call('openLink', { url: href }).catch(V.problem);
    else window.open(href, '_blank', 'noopener');
  }

  /* A subscription's menu (1.19.1: a right-click, a long press or the menu key, wherever it shows): Edit, Pause or
     Resume, Cancel here (its link), Delete with an Undo. Asked as it opens, from the list as it is now. */
  function subItems(id) {
    const sub = stored().find((s) => s.id === id);
    if (!sub || !on()) return [];
    const failed = () => V.toast(NOT_SAVED, { kind: 'err', ms: 5000 });
    return [
      { label: 'Edit...', icon: 'edit', onClick: () => edit(list().find((s) => s.id === id) || sub) },
      { label: sub.paused ? 'Resume' : 'Pause', icon: sub.paused ? 'play' : 'stop', onClick: () => save({ ...sub, paused: !sub.paused })
        .then(() => V.toast(sub.paused ? `${sub.name} is back on Today.` : `${sub.name} is paused: left off Today and the total.`)).catch(failed) },
      sub.link ? { label: 'Cancel it on its site', icon: 'open', onClick: () => openLink(sub.link) } : null,
      { sep: true },
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => remove(sub.id)
        .then(() => V.toast(`Deleted ${sub.name}.`, { action: 'Undo', onAction: () => save(sub).catch(failed) })).catch(failed) },
    ];
  }
  const subMenu = (el, id, name) => V.contextMenu(el, () => subItems(id), { label: `${name}: options` });

  function todayRow({ sub, days }, today) {
    const trial = sub.trial;
    const title = trial ? `${sub.name} trial ${days === 0 ? 'ends today' : days === 1 ? 'ends tomorrow' : `ends in ${days} days`}`
      : `${sub.name} renews ${when(sub.next, today)}`;
    return subMenu(V.h('div.sub-soon' + (trial ? '.trial' : ''), { dataset: { sub: sub.id } },
      initial(sub),
      V.h('button.sub-soon-text', { type: 'button', onclick: () => edit(sub) },
        V.h('strong', { text: title }),
        V.h('span', { text: trial ? 'Cancel if you don\'t want it' : `${money(sub.price, sub.currency)}${perWords(sub)}` })),
      trial ? cancelButton(sub, '.small') : V.h('span.sub-price', { text: money(sub.price, sub.currency) })), sub.id, sub.name);
  }

  function todayCard() {
    // (Today's days have every renewal on its day: this card is for the first-run screen, which has none)
    if (!on() || (V.today.showsDays && V.today.showsDays())) return null;
    const today = V.today();
    rollLater();
    const coming = soon(null, today);
    if (!coming.length) return null;
    return V.h('section.today-subs', { 'aria-label': 'Subscriptions coming up' },
      V.h('div.sub-head', {}, V.h('h2', { text: 'Coming up' }),
        V.h('button.sub-all', { type: 'button', text: 'See all', onclick: () => open() })),
      V.h('div.sub-soon-list', {}, coming.slice(0, 4).map((x) => todayRow(x, today)),
        coming.length > 4 ? V.h('button.sub-more', { type: 'button', text: `${coming.length - 4} more`, onclick: () => open() }) : null));
  }

  /* -- Today's days (1.17): each renewal from `from` to `to` on its own day (a weekly one on each), and a trial's end
     (amber, with Cancel here when there's a link). Paused ones never. A tap opens it as it is now. */
  function dayItems(from, to) {
    if (!on()) return [];
    rollLater();
    const out = [];
    for (const sub of list(from)) {
      if (sub.paused) continue;
      let one = sub;
      for (let guard = 0; one && one.next <= to && guard < 60; guard++) {
        const now = one;
        out.push({
          day: now.next, key: `${now.id}:${now.next}`, warn: now.trial, data: { sub: now.id },
          text: now.trial ? `${now.name} trial ends` : `${now.name} renews`,
          line: now.trial ? 'Cancel if you don\'t want it' : `${money(now.price, now.currency)}${perWords(now)}`,
          lead: () => initial(now),
          action: now.trial && now.link ? () => cancelButton(now, '.small') : null,
          open: () => edit(list().find((s) => s.id === now.id) || sub), openTitle: 'Change it',
          menu: () => subItems(now.id),
        });
        one = rolled({ ...now, trial: false }, V.addDays(now.next, 1));  // (the one after: paid, once a trial has ended)
      }
    }
    return out;
  }

  /* -- the list */

  let shown = null;  // { body, close } while the list shows

  function totalsLine(today) {
    const t = totals(today);
    const parts = CURRENCIES.filter((c) => t[c]).map((c) => money(t[c], c));
    const trial = CURRENCIES.filter((c) => t.trials[c]).map((c) => money(t.trials[c], c));
    return V.h('div.sub-total', {},
      V.h('span.sub-total-label', { text: 'About a month' }),
      V.h('strong', { text: parts.length ? parts.join(' + ') : money(0, 'CAD') }),
      trial.length ? V.h('span.hint', { text: `Plus ${trial.join(' + ')} once trials end` }) : null);
  }

  /* A row of the list (its sheet holds "Cancel here": a button beside the row left no room for the name on a phone). */
  function listRow(sub, today) {
    const days = between(today, sub.next);
    const warn = !sub.paused && sub.trial && days <= Math.max(3, sub.remind_days);
    return subMenu(V.h('div.sub-row' + (sub.paused ? '.paused' : '') + (warn ? '.trial' : ''), { dataset: { sub: sub.id } },
      V.h('button.sub-row-main', { type: 'button', 'aria-label': `${sub.name}: ${line(sub, today)}, ${money(sub.price, sub.currency)} ${oftenWords(sub)}. Edit`,
        onclick: () => edit(sub) },
      initial(sub),
      V.h('span.sub-row-text', {}, V.h('strong', { text: sub.name }),
        V.h('span', {}, sub.trial && !sub.paused ? V.h('span.sub-chip', { text: 'Trial' }) : null, line(sub, today))),
      V.h('span.sub-row-price', {}, V.h('strong', { text: money(sub.price, sub.currency) }),
        V.h('span', { text: perWords(sub).trim() })))), sub.id, sub.name);
  }

  function drawList() {
    if (!shown) return;
    const today = V.today();
    const all = list(today);
    V.clear(shown.body, all.length ? [
      totalsLine(today),
      V.h('div.sub-list', {}, all.map((s) => listRow(s, today))),
    ] : V.h('div.sub-empty', {},
      V.h('p', {}, V.h('strong', { text: 'Nothing here yet.' })),
      V.h('p.hint', { text: 'Add what you pay for, like Spotify or Higgsfield. Wefty shows it on Today a few days before it renews, and warns you before a free trial ends.' })),
    V.h('p.hint.sub-tip', { text: 'Wefty never keeps card numbers or passwords. For passwords, use Google Password Manager, iCloud Keychain or Bitwarden.' }));
  }

  function open() {
    if (shown) return;
    if (!on()) { saysOff(); return; }
    rollLater();
    const body = V.h('div.sub-page');
    const sheet = V.sheet({
      title: 'Subscriptions',
      content: body,
      wide: false,
      actions: [{ label: 'Add', icon: 'plus', kind: 'primary', onClick: () => { edit(null); return true; } }],
      onClose: () => { shown = null; },
    });
    sheet.el.classList.add('sub-sheet');
    shown = { body, close: sheet.close };
    drawList();
  }

  /* -- the sheet for one (null: a new one) */

  function edit(sub) {
    if (!on()) { saysOff(); return; }
    const today = V.today();
    const was = sub ? rolled(sub, today) : null;
    const lastCurrency = (() => { const all = stored(); return all.length ? all[all.length - 1].currency : 'CAD'; })();
    const input = (attrs) => V.h('input.field.sub-field', { autocomplete: 'off', ...attrs });
    const name = input({ type: 'text', value: was ? was.name : '', placeholder: 'Spotify, Higgsfield...', maxlength: String(NAME_MOST),
      autocapitalize: 'words' });
    const price = input({ type: 'text', inputmode: 'decimal', value: was ? String(was.price.toFixed(2)) : '', placeholder: '9.99' });
    const currency = V.h('select.field.sub-field.sub-currency', { 'aria-label': 'Currency' },
      CURRENCIES.map((c) => V.h('option', { value: c, text: c, selected: (was ? was.currency : lastCurrency) === c })));
    const oftenValue = was ? `${was.n} ${was.every}` : '1 month';
    const choices = OFTEN.some(([v]) => v === oftenValue) ? OFTEN : [...OFTEN, [oftenValue, `Every ${was.n} ${was.every}s`]];
    const often = V.h('select.field.sub-field', {}, choices.map(([v, label]) => V.h('option', { value: v, text: label, selected: v === oftenValue })));
    const trial = V.h('input.switch', { type: 'checkbox', checked: was ? was.trial : false });
    const next = input({ type: 'date', value: was ? was.next : V.addDays(today, 30) });
    const nextLabel = V.h('span', { text: '' });
    const sayDate = () => { nextLabel.textContent = trial.checked ? 'Free trial ends' : 'Next renewal'; };
    trial.addEventListener('change', sayDate);
    sayDate();
    const remindValue = was ? was.remind_days : 3;
    const remindChoices = REMIND.some(([v]) => v === remindValue) ? REMIND : [...REMIND, [remindValue, `${remindValue} days before`]];
    const remind = V.h('select.field.sub-field', {}, remindChoices.map(([v, label]) => V.h('option', { value: String(v), text: label, selected: v === remindValue })));
    const link = input({ type: 'url', inputmode: 'url', value: was ? was.link : '', placeholder: 'https://...', autocapitalize: 'off' });
    const note = V.h('textarea.field.sub-field', { rows: '2', maxlength: String(NOTE_MOST), placeholder: 'Optional' });
    note.value = was ? was.note : '';
    const paused = V.h('input.switch', { type: 'checkbox', checked: was ? was.paused : false });
    const problem = V.h('p.error-text', { role: 'alert' });
    const label = (text, control) => V.h('label.label', {}, typeof text === 'string' ? V.h('span', { text }) : text, control);
    const switchRow = (title, sub2, control) => V.h('label.switch-row.sub-switch', {},
      V.h('span.switch-text', {}, V.h('strong', { text: title }), V.h('span', { text: sub2 })), control);

    function read() {
      const words = { name: name.value.trim(), note: note.value.trim(), link: link.value.trim() };
      if (!words.name) return 'Give it a name.';
      for (const [text, strict] of [[words.name, false], [words.note, true], [words.link, true]]) {
        const why = refused(text, strict);
        if (why) return why;
      }
      let money2 = price.value.replace(/[$\s]|CAD|USD/gi, '');
      if (/^\d+,\d{1,2}$/.test(money2)) money2 = money2.replace(',', '.');
      money2 = money2.replace(/,/g, '');
      if (!/^\d+(?:\.\d{0,2})?$|^\.\d{1,2}$/.test(money2)) return 'Write the price as a number, like 9.99.';
      const amount = Number(money2);
      if (!(amount >= 0 && amount <= 100000)) return 'That price looks too big.';
      if (!validDate(next.value)) return `Pick the date it ${trial.checked ? 'ends' : 'renews'}.`;
      if (words.link && !safeLink(words.link)) return 'The link has to start with https://';
      const [n, every] = often.value.split(' ');
      const keepDay = was && was.next === next.value ? was.day : V.parseDate(next.value).getDate();
      return { ...(was || {}), id: was ? was.id : V.uuid(), name: words.name, price: amount, currency: currency.value,
        every, n: Number(n), next: next.value, day: keepDay, trial: trial.checked, remind_days: Number(remind.value),
        link: safeLink(words.link) || '', note: words.note.slice(0, NOTE_MOST), paused: paused.checked };
    }

    const actions = [];
    if (was) {
      actions.push({ label: 'Delete', kind: 'danger-quiet', onClick: async (close) => {
        if (!await V.confirm(`Delete ${was.name}?`, 'It goes from the list on every device.', { ok: 'Delete', danger: true })) return true;
        try {
          await remove(was.id);
          close();
          V.toast(`Deleted ${was.name}.`, { action: 'Undo', onAction: () => save(was).catch(() => V.toast(NOT_SAVED, { kind: 'err', ms: 5000 })) });
        } catch (error) {
          console.warn('Wefty:', error);
          problem.textContent = NOT_SAVED;
        }
        return true;
      } });
    }
    actions.push({ label: 'Cancel' });
    actions.push({ label: 'Save', kind: 'primary', onClick: async (close) => {
      problem.textContent = '';
      const made = read();
      if (typeof made === 'string') { problem.textContent = made; return true; }
      if (!was && stored().length >= MOST) { problem.textContent = `Wefty keeps up to ${MOST} subscriptions.`; return true; }
      try {
        await save(made);
        close();
        V.toast(was ? 'Saved.' : `${made.name} added. It shows on Today ${made.remind_days ? 'a few days before' : 'on the day'} it ${made.trial ? 'ends' : 'renews'}.`);
      } catch (error) {
        console.warn('Wefty:', error);
        problem.textContent = NOT_SAVED;
      }
      return true;
    } });

    const sheet = V.sheet({
      title: was ? was.name : 'New subscription',
      content: [
        label('Name', name),
        V.h('div.sub-pair', {}, label('Price', price), label('Currency', currency)),
        label('How often', often),
        switchRow('It\'s a free trial', 'Wefty warns you before it ends', trial),
        label(nextLabel, next),
        label('Remind me', remind),
        label('Where to cancel (optional)', link),
        was && was.link ? cancelButton(was) : null,
        label('Note', note),
        was ? switchRow('Paused', 'Not paying for now: left off Today and the total', paused) : null,
        problem,
      ],
      actions,
    });
    sheet.el.classList.add('sub-edit');
  }

  /* -- on Today */

  V.on('data', (table) => {
    if (table !== 'settings') return;
    if (shown && !on()) shown.close();  // (switched off on another device)
    else drawList();
  });
  V.on('signing-out', () => { if (shown) shown.close(); });
  if (V.today && V.today.addSection) {  // (ORDER.subs: Today's own slot for it, after the flash cards)
    V.today.addSection({ id: 'subs', order: (V.today.ORDER && V.today.ORDER.subs) || 45, column: 'right', build: todayCard });
    if (V.today.addDayItems) V.today.addDayItems({ id: 'subs', items: dayItems });
    V.today.addMenuItem({ id: 'subs', label: 'Subscriptions', icon: 'restore', onClick: () => open(), shown: on });
  }

  // (save/remove/stored/validDate/MOST: the Chat tab's tools, js/chattools.js, go through the same path and checks)
  return { open, edit, subItems, list, soon, totals, rolled, refused, tidy, todayCard, dayItems, money, line, monthly, save, remove,
    stored, validDate, safeLink, when, perWords, on, setOn, settingsRow, OFF_WORDS, MOST, NAME_MOST, NOTE_MOST, CURRENCIES, EVERY };
})();
