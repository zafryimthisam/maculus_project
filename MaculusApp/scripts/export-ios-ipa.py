#!/usr/bin/env python3
"""Copy a built IPA to the shared folder using a persistent, verified sequence."""

import argparse
import filecmp
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


LAST_MANUAL_EXPORT = 48
DEFAULT_DESTINATION = "/Volumes/VMware Shared Folders/Downloads"


def copy_ipa(source, target):
    if sys.platform == "darwin":
        subprocess.run(["cp", "-X", str(source), str(target)], check=True)
    else:
        # Also permits testing the export independently of Xcode/macOS.
        shutil.copyfile(source, target)


def export_ipa(source, destination, counter, copier=copy_ipa):
    source, destination, counter = map(Path, (source, destination, counter))
    if not source.is_file():
        raise RuntimeError(f"Source IPA does not exist: {source}")
    if not destination.is_dir():
        raise RuntimeError(f"Shared folder is not mounted: {destination}. Local IPA retained: {source}")
    lock = destination / ".maculus-ipa-export.lock"
    try:
        lock.mkdir()
    except FileExistsError:
        raise RuntimeError(f"Another export may be running. Check the export lock: {lock}") from None
    try:
        last = LAST_MANUAL_EXPORT
        if counter.exists():
            value = counter.read_text(encoding="utf-8").strip()
            if not re.fullmatch(r"[0-9]+", value):
                raise RuntimeError(f"Invalid IPA counter; refusing to reset it: {counter}")
            last = max(last, int(value))
        for entry in destination.iterdir():
            match = re.fullmatch(r"Maculus-unsigned-([0-9]+)\.ipa", entry.name)
            if match:
                last = max(last, int(match[1]))
        target = destination / f"Maculus-unsigned-{last + 1}.ipa"
        # Exclusive creation prevents accidentally overwriting a previous IPA.
        with target.open("xb"):
            pass
        verified = False
        try:
            copier(source, target)
            if not filecmp.cmp(source, target, shallow=False):
                raise RuntimeError(f"IPA verification failed: {target}")
            verified = True
            counter.parent.mkdir(parents=True, exist_ok=True)
            temporary = counter.with_name(counter.name + ".tmp")
            temporary.write_text(f"{last + 1}\n", encoding="utf-8")
            os.replace(temporary, counter)
        finally:
            if not verified:
                target.unlink(missing_ok=True)
        # If counter persistence fails, retain the verified IPA. The destination
        # scan recovers its number on the next run without overwriting it.
        return target
    finally:
        lock.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--destination", type=Path, default=Path(os.environ.get("MACULUS_SHARED_IPA_DIR", DEFAULT_DESTINATION)))
    parser.add_argument("--counter", type=Path)
    args = parser.parse_args()
    counter = args.counter or args.source.parent / ".maculus-ipa-counter"
    try:
        target = export_ipa(args.source, args.destination, counter)
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"IPA export failed: {error}\nLocal IPA: {args.source}\n")
    print(f"Shared IPA: {target} ({target.stat().st_size:,} bytes)")
    print("IPA copied and verified successfully")


if __name__ == "__main__":
    main()
