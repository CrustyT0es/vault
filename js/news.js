/* Vault: updates for everyone (announcements). The owner of a Vault cloud posts an update (a title, a message, maybe a
   poll and a note to keep) that pops up once on the Vault of everyone else in that cloud, the owner's friends (never on
   the owner's own devices: the helper marks it seen by them as it's posted). Vault's helper in the owner's cloud keeps
   them (vault/functions/vault-admin, version 3: "news", "news-vote", "news-seen" for anyone signed in there,
   "news-post" and "news-delete" for the owner); a phone or a Chromebook asks it with the person's own sign-in, the PC
   through Python (the bridge's newsCall, vault/helper.py's news), which asks it with the PC's. A cloud with no helper,
   or an older one, simply has no updates: nothing pops up, and nothing is said about it.

   Asked when Vault has started (js/start.js's main: never on the setup, sign-in, choose-password or welcome screens)
   and when it comes back to the front, at most every 10 minutes. Each update nobody here has seen yet pops up once,
   oldest first, one at a time, and only at a calm moment: Vault in sight, nothing being typed (no box with the caret
   in it, the open note saved and settled), no other sheet or layer open, no locked note showing. Closed, it's marked
   seen at once on this device (localStorage 'vault-news-seen', per person, so a slow network never shows it twice)
   and told to the helper a moment later (several together); what couldn't be told then is told at the next look.

   Settings: an "Announcements" card (the newest ones, each opened again with a tap) for anyone who has had one, and
   always for the owner, who also sees how many have seen each one and every poll's counts, and can delete one. The
   owner posts from Settings > Friends > Announcements (js/access.js), with the composer here. Every word anyone
   wrote is shown as text only: the message and a note's lines through js/format.js's Read view. */
'use strict';

