#!/usr/bin/env node
import { TmuxCapture } from './tmux/index.js';
import { EncryptedWSClient } from './ws/index.js';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';

const SERVER_URL = process.env.SOHAPPY_SERVER_URL ?? 'http://localhost:3010';
const SESSION_NAME = process.argv[2] ?? '';
const ENCRYPTED = !process.argv.includes('--no-encrypt');

// Parse userSecret from command line
function getUserSecret(): string | undefined {
  const secretIdx = process.argv.indexOf('--secret');
  if (secretIdx !== -1 && process.argv[secretIdx + 1]) {
    return process.argv[secretIdx + 1];
  }
  return process.env.SOHAPPY_USER_SECRET;
}

const USER_SECRET = getUserSecret();

function printUsage(): void {
  console.log(`
${chalk.bold('sohappy')} - Tmux terminal bridge with E2E encryption

${chalk.bold('Usage:')}
  sohappy <tmux-session-name>           Attach to existing tmux session (encrypted)
  sohappy <session> --no-encrypt        Run without encryption
  sohappy <session> --secret <key>      Use user secret for session ownership
  sohappy --list                        List available tmux sessions
  sohappy --create <name>               Create new tmux session

${chalk.bold('Environment:')}
  SOHAPPY_SERVER_URL   Server URL (default: http://localhost:3000)
  SOHAPPY_USER_SECRET  User secret key for session ownership
`);
}

async function main(): Promise<void> {
  // Handle --list flag
  if (process.argv.includes('--list')) {
    const sessions = TmuxCapture.listSessions();
    if (sessions.length === 0) {
      console.log('No tmux sessions found');
    } else {
      console.log(chalk.bold('Available tmux sessions:'));
      sessions.forEach((s) => console.log(`  - ${s}`));
    }
    process.exit(0);
  }

  // Handle --create flag
  const createIdx = process.argv.indexOf('--create');
  if (createIdx !== -1) {
    const name = process.argv[createIdx + 1];
    if (!name) {
      console.error('Please provide a session name');
      process.exit(1);
    }
    TmuxCapture.createSession(name);
    console.log(chalk.green(`Created tmux session: ${name}`));
    process.exit(0);
  }

  // Validate session name
  if (!SESSION_NAME || SESSION_NAME.startsWith('--')) {
    printUsage();
    process.exit(1);
  }

  // Check if session exists
  if (!TmuxCapture.sessionExists(SESSION_NAME)) {
    console.error(chalk.red(`Tmux session not found: ${SESSION_NAME}`));
    console.log('Use --list to see available sessions, or --create to create a new one');
    process.exit(1);
  }

  console.log(chalk.bold(`\n🎯 sohappy CLI`));
  console.log(`Session:   ${chalk.cyan(SESSION_NAME)}`);
  console.log(`Server:    ${chalk.cyan(SERVER_URL)}`);
  console.log(`Encrypted: ${ENCRYPTED ? chalk.green('Yes 🔒') : chalk.yellow('No')}`);
  if (USER_SECRET) {
    console.log(`User Auth: ${chalk.green('Enabled 🔑')}`);
  }
  console.log();

  // Initialize tmux capture
  const capture = new TmuxCapture({
    sessionName: SESSION_NAME,
    pollIntervalMs: 100,
  });

  // Initialize encrypted WebSocket client
  const wsClient = new EncryptedWSClient({
    serverUrl: SERVER_URL,
    sessionId: SESSION_NAME,
    userSecret: USER_SECRET,
    onConnect: () => {
      console.log(chalk.green('✓ Connected to server'));

      if (ENCRYPTED) {
        // Show pairing info
        const pairingData = wsClient.getPairingData();
        console.log(chalk.bold('\n📱 Pairing Information:'));
        console.log(chalk.dim(`Session ID: ${pairingData.sessionId}`));
        console.log(chalk.dim(`Public Key: ${pairingData.publicKey.substring(0, 20)}...`));

        // Generate QR code for pairing
        const pairingCode = wsClient.getPairingCode();
        const pairingUrl = `${SERVER_URL}/?session=${encodeURIComponent(SESSION_NAME)}&pairing=${encodeURIComponent(pairingCode)}`;
        console.log(chalk.bold('\n🔗 Connect URL:'));
        console.log(chalk.cyan(pairingUrl));
        console.log(chalk.bold('\n📷 Or scan QR code:'));
        qrcode.generate(pairingUrl, { small: true });
      }

      // Start capturing after connected
      capture.start((event) => {
        const viewerCount = wsClient.getPairedViewerCount();
        // Always send output - the client caches it for new viewers
        console.log(chalk.dim(`→ Output [seq=${event.seq}] ${event.content.length} bytes → ${viewerCount} viewer(s)`));
        wsClient.sendEncryptedOutput(event);
      });

      console.log(chalk.green('\nCapturing tmux output... Press Ctrl+C to stop\n'));
    },
    onDisconnect: () => {
      console.log(chalk.yellow('⚠ Disconnected from server'));
    },
    onError: (error) => {
      console.error(chalk.red(`Connection error: ${error.message}`));
    },
    onPaired: (viewerId) => {
      console.log(chalk.green(`🔗 Viewer paired: ${viewerId.substring(0, 8)}...`));
    },
  });

  // Connect to server
  wsClient.connect();

  // Handle decrypted input from remote clients
  wsClient.onDecryptedInput((data) => {
    console.log(chalk.dim(`← Input: ${JSON.stringify(data)}`));
    if (data.type === 'special') {
      capture.sendSpecialKey(data.keys);
    } else {
      capture.sendKeys(data.keys);
    }
  });

  // Handle graceful shutdown
  const shutdown = (): void => {
    console.log(chalk.yellow('\nShutting down...'));
    capture.stop();
    wsClient.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
