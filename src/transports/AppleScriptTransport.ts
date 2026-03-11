import { IMessageTransport, IncomingMessage } from '../interfaces/IMessageTransport';
import { MessagesDB } from './MessagesDB';
import { AppleScriptSender } from './AppleScriptSender';
import { ILogger } from '../interfaces/ILogger';

/**
 * AppleScriptTransport - Combined transport using Messages DB for monitoring
 * and AppleScript for sending. This is the Node.js implementation.
 *
 * Future: Can be replaced with Swift implementation using private APIs
 */
export class AppleScriptTransport implements IMessageTransport {
  private messagesDB: MessagesDB;
  private sender: AppleScriptSender;
  private logger: ILogger;
  private pollInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(
    dbPath: string,
    attachmentsDir: string,
    logger: ILogger
  ) {
    this.logger = logger;
    this.messagesDB = new MessagesDB(dbPath, attachmentsDir, logger);
    this.sender = new AppleScriptSender(logger);
  }

  /**
   * Start monitoring for new messages
   */
  async start(): Promise<void> {
    this.logger.info('Starting AppleScript transport...');

    // Test connection to Messages.app
    const connected = await this.sender.testConnection();
    if (!connected) {
      throw new Error('Cannot connect to Messages.app. Make sure it is running and accessible.');
    }

    this.isRunning = true;
    this.logger.info('✅ AppleScript transport started');
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    this.logger.info('Stopping AppleScript transport...');

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.messagesDB.close();
    this.isRunning = false;

    this.logger.info('✅ AppleScript transport stopped');
  }

  /**
   * Poll for new messages since last check
   */
  async pollNewMessages(): Promise<IncomingMessage[]> {
    if (!this.isRunning) {
      return [];
    }

    return this.messagesDB.pollNewMessages();
  }

  /**
   * Send a message to a thread
   */
  async sendMessage(threadId: string, text: string, isGroup: boolean): Promise<boolean> {
    if (!this.isRunning) {
      this.logger.warn('Transport not running, cannot send message');
      return false;
    }

    return this.sender.sendMessage(threadId, text, isGroup);
  }

  /**
   * Send multiple message bubbles with natural timing
   * @param batched - If true, sends all bubbles in single AppleScript (5× faster)
   */
  async sendMultiBubble(threadId: string, bubbles: string[], isGroup: boolean, batched: boolean = true): Promise<boolean> {
    if (!this.isRunning) {
      this.logger.warn('Transport not running, cannot send multi-bubble');
      return false;
    }

    return this.sender.sendMultiBubble(threadId, bubbles, isGroup, batched);
  }

  /**
   * Get transport name for logging
   */
  async setTypingIndicator(_threadId: string, _isTyping: boolean): Promise<boolean> {
    return false; // Not supported without typing-helper daemon
  }

  getName(): string {
    return 'AppleScriptTransport';
  }
}
