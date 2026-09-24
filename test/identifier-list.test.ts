import { describe, expect, it } from "bun:test";
import { parseIdentifierList } from "../src/api/data/file";

const MD5 = "b7abef3d085a1007a137a247dcff8dcb";

describe("parseIdentifierList", () => {
  it("reads DOIs in every form they are pasted in, alongside MD5s", () => {
    const contents = [
      "﻿# a mixed list",
      MD5,
      "10.1145/1073204.1073206",
      "https://doi.org/10.1111/cgf.12271",
      "doi.org/10.2312/sr20251176",
      "dx.doi.org/10.1109/TG.2024.3497601",
      "doi:10.5281/zenodo.12068528",
      "",
    ].join("\r\n");

    const { md5List, doiList, invalidLines } = parseIdentifierList(contents);

    expect(md5List).toEqual([MD5]);
    expect(doiList).toEqual([
      "10.1145/1073204.1073206",
      "10.1111/cgf.12271",
      "10.2312/sr20251176",
      "10.1109/TG.2024.3497601",
      "10.5281/zenodo.12068528",
    ]);
    expect(invalidLines).toEqual([]);
  });

  it("takes the DOI from the first word, so a title after it is harmless", () => {
    const { doiList } = parseIdentifierList("10.1145/2366145.2366146\tSome Paper Title");

    expect(doiList).toEqual(["10.1145/2366145.2366146"]);
  });

  it("drops a DOI repeated in another case or form", () => {
    const { doiList } = parseIdentifierList(
      ["10.1111/CGF.15283", "10.1111/cgf.15283", "https://doi.org/10.1111/cgf.15283"].join("\n")
    );

    expect(doiList).toEqual(["10.1111/CGF.15283"]);
  });

  it("still reports a line that is neither", () => {
    const { md5List, doiList, invalidLines } = parseIdentifierList("clean code\n10.1080");

    expect(md5List).toEqual([]);
    expect(doiList).toEqual([]);
    expect(invalidLines).toEqual([
      { lineNumber: 1, content: "clean code" },
      { lineNumber: 2, content: "10.1080" },
    ]);
  });
});
