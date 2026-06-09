import React, { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import "./ui.css";

/** Plugin title in the embedded UI (inlined into dist/ui.html). Run `npm run build` after changing; manifest `name` should match for consistency. */
const PLUGIN_DISPLAY_NAME = "Fetchly";

const BRANDS = ["tcm", "dc", "hbo"] as const;
type SourceKey = "tcm" | "dc" | "hbo";
type BrowseStage = "select" | "detail";
type MapMode = "multi-frame" | "single-frame";
type MapDataset = "content" | "relatedVideos";

type Mapping = { 
  titleNode: string; 
  metaNode: string; 
  posterNode: string; 
};

type LayerInfo = {
  id: string;
  name: string;
  type: string;
  path?: string;
  textCapable: boolean;
  imageFillCapable: boolean;
  locked?: boolean;
};

type FieldInfo = {
  path: string;
  type: string;  // "string", "number", "array", "object"
};

// Composed text part definition (used in per-row composition)
type ComposedPart = {
  fieldPath: string;              // Data field path (e.g. "releaseYear", "title.short")
  arrayMaxItems?: number;         // Optional: max items to show for array fields (default 3)
  arraySeparator?: string;        // Optional: separator for array elements (default ", ")
  placeholder?: string;           // Optional: value to use if field is missing/empty
};

// Mapping row definition (supports single-field, image, and per-row composed text)
type MappingRow = {
  // Layer identification
  layerId?: string;
  layerName?: string;             // Stored for re-matching across designs
  kind?: "text" | "image";
  
  // Single-field mapping (mutually exclusive with composed)
  fieldPath?: string;
  join?: string;                  // For array fields in single-field mode
  truncate?: number;
  uppercase?: boolean;
  fallback?: string;
  
  // Per-row composed text mapping (optional, only for text layers)
  // If present, fieldPath is ignored for this row
  composed?: {
    parts: ComposedPart[];        // Ordered list of fields to compose
    separator: string;            // Separator between parts (default " | ")
  };
  
  // UI state (not persisted)
  isComposing?: boolean;          // Is this row's composer UI expanded?
};

// Helper: escape query values for GraphQL search
function escapeQueryValue(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim();
}

// Helper: detect if a value looks like an image URL
function isImageUrl(value?: any): boolean {
  if (typeof value !== "string") return false;
  const v = value.toLowerCase();
  return v.startsWith("http") && (
    v.endsWith(".jpg") || 
    v.endsWith(".jpeg") || 
    v.endsWith(".png") || 
    v.endsWith(".webp") || 
    v.includes("/images/") || 
    v.includes("image")
  );
}

// Helper: flatten nested object into dot-notation keys
function flatten(obj: any, prefix = "", out: Record<string, any> = {}): Record<string, any> {
  if (obj == null) return out;
  
  if (Array.isArray(obj)) {
    // For arrays of primitives, keep as array
    if (obj.length > 0 && typeof obj[0] !== "object") {
      out[prefix || "[]"] = obj;
      return out;
    }
    
    // For arrays of objects, flatten each item with index (don't keep raw array)
    obj.forEach((item, index) => {
      const key = prefix ? `${prefix}.${index}` : String(index);
      flatten(item, key, out);
    });
    
    return out;
  }
  
  if (typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      flatten(obj[k], key, out);
    }
    return out;
  }
  
  out[prefix] = obj;
  return out;
}

const PREVIEW_IMAGE_DEFAULT = "https://static.tcm.com/movie-images/default.jpg";

function isPlaceholderPreviewUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  if (!lower) return true;
  return (
    lower === PREVIEW_IMAGE_DEFAULT.toLowerCase() ||
    lower.includes("static.tcm.com/movie-images/default")
  );
}

/** http(s) src candidate; excludes known placeholder so previews can fall through to images.* */
function isUsablePreviewCandidate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return false;
  if (isPlaceholderPreviewUrl(t)) return false;
  return true;
}

/** Browse card preview only; does not affect mapping payloads. */
function getBestPreviewImageUrl(hit: any): string {
  const flat = flatten(hit);

  const direct = flat["featuredImage.imageUrl"];
  if (isUsablePreviewCandidate(direct)) return direct.trim();

  const cuts = hit?.featuredImage?.cuts;
  if (Array.isArray(cuts)) {
    for (const c of cuts) {
      const u = c?.url;
      if (isUsablePreviewCandidate(u)) return String(u).trim();
    }
  }
  for (let i = 0; i < 25; i++) {
    const u = flat[`featuredImage.cuts.${i}.url`];
    if (isUsablePreviewCandidate(u)) return u.trim();
  }

  const orderedKeys = [
    "images.3x2",
    "images.16x9",
    "images.original",
    "images.2x3",
    "images.1x1",
    "images.1280",
    "images.640",
    "images.320",
    "images.324_poster_v2",
    "images.1280_v2",
    "images.640_v2",
    "images.320_v2",
  ];
  for (const k of orderedKeys) {
    const u = flat[k];
    if (isUsablePreviewCandidate(u)) return u.trim();
  }

  for (const key of Object.keys(flat).sort()) {
    if (!key.startsWith("images.")) continue;
    const u = flat[key];
    if (isUsablePreviewCandidate(u)) return u.trim();
  }

  console.warn("[Preview] No usable image; using default for feature", hit?.id);
  return PREVIEW_IMAGE_DEFAULT;
}

/** ===== Proxy URL =====
 *  Change this to your deployed Vercel URL, e.g.:
 *  https://<your-project>.vercel.app/api/graphql
 *  For local testing with `vercel dev`, use:
 *  http://localhost:3000/api/graphql
 */
// const DEFAULT_PROXY_URL = "http://localhost:3000/api/graphql"; // Testing locally
const DEFAULT_PROXY_URL = "https://figma-plugin-poc.vercel.app/api/graphql"; // QA endpoint (PROD requires auth)

// Optional: allow ?proxy=http://localhost:3000/api/graphql for quick switching
const PROXY_URL =
  new URLSearchParams(location.search).get("proxy") || DEFAULT_PROXY_URL;

/** Shared Feature selection for featureScroll, title search, and live browse (field parity). */
const FEATURE_SELECTION_GQL = `
      id
      titleId
      title { short full }
      summary { short full }
      releaseYear
      ratingCode
      mpaaRatingCode
      contentAdvisories
      runtime
      runtimeDisplay
      runtimeFormatted(format: "h[h] m[m]")
      genres
      images
      featuredImage {
        imageUrl
        alt
        cuts(
          sizes: ["3:2"]
          fallbackMap: "images"
        ) {
          size
          url
        }
      }
      pageAlias { pagePath }
      offeringDates { startDate endDate }
      castAndCrew {
        Cast {
          role { firstName lastName }
          person { firstName lastName }
        }
        Director { person { firstName lastName } }
        Writer { person { firstName lastName } }
        Producer { person { firstName lastName } }
        ExecutiveProducer { person { firstName lastName } }
        Crew { person { firstName lastName } }
      }
`;

const GQL = `
query FeatureGrid($brand: String!, $size: Int = 24, $scrollId: String) {
  featureScroll(brand: $brand, size: $size, scrollId: $scrollId) {
    hits {
${FEATURE_SELECTION_GQL}
    }
    scrollId
  }
}
`;

// Search query for content items with hardened wildcard matching
function buildSearchQuery(brand: string, searchTerm: string, start: number = 0, count: number = 50): string {
  const safeBrand = brand.toLowerCase();
  
  // Sanitize search term:
  // 1. Escape quotes and backslashes
  let safeTerm = escapeQueryValue(searchTerm);
  
  // 2. Remove user-typed asterisks to prevent query syntax injection
  safeTerm = safeTerm.replace(/\*/g, "");
  
  // 3. Trim and collapse whitespace
  safeTerm = safeTerm.trim().replace(/\s+/g, " ");
  
  // 4. Convert internal spaces to wildcards for multi-word partial matching
  // "big sleep" becomes "big*sleep"
  safeTerm = safeTerm.replace(/ /g, "*");
  
  // 5. Wrap with wildcards for partial matching
  // "big*sleep" becomes "*big*sleep*"
  const wildcardTerm = `*${safeTerm}*`;
  
  // Build query string with wildcard term
  const queryString = `type:feature AND brand:${safeBrand} AND title.short:${wildcardTerm}`;
  
  console.log('[Search] Final queryString:', queryString);
  
  const query = `
query SearchContent {
  search(
    queryString: "${queryString}"
    start: ${start}
    count: ${count}
    allowUnpublishedContent: false
  ) {
    ... on Feature {
${FEATURE_SELECTION_GQL}
    }
  }
}`;
  
  return query;
}

/** Live browse: production-aligned availability windows on search index (literal queryString). */
function buildLiveBrowseQuery(brand: string, start: number = 0, count: number = 24): string {
  const safeBrand = brand.toLowerCase();
  const queryString = `type:feature AND brand:${safeBrand} AND offeringDates.startDate:[* TO now] AND offeringDates.endDate:[now TO *]`;
  console.log("[LiveBrowse] queryString:", queryString);
  return `
query LiveBrowse {
  search(
    queryString: "${queryString}"
    start: ${start}
    count: ${count}
    sort: { field: "offeringDates.startDate", order: desc }
    allowUnpublishedContent: false
  ) {
    ... on Feature {
${FEATURE_SELECTION_GQL}
    }
  }
}`;
}

