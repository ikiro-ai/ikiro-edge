import { IMessageTransport, IncomingMessage, MessageAttachment } from '../interfaces/IMessageTransport';
import { AppleScriptSender } from './AppleScriptSender';
import { TypingIndicatorClient } from './TypingIndicatorClient';
import { ILogger } from '../interfaces/ILogger';
import { NativeBridgeClient, BridgeMessagePayload, BridgeAttachmentPayload } from './NativeBridgeClient';

interface NativeBridgeTransportOptions {
  executable: string;
  args: string[];
  attachmentsPath: string;
  dbPath: string;
  stateFilePath?: string;
  maxMessageAgeSeconds?: number;
  typingSocketPath?: string;
}

export class NativeBridgeTransport implements IMessageTransport {
  private readonly sender: AppleScriptSender;
  private readonly bridge: NativeBridgeClient;
  private readonly typingClient: TypingIndicatorClient;
  private readonly queue: IncomingMessage[] = [];
  private running = false;

  constructor(
    private readonly options: NativeBridgeTransportOptions,
    private readonly logger: ILogger
  ) {
    this.sender = new AppleScriptSender(logger);
    this.typingClient = new TypingIndicatorClient(
      options.typingSocketPath || '/tmp/typing-helper.sock',
      logger
    );
    const bridgeArgs = [
      '--db-path',
      options.dbPath,
      '--attachments-path',
      options.attachmentsPath,
      '--poll-interval-ms',
      '500'
    ];

    if (options.stateFilePath) {
      bridgeArgs.push('--state-file', options.stateFilePath);
    }

    if (options.maxMessageAgeSeconds) {
      bridgeArgs.push('--max-message-age-seconds', String(options.maxMessageAgeSeconds));
    }

    this.bridge = new NativeBridgeClient(
      {
        executable: options.executable,
        args: bridgeArgs.concat(options.args || [])
      },
      logger
    );

    this.bridge.on('message', (payload) => this.handleBridgeMessage(payload));
    this.bridge.on('error', (payload) => {
      this.logger.error(`Native helper error: ${JSON.stringify(payload)}`);
    });
  }

  async start(): Promise<void> {
    const connected = await this.sender.testConnection();
    if (!connected) {
      throw new Error('Cannot connect to Messages.app via AppleScript');
    }

    await this.bridge.start();
    this.running = true;
    this.logger.info('Native bridge transport started');

    // Probe typing indicator daemon (optional — degrades gracefully)
    await this.typingClient.probe();
  }

  stop(): void {
    this.bridge.stop();
    this.running = false;
    this.sender.destroy();
  }

  async pollNewMessages(): Promise<IncomingMessage[]> {
    if (!this.running) {
      return [];
    }

    const messages = this.queue.splice(0, this.queue.length);
    return messages;
  }

  async sendMessage(threadId: string, text: string, isGroup: boolean): Promise<boolean> {
    if (!this.running) {
      this.logger.warn('Transport not running, cannot send message');
      return false;
    }

    return this.sender.sendMessage(threadId, text, isGroup);
  }

  async sendMultiBubble(
    threadId: string,
    bubbles: string[],
    isGroup: boolean,
    batched: boolean = true
  ): Promise<boolean> {
    if (!this.running) {
      this.logger.warn('Transport not running, cannot send multi-bubble');
      return false;
    }

    return this.sender.sendMultiBubble(threadId, bubbles, isGroup, batched);
  }

  async setTypingIndicator(threadId: string, isTyping: boolean): Promise<boolean> {
    return this.typingClient[isTyping ? 'startTyping' : 'stopTyping'](threadId);
  }

  getName(): string {
    return 'NativeBridgeTransport';
  }

  private handleBridgeMessage(payload: BridgeMessagePayload): void {
    const message: IncomingMessage = {
      threadId: payload.thread_id,
      sender: payload.sender,
      text: payload.text || '',
      timestamp: new Date(payload.timestamp),
      isGroup: payload.is_group,
      participants: payload.participants || [],
      attachments: (payload.attachments || []).map(this.mapAttachment)
    };

    this.queue.push(message);
  }

  private mapAttachment(attachment: BridgeAttachmentPayload): MessageAttachment {
    return {
      id: attachment.id,
      guid: attachment.guid,
      filename: attachment.filename,
      uti: attachment.uti,
      mimeType: attachment.mime_type,
      transferName: attachment.transfer_name,
      totalBytes: attachment.total_bytes,
      createdAt: attachment.created_at ? new Date(attachment.created_at) : undefined,
      relativePath: attachment.relative_path,
      absolutePath: attachment.absolute_path,
      isSticker: attachment.is_sticker,
      isOutgoing: attachment.is_outgoing
    };
  }
}

