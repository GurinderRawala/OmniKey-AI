import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { createSubscriptionRouter } from './subscriptionRoutes';
import { createFeatureRouter } from './featureRoutes';
import { initDatabase } from './db';
import { logger } from './logger';
import { taskInstructionRouter } from './taskInstructionRoutes';
import { scheduledJobRouter } from './scheduledJobRoutes';
import { mcpServerRouter } from './mcpServerRoutes';
import { aiProviderRouter } from './aiProviderRoutes';
import { appSettingsRouter } from './appSettingsRoutes';
import { spawnWorker, type ManagedWorker } from './workers/spawn';
import { setScheduledJobWorker } from './workers/scheduledJobWorkerClient';
import { config } from './config';
import { attachAgentWebSocketServer, createAgentRouter } from './agent/agentServer';
import { AppDownload } from './models/appDownload';
// Importing AgentSession and ScheduledJob ensures the models are registered with Sequelize before initDatabase().
import './models/agentSession';
import './models/scheduledJob';
import './models/mcpServer';
import { incrementDownloadCount, getDownloadCounts } from './bucket-adapter';

const app = express();
const PORT = Number(config.port);

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// Landing page
app.use(express.static(path.join(process.cwd(), 'public')));

app.use('/api/subscription', createSubscriptionRouter(logger));

app.use('/api/feature', createFeatureRouter());

app.use('/api/instructions', taskInstructionRouter());

app.use('/api/scheduled-jobs', scheduledJobRouter());

app.use('/api/mcp-servers', mcpServerRouter());

app.use('/api/providers', aiProviderRouter());

app.use('/api/app-settings', appSettingsRouter());

app.use('/api/agent', createAgentRouter());

app.get('/macos/download', (_req, res) => {
  const dmgPath = path.join(process.cwd(), 'macOS', 'OmniKeyAI.dmg');

  if (!fs.existsSync(dmgPath)) {
    res.status(404).send('File not found.');
    return;
  }

  let fileSize = 0;
  try { fileSize = fs.statSync(dmgPath).size; } catch (_) {}

  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="OmniKeyAI.dmg"',
    ...(fileSize ? { 'Content-Length': String(fileSize) } : {}),
  });

  incrementDownloadCount('macos').catch(() => {});

  const fileStream = fs.createReadStream(dmgPath);

  fileStream.on('error', (err) => {
    logger.error('Failed to send OmniKeyAI.dmg for download.', { error: err });
    if (!res.headersSent) {
      res.status(500).send('Unable to download file.');
    }
  });

  fileStream.pipe(res);
});

// Sparkle appcast feed for macOS updates.
// This feed uses the existing /macos/download endpoint as the
// enclosure URL so both manual downloads and Sparkle updates
// share the same DMG file.
app.get('/macos/appcast', (req, res) => {
  const dmgPath = path.join(process.cwd(), 'macOS', 'OmniKeyAI.dmg');

  let length = 0;
  try {
    const stats = fs.statSync(dmgPath);
    length = stats.size;
  } catch (error) {
    logger.error('Failed to stat OmniKeyAI.dmg for appcast.', { error });
  }

  const baseUrl = `https://${req.get('host')}`;
  const downloadUrl = `${baseUrl}/macos/download`;
  const appcastUrl = `${baseUrl}/macos/appcast`;

  // These should match the values embedded into the macOS app
  // Info.plist in macOS/build_release_dmg.sh.
  const bundleVersion = '42';
  const shortVersion = '1.0.41';

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"
     xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>OmniKeyAI Updates</title>
    <link>${appcastUrl}</link>
    <description>OmniKeyAI macOS updates</description>
    <language>en</language>
    <item>
      <title>Version ${shortVersion}</title>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <enclosure
        url="${downloadUrl}"
        sparkle:version="${bundleVersion}"
        sparkle:shortVersionString="${shortVersion}"
        length="${length}"
        type="application/octet-stream" />
    </item>
  </channel>
</rss>`;

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.send(xml);
});

// ── Windows distribution endpoints ───────────────────────────────────────────
// These should match the values in windows/OmniKey.Windows.csproj
// <Version> and windows/build_release_zip.ps1 $APP_VERSION.
const WIN_VERSION = '1.14';
const WIN_ZIP_FILENAME = 'OmniKeyAI-windows-win-x64.zip';
const WIN_ZIP_PATH = path.join(process.cwd(), 'windows', WIN_ZIP_FILENAME);

// Serves the pre-built ZIP produced by windows/build_release_zip.ps1.
// Streams through gzip to reduce response size on Cloud Run.
app.get('/windows/download', (_req, res) => {
  if (!fs.existsSync(WIN_ZIP_PATH)) {
    res.status(404).send('File not found.');
    return;
  }

  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${WIN_ZIP_FILENAME}"`,
    'Content-Encoding': 'gzip',
  });

  incrementDownloadCount('windows').catch(() => {});

  const fileStream = fs.createReadStream(WIN_ZIP_PATH);
  const gzip = zlib.createGzip();

  fileStream.on('error', (err) => {
    logger.error('Failed to send Windows ZIP for download.', { error: err });
    if (!res.headersSent) {
      res.status(500).send('Unable to download file.');
    }
  });

  fileStream.pipe(gzip).pipe(res);
});

