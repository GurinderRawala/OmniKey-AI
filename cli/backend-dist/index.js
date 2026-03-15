"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const subscriptionRoutes_1 = require("./subscriptionRoutes");
const featureRoutes_1 = require("./featureRoutes");
const db_1 = require("./db");
const logger_1 = require("./logger");
const taskInstructionRoutes_1 = require("./taskInstructionRoutes");
const config_1 = require("./config");
const agentServer_1 = require("./agentServer");
const app = (0, express_1.default)();
const PORT = Number(config_1.config.port);
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use('/api/subscription', (0, subscriptionRoutes_1.createSubscriptionRouter)(logger_1.logger));
app.use('/api/feature', (0, featureRoutes_1.createFeatureRouter)());
app.use('/api/instructions', (0, taskInstructionRoutes_1.taskInstructionRouter)());
app.get('/macos/download', (req, res) => {
    const dmgPath = path_1.default.join(process.cwd(), 'macOS', 'OmniKeyAI.dmg');
    res.download(dmgPath, 'OmniKeyAI.dmg', (err) => {
        if (err) {
            logger_1.logger.error('Failed to send OmniKeyAI.dmg for download.', { error: err });
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
    const dmgPath = path_1.default.join(process.cwd(), 'macOS', 'OmniKeyAI.dmg');
    let length = 0;
    try {
        const stats = fs_1.default.statSync(dmgPath);
        length = stats.size;
    }
    catch (error) {
        logger_1.logger.error('Failed to stat OmniKeyAI.dmg for appcast.', { error });
    }
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const downloadUrl = `${baseUrl}/macos/download`;
    const appcastUrl = `${baseUrl}/macos/appcast`;
    // These should match the values embedded into the macOS app
    // Info.plist in macOS/build_release_dmg.sh.
    const bundleVersion = '11';
    const shortVersion = '1.0.10';
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
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});
let server = null;
async function start() {
    try {
        await (0, db_1.initDatabase)(logger_1.logger);
        server = app.listen(PORT, () => {
            logger_1.logger.info(`Enhancer API listening on http://localhost:${PORT}`);
        });
        // Attach the WebSocket-based agent server to the existing HTTP
        // server at /ws/omni-agent. This bi-directional stream is used
        // by clients when running @omniAgent sessions.
        if (server) {
            (0, agentServer_1.attachAgentWebSocketServer)(server);
        }
    }
    catch (err) {
        logger_1.logger.error('Failed to start server due to DB error.', { error: err });
        process.exit(1);
    }
}
start();
function gracefulShutdown(signal) {
    logger_1.logger.info(`Received ${signal}. Starting graceful shutdown...`);
    if (!server) {
        logger_1.logger.info('Server was not started or already closed. Exiting process.');
        process.exit(0);
        return;
    }
    server.close((err) => {
        if (err) {
            logger_1.logger.error('Error during HTTP server shutdown.', { error: err });
            process.exitCode = 1;
            return;
        }
        logger_1.logger.info('HTTP server closed. Exiting process.');
        process.exit(0);
    });
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
