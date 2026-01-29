import { spawn, execSync } from 'child_process';

export interface CaptureOptions {
  sessionName: string;
  windowId?: string;
  paneId?: string;
  pollIntervalMs?: number;
}

export interface OutputEvent {
  type: 'output';
  seq: number;
  content: string;
  timestamp: number;
}

export type OutputCallback = (event: OutputEvent) => void;

/**
 * Tmux output capture module
 * Captures terminal output from a tmux pane
 */
export class TmuxCapture {
  private sessionName: string;
  private windowId: string;
  private paneId: string;
  private pollIntervalMs: number;
  private running = false;
  private seq = 0;
  private lastContent = '';
  private intervalHandle: NodeJS.Timeout | null = null;
  private callback: OutputCallback | null = null;

  constructor(options: CaptureOptions) {
    this.sessionName = options.sessionName;
    this.windowId = options.windowId ?? '0';
    this.paneId = options.paneId ?? '0';
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  /**
   * Get the target pane identifier
   */
  private getTarget(): string {
    return `${this.sessionName}:${this.windowId}.${this.paneId}`;
  }

  /**
   * Check if tmux session exists
   */
  static sessionExists(sessionName: string): boolean {
    try {
      execSync(`tmux has-session -t ${sessionName} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all tmux sessions
   */
  static listSessions(): string[] {
    try {
      const output = execSync('tmux list-sessions -F "#{session_name}"', {
        encoding: 'utf8',
      });
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Create a new tmux session with a command
   */
  static createSession(sessionName: string, command?: string): void {
    const cmd = command
      ? `tmux new-session -d -s ${sessionName} "${command}"`
      : `tmux new-session -d -s ${sessionName}`;
    execSync(cmd);
  }

  /**
   * Capture current pane content
   */
  capturePane(): string {
    try {
      const output = execSync(
        `tmux capture-pane -t ${this.getTarget()} -p -e`,
        { encoding: 'utf8' }
      );
      return output;
    } catch (error) {
      console.error('Failed to capture pane:', error);
      return '';
    }
  }

  /**
   * Capture only visible content (last N lines)
   */
  capturePaneVisible(lines = 50): string {
    try {
      const output = execSync(
        `tmux capture-pane -t ${this.getTarget()} -p -e -S -${lines}`,
        { encoding: 'utf8' }
      );
      return output;
    } catch (error) {
      console.error('Failed to capture visible pane:', error);
      return '';
    }
  }

  /**
   * Start polling for output changes
   */
  start(callback: OutputCallback): void {
    if (this.running) {
      console.warn('Capture already running');
      return;
    }

    this.callback = callback;
    this.running = true;
    this.lastContent = this.capturePane();

    // Send initial content
    if (this.lastContent) {
      this.seq++;
      callback({
        type: 'output',
        seq: this.seq,
        content: this.lastContent,
        timestamp: Date.now(),
      });
    }

    this.intervalHandle = setInterval(() => {
      this.poll();
    }, this.pollIntervalMs);

    console.log(`Started capturing tmux pane: ${this.getTarget()}`);
  }

  /**
   * Poll for changes
   */
  private poll(): void {
    if (!this.running || !this.callback) return;

    const currentContent = this.capturePane();

    if (currentContent !== this.lastContent) {
      this.seq++;
      this.callback({
        type: 'output',
        seq: this.seq,
        content: currentContent,
        timestamp: Date.now(),
      });
      this.lastContent = currentContent;
    }
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.running = false;
    this.callback = null;
    console.log('Stopped capturing tmux pane');
  }

  /**
   * Send keys to the pane
   */
  sendKeys(keys: string): void {
    try {
      execSync(`tmux send-keys -t ${this.getTarget()} ${JSON.stringify(keys)}`);
    } catch (error) {
      console.error('Failed to send keys:', error);
    }
  }

  /**
   * Send special key (like Enter, C-c, etc.)
   */
  sendSpecialKey(key: string): void {
    try {
      execSync(`tmux send-keys -t ${this.getTarget()} ${key}`);
    } catch (error) {
      console.error('Failed to send special key:', error);
    }
  }

  /**
   * Get current sequence number
   */
  getSeq(): number {
    return this.seq;
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }
}
