import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Otlp } from "@opencode-ai/core/observability/otlp"
import { trace } from "@opentelemetry/api"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Tracer } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpTraceContext,
} from "effect/unstable/http"
import { traceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/trace-context"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))

describe("HttpApi trace context middleware", () => {
  it.live("provides incoming W3C trace context to request effects", () =>
    Effect.gen(function* () {
      yield* HttpRouter.add(
        "GET",
        "/probe",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const headerSpan = Option.getOrUndefined(HttpTraceContext.fromHeaders(request.headers))
          const otelContext = Option.getOrUndefined(yield* Effect.serviceOption(Otlp.CurrentTraceContext))
          const spanContext = otelContext ? trace.getSpanContext(otelContext) : undefined
          const parentSpan = Option.getOrUndefined(yield* Effect.serviceOption(Tracer.ParentSpan))

          return HttpServerResponse.jsonUnsafe({
            headerTraceId: headerSpan?.traceId,
            headerSpanId: headerSpan?.spanId,
            traceId: spanContext?.traceId,
            spanId: spanContext?.spanId,
            parentTraceId: parentSpan?._tag === "ExternalSpan" ? parentSpan.traceId : undefined,
            parentSpanId: parentSpan?._tag === "ExternalSpan" ? parentSpan.spanId : undefined,
          })
        }),
      ).pipe(Layer.provide(traceContextLayer), HttpRouter.serve, Layer.build)

      const response = yield* HttpClientRequest.get("/probe").pipe(
        HttpClientRequest.setHeader(
          "traceparent",
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        ),
        HttpClient.execute,
      )
      const body = (yield* response.json) as Record<string, string | undefined>

      expect(response.status).toBe(200)
      expect(body.headerTraceId).toBeDefined()
      expect(body.traceId).toBe(body.headerTraceId)
      expect(body.spanId).toBe(body.headerSpanId)
      expect(body.parentTraceId).toBe(body.headerTraceId)
      expect(body.parentSpanId).toBe(body.headerSpanId)
    }),
  )
})
