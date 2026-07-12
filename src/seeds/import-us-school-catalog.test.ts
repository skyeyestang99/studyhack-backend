import { describe, expect, it } from "vitest";
import {
  SCHOOL_ALIAS_OVERRIDES,
  schoolCatalogSearchKeys,
  scorecardSchoolToCatalogRow,
  splitScorecardAliases,
} from "./import-us-school-catalog.js";

describe("U.S. school catalog import", () => {
  it("maps College Scorecard rows into catalog rows", () => {
    expect(
      scorecardSchoolToCatalogRow({
        id: 110644,
        "school.name": "University of California-San Diego",
        "school.city": "La Jolla",
        "school.state": "CA",
        "school.alias": "UC San Diego|University of California San Diego",
      }),
    ).toEqual({
      source: "college_scorecard",
      sourceId: "110644",
      name: "University of California-San Diego",
      shortName: "UC San Diego",
      aliases: [
        "UC San Diego",
        "UCSD",
        "University of California San Diego",
        "University of California, San Diego",
      ],
      location: "La Jolla, CA",
    });
  });

  it("keeps key UC acronym overrides needed by fuzzy search", () => {
    expect(SCHOOL_ALIAS_OVERRIDES["110644"]?.aliases).toContain("UCSD");
    expect(SCHOOL_ALIAS_OVERRIDES["110662"]?.aliases).toContain("UCI");
    expect(SCHOOL_ALIAS_OVERRIDES["110680"]?.shortName).toBe("UCLA");
  });

  it("splits official alias strings from common delimiters", () => {
    expect(splitScorecardAliases("A|B; C, D")).toEqual(["A", "B", "C", "D"]);
  });

  it("builds dedupe lookup keys from name, shortName, and aliases", () => {
    expect(
      schoolCatalogSearchKeys({
        source: "college_scorecard",
        sourceId: "110662",
        name: "University of California-Irvine",
        shortName: "UC Irvine",
        aliases: ["UCI", "University of California Irvine"],
        location: "Irvine, CA",
      }),
    ).toEqual([
      "university of california-irvine",
      "uc irvine",
      "uci",
      "university of california irvine",
    ]);
  });
});
