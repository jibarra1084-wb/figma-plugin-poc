const UPSTREAM = "https://wme-gep-graphql-qa.wme-digital.com/graphql"; // Using QA for fresh data

module.exports = async (req, res) => {
  try {
    // Set CORS headers for ALL requests
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
    res.setHeader("Access-Control-Allow-Headers", "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, Cache-Control, Pragma");
    
    // Disable caching
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    
    // Handle preflight
    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }

    // Only allow POST
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    // Parse body
    const body = req.body || {};
    
    // Proxy to upstream with cache-busting headers
    const response = await fetch(UPSTREAM, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache"
      },
      body: JSON.stringify({ 
        query: body.query, 
        variables: body.variables 
      }),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error("Proxy error:", error);
    res.status(500).json({ 
      error: "Proxy error", 
      message: error.message 
    });
  }
};
