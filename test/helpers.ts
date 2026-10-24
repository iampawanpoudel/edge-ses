export interface CapturedCall {
  url: string;
  init: RequestInit;
}

export type MockHandler = (
  call: CapturedCall,
  attempt: number,
) => Response | Promise<Response>;

export function createMockFetch(handler: MockHandler): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchImpl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const call: CapturedCall = { url, init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length);
  };

  return { fetch: fetchImpl as typeof fetch, calls };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function responseText(
  body: string,
  status = 500,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain", ...headers },
  });
}

export function headerValue(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

export function requestBody(call: CapturedCall): Record<string, unknown> {
  if (typeof call.init.body !== "string") {
    throw new Error("Expected a string request body");
  }
  return JSON.parse(call.init.body) as Record<string, unknown>;
}
