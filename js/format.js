/* Vault: the light formatting a note's words can carry. It's all kept as plain text (Markdown-ish), so Jarvis reads
   a note as it is: "# " headings, "- " and "1. " lists, **bold**, _italic_, `code`, and links, written out
   (https://...) or bare (www.example.com, docs.google.com/...). This finds the links (the editor shows them as chips
   under their line), carries lists on with Enter, counts the words, and builds the Read view: page elements made one
   by one with the words as text, never HTML made from the words. */
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

  /* What ends a sentence isn't part of the link ("see www.x.com." / "(at x.com)"); brackets the link opened stay. */
  function trimEnd(url) {
    let end = url.length;
    while (end > 0) {
      const c = url[end - 1];
      if ('.,;:!?\'"*_~'.includes(c)) { end--; continue; }
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
    for (const m of String(text || '').matchAll(BARE)) {
      const raw = trimEnd(m[0]);
      const start = m.index;
      const end = start + raw.length;
      if (!raw || taken.some(([a, b]) => start < b && end > a)) continue;
      const href = toHref(raw);
      if (href && !/^https?:\/\/$/i.test(raw)) found.push({ start, end, text: raw, href });
    }
    return found.sort((a, b) => a.start - b.start);
  }

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
      line = line.replace(MD_LINK, '$1').replace(/\*\*|__|~~|`/g, '');
      chars += [...line].length;
      all += (line.replace(BARE, ' link ').match(WORD) || []).length;
    }
    return { words: all, chars, minutes: Math.max(1, Math.round(all / 200)) };
  }

  /* -- the Read view */

  const INLINE = new RegExp([
    '`([^`\\n]+)`',                                                            // 1 code
    `\\[([^\\]\\n]{1,300})\\]\\((${URL_SOURCE})\\)`,                           // 2 words, 3 link
    `(${URL_SOURCE})`,                                                         // 4 a bare link
    '\\*\\*(?=\\S)(.+?)(?<=\\S)\\*\\*',                                        // 5 bold
    '__(?=\\S)(.+?)(?<=\\S)__',                                                // 6 bold
    '~~(?=\\S)(.+?)(?<=\\S)~~',                                                // 7 struck out
    '(?<![\\p{L}\\p{N}*\\\\])\\*(?=[^\\s*])(.+?)(?<=[^\\s*])\\*(?![\\p{L}\\p{N}*])',   // 8 italic
    '(?<![\\p{L}\\p{N}_\\\\])_(?=[^\\s_])(.+?)(?<=[^\\s_])_(?![\\p{L}\\p{N}_])',     // 9 italic (snake_case isn't)
  ].join('|'), 'giu');

  /* The words of one line as page elements, every piece of text remembered with where it is in the note (`map`:
     text node -> {line, col}), so a tap in the Read view can put the caret on the same spot to write. */
  function inline(str, line, col, map) {
    const out = [];
    const re = new RegExp(INLINE.source, INLINE.flags);  // its own: the bold and italic inside call this again
    const words = (from, to, at = from) => {
      if (to <= from) return;
      const node = document.createTextNode(str.slice(from, to));
      map.set(node, { line, col: col + at });
      out.push(node);
    };
    const link = (href, kids) => V.h('a.read-link', { href, target: '_blank', rel: 'noopener noreferrer', title: href }, kids);
    let at = 0;
    let m;
    while ((m = re.exec(str))) {
      const start = m.index;
      let end = start + m[0].length;
      let made = null;
      if (m[1] !== undefined) {
        made = V.h('code.read-code-span', {}, inline.text(m[1], line, col + start + 1, map));
      } else if (m[2] !== undefined) {
        const href = toHref(m[3]);
        if (href) made = link(href, inline(m[2], line, col + start + 1, map));
      } else if (m[4] !== undefined) {
        const url = trimEnd(m[4]);
        const href = url && toHref(url);
        if (href && !/^https?:\/\/$/i.test(url)) {
          end = start + url.length;
          made = link(href, inline.text(url, line, col + start, map));
        }
      } else {
        const inner = m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[9];
        const mark = m[5] !== undefined || m[6] !== undefined || m[7] !== undefined ? 2 : 1;
        const tag = m[5] !== undefined || m[6] !== undefined ? 'strong' : m[7] !== undefined ? 's' : 'em';
        made = V.h(tag, {}, inline(inner, line, col + start + mark, map));
      }
      if (!made) { re.lastIndex = start + 1; continue; }
      words(at, start);
      out.push(made);
      at = end;
      re.lastIndex = end;
    }
    words(at, str.length);
    return out;
  }
  inline.text = (str, line, col, map) => {
    const node = document.createTextNode(str);
    map.set(node, { line, col });
    return node;
  };

  /* The whole note (its plain text) as formatted text. `tick(line)` ticks the item on that line of the note and says
     whether it's done now. Returns { el, map }. */
  function render(text, { tick } = {}) {
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
        el.append(V.h(`h${head[1].length + 1}.read-heading`, { dataset: { line: i } }, inline(head[2], i, head[1].length + 1, map)));
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
        const li = V.h('li', { dataset: { line: i, level: String(level) } }, inline(raw.slice(item[0].length), i, item[0].length, map));
        if (ordered) li.value = Number(item[3]);  // the number as written
        list.el.append(li);
        return;
      }
      const said = /^>\s?/.exec(raw);
      if (said) {
        para = null;
        list = null;
        if (!quote) { quote = V.h('blockquote.read-quote'); el.append(quote); } else quote.append(V.h('br'));
        quote.append(V.h('span.read-line', { dataset: { line: i } }, inline(raw.slice(said[0].length), i, said[0].length, map)));
        return;
      }
      list = null;
      quote = null;
      if (!para) { para = V.h('p.read-para'); el.append(para); } else para.append(V.h('br'));
      para.append(V.h('span.read-line', { dataset: { line: i } }, inline(raw, i, 0, map)));
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
      row.append(button, V.h('span.read-text', {}, inline(box[3], i, raw.length - box[3].length, map)));
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

  return { HEADING, LIST, links, site, continueList, cycleList, stats, render, fileKind, typeOf, icon, clock };
})();
