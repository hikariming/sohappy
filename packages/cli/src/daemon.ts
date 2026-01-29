import { io, Socket } from 'socket.io-client';
import { TmuxCapture } from './tmux/index.js';
import {
    generateKeyPair,
    computeSharedSecret,
    encrypt,
    decryptToString,
    generatePairingCode,
    encodePairingCode,
    publicKeyFromBase64,
    publicKeyToBase64,
    type KeyPair,
    type EncryptedMessage,
    type PairingCode,
} from '@sohappy/crypto';
import type { OutputEvent } from './tmux/index.js';
import chalk from 'chalk';

export interface DaemonOptions {
    serverUrl: string;
    userSecret?: string;
    onConnect?: () => void;
    onDisconnect?: () => void;
    onError?: (error: Error) => void;
}

interface SessionCapture {
    sessionName: string;
    capture: TmuxCapture;
    keyPair: KeyPair;
    pairingCode: PairingCode;
    sharedSecrets: Map<string, Uint8Array>; // viewerId -> sharedSecret
    lastOutput: OutputEvent | null;
}

interface CommandMessage {
    commandId: string;
    command: 'list-sessions' | 'create-session' | 'attach-session' | 'detach-session';
    params?: Record<string, string>;
}

interface CommandResponse {
    commandId: string;
    success: boolean;
    data?: unknown;
    error?: string;
}

/**
 * CLI Daemon 管理器
 * 支持同时管理多个 tmux session 的捕获
 */
export class DaemonManager {
    private socket: Socket | null = null;
    private options: DaemonOptions;
    private activeSessions: Map<string, SessionCapture> = new Map();
    private inputHandler: ((sessionName: string, data: { keys: string; type: 'text' | 'special' }) => void) | null = null;

    constructor(options: DaemonOptions) {
        this.options = options;
    }

