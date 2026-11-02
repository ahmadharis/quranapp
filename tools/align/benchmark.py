"""Compare aligners on real verses (no ground truth exists, so three proxies are used):

1. Pause hit rate - recitation pauses only between words, so every internal silence >= 150 ms
   should contain a word boundary (raw aligner output, no energy snapping, so it is fair).
2. Boundary distance to the pause's end (the next word's onset), for the pauses hit.
3. Pairwise agreement between models: median |boundary difference| per word.
Plus mean CTC token confidence, automatic-check failures and run time.

    python -I benchmark.py --models mms_fa xlsr_ar quran_xlsr --reciter feroz
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

import aligners  # noqa: E402
import common as c  # noqa: E402
import timing  # noqa: E402

def _norm(s: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFC", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn" and ch not in "|-ـ ")
    return s.translate(str.maketrans("ٱأإآىة", "اااايه"))


def _lev(a: str, b: str) -> int:
    d = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        p, d[0] = d[0], i
        for j, y in enumerate(b, 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (x != y))
    return d[-1]


def judge_cer(judge, wav, words_ms, words, shift_ms=0):
    """Cut each word's clip and let an independent recogniser transcribe it (greedy CTC).
    Letter error rate vs the word: a misplaced boundary moves letters between clips."""
    import torch
    errs = tot = 0
    for (a, b), w in zip(words_ms, words):
        a, b = a + shift_ms, b + shift_ms
        a, b = max(0, a), max(a + 40, b)
        clip = wav[int(a * 16):int(b * 16)]
        ref = _norm(judge.target_text(w))
        if len(clip) < 800 or not ref:
            errs += len(ref); tot += len(ref); continue
        ids = judge.emissions(clip).argmax(-1).tolist()
        hyp, prev = [], None
        for t in ids:
            if t != prev and t != judge.blank:
                hyp.append(t)
            prev = t
        inv = judge.proc.tokenizer.convert_ids_to_tokens(hyp)
        h = _norm("".join(x for x in inv if len(x) == 1))
        errs += _lev(ref, h); tot += len(ref)
    return errs, tot


SET = {1: range(1, 8), 2: list(range(1, 7)) + [256, 283], 3: [1, 2], 19: [2], 24: [36], 36: [2],
       73: [21], 78: range(1, 13), 98: [6], 103: range(1, 5), 108: range(1, 5), 112: range(1, 6),
       114: range(1, 8)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["mms_fa", "xlsr_ar", "quran_xlsr"])
    ap.add_argument("--reciter", default="feroz")
    ap.add_argument("--source", default="ar_", choices=["ar_", "ar"])
    ap.add_argument("--judges", nargs="*", default=["quran_xlsr", "xlsr_ar"])
    ap.add_argument("--shifts", default="-200,-100,-40,0,40,100,200",
                    help="ms added to every start when judging (finds a systematic offset)")
    a = ap.parse_args()
    counts = c.chapter_verse_counts()
    items = []
    for ch, vs in SET.items():
        text = c.chapter_text(ch, counts[ch])
        paths = c.fetch_audio(a.reciter, ch, vs)
        for v in vs:
            wav, dur = c.decode(paths[v])
            items.append((ch, v, text[v], wav, dur))
    out_dir = c.WORK / "bench" / a.reciter
    out_dir.mkdir(parents=True, exist_ok=True)
    res = {}
    for m in a.models:
        al = aligners.make(m)
        t0, audio_s = time.time(), 0.0
        per = {}
        for ch, v, tx, wav, dur in items:
            words = c.words_of(tx[a.source])
            spans, score, reps = aligners.run(al, wav, words)
            raw = timing.to_ms(spans, wav, dur, snap=False)
            snp = timing.to_ms(spans, wav, dur, snap=True)
            n, hit, err = timing.pause_metrics(raw, wav)
            per[f"{ch}:{v}"] = {"raw": raw, "snap": snp, "score": score, "repeats": reps, "pauses": n, "hit": hit,
                                "err": err, "problems": timing.check(snp, len(c.words_of(tx["ar"])), dur, wav)}
            audio_s += dur
        el = time.time() - t0
        P = sum(x["pauses"] for x in per.values())
        H = sum(x["hit"] for x in per.values())
        E = [e for x in per.values() for e in x["err"]]
        res[m] = {"model_id": al.model_id or m, "verses": per, "pauses": P, "hits": H,
                  "hit_rate": H / max(P, 1), "median_err_ms": float(np.median(E)) if E else None,
                  "mean_score": float(np.mean([x["score"] for x in per.values()])),
                  "problem_verses": [k for k, x in per.items() if x["problems"]],
                  "sec": el, "audio_sec": audio_s}
        print(f"{m:16s} pauses {H}/{P} hit {H / max(P, 1):.3f}  median|b-onset| {res[m]['median_err_ms']}ms  "
              f"score {res[m]['mean_score']:.3f}  problems {len(res[m]['problem_verses'])}  "
              f"{el:.0f}s for {audio_s:.0f}s audio", flush=True)
        del al
    ms = list(res)
    print("\nJudge: per-word clip letter error rate (lower = boundaries enclose the right letters)")
    judges = {}
    for jn in a.judges:
        J = aligners.make(jn)
        for m in ms:
            row = {}
            for sh in map(int, a.shifts.split(",")):
                E = T = 0
                for ch, v, tx, wav, dur in items:
                    e, t = judge_cer(J, wav, res[m]["verses"][f"{ch}:{v}"]["snap"], c.words_of(tx[a.source]), sh)
                    E += e; T += t
                row[sh] = E / T
            judges[f"{jn}|{m}"] = row
            print(f"  judge {jn:11s} on {m:14s}: " + "  ".join(f"{k:+d}:{x:.3f}" for k, x in row.items()), flush=True)
        del J
    print("\nPairwise median |boundary diff| (ms) over all internal boundaries, raw / snapped:")
    agree = {}
    for i in range(len(ms)):
        for j in range(i + 1, len(ms)):
            for kind in ("raw", "snap"):
                d = []
                for k in res[ms[i]]["verses"]:
                    A = [x[0] for x in res[ms[i]]["verses"][k][kind][1:]]
                    B = [x[0] for x in res[ms[j]]["verses"][k][kind][1:]]
                    d += [abs(x - y) for x, y in zip(A, B)]
                agree[f"{ms[i]}~{ms[j]}:{kind}"] = {"median": float(np.median(d)), "p90": float(np.percentile(d, 90)),
                                                    "within100": float(np.mean(np.array(d) <= 100))}
                print(f"  {ms[i]} vs {ms[j]} [{kind}]: median {np.median(d):.0f}  p90 {np.percentile(d, 90):.0f}  "
                      f"<=100ms {np.mean(np.array(d) <= 100):.2f}")
    (out_dir / f"bench_{'_'.join(ms).replace('+', '-')}_{a.source}.json").write_text(json.dumps({"models": res, "agreement": agree, "judges": judges}))


if __name__ == "__main__":
    main()
