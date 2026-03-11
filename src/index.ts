#!/usr/bin/env node
/**
 * Edge Agent - Mac Mini iMessage Relay
 * Phase 2: Transport + Scheduler (monitor, forward, respond, schedule)
 */

import { loadConfig, validateConfig } from './config';
import { Config } from './types/config.types';
import { IncomingMessage } from './types/message.types';
import { BackendMessageRequest } from './interfaces/IBackendClient';
import { Logger } from './utils/logger';
import { AppleScriptTransport } from './transports/AppleScriptTransport';
import { RailwayClient } from './backend/RailwayClient';
import { WebSocketClient } from './backend/WebSocketClient';
import { Scheduler } from './scheduler/Scheduler';
import { CommandHandler } from './commands/CommandHandler';
import { RuleEngine } from './rules/RuleEngine';
import { PlanManager } from './plans/PlanManager';
import { SentryMonitoring } from './monitoring/sentry';
import { PostHogAnalytics } from './monitoring/posthog';
import { HealthCheckServer } from './monitoring/health';
import { v4 as uuidv4 } from 'uuid';
import {
  EdgeEventWrapper,
  EdgeCommandWrapper,
  UploadRetryCommand,
  EmitEventCommand
} from './interfaces/ICommands';
import { ContextManager, MiniAppContext } from './context/ContextManager';
import { AttachmentCache } from './context/AttachmentCache';
import { AttachmentProcessor } from './attachments/AttachmentProcessor';
import { PhotoTranscoder } from './attachments/PhotoTranscoder';
import { BackendAttachmentSummary, BackendMiniAppContext } from './interfaces/IBackendClient';
import { KeychainManager } from './utils/keychain';
import { IMessageTransport, MessageAttachment } from './interfaces/IMessageTransport';
import { NativeBridgeTransport } from './transports/NativeBridgeTransport';
import { EmailSenderGate } from './validation/EmailSenderGate';

/**
 * Main application class
 */
class EdgeAgent {
  private config: Config;
  private logger: Logger;
  private sentry: SentryMonitoring;
  private posthog: PostHogAnalytics;
  private healthCheck: HealthCheckServer;
  private transport: IMessageTransport;
  private backend: RailwayClient;
  private wsClient: WebSocketClient;
  private scheduler: Scheduler;
  private ruleEngine: RuleEngine;
  private planManager: PlanManager;
  private commandHandler: CommandHandler;
  private contextManager: ContextManager;
  private attachmentCache: AttachmentCache;
  private attachmentProcessor: AttachmentProcessor;
  private photoTranscoder: PhotoTranscoder;
  private emailSenderGate: EmailSenderGate;
  private pollInterval: NodeJS.Timeout | null = null;
  private syncInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private startTime: Date = new Date();
  private pendingEvents: EdgeEventWrapper[] = [];
  private lastCommandId: string | null = null;
  private useWebSocket: boolean = true; // Enable WebSocket by default

  // iCloud sync watchdog: restart Messages.app if no new messages for too long
  private lastNewMessageTime: Date = new Date();
  private syncWatchdogInterval: NodeJS.Timeout | null = null;
  private static readonly SYNC_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
  private static readonly SYNC_WATCHDOG_CHECK_MS = 5 * 60 * 1000; // check every 5 minutes

  // MEMORY LEAK FIX: Track all timers for cleanup
  private activeTimers: Set<NodeJS.Timeout> = new Set();
  private activeIntervals: Set<NodeJS.Timeout> = new Set();

