import hashlib
import tempfile
import unittest
import zipfile
from pathlib import Path

from runtime_feed_bundle import download, merge


class RuntimeFeedBundleTest(unittest.TestCase):
    def archive(self, root: Path, name: str, entries: dict[str, bytes]) -> Path:
        path = root / name
        with zipfile.ZipFile(path, "w") as output:
            for entry, body in entries.items():
                output.writestr(entry, body)
        return path

    def test_merges_components_and_requires_the_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = self.archive(root, "base.zip", {"llama-server.exe": b"server"})
            component = self.archive(root, "component.zip", {"cudart64.dll": b"cuda"})
            output = root / "bundle.zip"
            merge([base, component], output, ["llama-server.exe"])
            with zipfile.ZipFile(output) as bundle:
                self.assertEqual(set(bundle.namelist()), {"llama-server.exe", "cudart64.dll"})

    def test_download_verifies_the_published_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.zip"
            source.write_bytes(b"archive")
            expected = hashlib.sha256(b"archive").hexdigest()
            destination = root / "download.zip"
            download(source.as_uri(), expected, destination)
            self.assertEqual(destination.read_bytes(), b"archive")
            with self.assertRaisesRegex(ValueError, "digest"):
                download(source.as_uri(), "0" * 64, root / "bad.zip")

    def test_rejects_duplicate_and_unsafe_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = self.archive(root, "first.zip", {"llama-server.exe": b"server"})
            duplicate = self.archive(root, "duplicate.zip", {"llama-server.exe": b"other"})
            with self.assertRaisesRegex(ValueError, "duplicate"):
                merge([first, duplicate], root / "duplicate-output.zip", ["llama-server.exe"])
            unsafe = self.archive(root, "unsafe.zip", {"../cudart64.dll": b"cuda"})
            with self.assertRaisesRegex(ValueError, "unsafe"):
                merge([first, unsafe], root / "unsafe-output.zip", ["llama-server.exe"])
            parent = self.archive(root, "parent.zip", {"cuda": b"file", "cuda/cudart64.dll": b"dll"})
            with self.assertRaisesRegex(ValueError, "file-parent"):
                merge([first, parent], root / "parent-output.zip", ["llama-server.exe"])


if __name__ == "__main__":
    unittest.main()
