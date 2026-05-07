const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const QRCode = require('qrcode');
const sharp = require('sharp');

const MASTER = path.join(__dirname, 'master', process.env.MASTER_VIDEO || 'myhome-rural-raw.mp4');
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'sk_1834f270e20daf5c0798106ddbf154fd5d131fdf9a0a7240';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'G7ILShrCNLfmS0A37SXS';
const VW = 1920, VH = 1080;

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, stdio: ['pipe','pipe','pipe'] });
}

function elevenLabsTTS(text, outPath) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } });
    const req = https.request({
      hostname: 'api.elevenlabs.io', path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) return reject(new Error(`ElevenLabs ${res.statusCode}: ${buf.slice(0,200)}`));
        fs.writeFileSync(outPath, buf);
        resolve();
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function makeTextPng(text, outPath, { fontSize = 40, color = 'white', width = VW, height = 120 } = {}) {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="${width/2}" y="${height/2}" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" fill="${color}" text-anchor="middle" dominant-baseline="middle">${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

async function generateQRCode(url, outPath) {
  await QRCode.toFile(outPath, url, { width: 280, margin: 1, color: { dark: '#1a1a2e', light: '#ffffff' } });
}

async function resizeLogo(logoPath, outPath, width, height) {
  await sharp(logoPath).resize(width, height, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(outPath);
}

function deriveVipSlug(agentUrl) {
  // Extract domain, strip www, take first part before first dot, preserve hyphens
  // e.g. https://kelvinfrancis.com -> kelvinfrancis
  //      https://www.your-ipswich.co.uk -> your-ipswich
  try {
    const url = agentUrl.startsWith('http') ? agentUrl : `https://${agentUrl}`;
    let host = new URL(url).hostname.replace(/^www\./, '');
    // Take everything before the first dot
    const slug = host.split('.')[0];
    return slug.toLowerCase();
  } catch (e) {
    // Fallback: strip protocol and take first path segment
    return agentUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('.')[0].toLowerCase();
  }
}

async function buildVideo({ logoPath, agentName, agentUrl, outputPath, jobDir }) {
  console.log(`[Pipeline] Starting for: ${agentName}`);

  const slug       = deriveVipSlug(agentUrl);
  const vipUrl     = `vip.myporta.ai/${slug}`;
  const vipQrUrl   = `https://${vipUrl}`;
  console.log(`[Pipeline] VIP URL: ${vipQrUrl}`);

  const voicePath   = path.join(jobDir, 'voice.mp3');
  const qrPath      = path.join(jobDir, 'qr.png');
  const logoSmall   = path.join(jobDir, 'logo_small.png');
  const logoLarge   = path.join(jobDir, 'logo_large.png');
  const txtPartner  = path.join(jobDir, 'txt_partner.png');
  const txtVipUrl   = path.join(jobDir, 'txt_vip_url.png');

  // 1. Generate assets
  console.log('[1/4] Generating voiceover...');
  await elevenLabsTTS(`MyHome by MyPorta. Just four pounds and ninety-nine pence a month. Cancel anytime. And your first month is on ${agentName}. Know your place with MyHome.`, voicePath);

  console.log('[2/4] Building overlays...');
  await generateQRCode(vipQrUrl, qrPath);
  await resizeLogo(logoPath, logoSmall, 180, 90);
  await resizeLogo(logoPath, logoLarge, 480, 200);
  await makeTextPng(`In partnership with ${agentName}`, txtPartner, { fontSize: 42, height: 120 });
  // VIP URL text — displayed below QR on outro, slightly smaller so it's clean
  await makeTextPng(vipUrl, txtVipUrl, { fontSize: 34, height: 70, color: '#f97316' });

  // 2. Mix audio
  console.log('[3/4] Mixing audio...');
  const audioMixed = path.join(jobDir, 'audio_mixed.aac');
  const voiceDur = parseFloat(run(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${voicePath}"`).trim());

  run(`ffmpeg -y \
    -i "${MASTER}" \
    -i "${voicePath}" \
    -filter_complex "\
      [0:a]atrim=0:38.10,asetpts=PTS-STARTPTS[pre];\
      [1:a]atrim=0:${voiceDur},asetpts=PTS-STARTPTS[vo];\
      [0:a]atrim=49.04,asetpts=PTS-STARTPTS[post];\
      [pre][vo][post]concat=n=3:v=0:a=1[aout]" \
    -map "[aout]" -acodec aac -b:a 192k "${audioMixed}"`);

  // 3. Composite video (all-image overlays, no drawtext)
  console.log('[4/4] Rendering video...');
  const M = 40;
  const lsX = VW - 180 - M, lsY = M;                             // small logo top-right
  const llX = Math.round((VW-480)/2), llY = Math.round(VH*0.42); // large logo centred on outro
  const txX = 0, txY = llY + 215;                                 // "In partnership with" below logo

  // Outro layout: QR on left, URL text centred below QR
  // QR sits left-of-centre so URL text has clear space to the right
  const qrSize = 220;
  const qrX = Math.round(VW * 0.35) - Math.round(qrSize / 2);    // ~35% from left
  const qrY = Math.round(VH * 0.58);
  // URL text centred under the QR code — same horizontal centre, well below it
  const urlTextW = 700;
  const urlX = Math.round(VW * 0.35) - Math.round(urlTextW / 2);
  const urlY = qrY + qrSize + 18;                                 // 18px gap below QR

  // Regenerate QR at the smaller size used here
  await QRCode.toFile(qrPath, vipQrUrl, { width: qrSize, margin: 1, color: { dark: '#1a1a2e', light: '#ffffff' } });
  // Regenerate URL text at correct width
  await makeTextPng(vipUrl, txtVipUrl, { fontSize: 30, height: 56, width: urlTextW, color: '#f97316' });

  run(`ffmpeg -y \
    -i "${MASTER}" \
    -i "${audioMixed}" \
    -i "${logoLarge}" \
    -i "${logoSmall}" \
    -i "${qrPath}" \
    -i "${txtPartner}" \
    -i "${txtVipUrl}" \
    -filter_complex "\
      [0:v][2:v]overlay=x=${llX}:y=${llY}:enable='between(t,2,4.13)'[v1];\
      [v1][5:v]overlay=x=${txX}:y=${txY}:enable='between(t,2,4.13)'[v2];\
      [v2][3:v]overlay=x=${lsX}:y=${lsY}:enable='between(t,4.13,48.17)'[v3];\
      [v3][2:v]overlay=x=${llX}:y=${llY}:enable='between(t,51.02,55)'[v4];\
      [v4][4:v]overlay=x=${qrX}:y=${qrY}:enable='between(t,52,55)'[v5];\
      [v5][6:v]overlay=x=${urlX}:y=${urlY}:enable='between(t,52,55)'[vout]" \
    -map "[vout]" -map "1:a" \
    -c:v libx264 -preset fast -crf 20 \
    -c:a aac -b:a 192k \
    -shortest \
    "${outputPath}"`);

  console.log(`[Pipeline] ✅ Done: ${outputPath}`);
  return outputPath;
}

module.exports = { buildVideo };
