#!/usr/bin/env python3
"""Verify the approved preview and reference files without modifying them."""
from pathlib import Path
import hashlib
import sys

root = Path(__file__).resolve().parent
failures = []
count = 0
for line in (root / "SHA256SUMS").read_text().splitlines():
    expected, relative = line.split("  ", 1)
    target = (root / relative).resolve()
    if not target.is_relative_to(root):
        failures.append(relative)
        continue
    count += 1
    if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != expected:
        failures.append(relative)
if failures:
    print("REFERENCE CHANGED: " + ", ".join(failures), file=sys.stderr)
    sys.exit(1)
print(f"Approved reference verified: {count} files")
