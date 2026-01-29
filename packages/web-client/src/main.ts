import { io, Socket } from 'socket.io-client';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import {
  generateKeyPair,
  computeSharedSecret,
  encrypt,
  decryptToString,
  publicKeyFromBase64,
  publicKeyToBase64,
  type KeyPair,
  type EncryptedMessage,
} from './crypto';

interface OutputEvent {
  type: 'output';
  seq: number;
  content: string;
  timestamp: number;
}

interface CliStatus {
  connected: boolean;
  publicKey?: string | null;
  encrypted?: boolean;
}

interface ControlStatus {
  locked: boolean;
  holderId?: string;
  holderNickname?: string;
  acquiredAt?: number;
}

// DOM Elements
const sessionInput = document.getElementById('session-input') as HTMLInputElement;
const nicknameInput = document.getElementById('nickname-input') as HTMLInputElement;
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const inputField = document.getElementById('input-field') as HTMLInputElement;
const terminalContainer = document.getElementById('terminal-container') as HTMLDivElement;
const cliStatusEl = document.getElementById('cli-status') as HTMLSpanElement;
const serverStatus = document.getElementById('server-status') as HTMLSpanElement;
const seqCounter = document.getElementById('seq-counter') as HTMLSpanElement;
const latencyDisplay = document.getElementById('latency') as HTMLSpanElement;
const specialKeys = document.querySelectorAll('.key-btn');
const controlIndicator = document.getElementById('control-indicator') as HTMLSpanElement;
const requestControlBtn = document.getElementById('request-control-btn') as HTMLButtonElement;
const releaseControlBtn = document.getElementById('release-control-btn') as HTMLButtonElement;

// State
let socket: Socket | null = null;
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let currentSeq = 0;
let mySocketId: string | null = null;

// Encryption state
let keyPair: KeyPair | null = null;
let sharedSecret: Uint8Array | null = null;
let isEncrypted = false;

// Control state
let hasControl = false;
let controlLocked = false;

// Initialize terminal
function initTerminal(): void {
  terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffffff',
    },
    convertEol: true,
    scrollback: 5000,
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalContainer);
  fitAddon.fit();

  window.addEventListener('resize', () => {
    fitAddon?.fit();
  });

  terminal.onKey(({ key, domEvent }) => {
    if (!socket?.connected) return;
    if (!hasControl && controlLocked) {
      terminal?.writeln('\r\n[You do not have control. Request control first.]\r\n');
      return;
    }

    if (domEvent.ctrlKey && domEvent.key.length === 1) {
      const ctrlKey = `C-${domEvent.key.toLowerCase()}`;
      sendInput(ctrlKey, 'special');
    } else if (domEvent.key === 'Enter') {
      sendInput('Enter', 'special');
    } else if (domEvent.key === 'Tab') {
      sendInput('Tab', 'special');
    } else if (domEvent.key === 'Escape') {
      sendInput('Escape', 'special');
    } else if (domEvent.key === 'Backspace') {
      sendInput('BSpace', 'special');
    } else if (domEvent.key === 'ArrowUp') {
      sendInput('Up', 'special');
    } else if (domEvent.key === 'ArrowDown') {
      sendInput('Down', 'special');
    } else if (domEvent.key === 'ArrowLeft') {
      sendInput('Left', 'special');
    } else if (domEvent.key === 'ArrowRight') {
      sendInput('Right', 'special');
    } else if (key.length === 1) {
      sendInput(key, 'text');
    }
  });
}

