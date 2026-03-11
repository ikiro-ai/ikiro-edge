/**
 * typing-helper — Standalone daemon for iMessage typing indicators
 *
 * Architecture:
 *   1. Links against IMCore private framework
 *   2. Connects to IMDaemon (same as Messages.app does)
 *   3. Listens on a Unix socket for commands from the edge agent
 *   4. Sets typing indicators via IMChat.setLocalUserIsTyping()
 *
 * IMPORTANT: This must run with SIP disabled, as it uses private frameworks.
 * It does NOT need dylib injection — it connects to imagent directly.
 *
 * Protocol (JSON lines over Unix socket):
 *   Request:  {"action": "start_typing", "chat_guid": "iMessage;-;+15551234567"}
 *   Request:  {"action": "stop_typing", "chat_guid": "iMessage;-;+15551234567"}
 *   Response: {"ok": true}
 *   Response: {"ok": false, "error": "Chat not found"}
 */

import Foundation
import Darwin

// MARK: - IMCore Dynamic Loading

/// Dynamically load IMCore to avoid hard link-time dependency.
/// This lets us build without SIP disabled — runtime loading only fails
/// if IMCore isn't accessible (which requires SIP off or proper entitlements).
private final class IMCoreBridge {
    private let chatRegistryClass: AnyClass
    private let daemonControllerClass: AnyClass

    init?() {
        // Load the private framework at runtime
        let frameworkPath = "/System/Library/PrivateFrameworks/IMCore.framework/IMCore"
        guard let handle = dlopen(frameworkPath, RTLD_NOW) else {
            let error = String(cString: dlerror())
            fputs("ERROR: Failed to load IMCore.framework: \(error)\n", stderr)
            return nil
        }

        guard let registryClass = NSClassFromString("IMChatRegistry"),
              let controllerClass = NSClassFromString("IMDaemonController") else {
            fputs("ERROR: Failed to find IMChatRegistry or IMDaemonController classes\n", stderr)
            dlclose(handle)
            return nil
        }

        self.chatRegistryClass = registryClass
        self.daemonControllerClass = controllerClass

        // Connect to the IM daemon
        let controller = self.performSelector(on: controllerClass, selector: "sharedController")
        if let ctrl = controller {
            self.performVoidSelector(on: ctrl, selector: "connectToDaemon")
            fputs("INFO: Connected to IMDaemon\n", stderr)
        }
    }

    func setTyping(_ isTyping: Bool, chatGuid: String) -> (ok: Bool, error: String?) {
        let registry = performSelector(on: chatRegistryClass, selector: "sharedInstance")
        guard let reg = registry else {
            return (false, "Failed to get IMChatRegistry.sharedInstance")
        }

        // Try by GUID first, then by chat identifier
        var chat = performSelector(on: reg, selector: "existingChatWithGUID:", arg: chatGuid)

        if chat == nil {
            // Try stripping the iMessage;-; prefix for identifier lookup
            let identifier = chatGuid
                .replacingOccurrences(of: "iMessage;-;", with: "")
                .replacingOccurrences(of: "iMessage;+;", with: "")
            chat = performSelector(on: reg, selector: "existingChatWithChatIdentifier:", arg: identifier)
        }

        guard let imChat = chat else {
            return (false, "Chat not found: \(chatGuid)")
        }

        // Call setLocalUserIsTyping:
        let sel = NSSelectorFromString("setLocalUserIsTyping:")
        guard imChat.responds(to: sel) else {
            return (false, "setLocalUserIsTyping: not available on this macOS version")
        }

        // Use performSelector with NSNumber for the BOOL argument
        let methodIMP = imChat.method(for: sel)
        typealias SetTypingFunc = @convention(c) (AnyObject, Selector, Bool) -> Void
        let setTyping = unsafeBitCast(methodIMP, to: SetTypingFunc.self)
        setTyping(imChat, sel, isTyping)

        return (true, nil)
    }

    // MARK: - ObjC Runtime Helpers

    private func performSelector(on target: AnyObject, selector selectorName: String) -> AnyObject? {
        let sel = NSSelectorFromString(selectorName)
        guard target.responds(to: sel) else { return nil }
        return target.perform(sel)?.takeUnretainedValue()
    }

    private func performSelector(on target: AnyObject, selector selectorName: String, arg: String) -> AnyObject? {
        let sel = NSSelectorFromString(selectorName)
        guard target.responds(to: sel) else { return nil }
        return target.perform(sel, with: arg as NSString)?.takeUnretainedValue()
    }

    private func performVoidSelector(on target: AnyObject, selector selectorName: String) {
        let sel = NSSelectorFromString(selectorName)
        guard target.responds(to: sel) else { return }
        _ = target.perform(sel)
    }
}

