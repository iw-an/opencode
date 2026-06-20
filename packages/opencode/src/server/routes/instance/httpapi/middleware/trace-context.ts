import { Otlp } from "@opencode-ai/core/observability/otlp"
import { Effect, Tracer } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"

export const traceContextLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const traceContext = Otlp.traceContextFromHeaders(request.headers)
    if (!traceContext) return yield* effect

    const withContext = Effect.provideService(effect, Otlp.CurrentTraceContext, traceContext.otelContext)
    return yield* Effect.provideService(withContext, Tracer.ParentSpan, traceContext.parentSpan)
  }),
).layer
