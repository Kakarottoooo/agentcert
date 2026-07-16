export type VendorSandboxHttpMethod = "GET";

export interface VendorSandboxResourceRule {
  id: string;
  method: VendorSandboxHttpMethod;
  pathPattern: RegExp;
}

export interface VendorSandboxEgressPolicy {
  vendor: string;
  allowedOrigin: string;
  resources: readonly VendorSandboxResourceRule[];
  timeoutMs: number;
  maxRequestsPerMinute: number;
}

export type VendorSandboxAuditOutcome =
  | "allowed"
  | "denied"
  | "rate_limited"
  | "timeout"
  | "http_error"
  | "failed";

export interface VendorSandboxRequestAudit {
  requestId: string;
  timestamp: string;
  vendor: string;
  resource: string;
  method: VendorSandboxHttpMethod;
  origin: string;
  outcome: VendorSandboxAuditOutcome;
  durationMs: number;
  status?: number;
  errorCode?: VendorSandboxEgressErrorCode;
}

export type VendorSandboxEgressErrorCode =
  | "ORIGIN_DENIED"
  | "METHOD_DENIED"
  | "RESOURCE_DENIED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "REQUEST_FAILED";

export class VendorSandboxEgressError extends Error {
  constructor(
    public readonly code: VendorSandboxEgressErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "VendorSandboxEgressError";
  }
}

export interface VendorSandboxEgressRequest {
  resource: string;
  method: VendorSandboxHttpMethod;
  path: string;
  headers?: HeadersInit;
}

export interface BoundedVendorSandboxEgress {
  requestJson(request: VendorSandboxEgressRequest): Promise<unknown>;
  getAuditLog(): VendorSandboxRequestAudit[];
}

export interface BoundedVendorSandboxEgressOptions {
  policy: VendorSandboxEgressPolicy;
  fetch?: typeof fetch;
  now?: () => number;
}

const MAX_AUDIT_ENTRIES = 100;

