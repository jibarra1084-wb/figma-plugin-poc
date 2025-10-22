/// <reference types="@figma/plugin-typings" />

console.log('Gridddly build timestamp:', Date.now());

// Load UI (will be replaced with actual HTML by build script)
figma.showUI(__html__, { width: 420, height: 650 });

// ==================== TYPES ====================

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

type FieldTransform = {
  fallback?: string;
  join?: string;      // For array fields, join with this separator
  truncate?: number;  // Max length
  uppercase?: boolean;
};

type FieldToLayer = {
  layerId: string;
  kind: "text" | "image";
  field: string;  // e.g. "title", "imageUrl", "genres"
  transform?: FieldTransform;
};

// ==================== EXISTING HELPERS ====================

async function setText(node: TextNode | undefined | null, value?: string) {
  if (!node || !value) return;
  
  // Handle mixed fonts safely
  const fn = node.fontName;
  if (fn === figma.mixed) {
    // Load font of first character if mixed
    const firstCharFont = node.getRangeFontName(0, 1);
    if (firstCharFont !== figma.mixed) {
      await figma.loadFontAsync(firstCharFont as FontName);
    }
  } else {
    await figma.loadFontAsync(fn as FontName);
  }
  
  node.characters = value;
}

async function setImageFill(shape: GeometryMixin | undefined | null, url?: string, brand?: string) {
  if (!shape) return;
  
  // If no URL, use brand-specific placeholder color
  if (!url) {
    const brandColors: { [key: string]: RGB } = {
      DC: { r: 0.0, g: 0.47, b: 0.95 },      // DC Blue
      TCM: { r: 0.85, g: 0.65, b: 0.13 },    // TCM Gold
      HBO: { r: 0.53, g: 0.25, b: 0.85 },    // HBO Purple
      MAX: { r: 0.0, g: 0.4, b: 1.0 },       // MAX Blue
    };
    
    const color = brandColors[brand?.toUpperCase() || "DC"] || { r: 0.2, g: 0.2, b: 0.2 }; // Default gray
    
    const solidFill: SolidPaint = {
      type: "SOLID",
      color: color,
      opacity: 1.0, // Full opacity so it's clearly visible
    };
    
    (shape as GeometryMixin).fills = [solidFill];
    console.log(`[${brand}] Applied ${brand?.toUpperCase()} placeholder (${color.r}, ${color.g}, ${color.b}) to node type: ${(shape as any).type}`);
    return;
  }
  
  try {
    // Use Vercel image proxy to bypass CDN CORS restrictions
    const proxyUrl = `https://figma-plugin-poc.vercel.app/api/image-proxy?url=${encodeURIComponent(url)}`;
    
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const bytes = await res.arrayBuffer();
    const img = figma.createImage(new Uint8Array(bytes));
    const fills: ImagePaint[] = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FILL" }];
    (shape as GeometryMixin).fills = fills;
  } catch (error) {
    // Gracefully fail - use placeholder color instead
    console.warn(`Failed to load image from ${url}, using placeholder:`, error);
    
    const brandColors: { [key: string]: RGB } = {
      DC: { r: 0.0, g: 0.47, b: 0.95 },
      TCM: { r: 0.85, g: 0.65, b: 0.13 },
      HBO: { r: 0.53, g: 0.25, b: 0.85 },
      MAX: { r: 0.0, g: 0.4, b: 1.0 },
    };
    
    const color = brandColors[brand || "DC"] || { r: 0.2, g: 0.2, b: 0.2 };
    const solidFill: SolidPaint = { type: "SOLID", color: color, opacity: 0.3 };
    (shape as GeometryMixin).fills = [solidFill];
  }
}

function findByName(node: SceneNode, name: string): SceneNode | null {
  const container = node as FrameNode | ComponentNode | InstanceNode;
  if (container && typeof (container as any).findOne === "function") {
    return (container as any).findOne((n: SceneNode) => n.name === name) as SceneNode | null;
  }
  return null;
}

// ==================== MAPPING STORAGE ====================

async function saveMapping(brand: string, mapping: Mapping): Promise<void> {
  const key = `gridddly:mappings:${brand}`;
  await figma.clientStorage.setAsync(key, mapping);
}

