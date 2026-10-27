/* Vault: the Send tab. Files, links and bits of text between the PC and the phone.

   A file goes to the "vault" bucket at <owner>/transfers/<id>/<name>, then gets a transfers row saying who it's for.
   Files picked while offline wait in V.db's "outgoing" and go when the internet's back. On the PC, a file sent to it
   is saved into Downloads\Vault by the app itself (V.pc saveFile) and marked received; on the phone it waits in the
   list with Open / Save / Share. Android's share sheet hands files to Vault through sw.js ("shared"). */
'use strict';

V.send = (() => {
  const MAX = 50 * 1024 * 1024;
  const FREE_SPACE = 1024 * 1024 * 1024;
  const progress = new Map();   // outgoing id -> 0..1
  const saving = new Set();     // incoming ids the PC is saving now
  let root = null;
  let parts = null;
  let queueRunning = false;
  let retry = null;
  const trouble = new Map();  // outgoing id -> why the last try didn't go

  const mine = () => [...V.data.transfers.values()].filter((t) => !t.deleted)
    .sort((a, b) => (b.created_at || b._edited || '').localeCompare(a.created_at || a._edited || ''));
  const incoming = () => mine().filter((t) => t.to_device === V.device);
  const unseen = () => incoming().filter((t) => !t.received_at).length;

  /* -- sending */

  async function files(list, { to = V.other } = {}) {
    const picked = [...list];
    const big = picked.filter((f) => f.size > MAX);
    if (big.length) V.toast(`${big[0].name} is over 50 MB, the most the free cloud takes.`, { kind: 'err', ms: 6000 });
    for (const file of picked.filter((f) => f.size <= MAX)) {
      await V.db.put('outgoing', {
        id: V.uuid(), name: file.name || 'file', size: file.size, mime: file.type || 'application/octet-stream',
        blob: file, to, at: new Date().toISOString(),
      });
    }
    draw();
    runQueue();
  }

  async function runQueue() {
    if (queueRunning || !V.data.user) return;
    queueRunning = true;
    try {
      for (const item of await V.db.all('outgoing')) {
        if (!navigator.onLine) break;
        const path = `${V.data.user.id}/transfers/${item.id}/${V.storageName(item.name)}`;
        progress.set(item.id, 0);
        draw();
        try {
          await V.cloud.upload(path, item.blob, {
            mime: item.mime, onProgress: (share) => { progress.set(item.id, share); drawQueue(); },
          });
          await V.cloud.save('transfers', {
            id: item.id, kind: 'file', name: item.name.slice(0, 500), path, size: item.size, mime: item.mime,
            text: '', from_device: V.device, to_device: item.to, received_at: null, deleted: false, extra: {},
            created_at: item.at,
          });
          await V.db.del('outgoing', item.id);
          trouble.delete(item.id);
          V.toast(`Sent ${item.name} to ${item.to === 'pc' ? 'your PC' : 'your phone'}`);
        } catch (error) {
          if (/50 MB/.test(error.message)) {
            await V.db.del('outgoing', item.id);
            V.problem(error);
            continue;
          }
          trouble.set(item.id, navigator.onLine ? 'Didn\'t go through: trying again in 30 seconds' : 'Waiting for the internet');
          // A hiccup (the cloud busy, a weak signal): try again by itself rather than wait for the next send.
          clearTimeout(retry);
          if (navigator.onLine) retry = setTimeout(runQueue, 30000);
          break;
        } finally {
          progress.delete(item.id);
        }
      }
    } finally {
      queueRunning = false;
      draw();
    }
  }

  async function text(words, { to = V.other, name = '' } = {}) {
    const clean = String(words || '').trim();
    if (!clean) return;
    const link = V.isLink(clean);
    await V.cloud.save('transfers', {
      id: V.uuid(), kind: link ? 'link' : 'text', name: (name || clean.split('\n')[0]).slice(0, 120),
      path: null, size: 0, mime: '', text: clean.slice(0, 200000), from_device: V.device, to_device: to,
      received_at: null, deleted: false, extra: {}, created_at: new Date().toISOString(),
    });
    V.toast(`Sent to ${to === 'pc' ? 'your PC' : 'your phone'}`);
  }

  async function remove(transfer) {
    if (transfer.path) V.cloud.remove([transfer.path]).catch(() => {});
    await V.cloud.save('transfers', { ...transfer, deleted: true });
  }

  /* -- receiving */

  async function received(transfer, extra = {}) {
    if (transfer.received_at && !Object.keys(extra).length) return;
    const now = V.data.transfers.get(transfer.id) || transfer;
    await V.cloud.save('transfers', { ...now, received_at: now.received_at || new Date().toISOString(),
      extra: { ...(now.extra || {}), ...extra } });
  }

  /* The PC saves what the phone sends by itself, into Downloads\Vault. */
  async function saveOnPc(transfer) {
    if (saving.has(transfer.id)) return;
    saving.add(transfer.id);
    draw();
    try {
      const url = await V.cloud.link(transfer.path);
      const answer = await V.pc.call('saveFile', { id: transfer.id, url, name: transfer.name || 'file' });
      await received(transfer, { saved: answer.path });
      V.pc.notify('From your phone', `${transfer.name} is in ${answer.folder || 'Downloads'}`);
    } catch (error) {
      V.problem(error);
    } finally {
      saving.delete(transfer.id);
      draw();
    }
  }

  const announced = new Set();  // each arrival is told about once, however often the cloud sends it again

  function arrived(list) {
    for (const t of list) {
      if (t.to_device !== V.device || t.received_at || t.deleted) continue;
      if (V.desktop && t.kind === 'file') saveOnPc(t);
      else if (announced.has(t.id)) continue;
      else if (V.desktop) {
        announced.add(t.id);
        received(t);
        V.pc.notify(t.kind === 'link' ? 'A link from your phone' : 'Text from your phone', t.text.slice(0, 200));
      } else if (Date.now() - new Date(t.created_at || 0).getTime() < 10 * 60000) {
        announced.add(t.id);
        V.toast(`${t.kind === 'file' ? t.name : t.kind === 'link' ? 'A link' : 'Some text'} from your PC`,
          { action: 'Show', onAction: () => V.go('send') });
      }
    }
    V.emit('badge');
  }

  async function openOnPhone(transfer, how) {
    try {
      if (how === 'share' && navigator.share) {
        const response = await fetch(await V.cloud.link(transfer.path));
        const blob = await response.blob();
        const file = new File([blob], transfer.name || 'file', { type: transfer.mime || blob.type });
        if (navigator.canShare && !navigator.canShare({ files: [file] })) throw new Error('This phone can\'t share that kind of file.');
        await navigator.share({ files: [file], title: transfer.name });
      } else {
        const url = await V.cloud.link(transfer.path, how === 'save' ? { download: transfer.name || 'file' } : {});
        if (how === 'save') {
          const a = V.h('a', { href: url, download: transfer.name || 'file', rel: 'noopener' });
          document.body.append(a); a.click(); a.remove();
        } else window.open(url, '_blank', 'noopener');
      }
      await received(transfer);
    } catch (error) {
      if (error.name !== 'AbortError') V.problem(error);
    }
  }

  /* -- what Android's share sheet handed over (sw.js keeps it in V.db "shared") */

  async function takeShared() {
    const shared = await V.db.all('shared');
    if (!shared.length) return;
    await V.db.clear('shared');
    const all = shared.flatMap((s) => s.files || []);
    const words = shared.map((s) => [s.title, s.text, s.url].filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
    const content = [
      all.length ? V.h('ul.shared-list', {}, all.map((f) => V.h('li', {}, V.icon(f.type.startsWith('image/') ? 'image' : 'file'),
        V.h('span', { text: f.name }), V.h('span.muted', { text: V.size(f.size) })))) : null,
      words ? V.h('p.shared-text', { text: words.slice(0, 500) }) : null,
    ];
    V.sheet({
      title: 'Shared with Vault', content,
      actions: [
        { label: 'Save as a note', onClick: async () => {
          V.go('notes');
          await V.notes.create(V.TEMPLATES[0], {
            title: (shared[0].title || '').slice(0, 200), body: [shared[0].text, shared[0].url].filter(Boolean).join('\n'),
          });
          if (all.some((f) => f.type.startsWith('image/'))) await V.editor.addPictures(all);
        } },
        { label: 'Send to PC', kind: 'primary', icon: 'send', onClick: async () => {
          V.go('send');
          if (all.length) await files(all, { to: 'pc' });
          if (words) await text(words, { to: 'pc' });
        } },
      ],
    });
  }

  /* -- drawing */

  function row(t) {
    const out = t.from_device === V.device;
    const kindIcon = t.kind === 'link' ? 'link' : t.kind === 'text' ? 'text' : (t.mime || '').startsWith('image/') ? 'image' : 'file';
    const status = out
      ? (t._dirty ? 'Sending...' : t.received_at ? (V.desktop ? 'Opened on your phone' : 'Saved on your PC') : `Waiting for ${V.otherName}`)
      : (saving.has(t.id) ? 'Saving...' : V.desktop && t.extra && t.extra.saved ? 'In your Downloads' : t.received_at ? 'Received' : 'New');
    const arrived = out ? !!t.received_at && !t._dirty : !!t.received_at && !saving.has(t.id);
    const actions = [];
    if (t.kind === 'file' && !out) {
      if (V.desktop) {
        if (t.extra && t.extra.saved) {
          actions.push(V.button('Open', { icon: 'open', onClick: () => V.pc.call('openFile', { path: t.extra.saved }).catch(V.problem) }));
          actions.push(V.button('Show in folder', { icon: 'folder', onClick: () => V.pc.call('showFile', { path: t.extra.saved }).catch(V.problem) }));
        } else actions.push(V.button('Save', { icon: 'download', onClick: () => saveOnPc(t) }));
      } else {
        actions.push(V.button('Open', { icon: 'open', kind: 'primary', onClick: () => openOnPhone(t, 'open') }));
        actions.push(V.button('Save', { icon: 'download', onClick: () => openOnPhone(t, 'save') }));
        if (navigator.share) actions.push(V.button('Share', { icon: 'share', onClick: () => openOnPhone(t, 'share') }));
      }
    }
    if (t.kind !== 'file') {
      actions.push(V.button('Copy', { icon: 'copy', onClick: async () => { await V.copy(t.text); V.toast('Copied'); if (!out) received(t); } }));
      if (t.kind === 'link') actions.push(V.button('Open', { icon: 'open', onClick: () => {
        if (V.desktop) V.pc.call('openLink', { url: t.text }).catch(V.problem); else window.open(t.text, '_blank', 'noopener');
        if (!out) received(t);
      } }));
    }
    actions.push(V.iconButton('trash', 'Delete', () => remove(t), 'quiet'));
    return V.h('div.transfer' + (out ? '.out' : '.in') + (!out && !t.received_at ? '.fresh' : ''), {},
      V.h('div.t-icon', {}, V.icon(kindIcon)),
      V.h('div.t-main', {},
        V.h('div.t-name', { text: t.kind === 'file' ? t.name : (t.kind === 'link' ? t.text : t.name || t.text) }),
        t.kind === 'text' && t.text.length > (t.name || '').length ? V.h('div.t-text', { text: t.text.slice(0, 600) }) : null,
        V.h('div.t-meta', {},
          V.h('span.t-dir', {}, V.icon(out ? 'up-right' : 'down-left'), (out ? 'To ' : 'From ') + V.otherName),
          t.size ? V.h('span', { text: V.size(t.size) }) : null,
          V.h('span', { text: V.ago(t.created_at || t._edited) }),
          V.h('span.t-status' + (arrived ? '.ok' : ''), {}, arrived ? V.icon('check') : null, status))),
      V.h('div.t-actions', {}, actions));
  }

  function drawQueue() {
    if (!parts) return;
    V.db.all('outgoing').then((waiting) => {
      V.clear(parts.queue, waiting.length ? V.h('h2.section', { text: navigator.onLine ? 'Sending' : 'Waiting for the internet' }) : null,
        waiting.map((item) => V.h('div.transfer.out.pending', {},
          V.h('div.t-icon', {}, V.icon(item.mime.startsWith('image/') ? 'image' : 'file')),
          V.h('div.t-main', {}, V.h('div.t-name', { text: item.name }),
            V.h('div.bar', {}, V.h('i', { style: { width: Math.round(100 * (progress.get(item.id) || 0)) + '%' } })),
            V.h('div.t-meta', {}, V.h('span', { text: V.size(item.size) }),
              trouble.has(item.id) ? V.h('span.t-status', { text: trouble.get(item.id) }) : null)),
          V.h('div.t-actions', {}, V.iconButton('x', 'Don\'t send', async () => { await V.db.del('outgoing', item.id); draw(); }, 'quiet')))));
    });
  }

  function draw() {
    if (!parts || !root || !root.isConnected || root.dataset.tab !== 'send') return;
    drawQueue();
    const list = mine();
    V.clear(parts.list, list.length ? list.map(row)
      : V.h('div.empty.small', {}, V.mark(36), V.h('p', { text: V.desktop ? 'Nothing sent yet. Drop a file here and it goes to your phone.'
        : 'Nothing sent yet. Share a photo to Vault, or pick files above.' })));
    const used = list.reduce((sum, t) => sum + (t.size || 0), 0) +
      [...V.data.notes.values()].reduce((sum, n) => sum + (n.attachments || []).reduce((s, a) => s + (a.size || 0), 0), 0);
    V.clear(parts.space, V.h('div.bar.space', {}, V.h('i', { style: { width: Math.min(100, 100 * used / FREE_SPACE) + '%' } })),
      V.h('span', { text: `${V.size(used)} of 1 GB of free space used` }),
      list.some((t) => t.kind === 'file') ? V.button('Clean up', { kind: 'quiet', onClick: cleanUp }) : null);
  }

  async function cleanUp() {
    const old = mine().filter((t) => t.kind === 'file' && Date.now() - new Date(t.created_at).getTime() > 7 * 86400000);
    const choice = await V.confirm('Clean up?', old.length
      ? `Delete the ${old.length} file${old.length > 1 ? 's' : ''} sent over a week ago from the cloud? Copies already saved on your PC or phone stay.`
      : 'Delete every sent file from the cloud? Copies already saved on your PC or phone stay.', { ok: 'Delete', danger: true });
    if (!choice) return;
    for (const t of old.length ? old : mine().filter((x) => x.kind === 'file')) await remove(t);
  }

  /* Where things go: the other device, and what happens to what's sent there. */
  function deviceCard() {
    return V.h('div.device-card', {}, V.icon(V.desktop ? 'phone' : 'pc'), V.h('div.device-text', {},
      V.h('strong', { text: V.desktop ? 'Your phone' : 'Your PC' }),
      V.h('span', { text: V.desktop ? 'Files wait in Vault on your phone until you open them there.'
        : 'Files you send are saved in Downloads\\Vault on the PC by themselves.' })));
  }

  function render(container) {
    root = container;
    const area = V.h('textarea.field.send-text', { rows: 1, placeholder: `Text or a link for ${V.otherName}`, 'aria-label': 'Text to send' });
    const take = (input) => () => { files(input.files); input.value = ''; };
    const picker = V.h('input', { type: 'file', multiple: true, hidden: true });
    picker.addEventListener('change', take(picker));
    const sendWords = async () => { const words = area.value; if (!words.trim()) return; area.value = ''; await text(words); };
    area.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendWords(); } });
    parts = { queue: V.h('div.queue'), list: V.h('div.transfers'), space: V.h('div.space-row') };
    let choose;
    if (V.desktop) {
      choose = V.h('button.drop-zone', { type: 'button', onclick: () => picker.click() },
        V.icon('upload', 'big'), V.h('strong', { text: 'Choose files' }),
        V.h('span', { text: 'or drop them anywhere in Vault (up to 50 MB each)' }));
    } else {
      // On the phone: photos from the gallery, any file, or a photo taken now.
      const photos = V.h('input', { type: 'file', multiple: true, accept: 'image/*,video/*', hidden: true });
      const camera = V.h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
      photos.addEventListener('change', take(photos));
      camera.addEventListener('change', take(camera));
      const tile = (icon, label, hint, input) => V.h('button.tile', { type: 'button', onclick: () => input.click() },
        V.icon(icon), V.h('span', {}, V.h('strong', { text: label }), V.h('small', { text: hint })));
      choose = [V.h('div.tiles', {}, tile('image', 'Photos', 'Gallery', photos), tile('file', 'Files', 'Any type', picker),
        tile('camera', 'Camera', 'Snap one', camera)), photos, camera];
    }
    V.clear(container, V.h('div.page', {},
      V.h('div.page-head', {}, V.h('h1', { text: V.desktop ? 'Send to your phone' : 'Send to your PC' }), V.statusPill()),
      V.h('div.send-card', {},
        picker,
        deviceCard(),
        choose,
        V.h('div.send-row', {}, area, V.button('Send', { kind: 'primary', icon: 'arrow-up', onClick: sendWords }))),
      parts.queue,
      V.h('h2.section', { text: 'Sent and received' }),
      parts.list,
      parts.space));
    draw();
    // Looking at the list counts as having seen what came in (files on the phone wait to be opened).
    for (const t of incoming()) if (!t.received_at && t.kind !== 'file') received(t);
  }

  V.on('data', (table) => { if (table === 'transfers') { draw(); V.emit('badge'); } });
  V.on('transfers-in', arrived);
  window.addEventListener('online', runQueue);

  return {
    render, files, text, runQueue, takeShared, unseen,
    checkIncoming: () => arrived(incoming()),
    busy: () => queueRunning || saving.size > 0,  // a file going up, or the PC saving one: not a moment to reload
  };
})();
