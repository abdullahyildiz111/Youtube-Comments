// Headed Chromium + unpacked extension. Run on a machine YouTube does not
// block (this cloud VM usually gets HTTP 403).
//
//   npm run build
//   npx playwright install chromium   # first time only
//   npx tsx scripts/e2e-extension.mts 4Unch--PmW0 --hl=tr
//
// Opens the watch page, opens the extension popup, clicks Load all, waits for
// the crawl, then prints reply diagnostics (button / topServed / keptOff).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const extensionPath = join(root, '.output', 'chrome-mv3');
const args = process.argv.slice(2);
const videoId = args.find((arg) => !arg.startsWith('--'));
const hl = args.find((arg) => arg.startsWith('--hl='))?.split('=')[1] ?? 'tr';
if (!videoId) {
  throw new Error('usage: e2e-extension.mts <videoId> [--hl=tr]');
}
if (!existsSync(join(extensionPath, 'manifest.json'))) {
  throw new Error(`Build the extension first: npm run build (missing ${extensionPath})`);
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    console.error('Installing playwright…');
    const install = spawnSync('npm', ['install', '-D', 'playwright'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (install.status !== 0) throw new Error('npm install playwright failed');
    const browsers = spawnSync('npx', ['playwright', 'install', 'chromium'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (browsers.status !== 0) throw new Error('playwright install chromium failed');
    return import('playwright');
  }
}

const { chromium } = await loadPlaywright();
const userDataDir = mkdtempSync(join(tmpdir(), 'cc-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  // Extensions need a headed context in Chromium.
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

const extensionId = async () => {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  return worker.url().split('/')[2];
};

try {
  const id = await extensionId();
  const page = await context.newPage();
  const url = `https://www.youtube.com/watch?v=${videoId}&hl=${hl}&persist_hl=1`;
  console.log(`opening ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForTimeout(4_000);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForTimeout(2_000);

  // Turn on Debug replies if the control is present, then load all.
  const debug = popup.locator('label.debug-switch input[type="checkbox"]');
  if (await debug.count()) {
    if (!(await debug.isChecked())) await debug.click();
  }
  const loadAll = popup.getByRole('button', { name: /Load all|Tümünü yükle/i });
  if (await loadAll.count()) await loadAll.click();

  const deadline = Date.now() + 600_000;
  let report: {
    capturedCount?: number;
    fetchedAll?: boolean;
    truncated?: boolean;
    extrasHidden?: number;
    threads?: Array<Record<string, unknown>>;
  } | null = null;

  while (Date.now() < deadline) {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('comment-catcher:request-diagnostics'));
    });
    report = await page.evaluate(() => {
      const node = document.getElementById('comment-catcher-diagnostics');
      if (!node?.textContent) return null;
      try {
        return JSON.parse(node.textContent);
      } catch {
        return null;
      }
    });
    if (report?.fetchedAll && (report.capturedCount ?? 0) > 0) break;
    await page.waitForTimeout(3_000);
  }

  if (!report?.fetchedAll) {
    throw new Error(
      'Timed out waiting for a finished crawl. Check the popup, click Load all, enable Debug replies.',
    );
  }

  console.log(
    JSON.stringify(
      {
        loaded: report.capturedCount,
        fetchedAll: report.fetchedAll,
        truncated: report.truncated,
        extrasHidden: report.extrasHidden,
      },
      null,
      2,
    ),
  );
  console.log('author\tbutton\ttoolbar\tloaded\ttopServed\tnewestOnly\tkeptOff\thiddenOff');
  for (const thread of report.threads ?? []) {
    console.log(
      [
        thread.author,
        thread.button,
        thread.toolbar,
        thread.loaded,
        thread.topServed,
        thread.newestOnly,
        thread.keptOff,
        thread.hiddenOff,
      ].join('\t'),
    );
  }
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
