"""Per-reciter calibration of the word-start lead (see timing.LEADS).

There is no ground truth, so a boundary is judged by an independent recogniser: for each
internal word boundary, the two words on either side are cut out at that boundary (shifted by
`sh` ms) and transcribed in isolation; the letter error rate of the pair is lowest when the
boundary sits where the second word becomes audible. Sweeping `sh` over every boundary of a
reciter's test set gives the systematic offset of that reciter's boundaries.

    python -I calibrate.py align  --reciters rashid ashiq       # aligns the test set (cached)
    python -I calibrate.py judge  --reciters rashid --judge xlsr_ar
    python -I calibrate.py report

Spans are cached in $ALIGN_WORK/calib/{reciter}.json; judge curves in
$ALIGN_WORK/calib/{reciter}.{judge}.json. Shifts are relative to lead 0 (snapped boundaries,
no lead): the best shift `s` means a lead of -s ms.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

import common as c  # noqa: E402

# benchmark.py's set (chapter 1, 2:1-6, 2:256, 2:283, muqatta'at 2:2 3:2 19:2 36:2, 24:36, 73:21,
# Juz 30 78:1-12, 98:6, 103, 108, 112, 114) plus 67:1-5 and 87:1-10.
SET = {1: range(1, 8), 2: list(range(1, 7)) + [256, 283], 3: [1, 2], 19: [2], 24: [36], 36: [2],
       67: range(1, 6), 73: [21], 78: range(1, 13), 87: range(1, 11), 98: [6], 103: range(1, 5),
       108: range(1, 5), 112: range(1, 6), 114: range(1, 8)}
SHIFTS = list(range(-240, 141, 20))
CAL = c.WORK / "calib"


def items(reciter):
    counts = c.chapter_verse_counts()
    for ch, vs in SET.items():
        text = c.chapter_text(ch, counts[ch])
        paths = c.fetch_audio(reciter, ch, vs)
        for v in vs:
            if v in paths:
                yield ch, v, text[v], paths[v]


def cmd_align(reciters, model):
    import aligners
    import timing
    al = aligners.make(model)
    for r in reciters:
        out = {}
        for ch, v, tx, path in items(r):
            wav, dur = c.decode(path)
            src = "ar_" if len(c.words_of(tx["ar"])) == len(c.words_of(tx["ar_"])) else "ar"
            words = c.words_of(tx[src])
            spans, score, reps = aligners.run(al, wav, words)
            snapped = []
            ms0 = timing.to_ms(spans, wav, dur, snap=True, lead=0.0, snapped=snapped)
            out[f"{ch}:{v}"] = {"spans": [list(map(int, s)) for s in spans], "ms0": ms0, "snapped": snapped,
                                "dur": dur, "src": src, "repeats": reps}
        CAL.mkdir(parents=True, exist_ok=True)
        (CAL / f"{r}.json").write_text(json.dumps(out))
        print(r, len(out), "verses aligned", flush=True)


def _clip_cer(judge, wav, a, b, word, B):
    a, b = max(0, a), max(a + 40, b)
    clip = wav[int(a * 16):int(b * 16)]
    ref = B._norm(judge.target_text(word))
    if not ref:
        return 0, 0
    if len(clip) < 800:
        return len(ref), len(ref)
    ids = judge.emissions(clip).argmax(-1).tolist()
    hyp, prev = [], None
    for t in ids:
        if t != prev and t != judge.blank:
            hyp.append(t)
        prev = t
    inv = judge.proc.tokenizer.convert_ids_to_tokens(hyp)
    h = B._norm("".join(x for x in inv if len(x) == 1))
    return B._lev(ref, h), len(ref)


def cmd_judge(reciters, judge_name):
    import aligners
    import benchmark as B
    J = aligners.make(judge_name)
    for r in reciters:
        cal = json.loads((CAL / f"{r}.json").read_text())
        rows = []  # per boundary: verse, k, snapped, gap_ms, errs per shift, letters
        for ch, v, tx, path in items(r):
            d = cal.get(f"{ch}:{v}")
            if not d:
                continue
            wav, _ = c.decode(path)
            words = c.words_of(tx[d["src"]])
            ms = d["ms0"]
            for k in range(1, len(ms)):
                b = ms[k][0]
                lo, hi = ms[k - 1][0], ms[k][1]
                errs = []
                for sh in SHIFTS:
                    e1, t1 = _clip_cer(J, wav, lo, b + sh, words[k - 1], B)
                    e2, t2 = _clip_cer(J, wav, b + sh, hi, words[k], B)
                    errs.append(e1 + e2)
                rows.append({"verse": f"{ch}:{v}", "k": k, "snapped": d["snapped"][k - 1], "letters": t1 + t2,
                             "errs": errs})
        (CAL / f"{r}.{judge_name}.json").write_text(json.dumps({"shifts": SHIFTS, "rows": rows}))
        print(r, judge_name, len(rows), "boundaries judged", flush=True)
        _summary(r, judge_name)


def _best(rows):
    E = np.array([x["errs"] for x in rows], float)
    T = sum(x["letters"] for x in rows)
    curve = E.sum(0) / max(T, 1)
    return curve


def _per_boundary_best(rows):
    """Per boundary, the shift (ms) with the fewest errors (centre of ties)."""
    out = []
    for x in rows:
        e = np.array(x["errs"])
        idx = np.flatnonzero(e == e.min())
        if len(idx) == len(e):
            continue  # judge can't tell
        out.append(float(np.mean([SHIFTS[i] for i in idx])))
    return np.array(out)


def _summary(r, judge_name, lead_ms=None):
    f = CAL / f"{r}.{judge_name}.json"
    if not f.exists():
        return
    rows = json.loads(f.read_text())["rows"]
    parts = []
    for name, sel in (("all", rows), ("pause", [x for x in rows if x["snapped"]]),
                      ("ctc", [x for x in rows if not x["snapped"]])):
        if not sel:
            continue
        curve = _best(sel)
        i = int(np.argmin(curve))
        # parabolic refinement around the minimum
        best = SHIFTS[i]
        if 0 < i < len(curve) - 1:
            y0, y1, y2 = curve[i - 1:i + 2]
            den = y0 - 2 * y1 + y2
            if den > 0:
                best = SHIFTS[i] + 0.5 * (y0 - y2) / den * (SHIFTS[1] - SHIFTS[0])
        pb = _per_boundary_best(sel)
        parts.append(f"{name}: n={len(sel)} best {best:+.0f}ms cer {curve[i]:.3f} (0ms {curve[SHIFTS.index(0)]:.3f}, "
                     f"-80 {curve[SHIFTS.index(-80)]:.3f}) per-boundary median {np.median(pb):+.0f}")
        if lead_ms is not None and len(pb):
            err = np.abs(pb + lead_ms)
            parts[-1] += f" | at lead {lead_ms}: |err| median {np.median(err):.0f} p90 {np.percentile(err, 90):.0f}"
    print(f"{r:10s} {judge_name:10s} " + " ;; ".join(parts), flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["align", "judge", "report"])
    ap.add_argument("--reciters", nargs="+", default=c.RECITERS, choices=c.RECITERS)
    ap.add_argument("--judge", default="xlsr_ar")
    ap.add_argument("--model", default="quran_xlsr+auto")
    a = ap.parse_args()
    if a.cmd == "align":
        cmd_align(a.reciters, a.model)
    elif a.cmd == "judge":
        cmd_judge(a.reciters, a.judge)
    else:
        import timing
        for j in ("xlsr_ar", "quran_xlsr"):
            for r in a.reciters:
                _summary(r, j, lead_ms=round(timing.lead_for(r) * 1000) if hasattr(timing, "lead_for") else 80)


if __name__ == "__main__":
    main()
