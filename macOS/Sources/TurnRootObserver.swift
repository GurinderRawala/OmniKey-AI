import CoreServices
import Foundation

/// FSEvents are invalidation hints, never evidence of original file contents.
/// The stream owns its callback context; that context weakly references the
/// tracker through its closure. Invalidating a stream cannot leave a dangling
/// unretained tracker pointer or a tracker/stream retain cycle.
final class TurnRootObserver {
    private final class CallbackContext {
        let changed: @Sendable () -> Void
        init(_ changed: @escaping @Sendable () -> Void) { self.changed = changed }
    }
    private var stream: FSEventStreamRef?

    init?(paths: [String], queue: DispatchQueue, changed: @escaping @Sendable () -> Void) {
        guard !paths.isEmpty else { return nil }
        let callback = CallbackContext(changed)
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(callback).toOpaque(),
            retain: { pointer in
                guard let pointer else { return nil }
                return UnsafeRawPointer(Unmanaged<CallbackContext>.fromOpaque(pointer).retain().toOpaque())
            },
            release: { pointer in
                if let pointer { Unmanaged<CallbackContext>.fromOpaque(pointer).release() }
            },
            copyDescription: nil
        )
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot | kFSEventStreamCreateFlagNoDefer)
        let created = withExtendedLifetime(callback) {
            FSEventStreamCreate(kCFAllocatorDefault, { _, info, _, _, _, _ in
                guard let info else { return }
                Unmanaged<CallbackContext>.fromOpaque(info).takeUnretainedValue().changed()
            }, &context, paths as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.2, flags)
        }
        guard let created else { return nil }
        stream = created
        FSEventStreamSetDispatchQueue(created, queue)
        guard FSEventStreamStart(created) else { cancel(); return nil }
    }

    func cancel() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }
    deinit { cancel() }
}
