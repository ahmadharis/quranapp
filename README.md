# Quran App

A web app to read and listen to the Holy Quran, hosted on GitHub Pages.

## Where the data comes from

| Asset | Source |
|---|---|
| Arabic text, translations, commentaries, word-by-word meanings, chapter introductions, topics index, search | `api.readquran.app` — the API behind alislam.org's official Quran app ([alislam.org/quran/app](https://www.alislam.org/quran/app/)) |
| Chapter list, part (juz) markers | alislam.org's Quran app |
| Recitation audio (per verse) | `files.alislam.cloud/audio/tilawat/<reciter>/<chapter>-<verse>-AR.mp3` |
| Translation audio (per verse) | `files.alislam.cloud/audio/tilawat/<translation>/<chapter>-<verse>-<EN\|UR>.mp3` |
| Verse images (Persian script) | `files.alislam.cloud/quran/verses/<chapter>-<verse>.png` |
| Manzoor Naskh font | alislam.org's Quran app assets |
| Other Arabic fonts (Noorehuda, KFGQPC Uthmanic Hafs) | alislam.org's Quran app assets |
| Urdu font (Jameel Noori Nastaleeq) | `alislam.org/urdu/fonts/` |
| Amiri, Noto Naskh Arabic fonts | [Google Fonts](https://fonts.google.com/) |
| Word-by-word timings (`data/words/<reciter>/<chapter>.json`) | Generated from alislam.org's recitation audio and verse text by forced alignment with [rabah2026/wav2vec2-large-xlsr-53-arabic-quran-v_final](https://huggingface.co/rabah2026/wav2vec2-large-xlsr-53-arabic-quran-v_final) (Apache-2.0) |

Verse numbering follows alislam.org's Quran (6,348 verses): the Bismillah is verse 1 of every
chapter except At-Taubah (chapter 9), so Al-Baqarah has 287 verses. This matches the audio files
exactly. See [why the Bismillah is counted as the first verse](https://www.alislam.org/articles/why-is-bismillahir-rahmanir-raheem-counted-as-first-verse/).

## Files

- `data/words/<reciter>/<chapter>.json` — start and end time (ms) of each word of each verse,
  measured from the start of that verse's audio file, so recitation can highlight word by word.

- `assets/fonts/ManzoorNaskh.ttf` — Arabic font (Khat-e-Manzoor) from alislam.org's Quran app.

## Acknowledgements

The choice of sources was informed by [Quran Memoriser](https://github.com/drhammadkhan/quran-memoriser),
which builds on the same alislam.org assets.
