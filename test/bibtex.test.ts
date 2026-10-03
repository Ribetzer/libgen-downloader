import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { looksLikeBibTeX, parseBibTeX } from "../src/api/data/bibtex";

// Real exports, copied from the corpus inbox (2026-10-03): of 22 such files,
// 292 entries, every one carried a DOI but two NVIDIA technical reports.
const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dir, "fixtures", "bibtex", name), "utf8");

describe("parseBibTeX", () => {
  it("reads a ScienceDirect volume export, whose DOIs are doi.org links", () => {
    const result = parseBibTeX(fixture("sciencedirect-volume.bib"));
    expect(result.entryCount).toBe(5);
    expect(result.doiList[0]).toBe("10.1016/j.gvc.2022.200059");
    expect(result.doiList).toHaveLength(5);
    expect(result.noDOI).toEqual([]);
  });

  it("reads a HAL export: upper-case fields, double braces, no final newline", () => {
    const result = parseBibTeX(fixture("hal.bib"));
    expect(result.doiList).toEqual(["10.1145/1577190.1577205"]);
  });

  it("reports an entry with no DOI by its key and title instead of dropping it", () => {
    const result = parseBibTeX(fixture("nvidia-techreport.bib"));
    expect(result.doiList).toEqual([]);
    expect(result.noDOI).toEqual([
      {
        key: "Bell:SpMV:NVIDIA:2008",
        title: "Efficient Sparse Matrix-Vector Multiplication on CUDA",
      },
    ]);
  });

  it("finds a DOI given only as a doi.org link in url or note", () => {
    const contents = [
      "@article{a, title = {A}, url = {https://doi.org/10.1145/3306346.3322962}}",
      '@misc{b, title = "B", note = "Available at https://dx.doi.org/10.1111/cgf.14362"}',
      "@article{c, title = {C}, url = {https://example.com/paper.pdf}}",
    ].join("\n");
    const result = parseBibTeX(contents);
    expect(result.doiList).toEqual(["10.1145/3306346.3322962", "10.1111/cgf.14362"]);
    expect(result.noDOI.map((entry) => entry.key)).toEqual(["c"]);
  });

  it("keeps only DOIs: a pdf link alone does not queue anything", () => {
    const result = parseBibTeX("@article{x, title = {X}, pdf = {https://hal.science/x.pdf}}");
    expect(result.doiList).toEqual([]);
    expect(result.noDOI).toHaveLength(1);
  });

  it("skips @string, @comment and @preamble, and handles quotes, bare values and nesting", () => {
    const contents = [
      "% exported by hand",
      "@string{tog = {ACM Transactions on Graphics}}",
      "@comment{jabref-meta: databaseType:bibtex;}",
      String.raw`@preamble{"\newcommand{\noop}[1]{}"}`,
      "@Article{k1,",
      "  Title   = {{Nested {braces} in a title}},",
      "  Journal = tog,",
      "  Year    = 2004,",
      '  DOI     = "10.1145/1015706.1015720",',
      "}",
      String.raw`@INPROCEEDINGS(k2, title={Parenthesised entry}, doi={10.1000/ABC\_def})`,
    ].join("\r\n");
    const result = parseBibTeX(contents);
    expect(result.entryCount).toBe(2);
    expect(result.doiList).toEqual(["10.1145/1015706.1015720", "10.1000/ABC_def"]);
  });

  it("queues a DOI once however many entries repeat it", () => {
    const contents =
      "@article{a, doi = {10.1000/x}}\n@article{b, doi = {https://doi.org/10.1000/X}}";
    expect(parseBibTeX(contents).doiList).toEqual(["10.1000/x"]);
  });
});

describe("looksLikeBibTeX", () => {
  it("recognises exports by their content, since the upload carries no file name", () => {
    expect(looksLikeBibTeX(fixture("sciencedirect-volume.bib"))).toBe(true);
    expect(looksLikeBibTeX("﻿% comment first\n\n@inproceedings{x,\n}")).toBe(true);
  });

  it("leaves MD5 and DOI lists to the existing parser", () => {
    expect(looksLikeBibTeX("b7abef3d085a1007a137a247dcff8dcb\n10.1145/1073204.1073206\n")).toBe(
      false
    );
    expect(looksLikeBibTeX("# failed downloads\n@ not an entry\n")).toBe(false);
  });
});
