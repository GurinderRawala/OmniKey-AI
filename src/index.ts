import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { createSubscriptionRouter } from './subscriptionRoutes';
import { createFeatureRouter } from './featureRoutes';
import { initDatabase } from './db';
import { logger } from './logger';
import { taskInstructionRouter } from './taskInstructionRoutes';
import { config } from './config';
import { attachAgentWebSocketServer } from './agentServer';

const app = express();
const PORT = Number(config.port);

app.use(cors());
app.use(express.json());

app.use('/api/subscription', createSubscriptionRouter(logger));

app.use('/api/feature', createFeatureRouter());

app.use('/api/instructions', taskInstructionRouter());

app.get('/macos/download', (req, res) => {
  const dmgPath = path.join(process.cwd(), 'macOS', 'OmniKeyAI.dmg');

  res.download(dmgPath, 'OmniKeyAI.dmg', (err) => {
    if (err) {
      logger.error('Failed to send OmniKeyAI.dmg for download.', { error: err });

      if (!res.headersSent) {
        res.status(500).send('Unable to download file.');
      }
    }
  });
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

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const downloadUrl = `${baseUrl}/macos/download`;
  const appcastUrl = `${baseUrl}/macos/appcast`;

  // These should match the values embedded into the macOS app
  // Info.plist in macOS/build_release_dmg.sh.
  const bundleVersion = '13';
  const shortVersion = '1.0.12';

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
const WIN_VERSION = '1.0';
const WIN_ZIP_FILENAME = 'OmniKeyAI-windows-x64.zip';
const WIN_ZIP_PATH = path.join(process.cwd(), 'windows', WIN_ZIP_FILENAME);

// Serves the pre-built ZIP produced by windows/build_release_zip.ps1.
app.get('/windows/download', (_req, res) => {
  res.download(WIN_ZIP_PATH, WIN_ZIP_FILENAME, (err) => {
    if (err) {
      logger.error('Failed to send Windows ZIP for download.', { error: err });
      if (!res.headersSent) {
        res.status(500).send('Unable to download file.');
      }
    }
  });
});

// JSON update-check endpoint consumed by UpdateChecker.cs on the Windows client.
// Returns the latest version + download URL so the client can decide whether
// to prompt the user for an update.
app.get('/windows/update', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  let fileSize = 0;
  try {
    fileSize = fs.statSync(WIN_ZIP_PATH).size;
  } catch (error) {
    logger.error('Failed to stat Windows ZIP for update endpoint.', { error });
  }

  res.json({
    version:      WIN_VERSION,
    downloadUrl:  `${baseUrl}/windows/download`,
    fileSize,
    releaseNotes: '',
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

let server: import('http').Server | null = null;

async function start() {
  try {
    await initDatabase(logger);
    server = app.listen(PORT, () => {
      logger.info(`Enhancer API listening on http://localhost:${PORT}`, {
        isSelfHosted: config.isSelfHosted,
      });
    });

    // Attach the WebSocket-based agent server to the existing HTTP
    // server at /ws/omni-agent. This bi-directional stream is used
    // by clients when running @omniAgent sessions.
    if (server) {
      attachAgentWebSocketServer(server as import('http').Server);
    }
  } catch (err) {
    logger.error('Failed to start server due to DB error.', { error: err });
    process.exit(1);
  }
}

start();

function gracefulShutdown(signal: NodeJS.Signals) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  if (!server) {
    logger.info('Server was not started or already closed. Exiting process.');
    process.exit(0);
    return;
  }

  server.close((err) => {
    if (err) {
      logger.error('Error during HTTP server shutdown.', { error: err });
      process.exitCode = 1;
      return;
    }

    logger.info('HTTP server closed. Exiting process.');
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
