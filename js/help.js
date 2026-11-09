/* Wefty: Help (1.22, the launch guide's second layer: "a search box and about 30 cards: How do I make flash cards?,
   How do I turn on notifications?, How do I move my notes?. Each ends with a Show me button. Typing a question matches
   the closest cards, with no AI. Reachable from a ? in the profile menu and from every error message.")

   V.help.cards(): the questions that apply on this device and to this person, in their own words, each answered in two
   to four short sentences that say what Wefty really does here (an iPhone gets its own install card, the PC its own,
   the owner's Friends card only for the owner), with the V.showMe id that points at it (`show`, or null).
   V.help.search(text): the cards that match, best first, with no AI: the words and their simple stems, words people
   use for the same thing ("flashcards", "deck", "quizlet"), and small typos ("notifcations").
   V.help.open({ query, card }): the Help screen. A sheet on a big screen, the whole screen on a phone: the search box
   at the top (the keyboard goes there on a big screen, never by itself on a phone), the questions (a tap opens the
   answer, with Show me, and Ask Chat when Chat can answer here), and "Still stuck? Send feedback" at the bottom.
   Back (Android's, or the browser's) closes it; a Show me closes it first, then points.
   V.help.forError(error): the card that fixes an error, or null. V.problem's toast gets a Help button from it.
   Entry points: your picture's menu (Help, after Settings: js/profile.js), Settings > About & feedback (its Help row,
   `card`), Settings' search, and #help in the address (#help=<card id> for one answer). */
'use strict';