async function loadMapping(brand: string): Promise<Mapping | null> {
  const key = `gridddly:mappings:${brand}`;
  const mapping = await figma.clientStorage.getAsync(key);
  return mapping || null;
}

// ==================== CARD TRAVERSAL & MAPPING ====================

function findMappedNodes(cardNode: SceneNode, mapping: Mapping) {
  return {
    titleNode: findByName(cardNode, mapping.titleNode) as TextNode | null,
    metaNode: findByName(cardNode, mapping.metaNode) as TextNode | null,
    posterNode: findByName(cardNode, mapping.posterNode) as (RectangleNode | FrameNode | InstanceNode) | null,
  };
}

function getTargetCards(mapping?: Mapping): SceneNode[] {
  const selection = figma.currentPage.selection;
  
  // Multi-selection mode: each selected item is a card
  if (selection.length > 1) {
    return selection.slice();
  }
  
  // Single container mode: find children that could be cards
  if (selection.length === 1) {
    const container = selection[0];
    
    // If it's a frame/group, treat its children as cards
    if (container.type === "FRAME" || container.type === "GROUP" || container.type === "COMPONENT") {
      const children = (container as FrameNode).children || [];
      if (children.length > 0) {
        // Sort by position (top-to-bottom, left-to-right)
        return children.slice().sort((a, b) => {
          const yDiff = a.y - b.y;
          if (Math.abs(yDiff) > 10) return yDiff; // Different rows
          return a.x - b.x; // Same row, sort by x
        });
      }
    }
    
    // Single card mode
    return [container];
  }
  
  return [];
}

// ==================== POPULATION ====================

async function populateCard(card: SceneNode, mapping: Mapping, item: any): Promise<void> {
  const { titleNode, metaNode, posterNode } = findMappedNodes(card, mapping);
  
  // Populate title
  if (titleNode && item.title) {
    await setText(titleNode, item.title);
  }
  
  // Build and populate meta
  if (metaNode) {
    const genres = Array.isArray(item.genres) ? item.genres.slice(0, 2).join(" • ") : "";
    const metaParts: string[] = [];
    if (item.year) metaParts.push(String(item.year));
    if (genres) metaParts.push(genres);
    if (item.runtimeDisplay) metaParts.push(item.runtimeDisplay);
    if (item.advisory) metaParts.push(item.advisory);
    const meta = metaParts.join(" • ");
    await setText(metaNode, meta);
  }
  
  // Populate poster image (or placeholder if no image)
  if (posterNode) {
    await setImageFill(posterNode as any, item.imageUrl, item.brand);
  } else {
    console.warn(`[${item.brand}] No poster node found for "${item.title}". Looking for layer named: "${mapping.posterNode}"`);
  }
}

// ==================== SELECTION INTROSPECTION ====================

function getLayerPath(node: SceneNode): string {
  const parts: string[] = [];
  let current: BaseNode | null = node;
  
  while (current && current.type !== "PAGE") {
    if ("name" in current) {
      parts.unshift(current.name);
    }
    current = current.parent;
  }
  
  return parts.join(" > ");
}

function isImageFillCapable(node: SceneNode): boolean {
  return "fills" in node && node.type !== "TEXT";
}

function introspectSelection(): LayerInfo[] {
  const selection = figma.currentPage.selection;
  const layers: LayerInfo[] = [];
  
  if (selection.length === 0) {
    return layers;
  }
  
  // Single container: introspect children
  if (selection.length === 1) {
    const node = selection[0];
    if (node.type === "FRAME" || node.type === "GROUP" || node.type === "COMPONENT" || node.type === "INSTANCE") {
      const container = node as FrameNode | GroupNode | ComponentNode | InstanceNode;
      for (const child of container.children) {
        layers.push({
          id: child.id,
          name: child.name,
          type: child.type,
          path: getLayerPath(child),
          textCapable: child.type === "TEXT",
          imageFillCapable: isImageFillCapable(child),
          locked: "locked" in child ? child.locked : undefined,
        });
      }
      return layers;
    }
  }
  
  // Multi-selection: introspect each selected node
  for (const node of selection) {
    layers.push({
      id: node.id,
      name: node.name,
      type: node.type,
      path: getLayerPath(node),
      textCapable: node.type === "TEXT",
      imageFillCapable: isImageFillCapable(node),
      locked: "locked" in node ? node.locked : undefined,
    });
  }
  
  return layers;
}

