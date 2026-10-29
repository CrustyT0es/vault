/* Vault: the light formatting a note's words can carry. It's all kept as plain text (Markdown-ish), so Jarvis reads
   a note as it is: "# " headings, "- " and "1. " lists, **bold**, _italic_, ++underline++, ~~strikethrough~~,
   ==highlight==, `code`, links, written out (https://...) or bare (www.example.com, docs.google.com/...), and {{blanks}}
   (fill-in-the-blank flash cards, see js/study.js). This finds the links (the editor shows them as chips under their
   line) and the blanks, carries lists on with Enter, puts marks on and takes them off (the editor's B, I, U, S and
   highlighter), counts the words, and builds the Read view: page elements made one by one with the words as text,
   never HTML made from the words. The editor's see-through copy under each box (js/editor.js: shade) reads the marks
   with the very same `pieces`, so the box and the Read view always agree. */
'use strict';

V.format = (() => {
  const HEADING = /^(#{1,3}) (.*)$/;
  const CHECK = /^(\s*)[-*]\s*\[( |x|X)\]\s?(.*)$/;          // the editor's tick-box items
  const LIST = /^([ \t]*)(?:([-*+•])|(\d{1,3})([.)]))([ \t]+)/;  // "- ", "* ", "1. ", "2) " (and its indent)

  /* -- links */

  // Bare addresses ("google.com/maps") only count with a top-level domain people really type, so file names
  // (notes.txt, main.py, readme.md) and "e.g." never become links. With www. or https:// in front, anything goes.
  const TLDS = ['com', 'org', 'net', 'edu', 'gov', 'mil', 'io', 'co', 'uk', 'ca', 'au', 'nz', 'ie', 'de', 'fr', 'nl',
    'es', 'eu', 'jp', 'kr', 'cn', 'tw', 'hk', 'sg', 'br', 'mx', 'za', 'ly', 'me', 'tv', 'gg', 'fm', 'cc', 'app', 'dev',
    'ai', 'info', 'biz', 'xyz', 'site', 'online', 'store', 'tech', 'blog', 'news', 'games', 'live', 'art', 'pro', 'page',
    'link', 'wiki', 'be', 'gl', 'gle', 'to', 'fi', 'it', 'us', 'in'];  // (the last ones for short links: youtu.be, goo.gl...)
  const NOT = '\\s<>"\'`\\u00a0';
  const TAIL = `(?:[/?#][^${NOT}]*)?`;
  const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const NOT_BEFORE = '(?<![\\p{L}\\p{N}_@./-])';
  const NOT_AFTER = '(?![\\p{L}\\p{N}_-])';
  const URL_SOURCE = `(?:https?://[^${NOT}]+`
    + `|${NOT_BEFORE}www\\.(?:${LABEL}\\.)+[a-z]{2,24}${NOT_AFTER}(?::\\d{2,5})?${TAIL}`
    + `|${NOT_BEFORE}(?:${LABEL}\\.)+(?:${TLDS.join('|')})${NOT_AFTER}(?::\\d{2,5})?${TAIL})`;
  const BARE = new RegExp(URL_SOURCE, 'giu');
  const MD_LINK = new RegExp(`\\[([^\\]\\n]{1,300})\\]\\((${URL_SOURCE})\\)`, 'giu');

  const count = (text, c) => text.split(c).length - 1;

  /* What ends a sentence isn't part of the link ("see www.x.com." / "(at x.com)"); brackets the link opened stay.
     `before`: the words just in front of the link, for "==link==" and "++link++": their closing marks only go when the
     same marks open right before it (an address can end in "=" or "+" of its own: a base64 key, a wiki's "C++"). */
  function trimEnd(url, before = '') {
    let end = url.length;
    while (end > 0) {
      const c = url[end - 1];
      if ('.,;:!?\'"*_~'.includes(c)) { end--; continue; }
      const two = url.slice(end - 2, end);
      if ((two === '==' || two === '++') && end > 2 && before.endsWith(two)) { end -= 2; continue; }
      if (c === ')' || c === ']') {
        const piece = url.slice(0, end);
        if (count(piece, c === ')' ? '(' : '[') < count(piece, c)) { end--; continue; }
      }
      break;
    }
    return url.slice(0, end);
  }

  /* The address a link opens (https:// put in front of a bare one), or null when it isn't a web link. */
  function toHref(raw) {
    const href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    try {
      const url = new URL(href);
      if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.') || url.hostname.endsWith('.')) return null;
      return href;
    } catch (error) {
      return null;
    }
  }

  /* Every link in `text`: [{start, end, text (as written), href, label (a [label](link)'s words)}]. */
  function links(text) {
    const found = [];
    const taken = [];
    for (const m of String(text || '').matchAll(MD_LINK)) {
      const href = toHref(m[2]);
      if (!href) continue;
      found.push({ start: m.index, end: m.index + m[0].length, text: m[2], href, label: m[1] });
      taken.push([m.index, m.index + m[0].length]);
    }
    const all = String(text || '');
    for (const m of all.matchAll(BARE)) {
      let raw = trimEnd(m[0], all.slice(Math.max(0, m.index - 2), m.index));
      if (/(?:==|\+\+)$/.test(raw)) raw = ownEnd(all, m.index, raw);
      const start = m.index;
      const end = start + raw.length;
      if (!raw || taken.some(([a, b]) => start < b && end > a)) continue;
      const href = toHref(raw);
      if (href && !/^https?:\/\/$/i.test(raw)) found.push({ start, end, text: raw, href });
    }
    return found.sort((a, b) => a.start - b.start);
  }

  /* A bare link ending in "==" or "++" (`raw`, at `at` in `all`): where it really ends, read the way the Read view and
     the box's copy read its line, so "==Homework on https://x.com/a==" gives https://x.com/a (the highlight's closing
     marks aren't part of it) while a link's own "==" (a base64 key) stays. */
  function ownEnd(all, at, raw) {
    const start = lineStart(all, at);
    const found = all.indexOf('\n', at);
    const line = all.slice(start, found < 0 ? all.length : found);
    const run = runsOf(pieces(line), 'url').find((p) => p.start === at - start);
    return run ? line.slice(run.from, run.to) : raw;
  }

  /* Where the line with place `i` in it starts. */
  const lineStart = (value, i) => (i > 0 ? value.lastIndexOf('\n', i - 1) + 1 : 0);

  // Sites the owner is likely to use, by a friendlier name (the most specific first).
  const SITES = [
    ['docs.google.com', 'Google Docs'], ['drive.google.com', 'Google Drive'], ['classroom.google.com', 'Google Classroom'],
    ['meet.google.com', 'Google Meet'], ['maps.google.com', 'Google Maps'], ['calendar.google.com', 'Google Calendar'],
    ['google.com', 'Google'], ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'], ['wikipedia.org', 'Wikipedia'],
    ['github.com', 'GitHub'], ['reddit.com', 'Reddit'], ['chess.com', 'Chess.com'], ['discord.com', 'Discord'],
    ['discord.gg', 'Discord'], ['twitch.tv', 'Twitch'], ['instagram.com', 'Instagram'], ['tiktok.com', 'TikTok'],
    ['x.com', 'X'], ['twitter.com', 'X'], ['spotify.com', 'Spotify'], ['music.amazon.com', 'Amazon Music'],
    ['amazon.com', 'Amazon'], ['quizlet.com', 'Quizlet'], ['khanacademy.org', 'Khan Academy'], ['canva.com', 'Canva'],
    ['roblox.com', 'Roblox'], ['steampowered.com', 'Steam'], ['epicgames.com', 'Epic Games'], ['netflix.com', 'Netflix'],
    ['notion.so', 'Notion'], ['claude.ai', 'Claude'], ['stackoverflow.com', 'Stack Overflow'], ['office.com', 'Office'],
    ['microsoft.com', 'Microsoft'], ['bit.ly', 'Bitly'],
  ];
  const DOCS = { document: 'Google Docs', presentation: 'Google Slides', spreadsheets: 'Google Sheets', forms: 'Google Forms' };
  const PLAIN_PAGES = /^(watch|view|edit|preview|search|results|index\.\w+|home)$/i;

  /* What a link chip shows: the site's name and the end of its address. */
  function site(href) {
    let url;
    try { url = new URL(href); } catch (error) { return { name: String(href).slice(0, 40), tail: '' }; }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const known = host === 'docs.google.com' && DOCS[url.pathname.split('/')[1]]
      ? [host, DOCS[url.pathname.split('/')[1]]] : SITES.find(([key]) => host === key || host.endsWith('.' + key));
    const decode = (part) => { try { return decodeURIComponent(part); } catch (error) { return part; } };
    const pieces = url.pathname.split('/').filter(Boolean).map(decode);
    let tail = pieces.length ? pieces[pieces.length - 1] : '';
    if (url.search && (!tail || PLAIN_PAGES.test(tail))) tail += decode(url.search);
    if (/[a-z]/i.test(tail) && !/[?=]/.test(tail)) tail = tail.replace(/_/g, ' ');
    return { name: known ? known[1] : host, tail };
  }

  /* -- blanks: "The {{mitochondria}} makes ATP" */

  // Something that isn't only spaces between double braces, all on one line.
  const BLANK_SOURCE = '\\{\\{([^{}\\n]*[^{}\\s][^{}\\n]*)\\}\\}';
  const BLANK = new RegExp(BLANK_SOURCE, 'g');

  /* Every blank in `text`: [{start, end, word}] (the word without the spaces round it). Lines inside ``` code blocks
     and `code` are left alone: a template's {{ name }} isn't a card. */
  function blanks(text) {
    const found = [];
    let fenced = false;
    let at = 0;
    for (const line of String(text || '').split('\n')) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      else if (!fenced && line.includes('{{')) {
        const code = [...line.matchAll(/`[^`\n]+`/g)].map((m) => [m.index, m.index + m[0].length]);
        for (const m of line.matchAll(BLANK)) {
          const end = m.index + m[0].length;
          if (!code.some(([a, b]) => m.index < b && end > a)) found.push({ start: at + m.index, end: at + end, word: m[1].trim() });
        }
      }
      at += line.length + 1;
    }
    return found;
  }

  /* -- lists */

  /* Enter in a list line ("- milk", "1. eggs"): the next item, numbered on; on an empty item the list ends there (its
     marker goes). Returns { value, caret } for the box, or null when the line isn't a list item (a plain new line). */
  function continueList(value, start, end) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const found = value.indexOf('\n', end);
    const lineEnd = found < 0 ? value.length : found;
    const m = LIST.exec(value.slice(lineStart, lineEnd));
    if (!m || CHECK.test(value.slice(lineStart, lineEnd))) return null;
    const markerEnd = lineStart + m[0].length;
    if (start < markerEnd) return null;  // the caret is in front of the words: an ordinary new line
    if (start === end && !value.slice(markerEnd, lineEnd).trim()) {
      return { value: value.slice(0, lineStart) + value.slice(lineEnd), caret: lineStart, ended: true };
    }
    const number = m[3] ? Number(m[3]) + 1 : 0;
    const insert = '\n' + m[1] + (m[3] ? number + m[4] : m[2]) + m[5];
    let next = value.slice(0, start) + insert + value.slice(end);
    const caret = start + insert.length;
    if (m[3]) next = renumber(next, caret, m[1], number + 1);
    return { value: next, caret };
  }

  /* The numbered items after `from` (same indent, sub-items skipped) count on from `number`. */
  function renumber(value, from, indent, number) {
    const lineEnd = value.indexOf('\n', from);
    if (lineEnd < 0) return value;
    const head = value.slice(0, lineEnd + 1);
    const lines = value.slice(lineEnd + 1).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = LIST.exec(lines[i]);
      if (!m) break;
      if (m[1].length > indent.length) continue;
      if (m[1] !== indent || !m[3]) break;
      lines[i] = indent + number + m[4] + m[5] + lines[i].slice(m[0].length);
      number++;
    }
    return head + lines.join('\n');
  }

  /* The List button on the lines from `start` to `end`: plain lines get "- ", bullets become "1. ", "2. "..., and
     numbered ones go back to plain. Returns the new { value, start, end }. */
  function cycleList(value, start, end) {
    const from = value.lastIndexOf('\n', start - 1) + 1;
    const found = value.indexOf('\n', Math.max(end, start));
    const to = found < 0 ? value.length : found;
    const lines = value.slice(from, to).split('\n');
    const kind = (line) => { const m = LIST.exec(line); return !m ? 'plain' : m[3] ? 'numbered' : 'bullet'; };
    const filled = lines.filter((line) => line.trim());
    const all = (k) => filled.length > 0 && filled.every((line) => kind(line) === k);
    const goal = all('bullet') ? 'numbered' : all('numbered') ? 'plain' : 'bullet';
    const edits = [];  // each line's mark: where it was, how long it was, how long it is now
    let n = 0;
    let at = from;
    const out = lines.map((line) => {
      const m = LIST.exec(line);
      const indent = m ? m[1] : /^[ \t]*/.exec(line)[0];
      const old = m ? m[0].length : indent.length;
      let next = line;
      if (line.trim() || lines.length === 1) {  // a gap between the lines stays a gap
        const mark = goal === 'bullet' ? indent + '- ' : goal === 'numbered' ? indent + (++n) + '. ' : indent;
        next = mark + line.slice(old);
        edits.push({ at, old, now: mark.length });
      }
      at += line.length + 1;
      return next;
    });
    // Where a place in the old words is now (one inside an old mark goes to the start of the line's words).
    const move = (p) => {
      let shift = 0;
      for (const e of edits) {
        if (p < e.at) break;
        if (p <= e.at + e.old) return e.at + shift + e.now;
        shift += e.now - e.old;
      }
      return p + shift;
    };
    return { value: value.slice(0, from) + out.join('\n') + value.slice(to), start: move(start), end: move(end) };
  }

  /* -- counting */

  const WORD = /[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu;
  // ++underline++ and ==highlight== marks (the pairs only: C++ and a == b keep theirs), a light look for the count,
  // which goes over the whole note at every pause in typing.
  const PAIRS = /(?<![\p{L}\p{N}+=\\<>!])(\+\+|==)(?=[^\s+=<>])(.+?)(?<=[^\s+=<>])\1(?![\p{L}\p{N}+=<>])/gu;

  /* Words, characters (what's written, without the list and heading marks or line breaks) and minutes to read. */
  function stats(words) {
    let all = 0;
    let chars = 0;
    for (const raw of String(words || '').split('\n')) {
      let line = raw;
      const box = CHECK.exec(line);
      const head = box ? null : HEADING.exec(line);
      const item = box || head ? null : LIST.exec(line);
      if (box) line = box[3];
      else if (head) line = head[2];
      else if (item) line = line.slice(item[0].length);
      else line = line.replace(/^>\s?/, '');
      line = line.replace(MD_LINK, '$1').replace(PAIRS, (pair, mark, inner) => (fairPair(mark, inner) ? inner : pair))
        .replace(/\*\*|__|~~|`/g, '');
      chars += [...line].length;
      all += (line.replace(BARE, ' link ').match(WORD) || []).length;
    }
    return { words: all, chars, minutes: Math.max(1, Math.round(all / 200)) };
  }

  /* -- marks: what's bold, underlined... in a line (the Read view, the editor's copy under its boxes, its buttons) */

  // ++underline++ and ==highlight== only count with a space, punctuation or the line's edge outside their marks and
  // no space just inside them, so C++, i++, a==b, x==y==z and "a == b" (in Claude's answers too) stay as written;
  // nor with an arrow's < or > next to them (<==>, ==>, <==, !==). Two separate uses on one line aren't a pair either
  // (fairPair).
  const INLINE_PARTS = [
    '`([^`\\n]+)`',                                                            // 1 code
    `\\[([^\\]\\n]{1,300})\\]\\((${URL_SOURCE})\\)`,                           // 2 words, 3 link
    `(${URL_SOURCE})`,                                                         // 4 a bare link
    '\\*\\*(?=\\S)(.+?)(?<=\\S)\\*\\*',                                        // 5 bold
    '__(?=\\S)(.+?)(?<=\\S)__',                                                // 6 bold
    '~~(?=\\S)(.+?)(?<=\\S)~~',                                                // 7 struck out
    '(?<![\\p{L}\\p{N}*\\\\])\\*(?=[^\\s*])(.+?)(?<=[^\\s*])\\*(?![\\p{L}\\p{N}*])',   // 8 italic
    '(?<![\\p{L}\\p{N}_\\\\])_(?=[^\\s_])(.+?)(?<=[^\\s_])_(?![\\p{L}\\p{N}_])',     // 9 italic (snake_case isn't)
    '(?<![\\p{L}\\p{N}+\\\\])\\+\\+(?=[^\\s+<>])(.+?)(?<=[^\\s+<>])\\+\\+(?![\\p{L}\\p{N}+])',     // 10 underlined
    '(?<![\\p{L}\\p{N}=\\\\<>!])==(?=[^\\s=<>])(.+?)(?<=[^\\s=<>])==(?![\\p{L}\\p{N}=<>])',      // 11 highlighted
  ];
  // What a ++ or == pair can't have inside: code (";", "||", "&&", a single { or }) or another ++ or ==, as in
  // "if (x ==1 || y== 2)" or "for (...; ++i) { a[i]++; }" ({{blanks}} are fine).
  const CODE_INSIDE = /;|\|\||&&|(?<!\{)\{(?!\{)|(?<!\})\}(?!\})|\+\+|==/;
  /* Whether a ++ or == pair round `inner` is a mark, not two uses of ++ or == that happen to pair up: "++i vs i++"
     (an increment each side) and "++count in C++" (a language) aren't. vault/store.py: _fair_pair is the same. */
  function fairPair(mark, inner) {
    if (CODE_INSIDE.test(inner)) return false;
    if (mark !== '++') return true;
    const last = /(?<![\p{L}\p{N}_])[\p{L}\p{N}_]{1,3}$/u.exec(inner);
    if (!last || last.index === 0) return true;  // one word: "++hi++"
    const first = /^[\p{L}\p{N}_]{1,3}(?![\p{L}\p{N}_])/u.exec(inner);
    if (first && first[0] === last[0]) return false;  // ++i ... i++
    return !(last[0].length === 1 && /\s/.test(inner[last.index - 1]));  // ... C++
  }
  const INLINE = new RegExp(INLINE_PARTS.join('|'), 'giu');
  const WITH_BLANKS = new RegExp([...INLINE_PARTS, BLANK_SOURCE].join('|'), 'giu');  // 12 a blank (a note's words)
  const MARKED = { 5: 'bold', 6: 'bold', 7: 'strike', 8: 'italic', 9: 'italic', 10: 'underline', 11: 'highlight' };
  const EMPHASIS = new Set(Object.values(MARKED));

  /* The marked pieces of `str` between `from` and `to`: [{kind, start, end, from, to, kids, href}], places in `str`.
     kind: code, link ([words](address)), url (a bare link), blank, or a mark: bold, italic, strike, underline,
     highlight. `from`-`to` are the words inside (inside the marks, the brackets, the braces); `kids` the pieces in
     those words (none in code or a bare link). */
  function pieces(str, withBlanks = false, from = 0, to = str.length) {
    const text = str.slice(from, to);
    const re = new RegExp((withBlanks ? WITH_BLANKS : INLINE).source, 'giu');  // its own: the marks inside call this again
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const start = m.index;
      let end = start + m[0].length;
      let piece = null;
      if (m[1] !== undefined) piece = { kind: 'code', inner: [start + 1, end - 1] };
      else if (m[2] !== undefined) {
        const href = toHref(m[3]);
        if (href) piece = { kind: 'link', href, inner: [start + 1, start + 1 + m[2].length], nested: true };
      } else if (m[12] !== undefined) {
        const lead = m[12].length - m[12].trimStart().length;
        piece = { kind: 'blank', inner: [start + 2 + lead, start + 2 + lead + m[12].trim().length], nested: true };
      } else if (m[4] !== undefined) {
        const url = trimEnd(m[4], str.slice(Math.max(0, from + start - 2), from + start));
        const href = url && toHref(url);
        if (href && !/^https?:\/\/$/i.test(url)) {
          end = start + url.length;
          piece = { kind: 'url', href, inner: [start, end] };
        }
      } else {
        const group = [5, 6, 7, 8, 9, 10, 11].find((g) => m[g] !== undefined);
        const size = group === 8 || group === 9 ? 1 : 2;
        if (group < 10 || fairPair(m[0].slice(0, 2), m[group])) {
          piece = { kind: MARKED[group], mark: m[0].slice(0, size), inner: [start + size, end - size], nested: true };
        }
      }
      if (!piece) { re.lastIndex = start + 1; continue; }
      const made = { kind: piece.kind, start: from + start, end: from + end, from: from + piece.inner[0],
        to: from + piece.inner[1], kids: [] };
      if (piece.href) made.href = piece.href;
      if (piece.mark) made.mark = piece.mark;
      if (piece.nested) made.kids = pieces(str, withBlanks, made.from, made.to);
      out.push(made);
      re.lastIndex = end;
    }
    return out;
  }

  /* Every mark of `kind` in `list`, the ones inside others too. */
  function runsOf(list, kind, out = []) {
    for (const piece of list) {
      if (piece.kind === kind) out.push(piece);
      runsOf(piece.kids, kind, out);
    }
    return out;
  }

  const MARKISH = /[*_~+=]/;  // (a line without any of these has no marks to look for)

  /* The words without their marks (**, __, _, *, ~~, ++, ==), as a note's card or a title shows them: `code`, links,
     {{blanks}} and the lines of a ``` block stay as written. */
  function unmark(text) {
    let fenced = false;
    return String(text || '').split('\n').map((line) => {
      if (/^\s*```/.test(line)) { fenced = !fenced; return line; }
      if (fenced || !MARKISH.test(line)) return line;
      const plain = (list, from, to) => {
        let out = '';
        let at = from;
        for (const piece of list) {
          out += line.slice(at, piece.start);
          out += EMPHASIS.has(piece.kind) ? plain(piece.kids, piece.from, piece.to) : line.slice(piece.start, piece.end);
          at = piece.end;
        }
        return out + line.slice(at, to);
      };
      return plain(pieces(line), 0, line.length);
    }).join('\n');
  }

  /* -- the editor's mark buttons: B (**), I (_), U (++), S (~~) and the highlighter (==), on the words picked or the
     word the caret is in; pressed again, the marks come off. Each works on one box's words (`value`) and the picked
     part `a`-`b`, and gives the new { value, start, end } (null: nothing to do). */

  const MARKS = { bold: '**', italic: '_', underline: '++', strike: '~~', highlight: '==' };
  const KIND = Object.fromEntries(Object.entries(MARKS).map(([kind, mark]) => [mark, kind]));
  const EDGED = new Set(['_', '++', '==']);  // marks that need a space, punctuation or the line's edge outside them
  const LETTER = /[\p{L}\p{N}]/u;

  /* The lines `a`-`b` touch: [{start, end, code}] (code: a ``` line, or one inside a ``` block: never marked). */
  function linesOf(value, a, b) {
    const out = [];
    const fences = value.includes('```');
    let fenced = false;
    let start = fences ? 0 : lineStart(value, a);
    for (;;) {
      const found = value.indexOf('\n', start);
      const end = found < 0 ? value.length : found;
      const fence = fences && /^\s*```/.test(value.slice(start, end));
      if (end >= a) out.push({ start, end, code: fenced || fence, text: value.slice(start, end) });
      if (fence) fenced = !fenced;
      if (found < 0 || found >= b) break;
      start = found + 1;
    }
    return out;
  }

  /* How far into a line its words start: after "- ", "1. ", "> ", a tick box or "# " (and the indent). */
  function lead(text) {
    const box = CHECK.exec(text);
    if (box) return text.length - box[3].length;
    const head = HEADING.exec(text);
    if (head) return head[1].length + 1;
    const item = LIST.exec(text);
    if (item) return item[0].length;
    const said = /^\s*>\s?/.exec(text);
    return said ? said[0].length : /^[ \t]*/.exec(text)[0].length;
  }

  /* A line's pieces, with places in the whole of `value` (each line read once). */
  function linePieces(line) {
    if (!line.pieces) {
      const shift = (list) => list.map((p) => ({ ...p, start: p.start + line.start, end: p.end + line.start,
        from: p.from + line.start, to: p.to + line.start, kids: shift(p.kids) }));
      line.pieces = shift(pieces(line.text, true));
    }
    return line.pieces;
  }

  /* The picked words line by line, without the spaces round them or a line's own mark ("- "...): [{line, x, y}]. */
  function partsOf(value, a, b, lines) {
    const out = [];
    for (const line of lines) {
      if (line.code) continue;
      let x = Math.max(a, line.start + lead(line.text));
      let y = Math.min(b, line.end);
      while (x < y && /\s/.test(value[x])) x++;
      while (y > x && /\s/.test(value[y - 1])) y--;
      if (x < y) out.push({ line, x, y });
    }
    return out;
  }

  /* The innermost mark of `kind` around `x`-`y` (its own marks count as inside it), or null. */
  function around(line, kind, x, y) {
    let best = null;
    for (const run of runsOf(linePieces(line), kind)) {
      const from = x >= run.start && x < run.from ? run.from : x;
      const to = y > run.to && y <= run.end ? run.to : y;
      if (run.from <= from && to <= run.to && from <= to && (!best || run.end - run.start < best.end - best.start)) best = run;
    }
    return best;
  }

  /* A pair of marks put in by the button and typed into ("**word |**", or still empty "**|**"): the opening one before
     the caret and the closing one right after it, not part of any finished mark. Gives [open, close] or null. */
  function pendingPair(value, line, mark, c) {
    const n = mark.length;
    if (value.slice(c, c + n) !== mark) return null;
    const open = value.lastIndexOf(mark, c - n);
    if (open < line.start || open + n > c) return null;
    if (EDGED.has(mark) && open > line.start && LETTER.test(value[open - 1])) {
      // _, ++ and == right after a word ("This is_|_", Ctrl+I just after "is") are a pair while what's typed in it
      // starts with a space (it goes outside the marks when they're closed); "snake_case", "a_b_c" and "foo_|_bar"
      // are only words.
      const inner = value.slice(open + n, c);
      if (inner ? !/^\s/.test(inner) : LETTER.test(value[c + n] || '')) return null;
    }
    const list = linePieces(line);
    const busy = (p) => [...runsOf(list, KIND[mark]), ...runsOf(list, 'code'), ...runsOf(list, 'url')]
      .some((r) => p >= r.start && p < r.end);
    return busy(open) || busy(c) ? null : [open, c];
  }

  /* `edits` ({at, del, put}) made to `value`: the new words, and where a place in the old words is now (`late`: a
     place where words went in ends up after them, else before). */
  function apply(value, edits) {
    const list = edits.map((e) => ({ at: e.at, del: e.del || 0, put: e.put || '' }))
      .sort((p, q) => p.at - q.at || p.del - q.del);
    let out = '';
    let last = 0;
    for (const e of list) { out += value.slice(last, e.at) + e.put; last = e.at + e.del; }
    out += value.slice(last);
    const move = (p, late = false) => {
      let shift = 0;
      for (const e of list) {
        if (p < e.at || (p === e.at && !e.del && !late)) break;
        if (p < e.at + e.del) return e.at + shift + (late ? e.put.length : 0);
        shift += e.put.length - e.del;
      }
      return p + shift;
    };
    return { value: out, move };
  }

  const unwrapEdits = (run) => [{ at: run.start, del: run.from - run.start }, { at: run.to, del: run.end - run.to }];

  /* `x`-`y` on `line` marked: grown over a link or code it cuts into, over marks of the same kind it touches (those
     go: the whole stretch gets one pair), over other marks it only partly covers (marks nest whole, never cross), and
     for _, ++ and == out to whole words. Gives { edits, x, y }. */
  function wrapEdits(value, line, mark, x, y) {
    const kind = KIND[mark];
    const list = linePieces(line);
    const whole = [...runsOf(list, 'url'), ...runsOf(list, 'code'), ...runsOf(list, 'link')];
    const same = runsOf(list, kind);
    const others = [...EMPHASIS, 'blank'].filter((k) => k !== kind).flatMap((k) => runsOf(list, k));
    // _, ++ and == go round whole words, and over the marks' own letter next to them too ("F=ma", "a+b", "my_var"):
    // "F===ma==" wouldn't read as a highlight.
    const sticks = (ch) => LETTER.test(ch) || ch === mark[0] || ch === '\\' || (mark === '==' && '<>!'.includes(ch));
    for (let round = 0; round < 8; round++) {
      const was = [x, y];
      for (const p of whole) {
        // A link's words can take marks of their own when all the picked words are in them; picked words going
        // past its [ or ](address) take in the whole link (marks never cut a link).
        const inLabel = p.kind === 'link' && x >= p.from && y <= p.to;
        const cuts = (q) => !inLabel && q > p.start && q < p.end;
        if (cuts(x)) x = p.start;
        if (cuts(y)) y = p.end;
      }
      for (const r of same) if (r.start <= y && x <= r.end) { x = Math.min(x, r.start); y = Math.max(y, r.end); }
      for (const r of others) {
        const apart = y <= r.start || x >= r.end || (x <= r.start && y >= r.end) || (x >= r.from && y <= r.to);
        if (!apart) { x = Math.min(x, r.start); y = Math.max(y, r.end); }
      }
      if (EDGED.has(mark)) {
        while (x > line.start && sticks(value[x - 1])) x--;
        while (y < line.end && sticks(value[y])) y++;
      }
      if (was[0] === x && was[1] === y) break;
    }
    const edits = [{ at: x, put: mark }, { at: y, put: mark }];
    for (const r of same) if (r.start >= x && r.end <= y) edits.push(...unwrapEdits(r));
    return { edits, x, y };
  }

  /* Which of the marks the picked words (or the caret) are in: a Set of kinds (bold, italic, underline, strike,
     highlight), for the buttons' pressed look. */
  function marksAt(value, a, b) {
    const on = new Set();
    value = String(value || '');
    if (a > b) [a, b] = [b, a];
    const lines = linesOf(value, a, b);
    const parts = a === b ? [] : partsOf(value, a, b, lines);
    for (const [kind, mark] of Object.entries(MARKS)) {
      if (parts.length) {
        if (parts.every((p) => around(p.line, kind, p.x, p.y))) on.add(kind);
      } else {
        const line = lines.find((l) => l.start <= a && a <= l.end);
        if (line && !line.code && (around(line, kind, a, a) || pendingPair(value, line, mark, a))) on.add(kind);
      }
    }
    return on;
  }

  /* The button for `mark` pressed with `a`-`b` picked in `value`:
     - picked words: marked (each line's own, from the first word to the last), or, when they all are already, unmarked;
     - the caret in marked words: the marks come off; at the very end of them it steps out past the closing marks
       (so B, a word, B again carries on in plain words);
     - the caret in a pair the button just put in: the pair is closed round what was typed (spaces stay outside it), or
       taken out again when nothing was;
     - the caret inside a word: the word is marked; elsewhere a pair goes in with the caret between.
     `word`: a phone's keyboard was still writing the word the caret is at (it's underlined): it's that word's mark,
     even with the caret at its end. */
  function toggleMark(value, a, b, mark, { word: writing = false } = {}) {
    value = String(value || '');
    const kind = KIND[mark];
    if (!kind) return null;
    if (a > b) [a, b] = [b, a];
    const lines = linesOf(value, a, b);
    const parts = a === b ? [] : partsOf(value, a, b, lines);
    if (parts.length) {
      const inside = parts.map((p) => around(p.line, kind, p.x, p.y));
      if (inside.every(Boolean)) {
        const edits = [];
        const done = new Set();
        for (const run of inside) if (!done.has(run.start)) { done.add(run.start); edits.push(...unwrapEdits(run)); }
        const changed = apply(value, edits);
        return { value: changed.value, start: changed.move(parts[0].x), end: changed.move(parts[parts.length - 1].y) };
      }
      const made = parts.map((p, i) => (inside[i] ? null : wrapEdits(value, p.line, mark, p.x, p.y)));
      let changed = apply(value, made.flatMap((w) => (w ? w.edits : [])));
      // A line whose new marks wouldn't read as marks there (in "C++ rocks", or round a ";") is left as it was.
      const fails = made.map((w) => !!w && !reads(changed.value, kind, changed.move(w.x, true), changed.move(w.y)));
      if (fails.some(Boolean)) {
        fails.forEach((bad, i) => { if (bad) made[i] = null; });
        if (!made.some(Boolean)) return null;
        changed = apply(value, made.flatMap((w) => (w ? w.edits : [])));
      }
      const ends = parts.map((p, i) => (made[i] ? [[made[i].x, true], [made[i].y, false]] : [[p.x, false], [p.y, false]]));
      const [first, last] = [ends[0][0], ends[ends.length - 1][1]];
      return { value: changed.value, start: changed.move(first[0], first[1]), end: changed.move(last[0], last[1]) };
    }
    // Only the caret.
    const c = a;
    const line = lines.find((l) => l.start <= c && c <= l.end);
    if (!line || line.code) return null;
    const run = around(line, kind, c, c);
    if (run) {
      if (c === run.to) return { value, start: run.end, end: run.end };  // stepping out: nothing changes
      const changed = apply(value, unwrapEdits(run));
      const at = changed.move(c);
      return { value: changed.value, start: at, end: at };
    }
    const pair = pendingPair(value, line, mark, c);
    if (pair) {
      const n = mark.length;
      const inner = value.slice(pair[0] + n, c);
      const words = inner.trim();
      const before = inner.slice(0, inner.length - inner.trimStart().length);
      const after = inner.slice(inner.trimEnd().length);
      const put = words ? before + mark + words + mark + after : inner;
      const next = value.slice(0, pair[0]) + put + value.slice(c + n);
      const at = pair[0] + put.length;
      return { value: next, start: at, end: at };
    }
    // Inside a word (or a link, or code): the whole of it.
    const list = linePieces(line);
    const piece = [...runsOf(list, 'url'), ...runsOf(list, 'code')].find((p) => p.start < c && c < p.end);
    let word = piece ? [piece.start, piece.end] : null;
    if (!word) {
      for (const m of line.text.matchAll(WORD)) {
        const start = line.start + m.index;
        const end = start + m[0].length;
        if (writing ? start <= c && c <= end : start < c && c < end) { word = [start, end]; break; }
      }
    }
    if (word) {
      const made = wrapEdits(value, line, mark, word[0], word[1]);
      const changed = apply(value, made.edits);
      if (!reads(changed.value, kind, changed.move(made.x, true), changed.move(made.y))) return null;  // ("C++")
      const at = changed.move(c);
      return { value: changed.value, start: at, end: at };
    }
    return { value: value.slice(0, c) + mark + mark + value.slice(c), start: c + mark.length, end: c + mark.length };
  }

  /* The opening marks of the empty pair a button just put in with the caret `c` between ("**|**", "word _|_"), outermost
     first ("**_" for B then I: "**_|_**"), or null: no such pair there, or words are already typed in it. What goes in
     next belongs inside the marks, so a space it needs goes before them (js/dictation.js). */
  function openPairAt(value, c) {
    value = String(value || '');
    if (!Number.isInteger(c) || c < 0 || c > value.length) return null;
    let open = '';
    for (;;) {
      const line = linesOf(value, c, c).find((l) => l.start <= c && c <= l.end);
      if (!line || line.code) break;
      const mark = Object.values(MARKS).find((m) => {
        const pair = pendingPair(value, line, m, c);
        return !!pair && pair[0] + m.length === c;
      });
      if (!mark) break;
      open = mark + open;
      // (a pair just inside another: the outer one is looked for as it was before the inner one went in)
      value = value.slice(0, c - mark.length) + value.slice(c + mark.length);
      c -= mark.length;
    }
    return open || null;
  }

  /* Whether `x`-`y` of `value` reads as marked `kind` (marks the buttons put in must show, or they'd only pile up). */
  function reads(value, kind, x, y) {
    const line = linesOf(value, x, y).find((l) => l.start <= x && y <= l.end);
    return !!line && !line.code && !!around(line, kind, x, y);
  }

  /* -- the Read view */

  const TAGS = { bold: 'strong', italic: 'em', strike: 's', underline: 'u', highlight: 'mark.read-hl' };

  /* The words of one line as page elements, every piece of text remembered with where it is in the note (`map`:
     text node -> {line, col}), so a tap in the Read view can put the caret on the same spot to write. With `withBlanks`
     a {{blank}} shows as its word, softly underlined. */
  function inline(str, line, col, map, withBlanks = false) {
    const link = (href, kids) => V.h('a.read-link', { href, target: '_blank', rel: 'noopener noreferrer', title: href }, kids);
    const draw = (list, from, to) => {
      const out = [];
      const words = (a, b) => {
        if (b <= a) return;
        const node = document.createTextNode(str.slice(a, b));
        map.set(node, { line, col: col + a });
        out.push(node);
      };
      let at = from;
      for (const piece of list) {
        words(at, piece.start);
        out.push(made(piece));
        at = piece.end;
      }
      words(at, to);
      return out;
    };
    const made = (piece) => {
      const kids = () => draw(piece.kids, piece.from, piece.to);
      if (piece.kind === 'code') return V.h('code.read-code-span', {}, inline.text(str.slice(piece.from, piece.to), line, col + piece.from, map));
      if (piece.kind === 'url') return link(piece.href, inline.text(str.slice(piece.from, piece.to), line, col + piece.from, map));
      if (piece.kind === 'link') return link(piece.href, kids());
      if (piece.kind === 'blank') return V.h('span.read-blank', { title: 'A fill-in-the-blank card' }, kids());
      return V.h(TAGS[piece.kind], {}, kids());
    };
    return draw(pieces(str, withBlanks), 0, str.length);
  }
  inline.text = (str, line, col, map) => {
    const node = document.createTextNode(str);
    map.set(node, { line, col });
    return node;
  };

  /* The whole note (its plain text) as formatted text. `tick(line)` ticks the item on that line of the note and says
     whether it's done now; `blanks` shows {{blanks}} as cards (a note's own Read view). Returns { el, map }. */
  function render(text, { tick, blanks: withBlanks = false } = {}) {
    const map = new WeakMap();
    const el = V.h('div.read-body');
    let para = null;
    let list = null;
    let quote = null;
    let code = null;
    const done = () => { para = null; list = null; quote = null; };
    const lines = String(text || '').split('\n');
    lines.forEach((raw, i) => {
      if (code) {
        if (/^\s*```/.test(raw)) { code = null; return; }
        if (code.childNodes.length) code.append('\n');
        code.append(V.h('span', { dataset: { line: i } }, inline.text(raw, i, 0, map)));
        return;
      }
      if (/^\s*```/.test(raw)) {
        done();
        code = V.h('code');
        el.append(V.h('pre.read-pre', { dataset: { line: i } }, code));
        return;
      }
      const box = CHECK.exec(raw);
      if (box) {
        done();
        el.append(checkRow(box, raw, i));
        return;
      }
      const head = HEADING.exec(raw);
      if (head) {
        done();
        el.append(V.h(`h${head[1].length + 1}.read-heading`, { dataset: { line: i } }, inline(head[2], i, head[1].length + 1, map, withBlanks)));
        return;
      }
      if (!raw.trim()) {
        done();
        el.append(V.h('div.read-gap', { dataset: { line: i } }));
        return;
      }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
        done();
        el.append(V.h('hr.read-rule', { dataset: { line: i } }));
        return;
      }
      const item = LIST.exec(raw);
      if (item) {
        para = null;
        quote = null;
        const ordered = !!item[3];
        const level = Math.min(4, Math.floor(item[1].replace(/\t/g, '  ').length / 2));
        if (!list || list.ordered !== ordered) {
          list = { ordered, el: V.h(ordered ? 'ol.read-list' : 'ul.read-list') };
          el.append(list.el);
        }
        const li = V.h('li', { dataset: { line: i, level: String(level) } }, inline(raw.slice(item[0].length), i, item[0].length, map, withBlanks));
        if (ordered) li.value = Number(item[3]);  // the number as written
        list.el.append(li);
        return;
      }
      const said = /^>\s?/.exec(raw);
      if (said) {
        para = null;
        list = null;
        if (!quote) { quote = V.h('blockquote.read-quote'); el.append(quote); } else quote.append(V.h('br'));
        quote.append(V.h('span.read-line', { dataset: { line: i } }, inline(raw.slice(said[0].length), i, said[0].length, map, withBlanks)));
        return;
      }
      list = null;
      quote = null;
      if (!para) { para = V.h('p.read-para'); el.append(para); } else para.append(V.h('br'));
      para.append(V.h('span.read-line', { dataset: { line: i } }, inline(raw, i, 0, map, withBlanks)));
    });
    if (!lines.some((line) => line.trim())) {
      V.clear(el, V.h('p.read-empty', { dataset: { line: String(lines.length - 1) }, text: 'Nothing written yet. Tap here to start.' }));
    }
    return { el, map };

    function checkRow(box, raw, i) {
      const ticked = box[2] !== ' ';
      const row = V.h('div.read-check' + (ticked ? '.done' : ''), { dataset: { line: i } });
      const button = V.h('button.tick.read-tick', {
        type: 'button', 'aria-label': ticked ? 'Not done' : 'Done', 'aria-pressed': String(ticked),
        onclick: () => {
          const now = tick ? tick(i) : null;
          if (typeof now !== 'boolean') return;
          row.classList.toggle('done', now);
          button.setAttribute('aria-pressed', String(now));
          button.setAttribute('aria-label', now ? 'Not done' : 'Done');
        },
      }, V.icon('check'));
      row.append(button, V.h('span.read-text', {}, inline(box[3], i, raw.length - box[3].length, map, withBlanks)));
      return row;
    }
  }

  /* -- files */

  const KINDS = [
    [/pdf/i, /\.pdf$/i, 'PDF'],
    [/wordprocessing|msword|opendocument\.text|rtf/i, /\.(docx?|odt|rtf|pages)$/i, 'Document'],
    [/spreadsheet|excel|csv/i, /\.(xlsx?|ods|csv|numbers)$/i, 'Spreadsheet'],
    [/presentation|powerpoint/i, /\.(pptx?|odp|key)$/i, 'Slides'],
    [/^audio\//i, /\.(mp3|m4a|wav|ogg|oga|opus|aac|flac)$/i, 'Audio'],
    [/^video\//i, /\.(mp4|mov|mkv|avi|webm)$/i, 'Video'],
    [/zip|rar|7z|tar|gzip/i, /\.(zip|rar|7z|tar|gz)$/i, 'Archive'],
    [/^text\//i, /\.(txt|md|log)$/i, 'Text'],
    [/^image\//i, /\.(png|jpe?g|gif|webp|heic|heif|bmp|svg)$/i, 'Picture'],
  ];

  /* A file's kind for its chip: { label: 'PDF', short: 'PDF' } (short is its own ending, as the PC shows it). */
  function fileKind(mime, name) {
    const found = KINDS.find(([byType, byName]) => (mime && byType.test(mime)) || byName.test(name || ''));
    const ending = (/\.([a-z0-9]{1,4})$/i.exec(name || '') || [])[1];
    return { label: found ? found[2] : 'File', short: (ending || (found ? found[2].slice(0, 3) : 'File')).toUpperCase() };
  }

  const TYPES = {
    pdf: 'application/pdf', doc: 'application/msword', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
    mp4: 'video/mp4', mov: 'video/quicktime', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  };
  /* A type for a file the phone gave none (Android often leaves Office files without one). */
  const typeOf = (name) => TYPES[((/\.([a-z0-9]+)$/i.exec(name || '') || [])[1] || '').toLowerCase()] || '';

  /* -- icons (drawn on the same 24 grid as util.js's, made as SVG elements) */

  const SVG = 'http://www.w3.org/2000/svg';
  const DRAWINGS = {
    bold: [{ d: 'M7 12h6.25a3.5 3.5 0 0 1 0 7H7V5h5.25a3.5 3.5 0 0 1 0 7', w: 2.4 }],
    italic: ['M18.5 5h-8', 'M13.5 19h-8', 'M14.5 5l-5 14'],
    underline: ['M7 4.5V11a5 5 0 0 0 10 0V4.5', 'M5.5 20h13'],
    strike: ['M4.5 12h15', 'M16.2 6.6A4.3 4.3 0 0 0 12.4 4.5h-.9A3.5 3.5 0 0 0 9.4 10.7',
      'M8 17.2a4.4 4.4 0 0 0 3.9 2.3h.7a3.6 3.6 0 0 0 3.3-5'],
    highlight: ['m13.8 4.7 5.5 5.5', 'M15.7 3.5a1.9 1.9 0 0 1 2.7 0l2.1 2.1a1.9 1.9 0 0 1 0 2.7L12 16.8l-4.8-4.8z',
      'm7.2 12-2.7 2.7v2.4h2.4L9.6 14.4', { d: 'M3.5 20.5h17', w: 2.2 }],
    heading: ['M6.5 5v14', 'M17.5 5v14', 'M6.5 12h11'],
    list: ['M10 6.5h10', 'M10 12h10', 'M10 17.5h10', { c: [5, 6.5, 1.3] }, { c: [5, 12, 1.3] }, { c: [5, 17.5, 1.3] }],
    undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
    redo: ['m15 14 5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'],
    mic: ['M12 3.5a3 3 0 0 0-3 3V12a3 3 0 0 0 6 0V6.5a3 3 0 0 0-3-3z', 'M5.5 11.5a6.5 6.5 0 0 0 13 0', 'M12 18v3'],
    clip: ['m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.2-8.2a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a1.6 1.6 0 0 1-2.3-2.3l7.6-7.6'],
    book: ['M12 6.8C10.4 5.3 8 4.8 4 4.8v12.8c4 0 6.4.5 8 2 1.6-1.5 4-2 8-2V4.8c-4 0-6.4.5-8 2z', 'M12 6.8v12.8'],
    pencil: ['M14.5 5.5l4 4', 'M16.6 3.4a2 2 0 0 1 2.9 0l1.1 1.1a2 2 0 0 1 0 2.9L8 20H4v-4z'],
    play: [{ d: 'M8 5.5v13l10.5-6.5z', fill: true }],
    pause: [{ d: 'M7 5.5h3.2v13H7zM13.8 5.5H17v13h-3.2z', fill: true }],
  };

  function icon(name, cls) {
    const span = document.createElement('span');
    span.className = 'icon' + (cls ? ' ' + cls : '');
    span.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG, 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(key, value);
    for (const part of DRAWINGS[name] || []) {
      const shape = document.createElementNS(SVG, typeof part === 'object' && part.c ? 'circle' : 'path');
      if (typeof part === 'string') shape.setAttribute('d', part);
      else if (part.c) {
        shape.setAttribute('cx', part.c[0]); shape.setAttribute('cy', part.c[1]); shape.setAttribute('r', part.c[2]);
        shape.setAttribute('fill', 'currentColor'); shape.setAttribute('stroke', 'none');
      } else {
        shape.setAttribute('d', part.d);
        if (part.fill) { shape.setAttribute('fill', 'currentColor'); shape.setAttribute('stroke', 'none'); }
        if (part.w) shape.setAttribute('stroke-width', String(part.w));
      }
      svg.append(shape);
    }
    span.append(svg);
    return span;
  }

  /* 0:07, 1:23 */
  const clock = (seconds) => {
    const s = Math.max(0, Math.round(seconds || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  return { HEADING, LIST, MARKS, links, blanks, site, continueList, cycleList, stats, render, fileKind, typeOf, icon, clock,
    pieces, unmark, marksAt, toggleMark, openPairAt };
})();
