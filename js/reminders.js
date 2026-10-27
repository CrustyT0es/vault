/* Vault: dates and reminders typed in plain words. "test fri 9am", "tomorrow 5pm", "due monday", "on the 3rd at 7",
   "next week", "in 2 hours" or "dec 5" in a note's title or first line is understood (on this device's clock, in its
   time zone), and once the typing stops a small question shows just above the tools (above the phone's keyboard; it
   never takes the caret): remind me on my phone, just a due date, or no (and "don't ask in this note").

   Kept in the note: `due` (the day), extra.remind_at (when, as an ISO time) and extra.remind_asked (the date and time
   last asked about, or 'never'). The words stay as they were typed, so Jarvis reads them as they are.

   A reminder reaches the phone through its calendar: a Google Calendar event filled in from a link (the phone's
   Calendar app, and Samsung Calendar, show Google's events), or an .ics file with an alarm 10 minutes before. While
   Vault is open (or was a few hours ago) it reminds too: a notification when that was allowed, and a toast. The Notes
   tab's Upcoming list shows the week by day; a bell chip on a note (and on its card) says when, and changes it. */
'use strict';

V.reminders = (() => {
  const DAY = 86400000;
  const DEFAULT_TIME = [9, 0];       // a reminder for a day with no time rings at 9:00 AM
  const ASK_AFTER = 1200;            // ms after the typing in the title or first line stops
  const MISSED_HOURS = 6;            // a reminder this late is still said when Vault opens
  const SEEN = 'vault-reminded';     // localStorage: the reminders this device has already said
  const NOTIFY_ASKED = 'vault-notify-asked';

  /* -- a few line icons (the same 24 grid as util.js's; fixed strings only) */

  const DRAWN = {
    bell: '<path d="M6 10a6 6 0 0 1 12 0c0 4.4 1.5 6.1 2.5 7h-17c1-.9 2.5-2.6 2.5-7z"/><path d="M10 20.2a2.3 2.3 0 0 0 4 0"/>',
    cards: '<rect x="3.5" y="7" width="13" height="13.5" rx="2.5"/><path d="M7.5 7v-.5A2.5 2.5 0 0 1 10 4h8a2.5 2.5 0 0 1 2.5 2.5V16a2.5 2.5 0 0 1-2.5 2.5h-1.5"/>',
    timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v3.5l2.5 1.5M9.5 2.5h5M18.5 6.5l1.5-1.5"/>',
    repeat: '<path d="M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H19M16 3.5l3 3-3 3"/><path d="M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H5M8 20.5l-3-3 3-3"/>',
    shuffle: '<path d="M3.5 7h3a4 4 0 0 1 3.3 1.8l4.4 6.4a4 4 0 0 0 3.3 1.8h3M17.5 14l3 3-3 3"/><path d="M3.5 17h3a4 4 0 0 0 2.4-.8M15.1 7.8A4 4 0 0 1 17.5 7h3M17.5 4l3 3-3 3"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    flip: '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18.5 3v4h-4M5.5 21v-4h4"/>',
  };
  function icon(name, cls) {
    if (!Object.prototype.hasOwnProperty.call(DRAWN, name)) return V.icon(name, cls);  // one of util.js's
    const span = V.icon('', cls);
    span.firstChild.innerHTML = DRAWN[name] || '';
    return span;
  }

  /* -- reading dates and times */

  const pad = (n) => String(n).padStart(2, '0');
  const dayText = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const plusDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const fromDay = (text) => { const [y, m, d] = String(text).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const daysBetween = (a, b) => Math.round((midnight(b) - midnight(a)) / DAY);

  const DAY_WORDS = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, weds: 3, wed: 3,
    thursday: 4, thurs: 4, thur: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
  const RISKY = new Set(['sun', 'sat', 'wed', 'mon']);  // English words too: only after "on", "due"... or before a time
  const MONTH_WORDS = { january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5,
    jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sept: 8, sep: 8, october: 9, oct: 9, november: 10, nov: 10,
    december: 11, dec: 11 };
  const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45 };
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const words = (object) => Object.keys(object).sort((a, b) => b.length - a.length).join('|');
  const COUNT = `(\\d{1,3}|${words(NUMBER_WORDS)})`;
  const AMPM = '(am|pm|a\\.m\\.?|p\\.m\\.?)(?![a-z])';
  // A time just after a word ("sat 9am", "sun at 3"): it makes the word a day.
  const TIME_AHEAD = new RegExp(`^\\s*(?:at\\s+\\d{1,2}|@\\s*\\d{1,2}|\\d{1,2}(?::\\d{2})?\\s*${AMPM}|\\d{1,2}:\\d{2}|noon|midnight|morning|afternoon|evening|night)`);

  /* The words with the matched part blanked out (so its numbers aren't read again as a time). */
  const blank = (text, found) => text.slice(0, found.index) + ' '.repeat(found[0].length) + text.slice(found.index + found[0].length);

  /* A bare hour ("at 7"): 1 to 7 is the afternoon or evening, 8 to 11 the morning ("tonight at 8" is 8 PM). */
  const guessHour = (hour, evening) => (hour === 12 ? 12 : evening || hour <= 7 ? hour + 12 : hour);

  /* When `text` says, or null. Returns { date: 'YYYY-MM-DD', time: 'HH:MM' or null, at (a Date: the time, or 9:00 AM
     when no time was said), past (that moment has gone), key, words (what said it) }. Dates without a year that have
     been this year are next year's (the last three months' stay in the past); "the 3rd" that has been this month is next month's; a weekday is always the next
     one (today only with a time still to come); a time alone is today's, or tomorrow's once it has gone. */
  function parse(text, now = new Date()) {
    let s = ' ' + String(text || '').toLowerCase().replace(/[’‘]/g, '\'')
      .replace(/https?:\/\/\S+|\bwww\.\S+|\S+@\S+\.\S+/g, (link) => ' '.repeat(link.length)) + ' ';
    const today = midnight(now);
    const said = [];
    let date = null;
    let time = null;          // [hours, minutes]
    let evening = false;
    let weekday = null;       // { day, next }: worked out once the time is known
    let m;

    // "in 2 hours", "in half an hour", "in 3 days", "in a week"
    m = new RegExp(`\\bin\\s+(?:(half\\s+an?\\s+hour)|${COUNT}\\s+(minutes?|mins?|hours?|hrs?|days?|weeks?|wks?)\\b)`).exec(s);
    if (m) {
      const n = m[1] ? 30 : NUMBER_WORDS[m[2]] || Number(m[2]);
      const unit = m[1] ? 'min' : m[3];
      if (n > 0 && /^(min|h)/.test(unit)) {
        const at = new Date(now.getTime() + n * (unit[0] === 'h' ? 60 : 1) * 60000);
        return result(midnight(at), [at.getHours(), at.getMinutes()], now, [m[0]]);
      }
      if (n > 0) { date = plusDays(today, /^w/.test(unit) ? 7 * n : n); said.push(m[0]); s = blank(s, m); }
    }

    if (!date && (m = /\b(today|tonight|tonite|tomorrow|tmrw|tmrrw|tmr|tomorow|tommorow|tommorrow)\b/.exec(s))) {
      date = /^to(day|night|nite)$/.test(m[1]) ? today : plusDays(today, 1);
      evening = /night|nite/.test(m[1]);
      said.push(m[0]);
      s = blank(s, m);
    }

    if (!date && (m = /\b(this\s+|next\s+)?weekend\b/.exec(s))) {
      const saturday = plusDays(today, (6 - today.getDay() + 7) % 7);
      date = m[1] && m[1].trim() === 'next' && saturday - today < 7 * DAY ? plusDays(saturday, 7) : saturday;
      said.push(m[0]);
      s = blank(s, m);
    }

    if (!date) {
      const re = new RegExp(`\\b(?:(due|on|by|this|next|until|till|before|for)\\s+)?(${words(DAY_WORDS)})\\b\\.?`, 'g');
      while ((m = re.exec(s))) {
        const lead = m[1] || '';
        const after = s.slice(m.index + m[0].length);
        if (RISKY.has(m[2]) && !lead && !TIME_AHEAD.test(after)) continue;
        weekday = { day: DAY_WORDS[m[2]], next: lead === 'next' || /^\s*next\s+week\b/.test(after) };
        said.push(m[0]);
        s = blank(s, m);
        break;
      }
    }

    if (!date && !weekday && (m = /\bnext\s+week\b/.exec(s))) {
      date = plusDays(today, 7 - ((today.getDay() + 6) % 7));  // next week's Monday
      said.push(m[0]);
      s = blank(s, m);
    }

    if (!date && !weekday) {
      const months = words(MONTH_WORDS);
      let day = 0;
      let month = -1;
      let year = 0;
      if ((m = new RegExp(`\\b(${months})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`).exec(s))) {
        [month, day, year] = [MONTH_WORDS[m[1]], Number(m[2]), Number(m[3] || 0)];
      } else if ((m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${months})\\b\\.?(?:,?\\s+(\\d{4}))?`).exec(s))) {
        [month, day, year] = [MONTH_WORDS[m[2]], Number(m[1]), Number(m[3] || 0)];
      } else if ((m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s))) {
        [month, day, year] = [Number(m[2]) - 1, Number(m[3]), Number(m[1])];
      }
      if (m && month >= 0) {
        let made = new Date(year || today.getFullYear(), month, day);
        // Gone this year: next year's, unless it was in the last three months ("notes from oct 5" is the past).
        if (!year && made < today && made < new Date(today.getFullYear(), today.getMonth() - 3, today.getDate())) {
          made = new Date(today.getFullYear() + 1, month, day);
        }
        if (made.getMonth() === month && made.getDate() === day) {
          date = made;
          said.push(m[0]);
          s = blank(s, m);
        }
      } else if ((m = /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/.exec(s))) {
        const wanted = Number(m[1]);
        let made = new Date(today.getFullYear(), today.getMonth(), wanted);
        if (wanted < today.getDate()) made = new Date(today.getFullYear(), today.getMonth() + 1, wanted);
        if (wanted >= 1 && made.getDate() === wanted) {
          date = made;
          said.push(m[0]);
          s = blank(s, m);
        }
      }
    }

    // The time: "9am", "5:30 pm", "at 7", "19:00", "noon", "midnight", "tomorrow morning".
    let strong = false;  // a time that means a time even with no day said
    if ((m = new RegExp(`\\b(?:at\\s+|@\\s*)?(\\d{1,2})(?::([0-5]\\d))?\\s*${AMPM}`).exec(s)) && Number(m[1]) >= 1 && Number(m[1]) <= 12) {
      const pm = m[3][0] === 'p';
      time = [(Number(m[1]) % 12) + (pm ? 12 : 0), Number(m[2] || 0)];
      strong = true;
    } else if ((m = /\b(?:(at|@)\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/.exec(s))) {
      const hour = Number(m[2]);
      time = [hour > 12 || /^0/.test(m[2]) ? hour : guessHour(hour, evening), Number(m[3])];
      strong = !!m[1] || hour > 12;
    } else if ((m = /\b(noon|midday|midnight)\b/.exec(s))) {
      time = m[1] === 'midnight' ? [23, 59] : [12, 0];
      strong = true;
    } else if ((m = /(?:\bat\s+|@\s*)(\d{1,2})\b(?!\s*(?:%|st\b|nd\b|rd\b|th\b|:|\.\d|,\d))/.exec(s)) && Number(m[1]) >= 1 && Number(m[1]) <= 12) {
      time = [guessHour(Number(m[1]), evening), 0];
    } else if ((m = /\b(morning|afternoon|evening|night)\b/.exec(s)) && (date || weekday)) {
      time = { morning: [9, 0], afternoon: [15, 0], evening: [19, 0], night: [19, 0] }[m[1]];
    } else if (evening) {
      time = [19, 0];  // "tonight"
      m = null;
    } else m = null;
    if (m) said.push(m[0]);

    if (weekday) {
      let ahead = (weekday.day - today.getDay() + 7) % 7;
      if (weekday.next) ahead = 7 - ((today.getDay() + 6) % 7) + ((weekday.day + 6) % 7);  // that day of next week
      else if (ahead === 0) {
        const later = time && (time[0] * 60 + time[1] > now.getHours() * 60 + now.getMinutes());
        ahead = later ? 0 : 7;
      }
      date = plusDays(today, ahead);
    }
    if (!date) {
      if (!time || !strong) return null;
      const passed = time[0] * 60 + time[1] <= now.getHours() * 60 + now.getMinutes();
      date = passed ? plusDays(today, 1) : today;
    }
    return result(date, time, now, said);
  }

  function result(date, time, now, said) {
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), ...(time || DEFAULT_TIME));
    const day = dayText(date);
    const hhmm = time ? `${pad(time[0])}:${pad(time[1])}` : null;
    return { date: day, time: hhmm, at, past: at <= now, key: day + (hhmm ? 'T' + hhmm : ''),
      words: said.map((w) => w.trim()).filter(Boolean).join(' ') };
  }

  /* -- saying when */

  /* "9:00 AM", "12:30 PM" (the same on every device, whatever its language). */
  function clock(hhmm) {
    const [h, m] = (hhmm instanceof Date ? `${hhmm.getHours()}:${hhmm.getMinutes()}` : String(hhmm)).split(':').map(Number);
    return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
  }

  /* "Today", "Tomorrow", "Friday" (this week), "Fri Nov 6" (later), "Tue Jan 5, 2027" (another year). */
  function dayLabel(day, now = new Date()) {
    const d = fromDay(day);
    const days = daysBetween(now, d);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    if (days > 1 && days < 7) return WEEKDAY_NAMES[d.getDay()];
    return `${SHORT_DAYS[d.getDay()]} ${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`
      + (d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : '');
  }

  const label = (found, now = new Date()) => dayLabel(found.date, now) + (found.time ? ' ' + clock(found.time) : '');

  /* -- a note's reminder */

  function remindAt(note) {
    const value = note && note.extra && note.extra.remind_at;
    if (!value) return null;
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
  }

  /* The day a note belongs to in the Upcoming list: its due date, else its reminder's day. */
  const dayOf = (note) => note.due || (remindAt(note) ? dayText(remindAt(note)) : null);

  /* "9:00 AM" when the reminder is on the note's due day, else "Sun 7:00 PM". */
  function remindLabel(note, now = new Date()) {
    const at = remindAt(note);
    if (!at) return '';
    if (note.due === dayText(at)) return clock(at);
    const days = daysBetween(now, at);
    if (days === 0) return 'Today ' + clock(at);
    if (days === 1) return 'Tomorrow ' + clock(at);
    return `${days > 1 && days < 7 ? SHORT_DAYS[at.getDay()] : `${SHORT_MONTHS[at.getMonth()]} ${at.getDate()}`} ${clock(at)}`;
  }

  /* The note as it is now: the open copy (with what was just typed) or the stored row. */
  const latest = (id) => (V.editor.openId() === id && V.editor.current() ? V.editor.current() : V.data.notes.get(id));

  /* A change to a note (its due date, done, extra): through the editor when it's open, so its copy stays the one that
     saves, else straight to its row. */
  function change(id, fn) {
    if (V.editor.openId() === id && V.editor.current()) {
      return V.editor.update((note) => { note.extra = { ...(note.extra || {}) }; fn(note); });
    }
    const row = V.data.notes.get(id);
    if (!row) return Promise.resolve();
    const copy = { ...row, extra: { ...(row.extra || {}) } };
    fn(copy);
    return V.cloud.save('notes', copy);
  }

  /* -- the phone's calendar */

  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');  // 20261030T130000Z

  function noteLink(id) {
    const own = location.protocol === 'https:' || location.protocol === 'http:' ? location.origin + location.pathname : '';
    const base = (V.config && V.config.phoneUrl) || own || 'https://crustyt0es.github.io/vault/';
    return `${base.replace(/#.*$/, '')}#note=${id}`;
  }

  function details(note) {
    return `${V.noteTitle(note)}\n\nOpen in Vault: ${noteLink(note.id)}`;
  }

  /* A Google Calendar "new event" page, filled in: the note's title, half an hour from the reminder, and a link back. */
  function calendarLink(note, at = remindAt(note)) {
    const end = new Date(at.getTime() + 30 * 60000);
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
      + `&text=${encodeURIComponent(V.noteTitle(note))}&dates=${stamp(at)}/${stamp(end)}`
      + `&details=${encodeURIComponent(details(note))}`;
  }

  /* The same event as an .ics file, with an alarm 10 minutes before. Lines folded at 75 bytes, as the format says. */
  function ics(note, at = remindAt(note), now = new Date()) {
    const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const end = new Date(at.getTime() + 30 * 60000);
    const title = V.noteTitle(note);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vault//Reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', `UID:${note.id}-${stamp(at)}@vault`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(at)}`,
      `DTEND:${stamp(end)}`, `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(details(note))}`, `URL:${noteLink(note.id)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, 'TRIGGER:-PT10M', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'];
    const encoder = new TextEncoder();
    const fold = (line) => {
      const out = [];
      let piece = '';
      let size = 0;
      for (const char of line) {
        const bytes = encoder.encode(char).length;
        if (size + bytes > (out.length ? 74 : 75)) { out.push(piece); piece = ''; size = 0; }
        piece += char;
        size += bytes;
      }
      out.push(piece);
      return out.join('\r\n ');
    };
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  function openOutside(url) {
    if (V.desktop && V.pc) { V.pc.call('openLink', { url }).catch(V.problem); return true; }
    return !!window.open(url, '_blank', 'noopener');
  }

  function downloadIcs(note, at = remindAt(note)) {
    const name = ((V.noteTitle(note) || 'Reminder').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Reminder') + '.ics';
    const url = URL.createObjectURL(new Blob([ics(note, at)], { type: 'text/calendar' }));
    const link = V.h('a', { href: url, download: name, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    V.toast(V.desktop ? `Saved ${name} in Downloads\\Vault` : `Downloaded ${name}: open it to add it to your calendar`);
  }

  /* -- the question, as the words are typed */

  let showing = null;  // { id, key }: the question up now

  const askSoon = V.debounce(() => consider(), ASK_AFTER);

  /* What the title or first line says, if anything worth asking about. */
  function consider(now = new Date()) {
    const id = V.editor.openId();
    const note = V.editor.current();
    if (!id || !note) return null;
    if (showing && showing.id !== id) showing = null;
    const extra = note.extra || {};
    if (extra.remind_asked === 'never' || V.organise.isTemplate(note)) return null;
    const firstLine = ((V.editor.words() || '').split('\n')[0] || '');
    const found = parse(note.title || '', now) || parse(firstLine, now);
    if (!found || found.past) {
      if (showing && showing.kind === 'question') { V.editor.ask(null); showing = null; }
      return null;
    }
    const at = remindAt(note);
    const already = extra.remind_asked === found.key
      || (note.due === found.date && (!found.time || (at && at.getTime() === found.at.getTime())));
    if (already || (showing && showing.key === found.key)) return null;
    question(found, id);
    return found;
  }

  const askButton = (text, kind, onClick, extraClass = '') => V.h('button.ask-btn.keep-caret' + (kind ? '.' + kind : '') + extraClass, {
    type: 'button', onclick: onClick,
  }, text);

  function question(found, id) {
    const when = label(found);
    showing = { id, key: found.key, kind: 'question' };
    V.editor.ask(V.h('div.ask-card', { role: 'group', 'aria-label': `${when}: set a reminder?` },
      V.h('div.ask-top', {}, icon('bell', 'ask-icon'),
        V.h('span.ask-text', {}, V.h('strong', { text: when }), V.h('span', { text: ' · Set a reminder?' })),
        V.h('button.ask-close.keep-caret', { type: 'button', title: 'Not now', 'aria-label': 'Not now',
          onclick: () => answer('no', found, id) }, V.icon('x'))),
      V.h('div.ask-actions', {},
        askButton('Remind me on my phone', 'primary', () => answer('remind', found, id)),
        askButton('Just a due date', '', () => answer('due', found, id)),
        askButton('No', '', () => answer('no', found, id)),
        askButton('Don\'t ask in this note', 'quiet', () => answer('never', found, id)))));
  }

  function answer(kind, found, id) {
    if (V.editor.openId() !== id) return;
    V.editor.ask(null);
    showing = null;
    V.editor.update((note) => {
      const extra = { ...(note.extra || {}) };
      extra.remind_asked = kind === 'never' ? 'never' : found.key;
      if (kind === 'remind' || kind === 'due') { note.due = found.date; note.done = false; }
      if (kind === 'remind') extra.remind_at = found.at.toISOString();
      note.extra = extra;
    });
    const note = V.editor.current();
    if (kind === 'due') V.toast(`Due ${dayLabel(found.date)}`);
    else if (kind === 'never') V.toast('Vault won\'t ask about dates in this note.');
    else if (kind === 'remind') {
      // Opened now, while the tap still counts (a page opened later is stopped as a pop-up).
      const opened = openOutside(calendarLink(note, found.at));
      afterRemind(note, found, opened);
    }
  }

  /* After "Remind me on my phone": what happened, and the other ways (an .ics file; notifications while Vault is open,
     asked for here only, the first time). */
  function afterRemind(note, found, opened) {
    const id = note.id;
    const when = dayLabel(found.date) + ' ' + clock(found.at);
    const canNotify = !V.desktop && 'Notification' in window && Notification.permission === 'default' && !flag(NOTIFY_ASKED);
    showing = { id, key: found.key, kind: 'done' };
    const close = () => {
      if (canNotify) setFlag(NOTIFY_ASKED);  // asked once: "Done" is an answer too
      if (showing && showing.kind === 'done') { V.editor.ask(null); showing = null; }
    };
    V.editor.ask(V.h('div.ask-card.after', { role: 'status' },
      V.h('div.ask-top', {}, V.icon('check', 'ask-icon ok'),
        V.h('span.ask-text', {}, V.h('strong', { text: `Reminder set: ${when}.` }),
          V.h('span', { text: opened ? ` Save the event in Google Calendar (it opened in ${V.desktop ? 'your browser' : 'a new tab'}) so your phone rings.`
            : ' Add it to your calendar so your phone rings:' })),
        V.h('button.ask-close.keep-caret', { type: 'button', title: 'Close', 'aria-label': 'Close', onclick: close }, V.icon('x'))),
      canNotify ? V.h('p.ask-line', { text: 'Vault can also show a notification at that time while it\'s open.' }) : null,
      V.h('div.ask-actions', {},
        opened ? null : askButton('Open Google Calendar', 'primary', () => openOutside(calendarLink(latest(id) || note, found.at))),
        askButton('Download .ics instead', '', () => downloadIcs(latest(id) || note, found.at)),
        canNotify ? askButton('Allow notifications', opened ? 'primary' : '', async () => {
          setFlag(NOTIFY_ASKED);
          close();
          let answerGiven = 'default';
          try { answerGiven = await Notification.requestPermission(); } catch (error) { /* an old browser */ }
          V.toast(answerGiven === 'granted' ? 'Notifications on: Vault pings you while it\'s open.'
            : 'No notifications, then. Your calendar still reminds you.');
        }) : null,
        askButton('Done', canNotify ? 'quiet' : opened ? 'primary' : '', close))));
  }

  /* The first reminder set from the sheet (not from the typed question, which offers it itself): notifications, asked
     about once, in one line above the tools of the open note. */
  function offerNotifications(id) {
    if (V.desktop || !('Notification' in window) || Notification.permission !== 'default' || flag(NOTIFY_ASKED)) return;
    if (V.editor.openId() !== id) return;
    showing = { id, key: '', kind: 'done' };
    const close = () => { if (showing && showing.kind === 'done') { V.editor.ask(null); showing = null; } };
    V.editor.ask(V.h('div.ask-card.after', { role: 'status' },
      V.h('div.ask-top', {}, icon('bell', 'ask-icon'),
        V.h('span.ask-text', { text: 'Vault can also show a notification at that time while it\'s open.' }),
        V.h('button.ask-close.keep-caret', { type: 'button', title: 'Close', 'aria-label': 'Close', onclick: close }, V.icon('x'))),
      V.h('div.ask-actions', {},
        askButton('Allow notifications', 'primary', async () => {
          setFlag(NOTIFY_ASKED);
          close();
          let given = 'default';
          try { given = await Notification.requestPermission(); } catch (error) { /* an old browser */ }
          V.toast(given === 'granted' ? 'Notifications on: Vault pings you while it\'s open.'
            : 'No notifications, then. Your calendar still reminds you.');
        }),
        askButton('Not now', 'quiet', () => { setFlag(NOTIFY_ASKED); close(); }))));
  }

  function flag(key) {
    try { return !!localStorage.getItem(key); } catch (error) { return false; }
  }
  function setFlag(key) {
    try { localStorage.setItem(key, '1'); } catch (error) { /* private browsing */ }
  }

  /* -- changing a note's day and reminder */

  /* The sheet the bell chip, the Upcoming list's day button and the Reminder tool open. */
  function edit(id, { remind = null } = {}) {
    const note = latest(id);
    if (!note) return;
    const at = remindAt(note);
    const today = V.today();
    const weekday = new Date().getDay();
    const day = V.h('input.field', { type: 'date', value: note.due || (at ? dayText(at) : V.addDays(today, 1)), 'aria-label': 'Day' });
    const switchId = 'remind-' + V.uuid();
    const on = V.h('input.switch', { type: 'checkbox', id: switchId, checked: remind === null ? !!at || !note.due : remind,
      'aria-label': 'Remind me' });
    const time = V.h('input.field.time-field', { type: 'time', value: at ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : '09:00',
      'aria-label': 'Reminder time' });
    const error = V.h('p.error-text');
    const showTime = () => { time.disabled = !on.checked; timeRow.classList.toggle('off', !on.checked); };
    on.addEventListener('change', showTime);
    const pick = (value) => { day.value = value; };
    const timeRow = V.h('div.remind-row', {}, V.h('label.remind-row-text', { for: switchId }, V.h('strong', { text: 'Remind me' }),
      V.h('span.hint', { text: 'On the day, at' })), time, on);
    const chosen = () => {
      if (!day.value) { error.textContent = 'Pick a day.'; return null; }
      const when = on.checked ? new Date(`${day.value}T${time.value || '09:00'}`) : null;
      if (when && Number.isNaN(when.getTime())) { error.textContent = 'Pick a time.'; return null; }
      return { day: day.value, when };
    };
    const apply = (picked) => change(id, (row) => {
      if (row.due !== picked.day) row.done = false;
      row.due = picked.day;
      if (picked.when) {
        row.extra.remind_at = picked.when.toISOString();
        row.extra.remind_asked = `${picked.day}T${pad(picked.when.getHours())}:${pad(picked.when.getMinutes())}`;
      } else delete row.extra.remind_at;
    });
    const outside = (how) => async () => {
      if (!on.checked) { on.checked = true; showTime(); }  // a calendar event is a reminder: at the time shown
      const picked = chosen();
      if (!picked) return;
      await apply(picked);
      const row = latest(id);
      if (how === 'google') openOutside(calendarLink(row, picked.when));
      else downloadIcs(row, picked.when);
    };
    showTime();
    const sheet = V.sheet({
      title: 'Due date and reminder',
      content: [
        V.h('div.quick-dates', {},
          V.button('Today', { onClick: () => pick(today) }),
          V.button('Tomorrow', { onClick: () => pick(V.addDays(today, 1)) }),
          V.button('Friday', { onClick: () => pick(V.addDays(today, ((5 - weekday + 7) % 7) || 7)) }),
          V.button('Next week', { onClick: () => pick(V.addDays(today, ((1 - weekday + 7) % 7) || 7)) })),
        V.h('label.label', {}, 'Day', day),
        timeRow,
        error,
        V.h('p.hint.remind-hint', { text: 'Vault reminds you while it\'s open. To have your phone ring even when it isn\'t, add it to your calendar:' }),
        V.h('div.remind-outside', {},
          V.button('Google Calendar', { icon: 'calendar', onClick: outside('google') }),
          V.button('Download .ics', { icon: 'download', onClick: outside('ics') })),
      ],
      actions: [
        at ? { label: 'Remove reminder', kind: 'danger-quiet', onClick: () => {
          change(id, (row) => { delete row.extra.remind_at; });
          V.toast('Reminder removed');
        } } : null,
        { label: 'Save', kind: 'primary', onClick: () => {
          const picked = chosen();
          if (!picked) return true;
          apply(picked).then(() => V.toast(picked.when ? `Reminder: ${dayLabel(picked.day)} ${clock(picked.when)}` : `Due ${dayLabel(picked.day)}`)).catch(V.problem);
          if (picked.when) offerNotifications(id);
          return false;
        } },
      ].filter(Boolean),
    });
    return sheet;
  }

  /* -- in the note and on its card */

  V.editor.onTyped(({ first }) => { if (first) askSoon(); });

  V.editor.addMeta((note) => {
    const at = remindAt(note);
    if (!at) return null;
    const late = at < new Date() && !note.done;
    return V.h('button.chip.remind-chip' + (late ? '.late' : ''), {
      type: 'button', title: 'Reminder: change or remove it', onclick: () => edit(note.id),
    }, icon('bell'), V.h('span', { text: `${dayLabel(dayText(at))} ${clock(at)}` }));
  });

  V.editor.addTool({ name: 'remind', label: 'Reminder', icon: () => icon('bell'), keepCaret: false,
    onClick: () => { const id = V.editor.openId(); if (id) edit(id, { remind: true }); } });

  function cardChip(note) {
    const at = remindAt(note);
    if (!at || note.done) return null;
    return V.h('span.due.remind' + (at < new Date() ? '.late' : ''), { title: 'Reminder' }, icon('bell'), remindLabel(note));
  }

  /* -- the Upcoming list (the Notes tab's "Upcoming") */

  /* In the list: what's due or has a reminder and isn't done, and what was done this week (ticked, struck through). */
  function inUpcoming(note, now = new Date()) {
    const day = dayOf(note);
    if (!day) return false;
    if (!note.done) return true;
    const days = daysBetween(now, fromDay(day));
    return days >= 0 && days < 7;
  }
  const pending = (note) => !!dayOf(note) && !note.done;

  /* The groups the list is in, in order: Overdue, Today, Tomorrow, the weekdays after, Later. */
  function groupOf(note, now = new Date()) {
    const days = daysBetween(now, fromDay(dayOf(note)));
    if (days < 0) return { key: 'overdue', title: 'Overdue', order: -1 };
    if (days === 0) return { key: 'today', title: 'Today', order: 0 };
    if (days === 1) return { key: 'tomorrow', title: 'Tomorrow', order: 1 };
    if (days < 7) return { key: 'day' + days, title: WEEKDAY_NAMES[fromDay(dayOf(note)).getDay()], order: days };
    return { key: 'later', title: 'Later', order: 7 };
  }

  function sortKey(note) {
    const at = remindAt(note);
    const time = at && dayText(at) === dayOf(note) ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : '99:99';
    return `${dayOf(note)} ${note.done ? 1 : 0} ${time} ${V.noteTitle(note).toLowerCase()}`;
  }

  function group(list, now = new Date()) {
    const groups = new Map();
    for (const note of [...list].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))) {
      const where = groupOf(note, now);
      if (!groups.has(where.key)) groups.set(where.key, { ...where, notes: [] });
      groups.get(where.key).notes.push(note);
    }
    return [...groups.values()].sort((a, b) => a.order - b.order);
  }

  function toggleDone(id) {
    const note = latest(id);
    if (!note) return;
    const done = !note.done;
    change(id, (row) => { row.done = done; }).catch(V.problem);
    if (done) V.toast('Nice, done.', { action: 'Undo', onAction: () => change(id, (row) => { row.done = false; }).catch(V.problem) });
  }

  /* The list drawn by day: each note's card with a tick before it and its day (or time) after it, which moves it. */
  function upcoming(list, make) {
    const now = new Date();
    return group(list, now).map((part) => [
      V.h('h2.list-section.up-section' + (part.key === 'overdue' ? '.late' : ''), {},
        V.h('span', { text: part.title }), V.h('span.count', { text: String(part.notes.filter((n) => !n.done).length || '') })),
      part.notes.map((note) => {
        const at = remindAt(note);
        const days = daysBetween(now, fromDay(dayOf(note)));
        const when = at && !note.done ? remindLabel(note, now)
          : part.key === 'later' || part.key === 'overdue' ? dayLabel(dayOf(note), now) : 'Move';
        return V.h('div.up-row' + (note.done ? '.done' : ''), { dataset: { id: note.id } },
          V.h('button.up-tick', { type: 'button', 'aria-pressed': String(!!note.done),
            'aria-label': note.done ? `${V.noteTitle(note)}: not done` : `${V.noteTitle(note)}: mark done`,
            onclick: () => toggleDone(note.id) }, V.icon('check')),
          make(note),
          V.h('button.up-when' + (days < 0 && !note.done ? '.late' : ''), { type: 'button', title: 'Move it, or change its reminder',
            'aria-label': `When: ${when}. Change it`, onclick: () => edit(note.id) },
          icon(at && !note.done ? 'bell' : 'calendar'), V.h('span', { text: when })));
      }),
    ]);
  }

  /* -- reminding while Vault is open */

  function seen() {
    try { return JSON.parse(localStorage.getItem(SEEN) || '[]'); } catch (error) { return []; }
  }
  function markSeen(key) {
    const list = seen().filter((k) => k !== key);
    list.push(key);
    try { localStorage.setItem(SEEN, JSON.stringify(list.slice(-200))); } catch (error) { /* private browsing */ }
  }

  /* A notification (only when it was allowed; never on the PC, where Jarvis says it). */
  async function notify(title, options) {
    if (V.desktop || !('Notification' in window) || Notification.permission !== 'granted') return false;
    try {
      const registration = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (registration && registration.showNotification) { await registration.showNotification(title, options); return true; }
    } catch (error) { /* no worker: a plain one below */ }
    try { new Notification(title, options); return true; } catch (error) { return false; }  // eslint-disable-line no-new
  }

  function ring(note, at, late) {
    const title = V.noteTitle(note);
    V.toast(`${late ? 'Missed reminder' : 'Reminder'}: ${title} (${clock(at)})`, { ms: 12000, action: 'Open', onAction: () => openNote(note.id) });
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (error) { /* no buzz */ }
    Promise.resolve(api.notify(title, { body: `${late ? 'Missed reminder' : 'Reminder'} · ${clock(at)}`, tag: 'vault-' + note.id,
      data: { url: noteLink(note.id), id: note.id }, icon: 'icons/icon-192.png', badge: 'icons/monochrome-512.png' }))
      .catch(() => {});
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!V.data || !V.data.notes) return;
    const now = Date.now();
    const said = new Set(seen());
    let next = Infinity;
    for (const note of V.data.notes.values()) {
      if (note.deleted || note._purge || note.done || V.organise.isTemplate(note) || V.organise.isArchived(note)) continue;
      const at = remindAt(note);
      if (!at) continue;
      const when = at.getTime();
      const key = `${note.id}|${note.extra.remind_at}`;
      if (when > now) next = Math.min(next, when);
      else if (now - when < MISSED_HOURS * 3600000 && !said.has(key)) {
        markSeen(key);
        ring(note, at, now - when > 2 * 60000);
      }
    }
    if (next < Infinity) timer = setTimeout(schedule, Math.min(next - now + 50, 2 ** 31 - 1));
  }
  const scheduleSoon = V.debounce(schedule, 300);
  V.on('data', (table) => { if (table === 'notes') scheduleSoon(); });
  V.on('back', scheduleSoon);

  /* -- opening a note from a link (the calendar's "Open in Vault") or a notification */

  function openNote(id) {
    if (!V.data || !V.data.notes.has(id)) return false;
    if (V.tab && V.tab() !== 'notes') V.go('notes');
    V.notes.open(id);
    return true;
  }

  let hashTries = 0;
  function fromHash() {
    const found = /^#note=([0-9a-f-]{36})$/i.exec(location.hash);
    if (!found) return;
    const app = document.getElementById('app');
    const ready = app && app.classList.contains('ready') && !app.classList.contains('gate') && V.data && V.data.notes;
    if (ready && V.data.notes.has(found[1])) {
      history.replaceState(history.state, '', location.pathname + location.search);
      hashTries = 0;
      openNote(found[1]);
      return;
    }
    if (++hashTries > 480) {  // two minutes (signing in first): it isn't here
      history.replaceState(history.state, '', location.pathname + location.search);
      if (ready) V.toast('That note isn\'t in Vault on this device.');
      hashTries = 0;
      return;
    }
    setTimeout(fromHash, 250);
  }
  window.addEventListener('hashchange', () => { hashTries = 0; fromHash(); });
  setTimeout(fromHash, 0);
  if (!V.desktop && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const said = event.data || {};
      if (said.vault === 'open-note' && typeof said.id === 'string') openNote(said.id);
    });
  }

  const api = { parse, label, dayLabel, clock, remindAt, remindLabel, dayOf, calendarLink, ics, noteLink, consider, edit,
    cardChip, inUpcoming, pending, group, upcoming, schedule, notify, icon, change, latest, openNote };
  return api;
})();
