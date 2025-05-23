import { z } from "zod";

import { tool } from "../../tool.js";
import { mcpError } from "../../util.js";
import * as client from "../../../dataconnect/dataplaneClient.js";
import { pickService } from "../../../dataconnect/fileUtils.js";
import { graphqlResponseToToolResponse, parseVariables } from "./converter.js";

export const execute_query = tool(
  {
    name: "execute_query",
    description: "Executes a deployed Data Connect query. Cannot write any data.",
    inputSchema: z.object({
      operationName: z.string().describe("The name of the deployed operation you want to execute"),
      serviceId: z
        .string()
        .nullable()
        .describe(
          "The Firebase Data Connect service ID to look for. If there is only one service defined in firebase.json, this can be omitted and that will be used.",
        ),
      connectorId: z
        .string()
        .nullable()
        .describe(
          "The Firebase Data Connect connector ID to look for. If there is only one connector defined in dataconnect.yaml, this can be omitted and that will be used.",
        ),
      variables: z
        .string()
        .optional()
        .describe(
          "A stringified JSON object containing the variables needed to execute the operation. The value MUST be able to be parsed as a JSON object.",
        ),
    }),
    annotations: {
      title: "Executes a deployed Data Connect query.",
      readOnlyHint: true,
    },
    _meta: {
      requiresProject: true,
      requiresAuth: true,
    },
  },
  async (
    { operationName, serviceId, connectorId, variables: unparsedVariables },
    { projectId, config },
  ) => {
    const serviceInfo = await pickService(projectId!, config!, serviceId || undefined);
    if (!connectorId) {
      if (serviceInfo.connectorInfo.length === 0) {
        return mcpError(`Service ${serviceInfo.serviceName} has no connectors`);
      }
      if (serviceInfo.connectorInfo.length > 1) {
        return mcpError(
          `Service ${serviceInfo.serviceName} has more than one connector. Please use the connectorId argument to specifiy which connector this operation is part of.`,
        );
      }
      connectorId = serviceInfo.connectorInfo[0].connectorYaml.connectorId;
    }
    const connectorPath = `${serviceInfo.serviceName}/connectors/${connectorId}`;
    const response = await client.executeGraphQLQuery(
      client.dataconnectDataplaneClient(),
      connectorPath,
      { operationName, variables: parseVariables(unparsedVariables) },
    );
    return graphqlResponseToToolResponse(response.body);
  },
);
