import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { z } from "zod";

// Keep this permissive for local dev; tighten later (e.g., allow only localhost + your Vercel domain).
const CORS_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "OPTIONS,POST",
} as const;

type SpiceLabel = "mild" | "medium" | "hot";

const ItineraryRequestSchema = z.object({
  zipCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, "zipCode must be 5 digits")
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

function toAdventureScore(spiceLabel: SpiceLabel | undefined): number | undefined {
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

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext?.http?.method;

  // Preflight
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

  const zipCode = (req.zipCode ?? "00000").trim();
  const maxDistanceMiles = Number.isFinite(req.maxDistanceMiles)
    ? (req.maxDistanceMiles as number)
    : 30;
  const intents = req.intents ?? [];
  const spiceLabel = req.preferences?.spiceLabel;
  const adventureScore = req.preferences?.adventureScore ?? toAdventureScore(spiceLabel);
  const explain = Boolean(req.explain);

  const stops: ItineraryStop[] = [
    {
      id: "stop-1",
      order: 1,
      kind: "coffee",
      name: "Coffee Stop (Demo)",
      estimatedDurationMinutes: 35,
      location: { lat: 45.5231, lng: -122.6765, address: "Demo address" },
      links: { googleMapsUrl: "https://maps.google.com" },
      tags: ["cozy"],
      rationale: explain ? "Easy starting point to fuel the day." : undefined,
    },
    {
      id: "stop-2",
      order: 2,
      kind: "activity",
      name: "Trail / Park (Demo)",
      estimatedDurationMinutes: 120,
      location: { lat: 45.5152, lng: -122.6784, address: "Demo address" },
      links: { googleMapsUrl: "https://maps.google.com" },
      tags: ["outdoors"],
      rationale: explain
        ? "Matches outdoors intent; mild-to-medium effort (will be tuned by adventure score later)."
        : undefined,
    },
    {
      id: "stop-3",
      order: 3,
      kind: "restaurant",
      name: "Thai Lunch (Demo)",
      estimatedDurationMinutes: 75,
      location: { lat: 45.5051, lng: -122.675, address: "Demo address" },
      links: { googleMapsUrl: "https://maps.google.com" },
      tags: ["food", "thai"],
      rationale: explain
        ? "Placeholder food stop; will later be driven by Places + preferences."
        : undefined,
    },
    {
      id: "stop-4",
      order: 4,
      kind: "activity",
      name: "Waterfront / Scenic (Demo)",
      estimatedDurationMinutes: 90,
      location: { lat: 45.52, lng: -122.67, address: "Demo address" },
      links: { googleMapsUrl: "https://maps.google.com" },
      tags: ["water", "scenic"],
      rationale: explain ? "Ends the day with a relaxing vibe." : undefined,
    },
  ];

  const res: ItineraryResponse = {
    meta: {
      zipCode,
      maxDistanceMiles,
      intents,
      generatedAt: new Date().toISOString(),
      totalStops: stops.length,
      spiceLabel,
      adventureScore,
      explain,
    },
    itinerary: {
      title: `A day trip near ${zipCode}`,
      summary:
        "Demo itinerary to prove the end-to-end flow. Next: real Places + AI composition.",
      totalEstimatedHours: 6.5,
      stops,
    },
  };

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify(res),
  };
}
