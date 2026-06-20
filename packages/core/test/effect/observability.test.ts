import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { context as otelContext, trace, TraceFlags } from "@opentelemetry/api"
import { Effect, Layer, Logger } from "effect"
import { Headers as HttpHeaders } from "effect/unstable/http"
import { OtlpSerialization } from "effect/unstable/observability"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileLogger } from "../../src/observability/logging"
import {
  logsExporterEnabled,
  protocol,
  resource,
  serializationLayer,
  traceContextFromHeaders,
  tracesExporterEnabled,
  withAsyncIterableTraceContext,
} from "../../src/observability/otlp"

const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES
const otelTracesExporter = process.env.OTEL_TRACES_EXPORTER
const otelLogsExporter = process.env.OTEL_LOGS_EXPORTER
const otelProtocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL
const otelTracesProtocol = process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
const otelLogsProtocol = process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL
const opencodeClient = process.env.OPENCODE_CLIENT

afterEach(() => {
  if (otelResourceAttributes === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
  else process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes
  if (otelTracesExporter === undefined) delete process.env.OTEL_TRACES_EXPORTER
  else process.env.OTEL_TRACES_EXPORTER = otelTracesExporter
  if (otelLogsExporter === undefined) delete process.env.OTEL_LOGS_EXPORTER
  else process.env.OTEL_LOGS_EXPORTER = otelLogsExporter
  if (otelProtocol === undefined) delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL
  else process.env.OTEL_EXPORTER_OTLP_PROTOCOL = otelProtocol
  if (otelTracesProtocol === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
  else process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = otelTracesProtocol
  if (otelLogsProtocol === undefined) delete process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL
  else process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = otelLogsProtocol

  if (opencodeClient === undefined) delete process.env.OPENCODE_CLIENT
  else process.env.OPENCODE_CLIENT = opencodeClient
})

describe("protocol", () => {
  test("defaults to json", () => {
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL

    expect(protocol("logs")).toBe("http/json")
    expect(protocol("traces")).toBe("http/json")
    expect(serializationLayer()).toBe(OtlpSerialization.layerJson)
  })

  test("uses general protobuf protocol for logs and traces", () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL

    expect(protocol("logs")).toBe("http/protobuf")
    expect(protocol("traces")).toBe("http/protobuf")
    expect(serializationLayer()).toBe(OtlpSerialization.layerProtobuf)
  })

  test("signal-specific protocol overrides the general protocol", () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json"
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/protobuf"

    expect(protocol("logs")).toBe("http/protobuf")
    expect(protocol("traces")).toBe("http/json")
    expect(serializationLayer()).toBe(OtlpSerialization.layerProtobuf)
  })

  test("unsupported protocol falls back to json", () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc"
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL

    expect(protocol("logs")).toBe("http/json")
  })
})

describe("exporters", () => {
  test("logs and traces exporters default to enabled", () => {
    delete process.env.OTEL_TRACES_EXPORTER
    delete process.env.OTEL_LOGS_EXPORTER

    expect(tracesExporterEnabled()).toBe(true)
    expect(logsExporterEnabled()).toBe(true)
  })

  test("logs and traces exporters can be disabled with standard none value", () => {
    process.env.OTEL_TRACES_EXPORTER = "none"
    process.env.OTEL_LOGS_EXPORTER = "none"

    expect(tracesExporterEnabled()).toBe(false)
    expect(logsExporterEnabled()).toBe(false)
  })
})

