/* Wefty 1.17: flash cards made by the AI. The owner: "add the option to generate flashcards using Gemini automatically
   so I don't have to do the stupid ::here:: or whatnot to create flashcards. Also if AI mode could use a certain folder,
   look it all over and make study cards based on the folder, that would be amazing."

   Make flash cards reads one note, a folder (with the folders inside it) or what a test covers, asks the AI that writes
   the note-taker's notes (V.ai.ask: the free Gemini unless "Write notes with Claude" is on, or only Claude is set up
   here), and shows the cards it made in a sheet first: each with a tick (all ticked), its words editable, "Add N cards".
   Nothing is written before that, and Cancel (or closing the sheet) stops the AI and writes nothing.

   What it reads: never a locked note (not even one open and unlocked), an archived one, a template or one in the Trash
   (the sheet says how many were skipped); a folder's or a test's go leaves out the tests' own notes and the study
   notes it made (their cards only count as there already). A big folder goes in parts (CHUNK letters a request, MOST_LETTERS in all, the
   most recently edited notes first: the sheet says how many were left out). Cards come back in Wefty's own format
   (js/study.js): "question :: answer", and now and then a fill-in-the-blank "The {{mitochondria}} release energy".

   Where they go: one note's cards under its "# Flash cards" heading (made at its end, above a note-taker's transcript,
   when there isn't one); a folder's into a note "Study cards: <Folder>" in that folder (added to when it's there), with
   a line saying which notes they came from (extra.ai_cards keeps them); a test's into each covered folder's study note
   (tags alone: one beside the test, carrying the tags so the test counts its cards). A card whose question is already
   there (in that note, or in the notes it was made from: case and spaces ignored) is never added again.

   The free Gemini costs nothing, and these requests aren't counted in Settings > AI's tally at all; a Claude answer
   is, like the note-taker's. Chat has the same thing as its make_flash_cards tool (js/chattools.js): there the cards
   are added at once, and the chip under the answer has Open and Undo (a sheet mid-answer would hold the chat's round
   up, and every other change Chat makes works that way). */
'use strict';

