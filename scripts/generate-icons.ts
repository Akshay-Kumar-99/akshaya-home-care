import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

// Builds every brand image from the owner's logo (assets/brand/akshaya-logo.jpg, gold rings and
// black script on white). Run after changing the logo: npm run icons.
// It uses the headless Chromium that Playwright already installs, so no image library is needed.
//
// Output (src/web/public/, served and cached for offline use):
//   brand/logo-light.png  transparent, black lettering: for the light theme (3:2, cropped to the art)
//   brand/logo-dark.png   transparent, white lettering, brighter gold: for the dark theme (3:2)
//   icons/icon-192.png, icons/icon-512.png, icons/maskable-512.png, icons/apple-touch-icon.png,
//   favicon.png           the logo on white, as the owner supplied it

const root = path.resolve(import.meta.dirname, '..');
const source = readFileSync(path.join(root, 'assets/brand/akshaya-logo.jpg')).toString('base64');
const out = path.join(root, 'src/web/public');

interface Job {
  file: string;
  /** Output height; width is the same for icons and 1.5x for the logo images. */
  size: number;
  /** transparent: cut out the white; ink: recolour the black lettering; bg: fill colour. */
  mode: { kind: 'transparent'; ink: 'dark' | 'light' } | { kind: 'solid'; bg: string; scale: number; round?: boolean };
}

const jobs: Job[] = [
  { file: 'brand/logo-light.png', size: 240, mode: { kind: 'transparent', ink: 'dark' } },
  { file: 'brand/logo-dark.png', size: 240, mode: { kind: 'transparent', ink: 'light' } },
  { file: 'icons/icon-192.png', size: 192, mode: { kind: 'solid', bg: '#ffffff', scale: 0.96 } },
  { file: 'icons/icon-512.png', size: 512, mode: { kind: 'solid', bg: '#ffffff', scale: 0.96 } },
  // Maskable: launchers may crop to a circle of 80 % diameter; the whole logo stays inside it.
  { file: 'icons/maskable-512.png', size: 512, mode: { kind: 'solid', bg: '#ffffff', scale: 0.78 } },
  { file: 'icons/apple-touch-icon.png', size: 180, mode: { kind: 'solid', bg: '#ffffff', scale: 0.9 } },
  { file: 'favicon.png', size: 64, mode: { kind: 'solid', bg: '#ffffff', scale: 1, round: true } },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const images: Record<string, string> = await page.evaluate(
    async ({ src, jobs }) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${src}`;
      await img.decode();
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const base = document.createElement('canvas');
      base.width = W;
      base.height = H;
      const bctx = base.getContext('2d')!;
      bctx.drawImage(img, 0, 0);
      const pixels = bctx.getImageData(0, 0, W, H);
      const d = pixels.data;

      // "Colour to alpha" against white: keeps the soft edges of the script and the gold dust.
      // A small floor removes JPEG noise in the white background.
      const cut = new ImageData(W, H);
      const c = cut.data;
      let minX = W, minY = H, maxX = 0, maxY = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
        let a = Math.max(255 - r, 255 - g, 255 - b) / 255;
        a = Math.max(0, (a - 0.06) / 0.94);
        if (a > 0) {
          for (let k = 0; k < 3; k++) c[i + k] = Math.max(0, Math.min(255, (d[i + k]! - 255 * (1 - a)) / a));
          c[i + 3] = Math.round(a * 255);
        }
        if (a > 0.15) {
          const p = i / 4;
          const x = p % W, y = Math.floor(p / W);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
      // Square crop around the artwork (icons), and a 3:2 crop (logo images: the script is
      // wider than the rings, so a square would shrink it), both with a little breathing room.
      const side = Math.round(Math.max(maxX - minX, maxY - minY) * 1.06);
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const crop = { x: cx - side / 2, y: cy - side / 2, s: side };
      const wideW = (maxX - minX) * 1.04;
      const wideH = Math.max((maxY - minY) * 1.04, wideW / 1.5);
      const wide = { x: cx - (wideH * 1.5) / 2, y: cy - wideH / 2, w: wideH * 1.5, h: wideH };

      const canvasOf = (data: ImageData) => {
        const cv = document.createElement('canvas');
        cv.width = W;
        cv.height = H;
        cv.getContext('2d')!.putImageData(data, 0, 0);
        return cv;
      };
      // Dark theme: grey/black ink becomes white; the gold is made brighter and more opaque so
      // it glows on black instead of looking dull.
      const light = new ImageData(new Uint8ClampedArray(c), W, H);
      const l = light.data;
      for (let i = 0; i < l.length; i += 4) {
        if (l[i + 3] === 0) continue;
        const r = l[i]!, g = l[i + 1]!, b = l[i + 2]!;
        if (Math.max(r, g, b) - Math.min(r, g, b) < 70 && Math.max(r, g, b) < 170) {
          l[i] = 245; l[i + 1] = 245; l[i + 2] = 245;
        } else {
          l[i] = Math.min(255, r * 1.15); l[i + 1] = Math.min(255, g * 1.15); l[i + 2] = Math.min(255, b * 1.15);
          l[i + 3] = Math.min(255, l[i + 3]! * 1.7);
        }
      }
      const cutDark = canvasOf(cut);
      const cutLight = canvasOf(light);

      const result: Record<string, string> = {};
      for (const job of jobs) {
        const cv = document.createElement('canvas');
        cv.width = job.mode.kind === 'transparent' ? Math.round(job.size * 1.5) : job.size;
        cv.height = job.size;
        const ctx = cv.getContext('2d')!;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        if (job.mode.kind === 'transparent') {
          const art = job.mode.ink === 'dark' ? cutDark : cutLight;
          ctx.drawImage(art, wide.x, wide.y, wide.w, wide.h, 0, 0, cv.width, cv.height);
        } else {
          ctx.fillStyle = job.mode.bg;
          if (job.mode.round) {
            ctx.beginPath();
            ctx.arc(job.size / 2, job.size / 2, job.size / 2, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillRect(0, 0, job.size, job.size);
          }
          const s = job.size * job.mode.scale;
          const o = (job.size - s) / 2;
          ctx.drawImage(cutDark, crop.x, crop.y, crop.s, crop.s, o, o, s, s);
        }
        result[job.file] = cv.toDataURL('image/png');
      }
      return result;
    },
    { src: source, jobs },
  );

  for (const [file, dataUrl] of Object.entries(images)) {
    const target = path.join(out, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(dataUrl.split(',')[1]!, 'base64'));
    console.log(`wrote ${path.relative(root, target)}`);
  }
  // The old house mark.
  rmSync(path.join(out, 'favicon.svg'), { force: true });
} finally {
  await browser.close();
}
