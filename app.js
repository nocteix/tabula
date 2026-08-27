document.addEventListener('DOMContentLoaded', () => {
  try {
    if (typeof classicsData === 'undefined') throw new Error('classicsData missing');
    initApp(classicsData);
  } catch (err) {
    console.error('Failed to initialize Tabula:', err);
    const panel = document.getElementById('mode-panel');
    if (panel) panel.innerHTML = '<p>Couldn\u2019t load the practice data. Try refreshing.</p>';
  }
});

function initApp(data) {
  const STORAGE_KEY = 'tabula-progress-v1';
  const BOX_INTERVALS = [0, 1, 2, 4, 8]; // sessions to wait before a word in this box is due again

  function emptyLangProgress() {
    return { vocab: {}, sessionCount: 0, parsing: {}, paradigm: {}, accent: { results: {} } };
  }

  // Merges saved progress into a fresh empty shape so old saves (from before
  // paradigm/accent tracking existed) don't crash on missing keys.
  function mergeLangProgress(saved) {
    const base = emptyLangProgress();
    if (!saved) return base;
    return {
      vocab: Object.assign({}, base.vocab, saved.vocab),
      sessionCount: saved.sessionCount || 0,
      parsing: Object.assign({}, base.parsing, saved.parsing),
      paradigm: Object.assign({}, base.paradigm, saved.paradigm),
      accent: { results: Object.assign({}, base.accent.results, saved.accent && saved.accent.results) },
    };
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { latin: emptyLangProgress(), greek: emptyLangProgress(), lastLang: null, lastMode: null };
      const parsed = JSON.parse(raw);
      return {
        latin: mergeLangProgress(parsed.latin),
        greek: mergeLangProgress(parsed.greek),
        lastLang: (parsed.lastLang === 'latin' || parsed.lastLang === 'greek') ? parsed.lastLang : null,
        lastMode: parsed.lastMode || null,
      };
    } catch (err) {
      console.warn('Tabula: could not read saved progress, starting fresh.', err);
      return { latin: emptyLangProgress(), greek: emptyLangProgress(), lastLang: null, lastMode: null };
    }
  }

  function saveProgress() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    } catch (err) {
      console.warn('Tabula: could not save progress (storage may be full or disabled).', err);
    }
  }

  const progress = loadProgress();

  const state = {
    lang: (progress.lastLang === 'latin' || progress.lastLang === 'greek') ? progress.lastLang : 'latin',
    mode: ['vocab', 'paradigm', 'parsing', 'accent', 'progress'].includes(progress.lastMode) ? progress.lastMode : 'vocab',
    vocab: { queue: [], index: 0, revealed: false },
    paradigm: { wordId: null, answers: {}, posFilter: 'all', search: '', tense: 'pres', gender: 'm' },
    parsing: { sentenceIndex: 0, activeParseIdx: null, answers: {}, checked: false, translationRevealed: false },
    accent: { queue: [], index: 0, checked: false, selectedPosition: null, selectedType: null, selectedLength: null },
    progress: { search: '', onlyTouched: null },
  };

  const panel = document.getElementById('mode-panel');
  const langToggle = document.getElementById('lang-toggle');
  const modeTabs = document.getElementById('mode-tabs');
  const progressToggle = document.getElementById('progress-toggle');
  const modeStatus = document.getElementById('mode-status');

  // Every render() below replaces panel.innerHTML wholesale, which destroys
  // and recreates every button/input in it - including whichever one the
  // user just activated. Without this, focus silently falls back to <body>
  // after every single interaction (reveal, check, next sentence...), which
  // is unusable for keyboard and screen reader users. Call this right after
  // a re-render with the id of whichever element should now hold focus.
  function focusAfterRender(id) {
    const el = document.getElementById(id);
    if (el) el.focus();
  }

  function announce(text) {
    if (modeStatus) modeStatus.textContent = text;
  }

  // Latin/Greek headwords and sentences are read by a screen reader with the
  // page's base lang ("en") otherwise, which mispronounces them badly.
  function langCode() { return state.lang === 'greek' ? 'el' : 'la'; }

  applyInitialParamsFromUrl();

  function applyInitialParamsFromUrl() {
    const params = new URLSearchParams(location.search);
    const requestedLang = params.get('lang');
    const requestedMode = params.get('mode');

    if (requestedLang === 'latin' || requestedLang === 'greek') {
      state.lang = requestedLang;
    }
    const validModes = ['vocab', 'paradigm', 'parsing', 'accent', 'progress'];
    if (validModes.includes(requestedMode)) {
      state.mode = requestedMode;
    }

    langToggle.querySelectorAll('button[data-lang]').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang));
    });
    syncModeControls();
    rememberLastUsed();
  }

  // Persists which language/mode is "current" so a future visit (including a
  // fresh load of the landing page reading this same storage key) can resume
  // there instead of guessing from activity counts.
  function rememberLastUsed() {
    progress.lastLang = state.lang;
    progress.lastMode = state.mode;
    saveProgress();
  }

  // Keeps the mode-tabs group and the separate Progress toggle in sync,
  // since only one of the two control groups is ever "current" at a time.
  function syncModeControls() {
    modeTabs.querySelectorAll('button[data-mode]').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
    });
    if (progressToggle) progressToggle.setAttribute('aria-pressed', String(state.mode === 'progress'));
  }

  const resetBtn = document.getElementById('reset-progress');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (confirm('Reset all saved vocab and parsing progress? This can\u2019t be undone.')) {
        try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
        location.reload();
      }
    });
  }

  function currentLangData() { return data[state.lang]; }

  function normalize(s) {
    // Lenient compare: strip macrons/diacritics and lowercase, so
    // learners aren't marked wrong for skipping vowel length or Greek accents.
    return (s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  // ---------- Cross-mode: vocab mastery, shared by Parsing/Paradigms ----------

  const KNOWN_BOX_THRESHOLD = 2; // box 2+ ("seen and gotten right a couple of times") counts as "known" elsewhere

  function vocabBoxFor(wordId) {
    const p = progress[state.lang].vocab[wordId];
    return p ? p.box : -1; // -1 = never studied in Vocab yet
  }

  function isKnownWord(wordId) {
    return vocabBoxFor(wordId) >= KNOWN_BOX_THRESHOLD;
  }

  function masteryDotsText(box) {
    let dots = '';
    for (let i = 0; i < BOX_INTERVALS.length; i++) dots += i <= box ? '\u25cf' : '\u25cb';
    return dots;
  }

  // ---------- Vocab mode ----------

  // Caps how many cards one sitting throws at the learner. Without this,
  // once the word list is in the hundreds/thousands, "every word due for
  // review" (e.g. the whole deck on day one) becomes one unworkable
  // session queue. NEW_WORDS_PER_SESSION mirrors how most SRS apps ration
  // new material: a handful of new words each time, topped up with
  // whatever's due for review, rather than pure random luck of the draw.
  const VOCAB_SESSION_SIZE = 20;
  const VOCAB_NEW_WORDS_PER_SESSION = 10;

  function buildVocabQueue() {
    const lang = progress[state.lang];
    lang.sessionCount += 1;
    saveProgress();

    const words = currentLangData().words;
    const neverStudied = [];
    const dueReview = [];
    words.forEach(w => {
      const p = lang.vocab[w.id];
      if (!p) { neverStudied.push(w.id); return; }
      const interval = BOX_INTERVALS[Math.min(p.box, BOX_INTERVALS.length - 1)];
      if (lang.sessionCount - p.lastSeenSession >= interval) dueReview.push(w.id);
    });

    let queue;
    if (neverStudied.length + dueReview.length === 0) {
      // Fully caught up for now — a light shuffled refresher beats an
      // empty session.
      queue = shuffle(words.map(w => w.id)).slice(0, VOCAB_SESSION_SIZE);
    } else {
      const newPicks = shuffle(neverStudied.slice()).slice(0, VOCAB_NEW_WORDS_PER_SESSION);
      const reviewRoom = VOCAB_SESSION_SIZE - newPicks.length;
      const reviewPicks = shuffle(dueReview.slice()).slice(0, Math.max(reviewRoom, 0));
      queue = newPicks.concat(reviewPicks);
      // Not enough new+due to fill a session (e.g. few reviews due yet, or
      // a near-mastered deck)? Top up first with more new words, then with
      // any other word at all, rather than serving a too-short session.
      if (queue.length < VOCAB_SESSION_SIZE) {
        const used = new Set(queue);
        const extraNew = shuffle(neverStudied.filter(id => !used.has(id)))
          .slice(0, VOCAB_SESSION_SIZE - queue.length);
        queue = queue.concat(extraNew);
      }
      if (queue.length < VOCAB_SESSION_SIZE) {
        const used = new Set(queue);
        const filler = shuffle(words.map(w => w.id).filter(id => !used.has(id)))
          .slice(0, VOCAB_SESSION_SIZE - queue.length);
        queue = queue.concat(filler);
      }
      queue = shuffle(queue);
    }

    state.vocab.queue = queue;
    state.vocab.index = 0;
    state.vocab.revealed = false;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Only ordinalizes plain single numbers ("1" -> "1st"); combo codes like
  // "1-2" or "2-1-2" (multi-declension adjectives) are left as-is since
  // there's no single ordinal to give them.
  function ordinalize(str) {
    if (/^\d+$/.test(str)) {
      if (str === '1') return '1st';
      if (str === '2') return '2nd';
      if (str === '3') return '3rd';
      return str + 'th';
    }
    return str;
  }

  function vocabTagLine(word) {
    const parts = [word.pos];
    if (word.pos === 'noun' && word.declension) parts.push(ordinalize(word.declension) + ' decl.');
    if (word.pos === 'verb' && word.conjugation) {
      parts.push(word.conjugation === 'irr' ? 'irregular' : ordinalize(word.conjugation) + ' conj.');
    }
    if (word.pos === 'adjective' && word.declension) parts.push(word.declension + ' decl.');
    return parts.join(' &middot; ');
  }

  // How many trailing characters of the genitive a dictionary entry keeps
  // when abbreviating with a dash (e.g. "puellae" -> "-ae"). Declensions
  // whose stem can shift unpredictably (3rd, in both languages) are left
  // out on purpose — those get the genitive spelled out in full instead,
  // exactly like a real dictionary entry would.
  const LATIN_NOUN_GEN_ABBR_LEN = { '1': 2, '2': 1, '4': 2, '5': 2 };
  const GREEK_NOUN_GEN_ABBR_LEN = { '1': 2, '2': 2 };

  function nounGenitiveEntry(word) {
    const table = state.lang === 'latin' ? LATIN_NOUN_GEN_ABBR_LEN : GREEK_NOUN_GEN_ABBR_LEN;
    const len = word.declension ? table[word.declension] : undefined;
    if (len && word.genitive.length > len) {
      return '-' + word.genitive.slice(-len);
    }
    return word.genitive;
  }

  // Abbreviates a form to its last `len` characters with a leading dash
  // (e.g. "bonum" with len 2 -> "-um"). Used for the known, regular
  // declension endings below — never for a stem that might shift
  // unpredictably, since a wrong guess there is worse than the full form.
  function abbrevBySuffixLen(form, len) {
    if (len && form.length > len) return '-' + form.slice(-len);
    return form;
  }

  // Classic single-line dictionary entry shown under the headword —
  // e.g. "puella, -ae, f." for nouns, full principal parts for verbs,
  // "bonus, -a, -um" for adjectives. This is morphology, not the English
  // gloss, so it's shown before reveal the same way a real vocab card would.
  function vocabPrincipalLine(word) {
    if (word.pos === 'noun' && word.genitive) {
      const gen = nounGenitiveEntry(word);
      const gender = word.gender ? `, ${word.gender}.` : '';
      return `<div class="word-principal">${word.headword}, ${gen}${gender}</div>`;
    }
    if (word.pos === 'verb' && word.principalParts && word.principalParts.length) {
      return `<div class="word-principal">${word.principalParts.join(', ')}</div>`;
    }
    if (word.pos === 'adjective' && word.adjForms) {
      const { m, f, n } = word.adjForms;
      let entries;
      if (m === f && f === n) {
        // One-termination (e.g. felix, felix, felix) — the genitive
        // carries the real declension info, not the repeated nominative.
        entries = word.genitive ? [m, word.genitive] : [m];
      } else if (word.declension === '1-2' || word.declension === '2-1-2') {
        // Regular three-termination: bonus/bona/bonum, καλός/καλή/καλόν.
        // Endings are predictable, so abbreviate with confidence.
        entries = [m, abbrevBySuffixLen(f, 1), abbrevBySuffixLen(n, 2)];
      } else if (f === m) {
        // Two-termination i-stem: fortis/fortis/forte, ἀληθής/ἀληθής/ἀληθές.
        entries = [m, abbrevBySuffixLen(n, state.lang === 'latin' ? 1 : 2)];
      } else {
        // Irregular three-termination (e.g. acer/acris/acre) — the stem
        // shifts too much to abbreviate reliably, so spell it all out.
        entries = [m, f, n];
      }
      return `<div class="word-principal">${entries.join(', ')}</div>`;
    }
    return '';
  }

  function renderVocab() {
    if (state.vocab.queue.length === 0) buildVocabQueue();
    if (state.vocab.index >= state.vocab.queue.length) {
      panel.innerHTML = '<div class="vocab-card"><p>Session complete.</p></div>' +
        '<div class="vocab-controls"><button type="button" class="action primary" id="vocab-restart">Start another session</button></div>';
      document.getElementById('vocab-restart').addEventListener('click', () => {
        buildVocabQueue();
        renderVocab();
        focusAfterRender('vocab-reveal');
      });
      return;
    }

    const wordId = state.vocab.queue[state.vocab.index];
    const word = currentLangData().words.find(w => w.id === wordId);
    const revealed = state.vocab.revealed;
    const box = (progress[state.lang].vocab[wordId] || { box: 0 }).box;

    panel.innerHTML = `
      <div class="vocab-card">
        <span class="pos-tag">${vocabTagLine(word)}</span>
        <div class="headword incised" lang="${langCode()}">${word.headword}</div>
        ${vocabPrincipalLine(word)}
        ${revealed ? `<div class="meaning">${word.meaning}</div>` : ''}
      </div>
      <div class="vocab-controls">
        ${revealed
          ? `<button type="button" class="action bad" id="vocab-again">Still learning</button>
             <button type="button" class="action good" id="vocab-good">Got it</button>`
          : `<button type="button" class="action primary" id="vocab-reveal">Show meaning</button>`
        }
      </div>
      <div class="vocab-progress">${state.vocab.index + 1} / ${state.vocab.queue.length} &middot; ${masteryDots(box)}</div>
    `;

    if (!revealed) {
      document.getElementById('vocab-reveal').addEventListener('click', () => {
        state.vocab.revealed = true;
        renderVocab();
        // The reveal button that was just clicked no longer exists post-render;
        // land focus on the next thing the learner will act on.
        focusAfterRender('vocab-good');
      });
    } else {
      document.getElementById('vocab-good').addEventListener('click', () => advanceVocab(true));
      document.getElementById('vocab-again').addEventListener('click', () => advanceVocab(false));
    }
  }

  function masteryDots(box) {
    let dots = '';
    for (let i = 0; i < BOX_INTERVALS.length; i++) {
      dots += i <= box ? '\u25cf' : '\u25cb';
    }
    return `<span aria-label="Familiarity ${box + 1} of ${BOX_INTERVALS.length}">${dots}</span>`;
  }

  function advanceVocab(gotIt) {
    const wordId = state.vocab.queue[state.vocab.index];
    const lang = progress[state.lang];
    const prev = lang.vocab[wordId] || { box: 0, lastSeenSession: 0 };
    const box = gotIt ? Math.min(prev.box + 1, BOX_INTERVALS.length - 1) : 0;
    lang.vocab[wordId] = { box, lastSeenSession: lang.sessionCount };
    saveProgress();

    if (!gotIt) {
      // requeue a few cards later so it comes back around this session
      const reinsertAt = Math.min(state.vocab.queue.length, state.vocab.index + 3);
      state.vocab.queue.splice(reinsertAt, 0, wordId);
    }
    state.vocab.index += 1;
    state.vocab.revealed = false;
    renderVocab();
    focusAfterRender(state.vocab.index >= state.vocab.queue.length ? 'vocab-restart' : 'vocab-reveal');
  }

// ---------- Paradigm mode ----------

const LATIN_NOUN_CASES = ['nom', 'gen', 'dat', 'acc', 'abl', 'voc'];
const GREEK_NOUN_CASES = ['nom', 'gen', 'dat', 'acc', 'voc'];
const CASE_LABELS = { nom: 'Nominative', gen: 'Genitive', dat: 'Dative', acc: 'Accusative', abl: 'Ablative', voc: 'Vocative' };

function latinNounParadigm(word) {
  const gen = word.genitive;
  if (word.declension === '1') {
    const stem = gen.replace(/ae$/, '');
    return {
      sg: { nom: word.headword, gen: stem + 'ae', dat: stem + 'ae', acc: stem + 'am', abl: stem + '\u0101', voc: word.headword },
      pl: { nom: stem + 'ae', gen: stem + '\u0101rum', dat: stem + '\u012bs', acc: stem + '\u0101s', abl: stem + '\u012bs', voc: stem + 'ae' },
    };
  }
  if (word.declension === '2') {
    const stem = gen.replace(/i$/, '');
    if (word.gender === 'n') {
      return {
        sg: { nom: word.headword, gen: stem + '\u012b', dat: stem + '\u014d', acc: word.headword, abl: stem + '\u014d', voc: word.headword },
        pl: { nom: stem + 'a', gen: stem + '\u014drum', dat: stem + '\u012bs', acc: stem + 'a', abl: stem + '\u012bs', voc: stem + 'a' },
      };
    }
    return {
      sg: { nom: word.headword, gen: stem + '\u012b', dat: stem + '\u014d', acc: stem + 'um', abl: stem + '\u014d', voc: stem + 'e' },
      pl: { nom: stem + '\u012b', gen: stem + '\u014drum', dat: stem + '\u012bs', acc: stem + '\u014ds', abl: stem + '\u012bs', voc: stem + '\u012b' },
    };
  }
  if (word.declension === '3' || word.declension === '3-i') {
    const stem = gen.replace(/is$/, '');
    const isIStem = word.declension === '3-i';
    if (word.gender === 'n') {
      if (isIStem) {
        return {
          sg: { nom: word.headword, gen: stem + 'is', dat: stem + '\u012b', acc: word.headword, abl: stem + '\u012b', voc: word.headword },
          pl: { nom: stem + 'ia', gen: stem + 'ium', dat: stem + 'ibus', acc: stem + 'ia', abl: stem + 'ibus', voc: stem + 'ia' },
        };
      }
      return {
        sg: { nom: word.headword, gen: stem + 'is', dat: stem + '\u012b', acc: word.headword, abl: stem + 'e', voc: word.headword },
        pl: { nom: stem + 'a', gen: stem + 'um', dat: stem + 'ibus', acc: stem + 'a', abl: stem + 'ibus', voc: stem + 'a' },
      };
    }
    const genPl = isIStem ? stem + 'ium' : stem + 'um';
    return {
      sg: { nom: word.headword, gen: stem + 'is', dat: stem + '\u012b', acc: stem + 'em', abl: stem + 'e', voc: word.headword },
      pl: { nom: stem + '\u0113s', gen: genPl, dat: stem + 'ibus', acc: stem + '\u0113s', abl: stem + 'ibus', voc: stem + '\u0113s' },
    };
  }
  if (word.declension === '4') {
    if (word.gender === 'n') {
      const stem = word.headword.replace(/u$/, '');
      return {
        sg: { nom: word.headword, gen: stem + '\u016bs', dat: stem + '\u016b', acc: word.headword, abl: stem + '\u016b', voc: word.headword },
        pl: { nom: stem + 'ua', gen: stem + 'uum', dat: stem + 'ibus', acc: stem + 'ua', abl: stem + 'ibus', voc: stem + 'ua' },
      };
    }
    const stem = word.headword.replace(/us$/, '');
    return {
      sg: { nom: word.headword, gen: stem + '\u016bs', dat: stem + 'u\u012b', acc: stem + 'um', abl: stem + '\u016b', voc: stem + '\u016bs' },
      pl: { nom: stem + '\u016bs', gen: stem + 'uum', dat: stem + 'ibus', acc: stem + '\u016bs', abl: stem + 'ibus', voc: stem + '\u016bs' },
    };
  }
  if (word.declension === '5') {
    const stem = gen.replace(/ei$/, '');
    return {
      sg: { nom: word.headword, gen: stem + 'e\u012b', dat: stem + 'e\u012b', acc: stem + 'em', abl: stem + '\u0113', voc: word.headword },
      pl: { nom: stem + '\u0113s', gen: stem + '\u0113rum', dat: stem + '\u0113bus', acc: stem + '\u0113s', abl: stem + '\u0113bus', voc: stem + '\u0113s' },
    };
  }
  return null;
}

// Greek nominative/vocative plural endings -αι and -οι count as
// phonologically SHORT for accent purposes (the standard exception to
// "diphthong = long"), even though they're long everywhere else. That
// means an accent that genuinely sits on the word's own stem-final
// syllable (its penult once -αι/-οι is attached) must be circumflex
// rather than acute whenever that vowel is inherently long -- e.g.
// χώρα's plural is χῶραι, not χώραι.
//
// It's NOT enough to look at the genitive-derived stem in isolation:
// Greek noun accent can shift forward between case forms (e.g.
// ἄνθρωπος, accented on the antepenult, moves to the penult in the
// genitive ἀνθρώπου because -ου is long there) -- so a stem borrowed
// from the genitive can carry an accent one syllable later than the
// word's own nominative singular actually has. Naively "fixing" every
// genitive-derived η/ω would wrongly turn ἄνθρωποι (correct: antepenult,
// unaffected by the short-ultima exception) into ἀνθρῶποι. So this only
// fires when the HEADWORD's own accent -- not the genitive's -- already
// falls on that stem-final syllable, confirming the noun's real accent
// belongs there before ever touching the spelling. It also only handles
// η/ω, the two vowels whose length is unambiguous from spelling alone;
// it can't tell long from short α/ι/υ without a dictionary, so those
// stems -- like the genitive-plural circumflex noted elsewhere -- are
// left as generated.
const ACUTE_TO_CIRCUMFLEX_ETA_OMEGA = { '\u03ae': '\u1fc6', '\u03ce': '\u1ff6' }; // ή->ῆ, ώ->ῶ
const GREEK_VOWELS_FOR_ACCENT_SHIFT = '\u03b1\u03b5\u03b7\u03b9\u03bf\u03c5\u03c9\u03ac\u03ad\u03ae\u03af\u03cc\u03cd\u03ce\u1fb6\u1fc6\u1fd6\u1fe6\u1ff6';
const GREEK_ACCENTED_CHARS = '\u03ac\u03ad\u03ae\u03af\u03cc\u03cd\u03ce\u1fb6\u1fc6\u1fd6\u1fe6\u1ff6';
const GREEK_BASE_VOWELS = '\u03b1\u03b5\u03b7\u03b9\u03bf\u03c5\u03c9';

function lastVowelIndex(str) {
  for (let i = str.length - 1; i >= 0; i--) {
    if (GREEK_VOWELS_FOR_ACCENT_SHIFT.includes(str[i])) return i;
  }
  return -1;
}

// True only if `headword`'s own accent (in its citation/nom.-sg. form)
// falls on the last vowel of its stem once `nomEndingLen` characters of
// nominative-singular ending are stripped -- i.e. the accent already
// belongs to what becomes the penult of the -αι/-οι plural, so the
// short-ultima exception can legally apply there.
function citationAccentOnStemFinalSyllable(headword, nomEndingLen) {
  const citationStem = headword.slice(0, -nomEndingLen);
  const idx = lastVowelIndex(citationStem);
  if (idx === -1) return false;
  return Object.prototype.hasOwnProperty.call(ACUTE_TO_CIRCUMFLEX_ETA_OMEGA, citationStem[idx]);
}

// Broader than the check above (which only cares about η/ω, all it needs
// for the circumflex-shift table): true if ANY accented vowel -- acute or
// circumflex, any letter -- is the stem's own last vowel. Used to detect
// proparoxytone (antepenult-accented) nouns, where the answer is "no":
// the accent sits further back than the stem-final syllable, which for
// Greek can only mean the antepenult. Like the rest of this file, this
// can't see accents fused with a word-initial breathing mark (a separate,
// narrower gap than the α/ι/υ-length one already noted) -- but that only
// matters for 2-syllable words, where the stem the generator builds from
// the genitive already matches the one built from the headword either
// way, so a missed detection there is a no-op rather than a wrong form.
function isAccentOnStemFinalSyllable(headword, nomEndingLen) {
  const citationStem = headword.slice(0, -nomEndingLen);
  const idx = lastVowelIndex(citationStem);
  if (idx === -1) return false;
  return GREEK_ACCENTED_CHARS.includes(citationStem[idx]);
}

// True if the word's own accent sits on its final syllable (the ending
// itself) rather than the stem -- e.g. θεός, ἀρχή, μαθητής. Oxytone words
// need their accent placed onto each newly-generated ending (see
// greekDecl1NounParadigm/greekNounParadigm below), since the generator
// only ever copies whatever accent happens to already be inside the stem
// it builds, and an oxytone word's accent isn't there at all.
function isOxytone(headword) {
  const idx = headword.endsWith('\u03c2') ? headword.length - 2 : headword.length - 1;
  return GREEK_ACCENTED_CHARS.includes(headword[idx]);
}

// Counts syllable nuclei (vowel letters, breathing/accent/iota-subscript
// stripped via NFD) -- used only to special-case the one monosyllabic 1st
// declension noun in this dataset (γῆ), whose accent behaves differently
// from every polysyllabic pattern below.
function countGreekVowels(str) {
  let count = 0;
  for (const ch of str) {
    if (GREEK_BASE_VOWELS.includes(ch.normalize('NFD')[0])) count++;
  }
  return count;
}

function shiftAcuteForShortUltimaPlural(stem) {
  const idx = lastVowelIndex(stem);
  if (idx === -1) return stem;
  const replacement = ACUTE_TO_CIRCUMFLEX_ETA_OMEGA[stem[idx]];
  if (!replacement) return stem;
  return stem.slice(0, idx) + replacement + stem.slice(idx + 1);
}

// 1st-declension genitive plural (-ων) is ALWAYS circumflex on the
// ultima, no matter where the noun's own persistent accent otherwise
// falls -- a fixed exception (from an original contracted -άων),
// unlike 2nd declension where gen. pl. accent follows the noun's usual
// pattern instead. So any accent already sitting in the stem (e.g.
// προφήτ-, carrying its own paroxytone ή) needs to be cleared before
// appending the circumflex ending, or the result carries two accents
// on the wrong syllable (προφήτων) instead of one on the right one
// (προφητῶν).
const ACCENTED_TO_PLAIN = {
  '\u03ac': '\u03b1', '\u1fb6': '\u03b1', '\u03ad': '\u03b5',
  '\u03ae': '\u03b7', '\u1fc6': '\u03b7', '\u03af': '\u03b9', '\u1fd6': '\u03b9',
  '\u03cc': '\u03bf', '\u03cd': '\u03c5', '\u1fe6': '\u03c5',
  '\u03ce': '\u03c9', '\u1ff6': '\u03c9',
};
function stripAccentForGenPl(stem) {
  const idx = lastVowelIndex(stem);
  if (idx === -1) return stem;
  const plain = ACCENTED_TO_PLAIN[stem[idx]];
  if (!plain) return stem;
  return stem.slice(0, idx) + plain + stem.slice(idx + 1);
}
function decl1GenPl(stem) {
  return stripAccentForGenPl(stem) + '\u1ff6\u03bd'; // -ῶν
}

// Aorist active subjunctive drops the indicative's augment (λύσω, not
// ἐλύσω) -- but the augment is exactly what carries the accent mark in
// the indicative spelling this stem is extracted from, so simply
// dropping it loses the accent entirely. The ultima is always long for
// every subjunctive personal ending, so accent can only ever land on the
// penult (the stem's own last vowel) here, always acute -- unlike the
// noun-side rules above, there's no antepenult case to worry about.
const PLAIN_TO_ACUTE = {
  '\u03b1': '\u03ac', '\u03b5': '\u03ad', '\u03b7': '\u03ae',
  '\u03b9': '\u03af', '\u03bf': '\u03cc', '\u03c5': '\u03cd', '\u03c9': '\u03ce',
};
function stripAllAccents(str) {
  let result = '';
  for (const ch of str) result += ACCENTED_TO_PLAIN[ch] || ch;
  return result;
}
function addAcuteToLastVowel(stem) {
  const bare = stripAllAccents(stem);
  const idx = lastVowelIndex(bare);
  if (idx === -1) return bare;
  const acute = PLAIN_TO_ACUTE[bare[idx]];
  if (!acute) return bare;
  return bare.slice(0, idx) + acute + bare.slice(idx + 1);
}

// Needed for the -ντ-stem participles below: the neuter singular of a
// present/aorist active participle (λῦον, λῦσαν) takes a CIRCUMFLEX where
// the masculine takes acute (λύων, λύσας) -- losing the final -τ of the
// -ντ stem without a case ending leaves a "long vowel + no following
// consonant" syllable, which is exactly the shape that requires
// circumflex rather than acute recessive accent.
const PLAIN_TO_CIRCUMFLEX = {
  '\u03b1': '\u1fb6', '\u03b7': '\u1fc6', '\u03b9': '\u1fd6',
  '\u03c5': '\u1fe6', '\u03c9': '\u1ff6',
};
function addCircumflexToLastVowel(stem) {
  const bare = stripAllAccents(stem);
  const idx = lastVowelIndex(bare);
  if (idx === -1) return bare;
  const circ = PLAIN_TO_CIRCUMFLEX[bare[idx]];
  if (!circ) return bare;
  return bare.slice(0, idx) + circ + bare.slice(idx + 1);
}

function greekDecl1NounParadigm(word) {
  const headword = word.headword;
  const gen = word.genitive;
  const s = gen.slice(0, -2);

  if (countGreekVowels(headword) === 1) {
    // Only γῆ in this dataset: a contracted monosyllable, circumflex
    // throughout every form (confirmed against attested γῆ/γῆς/γῇ/γῆν).
    return {
      sg: { nom: headword, gen: gen, dat: s + '\u1fc7', acc: s + '\u1fc6\u03bd', voc: headword },
      pl: { nom: s + '\u1fb6\u03b9', gen: s + '\u1ff6\u03bd', dat: s + '\u1fb6\u03b9\u03c2', acc: s + '\u1fb6\u03c2', voc: s + '\u1fb6\u03b9' },
    };
  }

  if (word.gender === 'm') {
    if (isOxytone(headword)) {
      return {
        sg: { nom: headword, gen: gen, dat: s + '\u1fc7', acc: s + '\u03ae\u03bd', voc: s + '\u03ac' },
        pl: { nom: s + '\u03b1\u03af', gen: s + '\u1ff6\u03bd', dat: s + '\u03b1\u1fd6\u03c2', acc: s + '\u03ac\u03c2', voc: s + '\u03b1\u03af' },
      };
    }
    if (!isAccentOnStemFinalSyllable(headword, 2)) {
      // Proparoxytone masc. -ης noun: same forward-shift issue as the
      // 2nd-declension case below, for the same short-ultima forms.
      // (No word in the current dataset actually needs this branch --
      // στρατιώτης/πολίτης/προφήτης are all paroxytone -- but the fix
      // mirrors the verified 2nd-declension and feminine ones so a future
      // proparoxytone masc. noun doesn't silently regress.)
      const properStem = headword.slice(0, -2);
      return {
        sg: { nom: headword, gen: gen, dat: s + '\u1fc3', acc: s + '\u03b7\u03bd', voc: properStem + '\u03b1' },
        pl: { nom: properStem + '\u03b1\u03b9', gen: decl1GenPl(s), dat: s + '\u03b1\u03b9\u03c2', acc: s + '\u03b1\u03c2', voc: properStem + '\u03b1\u03b9' },
      };
    }
    const shifted = citationAccentOnStemFinalSyllable(headword, 2) ? shiftAcuteForShortUltimaPlural(s) : s;
    return {
      sg: { nom: headword, gen: gen, dat: s + '\u1fc3', acc: s + '\u03b7\u03bd', voc: shifted + '\u03b1' },
      pl: { nom: shifted + '\u03b1\u03b9', gen: decl1GenPl(s), dat: s + '\u03b1\u03b9\u03c2', acc: s + '\u03b1\u03c2', voc: shifted + '\u03b1\u03b9' },
    };
  }

  // feminine
  if (isOxytone(headword)) {
    return {
      sg: { nom: headword, gen: gen, dat: s + '\u1fc7', acc: s + '\u03ae\u03bd', voc: headword },
      pl: { nom: s + '\u03b1\u03af', gen: s + '\u1ff6\u03bd', dat: s + '\u03b1\u1fd6\u03c2', acc: s + '\u03ac\u03c2', voc: s + '\u03b1\u03af' },
    };
  }
  const genIsAlphaType = gen.endsWith('\u03b1\u03c2');
  const nomEndsInAlpha = headword.endsWith('\u03b1');
  const datEnd = genIsAlphaType ? '\u1fb3' : '\u1fc3';
  const accEnd = nomEndsInAlpha ? '\u03b1\u03bd' : '\u03b7\u03bd';
  const nomEndingLen = 1; // feminine nom. sg. is always a bare -α or -η
  if (!isAccentOnStemFinalSyllable(headword, nomEndingLen)) {
    // Proparoxytone feminine, e.g. θάλασσα -> gen. θαλάσσης: the long
    // genitive ultima forces the antepenult accent forward, so accusative
    // singular and nom./voc. plural (short endings, accent legally back on
    // the antepenult) need the headword's own stem instead of the
    // genitive-derived one -- θάλασσαν/θάλασσαι, not θαλάσσαν/θαλάσσαι.
    const properStem = headword.slice(0, -1);
    return {
      sg: { nom: headword, gen: gen, dat: s + datEnd, acc: properStem + accEnd, voc: headword },
      pl: { nom: properStem + '\u03b1\u03b9', gen: decl1GenPl(s), dat: s + '\u03b1\u03b9\u03c2', acc: s + '\u03b1\u03c2', voc: properStem + '\u03b1\u03b9' },
    };
  }
  const shifted = citationAccentOnStemFinalSyllable(headword, nomEndingLen) ? shiftAcuteForShortUltimaPlural(s) : s;
  return {
    sg: { nom: headword, gen: gen, dat: s + datEnd, acc: s + accEnd, voc: headword },
    pl: { nom: shifted + '\u03b1\u03b9', gen: decl1GenPl(s), dat: s + '\u03b1\u03b9\u03c2', acc: s + '\u03b1\u03c2', voc: shifted + '\u03b1\u03b9' },
  };
}

function greekNounParadigm(word) {
  const gen = word.genitive;
  if (word.declension === '1') {
    return greekDecl1NounParadigm(word);
  }
  if (word.declension === '2') {
    const s = gen.slice(0, -2);
    if (word.gender === 'n') {
      return {
        sg: { nom: word.headword, gen: s + '\u03bf\u03c5', dat: s + '\u1ff3', acc: word.headword, voc: word.headword },
        pl: { nom: s + '\u03b1', gen: s + '\u03c9\u03bd', dat: s + '\u03bf\u03b9\u03c2', acc: s + '\u03b1', voc: s + '\u03b1' },
      };
    }
    if (isOxytone(word.headword)) {
      // Vocative singular of an oxytone masc. noun (θεός etc.) is
      // irregular and, per standard practice, just repeats the
      // nominative rather than using the regular short -ε ending.
      return {
        sg: { nom: word.headword, gen: gen, dat: s + '\u1ff7', acc: s + '\u03cc\u03bd', voc: word.headword },
        pl: { nom: s + '\u03bf\u03af', gen: s + '\u1ff6\u03bd', dat: s + '\u03bf\u1fd6\u03c2', acc: s + '\u03bf\u03cd\u03c2', voc: s + '\u03bf\u03af' },
      };
    }
    if (!isAccentOnStemFinalSyllable(word.headword, 2)) {
      // Proparoxytone (antepenult-accented, e.g. ἄνθρωπος): the genitive's
      // long -ου ending forces that accent one syllable forward (ἀνθρώπου),
      // so a stem borrowed from the genitive carries the WRONG syllable for
      // any other form whose own ending is short enough to allow the accent
      // back on the antepenult -- accusative/vocative singular (-ον/-ε) and
      // nominative/vocative plural (-οι, short by the same exception used
      // for 1st declension). Those forms are built from the headword's own
      // stem instead, which already has the accent in the right place;
      // genitive/dative singular and the plural's long endings keep using
      // the genitive-derived stem, since those forms DO take the forward
      // shift for real (ἀνθρώπου, ἀνθρώπῳ, ἀνθρώπων, ἀνθρώποις, ἀνθρώπους).
      const properStem = word.headword.slice(0, -2);
      return {
        sg: { nom: word.headword, gen: s + '\u03bf\u03c5', dat: s + '\u1ff3', acc: properStem + '\u03bf\u03bd', voc: properStem + '\u03b5' },
        pl: { nom: properStem + '\u03bf\u03b9', gen: s + '\u03c9\u03bd', dat: s + '\u03bf\u03b9\u03c2', acc: s + '\u03bf\u03c5\u03c2', voc: properStem + '\u03bf\u03b9' },
      };
    }
    const plStem = citationAccentOnStemFinalSyllable(word.headword, 2) ? shiftAcuteForShortUltimaPlural(s) : s;
    return {
      sg: { nom: word.headword, gen: s + '\u03bf\u03c5', dat: s + '\u1ff3', acc: s + '\u03bf\u03bd', voc: s + '\u03b5' },
      pl: { nom: plStem + '\u03bf\u03b9', gen: s + '\u03c9\u03bd', dat: s + '\u03bf\u03b9\u03c2', acc: s + '\u03bf\u03c5\u03c2', voc: plStem + '\u03bf\u03b9' },
    };
  }
  if (word.declension === '3') {
    const stem = gen.slice(0, -2);
    if (word.gender === 'n') {
      return {
        sg: { nom: word.headword, gen: stem + '\u03bf\u03c5\u03c2', dat: stem + '\u03b1', acc: word.headword, voc: word.headword },
        pl: { nom: stem + '\u03b1', gen: stem + '\u03c9\u03bd', dat: datPlEnding(stem), acc: stem + '\u03b1', voc: stem + '\u03b1' },
      };
    }
    return {
      sg: { nom: word.headword, gen: stem + '\u03bf\u03c2', dat: stem + '\u03b1', acc: stem + '\u03b1', voc: word.headword },
      pl: { nom: stem + '\u03b5\u03c2', gen: stem + '\u03c9\u03bd', dat: datPlEnding(stem), acc: stem + '\u03b1\u03c2', voc: stem + '\u03b5\u03c2' },
    };
  }
  return null;
}

function datPlEnding(stem) {
  const last = stem.slice(-1);
  const rest = stem.slice(0, -1);
  if ('\u03ba\u03b3\u03c7'.includes(last)) return rest + '\u03be\u03b9\u03bd';
  if ('\u03c0\u03b2\u03c6'.includes(last)) return rest + '\u03c8\u03b9\u03bd';
  if ('\u03c4\u03b4\u03b8\u03bd'.includes(last)) return rest + '\u03c3\u03b9\u03bd';
  return stem + '\u03c3\u03b9\u03bd';
}

function latinAdj3Paradigm(word, gender) {
  if (!word.adjForms || !word.genitive) return null;
  const nomSg = word.adjForms[gender];
  if (!nomSg) return null;
  const stem = word.genitive.replace(/is$/, '');
  if (gender === 'n') {
    return {
      sg: { nom: nomSg, gen: stem + 'is', dat: stem + '\u012b', acc: nomSg, abl: stem + '\u012b', voc: nomSg },
      pl: { nom: stem + 'ia', gen: stem + 'ium', dat: stem + 'ibus', acc: stem + 'ia', abl: stem + 'ibus', voc: stem + 'ia' },
    };
  }
  return {
    sg: { nom: nomSg, gen: stem + 'is', dat: stem + '\u012b', acc: stem + 'em', abl: stem + '\u012b', voc: nomSg },
    pl: { nom: stem + '\u0113s', gen: stem + 'ium', dat: stem + 'ibus', acc: stem + '\u0113s', abl: stem + 'ibus', voc: stem + '\u0113s' },
  };
}

// Generic 1st/2nd-declension (masc -us / fem -a / neut -um) adjective
// declension, parameterized directly by spelling -- shared by
// latinAdjParadigm above and the perfect passive / future active /
// gerundive participle generators below, all three of which decline
// exactly like a regular -us/-a/-um adjective once you know their three
// nominative singular forms.
function latin12AdjLikeParadigm(masc, fem, neut, gender) {
  if (gender === 'm') {
    const stem = masc.replace(/us$/, '');
    return {
      sg: { nom: masc, gen: stem + '\u012b', dat: stem + '\u014d', acc: stem + 'um', abl: stem + '\u014d', voc: stem + 'e' },
      pl: { nom: stem + '\u012b', gen: stem + '\u014drum', dat: stem + '\u012bs', acc: stem + '\u014ds', abl: stem + '\u012bs', voc: stem + '\u012b' },
    };
  }
  if (gender === 'f') {
    const stem = fem.replace(/a$/, '');
    return {
      sg: { nom: fem, gen: stem + 'ae', dat: stem + 'ae', acc: stem + 'am', abl: stem + '\u0101', voc: fem },
      pl: { nom: stem + 'ae', gen: stem + '\u0101rum', dat: stem + '\u012bs', acc: stem + '\u0101s', abl: stem + '\u012bs', voc: stem + 'ae' },
    };
  }
  if (gender === 'n') {
    const stem = neut.replace(/um$/, '');
    return {
      sg: { nom: neut, gen: stem + '\u012b', dat: stem + '\u014d', acc: neut, abl: stem + '\u014d', voc: neut },
      pl: { nom: stem + 'a', gen: stem + '\u014drum', dat: stem + '\u012bs', acc: stem + 'a', abl: stem + '\u012bs', voc: stem + 'a' },
    };
  }
  return null;
}

// Present active participle: a 3rd-declension nasal-stem adjective with
// a single nominative singular form shared by all three genders (amans
// serves as masc., fem., AND neut. nom./voc./acc. sg. alike) -- a
// different pattern from every other Latin adjective type this file
// otherwise generates, and not reducible to any of them. i-stem in the
// plural (genitive -ium), but ablative singular -e (not -i) throughout,
// since that's the standard form for a participle used verbally rather
// than as a substantivized adjective.
function latinPresActPartParadigm(word, gender) {
  const conj = word.conjugation;
  const presInf = word.principalParts && word.principalParts[1];
  if (!presInf) return null;
  let partStem;
  if (conj === '1' || conj === '2') {
    partStem = presInf.slice(0, -2) + 'nt';
  } else if (conj === '4') {
    if (!presInf.endsWith('ire')) return null;
    partStem = presInf.slice(0, -2) + 'ent';
  } else if (conj === '3' || conj === '3-io') {
    if (!presInf.endsWith('ere')) return null;
    const bare = presInf.slice(0, -3);
    partStem = conj === '3-io' ? bare + 'ient' : bare + 'ent';
  } else {
    return null;
  }
  const nomSg = partStem.slice(0, -1) + 's'; // amant- -> amans
  if (gender === 'n') {
    return {
      sg: { nom: nomSg, gen: partStem + 'is', dat: partStem + '\u012b', acc: nomSg, abl: partStem + 'e', voc: nomSg },
      pl: { nom: partStem + 'ia', gen: partStem + 'ium', dat: partStem + 'ibus', acc: partStem + 'ia', abl: partStem + 'ibus', voc: partStem + 'ia' },
    };
  }
  if (gender === 'm' || gender === 'f') {
    return {
      sg: { nom: nomSg, gen: partStem + 'is', dat: partStem + '\u012b', acc: partStem + 'em', abl: partStem + 'e', voc: nomSg },
      pl: { nom: partStem + '\u0113s', gen: partStem + 'ium', dat: partStem + 'ibus', acc: partStem + '\u0113s', abl: partStem + 'ibus', voc: partStem + '\u0113s' },
    };
  }
  return null;
}

// Perfect passive, future active, and gerundive (future passive) all
// reuse the regular -us/-a/-um adjective pattern above; only the present
// active participle needs its own generator. Future active is just the
// perfect passive participle's stem + -urus; the gerundive is the
// present stem + -ndus, varying by conjugation the same way the present
// tense forms earlier in this file do.
function latinParticipleParadigm(word, tense, gender) {
  if (tense === 'pres-act-part') {
    return latinPresActPartParadigm(word, gender);
  }
  const perfPassPart = word.principalParts && word.principalParts[3];
  if (tense === 'perf-pass-part') {
    if (!perfPassPart || !perfPassPart.endsWith('us')) return null;
    const stem = perfPassPart.slice(0, -2);
    return latin12AdjLikeParadigm(perfPassPart, stem + 'a', stem + 'um', gender);
  }
  if (tense === 'fut-act-part') {
    if (!perfPassPart || !perfPassPart.endsWith('us')) return null;
    const stem = perfPassPart.slice(0, -2) + 'ur';
    return latin12AdjLikeParadigm(stem + 'us', stem + 'a', stem + 'um', gender);
  }
  if (tense === 'gerundive') {
    const conj = word.conjugation;
    const presInf = word.principalParts && word.principalParts[1];
    if (!presInf) return null;
    let stem;
    if (conj === '1' || conj === '2') {
      stem = presInf.slice(0, -2) + 'nd';
    } else if (conj === '4') {
      if (!presInf.endsWith('ire')) return null;
      stem = presInf.slice(0, -2) + 'end';
    } else if (conj === '3' || conj === '3-io') {
      if (!presInf.endsWith('ere')) return null;
      const bare = presInf.slice(0, -3);
      stem = conj === '3-io' ? bare + 'iend' : bare + 'end';
    } else {
      return null;
    }
    return latin12AdjLikeParadigm(stem + 'us', stem + 'a', stem + 'um', gender);
  }
  return null;
}

function latinAdjParadigm(word, gender) {
  if (word.declension === '3') return latinAdj3Paradigm(word, gender);
  if (word.declension !== '1-2' || !word.adjForms) return null;
  if (gender === 'm') {
    const stem = word.adjForms.m.replace(/us$/, '');
    return {
      sg: { nom: word.adjForms.m, gen: stem + '\u012b', dat: stem + '\u014d', acc: stem + 'um', abl: stem + '\u014d', voc: stem + 'e' },
      pl: { nom: stem + '\u012b', gen: stem + '\u014drum', dat: stem + '\u012bs', acc: stem + '\u014ds', abl: stem + '\u012bs', voc: stem + '\u012b' },
    };
  }
  if (gender === 'f') {
    const stem = word.adjForms.f.replace(/a$/, '');
    return {
      sg: { nom: word.adjForms.f, gen: stem + 'ae', dat: stem + 'ae', acc: stem + 'am', abl: stem + '\u0101', voc: word.adjForms.f },
      pl: { nom: stem + 'ae', gen: stem + '\u0101rum', dat: stem + '\u012bs', acc: stem + '\u0101s', abl: stem + '\u012bs', voc: stem + 'ae' },
    };
  }
  if (gender === 'n') {
    const stem = word.adjForms.n.replace(/um$/, '');
    return {
      sg: { nom: word.adjForms.n, gen: stem + '\u012b', dat: stem + '\u014d', acc: word.adjForms.n, abl: stem + '\u014d', voc: word.adjForms.n },
      pl: { nom: stem + 'a', gen: stem + '\u014drum', dat: stem + '\u012bs', acc: stem + 'a', abl: stem + '\u012bs', voc: stem + 'a' },
    };
  }
  return null;
}

function greekAdj3Paradigm(word, gender) {
  if (!word.adjForms) return null;
  const nomSg = word.adjForms[gender];
  if (!nomSg) return null;
  const root = word.adjForms.m.slice(0, -2);
  if (gender === 'n') {
    return {
      sg: { nom: nomSg, gen: root + '\u03bf\u1fe6\u03c2', dat: root + '\u03b5\u1fd6', acc: nomSg, voc: nomSg },
      pl: { nom: root + '\u1fc6', gen: root + '\u1ff6\u03bd', dat: root + '\u03ad\u03c3\u03b9\u03bd', acc: root + '\u1fc6', voc: root + '\u1fc6' },
    };
  }
  return {
    sg: { nom: nomSg, gen: root + '\u03bf\u1fe6\u03c2', dat: root + '\u03b5\u1fd6', acc: root + '\u1fc6', voc: nomSg },
    pl: { nom: root + '\u03b5\u1fd6\u03c2', gen: root + '\u1ff6\u03bd', dat: root + '\u03ad\u03c3\u03b9\u03bd', acc: root + '\u03b5\u1fd6\u03c2', voc: root + '\u03b5\u1fd6\u03c2' },
  };
}

function greekAdjParadigm(word, gender) {
  if (word.declension === '3') return greekAdj3Paradigm(word, gender);
  if (word.declension !== '2-1-2' || !word.adjForms) return null;
  if (gender === 'm') {
    const stem = word.adjForms.m.slice(0, -2);
    const plStem = citationAccentOnStemFinalSyllable(word.adjForms.m, 2) ? shiftAcuteForShortUltimaPlural(stem) : stem;
    return {
      sg: { nom: word.adjForms.m, gen: stem + '\u03bf\u03c5', dat: stem + '\u1ff3', acc: stem + '\u03bf\u03bd', voc: stem + '\u03b5' },
      pl: { nom: plStem + '\u03bf\u03b9', gen: stem + '\u03c9\u03bd', dat: stem + '\u03bf\u03b9\u03c2', acc: stem + '\u03bf\u03c5\u03c2', voc: plStem + '\u03bf\u03b9' },
    };
  }
  if (gender === 'f') {
    const fem = word.adjForms.f;
    const lastBase = fem.slice(-1).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const isAlphaType = lastBase === '\u03b1';
    const stem = fem.slice(0, -1);
    const plStem = citationAccentOnStemFinalSyllable(fem, 1) ? shiftAcuteForShortUltimaPlural(stem) : stem;
    const genEnd = isAlphaType ? '\u03b1\u03c2' : '\u03b7\u03c2';
    const datEnd = isAlphaType ? '\u1fb3' : '\u1fc3';
    const accEnd = isAlphaType ? '\u03b1\u03bd' : '\u03b7\u03bd';
    return {
      sg: { nom: fem, gen: stem + genEnd, dat: stem + datEnd, acc: stem + accEnd, voc: fem },
      pl: { nom: plStem + '\u03b1\u03b9', gen: stem + '\u03c9\u03bd', dat: stem + '\u03b1\u03b9\u03c2', acc: stem + '\u03b1\u03c2', voc: plStem + '\u03b1\u03b9' },
    };
  }
  if (gender === 'n') {
    const stem = word.adjForms.n.slice(0, -2);
    return {
      sg: { nom: word.adjForms.n, gen: stem + '\u03bf\u03c5', dat: stem + '\u1ff3', acc: word.adjForms.n, voc: word.adjForms.n },
      pl: { nom: stem + '\u03b1', gen: stem + '\u03c9\u03bd', dat: stem + '\u03bf\u03b9\u03c2', acc: stem + '\u03b1', voc: stem + '\u03b1' },
    };
  }
  return null;
}

// Generic 2-1-2 (masc -ος / fem -η / neut -ον) declension, parameterized
// directly by spelling rather than reading word.adjForms -- shared by
// greekAdjParadigm above and the present/aorist middle participle
// generators below, since a participle isn't a headword of its own but
// still declines exactly like one of these adjectives once you know its
// three nominative singular forms.
function greek212AdjLikeParadigm(masc, fem, neut, gender) {
  if (gender === 'm') {
    const stem = masc.slice(0, -2);
    // Same forward-shift as the proparoxytone 2nd-declension nouns above
    // (ἄνθρωπος-type): if the accent isn't already on the stem's own last
    // syllable, the long genitive/dative endings force it there, e.g.
    // λυομένου not λυόμενου. This is a no-op for any already-paroxytone
    // adjective, so it's safe to fold into the generic helper.
    const oblStem = citationAccentOnStemFinalSyllable(masc, 2) ? stem : addAcuteToLastVowel(stem);
    const plStem = citationAccentOnStemFinalSyllable(masc, 2) ? shiftAcuteForShortUltimaPlural(stem) : stem;
    return {
      sg: { nom: masc, gen: oblStem + '\u03bf\u03c5', dat: oblStem + '\u1ff3', acc: stem + '\u03bf\u03bd', voc: stem + '\u03b5' },
      pl: { nom: plStem + '\u03bf\u03b9', gen: oblStem + '\u03c9\u03bd', dat: oblStem + '\u03bf\u03b9\u03c2', acc: oblStem + '\u03bf\u03c5\u03c2', voc: plStem + '\u03bf\u03b9' },
    };
  }
  if (gender === 'f') {
    const stem = fem.slice(0, -1);
    const plStem = citationAccentOnStemFinalSyllable(fem, 1) ? shiftAcuteForShortUltimaPlural(stem) : stem;
    return {
      sg: { nom: fem, gen: stem + '\u03b7\u03c2', dat: stem + '\u1fc3', acc: stem + '\u03b7\u03bd', voc: fem },
      pl: { nom: plStem + '\u03b1\u03b9', gen: stem + '\u03c9\u03bd', dat: stem + '\u03b1\u03b9\u03c2', acc: stem + '\u03b1\u03c2', voc: plStem + '\u03b1\u03b9' },
    };
  }
  if (gender === 'n') {
    const stem = neut.slice(0, -2);
    const oblStem = citationAccentOnStemFinalSyllable(neut, 2) ? stem : addAcuteToLastVowel(stem);
    return {
      sg: { nom: neut, gen: oblStem + '\u03bf\u03c5', dat: oblStem + '\u1ff3', acc: neut, voc: neut },
      pl: { nom: stem + '\u03b1', gen: oblStem + '\u03c9\u03bd', dat: oblStem + '\u03bf\u03b9\u03c2', acc: stem + '\u03b1', voc: stem + '\u03b1' },
    };
  }
  return null;
}

// Present and aorist-middle participles are the only ones covered here --
// present covers both middle and passive senses (the two aren't
// morphologically distinct in the present system, same as this app's
// pres-mp indicative), but AORIST passive uses a completely different,
// harder 3rd-declension pattern (-θείς/-θεῖσα/-θέν) that isn't modeled;
// active participles (a 3rd-declension nasal-stem type of their own) also
// aren't modeled. Both are future scope.
//
// Accent: masc./neut. -ος/-ον count short, so the recessive accent sits
// on the antepenult -- which, since -ομενος/-αμενος is always exactly
// three syllables, is always that ending's own first syllable, no matter
// how long the verb stem in front of it is (λυόμενος, βαπτιζόμενος).
// Feminine -η is long, which blocks the antepenult and pushes the same
// recessive accent one syllable later, onto the ending's second syllable
// instead (λυομένη, βαπτιζομένη) -- confirmed against attested forms
// rather than assumed, since this is exactly the kind of noun-side
// mistake already made and fixed once already in this file.
// Accent a link vowel that may itself be a single letter (α, for the
// aorist active/passive) or a diphthong (ου/ει, from the -ντ-stem +
// σ assimilation) -- Greek always writes the accent mark on a
// diphthong's SECOND letter (καί, not κάι), never the first.
function accentLinkVowel(link) {
  if (link.length === 1) return PLAIN_TO_ACUTE[link] || link;
  return link[0] + (PLAIN_TO_ACUTE[link[1]] || link[1]);
}
function circumflexLinkVowel(link) {
  if (link.length === 1) return PLAIN_TO_CIRCUMFLEX[link] || link;
  return link[0] + (PLAIN_TO_CIRCUMFLEX[link[1]] || link[1]);
}

// Present and aorist (the regular -αι- forms) active optative share one
// shape: the accent stays fixed on the stem's own vowel through every
// person -- unlike the middle/passive optative below, nothing here ever
// shifts forward, confirmed against attested full paradigms (λύοιμι,
// λύοις, λύοι, λύοιμεν, λύοιτε, λύοιεν all keep the accent on λυ).
function greekActiveOptative(stem, moodMarker) {
  const accented = addAcuteToLastVowel(stem);
  return {
    '1sg': accented + moodMarker + '\u03bc\u03b9', '2sg': accented + moodMarker + '\u03c2', '3sg': accented + moodMarker,
    '1pl': accented + moodMarker + '\u03bc\u03b5\u03bd', '2pl': accented + moodMarker + '\u03c4\u03b5', '3pl': accented + moodMarker + '\u03b5\u03bd',
  };
}

// Middle/passive optative (present and aorist middle): unlike the active
// above, the 1st singular (-μην) and 1st plural (-μεθα) endings are long
// enough to force the accent one syllable forward, onto the mood marker
// itself (λυοίμην/λυσαίμην, λυοίμεθα/λυσαίμεθα) -- every other person
// keeps the accent on the stem, same as active.
function greekMiddleOptative(stem, moodMarker) {
  const accented = addAcuteToLastVowel(stem);
  const shifted = stripAllAccents(stem) + accentLinkVowel(moodMarker);
  return {
    '1sg': shifted + '\u03bc\u03b7\u03bd', '2sg': accented + moodMarker + '\u03bf', '3sg': accented + moodMarker + '\u03c4\u03bf',
    '1pl': shifted + '\u03bc\u03b5\u03b8\u03b1', '2pl': accented + moodMarker + '\u03c3\u03b8\u03b5', '3pl': accented + moodMarker + '\u03bd\u03c4\u03bf',
  };
}

// Present and aorist active participles (λύων/λύουσα/λῦον,
// λύσας/λύσασα/λῦσαν) share one shape: a recessive-accented 3rd-
// declension -ντ- stem for masc./neut., alongside a 1st-declension
// -ουσα/-ασα feminine built by the same ντ+σ -> υσ/σ assimilation that
// also produces the masc./neut. dative plural (λύουσι, λύσασι). Only the
// link vowel (ο for present, α for aorist active) and the two irregular
// nominative-singular forms (masc. -ων/-ας, neut. -ον/-αν, both from
// the same lost final -τ that gives the neuter its circumflex) differ
// between the two tenses.
function greekNtStemActiveParticiple(bareStem, linkVowel, gender) {
  const assimLink = linkVowel === '\u03bf' ? '\u03bf\u03c5' : '\u03b1'; // ο -> ου, α stays α
  const mascNomEnding = linkVowel === '\u03bf' ? '\u03c9\u03bd' : '\u03b1\u03c2'; // -ων or (with accented stem) -ας
  const neutEnding = linkVowel === '\u03bf' ? '\u03bf\u03bd' : '\u03b1\u03bd';
  const stem = stripAllAccents(bareStem);
  const accentedStem = addAcuteToLastVowel(bareStem); // e.g. λύ -- used wherever the ending is short enough to keep the accent recessive on the stem's own vowel
  const shiftedNt = stem + accentLinkVowel(linkVowel) + '\u03bd\u03c4\u03c9\u03bd'; // long -ων genitive plural forces the accent one syllable forward, onto the link vowel (λυόντων/λυσάντων)

  if (gender === 'm' || gender === 'n') {
    const ntStem = accentedStem + linkVowel + '\u03bd\u03c4'; // e.g. λύοντ, λύσαντ
    const datPl = accentedStem + assimLink + '\u03c3\u03b9\u03bd'; // λύουσιν, λύσασιν
    if (gender === 'n') {
      const sgForm = addCircumflexToLastVowel(bareStem) + neutEnding; // λῦον, λῦσαν
      return {
        sg: { nom: sgForm, gen: ntStem + '\u03bf\u03c2', dat: ntStem + '\u03b9', acc: sgForm, voc: sgForm },
        pl: { nom: ntStem + '\u03b1', gen: shiftedNt, dat: datPl, acc: ntStem + '\u03b1', voc: ntStem + '\u03b1' },
      };
    }
    const nomSg = accentedStem + mascNomEnding; // λύων, λύσας
    return {
      sg: { nom: nomSg, gen: ntStem + '\u03bf\u03c2', dat: ntStem + '\u03b9', acc: ntStem + '\u03b1', voc: nomSg },
      pl: { nom: ntStem + '\u03b5\u03c2', gen: shiftedNt, dat: datPl, acc: ntStem + '\u03b1\u03c2', voc: ntStem + '\u03b5\u03c2' },
    };
  }
  if (gender === 'f') {
    const femStem = accentedStem + assimLink + '\u03c3'; // λύουσ, λύσασ -- short endings keep the accent here
    const femStemShifted = stem + accentLinkVowel(assimLink) + '\u03c3'; // λυούσ, λυσάσ -- long endings (gen./dat. sg., dat./acc. pl.) force it forward
    return {
      sg: {
        nom: femStem + '\u03b1', gen: femStemShifted + '\u03b7\u03c2', dat: femStemShifted + '\u1fc3',
        acc: femStem + '\u03b1\u03bd', voc: femStem + '\u03b1',
      },
      pl: {
        nom: femStem + '\u03b1\u03b9', gen: decl1GenPl(stem + assimLink + '\u03c3'),
        dat: femStemShifted + '\u03b1\u03b9\u03c2', acc: femStemShifted + '\u03b1\u03c2', voc: femStem + '\u03b1\u03b9',
      },
    };
  }
  return null;
}

// Aorist passive participle (λυθείς/λυθεῖσα/λυθέν): a DIFFERENT accent
// behaviour from the two above -- it's oxytone, meaning the accent stays
// fixed on the same syllable (the θη-stem's own vowel) through the whole
// paradigm rather than receding/advancing with ultima length. What
// changes instead is only the mark: acute on a plain or long-ultima
// syllable, circumflex wherever that fixed syllable happens to land as a
// long diphthong (εί/εῖ) before a short ultima -- λυθείς but λυθεῖσα,
// λυθεῖσι.
function greekAoristPassiveParticiple(thStem, gender) {
  const stem = stripAllAccents(thStem);
  const acute = stem + '\u03b5\u03af'; // θεί, e.g. λυθεί
  const circ = stem + '\u03b5\u1fd6'; // θεῖ, e.g. λυθεῖ
  const plainE = stem + '\u03ad'; // θέ (plain epsilon, no diphthong -- before -ντ-)
  if (gender === 'm') {
    return {
      sg: { nom: acute + '\u03c2', gen: plainE + '\u03bd\u03c4\u03bf\u03c2', dat: plainE + '\u03bd\u03c4\u03b9', acc: plainE + '\u03bd\u03c4\u03b1', voc: acute + '\u03c2' },
      pl: { nom: plainE + '\u03bd\u03c4\u03b5\u03c2', gen: plainE + '\u03bd\u03c4\u03c9\u03bd', dat: circ + '\u03c3\u03b9\u03bd', acc: plainE + '\u03bd\u03c4\u03b1\u03c2', voc: plainE + '\u03bd\u03c4\u03b5\u03c2' },
    };
  }
  if (gender === 'n') {
    const sgForm = plainE + '\u03bd';
    return {
      sg: { nom: sgForm, gen: plainE + '\u03bd\u03c4\u03bf\u03c2', dat: plainE + '\u03bd\u03c4\u03b9', acc: sgForm, voc: sgForm },
      pl: { nom: plainE + '\u03bd\u03c4\u03b1', gen: plainE + '\u03bd\u03c4\u03c9\u03bd', dat: circ + '\u03c3\u03b9\u03bd', acc: plainE + '\u03bd\u03c4\u03b1', voc: plainE + '\u03bd\u03c4\u03b1' },
    };
  }
  if (gender === 'f') {
    return {
      sg: { nom: circ + '\u03c3\u03b1', gen: acute + '\u03c3\u03b7\u03c2', dat: acute + '\u03c3\u1fc3', acc: circ + '\u03c3\u03b1\u03bd', voc: circ + '\u03c3\u03b1' },
      pl: { nom: circ + '\u03c3\u03b1\u03b9', gen: decl1GenPl(stem + '\u03b5\u03b9\u03c3'), dat: acute + '\u03c3\u03b1\u03b9\u03c2', acc: acute + '\u03c3\u03b1\u03c2', voc: circ + '\u03c3\u03b1\u03b9' },
    };
  }
  return null;
}

// Perfect active participle (λελυκώς/λελυκυῖα/λελυκός): oxytone like the
// aorist passive above, but with its own -οτ-/-υι- stems rather than
// -εντ-, and its own vowel-length behavior -- masc./neut. is a plain
// (non-diphthong) vowel throughout so it never needs the circumflex
// alternation aorist passive's -ει- diphthong does; feminine's -υι-
// diphthong does need it (circumflex on a short ultima, acute on a
// long one), the same mechanism as aorist passive's -ει-.
function greekPerfectActiveParticiple(perfStem, gender) {
  const stem = stripAllAccents(perfStem);
  if (gender === 'm') {
    return {
      sg: { nom: stem + '\u03ce\u03c2', gen: stem + '\u03cc\u03c4\u03bf\u03c2', dat: stem + '\u03cc\u03c4\u03b9', acc: stem + '\u03cc\u03c4\u03b1', voc: stem + '\u03ce\u03c2' },
      pl: { nom: stem + '\u03cc\u03c4\u03b5\u03c2', gen: stem + '\u03cc\u03c4\u03c9\u03bd', dat: stem + '\u03cc\u03c3\u03b9\u03bd', acc: stem + '\u03cc\u03c4\u03b1\u03c2', voc: stem + '\u03cc\u03c4\u03b5\u03c2' },
    };
  }
  if (gender === 'n') {
    const sgForm = stem + '\u03cc\u03c2';
    return {
      sg: { nom: sgForm, gen: stem + '\u03cc\u03c4\u03bf\u03c2', dat: stem + '\u03cc\u03c4\u03b9', acc: sgForm, voc: sgForm },
      pl: { nom: stem + '\u03cc\u03c4\u03b1', gen: stem + '\u03cc\u03c4\u03c9\u03bd', dat: stem + '\u03cc\u03c3\u03b9\u03bd', acc: stem + '\u03cc\u03c4\u03b1', voc: stem + '\u03cc\u03c4\u03b1' },
    };
  }
  if (gender === 'f') {
    const circ = stem + '\u03c5\u1fd6'; // υῖ, short-ultima forms
    const acute = stem + '\u03c5\u03af'; // υί, long-ultima forms
    return {
      sg: { nom: circ + '\u03b1', gen: acute + '\u03b1\u03c2', dat: acute + '\u1fb3', acc: circ + '\u03b1\u03bd', voc: circ + '\u03b1' },
      pl: { nom: circ + '\u03b1\u03b9', gen: decl1GenPl(stem + '\u03c5\u03b9'), dat: acute + '\u03b1\u03b9\u03c2', acc: acute + '\u03b1\u03c2', voc: circ + '\u03b1\u03b9' },
    };
  }
  return null;
}

function greekParticipleParadigm(word, tense, gender) {
  if (word.conjugation === 'irr') return null;
  const [pres1sg, , aor1sg] = word.principalParts;
  const aorPass1sg = word.principalParts.length >= 5 ? word.principalParts[word.principalParts.length - 1] : undefined;
  // Perfect active sits at index 3 whenever it's present at all (4-, 5-,
  // or 6-part entries); perfect middle/passive is only ever there on a
  // full 6-part entry (index 4) -- on a 5-part entry like λύω's, that
  // slot is the aorist passive instead, already handled above.
  const perfActive = word.principalParts.length >= 4 ? word.principalParts[3] : undefined;
  const perfMidPass = word.principalParts.length === 6 ? word.principalParts[4] : undefined;
  if (tense === 'pres-mp-part') {
    if (!pres1sg || !pres1sg.endsWith('\u03c9')) return null;
    const stem = stripAllAccents(pres1sg.slice(0, -1));
    const masc = stem + '\u03cc\u03bc\u03b5\u03bd\u03bf\u03c2';
    const fem = stem + '\u03bf\u03bc\u03ad\u03bd\u03b7';
    const neut = stem + '\u03cc\u03bc\u03b5\u03bd\u03bf\u03bd';
    return greek212AdjLikeParadigm(masc, fem, neut, gender);
  }
  if (tense === 'pres-act-part') {
    if (!pres1sg || !pres1sg.endsWith('\u03c9')) return null;
    return greekNtStemActiveParticiple(pres1sg.slice(0, -1), '\u03bf', gender);
  }
  if (tense === 'aor-mid-part') {
    const m = aor1sg && aor1sg.match(/^(\u1f10|\u1f14)(.*)\u03b1$/);
    if (!m) return null;
    const astem = addAcuteToLastVowel(m[2]);
    // addAcuteToLastVowel already put an acute on the stem's own last
    // vowel (matching aor-subj); the middle participle's accent belongs
    // one syllable later than that, on the ending's own alpha, so strip
    // that stem accent back off before appending the accented ending.
    const bareStem = stripAllAccents(astem);
    const masc = bareStem + '\u03ac\u03bc\u03b5\u03bd\u03bf\u03c2';
    const fem = bareStem + '\u03b1\u03bc\u03ad\u03bd\u03b7';
    const neut = bareStem + '\u03ac\u03bc\u03b5\u03bd\u03bf\u03bd';
    return greek212AdjLikeParadigm(masc, fem, neut, gender);
  }
  if (tense === 'aor-act-part') {
    const m = aor1sg && aor1sg.match(/^(\u1f10|\u1f14)(.*)\u03b1$/);
    if (!m) return null;
    return greekNtStemActiveParticiple(m[2], '\u03b1', gender);
  }
  if (tense === 'aor-pass-part') {
    const m = aorPass1sg && aorPass1sg.match(/^(\u1f10|\u1f14)(.*\u03b8)\u03b7\u03bd$/);
    if (!m) return null;
    return greekAoristPassiveParticiple(m[2], gender);
  }
  if (tense === 'perf-act-part') {
    if (!perfActive || !perfActive.endsWith('\u03b1')) return null;
    return greekPerfectActiveParticiple(perfActive.slice(0, -1), gender);
  }
  if (tense === 'perf-mp-part') {
    if (!perfMidPass || !perfMidPass.endsWith('\u03bc\u03b1\u03b9')) return null;
    const stem = stripAllAccents(perfMidPass.slice(0, -3));
    const masc = stem + '\u03bc\u03ad\u03bd\u03bf\u03c2';
    const fem = stem + '\u03bc\u03ad\u03bd\u03b7';
    const neut = stem + '\u03bc\u03ad\u03bd\u03bf\u03bd';
    return greek212AdjLikeParadigm(masc, fem, neut, gender);
  }
  return null;
}

function pronounParadigm(word, gender) {
  if (!word.paradigm) return null;
  const cases = state.lang === 'latin' ? LATIN_NOUN_CASES : GREEK_NOUN_CASES;
  const sg = {}, pl = {};
  let any = false;
  cases.forEach(c => {
    const sgVal = word.paradigm[`${c}-sg-${gender}`];
    const plVal = word.paradigm[`${c}-pl-${gender}`];
    if (sgVal) { sg[c] = sgVal; any = true; }
    if (plVal) { pl[c] = plVal; any = true; }
  });
  return any ? { sg, pl } : null;
}

function irregularVerbParadigm(word, tense) {
  if (!word.paradigm) return null;
  const keys = ['1sg', '2sg', '3sg', '1pl', '2pl', '3pl'];
  const result = {};
  let any = false;
  keys.forEach(k => {
    const v = word.paradigm[`${tense}-${k}`];
    if (v) { result[k] = v; any = true; }
  });
  return any ? result : null;
}

function isCaseBasedPos(pos) {
  return pos === 'noun' || pos === 'adjective' || pos === 'pronoun';
}

const LATIN_VERB_TENSES = [
  ['pres', 'Present Active Indicative'],
  ['pres-pass', 'Present Passive Indicative'],
  ['pres-subj', 'Present Active Subjunctive'],
  ['pres-pass-subj', 'Present Passive Subjunctive'],
  ['pres-imp', 'Present Active Imperative'],
  ['pres-pass-imp', 'Present Passive Imperative'],
  ['impf', 'Imperfect Active Indicative'],
  ['impf-pass', 'Imperfect Passive Indicative'],
  ['impf-subj', 'Imperfect Active Subjunctive'],
  ['impf-pass-subj', 'Imperfect Passive Subjunctive'],
  ['fut', 'Future Active Indicative'],
  ['fut-pass', 'Future Passive Indicative'],
  ['perf', 'Perfect Active Indicative'],
  ['perf-pass', 'Perfect Passive Indicative'],
  ['perf-subj', 'Perfect Active Subjunctive'],
  ['perf-pass-subj', 'Perfect Passive Subjunctive'],
  ['plup-subj', 'Pluperfect Active Subjunctive'],
  ['plup-pass-subj', 'Pluperfect Passive Subjunctive'],
  ['pres-act-part', 'Present Active Participle'],
  ['perf-pass-part', 'Perfect Passive Participle'],
  ['fut-act-part', 'Future Active Participle'],
  ['gerundive', 'Gerundive (Future Passive Participle)'],
];
const GREEK_VERB_TENSES = [
  ['pres', 'Present Active Indicative'],
  ['pres-mp', 'Present Middle/Passive Indicative'],
  ['pres-subj', 'Present Active Subjunctive'],
  ['pres-mp-subj', 'Present Middle/Passive Subjunctive'],
  ['pres-opt', 'Present Active Optative'],
  ['pres-mp-opt', 'Present Middle/Passive Optative'],
  ['pres-imp', 'Present Active Imperative'],
  ['pres-mp-imp', 'Present Middle/Passive Imperative'],
  ['impf', 'Imperfect Active Indicative'],
  ['impf-mp', 'Imperfect Middle/Passive Indicative'],
  ['fut', 'Future Active Indicative'],
  ['fut-pass', 'Future Passive Indicative'],
  ['aor', 'Aorist Active Indicative'],
  ['aor-pass', 'Aorist Passive Indicative'],
  ['aor-subj', 'Aorist Active Subjunctive'],
  ['aor-pass-subj', 'Aorist Passive Subjunctive'],
  ['aor-opt', 'Aorist Active Optative'],
  ['aor-mid-opt', 'Aorist Middle Optative'],
  ['aor-imp', 'Aorist Active Imperative'],
  ['aor-mid-imp', 'Aorist Middle Imperative'],
  ['aor-pass-imp', 'Aorist Passive Imperative'],
  ['aor-imp', 'Aorist Active Imperative'],
  ['aor-mid-imp', 'Aorist Middle Imperative'],
  ['aor-pass-imp', 'Aorist Passive Imperative'],
  ['pres-mp-part', 'Present Middle/Passive Participle'],
  ['pres-act-part', 'Present Active Participle'],
  ['aor-mid-part', 'Aorist Middle Participle'],
  ['aor-act-part', 'Aorist Active Participle'],
  ['aor-pass-part', 'Aorist Passive Participle'],
  ['perf-act-part', 'Perfect Active Participle'],
  ['perf-mp-part', 'Perfect Middle/Passive Participle'],
];

function latinVerbParadigm(word, tense) {
  const conj = word.conjugation;
  if (!['1', '2', '3', '3-io', '4'].includes(conj)) return null;
  const [pres1sg, presInf, perf1sg, perfPassPart] = word.principalParts;
  if (!presInf || !presInf.endsWith('re')) return null;

  if (tense === 'perf') {
    if (!perf1sg || !perf1sg.endsWith('i')) return null;
    const pstem = perf1sg.slice(0, -1);
    return {
      '1sg': perf1sg, '2sg': pstem + 'isti', '3sg': pstem + 'it',
      '1pl': pstem + 'imus', '2pl': pstem + 'istis', '3pl': pstem + '\u0113runt',
    };
  }
  if (tense === 'perf-pass') {
    if (!perfPassPart || !perfPassPart.endsWith('us')) return null;
    const sgForm = perfPassPart;
    const plForm = perfPassPart.slice(0, -2) + 'i';
    return {
      '1sg': sgForm + ' sum', '2sg': sgForm + ' es', '3sg': sgForm + ' est',
      '1pl': plForm + ' sumus', '2pl': plForm + ' estis', '3pl': plForm + ' sunt',
    };
  }
  // Imperfect subjunctive is the one Latin tense whose formation never
  // varies by conjugation: present active infinitive + personal endings,
  // for every verb (amarem, viderem, regerem, caperem, audirem...).
  if (tense === 'impf-subj') {
    return {
      '1sg': presInf + 'm', '2sg': presInf + 's', '3sg': presInf + 't',
      '1pl': presInf + 'mus', '2pl': presInf + 'tis', '3pl': presInf + 'nt',
    };
  }
  if (tense === 'impf-pass-subj') {
    return {
      '1sg': presInf + 'r', '2sg': presInf + 'ris', '3sg': presInf + 'tur',
      '1pl': presInf + 'mur', '2pl': presInf + 'mini', '3pl': presInf + 'ntur',
    };
  }
  // Perfect/pluperfect subjunctive likewise build off the perfect stem
  // alone, independent of conjugation.
  if (tense === 'perf-subj') {
    if (!perf1sg || !perf1sg.endsWith('i')) return null;
    const pstem = perf1sg.slice(0, -1);
    return {
      '1sg': pstem + 'erim', '2sg': pstem + 'eris', '3sg': pstem + 'erit',
      '1pl': pstem + 'erimus', '2pl': pstem + 'eritis', '3pl': pstem + 'erint',
    };
  }
  if (tense === 'perf-pass-subj') {
    if (!perfPassPart || !perfPassPart.endsWith('us')) return null;
    const sgForm = perfPassPart;
    const plForm = perfPassPart.slice(0, -2) + 'i';
    return {
      '1sg': sgForm + ' sim', '2sg': sgForm + ' sis', '3sg': sgForm + ' sit',
      '1pl': plForm + ' simus', '2pl': plForm + ' sitis', '3pl': plForm + ' sint',
    };
  }
  if (tense === 'plup-subj') {
    if (!perf1sg || !perf1sg.endsWith('i')) return null;
    const pstem = perf1sg.slice(0, -1);
    return {
      '1sg': pstem + 'issem', '2sg': pstem + 'isses', '3sg': pstem + 'isset',
      '1pl': pstem + 'issemus', '2pl': pstem + 'issetis', '3pl': pstem + 'issent',
    };
  }
  if (tense === 'plup-pass-subj') {
    if (!perfPassPart || !perfPassPart.endsWith('us')) return null;
    const sgForm = perfPassPart;
    const plForm = perfPassPart.slice(0, -2) + 'i';
    return {
      '1sg': sgForm + ' essem', '2sg': sgForm + ' esses', '3sg': sgForm + ' esset',
      '1pl': plForm + ' essemus', '2pl': plForm + ' essetis', '3pl': plForm + ' essent',
    };
  }

  if (conj === '1' || conj === '2') {
    const stem = presInf.slice(0, -2);
    if (tense === 'pres') {
      return {
        '1sg': pres1sg, '2sg': stem + 's', '3sg': stem + 't',
        '1pl': stem + 'mus', '2pl': stem + 'tis', '3pl': stem + 'nt',
      };
    }
    if (tense === 'pres-pass') {
      return {
        '1sg': pres1sg + 'r', '2sg': stem + 'ris', '3sg': stem + 'tur',
        '1pl': stem + 'mur', '2pl': stem + 'mini', '3pl': stem + 'ntur',
      };
    }
    if (tense === 'pres-imp') {
      // Active 2sg is just the bare stem; 2pl adds -te. Passive/deponent
      // imperative singular is identical in spelling to the present
      // active infinitive itself (amare, videre...); plural adds -mini.
      return { '2sg': stem, '2pl': stem + 'te' };
    }
    if (tense === 'pres-pass-imp') {
      return { '2sg': presInf, '2pl': stem + 'mini' };
    }
    if (tense === 'pres-subj') {
      // 1st conjugation swaps its thematic -a- for -e- in the subjunctive
      // (amem, not amaam); every other conjugation just adds -a- onto the
      // stem already used for the indicative above.
      if (conj === '1') {
        const root = presInf.slice(0, -3);
        return {
          '1sg': root + 'em', '2sg': root + 'es', '3sg': root + 'et',
          '1pl': root + 'emus', '2pl': root + 'etis', '3pl': root + 'ent',
        };
      }
      return {
        '1sg': stem + 'am', '2sg': stem + 'as', '3sg': stem + 'at',
        '1pl': stem + 'amus', '2pl': stem + 'atis', '3pl': stem + 'ant',
      };
    }
    if (tense === 'pres-pass-subj') {
      if (conj === '1') {
        const root = presInf.slice(0, -3);
        return {
          '1sg': root + 'er', '2sg': root + 'eris', '3sg': root + 'etur',
          '1pl': root + 'emur', '2pl': root + 'emini', '3pl': root + 'entur',
        };
      }
      return {
        '1sg': stem + 'ar', '2sg': stem + 'aris', '3sg': stem + 'atur',
        '1pl': stem + 'amur', '2pl': stem + 'amini', '3pl': stem + 'antur',
      };
    }
    if (tense === 'impf') {
      return {
        '1sg': stem + 'bam', '2sg': stem + 'bas', '3sg': stem + 'bat',
        '1pl': stem + 'bamus', '2pl': stem + 'batis', '3pl': stem + 'bant',
      };
    }
    if (tense === 'impf-pass') {
      return {
        '1sg': stem + 'bar', '2sg': stem + 'baris', '3sg': stem + 'batur',
        '1pl': stem + 'bamur', '2pl': stem + 'bamini', '3pl': stem + 'bantur',
      };
    }
    if (tense === 'fut') {
      return {
        '1sg': stem + 'bo', '2sg': stem + 'bis', '3sg': stem + 'bit',
        '1pl': stem + 'bimus', '2pl': stem + 'bitis', '3pl': stem + 'bunt',
      };
    }
    if (tense === 'fut-pass') {
      return {
        '1sg': stem + 'bor', '2sg': stem + 'beris', '3sg': stem + 'bitur',
        '1pl': stem + 'bimur', '2pl': stem + 'bimini', '3pl': stem + 'buntur',
      };
    }
    return null;
  }

  if (conj === '4') {
    if (!presInf.endsWith('ire')) return null;
    const stem = presInf.slice(0, -2);
    if (tense === 'pres') {
      return {
        '1sg': pres1sg, '2sg': stem + 's', '3sg': stem + 't',
        '1pl': stem + 'mus', '2pl': stem + 'tis', '3pl': stem + 'unt',
      };
    }
    if (tense === 'pres-pass') {
      return {
        '1sg': pres1sg + 'r', '2sg': stem + 'ris', '3sg': stem + 'tur',
        '1pl': stem + 'mur', '2pl': stem + 'mini', '3pl': stem + 'untur',
      };
    }
    if (tense === 'pres-imp') {
      return { '2sg': stem, '2pl': stem + 'te' };
    }
    if (tense === 'pres-pass-imp') {
      return { '2sg': presInf, '2pl': stem + 'mini' };
    }
    if (tense === 'pres-subj') {
      return {
        '1sg': stem + 'am', '2sg': stem + 'as', '3sg': stem + 'at',
        '1pl': stem + 'amus', '2pl': stem + 'atis', '3pl': stem + 'ant',
      };
    }
    if (tense === 'pres-pass-subj') {
      return {
        '1sg': stem + 'ar', '2sg': stem + 'aris', '3sg': stem + 'atur',
        '1pl': stem + 'amur', '2pl': stem + 'amini', '3pl': stem + 'antur',
      };
    }
    if (tense === 'impf') {
      return {
        '1sg': stem + 'ebam', '2sg': stem + 'ebas', '3sg': stem + 'ebat',
        '1pl': stem + 'ebamus', '2pl': stem + 'ebatis', '3pl': stem + 'ebant',
      };
    }
    if (tense === 'impf-pass') {
      return {
        '1sg': stem + 'ebar', '2sg': stem + 'ebaris', '3sg': stem + 'ebatur',
        '1pl': stem + 'ebamur', '2pl': stem + 'ebamini', '3pl': stem + 'ebantur',
      };
    }
    if (tense === 'fut') {
      return {
        '1sg': stem + 'am', '2sg': stem + 'es', '3sg': stem + 'et',
        '1pl': stem + 'emus', '2pl': stem + 'etis', '3pl': stem + 'ent',
      };
    }
    if (tense === 'fut-pass') {
      return {
        '1sg': stem + 'ar', '2sg': stem + 'eris', '3sg': stem + 'etur',
        '1pl': stem + 'emur', '2pl': stem + 'emini', '3pl': stem + 'entur',
      };
    }
    return null;
  }

  if (!presInf.endsWith('ere')) return null;
  const stem = presInf.slice(0, -3);
  if (tense === 'pres') {
    if (conj === '3') {
      return {
        '1sg': pres1sg, '2sg': stem + 'is', '3sg': stem + 'it',
        '1pl': stem + 'imus', '2pl': stem + 'itis', '3pl': stem + 'unt',
      };
    }
    return {
      '1sg': pres1sg, '2sg': stem + 'is', '3sg': stem + 'it',
      '1pl': stem + 'imus', '2pl': stem + 'itis', '3pl': stem + 'iunt',
    };
  }
  if (tense === 'pres-pass') {
    if (conj === '3') {
      return {
        '1sg': pres1sg + 'r', '2sg': stem + 'eris', '3sg': stem + 'itur',
        '1pl': stem + 'imur', '2pl': stem + 'imini', '3pl': stem + 'untur',
      };
    }
    return {
      '1sg': pres1sg + 'r', '2sg': stem + 'eris', '3sg': stem + 'itur',
      '1pl': stem + 'imur', '2pl': stem + 'imini', '3pl': stem + 'iuntur',
    };
  }
  if (tense === 'pres-imp') {
    // Same formula for conj. 3 and 3-io alike (capite, not "capiite") --
    // unlike the present indicative/subjunctive above, the -i- comes
    // from the -ite ending itself, not a separate conjugation-specific
    // insertion.
    return { '2sg': stem + 'e', '2pl': stem + 'ite' };
  }
  if (tense === 'pres-pass-imp') {
    return { '2sg': presInf, '2pl': stem + 'imini' };
  }
  if (tense === 'pres-subj') {
    const base = conj === '3-io' ? stem + 'i' : stem;
    return {
      '1sg': base + 'am', '2sg': base + 'as', '3sg': base + 'at',
      '1pl': base + 'amus', '2pl': base + 'atis', '3pl': base + 'ant',
    };
  }
  if (tense === 'pres-pass-subj') {
    const base = conj === '3-io' ? stem + 'i' : stem;
    return {
      '1sg': base + 'ar', '2sg': base + 'aris', '3sg': base + 'atur',
      '1pl': base + 'amur', '2pl': base + 'amini', '3pl': base + 'antur',
    };
  }
  if (tense === 'impf') {
    const base = conj === '3-io' ? stem + 'ie' : stem + 'e';
    return {
      '1sg': base + 'bam', '2sg': base + 'bas', '3sg': base + 'bat',
      '1pl': base + 'bamus', '2pl': base + 'batis', '3pl': base + 'bant',
    };
  }
  if (tense === 'impf-pass') {
    const base = conj === '3-io' ? stem + 'ie' : stem + 'e';
    return {
      '1sg': base + 'bar', '2sg': base + 'baris', '3sg': base + 'batur',
      '1pl': base + 'bamur', '2pl': base + 'bamini', '3pl': base + 'bantur',
    };
  }
  if (tense === 'fut') {
    const base = conj === '3-io' ? stem + 'i' : stem;
    return {
      '1sg': base + 'am', '2sg': base + 'es', '3sg': base + 'et',
      '1pl': base + 'emus', '2pl': base + 'etis', '3pl': base + 'ent',
    };
  }
  if (tense === 'fut-pass') {
    const base = conj === '3-io' ? stem + 'i' : stem;
    return {
      '1sg': base + 'ar', '2sg': base + 'eris', '3sg': base + 'etur',
      '1pl': base + 'emur', '2pl': base + 'emini', '3pl': base + 'entur',
    };
  }
  return null;
}

function greekVerbParadigm(word, tense) {
  if (word.conjugation === 'irr') return null;
  const [pres1sg, fut1sg, aor1sg] = word.principalParts;
  // Principal parts follow the traditional Greek 6-part scheme when fully
  // given: pres, fut, aor, perf-act, perf-mid/pass, aor-pass. The aorist
  // passive -- when the dataset includes it at all -- is always the LAST
  // part, whether the entry has 4 parts (no aor-pass), 5 (pres/fut/aor/
  // perf-act/aor-pass, as with λύω here), or the full 6. Treating the 4th
  // part as "aorist passive" unconditionally (as earlier code did) grabs
  // the perfect active instead for any verb with a perfect on record, so
  // aor-pass/fut-pass silently failed for most of the dataset.
  const aorPass1sg = word.principalParts.length >= 5 ? word.principalParts[word.principalParts.length - 1] : undefined;
  if (!pres1sg || !pres1sg.endsWith('\u03c9')) return null;
  const stem = pres1sg.slice(0, -1);

  if (tense === 'pres') {
    return {
      '1sg': pres1sg, '2sg': stem + '\u03b5\u03b9\u03c2', '3sg': stem + '\u03b5\u03b9',
      '1pl': stem + '\u03bf\u03bc\u03b5\u03bd', '2pl': stem + '\u03b5\u03c4\u03b5', '3pl': stem + '\u03bf\u03c5\u03c3\u03b9\u03bd',
    };
  }
  if (tense === 'pres-mp') {
    return {
      '1sg': stem + '\u03bf\u03bc\u03b1\u03b9', '2sg': stem + '\u1fc3', '3sg': stem + '\u03b5\u03c4\u03b1\u03b9',
      '1pl': stem + '\u03bf\u03bc\u03b5\u03b8\u03b1', '2pl': stem + '\u03b5\u03c3\u03b8\u03b5', '3pl': stem + '\u03bf\u03bd\u03c4\u03b1\u03b9',
    };
  }
  if (tense === 'pres-subj') {
    return {
      '1sg': stem + '\u03c9', '2sg': stem + '\u1fc3\u03c2', '3sg': stem + '\u1fc3',
      '1pl': stem + '\u03c9\u03bc\u03b5\u03bd', '2pl': stem + '\u03b7\u03c4\u03b5', '3pl': stem + '\u03c9\u03c3\u03b9\u03bd',
    };
  }
  if (tense === 'pres-mp-subj') {
    return {
      '1sg': stem + '\u03c9\u03bc\u03b1\u03b9', '2sg': stem + '\u1fc3', '3sg': stem + '\u03b7\u03c4\u03b1\u03b9',
      '1pl': stem + '\u03c9\u03bc\u03b5\u03b8\u03b1', '2pl': stem + '\u03b7\u03c3\u03b8\u03b5', '3pl': stem + '\u03c9\u03bd\u03c4\u03b1\u03b9',
    };
  }
  if (tense === 'pres-opt') {
    return greekActiveOptative(stem, '\u03bf\u03b9');
  }
  if (tense === 'pres-mp-opt') {
    return greekMiddleOptative(stem, '\u03bf\u03b9');
  }
  if (tense === 'impf') {
    if (/^[\u03b1\u03b5\u03b7\u03b9\u03bf\u03c5\u03c9\u1f00-\u1fff]/.test(stem)) return null;
    const aug = '\u1f14';
    const bareStem = normalize(stem);
    return {
      '1sg': aug + bareStem + '\u03bf\u03bd', '2sg': aug + bareStem + '\u03b5\u03c2', '3sg': aug + bareStem + '\u03b5\u03bd',
      '1pl': aug + bareStem + '\u03bf\u03bc\u03b5\u03bd', '2pl': aug + bareStem + '\u03b5\u03c4\u03b5', '3pl': aug + bareStem + '\u03bf\u03bd',
    };
  }
  if (tense === 'impf-mp') {
    if (/^[\u03b1\u03b5\u03b7\u03b9\u03bf\u03c5\u03c9\u1f00-\u1fff]/.test(stem)) return null;
    const aug = '\u1f14';
    const bareStem = normalize(stem);
    return {
      '1sg': aug + bareStem + '\u03bf\u03bc\u03b7\u03bd', '2sg': aug + bareStem + '\u03bf\u03c5', '3sg': aug + bareStem + '\u03b5\u03c4\u03bf',
      '1pl': aug + bareStem + '\u03bf\u03bc\u03b5\u03b8\u03b1', '2pl': aug + bareStem + '\u03b5\u03c3\u03b8\u03b5', '3pl': aug + bareStem + '\u03bf\u03bd\u03c4\u03bf',
    };
  }
  if (tense === 'fut') {
    if (!fut1sg || !fut1sg.endsWith('\u03c9')) return null;
    const fstem = fut1sg.slice(0, -1);
    return {
      '1sg': fut1sg, '2sg': fstem + '\u03b5\u03b9\u03c2', '3sg': fstem + '\u03b5\u03b9',
      '1pl': fstem + '\u03bf\u03bc\u03b5\u03bd', '2pl': fstem + '\u03b5\u03c4\u03b5', '3pl': fstem + '\u03bf\u03c5\u03c3\u03b9\u03bd',
    };
  }
  if (tense === 'aor') {
    const m = aor1sg && aor1sg.match(/^(\u1f10|\u1f14)(.*)\u03b1$/);
    if (!m) return null;
    const aug = '\u1f14';
    const astem = m[2];
    return {
      '1sg': aor1sg, '2sg': aug + astem + '\u03b1\u03c2', '3sg': aug + astem + '\u03b5\u03bd',
      '1pl': aug + astem + '\u03b1\u03bc\u03b5\u03bd', '2pl': aug + astem + '\u03b1\u03c4\u03b5', '3pl': aug + astem + '\u03b1\u03bd',
    };
  }
  if (tense === 'aor-subj') {
    // Subjunctive never carries the augment, unlike the indicative above --
    // λύσω, not ἐλύσω -- and uses the same endings as the present
    // subjunctive, just on the sigmatic aorist stem. Since the augment
    // was what carried the accent in the indicative spelling, dropping it
    // needs the accent restored onto the stem's own last vowel instead.
    const m = aor1sg && aor1sg.match(/^(\u1f10|\u1f14)(.*)\u03b1$/);
    if (!m) return null;
    const astem = addAcuteToLastVowel(m[2]);
    return {
      '1sg': astem + '\u03c9', '2sg': astem + '\u1fc3\u03c2', '3sg': astem + '\u1fc3',
      '1pl': astem + '\u03c9\u03bc\u03b5\u03bd', '2pl': astem + '\u03b7\u03c4\u03b5', '3pl': astem + '\u03c9\u03c3\u03b9\u03bd',
    };
  }
  if (tense === 'aor-opt' || tense === 'aor-mid-opt') {
    // Like the subjunctive, the optative never carries the augment, and
    // the same accent-restoration is needed for the same reason. Uses
    // the "regular" -αι- endings (λύσαιμι/λύσαις/λύσαι...) rather than
    // the -ειας/-ειε(ν) alternates classical grammars note as more
    // common in practice -- both are attested, but the -αι- set follows
    // one predictable formula shared with the present, so it's what's
    // modeled here.
    const m = aor1sg && aor1sg.match(/^(\u1f10|\u1f14)(.*)\u03b1$/);
    if (!m) return null;
    const astem = addAcuteToLastVowel(m[2]);
    return tense === 'aor-opt' ? greekActiveOptative(astem, '\u03b1\u03b9') : greekMiddleOptative(astem, '\u03b1\u03b9');
  }
  if (tense === 'aor-pass' || tense === 'fut-pass') {
    const m = aorPass1sg && aorPass1sg.match(/^(\u1f10|\u1f14)(.*\u03b8)\u03b7\u03bd$/);
    if (!m) return null;
    const thStem = m[2];
    if (tense === 'aor-pass') {
      const aug = m[1];
      return {
        '1sg': aorPass1sg, '2sg': aug + thStem + '\u03b7\u03c2', '3sg': aug + thStem + '\u03b7',
        '1pl': aug + thStem + '\u03b7\u03bc\u03b5\u03bd', '2pl': aug + thStem + '\u03b7\u03c4\u03b5', '3pl': aug + thStem + '\u03b7\u03c3\u03b1\u03bd',
      };
    }
    return {
      '1sg': thStem + '\u03b7\u03c3\u03bf\u03bc\u03b1\u03b9', '2sg': thStem + '\u03b7\u03c3\u1fc3', '3sg': thStem + '\u03b7\u03c3\u03b5\u03c4\u03b1\u03b9',
      '1pl': thStem + '\u03b7\u03c3\u03bf\u03bc\u03b5\u03b8\u03b1', '2pl': thStem + '\u03b7\u03c3\u03b5\u03c3\u03b8\u03b5', '3pl': thStem + '\u03b7\u03c3\u03bf\u03bd\u03c4\u03b1\u03b9',
    };
  }
  if (tense === 'aor-pass-subj') {
    // The θη-stem's own η genuinely contracts with the subjunctive
    // endings here (unlike the sigmatic aorist above, which just
    // concatenates), which is what produces the circumflex spellings:
    // λυθῶ, λυθῇς, λυθῇ, λυθῶμεν, λυθῆτε, λυθῶσι(ν). m[2] carries
    // whatever accent the indicative spelling had (e.g. λύθ- from
    // ἐλύθην); that needs clearing first or it doubles up with the new
    // circumflex ending instead of being replaced by it.
    const m = aorPass1sg && aorPass1sg.match(/^(\u1f10|\u1f14)(.*\u03b8)\u03b7\u03bd$/);
    if (!m) return null;
    const thStem = stripAllAccents(m[2]);
    return {
      '1sg': thStem + '\u1ff6', '2sg': thStem + '\u1fc7\u03c2', '3sg': thStem + '\u1fc7',
      '1pl': thStem + '\u1ff6\u03bc\u03b5\u03bd', '2pl': thStem + '\u1fc6\u03c4\u03b5', '3pl': thStem + '\u1ff6\u03c3\u03b9\u03bd',
    };
  }
  // Imperative has no 1st person -- you can't command yourself -- so
  // these only ever return 2sg/3sg/2pl/3pl. Each of the five (2 present,
  // 2 aorist, 1 aorist passive) is built from its own irregular 2nd-
  // singular ending (the one genuinely idiosyncratic form in each set,
  // confirmed against attested paradigms rather than derived), plus a
  // shared shift pattern for the rest: 3sg/3pl carry long endings
  // (-τω/-ντων/-θω/-σθων) that force the accent one syllable forward off
  // the stem, same mechanism used throughout this file already; 2pl's
  // ending is short, so it keeps the accent on the stem.
  if (tense === 'pres-imp') {
    return {
      '2sg': addCircumflexToLastVowel(stem) + '\u03b5',
      '3sg': stripAllAccents(stem) + accentLinkVowel('\u03b5') + '\u03c4\u03c9',
      '2pl': addAcuteToLastVowel(stem) + '\u03b5\u03c4\u03b5',
      '3pl': stripAllAccents(stem) + accentLinkVowel('\u03bf') + '\u03bd\u03c4\u03c9\u03bd',
    };
  }
  if (tense === 'pres-mp-imp') {
    return {
      '2sg': addAcuteToLastVowel(stem) + '\u03bf\u03c5',
      '3sg': stripAllAccents(stem) + accentLinkVowel('\u03b5') + '\u03c3\u03b8\u03c9',
      '2pl': addAcuteToLastVowel(stem) + '\u03b5\u03c3\u03b8\u03b5',
      '3pl': stripAllAccents(stem) + accentLinkVowel('\u03b5') + '\u03c3\u03b8\u03c9\u03bd',
    };
  }
  if (tense === 'aor-imp' || tense === 'aor-mid-imp') {
    const m = aor1sg && aor1sg.match(/^(\u1f10|\u1f14)(.*)\u03b1$/);
    if (!m) return null;
    const astem = m[2];
    if (tense === 'aor-imp') {
      // λῦσον is itself an irregular form (not the "expected" λύσε),
      // confirmed against attested paradigms rather than derived.
      return {
        '2sg': addCircumflexToLastVowel(astem) + '\u03bf\u03bd',
        '3sg': stripAllAccents(astem) + accentLinkVowel('\u03b1') + '\u03c4\u03c9',
        '2pl': addAcuteToLastVowel(astem) + '\u03b1\u03c4\u03b5',
        '3pl': stripAllAccents(astem) + accentLinkVowel('\u03b1') + '\u03bd\u03c4\u03c9\u03bd',
      };
    }
    return {
      '2sg': addAcuteToLastVowel(astem) + '\u03b1\u03b9',
      '3sg': stripAllAccents(astem) + accentLinkVowel('\u03b1') + '\u03c3\u03b8\u03c9',
      '2pl': addAcuteToLastVowel(astem) + '\u03b1\u03c3\u03b8\u03b5',
      '3pl': stripAllAccents(astem) + accentLinkVowel('\u03b1') + '\u03c3\u03b8\u03c9\u03bd',
    };
  }
  if (tense === 'aor-pass-imp') {
    const m = aorPass1sg && aorPass1sg.match(/^(\u1f10|\u1f14)(.*\u03b8)\u03b7\u03bd$/);
    if (!m) return null;
    const thStem = m[2];
    return {
      '2sg': addAcuteToLastVowel(thStem) + '\u03b7\u03c4\u03b9',
      '3sg': stripAllAccents(thStem) + accentLinkVowel('\u03b7') + '\u03c4\u03c9',
      '2pl': addAcuteToLastVowel(thStem) + '\u03b7\u03c4\u03b5',
      // 3pl echoes the aorist passive participle's own -εντ- stem rather
      // than the singular/2pl's η -- confirmed against attested λυθέντων,
      // not derived from the η-based pattern above.
      '3pl': stripAllAccents(thStem) + '\u03ad\u03bd\u03c4\u03c9\u03bd',
    };
  }
  return null;
}

const PARTICIPLE_TENSES = new Set(['pres-act-part', 'perf-pass-part', 'fut-act-part', 'gerundive', 'pres-mp-part', 'aor-mid-part', 'aor-act-part', 'aor-pass-part', 'perf-act-part', 'perf-mp-part']);
function isParticipleTense(tense) {
  return PARTICIPLE_TENSES.has(tense);
}

function getParadigm(word, tense, gender) {
  if (word.pos === 'noun') {
    return state.lang === 'latin' ? latinNounParadigm(word) : greekNounParadigm(word);
  }
  if (word.pos === 'adjective') {
    return state.lang === 'latin' ? latinAdjParadigm(word, gender) : greekAdjParadigm(word, gender);
  }
  if (word.pos === 'pronoun') {
    return pronounParadigm(word, gender);
  }
  if (word.pos === 'verb') {
    if (isParticipleTense(tense)) {
      return state.lang === 'latin' ? latinParticipleParadigm(word, tense, gender) : greekParticipleParadigm(word, tense, gender);
    }
    if (word.conjugation === 'irr') return irregularVerbParadigm(word, tense);
    return state.lang === 'latin' ? latinVerbParadigm(word, tense) : greekVerbParadigm(word, tense);
  }
  return null;
}

const GENDER_LABELS = { m: 'Masculine', f: 'Feminine', n: 'Neuter' };

function genderSelectorHtml() {
  const options = ['m', 'f', 'n'].map(g =>
    `<option value="${g}" ${g === state.paradigm.gender ? 'selected' : ''}>${GENDER_LABELS[g]}</option>`
  ).join('');
  return `
    <div class="paradigm-tense-picker">
      <label for="paradigm-gender">Gender:</label>
      <select id="paradigm-gender">${options}</select>
    </div>
  `;
}

function wireGenderSelector() {
  const sel = document.getElementById('paradigm-gender');
  if (!sel) return;
  sel.addEventListener('change', (e) => {
    state.paradigm.gender = e.target.value;
    renderParadigmTable();
  });
}

function renderParadigm() {
  panel.innerHTML = `
    <div class="paradigm-picker">
      <label for="paradigm-pos-filter">Show:</label>
      <select id="paradigm-pos-filter">
        <option value="all" ${state.paradigm.posFilter === 'all' ? 'selected' : ''}>All</option>
        <option value="noun" ${state.paradigm.posFilter === 'noun' ? 'selected' : ''}>Nouns</option>
        <option value="adjective" ${state.paradigm.posFilter === 'adjective' ? 'selected' : ''}>Adjectives</option>
        <option value="pronoun" ${state.paradigm.posFilter === 'pronoun' ? 'selected' : ''}>Pronouns</option>
        <option value="verb" ${state.paradigm.posFilter === 'verb' ? 'selected' : ''}>Verbs</option>
      </select>
      <label for="paradigm-search" class="visually-hidden">Search words</label>
      <input type="text" id="paradigm-search" class="paradigm-search" placeholder="Search words&hellip;" value="${escapeHtml(state.paradigm.search)}" autocomplete="off">
      <label for="paradigm-select" class="visually-hidden">Word</label>
      <select id="paradigm-select"></select>
      <button type="button" class="action" id="paradigm-reveal">Reveal all</button>
    </div>
    <p class="paradigm-note" id="paradigm-search-note"></p>
    <div id="paradigm-table-wrap"></div>
    <p class="paradigm-note">Regular endings only: 1st&ndash;5th Latin declension (incl. 4th-declension neuters), 1st&ndash;3rd Greek declension (3rd: consonant-stem masc./fem. and -\u03bc\u03b1-type neuters only), 1st/2nd- and 3rd-declension (i-stem) Latin adjectives, 2-1-2 and 3rd-declension (\u03c3-stem) Greek adjectives, verbs present/imperfect/future/perfect active and passive (Latin, perfect passive shown as participle + sum) or present/imperfect active and mediopassive plus future/aorist active and passive (regular Greek &mdash; passive future/aorist only for weak/\u03b8\u03b7-type verbs like \u1f10\u03bb\u03cd\u03b8\u03b7\u03bd, and only when the data lists the 4th principal part). Pronouns and irregular verbs use hand-authored paradigms instead of a generator, so only the forms listed in the data are checkable &mdash; try Reveal all to see what's covered. Macrons/accents are optional when typing &mdash; answers are checked leniently. Greek imperfect/mediopassive/passive-aorist accent placement is simplified (kept on the augment/stem).</p>
  `;

  populateParadigmSelect();
  renderParadigmTable();

  document.getElementById('paradigm-pos-filter').addEventListener('change', (e) => {
    state.paradigm.posFilter = e.target.value;
    populateParadigmSelect();
    renderParadigmTable();
  });
  document.getElementById('paradigm-search').addEventListener('input', (e) => {
    state.paradigm.search = e.target.value;
    populateParadigmSelect();
    renderParadigmTable();
  });
  document.getElementById('paradigm-select').addEventListener('change', (e) => {
    state.paradigm.wordId = e.target.value;
    state.paradigm.search = ''; // Clear search state when a word is chosen directly
    state.paradigm.tense = 'pres';
    state.paradigm.gender = 'm';
    
    // Reset search input UI if present
    const searchInput = document.getElementById('paradigm-search');
    if (searchInput) searchInput.value = '';

    populateParadigmSelect();
    renderParadigmTable();
  });
  document.getElementById('paradigm-reveal').addEventListener('click', () => revealParadigm());
}

const POS_LABELS = { noun: 'nouns', adjective: 'adjectives', pronoun: 'pronouns', verb: 'verbs' };

function getFilteredParadigmWords() {
  const words = currentLangData().words;
  const posFilter = state.paradigm.posFilter;
  const byPos = posFilter === 'all' ? words : words.filter(w => w.pos === posFilter);

  const search = state.paradigm.search.trim().toLowerCase();
  const filtered = search
    ? byPos.filter(w => w.headword.toLowerCase().includes(search) || w.meaning.toLowerCase().includes(search))
    : byPos;

  return {
    list: filtered.length ? filtered : (byPos.length ? byPos : words),
    noMatches: filtered.length === 0,
    byPos,
  };
}

function populateParadigmSelect() {
  const select = document.getElementById('paradigm-select');
  const note = document.getElementById('paradigm-search-note');
  if (!select) return;

  const posFilter = state.paradigm.posFilter;
  const search = state.paradigm.search.trim();

  const { list, noMatches } = getFilteredParadigmWords();

  if (!list.find(w => w.id === state.paradigm.wordId)) {
    state.paradigm.wordId = list[0].id;
    state.paradigm.tense = 'pres';
  }

  // --- Fixed: Stripped masteryDotsText from the option text ---
  select.innerHTML = list.map(w =>
    `<option value="${w.id}" ${w.id === state.paradigm.wordId ? 'selected' : ''}>${w.headword} (${w.meaning})</option>`
  ).join('');

  if (note) {
    if (noMatches && search) {
      note.textContent = `No ${POS_LABELS[posFilter] || 'words'} match \u201c${search}\u201d \u2014 showing all${posFilter !== 'all' ? ' ' + POS_LABELS[posFilter] : ''} instead.`;
    } else if (noMatches) {
      note.textContent = `No ${POS_LABELS[posFilter] || 'words'} in ${state.lang === 'greek' ? 'Greek' : 'Latin'} \u2014 showing all words.`;
    } else {
      note.textContent = search 
        ? (list.length === 1 ? '1 word matches.' : `${list.length} words match.`) 
        : '';
    }
  }
}

function goToNextParadigmWord() {
  const { list } = getFilteredParadigmWords();
  const currentIndex = list.findIndex(w => w.id === state.paradigm.wordId);

  if (currentIndex !== -1 && currentIndex < list.length - 1) {
    state.paradigm.wordId = list[currentIndex + 1].id;
  } else if (list.length > 0) {
    state.paradigm.wordId = list[0].id;
  }

  state.paradigm.tense = 'pres';
  state.paradigm.gender = 'm';

  populateParadigmSelect();
  renderParadigmTable();
}

function tenseListFor() {
  return state.lang === 'latin' ? LATIN_VERB_TENSES : GREEK_VERB_TENSES;
}

function tenseLabelFor(tense) {
  const entry = tenseListFor().find(([key]) => key === tense);
  return entry ? entry[1] : '';
}

function availableTensesFor(word) {
  const all = tenseListFor();
  const covered = all.filter(([tense]) => getParadigm(word, tense, state.paradigm.gender) !== null);
  return covered.length ? covered : all;
}

function tenseSelectorHtml(word) {
  const options = availableTensesFor(word).map(([key, label]) =>
    `<option value="${key}" ${key === state.paradigm.tense ? 'selected' : ''}>${label}</option>`
  ).join('');
  return `
    <div class="paradigm-tense-picker">
      <label for="paradigm-tense">Tense:</label>
      <select id="paradigm-tense">${options}</select>
    </div>
  `;
}

function wireTenseSelector() {
  const sel = document.getElementById('paradigm-tense');
  if (!sel) return;
  sel.addEventListener('change', (e) => {
    state.paradigm.tense = e.target.value;
    renderParadigmTable();
  });
}

/* ==========================================================================
   PARADIGM PRACTICE & VALIDATION MODULE
   ========================================================================== */

function renderParadigmTable() {
  const word = currentLangData().words.find(w => w.id === state.paradigm.wordId);
  const wrap = document.getElementById('paradigm-table-wrap');
  if (!word || !wrap) return;

  const isVerb = word.pos === 'verb';

  if (isVerb && !availableTensesFor(word).find(([key]) => key === state.paradigm.tense)) {
    state.paradigm.tense = availableTensesFor(word)[0][0];
  }

  // A participle is a verb form that declines like an adjective (case x
  // number x gender) rather than conjugating (person x number) -- so
  // which of the two table layouts below applies depends on the SELECTED
  // TENSE, not just word.pos, whenever the word is a verb.
  const participle = isVerb && isParticipleTense(state.paradigm.tense);
  const caseBased = isCaseBasedPos(word.pos) || participle;
  const isGendered = word.pos === 'adjective' || word.pos === 'pronoun' || participle;

  if (isGendered && !['m', 'f', 'n'].includes(state.paradigm.gender)) {
    state.paradigm.gender = 'm';
  }
  const paradigm = getParadigm(word, state.paradigm.tense, state.paradigm.gender);

  if (!paradigm) {
    const tenseNote = isVerb ? ` in the ${tenseLabelFor(state.paradigm.tense)}` : '';
    const genderNote = isGendered ? ` (${GENDER_LABELS[state.paradigm.gender]})` : '';
    const tryNote = [isVerb && 'tense', isGendered && 'gender'].filter(Boolean).join(' or ');
    wrap.innerHTML = `
      ${isVerb ? tenseSelectorHtml(word) : ''}
      ${isGendered ? genderSelectorHtml() : ''}
      <p class="paradigm-note">No paradigm generator yet covers this word${tenseNote}${genderNote} (outside the MVP set, or the data doesn't list this combination). ${tryNote ? `Try another word or ${tryNote}.` : 'Try another word.'}</p>
    `;
    wireTenseSelector();
    wireGenderSelector();
    return;
  }

  if (caseBased) {
    const cases = state.lang === 'latin' ? LATIN_NOUN_CASES : GREEK_NOUN_CASES;
    const rows = cases.map(c => `
      <tr>
        <th scope="row">${CASE_LABELS[c]}</th>
        <td>
          <input type="text" class="paradigm-input" data-key="sg-${c}" aria-label="${CASE_LABELS[c]} singular" aria-describedby="status-sg-${c}">
          <span class="visually-hidden" id="status-sg-${c}" aria-live="polite"></span>
        </td>
        <td>
          <input type="text" class="paradigm-input" data-key="pl-${c}" aria-label="${CASE_LABELS[c]} plural" aria-describedby="status-pl-${c}">
          <span class="visually-hidden" id="status-pl-${c}" aria-live="polite"></span>
        </td>
      </tr>
    `).join('');
    const genderSuffix = isGendered ? ` (${GENDER_LABELS[state.paradigm.gender]})` : '';
    const tenseSuffix = participle ? ` (${tenseLabelFor(state.paradigm.tense)})` : '';
    wrap.innerHTML = `
      ${isVerb ? tenseSelectorHtml(word) : ''}
      ${isGendered ? genderSelectorHtml() : ''}
      <table class="paradigm-table">
        <caption lang="${langCode()}">${word.headword} &mdash; ${word.meaning}${genderSuffix}${tenseSuffix}</caption>
        <thead><tr><th></th><th>Singular</th><th>Plural</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    wrap.dataset.correctSg = JSON.stringify(paradigm.sg || {});
    wrap.dataset.correctPl = JSON.stringify(paradigm.pl || {});
    wrap.dataset.caseBased = 'true';
  } else if (isVerb) {
    const allPersons = [
      ['1sg', '1st sg.'], ['2sg', '2nd sg.'], ['3sg', '3rd sg.'],
      ['1pl', '1st pl.'], ['2pl', '2nd pl.'], ['3pl', '3rd pl.']
    ];
    // Imperative only has 2nd/3rd person (you can't command yourself),
    // so only render rows for persons the paradigm actually returned --
    // a person missing from the object is "not applicable", not merely
    // an unfilled cell to type into.
    const persons = allPersons.filter(([key]) => Object.prototype.hasOwnProperty.call(paradigm, key));
    const rows = persons.map(([key, label]) => `
      <tr>
        <th scope="row">${label}</th>
        <td>
          <input type="text" class="paradigm-input" data-key="${key}" aria-label="${label}" aria-describedby="status-${key}">
          <span class="visually-hidden" id="status-${key}" aria-live="polite"></span>
        </td>
      </tr>
    `).join('');
    wrap.innerHTML = `
      ${tenseSelectorHtml(word)}
      <table class="paradigm-table">
        <caption lang="${langCode()}">${word.headword} &mdash; ${word.meaning} (${tenseLabelFor(state.paradigm.tense)})</caption>
        <tbody>${rows}</tbody>
      </table>
    `;
    wrap.dataset.correctFlat = JSON.stringify(paradigm || {});
    wrap.dataset.caseBased = 'false';
  }

  // Clear advance lock state upon rendering fresh table
  delete wrap.dataset.advancing;

  wrap.querySelectorAll('.paradigm-input').forEach(input => {
    input.addEventListener('input', () => checkParadigmCell(input));
  });
  wireTenseSelector();
  wireGenderSelector();
}

function correctValueFor(wrap, key) {
  try {
    if (wrap.dataset.caseBased === 'true') {
      const [num, c] = key.split('-');
      const dataStr = num === 'sg' ? wrap.dataset.correctSg : wrap.dataset.correctPl;
      const table = JSON.parse(dataStr || '{}');
      return table[c] || '';
    }
    const flatTable = JSON.parse(wrap.dataset.correctFlat || '{}');
    return flatTable[key] || '';
  } catch (err) {
    console.error('Failed to parse paradigm dataset:', err);
    return '';
  }
}

function paradigmProgressKey(word) {
  if (word.pos === 'verb') return `tense:${state.paradigm.tense}`;
  if (word.pos === 'adjective' || word.pos === 'pronoun') return `gender:${state.paradigm.gender}`;
  return 'base';
}

function normalize(str) {
  if (!str) return '';
  return str
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Strip diacritics/macrons for lenient evaluation
    .toLowerCase();
}

function checkParadigmCell(input) {
  const wrap = document.getElementById('paradigm-table-wrap');
  if (!wrap) return;

  const rawCorrect = correctValueFor(wrap, input.dataset.key);
  const status = document.getElementById(input.getAttribute('aria-describedby'));

  if (!input.value.trim()) {
    input.classList.remove('correct', 'incorrect');
    input.removeAttribute('aria-invalid');
    if (status) status.textContent = '';
    return;
  }

  const userVal = normalize(input.value);
  const isCorrect = Array.isArray(rawCorrect)
    ? rawCorrect.some(alt => normalize(alt) === userVal)
    : userVal === normalize(rawCorrect);

  input.classList.toggle('correct', isCorrect);
  input.classList.toggle('incorrect', !isCorrect);
  input.setAttribute('aria-invalid', String(!isCorrect));

  if (status) {
    status.textContent = isCorrect ? 'Correct' : 'Not yet correct';
  }

  maybeMarkParadigmComplete(wrap);
}

function maybeMarkParadigmComplete(wrap) {
  if (wrap.dataset.advancing === 'true') return;

  const inputs = Array.from(wrap.querySelectorAll('.paradigm-input'));
  const allCorrect = inputs.length > 0 && inputs.every(i => i.classList.contains('correct'));
  if (!allCorrect) return;

  const word = currentLangData().words.find(w => w.id === state.paradigm.wordId);
  if (!word) return;

  wrap.dataset.advancing = 'true';

  const lang = progress[state.lang];
  if (!lang.paradigm[word.id]) lang.paradigm[word.id] = {};
  const key = paradigmProgressKey(word);

  if (!lang.paradigm[word.id][key]) {
    lang.paradigm[word.id][key] = true;
    if (typeof saveProgress === 'function') saveProgress();
  }

  // Release focus so soft keyboards on touch devices dismiss smoothly
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }

  // Delay transition for visual feedback confirmation
  setTimeout(() => {
    if (typeof goToNextParadigmWord === 'function') {
      goToNextParadigmWord();
    }
  }, 600);
}

function revealParadigm() {
  const word = currentLangData().words.find(w => w.id === state.paradigm.wordId);
  const wrap = document.getElementById('paradigm-table-wrap');
  if (!word || !wrap) return;

  document.querySelectorAll('.paradigm-input').forEach(input => {
    const val = correctValueFor(wrap, input.dataset.key);

    // Choose primary alternative if answer is an array
    input.value = Array.isArray(val) ? val[0] : val;
    input.classList.add('correct');
    input.classList.remove('incorrect');
    input.removeAttribute('aria-invalid');

    const status = document.getElementById(input.getAttribute('aria-describedby'));
    if (status) status.textContent = 'Revealed';
  });

  if (typeof announce === 'function') {
    announce('Full paradigm revealed.');
  }
}

  // ---------- Parsing mode ----------

  // Master registry of every taggable field a sentence parse can carry,
  // keyed to the exact abbreviations used in the sentences_*.csv `parses`
  // column (see csv_to_data.py's docstring). 'tense' differs by language
  // (Latin's fourth principal part is perfect; Greek's is aorist) — matches
  // the same split tenseListFor() already makes for Paradigms mode — so
  // it's a getter, evaluated fresh against the current state.lang.
  const PARSING_TAG_FIELDS = {
    case: ['nom', 'gen', 'dat', 'acc', 'abl', 'voc'],
    number: ['sg', 'pl'],
    gender: ['m', 'f', 'n'],
    degree: ['pos', 'comp', 'superl'],
    person: ['1', '2', '3'],
    get tense() {
      return state.lang === 'latin'
        ? ['pres', 'imperf', 'fut', 'perf', 'plup']
        : ['pres', 'imperf', 'fut', 'aor', 'perf'];
    },
    aspect: ['imperf', 'perf'],
    mood: ['ind', 'sub', 'inf', 'imp'],
    voice: ['act', 'pass', 'mid', 'dep'],
    type: ['prep', 'conj', 'adv'],
  };
  const PARSING_FIELD_ORDER = [
    'case', 'number', 'gender', 'degree', 'person', 'tense', 'aspect', 'mood', 'voice', 'type',
  ];

  // Builds the [field, options] rows to show and grade for one parse entry,
  // driven entirely by which keys that entry's own `tags` carries — not by
  // a fixed noun-vs-verb split. This means a participle tagged with both
  // case/number/gender AND tense/aspect gets every applicable row (instead
  // of one side being silently dropped), and an invariant word tagged only
  // `type` gets a real, gradable row (instead of no row at all, which used
  // to auto-mark it "correct" no matter what was picked, since there was
  // nothing left to check against).
  function fieldsForTags(tags) {
    return PARSING_FIELD_ORDER
      .filter(field => field in tags)
      .map(field => [field, PARSING_TAG_FIELDS[field]]);
  }

  function parsingResultsFor(sentenceId) {
    const lang = progress[state.lang];
    if (!lang.parsing[sentenceId]) lang.parsing[sentenceId] = {};
    return lang.parsing[sentenceId];
  }

  function renderParsing() {
    const sentences = currentLangData().sentences;
    if (state.parsing.sentenceIndex >= sentences.length) state.parsing.sentenceIndex = 0;
    const sentence = sentences[state.parsing.sentenceIndex];
    state.parsing.activeParseIdx = null;
    state.parsing.answers = {};
    state.parsing.checked = false;
    state.parsing.translationRevealed = false;
    renderParsingBody(sentence);
  }

  // Splits sentence.text into alternating letter-runs and everything-else
  // runs (spaces, punctuation), so the real capitalization and punctuation
  // of the sentence can be shown instead of the bare, lowercase, no-period
  // surface forms some rows store in `parses`.
  function tokenizeSentenceText(text) {
    return text.match(/[\p{L}\p{M}]+|[^\p{L}\p{M}]+/gu) || [];
  }

  function isWordToken(token) {
    return /^[\p{L}\p{M}]/u.test(token);
  }

  // Builds the clickable sentence display by zipping sentence.text's tokens
  // against sentence.parses in order. Falls back to the old space-joined
  // parses[].surface rendering if the word-token count doesn't line up with
  // parses.length, so a mismatched or hand-edited row never loses its click
  // targets — it just loses punctuation fidelity for that one sentence.
  function buildParsingWordsHtml(sentence, results) {
    const wordButton = (p, idx) => {
      const cls = ['parsing-word'];
      if (isKnownWord(p.wordId)) cls.push('known');
      if (results[idx] === 'correct') cls.push('done');
      else if (results[idx] === 'incorrect') cls.push('wrong-once');
      return `<button type="button" class="${cls.join(' ')}" data-idx="${idx}">${escapeHtml(p.surface)}</button>`;
    };

    const tokens = tokenizeSentenceText(sentence.text);
    const wordTokens = tokens.filter(isWordToken);
    if (wordTokens.length !== sentence.parses.length) {
      return sentence.parses.map((p, idx) => wordButton(p, idx)).join(' ');
    }

    let parseIdx = 0;
    return tokens.map(t => {
      if (!isWordToken(t)) return escapeHtml(t);
      const html = wordButton(sentence.parses[parseIdx], parseIdx);
      parseIdx += 1;
      return html;
    }).join('');
  }

  function renderParsingBody(sentence) {
    const results = parsingResultsFor(sentence.id);
    const wordsHtml = buildParsingWordsHtml(sentence, results);

    panel.innerHTML = `
      <div class="parsing-sentence incised" lang="${langCode()}">${wordsHtml}</div>
      <div class="parsing-translation-row">
        <button type="button" class="action" id="parsing-translation-toggle">${state.parsing.translationRevealed ? 'Hide' : 'Show'} translation</button>
        <div id="parsing-translation-wrap">${state.parsing.translationRevealed ? `<p class="parsing-translation">${escapeHtml(sentence.translation)}</p>` : ''}</div>
      </div>
      <p class="paradigm-note">Click a word to parse it. Words underlined in solid bronze are ones you know from Vocab.</p>
      <div id="parsing-quiz-wrap"></div>
      <div class="parsing-nav">
        <button type="button" class="action" id="parsing-prev">&larr; Previous sentence</button>
        <button type="button" class="action" id="parsing-next">Next sentence &rarr;</button>
      </div>
    `;

    document.getElementById('parsing-translation-toggle').addEventListener('click', () => {
      state.parsing.translationRevealed = !state.parsing.translationRevealed;
      document.getElementById('parsing-translation-toggle').textContent =
        (state.parsing.translationRevealed ? 'Hide' : 'Show') + ' translation';
      document.getElementById('parsing-translation-wrap').innerHTML = state.parsing.translationRevealed
        ? `<p class="parsing-translation">${escapeHtml(sentence.translation)}</p>` : '';
    });

    panel.querySelectorAll('.parsing-word').forEach(btn => {
      btn.addEventListener('click', () => {
        state.parsing.activeParseIdx = Number(btn.dataset.idx);
        renderParsingQuiz(sentence);
        focusAfterRender('tag-' + fieldsForTags(sentence.parses[state.parsing.activeParseIdx].tags)[0][0]);
      });
    });

    document.getElementById('parsing-prev').addEventListener('click', () => {
      const sentences = currentLangData().sentences;
      state.parsing.sentenceIndex = (state.parsing.sentenceIndex - 1 + sentences.length) % sentences.length;
      renderParsing();
      announce(`Sentence ${state.parsing.sentenceIndex + 1} of ${sentences.length}.`);
      focusAfterRender('parsing-prev');
    });
    document.getElementById('parsing-next').addEventListener('click', () => {
      const sentences = currentLangData().sentences;
      state.parsing.sentenceIndex = (state.parsing.sentenceIndex + 1) % sentences.length;
      renderParsing();
      announce(`Sentence ${state.parsing.sentenceIndex + 1} of ${sentences.length}.`);
      focusAfterRender('parsing-next');
    });
  }

  function renderParsingQuiz(sentence) {
    const wrap = document.getElementById('parsing-quiz-wrap');
    const idx = state.parsing.activeParseIdx;
    if (idx === null) { wrap.innerHTML = ''; return; }
    const p = sentence.parses[idx];
    const fields = fieldsForTags(p.tags);

    const rows = fields.map(([field, options]) => `
      <div class="tag-row">
        <label for="tag-${field}">${field}</label>
        <select id="tag-${field}" data-field="${field}">
          <option value="">&mdash;</option>
          ${options.map(o => `<option value="${o}">${o}</option>`).join('')}
        </select>
      </div>
    `).join('');

    wrap.innerHTML = `
      <div class="parsing-quiz">
        <p><strong lang="${langCode()}">${p.surface}</strong> (dictionary form: <span lang="${langCode()}">${lookupWord(p.wordId).headword}</span>)</p>
        ${rows}
        <button type="button" class="action primary" id="parsing-check">Check</button>
        <div id="parsing-feedback" role="status" aria-live="polite"></div>
      </div>
    `;

    document.getElementById('parsing-check').addEventListener('click', () => {
      let allCorrect = true;
      const correctDetails = [];
      const wrongDetails = [];
      fields.forEach(([field]) => {
        const select = document.getElementById(`tag-${field}`);
        const given = select.value;
        const correct = p.tags[field];
        if (!correct) return;
        if (given === correct) {
          select.classList.add('correct');
          select.classList.remove('incorrect');
          correctDetails.push(`${field}: ${correct}`);
        } else {
          allCorrect = false;
          select.classList.add('incorrect');
          select.classList.remove('correct');
          wrongDetails.push(`${field} &mdash; you said ${given ? given : 'nothing'}, it's ${correct}`);
        }
      });
      const feedback = document.getElementById('parsing-feedback');
      const btn = panel.querySelector(`.parsing-word[data-idx="${idx}"]`);
      const results = parsingResultsFor(sentence.id);
      if (allCorrect) {
        results[idx] = 'correct';
        feedback.innerHTML = `<p class="parsing-feedback correct">Correct &mdash; ${correctDetails.join(', ')}</p>`;
        if (btn) { btn.classList.add('done'); btn.classList.remove('wrong-once'); }
      } else {
        results[idx] = 'incorrect';
        feedback.innerHTML = `<p class="parsing-feedback incorrect">Not quite: ${wrongDetails.join('; ')}</p>`;
        if (btn) btn.classList.add('wrong-once');
      }
      saveProgress();
    });
  }

  function lookupWord(wordId) {
    return currentLangData().words.find(w => w.id === wordId) || { headword: '?', meaning: '' };
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- Accent mode ----------
  //
  // Recall drills, not stress-placement derivation (that would need real
  // linguistic rules — e.g. Latin's penult-weight law — and is future scope,
  // not MVP): every item's mark is scanned off an already-correctly-
  // accented/macroned form for grading, but that form has its diacritics
  // stripped before being shown, so the word itself gives no hint.
  //   Greek: shown a word with its accent removed, say which syllable it
  //   was on and what type (acute/grave/circumflex).
  //   Latin: shown a paradigm form with every macron removed and one vowel
  //   underlined, say whether that vowel is long or short.
  // Both pools are built once per language from the same generators the
  // Paradigms tab already uses, plus (Greek only) headwords and tagged
  // sentence surface forms, so there's no new data to author.

  const GREEK_VOWELS = new Set(['\u03b1', '\u03b5', '\u03b7', '\u03b9', '\u03bf', '\u03c5', '\u03c9']);
  const GREEK_DIPHTHONGS = new Set(['\u03b1\u03b9', '\u03b5\u03b9', '\u03bf\u03b9', '\u03c5\u03b9', '\u03b1\u03c5', '\u03b5\u03c5', '\u03b7\u03c5', '\u03c9\u03c5', '\u03bf\u03c5']);
  const GREEK_ACCENT_MARKS = { '\u0301': 'acute', '\u0300': 'grave', '\u0342': 'circumflex' };
  const ACCENT_TYPE_LABELS = { acute: 'Acute ( ´ )', grave: 'Grave ( ` )', circumflex: 'Circumflex ( ῀ )' };
  const ACCENT_POSITION_LABELS = { ultima: 'Ultima (last)', penult: 'Penult (2nd-to-last)', antepenult: 'Antepenult (3rd-to-last)' };

  function greekBaseLetter(ch) {
    const base = ch.normalize('NFD')[0].toLowerCase();
    return GREEK_VOWELS.has(base) ? base : null;
  }

  function greekAccentOfChar(ch) {
    const d = ch.normalize('NFD');
    for (let i = 1; i < d.length; i++) {
      if (GREEK_ACCENT_MARKS[d[i]]) return GREEK_ACCENT_MARKS[d[i]];
    }
    return null;
  }

  // Splits a Greek word into syllable nuclei (single vowels or falling
  // diphthongs), so the accented one can be located and described as
  // ultima/penult/antepenult — the only three syllables Greek accent can
  // ever fall on, which is what makes that description always well-defined
  // regardless of word length.
  function greekSyllableNuclei(word) {
    const chars = Array.from(word);
    const nuclei = [];
    let i = 0;
    while (i < chars.length) {
      const base = greekBaseLetter(chars[i]);
      if (!base) { i++; continue; }
      const span = [i];
      if (i + 1 < chars.length) {
        const nextBase = greekBaseLetter(chars[i + 1]);
        if (nextBase) {
          const hasDiaeresis = chars[i + 1].normalize('NFD').includes('\u0308');
          if (GREEK_DIPHTHONGS.has(base + nextBase) && !hasDiaeresis) span.push(i + 1);
        }
      }
      let accent = null;
      span.forEach(idx => { const a = greekAccentOfChar(chars[idx]); if (a) accent = a; });
      nuclei.push({ text: span.map(idx => chars[idx]).join(''), accent });
      i = span[span.length - 1] + 1;
    }
    return nuclei;
  }

  function greekAccentInfo(word) {
    const nuclei = greekSyllableNuclei(word);
    const accentedIdx = nuclei.findIndex(n => n.accent);
    if (accentedIdx === -1) return null; // unaccented in context (e.g. enclitic ἐστιν) — not quizzable
    const fromEnd = nuclei.length - 1 - accentedIdx;
    const position = fromEnd === 0 ? 'ultima' : fromEnd === 1 ? 'penult' : fromEnd === 2 ? 'antepenult' : null;
    if (!position) return null; // outside the last three syllables shouldn't happen; guard anyway
    return { type: nuclei[accentedIdx].accent, position, syllableCount: nuclei.length };
  }

  // Strips just the accent (acute/grave/circumflex) from a Greek word for
  // display, leaving breathing marks, iota subscript, and diaeresis intact
  // — those aren't part of what's being quizzed and are orthographically
  // required regardless. Per-character NFD then filter then NFC recomposes
  // cleanly since Greek's precomposed breathing/subscript-only forms exist
  // in Unicode's canonical tables.
  function stripGreekAccentMarks(word) {
    return Array.from(word).map(ch => {
      const stripped = Array.from(ch.normalize('NFD')).filter(c => !GREEK_ACCENT_MARKS[c]).join('');
      return stripped.normalize('NFC');
    }).join('');
  }

  const LATIN_MACRON_MAP = { '\u0101': 'a', '\u0113': 'e', '\u012b': 'i', '\u014d': 'o', '\u016b': 'u' };
  const LATIN_MACRONS = new Set(Object.keys(LATIN_MACRON_MAP));
  const LATIN_VOWELS = new Set(['a', 'e', 'i', 'o', 'u', ...LATIN_MACRONS]);
  const LATIN_DIPHTHONGS = new Set(['ae', 'au', 'ei', 'oe', 'eu', 'ui']);

  function latinBase(ch) { return LATIN_MACRONS.has(ch) ? LATIN_MACRON_MAP[ch] : ch; }

  // Picks one vowel in a generated paradigm form to quiz "long or short?"
  // on. Prefers the rightmost macron (showcasing exactly the ablative-
  // singular/genitive-plural-type endings the generator marks long), else
  // falls back to the form's last vowel as a genuinely-short example —
  // skipping diphthong endings (no macron convention applies to those) and
  // forms identical to the raw headword (nominative/vocative singular for
  // consonant-stem nouns etc. — length there isn't tracked by this dataset).
  function latinTrailingVowelTarget(form, headword) {
    if (form === headword) return null;
    const chars = Array.from(form);
    for (let i = chars.length - 1; i >= 0; i--) {
      if (LATIN_MACRONS.has(chars[i])) return { index: i, isLong: true };
    }
    for (let i = chars.length - 1; i >= 0; i--) {
      if (!LATIN_VOWELS.has(chars[i])) continue;
      if (i > 0 && LATIN_VOWELS.has(chars[i - 1])) {
        if (LATIN_DIPHTHONGS.has(latinBase(chars[i - 1]) + latinBase(chars[i]))) return null;
      }
      return { index: i, isLong: false };
    }
    return null;
  }

  const accentPoolCache = { latin: null, greek: null };

  function buildGreekAccentPool() {
    const pool = new Map();
    const add = (form, wordId, gloss) => {
      const info = greekAccentInfo(form);
      if (!info || info.syllableCount < 2) return; // monosyllables are a trivial "ultima" every time — skip
      const key = `${wordId}:${form}`;
      if (!pool.has(key)) pool.set(key, { lang: 'greek', key, display: form, wordId, gloss, position: info.position, type: info.type, syllableCount: info.syllableCount });
    };
    const words = data.greek.words;
    words.forEach(w => {
      const gloss = `${w.headword} \u2014 ${w.meaning}`;
      add(w.headword, w.id, gloss);
      if (w.pos === 'noun') {
        const p = greekNounParadigm(w);
        if (p) [p.sg, p.pl].forEach(slice => Object.values(slice || {}).forEach(f => add(f, w.id, gloss)));
      } else if (w.pos === 'adjective') {
        ['m', 'f', 'n'].forEach(g => {
          const p = greekAdjParadigm(w, g);
          if (p) [p.sg, p.pl].forEach(slice => Object.values(slice || {}).forEach(f => add(f, w.id, gloss)));
        });
      } else if (w.pos === 'pronoun') {
        ['m', 'f', 'n'].forEach(g => {
          const p = pronounParadigm(w, g);
          if (p) [p.sg, p.pl].forEach(slice => Object.values(slice || {}).forEach(f => add(f, w.id, gloss)));
        });
      } else if (w.pos === 'verb') {
        if (w.conjugation === 'irr') {
          GREEK_VERB_TENSES.forEach(([tense]) => {
            const p = irregularVerbParadigm(w, tense);
            if (p) Object.values(p).forEach(f => add(f, w.id, gloss));
          });
        } else {
          GREEK_VERB_TENSES.forEach(([tense]) => {
            const p = greekVerbParadigm(w, tense);
            if (p) Object.values(p).forEach(f => add(f, w.id, gloss));
          });
        }
      }
    });
    data.greek.sentences.forEach(s => {
      s.parses.forEach(p => {
        const w = words.find(ww => ww.id === p.wordId);
        if (w) add(p.surface, w.id, `${w.headword} \u2014 ${w.meaning}`);
      });
    });
    return Array.from(pool.values());
  }

  function buildLatinAccentPool() {
    const pool = new Map();
    const add = (form, word) => {
      const target = latinTrailingVowelTarget(form, word.headword);
      if (!target) return;
      const key = `${word.id}:${form}`;
      if (!pool.has(key)) pool.set(key, { lang: 'latin', key, display: form, wordId: word.id, gloss: `${word.headword} \u2014 ${word.meaning}`, targetIndex: target.index, isLong: target.isLong });
    };
    data.latin.words.forEach(w => {
      if (w.pos === 'noun') {
        const p = latinNounParadigm(w);
        if (p) [p.sg, p.pl].forEach(slice => Object.values(slice || {}).forEach(f => add(f, w)));
      } else if (w.pos === 'adjective') {
        ['m', 'f', 'n'].forEach(g => {
          const p = latinAdjParadigm(w, g);
          if (p) [p.sg, p.pl].forEach(slice => Object.values(slice || {}).forEach(f => add(f, w)));
        });
      }
      // Pronouns and verbs aren't included: pronoun forms carry no macrons in
      // this dataset, and only one verb ending (perfect 3pl -ērunt) does, so
      // neither gives a reliable long/short signal to quiz on.
    });
    return Array.from(pool.values());
  }

  function getAccentPool(lang) {
    if (!accentPoolCache[lang]) accentPoolCache[lang] = lang === 'latin' ? buildLatinAccentPool() : buildGreekAccentPool();
    return accentPoolCache[lang];
  }

  function accentResultsFor() {
    const lang = progress[state.lang];
    return lang.accent.results;
  }

  const ACCENT_SESSION_SIZE = 20;

  function buildAccentQueue() {
    const pool = getAccentPool(state.lang);
    const results = accentResultsFor();
    const indices = pool.map((_, i) => i);
    const notYetCorrect = indices.filter(i => results[pool[i].key] !== 'correct');
    const alreadyCorrect = indices.filter(i => results[pool[i].key] === 'correct');

    let queue = shuffle(notYetCorrect.slice()).slice(0, ACCENT_SESSION_SIZE);
    if (queue.length < ACCENT_SESSION_SIZE) {
      const used = new Set(queue);
      const filler = shuffle(alreadyCorrect.filter(i => !used.has(i)))
        .slice(0, ACCENT_SESSION_SIZE - queue.length);
      queue = queue.concat(filler);
    }
    state.accent.queue = shuffle(queue);
    state.accent.index = 0;
  }

  function resetAccentSelection() {
    state.accent.checked = false;
    state.accent.selectedPosition = null;
    state.accent.selectedType = null;
    state.accent.selectedLength = null;
  }

  function renderAccent() {
    const pool = getAccentPool(state.lang);
    if (pool.length === 0) {
      panel.innerHTML = '<p class="paradigm-note">No accent-quiz items available for this language yet.</p>';
      return;
    }
    if (state.accent.queue.length === 0) buildAccentQueue();
    if (state.accent.index >= state.accent.queue.length) {
      panel.innerHTML = '<div class="accent-card"><p>Session complete.</p></div>' +
        '<div class="vocab-controls"><button type="button" class="action primary" id="accent-restart">Start another session</button></div>';
      document.getElementById('accent-restart').addEventListener('click', () => {
        buildAccentQueue();
        resetAccentSelection();
        renderAccent();
        focusAfterRender('accent-check');
      });
      return;
    }
    resetAccentSelection();
    renderAccentItem();
  }

  function currentAccentItem() {
    const pool = getAccentPool(state.lang);
    return pool[state.accent.queue[state.accent.index]];
  }

  function renderAccentItem() {
    const item = currentAccentItem();
    if (item.lang === 'greek') renderGreekAccentItem(item);
    else renderLatinAccentItem(item);
  }

  function toggleGroupHtml(groupId, options, selected, labelFor, ariaLabel) {
    return `<div class="accent-btn-group" id="${groupId}" role="group" aria-label="${ariaLabel}">${options.map(opt => `
      <button type="button" class="action accent-btn" data-value="${opt}" aria-pressed="${opt === selected}">${labelFor(opt)}</button>
    `).join('')}</div>`;
  }

  function wireToggleGroup(groupId, onPick) {
    const group = document.getElementById(groupId);
    group.querySelectorAll('.accent-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.accent-btn').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
        onPick(btn.dataset.value);
      });
    });
  }

  function renderGreekAccentItem(item) {
    const positions = item.syllableCount >= 3 ? ['antepenult', 'penult', 'ultima'] : ['penult', 'ultima'];
    const displayWord = stripGreekAccentMarks(item.display);
    panel.innerHTML = `
      <p class="accent-question">Which syllable carries the accent, and what type is it?</p>
      <div class="accent-card">
        <span class="pos-tag">${item.syllableCount} syllable${item.syllableCount > 1 ? 's' : ''}</span>
        <div class="headword incised accent-word" lang="el">${displayWord}</div>
        <div class="meaning">${item.gloss}</div>
      </div>
      <p class="accent-group-label">Syllable</p>
      ${toggleGroupHtml('accent-position-group', positions, state.accent.selectedPosition, p => ACCENT_POSITION_LABELS[p], 'Which syllable carries the accent')}
      <p class="accent-group-label">Type</p>
      ${toggleGroupHtml('accent-type-group', ['acute', 'grave', 'circumflex'], state.accent.selectedType, t => ACCENT_TYPE_LABELS[t], 'What type of accent is it')}
      <div class="accent-controls">
        <button type="button" class="action primary" id="accent-check">Check</button>
        <button type="button" class="action" id="accent-next">Next word &rarr;</button>
      </div>
      <div id="accent-feedback" role="status" aria-live="polite"></div>
      <div class="vocab-progress">${state.accent.index + 1} / ${state.accent.queue.length}</div>
    `;
    wireToggleGroup('accent-position-group', v => { state.accent.selectedPosition = v; });
    wireToggleGroup('accent-type-group', v => { state.accent.selectedType = v; });
    document.getElementById('accent-check').addEventListener('click', () => checkGreekAccent(item));
    document.getElementById('accent-next').addEventListener('click', () => advanceAccent());
  }

  function checkGreekAccent(item) {
    const posOk = state.accent.selectedPosition === item.position;
    const typeOk = state.accent.selectedType === item.type;
    const allCorrect = posOk && typeOk;
    const results = accentResultsFor();
    results[item.key] = allCorrect ? 'correct' : 'incorrect';
    saveProgress();
    const feedback = document.getElementById('accent-feedback');
    const detail = `${item.display} &mdash; ${ACCENT_POSITION_LABELS[item.position]}, ${ACCENT_TYPE_LABELS[item.type]}`;
    feedback.innerHTML = allCorrect
      ? `<p class="parsing-feedback correct">Correct &mdash; ${detail}.</p>`
      : `<p class="parsing-feedback incorrect">Not quite &mdash; ${detail}.</p>`;
    state.accent.checked = true;
  }

  function renderLatinAccentItem(item) {
    // Strip macrons from every vowel before display — showing the mark would
    // hand the learner the answer (and, for other vowels in the word,
    // answers to questions not even being asked). Only the target
    // position is highlighted; its length has to be recalled, not read off.
    const chars = Array.from(item.display).map(latinBase);
    const marked = chars.map((c, i) => i === item.targetIndex ? `<mark class="accent-target">${c}</mark>` : c).join('');
    panel.innerHTML = `
      <p class="accent-question">Is the marked vowel long or short?</p>
      <div class="accent-card">
        <span class="pos-tag">marked vowel</span>
        <div class="headword incised accent-word" lang="la">${marked}</div>
        <div class="meaning">${item.gloss}</div>
      </div>
      ${toggleGroupHtml('accent-length-group', ['long', 'short'], state.accent.selectedLength, l => l === 'long' ? 'Long' : 'Short', 'Is the marked vowel long or short')}
      <div class="accent-controls">
        <button type="button" class="action primary" id="accent-check">Check</button>
        <button type="button" class="action" id="accent-next">Next word &rarr;</button>
      </div>
      <div id="accent-feedback" role="status" aria-live="polite"></div>
      <div class="vocab-progress">${state.accent.index + 1} / ${state.accent.queue.length}</div>
    `;
    wireToggleGroup('accent-length-group', v => { state.accent.selectedLength = v; });
    document.getElementById('accent-check').addEventListener('click', () => checkLatinAccent(item));
    document.getElementById('accent-next').addEventListener('click', () => advanceAccent());
  }

  function checkLatinAccent(item) {
    const correctLabel = item.isLong ? 'long' : 'short';
    const allCorrect = state.accent.selectedLength === correctLabel;
    const results = accentResultsFor();
    results[item.key] = allCorrect ? 'correct' : 'incorrect';
    saveProgress();
    const feedback = document.getElementById('accent-feedback');
    const markedChar = Array.from(item.display)[item.targetIndex];
    const detail = `${item.display} &mdash; the marked vowel is ${correctLabel}${item.isLong ? ` (${markedChar}, a macron)` : ' (no macron)'}`;
    feedback.innerHTML = allCorrect
      ? `<p class="parsing-feedback correct">Correct &mdash; ${detail}.</p>`
      : `<p class="parsing-feedback incorrect">Not quite &mdash; ${detail}.</p>`;
    state.accent.checked = true;
  }

  function advanceAccent() {
    state.accent.index += 1;
    resetAccentSelection();
    renderAccent();
    focusAfterRender(state.accent.index >= state.accent.queue.length ? 'accent-restart' : 'accent-check');
  }

  // ---------- Progress mode (unifies Vocab/Paradigms/Parsing/Accent) ----------

  // ---------- Progress mode (unifies Vocab/Paradigms/Parsing/Accent) ----------

  function computeProgressStats() {
    const words = currentLangData().words;
    const sentences = currentLangData().sentences;
    const lang = progress[state.lang];
    const maxBox = BOX_INTERVALS.length - 1;

    let vocabMastered = 0;
    words.forEach(w => { if (vocabBoxFor(w.id) >= maxBox) vocabMastered++; });

    let paradigmDone = 0;
    words.forEach(w => { if (lang.paradigm[w.id] && Object.keys(lang.paradigm[w.id]).length > 0) paradigmDone++; });

    const parseStatsByWord = {};
    let parseCorrect = 0, parseTotal = 0;
    sentences.forEach(s => {
      const results = lang.parsing[s.id] || {};
      s.parses.forEach((p, idx) => {
        if (!parseStatsByWord[p.wordId]) parseStatsByWord[p.wordId] = { correct: 0, total: 0 };
        parseStatsByWord[p.wordId].total++;
        parseTotal++;
        if (results[idx] === 'correct') {
          parseStatsByWord[p.wordId].correct++;
          parseCorrect++;
        }
      });
    });

    const accentPool = getAccentPool(state.lang);
    const accentResults = lang.accent.results;
    const accentStatsByWord = {};
    let accentCorrect = 0;
    accentPool.forEach(item => {
      if (!accentStatsByWord[item.wordId]) accentStatsByWord[item.wordId] = { correct: 0, total: 0 };
      accentStatsByWord[item.wordId].total++;
      if (accentResults[item.key] === 'correct') {
        accentStatsByWord[item.wordId].correct++;
        accentCorrect++;
      }
    });

    return {
      vocab: { done: vocabMastered, total: words.length },
      paradigm: { done: paradigmDone, total: words.length },
      parsing: { done: parseCorrect, total: parseTotal },
      accent: { done: accentCorrect, total: accentPool.length },
      parseStatsByWord,
      accentStatsByWord,
    };
  }

  function pct(done, total) {
    return total > 0 ? Math.round((done / total) * 100) : 0;
  }

  function progressCardHtml(title, done, total, caption) {
    const p = pct(done, total);
    return `
      <div class="progress-card">
        <h3>${title}</h3>
        <div class="progress-figure">${done} / ${total}</div>
        <div class="progress-caption">${caption} &middot; ${p}%</div>
        <div class="progress-bar" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100" aria-label="${title} progress">
          <div class="progress-bar-fill" style="width:${p}%"></div>
        </div>
      </div>
    `;
  }

  function renderProgress() {
    const words = currentLangData().words;
    const stats = computeProgressStats();
    
    const overallDone = stats.vocab.done + stats.paradigm.done + stats.parsing.done + stats.accent.done;
    const overallTotal = stats.vocab.total + stats.paradigm.total + stats.parsing.total + stats.accent.total;
    const overallPct = pct(overallDone, overallTotal);

    // Ensure page state is initialized
    if (!state.progress.page) {
      state.progress.page = 1;
    }

    const search = state.progress.search.trim().toLowerCase();
    let visibleWords = words;
    
    if (search) {
      visibleWords = visibleWords.filter(w =>
        w.headword.toLowerCase().includes(search) || w.meaning.toLowerCase().includes(search)
      );
    }

    // --- PAGINATION (20 words per page) ---
    const PAGE_SIZE = 20;
    const totalPages = Math.max(1, Math.ceil(visibleWords.length / PAGE_SIZE));

    // Keep page index within valid bounds
    if (state.progress.page > totalPages) state.progress.page = totalPages;
    if (state.progress.page < 1) state.progress.page = 1;

    const startIndex = (state.progress.page - 1) * PAGE_SIZE;
    const pagedWords = visibleWords.slice(startIndex, startIndex + PAGE_SIZE);

    const rows = pagedWords.map(w => {
      const box = vocabBoxFor(w.id);
      const paradigmEntry = progress[state.lang].paradigm[w.id];
      const paradigmCount = paradigmEntry ? Object.keys(paradigmEntry).length : 0;
      const ps = stats.parseStatsByWord[w.id];
      const as = stats.accentStatsByWord[w.id];
      return `
        <tr>
          <td lang="${langCode()}">${w.headword}</td>
          <td>${masteryDotsText(box)}</td>
          <td class="num">${paradigmCount > 0 ? paradigmCount + ' table' + (paradigmCount > 1 ? 's' : '') : '&mdash;'}</td>
          <td class="num">${ps ? `${ps.correct} / ${ps.total}` : '&mdash;'}</td>
          <td class="num">${as ? `${as.correct} / ${as.total}` : '&mdash;'}</td>
        </tr>
      `;
    }).join('');

    const emptyMessage = visibleWords.length === 0
      ? `<p class="paradigm-note">${search ? `No words match \u201c${state.progress.search.trim()}\u201d.` : 'No words found.'}</p>`
      : '';

    const paginationControls = visibleWords.length > PAGE_SIZE ? `
      <div class="progress-pagination">
        <button type="button" id="progress-prev-page" ${state.progress.page === 1 ? 'disabled' : ''}>&larr; Previous</button>
        <span>Page ${state.progress.page} of ${totalPages}</span>
        <button type="button" id="progress-next-page" ${state.progress.page === totalPages ? 'disabled' : ''}>Next &rarr;</button>
      </div>
    ` : '';

    panel.innerHTML = `
      <p class="progress-summary">Overall progress in ${state.lang === 'greek' ? 'Greek' : 'Latin'}: <strong>${overallPct}%</strong> &mdash; combining Vocab mastery, Paradigms completed, Parsing accuracy, and Accent quiz accuracy. Each mode feeds this view; nothing here needs separate tracking.</p>
      <div class="progress-grid">
        ${progressCardHtml('Vocab', stats.vocab.done, stats.vocab.total, 'words fully mastered')}
        ${progressCardHtml('Paradigms', stats.paradigm.done, stats.paradigm.total, 'words with a table completed')}
        ${progressCardHtml('Parsing', stats.parsing.done, stats.parsing.total, 'tagged words parsed correctly')}
        ${progressCardHtml('Accent', stats.accent.done, stats.accent.total, 'accent/macron quiz items correct')}
      </div>
      <div class="progress-table-controls">
        <label for="progress-search" class="visually-hidden">Search words</label>
        <input type="text" id="progress-search" class="paradigm-search" placeholder="Search words&hellip;" value="${escapeHtml(state.progress.search)}" autocomplete="off">
      </div>
      ${emptyMessage}
      ${paginationControls}
      <div class="progress-table-wrap">
        <table class="progress-table">
          <caption>Per-word breakdown (${visibleWords.length} total found &middot; showing ${pagedWords.length} on this page)</caption>
          <thead><tr><th>Word</th><th>Vocab</th><th>Paradigms</th><th>Parsing</th><th>Accent</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${paginationControls}
      <p class="paradigm-note">Vocab dots show familiarity box (${BOX_INTERVALS.length} = fully mastered). Paradigms counts distinct tables (tenses, for verbs; genders, for adjectives/pronouns) you've filled in correctly. Parsing shows correct/total across every sentence the word appears tagged in. Accent shows correct/total across every quiz item (headword, generated paradigm forms, and tagged sentence forms for Greek; generated noun/adjective case forms for Latin) drawn from that word.</p>
    `;

    // Search listener (resets to page 1)
    document.getElementById('progress-search').addEventListener('input', (e) => {
      state.progress.search = e.target.value;
      state.progress.page = 1;
      renderProgress();
    });

    // Pagination button listeners
    const prevBtn = document.getElementById('progress-prev-page');
    const nextBtn = document.getElementById('progress-next-page');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (state.progress.page > 1) {
          state.progress.page--;
          renderProgress();
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (state.progress.page < totalPages) {
          state.progress.page++;
          renderProgress();
        }
      });
    }
  }

  // ---------- Mode dispatch ----------

  function renderMode() {
    if (state.mode === 'vocab') renderVocab();
    else if (state.mode === 'paradigm') renderParadigm();
    else if (state.mode === 'parsing') renderParsing();
    else if (state.mode === 'accent') renderAccent();
    else if (state.mode === 'progress') renderProgress();
  }

  langToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-lang]');
    if (!btn) return;
    state.lang = btn.dataset.lang;
    langToggle.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    state.vocab.queue = [];
    state.paradigm.wordId = null;
    state.paradigm.posFilter = 'all';
    state.paradigm.tense = 'pres';
    state.paradigm.gender = 'm';
    state.parsing.sentenceIndex = 0;
    state.accent.queue = [];
    rememberLastUsed();
    renderMode();
    announce(`Switched to ${btn.textContent}.`);
    panel.focus();
  });

  modeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    syncModeControls();
    rememberLastUsed();
    renderMode();
    announce(`${btn.textContent} mode, ${state.lang === 'greek' ? 'Greek' : 'Latin'}.`);
    panel.focus();
  });

  if (progressToggle) {
    progressToggle.addEventListener('click', () => {
      state.mode = 'progress';
      syncModeControls();
      rememberLastUsed();
      renderMode();
      announce(`Progress, ${state.lang === 'greek' ? 'Greek' : 'Latin'}.`);
      panel.focus();
    });
  }

  renderMode();
}
