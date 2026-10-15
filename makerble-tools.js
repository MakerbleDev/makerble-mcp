/**
 * makerble-tools.js
 * All 95 Makerble MCP tool definitions.
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
      // Arrays become key[]=…; objects (e.g. story_filters) become
      // key[sub][]=…, the nesting Rails parses back into a hash.
      const append = (key, value) => {
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) {
          for (const item of value) append(`${key}[]`, item);
        } else if (typeof value === "object") {
          for (const [sub, inner] of Object.entries(value)) append(`${key}[${sub}]`, inner);
        } else {
          qs.append(key, String(value));
        }
      };
      for (const [k, v] of Object.entries(params)) append(k, v);
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
    patch: (path, body) => request("PATCH", path, body),
    del: (path) => request("DELETE", path),
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
  const { get, post, patch, del, postBearer, signIn } = api;

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

    {
      name: "makerble_get_project_results",
      description:
        "Get the figures shown on Projects' Results Canvas (the Results panel on a Project page): one entry per " +
        "tracker, calculated by Makerble. Use this to answer 'how much did we do?' questions (sessions delivered, " +
        "people reached, achievements, answers to a choice question, totals and averages) instead of counting " +
        "Stories yourself. " +
        "\nTracker types (front-end name, API backend type in brackets): Activity tracker (Change of Activity type) " +
        "and Engagement tracker (Change of Participation type) give times_recorded and contacts; Achievement tracker " +
        "(Indicator of Binary type) gives times_recorded and contacts_achieved; Choice tracker (Indicator of Scale " +
        "type) gives answers: a count and distinct contacts per answer (Sub Ratio); Numerical tracker (Indicator of " +
        "Value type) gives total, contacts and average_per_contact. " +
        "\ntimes_recorded counts records, including headcounts and the same Contact recorded more than once, so it " +
        "is NOT a number of people. contacts / contacts_achieved count distinct Contacts (Beneficiaries) tagged, " +
        "each person once: use those for 'how many people'. anonymous_count is what was recorded with no Contact " +
        "tagged. target, target_deadline and percent_of_target appear when the Project has a target: target " +
        "deadlines dated in the timeframe are added up, otherwise the Project's own target is used. " +
        "\nWorkflow: (1) makerble_list_projects → project_ids (omit to cover every Project you can view). " +
        "(2) Call this tool with start_date / end_date for the period (omit both for all time); Stories count by " +
        "their date. (3) group_by 'month' for a trend or 'project' to compare Projects; each tracker then has a " +
        "groups array, with zero rows for months with nothing recorded. " +
        "Only Projects you can view (Editor, Reporter or Observer of the Project or its organisation) are included. " +
        "Returns page, page_size, page_count, total_count, start_date, end_date, project_ids and data (the trackers).",
      inputSchema: {
        type: "object",
        properties: {
          project_ids: { type: "array", items: { type: "number" }, description: "Project IDs. Defaults to every Project you can view" },
          start_date: { type: "string", description: "First Story date to include, YYYY-MM-DD" },
          end_date: { type: "string", description: "Last Story date to include, YYYY-MM-DD" },
          tracker_types: {
            type: "array",
            items: { type: "string", enum: ["activity", "engagement", "achievement", "choice", "numerical"] },
            description: "Tracker types to include. Defaults to all",
          },
          group_by: { type: "string", enum: ["project", "month"], description: "Split each tracker's figures. Default: one total" },
          page: { type: "number" },
          per_page: { type: "number", description: "Trackers per page. Default 10, max 200" },
        },
      },
      handler: (p) => get("/project_results", p),
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
      name: "makerble_list_project_contacts",
      description:
        "List which Contacts (Beneficiaries) belong to which Projects. Use this to find everyone in a set of " +
        "projects, e.g. to count the contacts a report covers before looking up their details or stories. " +
        "Returns the paginated envelope {page, page_size, page_count, total_count, data}; each item is a " +
        "Project–Contact link with project_id and beneficiary_id (the Contact's ID). A contact in several of " +
        "the given projects appears once per project. Only projects the signed-in user can see are included. " +
        "Use makerble_get_contact for a contact's details.",
      inputSchema: {
        type: "object",
        properties: {
          project_ids: {
            type: "array",
            items: { type: "number" },
            description: "Only include these projects. Omit for every project the user can see.",
          },
          page: { type: "number" },
          per_page: { type: "number" },
          last_sync_datetime: { type: "string" },
        },
      },
      handler: (p) => get("/project_beneficiaries", p),
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

    // ── Versions (audit trail) ─────────────────────────────────────────────────
    {
      name: "makerble_list_versions",
      description:
        "List the Versions (audit trail) of one record: every time it was created or edited, " +
        "who did it and when, newest first. Use this to answer 'who changed this Contact, and when?'. " +
        "Only Contacts (Beneficiaries) are versioned so far, so record_type must be \"Contact\". " +
        "Find the Contact's ID first with makerble_list_contacts. " +
        "Only Charity Editors (any Contact in the organisation) and Project Editors (Contacts in their projects) can see Versions; " +
        "anything else returns not-found. " +
        "Returns {page, page_size, page_count, total_count, record: {record_type, record_id, charity_id, name, deleted}, " +
        "data: [{id, event, action (Created/Edited/Destroyed), user_id, user_name (\"System\" for background jobs such as CSV imports), created_at}]}. " +
        "One Save can write several Versions a fraction of a second apart. " +
        "To see what the record looked like in a Version, call makerble_get_version with its id.",
      inputSchema: {
        type: "object",
        properties: {
          record_type: { type: "string", enum: ["Contact"], description: "Type of record. Only \"Contact\" for now." },
          record_id: { type: "number", description: "The Contact (Beneficiary) ID." },
          page: { type: "number" },
          per_page: { type: "number", description: "Default 10, max 200." },
          last_sync_datetime: { type: "string", description: "Only Versions created after this ISO 8601 datetime." },
        },
        required: ["record_type", "record_id"],
      },
      handler: (p) => get("/versions", p),
    },

    {
      name: "makerble_get_version",
      description:
        "Get one Version (audit-trail entry) by ID, including full_object: a complete snapshot of every field " +
        "of the record as it was saved at that moment (not just the fields that changed). " +
        "Compare two Versions' full_object to see exactly what changed between them. " +
        "Get Version IDs from makerble_list_versions. Same permissions as makerble_list_versions.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "The Version ID." } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/versions/${id}`),
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
        "Only works for organisations that have turned on SummaryMaker in their preferences (403 otherwise).",
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

    // ── Media Gallery ─────────────────────────────────────────────────────────
    {
      name: "makerble_list_media",
      description:
        "List the files in the Media Gallery: every photo, video, audio file and document attached to " +
        "Stories (Survey Responses / Updates) and to Contacts' bios (Beneficiary profiles) in one organisation " +
        "(Charity). Only files from Stories and Contacts the user is already allowed to view are returned. " +
        "Use it to find photos for a newsletter, social post, funder update or Impact Report, or to see what " +
        "files exist for a Contact or Story. Requires charity_id: read it from a Project in " +
        "makerble_list_projects (each Project belongs to one organisation). Filters combine with AND: kind (photo, video, " +
        "audio, document), search (matches the start of words in the file name, Story title, Contact name and " +
        "caption), source (stories, contacts or both) and sort (newest or oldest by upload date). " +
        "Returns {page, page_size, page_count, total_count, kind_counts, data}; each item has kind, file_name, " +
        "content_type, file_size, caption, source_type (story or contact), source_id (Story id or Contact id, " +
        "for makerble_get_story / makerble_get_contact), source_title, project_id, project_name, uploaded_at " +
        "and thumbnail_url (photos only). kind_counts gives the number of files of each kind for the same " +
        "filters, ignoring kind. Story and Contact filters combine with AND, as on a Progress Board.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "Organisation (Charity) id" },
          kind: { type: "string", enum: ["photo", "video", "audio", "document"] },
          search: { type: "string", description: "Words to match in file name, Story title, Contact name or caption" },
          source: {
            type: "array",
            items: { type: "string", enum: ["stories", "contacts"] },
            description: "Which files to include: Story files, Contact bio files, or both (default both)",
          },
          sort: { type: "string", enum: ["newest", "oldest"], description: "Default newest" },
          page: { type: "number" },
          per_page: { type: "number", description: "Default 10, maximum 200" },
          last_synced_datetime: { type: "string", description: "ISO 8601; only files indexed or changed after this time" },
          story_filters: {
            type: "object",
            description:
              "Timeline (Story) Filters, as on the homepage. Keys (arrays of ids unless noted): project_ids, " +
              "story_category_ids (Surveys), bundle_ids (Albums), beneficiary_ids (Contacts tagged in the Story), " +
              "label_ids, outcome_ids, change_ids (Engagement), indicator_ids, user_ids (Authors), charity_ids, " +
              "created_at_from (Date Happened range, \"YYYY/MM/DD - YYYY/MM/DD\"). Story files must match them. " +
              "Contact bio files: project_ids matches the Contact's Project memberships; any other key means the " +
              "Contact must appear in at least one matching Story.",
            additionalProperties: true,
          },
          contact_filters: {
            type: "object",
            description:
              "Contact Filters, as on Manage Contacts. Common keys (arrays of ids): project_ids, group_ids, " +
              "beneficiary_types (Contact types: 1 Person, 2 Object, 3 Organisation, 4 Animal), " +
              "beneficiary_state_ids, created_by_ids, bundle_ids. Contact bio files must match them, and Story " +
              "files must involve at least one matching Contact.",
            additionalProperties: true,
          },
        },
        required: ["charity_id"],
      },
      handler: (p) => get("/media_items", p),
    },

    {
      name: "makerble_get_media",
      description:
        "Get one file from the Media Gallery by its id (from makerble_list_media), with a download link. " +
        "Use it when the user wants to download, open or share a specific photo, video, audio file or document " +
        "attached to a Story (Survey Response / Update) or a Contact's bio (Beneficiary profile). Permissions are " +
        "checked again: the user must still be able to view the Story or Contact. Returns the same fields as " +
        "makerble_list_media plus field_name (where the file sits: \"Profile picture\", \"<field> (file field)\", " +
        "\"Story attachment\" or \"Contact attachment\"), download_url (a signed link that downloads the file) and " +
        "download_url_expires_in (seconds, usually 300). The link expires quickly: call this tool again for a fresh " +
        "one rather than storing it.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "Media item id from makerble_list_media" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/media_items/${id}`),
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

    {
      name: "makerble_create_draft_story",
      description:
        "Save an Answer In Progress (draft Story): a partly completed survey response that a colleague " +
        "reviews, finishes and publishes in Makerble. Use this instead of makerble_create_story when a person " +
        "should check the response before it becomes a published Story, e.g. notes you've summarised from a " +
        "meeting or call. It shows on the organisation's Answers In Progress page. " +
        "\nWorkflow: (1) makerble_list_projects → project_id. (2) makerble_list_surveys or makerble_get_survey → " +
        "story_category_id (the Survey). (3) Optionally makerble_list_contacts → beneficiary_ids to tag. (4) Save here. " +
        "\nReturns draft_story_id. A 403 'Permission denied.' means the signed-in user can't record Stories in that " +
        "Project: they must be a Project editor, reporter or observer, an organisation editor or reporter, or a " +
        "worker or manager of the given Event (event_id must belong to the Project).",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number", description: "Project the response belongs to" },
          story_category_id: { type: "number", description: "Survey (Story Category) being answered" },
          text: { type: "string", description: "Narrative text of the response. Supports Markdown." },
          event_id: { type: "number", description: "Optional Event this response is for; must belong to project_id" },
          beneficiary_ids: {
            type: "array",
            items: { type: "number" },
            description: "Contact (Beneficiary) IDs to tag",
          },
          story_privacy: {
            type: "string",
            enum: ["only_charity_colleagues", "public", "specific_individuals_only"],
            default: "only_charity_colleagues",
          },
          custom_fields: {
            type: "object",
            description: "Survey field values: {custom_field_id: value}",
          },
        },
        required: ["project_id", "story_category_id", "text"],
      },
      handler: ({ project_id, story_category_id, text, event_id, beneficiary_ids,
        story_privacy = "only_charity_colleagues", custom_fields }) =>
        post("/draft_stories", {
          story: {
            project_id,
            story_category_id,
            text,
            source_of_story: "api",
            ...(event_id ? { event_id } : {}),
          },
          beneficiaries: beneficiary_ids || [],
          story_privacy,
          ...(custom_fields ? { custom_fields } : {}),
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

    // ── Cohort Trackers ───────────────────────────────────────────────────────
    {
      name: "makerble_list_cohort_trackers",
      description:
        "List an Organisation's Cohort Trackers. A Cohort Tracker is a metric that counts the Contacts " +
        "(beneficiaries) in a Project or Album who meet a set of Contact Filter criteria, e.g. " +
        "'Children attending 75%+'. Returns each tracker's name, membership ('ever_enrolled' or " +
        "'currently_enrolled') and criteria. Only an Organisation's editors and reporters, and its " +
        "project managers, can see them.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          page: { type: "number" },
          per_page: { type: "number" },
          last_sync_datetime: { type: "string" },
        },
        required: ["charity_id"],
      },
      handler: (p) => get("/cohort_trackers", p),
    },

    {
      name: "makerble_get_cohort_tracker",
      description:
        "Get one Cohort Tracker by ID, with where it is used (usage: projects, albums, templates) and " +
        "names_projects_or_albums, which is true when its criteria point at specific Projects or Albums " +
        "(so it counts against those same ones wherever it is placed).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/cohort_trackers/${id}`),
    },

    {
      name: "makerble_preview_cohort_tracker",
      description:
        "Check Cohort Tracker criteria before saving them: returns how many of the Organisation's Contacts " +
        "currently meet them (before the tracker is placed on a Project or Album), the criteria as they " +
        "would be stored, and names_projects_or_albums. criteria take any key the Contacts page's " +
        "Filters sidebar sends (the Contact Filters format); keys no filter reads are dropped. These keys " +
        "follow the Project or Album the tracker is placed on and the reporting period: project_ids " +
        "(+ project_ids_narrow: 'true' " +
        "to require all), bundle_ids (Albums), narrow_bundle_ids, projects_states_hash ({project_id: " +
        "beneficiary_state_id}), project_beneficiary_states ({project_id: {state_id: {enabled: 'true', " +
        "added_from_date: 'dd/mm/yyyy - dd/mm/yyyy', removed_from_date}}}), project_story_category_ids " +
        "(Survey Campaigns completed) with project_story_category_filter_data, attendance_rate " +
        "({change_id, from, to}), same_day_rate (Same-day rate: {change_id, qualifying_change_ids, " +
        "match: 'all'|'any', from, to, event_scope / qualifying_event_scope: 'all'|'filtered' with " +
        "event_filter_params / qualifying_event_filter_params}: on the days change_id was recorded for a " +
        "Contact at an event, the % of those days the qualifying Engagement Trackers were also recorded " +
        "for them at an event on the same date, e.g. all 4 meals on every class day = from '100', to '100'), " +
        "distance_travelled ({trackers: [{indicator_id, directions: " +
        "['improved'|'no_change'|'worsened']}], same_project}), indicator_comparisons ({indicator_id: " +
        "{response: 'any'|'latest', op, sub_ratio_ids, values}}) and indicator_sub_ratios_hash " +
        "({indicator_id: [sub_ratio_id]}). The Contacts page's other sections apply to Contacts' current " +
        "details, e.g. group_ids, beneficiary_types, age_from / age_to ({year, month, day}), " +
        "date_of_birth_from ('yyyy/mm/dd - yyyy/mm/dd'), created_by_ids, case_owner_ids, open_cases, " +
        "custom_field_value_hash, changes_hash, indicators_hash, event_ids and flag_hash. " +
        "Use makerble_list_projects, makerble_list_indicators and " +
        "makerble_list_answer_choices to find the IDs.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          criteria: { type: "object", description: "Contact Filter criteria, see the description" },
          membership: { type: "string", enum: ["ever_enrolled", "currently_enrolled"] },
        },
        required: ["charity_id"],
      },
      handler: ({ charity_id, criteria, membership }) =>
        post("/cohort_trackers/preview", {
          charity_id,
          cohort_tracker: { ...(criteria ? { criteria } : {}), ...(membership ? { membership } : {}) },
        }),
    },

    {
      name: "makerble_create_cohort_tracker",
      description:
        "Create a Cohort Tracker: a metric counting the Contacts in a Project or Album who meet criteria. " +
        "Every tracker counts only members of the Project or Album it is placed on: membership " +
        "'ever_enrolled' (default: anyone whose status History shows them Enrolled at any time) or " +
        "'currently_enrolled' (their current Project State). criteria add further conditions (see " +
        "makerble_preview_cohort_tracker for the keys). Requires an editor or reporter of the Organisation." +
        "\nWorkflow: (1) makerble_preview_cohort_tracker to check the criteria and the count. " +
        "(2) makerble_create_cohort_tracker. (3) makerble_add_cohort_tracker_to_project to place it in " +
        "a column of a Project's Impact Scorecard, optionally with a target. Albums pick it up from " +
        "their Projects automatically.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          name: { type: "string", description: "Shown next to the result, e.g. 'Children attending 75%+'" },
          description: { type: "string" },
          membership: { type: "string", enum: ["ever_enrolled", "currently_enrolled"] },
          criteria: { type: "object", description: "Contact Filter criteria" },
        },
        required: ["charity_id", "name"],
      },
      handler: ({ charity_id, ...cohort_tracker }) =>
        post("/cohort_trackers", { cohort_tracker: { charity_id, ...cohort_tracker } }),
    },

    {
      name: "makerble_update_cohort_tracker",
      description:
        "Update a Cohort Tracker's name, description, membership or criteria. Only the fields sent change. " +
        "Changes apply everywhere it is used (see makerble_get_cohort_tracker usage). Requires an " +
        "Organisation editor, or the reporter who created it.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
          description: { type: "string" },
          membership: { type: "string", enum: ["ever_enrolled", "currently_enrolled"] },
          criteria: { type: "object", description: "Replaces the stored criteria" },
        },
        required: ["id"],
      },
      handler: ({ id, ...cohort_tracker }) => patch(`/cohort_trackers/${id}`, { cohort_tracker }),
    },

    {
      name: "makerble_delete_cohort_tracker",
      description:
        "Delete a Cohort Tracker. Refused while it is used on any Project, Album or Scorecard Template; " +
        "remove it from those first.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: async ({ id }) => {
        await del(`/cohort_trackers/${id}`);
        return { deleted: true, id };
      },
    },

    {
      name: "makerble_add_cohort_tracker_to_project",
      description:
        "Place a Cohort Tracker in a column of a Project's Impact Scorecard (Edit Project Metrics), " +
        "optionally with a one-off target (a number of Contacts to reach). Columns: activities, " +
        "engagement, potential (short-term outcomes), behaviour (medium-term), growth (long-term). " +
        "The tracker and Project must belong to the same Organisation, and you need rights to edit the " +
        "Project's metrics. Returns the column and target.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Cohort Tracker ID" },
          project_id: { type: "number" },
          column: { type: "string", enum: ["activities", "engagement", "potential", "behaviour", "growth"] },
          target: { type: "number", description: "Optional one-off target" },
        },
        required: ["id", "project_id", "column"],
      },
      handler: ({ id, project_id, column, target }) =>
        post(`/cohort_trackers/${id}/projects/${project_id}`, { column, ...(target !== undefined ? { target } : {}) }),
    },

    {
      name: "makerble_get_cohort_tracker_targets",
      description:
        "Get a Cohort Tracker's targets on a Project or an Album (its Set Targets page): the one-off " +
        "target and any deadline targets ([{date, number}]). Pass project_id or album_id. For an Album, " +
        "album_target_type says whether the Album uses manual targets (where Cohort Tracker targets are set) " +
        "or automatic ones. Requires rights to edit that Project's or Album's targets.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Cohort Tracker ID" },
          project_id: { type: "number" },
          album_id: { type: "number", description: "The Album (Bundle) ID" },
        },
        required: ["id"],
      },
      handler: ({ id, project_id, album_id }) =>
        get(album_id ? `/cohort_trackers/${id}/albums/${album_id}` : `/cohort_trackers/${id}/projects/${project_id}`),
    },

    {
      name: "makerble_set_cohort_tracker_targets",
      description:
        "Set a Cohort Tracker's targets on a Project or an Album (Set Targets): target is the one-off number " +
        "of Contacts to reach; deadlines is a list of {date: 'YYYY-MM-DD', number} that REPLACES this " +
        "tracker's deadline targets there ([] clears them). A target is a level to reach, not a total that " +
        "adds up across periods, and an Album's is never the sum of its Projects'. Pass project_id or " +
        "album_id; the tracker must already be on that Project (makerble_add_cohort_tracker_to_project) or " +
        "on one of the Album's Projects. Requires rights to edit that Project's or Album's targets.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Cohort Tracker ID" },
          project_id: { type: "number" },
          album_id: { type: "number", description: "The Album (Bundle) ID" },
          target: { type: "number", description: "One-off target" },
          deadlines: {
            type: "array",
            description: "Deadline targets, replacing any already set for this tracker",
            items: {
              type: "object",
              properties: { date: { type: "string" }, number: { type: "number" } },
              required: ["date", "number"],
            },
          },
        },
        required: ["id"],
      },
      handler: ({ id, project_id, album_id, ...targets }) =>
        patch(album_id ? `/cohort_trackers/${id}/albums/${album_id}` : `/cohort_trackers/${id}/projects/${project_id}`, targets),
    },

    {
      name: "makerble_get_cohort_tracker_results",
      description:
        "Get a Cohort Tracker's result on a Project's or an Album's (Bundle's) Results Canvas, and the Contacts " +
        "(Beneficiaries) behind it. The result is a count of distinct Contacts who meet the tracker's membership " +
        "setting and all its criteria, counting only stories, events and survey responses saved in that Project " +
        "(or the Album's Projects) and dated in the window. On an Album a Contact is counted once, however many of " +
        "its Projects they are on, so an Album's result is never the sum of its Projects'. Results are worked out " +
        "afresh for each window: a Year to Date result is NOT the sum of period results. timeframe is 'period' " +
        "(the day after the previous Target Deadline up to the deadline), 'year_to_date' (the start of the " +
        "Project's year up to the deadline) or 'all_time' (default). as_of is the deadline the window ends on " +
        "(YYYY-MM-DD); without it the window ends at the next Target Deadline, or today when there is none. " +
        "Returns count, eligible_count (Contacts the criteria could judge), target ({number, date}: the deadline " +
        "target on the window's last day, else the one-off target, or null), starts_on, ends_on, and a paginated " +
        "list of Contacts (data: [{id, name, qualifying_value}], alphabetically). qualifying_value is the value " +
        "that qualified the Contact where there is one, named by qualifying_value_label (e.g. 'Attendance rate', " +
        "a percentage). A Contact you may not read is listed as {restricted: true} with no details. Pass " +
        "project_id or album_id; the tracker must be on that Project, or on one of the Album's Projects. Find " +
        "trackers with makerble_list_cohort_trackers.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Cohort Tracker ID" },
          project_id: { type: "number" },
          album_id: { type: "number", description: "The Album (Bundle) ID" },
          timeframe: { type: "string", enum: ["period", "year_to_date", "all_time"], description: "Default all_time" },
          as_of: { type: "string", description: "The deadline the window ends on, YYYY-MM-DD" },
          page: { type: "number" },
          per_page: { type: "number", description: "Contacts per page, default 10, max 200" },
        },
        required: ["id"],
      },
      handler: ({ id, project_id, album_id, ...params }) =>
        get(album_id ? `/cohort_trackers/${id}/albums/${album_id}/results` : `/cohort_trackers/${id}/projects/${project_id}/results`, params),
    },

    {
      name: "makerble_remove_cohort_tracker_from_project",
      description: "Remove a Cohort Tracker from a Project's Impact Scorecard, and its Albums if no other Project in them uses it.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Cohort Tracker ID" },
          project_id: { type: "number" },
        },
        required: ["id", "project_id"],
      },
      handler: async ({ id, project_id }) => {
        await del(`/cohort_trackers/${id}/projects/${project_id}`);
        return { removed: true, id, project_id };
      },
    },

    // ── Workflow Trackers ─────────────────────────────────────────────────────
    {
      name: "makerble_list_workflow_trackers",
      description:
        "List an Organisation's Workflow Trackers. A Workflow Tracker is a metric that counts records " +
        "Makerble's own features create, rather than Contacts tagged in updates. Its source says what it " +
        "counts: 'signpostings' (Signpostings made from a Project) or 'internal_referrals' (Contacts in a " +
        "Project added to another of the Organisation's Projects). count_mode is 'items' (each signposting " +
        "or referral; result_kind 'additive', adds up across periods) or 'contacts' (each Contact once; " +
        "result_kind 'snapshot'). Only an Organisation's editors and reporters, and its project managers, " +
        "can see them.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
        required: ["charity_id"],
      },
      handler: (p) => get("/workflow_trackers", p),
    },

    {
      name: "makerble_get_workflow_tracker",
      description:
        "Get one Workflow Tracker by ID: its source, count_mode, result_kind, settings and where it is used " +
        "(usage: projects, albums, templates).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/workflow_trackers/${id}`),
    },

    {
      name: "makerble_preview_workflow_tracker",
      description:
        "Check what a Workflow Tracker would count before saving it: returns its result on one of the " +
        "Organisation's Projects for the current period (ending at the Project's next deadline, or today), " +
        "Year to Date and All-time, and the latest records it counts (Contact name, who they were " +
        "signposted to or which Project they were referred to, and when). Takes the same source, " +
        "count_mode and settings as makerble_create_workflow_tracker.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          project_id: { type: "number", description: "The Project to preview the result on" },
          source: { type: "string", enum: ["signpostings", "internal_referrals"] },
          count_mode: { type: "string", enum: ["items", "contacts"] },
          settings: { type: "object", description: "See makerble_create_workflow_tracker" },
        },
        required: ["charity_id", "project_id", "source"],
      },
      handler: ({ charity_id, project_id, ...workflow_tracker }) =>
        post("/workflow_trackers/preview", { charity_id, project_id, workflow_tracker }),
    },

    {
      name: "makerble_create_workflow_tracker",
      description:
        "Create a Workflow Tracker: a metric counting records Makerble creates as a team works. source: " +
        "'signpostings' counts Signpostings made from the Project (or an Album's Projects) it is placed on; " +
        "one signposting counts once whether it names the Organisation signposted to, the Person, or both, " +
        "and signpostings saved without a Project are not counted anywhere. 'internal_referrals' counts " +
        "Contacts in the Project who are added to another of the Organisation's Projects, dated by the " +
        "Status in Projects history; settings choose which Projects count: {destinations: 'any'} (any " +
        "other Project), {destinations: 'only', project_ids: [...]} or {destinations: 'except', " +
        "project_ids: [...]} (default 'except' with none listed). count_mode 'items' (default) counts each " +
        "signposting or referral and adds up across periods; 'contacts' counts each Contact once and is a " +
        "snapshot. Requires an editor or reporter of the Organisation." +
        "\nWorkflow: (1) makerble_list_projects for Project IDs. (2) makerble_preview_workflow_tracker to " +
        "check the count. (3) makerble_create_workflow_tracker. (4) makerble_add_workflow_tracker_to_project " +
        "to place it in a column of a Project's Impact Scorecard, optionally with a target. Albums pick it " +
        "up from their Projects automatically.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          name: { type: "string", description: "Shown next to the result, e.g. 'Signpostings made'" },
          description: { type: "string" },
          source: { type: "string", enum: ["signpostings", "internal_referrals"] },
          count_mode: { type: "string", enum: ["items", "contacts"] },
          settings: {
            type: "object",
            description: "internal_referrals only: {destinations: 'any'|'only'|'except', project_ids: [number]}",
          },
        },
        required: ["charity_id", "name", "source"],
      },
      handler: ({ charity_id, ...workflow_tracker }) =>
        post("/workflow_trackers", { workflow_tracker: { charity_id, ...workflow_tracker } }),
    },

    {
      name: "makerble_update_workflow_tracker",
      description:
        "Update a Workflow Tracker's name, description, source, count_mode or settings. Only the fields sent " +
        "change. Changes apply everywhere it is used (see makerble_get_workflow_tracker usage). Requires an " +
        "Organisation editor, or the reporter who created it.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
          description: { type: "string" },
          source: { type: "string", enum: ["signpostings", "internal_referrals"] },
          count_mode: { type: "string", enum: ["items", "contacts"] },
          settings: { type: "object", description: "Replaces the stored settings" },
        },
        required: ["id"],
      },
      handler: ({ id, ...workflow_tracker }) => patch(`/workflow_trackers/${id}`, { workflow_tracker }),
    },

    {
      name: "makerble_delete_workflow_tracker",
      description:
        "Delete a Workflow Tracker. Refused while it is used on any Project, Album or Scorecard Template; " +
        "remove it from those first.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: async ({ id }) => {
        await del(`/workflow_trackers/${id}`);
        return { deleted: true, id };
      },
    },

    {
      name: "makerble_add_workflow_tracker_to_project",
      description:
        "Place a Workflow Tracker in a column of a Project's Impact Scorecard (Edit Project Metrics), " +
        "optionally with a one-off target. Columns: activities, engagement, potential (short-term " +
        "outcomes), behaviour (medium-term), growth (long-term). The tracker and Project must belong to " +
        "the same Organisation, and you need rights to edit the Project's metrics.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Workflow Tracker ID" },
          project_id: { type: "number" },
          column: { type: "string", enum: ["activities", "engagement", "potential", "behaviour", "growth"] },
          target: { type: "number", description: "Optional one-off target" },
        },
        required: ["id", "project_id", "column"],
      },
      handler: ({ id, project_id, column, target }) =>
        post(`/workflow_trackers/${id}/projects/${project_id}`, { column, ...(target !== undefined ? { target } : {}) }),
    },

    {
      name: "makerble_get_workflow_tracker_targets",
      description:
        "Get a Workflow Tracker's targets on a Project or an Album (its Set Targets page): the one-off " +
        "target and any deadline targets ([{date, number}]). Pass project_id or album_id. Requires rights to " +
        "edit that Project's or Album's targets.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Workflow Tracker ID" },
          project_id: { type: "number" },
          album_id: { type: "number", description: "The Album (Bundle) ID" },
        },
        required: ["id"],
      },
      handler: ({ id, project_id, album_id }) =>
        get(album_id ? `/workflow_trackers/${id}/albums/${album_id}` : `/workflow_trackers/${id}/projects/${project_id}`),
    },

    {
      name: "makerble_set_workflow_tracker_targets",
      description:
        "Set a Workflow Tracker's targets on a Project or an Album (Set Targets): target is the one-off " +
        "number; deadlines is a list of {date: 'YYYY-MM-DD', number} that REPLACES this tracker's deadline " +
        "targets there ([] clears them). A tracker counting items adds its targets up across deadlines; one " +
        "counting each Contact once (a snapshot) uses each deadline's target on its own. An Album's target " +
        "is never the sum of its Projects'. The tracker must already be on that Project or one of the " +
        "Album's Projects. Requires rights to edit that Project's or Album's targets.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Workflow Tracker ID" },
          project_id: { type: "number" },
          album_id: { type: "number", description: "The Album (Bundle) ID" },
          target: { type: "number", description: "One-off target" },
          deadlines: {
            type: "array",
            description: "Deadline targets, replacing any already set for this tracker",
            items: {
              type: "object",
              properties: { date: { type: "string" }, number: { type: "number" } },
              required: ["date", "number"],
            },
          },
        },
        required: ["id"],
      },
      handler: ({ id, project_id, album_id, ...targets }) =>
        patch(album_id ? `/workflow_trackers/${id}/albums/${album_id}` : `/workflow_trackers/${id}/projects/${project_id}`, targets),
    },

    {
      name: "makerble_remove_workflow_tracker_from_project",
      description: "Remove a Workflow Tracker from a Project's Impact Scorecard, and its Albums if no other Project in them uses it.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Workflow Tracker ID" },
          project_id: { type: "number" },
        },
        required: ["id", "project_id"],
      },
      handler: async ({ id, project_id }) => {
        await del(`/workflow_trackers/${id}/projects/${project_id}`);
        return { removed: true, id, project_id };
      },
    },

    // ── Filtered versions of metrics (CP-8438) ─────────────────────────────────
    {
      name: "makerble_list_filtered_metrics",
      description:
        "List the filtered versions of metrics on a Project's or Album's Results Canvas. A filtered version " +
        "counts a standard metric (a Change: Activity or Engagement tracker; or an Indicator: Choice, " +
        "Achievement or Numerical tracker) again for only some responses and Contacts, e.g. 'Session " +
        "attendances — Female, under 21'. It counts attendances (or answers), not Contacts: use a Cohort " +
        "Tracker to count Contacts. Each item gives parent_type and parent_id (the metric it filters), " +
        "outcome_id (an Indicator's version sits under that Outcome), response_criteria and " +
        "contact_criteria. Pass project_id or album_id; an Album shows every filtered version on its " +
        "Projects. Paginated.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number" },
          album_id: { type: "number", description: "The Album (Bundle) ID" },
          page: { type: "number" },
          per_page: { type: "number" },
        },
      },
      handler: ({ project_id, album_id, page, per_page }) =>
        get(album_id ? `/albums/${album_id}/filtered_metrics` : `/projects/${project_id}/filtered_metrics`, { page, per_page }),
    },

    {
      name: "makerble_preview_filtered_metric",
      description:
        "Check a filtered version's filters before adding it: returns count (how many of the metric's " +
        "tagged responses on the Project currently pass the filters, e.g. attendances) and total (how " +
        "many there are with no filters). Takes the same parent_type, parent_id, response_criteria and " +
        "contact_criteria as makerble_create_filtered_metric.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number" },
          parent_type: { type: "string", enum: ["Change", "Indicator"] },
          parent_id: { type: "number" },
          response_criteria: { type: "object", description: "See makerble_create_filtered_metric" },
          contact_criteria: { type: "object", description: "See makerble_create_filtered_metric" },
        },
        required: ["project_id", "parent_type", "parent_id"],
      },
      handler: ({ project_id, ...filtered_metric }) =>
        post(`/projects/${project_id}/filtered_metrics/preview`, { filtered_metric }),
    },

    {
      name: "makerble_create_filtered_metric",
      description:
        "Add a filtered version of a metric to a Project (Edit Project Metrics > Add filtered version). " +
        "It becomes its own row on the Results Canvas and Set Targets, and appears on the Project's Albums. " +
        "Workflow: 1) makerble_get_project_results to see the Project's trackers and their IDs; the metric must already be on " +
        "the Project (a Change in a column, or an Indicator under one of its Outcomes). 2) Build the " +
        "filters. response_criteria (about the response/story the metric was recorded in) takes: " +
        "story_category_ids (Surveys), wave_ids (Intervals, e.g. Baseline; see makerble_list_survey_waves), " +
        "date_range ('dd/mm/yyyy - dd/mm/yyyy', the Date Happened; either end optional), label_ids and " +
        "author_ids (User IDs). contact_criteria (about the Contacts tagged in it) takes any key the Contacts " +
        "Filters sidebar sends, as for makerble_preview_cohort_tracker: e.g. sub_ratio_ids (a select Bio " +
        "field option such as Gender), age_from / age_to ({year, month, day}; age is worked out at the date " +
        "of each response), custom_field_value_hash, bundle_ids (Contacts also in a Project of these " +
        "Albums), project_ids. Other Bio fields use the Contact's current value; answer-based and attendance " +
        "criteria are judged at the end of each reporting period. 3) Optionally check with " +
        "makerble_preview_filtered_metric. 4) Create, with a display_name such as 'Session attendances — " +
        "Female, under 21'. A Change's version goes in its parent's column unless column is given; an " +
        "Indicator's goes under its parent's Outcome. Requires rights to edit the Project's metrics.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number" },
          parent_type: { type: "string", enum: ["Change", "Indicator"], description: "The kind of metric being filtered" },
          parent_id: { type: "number", description: "The Change or Indicator ID" },
          display_name: { type: "string" },
          column: {
            type: "string",
            enum: ["activities", "engagement", "potential", "behaviour", "growth"],
            description: "Changes only; defaults to the parent's column",
          },
          response_criteria: { type: "object", description: "Response Filters, see the description" },
          contact_criteria: { type: "object", description: "Contact Filters, see the description" },
        },
        required: ["project_id", "parent_type", "parent_id", "display_name"],
      },
      handler: ({ project_id, ...filtered_metric }) =>
        post(`/projects/${project_id}/filtered_metrics`, { filtered_metric }),
    },

    {
      name: "makerble_update_filtered_metric",
      description:
        "Rename a filtered version or replace its filters. response_criteria and contact_criteria, when " +
        "given, replace the stored ones ({} clears them). The metric it filters can't be changed. The " +
        "change applies on every Project and Scorecard Template it is on. Requires rights to edit the " +
        "Project's metrics.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number" },
          id: { type: "number", description: "The filtered version's ID" },
          display_name: { type: "string" },
          response_criteria: { type: "object" },
          contact_criteria: { type: "object" },
        },
        required: ["project_id", "id"],
      },
      handler: ({ project_id, id, ...filtered_metric }) =>
        patch(`/projects/${project_id}/filtered_metrics/${id}`, { filtered_metric }),
    },

    {
      name: "makerble_remove_filtered_metric",
      description:
        "Remove a filtered version from a Project (and its Albums). It is deleted once it is on no other " +
        "Project or Scorecard Template.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number" },
          id: { type: "number", description: "The filtered version's ID" },
        },
        required: ["project_id", "id"],
      },
      handler: async ({ project_id, id }) => {
        await del(`/projects/${project_id}/filtered_metrics/${id}`);
        return { removed: true, id, project_id };
      },
    },

    {
      name: "makerble_get_filtered_metric_results",
      description:
        "Get a filtered version's result on a Project or Album, as the Results Canvas shows it: number " +
        "(count of matching attendances or answers; a Numerical tracker's total) and unit, for a timeframe " +
        "ending at as_of. timeframe: period (since the previous Target Deadline), year_to_date (since the " +
        "Year Start) or all_time (default). as_of defaults to the next Target Deadline, or today. " +
        "Requires the right to see that Project's or Album's results.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The filtered version's ID" },
          project_id: { type: "number" },
          album_id: { type: "number", description: "The Album (Bundle) ID" },
          timeframe: { type: "string", enum: ["period", "year_to_date", "all_time"] },
          as_of: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["id"],
      },
      handler: ({ id, project_id, album_id, timeframe, as_of }) =>
        get(album_id ? `/albums/${album_id}/filtered_metrics/${id}/results` : `/projects/${project_id}/filtered_metrics/${id}/results`,
            { timeframe, as_of }),
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

    // ── Framework Sets (CP-8774) ───────────────────────────────────────────────
    {
      name: "makerble_list_framework_sets",
      description:
        "List the Framework Sets an Organisation can use. A Framework Set groups Impact Frameworks " +
        "(called templates in the API) into one thing an Organisation reports its contribution towards, " +
        "e.g. 'UN Sustainable Development Goals' holds the 17 SDG Impact Frameworks; others are TOMs, a " +
        "funder's outcomes framework or the Organisation's own strategy. Each set names its two levels " +
        "(e.g. Goal › Target): level 1 is an Impact Framework, level 2 an Outcome inside it. Returns live " +
        "sets available to the Organisation (every-organisation sets, its Networks' sets and its own) and " +
        "the drafts the user can edit, with availability (platform | network | charity), the frameworks " +
        "in order (template_id, name, short_code, colours) and value_source.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID; the user must belong to it" },
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
        required: ["charity_id"],
      },
      handler: (p) => get("/framework_sets", p),
    },

    {
      name: "makerble_get_framework_set",
      description:
        "Get one Framework Set by ID: its levels, who can use it, its Impact Frameworks in order " +
        "(template_id, name, position, short_code, colour, text_colour) and, when value_source is " +
        "'set_values', the Financial Value it defines for each Outcome (financial_values).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/framework_sets/${id}`),
    },

    {
      name: "makerble_create_framework_set",
      description:
        "Create a Framework Set from Impact Frameworks (templates). availability decides who can use it: " +
        "'charity' (only the Organisation in charity_id; needs an Organisation admin), 'network' (every " +
        "Organisation in network_id; needs that Network's admin) or 'platform' (every Organisation; " +
        "System Access users only). frameworks is the ordered list of existing Impact Frameworks; " +
        "new_frameworks names new, empty Impact Frameworks to create and add at the end (e.g. one per " +
        "Objective). value_source is 'organisation_values' (each Organisation's own Financial Values, the " +
        "default) or 'set_values' (values defined in the set per Outcome, set later with " +
        "makerble_update_framework_set). status 'draft' hides it from people who can't edit it.\n" +
        "Workflow: (1) makerble_list_framework_sets to avoid duplicating an existing set. " +
        "(2) makerble_create_framework_set. (3) Link the Organisation's own Indicators to the set's " +
        "Outcomes so its Stories count towards them.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation the user is acting for" },
          name: { type: "string" },
          availability: { type: "string", enum: ["platform", "network", "charity"] },
          network_id: { type: "number", description: "Required when availability is 'network'" },
          level1_singular: { type: "string", description: "e.g. Goal" },
          level1_plural: { type: "string", description: "e.g. goals" },
          level2_singular: { type: "string", description: "e.g. Target" },
          level2_plural: { type: "string", description: "e.g. targets" },
          value_source: { type: "string", enum: ["organisation_values", "set_values"] },
          version_label: { type: "string", description: "e.g. '2025 review'" },
          supersedes_id: { type: "number", description: "The Framework Set this version replaces" },
          status: { type: "string", enum: ["draft", "live"] },
          frameworks: {
            type: "array",
            description: "Impact Frameworks in order",
            items: {
              type: "object",
              properties: {
                template_id: { type: "number" },
                short_code: { type: "string", description: "e.g. '4' or 'O1'" },
                colour: { type: "string", description: "Hex colour, e.g. '#C5192D'" },
                text_colour: { type: "string", description: "Hex colour, e.g. '#FFFFFF'" },
              },
              required: ["template_id"],
            },
          },
          new_frameworks: { type: "array", items: { type: "string" }, description: "Names of new Impact Frameworks" },
        },
        required: ["charity_id", "name", "availability"],
      },
      handler: (p) => post("/framework_sets", p),
    },

    {
      name: "makerble_update_framework_set",
      description:
        "Update a Framework Set the user can edit. Only the fields sent change, except that frameworks " +
        "(when sent) replaces the whole ordered list and financial_values (when sent) replaces the " +
        "Financial Value chosen for each Outcome. financial_values are used when value_source is " +
        "'set_values': find Outcome IDs with makerble_list_outcomes and Financial Values the Organisation " +
        "can use in Makerble.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          charity_id: { type: "number", description: "The Organisation the user is acting for" },
          name: { type: "string" },
          availability: { type: "string", enum: ["platform", "network", "charity"] },
          network_id: { type: "number" },
          level1_singular: { type: "string" },
          level1_plural: { type: "string" },
          level2_singular: { type: "string" },
          level2_plural: { type: "string" },
          value_source: { type: "string", enum: ["organisation_values", "set_values"] },
          version_label: { type: "string" },
          supersedes_id: { type: "number" },
          status: { type: "string", enum: ["draft", "live"] },
          frameworks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                template_id: { type: "number" },
                short_code: { type: "string" },
                colour: { type: "string" },
                text_colour: { type: "string" },
              },
              required: ["template_id"],
            },
          },
          new_frameworks: { type: "array", items: { type: "string" } },
          financial_values: {
            type: "array",
            items: {
              type: "object",
              properties: { outcome_id: { type: "number" }, financial_value_id: { type: "number" } },
              required: ["outcome_id", "financial_value_id"],
            },
          },
        },
        required: ["id", "charity_id"],
      },
      handler: ({ id, ...body }) => patch(`/framework_sets/${id}`, body),
    },

    // ── Linked indicators (CP-8774) ───────────────────────────────────────────
    {
      name: "makerble_list_framework_links",
      description:
        "List an Organisation's Linked indicators. A Linked indicator is one of the Organisation's own " +
        "Indicators (progress trackers) linked to an Outcome inside a Framework Set, e.g. its 'Bootcamp " +
        "completions' Indicator linked to SDG Target 4.4. Every Story recorded against that Indicator " +
        "then counts towards the Outcome, in every project (all_projects: true) or only the projects " +
        "in project_ids. Returns indicator_name, outcome_title, project_ids and all_projects.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID; the user must belong to it" },
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string" },
        },
        required: ["charity_id"],
      },
      handler: (p) => get("/framework_links", p),
    },

    {
      name: "makerble_link_indicator_to_framework",
      description:
        "Link one of an Organisation's Indicators to an Outcome (e.g. an SDG Target) in a Framework Set the " +
        "Organisation can use, so its Stories count towards that Outcome. The Indicator must be one the " +
        "Organisation owns or uses in its projects. Leave project_ids empty to count it in every project, " +
        "or list the projects it should count in; linking again with more projects adds them. Requires an " +
        "Organisation admin.\n" +
        "Workflow: (1) makerble_list_framework_sets to choose a set. (2) makerble_get_framework_set for its " +
        "Impact Frameworks (template_id), then find the Outcome ID inside the right framework, e.g. with " +
        "makerble_list_outcomes. (3) makerble_list_indicators for the Organisation's Indicator. " +
        "(4) makerble_link_indicator_to_framework.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          indicator_id: { type: "number" },
          outcome_id: { type: "number", description: "An Outcome in one of the set's Impact Frameworks" },
          project_ids: { type: "array", items: { type: "number" }, description: "Empty or omitted: every project" },
        },
        required: ["charity_id", "indicator_id", "outcome_id"],
      },
      handler: (p) => post("/framework_links", p),
    },

    {
      name: "makerble_unlink_indicator",
      description:
        "Remove one of an Organisation's Linked indicators (by its id from makerble_list_framework_links). " +
        "Stories recorded against the Indicator stop counting towards that Outcome. Requires an " +
        "Organisation admin.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Linked indicator ID" },
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
        },
        required: ["id", "charity_id"],
      },
      handler: async ({ id, charity_id }) => {
        await del(`/framework_links/${id}?charity_id=${encodeURIComponent(charity_id)}`);
        return { deleted: true, id };
      },
    },

    {
      name: "makerble_get_framework_contribution",
      description:
        "Get an Organisation's contribution to a Framework Set (e.g. the UN Sustainable Development Goals): " +
        "the figures on its Contribution page. A Story counts towards an Outcome (e.g. SDG Target 4.4) when it " +
        "records a value against an Indicator inside that Outcome as a Core indicator, or against one of the " +
        "Organisation's Linked indicators (see makerble_list_framework_links) in a project the link covers. " +
        "Use it to answer 'which SDGs does our work contribute to?' for the whole Organisation, one project " +
        "or one Album (bundle_id), over a period.\n" +
        "Returns summary { frameworks_contributed, frameworks_total, stories, reached (distinct Contacts), " +
        "entries, financial_value } with each Story, Contact and entry counted once for the whole set, and " +
        "frameworks[] (each Impact Framework, e.g. an SDG Goal, with its stories and the outcomes[] it has a " +
        "contribution to, each with indicators[] and their membership core/linked, stories, reached and " +
        "financial_value). Framework and Outcome figures overlap, so never add them up into a total; use " +
        "summary instead. Never add figures across different Framework Sets.\n" +
        "Workflow: makerble_list_framework_sets to choose the set, then this tool.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Framework Set ID" },
          charity_id: { type: "number", description: "The Organisation (Charity) ID; the user must belong to it" },
          project_id: { type: "number", description: "Only count Stories in this project" },
          bundle_id: { type: "number", description: "Only count Stories in the projects of this Album (Bundle)" },
          period: {
            type: "string",
            enum: ["all_time", "last_12_months", "financial_year", "custom"],
            description: "Default all_time. financial_year starts on 5 April. custom uses from and to.",
          },
          from: { type: "string", description: "First day of a custom period (YYYY-MM-DD)" },
          to: { type: "string", description: "Last day of a custom period (YYYY-MM-DD)" },
        },
        required: ["id", "charity_id"],
      },
      handler: ({ id, ...params }) => get(`/framework_sets/${id}/contribution`, params),
    },

    {
      name: "makerble_migrate_framework_links",
      description:
        "Copy an Organisation's Linked indicators onto a new version of a Framework Set. A version is a set " +
        "whose supersedes_id names the set it replaces (e.g. 'SDGs 2025 review' replacing 'SDGs'). Each link " +
        "on the old version is carried across wherever the new version has the same Outcome, or one with " +
        "the same title, keeping its project scope. The old links stay, so past reports don't change. " +
        "Returns carried[] and not_carried[] (links with no matching Outcome, to re-link by hand with " +
        "makerble_link_indicator_to_framework). Requires an Organisation admin.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The new version's Framework Set ID" },
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
        },
        required: ["id", "charity_id"],
      },
      handler: ({ id, charity_id }) => post(`/framework_sets/${id}/migrate_links`, { charity_id }),
    },

    // ── Event Formats ──────────────────────────────────────────────────────────
    {
      name: "makerble_delete_event_format",
      description:
        "Permanently delete an Event Format (called Event Category / event_category in the API). " +
        "An Event Format is a template for events — e.g. Workshops, Classes, Meetings — managed on an " +
        "organisation's Manage Event Formats page. Only an Organisation Admin of the organisation that " +
        "owns the Event Format can delete it. Deletion is refused (with the reason in the error) while " +
        "the Event Format still has any events, or is still added to any project: the user must first " +
        "delete or move those events, or remove the Event Format from those projects, in Makerble. " +
        "Default formats (Appointments, Classes, Conferences, Gatherings, Meetings, Other Events, " +
        "Sessions, Workshops) can be deleted under the same rules. Ask the user for the Event Format's " +
        "id (it is in the URL of its Edit Settings page: /charities/<org id>/event_categories/<id>/edit) " +
        "and confirm with them before calling, because this cannot be undone. " +
        "Returns { id, message } on success.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Event Format (event_category) id" },
        },
        required: ["id"],
      },
      handler: ({ id }) => del(`/event_categories/${id}`),
    },

    // ── Webhooks ──────────────────────────────────────────────────────────────
    {
      name: "makerble_list_webhook_endpoints",
      description:
        "List an Organisation's (Charity's) webhook endpoints. A webhook endpoint is an HTTPS URL in " +
        "another system (a CRM such as Dynamics or Salesforce, Zapier, a data warehouse) that Makerble " +
        "sends a signed JSON POST to whenever a Contact (beneficiary), Story or Project is created or " +
        "updated, or an import finishes. Returns each endpoint's url, description, event_types, active " +
        "(false = paused), disabled_at (set when Makerble switched it off after repeated failed " +
        "deliveries), failure_count and last_success_at. Secrets are never returned here. Only the " +
        "Organisation's admins can use the webhook tools, and only once an admin has ticked 'Turn on " +
        "Webhooks' in the Organisation's Settings (Preferences) page in Makerble (otherwise the API answers " +
        "'Webhooks are not turned on for this organisation'; tell the user an admin can turn them on there).",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          page: { type: "number" },
          per_page: { type: "number" },
          last_synced_datetime: { type: "string", description: "Only endpoints changed after this ISO 8601 time" },
        },
        required: ["charity_id"],
      },
      handler: (p) => get("/webhook_endpoints", p),
    },

    {
      name: "makerble_create_webhook_endpoint",
      description:
        "Register a webhook endpoint for an Organisation, so Makerble starts sending it events. " +
        "Events: contact.created, contact.updated (includes changed_fields), story.created, story.updated, " +
        "project.created, project.updated, import.completed (one event per finished spreadsheet import " +
        "instead of one per row). Leave event_types out to send every event. The url must be HTTPS and " +
        "reachable from the internet. An Organisation can have at most 10 endpoints. The response includes " +
        "`secret` (whsec_…), which the receiving system needs to verify the X-Makerble-Signature header: " +
        "it is shown only this once, so give it to the user straight away and tell them to store it safely. " +
        "Then call makerble_send_test_webhook to check the receiver works.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          url: { type: "string", description: "HTTPS URL of the receiver" },
          description: { type: "string", description: "What the endpoint is for, e.g. 'Dynamics sync'" },
          event_types: {
            type: "array",
            items: {
              type: "string",
              enum: ["contact.created", "contact.updated", "story.created", "story.updated", "project.created", "project.updated", "import.completed"],
            },
          },
        },
        required: ["charity_id", "url"],
      },
      handler: (webhook_endpoint) => post("/webhook_endpoints", { webhook_endpoint }),
    },

    {
      name: "makerble_update_webhook_endpoint",
      description:
        "Change a webhook endpoint: its url, description or event_types, or pause it (active: false) and " +
        "resume it (active: true). Resuming also turns back on an endpoint that Makerble switched off after " +
        "repeated failed deliveries (disabled_at set), and resets its failure_count; check the receiver " +
        "works first with makerble_send_test_webhook. Changes made while an endpoint was paused or " +
        "switched off are not sent afterwards. Only send the fields to change.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The webhook endpoint ID" },
          url: { type: "string" },
          description: { type: "string" },
          event_types: { type: "array", items: { type: "string" } },
          active: { type: "boolean" },
        },
        required: ["id"],
      },
      handler: ({ id, ...webhook_endpoint }) => patch(`/webhook_endpoints/${id}`, { webhook_endpoint }),
    },

    {
      name: "makerble_delete_webhook_endpoint",
      description:
        "Delete a webhook endpoint and its delivery log. Makerble stops sending to it at once. This " +
        "cannot be undone, so confirm with the user first; to stop sending for a while, pause it with " +
        "makerble_update_webhook_endpoint (active: false) instead.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "The webhook endpoint ID" } },
        required: ["id"],
      },
      handler: async ({ id }) => {
        await del(`/webhook_endpoints/${id}`);
        return { deleted: true, id };
      },
    },

    {
      name: "makerble_rotate_webhook_secret",
      description:
        "Replace a webhook endpoint's signing secret, e.g. if it may have leaked. Returns the endpoint " +
        "with the new `secret`, shown only this once. Deliveries are signed with the new secret straight " +
        "away, so the receiving system must be updated with it before it rejects them.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "The webhook endpoint ID" } },
        required: ["id"],
      },
      handler: ({ id }) => post(`/webhook_endpoints/${id}/rotate_secret`),
    },

    {
      name: "makerble_send_test_webhook",
      description:
        "Send a test event (event: webhook.test, data: { test: true, message }) to a webhook endpoint to check the " +
        "receiver accepts it. It is queued and sent within a few seconds; returns the queued delivery. " +
        "Call makerble_list_webhook_deliveries afterwards to see whether it succeeded and the HTTP " +
        "response_code the receiver returned.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "The webhook endpoint ID" } },
        required: ["id"],
      },
      handler: ({ id }) => post(`/webhook_endpoints/${id}/test`),
    },

    {
      name: "makerble_list_webhook_deliveries",
      description:
        "A webhook endpoint's delivery log, newest first, kept for 30 days: each delivery's event, the " +
        "record it is about (resource_type Beneficiary = Contact, Story or Project, and resource_id), " +
        "status (pending, succeeded or failed), attempts, the receiver's last response_code, " +
        "occurred_at and next_attempt_at. Failed deliveries are retried about 9 times over 25 hours. " +
        "event_id is the `id` the receiver saw. Payloads are not included.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The webhook endpoint ID" },
          page: { type: "number" },
          per_page: { type: "number" },
        },
        required: ["id"],
      },
      handler: ({ id, ...p }) => get(`/webhook_endpoints/${id}/deliveries`, p),
    },

    {
      name: "makerble_replay_webhook_delivery",
      description:
        "Send a delivery from the log again, e.g. one that failed while the receiver was down. It keeps " +
        "the same event id, so a receiver that already processed it can ignore it. The payload shows the " +
        "record as it is now, not as it was when the event happened.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The webhook endpoint ID" },
          delivery_id: { type: "number", description: "The delivery's id from makerble_list_webhook_deliveries" },
        },
        required: ["id", "delivery_id"],
      },
      handler: ({ id, delivery_id }) => post(`/webhook_endpoints/${id}/deliveries/${delivery_id}/replay`),
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
