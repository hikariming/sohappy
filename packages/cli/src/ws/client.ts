import { io, Socket } from 'socket.io-client';
import type { OutputEvent } from '../tmux/index.js';

export interface WSClientOptions {
  serverUrl: string;
  sessionId: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

/**
 * WebSocket client for connecting CLI to server
 */
export class WSClient {
  private socket: Socket | null = null;
  private options: WSClientOptions;

  constructor(options: WSClientOptions) {
    this.options = options;
  }

  /**
   * Connect to the server
   */
  connect(): void {
    this.socket = io(this.options.serverUrl, {
      query: {
        sessionId: this.options.sessionId,
        clientType: 'cli',
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

    // Handle input from remote clients
    this.socket.on('input', (data: { keys: string; type: 'text' | 'special' }) => {
      console.log('Received input:', data);
      // This will be handled by the main CLI
    });
  }

  /**
   * Send output event to server
   */
  sendOutput(event: OutputEvent): void {
    if (!this.socket?.connected) {
      console.warn('Socket not connected, cannot send output');
      return;
    }
    this.socket.emit('output', event);
  }

  /**
   * Register input handler
   */
  onInput(handler: (data: { keys: string; type: 'text' | 'special' }) => void): void {
    this.socket?.on('input', handler);
  }

  /**
   * Disconnect from server
   */
  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}