V.aiCards = (() => {
  const CHUNK = 20000;          // letters of notes one request reads
  const MOST_LETTERS = 100000;  // letters one go reads in all (about five requests)
  const MOST_CARDS = 150;       // cards one go adds at most
  const PART_CARDS = 25;        // cards one request is asked for at most
  const HAVE_MOST = 120;        // cards already there, listed for the AI so it doesn't make them again
  const Q_MOST = 300;
  const A_MOST = 600;
  const FROM_MOST = 200;        // notes a study note remembers it was made from
  const STUDY = 'Study cards';
  const HEADING = /^\s{0,3}#{1,3}\s*flash ?cards\s*$/i;
  const ANY_HEADING = /^\s{0,3}#{1,6}\s+\S/;
  const TRANSCRIPT = /^#\s+Transcript\s*$/i;
  const FROM_LINE = /^Made with AI from: /;
  const LEAD = /^\s*(?:[-*•]\s+(?:\[[ xX]\]\s*)?|\d{1,3}[.)]\s+)/;

  class Refusal extends Error {}
  const no = (words) => { throw new Refusal(words); };
  const O = () => V.organise;
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const nameOf = (who) => (who === 'claude' ? 'Claude' : 'Gemini');
  const liveFolder = (id) => { const f = id ? V.data.folders.get(id) : null; return f && !f.deleted ? f : null; };
  const listening = (id) => !!(V.notetaker && V.notetaker.listeningTo && V.notetaker.listeningTo() === id);
  const squash = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const plainTitle = (row) => V.format.unmark(V.noteTitle(row)).replace(/::|\{\{|\}\}/g, ' ').replace(/\s+/g, ' ').trim();

  /* -- the notes */

  const openCopy = (id) => (V.editor && V.editor.openId() === id && V.editor.current() ? V.editor.current() : null);

  /* A note's words as they are now: the open copy's (with what was just typed), else its row's; null for a locked one
     (shown or not). */
  function wordsOf(row) {
    if (!row || row.locked) return null;
    const open = openCopy(row.id);
    if (open) return open.locked ? null : (V.editor.words() || '');
    return String(row.body || '');
  }
  const titled = (row) => openCopy(row.id) || row;

  /* Why a note isn't read: '' when it is. */
  function skipWhy(row) {
    if (row.deleted) return 'trash';
    if (row.locked || (openCopy(row.id) || {}).locked) return 'locked';
    if (O().isTemplate(row)) return 'template';
    if (O().isArchived(row)) return 'archived';
    return '';
  }
  const noneSkipped = () => ({ locked: 0, archived: 0, template: 0, trash: 0 });
  const isStudy = (row) => !!(row && row.extra && row.extra.ai_cards);
  /* A test's own note (a due day and what it covers): its words are about the test (its day, what to bring), so a
     folder's or a test's go never reads it. One note's own Make flash cards still can. */
  const isTest = (row) => !!(row && row.due && V.review.coversOf({ ...row, body: wordsOf(row) || '' }).length);
  /* The notes a folder's or a test's go reads: words in them, and not a study note or a test. */
  const readable = (row) => !isStudy(row) && !isTest(row) && !!String(wordsOf(row) || '').trim();

  /* "Skipped 1 locked note and 2 in the Trash." ('' when none were). */
  function skippedLine(skipped) {
    const bits = [
      skipped.locked ? plural(skipped.locked, 'locked note') : '',
      skipped.archived ? plural(skipped.archived, 'archived note') : '',
      skipped.template ? plural(skipped.template, 'template') : '',
      skipped.trash ? `${skipped.trash} in the Trash` : '',
    ].filter(Boolean);
    if (!bits.length) return '';
    const list = bits.length === 1 ? bits[0] : `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`;
    return `Skipped ${list}.`;
  }

  /* The notes in these folders (ids) that can be read; the others counted in `skipped`. */
  function inFolders(ids, skipped, except) {
    const out = [];
    for (const row of V.data.notes.values()) {
      if (row._purge || !ids.has(row.folder_id) || except.has(row.id)) continue;
      const why = skipWhy(row);
      if (why) { skipped[why] += 1; continue; }
      out.push(row);
    }
    return out;
  }

  /* -- the cards */

  const lineOf = (card) => (card.kind === 'blank' ? card.text : `${card.q} :: ${card.a}`);
  /* A card's question, for "is it already there?": its words without marks, case, spaces or the end's punctuation. */
  const squashed = (text) => V.format.unmark(String(text || '')).toLowerCase().replace(/\s+/g, '').replace(/[?.!,;:]+$/u, '');
  const keyOf = (card) => (card.kind === 'blank' ? 'b:' + squashed(card.text.replace(LEAD, '')) : 'q:' + squashed(card.q));

  /* The questions of the cards in `words`, as keyOf makes them. */
  function keysIn(words) {
    const out = new Set();
    const lines = String(words || '').split('\n');
    for (const c of V.study.cards(words)) {
      out.add(c.kind === 'qa' ? 'q:' + squashed(c.term) : 'b:' + squashed((lines[c.line] || '').replace(LEAD, '')));
    }
    return out;
  }

  const clean = (text, most) => String(text || '').replace(/\s+/g, ' ').trim().replace(/^\*\*(.+)\*\*$/, '$1').slice(0, most).trim();

  /* The cards in the AI's answer: "question :: answer" lines and lines with a {{blank}}, each as Wefty reads it (a line
     js/study.js doesn't take for a card is dropped, and so is anything else the AI wrote). `cut`: the answer ran out of
     room, so its last line may be half a card. */
  function parse(text, cut = false) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    if (cut && lines.length > 1) lines.pop();
    const out = [];
    for (const raw of lines) {
      const line = raw.trim().replace(LEAD, '').trim();
      if (!line || /^```/.test(line) || /^#/.test(line)) continue;
      const qa = /^(.+?)\s*::\s*(.+)$/.exec(line);
      if (qa) {
        const q = clean(qa[1].replace(/^Q\s*[:.]\s+/i, ''), Q_MOST);
        const a = clean(qa[2].replace(/::/g, ':').replace(/^A\s*[:.]\s+/i, ''), A_MOST);
        if (q && a && !q.includes('{{')) out.push({ kind: 'qa', q, a });
        continue;
      }
      if (line.includes('{{') && V.format.blanks(line).length) out.push({ kind: 'blank', text: clean(line, Q_MOST + A_MOST) });
    }
    return out.filter((c) => V.study.cards(lineOf(c)).length > 0);
  }

  /* `words` with these card lines added: at the end of its Flash cards part (the last "# Flash cards" heading's, up to
     the next heading), else under a new "# Flash cards" heading at the end, above a note-taker's transcript when it
     has one (so the transcript stays the last thing in the note). { text, heading: whether the heading was made }. */
  function withCards(words, lines) {
    const all = String(words || '').split('\n');
    let end = all.length;
    for (let i = all.length - 1; i >= 0; i--) if (TRANSCRIPT.test(all[i])) { end = i; break; }
    let head = -1;
    for (let i = 0; i < end; i++) if (HEADING.test(all[i])) head = i;
    if (head >= 0) {
      let stop = end;
      for (let i = head + 1; i < end; i++) if (ANY_HEADING.test(all[i])) { stop = i; break; }
      let at = stop;
      while (at > head + 1 && !all[at - 1].trim()) at--;
      all.splice(at, 0, ...lines);
      return { text: all.join('\n'), heading: false };
    }
    const before = all.slice(0, end).join('\n').replace(/\s+$/, '');
    const block = ['# Flash cards', ...lines].join('\n');
    const after = all.slice(end).join('\n');
    return { text: (before ? `${before}\n\n${block}` : block) + (end < all.length ? `\n\n${after}` : ''), heading: true };
  }

  /* `words` with these card lines taken out again (each once, the last one with those words), and the "# Flash cards"
     heading too when it was made for them and nothing is left under it (Chat's Undo). Null when none are there. */
  function withoutCards(words, lines, heading = false) {
    const all = String(words || '').split('\n');
    let taken = 0;
    for (const line of lines) {
      let at = -1;
      for (let i = all.length - 1; i >= 0; i--) if (all[i].trim() === String(line).trim()) { at = i; break; }
      if (at >= 0) { all.splice(at, 1); taken += 1; }
    }
    if (!taken) return null;
    if (heading) {
      for (let i = all.length - 1; i >= 0; i--) {
        if (!HEADING.test(all[i])) continue;
        let j = i + 1;
        while (j < all.length && !all[j].trim()) j++;
        if (j >= all.length || ANY_HEADING.test(all[j])) {
          let from = i;
          while (from > 0 && !all[from - 1].trim()) from--;
          all.splice(from, j - from, ...(j < all.length && from > 0 ? [''] : []));
        }
        break;
      }
    }
    return all.join('\n').replace(/\n+$/, String(words || '').endsWith('\n') ? '\n' : '');
  }

  /* -- what one go reads, and where its cards go

     { name (what they're made from, for the sheet), targets: [{ kind 'note' (one note, added to) or 'study' (a study
     note: `id` when there's one, else made), id, title, folderId, tags, sources: [rows], have: Set of questions there
     already, extra (only the study note's own cards) }], skipped, read (notes read), cut (left out for size), cutNote
     (one note read only in part) }. Throws a Refusal (words to show) when there's nothing to make cards from. */

  function noteScope(id) {
    const row = V.data.notes.get(id);
    if (!row || row._purge) no('That note isn\'t there any more.');
    if (row.deleted) no('That note is in the Trash.');
    if (skipWhy(row) === 'locked') no('Wefty never reads a locked note to make flash cards.');
    if (O().isTemplate(row)) no('This is a template: make cards in a note made from it.');
    if (O().isArchived(row)) no('This note is archived, so its cards wouldn\'t come up to study. Unarchive it first.');
    if (listening(id)) no('The note-taker is writing into this note. Stop it first, then make cards.');
    const words = wordsOf(row);
    if (!String(words || '').trim()) no('There\'s nothing in this note to make cards from yet.');
    const target = { kind: 'note', id, title: plainTitle({ ...titled(row), body: words }), sources: [row], have: keysIn(words), extra: [] };
    return { name: target.title, targets: [target], skipped: noneSkipped() };
  }

  /* The study note of `folder` (made by Make flash cards before, or one with that title), or null. `test`: the one made
     for that test's #tags instead (extra.ai_cards.test), never the folder's own. */
  function studyNoteIn(folder, title, test = '') {
    const ours = (n) => isStudy(n) && n.extra.ai_cards.folder === folder.id && (n.extra.ai_cards.test || '') === test;
    const fits = [...V.data.notes.values()].filter((n) => !n._purge && n.folder_id === folder.id && !skipWhy(n)
      && !listening(n.id) && (ours(n) || (squash(n.title) === squash(title) && (!isStudy(n) || ours(n)))));
    fits.sort((a, b) => Number(ours(b)) - Number(ours(a)) || (V.editedAt(b) || '').localeCompare(V.editedAt(a) || ''));
    return fits[0] || null;
  }

  function studyTarget(folder, title = `${STUDY}: ${folder.name}`, { tags = [], test = '' } = {}) {
    const found = studyNoteIn(folder, title, test);
    const words = found ? wordsOf(found) : '';
    return { kind: 'study', id: found ? found.id : null, folderId: folder.id, title: found ? plainTitle(titled(found)) : title,
      tags, test, sources: [], have: keysIn(words), extra: found ? V.study.cards(words) : [] };
  }

  /* Every card already in these notes (the ones read, and the study notes beside them) counts as there. */
  function haveAlso(target, rows) {
    for (const row of rows) for (const key of keysIn(wordsOf(row))) target.have.add(key);
  }

  function folderScope(folderId) {
    const folder = liveFolder(folderId);
    if (!folder) no('That folder isn\'t there any more.');
    const target = studyTarget(folder);
    const skipped = noneSkipped();
    const rows = inFolders(new Set([folder.id, ...O().inside(folder.id)]), skipped, new Set(target.id ? [target.id] : []));
    haveAlso(target, rows);
    target.sources = rows.filter(readable);
    if (!target.sources.length) {
      no(`There are no notes in ${folder.name} to make cards from yet.${skippedLine(skipped) ? ' ' + skippedLine(skipped) : ''}`);
    }
    return { name: folder.name, targets: [target], skipped };
  }

  /* A test's covers: each covered folder's study note (a folder inside another covered one goes with that one), and the
     notes with a covered #tag that no covered folder has go with the first; with tags alone, into a study note beside
     the test, carrying the tags (so the test counts its cards). Never the test note itself. */
  function testScope(id) {
    const note = V.data.notes.get(id);
    if (!note || note._purge || note.deleted) no('That test note isn\'t there any more.');
    if (skipWhy(note) === 'locked') no('Wefty never reads a locked note to make flash cards.');
    const name = V.review.testName(note);
    const covers = V.review.coversOf(note);
    if (!covers.length) no(`Say what ${name} covers first: its Test button picks the folders and #tags.`);
    const folders = covers.filter((c) => !c.startsWith('#')).map(liveFolder).filter(Boolean);
    const tags = covers.filter((c) => c.startsWith('#')).map((c) => c.slice(1));
    const outer = folders.filter((f) => !folders.some((g) => g.id !== f.id && O().inside(g.id).has(f.id)));
    const skipped = noneSkipped();
    const targets = [];
    const counted = new Set([id]);
    for (const folder of outer) {
      const target = studyTarget(folder);
      const ids = new Set([folder.id, ...O().inside(folder.id)]);
      const rows = inFolders(ids, skipped, new Set([id, ...(target.id ? [target.id] : [])]));
      for (const row of rows) counted.add(row.id);
      if (target.id) counted.add(target.id);
      haveAlso(target, rows);
      target.sources = rows.filter(readable);
      target.ids = ids;
      targets.push(target);
    }
    if (tags.length) {
      const tagged = [];
      for (const row of V.data.notes.values()) {
        if (row._purge || counted.has(row.id) || targets.some((t) => t.ids.has(row.folder_id))) continue;
        if (!O().tagsOf({ ...titled(row), body: wordsOf(row) || '' }).some((t) => tags.includes(t.key))) continue;
        const why = skipWhy(row);
        if (why) { skipped[why] += 1; continue; }
        tagged.push(row);
      }
      if (tagged.length) {
        let target = targets[0];
        if (!target) {
          const home = liveFolder(note.folder_id) || V.notes.inbox();
          target = home ? studyTarget(home, `${STUDY}: ${name}`, { tags: tags.map((t) => '#' + t), test: id }) : null;
          if (target) targets.push(target);
        }
        if (target) {
          haveAlso(target, tagged);
          target.sources.push(...tagged.filter(readable));
        }
      }
    }
    const with_ = targets.filter((t) => t.sources.length);
    if (!with_.length) {
      no(`There are no notes in what ${name} covers to make cards from yet.${skippedLine(skipped) ? ' ' + skippedLine(skipped) : ''}`);
    }
    return { name, targets: with_, skipped };
  }

  /* The requests one go makes: each target's notes (the most recently edited first, in all at most MOST_LETTERS), in
     pieces of at most CHUNK letters. Sets plan.read, plan.cut and plan.cutNote. */
  function partsOf(plan) {
    const all = [];
    for (const target of plan.targets) for (const row of target.sources) all.push({ target, row });
    all.sort((a, b) => (V.editedAt(b.row) || '').localeCompare(V.editedAt(a.row) || ''));
    let left = MOST_LETTERS;
    const pieces = new Map(plan.targets.map((t) => [t, []]));
    plan.read = 0;
    plan.cut = 0;
    plan.cutNote = false;
    for (const { target, row } of all) {
      if (left <= 0) { plan.cut += 1; continue; }
      const title = plainTitle({ ...titled(row), body: wordsOf(row) });
      let text = `### ${title}\n${String(wordsOf(row) || '').trim()}`;
      if (text.length > left) {
        if (plan.read) { plan.cut += 1; continue; }  // (the next note doesn't fit: left for another go)
        text = text.slice(0, left);
        plan.cutNote = true;
      }
      left -= text.length;
      plan.read += 1;
      // A note longer than a request takes goes in several, cut between lines.
      while (text.length > CHUNK) {
        let at = text.lastIndexOf('\n', CHUNK);
        if (at < CHUNK / 2) at = CHUNK;
        pieces.get(target).push(text.slice(0, at));
        text = `### ${title} (more)\n${text.slice(at).replace(/^\n+/, '')}`;
      }
      pieces.get(target).push(text);
    }
    const parts = [];
    for (const target of plan.targets) {
      let now = '';
      const flush = () => { if (now) parts.push({ target, text: now }); now = ''; };
      for (const piece of pieces.get(target)) {
        if (now && now.length + piece.length + 2 > CHUNK) flush();
        now = now ? `${now}\n\n${piece}` : piece;
      }
      flush();
    }
    for (const part of parts) part.want = Math.max(3, Math.min(PART_CARDS, Math.ceil(part.text.length / 350)));
    return parts;
  }

  /* What the AI is told. */
  function instructions(most) {
    return [
      'You make flash cards for a student from their own notes, for Wefty, their notes app.',
      'Answer with the cards only, one card a line, each in one of these two forms, and nothing else (no title, numbers, '
        + 'bullets, headings, blank lines or other words):',
      '<a question or a term> :: <its short answer>',
      'A sentence with one key word or short phrase in double curly brackets, like: The {{mitochondria}} release energy from food.',
      'Mostly use the first form. Use the second only for a fact best remembered in its sentence (at most one card in four).',
      `Make up to ${most} cards: one for each important fact, term, definition, date, formula or idea. Leave out what isn't `
        + 'worth studying (to-dos, plans, reminders, things to bring).',
      'Use only what the notes say: never add facts, numbers or names that aren\'t in them. Write in the language of the notes.',
      'Each question must make sense on its own, without the notes. Keep each answer short: a few words, or one sentence at most.',
      'Lines in the notes already written as "question :: answer", or with {{ }}, are cards the student already has: never '
        + 'repeat them or ask the same thing another way.',
      'Never write "::" or "{{" anywhere else. If nothing is worth a card, answer with just: NONE',
    ].join('\n');
  }

  /* One request's words: the target's own cards (a study note's, which aren't in the notes read), then the notes. */
  function requestText(part) {
    const own = part.target.extra.slice(0, HAVE_MOST).map((c) => `- ${c.kind === 'qa' ? c.term : c.term.replace(V.study.GAP, '…')}`);
    return [own.length ? `Cards the student already has (never make these again):\n${own.join('\n')}\n` : '',
      'The notes:', '', part.text].filter((s, i) => s || i > 0).join('\n');
  }

  /* -- one go: asking the AI, part by part

     A job keeps what each part gave, so Try again only asks for the parts that didn't come back. */

  function newJob(plan) {
    const parts = partsOf(plan);
    return { plan, parts, at: 0, who: V.ai.brain(), ctl: null, cost: 0 };
  }

  async function run(job, onStep = () => {}) {
    job.ctl = new AbortController();
    const signal = job.ctl.signal;
    for (let i = 0; i < job.parts.length; i++) {
      const part = job.parts[i];
      if (part.done) continue;
      job.at = i;
      onStep();
      const answer = await V.ai.ask({ system: instructions(part.want), text: requestText(part), signal, tallyFree: false,
        onBrain: (who) => { if (job.who !== who) { job.who = who; onStep(); } } });
      if (signal.aborted) throw new V.ai.AiError('stopped', 'Stopped.');
      job.cost += answer.cost || 0;
      part.who = answer.usage && answer.usage.gemini ? 'gemini' : 'claude';
      part.refused = answer.stopReason === 'refusal';
      part.cards = part.refused ? [] : parse(answer.text, answer.stopReason === 'max_tokens');
      part.done = true;
    }
    return made(job);
  }

  /* What came back: [{ target, cards }] (new ones only, MOST_CARDS in all), and how many were already there. One set
     for every target: a test's go reads several folders, and a card already in any of them, or made for another of
     them in this go, would show twice in the test's Review. */
  function made(job) {
    let dupes = 0;
    let room = MOST_CARDS;
    let over = 0;
    const out = [];
    const seen = new Set();
    for (const target of job.plan.targets) for (const key of target.have) seen.add(key);
    for (const target of job.plan.targets) {
      const cards = [];
      for (const part of job.parts) {
        if (part.target !== target) continue;
        for (const card of part.cards || []) {
          const key = keyOf(card);
          if (seen.has(key)) { dupes += 1; continue; }
          seen.add(key);
          if (room <= 0) { over += 1; continue; }
          room -= 1;
          cards.push(card);
        }
      }
      out.push({ target, cards });
    }
    const refused = job.parts.filter((p) => p.refused).length;
    return { lists: out, dupes, over, refused, parts: job.parts.length, count: out.reduce((n, l) => n + l.cards.length, 0) };
  }

  /* -- writing them */

  /* New words (and extra) for note `id`: through the editor when it's the open one (its copy is the one that saves). */
  async function save(id, words, extra = null, lines = []) {
    if (openCopy(id)) {
      V.editor.setWords(words);
      // (an open note that can't take words just now never has its cards said to be added)
      const now = V.editor.words() || '';
      if (lines.some((line) => !now.includes(line))) throw new Error('The open note couldn\'t take the cards just now. Close it and try again.');
      if (extra) await V.editor.update((note) => { note.extra = { ...(note.extra || {}), ...extra }; }, { draw: false });
      await V.editor.settled();
      return;
    }
    const row = V.data.notes.get(id);
    await V.cloud.save('notes', { ...row, body: words, ...(extra ? { extra: { ...(row.extra || {}), ...extra } } : {}) });
  }

  /* The study note's first line: which notes its cards came from. */
  function fromLine(from) {
    const names = from.map((f) => f.title).filter(Boolean);
    const shown = names.slice(0, 8).join(', ');
    return `Made with AI from: ${shown}${names.length > 8 ? ` and ${plural(names.length - 8, 'more note')}` : ''}`;
  }

  /* `target`'s cards written: added to its note, or a new study note made. Returns what was done, for Chat's Undo:
     { type 'cards_add', target, lines, heading, title } or { type 'note_create', target, title, body }, and `added`. */
  async function addTo(target, cards) {
    const sources = target.sources.map((r) => ({ id: r.id, title: plainTitle(titled(r)) }));
    if (target.kind === 'study' && !target.id) {
      // (made meanwhile, here or on another device, while the cards were being picked: added to, never a second one)
      const folder = liveFolder(target.folderId);
      if (!folder) no('That folder isn\'t there any more, so nothing was added.');
      const found = studyNoteIn(folder, target.title, target.test || '');
      if (found) target.id = found.id;
    }
    if (target.id) {
      const row = V.data.notes.get(target.id);
      if (!row || row._purge || row.deleted) no(`"${target.title}" isn't there any more.`);
      if (skipWhy(row) === 'locked') no(`"${target.title}" is locked now, so nothing was added.`);
      if (listening(row.id)) no(`The note-taker is writing into "${target.title}" now. Stop it first, then add the cards.`);
      const words = wordsOf(row);
      const there = keysIn(words);
      const fresh = cards.filter((c) => { const k = keyOf(c); if (there.has(k)) return false; there.add(k); return true; });
      if (!fresh.length) return { added: 0, title: target.title, target: row.id };
      const lines = fresh.map(lineOf);
      const put = withCards(words, lines);
      let text = put.text;
      let extra = null;
      if (target.kind === 'study') {
        const was = (row.extra && row.extra.ai_cards) || {};
        const from = [...(Array.isArray(was.from) ? was.from : [])];
        for (const s of sources) if (!from.some((f) => f && f.id === s.id)) from.push(s);
        extra = { ai_cards: { ...was, folder: target.folderId, from: from.slice(-FROM_MOST), at: new Date().toISOString(),
          ...(target.test ? { test: target.test } : {}) } };
        const all = text.split('\n');
        let at = all.findIndex((line) => FROM_LINE.test(line));
        if (at >= 0) all[at] = fromLine(extra.ai_cards.from); else { all.unshift(fromLine(extra.ai_cards.from), ''); at = 0; }
        // (a test's #tags note keeps its tags, so the test still counts its cards: put back if they were taken out)
        const tagged = new Set(O().tagsOf({ ...row, body: all.join('\n') }).map((t) => t.key));
        const missing = (target.tags || []).filter((t) => !tagged.has(t.slice(1).toLowerCase()));
        if (missing.length) all.splice(at + 1, 0, missing.join(' '));
        text = all.join('\n');
      }
      await save(row.id, text, extra, lines);
      if (V.streak) V.streak.made(fresh.length);  // (a day studied: js/streak.js)
      return { added: fresh.length, title: target.title, target: row.id, type: 'cards_add', lines, heading: put.heading };
    }
    const keys = new Set();
    const fresh = cards.filter((c) => { const k = keyOf(c); if (keys.has(k)) return false; keys.add(k); return true; });
    const body = [fromLine(sources), ...(target.tags && target.tags.length ? [target.tags.join(' ')] : []), '',
      '# Flash cards', ...fresh.map(lineOf)].join('\n');
    const note = await V.cloud.save('notes', V.notes.blankNote({ folder_id: target.folderId, title: target.title, body,
      extra: { ai_cards: { folder: target.folderId, from: sources.slice(-FROM_MOST), at: new Date().toISOString(),
        ...(target.test ? { test: target.test } : {}) } } }));
    target.id = note.id;
    if (V.streak) V.streak.made(fresh.length);
    return { added: fresh.length, title: target.title, target: note.id, type: 'note_create', body };
  }

  /* -- the sheet: reading, then the cards to pick, or what went wrong */

  /* An AiError (or a Refusal) in plain words, and what can be done about it: { words, tryAgain, setUp, settings }. */
  function trouble(error, who) {
    const name = nameOf(who);
    if (error instanceof Refusal) return { words: error.message };
    switch (error && error.kind) {
      case 'nokey':
        return who === 'claude' ? { words: error.message, settings: true }
          : { words: 'Making flash cards uses the free Gemini. It needs a free key from your own Google account: set it up once and it works on all your devices.', setUp: true };
      case 'off': return { words: error.message, settings: true };
      case 'key': return { words: error.message, settings: true };
      case 'offline':
        return { words: !navigator.onLine ? 'You\'re offline. Connect to the internet, then try again.'
          : error.cloud ? 'Couldn\'t reach your cloud just now. Check your connection, then try again.'
            : `Couldn't reach ${name} from this network. Check your connection, then try again.`, tryAgain: true };
      case 'busy':
        return { words: error.why === 'quota' ? 'Google\'s free Gemini limit is used up for now. Try again in a little while.'
          : error.slow ? `${name} is taking too long right now. Try again in a minute.` : `${name} is busy right now. Try again in a minute.`,
        tryAgain: true };
      case 'limit': case 'old': return { words: error.message };
      case 'refusal': return { words: `${name} didn't make cards from these notes.` };
      default: return { words: (error && error.message) || 'Something went wrong. Try again.', tryAgain: true };
    }
  }

  let open = null;  // the sheet showing now (one at a time)

  /* Make flash cards for `scope` ({ note }, { folder } or { test }: an id), with the sheet. */
  function start(scope) {
    if (open) { open.focus(); return null; }
    let plan;
    try {
      plan = scope.note ? noteScope(scope.note) : scope.folder ? folderScope(scope.folder) : testScope(scope.test);
    } catch (error) {
      if (error instanceof Refusal) { V.toast(error.message, { ms: 6000 }); return null; }
      throw error;
    }
    const job = newJob(plan);
    const body = V.h('div.aic');
    const bar = V.h('div.sheet-actions.aic-bar');
    let closed = false;
    const sheet = V.sheet({ title: scope.test ? `Flash cards for ${plan.name}` : `Flash cards from ${plan.name}`, content: body,
      onClose: () => { closed = true; open = null; if (job.ctl) job.ctl.abort(); } });
    sheet.el.classList.add('aic-sheet');
    sheet.el.append(bar);
    const me = { close: sheet.close, focus: () => { const b = bar.querySelector('.btn.primary') || bar.querySelector('.btn'); if (b) b.focus(); } };
    open = me;
    const button = (label, kind, onClick, icon) => V.button(label, { kind, icon, onClick });
    const skipped = skippedLine(plan.skipped);
    const notesRead = () => plan.read || plan.targets.reduce((n, t) => n + t.sources.length, 0);

    const drawWaiting = () => {
      if (closed) return;
      const n = notesRead();
      V.clear(body, V.h('div.aic-state', { role: 'status' }, V.h('div.spinner.big'),
        V.h('h3', { text: 'Making flash cards…' }),
        V.h('p.aic-lead', { text: `${nameOf(job.who)} is reading ${scope.note ? 'your note' : plural(n, 'note')}. This takes a few seconds.` }),
        job.parts.length > 1 ? V.h('p.aic-step.num', { text: `Part ${job.at + 1} of ${job.parts.length}` }) : null,
        skipped ? V.h('p.hint.aic-skipped', { text: skipped }) : null));
      V.clear(bar, button('Cancel', '', () => sheet.close()));
    };

    const drawProblem = (error) => {
      if (closed) return;
      const t = trouble(error, job.who);
      V.clear(body, V.h('div.aic-state.aic-problem', { role: 'alert' }, V.h('span.aic-problem-icon', {}, V.icon('alert')),
        V.h('h3', { text: 'No cards yet' }), V.h('p', { text: t.words })));
      V.clear(bar,
        button('Close', '', () => sheet.close()),
        t.setUp ? button('Set up Gemini', 'primary', () => { sheet.close(); V.ai.setUp('gemini'); }) : null,
        t.settings ? button('Open Settings', t.tryAgain ? '' : 'primary', () => { sheet.close(); V.ai.setUp(job.who === 'claude' ? 'claude' : 'gemini'); }) : null,
        t.tryAgain ? button('Try again', 'primary', () => go(), 'restore') : null);
    };

    const drawCards = (got) => {
      if (closed) return;
      const lines = [];
      if (skipped) lines.push(skipped);
      if (got.dupes) lines.push(`${plural(got.dupes, 'card was', 'cards were')} already there, so ${got.dupes === 1 ? 'it\'s' : 'they\'re'} left out.`);
      if (plan.cut) {
        lines.push(`Read the ${plan.read === 1 ? 'newest note' : `${plan.read} newest notes`} of ${plan.read + plan.cut}: that's as `
          + 'much as one go can take. Make cards for a smaller folder to cover the rest.');
      }
      if (plan.cutNote) lines.push('This is a lot to read, so the cards come from the first part of it.');
      if (got.over) lines.push(`Showing the first ${MOST_CARDS} cards.`);
      if (got.refused && got.refused < got.parts) lines.push(`${nameOf(job.who)} turned down ${plural(got.refused, 'part')} of it.`);
      if (!got.count) {
        V.clear(body, V.h('div.aic-state', { role: 'status' }, V.mark(40),
          V.h('h3', { text: 'No new cards' }),
          V.h('p', { text: got.refused === got.parts ? `${nameOf(job.who)} didn't make cards from these notes.`
            : got.dupes ? 'Every card it made is already there.' : `${nameOf(job.who)} didn't find anything to make cards from.` }),
          lines.filter((l) => !/already there/.test(l)).map((l) => V.h('p.hint', { text: l }))));
        V.clear(bar, button('Close', 'primary', () => sheet.close()));
        return;
      }
      const rows = [];
      const many = got.lists.filter((l) => l.cards.length).length > 1;
      const sections = got.lists.filter((l) => l.cards.length).map((list) => {
        const t = list.target;
        const has = t.kind === 'note' && String(wordsOf(V.data.notes.get(t.id)) || '').split('\n').some((l) => HEADING.test(l));
        const where = t.kind === 'note' ? (has ? 'They go under the note\'s Flash cards heading.'
          : 'They go at the end of the note, under a new Flash cards heading.')
          : t.id ? `They go into "${t.title}".`
            : `They go into a new note, "${t.title}", in ${(liveFolder(t.folderId) || {}).name || 'Inbox'}.`;
        return V.h('section.aic-group', { dataset: { target: t.id || t.title } },
          many ? V.h('h3.aic-into', { text: `Into ${t.title}` }) : null,
          V.h('p.hint.aic-where', { text: where }),
          V.h('div.aic-list', {}, list.cards.map((card) => {
            const n = rows.length + 1;
            const tick = V.h('input.covers-tick.aic-tick', { type: 'checkbox', checked: true, 'aria-label': `Use card ${n}`,
              onchange: () => { row.classList.toggle('off', !tick.checked); count(); } });
            const fields = card.kind === 'blank'
              ? [V.h('textarea.field.aic-blank', { rows: 2, value: card.text, 'aria-label': `Card ${n}, fill in the blank` }),
                V.h('span.aic-kind', { text: 'Fill in the blank: the word in {{ }} is hidden' })]
              : [V.h('textarea.field.aic-q', { rows: 1, value: card.q, 'aria-label': `Card ${n}, question` }),
                V.h('textarea.field.aic-a', { rows: 1, value: card.a, 'aria-label': `Card ${n}, answer` })];
            const row = V.h('div.aic-card', { dataset: { kind: card.kind } }, tick, V.h('div.aic-fields', {}, fields));
            rows.push({ row, tick, card, list });
            return row;
          })));
      });
      const summary = V.h('p.aic-summary', { text: `${plural(got.count, 'new card')} from ${scope.note ? 'this note' : plural(notesRead(), 'note')}.` });
      const all = V.h('button.link-btn.aic-all', { type: 'button', text: 'Untick all', onclick: () => {
        const on = rows.some((r) => r.tick.checked);
        for (const r of rows) { r.tick.checked = !on; r.row.classList.toggle('off', on); }
        count();
      } });
      V.clear(body, V.h('div.aic-top', {}, summary, all), lines.map((l) => V.h('p.hint.aic-note', { text: l })), sections,
        V.h('p.hint.aic-foot', { text: 'Check them over: change any words, and untick the ones you don\'t want.' }));
      const add = button('Add', 'primary', () => addPicked(rows, add), 'cards');
      const count = () => {
        const n = rows.filter((r) => r.tick.checked).length;
        add.lastChild.textContent = `Add ${plural(n, 'card')}`;
        add.disabled = !n;
        all.textContent = n ? 'Untick all' : 'Tick all';
      };
      count();
      V.clear(bar, button('Cancel', '', () => sheet.close()), add);
      requestAnimationFrame(() => { for (const area of body.querySelectorAll('textarea')) grow(area); });
      body.addEventListener('input', (event) => { if (event.target.matches('textarea')) grow(event.target); });
    };

    /* The ticked cards (with their words as they are now) written, each target's into its note. */
    const addPicked = async (rows, add) => {
      if (add.disabled || add.dataset.busy) return;
      const by = new Map();
      let dropped = 0;
      for (const r of rows) {
        if (!r.tick.checked) continue;
        const card = edited(r);
        if (!card) { dropped += 1; continue; }
        if (!by.has(r.list.target)) by.set(r.list.target, []);
        by.get(r.list.target).push(card);
      }
      if (!by.size) { V.toast(dropped ? 'Each card needs a question and an answer (or a word in {{ }}).' : 'Tick at least one card.', { kind: 'err' }); return; }
      add.dataset.busy = '1';
      add.disabled = true;
      add.lastChild.textContent = 'Adding…';
      const done = [];
      try {
        for (const [target, cards] of by) done.push(await addTo(target, cards));
      } catch (error) {
        delete add.dataset.busy;
        add.disabled = false;
        add.lastChild.textContent = 'Add';
        if (error instanceof Refusal) V.toast(error.message, { kind: 'err', ms: 7000 }); else V.problem(error);
        if (!done.length) return;
      }
      sheet.close();
      const added = done.reduce((n, d) => n + d.added, 0);
      if (added) V.emit('study-loop', 'cards');  // (the study loop done once: Today's "Start here" goes, js/starthere.js)
      const first = done.find((d) => d.added);
      const into = done.filter((d) => d.added).length === 1 ? ` to "${first.title}"` : ` to ${plural(done.filter((d) => d.added).length, 'note')}`;
      // What's next is studying them (1.18): the test's cards, or the note they went into (new cards are all due).
      const studyThem = !added || !V.review ? null : scope.test ? () => V.review.start('test:' + scope.test)
        : () => V.review.study(first.target);
      V.toast(added ? `Added ${plural(added, 'flash card')}${into}.${dropped ? ` ${plural(dropped, 'empty card')} left out.` : ''}`
        : 'Those cards were already there, so nothing was added.', studyThem
        ? { ms: 6000, action: 'Study', onAction: studyThem } : { ms: 5000 });
    };

    const go = async () => {
      drawWaiting();
      try {
        const got = await run(job, drawWaiting);
        if (!closed) drawCards(got);
      } catch (error) {
        if (closed || (error && error.kind === 'stopped')) return;
        if (!(error instanceof V.ai.AiError) && !(error instanceof Refusal)) console.warn('Wefty: making flash cards', error);
        drawProblem(error);
      }
    };
    go();
    return me;
  }

  /* A card's words as the sheet shows them now: null when it's no longer a card. */
  function edited(r) {
    if (r.card.kind === 'blank') {
      const text = clean(r.row.querySelector('.aic-blank').value, Q_MOST + A_MOST);
      const card = { kind: 'blank', text };
      return text && V.format.blanks(text).length && !text.includes('::') && V.study.cards(text).length ? card : null;
    }
    const q = clean(r.row.querySelector('.aic-q').value, Q_MOST).replace(/::/g, ':');
    const a = clean(r.row.querySelector('.aic-a').value, A_MOST).replace(/::/g, ':');
    const card = { kind: 'qa', q, a };
    return q && a && V.study.cards(lineOf(card)).length ? card : null;
  }

  /* A text box as tall as its words (where the browser can't do it by itself: field-sizing). */
  function grow(area) {
    if (CSS.supports && CSS.supports('field-sizing', 'content')) return;
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`;
  }

  /* -- for Chat (js/chattools.js): the same, without the sheet. The cards are added at once; what was done comes back
     for the chip's Undo. Throws a Refusal (words for the model) when it can't. */
  async function makeAndAdd(scope, { signal = null } = {}) {
    const plan = scope.note ? noteScope(scope.note) : scope.folder ? folderScope(scope.folder) : testScope(scope.test);
    const job = newJob(plan);
    const stop = () => { if (job.ctl) job.ctl.abort(); };
    if (signal) { if (signal.aborted) no('Stopped before this was done.'); signal.addEventListener('abort', stop, { once: true }); }
    let got;
    try {
      got = await run(job);
    } catch (error) {
      if (error && error.kind === 'stopped') no('Stopped before this was done. Nothing was added.');
      no(`${trouble(error, job.who).words} Nothing was added.`);
    } finally {
      if (signal) signal.removeEventListener('abort', stop);
    }
    const writes = [];
    let trouble_ = '';
    for (const list of got.lists) {
      if (!list.cards.length) continue;
      try {
        writes.push(await addTo(list.target, list.cards));
      } catch (error) {
        if (!writes.some((w) => w.added)) throw error;  // (nothing written yet: the call failed as a whole)
        trouble_ = `Some cards weren't added (${error.message || 'a problem in Wefty'}).`;  // (what was, keeps its Undo)
        break;
      }
    }
    const added = writes.reduce((n, w) => n + w.added, 0);
    if (added) V.emit('study-loop', 'cards');
    return { plan, got, writes: writes.filter((w) => w.added), added, cost: job.cost, who: job.who, trouble: trouble_,
      skipped: skippedLine(plan.skipped), cards: got.lists.flatMap((l) => l.cards).slice(0, 12).map(lineOf) };
  }

  /* -- the ways in */

  const forNote = (id) => start({ note: id });
  const forFolder = (id) => start({ folder: id });
  const forTest = (id) => start({ test: id });

  /* Review's "Make cards with AI": which folder, then that folder's. */
  async function pickFolder() {
    const folder = await V.organise.chooseFolder({ title: 'Make cards from which folder?' });
    if (folder && folder.id) forFolder(folder.id);
  }

  // A note's own tool: shown in a note with words that isn't locked (nor a template).
  // (In the strip, not under + More: the study loop's next step, 1.19.)
  V.editor.addTool({ name: 'aicards', label: 'Make cards with AI', icon: () => V.icon('spark'), keepCaret: false, strip: true,
    onClick: () => { const id = V.editor.openId(); if (id) forNote(id); },
    shown: (note, text) => !note.locked && !O().isTemplate(note) && !!String(text || '').trim() });

  return { forNote, forFolder, forTest, pickFolder, start, makeAndAdd, parse, withCards, withoutCards, keysIn, keyOf,
    instructions, skippedLine, Refusal, waits: { CHUNK, MOST_LETTERS, MOST_CARDS }, showing: () => !!open };
})();
