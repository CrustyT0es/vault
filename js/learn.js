/* Vault: Learn mode (like Quizlet's Learn), for a note's flash cards (its Learn button), a folder, a #tag or everything
   (the Review page). The cards go in groups of seven, each group through three rounds: pick the answer out of four,
   then true or false, then type it. A miss comes back at the end of its round. Typing forgives capitals, accents,
   punctuation, spaces and a typo or two (more in a longer answer), but never a wrong number or date; "I was right"
   takes an answer it didn't. The wrong choices are other cards' answers from the same deck (from other notes when
   it hasn't enough). It all feeds each card's schedule (js/review.js): a miss anywhere counts as "Not yet", a right
   typed answer as "I knew it", saved in batches like Review's. All on this device: no AI, no internet needed. */
'use strict';

V.learn = (() => {
  const RV = V.review;
  const GROUP = 7;
  const ROUNDS = [
    { kind: 'choice', title: 'Pick the answer' },
    { kind: 'truth', title: 'True or false?' },
    { kind: 'type', title: 'Type the answer' },
  ];

  /* -- checking a typed answer */

  /* Words as compared: no accents, capitals or punctuation, and no "the", "a" or "an" in front. */
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

  /* Whether `typed` says `answer`: { right, typo (right, but not as written) }. */
  function check(typed, answer) {
    const a = fold(typed);
    const b = fold(answer);
    if (!a || !b) return { right: false, typo: false };
    const numbers = (text) => (text.match(/\p{N}+/gu) || []).join(' ');
    if (numbers(a) !== numbers(b)) return { right: false, typo: false };  // 1945 isn't 1946, however close
    const x = a.replace(/ /g, '');
    const y = b.replace(/ /g, '');
    const right = x === y || distance(x, y, slack(y.length)) <= slack(y.length);
    return { right, typo: right && String(typed).trim().toLowerCase() !== String(answer).trim().toLowerCase() && x !== y };
  }

  /* -- the wrong choices */

  /* Up to `count` answers that aren't this card's: the deck's own first (cards of the same kind before the others),
     then other notes'. */
  function wrongOnes(card, deck, count = 3) {
    const seen = new Set([fold(card.answer)]);
    const fresh = (list) => RV.shuffle(list).filter((c) => {
      const said = fold(c.answer);
      if (!said || seen.has(said)) return false;
      seen.add(said);
      return true;
    });
    const mine = new Set(deck.map((c) => c.id));
    const here = deck.filter((c) => c.id !== card.id);
    const elsewhere = RV.all().filter((c) => !mine.has(c.id));
    const alike = (c) => c.kind === card.kind;
    return [...fresh(here.filter(alike)), ...fresh(here.filter((c) => !alike(c))), ...fresh(elsewhere.filter(alike)),
      ...fresh(elsewhere.filter((c) => !alike(c)))].slice(0, count).map((c) => c.answer);
  }

  /* -- a session */

  /* A note's cards (its Learn button), as they're written now. */
  function forNote(id) {
    const row = V.data.notes.get(id);
    if (!row) return null;
    const words = V.editor.openId() === id && V.editor.words() !== null ? V.editor.words() : row.body;
    const list = RV.cardsOf(row, words);
    if (!list.length) return V.toast('Write cards as "term :: definition" (or "The {{word}} in a sentence"), then press Learn.');
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

  function start({ title, list, deck = 'all' }) {
    const cards = [...list];
    if (!cards.length) return null;
    // With nothing to choose between (one card in all of Vault), only the typing round.
    const rounds = wrongOnes(cards[0], cards, 1).length ? ROUNDS : ROUNDS.filter((r) => r.kind === 'type');
    const groups = [];
    for (let i = 0; i < cards.length; i += GROUP) groups.push(cards.slice(i, i + GROUP));
    let group = 0;
    let round = 0;
    let queue = [];
    let asked = null;   // { card, kind, options, claim, truth }
    let answered = null; // after an answer: { right, typo, picked }
    let steps = 0;      // answers right so far (each card counts once a round)
    let learned = 0;
    let after = null;    // what Continue does
    let wait = null;     // the timer that moves on after a right answer
    const missed = new Set();
    const many = new Set(cards.map((c) => c.note)).size > 1;  // cards from several notes say which one
    const ui = {
      round: V.h('p.learn-round', { 'aria-live': 'polite' }),
      count: V.h('span.learn-count'),
      fill: V.h('i'),
      body: V.h('div.learn-body'),
    };

    function begin() {
      queue = RV.shuffle(groups[group]);
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
        if (group < groups.length) return begin();
        return finish();
      }
      const card = queue[0];
      const kind = rounds[round].kind;
      asked = { card, kind };
      if (kind === 'choice') asked.options = RV.shuffle([card.answer, ...wrongOnes(card, cards, 3)]);
      if (kind === 'truth') {
        const wrong = wrongOnes(card, cards, 1)[0];
        asked.truth = !wrong || Math.random() < 0.5;
        asked.claim = asked.truth ? card.answer : wrong;
      }
      draw();
    }

    /* The question's own words: a blank's sentence with its gap (or, for true or false, with the answer to judge). */
    function prompt(card, claim = null) {
      if (card.kind !== 'blank') return [V.h('span.learn-term', { text: card.term }),
        claim === null ? null : V.h('span.learn-claim', {}, V.h('span.learn-claim-label', { text: 'Answer' }), V.h('span', { text: claim }))];
      return V.h('span.learn-term', {}, claim === null ? RV.question(card)
        : [card.before, V.h('mark.blank-fill', { text: claim }), card.after]);
    }

    function draw() {
      const total = cards.length * rounds.length;
      ui.fill.style.width = `${(100 * steps) / total}%`;
      ui.count.textContent = `${learned} of ${cards.length} learned`;
      if (!asked) return;
      const { card, kind } = asked;
      const meta = rounds[round];
      ui.round.textContent = `Round ${round + 1} of ${rounds.length} · ${meta.title}`;
      const row = V.data.notes.get(card.note);
      const from = many && row ? V.noteTitle(row) : '';
      const head = V.h('div.learn-card', {}, from ? V.h('span.flash-side', { text: from }) : null, prompt(card, kind === 'truth' ? asked.claim : null));
      let answer = null;
      if (kind === 'choice') {
        answer = V.h('div.learn-options', { role: 'group', 'aria-label': 'Choices' }, asked.options.map((option, i) => {
          const state = !answered ? '' : option === card.answer ? '.right' : option === answered.picked ? '.wrong' : '.faded';
          return V.h('button.learn-option' + state, { type: 'button', disabled: !!answered, onclick: () => pick(option) },
            V.h('span.learn-key', { text: String(i + 1) }), V.h('span.learn-option-text', { text: option }));
        }));
      } else if (kind === 'truth') {
        const mark = (value) => (!answered ? '' : value === asked.truth ? '.right' : value === answered.picked ? '.wrong' : '.faded');
        answer = V.h('div.learn-options.two', { role: 'group', 'aria-label': 'True or false' },
          V.h('button.learn-option' + mark(true), { type: 'button', disabled: !!answered, onclick: () => pick(true) },
            V.h('span.learn-key', { text: 'T' }), V.h('span.learn-option-text', { text: 'True' })),
          V.h('button.learn-option' + mark(false), { type: 'button', disabled: !!answered, onclick: () => pick(false) },
            V.h('span.learn-key', { text: 'F' }), V.h('span.learn-option-text', { text: 'False' })));
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
    }

    function feedback() {
      if (!answered) return null;
      const { card, kind } = asked;
      const continueButton = V.button('Continue', { kind: 'primary', onClick: () => after && after() });
      if (answered.right) {
        const said = answered.typo ? `Right! It's written "${card.answer}".` : 'Right!';
        return V.h('div.learn-feedback.ok', { role: 'status' }, V.icon('check'), V.h('span.learn-said', { text: said }),
          kind === 'type' ? continueButton : null);
      }
      const word = kind === 'truth' ? (asked.truth ? 'It\'s true: the answer is right.' : `It's false: the answer is "${card.answer}".`)
        : `The answer is "${card.answer}".`;
      return V.h('div.learn-feedback.err', { role: 'status' }, V.icon('alert'),
        V.h('span.learn-said', {}, V.h('strong', { text: kind === 'type' ? 'Not quite. ' : 'Not this time. ' }), word),
        V.h('div.learn-feedback-actions', {},
          kind === 'type' ? V.button('I was right', { kind: 'quiet', onClick: () => overrule() }) : null,
          continueButton));
    }

    /* A right answer moves on by itself (the typed one when Continue is pressed); a wrong one when Continue is. */
    function right(typo = false, picked = null) {
      const card = queue.shift();
      steps++;
      answered = { right: true, typo, picked };
      if (asked.kind === 'type') RV.grade(card, RV.GOOD);
      after = ask;
      draw();
      if (asked.kind !== 'type') wait = setTimeout(() => { if (answered && answered.right && sheet.el.isConnected) ask(); }, 650);
    }

    function wrong(picked) {
      const card = queue[0];
      answered = { right: false, picked, first: !missed.has(card.id) };
      missed.add(card.id);
      if (asked.kind !== 'type') RV.grade(card, RV.AGAIN);
      after = () => {
        if (asked.kind === 'type') RV.grade(card, RV.AGAIN);
        queue.push(queue.shift());  // it comes back at the end of this round
        ask();
      };
      draw();
    }

    function pick(option) {
      if (answered || !asked) return;
      const correct = asked.kind === 'truth' ? option === asked.truth : option === asked.card.answer;
      if (correct) right(false, option);
      else wrong(option);
    }

    function typed(text) {
      if (answered || !asked || !String(text || '').trim()) return;
      const result = check(text, asked.card.answer);
      if (result.right) right(result.typo, text);
      else wrong(text);
    }

    /* "I was right": the typed answer counts after all. */
    function overrule() {
      if (!answered || answered.right) return;
      const { picked, first } = answered;
      if (first) missed.delete(asked.card.id);
      answered = null;
      right(false, picked);
    }

    function finish() {
      asked = null;
      ui.fill.style.width = '100%';
      ui.round.textContent = 'All done';
      ui.count.textContent = `${cards.length} of ${cards.length} learned`;
      V.clear(ui.body, V.h('div.learn-card.end', {},
        V.h('span.flash-side', { text: 'All done' }),
        V.h('span.learn-term', { text: `You learned all ${cards.length} card${cards.length === 1 ? '' : 's'}.` }),
        V.h('span.hint', { text: missed.size ? `${missed.size} needed another go: they come back for review tomorrow.`
          : 'Every one right the first time. Nice work!' })),
      V.h('div.study-actions', {},
        V.button('Learn again', { icon: 'learn', onClick: () => { sheet.close(); start({ title, list, deck }); } }),
        V.button('Close', { kind: 'primary', onClick: () => sheet.close() })));
    }

    const keys = (event) => {
      if (!ui.body.isConnected || event.ctrlKey || event.metaKey || event.altKey) return;
      const inField = event.target.closest('input, textarea, select');
      if (event.key === 'Enter' && answered && after && !event.target.closest('button')) {
        event.preventDefault();
        after();
        return;
      }
      if (inField || answered || !asked) return;
      if (asked.kind === 'choice' && /^[1-4]$/.test(event.key) && asked.options[Number(event.key) - 1] !== undefined) {
        event.preventDefault();
        pick(asked.options[Number(event.key) - 1]);
      } else if (asked.kind === 'truth' && /^[tf]$/i.test(event.key)) {
        event.preventDefault();
        pick(event.key.toLowerCase() === 't');
      }
    };
    document.addEventListener('keydown', keys);
    const sheet = V.sheet({
      title,
      wide: true,
      content: [V.h('div.learn-top', {}, ui.round, ui.count), V.h('span.bar.study-bar', {}, ui.fill), ui.body],
      onClose: () => {
        clearTimeout(wait);
        document.removeEventListener('keydown', keys);
        // A typed miss closed without Continue (or "I was right") still counts.
        if (answered && !answered.right && asked && asked.kind === 'type') RV.grade(asked.card, RV.AGAIN);
        RV.flush();
      },
    });
    begin();
    return sheet;
  }

  return { fold, distance, slack, check, wrongOnes, forNote, forDeck, start, GROUP };
})();
