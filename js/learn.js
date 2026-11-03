/* Vault: Learn mode (like Quizlet's Learn), from the study screen's ⋯ (1.18: "Learn: quiz me", for the cards being
   studied; js/review.js), a note's cards, a folder, a #tag or everything. The cards go in sets of seven, each set
   through its rounds: pick the answer out of four, then true or false, then type it, with a stop between sets. A
   miss comes back at the end of its round (twice at most: then it goes on, and comes back for review tomorrow). It
   all feeds each card's schedule (js/review.js): a miss anywhere counts as "Still learning", a right answer in the
   card's last round as "I know it", saved in batches like the cards'. All on this device: no AI, no internet needed.

   1.19.1 (the owner: "Some of the answers on test mode does not work properly", and AI-made cards that do "stupid
   things"). Each card gets the rounds that suit its answer:
   - a long answer (more than six words, a formula with √ or ±...) is never typed: it's picked and judged only;
   - a card with nothing to choose between (no other answer like it anywhere) is typed only, and one that can't be
     typed either is a "Do you know it?" (show the answer, then I knew it / Not yet).
   Typing forgives what a teacher would: capitals, accents, punctuation, spaces, a typo or two (more in a longer
   answer), "the"/"a"/"to"/"in"/"about" in front, a list in any order ("gas, solid and liquid"), a date either way
   round, numbers written as words ("six", "one hundred sixteen"), 1,000 / 0,5 / .5 / 1/2 / ½, π as pi, ² as ^2, a
   unit left off ("116" for "116 years"), the name in brackets or without them ("N" or "newton" for "The newton
   (N)"), any one of "to speak / to talk" or "tomorrow; morning", the surname alone for a "Who...?", and an answer's
   explanation after " — " (only the part before it is asked for). Never a different number, nor another card's own
   answer (typing "hypotonic" for "hypertonic" is a real mistake, however close the letters).
   The wrong choices (and true or false's claims) are other cards' answers like this one: the deck's own first, the
   same kind (a year for a year, a word for a word, a formula for a formula) and a similar length, never one that's
   also right (the same answer in other words, "In 1914" for "1914"), never one inside the question or the
   right answer, never the answer of a card asking the same thing, never twice. True or false is only asked when a
   claim like that exists, so it's never "false" for something true. The same card written twice (in two notes) is
   asked once, and answered for both. */
'use strict';