// ==================== APPLY MAPPING BY ID ====================

function applyTransform(value: any, transform?: FieldTransform): string {
  let result = value;
  
  // Handle arrays
  if (Array.isArray(result)) {
    result = transform?.join ? result.join(transform.join) : result.join(", ");
  }
  
  // Convert to string
  result = String(result || "");
  
  // Apply fallback if empty
  if (!result && transform?.fallback) {
    result = transform.fallback;
  }
  
  // Uppercase
  if (transform?.uppercase) {
    result = result.toUpperCase();
  }
  
  // Truncate
  if (transform?.truncate && result.length > transform.truncate) {
    result = result.substring(0, transform.truncate) + "...";
  }
  
  return result;
}

async function applyMappingById(pairs: FieldToLayer[], items: any[], offset: number, count: number): Promise<{ success: number; failed: number }> {
  const startIdx = Math.max(0, offset);
  const endIdx = count ? Math.min(items.length, startIdx + count) : items.length;
  const itemsToUse = items.slice(startIdx, endIdx);
  
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < itemsToUse.length; i++) {
    const item = itemsToUse[i];
    
    for (const pair of pairs) {
      try {
        const node = figma.getNodeById(pair.layerId);
        
        if (!node) {
          console.warn(`Node ${pair.layerId} not found, skipping`);
          continue;
        }
        
        if ("locked" in node && node.locked) {
          console.warn(`Node ${pair.layerId} (${node.name}) is locked, skipping`);
          continue;
        }
        
        const fieldValue = item[pair.field];
        
        if (pair.kind === "text" && node.type === "TEXT") {
          const textNode = node as TextNode;
          const transformedValue = applyTransform(fieldValue, pair.transform);
          
          // Load font
          const fn = textNode.fontName;
          if (fn === figma.mixed) {
            const firstCharFont = textNode.getRangeFontName(0, 1);
            if (firstCharFont !== figma.mixed) {
              await figma.loadFontAsync(firstCharFont as FontName);
            }
          } else {
            await figma.loadFontAsync(fn as FontName);
          }
          
          textNode.characters = transformedValue;
          successCount++;
        } else if (pair.kind === "image" && "fills" in node) {
          const url = applyTransform(fieldValue, pair.transform);
          if (url) {
            await setImageFill(node as any, url, item.brand);
            successCount++;
          }
        }
      } catch (error) {
        console.error(`Failed to apply ${pair.field} to ${pair.layerId}:`, error);
        failCount++;
      }
    }
  }
  
  return { success: successCount, failed: failCount };
}

// ==================== MESSAGE HANDLER ====================

