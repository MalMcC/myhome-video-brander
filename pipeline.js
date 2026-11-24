const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const QRCode = require('qrcode');
const sharp = require('sharp');

const run = promisify(execFile);
const VARIANTS = ['rural', 'urban'];
const SHAPES = {
  landscape: { width: 1920, height: 1080, suffix: '' },
  portrait: { width: 1080, height: 1920, suffix: '-portrait' }
};
const FILM_END = 41.7;
const CARD_SECONDS = 12;
const BRANCHES_PER_CARD = 4;
const VIDEO_VERSION = 'mydomi-masters-v1';
const WORDMARK = path.join(__dirname, 'brand', 'mydomi-wordmark.png');

function deriveVipSlug(agentUrl) {
  return new URL(agentUrl).hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
}

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function text(value, x, y, size, width, { bold = false, color = '#FFFFFF' } = {}) {
  const fitted = Math.min(size, Math.floor(width / Math.max(1, [...String(value)].length * 0.57)));
  return `<text x="${x}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fitted}" font-weight="${bold ? 700 : 400}" fill="${color}">${esc(value)}</text>`;
}

function cardMarkup(shape, agentName, referral, branches, page, pages) {
  const portrait = shape === SHAPES.portrait;
  const { width, height } = shape;
  const margin = portrait ? 80 : 110;
  const contactTop = portrait ? 910 : 548;
  const cardWidth = portrait ? 920 : 820;
  const cardHeight = portrait ? 188 : 183;
  const colGap = portrait ? 0 : 60;
  const cards = branches.map((branch, index) => {
    const col = portrait ? 0 : index % 2;
    const row = portrait ? index : Math.floor(index / 2);
    const x = margin + col * (cardWidth + colGap);
    const y = contactTop + row * (cardHeight + 22);
    return `<rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="22" fill="#22264D"/>
      ${text(branch.name, x + 30, y + 50, portrait ? 37 : 43, cardWidth - 60, { bold: true })}
      ${text(branch.phone, x + 30, y + 105, portrait ? 42 : 47, cardWidth - 60)}
      ${text(branch.email, x + 30, y + 150, portrait ? 36 : 42, cardWidth - 60, { color: '#DCE0FF' })}`;
  });
  const ruleY = portrait ? 864 : 502;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#13152D"/>
    <rect x="${margin}" y="${portrait ? 245 : 72}" width="${portrait ? 397 : 340}" height="${portrait ? 149 : 140}" rx="24" fill="white"/>
    ${text(agentName, portrait ? 80 : 490, portrait ? 467 : 163, portrait ? 54 : 63, portrait ? 910 : 925, { bold: true })}
    ${text('Claim your home', margin, portrait ? 586 : 343, portrait ? 75 : 104, portrait ? 608 : 1120, { bold: true })}
    ${text(referral, margin, portrait ? 654 : 426, portrait ? 44 : 51, portrait ? 608 : 1150, { color: '#DCE0FF' })}
    ${text('Scan to get started', portrait ? 688 : 1435, portrait ? 811 : 442, portrait ? 33 : 37, 350, { bold: true })}
    <path d="M${margin} ${ruleY}H${width-margin}" stroke="#555D98" stroke-width="2"/>
    ${cards.join('')}
    ${pages > 1 ? text(`Branch contacts ${page} of ${pages}`, portrait ? margin : 1300, height - (portrait ? 82 : 70), 30, 500, { color: '#DCE0FF' }) : ''}
  </svg>`;
}

async function preparedImage(input, width, height) {
  return sharp(input, { limitInputPixels: 16_000_000 })
    .resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
}

async function makeEndCards({ shape, logoPath, agentName, referral, branches, jobDir }) {
  if (!branches.length) throw new Error('Branch contacts are missing');
  const portrait = shape === SHAPES.portrait;
  const qr = await QRCode.toBuffer('https://' + referral, { width: portrait ? 214 : 280, margin: 3, errorCorrectionLevel: 'M' });
  const wordmark = await preparedImage(WORDMARK, portrait ? 380 : 470, 108);
  const logo = await preparedImage(logoPath, portrait ? 365 : 308, portrait ? 117 : 108);
  const overlays = [
    { input: qr, left: portrait ? 707 : 1455, top: portrait ? 566 : 102 },
    { input: wordmark, left: portrait ? 80 : 110, top: portrait ? 106 : 952 },
    { input: logo, left: portrait ? 96 : 126, top: portrait ? 261 : 88 }
  ];
  const pages = Math.ceil(branches.length / BRANCHES_PER_CARD);
  const files = [];
  for (let page = 0; page < pages; page++) {
    const start = page * BRANCHES_PER_CARD;
    const file = path.join(jobDir, `end-${shape.width}-${page}.png`);
    const svg = cardMarkup(shape, agentName, referral, branches.slice(start, start + BRANCHES_PER_CARD), page + 1, pages);
    await sharp(Buffer.from(svg)).composite(overlays).png().toFile(file);
    files.push(file);
  }
  return files;
}

async function buildVariant({ variant, shape, logo, cards, outputPath, thumbPath }) {
  const master = path.join(__dirname, 'master', `mydomi-${variant}.mp4`);
  const duration = FILM_END + CARD_SECONDS * cards.length;
  const { width, height } = shape;
  const graph = [
    `[0:v]fps=24,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x13152D,tpad=stop_mode=clone:stop_duration=${duration}[film]`,
    `[film][1:v]overlay=x=W-w-36:y=36:enable='between(t,3,${FILM_END})'[intro]`
  ];
  cards.forEach((_, index) => {
    const start = FILM_END + CARD_SECONDS * index;
    graph.push(`[${index === 0 ? 'intro' : 'card' + (index-1)}][${index+2}:v]overlay=enable='gte(t,${start})'[${index === cards.length - 1 ? 'out' : 'card'+index}]`);
  });
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex_threads', '2',
    '-i', master, '-i', logo, ...cards.flatMap(file => ['-i', file]), '-filter_complex', graph.join(';'),
    '-map', '[out]', '-map', '0:a:0', '-af', 'apad', '-t', String(duration),
    '-c:v', 'libx264', '-threads', '4', '-preset', 'fast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outputPath]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '12', '-i', outputPath,
    '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', thumbPath]);
}

async function buildVideo({ logoPath, agentName, agentUrl, outputDir, jobDir, branches }) {
  const referral = `vip.myporta.ai/${deriveVipSlug(agentUrl)}`;
  const logo = path.join(jobDir, 'agency-overlay.png');
  const padding = { top: 12, right: 14, bottom: 12, left: 14, background: 'white' };
  await sharp(await preparedImage(logoPath, 256, 92))
    .extend(padding).flatten({ background: 'white' }).png().toFile(logo);
  const results = {};
  const jobId = path.basename(jobDir);
  for (const shape of Object.values(SHAPES)) {
    const cards = await makeEndCards({ shape, logoPath, agentName, referral, branches, jobDir });
    for (const variant of VARIANTS) {
      const key = variant + shape.suffix;
      const prefix = path.join(outputDir, `mydomi-${key}-${jobId}`);
      const outputPath = prefix + '.mp4';
      const thumbPath = prefix + '-thumb.jpg';
      await buildVariant({ variant, shape, logo, cards, outputPath, thumbPath });
      results[key] = { outputPath, thumbPath };
    }
  }
  return results;
}

module.exports = { buildVideo, VIDEO_VERSION, VARIANTS, SHAPES };
