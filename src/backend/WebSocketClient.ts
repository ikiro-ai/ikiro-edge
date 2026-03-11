import WebSocket from 'ws';
import { ILogger } from '../interfaces/ILogger';
import { EdgeCommandWrapper } from '../interfaces/ICommands';

/**
 * WebSocket client for real-time communication with backend
 * Handles connection, reconnection, and message parsing
 */
export class WebSocketClient {
  private ws: WebSocket | null = null;
  private logger: ILogger;
  private backendUrl: string;
  private edgeAgentId: string | null = null;
  private secret: string;
  private reconnectAttempts = 0;
  private reconnectDelay = 1000; // Start with 1 second
  private maxReconnectDelay = 60000; // Max 60 seconds
  private isConnecting = false;
  private shouldReconnect = true;
  private isClosingForReconnect = false; // Flag to prevent reconnect loop during cleanup
  private pingInterval: NodeJS.Timeout | null = null;
  private pongTimeout: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastPongReceived: number = Date.now();
  private static readonly PONG_TIMEOUT_MS = 10000; // 10s to receive pong before declaring dead
  private onCommandCallback: ((command: EdgeCommandWrapper) => Promise<void>) | null = null;
  private onConnectedCallback: (() => void) | null = null;
  private onDisconnectedCallback: (() => void) | null = null;
  private onConfigUpdateCallback: ((config: Record<string, any>) => void) | null = null;

  constructor(
    backendUrl: string,
    secret: string,
    logger: ILogger
  ) {
    // Convert HTTP(S) URL to WS(S) URL
    this.backendUrl = backendUrl
      .replace('https://', 'wss://')
      .replace('http://', 'ws://');
    this.secret = secret;
    this.logger = logger;
  }

  /**
   * Set the edge agent ID (after registration)
   */
  setEdgeAgentId(edgeAgentId: string): void {
    this.edgeAgentId = edgeAgentId;
  }

  /**
   * Register callback for incoming commands
   */
  onCommand(callback: (command: EdgeCommandWrapper) => Promise<void>): void {
    this.onCommandCallback = callback;
  }

  /**
   * Register callback for connection established
   */
  onConnected(callback: () => void): void {
    this.onConnectedCallback = callback;
  }

  /**
   * Register callback for connection lost
   */
  onDisconnected(callback: () => void): void {
    this.onDisconnectedCallback = callback;
  }

  /**
   * Register callback for config updates from backend
   */
  onConfigUpdate(callback: (config: Record<string, any>) => void): void {
    this.onConfigUpdateCallback = callback;
  }

