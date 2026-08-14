import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";
import { useBoundStore } from "../../store";
import { DownloadStatusAndProgress } from "../../components/download-status-and-progress";
import { BulkDownloadAfterCompleteOptions } from "./bulk-download-after-complete-options";

export function BulkDownload() {
  const bulkDownloadQueue = useBoundStore((state) => state.bulkDownloadQueue);
  const isBulkDownloadComplete = useBoundStore((state) => state.isBulkDownloadComplete);
  const completedBulkDownloadItemCount = useBoundStore(
    (state) => state.completedBulkDownloadItemCount
  );
  const failedBulkDownloadItemCount = useBoundStore((state) => state.failedBulkDownloadItemCount);
  const createdMD5ListFileName = useBoundStore((state) => state.createdMD5ListFileName);
  const createdFailureListFileName = useBoundStore((state) => state.createdFailureListFileName);
  const CLIMode = useBoundStore((state) => state.CLIMode);
  const activeMirrorSource = useBoundStore((state) => state.mirror?.src);
  const outputDirectory = useBoundStore((state) => state.outputDirectory);
  const totalItemCount = bulkDownloadQueue.length;

  return (
    <Box flexDirection="column">
      <Box paddingLeft={3} flexDirection="column">
        <Text wrap="truncate-end">
          <Text color="greenBright">COMPLETED ({completedBulkDownloadItemCount}) </Text>
          <Text color="redBright">FAILED ({failedBulkDownloadItemCount}) </Text>
          <Text color="white">TOTAL ({totalItemCount})</Text>
        </Text>

        <Text color="gray">
          {createdMD5ListFileName && (
            <Text>
              MD5 list file created: <Text color="blueBright">{createdMD5ListFileName}</Text>
            </Text>
          )}
          {!createdMD5ListFileName && <InkSpinner type="simpleDotsScrolling" />}
        </Text>

        {createdFailureListFileName && (
          <Text color="gray">
            Failed downloads written to: <Text color="yellow">{createdFailureListFileName}</Text>
            <Text color="gray"> (re-run with -b to retry them)</Text>
          </Text>
        )}

        <Text color="white">
          Downloading files to <Text color="blueBright">{outputDirectory}</Text>
        </Text>

        {bulkDownloadQueue.map((item, index) => (
          <Box key={index} flexDirection="column">
            <Text wrap="truncate-end">
              <DownloadStatusAndProgress downloadProgressData={item} />
              {item.filename && (
                <Text>
                  <Text color="green">{item.filename}</Text>
                </Text>
              )}
              {!item.filename && item.md5 && (
                <Text>
                  <Text color="gray">md5: </Text>
                  <Text color="green">{item.md5}</Text>
                </Text>
              )}
              {!item.filename && !item.md5 && <Text color="gray">-</Text>}
              {!item.error && item.mirror && item.mirror !== activeMirrorSource && (
                <Text color="gray"> via {item.mirror}</Text>
              )}
            </Text>
            {/* Its own line, otherwise the md5 crowds the reason off the row. */}
            {item.error && (
              <Text wrap="truncate-end" color="gray">
                {"    "}
                {item.error}
              </Text>
            )}
          </Box>
        ))}

        {!CLIMode && isBulkDownloadComplete && <BulkDownloadAfterCompleteOptions />}
      </Box>
    </Box>
  );
}
