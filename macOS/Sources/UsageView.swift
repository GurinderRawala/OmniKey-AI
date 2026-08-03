import Foundation
import SwiftUI

/// Canonical list of AI providers OmniKey supports. Keys must match the
/// server-side provider identifiers used by `AIProviderDTO` and the usage
/// metrics API so filtering works even before any calls have been recorded
/// for a provider. Keep in sync with `ProviderKind` in `SettingsView.swift`.
private let usageSupportedProviders: [(key: String, label: String)] = [
    ("openai", "OpenAI"),
    ("anthropic", "Anthropic (Claude)"),
    ("gemini", "Google Gemini"),
    ("nemotron", "Open Model"),
]

private enum UsageRangeOption: String, CaseIterable, Identifiable {
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case thisMonth = "month"
    case ninetyDays = "90d"
    case allTime = "all"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .sevenDays: return "7d"
        case .thirtyDays: return "30d"
        case .thisMonth: return "Month"
        case .ninetyDays: return "90d"
        case .allTime: return "All"
        }
    }
}

/// Token-only usage dashboard. Cost estimates and the price override were
/// removed deliberately: the pricing figures the API returns are estimates
/// that cannot be reconciled with provider invoices, so the tab now reports
/// just the four token metrics we can state accurately.
struct UsageView: View {
    @Environment(\.colorScheme) private var colorScheme

    @State private var selectedRange: UsageRangeOption = .thirtyDays
    @AppStorage("UsageSelectedProvider") private var selectedProvider: String = "all"
    @State private var metrics: APIClient.UsageMetricsResponse? = nil
    @State private var isLoading: Bool = false
    @State private var statusMessage: String = ""

    private let apiClient = APIClient()

    /// Metric cards stretch to fill the available width and wrap onto extra
    /// rows on narrow windows instead of being pinned to a fixed column count.
    private var summaryColumns: [GridItem] {
        [GridItem(.adaptive(minimum: 200), spacing: 12)]
    }

