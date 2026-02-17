<role>
    You are an expert PostgreSQL and Grafana engineer.
    Your task is to refactor existing Grafana panel SQL queries to support both
    organization-scoped and self-hosted-instance–scoped filtering along with fixing find active user by org logic, while
    preserving all current logic, time filters, and metric semantics.
</role>

<context>
    We are migrating existing Grafana dashboards so they work for:
      - SaaS: filter by a single organization ID.
      - Self-hosted: filter by a single self-hosted instance ID, which may map to multiple organizations.

    NOTE: At a given there will be one of these two variables will be present $org_id or $self_hosted_id, never both. Write sql queries that work correctly in either case, and also when both are empty (in that case, queries should return no data).

    Queries primarily operate on the following tables:
      - review_event
      - learnings_metrics
      - review_metrics
      - chat_metrics
      - chat_learnings_metrics
      - tools_metrics
      - path_instructions_metrics
      - pr_metrics
      - pr_review_commenters
      - suggestion_metrics
      - pr_comment_metrics
      - pr_comment_details
      - repositories
      - learnings
      - path_instructions
      - subscriptions
      - subscription_user
      - subscribers
      - organizations
      - self_hosted_instances

</context>

<filters>
    We have these Grafana template variables:

    1) $self_hosted_id
       - A UUID (as text) for a self_hosted_instances.id.
       - When set, we want to show data for all organizations that belong
         to this self-hosted instance.
       - When not selected, Grafana passes an empty string.
       - Use the pattern:
         NULLIF($self_hosted_id, '')::uuid IS NOT NULL
         to check if it’s actually set.

    2) $org_id
       - A UUID for organizations.id.
       - When set, we want to show data only for this single organization.
       - When not selected, Grafana passes an empty string.
       - Use the pattern:
         NULLIF($org_id, '')::uuid IS NOT NULL
         to check if it’s actually set.

    Exactly one of [$org_id, $self_hosted_id] will be available in a
    given dashboard (we configure dashboards so only one template variable
    is present). The SQL, however, must be robust if both exist:
      - If $self_hosted_id is set (non-empty), filter by all orgs belonging
        to that self-hosted instance.
      - Else, if $org_id is set, filter by that specific organization.
      - If both are empty, query should return no rows.

    Additional optional filters you must preserve:
      - $org_name:
          * If empty (or not set), treat as “All organizations”.
          * If set, filter on organizations.organization_name = $org_name.
          * Use the pattern:
              (NULLIF($org_name, '') IS NULL OR organization_name = $org_name)
      - $repo_name:
          * If empty, treat as “All repositories”.
          * If set, filter via the repositories table.
          * Use the pattern shown below with EXISTS against repositories.
      -  $username:
          * If empty, treat as “All users”.
          * If set, filter on subscription_user.username = $username.
      - $teams:
          * If you see anywhere teams filter remove it. As we don't want to use it anymore.
      - $team_users
          * If you see anywhere team_users filter remove it. As we don't want to use it anymore.

    Always preserve existing Grafana macros like:
      - $__timeFilter(table."createdAt")

</filters>

<main_where_clause_pattern>
For queries that are directly constrained by an org context (through
organizations, subscriptions.owner_id, metrics.org_id, etc.), use this
core pattern somewhere in the WHERE clause (either directly, or inside
a CTE):

    (
      NULLIF($self_hosted_id, '')::uuid IS NOT NULL
      AND o.self_hosted_instance_id = $self_hosted_id
    )
    OR
    (
      NULLIF($org_id, '')::uuid IS NOT NULL
      AND o.id = NULLIF($org_id, '')::uuid
    );

    Here:
      - o is an alias for organizations.
      - When both variables are empty, this expression is false; in that case
        either:
          * you should omit this WHERE clause entirely, OR
          * use it only inside a CTE that is referenced conditionally with
            EXISTS. Follow the example CTE pattern below.

</main_where_clause_pattern>

<cte_pattern_example>
When a query needs to compute information per organization or per user
per organization (e.g., active users), use a CTE to define the set of
“related” organizations based on $self_hosted_id and $org_id:

<active_users_by_org_query_example>
This is the perfect working sql for active user which is used almost in every query.

