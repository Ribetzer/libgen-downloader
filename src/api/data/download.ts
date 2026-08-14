import contentDisposition from "content-disposition";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DownloadResult } from "../models/download-result";
import { Mirror } from "./config";
import { buildDownloadFileName, MAX_FILE_NAME_LENGTH, withCollisionSuffix } from "./filename";
import { MirrorCandidate, resolveDownloadURL, ResolveResult } from "./resolve";
import {
  DOWNLOAD_ATTEMPT_COUNT,
  DOWNLOAD_RETRY_DELAY_MS,
  MAX_DOWNLOAD_MIRRORS,
  MAX_PATH_LENGTH,
  MAX_RETRY_AFTER_MS,
  MIN_FILE_NAME_LENGTH,
  THROTTLE_BACKOFF_MS,
} from "../../settings";
import { delay } from "../../utilities";

interface downloadFileArguments {
  downloadStream: Response;
  outputDirectory: string;
  onStart: (filename: string, total: number) => void;
  onProgress: (filename: string, receivedBytes: number, total: number) => void;
}

const removePartialFile = async (filePath: string) => {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch {
    // A leftover file we cannot remove must not mask the download error.
  }
};

const statFile = async (filePath: string) => {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return;
  }
};

/**
 * Returns the path to write to, plus whether a complete copy is already there.
 * A file whose size matches `content-length` is taken as already downloaded,
 * which is what makes re-running a partially failed list cheap. Anything else
 * occupying the name is left untouched and the download gets `Name (2).ext`.
 */
const resolveTargetPath = async (outputDirectory: string, fileName: string, total: number) => {
  const candidatePath = path.join(outputDirectory, fileName);
  const existing = await statFile(candidatePath);

  if (!existing) {
    return { targetPath: candidatePath, alreadyDownloaded: false };
  }

  if (existing.isFile() && total > 0 && existing.size === total) {
    return { targetPath: candidatePath, alreadyDownloaded: true };
  }

  const MAX_COLLISION_INDEX = 99;
  for (let index = 2; index <= MAX_COLLISION_INDEX; index++) {
    const alternativePath = path.join(outputDirectory, withCollisionSuffix(fileName, index));
    if (!(await statFile(alternativePath))) {
      return { targetPath: alternativePath, alreadyDownloaded: false };
    }
  }

  return { targetPath: candidatePath, alreadyDownloaded: false };
};

export const downloadFile = async ({
  downloadStream,
  outputDirectory,
  onStart,
  onProgress,
}: downloadFileArguments): Promise<DownloadResult> => {
  const downloadContentDisposition = downloadStream.headers.get("content-disposition");
  if (!downloadContentDisposition) {
    throw new Error("No content-disposition header found");
  }

  const parsedContentDisposition = contentDisposition.parse(downloadContentDisposition);
  // Leave room for the directory so the whole path stays inside the limit.
  const nameBudget = Math.max(
    MIN_FILE_NAME_LENGTH,
    Math.min(MAX_FILE_NAME_LENGTH, MAX_PATH_LENGTH - outputDirectory.length)
  );
  const filename = buildDownloadFileName(parsedContentDisposition.parameters.filename, nameBudget);

  const total = Number(downloadStream.headers.get("content-length") || 0);

  if (!downloadStream.body) {
    throw new Error("No response body");
  }

  const { targetPath, alreadyDownloaded } = await resolveTargetPath(
    outputDirectory,
    filename,
    total
  );

  onStart(filename, total);

  if (alreadyDownloaded) {
    onProgress(filename, total, total);
    await downloadStream.body.cancel();
    return { path: targetPath, filename, total, skipped: true };
  }

  let receivedBytes = 0;
  const progressStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buffer = Buffer.from(chunk);
      // Absolute, not a delta: a restarted transfer must not double count.
      receivedBytes += buffer.length;
      onProgress(filename, receivedBytes, total);
      callback(undefined, buffer);
    },
  });

  try {
    await pipeline(
      Readable.from(downloadStream.body, { objectMode: false }),
      progressStream,
      fs.createWriteStream(targetPath)
    );

    const downloadResult: DownloadResult = {
      path: targetPath,
      filename,
      total,
      skipped: false,
    };

    return downloadResult;
  } catch {
    // The file on disk is truncated at this point and would otherwise be
    // indistinguishable from a complete download.
    await removePartialFile(targetPath);
    throw new Error(`(${filename}) Error occurred while downloading file`);
  }
};