// MARK: - Unix Socket Server

private final class SocketServer {
    private let socketPath: String
    private let bridge: IMCoreBridge
    private var serverFd: Int32 = -1
    private var running = true

    init(socketPath: String, bridge: IMCoreBridge) {
        self.socketPath = socketPath
        self.bridge = bridge
    }

    func run() {
        // Clean up stale socket file
        unlink(socketPath)

        // Create socket
        serverFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard serverFd >= 0 else {
            fputs("ERROR: Failed to create socket: \(String(cString: strerror(errno)))\n", stderr)
            return
        }

        // Bind
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            socketPath.withCString { cstr in
                _ = memcpy(ptr, cstr, min(socketPath.utf8.count, 104))
            }
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(serverFd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }

        guard bindResult == 0 else {
            fputs("ERROR: Failed to bind socket at \(socketPath): \(String(cString: strerror(errno)))\n", stderr)
            close(serverFd)
            return
        }

        // Set permissions so other users on the machine can connect
        chmod(socketPath, 0o777)

        // Listen
        guard listen(serverFd, 5) == 0 else {
            fputs("ERROR: Failed to listen on socket: \(String(cString: strerror(errno)))\n", stderr)
            close(serverFd)
            return
        }

        fputs("INFO: Listening on \(socketPath)\n", stderr)

        // Accept loop
        while running {
            var clientAddr = sockaddr_un()
            var clientLen = socklen_t(MemoryLayout<sockaddr_un>.size)
            let clientFd = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    accept(serverFd, sockPtr, &clientLen)
                }
            }

            guard clientFd >= 0 else {
                if running {
                    fputs("WARN: accept() failed: \(String(cString: strerror(errno)))\n", stderr)
                }
                continue
            }

            // Handle client in a detached thread
            let fd = clientFd
            Thread.detachNewThread { [weak self] in
                self?.handleClient(fd: fd)
            }
        }

        close(serverFd)
        unlink(socketPath)
    }

    func stop() {
        running = false
        close(serverFd)
        unlink(socketPath)
    }

    private func handleClient(fd: Int32) {
        defer { close(fd) }

        let fileHandle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        let data = fileHandle.availableData

        guard !data.isEmpty,
              let line = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !line.isEmpty else {
            writeResponse(fd: fd, ok: false, error: "Empty request")
            return
        }

        // Parse JSON request
        guard let jsonData = line.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
              let action = request["action"] as? String,
              let chatGuid = request["chat_guid"] as? String else {
            writeResponse(fd: fd, ok: false, error: "Invalid JSON: expected {\"action\": \"start_typing\"|\"stop_typing\", \"chat_guid\": \"...\"}")
            return
        }

        let isTyping: Bool
        switch action {
        case "start_typing":
            isTyping = true
        case "stop_typing":
            isTyping = false
        default:
            writeResponse(fd: fd, ok: false, error: "Unknown action: \(action). Use start_typing or stop_typing")
            return
        }

        let result = bridge.setTyping(isTyping, chatGuid: chatGuid)
        writeResponse(fd: fd, ok: result.ok, error: result.error)
    }

    private func writeResponse(fd: Int32, ok: Bool, error: String? = nil) {
        var response: [String: Any] = ["ok": ok]
        if let error = error {
            response["error"] = error
            fputs("WARN: \(error)\n", stderr)
        }

        guard let data = try? JSONSerialization.data(withJSONObject: response),
              var json = String(data: data, encoding: .utf8) else {
            return
        }

        json += "\n"
        json.withCString { ptr in
            _ = write(fd, ptr, json.utf8.count)
        }
    }
}

// MARK: - Main

private var server: SocketServer?

// Handle signals for graceful shutdown
signal(SIGINT) { _ in
    fputs("\nINFO: Shutting down...\n", stderr)
    server?.stop()
    exit(0)
}
signal(SIGTERM) { _ in
    fputs("INFO: Shutting down...\n", stderr)
    server?.stop()
    exit(0)
}

// Parse arguments
var socketPath = "/tmp/typing-helper.sock"
var args = CommandLine.arguments.makeIterator()
_ = args.next() // skip executable
while let arg = args.next() {
    if arg == "--socket", let value = args.next() {
        socketPath = value
    }
}

fputs("INFO: typing-helper starting...\n", stderr)

// Initialize IMCore bridge
guard let bridge = IMCoreBridge() else {
    fputs("FATAL: Could not initialize IMCore bridge. Is SIP disabled?\n", stderr)
    exit(1)
}

fputs("INFO: IMCore bridge initialized\n", stderr)

// Start socket server (blocks)
server = SocketServer(socketPath: socketPath, bridge: bridge)
server?.run()
