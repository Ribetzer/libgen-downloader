import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  absolutePDFURL,
  getSciHubHosts,
  readSciHubPage,
  SCIHUB_CERTIFICATE_FINGERPRINT,
  scihubRequestInit,
  scihubSource,
} from "../src/api/sources/scihub";
import { downloadRequestInit } from "../src/api/sources";
import { SCIHUB_HOSTS } from "../src/settings";
import { mockFetch } from "./support/fetch-mock";

// Captured from sci-hub.st, not written by hand: the three responses only
// differ in ways a real capture preserves - the found page carries a
// `citation_pdf_url` meta, the missing one answers 404, and the rate-limited
// one is a 200 that looks like neither.
const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dir, "fixtures", `${name}.html`), "utf8");

const FOUND = fixture("scihub-found");
const NOT_FOUND = fixture("scihub-not-found");
const CHALLENGE = fixture("scihub-challenge");

describe("readSciHubPage", () => {
  it("reads the PDF URL out of an article page", () => {
    const page = readSciHubPage(FOUND, 200, "sci-hub.st");

    expect(page.status).toBe("found");
    if (page.status !== "found") {
      return;
    }

    expect(page.pdfURL).toStartWith("https://");
    expect(page.pdfURL).toEndWith(".pdf");
    expect(page.title).toBe("Marching cubes: A high resolution 3D surface construction algorithm");
    expect(page.year).toBe("1987");
    expect(page.journal).toBe("ACM SIGGRAPH Computer Graphics");
  });

  it("reads a 404 as the article not being held", () => {
    expect(readSciHubPage(NOT_FOUND, 404, "sci-hub.st").status).toBe("not_found");
  });

  it("does not report a captcha as the article not being held", () => {
    // The important distinction in this file. Sci-Hub answers the rate limit
    // with 200 and a page that carries no PDF URL; calling that "not found"
    // would send the caller looking elsewhere for a paper Sci-Hub is holding.
    expect(readSciHubPage(CHALLENGE, 200, "sci-hub.st").status).toBe("challenged");
  });
});

describe("absolutePDFURL", () => {
  it("gives a protocol-relative link to a different host its scheme", () => {
    // The PDF lives on a storage host, not the page host, and the link arrives
    // as `//sci-hub.red/storage/…`.
    expect(absolutePDFURL("//sci-hub.red/storage/a/b.pdf", "sci-hub.st")).toBe(
      "https://sci-hub.red/storage/a/b.pdf"
    );
  });

  it("resolves a rooted path against the page host", () => {
    // The other spelling, seen on the same day.
    expect(absolutePDFURL("/storage/a/b.pdf", "sci-hub.st")).toBe(
      "https://sci-hub.st/storage/a/b.pdf"
    );
  });

  it("leaves an absolute URL alone", () => {
    expect(absolutePDFURL("https://elsewhere.example/a.pdf", "sci-hub.st")).toBe(
      "https://elsewhere.example/a.pdf"
    );
  });
});

