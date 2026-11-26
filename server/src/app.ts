import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { Pool } from "pg";
import { identifyRequest, registerIdentity } from "./auth.js";
import { registerCorpusRoutes } from "./corpus/routes.js";
import { registerDraftRoutes } from "./drafts/routes.js";
import { AppError } from "./errors.js";
import { registerPullBackRoutes } from "./pullback/routes.js";
import { registerSeriesRoutes } from "./series/routes.js";
import { registerVersionRoutes } from "./versions/routes.js";

export type Deps = { pool: Pool };

function sendError(reply: FastifyReply, { status, code, message, details }: AppError) {
  return reply.code(status).send({ error: { code, message, details } });
}

function handleError(error: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AppError) return sendError(reply, error);

  if (error.validation !== undefined) {
    const errors = error.validation.map(({ instancePath, message }) => ({
      path: instancePath,
      message: message ?? "",
    }));
    return sendError(reply, new AppError(400, "validation_failed", "Request validation failed", { errors }));
  }
  if (error.statusCode === 413) {
    return sendError(reply, new AppError(413, "payload_too_large", "Request body too large"));
  }
  if (error.statusCode === 415) {
    return sendError(reply, new AppError(415, "unsupported_media_type", "Content-Type must be application/json"));
  }
  if (error.statusCode === 400) {
    return sendError(reply, new AppError(400, "validation_failed", "Request could not be parsed"));
  }

  request.log.error(error);
  return sendError(reply, new AppError(500, "internal", "Internal error"));
}

function routeNotFound(_request: FastifyRequest, reply: FastifyReply) {
  return sendError(reply, new AppError(404, "not_found", "Route not found"));
}

export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1048576,
    exposeHeadRoutes: false,
    // Let the Series route return its own 404 for identifiers over 64 characters.
    routerOptions: { maxParamLength: Number.MAX_SAFE_INTEGER },
    ajv: {
      customOptions: { removeAdditional: false, coerceTypes: false, allErrors: true },
    },
    logger: process.env.NODE_ENV === "test" ? false : {
      level: "info",
      serializers: {
        req: (request) => ({ method: request.method, url: request.url }),
        res: (reply) => ({ statusCode: reply.statusCode }),
      },
    },
    frameworkErrors(error, request, reply) {
      // Routing errors occur before the regular request hooks.
      try {
        identifyRequest(request);
      } catch (error) {
        return handleError(error as AppError, request, reply);
      }
      return handleError(error, request, reply);
    },
  });
  app.removeContentTypeParser("text/plain");

  app.setErrorHandler(handleError);
  app.setNotFoundHandler(routeNotFound);
  registerIdentity(app);
  app.addHook("onRequest", async (request, reply) => {
    if (request.is404) return routeNotFound(request, reply);
  });

  app.get("/health", async () => ({ status: "ok" }));
  registerSeriesRoutes(app, deps);
  registerCorpusRoutes(app, deps);
  registerDraftRoutes(app, deps);
  registerVersionRoutes(app, deps);
  registerPullBackRoutes(app, deps);
  return app;
}
