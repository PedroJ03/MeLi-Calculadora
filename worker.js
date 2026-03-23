/**
 * MeLi Calculadora - Cloudflare Worker Proxy
 * Sirve como puente CORS para la API de MercadoLibre
 * 
 * Deploy: https://dash.cloudflare.com > Workers & Pages > Create Worker
 * Pegá todo este código en el editor
 */

export default {
  async fetch(request, env) {
    // CORS headers para permitir requests desde la extensión
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ============================================
    // Endpoint: /listing-prices
    // Params: price, listing_type_id, category_id
    // ============================================
    if (url.pathname === '/listing-prices') {
      const price = url.searchParams.get('price');
      const listingTypeId = url.searchParams.get('listing_type_id');
      const categoryId = url.searchParams.get('category_id');
      const authHeader = request.headers.get('Authorization');

      if (!price || !listingTypeId || !categoryId) {
        return new Response(
          JSON.stringify({ error: 'Missing required parameters: price, listing_type_id, category_id' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      try {
        // Forward request to MeLi API
        const meliUrl = `https://api.mercadolibre.com/sites/MLA/listing_prices?price=${price}&listing_type_id=${listingTypeId}&category_id=${categoryId}`;

        const meliResponse = await fetch(meliUrl, {
          headers: authHeader ? { 'Authorization': authHeader } : {}
        });

        if (!meliResponse.ok) {
          return new Response(
            JSON.stringify({
              error: 'MeLi API error',
              status: meliResponse.status,
              message: await meliResponse.text()
            }),
            { status: meliResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const data = await meliResponse.json();

        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        return new Response(
          JSON.stringify({ error: 'Proxy error', message: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ============================================
    // Endpoint: /item/{itemId}
    // Obtiene datos públicos del item
    // ============================================
    if (url.pathname.startsWith('/item/')) {
      const itemId = url.pathname.split('/item/')[1];

      if (!itemId) {
        return new Response(
          JSON.stringify({ error: 'Missing item ID' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      try {
        const meliUrl = `https://api.mercadolibre.com/items/${itemId}`;

        const meliResponse = await fetch(meliUrl);

        if (!meliResponse.ok) {
          return new Response(
            JSON.stringify({ error: 'MeLi API error', status: meliResponse.status }),
            { status: meliResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const data = await meliResponse.json();

        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        return new Response(
          JSON.stringify({ error: 'Proxy error', message: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ============================================
    // Endpoint: /prices/{itemId}
    // Obtiene precios con descuentos activos
    // ============================================
    if (url.pathname.startsWith('/prices/')) {
      const itemId = url.pathname.split('/prices/')[1];

      if (!itemId) {
        return new Response(
          JSON.stringify({ error: 'Missing item ID' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      try {
        const meliUrl = `https://api.mercadolibre.com/items/${itemId}/prices`;

        const meliResponse = await fetch(meliUrl);

        if (!meliResponse.ok) {
          return new Response(
            JSON.stringify({ error: 'MeLi API error', status: meliResponse.status }),
            { status: meliResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const data = await meliResponse.json();

        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        return new Response(
          JSON.stringify({ error: 'Proxy error', message: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ============================================
    // Health check endpoint
    // ============================================
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', timestamp: Date.now() }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fallback: 404
    return new Response(
      JSON.stringify({
        error: 'Not found',
        availableEndpoints: [
          'GET /listing-prices?price=X&listing_type_id=Y&category_id=Z',
          'GET /item/{itemId}',
          'GET /prices/{itemId}',
          'GET /health'
        ]
      }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
};
