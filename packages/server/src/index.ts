import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Server as SocketIO } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT ?? '3010', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

// Control lock timeout (ms) - auto-release if no input for this duration
const CONTROL_LOCK_TIMEOUT = 30000;

interface OutputEvent {
  type: 'output';
  seq: number;
  content: string;
  timestamp: number;
}

interface EncryptedMessage {
  nonce: string;
  ciphertext: string;
}

interface EncryptedOutputEvent {
  viewerId: string;
  encrypted: EncryptedMessage;
  seq: number;
  timestamp: number;
}

interface Viewer {
  socketId: string;
  publicKey: string;
  nickname?: string;
}

interface ControlLock {
  holderId: string;
  holderNickname?: string;
  acquiredAt: number;
  lastInputAt: number;
}

interface Session {
  id: string;
  userId: string | null; // User who owns this session
  cliSocketId: string | null;
  cliPublicKey: string | null;
  daemonSocketId: string | null; // 关联的 daemon 连接
  viewers: Map<string, Viewer>;
  lastOutput: OutputEvent | null;
  outputHistory: OutputEvent[];
  encryptedHistory: EncryptedOutputEvent[];
  encrypted: boolean;
  controlLock: ControlLock | null;
  createdAt: number;
}

// CLI Daemon 信息
interface CLIDaemon {
  socketId: string;
  userId: string | null;
  activeSessions: Set<string>; // daemon 管理的 session IDs
  connectedAt: number;
}

// Session storage (in-memory for MVP)
const sessions = new Map<string, Session>();

// CLI Daemon storage
const cliDaemons = new Map<string, CLIDaemon>(); // socketId -> daemon info

// User to sessions mapping
const userSessions = new Map<string, Set<string>>();

