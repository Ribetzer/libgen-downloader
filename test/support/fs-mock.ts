import { spyOn } from "bun:test";
import fs from "node:fs";

/**
 * Stubs the rename that finishes a download.
 *
 * `downloadFile` streams into `<name>.part` and renames it to the real name
 * only once the transfer completes, so a partial never occupies the final
 * name and can be resumed instead of thrown away. Any test that stubs
 * `fs.createWriteStream` writes no bytes anywhere, so that rename would fail
 * with ENOENT and turn every successful download into an error.
 *
 * Stub the two together: they are one mechanism, not two.
 */
export const stubPartFileRename = () =>
  spyOn(fs.promises, "rename").mockImplementation(async () => {});