  constructor() {
    // Load configuration
    this.config = loadConfig();
    validateConfig(this.config);

    // Initialize logger
    this.logger = new Logger(
      this.config.logging.level,
      this.config.logging.file
    );

    // Initialize monitoring
    this.sentry = new SentryMonitoring(this.config, this.logger);
    this.posthog = new PostHogAnalytics(this.config, this.logger);
    this.healthCheck = new HealthCheckServer(this.config, this.logger);

    const attachmentsPath =
      this.config.imessage.attachments_path ||
      `${process.env.HOME}/Library/Messages/Attachments`;

    // Initialize transport
    this.transport = this.initializeTransport(attachmentsPath);

    // Initialize backend client and WebSocket (both use EDGE_SECRET for auth)
    const edgeSecret = process.env.EDGE_SECRET;
    if (!edgeSecret) {
      throw new Error('EDGE_SECRET environment variable is required');
    }

    this.backend = new RailwayClient(
      this.config.backend.url,
      this.config.edge.user_phone,
      edgeSecret,
      this.config.edge.agent_id,
      this.logger
    );

    this.wsClient = new WebSocketClient(
      this.config.backend.url,
      edgeSecret,
      this.logger
    );

    // Initialize scheduler
    const dbPath = this.config.database?.path || './data/scheduler.db';
    this.scheduler = new Scheduler(dbPath, this.transport, this.logger, this.posthog);

    // Set up scheduler acknowledgment callback for scheduled message execution
    this.scheduler.onAck((commandId, status, options) => {
      this.sendScheduledMessageAck(commandId, status, options);
    });

    // Initialize rule engine
    const rulesDbPath = this.config.database?.rules_path || './data/rules.db';
    this.ruleEngine = new RuleEngine(rulesDbPath, this.logger);

    // Initialize plan manager
    const plansDbPath = this.config.database?.plans_path || './data/plans.db';
    this.planManager = new PlanManager(plansDbPath, this.logger);

    const stateDbPath = this.config.database?.state_path || './data/edge-state.db';
    const keychainManager = new KeychainManager(
      this.config.security?.keychain_service || 'com.ikiro.edge',
      this.config.security?.keychain_account || 'edge-state',
      this.logger
    );
    const stateKey = keychainManager.ensureKey();
    this.contextManager = new ContextManager(stateDbPath, stateKey, this.logger);
    this.attachmentCache = new AttachmentCache(stateDbPath, stateKey, this.logger);

    const maxPhotoBytes = 5 * 1024 * 1024;
    this.photoTranscoder = new PhotoTranscoder(this.logger, maxPhotoBytes);
    this.attachmentProcessor = new AttachmentProcessor(
      this.logger,
      maxPhotoBytes,
      this.photoTranscoder
    );

    // Initialize email sender gate (phone is primary identifier)
    this.emailSenderGate = new EmailSenderGate(this.logger);

    // Initialize command handler
    this.commandHandler = new CommandHandler(
      this.scheduler,
      this.transport,
      this.logger,
      this.ruleEngine,
      this.planManager,
      this.contextManager
    );

    // Set up WebSocket callbacks
    this.wsClient.onCommand(async (command) => {
      await this.processCommand(command);
    });

    this.wsClient.onConnected(() => {
      this.logger.info('🔌 WebSocket connected - real-time command delivery enabled');
      this.healthCheck.setWebSocketConnected(true);

      // Track WebSocket connection
      this.posthog.trackWebSocketStatus('connected');

      // Reduce or stop HTTP polling when WebSocket is connected
      if (this.syncInterval) {
        clearInterval(this.syncInterval);
        this.syncInterval = null;
        this.logger.info('HTTP polling paused (using WebSocket)');
      }
    });

    this.wsClient.onConfigUpdate((config) => {
      if (config.persona_id && config.persona_id !== this.config.edge.persona_id) {
        const result = this.switchPersona(config.persona_id);
        this.logger.info(`🔄 Remote persona switch: ${result.previous} → ${result.current}`);
      }
    });

    this.wsClient.onDisconnected(() => {
      this.logger.warn('🔌 WebSocket disconnected - falling back to HTTP polling');
      this.healthCheck.setWebSocketConnected(false);

      // Track WebSocket disconnection
      this.posthog.trackWebSocketStatus('disconnected');

      // Resume HTTP polling as fallback
      if (!this.syncInterval && this.isRunning) {
        this.startSyncLoop();
      }
    });

    this.logger.info('Edge Agent initialized with scheduler and WebSocket support');
  }

  private initializeTransport(attachmentsPath: string): IMessageTransport {
    const mode = this.config.imessage.transport_mode || 'native_helper';
    if (mode === 'native_helper') {
      if (!this.config.imessage.bridge_executable) {
        throw new Error('imessage.bridge_executable is required for native_helper transport mode');
      }

      return new NativeBridgeTransport(
        {
          executable: this.config.imessage.bridge_executable!,
          args: this.config.imessage.bridge_args || [],
          attachmentsPath,
          dbPath: this.config.imessage.db_path,
          stateFilePath: './data/messages-helper-rowid',
          maxMessageAgeSeconds: this.config.imessage.max_message_age_seconds
        },
        this.logger
      );
    }

    return new AppleScriptTransport(
      this.config.imessage.db_path,
      attachmentsPath,
      this.logger
    );
  }

