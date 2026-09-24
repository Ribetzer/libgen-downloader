import { beforeEach } from "bun:test";
import { resetLibgenFilePacing } from "../../src/api/data/libgen-file-pacing";

// LibGen file requests are spaced 21s apart and share a cooldown at module
// scope, which would otherwise carry from one test into the next and make any
// test with a retry sit out real intervals. Tests of the pacing itself set
// their own interval.
beforeEach(() => {
  resetLibgenFilePacing(0);
});

// Wiley's TDM pacing is module-level too, and 10s apart.
beforeEach(async () => {
  const { resetWileyPacing } = await import("../../src/api/sources/wiley-tdm");
  resetWileyPacing();
});
