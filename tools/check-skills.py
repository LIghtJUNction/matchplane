#!/usr/bin/env python3
"""Validate the small project skill catalog shipped with MatchPlane."""

from __future__ import annotations

import json
import re
from pathlib import Path

SKILL_NAME = re.compile(r"""name: +(?:([a-z0-9-]+)|'([a-z0-9-]+)'|"([a-z0-9-]+)")""")
TOP_LEVEL_KEY = re.compile(r"([a-z][a-z0-9_-]*):(?: |$)")
NON_STRING_PLAIN_VALUES = frozenset(
    {"null", "~", "true", "false", ".nan", ".inf", "+.inf", "-.inf"}
)
PLAIN_NUMBER = re.compile(
    r"[+-]?(?:(?:0|[1-9][0-9_]*)(?:\.[0-9_]*)?|\.[0-9_]+)(?:e[+-]?[0-9]+)?",
    re.IGNORECASE,
)


def frontmatter_lines(document: str) -> tuple[str, ...] | None:
    """Extract lines inside strict, leading YAML frontmatter delimiters."""
    if not document.startswith("---\n"):
        return None

    lines = document.splitlines()
    try:
        closing_delimiter = lines.index("---", 1)
    except ValueError:
        return None

    frontmatter = tuple(lines[1:closing_delimiter])
    seen_keys: set[str] = set()
    for line in frontmatter:
        if not line or line.startswith(("#", " ")):
            continue
        match = TOP_LEVEL_KEY.match(line)
        if match is None:
            return None
        key = match.group(1)
        if key in seen_keys:
            return None
        seen_keys.add(key)
    return frontmatter


def unique_frontmatter_line(document: str, key: str) -> str | None:
    """Return the only top-level line for key, or None unless exactly one exists."""
    frontmatter = frontmatter_lines(document)
    if frontmatter is None:
        return None

    matching_lines = [line for line in frontmatter if line.startswith(f"{key}:")]
    if len(matching_lines) != 1:
        return None
    return matching_lines[0]


def frontmatter_name(document: str) -> str | None:
    """Return a simple, safe YAML name scalar from the document frontmatter."""
    name_line = unique_frontmatter_line(document, "name")
    if name_line is None:
        return None

    match = SKILL_NAME.fullmatch(name_line)
    if match is None:
        return None
    return next(value for value in match.groups() if value is not None)


def frontmatter_description(document: str) -> str | None:
    """Return a non-empty plain or double-quoted frontmatter description."""
    description_line = unique_frontmatter_line(document, "description")
    if description_line is None:
        return None

    prefix = "description:"
    remainder = description_line[len(prefix) :]
    if not remainder.startswith(" "):
        return None
    value = remainder.strip()
    if not value or value.startswith("#"):
        return None

    if value.startswith('"'):
        try:
            decoded = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(decoded, str) or not decoded.strip():
            return None
        return decoded.strip()
    if value.startswith("'") or value.endswith(("'", '"')):
        return None

    # In a plain scalar, an inline comment begins at whitespace followed by `#`.
    # Validate the semantic value rather than letting `null # comment` pass.
    value = value.split(" #", 1)[0].rstrip()
    if (
        not value
        or value.startswith(("[", "{", "|", ">", "&", "*", "!", "?", "- ", ": "))
        or ": " in value
        or value.casefold() in NON_STRING_PLAIN_VALUES
        or PLAIN_NUMBER.fullmatch(value) is not None
    ):
        return None
    return value


def skill_name_matches(document: str, directory_name: str) -> bool:
    """Check that the frontmatter has one safe name matching its directory."""
    return frontmatter_name(document) == directory_name


def main() -> None:
    root = Path(".agents/skills")
    skills = sorted(path for path in root.iterdir() if path.is_dir())
    if not skills:
        raise SystemExit("at least one project skill is required")

    for skill in skills:
        document = skill / "SKILL.md"
        if not document.is_file():
            raise SystemExit(f"{skill}: SKILL.md is required")
        text = document.read_text(encoding="utf-8")
        if not text.startswith("---\n"):
            raise SystemExit(f"{skill}: SKILL.md must start with YAML frontmatter")
        if not skill_name_matches(text, skill.name):
            raise SystemExit(f"{skill}: frontmatter name must match the directory")
        if frontmatter_description(text) is None:
            raise SystemExit(f"{skill}: frontmatter description is required")

    print(f"validated {len(skills)} MatchPlane project skills")


if __name__ == "__main__":
    main()
