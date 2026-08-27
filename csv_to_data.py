"""
Converts the four source CSVs in data/ into a single assets/js/data.js
consumed directly by the app (no build step at runtime).

Also writes counts.json next to the output file, with word/sentence
totals per language, e.g.:
    { "words": {"latin": 120, "greek": 95}, "sentences": {"latin": 40, "greek": 30} }
This is read by the landing page to show a real content-scope number
instead of a hardcoded one that goes stale.

Input files (in the given data dir):
    words_la.csv, words_gr.csv        -- one row per headword
    sentences_la.csv, sentences_gr.csv -- one row per practice sentence

words_*.csv columns:
    id, headword, pos, meaning,
    gender, declension, genitive,        (nouns)
    conjugation, principal_parts,        (verbs; principal_parts is
                                           semicolon-separated. Greek regular
                                           verbs may give a 5th part after
                                           pres/fut/aor/perf-act -- the
                                           aorist passive 1sg, e.g. "ἐλύθην"
                                           -- to enable the fut-pass/aor-pass
                                           paradigm tables; only the
                                           weak/θη-type passive aorist is
                                           supported by the generator. Latin
                                           verbs' 4th part is the perfect
                                           passive participle, e.g.
                                           "amatus", used the same way for
                                           the perf-pass table.)
    forms                                (adjectives, pronouns, and
                                           irregular verbs; see below)

    pos is one of: noun, verb, adjective, pronoun, plus invariant
    categories that carry no other columns: conjunction, preposition,
    adverb, numeral, article, particle. Only the first four get
    grammar-specific fields/generation; the rest are vocab-only entries.

    `forms` is overloaded by pos:
      - adjective: "masc;fem;neut" nominative singular forms, e.g.
        "bonus;bona;bonum". Requires declension "1-2" or "3" (Latin)
        or "2-1-2" or "3" (Greek) — the only patterns the generator
        covers. Latin declension "3" (i-stem adjectives: three-termination
        "acer;acris;acre", two-termination "fortis;fortis;forte",
        one-termination "felix;felix;felix") also needs `genitive`
        filled in with the singular genitive (e.g. "acris", "fortis",
        "felicis") — same column nouns use, since the oblique stem
        can't be derived from the nominative alone. Greek declension
        "3" (σ-stem, e.g. "ἀληθής;ἀληθής;ἀληθές") does NOT need
        `genitive` — the contracted stem is derived from the masc.
        nominative instead.
      - pronoun: a fully hand-authored paradigm, packed as
        "key=form;key=form;...", where key is
        "<case>-<sg|pl>-<m|f|n>", e.g. "nom-sg-m=hic;gen-sg-m=huius;...".
        Pronouns are suppletive, so there's no pattern to generate —
        list every form the Paradigms tab should be able to check.
      - verb with conjugation "irr": same packed format as pronouns,
        but keyed "<tense>-<person><sg|pl>", e.g.
        "pres-1sg=sum;pres-2sg=es;...". Only the tense/person
        combinations you list will be checkable; omitted ones show
        as "not covered" in the Paradigms tab.

sentences_*.csv columns:
    id, text, translation, source_citation, parses

    `parses` packs one entry per tagged word, separated by ';':
        word_id|surface_form|tag=val,tag=val,...

    The Parsing tab shows and grades exactly the tags present on a given
    word -- there's no fixed noun-vs-verb split, so a participle can carry
    both noun-style and verb-style tags at once (e.g. case=acc,number=pl,
    gender=m,tense=pres,aspect=imperf for a present active participle used
    adjectivally). Recognized tags:
        case      nom, gen, dat, acc, abl, voc
        number    sg, pl
        gender    m, f, n
        degree    pos, comp, superl               (comparable adjectives/adverbs)
        person    1, 2, 3
        tense     Latin: pres, imperf, fut, perf, plup
                  Greek:  pres, imperf, fut, aor, perf
        aspect    imperf, perf                     (participles)
        mood      ind, sub, inf, imp
        voice     act, pass, mid, dep
        type      prep, conj, adv                  (invariant words)
    Any other tag key is passed through into data.js but won't get a
    Parsing-tab row, since the app doesn't know how to grade it.

Usage:
    python3 csv_to_data.py <data_dir> <output_js_path>
"""

import csv
import json
import sys
from pathlib import Path

LANGS = {"latin": "la", "greek": "gr"}


def parse_word_row(row: dict, line_no: int, source: str) -> dict:
    required = ["id", "headword", "pos", "meaning"]
    missing = [f for f in required if not row.get(f, "").strip()]
    if missing:
        raise ValueError(f"{source}:{line_no}: missing required field(s) {missing}")

    word = {
        "id": row["id"].strip(),
        "headword": row["headword"].strip(),
        "pos": row["pos"].strip(),
        "meaning": row["meaning"].strip(),
    }
    if row.get("gender", "").strip():
        word["gender"] = row["gender"].strip()
    if row.get("declension", "").strip():
        word["declension"] = row["declension"].strip()
    if row.get("genitive", "").strip():
        word["genitive"] = row["genitive"].strip()
    if row.get("conjugation", "").strip():
        word["conjugation"] = row["conjugation"].strip()
    if row.get("principal_parts", "").strip():
        word["principalParts"] = [p.strip() for p in row["principal_parts"].split(";") if p.strip()]
    if row.get("forms", "").strip():
        word.update(parse_forms_column(row["forms"], word["pos"], word.get("conjugation", ""), source, line_no))

    return word


