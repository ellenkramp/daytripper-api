import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "path";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const itineraryFn = new NodejsFunction(this, "ItineraryFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../lambda/itinerary/handler.ts"),
      handler: "handler",
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
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
