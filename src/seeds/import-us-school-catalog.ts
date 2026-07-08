import { pool, withTransaction, type TxQuery } from "../db.js";
import { runMigrations } from "../migrate.js";

const SCORECARD_API_URL =
  "https://api.data.gov/ed/collegescorecard/v1/schools";
const SCORECARD_SOURCE = "college_scorecard";
const DEFAULT_PER_PAGE = 100;

interface ScorecardSchool {
  id?: number | string | null;
  "school.name"?: string | null;
  "school.city"?: string | null;
  "school.state"?: string | null;
  "school.alias"?: string | null;
  "school.operating"?: number | string | null;
}

interface ScorecardResponse {
  metadata?: {
    total?: number;
    page?: number;
    per_page?: number;
  };
  results?: ScorecardSchool[];
}

export interface SchoolCatalogRow {
  source: string;
  sourceId: string;
  name: string;
  shortName: string | null;
  aliases: string[];
  location: string | null;
}

interface AliasOverride {
  shortName?: string;
  aliases: string[];
}

export const SCHOOL_ALIAS_OVERRIDES: Record<string, AliasOverride> = {
  "110635": {
    shortName: "UC Berkeley",
    aliases: [
      "UCB",
      "Berkeley",
      "Cal",
      "University of California Berkeley",
    ],
  },
  "110653": {
    shortName: "UC Davis",
    aliases: ["UCD", "University of California Davis"],
  },
  "110662": {
    shortName: "UC Irvine",
    aliases: ["UCI", "University of California Irvine"],
  },
  "110680": {
    shortName: "UCLA",
    aliases: ["UC Los Angeles", "University of California Los Angeles"],
  },
  "445188": {
    shortName: "UC Merced",
    aliases: ["UCM", "University of California Merced"],
  },
  "110671": {
    shortName: "UC Riverside",
    aliases: ["UCR", "University of California Riverside"],
  },
  "110680_ucla_fallback": {
    shortName: "UCLA",
    aliases: ["UC Los Angeles", "University of California Los Angeles"],
  },
  "110644": {
    shortName: "UC San Diego",
    aliases: [
      "UCSD",
      "University of California, San Diego",
      "University of California San Diego",
    ],
  },
  "110699": {
    shortName: "UCSF",
    aliases: ["UC San Francisco", "University of California San Francisco"],
  },
  "110705": {
    shortName: "UC Santa Barbara",
    aliases: ["UCSB", "University of California Santa Barbara"],
  },
  "110714": {
    shortName: "UC Santa Cruz",
    aliases: ["UCSC", "University of California Santa Cruz"],
  },
  "243744": {
    shortName: "Stanford",
    aliases: ["SU"],
  },
  "166027": {
    shortName: "Harvard",
    aliases: ["HU"],
  },
  "166683": {
    shortName: "MIT",
    aliases: ["M.I.T."],
  },
  "190150": {
    shortName: "Columbia",
    aliases: ["CU"],
  },
  "215062": {
    shortName: "Penn",
    aliases: ["UPenn", "Pennsylvania"],
  },
  "186131": {
    shortName: "Princeton",
    aliases: ["PU"],
  },
  "130794": {
    shortName: "Yale",
    aliases: ["YU"],
  },
  "228778": {
    shortName: "UT Austin",
    aliases: ["UT", "Texas", "University of Texas Austin"],
  },
  "170976": {
    shortName: "Michigan",
    aliases: ["UMich", "U-M", "University of Michigan Ann Arbor"],
  },
  "145637": {
    shortName: "UIUC",
    aliases: ["Illinois", "University of Illinois Urbana-Champaign"],
  },
  "139755": {
    shortName: "Georgia Tech",
    aliases: ["GT", "Georgia Institute of Technology"],
  },
  "199120": {
    shortName: "UNC Chapel Hill",
    aliases: ["UNC", "North Carolina"],
  },
  "190415": {
    shortName: "NYU",
    aliases: ["New York U"],
  },
  "211440": {
    shortName: "CMU",
    aliases: ["Carnegie Mellon"],
  },
};

export const normalizeSchoolKey = (value: string): string =>
  value.trim().toLowerCase();

