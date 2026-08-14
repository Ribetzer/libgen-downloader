import fs from "node:fs";
import path from "node:path";
import { describeResolveFailure } from "../api/data/download";
import { getEditionMD5s, normalizeDOI } from "../api/data/edition";
import { parseMD5List } from "../api/data/file";
import { lookupEditionByDOI, lookupIssueEditions, LookupResult } from "../api/data/lookup";
import { getMD5FromURL } from "../api/data/md5";
import { resolveDownloadURL } from "../api/data/resolve";
import {
  ensureOutputDirectory,
  resolveOutputDirectory,
  writeUserConfig,
} from "../api/data/user-config";
import renderTUI from "../tui/index";
import { LAYOUT_KEY } from "../tui/layouts/keys";
import { useBoundStore } from "../tui/store/index";

const MAX_REPORTED_INVALID_LINES = 5;

/**
 * Resolves the download folder once per run (flag, then saved default, then
 * the current directory) and makes sure it can actually be written to before
 * any download starts.
 */
const applyOutputDirectory = async (flags: Record<string, unknown>) => {
  const directory = await resolveOutputDirectory(flags.output as string | undefined);

  try {
    await ensureOutputDirectory(directory);
  } catch (error: unknown) {
    console.log(`Can't use "${directory}" as the download folder: ${(error as Error)?.message}`);
    process.exitCode = 1;
    return;
  }

  useBoundStore.getState().setOutputDirectory(directory);
  return directory;
};

const buildLookupArguments = () => {
  const store = useBoundStore.getState();

  return {
    candidates: store.getMirrorCandidates(),
    onMirrorUnreachable: (mirrorSource: string) => {
      store.markMirrorUnreachable(mirrorSource);
    },
  };
};

const describeLookupFailure = (
  result: Exclude<LookupResult, { status: "found" }>,
  notFoundMessage: string
): string => {
  if (result.status === "unreachable") {
    return `Couldn't reach any mirror (${result.checkedMirrors.join(", ")})`;
  }

  return `${notFoundMessage} on any mirror (${result.checkedMirrors.join(", ")})`;
};

/**
 * Every list of MD5s, however it was gathered, goes through the same bulk queue
 * so failover, backoff, naming and the failure report apply unchanged.
 */
const startBulkDownload = (md5List: string[]) => {
  renderTUI({
    startInCLIMode: true,
    doNotFetchConfigInitially: true,
    initialLayout: LAYOUT_KEY.BULK_DOWNLOAD_LAYOUT,
  });
  useBoundStore.getState().startBulkDownloadInCLI(md5List);
};

/**
 * `fetchConfig` reports its own failures through the store, and the snapshot
 * taken before it ran is stale, so the result has to be read back fresh.
 */
const fetchConfigAndCheckMirror = async () => {
  await useBoundStore.getState().fetchConfig();

  if (useBoundStore.getState().mirror) {
    return true;
  }

  console.log("Couldn't reach any LibGen mirror. Nothing to download from, try again later.");
  process.exitCode = 1;
  return false;
};

const readMD5ListFile = async (filePath: string) => {
  try {
    const contents = await fs.promises.readFile(filePath, "utf8");
    return parseMD5List(contents);
  } catch (error: unknown) {
    console.log(`Couldn't read "${filePath}": ${(error as Error)?.message}`);
    return;
  }
};

/**
 * Nothing awaits `operate`, so an unhandled rejection here would surface as a
 * bare stack trace on top of the rendered UI.
 */
export const operate = async (flags: Record<string, unknown>) => {
  try {
    await runFlags(flags);
  } catch (error: unknown) {
    console.log((error as Error)?.message || "Unexpected error");
    process.exitCode = 1;
  }
};

