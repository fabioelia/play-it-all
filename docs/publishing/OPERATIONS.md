# Running and maintaining CleanCut

**Short answer:** there is **nothing to host**. The community catalog is files in this repo read straight from GitHub, and the website is static pages on GitHub Pages. It costs $0 to run.
The ongoing work is keeping the streaming-site adapters alive, and reviewing catalog contributions.

## What has to run

| Piece | What | Cost |
| --- | --- | --- |
| **Extension** | Nothing at runtime. A zip in the user's browser; updates go through the Web Store. | $5 once (developer account) |
| **Community catalog** | `catalog/` in this repo, read via `raw.githubusercontent.com`. `catalog.yml` validates changes and rebuilds `catalog/index.json`. | $0 |
| **Catalog submissions** | `catalog-submission.yml` turns a "Submit to the catalog" issue into a PR | $0 |
| **Website** | `site/` on GitHub Pages, deployed by `site.yml` | $0 |
| **Moderation** | Pull requests on `catalog/**`, checked by CI | your time |

## How the data flows

```
 viewer flags a scene ──▶ popup: "Share on GitHub" ──▶ prefilled issue (label: submission)
                                                          │  bot validates + merges into the right catalog file
                                                          ▼
                                                  pull request  ──▶ CI (catalog.yml: index + validate) ──▶ maintainer reviews, merges
                                                                                                              │
 extension  ◀── raw.githubusercontent.com/…/catalog/index.json (conditional request) + one episode file ◀───────┘
```

- The extension downloads the small `index.json` (asking only if it changed), then only the file for a title the index lists. Titles with no data cost no request.
- One file per episode, shared by every platform: each tag records the platform it was timed on, and per-platform offsets let a tag made on one service play on another.
- raw.githubusercontent.com is cached for a few minutes, so a merged tag reaches viewers within minutes.

## One-time setup

1. **Pages:** Settings → Pages → Source: *GitHub Actions*. Merge to `main`; `site.yml` publishes `site/`.
2. **Bot PRs:** Settings → Actions → General → *Allow GitHub Actions to create and approve pull requests* (the submission workflow needs it).
3. Optional: branch protection on `main` requiring the **validate** check; add co-maintainers or a `CODEOWNERS` entry for `catalog/`.
4. If the repo moves or is renamed, update `extension/src/config.js`, the links in `site/`, and the privacy policy.

## Maintainability

| Area | Assessment |
| --- | --- |
| Dependencies | Runtime: none in the extension bundle. Dev: `esbuild` and Playwright for browser tests. Optional: `onnxruntime-node` for the scanner. |
| Tests | Unit tests plus several headless-Chromium suites (demo, YouTube fixtures, every adapter on a fixture at its site's real address), perf benchmarks, and live checks for YouTube and Vimeo. |
| Structure | Each service is one entry in `shared/platforms.js` plus a few lines of adapter config; the engine, analyzer and catalog code are shared and tested. |
| Hosting risk | None to operate. GitHub is the only dependency; the extension keeps working from its cache and the user's own flags if GitHub is unreachable. |

## What will actually take your time

1. **Site changes (high, recurring, and it scales with the number of services).** Each service has its own player, JSON shapes and DOM, and none promise stability.
   Netflix is the most fragile (encrypted manifests, a seek API that crashes the player if bypassed). With 15 adapters, expect more breakages per year than with two,
   and most are unverified against live accounts, so you'll learn of problems from users. Each fix is typically a few hours. When a seek fails, CleanCut covers the
   scene by muting and hiding, which softens the failure.
2. **Reviewing catalog PRs (grows with success).** Each is a small JSON diff, already validated by CI. Review is about accuracy and spam. At a few PRs a week it is minutes per PR;
   it becomes the bottleneck first. Add co-maintainers, or auto-merge PRs from trusted contributors.
3. **Support (low to medium).** "It didn't skip X" (no tag), "subtitles not scanned yet" (turn on captions), timing offsets after ad breaks (Sync nudge). `site/support.html` answers these.
4. **Store housekeeping (low).** Each update needs a version bump and re-review.
5. **Privacy (low, non-negotiable).** If you add a data flow, update `site/privacy.html` and the dashboard disclosures first.

## Trade-offs of the file-based catalog

- **No votes or accounts.** Quality control is review, not crowd voting. A bad merged tag is fixed by another PR.
- **GitHub sees the catalog-file requests** (not CleanCut). The privacy policy says so.
- **Contributors need a GitHub account**, though not git.
- **Cold start.** The catalog starts with one demo show.
- **Scale.** One file per episode and one index. Thousands of episodes is fine; if `index.json` grows past about 1 MB, split it by show or platform.

## Monitoring

- **Catalog:** a red `Catalog` check on a PR or on `main` is the alert. Watch the Actions tab.
- **Extension health:** there is no telemetry by design, so breakage reaches you through reviews and issues. Run `npm run test:adapters` and `npm test` before releases, `npm run test:live:youtube` / `:vimeo` when you can,
  and do a weekly 10-minute smoke test on Netflix and Prime with a real account.

## Rough monthly effort

| Stage | Hours/month | Out-of-pocket |
| --- | --- | --- |
| Quiet (no site changes, < 1k users) | 3–6 | $0 |
| Typical (a couple of site changes, a few thousand users, a few PRs a week) | 10–20 | $0 |
| Growing (10k+ users, many contributors) | 20–40 | $0 (domain optional) |

These are judgment estimates, higher than a two-service version because of the number of adapters.

## If you outgrow it

A hosted API with accounts, votes and instant publishing is a possible later step (see the README roadmap). The catalog format and the extension's catalog reader are isolated enough to put a service behind them,
but it means hosting, moderation tooling and an on-call burden you don't have today. Free hosts that keep a disk are scarce; budget roughly $2–5 a month.
