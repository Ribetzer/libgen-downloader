import { Entry } from "../models/entry";

export interface IssueQuery {
  issuesId: string;
  volume?: string;
  pageNumber: number;
  pageSize: number;
}

export abstract class Adapter {
  abstract baseURL: string;

  // Bibliographic lookups go through the mirror's JSON API rather than its
  // HTML, which is both stabler and cheaper.
  abstract getEditionByDOIURL(doi: string): string;
  abstract getEditionsByIdsURL(editionIds: string[]): string;
  abstract getFilesByIdsURL(fileIds: string[]): string;
  abstract getIssueSearchURL(query: IssueQuery): string;
  abstract parseEditionIds(document: Document): string[];

  abstract isHiddenField(fieldName: string): boolean;
  abstract parseEntries(
    document: Document,
    throwError?: (message: string) => void
  ): Entry[] | undefined;
  abstract getPageURL(pathname: string): string;
  abstract getSearchURL(query: string, pageNumber: number, pageSize: number): string;
  abstract getDetailPageURL(md5: string): string;
  abstract getMainDownloadURLFromDocument(
    document: Document,
    throwError?: (message: string) => void
  ): string | undefined;
  abstract formatField(fieldName: string, value: string): string;
  abstract detectConnectionError(document: Document): string | undefined;
}
