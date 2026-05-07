const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const QRCode = require('qrcode');
const sharp = require('sharp');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'sk_1834f270e20daf5c0798106ddbf154fd5d131fdf9a0a7240';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'G7ILShrCNLfmS0A37SXS';

// Variant config: timings in SS:FF (seconds:frames at 24fps)
const VARIANTS = {
  rural: {
    file: 'myhome-rural-raw.mp4',
    label: 'Rural',
    logoCentreIn:  [1,  13],   // 01:13
    logoCentreOut: [4,   8],   // 04:08
    logoTrIn:      [4,  19],   // 04:19
    qrIn:          [53,  7],   // 53:07
    thumbTime:     9 + 14/24,  // 09:14
  },
  urban: {
    file: 'myhome-urban-raw.mp4',
    label: 'Urban',
    logoCentreIn:  [0,  20],   // 00:20
    logoCentreOut: [3,  18],   // 03:18
    logoTrIn:      [5,   8],   // 05:08
    qrIn:          [54,  7],   // 54:07
    thumbTime:     12 + 4/24,  // 12:04
  }
};

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, stdio: ['pipe','pipe','pipe'] });
}

function getVideoInfo(filePath) {
  const out = run(`ffprobe -v quiet -print_format json -show_streams "${filePath}"`);
  const streams = JSON.parse(out).streams;
  const v = streams.find(s => s.codec_type === 'video');
  const [fpsNum, fpsDen] = v.r_frame_rate.split('/').map(Number);
  return { width: v.width, height: v.height, fps: fpsNum / fpsDen };
}

function toSecs([ss, ff], fps) {
  return ss + ff / fps;
}

function deriveVipSlug(agentUrl) {
  try {
    const url = agentUrl.startsWith('http') ? agentUrl : `https://${agentUrl}`;
    let host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.')[0].toLowerCase();
  } catch (e) {
    return agentUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('.')[0].toLowerCase();
  }
}

