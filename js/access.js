/* Vault: early access for friends. Two Settings cards:

   "Invite people" (the owner's PC): each friend gets their own private Vault in the owner's free cloud. Python makes
   the account (vault/invites.py) with the project's secret key, which only ever lives in Python (vault/admin.py):
   the page sends it once when it's pasted, and never sees it again. A new account's first password is a one-time
   code; the invite link (or its QR code) signs the friend in with it, and then they choose their own password
   (js/start.js's chooseScreen), which ends the code.

   "Send feedback" (anyone): a bug, an idea or anything else, saved into the sender's OWN file storage as
   <their id>/feedback/<time>-<id>.json (the cloud's locks already allow that; nothing is queued when offline). The
   owner's PC collects everyone's into a Feedback folder of their own (vault/feedback.py), now and then by itself or
   with "Check feedback now". */
'use strict';

V.invites = (() => {
  let state = null;   // { on, invited, email } from the PC
  let people = null;  // the people the owner invited, once asked
  let asking = null;
  let trouble = '';

  const can = (name) => !!(V.desktop && V.pc && V.pc.can(name));

  function refresh(ui) {
    if (asking || !can('invitesState')) return;
    asking = (async () => {
      state = await V.pc.call('invitesState');
      trouble = '';
      people = state.on && !state.invited ? (await V.pc.call('invitesList')).people : null;
    })().catch((error) => {
      trouble = error.message || String(error);
      if (!state) state = { on: false, invited: false, failed: true };
    }).finally(() => { asking = null; if (ui) ui.draw(); });
  }

  const offline = (error) => !navigator.onLine || /fetch|network|internet|reach/i.test(String((error && error.message) || error));

  /* -- turning it on: the secret key, pasted once */

  function turnOnSheet(ui) {
    const box = V.h('input.field', { type: 'password', placeholder: 'sb_secret_...', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Secret key' });
    const problem = V.h('p.error-text');
    const ref = (/^https:\/\/([a-z0-9-]+)\.supabase\.co/i.exec((V.config || {}).url || '') || [])[1];
    const page = ref ? `https://supabase.com/dashboard/project/${ref}/settings/api-keys` : 'https://supabase.com/dashboard';
    let busy = false;
    V.sheet({
      title: 'Turn on invites',
      content: [
        V.h('p', { text: 'To make accounts for friends, Vault needs your cloud\'s secret key once. It stays on this PC, in '
          + 'Jarvis\'s settings file, and is never shown again.' }),
        V.h('ol.steps', {},
          V.h('li', { text: 'Open your vault project\'s API keys page in Supabase.' }),
          V.h('li', { text: 'Under Secret keys, copy the key (it starts with sb_secret_). On an older project it\'s the service_role key.' }),
          V.h('li', { text: 'Paste it here.' })),
        V.h('div.setting-buttons', {}, V.button('Open Supabase', { icon: 'open',
          onClick: () => V.pc.call('openLink', { url: page }).catch(V.problem) })),
        box,
        V.h('p.hint', { text: 'An access token (sbp_...) works too: Vault fetches the key with it once and doesn\'t keep the '
          + 'token. Never give the secret key to anyone: it opens everything in your cloud.' }),
        problem],
      actions: [{ label: 'Cancel' }, { label: 'Turn on', kind: 'primary', onClick: async () => {
        if (busy) return true;
        problem.textContent = '';
        if (!box.value.trim()) { problem.textContent = 'Paste the secret key first.'; return true; }
        busy = true;
        try {
          await V.pc.call('invitesTurnOn', { key: box.value.trim() });
          box.value = '';
          V.toast('Invites are on.');
          state = null;
          people = null;
          ui.draw();
          return false;
        } catch (error) {
          problem.textContent = error.message || String(error);
          return true;
        } finally {
          busy = false;
        }
      } }],
    });
  }

  async function turnOff(ui) {
    const sure = await V.confirm('Turn off invites?', 'This PC forgets your cloud\'s secret key. Everyone you invited keeps '
      + 'their Vault; you just can\'t invite or remove anyone, or collect feedback, until you turn it on again.', { ok: 'Turn off' });
    if (!sure) return;
    try { await V.pc.call('invitesTurnOff'); } catch (error) { V.problem(error); }
    state = null;
    people = null;
    ui.draw();
  }

  /* -- inviting */

  function inviteSheet(ui) {
    const name = V.h('input.field', { type: 'text', placeholder: 'Sam', autocomplete: 'off', maxlength: '60' });
    const email = V.h('input.field', { type: 'email', placeholder: 'sam@example.com', autocomplete: 'off' });
    const problem = V.h('p.error-text');
    let busy = false;
    V.sheet({
      title: 'Invite someone',
      content: [V.h('label.label', {}, 'Their name', name), V.h('label.label', {}, 'Their e-mail', email),
        V.h('p.hint', { text: 'Nothing is e-mailed to them: you send them the invite yourself.' }), problem],
      actions: [{ label: 'Cancel' }, { label: 'Make invite', kind: 'primary', onClick: async () => {
        if (busy) return true;
        problem.textContent = '';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) { problem.textContent = 'Type their e-mail address.'; return true; }
        busy = true;
        try {
          show(await V.pc.call('invitesMake', { name: name.value.trim(), email: email.value.trim() }));
          refresh(ui);
          return false;
        } catch (error) {
          problem.textContent = error.message || String(error);
          return true;
        } finally {
          busy = false;
        }
      } }],
    });
  }

  /* The invite to hand over: the link (and its QR code), and the code itself. */
  function show(made) {
    const first = String(made.name || '').split(' ')[0] || 'them';
    V.sheet({
      title: made.renewed ? `New code for ${made.name}` : `Invite for ${made.name}`,
      wide: true,
      content: [
        V.h('p.invite-what', { text: `Send ${first} this link in a message or an e-mail (or let them scan the code). It opens `
          + 'Vault and signs them in once with the code below; then they choose their own password and the code stops working.' }),
        V.h('div.connect', {}, V.qr(made.link), V.h('div.invite-code-box', {},
          V.h('span.label', { text: 'One-time code' }),
          V.h('div.invite-code', { text: made.code }),
          V.h('p.hint', { text: `For ${made.email}. On a PC, they paste the link into Vault's first screen: "Join with an invite".` }))),
        V.h('div.setting-buttons', {},
          V.button('Copy link', { icon: 'copy', onClick: async () => { await V.copy(made.link); V.toast('Link copied.'); } }),
          V.button('Copy code', { icon: 'copy', onClick: async () => { await V.copy(made.code); V.toast('Code copied.'); } }))],
      actions: [{ label: 'Done', kind: 'primary' }],
    });
  }

  async function remove(ui, person) {
    const who = person.name || person.email;
    const sure = await V.confirm(`Remove ${who}?`, `${who}'s account is deleted with everything in it: their notes, files and `
      + 'clipboard. They can\'t sign in any more, and this can\'t be undone.', { ok: 'Remove', danger: true });
    if (!sure) return;
    try {
      await V.pc.call('invitesRemove', { id: person.id });
      V.toast(`${who} was removed. Their notes are deleted.`);
    } catch (error) {
      V.problem(error);
    }
    refresh(ui);
  }

  function personLine(ui, person) {
    const waiting = person.state === 'waiting';
    const said = waiting ? (person.signedIn ? 'Signed in, hasn\'t chosen a password yet' : `Waiting · invited ${V.ago(person.invitedAt)}`)
      : `Joined${person.signedIn ? ` · last signed in ${V.ago(person.signedIn)}` : ''}`;
    const row = ui.line(person.name || person.email, `${person.email} · ${said}`, V.h('div.setting-buttons', {},
      waiting ? V.button('New code', { onClick: async () => {
        try { show(await V.pc.call('invitesMake', { name: person.name, email: person.email })); } catch (error) { V.problem(error); }
      } }) : null,
      V.button('Remove', { kind: 'danger-quiet', onClick: () => remove(ui, person) })));
    row.classList.add('invite-person');
    row.dataset.state = person.state;
    return row;
  }

  /* Settings' "Invite people" card. `ui` is Settings' own { card, line, toggle, draw }. */
  function card(ui) {
    if ((V.data.user || {}).invited) return null;  // a friend's Vault: invites are the owner's
    if (!V.desktop) {
      return ui.card('Invite people', ui.line('Give friends their own Vault', 'Invites are made in Vault on your PC: '
        + 'Settings > Invite people. Each friend gets a private Vault in your cloud.', null));
    }
    if (!can('invitesState')) return null;  // an older PC part: a Jarvis update brings it
    if (!state) {
      refresh(ui);
      return ui.card('Invite people', ui.line('Checking...', '', null));
    }
    if (state.invited) return null;
    if (!state.on) {
      return ui.card('Invite people', ui.line('Give friends their own Vault', 'Each friend gets a private Vault in your free '
        + 'cloud: nobody sees anyone else\'s notes in the app. Turn this on once with your cloud\'s secret key.',
      V.button('Turn on', { onClick: () => turnOnSheet(ui) })));
    }
    const rows = [ui.line('Invite someone', 'They get a link that signs them in once; then they choose their own password.',
      V.button('Invite', { kind: 'primary', icon: 'plus', onClick: () => inviteSheet(ui) }))];
    if (trouble) {
      rows.push(ui.line('Couldn\'t load the people you invited', offline(trouble) ? 'You\'re offline.' : trouble,
        V.button('Try again', { icon: 'restore', onClick: () => { state = null; ui.draw(); } })));
    }
    for (const person of people || []) rows.push(personLine(ui, person));
    if (people && !people.length) rows.push(ui.line('Nobody yet', 'The people you invite show here.', null));
    rows.push(V.h('div.setting-buttons', {}, V.button('Turn off invites', { kind: 'danger-quiet', onClick: () => turnOff(ui) })));
    return ui.card('Invite people', ...rows);
  }

  return { card, state: () => state, refresh };
})();

V.feedback = (() => {
  const KINDS = [['bug', 'Bug'], ['idea', 'Idea'], ['other', 'Other']];
  const MOST = 4000;
  const OFFLINE = 'Couldn\'t send — try again when online.';
  let draft = { kind: 'bug', text: '', device: true };  // kept while the sheet is closed and opened again
  let checking = false;

  const offline = (error) => !navigator.onLine || /fetch|network|internet|offline|load failed/i.test(String((error && error.message) || error));

  /* One piece of feedback into this person's own storage. Never anything of their notes: only what they wrote, and
     (if they let it) Vault's version, which kind of device, and the browser's own name. */
  async function send({ kind, text, device }) {
    const user = V.data.user || {};
    if (!user.id) throw new Error('Sign in first.');
    const words = String(text || '').trim().slice(0, MOST);
    if (!words) throw new Error('Write something first.');
    if (!navigator.onLine) throw new Error(OFFLINE);
    const id = V.uuid();
    const at = new Date().toISOString();
    const item = { format: 1, id, kind: KINDS.some(([k]) => k === kind) ? kind : 'other', text: words, at };
    if (device) item.device = { version: V.VERSION, kind: V.deviceLabel(V.device), agent: String(navigator.userAgent || '').slice(0, 300) };
    const path = `${user.id}/feedback/${at.replace(/[:.]/g, '-')}-${id.slice(0, 8)}.json`;
    await V.cloud.upload(path, new Blob([JSON.stringify(item)], { type: 'application/json' }), { mime: 'application/json' });
    return path;
  }

  function sheet() {
    const kinds = V.h('div.segmented.feedback-kinds', { role: 'radiogroup', 'aria-label': 'What kind' },
      KINDS.map(([value, label]) => V.h('button', { type: 'button', role: 'radio', 'aria-checked': String(draft.kind === value),
        dataset: { kind: value }, onclick: () => {
          draft.kind = value;
          for (const button of kinds.children) button.setAttribute('aria-checked', String(button.dataset.kind === value));
        } }, V.h('span', { text: label }))));
    const count = V.h('span.feedback-count');
    const box = V.h('textarea.field.feedback-text', { rows: '6', maxlength: String(MOST), 'aria-label': 'Your feedback',
      placeholder: 'What went wrong, or what would make Vault better?', oninput: () => { draft.text = box.value; counted(); } });
    box.value = draft.text;
    const counted = () => { count.textContent = box.value.length > MOST - 500 ? `${box.value.length} / ${MOST}` : ''; };
    counted();
    const device = V.h('input.switch', { type: 'checkbox', checked: draft.device, 'aria-label': 'Include device info',
      onchange: (event) => { draft.device = event.target.checked; } });
    const owner = !(V.data.user || {}).invited;
    let busy = false;
    V.sheet({
      title: 'Send feedback',
      content: [kinds, box, count,
        V.h('div.setting', {}, V.h('div.setting-text', {}, V.h('strong', { text: 'Include device info' }),
          V.h('span', { text: 'Vault\'s version, which kind of device, and the browser\'s name. Never your notes.' })), device),
        V.h('p.hint', { text: owner ? 'It lands in your Feedback folder.' : 'It goes to the person who runs your Vault cloud.' })],
      actions: [{ label: 'Cancel' }, { label: 'Send', kind: 'primary', onClick: async () => {
        if (busy) return true;
        if (!box.value.trim()) { V.toast('Write something first.', { kind: 'err' }); return true; }
        busy = true;
        try {
          await send({ kind: draft.kind, text: box.value, device: draft.device });
          draft = { ...draft, text: '' };
          V.toast('Thanks! Your feedback was sent.');
          return false;
        } catch (error) {
          V.toast(offline(error) ? OFFLINE : `Couldn't send: ${error.message || error}`, { kind: 'err', ms: 5000 });
          return true;
        } finally {
          busy = false;
        }
      } }],
    });
  }

  async function checkNow(ui) {
    checking = true;
    ui.draw();
    try {
      const done = await V.pc.call('feedbackCollect');
      V.toast(done.added ? `${done.added} new in your Feedback folder.` : 'No new feedback.');
      if (done.added) V.cloud.sync();
    } catch (error) {
      V.problem(error);
    } finally {
      checking = false;
      ui.draw();
    }
  }

  /* Settings' "Send feedback" card; on the owner's PC also where everyone's feedback is collected. */
  function card(ui) {
    const rows = [ui.line('Found a bug, or have an idea?', 'Say it here: it only takes a moment.',
      V.button('Write', { icon: 'send', onClick: sheet }))];
    if (V.desktop && !(V.data.user || {}).invited && V.pc && V.pc.can('feedbackCollect')) {
      const invites = V.invites.state();
      if (invites && invites.on) {
        rows.push(ui.line('Feedback from everyone', 'Your PC collects it into your Feedback folder by itself, every half hour.',
          V.button(checking ? 'Checking...' : 'Check feedback now', { icon: 'restore', disabled: checking, onClick: () => checkNow(ui) })));
      } else if (invites && !invites.invited) {
        rows.push(ui.line('Feedback from everyone', 'Feedback from the people you invite arrives in a Feedback folder once '
          + 'invites are turned on (Invite people, above).', null));
      }
    }
    return ui.card('Send feedback', ...rows);
  }

  if (V.desktop) V.on('pc:feedback-in', () => V.cloud.sync());  // the PC just wrote new feedback notes

  return { card, send, sheet };
})();
