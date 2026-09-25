# Comment Catcher for YouTube

A WXT, React, and TypeScript browser extension that collects comments as
YouTube loads them on a video page and summarizes the captured discussion in
one paragraph. Summaries use Gemini 3.5 Flash-Lite through a small API you
deploy on Coolify / your Hetzner VPS.

## Run locally

1. Create a free Gemini API key at [Google AI Studio](https://aistudio.google.com/apikey).
2. Copy `backend/.env.example` to `backend/.env` and paste the key:

```dotenv
GEMINI_API_KEY=your_key_here
```

3. Copy `.env.example` to `.env` for the extension:

```dotenv
WXT_SUMMARY_API_URL=http://localhost:3000/summarize
```

4. Start the backend and extension in separate terminals:

```bash
npm install
npm run backend:dev
```

```bash
npm run dev
```

WXT opens a browser with the extension installed. Open a YouTube video, then
use **Load all comments** or **Summarize all comments**. Refresh the YouTube
tab once after installing or updating the extension.

Use `npm run build` to create a production Chromium build in `.output/`.

## Current collection behavior

- No YouTube API key is required.
- **Load all comments** asks YouTube for the comment thread directly, so you
  do not need to scroll the page. The same action runs automatically before
  **Summarize all comments**.
- Replies are loaded in small parallel batches after the main thread. The
  fetch is capped at 2,000 comments.
- The popup has the same **Sort by** control YouTube puts above its comments,
  with the same two options: **Top** and **Newest**. "Top" is a ranking
  YouTube computes on its side, not a like-count sort, so the extension asks
  YouTube for both orders and lists comments in the position YouTube gave
  them. Switching between the two is instant and refetches nothing.
- Because both orders are requested, a video costs roughly twice as many
  top-level page requests as before. Replies are still fetched once.
- Comments that YouTube's "Top" ranking leaves out are still kept. They are
  listed after the ranked ones instead of being dropped. The **Hide spam**
  switch drops them from the list and from what gets summarized.
- Reply continuations inherit the sort of the listing they were found on, so
  the Top chain returns YouTube's moderated replies and the Newest chain
  returns the same thread plus what YouTube keeps out of it. That difference
  is where banned and held-for-review replies live, and it is what **Hide
  spam** removes. On one sampled thread YouTube reported 27 replies under Top
  and 31 under Newest, and the four extras were exactly the hidden ones.
- Replies are only dropped when the remaining count matches the reply total
  YouTube's own Top listing reports. A thread the Top pass has not fully
  walked is left whole rather than guessing, and the switch does nothing until
  the full thread has loaded.
- The switch is YouTube's judgement, not the extension's. The set it hides
  also contains ordinary comments with no likes, so it is not a perfect spam
  classifier.
- Pinned comments show YouTube's own wording ("Pinned by @channel"), and
  verified authors, channel-owner authors and creator hearts are marked. None
  of these arrive on the comment record itself: pinning is sent on the
  rendered thread and the heart in a separate toolbar entity, so they are read
  from there and merged in.
- Replies are shown as a tree with the same connector lines YouTube draws,
  and the nesting is not capped. YouTube returns every reply in a thread at
  the same depth, so the structure is rebuilt from the handle each reply opens
  with, which is what YouTube itself keys on. Real threads reach eleven levels
  on a busy video.
- The popup is 420px wide against YouTube's thousand or more, so the first few
  levels use YouTube's spacing and the step narrows after that. Deep replies
  keep their connector without squeezing the text away.
- YouTube's on-page total is an estimate. Hidden, held-for-review, and some
  low-ranked comments are often never returned.
- Requests are signed the same way youtube.com signs its own, using the
  SAPISID cookie already in the tab. YouTube ranks "Top" per viewer, so an
  unsigned request comes back in the signed-out ranking and the order will not
  match the page. The signature is built in the page and sent only to
  youtube.com. If the cookie is unavailable the thread still loads, just in
  the signed-out order.
- Reply counts come from YouTube and can differ from the number the page
  showed when it loaded, because the page does not refresh them. YouTube's own
  Top and Newest pages sometimes disagree by a reply or two as well.
- These requests use the same YouTube session as the tab. Loading one video is
  similar to scrolling the comments section quickly. Do not hammer many videos
  in a row.
- Visible comments on the page are still captured in the background and merged
  into the same list.
- Turn on **Auto** in the popup to fetch and summarize each new video as it
  opens. Open the popup to read the paragraph. Leave Auto off to summarize
  only when you click the button.
- Navigation between videos is handled without requiring a full page reload.

## Cloud AI summaries

- Select **Summarize all comments** in the popup. The extension loads the
  thread from YouTube first, then sends that set to Gemini.
- The extension sends only the video ID, title, comment text, and reply flags.
- The Gemini key lives only on the VPS as a Coolify environment variable. It
  is never bundled into the extension.
- The API validates request sizes, rate-limits each IP to five summaries per
  minute, and treats comments as untrusted content.
- Gemini free-tier requests may be used by Google to improve its products.
- Completed summaries are cached locally for the 20 most recent videos.

## Deploy on Coolify

Coolify must build the API, not the Chrome extension. In the application
**Build** settings:

- Build pack: **Dockerfile** (not Nixpacks)
- Base directory: `/` (repo root)
- Dockerfile: `Dockerfile`
- Port: `3000`

If Coolify stays on Nixpacks, `nixpacks.toml` still builds `backend/` instead
of the extension.

Then:

1. Push this repository to GitHub/GitLab, or point Coolify at the local repo.
2. Create a new Coolify application with the build settings above.
3. Add these environment variables in Coolify:

```dotenv
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.5-flash-lite
RATE_LIMIT_PER_MINUTE=5
```

4. Assign a domain such as `https://summary.yourdomain.com`.
5. Put that URL in the extension `.env` and rebuild:

```dotenv
WXT_SUMMARY_API_URL=https://summary.yourdomain.com/summarize
```

Then run `npm run zip`. The backend URL is public and safe to bundle;
`GEMINI_API_KEY` is not.

Optional: set matching `EXTENSION_API_TOKEN` on Coolify and
`WXT_SUMMARY_API_TOKEN` in the extension `.env` so random visitors cannot
use your Gemini quota. Rate limiting still applies either way. For a
store-scale public release, add real user authentication.