const runFlags = async (flags: Record<string, unknown>) => {
  if (flags.setOutput) {
    const directory = path.resolve(flags.setOutput as string);

    try {
      await ensureOutputDirectory(directory);
      const configPath = await writeUserConfig({ outputDirectory: directory });
      console.log(`Downloads will go to ${directory}`);
      console.log(`Saved in ${configPath}`);
    } catch (error: unknown) {
      console.log(`Couldn't save "${directory}": ${(error as Error)?.message}`);
      process.exitCode = 1;
    }

    return;
  }

  if (!(await applyOutputDirectory(flags))) {
    return;
  }

  if (flags.search) {
    const query = flags.search as string;
    if (query.length < 3) {
      console.log("Query must be at least 3 characters long");
      return;
    }

    const store = useBoundStore.getState();
    await store.fetchConfig();
    store.setSearchValue(query);
    renderTUI({
      startInCLIMode: false,
      doNotFetchConfigInitially: true,
    });
    store.handleSearchSubmit();
    return;
  }

  if (flags.doi) {
    const doi = normalizeDOI(flags.doi as string);
    if (!doi) {
      console.log(`"${flags.doi}" is not a DOI`);
      process.exitCode = 1;
      return;
    }

    if (!(await fetchConfigAndCheckMirror())) {
      return;
    }

    console.log(`Looking up ${doi}...`);
    const result = await lookupEditionByDOI(doi, buildLookupArguments());

    if (result.status !== "found") {
      console.log(describeLookupFailure(result, `No record for ${doi}`));
      process.exitCode = 1;
      return;
    }

    const md5List: string[] = [];
    for (const record of result.records) {
      console.log(`${record.title} (${record.year})`);
      if (record.files.length === 0) {
        console.log("  no file attached to this record");
        continue;
      }

      md5List.push(record.files[0].md5);
      if (record.files.length > 1) {
        console.log(`  ${record.files.length} files attached, taking the first`);
      }
    }

    if (md5List.length === 0) {
      console.log("Nothing to download");
      process.exitCode = 1;
      return;
    }

    startBulkDownload(md5List);
    return;
  }

  if (flags.issue) {
    const issuesId = (flags.issue as string).trim();
    if (!/^\d+$/.test(issuesId)) {
      console.log(`"${flags.issue}" is not an issues id`);
      process.exitCode = 1;
      return;
    }

    const volume = (flags.volume as string | undefined)?.trim();

    if (!(await fetchConfigAndCheckMirror())) {
      return;
    }

    let scope = `issuesid:${issuesId}`;
    if (volume) {
      scope += ` volume ${volume}`;
    }
    console.log(`Collecting editions for ${scope}`);
    const result = await lookupIssueEditions({
      issuesId,
      volume,
      ...buildLookupArguments(),
      onPage: (pageNumber, editionCount) => {
        console.log(`  page ${pageNumber}: ${editionCount} editions so far`);
      },
    });

    if (result.status !== "found") {
      console.log(describeLookupFailure(result, "No editions found"));
      process.exitCode = 1;
      return;
    }

    const md5List = getEditionMD5s(result.records);
    const withoutFiles = result.records.filter((record) => record.files.length === 0).length;
    console.log(`${result.records.length} editions, ${md5List.length} files`);
    if (withoutFiles > 0) {
      console.log(`${withoutFiles} editions have no file and are skipped`);
    }

    if (md5List.length === 0) {
      console.log("Nothing to download");
      process.exitCode = 1;
      return;
    }

    startBulkDownload(md5List);
    return;
  }

  if (flags.bulk) {
    const filePath = flags.bulk as string;

    const parseResult = await readMD5ListFile(filePath);
    if (!parseResult) {
      return;
    }

    const { md5List, invalidLines, preferredMirror } = parseResult;

    for (const invalidLine of invalidLines.slice(0, MAX_REPORTED_INVALID_LINES)) {
      console.log(`Skipping line ${invalidLine.lineNumber}, no MD5 found: ${invalidLine.content}`);
    }
    if (invalidLines.length > MAX_REPORTED_INVALID_LINES) {
      console.log(`...and ${invalidLines.length - MAX_REPORTED_INVALID_LINES} more skipped lines`);
    }

    if (md5List.length === 0) {
      console.log(
        `No MD5 found in "${filePath}". The file should hold one 32 character MD5 per line and be saved as plain UTF-8 text.`
      );
      process.exitCode = 1;
      return;
    }

    if (!(await fetchConfigAndCheckMirror())) {
      return;
    }

    const store = useBoundStore.getState();
    // The list records the mirror it came from, and catalogues differ between
    // mirrors, so that one is worth trying first.
    store.setPreferredMirrorSource(preferredMirror);
    renderTUI({
      startInCLIMode: true,
      doNotFetchConfigInitially: true,
      initialLayout: LAYOUT_KEY.BULK_DOWNLOAD_LAYOUT,
    });
    store.startBulkDownloadInCLI(md5List);
    return;
  }

  if (flags.url) {
    const md5 = getMD5FromURL(flags.url as string);
    if (!md5) {
      console.log(`"${flags.url}" is not an MD5`);
      process.exitCode = 1;
      return;
    }

    console.log("Fetching config...");
    await useBoundStore.getState().fetchConfig();
    const store = useBoundStore.getState();

    console.log("Finding download url...");
    const resolveResult = await resolveDownloadURL({
      md5,
      candidates: store.getMirrorCandidates(),
      onMirrorTry: (mirrorSource) => {
        console.log(`Looking up ${mirrorSource}`);
      },
    });

    if (resolveResult.status !== "resolved") {
      console.log(`No download url for ${md5}: ${describeResolveFailure(resolveResult)}`);
      return;
    }

    console.log("Here is the direct download link:");
    console.log(resolveResult.downloadURL);

    return;
  }

  if (flags.download) {
    const md5 = getMD5FromURL(flags.download as string);
    if (!md5) {
      console.log(`"${flags.download}" is not an MD5`);
      process.exitCode = 1;
      return;
    }

    if (!(await fetchConfigAndCheckMirror())) {
      return;
    }

    const md5List = [md5];
    const store = useBoundStore.getState();
    renderTUI({
      startInCLIMode: true,
      doNotFetchConfigInitially: true,
      initialLayout: LAYOUT_KEY.BULK_DOWNLOAD_LAYOUT,
    });
    store.startBulkDownloadInCLI(md5List);
    return;
  }

  renderTUI({
    startInCLIMode: false,
    doNotFetchConfigInitially: false,
  });
};
