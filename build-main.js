const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

console.log('Building UI with esbuild...');

// Build UI with esbuild (NO minification for debugging)
esbuild.build({
  entryPoints: ['src/ui.tsx'],
  bundle: true,
  outfile: 'dist/ui-bundle.js',
  format: 'iife',
  target: ['es2019'],
  minify: false,  // Keep readable for debugging
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"'
  },
}).then(() => {
  // Read the bundled UI JS and CSS
  const uiJsPath = path.join(__dirname, 'dist/ui-bundle.js');
  const uiCssPath = path.join(__dirname, 'src/ui.css');
  
  let uiJs = fs.readFileSync(uiJsPath, 'utf8');
  const uiCss = fs.readFileSync(uiCssPath, 'utf8');
  
  // Add debug logging at the START of the JS
  const debugLog = `
console.log('[UI] JS bundle loaded successfully');
console.log('[UI] React version:', typeof React !== 'undefined' ? 'loaded' : 'NOT loaded');
console.log('[UI] ReactDOM version:', typeof ReactDOM !== 'undefined' ? 'loaded' : 'NOT loaded');
`;
  uiJs = debugLog + uiJs;
  
  // Create HTML with inlined CSS and JS
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${uiCss}</style>
</head>
<body>
  <div id="root"></div>
  <script>
console.log('[UI] HTML loaded');
console.log('[UI] Root element:', document.getElementById('root'));
${uiJs}
  </script>
</body>
</html>`;
  
  const uiHtmlPath = path.join(__dirname, 'dist/ui.html');
  fs.writeFileSync(uiHtmlPath, html, 'utf8');
  
  const htmlSizeKB = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`Created ui.html with inlined CSS/JS (${htmlSizeKB} KB)`);
  
  // Build main.ts
  return esbuild.build({
    entryPoints: ['src/main.ts'],
    bundle: true,
    outfile: 'dist/main.es5.js',
    format: 'iife',
    target: ['es2019'],
    logLevel: 'info',
  });
}).catch(() => process.exit(1));
