/**
 * Test script to fetch real data from YouTube's innertube API
 * and verify reply count behavior
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';

// YouTube innertube API endpoint
const YOUTUBE_API = 'https://www.youtube.com/youtubei/v1/next';

interface InnertubeContext {
  client: {
    clientName: string;
    clientVersion: string;
  };
}

// Test with a real API call
async function fetchYouTubeComments(videoId: string) {
  console.log(`\nFetching comments for video: ${videoId}`);
  console.log('='.repeat(80));
  
  try {
    const context: InnertubeContext = {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20241120.01.00',
      },
    };

    const response = await fetch(`${YOUTUBE_API}?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        context,
        videoId,
      }),
    });

    if (!response.ok) {
      console.error(`HTTP ${response.status}: ${response.statusText}`);
      return null;
    }

    const text = await response.text();
    // Remove )]}' prefix if present
    const jsonText = text.startsWith(')]}\'') ? text.substring(4) : text;
    const data = JSON.parse(jsonText);
    
    // Save response for analysis
    const fs = await import('fs/promises');
    await fs.writeFile(`/tmp/youtube-response-${videoId}.json`, JSON.stringify(data, null, 2));
    console.log(`Saved response to /tmp/youtube-response-${videoId}.json`);
    
    return data;
  } catch (error) {
    console.error('Error fetching from YouTube API:', error);
    return null;
  }
}

// Extract comment data from YouTube response
function analyzeResponse(data: any, videoId: string) {
  if (!data) {
    console.log('No data received');
    return;
  }

  console.log('\nAnalyzing YouTube API response...');
  
  // Find the comments section
  const engagementPanels = data?.engagementPanels || [];
  let commentsSection: any = null;
  
  for (const panel of engagementPanels) {
    if (panel?.engagementPanelSectionListRenderer) {
      const renderer = panel.engagementPanelSectionListRenderer;
      if (renderer?.header?.engagementPanelTitleHeaderRenderer) {
        const header = renderer.header.engagementPanelTitleHeaderRenderer;
        if (header?.contextualInfo?.runs?.[0]?.text?.includes('comment')) {
          commentsSection = renderer;
          break;
        }
      }
    }
  }

  if (!commentsSection) {
    console.log('Could not find comments section in response');
    console.log('Available engagement panels:', engagementPanels.length);
    return;
  }

  // Extract comment count from header
  const header = commentsSection.header?.engagementPanelTitleHeaderRenderer;
  const totalCommentsText = header?.contextualInfo?.runs?.[0]?.text || 'Unknown';
  console.log(`Total comments: ${totalCommentsText}`);

  // Find comments in content
  const content = commentsSection.content;
  const sectionRenderer = content?.sectionContents ||
                         content?.continuationItemsRenderer ||
                         content?.engagementPanelSectionListRenderer;
  
  console.log('\nTop comments in initial response:');
  
  let commentCount = 0;
  const replyInfo: Array<{author: string; replyCount: string; replyToken: string | null}> = [];

  function extractComments(contents: any[], depth = 0) {
    if (!contents || depth > 3) return;
    
    for (const item of contents) {
      if (item?.commentThreadRenderer) {
        commentCount++;
        const thread = item.commentThreadRenderer;
        const comment = thread.comment?.commentRenderer;
        const author = comment?.authorText?.simpleText || 'Unknown';
        const text = comment?.contentText?.runs?.[0]?.text?.substring(0, 50) || '';
        
        // Check for reply button
        const replies = thread.replies?.commentRepliesRenderer;
        const viewReplies = replies?.viewReplies?.buttonRenderer;
        const replyText = viewReplies?.text?.simpleText || '';
        const replyToken = replies?.contents?.[0]?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        
        console.log(`${commentCount}. ${author}: ${text}...`);
        if (replyText) {
          console.log(`   Replies: ${replyText}`);
          replyInfo.push({ author, replyCount: replyText, replyToken: replyToken || null });
        }
      } else if (item?.commentRenderer) {
        // Nested reply
        const comment = item.commentRenderer;
        const author = comment?.authorText?.simpleText || 'Unknown';
        console.log(`  Reply by ${author}`);
      }
    }
  }

  // Try different possible locations for comments
  if (sectionRenderer?.contents) {
    extractComments(sectionRenderer.contents);
  }
  if (content?.continuationItems) {
    extractComments(content.continuationItems);
  }

  console.log(`\nTotal comments found in initial response: ${commentCount}`);
  console.log(`\nComments with reply buttons: ${replyInfo.length}`);
  
  return { totalCommentsText, commentCount, replyInfo };
}

// Test videos
const TEST_VIDEOS = [
  {
    id: 'NkRHPEueW7Q',
    name: 'Repro video (Turkish, ~4,628 comments)',
    expected: { topComment: 520, secondComment: 88 },
  },
];

async function main() {
  console.log('YouTube API Reply Count Test');
  console.log('='.repeat(80));
  
  for (const video of TEST_VIDEOS) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Video: ${video.name}`);
    console.log(`URL: https://www.youtube.com/watch?v=${video.id}`);
    
    const data = await fetchYouTubeComments(video.id);
    if (data) {
      const analysis = analyzeResponse(data, video.id);
      
      if (analysis) {
        console.log('\n' + '-'.repeat(80));
        console.log('EXPECTED vs ACTUAL:');
        console.log(`Expected top comment replies: ${video.expected.topComment}`);
        console.log(`Expected second comment replies: ${video.expected.secondComment}`);
        
        if (analysis.replyInfo[0]) {
          console.log(`\nActual top comment: ${analysis.replyInfo[0].author}`);
          console.log(`  Reply count text: ${analysis.replyInfo[0].replyCount}`);
          console.log(`  Has continuation token: ${analysis.replyInfo[0].replyToken ? 'YES' : 'NO'}`);
        }
        
        if (analysis.replyInfo[1]) {
          console.log(`\nActual second comment: ${analysis.replyInfo[1].author}`);
          console.log(`  Reply count text: ${analysis.replyInfo[1].replyCount}`);
          console.log(`  Has continuation token: ${analysis.replyInfo[1].replyToken ? 'YES' : 'NO'}`);
        }
      }
    }
    
    // Delay between requests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('Test complete');
  console.log('\nNote: This test only fetches the initial page.');
  console.log('Full thread fetching requires following continuation tokens.');
  console.log('The extension should be fetching ALL replies via continuations.');
}

main().catch(console.error);
