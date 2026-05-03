import SwiftUI

private enum ScheduleType {
    case oneTime
    case recurring
}

struct ScheduledJobsView: View {
    @Environment(\.colorScheme) private var colorScheme

    @State private var jobs: [APIClient.ScheduledJobDTO] = []
    @State private var isLoading: Bool = false
    @State private var statusMessage: String = ""
    @State private var isEditing: Bool = false
    @State private var editingJobId: String? = nil

    @State private var showingRunHistory: Bool = false
    @State private var historyJobLabel: String = ""
    @State private var historySessionId: String = ""

    // Running-status tracking
    @State private var runningJobIds: Set<String> = []
    @State private var preRunLastRunAt: [String: String?] = [:]
    @State private var pollTimer: Timer? = nil
    @State private var pulseRunning: Bool = false

    @State private var labelInput: String = ""
    @State private var promptInput: String = ""
    @State private var scheduleType: ScheduleType = .recurring

    // Recurring schedule — day chips + time picker
    @State private var recurringTime: Date = {
        var c = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        c.hour = 9
        c.minute = 0
        return Calendar.current.date(from: c) ?? Date()
    }()
    @State private var recurringDays: Set<Int> = [1, 2, 3, 4, 5]   // 0=Sun…6=Sat

    // One-time schedule
    @State private var runAtDate: Date = Date().addingTimeInterval(3_600)

    private let apiClient = APIClient()

    // Mon…Sun display order; value is standard cron day (0=Sun, 1=Mon … 6=Sat)
    private let weekdayOptions: [(label: String, value: Int)] = [
        ("Mon", 1), ("Tue", 2), ("Wed", 3), ("Thu", 4),
        ("Fri", 5), ("Sat", 6), ("Sun", 0),
    ]

    // Build a cron expression from the current picker state.
    private var computedCron: String {
        let cal = Calendar.current
        let minute = cal.component(.minute, from: recurringTime)
        let hour   = cal.component(.hour,   from: recurringTime)
        if recurringDays.count == 7 { return "\(minute) \(hour) * * *" }
        // Sort Mon(1)…Sat(6) first, then Sun(0) last for readability.
        let sorted = recurringDays.sorted { ($0 == 0 ? 7 : $0) < ($1 == 0 ? 7 : $1) }
        return "\(minute) \(hour) * * \(sorted.map { String($0) }.joined(separator: ","))"
    }

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                headerSection
                    .padding(.horizontal, 24)
                    .padding(.top, 20)
                    .padding(.bottom, 16)

                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(height: 1)

                if isEditing {
                    ScrollView {
                        editPanel
                            .padding(24)
                    }
                } else {
                    jobListSection
                        .padding(.horizontal, 24)
                        .padding(.top, 16)
                }

                Spacer()

