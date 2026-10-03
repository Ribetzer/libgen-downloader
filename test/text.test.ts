import { describe, expect, it } from "bun:test";
import { cleanText } from "../src/api/data/text";

// Every case is a real value found in the NAS queue database (2026-10-03):
// 86 rows with HTML entities, 4 with markup, 35 with runs of spaces.
describe("cleanText", () => {
  it("decodes HTML entities, named and numeric", () => {
    expect(cleanText("T&amp;I engine")).toBe("T&I engine");
    expect(cleanText("Computers &amp; Graphics")).toBe("Computers & Graphics");
    expect(cleanText("Drawing, painting &amp; stylization")).toBe(
      "Drawing, painting & stylization"
    );
    expect(cleanText("caf&#233; &#x2014; na&iuml;ve &lt;3")).toBe("café — naïve <3");
  });

  it("joins Crossref's small caps even when the layout became runs of spaces", () => {
    const raw =
      "L               <scp>EVEL</scp>               S               <scp>ET</scp>               M               <scp>ETHODS FOR</scp> fluids";
    expect(cleanText(raw)).toBe("LEVEL SET METHODS FOR fluids");
    expect(
      cleanText("Special Issue: Data-Driven Design (D               <sup>3</sup>               )")
    ).toBe("Special Issue: Data-Driven Design (D3)");
  });

  it("keeps a single space beside a tag, which is a real space", () => {
    expect(cleanText("Will GPT-4 Run <i>DOOM</i>?")).toBe("Will GPT-4 Run DOOM?");
    expect(cleanText("The <i>p</i>-Laplacian")).toBe("The p-Laplacian");
  });

  it("collapses whitespace and non-breaking spaces", () => {
    expect(cleanText("Computer Graphics Forum    2021-jul vol. 40 iss. 4 ")).toBe(
      "Computer Graphics Forum 2021-jul vol. 40 iss. 4"
    );
  });

  it("leaves text in angle brackets that is not markup", () => {
    expect(cleanText("Notes <draft> and <TODO: check>")).toBe("Notes <draft> and <TODO: check>");
    expect(cleanText("x <mml:math><mml:mi>y</mml:mi></mml:math> z")).toBe("x y z");
  });

  it("does not turn an encoded tag into markup, or touch text with no problems", () => {
    expect(cleanText("x &lt;i&gt;y&lt;/i&gt;")).toBe("x <i>y</i>");
    expect(cleanText("Plain title (2004) [10.1145/1015706.1015720]")).toBe(
      "Plain title (2004) [10.1145/1015706.1015720]"
    );
    expect(cleanText("")).toBe("");
  });
});
