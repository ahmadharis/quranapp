"""Check every data/words/{reciter}/{ch}.json against the app's word rule and the timing rules.

    python -I validate.py [--reciters feroz ...]

Checks: shape and keys; verse set = 1..N (alislam numbering); one [start,end] per WORD of `ar`;
integers; contiguous (end == next start); start < end; first start >= 0; last end <= the MP3's
duration (frames x samples-per-frame / rate, from the per-chapter report). Prints statistics
and the verses the aligner flagged.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

import common as c  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reciters", nargs="+", default=c.RECITERS)
    a = ap.parse_args()
    counts = c.chapter_verse_counts()
    for r in a.reciters:
        d = c.REPO / "data" / "words" / r
        if not d.exists():
            continue
        errors, durs, nwords, flagged, repeats, size, done = [], [], 0, [], 0, 0, []
        for ch in range(1, 115):
            p = d / f"{ch}.json"
            if not p.exists():
                continue
            done.append(ch)
            size += p.stat().st_size
            j = json.loads(p.read_text())
            if set(j) - {"reciter", "ch", "source", "model", "lead_ms", "verses", "ar_fallback", "missing"} or j["reciter"] != r or j["ch"] != ch:
                errors.append(f"{ch}: bad header")
            if j["source"] not in ("ar_", "ar"):
                errors.append(f"{ch}: bad source")
            if sorted(list(map(int, j["verses"])) + j.get("missing", [])) != list(range(1, counts[ch] + 1)):
                errors.append(f"{ch}: verse set")
            text = c.chapter_text(ch, counts[ch])
            rp = c.WORK / "reports" / r / f"{ch}.json"
            rep = json.loads(rp.read_text()) if rp.exists() else {}
            for v, ws in j["verses"].items():
                n = len(c.words_of(text[int(v)]["ar"]))
                nwords += len(ws)
                if len(ws) != n:
                    errors.append(f"{ch}:{v} {len(ws)} spans for {n} words")
                flat = [x for w in ws for x in w]
                if not all(isinstance(x, int) for x in flat):
                    errors.append(f"{ch}:{v} non-integer")
                if ws and ws[0][0] < 0:
                    errors.append(f"{ch}:{v} negative start")
                for i, (s, e) in enumerate(ws):
                    if e <= s:
                        errors.append(f"{ch}:{v} w{i} empty")
                    if i and s != ws[i - 1][1]:
                        errors.append(f"{ch}:{v} w{i} gap/overlap")
                    durs.append(e - s)
                info = rep.get(v, {})
                if "duration_ms" in info and ws and ws[-1][1] > info["duration_ms"]:
                    errors.append(f"{ch}:{v} ends after file")
                if info.get("problems"):
                    flagged.append(f"{ch}:{v} {'; '.join(info['problems'])}")
                repeats += bool(info.get("repeats"))
        if not done:
            continue
        D = np.array(durs)
        print(f"{r}: {len(done)} chapters, {sum(counts[x] for x in done)} verses, {nwords} words, "
              f"{size / 1e6:.2f} MB JSON")
        print(f"  word ms: median {np.median(D):.0f}, p1 {np.percentile(D, 1):.0f}, p99 {np.percentile(D, 99):.0f}, "
              f"<80ms {np.mean(D < 80) * 100:.2f}%, >8s {np.mean(D > 8000) * 100:.2f}%")
        print(f"  verses with a detected repeat: {repeats}; flagged: {len(flagged)}; errors: {len(errors)}")
        for x in errors[:30]:
            print("  ERROR", x)
        for x in flagged[:30]:
            print("  flag ", x)


if __name__ == "__main__":
    main()