def parse_forms_column(forms_str: str, pos: str, conjugation: str, source: str, line_no: int) -> dict:
    """Overloaded by pos — see module docstring for the packing formats."""
    forms_str = forms_str.strip()
    if not forms_str:
        return {}

    if pos == "adjective":
        parts = [p.strip() for p in forms_str.split(";")]
        if len(parts) != 3 or not all(parts):
            raise ValueError(
                f"{source}:{line_no}: adjective 'forms' must be 'masc;fem;neut', got {forms_str!r}"
            )
        return {"adjForms": {"m": parts[0], "f": parts[1], "n": parts[2]}}

    if pos == "pronoun" or (pos == "verb" and conjugation == "irr"):
        paradigm = {}
        for pair in forms_str.split(";"):
            pair = pair.strip()
            if not pair:
                continue
            key, sep, val = pair.partition("=")
            if not sep:
                raise ValueError(f"{source}:{line_no}: malformed forms entry {pair!r} (expected key=value)")
            paradigm[key.strip()] = val.strip()
        return {"paradigm": paradigm}

    # forms given but pos doesn't use it — ignore rather than error, so a
    # stray value doesn't block the whole pipeline.
    return {}


def parse_tags(tag_str: str) -> dict:
    tags = {}
    for pair in tag_str.split(","):
        pair = pair.strip()
        if not pair:
            continue
        key, _, val = pair.partition("=")
        tags[key.strip()] = val.strip()
    return tags


def parse_parses_column(parses_str: str, sentence_id: str, valid_word_ids: set) -> list:
    entries = []
    for chunk in parses_str.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = chunk.split("|")
        if len(parts) != 3:
            raise ValueError(f"{sentence_id}: malformed parse entry {chunk!r} (expected word_id|surface|tags)")
        word_id, surface, tag_str = parts
        word_id = word_id.strip()
        if word_id not in valid_word_ids:
            raise ValueError(f"{sentence_id}: parse references unknown word id {word_id!r}")
        entries.append({
            "wordId": word_id,
            "surface": surface.strip(),
            "tags": parse_tags(tag_str),
        })
    return entries


def load_words(path: Path) -> list:
    words = []
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, start=2):
            words.append(parse_word_row(row, i, path.name))
    return words


def load_sentences(path: Path, valid_word_ids: set) -> list:
    sentences = []
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, start=2):
            required = ["id", "text", "translation"]
            missing = [f for f in required if not row.get(f, "").strip()]
            if missing:
                raise ValueError(f"{path.name}:{i}: missing required field(s) {missing}")
            sentences.append({
                "id": row["id"].strip(),
                "text": row["text"].strip(),
                "translation": row["translation"].strip(),
                "sourceCitation": row.get("source_citation", "").strip(),
                "parses": parse_parses_column(row.get("parses", ""), row["id"].strip(), valid_word_ids),
            })
    return sentences


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 csv_to_data.py <data_dir> <output_js_path>")
        sys.exit(1)

    data_dir = Path(sys.argv[1])
    out_path = Path(sys.argv[2])

    bundle = {}
    errors = []

    for lang, suffix in LANGS.items():
        try:
            words = load_words(data_dir / f"words_{suffix}.csv")
            word_ids = {w["id"] for w in words}
            sentences = load_sentences(data_dir / f"sentences_{suffix}.csv", word_ids)
            bundle[lang] = {"words": words, "sentences": sentences}
        except ValueError as e:
            errors.append(str(e))

    if errors:
        print(f"Stopped: {len(errors)} error(s):\n")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    js_content = "const classicsData = " + json.dumps(bundle, indent=2, ensure_ascii=False) + ";\n"
    out_path.write_text(js_content, encoding="utf-8")

    counts = {
        "words": {lang: len(bundle[lang]["words"]) for lang in bundle},
        "sentences": {lang: len(bundle[lang]["sentences"]) for lang in bundle},
    }
    counts_path = out_path.parent / "counts.json"
    counts_path.write_text(json.dumps(counts, indent=2) + "\n", encoding="utf-8")

    for lang in bundle:
        print(f"{lang}: {len(bundle[lang]['words'])} word(s), {len(bundle[lang]['sentences'])} sentence(s)")
    print(f"\nWrote {out_path}")
    print(f"Wrote {counts_path}")
    print("Run validate_dataset.py next.")


if __name__ == "__main__":
    main()
