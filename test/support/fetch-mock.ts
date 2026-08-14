import { spyOn } from "bun:test";

type FetchHandler = (input: RequestInfo | URL) => Promise<Response>;

/**
 * Replaces global fetch with a handler and records every requested URL.
 * `preconnect` only exists to satisfy the shape of Bun's fetch.
 */
export const mockFetch = (handler: FetchHandler) => {
  const requestedURLs: string[] = [];

  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL) => {
        requestedURLs.push(getRequestURL(input));
        return handler(input);
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