figma.ui.onmessage = async (msg) => {
  if (!msg || !msg.type) return;

  // ===== SINGLE POPULATE (existing behavior) =====
  if (msg.type === "populate") {
    const items = (msg.items as any[]) || [];
    const selection = figma.currentPage.selection;
    if (!selection.length) { 
      figma.notify("Select a card/frame to populate."); 
      return; 
    }
    if (items.length === 0) { 
      figma.notify("No items to populate."); 
      return; 
    }

    const target = selection[0];
    const titleNode = findByName(target, "Title") as TextNode | null;
    const metaNode  = findByName(target, "Meta")  as TextNode | null;
    const poster    = findByName(target, "Poster") as RectangleNode | null;

    const item = items[0];

    await setText(titleNode || undefined, item.title);

    const genres = Array.isArray(item.genres) ? item.genres.slice(0, 2).join(" • ") : "";
    const metaParts: string[] = [];
    if (item.year) metaParts.push(String(item.year));
    if (genres) metaParts.push(genres);
    if (item.runtimeDisplay) metaParts.push(item.runtimeDisplay);
    if (item.advisory) metaParts.push(item.advisory);
    const meta = metaParts.join(" • ");

    await setText(metaNode || undefined, meta);
    await setImageFill(poster || undefined, item.imageUrl);

    figma.notify("Populated 1 item.");
  }

  // ===== SAVE MAPPING =====
  if (msg.type === "SAVE_MAPPING") {
    const { brand, mapping } = msg;
    if (!brand || !mapping) {
      figma.notify("⚠️ Missing brand or mapping data.");
      return;
    }
    
    try {
      await saveMapping(brand, mapping as Mapping);
      figma.notify(`✅ Mapping saved for ${brand.toUpperCase()}`);
      figma.ui.postMessage({ type: "MAPPING_SAVED", brand });
    } catch (err) {
      figma.notify("⚠️ Failed to save mapping.");
      console.error("Save mapping error:", err);
    }
  }

  // ===== LOAD MAPPING =====
  if (msg.type === "LOAD_MAPPING") {
    const { brand } = msg;
    if (!brand) {
      figma.notify("⚠️ Missing brand.");
      return;
    }
    
    try {
      const mapping = await loadMapping(brand);
      figma.ui.postMessage({ 
        type: "MAPPING_LOADED", 
        brand, 
        mapping: mapping || { titleNode: "Title", metaNode: "Meta", posterNode: "Poster" } 
      });
    } catch (err) {
      figma.notify("⚠️ Failed to load mapping.");
      console.error("Load mapping error:", err);
    }
  }

  // ===== MULTI POPULATE =====
  if (msg.type === "MULTI_POPULATE") {
    const { items, mapping, offset = 0, count } = msg;
    
    if (!items || items.length === 0) {
      figma.notify("⚠️ No items to populate.");
      return;
    }
    
    if (!mapping) {
      figma.notify("⚠️ No field mapping defined.");
      return;
    }

    const cards = getTargetCards(mapping);
    if (cards.length === 0) {
      figma.notify("⚠️ No cards selected.");
      return;
    }

    // Apply offset and count
    const startIdx = Math.max(0, offset);
    const endIdx = count ? Math.min(items.length, startIdx + count) : items.length;
    const itemsToUse = items.slice(startIdx, endIdx);
    const cardsToUse = cards.slice(0, itemsToUse.length);

    figma.notify(`⏳ Populating ${cardsToUse.length} cards...`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < cardsToUse.length; i++) {
      try {
        await populateCard(cardsToUse[i], mapping as Mapping, itemsToUse[i]);
        successCount++;
      } catch (err) {
        failCount++;
        console.error(`Failed to populate card ${i}:`, err);
      }
    }

    if (failCount === 0) {
      figma.notify(`✅ Populated ${successCount} cards!`);
    } else {
      figma.notify(`⚠️ Populated ${successCount} cards, ${failCount} failed.`);
    }
    
    figma.ui.postMessage({ type: "MULTI_POPULATE_COMPLETE", successCount, failCount });
  }

  // ===== INTROSPECT SELECTION =====
  if (msg.type === "INTROSPECT_SELECTION") {
    const layers = introspectSelection();
    figma.ui.postMessage({ type: "SELECTION_INTROSPECTED", layers });
  }

  // ===== APPLY MAPPING BY ID =====
  if (msg.type === "APPLY_MAPPING") {
    const { brand, pairs, items, offset = 0, count = 0 } = msg;
    
    if (!pairs || pairs.length === 0) {
      figma.notify("⚠️ No field mappings defined.");
      return;
    }
    
    if (!items || items.length === 0) {
      figma.notify("⚠️ No items to populate.");
      return;
    }

    figma.notify(`⏳ Applying mappings...`);

    const result = await applyMappingById(pairs, items, offset, count);

    if (result.failed === 0) {
      figma.notify(`✅ Applied ${result.success} mappings!`);
    } else {
      figma.notify(`⚠️ Applied ${result.success} mappings, ${result.failed} failed.`);
    }
    
    figma.ui.postMessage({ 
      type: "APPLY_MAPPING_COMPLETE", 
      success: result.success, 
      failed: result.failed 
    });
  }
};
