"""
Sanity-checks assets/js/data.js before it's wired into the app.

Checks per language:
  - Duplicate word ids
  - Nouns missing gender/declension/genitive
  - Verbs missing conjugation/principal_parts
  - 3rd-declension Latin adjectives missing genitive (needed for the
    oblique stem, since it can't be derived from the nominative alone
    the way Greek's contracted 3rd-declension adjectives can be)
  - Sentence parses referencing a word id that doesn't exist
    (should already be caught by csv_to_data.py, but re-checked here
    in case data.js was hand-edited)

Usage:
    python3 validate_dataset.py assets/js/data.js
"""

import json
import re
import sys
from pathlib import Path


def load_bundle(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    match = re.search(r"=\s*(\{.*\});?\s*$", text, re.DOTALL)
    if not match:
        raise ValueError("Couldn't find a JSON object assigned in this file")
    return json.loads(match.group(1))


def check_language(lang: str, data: dict) -> list:
    issues = []
    words = data.get("words", [])
    sentences = data.get("sentences", [])

    seen_ids = {}
    for w in words:
        seen_ids.setdefault(w.get("id"), []).append(w)

    for wid, entries in seen_ids.items():
        if len(entries) > 1:
            issues.append(f"[{lang}] duplicate word id '{wid}' ({len(entries)} entries)")

    for w in words:
        wid = w.get("id", "<no id>")
        if w.get("pos") == "noun":
            for field in ("gender", "declension", "genitive"):
                if not w.get(field):
                    issues.append(f"[{lang}:{wid}] noun missing '{field}'")
        elif w.get("pos") == "verb":
            if not w.get("conjugation"):
                issues.append(f"[{lang}:{wid}] verb missing 'conjugation'")
            if not w.get("principalParts"):
                issues.append(f"[{lang}:{wid}] verb missing 'principalParts'")
            if w.get("conjugation") == "irr" and not w.get("paradigm"):
                issues.append(f"[{lang}:{wid}] irregular verb missing 'forms' (hand-authored paradigm)")
        elif w.get("pos") == "adjective":
            if not w.get("declension"):
                issues.append(f"[{lang}:{wid}] adjective missing 'declension'")
            if not w.get("adjForms"):
                issues.append(f"[{lang}:{wid}] adjective missing 'forms' (masc;fem;neut)")
            if lang == "latin" and w.get("declension") == "3" and not w.get("genitive"):
                issues.append(f"[{lang}:{wid}] 3rd-declension adjective missing 'genitive' (needed for the oblique stem)")
        elif w.get("pos") == "pronoun":
            if not w.get("paradigm"):
                issues.append(f"[{lang}:{wid}] pronoun missing 'forms' (hand-authored paradigm)")

    valid_ids = {w.get("id") for w in words}
    for s in sentences:
        sid = s.get("id", "<no id>")
        for p in s.get("parses", []):
            if p.get("wordId") not in valid_ids:
                issues.append(f"[{lang}:{sid}] parse references unknown word id '{p.get('wordId')}'")

    return issues


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 validate_dataset.py <data.js>")
        sys.exit(1)

    path = Path(sys.argv[1])
    bundle = load_bundle(path)

    all_issues = []
    for lang, data in bundle.items():
        all_issues.extend(check_language(lang, data))

    total_words = sum(len(d.get("words", [])) for d in bundle.values())
    total_sentences = sum(len(d.get("sentences", [])) for d in bundle.values())
    print(f"Checked {total_words} word(s) and {total_sentences} sentence(s) across {len(bundle)} language(s).\n")

    if not all_issues:
        print("No issues found.")
        sys.exit(0)

    print(f"{len(all_issues)} issue(s) found:\n")
    for issue in all_issues:
        print(f"  - {issue}")
    sys.exit(1)


if __name__ == "__main__":
    main()
