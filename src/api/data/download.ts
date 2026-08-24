import contentDisposition from "content-disposition";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { DownloadResult } from "../models/download-result";
import { Mirror } from "./config";
import { buildDownloadFileName, MAX_FILE_NAME_LENGTH, withCollisionSuffix } from "./filename";
import { MirrorCandidate, resolveDownloadURL, ResolveResult } from "./resolve";
import {
  DOWNLOAD_ATTEMPT_COUNT,
  DOWNLOAD_BACKOFF_MS,
  DOWNLOAD_STALL_TIMEOUT_MS,
  DOWNLOAD_TOTAL_BUDGET_MS,
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
  /** The caller's own title, used when libgen's filename has lost it. */
  preferredTitle?: string;
  /** Overrides the stall watchdog, so a test need not wait a real minute. */
  stallTimeoutMs?: number;
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
  preferredTitle,
  stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS,
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
  const filename = buildDownloadFileName(
    parsedContentDisposition.parameters.filename,
    nameBudget,
    preferredTitle
  );

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
  // `fromWeb`, not `from`: `Readable.from` merely iterates the web stream, so
  // destroying it on a stall leaves the reader, and the socket, pending.
  // `fromWeb` owns the stream, and destroy propagates to it as a cancel.
  // The cast bridges the DOM `ReadableStream` that `fetch` returns and the
  // `node:stream/web` one `fromWeb` expects; they are the same object.
  const source = Readable.fromWeb(downloadStream.body as unknown as NodeReadableStream<Uint8Array>);

  // Destroying the source is what turns silence into an error: `pipeline`
  // rejects, the catch below removes the partial file, and the caller's retry
  // and mirror fall-through take it from there.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const restartIdleWatchdog = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      source.destroy(new Error(`no data for ${Math.round(stallTimeoutMs / 1000)}s`));
    }, stallTimeoutMs);
  };

  const progressStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buffer = Buffer.from(chunk);
      restartIdleWatchdog();
      // Absolute, not a delta: a restarted transfer must not double count.
      receivedBytes += buffer.length;
      onProgress(filename, receivedBytes, total);
      callback(undefined, buffer);
    },
  });

  try {
    restartIdleWatchdog();
    await pipeline(source, progressStream, fs.createWriteStream(targetPath));

    const downloadResult: DownloadResult = {
      path: targetPath,
      filename,
      total,
      skipped: false,
    };

    return downloadResult;
  } catch (error: unknown) {
    // The file on disk is truncated at this point and would otherwise be
    // indistinguishable from a complete download.
    await removePartialFile(targetPath);
    const reason = (error as Error)?.message || "unknown error";
    throw new Error(`(${filename}) Error occurred while downloading file: ${reason}`, {
      cause: error,
    });
  } finally {
    clearTimeout(idleTimer);
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
  preferredTitle?: string;
  throttleBackoffMs: number[];
  /**
   * Spacing between restarts, indexed by attempt and clamped at the last
   * entry. A caller wanting one flat delay passes a single-element array;
   * that is how `retryDelayMs` is honoured, and how the tests stay fast.
   */
  backoffMs: number[];
  /** Absolute time after which no further attempt is started. */
  deadline?: number;
  onStart: (filename: string, total: number) => void;
  onProgress: (filename: string, receivedBytes: number, total: number) => void;
  onRetry?: (message: string) => void;
}

const formatMegabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

/**
 * "reached 60.2 MB of 140.0 MB" - the transfer restarts from zero either way,
 * so this is the only place the abandoned progress is visible. A total of 0
 * means the server never declared one, so only the received count is known.
 */
const describeProgress = (receivedBytes: number, total: number): string => {
  if (receivedBytes <= 0) {
    return "no data received";
  }

  if (total > 0) {
    return `reached ${formatMegabytes(receivedBytes)} of ${formatMegabytes(total)}`;
  }

  return `reached ${formatMegabytes(receivedBytes)}`;
};

type TransferOutcome =
  | { status: "downloaded"; result: DownloadResult }
  | { status: "failed"; reason: string };

