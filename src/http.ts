/**
 * Minimal fetch-based HTTP layer shared by all service clients.
 *
 * Auth integration: callers pass a `headers` factory per request (L1/L2 headers depend on
 * method + path + body, so they must be computed after serialization).
 */

import { ApiError, RateLimitError, TransportError } from "./errors.js";

export interface HttpRequestOptions {
  /** Query parameters; undefined values are skipped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
  /** JSON body (already-typed value; serialized exactly once, used for HMAC too). */
  body?: unknown;
  /** AbortSignal for cancellation/timeouts. */
  signal?: AbortSignal;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
}

export class HttpClient {
  readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(baseUrl: string, defaultHeaders: Record<string, string> = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.defaultHeaders = defaultHeaders;
  }

  /** URL path (no query) for HMAC signing parity with the server's `URL.Path`. */
  buildPath(path: string): string {
    return path.startsWith("/") ? path : `/${path}`;
  }

  buildUrl(path: string, query?: HttpRequestOptions["query"]): string {
    const url = new URL(this.baseUrl + this.buildPath(path));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /**
   * Serialize the body exactly as it goes on the wire. L2 signing must HMAC these exact
   * bytes, so this is the single source of truth for serialization.
   */
  static serializeBody(body: unknown): string {
    return body === undefined ? "" : JSON.stringify(body);
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const url = this.buildUrl(path, options.query);
    const bodyText = HttpClient.serializeBody(options.body);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...this.defaultHeaders,
      ...options.headers,
    };
    if (bodyText !== "") {
      headers["content-type"] = "application/json";
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(bodyText === "" ? {} : { body: bodyText }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (e) {
      throw new TransportError(`${method} ${url}: ${(e as Error).message}`, { cause: e });
    }

    const text = await res.text();
    if (res.status === 429) {
      throw new RateLimitError(res.status, path, text);
    }
    if (!res.ok) {
      throw new ApiError(res.status, path, text);
    }
    if (text === "") {
      return { status: res.status, data: undefined as T };
    }
    try {
      return { status: res.status, data: JSON.parse(text) as T };
    } catch {
      // Some endpoints (e.g. /ok) return plain text.
      return { status: res.status, data: text as unknown as T };
    }
  }

  get<T>(path: string, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>("GET", path, options);
  }

  post<T>(path: string, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>("POST", path, options);
  }

  put<T>(path: string, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>("PUT", path, options);
  }

  del<T>(path: string, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>("DELETE", path, options);
  }
}
