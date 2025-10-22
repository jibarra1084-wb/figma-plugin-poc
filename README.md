# Figma Plugin POC

Browse and map content from Warner Bros. Discovery brands into Figma.

A Figma plugin built with TypeScript, Vite, and React.

## Project Structure

```
figma-plugin-poc/
├── api/
│   └── graphql.ts     # Vercel serverless function (GraphQL proxy)
├── src/
│   ├── main.ts        # Figma main thread code
│   ├── ui.tsx         # React UI component
│   ├── ui.css         # UI styles
│   └── manifest.json  # Plugin manifest (v2)
├── ui.html            # HTML entry point for Vite
├── vite.config.ts     # Vite configuration
├── vercel.json        # Vercel configuration
├── tsconfig.json      # TypeScript configuration
└── package.json       # Dependencies and scripts
```

## Setup

Install dependencies:

```bash
npm install
```

## Development

Run the development server with watch mode for both UI and main code:

```bash
npm run dev
```

Or run them separately:

```bash
# Run UI dev server
npm run ui

# Watch main.ts compilation
npm run main
```

## Build

Build the plugin for production:

```bash
npm run build
```

This will generate:
- `dist/ui.html` - Plugin UI
- `dist/ui.js` - Bundled UI JavaScript
- `dist/ui.css` - UI styles
- `dist/main.js` - Main thread code

## Loading the Plugin in Figma

1. Run `npm run build` to build the plugin
2. Open Figma desktop app
3. Go to `Plugins` > `Development` > `Import plugin from manifest...`
4. Select the `src/manifest.json` file
5. The plugin will now appear in `Plugins` > `Development`

## Scripts

- `npm run dev` - Run both UI and main in watch mode (parallel)
- `npm run ui` - Run Vite dev server for UI
- `npm run main` - Compile main.ts in watch mode
- `npm run build` - Build both UI and main for production
- `npm run build:ui` - Build UI only
- `npm run build:main` - Build main code only

## Features

This plugin provides:
- **Feature Grid Panel**: Browse and query features from a GraphQL API
  - Filter by brand (TCM, DC, HBO)
  - Adjust result size (12, 24, 48 items)
  - Load more results with infinite scroll capability
  - Preview grid showing poster, title, year, genres, runtime, and advisory info
- **Populate Selection**: Update existing Figma frames with feature data
  - Select frames with "Poster", "Title", and "Meta" layers
  - Plugin downloads poster images and updates text content
  - Formats metadata with " • " separator
  - Handles missing images gracefully
- Demonstrates communication between UI and main thread
- Uses React for a modern, responsive UI

## API Endpoints

### `/api/graphql`

A Vercel serverless function that proxies GraphQL requests to `https://wme-gep-graphql-qa.wme-digital.com/graphql`.

**Usage:**
```bash
POST /api/graphql
Content-Type: application/json

{
  "query": "query FeatureGrid($brand: String!, $size: Int!, $scrollId: String) { ... }",
  "variables": { "brand": "tcm", "size": 24 }
}
```

**Features:**
- CORS enabled for all origins
- Forwards query and variables to the GraphQL endpoint
- Returns JSON response
- Supports scrollId for pagination
- No authentication (for now)

**GraphQL Query:**
The plugin uses the `FeatureGrid` query with:
- `brand`: Filter by content brand (tcm, dc, hbo)
- `size`: Number of results to return (12, 24, or 48)
- `scrollId`: Optional pagination cursor for loading more results

## Using the Plugin

1. **Select Brand & Size**: Choose a content brand (TCM, DC, or HBO) and the number of results you want (12, 24, or 48)

2. **Run Query**: Click "Run Query" to fetch features from the GraphQL API. Results will display in a scrollable grid showing:
   - Poster image
   - Title (short or full)
   - Year
   - Genres (first 2)
   - Runtime
   - Advisory information

3. **Load More**: Click "Load More" to fetch additional results using pagination

4. **Populate Selection**: Click "Populate Selection" to update the currently selected Figma frames with feature data. The plugin expects frames with the following named layers:
   - **"Poster"** (Rectangle) - Will be filled with the feature's poster image
   - **"Title"** (Text) - Updated with title.short or title.full
   - **"Meta"** (Text) - Updated with year, genres, runtimeDisplay, and advisory, joined with " • "
   
   The plugin will populate as many selected frames as there are loaded features (matches them in order)

## Frame Structure for Populate

To use the "Populate Selection" feature, create frames with these named layers:

```
Frame (any name)
├── Poster (Rectangle or Frame) - Will be filled with poster image
├── Title (Text) - Will show feature title
└── Meta (Text) - Will show metadata (year • genres • runtime • advisory)
```

The plugin recursively searches for these layer names within your selected frames, so they can be nested at any level.

## Deployment

To deploy to Vercel:

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel
```

The API endpoint will be available at `https://your-project.vercel.app/api/graphql`

After deployment, update the `fetch` URL in `src/ui.tsx` to point to your deployed API endpoint, or use relative paths if the plugin UI is also hosted on Vercel.