const transferFile = async ({
  downloadURL,
  outputDirectory,
  preferredTitle,
  throttleBackoffMs,
  backoffMs,
  deadline,
  onStart,
  onProgress,
  onRetry,
}: TransferArguments): Promise<TransferOutcome> => {
  let lastError = "unknown error";

  for (let index = 0; index < DOWNLOAD_ATTEMPT_COUNT; index++) {
    let waitMs = backoffMs[Math.min(index, backoffMs.length - 1)];
    // Each attempt starts over, so this is per-attempt, not cumulative.
    let attemptBytes = 0;
    let attemptTotal = 0;

    try {
      const downloadStream = await fetch(downloadURL);

      if (!downloadStream.ok) {
        if (THROTTLE_STATUS_CODES.has(downloadStream.status)) {
          const throttleWaitMs =
            readRetryAfterMs(downloadStream.headers.get("retry-after")) ??
            throttleBackoffMs[Math.min(index, throttleBackoffMs.length - 1)];
          waitMs = throttleWaitMs;
          throw new Error(`HTTP ${downloadStream.status} (throttled)`);
        }

        throw new Error(`HTTP ${downloadStream.status}`);
      }

      const result = await downloadFile({
        downloadStream,
        outputDirectory,
        preferredTitle,
        onStart,
        onProgress: (filename, receivedBytes, total) => {
          attemptBytes = receivedBytes;
          attemptTotal = total;
          onProgress(filename, receivedBytes, total);
        },
      });
      return { status: "downloaded", result };
    } catch (error: unknown) {
      lastError = (error as Error)?.message || "unknown error";

      if (index + 1 === DOWNLOAD_ATTEMPT_COUNT) {
        break;
      }

      // Attempts alone bound the number of tries, not how long they take. A
      // large file on a slow link can spend hours here with the queue stuck
      // behind it, so stop starting new ones once the budget is gone.
      if (deadline !== undefined && Date.now() + waitMs >= deadline) {
        lastError = `${lastError} (${describeProgress(attemptBytes, attemptTotal)}), gave up: out of time`;
        break;
      }

      if (onRetry) {
        const waitSeconds = Math.round(waitMs / 1000);
        onRetry(
          `${lastError} - ${describeProgress(attemptBytes, attemptTotal)}, ` +
            `retrying in ${waitSeconds}s (${index + 2}/${DOWNLOAD_ATTEMPT_COUNT})`
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
  preferredTitle?: string;
  onStart: (filename: string, total: number) => void;
  onProgress: (filename: string, receivedBytes: number, total: number) => void;
  onMirrorTry?: (mirrorSource: string) => void;
  onMirrorUnreachable?: (mirrorSource: string) => void;
  onRetry?: (message: string) => void;
  retryDelayMs?: number;
  throttleBackoffMs?: number[];
  backoffMs?: number[];
  /** Wall-clock ceiling for the whole MD5, across every mirror. */
  totalBudgetMs?: number;
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
  preferredTitle,
  onStart,
  onProgress,
  onMirrorTry,
  onMirrorUnreachable,
  onRetry,
  retryDelayMs,
  throttleBackoffMs = THROTTLE_BACKOFF_MS,
  backoffMs,
  totalBudgetMs = DOWNLOAD_TOTAL_BUDGET_MS,
}: DownloadByMD5Arguments): Promise<DownloadByMD5Outcome> => {
  // One spacing source, resolved once. A caller that names a single
  // `retryDelayMs` means it - collapsing it to a one-element array keeps that
  // working without a second precedence rule to get wrong.
  const effectiveBackoffMs = (() => {
    if (backoffMs) {
      return backoffMs;
    }

    if (retryDelayMs === undefined) {
      return DOWNLOAD_BACKOFF_MS;
    }

    return [retryDelayMs];
  })();
  let remainingCandidates = [...candidates];
  const failedMirrorLabels: string[] = [];
  let lastTransferError: string | undefined;
  const deadline = Date.now() + totalBudgetMs;

  for (let mirrorIndex = 0; mirrorIndex < MAX_DOWNLOAD_MIRRORS; mirrorIndex++) {
    // Checked before resolving as well as before transferring: walking a dead
    // mirror's detail pages is not free either.
    if (mirrorIndex > 0 && Date.now() >= deadline) {
      break;
    }

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
      preferredTitle,
      throttleBackoffMs,
      backoffMs: effectiveBackoffMs,
      deadline,
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
