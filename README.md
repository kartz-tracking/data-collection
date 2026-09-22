# Kartz Extractor

A single static page that turns a screen recording of the in-game **Ranking** list into
rows you paste straight into the tracking sheet. No install, no OCR software, no server.
Works on Windows, macOS, Android and iOS — anywhere with a browser.

## Deploying

One Cloudflare Worker serves both halves: `public/` is the site, `/api/*` runs `worker.js`.
Same origin, one deploy.

```bash
npm i -g wrangler && wrangler login && wrangler deploy
```

Then, in the project settings:

- **Settings → Domains & Routes → Enable `workers.dev`.** A Worker has no public URL until
  you do; the Overview will say *No URLs enabled* until then.
- **Settings → Variables and Secrets → `GEMINI_KEY`** — required. Everything runs through
  Gemini, and the key lives here rather than in anyone's browser. Without it every run fails
  with *Worker has no GEMINI_KEY secret set*.
- `SHARED_PASS` — optional, and no longer entered anywhere on the page. The site is served
  from the Worker, so its own requests are recognised by origin and never need it; the phrase
  now only gates callers that are not the site — curl, a script, another origin.

Pushing to `main` redeploys.

## Opening it the first time

A Worker has no public URL until you turn one on. If the Overview says **No URLs enabled**,
go to **Settings → Domains & Routes → Enable `workers.dev`**. The site is then at
`https://kartz.<your-subdomain>.workers.dev` — open it in any browser, there is nothing to
start and nothing to install.

Every push to `main` redeploys it automatically.

On a phone, open that URL and use **Share → Add to Home Screen**. It then behaves like an
app, which is worth doing because the phone is where the recording already lives.

### Setting it up, once per device

Paste the link to your **Alliance Rosters** tab, press **Pull roster**, and **Save setup**.
That is the whole configuration — there is no model or key to choose, because both live on
the Worker. If the pull complains about a sign-in page, the sheet is not link-readable:
*Share → General access → Anyone with the link → Viewer*.

The badge next to *Setup* turns green and shows the roster count when it is ready.

### Each run

Pick the recording, set the date, press **Extract**, then **Copy for sheet**.

There is no alliance filter, deliberately. It was tried and removed: a Kartz list mixes
alliances, and restricting one 148-player recording to 698W dropped 27 players who were
plainly correct, taking the match rate from 95% down to 76%. Every row is matched against
the whole roster.

Rows that need a decision get two controls:

- a **search box** in the Game Name column — type a few letters and the list filters. It is
  drawn rather than left to the browser, because a native `<select>` opens a list as tall as
  the page and a `<datalist>` ignores any attempt to size its popup. This one is capped at
  about 210 pixels and scrolls inside itself, shows each player's alliance beside the name,
  and takes arrow keys and Enter;
- an **alliance dropdown** in the Alliance column, for saying which alliance a new player
  belongs to. Matched rows just show the alliance the roster already knows.

**Remember my fixes** stores the name *and* the alliance you gave it, so the same player is
recognised, with the right alliance, from the next run onward.

## Grouping by rank, not by name

Readings are grouped by the rank they carry, and the name is then decided by majority vote
inside that group.

Grouping by name was the earlier design and it fails in a specific way: a name read three
different ways becomes three players, so a 153-player list comes back as 158 rows, each seen
once, with no majority left to correct anything. Rank is a plain numeral and comes back
reliably, which makes it a far better key. Voting still happens — within a rank rather than
within a spelling — so a good reading outvotes a bad one instead of splitting away from it.

Readings whose rank was unreadable are attached to the rank whose score and name they agree
with, and otherwise stand on their own.

## The response shape is enforced by the API

Requests set `responseMimeType` and a `responseSchema`, so the model cannot return prose, a
markdown fence or a half-written object. Every field is declared as a string and converted
here, because a model asked for a number will occasionally answer `"1,234"` or `"#4"` and
have the whole response rejected. The salvaging parser is still in place behind it.

## The roster goes into the prompt

The biggest single improvement was not a better model — it was asking a different question.
Reading a name off a screen is open-ended, and stylised game tags defeat it. Deciding *which
of 689 known players* a row is, is a far easier question, and the roster is already loaded.

So the roster is sent with the request and the model returns the entry it recognises. It
costs roughly 2,300 tokens.

Crucially the list gives **both** forms — the sheet name and the name as drawn in the game —
because for about 40% of the roster they differ, and some pairs no string comparison could
ever bridge: `ERank` is Aalonsoj ALT, `TRD` is AcE, `ŊŲƁĮ` is Nubi, and one player renders as
glyphs that normalise to an empty string. Only the mapping resolves those.

The model's answer is not taken on trust: a name it returns must actually exist in the
roster, or the row falls back to fuzzy matching and is raised for confirmation.

## Frames are sent at the recording's own resolution

