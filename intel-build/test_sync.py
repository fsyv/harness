"""Exercise version ordering and patch refusal without GitHub writes."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from common import select_tag, version_key


class TagTests(unittest.TestCase):
    def test_semver_order(self):
        versions = ["0.2.2-alpha.2", "0.2.2-alpha.10", "0.2.2-beta.1", "0.2.2-rc.1", "0.2.2", "0.2.10-alpha.1"]
        self.assertEqual(sorted(reversed(versions), key=version_key), versions)

    def test_annotated_tag_uses_commit(self):
        data = f"{'a'*40}\trefs/tags/dsh-v0.2.2-rc.1\n{'b'*40}\trefs/tags/dsh-v0.2.2-rc.1^{{}}\n{'c'*40}\trefs/tags/desktop-v99.0.0"
        self.assertEqual(select_tag(data), ("dsh-v0.2.2-rc.1", "b" * 40))

    def test_explicit_and_missing_tag(self):
        data = f"{'a'*40}\trefs/tags/dsh-v0.2.2\n{'b'*40}\trefs/tags/dsh-v0.2.3"
        self.assertEqual(select_tag(data, "dsh-v0.2.2")[1], "a" * 40)
        with self.assertRaises(ValueError):
            select_tag(data, "master")

    def test_reject_invalid_versions(self):
        for version in ["1.2.3-01", "01.2.3", "1.2", "1.2.3\nmalicious", "1.2.3+ignored"]:
            with self.assertRaises(ValueError):
                version_key(version)

    def test_patch_refuses_ambiguous_integration_point(self):
        spec = importlib.util.spec_from_file_location("overlay", Path(__file__).with_name("apply.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "source.ts"
            target.write_text("old old")
            with self.assertRaises(RuntimeError):
                module.replace_once(target, "old", "new")
            self.assertEqual(target.read_text(), "old old")


if __name__ == "__main__":
    unittest.main()
