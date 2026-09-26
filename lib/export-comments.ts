import {
  MAX_FETCHED_COMMENTS,
  type CommentNode,
  type CommentThread,
  type YouTubeComment,
} from '@/lib/comments';

export interface CommentExportRow {
  depth: number;
  comment: YouTubeComment;
  replyToAuthor: string;
}

export interface CommentExportMeta {
  videoTitle: string;
  channelName: string;
  pageUrl: string;
  sortLabel: string;
  spamHidden: boolean;
  fetchedAll: boolean;
  truncated: boolean;
  exportedAt: Date;
}

const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;
const PAGE_SCALE = 2;
const MARGIN_X = 48;
const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 42;
const BRANCH_STEP = 22;
const BRANCH_COLOR = '#c8c8c8';
const FONT = '"Segoe UI", Arial, sans-serif';

// Depth-first, matching the branches on screen. replyToAuthor is whoever
// this comment is nested under, so a reply-to-a-reply names that reply.
export function rowsForExport(threads: CommentThread[]): CommentExportRow[] {
  const rows: CommentExportRow[] = [];

  const walk = (nodes: CommentNode[], depth: number, parentAuthor: string) => {
    for (const node of nodes) {
      rows.push({
        depth,
        comment: node.comment,
        replyToAuthor: parentAuthor,
      });
      walk(node.children, depth + 1, node.comment.author);
    }
  };

  for (const thread of threads) {
    rows.push({
      depth: 0,
      comment: thread.parent,
      replyToAuthor: '',
    });
    walk(thread.tree, 1, thread.parent.author);
  }

  return rows;
}

export function commentExportFileName(
  title: string,
  extension: 'csv' | 'pdf',
): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${cleaned || 'youtube-comments'}.${extension}`;
}

function scopeLabel(meta: CommentExportMeta): string {
  if (meta.truncated) {
    return `First ${MAX_FETCHED_COMMENTS.toLocaleString()} comments`;
  }
  if (meta.fetchedAll) return 'All loaded comments';
  return 'Comments captured so far';
}

function csvCell(value: string): string {
  // A leading = + - or @ becomes a formula when the file is opened in Excel.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe) || safe !== value) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function commentsToCsv(
  rows: CommentExportRow[],
  meta: CommentExportMeta,
): string {
  const spam = meta.spamHidden ? 'Hidden' : 'Shown';
  const header = [
    'Video title',
    'Video URL',
    'Channel',
    'Sort',
    'Spam filter',
    'Depth',
    'Author',
    'In reply to',
    'Published',
    'Likes',
    'Replies',
    'Pinned',
    'Creator heart',
    'Text',
    'Comment URL',
  ];

  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    const comment = row.comment;
    lines.push(
      [
        meta.videoTitle,
        meta.pageUrl,
        meta.channelName,
        meta.sortLabel,
        spam,
        String(row.depth),
        comment.author,
        row.replyToAuthor,
        comment.publishedAt,
        comment.likeCount ?? '0',
        row.depth === 0 ? (comment.replyCount ?? '') : '',
        comment.isPinned ? 'Yes' : '',
        comment.isCreatorHearted ? 'Yes' : '',
        comment.text,
        comment.permalink ?? '',
      ]
        .map((value) => csvCell(value))
        .join(','),
    );
  }

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  const paragraphs = text.replace(/\r\n/g, '\n').split('\n');

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let line = '';
    const pushLongWord = (word: string) => {
      let chunk = '';
      for (const char of word) {
        const trial = chunk + char;
        if (ctx.measureText(trial).width > maxWidth && chunk) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk = trial;
        }
      }
      line = chunk;
    };

    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      if (ctx.measureText(word).width > maxWidth) pushLongWord(word);
      else line = word;
    }
    if (line) lines.push(line);
  }

  return lines.length > 0 ? lines : [''];
}

function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let value = text;
  while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}…`;
}

interface PdfPage {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  y: number;
}

function createPdfPage(runningTitle: string): PdfPage {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_WIDTH * PAGE_SCALE;
  canvas.height = PAGE_HEIGHT * PAGE_SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare the PDF page.');

  ctx.scale(PAGE_SCALE, PAGE_SCALE);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  ctx.textBaseline = 'top';

  const page: PdfPage = { canvas, ctx, y: MARGIN_TOP };
  if (!runningTitle) return page;

  ctx.fillStyle = '#9a9aa1';
  ctx.font = `11px ${FONT}`;
  ctx.fillText(
    fitText(ctx, runningTitle, PAGE_WIDTH - MARGIN_X * 2),
    MARGIN_X,
    20,
  );
  page.y = 42;
  return page;
}

