#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const ENDPOINT = (
	process.env.BIGQUERY_API_ENDPOINT ?? "http://localhost:9050"
).replace(/\/$/, "")
const PROJECT_ID = process.env.BIGQUERY_PROJECT_ID ?? "123"
const DATASET = process.env.BIGQUERY_DATASET ?? "coderabbit_prod_db_public"

const ORG_ID =
	process.env.SEED_ORG_ID ?? "fef3aa20-3c61-11ee-ad56-f7d4f84f4906"
const WORKSPACE_ID =
	process.env.SEED_WORKSPACE_ID ?? "29b07494-e730-4aaf-bbc6-99f81b5064fd"
const ORG_NAME = process.env.SEED_ORG_NAME ?? "coderabbitai"

const DASHBOARDS_DIR = "coderabbitHandler/src/grafana-proxy/dashboards"

const now = new Date()
const daysAgo = days => new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
const iso = date => date.toISOString()
const dateOnly = date => date.toISOString().slice(0, 10)

const subscriptionId = 1
const teamId = "team-platform"
const users = [
	{ id: "92389887", username: "GurinderRawala", name: "Gurinder Singh" },
	{ id: "1001", username: "alex-dev", name: "Alex Dev" },
	{ id: "1002", username: "sam-reviewer", name: "Sam Reviewer" },
	{ id: "1003", username: "mira-cli", name: "Mira CLI" },
]
const repos = [
	{ id: "repo-api", name: "mono" },
	{ id: "repo-dashboard", name: "dashboard-mfe" },
	{ id: "repo-agent", name: "omnikey-agent" },
]

function log(...args) {
	console.log("[seed-local-bq-dashboard-data]", ...args)
}

async function request(path, options = {}) {
	const response = await fetch(`${ENDPOINT}${path}`, {
		...options,
		headers: {
			"content-type": "application/json",
			...(options.headers ?? {}),
		},
	})
	const text = await response.text()
	let body = text
	try {
		body = text ? JSON.parse(text) : {}
	} catch {
		// Keep plain text.
	}
	if (!response.ok) {
		const err = new Error(
			`${options.method ?? "GET"} ${path} failed: ${response.status} ${text}`,
		)
		err.status = response.status
		err.body = body
		throw err
	}
	return body
}

async function ignoreNotFound(promise) {
	try {
		return await promise
	} catch (err) {
		if (err.status === 404 || /not found/i.test(String(err.message))) return null
		throw err
	}
}

