import { AppError, ErrorCode } from "@jarvis/shared";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { unwrap, unwrapMaybe } from "../db.js";
import type { Place, PlacesClient } from "../integrations/google-places.js";
import { PLACE_ID, PlacesError } from "../integrations/google-places.js";
import { normalizePhone } from "../lib/phone.js";
import { parseBody, uuidParam } from "../validation.js";

export interface ProspectSettings {
  /** null when GOOGLE_MAPS_API_KEY is not set: the feature reports "not connected". */
  places: PlacesClient | null;
  /** Google Maps calls (searches + additions) per user per UTC day. */
  dailyLimit: number;
}

const searchSchema = z
  .object({
    what: z.string().trim().min(2).max(100),
    where: z.string().trim().max(100).optional(),
    pageToken: z.string().max(2000).optional(),
  })
  .strict();

const addSchema = z
  .object({
    placeId: z.string().regex(PLACE_ID, "invalid place id"),
    createDeal: z.boolean().default(false),
    dealTitle: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** Business workspace + member (or higher) access, checked under RLS. */
async function requireBusinessMember(c: Context<AppEnv>, workspaceId: string) {
  const db = c.get("db");
  const [workspace, membership] = await Promise.all([
    db.from("workspaces").select("type").eq("id", workspaceId).maybeSingle().then(unwrapMaybe),
    db
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", c.get("user").id)
      .maybeSingle()
      .then(unwrapMaybe),
  ]);
  if (!workspace || !membership) throw new AppError(ErrorCode.NotFound, "Workspace not found.");
  if (workspace.type !== "business") {
    throw new AppError(ErrorCode.BadRequest, "Prospecting is only available in Business mode.");
  }
  if (membership.role === "viewer") {
    throw new AppError(ErrorCode.Forbidden, "You need member access to find prospects.");
  }
}

/** Shared daily cap on billable Google calls. */
async function consumeQuota(c: Context<AppEnv>, limit: number) {
  const { data, error } = await c.get("db").rpc("consume_rate_limit", {
    p_bucket: "google_places",
    p_limit: limit,
    p_window_seconds: 86_400,
  });
  if (error) throw new AppError(ErrorCode.Internal, "Could not check the search limit.");
  const result = data as { allowed: boolean; retry_after_seconds: number };
  if (!result.allowed) {
    c.header("Retry-After", String(result.retry_after_seconds));
    throw new AppError(
      ErrorCode.RateLimited,
      `Daily Google Maps limit reached (${limit}). It resets at 00:00 UTC.`,
    );
  }
}

function requirePlaces(settings: ProspectSettings): PlacesClient {
  if (!settings.places) {
    throw new AppError(
      ErrorCode.Unavailable,
      "Google Maps is not connected. An owner needs to add a Google Maps API key.",
    );
  }
  return settings.places;
}

function placesFailure(err: unknown): never {
  if (err instanceof PlacesError) {
    console.error(
      JSON.stringify({ level: "error", msg: "google places failed", status: err.status }),
    );
    throw new AppError(
      ErrorCode.Unavailable,
      err.status === 403 || err.status === 401
        ? "Google Maps rejected the API key. Check that it is valid and has Places API (New) enabled."
        : "Google Maps is not responding right now. Please try again.",
    );
  }
  throw err;
}

export function prospectRoutes(settings: ProspectSettings) {
  return (
    new Hono<AppEnv>()
      .get("/workspaces/:workspaceId/prospects/status", (c) => {
        uuidParam(c, "workspaceId");
        return c.json({ configured: settings.places !== null, dailyLimit: settings.dailyLimit });
      })

      /** Live search. Results are shown, not stored; matches to existing clients are flagged. */
      .post("/workspaces/:workspaceId/prospects/search", async (c) => {
        const workspaceId = uuidParam(c, "workspaceId");
        const body = await parseBody(c, searchSchema);
        const places = requirePlaces(settings);
        await requireBusinessMember(c, workspaceId);
        await consumeQuota(c, settings.dailyLimit);

        const query = body.where ? `${body.what} in ${body.where}` : body.what;
        const result = await places.search(query, body.pageToken).catch(placesFailure);

        const ids = result.places.map((p) => p.placeId);
        const phones = result.places
          .map((p) => (p.phone ? normalizePhone(p.phone) : null))
          .filter((p): p is string => !!p);
        const db = c.get("db");
        const [byPlace, byPhone] = await Promise.all([
          ids.length
            ? db
                .from("companies")
                .select("id, attributes")
                .eq("workspace_id", workspaceId)
                .in("attributes->>google_place_id", ids)
                .then(unwrap)
            : [],
          phones.length
            ? db
                .from("companies")
                .select("id, phone_e164")
                .eq("workspace_id", workspaceId)
                .in("phone_e164", phones)
                .then(unwrap)
            : [],
        ]);
        const placeToCompany = new Map(
          byPlace.map((r) => [
            (r.attributes as { google_place_id?: string }).google_place_id,
            r.id,
          ]),
        );
        const phoneToCompany = new Map(byPhone.map((r) => [r.phone_e164, r.id]));

        return c.json({
          query,
          nextPageToken: result.nextPageToken,
          results: result.places.map((p) => {
            const phone = p.phone ? normalizePhone(p.phone) : null;
            return {
              ...p,
              phoneE164: phone,
              existingClientId:
                placeToCompany.get(p.placeId) ??
                (phone ? (phoneToCompany.get(phone) ?? null) : null),
            };
          }),
        });
      })

      /**
       * Add a place as a client (and optionally a lead deal). Details are fetched
       * from Google on the server, so the browser cannot inject other data.
       */
      .post("/workspaces/:workspaceId/prospects/add", async (c) => {
        const workspaceId = uuidParam(c, "workspaceId");
        const body = await parseBody(c, addSchema);
        const places = requirePlaces(settings);
        await requireBusinessMember(c, workspaceId);
        await consumeQuota(c, settings.dailyLimit);

        const place: Place | null = await places.details(body.placeId).catch(placesFailure);
        if (!place)
          throw new AppError(ErrorCode.NotFound, "That place was not found on Google Maps.");

        const db = c.get("db");
        const phone = place.phone ? normalizePhone(place.phone) : null;
        const row = {
          workspace_id: workspaceId,
          name: place.name.slice(0, 200),
          phone_e164: phone,
          website: place.website && place.website.length <= 500 ? place.website : null,
          address: place.address?.slice(0, 500) ?? null,
          source: "google_maps",
          attributes: {
            google_place_id: place.placeId,
            ...(place.googleMapsUri ? { google_maps_uri: place.googleMapsUri } : {}),
            ...(place.types.length ? { google_types: place.types.slice(0, 10) } : {}),
          },
        };
        const inserted = await db.from("companies").insert(row).select("id, name").single();
        if (inserted.error?.code === "23505") {
          throw new AppError(ErrorCode.Conflict, "This business is already one of your clients.");
        }
        const company = unwrap(inserted) as { id: string; name: string };

        let dealId: string | null = null;
        if (body.createDeal) {
          const deal = await db
            .from("deals")
            .insert({
              workspace_id: workspaceId,
              company_id: company.id,
              title: body.dealTitle ?? `New lead: ${company.name}`.slice(0, 200),
              stage: "lead",
            })
            .select("id")
            .single()
            .then(unwrap);
          dealId = (deal as { id: string }).id;
        }
        return c.json({ company, dealId }, 201);
      })
  );
}
