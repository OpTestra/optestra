import { describe, expect, it } from "vitest";
import { parseDotenv } from "./dotenv.js";

describe("parseDotenv", () => {
  it("parses the usual forms", () => {
    const text = [
      "# comment",
      "PLAIN=value # trailing comment",
      "export EXPORTED=yes",
      "SINGLE='literal # not a comment \\n'",
      'DOUBLE="line1\\nline2 \\"quoted\\""',
      'MULTI="first',
      'second"',
      "EMPTY=",
      "SPACED = padded ",
    ].join("\n");
    expect(parseDotenv(text)).toEqual({
      values: {
        PLAIN: "value",
        EXPORTED: "yes",
        SINGLE: "literal # not a comment \\n",
        DOUBLE: 'line1\nline2 "quoted"',
        MULTI: "first\nsecond",
        EMPTY: "",
        SPACED: "padded",
      },
      diagnostics: [],
    });
  });

  it("reports bad lines without throwing", () => {
    const result = parseDotenv('GOOD=1\nnot a line\nBAD="open\n', ".env.staging");
    expect(result.values).toEqual({ GOOD: "1" });
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["ENV_FILE_SYNTAX", 2],
      ["ENV_FILE_SYNTAX", 3],
    ]);
  });
});
