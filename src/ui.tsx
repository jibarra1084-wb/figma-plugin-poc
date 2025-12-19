import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom";
import "./ui.css";

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

type MappingRow = {
  fieldPath?: string;
  layerId?: string;
  layerName?: string; // Store layer name for re-matching across designs
  kind?: "text" | "image";
  join?: string;
  truncate?: number;
  uppercase?: boolean;
  fallback?: string;
};

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

const GQL = `
query FeatureGrid($brand: String!, $size: Int = 24, $scrollId: String) {
  featureScroll(brand: $brand, size: $size, scrollId: $scrollId) {
    hits {
      id
      titleId
      title { short full }
      releaseYear
      runtime
      runtimeDisplay
      runtimeFormatted
      genres
      contentAdvisories
      ratingCode
      mpaaRatingCode
      featuredImage { 
        imageUrl 
        cuts { url }
      }
      images
    }
    scrollId
  }
}
`;

const GQL_REFERENCED_VIDEOS = `
query getReferencedVideosByContentId($featureId: String!, $brand: String!) {
  search(
    queryString: "type:video AND brand:{{$brand}} AND references.handle.gepContentId:\\"{{$featureId}}\\""
    count: 20
    sort: { field: "lifecycle.date.firstPublishedDate", order: desc }
    allowUnpublishedContent: false
  )
    @tmplStrVar(key: "$featureId", value: $featureId)
    @tmplStrVar(key: "$brand", value: $brand) {
    ... on Video {
      title { short }
      summary { short }
      videoType
      lifecycle { date { firstPublishedDate } }
      featuredVideo { videoUrl videoDurationFormatted(format: "mm:ss") }
      featuredImage { cuts(sizes: ["3:2"]) { size url } }
    }
  }
}
`;

// Test query - simple search without reference filter
const GQL_TEST_VIDEOS = `
query testVideoSearch($brand: String!) {
  search(
    queryString: "type:video AND brand:{{$brand}}"
    count: 5
    allowUnpublishedContent: false
  )
    @tmplStrVar(key: "$brand", value: $brand) {
    ... on Video {
      id
      title { short }
      videoType
    }
  }
}
`;

type Hit = {
  id: string;
  title?: { short?: string; full?: string };
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
    cuts?: Array<{ url?: string | null }> | null;
  } | null;
  images?: Record<string, string> | null;
};

