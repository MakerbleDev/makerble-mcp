/**
 * makerble-tools.js
 * All 43 Makerble MCP tool definitions.
 * Imported by server.js and used by both transports (stdio & HTTP).
 */

import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

// ─── HTTP helper ──────────────────────────────────────────────────────────────

export function makeApiClient(baseUrl, email, token) {
  async function request(method, path, body = null, params = null) {
    if (!email || !token) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "MAKERBLE_EMAIL and MAKERBLE_TOKEN environment variables must be set."
      );
    }

    let url = `${baseUrl}${path}`;
    if (params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) qs.append(`${k}[]`, String(item));
        } else {
          qs.append(k, String(v));
        }
      }
      const qstr = qs.toString();
      if (qstr) url += `?${qstr}`;
    }

    const headers = {
      "X-User-Email": email,
      "X-User-Token": token,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    const text = await res.text();

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok) {
      const msg = data?.error || data?.errors || `HTTP ${res.status} ${res.statusText}`;
      throw new McpError(ErrorCode.InternalError, `Makerble API error: ${JSON.stringify(msg)}`);
    }
    return data;
  }

  return {
    get: (path, params) => request("GET", path, null, params),
    post: (path, body) => request("POST", path, body),
    postBearer: async (path, body, bearerToken) => {
      const url = `${baseUrl}${path}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!res.ok) {
        const msg = data?.error || data?.errors || `HTTP ${res.status} ${res.statusText}`;
        throw new McpError(ErrorCode.InternalError, `Makerble API error: ${JSON.stringify(msg)}`);
      }
      return data;
    },
    signIn: async (email, password) => {
      const body = new URLSearchParams({
        "user[email]": email,
        "user[password]": password,
      });
      const res = await fetch(`${baseUrl}/users/sign_in`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      return res.json();
    },
  };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function buildTools(api) {
  const { get, post, postBearer, signIn } = api;

  return [
    // ── Authentication ────────────────────────────────────────────────────────
    {
      name: "makerble_sign_in",
      description:
        "Authenticate with Makerble and retrieve a long-lived token. " +
        "Returns user_id, email, and authentication_token. Tokens do not expire.",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string" },
          password: { type: "string" },
        },
        required: ["email", "password"],
      },
      handler: ({ email, password }) => signIn(email, password),
    },

    // ── Organisations ─────────────────────────────────────────────────────────
    {
      name: "makerble_get_organisation",
      description:
        "Get a single Organisation (Charity) by ID. Organisations own Projects.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/charities/${id}`),
    },

    // ── Projects ──────────────────────────────────────────────────────────────
    {
      name: "makerble_list_projects",
      description:
        "List all Projects accessible to the authenticated user. " +
        "Supports pagination and incremental sync via last_synced_datetime.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/projects", p),
    },

    {
      name: "makerble_get_project",
      description: "Get a single Project by ID.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/projects/${id}`),
    },

    {
      name: "makerble_add_users_to_project",
      description:
        "Add users to a Project with a role. Roles: editor (Manager), reporter (Changemaker), observer (Analyst). " +
        "A user can hold multiple roles simultaneously.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number" },
          editor_ids: { type: "array", items: { type: "number" } },
          reporter_ids: { type: "array", items: { type: "number" } },
          observer_ids: { type: "array", items: { type: "number" } },
        },
        required: ["project_id"],
      },
      handler: ({ project_id, editor_ids, reporter_ids, observer_ids }) =>
        post("/projects/add_colleague.json", {
          role_data: [{
            project_id,
            ...(editor_ids   ? { editor_ids }   : {}),
            ...(reporter_ids ? { reporter_ids } : {}),
            ...(observer_ids ? { observer_ids } : {}),
          }],
        }),
    },

    // ── Users ─────────────────────────────────────────────────────────────────
    {
      name: "makerble_list_users",
      description: "List all Users accessible to the authenticated user.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/users", p),
    },

    {
      name: "makerble_get_user",
      description: "Get a single User by ID.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/users/${id}`),
    },

    {
      name: "makerble_create_user",
      description:
        "Create a new Makerble user. Requires an auth_code API key from api-key-request@makerble.com. " +
        "Password: 8+ chars, 1 number, 1 special char, 1 capital letter.",
      inputSchema: {
        type: "object",
        properties: {
          auth_code: { type: "string" },
          email: { type: "string" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          password: { type: "string" },
          charity_id: { type: "number" },
          charity_controlled: { type: "boolean", default: false },
          disable_email_notification: { type: "boolean", default: false },
        },
        required: ["auth_code", "email", "first_name", "last_name", "password", "charity_id"],
      },
      handler: ({ auth_code, email, first_name, last_name, password, charity_id,
        charity_controlled = false, disable_email_notification = false }) =>
        post("/users", {
          auth_code,
          user: { email, first_name, last_name, password, password_confirmation: password },
          charity_id,
          charity_controlled: String(charity_controlled),
          disable_email_notification: String(disable_email_notification),
        }),
    },

    // ── Contacts (Beneficiaries) ───────────────────────────────────────────────
    {
      name: "makerble_list_contacts",
      description:
        "List all Contacts (Beneficiaries). Filter by charity_id or project_id. " +
        "Response includes custom fields from the Contact Bio Form.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
          charity_id: { type: "number" },
          project_id: { type: "number" },
        },
      },
      handler: (p) => get("/beneficiaries", p),
    },

    {
      name: "makerble_get_contact",
      description: "Get a single Contact (Beneficiary) by ID, including all custom fields.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/beneficiaries/${id}`),
    },

    {
      name: "makerble_create_contact",
      description:
        "Create a new Contact (Beneficiary). Required: name, owner_id. " +
        "Call makerble_list_contact_bio_form_fields first to get custom field IDs. " +
        "Call makerble_list_contact_types to get beneficiary_type_id (1=Person, 2=Object, 3=Organisation, 4=Animal).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          owner_id: { type: "number" },
          date_of_birth: { type: "string", description: "Format: DD-MM-YYYY" },
          address: { type: "string" },
          latitude: { type: "string" },
          longitude: { type: "string" },
          beneficiary_type_id: { type: "number", default: 1 },
          project_ids: { type: "array", items: { type: "number" } },
          beneficiary_category_ids: { type: "array", items: { type: "number" } },
          custom_fields: {
            type: "object",
            description: "Dictionary of custom_field_id (string key) to value",
          },
        },
        required: ["name", "owner_id"],
      },
      handler: ({ name, owner_id, date_of_birth, address, latitude, longitude,
        beneficiary_type_id = 1, project_ids, beneficiary_category_ids, custom_fields }) =>
        post("/beneficiaries", {
          beneficiary: {
            name, owner_id, beneficiary_type_id,
            ...(date_of_birth ? { date_of_birth } : {}),
            ...(address  ? { address }  : {}),
            ...(latitude ? { latitude } : {}),
            ...(longitude ? { longitude } : {}),
          },
          ...(project_ids              ? { project_ids }              : {}),
          ...(beneficiary_category_ids ? { beneficiary_category_ids } : {}),
          ...(custom_fields            ? { custom_fields }            : {}),
        }),
    },

    {
      name: "makerble_get_contact_impact_box",
      description:
        "Get the Progress Trackers (Impact Box) data — aggregated metric progress per Contact.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/beneficiaries/impact_box_data", p),
    },

    {
      name: "makerble_get_contact_summary",
      description:
        "Get the AI summary (made by SummaryMaker) of one Contact (Beneficiary): three sections, " +
        "'Who', 'Progress' and 'Watch for', written from the Contact's bio and the Stories (Survey Responses / Updates) " +
        "that the signed-in user is allowed to see. Use it for a quick picture of a Contact before a session or meeting. " +
        "Every sentence lists its sources: bio=true if it came from the bio, and story_ids for the Stories it came from " +
        "(fetch one with makerble_get_story to check the detail). " +
        "\nstatus: 'ready' = the summary is current; 'stale' = an older summary is returned and new_story_count Stories " +
        "have been added since; 'pending' = SummaryMaker is writing it (summary may be null or the previous version), " +
        "so wait about 10 seconds and call again; 'failed' = it could not be made, call again with update=true; " +
        "'empty' = there is nothing to summarise yet. " +
        "\nSet update=true to make a fresh summary (like the 'Update summary' button), e.g. when status is 'stale'. " +
        "Only works for organisations that have AI enabled (403 otherwise).",
      inputSchema: {
        type: "object",
        properties: {
          contact_id: { type: "number", description: "Contact (Beneficiary) ID" },
          update: {
            type: "boolean",
            description: "true to regenerate the summary from the latest bio and Stories",
            default: false,
          },
        },
        required: ["contact_id"],
      },
      handler: ({ contact_id, update }) =>
        update
          ? post(`/beneficiaries/${contact_id}/summary`, {})
          : get(`/beneficiaries/${contact_id}/summary`),
    },

    // ── Contact Bio Forms (Beneficiary Categories) ────────────────────────────
    {
      name: "makerble_list_contact_bio_forms",
      description:
        "List all Contact Bio Forms (Beneficiary Categories) — the schemas defining fields for creating Contacts.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/beneficiary_categories", p),
    },

    {
      name: "makerble_get_contact_bio_form",
      description: "Get a single Contact Bio Form (Beneficiary Category) by ID.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/beneficiary_categories/${id}`),
    },

    {
      name: "makerble_list_contact_bio_form_fields",
      description:
        "List custom field definitions for Contact Bio Forms. " +
        "Filter by beneficiary_category_ids. Use field IDs when creating a contact.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          beneficiary_category_ids: { type: "array", items: { type: "number" } },
        },
      },
      handler: ({ beneficiary_category_ids, ...p }) =>
        get("/custom_fields", { ...p, ...(beneficiary_category_ids ? { beneficiary_category_ids } : {}) }),
    },

    {
      name: "makerble_list_contact_types",
      description:
        "List the four Contact Types: Person (1), Object (2), Organisation (3), Animal (4). " +
        "Use the ID as beneficiary_type_id when creating a contact.",
      inputSchema: { type: "object", properties: {} },
      handler: () => get("/beneficiary_types"),
    },

    // ── Stories ───────────────────────────────────────────────────────────────
    {
      name: "makerble_list_stories",
      description:
        "List all Stories visible to the authenticated user. " +
        "Timestamps: actual_created_at=Date Posted, created_at=Date Happened, updated_at=Date Edited.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/stories", p),
    },

    {
      name: "makerble_get_story",
      description:
        "Get a single Story by ID with full detail — custom fields, beneficiary tags, case links, " +
        "indicator responses, change values, and verdict scores.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/stories/${id}`),
    },

    {
      name: "makerble_get_story_survey_responses",
      description:
        "Get Stories with full named survey response data — indicator names, change names, custom field values. " +
        "Ideal for reporting. Filter by story_category_id, project_ids, start_date, end_date.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          story_category_id: { type: "number" },
          project_ids: { type: "array", items: { type: "number" } },
          start_date: { type: "string", description: "YYYY-MM-DD" },
          end_date: { type: "string", description: "YYYY-MM-DD" },
        },
      },
      handler: ({ project_ids, ...p }) =>
        get("/stories/story_category_response", { ...p, ...(project_ids ? { project_ids } : {}) }),
    },

    {
      name: "makerble_create_story",
      description:
        "Create a new Story (Survey Response / Update). " +
        "Supports zero, one, or multiple contacts. For stories linked to Cases, include case_ids (single contact only). " +
        "\nWorkflow: (1) makerble_get_survey → see fields/indicators/outcome_ids. " +
        "(2) makerble_list_answer_choices with ratio_set_ids → get sub_ratio_ids for scale questions. " +
        "(3) Submit here. " +
        "\nRules: story_group='change_created', story_format='old'. " +
        "date_happened=YYYY-MM-DD (the activity date). " +
        "Binary indicators: binray_indicator_value='on' if ticked, omit the record if not. " +
        "Activity changes: only in story_changes, NOT story_change_beneficiaries.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number" },
          story_category_id: { type: "number" },
          text: { type: "string", description: "Narrative text. Supports Markdown." },
          date_happened: { type: "string", description: "Activity date YYYY-MM-DD" },
          beneficiary_ids: { type: "array", items: { type: "number" } },
          case_ids: { type: "array", items: { type: "number" } },
          story_privacy: {
            type: "string",
            enum: ["only_charity_colleagues", "public", "specific_individuals_only"],
            default: "only_charity_colleagues",
          },
          story_changes: {
            type: "array",
            description: "Metric totals: [{change_id, number}]",
            items: {
              type: "object",
              properties: {
                change_id: { type: "number" },
                number: { type: "number" },
              },
            },
          },
          story_change_beneficiaries: {
            type: "array",
            description: "Per-contact participation records (Participation Changes only): [{change_id, beneficiary_id}]",
            items: {
              type: "object",
              properties: {
                change_id: { type: "number" },
                beneficiary_id: { type: "number" },
              },
            },
          },
          story_indicator_beneficiaries: {
            type: "array",
            description:
              "Per-contact indicator responses. Each: {indicator_id, indicator_type, outcome_id, beneficiary_id, " +
              "sub_ratio_id (scale), binray_indicator_value='on' (binary), number (value)}",
            items: {
              type: "object",
              properties: {
                indicator_id: { type: "number" },
                indicator_type: { type: "string", enum: ["scale", "binary", "value"] },
                outcome_id: { type: "number" },
                beneficiary_id: { type: "number" },
                sub_ratio_id: { type: "number" },
                binray_indicator_value: { type: "string", enum: ["on"] },
                number: { type: "number" },
              },
            },
          },
          custom_fields: {
            type: "object",
            description: "Survey field values: {custom_field_id: value}",
          },
        },
        required: ["project_id", "story_category_id"],
      },
      handler: ({ project_id, story_category_id, text, date_happened, beneficiary_ids,
        case_ids, story_privacy = "only_charity_colleagues", story_changes,
        story_change_beneficiaries, story_indicator_beneficiaries, custom_fields }) =>
        post("/stories", {
          story: {
            story_group: "change_created",
            story_format: "old",
            display_as: "survey_questions_view",
            project_id,
            story_category_id,
            source_of_story: "api",
            ...(text          ? { text }                      : {}),
            ...(date_happened ? { created_at: date_happened } : {}),
          },
          story_privacy,
          individual_list: [],
          beneficiary_ids:               beneficiary_ids               || [],
          case_ids:                       case_ids                       || [],
          story_changes:                  story_changes                  || [],
          story_change_beneficiaries:     story_change_beneficiaries     || [],
          story_indicator_beneficiaries:  story_indicator_beneficiaries  || [],
          custom_fields:                  custom_fields                  || {},
        }),
    },

    // ── Surveys (Story Categories) ─────────────────────────────────────────────
    {
      name: "makerble_list_surveys",
      description: "List all Surveys (Story Categories) visible to the authenticated user.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/story_categories", p),
    },

    {
      name: "makerble_get_survey",
      description:
        "Get a single Survey (Story Category) with full detail: current_fields (ordered questions with " +
        "field_class_name, outcome_id, indicator_type), scale_indicator_choices (choice config per indicator), " +
        "and verdict_data (scoring bands). Always call this before creating a story.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/story_categories/${id}`),
    },

    {
      name: "makerble_get_survey_verdict_scores",
      description:
        "Get verdict scoring results for a Survey Campaign — total points per contact per submission, grouped by beneficiary.",
      inputSchema: {
        type: "object",
        properties: {
          story_category_id: { type: "number" },
          project_id: { type: "number" },
          page: { type: "number" },
          per_page: { type: "number" },
        },
        required: ["story_category_id", "project_id"],
      },
      handler: ({ story_category_id, ...p }) =>
        get(`/story_categories/${story_category_id}/verdicts`, p),
    },

    {
      name: "makerble_list_survey_campaigns",
      description:
        "List all Survey Campaigns (Project Story Categories) — Surveys deployed to specific Projects.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/project_story_categories", p),
    },

    {
      name: "makerble_list_survey_waves",
      description:
        "List the Waves of a Survey Campaign (Project Story Category). A Wave is a named round of a " +
        "longitudinal survey (e.g. Baseline, Midline, Exit). Use this to find the send_survey_wave_id " +
        "to pass to makerble_create_survey_links when the Survey Campaign uses Waves. " +
        "Returns an empty list when it doesn't. Get project_story_category_id from makerble_list_survey_campaigns.",
      inputSchema: {
        type: "object",
        properties: {
          project_story_category_id: { type: "number", description: "The Survey Campaign (Project Story Category) ID" },
          page: { type: "number" },
          per_page: { type: "number", description: "Default 10, max 200" },
        },
        required: ["project_story_category_id"],
      },
      handler: ({ project_story_category_id, ...p }) =>
        get(`/project_story_categories/${project_story_category_id}/survey_waves`, p),
    },

    {
      name: "makerble_create_survey_links",
      description:
        "Generate personal survey links (Survey Invitation links / survey tokens) for Contacts (Beneficiaries) " +
        "in a Survey Campaign (Project Story Category). THIS DOES NOT SEND ANYTHING: no email or SMS goes out. " +
        "It returns one URL per Contact, which you can share yourself or open to fill in the survey on the " +
        "Contact's behalf (e.g. during a phone interview). Each response submitted through the link is recorded " +
        "against that Contact. " +
        "\nWorkflow: (1) makerble_list_survey_campaigns → project_story_category_id. " +
        "(2) If you only need an existing link, call makerble_list_survey_links with beneficiary_id first and reuse it. " +
        "(3) If the Survey Campaign uses Waves, makerble_list_survey_waves → send_survey_wave_id. " +
        "(4) Call this tool. " +
        "\nRecipients: beneficiary_ids must be Contacts already in the Survey Campaign's Project. emails can be any " +
        "address: it is matched to an existing Contact of the organisation, or a new Contact is created. " +
        "At most 200 beneficiary_ids + emails per call. " +
        "\nlink_expiry: 'use_once' (default) — the link stops working after one response; " +
        "'evergreen' — the link stays active for repeat responses. " +
        "Requires Project Editor or Organisation Editor access. " +
        "Returns send_survey_id and data: [{beneficiary_id, email, survey_token, survey_url, link_expiry, " +
        "is_anonymised, send_survey_wave_id, expired, created_at}].",
      inputSchema: {
        type: "object",
        properties: {
          project_story_category_id: { type: "number", description: "The Survey Campaign (Project Story Category) ID" },
          beneficiary_ids: { type: "array", items: { type: "number" }, description: "Contact IDs in the Survey Campaign's Project" },
          emails: { type: "array", items: { type: "string" }, description: "Email addresses; matched to or creating Contacts. Nothing is emailed." },
          send_survey_wave_id: { type: "number", description: "Optional Wave ID from makerble_list_survey_waves" },
          link_expiry: { type: "string", enum: ["use_once", "evergreen"], default: "use_once" },
          is_anonymised: { type: "boolean", default: false, description: "Record responses anonymously" },
        },
        required: ["project_story_category_id"],
      },
      handler: ({ project_story_category_id, ...body }) =>
        post(`/project_story_categories/${project_story_category_id}/survey_links`, body),
    },

    {
      name: "makerble_list_survey_links",
      description:
        "List existing personal survey links (Survey Invitation links / survey tokens) for a Survey Campaign " +
        "(Project Story Category). Use it to find a Contact's (Beneficiary's) existing link and reuse it instead " +
        "of generating a new one with makerble_create_survey_links. Check `expired`: a 'use_once' link that has " +
        "already been answered is expired and no longer works. " +
        "Filter by beneficiary_id and/or send_survey_wave_id. Requires Project Editor or Organisation Editor access. " +
        "Returns {page, page_size, page_count, total_count, data: [{beneficiary_id, email, survey_token, survey_url, " +
        "link_expiry, is_anonymised, send_survey_wave_id, expired, created_at}]}.",
      inputSchema: {
        type: "object",
        properties: {
          project_story_category_id: { type: "number", description: "The Survey Campaign (Project Story Category) ID" },
          beneficiary_id: { type: "number", description: "Only this Contact's links" },
          send_survey_wave_id: { type: "number", description: "Only links for this Wave" },
          page: { type: "number" },
          per_page: { type: "number", description: "Default 10, max 200" },
          last_sync_datetime: { type: "string", description: "Only links changed after this ISO 8601 time" },
        },
        required: ["project_story_category_id"],
      },
      handler: ({ project_story_category_id, ...p }) =>
        get(`/project_story_categories/${project_story_category_id}/survey_links`, p),
    },

    // ── Cases ──────────────────────────────────────────────────────────────────
    {
      name: "makerble_list_cases",
      description: "List all Cases. Each Case belongs to one Contact and one Project.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/cases", p),
    },

    {
      name: "makerble_create_case",
      description:
        "Create a new Case for a Contact within a Project. " +
        "Call makerble_list_case_forms first to discover custom field IDs.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number" },
          beneficiary_id: { type: "number" },
          title: { type: "string" },
          case_owner_id: { type: "number" },
          case_worker_ids: { type: "array", items: { type: "number" } },
          custom_field_categories_definition: {
            type: "object",
            description: "Case form field values: {field_definition_id: value}",
          },
        },
        required: ["project_id", "beneficiary_id"],
      },
      handler: ({ project_id, beneficiary_id, title, case_owner_id,
        case_worker_ids, custom_field_categories_definition }) =>
        post("/cases", {
          case: { ...(title ? { title } : {}) },
          project_id,
          beneficiary_id,
          ...(case_owner_id                    ? { case_owner_id }                    : {}),
          ...(case_worker_ids                  ? { case_worker_ids }                  : {}),
          ...(custom_field_categories_definition ? { custom_field_categories_definition } : {}),
        }),
    },

    {
      name: "makerble_list_case_forms",
      description:
        "List all Case Forms (Custom Field Categories) — field schemas for creating Cases.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/custom_field_categories", p),
    },

    // ── Metrics ────────────────────────────────────────────────────────────────
    {
      name: "makerble_list_changes",
      description:
        "List all Changes (Activity & Participation custom KPIs). " +
        "Activity = col 1 of Progress Panel; Participation = col 2.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/changes", p),
    },

    {
      name: "makerble_list_indicators",
      description:
        "List the Indicators (scale/binary/value) the signed-in user can see: their own, and those of every organisation where they are an editor, reporter or observer. Linked to Outcomes. Progress Panel cols 3–5. " +
        "The Indicator library shared by all organisations (the public library) is left out unless include_public_library is true, the same as the Indicator search in the Makerble app. " +
        "Set it when looking for an existing Indicator to reuse rather than listing the organisation's own.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
          include_public_library: {
            type: "boolean",
            description:
              "Also return public-library Indicators from other organisations. Default false.",
          },
        },
      },
      handler: (p) => get("/indicators", p),
    },

    {
      name: "makerble_get_indicator",
      description:
        "Get a single Indicator by ID with full detail. Returns not-found for an Indicator the signed-in user cannot see. " +
        "A public-library Indicator owned by another organisation is only returned when include_public_library is true.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          include_public_library: {
            type: "boolean",
            description:
              "Allow a public-library Indicator from another organisation to be returned. Default false.",
          },
        },
        required: ["id"],
      },
      handler: ({ id, include_public_library }) =>
        get(`/indicators/${id}`, { include_public_library }),
    },

    {
      name: "makerble_list_outcomes",
      description:
        "List all Outcomes. Each has a stage (short/medium/long-term) placing it in Progress Panel cols 3–5.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/outcomes", p),
    },

    {
      name: "makerble_get_outcome",
      description: "Get a single Outcome by ID.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/outcomes/${id}`),
    },

    {
      name: "makerble_list_outcome_indicators",
      description:
        "List all Outcome–Indicator pairings. Use to find the outcome_id to supply when creating story indicator responses.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/outcome_indicators", p),
    },

    // ── Story metric sub-resources ─────────────────────────────────────────────
    {
      name: "makerble_list_story_changes",
      description:
        "List Story Changes — per-story metric totals. Filter by story_id.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          story_id: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/story_changes", p),
    },

    {
      name: "makerble_list_story_indicator_beneficiaries",
      description:
        "List Story Indicator Beneficiary records — per-contact indicator responses. Filter by story_id.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          story_id: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/story_indicator_beneficiaries", p),
    },

    // ── Dropdowns (Ratio Sets / Sub Ratios) ────────────────────────────────────
    {
      name: "makerble_list_dropdown_fields",
      description:
        "List all Dropdown/List fields (Ratio Sets). Type 'identity' = Contact Bio Forms; 'progress' = Scale Indicators.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/ratio_sets", p),
    },

    {
      name: "makerble_list_answer_choices",
      description:
        "List answer choices (Sub Ratios) within Dropdown/List fields. " +
        "Filter by ratio_set_ids. Use returned IDs as sub_ratio_id in story indicator responses.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number" },
          ratio_set_ids: { type: "array", items: { type: "number" } },
          last_synced_datetime: { type: "string" },
        },
      },
      handler: ({ ratio_set_ids, ...p }) =>
        get("/sub_ratios", { ...p, ...(ratio_set_ids ? { ratio_set_ids } : {}) }),
    },

    // ── Signup Pages / Offline Collector ────────────────────────────────────────
    {
      name: "makerble_get_signup_page_offline_definition",
      description:
        "Get the Form Definition for a Signup Page (Referral Link Detail) — its contact form " +
        "and survey fields, skip logic, branding, and settings, in the same JSON shape the " +
        "Offline Collector app uses. Useful for inspecting or testing a Signup Page's offline " +
        "form before it goes out to field workers. Uses your own Makerble credentials, and only " +
        "works for Signup Pages belonging to an organisation you have access to. Does not include " +
        "the offline submission bearer token — that's only issued to the offline device itself.",
      inputSchema: {
        type: "object",
        properties: {
          signup_page_id: { type: "number", description: "The Signup Page (Referral Link Detail) ID" },
        },
        required: ["signup_page_id"],
      },
      handler: ({ signup_page_id }) => get(`/referral_link_details/${signup_page_id}/definition`),
    },

    {
      name: "makerble_sync_offline_signup_submission",
      description:
        "Submit a completed offline Signup Page response — the same call an Offline Collector " +
        "device makes once it regains connectivity. Mainly useful for testing the offline flow " +
        "end-to-end (e.g. simulating a field worker's submission). Requires a submission_token " +
        "(the submission_credential.token from an offline Form Definition fetch), not your own " +
        "Makerble login. idempotency_key should be a fresh UUID per submission — retrying the " +
        "same key returns the original result rather than creating duplicates. Use `primary` + " +
        "`related_people` for a structured Signup Page, or `roles` for a personalised one — " +
        "never both. Every answer object is keyed by field id from the Form Definition, not name.",
      inputSchema: {
        type: "object",
        properties: {
          submission_token: { type: "string", description: "submission_credential.token from the offline Form Definition" },
          idempotency_key: { type: "string", description: "A fresh UUID v4, generated once per completed submission" },
          definition_version: { type: "string", description: "The definition_version the cached Form Definition was fetched with" },
          primary: {
            type: "object",
            description: "For a structured Signup Page: the primary person's answers",
            properties: {
              contact_form_answers: { type: "object", description: "Keyed by field id" },
              survey_answers: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    story_category_id: { type: "number" },
                    answers: { type: "object", description: "Keyed by field id" },
                  },
                },
              },
            },
          },
          related_people: {
            type: "array",
            description: "For a structured Signup Page: additional related people, each identified by referral_link_relationship_detail_id",
            items: {
              type: "object",
              properties: {
                referral_link_relationship_detail_id: { type: "number" },
                contact_form_answers: { type: "object" },
                survey_answers: { type: "array", items: { type: "object" } },
              },
            },
          },
          roles: {
            type: "array",
            description: "For a personalised Signup Page instead of primary/related_people — one entry per person, identified by referral_link_beneficiary_role_detail_id",
            items: {
              type: "object",
              properties: {
                referral_link_beneficiary_role_detail_id: { type: "number" },
                contact_form_answers: { type: "object" },
                survey_answers: { type: "array", items: { type: "object" } },
              },
            },
          },
        },
        required: ["submission_token", "idempotency_key", "definition_version"],
      },
      handler: ({ submission_token, ...body }) =>
        postBearer("/referral_submissions", body, submission_token),
    },
  ];
}

// ─── Register tools on an MCP Server instance ─────────────────────────────────

export function registerTools(server, tools) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name, description, inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      const result = await tool.handler(args || {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `Tool error: ${err.message}`);
    }
  });
}
