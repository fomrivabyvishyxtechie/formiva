import { randomUUID } from 'node:crypto';

const SENSITIVE_KEY_PATTERN =
  /(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|secret|password|token|session|jwt|bearer)/i;

export function generateRequestId(): string {
  return randomUUID();
}

export function generateCorrelationId(): string {
  return randomUUID();
}

function readHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

export function getOrCreateRequestId(
  headers: Record<string, string | string[] | undefined>,
  fallback = generateRequestId(),
): string {
  const requestId = readHeaderValue(headers, 'x-request-id');
  return requestId && requestId.trim().length > 0 ? requestId : fallback;
}

export function getOrCreateCorrelationId(
  headers: Record<string, string | string[] | undefined>,
  fallback = generateCorrelationId(),
): string {
  const correlationId = readHeaderValue(headers, 'x-correlation-id');
  return correlationId && correlationId.trim().length > 0 ? correlationId : fallback;
}

export function redactSensitiveData<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(/(Authorization\s*:\s*Bearer\s+)[\w\-._~+/]+=*/gi, '$1[REDACTED]')
      .replace(/(password\s*[:=]\s*)([^,\s]+)/gi, '$1[REDACTED]')
      .replace(/(token\s*[:=]\s*)([^,\s]+)/gi, '$1[REDACTED]')
      .replace(/(api[_-]?key\s*[:=]\s*)([^,\s]+)/gi, '$1[REDACTED]') as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item)) as T;
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSensitiveData(nestedValue),
      ]),
    ) as T;
  }

  return value;
}

export function safeSerializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactSensitiveData(error.message),
      ...(typeof (error as Error & { code?: unknown }).code !== 'undefined'
        ? { code: (error as Error & { code?: unknown }).code }
        : {}),
    };
  }

  return { message: redactSensitiveData(String(error)) };
}