  /**
   * Connect to WebSocket server
   */
  async connect(): Promise<boolean> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      this.logger.debug('WebSocket already connecting or connected');
      return true;
    }

    if (!this.edgeAgentId) {
      this.logger.error('Cannot connect WebSocket: no edge agent ID set');
      return false;
    }

    // Clean up any existing WebSocket before creating a new one
    if (this.ws) {
      this.isClosingForReconnect = true; // Prevent handleClose from scheduling reconnect
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
      this.isClosingForReconnect = false;
    }

    this.isConnecting = true;
    const wsUrl = `${this.backendUrl}/edge/ws?edge_agent_id=${this.edgeAgentId}`;

    try {
      this.logger.info(`Connecting to WebSocket: ${wsUrl}`);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.secret}`,
          'X-Edge-Agent-Id': this.edgeAgentId
        }
      });

      // Set up event handlers
      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('error', (error) => this.handleError(error));
      this.ws.on('close', (code, reason) => this.handleClose(code, reason));

      // Wait for connection to open
      return await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          this.logger.error('WebSocket connection timeout');
          this.isConnecting = false;
          // Clean up the timed-out socket to prevent ghost connections
          if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
          }
          resolve(false);
        }, 10000);

        this.ws!.once('open', () => {
          clearTimeout(timeout);
          this.isConnecting = false;
          resolve(true);
        });

        this.ws!.once('error', () => {
          clearTimeout(timeout);
          this.isConnecting = false;
          resolve(false);
        });
      });
    } catch (error: any) {
      this.logger.error('Failed to create WebSocket connection:', error.message);
      this.isConnecting = false;
      return false;
    }
  }

  /**
   * Handle WebSocket open event
   */
  private handleOpen(): void {
    this.logger.info('✅ WebSocket connected');
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;
    this.lastPongReceived = Date.now();

    // Start ping/pong for keepalive
    this.startPingInterval();

    // Notify callback
    if (this.onConnectedCallback) {
      this.onConnectedCallback();
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private async handleMessage(data: WebSocket.Data): Promise<void> {
    try {
      const message = JSON.parse(data.toString());
      this.logger.debug('Received WebSocket message:', message);

      // Handle different message types
      switch (message.type) {
        case 'command':
          await this.handleCommandMessage(message.data);
          break;

        case 'pong':
          this.lastPongReceived = Date.now();
          if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
          }
          this.logger.debug('Received pong from server');
          break;

        case 'config_update':
          this.logger.info('Received config update:', message.data);
          if (this.onConfigUpdateCallback) {
            this.onConfigUpdateCallback(message.data);
          }
          break;

        default:
          this.logger.warn('Unknown message type:', message.type);
      }
    } catch (error: any) {
      this.logger.error('Error handling WebSocket message:', error.message);
    }
  }

  /**
   * Handle command message from backend
   */
  private async handleCommandMessage(command: EdgeCommandWrapper): Promise<void> {
    this.logger.info('='.repeat(60));
    this.logger.info(`📥 WEBSOCKET COMMAND RECEIVED`);
    this.logger.info(`   Command ID: ${command.command_id}`);
    this.logger.info(`   Command Type: ${command.command_type}`);
    if (command.priority) {
      this.logger.info(`   Priority: ${command.priority}`);
    }
    if (command.timestamp) {
      this.logger.info(`   Timestamp: ${command.timestamp}`);
    }
    this.logger.info(`   Payload: ${JSON.stringify(command.payload, null, 2)}`);
    this.logger.info('='.repeat(60));

    if (this.onCommandCallback) {
      try {
        await this.onCommandCallback(command);
      } catch (error: any) {
        this.logger.error('Error executing command callback:', error.message);
      }
    } else {
      this.logger.warn('No command callback registered');
    }
  }

  /**
   * Handle WebSocket error
   */
  private handleError(error: Error): void {
    this.logger.error('WebSocket error:', error.message);
  }

  /**
   * Handle WebSocket close event
   */
  private handleClose(code: number, reason: Buffer): void {
    const reasonStr = reason.toString() || 'Unknown';
    this.logger.warn(`WebSocket closed: code=${code}, reason=${reasonStr}`);

    this.stopPingInterval();

    // Notify callback
    if (this.onDisconnectedCallback) {
      this.onDisconnectedCallback();
    }

    // Don't reconnect if we're closing for cleanup (about to create new connection)
    if (this.isClosingForReconnect) {
      this.logger.debug('Skipping reconnect - closing for cleanup');
      return;
    }

    // Attempt reconnection if enabled (will retry indefinitely)
    if (this.shouldReconnect) {
      // Use immediate reconnect for server-initiated restarts (code 1012)
      // to minimize downtime during backend deploys
      if (code === 1012) {
        this.logger.info('Server restart detected (1012) - reconnecting immediately');
        this.reconnectAttempts = 0;
        this.connect();
      } else {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff + jitter
   */
  private scheduleReconnect(): void {
    // Clear any existing reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectAttempts++;
    const baseDelay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
    // Add random jitter (0-25% of base delay) to prevent thundering herd
    const jitter = Math.floor(Math.random() * baseDelay * 0.25);
    const delay = baseDelay + jitter;

    this.logger.info(`Scheduling WebSocket reconnect attempt #${this.reconnectAttempts} in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.logger.info(`Attempting WebSocket reconnect (attempt #${this.reconnectAttempts})`);
      this.connect();
    }, delay);
  }

  /**
   * Start ping interval to keep connection alive.
   * Each ping sets a pong timeout - if no pong arrives within PONG_TIMEOUT_MS,
   * the connection is considered dead and forcefully closed to trigger reconnect.
   */
  private startPingInterval(): void {
    this.stopPingInterval(); // Ensure no duplicate intervals

    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.logger.debug('Sending ping to server');
        this.send({ type: 'ping' });

        // Set a pong timeout - if server doesn't respond, force-close
        if (this.pongTimeout) {
          clearTimeout(this.pongTimeout);
        }
        this.pongTimeout = setTimeout(() => {
          const staleness = Date.now() - this.lastPongReceived;
          this.logger.warn(`Pong timeout: no response in ${WebSocketClient.PONG_TIMEOUT_MS}ms (last pong ${staleness}ms ago)`);
          // Force-close the zombie connection to trigger reconnect
          if (this.ws) {
            this.logger.warn('Force-closing zombie WebSocket connection');
            this.ws.terminate();
          }
        }, WebSocketClient.PONG_TIMEOUT_MS);
      }
    }, 30000); // Ping every 30 seconds
  }

  /**
   * Stop ping interval and pong timeout
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  /**
   * Send a message through WebSocket
   */
  send(message: any): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('Cannot send message: WebSocket not connected');
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (error: any) {
      this.logger.error('Error sending WebSocket message:', error.message);
      return false;
    }
  }

  /**
   * Send command acknowledgment to backend
   * Protocol: {"type": "command_ack", "data": {"command_id": "...", "status": "completed|failed|received|executing", "completed_at": "...", "error": "..."}}
   */
  sendCommandAck(
    commandId: string,
    status: 'completed' | 'failed' | 'received' | 'executing',
    options?: { error?: string; completedAt?: Date }
  ): boolean {
    const completedAt = options?.completedAt ?? (status === 'completed' ? new Date() : undefined);

    this.logger.info('-'.repeat(60));
    this.logger.info(`📤 SENDING COMMAND ACK via WebSocket`);
    this.logger.info(`   Command ID: ${commandId}`);
    this.logger.info(`   Status: ${status}`);
    if (completedAt) {
      this.logger.info(`   Completed At: ${completedAt.toISOString()}`);
    }
    if (options?.error) {
      this.logger.info(`   Error: ${options.error}`);
    }
    this.logger.info('-'.repeat(60));

    return this.send({
      type: 'command_ack',
      data: {
        command_id: commandId,
        status,
        completed_at: completedAt?.toISOString(),
        error: options?.error
      }
    });
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Disconnect WebSocket
   */
  disconnect(): void {
    this.logger.info('Disconnecting WebSocket...');
    this.shouldReconnect = false;
    this.stopPingInterval();

    // Clear pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Get connection status
   */
  getStatus(): {
    connected: boolean;
    reconnectAttempts: number;
    state: string;
    lastPongAge: number;
  } {
    return {
      connected: this.isConnected(),
      reconnectAttempts: this.reconnectAttempts,
      state: this.ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][this.ws.readyState] : 'DISCONNECTED',
      lastPongAge: Date.now() - this.lastPongReceived
    };
  }
}