// Helper: Build related videos query dynamically (no templating)
// Uses references.handle.gepContentId (confirmed working in QA playground)
function buildReferencedVideosQuery(brand: string, contentId: string, excludeHost = false): string {
  // Guard against empty/missing content ID
  if (!contentId || contentId.trim() === '') {
    throw new Error('Content ID is required for related videos query');
  }
  
  // Ensure brand is lowercase and escape content ID quotes
  const safeBrand = brand.toLowerCase();
  const safeContentId = contentId.replace(/"/g, '\\"');
  
  // Build queryString with proper field path: references.handle.gepContentId
  let queryString = `type:video AND brand:${safeBrand} AND references.handle.gepContentId:\\"${safeContentId}\\"`;
  
  // Optional: exclude Host videos
  if (excludeHost) {
    queryString += ' AND !(videoType:Host)';
  }
  
  // Return complete query with embedded literal queryString
  return `
query getReferencedVideosByContentId {
  search(
    queryString: "${queryString}"
    count: 20
    sort: { field: "lifecycle.date.firstPublishedDate", order: desc }
    allowUnpublishedContent: false
  ) {
    ... on Video {
      title { short }
      summary { short full }
      videoType
      lifecycle { 
        date { 
          firstPublishedDate
          firstPublishedDateFormatted(format: "MMM YYYY")
        } 
      }
      featuredVideo { videoUrl videoDurationFormatted(format: "mm:ss") }
      featuredImage { cuts(sizes: ["3:2"]) { size url } }
    }
  }
}`;
}

// Helper: Build test videos query dynamically (no templating)
function buildTestVideosQuery(brand: string): string {
  const safeBrand = brand.toLowerCase();
  return `
query testVideoSearch {
  search(
    queryString: "type:video AND brand:${safeBrand}"
    count: 5
    allowUnpublishedContent: false
  ) {
    ... on Video {
      id
      title { short }
      videoType
    }
  }
}`;
}

type Hit = {
  id: string;
  titleId?: string;
  title?: { short?: string; full?: string };
  summary?: { short?: string; full?: string } | null;
  releaseYear?: number | null;
  runtime?: string | number | null;
  runtimeDisplay?: string | null;
  runtimeFormatted?: string | null;
  genres?: string[] | null;
  contentAdvisories?: string[] | null;
  ratingCode?: string | null;
  mpaaRatingCode?: string | null;
  featuredImage?: {
    imageUrl?: string | null;
    alt?: string | null;
    cuts?: Array<{ size?: string | null; url?: string | null }> | null;
  } | null;
  images?: Record<string, string> | null;
  pageAlias?: { pagePath?: string | null } | null;
  offeringDates?: { startDate?: string | null; endDate?: string | null } | null;
  _derived?: { genres?: string[]; [key: string]: any };
};

const parseSecs = (val?: string | number | null) => {
  if (val == null) return undefined;
  const s = typeof val === "string" ? parseInt(val, 10) : val;
  if (Number.isNaN(s)) return undefined;
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

// Helper: format person name safely
function formatPersonName(person?: { firstName?: string | null; lastName?: string | null } | null): string | null {
  if (!person) return null;
  const first = person.firstName?.trim() || "";
  const last = person.lastName?.trim() || "";
  if (!first && !last) return null;
  return `${first} ${last}`.trim();
}

// Helper: get unique names from list, filtering out nulls
function uniqueNames(names: (string | null)[]): string[] {
  const unique = new Set<string>();
  names.forEach(name => {
    if (name) unique.add(name);
  });
  return Array.from(unique);
}

// Helper: join names with comma separator
function joinNames(names: (string | null)[]): string {
  return uniqueNames(names).join(", ");
}

// Helper: format cast member with role (e.g., "Humphrey Bogart (Rick)")
function formatCastMember(castMember?: { person?: any; role?: any } | null): string | null {
  if (!castMember) return null;
  
  const personName = formatPersonName(castMember.person);
  if (!personName) return null;
  
  // Try to get role name
  const roleName = castMember.role?.firstName || castMember.role?.lastName || "";
  
  if (roleName) {
    return `${personName} (${roleName})`;
  }
  
  return personName;
}

// Helper: format list of people with optional truncation
function formatPeopleList(people: (string | null)[], max: number = 3): string {
  const validPeople = people.filter(p => p != null && p !== "");
  
  if (validPeople.length === 0) return "";
  if (validPeople.length <= max) return validPeople.join(", ");
  
  const shown = validPeople.slice(0, max);
  const remaining = validPeople.length - max;
  return `${shown.join(", ")} +${remaining} more`;
}

// Helper: safely get value by nested path (e.g., "title.short")
function getValueByPath(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  
  const segments = path.split('.');
  let current = obj;
  
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = current[segment];
  }
  
  return current;
}

// Helper: format scalar value to string
function formatScalarValue(value: any): string | undefined {
  // Null/undefined -> missing
  if (value == null) return undefined;
  
  // Empty string -> missing
  if (value === "") return undefined;
  
  // Boolean -> string
  if (typeof value === "boolean") return String(value);
  
  // Number -> string (including 0)
  if (typeof value === "number") return String(value);
  
  // String -> return as-is (already filtered empty above)
  if (typeof value === "string") return value;
  
  // Other types -> undefined (will be handled as missing)
  return undefined;
}

// Helper: format array value to string
function formatArrayValue(arr: any[], maxItems?: number, joinSep?: string): string | undefined {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  
  const max = maxItems ?? 3;
  const sep = joinSep ?? ", ";
  
  // Take first N items
  const items = arr.slice(0, max);
  
  // Map each item to string
  const strings = items.map(item => {
    // If scalar, use formatScalarValue
    if (item == null || typeof item !== 'object') {
      return formatScalarValue(item);
    }
    
    // If object, try common shapes
    if (item.short) return String(item.short);
    if (item.full) return String(item.full);
    if (item.name) return String(item.name);
    if (item.label) return String(item.label);
    
    // Last resort: JSON.stringify
    try {
      return JSON.stringify(item);
    } catch {
      return undefined;
    }
  }).filter(s => s != null && s !== "");
  
  if (strings.length === 0) return undefined;
  
  return strings.join(sep);
}

// Helper: compose multiple fields into one string
// 
// Separator behavior:
// - fieldSeparator (global): joins DIFFERENT FIELDS together (e.g., " | " between year, runtime, genres)
// - joinSep (per-field): joins ARRAY ELEMENTS within a single field (e.g., ", " between genre values)
// 
// Example: releaseYear=" | "runtimeDisplay=" | "genres(join=", ")
// Result: "1942 | 1 hr 30 min | Drama, Comedy"
//         ^^^^^  ^^^^  ^^^^^^^^^^^^^  ^^^^^^ ^^^^^^
//         field1  sep  field2          sep    array elements joined with ", "
//
// Skip vs Placeholder:
// - If field is missing/empty AND placeholder is set → use placeholder
// - If field is missing/empty AND no placeholder → skip field entirely (no separator added)
function composeFields(item: any, parts: ComposedPart[], fieldSeparator: string): string {
  const fieldValues: string[] = [];
  
  for (const part of parts) {
    // Get value by path
    const value = getValueByPath(item, part.fieldPath);
    
    let formatted: string | undefined;
    
    // Handle array fields (use part.arraySeparator to join array elements)
    // Detection: check if actual value is an array
    if (Array.isArray(value)) {
      formatted = formatArrayValue(
        value,
        part.arrayMaxItems,
        part.arraySeparator // Array element separator (within this field)
      );
    } else {
      // Handle scalar fields
      formatted = formatScalarValue(value);
    }
    
    // Handle missing values (placeholder vs skip)
    if (formatted == null || formatted === "") {
      // Use placeholder if provided, otherwise skip
      if (part.placeholder && part.placeholder !== "") {
        fieldValues.push(part.placeholder);
      }
      // If no placeholder, skip (don't add anything)
    } else {
      fieldValues.push(formatted);
    }
  }
  
  // Join with global field separator (between different fields)
  return fieldValues.join(fieldSeparator);
}

// Helper: Build composed text from a data item using per-row composition config
// This is the entry point for per-row composed text mapping (used in applyMapping)
function buildComposedText(hit: any, composedConfig: { parts: ComposedPart[]; separator: string }): string {
  // Guard: if no parts, return empty string
  if (!composedConfig.parts || composedConfig.parts.length === 0) {
    return "";
  }
  
  // Use existing composeFields helper with new config structure
  return composeFields(hit, composedConfig.parts, composedConfig.separator);
}

// Helper: normalize genres field to string array
function normalizeGenres(genres?: any): string[] {
  if (!genres) return [];
  
  // If already an array
  if (Array.isArray(genres)) {
    return genres
      .map(g => {
        // Handle array of strings
        if (typeof g === "string") return g.trim();
        // Handle array of objects with name/label
        if (typeof g === "object" && g !== null) {
          return g.name || g.label || "";
        }
        return "";
      })
      .filter(g => g.length > 0);
  }
  
  // If string, split by common delimiters
  if (typeof genres === "string") {
    return genres.split(/[,;|]/).map(g => g.trim()).filter(g => g.length > 0);
  }
  
  return [];
}

// Helper: extract unique genres from hits
function getUniqueGenres(hits: Hit[]): string[] {
  const genreSet = new Set<string>();
  
  hits.forEach(hit => {
    const normalized = normalizeGenres(hit.genres);
    normalized.forEach(g => genreSet.add(g));
  });
  
  const genres = Array.from(genreSet);
  genres.sort((a, b) => a.localeCompare(b));
  return genres;
}

// Helper: extract best title from Hit
function extractTitle(hit: Hit): string {
  return (hit.title?.short || hit.title?.full || "").trim();
}

// Helper: sort content items by selected order (stable, null-safe)
function sortHits(hits: Hit[], order: "default" | "title-asc" | "title-desc" | "year-asc" | "year-desc"): Hit[] {
  if (order === "default") {
    return hits; // Preserve incoming order (no copy needed)
  }
  
  // Create a copy to avoid mutating original
  const sorted = [...hits];
  
  if (order === "title-asc" || order === "title-desc") {
    sorted.sort((a, b) => {
      const titleA = extractTitle(a).toLowerCase();
      const titleB = extractTitle(b).toLowerCase();
      
      // Handle empty titles (push to end)
      if (!titleA && !titleB) return 0;
      if (!titleA) return 1;
      if (!titleB) return -1;
      
      const comparison = titleA.localeCompare(titleB);
      return order === "title-asc" ? comparison : -comparison;
    });
  } else if (order === "year-asc" || order === "year-desc") {
    sorted.sort((a, b) => {
      const yearA = a.releaseYear;
      const yearB = b.releaseYear;
      
      // Push nulls to bottom for both ascending and descending
      if (yearA == null && yearB == null) return 0;
      if (yearA == null) return 1;
      if (yearB == null) return -1;
      
      const comparison = yearA - yearB;
      return order === "year-asc" ? comparison : -comparison;
    });
  }
  
  return sorted;
}

// Helper: derive cast/crew strings from castAndCrew object
function deriveCastAndCrew(castAndCrew?: any) {
  if (!castAndCrew) {
    return {
      director: "",
      writer: "",
      producer: "",
      executiveProducer: "",
      cast: "",
      castFull: "",
      crew: ""
    };
  }
  
  // Directors (full list)
  const directorList = castAndCrew.Director 
    ? castAndCrew.Director.map((d: any) => formatPersonName(d?.person)).filter((n: any) => n)
    : [];
  const director = directorList.join(", ");
  
  // Writers (full list)
  const writerList = castAndCrew.Writer
    ? castAndCrew.Writer.map((w: any) => formatPersonName(w?.person)).filter((n: any) => n)
    : [];
  const writer = writerList.join(", ");
  
  // Producers (full list)
  const producerList = castAndCrew.Producer
    ? castAndCrew.Producer.map((p: any) => formatPersonName(p?.person)).filter((n: any) => n)
    : [];
  const producer = producerList.join(", ");
  
  // Executive Producers (full list)
  const executiveProducerList = castAndCrew.ExecutiveProducer
    ? castAndCrew.ExecutiveProducer.map((ep: any) => formatPersonName(ep?.person)).filter((n: any) => n)
    : [];
  const executiveProducer = executiveProducerList.join(", ");
  
  // Cast with roles (e.g., "Humphrey Bogart (Rick), Ingrid Bergman (Ilsa)")
  const castList = castAndCrew.Cast
    ? castAndCrew.Cast.map((c: any) => formatCastMember(c)).filter((n: any) => n)
    : [];
  const castFull = castList.join(", ");
  const cast = formatPeopleList(castList, 3); // Truncated to 3 for UI
  
  // Crew (if available)
  const crewList = castAndCrew.Crew
    ? castAndCrew.Crew.map((c: any) => formatPersonName(c?.person)).filter((n: any) => n)
    : [];
  const crew = crewList.join(", ");
  
  return {
    director,
    writer,
    producer,
    executiveProducer,
    cast,
    castFull,
    crew
  };
}

/** One enrichment path for Feature rows from scroll, catalog search, or live browse. */
function enrichFeatureHit(hit: Hit): Hit {
  const derived = deriveCastAndCrew((hit as any).castAndCrew);
  const genresNormalized = normalizeGenres(hit.genres);
  return {
    ...hit,
    genres: genresNormalized,
    _derived: { ...derived, genres: genresNormalized },
  } as Hit;
}

function enrichFeatureHits(hits: Hit[]): Hit[] {
  return hits.map(enrichFeatureHit);
}

// Helper: extractors for cast/crew (convenience functions)
function getDirectors(hit: any): string {
  return hit._derived?.director || "";
}

function getWriters(hit: any): string {
  return hit._derived?.writer || "";
}

function getProducers(hit: any): string {
  return hit._derived?.producer || "";
}

function getExecutiveProducers(hit: any): string {
  return hit._derived?.executiveProducer || "";
}

function getCast(hit: any): string {
  return hit._derived?.cast || "";
}

function getCastFull(hit: any): string {
  return hit._derived?.castFull || "";
}

function getCrew(hit: any): string {
  return hit._derived?.crew || "";
}

function getGenres(hit: any): string[] {
  return hit._derived?.genres || [];
}

function normalize(h: Hit, brand: string) {
  const title = (h.title && (h.title.short || h.title.full)) || "";
  const advisory =
    (h.contentAdvisories && h.contentAdvisories[0]) ||
    h.ratingCode ||
    h.mpaaRatingCode ||
    undefined;
  const images = h.images || {};
  
  // Debug: Log available image fields (only if no images found) - commented out to reduce noise
  // if (title && !h.featuredImage?.imageUrl && Object.keys(images).length === 0) {
  //   console.log(`[${brand}] No images found for "${title}"`);
  // }
  
  const imageUrl =
    (h.featuredImage && h.featuredImage.imageUrl) ||
    (h.featuredImage?.cuts && h.featuredImage.cuts[0]?.url) ||
    (images as any).original ||
    (images as any)["3x2"] ||
    (images as any)["16x9"] ||
    (images as any)["2x3"] ||
    (images as any)["1x1"];
  const runtimeDisplay =
    h.runtimeFormatted || h.runtimeDisplay || parseSecs(h.runtime);

  // Derive cast/crew strings
  const derived = deriveCastAndCrew((h as any).castAndCrew);

  return {
    id: h.id,
    title,
    year: h.releaseYear == null ? undefined : h.releaseYear,
    genres: (h.genres || []).slice(0, 2),
    advisory,
    runtimeDisplay,
    imageUrl,
    brand, // Include brand for placeholder colors
    _derived: derived, // Add derived cast/crew fields
  };
}

// ---- GraphQL fetch with timeout and friendlier errors ----
async function runQuery(brand: string, size: number, scrollId?: string) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000); // 12s timeout

  // Build variables object, only include scrollId if it's defined
  const variables: any = { 
    brand, 
    size,
    _cacheBust: Date.now() // Force fresh data by adding timestamp
  };
  if (scrollId) {
    variables.scrollId = scrollId;
  }

  let res: Response;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
        // Cache-Control headers removed - causing CORS issues
      },
      body: JSON.stringify({ 
        query: GQL, 
        variables 
      }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(t);
    if (e && e.name === "AbortError") throw new Error("Request timed out");
    throw new Error((e && e.message) || "Network error");
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Proxy ${res.status}: ${text || res.statusText}`);
  }

  const json = await res.json().catch(() => ({}));
  if (json.errors && json.errors.length) {
    const msg = (json.errors[0] && json.errors[0].message) || "GraphQL error";
    throw new Error(msg);
  }

  const result = (json.data && json.data.featureScroll
    ? json.data.featureScroll
    : { hits: [], scrollId: undefined }) as { hits: Hit[]; scrollId?: string };

  result.hits = enrichFeatureHits(result.hits || []);

  return result;
}

async function runLiveBrowseQuery(brand: string, start: number = 0, count: number = 24): Promise<Hit[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  const query = buildLiveBrowseQuery(brand, start, count);

  let res: Response;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(t);
    if (e && e.name === "AbortError") throw new Error("Request timed out");
    throw new Error((e && e.message) || "Network error");
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Proxy ${res.status}: ${text || res.statusText}`);
  }

  const json = await res.json().catch(() => ({}));
  if (json.errors && json.errors.length) {
    const msg = (json.errors[0] && json.errors[0].message) || "GraphQL error";
    throw new Error(msg);
  }

  const raw = (json.data && json.data.search ? json.data.search : []) as Hit[];
  console.log("[LiveBrowse] items:", raw.length);
  return enrichFeatureHits(raw);
}

