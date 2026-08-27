# Tabula — Latin & Greek Practice

A static, no-build-step practice tool for Latin and Greek: vocab drill, a declension/conjugation paradigm trainer, a sentence-parsing quiz, and a Greek accent / Latin vowel-length quiz — all sharing one word/sentence dataset.

## Project structure

```
index.html          # landing page — description + entrance
practice.html        # the app itself: vocab, paradigm, parsing, accent
assets/
  css/
    style.css         # shared wax-tablet theme + practice.html UI
    landing.css        # index.html only
  js/
    data.js         # generated — do not hand-edit, see Data pipeline
    app.js          # all four modes: vocab, paradigm, parsing, accent
data/
  words_la.csv       # Latin headwords
  words_gr.csv       # Greek headwords
  sentences_la.csv    # Latin practice sentences, tagged word-by-word
  sentences_gr.csv    # Greek practice sentences, tagged word-by-word
csv_to_data.py       # merges the 4 CSVs -> assets/js/data.js
validate_dataset.py   # checks the generated data.js for consistency
```

## Data pipeline

```
data/words_la.csv, words_gr.csv, sentences_la.csv, sentences_gr.csv
    │
    │  python3 csv_to_data.py data assets/js/data.js
    ▼
assets/js/data.js
    │
    │  python3 validate_dataset.py assets/js/data.js
    ▼
loaded directly by index.html
```

### `words_*.csv` columns
`id, headword, pos, meaning` are required for every row. `pos` is one of `noun`, `verb`, `adjective`, `pronoun`, or one of the invariant categories `conjunction`, `preposition`, `adverb`, `numeral`, `article`, `particle` — these carry no other columns and aren't part of any paradigm generator, but still show up in Vocab and can be tagged in sentence `parses`.
- Nouns also need `gender, declension, genitive`. For Latin 3rd declension, `declension` is `3` (regular consonant-stem, e.g. miles/militis, corpus/corporis) or `3-i` (i-stem — masc./fem. like civis/civis or urbs/urbis, whose only difference is a genitive plural in `-ium`; or neuter like mare/maris, which has a fuller set of i-stem endings: ablative singular and dative singular in `-ī`, nominative/accusative/vocative plural in `-ia`, genitive plural in `-ium`).
- Verbs also need `conjugation, principal_parts` (semicolon-separated, e.g. `amo;amare;amavi;amatus`). For Latin, `conjugation` is one of `1` (amo), `2` (video), `3` (rego), `3-io` (capio-type i-stem 3rd), or `4` (audio) — the paradigm generator derives the present, imperfect, future, and perfect active indicative from `principal_parts` for all five. For Greek, `conjugation` isn't subdivided this way; see Known limits. Set `conjugation` to `irr` for suppletive/irregular verbs (sum, εἰμί, φέρω) — see `forms` below.
- Adjectives need `declension` set to `1-2` or `3` (Latin) or `2-1-2` or `3` (Greek) — the only patterns the paradigm generator covers — plus `forms`. Latin declension `3` (i-stem adjectives) also needs `genitive` filled in (the singular genitive, e.g. `acris`, `fortis`, `felicis`) since the oblique stem isn't derivable from the nominative alone; Greek declension `3` (σ-stem, contracted) does not need `genitive` — its stem comes from the masc. nominative.
- Pronouns are entirely hand-authored via `forms` (see below); no other columns apply.

