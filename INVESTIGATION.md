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

## Implemented Fix

**Chose Option 3**: Removed the cap check entirely, rely on continuation token exhaustion.

### Changes Made (lib/innertube-comments.ts)

1. **Line 1732 in `enqueue()`**: Commented out the cap check
   ```typescript
   // if (next.sort === 'top' && next.isReply && topReplyCapped(next.parentId)) return;
   ```

2. **Lines 1998-2004**: Removed `stopTopReplies` logic
   ```typescript
   const continuations = next.isReply
     ? [...parsed.replyTokens, ...parsed.pageTokens]
     : [...parsed.pageTokens, ...parsed.replyTokens];
   ```

3. **Line 2082**: Commented out cap check in reply queue processing
   ```typescript
   // if (next.sort === 'top' && next.isReply && topReplyCapped(next.parentId)) continue;
   ```

### Why This Works

- **Before**: Stopped fetching when counted replies >= button total
  - Counted entity batch replies that YouTube doesn't render
  - Hit cap at 520 seen, but only ~203 rendered
  - Stopped pagination, missing 317+ visible replies

- **After**: Fetches ALL continuation tokens
  - No premature stopping based on counts
  - Pagination continues until YouTube has no more tokens
  - UI filtering (`selectShownReplies`) handles Hide spam mode
  - Complete threads are fetched for both modes

### Testing Required

User must verify in browser:
1. Build extension: `npm run build`
2. Load in Chrome/Firefox
3. Navigate to https://www.youtube.com/watch?v=NkRHPEueW7Q
4. Click "TÜMÜNÜ YÜKLE" (Load all)
5. Verify counts:
   - Hide spam ON: Should show ~520 replies for top comment
   - Hide spam OFF: Should show ≥520 replies
   - Click "520 yanıt gör" should expand and show ~520 replies
6. Test on other videos (large, small, non-English)

### Potential Issues

1. **Performance**: Fetching ALL replies may be slower for huge threads
   - Extension already has safety limits (500K comments, 200K pages)
   - Most videos won't hit these limits

2. **Rate limiting**: More API calls might trigger YouTube's rate limits
   - Extension already has retry logic with backoff
   - Pauses after 429 responses

3. **Memory**: Storing more replies uses more memory
   - Should be fine for typical use cases
   - Very large threads (10K+ replies) might be slow

### Why Previous "Fix" Was Wrong

The previous fix only changed UI labeling to show `featuredReplyCount` instead of `replies.length`. That made the COUNT LABEL correct, but clicking the button still only showed ~203 replies because the data wasn't fetched. This fix ensures the data is actually fetched.

## Next Steps

Since I cannot test in a browser:
1. User needs to test with real videos
2. Create verification table comparing:
   - YouTube's displayed count
   - Extension's count (Hide spam ON)
   - Extension's count (Hide spam OFF)
   - Actual replies when expanded
3. Report any remaining discrepancies
