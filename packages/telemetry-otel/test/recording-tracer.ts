import type {
  OtelAttributeValue,
  OtelSpan,
  OtelSpanKindValue,
  OtelSpanStatusCodeValue,
  OtelTracer,
} from "../src/index.js";

export interface RecordedSpan extends OtelSpan {
  readonly name: string;
  readonly kind: OtelSpanKindValue | undefined;
  readonly attributes: Record<string, OtelAttributeValue>;
  readonly exceptions: unknown[];
  readonly events: Array<{ readonly name: string; readonly attributes?: Record<string, OtelAttributeValue> }>;
  status: { readonly code: OtelSpanStatusCodeValue; readonly message?: string } | undefined;
  ended: boolean;
}

export class RecordingTracer implements OtelTracer {
  readonly spans: RecordedSpan[] = [];

  startSpan(
    name: string,
    options?: {
      readonly kind?: OtelSpanKindValue;
      readonly attributes?: Record<string, OtelAttributeValue>;
    },
  ): RecordedSpan {
    const attributes: Record<string, OtelAttributeValue> = { ...(options?.attributes ?? {}) };
    const exceptions: unknown[] = [];
    const span: RecordedSpan = {
      name,
      kind: options?.kind,
      attributes,
      exceptions,
      events: [],
      status: undefined,
      ended: false,
      setAttribute(key, value) {
        attributes[key] = value;
      },
      recordException(exception) {
        exceptions.push(exception);
      },
      setStatus(status) {
        span.status = status;
      },
      end() {
        span.ended = true;
      },
    };
    this.spans.push(span);
    return span;
  }
}