// ---- Search for content items using GraphQL search endpoint ----
async function runSearchQuery(brand: string, searchTerm: string, start: number = 0, count: number = 50): Promise<Hit[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000); // 12s timeout

  const trimmedTerm = searchTerm.trim();
  
  // Validate search term (minimum 2 characters to avoid noisy broad searches)
  if (!trimmedTerm || trimmedTerm.length < 2) {
    return [];
  }

  const query = buildSearchQuery(brand, trimmedTerm, start, count);

  let res: Response;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(t);
    if (e && e.name === "AbortError") throw new Error("Request timed out");
    throw new Error((e && e.message) || "Network error");
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error('[Search API] HTTP Error:', res.status, text);
    throw new Error(`Search failed (${res.status}): ${text || res.statusText}`);
  }

  const json = await res.json().catch(() => ({}));
  
  console.log('[Search API] Response for term "%s" (start=%d, count=%d):', searchTerm, start, count);
  console.log('[Search API] Results count:', json.data?.search?.length || 0);
  
  if (json.errors && json.errors.length) {
    const msg = (json.errors[0] && json.errors[0].message) || "GraphQL error";
    console.error('[Search API] GraphQL errors:', json.errors);
    throw new Error(msg);
  }

  const results = (json.data && json.data.search) ? json.data.search : [];
  console.log('[Search API] Extracted results:', results);

  return enrichFeatureHits(results as Hit[]);
}

// ---- Fetch referenced videos by content ID ----
async function runReferencedVideos(brand: SourceKey, contentId: string, excludeHost: boolean): Promise<any[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000); // 12s timeout

  // Guard: Validate content ID
  if (!contentId || contentId.trim() === '') {
    throw new Error('Content ID is required for fetching related videos');
  }

  // Build query dynamically (no templating/variables)
  let query: string;
  try {
    query = buildReferencedVideosQuery(brand, contentId, excludeHost);
  } catch (e: any) {
    throw new Error(`Failed to build query: ${e.message}`);
  }
  
  console.log('[Related Videos API] Brand:', brand.toLowerCase());
  console.log('[Related Videos API] Content ID:', contentId);
  console.log('[Related Videos API] Query preview:', query.substring(0, 300) + '...');

  let res: Response;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        query,
        // No variables - query is fully embedded
      }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(t);
    if (e && e.name === "AbortError") throw new Error("Request timed out");
    throw new Error((e && e.message) || "Network error");
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Proxy ${res.status}: ${text || res.statusText}`);
  }

  const json = await res.json().catch(() => ({}));
  
  console.log('[Related Videos API] Raw response:', json);
  console.log('[Related Videos API] Response data:', JSON.stringify(json.data, null, 2));
  
  if (json.errors && json.errors.length) {
    const msg = (json.errors[0] && json.errors[0].message) || "GraphQL error";
    console.error('[Related Videos API] GraphQL errors:', json.errors);
    throw new Error(msg);
  }

  // Extract search results from response
  const results = (json.data && json.data.search) ? json.data.search : [];
  console.log('[Related Videos API] Extracted results:', results);
  console.log('[Related Videos API] Results count:', results.length);
  
  // Debug: Try alternate response paths
  if (results.length === 0) {
    console.warn('[Related Videos API] No results found. Checking alternate response structures...');
    console.log('[Related Videos API] json.data keys:', Object.keys(json.data || {}));
    console.log('[Related Videos API] json.data.search:', json.data?.search);
  }
  
  return results;
}

// ---- Test query to verify search endpoint works ----
async function runTestVideoQuery(brand: SourceKey): Promise<any[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);

  // Build query dynamically (no templating/variables)
  const query = buildTestVideosQuery(brand);

  let res: Response;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        query,
        // No variables - query is fully embedded
      }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(t);
    if (e && e.name === "AbortError") throw new Error("Request timed out");
    throw new Error((e && e.message) || "Network error");
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Proxy ${res.status}: ${text || res.statusText}`);
  }

  const json = await res.json().catch(() => ({}));
  return (json.data && json.data.search) ? json.data.search : [];
}