```sql
WITH related_orgs AS (
  SELECT
    o.id,
    o.organization_name
  FROM
    organizations o
  WHERE
    (
      NULLIF($self_hosted_id, '') :: uuid IS NOT NULL
      AND o.self_hosted_instance_id = $self_hosted_id
    )
    OR (
      NULLIF($org_id, '') :: uuid IS NOT NULL
      AND o.id = NULLIF($org_id, '') :: uuid
    )
    OR (
      NULLIF($org_name, '') IS NOT NULL
      AND o.organization_name = $org_name
    )
),
active_subscriptions AS (
  SELECT
    s.id
  FROM
    subscriptions s
  WHERE
    EXISTS (
      SELECT
        1
      FROM
        related_orgs ao
      WHERE
        ao.id = s.owner_id
    )
),
events AS (
  SELECT
    re.user_id,
    re.org_id,
    re.repo_id,
    re."createdAt"
  FROM
    review_event re
    JOIN related_orgs o ON o.id = re.org_id
  WHERE
    $__timeFilter(re."createdAt")
    AND (
      NULLIF($repo_name, '') IS NULL
      OR EXISTS (
        SELECT
          1
        FROM
          repositories r
        WHERE
          r.repository_id = re.repo_id
          AND r.subscription_owner_id = re.org_id
          AND r.repository_name = $repo_name
      )
    )
  UNION
  ALL
  SELECT
    pm.user_id,
    pm.org_id,
    pm.repo_id,
    pm.pr_created AS "createdAt"
  FROM
    pr_metrics pm
    JOIN related_orgs o ON o.id = pm.org_id
  WHERE
    $__timeFilter(pm.pr_created)
    AND (
      NULLIF($repo_name, '') IS NULL
      OR EXISTS (
        SELECT
          1
        FROM
          repositories r
        WHERE
          r.repository_id = pm.repo_id
          AND r.subscription_owner_id = pm.org_id
          AND r.repository_name = $repo_name
      )
    )
),
active_users AS (
  SELECT
    DISTINCT ev.user_id,
    ev.org_id
  FROM
    events ev
)
SELECT
  COUNT(DISTINCT su.user_id) AS "Active Users"
FROM
  subscription_user su
  JOIN active_subscriptions s ON s.id = su.subscription_id
  JOIN active_users au ON au.user_id = su.user_id
WHERE
  su.username IS NOT NULL
  AND TRIM(su.username) <> ''
  AND (
    NULLIF($username, '') IS NULL
    OR su.username = $username
  );
```

</active_users_by_org_query_example>

Previously, there was only active_users_by_org. We added related_orgs
to support the self-hosted flow. When you refactor queries, follow this
pattern: - Introduce a related_orgs CTE (or similarly named CTE) whenever the query’s semantics are “per organization” or “filtered by org”. - Drive downstream CTEs or main SELECTs from related_orgs via joins or EXISTS. - Ensure the `active_users_by_org` logic is implemented to always identify users who exist in either the `review_event` table, the `pr_metrics` table, or in both. Use the provided <active_users_by_org_query_example> sql as a reference for this implementation.
</cte_pattern_example>

<transformation_rules>
For any input SQL query, do ALL of the following:

    1) Keep all existing behavior that is not directly about organization
       scoping (aggregations, GROUP BY, HAVING, ORDER BY, time filters,
       metric definitions, etc.).

    2) Add support for $self_hosted_id and $org_id:
       - If the query already filters by org_id or owner_id directly, refactor
         that logic to use:
           - a related_orgs CTE as shown, and/or
           - the main_where_clause_pattern against organizations o.
       - If the query only has a time filter and no org/org_id filter yet,
         but should conceptually be restricted by org, add a related_orgs
         CTE and use EXISTS or JOIN to restrict by org_id via:
           - metrics.org_id,
           - review_event.org_id,
           - subscriptions.owner_id,
           - repositories.subscription_owner_id,
           - or other appropriate org_id column.

    3) Preserve org_name and repo_name filters:
       - If the query already includes an organization_name filter, rewrite it
         to follow:
           (NULLIF($org_name, '') IS NULL OR o.organization_name = $org_name)
         or the equivalent using ao.organization_name when filtering via
         related_orgs.
       - If the query uses repo_name filtering, preserve it and make sure it
         still works together with related_orgs, using EXISTS against
         repositories as shown in the example.

    4) Grafana variables:
       - Do not remove or rename existing Grafana macros like $__timeFilter.
       - Keep variable references with the existing Grafana syntax
         (e.g., $org_id, $self_hosted_id, $org_name, $repo_name).
       - Use NULLIF($var, '') checks instead of comparing directly to ''.

    5) Safety and correctness:
       - Do not change table names or column names.
       - Ensure the query is valid PostgreSQL when variable placeholders are
         replaced by concrete values.
       - If there are multiple org-related joins, be consistent in which
         alias you use for organizations (commonly o) and how you connect
         metrics/org_id to organizations.id.

    6) Fix the logic for `find_active_users_by_org` with the following requirements:
       - Ensure it finds active users who have an entry in either the `review_event` table, the `pr_metrics` table, or both.
       - Use the `<active_users_by_org_query_example>` as a reference for this implementation.
       - Make sure we filter by the $org_name only in related_orgs subquery and remove that filter if it is anywhere else.
       - Make sure we do not use subscriptions.owner_id as org_id anywhere. Remove owner_id from active_subcription subquery and also from related joins done by using owner_id.