function sealPdfPage(page: PdfPage, pageNumber: number): Promise<Uint8Array> {
  const { ctx, canvas } = page;
  ctx.fillStyle = '#9a9aa1';
  ctx.font = `11px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText(String(pageNumber), PAGE_WIDTH - MARGIN_X, PAGE_HEIGHT - 26);
  ctx.textAlign = 'left';

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        canvas.width = 0;
        canvas.height = 0;
        if (!blob) {
          reject(new Error('Could not prepare the PDF page.'));
          return;
        }
        void blob.arrayBuffer().then(
          (buffer) => resolve(new Uint8Array(buffer)),
          reject,
        );
      },
      'image/jpeg',
      0.86,
    );
  });
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// One JPEG per page. System fonts draw the text, so Turkish and other
// scripts stay intact without embedding a font file.
export function buildJpegPdf(
  images: Uint8Array[],
  pixelWidth: number,
  pixelHeight: number,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    length += bytes.length;
  };
  const pushText = (value: string) => push(encoder.encode(value));

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const offsets: number[] = [];
  const objectCount = 2 + images.length * 3;

  pushText('%PDF-1.4\n');
  // Marks the file as binary. These four bytes must not be UTF-8 encoded.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const startObject = (id: number) => {
    offsets[id] = length;
    pushText(`${id} 0 obj\n`);
  };
  const endObject = () => pushText('endobj\n');

  startObject(1);
  pushText('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObject();

  const pageObjectId = (index: number) => 3 + index * 3;
  startObject(2);
  const kids = images
    .map((_, index) => `${pageObjectId(index)} 0 R`)
    .join(' ');
  pushText(
    `<< /Type /Pages /Count ${images.length} /Kids [${kids}] >>\n`,
  );
  endObject();

  images.forEach((image, index) => {
    const pageId = pageObjectId(index);
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;

    startObject(pageId);
    pushText(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\n`,
    );
    endObject();

    startObject(contentId);
    pushText(`<< /Length ${encoder.encode(content).length} >>\nstream\n`);
    pushText(content);
    pushText('endstream\n');
    endObject();

    startObject(imageId);
    pushText(
      `<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`,
    );
    push(image);
    pushText('\nendstream\n');
    endObject();
  });

  const xrefAt = length;
  pushText(`xref\n0 ${objectCount + 1}\n`);
  pushText('0000000000 65535 f \n');
  for (let id = 1; id <= objectCount; id += 1) {
    pushText(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  pushText(
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`,
  );

  return concatBytes(chunks);
}

export async function commentsToPdf(
  rows: CommentExportRow[],
  meta: CommentExportMeta,
): Promise<Blob> {
  const images: Uint8Array[] = [];
  const runningTitle = meta.videoTitle || 'YouTube comments';
  let page = createPdfPage('');
  let pageNumber = 1;
  // A vertical rail stays open while more siblings at that depth are still
  // coming, including ones that continue onto the next page.
  const openRails: Array<{ depth: number; x: number; y: number }> = [];

  const strokeRail = (
    rail: { x: number; y: number },
    toY: number,
  ) => {
    if (toY <= rail.y + 0.5) return;
    page.ctx.save();
    page.ctx.strokeStyle = BRANCH_COLOR;
    page.ctx.lineWidth = 1.25;
    page.ctx.lineCap = 'round';
    page.ctx.beginPath();
    page.ctx.moveTo(rail.x, rail.y);
    page.ctx.lineTo(rail.x, toY);
    page.ctx.stroke();
    page.ctx.restore();
    rail.y = toY;
  };

  const extendRails = (toY: number) => {
    for (const rail of openRails) strokeRail(rail, toY);
  };

  const breakPage = async () => {
    extendRails(PAGE_HEIGHT - MARGIN_BOTTOM);
    images.push(await sealPdfPage(page, pageNumber));
    pageNumber += 1;
    page = createPdfPage(runningTitle);
    for (const rail of openRails) rail.y = page.y;
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  };

  const ensure = async (height: number) => {
    if (page.y + height > PAGE_HEIGHT - MARGIN_BOTTOM) await breakPage();
  };

  const drawLines = async (
    lines: string[],
    x: number,
    font: string,
    color: string,
    lineHeight: number,
  ) => {
    for (const line of lines) {
      await ensure(lineHeight);
      page.ctx.font = font;
      page.ctx.fillStyle = color;
      page.ctx.fillText(line, x, page.y);
      page.y += lineHeight;
    }
  };

  page.ctx.font = `700 20px ${FONT}`;
  const titleLines = wrapText(
    page.ctx,
    runningTitle,
    PAGE_WIDTH - MARGIN_X * 2,
  ).slice(0, 3);
  await drawLines(titleLines, MARGIN_X, `700 20px ${FONT}`, '#17171a', 26);
  page.y += 2;

  const details = [
    meta.channelName,
    meta.sortLabel,
    meta.spamHidden ? 'Spam hidden' : 'Spam shown',
    scopeLabel(meta),
    `${rows.length.toLocaleString()} comments`,
    meta.exportedAt.toLocaleString(),
  ]
    .filter(Boolean)
    .join('   ·   ');
  page.ctx.font = `12px ${FONT}`;
  await drawLines(
    wrapText(page.ctx, details, PAGE_WIDTH - MARGIN_X * 2),
    MARGIN_X,
    `12px ${FONT}`,
    '#6b6b73',
    16,
  );

  if (meta.pageUrl) {
    page.ctx.font = `11px ${FONT}`;
    await drawLines(
      wrapText(page.ctx, meta.pageUrl, PAGE_WIDTH - MARGIN_X * 2).slice(0, 2),
      MARGIN_X,
      `11px ${FONT}`,
      '#9a9aa1',
      15,
    );
  }
  page.y += 14;

  const hasNextSibling = (index: number, depth: number) => {
    for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
      const next = rows[cursor];
      if (!next || next.depth < depth) return false;
      if (next.depth === depth) return true;
    }
    return false;
  };

  const drawElbow = (
    railX: number,
    elbowY: number,
    textX: number,
    continued: boolean,
  ) => {
    const radius = 8;
    const stubTop = continued ? elbowY - radius : elbowY - 16;
    page.ctx.save();
    page.ctx.strokeStyle = BRANCH_COLOR;
    page.ctx.lineWidth = 1.25;
    page.ctx.lineCap = 'round';
    page.ctx.lineJoin = 'round';
    page.ctx.beginPath();
    page.ctx.moveTo(railX, stubTop);
    page.ctx.arcTo(railX, elbowY, textX, elbowY, radius);
    page.ctx.lineTo(textX - 4, elbowY);
    page.ctx.stroke();
    page.ctx.restore();
  };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    const comment = row.comment;
    const room = PAGE_HEIGHT - MARGIN_BOTTOM - page.y;
    if (room < 72 && page.y > MARGIN_TOP + 8) await breakPage();
    const visualDepth = Math.min(row.depth, 6);
    const indent = MARGIN_X + visualDepth * BRANCH_STEP;
    const width = PAGE_WIDTH - MARGIN_X - indent;

    if (row.depth === 0 && index > 0) {
      await ensure(16);
      page.ctx.strokeStyle = '#ececef';
      page.ctx.lineWidth = 1;
      page.ctx.beginPath();
      page.ctx.moveTo(MARGIN_X, page.y + 2);
      page.ctx.lineTo(PAGE_WIDTH - MARGIN_X, page.y + 2);
      page.ctx.stroke();
      page.y += 12;
    } else if (index > 0) {
      page.y += 6;
    }

    if (row.depth > 0) {
      const railX = MARGIN_X + (visualDepth - 1) * BRANCH_STEP + 4;
      const elbowY = page.y + 7;
      const incoming = openRails.findIndex((rail) => rail.depth === row.depth);
      if (incoming >= 0) {
        const rail = openRails[incoming];
        if (rail) strokeRail(rail, elbowY - 8);
        openRails.splice(incoming, 1);
      }
      drawElbow(railX, elbowY, indent, incoming >= 0);
      if (hasNextSibling(index, row.depth)) {
        openRails.push({ depth: row.depth, x: railX, y: elbowY });
      }
    }

    const authorFont = `700 13px ${FONT}`;
    page.ctx.font = authorFont;
    await drawLines(
      wrapText(page.ctx, comment.author || 'Unknown author', width).slice(0, 2),
      indent,
      authorFont,
      '#17171a',
      17,
    );

    const metaBits = [
      comment.publishedAt,
      `${comment.likeCount ?? '0'} likes`,
      row.depth === 0 && comment.replyCount && comment.replyCount !== '0'
        ? `${comment.replyCount} replies`
        : '',
      comment.isPinned ? 'Pinned' : '',
      comment.isCreatorHearted ? 'Creator heart' : '',
    ].filter(Boolean);
    if (metaBits.length > 0) {
      const metaFont = `11px ${FONT}`;
      page.ctx.font = metaFont;
      await drawLines(
        wrapText(page.ctx, metaBits.join('   ·   '), width),
        indent,
        metaFont,
        '#8a8a93',
        15,
      );
    }

    if (row.depth > 0 && row.replyToAuthor) {
      const replyFont = `11px ${FONT}`;
      page.ctx.font = replyFont;
      await drawLines(
        wrapText(page.ctx, `Reply to ${row.replyToAuthor}`, width).slice(0, 2),
        indent,
        replyFont,
        '#d92121',
        15,
      );
    }

    const bodyFont = `13px ${FONT}`;
    page.ctx.font = bodyFont;
    await drawLines(
      wrapText(page.ctx, comment.text || '', width),
      indent,
      bodyFont,
      '#28282c',
      18,
    );
  }

  images.push(await sealPdfPage(page, pageNumber));
  const pdf = buildJpegPdf(
    images,
    PAGE_WIDTH * PAGE_SCALE,
    PAGE_HEIGHT * PAGE_SCALE,
  );
  const buffer = new ArrayBuffer(pdf.byteLength);
  new Uint8Array(buffer).set(pdf);
  return new Blob([buffer], { type: 'application/pdf' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
