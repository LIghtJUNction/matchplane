#!/usr/bin/env python3
"""Validate the small project skill catalog shipped with MatchPlane."""

from __future__ import annotations

import re
from pathlib import Path


SKILL_NAME = re.compile(r"^name: ([a-z0-9-]+)$", re.MULTILINE)
SKILL_DESCRIPTION = re.compile(r"^description: .+$", re.MULTILINE)


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
        name = SKILL_NAME.search(text)
        if not name or name.group(1) != skill.name:
            raise SystemExit(f"{skill}: frontmatter name must match the directory")
        if not SKILL_DESCRIPTION.search(text):
            raise SystemExit(f"{skill}: frontmatter description is required")

    print(f"validated {len(skills)} MatchPlane project skills")


if __name__ == "__main__":
    main()