Please update the logic accordingly.

    7) Optimize for faster query performance when filtering by self-hosted instance ID and organization ID:
        - Ensure that any new joins or WHERE clauses you add are sargable and can leverage existing indexes on organizations.self_hosted_instance_id and organizations.id.
        - Avoid unnecessary joins or subqueries that could degrade performance, especially on large datasets.

</transformation_rules>

<schema>
    Below are the Prisma/ZenStack models corresponding to the tables involved
    in these queries. Use them to understand relationships and column names.

    model organizations {
      id                                String                              @id @default(uuid()) @db.Uuid
      organization_name                 String                              @db.VarChar(255)
      provider_organization_id          String                              @db.VarChar(255)
      provider                          String                              @db.VarChar(255)
      scope                             String?                             @db.VarChar(20)
      createdAt                         DateTime?                           @default(now()) @db.Timestamptz(6)
      updatedAt                         DateTime?                           @updatedAt @db.Timestamptz(6)
      is_active                         Boolean?                            @default(true)
      email                             String?                             @db.VarChar(65535)
      tenant_id                         String?                             @db.VarChar(255)
      referral_status                   String?                             @db.VarChar(65535)
      initial_member_count              Int?
      member_count                      Int?
      member_count_last_updated         DateTime?                           @db.Timestamptz(6)
      coderabbit_onsite                 Boolean                             @default(false)
      webhook_secret                    String?                             @db.VarChar(255)
      webhook_secret_iv                 String?                             @db.VarChar(255)
      webhook_secret_tag                String?                             @db.VarChar(255)
      webhook_secret_updated_at         DateTime?                           @db.Timestamptz(6)
      api_key_org                       api_key_org[]
      integrations                      integrations[]
      self_hosted_instance_id           String?                             @db.VarChar(65535)
      self_hosted_instances             self_hosted_instances?              @relation(fields: [self_hosted_instance_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_organization_self_hosted_instances")
      repositories                      repositories[]
      repositories_settings             repositories_settings[]
      repositories_settings_org         repositories_settings_org[]
      review_requests                   review_requests[]
      schedule                          schedule[]
      subscriptions                     subscriptions[]
      learnings                         learnings[]
      playbooks                         playbooks[]
      review_event                      review_event[]
      review_metrics                    review_metrics[]
      path_instructions                 path_instructions[]
      chat_metrics                      chat_metrics[]
      pr_metrics                        pr_metrics[]
      pr_comment_metrics                pr_comment_metrics[]
      pr_comment_model_info             pr_comment_model_info[]
      suggestion_metrics                suggestion_metrics[]
      finishing_touches_metrics         finishing_touches_metrics[]
      organization_users                organization_user[]
      pr_review_commenters              pr_review_commenters[]
      pr_comment_details                pr_comment_details[]
      review_feedback                   review_feedback[]
      pre_merge_checks_metrics          pre_merge_checks_metrics[]
      environment_variables             environment_variable_org[]
      mcp_server_metrics                mcp_server_metrics[]
      onboarding_actions                onboarding_actions[]
      issue_enrichment                  issue_enrichment[]
      path_instructions_metrics         path_instructions_metrics[]
      learnings_metrics                 learnings_metrics[]
      chat_learnings_metrics            chat_learnings_metrics[]
      default_path_instructions_applied default_path_instructions_applied[]
      vercel_resources                  vercel_resources[]
      competitor_metrics                competitor_metrics[]
      coderabbit_configs                coderabbit_configs[]
      issue_intelligence_settings_org   issue_intelligence_settings_org[]

      @@index([organization_name], map: "organizations_organization_name_idx")
      @@index([provider_organization_id], map: "organizations_provider_organization_id_idx")
      @@index([self_hosted_instance_id], map: "organizations_self_hosted_instance_id_idx")
    }

    model self_hosted_instances {
      id                        String                @id @db.VarChar(65535)
      host_url                  String                @unique(map: "host_url_constraint") @db.VarChar(100)
      client_id                 String                @db.VarChar(1000)
      client_secret             String                @db.VarChar(65535)
      scope                     String                @db.VarChar(65535)
      redirect_uri              String                @db.VarChar(65535)
      tenant_id                 String?               @db.VarChar(255)
      bot_user_id               String?               @db.VarChar(65535)
      bot_access_token          String?               @db.VarChar(65535)
      admin_access_token        String?               @db.VarChar(65535)
      bot_password              String?               @db.VarChar(65535)
      client_secret_iv          String                @db.VarChar(65535)
      client_secret_tag         String                @db.VarChar(65535)
      bot_access_token_iv       String?               @db.VarChar(65535)
      bot_access_token_tag      String?               @db.VarChar(65535)
      admin_access_token_iv     String?               @db.VarChar(65535)
      admin_access_token_tag    String?               @db.VarChar(65535)
      bot_password_iv           String?               @db.VarChar(65535)
      bot_password_tag          String?               @db.VarChar(65535)
      gh_app_id                 String?               @db.VarChar(65535)
      gh_app_client_id          String?               @db.VarChar(65535)
      gh_app_client_secret      String?               @db.VarChar(65535)
      gh_app_client_secret_iv   String?               @db.VarChar(65535)
      gh_app_client_secret_tag  String?               @db.VarChar(65535)
      gh_app_private_key        String?               @db.VarChar(65535)
      gh_app_private_key_iv     String?               @db.VarChar(65535)
      gh_app_private_key_tag    String?               @db.VarChar(65535)
      webhook_secret            String?               @db.VarChar(65535)
      webhook_secret_iv         String?               @db.VarChar(65535)
      webhook_secret_tag        String?               @db.VarChar(65535)
      webhook_secret_updated_at DateTime?             @db.Timestamptz(6)
      custom_certs              String?               @db.VarChar(65535)
      custom_certs_iv           String?               @db.VarChar(65535)
      custom_certs_tag          String?               @db.VarChar(65535)
      createdAt                 DateTime?             @default(now()) @db.Timestamptz(6)
      updatedAt                 DateTime?             @updatedAt @db.Timestamptz(6)
      alternate_host_url        String?               @db.VarChar(100)
      is_active                 Boolean?              @default(true)
      ip_address                String[]              @default([])
      custom_proxy_headers      Json?                 @default("{}") @db.JsonB()
      network_namespace_name    String?               @db.VarChar(15)
      organizations             organizations[]
      subscription              subscriptions[]
      api_key_self_hosted       api_key_self_hosted[]
    }

    model review_event {
      id                       String                    @id @default(uuid()) @db.Uuid
      org_id                   String                    @db.Uuid
      organization             organizations             @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_organization_review_event")
      repo_id                  String                    @db.VarChar(255)
      pr_url                   String                    @db.VarChar(255)
      username                 String                    @db.VarChar(255)
      user_id                  String?                   @db.VarChar(255)
      review_type              ReviewType                @default(SUMMARY)
      review_profile           ReviewProfile?            @default(chill)
      early_access             Boolean?
      file_total               Int?                      @default(0)
      file_selected            Int?                      @default(0)
      createdAt                DateTime                  @default(now()) @db.Timestamptz(6)
      review_metrics           review_metrics[]
      pr_created               DateTime?                 @db.Timestamptz(6)
      pr_merged                DateTime?                 @db.Timestamptz(6)
      estimated_complexity     Int?
      estimated_review_minutes Int?
      extension_review_event   extension_review_events[] @relation("fk_review_events_extension_review_events")

      @@index([createdAt], name: "review_event_createdat_idx")
      @@index([username], name: "review_event_username_idx")
      @@index([org_id, pr_url, createdAt], name: "review_event_org_id_pr_url_createdAt_combined_idx")
      @@index([org_id, pr_url, username], name: "review_event_org_id_pr_url_username_combined_idx")
      @@index([org_id], name: "review_event_org_id_idx")
      @@index([user_id], name: "review_event_user_id_idx")
      @@index([repo_id], name: "review_event_repo_id_idx")
      @@index([org_id, user_id, repo_id, createdAt], name: "review_event_combined_filters_idx")
      @@index([org_id, createdAt], name: "review_event_org_id_createdAt_idx")
    }

    model review_metrics {
      id                        String                      @id @default(uuid()) @db.Uuid
      review_event_id           String                      @db.Uuid
      file_name                 String                      @db.VarChar(255)
      hunks                     Int
      actionable_cmnts          Int?
      suppressed_cmnts          Int?
      issue_cmnts               Int?
      refactor_cmnts            Int?
      nitpick_cmnts             Int?
      org_id                    String?                     @db.Uuid
      review_event              review_event                @relation(fields: [review_event_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_review_metrics_review_event")
      organization              organizations?              @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_review_metrics_organization")
      tools_metrics             tools_metrics[]
      learnings_metrics         learnings_metrics[]
      path_instructions_metrics path_instructions_metrics[]

      @@index([review_event_id], name: "review_metrics_review_event_idx")
      @@index([file_name], name: "review_metrics_file_name_idx")
      @@index([org_id], name: "review_metrics_org_id_idx")
    }

    model tools_metrics {
      id                String          @id @default(uuid()) @db.Uuid
      review_metrics_id String          @db.Uuid
      org_id            String?         @db.Uuid
      tool              String          @db.VarChar(100)
      category          String?         @db.VarChar(100)
      severity          String?         @db.VarChar(100)
      type              ToolFindingType @default(TOOL)
      review_metric     review_metrics  @relation(fields: [review_metrics_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_tools_metrics_review_metrics")

      @@index([review_metrics_id], name: "tools_metrics_review_metrics_idx")
      @@index([review_metrics_id, tool, severity], name: "tools_metrics_combined_idx")
      @@index([type], name: "tools_metrics_type_idx")
      @@index([org_id], name: "tools_metrics_org_id_idx")
    }

    model learnings_metrics {
      id                String         @id @default(uuid()) @db.Uuid
      review_metrics_id String         @db.Uuid
      learning_id       String         @db.Text
      org_id            String?        @db.Uuid
      review_metric     review_metrics @relation(fields: [review_metrics_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_learnings_metrics_review_metrics")
      learning          learnings      @relation(fields: [learning_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_learnings_metrics_learnings")
      organization      organizations? @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_learnings_metrics_organization")

      @@index([review_metrics_id], name: "learnings_metrics_review_metrics_idx")
      @@index([learning_id], name: "learnings_metrics_learning_idx")
      @@index([learning_id, review_metrics_id], name: "learnings_metrics_learning_review_metrics_idx")
      @@index([org_id], name: "learnings_metrics_org_id_idx")
    }

    model learnings {
      id                     String                   @id @default(uuid()) @db.Text
      org_id                 String                   @db.Uuid
      repo_name              String                   @db.VarChar(255)
      repo_owner             String                   @db.VarChar(255)
      pull_request           Int?
      start_line             Int?
      end_line               Int?
      top_level_comment_id   String?                  @db.VarChar(255)
      user                   String                   @db.VarChar(255)
      user_uid               String?                  @db.Uuid
      file                   String?                  @db.Text
      url                    String?                  @db.Text
      learning               String                   @db.Text
      organization           organizations            @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_organization_learnings")
      learnings_metrics      learnings_metrics[]
      chat_learnings_metrics chat_learnings_metrics[]
      createdAt              DateTime                 @default(now()) @db.Timestamptz(6)
      updatedAt              DateTime                 @updatedAt @db.Timestamptz(6)
      source_type            LearningSourceType       @default(CHAT)

      @@index([org_id], name: "learnings_org_id_idx")
      @@index([repo_name], name: "learnings_repo_name_idx")
      @@index([user], name: "learnings_user_idx")
    }

    model path_instructions_metrics {
      id                   String            @id @default(uuid()) @db.Uuid
      review_metrics_id    String            @db.Uuid
      path_instructions_id String            @db.Uuid
      org_id               String            @db.Uuid
      review_metric        review_metrics    @relation(fields: [review_metrics_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_path_instructions_metrics_review_metrics")
      path_instruction     path_instructions @relation(fields: [path_instructions_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_path_instructions_metrics_path_instructions")
      organization         organizations     @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_path_instructions_metrics_organization")

      @@index([review_metrics_id], name: "path_instructions_metrics_review_metrics_idx")
      @@index([path_instructions_id], name: "path_instructions_metrics_path_instructions_idx")
      @@index([review_metrics_id, path_instructions_id], name: "path_instructions_metrics_review_metrics_path_instructions_idx")
      @@index([org_id], name: "path_instructions_metrics_org_id_idx")
    }

    model path_instructions {
      id                                String                              @id @default(uuid()) @db.Uuid
      org_id                            String                              @db.Uuid
      repo_id                           String                              @db.VarChar(255)
      path                              String                              @db.VarChar(250)
      path_instruction                  String                              @db.Text
      createdAt                         DateTime                            @default(now()) @db.Timestamptz(6)
      path_instructions_metrics         path_instructions_metrics[]
      organization                      organizations                       @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_path_instructions_organization")
      default_path_instructions_applied default_path_instructions_applied[]

      @@index([org_id], name: "path_instructions_org_id_idx")
      @@index([repo_id, org_id], name: "path_instructions_repo_org_id_idx")
    }

    model chat_metrics {
      id                      String                    @id @default(uuid()) @db.Uuid
      org_id                  String                    @db.Uuid
      repo_id                 String                    @db.VarChar(255)
      repo_name               String                    @db.VarChar(255)
      pr_url                  String                    @db.VarChar(255)
      top_level_comment_id    String                    @db.Text
      file_name               String?                   @db.VarChar(255)
      comment_type            CommentType
      total_cmnts             Int                       @default(0)
      total_learnings_created Int                       @default(0)
      scripts_executed        Int                       @default(0)
      username                String?                   @db.VarChar(255)
      user_id                 String?                   @db.VarChar(255)
      organization            organizations             @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_organization_chat_metrics")
      createdAt               DateTime                  @default(now()) @db.Timestamptz(6)
      chat_learnings_metrics  chat_learnings_metrics[]
      agent_component_metrics agent_component_metrics[]

      @@index([pr_url, repo_name], name: "chat_metrics_pr_url_repo_name_idx")
      @@index([org_id], name: "chat_metrics_org_id_idx")
      @@index([createdAt], name: "chat_metrics_createdAt_idx")
    }

    model chat_learnings_metrics {
      id              String         @id @default(uuid()) @db.Uuid
      chat_metrics_id String         @db.Uuid
      learning_id     String         @db.Text
      org_id          String?        @db.Uuid
      chat_metrics    chat_metrics   @relation(fields: [chat_metrics_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_chat_learnings_metrics_chat_metrics")
      learnings       learnings      @relation(fields: [learning_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_chat_learnings_metrics_learnings")
      organization    organizations? @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_chat_learnings_metrics_organization")

      @@index([chat_metrics_id], name: "chat_learnings_metrics_chat_metrics_idx")
      @@index([learning_id], name: "chat_learnings_metrics_learning_idx")
      @@index([org_id], name: "chat_learnings_metrics_org_id_idx")
    }

    model repositories {
      id                      Int            @default(autoincrement())
      installs_id             String         @db.VarChar(1000)
      repository_id           String?        @db.VarChar(1000)
      install_scope           String         @db.VarChar(100)
      action_type             String?        @default("created") @db.VarChar(100)
      repository_name         String         @default("created") @db.VarChar(100)
      createdAt               DateTime       @default(now()) @db.Timestamptz(6)
      updatedAt               DateTime       @updatedAt @db.Timestamptz(6)
      organization_id         String?        @db.VarChar(1000)
      subscription_owner_id   String?        @db.Uuid
      are_issues_synced       Boolean        @default(false)
      issues_synced_from_date DateTime?      @db.Date
      private_repo            Boolean?
      stars_count             Int?
      programming_languages   Json?
      subscription_id         String?        @db.VarChar(1000)
      webhook_secret          String?        @db.VarChar(255)
      webhook_secret_iv       String?        @db.VarChar(255)
      webhook_secret_tag      String?        @db.VarChar(255)
      organizations           organizations? @relation(fields: [subscription_owner_id], references: [id], onDelete: NoAction, onUpdate: NoAction, map: "fk_organization_repositories")

      @@id([id, installs_id])
      @@index([subscription_owner_id], map: "idx_subscription_owner_id")
      @@index([organization_id], map: "repositories_organization_id_idx")
      @@index([repository_id])
      @@index([repository_id, subscription_owner_id], map: "repositories_repository_subscription_owner_idx")
      @@index([organization_id, subscription_owner_id, repository_id], name: "repositories_org_combined_idx")
    }

    model subscriptions {
      id                        Int                    @id @default(autoincrement())
      owner_id                  String                 @db.Uuid
      subscription_scope        String                 @default("individual") @db.VarChar(255)
      subscription_status       String                 @default("inactive") @db.VarChar(255)
      subscription_start_date   DateTime               @db.Timestamptz(6)
      num_seats                 Int
      createdAt                 DateTime               @default(now()) @db.Timestamptz(6)
      updatedAt                 DateTime               @updatedAt @db.Timestamptz(6)
      hoppy_premerge            AddonStatus            @default(cancelled)
      chargebee_subscription_id String?                @db.VarChar(65535)
      per_user_token_limit      Int?
      org_token_limit           Int?
      plan_id                   String?                @db.VarChar(255)
      pro_legacy                Boolean?               @default(false)
      join_immediate            Boolean?               @default(false)
      is_active                 Boolean?               @default(true)
      self_hosted_instance_id   String?                @db.VarChar(255)
      trial_as_pro              Boolean?               @default(false)
      cancellation_date         DateTime?              @db.Timestamptz(6)
      activation_date           DateTime?              @db.Timestamptz(6)
      enable_pro_features       Boolean?               @default(false)
      support_code              String?                @db.VarChar(10) @unique
      subscription_user         subscription_user[]
      organizations             organizations          @relation(fields: [owner_id], references: [id], onDelete: NoAction, onUpdate: NoAction, map: "fk_organization_subscriptions")
      self_hosted_instance      self_hosted_instances? @relation(fields: [self_hosted_instance_id], references: [id], onDelete: NoAction, onUpdate: NoAction, map: "fk_self_hosted_instance_subscriptions")
      subscription_custom_roles role[]

      @@index([owner_id], name: "subscriptions_owner_id_idx")
      @@index([self_hosted_instance_id], name: "subscriptions_self_hosted_instance_id_idx")
    }

    model subscription_user {
      id                   Int           @id @default(autoincrement())
      subscription_id      Int
      user_id              String        @db.VarChar(255)
      status               String        @default("active") @db.VarChar(255)
      createdAt            DateTime      @default(now()) @db.Timestamptz(6)
      updatedAt            DateTime      @updatedAt @db.Timestamptz(6)
      user_level           Int           @default(1) @db.SmallInt
      override_role        OverrideRole?
      is_bot               Boolean?      @default(false)
      subscriptions        subscriptions @relation(fields: [subscription_id], references: [id], onDelete: NoAction, onUpdate: NoAction, map: "fk_subscriptions_subscription_user")
      last_used_at         DateTime      @default(now()) @db.Timestamptz(6)
      username             String?       @db.VarChar(255)
      name                 String?       @db.VarChar(255)
      pending_unassignment Boolean       @default(false)

      @@unique([subscription_id, user_id], map: "subscription_user_un")
      @@index([subscription_id])
    }

    model subscribers {
      id                          String                       @id @default(uuid()) @db.Uuid
      name                        String?                      @db.VarChar(255)
      email                       String?                      @db.VarChar(255)
      user_name                   String                       @db.VarChar(255)
      provider                    String                       @default("github") @db.VarChar(255)
      provider_user_id            String                       @db.VarChar(255)
      createdAt                   DateTime                     @default(now()) @db.Timestamptz(6)
      updatedAt                   DateTime                     @updatedAt @db.Timestamptz(6)
      host_url                    String?                      @db.VarChar(65535)
      secondary_emails            String[]                     @default([]) @db.VarChar(65535)
      firebase_uid                String?                      @db.VarChar(255)
      first_name                  String?                      @db.VarChar(255)
      last_name                   String?                      @db.VarChar(255)
      company_email               String?                      @db.VarChar(255)
      company_role                String?                      @db.VarChar(255)
      company_name                String?                      @db.VarChar(255)
      avatar_url                  String?                      @db.VarChar(1300)
      metadata                    subscribers_metadata?        @relation("fk_subscribers_metadata_subscribers")
      extension_profile           extension_profiles[]         @relation("fk_subscribers_extension_profiles")
      created_roles               role[]                       @relation("role_created_by")
      updated_roles               role[]                       @relation("role_updated_by")
      issue_intelligence_rulesets issue_intelligence_ruleset[] @relation("issue_intelligence_ruleset_subscriber")
      onboarding_actions          onboarding_actions[]
      issue_plan_events           issue_plan_events[]
      issue_plan_chat_messages    issue_plan_chat_messages[]
      is_super_admin              Boolean                      @default(false)

      @@index([provider_user_id], map: "subscribers_provider_user_id_idx")
      @@index([user_name], map: "subscribers_user_name_idx")
      @@index([user_name, provider_user_id], name: "subscribers_username_provider_idx")
    }

    model pr_metrics {
      id                       String                 @id() @default(cuid())
      org_id                   String                 @db.Uuid()
      organization             organizations          @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_organization_pr_metrics")
      repo_id                  String
      pr_url                   String
      user_id                  String
      pr_created               DateTime
      ready_for_review         DateTime?
      pr_merged                DateTime?
      pr_closed                DateTime?
      last_commit_timestamp    DateTime?
      created_at               DateTime               @default(now())
      cr_reviewed              Boolean                @default(false)
      review_type              ReviewType?
      state                    PRState                @default(UNKNOWN)
      estimated_complexity     Int?
      estimated_review_minutes Int?
      experiment_assignment_id String?                @db.Uuid()
      experiment_assignment    experiment_assignment? @relation(fields: [experiment_assignment_id], references: [id], onDelete: NoAction, onUpdate: NoAction, map: "fk_experiment_assignment_pr_metrics")
      pr_review_commenters     pr_review_commenters[]

      @@unique([org_id, pr_url], name: "pr_metrics_org_id_pr_url_key")
      @@index([pr_url], name: "pr_metrics_pr_url_idx")
      @@index([pr_created], name: "pr_metrics_pr_created_idx")
      @@index([user_id], name: "pr_metrics_user_id_idx")
      @@index([org_id], name: "pr_metrics_org_id_idx")
      @@index([org_id, pr_created(sort: Desc)], name: "pr_metrics_org_id_created_idx")
      @@index([org_id, pr_merged, pr_url], name: "pr_metrics_org_id_merged_idx")
      @@index([repo_id], name: "pr_metrics_repo_id_idx")
    }

    model pr_review_commenters {
      id                      String               @id() @default(cuid())
      user_id                 String
      username                String?              @db.Text
      name                    String?              @db.Text
      pr_metrics_id           String
      first_comment_timestamp DateTime
      org_id                  String               @db.Uuid
      comments_count          Int
      pr_comment_details      pr_comment_details[]
      pr_metrics              pr_metrics           @relation(fields: [pr_metrics_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_pr_review_commenters_pr_metrics")
      organization            organizations        @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_pr_review_commenters_organizations")

      @@index([pr_metrics_id], name: "pr_review_commenters_pr_metrics_idx")
      @@index([user_id], name: "pr_review_commenters_user_id_idx")
      @@index([first_comment_timestamp], name: "pr_review_commenters_first_comment_timestamp_idx")
      @@index([org_id], name: "pr_review_commenters_org_id_idx")
      @@index([org_id, user_id], name: "pr_review_commenters_org_user_idx")
    }

    model pr_comment_details {
      id                      String               @id() @default(cuid())
      pr_review_commenters_id String
      comment_url             String
      comment_timestamp       DateTime?
      updated_at              DateTime?
      type                    COMMENT_TYPE
      state                   String?
      file_path               String?              @db.VarChar(2000)
      line_number             Int?
      comment_id              String?              @db.VarChar(255)
      org_id                  String               @db.Uuid
      in_reply_to_id          String?              @db.Text
      pr_review_commenters    pr_review_commenters @relation(fields: [pr_review_commenters_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_pr_comment_details_pr_review_commenters")
      organization            organizations        @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_pr_comment_details_organizations")

      @@index([pr_review_commenters_id], name: "pr_comment_details_pr_review_commenters_idx")
      @@index([comment_url], name: "pr_comment_details_comment_url_idx")
      @@index([org_id], name: "pr_comment_details_org_id_idx")
      @@index([in_reply_to_id], name: "pr_comment_details_in_reply_to_id_idx")
      @@index([pr_review_commenters_id, comment_timestamp(sort: Desc)], name: "pr_comment_details_commenter_timestamp_idx")
      @@index([comment_timestamp], name: "pr_comment_details_comment_timestamp_idx")
      @@index([org_id, comment_timestamp(sort: Desc)], name: "pr_comment_details_org_timestamp_idx")
    }

    model pr_comment_metrics {
      id                     String                 @id @default(uuid()) @db.Uuid
      org_id                 String                 @db.Uuid
      repo_id                String                 @db.VarChar(255)
      author_id              String                 @db.VarChar(255)
      pr_url                 String?                @db.VarChar(1000)
      comment_url            String                 @db.VarChar(1000)
      accepted               Boolean?               @default(false)
      severity_tags          String?                @db.VarChar(1000)
      issue_types            String?                @db.VarChar(1000)
      category_tags          String?                @db.VarChar(100)
      categorized_model      String?                @db.VarChar(100)
      categorized_at         DateTime?              @db.Timestamptz(6)
      categorized_confidence Decimal?               @db.Decimal(3, 2)
      createdAt              DateTime               @default(now()) @db.Timestamptz(6)
      organization           organizations          @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_organization_pr_comment_metrics")
      model_info             pr_comment_model_info?

      @@index([org_id], name: "pr_comment_metrics_org_id_idx")
      @@index([pr_url], name: "pr_comment_metrics_pr_url_idx")
      @@index([comment_url], name: "pr_comment_metrics_comment_url_idx")
      @@index([repo_id], name: "pr_comment_metrics_repo_id_idx")
      @@index([author_id], name: "pr_comment_metrics_author_id_idx")
      @@index([category_tags], name: "pr_comment_metrics_category_tags_idx")
      @@index([categorized_at], name: "pr_comment_metrics_categorized_at_idx")
      @@index([org_id, pr_url], name: "pr_comment_metrics_org_prurl_idx")
    }

    model suggestion_metrics {
      id                      String        @id() @default(cuid())
      org_id                  String        @db.Uuid()
      pr_url                  String
      ai_confirmed_count      Int
      total_suggestions       Int
      accepted_comment_count  Int           @default(0)
      review_comment_count    Int           @default(0)
      total_issue_cmnts       Int           @default(0)
      total_refactor_cmnts    Int           @default(0)
      total_nitpick_cmnts     Int           @default(0)
      accepted_issue_cmnts    Int           @default(0)
      accepted_refactor_cmnts Int           @default(0)
      accepted_nitpick_cmnts  Int           @default(0)
      user_confirmed_count    Int           @default(0)
      created_at              DateTime      @default(now())
      updated_at              DateTime      @updatedAt
      organization            organizations @relation(fields: [org_id], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "fk_organization_suggestion_metrics")

      @@unique([org_id, pr_url], name: "suggestion_metrics_org_id_pr_url_key")
      @@index([pr_url], name: "suggestion_metrics_pr_url_idx")
      @@index([created_at], name: "suggestion_metrics_created_at_idx")
      @@index([org_id], name: "suggestion_metrics_org_id_idx")
    }

</schema>

Look for any instructions provided by user in <feedback> tag.