const parseSecs = (val?: string | number | null) => {
  if (val == null) return undefined;
  const s = typeof val === "string" ? parseInt(val, 10) : val;
  if (Number.isNaN(s)) return undefined;
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

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

  return {
    id: h.id,
    title,
    year: h.releaseYear == null ? undefined : h.releaseYear,
    genres: (h.genres || []).slice(0, 2),
    advisory,
    runtimeDisplay,
    imageUrl,
    brand, // Include brand for placeholder colors
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

  return (json.data && json.data.featureScroll
    ? json.data.featureScroll
    : { hits: [], scrollId: undefined }) as { hits: Hit[]; scrollId?: string };
}

// ---- Fetch referenced videos by content ID ----
async function runReferencedVideos(brand: SourceKey, featureId: string): Promise<any[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000); // 12s timeout

  const variables = {
    brand: brand.toUpperCase(),
    featureId,
    _cacheBust: Date.now()
  };
  
  console.log('[Related Videos API] Sending request with variables:', variables);
  console.log('[Related Videos API] Query:', GQL_REFERENCED_VIDEOS.substring(0, 200) + '...');

  let res: Response;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        query: GQL_REFERENCED_VIDEOS, 
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

  const variables = {
    brand: brand.toUpperCase(),
    _cacheBust: Date.now()
  };

  let res: Response;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        query: GQL_TEST_VIDEOS, 
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

  // Related videos state (per content ID)
  const [relatedById, setRelatedById] = useState<Record<string, any[]>>({});
  const [relatedLoadingById, setRelatedLoadingById] = useState<Record<string, boolean>>({});
  const [relatedErrById, setRelatedErrById] = useState<Record<string, string | null>>({});
  const [relatedOpenById, setRelatedOpenById] = useState<Record<string, boolean>>({});

  // Active content context (for Map tab to know which content's videos to use)
  const [activeContentId, setActiveContentId] = useState<string | null>(null);
  const [activeContentTitle, setActiveContentTitle] = useState<string | null>(null);

  // Track which items have "Show raw fields" expanded
  const [showRawFieldsById, setShowRawFieldsById] = useState<Record<string, boolean>>({});

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
    }
  }, [browseStage]);

  const connectToSource = async () => {
    if (!selectedSource) return;
    setLoading(true);
    setErr(null);
    try {
      const data = await runQuery(selectedSource, 24);
      const hits = data.hits || [];
      
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

  const toggleRelatedVideos = async (contentId: string, titleId: string | undefined, contentTitle: string) => {
    if (!selectedSource) return;
    
    // Toggle open/close
    const isCurrentlyOpen = relatedOpenById[contentId];
    
    if (isCurrentlyOpen) {
      // Close it
      setRelatedOpenById({ ...relatedOpenById, [contentId]: false });
      return;
    }
    
    // Open and set as active content
    setRelatedOpenById({ ...relatedOpenById, [contentId]: true });
    setActiveContentId(contentId);
    setActiveContentTitle(contentTitle);
    
    // If already fetched, just open
    if (relatedById[contentId]) {
      return;
    }
    
    // Fetch related videos using titleId (preferred) or fallback to contentId
    const searchId = titleId || contentId;
    setRelatedLoadingById({ ...relatedLoadingById, [contentId]: true });
    setRelatedErrById({ ...relatedErrById, [contentId]: null });
    
    try {
      console.log(`[Related Videos] Fetching for titleId: ${titleId}, contentId: ${contentId}, brand: ${selectedSource}`);
      console.log(`[Related Videos] Using searchId: ${searchId}`);
      const videos = await runReferencedVideos(selectedSource, searchId);
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
      
      setRelatedById({ ...relatedById, [contentId]: videos });
    } catch (e: any) {
      console.error(`[Related Videos] Error:`, e);
      setRelatedErrById({ ...relatedErrById, [contentId]: e?.message || "Failed to load related videos" });
    } finally {
      setRelatedLoadingById({ ...relatedLoadingById, [contentId]: false });
    }
  };

  const applyMapping = () => {
    if (!selectedSource) return;
    
    // Determine data source based on selected dataset
    let dataSource: any[] = [];
    
    if (mapDataset === "content") {
      if (hits.length === 0) return;
      dataSource = hits;
    } else if (mapDataset === "relatedVideos") {
      if (!activeContentId || !relatedById[activeContentId] || relatedById[activeContentId].length === 0) {
        console.error("No related videos loaded for active content");
        return;
      }
      dataSource = relatedById[activeContentId];
    }
    
    // Use flattened raw data so field paths like "title.short" work
    const items = dataSource.map(h => {
      const flattened = flatten(h);
      // Add brand for placeholder colors
      return { ...flattened, brand: selectedSource };
    });
    
    // Convert rows to pairs, including layer names
    const pairs = mappingRows
      .filter(row => row.fieldPath && row.layerId && row.kind)
      .map(row => {
        const layer = layers.find(l => l.id === row.layerId);
        // Use saved layerName if available, otherwise get from current layers
        const layerName = row.layerName || layer?.name || "";
        
        if (!layerName) {
          console.warn(`Cannot find layer name for layer ID: ${row.layerId}`);
        }
        
        return {
          layerId: row.layerId!,
          layerName,
          kind: row.kind!,
          field: row.fieldPath!,
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
    
    parent.postMessage({
      pluginMessage: {
        type: "APPLY_MAPPING",
        brand: selectedSource,
        pairs,
        items,
        offset: Number(offset) || 0,
        count: Number(count) || 0,
        mapMode, // Pass the selected mode to backend
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
  const getFieldsFromData = (): FieldInfo[] => {
    if (!selectedSource) return [];
    
    // Determine data source based on selected dataset
    let dataSource: any[] = [];
    
    if (mapDataset === "content") {
      if (hits.length === 0) return [];
      dataSource = hits;
    } else if (mapDataset === "relatedVideos") {
      if (!activeContentId || !relatedById[activeContentId] || relatedById[activeContentId].length === 0) {
        return [];
      }
      dataSource = relatedById[activeContentId];
    }
    
    // Use flattened raw data to show ALL fields from API
    const firstItem = flatten(dataSource[0]);
    const fieldMap = new Map<string, FieldInfo>();
    
    for (const key in firstItem) {
      const value = firstItem[key];
      let type: string = typeof value;
      if (Array.isArray(value)) type = "array";
      
      // Use Map to automatically deduplicate by key
      if (!fieldMap.has(key)) {
        fieldMap.set(key, { path: key, type });
      }
    }
    
    // Convert to array and sort alphabetically for easier browsing
    const fields = Array.from(fieldMap.values());
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
        
        if (layer.textCapable && !layer.imageFillCapable) {
          newRows[index].kind = "text";
        } else if (layer.imageFillCapable && !layer.textCapable) {
          newRows[index].kind = "image";
        }
      }
    }
    
    setMappingRows(newRows);
    setMappingSaved(false);
    setAutoRefreshDisabled(true);
  };

  const fields = getFieldsFromData();

  return (
    <div className="container">
      <div className="header">
        <span>✨ Gridddly</span>
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

              {/* Item list */}
              {loading && <div className="info-message">Loading…</div>}
              {!loading && !hits.length && <div className="info-message">No results.</div>}

              <div className="item-list">
                {hits.map((hit) => {
                  const flat = flatten(hit);
                  const entries = Object.entries(flat);
                  const title = flat['title.short'] || flat['title.full'] || 'Untitled';
                  const titleId = flat['titleId'];
                  const imageUrl = flat['featuredImage.imageUrl'] || flat['featuredImage.cuts.0.url'];
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
                          <div style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "monospace" }}>
                            {titleId && <div>titleId: {titleId}</div>}
                            <div>ID: {hit.id}</div>
                          </div>
                          {(year || genres) && (
                            <div style={{ fontSize: "12px", marginTop: "4px" }}>
                              {year && <span>{year}</span>}
                              {year && genres && <span> • </span>}
                              {genres && Array.isArray(genres) && <span>{genres.slice(0, 2).join(", ")}</span>}
                            </div>
                          )}
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
                          {relatedLoadingById[hit.id] && " ..."}
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
                      {isRelatedOpen && (
                        <div style={{ marginBottom: "12px", padding: "12px", background: "var(--bg-dark)", borderRadius: "4px" }}>
                          {relatedLoadingById[hit.id] && (
                            <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Loading related videos...</div>
                          )}
                          {relatedErrById[hit.id] && (
                            <div style={{ fontSize: "12px", color: "var(--error)" }}>⚠️ {relatedErrById[hit.id]}</div>
                          )}
                          {relatedById[hit.id] && relatedById[hit.id].length === 0 && (
                            <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>No related videos found</div>
                          )}
                          {relatedById[hit.id] && relatedById[hit.id].length > 0 && (
                            <div>
                              <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "8px" }}>
                                {relatedById[hit.id].length} related video{relatedById[hit.id].length !== 1 ? 's' : ''}
                              </div>
                              {relatedById[hit.id].map((video: any, idx: number) => {
                                const vFlat = flatten(video);
                                const vTitle = vFlat['title.short'] || 'Untitled';
                                const vThumb = vFlat['featuredImage.cuts.0.url'];
                                const vDuration = vFlat['featuredVideo.videoDurationFormatted'];
                                const vType = vFlat['videoType'];
                                const vDate = vFlat['lifecycle.date.firstPublishedDate'];
                                
                                return (
                                  <div key={idx} style={{ display: "flex", gap: "8px", marginBottom: "8px", paddingBottom: "8px", borderBottom: idx < relatedById[hit.id].length - 1 ? "1px solid var(--border)" : "none" }}>
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
                                        {vDate && <span> • {new Date(vDate).toLocaleDateString()}</span>}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                      
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
                Using data from: <strong>{selectedSource.toUpperCase()}</strong> ({hits.length} items loaded)
              </div>
            ) : (
              <div className="data-source-banner warning">
                ⚠️ Load data from Browse tab first
              </div>
            )}
            
            {/* Dataset Selector */}
            {selectedSource && hits.length > 0 && (
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
                    <span>Content items ({hits.length} loaded)</span>
                  </label>
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="mapDataset"
                      value="relatedVideos"
                      checked={mapDataset === "relatedVideos"}
                      onChange={(e) => setMapDataset(e.target.value as MapDataset)}
                      disabled={!activeContentId || !relatedById[activeContentId]}
                    />
                    <span>
                      Related videos
                      {activeContentId && relatedById[activeContentId] && 
                        ` for "${activeContentTitle}" (${relatedById[activeContentId].length} loaded)`
                      }
                      {(!activeContentId || !relatedById[activeContentId]) && 
                        " (click 'View related' in Browse tab first)"
                      }
                    </span>
                  </label>
                </div>
              </div>
            )}
            
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
                
                {/* Mapping Table */}
                <div className="mapping-table" style={{ marginBottom: "16px" }}>
                  {mappingRows.map((row, index) => {
                    const selectedField = fields.find(f => f.path === row.fieldPath);
                    const isArrayField = selectedField?.type === "array";
                    
                    return (
                      <div key={index} style={{ marginBottom: "16px", padding: "12px", border: "1px solid var(--border)", borderRadius: "4px" }}>
                        <div className="mapping-row" style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
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
                        
                        {/* Transform options */}
                        {row.fieldPath && (
                          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", fontSize: "12px" }}>
                            {isArrayField && (
                              <input
                                className="select"
                                type="text"
                                placeholder="Join with (e.g., ' • ')"
                                value={row.join || ""}
                                onChange={(e) => updateMappingRow(index, { join: e.target.value })}
                                style={{ flex: "1 1 120px", fontSize: "12px" }}
                                title="Separator for array values"
                              />
                            )}
                            <input
                              className="select"
                              type="text"
                              placeholder="Fallback value"
                              value={row.fallback || ""}
                              onChange={(e) => updateMappingRow(index, { fallback: e.target.value })}
                              style={{ flex: "1 1 120px", fontSize: "12px" }}
                              title="Value to use if field is empty"
                            />
                            <input
                              className="select"
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
                    className="select" 
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
                    className="select" 
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
                    disabled={!hits.length || mappingRows.every(r => !r.fieldPath || !r.layerId)}
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
