import { filesize } from "filesize";
import { nanoid } from "nanoid";
import { Adapter } from "../adapters/adapter";
import { Entry } from "../models/entry";
import { EditionRecord, FileDetails } from "./edition";

const formatSize = (bytes: number): string => {
  if (bytes <= 0) {
    return "";
  }

  return filesize(bytes, { base: 2, standard: "jedec" }).toString();
};

/**
 * Turns bibliographic records into the same `Entry` shape the HTML search
 * produces, so a DOI or issue lookup flows into the existing result list,
 * detail view, download queue and bulk queue untouched. `mirror` holds the
 * detail page URL, which is what every download path reads the MD5 from.
 */
export const buildEntriesFromEditions = (
  records: EditionRecord[],
  fileDetails: Map<string, FileDetails>,
  adapter: Adapter
): Entry[] => {
  const entries: Entry[] = [];

  for (const record of records) {
    for (const file of record.files) {
      const details = fileDetails.get(file.md5);

      entries.push({
        id: nanoid(),
        authors: record.author,
        title: record.title,
        publisher: record.doi,
        year: record.year,
        pages: record.pages,
        language: "",
        size: formatSize(details?.filesize || 0),
        extension: details?.extension || "",
        mirror: adapter.getDetailPageURL(file.md5),
      });
    }
  }

  return entries;
};