export function createBoundedVendorSandboxEgress(
  options: BoundedVendorSandboxEgressOptions,
): BoundedVendorSandboxEgress {
  const policy = validatePolicy(options.policy);
  const requestFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const audit: VendorSandboxRequestAudit[] = [];
  let requestSequence = 0;
  let windowStartedAt = now();
  let requestsInWindow = 0;

  const record = (entry: VendorSandboxRequestAudit): void => {
    audit.push(Object.freeze({ ...entry }));
    if (audit.length > MAX_AUDIT_ENTRIES) audit.splice(0, audit.length - MAX_AUDIT_ENTRIES);
  };

  return Object.freeze({
    requestJson: async (request: VendorSandboxEgressRequest) => {
      const startedAt = now();
      const requestId = `${policy.vendor}-${++requestSequence}`;
      const method = request.method;
      const url = safeUrl(request.path, policy.allowedOrigin);
      const baseAudit = {
        requestId,
        timestamp: new Date(startedAt).toISOString(),
        vendor: policy.vendor,
        resource: request.resource,
        method,
        origin: url?.origin ?? policy.allowedOrigin,
      };
      const deny = (error: VendorSandboxEgressError): never => {
        record({ ...baseAudit, outcome: "denied", durationMs: elapsed(now, startedAt), errorCode: error.code });
        throw error;
      };

      if (!url || url.origin !== policy.allowedOrigin || url.protocol !== "https:" || url.username || url.password || url.hash) {
        return deny(new VendorSandboxEgressError("ORIGIN_DENIED", "Vendor sandbox request origin is not allowlisted."));
      }
      const resource = policy.resources.find((entry) => entry.id === request.resource);
      if (!resource) {
        return deny(new VendorSandboxEgressError("RESOURCE_DENIED", "Vendor sandbox resource is not allowlisted."));
      }
      if (method !== resource.method) {
        return deny(new VendorSandboxEgressError("METHOD_DENIED", "Vendor sandbox HTTP method is not allowlisted for this resource."));
      }
      resource.pathPattern.lastIndex = 0;
      if (!resource.pathPattern.test(`${url.pathname}${url.search}`)) {
        return deny(new VendorSandboxEgressError("RESOURCE_DENIED", "Vendor sandbox path is not allowlisted for this resource."));
      }

      const current = now();
      if (current - windowStartedAt >= 60_000) {
        windowStartedAt = current;
        requestsInWindow = 0;
      }
      if (requestsInWindow >= policy.maxRequestsPerMinute) {
        const error = new VendorSandboxEgressError("RATE_LIMITED", "Vendor sandbox request limit exceeded. Retry after the current one-minute window.");
        record({ ...baseAudit, outcome: "rate_limited", durationMs: elapsed(now, startedAt), errorCode: error.code });
        throw error;
      }
      requestsInWindow += 1;

      const controller = new AbortController();
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const operation = (async (): Promise<{ payload: unknown; status: number }> => {
        const response = await requestFetch(url, {
          method,
          headers: request.headers,
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new VendorSandboxEgressError(
            "HTTP_ERROR",
            `Vendor sandbox returned HTTP ${response.status}.`,
            response.status,
          );
        }
        return { payload: await response.json(), status: response.status };
      })();
      const timeoutOperation = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new VendorSandboxEgressError("TIMEOUT", `Vendor sandbox request exceeded ${policy.timeoutMs} ms.`));
        }, policy.timeoutMs);
      });

      try {
        const result = await Promise.race([operation, timeoutOperation]);
        record({ ...baseAudit, outcome: "allowed", durationMs: elapsed(now, startedAt), status: result.status });
        return result.payload;
      } catch (cause) {
        const error = cause instanceof VendorSandboxEgressError
          ? cause
          : timedOut
            ? new VendorSandboxEgressError("TIMEOUT", `Vendor sandbox request exceeded ${policy.timeoutMs} ms.`)
            : new VendorSandboxEgressError("REQUEST_FAILED", "Vendor sandbox request failed.");
        record({
          ...baseAudit,
          outcome: error.code === "TIMEOUT" ? "timeout" : error.code === "HTTP_ERROR" ? "http_error" : "failed",
          durationMs: elapsed(now, startedAt),
          status: error.status,
          errorCode: error.code,
        });
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
    getAuditLog: () => audit.map((entry) => ({ ...entry })),
  });
}

function validatePolicy(policy: VendorSandboxEgressPolicy): VendorSandboxEgressPolicy {
  const origin = new URL(policy.allowedOrigin);
  if (origin.protocol !== "https:" || origin.origin !== policy.allowedOrigin || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Vendor sandbox allowedOrigin must be an exact HTTPS origin without a path.");
  }
  if (!policy.vendor.trim()) throw new Error("Vendor sandbox policy vendor is required.");
  if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs < 100 || policy.timeoutMs > 30_000) {
    throw new Error("Vendor sandbox timeoutMs must be an integer from 100 to 30000.");
  }
  if (!Number.isSafeInteger(policy.maxRequestsPerMinute) || policy.maxRequestsPerMinute < 1 || policy.maxRequestsPerMinute > 60) {
    throw new Error("Vendor sandbox maxRequestsPerMinute must be an integer from 1 to 60.");
  }
  if (policy.resources.length === 0 || new Set(policy.resources.map((entry) => entry.id)).size !== policy.resources.length) {
    throw new Error("Vendor sandbox policy requires unique resource rules.");
  }
  return Object.freeze({
    ...policy,
    resources: Object.freeze(policy.resources.map((entry) => Object.freeze({
      ...entry,
      pathPattern: new RegExp(entry.pathPattern.source, entry.pathPattern.flags),
    }))),
  });
}

function safeUrl(path: string, origin: string): URL | undefined {
  try {
    return new URL(path, `${origin}/`);
  } catch {
    return undefined;
  }
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, Math.round(now() - startedAt));
}