They used to be downscaled to 560 px wide, which was chosen when the concern was payload
size. That turned out to cost real accuracy: at 560 the name `ŊŲƁĮ` came back as `MB` and
`DJ`, while the identical row at the phone's native width resolves to `Nubi` outright. Token
cost is near enough flat per image, so the downscale was buying nothing.

Higher resolution has one side effect worth knowing about: the opening seconds of a recording
become legible too, and those often show a different screen. Rows whose score sits far
outside the rest of the list, or at zero, are dropped as belonging to some other screen — the
phone's own music widget once arrived as a player called "Not Playing".

## Two ways to read a recording

**Sampling frames** (the default) picks stills and sends them in batches. Names benefit from
being read several times and voted on, but coverage depends on the frame budget matching how
fast the list was scrolled.

**Send the whole video** hands Gemini the clip and lets it do its own sampling — the same
thing the Google AI Studio app does. One request covers the entire list, so nothing can fall
between frames, but each player is read exactly once and there is no second reading to
outvote a bad one.

Measured on the same 43-second, 153-player recording:

Measured on the same 43-second, 153-player recording:

| | frames | whole video, roster in prompt |
|---|---|---|
| rows returned | 147 of 153 | **153 of 153**, ranks 1..153 |
| requests | 5 to 29 | **1** |
| time | 63s | **26s** |
| rank 1 read as | `Noxira` / `Nitro` ✗ | **`Neaira`** ✓ |
| rows needing a decision | 13 | **8** |
| coverage warning | yes | none |

Whole-video is the better setting for this. It cannot miss a player, because nothing depends
on the frame budget lining up with how fast the list was scrolled, and with the roster in the
prompt the names hold up too. Under about 14 MB, and Gemini only.

Of the eight rows left to decide, six are **contested**: two rows both resolving to one
roster entry, usually a main and an alt sharing a display name where the roster lists only
one of them. Neither the model nor a fuzzy match can settle that, so both rows are shown and
neither is emitted until you choose. The other two were genuinely absent from the roster.

Frames mode remains useful when a recording is too large for whole-video, and it is the only
mode that reads a name several times and votes.

## One model, no fallback chain

`gemini-3.5-flash-lite`, and nothing behind it. An earlier version walked a chain of six
models on a 429 or 503, which mattered when the free tier was metered per model and the
better ones kept running dry. It stopped mattering: with readings grouped by rank and the
roster supplied in the prompt, the lite model scores within a point of the largest one on the
same recording — 143 matched against 144 out of 153 — so there is nothing to fall back *to*
that would be worth the complexity. A failed run now says what went wrong instead of quietly
producing worse results on a different model.

## Errors, and why they stopped happening

Two different faults both used to surface as a red message, and both are now handled
without you seeing anything.

**503 "high demand"** is not about your key. It means that one model alias is saturated at
that moment. Probed side by side, `gemini-3.7-flash` returned 503 while six sibling models
answered normally in the same second.

**429** is the free tier's daily allowance — and the quota is named
`GenerateRequestsPerDayPerProjectPerModel-FreeTier`. The important word is **PerModel**:
the 20-a-day is counted separately for every model, not shared across them.

So both faults have the same cure — ask a different model — and the page now does that
automatically, walking down a fallback chain and carrying on. It says which model it landed
on rather than hiding it. Verified by starting a run on a model whose daily quota was fully
exhausted: it fell through to the next and returned all 40 players with no error shown.

## How many runs you actually get

| | |
|---|---|
| models in the chain | 7 |
| free quota, per model, per day | 20 requests |
| **effective total** | **140 requests a day** |
| requests per run (24 frames, 8 per call) | 3 |
| **runs per day** | **about 46** |

Twelve runs — three scoring days across four alliances — is 36 requests. Done back to back
in a single hour that is roughly **a quarter of one day's free allowance**, on one key, with
no billing enabled.

The chain order is set by what held up under testing. `gemini-flash-latest` is deliberately
excluded: it returned 503 on every attempt across a whole session, then an empty body. The
lite models are quick — 5 seconds a batch against 18 — but one dropped a player, so they sit
below the full ones and are reached only when the better models are spent.

## What cropping does and does not do

Frames are cropped before sending: the title bar, margins and avatar column are dropped,
and the rank digits are spliced next to the name and score. Untick **Crop to the list** if
the preview strip ever looks wrong on a differently shaped phone.

It is worth being precise about why, because the obvious reason turns out to be false.
Cropping does **not** make the request cheaper. Measured against Groq with Qwen 3.6:

| image | pixels | tokens |
|---|---|---|
| 560x936 | 524,160 | 1807 |
| 280x468 | 131,040 | 1807 |
| 140x234 | 32,760 | 1807 |

