# Word timings (offline forced alignment)

Builds `data/words/{reciter}/{ch}.json`: the start and end of every Arabic word in alislam.org's
per-verse recitation MP3s, so the app can highlight each word as it is recited. Runs offline on a
Mac (Apple Silicon, PyTorch on MPS) with free, open tools. The output is static JSON for GitHub
Pages. No server, no paid API.

## Setup

Keep the virtualenv, model caches and audio **outside the repo**. `ALIGN_WORK` holds the text
cache, audio cache, reports, benchmark results and plots (default `~/.cache/quranapp-align`).

```sh
export ALIGN_WORK=~/.cache/quranapp-align          # or any folder outside the repo
export HF_HOME=$ALIGN_WORK/hf TORCH_HOME=$ALIGN_WORK/torch
python3.12 -m venv $ALIGN_WORK/venv
$ALIGN_WORK/venv/bin/pip install -r tools/align/requirements.txt
```

ffmpeg comes from the `imageio-ffmpeg` wheel, so Homebrew isn't needed. The model
(~1.2 GB) downloads on first use. Always run with `python -I`, because the scripts read
downloaded files.

## Usage

```sh
cd tools/align
PY="$ALIGN_WORK/venv/bin/python -I"

$PY align.py                                   # everything missing: all reciters, pilot order
$PY align.py --reciters feroz --chapters 1,78-114
$PY align.py --reciters feroz --chapters 2 --force   # redo a chapter
$PY validate.py                                # check every output file, print stats
$PY plot.py --reciter feroz --verses 1:7 2:2 98:6    # PNGs in $ALIGN_WORK/plots/
$PY benchmark.py --models mms_fa xlsr_ar quran_xlsr  # model comparison
```

`align.py` is resumable. It skips a chapter whose JSON already exists with the same `model` and
all of its verses, and writes each file atomically, so you can stop it at any point and run the
same command again. Order: reciters `feroz, rashid, ashiq, aiman, idir-iken`; chapters
1, 78–114, then 2–77. It prints the time per chapter and an ETA as it goes. MP3s are deleted
after each chapter unless you pass `--keep-audio`. Per-verse check reports go to
`$ALIGN_WORK/reports/{reciter}/{ch}.json`.

Sources and politeness: text comes from `POST https://api.readquran.app/chapter/{ch}:{a}-{b}`
in batches of 10 verses. Each batch is two calls, because `f:1` returns only `ar` and `f:2`
returns only `ar_`. Text is cached on disk, so each verse is fetched once. Audio comes from
`https://files.alislam.cloud/audio/tilawat/{reciter}/{CCC}-{VVV}-AR.mp3` with at most 4 requests
in flight, cached on disk. The next chapter downloads while the current one aligns. Verse counts
come from the app's `js/quran-data.js` (alislam's list, 6,348 verses).

## Output format

```json
{"reciter":"feroz","ch":1,"source":"ar_","model":"rabah2026/wav2vec2-large-xlsr-53-arabic-quran-v_final+auto",
 "verses":{"1":[[642,1460],[1460,4640],[4640,8720],[8720,15312]], "2":[...]}}
```

- **Verses** use alislam numbering (the Bismillah is verse 1, except in chapter 9).
- **Words** follow the app's rule exactly. `ar` (Indo-Pak) is split on whitespace, and a token is
  a WORD if it contains a letter in U+0621–064A, U+066E–06D3, U+06D5 or U+06FA–06FC. Pause marks,
  `﴿۲﴾` ornaments and digits are not words. Each verse has one `[start, end]` per WORD, in order.
- **Contiguous.** A word's end is the next word's start, so a pause belongs to the word before it.
  The first start is ≥ 0, every word is at least 20 ms long, and the last end runs to the end of
  speech and is ≤ the file's duration.
