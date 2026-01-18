import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const itineraryFn = new lambda.Function(this, "ItineraryFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  // NOTE: Keep CORS headers here so you can call this from a local Next.js app.
  // For production, prefer API Gateway CORS + stricter origins.
  const headers = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'OPTIONS,POST',
  };

  if (event?.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const body = {
    meta: {
      zipCode: '00000',
      maxDistanceMiles: 30,
      intents: ['food', 'outdoors', 'water'],
      generatedAt: new Date().toISOString(),
      totalStops: 4,
      spiceLabel: 'medium',
      adventureScore: 6,
    },
    itinerary: {
      title: 'A day trip that hits food + outdoors + water',
      summary: 'A quick demo itinerary to prove the full stack is wired up.',
      totalEstimatedHours: 6.5,
      stops: [
        {
          id: 'stop-1',
          order: 1,
          kind: 'coffee',
          name: 'Coffee Stop (Demo)',
          estimatedDurationMinutes: 35,
          location: { lat: 45.5231, lng: -122.6765, address: 'Demo address' },
          links: { googleMapsUrl: 'https://maps.google.com' },
          tags: ['cozy'],
          rationale: 'Easy starting point to fuel the day.',
        },
        {
          id: 'stop-2',
          order: 2,
          kind: 'activity',
          name: 'Trail / Park (Demo)',
          estimatedDurationMinutes: 120,
          location: { lat: 45.5152, lng: -122.6784, address: 'Demo address' },
          links: { googleMapsUrl: 'https://maps.google.com' },
          tags: ['outdoors'],
          rationale: 'Matches outdoors intent; mild-to-medium effort.',
        },
        {
          id: 'stop-3',
          order: 3,
          kind: 'restaurant',
          name: 'Thai Lunch (Demo)',
          estimatedDurationMinutes: 75,
          location: { lat: 45.5051, lng: -122.6750, address: 'Demo address' },
          links: { googleMapsUrl: 'https://maps.google.com' },
          tags: ['food', 'thai'],
          rationale: 'Food stop that can later be driven by Places + your preferences.',
        },
        {
          id: 'stop-4',
          order: 4,
          kind: 'activity',
          name: 'Waterfront / Scenic (Demo)',
          estimatedDurationMinutes: 90,
          location: { lat: 45.5200, lng: -122.6700, address: 'Demo address' },
          links: { googleMapsUrl: 'https://maps.google.com' },
          tags: ['water', 'scenic'],
          rationale: 'Ends the day with a relaxing water/scenic vibe.',
        },
      ],
    },
  };

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(body),
  };
};
      `),
    });

    const httpApi = new apigwv2.HttpApi(this, "DaytripperHttpApi", {
      apiName: "daytripper-api",
      corsPreflight: {
        // TODO: Keep this permissive for local dev; tighten later.
        allowHeaders: ["content-type"],
        allowMethods: [
          apigwv2.CorsHttpMethod.OPTIONS,
          apigwv2.CorsHttpMethod.POST,
        ],
        allowOrigins: ["*"],
      },
    });

    httpApi.addRoutes({
      path: "/itinerary",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        "ItineraryIntegration",
        itineraryFn
      ),
    });

    new cdk.CfnOutput(this, "HttpApiUrl", {
      value: httpApi.apiEndpoint,
    });
  }
}
