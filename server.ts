// server.ts — alla root del fork
import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '20mb' }));

// Auth con shared secret
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const token = req.headers['x-api-key'];
  if (token !== process.env.HYPERFRAMES_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/render', async (req, res) => {
  const {
    html,                    // string: contenuto del file composition.html
    assets = {},             // { "image.jpg": "https://..." } file extra da scaricare
    width = 1080,
    height = 1080,
    fps = 30,
    callbackUrl,             // URL Lovable Edge Function dove inviare l'MP4
    jobId,
  } = req.body;

  if (!html || !callbackUrl || !jobId) {
    return res.status(400).json({ error: 'html, callbackUrl, jobId required' });
  }

  // Risposta immediata, render in background
  res.json({ success: true, jobId, status: 'processing' });

  const projectDir = path.join(os.tmpdir(), `hf-${jobId}`);
  const outputPath = path.join(projectDir, 'output.mp4');

  try {
    // 1. Scaffold del progetto HyperFrames
    await fs.mkdir(projectDir, { recursive: true });
    
    // package.json minimale
    await fs.writeFile(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: `job-${jobId}`, version: '1.0.0', private: true }, null, 2)
    );

    // hyperframes config
    await fs.writeFile(
      path.join(projectDir, 'hyperframes.config.json'),
      JSON.stringify({ width, height, fps }, null, 2)
    );

    // composition HTML
    await fs.mkdir(path.join(projectDir, 'compositions'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'compositions', 'main.html'), html);

    // Scarica gli asset esterni (immagini della creative) in /assets locale
    if (Object.keys(assets).length > 0) {
      await fs.mkdir(path.join(projectDir, 'assets'), { recursive: true });
      for (const [filename, url] of Object.entries(assets)) {
        const buf = Buffer.from(await (await fetch(url as string)).arrayBuffer());
        await fs.writeFile(path.join(projectDir, 'assets', filename), buf);
      }
    }

    // 2. Render con la CLI
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'npx',
        ['hyperframes', 'render', '--composition', 'main', '--output', outputPath],
        { cwd: projectDir, stdio: 'inherit' }
      );
      proc.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`render exited ${code}`))
      );
    });

    // 3. Invia MP4 al callback Lovable
    const mp4 = await fs.readFile(outputPath);
    await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4',
        'X-Job-Id': jobId,
        'X-Callback-Secret': process.env.CALLBACK_SECRET!,
      },
      body: mp4,
    });
  } catch (err) {
    console.error(`Job ${jobId} failed:`, err);
    await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Job-Id': jobId,
        'X-Callback-Secret': process.env.CALLBACK_SECRET!,
        'X-Error': 'true',
      },
      body: JSON.stringify({ error: String(err) }),
    }).catch(() => {});
  } finally {
    // Cleanup
    await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`HyperFrames API on :${PORT}`));