function extractDashboardColumns() {
	const tables = new Map()
	const add = (table, column) => {
		if (!tables.has(table)) tables.set(table, new Set())
		tables.get(table).add(column.replace(/`/g, ""))
	}
	const scanSql = sql => {
		const aliasMap = new Map()
		const tableRe =
			/(?:FROM|JOIN)\s+`?coderabbit_prod_db_public`?\.`?([A-Za-z_][A-Za-z0-9_]*)`?(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi
		for (const match of sql.matchAll(tableRe)) {
			const table = match[1]
			const alias = match[2] ?? table
			aliasMap.set(alias, table)
			if (!tables.has(table)) tables.set(table, new Set())
		}
		for (const [alias, table] of aliasMap) {
			const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			const columnRe = new RegExp(
				`\\b${escapedAlias}\\s*\\.\\s*(?:\`([^\`]+)\`|([A-Za-z_][A-Za-z0-9_]*))`,
				"g",
			)
			for (const match of sql.matchAll(columnRe)) {
				add(table, match[1] ?? match[2])
			}
		}
	}
	const walkPanel = panel => {
		for (const target of panel.targets ?? []) {
			if (typeof target.rawSql === "string" && target.rawSql.trim()) {
				scanSql(target.rawSql)
			}
		}
		for (const child of panel.panels ?? []) walkPanel(child)
	}
	for (const file of readdirSync(DASHBOARDS_DIR).filter(f => f.endsWith(".json"))) {
		const dashboard = JSON.parse(readFileSync(join(DASHBOARDS_DIR, file), "utf8"))
		for (const panel of dashboard.panels ?? []) walkPanel(panel)
		for (const variable of dashboard.templating?.list ?? []) {
			const query =
				typeof variable.query === "string"
					? variable.query
					: typeof variable.definition === "string"
						? variable.definition
						: ""
			if (query.includes("coderabbit_prod_db_public")) scanSql(query)
		}
	}
	return tables
}

function addRowColumns(tables, rowsByTable) {
	for (const [table, rows] of Object.entries(rowsByTable)) {
		if (!tables.has(table)) tables.set(table, new Set())
		for (const row of rows) {
			for (const column of Object.keys(row)) tables.get(table).add(column)
		}
	}
}

function typeForColumn(table, column) {
	if (
		column === "createdAt" ||
		column === "updatedAt" ||
		column === "created_at" ||
		column === "updated_at" ||
		column === "last_used_at" ||
		column === "pr_created" ||
		column === "ready_for_review" ||
		column === "pr_merged" ||
		column === "pr_closed" ||
		column === "last_commit_timestamp" ||
		column === "first_comment_timestamp" ||
		column === "comment_timestamp" ||
		column === "created" ||
		column.endsWith("_at") ||
		column.endsWith("_timestamp")
	) {
		return "TIMESTAMP"
	}
	if (
		column === "accepted" ||
		column === "cr_reviewed" ||
		column === "inconclusive" ||
		column === "is_active" ||
		column === "is_bot" ||
		column === "is_overridden" ||
		column === "is_pr_blocked" ||
		column === "private_repo" ||
		column === "pro_legacy" ||
		column === "schedule_success" ||
		column === "schedule_status" ||
		column === "trial_as_pro" ||
		(table === "pre_merge_checks_results" && column === "status")
	) {
		return "BOOL"
	}
	if (
		column === "id" &&
		["repositories", "subscription_user", "subscriptions"].includes(table)
	) {
		return "INT64"
	}
	if (
		column === "subscription_id" ||
		column === "subscription_user_id" ||
		column === "num_seats" ||
		column === "user_level" ||
		column === "file_total" ||
		column === "file_selected" ||
		column === "estimated_complexity" ||
		column === "estimated_review_minutes" ||
		column === "hunks" ||
		column === "actionable_cmnts" ||
		column === "suppressed_cmnts" ||
		column === "issue_cmnts" ||
		column === "refactor_cmnts" ||
		column === "nitpick_cmnts" ||
		column === "comments_count" ||
		column === "line_number" ||
		column === "total_cmnts" ||
		column === "total_suggestions" ||
		column === "total_learnings_created" ||
		column === "total_issue_cmnts" ||
		column === "total_refactor_cmnts" ||
		column === "total_nitpick_cmnts" ||
		column === "accepted_issue_cmnts" ||
		column === "accepted_refactor_cmnts" ||
		column === "accepted_nitpick_cmnts" ||
		column === "scripts_executed" ||
		column === "tool_call_count" ||
		column === "server_error_count" ||
		column === "insights_count" ||
		column === "action_performed" ||
		column === "billable_files_count" ||
		column === "files_billed" ||
		column === "unit_price_cents" ||
		column.endsWith("_count") ||
		column.endsWith("_posted") ||
		column.endsWith("_accepted") ||
		column.endsWith("_comments")
	) {
		return "INT64"
	}
	if (
		column === "wait_time_ms" ||
		column === "dynamic_reviews_per_hour" ||
		column === "categorized_confidence"
	) {
		return "FLOAT64"
	}
	return "STRING"
}

async function ensureDataset() {
	await ignoreNotFound(
		request(`/bigquery/v2/projects/${PROJECT_ID}/datasets/${DATASET}`, {
			method: "GET",
		}),
	)
	try {
		await request(`/bigquery/v2/projects/${PROJECT_ID}/datasets`, {
			method: "POST",
			body: JSON.stringify({
				datasetReference: { projectId: PROJECT_ID, datasetId: DATASET },
				location: "US",
			}),
		})
		log(`created dataset ${PROJECT_ID}.${DATASET}`)
	} catch (err) {
		if (!/already/i.test(String(err.message))) throw err
	}
}

async function recreateTable(table, columns) {
	await ignoreNotFound(
		request(
			`/bigquery/v2/projects/${PROJECT_ID}/datasets/${DATASET}/tables/${table}`,
			{ method: "DELETE" },
		),
	)
	await request(`/bigquery/v2/projects/${PROJECT_ID}/datasets/${DATASET}/tables`, {
		method: "POST",
		body: JSON.stringify({
			tableReference: { projectId: PROJECT_ID, datasetId: DATASET, tableId: table },
			schema: {
				fields: [...columns].sort().map(column => ({
					name: column,
					type: typeForColumn(table, column),
					mode: "NULLABLE",
				})),
			},
		}),
	})
}

async function insertRows(table, rows) {
	if (rows.length === 0) return
	const response = await request(
		`/bigquery/v2/projects/${PROJECT_ID}/datasets/${DATASET}/tables/${table}/insertAll`,
		{
			method: "POST",
			body: JSON.stringify({
				kind: "bigquery#tableDataInsertAllRequest",
				rows: rows.map((json, index) => ({
					insertId: `${table}-${index}`,
					json,
				})),
			}),
		},
	)
	if (response.insertErrors?.length) {
		throw new Error(
			`insertAll ${table} returned errors: ${JSON.stringify(response.insertErrors)}`,
		)
	}
}

function makeRows() {
	const reviewEvents = []
	const prMetrics = []
	const reviewMetrics = []
	const toolsMetrics = []
	const prComments = []
	const suggestionMetrics = []
	const commenters = []
	const commentDetails = []
	const preMergeMetrics = []
	const preMergeResults = []
	const extensionProfiles = []
	const extensionReviewEvents = []
	const rateLimitEvents = []
	const overages = []

	for (let i = 0; i < 36; i++) {
		const user = users[i % users.length]
		const repo = repos[i % repos.length]
		const created = daysAgo(i % 21)
		const prUrl = `https://github.com/coderabbitai/${repo.name}/pull/${1000 + i}`
		const reviewEventId = `review-event-${i}`
		const prMetricId = `pr-metric-${i}`
		const reviewMetricId = `review-metric-${i}`
		const commenterId = `commenter-${i}`
		const commentUrl = `${prUrl}#discussion_r${900000 + i}`
		const productTier = i % 2 === 0 ? "pro" : "pro_plus"
		const extensionProfileId = `extension-profile-${i % users.length}`

		prMetrics.push({
			id: prMetricId,
			org_id: ORG_ID,
			repo_id: repo.id,
			pr_url: prUrl,
			user_id: user.id,
			pr_created: iso(created),
			ready_for_review: iso(created),
			pr_merged: i % 4 === 0 ? null : iso(daysAgo(Math.max((i % 21) - 1, 0))),
			pr_closed: null,
			last_commit_timestamp: iso(created),
			created_at: iso(created),
			cr_reviewed: true,
			review_type: "REVIEW",
			state: i % 4 === 0 ? "OPEN" : "MERGED",
			estimated_complexity: 2 + (i % 8),
			estimated_review_minutes: 8 + (i % 25),
		})

		reviewEvents.push({
			id: reviewEventId,
			org_id: ORG_ID,
			repo_id: repo.id,
			pr_url: prUrl,
			username: user.username,
			user_id: user.id,
			product_tier: productTier,
			product_reason: "paid_user",
			review_type: "REVIEW",
			review_profile: "chill",
			early_access: false,
			file_total: 12 + (i % 9),
			file_selected: 5 + (i % 7),
			createdAt: iso(created),
			pr_created: iso(created),
			pr_merged: i % 4 === 0 ? null : iso(daysAgo(Math.max((i % 21) - 1, 0))),
			estimated_complexity: 2 + (i % 8),
			estimated_review_minutes: 8 + (i % 25),
		})

		reviewMetrics.push({
			id: reviewMetricId,
			review_event_id: reviewEventId,
			file_name: `src/module-${i % 6}.ts`,
			hunks: 1 + (i % 5),
			actionable_cmnts: 1 + (i % 4),
			suppressed_cmnts: i % 2,
			issue_cmnts: i % 3,
			refactor_cmnts: 1 + (i % 2),
			nitpick_cmnts: i % 2,
			org_id: ORG_ID,
		})

		toolsMetrics.push({
			id: `tool-metric-${i}`,
			review_metrics_id: reviewMetricId,
			org_id: ORG_ID,
			subscription_id: subscriptionId,
			team_id: teamId,
			user_id: user.id,
			tool: ["eslint", "semgrep", "typescript", "secret-scan"][i % 4],
			category: ["bug", "security", "style", "performance"][i % 4],
			severity: ["critical", "major", "minor", "info"][i % 4],
			type: "TOOL",
			createdAt: iso(created),
		})

		prComments.push({
			id: `pr-comment-${i}`,
			org_id: ORG_ID,
			repo_id: repo.id,
			author_id: user.id,
			pm_user_id: user.id,
			pr_url: prUrl,
			comment_url: commentUrl,
			accepted: i % 3 !== 0,
			accepted_source: "github",
			severity_tags: ["critical", "major", "minor"][i % 3],
			issue_types: ["bug", "security", "docs"][i % 3],
			category_tags: ["correctness", "security", "maintainability"][i % 3],
			createdAt: iso(created),
			total_merged_comments: 1 + (i % 5),
			accepted_merged_comments: i % 3,
			critical_comments_posted: i % 2,
			critical_comments_accepted: i % 2 === 0 ? 1 : 0,
			major_comments_posted: 1 + (i % 3),
			major_comments_accepted: i % 2,
			other_comments_posted: 1 + (i % 4),
			other_comments_accepted: i % 3,
		})

		suggestionMetrics.push({
			id: `suggestion-metric-${i}`,
			org_id: ORG_ID,
			pr_url: prUrl,
			ai_confirmed_count: 1 + (i % 5),
			total_suggestions: 4 + (i % 9),
			accepted_comment_count: 1 + (i % 4),
			review_comment_count: 3 + (i % 8),
			total_issue_cmnts: 1 + (i % 3),
			total_refactor_cmnts: 1 + (i % 2),
			total_nitpick_cmnts: i % 4,
			accepted_issue_cmnts: i % 2,
			accepted_refactor_cmnts: i % 2,
			accepted_nitpick_cmnts: i % 3,
			user_confirmed_count: i % 4,
			created_at: iso(created),
			updated_at: iso(created),
		})

		commenters.push({
			id: commenterId,
			user_id: user.id,
			username: user.username,
			name: user.name,
			pr_metrics_id: prMetricId,
			first_comment_timestamp: iso(created),
			org_id: ORG_ID,
			comments_count: 1 + (i % 6),
		})

		commentDetails.push({
			id: `comment-detail-${i}`,
			pr_review_commenters_id: commenterId,
			comment_url: commentUrl,
			comment_timestamp: iso(created),
			updated_at: iso(created),
			type: i % 2 === 0 ? "CODE" : "GENERAL",
			state: i % 3 === 0 ? "resolved" : "open",
			file_path: `src/module-${i % 6}.ts`,
			line_number: 20 + i,
			comment_id: `comment-${i}`,
			org_id: ORG_ID,
			in_reply_to_id: null,
		})

		const preMergeId = `premerge-${i}`
		preMergeMetrics.push({
			id: preMergeId,
			org_id: ORG_ID,
			repo_id: repo.id,
			pr_url: prUrl,
			user_id: user.id,
			createdAt: iso(created),
			updatedAt: iso(created),
			settings: JSON.stringify({ strict: i % 2 === 0 }),
			is_pr_blocked: i % 5 === 0,
			is_overridden: i % 7 === 0,
		})
		preMergeResults.push({
			id: `premerge-result-${i}`,
			metrics_id: preMergeId,
			check_name: ["lint", "tests", "security"][i % 3],
			custom_check_name: null,
			inconclusive: false,
			status: i % 5 !== 0,
			check_status: i % 5 === 0 ? "FAILED" : "PASSED",
			execution_method: "AUTOMATED",
			is_resolved: i % 5 !== 0,
			createdAt: iso(created),
			updatedAt: iso(created),
		})

		if (i < users.length) {
			extensionProfiles.push({
				id: extensionProfileId,
				subscriber_user_id: user.id,
				extension_type: i % 2 === 0 ? "vscode" : "jetbrains",
				created_at: iso(daysAgo(30 - i)),
			})
		}
		extensionReviewEvents.push({
			id: `extension-review-${i}`,
			extension_profile_id: extensionProfileId,
			review_event_id: reviewEventId,
			created_at: iso(created),
		})

		rateLimitEvents.push({
			id: `rate-limit-${i}`,
			org_id: ORG_ID,
			repo_id: repo.id,
			pr_url: prUrl,
			username: user.username,
			user_id: user.id,
			product_tier: productTier,
			product_reason: "paid_user",
			type: "review",
			platform: "github",
			wait_time_ms: i % 5 === 0 ? 800 : 0,
			rate_limit_outcome:
				i % 6 === 0
					? "rate_limited_insufficient_credits"
					: i % 5 === 0
						? "rate_limited_legacy"
						: "allowed",
			rate_limit_identity: user.username.toLowerCase(),
			billable_files_count: 4 + (i % 9),
			createdAt: iso(created),
		})

		if (i % 6 === 0) {
			overages.push({
				id: `overage-${i}`,
				review_event_id: reviewEventId,
				ubb_addon_id: "ubb-addon-local",
				subscription_id: subscriptionId,
				files_billed: 3 + (i % 8),
				unit_price_cents: 25,
				chargebee_dedup_id: `local-overage-${i}`,
				event_type: "review_files",
				created_at: iso(created),
			})
		}
	}

	return {
		workspaces: [
			{
				id: WORKSPACE_ID,
				name: "CodeRabbit",
				domain: "coderabbit.ai",
				created_at: iso(daysAgo(180)),
				updated_at: iso(now),
			},
		],
		organizations: [
			{
				id: ORG_ID,
				organization_name: ORG_NAME,
				provider_organization_id: "132028505",
				provider: "github",
				scope: "Organization",
				createdAt: iso(daysAgo(180)),
				updatedAt: iso(now),
				is_active: true,
				member_count: 180,
				initial_member_count: 100,
				self_hosted_instance_id: null,
				workspace_id: WORKSPACE_ID,
			},
		],
		subscriptions: [
			{
				id: subscriptionId,
				owner_id: ORG_ID,
				org_id: ORG_ID,
				workspace_id: WORKSPACE_ID,
				subscription_scope: "organization",
				subscription_status: "active",
				subscription_start_date: iso(daysAgo(150)),
				num_seats: 125,
				createdAt: iso(daysAgo(150)),
				updatedAt: iso(now),
				chargebee_subscription_id: "local-subscription-pro-plus",
				plan_id: "CRB_PRO_PLUS_MONTHLY_SUBSCRIPTION_PER_SEAT-USD-Monthly",
				is_active: true,
				self_hosted_instance_id: null,
				pro_legacy: false,
				trial_as_pro: false,
			},
		],
		subscription_user: users.map((user, index) => ({
			id: index + 1,
			subscription_id: subscriptionId,
			user_id: user.id,
			status: "active",
			createdAt: iso(daysAgo(120 - index)),
			updatedAt: iso(now),
			user_level: index === 0 ? 3 : 2,
			is_bot: false,
			last_used_at: iso(daysAgo(index)),
			username: user.username,
			name: user.name,
			provider: "github",
			self_hosted_instance_id: null,
		})),
		teams: [
			{
				id: teamId,
				subscription_id: subscriptionId,
				provider_team_id: "platform",
				team_name: "Platform",
				org_id: ORG_ID,
			},
			{
				id: "team-product",
				subscription_id: subscriptionId,
				provider_team_id: "product",
				team_name: "Product",
				org_id: ORG_ID,
			},
		],
		team_membership: users.map((user, index) => ({
			team_id: index % 2 === 0 ? teamId : "team-product",
			subscription_id: subscriptionId,
			user_id: user.id,
			subscription_user_id: index + 1,
			createdAt: iso(daysAgo(90)),
			updatedAt: iso(now),
		})),
		repositories: repos.map((repo, index) => ({
			id: index + 1,
			installs_id: "local-install",
			repository_id: repo.id,
			install_scope: "Organization",
			action_type: "created",
			repository_name: repo.name,
			group_path: `coderabbitai/${repo.name}`,
			createdAt: iso(daysAgo(160)),
			updatedAt: iso(daysAgo(index)),
			organization_id: "132028505",
			subscription_owner_id: ORG_ID,
			private_repo: index % 2 === 0,
			stars_count: 40 + index * 11,
			programming_languages: JSON.stringify({ TypeScript: 78, Go: 12 }),
			subscription_id: String(subscriptionId),
		})),
		pr_metrics: prMetrics,
		review_event: reviewEvents,
		review_metrics: reviewMetrics,
		tools_metrics: toolsMetrics,
		pr_comment_metrics: prComments,
		suggestion_metrics: suggestionMetrics,
		pr_review_commenters: commenters,
		pr_comment_details: commentDetails,
		pre_merge_checks_metrics: preMergeMetrics,
		pre_merge_checks_results: preMergeResults,
		finishing_touches_metrics: repos.map((repo, index) => ({
			id: `finishing-touch-${index}`,
			org_id: ORG_ID,
			repo_id: repo.id,
			pr_url: `https://github.com/coderabbitai/${repo.name}/pull/${2000 + index}`,
			action_performed: 2 + index,
			generation_type: index % 2 === 0 ? "PR" : "DOCSTRING",
			type: index % 2 === 0 ? "docstrings" : "tests",
			createdAt: iso(daysAgo(index + 1)),
			updatedAt: iso(daysAgo(index)),
		})),
		learnings: [
			{
				id: "learning-1",
				org_id: ORG_ID,
				repo_name: "mono",
				repo_owner: "coderabbitai",
				source_type: "review",
				user: users[0].username,
				createdAt: iso(daysAgo(5)),
			},
			{
				id: "learning-2",
				org_id: ORG_ID,
				repo_name: "dashboard-mfe",
				repo_owner: "coderabbitai",
				source_type: "chat",
				user: users[1].username,
				createdAt: iso(daysAgo(2)),
			},
		],
		learnings_metrics: [
			{
				id: "learning-metric-1",
				review_metrics_id: "review-metric-1",
				learning_id: "learning-1",
				org_id: ORG_ID,
			},
			{
				id: "learning-metric-2",
				review_metrics_id: "review-metric-2",
				learning_id: "learning-2",
				org_id: ORG_ID,
			},
		],
		chat_metrics: users.map((user, index) => ({
			id: `chat-${index}`,
			org_id: ORG_ID,
			repo_id: repos[index % repos.length].id,
			repo_name: repos[index % repos.length].name,
			pr_url: `https://github.com/coderabbitai/${repos[index % repos.length].name}/pull/${3000 + index}`,
			top_level_comment_id: `chat-top-${index}`,
			file_name: `src/chat-${index}.ts`,
			comment_type: "QUESTION",
			total_cmnts: 3 + index,
			total_learnings_created: index % 2,
			scripts_executed: 1 + index,
			username: user.username,
			user_id: user.id,
			createdAt: iso(daysAgo(index + 1)),
		})),
		chat_learnings_metrics: [
			{
				id: "chat-learning-1",
				chat_metrics_id: "chat-0",
				learning_id: "learning-1",
				org_id: ORG_ID,
			},
		],
		path_instructions_metrics: [
			{
				id: "path-instruction-metric-1",
				review_metrics_id: "review-metric-1",
				path_instructions_id: "path-instruction-1",
				org_id: ORG_ID,
			},
			{
				id: "path-instruction-metric-2",
				review_metrics_id: "review-metric-2",
				path_instructions_id: "path-instruction-2",
				org_id: ORG_ID,
			},
		],
		mcp_server_metrics: [
			{
				id: "mcp-server-1",
				organization_id: ORG_ID,
				ref_url: "https://github.com/coderabbitai/mono/pull/4100",
				server_id: "linear",
				flow_type: "review",
				tool_call_count: 14,
				server_error_count: 1,
				insights_count: 5,
				created_at: iso(daysAgo(3)),
				updated_at: iso(daysAgo(1)),
			},
			{
				id: "mcp-server-2",
				organization_id: ORG_ID,
				ref_url: "https://github.com/coderabbitai/mono/pull/4101",
				server_id: "github",
				flow_type: "chat",
				tool_call_count: 9,
				server_error_count: 0,
				insights_count: 4,
				created_at: iso(daysAgo(1)),
				updated_at: iso(now),
			},
		],
		integrations: [
			{
				id: "integration-linear",
				organization_id: ORG_ID,
				workspace_id: WORKSPACE_ID,
				service: "linear",
				service_id: "linear-local",
				created_at: iso(daysAgo(20)),
			},
			{
				id: "integration-github",
				organization_id: ORG_ID,
				workspace_id: WORKSPACE_ID,
				service: "github",
				service_id: "github-local",
				created_at: iso(daysAgo(180)),
			},
		],
		extension_profiles: extensionProfiles,
		extension_review_events: extensionReviewEvents,
		schedule: [
			{
				id: "schedule-weekly",
				owner_id: ORG_ID,
				schedule_status: true,
				schedule_type: "WEEKLY",
			},
		],
		schedule_event_log: [
			{
				id: "schedule-event-1",
				schedule_key: "schedule-weekly",
				schedule_success: true,
				schedule_channels: "slack",
				created_at: iso(daysAgo(7)),
			},
			{
				id: "schedule-event-2",
				schedule_key: "schedule-weekly",
				schedule_success: true,
				schedule_channels: "email",
				created_at: iso(daysAgo(1)),
			},
		],
		rate_limit_event: rateLimitEvents,
		review_event_overages: overages,
	}
}

async function validate() {
	const query = `
		SELECT
			(SELECT COUNT(*) FROM \`${DATASET}.organizations\`) AS organizations,
			(SELECT COUNT(*) FROM \`${DATASET}.pr_metrics\`) AS pr_metrics,
			(SELECT COUNT(*) FROM \`${DATASET}.review_event\`) AS review_event,
			(SELECT COUNT(*) FROM \`${DATASET}.pr_comment_metrics\`) AS pr_comment_metrics,
			(SELECT COUNT(*) FROM \`${DATASET}.rate_limit_event\`) AS rate_limit_event
	`
	const response = await request(`/bigquery/v2/projects/${PROJECT_ID}/queries`, {
		method: "POST",
		body: JSON.stringify({ query, useLegacySql: false }),
	})
	log("validation counts", JSON.stringify(response.rows?.[0]?.f?.map(f => f.v)))
}

async function main() {
	const rowsByTable = makeRows()
	const columnsByTable = extractDashboardColumns()
	addRowColumns(columnsByTable, rowsByTable)

	await ensureDataset()

	for (const table of [...columnsByTable.keys()].sort()) {
		await recreateTable(table, columnsByTable.get(table))
		const rows = rowsByTable[table] ?? []
		await insertRows(table, rows)
		log(`seeded ${table}: ${rows.length} rows`)
	}

	await validate()
	log(`done: ${PROJECT_ID}.${DATASET} at ${ENDPOINT}`)
}

main().catch(err => {
	console.error("[seed-local-bq-dashboard-data] fatal", err)
	process.exit(1)
})
