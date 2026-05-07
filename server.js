const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { buildVideo } = require('./pipeline');

const app = express();
const PORT = process.env.PORT || 3456;
console.log(`[Server] Starting on PORT=${PORT}`);

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(express.static(path.join(__dirname, 'public')));

const jobs = {};

app.post('/brand', upload.single('logo'), async (req, res) => {
  const { agentName, agentUrl } = req.body;
  if (!req.file || !agentName || !agentUrl) {
    return res.status(400).json({ error: 'logo, agentName and agentUrl are required' });
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  const jobDir = path.join(__dirname, 'uploads', jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const logoExt = path.extname(req.file.originalname) || '.png';
  const logoPath = path.join(jobDir, `logo${logoExt}`);
  fs.renameSync(req.file.path, logoPath);

  const outputDir = path.join(__dirname, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  jobs[jobId] = { status: 'processing', agentName, agentUrl, createdAt: new Date().toISOString() };
  res.json({ jobId, status: 'processing', pollUrl: `/status/${jobId}` });

  buildVideo({ logoPath, agentName, agentUrl, outputDir, jobDir })
    .then(results => {
      jobs[jobId].status = 'done';
      jobs[jobId].variants = {
        rural: {
          downloadUrl: `/download/${jobId}/rural`,
          thumbUrl: `/thumb/${jobId}/rural`
        },
        urban: {
          downloadUrl: `/download/${jobId}/urban`,
          thumbUrl: `/thumb/${jobId}/urban`
        }
      };
      jobs[jobId]._results = results;
    })
    .catch(err => {
      console.error(`[Job ${jobId}] Error:`, err.message);
      jobs[jobId].status = 'error';
      jobs[jobId].error = err.message;
    });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  // Return public fields only
  const { status, agentName, agentUrl, createdAt, variants, error } = job;
  res.json({ status, agentName, agentUrl, createdAt, variants, error });
});

app.get('/download/:jobId/:variant', (req, res) => {
  const job = jobs[req.params.jobId];
  const variant = req.params.variant;
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  const result = job._results?.[variant];
  if (!result) return res.status(404).json({ error: 'Variant not found' });
  const agentSlug = job.agentName.replace(/\s+/g, '-');
  res.download(result.outputPath, `myhome-${variant}-${agentSlug}.mp4`);
});

app.get('/thumb/:jobId/:variant', (req, res) => {
  const job = jobs[req.params.jobId];
  const variant = req.params.variant;
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  const result = job._results?.[variant];
  if (!result || !fs.existsSync(result.thumbPath)) return res.status(404).json({ error: 'Thumbnail not found' });
  res.sendFile(result.thumbPath);
});

app.listen(PORT, () => console.log(`🎬 Video Brander running on http://localhost:${PORT}`));
