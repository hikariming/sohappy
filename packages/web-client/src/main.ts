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

interface PairingCode {
  sessionId: string;
  publicKey: string;
  timestamp: number;
}

interface ControlStatus {
  locked: boolean;
  holderId?: string;
  holderNickname?: string;
  acquiredAt?: number;
}

const SERVER_URL = (import.meta as ImportMeta & { env?: { VITE_SERVER_URL?: string } }).env?.VITE_SERVER_URL
  ?? `${window.location.protocol}//${window.location.hostname}:3010`;

// DOM Elements
const userSecretInput = document.getElementById('user-secret-input') as HTMLInputElement;
const loginBtn = document.getElementById('login-btn') as HTMLButtonElement;
const loginSection = document.getElementById('login-section') as HTMLDivElement;
const sessionsList = document.getElementById('sessions-list') as HTMLDivElement;
const sessionsContainer = document.getElementById('sessions-container') as HTMLDivElement;
const logoutBtn = document.getElementById('logout-btn') as HTMLButtonElement;
const sessionSelector = document.getElementById('session-selector') as HTMLDivElement;
const sessionInput = document.getElementById('session-input') as HTMLInputElement;
const nicknameInput = document.getElementById('nickname-input') as HTMLInputElement;
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const backBtn = document.getElementById('back-btn') as HTMLButtonElement;
const inputField = document.getElementById('input-field') as HTMLInputElement;
const terminalContainer = document.getElementById('terminal-container') as HTMLDivElement;
const cliStatusEl = document.getElementById('cli-status') as HTMLSpanElement;
const serverStatus = document.getElementById('server-status') as HTMLSpanElement;
const pairingFingerprintEl = document.getElementById('pairing-fingerprint') as HTMLSpanElement;
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

// Pairing state
let pairingCode: PairingCode | null = null;
let pairingFingerprint: string | null = null;

// Control state
let hasControl = false;
let controlLocked = false;

// User state
let currentUserSecret: string | null = null;
let currentUserId: string | null = null;

interface SessionInfo {
  id: string;
  hasCliConnected: boolean;
  viewerCount: number;
  lastOutputSeq: number;
  encrypted: boolean;
  controlLocked: boolean;
  controlHolder: string | null;
  createdAt: number;
}