function compactStrings(values: Array<string | null | undefined>): string[] {
  return values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

export function splitScorecardAliases(value?: string | null): string[] {
  if (!value) return [];
  return compactStrings(value.split(/\s*[|;,]\s*/g));
}

function uniqueStrings(values: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const value of compactStrings(values)) {
    byKey.set(normalizeSchoolKey(value), value);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

export function scorecardSchoolToCatalogRow(
  school: ScorecardSchool,
): SchoolCatalogRow | null {
  const sourceId = school.id == null ? "" : String(school.id).trim();
  const name = school["school.name"]?.trim();
  if (!sourceId || !name) return null;

  const override = SCHOOL_ALIAS_OVERRIDES[sourceId];
  const city = school["school.city"]?.trim();
  const state = school["school.state"]?.trim();
  const location = compactStrings([city, state]).join(", ") || null;
  const aliases = uniqueStrings([
    ...splitScorecardAliases(school["school.alias"]),
    ...(override?.aliases ?? []),
  ]);

  return {
    source: SCORECARD_SOURCE,
    sourceId,
    name,
    shortName: override?.shortName ?? null,
    aliases,
    location,
  };
}

export function schoolCatalogSearchKeys(row: SchoolCatalogRow): string[] {
  return Array.from(
    new Set(
      [row.name, row.shortName, ...row.aliases]
        .filter((value): value is string => Boolean(value?.trim()))
        .map(normalizeSchoolKey),
    ),
  );
}

async function fetchScorecardPage(
  page: number,
  perPage: number,
  apiKey: string,
): Promise<ScorecardResponse> {
  const params = new URLSearchParams({
    api_key: apiKey,
    page: String(page),
    per_page: String(perPage),
    fields: [
      "id",
      "school.name",
      "school.city",
      "school.state",
      "school.alias",
      "school.operating",
    ].join(","),
    "school.operating": "1",
  });

  const response = await fetch(`${SCORECARD_API_URL}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(
      `College Scorecard request failed: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as ScorecardResponse;
}

export async function fetchScorecardCatalog(options: {
  apiKey?: string;
  perPage?: number;
  maxPages?: number;
} = {}): Promise<SchoolCatalogRow[]> {
  const apiKey = options.apiKey ?? process.env.COLLEGE_SCORECARD_API_KEY ?? "DEMO_KEY";
  const perPage = options.perPage ?? DEFAULT_PER_PAGE;
  const rows: SchoolCatalogRow[] = [];
  let page = 0;
  let total = Number.POSITIVE_INFINITY;

  while (rows.length < total) {
    if (options.maxPages != null && page >= options.maxPages) break;
    const payload = await fetchScorecardPage(page, perPage, apiKey);
    const results = payload.results ?? [];
    total = payload.metadata?.total ?? total;
    if (results.length === 0) break;

    for (const school of results) {
      const row = scorecardSchoolToCatalogRow(school);
      if (row) rows.push(row);
    }
    page += 1;
  }

  return rows;
}

export async function upsertSchoolCatalogRow(
  q: TxQuery,
  row: SchoolCatalogRow,
): Promise<"inserted" | "updated"> {
  const sourceMatch = await q<{ id: string }>(
    "SELECT id FROM schools WHERE source=$1 AND source_id=$2 LIMIT 1",
    [row.source, row.sourceId],
  );
  const existingId = sourceMatch[0]?.id
    ?? (await q<{ id: string }>(
      `SELECT id
         FROM schools
        WHERE lower(trim(name)) = ANY($1::text[])
           OR lower(trim(COALESCE(short_name, ''))) = ANY($1::text[])
           OR EXISTS (
                SELECT 1
                FROM unnest(aliases) AS alias
                WHERE lower(trim(alias)) = ANY($1::text[])
              )
        ORDER BY created_at ASC
        LIMIT 1`,
      [schoolCatalogSearchKeys(row)],
    ))[0]?.id;

  if (existingId) {
    await q(
      `UPDATE schools
          SET name = $2,
              short_name = COALESCE($3, short_name),
              location = COALESCE($4, location),
              source = $5,
              source_id = $6,
              source_updated_at = now(),
              aliases = (
                SELECT array_agg(alias ORDER BY lower(alias))
                FROM (
                  SELECT DISTINCT trim(alias) AS alias
                  FROM unnest(COALESCE(aliases, '{}') || $7::text[]) AS alias
                  WHERE trim(alias) <> ''
                ) merged
              )
        WHERE id = $1`,
      [
        existingId,
        row.name,
        row.shortName,
        row.location,
        row.source,
        row.sourceId,
        row.aliases,
      ],
    );
    return "updated";
  }

  await q(
    `INSERT INTO schools
       (name, short_name, aliases, location, source, source_id, source_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (source, source_id) DO UPDATE
       SET name = EXCLUDED.name,
           short_name = COALESCE(EXCLUDED.short_name, schools.short_name),
           location = COALESCE(EXCLUDED.location, schools.location),
           source_updated_at = now(),
           aliases = (
             SELECT array_agg(alias ORDER BY lower(alias))
             FROM (
               SELECT DISTINCT trim(alias) AS alias
               FROM unnest(COALESCE(schools.aliases, '{}') || EXCLUDED.aliases) AS alias
               WHERE trim(alias) <> ''
             ) merged
           )`,
    [
      row.name,
      row.shortName,
      row.aliases,
      row.location,
      row.source,
      row.sourceId,
    ],
  );
  return "inserted";
}

export async function importUsSchoolCatalog(
  rows: SchoolCatalogRow[],
): Promise<{ inserted: number; updated: number; total: number }> {
  return withTransaction(async (q) => {
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      const result = await upsertSchoolCatalogRow(q, row);
      if (result === "inserted") inserted += 1;
      else updated += 1;
    }
    return { inserted, updated, total: rows.length };
  });
}

export async function importUsSchoolCatalogCli(): Promise<void> {
  await runMigrations();
  const maxPages = process.env.SCHOOL_IMPORT_MAX_PAGES
    ? Number(process.env.SCHOOL_IMPORT_MAX_PAGES)
    : undefined;
  const rows = await fetchScorecardCatalog({ maxPages });
  const result = await importUsSchoolCatalog(rows);
  console.log(
    `imported U.S. school catalog from College Scorecard: ${result.inserted} inserted, ${result.updated} updated, ${result.total} total`,
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  importUsSchoolCatalogCli()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error("SCHOOL CATALOG IMPORT FAILED", error);
      await pool.end();
      process.exit(1);
    });
}
