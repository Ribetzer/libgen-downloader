import { describe, expect, it } from "bun:test";
import { readDispositionFilename } from "../src/api/data/download";

describe("readDispositionFilename", () => {
  it("reads a well-formed header", () => {
    expect(readDispositionFilename('attachment; filename="paper.pdf"')).toBe("paper.pdf");
  });

  it("tolerates the trailing semicolon KIT's repository sends", () => {
    expect(
      readDispositionFilename(
        'attachment; filename="Computer Graphics Forum - 2022 - Sch ler - Path Guiding.pdf";'
      )
    ).toBe("Computer Graphics Forum - 2022 - Sch ler - Path Guiding.pdf");
  });

  it("falls back to reading the name itself from a header the parser rejects", () => {
    expect(readDispositionFilename('attachment;; filename="odd.pdf" ;; x')).toBe("odd.pdf");
  });

  it("returns nothing rather than throwing for a header with no name", () => {
    expect(readDispositionFilename("inline")).toBe("");
  });
});