describe("scihubRequestInit", () => {
  it("pins one certificate rather than turning verification off", () => {
    const { tls } = scihubRequestInit() as { tls: { ca: string; rejectUnauthorized?: boolean } };

    expect(tls.ca).toContain("BEGIN CERTIFICATE");
    // The thing this must never become. `rejectUnauthorized: false` here - or
    // NODE_TLS_REJECT_UNAUTHORIZED anywhere - would switch verification off for
    // LibGen and arXiv too, which is the whole reason for the pin.
    expect(tls.rejectUnauthorized).toBeUndefined();
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it("records the fingerprint of the certificate it carries", () => {
    // A pin nobody can check is not much of a pin: this is the value to
    // compare against when the certificate rotates and every request starts
    // failing.
    expect(SCIHUB_CERTIFICATE_FINGERPRINT).toMatch(/^([\dA-F]{2}:){31}[\dA-F]{2}$/);
  });
});

describe("getSciHubHosts", () => {
  afterEach(() => {
    delete process.env.LIBGEN_SCIHUB_HOSTS;
  });

  it("uses the built-in list by default", () => {
    expect(getSciHubHosts()).toEqual(SCIHUB_HOSTS);
  });

  it("lets a dead host be replaced without a code change", () => {
    process.env.LIBGEN_SCIHUB_HOSTS = "sci-hub.example, sci-hub.other";
    expect(getSciHubHosts()).toEqual(["sci-hub.example", "sci-hub.other"]);
  });

  it("does not list sci-hub.se, which no longer resolves anywhere", () => {
    expect(SCIHUB_HOSTS).not.toContain("sci-hub.se");
  });
});

describe("scihubSource", () => {
  afterEach(() => {
    delete process.env.LIBGEN_SCIHUB_HOSTS;
  });

  it("takes a DOI and nothing else", () => {
    expect(scihubSource.handles({ kind: "doi", doi: "10.1145/37402.37422" })).toBe(true);
    expect(scihubSource.handles({ kind: "text", query: "marching cubes" })).toBe(false);
    expect(scihubSource.handles({ kind: "issue", issuesId: "13647" })).toBe(false);
  });

  it("returns a result carrying the URL and the DOI it was found by", async () => {
    process.env.LIBGEN_SCIHUB_HOSTS = "sci-hub.example";
    const { fetchMock } = mockFetch(async () => new Response(FOUND, { status: 200 }));

    const outcome = await scihubSource.search({ kind: "doi", doi: "10.1145/37402.37422" }, 1, {
      candidates: [],
    });
    fetchMock.mockRestore();

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") {
      return;
    }

    const [item] = outcome.items;
    expect(item.source).toBe("scihub");
    // No MD5 anywhere in this path, which is the case `withIdentity` exists for.
    expect(item.md5).toBe("");
    expect(item.downloadURL).toEndWith("lorensen1987.pdf");
    // Found *by* DOI, so this is never a guess - and it is what puts the
    // identifier into the downloaded filename.
    expect(item.doi).toBe("10.1145/37402.37422");
  });

  it("asks only one host once the answer is a definite no", async () => {
    // Every host serves the same library, so walking the rest after a 404 is
    // pure load on a service that is already rate limiting.
    process.env.LIBGEN_SCIHUB_HOSTS = "first.example,second.example";
    const { fetchMock, requestedURLs } = mockFetch(
      async () => new Response(NOT_FOUND, { status: 404 })
    );

    const outcome = await scihubSource.search({ kind: "doi", doi: "10.9999/nope" }, 1, {
      candidates: [],
    });
    fetchMock.mockRestore();

    expect(requestedURLs).toHaveLength(1);
    expect(outcome).toEqual({ status: "ok", items: [] });
  });

  it("says a captcha is a captcha rather than reporting an empty result", async () => {
    process.env.LIBGEN_SCIHUB_HOSTS = "first.example,second.example";
    const { fetchMock, requestedURLs } = mockFetch(
      async () => new Response(CHALLENGE, { status: 200 })
    );

    const outcome = await scihubSource.search({ kind: "doi", doi: "10.1145/37402.37422" }, 1, {
      candidates: [],
    });
    fetchMock.mockRestore();

    // A challenge is not an answer about the DOI, so the other host is tried.
    expect(requestedURLs).toHaveLength(2);
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") {
      return;
    }

    expect(outcome.message).toContain("captcha");
  });

  it("reports being unable to reach Sci-Hub separately from being told no", async () => {
    process.env.LIBGEN_SCIHUB_HOSTS = "first.example";
    const { fetchMock } = mockFetch(async () => {
      throw new Error("self signed certificate");
    });

    const outcome = await scihubSource.search({ kind: "doi", doi: "10.1145/37402.37422" }, 1, {
      candidates: [],
    });
    fetchMock.mockRestore();

    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") {
      return;
    }

    expect(outcome.message).toContain("Couldn't reach Sci-Hub");
    expect(outcome.message).toContain("self signed certificate");
  });
});

describe("downloadRequestInit", () => {
  afterEach(() => {
    delete process.env.LIBGEN_SCIHUB_HOSTS;
  });

  it("pins a PDF served from the page host", () => {
    // The `/storage/…` spelling resolves against the page host, which is
    // behind DDoS-Guard's self-signed certificate. A plain fetch of it fails
    // with "self signed certificate" - observed, in the queue, after the
    // lookup itself had already succeeded.
    const init = downloadRequestInit(
      "https://sci-hub.st/storage/zero/6684/abc/lorensen1987.pdf"
    ) as { tls?: { ca: string } };

    expect(init.tls?.ca).toContain("BEGIN CERTIFICATE");
  });

  it("leaves the storage host alone, which has an ordinary certificate", () => {
    // sci-hub.red serves the same files under a real Let's Encrypt
    // certificate, so pinning there would be pointless and fragile.
    expect(downloadRequestInit("https://sci-hub.red/storage/dace/4357/abc/ju2002.pdf")).toEqual({});
  });

  it("leaves every other host alone", () => {
    expect(downloadRequestInit("https://arxiv.org/pdf/2304.00359v1")).toEqual({});
    expect(downloadRequestInit("https://libgen.li/get.php?md5=abc")).toEqual({});
  });

  it("does not throw on something that is not a URL", () => {
    expect(downloadRequestInit("not a url")).toEqual({});
  });

  it("follows the configured host list, so an override is pinned too", () => {
    process.env.LIBGEN_SCIHUB_HOSTS = "sci-hub.example";
    const init = downloadRequestInit("https://sci-hub.example/storage/a.pdf") as {
      tls?: { ca: string };
    };

    expect(init.tls?.ca).toContain("BEGIN CERTIFICATE");
    // …and a host that was in the built-in list no longer is.
    expect(downloadRequestInit("https://sci-hub.st/storage/a.pdf")).toEqual({});
  });
});
