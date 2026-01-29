import { io, Socket } from 'socket.io-client';
import {
  generateKeyPair,
  computeSharedSecret,
  encrypt,
  decrypt,
  decryptToString,
  generatePairingCode,
  encodePairingCode,
  publicKeyFromBase64,
  publicKeyToBase64,
  type KeyPair,
  type EncryptedMessage,
  type PairingCode,
} from '@sohappy/crypto';
import type { OutputEvent } from '../tmux/index.js';

export interface EncryptedWSClientOptions {
  serverUrl: string;
  sessionId: string;
  userSecret?: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  onPaired?: (viewerId: string) => void;
}

export interface EncryptedOutputEvent {
  type: 'encrypted-output';
  seq: number;
  encrypted: EncryptedMessage;
  timestamp: number;
}

/**
 * Encrypted WebSocket client for CLI
 * Handles key exchange and E2E encryption
 */
export class EncryptedWSClient {
  private socket: Socket | null = null;
  private options: EncryptedWSClientOptions;
  private keyPair: KeyPair;
  private sharedSecrets: Map<string, Uint8Array> = new Map(); // viewerId -> sharedSecret
  private pairingCode: PairingCode;
  private lastOutputEvent: OutputEvent | null = null; // Cache last output for new viewers

  constructor(options: EncryptedWSClientOptions) {
    this.options = options;
    // Generate key pair for this session
    this.keyPair = generateKeyPair();
    this.pairingCode = generatePairingCode(
      options.sessionId,
      this.keyPair.publicKey
    );
  }

  /**
   * Get the pairing code for QR code display
   */
  getPairingCode(): string {
    return encodePairingCode(this.pairingCode);
  }

  /**
   * Get pairing code data
   */
  getPairingData(): PairingCode {
    return this.pairingCode;
  }

  /**
   * Connect to the server
   */
  connect(): void {
    this.socket = io(this.options.serverUrl, {
      query: {
        sessionId: this.options.sessionId,
        clientType: 'cli',
        publicKey: publicKeyToBase64(this.keyPair.publicKey),
        userSecret: this.options.userSecret,
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this.socket.on('connect', () => {
      console.log(`Connected to server: ${this.options.serverUrl}`);
      this.options.onConnect?.();
    });

    this.socket.on('disconnect', (reason) => {
      console.log(`Disconnected from server: ${reason}`);
      this.options.onDisconnect?.();
    });

    this.socket.on('connect_error', (error) => {
      console.error('Connection error:', error.message);
      this.options.onError?.(error);
    });

    // Handle viewer key exchange
    this.socket.on('viewer-joined', (data: { viewerId: string; publicKey: string }) => {
      console.log(`Viewer joined: ${data.viewerId}`);
      const viewerPublicKey = publicKeyFromBase64(data.publicKey);
      const sharedSecret = computeSharedSecret(this.keyPair.secretKey, viewerPublicKey);
      this.sharedSecrets.set(data.viewerId, sharedSecret);
      this.options.onPaired?.(data.viewerId);

      // Immediately send current terminal state to new viewer if we have it
      if (this.lastOutputEvent) {
        const encrypted = encrypt(JSON.stringify(this.lastOutputEvent), sharedSecret);
        this.socket?.emit('encrypted-output', {
          viewerId: data.viewerId,
          encrypted,
          seq: this.lastOutputEvent.seq,
          timestamp: this.lastOutputEvent.timestamp,
        });
      }
    });

    this.socket.on('viewer-left', (data: { viewerId: string }) => {
      console.log(`Viewer left: ${data.viewerId}`);
      this.sharedSecrets.delete(data.viewerId);
    });

    // Handle encrypted input from viewers
    this.socket.on('encrypted-input', (data: {
      viewerId: string;
      encrypted: EncryptedMessage;
    }) => {
      const sharedSecret = this.sharedSecrets.get(data.viewerId);
      if (!sharedSecret) {
        console.warn(`No shared secret for viewer: ${data.viewerId}`);
        return;
      }

      const decrypted = decryptToString(data.encrypted, sharedSecret);
      if (!decrypted) {
        console.warn('Failed to decrypt input');
        return;
      }

      try {
        const input = JSON.parse(decrypted);
        // Emit decrypted input event
        this.socket?.emit('_decrypted-input', input);
      } catch {
        console.warn('Failed to parse decrypted input');
      }
    });
  }

  /**
   * Send encrypted output event to all paired viewers
   */
  sendEncryptedOutput(event: OutputEvent): void {
    // Always cache the last output for new viewers
    this.lastOutputEvent = event;

    if (!this.socket?.connected) {
      console.warn('Socket not connected, cannot send output');
      return;
    }

    // Send encrypted output to each viewer
    for (const [viewerId, sharedSecret] of this.sharedSecrets) {
      const encrypted = encrypt(JSON.stringify(event), sharedSecret);
      this.socket.emit('encrypted-output', {
        viewerId,
        encrypted,
        seq: event.seq,
        timestamp: event.timestamp,
      });
    }

    // Also send to server for relay (server cannot decrypt)
    // This allows new viewers to get history (encrypted)
    if (this.sharedSecrets.size > 0) {
      // Use first viewer's encryption for history storage
      const firstEntry = this.sharedSecrets.entries().next().value;
      if (firstEntry) {
        const [firstViewerId, firstSecret] = firstEntry;
        const encrypted = encrypt(JSON.stringify(event), firstSecret);
        this.socket.emit('output-history', {
          encrypted,
          seq: event.seq,
          timestamp: event.timestamp,
        });
      }
    }
  }

  /**
   * Register handler for decrypted input
   */
  onDecryptedInput(handler: (data: { keys: string; type: 'text' | 'special' }) => void): void {
    this.socket?.on('_decrypted-input', handler);
  }

  /**
   * Check if any viewers are paired
   */
  hasPairedViewers(): boolean {
    return this.sharedSecrets.size > 0;
  }

  /**
   * Get number of paired viewers
   */
  getPairedViewerCount(): number {
    return this.sharedSecrets.size;
  }

  /**
   * Disconnect from server
   */
  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.sharedSecrets.clear();
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}
