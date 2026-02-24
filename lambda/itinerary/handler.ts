import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { z } from "zod";

const CORS_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "OPTIONS,POST",
} as const;

type SpiceLabel = "mild" | "medium" | "hot";

const ItineraryRequestSchema = z
  .object({
    origin: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      })
      .optional(),
    zipCode: z
      .string()
      .trim()
      .regex(/^\d{5}$/)
      .optional(),
    maxDistanceMiles: z.number().int().positive().max(100).optional(),
    intents: z.array(z.string()).max(3).optional(),
    preferences: z
      .object({
        spiceLabel: z.enum(["mild", "medium", "hot"]).optional(),
        adventureScore: z.number().min(1).max(10).optional(),
      })
      .optional(),
    explain: z.boolean().optional(),
  })
  .refine((v) => v.origin || v.zipCode, {
    message: "Provide either origin {lat,lng} or zipCode",
    path: ["origin"],
  });

type ItineraryRequest = z.infer<typeof ItineraryRequestSchema>;

type ItineraryStop = {
  id: string;
  order: number;
  kind: "restaurant" | "coffee" | "activity";
  name: string;
  estimatedDurationMinutes: number;
  location: {
    lat: number;
    lng: number;
    address?: string;
  };
  links?: {
    googleMapsUrl?: string;
    websiteUrl?: string;
  };
  tags?: string[];
  rationale?: string;
};

type ItineraryResponse = {
  meta: {
    zipCode: string;
    maxDistanceMiles: number;
    intents: string[];
    generatedAt: string;
    totalStops: number;
    spiceLabel?: SpiceLabel;
    adventureScore?: number;
    explain?: boolean;
  };
  itinerary: {
    title: string;
    summary: string;
    totalEstimatedHours: number;
    stops: ItineraryStop[];
  };
};

function toAdventureScore(
  spiceLabel: SpiceLabel | undefined
): number | undefined {
  if (!spiceLabel) return undefined;
  if (spiceLabel === "mild") return 2;
  if (spiceLabel === "medium") return 6;
  return 9;
}

function parseJsonBody(event: APIGatewayProxyEventV2): ItineraryRequest {
  const rawBody = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body
    : "{}";

  const json = JSON.parse(rawBody);
  return ItineraryRequestSchema.parse(json);
}

function milesToMeters(mi: number): number {
  return Math.round(mi * 1609.344);
}

function totalHoursFromStops(stops: ItineraryStop[]): number {
  const hours =
    stops.reduce((sum, s) => sum + s.estimatedDurationMinutes, 0) / 60;
  return Math.round(hours * 10) / 10;
}

function googleMapsPlaceUrl(placeId: string): string {
  return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(
    placeId
  )}`;
}

// --- Google helpers (Places v1 + Geocoding) ---

type LatLng = { lat: number; lng: number };

async function geocodeZipToLatLng(
  zipCode: string,
  apiKey: string
): Promise<LatLng> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    zipCode
  )}&key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Geocoding failed (${resp.status})`);
  const data = (await resp.json()) as any;

  const loc = data?.results?.[0]?.geometry?.location;
  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
    throw new Error("Could not resolve zipCode to coordinates");
  }
  return { lat: loc.lat, lng: loc.lng };
}

type PlacesV1SearchResult = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
};

type PlaceAddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
  languageCode?: string;
};

type PlaceDetailsV1Result = {
  id?: string;
  addressComponents?: PlaceAddressComponent[];
};

