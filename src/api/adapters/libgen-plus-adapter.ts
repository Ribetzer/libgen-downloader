import { Entry } from "../models/entry";
import { Adapter, IssueQuery } from "./adapter";
import { nanoid } from "nanoid";
import { clearText } from "../../utilities";

const EDITION_LINK_PATTERN = /edition\.php\?id=(\d+)/g;

export class LibgenPlusAdapter implements Adapter {
  baseURL: string;

  constructor(baseURL: string) {
    this.baseURL = baseURL;
  }

  getEditionByDOIURL(doi: string): string {
    const url = new URL("/json.php", this.baseURL);
    url.searchParams.set("object", "e");
    url.searchParams.set("doi", doi);
    url.searchParams.set("fields", "*");
    return url.toString();
  }

  getEditionsByIdsURL(editionIds: string[]): string {
    const url = new URL("/json.php", this.baseURL);
    url.searchParams.set("object", "e");
    url.searchParams.set("ids", editionIds.join(","));
    url.searchParams.set("fields", "*");
    return url.toString();
  }

  getFilesByIdsURL(fileIds: string[]): string {
    const url = new URL("/json.php", this.baseURL);
    url.searchParams.set("object", "f");
    url.searchParams.set("ids", fileIds.join(","));
    url.searchParams.set("fields", "md5,extension,filesize");
    return url.toString();
  }

  /**
   * The editions tab is the only view that lists a periodical's articles;
   * `curtab=e` selects it and the results carry no MD5s, only edition ids.
   */
  getIssueSearchURL({ issuesId, volume, pageNumber, pageSize }: IssueQuery): string {
    const url = new URL("/index.php", this.baseURL);

    let request = `issuesid:${issuesId}`;
    if (volume) {
      request += ` issuevolume:${volume}`;
    }

    url.searchParams.set("req", request);
    url.searchParams.set("gmode", "on");
    url.searchParams.set("topics1", "all");
    url.searchParams.set("curtab", "e");
    url.searchParams.set("res", pageSize.toString());
    url.searchParams.set("page", pageNumber.toString());
    return url.toString();
  }

  /**
   * Every result row links to its edition from several columns, so the ids are
   * collected in document order and de-duplicated.
   */
  parseEditionIds(document: Document): string[] {
    const editionIds: string[] = [];

    for (const element of document.querySelectorAll("a")) {
      const href = element.getAttribute("href") || "";
      for (const match of href.matchAll(EDITION_LINK_PATTERN)) {
        if (!editionIds.includes(match[1])) {
          editionIds.push(match[1]);
        }
      }
    }

    return editionIds;
  }

  isHiddenField(fieldName: string): boolean {
    return !["id"].includes(fieldName);
  }

  parseEntries(document: Document, throwError?: (message: string) => void): Entry[] | undefined {
    const entries: Entry[] = [];
    const containerTable = document.querySelector<HTMLTableElement>("#tablelibgen > tbody");

    if (!containerTable) {
      if (throwError) {
        throwError("containerTable is undefined");
      }
      return [];
    }

    // Get rid of table header by slicing it
    const entryElements = containerTable.children;

    for (const element of entryElements) {
      const id = nanoid();
      const authors = clearText(element.children[1]?.textContent || "")
        .split(";")
        .map((author) => author.trim())
        .join(", ");
      const titleSectionContent = [...element.children[0].children]
        .filter((child) => child.nodeName !== "NOBR")
        .map((element) => element.textContent?.trim())
        .filter(Boolean)
        .join(" / ");
      const title = clearText(titleSectionContent || "");
      const publisher = clearText(element.children[2]?.textContent || "");
      const year = clearText(element.children[3]?.textContent || "");
      const pages = clearText(element.children[5]?.textContent || "");
      const language = clearText(element.children[4]?.textContent || "");
      const size = clearText(element.children[6]?.textContent || "");
      const extension = clearText(element.children[7]?.textContent || "");
      const mirror =
        element.children[8]?.getElementsByTagName("a")?.[0]?.getAttribute("href") || "";
      entries.push({
        id,
        authors,
        title,
        publisher,
        year,
        pages,
        language,
        size,
        extension,
        mirror,
      });
    }

    return entries;
  }

  getPageURL(pathname: string): string {
    const url = new URL(pathname, this.baseURL);
    return url.toString();
  }

  getSearchURL(query: string, pageNumber: number, pageSize: number): string {
    const url = new URL("/index.php", this.baseURL);
    url.searchParams.set("req", query);
    url.searchParams.set("page", pageNumber.toString());
    url.searchParams.set("res", pageSize.toString());
    return url.toString();
  }

  getDetailPageURL(md5: string): string {
    const url = new URL("/ads.php", this.baseURL);
    url.searchParams.set("md5", md5);
    return url.toString();
  }

  getMainDownloadURLFromDocument(
    document: Document,
    throwError?: (message: string) => void
  ): string | undefined {
    const downloadLinkElement = document.querySelector(
      "#main > tr:first-child > td:nth-child(2) > a"
    );

    if (!downloadLinkElement) {
      if (throwError) {
        throwError("downloadLinkElement is undefined");
      }
      return undefined;
    }

    const href = downloadLinkElement.getAttribute("href");
    return this.getPageURL(href || "");
  }

  detectConnectionError(document: Document): string | undefined {
    const alertElement = document.querySelector(".alert-danger");
    if (alertElement) {
      return alertElement.textContent?.trim() || "Unknown connection error";
    }
    return undefined;
  }

  formatField(fieldName: string, value: string): string {
    switch (fieldName) {
      case "authors": {
        return value
          .split(", ")
          .map((author) => author.trim())
          .join(", ");
      }
      case "title": {
        return value.trim();
      }
      case "publisher":
      case "year":
      case "pages":
      case "language":
      case "size":
      case "extension": {
        return value.trim();
      }
      case "mirror": {
        if (value.startsWith("http")) {
          return value;
        }
        return this.getPageURL(value);
      }
      default: {
        return value;
      }
    }
  }
}
