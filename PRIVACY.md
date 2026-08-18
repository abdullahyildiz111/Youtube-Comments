# Privacy

Comment Catcher can read comments already painted on a YouTube video page and
can also request the comment thread from YouTube so you do not have to scroll.
It does not transmit anything until the user selects **Summarize all comments**.

## Data sent for a summary

- YouTube video ID and title
- Captured comment text
- Whether each captured item is a reply

The extension sends this data to the summary API you host (Coolify on a Hetzner
VPS by default). That API forwards the text to the Google Gemini API. Request
bodies are not stored. The client IP is used only for short-lived rate limiting.

Gemini free-tier requests may be used by Google to improve its products. Review
the current Google Gemini API terms before deploying this extension.

## Local storage

Generated summaries, video IDs, comment counts, and generation timestamps are
stored in browser-local extension storage for up to 20 recent videos. Removing
the extension clears this storage.

## Secrets

The Gemini API key is stored only as a Coolify / server environment variable.
It is never included in extension source code, builds, or network responses.