const THROTTLE_STATUS_CODES = new Set([429, 503]);

/**
 * Reads `Retry-After` in either of its forms, capped so a hostile value cannot
 * park the queue for hours.
 */
export const readRetryAfterMs = (header: string | null): number | undefined => {
  if (!header) {
    return;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const retryAt = Date.parse(header);
  if (Number.isNaN(retryAt)) {
    return;
  }

  return Math.min(Math.max(retryAt - Date.now(), 0), MAX_RETRY_AFTER_MS);
};

interface TransferArguments {
  downloadURL: string;
  outputDirectory: string;
  retryDelayMs: number;
  throttleBackoffMs: number[];
  onStart: (filename: string, total: number) => void;
  onProgress: (filename: string, receivedBytes: number, total: number) => void;
  onRetry?: (message: string) => void;
}

type TransferOutcome =
  | { status: "downloaded"; result: DownloadResult }
  | { status: "failed"; reason: string };

const transferFile = async ({
  downloadURL,
  outputDirectory,
  retryDelayMs,
  throttleBackoffMs,
  onStart,
  onProgress,
  onRetry,
}: TransferArguments): Promise<TransferOutcome> => {
  let lastError = "unknown error";

  for (let index = 0; index < DOWNLOAD_ATTEMPT_COUNT; index++) {
    let waitMs = retryDelayMs;

    try {
      const downloadStream = await fetch(downloadURL);

      if (!downloadStream.ok) {
        if (THROTTLE_STATUS_CODES.has(downloadStream.status)) {
          const backoffMs =
            readRetryAfterMs(downloadStream.headers.get("retry-after")) ??
            throttleBackoffMs[Math.min(index, throttleBackoffMs.length - 1)];
          waitMs = backoffMs;
          throw new Error(`HTTP ${downloadStream.status} (throttled)`);
        }

        throw new Error(`HTTP ${downloadStream.status}`);
      }

      const result = await downloadFile({
        downloadStream,
        outputDirectory,
        onStart,
        onProgress,
      });
      return { status: "downloaded", result };
    } catch (error: unknown) {
      lastError = (error as Error)?.message || "unknown error";

      if (index + 1 === DOWNLOAD_ATTEMPT_COUNT) {
        break;
      }

      if (onRetry) {
        const waitSeconds = Math.round(waitMs / 1000);
        onRetry(
          `${lastError}, retrying in ${waitSeconds}s (${index + 2}/${DOWNLOAD_ATTEMPT_COUNT})`
        );
      }

      await delay(waitMs);
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
  outputDirectory: string;
  onStart: (filename: string, total: number) => void;
  onProgress: (filename: string, receivedBytes: number, total: number) => void;
  onMirrorTry?: (mirrorSource: string) => void;
  onMirrorUnreachable?: (mirrorSource: string) => void;
  onRetry?: (message: string) => void;
  retryDelayMs?: number;
  throttleBackoffMs?: number[];
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
  outputDirectory,
  onStart,
  onProgress,
  onMirrorTry,
  onMirrorUnreachable,
  onRetry,
  retryDelayMs = DOWNLOAD_RETRY_DELAY_MS,
  throttleBackoffMs = THROTTLE_BACKOFF_MS,
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
      outputDirectory,
      retryDelayMs,
      throttleBackoffMs,
      onStart,
      onProgress,
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