V.help = (() => {
  const kind = () => V.deviceKind || {};
  const phone = () => !V.desktop && V.device === 'phone';
  const ios = () => !V.desktop && !!kind().ios;
  const android = () => !V.desktop && !!kind().android;
  const chromebook = () => !V.desktop && !!kind().chromebook;
  const iphoneWord = () => (kind().model === 'iPad' ? 'iPad' : 'iPhone');
  const here = () => (V.desktop ? 'PC' : phone() ? (ios() ? iphoneWord() : 'phone') : chromebook() ? 'Chromebook' : 'computer');
  const who = () => (V.who ? V.who() : 'owner');
  const can = (id) => !!(V.settings && V.settings.categories && V.settings.categories().some((cat) => cat.id === id));
  const installed = () => !!(V.install && V.install.installed && V.install.installed());
  const doors = () => !V.desktop && !!V.doors;
  const hold = () => (window.matchMedia && matchMedia('(pointer: coarse)').matches ? 'hold' : 'right-click');

  /* -- the cards. `a`: the answer (words, or a function for words that depend on the device); `show`: a V.showMe id,
     or several (the first one this device has); `words`: more words people search with, and their misspellings;
     `when`: only where it applies; `steps`: a numbered list under the answer; `extra`: buttons of its own. */
  const GROUPS = [
    ['start', 'Getting started'], ['notes', 'Notes and folders'], ['cards', 'Flash cards and tests'],
    ['record', 'Recording and photos'], ['remind', 'Reminders and notifications'], ['share', 'Share between devices'],
    ['ai', 'Chat and AI'], ['account', 'Your account'], ['trouble', 'When something\'s wrong'], ['look', 'Look and feel'],
  ];
  const CARDS = [
    // -- getting started
    { id: 'start', group: 'start', q: 'Where do I start?', show: 'new-note',
      a: () => `Wefty keeps your school notes, flash cards and reminders in step on your phone, Chromebook and PC. Today shows `
        + `your week; Notes holds everything you write. Tap ${V.wide() ? 'New note' : '+'} on Notes (or New note on Today) to write your first one.`,
      words: ['begin', 'first', 'new', 'what is wefty', 'how does it work', 'basics', 'intro', 'getting started'] },
    { id: 'today', group: 'start', q: 'What\'s on Today?', show: 'today-week',
      a: 'Today shows your week at the top: tap a day to see what\'s due then, and tick things off right there. Under it are '
        + 'quick buttons (New note, Note-taker, Flash cards and more), tests coming up and the cards to study today.',
      words: ['dashboard', 'home', 'week', 'day', 'calendar', 'agenda', 'planner', 'whats due', 'to do', 'todo'] },
    { id: 'tour', group: 'start', q: 'Can Wefty show me around?', show: 'tour', when: () => !!V.tour,
      a: 'Yes: the tour takes about two minutes and points at each part of Wefty and what the switches in Settings do. Tap '
        + 'your picture, then Take the tour. It\'s in Settings > About & feedback too.',
      words: ['tour', 'tutorial', 'walkthrough', 'walk through', 'guide', 'show me around', 'how to use'] },

    // -- notes and folders
    { id: 'new-note', group: 'notes', q: 'How do I make a note?', show: 'new-note',
      a: () => `On Notes, tap ${V.wide() ? 'New note above the list' : 'the + at the bottom'}, pick Blank note or a template, and `
        + 'start writing. It saves by itself as you type.',
      words: ['new note', 'write', 'create', 'add a note', 'start a note', 'type', 'template', 'save'] },
    { id: 'folders', group: 'notes', q: 'How do I make a folder?', show: 'new-folder',
      a: () => `${V.wide() ? 'On Notes, tap the + beside Folders' : 'On Notes, scroll the row of folders and tap New folder'}, then `
        + `name it and pick an emoji. For a folder inside a folder, ${hold()} the folder and tap New folder inside.`,
      words: ['folder', 'folders', 'subject', 'class', 'organise', 'organize', 'category', 'subfolder', 'emoji'] },
    { id: 'move-notes', group: 'notes', q: 'How do I move notes into a folder?', show: 'drag',
      a: () => `${hold() === 'hold' ? 'Hold a note, then drag it' : 'Drag a note'} onto a folder. Or open the note and pick its folder `
        + 'at the top, or use its ⋯ > Move to. To move several at once, select them first.',
      words: ['move', 'drag', 'drop', 'put', 'organise', 'organize', 'sort', 'into a folder', 'change folder'] },
    { id: 'search', group: 'notes', q: 'How do I find a note?', show: 'search',
      a: () => `${V.wide() ? 'Type in the search box above your notes' : 'On Notes, tap the magnifier at the top'}. It looks in `
        + `titles and words, and #tags too.${V.wide() ? ' Ctrl+F opens it from anywhere.' : ''}`,
      words: ['search', 'find', 'look for', 'lost', 'missing', 'where is my note', 'tag', 'tags'] },
    { id: 'select', group: 'notes', q: 'How do I pick several notes at once?', show: 'select',
      a: () => (V.wide() ? 'On Notes, tap Select above the list (or Ctrl+click notes), then tap the notes you want. ' :
        'On Notes, tap ⋯ > Select notes (or hold a note), then tap the others you want. ')
        + 'Move, pin, archive, export or delete them together from the bar.',
      words: ['select', 'pick', 'several', 'multiple', 'many', 'all', 'bulk', 'choose', 'tick'] },
    { id: 'lock', group: 'notes', q: 'How do I lock a note?', show: 'lock-note',
      a: 'Open the note and tap the lock at the top. The first time, you make a PIN: locked notes are scrambled with it on your '
        + 'device, so if you forget it nobody can open them, not even Wefty. Locked notes keep words only.',
      words: ['lock', 'locked', 'private', 'secret', 'pin', 'hide', 'password protect', 'diary'] },
    { id: 'export', group: 'notes', q: 'How do I export a note or send it to someone?', show: 'export-note',
      when: () => !!V.exporter,
      a: 'Open the note, tap ⋯ > Export, and pick Text or Markdown. To export several, select them and tap Export; a '
        + 'folder\'s menu has Export folder. Copy as text in the same menu copies just the words.',
      words: ['export', 'download', 'save as', 'txt', 'text file', 'markdown', 'send to someone', 'share a note', 'copy', 'print', 'zip'] },
    { id: 'trash', group: 'notes', q: 'I deleted a note. Can I get it back?', show: 'trash',
      a: () => `Yes, for 30 days: on Notes, open the Trash (${V.wide() ? 'at the bottom of the folders' : 'the last chip in the row of folders'}), `
        + `${hold()} the note and tap Put back. After 30 days in the Trash it's gone for good.`,
      words: ['deleted', 'delete', 'trash', 'bin', 'undo', 'restore', 'get back', 'recover', 'undelete', 'lost'] },

    // -- flash cards and tests
    { id: 'flash-cards', group: 'cards', q: 'How do I make flash cards?', show: 'flash-cards',
      a: 'In any note, write a question and its answer on one line with :: between them, like "Capital of France :: Paris". '
        + 'Or put a word in double curly brackets, like "The {{mitochondria}} makes energy", for a fill-in-the-blank card. They show '
        + 'up in Flash cards, ready to study.',
      words: ['flash card', 'flashcard', 'flash cards', 'flashcards', 'card', 'cards', 'deck', 'make cards', 'write cards', 'cloze',
        'quizlet', 'anki', 'q a', 'question answer', 'blank', 'curly'] },
    { id: 'ai-cards', group: 'cards', q: 'Can AI make my flash cards?', show: 'make-cards', when: () => !!V.aiCards,
      a: 'Yes, once the free Gemini is set up: open a note and tap Make cards with AI in its tools, or use a folder\'s menu > '
        + 'Make flash cards. You see the cards first; nothing is added until you tap Add.',
      words: ['ai cards', 'make cards with ai', 'automatic', 'generate', 'gemini', 'flashcard', 'flashcards', 'flash cards', 'deck'] },
    { id: 'study', group: 'cards', q: 'How do I study my flash cards?', show: ['study', 'flash-cards'], when: () => !!V.review,
      a: 'Tap Flash cards on Today (it says how many are due), or Study on the Flash cards page. Tap a card to flip it, then '
        + 'Still learning, Next or I know it. Wefty brings each card back just before you\'d forget it.',
      words: ['study', 'revise', 'revision', 'review', 'practice', 'practise', 'memorize', 'memorise', 'due', 'flashcards', 'flash cards', 'learn'] },
    { id: 'test-me', group: 'cards', q: 'What\'s Test me?', show: ['test-me', 'flash-cards'], when: () => !!V.learn,
      a: 'A quick quiz on your flash cards: pick the answer, true or false, then type it. Tap Test me on Today, on the Flash '
        + 'cards page or in a note with cards. With AI on, the wrong choices are trickier and a typed answer with the right idea counts.',
      words: ['test me', 'quiz', 'quiz me', 'multiple choice', 'true or false', 'type the answer', 'learn mode'] },
    { id: 'tests', group: 'cards', q: 'How do I add a test and get a study plan?', show: ['tests', 'make-test'],
      when: () => !!V.exams,
      a: 'Make a note for the test, give it the test\'s day with Due date at its top, then tap + More > Test and tick the '
        + 'folders it covers. Today counts down to it and spreads the cards you haven\'t gone over across the days left.',
      words: ['test', 'exam', 'exams', 'midterm', 'final', 'quiz', 'study plan', 'countdown', 'plan', 'covers', 'unit test'] },

    // -- recording and photos
    { id: 'notetaker', group: 'record', q: 'How do I record a class?', show: 'notetaker', when: () => !!V.notetaker,
      a: 'Tap Note-taker on Today, then Start listening. Wefty writes down what\'s said; when you tap Stop and make notes, AI '
        + 'turns it into notes with a summary, key points and flash cards. Without AI you keep the plain transcript.',
      words: ['record', 'recording', 'note taker', 'notetaker', 'note-taker', 'transcribe', 'transcript', 'lecture', 'lesson', 'listen',
        'microphone', 'mic', 'audio', 'class', 'teacher'] },
    { id: 'ai-listening', group: 'record', q: 'What\'s AI listening?', show: ['ai-listening', 'notetaker'],
      when: () => !!V.notetaker && !V.desktop,
      a: 'With the free Gemini set up, the note-taker records the room and writes down what the teacher says about every half '
        + 'minute, leaving out the chat around you. Switch it off on the note-taker\'s start screen or in Settings > AI.',
      words: ['ai listening', 'noisy', 'noise', 'loud', 'background', 'hear', 'missed words', 'teacher', 'gemini'] },
    { id: 'notetaker-away', group: 'record', q: 'Does the note-taker keep going if I switch tabs or lock my phone?', show: 'notetaker',
      when: () => !!V.notetaker,
      a: () => {
        if (V.desktop) return 'Yes: on the PC it keeps listening while you use other apps and other screens of Wefty. Tap the bar at the top to come back to it.';
        if (phone()) {
          return `Inside Wefty, yes: tap Hide or another tab and it keeps listening. But your ${here()} can't hear while Wefty is in `
            + `the background or the screen is off, so keep Wefty open.${android() ? ' Putting it in a pocket? Tap Pocket mode: the screen goes black and a double tap wakes it.' : ''}`;
        }
        return 'Yes: tap Hide or another tab in Wefty and it keeps listening, and Chrome keeps hearing in other browser tabs too. '
          + 'For a backup there, switch on Record while in another tab on its start screen.';
      },
      words: ['background', 'switch tabs', 'other tab', 'lock screen', 'screen off', 'pocket', 'pocket mode', 'keeps going', 'stops', 'minimise'] },
    { id: 'snap', group: 'record', q: 'Can I take a photo of my notes?', show: 'snap', when: () => !!V.capture,
      a: 'Yes: tap Snap on Today (or Snap a page in a new note), take a photo of the page, and AI turns it into a tidy note you '
        + 'check before it\'s saved. It needs the free Gemini.',
      words: ['photo', 'picture', 'camera', 'snap', 'scan', 'handout', 'worksheet', 'whiteboard', 'board', 'textbook', 'image', 'screenshot'] },
    { id: 'dictate', group: 'record', q: 'Can I talk instead of typing?', show: 'dictate',
      when: () => { try { return !!(V.dictation && V.dictation.engine && V.dictation.engine().kind); } catch (error) { return false; } },
      a: 'Yes: tap Dictate on Today, or + More > Dictate in a note, and say what to write. Say "comma", "full stop", '
        + '"question mark" or "new line" for those.',
      words: ['dictate', 'dictation', 'talk', 'speak', 'voice', 'voice typing', 'speech to text', 'say'] },

    // -- reminders and notifications
    { id: 'reminders', group: 'remind', q: 'How do I set a reminder?', show: 'reminder', when: () => !!V.reminders,
      a: 'Open the note and tap Reminder in its tools: pick the day and the time. You can also type it in the title, like '
        + '"Essay due Friday 9am", and Wefty offers to set it. Today shows it on its day.',
      words: ['reminder', 'remind', 'alarm', 'alert', 'due date', 'deadline', 'due', 'time', 'schedule', 'homework'] },
    { id: 'repeat', group: 'remind', q: 'How do I make a reminder repeat?', show: 'repeat', when: () => !!V.reminders,
      a: 'In the note\'s Reminder, pick how often in Repeat: every day, a few days of the week, every week, month or year. '
        + 'Or type it in the title, like "Badminton every Tuesday 6pm". Stop repeating is in the same place.',
      words: ['repeat', 'repeating', 'recurring', 'every day', 'every week', 'weekly', 'daily', 'monthly', 'each week', 'routine'] },
    { id: 'notifications', group: 'remind', q: 'How do I turn on notifications?', show: 'notifications',
      when: () => !V.desktop && !!V.push,
      a: () => (ios() && !installed()
        ? `On an ${iphoneWord()}, notifications only work from Wefty's icon on your Home Screen. Add it there first (see How do I `
          + 'add Wefty to my home screen?), open Wefty from the icon, then Settings > Notifications > Turn on.'
        : 'Settings > Notifications > Turn on, then allow them. You get your reminders, a daily study nudge and a heads-up the '
          + 'evening before a test, even when Wefty is closed. Blocked them once? That page says how to allow them again.'),
      words: ['notification', 'notifications', 'notify', 'push', 'alerts', 'buzz', 'nudge', 'not getting', 'blocked', 'allow'] },

    // -- share between devices
    { id: 'send', group: 'share', q: 'How do I send something to my other devices?', show: 'share-send', when: () => !!V.send,
      a: 'Open Share > Send: type or paste words, or add photos and files, pick the device in Send to, and tap Send. It shows '
        + 'up in Share on that device, ready to open.',
      words: ['send', 'share', 'transfer', 'airdrop', 'other device', 'phone to pc', 'pc to phone', 'move a file', 'photo to computer'] },
    { id: 'clipboard', group: 'share', q: 'Can I copy on one device and paste on another?', show: 'clipboard', when: () => !!V.clips,
      a: () => (ios()
        ? `Yes, with a tap: on an ${iphoneWord()}, Share > Clipboard's buttons send what you copied and copy what came, as Safari `
          + 'only lets Wefty read the clipboard when you tap. Passwords and codes are never shared.'
        : `Yes: in Share > Clipboard, switch on Keep this ${here()}'s clipboard in step. What you copy is ready on your other `
          + 'devices when you open Wefty there. Passwords and codes are never shared.'),
      words: ['clipboard', 'copy', 'paste', 'copy paste', 'universal clipboard', 'between devices', 'text'] },
    { id: 'pc-files', group: 'share', q: 'Can I open my PC\'s files on my phone?', show: ['pc-files', 'setting:pc-files'],
      when: () => !!(V.share && V.share.filesRow),
      a: 'Yes, with Wefty on your PC: switch on PC files in Settings > Devices, pick the folders your phone may see in Share > '
        + 'Files on the PC, and Share > Files shows them on your phone and Chromebook.',
      words: ['pc files', 'computer files', 'documents', 'files', 'folders', 'drive', 'wefty drive', 'browse', 'remote'] },

    // -- chat and AI
    { id: 'chat', group: 'ai', q: 'What can Chat do?', show: 'chat', when: () => !!V.chat,
      a: 'Ask it anything, or ask it to do things in Wefty: make folders, notes, reminders and flash cards, and move or tidy '
        + 'notes. It always asks before deleting anything, and it only looks at your notes when you ask it to in that chat.',
      words: ['chat', 'ai', 'assistant', 'chatbot', 'chatgpt', 'ask', 'questions', 'homework help', 'agent', 'gemini', 'claude'] },
    { id: 'gemini', group: 'ai', q: 'What\'s the free Gemini key, and is it safe?', show: 'gemini-key', when: () => !!V.ai,
      a: () => `It's a free key from Google that lets AI in Wefty write notes, make cards and chat. ${(V.ai && V.ai.AGE_WORDS)
        || 'Google requires the person making the key to be 18 or older, so a parent or guardian can make it with you.'} `
        + `Wefty only sends it to Google, and it's ${V.ai && V.ai.kept ? V.ai.kept() : 'never shown'}.`,
      words: ['gemini', 'key', 'api key', 'google', 'free ai', 'set up ai', 'ai studio', 'safe', 'privacy', 'age', '18', 'parent',
        'guardian', 'cost', 'free', 'aq'] },
    { id: 'ai-trouble', group: 'ai', q: 'AI says it can\'t be reached, or it\'s busy', show: 'gemini-key', when: () => !!V.ai,
      a: 'Some wifi (a school\'s, often) blocks AI. Your words are saved, and the notes or the message go by themselves once '
        + 'it can be reached, on mobile data or at home. Busy or over Google\'s free limit: Wefty tries again in a little while.',
      words: ['cant reach', 'blocked', 'busy', 'slow', 'waiting to send', 'school wifi', 'limit', 'quota', 'not working', 'error', 'ai broken'] },

    // -- your account
    { id: 'install', group: 'account', q: 'How do I add Wefty to my home screen?', show: 'install', when: () => !V.desktop && !installed(),
      a: () => {
        if (kind().inApp) return `This app's own browser can't add Wefty to your home screen. Open Wefty in ${ios() ? 'Safari' : 'Chrome'} first, then add it from there.`;
        if (ios()) return `Safari has no install button, so it's three taps: Share, then Add to Home Screen, then Add. Then open Wefty from the new icon and sign in once. On an ${iphoneWord()}, notifications only work from the icon.`;
        if (android()) return 'It opens like an app and works offline. In Chrome, tap Install in Settings > Devices, or Chrome\'s ⋮ menu > Add to Home screen.';
        return 'It opens in its own window like any app and works offline. Settings > Devices has Install, or use Chrome\'s menu as below.';
      },
      steps: () => (V.welcome && V.welcome.howToInstall ? V.welcome.howToInstall().steps : []),
      extra: () => (V.homeScreen && V.homeScreen.open ? [{ label: 'Add Wefty', icon: 'download', run: () => V.homeScreen.open() }] : []),
      words: ['home screen', 'homescreen', 'install', 'app', 'icon', 'add to home', 'pwa', 'shortcut', 'download the app', 'download'] },
    { id: 'another-device', group: 'account', q: 'How do I sign in on another device?', show: ['sign-in-another-device', 'add-device'],
      a: () => (V.pair
        ? 'On the new device, open wefty.org and sign in with your e-mail and password. No password? Tap Use a code from another '
          + 'device there, then here go to Settings > Devices > Sign in another device and type the code it shows.'
        : 'On the new device, open Wefty and sign in with your e-mail and password. Settings > Devices > Add a phone or '
          + 'computer shows a code to scan that opens it there.'),
      words: ['sign in', 'signin', 'log in', 'login', 'another device', 'other device', 'new phone', 'chromebook', 'laptop', 'second device', 'code',
        'pair', 'connect', 'school computer'] },
    { id: 'forgot-password', group: 'account', q: 'I forgot my password', show: 'change-password',
      a: () => (doors()
        ? 'On the sign-in screen, tap Forgot password?, type your e-mail and Wefty sends you a code to pick a new one. Still '
          + 'signed in on another device? Settings > Account > Change password works there too.'
        : 'Still signed in on another device? Change it there: Settings > Account > Change password. Otherwise open wefty.org '
          + 'and tap Forgot password? on its sign-in screen.'),
      words: ['forgot', 'forgotten', 'password', 'reset', 'cant sign in', 'locked out', 'wrong password', 'lost password', 'pasword'] },
    { id: 'change-password', group: 'account', q: 'How do I change my password?', show: 'change-password',
      a: 'Settings > Account > Change password. Your other devices stay signed in; use the new one next time you sign in. It isn\'t '
        + 'your locked notes\' PIN (that\'s in Settings > Notes & files).',
      words: ['change password', 'new password', 'password', 'update password', 'pasword'] },
    { id: 'export-all', group: 'account', q: 'How do I get a copy of everything I have in Wefty?', show: 'export-everything',
      a: 'Settings > Account > Export everything makes one ZIP with every note, folder and chat, to keep or take somewhere '
        + 'else. Locked notes stay locked in it.',
      words: ['export everything', 'backup', 'back up', 'download all', 'my data', 'zip', 'copy of everything', 'takeout', 'save everything'] },
    { id: 'delete-account', group: 'account', q: 'How do I delete my account?', show: 'delete-account', when: () => who() !== 'owner',
      a: 'Settings > Account > Delete my account. It deletes every note, file, chat and setting, on every device, for good, so '
        + 'export everything first if you want to keep a copy.',
      words: ['delete account', 'remove account', 'close account', 'erase', 'my data', 'leave', 'quit', 'gdpr', 'delete everything'] },
    { id: 'invite', group: 'account', q: 'How do I invite friends?', show: 'invite', when: () => who() === 'owner' && can('friends'),
      a: 'Settings > Friends > Invite someone makes a link that signs a friend in once, and Join with a QR code lets a whole '
        + 'room join in the next 30 minutes. Each friend gets their own Wefty: you never see their notes.',
      words: ['invite', 'friend', 'friends', 'classmate', 'classmates', 'qr code', 'join', 'share wefty', 'people'] },

    // -- when something's wrong
    { id: 'offline', group: 'trouble', q: 'Does Wefty work offline?', show: 'profile',
      a: () => `Yes: what you write is kept on this ${here()} and syncs when you're back online. Your picture shows an amber dot `
        + 'while changes wait here; tap it to see. Wait for the dot to go before you sign out.',
      words: ['offline', 'no internet', 'no wifi', 'wifi', 'internet', 'connection', 'sync', 'syncing', 'not syncing', 'saved', 'saving',
        'other devices', 'failed to fetch'] },
    { id: 'storage-full', group: 'trouble', q: 'It says my storage is full', show: 'storage', when: () => !!V.send,
      a: 'Your pictures and files share one space (Share > Send shows how much is used). Remove a few you don\'t need, like '
        + 'old sent files with Clean up there, and you can add more. The words in your notes don\'t use it.',
      words: ['storage', 'space', 'full', 'room', 'quota', 'limit', 'mb', 'gb', 'upload', 'upload failed', 'cant add pictures', 'too many files'] },
    { id: 'too-big', group: 'trouble', q: 'A note won\'t sync because it\'s too big', show: 'profile',
      a: 'The cloud only takes notes up to a size. The note is safe on this device: make its words shorter, or move big '
        + 'pictures into a file, and it goes up by itself. Your picture\'s menu shows which notes are waiting.',
      words: ['too big', 'not synced', 'wont sync', 'held', 'size', 'large note', 'long note'] },
    // (1.22.2: a file, not a note: Share > Send keeps it with Try again and Remove, js/send.js)
    { id: 'file-too-big', group: 'trouble', q: 'A file is too big for my cloud', show: 'share-send', when: () => !!V.send,
      a: () => `Wefty takes files up to ${V.FILE_MOST_WORDS}, but your cloud has its own limit: ${V.FILE_CLOUD_WAS / (1024 * 1024)} MB `
        + 'until it\'s raised. A file sent with Share > Send waits there: remove it, or press Try again once the limit is '
        + 'higher. A smaller copy goes, like a shorter video or a photo shared at a smaller size.',
      words: ['file too big', 'too big for my cloud', 'refused', 'turned down', 'wont upload', 'big file', 'big video',
        'maximum allowed size', 'limit raised'] },
    { id: 'asleep', group: 'trouble', q: 'It says the cloud is asleep, or Wefty can\'t reach it', show: 'profile',
      a: () => (who() === 'owner'
        ? 'Free Supabase clouds go to sleep after a week with no use; everything is still there. Open supabase.com/dashboard, '
          + 'click your project and press Restore. A few minutes later, tap your picture > What to do > Try again.'
        : who() === 'self'
          ? `Everything is still there, and what you write waits on this device. It usually comes back by itself; if it lasts more than a day, write to ${V.TEAM || 'Wefty\'s team'}.`
          : 'Everything is still there, and what you write waits on this device. Ask the person who invited you to open Wefty: '
            + 'that wakes the cloud up in a few minutes.'),
      words: ['asleep', 'sleep', 'paused', 'cant reach', 'cannot reach', 'unreachable', 'server', 'down', 'cloud', 'not loading', 'supabase'] },
    { id: 'signed-out', group: 'trouble', q: 'Wefty signed me out', show: null,
      a: 'Sign in again with your e-mail and password (or a code from another device). Your notes are safe in your cloud and '
        + 'come back as soon as you\'re in.',
      words: ['signed out', 'logged out', 'kicked out', 'sign in again', 'session', 'expired'] },
    { id: 'sign-in-check', group: 'trouble', q: 'The sign-in check didn\'t load', show: null, when: doors,
      a: 'Some networks block the check Wefty uses to stop robots signing up. Try mobile data or another network, or sign in '
        + 'with a code from another device instead.',
      words: ['captcha', 'robot', 'not a robot', 'check', 'verification', 'turnstile', 'cant sign up', 'sign up', 'blocked'] },
    { id: 'move', group: 'trouble', q: 'Moving to wefty.org didn\'t work', show: null, when: () => !V.desktop && !!V.moved && (V.moved.old || location.origin === V.moved.toOrigin),
      a: 'Your notes are safe in your cloud. In your old Wefty, tap Copy my sign-in (on its "Wefty has moved" popup, or in '
        + 'Settings > Devices > Sign in on wefty.org), then open wefty.org and tap Paste my sign-in. Or at wefty.org tap Use a '
        + 'code from another device and type its code in the old one. Your e-mail and password work there too.',
      words: ['move', 'moving', 'wefty.org', 'old wefty', 'old address', 'vault', 'new address', 'moved', 'github'] },
    { id: 'update', group: 'trouble', q: 'How do I update Wefty?', show: 'update',
      a: 'Wefty updates itself, next time it\'s in the background. Settings > About & feedback has Check for updates, and What\'s new '
        + 'says what changed.',
      words: ['update', 'version', 'whats new', 'new version', 'latest', 'old version', 'upgrade'] },
    { id: 'feedback', group: 'trouble', q: 'Something\'s wrong, or I have an idea', show: 'feedback', when: () => !!V.feedback,
      a: 'Tap your picture, then Feedback, and say what happened or what you\'d like. It only takes a moment, and it\'s read.',
      words: ['feedback', 'bug', 'report', 'problem', 'idea', 'suggestion', 'broken', 'contact', 'email', 'support', 'help'] },

    // -- look and feel
    { id: 'look', group: 'look', q: 'How do I turn on dark mode or Pure black?', show: 'theme',
      a: () => `Settings > Appearance: pick Light, Dark or System (which follows your ${here()}). Pure black, just below it, makes `
        + 'dark mode fully black for OLED screens. Each device keeps its own.',
      words: ['dark', 'dark mode', 'night mode', 'light mode', 'theme', 'black', 'pure black', 'oled', 'colour', 'color', 'look', 'amoled'] },
    { id: 'reading', group: 'look', q: 'Is there a dyslexia-friendly font?', show: 'reading', when: () => !!V.reading,
      a: 'Yes: Settings > Appearance > Dyslexia-friendly text gives an easier font, more room between letters and lines and a soft '
        + 'page colour. Quick read draws the first part of every word bolder. Both follow you to every device.',
      words: ['dyslexia', 'dyslexic', 'font', 'reading', 'bionic', 'ruler', 'easier to read', 'spacing', 'adhd', 'quick read', 'bold'] },
  ];

  /* -- what applies here */

  const said = (value) => (typeof value === 'function' ? value() : value);
  const applies = (card) => { try { return !card.when || !!card.when(); } catch (error) { return false; } };
  // (before Wefty is up, a sign-in or move screen: nothing to point at yet)
  const appUp = () => { const app = document.getElementById('app'); return !!app && app.classList.contains('ready') && !app.classList.contains('gate'); };
  const showFor = (card) => {
    if (!appUp()) return null;
    const list = Array.isArray(card.show) ? card.show : [card.show];
    for (const id of list) {
      if (id && V.showMe && V.showMe.has && V.showMe.has(id)) return id;
    }
    return null;
  };
  const resolved = (card) => {
    let a = '';
    try { a = said(card.a) || ''; } catch (error) { console.error('Wefty: Help', card.id, error); }
    return { id: card.id, q: card.q, a, show: showFor(card), words: card.words.slice(), group: card.group };
  };
  function cards() { return CARDS.filter(applies).map(resolved); }

  /* -- search, without AI */

  const STOP = new Set(['how', 'do', 'does', 'did', 'i', 'a', 'an', 'the', 'to', 'my', 'can', 'is', 'it', 'what', 'whats', 'where',
    'why', 'when', 'on', 'in', 'of', 'for', 'and', 'or', 'you', 'me', 'with', 'get', 'are', 'be', 'this', 'that', 'there', 'im',
    'its', 'was', 'will', 'would', 'could', 'should', 'please', 'way', 'any', 'some', 'from', 'at', 'by', 'as', 'so', 'if', 'into',
    'up', 'all', 'your', 'we', 'u', 'pls', 'plz', 'wefty', 'want', 'need', 'use', 'using', 'thing', 'things', 'just', 'like', 'have',
    'has', 'one', 'out', 'about', 'which', 'who', 'am', 'not', 'dont', 'cant', 'wont', 'isnt', 'doesnt', 'there']);
  /* Words people use for the same thing: a phrase in the question or in a card stands for its idea (`~name`). */
  const IDEAS = {
    cards: ['flash card', 'flash cards', 'flashcard', 'flashcards', 'card', 'cards', 'deck', 'decks', 'quizlet', 'anki', 'cloze',
      'revision cards', 'cue cards'],
    study: ['study', 'studying', 'revise', 'revising', 'revision', 'review', 'practice', 'practise', 'memorize', 'memorise'],
    quiz: ['test me', 'quiz me', 'multiple choice', 'true or false'],
    test: ['test', 'tests', 'exam', 'exams', 'midterm', 'final', 'finals', 'study plan', 'countdown'],
    install: ['home screen', 'homescreen', 'install', 'add to home', 'pwa', 'app icon', 'download the app', 'download app', 'as an app'],
    notify: ['notification', 'notifications', 'notify', 'push', 'alerts', 'buzz', 'nudge'],
    remind: ['reminder', 'reminders', 'remind', 'alarm', 'alarms', 'due date', 'deadline'],
    repeat: ['repeat', 'repeating', 'recurring', 'every day', 'every week', 'weekly', 'daily', 'monthly', 'each week'],
    record: ['record', 'recording', 'note taker', 'notetaker', 'transcribe', 'transcript', 'lecture', 'listen', 'listening', 'microphone', 'mic'],
    snap: ['photo', 'picture', 'camera', 'snap', 'scan', 'take a picture', 'take a photo', 'handout', 'worksheet', 'whiteboard'],
    dictate: ['dictate', 'dictation', 'talk to type', 'voice typing', 'speech to text', 'speak'],
    folder: ['folder', 'folders', 'subject', 'subjects', 'organise', 'organize', 'category', 'subfolder'],
    move: ['move', 'drag', 'into a folder', 'change folder'],
    find: ['search', 'find', 'look for', 'where is my note'],
    select: ['select', 'pick several', 'multiple', 'several', 'many notes', 'bulk', 'all at once'],
    lock: ['lock', 'locked', 'private', 'secret', 'password protect', 'diary'],
    export: ['export', 'save as', 'txt', 'text file', 'markdown', 'send to someone', 'print'],
    trash: ['trash', 'bin', 'recycle', 'deleted', 'undo', 'restore', 'get back', 'recover', 'undelete'],
    send: ['send', 'transfer', 'airdrop', 'phone to pc', 'pc to phone', 'to my computer', 'to my phone'],
    clip: ['clipboard', 'copy paste', 'paste'],
    pcfiles: ['pc files', 'computer files', 'my pc', 'my computer', 'documents', 'wefty drive'],
    chat: ['chat', 'chatbot', 'chatgpt', 'assistant'],
    key: ['api key', 'gemini key', 'google key', 'ai studio', 'aistudio', 'set up ai', 'free ai'],
    safe: ['safe', 'safety', 'privacy', 'secure', 'security', 'trust'],
    age: ['18', 'eighteen', 'parent', 'guardian', 'mom', 'mum', 'dad', 'too young', 'underage', 'age'],
    signin: ['sign in', 'signin', 'log in', 'login', 'logging in', 'signing in', 'new phone', 'another device', 'other device', 'second device'],
    password: ['password', 'passcode', 'forgot', 'forgotten', 'reset', 'locked out'],
    signout: ['sign out', 'log out', 'logout', 'signout', 'signed out', 'logged out', 'kicked out'],
    offline: ['offline', 'no internet', 'no wifi', 'internet', 'connection', 'sync', 'syncing', 'not syncing', 'failed to fetch'],
    storage: ['storage', 'space', 'full', 'quota', 'out of room', 'upload failed'],
    asleep: ['asleep', 'sleep', 'sleeping', 'paused', 'cant reach', 'cannot reach', 'unreachable', 'server down'],
    look: ['dark', 'dark mode', 'night mode', 'light mode', 'theme', 'pure black', 'oled', 'amoled'],
    read: ['dyslexia', 'dyslexic', 'font', 'bionic', 'ruler', 'easier to read', 'quick read'],
    update: ['update', 'version', 'whats new', 'new version', 'upgrade'],
    tour: ['tour', 'tutorial', 'walkthrough', 'walk through', 'show me around', 'intro', 'getting started', 'beginner', 'new here'],
    feedback: ['feedback', 'bug', 'report', 'suggestion', 'idea', 'broken', 'contact', 'support'],
    invite: ['invite', 'friend', 'friends', 'classmate', 'classmates', 'qr code', 'join'],
    today: ['today', 'dashboard', 'week', 'calendar', 'agenda', 'planner'],
    newnote: ['new note', 'make a note', 'create a note', 'write a note', 'start a note', 'first note', 'add a note'],
    account: ['delete account', 'delete my account', 'close my account', 'remove my account', 'export everything', 'my data'],
    captcha: ['captcha', 'robot', 'not a robot', 'verification', 'turnstile'],
    movesite: ['wefty.org', 'wefty org', 'old wefty', 'old address', 'new address'],
  };

  const normal = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '').replace(/\bwefty\.org\b/g, 'weftyorg').replace(/[^a-z0-9]+/g, ' ').trim();
  function stem(word) {
    let w = word;
    if (w.length <= 3 || /^\d+$/.test(w)) return w;
    if (/ies$/.test(w) && w.length > 4) w = w.slice(0, -3) + 'y';
    else if (/ied$/.test(w) && w.length > 4) w = w.slice(0, -3) + 'y';
    else if (/(ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
    else if (/ing$/.test(w) && w.length > 5) w = w.slice(0, -3);
    else if (/ed$/.test(w) && w.length > 4) w = w.slice(0, -2);
    else if (/s$/.test(w) && !/ss$/.test(w)) w = w.slice(0, -1);
    if (w.length > 3 && /e$/.test(w)) w = w.slice(0, -1);
    if (w.length > 3 && /(.)\1$/.test(w) && !/(ss|ll)$/.test(w)) w = w.slice(0, -1);  // (dropped, dropping: drop)
    return w;
  }
  const tokens = (text) => normal(text).split(' ').filter((w) => w && !STOP.has(w)).map(stem);
  // An idea's phrases, as words with their stems, matched at word edges.
  const IDEA_LIST = Object.entries(IDEAS).map(([name, phrases]) => ({ name,
    phrases: phrases.map((p) => normal(p).split(' ').map(stem).join(' ')) }));
  function ideasIn(text) {
    const words = ` ${normal(text).split(' ').filter(Boolean).map(stem).join(' ')} `;
    const out = new Set();
    for (const idea of IDEA_LIST) if (idea.phrases.some((p) => words.includes(` ${p} `))) out.add(idea.name);
    return out;
  }

  /* How far apart two words are: letters added, taken out, changed or swapped (two side by side), up to `most`. */
  function distance(a, b, most) {
    if (Math.abs(a.length - b.length) > most) return most + 1;
    const prev2 = new Array(b.length + 1).fill(0);
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      let low = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        row.push(v);
        if (v < low) low = v;
      }
      prev2.splice(0, prev2.length, ...prev);
      prev = row;
      if (low > most) return most + 1;
    }
    return prev[b.length];
  }
  const typoRoom = (w) => (w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0);

  // Each card's words by weight (the question and its own words count most), and its ideas.
  function build(list) {
    const vocab = new Set();
    const rows = list.map((card) => {
      const weights = new Map();
      const add = (text, weight) => {
        const list = tokens(text);
        // (two words side by side count as one too: "flash cards" is "flashcards", "home screen" is "homescreen")
        const joined = list.slice(1).map((t, i) => stem(list[i] + t));
        for (const t of [...list, ...joined]) {
          vocab.add(t);
          if ((weights.get(t) || 0) < weight) weights.set(t, weight);
        }
      };
      add(card.q, 3);
      add(card.words.join(' '), 2.5);
      add(card.a, 1);
      const ideas = new Map();
      for (const name of ideasIn(card.a)) ideas.set(name, 1.5);
      for (const name of ideasIn(`${card.q} . ${card.words.join(' . ')}`)) ideas.set(name, 4);
      return { card, weights, ideas, question: ` ${normal(card.q)} ` };
    });
    for (const idea of IDEA_LIST) for (const p of idea.phrases) for (const w of p.split(' ')) vocab.add(w);
    return { rows, vocab: [...vocab] };
  }
  // A word that isn't one of Help's, put right when it's a near miss of one ("notifcations", "flascards").
  function corrected(word, vocab) {
    if (vocab.includes(word)) return word;
    const room = typoRoom(word);
    if (!room) return word;
    let best = word;
    let bestD = room + 1;
    for (const v of vocab) {
      if (Math.abs(v.length - word.length) > room) continue;
      const d = distance(word, v, room);
      if (d < bestD || (d === bestD && v.length > best.length)) { best = v; bestD = d; }
    }
    return bestD <= room ? best : word;
  }

  function search(text) {
    const list = cards();
    const plain = normal(text);
    if (!plain) return list;
    const { rows, vocab } = build(list);
    // The words as typed, each put right if it's a near miss, and two side by side joined ("flash cards", "home screen").
    const raw = plain.split(' ').filter(Boolean);
    const fixed = raw.map((w) => (STOP.has(w) ? w : corrected(stem(w), vocab)));
    const asked = fixed.filter((w, i) => !STOP.has(raw[i]));
    for (let i = 0; i + 1 < raw.length; i++) {
      const joined = stem(raw[i] + raw[i + 1]);
      if (vocab.includes(joined)) asked.push(joined);
    }
    const ideas = new Set([...ideasIn(plain), ...ideasIn(fixed.join(' '))]);
    // A word in most cards ("make", "note") says little; one in a few says a lot.
    const df = new Map();
    for (const row of rows) for (const key of [...row.weights.keys(), ...[...row.ideas.keys()].map((n) => `~${n}`)]) df.set(key, (df.get(key) || 0) + 1);
    const rare = (key) => Math.log(1 + rows.length / (df.get(key) || 1)) / Math.log(1 + rows.length);
    const scored = rows.map((row) => {
      let score = 0;
      for (const name of ideas) score += (row.ideas.get(name) || 0) * rare(`~${name}`);
      for (const word of new Set(asked)) {
        let best = (row.weights.get(word) || 0) * rare(word);
        if (!best && word.length >= 3) {
          for (const [have, weight] of row.weights) {
            if (have.length >= 4 && (have.startsWith(word) || word.startsWith(have))) best = Math.max(best, weight * 0.6 * rare(have));
          }
        }
        score += best;
      }
      if (plain.length >= 4 && row.question.includes(` ${plain} `)) score += 4;  // (the question itself, word for word)
      return { card: row.card, score };
    }).filter((x) => x.score > 0);
    if (!scored.length) return [];
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0].score;
    return scored.filter((x) => x.score >= Math.max(1.5, top * 0.35)).slice(0, 8).map((x) => x.card);
  }

  // When nothing matches: what helps most people.
  const USEFUL = ['start', 'new-note', 'flash-cards', 'notetaker', 'install', 'another-device', 'notifications', 'offline', 'chat'];
  function useful(n = 5) {
    const list = cards();
    const byId = new Map(list.map((c) => [c.id, c]));
    const out = USEFUL.map((id) => byId.get(id)).filter(Boolean);
    for (const c of list) if (out.length < n && !out.includes(c)) out.push(c);
    return out.slice(0, n);
  }

  /* -- errors that Help fixes */

  const words = (error) => String((error && (error.message || error.error_description || error.msg)) || error || '');
  function forError(error) {
    if (!error) return null;
    const text = words(error);
    const k = String(error.kind || error.code || '');
    const status = Number(error.status) || 0;
    let id = null;
    if (error.full || k === 'full' || /of files is full|storage.*full|full.*storage/i.test(text)) id = 'storage-full';
    else if (k === 'captcha' || /sign-in check|captcha/i.test(text)) id = 'sign-in-check';
    else if (error.move || /move to wefty\.org|moving to wefty\.org|copy my sign-in|paste my sign-in|sign-in pass|wefty\.org couldn't|didn't open wefty\.org/i.test(text)) id = 'move';
    else if (['nokey', 'key'].includes(k) || /gemini key|set up the (free )?gemini|google key/i.test(text)) id = 'gemini';
    else if (['busy', 'quota', 'limit'].includes(k) || (k === 'offline' && /claude|gemini/i.test(text))
      || /(gemini|claude) (is busy|can't be reached|is taking)|free gemini limit/i.test(text)) id = 'ai-trouble';
    else if (/notifications are blocked|notification.*(denied|blocked)/i.test(text) || k === 'denied') id = 'notifications';
    else if ((V.fileTooBig && V.fileTooBig(error)) || /too big for your cloud/i.test(text)) id = 'file-too-big';  // (a file: 1.22.2)
    else if (/too big|isn't saved to the cloud|couldn't be saved to the cloud/i.test(text)) id = 'too-big';
    else if (k === 'asleep' || status === 540 || /\basleep\b|paused|\b540\b/i.test(text)) id = 'asleep';
    else if (['signed-out', 'signed_out', 'signedOut'].includes(k) || status === 401 || /signed out|sign in again/i.test(text)) id = 'signed-out';
    else if (/e-mail or password isn't right|wrong password|invalid login/i.test(text)) id = 'forgot-password';
    else if (k === 'offline' || error.late || (typeof navigator !== 'undefined' && navigator.onLine === false)
      || /failed to fetch|networkerror|network request failed|load failed|offline|couldn't reach|can't be reached|no internet/i.test(text)) id = 'offline';
    else if (k === 'pc' || /needs an update|needs the pc part|update jarvis/i.test(text)) id = 'update';
    if (!id) return null;
    return CARDS.some((card) => card.id === id && applies(card)) ? id : null;
  }

  /* -- the Help screen */

  let open_ = null;  // { layer, panel, input, list, count, previous, step, inert }

  // Chat can answer here: js/chat.js says (canAnswer: a Gemini key, or Claude on with its key); an older Chat, the keys.
  const chatHere = () => {
    try {
      if (!V.chat || !V.chat.askHelp) return false;
      if (typeof V.chat.canAnswer === 'function') return !!V.chat.canAnswer();
      return !!(V.ai && (V.ai.has('gemini') || (V.ai.claudeOn && V.ai.claudeOn() && V.ai.has('claude'))));
    } catch (error) { return false; }
  };

  function answerOf(card, raw) {
    const box = V.h('div.help-a', { id: `help-a-${card.id}`, hidden: true });
    const acts = [];
    if (card.show) {
      acts.push(V.button('Show me', { kind: 'tonal', icon: 'target', aria: `Show me: ${card.q}`, onClick: () => showMe(card.show) }));
    }
    let extra = [];
    try { extra = raw.extra ? raw.extra() : []; } catch (error) { extra = []; }
    for (const one of extra) {
      acts.push(V.button(one.label, { icon: one.icon, onClick: async () => { await close(); one.run(); } }));
    }
    if (chatHere()) {
      acts.push(V.button('Ask Chat', { kind: 'quiet', icon: 'spark', aria: `Ask Chat: ${card.q}`, onClick: async () => {
        await close();
        V.chat.askHelp(card.q);
      } }));
    }
    let steps = [];
    try { steps = raw.steps ? raw.steps() || [] : []; } catch (error) { steps = []; }
    V.clear(box, V.h('p.ctx-words', { text: card.a }),
      steps.length ? V.h('ol.steps.ctx-words', {}, steps.map((s) => V.h('li', { text: s }))) : null,
      acts.length ? V.h('div.help-acts', {}, acts) : null);
    return box;
  }

  function cardEl(card) {
    const raw = CARDS.find((c) => c.id === card.id) || {};
    const answer = answerOf(card, raw);
    const question = V.h('button.help-q', { type: 'button', 'aria-expanded': 'false', 'aria-controls': answer.id,
      onclick: () => toggle(item, question, answer) },
    V.h('span.help-q-text', { text: card.q }), V.icon('down', 'help-chev'));
    const item = V.h('div.help-card', { dataset: { card: card.id } }, V.h('h3.help-q-head', {}, question), answer);
    return item;
  }
  function toggle(item, question, answer, force) {
    const now = force === undefined ? answer.hidden : force;
    answer.hidden = !now;
    question.setAttribute('aria-expanded', String(now));
    item.classList.toggle('open', now);
  }
  function openCard(id) {
    if (!open_) return false;
    const item = open_.list.querySelector(`.help-card[data-card="${CSS.escape(id)}"]`);
    if (!item) return false;
    toggle(item, item.querySelector('.help-q'), item.querySelector('.help-a'), true);
    try { item.scrollIntoView({ block: 'start' }); } catch (error) { /* */ }
    return true;
  }

  function drawList(text) {
    if (!open_) return;
    const query = String(text || '').trim();
    const list = open_.list;
    if (!query) {
      const all = cards();
      open_.count.textContent = '';
      V.clear(list, GROUPS.map(([id, name]) => {
        const mine = all.filter((c) => c.group === id);
        return mine.length ? V.h('section.help-group', { 'aria-label': name }, V.h('h3.help-group-name', { text: name }), mine.map(cardEl)) : null;
      }));
      return;
    }
    const found = search(query);
    if (found.length) {
      open_.count.textContent = `${found.length} answer${found.length === 1 ? '' : 's'} for “${query}”`;
      V.clear(list, found.map(cardEl));
      if (found.length === 1) openCard(found[0].id);
      return;
    }
    open_.count.textContent = `Nothing matched “${query}”. These help most people:`;
    V.clear(list, V.h('div.help-useful', {}, useful(5).map(cardEl)));
  }

  function stuck() {
    const button = V.feedback && V.feedback.sheet
      ? V.button('Send feedback', { icon: 'feedback', onClick: async () => { await close(); V.feedback.sheet(); } }) : null;
    return V.h('section.help-stuck', { 'aria-labelledby': 'help-stuck-title' },
      V.h('h3', { id: 'help-stuck-title', text: 'Still stuck?' }),
      V.h('p', { text: button ? 'Tell us what you were trying to do, and we\'ll help.'
        : `Write to ${V.TEAM || 'Wefty\'s team'} and say what you were trying to do.` }),
      button);
  }

  /* Opens Help (`query`: its search box filled in; `card`: that answer open). Opened again while it shows, it moves to
     what's asked. */
  function open({ query = '', card = '' } = {}) {
    if (open_) {
      if (query || card) {
        open_.input.value = query;
        drawList(query);
        if (card) openCard(card);
      }
      return;
    }
    if (V.showMe && V.showMe.stop) V.showMe.stop();
    const previous = document.activeElement;
    const again = previous && previous !== document.body && previous.classList && previous.classList.length
      ? previous.tagName.toLowerCase() + [...previous.classList].filter((c) => !/^(on|open|lit)$/.test(c)).map((c) => `.${CSS.escape(c)}`).join('')
        + (previous.dataset && previous.dataset.key ? `[data-key="${CSS.escape(previous.dataset.key)}"]` : '')
        + (previous.dataset && previous.dataset.setting ? `[data-setting="${CSS.escape(previous.dataset.setting)}"]` : '') : '';
    const input = V.h('input.field.help-box', { type: 'search', value: query, placeholder: 'Search Help',
      'aria-label': 'Search Help', autocomplete: 'off', enterkeyhint: 'search', spellcheck: 'false' });
    const clear = V.iconButton('x', 'Clear the search', () => { input.value = ''; drawList(''); input.focus(); }, 'help-clear');
    const count = V.h('p.help-count', { role: 'status', 'aria-live': 'polite' });
    const list = V.h('div.help-list');
    const closer = V.iconButton('x', 'Close Help', () => close(), 'quiet help-close');
    const panel = V.h('div.sheet.help-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-title', tabindex: '-1' },
      V.h('div.sheet-head', {}, V.h('h2', { id: 'help-title', text: 'Help' }), closer),
      V.h('div.help-search', { role: 'search' }, V.icon('search', 'help-search-ic'), input, clear),
      V.h('div.sheet-body.help-body', {}, count, list, stuck()));
    const layer = V.h('div.layer.help-layer', { onmousedown: (event) => { if (event.target === layer) close(); } }, panel);
    const update = V.debounce(() => { clear.hidden = !input.value; drawList(input.value); }, 120);
    input.addEventListener('input', update);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && input.value) { event.preventDefault(); event.stopPropagation(); input.value = ''; clear.hidden = true; drawList(''); }
    });
    clear.hidden = !query;
    document.getElementById('layers').append(layer);
    const app = document.getElementById('app');
    open_ = { layer, panel, input, list, count, previous, again, step: false, inert: app ? app.inert : false };
    if (app && 'inert' in app) app.inert = true;  // (Tab and a screen reader stay in Help)
    document.addEventListener('keydown', keys, true);
    try {
      history.pushState({ vault: 'help', boot: V.pageLife }, '');
      open_.step = true;
    } catch (error) { /* (its X still closes it) */ }
    drawList(query);
    if (card) openCard(card);
    requestAnimationFrame(() => {
      layer.classList.add('shown');
      // The keyboard on the search box on a big screen; on a phone, Help itself (no keyboard popping up).
      if (V.wide() && !(window.matchMedia && matchMedia('(pointer: coarse)').matches)) input.focus();
      else panel.focus({ preventScroll: true });
    });
  }

  function keys(event) {
    if (!open_) return;
    if (event.key === 'Escape' && event.target === open_.input && open_.input.value) return;  // (Esc there clears it first)
    if (event.key === 'Escape' && !document.querySelector('#layers > .layer:not(.help-layer):not(.leaving)')) {
      event.stopPropagation();
      event.preventDefault();
      close();
    }
  }

  /* Closes Help: its step in history gone first (Back took it, or it's gone back over), so a Show me or another screen
     after it never lands under a stale step. */
  function close() {
    const was = open_;
    if (!was) return Promise.resolve();
    open_ = null;
    document.removeEventListener('keydown', keys, true);
    was.layer.classList.add('leaving');
    setTimeout(() => was.layer.remove(), 180);
    const app = document.getElementById('app');
    if (app && 'inert' in app) app.inert = was.inert;
    // (the keyboard back where it was: the same button drawn again meanwhile, as Today and Settings redraw with their data)
    let focus = was.previous;
    if (focus && !focus.isConnected && was.again) focus = [...document.querySelectorAll(was.again)].find((el) => el.getClientRects().length) || null;
    if (focus && focus.isConnected && focus !== document.body && focus.focus) focus.focus({ preventScroll: true });
    if (was.step && history.state && history.state.vault === 'help' && history.state.boot === V.pageLife) {
      return new Promise((resolve) => {
        const done = () => { window.removeEventListener('popstate', done); clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, 500);
        window.addEventListener('popstate', done);
        history.back();
      });
    }
    return Promise.resolve();
  }
  window.addEventListener('popstate', () => {
    if (!open_) return;
    const state = history.state;
    if (state && state.vault === 'help' && state.boot === V.pageLife) return;
    open_.step = false;  // (Back took Help's step)
    close();
  });

  async function showMe(id) {
    await close();
    if (V.showMe) return V.showMe(id, { from: 'help' });
    return false;
  }

  /* #help (and #help=<card>) in the address: Help, once Wefty is up. */
  let asked = null;
  function fromAddress() {
    const match = /^#help(?:=([a-z0-9-]+))?$/.exec(location.hash || '');
    if (!match) return;
    asked = { card: match[1] || '' };
    tryAsked();
  }
  function tryAsked() {
    if (!asked) return;
    if (!appUp() || !V.tab || !V.tab()) return;
    const want = asked;
    asked = null;
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (error) { /* */ }
    open({ card: want.card });
  }
  window.addEventListener('hashchange', fromAddress);
  V.on('tab', () => setTimeout(tryAsked, 0));
  fromAddress();

  V.on('signing-out', () => { if (open_) close(); });

  /* Settings > About & feedback's Help row (js/settings.js). */
  function card(ui) {
    return ui.card('', ui.line('Help', 'Answers to common questions, each with Show me to point at the place.',
      V.button('Open Help', { icon: 'help', onClick: () => open() }), 'help'));
  }

  return { cards, search, open, close, forError, card, useful, showing: () => !!open_, GROUPS, CARDS, normal, stem, distance };
})();