// Login and fetch user sessions
async function login(userSecret: string): Promise<void> {
  currentUserSecret = userSecret;

  try {
    const response = await fetch(`${SERVER_URL}/api/user/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userSecret }),
    });

    const data = await response.json();

    if (data.error) {
      alert(`Error: ${data.error}`);
      return;
    }

    currentUserId = data.userId;
    displaySessions(data.sessions);

    // Hide login, show sessions list
    loginSection.style.display = 'none';
    sessionsList.style.display = 'block';
  } catch (error) {
    console.error('Login failed:', error);
    alert('Failed to connect to server');
  }
}

// Display user's sessions
function displaySessions(sessions: SessionInfo[]): void {
  sessionsContainer.innerHTML = '';

  if (sessions.length === 0) {
    sessionsContainer.innerHTML = '<p>No sessions found. Start a CLI session first.</p>';
    return;
  }

  sessions.forEach((session) => {
    const sessionEl = document.createElement('div');
    sessionEl.className = 'session-item';
    sessionEl.innerHTML = `
      <div class="session-info">
        <strong>${session.id}</strong>
        <span class="${session.hasCliConnected ? 'connected' : 'disconnected'}">
          ${session.hasCliConnected ? '🟢 Connected' : '🔴 Offline'}
        </span>
        <span>${session.encrypted ? '🔒 Encrypted' : '🔓 Unencrypted'}</span>
        <span>Viewers: ${session.viewerCount}</span>
        <span>Seq: ${session.lastOutputSeq}</span>
      </div>
      <button class="join-session-btn" data-session-id="${session.id}">Join</button>
    `;
    sessionsContainer.appendChild(sessionEl);
  });

  // Add event listeners to join buttons
  document.querySelectorAll('.join-session-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const sessionId = (e.target as HTMLButtonElement).dataset.sessionId;
      if (sessionId) {
        selectSession(sessionId);
      }
    });
  });
}

// Select a session to join
function selectSession(sessionId: string): void {
  pairingCode = null;
  pairingFingerprint = null;
  updatePairingStatus('Pairing: --');
  sessionInput.value = sessionId;
  sessionsList.style.display = 'none';
  sessionSelector.style.display = 'block';
}

// Go back to sessions list
function goBackToSessions(): void {
  if (socket?.connected) {
    socket.disconnect();
  }
  sessionSelector.style.display = 'none';
  terminalContainer.style.display = 'none';
  if (currentUserSecret) {
    login(currentUserSecret);
  }
}

// Logout
function logout(): void {
  if (socket?.connected) {
    socket.disconnect();
  }
  currentUserSecret = null;
  currentUserId = null;
  sessionsList.style.display = 'none';
  loginSection.style.display = 'block';
  userSecretInput.value = '';
}

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

  // Show terminal container when connecting
  terminalContainer.style.display = 'block';

  socket = io(SERVER_URL, {
    query: {
      sessionId,
      clientType: 'viewer',
      publicKey: publicKeyToBase64(keyPair.publicKey),
      nickname: nickname || undefined,
      userSecret: currentUserSecret || undefined,
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
      void verifyPairing(data.publicKey);
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

function updatePairingStatus(text: string, className?: string): void {
  pairingFingerprintEl.textContent = text;
  pairingFingerprintEl.className = className ? `status ${className}` : 'status';
}

async function fingerprintFromBase64(base64: string): Promise<string> {
  try {
    if (!window.crypto?.subtle) return 'unknown';
    const bytes = publicKeyFromBase64(base64);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return hex.slice(0, 12);
  } catch {
    return 'unknown';
  }
}

async function verifyPairing(cliPublicKey: string): Promise<void> {
  if (!pairingCode) return;
  if (!pairingFingerprint) {
    pairingFingerprint = await fingerprintFromBase64(pairingCode.publicKey);
  }

  const cliFingerprint = await fingerprintFromBase64(cliPublicKey);
  if (pairingCode.publicKey === cliPublicKey) {
    updatePairingStatus(`Pairing: verified (${cliFingerprint})`, 'connected');
  } else {
    updatePairingStatus(`Pairing: mismatch (${cliFingerprint})`, 'warning');
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
loginBtn.addEventListener('click', () => {
  const userSecret = userSecretInput.value.trim();
  if (!userSecret) {
    alert('Please enter your secret key');
    return;
  }
  login(userSecret);
});

userSecretInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    loginBtn.click();
  }
});

logoutBtn.addEventListener('click', () => {
  logout();
});

backBtn.addEventListener('click', () => {
  goBackToSessions();
});

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

// Parse pairing/session from URL
const urlParams = new URLSearchParams(window.location.search);
const pairingParam = urlParams.get('pairing');
const sessionParam = urlParams.get('session');

if (pairingParam) {
  try {
    const parsed = JSON.parse(pairingParam) as PairingCode;
    if (parsed.sessionId && parsed.publicKey && parsed.timestamp) {
      pairingCode = parsed;
      sessionInput.value = parsed.sessionId;
      // 隐藏登录区域，直接显示连接界面
      loginSection.style.display = 'none';
      sessionsList.style.display = 'none';
      sessionSelector.style.display = 'block';
      void fingerprintFromBase64(parsed.publicKey).then((fp) => {
        pairingFingerprint = fp;
        updatePairingStatus(`Pairing: loaded (${fp})`);
      });
    } else {
      updatePairingStatus('Pairing: invalid', 'warning');
    }
  } catch {
    updatePairingStatus('Pairing: invalid', 'warning');
  }
} else if (sessionParam) {
  sessionInput.value = sessionParam;
  // 隐藏登录区域，直接显示连接界面
  loginSection.style.display = 'none';
  sessionsList.style.display = 'none';
  sessionSelector.style.display = 'block';
}

// Hide terminal initially
terminalContainer.style.display = 'none';

// Check for stored userSecret (optional - for convenience)
const storedSecret = localStorage.getItem('sohappy-user-secret');
if (storedSecret) {
  userSecretInput.value = storedSecret;
}

// Save userSecret on login (optional)
const originalLogin = login;
async function loginWithSave(userSecret: string): Promise<void> {
  localStorage.setItem('sohappy-user-secret', userSecret);
  return originalLogin(userSecret);
}

// Replace login function
login = loginWithSave;
