"""Print a version's CHANGELOG.md section as plain text for the Comfy Registry.

The registry shows a version's changelog as one paragraph: line breaks and
Markdown are not rendered. So headings become "Added:", "Fixed:"..., list
items are joined with "; ", and Markdown markup is dropped.

    python .github/scripts/registry_changelog.py 1.2.2
    python .github/scripts/registry_changelog.py --all   # JSON {version: text}
"""

import json
import re
import sys


def sections(path="CHANGELOG.md"):
    out, current = {}, None
    for line in open(path, encoding="utf-8").read().splitlines():
        m = re.match(r"^## (\d+\.\d+\.\d+)\b", line)
        if m:
            current = m.group(1)
            out[current] = []
        elif line.startswith("## "):
            current = None
        elif current:
            out[current].append(line)
    return out


def plain(text):
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)  # links: keep the text
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"(?<!\w)\*([^*]+)\*(?!\w)", r"\1", text)
    return text.replace("`", "").strip()


def registry_text(lines):
    parts, heading, items, intro = [], None, [], []

    def flush():
        if items:
            body = "; ".join(i.rstrip(".") for i in items) + "."
            parts.append(f"{heading}: {body}" if heading else body)

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if line.startswith("### "):
            flush()
            heading, items = plain(line[4:]), []
        elif line.startswith("- "):
            items.append(plain(line[2:]))
        elif items:
            items[-1] += " " + plain(line)  # a wrapped list item
        else:
            intro.append(plain(line))
    flush()
    return " ".join(intro + parts).strip()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    all_sections = sections()
    if sys.argv[1:] == ["--all"]:
        print(json.dumps({v: registry_text(lines) for v, lines in all_sections.items()}, ensure_ascii=False))
    elif len(sys.argv) == 2:
        print(registry_text(all_sections.get(sys.argv[1], [])))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