async function makeTextPng(text, outPath, { fontSize = 40, color = 'white', fontFamily = 'Helvetica, Arial, sans-serif', fontWeight = 'normal', width, height = 120 } = {}) {
  const w = width || Math.max(500, text.length * fontSize * 0.65);
  const safeFontFamily = fontFamily.replace(/"/g, "'");
  const svg = `<svg width="${w}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="${w/2}" y="${height/2}" font-family="${safeFontFamily}" font-weight="${fontWeight}" font-size="${fontSize}" fill="${color}" text-anchor="middle" dominant-baseline="middle">${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return { width: w, height };
}

async function resizeLogo(logoPath, outPath, maxW, maxH) {
  await sharp(logoPath).resize(maxW, maxH, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(outPath);
  return await sharp(outPath).metadata();
}

async function extractThumb(videoPath, timeSecs, outPath) {
  run(`ffmpeg -y -ss ${timeSecs.toFixed(3)} -i "${videoPath}" -vframes 1 -q:v 3 "${outPath}"`);
}

async function buildVariant({ variant, logoPath, agentName, agentUrl, outputPath, thumbPath, jobDir }) {
  const cfg = VARIANTS[variant];
  if (!cfg) throw new Error(`Unknown variant: ${variant}`);

  const masterPath = path.join(__dirname, 'master', cfg.file);
  const info = getVideoInfo(masterPath);
  const { width: VW, height: VH, fps: FPS } = info;

  const slug     = deriveVipSlug(agentUrl);
  const vipUrl   = `vip.myporta.ai/${slug}`;
  const vipQrUrl = `https://${vipUrl}`;

  const T_CENTRE_IN  = toSecs(cfg.logoCentreIn,  FPS);
  const T_CENTRE_OUT = toSecs(cfg.logoCentreOut, FPS);
  const T_TR_IN      = toSecs(cfg.logoTrIn,      FPS);
  const T_QR_IN      = toSecs(cfg.qrIn,          FPS);

  console.log(`[${cfg.label}] ${VW}x${VH} @ ${FPS}fps | centre ${T_CENTRE_IN.toFixed(2)}-${T_CENTRE_OUT.toFixed(2)}s | top-right from ${T_TR_IN.toFixed(2)}s | QR from ${T_QR_IN.toFixed(2)}s`);

  const qrPath     = path.join(jobDir, `${variant}_qr.png`);
  const logoSmall  = path.join(jobDir, `${variant}_logo_small.png`);
  const logoCentre = path.join(jobDir, `${variant}_logo_centre.png`);
  const txtVipUrl  = path.join(jobDir, `${variant}_txt_url.png`);

  // --- QR: 5cm = 17.5% of VH at 1080p = 189px
  const QR_SIZE = Math.round(VH * 0.175);
  await QRCode.toFile(qrPath, vipQrUrl, { width: QR_SIZE, margin: 2, color: { dark: '#000000', light: '#ffffff' } });

  // --- Top-right logo: ~5mm margin, max 12% wide, 9% tall
  const TR_MARGIN = Math.round(VW * 0.018);
  await resizeLogo(logoPath, logoSmall, Math.round(VW * 0.12), Math.round(VH * 0.09));
  const lsMeta = await sharp(logoSmall).metadata();
  const lsX = VW - lsMeta.width - TR_MARGIN;
  const lsY = TR_MARGIN;

  // --- Centre logo: 35% wide, 20% tall, vertically at ~69% (midpoint between MyHome logo bottom ~38% and screen bottom)
  await resizeLogo(logoPath, logoCentre, Math.round(VW * 0.35), Math.round(VH * 0.20));
  const lcMeta = await sharp(logoCentre).metadata();
  const lcX = Math.round((VW - lcMeta.width) / 2);
  const lcY = Math.round(VH * 0.69 - lcMeta.height / 2);

  // --- VIP URL text: DM Sans Bold, black, same size/position for both variants
  const URL_FONT_SIZE = Math.round(VH * 0.057);
  const urlDims = await makeTextPng(vipUrl, txtVipUrl, {
    fontSize: URL_FONT_SIZE,
    color: '#000000',
    fontFamily: "'DM Sans', DMSans, Helvetica, Arial, sans-serif",
    fontWeight: 'bold',
    height: Math.round(URL_FONT_SIZE * 1.8)
  });

  // --- QR + URL positions: centred on screen
  const qrX   = Math.round((VW - QR_SIZE) / 2);
  const qrY   = Math.round(VH * 0.45);
  const urlX  = Math.round((VW - urlDims.width) / 2);
  const urlY  = qrY + QR_SIZE + Math.round(VH * 0.015);

  // --- Render
  run(`ffmpeg -y \
    -i "${masterPath}" \
    -i "${logoCentre}" \
    -i "${logoSmall}" \
    -i "${qrPath}" \
    -i "${txtVipUrl}" \
    -filter_complex "\
      [0:v][1:v]overlay=x=${lcX}:y=${lcY}:enable='between(t,${T_CENTRE_IN},${T_CENTRE_OUT})'[v1];\
      [v1][2:v]overlay=x=${lsX}:y=${lsY}:enable='between(t,${T_TR_IN},9999)'[v2];\
      [v2][3:v]overlay=x=${qrX}:y=${qrY}:enable='between(t,${T_QR_IN},9999)'[v3];\
      [v3][4:v]overlay=x=${urlX}:y=${urlY}:enable='between(t,${T_QR_IN},9999)'[vout]" \
    -map "[vout]" -map "0:a" \
    -c:v libx264 -preset fast -crf 18 \
    -c:a copy \
    "${outputPath}"`);

  // --- Thumbnail
  if (thumbPath) {
    await extractThumb(outputPath, cfg.thumbTime, thumbPath);
  }

  return outputPath;
}

async function buildVideo({ logoPath, agentName, agentUrl, outputDir, jobDir }) {
  const slug = deriveVipSlug(agentUrl);
  const results = {};

  for (const variant of ['rural', 'urban']) {
    const outputPath = path.join(outputDir, `myhome-${variant}-${path.basename(jobDir)}.mp4`);
    const thumbPath  = path.join(outputDir, `myhome-${variant}-${path.basename(jobDir)}-thumb.jpg`);
    console.log(`\n[Pipeline] Building ${variant} variant...`);
    await buildVariant({ variant, logoPath, agentName, agentUrl, outputPath, thumbPath, jobDir });
    results[variant] = { outputPath, thumbPath };
  }

  return results;
}

module.exports = { buildVideo, VARIANTS };