- **`source`** is `ar_` because the aligner is given the Uthmanic text. Alislam's `ar_` has the
  same WORD count as `ar` in 6,339 of 6,348 verses. The other 9 (4:79, 7:197, 25:50, 27:37,
  31:28, 37:131, 46:34, 72:17, 75:41) split or join a word differently, so those verses are
  aligned on `ar` instead and listed in an extra key, `"ar_fallback": [79]`. Either way the spans
  always index the words of `ar`.
- **Size:** about 15 bytes per word. That is ~1.2 MB per reciter (77,887 words) uncompressed and
  ~0.55 MB gzipped.

### Timing reference (important for the player)

Times are **integer milliseconds from sample 0 of the full, untrimmed decode of the original MP3**:

- Decoding uses `ffmpeg -flags2 +skip_manual`, which stops ffmpeg from applying the LAME/Info
  gapless trim. The output is then resampled to 16 kHz mono.
- Sample 0 is the first sample the decoder outputs for the **first audio frame**. The Xing/Info
  frame is metadata and not counted, which matches `js/mp3.js`.
- The **encoder delay + 529 samples of decoder delay are included** at the start, and the encoder
  padding at the end. Decoded length = frames × 1152, so duration = frames × 1152 / sample rate.
  This was verified on feroz 1:2: 580 frames, 668,160 samples at 48 kHz = 13.920 s. The default
  trimmed decode is 666,054 samples, starting 1,105 samples (576 + 529) later.
- So the player converts times onto its trimmed timeline with
  `t_trimmed = t_ms/1000 − skipStart/sampleRate`, using `skipStart = encoderDelay + 529` from
  `extractFrames()` (for feroz: 1,105 / 48,000 = 23.0 ms; aiman has no Info header, so only 529).

## How it works

1. Emissions come from a wav2vec2 CTC model on 16 kHz audio, in 20 ms frames. Long verses are
   processed in 30 s windows with 2 s of context on each side.
2. The model is aligned to the verse's words with Viterbi forced alignment
   (`torchaudio.functional.forced_align`). Letters are mapped into the model's vocabulary for the
   aligner only (for example `ۡ` → `ْ`, and Indo-Pak `ی ہ ک` → `ي ه ك`); the displayed text is
   never changed.
3. **Repeats.** Reciters (feroz especially) often pause in long verses and resume a few words
   back, e.g. 98:6 "… مخلصين له الدين ‖ مخلصين له الدين حنفاء …". The long-context model emits
   blanks over the repeated phrase, so plain alignment stretches one word across it. That put
   "له" over 8 s in 98:6. With `+auto`, a repeat-aware Viterbi on short windows (6 s + 1 s)
   checks every verse first. From the end of any word it may jump back up to 12 words. When it
   finds a repeat, its result is used. A word's start is then its **first** recitation, and while
   the reciter repeats, the highlight stays on the furthest word reached. The per-word JSON
   format cannot express a repeat, so this is a limitation of the format.
4. Boundaries are snapped to the end of any silence between two words, which is the next word's
   onset. Every start is then moved **earlier by the reciter's lead** (`timing.LEADS`: 80 ms for feroz and
   ashiq, 60-65 ms for the others, see "Per-reciter calibration"), because CTC onsets run late. The last word runs to the end of
   speech, because CTC fires early on the last letter and a held madd can last seconds.