// Connect to server
function connect(sessionId: string, nickname?: string): void {
  if (socket?.connected) {
    socket.disconnect();
  }

  updateServerStatus(false);
  updateCliStatus(false, false);
  updateControlStatus({ locked: false });

  keyPair = generateKeyPair();
  sharedSecret = null;
  isEncrypted = false;
  hasControl = false;
  controlLocked = false;

  socket = io({
    query: {
      sessionId,
      clientType: 'viewer',
      publicKey: publicKeyToBase64(keyPair.publicKey),
      nickname: nickname || undefined,
    },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
  });

  socket.on('connect', () => {
    console.log('Connected to server');
    mySocketId = socket!.id ?? null;
    updateServerStatus(true);
    inputField.disabled = false;
    connectBtn.textContent = 'Disconnect';
    requestControlBtn.disabled = false;
    terminal?.clear();
    terminal?.writeln(`Connected to session: ${sessionId}\r\n`);

    socket?.emit('get-history');
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from server');
    updateServerStatus(false);
    inputField.disabled = true;
    connectBtn.textContent = 'Connect';
    requestControlBtn.disabled = true;
    releaseControlBtn.style.display = 'none';
    sharedSecret = null;
    isEncrypted = false;
    hasControl = false;
    mySocketId = null;
  });

  socket.on('cli-status', (data: CliStatus) => {
    updateCliStatus(data.connected, data.encrypted ?? false);

    if (data.connected && data.publicKey && keyPair) {
      const cliPublicKey = publicKeyFromBase64(data.publicKey);
      sharedSecret = computeSharedSecret(keyPair.secretKey, cliPublicKey);
      isEncrypted = true;
      console.log('E2E encryption established');
      terminal?.writeln('\r\n🔒 E2E encryption enabled\r\n');
    } else if (data.connected) {
      terminal?.writeln('\r\n--- CLI connected (unencrypted) ---\r\n');
    } else {
      terminal?.writeln('\r\n--- CLI disconnected ---\r\n');
      sharedSecret = null;
    }
  });

  // Control status
  socket.on('control-status', (data: ControlStatus) => {
    updateControlStatus(data);
  });

  socket.on('control-denied', (data: { reason: string; holderId?: string; holderNickname?: string }) => {
    const holder = data.holderNickname || data.holderId?.substring(0, 8) || 'someone';
    terminal?.writeln(`\r\n[Control denied: ${holder} has control]\r\n`);
  });

  socket.on('input-rejected', (data: { reason: string }) => {
    if (data.reason === 'not-controller') {
      terminal?.writeln('\r\n[Input rejected: You do not have control]\r\n');
    }
  });

  // Handle unencrypted output
  socket.on('output', (event: OutputEvent) => {
    handleOutput(event);
  });

  // Handle encrypted output
  socket.on('encrypted-output', (data: { encrypted: EncryptedMessage; seq: number; timestamp: number }) => {
    if (!sharedSecret) {
      console.warn('Received encrypted output but no shared secret');
      return;
    }

    const decrypted = decryptToString(data.encrypted, sharedSecret);
    if (!decrypted) {
      console.error('Failed to decrypt output');
      terminal?.writeln('\r\n[Decryption failed]\r\n');
      return;
    }

    try {
      const event: OutputEvent = JSON.parse(decrypted);
      handleOutput(event);
    } catch (e) {
      console.error('Failed to parse decrypted output:', e);
    }
  });

  // Handle unencrypted history
  socket.on('history', (events: OutputEvent[]) => {
    console.log(`Received ${events.length} history events`);
    events.forEach((event) => handleOutput(event, true));
  });

  // Handle encrypted history
  socket.on('encrypted-history', (events: Array<{ encrypted: EncryptedMessage; seq: number; timestamp: number }>) => {
    if (!sharedSecret) {
      console.warn('Received encrypted history but no shared secret');
      return;
    }

    console.log(`Received ${events.length} encrypted history events`);
    events.forEach((data) => {
      const decrypted = decryptToString(data.encrypted, sharedSecret!);
      if (decrypted) {
        try {
          const event: OutputEvent = JSON.parse(decrypted);
          handleOutput(event, true);
        } catch {
          // ignore parse errors in history
        }
      }
    });
  });

  socket.on('error', (data: { message: string }) => {
    console.error('Server error:', data.message);
    terminal?.writeln(`\r\n[Error: ${data.message}]\r\n`);
  });
}

// Handle output event
function handleOutput(event: OutputEvent, isHistory = false): void {
  if (event.seq <= currentSeq && !isHistory) {
    console.log(`Skipping duplicate seq: ${event.seq}`);
    return;
  }

  currentSeq = event.seq;
  seqCounter.textContent = `Seq: ${currentSeq}`;

  if (!isHistory) {
    const latency = Date.now() - event.timestamp;
    latencyDisplay.textContent = `Latency: ${latency}ms`;
  }

  terminal?.clear();
  terminal?.write(event.content);
}