    /**
     * 连接到服务器
     */
    connect(): void {
        this.socket = io(this.options.serverUrl, {
            query: {
                clientType: 'cli-daemon',
                userSecret: this.options.userSecret,
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
        });

        this.socket.on('connect', () => {
            console.log(chalk.green(`✓ Daemon connected to server: ${this.options.serverUrl}`));
            this.options.onConnect?.();

            // 发送当前已 attach 的 sessions 列表
            this.broadcastActiveSessionsList();
        });

        this.socket.on('disconnect', (reason) => {
            console.log(chalk.yellow(`⚠ Daemon disconnected: ${reason}`));
            this.options.onDisconnect?.();
        });

        this.socket.on('connect_error', (error) => {
            console.error(chalk.red(`Connection error: ${error.message}`));
            this.options.onError?.(error);
        });

        // 处理来自服务器的命令
        this.socket.on('cli-command', (msg: CommandMessage) => {
            console.log(chalk.dim(`← Command: ${msg.command}`));
            this.handleCommand(msg);
        });

        // 处理 viewer 加入某个 session
        this.socket.on('viewer-joined', (data: { sessionId: string; viewerId: string; publicKey: string }) => {
            this.handleViewerJoined(data);
        });

        // 处理 viewer 离开
        this.socket.on('viewer-left', (data: { sessionId: string; viewerId: string }) => {
            this.handleViewerLeft(data);
        });

        // 处理加密输入
        this.socket.on('encrypted-input', (data: {
            sessionId: string;
            viewerId: string;
            encrypted: EncryptedMessage;
        }) => {
            this.handleEncryptedInput(data);
        });
    }

    /**
     * 处理服务器命令
     */
    private handleCommand(msg: CommandMessage): void {
        let response: CommandResponse;

        try {
            switch (msg.command) {
                case 'list-sessions':
                    response = this.cmdListSessions(msg.commandId);
                    break;
                case 'create-session':
                    response = this.cmdCreateSession(msg.commandId, msg.params?.name);
                    break;
                case 'attach-session':
                    response = this.cmdAttachSession(msg.commandId, msg.params?.name);
                    break;
                case 'detach-session':
                    response = this.cmdDetachSession(msg.commandId, msg.params?.name);
                    break;
                default:
                    response = {
                        commandId: msg.commandId,
                        success: false,
                        error: `Unknown command: ${msg.command}`,
                    };
            }
        } catch (e) {
            response = {
                commandId: msg.commandId,
                success: false,
                error: e instanceof Error ? e.message : 'Unknown error',
            };
        }

        this.socket?.emit('cli-response', response);
    }

    /**
     * 列出本机所有 tmux sessions
     */
    private cmdListSessions(commandId: string): CommandResponse {
        const allSessions = TmuxCapture.listSessions();
        const activeSessions = Array.from(this.activeSessions.keys());

        return {
            commandId,
            success: true,
            data: {
                all: allSessions,
                active: activeSessions,
                sessions: allSessions.map((name) => ({
                    name,
                    attached: activeSessions.includes(name),
                    viewerCount: this.activeSessions.get(name)?.sharedSecrets.size ?? 0,
                })),
            },
        };
    }

    /**
     * 创建新 tmux session
     */
    private cmdCreateSession(commandId: string, name?: string): CommandResponse {
        if (!name) {
            return { commandId, success: false, error: 'Session name is required' };
        }

        if (TmuxCapture.sessionExists(name)) {
            return { commandId, success: false, error: `Session "${name}" already exists` };
        }

        TmuxCapture.createSession(name);
        console.log(chalk.green(`Created tmux session: ${name}`));

        return { commandId, success: true, data: { name } };
    }

    /**
     * 开始捕获指定 session
     */
    private cmdAttachSession(commandId: string, name?: string): CommandResponse {
        if (!name) {
            return { commandId, success: false, error: 'Session name is required' };
        }

        if (!TmuxCapture.sessionExists(name)) {
            return { commandId, success: false, error: `Session "${name}" does not exist` };
        }

        if (this.activeSessions.has(name)) {
            return { commandId, success: false, error: `Session "${name}" is already attached` };
        }

        // 创建新的捕获实例
        const capture = new TmuxCapture({
            sessionName: name,
            pollIntervalMs: 100,
        });

        const keyPair = generateKeyPair();
        const pairingCode = generatePairingCode(name, keyPair.publicKey);

        const sessionCapture: SessionCapture = {
            sessionName: name,
            capture,
            keyPair,
            pairingCode,
            sharedSecrets: new Map(),
            lastOutput: null,
        };

        this.activeSessions.set(name, sessionCapture);

        // 通知服务器新 session 已 attach
        this.socket?.emit('session-attached', {
            sessionId: name,
            publicKey: publicKeyToBase64(keyPair.publicKey),
            encrypted: true,
        });

        // 开始捕获
        capture.start((event) => {
            sessionCapture.lastOutput = event;
            this.broadcastOutput(name, event);
        });

        console.log(chalk.green(`Attached to session: ${name}`));
        console.log(chalk.dim(`Public Key: ${publicKeyToBase64(keyPair.publicKey).substring(0, 20)}...`));

        return {
            commandId,
            success: true,
            data: {
                name,
                publicKey: publicKeyToBase64(keyPair.publicKey),
                pairingCode: encodePairingCode(pairingCode),
            },
        };
    }

    /**
     * 停止捕获指定 session
     */
    private cmdDetachSession(commandId: string, name?: string): CommandResponse {
        if (!name) {
            return { commandId, success: false, error: 'Session name is required' };
        }

        const session = this.activeSessions.get(name);
        if (!session) {
            return { commandId, success: false, error: `Session "${name}" is not attached` };
        }

        session.capture.stop();
        this.activeSessions.delete(name);

        // 通知服务器 session 已 detach
        this.socket?.emit('session-detached', { sessionId: name });

        console.log(chalk.yellow(`Detached from session: ${name}`));

        return { commandId, success: true, data: { name } };
    }

    /**
     * 广播已 attach 的 sessions 列表
     */
    private broadcastActiveSessionsList(): void {
        const sessions = Array.from(this.activeSessions.entries()).map(([name, session]) => ({
            sessionId: name,
            publicKey: publicKeyToBase64(session.keyPair.publicKey),
            encrypted: true,
            viewerCount: session.sharedSecrets.size,
        }));

        this.socket?.emit('active-sessions', { sessions });
    }

    /**
     * 处理 viewer 加入
     */
    private handleViewerJoined(data: { sessionId: string; viewerId: string; publicKey: string }): void {
        const session = this.activeSessions.get(data.sessionId);
        if (!session) {
            console.warn(`Viewer joined unknown session: ${data.sessionId}`);
            return;
        }

        console.log(chalk.dim(`Viewer joined session ${data.sessionId}: ${data.viewerId.substring(0, 8)}...`));

        try {
            const viewerPublicKey = publicKeyFromBase64(data.publicKey);
            const sharedSecret = computeSharedSecret(session.keyPair.secretKey, viewerPublicKey);
            session.sharedSecrets.set(data.viewerId, sharedSecret);

            // 发送当前终端状态给新 viewer
            if (session.lastOutput) {
                const encrypted = encrypt(JSON.stringify(session.lastOutput), sharedSecret);
                this.socket?.emit('encrypted-output', {
                    sessionId: data.sessionId,
                    viewerId: data.viewerId,
                    encrypted,
                    seq: session.lastOutput.seq,
                    timestamp: session.lastOutput.timestamp,
                });
            }
        } catch (e) {
            console.error('Failed to compute shared secret:', e);
        }
    }

    /**
     * 处理 viewer 离开
     */
    private handleViewerLeft(data: { sessionId: string; viewerId: string }): void {
        const session = this.activeSessions.get(data.sessionId);
        if (session) {
            session.sharedSecrets.delete(data.viewerId);
            console.log(chalk.dim(`Viewer left session ${data.sessionId}: ${data.viewerId.substring(0, 8)}...`));
        }
    }

    /**
     * 处理加密输入
     */
    private handleEncryptedInput(data: {
        sessionId: string;
        viewerId: string;
        encrypted: EncryptedMessage;
    }): void {
        const session = this.activeSessions.get(data.sessionId);
        if (!session) {
            console.warn(`Input for unknown session: ${data.sessionId}`);
            return;
        }

        const sharedSecret = session.sharedSecrets.get(data.viewerId);
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
            const input = JSON.parse(decrypted) as { keys: string; type: 'text' | 'special' };
            console.log(chalk.dim(`← Input [${data.sessionId}]: ${input.type}:${input.keys}`));

            if (input.type === 'special') {
                session.capture.sendSpecialKey(input.keys);
            } else {
                session.capture.sendKeys(input.keys);
            }
        } catch {
            console.warn('Failed to parse decrypted input');
        }
    }

