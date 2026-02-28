---
name: swift-development
description: Swift 6 development guidelines for iOS/macOS apps with strict concurrency, actor isolation, Sendable conformance, async/await patterns, SwiftUI best practices, and Swift Testing. Use when writing or reviewing Swift code.
---

# Swift Development Guidelines

Conventions and patterns for Swift 6 projects with strict concurrency checking enabled. All code must be data-race free at compile time.

## Concurrency Patterns

### Actor Isolation

Use actors for mutable shared state:

```swift
// ✅ Actor for shared mutable state
actor AudioManager {
    private var isRecording = false

    func startRecording() async throws {
        guard !isRecording else { return }
        isRecording = true
    }
}

// ❌ Class with manual locking
class AudioManager {
    private var isRecording = false
    private let lock = NSLock()
}
```

### Sendable Conformance

All types crossing isolation boundaries must be `Sendable`:

```swift
// ✅ Sendable struct for cross-boundary data
struct TranscriptionResult: Sendable {
    let text: String
    let confidence: Double
    let timestamp: Date
}

// ✅ Sendable enum
enum AudioCommand: Sendable {
    case start, stop, pause
}
```

### Async/Await Over Callbacks

Always prefer structured concurrency:

```swift
// ✅ async/await
func transcribe(audio: Data) async throws -> String {
    let result = try await speechRecognizer.recognize(audio)
    return result.text
}

// ❌ Callback-based
func transcribe(audio: Data, completion: @escaping (Result<String, Error>) -> Void)
```

### MainActor ViewModels

```swift
@MainActor
final class ViewModel: ObservableObject {
    @Published var state: ViewState = .idle

    private let service: AudioService

    func startListening() {
        Task {
            do {
                let result = try await service.listen()
                self.state = .result(result)
            } catch {
                self.state = .error(error)
            }
        }
    }
}
```

### Thread-Safe Singletons

```swift
// ✅ Actor-based singleton
actor ConfigurationManager {
    static let shared = ConfigurationManager()
    private var settings: [String: Any] = [:]

    func get(_ key: String) -> Any? { settings[key] }
    func set(_ key: String, value: Any) { settings[key] = value }
}

// ✅ Immutable Sendable singleton
final class Constants: Sendable {
    static let shared = Constants()
    let apiEndpoint = "https://api.example.com"
    let timeout: TimeInterval = 30
}
```

### Continuation Patterns

When bridging callback APIs:

```swift
// One-shot callback
func requestPermission() async throws -> Bool {
    try await withCheckedThrowingContinuation { continuation in
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            continuation.resume(returning: granted)
        }
    }
}

// Multiple values
func audioLevels() -> AsyncStream<Float> {
    AsyncStream { continuation in
        let monitor = AudioMonitor { level in continuation.yield(level) }
        continuation.onTermination = { _ in monitor.stop() }
        monitor.start()
    }
}
```

### Task Groups

```swift
func processMultipleFiles(_ files: [URL]) async throws -> [Result] {
    try await withThrowingTaskGroup(of: Result.self) { group in
        for file in files {
            group.addTask { try await self.processFile(file) }
        }
        var results: [Result] = []
        for try await result in group { results.append(result) }
        return results
    }
}
```

## Error Handling

Use typed errors:

```swift
enum AudioError: LocalizedError, Sendable {
    case permissionDenied
    case deviceUnavailable
    case recordingFailed(underlying: String)

    var errorDescription: String? {
        switch self {
        case .permissionDenied: return "Microphone access denied"
        case .deviceUnavailable: return "No audio input device available"
        case .recordingFailed(let message): return "Recording failed: \(message)"
        }
    }
}
```

## SwiftUI Integration

```swift
@MainActor
@Observable
final class AppState {
    var isListening = false
    var transcript = ""
    var error: Error?

    private let audioManager: AudioManager

    func toggleListening() {
        Task {
            do {
                if isListening { await audioManager.stop() }
                else { try await audioManager.start() }
                isListening.toggle()
            } catch { self.error = error }
        }
    }
}
```

## Code Style

### Naming Conventions

- **Types:** `PascalCase` — `AudioManager`, `TranscriptionResult`
- **Functions/Properties:** `camelCase` — `startListening`, `isRecording`
- **Constants:** `camelCase` — `defaultTimeout`, `maxRetries`
- **Actors:** Suffix with purpose — `AudioManager`, `ConfigurationStore`

### Documentation

Use DocC-style comments for public APIs:

```swift
/// Manages audio capture and processing.
///
/// ## Example
/// ```swift
/// let manager = AudioManager()
/// try await manager.startRecording()
/// ```
actor AudioManager {
    /// Starts audio capture from the default input device.
    /// - Throws: `AudioError.permissionDenied` if microphone access is not granted.
    func startRecording() async throws { }
}
```

### File Organization

```swift
// MARK: - Type Definition
actor MyActor {
    // MARK: - Properties
    private var state: State

    // MARK: - Initialization
    init() { }

    // MARK: - Public API
    func publicMethod() async { }

    // MARK: - Private Implementation
    private func helper() { }
}

// MARK: - Supporting Types
extension MyActor {
    enum State: Sendable { case idle, active }
}
```

## Testing

Use Swift Testing (`@Test`, `#expect`):

```swift
@Test
func audioManagerStartsRecording() async throws {
    let manager = AudioManager()
    try await manager.startRecording()
    let isRecording = await manager.isRecording
    #expect(isRecording == true)
}

@Test @MainActor
func viewModelUpdatesState() {
    let vm = ViewModel(mode: .default)
    vm.doSomething()
    #expect(vm.state == .updated)
}
```

## Forbidden Patterns

### Never Use

- `DispatchQueue.main.async` for UI updates — use `@MainActor`
- `NSLock`, `os_unfair_lock` — use actors
- `nonisolated(unsafe)` except for truly immutable external constants
- Force unwrapping (`!`) without prior nil check
- `try!` or `try?` that silently swallows errors
- Mutable-state singletons using class — use actor
- `@unchecked Sendable` without documented thread-safety proof

### Avoid

- `Task.detached` unless truly necessary
- `withUnsafeContinuation` — prefer checked variants
- Global mutable state
- Implicit `@MainActor` inheritance without explicit annotation
