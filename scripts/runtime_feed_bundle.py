#!/usr/bin/env python3
"""Download and safely merge split upstream ZIP archives."""

from __future__ import annotations

import argparse
import copy
import hashlib
import os
import shutil
import stat
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
MAX_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024
RETRYABLE_STATUS = {429, 502, 503, 504}


def safe_name(raw: str) -> str:
    value = raw.replace("\\", "/")
    path = PurePosixPath(value)
    if not value or value.startswith("/") or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("component archive contains an unsafe path")
    return str(path)


def download(url: str, expected_sha256: str, destination: Path) -> None:
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            request = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/octet-stream",
                    "User-Agent": "msty-catalogs-runtime-feed/1",
                },
            )
            digest = hashlib.sha256()
            with urllib.request.urlopen(request, timeout=90) as response, destination.open("wb") as output:
                declared = int(response.headers.get("Content-Length", "0") or "0")
                if declared > MAX_DOWNLOAD_BYTES:
                    raise ValueError("component archive exceeds the download limit")
                copied = 0
                while chunk := response.read(1024 * 1024):
                    copied += len(chunk)
                    if copied > MAX_DOWNLOAD_BYTES:
                        raise ValueError("component archive exceeded the download limit")
                    output.write(chunk)
                    digest.update(chunk)
            if digest.hexdigest() != expected_sha256:
                raise ValueError("component archive digest did not match GitHub metadata")
            return
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code not in RETRYABLE_STATUS or attempt == 3:
                raise
        except (OSError, TimeoutError, urllib.error.URLError) as error:
            last_error = error
            if attempt == 3:
                raise
        time.sleep(2**attempt)
    raise RuntimeError("component download failed") from last_error


def merge(inputs: list[Path], output: Path, required: list[str]) -> None:
    seen: set[str] = set()
    files: set[str] = set()
    expanded = 0
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as target:
            for source_path in inputs:
                with zipfile.ZipFile(source_path, "r") as source:
                    for entry in source.infolist():
                        name = safe_name(entry.filename.rstrip("/"))
                        is_directory = entry.is_dir()
                        mode = entry.external_attr >> 16
                        if stat.S_ISLNK(mode):
                            raise ValueError("component archive contains a symbolic link")
                        if name in seen:
                            if is_directory:
                                continue
                            raise ValueError("component archives contain duplicate files")
                        parents = list(PurePosixPath(name).parents)
                        if any(str(parent) in files for parent in parents if str(parent) != "."):
                            raise ValueError("component archive contains a file-parent conflict")
                        if not is_directory and any(existing.startswith(f"{name}/") for existing in seen):
                            raise ValueError("component archive contains a file-parent conflict")
                        seen.add(name)
                        if not is_directory:
                            files.add(name)
                        expanded += entry.file_size
                        if expanded > MAX_EXPANDED_BYTES:
                            raise ValueError("expanded runtime bundle exceeds the size limit")
                        copied = copy.copy(entry)
                        copied.filename = f"{name}/" if is_directory else name
                        if is_directory:
                            target.writestr(copied, b"")
                            continue
                        with source.open(entry, "r") as reader, target.open(copied, "w", force_zip64=True) as writer:
                            shutil.copyfileobj(reader, writer, length=1024 * 1024)
        missing = set(required) - seen
        if missing:
            raise ValueError("assembled runtime bundle is missing required files: " + ", ".join(sorted(missing)))
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--required", action="append", default=[])
    parser.add_argument("--source", action="append", nargs=2, metavar=("URL", "SHA256"), required=True)
    args = parser.parse_args()
    if len(args.source) < 2:
        parser.error("a base archive and at least one component URL are required")
    output = Path(args.output)
    with tempfile.TemporaryDirectory(prefix="msty-runtime-feed-") as directory:
        root = Path(directory)
        inputs = []
        for index, (url, expected_sha256) in enumerate(args.source):
            if len(expected_sha256) != 64 or any(character not in "0123456789abcdef" for character in expected_sha256):
                parser.error("source SHA-256 values must be lowercase hexadecimal")
            path = root / f"component-{index}.zip"
            download(url, expected_sha256, path)
            inputs.append(path)
        merge(inputs, output, args.required)


if __name__ == "__main__":
    main()
