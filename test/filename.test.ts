import { describe, expect, it } from "bun:test";
import {
  buildDownloadFileName,
  MAX_FILE_NAME_LENGTH,
  repairEncoding,
  withCollisionSuffix,
} from "../src/api/data/filename";

// Exactly what libgen.li sent for this article during a real run.
const LIBGEN_NAME =
  "Efficiently Building a Matrix to Rotate One Vector to Another" +
  "{Moller, Tomas_ Hughes, John F.}(1999 January)" +
  "[10.1080_10867651.1999.10487509]{18014866} libgen.li.pdf";

// How a UTF-8 name looks after a header is decoded as ISO-8859-1.
const asMojibake = (value: string) => Buffer.from(value, "utf8").toString("latin1");

describe("repairEncoding", () => {
  it("recovers a UTF-8 name that was read as ISO-8859-1", () => {
    expect(repairEncoding(asMojibake("Möller, Tomas"))).toBe("Möller, Tomas");
  });

  it("leaves a plain name alone", () => {
    expect(repairEncoding("Hughes, John F.")).toBe("Hughes, John F.");
  });

  it("keeps the original when the bytes are not valid UTF-8", () => {
    const notUtf8 = `caf${String.fromCodePoint(0xe9)}`;
    expect(repairEncoding(notUtf8)).toBe(notUtf8);
  });
});

describe("buildDownloadFileName", () => {
  it("keeps the title, year and DOI from a libgen name", () => {
    expect(buildDownloadFileName(LIBGEN_NAME)).toBe(
      "Efficiently Building a Matrix to Rotate One Vector to Another (1999) " +
        "[10.1080_10867651.1999.10487509].pdf"
    );
  });

  it("drops the journal prefix so the article title survives", () => {
    // Exactly what libgen.li sent for this article during a live download.
    const journalName =
      "[Journal of Graphics Tools 2013-jan 02 vol. 17 iss. 1-2] " +
      "Fast Relabeling of Deformable Delaunay Tetrahedral Meshes Using a Compact Uniform Grid" +
      "{Frogley, D._ Jones, M. D.}(2013 January 02)" +
      "[10.1080_2165347X.2013.870057]{39124575} libgen.li.pdf";

    expect(buildDownloadFileName(journalName)).toBe(
      "Fast Relabeling of Deformable Delaunay Tetrahedral Meshes Using a Compact Uniform Grid " +
        "(2013) [10.1080_2165347X.2013.870057].pdf"
    );
  });

  it("drops a journal prefix that arrived with a leading space", () => {
    // Some names come through with one, and an anchored ^\[ then misses the
    // prefix entirely and keeps the whole thing as the title.
    const withSpace =
      " [Journal of Graphics Tools vol. 17] Real Title{Author}(2013)[10.1_2]{9}.pdf";

    expect(buildDownloadFileName(withSpace)).toBe("Real Title (2013) [10.1_2].pdf");
  });

  it("uses the caller's title when libgen truncated its own name", () => {
    // Exactly what libgen sent for the GPU Voronoi paper: the conference name
    // fills the prefix and the real title is elided to "...".
    const truncated =
      "[ACM Press the 26th annual conference - Not Known (1999..-..)] " +
      "Proceedings of the 26th annual co...{Hoff, Kenneth E._ Keyser, John...{40060 (1999).pdf";

    expect(
      buildDownloadFileName(
        truncated,
        MAX_FILE_NAME_LENGTH,
        "Fast computation of generalized Voronoi diagrams using graphics hardware"
      )
    ).toBe("Fast computation of generalized Voronoi diagrams using graphics hardware (1999).pdf");
  });

  it("keeps the year and DOI from the name even when the title is supplied", () => {
    expect(buildDownloadFileName(LIBGEN_NAME, MAX_FILE_NAME_LENGTH, "A Better Title")).toBe(
      "A Better Title (1999) [10.1080_10867651.1999.10487509].pdf"
    );
  });

  it("ignores a blank caller title rather than producing an empty name", () => {
    expect(buildDownloadFileName("simple book.epub", MAX_FILE_NAME_LENGTH, "   ")).toBe(
      "simple book.epub"
    );
  });

  it("repairs the encoding before rebuilding", () => {
    expect(buildDownloadFileName(asMojibake("Tödliche Zahlen{Autor}(2001)[10.1_2]{7}.pdf"))).toBe(
      "Tödliche Zahlen (2001) [10.1_2].pdf"
    );
  });

  it("passes through a name that carries no metadata", () => {
    expect(buildDownloadFileName("simple book.epub")).toBe("simple book.epub");
  });

  it("drops metadata groups that are absent", () => {
    expect(buildDownloadFileName("Some Title{Author}(2011){55} libgen.li.djvu")).toBe(
      "Some Title (2011).djvu"
    );
  });

  it("replaces characters Windows rejects", () => {
    expect(buildDownloadFileName('Notes: "A/B" <draft>.pdf')).toBe("Notes_ _A_B_ _draft_.pdf");
  });

  it("escapes reserved device names", () => {
    expect(buildDownloadFileName("CON.pdf")).toBe("_CON.pdf");
  });

  it("trims the end of the title and never the extension", () => {
    const longTitle = "A".repeat(300);
    const result = buildDownloadFileName(`${longTitle}(1999)[10.1_2]{3} libgen.li.pdf`, 80);

    expect(result.length).toBeLessThanOrEqual(80 + ".pdf".length);
    expect(result.startsWith("AAAA")).toBe(true);
    expect(result.endsWith("(1999) [10.1_2].pdf")).toBe(true);
  });

  it("stays within the default budget for a very long real-world name", () => {
    const result = buildDownloadFileName(`${"Long Title ".repeat(40)}(2020)[10.1_2]{9}.pdf`);

    expect(result.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH + ".pdf".length);
  });

  it("writes the caller's DOI when the source name carries none", () => {
    // The case this exists for: libgen served a 158 MB proceedings volume with
    // no identifier in its filename, so it reached the corpus anonymous and was
    // mistaken for a different volume of the same series. The queue knew the
    // DOI all along.
    const result = buildDownloadFileName(
      "Design Tools and Methods in Industrial Engineering.pdf",
      MAX_FILE_NAME_LENGTH,
      "",
      "10.1007/978-3-030-31154-4"
    );

    expect(result).toBe(
      "Design Tools and Methods in Industrial Engineering [10.1007_978-3-030-31154-4].pdf"
    );
  });

  it("prefers the DOI in the name over the caller's", () => {
    // The name describes this exact file; the caller's DOI is a fallback, and
    // a queue row can be wrong about which file a DOI resolved to.
    const result = buildDownloadFileName("Paper[10.1111/real]{9}.pdf", 120, "", "10.9999/wrong");

    expect(result).toBe("Paper [10.1111_real].pdf");
  });

  it("keeps the DOI when the title has to be trimmed to fit", () => {
    const result = buildDownloadFileName("A".repeat(300) + ".pdf", 60, "", "10.1007/x");

    expect(result.endsWith(" [10.1007_x].pdf")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(60 + ".pdf".length);
  });
});

describe("withCollisionSuffix", () => {
  it("inserts the index before the extension", () => {
    expect(withCollisionSuffix("Paper (1999) [10.1_2].pdf", 2)).toBe(
      "Paper (1999) [10.1_2] (2).pdf"
    );
  });

  it("handles a name without an extension", () => {
    expect(withCollisionSuffix("Paper", 3)).toBe("Paper (3)");
  });
});
