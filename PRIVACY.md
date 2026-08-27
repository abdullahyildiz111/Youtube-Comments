# Privacy

Comment Catcher can read comments already painted on a YouTube video page and
can also request the comment thread from YouTube so you do not have to scroll.
It does not transmit anything until the user selects **Summarize all comments**
or asks a question in **Ask the comments**.

## Requests to YouTube

Comment requests are signed the same way youtube.com signs its own, using the
SAPISID cookie already present in the tab. YouTube ranks "Top" per viewer, so
an unsigned request comes back in the signed-out ranking and the order will not
match the page.

- The signature is built inside the YouTube page and sent only to youtube.com.
- It is derived from the cookie of whoever is signed in on that computer. Each
  installation uses its own browser session. No account, cookie, or signature
  is bundled into the extension, shared between installations, or sent to the
  summary API or any other server.
- The cookie value itself is never transmitted; only a timestamped SHA-1 hash
  of it, which is what youtube.com sends.
- If the cookie is unavailable the thread still loads, in the signed-out order.

The extension can only show comments YouTube itself returns in its Top or
Newest listing. Comments YouTube has removed or is holding for review are never
part of that data.

## Data sent for a summary or chat

- YouTube video ID and title
- Captured comment text
- Whether each captured item is a reply
- For chat, the question and recent conversation turns

The extension sends this data to the summary API you host (Coolify on a Hetzner
VPS by default). That API forwards the text to the Google Gemini API. Request
bodies are not stored. The client IP is used only for short-lived rate limiting.

Gemini free-tier requests may be used by Google to improve its products. Review
the current Google Gemini API terms before deploying this extension.

## Local storage

Generated summaries, chat transcripts, video IDs, comment counts, and
generation timestamps are stored in browser-local extension storage for up to
20 recent videos. Removing the extension clears this storage.

## Secrets

The Gemini API key is stored only as a Coolify / server environment variable.
It is never included in extension source code, builds, or network responses.
