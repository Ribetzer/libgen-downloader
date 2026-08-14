import contentDisposition from "content-disposition";
import fs from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DownloadResult } from "../models/download-result";
import { Mirror } from "./config";
import { MirrorCandidate, resolveDownloadURL, ResolveResult } from "./resolve";
import {
  DOWNLOAD_ATTEMPT_COUNT,
  DOWNLOAD_RETRY_DELAY_MS,
  MAX_DOWNLOAD_MIRRORS,
} from "../../settings";
import { delay } from "../../utilities";

interface downloadFileArguments {
  downloadStream: Response;
  onStart: (filename: string, total: number) => void;
  onData: (filename: string, chunk: Buffer, total: number) => void;
}

const removePartialFile = async (path: string) => {
  try {
    await fs.promises.rm(path, { force: true });
  } catch {
    // A leftover file we cannot remove must not mask the download error.
  }
};

export const downloadFile = async ({
  downloadStream,
  onStart,
  onData,
}: downloadFileArguments): Promise<DownloadResult> => {
  const MAX_FILE_NAME_LENGTH = 128;

  const downloadContentDisposition = downloadStream.headers.get("content-disposition");
  if (!downloadContentDisposition) {
    throw new Error("No content-disposition header found");
  }

  const parsedContentDisposition = contentDisposition.parse(downloadContentDisposition);
  const fullFileName = parsedContentDisposition.parameters.filename;
  const slicedFileName = fullFileName.slice(
    Math.max(fullFileName.length - MAX_FILE_NAME_LENGTH, 0)
  );
  const path = `./${slicedFileName}`;

  const total = Number(downloadStream.headers.get("content-length") || 0);
  const filename = parsedContentDisposition.parameters.filename;

  if (!downloadStream.body) {
    throw new Error("No response body");
  }

  onStart(filename, total);

  const progressStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buffer = Buffer.from(chunk);
      onData(filename, buffer, total);
      callback(undefined, buffer);
    },
  });

  try {
    await pipeline(
      Readable.from(downloadStream.body, { objectMode: false }),
      progressStream,
      fs.createWriteStream(path)
    );

    const downloadResult: DownloadResult = {
      path,
      filename,
      total,
    };

    return downloadResult;
  } catch {
    // The file on disk is truncated at this point and would otherwise be
    // indistinguishable from a complete download.
    await removePartialFile(path);
    throw new Error(`(${filename}) Error occurred while downloading file`);
  }
};

interface TransferArguments {
  downloadURL: string;
  retryDelayMs: number;
  onStart: (filename: string, total: number) => void;
  onData: (filename: string, chunk: Buffer, total: number) => void;
  onRetry?: (message: string) => void;
}

type TransferOutcome =
  | { status: "downloaded"; result: DownloadResult }
  | { status: "failed"; reason: string };

const transferFile = async ({
  downloadURL,
  retryDelayMs,
  onStart,
  onData,
  onRetry,
}: TransferArguments): Promise<TransferOutcome> => {
  let lastError = "unknown error";

  for (let index = 0; index < DOWNLOAD_ATTEMPT_COUNT; index++) {
    try {
      const downloadStream = await fetch(downloadURL);

      if (!downloadStream.ok) {
        throw new Error(`HTTP ${downloadStream.status}`);
      }

      const result = await downloadFile({ downloadStream, onStart, onData });
      return { status: "downloaded", result };
    } catch (error: unknown) {
      lastError = (error as Error)?.message || "unknown error";

      if (index + 1 === DOWNLOAD_ATTEMPT_COUNT) {
        break;
      }

      if (onRetry) {
        onRetry(`${lastError} (retrying ${index + 2}/${DOWNLOAD_ATTEMPT_COUNT})`);
      }

      await delay(retryDelayMs);
    }
  }

  return { status: "failed", reason: lastError };
};

const getMirrorLabel = (mirrorSource: string): string => {
  try {
    return new URL(mirrorSource).hostname;
  } catch {
    return mirrorSource;
  }
};

export const describeResolveFailure = (result: ResolveResult): string => {
  if (result.status === "resolved") {
    return "";
  }

  if (result.checkedMirrors.length === 0) {
    return "no mirror available";
  }

  const mirrorLabels = result.checkedMirrors.map((source) => getMirrorLabel(source)).join(", ");

  if (result.status === "not_found") {
    return `not found on any mirror (${mirrorLabels})`;
  }

  return `couldn't reach any mirror (${mirrorLabels})`;
};

interface DownloadByMD5Arguments {
  md5: string;
  candidates: MirrorCandidate[];
  onStart: (filename: string, total: number) => void;
  onData: (filename: string, chunk: Buffer, total: number) => void;
  onMirrorTry?: (mirrorSource: string) => void;
  onMirrorUnreachable?: (mirrorSource: string) => void;
  onRetry?: (message: string) => void;
  retryDelayMs?: number;
}

export type DownloadByMD5Outcome =
  | { status: "downloaded"; result: DownloadResult; mirror: Mirror }
  | { status: "failed"; reason: string };

/**
 * Resolves an MD5 against the candidate mirrors and downloads it, restarting a
 * dropped transfer a few times and falling through to another mirror when one
 * keeps failing. Shared by the direct download queue and the bulk queue.
 */
export const downloadByMD5 = async ({
  md5,
  candidates,
  onStart,
  onData,
  onMirrorTry,
  onMirrorUnreachable,
  onRetry,
  retryDelayMs = DOWNLOAD_RETRY_DELAY_MS,
}: DownloadByMD5Arguments): Promise<DownloadByMD5Outcome> => {
  let remainingCandidates = [...candidates];
  const failedMirrorLabels: string[] = [];
  let lastTransferError: string | undefined;

  for (let mirrorIndex = 0; mirrorIndex < MAX_DOWNLOAD_MIRRORS; mirrorIndex++) {
    const resolveResult = await resolveDownloadURL({
      md5,
      candidates: remainingCandidates,
      onMirrorTry,
      onMirrorUnreachable,
    });

    if (resolveResult.status !== "resolved") {
      if (lastTransferError) {
        break;
      }

      return { status: "failed", reason: describeResolveFailure(resolveResult) };
    }

    const transferOutcome = await transferFile({
      downloadURL: resolveResult.downloadURL,
      retryDelayMs,
      onStart,
      onData,
      onRetry,
    });

    if (transferOutcome.status === "downloaded") {
      return {
        status: "downloaded",
        result: transferOutcome.result,
        mirror: resolveResult.candidate.mirror,
      };
    }

    const failedMirrorSource = resolveResult.candidate.mirror.src;
    lastTransferError = transferOutcome.reason;
    failedMirrorLabels.push(getMirrorLabel(failedMirrorSource));
    remainingCandidates = remainingCandidates.filter(
      (candidate) => candidate.mirror.src !== failedMirrorSource
    );
  }

  return {
    status: "failed",
    reason: `download failed on ${failedMirrorLabels.join(", ")}: ${lastTransferError}`,
  };
};
