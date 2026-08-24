import { spyOn } from "bun:test";

// `init` is forwarded so a handler can assert on request headers - the
// resume tests check for `Range`, which is invisible without it.
type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Replaces global fetch with a handler and records every requested URL.
 * `preconnect` only exists to satisfy the shape of Bun's fetch.
 */
export const mockFetch = (handler: FetchHandler) => {
  const requestedURLs: string[] = [];

  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requestedURLs.push(getRequestURL(input));
        return handler(input, init);
      },
      { preconnect() {} }
    )
  );

  return { fetchMock, requestedURLs };
};

export const getRequestURL = (input: RequestInfo | URL): string => {
  if (input instanceof Request) {
    return input.url;
  }

  return input.toString();
};
