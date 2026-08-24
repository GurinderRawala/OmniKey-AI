import Combine
import Foundation

@MainActor
final class CLIUpdateChecker: ObservableObject {
    static let shared = CLIUpdateChecker()

    @Published private(set) var isUpdateAvailable: Bool = false
    @Published private(set) var currentVersion: String?
    @Published private(set) var latestVersion: String?
    @Published private(set) var isChecking: Bool = false
    @Published private(set) var isUpdating: Bool = false
    @Published private(set) var statusMessage: String?

    private let refreshInterval: TimeInterval = 6 * 60 * 60
    private var timer: Timer?
    private var lastFetchAt: Date?

    private init() {}

    func start() {
        guard timer == nil else { return }

        DispatchQueue.main.asyncAfter(deadline: .now() + 7) { [weak self] in
            self?.refreshNow()
        }

        let timer = Timer.scheduledTimer(withTimeInterval: refreshInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshNow() }
        }
        timer.tolerance = 60
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func refreshNow(force: Bool = false) {
        guard !isChecking, !isUpdating else { return }
        if !force, let last = lastFetchAt, Date().timeIntervalSince(last) < 30 {
            return
        }

        isChecking = true
        lastFetchAt = Date()

        SelfHostedBootstrap.checkCLIUpdate { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                self.isChecking = false

                switch result {
                case .success(let status):
                    self.currentVersion = status.currentVersion
                    self.latestVersion = status.latestVersion
                    self.isUpdateAvailable = status.isUpdateAvailable
                    if status.isUpdateAvailable {
                        self.statusMessage = nil
                    }
                case .failure:
                    break
                }
            }
        }
    }

    func updateAndRestartDaemon() {
        guard !isUpdating else { return }

        isUpdating = true
        statusMessage = "Updating omnikey-cli..."

        SelfHostedBootstrap.installOrUpdateCLI { [weak self] result in
            Task { @MainActor in
                guard let self else { return }

                switch result {
                case .success:
                    self.restartDaemonAfterCLIUpdate()
                case .failure(let error):
                    self.isUpdating = false
                    self.statusMessage = error.localizedDescription
                }
            }
        }
    }

    private func restartDaemonAfterCLIUpdate() {
        guard let port = SelfHostedBootstrap.configuredDaemonPort() else {
            isUpdating = false
            isUpdateAvailable = false
            currentVersion = latestVersion
            statusMessage = nil
            return
        }

        statusMessage = "Restarting daemon..."
        SelfHostedBootstrap.startDaemonInBackground(port: port, restartExisting: true) { [weak self] result in
            Task { @MainActor in
                guard let self else { return }

                switch result {
                case .success:
                    self.waitForRestartedDaemon(port: port)
                case .failure(let error):
                    self.isUpdating = false
                    self.statusMessage = error.localizedDescription
                }
            }
        }
    }

    private func waitForRestartedDaemon(port: Int) {
        statusMessage = "Waiting for daemon..."
        SelfHostedBootstrap.waitForDaemon(port: port, timeout: 60) { [weak self] isRunning in
            Task { @MainActor in
                guard let self else { return }
                self.isUpdating = false

                if isRunning {
                    self.currentVersion = self.latestVersion
                    self.isUpdateAvailable = false
                    self.statusMessage = nil
                } else {
                    self.statusMessage = "CLI updated. Daemon did not respond yet."
                }
            }
        }
    }
}