`forms` is overloaded by `pos`:
- **adjective**: `masc;fem;neut` nominative singular forms, e.g. `bonus;bona;bonum` (Latin declension `1-2`), `acer;acris;acre` / `fortis;fortis;forte` / `felix;felix;felix` (Latin declension `3`, three-/two-/one-termination respectively — repeat the same spelling across genders where the termination doesn't distinguish them), or `ἀληθής;ἀληθής;ἀληθές` (Greek declension `3`, σ-stem — masc./fem. share a form, neuter has its own).
- **pronoun**, or **verb with `conjugation=irr`**: a packed, hand-authored paradigm — every form the Paradigms tab should be able to check, since these are suppletive and there's no pattern to generate from. Packed as `key=form;key=form;...`
  - pronouns: key is `<case>-<sg|pl>-<m|f|n>`, e.g. `nom-sg-m=hic;gen-sg-m=huius;...`
  - irregular verbs: key is `<tense>-<person><sg|pl>`, e.g. `pres-1sg=sum;pres-2sg=es;...`. Only tense/person combinations you list are checkable — the rest show as "not covered" in the Paradigms tab.
  - Avoid parenthetical alternatives like `ἐστί(ν)` in a `forms` value — comparison is exact (beyond diacritics), so pick one canonical form (e.g. `ἐστίν`) or the typed answer can never match.

### `sentences_*.csv` columns
`id, text, translation, source_citation, parses`.
`parses` packs one entry per tagged word, separated by `;`, each as `word_id|surface_form|tag=val,tag=val,...`. The Parsing tab shows and grades exactly the tags present on a word — there's no fixed noun-vs-verb split, so a participle can be tagged with both noun-style and verb-style keys at once (e.g. `case=acc,number=pl,gender=m,tense=pres,aspect=imperf` for a present active participle used adjectivally). Recognized tags and their values:
- `case`: `nom, gen, dat, acc, abl, voc`
- `number`: `sg, pl`
- `gender`: `m, f, n`
- `degree`: `pos, comp, superl` — for comparable adjectives/adverbs
- `person`: `1, 2, 3`
- `tense`: Latin `pres, imperf, fut, perf, plup`; Greek `pres, imperf, fut, aor, perf`
- `aspect`: `imperf, perf` — for participles
- `mood`: `ind, sub, inf, imp`
- `voice`: `act, pass, mid, dep`
- `type`: `prep, conj, adv` — for invariant words (prepositions, conjunctions, plain adverbs), which otherwise have nothing else to parse

Any tag key outside this list is passed through into `data.js` but won't get a row in the Parsing tab, since the app has no dropdown/grading logic for it.

`word_id` must match an id in the matching `words_*.csv` — `csv_to_data.py` and `validate_dataset.py` both check this.

## Running locally

```
python3 -m http.server 8000
```
then open `http://localhost:8000` for the landing page, or `http://localhost:8000/practice.html` to go straight to the app.

## What each mode does

- **Vocab** — flashcard drill through words in the current language, prioritized with a simple Leitner-style spaced-repetition system: getting a card right pushes it further out before it's due again, "Still learning" resets it to the front of the line. Progress (and parsing results, below) is saved to `localStorage` per browser, so it survives reloads. A "Reset saved progress" link in the footer clears it.
- **Paradigms** — pick a word (or filter the list down to nouns, adjectives, pronouns, or verbs) and, for verbs, a tense; type the full declension or conjugation into the table; cells turn correct/incorrect as you type (macrons and Greek accents are optional — comparison is diacritic-insensitive), or reveal the whole table.
- **Parsing** — click any word in a practice sentence, then identify it from whichever dropdowns apply to that word (case/number/gender/degree for a noun or adjective, person/number/tense/mood/voice for a finite verb, a mix of both for a participle, or just its part of speech for an invariant word like a preposition or conjunction — see `sentences_*.csv columns` above for the full tag list). Correct/incorrect results are saved per sentence and word, so they're still marked when you navigate away and back.
- **Accent** — a recall drill for both languages: the form shown has its diacritics stripped before display, so the word itself gives no hint and you have to answer from memory, not by reading a mark off the page. Every form is drawn from words/paradigms the app already knows are correctly accented/macroned (Greek: headwords, generated paradigm forms, and tagged sentence surface forms; Latin: generated noun/adjective paradigm forms), so the underlying answer is always trustworthy even though it's hidden from the display. Greek: shown a word with its accent removed (breathing marks and iota subscript stay, since those aren't part of what's being asked), say which syllable (ultima/penult/antepenult — the only three Greek accent can ever land on) carries the accent and whether it's acute, grave, or circumflex. Latin: shown a paradigm form (ablative singulars, genitive plurals, and the like) with every macron stripped and one vowel underlined, say whether that vowel is actually long or short. Checking an answer reveals the correctly-marked spelling either way. Each quiz item's result is saved, so Progress can show how many you've gotten right.
- **Progress** — one view combining all three other modes' saved progress for the current language: how many words are fully mastered in Vocab, how many paradigm tables you've filled in correctly, your running Parsing accuracy, and your running Accent-quiz accuracy, plus a per-word breakdown table. Nothing new to track by hand — it's read straight from the same `localStorage` data the other modes already save.

## How the modes connect

- **Vocab → Parsing**: once a word reaches familiarity box 2+ in Vocab, it's underlined in solid bronze in the Parsing sentence display.
- **Vocab → Paradigms**: the word picker in Paradigms shows each word's Vocab familiarity dots inline, so you can jump straight to drilling the forms of a word you already recognize by meaning but haven't nailed the endings of.
- **Paradigms → Accent**: the Accent quiz pool is built from the same paradigm generators Paradigms uses (plus headwords and tagged sentence forms for Greek), so any word/form combination correct there is quizzable here too.
- **Vocab, Paradigms, Parsing, Accent → Progress**: the Progress tab reads each mode's saved state and rolls it into one summary and one per-word table.

## Known limits (MVP scope)

- **Noun/verb paradigm generation covers regular patterns only**: Latin 1st–5th declension nouns — including 4th-declension neuters (cornu, cornus), 3rd-declension neuters (corpus, corporis), and 3rd-declension i-stems, both masc./fem. (civis, urbis; urbs, urbis) and neuter (mare, maris) — and all four regular conjugations of verbs — 1st (amo), 2nd (video), 3rd (rego), 3rd i-stem (capio-type), and 4th (audio) — present, imperfect, future, perfect active indicative; Greek 1st–3rd declension nouns (3rd: consonant-stem masc./fem. like φύλαξ and -μα-type neuters like σῶμα only — vowel/diphthong stems like πόλις, βασιλεύς and contracting σ-stems like γένος aren't modeled) and thematic (ω-verb) verbs (present, imperfect, future, and first/sigmatic aorist active indicative). Other moods/voices and Greek's un-modeled 3rd-declension noun types aren't generated yet. Deponents and semi-deponents (any voice other than active) also aren't modeled for either language. The alternative accusative plural in `-īs` that some Latin i-stem nouns allow alongside `-ēs` isn't modeled — only `-ēs` is generated.
- **Adjective paradigm generation** covers Latin 1st/2nd-declension (bonus, -a, -um), Latin 3rd-declension i-stem (all three termination types: acer/acris/acre, fortis/forte, felix), Greek 2-1-2 (καλός, -ή, -όν), and Greek 3rd-declension σ-stem (ἀληθής, -ές type — three-termination πᾶς/πᾶσα/πᾶν and nasal-stem εὐδαίμων/-ον types aren't modeled). The Paradigms tab shows a Gender selector (masc./fem./neut.) for adjectives, since the table itself is still just case × number.
- **Pronouns and irregular verbs are hand-authored, not generated** — they're suppletive (hic/haec/hoc, sum/es/est, αὐτός, εἰμί, φέρω's aorist), so there's no productive ending pattern to derive from a headword. Their full paradigm lives directly in the `forms` column of the CSV; only the forms actually listed there are checkable in the Paradigms tab, so gaps in the data show as "not covered" there rather than a wrong answer.
- The Paradigms tab will say so whenever a selected word/tense/gender combination isn't covered by any of the above. Use the Show dropdown to filter the word list down to nouns, adjectives, pronouns, or verbs, the Tense dropdown (verbs) to switch tenses, and the Gender dropdown (adjectives/pronouns) to switch gender.
- **Accent placement is simplified** for generated Greek forms — the imperfect/aorist augment keeps its accent across all persons rather than shifting forward in the 1st/2nd plural (e.g. generated `ἐλύομεν` would traditionally be written `ἐλύομεν` with the accent on the stem), and some circumflexes/accent shifts in the genitive plural aren't modeled either — treat generated paradigms as a drilling aid, not a citation-quality reference. Comparison when typing is diacritic-insensitive either way.
- **Accent mode quizzes recall against a known-correct answer, not linguistic derivation** — each item's mark(s) are scanned off an already-correctly-accented/macroned form *before* being stripped for display (see "Accent placement is simplified" above for the Greek generator's own caveats), so the source of truth is always trustworthy even though you can't read it off the word. It isn't computing the answer from a stress rule, though — real derivation quizzes (e.g. Latin's penult-weight law: long vowel or closed syllable) are future scope, not MVP. The Latin macron quiz draws only from generated noun/adjective case forms — pronoun forms carry no macrons in this dataset and only one verb ending (perfect 3rd plural `-ērunt`) does, so neither gives a reliable long/short signal to quiz on; nominative/vocative singular forms that are just the raw headword are also skipped, since this dataset doesn't track their vowel length. The Greek accent quiz skips monosyllables (trivially always "ultima") and any surface form that turns out unaccented in context (e.g. enclitic `ἐστιν`).
- **Sample sentences are constructed for practice**, not quotations from any ancient author, so there's no attribution or copyright question — swap in real passages via the CSVs whenever you're ready.
- 258 Latin and 188 Greek words are seeded, with 56 Latin and 25 Greek practice sentences; add rows to the CSVs and re-run the pipeline to grow the dataset further.
