from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("check-skills.py")
SPEC = importlib.util.spec_from_file_location("check_skills", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
check_skills = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_skills)


def document_with_name(value: str) -> str:
    return f"---\nname: {value}\ndescription: Test skill.\n---\n\n# Test\n"


def document_with_description(value: str) -> str:
    return f"---\nname: example-skill\ndescription: {value}\n---\n\n# Test\n"


class FrontmatterBoundaryTest(unittest.TestCase):
    def test_extracts_only_the_leading_frontmatter(self) -> None:
        document = document_with_name("example-skill") + "description: Body text\n"
        self.assertEqual(
            check_skills.frontmatter_lines(document),
            ("name: example-skill", "description: Test skill."),
        )

    def test_rejects_missing_or_nonleading_boundaries(self) -> None:
        documents = (
            "name: example-skill\ndescription: Test skill.\n---\n",
            "# Preamble\n---\nname: example-skill\ndescription: Test skill.\n---\n",
            "---\nname: example-skill\ndescription: Test skill.\n",
        )
        for document in documents:
            with self.subTest(document=document):
                self.assertIsNone(check_skills.frontmatter_lines(document))


class FrontmatterNameTest(unittest.TestCase):
    def test_accepts_plain_and_quoted_names(self) -> None:
        for value in ("example-skill", "'example-skill'", '"example-skill"'):
            with self.subTest(value=value):
                document = document_with_name(value)
                self.assertEqual(
                    check_skills.frontmatter_name(document), "example-skill"
                )
                self.assertTrue(
                    check_skills.skill_name_matches(document, "example-skill")
                )

    def test_rejects_unsafe_or_invalid_yaml_values(self) -> None:
        invalid_values = (
            "",
            "Example-Skill",
            "example_skill",
            "[example-skill]",
            "{value: example-skill}",
            "!!str example-skill",
            "&name example-skill",
            '"example-skill" # comment',
        )
        for value in invalid_values:
            with self.subTest(value=value):
                self.assertIsNone(
                    check_skills.frontmatter_name(document_with_name(value))
                )

    def test_rejects_duplicate_or_quoted_name_keys(self) -> None:
        duplicate_lines = (
            "name: other-skill",
            "name: [other-skill]",
            '"name": other-skill',
            "'name': other-skill",
        )
        for duplicate_line in duplicate_lines:
            with self.subTest(duplicate_line=duplicate_line):
                document = document_with_name("example-skill").replace(
                    "description:", f"{duplicate_line}\ndescription:"
                )
                self.assertIsNone(check_skills.frontmatter_name(document))

    def test_rejects_directory_mismatch(self) -> None:
        self.assertFalse(
            check_skills.skill_name_matches(
                document_with_name("example-skill"), "different-skill"
            )
        )

    def test_body_name_cannot_replace_missing_frontmatter_name(self) -> None:
        document = "---\ndescription: Test skill.\n---\n\nname: example-skill\n"
        self.assertIsNone(check_skills.frontmatter_name(document))


class FrontmatterDescriptionTest(unittest.TestCase):
    def test_accepts_plain_and_double_quoted_descriptions(self) -> None:
        cases = (
            ("A useful test skill.", "A useful test skill."),
            ('"A useful test skill."', "A useful test skill."),
            ('"A \\"quoted\\" skill."', 'A "quoted" skill.'),
            ('"null"', "null"),
            ('"# literal text"', "# literal text"),
            ("Useful text. # metadata comment", "Useful text."),
        )
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(
                    check_skills.frontmatter_description(
                        document_with_description(value)
                    ),
                    expected,
                )

    def test_rejects_missing_duplicate_or_body_only_description(self) -> None:
        missing = "---\nname: example-skill\n---\n\n# Test\n"
        body_only = missing + "description: Body text must not count.\n"
        duplicate = document_with_description("First description.").replace(
            "---\n\n# Test", "description: Second description.\n---\n\n# Test"
        )
        quoted_duplicate = document_with_description("First description.").replace(
            "---\n\n# Test", '"description": Second description.\n---\n\n# Test'
        )
        for document in (missing, body_only, duplicate, quoted_duplicate):
            with self.subTest(document=document):
                self.assertIsNone(check_skills.frontmatter_description(document))

    def test_rejects_empty_null_comment_and_malformed_values(self) -> None:
        invalid_values = (
            "",
            "   ",
            "null",
            "NULL",
            "null # empty",
            "~",
            "true",
            "123",
            "[]",
            "{}",
            "|",
            ">-",
            "&description text",
            "*description",
            "!!str text",
            "# comment only",
            '""',
            '"   "',
            '"unterminated',
            'unterminated"',
            "'unterminated",
            "'unsupported quoted text'",
        )
        for value in invalid_values:
            with self.subTest(value=value):
                self.assertIsNone(
                    check_skills.frontmatter_description(
                        document_with_description(value)
                    )
                )

    def test_ignores_body_description_after_valid_frontmatter(self) -> None:
        document = document_with_description("Frontmatter text.")
        document += "description: Body text.\n"
        self.assertEqual(
            check_skills.frontmatter_description(document), "Frontmatter text."
        )


if __name__ == "__main__":
    unittest.main()
