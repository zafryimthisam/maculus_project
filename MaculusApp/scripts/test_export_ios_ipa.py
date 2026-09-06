import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("ipa_export", Path(__file__).with_name("export-ios-ipa.py"))
ipa_export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ipa_export)


class IpaExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "Maculus-unsigned-20260906-005015.ipa"
        self.source.write_bytes(b"test IPA payload\x00\xff")
        self.destination = self.root / "VMware Shared Folders" / "Downloads"
        self.destination.mkdir(parents=True)
        self.counter = self.root / ".maculus-ipa-counter"

    def export(self, **kwargs):
        return ipa_export.export_ipa(self.source, self.destination, self.counter, **kwargs)

    def test_starts_at_49_and_persists_next_number(self):
        first = self.export()
        self.assertEqual(first.name, "Maculus-unsigned-49.ipa")
        self.assertEqual(first.read_bytes(), self.source.read_bytes())
        self.assertEqual(self.export().name, "Maculus-unsigned-50.ipa")
        self.assertEqual(self.counter.read_text().strip(), "50")

    def test_existing_exports_are_preserved_and_counter_can_recover(self):
        previous = self.destination / "Maculus-unsigned-53.ipa"
        previous.write_bytes(b"previous export")
        self.assertEqual(self.export().name, "Maculus-unsigned-54.ipa")
        self.assertEqual(previous.read_bytes(), b"previous export")

    def test_verification_failure_removes_partial_copy_without_advancing(self):
        def corrupt_copy(_source, target):
            target.write_bytes(b"bad copy")
        with self.assertRaisesRegex(RuntimeError, "verification failed"):
            self.export(copier=corrupt_copy)
        self.assertFalse(self.counter.exists())
        self.assertEqual(list(self.destination.iterdir()), [])
        self.assertEqual(self.export().name, "Maculus-unsigned-49.ipa")

    def test_unmounted_share_preserves_local_ipa(self):
        self.destination.rmdir()
        with self.assertRaisesRegex(RuntimeError, "not mounted"):
            self.export()
        self.assertTrue(self.source.exists())
        self.assertFalse(self.counter.exists())

    def test_concurrent_export_lock_prevents_copy(self):
        (self.destination / ".maculus-ipa-export.lock").mkdir()
        with self.assertRaisesRegex(RuntimeError, "Another export"):
            self.export()
        self.assertFalse(self.counter.exists())

    def test_macos_copy_uses_no_extended_attributes(self):
        with patch.object(ipa_export.sys, "platform", "darwin"), patch.object(ipa_export.subprocess, "run") as run:
            ipa_export.copy_ipa(self.source, self.destination / "out.ipa")
        run.assert_called_once_with(["cp", "-X", str(self.source), str(self.destination / "out.ipa")], check=True)


if __name__ == "__main__":
    unittest.main()
