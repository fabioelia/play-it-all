# CleanCut

**Watch any show at the rating you choose.** CleanCut is a browser extension
that runs on top of Netflix, Prime Video, YouTube, Disney+, HBO Max, Hulu,
Apple TV, Paramount+, Peacock, Crunchyroll, Tubi, Pluto TV, The Roku Channel,
Plex and Vimeo (and any page with a `<video>`; see [Supported sites](#supported-sites)).
It recognizes what's playing, looks up timestamped content tags, and **skips,
mutes or hides the picture of** the scenes above your chosen rating. Take *Game of Thrones*
and watch an R, PG-13, PG or G cut of it.

It has three parts:

| Part | What it does | Where |
| --- | --- | --- |
| **Browser extension** (Chrome / Edge / Firefox, Manifest V3) | Identifies the title, applies your rating, scans the episode's subtitles ahead of playback, lets you tag scenes while you watch | [`extension/`](extension) |
| **Community server** (Node + built-in SQLite, zero runtime dependencies) | Stores tags, votes, accounts and published skip lists, and serves a small web hub | [`server/`](server) |
| **Scanner CLI** (`cleancut-scan`) | Runs lightweight vision models over video files offline and publishes machine-detected segments | [`scanner/`](scanner) |

<p>
  <img src="docs/overlay.png" alt="Demo player: on the right edge, a toast reads 'Skipped 0:10 · violence (strong)' with an Undo button, above the CleanCut badge and the Flag scene control; a coloured strip of cuts runs along the bottom" width="62%">
  <img src="docs/popup.png" alt="Extension popup: what is playing with its rating, cut count and time skipped, the rating buttons Uncut/R/PG-13/PG/G/Custom, the list of cuts in this episode (the one already played marked Earlier), and a button to flag a scene on the player" width="30%">
</p>

They share one core ([`shared/`](shared)): the content taxonomy, the rating
presets, the decision engine, subtitle parsing and the subtitle analyzer.

---

## How it works

```
                 ┌───────────────────────── browser tab (netflix.com / primevideo.com / …) ──────────────────────────┐
                 │                                                                                                    │
 player's own    │  page-hook.js (page world)            content script                                              │
 network calls ──┼─▶ sees manifest / metadata JSON ──────▶ identify title ──▶ lookup ─────────────┐                  │
                 │   fetches full English SDH subtitles ─▶ analyzer: profanity + [sound cues] ─────┤                  │
                 │   Netflix seek bridge ◀──────────────── engine: decide(t) every 100 ms ◀── plan ◀┘                  │
                 │                                          │ skip → seek past   mute → video.muted   hide → dark video │
                 └──────────────────────────────────────────┼─────────────────────────────────────────────────────────┘
                                                            ▼
                                   background worker ──▶ community API (/v1/lookup, /v1/segments, /v1/profiles)
                                                            ▲
                                   cleancut-scan (offline): ffmpeg frames → ONNX classifier → segments ─┘
```

1. **Identify.** Each platform adapter works out what is playing. Netflix uses
   the `/watch/<id>` URL plus the player's metadata response, Prime uses the
   episode ASIN from its playback-resources response, YouTube the video id
   plus the player response (title, channel), the other services the id in
   their watch-page address plus the player's markup or the page's JSON-LD,
   and any other site `<meta name="cleancut:*">` tags or the URL. Each title also gets a
   *canonical key* (`game-of-thrones/s01e01`), so tags made on one platform
   can be offered on another.
2. **Gather segments** from these sources:
   - **Community tags:** humans marked a scene with a category and severity.
   - **Your own tags:** flagged on the player while watching (**Flag scene**, or `Alt+[` / `Alt+]`).
   - **Scan-ahead:** the subtitle track is analyzed the moment the player
     downloads it, before the scenes play (see below).
   - **Listening ahead** (opt-in, for videos without captions on sites that
     don't encrypt their audio): the audio the player has buffered is
     transcribed on your computer and swearing muted before it plays (see below).
3. **Plan.** Your profile sets the highest severity allowed per category. Every
   segment above it becomes an action (skip, mute or hide picture). Nearby regions are
   merged so playback doesn't stutter.
4. **Act.** A 100 ms loop compares playback time against the plan and skips,
   mutes or hides the picture. A toast shows what happened, with **Undo**, which lets that
   scene play.

### Ratings

Severity runs from 1 (mild) to 3 (strong). Each preset is the highest severity
allowed to play; anything above it is cut.

| Preset | Nudity | Sex | Violence | Gore | Language | Drugs | Frightening |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R | moderate | moderate | any | moderate | any | any | any |
| PG-13 | none | mild | moderate | mild | moderate | moderate | any |
| PG | none | none | mild | none | mild | mild | moderate |
| G | none | none | none | none | none | none | mild |
| Custom | per-category sliders | | | | | | |

By default, language is **muted** (captions hide too) and everything else is
**skipped**. Any category can be set to skip, mute or *hide picture* instead.
*Hide picture* darkens the video rather than blurring it: a blur filter over a
full-size video stuttered playback badly in testing, while darkening is a
single cheap pass. It is stored as `blur` for compatibility.

### Scan-ahead with lightweight models

Streaming video is DRM-encrypted, so a browser extension **cannot see the
frames**. Drawing a protected video to a canvas gives black. CleanCut therefore
scans in two places:

- **In the browser: the subtitle track.** Netflix and Prime download the full
  subtitle file at playback start. The page hook reads the track list from the
  player's own JSON (YouTube's player response, Vimeo's player config, Hulu's
  playlist, Crunchyroll's play service, Tubi's content API, Plex's library
  metadata, or the subtitle renditions an HLS or DASH manifest lists), fetches
  the English SDH track, and the analyzer
  ([`shared/analyzer.js`](shared/analyzer.js)) processes the whole episode in
  milliseconds:
  - *Profanity* in dialogue becomes precise mute segments, by line or by
    estimated word timing.
  - *Sound descriptions* in SDH captions (`[moaning]`, `[gunfire]`,
    `[bones crunching]`) and suggestive dialogue become scene hints. Hints of
    the same category are clustered over time, and their confidences compound
    (1 − Π(1 − cᵢ)). Three sex-related cues in ten seconds come out as one
    sex scene at about 83% confidence.

  Machine segments are **suggestions** unless they clear your confidence bar
  (default 60%). The timeline shows them hatched.
- **Offline: the frames.** `cleancut-scan` runs any Hugging Face-style ONNX
  image classifier over a video file you have lawful access to, smooths the
  per-frame scores into scenes, and publishes them to the database as
  `scanner` segments for people to confirm.

### Listening ahead (videos without captions)

Plenty of videos have no captions at all (on Vimeo especially, and on YouTube).
With **Listen ahead when there are no captions** on (popup → *How scenes are
cut*; off by default), CleanCut transcribes the audio the player has already
buffered ahead of the playhead, **on this computer**, and mutes profanity
before it plays.

```
 page (MAIN world)            content script             offscreen document (the extension's own process)
 page-hook.js                 content/listen.js          audio-worker.js                 asr-worker.js
 appendBuffer: a copy of ──▶  base64 over a      ──▶    demux fMP4 / WebM ── 16 kHz ──▶  plan a window ahead of the
 each audio append            runtime port, and         WebCodecs decode       PCM       playhead → Whisper tiny.en
 (transferred)                the playhead (≤ 1/s)      (shared/media.js)                (transformers.js, onnxruntime-web
                                                                                          WASM, 1 thread) → words → analyzer
          plan ◀──── segments, source "listening" (times, category, masked word: never the words or the audio) ◀──┘
```

- **Off, it costs nothing.** The page hook reads `cleancut:listen` from the
  site's `localStorage` at document_start (like the debug flag). Unless the
  viewer turned listening on for that site, it never touches `MediaSource` or
  `SourceBuffer`. No offscreen document, no model, no copies. Switched off
  while the page is open, each append costs one boolean check.
- **On, the page does very little.** For audio SourceBuffers only (by MIME
  type), the hook copies each append and transfers it to the content script
  (no parsing beyond a look at the first bytes), which base64-encodes it
  (`Uint8Array.toBase64`, native) and posts it on a long-lived port. That was
  measured at about 0.13 ms for a 30 KB append, every few seconds. Runtime
  messaging carries JSON only. Moving the bytes without copying would take an
  extension iframe inside the site's page, which CleanCut avoids. The playhead
  rides on the existing 100 ms playback tick, at most once a second. No
  timers, DOM or layout reads are added.
- **Only where the audio isn't encrypted.** Netflix, Prime Video, Disney+, HBO
  Max, Hulu, Apple TV, Paramount+ and Peacock encrypt their audio (EME), so it
  cannot be read ahead. There the popup says *This service encrypts its audio,
  so CleanCut can't listen ahead here*, and nothing runs. On any other site, a
  video with `mediaKeys`, an `encrypted` event, or an encrypted init segment
  (`enca`/`sinf`, `pssh`, `senc`, WebM `ContentEncryption`) is refused the same
  way.
- **Captions win.** Once a title's captions are scanned, listening stops
  (Options has *Listen even when there are captions*).
- **What it hears, and when.** It plans up to 90 s ahead of the playhead, in
  windows of up to 28 s that start and end in pauses, with a shorter first
  window after a start or a seek. It idles while the video is paused or an ad
  plays. A seek stops the window being heard and starts at the new place.
  Speech the model left out (Whisper tiny can drop a short window's last
  sentence) is heard again. Decoding runs in its own worker, so it never waits
  behind recognition.
- **Mutes at the word.** Whisper's cross-attention word times (dynamic time
  warping; see `fixWordTimestamps` in `recognizer.js` for a bug fixed on the
  way) go through the subtitle analyzer as timed words. A profanity is muted
  from 0.12 s before to 0.12 s after the word (at least 0.35 s), plus the
  engine's usual padding. Confidences allow for mishearing: strong 0.85,
  moderate 0.75, mild 0.5 (a suggestion at the default 60% bar). Scene hints
  from sounds Whisper writes in brackets count 0.7 times as much.
- **The model** is downloaded once, after the viewer agrees to it in the popup:
  Whisper tiny.en, int8 ONNX, **44 MB**, from Hugging Face
  (`onnx-community/whisper-tiny.en_timestamped` at commit `aeaa137`). Every
  file is checked against a pinned SHA-256 (or git blob id) before it is kept
  in the extension's Cache Storage; *Options → Delete the model* removes it.
  No host permission is needed: Hugging Face and its CDN answer with CORS
  headers. While recognizing, nothing is fetched (a request for any file not
  in the cache is answered 404 in the worker). The WebAssembly runtime ships
  in the package (11 MB); no code is downloaded.
- **Private.** Audio and transcripts never leave the computer and are held in
  memory only while the video plays.

Why Whisper tiny.en, measured by `npm run bench:listen-model` in headless
Chromium (WebAssembly SIMD, 1 thread, a 4-core VM). RTF (real-time factor) is
compute seconds per second of audio, measured on 28 s windows. WER is on 30
LibriSpeech utterances. Swears are found by the analyzer in TTS speech.

| Model (int8) | Download | Load | RTF | WER | Swears | Word times |
| --- | --- | --- | --- | --- | --- | --- |
| **Whisper tiny.en** | 44 MB | 3.6 s | 0.20 | 9.5% | 8/8 | yes, ±96 ms |
| Whisper base.en | 80 MB | 6.1 s | 0.36 | 8.0% | 8/8 | yes, ±241 ms |
| Moonshine tiny | 32 MB | 1.7 s | 0.13 | 9.3% | 8/8 | none |
| Moonshine base | 67 MB | 2.2 s | 0.25 | 6.4% | 8/8 | none |

Moonshine is faster and as accurate, but gives no word times, so a mute
could only cover the whole phrase. Whisper base.en costs 1.7× the CPU and
twice the download for 1.5 points of WER, and its word times were looser.
More threads barely help (RTF 0.21 with 1, 0.16 with 2, 0.14 with 4), so
one thread is the most CPU-efficient (0.21 core-seconds per second of
audio, against 0.32 and 0.54). It also leaves the cores to the video, and
needs no cross-origin isolation. WebGPU is not available in headless
Chromium, so it was not measured and is not used. The int8 files rely on
operators (dynamic quantization) that onnxruntime's WebGPU backend may not
run, so WebGPU would probably need a different (fp16 or 4-bit) download.
Only the WebAssembly build of the runtime ships (11 MB instead of 22 MB).

What it costs the page (`npm run bench:listen`): the MSE demo, 720p VP9 and
Opus buffered 30 s ahead in 5 s segments like YouTube, 30 s of playback with
the mouse moving over the player. Headless Chromium on 4 cores, 3 runs each
(ranges):

| | script ms/s | task ms/s | long tasks | janky frames | dropped frames | `appendBuffer` call | CPU, all processes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| No extension | 2.3 | 31–32 | 0 | 0 | 0 / 903 | 0.09–0.11 ms | 0.42 cores |
| CleanCut, listening off | 3.4–3.8 | 41–43 | 0 | 0 | 0 / 903 | 0.08–0.11 ms | 0.45–0.47 |
| CleanCut, listening on | 4.2–4.3 | 48–49 | 0 | 0 | 0 / 903 | 0.13–0.15 ms | 1.03–1.12 |

With listening on, the page's main thread does 0.6 ms/s more script work.
That is the content script carrying 420 KB of audio in 14 appends, about
0.13 ms each, plus planning in what comes back. The hook's copy adds about
0.04 ms to each `appendBuffer` call. There are no long tasks and no janky or
dropped frames. The model works in the extension's own process: about
0.6 cores while it catches up on the first minute, then about 0.2 cores per
second of speech (RTF 0.21 to 0.24 in the extension). With listening off, the
hook installs nothing.

---

## Quick start

Requires Node 22.13+ (for the built-in `node:sqlite`) and, for the demo video
and scanner, `ffmpeg`.

```bash
cd cleancut
npm install
npm run build          # → extension/dist/chrome and extension/dist/firefox
npm run demo:video     # generates server/public/demo.webm (ffmpeg)
npm run server         # http://localhost:8787  (hub at /, demo at /demo)
```

**Load the extension**

- Chrome / Edge: open `chrome://extensions`, turn on *Developer mode*, choose
  *Load unpacked*, and pick `extension/dist/chrome`.
- Firefox 128+: open `about:debugging#/runtime/this-firefox`, choose *Load
  Temporary Add-on*, and pick `extension/dist/firefox/manifest.json`. Then
  grant the site permissions from the extension's menu.

**Try it on the demo:** open http://localhost:8787/demo, click **Seed demo
tags**, reload, and press play. At 0:20 the tagged violent scene is skipped.
At 0:44 an *untagged* sex scene is skipped because scan-ahead found it in the
SDH captions. At 1:00 the strong language is muted. Switch ratings from the
toolbar popup and the cut changes. `/demo?mode=hook` serves captions the way
Prime does, through a playback JSON, to exercise the subtitle-fetching path.

**On Netflix / Prime Video:** pick a rating in the popup and play an episode.
If the popup says *subtitles not scanned yet*, turn on **English [CC]** once
so the player downloads the track. You can hide captions again afterwards;
the scan stays.

![Community hub listing tagged titles with a timeline of segments and published skip lists](docs/hub.png)

### Tagging and sharing

- Move the mouse over the player: on the right edge, under the CleanCut badge,
  is **Flag scene**. Click it when a scene starts and **Done** when it ends, or
  click **Last 10 s** to flag what just played. Pick what is in the scene,
  nudge the start and end by a second if needed, and **Save flag**. It applies
  immediately, and the toast has **Undo**. Keyboard: `Alt+[` starts and
  finishes, `Alt+]` finishes (or flags the last 10 s), `Esc` cancels.
  Everything CleanCut shows on a player (toasts, badge, flag control) sits on
  that right-edge rail, clear of the sites' own controls along the top and
  bottom; while an ad plays it shows only the badge.
  Screenshots: [`docs/flagging/`](docs/flagging) (demo, Netflix- and
  Prime-style players) and [`docs/youtube/`](docs/youtube) (default, theater,
  fullscreen, during an ad); `node test/e2e/player-screenshots.mjs` retakes them.
- **Share N flags on GitHub** in the popup opens a prefilled issue on the
  catalog repository with the flags you made on this title.
- **Share my settings as a skip list…** in the popup shares your rating
  settings, for this title or for everything. Scenes you chose to *Let play*
  become explicit exceptions. Other people see the list in their popup and
  can **Use** it.
- Votes hide bad tags: below a score of −3, a tag is no longer served.

### Scanner

```bash
# subtitle analysis only (SRT, WebVTT, TTML/DFXP)
node scanner/src/cli.js subtitles episode.srt

# frames with a real model (optional dependency onnxruntime-node, installed by npm install)
#   model dir: config.json + preprocessor_config.json + onnx/model_quantized.onnx
#   e.g. https://huggingface.co/onnx-community/nsfw_image_detection-ONNX
node scanner/src/cli.js video episode.mkv --model ./models/nsfw --map nsfw=nudity --subs episode.srt -o scan.json

# frames with the no-model heuristic baseline (scores capped at 50%, so they stay suggestions)
node scanner/src/cli.js video episode.mkv -o scan.json

# publish against the platform's own video id (times must match that encode)
node scanner/src/cli.js publish scan.json --platform netflix --id 70248288 \
  --series "Game of Thrones" --season 1 --episode 1 --key "$CLEANCUT_API_KEY"
```

The quantized NSFW ViT runs at about 8–9 frames per second on a laptop-class
CPU, so a one-hour episode sampled at 1 fps takes about 7 minutes. `--map`
lets any classifier feed any category: a violence or gore model, for example,
with `--map violent=violence`.

---

## API

All JSON. Write calls need `Authorization: Bearer <apiKey>`.

| Method | Path | |
| --- | --- | --- |
| POST | `/v1/users` | `{ name }` → `{ apiKey }` |
| GET | `/v1/lookup?platform=&id=&canonical=` | segments, skip lists, and `borrowedFrom` when timing comes from another platform |
| POST | `/v1/segments` | `{ title: {platform, platformId, series?, season?, episode?, name?}, segments: [...] }` |
| POST | `/v1/segments/:id/vote` | `{ value: 1 \| -1 \| 0 }` |
| DELETE | `/v1/segments/:id` | your own tag |
| GET | `/v1/titles?q=` | browse |
| GET / POST | `/v1/profiles` | search / publish skip lists |
| POST | `/v1/profiles/:id/subscribe` | count a user |

Segment: `{ start, end, category, severity: 1-3, action?: skip|mute|blur, note?, source?, confidence? }`.
Categories: `nudity, sex, violence, gore, language, drugs, frightening`.

Configuration is through environment variables: `PORT` (8787), `HOST`
(127.0.0.1) and `CLEANCUT_DB` (`data/cleancut.db`).

---

## Tests

The browser tests and benchmarks drive Chromium with Playwright, a dev
dependency. Download its browser once:

```bash
npm install
npm run setup:browser   # downloads the Chromium build Playwright drives
```

They also need `ffmpeg` to generate their test videos (`brew install ffmpeg`
on macOS).

```bash
npm test                  # unit + API + scanner tests (node:test)
npm run test:e2e          # loads the built extension in headless Chromium against the demo
npm run test:e2e:youtube  # the YouTube adapter in the extension, on fixtures of YouTube's pages
npm run test:adapters     # every streaming adapter on a fixture at its site's real address
npm run test:live:youtube # the real youtube.com (network needed; exit 2 if YouTube refuses the browser)
npm run test:live:vimeo   # the real Vimeo embedded player (network needed)
npm run test:e2e:listen   # listening ahead on the MSE demo (downloads, once: the 44 MB speech model, 92 MB TTS model)
npm run bench:listen      # what listening costs the page: no extension vs listening off vs on
npm run bench:listen-model  # the candidate speech models: load time, real-time factor, WER, word timing
```

The listening tests need speech with known swearing. `npm run demo:listen`
makes it with a local TTS model (Kokoro-82M via kokoro-js, ONNX, Apache-2.0)
and ffmpeg. It writes an episode with no captions as WebM Opus, fragmented MP4
AAC, and a ClearKey-encrypted copy, all outside the repository, under
`~/.cache/cleancut` (`CLEANCUT_CACHE`). `npm run dev` then serves it at
`http://localhost:8787/demo/listen` (`?audio=mp4`, `?audio=enc`, `?ahead=30`).
The tests serve the model from a local copy of Hugging Face's files, checked
against the same digests. `test:e2e:listen` checks that, off, nothing is
installed, copied or opened; that turning it on asks first and downloads once;
that it idles while paused; that a swear is found in the buffered audio before
the playhead reaches it and muted around the word (also after a seek, and in
AAC); the popup's status; that captions win; that encrypted audio is refused;
and turning it off per site and deleting the model.

The live checks go through `HTTPS_PROXY` when it is set. YouTube shows a
"confirm you're not a bot" page or Google's "unusual traffic" page to some
networks (data centres, shared proxies); the live script then stops and says
so rather than trying to get past it. Playwright's Chromium cannot decode
H.264, which is all Vimeo serves, so the Vimeo check covers identification,
scan-ahead and the overlay but cannot play the video to test a skip.

`npm run bench` measures the extension's cost on a simulated Netflix watch page.
It serves a fake `www.netflix.com` locally with Netflix-like traffic, then
compares main-thread script time, style and layout work, and dropped frames
with and without the extension. Add `PROFILE=1` to print the hottest
functions.

`npm run bench:playback` checks playback smoothness while a viewer uses the
controls. It plays a 1080p video on the same fake page with a mock control
bar, moves the mouse and clicks pause and play, and reports janky frames,
input delay (Event Timing), dropped video frames, and style and layout work.
`BROKEN_API=1` simulates Netflix's seek API being unavailable.

`npm run bench:real` measures the extension on the real Netflix site: public
pages (a title page and the home page, no account needed), each loaded cold
and warm with and without CleanCut, traced, and compared on main-thread time,
long tasks, compile and code-cache use, FCP/LCP/load, requests and CPU in
every browser process. `--variants none,full,hook,content` switches the two
page scripts separately, `--ext before=…,after=…` compares builds, `--with`
loads other extensions (an ad blocker, say) in every run, and `--traffic`
replays what a signed-in Netflix page does in the background (the player
prefetching manifests for titles on screen, then opening one) inside the
real page. The header of `test/perf/netflix-real.mjs` lists every option.

`npm run trace -- <file>` summarises a Performance recording made in Chrome
DevTools on the real site (Performance → record → Save profile). It reports
main-thread time per owner (the page, CleanCut, other extensions), long
tasks, frame presentation, input latency, and whether CleanCut skipped, muted
or hid anything during the recording.

The end-to-end test plays the demo episode and checks:

- the community-tagged skip, the scan-ahead skip, mute and unmute, and gore;
- the hide-picture action;
- R, PG-13 and unfiltered producing different cuts;
- Undo and adopting a published list;
- keyboard tagging;
- the page-hook subtitle path;
- that the popup and options pages render without errors.

---

## Supported sites

Each service is one entry in [`shared/platforms.js`](shared/platforms.js)
(its id, name, hosts, match patterns and how to read a title id from a
watch-page address) plus, for the player, a few lines of config in
[`extension/src/content/adapters/`](extension/src/content/adapters).

| Service | Status | Identify | Skip | Ads | Scan-ahead subtitles |
| --- | --- | --- | --- | --- | --- |
| Netflix | unverified (needs an account) | id + metadata | player API, else cover | not detected | decrypted manifest |
| Prime Video | unverified (needs an account) | ASIN + metadata | currentTime | stream offset recalibrated | playback resources |
| YouTube | fixture-verified; live blocked here | id + player response | currentTime | `.ad-showing`: does nothing | caption tracks (json3); else the player's own request once CC is on |
| Vimeo | verified live (embed) | id + player config | currentTime | none | text tracks (VTT) |
| Disney+ | unverified | id + title bug | currentTime | ad badge | HLS WebVTT |
| HBO Max | unverified | id + player-ux | cover | ad badge | HLS/DASH sidecar |
| Hulu | unverified | id + metadata | cover | ad unit | playlist WebVTT/TTML |
| Apple TV | unverified | id + title | cover | none | HLS WebVTT |
| Paramount+ | unverified | id + title | currentTime | ad countdown | HLS/DASH |
| Peacock | unverified | id + header | cover | ad countdown | HLS/DASH |
| Crunchyroll | unverified | id + JSON-LD | cover | ad countdown | ASS / CC from the play service |
| Tubi | unverified | id + JSON-LD | currentTime | ad countdown | .srt from the content API |
| Pluto TV | unverified | id (on demand) | currentTime | ad marker | HLS WebVTT |
| The Roku Channel | unverified | id + title | cover | ad countdown | HLS/DASH |
| Plex | unverified | id + library metadata | cover | not detected | sidecar subtitle streams |

*Cover* means CleanCut mutes and hides the picture for a skip region instead
of seeking, because it is not known that the player tolerates
`video.currentTime` being set (as with Netflix, where it crashes the player).
On services whose ads are stitched into the stream (Disney+, Hulu, Peacock,
Paramount+, Pluto TV and the ad tiers of others), the stream clock runs ahead
of the episode's after every ad break; catalog tags and scan-ahead segments
then land late by the ads' length. YouTube Shorts are out of scope: looping
clips in a swipe feed, rarely captioned, never in the catalog.

## Website and publishing

- `site/` is the project website (landing, privacy and support pages), deployed to GitHub Pages by `.github/workflows/site.yml`.
- [`docs/publishing/CHROME_STORE.md`](docs/publishing/CHROME_STORE.md): submitting to the Chrome Web Store (listing copy, permission justifications, checklist). `npm run package` builds the store zip.
- [`docs/publishing/OPERATIONS.md`](docs/publishing/OPERATIONS.md): what runs, what it costs, and the upkeep and support effort.

## Limits and honest caveats

- **Not tested against live Netflix, Prime Video or the other subscription services.** That needs real
  accounts. The adapters follow the players' current DOM and JSON shapes,
  which change without notice. Every extractor is defensive, and the code
  marks each place that depends on site internals. Expect to maintain
  selectors. Netflix's player fetches its manifests over its encrypted MSL
  transport (`/msl/playapi/…`), so the subtitle list is not readable on the
  network. CleanCut reads it when the player itself `JSON.parse`s the decrypted
  manifest (a shape check on each parsed value, in the page hook). If Netflix
  changes that, scan-ahead on Netflix finds nothing; catalog tags and your own
  tags still work.
- **Netflix seeking** goes through the player's own API, because setting
  `video.currentTime` crashes the Netflix player (error M7375). If Netflix
  changes that API, CleanCut notices the failed seek, says so once, and covers
  skip regions by muting and hiding the picture instead.
- **Prime Video** can offset media time from programme time (and ad breaks
  shift it further). The adapter recalibrates against the on-screen clock
  whenever it is visible, and the popup has a manual **Sync** nudge.
- **Cross-platform timing.** Tags are timed against one platform's encode.
  When a title only has tags from another platform, they are offered with a
  warning and the sync control. Automatic alignment, by matching subtitle cue
  timings between platforms, is the next step (see Roadmap).
- **Subtitle hints are hints.** `[moaning]` can be pain, and plenty of scenes
  have no caption at all. That is why machine segments carry a confidence and
  default to suggestions. People confirming tags is what makes a cut reliable.
- **Seeing a skipped scene's first frames.** The engine acts about 150 ms
  early and pads each region, but the first fraction of a second of a scene
  can show. Use *hide picture* for categories where that matters.
- **Legal.** In the US, the Family Movie Act of 2005 permits skipping and
  muting parts of a film during private home viewing, as long as no altered
  copy is made. CleanCut works that way: it never copies, modifies or
  redistributes the stream. Streaming services' terms of use still apply, and
  rules differ by country. This is not legal advice.
- **Privacy.** The only thing that leaves your browser is the lookup of what
  you are watching (platform and id) sent to the server you configure, plus
  anything you choose to share. Subtitles are analyzed locally and never
  uploaded. With listening ahead on, audio is transcribed on your computer and
  never leaves it; the one extra request is the model download, once, from
  Hugging Face.
- **Listening ahead mishears.** Whisper tiny.en on clean TTS speech found 8/8
  swears and wrote "dam" for "damn" in 1 of 16 windows. With a weaker TTS voice
  it heard "FUG" for "fuck" in 9 of 16 windows. Films with music and effects will be
  harder. Captions, when a video has them, are more reliable and win. After a
  seek, the first words at the new place are known about 3 to 7 s later on this
  4-core VM: each window costs about 2 s of encoder time plus about 45 ms per word.
  So a swear right after the landing point can get through.
- **Listening ahead is unverified on the real YouTube and Vimeo.** YouTube
  refuses this test machine, and in its headless Chromium Vimeo's player never
  loads media, with or without CleanCut. What is known: Vimeo plays through MSE
  (a `blob:` source), and the hook arms in the `player.vimeo.com` frame;
  YouTube serves Chrome Opus in WebM, the demo's default; Vimeo's DASH container
  (AAC in fragmented MP4) is checked on the demo. Not handled: a SourceBuffer
  carrying audio and video muxed together, MediaSource in a worker, `sequence`
  mode, plain MP4 files without MSE (plain WebM files are read with Range
  requests), and Firefox (no offscreen documents). Turning it on for a site
  takes effect on the next page load, because the hook reads its flag at
  document_start.

## Roadmap

- Automatic cross-platform sync: store cue-timing fingerprints per title and
  cross-correlate them.
- A hosted server with moderation, reputation-weighted votes and duplicate-tag
  clustering.
- In-browser frame models (onnxruntime-web) for non-DRM sites.
- Live verification of the subscription services' adapters, and mapping the
  stream clock to the episode's around stitched-in ads.
- Shareable skip-list links, and following people whose lists you like.
- Non-English lexicons.

## Layout

```
shared/      ratings, engine, subtitles, analyzer, lexicon, sources, identity, validate, media, listening
extension/   build.mjs, src/{background,page-hook,config}.js, src/content/*, src/popup/*, src/options/*,
             src/offscreen/* (listening's host page), src/listen/* (model registry, store, workers)
server/      src/{index,app,db}.js, public/{index,demo}.html + demo captions
scanner/     src/{cli,frames,classifiers,timeline}.js
test/        *.test.js, e2e/extension.e2e.mjs, fixtures/
```