Sixteen times fewer pixels, identical cost — billing is per image, not per pixel. Shrinking
or cropping frames to save money simply does not work here; the only real lever on a
token-metered tier is **sending fewer frames**.

What cropping actually buys is correctness and upload size. The game pins the viewer's own
rank in a card at the foot of every frame, so it repeats in every single image; it used to
be held off with a line in the prompt and a y-position guess, and now it is physically not
in the picture. The upload drops from about 36 KB a frame to 20 KB, which is worth having
on a phone connection.

## If a response gets cut off

Long batches can hit the output limit mid-object. Rather than discarding the batch, the page
parses row objects individually and keeps every complete one. Because frames overlap
heavily, a lost tail is picked up by the neighbouring frame anyway.

## Other providers

The page speaks four dialects: Gemini, Anthropic, the team Worker, and the OpenAI
chat-completions shape almost everyone else implements. Picking a provider fills in its
endpoint, model, batch size and pacing.

### Groq — Qwen 3.6 27B

The model itself is very good at this. Given a leaderboard screen it returned every row
with correct ranks and scores in **1.3 seconds**, and read `ᏢᎬᎪĆᎻ` as PEACH, `ᵇᵃᵗᵐᵃⁿ` as
batman and `ÈXÎLÉ` as EXILE without being asked twice. Accuracy is not the problem.

Throughput is. The free tier allows **8,000 tokens a minute**, and that budget counts the
output you *reserve*, not just what comes back — asking for 16k of output made a 5k request
weigh 19k and get refused outright with a 413.

Measured: the prompt is 383 tokens and a frame about 2,100. Three frames plus a 1,500-token
reservation comes to roughly 8,050 — just over the ceiling, and it fails on some recordings
and not others depending on how busy the picture is. Two frames with a 900-token reservation
lands near 5,400, which fits with room to spare. Three would be about 10% quicker across a
whole run and is not worth the intermittent failure.

| | Groq free (Qwen 3.6) | Gemini free |
|---|---|---|
| per request | ~5,400 tokens, 2 frames | 8 frames, 3 requests per run |
| one 24-frame run | **~8 minutes** | **18–24 seconds** |
| twelve runs | **~97 minutes** | **~5 minutes** |
| what limits you | 8k tokens/minute | 20 requests/day/model, ×7 models |

Groq's 1,000 requests a day is generous and its per-call latency is excellent; the minute
budget is what bites. The page handles it rather than failing: Groq batches run one at a
time instead of in parallel, and a 429 there is waited out using the server's own
`retry-after` hint, because unlike Gemini's daily cap a per-minute window genuinely clears.

Use it if you like the model or Gemini is down. For twelve runs in one sitting, Gemini is
roughly twenty times quicker.

### Cloudflare Workers AI — measured, and not recommended for this

Reachable only through the Worker: the REST API answers a CORS preflight with 405 and sends
no allow-origin header, so a page cannot call it however the request is shaped. Through the
Worker it does work, and Llama 4 Scout does accept images.

It reads the *numbers* perfectly — every rank and score matched what Gemini produced. Names
are the problem, and on a 153-player list they are the problem badly:

| | players found | matched to roster |
|---|---|---|
| Gemini | 147 | 134 (**91%**) |
| Llama 4 Scout | 158 | 129 (82%) |

Finding 158 players in a list of 153 is itself the symptom: a name read differently in two
frames becomes two rows. Mid-list it is respectable — 89 to 96% on a sample of eight frames —
but the stylised names at the top defeat it, and those are the ranks people look at.

One setting matters a great deal if you use it. Measured on the same eight frames:

| frames per call | rows read per frame |
|---|---|
| 8 | 3.5 |
| 4 | 4.1 |
| **2** | **5.8** |
| 1 | 6.0 |

Given eight images at once the model stops reading partway through, and the rows it skips are
exactly what the majority vote needs. Two per call is now the default for this provider, and
it lifted a full run from 203 sightings to 310, with players-seen-only-once falling from 139
to 38. It did not rescue the match rate, because more readings of a name do not help when the
readings disagree with each other rather than converging.

There is no fallback model configured: `llama-3.2-11b-vision-instruct` refuses every request
until Meta's terms are accepted by hand in the Cloudflare dashboard.

Use it if you want everything on one Cloudflare account with no keys anywhere, and you are
willing to confirm more names by hand. For accuracy, use Gemini.

| provider | free vision | notes |
|---|---|---|
| **Gemini** | 20/day per model, 7 models | default; measured 40/40 on a real recording |
| **Groq — Qwen** | 1000/day but 8k tokens/min | accurate and fast per call, slow in bulk |
| **OpenRouter** | ~50 requests/day | 8 free vision models |
| **Mistral** | free tier | Pixtral |
| **Cloudflare** | 10k neurons/day | via the Worker only; untested against a real account |
| **Anthropic** | paid | no free tier |