    /**
     * 广播输出到所有 viewer
     */
    private broadcastOutput(sessionName: string, event: OutputEvent): void {
        const session = this.activeSessions.get(sessionName);
        if (!session || !this.socket?.connected) return;

        const viewerCount = session.sharedSecrets.size;
        if (viewerCount > 0) {
            console.log(chalk.dim(`→ Output [${sessionName}] seq=${event.seq} → ${viewerCount} viewer(s)`));
        }

        for (const [viewerId, sharedSecret] of session.sharedSecrets) {
            const encrypted = encrypt(JSON.stringify(event), sharedSecret);
            this.socket.emit('encrypted-output', {
                sessionId: sessionName,
                viewerId,
                encrypted,
                seq: event.seq,
                timestamp: event.timestamp,
            });
        }
    }

    /**
     * 断开连接并清理
     */
    disconnect(): void {
        // 停止所有捕获
        for (const [name, session] of this.activeSessions) {
            session.capture.stop();
            console.log(chalk.dim(`Stopped capturing: ${name}`));
        }
        this.activeSessions.clear();

        this.socket?.disconnect();
        this.socket = null;
    }

    /**
     * 检查是否已连接
     */
    isConnected(): boolean {
        return this.socket?.connected ?? false;
    }

    /**
     * 获取活跃 session 数量
     */
    getActiveSessionCount(): number {
        return this.activeSessions.size;
    }
}
