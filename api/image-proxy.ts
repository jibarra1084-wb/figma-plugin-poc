const https = require('https');
const http = require('http');

module.exports = async (req: any, res: any) => {
  try {
    // Set CORS headers
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    
    // Handle preflight
    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }

    // Only allow GET
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    // Get the image URL from query param
    const imageUrl = req.query.url as string;
    
    if (!imageUrl) {
      res.status(400).json({ error: "Missing 'url' query parameter" });
      return;
    }

    // Fetch the image from the CDN using native https module
    const response = await new Promise<{ status: number; headers: any; buffer: Buffer }>((resolve, reject) => {
      const protocol = imageUrl.startsWith('https:') ? https : http;
      
      protocol.get(imageUrl, (imageRes) => {
        const chunks: Buffer[] = [];
        
        imageRes.on('data', (chunk) => chunks.push(chunk));
        imageRes.on('end', () => {
          resolve({
            status: imageRes.statusCode || 500,
            headers: imageRes.headers,
            buffer: Buffer.concat(chunks)
          });
        });
        imageRes.on('error', reject);
      }).on('error', reject);
    });
    
    if (response.status !== 200) {
      res.status(response.status).json({ 
        error: `Failed to fetch image: HTTP ${response.status}` 
      });
      return;
    }

    // Get the image data and content type
    const contentType = response.headers['content-type'] || 'image/jpeg';

    // Set appropriate headers and return the image
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.status(200).send(response.buffer);
    
  } catch (error: any) {
    console.error("Image proxy error:", error);
    res.status(500).json({ 
      error: "Image proxy error", 
      message: error.message 
    });
  }
};
