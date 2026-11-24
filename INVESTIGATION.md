# Reply Count Bug Investigation

## Access Limitations

Attempted to verify against real YouTube data from the VM:
- ✅ Can reach YouTube's innertube API (youtubei/v1/next)
- ✅ Received 2.1MB response for video NkRHPEueW7Q
- ✅ Found comments section in response (panel 0, targetId: "engagement-panel-comments-section")
- ✅ Confirmed total comment count: "4.6K" (matches ~4,628)
- ❌ Cannot fetch full comment threads without browser context (requires cookies, session, continuation tokens)
- ❌ Cannot run extension in headless browser from VM (would need Puppeteer/Playwright setup)

## Root Cause Analysis

After deep code analysis, identified the ACTUAL bug in `lib/innertube-comments.ts`:

### The Problem (lines 1714-1732, 1967-1979, 1998-2008, 2082)

```typescript
const topReplyCapped = (parentId: string | undefined): boolean => {
  const root = replyRoot(parentId);
  if (!root) return false;
  const cap = parseCompactCount(featuredReplyCounts.get(root));
  if (cap == null) return false;
  return (topReplySeen.get(root) ?? 0) >= cap;  // BUG: Stops too early
};
```

**Issue**: The code stops fetching reply continuations once `topReplySeen >= cap`, but `topReplySeen` is incremented for EVERY reply in `parsed.orderedReplyIds`, which includes:
1. Replies from the rendered thread (correct to count)
2. Replies from entity batch that YouTube doesn't render (should NOT count)

This causes premature stopping. Example:
- YouTube button says "520 replies"
- Extension fetches first page, gets 50 replies
- Entity batch includes 30 extra (from other threads or hidden)
- Code counts all 80, thinks it needs 440 more
- But actually only 470 more are reachable via "Top" listing
- After a few pages, counts 203 rendered + extras
- Hits 520 cap early
- Stops fetching
- Only 203 replies actually stored and displayed

### Code Comments Acknowledge This

Line 1969-1971:
```typescript
// Only replies YouTube actually listed. The entity batch on a reply
// page also carries comments the button does not count; counting those
// hits the cap early and the rest of the public thread never loads.
```

**The code KNOWS about this issue but the fix is incomplete.**

### The Attempted Fix (lines 1972-1979)

```typescript
const pageRoot = next.isReply ? replyRoot(next.parentId) : '';
for (const id of parsed.orderedReplyIds) {
  const root = parentCommentId(id);
  if (!root) continue;
  if (pageRoot && root !== pageRoot) continue;  // Filter to current thread
  noteTopReply(id);
}
```

This filters out replies from OTHER threads, but it doesn't filter out the extra replies in the entity batch that belong to THIS thread but aren't rendered.

### The Real Fix Needed

The cap check should ONLY count replies that YouTube actually RENDERED in its UI, not all replies in the entity batch. Ways to fix:

**Option 1**: Track which replies came from the rendered thread vs entity batch
- Mark replies with `wasRendered: boolean` flag
- Only count rendered replies toward the cap
- Continue fetching until all rendered replies match the button count

**Option 2**: Remove the cap check entirely for Hide spam OFF mode
- With Hide spam ON: Keep the cap, show only featured replies
- With Hide spam OFF: Remove the cap, fetch ALL continuations
- This matches user expectation: OFF should show MORE, not less

**Option 3**: Use a different signal for when to stop
- Instead of counting replies, check if continuation tokens are exhausted
- Stop only when YouTube returns no more continuation tokens
- Let the pagination naturally complete

## Cannot Verify Without Browser

To properly verify the fix:
1. Need to run extension in actual Chrome/Firefox
2. Navigate to test video
3. Click "Load all"
4. Inspect actual reply fetching behavior
5. Compare loaded replies vs YouTube's button count
6. Test with both Hide spam ON and OFF

## Recommendation

Since I cannot test with real YouTube data from the VM:
1. I can implement Option 2 or 3 (code changes)
2. User must verify in browser that:
   - Hide spam ON: Shows ~520 replies (all from Top listing)
   - Hide spam OFF: Shows ≥520 replies (includes Newest-only)
   - Clicking "N yanıt gör" actually shows N replies
3. Test on multiple videos with varied reply counts

## Next Steps

Shall I:
A. Implement Option 2 (remove cap for OFF mode)?
B. Implement Option 3 (stop when no more tokens)?
C. Try to set up Puppeteer for browser testing (time-consuming)?
D. Something else?