  /**
   * MEMORY LEAK FIX: Safe setTimeout that tracks timer for cleanup
   */
  private safeSetTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.activeTimers.delete(timer);
      callback();
    }, ms);

    this.activeTimers.add(timer);
    return timer;
  }

  /**
   * MEMORY LEAK FIX: Safe setInterval that tracks timer for cleanup
   */
  private safeSetInterval(callback: () => void, ms: number): NodeJS.Timeout {
    const timer = setInterval(callback, ms);
    this.activeIntervals.add(timer);
    return timer;
  }


  /**
   * Start the edge agent
   */
  async start(): Promise<void> {
    try {
      this.logger.info('='.repeat(60));
      this.logger.info('Starting Edge Agent v2.0.0 (Phase 2: Transport + Scheduler)');
      this.logger.info('='.repeat(60));

      // Initialize monitoring
      this.sentry.initialize();
      this.posthog.initialize();
      this.healthCheck.start();

      // Apply feature flag overrides (if PostHog flags are enabled)
      if (this.config.monitoring?.posthog?.feature_flags_enabled) {
        await this.applyFeatureFlagOverrides();
      }

      // Register with backend
      this.logger.info('Registering with backend...');
      const edgeAgentId = await this.backend.register();
      this.logger.info(`✅ Registered as: ${edgeAgentId}`);

      // Set edge agent ID for WebSocket
      this.wsClient.setEdgeAgentId(edgeAgentId);

      // Start transport
      this.logger.info('Starting iMessage transport...');
      await this.transport.start();
      this.logger.info('✅ Transport ready');

      // Start scheduler
      this.logger.info('Starting scheduler...');
      const schedulerInterval = this.config.scheduler?.check_interval_seconds ?? 30;
      const schedulerAdaptive = this.config.scheduler?.adaptive_mode ?? true;
      this.scheduler.start(schedulerInterval, schedulerAdaptive);
      const stats = this.scheduler.getStats();
      this.logger.info(`✅ Scheduler ready (${stats.pending} pending messages)`);

      // Check backend health
      const healthy = await this.backend.healthCheck();
      if (healthy) {
        this.logger.info('✅ Backend is healthy');
      } else {
        this.logger.warn('⚠️  Backend health check failed');
      }

      // Start message polling loop
      this.isRunning = true;

      this.startPolling();
      this.startSyncWatchdog();

      // Try to connect WebSocket for real-time commands
      if (this.useWebSocket) {
        this.logger.info('Attempting WebSocket connection...');
        const wsConnected = await this.wsClient.connect();

        if (wsConnected) {
          this.logger.info('✅ WebSocket connected - real-time mode enabled');
        } else {
          this.logger.warn('⚠️  WebSocket connection failed - falling back to HTTP polling');
          // Track WebSocket connection failure
          this.posthog.trackWebSocketStatus('failed', 'Initial connection failed');
          this.startSyncLoop();
        }
      } else {
        // Start sync loop (HTTP polling fallback)
        this.startSyncLoop();
      }

      this.logger.info('='.repeat(60));
      this.logger.info('✅ Edge Agent is running!');
      this.healthCheck.setRunning(true);
      this.logger.info(`Polling for messages every ${this.config.imessage.poll_interval_seconds}s`);

      if (this.wsClient.isConnected()) {
        this.logger.info('Command delivery: Real-time via WebSocket 🚀');
      } else {
        this.logger.info(`Command delivery: HTTP polling every ${this.config.backend.sync_interval_seconds}s`);
      }

      this.logger.info('Press Ctrl+C to stop');
      this.logger.info('='.repeat(60));
    } catch (error: any) {
      this.logger.error('Failed to start edge agent:', error.message);
      throw error;
    }
  }

  /**
   * Start polling for messages
   */
  private startPolling(): void {
    const pollIntervalMs = this.config.imessage.poll_interval_seconds * 1000;

    // Poll immediately
    this.pollMessages();

    // Then poll on interval (using safe interval tracking)
    this.pollInterval = this.safeSetInterval(() => {
      this.pollMessages();
    }, pollIntervalMs);
  }

  /**
   * Start the iCloud sync watchdog.
   * If no new messages arrive within SYNC_STALE_THRESHOLD_MS, restart Messages.app
   * to kick iCloud sync back into action.
   */
  private startSyncWatchdog(): void {
    this.lastNewMessageTime = new Date();
    this.syncWatchdogInterval = this.safeSetInterval(() => {
      this.checkSyncStaleness();
    }, EdgeAgent.SYNC_WATCHDOG_CHECK_MS);
    this.logger.info(`Sync watchdog started (restart Messages.app if no messages for ${EdgeAgent.SYNC_STALE_THRESHOLD_MS / 60000}min)`);
  }

  private checkSyncStaleness(): void {
    const staleDuration = Date.now() - this.lastNewMessageTime.getTime();
    if (staleDuration < EdgeAgent.SYNC_STALE_THRESHOLD_MS) {
      return;
    }

    const staleMinutes = Math.round(staleDuration / 60000);
    this.logger.warn(`iCloud sync may be stalled — no new messages for ${staleMinutes}min, restarting Messages.app`);

    const { execSync } = require('child_process');
    try {
      execSync('killall Messages 2>/dev/null; sleep 2; open -a Messages', { timeout: 15000 });
      this.logger.info('Messages.app restarted to refresh iCloud sync');
      // Reset timer so we don't restart again immediately
      this.lastNewMessageTime = new Date();
    } catch (error: any) {
      this.logger.error('Failed to restart Messages.app:', error.message);
    }
  }

  /**
   * Poll for new messages and process them
   */
  private async pollMessages(): Promise<void> {
    try {
      // Get new messages from transport
      const messages = await this.transport.pollNewMessages();

      if (messages.length === 0) {
        return;
      }

      this.logger.info(`📬 Processing ${messages.length} new message(s)`);

      // Reset sync watchdog — we got fresh messages
      this.lastNewMessageTime = new Date();

      // OPTIMIZATION: Process messages in parallel (up to 3 concurrent)
      // Improves throughput 2-3× when multiple messages arrive together
      const concurrency = 3;
      for (let i = 0; i < messages.length; i += concurrency) {
        const batch = messages.slice(i, i + concurrency);
        await Promise.all(batch.map(message => this.processMessage(message)));
      }
    } catch (error: any) {
      this.logger.error('Error polling messages:', error.message);
    }
  }

  /**
   * Process a single message
   */
  private async processMessage(message: IncomingMessage): Promise<void> {
    try {
      this.logger.info('='.repeat(60));
      this.logger.info(`📨 INCOMING MESSAGE from ${message.sender}`);
      this.logger.info(`   Thread: ${message.threadId}`);
      this.logger.info(`   Group: ${message.isGroup ? 'Yes' : 'No'}`);
      this.logger.info(`   Text: "${message.text}"`);
      this.logger.info('='.repeat(60));

      // Track message received
      this.posthog.trackMessageRelayed('inbound', message.threadId, message.isGroup, {
        hasAttachments: (message.attachments?.length ?? 0) > 0,
      });

      // Filter out messages from the edge client's own phone number to prevent loops
      if (message.sender === this.config.edge.user_phone) {
        this.logger.info(`⏭️  Skipping message from edge client's own number (${message.sender}) to prevent loop`);
        return;
      }

      // Defense-in-depth: reject stale messages (iCloud sync can insert old messages with new ROWIDs)
      const maxAgeSec = this.config.imessage.max_message_age_seconds || 21600;
      const messageAgeSec = (Date.now() - message.timestamp.getTime()) / 1000;
      if (messageAgeSec > maxAgeSec) {
        const ageHours = (messageAgeSec / 3600).toFixed(1);
        const maxHours = (maxAgeSec / 3600).toFixed(1);
        this.logger.warn(`⏭️  Skipping stale message from ${message.sender} (age: ${ageHours}h, max: ${maxHours}h) — likely iCloud sync backfill`);
        this.logger.warn(`   Text: "${message.text.substring(0, 80)}"`);
        return;
      }

      // Email sender gate: phone number is the primary identifier.
      // If someone messages from an email Apple ID, block and reply locally.
      // No backend cost — handled entirely on edge.
      const emailRejection = this.emailSenderGate.check(
        message.sender,
        this.config.edge.persona_id
      );
      if (emailRejection) {
        await this.transport.sendMessage(message.threadId, emailRejection, message.isGroup);
        return;
      }

      const activeContext = this.contextManager.getContext(message.threadId);
      const attachmentSummaries = await this.processMessageAttachments(message, activeContext);

      // Filter out attachment placeholder character (￼) from text
      const filteredText = message.text.replace(/\uFFFC/g, '').trim();

      // Skip sending to /edge/message if this is a photo-only message with no text
      if (!filteredText && attachmentSummaries.length > 0) {
        this.logger.info('ℹ️  Photo-only message - skipping /edge/message (photos uploaded to /photo/upload)');
        return;
      }

      // Send to backend for processing
      this.logger.info(`⬆️  SENDING TO BACKEND: ${this.config.backend.url}/edge/message`);
      const backendRequest: BackendMessageRequest = {
        chat_guid: message.threadId,                      // Unique conversation ID
        mode: message.isGroup ? 'group' : 'direct',       // Conversation mode
        sender: message.sender,
        text: filteredText,                               // Message text
        timestamp: Math.floor(message.timestamp.getTime() / 1000), // Unix timestamp
        participants: message.participants,
        persona_id: this.config.edge.persona_id,             // Persona for this edge node (from config)
        persona_phone: this.config.edge.user_phone,          // This persona's iMessage phone number
        metadata: {
          was_redacted: false,
          redacted_fields: [],
          filter_reason: 'phase1_transport'
        },
        context: this.buildBackendContext(activeContext),
        attachments: attachmentSummaries.length > 0 ? attachmentSummaries : undefined
      };

      // Show typing indicator while backend processes
      await this.transport.setTypingIndicator(message.threadId, true);

      const response = await this.backend.sendMessage(backendRequest);
      this.logger.info(`⬇️  BACKEND RESPONSE: should_respond=${response.should_respond}`);

      // Clear typing indicator once we have a response
      await this.transport.setTypingIndicator(message.threadId, false);

      if (response.mini_app_triggered) {
        this.contextManager.upsertContext({
          chatGuid: message.threadId,
          appId: response.mini_app_triggered,
          roomId: response.room_id || undefined,
          state: 'active',
          metadata: response.context_metadata || undefined
        });
      } else if (response.context_metadata?.state === 'completed') {
        this.contextManager.completeContext(message.threadId, response.context_metadata);
      }

      // Send response if backend wants us to
      if (response.should_respond) {
        // NEW: Check for reflex/burst split (fast path)
        if (response.reflex_message) {
          this.logger.info('-'.repeat(60));
          this.logger.info(`⚡ SENDING REFLEX MESSAGE to ${message.threadId}`);
          this.logger.info(`   Text: "${response.reflex_message}"`);
          this.logger.info('-'.repeat(60));

          const reflexSent = await this.transport.sendMessage(
            message.threadId,
            response.reflex_message,
            message.isGroup
          );

          // Track reflex message sent
          this.posthog.trackMessageRelayed('outbound', message.threadId, message.isGroup, {
            bubbleType: 'reflex',
            success: reflexSent,
          });

          if (reflexSent) {
            this.logger.info('✅ Reflex message DELIVERED to iMessage');
          } else {
            this.logger.error('❌ FAILED to deliver reflex message to iMessage');
          }

          // Send burst messages after delay (if any)
          if (response.burst_messages && response.burst_messages.length > 0) {
            const delayMs = response.burst_delay_ms || 2000;
            this.logger.info(`⏳ Will send ${response.burst_messages.length} burst messages after ${delayMs}ms`);
            this.logger.info(`   Burst messages: ${JSON.stringify(response.burst_messages)}`);

            setTimeout(async () => {
              this.logger.info('-'.repeat(60));
              this.logger.info(`📤 SENDING BURST MESSAGES to ${message.threadId}`);
              for (let i = 0; i < response.burst_messages!.length; i++) {
                this.logger.info(`   [${i + 1}/${response.burst_messages!.length}]: "${response.burst_messages![i]}"`);
              }
              this.logger.info('-'.repeat(60));

              const burstSent = await this.transport.sendMultiBubble(
                message.threadId,
                response.burst_messages!,
                message.isGroup
              );

              // Track burst messages sent
              this.posthog.trackMessageRelayed('outbound', message.threadId, message.isGroup, {
                bubbleType: 'burst',
                success: burstSent,
              });

              if (burstSent) {
                this.logger.info('✅ All burst messages DELIVERED to iMessage');
              } else {
                this.logger.error('❌ FAILED to deliver burst messages to iMessage');
              }
            }, delayMs);
          }
        }
        // Legacy multi-bubble response
        else if (response.reply_bubbles && response.reply_bubbles.length > 0) {
          this.logger.info('-'.repeat(60));
          this.logger.info(`📤 SENDING ${response.reply_bubbles.length} BUBBLES to ${message.threadId}`);
          for (let i = 0; i < response.reply_bubbles.length; i++) {
            this.logger.info(`   [${i + 1}/${response.reply_bubbles.length}]: "${response.reply_bubbles[i]}"`);
          }
          this.logger.info('-'.repeat(60));

          const sent = await this.transport.sendMultiBubble(
            message.threadId,
            response.reply_bubbles,
            message.isGroup
          );

          // Track multi-bubble message sent
          this.posthog.trackMessageRelayed('outbound', message.threadId, message.isGroup, {
            bubbleType: 'multi',
            success: sent,
          });

          if (sent) {
            this.logger.info('✅ All bubbles DELIVERED to iMessage');
          } else {
            this.logger.error('❌ FAILED to deliver bubbles to iMessage');
          }
        }
        // Legacy single bubble
        else if (response.reply_text) {
          this.logger.info('-'.repeat(60));
          this.logger.info(`📤 SENDING RESPONSE to ${message.threadId}`);
          this.logger.info(`   Text: "${response.reply_text}"`);
          this.logger.info('-'.repeat(60));

          const sent = await this.transport.sendMessage(
            message.threadId,
            response.reply_text,
            message.isGroup
          );

          // Track single message sent
          this.posthog.trackMessageRelayed('outbound', message.threadId, message.isGroup, {
            bubbleType: 'single',
            success: sent,
          });

          if (sent) {
            this.logger.info('✅ Response DELIVERED to iMessage');
          } else {
            this.logger.error('❌ FAILED to deliver response to iMessage');
          }
        }
      } else {
        this.logger.info('ℹ️  Backend did not request a response');
      }

    } catch (error: any) {
      // Clear typing indicator on error so it doesn't get stuck
      await this.transport.setTypingIndicator(message.threadId, false).catch(() => {});

      this.logger.error('Error processing message:', error.message);

      // Track error
      this.posthog.trackError(
        'message_processing',
        error.message,
        {
          thread_id: message.threadId,
          is_group: message.isGroup,
          component: 'EdgeAgent.processMessage'
        }
      );
    }
  }

  /**
   * Start sync loop with backend
   */
  private startSyncLoop(): void {
    const syncIntervalMs = this.config.backend.sync_interval_seconds * 1000;

    // Sync immediately
    this.syncWithBackend();

    // Then sync on interval (using safe interval tracking)
    this.syncInterval = this.safeSetInterval(() => {
      this.syncWithBackend();
    }, syncIntervalMs);
  }

  /**
   * Sync with backend - send events and receive commands
   */
  private async syncWithBackend(): Promise<void> {
    try {
      const edgeAgentId = this.backend.getEdgeAgentId();
      if (!edgeAgentId) {
        this.logger.warn('Cannot sync - no edge agent ID');
        return;
      }

      // Get current stats
      const stats = this.scheduler.getStats();
      const uptimeSeconds = Math.floor((new Date().getTime() - this.startTime.getTime()) / 1000);

      // Prepare sync request
      const syncRequest = {
        edge_agent_id: edgeAgentId,
        last_command_id: this.lastCommandId,
        pending_events: this.pendingEvents,
        status: {
          scheduled_messages: stats.pending,
          active_rules: this.commandHandler.getActiveRulesCount(),
          uptime_seconds: uptimeSeconds
        }
      };

      // Sync with backend
      const response = await this.backend.sync(syncRequest);

      // Clear acknowledged events
      if (response.ack_events.length > 0) {
        this.pendingEvents = this.pendingEvents.filter(
          event => !response.ack_events.includes(event.event_id)
        );
        this.logger.debug(`Cleared ${response.ack_events.length} acknowledged events`);
      }

      // Process commands
      if (response.commands.length > 0) {
        this.logger.info(`📥 Received ${response.commands.length} command(s) from backend`);

        for (const command of response.commands) {
          await this.processCommand(command);
        }
      }

      // Apply config updates if any
      if (response.config_updates) {
        this.applyConfigUpdates(response.config_updates);
      }
    } catch (error: any) {
      this.logger.error('Error syncing with backend:', error.message);
    }
  }

  /**
   * Process a command from the backend
   */
  private async processCommand(command: EdgeCommandWrapper): Promise<void> {
    const commandStartTime = Date.now();
    try {
      // Log command priority if specified
      if (command.priority === 'immediate') {
        this.logger.info(`⚡ Processing IMMEDIATE priority command ${command.command_id}`);
      }

      if (command.command_type === 'upload_retry') {
        const retryResult = await this.handleUploadRetryCommand(command);
        await this.acknowledgeCommandResult(command, retryResult.success, retryResult.error);

        // Track command execution
        const durationMs = Date.now() - commandStartTime;
        this.posthog.trackCommandProcessed(command.command_type, retryResult.success, durationMs);
        return;
      }

      if (command.command_type === 'emit_event') {
        const eventResult = await this.handleEmitEventCommand(command);
        await this.acknowledgeCommandResult(command, eventResult.success, eventResult.error);

        // Track command execution
        const durationMs = Date.now() - commandStartTime;
        this.posthog.trackCommandProcessed(command.command_type, eventResult.success, durationMs);
        return;
      }

      // Execute command
      const result = await this.commandHandler.executeCommand(command);

      // Update last command ID
      this.lastCommandId = command.command_id;

      await this.acknowledgeCommandResult(command, result.success, result.error);

      // Track command execution
      const durationMs = Date.now() - commandStartTime;
      this.posthog.trackCommandProcessed(command.command_type, result.success, durationMs);

      if (result.success) {
        this.logger.info(`✅ Command ${command.command_id} executed successfully`);
      } else {
        this.logger.error(`❌ Command ${command.command_id} failed: ${result.error}`);
      }
    } catch (error: any) {
      this.logger.error(`Error processing command ${command.command_id}:`, error.message);
      await this.acknowledgeCommandResult(command, false, error.message);

      // Track command error
      const durationMs = Date.now() - commandStartTime;
      this.posthog.trackCommandProcessed(command.command_type, false, durationMs);
      this.posthog.trackError(
        'command_processing',
        error.message,
        {
          command_type: command.command_type,
          command_id: command.command_id,
          component: 'EdgeAgent.processCommand'
        }
      );
    }
  }

  private async acknowledgeCommandResult(
    command: EdgeCommandWrapper,
    success: boolean,
    error?: string
  ): Promise<void> {
    const ackSent = this.wsClient.isConnected()
      ? this.wsClient.sendCommandAck(
          command.command_id,
          success ? 'completed' : 'failed',
          { error }
        )
      : false;

    if (!ackSent) {
      await this.backend.acknowledgeCommand(
        command.command_id,
        success,
        error
      );
    }
  }

  /**
   * Send acknowledgment for scheduled message execution
   * Called by Scheduler when a scheduled message (from a command) is sent or fails
   * This prevents the backend safety net from sending duplicate reminders
   */
  private sendScheduledMessageAck(
    commandId: string,
    status: 'completed' | 'failed',
    options?: { error?: string; completedAt?: Date }
  ): void {
    const ackSent = this.wsClient.isConnected()
      ? this.wsClient.sendCommandAck(commandId, status, options)
      : false;

    if (!ackSent) {
      // Fall back to HTTP acknowledgment
      this.backend.acknowledgeCommand(
        commandId,
        status === 'completed',
        options?.error
      ).catch(err => {
        this.logger.error(`Failed to send HTTP ack for scheduled message ${commandId}:`, err.message);
      });
    }
  }

  /**
   * Apply config updates from backend
   */
  private applyConfigUpdates(updates: { sync_interval?: number; [key: string]: any }): void {
    if (updates.sync_interval) {
      this.logger.info(`Updating sync interval to ${updates.sync_interval}s`);
      this.config.backend.sync_interval_seconds = updates.sync_interval;

      // Restart sync loop with new interval
      if (this.syncInterval) {
        clearInterval(this.syncInterval);
        this.startSyncLoop();
      }
    }
  }

  /**
   * Apply feature flag overrides from PostHog.
   * Allows remote configuration of persona, poll interval, WebSocket, and adaptive scheduling.
   */
  private async applyFeatureFlagOverrides(): Promise<void> {
    try {
      // persona_id is now managed via WebSocket config_update (not PostHog)

      // Override iMessage poll interval
      const pollOverride = await this.posthog.getConfig<number>('edge-poll-interval', 0);
      if (pollOverride > 0 && pollOverride !== this.config.imessage.poll_interval_seconds) {
        this.logger.info(`Feature flag override: poll_interval ${this.config.imessage.poll_interval_seconds}s → ${pollOverride}s`);
        this.config.imessage.poll_interval_seconds = pollOverride;
      }

      // Override WebSocket enabled/disabled
      const wsEnabled = await this.posthog.getFlag('edge-websocket-enabled', true);
      if (wsEnabled !== this.useWebSocket) {
        this.logger.info(`Feature flag override: websocket ${this.useWebSocket} → ${wsEnabled}`);
        this.useWebSocket = wsEnabled;
      }

      // Override adaptive scheduling
      const adaptiveEnabled = await this.posthog.getFlag('edge-adaptive-scheduling', true);
      if (this.config.scheduler) {
        if (adaptiveEnabled !== (this.config.scheduler.adaptive_mode ?? true)) {
          this.logger.info(`Feature flag override: adaptive_mode → ${adaptiveEnabled}`);
          this.config.scheduler.adaptive_mode = adaptiveEnabled;
        }
      }
    } catch (error) {
      this.logger.warn('Failed to apply feature flag overrides (using defaults):', error);
    }
  }

  /**
   * Build backend context payload from local context
   */
  private buildBackendContext(context: MiniAppContext | null): BackendMiniAppContext | undefined {
    if (!context) {
      return undefined;
    }

    return {
      active_miniapp: context.appId,
      room_id: context.roomId,
      state: context.state,
      metadata: context.metadata
    };
  }

  /**
   * Process attachments for an incoming message (photo uploads, metadata)
   */
  private async processMessageAttachments(
    message: IncomingMessage,
    activeContext: MiniAppContext | null
  ): Promise<BackendAttachmentSummary[]> {
    if (!message.attachments || message.attachments.length === 0) {
      return [];
    }

    this.logger.info(`📎 Message includes ${message.attachments.length} attachment(s)`);

    // Debug: Log attachment details
    for (const att of message.attachments) {
      this.logger.debug(`  Attachment: guid=${att.guid}, uti=${att.uti}, mime=${att.mimeType}, path=${att.absolutePath}`);
    }

    const backendContext = this.buildBackendContext(activeContext);

    for (const attachment of message.attachments) {
      this.attachmentCache.saveOrUpdate({
        guid: attachment.guid,
        attachmentId: attachment.id,
        threadId: message.threadId,
        sender: message.sender,
        isGroup: message.isGroup,
        participants: message.participants,
        filename: attachment.filename,
        transferName: attachment.transferName,
        uti: attachment.uti,
        mimeType: attachment.mimeType,
        absolutePath: attachment.absolutePath,
        relativePath: attachment.relativePath,
        sizeBytes: attachment.totalBytes,
        isSticker: attachment.isSticker,
        isOutgoing: attachment.isOutgoing,
        context: backendContext
      });
    }

    const prepared = await this.attachmentProcessor.prepareAttachments(message.attachments);
    this.logger.debug(`📦 Prepared ${prepared.length} attachments`);
    const summaries: BackendAttachmentSummary[] = [];

    for (const item of prepared) {
      const summary: BackendAttachmentSummary = {
        guid: item.attachment.guid,
        mime_type: item.mimeType,
        size_bytes: item.sizeBytes ?? null,
        is_photo: this.attachmentProcessor.isPhotoCandidate(item.attachment),
        skipped: item.skipped,
        skip_reason: item.skipReason
      };

      // Log attachment processing details
      if (item.skipped) {
        this.logger.warn(`⏭️  Skipping attachment ${item.attachment.guid}: ${item.skipReason}`);
      } else if (!item.base64) {
        this.logger.warn(`⏭️  Skipping attachment ${item.attachment.guid}: no base64 data`);
      } else {
        this.logger.info(`📤 Uploading photo ${item.attachment.guid} (${item.sizeBytes} bytes, ${item.mimeType})`);
      }

      if (!item.skipped && item.base64) {
        const uploadStartTime = Date.now();

        // Track photo upload started
        this.posthog.trackPhotoUpload('started', item.attachment.guid, {
          mimeType: item.mimeType || 'unknown',
          sizeBytes: item.sizeBytes ?? 0,
          threadId: message.threadId,
        });

        try {
          // Extract caption from message text (if photo has accompanying text)
          const caption = message.text?.trim() || undefined;

          const uploadResponse = await this.backend.uploadPhoto({
            photo_data: item.base64,
            user_phone: message.sender,
            edge_agent_id: this.config.edge.agent_id,
            chat_guid: message.threadId,
            mime_type: item.mimeType,
            size_bytes: item.sizeBytes ?? undefined,
            attachment_guid: item.attachment.guid,
            context: backendContext,
            // Group photo handling - backend will defer processing if group without Luna mention
            is_group: message.isGroup,
            caption
          });

          const uploadDurationMs = Date.now() - uploadStartTime;

          // Track photo upload completed
          this.posthog.trackPhotoUpload('completed', item.attachment.guid, {
            photoId: uploadResponse.photo_id,
            sizeBytes: item.sizeBytes ?? 0,
            uploadDurationMs,
          });

          summary.uploaded_photo_id = uploadResponse.photo_id;
          this.attachmentCache.markUploaded(item.attachment.guid, uploadResponse.photo_id);

          // Log based on processing status
          const status = uploadResponse.status || 'processing';
          if (status === 'stored') {
            this.logger.info(`📦 Photo ${item.attachment.guid} stored for deferred processing (group chat, no Luna mention)`);
          } else {
            this.logger.info(`📸 Uploaded attachment ${item.attachment.guid} (photo_id=${uploadResponse.photo_id})`);
          }
        } catch (error: any) {
          // Track photo upload failed
          this.posthog.trackPhotoUpload('failed', item.attachment.guid, {
            errorReason: error.message,
            sizeBytes: item.sizeBytes ?? 0,
          });

          summary.skipped = true;
          summary.skip_reason = 'upload_failed';
          this.logger.error(`❌ Failed to upload attachment ${item.attachment.guid}: ${error.message}`);
        }
      }

      summaries.push(summary);
    }

    return summaries;
  }

  /**
   * Handle upload_retry command from backend
   */
  private async handleUploadRetryCommand(
    command: EdgeCommandWrapper
  ): Promise<{ success: boolean; error?: string }> {
    const payload = command.payload as UploadRetryCommand['payload'];

    if (!payload.attachment_guid) {
      return { success: false, error: 'attachment_guid is required for upload_retry' };
    }

    const record = this.attachmentCache.get(payload.attachment_guid);
    if (!record || !record.absolutePath) {
      this.logger.warn(`upload_retry requested for unknown attachment ${payload.attachment_guid}`);
      return { success: false, error: 'Attachment not found locally' };
    }

    const attachment = {
      id: record.attachmentId ?? 0,
      guid: record.guid,
      filename: record.filename,
      uti: record.uti,
      mimeType: record.mimeType,
      transferName: record.transferName,
      totalBytes: record.sizeBytes,
      absolutePath: record.absolutePath,
      relativePath: record.relativePath,
      isSticker: record.isSticker,
      isOutgoing: record.isOutgoing
    } as MessageAttachment;

    const prepared = await this.attachmentProcessor.prepareAttachments([attachment]);
    const item = prepared[0];

    if (!item || item.skipped || !item.base64) {
      const reason = item?.skipReason || 'unable_to_prepare_attachment';
      this.logger.error(`upload_retry failed to prepare ${record.guid}: ${reason}`);
      return { success: false, error: reason };
    }

    const latestContext = this.contextManager.getContext(record.threadId);
    const backendContext = this.buildBackendContext(latestContext) || record.context;

    try {
      const uploadResponse = await this.backend.uploadPhoto({
        photo_data: item.base64,
        user_phone: record.sender || this.config.edge.user_phone,
        edge_agent_id: this.config.edge.agent_id,
        chat_guid: record.threadId,
        mime_type: item.mimeType,
        size_bytes: item.sizeBytes ?? undefined,
        attachment_guid: record.guid,
        context: backendContext,
        // Group photo handling - include cached group context
        is_group: record.isGroup
        // Note: caption not available for retry - backend should handle without it
      });

      this.attachmentCache.markUploaded(record.guid, uploadResponse.photo_id);
      this.logger.info(`✅ Re-uploaded attachment ${record.guid} (photo_id=${uploadResponse.photo_id})`);
      return { success: true };
    } catch (error: any) {
      this.logger.error(`❌ upload_retry failed for ${record.guid}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle emit_event command from backend
   */
  private async handleEmitEventCommand(
    command: EdgeCommandWrapper
  ): Promise<{ success: boolean; error?: string }> {
    const payload = command.payload as EmitEventCommand['payload'];

    if (!payload.event_type) {
      return { success: false, error: 'event_type is required for emit_event' };
    }

    this.logger.info(
      `📡 Backend emit_event received (${payload.event_type}) for chat ${payload.chat_guid || payload.thread_id || payload.room_id}`
    );

    this.addEvent(
      `backend_${payload.event_type}`,
      payload.thread_id || payload.chat_guid,
      payload
    );

    return { success: true };
  }

  /**
   * Add an event to send to backend
   */
  private addEvent(eventType: string, threadId: string | undefined, details: Record<string, any>): void {
    const event: EdgeEventWrapper = {
      event_id: uuidv4(),
      event_type: eventType,
      thread_id: threadId,
      details
    };

    this.pendingEvents.push(event);
  }

  /**
   * Stop the edge agent
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping Edge Agent...');

    this.isRunning = false;

    // Flush monitoring events before shutdown
    await this.sentry.flush();
    await this.posthog.flush();

    // MEMORY LEAK FIX: Clear all tracked intervals
    this.activeIntervals.forEach(interval => {
      clearInterval(interval);
    });
    this.activeIntervals.clear();

    // MEMORY LEAK FIX: Clear all tracked timeouts
    this.activeTimers.forEach(timer => {
      clearTimeout(timer);
    });
    this.activeTimers.clear();

    // Clear legacy interval references (already tracked in activeIntervals)
    this.pollInterval = null;
    this.syncInterval = null;

    // Disconnect WebSocket
    this.wsClient.disconnect();

    this.contextManager.close();
    this.attachmentCache.close();
    this.scheduler.stop();
    this.transport.stop();

    // Close monitoring
    this.healthCheck.stop();
    await this.sentry.close();
    await this.posthog.shutdown();

    this.logger.info('✅ Edge Agent stopped (cleaned up all timers)');
  }

  // ====================
  // Dev Mode API
  // ====================

  /**
   * Switch the active persona at runtime (dev mode only).
   * Only changes the persona_id tag on outbound requests — no WebSocket reconnection needed.
   */
  public switchPersona(personaId: string): { previous: string; current: string } {
    const previous = this.config.edge.persona_id;
    this.config.edge.persona_id = personaId;
    this.logger.info(`Persona switched: ${previous} → ${personaId}`);
    return { previous, current: personaId };
  }

  public getPersonaId(): string {
    return this.config.edge.persona_id;
  }

  public isDevMode(): boolean {
    return this.config.dev?.enabled === true;
  }

  // ====================
  // Admin Interface API
  // ====================

  /**
   * Get current stats for admin dashboard
   */
  async getAdminStats(): Promise<any> {
    const stats = this.scheduler.getStats();
    const uptimeSeconds = Math.floor((new Date().getTime() - this.startTime.getTime()) / 1000);
    const activeRules = this.commandHandler.getActiveRulesCount();

    return {
      uptime_seconds: uptimeSeconds,
      scheduled_messages: stats.pending,
      active_rules: activeRules,
      websocket_connected: this.wsClient.isConnected(),
      http_fallback_active: this.syncInterval !== null,
      messages_processed: stats.sent + stats.failed, // Total processed
      messages_sent: stats.sent,
      last_message_time: null, // Could track this if needed
      edge_agent_id: this.backend.getEdgeAgentId(),
      backend_url: this.config.backend.url,
      imessage_poll_interval: this.config.imessage.poll_interval_seconds,
      performance_profile: this.config.performance?.profile || 'balanced',
    };
  }

  /**
   * Get all scheduled messages
   */
  async getScheduledMessages(): Promise<any[]> {
    return this.scheduler.getAllScheduled();
  }

  /**
   * Get all rules
   */
  async getRules(): Promise<any[]> {
    return this.ruleEngine.getAllRules();
  }

  /**
   * Get all plans
   */
  async getPlans(): Promise<any[]> {
    return this.planManager.getAllPlans();
  }

  /**
   * Cancel a scheduled message
   */
  async cancelScheduledMessage(scheduleId: string): Promise<void> {
    this.logger.info(`Admin: Cancelling scheduled message ${scheduleId}`);
    await this.scheduler.cancel(scheduleId);
  }

  /**
   * Enable a rule
   */
  async enableRule(ruleId: string): Promise<void> {
    this.logger.info(`Admin: Enabling rule ${ruleId}`);
    await this.ruleEngine.enableRule(ruleId);
  }

  /**
   * Disable a rule
   */
  async disableRule(ruleId: string): Promise<void> {
    this.logger.info(`Admin: Disabling rule ${ruleId}`);
    await this.ruleEngine.disableRule(ruleId);
  }

  /**
   * Send a test message
   */
  async sendTestMessage(threadId: string, text: string): Promise<void> {
    this.logger.info(`Admin: Sending test message to ${threadId}`);
    const isGroup = threadId.includes('chat');
    await this.transport.sendMessage(threadId, text, isGroup);
  }

  /**
   * Test backend connection
   */
  async testBackendConnection(): Promise<{ healthy: boolean; latency: number }> {
    const start = Date.now();
    const healthy = await this.backend.healthCheck();
    const latency = Date.now() - start;
    return { healthy, latency };
  }
}

/**
 * Main entry point
 */
async function main() {
  const agent = new EdgeAgent();

  // Handle shutdown gracefully
  process.on('SIGINT', async () => {
    console.log('\n\nReceived SIGINT, shutting down gracefully...');
    await agent.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\nReceived SIGTERM, shutting down gracefully...');
    await agent.stop();
    process.exit(0);
  });

  // Handle uncaught errors
  process.on('uncaughtException', async (error) => {
    console.error('Uncaught exception:', error);
    await agent.stop();
    process.exit(1);
  });

  process.on('unhandledRejection', async (error) => {
    console.error('Unhandled rejection:', error);
    await agent.stop();
    process.exit(1);
  });

  // Start the agent
  try {
    await agent.start();
  } catch (error) {
    console.error('Failed to start edge agent:', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (require.main === module) {
  main();
}

export { EdgeAgent };
