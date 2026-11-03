// Shared setup for the browser-driven tests and benchmarks: load Playwright
// and make sure the generated demo video exists, with clear instructions
// instead of stack traces when something is missing.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));

function fail(lines) {
  console.error(`\n${lines.join('\n')}\n`);
  process.exit(1);
}

export function loadChromium() {
  const require = createRequire(import.meta.url);
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    fail([
      'Playwright is not installed. From the project folder run:',
      '  npm install',
      '  npm run setup:browser     # downloads the Chromium build Playwright drives (once)',
    ]);
  }
  return playwright.chromium;
}

/** Launch errors that mean the browser binary has not been downloaded yet. */
export function explainLaunchError(e) {
  if (/Executable doesn't exist|browserType\.launch|playwright install/i.test(String(e?.message))) {
    fail(['Playwright\'s Chromium is not downloaded yet. Run:', '  npm run setup:browser']);
  }
  throw e;
}

export function requireFfmpeg(purpose) {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    fail([`ffmpeg is needed to ${purpose}.`, '  macOS:  brew install ffmpeg', '  Debian/Ubuntu:  sudo apt install ffmpeg']);
  }
}

/** server/public/demo.webm is generated, not committed. */
export function ensureDemoVideo() {
  const file = join(root, 'server/public/demo.webm');
  if (!existsSync(file)) {
    requireFfmpeg('generate the demo video');
    execFileSync('sh', [join(root, 'scripts/make-demo-video.sh')], { stdio: 'inherit' });
  }
  return file;
}
