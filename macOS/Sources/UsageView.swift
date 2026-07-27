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
    ("nemotron", "NVIDIA Nemotron"),
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

struct UsageView: View {
    @Environment(\.colorScheme) private var colorScheme

    @State private var selectedRange: UsageRangeOption = .thirtyDays
    @AppStorage("UsageSelectedProvider") private var selectedProvider: String = "all"
    @AppStorage("UsageCustomPricePerMillionTokensText") private var customPricePerMillionTokensText: String = ""
    @State private var metrics: APIClient.UsageMetricsResponse? = nil
    @State private var isLoading: Bool = false
    @State private var statusMessage: String = ""

    private let apiClient = APIClient()

    private var summaryColumns: [GridItem] {
        Array(
            repeating: GridItem(.flexible(minimum: 180), spacing: 12),
            count: 3
        )
    }

    private var sectionColumns: [GridItem] {
        [
            GridItem(.flexible(minimum: 280), spacing: 14),
            GridItem(.flexible(minimum: 280), spacing: 14),
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
                    Text("Token spend, mode mix, and cost estimates.")
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
        // All three filters share the same label‐above‐control column so
        // their bottoms line up in the wide layout and their top edges align
        // with the field-label baseline used elsewhere in Settings
        // (see `fieldLabel` in ScheduledJobsView / MCPServersView).
        //
        // Each control has its own native chrome inset (segmented picker
        // borders, popup button borders, rounded-border text field padding),
        // so the readable content inside each input sits a few points right
        // of the frame origin. We compensate on the *label* side with a
        // per-control `labelIndent` so labels visually line up with the
        // input content rather than the raw frame edge.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .bottom, spacing: 12) {
                controlGroup("Time range", labelIndent: 2) { rangePicker }
                controlGroup("Provider", labelIndent: 6) { providerPicker }
                controlGroup("Price override", labelIndent: 4) { priceOverrideField }
                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: 8) {
                controlGroup("Time range", labelIndent: 2) { rangePicker }
                HStack(alignment: .bottom, spacing: 12) {
                    controlGroup("Provider", labelIndent: 6) { providerPicker }
                    controlGroup("Price override", labelIndent: 4) { priceOverrideField }
                }
            }
        }
    }

    /// Field-label + control column. Matches the `fieldLabel` typography used
    /// elsewhere in the app (12 pt medium, secondary text) so the Usage tab
    /// visually agrees with Scheduled Jobs, MCP Servers, and Agent Access
    /// settings.
    ///
    /// - Parameter labelIndent: Small leading offset applied to the label so
    ///   it aligns with the visible content of the wrapped native control
    ///   (which sits inside its own border chrome). Defaults to `0`.
    private func controlGroup<Content: View>(
        _ title: String,
        labelIndent: CGFloat = 0,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .padding(.leading, labelIndent)
            content()
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

    private var priceOverrideField: some View {
        HStack(spacing: 6) {
            TextField("USD / 1M tokens", text: $customPricePerMillionTokensText)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12, design: .monospaced))
                .frame(width: 130)
                .onSubmit { loadMetrics() }
                .disabled(isLoading)

            Button(action: loadMetrics) {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.bordered)
            .frame(width: 28)
            .help("Apply custom price")
            .disabled(isLoading || hasInvalidCustomPrice)

            if !customPricePerMillionTokensText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(action: clearCustomPrice) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                }
                .buttonStyle(.bordered)
                .frame(width: 28)
                .help("Use default model prices")
                .disabled(isLoading)
            }
        }
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
                    dailyTrend(metrics)

                    LazyVGrid(columns: sectionColumns, alignment: .leading, spacing: 14) {
                        modeBreakdown(metrics)
                        modelCosts(metrics)
                        providerBreakdown(metrics)
                        peakHours(metrics)
                        mostUsedFeatures(metrics)
                        efficiencyTrend(metrics)
                        projectionDetails(metrics)
                        topThreads(metrics)
                    }
                }

                VStack(alignment: .leading, spacing: 14) {
                    dailyTrend(metrics)
                    modeBreakdown(metrics)
                    modelCosts(metrics)
                    providerBreakdown(metrics)
                    peakHours(metrics)
                    mostUsedFeatures(metrics)
                    efficiencyTrend(metrics)
                    projectionDetails(metrics)
                    topThreads(metrics)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func summaryGrid(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        LazyVGrid(columns: summaryColumns, alignment: .leading, spacing: 12) {
            metricCard(
                icon: "sum",
                title: "Tokens To Date",
                value: formatTokens(metrics.allTimeTotals.totalTokens),
                subtitle: "\(metrics.allTimeTotals.requests) recorded calls",
                tint: NordTheme.accent(colorScheme)
            )

            metricCard(
                icon: "calendar",
                title: "Range Tokens",
                value: formatTokens(metrics.totals.totalTokens),
                subtitle: tokenDeltaText(metrics.comparison),
                tint: deltaTint(metrics.comparison)
            )

            metricCard(
                icon: "dollarsign.circle",
                title: "Range Cost",
                value: formatCurrency(metrics.totals.costUsd),
                subtitle: costDeltaText(metrics.comparison, metrics: metrics),
                tint: NordTheme.accentGreen(colorScheme)
            )

            metricCard(
                icon: "calendar.badge.clock",
                title: "Month Estimate",
                value: formatCurrency(metrics.estimates.projectedEndOfMonthCostUsd),
                subtitle: "\(formatCurrency(metrics.estimates.monthToDateAverageDailyCostUsd)) MTD daily avg",
                tint: NordTheme.accentPurple(colorScheme)
            )

            metricCard(
                icon: "chart.bar",
                title: "Daily Average",
                value: formatTokens(metrics.estimates.averageDailyTokens),
                subtitle: "\(metrics.range.days) day\(metrics.range.days == 1 ? "" : "s") counted",
                tint: NordTheme.accentBlue(colorScheme)
            )

            metricCard(
                icon: "bubble.left.and.bubble.right",
                title: "Avg Per Thread",
                value: formatTokens(metrics.threads.averageTokensPerThread),
                subtitle: "\(metrics.threads.distinctThreads) thread\(metrics.threads.distinctThreads == 1 ? "" : "s") in range",
                tint: NordTheme.accentAmber(colorScheme)
            )
        }
    }

    // MARK: - Sections

    private func modeBreakdown(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        let buckets = Array(metrics.byMode.prefix(8))
        let maxTokens = buckets.map(\.totalTokens).max() ?? 0

        return sectionContainer(
            title: "Usage by Mode",
            subtitle: "Token and cost mix for \(metrics.range.label.lowercased()).",
            icon: "square.grid.2x2",
            minHeight: 250
        ) {
            if buckets.isEmpty {
                miniEmpty("No mode data in this range.")
            } else {
                ForEach(Array(buckets.enumerated()), id: \.element.id) { index, bucket in
                    meterRow(bucket, maxTokens: maxTokens, accent: modeAccent(index))
                }
            }
        }
    }

    private func dailyTrend(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        sectionContainer(
            title: "Daily Trend",
            subtitle: "Total tokens per day with input/output split reflected below.",
            icon: "chart.bar.xaxis",
            minHeight: 210
        ) {
            if metrics.daily.isEmpty {
                miniEmpty("No daily trend data yet.")
            } else {
                trendBars(Array(metrics.daily.suffix(32)))

                HStack(spacing: 14) {
                    legendDot("Input", color: NordTheme.accentBlue(colorScheme))
                    legendDot("Output", color: NordTheme.accentGreen(colorScheme))
                    Spacer()
                }
            }
        }
    }

    private func modelCosts(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        let buckets = Array(metrics.byModel.prefix(6))
        let maxCost = buckets.map(\.costUsd).max() ?? 0

        return sectionContainer(
            title: "Cost by Model",
            subtitle: metrics.estimates.costAssumption,
            icon: "cpu",
            minHeight: 250
        ) {
            if buckets.isEmpty {
                miniEmpty("No model cost data in this range.")
            } else {
                ForEach(buckets) { bucket in
                    costRow(bucket, maxCost: maxCost)
                }
            }
        }
    }

    private func peakHours(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        sectionContainer(
            title: "Peak Hours",
            subtitle: "Busiest local hours by token spend.",
            icon: "clock",
            minHeight: 170
        ) {
            if metrics.peakHours.isEmpty {
                miniEmpty("No peak hours yet.")
            } else {
                ForEach(metrics.peakHours) { bucket in
                    compactStatRow(
                        label: bucket.label,
                        value: formatTokens(bucket.totalTokens),
                        detail: "\(bucket.requests) call\(bucket.requests == 1 ? "" : "s")"
                    )
                }
            }
        }
    }

    private func providerBreakdown(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        sectionContainer(
            title: "Providers",
            subtitle: selectedProvider == "all"
                ? "Current range by provider."
                : "Filtered to \(metrics.pricing.providerLabel).",
            icon: "server.rack",
            minHeight: 170
        ) {
            if metrics.byProvider.isEmpty {
                miniEmpty("No provider data in this range.")
            } else {
                ForEach(metrics.byProvider.prefix(5)) { bucket in
                    compactStatRow(
                        label: bucket.label,
                        value: formatCurrency(bucket.costUsd),
                        detail: "\(formatTokens(bucket.totalTokens)) across \(bucket.requests) call\(bucket.requests == 1 ? "" : "s")"
                    )
                }
            }
        }
    }

    private func mostUsedFeatures(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        sectionContainer(
            title: "Most Used Features",
            subtitle: "Ranked by request count.",
            icon: "bolt.horizontal",
            minHeight: 170
        ) {
            if metrics.mostUsedFeatures.isEmpty {
                miniEmpty("No feature usage in this range.")
            } else {
                ForEach(metrics.mostUsedFeatures) { bucket in
                    compactStatRow(
                        label: bucket.label,
                        value: "\(bucket.requests)",
                        detail: formatTokens(bucket.totalTokens)
                    )
                }
            }
        }
    }

    private func efficiencyTrend(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        let points = Array(metrics.efficiencyTrend.suffix(14))
        let latest = points.last

        return sectionContainer(
            title: "Efficiency",
            subtitle: "Average tokens per request and output share.",
            icon: "gauge.with.dots.needle.bottom.50percent",
            minHeight: 170
        ) {
            if points.isEmpty {
                miniEmpty("No efficiency samples yet.")
            } else {
                if let latest {
                    compactStatRow(
                        label: "Latest avg/request",
                        value: formatTokens(latest.averageTokensPerRequest),
                        detail: "\(formatPercent(latest.outputShare)) output"
                    )
                }

                efficiencyBars(points)
            }
        }
    }

    private func topThreads(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        sectionContainer(
            title: "Top Threads",
            subtitle: selectedProvider == "all" ? "Largest recorded threads to date." : "Provider-filtered thread totals.",
            icon: "text.bubble",
            minHeight: 190
        ) {
            if metrics.threads.topThreads.isEmpty {
                miniEmpty("No thread token totals yet.")
            } else {
                ForEach(metrics.threads.topThreads.prefix(5)) { thread in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(thread.title.isEmpty ? "Untitled Thread" : thread.title)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(NordTheme.primaryText(colorScheme))
                                .lineLimit(1)
                            Spacer()
                            Text(formatTokens(thread.totalTokens))
                                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                                .foregroundColor(NordTheme.primaryText(colorScheme))
                        }
                        Text("\(thread.turns) turn\(thread.turns == 1 ? "" : "s")  |  \(shortDate(thread.lastActiveAt))")
                            .font(.system(size: 11))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                            .lineLimit(1)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    private func projectionDetails(_ metrics: APIClient.UsageMetricsResponse) -> some View {
        sectionContainer(
            title: "Projection",
            subtitle: "Month-end estimate from month-to-date run rate.",
            icon: "calendar.badge.exclamationmark",
            minHeight: 190
        ) {
            compactStatRow(
                label: "Month-to-date cost",
                value: formatCurrency(metrics.estimates.monthToDateCostUsd),
                detail: "\(formatTokens(metrics.estimates.monthToDateTokens)) tokens"
            )
            compactStatRow(
                label: "Elapsed days",
                value: "\(metrics.estimates.monthElapsedDays)",
                detail: "\(formatCurrency(metrics.estimates.monthToDateAverageDailyCostUsd)) average daily cost"
            )
            compactStatRow(
                label: "Projected month end",
                value: formatCurrency(metrics.estimates.projectedEndOfMonthCostUsd),
                detail: metrics.pricing.customPricePerMillionTokensUsd == nil ? "Default model prices" : "Custom price override"
            )
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
            HStack(alignment: .firstTextBaseline) {
                Text(bucket.label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                    .lineLimit(1)
                Spacer()
                Text("\(formatTokens(bucket.totalTokens))  |  \(formatCurrency(bucket.costUsd))")
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

            Text("\(bucket.requests) request\(bucket.requests == 1 ? "" : "s")")
                .font(.system(size: 11))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
        }
        .padding(.vertical, 2)
    }

    private func costRow(_ bucket: APIClient.UsageBucketDTO, maxCost: Double) -> some View {
        let fraction = maxCost > 0 ? CGFloat(bucket.costUsd / maxCost) : 0

        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(bucket.label)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                    .lineLimit(1)
                Spacer()
                Text(formatCurrency(bucket.costUsd))
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
            }

            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(NordTheme.badgeFill(colorScheme))
                    .frame(height: 8)
                GeometryReader { proxy in
                    RoundedRectangle(cornerRadius: 4)
                        .fill(NordTheme.accentGreen(colorScheme))
                        .frame(width: max(4, proxy.size.width * fraction), height: 8)
                }
                .frame(height: 8)
            }

            Text("\(formatTokens(bucket.totalTokens)) across \(bucket.requests) call\(bucket.requests == 1 ? "" : "s")")
                .font(.system(size: 11))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
        }
        .padding(.vertical, 2)
    }

    private func compactStatRow(label: String, value: String, detail: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                    .lineLimit(1)
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .lineLimit(1)
            }

            Spacer()

            Text(value)
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundColor(NordTheme.primaryText(colorScheme))
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

    private func efficiencyBars(_ points: [APIClient.UsageEfficiencyPointDTO]) -> some View {
        let maxAverage = points.map(\.averageTokensPerRequest).max() ?? 0

        return HStack(alignment: .bottom, spacing: 4) {
            ForEach(points) { point in
                let height = maxAverage > 0
                    ? max(4, CGFloat(point.averageTokensPerRequest / maxAverage) * 62)
                    : CGFloat(4)

                VStack(spacing: 3) {
                    Spacer(minLength: 0)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(NordTheme.accentPurple(colorScheme))
                        .frame(height: height)
                    Text(String(point.date.suffix(2)))
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .frame(height: 10)
                }
            }
        }
        .frame(height: 86)
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
        if hasInvalidCustomPrice {
            statusMessage = "Enter a valid non-negative USD price per 1M tokens."
            return
        }

        isLoading = true
        statusMessage = ""

        apiClient.fetchUsageMetrics(
            range: selectedRange.rawValue,
            provider: selectedProvider,
            pricePerMillionTokensUsd: parsedCustomPricePerMillionTokens
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

    private func clearCustomPrice() {
        customPricePerMillionTokensText = ""
        loadMetrics()
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

    private func deltaTint(_ comparison: APIClient.UsageComparisonDTO) -> Color {
        if comparison.tokenDelta < 0 {
            return NordTheme.accentGreen(colorScheme)
        }
        if comparison.tokenDelta > 0 {
            return NordTheme.accentAmber(colorScheme)
        }
        return NordTheme.accentBlue(colorScheme)
    }

    private func tokenDeltaText(_ comparison: APIClient.UsageComparisonDTO) -> String {
        guard let ratio = comparison.tokenDeltaRatio else {
            return "No prior period data"
        }
        let direction = comparison.tokenDelta >= 0 ? "+" : "-"
        return "\(direction)\(formatTokens(abs(comparison.tokenDelta))) vs prior (\(formatPercent(abs(ratio))))"
    }

    private var parsedCustomPricePerMillionTokens: Double? {
        let normalized = customPricePerMillionTokensText
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
        if normalized.isEmpty { return nil }
        guard let value = Double(normalized), value >= 0 else { return nil }
        return value
    }

    private var hasInvalidCustomPrice: Bool {
        let trimmed = customPricePerMillionTokensText.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && parsedCustomPricePerMillionTokens == nil
    }

    private func costDeltaText(_ comparison: APIClient.UsageComparisonDTO, metrics: APIClient.UsageMetricsResponse) -> String {
        if let customPrice = metrics.pricing.customPricePerMillionTokensUsd {
            return "\(formatCurrency(customPrice)) / 1M tokens"
        }
        let direction = comparison.costDeltaUsd >= 0 ? "+" : "-"
        return "\(direction)\(formatCurrency(abs(comparison.costDeltaUsd))) vs prior"
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

    private func formatCurrency(_ value: Double) -> String {
        if value > 0 && value < 0.01 {
            return String(format: "$%.4f", value)
        }
        return String(format: "$%.2f", value)
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