V.news = (() => {
  const SLUG = 'vault-admin';
  const SINCE = 3;          // the helper's first version with updates (vault/helper.py's NEWS_SINCE)
  const SEEN = 'vault-news-seen';
  const KEEP_SEEN = 200;    // ids kept per person on this device (the helper keeps 50 updates)
  const SHOWN = 10;         // updates listed in Settings
  const PREVIEW = 6;        // a note's first lines in the pop-up
  const ID = /^[0-9a-f]{16}$/;
  // What the owner may write (the helper's own limits, said the same way before anything is sent).
  const MOST = { title: 120, text: 4000, question: 200, option: 80, noteTitle: 200, note: 20000 };
  const OPTIONS = [2, 6];
  const OFFLINE = 'You\'re offline. Try again once you\'re back online.';
  // How long between looks, how soon a calm moment is looked for again, how long seen marks gather before they're
  // told, how long a request may take (tests shorten them).
  const waits = { gap: 10 * 60 * 1000, calm: 1500, seen: 1500, ask: 30000, next: 220 };

  let answer = null;     // the helper's last answer to "news" (null: never had one)
  let trouble = '';      // why the last look failed (only the owner's Settings card says it)
  let asking = null;
  let asked = 0;         // when it was last asked (this device's clock): 'back' asks again only after waits.gap
  let started = false;
  let showing = null;    // the pop-up while it shows: { id, close }
  let resting = false;   // "Got it" with more waiting: the rest come the next time Vault is back in front
  let timer = null;
  let settings = null;   // Settings' { card, line, draw }, to draw the card again when something changes
  const toTell = new Set();  // seen here, not told to the helper yet
  let telling = null;
  let tellTimer = null;
  const seenNow = new Set(); // seen this session (when this browser keeps nothing: a private window)

  const me = () => (V.data.user && V.data.user.id) || '';
  const isOwner = () => !!me() && !V.data.user.invited;
  const letters = (text) => Array.from(String(text || '')).length;  // (an emoji is one letter, as the helper counts)
  const offline = (error) => !navigator.onLine || !!(error && error.offline)
    || /fetch|network|internet|offline|load failed/i.test(String((error && error.message) || error));
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /* Whether this device can ask at all: a PC part new enough for newsCall, or a page connected to a cloud. */
  const can = () => !!me() && (V.desktop ? !!(V.pc && V.pc.can('newsCall')) : !!(V.config && V.config.url && V.cloud.sb));

  /* -- asking the helper */

  /* One request: the PC asks Python; a phone or a Chromebook the helper itself, with the person's own sign-in (never
     a key). A refusal carries the helper's own sentence, its status and code. */
  async function ask(action, args = {}) {
    if (V.desktop) return V.pc.call('newsCall', { action, args });
    const control = new AbortController();
    const stop = setTimeout(() => control.abort(), waits.ask);
    let response;
    try {
      const token = await V.cloud.accessToken();
      response = await fetch(`${V.config.url}/functions/v1/${SLUG}`, { method: 'POST', signal: control.signal,
        headers: { apikey: V.config.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...args, action }) });
    } catch (error) {
      if (error && error.kind === 'signed-out') throw error;
      throw Object.assign(new Error(navigator.onLine ? 'Wefty couldn\'t reach your cloud just now. Try again in a minute.'
        : OFFLINE), { offline: !navigator.onLine });
    } finally {
      clearTimeout(stop);
    }
    const said = await response.json().catch(() => ({}));
    if (response.ok) return said && typeof said === 'object' ? said : {};
    const message = said && typeof said.message === 'string' && said.message ? V.weftyWords(said.message)
      : `Your cloud's helper said ${response.status}.`;
    throw Object.assign(new Error(message), { status: response.status, code: (said && said.error) || '' });
  }

  /* -- what the helper said, as Vault keeps it */

  const words = (value, most) => (typeof value === 'string' ? value : '').slice(0, most);
  const table = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {});

  /* One update as it may be shown (anything else in it is let go). */
  function cleanItem(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID.test(raw.id)) return null;
    const item = { id: raw.id, at: words(raw.at, 40), by: words(raw.by, 80).trim(), title: words(raw.title, 400).trim() || 'An update',
      text: words(raw.text, 8000) };
    const poll = raw.poll;
    if (poll && typeof poll === 'object' && Array.isArray(poll.options) && poll.options.length) {
      item.poll = { question: words(poll.question, 400), options: poll.options.slice(0, OPTIONS[1]).map((one) => words(one, 200)),
        results: poll.results === 'owner' ? 'owner' : 'everyone' };
    }
    const note = raw.note;
    if (note && typeof note === 'object' && typeof note.body === 'string') {
      item.note = { title: words(note.title, 400).trim(), body: words(note.body, 40000) };
    }
    return item;
  }

  function cleanAnswer(raw) {
    return {
      items: (Array.isArray(raw.items) ? raw.items : []).map(cleanItem).filter(Boolean),
      mine: table(raw.mine), results: table(raw.results), seenCounts: table(raw.seenCounts),
      seen: Array.isArray(raw.seen) ? raw.seen.filter((one) => typeof one === 'string') : [],
      owner: !!raw.owner, unavailable: typeof raw.unavailable === 'string' ? raw.unavailable : '',
    };
  }

  /* A poll's counts as the helper gave them, or null: { counts, voters }. */
  function resultsOf(item) {
    const got = answer && answer.results[item.id];
    if (!got || !Array.isArray(got.counts) || got.counts.length !== item.poll.options.length) return null;
    const counts = got.counts.map((n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0));
    return { counts, voters: counts.reduce((all, n) => all + n, 0) };
  }

  const myChoice = (item) => {
    const choice = answer && answer.mine[item.id];
    return Number.isSafeInteger(choice) && item.poll && choice >= 0 && choice < item.poll.options.length ? choice : null;
  };

  /* -- seen on this device */

  function stored() {
    try {
      const all = JSON.parse(localStorage.getItem(SEEN) || '{}');
      return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    } catch (error) {
      return {};
    }
  }

  /* What this person has seen on this device (read again at each look: another tab may have seen one). */
  let here = null;  // { user, ids }
  function seenHere() {
    if (!here || here.user !== me()) {
      const list = stored()[me()];
      here = { user: me(), ids: new Set([...(Array.isArray(list) ? list.filter((one) => typeof one === 'string') : []), ...seenNow]) };
    }
    return here.ids;
  }

  function keepSeen(ident) {
    seenNow.add(ident);
    seenHere().add(ident);
    try {
      const all = stored();
      const list = (Array.isArray(all[me()]) ? all[me()] : []).filter((one) => one !== ident);
      list.push(ident);
      all[me()] = list.slice(-KEEP_SEEN);
      localStorage.setItem(SEEN, JSON.stringify(all));
    } catch (error) { /* a private window: this session remembers it */ }
  }

  /* Seen here: kept on this device now, told to the helper a moment later (with any others closed meanwhile). */
  function seen(ident) {
    keepSeen(ident);
    if (answer && answer.seen.includes(ident)) return;
    toTell.add(ident);
    clearTimeout(tellTimer);
    tellTimer = setTimeout(tell, waits.seen);
  }

  async function tell() {
    if (telling || !toTell.size || !can()) return;
    const ids = [...toTell].slice(0, 50);
    let told = false;
    telling = ask('news-seen', { ids }).then(() => {
      told = true;
      for (const ident of ids) {
        toTell.delete(ident);
        if (answer && !answer.seen.includes(ident)) answer.seen.push(ident);
      }
    }, () => { /* told at the next look, or when the internet is back */ }).finally(() => {
      telling = null;
      if (told && toTell.size) tell();  // (more than one request's worth)
    });
    await telling;
  }

  /* The updates nobody here has seen yet, oldest first. */
  function waiting() {
    if (!answer) return [];
    const kept = seenHere();
    return answer.items.filter((item) => !answer.seen.includes(item.id) && !kept.has(item.id)).reverse();
  }

  /* -- looking */

  /* What the helper has. The owner's phone or Chromebook first reads the note its setup left (as Settings > Invite
     people does), so a cloud without the helper, or with an older one, is never asked: a friend can't read that note,
     so theirs simply asks (a missing helper fails without a word). */
  async function load() {
    if (!V.desktop && isOwner() && V.invites && V.invites.findHelper) {
      const note = await V.invites.findHelper();
      if (!note || Number(note.version) < SINCE) {
        return { items: [], mine: {}, seen: [], results: {}, owner: true, unavailable: note ? 'old' : 'missing' };
      }
    }
    return ask('news');
  }

  /* Asks again (unless it was asked less than waits.gap ago and `now` isn't set). Never says a word when it can't:
     offline, signed out, no helper, an older one. */
  function check(now = false) {
    if (asking) return asking;
    if (!started || !can() || (!now && asked && Date.now() - asked < waits.gap)) return Promise.resolve(answer);
    asked = Date.now();
    here = null;
    asking = load().then((got) => {
      answer = cleanAnswer(got && typeof got === 'object' ? got : {});
      trouble = '';
      // Seen here but not told yet (closed while offline, or on a page that was closed too soon): told now.
      const kept = seenHere();
      for (const item of answer.items) if (kept.has(item.id) && !answer.seen.includes(item.id)) toTell.add(item.id);
      if (toTell.size) tell();
    }, (error) => {
      trouble = offline(error) ? OFFLINE : (error && error.message) || String(error);
    }).finally(() => {
      asking = null;
      redraw();
      soon();
    });
    return asking;
  }

  /* -- a calm moment */

  const app = () => document.getElementById('app');
  const onGate = () => !app().classList.contains('ready') || app().classList.contains('gate');  // setup, sign-in...
  // A sheet, a menu, a note over everything, a drawing, the note-taker (not its bar at the top: js/notetaker.js).
  const layerOpen = () => !!document.querySelector('#layers > :not(.nt-strip):not(.coach[hidden])');
  const NOT_TYPED = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color', 'image'];
  function typing() {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    return el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
      || (el.tagName === 'INPUT' && !NOT_TYPED.includes(String(el.type).toLowerCase()));
  }
  function lockedShowing() {
    const note = V.editor && V.editor.openId() && V.editor.current ? V.editor.current() : null;
    return !!(note && note.locked);
  }
  const quiet = () => started && !showing && !resting && !V.away() && !onGate() && !layerOpen() && !typing()
    && !lockedShowing() && !(V.welcome && V.welcome.pending && V.welcome.pending(me()));

  /* Nothing being typed or saved, nothing over the app (V.editor.settled() also waits for the open note's saves). */
  async function calm() {
    if (!quiet()) return false;
    if (V.editor && V.editor.openId() && !(await V.editor.settled())) return false;
    return quiet();
  }

  /* The next update waiting, at the next calm moment (looked for again every waits.calm while one waits). */
  function soon(ms = waits.calm) {
    clearTimeout(timer);
    timer = null;
    if (!started || showing || resting || !waiting().length) return;
    timer = setTimeout(async () => {
      timer = null;
      if (V.away()) return;  // ('back' looks again)
      if (!(await calm())) { soon(); return; }
      const next = waiting()[0];
      if (next && !showing) popUp(next, { queued: true });
    }, ms);
  }

  /* -- the pop-up */

  /* An update's words (Markdown-ish, as a note's Read view shows them: text only, never HTML made from them). */
  function rendered(text) {
    const { el } = V.format.render(text);
    for (const tick of el.querySelectorAll('.read-tick')) tick.disabled = true;  // only to look at
    return V.reading.area(el);  // (reading text: Quick read's pieces go in when it's on, js/reading.js)
  }

  /* The poll: one button per answer, "Voted" on this person's; once the counts come back, a bar for each. */
  function pollPart(item) {
    const box = V.h('div.news-poll', { role: 'group', 'aria-label': item.poll.question || 'Poll' });
    const problem = V.h('p.error-text', { role: 'alert' });
    let busy = false;
    const owner = isOwner();

    function draw() {
      const mine = myChoice(item);
      const results = resultsOf(item);
      const options = item.poll.options.map((option, i) => {
        const voted = mine === i;
        const kids = [V.h('span.news-option-line', {}, V.h('span.news-option-text', { text: option }),
          voted ? V.h('span.news-voted', {}, V.icon('check'), V.h('span', { text: 'Voted' })) : null,
          results ? V.h('span.news-tally', { text: `${results.counts[i]} · ${results.voters
            ? Math.round((results.counts[i] / results.voters) * 100) : 0}%` }) : null)];
        if (results) {
          const share = results.voters ? (results.counts[i] / results.voters) * 100 : 0;
          kids.push(V.h('span.news-bar', { 'aria-hidden': 'true' }, V.h('i', { style: { width: `${share}%` } })));
        }
        return V.h('button.news-option' + (voted ? '.voted' : '') + (results ? '.counted' : ''), {
          type: 'button', 'aria-pressed': String(voted), disabled: busy, onclick: () => vote(i) }, kids);
      });
      const hint = !owner && item.poll.results === 'owner' ? `Only ${item.by || 'the owner'} sees the results.`
        : results ? plural(results.voters, 'answer') + ' so far.'
          : mine === null ? 'Tap an answer to see what everyone said.' : '';
      V.clear(box, V.h('p.news-question', { text: item.poll.question }), options,
        hint ? V.h('p.hint.news-poll-hint', { text: hint }) : null, problem);
    }

    async function vote(choice) {
      if (busy) return;
      busy = true;
      problem.textContent = '';
      draw();
      try {
        const said = await ask('news-vote', { id: item.id, choice });
        if (answer) {
          Object.assign(answer.mine, table(said.mine));
          Object.assign(answer.results, table(said.results));
        }
        redraw();
      } catch (error) {
        problem.textContent = offline(error) ? OFFLINE : (error && error.message) || String(error);
      } finally {
        busy = false;
        draw();
      }
    }

    draw();
    return box;
  }

  /* A note the owner attached: its title and first lines, and "Save to my notes" (once). */
  function notePart(item) {
    const note = item.note;
    const lines = note.body.split('\n');
    let saved = false;
    const save = V.button('Save to my notes', { icon: 'download', onClick: async () => {
      if (saved) return;
      saved = true;
      save.disabled = true;
      try {
        const home = V.notes.inbox();
        await V.cloud.save('notes', V.notes.blankNote({ folder_id: home ? home.id : null,
          title: note.title || item.title, body: note.body }));
        save.querySelector('span:not(.icon)').textContent = 'Saved';
        V.toast('Saved to Inbox');
      } catch (error) {
        saved = false;
        save.disabled = false;
        V.problem(error);
      }
    } });
    return V.h('div.news-note', {},
      V.h('div.news-note-head', {}, V.icon('notes'), V.h('strong', { text: note.title || 'A note' })),
      V.h('div.news-note-body', {}, rendered(lines.slice(0, PREVIEW).join('\n'))),
      lines.length > PREVIEW ? V.h('p.hint.news-note-more', { text: `and ${plural(lines.length - PREVIEW, 'more line')}` }) : null,
      V.h('div.setting-buttons.news-note-buttons', {}, save));
  }

  /* One update in a sheet. `queued`: popped up by itself, with "Next" when more are waiting (else opened from
     Settings). Closed any way, it's seen. */
  function popUp(item, { queued = false } = {}) {
    const more = queued ? waiting().filter((other) => other.id !== item.id).length : 0;
    let next = false;
    const sheet = V.sheet({
      title: item.title,
      content: [
        V.h('p.news-from', { text: [`From ${item.by || 'the owner'}`, V.ago(item.at)].filter(Boolean).join(' · ') }),
        more ? V.h('p.news-count', { text: `${plural(more, 'more update')} after this one` }) : null,
        item.text.trim() ? V.h('div.news-text', {}, rendered(item.text)) : null,
        item.poll ? pollPart(item) : null,
        item.note ? notePart(item) : null,
      ],
      actions: more ? [{ label: 'Got it' }, { label: 'Next', kind: 'primary', onClick: () => { next = true; } }]
        : [{ label: 'Got it', kind: 'primary' }],
      onClose: () => {
        showing = null;
        seen(item.id);
        if (queued && !next && waiting().length) resting = true;  // the rest: next time Vault is back in front
        redraw();
        soon(next ? waits.next : waits.calm);
      },
    });
    sheet.el.classList.add('news-sheet');
    sheet.el.dataset.news = item.id;
    showing = { id: item.id, close: sheet.close };
    return sheet;
  }

  /* Settings' rows open an update again (seen ones too). */
  function open(ident) {
    const item = answer && answer.items.find((one) => one.id === ident);
    if (item && !showing) popUp(item);
  }

  /* -- the owner: posting and deleting */

  function redraw() { if (settings && settings.draw) settings.draw(); }

  async function remove(item) {
    const sure = await V.confirm('Delete this update?', 'It goes from everyone\'s Wefty, with its poll\'s answers. This '
      + 'can\'t be undone.', { ok: 'Delete', danger: true });
    if (!sure) return;
    try {
      await ask('news-delete', { id: item.id });
      if (answer) answer.items = answer.items.filter((one) => one.id !== item.id);
      V.toast('Deleted.');
    } catch (error) {
      V.problem(offline(error) ? new Error(OFFLINE) : error);
    }
    redraw();
  }

  /* The notes the owner may attach: never a locked note (its words are only ever on their own devices) or a template. */
  function attachable() {
    return [...V.data.notes.values()].filter((n) => !n.deleted && !n._purge && !n.locked
      && !(V.organise && V.organise.isTemplate(n)))
      .sort((a, b) => String(V.editedAt(b) || '').localeCompare(String(V.editedAt(a) || '')));
  }

  /* What the owner wrote, checked as the helper checks it (the same sentences), or a sentence saying what's wrong. */
  function checked(draft) {
    const title = draft.title.trim();
    if (!title) return { problem: 'Give your update a title.', where: 'title' };
    if (letters(title) > MOST.title) return { problem: `Make the title shorter (${MOST.title} letters at most).`, where: 'title' };
    const text = draft.text.trim();
    if (letters(text) > MOST.text) return { problem: 'Make the message shorter (4,000 letters at most).', where: 'text' };
    const sent = { title, text };
    if (draft.poll) {
      const question = draft.poll.question.trim();
      if (!question) return { problem: 'Type the poll\'s question.', where: 'question' };
      if (letters(question) > MOST.question) {
        return { problem: `Make the poll's question shorter (${MOST.question} letters at most).`, where: 'question' };
      }
      const options = draft.poll.options.map((one) => one.trim());
      if (options.length < OPTIONS[0]) return { problem: `Give the poll at least ${OPTIONS[0]} answers to pick from.`, where: 'option' };
      const folded = new Set();
      for (let i = 0; i < options.length; i++) {
        if (!options[i]) return { problem: 'Fill in every answer, or take out the empty one.', where: 'option', at: i };
        if (letters(options[i]) > MOST.option) {
          return { problem: `Make each answer shorter (${MOST.option} letters at most).`, where: 'option', at: i };
        }
        const key = options[i].toLowerCase().replace(/\s+/g, ' ');
        if (folded.has(key)) return { problem: `Each answer has to be different: "${options[i]}" is there twice.`, where: 'option', at: i };
        folded.add(key);
      }
      sent.poll = { question, options, results: draft.poll.results === 'owner' ? 'owner' : 'everyone' };
    }
    if (draft.note) {
      const body = String(draft.note.body || '');
      if (!body.trim()) return { problem: 'The note you attach needs some words in it.', where: 'note' };
      if (letters(body) > MOST.note) return { problem: 'That note is too long to send (20,000 letters at most).', where: 'note' };
      sent.note = { title: Array.from(String(draft.note.title || '').trim()).slice(0, MOST.noteTitle).join(''), body };
    }
    return { sent };
  }

  /* The composer: a title, a message, maybe a poll and a note, then Post. */
  function compose() {
    if (!can()) { V.toast('Updates can\'t be posted from here yet.', { kind: 'err' }); return; }
    const title = V.h('input.field', { type: 'text', maxlength: String(MOST.title * 2), autocomplete: 'off',
      'aria-label': 'Title', placeholder: 'What\'s new?' });
    const text = V.h('textarea.field.news-message', { rows: '4', maxlength: String(MOST.text * 2), 'aria-label': 'Message',
      placeholder: 'Say a bit more (optional)' });
    const problem = V.h('p.error-text', { role: 'alert' });

    // The poll, while there is one.
    let poll = null;  // { question, options, results }
    const pollBox = V.h('div.news-compose-poll');
    const pollButton = V.button('Add a poll', { icon: 'checklist', onClick: () => {
      poll = { question: '', options: ['', ''], results: 'everyone' };
      drawPoll();
      pollBox.querySelector('input').focus();
    } });
    function drawPoll() {
      pollButton.hidden = !!poll;
      if (!poll) { V.clear(pollBox); return; }
      const question = V.h('input.field', { type: 'text', value: poll.question, maxlength: String(MOST.question * 2),
        autocomplete: 'off', 'aria-label': 'Poll question', placeholder: 'Ask something', oninput: () => { poll.question = question.value; } });
      const answers = poll.options.map((value, i) => {
        const box = V.h('input.field', { type: 'text', value, maxlength: String(MOST.option * 2), autocomplete: 'off',
          'aria-label': `Answer ${i + 1}`, placeholder: `Answer ${i + 1}`, oninput: () => { poll.options[i] = box.value; } });
        box.dataset.answer = String(i);
        return V.h('div.news-answer', {}, box, poll.options.length > OPTIONS[0]
          ? V.iconButton('x', `Take out answer ${i + 1}`, () => { poll.options.splice(i, 1); drawPoll(); }, 'quiet') : null);
      });
      const add = V.button('Add an answer', { icon: 'plus', kind: 'quiet', disabled: poll.options.length >= OPTIONS[1], onClick: () => {
        poll.options.push('');
        drawPoll();
        pollBox.querySelector(`[data-answer="${poll.options.length - 1}"]`).focus();
      } });
      const results = V.h('div.segmented.news-results', { role: 'radiogroup', 'aria-label': 'Who sees the results' },
        [['everyone', 'Everyone, after voting'], ['owner', 'Only me']].map(([value, label]) => V.h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(poll.results === value), dataset: { results: value },
          onclick: () => {
            poll.results = value;
            for (const button of results.children) button.setAttribute('aria-checked', String(button.dataset.results === value));
          } }, V.h('span', { text: label }))));
      V.clear(pollBox, V.h('div.news-compose-head', {}, V.h('strong', { text: 'Poll' }),
        V.button('Remove the poll', { kind: 'danger-quiet', onClick: () => { poll = null; drawPoll(); } })),
      question, V.h('div.news-answers', {}, answers), add,
      V.h('span.label.news-results-label', { text: 'Results' }), results);
    }

    // The note, once one is picked (a picker until then).
    let note = null;  // the note row picked
    let picking = false;
    const noteBox = V.h('div.news-compose-note');
    const noteButton = V.button('Attach a note', { icon: 'paperclip', onClick: () => { picking = true; drawNote(); } });
    function drawNote() {
      noteButton.hidden = !!note || picking;
      if (note) {
        V.clear(noteBox, V.h('div.news-chosen', {}, V.icon('notes'), V.h('strong', { text: V.noteTitle(note) }),
          V.iconButton('x', 'Take the note off', () => { note = null; drawNote(); }, 'quiet')));
        return;
      }
      if (!picking) { V.clear(noteBox); return; }
      const list = V.h('div.news-pick-list');
      const find = V.h('input.field', { type: 'search', autocomplete: 'off', 'aria-label': 'Find a note',
        placeholder: 'Find a note', oninput: () => fill() });
      const fill = () => {
        const wanted = find.value.trim().toLowerCase();
        const found = attachable().filter((n) => !wanted || `${V.noteTitle(n)}\n${n.body || ''}`.toLowerCase().includes(wanted)).slice(0, 8);
        V.clear(list, found.length ? found.map((n) => V.h('button.news-pick-item', { type: 'button',
          onclick: () => { note = n; picking = false; drawNote(); } }, V.icon('notes'), V.h('span', { text: V.noteTitle(n) })))
          : V.h('p.hint', { text: wanted ? 'No note matches that.' : 'No notes to attach yet. (Locked notes and templates can\'t be sent.)' }));
      };
      fill();
      V.clear(noteBox, V.h('div.news-compose-head', {}, V.h('strong', { text: 'Attach a note' }),
        V.button('Don\'t attach one', { kind: 'quiet', onClick: () => { picking = false; drawNote(); } })), find, list);
      find.focus();
    }

    // Enter never posts from here (a poll's answers are typed one after another): it goes to the next box instead.
    const panel = { el: null };
    const enter = (event) => {
      if (event.key !== 'Enter' || event.shiftKey || !panel.el || !panel.el.contains(event.target)
        || event.target.tagName !== 'INPUT') return;
      event.stopPropagation();
      event.preventDefault();
      const boxes = [...panel.el.querySelectorAll('.sheet-body input.field, .sheet-body textarea.field')];
      const after = boxes[boxes.indexOf(event.target) + 1];
      if (after) after.focus();
    };
    window.addEventListener('keydown', enter, true);

    let busy = false;
    const sheet = V.sheet({
      title: 'New announcement',
      content: [
        V.h('p', { text: 'It pops up once for everyone else in your Wefty cloud the next time they open Wefty. You can '
          + 'open it again from Settings > Friends.' }),
        V.h('label.label', {}, 'Title', title), V.h('label.label', {}, 'Message', text),
        V.h('div.setting-buttons.news-compose-add', {}, pollButton, noteButton), pollBox, noteBox, problem],
      actions: [{ label: 'Cancel' }, { label: 'Post', kind: 'primary', icon: 'send', onClick: async () => {
        if (busy) return true;
        problem.textContent = '';
        const made = checked({ title: title.value, text: text.value, poll,
          note: note ? { title: V.noteTitle(note), body: note.locked ? '' : note.body || '' } : null });
        if (made.problem) {
          problem.textContent = made.problem;
          const at = made.where === 'title' ? title : made.where === 'text' ? text
            : made.where === 'question' ? pollBox.querySelector('input')
              : made.where === 'option' ? pollBox.querySelector(`[data-answer="${made.at || 0}"]`) : null;
          if (at) at.focus();
          return true;
        }
        busy = true;
        try {
          const said = await ask('news-post', made.sent);
          const item = cleanItem(said && said.item);
          if (item && !answer) answer = cleanAnswer({ owner: true });
          if (item) {
            answer.items = [item, ...answer.items.filter((one) => one.id !== item.id)];
            answer.seen.push(item.id);  // (the owner wrote it: it never pops up for them)
            answer.seenCounts[item.id] = 1;
            if (item.poll) answer.results[item.id] = { counts: item.poll.options.map(() => 0), voters: 0 };
            answer.unavailable = '';
          }
          if (item) keepSeen(item.id);
          V.toast('Posted. Everyone sees it next time they open Wefty.');
          redraw();
          return false;
        } catch (error) {
          problem.textContent = offline(error) ? OFFLINE : (error && error.message) || String(error);
          return true;
        } finally {
          busy = false;
        }
      } }],
      onClose: () => window.removeEventListener('keydown', enter, true),
    });
    sheet.el.classList.add('news-compose');
    panel.el = sheet.el;
    drawPoll();
    drawNote();
    return sheet;
  }

  /* -- Settings */

  function row(item) {
    const owner = isOwner();
    const bits = [`From ${item.by || 'the owner'}`, V.ago(item.at)];
    if (owner) {
      const count = Math.max(0, (Number(answer.seenCounts[item.id]) || 0) - (answer.seen.includes(item.id) ? 1 : 0));
      bits.push(count ? `Seen by ${count}` : 'Not seen yet');  // (other people: the owner's own mark isn't counted)
    }
    if (item.poll) {
      const results = owner ? resultsOf(item) : null;
      if (results) bits.push(item.poll.options.map((option, i) => `${option} ${results.counts[i]}`).join(' · '));
      if (!owner) bits.push(myChoice(item) === null ? 'Not voted' : 'Voted');
    }
    return V.h('div.setting.news-row', { dataset: { news: item.id } },
      V.h('button.news-open', { type: 'button', onclick: () => open(item.id) },
        V.h('span.setting-text', {}, V.h('strong', { text: item.title }), V.h('span', { text: bits.join(' · ') }))),
      owner ? V.button('Delete', { kind: 'danger-quiet', onClick: () => remove(item) }) : null);
  }

  /* Settings' "Announcements" card: anyone who has had one, and always the owner (where this device can ask). */
  function card(ui) {
    settings = ui;
    if (!can()) return null;
    const owner = isOwner();
    const items = answer ? answer.items : [];
    if (!owner && !items.length) return null;
    if (!answer) {
      return ui.card('Announcements', asking || !asked ? ui.line('Checking...', '', null)
        : ui.line('Couldn\'t check for announcements', trouble || 'Try again in a minute.',
          V.button('Try again', { icon: 'restore', onClick: () => { check(true); redraw(); } })));
    }
    const rows = items.slice(0, SHOWN).map(row);
    if (!rows.length) {
      rows.push(ui.line('Nothing posted yet', answer.unavailable
        ? 'Announcements need Wefty\'s helper in your cloud, at its newest version: see Invite people, above.'
        : 'Post an update, a poll or a note for everyone from Invite people, above.', null));
    }
    if (items.length > SHOWN) rows.push(V.h('p.hint', { text: `The newest ${SHOWN} of ${items.length}.` }));
    return ui.card('Announcements', ...rows);
  }

  /* Settings > Friends' Announcements (the owner's): the newest few (each with its ⋯: Open, Delete), then "All
     announcements (N)" in a sheet. Rows only (js/access.js puts them under New announcement); [] when there's
     nothing to show yet, or this device can't ask. */
  const FEW = 3;
  function ownerRow(item) {
    const count = Math.max(0, (Number(answer.seenCounts[item.id]) || 0) - (answer.seen.includes(item.id) ? 1 : 0));
    const bits = [V.ago(item.at), count ? `Seen by ${count}` : 'Not seen yet'];
    const results = item.poll ? resultsOf(item) : null;
    if (results) bits.push(item.poll.options.map((option, i) => `${option} ${results.counts[i]}`).join(' · '));
    const more = V.iconButton('more', `${item.title}: open or delete`, () => V.menu(more, [
      { label: 'Open it again', icon: 'open', onClick: () => open(item.id) },
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => remove(item) },
    ], { label: item.title, returnFocus: true }), 'quiet');
    return V.h('div.setting.news-row', { dataset: { news: item.id } },
      V.h('button.news-open', { type: 'button', onclick: () => open(item.id) },
        V.h('span.setting-text', {}, V.h('strong', { text: item.title }), V.h('span', { text: bits.join(' · ') }))),
      more);
  }

  function rows(ui) {
    settings = ui;
    if (!can() || !isOwner()) return [];
    if (!answer) {
      return [asking || !asked ? ui.line('Checking for announcements...', '', null)
        : ui.line('Couldn\'t check for announcements', trouble || 'Try again in a minute.',
          V.button('Try again', { icon: 'restore', onClick: () => { check(true); redraw(); } }))];
    }
    const items = answer.items;
    if (!items.length) {
      return [ui.line('Nothing posted yet', answer.unavailable ? 'Announcements need Wefty\'s helper in your cloud, at its '
        + 'newest version: see Invite people, above.' : 'What you post shows here.', null)];
    }
    const out = items.slice(0, FEW).map(ownerRow);
    if (items.length > FEW) {
      out.push(V.h('button.invite-all.news-all', { type: 'button', onclick: () => V.sheet({
        title: 'Announcements', content: V.h('div.news-everything', {}, items.map(ownerRow)), actions: [{ label: 'Done' }] }) },
      V.h('span', { text: `All announcements (${items.length})` }), V.icon('chevron')));
    }
    return out;
  }

  /* How many announcements this person hasn't seen yet (a friend's About & feedback line); 0 until asked. */
  function unseenCount() {
    if (!answer || !Array.isArray(answer.items) || !Array.isArray(answer.seen)) return 0;
    return answer.items.filter((item) => !answer.seen.includes(item.id)).length;
  }

  /* -- starting (js/start.js's main, once the app shows) */

  function start() {
    if (started) return;
    started = true;
    V.on('back', () => {
      resting = false;
      check();
      soon();
    });
    window.addEventListener('online', () => {
      if (trouble) check(true);
      if (toTell.size) tell();
    });
    // A calm moment may come sooner than the next look: a sheet closing, a note left, the caret taken out of a box.
    V.on('tab', () => soon());
    V.on('note-left', () => soon());
    document.addEventListener('focusout', () => { if (!timer) soon(); }, true);
    check(true);
  }

  return { start, check, card, rows, unseenCount, compose, open, waits, state: () => answer, SINCE };
})();