V.learn = (() => {
  const RV = V.review;
  const GROUP = 7;
  const KINDS = ['choice', 'truth', 'type', 'recall'];
  const TITLES = { choice: 'Pick the answer', truth: 'True or false?', type: 'Type the answer', recall: 'Do you know it?' };
  const TYPE_WORDS = 6;      // an answer longer than this is never typed (each "a / b" alternative counted alone)
  const TYPE_LETTERS = 40;
  const TRIES = 2;           // a card missed this many times in one round goes on to the next (no endless rounds)
  const HARD = /[±√∑∫≈≠≤≥∞∆∂⇌→∝]/;      // signs a phone's keyboard hasn't got: picked, never typed
  const FORMULA = /[=±√∑∫≈≠≤≥∞∆∂⇌→∝]/;

  /* -- reading an answer */

  /* Words as compared before 1.19.1 (still what `distance` and the slack are worked on): no accents, capitals or
     punctuation, and no "the", "a" or "an" in front. */
  const fold = (text) => String(text || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^(?:the|a|an) (?=\S)/, '');
  /* How many typos an answer forgives: none up to 3 letters, 1 up to 7, 2 up to 14, then one in every 7. */
  const slack = (length) => (length <= 3 ? 0 : length <= 7 ? 1 : length <= 14 ? 2 : Math.floor(length / 7));

  /* Letters to change, add, take away or swap round ("teh") to turn a into b (past `most` it stops counting). */
  function distance(a, b, most = Infinity) {
    if (Math.abs(a.length - b.length) > most) return most + 1;
    let older = null;
    let before = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      let least = i;
      for (let j = 1; j <= b.length; j++) {
        row[j] = Math.min(before[j] + 1, row[j - 1] + 1, before[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (older && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], older[j - 2] + 1);
        least = Math.min(least, row[j]);
      }
      if (least > most) return most + 1;
      older = before;
      before = row;
    }
    return before[b.length];
  }

  /* A card's words as shown: no marks, `code` ticks, braces or a "Q:"/"A:" label left by the AI. */
  function plain(text) {
    let s = String(text || '');
    if (V.format && V.format.unmark) s = V.format.unmark(s);
    s = s.replace(/`([^`]*)`/g, '$1').replace(/\{\{\s*([^{}]*?)\s*\}\}/g, '$1')
      .replace(/^\s*(?:q|a|question|answer|front|back|term|definition)\s*:\s+(?=\S)/i, '')
      .replace(/^(\*\*|__)(.+)\1$/, '$2').replace(/\s+/g, ' ').trim();
    return s;
  }

  /* An answer's own part: before " — " (the AI's explanation after it is shown, never asked for), without the full
     stop at the end of a short one. "Ribosomes — they build proteins." -> "Ribosomes". */
  function face(answer) {
    const all = plain(answer);
    const cut = /\s+[—–]\s+/.exec(all);
    let core = all;
    if (cut && cut.index > 0 && !(/\d$/.test(all.slice(0, cut.index)) && /^\d/.test(all.slice(cut.index + cut[0].length)))) {
      core = all.slice(0, cut.index).trim();
    }
    if (!/[.!?].*\s\S/.test(core.slice(0, -1))) core = core.replace(/(?<![A-Z]|\b(?:etc|vs|approx|[a-z]))\.$/, '');
    return core || all;
  }

  /* "to speak / to talk" or "tomorrow; morning": the right answers it lists (a formula is never cut up). */
  function alternatives(core) {
    if (FORMULA.test(core)) return [core];
    // (three or more pieces between ";" are a list, not answers to pick from)
    const semi = core.split(/\s*;\s*/).filter((s) => s.trim());
    const pieces = semi.length === 2 ? semi : [core];
    const out = pieces.flatMap((piece) => piece.split(/\s+\/\s+|(?<=\p{L}{2})\/(?=\p{L}{2})/u)).map((s) => s.trim()).filter(Boolean);
    return out.length ? out : [core];
  }

  const table = (list) => new Map(Object.entries(list));  // (a Map: "constructor" is never a number)
  const ONES = table({ zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
  const SCALE = table({ hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 });
  const ROMAN = table({ ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15,
    xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20 });
  const MONTHS = table({ jan: 'jan', january: 'jan', feb: 'feb', february: 'feb', mar: 'mar', march: 'mar', apr: 'apr',
    april: 'apr', may: 'may', jun: 'jun', june: 'jun', jul: 'jul', july: 'jul', aug: 'aug', august: 'aug', sep: 'sep',
    sept: 'sep', september: 'sep', oct: 'oct', october: 'oct', nov: 'nov', november: 'nov', dec: 'dec', december: 'dec' });
  const STRICT_LEAD = new Set(['the', 'a', 'an']);
  const LOOSE_LEAD = new Set(['the', 'a', 'an', 'to', 'in', 'on', 'at', 'about', 'around', 'approximately', 'roughly',
    'circa', 'c', 'el', 'la', 'los', 'las', 'un', 'una', 'le', 'les', 'l']);
  const QUIET_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'on', 'is', 'are', 'for', 'with', 'what',
    'which', 'who', 'when', 'where', 'how', 'why', 'does', 'do', 'did', 'was', 'were', 'el', 'la', 'de', 'que']);
  const number = (n) => String(Math.round(n * 1e6) / 1e6);

  /* An answer as tokens to compare: accents, capitals and punctuation gone, numbers in one form ("Six" and "6",
     "1,000" and "1000", ".5", "0,5", "1/2" and "0.5", "21st" and "21", "War II" and "War 2"), π as "pi", ² as "2". */
  const remembered = new Map();  // (words read lately: Learn compares the same answers again and again)
  function tokens(text) {
    const key = String(text || '');
    const kept = remembered.get(key);
    if (kept) return kept;
    const out = tokenize(key);
    if (remembered.size > 4000) remembered.clear();
    remembered.set(key, out);
    return out;
  }
  function tokenize(text) {
    let s = String(text || '').replace(/π/g, ' pi ').replace(/²/g, '^2').replace(/³/g, '^3').replace(/½/g, ' 1/2')
      .replace(/¼/g, ' 1/4').replace(/¾/g, ' 3/4').replace(/×/g, ' x ').replace(/[·•]/g, ' ')
      .normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
    s = s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1')            // 1,000 -> 1000
      .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2')              // 0,5 -> 0.5 (a decimal comma)
      .replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1')               // 21st -> 21
      .replace(/(^|[^\d/.])(\d{1,3})\s?\/\s?(\d{1,3})(?![\d/])/g, (m, pre, a, b) => (Number(b) ? `${pre} ${number(Number(a) / Number(b))} ` : m))
      .replace(/(^|[\s(])-(?=\d)/g, '$1\u0002')               // a minus sign stays with its number
      .replace(/(\d)\.(?=\d)/g, '$1\u0001').replace(/(^|[^\d])\.(?=\d)/g, '$1 0\u0001')
      .replace(/[^\p{L}\p{N}\u0001\u0002]+/gu, ' ').replace(/\u0001/g, '.').replace(/\u0002/g, '-').trim();
    const raw = s ? s.split(' ') : [];
    const out = [];
    let run = null;
    const flush = () => { if (run) out.push(number(run.total + run.now)); run = null; };
    raw.forEach((t, i) => {
      if (ONES.has(t)) { run = run || { total: 0, now: 0 }; run.now += ONES.get(t); return; }
      if (SCALE.has(t) && run) {
        if (SCALE.get(t) === 100) run.now *= 100; else { run.total += run.now * SCALE.get(t); run.now = 0; }
        return;
      }
      if (t === 'and' && run && ONES.has(raw[i + 1])) return;
      flush();
      if (ROMAN.has(t)) out.push(String(ROMAN.get(t)));
      else if (t === 'i' && raw[i - 1] === 'war') out.push('1');
      else if (/^-?\d+(?:\.\d+)?$/.test(t)) out.push(number(Number(t)));
      else out.push(t);
    });
    flush();
    return out;
  }
  const lead = (list, words) => { const out = [...list]; while (out.length > 1 && words.has(out[0])) out.shift(); return out; };
  const numbersIn = (list) => list.join(' ').match(/-?\d+(?:\.\d+)?/g) || [];
  const sorted = (list) => [...list].sort().join(' ');

  /* Whether two token lists say the same, forgiving typos by the slack (never a number). */
  function near(a, b) {
    if (a.join(' ') === b.join(' ')) return true;
    if (numbersIn(a).join(' ') !== numbersIn(b).join(' ')) return false;
    const x = a.join('');
    const y = b.join('');
    if (!x || !y) return false;
    const most = slack(y.length);
    return distance(x, y, most) <= most;
  }

  /* A list's items, as written: "Solid, liquid and gas" -> Solid / liquid / gas (a formula or a number is never a list). */
  const ITEMS = /\s*[,;]\s*(?:and\s+|&\s*)?|\s+(?:and|&)\s+|\s*&\s*/i;
  const itemsOf = (text) => (FORMULA.test(text) ? [text] : String(text).split(ITEMS).map((s) => s.trim()).filter(Boolean));

  /* Whether typed words say a form of the answer, in order or (a list, a date) in any order. */
  function says(typed, form, leadWords) {
    const t = lead(tokens(typed), leadWords);
    const f = lead(tokens(form), leadWords);
    if (!t.length || !f.length) return false;
    if (near(t, f)) return true;
    const items = itemsOf(form);
    if (items.length > 1) {
      const mine = itemsOf(typed);
      if (mine.length === items.length) {
        const left = items.map((item) => lead(tokens(item), leadWords));
        const all = mine.every((piece) => {
          const p = lead(tokens(piece), leadWords);
          const at = left.findIndex((item) => item && near(p, item));
          if (at < 0) return false;
          left[at] = null;
          return true;
        });
        if (all) return true;
      }
      const loose = (list) => sorted(list.filter((x) => x !== 'and'));
      if (loose(t) === loose(f)) return true;
    }
    // A date either way round: "28 June 1919" for "June 28, 1919".
    const month = (list) => list.map((x) => MONTHS.get(x) || x);
    if (f.some((x) => MONTHS.has(x)) && numbersIn(f).length && sorted(month(t)) === sorted(month(f))) return true;
    return false;
  }

  /* What can be typed for an answer: each alternative as written, then (`loose`: right, though not as written) without
     its brackets, what's in its brackets (a word or two), its number without the unit, the surname for a "Who...?". */
  function forms(answer, question = '') {
    const out = [];
    const add = (text, loose) => {
      const t = String(text || '').replace(/\s+/g, ' ').trim();
      if (t && !out.some((f) => f.text === t)) out.push({ text: t, loose });
    };
    const core = face(answer);
    const alts = alternatives(core);
    if (alts.length > 1) add(core, false);  // (all of it, as written, is right too)
    for (const alt of alts) {
      add(alt, false);
      const bare = alt.replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
      if (bare !== alt) add(bare, true);
      for (const m of alt.matchAll(/\(([^()]+)\)/g)) if (m[1].trim().split(/\s+/).length <= 2) add(m[1], true);
      const unit = /^(?:(?:about|around|approximately|roughly|in|c\.?)\s+)?(-?\d[\d.,]*)\s*[\p{L}°%µ][^\d]{0,14}$/iu.exec(bare);
      if (unit) add(unit[1], true);
      const names = bare.split(/\s+/);
      if (/^\s*(?:who|whom)\b/i.test(question) && names.length >= 2 && names.length <= 4 && names.every((n) => /^\p{Lu}/u.test(n))) {
        const last = names[names.length - 1];
        if (last.replace(/\P{L}/gu, '').length >= 3) add(last, true);
      }
    }
    return out;
  }

  /* Whether `typed` says `answer`: { right, typo (right, but not as written: the feedback shows how it's written) }.
     `question`: the card's (a "Who...?" takes the surname); `others`: the deck's other answers (typing one of them is
     never right, however close its letters are to this one). */
  function check(typed, answer, { question = '', others = [] } = {}) {
    const said = String(typed || '').trim();
    const all = forms(answer, question);
    if (!said || !all.length || !lead(tokens(said), STRICT_LEAD).length) return { right: false, typo: false };
    const mine = lead(tokens(said), STRICT_LEAD).join(' ');
    const exact = all.some((f) => lead(tokens(f.text), STRICT_LEAD).join(' ') === mine);
    // (another card's answer, unless it's this one's in other words: "In 1914" beside "1914")
    const same = (a, b) => { const x = lead(tokens(a), LOOSE_LEAD); const y = lead(tokens(b), LOOSE_LEAD); return sorted(x) === sorted(y); };
    if (!exact && others.some((other) => other && alternatives(face(other)).some((alt) => lead(tokens(alt), STRICT_LEAD).join(' ') === mine)
      && !all.some((f) => same(face(other), f.text)))) return { right: false, typo: false };
    for (const f of all) {
      if (!f.loose && says(said, f.text, STRICT_LEAD)) {
        const asWritten = lead(tokens(said), STRICT_LEAD).join('') === lead(tokens(f.text), STRICT_LEAD).join('');
        return { right: true, typo: !asWritten, written: f.text };
      }
    }
    for (const f of all) {
      if ((f.loose && says(said, f.text, STRICT_LEAD)) || says(said, f.text, LOOSE_LEAD)) return { right: true, typo: true, written: face(answer) };
    }
    return { right: false, typo: false };
  }

  /* -- what kind of answer it is, for wrong choices like it */

  const YEAR_WORDS = new Set(['in', 'about', 'around', 'c', 'circa', 'ad', 'bc', 'bce', 'ce']);
  const JOINS = new Set(['and', 'of', 'the', 'de', 'del', 'la', 'von', 'van', 'da', 'du', 'le', 'y', '&']);
  /* What kind of answer it is (its first alternative, without brackets): a formula, a date, a year, a number, a
     name ("William Shakespeare": two or more words with capitals), a word, a phrase (two to four words) or long. */
  function shapeOf(answer) {
    const core = face(answer);
    if (FORMULA.test(core)) return 'formula';
    const first = alternatives(core)[0].replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim() || core;
    const t = tokens(first);
    const nums = t.filter((x) => /^-?\d+(?:\.\d+)?$/.test(x));
    const rest = t.filter((x) => !/^-?\d+(?:\.\d+)?$/.test(x));
    if (nums.length && t.some((x) => MONTHS.has(x))) return 'date';
    if (nums.length && rest.length <= Math.max(2, nums.length)) {
      return nums.length === 1 && /^\d{3,4}$/.test(nums[0]) && rest.every((x) => YEAR_WORDS.has(x)) ? 'year' : 'number';
    }
    const words = first.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 5 && /^\p{Lu}/u.test(words[words.length - 1])
      && words.every((w) => /^\p{Lu}/u.test(w) || JOINS.has(w.toLowerCase()))) return 'name';
    return words.length <= 1 ? 'word' : words.length <= 4 ? 'phrase' : 'long';
  }
  const NEAR = { word: ['phrase', 'name'], phrase: ['word', 'long'], long: ['phrase'], name: ['word'],
    year: ['number', 'date'], number: ['year'], date: ['year'], formula: [] };
  const ES = /[ñáéíóúü¿¡]|^(?:el|la|los|las|un|una|unos|unas)\s/i;
  const EN = /^(?:the|a|an|to)\s/i;
  const langOf = (text) => (ES.test(text) ? 'es' : EN.test(text) ? 'en' : '');

  /* A card's answer, read once a session. */
  function readCard(card) {
    const shown = face(card.answer);
    const question = card.kind === 'blank' ? `${card.before || ''} ${card.after || ''}` : card.term;
    const content = (text) => new Set(tokens(text).filter((x) => !QUIET_WORDS.has(x)));
    const alts = alternatives(shown);
    return {
      shown, alts, shape: shapeOf(card.answer), lang: langOf(shown), length: shown.length,
      key: lead(tokens(shown), STRICT_LEAD).join(' '),
      forms: forms(card.answer, card.term),
      words: content(shown),
      question: ` ${tokens(question).join(' ')} `,
      asks: content(card.kind === 'blank' ? question : card.term),
      typeable: !HARD.test(shown) && alts.every((alt) => {
        const bare = alt.replace(/\s*\([^)]*\)/g, ' ').trim();
        return bare.split(/\s+/).filter(Boolean).length <= TYPE_WORDS && bare.replace(/\s/g, '').length <= TYPE_LETTERS;
      }),
    };
  }

  /* Whether two answers say the same thing (so one can never be the other's wrong choice): the same words in any order
     ("In 1914" and "1914", "gas and solid" and "solid and gas"), one letter apart at most ("ribosome", "Ribosomes"),
     or one of them in the other's brackets, unit or alternatives. Never two answers a typo apart only by the slack
     typing allows ("hypotonic" and "hypertonic" are each other's best wrong choice). */
  function sameWords(a, b) {
    const x = lead(tokens(a), LOOSE_LEAD).filter((w) => w !== 'and');
    const y = lead(tokens(b), LOOSE_LEAD).filter((w) => w !== 'and');
    if (!x.length || !y.length) return false;
    if (sorted(x) === sorted(y)) return true;
    if (numbersIn(x).join(' ') !== numbersIn(y).join(' ')) return false;
    const p = x.join('');
    const q = y.join('');
    return Math.min(p.length, q.length) >= 5 && distance(p, q, 1) <= 1;
  }
  function alike(ra, rb) {
    if (!ra.key || !rb.key || ra.key === rb.key) return true;
    return rb.alts.some((alt) => ra.forms.some((f) => sameWords(alt, f.text)))
      || ra.alts.some((alt) => rb.forms.some((f) => sameWords(alt, f.text)));
  }
  const within = (small, big) => small.size > 0 && [...small].every((x) => big.has(x));
  const overlap = (a, b) => { const both = [...a].filter((x) => b.has(x)).length; return both / (new Set([...a, ...b]).size || 1); };

  /* The wrong answers for `card`, best first: [{ text, tier }] (tier 1: the deck's, the same kind; 2: the deck's, a
     kind near it; 3 and 4 the same from other notes; 5 and 6 any other). `read` reads a card (cached by the session). */
  function wrongFor(card, deck, count = 3, read = readCard, elsewhere = null) {
    const me = read(card);
    const inDeck = new Set(deck.map((c) => c.id));
    const pool = [...deck.filter((c) => c.id !== card.id), ...(elsewhere || RV.all()).filter((c) => !inDeck.has(c.id))];
    const found = [];
    for (const other of pool) {
      if (!other.answer) continue;
      const it = read(other);
      if (!it.key || it.key === me.key) continue;
      if (me.question.includes(` ${it.key} `)) continue;                            // in the question: a give-away
      if (within(it.words, me.words) || within(me.words, it.words)) continue;      // part of the right answer, or holds it
      if (me.asks.size && it.asks.size && (overlap(me.asks, it.asks) >= 0.7)) continue;  // a card asking the same thing
      if (alike(me, it)) continue;                                                  // the same answer in other words
      const mine = inDeck.has(other.id);
      const kind = it.shape === me.shape ? 0 : (NEAR[me.shape] || []).includes(it.shape) ? 1 : 2;
      const tier = kind === 2 ? (mine ? 5 : 6) : (mine ? 1 : 3) + kind;
      const lang = me.lang && it.lang ? (me.lang === it.lang ? 0 : 1) : 0.5;
      const size = Math.abs(Math.log((it.length + 3) / (me.length + 3)));
      // One that says the question's own subject ("A positively charged ion" for "What is an ion?") is a poor choice,
      // and never a true-or-false claim.
      const echo = [...me.asks].some((w) => it.words.has(w));
      found.push({ text: it.shown, key: it.key, other, tier: echo ? Math.max(tier, 5) : tier,
        rank: tier * 10 + (echo ? 5 : 0) + lang * 2 + size + Math.random() * 0.6 });
    }
    found.sort((a, b) => a.rank - b.rank);
    const out = [];
    for (const f of found) {
      if (out.length >= count) break;
      if (out.some((o) => o.key === f.key || alike(read(o.other), read(f.other)))) continue;
      out.push(f);
    }
    return out.map(({ text, tier, other }) => ({ text, tier, other }));
  }

  /* Up to `count` wrong answers' words (the deck's own first, then other notes'). */
  const wrongOnes = (card, deck, count = 3) => wrongFor(card, deck, count).map((w) => w.text);

  /* -- a session */

  /* A note's cards, as they're written now. */
  function forNote(id) {
    const row = V.data.notes.get(id);
    if (!row) return null;
    const words = V.editor.openId() === id && V.editor.words() !== null ? V.editor.words() : row.body;
    const list = RV.cardsOf(row, words);
    if (!list.length) return V.toast('Write cards as "term :: definition" (or "The {{word}} in a sentence"), then press Study.');
    return start({ title: V.noteTitle({ ...row, body: words || '' }) + ': learn', list, deck: 'note:' + id });
  }

  /* A deck's cards (js/review.js's decks), the ones due first. */
  function forDeck(deck = 'all') {
    const at = RV.now();
    const list = at.list.filter(RV.inDeck(deck));
    if (!list.length) return V.toast('No flash cards there yet.');
    const due = (c) => (RV.isDue(c, at) ? 0 : 1);
    list.sort((a, b) => due(a) - due(b) || (a.note === b.note ? a.line - b.line : a.note.localeCompare(b.note)));
    return start({ title: deck === 'all' ? 'Learn' : `Learn: ${RV.deckName(deck)}`, list, deck });
  }

  /* Learn on the study screen (js/review.js: its own, or `view`, the one the cards were on, from their ⋯). Sets of
     seven, each through its rounds; between sets a stop: "Next set" or "Done for now". */
  function start({ title, list, deck = 'all', view = null }) {
    // The same card written twice (two notes, or twice in one) is asked once, and its answers count for both.
    const twins = new Map();
    const cards = [];
    const seen = new Map();
    for (const c of list) {
      const key = `${c.kind}|${fold(plain(c.term))}|${lead(tokens(face(c.answer)), STRICT_LEAD).join(' ')}`;
      if (seen.has(key)) { twins.get(seen.get(key)).push(c); continue; }
      seen.set(key, c.id);
      twins.set(c.id, [c]);
      cards.push(c);
    }
    if (!cards.length) return null;
    const scr = view && !view.closed() ? view : RV.screen(title);
    scr.setTitle(title);
    const readings = new Map();
    const read = (c) => {
      const key = c.id + '\u0000' + c.term + '\u0000' + c.answer;
      if (!readings.has(key)) readings.set(key, readCard(c));
      return readings.get(key);
    };
    let elsewhere = null;
    const others = () => elsewhere || (elsewhere = RV.all());
    const plans = new Map();   // card id -> the kinds of round it goes through
    function planOf(card) {
      if (plans.has(card.id)) return plans.get(card.id);
      const wrong = wrongFor(card, cards, 3, read, others());
      const kinds = [];
      if (wrong.length) kinds.push('choice');
      if (wrong.some((w) => w.tier <= 4)) kinds.push('truth');
      if (read(card).typeable) kinds.push('type');
      if (!kinds.length || (kinds.length === 1 && kinds[0] === 'choice')) kinds.push('recall');
      plans.set(card.id, kinds);
      return kinds;
    }
    const groups = [];
    for (let i = 0; i < cards.length; i += GROUP) groups.push(cards.slice(i, i + GROUP));
    let group = 0;
    let rounds = [];    // this set's kinds of round, in order
    let round = 0;
    let queue = [];
    let asked = null;   // { card, kind, options: [{ text, right }], claim, truth, shown }
    let answered = null; // after an answer: { right, typo, picked, written, first, last }
    let steps = 0;      // answers done in this set so far (each card counts once a round)
    let total = 0;
    let learned = 0;
    let after = null;    // what Continue does
    let wait = null;     // the timer that moves on after a right answer
    let live = true;     // (false once the screen has gone on to something else)
    const missed = new Set();
    const tries = new Map();   // card id -> misses in this round
    const many = new Set(cards.map((c) => c.note)).size > 1;  // cards from several notes say which one
    const ui = { body: V.h('div.learn-body') };
    const deckAnswers = (card) => cards.filter((c) => c.id !== card.id).map((c) => c.answer);
    const gradeAll = (card, rating) => { for (const twin of twins.get(card.id) || [card]) RV.grade(twin, rating); };

    function plan() {
      const set = groups[group];
      rounds = KINDS.filter((k) => set.some((c) => planOf(c).includes(k)));
      total = set.reduce((n, c) => n + planOf(c).length, 0);
    }

    function begin() {
      if (round === 0) { plan(); steps = 0; }
      const kind = rounds[round];
      queue = RV.shuffle(groups[group].filter((c) => planOf(c).includes(kind)));
      tries.clear();
      scr.ended(false);
      if (!ui.body.isConnected) { V.clear(scr.stage, ui.body); V.clear(scr.foot); }
      ask();
    }

    function ask() {
      clearTimeout(wait);
      answered = null;
      if (!queue.length) {
        if (round < rounds.length - 1) { round++; return begin(); }
        learned += groups[group].length;
        group++;
        round = 0;
        if (group < groups.length) return pause();
        return finish();
      }
      const card = queue[0];
      const kind = rounds[round];
      asked = { card, kind };
      if (kind === 'choice') {
        const wrong = wrongFor(card, cards, 3, read, others());
        asked.options = RV.shuffle([{ text: read(card).shown, right: true }, ...wrong.map((w) => ({ text: w.text, right: false }))]);
      }
      if (kind === 'truth') {
        const near_ = wrongFor(card, cards, 3, read, others()).filter((w) => w.tier <= 4);
        const wrong = near_.length ? near_[Math.floor(Math.random() * near_.length)] : null;
        asked.truth = !wrong || Math.random() < 0.5;
        asked.claim = asked.truth ? read(card).shown : wrong.text;
      }
      draw();
    }

    /* The question's own words: a blank's sentence with its gap (or, for true or false, with the answer to judge). */
    function prompt(card, claim = null) {
      // (reading text: Quick read's pieces go in when it's on, js/reading.js)
      if (card.kind !== 'blank') return [V.reading.area(V.h('span.learn-term', { text: plain(card.term) })),
        claim === null ? null : V.h('span.learn-claim', {}, V.h('span.learn-claim-label', { text: 'Answer' }), V.h('span', { text: claim }))];
      return V.reading.area(V.h('span.learn-term', {}, claim === null ? RV.question(card)
        : [card.before, V.h('mark.blank-fill', { text: claim }), card.after]));
    }

    function where() {
      const kind = rounds[round];
      scr.progress(`Round ${round + 1} of ${rounds.length} · ${TITLES[kind]}`, total ? steps / total : 0,
        groups.length > 1 ? `Set ${group + 1} of ${groups.length}` : '');
    }

    function draw() {
      if (!asked) return;
      where();
      scr.editable(true);
      const { card, kind } = asked;
      const row = V.data.notes.get(card.note);
      const from = many && row ? V.noteTitle(row) : '';
      const showing = kind === 'recall' && (answered || asked.shown);
      const head = V.h('div.learn-card', { dataset: { card: card.id, kind } }, from ? V.h('span.flash-side', { text: from }) : null,
        prompt(card, kind === 'truth' ? asked.claim : null),
        showing ? V.h('span.learn-claim.learn-reveal', {}, V.h('span.learn-claim-label', { text: 'Answer' }),
          V.reading.area(V.h('span', { text: plain(card.answer) }))) : null);
      let answer = null;
      if (kind === 'choice') {
        answer = V.h('div.learn-options', { role: 'group', 'aria-label': 'Choices' }, asked.options.map((option, i) => {
          const state = !answered ? '' : option.right ? '.right' : i === answered.picked ? '.wrong' : '.faded';
          return V.h('button.learn-option' + state, { type: 'button', disabled: !!answered, onclick: () => pick(i) },
            V.h('span.learn-key', { text: String(i + 1) }), V.reading.area(V.h('span.learn-option-text', { text: option.text })));
        }));
      } else if (kind === 'truth') {
        const mark = (value) => (!answered ? '' : value === asked.truth ? '.right' : value === answered.picked ? '.wrong' : '.faded');
        answer = V.h('div.learn-options.two', { role: 'group', 'aria-label': 'True or false' },
          V.h('button.learn-option' + mark(true), { type: 'button', disabled: !!answered, onclick: () => pick(true) },
            V.h('span.learn-key', { text: 'T' }), V.h('span.learn-option-text', { text: 'True' })),
          V.h('button.learn-option' + mark(false), { type: 'button', disabled: !!answered, onclick: () => pick(false) },
            V.h('span.learn-key', { text: 'F' }), V.h('span.learn-option-text', { text: 'False' })));
      } else if (kind === 'recall') {
        answer = answered ? null : !asked.shown
          ? V.h('div.learn-options.one', {}, V.button('Show the answer', { kind: 'primary', onClick: () => reveal() }))
          : V.h('div.learn-options.two', { role: 'group', 'aria-label': 'Did you know it?' },
            V.h('button.learn-option', { type: 'button', onclick: () => recalled(false) },
              V.h('span.learn-key', { text: '1' }), V.h('span.learn-option-text', { text: 'Not yet' })),
            V.h('button.learn-option', { type: 'button', onclick: () => recalled(true) },
              V.h('span.learn-key', { text: '2' }), V.h('span.learn-option-text', { text: 'I knew it' })));
      } else {
        const input = V.h('input.field.learn-input', { type: 'text', placeholder: 'Type the answer', 'aria-label': 'Your answer',
          autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done', disabled: !!answered,
          value: answered ? answered.picked : '' });
        if (answered) input.classList.add(answered.right ? 'right' : 'wrong');
        answer = V.h('form.learn-type', { onsubmit: (event) => { event.preventDefault(); if (!answered) typed(input.value); } },
          input, answered ? null : V.button('Check', { kind: 'primary', onClick: () => typed(input.value) }));
        if (!answered) requestAnimationFrame(() => { if (input.isConnected) input.focus({ preventScroll: true }); });
      }
      V.clear(ui.body, head, answer, feedback());
      const go = ui.body.querySelector('.learn-feedback .btn.primary, .learn-options .btn.primary');
      if (go) requestAnimationFrame(() => { if (go.isConnected) go.focus({ preventScroll: true }); });
    }

    function feedback() {
      if (!answered) return null;
      const { card, kind } = asked;
      const continueButton = V.button('Continue', { kind: 'primary', onClick: () => after && after() });
      const full = plain(card.answer);
      if (answered.right) {
        const said = answered.typo ? `Right! It's written "${answered.written || full}".` : 'Right!';
        return V.h('div.learn-feedback.ok', { role: 'status' }, V.icon('check'), V.h('span.learn-said', { text: said }),
          kind === 'type' ? continueButton : null);
      }
      const again = (tries.get(card.id) || 0) < TRIES;
      const word = kind === 'truth' ? (asked.truth ? 'It\'s true: the answer is right.' : `It's false: the answer is "${full}".`)
        : kind === 'recall' ? (again ? 'It comes round again at the end of this round.' : 'It comes back for review tomorrow.')
          : `The answer is "${full}".`;
      return V.h('div.learn-feedback.err', { role: 'status' }, V.icon('alert'),
        V.h('span.learn-said', {}, V.h('strong', { text: kind === 'type' ? 'Not quite. ' : kind === 'recall' ? 'Not yet. ' : 'Not this time. ' }), word),
        V.h('div.learn-feedback-actions', {},
          // (a card the AI got wrong is fixed right here: js/review.js editCard)
          V.button('Edit card', { kind: 'quiet', icon: 'edit', onClick: () => edit() }),
          kind === 'type' ? V.button('I was right', { kind: 'quiet', onClick: () => overrule() }) : null,
          continueButton));
    }

    const lastOf = (card) => { const kinds = planOf(card); return rounds[round] === kinds[kinds.length - 1]; };

    /* A right answer moves on by itself (the typed one when Continue is pressed); a wrong one when Continue is. */
    function right(typo = false, picked = null, written = '') {
      const card = queue.shift();
      steps++;
      answered = { right: true, typo, picked, written };
      if (lastOf(card)) gradeAll(card, RV.GOOD);
      after = ask;
      draw();
      if (asked.kind !== 'type') wait = setTimeout(() => { if (live && answered && answered.right) ask(); }, 650);
    }

    function wrong(picked) {
      const card = queue[0];
      const misses = (tries.get(card.id) || 0) + 1;
      tries.set(card.id, misses);
      answered = { right: false, picked, first: !missed.has(card.id) };
      missed.add(card.id);
      if (asked.kind !== 'type') gradeAll(card, RV.AGAIN);
      after = () => {
        if (asked.kind === 'type') gradeAll(card, RV.AGAIN);
        queue.shift();
        // It comes back at the end of this round; missed again, it goes on (it's back for review tomorrow).
        if (misses < TRIES) queue.push(card); else steps++;
        ask();
      };
      draw();
    }

    function pick(option) {
      if (answered || !asked) return;
      if (V.streak) V.streak.studied(asked.card);  // (a day studied: js/streak.js)
      const correct = asked.kind === 'truth' ? option === asked.truth : !!(asked.options[option] || {}).right;
      if (correct) right(false, option);
      else wrong(option);
    }

    function typed(text) {
      if (answered || !asked || !String(text || '').trim()) return;
      if (V.streak) V.streak.studied(asked.card);
      const result = check(text, asked.card.answer, { question: plain(asked.card.term), others: deckAnswers(asked.card) });
      if (result.right) right(result.typo, text, result.written);
      else wrong(text);
    }

    function reveal() {
      if (answered || !asked || asked.kind !== 'recall') return;
      asked.shown = true;
      draw();
      scr.say(`Answer: ${plain(asked.card.answer)}`);
    }

    function recalled(knew) {
      if (answered || !asked || !asked.shown) return;
      if (V.streak) V.streak.studied(asked.card);
      if (knew) right(false, true);
      else wrong(false);
    }

    /* "I was right": the typed answer counts after all. */
    function overrule() {
      if (!answered || answered.right) return;
      const { picked, first } = answered;
      if (first) missed.delete(asked.card.id);
      tries.set(asked.card.id, Math.max(0, (tries.get(asked.card.id) || 1) - 1));
      answered = null;
      right(false, picked);
    }

    /* "Edit card" (the wrong answer's, or the top's pencil): the card fixed (or taken out) in its note, then asked
       again as it is now (a miss it had just now doesn't count against it here). */
    function edit() {
      const card = asked && asked.card;
      if (!card || !RV.editCard) return;
      const kindNow = asked.kind;
      let changed = false;
      const sheet = RV.editCard(card, { onClose: () => {
        if (!changed && live && asked && asked.card === card && answered && answered.right && asked.kind !== 'type') ask();
      }, onDone: (fresh) => {
        changed = true;
        if (!live || !asked || asked.card !== card) return;
        clearTimeout(wait);
        const wasRight = !!(answered && answered.right);
        if (!wasRight && answered && answered.first) missed.delete(card.id);
        tries.delete(card.id);
        const swap = (list) => {
          const at = list.indexOf(card);
          if (at < 0) return;
          if (fresh) list[at] = fresh; else list.splice(at, 1);
        };
        swap(cards);
        swap(groups[group]);
        queue = queue.filter((c) => c !== card);
        twins.delete(card.id);
        plans.delete(card.id);
        if (fresh) { twins.set(fresh.id, [fresh]); plans.delete(fresh.id); }
        if (!groups[group].length) {
          groups.splice(group, 1);
          round = 0;
          return group < groups.length ? begin() : finish();
        }
        plan();
        steps = Math.min(steps, total);
        // Asked again now when it still has this kind of round (and wasn't answered right already).
        if (fresh && !wasRight && planOf(fresh).includes(kindNow)) queue.unshift(fresh);
        const at = rounds.indexOf(kindNow);
        if (at >= 0) { round = at; return ask(); }
        round = rounds.findIndex((k) => KINDS.indexOf(k) > KINDS.indexOf(kindNow));
        if (round < 0) { round = rounds.length - 1; queue = []; return ask(); }
        return begin();
      } });
      if (sheet) clearTimeout(wait);  // (a right pick waits while the card is being fixed; closing the sheet moves on)
    }

    /* A set done, more to go: a stop, so a long deck never feels endless. */
    function pause() {
      asked = null;
      scr.editable(false);
      const left = cards.length - learned;
      scr.progress('', 1, '');
      scr.ended(true);
      V.clear(scr.stage, V.h('div.study-end.learn-pause', { role: 'status' },
        V.h('span.study-end-mark', {}, V.icon('check')),
        V.h('h3', { text: `Set ${group} done` }),
        V.h('p.study-end-sum', { text: `${learned} of ${cards.length} learned so far.` }),
        V.h('p.study-end-next', { text: `${left} more to go, ${Math.min(GROUP, left)} at a time.` })));
      const go = V.button('Next set', { kind: 'primary', onClick: () => begin() });
      V.clear(scr.foot, V.h('div.study-end-go', {}, V.button('Done for now', { onClick: () => scr.close() }), go));
      requestAnimationFrame(() => { if (go.isConnected) go.focus({ preventScroll: true }); });
    }

    function finish() {
      asked = null;
      scr.editable(false);
      scr.progress('', 1, '');
      scr.ended(true);
      const done = V.button('Done', { kind: 'primary', onClick: () => scr.close() });
      const n = cards.length;
      V.clear(scr.stage, V.h('div.study-end.learn-end', { role: 'status' },
        V.h('span.study-end-mark', {}, V.icon('check')),
        V.h('h3', { text: 'Done for now' }),
        V.h('p.study-end-sum', { text: n ? `You learned all ${n} card${n === 1 ? '' : 's'}.` : 'No cards left to learn.' }),
        V.streak ? V.streak.endLine() : null,
        V.h('p.study-end-next', { text: missed.size ? `${missed.size} needed another go: they come back for review tomorrow.`
          : 'Every one right the first time. Nice work!' })));
      V.clear(scr.foot, V.h('div.study-end-go' + (n ? '' : '.one'), {},
        n ? V.button('Learn again', { icon: 'learn', onClick: () => start({ title, list: cards.flatMap((c) => twins.get(c.id) || [c]), deck, view: scr }) }) : null,
        done));
      requestAnimationFrame(() => { if (done.isConnected) done.focus({ preventScroll: true }); });
    }

    const keys = (event) => {
      const target = event.target && event.target.closest ? event.target : document.body;
      if (event.key === 'Enter' && answered && after && !target.closest('button')) {
        event.preventDefault();
        after();
        return;
      }
      if (target.closest('input, textarea, select') || answered || !asked) return;
      if (asked.kind === 'choice' && /^[1-4]$/.test(event.key) && asked.options[Number(event.key) - 1] !== undefined) {
        event.preventDefault();
        pick(Number(event.key) - 1);
      } else if (asked.kind === 'truth' && /^[tf]$/i.test(event.key)) {
        event.preventDefault();
        pick(event.key.toLowerCase() === 't');
      } else if (asked.kind === 'recall') {
        if (!asked.shown && (event.key === ' ' || event.key === 'Enter') && !target.closest('button')) { event.preventDefault(); reveal(); }
        else if (asked.shown && /^[12]$/.test(event.key)) { event.preventDefault(); recalled(event.key === '2'); }
      }
    };

    /* Back to flipping the same cards (the ones due first, else all of them as practice). */
    function flipInstead() {
      const at = RV.now();
      const all = cards.flatMap((c) => twins.get(c.id) || [c]);
      const due = all.filter((c) => RV.isDue(c, at));
      RV.session({ title, list: due.length ? due : all, practice: !due.length, deck, many, view: scr });
    }

    scr.use({
      name: 'learn',
      keys,
      edit: () => edit(),
      menu: () => [{ label: 'Flip cards instead', icon: 'cards', onClick: flipInstead }],
      leave: () => {
        live = false;
        clearTimeout(wait);
        // A typed miss left without Continue (or "I was right") still counts.
        if (answered && !answered.right && asked && asked.kind === 'type') gradeAll(asked.card, RV.AGAIN);
        answered = null;
        RV.flush();
      },
    });
    scr.stage.append(ui.body);
    begin();
    return scr;
  }

  return { fold, distance, slack, check, wrongOnes, wrongFor, forNote, forDeck, start, GROUP, plain, face, alternatives,
    tokens, forms, shapeOf, readCard, TYPE_WORDS };
})();
