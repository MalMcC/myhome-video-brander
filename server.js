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
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB logo limit
});

// Serve static UI
app.use(express.static(path.join(__dirname, 'public')));

// Job status store (in-memory for now)
const jobs = {};

// POST /brand — kick off a branding job
app.post('/brand', upload.single('logo'), async (req, res) => {
  const { agentName, agentUrl } = req.body;
  if (!req.file || !agentName || !agentUrl) {
    return res.status(400).json({ error: 'logo, agentName and agentUrl are required' });
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  const jobDir = path.join(__dirname, 'uploads', jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Move logo into job dir
  const logoExt = path.extname(req.file.originalname) || '.png';
  const logoPath = path.join(jobDir, `logo${logoExt}`);
  fs.renameSync(req.file.path, logoPath);

  const outputPath = path.join(__dirname, 'output', `myhome-${jobId}.mp4`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  jobs[jobId] = { status: 'processing', agentName, agentUrl, createdAt: new Date().toISOString() };
  res.json({ jobId, status: 'processing', pollUrl: `/status/${jobId}` });

  // Run pipeline async
  buildVideo({ logoPath, agentName, agentUrl, outputPath, jobDir })
    .then(() => {
      jobs[jobId].status = 'done';
      jobs[jobId].downloadUrl = `/download/${jobId}`;
    })
    .catch(err => {
      console.error(`[Job ${jobId}] Error:`, err.message);
      jobs[jobId].status = 'error';
      jobs[jobId].error = err.message;
    });
});

// GET /status/:jobId
app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// GET /download/:jobId
app.get('/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  const filePath = path.join(__dirname, 'output', `myhome-${req.params.jobId}.mp4`);
  res.download(filePath, `myhome-${job.agentName.replace(/\s+/g, '-')}.mp4`);
});

app.listen(PORT, () => console.log(`🎬 Video Brander running on http://localhost:${PORT}`));
