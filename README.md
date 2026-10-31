# Holy Quran

Read and listen to the Holy Quran, verse by verse, with recitation that flows from one verse to
the next without a pause.

**Open the app:** https://ahmadharis.github.io/quranapp/

It works in any modern browser on phone, tablet and desktop, and can be installed to the home
screen as an app.

## What it does

### Read
- The Arabic text in the Khat-e-Manzoor script, with the Manzoor Naskh font.
- Tap any verse to play from it, bookmark it or copy it.
- **Nazira mode:** the Arabic only, the verses flowing together like a printed page.
- Part (juz) and quarter markers in the text.
- Optional translations and commentaries shown under each verse, in the order you choose:
  English (Maulawi Sher Ali, Muhammad Zafrulla Khan, Short Commentary, Five Volume Commentary),
  Urdu (Hazrat Mirza Tahir Ahmad rh, Tafseer-e-Saghir), and French, Spanish, German, Italian,
  Bangla, Chinese, Norwegian, Swedish, Hebrew and Myanmar.
- Word-by-word meanings in English or Urdu, and an introduction for each chapter.

### Listen
- Recitation by Qari Muhammad Ashiq, Maulana Feroz Alam, Aiman Almaliki, Mishary Rashid
  AlAfasy and Idir Iken.
- Verses join seamlessly into one continuous recitation, across chapters too.
- Each word lights up as it is recited, in Read and in Listen.
- A Listen view with only the Arabic and the player, made to be read at a glance.
- Keeps playing with the screen off until you pause; play, pause and previous/next verse from
  the lock screen, headphones and the car.
- Repeat a verse, and play at 0.75×, 1× or 1.25×.

### Find your place
- Go to any chapter, part or verse from one place: search by name, number, `36:58` or `part 30`.
- Continue where you left off, and keep bookmarks on your device.

### Make it yours
- Light, dark or automatic appearance, and adjustable text size.
- Larger screens add a contents sidebar and a panel with the current word's meaning and the
  chapter introduction; both can be hidden.
- Full keyboard support (press `?` in the app for the shortcuts).
- Reading works offline for chapters you have opened.

## Where everything comes from

Everything in the app comes from alislam.org.

| What | Source |
|---|---|
| Arabic text, translations, commentaries, word meanings, chapter introductions | `api.readquran.app`, the service behind alislam.org's Quran app ([alislam.org/quran/app](https://www.alislam.org/quran/app/)) |
| Chapter list, parts and part markers | alislam.org's Quran app |
| Recitation | `files.alislam.cloud`, alislam.org's audio library, streamed verse by verse |
| Manzoor Naskh font (Khat-e-Manzoor), `assets/fonts/ManzoorNaskh.ttf` | alislam.org's Quran app |
| Word-by-word timings, `data/words/<reciter>/<chapter>.json` | Measured from alislam.org's recitation and verse text, so each word can be highlighted as it is recited |

Verse numbers follow alislam.org's Quran.