// Pending commands (commandId -> { resolve, reject, timeout })
const pendingCommands = new Map<string, {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

// Helper function to derive userId from user secret
function deriveUserId(userSecret: string): string {
  return createHash('sha256').update(userSecret).digest('hex');
}

function broadcastControlStatus(io: SocketIO, sessionId: string, session: Session): void {
  const status = session.controlLock
    ? {
      locked: true,
      holderId: session.controlLock.holderId,
      holderNickname: session.controlLock.holderNickname,
      acquiredAt: session.controlLock.acquiredAt,
    }
    : { locked: false };

  io.to(`session:${sessionId}`).emit('control-status', status);
}

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  const webClientPath = join(__dirname, '../../web-client/dist');
  if (existsSync(webClientPath)) {
    await app.register(fastifyStatic, {
      root: webClientPath,
      prefix: '/',
    });
  } else {
    console.log('Web client static files not found, serving API only');
  }

  const io = new SocketIO(app.server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    pingTimeout: 45000,
    pingInterval: 15000,
  });

  // API Routes
  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  app.get('/api/sessions', async () => {
    return {
      sessions: Array.from(sessions.entries()).map(([id, session]) => ({
        id,
        hasCliConnected: !!session.cliSocketId || !!session.daemonSocketId,
        viewerCount: session.viewers.size,
        lastOutputSeq: session.lastOutput?.seq ?? 0,
        encrypted: session.encrypted,
        controlLocked: !!session.controlLock,
        controlHolder: session.controlLock?.holderNickname ?? null,
        isDaemonManaged: !!session.daemonSocketId,
      })),
      daemons: Array.from(cliDaemons.values()).map(daemon => ({
        socketId: daemon.socketId,
        activeSessions: Array.from(daemon.activeSessions),
        connectedAt: daemon.connectedAt,
      })),
    };
  });

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params;
    const session = sessions.get(sessionId);
    if (!session) {
      return { error: 'Session not found' };
    }
    return {
      id: session.id,
      hasCliConnected: !!session.cliSocketId,
      cliPublicKey: session.cliPublicKey,
      encrypted: session.encrypted,
      controlLock: session.controlLock
        ? {
          holderId: session.controlLock.holderId,
          holderNickname: session.controlLock.holderNickname,
          acquiredAt: session.controlLock.acquiredAt,
        }
        : null,
    };
  });

  // Get user's sessions by userSecret
  app.post('/api/user/sessions', async (request) => {
    const { userSecret } = request.body as { userSecret?: string };

    if (!userSecret) {
      return { error: 'userSecret is required' };
    }

    const userId = deriveUserId(userSecret);
    const sessionIds = userSessions.get(userId) || new Set();

    const userSessionsList = Array.from(sessionIds)
      .map(id => sessions.get(id))
      .filter((session): session is Session => !!session)
      .map(session => ({
        id: session.id,
        hasCliConnected: !!session.cliSocketId,
        viewerCount: session.viewers.size,
        lastOutputSeq: session.lastOutput?.seq ?? 0,
        encrypted: session.encrypted,
        controlLocked: !!session.controlLock,
        controlHolder: session.controlLock?.holderNickname ?? null,
        createdAt: session.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt); // 最新的在前

    return {
      userId,
      sessions: userSessionsList,
    };
  });

  // Send command to CLI daemon (via first connected daemon)
  app.post('/api/daemon/command', async (request) => {
    const { command, params } = request.body as { command: string; params?: Record<string, string> };

    if (!command) {
      return { error: 'command is required' };
    }

    // 找到第一个连接的 daemon
    const daemon = cliDaemons.values().next().value as CLIDaemon | undefined;
    if (!daemon) {
      return { error: 'No CLI daemon connected' };
    }

    const commandId = `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // 通过 WebSocket 发送命令给 daemon
    const daemonSocket = io.sockets.sockets.get(daemon.socketId);
    if (!daemonSocket) {
      return { error: 'Daemon socket not found' };
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingCommands.delete(commandId);
        resolve({ error: 'Command timeout' });
      }, 10000);

      pendingCommands.set(commandId, {
        resolve: (data) => resolve({ success: true, data }),
        reject: (error) => resolve({ error: error.message }),
        timeout,
      });

      daemonSocket.emit('cli-command', { commandId, command, params });
    });
  });

  // Socket.IO connection handling
  io.on('connection', (socket) => {
    const sessionId = socket.handshake.query.sessionId as string | undefined;
    const clientType = socket.handshake.query.clientType as 'cli' | 'cli-daemon' | 'viewer';
    const publicKey = socket.handshake.query.publicKey as string | undefined;
    const nickname = socket.handshake.query.nickname as string | undefined;
    const userSecret = socket.handshake.query.userSecret as string | undefined;

    // ==================== CLI Daemon 模式 ====================
    if (clientType === 'cli-daemon') {
      const userId = userSecret ? deriveUserId(userSecret) : null;

      const daemon: CLIDaemon = {
        socketId: socket.id,
        userId,
        activeSessions: new Set(),
        connectedAt: Date.now(),
      };
      cliDaemons.set(socket.id, daemon);

      console.log(`CLI Daemon connected: ${socket.id}`);

      // 处理来自 web 的命令请求
      socket.on('cli-command', (msg: { commandId: string; command: string; params?: Record<string, string> }) => {
        console.log(`Command received: ${msg.command} (${msg.commandId})`);
        // 直接转发给 daemon（这里假设只有一个 daemon，实际应用可能需要路由逻辑）
        socket.emit('cli-command', msg);
      });

      // 处理 daemon 的命令响应
      socket.on('cli-response', (response: { commandId: string; success: boolean; data?: unknown; error?: string }) => {
        console.log(`Command response: ${response.commandId} success=${response.success}`);
        const pending = pendingCommands.get(response.commandId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingCommands.delete(response.commandId);
          if (response.success) {
            pending.resolve(response.data);
          } else {
            pending.reject(new Error(response.error ?? 'Command failed'));
          }
        }
        // 同时广播给所有 viewer
        io.emit('cli-response', response);
      });

      // 处理 daemon 报告 session attached
      socket.on('session-attached', (data: { sessionId: string; publicKey: string; encrypted: boolean }) => {
        console.log(`Daemon attached session: ${data.sessionId}`);
        daemon.activeSessions.add(data.sessionId);

        // 创建或更新 session
        let session = sessions.get(data.sessionId);
        if (!session) {
          session = {
            id: data.sessionId,
            userId,
            cliSocketId: null,
            cliPublicKey: data.publicKey,
            daemonSocketId: socket.id,
            viewers: new Map(),
            lastOutput: null,
            outputHistory: [],
            encryptedHistory: [],
            encrypted: data.encrypted,
            controlLock: null,
            createdAt: Date.now(),
          };
          sessions.set(data.sessionId, session);
        } else {
          session.daemonSocketId = socket.id;
          session.cliPublicKey = data.publicKey;
          session.encrypted = data.encrypted;
        }

        // 通知 viewers
        io.to(`session:${data.sessionId}`).emit('cli-status', {
          connected: true,
          publicKey: data.publicKey,
          encrypted: data.encrypted,
        });

        // 添加到用户的 session 列表
        if (userId) {
          if (!userSessions.has(userId)) {
            userSessions.set(userId, new Set());
          }
          userSessions.get(userId)!.add(data.sessionId);
        }
      });

      // 处理 daemon 报告 session detached
      socket.on('session-detached', (data: { sessionId: string }) => {
        console.log(`Daemon detached session: ${data.sessionId}`);
        daemon.activeSessions.delete(data.sessionId);

        const session = sessions.get(data.sessionId);
        if (session && session.daemonSocketId === socket.id) {
          session.daemonSocketId = null;
          session.cliPublicKey = null;

          io.to(`session:${data.sessionId}`).emit('cli-status', {
            connected: false,
            publicKey: null,
            encrypted: session.encrypted,
          });
        }
      });

      // 处理 daemon 发送的加密输出
      socket.on('encrypted-output', (data: { sessionId: string; viewerId: string; encrypted: EncryptedMessage; seq: number; timestamp: number }) => {
        io.to(data.viewerId).emit('encrypted-output', {
          encrypted: data.encrypted,
          seq: data.seq,
          timestamp: data.timestamp,
        });
      });

      // 处理 daemon 发送的活跃 sessions 列表
      socket.on('active-sessions', (data: { sessions: Array<{ sessionId: string; publicKey: string; encrypted: boolean; viewerCount: number }> }) => {
        console.log(`Daemon reported ${data.sessions.length} active session(s)`);
        // 可以用于重新同步状态
      });

      // Daemon 断开连接
      socket.on('disconnect', () => {
        console.log(`CLI Daemon disconnected: ${socket.id}`);

        // 清理所有该 daemon 管理的 sessions
        for (const sessionId of daemon.activeSessions) {
          const session = sessions.get(sessionId);
          if (session && session.daemonSocketId === socket.id) {
            session.daemonSocketId = null;
            session.cliPublicKey = null;
            io.to(`session:${sessionId}`).emit('cli-status', {
              connected: false,
              publicKey: null,
              encrypted: session.encrypted,
            });
          }
        }

        cliDaemons.delete(socket.id);
      });

      return; // daemon 处理完毕，不继续执行下面的普通逻辑
    }

    // ==================== 普通 CLI / Viewer 模式 ====================
    if (!sessionId) {
      console.log('Connection rejected: no sessionId');
      socket.disconnect(true);
      return;
    }

    console.log(`Client connected: ${clientType} (${socket.id}) for session: ${sessionId}`);

    // Derive userId if userSecret provided
    const userId = userSecret ? deriveUserId(userSecret) : null;

    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        userId: clientType === 'cli' ? userId : null, // Only CLI can own sessions
        cliSocketId: null,
        cliPublicKey: null,
        daemonSocketId: null,
        viewers: new Map(),
        lastOutput: null,
        outputHistory: [],
        encryptedHistory: [],
        encrypted: false,
        controlLock: null,
        createdAt: Date.now(),
      };
      sessions.set(sessionId, session);

      // Add to user's session list
      if (clientType === 'cli' && userId) {
        if (!userSessions.has(userId)) {
          userSessions.set(userId, new Set());
        }
        userSessions.get(userId)!.add(sessionId);
      }
    }

    socket.join(`session:${sessionId}`);

    if (clientType === 'cli') {
      if (session.cliSocketId) {
        console.log(`Replacing existing CLI connection for session: ${sessionId}`);
      }
      session.cliSocketId = socket.id;
      session.cliPublicKey = publicKey ?? null;
      session.encrypted = !!publicKey;

      io.to(`session:${sessionId}`).emit('cli-status', {
        connected: true,
        publicKey: session.cliPublicKey,
        encrypted: session.encrypted,
      });
    } else {
      const viewer: Viewer = {
        socketId: socket.id,
        publicKey: publicKey ?? '',
        nickname: nickname,
      };
      session.viewers.set(socket.id, viewer);

      if (session.encrypted && session.cliSocketId && publicKey) {
        io.to(session.cliSocketId).emit('viewer-joined', {
          viewerId: socket.id,
          publicKey: publicKey,
        });
      }

      if (!session.encrypted && session.lastOutput) {
        socket.emit('output', session.lastOutput);
      }

      socket.emit('cli-status', {
        connected: !!session.cliSocketId,
        publicKey: session.cliPublicKey,
        encrypted: session.encrypted,
      });

      // Send current control status to new viewer
      broadcastControlStatus(io, sessionId, session);
    }

    // Handle control lock request
    socket.on('request-control', () => {
      if (clientType === 'cli') return;

      const viewer = session!.viewers.get(socket.id);
      if (!viewer) return;

      // Check if lock is available or expired
      const now = Date.now();
      if (session!.controlLock) {
        const timeSinceLastInput = now - session!.controlLock.lastInputAt;
        if (timeSinceLastInput < CONTROL_LOCK_TIMEOUT && session!.controlLock.holderId !== socket.id) {
          // Lock is held by someone else and not expired
          socket.emit('control-denied', {
            reason: 'locked',
            holderId: session!.controlLock.holderId,
            holderNickname: session!.controlLock.holderNickname,
          });
          return;
        }
      }

      // Grant control
      session!.controlLock = {
        holderId: socket.id,
        holderNickname: viewer.nickname,
        acquiredAt: now,
        lastInputAt: now,
      };

      console.log(`Control granted to ${socket.id} (${viewer.nickname ?? 'anonymous'})`);
      broadcastControlStatus(io, sessionId, session!);
    });

    // Handle control release
    socket.on('release-control', () => {
      if (clientType === 'cli') return;

      if (session!.controlLock?.holderId === socket.id) {
        session!.controlLock = null;
        console.log(`Control released by ${socket.id}`);
        broadcastControlStatus(io, sessionId, session!);
      }
    });

    // Handle unencrypted output from CLI
    socket.on('output', (event: OutputEvent) => {
      if (clientType !== 'cli') return;

      session!.lastOutput = event;
      session!.outputHistory.push(event);
      if (session!.outputHistory.length > 100) {
        session!.outputHistory.shift();
      }

      socket.to(`session:${sessionId}`).emit('output', event);
    });

    // Handle encrypted output from CLI
    socket.on('encrypted-output', (data: EncryptedOutputEvent) => {
      if (clientType !== 'cli') return;

      io.to(data.viewerId).emit('encrypted-output', {
        encrypted: data.encrypted,
        seq: data.seq,
        timestamp: data.timestamp,
      });
    });

    // Handle encrypted output for history
    socket.on('output-history', (data: { encrypted: EncryptedMessage; seq: number; timestamp: number }) => {
      if (clientType !== 'cli') return;

      session!.encryptedHistory.push({
        viewerId: '',
        encrypted: data.encrypted,
        seq: data.seq,
        timestamp: data.timestamp,
      });
      if (session!.encryptedHistory.length > 100) {
        session!.encryptedHistory.shift();
      }
    });

    // Handle unencrypted input from viewers
    socket.on('input', (data: { keys: string; type: 'text' | 'special' }) => {
      if (clientType === 'cli') return;

      // Check control lock
      if (session!.controlLock && session!.controlLock.holderId !== socket.id) {
        const timeSinceLastInput = Date.now() - session!.controlLock.lastInputAt;
        if (timeSinceLastInput < CONTROL_LOCK_TIMEOUT) {
          socket.emit('input-rejected', { reason: 'not-controller' });
          return;
        }
        // Lock expired, clear it
        session!.controlLock = null;
        broadcastControlStatus(io, sessionId, session!);
      }

      // Update last input time if this viewer has control
      if (session!.controlLock?.holderId === socket.id) {
        session!.controlLock.lastInputAt = Date.now();
      }

      if (session!.cliSocketId) {
        io.to(session!.cliSocketId).emit('input', data);
      } else {
        socket.emit('error', { message: 'CLI not connected' });
      }
    });

    // Handle encrypted input from viewers
    socket.on('encrypted-input', (data: { encrypted: EncryptedMessage }) => {
      if (clientType === 'cli') return;

      // Check control lock
      if (session!.controlLock && session!.controlLock.holderId !== socket.id) {
        const timeSinceLastInput = Date.now() - session!.controlLock.lastInputAt;
        if (timeSinceLastInput < CONTROL_LOCK_TIMEOUT) {
          socket.emit('input-rejected', { reason: 'not-controller' });
          return;
        }
        session!.controlLock = null;
        broadcastControlStatus(io, sessionId, session!);
      }

      if (session!.controlLock?.holderId === socket.id) {
        session!.controlLock.lastInputAt = Date.now();
      }

      if (session!.cliSocketId) {
        io.to(session!.cliSocketId).emit('encrypted-input', {
          viewerId: socket.id,
          encrypted: data.encrypted,
        });
      } else {
        socket.emit('error', { message: 'CLI not connected' });
      }
    });

    // Handle get-history request
    socket.on('get-history', () => {
      if (session!.encrypted) {
        socket.emit('encrypted-history', session!.encryptedHistory);
      } else {
        socket.emit('history', session!.outputHistory);
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${clientType} (${socket.id})`);

      if (clientType === 'cli' && session!.cliSocketId === socket.id) {
        session!.cliSocketId = null;
        session!.cliPublicKey = null;
        io.to(`session:${sessionId}`).emit('cli-status', {
          connected: false,
          publicKey: null,
          encrypted: session!.encrypted,
        });
      } else {
        // Release control if this viewer held it
        if (session!.controlLock?.holderId === socket.id) {
          session!.controlLock = null;
          broadcastControlStatus(io, sessionId, session!);
        }

        if (session!.cliSocketId) {
          io.to(session!.cliSocketId).emit('viewer-left', {
            viewerId: socket.id,
          });
        }
        session!.viewers.delete(socket.id);
      }

      setTimeout(() => {
        const s = sessions.get(sessionId);
        if (s && !s.cliSocketId && s.viewers.size === 0) {
          sessions.delete(sessionId);
          console.log(`Cleaned up empty session: ${sessionId}`);
        }
      }, 60000);
    });
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`\n🚀 sohappy server running at http://${HOST}:${PORT}`);
    console.log(`   WebSocket ready for connections\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main().catch(console.error);
