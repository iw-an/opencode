import { Context as EffectContext, Layer, Option, Tracer } from "effect"
import {
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context as OtelContext,
} from "@opentelemetry/api"
import { Headers as HttpHeaders, HttpTraceContext } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization } from "effect/unstable/observability"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { runID } from "./shared"

export type { OtelContext }

const endpoint = Flag.OTEL_EXPORTER_OTLP_ENDPOINT

export class CurrentTraceContext extends EffectContext.Service<CurrentTraceContext, OtelContext>()(
  "@opencode/OtlpCurrentTraceContext",
) {}

export type OtlpProtocol = "http/json" | "http/protobuf"
export type OtlpSignal = "logs" | "traces"

const defaultProtocol: OtlpProtocol = "http/json"
let contextManagerRegistered = false

const headers = Flag.OTEL_EXPORTER_OTLP_HEADERS
  ? Flag.OTEL_EXPORTER_OTLP_HEADERS.split(",").reduce(
      (acc, entry) => {
        const [key, ...value] = entry.split("=")
        acc[key] = value.join("=")
        return acc
      },
      {} as Record<string, string>,
    )
  : undefined

function protocolValue(signal: OtlpSignal) {
  return (
    (signal === "logs" ? Flag.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL : Flag.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL) ??
    Flag.OTEL_EXPORTER_OTLP_PROTOCOL
  )
}

export function protocol(signal: OtlpSignal): OtlpProtocol {
  const value = protocolValue(signal)
  if (value === "http/json") return value
  if (value === "http/protobuf") return value
  return defaultProtocol
}

function exporterEnabled(value: string | undefined) {
  return value?.trim().toLowerCase() !== "none"
}

export function logsExporterEnabled() {
  return exporterEnabled(Flag.OTEL_LOGS_EXPORTER)
}

export function tracesExporterEnabled() {
  return exporterEnabled(Flag.OTEL_TRACES_EXPORTER)
}

export function serializationLayer() {
  return protocol("logs") === "http/protobuf" ? OtlpSerialization.layerProtobuf : OtlpSerialization.layerJson
}

export interface TraceContext {
  readonly otelContext: OtelContext
  readonly parentSpan: Tracer.ExternalSpan
}

function otelContextFromExternalSpan(parentSpan: Tracer.ExternalSpan): OtelContext | undefined {
  const spanContext = {
    traceId: parentSpan.traceId,
    spanId: parentSpan.spanId,
    traceFlags: parentSpan.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  }
  return isSpanContextValid(spanContext) ? trace.setSpanContext(ROOT_CONTEXT, spanContext) : undefined
}

export function traceContextFromHeaders(headers: HttpHeaders.Headers): TraceContext | undefined {
  const parentSpan = Option.getOrUndefined(HttpTraceContext.fromHeaders(headers))
  if (!parentSpan) return undefined

  const otelContext = otelContextFromExternalSpan(parentSpan)
  return otelContext ? { otelContext, parentSpan } : undefined
}

export function withTraceContext<T>(otelContext: OtelContext | undefined, fn: () => T): T {
  return otelContext ? context.with(otelContext, fn) : fn()
}

export function withAsyncIterableTraceContext<T>(
  otelContext: OtelContext | undefined,
  iterable: AsyncIterable<T>,
): AsyncIterable<T> {
  if (!otelContext) return iterable
  return {
    [Symbol.asyncIterator]() {
      const iterator = iterable[Symbol.asyncIterator]()
      return {
        next: () => withTraceContext(otelContext, () => iterator.next()),
        return: iterator.return
          ? (value?: unknown) => withTraceContext(otelContext, () => iterator.return!(value))
          : undefined,
        throw: iterator.throw
          ? (error?: unknown) => withTraceContext(otelContext, () => iterator.throw!(error))
          : undefined,
      }
    },
  }
}

function resourceAttributes() {
  const value = process.env.OTEL_RESOURCE_ATTRIBUTES
  if (!value) return {}
  try {
    return Object.fromEntries(
      value.split(",").map((entry) => {
        const index = entry.indexOf("=")
        if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
        return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
      }),
    )
  } catch {
    return {}
  }
}

export function resource(): { serviceName: string; serviceVersion: string; attributes: Record<string, string> } {
  return {
    serviceName: "opencode",
    serviceVersion: InstallationVersion,
    attributes: {
      ...resourceAttributes(),
      "deployment.environment.name": InstallationChannel,
      "opencode.client": Flag.OPENCODE_CLIENT,
      "opencode.run": runID,
      "service.instance.id": runID,
    },
  }
}

export function loggers() {
  if (!endpoint || !logsExporterEnabled()) return []
  return [OtlpLogger.make({ url: `${endpoint}/v1/logs`, resource: resource(), headers })]
}

export async function tracingLayer() {
  if (!endpoint || !tracesExporterEnabled()) return Layer.empty
  const OTLP =
    protocol("traces") === "http/protobuf"
      ? await import("@opentelemetry/exporter-trace-otlp-proto")
      : await import("@opentelemetry/exporter-trace-otlp-http")
  const SdkBase = await import("@opentelemetry/sdk-trace-base")
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks")

  // The Effect Node SDK provides the tracer service, but the AI SDK relies on
  // the OpenTelemetry context API to parent spans across async stream reads.
  if (!contextManagerRegistered) {
    const manager = new AsyncLocalStorageContextManager()
    manager.enable()
    contextManagerRegistered = true
    if (!context.setGlobalContextManager(manager)) manager.disable()
  }

  const NodeSdk = await import("@effect/opentelemetry/NodeSdk")
  const traceUrl = `${endpoint}/v1/traces`
  return NodeSdk.layer(() => {
    return {
      resource: resource(),
      spanProcessor: new SdkBase.BatchSpanProcessor(
        new OTLP.OTLPTraceExporter({
          url: traceUrl,
          headers,
        }),
      ),
    }
  })
}

export * as Otlp from "./otlp"
