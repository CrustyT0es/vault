/* Vault: dates and reminders typed in plain words. "test fri 9am", "tomorrow 5pm", "due monday", "on the 3rd at 7",
   "next week", "in 2 hours" or "dec 5" in a note's title or first line is understood (on this device's clock, in its
   time zone), and once the typing stops a small question shows just above the tools (above the phone's keyboard; it
   never takes the caret): remind me on my phone, just a due date, or no (and "don't ask in this note").

   Kept in the note: `due` (the day), extra.remind_at (when, as an ISO time) and extra.remind_asked (the date and time
   last asked about, or 'never'). The words stay as they were typed, so Jarvis reads them as they are.

   A reminder reaches the phone through its calendar: a Google Calendar event filled in from a link (the phone's
   Calendar app, and Samsung Calendar, show Google's events), or an .ics file with an alarm 10 minutes before. While
   Vault is open (or was a few hours ago) it reminds too: a notification when that was allowed, and a toast. The Notes
   tab's Upcoming list shows the week by day; a bell chip on a note (and on its card) says when, and changes it.

   A reminder (or a due date) can repeat: "Badminton every Tuesday 6pm", "every other Friday", or the sheet's Repeat.
   It moves on to its next one by itself when one goes by or is ticked done (see "repeating" below; set() is the one
   call for other parts, such as Chat's tools). */
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

    // "every Tuesday", "every other Friday", "every day", "each weekday", "every 2 weeks", "daily", "on Tuesdays":
    // taken out of the words first, so the rest gives the time (and maybe the day it starts).
    const rep = readRepeat(s);
    if (rep) {
      said.push(rep.found[0]);
      s = blank(s, rep.found);
      if (rep.hint === 'evening') evening = true;
    }

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
    } else if ((m = /\b(morning|afternoon|evening|night)\b/.exec(s)) && (date || weekday || rep)) {
      time = { morning: [9, 0], afternoon: [15, 0], evening: [19, 0], night: [19, 0] }[m[1]];
    } else if (evening) {
      time = [19, 0];  // "tonight"
      m = null;
    } else m = null;
    if (m) said.push(m[0]);
    if (rep && !time && rep.hint) time = HINT_TIMES[rep.hint];
    if (rep && rep.hint === 'morning' && time && !strong && time[0] > 12) time = [time[0] - 12, time[1]];  // "every morning at 7"

    if (weekday) {
      let ahead = (weekday.day - today.getDay() + 7) % 7;
      if (weekday.next) ahead = 7 - ((today.getDay() + 6) % 7) + ((weekday.day + 6) % 7);  // that day of next week
      else if (ahead === 0) {
        const later = time && (time[0] * 60 + time[1] > now.getHours() * 60 + now.getMinutes());
        ahead = later ? 0 : 7;
      }
      date = plusDays(today, ahead);
    }
    if (rep) {
      if (rep.soft && !date && !time) return null;  // "Daily standup notes": a word, not a reminder
      return repeating(rep, date, time, now, said);
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

  /* -- repeating (1.16.1): extra.repeat

     "Badminton every Tuesday 6pm", "every day at 7", "every other Friday", "each weekday", "every 2 weeks", "every
     month", "every year", "daily at 8", "on Tuesdays at 6" (or the Repeat choice in the reminder's sheet) make a note's
     reminder (or its due date alone) come back. Kept in the note as extra.repeat:

       { every: 'day' | 'weekday' | 'week' | 'month' | 'year',
         n:      every n of them (2 = every other),
         days:   a week's days, 0 Sunday ... 6 Saturday (only for 'week'),
         start:  'YYYY-MM-DD', the first one: "every other" and "every month" count from it,
         until:  'YYYY-MM-DD', the last day one may fall on (optional),
         last:   the reminder that went by last (an ISO time), said as missed on a device that wasn't open then }

     The note's own `due` and extra.remind_at are always the next one, so an older Wefty (which doesn't know
     extra.repeat) shows a plain reminder and never breaks. When one goes by (or is ticked done) the note moves on to the
     next one still to come, never a pile of missed ones (moveOn). Days are counted in this device's time zone, at the
     reminder's own clock time, so 6 PM stays 6 PM across a clock change. Where the next one falls is worked out from
     the note alone, so two devices moving it on at once write the same thing, and one that already moved (here or
     elsewhere) is never moved again. */

  const KINDS = ['day', 'weekday', 'week', 'month', 'year'];
  const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const IS_DAY = /^\d{4}-\d{2}-\d{2}$/;
  const HINT_TIMES = { morning: [9, 0], afternoon: [15, 0], evening: [19, 0] };
  const PLURAL_DAYS = { sundays: 0, mondays: 1, tuesdays: 2, wednesdays: 3, thursdays: 4, fridays: 5, saturdays: 6 };
  const DAY_LIST = `(?:${words(DAY_WORDS)})s?(?:\\s*(?:,|&|\\+|\\/|\\band\\b)\\s*(?:${words(DAY_WORDS)})s?)*`;
  const EVERY = new RegExp(`\\b(?:every|each)\\s+(?:(other)\\s+|${COUNT}\\s+)?(${DAY_LIST}|week\\s*days?|school\\s+days?|weekends?|days?|weeks?|months?|years?|mornings?|afternoons?|evenings?|nights?)(?![a-z])`);
  const SOFT = /\b(daily|everyday|weekly|fortnightly|biweekly|monthly|yearly|annually)\b/;
  const PLURAL = new RegExp(`\\b(on\\s+)?((?:${Object.keys(PLURAL_DAYS).join('|')})(?:\\s*(?:,|&|\\band\\b)\\s*(?:${Object.keys(PLURAL_DAYS).join('|')}))*)\\b`);
  const validDay = (text) => typeof text === 'string' && IS_DAY.test(text) && dayText(fromDay(text)) === text;
  const atOn = (d, [h, m]) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
  const mondayOf = (d) => plusDays(d, -((d.getDay() + 6) % 7));

  /* The repeat said in the words `s` (lower case), or null: { every, n, days, hint (a time of day), soft, found }. */
  function readRepeat(s) {
    let m = EVERY.exec(s);
    if (m) {
      const unit = m[3].replace(/\s+/g, ' ');
      const n = m[1] ? 2 : m[2] ? NUMBER_WORDS[m[2]] || Number(m[2]) : 1;
      const out = { every: 'week', n: Math.min(Math.max(n || 1, 1), 99), found: m };
      if (/^(week ?days?|school days?)$/.test(unit)) { out.every = 'weekday'; out.n = 1; }
      else if (/^weekends?$/.test(unit)) out.days = [0, 6];
      else if (/^days?$/.test(unit)) out.every = 'day';
      else if (/^(morning|afternoon|evening|night)s?$/.test(unit)) {
        out.every = 'day';
        out.hint = /^(evening|night)/.test(unit) ? 'evening' : unit.replace(/s$/, '');
      } else if (/^weeks?$/.test(unit)) { /* (its day: the one said with it, or today's) */ }
      else if (/^months?$/.test(unit)) out.every = 'month';
      else if (/^years?$/.test(unit)) out.every = 'year';
      else {
        const names = unit.match(new RegExp(`(?:${words(DAY_WORDS)})`, 'g')) || [];
        out.days = [...new Set(names.map((w) => DAY_WORDS[w]))].sort((a, b) => a - b);
      }
      return out;
    }
    if ((m = PLURAL.exec(s)) && (m[1] || TIME_AHEAD.test(s.slice(m.index + m[0].length)))) {
      const names = m[2].match(new RegExp(Object.keys(PLURAL_DAYS).join('|'), 'g'));
      return { every: 'week', n: 1, days: [...new Set(names.map((w) => PLURAL_DAYS[w]))].sort((a, b) => a - b), found: m };
    }
    if ((m = SOFT.exec(s))) {
      const kind = { daily: ['day', 1], everyday: ['day', 1], weekly: ['week', 1], fortnightly: ['week', 2], biweekly: ['week', 2],
        monthly: ['month', 1], yearly: ['year', 1], annually: ['year', 1] }[m[1]];
      return { every: kind[0], n: kind[1], soft: true, found: m };
    }
    return null;
  }

  /* A parse() result for repeating words: the first one still to come (from the day said, else today). */
  function repeating(rep, date, time, now, said) {
    const today = midnight(now);
    const base = date || today;
    const rule = { every: rep.every, n: rep.n };
    if (rep.every === 'week') rule.days = rep.days || [base.getDay()];
    const probe = { ...rule, n: 1, start: dayText(base) };  // (the first one fits the days, whatever the n)
    let first = null;
    for (let k = 0; k < 400 && !first; k++) {
      const d = plusDays(base, k);
      if (fits(probe, d) && atOn(d, time || DEFAULT_TIME) > now) first = d;
    }
    if (!first) return null;
    rule.start = dayText(first);
    const found = result(first, time, now, said);
    found.repeat = rule;
    found.key += '|' + ruleKey(rule);
    return found;
  }

  /* A rule as it's kept, tidied (anything odd from another device or version: null, never an error). */
  function cleanRule(raw) {
    if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.every)) return null;
    const rule = { every: raw.every, n: raw.every === 'weekday' ? 1 : Math.min(Math.max(Math.round(Number(raw.n) || 1), 1), 99) };
    if (rule.every === 'week' && Array.isArray(raw.days)) {
      const days = [...new Set(raw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
      if (days.length) rule.days = days;
    }
    if (validDay(raw.start)) rule.start = raw.start;
    if (validDay(raw.until)) rule.until = raw.until;
    if (typeof raw.last === 'string' && !Number.isNaN(new Date(raw.last).getTime())) rule.last = raw.last;
    return rule;
  }

  /* The note's next one: { day (a Date at midnight), at (the reminder, or null for a due date alone), key }. */
  function occurrence(note) {
    if (!note) return null;
    const at = remindAt(note);
    if (at) return { day: midnight(at), at, key: String(note.extra.remind_at) };
    return validDay(note.due) ? { day: fromDay(note.due), at: null, key: 'due:' + note.due } : null;
  }

  /* A note's repeat, ready to use (its start filled in from its next one when missing), or null. */
  function repeatOf(note) {
    const rule = cleanRule(note && note.extra && note.extra.repeat);
    if (!rule) return null;
    const here = occurrence(note);
    if (!rule.start) rule.start = here ? dayText(here.day) : V.today();
    if (rule.every === 'week' && !rule.days) rule.days = [fromDay(rule.start).getDay()];
    return rule;
  }

  const ruleKey = (rule) => (rule ? `${rule.every}${rule.n}${rule.days ? ':' + rule.days.join('') : ''}${rule.until ? '-' + rule.until : ''}` : '');

  /* Whether the rule falls on day `d` (a Date at midnight). */
  function fits(rule, d) {
    const start = fromDay(rule.start);
    if (d < start || (rule.until && dayText(d) > rule.until)) return false;
    if (rule.every === 'day') return daysBetween(start, d) % rule.n === 0;
    if (rule.every === 'weekday') return d.getDay() >= 1 && d.getDay() <= 5;
    if (rule.every === 'week') {
      if (!(rule.days || [start.getDay()]).includes(d.getDay())) return false;
      return Math.round(daysBetween(mondayOf(start), mondayOf(d)) / 7) % rule.n === 0;
    }
    const months = (d.getFullYear() - start.getFullYear()) * 12 + d.getMonth() - start.getMonth();
    if (months % (rule.every === 'year' ? 12 * rule.n : rule.n) !== 0) return false;
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();  // (the 31st in a short month: its last day)
    return d.getDate() === Math.min(start.getDate(), last);
  }

  /* The first day after `day` the rule falls on, or null once it has ended. */
  function nextAfter(rule, day) {
    const span = { day: 1, weekday: 3, week: 7, month: 31, year: 366 }[rule.every] * rule.n + 31;
    for (let k = 1; k <= span; k++) {
      const d = plusDays(day, k);
      if (rule.until && dayText(d) > rule.until) return null;
      if (fits(rule, d)) return d;
    }
    return null;
  }

  /* Where a repeating note goes next: the first one after its current one that's still to come (a reminder's time
     not gone yet; a due date alone, today or later). { day, at, due, key } or null (no repeat, or it has ended). */
  function upNext(note, now = new Date()) {
    const rule = repeatOf(note);
    const here = occurrence(note);
    if (!rule || !here) return null;
    const today = midnight(now);
    const time = here.at ? [here.at.getHours(), here.at.getMinutes()] : null;
    let d = here.day;
    for (let i = 0; i < 20000; i++) {
      d = nextAfter(rule, d);
      if (!d) return null;
      if (time ? atOn(d, time) > now : d >= today) break;
    }
    const at = time ? atOn(d, time) : null;
    const shift = daysBetween(here.day, d);
    return { day: dayText(d), at, due: validDay(note.due) ? dayText(plusDays(fromDay(note.due), shift)) : null,
      key: at ? at.toISOString() : 'due:' + dayText(d) };
  }

  /* A repeating note whose one has gone by (a reminder's time, or a due date's day) and isn't done. */
  function hasPassed(note, now = new Date()) {
    if (!note || note.done || !repeatOf(note)) return false;
    const here = occurrence(note);
    return !!here && (here.at ? here.at <= now : here.day < midnight(now));
  }

  /* "Every day", "Every weekday", "Every Tue", "Every Tue and Thu", "Every other Fri", "Every 3 weeks on Mon", "Every
     month on the 3rd", "Every year on Nov 2", with " until Dec 20" when it ends. */
  function repeatText(raw) {
    const rule = raw && raw.every ? raw : null;
    if (!rule) return '';
    const n = rule.n || 1;
    const list = (days) => {
      const names = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => SHORT_DAYS[d]);
      return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '';
    };
    const start = validDay(rule.start) ? fromDay(rule.start) : null;
    let text;
    if (rule.every === 'day') text = n === 1 ? 'Every day' : n === 2 ? 'Every other day' : `Every ${n} days`;
    else if (rule.every === 'weekday') text = 'Every weekday';
    else if (rule.every === 'week') {
      const days = rule.days || (start ? [start.getDay()] : []);
      const said = days.length === 7 ? 'day' : days.length === 5 && !days.includes(0) && !days.includes(6) ? 'weekday' : list(days);
      text = n === 1 ? `Every ${said}` : n === 2 ? `Every other ${said}` : `Every ${n} weeks on ${said}`;
    } else if (rule.every === 'month') {
      const on = start ? ` on the ${ordinal(start.getDate())}` : '';
      text = (n === 1 ? 'Every month' : n === 2 ? 'Every other month' : `Every ${n} months`) + on;
    } else {
      const on = start ? ` on ${SHORT_MONTHS[start.getMonth()]} ${start.getDate()}` : '';
      text = (n === 1 ? 'Every year' : `Every ${n} years`) + on;
    }
    if (validDay(rule.until)) {
      const end = fromDay(rule.until);
      text += ` until ${SHORT_MONTHS[end.getMonth()]} ${end.getDate()}` + (end.getFullYear() !== new Date().getFullYear() ? `, ${end.getFullYear()}` : '');
    }
    return text;
  }
  const ordinal = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

  /* When the next one is, said short: "today 6:00 PM", "tomorrow", "next Tue 6:00 PM", "next Tue Nov 10 6:00 PM". */
  function nextWords(day, at, now = new Date()) {
    const d = typeof day === 'string' ? fromDay(day) : midnight(day);
    const days = daysBetween(now, d);
    const time = at ? ' ' + clock(at) : '';
    if (days === 0) return 'today' + time;
    if (days === 1) return 'tomorrow' + time;
    if (days > 1 && days < 7) return `next ${SHORT_DAYS[d.getDay()]}` + time;
    return `next ${SHORT_DAYS[d.getDay()]} ${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`
      + (d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : '') + time;
  }

  /* A repeating note's line: "Every Tue · next Tue 6:00 PM" ("" when it doesn't repeat). */
  function repeatLine(note, now = new Date()) {
    const rule = repeatOf(note);
    const here = occurrence(note);
    if (!rule || !here) return '';
    return `${repeatText(rule)} · ${nextWords(here.day, here.at, now)}`;
  }

  /* The rule as an iCalendar RRULE (without "RRULE:"), for the calendar's event; `at` is its first one. */
  function rrule(rule) {
    const parts = [];
    const n = rule.n || 1;
    const start = fromDay(rule.start);
    if (rule.every === 'day') parts.push('FREQ=DAILY');
    else if (rule.every === 'weekday') parts.push('FREQ=WEEKLY', 'BYDAY=MO,TU,WE,TH,FR');
    else if (rule.every === 'week') {
      parts.push('FREQ=WEEKLY');
      if (n > 1) parts.push(`INTERVAL=${n}`, 'WKST=MO');
      parts.push('BYDAY=' + (rule.days || [start.getDay()]).map((d) => BYDAY[d]).join(','));
    } else if (rule.every === 'month') {
      parts.push('FREQ=MONTHLY');
      const day = start.getDate();
      // The 29th to 31st fall on a short month's last day, as here: the last of those days the month has.
      parts.push(day <= 28 ? `BYMONTHDAY=${day}` : `BYMONTHDAY=${Array.from({ length: day - 27 }, (_, i) => 28 + i).join(',')};BYSETPOS=-1`);
    } else parts.push('FREQ=YEARLY');
    if (n > 1 && rule.every !== 'week' && rule.every !== 'weekday') parts.splice(1, 0, `INTERVAL=${n}`);
    if (validDay(rule.until)) parts.push(`UNTIL=${rule.until.replace(/-/g, '')}T235959`);
    return parts.join(';');
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

  /* -- moving a repeating note on, and setting one */

  const TICKED_LINE = /^\s*[-*]\s*\[[xX]\]/m;
  const untick = (text) => String(text).split('\n').map((line) => line.replace(/^(\s*[-*]\s*\[)[xX](\])/, '$1 $2')).join('\n');
  const moving = new Set();
  const askedKey = (day, at, rule) => day + (at ? `T${pad(at.getHours())}:${pad(at.getMinutes())}` : '') + (rule ? '|' + ruleKey(rule) : '');

  /* Moves repeating note `id` on to its next one still to come, but only while it's still at `from` (the key of the
     one the caller saw: occurrence(note).key): one that has moved already (here, or on another device and synced)
     is left alone, so a tap and a timer, or two devices, never move it twice. `why`: 'passed' (its time went by:
     kept as repeat.last, so a device that wasn't open says it as missed) or 'done' (ticked). Its ticked boxes come off
     for the next one (not a locked note's, nor a repeating checklist's, which has its own days). Resolves to
     { before, next } (what putBack needs for an Undo), or null when nothing moved. */
  async function moveOn(id, { from, why = 'done', now = new Date() } = {}) {
    const note = latest(id);
    const here = occurrence(note);
    if (!note || !here || note.done || note.deleted || (from !== undefined && here.key !== from)) return null;
    const next = upNext(note, now);
    const flag = `${id}|${here.key}`;
    if (!next || moving.has(flag)) return null;
    moving.add(flag);
    try {
      const open = V.editor.openId() === id && !!V.editor.current();
      const words = open ? V.editor.words() : note.body;
      const fresh = !note.locked && !(note.extra && note.extra.reset) && typeof words === 'string' && TICKED_LINE.test(words)
        ? untick(words) : null;
      const before = { due: note.due || null, extra: { ...(note.extra || {}) }, words: fresh === null ? null : words, fresh };
      if (fresh !== null && open) V.editor.setWords(fresh);
      await change(id, (row) => {
        if (fresh !== null && !open) row.body = fresh;
        row.due = next.due;
        row.done = false;
        if (next.at) row.extra.remind_at = next.at.toISOString();
        const rule = { ...row.extra.repeat };
        if (!rule.start) rule.start = dayText(here.day);  // (counted from where it was, from now on)
        if (why === 'passed' && here.at) rule.last = here.key;
        row.extra.repeat = rule;
        if (row.extra.remind_asked && row.extra.remind_asked !== 'never') row.extra.remind_asked = askedKey(next.day, next.at, cleanRule(rule));
      });
      return { before, next };
    } finally {
      moving.delete(flag);
    }
  }

  /* Undoes a moveOn (its result): the day, reminder and ticks as they were, if it hasn't moved again since. */
  async function putBack(id, { before, next }) {
    const note = latest(id);
    const here = occurrence(note);
    if (!note || !here || here.key !== next.key) return false;
    const open = V.editor.openId() === id && !!V.editor.current();
    const words = open ? V.editor.words() : note.body;
    const ticks = before.words !== null && words === before.fresh;
    if (ticks && open) V.editor.setWords(before.words);
    await change(id, (row) => {
      if (ticks && !open) row.body = before.words;
      row.due = before.due;
      row.done = false;
      row.extra = { ...before.extra };
    });
    return true;
  }

  /* A repeating note ticked done: on to its next one, with an Undo. False when it doesn't repeat (or has ended). */
  async function doneOnce(id) {
    const here = occurrence(latest(id));
    const moved = here ? await moveOn(id, { from: here.key, why: 'done' }) : null;
    if (!moved) return false;
    V.toast(`Done. Next one: ${dayLabel(moved.next.day)}${moved.next.at ? ' ' + clock(moved.next.at) : ''}`,
      { action: 'Undo', onAction: () => putBack(id, moved).catch(V.problem) });
    return true;
  }

  /* A note's day, reminder and repeat, in one call (the reminder sheet's Save, and Chat's tools):

       V.reminders.set(noteId, { due, at, repeat })   ->  Promise<{ due, remind_at, repeat }>
       V.reminders.setRepeat(noteId, repeat)          (the same, with the repeat alone)

     due:    'YYYY-MM-DD', or null for none. Left out: the reminder's day when `at` is given, else as it is.
     at:     the reminder: a Date or an ISO time, or null for none. Left out: as it is.
     repeat: a rule ({ every: 'day' | 'weekday' | 'week' | 'month' | 'year', n, days, until }: see "repeating"
             above), words ("every Tuesday 6pm", "every other Friday", "daily": a time or day in them is used when
             `at` / `due` are left out), or null to stop repeating. Left out: as it is.
     A repeating one starts on the first day, on or after the one given, that its rule falls on. Rejects with an Error
     whose message can be shown as it is ("That note isn't here.", "Try words like \"every Tuesday\"."). */
  async function set(id, options = {}) {
    const note = latest(id);
    if (!note || note.deleted || note._purge) throw new Error('That note isn\'t here.');
    let when = options.at === undefined ? remindAt(note) : options.at === null ? null : new Date(options.at);
    if (when && Number.isNaN(when.getTime())) throw new Error('That time isn\'t one Wefty understands.');
    let day = options.due !== undefined ? options.due : options.at !== undefined && when ? dayText(when) : note.due || null;
    let rule;
    if (options.repeat === undefined) rule = cleanRule(note.extra && note.extra.repeat);
    else if (options.repeat === null || options.repeat === false) rule = null;
    else if (typeof options.repeat === 'string') {
      const found = parse(options.repeat);
      if (!found || !found.repeat) throw new Error('Try words like "every Tuesday" or "every other Friday".');
      rule = found.repeat;
      // "every week" with a day given: the week's day is that day's, not today's (parse() anchors on today).
      if ((options.at !== undefined || options.due !== undefined) && rule.every === 'week'
          && !/\b(mon|tue|wed|thu|fri|sat|sun)/i.test(options.repeat)) delete rule.days;
      if (options.at === undefined && options.due === undefined) {
        if (found.time) when = found.at;
        else if (when) when = atOn(fromDay(found.date), [when.getHours(), when.getMinutes()]);
        day = when ? dayText(when) : found.date;
      }
    } else {
      rule = cleanRule(options.repeat);
      if (!rule) throw new Error('That repeat isn\'t one Wefty understands.');
    }
    if (day !== null && !validDay(day)) throw new Error('Pick a day like 2026-11-03.');
    if (rule) {
      if (!day && !when) throw new Error('A repeat needs a day to start on.');
      const was = cleanRule(note.extra && note.extra.repeat);
      const from = when ? midnight(when) : fromDay(day);
      if (rule.every === 'week' && !rule.days) rule.days = [from.getDay()];
      // The start: kept when it's the same repeat (so "every month" on the 31st stays the 31st), else the first one.
      const keep = validDay(rule.start) ? rule.start : was && ruleKey(was) === ruleKey(rule) && was.start && was.start <= dayText(from) ? was.start : null;
      const probe = { ...rule, start: keep || dayText(from), ...(keep ? {} : { n: 1 }) };
      let first = null;
      for (let k = 0; k < 800 && !first; k++) if (fits(probe, plusDays(from, k))) first = plusDays(from, k);
      rule.start = keep || (first && dayText(first));
      // Never one that has gone already (it would only ring as missed): the first still to come.
      const now = new Date();
      const time = when ? [when.getHours(), when.getMinutes()] : null;
      for (let i = 0; first && i < 20000 && (time ? atOn(first, time) <= now : first < midnight(now)); i++) first = nextAfter(rule, first);
      if (!first) throw new Error('That repeat has ended before it starts: pick a later last day.');
      delete rule.last;
      const shift = daysBetween(from, first);
      if (when) when = atOn(first, [when.getHours(), when.getMinutes()]);
      if (day) day = dayText(plusDays(fromDay(day), shift));
    }
    await change(id, (row) => {
      if (row.due !== day) row.done = false;
      row.due = day;
      if (when) {
        row.extra.remind_at = when.toISOString();
        row.extra.remind_asked = askedKey(dayText(when), when, rule);
      } else delete row.extra.remind_at;
      if (rule) row.extra.repeat = rule;
      else delete row.extra.repeat;
    });
    return { due: day, remind_at: when ? when.toISOString() : null, repeat: rule };
  }
  const setRepeat = (id, repeat) => set(id, { repeat });

  /* -- the phone's calendar */

  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');  // 20261030T130000Z

  function noteLink(id) {
    const page = location.origin + location.pathname;
    const own = location.protocol === 'https:' || location.protocol === 'http:' ? (V.moved ? V.moved.address(page) : page) : '';
    const base = (V.config && V.config.phoneUrl) || own || 'https://crustyt0es.github.io/wefty/';
    return `${base.replace(/#.*$/, '')}#note=${id}`;
  }

  function details(note) {
    return `${V.noteTitle(note)}\n\nOpen in Wefty: ${noteLink(note.id)}`;
  }

  /* The same moment as this device's wall-clock time, with no zone: 20261103T180000 (a repeating event's times, so its
     6 PM stays 6 PM in the calendar across a clock change). */
  const wall = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  function timeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (error) { return ''; }
  }

  /* A Google Calendar "new event" page, filled in: the note's title, half an hour from the reminder, and a link back.
     A repeating one carries its rule (recur=RRULE:...), its times in this device's own time zone (ctz). */
  function calendarLink(note, at = remindAt(note)) {
    const end = new Date(at.getTime() + 30 * 60000);
    const rule = repeatOf(note);
    const zone = rule ? timeZone() : '';
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
      + `&text=${encodeURIComponent(V.noteTitle(note))}`
      + (rule ? `&dates=${wall(at)}/${wall(end)}${zone ? `&ctz=${encodeURIComponent(zone)}` : ''}&recur=${encodeURIComponent('RRULE:' + rrule(rule))}`
        : `&dates=${stamp(at)}/${stamp(end)}`)
      + `&details=${encodeURIComponent(details(note))}`;
  }

  /* The same event as an .ics file, with an alarm 10 minutes before. Lines folded at 75 bytes, as the format says. */
  function ics(note, at = remindAt(note), now = new Date()) {
    const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const end = new Date(at.getTime() + 30 * 60000);
    const title = V.noteTitle(note);
    // A repeating one: its rule, and its times as the clock on the wall (floating, so the rule follows this device's
    // time zone and its clock changes, the way a calendar app's own repeating event does).
    const rule = repeatOf(note);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wefty//Reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', `UID:${note.id}-${stamp(at)}@vault`, `DTSTAMP:${stamp(now)}`,
      ...(rule ? [`DTSTART:${wall(at)}`, `DTEND:${wall(end)}`, `RRULE:${rrule(rule)}`] : [`DTSTART:${stamp(at)}`, `DTEND:${stamp(end)}`]),
      `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(details(note))}`, `URL:${noteLink(note.id)}`,
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
    const rule = repeatOf(note);
    const already = extra.remind_asked === found.key
      || (note.due === found.date && (!found.time || (at && at.getTime() === found.at.getTime()))
        && (!found.repeat || ruleKey(rule) === ruleKey(found.repeat)));
    if (already || (showing && showing.key === found.key)) return null;
    question(found, id);
    return found;
  }

  const askButton = (text, kind, onClick, extraClass = '') => V.h('button.ask-btn.keep-caret' + (kind ? '.' + kind : '') + extraClass, {
    type: 'button', onclick: onClick,
  }, text);

  function question(found, id) {
    const when = found.repeat ? `${repeatText(found.repeat)} · ${nextWords(found.date, found.time ? found.at : null)}` : label(found);
    showing = { id, key: found.key, kind: 'question' };
    V.editor.ask(V.h('div.ask-card', { role: 'group', 'aria-label': `${when}: set a reminder?` },
      V.h('div.ask-top', {}, icon(found.repeat ? 'repeat' : 'bell', 'ask-icon'),
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
      if (kind === 'remind' || kind === 'due') {
        note.due = found.date;
        note.done = false;
        // A repeat said in the words (or none: a one-off date typed over a repeating one ends it).
        if (found.repeat) extra.repeat = { ...found.repeat };
        else delete extra.repeat;
      }
      if (kind === 'remind') extra.remind_at = found.at.toISOString();
      else if (kind === 'due' && found.repeat) delete extra.remind_at;  // (a repeating due date: no old time moving with it)
      note.extra = extra;
    });
    const note = V.editor.current();
    if (kind === 'due') V.toast(found.repeat ? `${repeatText(found.repeat)}: next due ${dayLabel(found.date)}` : `Due ${dayLabel(found.date)}`);
    else if (kind === 'never') V.toast('Wefty won\'t ask about dates in this note.');
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
    const when = found.repeat ? `${repeatText(found.repeat)}, ${nextWords(found.date, found.at)}` : dayLabel(found.date) + ' ' + clock(found.at);
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
      canNotify ? V.h('p.ask-line', { text: 'Wefty can also show a notification at that time while it\'s open.' }) : null,
      V.h('div.ask-actions', {},
        opened ? null : askButton('Open Google Calendar', 'primary', () => openOutside(calendarLink(latest(id) || note, found.at))),
        askButton('Download .ics instead', '', () => downloadIcs(latest(id) || note, found.at)),
        canNotify ? askButton('Allow notifications', opened ? 'primary' : '', async () => {
          setFlag(NOTIFY_ASKED);
          close();
          let answerGiven = 'default';
          try { answerGiven = await Notification.requestPermission(); } catch (error) { /* an old browser */ }
          V.toast(answerGiven === 'granted' ? 'Notifications on: Wefty pings you while it\'s open.'
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
        V.h('span.ask-text', { text: 'Wefty can also show a notification at that time while it\'s open.' }),
        V.h('button.ask-close.keep-caret', { type: 'button', title: 'Close', 'aria-label': 'Close', onclick: close }, V.icon('x'))),
      V.h('div.ask-actions', {},
        askButton('Allow notifications', 'primary', async () => {
          setFlag(NOTIFY_ASKED);
          close();
          let given = 'default';
          try { given = await Notification.requestPermission(); } catch (error) { /* an old browser */ }
          V.toast(given === 'granted' ? 'Notifications on: Wefty pings you while it\'s open.'
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

  /* The repeat choices in the sheet: [value, words]. A rule none of them is ("every 3 days") shows as itself. */
  const REPEAT_CHOICES = [['none', 'Doesn\'t repeat'], ['day', 'Every day'], ['weekday', 'Every weekday (Mon to Fri)'],
    ['week', 'Every week'], ['week2', 'Every 2 weeks'], ['month', 'Every month'], ['year', 'Every year']];
  function choiceOf(rule) {
    if (!rule) return 'none';
    if (rule.n === 1 && ['day', 'weekday', 'week', 'month', 'year'].includes(rule.every)) return rule.every;
    if (rule.every === 'week' && rule.n === 2) return 'week2';
    return 'kept';
  }

  /* The sheet the bell chip, the Upcoming list's day button and the Reminder tool open: the day, the reminder's time,
     whether it repeats (on which days of the week, until when), and the calendar. */
  function edit(id, { remind = null } = {}) {
    const note = latest(id);
    if (!note) return;
    const at = remindAt(note);
    const rule = repeatOf(note);
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
    const timeRow = V.h('div.remind-row', {}, V.h('label.remind-row-text', { for: switchId }, V.h('strong', { text: 'Remind me' }),
      V.h('span.hint', { text: 'On the day, at' })), time, on);

    // Repeat: how often, a week's days, and when it ends.
    const howOften = V.h('select.field.repeat-field', { 'aria-label': 'Repeat' },
      (choiceOf(rule) === 'kept' ? [['kept', repeatText(rule)]] : []).concat(REPEAT_CHOICES)
        .map(([value, text]) => V.h('option', { value, text })));
    howOften.value = choiceOf(rule);
    let days = rule && rule.every === 'week' ? [...rule.days] : null;  // (null: the picked day's, following it)
    const weekDays = () => days || (day.value ? [fromDay(day.value).getDay()] : [weekday]);
    const dayButtons = [1, 2, 3, 4, 5, 6, 0].map((d) => V.h('button.repeat-day', { type: 'button', dataset: { day: String(d) },
      'aria-label': WEEKDAY_NAMES[d], onclick: () => {
        const now = weekDays();
        const next = now.includes(d) ? now.filter((x) => x !== d) : [...now, d];
        if (next.length) days = next.sort((a, b) => a - b);
        showRepeat();
      } }, SHORT_DAYS[d].slice(0, 2)));
    const daysRow = V.h('div.repeat-days', { role: 'group', 'aria-label': 'On these days' }, dayButtons);
    const ends = V.h('select.field.repeat-ends', { 'aria-label': 'Ends' },
      V.h('option', { value: 'never', text: 'Never' }), V.h('option', { value: 'on', text: 'On a day' }));
    ends.value = rule && rule.until ? 'on' : 'never';
    const lastDay = V.h('input.field.repeat-until', { type: 'date', 'aria-label': 'Last day', value: (rule && rule.until) || '' });
    const endRow = V.h('div.repeat-end', {}, V.h('label.label', {}, 'Ends', ends), lastDay);
    const repeatSays = V.h('p.hint.repeat-says', { 'aria-live': 'polite' });
    const chosenRule = () => {
      const value = howOften.value;
      if (value === 'none') return null;
      const made = value === 'kept' ? { ...rule } : value === 'week' || value === 'week2'
        ? { every: 'week', n: value === 'week2' ? 2 : 1, days: weekDays() } : { every: value, n: 1 };
      delete made.until;
      delete made.last;
      if (value !== 'kept') delete made.start;
      if (ends.value === 'on' && lastDay.value) made.until = lastDay.value;
      return made;
    };
    function showRepeat() {
      const value = howOften.value;
      daysRow.hidden = !(value === 'week' || value === 'week2');
      endRow.hidden = value === 'none';
      lastDay.hidden = ends.value !== 'on';
      const picked = weekDays();
      dayButtons.forEach((b) => b.setAttribute('aria-pressed', String(picked.includes(Number(b.dataset.day)))));
      const made = chosenRule();
      repeatSays.textContent = made ? repeatText({ ...made, start: (value === 'kept' && rule.start) || day.value || today }) : '';
      repeatSays.hidden = !made;
    }
    howOften.addEventListener('change', showRepeat);
    ends.addEventListener('change', () => {
      if (ends.value === 'on' && !lastDay.value && day.value) lastDay.value = V.addDays(day.value, 28);
      showRepeat();
    });
    lastDay.addEventListener('change', showRepeat);
    day.addEventListener('change', showRepeat);
    const pick = (value) => { day.value = value; showRepeat(); };

    const chosen = () => {
      if (!day.value) { error.textContent = 'Pick a day.'; return null; }
      const when = on.checked ? new Date(`${day.value}T${time.value || '09:00'}`) : null;
      if (when && Number.isNaN(when.getTime())) { error.textContent = 'Pick a time.'; return null; }
      const repeat = chosenRule();
      if (repeat && ends.value === 'on' && !lastDay.value) { error.textContent = 'Pick the last day, or Never.'; return null; }
      if (repeat && repeat.until && repeat.until < day.value) { error.textContent = 'The last day is before the first one.'; return null; }
      return { day: day.value, when, repeat };
    };
    const apply = (picked) => set(id, { due: picked.day, at: picked.when, repeat: picked.repeat });
    const outside = (how) => async () => {
      if (!on.checked) { on.checked = true; showTime(); }  // a calendar event is a reminder: at the time shown
      const picked = chosen();
      if (!picked) return;
      try {
        await apply(picked);
      } catch (problem) {
        error.textContent = problem.message;
        return;
      }
      const row = latest(id);
      const when = remindAt(row) || picked.when;
      if (how === 'google') openOutside(calendarLink(row, when));
      else downloadIcs(row, when);
    };
    showTime();
    showRepeat();
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
        V.h('div.repeat-box', {}, V.h('label.label', {}, V.h('span.repeat-label', {}, icon('repeat'), V.h('span', { text: 'Repeat' })), howOften),
          daysRow, endRow, repeatSays),
        error,
        V.h('p.hint.remind-hint', { text: 'Wefty reminds you while it\'s open. To have your phone ring even when it isn\'t, add it to your calendar:' }),
        V.h('div.remind-outside', {},
          V.button('Google Calendar', { icon: 'calendar', onClick: outside('google') }),
          V.button('Download .ics', { icon: 'download', onClick: outside('ics') })),
      ],
      actions: [
        rule ? { label: 'Stop repeating', kind: 'danger-quiet', onClick: () => {
          set(id, { repeat: null }).then(() => V.toast('It doesn\'t repeat any more.')).catch(V.problem);
        } } : null,
        at ? { label: 'Remove reminder', kind: 'danger-quiet', onClick: () => {
          change(id, (row) => { delete row.extra.remind_at; });
          V.toast('Reminder removed');
        } } : null,
        { label: 'Save', kind: 'primary', onClick: () => {
          const picked = chosen();
          if (!picked) return true;
          apply(picked).then((saved) => {
            const when = saved.remind_at ? new Date(saved.remind_at) : null;
            V.toast(saved.repeat ? `${repeatText(saved.repeat)} · ${nextWords(saved.due || dayText(when), when)}`
              : picked.when ? `Reminder: ${dayLabel(picked.day)} ${clock(picked.when)}` : `Due ${dayLabel(picked.day)}`);
          }).catch((problem) => V.toast(problem.message || 'That didn\'t save.'));
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
    const line = repeatLine(note);
    if (line) {  // "Every Tue · next Tue 6:00 PM" (a repeating due date alone too)
      return V.h('button.chip.remind-chip.remind-repeat', {
        type: 'button', title: 'Repeats: change it, or stop it', onclick: () => edit(note.id),
      }, icon('repeat'), V.h('span', { text: line }));
    }
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
    const rule = !note.done && repeatOf(note);
    if (rule && !at) return V.h('span.due.remind.repeats', { title: repeatLine(note) }, icon('repeat'), repeatText(rule));
    if (!at || note.done) return null;
    return V.h('span.due.remind' + (at < new Date() ? '.late' : '') + (rule ? '.repeats' : ''), { title: rule ? repeatLine(note) : 'Reminder' },
      icon('bell'), remindLabel(note), rule ? icon('repeat', 'repeat-mark-icon') : null);
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
    // A repeating one isn't done for good: it moves on to its next one (and says when), with an Undo.
    if (!note.done && upNext(note)) { doneOnce(id).catch(V.problem); return; }
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
        const repeats = !note.done && !!repeatOf(note);
        return V.h('div.up-row' + (note.done ? '.done' : '') + (repeats ? '.repeats' : ''), { dataset: { id: note.id } },
          V.h('button.up-tick', { type: 'button', 'aria-pressed': String(!!note.done),
            'aria-label': note.done ? `${V.noteTitle(note)}: not done` : `${V.noteTitle(note)}: mark done`,
            onclick: () => toggleDone(note.id) }, V.icon('check')),
          make(note),
          V.h('button.up-when' + (days < 0 && !note.done ? '.late' : ''), { type: 'button', title: 'Move it, or change its reminder',
            'aria-label': `When: ${when}${repeats ? `. ${repeatLine(note, now)}` : ''}. Change it`, onclick: () => edit(note.id),
            title: repeats ? repeatLine(note, now) : null },
          icon(repeats ? 'repeat' : at && !note.done ? 'bell' : 'calendar'), V.h('span', { text: when })));
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
      data: { url: noteLink(note.id), id: note.id }, icon: 'icons/wefty-192.png', badge: 'icons/wefty-mono-512.png' }))
      .catch(() => {});
  }

  /* Repeating notes are moved on only once this device's copy is the cloud's (not mid-sync, when an older copy here
     could move on what another device already changed); offline, they're moved on here and merged when back. */
  const canMove = () => !V.cloud || (V.cloud.status !== 'syncing' && V.cloud.status !== 'idle');

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!V.data || !V.data.notes) return;
    const now = Date.now();
    const said = new Set(seen());
    let next = Infinity;
    const passed = [];
    for (const note of V.data.notes.values()) {
      if (note.deleted || note._purge || note.done || V.organise.isTemplate(note) || V.organise.isArchived(note)) continue;
      const rule = repeatOf(note);
      // A repeating one that went by while this device wasn't looking (moved on elsewhere): said once, as missed.
      if (rule && rule.last && rule.last !== (note.extra && note.extra.remind_at)) {
        const was = new Date(rule.last);
        const key = `${note.id}|${rule.last}`;
        if (now - was.getTime() >= 0 && now - was.getTime() < MISSED_HOURS * 3600000 && !said.has(key)) {
          markSeen(key);
          said.add(key);
          ring(note, was, now - was.getTime() > 2 * 60000);
        }
      }
      if (rule && hasPassed(note, new Date(now))) passed.push(note);
      if (rule && !remindAt(note)) next = Math.min(next, plusDays(midnight(new Date(now)), 1).getTime() + 1000);  // (a due date alone: at midnight)
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
    // Gone by: on to the next one (one missed reminder said at most, above; never a pile of them).
    if (passed.length && canMove()) {
      for (const note of passed) {
        const here = occurrence(note);
        moveOn(note.id, { from: here.key, why: 'passed', now: new Date(now) }).catch((error) => console.error('Wefty: moving a repeating note on:', error));
      }
    }
    if (next < Infinity) timer = setTimeout(schedule, Math.min(Math.max(next - now + 50, 50), 2 ** 31 - 1));
  }
  const scheduleSoon = V.debounce(schedule, 300);
  V.on('data', (table) => { if (table === 'notes') scheduleSoon(); });
  V.on('back', scheduleSoon);
  V.on('status', (value) => { if (value !== 'syncing') scheduleSoon(); });

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
      if (ready) V.toast('That note isn\'t in Wefty on this device.');
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
    cardChip, inUpcoming, pending, group, groupOf, toggleDone, upcoming, schedule, notify, icon, change, latest, openNote,
    // repeating (1.16.1)
    set, setRepeat, repeatOf, cleanRule, repeatText, repeatLine, nextWords, occurrence, upNext, hasPassed, moveOn, putBack,
    doneOnce, fits, nextAfter, rrule, ruleKey };
  return api;
})();
