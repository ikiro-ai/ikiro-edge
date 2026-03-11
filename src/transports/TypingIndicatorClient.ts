import * as net from 'net';
import { ILogger } from '../interfaces/ILogger';

/**
 * TypingIndicatorClient — Communicates with the typing-helper daemon
 * over a Unix socket to control iMessage typing indicators.
 *
 * Protocol: JSON lines over Unix socket (connect-per-request)
 *   Request:  {"action": "start_typing", "chat_guid": "iMessage;-;+15551234567"}
 *   Response: {"ok": true} | {"ok": false, "error": "..."}
 */
export class TypingIndicatorClient {
  private socketPath: string;
  private logger: ILogger;
  private available: boolean | null = null; // null = not yet checked

  constructor(socketPath: string, logger: ILogger) {
    this.socketPath = socketPath;
    this.logger = logger;
  }

  /**
   * Check if the typing-helper daemon is running
   */
  isAvailable(): boolean {
    return this.available === true;
  }

  /**
   * Probe the socket to see if the daemon is reachable
   */
  async probe(): Promise<boolean> {
    try {
      // Try a quick connect/disconnect to verify the socket exists and accepts connections
      await this.sendCommand({ action: 'stop_typing', chat_guid: 'probe' });
      // Even if the chat isn't found, the daemon responded — it's alive
      this.available = true;
      this.logger.info('✅ Typing indicator daemon is available');
      return true;
    } catch {
      this.available = false;
      this.logger.debug('Typing indicator daemon not available (this is optional)');
      return false;
    }
  }

  /**
   * Start showing typing indicator in a chat
   */
  async startTyping(chatGuid: string): Promise<boolean> {
    if (!this.available) return false;

    try {
      const result = await this.sendCommand({ action: 'start_typing', chat_guid: chatGuid });
      if (result.ok) {
        this.logger.debug(`✏️ Typing indicator ON for ${chatGuid}`);
      } else {
        this.logger.warn(`Failed to start typing for ${chatGuid}: ${result.error}`);
      }
      return result.ok;
    } catch (error: any) {
      this.logger.warn(`Typing indicator error: ${error.message}`);
      return false;
    }
  }

  /**
   * Stop showing typing indicator in a chat
   */
  async stopTyping(chatGuid: string): Promise<boolean> {
    if (!this.available) return false;

    try {
      const result = await this.sendCommand({ action: 'stop_typing', chat_guid: chatGuid });
      if (result.ok) {
        this.logger.debug(`✏️ Typing indicator OFF for ${chatGuid}`);
      }
      return result.ok;
    } catch (error: any) {
      this.logger.warn(`Typing indicator error: ${error.message}`);
      return false;
    }
  }

  /**
   * Send a command to the typing-helper daemon over Unix socket.
   * Uses connect-per-request pattern for simplicity and reliability.
   */
  private sendCommand(command: { action: string; chat_guid: string }): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Typing helper timeout'));
      }, 2000);

      const socket = net.createConnection({ path: this.socketPath }, () => {
        socket.write(JSON.stringify(command) + '\n');
      });

      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
      });

      socket.on('end', () => {
        clearTimeout(timeout);
        try {
          const result = JSON.parse(data.trim());
          resolve(result);
        } catch {
          reject(new Error(`Invalid response: ${data}`));
        }
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}
