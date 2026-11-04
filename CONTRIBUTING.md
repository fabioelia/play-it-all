# Contributing to the CleanCut catalog

The catalog is the shared list of timestamped content tags that CleanCut uses
to skip, mute or hide scenes. It lives in this repository as plain JSON in
[`catalog/`](catalog). There is no server or account system: you contribute
through GitHub, and the extension reads the catalog straight from here.

## The quick way: from the extension

1. While you watch, click **Flag scene** on the player (move the mouse to
   show it) when a scene starts and **Done** when it ends, or **Last 10 s**
   right after it. Pick a category and severity and **Save flag**. The
   shortcuts `Alt+[` and `Alt+]` do the same.
2. Open the CleanCut popup and click **Share on GitHub**. It opens a
   [**Submit to the catalog**](../../issues/new?template=submit-to-catalog.yml)
   issue with everything filled in.
3. Submit the issue. A bot checks it, merges it into the right file and opens
   a pull request. A maintainer reviews and merges it, and everyone gets your
   tags within minutes.

If the bot can't use a submission, it replies on the issue with the reason.
Edit the issue to try again.

## By hand: pull requests

Edit files in `catalog/` directly and open a pull request. CI validates
everything and rebuilds `catalog/index.json` after merge, so don't edit the
index yourself. To check locally:

```bash
node scripts/catalog.mjs validate
```

You can also merge a submission JSON into your checkout:

```bash
node scripts/catalog.mjs ingest my-tags.json --author your-github-name
```

## How it is organised

```
catalog/
  index.json                      generated: titles, platform ids, name aliases, lists
  shows/<show>/show.json          { "name": "Game of Thrones", "year": 2011, "aliases": ["Game of Thrones (HBO)"] }
  shows/<show>/s01e01.json        one episode
  movies/<title>-<year>.json      one film
  lists/<id>.json                 a published skip list
```

The **key** of an episode is `<show>/s01e01`, where `<show>` is the show name
lower-cased with dashes (`game-of-thrones`). For a film it is the name plus
the year (`the-matrix-1999`). Keys are what tie the same title together across
services.

### One file per episode, every platform in it

The same episode on Netflix, Prime Video and elsewhere is **one** file. Each
service it is on gets an entry with:

- its own **video id**, so the extension finds the file straight from what is
  playing;
- how its **clock** relates to the episode's *reference timeline*:

```
platform_time = reference_time × speed + offset
```

Services start programmes at different moments (a studio logo, a recap), and
some regions play 25 fps versions of 23.976 fps masters, about 4% faster. The
**reference timeline** is the first service anyone tagged the episode on. It
has offset 0 and speed 1.

```json
{
  "key": "game-of-thrones/s01e01",
  "type": "episode",
  "series": "Game of Thrones", "season": 1, "episode": 1, "name": "Winter Is Coming",
  "timeline": "netflix",
  "platforms": {
    "netflix": { "id": "70248288", "offset": 0, "speed": 1 },
    "prime":   { "id": "B007ABC123", "offset": 12.4, "speed": 1 },
    "web":     { "id": "example.com/watch/123", "offset": null }
  },
  "sync": { "cues": [12.3, 15.8, 19.1] },
  "segments": [
    { "id": "0y2hx83", "on": "netflix", "start": 1210, "end": 1290,
      "category": "sex", "severity": 3, "note": "brothel scene", "by": "octocat" }
  ]
}
```

Each segment says which service it was timed **on**. A tag timed on Prime
plays on Netflix as soon as both clocks are known, and vice versa.

### Syncing a new service automatically

`sync.cues` is a fingerprint of the episode's timing: subtitle cue start
times on the reference timeline, with no subtitle text. When someone submits
tags from a service the episode doesn't list yet, the extension includes that
service's cue times. The bot then matches the two patterns and fills in the
`offset` and `speed` itself. The pull request says whether this worked.

Without a match the service is added with `"offset": null`. Its tags work on
that service, and the extension can still measure the offset on a viewer's
device whenever that viewer has subtitles. Once anyone works out the offset,
put it in the file and every tag works everywhere.

### Segments

| Field | Values |
| --- | --- |
| `start`, `end` | seconds on the `on` service's clock |
| `category` | `nudity`, `sex`, `violence`, `gore`, `language`, `drugs`, `frightening` |
| `severity` | `1` mild, `2` moderate, `3` strong |
| `note` | optional, up to 280 characters: what happens, never quoted dialogue |
| `id` | generated from the content; leave it to the tools |
| `by` | GitHub username of the contributor |

How viewers act on a tag (skip, mute or hide the picture) is their choice in
the extension, not part of the catalog.

### Skip lists

A skip list is a shareable setting: a rating, how to act per category, and
optionally specific tags to always cut (`include`) or always allow
(`exclude`). `scope` is `"*"` (everything), a show (`game-of-thrones`) or one
episode or film.

```json
{
  "id": "family-night",
  "name": "Family movie night",
  "description": "PG everywhere.",
  "scope": "*",
  "settings": { "preset": "PG" },
  "overrides": { "include": [], "exclude": [] }
}
```

Submit one through the same issue form, as `{ "cleancut": 1, "list": { … } }`.

## Ground rules

- **Timestamps and descriptions only.** Never paste subtitle text, scripts,
  frames or links to copies of the video.
- **Tag what is on screen, not opinions about it.** Severity follows the
  scale in the extension; when unsure, choose the higher one.
- **Machine-detected tags** (from `cleancut-scan`) use
  `"source": "scanner"` and a `confidence`. Viewers treat them as suggestions
  unless they opt in.

## For maintainers

One-time repository setup:

- Settings → Actions → General → **Allow GitHub Actions to create and approve
  pull requests**.
- Create the labels `submission` (the issue form adds it) and `catalog`.
- Pull requests opened by the bot are created with the Actions token, so they
  don't trigger CI themselves. The bot has already validated them; CI runs
  again on `main` after merge and rebuilds the index.
