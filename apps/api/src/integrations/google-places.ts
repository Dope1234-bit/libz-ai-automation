import { z } from "zod";

/**
 * Minimal client for Google Places API (New): text search and place details.
 * Server-side only — the key never reaches the browser. Only the fields we
 * show are requested (the field mask also decides what Google bills).
 */

export interface Place {
  placeId: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  googleMapsUri: string | null;
  rating: number | null;
  ratingCount: number | null;
  types: string[];
  businessStatus: string | null;
}

export interface PlacesSearchResult {
  places: Place[];
  nextPageToken: string | null;
}

export interface PlacesClient {
  search(query: string, pageToken?: string): Promise<PlacesSearchResult>;
  details(placeId: string): Promise<Place | null>;
}

export class PlacesError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "PlacesError";
  }
}

const FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "internationalPhoneNumber",
  "nationalPhoneNumber",
  "websiteUri",
  "googleMapsUri",
  "rating",
  "userRatingCount",
  "types",
  "businessStatus",
];

const placeSchema = z
  .object({
    id: z.string(),
    displayName: z.object({ text: z.string() }).loose().optional(),
    formattedAddress: z.string().optional(),
    internationalPhoneNumber: z.string().optional(),
    nationalPhoneNumber: z.string().optional(),
    websiteUri: z.string().optional(),
    googleMapsUri: z.string().optional(),
    rating: z.number().optional(),
    userRatingCount: z.number().int().optional(),
    types: z.array(z.string()).optional(),
    businessStatus: z.string().optional(),
  })
  .loose();

function toPlace(raw: z.infer<typeof placeSchema>): Place {
  return {
    placeId: raw.id,
    name: raw.displayName?.text ?? "Unnamed place",
    address: raw.formattedAddress ?? null,
    phone: raw.internationalPhoneNumber ?? raw.nationalPhoneNumber ?? null,
    website: raw.websiteUri && /^https?:\/\//i.test(raw.websiteUri) ? raw.websiteUri : null,
    googleMapsUri: raw.googleMapsUri ?? null,
    rating: raw.rating ?? null,
    ratingCount: raw.userRatingCount ?? null,
    types: raw.types ?? [],
    businessStatus: raw.businessStatus ?? null,
  };
}

export const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;

export function createGooglePlacesClient(options: {
  apiKey: string;
  regionCode?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): PlacesClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const headers = (fields: string) => ({
    "Content-Type": "application/json",
    "X-Goog-Api-Key": options.apiKey,
    "X-Goog-FieldMask": fields,
  });

  async function call(url: string, init: RequestInit) {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new PlacesError(`Google Maps request failed: ${String(err)}`, null);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      // Google's error text can echo request details; keep only the status.
      throw new PlacesError(`Google Maps returned HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as unknown;
  }

  return {
    async search(query, pageToken) {
      const data = await call("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: headers([...FIELDS.map((f) => `places.${f}`), "nextPageToken"].join(",")),
        body: JSON.stringify({
          textQuery: query,
          regionCode: options.regionCode ?? "ZW",
          languageCode: "en",
          pageSize: 20,
          ...(pageToken ? { pageToken } : {}),
        }),
      });
      const parsed = z
        .object({ places: z.array(placeSchema).default([]), nextPageToken: z.string().optional() })
        .safeParse(data ?? {});
      if (!parsed.success) throw new PlacesError("Unexpected response from Google Maps", null);
      return {
        places: parsed.data.places.map(toPlace),
        nextPageToken: parsed.data.nextPageToken ?? null,
      };
    },
    async details(placeId) {
      if (!PLACE_ID.test(placeId)) return null;
      const data = await call(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
        { method: "GET", headers: headers(FIELDS.join(",")) },
      );
      if (data === null) return null;
      const parsed = placeSchema.safeParse(data);
      if (!parsed.success) throw new PlacesError("Unexpected response from Google Maps", null);
      return toPlace(parsed.data);
    },
  };
}
