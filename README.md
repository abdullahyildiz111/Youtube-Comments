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
- YouTube's on-page total is an estimate. Hidden, held-for-review, and some
  low-ranked comments are often never returned.
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
