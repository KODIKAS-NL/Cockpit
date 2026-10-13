import Foundation

/// A session as cockpit-daemon lists it (shared/daemon.ts: DaemonSessionInfo).
struct DaemonSessionInfo: Identifiable, Equatable {
    let id: String
    let cwd: String
    let cliSessionId: String?
    let title: String?
    let state: String          // busy | running | idle
    let pendingPrompts: Int
    let clients: Int
    let lastActivity: Date

    init?(_ dict: [String: Any]) {
        guard let id = dict["id"] as? String, let cwd = dict["cwd"] as? String else { return nil }
        self.id = id
        self.cwd = cwd
        self.cliSessionId = dict["cliSessionId"] as? String
        self.title = dict["title"] as? String
        self.state = dict["state"] as? String ?? "idle"
        self.pendingPrompts = (dict["pendingPrompts"] as? NSNumber)?.intValue ?? 0
        self.clients = (dict["clients"] as? NSNumber)?.intValue ?? 0
        let ms = (dict["lastActivity"] as? NSNumber)?.doubleValue ?? 0
        self.lastActivity = Date(timeIntervalSince1970: ms / 1000)
    }

    /// The project folder's name, for compact lists.
    var folderName: String { (cwd as NSString).lastPathComponent }
}

enum DaemonSocketError: LocalizedError {
    case pathTooLong
    case connect(Int32)
    case io(String)
    case timeout
    case closed

    var errorDescription: String? {
        switch self {
        case .pathTooLong: return "socket path is too long"
        case .connect(let code): return "cannot connect (\(String(cString: strerror(code))))"
        case .io(let what): return what
        case .timeout: return "the daemon did not answer in time"
        case .closed: return "the daemon closed the connection"
        }
    }
}

/// Minimal client of the daemon's socket protocol, for status and the sessions list. Blocking:
/// call it off the main thread. Each call opens its own short-lived connection.
enum DaemonSocket {
    /// The pid of the daemon listening on the socket (throws when nothing listens).
    static func hello(socketPath: String, timeout: TimeInterval = 2) throws -> Int32 {
        let reply = try exchange(socketPath: socketPath, messages: [], timeout: timeout) { $0["type"] as? String == "hello_ok" }
        return (reply["pid"] as? NSNumber)?.int32Value ?? 0
    }

    static func list(socketPath: String, timeout: TimeInterval = 3) throws -> [DaemonSessionInfo] {
        let reqId = "app-list-\(UUID().uuidString)"
        let reply = try exchange(
            socketPath: socketPath,
            messages: [["op": "list", "reqId": reqId]],
            timeout: timeout
        ) { $0["reqId"] as? String == reqId }
        let raw = reply["sessions"] as? [[String: Any]] ?? []
        return raw.compactMap(DaemonSessionInfo.init)
    }

    /// Ends a session's CLI process (the conversation stays on disk and resumes later).
    static func stopSession(socketPath: String, id: String) throws {
        // `list` after `stop`: its answer proves the stop was read before we hang up.
        let reqId = "app-stop-\(UUID().uuidString)"
        _ = try exchange(
            socketPath: socketPath,
            messages: [["op": "stop", "sessionId": id], ["op": "list", "reqId": reqId]],
            timeout: 3
        ) { $0["reqId"] as? String == reqId }
    }

    // MARK: - transport

    private static func exchange(
        socketPath: String,
        messages: [[String: Any]],
        timeout: TimeInterval,
        until done: ([String: Any]) -> Bool
    ) throws -> [String: Any] {
        let fd = try connect(socketPath)
        defer { close(fd) }

        var tv = timeval(tv_sec: 0, tv_usec: 200_000)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

        let hello: [String: Any] = ["op": "hello", "clientId": "cockpit-daemon-app", "version": 1]
        for msg in [hello] + messages {
            try send(fd, msg)
        }

        let deadline = Date().addingTimeInterval(timeout)
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while Date() < deadline {
            let n = recv(fd, &chunk, chunk.count, 0)
            if n == 0 { throw DaemonSocketError.closed }
            if n < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { continue }
                throw DaemonSocketError.io("read failed (\(String(cString: strerror(errno))))")
            }
            buffer.append(contentsOf: chunk[0..<n])
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<nl]
                buffer.removeSubrange(buffer.startIndex...nl)
                guard !line.isEmpty,
                      let obj = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any]
                else { continue }
                if done(obj) { return obj }
            }
        }
        throw DaemonSocketError.timeout
    }

    private static func connect(_ path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw DaemonSocketError.io("socket() failed") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < capacity else {
            close(fd)
            throw DaemonSocketError.pathTooLong
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            let code = errno
            close(fd)
            throw DaemonSocketError.connect(code)
        }
        return fd
    }

    private static func send(_ fd: Int32, _ obj: [String: Any]) throws {
        var data = try JSONSerialization.data(withJSONObject: obj)
        data.append(0x0A)
        try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            var offset = 0
            while offset < raw.count {
                let n = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if n < 0 {
                    if errno == EINTR { continue }
                    throw DaemonSocketError.io("write failed (\(String(cString: strerror(errno))))")
                }
                offset += n
            }
        }
    }
}