    private var sectionColumns: [GridItem] {
        [
            GridItem(.flexible(minimum: 300), spacing: 14),
            GridItem(.flexible(minimum: 300), spacing: 14),
        ]
    }

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.horizontal, 24)
                    .padding(.top, 20)
                    .padding(.bottom, 16)

                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(height: 1)

                ScrollView {
                    content
                        .padding(.horizontal, 24)
                        .padding(.top, 16)
                        .padding(.bottom, 12)
                }

                if !statusMessage.isEmpty {
                    Text(statusMessage)
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .padding(.horizontal, 24)
                        .padding(.bottom, 12)
                }
            }
        }
        .onAppear { loadMetrics() }
        .onChange(of: selectedRange) { _, _ in loadMetrics() }
        .onChange(of: selectedProvider) { _, _ in loadMetrics() }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "chart.xyaxis.line")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(NordTheme.accent(colorScheme))

                VStack(alignment: .leading, spacing: 2) {
                    Text("Usage")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                    Text("Token usage across your recorded AI calls.")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                }

                Spacer()

                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                }

                Button(action: loadMetrics) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                        .font(.system(size: 13, weight: .medium))
                }
                .buttonStyle(.bordered)
                .tint(NordTheme.accentBlue(colorScheme))
                .disabled(isLoading)
            }

            controlsBar
        }
    }

    private var controlsBar: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .bottom, spacing: 12) {
                rangePicker
                providerPicker
                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: 8) {
                rangePicker
                providerPicker
            }
        }
    }

    private var rangePicker: some View {
        Picker("", selection: $selectedRange) {
            ForEach(UsageRangeOption.allCases) { option in
                Text(option.label).tag(option)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 340)
        .disabled(isLoading)
    }

    private var providerPicker: some View {
        Picker("", selection: $selectedProvider) {
            Text("All Providers").tag("all")
            ForEach(usageSupportedProviders, id: \.key) { provider in
                Text(provider.label).tag(provider.key)
            }
        }
        .frame(width: 190)
        .labelsHidden()
        .disabled(isLoading)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if isLoading && metrics == nil {
            loadingState
        } else if let metrics {
            dashboard(metrics)
        } else {
            emptyState
        }
    }

    private var loadingState: some View {
        HStack {
            Spacer()
            ProgressView()
                .padding(.top, 36)
            Spacer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "chart.bar.doc.horizontal")
                .font(.system(size: 36))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .padding(.top, 32)
            Text("No usage metrics loaded.")
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(NordTheme.primaryText(colorScheme))
            Text(statusMessage.isEmpty ? "Refresh to load usage data." : statusMessage)
                .font(.system(size: 13))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
        }
        .frame(maxWidth: .infinity)
    }

    private func dashboard(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if !metrics.recordingEnabled {
                statusBanner(
                    icon: "pause.circle.fill",
                    title: "Usage recording is off",
                    message: "Historical rows are shown if available. New detailed token rows will start after usage recording is enabled in Agent Access.",
                    tint: NordTheme.accentAmber(colorScheme)
                )
            }

            if metrics.totals.requests == 0 {
                statusBanner(
                    icon: "chart.bar.xaxis",
                    title: "No calls in \(metrics.range.label.lowercased())",
                    message: "Switch ranges to inspect older usage, or enable recording before the next AI call.",
                    tint: NordTheme.accentBlue(colorScheme)
                )
            }

            summaryGrid(metrics)

            ViewThatFits(in: .horizontal) {
                VStack(alignment: .leading, spacing: 14) {
                    dailyTokenTrend(metrics)

                    LazyVGrid(columns: sectionColumns, alignment: .leading, spacing: 14) {
                        modelTokenBreakdown(metrics)
                        recentSessions(metrics)
                    }
                }

                VStack(alignment: .leading, spacing: 14) {
                    dailyTokenTrend(metrics)
                    modelTokenBreakdown(metrics)
                    recentSessions(metrics)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The token metrics reported for the selected range: total tokens plus
    /// the input/output split.
    private func summaryGrid(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        LazyVGrid(columns: summaryColumns, alignment: .leading, spacing: 12) {
            metricCard(
                icon: "sum",
                title: "Total Tokens Used",
                value: formatTokens(metrics.totals.totalTokens),
                subtitle: "\(metrics.totals.requests) call\(metrics.totals.requests == 1 ? "" : "s") in \(metrics.range.label.lowercased())",
                tint: NordTheme.accent(colorScheme)
            )

            metricCard(
                icon: "arrow.down.circle",
                title: "Input Tokens Used",
                value: formatTokens(metrics.totals.promptTokens),
                subtitle: tokenShareSubtitle(metrics.totals.promptTokens, of: metrics.totals.totalTokens),
                tint: NordTheme.accentGreen(colorScheme)
            )

            metricCard(
                icon: "arrow.up.circle",
                title: "Output Tokens Used",
                value: formatTokens(metrics.totals.completionTokens),
                subtitle: tokenShareSubtitle(metrics.totals.completionTokens, of: metrics.totals.totalTokens),
                tint: NordTheme.accentPurple(colorScheme)
            )
        }
    }

    // MARK: - Sections

    private func dailyTokenTrend(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        let buckets = Array(metrics.daily.suffix(32))
        let hasTokens = buckets.contains { $0.totalTokens > 0 }

        return sectionContainer(
            title: "Daily Token Split",
            subtitle: "Input and output tokens per day.",
            icon: "chart.bar.xaxis",
            minHeight: 210
        ) {
            if buckets.isEmpty || !hasTokens {
                miniEmpty("No daily token data in this range.")
            } else {
                trendBars(buckets)

                HStack(spacing: 14) {
                    legendDot("Input", color: NordTheme.accentBlue(colorScheme))
                    legendDot("Output", color: NordTheme.accentGreen(colorScheme))
                    Spacer()
                }
            }
        }
    }

    private func modelTokenBreakdown(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        let buckets = Array(metrics.byModel.prefix(8))
        let maxTokens = buckets.map(\.totalTokens).max() ?? 0

        return sectionContainer(
            title: "Tokens by Model",
            subtitle: "Recorded tokens grouped by model.",
            icon: "cpu",
            minHeight: 230
        ) {
            if buckets.isEmpty {
                miniEmpty("No model token data in this range.")
            } else {
                ForEach(Array(buckets.enumerated()), id: \.element.id) { index, bucket in
                    meterRow(bucket, maxTokens: maxTokens, accent: modeAccent(index))
                }
            }
        }
    }

    private func recentSessions(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        sectionContainer(
            title: "Recent Sessions",
            subtitle: "Last five sessions with recorded tokens.",
            icon: "text.bubble",
            minHeight: 230
        ) {
            if metrics.recentSessions.isEmpty {
                miniEmpty("No session token totals in this range.")
            } else {
                ForEach(metrics.recentSessions.prefix(5)) { session in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(session.title.isEmpty ? "Untitled Session" : session.title)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(NordTheme.primaryText(colorScheme))
                                .lineLimit(1)
                            Spacer()
                            Text(formatTokens(session.totalTokens))
                                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                                .foregroundColor(NordTheme.primaryText(colorScheme))
                                .lineLimit(1)
                        }

                        Text("\(session.turns) turn\(session.turns == 1 ? "" : "s")  |  \(shortDate(session.lastActiveAt))")
                            .font(.system(size: 11))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                            .lineLimit(1)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    // MARK: - Reusable UI

    private func statusBanner(icon: String, title: String, message: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(tint)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                Text(message)
                    .font(.system(size: 12))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()
        }
        .padding(12)
        .background(NordTheme.sectionFill(accent: tint, scheme: colorScheme))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(NordTheme.sectionBorder(accent: tint, scheme: colorScheme), lineWidth: 1)
        )
    }

    private func metricCard(icon: String, title: String, value: String, subtitle: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(tint)
                    .frame(width: 16)
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .lineLimit(1)
                Spacer()
            }

            Text(value)
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                .foregroundColor(NordTheme.primaryText(colorScheme))
                .lineLimit(1)
                .minimumScaleFactor(0.78)

            Text(subtitle)
                .font(.system(size: 11))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
        .background(NordTheme.panelBackground(colorScheme))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(NordTheme.border(colorScheme), lineWidth: 1)
        )
    }

    private func sectionContainer<Content: View>(
        title: String,
        subtitle: String,
        icon: String,
        minHeight: CGFloat = 150,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(NordTheme.accent(colorScheme))
                    .frame(width: 16)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()
            }

            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
        .background(NordTheme.panelBackground(colorScheme))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(NordTheme.border(colorScheme), lineWidth: 1)
        )
    }

    private func miniEmpty(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundColor(NordTheme.secondaryText(colorScheme))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 2)
    }

    private func meterRow(_ bucket: APIClient.UsageBucketDTO, maxTokens: Int, accent: Color) -> some View {
        let fraction = maxTokens > 0 ? CGFloat(bucket.totalTokens) / CGFloat(maxTokens) : 0

        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(bucket.label)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Text(formatTokens(bucket.totalTokens))
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                    .lineLimit(1)
            }

            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(NordTheme.badgeFill(colorScheme))
                    .frame(height: 8)
                GeometryReader { proxy in
                    RoundedRectangle(cornerRadius: 4)
                        .fill(accent)
                        .frame(width: max(4, proxy.size.width * fraction), height: 8)
                }
                .frame(height: 8)
            }

            Text("\(bucket.requests) call\(bucket.requests == 1 ? "" : "s")  |  input \(formatTokens(bucket.promptTokens)), output \(formatTokens(bucket.completionTokens))")
                .font(.system(size: 11))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .lineLimit(1)
        }
        .padding(.vertical, 2)
    }

    private func trendBars(_ buckets: [APIClient.UsageBucketDTO]) -> some View {
        let maxTokens = buckets.map(\.totalTokens).max() ?? 0

        return HStack(alignment: .bottom, spacing: 4) {
            ForEach(buckets) { bucket in
                let inputHeight = barHeight(bucket.promptTokens, maxTokens: maxTokens)
                let outputHeight = barHeight(bucket.completionTokens, maxTokens: maxTokens)

                VStack(spacing: 3) {
                    Spacer(minLength: 0)
                    VStack(spacing: 1) {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(NordTheme.accentGreen(colorScheme))
                            .frame(height: outputHeight)
                        RoundedRectangle(cornerRadius: 3)
                            .fill(NordTheme.accentBlue(colorScheme))
                            .frame(height: inputHeight)
                    }
                    .frame(maxWidth: .infinity)

                    Text(String(bucket.key.suffix(2)))
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .frame(height: 10)
                }
            }
        }
        .frame(height: 116)
    }

    private func legendDot(_ label: String, color: Color) -> some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(label)
                .font(.system(size: 11))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
        }
    }

    // MARK: - Data Loading

    private func loadMetrics() {
        isLoading = true
        statusMessage = ""

        apiClient.fetchUsageMetrics(
            range: selectedRange.rawValue,
            provider: selectedProvider
        ) { result in
            DispatchQueue.main.async {
                isLoading = false
                switch result {
                case .success(let response):
                    metrics = response
                    statusMessage = "Updated \(shortDateTime(response.generatedAt))"
                case .failure(let error):
                    statusMessage = "Failed to load usage metrics: \(error.localizedDescription)"
                }
            }
        }
    }

    // MARK: - Formatting

    private func modeAccent(_ index: Int) -> Color {
        let accents = [
            NordTheme.accent(colorScheme),
            NordTheme.accentGreen(colorScheme),
            NordTheme.accentAmber(colorScheme),
            NordTheme.accentPurple(colorScheme),
            NordTheme.accentBlue(colorScheme),
        ]
        return accents[index % accents.count]
    }

    private func formatTokens(_ tokens: Int) -> String {
        let value = Double(tokens)
        if value >= 1_000_000 {
            return String(format: "%.1fM", value / 1_000_000)
        }
        if value >= 10_000 {
            return String(format: "%.0fK", value / 1_000)
        }
        if value >= 1_000 {
            return String(format: "%.1fK", value / 1_000)
        }

        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: tokens)) ?? "\(tokens)"
    }

    private func formatTokens(_ tokens: Double) -> String {
        formatTokens(Int(tokens.rounded()))
    }

    /// Share of the range total, guarding against the divide-by-zero that
    /// happens whenever the selected range has no recorded calls.
    private func tokenShareSubtitle(_ tokens: Int, of total: Int) -> String {
        guard total > 0 else { return "No tokens recorded in range" }
        return "\(formatPercent(Double(tokens) / Double(total))) of range tokens"
    }

    private func formatPercent(_ ratio: Double) -> String {
        String(format: "%.0f%%", ratio * 100)
    }

    private func barHeight(_ tokens: Int, maxTokens: Int) -> CGFloat {
        guard maxTokens > 0, tokens > 0 else { return 2 }
        return max(4, CGFloat(tokens) / CGFloat(maxTokens) * 86)
    }

    private func shortDateTime(_ value: String) -> String {
        if value.count >= 16 {
            let date = value.prefix(10)
            let time = value.dropFirst(11).prefix(5)
            return "\(date) \(time)"
        }
        return value
    }

    private func shortDate(_ value: String) -> String {
        if value.count >= 10 {
            return String(value.prefix(10))
        }
        return value
    }
}