5. Automatic checks run on every verse: word count, monotonic and contiguous spans, no empty
   words, no word over 12 s (except a lone muqatta'at verse), start within 400 ms of speech
   onset, end at speech end, and model confidence. `validate.py` re-checks every file.

## Per-reciter calibration (lead)

The 80 ms lead was tuned on feroz. `calibrate.py` measures it per reciter on a 69-verse sample
(chapter 1; 2:1-6, 2:256, 2:283; muqatta'at 2:2, 3:2, 19:2, 36:2; 24:36; 67:1-5; 73:21; 78:1-12;
87:1-10; 98:6; 103; 108; 112; 114). For every internal boundary, the two words beside it are
cut at the boundary shifted by -240...+140 ms and transcribed by two judges (`xlsr_ar`,
`quran_xlsr`). The best shift comes from the summed letter-error curve and from the
per-boundary minima. The two estimators differ by 10-20 ms, and each has a 90 % CI of about
+/-30 ms. Leads are set relative to feroz, averaging both estimators:

| reciter | aggregate optimum | per-boundary optimum | vs feroz | lead |
|---|---|---|---|---|
| feroz | -77 | -74 | 0 | 80 |
| ashiq | -84 | -74 | -3 | 80 |
| rashid | -46 | -63 | +21 | 60 |
| aiman | -49 | -63 | +20 | 60 |
| idir-iken | -54 | -67 | +15 | 65 |

The leads live in `timing.LEADS`. `align.py` uses them (`--lead-ms` overrides) and writes
`"lead_ms"` into every file; the app ignores it. `adjust.py` applies a new lead to existing files
without re-aligning, by shifting every start. The only difference from a re-run is that a first
word's start clamped at 0 stays at 0.

    $PY calibrate.py align --reciters rashid      # sample audio: ALIGN_AUDIO=<dir> to keep it
    $PY calibrate.py judge --reciters rashid --judge xlsr_ar   # and --judge quran_xlsr
    $PY calibrate.py report
    $PY adjust.py --reciters rashid aiman idir-iken

## Choosing the model (benchmark, feroz, 59 verses / 20 min of audio)

There is no ground truth, so two independent measures were used. The test set covers chapter 1;
2:1–6, 2:256 and 2:283 (128 words, 3.6 min); the muqatta'at 2:2, 3:2, 19:2 and 36:2; 24:36;
73:21; 78:1–12; 98:6; 103; 108; 112; and 114.

- **Judge letter error rate.** Each word's clip is cut out using the aligner's boundaries and
  transcribed in isolation by a recogniser. A misplaced boundary moves letters into the wrong
  clip. `xlsr_ar` is the independent judge; `quran_xlsr` is a stronger judge but is biased
  towards itself.
- **Agreement.** The models are compared with each other, and with ASR of the cropped audio
  where they disagree.

| aligner | judge xlsr_ar (−80 ms / 0) | judge quran_xlsr (−80 / 0) | role in disagreements > 250 ms |
|---|---|---|---|
| `mms_fa` (Meta MMS-300m FA, uroman) | 0.569 / 0.593 | 0.269 / 0.276 | outlier in 20 of 24 |
| `xlsr_ar` (jonatasgrosman) | 0.529* / 0.590* | 0.223* / 0.269* | outlier in 3 |
| **`quran_xlsr`** (rabah2026, Quran-trained) | **0.555 / 0.605** | **0.234 / 0.269** | **never the outlier** |
| `quran_xlsr+auto` (production) | 0.554 / 0.603 | — | finds the repeats in 2:283 (2), 24:36 (2), 73:21, 98:6 |

\* The `xlsr_ar` row comes from the first, smaller run (49 verses); the other rows come from the
59-verse run.

The judge scores of all three models are close; the boundaries agree to a median of 20 ms (one
frame), and 90–95 % agree within 100 ms. The real differences are gross errors. In 2:283,
`mms_fa` and `xlsr_ar` misplace whole phrases by 3–9 s, while `quran_xlsr` was never the odd one
out, and cropped-audio ASR confirmed its placements. `quran_xlsr` also has the highest token
confidence (0.82 against 0.75 and 0.53). Applying the −80 ms shift improves every model; the
error curve is flat between −60 and −120 ms. **Estimated boundary accuracy:** independent models typically agree to within one 20 ms frame, so the typical error is on that order. A systematic offset of ±20–40 ms may remain after the lead. The three models disagreed by more than 250 ms at 24 of 264 boundaries (9 %), 19 of them in 2:283. `mms_fa` was the outlier in 20 of those, `xlsr_ar` in 3, `quran_xlsr` in none, and 1 had no majority. The chosen model's rate of gross errors cannot be measured without ground truth; the hand-check PNGs are there to judge it. Whisper-based models (Tarteel `whisper-base-ar-quran`) were
considered but not used: Whisper's word timestamps come from attention, not frame-level CTC
paths, and are coarser.

Speed: about 0.2 s of compute per verse (≈ 25 min of compute per reciter). Downloads are the
bottleneck: feroz files are ~500 KB per verse (≈ 3 GB per reciter, 30–70 min); the other
reciters are 50–180 KB per verse.

## Licences and terms

The owner's decision: the app is free and non-commercial, so non-commercial model licences are
acceptable; credit wherever a licence asks for it.

| Component | Used for | Code licence | Weights / data licence | Restrictions / attribution | Publishing derived word timings? |
|---|---|---|---|---|---|
| **rabah2026/wav2vec2-large-xlsr-53-arabic-quran-v_final** (chosen) | aligner | via transformers (Apache-2.0) | **Apache-2.0** (model card). Fine-tuned from jonatasgrosman/xlsr-53-arabic. Training set rabah2026/Quran-Ayah-Corpus, declared Apache-2.0, built from Al-Quran.cloud and EveryAyah.com recitations | Keep the licence notice; credit in README. The training audio's own rights are not stated by its sources, which is a provenance caveat and no restriction on us | Yes. Apache-2.0 places no limits on outputs |
| facebook/wav2vec2-large-xlsr-53 (base of the above) | — | — | Apache-2.0 | — | Yes |
| jonatasgrosman/wav2vec2-large-xlsr-53-arabic | benchmark, judge | — | Apache-2.0 (Common Voice 6.1 CC0, Arabic Speech Corpus) | Credit | Yes |
| torchaudio `MMS_FA` (Meta MMS-300m forced aligner) | benchmark only | torchaudio BSD-2-Clause | **CC-BY-NC 4.0** | Non-commercial, attribution | Allowed for a non-commercial site with credit, but not used for the output |
| ctc-forced-aligner (not run) | — | BSD-2-Clause | default model MahmoudAshraf/mms-300m-1130-forced-aligner **CC-BY-NC 4.0** | Same as MMS | — |
| tarteel-ai/whisper-base-ar-quran (not run) | — | — | Apache-2.0 | — | — |
| PyTorch 2.15 | runtime | BSD-3-Clause (plus bundled permissive licences) | — | — | Yes |
| torchaudio 2.11 | forced_align | BSD-2-Clause | — | — | Yes |
| transformers 5.22, huggingface_hub 2.4 | model loading | Apache-2.0 | — | — | Yes |
| numpy | maths | BSD-3-Clause | — | — | Yes |
| imageio-ffmpeg 0.7 (bundled FFmpeg 7.1 binary) | MP3 decoding | wrapper BSD-2-Clause; FFmpeg binary LGPL/GPL | — | Used locally as a tool; nothing of FFmpeg is distributed | Yes. GPL does not reach program output |
| uroman 1.3 | MMS romanisation (benchmark) | MIT-style (USC ISI) | — | Keep the notice | Yes |
| matplotlib, arabic-reshaper (MIT), python-bidi (LGPL-3.0) | PNG plots (local) | permissive / LGPL | — | — | n/a |
| Noto Naskh Arabic (assets/fonts) | plot labels (local) | — | SIL OFL 1.1 | — | n/a |

Suggested credit line for the app's README or about page: *"Word timings computed with
wav2vec2-large-xlsr-53-arabic-quran (rabah2026, Apache-2.0), fine-tuned from Jonatas Grosman's
XLSR-53 Arabic model (Apache-2.0) and Meta's XLSR-53 (Apache-2.0), aligned with torchaudio
(BSD)."*

The recitation and verse text come from alislam.org; requests are cached and kept light (10
verses per call, at most 4 downloads at a time).