// Send input to CLI
function sendInput(keys: string, type: 'text' | 'special'): void {
  if (!socket?.connected) return;

  const inputData = { keys, type };

  if (isEncrypted && sharedSecret) {
    const encrypted = encrypt(JSON.stringify(inputData), sharedSecret);
    socket.emit('encrypted-input', { encrypted });
    console.log(`Sent encrypted input: ${type}:${keys}`);
  } else {
    socket.emit('input', inputData);
    console.log(`Sent input: ${type}:${keys}`);
  }
}

// Update status indicators
function updateServerStatus(connected: boolean): void {
  serverStatus.textContent = connected ? 'Server: Connected' : 'Server: Disconnected';
  serverStatus.className = `status ${connected ? 'connected' : 'disconnected'}`;
}

function updateCliStatus(connected: boolean, encrypted: boolean): void {
  if (connected && encrypted) {
    cliStatusEl.textContent = 'CLI: 🔒 Encrypted';
    cliStatusEl.className = 'status connected';
  } else if (connected) {
    cliStatusEl.textContent = 'CLI: Connected';
    cliStatusEl.className = 'status connected';
  } else {
    cliStatusEl.textContent = 'CLI: Disconnected';
    cliStatusEl.className = 'status disconnected';
  }
}

function updateControlStatus(data: ControlStatus): void {
  controlLocked = data.locked;

  if (!data.locked) {
    controlIndicator.textContent = '🔓 No controller';
    controlIndicator.className = '';
    hasControl = false;
    requestControlBtn.style.display = 'inline-block';
    requestControlBtn.textContent = 'Request Control';
    releaseControlBtn.style.display = 'none';
  } else if (data.holderId === mySocketId) {
    controlIndicator.textContent = '🎮 You have control';
    controlIndicator.className = 'has-control';
    hasControl = true;
    requestControlBtn.style.display = 'none';
    releaseControlBtn.style.display = 'inline-block';
    releaseControlBtn.disabled = false;
  } else {
    const holder = data.holderNickname || data.holderId?.substring(0, 8) || 'someone';
    controlIndicator.textContent = `🔒 ${holder} has control`;
    controlIndicator.className = 'other-control';
    hasControl = false;
    requestControlBtn.style.display = 'inline-block';
    requestControlBtn.textContent = 'Request Control';
    releaseControlBtn.style.display = 'none';
  }
}

// Event handlers
connectBtn.addEventListener('click', () => {
  if (socket?.connected) {
    socket.disconnect();
    return;
  }

  const sessionId = sessionInput.value.trim();
  const nickname = nicknameInput.value.trim();
  if (!sessionId) {
    alert('Please enter a session ID');
    return;
  }
  connect(sessionId, nickname);
});

sessionInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    connectBtn.click();
  }
});

nicknameInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    connectBtn.click();
  }
});

inputField.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    const text = inputField.value;
    if (text) {
      if (!hasControl && controlLocked) {
        terminal?.writeln('\r\n[You do not have control. Request control first.]\r\n');
        return;
      }
      sendInput(text, 'text');
      sendInput('Enter', 'special');
      inputField.value = '';
    }
  }
});

specialKeys.forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = (btn as HTMLButtonElement).dataset.key;
    if (key) {
      if (!hasControl && controlLocked) {
        terminal?.writeln('\r\n[You do not have control. Request control first.]\r\n');
        return;
      }
      sendInput(key, 'special');
    }
  });
});

requestControlBtn.addEventListener('click', () => {
  if (socket?.connected) {
    socket.emit('request-control');
  }
});

releaseControlBtn.addEventListener('click', () => {
  if (socket?.connected) {
    socket.emit('release-control');
  }
});

// Initialize
initTerminal();

// Auto-connect if session in URL
const urlParams = new URLSearchParams(window.location.search);
const sessionFromUrl = urlParams.get('session');
if (sessionFromUrl) {
  sessionInput.value = sessionFromUrl;
  connect(sessionFromUrl);
}