function App() {
  // Tab state
  const [activeTab, setActiveTab] = useState<"browse" | "map">("browse");
  
  // Browse tab state
  const [browseStage, setBrowseStage] = useState<BrowseStage>("select");
  const [selectedSource, setSelectedSource] = useState<SourceKey | undefined>(undefined);
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Search state
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [searchResults, setSearchResults] = useState<Hit[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searchStart, setSearchStart] = useState<number>(0);
  const [searchHasMore, setSearchHasMore] = useState<boolean>(false);
  const [searchCount] = useState<number>(50); // Results per page
  
  // Sorting state
  const [sortOrder, setSortOrder] = useState<"default" | "title-asc" | "title-desc" | "year-asc" | "year-desc">("default");
  
  // Genre filter state
  const [selectedGenre, setSelectedGenre] = useState<string>("");

  // Related videos state (per content ID + excludeHost composite key)
  const [relatedById, setRelatedById] = useState<Record<string, any[]>>({});
  const [relatedLoadingById, setRelatedLoadingById] = useState<Record<string, boolean>>({});
  const [relatedErrById, setRelatedErrById] = useState<Record<string, string | null>>({});
  const [relatedOpenById, setRelatedOpenById] = useState<Record<string, boolean>>({}); // Keyed by contentId only
  
  // Use ref for race condition guard (synchronous, no closure issues)
  const relatedReqByKey = useRef<Record<string, number>>({});
  const searchReqIdRef = useRef<number>(0);

  // Active content context (for Map tab to know which content's videos to use)
  const [activeContentId, setActiveContentId] = useState<string | null>(null);
  const [activeContentTitle, setActiveContentTitle] = useState<string | null>(null);

  // Track which items have "Show raw fields" expanded
  const [showRawFieldsById, setShowRawFieldsById] = useState<Record<string, boolean>>({});
  
  // Exclude Host videos toggle (affects related videos only)
  const [excludeHost, setExcludeHost] = useState<boolean>(false);
  
  // Video type filtering (client-side only, applied after excludeHost)
  const [relatedAllTypes, setRelatedAllTypes] = useState<boolean>(true);
  const [relatedSelectedTypes, setRelatedSelectedTypes] = useState<string[]>([]);
  
  // Helper: Generate composite key for related videos cache
  const getRelatedKey = (contentId: string, excludeHost: boolean) => `${contentId}|excludeHost=${excludeHost}`;

  // Map tab state
  const [mapDataset, setMapDataset] = useState<MapDataset>("content");
  const [mapMode, setMapMode] = useState<MapMode>("multi-frame");
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [mappingRows, setMappingRows] = useState<MappingRow[]>([]);
  const [offset, setOffset] = useState<number>(0);
  const [count, setCount] = useState<number>(0);
  const [mappingSaved, setMappingSaved] = useState<boolean>(false);
  const [autoRefreshDisabled, setAutoRefreshDisabled] = useState<boolean>(false);
  const [isCreatingMapping, setIsCreatingMapping] = useState<boolean>(false);
  
  // Legacy state (remove after migration)
  const [mapping, setMapping] = useState<Mapping>({ 
    titleNode: "Title", 
    metaNode: "Meta", 
    posterNode: "Poster" 
  });

  // Listen for responses from main thread
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const m = e.data?.pluginMessage;
      if (!m) return;
      
      if (m.type === "SELECTION_INTROSPECTED" && m.layers) {
        // Always update the layers list
        setLayers(m.layers);
        
        // If we have saved mapping rows, handle re-matching
        if (mappingSaved && mappingRows.length > 0 && !autoRefreshDisabled) {
          const updatedRows = mappingRows.map(row => {
            // If row has layerName, use it to re-match
            if (row.layerName) {
              const matchedLayer = m.layers.find((l: LayerInfo) => l.name === row.layerName);
              if (matchedLayer) {
                return { ...row, layerId: matchedLayer.id };
              }
            }
            // Backwards compatibility: if old mapping has layerId but no layerName
            else if (row.layerId) {
              const matchedLayer = m.layers.find((l: LayerInfo) => l.id === row.layerId);
              if (matchedLayer) {
                return { ...row, layerId: matchedLayer.id, layerName: matchedLayer.name };
              }
            }
            return row;
          });
          setMappingRows(updatedRows);
          setAutoRefreshDisabled(true); // Lock it after re-matching
        }
      }
      
      if (m.type === "MAPPING_SAVED" && m.brand) {
        setMappingSaved(true);
      }
      
      if (m.type === "MAPPING_LOADED" && m.mapping && m.brand === selectedSource) {
        // Load saved mapping rows
        if (m.mapping.rows && Array.isArray(m.mapping.rows) && m.mapping.rows.length > 0) {
          // Store the raw saved rows (with old layer IDs)
          // We'll re-match layer IDs when layers are introspected
          setMappingRows(m.mapping.rows);
          setMappingSaved(true);
          setAutoRefreshDisabled(false); // Enable auto-refresh to get current layers
          setIsCreatingMapping(false); // Not in creation mode if we have saved mappings
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [autoRefreshDisabled, selectedSource]);
  
  // Introspect selection and load mapping when entering Map tab
  useEffect(() => {
    if (activeTab === "map" && selectedSource) {
      // Load saved mapping for this brand
      parent.postMessage({ pluginMessage: { type: "LOAD_MAPPING_ROWS", brand: selectedSource } }, "*");
      
      // Introspect selection (only updates if auto-refresh not disabled)
      parent.postMessage({ pluginMessage: { type: "INTROSPECT_SELECTION" } }, "*");
    }
  }, [activeTab, selectedSource]);
  
  // Clear mappings and related videos when disconnecting from a brand (back arrow clicked)
  useEffect(() => {
    if (browseStage === "select") {
      // Reset all mapping state
      setMappingRows([]);
      setMappingSaved(false);
      setAutoRefreshDisabled(false);
      setIsCreatingMapping(false);
      setLayers([]);
      
      // Reset related videos state
      setRelatedById({});
      setRelatedLoadingById({});
      setRelatedErrById({});
      setRelatedOpenById({});
      setActiveContentId(null);
      setActiveContentTitle(null);
      setShowRawFieldsById({});
      setMapDataset("content"); // Reset to content
      
      // Reset video type filter
      setRelatedAllTypes(true);
      setRelatedSelectedTypes([]);
      
      // Reset search state
      setSearchTerm("");
      setSearchResults([]);
      setSearchErr(null);
      setSearchStart(0);
      setSearchHasMore(false);
      
      // Reset sort order
      setSortOrder("default");
      
      // Reset genre filter
      setSelectedGenre("");
    }
  }, [browseStage]);
  
  // Refetch related videos when excludeHost toggle changes for currently open content
  useEffect(() => {
    // Only run when excludeHost changes, not on initial mount or activeContentId change
    if (!selectedSource || !activeContentId) return;
    
    // Only refetch if this content is currently open
    if (!relatedOpenById[activeContentId]) return;
    
    const relatedKey = getRelatedKey(activeContentId, excludeHost);
    
    // If already cached for this key, no need to refetch
    if (relatedById[relatedKey]) return;
    
    // Trigger refetch with new excludeHost setting
    const refetch = async () => {
      const requestId = Date.now();
      relatedReqByKey.current[relatedKey] = requestId;
      
      setRelatedLoadingById(prev => ({ ...prev, [relatedKey]: true }));
      setRelatedErrById(prev => ({ ...prev, [relatedKey]: null }));
      
      try {
        console.log(`[Related Videos] Refetching for ${activeContentId} with excludeHost=${excludeHost}`);
        const videos = await runReferencedVideos(selectedSource, activeContentId, excludeHost);
        
        // Check if still latest request (synchronous ref check)
        if (relatedReqByKey.current[relatedKey] !== requestId) {
          console.log(`[Related Videos] Ignoring stale refetch response`);
          return;
        }
        
        // Update cache with fresh data
        setRelatedById(prev => ({ ...prev, [relatedKey]: videos }));
      } catch (e: any) {
        console.error(`[Related Videos] Refetch error:`, e);
        setRelatedErrById(prev => ({ ...prev, [relatedKey]: e?.message || "Failed to load related videos" }));
      } finally {
        setRelatedLoadingById(prev => ({ ...prev, [relatedKey]: false }));
      }
    };
    
    refetch();
  }, [excludeHost]); // ONLY depend on excludeHost - don't trigger on activeContentId changes

  const connectToSource = async () => {
    if (!selectedSource) return;
    setLoading(true);
    setErr(null);
    try {
      let hits: Hit[];
      try {
        hits = await runLiveBrowseQuery(selectedSource, 0, 24);
      } catch (liveErr: any) {
        console.warn(
          "[Browse] Live browse failed, falling back to featureScroll:",
          liveErr?.message || liveErr
        );
        const data = await runQuery(selectedSource, 24);
        hits = data.hits || [];
      }

      // Validate data completeness
      const incompleteItems = hits.filter(h => {
        const flat = flatten(h);
        const hasTitle = flat['title.short'] || flat['title.full'];
        return !hasTitle; // Missing title is a sign of incomplete data
      });
      
      if (incompleteItems.length > 0) {
        console.warn(`⚠️ Received ${incompleteItems.length}/${hits.length} incomplete items from API`);
        setErr(`Warning: ${incompleteItems.length} items have incomplete data. Try reconnecting.`);
      }
      
      setHits(hits);
      setBrowseStage("detail");
    } catch (e: any) {
      setErr(e?.message || "Failed to load source");
    } finally {
      setLoading(false);
    }
  };

  // GraphQL search with debounce (500ms)
  useEffect(() => {
    const trimmedTerm = searchTerm.trim();
    
    // Clear results if empty or too short
    if (!selectedSource || !trimmedTerm || trimmedTerm.length < 2) {
      setSearchResults([]);
      setSearchErr(null);
      setIsSearching(false);
      setSearchStart(0);
      setSearchHasMore(false);
      return;
    }

    const timer = setTimeout(async () => {
      const requestId = Date.now();
      searchReqIdRef.current = requestId;
      
      setIsSearching(true);
      setSearchErr(null);
      setSearchStart(0); // Reset to first page
      
      try {
        const results = await runSearchQuery(selectedSource, trimmedTerm, 0, searchCount);
        
        // Guard against stale responses
        if (searchReqIdRef.current !== requestId) {
          console.log('[Search] Ignoring stale response');
          return;
        }
        
        setSearchResults(results);
        setSearchHasMore(results.length === searchCount); // If we got full page, there might be more
      } catch (e: any) {
        // Only update error if still latest request
        if (searchReqIdRef.current === requestId) {
          setSearchErr(e?.message || "Search failed");
          setSearchResults([]);
          setSearchHasMore(false);
        }
      } finally {
        // Only clear loading if still latest request
        if (searchReqIdRef.current === requestId) {
          setIsSearching(false);
        }
      }
    }, 500); // 500ms debounce

    return () => clearTimeout(timer);
  }, [searchTerm, selectedSource, searchCount]);

  const loadMoreSearchResults = async () => {
    const trimmedTerm = searchTerm.trim();
    if (!selectedSource || !trimmedTerm || trimmedTerm.length < 2 || isSearching) return;
    
    const nextStart = searchStart + searchCount;
    setIsSearching(true);
    setSearchErr(null);
    
    try {
      // runSearchQuery already adds _derived fields
      const moreResults = await runSearchQuery(selectedSource, trimmedTerm, nextStart, searchCount);
      setSearchResults(prev => [...prev, ...moreResults]);
      setSearchStart(nextStart);
      setSearchHasMore(moreResults.length === searchCount);
    } catch (e: any) {
      setSearchErr(e?.message || "Failed to load more results");
    } finally {
      setIsSearching(false);
    }
  };

  const toggleRelatedVideos = async (contentId: string, titleId: string | undefined, contentTitle: string) => {
    if (!selectedSource) return;
    
    // Toggle open/close (keyed by contentId only, not composite)
    const isCurrentlyOpen = relatedOpenById[contentId];
    
    if (isCurrentlyOpen) {
      // Close it
      setRelatedOpenById({ ...relatedOpenById, [contentId]: false });
      
      // Auto-switch Map dataset to "content" if closing the currently active film
      if (mapDataset === "relatedVideos" && activeContentId === contentId) {
        setMapDataset("content");
        // Keep activeContentId/activeContentTitle as-is, just switch dataset
      }
      
      return;
    }
    
    // Open and set as active content
    setRelatedOpenById({ ...relatedOpenById, [contentId]: true });
    setActiveContentId(contentId);
    setActiveContentTitle(contentTitle);
    
    // Reset video type filter to default when switching content
    setRelatedAllTypes(true);
    setRelatedSelectedTypes([]);
    
    // Compute composite key for current excludeHost setting
    const relatedKey = getRelatedKey(contentId, excludeHost);
    
    // If already fetched for this key, just open
    if (relatedById[relatedKey]) {
      return;
    }
    
    // Use the main content ID (longer, more reliable per dev recommendation)
    const searchId = contentId;
    
    // Race condition guard: generate request ID (using ref for synchronous tracking)
    const requestId = Date.now();
    relatedReqByKey.current[relatedKey] = requestId;
    
    setRelatedLoadingById({ ...relatedLoadingById, [relatedKey]: true });
    setRelatedErrById({ ...relatedErrById, [relatedKey]: null });
    
    try {
      console.log(`[Related Videos] Fetching for contentId: ${contentId}, titleId (for reference): ${titleId}, brand: ${selectedSource}, excludeHost: ${excludeHost}`);
      console.log(`[Related Videos] Using searchId: ${searchId}, cache key: ${relatedKey}`);
      const videos = await runReferencedVideos(selectedSource, searchId, excludeHost);
      
      // Check if this is still the latest request for this key (synchronous ref check)
      if (relatedReqByKey.current[relatedKey] !== requestId) {
        console.log(`[Related Videos] Ignoring stale response for ${relatedKey}`);
        return;
      }
      
      console.log(`[Related Videos] Received ${videos.length} videos:`, videos);
      
      // If no results, try a test query to verify the endpoint works
      if (videos.length === 0) {
        console.warn('[Related Videos] No results found. Running diagnostic test query...');
        try {
          const testVideos = await runTestVideoQuery(selectedSource);
          console.log(`[Related Videos] Test query returned ${testVideos.length} videos for ${selectedSource}:`, testVideos);
          if (testVideos.length > 0) {
            console.warn('[Related Videos] Search endpoint works, but reference query returned no results. Check field path or data.');
          }
        } catch (testErr) {
          console.error('[Related Videos] Test query also failed:', testErr);
        }
      }
      
      setRelatedById({ ...relatedById, [relatedKey]: videos });
    } catch (e: any) {
      console.error(`[Related Videos] Error:`, e);
      setRelatedErrById({ ...relatedErrById, [relatedKey]: e?.message || "Failed to load related videos" });
    } finally {
      setRelatedLoadingById({ ...relatedLoadingById, [relatedKey]: false });
    }
  };

  const applyMapping = () => {
    if (!selectedSource) return;
    
    // Use the unified activeDataset (already filtered for content or related videos)
    const dataSource = activeDataset;
    
    // Debug: Log dataset details
    console.log('[applyMapping called]', {
      mapDataset,
      activeContentId,
      excludeHost,
      relatedAllTypes,
      relatedSelectedTypes,
      activeDatasetLength: activeDataset.length,
      dataSourceLength: dataSource.length,
      displayHitsLength: displayHits.length,
      filteredRelatedVideosLength: filteredRelatedVideos.length,
    });
    
    if (dataSource.length === 0) {
      console.error("No data available for mapping");
      return;
    }
    
    // Build items with mixed composition support (per-row)
    // Each item will have either flattened fields OR composed text fields
    const items = dataSource.map((rawItem, itemIndex) => {
      const flattened = flatten(rawItem);
      const item: any = { ...flattened, brand: selectedSource };
      
      // For each mapping row that has composition, add a composed field
      mappingRows.forEach((row, rowIndex) => {
        if (row.composed && row.composed.parts.length > 0 && row.layerId) {
          // Build composed text for this specific row using the new helper
          const composedText = buildComposedText(rawItem, row.composed);
          // Store with unique key per row index
          item[`_composed_${rowIndex}`] = composedText;
          
          // Debug log first item only
          if (itemIndex === 0) {
            const partPaths = row.composed.parts.map(p => p.fieldPath).join(", ");
            console.log(`[Composed Row ${rowIndex}] "${composedText}" from [${partPaths}] sep="${row.composed.separator}"`);
          }
        }
      });
      
      return item;
    });
    
    // Build pairs array from all mapping rows (mix of single-field, image, and composed)
    const pairs = mappingRows
      .filter(row => row.layerId && row.kind)
      .filter(row => {
        // Include row if it has either:
        // - A fieldPath (single-field mapping)
        // - Composed config with parts (composed mapping)
        // 
        // Guardrail: If composed exists but has 0 parts, row is excluded
        return row.fieldPath || (row.composed && row.composed.parts.length > 0);
      })
      .map((row, rowIndex) => {
        const layer = layers.find(l => l.id === row.layerId);
        const layerName = row.layerName || layer?.name || "";
        
        if (!layerName) {
          console.warn(`Cannot find layer name for layer ID: ${row.layerId}`);
        }
        
        // Determine field name to use
        // - Composed text rows: use generated field name (_composed_0, _composed_1, etc.)
        // - Single-field text rows: use the fieldPath directly (e.g., "title.short")
        // - Image rows: use the fieldPath for image URL (e.g., "featuredImage.imageUrl")
        let fieldName: string;
        if (row.composed && row.composed.parts.length > 0) {
          // Composed row: use special field name with row index
          fieldName = `_composed_${rowIndex}`;
        } else {
          // Single-field or image row: use the fieldPath
          fieldName = row.fieldPath!;
        }
        
        return {
          layerId: row.layerId!,
          layerName,
          kind: row.kind!,
          field: fieldName,
          transform: {
            fallback: row.fallback,
            join: row.join,
            truncate: row.truncate,
            uppercase: row.uppercase,
          }
        };
      });
    
    if (pairs.length === 0) {
      console.error("No valid mappings to apply");
      return;
    }
    
    // Check if any pairs are missing layer names
    const missingNames = pairs.filter(p => !p.layerName);
    if (missingNames.length > 0) {
      console.error("Some mappings are missing layer names:", missingNames);
      console.error("Try selecting your frame/layers again to refresh the layer list");
      return;
    }
    
    console.log(`[Apply Mapping] ${pairs.length} mappings (mixed: single-field + composed), ${items.length} items`);
    
    parent.postMessage({
      pluginMessage: {
        type: "APPLY_MAPPING",
        brand: selectedSource,
        pairs,
        items,
        offset: Number(offset) || 0,
        count: Number(count) || 0,
        mapMode,
      }
    }, "*");
  };
  
  const createNewMapping = () => {
    setIsCreatingMapping(true);
    setMappingRows([{}]); // Add one empty row
    setAutoRefreshDisabled(false); // Enable auto-refresh during creation
    // Introspect current selection
    parent.postMessage({ pluginMessage: { type: "INTROSPECT_SELECTION" } }, "*");
  };
  
  const saveCurrentMapping = () => {
    if (!selectedSource || mappingRows.length === 0) return;
    
    parent.postMessage({
      pluginMessage: {
        type: "SAVE_MAPPING_ROWS",
        brand: selectedSource,
        rows: mappingRows,
      }
    }, "*");
  };
  
  const clearMapping = () => {
    if (!selectedSource) return;
    
    // Delete from storage
    parent.postMessage({
      pluginMessage: {
        type: "DELETE_MAPPING_ROWS",
        brand: selectedSource,
      }
    }, "*");
    
    // Clear UI state - go back to State 1 (empty state)
    setMappingRows([]);
    setMappingSaved(false);
    setAutoRefreshDisabled(false);
    setIsCreatingMapping(false);
    setLayers([]); // Clear layers so we show empty state
    
    // Don't re-introspect - user can manually click "Create New Mapping" to start fresh
  };
  
  // Debug: Clear all brands' storage (temporary for testing)
  const clearAllStorage = () => {
    const brands: SourceKey[] = ['hbo', 'dc', 'tcm'];
    brands.forEach(brand => {
      parent.postMessage({
        pluginMessage: {
          type: "DELETE_MAPPING_ROWS",
          brand,
        }
      }, "*");
    });
    
    // Clear UI state
    setMappingRows([]);
    setMappingSaved(false);
    setAutoRefreshDisabled(false);
    setIsCreatingMapping(false);
    setLayers([]);
  };
  
  // Extract fields from data - show ALL raw API fields (content or related videos)
  const getFieldsFromData = (dataSource: any[]): FieldInfo[] => {
    if (!selectedSource || dataSource.length === 0) return [];
    
    // Examine multiple items to build complete field list
    // This ensures fields that don't exist on first item are still available
    const fieldMap = new Map<string, FieldInfo>();
    
    // Examine up to first 10 items (or all if fewer) to find all possible fields
    const itemsToExamine = Math.min(10, dataSource.length);
    
    for (let i = 0; i < itemsToExamine; i++) {
      const flattenedItem = flatten(dataSource[i]);
      
      for (const key in flattenedItem) {
        const value = flattenedItem[key];
        let type: string = typeof value;
        if (Array.isArray(value)) type = "array";
        
        // Use Map to automatically deduplicate by key
        // Once we've seen a field, we don't need to update its type
        if (!fieldMap.has(key)) {
          fieldMap.set(key, { path: key, type });
        }
      }
    }
    
    console.log('[getFieldsFromData] Examined', itemsToExamine, 'items, found', fieldMap.size, 'unique fields');
    
    // Convert to array and filter out noisy fields
    let fields = Array.from(fieldMap.values());
    
    // Filter out noisy nested fields - keep only clean _derived strings
    fields = fields.filter(field => {
      // Remove any castAndCrew.* paths (firstName, lastName, role, etc.)
      if (field.path.startsWith("castAndCrew")) return false;
      
      // Remove individual indexed genre paths (e.g., genres.0.name for TCM)
      // Keep the top-level "genres" field, but remove genres.0, genres.1, etc.
      if (/^genres\.\d+/.test(field.path)) return false;
      
      // Keep everything else (including _derived fields and top-level genres)
      return true;
    });
    
    // Sort alphabetically for easier browsing
    fields.sort((a, b) => a.path.localeCompare(b.path));
    
    return fields;
  };
  
  const addMappingRow = () => {
    setMappingRows([...mappingRows, {}]);
    setMappingSaved(false);
    setAutoRefreshDisabled(true);
    if (!isCreatingMapping) {
      setIsCreatingMapping(true);
    }
  };
  
  const removeMappingRow = (index: number) => {
    setMappingRows(mappingRows.filter((_, i) => i !== index));
    setMappingSaved(false);
  };
  
  const updateMappingRow = (index: number, updates: Partial<MappingRow>) => {
    const newRows = [...mappingRows];
    newRows[index] = { ...newRows[index], ...updates };
    
    // Auto-set kind and save layer name based on layer capability
    if (updates.layerId) {
      const layer = layers.find(l => l.id === updates.layerId);
      if (layer) {
        // Save layer name for re-matching across designs
        newRows[index].layerName = layer.name;
        
        // Prioritize text detection (if textCapable at all, it's probably a text layer)
        if (layer.textCapable) {
          newRows[index].kind = "text";
        } else if (layer.imageFillCapable) {
          newRows[index].kind = "image";
        }
        // If neither, leave kind undefined (user will need to select field first)
      }
    }
    
    setMappingRows(newRows);
    setMappingSaved(false);
    setAutoRefreshDisabled(true);
  };

  // ===== UNIFIED CONTENT PIPELINE =====
  // Process content items through filter → sort → display pipeline
  // This ensures consistent ordering across browse, search, and mapping
  // MUST be declared before any functions that use displayHits to avoid TDZ errors
  
  // Step 1: Determine base dataset (browse hits or search results)
  const isSearchActive = searchTerm.trim().length > 0;
  const baseHits = isSearchActive ? searchResults : hits;
  
  // Step 2: Extract unique genres for filter dropdown
  const availableGenres = getUniqueGenres(baseHits);
  
  // Step 3: Apply genre filter (if selected)
  const filteredHits = selectedGenre
    ? baseHits.filter(hit => {
        const normalized = normalizeGenres(hit.genres);
        return normalized.some(g => g.toLowerCase() === selectedGenre.toLowerCase());
      })
    : baseHits;
  
  // Step 4: Apply sorting to filtered results
  // "default" preserves incoming order, other options create sorted copy
  const displayHits = sortHits(filteredHits, sortOrder);
  
  // ===== RELATED VIDEOS FILTERING PIPELINE =====
  // Client-side filtering by video type (applied after excludeHost)
  // MUST be declared BEFORE getActiveDataset to avoid TDZ errors
  
  // Helper: Get related videos for a specific content ID
  const getRelatedVideosForId = (contentId: string): any[] => {
    if (!contentId) return [];
    const relatedKey = getRelatedKey(contentId, excludeHost);
    return relatedById[relatedKey] || [];
  };
  
  // Helper: Get currently displayed related videos for active content
  const getCurrentRelatedVideos = (): any[] => {
    return getRelatedVideosForId(activeContentId || '');
  };
  
  // Derive available video types from fetched related videos (for active content only)
  const availableRelatedTypes = React.useMemo(() => {
    const currentVideos = getCurrentRelatedVideos();
    const typeSet = new Set<string>();
    
    currentVideos.forEach((video: any) => {
      const vType = video?.videoType;
      if (vType && typeof vType === 'string' && vType.trim() !== '') {
        typeSet.add(vType.trim());
      }
    });
    
    const types = Array.from(typeSet);
    types.sort((a, b) => a.localeCompare(b)); // Sort A→Z
    return types;
  }, [activeContentId, excludeHost, relatedById]);
  
  // Apply filtering pipeline: excludeHost → video type filter
  // Can be used for any content ID (for browse tab) or active content (for map tab)
  const getFilteredRelatedVideosForId = (contentId: string): any[] => {
    let filtered = getRelatedVideosForId(contentId);
    
    // Step 1: Apply excludeHost filter
    if (excludeHost) {
      filtered = filtered.filter((video: any) => video?.videoType !== "Host");
    }
    
    // Step 2: Apply video type filter (only if All types is OFF)
    if (!relatedAllTypes && relatedSelectedTypes.length > 0) {
      filtered = filtered.filter((video: any) => {
        const vType = video?.videoType;
        return vType && relatedSelectedTypes.includes(vType);
      });
    }
    
    return filtered;
  };
  
  // For active content (used in Map tab and controls)
  const filteredRelatedVideos = getFilteredRelatedVideosForId(activeContentId || '');
  
  // Step 5: Create unified "active dataset" for mapping (content or filtered related videos)
  // This is the SINGLE SOURCE OF TRUTH for what gets mapped
  const getActiveDataset = (): any[] => {
    if (mapDataset === "content") {
      return displayHits; // Already filtered + sorted
    } else if (mapDataset === "relatedVideos") {
      return filteredRelatedVideos; // Already filtered by excludeHost + video types
    }
    return [];
  };
  
  const activeDataset = getActiveDataset();
  
  // Step 6: Extract fields from active dataset for mapping
  const fields = getFieldsFromData(activeDataset);
  
  // ===== COMPOSED TEXT HELPERS =====
  
  // Helper: Detect if a field path is actually an array by checking runtime data
  // (Checks first 3 items to handle cases where first item might be missing the field)
  const isFieldActuallyArray = (fieldPath: string, dataSource: Hit[]): boolean => {
    if (dataSource.length === 0) return false;
    
    // Check up to first 3 items
    const samplesToCheck = Math.min(3, dataSource.length);
    
    for (let i = 0; i < samplesToCheck; i++) {
      const value = getValueByPath(dataSource[i], fieldPath);
      if (value !== undefined && value !== null) {
        // Found a non-null value, check if it's an array
        return Array.isArray(value);
      }
    }
    
    // All checked items were null/undefined, fallback to field schema type
    const field = fields.find(f => f.path === fieldPath);
    return field?.type === "array";
  };
  
  // Helper: Get data source for current map dataset (for array detection)
  // Uses the same filtered dataset as mapping
  const getMapDataSource = (): Hit[] => {
    return activeDataset;
  };
  
  // Helper: Group videos by type (for future rails feature)
  const groupVideosByType = (videos: any[]): Record<string, any[]> => {
    const grouped: Record<string, any[]> = {};
    
    videos.forEach((video: any) => {
      const vType = video?.videoType;
      const key = (vType && vType.trim() !== '') ? vType : 'Unknown';
      
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(video);
    });
    
    return grouped;
  };

  return (
    <div className="container">
      <div className="header">
        <span>✨ {PLUGIN_DISPLAY_NAME}</span>
        <button 
          onClick={clearAllStorage}
          style={{ 
            fontSize: "10px", 
            padding: "4px 8px", 
            background: "var(--error)", 
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            marginLeft: "auto"
          }}
          title="Clear all saved mappings (testing)"
        >
          🗑️ Clear All
        </button>
      </div>
      <div className="subtitle">
        Content Browser • {PROXY_URL.split('//')[1]?.split('/')[0]}
      </div>

      {/* Tab Switcher */}
      <div className="tab-switcher">
        <button 
          className={`tab-button ${activeTab === "browse" ? "active" : ""}`}
          onClick={() => setActiveTab("browse")}
        >
          Browse
        </button>
        <button 
          className={`tab-button ${activeTab === "map" ? "active" : ""}`}
          onClick={() => setActiveTab("map")}
        >
          Map
        </button>
      </div>

      {activeTab === "browse" && (
        <>
          {/* Stage A: Source Picker */}
          {browseStage === "select" && (
            <div className="control-panel">
              <div className="header">Browse</div>
              
              <div className="form-group">
                <label className="label">Select your source</label>
                <select
                  className="select"
                  value={selectedSource || ""}
                  onChange={(e) => setSelectedSource((e.target.value || "").toLowerCase() as SourceKey)}
                >
                  <option value="" disabled>Select your source</option>
                  <option value="tcm">TCM</option>
                  <option value="dc">DC</option>
                  <option value="hbo">HBO</option>
                </select>
              </div>
              
              <div className="button-group">
                <button
                  className="button button-primary"
                  disabled={!selectedSource || loading}
                  onClick={connectToSource}
                >
                  {loading ? "Connecting…" : "Connect"}
                </button>
              </div>
              
              {err && <div className="error">⚠️ {err}</div>}
            </div>
          )}

          {/* Stage B: Source Detail */}
          {browseStage === "detail" && selectedSource && (
            <>
              {/* Subnav with back button */}
              <div className="subnav">
                <button
                  className="icon-button"
                  onClick={() => setBrowseStage("select")}
                  title="Back"
                  aria-label="Back"
                >
                  ←
                </button>
                <div className="subnav-title">{selectedSource.toUpperCase()}</div>
              </div>

              {/* Search input */}
              <div className="form-group" style={{ marginBottom: "16px" }}>
                <div style={{ position: "relative" }}>
                  <input
                    type="text"
                    className="input"
                    placeholder="Search catalog..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    style={{ paddingRight: searchTerm ? "36px" : "12px" }}
                  />
                  {searchTerm && (
                    <button
                      onClick={() => setSearchTerm("")}
                      style={{
                        position: "absolute",
                        right: "8px",
                        top: "50%",
                        transform: "translateY(-50%)",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        fontSize: "16px",
                        color: "var(--text-muted)",
                        padding: "4px",
                        lineHeight: 1
                      }}
                      title="Clear search"
                    >
                      ✕
                    </button>
                  )}
                </div>
                {searchTerm.trim().length === 1 && !isSearching && (
                  <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
                    Type at least 2 characters to search
                  </div>
                )}
                {isSearching && (
                  <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
                    {searchResults.length > 0 ? "Loading more..." : "Searching..."}
                  </div>
                )}
                {searchErr && (
                  <div style={{ fontSize: "12px", color: "var(--error)", marginTop: "4px" }}>
                    ⚠️ {searchErr}
                  </div>
                )}
                {searchResults.length > 0 && !isSearching && (
                  <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
                    Showing {displayHits.length} result{displayHits.length !== 1 ? 's' : ''}
                    {displayHits.length < searchResults.length && ` (filtered from ${searchResults.length})`}
                  </div>
                )}
              </div>
              
              {/* Filter and Sort controls */}
              <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
                <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                  <label className="label">Filter by genre</label>
                  <select
                    className="select"
                    value={selectedGenre}
                    onChange={(e) => setSelectedGenre(e.target.value)}
                  >
                    <option value="">All genres</option>
                    {availableGenres.map(genre => (
                      <option key={genre} value={genre}>{genre}</option>
                    ))}
                  </select>
                </div>
                
                <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                  <label className="label">Sort by</label>
                  <select
                    className="select"
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value as any)}
                  >
                    <option value="default">As loaded</option>
                    <option value="title-asc">Title A→Z</option>
                    <option value="title-desc">Title Z→A</option>
                    <option value="year-desc">Release Year: Newest → Oldest</option>
                    <option value="year-asc">Release Year: Oldest → Newest</option>
                  </select>
                </div>
              </div>
              
              {/* Clear filters button */}
              {(selectedGenre || sortOrder !== "default") && (
                <div style={{ marginBottom: "16px", textAlign: "center" }}>
                  <button
                    className="button"
                    onClick={() => {
                      setSelectedGenre("");
                      setSortOrder("default");
                    }}
                    style={{ fontSize: "12px", padding: "8px 16px" }}
                  >
                    Clear filters
                  </button>
                </div>
              )}

              {/* Results count (when filtering/sorting applied) */}
              {!loading && !isSearchActive && hits.length > 0 && (selectedGenre || sortOrder !== "default") && (
                <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "12px", textAlign: "center" }}>
                  Showing {displayHits.length} of {hits.length} item{hits.length !== 1 ? 's' : ''}
                </div>
              )}
              
              {/* Item list */}
              {(() => {
                if (loading) return <div className="info-message">Loading…</div>;
                if (!loading && !isSearchActive && !hits.length) return <div className="info-message">No results.</div>;
                if (isSearchActive && !isSearching && displayHits.length === 0) {
                  return <div className="info-message">No results found for "{searchTerm}"</div>;
                }
                if (!isSearchActive && !loading && displayHits.length === 0 && selectedGenre) {
                  return <div className="info-message">No results for genre "{selectedGenre}"</div>;
                }

              return (
              <>
              <div className="item-list">
                {displayHits.map((hit) => {
                  const flat = flatten(hit);
                  const entries = Object.entries(flat);
                  const title = flat['title.short'] || flat['title.full'] || 'Untitled';
                  const titleId = flat['titleId'];
                  const imageUrl = getBestPreviewImageUrl(hit);

                  const year = flat['releaseYear'];
                  const genres = flat['genres'];
                  const isRelatedOpen = relatedOpenById[hit.id];
                  const showRawFields = showRawFieldsById[hit.id] || false;
                  
                  return (
                    <div key={hit.id} className="item-card">
                      {/* Compact card header */}
                      <div style={{ display: "flex", gap: "12px", marginBottom: "12px" }}>
                        {imageUrl && (
                          <img
                            src={String(imageUrl)}
                            alt={title}
                            style={{ width: 80, height: 48, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
                          />
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, marginBottom: "4px", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {title}
                          </div>
                          {year && (
                            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "2px" }}>
                              {year}
                            </div>
                          )}
                          {(() => {
                            const director = getDirectors(hit);
                            if (!director) return null;
                            return (
                              <div style={{ fontSize: "12px", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                <strong style={{ color: "var(--text)" }}>Director:</strong> {director}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                      
                      {/* Action buttons */}
                      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
                        <button 
                          className="button"
                          onClick={() => toggleRelatedVideos(hit.id, titleId, title)}
                          style={{ flex: 1, fontSize: "12px" }}
                        >
                          {isRelatedOpen ? "Hide related" : "View related"}
                          {(() => {
                            const key = getRelatedKey(hit.id, excludeHost);
                            return relatedLoadingById[key] && " ...";
                          })()}
                        </button>
                        <button 
                          className="button"
                          onClick={() => setShowRawFieldsById({ ...showRawFieldsById, [hit.id]: !showRawFields })}
                          style={{ flex: 1, fontSize: "12px" }}
                        >
                          {showRawFields ? "Hide" : "Show"} raw fields
                        </button>
                      </div>
                      
                      {/* Related videos list */}
                      {isRelatedOpen && (() => {
                        const relatedKey = getRelatedKey(hit.id, excludeHost);
                        const isLoading = relatedLoadingById[relatedKey];
                        const error = relatedErrById[relatedKey];
                        const rawVideos = relatedById[relatedKey] || [];
                        const videos = getFilteredRelatedVideosForId(hit.id);
                        
                        return (
                        <div style={{ marginBottom: "12px", padding: "12px", background: "var(--bg-dark)", borderRadius: "4px" }}>
                          {/* Exclude Host videos toggle */}
                          <div style={{ marginBottom: "12px", paddingBottom: "12px", borderBottom: "1px solid var(--border)" }}>
                            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                checked={excludeHost}
                                onChange={(e) => setExcludeHost(e.target.checked)}
                                disabled={isLoading}
                                style={{ cursor: isLoading ? "not-allowed" : "pointer" }}
                              />
                              <span>Exclude Host videos</span>
                            </label>
                          </div>
                          
                          {/* Video type filtering (client-side) */}
                          {availableRelatedTypes.length > 0 && (
                            <div style={{ marginBottom: "12px", paddingBottom: "12px", borderBottom: "1px solid var(--border)" }}>
                              <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "8px" }}>
                                Video types
                              </div>
                              
                              {/* All types checkbox */}
                              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", cursor: "pointer", marginBottom: "6px" }}>
                                <input
                                  type="checkbox"
                                  checked={relatedAllTypes}
                                  onChange={(e) => {
                                    setRelatedAllTypes(e.target.checked);
                                    if (e.target.checked) {
                                      setRelatedSelectedTypes([]); // Clear selections when switching to All
                                    }
                                  }}
                                  disabled={isLoading}
                                  style={{ cursor: isLoading ? "not-allowed" : "pointer" }}
                                />
                                <span style={{ fontWeight: 500 }}>All types</span>
                              </label>
                              
                              {/* Individual type checkboxes */}
                              <div style={{ marginLeft: "20px", display: "flex", flexDirection: "column", gap: "4px" }}>
                                {availableRelatedTypes.map((vType) => {
                                  const isChecked = relatedSelectedTypes.includes(vType);
                                  
                                  return (
                                    <label 
                                      key={vType}
                                      style={{ 
                                        display: "flex", 
                                        alignItems: "center", 
                                        gap: "8px", 
                                        fontSize: "12px", 
                                        cursor: relatedAllTypes || isLoading ? "not-allowed" : "pointer",
                                        opacity: relatedAllTypes ? 0.5 : 1
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={isChecked}
                                        onChange={(e) => {
                                          // Auto-turn off "All types" when selecting specific type
                                          setRelatedAllTypes(false);
                                          
                                          if (e.target.checked) {
                                            setRelatedSelectedTypes([...relatedSelectedTypes, vType]);
                                          } else {
                                            const newTypes = relatedSelectedTypes.filter(t => t !== vType);
                                            // If unchecking last type, revert to All types
                                            if (newTypes.length === 0) {
                                              setRelatedAllTypes(true);
                                            }
                                            setRelatedSelectedTypes(newTypes);
                                          }
                                        }}
                                        disabled={relatedAllTypes || isLoading}
                                        style={{ cursor: relatedAllTypes || isLoading ? "not-allowed" : "pointer" }}
                                      />
                                      <span>{vType}</span>
                                    </label>
                                  );
                                })}
                              </div>
                              
                              {/* Summary: Showing X of Y videos */}
                              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "8px" }}>
                                Showing {filteredRelatedVideos.length} of {getCurrentRelatedVideos().length} videos
                              </div>
                            </div>
                          )}
                          
                          {isLoading && (
                            <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Loading related videos...</div>
                          )}
                          {error && (
                            <div style={{ fontSize: "12px", color: "var(--error)" }}>⚠️ {error}</div>
                          )}
                          {videos.length === 0 && !isLoading && !error && (
                            <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>No related videos found</div>
                          )}
                          {videos.length > 0 && (
                            <div>
                              <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "8px" }}>
                                {videos.length} related video{videos.length !== 1 ? 's' : ''}
                              </div>
                              {videos.map((video: any, idx: number) => {
                                const vFlat = flatten(video);
                                const vTitle = vFlat['title.short'] || 'Untitled';
                                const vThumb = vFlat['featuredImage.cuts.0.url'];
                                const vDuration = vFlat['featuredVideo.videoDurationFormatted'];
                                const vType = vFlat['videoType'];
                                const vDate = vFlat['lifecycle.date.firstPublishedDateFormatted'];
                                
                                return (
                                  <div key={idx} style={{ display: "flex", gap: "8px", marginBottom: "8px", paddingBottom: "8px", borderBottom: idx < videos.length - 1 ? "1px solid var(--border)" : "none" }}>
                                    {vThumb && (
                                      <img
                                        src={String(vThumb)}
                                        alt={vTitle}
                                        style={{ width: 60, height: 34, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
                                      />
                                    )}
                                    <div style={{ flex: 1, minWidth: 0, fontSize: "12px" }}>
                                      <div style={{ fontWeight: 500, marginBottom: "2px", overflow: "hidden", textOverflow: "ellipsis" }}>
                                        {vTitle}
                                      </div>
                                      <div style={{ color: "var(--text-muted)" }}>
                                        {vDuration && <span>{vDuration}</span>}
                                        {vDuration && vType && <span> • </span>}
                                        {vType && <span>{vType}</span>}
                                        {vDate && <span> • {vDate}</span>}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        );
                      })()}
                      
                      {/* Raw fields (toggled) */}
                      {showRawFields && (
                        <div className="item-props" style={{ borderTop: "1px solid var(--border)", paddingTop: "12px" }}>
                          {entries.map(([k, v]) => {
                            const isImg = isImageUrl(v);
                            return (
                              <div key={k} className="item-prop">
                                <div className="prop-key">{k}</div>
                                <div className="prop-val">
                                  {isImg ? (
                                    <img
                                      src={String(v)}
                                      alt={k}
                                      style={{ maxHeight: 48, maxWidth: 96, objectFit: "cover", borderRadius: 4 }}
                                    />
                                  ) : Array.isArray(v) ? (
                                    <span className="mono">{v.join(", ")}</span>
                                  ) : typeof v === "object" && v !== null ? (
                                    <span className="mono">{JSON.stringify(v)}</span>
                                  ) : (
                                    <span className="mono">{String(v)}</span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              
              {/* Load More button for search pagination */}
              {isSearchActive && searchHasMore && (
                <div style={{ padding: "16px", textAlign: "center" }}>
                  <button
                    className="button"
                    onClick={loadMoreSearchResults}
                    disabled={isSearching}
                  >
                    {isSearching ? "Loading..." : "Load more"}
                  </button>
                </div>
              )}
              </>
              );
              })()}
            </>
          )}
        </>
      )}

      {/* Map Tab */}
      {activeTab === "map" && (
        <div className="map-tab">
          <div className="control-panel">
            <div className="header">Field to Layer Mapping</div>
            
            {/* Data Source Indicator */}
            {selectedSource && hits.length > 0 ? (
              <div className="data-source-banner">
                Using data from: <strong>{selectedSource.toUpperCase()}</strong> ({displayHits.length} items available{displayHits.length !== hits.length ? ` / ${hits.length} loaded` : ''})
              </div>
            ) : (
              <div className="data-source-banner warning">
                ⚠️ Load data from Browse tab first
              </div>
            )}
            
            {/* Dataset Selector */}
            {selectedSource && hits.length > 0 && (() => {
              // Build list of films with related videos for current excludeHost mode
              const relatedFilmOptions = Object.entries(relatedById)
                .map(([key, videos]) => {
                  const contentId = key.split("|excludeHost=")[0];
                  return { 
                    key, 
                    contentId, 
                    count: Array.isArray(videos) ? videos.length : 0 
                  };
                })
                .filter(opt => opt.key.endsWith(`|excludeHost=${excludeHost}`))
                .reduce((acc: Array<{key: string, contentId: string, count: number}>, opt) => {
                  if (!acc.find(a => a.contentId === opt.contentId)) {
                    acc.push(opt);
                  }
                  return acc;
                }, []);
              
              // Helper to get title from displayHits by contentId
              const getTitleForContentId = (contentId: string): string => {
                const hit = displayHits.find(h => h.id === contentId);
                if (!hit) return contentId;
                const flat = flatten(hit);
                return flat["title.short"] || flat["title.full"] || contentId;
              };
              
              // Handle film selection from dropdown
              const handleFilmSelection = (selectedContentId: string) => {
                setActiveContentId(selectedContentId);
                setActiveContentTitle(getTitleForContentId(selectedContentId));
              };
              
              // Prevent stale activeContentId when excludeHost changes
              const isActiveInOptions = !!activeContentId && relatedFilmOptions.some(o => o.contentId === activeContentId);
              const selectedFilmId = isActiveInOptions ? activeContentId : "";
              
              return (
              <>
              <div className="form-group" style={{ marginBottom: "16px" }}>
                <label className="label">Map data from:</label>
                <div className="radio-group">
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="mapDataset"
                      value="content"
                      checked={mapDataset === "content"}
                      onChange={(e) => setMapDataset(e.target.value as MapDataset)}
                    />
                    <span>Content items ({displayHits.length} loaded{isSearchActive ? ' from search' : ''})</span>
                  </label>
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="mapDataset"
                      value="relatedVideos"
                      checked={mapDataset === "relatedVideos"}
                      onChange={(e) => {
                        setMapDataset(e.target.value as MapDataset);
                        // Auto-select first film if none selected or current selection invalid
                        if (relatedFilmOptions.length > 0 && !isActiveInOptions) {
                          handleFilmSelection(relatedFilmOptions[0].contentId);
                        }
                      }}
                      disabled={relatedFilmOptions.length === 0}
                    />
                    <span>
                      Related videos
                      {relatedFilmOptions.length === 0 && 
                        " (click 'View related' in Browse tab first)"
                      }
                      {relatedFilmOptions.length > 0 && (() => {
                        // Show filtered count vs total for active content
                        const totalVideos = getCurrentRelatedVideos().length;
                        const shownVideos = filteredRelatedVideos.length;
                        const hasFilters = excludeHost || !relatedAllTypes;
                        
                        if (hasFilters && shownVideos < totalVideos) {
                          return ` (${shownVideos} shown / ${totalVideos} total)`;
                        } else {
                          return ` (${shownVideos} video${shownVideos !== 1 ? 's' : ''})`;
                        }
                      })()}
                    </span>
                  </label>
                </div>
              </div>
              
              {/* Film selector dropdown when Related videos is selected */}
              {mapDataset === "relatedVideos" && relatedFilmOptions.length > 0 && (
                <div className="form-group" style={{ marginBottom: "16px" }}>
                  <label className="label">Select film:</label>
                  <select
                    className="select"
                    value={selectedFilmId}
                    onChange={(e) => handleFilmSelection(e.target.value)}
                  >
                    {!selectedFilmId && <option value="">-- Select a film --</option>}
                    {relatedFilmOptions.map(opt => {
                      const title = getTitleForContentId(opt.contentId);
                      return (
                        <option key={opt.contentId} value={opt.contentId}>
                          {title} ({opt.count} video{opt.count !== 1 ? 's' : ''})
                        </option>
                      );
                    })}
                  </select>
                  {!selectedFilmId && (
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
                      Select a film to map its related videos
                    </div>
                  )}
                </div>
              )}
              </>
              );
            })()}
            
            {/* State 1: Empty (No mappings exist) */}
            {!isCreatingMapping && mappingRows.length === 0 && !mappingSaved && (
              <div className="info-message" style={{ padding: "32px 16px", textAlign: "center" }}>
                <div style={{ marginBottom: "16px", fontSize: "14px", color: "var(--text-muted)" }}>
                  You don't have any mappings yet
                </div>
                <button 
                  className="button button-primary"
                  onClick={createNewMapping}
                >
                  ➕ Create New Mapping
                </button>
              </div>
            )}
            
            {/* State 2: Creating (No layers selected yet) */}
            {isCreatingMapping && layers.length === 0 && (
              <div className="info-message" style={{ padding: "16px", textAlign: "center" }}>
                Select a layer in Figma to see available layers
              </div>
            )}
            
            {/* State 2-4: Has layers (Creating, Editing, or Saved) */}
            {layers.length > 0 && (isCreatingMapping || mappingRows.length > 0 || mappingSaved) && (
              <>
                <div className="info-message" style={{ marginBottom: "12px", padding: "8px", fontSize: "12px" }}>
                  Found {layers.length} layer{layers.length !== 1 ? "s" : ""} in selection
                </div>
                
                {/* Mapping Table (supports mixed: single-field, image, and per-row composed) */}
                <div className="mapping-table" style={{ marginBottom: "16px" }}>
                  {mappingRows.map((row, index) => {
                    const selectedField = fields.find(f => f.path === row.fieldPath);
                    const isArrayField = selectedField?.type === "array";
                    
                    return (
                      <div key={index} style={{ marginBottom: "16px", padding: "12px", border: "1px solid var(--border)", borderRadius: "4px" }}>
                        <div className="mapping-row" style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                          {/* Field selector (hidden when composing) */}
                          {!row.composed && (
                            <>
                              <select
                                className="select"
                                value={row.fieldPath || ""}
                                onChange={(e) => updateMappingRow(index, { fieldPath: e.target.value })}
                                style={{ flex: 1 }}
                              >
                                <option value="">-- Select Field --</option>
                                {fields.map(f => (
                                  <option key={f.path} value={f.path}>
                                    {f.path} ({f.type})
                                  </option>
                                ))}
                              </select>
                              
                              <span>→</span>
                            </>
                          )}
                          
                          {/* When composing, show label instead */}
                          {row.composed && (
                            <div style={{ flex: 1, fontSize: "12px", color: "var(--text-muted)" }}>
                              Composed → 
                            </div>
                          )}

                          <select
                            className="select"
                            value={row.layerId || ""}
                            onChange={(e) => updateMappingRow(index, { layerId: e.target.value })}
                            style={{ flex: 1 }}
                          >
                            <option value="">-- Select Layer --</option>
                            {layers.map(l => (
                              <option key={l.id} value={l.id} disabled={l.locked}>
                                {l.name} [{l.type}] {l.locked ? "🔒" : ""}
                              </option>
                            ))}
                          </select>
                          
                          <button 
                            className="button"
                            onClick={() => removeMappingRow(index)}
                            style={{ padding: "6px", minWidth: "auto", width: "32px", flex: "0 0 32px" }}
                            title="Remove row"
                          >
                            ✕
                          </button>
                        </div>
                        
                        {/* Transform options (only shown for single-field mode) */}
                        {row.fieldPath && !row.composed && (
                          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", fontSize: "12px" }}>
                            {isArrayField && (
                              <input
                                className="input"
                                type="text"
                                placeholder="Join with (e.g., ' • ')"
                                value={row.join || ""}
                                onChange={(e) => updateMappingRow(index, { join: e.target.value })}
                                style={{ flex: "1 1 120px", fontSize: "12px" }}
                                title="Separator for array values"
                              />
                            )}
                            <input
                              className="input"
                              type="text"
                              placeholder="Fallback value"
                              value={row.fallback || ""}
                              onChange={(e) => updateMappingRow(index, { fallback: e.target.value })}
                              style={{ flex: "1 1 120px", fontSize: "12px" }}
                              title="Value to use if field is empty"
                            />
                            <input
                              className="input"
                              type="number"
                              placeholder="Max length"
                              value={row.truncate || ""}
                              onChange={(e) => updateMappingRow(index, { truncate: e.target.value ? parseInt(e.target.value, 10) : undefined })}
                              style={{ flex: "1 1 80px", fontSize: "12px" }}
                              title="Truncate to max characters"
                            />
                            <label style={{ display: "flex", alignItems: "center", gap: "4px", flex: "0 0 auto" }}>
                              <input
                                type="checkbox"
                                checked={row.uppercase || false}
                                onChange={(e) => updateMappingRow(index, { uppercase: e.target.checked })}
                              />
                              <span>UPPERCASE</span>
                            </label>
                          </div>
                        )}
                        
                        {/* Compose toggle (only for TEXT layers) */}
                        {row.kind === "text" && !row.composed && (
                          <div style={{ marginTop: "8px" }}>
                            <button
                              className="button"
                              onClick={() => {
                                updateMappingRow(index, {
                                  composed: { parts: [], separator: " | " },
                                  fieldPath: undefined // Clear single-field path when composing
                                });
                              }}
                              style={{ fontSize: "11px", padding: "4px 8px" }}
                            >
                              + Compose
                            </button>
                          </div>
                        )}
                        
                        {/* Inline composer UI (when row.composed exists) */}
                        {row.composed && (
                          <div style={{ marginTop: "12px", padding: "12px", background: "var(--bg-dark)", borderRadius: "4px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                              <div style={{ fontSize: "12px", fontWeight: 600 }}>
                                Composed Text ({row.composed.parts.length} field{row.composed.parts.length !== 1 ? 's' : ''})
                              </div>
                              <button
                                className="button"
                                onClick={() => {
                                  updateMappingRow(index, {
                                    composed: undefined,
                                    fieldPath: "" // Reset to empty, user can select single field again
                                  });
                                }}
                                style={{ fontSize: "11px", padding: "4px 8px" }}
                              >
                                Remove compose
                              </button>
                            </div>
                            
                            {/* Composed parts list */}
                            {row.composed.parts.length === 0 && (
                              <div style={{ padding: "12px", textAlign: "center", fontSize: "11px", color: "var(--text-muted)", border: "1px dashed var(--border)", borderRadius: "4px", marginBottom: "12px" }}>
                                No fields added yet. Use "Add field" below.
                              </div>
                            )}
                            
                            {row.composed.parts.map((part, partIndex) => {
                              const partField = fields.find(f => f.path === part.fieldPath);
                              const isPartArray = partField?.type === "array" || isFieldActuallyArray(part.fieldPath, getMapDataSource());
                              
                              return (
                                <div key={partIndex} style={{ marginBottom: "8px", padding: "8px", border: "1px solid var(--border)", borderRadius: "4px", background: "var(--bg)", fontSize: "12px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                                    <div style={{ flex: 1, fontWeight: 500 }}>
                                      {part.fieldPath}
                                      {isPartArray && <span style={{ fontSize: "10px", color: "var(--text-muted)" }}> (array)</span>}
                                    </div>
                                    <button
                                      className="button"
                                      onClick={() => {
                                        const newParts = [...row.composed!.parts];
                                        if (partIndex > 0) {
                                          [newParts[partIndex - 1], newParts[partIndex]] = [newParts[partIndex], newParts[partIndex - 1]];
                                          updateMappingRow(index, { composed: { ...row.composed!, parts: newParts } });
                                        }
                                      }}
                                      disabled={partIndex === 0}
                                      style={{ padding: "2px 6px", fontSize: "10px", minWidth: "auto" }}
                                      title="Move up"
                                    >
                                      ↑
                                    </button>
                                    <button
                                      className="button"
                                      onClick={() => {
                                        const newParts = [...row.composed!.parts];
                                        if (partIndex < newParts.length - 1) {
                                          [newParts[partIndex], newParts[partIndex + 1]] = [newParts[partIndex + 1], newParts[partIndex]];
                                          updateMappingRow(index, { composed: { ...row.composed!, parts: newParts } });
                                        }
                                      }}
                                      disabled={partIndex === row.composed.parts.length - 1}
                                      style={{ padding: "2px 6px", fontSize: "10px", minWidth: "auto" }}
                                      title="Move down"
                                    >
                                      ↓
                                    </button>
                                    <button
                                      className="button"
                                      onClick={() => {
                                        const newParts = row.composed!.parts.filter((_, i) => i !== partIndex);
                                        updateMappingRow(index, { composed: { ...row.composed!, parts: newParts } });
                                      }}
                                      style={{ padding: "2px 6px", fontSize: "10px", minWidth: "auto" }}
                                      title="Remove"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                  
                                  {/* Array controls */}
                                  {isPartArray && (
                                    <div style={{ display: "flex", gap: "8px", marginBottom: "6px" }}>
                                      <input
                                        className="input"
                                        type="number"
                                        placeholder="Max items"
                                        value={part.arrayMaxItems || 3}
                                        onChange={(e) => {
                                          const newParts = [...row.composed!.parts];
                                          newParts[partIndex] = { ...newParts[partIndex], arrayMaxItems: parseInt(e.target.value) || 3 };
                                          updateMappingRow(index, { composed: { ...row.composed!, parts: newParts } });
                                        }}
                                        min="1"
                                        style={{ flex: "0 0 80px", fontSize: "11px" }}
                                        title="Max items to show"
                                      />
                                      <input
                                        className="input"
                                        type="text"
                                        placeholder="Join with (e.g., ', ')"
                                        value={part.arraySeparator || ", "}
                                        onChange={(e) => {
                                          const newParts = [...row.composed!.parts];
                                          newParts[partIndex] = { ...newParts[partIndex], arraySeparator: e.target.value };
                                          updateMappingRow(index, { composed: { ...row.composed!, parts: newParts } });
                                        }}
                                        style={{ flex: 1, fontSize: "11px" }}
                                        title="Separator for array items"
                                      />
                                    </div>
                                  )}
                                  
                                  {/* Placeholder control */}
                                  {!part.placeholder && (
                                    <button
                                      className="button"
                                      onClick={() => {
                                        const newParts = [...row.composed!.parts];
                                        newParts[partIndex] = { ...newParts[partIndex], placeholder: "" };
                                        updateMappingRow(index, { composed: { ...row.composed!, parts: newParts } });
                                      }}
                                      style={{ fontSize: "10px", padding: "2px 6px" }}
                                    >
                                      + placeholder
                                    </button>
                                  )}
                                  {part.placeholder !== undefined && (
                                    <input
                                      className="input"
                                      type="text"
                                      placeholder="Placeholder text (leave empty to skip if missing)"
                                      value={part.placeholder}
                                      onChange={(e) => {
                                        const newParts = [...row.composed!.parts];
                                        newParts[partIndex] = { ...newParts[partIndex], placeholder: e.target.value };
                                        updateMappingRow(index, { composed: { ...row.composed!, parts: newParts } });
                                      }}
                                      style={{ fontSize: "11px" }}
                                      title="Used when field is missing"
                                    />
                                  )}
                                </div>
                              );
                            })}
                            
                            {/* Add field dropdown */}
                            <div style={{ marginTop: "12px", padding: "8px", border: "1px dashed var(--border)", borderRadius: "4px" }}>
                              <div style={{ fontSize: "11px", marginBottom: "6px", color: "var(--text-muted)" }}>Add field:</div>
                              <div style={{ display: "flex", gap: "8px" }}>
                                <select
                                  className="select"
                                  id={`compose-field-${index}`}
                                  style={{ flex: 1, fontSize: "11px" }}
                                >
                                  <option value="">-- Select Field --</option>
                                  {fields.map(f => {
                                    const alreadyAdded = row.composed!.parts.some(p => p.fieldPath === f.path);
                                    return (
                                      <option
                                        key={f.path}
                                        value={f.path}
                                        disabled={alreadyAdded}
                                        style={alreadyAdded ? { color: "var(--text-muted)", fontStyle: "italic" } : {}}
                                      >
                                        {f.path} ({f.type}){alreadyAdded ? " ✓" : ""}
                                      </option>
                                    );
                                  })}
                                </select>
                                <button
                                  className="button button-primary"
                                  onClick={() => {
                                    const select = document.getElementById(`compose-field-${index}`) as HTMLSelectElement;
                                    const fieldPath = select.value;
                                    if (!fieldPath) return;
                                    
                                    // Check for duplicate
                                    if (row.composed!.parts.some(p => p.fieldPath === fieldPath)) {
                                      select.value = "";
                                      return;
                                    }
                                    
                                    const newPart: ComposedPart = {
                                      fieldPath,
                                      arrayMaxItems: 3,
                                      arraySeparator: ", "
                                    };
                                    
                                    const newParts = [...row.composed!.parts, newPart];
                                    updateMappingRow(index, { composed: { ...row.composed!, parts: newParts } });
                                    select.value = "";
                                  }}
                                  style={{ fontSize: "11px", padding: "4px 8px" }}
                                >
                                  Add
                                </button>
                              </div>
                            </div>
                            
                            {/* Separator input */}
                            <div style={{ marginTop: "12px" }}>
                              <label className="label" style={{ fontSize: "11px", marginBottom: "4px" }}>Between fields:</label>
                              <input
                                className="input"
                                type="text"
                                placeholder="e.g., ' | '"
                                value={row.composed.separator}
                                onChange={(e) => {
                                  updateMappingRow(index, { composed: { ...row.composed!, separator: e.target.value } });
                                }}
                                style={{ fontSize: "11px" }}
                                title="Separator between each field"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <button className="button" onClick={addMappingRow} style={{ marginTop: "8px" }}>
                    ➕ Add Row
                  </button>
                </div>
                
                
                {/* Auto-refresh disabled info */}
                {autoRefreshDisabled && (
                  <div className="info-message" style={{ marginBottom: "12px", padding: "8px", fontSize: "12px", background: "var(--bg-dark)" }}>
                    ℹ️ Auto-refresh disabled. Save your mapping to lock it in.
      </div>
                )}
                
                {/* Save and Clear Mapping Buttons */}
                {mappingRows.length > 0 && (
                  <div className="button-group" style={{ marginBottom: "16px" }}>
                    <button 
                      className="button"
                      onClick={saveCurrentMapping}
                      disabled={mappingSaved}
                      style={{ flex: 1 }}
      >
                      {mappingSaved ? "✅ Saved" : "💾 Save Mapping"}
                    </button>
                    <button 
                      className="button"
                      onClick={clearMapping}
                      style={{ flex: 1 }}
                    >
                      🗑️ Clear
                    </button>
                  </div>
                )}
                
                {/* Offset/Count */}
                <div className="form-group">
                  <label className="label">Offset (skip first N items)</label>
                  <input 
                    className="input" 
                    type="number"
                    min="0"
                    value={offset}
                    onChange={(e) => setOffset(parseInt(e.target.value || "0", 10))}
                    placeholder="0"
                  />
                </div>
                
                <div className="form-group">
                  <label className="label">Count (0 = all remaining)</label>
                  <input 
                    className="input" 
                    type="number"
                    min="0"
                    value={count}
                    onChange={(e) => setCount(parseInt(e.target.value || "0", 10))}
                    placeholder="0"
                  />
              </div>
                
                {/* Mode Selector */}
                <div className="form-group">
                  <label className="label">Population Mode</label>
                  <div className="radio-group">
                    <label className="radio-label">
                      <input
                        type="radio"
                        name="mapMode"
                        value="multi-frame"
                        checked={mapMode === "multi-frame"}
                        onChange={(e) => setMapMode(e.target.value as MapMode)}
                      />
                      <span>Multi-frame (each selected frame gets data in sequence)</span>
                    </label>
                    <label className="radio-label">
                      <input
                        type="radio"
                        name="mapMode"
                        value="single-frame"
                        checked={mapMode === "single-frame"}
                        onChange={(e) => setMapMode(e.target.value as MapMode)}
                      />
                      <span>Single-frame (selected frame's children get data)</span>
                    </label>
              </div>
            </div>
                
                <div className="button-group">
                  <button 
                    className="button button-primary" 
                    onClick={applyMapping}
                    disabled={
                      !hits.length || 
                      mappingRows.every(r => {
                        // Row is invalid if it doesn't have a layer
                        if (!r.layerId) return true;
                        
                        // Row is valid if it has either:
                        // - A fieldPath (single-field or image)
                        // - OR composed config with parts
                        const hasFieldPath = !!r.fieldPath;
                        const hasComposed = r.composed && r.composed.parts.length > 0;
                        
                        return !hasFieldPath && !hasComposed;
                      })
                    }
                  >
                    ⚡ Apply Mapping
                  </button>
                </div>
              </>
            )}
          </div>
      </div>
      )}
    </div>
  );
}

console.log('[UI] Starting React render to #root');
const rootEl = document.getElementById("root");
console.log('[UI] Root element:', rootEl);
ReactDOM.render(<App />, rootEl);