async function getPlaceDetailsV1(args: {
  apiKey: string;
  placeId: string;
  fields: string;
}): Promise<PlaceDetailsV1Result> {
  const { apiKey, placeId, fields } = args;

  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(
    placeId
  )}?fields=${encodeURIComponent(fields)}&key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url, { method: "GET" });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Places details failed (${resp.status}): ${text}`);
  }

  return (await resp.json()) as PlaceDetailsV1Result;
}

function extractNeighborhoodLikeLabel(
  details: PlaceDetailsV1Result
): string | undefined {
  const comps = details.addressComponents ?? [];
  const preferredTypes = [
    "neighborhood",
    "sublocality",
    "locality",
    "administrative_area_level_2",
  ];

  for (const t of preferredTypes) {
    const comp = comps.find((c) => (c.types ?? []).includes(t));
    if (comp?.longText) return comp.longText;
    if (comp?.shortText) return comp.shortText;
  }

  return undefined;
}

async function nearbySearchPlacesV1(args: {
  apiKey: string;
  origin: LatLng;
  radiusMeters: number;
  includedTypes?: string[];
  textQuery?: string;
  maxResults?: number;
}): Promise<PlacesV1SearchResult[]> {
  const { apiKey, origin, radiusMeters, includedTypes, maxResults = 10 } = args;

  const body: any = {
    locationRestriction: {
      circle: {
        center: { latitude: origin.lat, longitude: origin.lng },
        radius: radiusMeters,
      },
    },
    maxResultCount: maxResults,
  };

  if (includedTypes?.length) body.includedTypes = includedTypes;

  const resp = await fetch(
    "https://places.googleapis.com/v1/places:searchNearby",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": apiKey,
        // todo: expand later for details
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.websiteUri,places.rating,places.userRatingCount,places.location,places.types",
      },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Places nearbySearch failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as { places?: PlacesV1SearchResult[] };
  return data.places ?? [];
}

function pickTopPlaces(
  places: PlacesV1SearchResult[],
  count: number
): PlacesV1SearchResult[] {
  // Deterministic “good enough” ranking:
  // prioritize rating, then rating count
  return [...places]
    .filter(
      (p) =>
        p.id &&
        p.displayName?.text &&
        p.location?.latitude &&
        p.location?.longitude
    )
    .sort((a, b) => {
      const ar = a.rating ?? 0;
      const br = b.rating ?? 0;
      if (br !== ar) return br - ar;
      const ac = a.userRatingCount ?? 0;
      const bc = b.userRatingCount ?? 0;
      return bc - ac;
    })
    .slice(0, count);
}

function placeToStop(
  place: PlacesV1SearchResult,
  kind: ItineraryStop["kind"],
  order: number,
  explain: boolean,
  rationale?: string
): ItineraryStop {
  const lat = place.location!.latitude!;
  const lng = place.location!.longitude!;
  const id = place.id!;

  return {
    id,
    order,
    kind,
    name: place.displayName?.text ?? "Unknown",
    estimatedDurationMinutes:
      kind === "coffee" ? 35 : kind === "restaurant" ? 75 : 120,
    location: {
      lat,
      lng,
      address: place.formattedAddress,
    },
    links: {
      googleMapsUrl: googleMapsPlaceUrl(id),
      websiteUrl: place.websiteUri,
    },
    tags: place.types,
    rationale: explain ? rationale : undefined,
  };
}

// --- handler ---

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext?.http?.method;

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  let req: ItineraryRequest;
  try {
    req = parseJsonBody(event);
  } catch (err) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Invalid request",
        details:
          err instanceof z.ZodError
            ? err.issues.map((i) => ({ path: i.path, message: i.message }))
            : undefined,
      }),
    };
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Server misconfigured: missing GOOGLE_MAPS_API_KEY",
      }),
    };
  }

  const zipCode = (req.zipCode ?? "00000").trim();
  const maxDistanceMiles = Number.isFinite(req.maxDistanceMiles)
    ? (req.maxDistanceMiles as number)
    : 30;
  const radiusMeters = milesToMeters(maxDistanceMiles);

  const intents = req.intents ?? [];
  const spiceLabel = req.preferences?.spiceLabel;
  const adventureScore =
    req.preferences?.adventureScore ?? toAdventureScore(spiceLabel);
  const explain = Boolean(req.explain);

  // 1) Resolve origin
  const origin =
    req.origin ??
    (req.zipCode ? await geocodeZipToLatLng(req.zipCode, apiKey) : undefined);

  if (!origin) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Provide either origin {lat,lng} or zipCode",
      }),
    };
  }

  // 2) Fetch candidates (basic buckets)
  const [coffee, restaurants, parks, museums] = await Promise.all([
    nearbySearchPlacesV1({
      apiKey,
      origin,
      radiusMeters,
      includedTypes: ["cafe"],
      maxResults: 12,
    }),
    nearbySearchPlacesV1({
      apiKey,
      origin,
      radiusMeters,
      includedTypes: ["restaurant"],
      maxResults: 12,
    }),
    nearbySearchPlacesV1({
      apiKey,
      origin,
      radiusMeters,
      includedTypes: ["park"],
      maxResults: 12,
    }),
    nearbySearchPlacesV1({
      apiKey,
      origin,
      radiusMeters,
      includedTypes: ["museum"],
      maxResults: 12,
    }),
  ]);

  // 3) Choose stops (deterministic for now)
  const pickedCoffee = pickTopPlaces(coffee, 1);
  const pickedLunch = pickTopPlaces(restaurants, 1);

  const pickedActivities = [
    ...pickTopPlaces(parks, 1),
    ...pickTopPlaces(museums, 1),
  ].slice(0, 2);

  const chosen: ItineraryStop[] = [];
  let order = 1;

  for (const p of pickedCoffee) {
    chosen.push(
      placeToStop(
        p,
        "coffee",
        order++,
        explain,
        "Highly-rated cafe nearby to start the day."
      )
    );
  }
  for (const p of pickedActivities) {
    chosen.push(
      placeToStop(
        p,
        "activity",
        order++,
        explain,
        adventureScore && adventureScore > 7
          ? "A higher-energy activity choice based on your adventure score."
          : "A solid nearby activity pick based on ratings and proximity."
      )
    );
  }
  for (const p of pickedLunch) {
    chosen.push(
      placeToStop(
        p,
        "restaurant",
        order++,
        explain,
        spiceLabel
          ? `A lunch spot to match your spice preference (${spiceLabel}).`
          : "A well-rated lunch option nearby."
      )
    );
  }

  if (explain) {
    try {
      const detailsById = new Map<string, PlaceDetailsV1Result>();

      await Promise.all(
        chosen.map(async (stop) => {
          if (!stop.id) return;
          const details = await getPlaceDetailsV1({
            apiKey,
            placeId: stop.id,
            fields: "addressComponents",
          });
          detailsById.set(stop.id, details);
        })
      );

      for (const stop of chosen) {
        const details = detailsById.get(stop.id);
        const neighborhood = details
          ? extractNeighborhoodLikeLabel(details)
          : undefined;
        if (neighborhood) {
          stop.rationale = stop.rationale
            ? `${stop.rationale} (Area: ${neighborhood})`
            : `Picked because it's in/near ${neighborhood}.`;
        }
      }
    } catch(error) {
      console.log(error)
    }
  }

  if (chosen.length === 0) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "No places found",
        details: { maxDistanceMiles, origin },
      }),
    };
  }

  const res: ItineraryResponse = {
    meta: {
      zipCode,
      maxDistanceMiles,
      intents,
      generatedAt: new Date().toISOString(),
      totalStops: chosen.length,
      spiceLabel,
      adventureScore,
      explain,
    },
    itinerary: {
      title: `A day trip near ${req.zipCode ?? "your location"}`,
      summary:
        "Built from real Google Places results. Next step: smarter ranking + AI composition.",
      totalEstimatedHours: totalHoursFromStops(chosen),
      stops: chosen,
    },
  };

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify(res),
  };
}