                if !statusMessage.isEmpty {
                    Text(statusMessage)
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .padding(.horizontal, 24)
                        .padding(.bottom, 12)
                }
            }
        }
        .onAppear { loadJobs() }
        .onDisappear { stopPolling() }
        .sheet(isPresented: $showingRunHistory) {
            JobRunHistoryView(jobLabel: historyJobLabel, sessionId: historySessionId)
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "clock.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(NordTheme.accent(colorScheme))

                Text("Scheduled Jobs")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                Spacer()

                if !isEditing {
                    Button(action: refreshJobs) {
                        Label("Refresh", systemImage: "arrow.clockwise")
                            .font(.system(size: 13, weight: .medium))
                    }
                    .buttonStyle(.bordered)
                    .tint(NordTheme.accentBlue(colorScheme))
                    .disabled(isLoading)

                    Button(action: startAddingJob) {
                        Label("Add New Job", systemImage: "plus")
                            .font(.system(size: 13, weight: .medium))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(NordTheme.accent(colorScheme))
                    .disabled(isLoading)
                }
            }

            Text("Schedule prompts to run automatically at specified times.")
                .font(.system(size: 13))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
        }
    }

    // MARK: - Job List

    private var jobListSection: some View {
        Group {
            if isLoading {
                HStack {
                    Spacer()
                    ProgressView().padding()
                    Spacer()
                }
            } else if jobs.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "clock.badge.questionmark")
                        .font(.system(size: 36))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .padding(.top, 32)
                    Text("No scheduled jobs yet.")
                        .font(.system(size: 14))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                    Text("Click \"Add New Job\" to create one.")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.7))
                }
                .frame(maxWidth: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(jobs) { job in
                            jobRow(job)
                        }
                    }
                    .padding(.bottom, 8)
                }
            }
        }
    }

    private func jobRow(_ job: APIClient.ScheduledJobDTO) -> some View {
        let isRunning = runningJobIds.contains(job.id)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Circle()
                    .fill(isRunning
                          ? NordTheme.accentAmber(colorScheme)
                          : job.isActive
                            ? NordTheme.accentGreen(colorScheme)
                            : NordTheme.secondaryText(colorScheme))
                    .frame(width: 8, height: 8)
                    .scaleEffect(isRunning && pulseRunning ? 1.4 : 1.0)
                    .opacity(isRunning && pulseRunning ? 0.5 : 1.0)
                    .animation(
                        isRunning
                            ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true)
                            : .default,
                        value: pulseRunning
                    )

                Text(job.label)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                Spacer()

                if isRunning {
                    HStack(spacing: 4) {
                        Image(systemName: "bolt.fill")
                            .font(.system(size: 9))
                            .foregroundColor(NordTheme.accentAmber(colorScheme))
                        Text("Running…")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(NordTheme.accentAmber(colorScheme))
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(NordTheme.sectionFill(accent: NordTheme.accentAmber(colorScheme), scheme: colorScheme)))
                    .overlay(Capsule().strokeBorder(NordTheme.sectionBorder(accent: NordTheme.accentAmber(colorScheme), scheme: colorScheme), lineWidth: 1))
                } else if let nextRun = job.nextRunAt {
                    Text("Next: \(formatDateTime(nextRun))")
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                } else if !job.isActive {
                    Text("Inactive")
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                }
            }

            Text(job.prompt)
                .font(.system(size: 12))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .lineLimit(2)

            if let cron = job.cronExpression {
                Text(cronDescription(cron))
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.accentPurple(colorScheme))
            } else if let runAt = job.runAt {
                Text("One-time: \(formatDateTime(runAt))")
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.accentPurple(colorScheme))
            }

            HStack(spacing: 10) {
                Button("Edit")     { startEditingJob(job) }
                    .buttonStyle(.bordered).font(.system(size: 12))

                Button("Run Now")  { runJobNow(job) }
                    .buttonStyle(.bordered).font(.system(size: 12))
                    .disabled(isLoading)

                Button(job.isActive ? "Deactivate" : "Activate") { toggleActive(job) }
                    .buttonStyle(.bordered).font(.system(size: 12))
                    .disabled(isLoading)

                if job.lastRunAt != nil || job.lastRunSessionId != nil {
                    Button {
                        openRunHistory(for: job)
                    } label: {
                        Label("Last Run", systemImage: "clock.arrow.circlepath")
                            .font(.system(size: 12))
                    }
                    .buttonStyle(.bordered)
                    .tint(NordTheme.accentPurple(colorScheme))
                }

                Spacer()

                Button("Delete") { deleteJob(job) }
                    .buttonStyle(.bordered).font(.system(size: 12))
                    .foregroundColor(.red)
                    .disabled(isLoading)
            }
        }
        .padding(12)
        .background(NordTheme.panelBackground(colorScheme))
        .cornerRadius(8)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(NordTheme.border(colorScheme), lineWidth: 1))
    }

    // MARK: - Edit Panel

    private var editPanel: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(editingJobId == nil ? "Add New Job" : "Edit Job")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(NordTheme.primaryText(colorScheme))

            // Label
            VStack(alignment: .leading, spacing: 4) {
                fieldLabel("Label")
                TextField("e.g. Daily Standup Summary", text: $labelInput)
                    .textFieldStyle(.roundedBorder)
            }

            // Prompt
            VStack(alignment: .leading, spacing: 4) {
                fieldLabel("Prompt")
                TextEditor(text: $promptInput)
                    .font(.system(size: 13))
                    .frame(height: 100)
                    .padding(6)
                    .background(NordTheme.editorBackground(colorScheme))
                    .cornerRadius(6)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(NordTheme.border(colorScheme), lineWidth: 1))
            }

            // Schedule type toggle
            VStack(alignment: .leading, spacing: 8) {
                fieldLabel("Schedule Type")
                HStack(spacing: 20) {
                    scheduleTypeButton(title: "Recurring",  type: .recurring)
                    scheduleTypeButton(title: "One-time",   type: .oneTime)
                }
            }

            // Schedule inputs
            if scheduleType == .recurring {
                recurringScheduleSection
            } else {
                oneTimeScheduleSection
            }

            // Save / Cancel
            HStack(spacing: 12) {
                Button("Cancel") { cancelEditing() }
                    .buttonStyle(.bordered)

                Button("Save Job") { saveJob() }
                    .buttonStyle(.borderedProminent)
                    .tint(NordTheme.accent(colorScheme))
                    .disabled(
                        labelInput.trimmingCharacters(in: .whitespaces).isEmpty ||
                        promptInput.trimmingCharacters(in: .whitespaces).isEmpty ||
                        (scheduleType == .recurring && recurringDays.isEmpty) ||
                        isLoading
                    )
            }
        }
    }

    // MARK: - Recurring schedule section

    private var recurringScheduleSection: some View {
        VStack(alignment: .leading, spacing: 12) {

            // Time picker
            HStack(spacing: 12) {
                fieldLabel("Time")
                    .frame(width: 36, alignment: .leading)
                DatePicker("", selection: $recurringTime, displayedComponents: .hourAndMinute)
                    .labelsHidden()
                Spacer()
            }

            Divider()

            // Day-of-week chips
            VStack(alignment: .leading, spacing: 8) {
                fieldLabel("Days")

                HStack(spacing: 6) {
                    ForEach(weekdayOptions.indices, id: \.self) { i in
                        dayChip(label: weekdayOptions[i].label, value: weekdayOptions[i].value)
                    }
                }

                // Quick-select presets
                HStack(spacing: 6) {
                    presetButton(label: "Weekdays",   days: [1, 2, 3, 4, 5])
                    presetButton(label: "Every day",  days: [0, 1, 2, 3, 4, 5, 6])
                    presetButton(label: "Weekends",   days: [0, 6])
                }
            }

            // Human-readable preview
            if !recurringDays.isEmpty {
                Text(cronDescription(computedCron))
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.accentPurple(colorScheme))
            } else {
                Text("Select at least one day.")
                    .font(.system(size: 11))
                    .foregroundColor(.red.opacity(0.8))
            }
        }
        .padding(14)
        .background(NordTheme.panelBackground(colorScheme))
        .cornerRadius(8)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(NordTheme.border(colorScheme), lineWidth: 1))
    }

    private func dayChip(label: String, value: Int) -> some View {
        let selected = recurringDays.contains(value)
        return Button {
            if recurringDays.contains(value) { recurringDays.remove(value) }
            else { recurringDays.insert(value) }
        } label: {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 38, height: 30)
                .foregroundColor(selected ? .white : NordTheme.primaryText(colorScheme))
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(selected ? NordTheme.accent(colorScheme) : Color.clear)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(
                            selected ? NordTheme.accent(colorScheme) : NordTheme.border(colorScheme),
                            lineWidth: 1
                        )
                )
        )
    }

    private func presetButton(label: String, days: [Int]) -> some View {
        Button(label) { recurringDays = Set(days) }
            .buttonStyle(.bordered)
            .font(.system(size: 11))
            .tint(NordTheme.accentPurple(colorScheme))
    }

    // MARK: - One-time schedule section

    private var oneTimeScheduleSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel("Date & Time")
            DatePicker("", selection: $runAtDate, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                .labelsHidden()
        }
        .padding(14)
        .background(NordTheme.panelBackground(colorScheme))
        .cornerRadius(8)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(NordTheme.border(colorScheme), lineWidth: 1))
    }

    // MARK: - Small reusable helpers

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(NordTheme.secondaryText(colorScheme))
    }

    private func scheduleTypeButton(title: String, type: ScheduleType) -> some View {
        HStack(spacing: 6) {
            Image(systemName: scheduleType == type ? "largecircle.fill.circle" : "circle")
                .foregroundColor(NordTheme.accent(colorScheme))
            Text(title)
                .font(.system(size: 13))
                .foregroundColor(NordTheme.primaryText(colorScheme))
        }
        .onTapGesture { scheduleType = type }
    }

    // MARK: - Cron helpers

    // Produce a human-readable description of a cron expression.
    private func cronDescription(_ cron: String) -> String {
        let parts = cron.split(separator: " ").map(String.init)
        guard parts.count == 5,
              let minute = Int(parts[0]),
              let hour   = Int(parts[1]) else { return cron }

        let time    = formatTime(hour: hour, minute: minute)
        let daysStr = parts[4]

        switch daysStr {
        case "*":        return "Every day at \(time)"
        case "1-5":      return "Weekdays at \(time)"
        case "0,6", "6,0": return "Weekends at \(time)"
        default:
            let dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
            let nums = daysStr.split(separator: ",").compactMap { Int($0) }.filter { $0 >= 0 && $0 <= 6 }
            if nums.count == 1 {
                return "Every \(dayNames[nums[0]]) at \(time)"
            }
            if !nums.isEmpty {
                let names = nums
                    .sorted { ($0 == 0 ? 7 : $0) < ($1 == 0 ? 7 : $1) }
                    .map { dayNames[$0] }
                    .joined(separator: ", ")
                return "\(names) at \(time)"
            }
            return cron
        }
    }

    private func formatTime(hour: Int, minute: Int) -> String {
        let h = hour == 0 ? 12 : (hour > 12 ? hour - 12 : hour)
        let ampm = hour < 12 ? "AM" : "PM"
        return "\(h):\(String(format: "%02d", minute)) \(ampm)"
    }

    private func formatDateTime(_ raw: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fallbackParser = ISO8601DateFormatter()

        let date = parser.date(from: raw) ?? fallbackParser.date(from: raw)
        guard let date else { return raw }

        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.timeZone = .current
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    // Populate picker state from an existing cron string when editing a job.
    private func parseCronToState(_ cron: String) {
        let parts = cron.split(separator: " ").map(String.init)
        guard parts.count == 5,
              let minute = Int(parts[0]),
              let hour   = Int(parts[1]) else {
            setRecurringTime(hour: 9, minute: 0)
            recurringDays = [1, 2, 3, 4, 5]
            return
        }
        setRecurringTime(hour: hour, minute: minute)

        let daysStr = parts[4]
        if daysStr == "*" {
            recurringDays = Set(0...6)
        } else if daysStr.contains("-") {
            let r = daysStr.split(separator: "-").compactMap { Int($0) }
            recurringDays = r.count == 2 ? Set(r[0]...r[1]) : [1, 2, 3, 4, 5]
        } else {
            recurringDays = Set(daysStr.split(separator: ",").compactMap { Int($0) })
        }
    }

    private func setRecurringTime(hour: Int, minute: Int) {
        var c = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        c.hour = hour
        c.minute = minute
        if let d = Calendar.current.date(from: c) {
            recurringTime = d
        }
    }

    // MARK: - Actions

    private func loadJobs() {
        isLoading = true
        apiClient.fetchScheduledJobs { result in
            DispatchQueue.main.async {
                self.isLoading = false
                switch result {
                case .success(let fetched): self.jobs = fetched
                case .failure(let err):    self.statusMessage = "Error: \(err.localizedDescription)"
                }
            }
        }
    }

    private func refreshJobs() {
        statusMessage = ""
        loadJobs()
    }

    private func openRunHistory(for job: APIClient.ScheduledJobDTO) {
        statusMessage = "Preparing session history..."
        ensureAuthenticated { success in
            guard success else {
                self.statusMessage = "Could not authenticate to load run history."
                return
            }
            self.resolveHistorySessionAndOpen(for: job)
        }
    }

    private func ensureAuthenticated(completion: @escaping (Bool) -> Void) {
        if let token = SubscriptionManager.shared.jwtToken, !token.isEmpty {
            completion(true)
            return
        }

        SubscriptionManager.shared.activateStoredKey { success in
            DispatchQueue.main.async {
                completion(success)
            }
        }
    }

    private func resolveHistorySessionAndOpen(for job: APIClient.ScheduledJobDTO) {
        if let sid = job.lastRunSessionId?.trimmingCharacters(in: .whitespacesAndNewlines), !sid.isEmpty {
            presentRunHistory(jobLabel: job.label, sessionId: sid)
            return
        }

        // Refresh jobs to avoid stale session IDs right after app startup.
        apiClient.fetchScheduledJobs { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let fetched):
                    self.jobs = fetched
                    if let refreshed = fetched.first(where: { $0.id == job.id }),
                       let sid = refreshed.lastRunSessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !sid.isEmpty
                    {
                        self.presentRunHistory(jobLabel: refreshed.label, sessionId: sid)
                    } else {
                        self.statusMessage = "Session history is not ready yet. Please try again in a moment."
                    }
                case .failure(let err):
                    self.statusMessage = "Error: \(err.localizedDescription)"
                }
            }
        }
    }

    private func presentRunHistory(jobLabel: String, sessionId: String) {
        statusMessage = ""
        historyJobLabel = jobLabel
        historySessionId = sessionId
        showingRunHistory = true
    }

    private func startAddingJob() {
        editingJobId = nil
        labelInput = ""
        promptInput = ""
        scheduleType = .recurring
        setRecurringTime(hour: 9, minute: 0)
        recurringDays = [1, 2, 3, 4, 5]
        runAtDate = Date().addingTimeInterval(3_600)
        isEditing = true
    }

    private func startEditingJob(_ job: APIClient.ScheduledJobDTO) {
        editingJobId = job.id
        labelInput   = job.label
        promptInput  = job.prompt
        if let cron = job.cronExpression {
            scheduleType = .recurring
            parseCronToState(cron)
        } else {
            scheduleType = .oneTime
            if let runAtStr = job.runAt, let d = ISO8601DateFormatter().date(from: runAtStr) {
                runAtDate = d
            }
        }
        isEditing = true
    }

    private func cancelEditing() {
        isEditing = false
        statusMessage = ""
    }

    private func saveJob() {
        isLoading = true
        statusMessage = ""

        let label          = labelInput.trimmingCharacters(in: .whitespaces)
        let prompt         = promptInput.trimmingCharacters(in: .whitespaces)
        let cronExpression = scheduleType == .recurring ? computedCron : nil
        let runAt          = scheduleType == .oneTime ? ISO8601DateFormatter().string(from: runAtDate) : nil

        if let jobId = editingJobId {
            apiClient.updateScheduledJob(id: jobId, label: label, prompt: prompt,
                                         cronExpression: cronExpression, runAt: runAt) { result in
                DispatchQueue.main.async {
                    self.isLoading = false
                    switch result {
                    case .success:
                        self.isEditing = false
                        self.loadJobs()
                        self.statusMessage = "Job updated."
                    case .failure(let err):
                        self.statusMessage = "Error: \(err.localizedDescription)"
                    }
                }
            }
        } else {
            apiClient.createScheduledJob(label: label, prompt: prompt,
                                         cronExpression: cronExpression, runAt: runAt) { result in
                DispatchQueue.main.async {
                    self.isLoading = false
                    switch result {
                    case .success:
                        self.isEditing = false
                        self.loadJobs()
                        self.statusMessage = "Job created."
                    case .failure(let err):
                        self.statusMessage = "Error: \(err.localizedDescription)"
                    }
                }
            }
        }
    }

    private func deleteJob(_ job: APIClient.ScheduledJobDTO) {
        isLoading = true
        apiClient.deleteScheduledJob(id: job.id) { result in
            DispatchQueue.main.async {
                self.isLoading = false
                switch result {
                case .success:
                    self.jobs.removeAll { $0.id == job.id }
                    self.statusMessage = "Job deleted."
                case .failure(let err):
                    self.statusMessage = "Error: \(err.localizedDescription)"
                }
            }
        }
    }

    private func runJobNow(_ job: APIClient.ScheduledJobDTO) {
        isLoading = true
        apiClient.runScheduledJobNow(id: job.id) { result in
            DispatchQueue.main.async {
                self.isLoading = false
                switch result {
                case .success:
                    self.runningJobIds.insert(job.id)
                    self.preRunLastRunAt[job.id] = job.lastRunAt
                    self.statusMessage = "\"\(job.label)\" triggered."
                    self.startPolling()
                case .failure(let err):
                    self.statusMessage = "Error: \(err.localizedDescription)"
                }
            }
        }
    }

    private func startPolling() {
        guard pollTimer == nil else { return }
        pulseRunning = true
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { _ in
            DispatchQueue.main.async { self.pollForCompletion() }
        }
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
        pulseRunning = false
    }

    private func pollForCompletion() {
        apiClient.fetchScheduledJobs { result in
            DispatchQueue.main.async {
                guard case .success(let fetched) = result else { return }
                self.jobs = fetched
                var stillRunning: Set<String> = []
                for id in self.runningJobIds {
                    let snapshot = self.preRunLastRunAt[id]
                    let current = fetched.first(where: { $0.id == id })?.lastRunAt
                    if current == snapshot {
                        stillRunning.insert(id)
                    }
                }
                self.runningJobIds = stillRunning
                self.preRunLastRunAt = self.preRunLastRunAt.filter { stillRunning.contains($0.key) }
                if stillRunning.isEmpty { self.stopPolling() }
            }
        }
    }

    private func toggleActive(_ job: APIClient.ScheduledJobDTO) {
        isLoading = true
        apiClient.updateScheduledJob(id: job.id, label: job.label, prompt: job.prompt,
                                     cronExpression: job.cronExpression, runAt: job.runAt,
                                     isActive: !job.isActive) { result in
            DispatchQueue.main.async {
                self.isLoading = false
                switch result {
                case .success:          self.loadJobs()
                case .failure(let err): self.statusMessage = "Error: \(err.localizedDescription)"
                }
            }
        }
    }
}