// JSON update-check endpoint consumed by UpdateChecker.cs on the Windows client.
// Returns the latest version + download URL so the client can decide whether
// to prompt the user for an update.
app.get('/windows/update', (req, res) => {
  const baseUrl = `https://${req.get('host')}`;

  let fileSize = 0;
  try {
    fileSize = fs.statSync(WIN_ZIP_PATH).size;
  } catch (error) {
    logger.error('Failed to stat Windows ZIP for update endpoint.', { error });
  }

  res.json({
    version: WIN_VERSION,
    downloadUrl: `${baseUrl}/windows/download`,
    fileSize,
    releaseNotes: [
      `What's new in ${WIN_VERSION}`,
      ``,
      `• Settings: redesigned with a dedicated sidebar — AI Providers, Agent Access, Check for updates, and Manual now live in one place, and the main app sidebar tucks away automatically when you open Settings.`,
      `• Settings: Manual and Check for updates moved into Settings and removed from the top-level sidebar and the tray menu.`,
      `• AI Providers: listed as rows showing each provider's masked key and which one is active. Pick a provider to edit its key, base URL, or model on the next screen with a Back button — and keys already saved in your config now load and display automatically.`,
      `• AI Providers: change the OpenAI model (gpt-5.1 or gpt-5.5) from a dropdown; an Apply button appears only when you pick a different model, mirroring the macOS app.`,
      `• Agent Access: terminal access (limited / full), web search, and authenticated browser access are managed together and applied with a single Save.`,
      `• Authenticated browser access now works on Windows — toggling it on opens the guided setup so the agent can read tabs from a signed-in browser session.`,
      `• Markdown: proper bullet points — disc / circle / square markers by nesting level, no left-edge clipping, and tighter list spacing so answers read cleanly. Headings now stand out with better spacing and contrast.`,
      `• Stability: the app no longer closes when you change a setting or when the self-hosted backend is briefly unavailable, and restarting the daemon after a settings change no longer shuts the app down.`,
      `• Reliability: large agent shell commands no longer fail with "The filename or extension is too long".`,
    ].join('\n'),
  });
});

app.get('/downloads/stats', async (_req, res) => {
  try {
    const counts = await getDownloadCounts();
    res.json(counts);
  } catch (err) {
    logger.error('Failed to retrieve download stats.', { error: err });
    res.status(500).json({ error: 'Unable to retrieve download stats.' });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/install.sh', (_req, res) => {
  const scriptPath = path.join(process.cwd(), 'install.sh');
  if (!fs.existsSync(scriptPath)) {
    res.status(404).send('Not found.');
    return;
  }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(scriptPath);
});

app.get('/install.ps1', (_req, res) => {
  const scriptPath = path.join(process.cwd(), 'install.ps1');
  if (!fs.existsSync(scriptPath)) {
    res.status(404).send('Not found.');
    return;
  }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(scriptPath);
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

let server: import('http').Server | null = null;
const backgroundWorkers: ManagedWorker[] = [];

async function start() {
  try {
    await initDatabase(logger);

    server = app.listen(PORT, () => {
      logger.info(`Enhancer API listening on http://localhost:${PORT}`, {
        isSelfHosted: config.isSelfHosted,
        aiProvider: config.aiProvider,
      });
    });

    // Attach the WebSocket-based agent server to the existing HTTP
    // server at /ws/omni-agent. This bi-directional stream is used
    // by clients when running @omniAgent sessions.
    if (server) {
      attachAgentWebSocketServer(server as import('http').Server);
    }

    if (config.isSelfHosted) {
      // Run the schedulers in dedicated worker threads so their DB
      // polling / cron ticks never block the HTTP event loop.
      const scheduledJobWorker = spawnWorker('scheduledJobWorker');
      backgroundWorkers.push(scheduledJobWorker);
      backgroundWorkers.push(spawnWorker('groupingWorker'));
      // Expose the worker handle so HTTP routes (e.g. POST /:id/run-now)
      // can dispatch immediate executions into the worker thread instead
      // of running them in-process and blocking the event loop.
      setScheduledJobWorker(scheduledJobWorker);
    }
  } catch (err) {
    logger.error('Failed to start server due to DB error.', { error: err });
    process.exit(1);
  }
}

start();

async function stopBackgroundWorkers(): Promise<void> {
  if (!backgroundWorkers.length) return;
  logger.info('Stopping background workers...', { count: backgroundWorkers.length });
  setScheduledJobWorker(null);
  await Promise.allSettled(backgroundWorkers.map((w) => w.stop()));
}

function gracefulShutdown(signal: NodeJS.Signals) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  const finish = (code: number) => {
    void stopBackgroundWorkers().finally(() => process.exit(code));
  };

  if (!server) {
    logger.info('Server was not started or already closed. Exiting process.');
    finish(0);
    return;
  }

  server.close((err) => {
    if (err) {
      logger.error('Error during HTTP server shutdown.', { error: err });
      finish(1);
      return;
    }

    logger.info('HTTP server closed. Exiting process.');
    finish(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