describe("trace context", () => {
  test("extracts valid incoming trace context", () => {
    const traceContext = traceContextFromHeaders(
      HttpHeaders.fromInput({
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      }),
    )

    const spanContext = traceContext ? trace.getSpanContext(traceContext.otelContext) : undefined
    expect(spanContext).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    })
    expect(traceContext?.parentSpan).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true,
    })
  })

  test("ignores invalid W3C traceparent headers", () => {
    expect(
      traceContextFromHeaders(HttpHeaders.fromInput({ traceparent: "00-invalid-00f067aa0ba902b7-01" })),
    ).toBeUndefined()
    expect(
      traceContextFromHeaders(
        HttpHeaders.fromInput({ traceparent: "zz-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }),
      ),
    ).toBeUndefined()
  })

  test("keeps W3C context active while consuming async iterables", async () => {
    const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks")
    const manager = new AsyncLocalStorageContextManager().enable()
    otelContext.setGlobalContextManager(manager)

    const parent = traceContextFromHeaders(
      HttpHeaders.fromInput({ traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }),
    )?.otelContext

    try {
      async function* readActiveTrace() {
        yield trace.getSpanContext(otelContext.active())?.traceId
        await Promise.resolve()
        yield trace.getSpanContext(otelContext.active())?.traceId
      }

      const traceIds: Array<string | undefined> = []
      for await (const traceId of withAsyncIterableTraceContext(parent, readActiveTrace())) {
        traceIds.push(traceId)
      }

      expect(traceIds).toEqual(["4bf92f3577b34da6a3ce929d0e0e4736", "4bf92f3577b34da6a3ce929d0e0e4736"])
    } finally {
      otelContext.disable()
      manager.disable()
    }
  })
})

describe("resource", () => {
  test("parses and decodes OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.namespace=anomalyco,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here"

    expect(resource().attributes).toMatchObject({
      "service.namespace": "anomalyco",
      team: "platform,observability",
      label: "hello=world",
      "key/name": "value here",
    })
  })

  test("drops OTEL resource attributes when any entry is invalid", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.namespace=anomalyco,broken"

    expect(resource().attributes["service.namespace"]).toBeUndefined()
    expect(resource().attributes["opencode.client"]).toBeDefined()
  })

  test("keeps built-in attributes when env values conflict", () => {
    process.env.OPENCODE_CLIENT = "cli"
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "opencode.client=web,service.instance.id=override,service.namespace=anomalyco"

    expect(resource().attributes).toMatchObject({
      "opencode.client": "cli",
      "service.namespace": "anomalyco",
    })
    expect(resource().attributes["service.instance.id"]).not.toBe("override")
    expect(resource().attributes["opencode.run"]).toMatch(/^[0-9a-f]{8}$/)
  })
})

test("file logger appends concurrent runs with a run on every line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  const write = (runID: string) =>
    Effect.forEach(
      Array.from({ length: 50 }, (_, index) => index),
      (index) => Effect.logInfo(`entry-${index}`),
    ).pipe(
      Effect.provide(Logger.layer([fileLogger(file, runID)]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
      Effect.scoped,
    )

  await Effect.runPromise(Effect.all([write("run-a"), write("run-b")], { concurrency: "unbounded" }))

  const lines = (await Bun.file(file).text()).trim().split("\n")
  expect(lines).toHaveLength(100)
  expect(lines.filter((line) => line.includes("run=run-a"))).toHaveLength(50)
  expect(lines.filter((line) => line.includes("run=run-b"))).toHaveLength(50)
  expect(lines.every((line) => line.startsWith("timestamp=") && line.includes(" level=INFO "))).toBe(true)
  expect(lines.every((line) => !line.includes(" fiber="))).toBe(true)
  expect(lines.every((line) => !line.startsWith("{"))).toBe(true)
})

test("file logger flattens nested objects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")

  await Effect.logInfo("request complete", {
    request: { method: "GET", timing: { duration: 42 } },
    tags: ["api", "test"],
  }).pipe(
    Effect.annotateLogs({ session: { id: "session-1" } }),
    Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
    Effect.scoped,
    Effect.runPromise,
  )

  const line = (await Bun.file(file).text()).trim()
  expect(line).toContain('message="request complete"')
  expect(line).toContain("request.method=GET")
  expect(line).toContain("request.timing.duration=42")
  expect(line).toContain('tags="[\\\"api\\\",\\\"test\\\"]"')
  expect(line).toContain("session.id=session-1")
  expect(line).not.toContain("request={")
})
