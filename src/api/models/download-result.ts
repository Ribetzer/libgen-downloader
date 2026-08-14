export interface DownloadResult {
  path: string;
  filename: string;
  total: number;
  // True when a complete copy was already on disk and nothing was transferred.
  skipped: boolean;
}
