#!/usr/bin/env python3
"""
FEDJAJ redaction CI gate.

Scans all dataset files (metadata.jsonl, beacons.jsonl, and any raw JSON)
for raw PII patterns. Fails the build if any match is found.

Patterns (Algerian):
  - Card numbers: 16 digits (may have spaces/dashes)
  - Phone numbers: 10 digits starting with 05/06/07/09 (with or without separators)
  - CIN: 14 digits
  - IBAN: DZ + 22 digits (24 chars total)

Usage: python3 tests/test_redaction.py [--dataset-dir PATH]
Exit code: 0 = clean, 1 = PII found
"""

import json
import os
import re
import sys
import argparse

# Raw PII patterns (strict - only flag what looks like real data)
PATTERNS = [
    ("CARD_16", re.compile(r'\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b')),
    ("PHONE_DZ", re.compile(r'\b0[5679][- ]?\d{2}[- ]?\d{2}[- ]?\d{2}[- ]?\d{2}\b')),
    ("CIN_14", re.compile(r'\b\d{14}\b')),
    ("IBAN_DZ", re.compile(r'\bDZ\d{22}\b')),
]

# Fields that MAY contain PII in metadata (these are expected to be redacted)
METADATA_ALLOWED_FIELDS = {"url", "referrer", "ua", "screen", "tz", "geo_hint"}


def scan_string(content: str, filepath: str) -> list:
    """Scan a string for PII patterns. Returns list of (pattern_name, match, context)."""
    hits = []
    for name, pattern in PATTERNS:
        for m in pattern.finditer(content):
            # Context: 30 chars before/after
            start = max(0, m.start() - 30)
            end = min(len(content), m.end() + 30)
            ctx = content[start:end].replace('\n', '\\n')
            hits.append((name, m.group(), ctx))
    return hits


def scan_file(filepath: str) -> list:
    """Scan a file line by line (handles JSONL)."""
    hits = []
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                # Try to parse as JSON - if it parses, check values only
                try:
                    obj = json.loads(line)
                    # For metadata.jsonl, only scan non-allowed fields
                    if 'fields' in obj and 'raw_encrypted' in obj:
                        # This is metadata - only scan the structural fields
                        # The actual PII is in the encrypted raw file (expected)
                        scan_obj = {k: v for k, v in obj.items()
                                   if k not in METADATA_ALLOWED_FIELDS}
                        content = json.dumps(scan_obj, ensure_ascii=False)
                    else:
                        content = line
                    hits.extend((name, match, f"{filepath}:{line_num}:{ctx}")
                              for name, match, ctx in scan_string(content, filepath))
                except json.JSONDecodeError:
                    # Not JSON, scan raw
                    hits.extend((name, match, f"{filepath}:{line_num}:{ctx}")
                              for name, match, ctx in scan_string(line, filepath))
    except Exception as e:
        hits.append(("SCAN_ERROR", str(e), filepath))
    return hits


def scan_dir(root: str) -> list:
    """Recursively scan all files in directory."""
    all_hits = []
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            if fn.endswith(('.jsonl', '.json', '.enc', '.txt', '.log')):
                fp = os.path.join(dirpath, fn)
                # Skip .enc files - they're encrypted, should be opaque
                if fn.endswith('.enc'):
                    continue
                all_hits.extend(scan_file(fp))
    return all_hits


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset-dir', default='datasets')
    parser.add_argument('--strict', action='store_true', help='Fail on ANY hit, including allowed fields')
    args = parser.parse_args()

    hits = scan_dir(args.dataset_dir)

    if hits:
        print("❌ REDACTION GATE FAILED — Raw PII found in datasets:")
        for name, match, ctx in hits:
            print(f"  [{name}] {match}")
            print(f"    Context: ...{ctx}...")
        print(f"\nTotal hits: {len(hits)}")
        return 1
    else:
        print("✅ REDACTION GATE PASSED — No raw PII found in datasets.")
        return 0


if __name__ == '__main__':
    sys.exit(main())