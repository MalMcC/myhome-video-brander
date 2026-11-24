const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { buildVideo, VIDEO_VERSION, VARIANTS } = require('./pipeline');
const { BranchContactError, verifyBranchContacts, fetchPublicLogo } = require('./branch-contacts');

const app = express();
const PORT = process.env.PORT || 3456;
const outputDir = path.resolve(process.env.VIDEO_OUTPUT_DIR || path.join(__dirname, 'output'));
const uploadDir = path.resolve(process.env.VIDEO_UPLOAD_DIR || path.join(__dirname, 'uploads'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 7_000_000 } });
const jobs = new Map();
const variants = VARIANTS.concat(VARIANTS.map(variant => variant + '-portrait'));
let queue = Promise.resolve();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/preview/:variant', (req, res) => {
  const { variant } = req.params;
  if (!VARIANTS.includes(variant)) return res.sendStatus(404);
  res.sendFile(path.join(__dirname, 'master', `mydomi-${variant}.mp4`));
});

app.get('/health', (_req, res) => {
  const files = VARIANTS.map(variant => path.join(__dirname, 'master', `mydomi-${variant}.mp4`));
  files.push(path.join(__dirname, 'brand', 'mydomi-wordmark.png'));
  const ready = files.every(file => fs.existsSync(file) && fs.statSync(file).size > 0);
  res.status(ready ? 200 : 503).set('Cache-Control', 'no-store').json({ ready, version: VIDEO_VERSION });
});


function links(jobId, version) {
  const names = version === VIDEO_VERSION ? variants : VARIANTS;
  return Object.fromEntries([
    ...names.map(variant => [variant, { downloadUrl: `/download/${jobId}/${variant}`, thumbUrl: `/thumb/${jobId}/${variant}` }]),
    ...(version ? [['version', version]] : [])
  ]);
}

async function submit(req, res, readLogo) {
  const { agentName, agentUrl, branches, allBranchesConfirmed } = req.body || {};
  if (typeof agentName !== 'string' || !agentName.trim() || agentName.length > 100 || typeof agentUrl !== 'string' ||
      !['true', true].includes(allBranchesConfirmed)) {
    return res.status(400).json({ error: 'Enter your agency and confirm that all branches covered by the film are listed.' });
  }
  let contacts;
  let logo;
  try {
    contacts = await verifyBranchContacts(agentUrl, branches);
    logo = await readLogo();
    if (!logo?.length) throw new BranchContactError('Add your agency logo and try again.');
  } catch (error) {
    return res.status(422).json({ error: error instanceof BranchContactError ? error.message : 'We couldn’t read your agency logo. Upload it again in your branding settings.' });
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  const jobDir = path.join(uploadDir, jobId);
  const job = { status: 'processing', agentName: agentName.trim(), agentUrl, createdAt: new Date().toISOString() };
  jobs.set(jobId, job);
  res.json({ jobId, status: 'processing', pollUrl: `/status/${jobId}` });

  queue = queue.then(async () => {
    try {
      fs.mkdirSync(jobDir, { recursive: true });
      fs.mkdirSync(outputDir, { recursive: true });
      const logoPath = path.join(jobDir, 'logo');
      fs.writeFileSync(logoPath, logo);
      job._results = await buildVideo({ logoPath, agentName: job.agentName, agentUrl, outputDir, jobDir, branches: contacts });
      const manifest = path.join(outputDir, `mydomi-${jobId}.json`);
      fs.writeFileSync(manifest + '.tmp', JSON.stringify({ agentName: job.agentName, agentUrl, createdAt: job.createdAt }));
      fs.renameSync(manifest + '.tmp', manifest);
      job.variants = links(jobId, VIDEO_VERSION);
      job.status = 'done';
    } catch {
      job.status = 'error';
      job.error = 'We couldn’t make the films. Check the logo and try again.';
      console.error(`[Video ${jobId}] Render failed`);
    } finally {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }).catch(() => { job.status = 'error'; job.error = 'We couldn’t finish the films. Please try again.'; });
}

app.post('/brand-url', express.json({ limit: '10mb' }), (req, res) => submit(req, res, async () => {
  const { logoUrl } = req.body || {};
  if (typeof logoUrl !== 'string') return null;
  if (/^data:/i.test(logoUrl)) {
    const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=]+)$/i.exec(logoUrl);
    return match ? Buffer.from(match[1], 'base64') : null;
  }
  return fetchPublicLogo(logoUrl);
}));

app.post('/brand', upload.single('logo'), (req, res) => submit(req, res, () => req.file?.buffer));

function restoreJobFromDisk(jobId) {
  if (!/^[a-f0-9]{12}$/.test(jobId)) return null;
  const manifest = path.join(outputDir, `mydomi-${jobId}.json`);
  const current = fs.existsSync(manifest);
  const paths = Object.fromEntries((current ? variants : VARIANTS).map(variant => {
    const prefix = path.join(outputDir, `${current ? 'mydomi' : 'myhome'}-${variant}-${jobId}`);
    return [variant, { outputPath: prefix + '.mp4', thumbPath: prefix + '-thumb.jpg' }];
  }));
  if (Object.values(paths).some(result => !fs.existsSync(result.outputPath))) return null;
  let metadata = { agentName: 'restored', agentUrl: '' };
  if (current) {
    try { metadata = JSON.parse(fs.readFileSync(manifest, 'utf8')); }
    catch { return null; }
  }
  const job = { ...metadata, status: 'done', variants: links(jobId, current ? VIDEO_VERSION : ''), _results: paths };
  jobs.set(jobId, job);
  return job;
}

function getJob(jobId) {
  return jobs.get(jobId) || restoreJobFromDisk(jobId);
}

app.get('/status/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { status, agentName, agentUrl, createdAt, variants, error } = job;
  res.set('Cache-Control', 'no-store').json({ status, agentName, agentUrl, createdAt, variants, error });
});

app.get('/download/:jobId/:variant', (req, res) => {
  const job = getJob(req.params.jobId);
  const { variant } = req.params;
  const result = job?.status === 'done' && resultsFor(job, variant);
  if (!result || !fs.existsSync(result.outputPath)) return res.status(404).json({ error: 'Video not ready' });
  const agentSlug = (job.agentName || 'mydomi').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const brand = job.variants.version ? 'mydomi' : 'myhome';
  res.download(result.outputPath, `${brand}-${variant}-${agentSlug}.mp4`);
});

app.get('/thumb/:jobId/:variant', (req, res) => {
  const job = getJob(req.params.jobId);
  const result = job?.status === 'done' && resultsFor(job, req.params.variant);
  if (!result || !fs.existsSync(result.thumbPath)) return res.status(404).json({ error: 'Thumbnail not ready' });
  res.sendFile(result.thumbPath);
});

function resultsFor(job, variant) {
  return variants.includes(variant) ? job._results?.[variant] : null;
}

app.listen(PORT, () => console.log(`MyDomi Video Brander running on port ${PORT}`));
