import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom";
import "./ui.css";

const BRANDS = ["tcm", "dc", "hbo"] as const;
type SourceKey = "tcm" | "dc" | "hbo";
type BrowseStage = "select" | "detail";
type MapMode = "multi-frame" | "single-frame";

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
    out[prefix || "[]"] = obj;
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
const DEFAULT_PROXY_URL = "https://figma-plugin-poc.vercel.app/api/graphql"; // Using QA for fresh data

// Optional: allow ?proxy=http://localhost:3000/api/graphql for quick switching
const PROXY_URL =
  new URLSearchParams(location.search).get("proxy") || DEFAULT_PROXY_URL;

const GQL = `
query FeatureGrid($brand: String!, $size: Int = 24, $scrollId: String, $allowUnpublishedContent: Boolean = false) {
  featureScroll(brand: $brand, size: $size, scrollId: $scrollId, allowUnpublishedContent: $allowUnpublishedContent) {
    hits {
      id
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
    allowUnpublishedContent: false,
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

function App() {
  // Tab state
  const [activeTab, setActiveTab] = useState<"browse" | "map">("browse");
  
  // Browse tab state
  const [browseStage, setBrowseStage] = useState<BrowseStage>("select");
  const [selectedSource, setSelectedSource] = useState<SourceKey | undefined>(undefined);
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  
  // Map tab state
  const [mapMode, setMapMode] = useState<MapMode>("multi-frame");
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [mappingRows, setMappingRows] = useState<MappingRow[]>([
    { fieldPath: "title", kind: "text" },
    { fieldPath: "imageUrl", kind: "image" },
  ]);
  const [offset, setOffset] = useState<number>(0);
  const [count, setCount] = useState<number>(0);
  
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
        setLayers(m.layers);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  
  // Introspect selection when entering Map tab
  useEffect(() => {
    if (activeTab === "map") {
      parent.postMessage({ pluginMessage: { type: "INTROSPECT_SELECTION" } }, "*");
    }
  }, [activeTab]);

  const connectToSource = async () => {
    if (!selectedSource) return;
    setLoading(true);
    setErr(null);
    try {
      const data = await runQuery(selectedSource, 24);
      setHits(data.hits || []);
      setBrowseStage("detail");
    } catch (e: any) {
      setErr(e?.message || "Failed to load source");
    } finally {
      setLoading(false);
    }
  };
  
  const applyMapping = () => {
    if (!selectedSource || hits.length === 0) return;
    
    const items = hits.map(h => normalize(h, selectedSource));
    
    // Convert rows to pairs
    const pairs = mappingRows
      .filter(row => row.fieldPath && row.layerId && row.kind)
      .map(row => ({
        layerId: row.layerId!,
        kind: row.kind!,
        field: row.fieldPath!,
        transform: {
          fallback: row.fallback,
          join: row.join,
          truncate: row.truncate,
          uppercase: row.uppercase,
        }
      }));
    
    if (pairs.length === 0) {
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
      }
    }, "*");
  };
  
  // Extract fields from data
  const getFieldsFromData = (): FieldInfo[] => {
    if (hits.length === 0 || !selectedSource) return [];
    
    const firstItem = normalize(hits[0], selectedSource);
    const fields: FieldInfo[] = [];
    
    for (const key in firstItem) {
      const value = firstItem[key];
      let type: string = typeof value;
      if (Array.isArray(value)) type = "array";
      fields.push({ path: key, type });
    }
    
    return fields;
  };
  
  const addMappingRow = () => {
    setMappingRows([...mappingRows, {}]);
  };
  
  const removeMappingRow = (index: number) => {
    setMappingRows(mappingRows.filter((_, i) => i !== index));
  };
  
  const updateMappingRow = (index: number, updates: Partial<MappingRow>) => {
    const newRows = [...mappingRows];
    newRows[index] = { ...newRows[index], ...updates };
    
    // Auto-set kind based on layer capability
    if (updates.layerId) {
      const layer = layers.find(l => l.id === updates.layerId);
      if (layer) {
        if (layer.textCapable && !layer.imageFillCapable) {
          newRows[index].kind = "text";
        } else if (layer.imageFillCapable && !layer.textCapable) {
          newRows[index].kind = "image";
        }
      }
    }
    
    setMappingRows(newRows);
  };

  const fields = getFieldsFromData();
  
  return (
    <div className="container">
      <div className="header">✨ Gridddly</div>
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
                  return (
                    <div key={hit.id} className="item-card">
                      <div className="item-props">
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
            
            {layers.length === 0 && (
              <div className="info-message" style={{ padding: "16px", textAlign: "center" }}>
                Select a frame or multiple layers in Figma to start mapping.
              </div>
            )}
            
            {layers.length > 0 && (
              <>
                <div className="info-message" style={{ marginBottom: "12px", padding: "8px", fontSize: "12px" }}>
                  Found {layers.length} layer{layers.length !== 1 ? "s" : ""} in selection
                </div>
                
                {/* Mapping Table */}
                <div className="mapping-table" style={{ marginBottom: "16px" }}>
                  {mappingRows.map((row, index) => (
                    <div key={index} className="mapping-row" style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
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
                        style={{ padding: "4px 8px", minWidth: "auto" }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  
                  <button className="button" onClick={addMappingRow} style={{ marginTop: "8px" }}>
                    ➕ Add Row
                  </button>
                </div>
                
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
