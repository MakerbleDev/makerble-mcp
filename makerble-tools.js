/**
 * makerble-tools.js
 * All 166 Makerble MCP tool definitions.
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
      // Lets Makerble attribute Access Log views to the MCP server rather than the API.
      "X-Makerble-Client": "makerble-mcp",
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
    put: (path, body) => request("PUT", path, body),
    del: (path, body) => request("DELETE", path, body),
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

// Webhook events an endpoint can subscribe to (WebhookEndpoint::EVENT_TYPES in the Rails app).
const WEBHOOK_EVENTS = [
  "contact.created", "contact.updated", "contact.deleted", "contact.merged", "contact.restored",
  "story.created", "story.updated", "story.deleted",
  "project.created", "project.updated", "project.deleted", "project.contact_added", "project.contact_removed",
  "import.completed",
];

export function buildTools(api) {
  const { get, post, patch, put, del, postBearer, signIn } = api;
  const query = (p) => { const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined)); return qs.toString() ? `?${qs}` : ""; };
  const metricDestinationPath = (metricType, metricId, destination, targetId, context) =>
    `/metrics/${metricType}/${metricId}/destinations/${destination}${targetId ? `/${targetId}` : ""}${query(context)}`;

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
      description:
        "Get a single Project by ID. beneficiary_states lists the Contact statuses (Beneficiary States, e.g. " +
        "Enrolled, Waiting List) switched on for the Project: use their ids as beneficiary_state_id in " +
        "makerble_add_contacts_to_project.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/projects/${id}`),
    },

    {
      name: "makerble_get_project_form",
      description:
        "Get what the Create Project form offers in an organisation, before creating or editing a Project with " +
        "makerble_create_project or makerble_update_project. Returns the Project Types (each with its solutions) and " +
        "the organisation's Project Categories. Each category lists its form fields in order: standard fields with " +
        "the parameter that sets them (e.g. project[help_statement] for Short Description, project[reporter_ids] for " +
        "Changemakers), custom questions with the field_id their answer goes under in custom_fields, and dropdowns " +
        "with the field_id their choices go under in sub_ratios (use makerble_list_answer_choices for the choices). " +
        "is_mandatory marks the fields the form requires. Get the organisation id from makerble_list_charities.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The organisation (Charity) to create the Project in." },
        },
        required: ["charity_id"],
      },
      handler: ({ charity_id }) => get("/projects/form", { charity_id }),
    },

    {
      name: "makerble_create_project",
      description:
        "Create a Project in an organisation, as the Create Project page does, with the same permissions: the user must " +
        "be allowed to create projects there (an Organisation Admin, or a colleague with project creation switched on). " +
        "The user becomes the Project's Manager unless editor_ids is given. Any Project Automation the new Project " +
        "matches is applied. Returns the Project.\n" +
        "Workflow: (1) Look before you make: call makerble_list_projects and check the organisation doesn't already " +
        "have this Project; suggest using or editing an existing one instead of a near-duplicate. " +
        "(2) makerble_get_project_form → project_type_id, project_category_id and the category's fields. " +
        "(3) makerble_create_project with the fields the category's form asks for. " +
        "(4) Set its Project Preferences and targets separately once those tools exist.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The organisation (Charity) to create the Project in." },
          name: { type: "string", description: "The Project's name." },
          project_type_id: { type: "number", description: "From makerble_get_project_form. Required." },
          solution_group_id: { type: "number", description: "One of the chosen Project Type's solutions, from makerble_get_project_form." },
          project_category_id: { type: "number", description: "One of the organisation's Project Categories. Defaults to its default category." },
          help_statement: { type: "string", description: "Short Description." },
          help_description: { type: "string", description: "Long Description." },
          location: { type: "string" },
          editor_ids: { type: "array", items: { type: "number" }, description: "Managers (Project Editors) by user id." },
          reporter_ids: { type: "array", items: { type: "number" }, description: "Changemakers (Project Reporters) by user id." },
          observer_ids: { type: "array", items: { type: "number" }, description: "Analysts (Project Observers) by user id." },
          story_category_ids: { type: "array", items: { type: "number" }, description: "Surveys (Story Categories) to use in the Project, on top of the Project Category's own." },
          privacy: {
            type: "string",
            enum: ["only_charity_colleagues", "only_project_colleagues", "only_certain_individual", "charity_plus_network", "everyone"],
            description: "Who can see the Project. only_certain_individual uses individual_list.",
          },
          individual_list: { type: "array", items: { type: "number" }, description: "User ids the Project is shared with, for only_certain_individual." },
          custom_fields: { type: "object", description: "Answers to the category's custom questions: { \"<field_id>\": value }." },
          sub_ratios: { type: "object", description: "Choices in the category's dropdowns: { \"<field_id>\": [choice ids] }." },
        },
        required: ["charity_id", "name", "project_type_id"],
      },
      handler: ({ charity_id, story_category_ids, privacy, individual_list, custom_fields, sub_ratios, ...project }) =>
        post("/projects", { charity_id, project, story_category_ids, privacy, individual_list, custom_fields, sub_ratios }),
    },

    {
      name: "makerble_update_project",
      description:
        "Edit a Project's details, as the Edit Project page does, with the same permissions (a Manager of the Project or " +
        "an Organisation Admin; a Changemaker can't). Only what you send changes. A colleague list you send replaces " +
        "that role's colleagues; one you leave out is kept. story_category_ids adds Surveys (Story Categories) to the " +
        "Project and never removes or stops any. Returns the Project.\n" +
        "Before changing anything, show the user the Project's current values (makerble_get_project) and what you will " +
        "change, and only go ahead when they agree.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Project's id." },
          name: { type: "string" },
          project_type_id: { type: "number" },
          solution_group_id: { type: "number" },
          project_category_id: { type: "number", description: "One of the organisation's Project Categories." },
          help_statement: { type: "string", description: "Short Description." },
          help_description: { type: "string", description: "Long Description." },
          location: { type: "string" },
          editor_ids: { type: "array", items: { type: "number" }, description: "Replaces the Managers (Project Editors)." },
          reporter_ids: { type: "array", items: { type: "number" }, description: "Replaces the Changemakers (Project Reporters)." },
          observer_ids: { type: "array", items: { type: "number" }, description: "Replaces the Analysts (Project Observers)." },
          story_category_ids: { type: "array", items: { type: "number" }, description: "Surveys to add to the Project." },
          privacy: {
            type: "string",
            enum: ["only_charity_colleagues", "only_project_colleagues", "only_certain_individual", "charity_plus_network", "everyone"],
          },
          individual_list: { type: "array", items: { type: "number" } },
          custom_fields: { type: "object", description: "Answers to the category's custom questions: { \"<field_id>\": value }." },
          sub_ratios: { type: "object", description: "Choices in the category's dropdowns: { \"<field_id>\": [choice ids] }." },
        },
        required: ["id"],
      },
      handler: ({ id, story_category_ids, privacy, individual_list, custom_fields, sub_ratios, ...project }) =>
        patch(`/projects/${id}`, { project, story_category_ids, privacy, individual_list, custom_fields, sub_ratios }),
    },

    {
      name: "makerble_get_project_settings",
      description:
        "Get a Project's Project Preferences, as its Project Preferences page shows them: which bio forms (Contact " +
        "Forms) create and edit Contacts (contact_form_ids, edit_contact_form_ids), which Contact statuses are " +
        "switched on (beneficiary_state_ids: Waiting List, Enrolled, Alumni, Declined) with each status's form and " +
        "baseline Surveys, editorial control (which bio forms each role may edit), Events (is_creation_of_events_required, " +
        "event_creator_ids, event_category_ids for Event Formats), Cases (is_creation_of_new_cases_enabled, " +
        "case_creator_ids, custom_field_category_id for the Case Form), Timesheets, the default privacy of new Stories, " +
        "and the Mailchimp list. Requires a Project Manager or Organisation Admin. Use it before " +
        "makerble_update_project_settings to show the user the current values.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "The Project's id." } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/projects/${id}/preferences`),
    },

    {
      name: "makerble_update_project_settings",
      description:
        "Change a Project's Project Preferences, as its Project Preferences page does, with the same permissions " +
        "(a Project Manager or Organisation Admin; a Changemaker can't). Send only the settings to change, using the " +
        "names makerble_get_project_settings returns; a list you send replaces that list ([] empties it). Forms, " +
        "Case Forms, Event Formats and Surveys must be the Project's organisation's. Examples: switch on the " +
        "Waiting List and Enrolled statuses with beneficiary_state_ids; choose a bio form with contact_form_ids; " +
        "switch on Events with is_creation_of_events_required: true. Returns the Project Preferences.\n" +
        "Before changing anything, show the user the current values (makerble_get_project_settings) and what you will " +
        "change, and only go ahead when they agree.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Project's id." },
          beneficiary_state_ids: { type: "array", items: { type: "number" }, description: "Contact statuses switched on." },
          contact_form_ids: { type: "array", items: { type: "number" }, description: "Bio forms used to create Contacts." },
          edit_contact_form_ids: { type: "array", items: { type: "number" }, description: "Bio forms that can be added to a Contact's bio." },
          is_creation_of_events_required: { type: "boolean", description: "Enable Events." },
          event_creator_ids: { type: "array", items: { type: "number" }, description: "Users who may create Events besides Project Managers." },
          event_category_ids: { type: "array", items: { type: "number" }, description: "The Project's Event Formats." },
          is_creation_of_new_cases_enabled: { type: "boolean", description: "Enable Cases." },
          case_creator_ids: { type: "array", items: { type: "number" }, description: "Changemakers and Analysts who may create Cases." },
          custom_field_category_id: { type: ["number", "null"], description: "The Case Form for the Project's Cases." },
          is_creation_of_timesheets_required: { type: "boolean", description: "Enable Timesheets." },
          default_story_privacy: {
            type: "string",
            enum: ["only_charity_colleagues", "only_project_colleagues", "only_certain_individual", "charity_plus_network", "everyone"],
            description: "Who sees a new Story by default. only_certain_individual uses individual_list.",
          },
          individual_list: { type: "array", items: { type: "number" } },
          default_results_template_id: { type: ["number", "null"], description: "The Impact Framework the Results Canvas shows by default; null for All metrics." },
        },
        required: ["id"],
        additionalProperties: true,
      },
      handler: ({ id, ...body }) => patch(`/projects/${id}/preferences`, body),
    },

    {
      name: "makerble_get_project_targets",
      description:
        "Get a Project's targets, as its Set Targets page shows them: year_start_date (the day its target year " +
        "starts), the one-off target on each Activity (Change) and Outcome (Indicator) metric on the Project (metrics), " +
        "on each Cohort, Workflow and Formula Tracker and filtered version (trackers), and its deadline targets " +
        "(deadlines). Requires rights to edit the Project's targets. Use before makerble_set_project_targets.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "The Project's id." } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/projects/${id}/targets`),
    },

    {
      name: "makerble_set_project_targets",
      description:
        "Set a Project's targets, as its Set Targets page does. Only metrics and trackers already on the Project (see " +
        "makerble_get_project_targets) can be given a target; to add a metric use makerble_add_metric_to, and to add a " +
        "tracker makerble_add_cohort_tracker_to_project, makerble_add_workflow_tracker_to_project or " +
        "makerble_add_formula_tracker_to_project. Anything not on " +
        "the Project is refused and nothing is saved. " +
        "deadlines, when sent, replaces all the Project's deadline targets; send [] to clear them. Returns the targets.\n" +
        "Before changing anything, show the user the current targets and what you will change, and only go ahead when they agree.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Project's id." },
          year_start_date: { type: "string", description: "The day the Project's target year starts, YYYY-MM-DD." },
          metrics: {
            type: "array",
            items: {
              type: "object",
              properties: {
                metric_type: { type: "string", enum: ["Change", "Indicator"] },
                metric_id: { type: "number" },
                target: { type: "number", description: "A whole number, 0 or more." },
              },
              required: ["metric_type", "metric_id", "target"],
            },
          },
          trackers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                tracker_type: { type: "string", enum: ["CohortTracker", "WorkflowTracker", "FormulaTracker", "FilteredMetric"] },
                tracker_id: { type: "number" },
                target: { type: "number" },
              },
              required: ["tracker_type", "tracker_id", "target"],
            },
          },
          deadlines: {
            type: "array",
            description: "Deadline targets: what to reach by a date. Replaces them all.",
            items: {
              type: "object",
              properties: {
                metric_type: { type: "string" },
                metric_id: { type: "number" },
                date: { type: "string", description: "YYYY-MM-DD." },
                number: { type: "number" },
              },
              required: ["metric_type", "metric_id", "date", "number"],
            },
          },
        },
        required: ["id"],
      },
      handler: ({ id, ...body }) => patch(`/projects/${id}/targets`, body),
    },

    {
      name: "makerble_list_albums",
      description:
        "List the Albums (Portfolios; Bundles in the API) the user can work with: those they made, manage or are an " +
        "Album Analyst of, and their organisations' Albums. An Album groups Projects so their results can be seen " +
        "together. Returns each Album's id, name, owner (owner_type Charity for an organisation's Album, User for a " +
        "personal one), managers, Album Analysts, project_ids and target type. Paginated; use last_synced_datetime " +
        "for incremental sync.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number" },
          per_page: { type: "number", description: "Default 10, max 200." },
          last_synced_datetime: { type: "string", description: "Only Albums changed after this ISO 8601 time." },
        },
      },
      handler: (p) => get("/albums", p),
    },

    {
      name: "makerble_get_album",
      description:
        "Get one Album (Portfolio) by id: its settings, managers (manager_ids), Album Analysts (analyst_ids), " +
        "project_ids, and pending_project_ids (Projects from another organisation invited to join, until their " +
        "managers accept). An Album the user can't see returns not found.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "The Album's id." } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/albums/${id}`),
    },

    {
      name: "makerble_create_album",
      description:
        "Make an Album (Portfolio), as the Make an Album form does. Its owner is an organisation the user is an " +
        "editor of (owner_type Charity with owner_id) or the user themself (owner_type User, a personal Album). The " +
        "user becomes its manager. Projects in project_ids join straight away when they belong to the organisation " +
        "or the user; another organisation's Project is invited instead and shows in pending_project_ids. Returns the Album.\n" +
        "Workflow: (1) Look before you make: call makerble_list_albums and check the organisation doesn't already " +
        "have this Album; suggest using or editing an existing one instead of a near-duplicate. " +
        "(2) makerble_list_projects for the Project ids. (3) makerble_create_album. " +
        "(4) makerble_update_album for its description, managers and Album Analysts, and makerble_set_album_targets for its targets.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The Album's name." },
          owner_type: { type: "string", enum: ["Charity", "User"], description: "Charity for an organisation's Album, User for a personal one." },
          owner_id: { type: "number", description: "The organisation (Charity) id when owner_type is Charity." },
          project_ids: { type: "array", items: { type: "number" }, description: "Projects to put in the Album." },
        },
        required: ["name", "owner_type"],
      },
      handler: (body) => post("/albums", body),
    },

    {
      name: "makerble_update_album",
      description:
        "Change an Album's (Portfolio's) settings, as its Edit Album and Album Edit pages do. Only the Album's managers " +
        "may. Only what you send changes. manager_ids and analyst_ids replace the Album's managers and Album Analysts " +
        "(the Album's maker always stays a manager). To add or remove Projects use makerble_add_projects_to_album and " +
        "makerble_remove_projects_from_album. Returns the Album.\n" +
        "Before changing anything, show the user the Album's current values (makerble_get_album) and what you will " +
        "change, and only go ahead when they agree.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Album's id." },
          name: { type: "string" },
          description: { type: "string" },
          owner_type: { type: "string", enum: ["Charity", "User"] },
          owner_id: { type: "number", description: "The organisation (Charity) id when owner_type is Charity." },
          manager_ids: { type: "array", items: { type: "number" }, description: "Replaces the Album's managers, by user id." },
          analyst_ids: { type: "array", items: { type: "number" }, description: "Replaces the Album Analysts, by user id. [] removes them all." },
          automatically_create_survey_progress_board: { type: "boolean", description: "Give each Survey on the Album's Projects a progress board." },
          default_results_template_id: {
            type: ["number", "null"],
            description: "The Impact Framework the Album's Progress Panel opens on (one of the organisation's); null for All metrics.",
          },
        },
        required: ["id"],
      },
      handler: ({ id, ...body }) => patch(`/albums/${id}`, body),
    },

    {
      name: "makerble_add_projects_to_album",
      description:
        "Add Projects to an Album (Portfolio), keeping the ones already in it. Only the Album's managers may. A Project " +
        "from another organisation is invited instead and shows in pending_project_ids until its managers accept. " +
        "Returns the Album.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Album's id." },
          project_ids: { type: "array", items: { type: "number" }, description: "Projects to add." },
        },
        required: ["id", "project_ids"],
      },
      handler: ({ id, project_ids }) => post(`/albums/${id}/projects`, { project_ids }),
    },

    {
      name: "makerble_remove_projects_from_album",
      description:
        "Take Projects out of an Album (Portfolio). The Projects themselves don't change. Only the Album's managers may. " +
        "Returns the Album. Confirm with the user before removing.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Album's id." },
          project_ids: { type: "array", items: { type: "number" }, description: "Projects to remove." },
        },
        required: ["id", "project_ids"],
      },
      handler: ({ id, project_ids }) => del(`/albums/${id}/projects`, { project_ids }),
    },

    {
      name: "makerble_get_album_targets",
      description:
        "Get an Album's (Portfolio's) targets, as its Set Targets page shows them. target_type automatic_target means " +
        "the Album adds up its Projects' targets from year_start_date; manual_target means it has its own: a one-off " +
        "target on each Activity and Outcome metric on the Album (metrics: Change or Indicator), on each Cohort, " +
        "Workflow and Formula Tracker and filtered version (trackers), and deadline targets (deadlines). Requires " +
        "rights to edit the Album's targets. Use before makerble_set_album_targets to show the user the current values.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "The Album's id." } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/albums/${id}/targets`),
    },

    {
      name: "makerble_set_album_targets",
      description:
        "Set an Album's (Portfolio's) targets, as its Set Targets page does. Only metrics and trackers already on the " +
        "Album (see makerble_get_album_targets) can be given a target; anything else is refused and nothing is saved. " +
        "Metric, tracker and deadline targets are only saved while the Album uses manual targets (target_type " +
        "manual_target). deadlines, when sent, replaces all the Album's deadline targets; send [] to clear them. " +
        "Returns the targets.\n" +
        "Before changing anything, show the user the current targets and what you will change, and only go ahead when they agree.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Album's id." },
          target_type: { type: "string", enum: ["manual_target", "automatic_target"] },
          year_start_date: { type: "string", description: "The day the Album's target year starts, YYYY-MM-DD." },
          metrics: {
            type: "array",
            description: "One-off targets on the Album's Activity (Change) and Outcome (Indicator) metrics.",
            items: {
              type: "object",
              properties: {
                metric_type: { type: "string", enum: ["Change", "Indicator"] },
                metric_id: { type: "number" },
                target: { type: "number", description: "A whole number, 0 or more." },
              },
              required: ["metric_type", "metric_id", "target"],
            },
          },
          trackers: {
            type: "array",
            description: "One-off targets on the Album's trackers.",
            items: {
              type: "object",
              properties: {
                tracker_type: { type: "string", enum: ["CohortTracker", "WorkflowTracker", "FormulaTracker", "FilteredMetric"] },
                tracker_id: { type: "number" },
                target: { type: "number", description: "A whole number, 0 or more; a percentage (0-100) for a percentage tracker." },
              },
              required: ["tracker_type", "tracker_id", "target"],
            },
          },
          deadlines: {
            type: "array",
            description: "Deadline targets: what to reach by a date, for a metric or tracker on the Album. Replaces them all.",
            items: {
              type: "object",
              properties: {
                metric_type: { type: "string", description: "Change, Indicator, CohortTracker, WorkflowTracker, FormulaTracker or FilteredMetric." },
                metric_id: { type: "number" },
                date: { type: "string", description: "YYYY-MM-DD." },
                number: { type: "number" },
              },
              required: ["metric_type", "metric_id", "date", "number"],
            },
          },
        },
        required: ["id"],
      },
      handler: ({ id, ...body }) => patch(`/albums/${id}/targets`, body),
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
        "(4) To see only the metrics in one Impact Framework (Template), as 'Metrics included' does on the Results " +
        "Canvas, pass template_id. A Project's default Impact Framework is default_results_template_id from " +
        "makerble_get_project; null there means All metrics. The Impact Framework must be the user's own or belong to " +
        "the Organisation of every Project requested. " +
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
          template_id: {
            type: "number",
            description: "Impact Framework (Template) ID: return only its trackers. Omit for every tracker",
          },
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
      name: "makerble_add_contacts_to_project",
      description:
        "Add existing Contacts (Beneficiaries) to a Project, optionally with a status (Beneficiary State, e.g. " +
        "Enrolled or Waiting List). This is the same as 'Assign Contacts to projects' on the Contacts page in " +
        "Makerble: each Contact added gets an entry on their activity timeline and the Project's team is notified. " +
        "It does not create Contacts: use makerble_create_contact for a new person. " +
        "\nWhen to use: before makerble_create_survey_links with beneficiary_ids, when the Contacts aren't in the " +
        "Survey Campaign's Project yet (that call fails with 'not in the project' otherwise). Contacts created from " +
        "an email address by makerble_create_survey_links join the organisation but not the Project. " +
        "\nWorkflow: (1) makerble_get_project → beneficiary_states, if you want a status other than the default " +
        "(Enrolled, or the Project's first status if Enrolled is switched off). (2) Call this tool. " +
        "\nContacts already in the Project are left as they are: their status is not changed, and they are returned " +
        "with already_in_project: true. At most 200 beneficiary_ids per call. Nothing is added if any Contact is " +
        "refused. The Project must be open (not closed) and in the Contacts' organisation. " +
        "Requires an Organisation Editor, Reporter or Observer, or a Project Editor (or Reporter, if the " +
        "organisation allows it) of a Project the Contact is in. " +
        "Returns { data: [{ id, project_id, beneficiary_id, beneficiary_state_id, already_in_project, created_at, " +
        "updated_at }] }, one entry per Contact. Errors: 404 for a Project you can't see; 403 naming the Contacts " +
        "you may not move; 422 with beneficiary_ids_not_found for ids that aren't Contacts of the Project's " +
        "organisation, or for an unknown status, a closed Project, no ids or more than 200.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number", description: "The Project to add the Contacts to" },
          beneficiary_ids: {
            type: "array",
            items: { type: "number" },
            description: "Contact (Beneficiary) IDs from the Project's organisation, at most 200",
          },
          beneficiary_state_id: {
            type: "number",
            description: "Optional Contact status (Beneficiary State) ID from makerble_get_project's beneficiary_states",
          },
        },
        required: ["project_id", "beneficiary_ids"],
      },
      handler: (body) => post("/project_beneficiaries", body),
    },

    {
      name: "makerble_get_contact",
      description:
        "Get a single Contact (Beneficiary) by ID, including all custom fields. " +
        "Opening a Contact this way is recorded in its Access Log (the audit trail of who viewed it), " +
        "under your name and marked as via MCP, so use makerble_list_contacts when you only need to find or scan Contacts.",
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
        "who did it and when, newest first. Use this to answer 'who changed this Contact or Story, and when?'. " +
        "record_type is \"Contact\" (a Contact, API: Beneficiary; find its ID with makerble_list_contacts) or " +
        "\"Story\" (a Story or Survey Response; find its ID with makerble_list_stories). " +
        "A Story is named \"[story ID] <survey> in <project> by <user> on <date happened>\". " +
        "Only Charity Editors (any Contact or Story in the organisation) and Project Editors (Contacts in their projects, and " +
        "Stories in their projects that they may read: a Story shared only with specific individuals is hidden unless they are one) " +
        "can see Versions; anything else returns not-found. A deleted record's Versions stay listed, with record.deleted true. " +
        "Returns {page, page_size, page_count, total_count, record: {record_type, record_id, charity_id, name, deleted}, " +
        "data: [{id, event, action (Created/Edited/Destroyed), user_id, user_name (\"System\" for background jobs such as CSV imports), created_at}]}. " +
        "One Save can write several Versions a fraction of a second apart. " +
        "To see what the record looked like in a Version, call makerble_get_version with its id.",
      inputSchema: {
        type: "object",
        properties: {
          record_type: {
            type: "string",
            enum: ["Contact", "Story"],
            description: "\"Contact\" (Beneficiary) or \"Story\" (a Story or Survey Response).",
          },
          record_id: { type: "number", description: "The Contact (Beneficiary) ID or the Story ID." },
          page: { type: "number" },
          per_page: { type: "number", description: "Default 10, max 200." },
          last_sync_datetime: { type: "string", description: "Only Versions created after this ISO 8601 datetime." },
        },
        required: ["record_type", "record_id"],
      },
      handler: (p) => get("/versions", p),
    },

    {
      name: "makerble_list_access_logs",
      description:
        "List the Access Logs (audit trail of views) of one record: who opened it, when, and how many times, newest first. " +
        "Use this to answer 'who has looked at this Contact, and when?'. Changes are in makerble_list_versions instead. " +
        "Views by the same colleague less than 30 minutes apart are one entry with a view_count. " +
        "Entries older than the organisation's retention period (3 to 12 months, set on Organisation Preferences) are rolled up into " +
        "one entry per colleague per month with monthly_summary: true, first_viewed_at and last_viewed_at spanning that month. " +
        "source is \"web\" (opened in Makerble), \"api\" (fetched through the API) or \"mcp\" (fetched through this MCP server, " +
        "for example by makerble_get_contact). record_type is \"Contact\" (find its ID with makerble_list_contacts) or " +
        "\"Story\" (a Story or Survey Response; find its ID with makerble_list_stories). " +
        "Same permissions as makerble_list_versions; anything else returns not-found. " +
        "Returns {page, page_size, page_count, total_count, record: {record_type, record_id, charity_id, name, deleted}, " +
        "data: [{id, action (\"Viewed ×N\"), view_count, source, user_id, user_name, first_viewed_at, last_viewed_at, monthly_summary}]}.",
      inputSchema: {
        type: "object",
        properties: {
          record_type: {
            type: "string",
            enum: ["Contact", "Story"],
            description: "\"Contact\" (Beneficiary) or \"Story\" (a Story or Survey Response).",
          },
          record_id: { type: "number", description: "The Contact (Beneficiary) ID or the Story ID." },
          from: { type: "string", description: "Only entries on or after this date (YYYY-MM-DD)." },
          to: { type: "string", description: "Only entries on or before this date (YYYY-MM-DD)." },
          user_id: { type: "number", description: "Only this colleague's views (a user ID from makerble_list_users)." },
          page: { type: "number" },
          per_page: { type: "number", description: "Default 10, max 200." },
          last_synced_datetime: { type: "string", description: "Only entries last viewed after this ISO 8601 datetime." },
        },
        required: ["record_type", "record_id"],
      },
      handler: (p) => get("/access_logs", p),
    },

    {
      name: "makerble_list_audit_trail",
      description:
        "List an organisation's Audit Trail: the latest changes (Versions: Created, Edited, Destroyed) and views " +
        "(Access Logs: Viewed) across all its Contacts (Beneficiaries) and Stories (including Survey Responses), newest first. " +
        "Use this to answer organisation-wide questions such as 'what has Jane done this week?', 'who has viewed or changed " +
        "records today?' or 'which Contacts were deleted recently?'. For one record's full history use makerble_list_versions " +
        "(changes) or makerble_list_access_logs (views, including older monthly summaries) instead. " +
        "Views by the same colleague less than 30 minutes apart are one entry with a view_count. Only views within the " +
        "organisation's retention period are listed here; older ones are monthly summaries on makerble_list_access_logs. " +
        "Get the organisation (charity) ID from makerble_get_organisation and colleague IDs from makerble_list_users. " +
        "Only Charity Editors (everything in the organisation) and Project Editors (Contacts and Stories in their projects) " +
        "can see it; anything else returns not-found. " +
        "Returns {page, page_size, page_count, total_count, data: [{entry_type (\"version\" or \"access_log\"), id, " +
        "action (\"Created\", \"Edited\", \"Destroyed\" or \"Viewed\"), record_type (\"Contact\" or \"Story\"), " +
        "record_id, record_name, occurred_at, user_id, who, view_count, source}]}. " +
        "For an entry_type \"version\" entry, id is a Version ID for makerble_get_version. source is \"web\", \"api\" or " +
        "\"mcp\" for views, null for changes.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The organisation (Charity) ID." },
          actions: {
            type: "string",
            description:
              "Comma-separated types of action to include, from created, edited, destroyed, viewed. Default: all of them.",
          },
          user_id: { type: "number", description: "Only this colleague's actions (a user ID from makerble_list_users)." },
          record_type: {
            type: "string",
            enum: ["Contact", "Story"],
            description: "Only Contacts, or only Stories (including Survey Responses).",
          },
          record_id: { type: "number", description: "Only this record (needs record_type)." },
          page: { type: "number" },
          per_page: { type: "number", description: "Default 10, max 200." },
          last_synced_datetime: { type: "string", description: "Only entries after this ISO 8601 datetime." },
        },
        required: ["charity_id"],
      },
      handler: (p) => get("/audit_trail", p),
    },

    {
      name: "makerble_get_version",
      description:
        "Get one Version (audit-trail entry) by ID, including full_object: a complete snapshot of every field " +
        "of the record as it was saved at that moment (not just the fields that changed). " +
        "For a Story, full_object is {schema_version, story (the Story's own fields), privacy_settings, contact_ids, " +
        "outcome_ids, label_ids, media, answers: [{kind, field_id, label, contact_id, sub_ratio_id, sub_ratio_label, value}]}, " +
        "so a survey question keeps the label it had then. " +
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
        "indicator responses, change values, and verdict scores. " +
        "Opening a Story this way is recorded in its Access Log (the audit trail of who viewed it), " +
        "under your name and marked as via MCP, so use makerble_list_stories when you only need to find or scan Stories.",
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
        "A Contact created from an email joins the organisation but NOT the Survey Campaign's Project, so to pass " +
        "their id in beneficiary_ids later, first call makerble_add_contacts_to_project (or reuse their existing " +
        "link from makerble_list_survey_links). " +
        "At most 200 beneficiary_ids + emails per call. " +
        "\nlink_expiry: 'use_once' (default) — the link stops working after one response; " +
        "'evergreen' — the link stays active for repeat responses. " +
        "Requires Project Editor or Organisation Editor access. " +
        "Returns send_survey_id and data: [{beneficiary_id, email, survey_token, survey_url, link_expiry, " +
        "is_anonymised, send_survey_wave_id, expired, created_at}]. " +
        "A 422 for refused Contacts lists them in invalid_beneficiary_ids, split into beneficiary_ids_not_in_project " +
        "(in the organisation but not the Project: add them with makerble_add_contacts_to_project, then retry) and " +
        "beneficiary_ids_not_found (not Contacts of the organisation).",
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

    // ── Checklists ────────────────────────────────────────────────────────────
    {
      name: "makerble_list_checklists",
      description:
        "List an Organisation's Checklists. A Checklist is an ordered list of actions the Organisation " +
        "expects to be done for each Contact (beneficiary), e.g. 'give them a Role', 'complete the Alpha " +
        "Contact Form', 'invite them to an induction event'. Returns each Checklist's id, name, description " +
        "and actions_count. Organisation editors and reporters, and its Project Managers, can see them.",
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
      handler: (p) => get("/checklists", p),
    },

    {
      name: "makerble_get_checklist",
      description:
        "Get one Checklist by ID: its ordered actions (action_type, title, description and criteria, " +
        "which say what counts as done, due_within_days: the deadline, in days after the Checklist is added " +
        "to a Contact, null for none, and who is responsible: owner_kind, owner_user_id, owner_team_id, " +
        "owner_relationship_side and a readable owner_description), the Projects that offer it with their assignment_mode " +
        "('manual': colleagues may add it to Contacts by hand; 'automatic': every Contact in the Project " +
        "gets it) and how many Contacts have it.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/checklists/${id}`),
    },

    {
      name: "makerble_list_checklist_action_types",
      description:
        "List the actions a Checklist can contain (e.g. add_role 'Add a role', complete_survey 'Complete a " +
        "survey', invite_to_event 'Invite to an event') and, for each, the criteria_keys that say what " +
        "counts as done. Call this before makerble_create_checklist. Criteria values are strings: IDs " +
        "(beneficiary_role_ids, skill_ids, group_ids, flag_ids, beneficiary_category_ids = Contact Forms, " +
        "custom_field_category_ids = Custom Forms for contacts, case_form_ids, label_ids) or pairs: " +
        "relationship_sides '<relationship_category_id>:parent|child', project_states " +
        "'<project_id>:<beneficiary_state_id>', project_event_categories '<project_id>:<event_category_id>', " +
        "survey_waves '<project_story_category_id (Survey Campaign)>:<send_survey_wave_id, or 0 for a " +
        "campaign without Waves>'. The two 'for a relative' types take relatives: [{relationship_side, " +
        "beneficiary_category_ids or survey_waves}], where the side is the relative's own (e.g. the Son). " +
        "Action types with no criteria_keys are done by any record of the kind (e.g. create_task).",
      inputSchema: { type: "object", properties: {} },
      handler: () => get("/checklists/action_types"),
    },

    {
      name: "makerble_create_checklist",
      description:
        "Create a Checklist for an Organisation. Requires an Organisation editor or reporter. Each action " +
        "needs an action_type and, unless that type has no criteria_keys, at least one criteria value " +
        "(see makerble_list_checklist_action_types). Actions keep the order given." +
        " Each action may name who is responsible for it (owner_kind); leave it out for nobody in particular." +
        " Each action may have a deadline (due_within_days); leave it out for none." +
        "\nWorkflow: (1) makerble_list_checklist_action_types. (2) Find IDs with makerble_list_projects, " +
        "makerble_list_surveys, makerble_list_survey_campaigns, makerble_list_survey_waves, " +
        "makerble_list_contact_bio_forms etc., and owners with makerble_get_checklist_owner_options and " +
        "makerble_list_users. (3) makerble_create_checklist. (4) makerble_set_checklist_project to offer " +
        "it in Projects, by hand or automatically.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          name: { type: "string" },
          description: { type: "string" },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action_type: { type: "string", description: "e.g. add_role, complete_survey, create_task" },
                title: { type: "string", description: "Shown on the Contact profile, e.g. 'Give them a Role'" },
                description: { type: "string" },
                criteria: { type: "object", description: "What counts as done, keyed by the type's criteria_keys" },
                due_within_days: {
                  type: "integer",
                  minimum: 0,
                  maximum: 3650,
                  description: "'Due within N days of the checklist being added': the action is due this many days after the " +
                    "Checklist is added to a Contact (0 = the same day). Leave it out for no deadline",
                },
                only_this_project: {
                  type: "boolean",
                  description: "'Only count records in this project': for project_scopable types (surveys, events, labelled stories, cases, " +
                    "project states), count only records made in the Project the Checklist was added to the Contact through",
                },
                owner_kind: {
                  type: "string",
                  enum: ["none", "adder", "user", "team", "relationship"],
                  description: "Who is responsible for this action (optional, default 'none'). See makerble_get_checklist_owner_options.",
                },
                owner_user_id: { type: "number", description: "For owner_kind 'user': a colleague's User ID (makerble_list_users)" },
                owner_team_id: { type: "number", description: "For owner_kind 'team': one of the Organisation's Team IDs" },
                owner_relationship_side: {
                  type: "string",
                  description: "For owner_kind 'relationship': '<relationship_category_id>:parent|child', the colleague's own side",
                },
              },
              required: ["action_type"],
            },
          },
        },
        required: ["charity_id", "name"],
      },
      handler: ({ charity_id, ...checklist }) => post("/checklists", { charity_id, checklist }),
    },

    {
      name: "makerble_update_checklist",
      description:
        "Update a Checklist's name, description or actions. Requires an Organisation editor or reporter. " +
        "To change an action send its id with the new fields; to remove one send {id, _destroy: true}; " +
        "actions without an id are added. Get the current actions with makerble_get_checklist first.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
          description: { type: "string" },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                _destroy: { type: "boolean" },
                action_type: { type: "string" },
                position: { type: "number" },
                title: { type: "string" },
                description: { type: "string" },
                criteria: { type: "object" },
                due_within_days: {
                  type: ["integer", "null"],
                  minimum: 0,
                  maximum: 3650,
                  description: "Days after the Checklist is added to a Contact that the action is due; null removes the deadline",
                },
                only_this_project: { type: "boolean", description: "'Only count records in this project' (project_scopable types only)" },
                owner_kind: {
                  type: "string",
                  enum: ["none", "adder", "user", "team", "relationship"],
                  description: "Who is responsible for this action (optional, default 'none'). See makerble_get_checklist_owner_options.",
                },
                owner_user_id: { type: "number", description: "For owner_kind 'user': a colleague's User ID (makerble_list_users)" },
                owner_team_id: { type: "number", description: "For owner_kind 'team': one of the Organisation's Team IDs" },
                owner_relationship_side: {
                  type: "string",
                  description: "For owner_kind 'relationship': '<relationship_category_id>:parent|child', the colleague's own side",
                },
              },
            },
          },
        },
        required: ["id"],
      },
      handler: ({ id, ...checklist }) => patch(`/checklists/${id}`, { checklist }),
    },

    {
      name: "makerble_set_checklist_project",
      description:
        "Set how a Project offers a Checklist (the Add to Projects popup). mode 'manual': colleagues may " +
        "add it to the Project's Contacts by hand. 'automatic': every Contact now in the Project gets it " +
        "(in the background) and so does every Contact who later joins or is created in it. 'none': stop " +
        "offering it; Contacts who already have it keep it. Requires an Organisation editor or the " +
        "Project's Project Manager.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Checklist ID" },
          project_id: { type: "number" },
          mode: { type: "string", enum: ["none", "manual", "automatic"] },
        },
        required: ["id", "project_id", "mode"],
      },
      handler: ({ id, project_id, mode }) => patch(`/checklists/${id}/projects/${project_id}`, { mode }),
    },

    {
      name: "makerble_get_contact_checklists",
      description:
        "Get a Contact's (beneficiary's) Checklists, as on the Checklists box of their profile page: for " +
        "each, done_count of actions_count and every action with done true/false. A done action has a " +
        "completion saying when it was done (completed_at: when the record that did it was made, e.g. the " +
        "survey's date), by whom (completed_by_user_id, completed_by_name; null when unknown), how " +
        "(completion_method: detected or manual) and with what record (proof_type and proof_id, e.g. Story " +
        "123; proof_deleted true once that record was deleted). A done action stays done. Actions are " +
        "ticked in the background a few seconds after the record is saved, so re-check shortly after " +
        "creating a story or role. Each action has a deadline when its Checklist sets one: due_on (the date, " +
        "the day the Checklist was added to the Contact plus the action's due_within_days; null for none), " +
        "done_late (done after due_on) and overdue (not done and due_on has passed). Use overdue to find " +
        "the steps that need chasing. Each action also says who is responsible " +
        "for it for this Contact: owner_kind etc., owner_overridden (true when changed for this Contact " +
        "only), owner_description (e.g. 'Safeguarding Team'), responsible_user_ids (only colleagues who " +
        "can see the Contact) and owner_warning when nobody responsible can see them. Use it to see what " +
        "still needs doing for a Contact, and by whom. Only Contacts you can see are returned.",
      inputSchema: {
        type: "object",
        properties: {
          beneficiary_id: { type: "number", description: "The Contact ID" },
          page: { type: "number" },
          per_page: { type: "number" },
        },
        required: ["beneficiary_id"],
      },
      handler: ({ beneficiary_id, ...p }) => get(`/beneficiaries/${beneficiary_id}/checklists`, p),
    },

    {
      name: "makerble_add_checklist_to_contact",
      description:
        "Add a Checklist to a Contact by hand (Add a Checklist on their profile page). Only Checklists that " +
        "one of the Contact's Projects lets you add are allowed; call with list_available: true to get them " +
        "first (returns [{id, name, projects: [{id, name}]}] and adds nothing). A Checklist is added through " +
        "one of its projects: when it lists more than one, pass the chosen project_id (actions set to 'Only " +
        "count records in this project' then count only that Project's records).",
      inputSchema: {
        type: "object",
        properties: {
          beneficiary_id: { type: "number", description: "The Contact ID" },
          checklist_id: { type: "number" },
          project_id: { type: "number", description: "The Project to add it through; required when the Checklist lists several projects" },
          list_available: { type: "boolean", description: "Only list the Checklists that can be added" },
        },
        required: ["beneficiary_id"],
      },
      handler: ({ beneficiary_id, checklist_id, project_id, list_available }) =>
        list_available || !checklist_id
          ? get(`/beneficiaries/${beneficiary_id}/checklists/available`)
          : post(`/beneficiaries/${beneficiary_id}/checklists`, project_id ? { checklist_id, project_id } : { checklist_id }),
    },

    {
      name: "makerble_get_checklist_owner_options",
      description:
        "List the choices for who is responsible for a Checklist action (the 'Who is responsible?' " +
        "dropdown): owner kinds ('none' nobody in particular; 'adder' the colleague who added the Checklist " +
        "to the Contact, or the Project's Project Managers when a Project added it automatically; 'user' a " +
        "specific colleague, from makerble_list_users; 'team' anyone in one of the Organisation's Teams who " +
        "can see the Contact; 'relationship' any colleague with a given kind of Relationship with the " +
        "Contact, e.g. their Therapist), the Organisation's Teams [{id, name}] and its relationship sides " +
        "[{owner_relationship_side, name}]. Use the values with makerble_create_checklist, " +
        "makerble_update_checklist or makerble_set_contact_checklist_action_owner.",
      inputSchema: {
        type: "object",
        properties: { charity_id: { type: "number", description: "The Organisation (Charity) ID" } },
        required: ["charity_id"],
      },
      handler: ({ charity_id }) => get("/checklists/owner_options", { charity_id }),
    },

    {
      name: "makerble_set_contact_checklist_action_owner",
      description:
        "Change who is responsible for one action of a Contact's (beneficiary's) Checklist, for that " +
        "Contact only (the Change link on their profile's Checklists box); other Contacts keep the " +
        "Checklist's default. Send use_checklist_default: true to undo the change. Requires edit access to " +
        "the Contact. Returns the action's owner fields, responsible_user_ids and owner_warning." +
        "\nWorkflow: (1) makerble_get_contact_checklists for the checklist_id and action id. (2) " +
        "makerble_get_checklist_owner_options (and makerble_list_users for a colleague). (3) this tool.",
      inputSchema: {
        type: "object",
        properties: {
          beneficiary_id: { type: "number", description: "The Contact ID" },
          checklist_id: { type: "number" },
          action_id: { type: "number", description: "The Checklist action's id" },
          use_checklist_default: { type: "boolean", description: "Go back to the Checklist's own owner for this action" },
          owner_kind: { type: "string", enum: ["none", "adder", "user", "team", "relationship"] },
          owner_user_id: { type: "number" },
          owner_team_id: { type: "number" },
          owner_relationship_side: { type: "string", description: "'<relationship_category_id>:parent|child'" },
        },
        required: ["beneficiary_id", "checklist_id", "action_id"],
      },
      handler: async ({ beneficiary_id, checklist_id, action_id, use_checklist_default, ...owner }) => {
        const path = `/beneficiaries/${beneficiary_id}/checklists/${checklist_id}/actions/${action_id}/owner`;
        return use_checklist_default ? del(path) : patch(path, owner);
      },
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
        "their Projects automatically. To show the result as a percentage (e.g. '68% Children attending " +
        "75%+', shown with '34 of 50 contacts in this project'), set result_type 'percentage' and a denominator; " +
        "for a percentage of some of the members (e.g. of the girls), use denominator 'filtered' with denominator_criteria.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          name: { type: "string", description: "Shown next to the result, e.g. 'Children attending 75%+'" },
          description: { type: "string" },
          membership: { type: "string", enum: ["ever_enrolled", "currently_enrolled"] },
          criteria: { type: "object", description: "Contact Filter criteria" },
          result_type: {
            type: "string",
            enum: ["number", "percentage"],
            description: "'number' (default): a number of Contacts. 'percentage': a percentage of the denominator",
          },
          denominator: {
            type: "string",
            enum: ["members", "enough_data", "filtered"],
            description:
              "For a percentage, what it is out of: 'members' (default: Contacts in this Project / Album), " +
              "'enough_data' (Contacts with enough data: invited to an event for Attendance Rate, two or more " +
              "Choice Tracker responses for Distance Travelled, an answer for an answer-based criterion), or " +
              "'filtered' (members who also meet denominator_criteria, e.g. 'of the girls in this project'). " +
              "'enough_data' is recommended for improvement or attendance, so Contacts without data don't lower it",
          },
          denominator_criteria: {
            type: "object",
            description:
              "Required when denominator is 'filtered': Contact Filter criteria, the same keys as criteria " +
              "(check them with makerble_preview_cohort_tracker), for the Contacts the percentage is out of. " +
              "Ignored and cleared for any other denominator",
          },
        },
        required: ["charity_id", "name"],
      },
      handler: ({ charity_id, ...cohort_tracker }) =>
        post("/cohort_trackers", { cohort_tracker: { charity_id, ...cohort_tracker } }),
    },

    {
      name: "makerble_update_cohort_tracker",
      description:
        "Update a Cohort Tracker's name, description, membership, criteria, result_type, denominator or " +
        "denominator_criteria. Only " +
        "the fields sent change. Changes apply everywhere it is used (see makerble_get_cohort_tracker usage). " +
        "Requires an Organisation editor, or the reporter who created it. Switching result_type between " +
        "'number' and 'percentage' CLEARS all the tracker's targets on every Project and Album, so the API " +
        "refuses it with an error naming how many targets would go unless confirm_clear_targets is true. Ask " +
        "the user before confirming.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
          description: { type: "string" },
          membership: { type: "string", enum: ["ever_enrolled", "currently_enrolled"] },
          criteria: { type: "object", description: "Replaces the stored criteria" },
          result_type: {
            type: "string",
            enum: ["number", "percentage"],
            description: "'number' (default): a number of Contacts. 'percentage': a percentage of the denominator",
          },
          denominator: {
            type: "string",
            enum: ["members", "enough_data", "filtered"],
            description:
              "For a percentage, what it is out of: 'members' (default: Contacts in this Project / Album), " +
              "'enough_data' (Contacts with enough data: invited to an event for Attendance Rate, two or more " +
              "Choice Tracker responses for Distance Travelled, an answer for an answer-based criterion), or " +
              "'filtered' (members who also meet denominator_criteria, e.g. 'of the girls in this project'). " +
              "'enough_data' is recommended for improvement or attendance, so Contacts without data don't lower it",
          },
          denominator_criteria: {
            type: "object",
            description:
              "Required when denominator is 'filtered': Contact Filter criteria, the same keys as criteria " +
              "(check them with makerble_preview_cohort_tracker), for the Contacts the percentage is out of. " +
              "Ignored and cleared for any other denominator",
          },
          confirm_clear_targets: {
            type: "boolean",
            description: "Confirms clearing the tracker's targets when result_type changes",
          },
        },
        required: ["id"],
      },
      handler: ({ id, confirm_clear_targets, ...cohort_tracker }) =>
        patch(`/cohort_trackers/${id}`, {
          cohort_tracker,
          ...(confirm_clear_targets !== undefined ? { confirm_clear_targets } : {}),
        }),
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
        "on one of the Album's Projects. Requires rights to edit that Project's or Album's targets. For a " +
        "percentage tracker (result_type 'percentage') the target and each deadline number are a whole " +
        "percentage from 0 to 100.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Cohort Tracker ID" },
          project_id: { type: "number" },
          album_id: { type: "number", description: "The Album (Bundle) ID" },
          target: { type: "number", description: "One-off target: a number of Contacts, or 0-100 for a percentage tracker" },
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
        "a percentage). A Contact you may not read is listed as {restricted: true} with no details. For a " +
        "percentage tracker (result_type 'percentage') it also returns denominator ('members' or 'enough_data'), " +
        "denominator_count and percentage (a whole number, or null when denominator_count is 0, shown as '–'); " +
        "the cohort is always within the denominator, and cohort 'not_in' lists the Contacts in the " +
        "denominator who are not in the cohort (the popup's Not in cohort tab). Pass " +
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
          cohort: {
            type: "string",
            enum: ["in", "not_in"],
            description: "Which Contacts to list: 'in' (default) the cohort; 'not_in', for a percentage, the rest of the denominator",
          },
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
        "counts: 'signpostings' (Signpostings made from a Project), 'internal_referrals' (Contacts in a " +
        "Project added to another of the Organisation's Projects), 'cases_created' (Cases created on a " +
        "Project), 'cases_closed' (each time one of those Cases is closed) or 'cases_open' (the Cases open " +
        "at the end of each timeframe). count_mode is 'items' (each signposting, referral, Case or closing; " +
        "result_kind 'additive', adds up across periods, except cases_open which is always 'snapshot') or " +
        "'contacts' (each Contact once; result_kind 'snapshot'). Only an Organisation's editors and reporters, and its project managers, " +
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
        "Year to Date and All-time, and the latest records it counts that you may see (Contact name, who " +
        "they were signposted to, which Project they were referred to or the Case's title, and when); " +
        "hidden_count says how many more are counted but hidden from you, e.g. confidential Cases. Takes the same source, " +
        "count_mode and settings as makerble_create_workflow_tracker.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          project_id: { type: "number", description: "The Project to preview the result on" },
          source: { type: "string", enum: ["signpostings", "internal_referrals", "cases_created", "cases_closed", "cases_open"] },
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
        "project_ids: [...]} (default 'except' with none listed). Cases (the Cases App) linked to the " +
        "Project, or to any of an Album's Projects, each counted once: 'cases_created' counts the Cases " +
        "created; 'cases_closed' counts each time one is closed (a Case closed, reopened and closed again " +
        "counts twice, or once per Contact); 'cases_open' counts the Cases open at the end of each " +
        "timeframe, a snapshot. For these three, settings {case_form_id: n} counts only the Cases created " +
        "with that Case Form (IDs from makerble_list_case_forms); leave it out for any Case Form. " +
        "Confidential Cases are counted but only listed to people who can see them. count_mode 'items' " +
        "(default) counts each signposting, referral, Case or closing and adds up across periods (except " +
        "cases_open); 'contacts' counts each Contact once and is a snapshot. Requires an editor or reporter of the Organisation." +
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
          source: { type: "string", enum: ["signpostings", "internal_referrals", "cases_created", "cases_closed", "cases_open"] },
          count_mode: { type: "string", enum: ["items", "contacts"] },
          settings: {
            type: "object",
            description:
              "internal_referrals: {destinations: 'any'|'only'|'except', project_ids: [number]}; " +
              "cases_created, cases_closed, cases_open: {case_form_id: number} (optional); signpostings: none",
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
          source: { type: "string", enum: ["signpostings", "internal_referrals", "cases_created", "cases_closed", "cases_open"] },
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
      name: "makerble_get_workflow_tracker_results",
      description:
        "Get a Workflow Tracker's result on a Project's or an Album's (Bundle's) Results Canvas, and the items " +
        "behind it (e.g. each signposting: the Contact (Beneficiary), who they were signposted to and when; each " +
        "internal referral: the Contact, the Project they were added to and when; each Case: the Contact, the Case's " +
        "title and case_id, and when it was created, closed or last opened). On an Album the item or " +
        "Contact is counted once across its open Projects, so an Album's result is never the sum of its " +
        "Projects'. result_kind 'additive' (counting each item) adds up across periods; 'snapshot' (counting each " +
        "Contact once, or the Cases open) is worked out for the window on its own, read as_of its last day (or today while that is " +
        "still to come). timeframe is 'period' (the day after the previous Target Deadline up to the deadline), " +
        "'year_to_date' (the start of the Project's year up to the deadline) or 'all_time' (default). as_of is " +
        "the deadline the window ends on (YYYY-MM-DD); without it the window ends at the next Target Deadline, " +
        "or today when there is none, as on the Results Canvas. Returns number, target (the deadline targets in " +
        "the window, added up, or for a snapshot the one at its end; else the one-off target; or null), " +
        "starts_on, ends_on, and a paginated list of items, newest first (data: [{contact_id, contact_name, " +
        "detail, project_id, case_id, happened_at}]; total_count counts every item, whatever the count mode). Items you " +
        "may not see (a Contact you can't read, a referral to a Project you can't see, or a confidential Case) are counted in " +
        "hidden_count for that page but never listed. Pass project_id or album_id; the tracker must be on that " +
        "Project, or one of the Album's Projects. Requires rights to see that Results Canvas. Find trackers " +
        "with makerble_list_workflow_trackers.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Workflow Tracker ID" },
          project_id: { type: "number" },
          album_id: { type: "number", description: "The Album (Bundle) ID" },
          timeframe: { type: "string", enum: ["period", "year_to_date", "all_time"], description: "Default all_time" },
          as_of: { type: "string", description: "The deadline the window ends on, YYYY-MM-DD" },
          page: { type: "number" },
          per_page: { type: "number", description: "Items per page, default 10, max 200" },
        },
        required: ["id"],
      },
      handler: ({ id, project_id, album_id, ...params }) =>
        get(album_id ? `/workflow_trackers/${id}/albums/${album_id}/results` : `/workflow_trackers/${id}/projects/${project_id}/results`, params),
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

    // ── Formula Trackers (CP-8514) ─────────────────────────────────────────────
    {
      name: "makerble_list_formula_trackers",
      description:
        "List an Organisation's Formula Trackers. A Formula Tracker is a metric worked out from the " +
        "Organisation's other trackers with + − × ÷, numbers and brackets, e.g. Referrals completed = " +
        "External referrals + Internal referrals, or % of children receiving support = Children supported ÷ " +
        "Children enrolled × 100. Each has its formula as tokens (expression), formula_text (the formula in " +
        "words), display_format ('number' or 'percentage'), decimal_places, unit_label and result_kind: " +
        "'additive' (only + and − of trackers that add up; adds up across periods) or 'snapshot' (each " +
        "timeframe worked out from its own totals). Only an Organisation's editors and reporters, and its " +
        "project managers, can see them.",
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
      handler: (p) => get("/formula_trackers", p),
    },

    {
      name: "makerble_get_formula_tracker",
      description:
        "Get one Formula Tracker by ID: its formula (expression tokens and formula_text), display settings, " +
        "result_kind, where it is used (usage: projects, albums, templates) and warnings about its formula.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: ({ id }) => get(`/formula_trackers/${id}`),
    },

    {
      name: "makerble_list_formula_tracker_operands",
      description:
        "List the trackers a Formula Tracker can use, by name: the Organisation's Activity and Engagement " +
        "trackers (type 'Change'), Achievement and Numerical trackers (type 'Indicator'; Choice trackers " +
        "aren't listed), Cohort Trackers ('CohortTracker'), Workflow Trackers ('WorkflowTracker'), filtered " +
        "versions ('FilteredMetric') and other Formula Trackers ('FormulaTracker'). Each has the type and id " +
        "to put in a tracker token, its front-end type_name (e.g. 'Engagement tracker'), its unit and whether " +
        "it adds up across periods (result_kind). Use this before makerble_create_formula_tracker.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          page: { type: "number" },
          per_page: { type: "number", description: "Default 10, max 200" },
        },
        required: ["charity_id"],
      },
      handler: (p) => get("/formula_trackers/operands", p),
    },

    {
      name: "makerble_preview_formula_tracker",
      description:
        "Check a formula before saving it: returns its result on one of the Organisation's Projects for the " +
        "current period (ending at the Project's next deadline, or today), Year to Date and All-time (null " +
        "where it divides by 0), each tracker's own result, result_kind, and warnings worth checking (a " +
        "tracker used twice is counted twice; a Numerical tracker added to a count; trackers with different " +
        "units added together; dividing by a tracker that could be 0). A formula with errors (e.g. it ends " +
        "with an operator, or brackets don't match) is refused with errors and warnings. Takes the same " +
        "expression as makerble_create_formula_tracker; pass formula_tracker_id when editing one.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          project_id: { type: "number", description: "The Project to preview the result on" },
          formula_tracker_id: { type: "number", description: "The Formula Tracker being edited, if any" },
          expression: { type: "array", description: "See makerble_create_formula_tracker", items: { type: "object" } },
          display_format: { type: "string", enum: ["number", "percentage"] },
        },
        required: ["charity_id", "project_id", "expression"],
      },
      handler: ({ charity_id, project_id, formula_tracker_id, ...formula_tracker }) =>
        post("/formula_trackers/preview", { charity_id, project_id, formula_tracker_id, formula_tracker }),
    },

    {
      name: "makerble_create_formula_tracker",
      description:
        "Create a Formula Tracker (Create a metric > Formula Tracker): a metric worked out from the " +
        "Organisation's other trackers. expression is the formula as an ordered list of tokens: " +
        "{kind: 'tracker', type, id} (type and id from makerble_list_formula_tracker_operands), " +
        "{kind: 'operator', value: '+' | '-' | '*' | '/'}, {kind: 'number', value: 100}, {kind: 'open'} " +
        "and {kind: 'close'} (brackets). × and ÷ are worked out before + and −, brackets first. Examples: " +
        "A + B is [{kind:'tracker',type:'Change',id:1},{kind:'operator',value:'+'},{kind:'tracker',type:'WorkflowTracker',id:2}]; " +
        "a percentage A ÷ B × 100 adds {kind:'operator',value:'/'}, B, {kind:'operator',value:'*'}, " +
        "{kind:'number',value:100} with display_format 'percentage'. For each timeframe each tracker's result " +
        "is worked out first, then the formula, so a Year to Date percentage is Year to Date numerator ÷ Year " +
        "to Date denominator. Dividing by 0 gives no result. Refused when the formula is empty, starts or ends " +
        "with an operator, has two operators or values in a row, unmatched or empty brackets, uses another " +
        "Organisation's tracker, or uses itself. Requires an editor or reporter of the Organisation." +
        "\nWorkflow: (1) makerble_list_formula_tracker_operands for the trackers. (2) makerble_list_projects " +
        "for a Project ID. (3) makerble_preview_formula_tracker to check the result and warnings. " +
        "(4) makerble_create_formula_tracker. (5) makerble_add_formula_tracker_to_project to place it in a " +
        "column of a Project's Impact Scorecard, optionally with a target. Albums pick it up automatically.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "The Organisation (Charity) ID" },
          name: { type: "string", description: "Shown next to the result, e.g. 'Referrals completed'" },
          description: { type: "string" },
          expression: {
            type: "array",
            description: "The formula's tokens, in order",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["tracker", "operator", "number", "open", "close"] },
                type: { type: "string", enum: ["Change", "Indicator", "CohortTracker", "WorkflowTracker", "FilteredMetric", "FormulaTracker"] },
                id: { type: "number" },
                value: { description: "operator: + - * /; number: the number" },
              },
              required: ["kind"],
            },
          },
          display_format: { type: "string", enum: ["number", "percentage"], description: "Show result as (default number)" },
          decimal_places: { type: "number", description: "0 to 3, default 0" },
          unit_label: { type: "string", description: "Optional, e.g. 'h per child'" },
        },
        required: ["charity_id", "name", "expression"],
      },
      handler: ({ charity_id, ...formula_tracker }) =>
        post("/formula_trackers", { formula_tracker: { charity_id, ...formula_tracker } }),
    },

    {
      name: "makerble_update_formula_tracker",
      description:
        "Update a Formula Tracker's name, description, expression (replaces the whole formula), " +
        "display_format, decimal_places or unit_label. Only the fields sent change. Changes apply everywhere " +
        "it is used (see makerble_get_formula_tracker usage). Requires an Organisation editor, or the " +
        "reporter who created it.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
          description: { type: "string" },
          expression: { type: "array", description: "See makerble_create_formula_tracker", items: { type: "object" } },
          display_format: { type: "string", enum: ["number", "percentage"] },
          decimal_places: { type: "number" },
          unit_label: { type: "string" },
        },
        required: ["id"],
      },
      handler: ({ id, ...formula_tracker }) => patch(`/formula_trackers/${id}`, { formula_tracker }),
    },

    {
      name: "makerble_delete_formula_tracker",
      description:
        "Delete a Formula Tracker. Refused while it is used on any Project, Album or Scorecard Template; " +
        "remove it from those first.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      handler: async ({ id }) => {
        await del(`/formula_trackers/${id}`);
        return { deleted: true, id };
      },
    },

    {
      name: "makerble_add_formula_tracker_to_project",
      description:
        "Place a Formula Tracker in a column of a Project's Impact Scorecard (Edit Project Metrics), " +
        "optionally with a one-off target (a whole percentage, 0 to 100, for a percentage tracker). Columns: " +
        "activities, engagement, potential (short-term outcomes), behaviour (medium-term), growth (long-term). " +
        "The tracker and Project must belong to the same Organisation, and you need rights to edit the " +
        "Project's metrics.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Formula Tracker ID" },
          project_id: { type: "number" },
          column: { type: "string", enum: ["activities", "engagement", "potential", "behaviour", "growth"] },
          target: { type: "number", description: "Optional one-off target" },
        },
        required: ["id", "project_id", "column"],
      },
      handler: ({ id, project_id, column, target }) =>
        post(`/formula_trackers/${id}/projects/${project_id}`, { column, ...(target !== undefined ? { target } : {}) }),
    },

    {
      name: "makerble_get_formula_tracker_targets",
      description:
        "Get a Formula Tracker's targets on a Project or an Album (its Set Targets page): the one-off " +
        "target and any deadline targets ([{date, number}]). Pass project_id or album_id. Requires rights to " +
        "edit that Project's or Album's targets.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Formula Tracker ID" },
          project_id: { type: "number" },
          album_id: { type: "number", description: "The Album (Bundle) ID" },
        },
        required: ["id"],
      },
      handler: ({ id, project_id, album_id }) =>
        get(album_id ? `/formula_trackers/${id}/albums/${album_id}` : `/formula_trackers/${id}/projects/${project_id}`),
    },

    {
      name: "makerble_set_formula_tracker_targets",
      description:
        "Set a Formula Tracker's targets on a Project or an Album (Set Targets): target is the one-off " +
        "number; deadlines is a list of {date: 'YYYY-MM-DD', number} that REPLACES this tracker's deadline " +
        "targets there ([] clears them). An additive tracker adds its targets up across deadlines; a snapshot " +
        "uses each deadline's target on its own. A percentage tracker's targets are whole percentages from 0 " +
        "to 100. An Album's target is never the sum of its Projects'. The tracker must already be on that " +
        "Project or one of the Album's Projects. Requires rights to edit that Project's or Album's targets.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Formula Tracker ID" },
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
        patch(album_id ? `/formula_trackers/${id}/albums/${album_id}` : `/formula_trackers/${id}/projects/${project_id}`, targets),
    },

    {
      name: "makerble_remove_formula_tracker_from_project",
      description: "Remove a Formula Tracker from a Project's Impact Scorecard, and its Albums if no other Project in them uses it.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The Formula Tracker ID" },
          project_id: { type: "number" },
        },
        required: ["id", "project_id"],
      },
      handler: async ({ id, project_id }) => {
        await del(`/formula_trackers/${id}/projects/${project_id}`);
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
      name: "makerble_copy_metric",
      description:
        "Copy a metric: an Output (API: Change), an Outcome or an Indicator (Progress Tracker). " +
        "Use it when someone wants a new metric that starts from an existing one, e.g. the same indicator with different wording. " +
        "The copy is called \"Copy of <original name>\" (numbered, e.g. \"Copy of X (2)\", if that name is taken), has the same owner, " +
        "settings, survey question wording and levels, and is not added to any Project, Survey (Story Category) or Impact Framework. " +
        "A copied Indicator keeps the original's Outcomes; a copied Outcome keeps the original's Indicators. " +
        "Only someone who can edit the original may copy it. Returns { id, metric_class, name, owner_type, owner_id, copied_from_id }. " +
        "To rename the copy afterwards, edit it in Makerble (Edit Metric).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "ID of the metric to copy." },
          metric_class: {
            type: "string",
            enum: ["Change", "Indicator", "Outcome"],
            description: "What kind of metric it is: Change (an Output), Indicator or Outcome.",
          },
        },
        required: ["id", "metric_class"],
      },
      handler: ({ id, metric_class }) => post(`/metrics/${id}/copy`, { metric_class }),
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

    // ── Add metric to (CP-559) ───────────────────────────────────────────────
    // project_id / bundle_id say whose results a Progress Board card shows. DELETE takes no body,
    // so they go in the query string for every call.
    {
      name: "makerble_list_metric_destinations",
      description:
        "Where a metric can be added: the options of the Add metric to popup in the Makerble app. " +
        "A metric is a Change (activity or participation KPI), an Outcome or an Indicator; a Cohort Tracker or Workflow Tracker (metric_type cohort_tracker / workflow_tracker) " +
        "can also be added, to 'projects' and 'impact_frameworks' only: each item then has column, the Impact Scorecard column it is in (null if it isn't there). " +
        "Without destination, returns the destination types offered for the metric, e.g. " +
        "[{key: 'projects', label: 'Projects'}, {key: 'impact_frameworks', label: 'Impact Frameworks'}, {key: 'surveys', label: 'Surveys'}, {key: 'collections', label: 'Collections'}]. " +
        "An Indicator also gets 'outcomes' (Outcomes it can be added to, i.e. made a child of) when you can edit an Outcome; " +
        "an Outcome you can edit gets 'indicators' (Indicators to make it the parent of). " +
        "A Collection is a curated set of metrics, surveys and other resources that people can browse and reuse. " +
        "An Impact Framework (Template) is a reusable set of metrics that can be applied to several Projects. " +
        "An Indicator is never added to a Project or Impact Framework directly, only through one of its Outcomes, so it has neither option (it can go in a Collection). " +
        "With destination (e.g. 'projects'), returns a page of the places of that type you can add the metric to, each with " +
        "added: true if the metric is already there. For projects, these are the open Projects whose metrics you can edit, " +
        "with their Organisation; for impact_frameworks, the Impact Frameworks you created (only their creator can edit them); for surveys, the Surveys (Story Categories) you can edit, with their owner; for collections, your own Collections and those of Organisations you are an editor of, with their owner; for outcomes, the Outcomes you can edit; " +
        "for indicators, the Indicators you can see (your own, your Organisations' and the public library), with their indicator_type. " +
        "for progress_boards, the open Progress Boards you created or are a Board Admin of, with board_type 'managed' or 'basic'. " +
        "Progress Boards are only offered for a Change or an Indicator (a board has no Outcome card), and only when you pass project_id (a Project) or bundle_id (an Album, the API's Bundle) whose results the board's card will show. " +
        "Pass q to search outcomes or indicators by name. Each item has removable: false when it can't be removed here: a Survey that already asks the metric, " +
        "or an Outcome/Indicator link that stories have already used. Use before makerble_add_metric_to or makerble_remove_metric_from to find the target_id.",
      inputSchema: {
        type: "object",
        properties: {
          metric_type: { type: "string", enum: ["change", "outcome", "indicator", "cohort_tracker", "workflow_tracker"] },
          metric_id: { type: "number" },
          destination: { type: "string", description: "A key from the list of destination types: 'projects', 'impact_frameworks', 'surveys', 'collections', 'outcomes', 'indicators' or 'progress_boards'" },
          project_id: { type: "number", description: "For progress_boards: the Project whose results the card shows" },
          bundle_id: { type: "number", description: "For progress_boards: the Album (Bundle) whose results the card shows, instead of a Project" },
          q: { type: "string", description: "Search by name (outcomes and indicators only)" },
          page: { type: "number" },
          per_page: { type: "number", description: "Default 10, max 200" },
        },
        required: ["metric_type", "metric_id"],
      },
      handler: ({ metric_type, metric_id, destination, ...params }) =>
        get(`/metrics/${metric_type}/${metric_id}/destinations${destination ? `/${destination}` : ""}`, params),
    },

    {
      name: "makerble_add_metric_to",
      description:
        "Add a metric (Change, Outcome or Indicator) to a Project, an Impact Framework or a Collection, the same as the Add metric to popup in the Makerble app. " +
        "On a Project (destination 'projects') it goes in the Impact Scorecard column of its own stage, after the " +
        "metrics already there, as on Edit Project Metrics; it is also added to the Project's Default Survey and, if the Organisation uses one, its " +
        "default Progress Board. Requires rights to edit the Project's metrics. On an Impact Framework (destination 'impact_frameworks') it goes in " +
        "its own stage, which is added to the framework if missing; you must have created the framework. In a Collection (destination 'collections', " +
        "which also takes an Indicator) it goes at the end; you must own the Collection or edit the Organisation that owns it. " +
        "On a Survey (destination 'surveys', a Story Category) it becomes the last, optional question; a scale Indicator is Single Choice, " +
        "and an Outcome adds each of its Indicators (as a grid when they share answer choices); you must be able to edit the Survey. " +
        "With destination 'outcomes' (metric_type indicator) or 'indicators' (metric_type outcome), it makes the Outcome a parent of the Indicator; " +
        "you must be able to edit the Outcome. " +
        "A Cohort or Workflow Tracker goes on a Project (only its own Organisation's) or an Impact Framework in the column you pass: " +
        "'activities', 'engagement' (the default), 'potential', 'behaviour' or 'growth'. " +
        "On a Progress Board (destination 'progress_boards', a Change or an Indicator only, with project_id or bundle_id) it becomes the board's last card, showing that Project's or Album's results; " +
        "you must have created the board or be one of its Board Admins. Leave out target_id to create a new Managed Progress Board " +
        "named \"<your name>'s Progress Board\" for the Project's Organisation with the card on it; this returns {added: true, data: {id, name}}. " +
        "Workflow: (1) makerble_list_metric_destinations with destination 'projects' to find the Project's id (target_id) " +
        "(or the Impact Framework's id) and check it isn't already added. (2) makerble_add_metric_to. Returns {added: true}.",
      inputSchema: {
        type: "object",
        properties: {
          metric_type: { type: "string", enum: ["change", "outcome", "indicator", "cohort_tracker", "workflow_tracker"] },
          metric_id: { type: "number" },
          destination: { type: "string", enum: ["projects", "impact_frameworks", "surveys", "collections", "outcomes", "indicators", "progress_boards"] },
          target_id: { type: "number", description: "The id of the Project (or other destination) to add it to. Leave out only for progress_boards, to create a new board" },
          column: { type: "string", enum: ["activities", "engagement", "potential", "behaviour", "growth"], description: "For a Cohort or Workflow Tracker: the Impact Scorecard column to put it in (default engagement)" },
          project_id: { type: "number", description: "For progress_boards: the Project whose results the card shows" },
          bundle_id: { type: "number", description: "For progress_boards: the Album (Bundle) whose results the card shows, instead of a Project" },
        },
        required: ["metric_type", "metric_id", "destination"],
      },
      handler: ({ metric_type, metric_id, destination, target_id, project_id, bundle_id, column }) =>
        post(metricDestinationPath(metric_type, metric_id, destination, target_id, { project_id, bundle_id, column })),
    },

    {
      name: "makerble_remove_metric_from",
      description:
        "Remove a metric from a Project, an Impact Framework, a Collection or a Progress Board, the same as removing it in the Add metric to popup. " +
        "For a Progress Board, pass the same project_id or bundle_id as when adding: only that Project's or Album's card is removed. " +
        "A Survey's questions can't be removed this way (edit the Survey instead). For outcomes/indicators, it unlinks the Indicator from the Outcome, which is refused once stories have recorded the Indicator under that Outcome. " +
        "Requires the same rights as adding it. Stories already recorded against the metric are kept. Returns {added: false}.",
      inputSchema: {
        type: "object",
        properties: {
          metric_type: { type: "string", enum: ["change", "outcome", "indicator", "cohort_tracker", "workflow_tracker"] },
          metric_id: { type: "number" },
          destination: { type: "string", enum: ["projects", "impact_frameworks", "surveys", "collections", "outcomes", "indicators", "progress_boards"] },
          target_id: { type: "number", description: "The id of the Project (or other destination) to remove it from" },
          project_id: { type: "number", description: "For progress_boards: the Project whose card to remove" },
          bundle_id: { type: "number", description: "For progress_boards: the Album (Bundle) whose card to remove" },
        },
        required: ["metric_type", "metric_id", "destination", "target_id"],
      },
      handler: ({ metric_type, metric_id, destination, target_id, project_id, bundle_id }) =>
        del(metricDestinationPath(metric_type, metric_id, destination, target_id, { project_id, bundle_id })),
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
    // ── Events ─────────────────────────────────────────────────────────────────
    {
      name: "makerble_list_events",
      description:
        "List the events the user can see, soonest first — the same events as Makerble's Manage Events " +
        "page. An event is a session, class, appointment or other gathering run within a Project. A recurring " +
        "series of events starts with a 'master' event followed by its 'subsequent' events; one-off events " +
        "have event_type 'one-off'. Organisation Admins see every event in their organisation; other users see " +
        "the events of projects they edit and events they are an Event Manager or Event Worker at. " +
        "Filters: charity_id (one organisation), project_id, event_category_id (Event Format, e.g. Workshops — " +
        "find ids with makerble_list_event_formats), event_type, start_date / end_date (YYYY-MM-DD; the event " +
        "starts between them), master_event_id (every event in one recurring series), and form_field_filters: " +
        "the answers on the event's Event Creation Form (its custom fields and Dropdowns), e.g. every event whose " +
        "Activity Dropdown is Archery. Call makerble_list_event_filter_fields first for the filter keys, then pass " +
        "an object of key => value: text for a Text / Email Address field (contains, ignoring case), digits for a " +
        "Telephone field, 'yes' or 'no' for a Tickbox / Attachment / Signature field, <key>_from and/or <key>_to " +
        "for a Number, Date (YYYY-MM-DD) or Time (HH:MM) range, and a list of answer choice ids for a Dropdown " +
        "(the event matches if it has any of them). Several keys must all match. sort orders the whole list by " +
        "those fields: a sort_key from makerble_list_event_filter_fields followed by asc or desc, several " +
        "comma-separated; blank answers come last. Each item returns id, " +
        "name, start_datetime, end_datetime, timezone, location, event_type, master_event_id, project {id, name}, " +
        "event_category {id, name} (the Event Format), guests_count (guests are Contacts), managers_count and " +
        "workers_count. Use makerble_get_event for an event's full details. " +
        "Paginated: returns { page, page_size, page_count, total_count, data }.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "Only this Organisation's (Charity's) events" },
          project_id: { type: "number", description: "Only this Project's events" },
          event_category_id: { type: "number", description: "Only events of this Event Format (event_category)" },
          event_type: { type: "string", enum: ["one-off", "master", "subsequent"], description: "master = first event of a recurring series; subsequent = the rest of the series" },
          start_date: { type: "string", description: "Only events starting on or after this date (YYYY-MM-DD)" },
          end_date: { type: "string", description: "Only events starting on or before this date (YYYY-MM-DD)" },
          master_event_id: { type: "number", description: "Only the events of the recurring series this master event starts" },
          form_field_filters: {
            type: "object",
            description:
              "Event Creation Form answers to match, keyed by the filter_keys of makerble_list_event_filter_fields, " +
              "e.g. { \"custom_field_12\": \"archery\", \"custom_field_15_from\": 5, \"ratio_set_7\": [31, 32] }",
            additionalProperties: {
              oneOf: [{ type: "string" }, { type: "number" }, { type: "array", items: { type: "number" } }],
            },
          },
          sort: { type: "string", description: "e.g. 'custom_field_12 desc' or 'ratio_set_7 asc, custom_field_15 desc'. Default: soonest first" },
          page: { type: "number" },
          per_page: { type: "number", description: "Events per page. Default 10, max 200" },
          last_synced_datetime: { type: "string", description: "Only events changed after this ISO 8601 time" },
        },
      },
      handler: (p) => get("/events", p),
    },

    {
      name: "makerble_list_event_filter_fields",
      description:
        "List the fields events can be filtered and sorted by with makerble_list_events: the custom fields and " +
        "Dropdowns (ratio sets) on the Event Creation Forms of the user's organisations' Event Formats " +
        "(event categories) — the 'Event Creation Form fields' section of the Filter Events panel on Makerble's " +
        "Manage Events page. Use it when someone wants to find events by what was recorded about them, e.g. 'all " +
        "the archery sessions' or 'events for ages 5 to 10'. Each item returns key, id, name, data_type (text, " +
        "email_address, telephone, number, date, time, tickbox, file (Attachment), signature or dropdown), " +
        "filter_keys (the keys to use in form_field_filters; a Number, Date or Time field has <key>_from and " +
        "<key>_to), filter_hint (what value to send) and sort_key (for sort). A Dropdown's filter takes answer " +
        "choice (sub ratio) ids: pass dropdown_id with that item's id, and optionally query with part of a " +
        "name, to list its answer choices [{id, name}] alphabetically instead. " +
        "Paginated: returns { page, page_size, page_count, total_count, data }.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "Only this Organisation's (Charity's) Event Creation Forms" },
          dropdown_id: { type: "number", description: "List this Dropdown's answer choices instead of the fields" },
          query: { type: "string", description: "With dropdown_id: only answer choices whose name contains this" },
          page: { type: "number" },
          per_page: { type: "number", description: "Items per page. Default 10, max 200" },
        },
      },
      handler: ({ dropdown_id, ...p }) =>
        dropdown_id ? get(`/event_filter_fields/${dropdown_id}/choices`, p) : get("/event_filter_fields", p),
    },

    {
      name: "makerble_get_event",
      description:
        "Get one event's full details, as shown on its event page and Edit Event page in Makerble. Returns the " +
        "fields from makerble_list_events plus: can_edit and can_delete (whether this user may change or delete " +
        "it); for a master event (the first of a recurring series) recurring_schedule {rule, description} such as " +
        "'Weekly on Tuesdays', recurring_end_date and series_events_count; custom_fields [{id, name, value}] and " +
        "dropdowns [{id, name, answer_choices: [{id, name}]}] from its Event Format (Dropdown = ratio set, answer " +
        "choice = sub ratio); signup_page {id, name} (the Signup Page / referral link detail people register " +
        "through); self_check_in {survey, wave} (the Survey / story category guests answer when they check " +
        "themselves in, also called Kiosk); capacity (guest and worker limits, whether sign-up continues once " +
        "the event is full, the Guest Status ids (event states) new sign-ups get, messages, timesheet settings); " +
        "listing (whether it appears in Events Catalogues, location, description, image); and links " +
        "{self_check_in, signup, signup_and_self_check_in} — web addresses to share with guests, null when the " +
        "event has no such page. A user who can't see the event gets 403; another organisation's event, 404.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The event id" },
        },
        required: ["id"],
      },
      handler: ({ id }) => get(`/events/${id}`),
    },

    {
      name: "makerble_list_project_event_formats",
      description:
        "List the Event Formats (event_category in the API) a user can create events with in one Project — " +
        "the formats Makerble's Create Event form offers for that Project. An Event Format is a template for " +
        "events, e.g. Workshops or Drop-in Sessions. This is also how to find out whether the user may create " +
        "events in the Project: if they can't (the Project has events turned off, or they aren't an " +
        "Organisation Admin, a Project Manager, or a Project Reporter / Observer chosen as an Event Creator), " +
        "it returns 403. Each item returns id, name and is_default. First step of creating an event: pick a " +
        "format here, then call makerble_get_event_form with its id. " +
        "Paginated: returns { page, page_size, page_count, total_count, data }.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number", description: "The Project the event will belong to" },
          page: { type: "number" },
          per_page: { type: "number", description: "Event Formats per page. Default 10, max 200" },
        },
        required: ["project_id"],
      },
      handler: ({ project_id, ...p }) => get(`/projects/${project_id}/event_categories`, p),
    },

    {
      name: "makerble_get_event_form",
      description:
        "Get everything Makerble's Create Event (or Edit Event) form offers once an Event Format is chosen in a " +
        "Project, so you know what to ask the user and which ids to send when creating or editing the event. " +
        "Returns: fields — the format's fields in order, each with name, kind ('event_attribute' for name / " +
        "start_datetime / end_datetime, 'custom_field', or 'dropdown'), field_id (the custom field or Dropdown " +
        "id), data_type (e.g. text, number, date, tickbox, ward, datetime, dropdown), mandatory, " +
        "validation_hint (the rule a custom field's answer must follow) and, for a Dropdown (ratio set), " +
        "dropdown {choice: single_choice | unlimited_choice | limited_choice, choice_limit, options: [{id, " +
        "name}]} (options are answer choices / sub ratios); self_check_in {enabled, surveys, waves} — whether " +
        "the format has Self Check-in (Kiosk) and the Project's Surveys (story categories; send their " +
        "project_story_category_id) and their Waves (send the wave's id as wave_id) to choose from; signup_pages [{id, " +
        "name}] — the Project's Signup Pages (referral link details) people can register through; " +
        "guest_statuses [{id, name}] — the Guest Statuses (event states) a Signup Page can put people into, " +
        "in order, the first being the default; event_roles {enabled, guests, event_managers_and_workers}. " +
        "Workflow: makerble_list_project_event_formats → this tool → create the event. Pass event_id to get " +
        "the Edit Event form for an existing event. Returns 403 if the user can't create events in the " +
        "Project (or can't edit the event), 404 if the Event Format isn't available in the Project.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number", description: "The Project the event belongs to" },
          event_category_id: { type: "number", description: "The chosen Event Format id, from makerble_list_project_event_formats" },
          event_id: { type: "number", description: "Only when editing: the event being edited" },
        },
        required: ["project_id", "event_category_id"],
      },
      handler: ({ project_id, ...p }) => get(`/projects/${project_id}/event_form`, p),
    },

    {
      name: "makerble_create_event",
      description:
        "Create an event — a session, class, appointment or other gathering — in a Project, as Makerble's " +
        "Create Event form does. Workflow: (1) find a Project (makerble_list_projects); (2) list the Event " +
        "Formats you can use there with makerble_list_project_event_formats (a 403 means the user can't create " +
        "events in that Project); (3) get the form for the chosen format with makerble_get_event_form; (4) ask " +
        "the user for the mandatory fields and any choices, then call this tool with the ids the form returned. " +
        "For a recurring series pass recurring_schedule and recurring_end_date: Makerble creates the master " +
        "event (the first of the series) and every subsequent event up to that date. The user becomes the Event " +
        "Manager unless manager_ids is given. Every id is checked against the form, and all problems come back " +
        "together as a 422 { errors: [...] } — fix them and try again. Returns the new event as makerble_get_event " +
        "does. Not supported: an event image, and adding guests (Contacts) — add guests separately.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number", description: "The Project the event belongs to" },
          event_category_id: { type: "number", description: "The Event Format (event category), from makerble_list_project_event_formats" },
          name: { type: "string" },
          start_datetime: { type: "string", description: "ISO 8601, e.g. 2030-01-08T18:00. Without an offset it is a local time in timezone" },
          end_datetime: { type: "string", description: "ISO 8601, after start_datetime" },
          timezone: { type: "string", description: "IANA time zone name, e.g. Europe/London. Defaults to the user's. Daylight saving is handled by Makerble" },
          location: { type: "string" },
          custom_fields: { type: "object", description: "Custom field id => value, using field_id from makerble_get_event_form. Dates YYYY-MM-DD, times HH:MM, tickboxes true/false" },
          dropdowns: { type: "object", description: "Dropdown (ratio set) id => array of answer choice (sub ratio) ids, within the Dropdown's choice rule" },
          manager_ids: { type: "array", items: { type: "number" }, description: "Event Managers (user ids of colleagues in the Project or organisation). At least one" },
          worker_ids: { type: "array", items: { type: "number" }, description: "Event Workers (user ids of colleagues in the Project or organisation)" },
          signup_page_id: { type: ["number", "null"], description: "A Signup Page (referral link detail) from the form's signup_pages, or null for none" },
          guest_status_for_signup_id: { type: "number", description: "Guest Status (event state) for people who sign up while there is space; from the form's guest_statuses" },
          self_check_in: { type: ["object", "null"], description: "{ project_story_category_id, wave_id } from the form's self_check_in surveys and waves, or null for none. Only when the Event Format has Self Check-in on" },
          capacity: { type: "object", description: "{ guests: 'fixed'|'unlimited', max_guests, allow_signup_after_full, guest_status_after_full_id, confirmation_message_after_full, thank_you_message, workers: 'fixed'|'unlimited', max_workers, timesheets_for_workers, timesheets_for_guests }" },
          listing: { type: "object", description: "{ listing_enabled, description (HTML) } — the public event listing for Events Catalogues. Needs a Signup Page" },
          recurring_schedule: {
            type: "object",
            description: "For a recurring series: { frequency: 'daily'|'weekly'|'monthly'|'yearly', interval (default 1), days_of_week: ['tuesday', ...] for weekly, days_of_month: [1, 15, -1 for last] for monthly }",
          },
          recurring_end_date: { type: "string", description: "YYYY-MM-DD, the last day of the series. Required with recurring_schedule" },
        },
        required: ["project_id", "event_category_id", "name", "start_datetime", "end_datetime"],
      },
      handler: (p) => post("/events", p),
    },

    {
      name: "makerble_update_event",
      description:
        "Change an event, as Makerble's Edit Event page does. Only the fields you pass change; Dropdowns you " +
        "don't mention keep their answers. Get valid ids from makerble_get_event_form with event_id. For a " +
        "master event (the first of a recurring series), pass apply_to: 'all_events_in_series' to apply the " +
        "change to every event in the series (the default, 'this_event', changes only this one). Locked, as on " +
        "the Edit Event page: the Project, a series' time zone, and a master event's start and end times. " +
        "To change a series' Recurring Schedule or Recurring End Date, use makerble_change_event_series. " +
        "Returns the event as makerble_get_event does; problems come back together as a 422 { errors: [...] }. Needs " +
        "permission to edit the event (403 otherwise).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The event id" },
          event_category_id: { type: "number", description: "A different Event Format, from makerble_list_project_event_formats" },
          name: { type: "string" },
          start_datetime: { type: "string", description: "ISO 8601, e.g. 2030-01-08T18:00. Without an offset it is a local time in timezone" },
          end_datetime: { type: "string", description: "ISO 8601, after start_datetime" },
          timezone: { type: "string", description: "IANA time zone name, e.g. Europe/London. Defaults to the user's. Daylight saving is handled by Makerble" },
          location: { type: "string" },
          custom_fields: { type: "object", description: "Custom field id => value, using field_id from makerble_get_event_form. Dates YYYY-MM-DD, times HH:MM, tickboxes true/false" },
          dropdowns: { type: "object", description: "Dropdown (ratio set) id => array of answer choice (sub ratio) ids, within the Dropdown's choice rule" },
          manager_ids: { type: "array", items: { type: "number" }, description: "Event Managers (user ids of colleagues in the Project or organisation). At least one" },
          worker_ids: { type: "array", items: { type: "number" }, description: "Event Workers (user ids of colleagues in the Project or organisation)" },
          signup_page_id: { type: ["number", "null"], description: "A Signup Page (referral link detail) from the form's signup_pages, or null for none" },
          guest_status_for_signup_id: { type: "number", description: "Guest Status (event state) for people who sign up while there is space; from the form's guest_statuses" },
          self_check_in: { type: ["object", "null"], description: "{ project_story_category_id, wave_id } from the form's self_check_in surveys and waves, or null for none. Only when the Event Format has Self Check-in on" },
          capacity: { type: "object", description: "{ guests: 'fixed'|'unlimited', max_guests, allow_signup_after_full, guest_status_after_full_id, confirmation_message_after_full, thank_you_message, workers: 'fixed'|'unlimited', max_workers, timesheets_for_workers, timesheets_for_guests }" },
          listing: { type: "object", description: "{ listing_enabled, description (HTML) } — the public event listing for Events Catalogues. Needs a Signup Page" },
          apply_to: { type: "string", enum: ["this_event", "all_events_in_series"], description: "For a master event: also change every event in its series" },
        },
        required: ["id"],
      },
      handler: ({ id, ...p }) => patch(`/events/${id}`, p),
    },

    {
      name: "makerble_preview_event_series_change",
      description:
        "Preview what a new Recurring Schedule or Recurring End Date would do to a recurring series of " +
        "events, without changing anything, as Makerble's Edit Event Series page shows before saving. Pass the " +
        "id of the master event (the first event of the series; event_type 'master' in makerble_get_event). " +
        "Leave out recurring_schedule or recurring_end_date to keep its current value. Returns " +
        "recurring_schedule (with a plain-English description), recurring_end_date, required_dates (every " +
        "date the new schedule needs, with event_id of the event already on it, or exists: false for one that " +
        "would be created) and no_longer_fitting_events (events that don't fit the new schedule, with " +
        "has_stories and has_timesheets). Step 1 of 2: show the user the no_longer_fitting_events, warn " +
        "them about any with Stories or timesheets, ask which to keep and which to delete, then call " +
        "makerble_change_event_series. Needs permission to edit the event (403 otherwise).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The master event's id" },
          recurring_schedule: { type: "object", description: "{ frequency: 'daily'|'weekly'|'monthly'|'yearly', interval (every N; default 1), days_of_week (weekly: e.g. ['tuesday']), days_of_month (monthly: e.g. [1, -1], -1 is the last day) }" },
          recurring_end_date: { type: "string", description: "New Recurring End Date, YYYY-MM-DD" },
        },
        required: ["id"],
      },
      handler: ({ id, ...p }) => post(`/events/${id}/series_schedule_preview`, p),
    },

    {
      name: "makerble_change_event_series",
      description:
        "Change a recurring series' Recurring Schedule and/or Recurring End Date, as Makerble's Edit Event " +
        "Series page does. Step 2 of 2: call makerble_preview_event_series_change first with the same " +
        "values. Every event in its no_longer_fitting_events must be listed in keep_event_ids or " +
        "delete_event_ids (ask the user; deleting an event also deletes what is recorded against it), or " +
        "nothing changes and you get a 422. Events for the new dates are created, and the series is " +
        "renumbered in date order. Pass the master event's id. Returns the master event as makerble_get_event " +
        "does. Needs permission to edit the event (403 otherwise).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The master event's id" },
          recurring_schedule: { type: "object", description: "{ frequency: 'daily'|'weekly'|'monthly'|'yearly', interval (every N; default 1), days_of_week (weekly: e.g. ['tuesday']), days_of_month (monthly: e.g. [1, -1], -1 is the last day) }" },
          recurring_end_date: { type: "string", description: "New Recurring End Date, YYYY-MM-DD" },
          keep_event_ids: { type: "array", items: { type: "number" }, description: "Events that no longer fit, to keep" },
          delete_event_ids: { type: "array", items: { type: "number" }, description: "Events that no longer fit, to delete" },
        },
        required: ["id"],
      },
      handler: ({ id, ...p }) => patch(`/events/${id}`, p),
    },

    {
      name: "makerble_delete_event",
      description:
        "Delete an event, as Makerble's Delete Event does. Deleting a master event (the first event of a " +
        "recurring series) deletes the whole series. For a later event in a series, delete_option chooses " +
        "what goes: 'this_event' (default), 'current_and_upcoming_series_events', or 'all_series_events'. " +
        "Deleting an event also deletes what is recorded against it, so confirm with the user first, naming " +
        "the events. Returns { deleted_event_ids }. Needs permission to edit the event (403 otherwise).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The event id" },
          delete_option: { type: "string", enum: ["this_event", "current_and_upcoming_series_events", "all_series_events"] },
        },
        required: ["id"],
      },
      handler: ({ id, delete_option }) => del(`/events/${id}${query({ delete_option })}`),
    },

    {
      name: "makerble_list_event_guests",
      description:
        "List an event's guests (Contacts / beneficiaries), by name, with each one's Guest Status (event state) " +
        "and, when the Event Format has Event Roles turned on, Event Role. Returns { page, page_size, " +
        "page_count, total_count, data: [{ contact_id, name, guest_status: {id, name}, event_role: {id, name} " +
        "or null, added_at, updated_at }] }. Anyone who can open the event page can see them. To find one " +
        "guest, pass search: part of their name or Contact ID; it searches every page, not only the one returned.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The event id" },
          search: { type: "string", description: "Part of a guest's name or Contact ID (the prefix and leading zeros of a Contact ID are ignored)" },
          page: { type: "number" },
          per_page: { type: "number", description: "Guests per page. Default 10, max 200" },
          last_synced_datetime: { type: "string", description: "Only guests added or changed after this ISO 8601 time" },
        },
        required: ["id"],
      },
      handler: ({ id, ...p }) => get(`/events/${id}/guests`, p),
    },

    {
      name: "makerble_add_event_guests",
      description:
        "Add Contacts (beneficiaries) as guests of an event, as the event page's Add Guests does. Only Contacts " +
        "in the event's Project can be added (find them with makerble_list_project_contacts). Contacts already " +
        "on the event are left as they are. guest_status_id is a Guest Status (event state) from " +
        "makerble_get_event_form's guest_statuses (default: the first); each Contact must meet that Guest " +
        "Status's requirements, or the request is refused with 422 naming the requirement. event_role_id is " +
        "one of the form's event_roles.guests. A fixed guest limit is respected. For an event in a recurring " +
        "series, apply_to 'this_and_upcoming_events' also adds them to the later events. Returns { event_id, " +
        "guests_count }; every problem comes back together as 422 { errors }.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The event id" },
          contact_ids: { type: "array", items: { type: "number" }, description: "Contact (beneficiary) ids" },
          guest_status_id: { type: "number", description: "Guest Status (event state) id" },
          event_role_id: { type: "number", description: "Event Role id for guests" },
          apply_to: { type: "string", enum: ["this_event", "this_and_upcoming_events"] },
        },
        required: ["id", "contact_ids"],
      },
      handler: ({ id, ...p }) => post(`/events/${id}/guests`, p),
    },

    {
      name: "makerble_update_event_guest",
      description:
        "Change one guest's Guest Status (event state), e.g. from Registered to Attended, and/or Event Role on " +
        "an event. The Contact must meet the new Guest Status's requirements (422 otherwise). Pass " +
        "event_role_id: null to clear the role; leave it out to keep it. Returns { event_id, guests_count }.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The event id" },
          contact_id: { type: "number", description: "The guest's Contact (beneficiary) id" },
          guest_status_id: { type: "number", description: "Guest Status (event state) id from makerble_get_event_form" },
          event_role_id: { type: ["number", "null"], description: "Event Role id for guests, or null to clear it" },
        },
        required: ["id", "contact_id"],
      },
      handler: ({ id, contact_id, ...p }) => patch(`/events/${id}/guests/${contact_id}`, p),
    },

    {
      name: "makerble_remove_event_guest",
      description:
        "Remove a Contact (beneficiary) from an event's guests. For an event in a recurring series, apply_to " +
        "'this_and_upcoming_events' also removes them from the later events. Returns { event_id, guests_count }.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The event id" },
          contact_id: { type: "number", description: "The guest's Contact (beneficiary) id" },
          apply_to: { type: "string", enum: ["this_event", "this_and_upcoming_events"] },
        },
        required: ["id", "contact_id"],
      },
      handler: ({ id, contact_id, apply_to }) => del(`/events/${id}/guests/${contact_id}${query({ apply_to })}`),
    },

    {
      name: "makerble_list_event_staff",
      description:
        "List an event's Event Managers and Event Workers (users), by name. Returns { page, page_size, " +
        "page_count, total_count, data: [{ user_id, name, roles: ['manager' and/or 'worker'], event_role: " +
        "{id, name} or null }] }. Anyone who can open the event page can see them.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The event id" },
          page: { type: "number" },
          per_page: { type: "number", description: "Staff per page. Default 10, max 200" },
        },
        required: ["id"],
      },
      handler: ({ id, ...p }) => get(`/events/${id}/staff`, p),
    },

    {
      name: "makerble_add_event_staff",
      description:
        "Add colleagues as Event Managers or Event Workers of an event, as the Edit Event form does. They must " +
        "be colleagues in the event's Project or organisation (find their user ids with makerble_list_users), and a fixed " +
        "worker limit is respected. event_role_id is one of the form's event_roles.event_managers_and_workers, " +
        "set on this event. For a master event (first of a recurring series), apply_to " +
        "'all_events_in_series' adds them to the whole series. Returns the event as makerble_get_event does. " +
        "Needs permission to edit the event (403 otherwise).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The event id" },
          user_ids: { type: "array", items: { type: "number" } },
          role: { type: "string", enum: ["manager", "worker"] },
          event_role_id: { type: "number", description: "Event Role id for Event Managers and Workers" },
          apply_to: { type: "string", enum: ["this_event", "all_events_in_series"] },
        },
        required: ["id", "user_ids", "role"],
      },
      handler: ({ id, ...p }) => post(`/events/${id}/staff`, p),
    },

    {
      name: "makerble_update_event_staff_role",
      description:
        "Set or clear (event_role_id: null) the Event Role of one of an event's Event Managers or Workers. " +
        "Returns the event as makerble_get_event does. Needs permission to edit the event.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The event id" },
          user_id: { type: "number" },
          event_role_id: { type: ["number", "null"], description: "Event Role id for Event Managers and Workers, or null" },
        },
        required: ["id", "user_id", "event_role_id"],
      },
      handler: ({ id, user_id, ...p }) => patch(`/events/${id}/staff/${user_id}`, p),
    },

    {
      name: "makerble_remove_event_staff",
      description:
        "Remove a user from an event's Event Managers and/or Workers (pass role to remove only one). At least " +
        "one Event Manager must remain (422 otherwise). For a master event, apply_to 'all_events_in_series' " +
        "removes them from the whole series. Returns the event as makerble_get_event does.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "The event id" },
          user_id: { type: "number" },
          role: { type: "string", enum: ["manager", "worker"] },
          apply_to: { type: "string", enum: ["this_event", "all_events_in_series"] },
        },
        required: ["id", "user_id"],
      },
      handler: ({ id, user_id, role, apply_to }) => del(`/events/${id}/staff/${user_id}${query({ role, apply_to })}`),
    },

    {
      name: "makerble_list_event_formats",
      description:
        "List the Event Formats (called Event Category / event_category in the API) of the " +
        "organisations the user is an Organisation Admin of. An Event Format is a template for events " +
        "— e.g. Workshops, Classes, Meetings — managed on an organisation's Manage Event Formats page. " +
        "Only Organisation Admins can see this list: anyone else gets 403 'Only an Organisation Admin " +
        "can list Event Formats.' Pass charity_id to list one organisation's formats. " +
        "Each item returns id, name, is_default (one of the formats every organisation starts with), " +
        "charity_id, events_count (events using it), projects_count (projects it is added to), " +
        "can_delete and delete_blocked_reason (why it can't be deleted yet, or null). Use it to find the " +
        "id for makerble_delete_event_format and to tell the user beforehand whether deletion will work. " +
        "Paginated: returns { page, page_size, page_count, total_count, data }.",
      inputSchema: {
        type: "object",
        properties: {
          charity_id: { type: "number", description: "Only this Organisation's (Charity's) Event Formats" },
          page: { type: "number" },
          per_page: { type: "number", description: "Event Formats per page. Default 10, max 200" },
          last_synced_datetime: { type: "string", description: "Only Event Formats changed after this ISO 8601 time" },
        },
      },
      handler: (p) => get("/event_categories", p),
    },

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
        "Sessions, Workshops) can be deleted under the same rules. Find the id with makerble_list_event_formats, " +
        "which also says whether the Event Format can be deleted and why not, and confirm with the user " +
        "before calling, because this cannot be undone. " +
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
        "sends a signed JSON POST to whenever a Contact (beneficiary), Story or Project is created, " +
        "updated or deleted, a Contact is merged, restored, added to or removed from a Project, or an " +
        "import finishes. Returns each endpoint's url, description, event_types, active " +
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
        "Events: contact.created, contact.updated (includes changed_fields; a changed dropdown answer is " +
        "listed as custom_fields.<dropdown title>), contact.deleted (ids only, no personal data), " +
        "contact.merged (kept_contact_id and merged_contact_ids; no contact.deleted is sent for a merged " +
        "Contact), contact.restored, story.created, story.updated, story.deleted, project.created, " +
        "project.updated, project.deleted, project.contact_added and project.contact_removed (a Contact " +
        "joins or leaves a Project), import.completed (one event per finished spreadsheet import " +
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
              enum: WEBHOOK_EVENTS,
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
          event_types: {
            type: "array",
            description: "The full list of events to send. A webhook made before an event existed doesn't " +
              "receive it until it is added here.",
            items: { type: "string", enum: WEBHOOK_EVENTS },
          },
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

    {
      name: "makerble_search_library",
      description:
        "Search the library of reusable building blocks before making a new one: Surveys, Metrics, Activity " +
        "trackers, Outcomes, Lists of answer choices, Units, Fields, Contact Forms, Case Forms, Impact " +
        "Frameworks, Toolkits, Project Types and Ideas. Look here first and reuse what exists: results recorded " +
        "against a copy of a Metric don't add up with results recorded against the original. Every word of the " +
        "query must match a name or description; Surveys also match on their question wording, Lists on their " +
        "choices and Metrics on their default question (so 'safe at home' finds a Survey asking 'How safe do " +
        "you feel at home?'). source is 'organisation' (default, the user's own organisation's library), " +
        "'public' (the public library shared by every organisation) or 'both'. Returns up to per_page results " +
        "of each type, each with id, type, name, a one-line description and owner ('your organisation', " +
        "'public library' or 'Makerble'); Metrics also have metric_type (scale, value or binary) and choices, " +
        "Lists have choices. Then use makerble_get_library_item to read an item in full, and " +
        "makerble_get_where_used before changing one.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you are looking for, e.g. 'confidence', 'agree disagree'" },
          item_types: {
            type: "array",
            items: { type: "string" },
            description: "Types to search (default every type), any of: survey (Survey, a Story Category), metric (Metric, an Indicator), activity_tracker (Activity or Attendance tracker, a Change), outcome, list (List of answer choices, a Ratio Set), unit, field (Field, a Custom Field), contact_form (Contact Form, a Beneficiary Category), case_form (Case Form, a Custom Field Category), impact_framework (Impact Framework, a Template), toolkit (Toolkit, a Collection), project_type, idea (Idea, a Tip)",
          },
          source: { type: "string", enum: ["organisation", "public", "both"] },
          page: { type: "number" },
          per_page: { type: "number", description: "Results per type (default 10, max 200)" },
        },
        required: ["query"],
      },
      handler: (p) => get("/library/search", p),
    },

    {
      name: "makerble_get_library_item",
      description:
        "Read one library item in full, to reuse it or copy it. Use the type and id from " +
        "makerble_search_library. A Survey returns its questions in order, each with the Metric, List, Field or " +
        "Activity tracker behind it, plus section titles. A Metric returns metric_type, default_question, unit, " +
        "list with choices, success_direction and Outcomes. A List returns its choices in order. A Contact Form " +
        "or Case Form returns its fields in order. An Impact Framework returns its Outcomes, Activity trackers " +
        "and Metrics by stage. A Toolkit returns the Surveys, Forms, Frameworks, Metrics and Ideas in it. " +
        "Returns 404 for anything the user may not see.",
      inputSchema: {
        type: "object",
        properties: {
          item_type: { type: "string", description: "The item's type, one of: survey (Survey, a Story Category), metric (Metric, an Indicator), activity_tracker (Activity or Attendance tracker, a Change), outcome, list (List of answer choices, a Ratio Set), unit, field (Field, a Custom Field), contact_form (Contact Form, a Beneficiary Category), case_form (Case Form, a Custom Field Category), impact_framework (Impact Framework, a Template), toolkit (Toolkit, a Collection), project_type, idea (Idea, a Tip)" },
          id: { type: "number" },
        },
        required: ["item_type", "id"],
      },
      handler: ({ item_type, id }) => get(`/library/${encodeURIComponent(item_type)}/${id}`),
    },

    {
      name: "makerble_get_where_used",
      description:
        "See where a library item is used before changing it. Use the type and id from " +
        "makerble_search_library. Returns projects (id and name of up to 50 projects the user can see that use " +
        "it) and other_projects_count, records_count and last_used_at (survey responses for a Survey; recorded " +
        "values for a Metric, Activity tracker, Outcome or List; Contacts for a Contact Form; Cases for a Case " +
        "Form), contained_in (the Surveys, Contact Forms, Outcomes, Impact Frameworks, Metrics or Toolkits that " +
        "include it) and in_use, true if any of these is above zero. Don't change an item that is in_use unless " +
        "the user created it for this task; make a new one instead. Counts only, no records.",
      inputSchema: {
        type: "object",
        properties: {
          item_type: { type: "string", description: "The item's type, one of: survey (Survey, a Story Category), metric (Metric, an Indicator), activity_tracker (Activity or Attendance tracker, a Change), outcome, list (List of answer choices, a Ratio Set), unit, field (Field, a Custom Field), contact_form (Contact Form, a Beneficiary Category), case_form (Case Form, a Custom Field Category), impact_framework (Impact Framework, a Template), toolkit (Toolkit, a Collection), project_type, idea (Idea, a Tip)" },
          id: { type: "number" },
        },
        required: ["item_type", "id"],
      },
      handler: ({ item_type, id }) => get(`/library/${encodeURIComponent(item_type)}/${id}/usage`),
    },

    // ── Seats (CP-8881) ───────────────────────────────────────────────────────
    {
      name: "makerble_list_seats",
      description:
        "List an Organisation's (Charity's) seats per colleague: the Seats per Colleague page under Our Account › " +
        "Seats in Makerble. Use it to answer 'who has which seat', 'are we over our seat count' or 'who still needs " +
        "a seat'. Each Contract (what the Organisation has bought, e.g. Makerble CRM · Standard) comes with its seats " +
        "bought, assigned and over, per Billing Role (Organiser, Practitioner or Helper) on Role-based Pricing, or one " +
        "line in all on Flat Pricing; default_for_new_colleagues marks the Contract new colleagues are given seats on " +
        "automatically. data is a page of colleagues: their roles in words, lowest_seat_allowed (the Billing Role their " +
        "roles need), status (covered, no_seat, seat_too_low, or no_seat_needed for someone still holding a seat they " +
        "no longer need), and the seat they hold on each Contract. Nobody loses access because of their seat. Only " +
        "the Organisation's admins (Organisation Admins / Charity Editors) can read this; anyone else gets not-found.",
      inputSchema: {
        type: "object",
        properties: {
          organisation_id: { type: "number", description: "The Organisation (Charity) ID" },
          page: { type: "number" },
          per_page: { type: "number", description: "Colleagues per page, up to 200 (default 10)" },
        },
        required: ["organisation_id"],
      },
      handler: ({ organisation_id, ...params }) => get(`/organisations/${organisation_id}/seats`, params),
    },

    {
      name: "makerble_change_seat",
      description:
        "Give a colleague a seat on one of their Organisation's current Contracts, change it, or take it away. Call " +
        "makerble_list_seats first to get the contract_id, the Billing Role ids (from a Contract's lines) and the " +
        "colleague's user_id, and to see whether the Contract uses Role-based or Flat Pricing. On Role-based Pricing " +
        "send billing_role_id (e.g. the Helper seat's id), or billing_role_id: null to take the seat away. On Flat " +
        "Pricing send has_seat: true or false instead, and no billing_role_id. A seat below the colleague's " +
        "lowest_seat_allowed shows as 'Seat too low'; going over the seats bought is allowed and shows as over count, so " +
        "warn the user before doing either. The old seat stays in Seat History. Only the Organisation's admins can " +
        "change seats. Returns the colleague with their seats after the change.",
      inputSchema: {
        type: "object",
        properties: {
          organisation_id: { type: "number", description: "The Organisation (Charity) ID" },
          user_id: { type: "number", description: "The colleague's user id, from makerble_list_seats" },
          contract_id: { type: "number", description: "One of the Organisation's current Contracts, from makerble_list_seats" },
          billing_role_id: {
            type: ["number", "null"],
            description: "Role-based Pricing only: the Billing Role (seat) to give, or null to take the seat away",
          },
          has_seat: { type: "boolean", description: "Flat Pricing only: true gives a seat, false takes it away" },
        },
        required: ["organisation_id", "user_id", "contract_id"],
      },
      handler: ({ organisation_id, user_id, ...body }) => put(`/organisations/${organisation_id}/seats/${user_id}`, body),
    },

    // ── Age bands (CP-8902) ───────────────────────────────────────────────────
    {
      name: "makerble_get_age_bands",
      description:
        "Get the age bands an Organisation (Charity), Album (Portfolio / Bundle) or Project uses to group Contacts " +
        "(Beneficiaries) by age. Ages are worked out from each Contact's Date of Birth as of today. Bands are stored as " +
        "the age each starts at: starts [0, 13, 18, 25] means the bands 0–12, 13–17, 18–24 and 25 and over (returned " +
        "in words as bands). Every Organisation has bands (by default those four); an Album or Project can have its " +
        "own and otherwise uses its Organisation's. source says whose bands they are: 'organisation', 'album' or " +
        "'project'. Anyone in the Organisation (or who can see the Album) can read them.",
      inputSchema: {
        type: "object",
        properties: {
          owner_type: { type: "string", enum: ["organisation", "album", "project"], description: "Whose age bands to get" },
          id: { type: "number", description: "The Organisation's, Album's or Project's ID" },
        },
        required: ["owner_type", "id"],
      },
      handler: ({ owner_type, id }) => get(`/${{ organisation: "organisations", album: "albums", project: "projects" }[owner_type]}/${id}/age_bands`),
    },

    {
      name: "makerble_set_age_bands",
      description:
        "Change the age bands of an Organisation (Charity), Album (Portfolio / Bundle) or Project: the Age bands " +
        "section of its Preferences page. Send starts, the age each band starts at (whole numbers 0 to 120, in any " +
        "order; Makerble sorts them and drops duplicates): e.g. a youth programme might use [10, 14, 18, 22] for " +
        "10–13, 14–17, 18–21 and 22 and over. For an Album or Project, send use_organisation_bands: true instead to " +
        "remove its own bands so it follows its Organisation's. Changing an Organisation's bands changes them for " +
        "every Album and Project without bands of its own. Only the Organisation's admins can change its bands, an " +
        "Album's managers the Album's, and Project Managers or Organisation Admins a Project's. Returns the bands " +
        "after the change, as makerble_get_age_bands does.",
      inputSchema: {
        type: "object",
        properties: {
          owner_type: { type: "string", enum: ["organisation", "album", "project"], description: "Whose age bands to change" },
          id: { type: "number", description: "The Organisation's, Album's or Project's ID" },
          starts: { type: "array", items: { type: "number" }, description: "The age each band starts at" },
          use_organisation_bands: { type: "boolean", description: "Albums and Projects only: true goes back to the Organisation's bands" },
        },
        required: ["owner_type", "id"],
      },
      handler: ({ owner_type, id, ...body }) => put(`/${{ organisation: "organisations", album: "albums", project: "projects" }[owner_type]}/${id}/age_bands`, body),
    },

    {
      name: "makerble_count_contacts_by_age_band",
      description:
        "Count an Organisation's Contacts (Beneficiaries) in each age band: what the Age band card on the " +
        "Demographics tab of Manage Contacts shows. Use it to answer 'how many young people do we work with' or 'what " +
        "is the age breakdown of this project'. Give album_id or project_id to count only that Album's or Project's " +
        "Contacts, by its own age bands if it has them (source says whose bands were used). data lists each band " +
        "with its number of contacts; 'Under X' appears only if someone is younger than the first band, 'Date of " +
        "birth in the future' only if someone's Date of Birth is after today (a data-entry error the user may want " +
        "to fix), and 'No date of birth' only if someone has none. Bands with fewer Contacts than the Organisation's Minimum Results " +
        "Threshold have contacts: null and are added up under 'Below Threshold'; don't try to work out the hidden " +
        "numbers. total_count is every Contact counted. Ages are as of today.",
      inputSchema: {
        type: "object",
        properties: {
          organisation_id: { type: "number", description: "The Organisation (Charity) ID" },
          album_id: { type: "number", description: "Optional: count only this Album's Contacts" },
          project_id: { type: "number", description: "Optional: count only this Project's Contacts" },
        },
        required: ["organisation_id"],
      },
      handler: ({ organisation_id, ...params }) => get(`/organisations/${organisation_id}/age_band_counts`, params),
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
