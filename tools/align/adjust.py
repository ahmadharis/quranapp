"""Apply a reciter's calibrated lead (timing.LEADS) to existing data/words files, without
re-aligning: every word start moves by (old lead - new lead) ms; the last word's end stays at
the end of speech. The file records the lead it now carries as "lead_ms" (files without it were
made with the original 80 ms). Same JSON otherwise (verses, missing, ar_fallback, model).

    python -I adjust.py --reciters rashid ashiq aiman idir-iken
    python -I adjust.py --reciters rashid --lead-ms 50 --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common as c  # noqa: E402

OLD_DEFAULT = 80  # timing.LEAD, used by every file written before "lead_ms" existed


def shift_verse(ws: list[list[int]], delta: int) -> list[list[int]]:
    """Move every start by `delta` ms (later if positive), keeping the spans contiguous, every
    word >= 20 ms where possible and the last end unchanged. A start at 0 (clamped when it was
    made) stays at 0: the true unclamped value is unknown and lighting from 0 is harmless."""
    end = ws[-1][1]
    starts = [s if (s == 0 and delta > 0) else max(0, s + delta) for s, _ in ws]
    for i in range(1, len(starts)):
        starts[i] = max(starts[i], starts[i - 1] + 20)
    # keep room before the fixed last end: pull back from the end if shifting crowded it
    lim = end - 20
    for i in range(len(starts) - 1, -1, -1):
        if starts[i] > lim:
            starts[i] = max(lim, 0)
        lim = starts[i] - 20
    for i in range(1, len(starts)):  # tiny verses: never decreasing
        starts[i] = max(starts[i], starts[i - 1])
    edges = starts + [end]
    return [[edges[i], edges[i + 1]] for i in range(len(starts))]


def main():
    import timing
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reciters", nargs="+", required=True, choices=c.RECITERS)
    ap.add_argument("--lead-ms", type=int, help="override timing.LEADS")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    for r in a.reciters:
        new = a.lead_ms if a.lead_ms is not None else round(timing.lead_for(r) * 1000)
        n_files = n_words = 0
        for p in sorted((c.REPO / "data" / "words" / r).glob("*.json"), key=lambda p: int(p.stem)):
            j = json.loads(p.read_text())
            old = j.get("lead_ms", OLD_DEFAULT)
            if old == new:
                continue
            delta = old - new
            j["verses"] = {v: shift_verse(ws, delta) if ws else ws for v, ws in j["verses"].items()}
            out = {k: j[k] for k in ("reciter", "ch", "source", "model")}
            out["lead_ms"] = new
            out["verses"] = j["verses"]
            for k in j:
                if k not in out:
                    out[k] = j[k]
            n_files += 1
            n_words += sum(len(ws) for ws in j["verses"].values())
            if not a.dry_run:
                tmp = p.with_suffix(".tmp")
                tmp.write_text(json.dumps(out, separators=(",", ":")))
                tmp.replace(p)
        print(f"{r}: lead {new} ms, {n_files} files / {n_words} words {'would change' if a.dry_run else 'updated'}")


if __name__ == "__main__":
    main()
