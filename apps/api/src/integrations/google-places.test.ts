import { describe, expect, it, vi } from "vitest";
import { createGooglePlacesClient, PlacesError } from "./google-places.js";

const raw = {
  id: "ChIJabcdefghijk",
  displayName: { text: "Moyo Hardware" },
  formattedAddress: "12 Speke Ave, Harare, Zimbabwe",
  internationalPhoneNumber: "+263 77 212 3456",
  websiteUri: "https://moyo.example",
  googleMapsUri: "https://maps.google.com/?cid=1",
  rating: 4.4,
  userRatingCount: 31,
  types: ["hardware_store"],
  businessStatus: "OPERATIONAL",
};

describe("Google Places client", () => {
  it("searches with a field mask and region, and maps results", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        places: [raw, { id: "ChIJzzzzzzzzzz", websiteUri: "javascript:x" }],
        nextPageToken: "next",
      }),
    );
    const client = createGooglePlacesClient({
      apiKey: "k-123456789",
      fetch: fetchMock as typeof fetch,
    });
    const result = await client.search("hardware store in Harare");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    const headers = init!.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("k-123456789");
    expect(headers["X-Goog-FieldMask"]).toContain("places.internationalPhoneNumber");
    expect(JSON.parse(String(init!.body))).toMatchObject({
      textQuery: "hardware store in Harare",
      regionCode: "ZW",
    });

    expect(result.nextPageToken).toBe("next");
    expect(result.places[0]).toEqual({
      placeId: "ChIJabcdefghijk",
      name: "Moyo Hardware",
      address: "12 Speke Ave, Harare, Zimbabwe",
      phone: "+263 77 212 3456",
      website: "https://moyo.example",
      googleMapsUri: "https://maps.google.com/?cid=1",
      rating: 4.4,
      ratingCount: 31,
      types: ["hardware_store"],
      businessStatus: "OPERATIONAL",
    });
    expect(result.places[1]).toMatchObject({ name: "Unnamed place", website: null });
  });

  it("fetches details, returns null for unknown or malformed ids", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("ChIJabcdefghijk")
        ? Response.json(raw)
        : new Response("", { status: 404 }),
    );
    const client = createGooglePlacesClient({
      apiKey: "k-123456789",
      fetch: fetchMock as typeof fetch,
    });
    expect((await client.details("ChIJabcdefghijk"))?.name).toBe("Moyo Hardware");
    expect(await client.details("ChIJmissingxxxx")).toBeNull();
    expect(await client.details("../../etc")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports HTTP errors without echoing response bodies", async () => {
    const client = createGooglePlacesClient({
      apiKey: "k-123456789",
      fetch: (async () => new Response("secret detail", { status: 403 })) as typeof fetch,
    });
    const err = await client.search("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlacesError);
    expect((err as PlacesError).status).toBe(403);
    expect((err as PlacesError).message).not.toContain("secret");
  });
});
