/**
 * MeLi Calculadora - Content Script
 * 3-Layer Hybrid Architecture:
 *   Layer 1: Public API (no auth) - item data + prices
 *   Layer 2: Official API (with token) - exact commissions
 *   Layer 3: Fallback config - estimated calculations
 */

(function() {
  'use strict';

  // ═══ CONSTANTS ═══

  const API_BASE = 'https://api.mercadolibre.com';

  // Keep FALLBACK_CONFIG for when API is not available
  const FALLBACK_CONFIG = {
    version: "2026-03",
    comisiones: {
      clasica_default: 0.13,
      premium_recargos: {
        "3": 0.09,
        "6": 0.142,
        "9": 0.189,
        "12": 0.232
      },
      interes_bajo_recargo: 0.05
    },
    costo_unidad: {
      umbral_maximo: 33000,
      umbral_envio_gratis: 30000,
      logisticas_fijas: ["custom", "not_specified"],
      tags_flex: ["self_service_in", "self_service_out"],
      fijo_escalonado: [
        { max: 15999, fee: 1255 },
        { max: 23999, fee: 2500 },
        { max: 32999.99, fee: 3030 }
      ],
      variable_estimado_default: 2800
    },
    iibb: {
      "Buenos Aires": 0.035,
      "CABA": 0.03,
      "Córdoba": 0.0475,
      "Santa Fe": 0.035,
      "Mendoza": 0.035,
      "Tucumán": 0.03,
      "Salta": 0.025,
      "Entre Ríos": 0.03,
      "Misiones": 0.025,
      "Chaco": 0.025,
      "Corrientes": 0.025,
      "Santiago del Estero": 0.025,
      "San Juan": 0.025,
      "Jujuy": 0.025,
      "Río Negro": 0.03,
      "Neuquén": 0.025,
      "Formosa": 0.01,
      "Chubut": 0.025,
      "San Luis": 0.025,
      "Catamarca": 0.025,
      "La Rioja": 0.025,
      "La Pampa": 0.025,
      "Santa Cruz": 0.025,
      "Tierra del Fuego": 0.025
    }
  };

  function calcularCostoUnidadVendida(price, logisticType, tags = [], costoPromedioUsuario) {
    const cfg = FALLBACK_CONFIG.costo_unidad;
    if (price >= cfg.umbral_maximo) {
      return { costo: 0, tipo: 'exento', LOG: `Producto exento de costo por unidad (≥$${cfg.umbral_maximo})` };
    }

    const isFlex = tags.some(tag => cfg.tags_flex.includes(tag));
    const isLogisticaFija = cfg.logisticas_fijas.includes(logisticType) || isFlex;

    if (isLogisticaFija) {
      const tramo = cfg.fijo_escalonado.find(t => price <= t.max);
      const costo = tramo ? tramo.fee : 0;
      return { costo, tipo: 'fijo', LOG: `Logística fija detectada: $${costo}` };
    } else {
      const costo = costoPromedioUsuario || cfg.variable_estimado_default;
      return { costo, tipo: 'variable', LOG: `Logística variable: $${costo} (estimado)` };
    }
  }

  // ═══ CONFIG URL FOR REMOTE CONFIG ═══

  const CONFIG_URL = 'https://raw.githubusercontent.com/PedroJ03/MeLi-Calculadora/main/config.json';

  // Config cache
  let cachedConfig = null;

  async function loadConfig() {
    const now = Date.now();
    const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
    
    // Return memory cache if available
    if (cachedConfig) {
      return cachedConfig;
    }
    
    try {
      // 1. Read chrome.storage.local for 'tarifas' and 'tarifas_ts'
      const stored = await chrome.storage.local.get(['tarifas', 'tarifas_ts']);
      
      // 2. If cache is valid (less than 24 hours), return cached config
      if (stored.tarifas_ts && (now - stored.tarifas_ts) < CACHE_DURATION) {
        cachedConfig = { ...stored.tarifas, _fuente: 'cache' };
        return cachedConfig;
      }
      
      // 3. Try to fetch with 5 second timeout
      const fetchPromise = fetch(CONFIG_URL, {
        cache: 'no-store',
        mode: 'cors',
        credentials: 'omit'
      });
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('timeout')), 5000)
      );
      
      const response = await Promise.race([fetchPromise, timeoutPromise]);
      
      // 404 means config.json doesn't exist on GitHub yet - this is OK, use fallback silently
      if (response.status === 404) {
        console.log('[MeLi Calc] config.json not found on GitHub (404) - using fallback');
        cachedConfig = { ...FALLBACK_CONFIG, _fuente: 'fallback' };
        return cachedConfig;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const config = await response.json();
      
      // Save to storage with timestamp
      await chrome.storage.local.set({
        tarifas: config,
        tarifas_ts: now
      });
      
      // If config has "aviso" field, save it
      if (config.aviso) {
        await chrome.storage.local.set({ aviso_pendiente: config.aviso });
      }
      
      cachedConfig = { ...config, _fuente: 'remota' };
      return cachedConfig;
      
    } catch (error) {
      console.log('[MeLi Calc] Error loading config:', error.message);
      
      // 4. On error, try to use cached config
      const stored = await chrome.storage.local.get(['tarifas']);
      if (stored.tarifas) {
        cachedConfig = { ...stored.tarifas, _fuente: 'cache' };
        return cachedConfig;
      }
      
      // 5. Final fallback to hardcoded config
      cachedConfig = { ...FALLBACK_CONFIG, _fuente: 'fallback' };
      return cachedConfig;
    }
  }

  // ═══ LAYER 1: PUBLIC API (No Auth Required) ═══

  /**
   * Extract item ID from URL patterns
   * @returns {string|null} MeLi item ID (e.g., MLA123456789)
   */
  function getItemId() {
    const patterns = [
      /\/(MLA\d+)[-_]/i,
      /\/p\/(MLA\d+)/i,
    ];
    for (const p of patterns) {
      const match = location.pathname.match(p);
      if (match) return match[1];
    }
    return null;
  }

  /**
   * Fetch item data from public MeLi API
   * @param {string} itemId - MeLi item ID
   * @returns {Promise<Object|null>} Item data or null on failure
   */
  async function fetchItemData(itemId) {
    try {
      const [itemRes, pricesRes] = await Promise.allSettled([
        fetch(`${API_BASE}/items/${itemId}`),
        fetch(`${API_BASE}/items/${itemId}/prices`)
      ]);
      
      const item = itemRes.status === 'fulfilled' 
        ? await itemRes.value.json() : null;
      const prices = pricesRes.status === 'fulfilled'
        ? await pricesRes.value.json() : null;

      if (!item) return null;

      // Get final price from prices array (most accurate)
      let precioFinal = item.price;
      if (prices?.prices?.length) {
        const now = Date.now();
        const activePrices = prices.prices.filter(p => {
          const startOk = !p.conditions?.start_time || p.conditions.start_time <= now;
          const endOk = !p.conditions?.end_time || p.conditions.end_time >= now;
          return startOk && endOk;
        });
        
        if (activePrices.length) {
          const lowest = activePrices.sort((a, b) => a.amount - b.amount)[0];
          precioFinal = lowest.amount;
        }
      }

      return {
        itemId,
        price: precioFinal,
        originalPrice: item.original_price || null,
        categoryId: item.category_id,
        listingTypeId: item.listing_type_id,
        listingType: item.listing_type_id?.replace('gold_', '').replace('_', ' '),
        freeShipping: item.shipping?.free_shipping || false,
        logisticType: item.shipping?.logistic_type || 'not_specified',
        shippingTags: item.shipping?.tags || [],
        source: 'api_publica'
      };
    } catch (e) {
      console.warn('[MeLi Calc] fetchItemData failed:', e.message);
      return null;
    }
  }

  // ═══ TOKEN EXTRACTION STRATEGIES ═══

  /**
   * Strategy E: Try to extract token from cookies
   * MeLi sometimes stores session in cookies
   */
  function extractTokenFromCookies() {
    try {
      const cookies = document.cookie;
      console.log('[MeLi Calc] Cookie raw:', cookies.substring(0, 200));
      
      // Look for common MeLi session cookie patterns
      const patterns = [
        /session[^=]*=([^;]+)/i,
        /\_ml_session\s*=\s*([^;]+)/i,
        /access_token\s*=\s*([^;]+)/i,
        /Bearer\s+([a-zA-Z0-9\-_]+)/i
      ];
      
      for (const pattern of patterns) {
        const match = cookies.match(pattern);
        if (match && match[1] && match[1].length > 20) {
          console.log('[MeLi Calc] Found token in cookies!');
          return match[1];
        }
      }
    } catch (e) {
      console.log('[MeLi Calc] Cookie extraction failed:', e.message);
    }
    return null;
  }

  /**
   * Strategy F: Check window objects for auth info
   * MeLi may expose user data in window objects
   */
  function extractTokenFromWindowObjects() {
    const windowProps = [
      '__PRELOADED_STATE__',
      '__STATE__',
      '__NEXT_DATA__',
      'MELI',
      'MELI_USER_ID',
      'serverTime',
      '__INITIAL_PROPS__',
      '__REUX_DEVTOOLS_HOOK__'
    ];
    
    for (const prop of windowProps) {
      try {
        const obj = window[prop];
        if (obj) {
          const objStr = JSON.stringify(obj);
          // Look for Bearer token pattern
          const tokenMatch = objStr.match(/Bearer\s+([a-zA-Z0-9\-_\.]+)/);
          if (tokenMatch && tokenMatch[1]) {
            console.log('[MeLi Calc] Found token in window.' + prop);
            return tokenMatch[1];
          }
          // Look for access_token
          const accessMatch = objStr.match(/"access_token"\s*:\s*"([^"]+)"/);
          if (accessMatch && accessMatch[1]) {
            console.log('[MeLi Calc] Found access_token in window.' + prop);
            return accessMatch[1];
          }
        }
      } catch (e) {
        // Some objects may throw on JSON.stringify
      }
    }
    
    // Also check localStorage/sessionStorage
    try {
      const localToken = localStorage.getItem('access_token') || sessionStorage.getItem('access_token');
      if (localToken) {
        console.log('[MeLi Calc] Found token in localStorage/sessionStorage');
        return localToken;
      }
    } catch (e) {
      // Storage might be blocked
    }
    
    return null;
  }

  /**
   * Get token using all available strategies
   * @returns {Promise<string|null>} Token or null
   */
  async function getTokenWithFallbacks() {
    console.log('[MeLi Calc] Getting token with fallbacks...');
    
    // First try via background service worker (most reliable)
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_TOKEN' });
      if (response.token && !response.isExpired) {
        console.log('[MeLi Calc] Got token from background service worker');
        return response.token;
      }
      console.log('[MeLi Calc] No valid token from background, trying fallbacks...');
    } catch (e) {
      console.log('[MeLi Calc] Background token request failed:', e.message);
    }
    
    // Strategy E: Cookies
    const cookieToken = extractTokenFromCookies();
    if (cookieToken) return cookieToken;
    
    // Strategy F: Window objects
    const windowToken = extractTokenFromWindowObjects();
    if (windowToken) return windowToken;
    
    console.log('[MeLi Calc] All token extraction strategies failed');
    return null;
  }

  // ═══ LAYER 2: OFFICIAL API (Requires Token) ═══

  /**
   * Fetch exact commission from MeLi official API using captured token
   * @param {Object} itemData - Item data from fetchItemData
   * @returns {Promise<Object|null>} Commission data or null on failure
   */
  async function fetchComision(itemData) {
    try {
      // Get token using all available strategies
      const token = await getTokenWithFallbacks();
      
      if (!token) {
        console.log('[MeLi Calc] No valid token available after trying all strategies');
        return null;
      }

      const params = new URLSearchParams({
        price: itemData.price,
        listing_type_id: itemData.listingTypeId,
        category_id: itemData.categoryId,
      });

      // Use Cloudflare Worker proxy to bypass CORS
      const PROXY_URL = 'https://round-pond-5460.pedrojossi03.workers.dev';
      const url = `${PROXY_URL}/listing-prices?${params}`;
      console.log('[MeLi Calc] Making authenticated API request via proxy...', {
        url: url,
        tokenPrefix: token.substring(0, 20) + '...',
        tokenLength: token.length
      });

      const res = await fetch(url, {
        headers: { 
          Authorization: `Bearer ${token}`,
          'Accept': 'application/json'
        },
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store'
      });

      if (!res.ok) {
        console.warn('[MeLi Calc] listing_prices failed:', res.status, res.statusText);
        return null;
      }

      const data = await res.json();
      
      // Debug: log the response structure
      console.log('[MeLi Calc] listing_prices response:', JSON.stringify(data).substring(0, 500));
      
      // Handle different response formats
      let match = null;
      
      // Try to find matching listing type
      if (Array.isArray(data)) {
        match = data.find(l => l.listing_type_id === itemData.listingTypeId) || data[0];
      } else if (data.listing_prices && Array.isArray(data.listing_prices)) {
        match = data.listing_prices.find(l => l.listing_type_id === itemData.listingTypeId) || data.listing_prices[0];
      } else if (typeof data === 'object') {
        // Maybe it's a single object
        match = data;
      }
      
      if (!match) {
        console.warn('[MeLi Calc] No matching listing type found in response');
        return null;
      }

      return {
        comisionMonto: match.sale_fee_amount || match.commission || 0,
        costoFijoMonto: match.listing_fee_amount || match.listing_fee || 0,
        source: 'api_oficial'
      };
    } catch (e) {
      console.warn('[MeLi Calc] fetchComision failed:', e.message, {
        name: e.name,
        stack: e.stack?.substring(0, 200)
      });
      return null;
    }
  }

  // ═══ LAYER 3: FALLBACK CONFIG (No API) ═══

  // Uses FALLBACK_CONFIG constants directly

  // ═══ ORCHESTRATION: HYBRID DATA FETCHING ═══

  /**
   * Obtain calculation data using 3-layer hybrid approach
   * Layer 1: Public API (item data + prices) - no auth required
   * Layer 2: Official API (exact commissions) - requires token
   * Layer 3: Fallback (estimated commissions) - no network required
   * 
   * @returns {Promise<Object>} Calculation data with source indicator
   */
  async function obtenerDatosCalculo() {
    const itemId = getItemId();
    
    // If not a product page, use DOM detection
    if (!itemId) {
      return {
        price: detectarPrecio(),
        source: 'dom'
      };
    }

    // Try Layer 1: Public API data
    const itemData = await fetchItemData(itemId);
    
    if (!itemData) {
      return {
        price: detectarPrecio(),
        source: 'dom_fallback'
      };
    }

    // Try Layer 2: Commission with token
    const comisionData = await fetchComision(itemData);

    if (comisionData) {
      return {
        ...itemData,
        ...comisionData,
        source: 'api_oficial'
      };
    }

    // Fallback: use public data + estimated commission
    return {
      ...itemData,
      source: 'api_publica_estimado'
    };
  }

  // ═══ PART: DETECCIÓN DE PRECIO RESILIENTE (UNCHANGED) ═══

  function detectarPrecio() {
    // Opción A: Buscar el precio con descuento (precio final que vas a cobrar)
    // En productos con descuento, el precio final suele estar en el segundo elemento
    // o dentro de .ui-pdp-price__second-line
    
    // 1. Intentar primero con el selector más específico del precio final
    const precioFinalEl = document.querySelector('.ui-pdp-price__second-line .andes-money-amount__fraction');
    if (precioFinalEl) {
      const rawValue = precioFinalEl.textContent;
      if (rawValue) {
        const cleaned = rawValue.replace(/\./g, '').replace(',', '.').trim();
        const value = parseFloat(cleaned);
        if (!isNaN(value) && value > 0) {
          return { price: value, selector: '.ui-pdp-price__second-line .andes-money-amount__fraction' };
        }
      }
    }
    
    // 2. Buscar todos los spans con precios y tomar el ÚLTIMO (generalmente es el precio con descuento)
    const todosLosPrecios = document.querySelectorAll('span.andes-money-amount__fraction');
    if (todosLosPrecios.length > 0) {
      // Si hay múltiples precios (tachado + descuento), tomar el último
      const ultimoPrecio = todosLosPrecios[todosLosPrecios.length - 1];
      const rawValue = ultimoPrecio.textContent;
      if (rawValue) {
        const cleaned = rawValue.replace(/\./g, '').replace(',', '.').trim();
        const value = parseFloat(cleaned);
        if (!isNaN(value) && value > 0) {
          return { price: value, selector: 'span.andes-money-amount__fraction' };
        }
      }
    }
    
    // 3. Fallback: meta tag (generalmente tiene el precio base)
    const metaPrice = document.querySelector('meta[itemprop="price"]');
    if (metaPrice) {
      const rawValue = metaPrice.getAttribute('content');
      if (rawValue) {
        const cleaned = rawValue.replace(/\./g, '').replace(',', '.').trim();
        const value = parseFloat(cleaned);
        if (!isNaN(value) && value > 0) {
          return { price: value, selector: 'meta[itemprop="price"]' };
        }
      }
    }
    
    return { price: null, selector: null };
  }

  async function detectarPrecioConObservador() {
    // First attempt
    let resultado = detectarPrecio();
    if (resultado.price !== null) return resultado;
    
    // Set up observer and wait up to 4 seconds
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const nuevoResultado = detectarPrecio();
        if (nuevoResultado.price !== null) {
          observer.disconnect();
          resolve(nuevoResultado);
        }
      });
      
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      
      // Timeout after 4 seconds
      setTimeout(() => {
        observer.disconnect();
        resolve({ price: null, selector: null });
      }, 4000);
    });
  }

  // ═══ RENTABILITY CALCULATION (UPDATED FOR HYBRID) ═══

  /**
   * Calculate seller profitability with hybrid data support
   * @param {Object} params - Calculation parameters from UI
   * @param {Object} data - Data from obtenerDatosCalculo (includes source)
   * @param {number} costoEnvioUsuario - User configured costoEnvio from sync storage
   * @returns {Object} Calculation results
   */
  function calcularRentabilidad(params, data, costoEnvioUsuario) {
    const {
      precioVenta,
      costoProducto = 0,
      provincia = 'Buenos Aires',
      envioGratis = false,
      costoEnvio = 0,
      tipoPub = 'clasica',
      cuotas = 6
    } = params;
    
    // Determine source and calculate accordingly
    let comisionMonto, costoFijoMonto, comisionPorcentaje;
    
    if (data.source === 'api_oficial') {
      // Use exact values from API
      comisionMonto = data.comisionMonto;
      costoFijoMonto = data.costoFijoMonto;
      comisionPorcentaje = comisionMonto / precioVenta;
    } else {
      // Use new commission structure
      const cfg = FALLBACK_CONFIG.comisiones;
      
      // Check if new schema exists (has premium_recargos)
      if (cfg.premium_recargos) {
        // New schema: clasica_default, premium_recargos, interes_bajo_recargo
        if (tipoPub === 'premium') {
          const recargo = cfg.premium_recargos[cuotas] || cfg.premium_recargos["6"] || 0.142;
          comisionPorcentaje = cfg.clasica_default + recargo;
        } else if (tipoPub === 'interes_bajo') {
          comisionPorcentaje = cfg.clasica_default + cfg.interes_bajo_recargo;
        } else {
          // clasica
          comisionPorcentaje = cfg.clasica_default;
        }
      } else {
        // Legacy schema compatibility
        const listingTypeMap = {
          'gold_special': 'clasica',
          'gold_premium': 'cuotas_precio',
          'gold_pro': 'cuotas_precio',
          'gold': 'clasica',
          'silver': 'clasica',
          'bronze': 'clasica',
        };
        
        let tipoPubKey = tipoPub || 'clasica';
        if (data.listingTypeId) {
          const mapped = listingTypeMap[data.listingTypeId];
          if (mapped) tipoPubKey = mapped;
        }
        
        comisionPorcentaje = cfg[tipoPubKey]?.default || 0.13;
      }
      
      comisionMonto = precioVenta * comisionPorcentaje;
      
      // Calculate costo por unidad using new architecture
      const logisticType = data.logisticType || 'not_specified';
      const shippingTags = data.shippingTags || [];
      
      // Check if new costo_unidad structure exists
      if (FALLBACK_CONFIG.costo_unidad) {
        const costoUnidadResult = calcularCostoUnidadVendida(
          precioVenta,
          logisticType,
          shippingTags,
          costoEnvioUsuario
        );
        costoFijoMonto = costoUnidadResult.costo;
      } else {
        // Backwards compatibility: use old costo_fijo array
        costoFijoMonto = FALLBACK_CONFIG.costo_fijo?.find(r => precioVenta <= r.hasta)?.costo || 0;
      }
    }

    // IIBB always local
    const tasaIIBB = FALLBACK_CONFIG.iibb?.[provincia] || 0.025;
    const iibbMonto = precioVenta * tasaIIBB;
    
    // Shipping logic with mandatory free shipping threshold
    const cfgCostoUnidad = FALLBACK_CONFIG.costo_unidad;
    const umbralEnvioGratis = cfgCostoUnidad?.umbral_envio_gratis || 30000;
    let envioEfectivo = 0;
    let envioForzado = false;
    
    if (precioVenta >= umbralEnvioGratis) {
      // Product above threshold - shipping is MANDATORY
      // If user didn't check "envio gratis", we still need to account for the cost
      envioEfectivo = costoEnvio || cfgCostoUnidad?.variable_estimado_default || 2800;
      envioForzado = !envioGratis;
    } else if (envioGratis) {
      // Below threshold but user chose free shipping
      envioEfectivo = costoEnvio || 0;
    }
    
    // Totals
    const totalDescuentos = comisionMonto + costoFijoMonto + iibbMonto + envioEfectivo;
    const gananciaNeta = precioVenta - totalDescuentos - costoProducto;
    const margen = precioVenta > 0 ? (gananciaNeta / precioVenta) * 100 : 0;

    return {
      price: precioVenta,
      comisionMonto,
      comisionPorcentaje,
      costoFijoMonto,
      tasaIIBB,
      iibbMonto,
      envioEfectivo,
      envioForzado,
      totalDescuentos,
      costoProducto,
      gananciaNeta,
      margen,
      source: data.source,
      configVersion: FALLBACK_CONFIG.version
    };
  }

  // ═══ PANEL UI Y LÓGICA ═══

  // State (UNCHANGED)
  let panelElement = null;
  let isMinimized = false;
  let debounceTimer = null;
  let currentConfig = null;
  let panelInjected = false;
  let currentListeners = [];
  let priceObserver = null;
  let lastSelectorUsado = null;

  // Storage keys (UNCHANGED)
  const STORAGE_KEYS = {
    PROVINCIA: 'meli_calc_provincia',
    TIPO_PUB: 'meli_calc_tipo_pub',
    COSTO_PRODUCTO: 'meli_calc_costo_producto',
    MINIMIZED: 'meli_calc_minimized',
    CUOTAS: 'meli_calc_cuotas'
  };

  // ═══ HISTORIAL DE CÁLCULOS (UNCHANGED) ═══

  function getProductTitle() {
    const titleSelectors = [
      'h1.ui-pdp-title',
      'h1.ui-vip-title',
      '.ui-pdp-header__title',
      '[data-testid="product-title"]',
      'h1'
    ];

    for (const selector of titleSelectors) {
      const element = document.querySelector(selector);
      if (element && element.textContent.trim()) {
        return element.textContent.trim();
      }
    }

    return document.title.split('|')[0].split('-')[0].trim() || 'Producto sin nombre';
  }

  async function saveToHistory(item) {
    try {
      const { historial: existing = [] } = await chrome.storage.local.get(['historial']);
      
      const newItem = {
        titulo: item.titulo.substring(0, 40),
        precio: item.precio,
        gananciaNeta: item.gananciaNeta,
        margenPct: item.margen,
        fecha: Date.now()
      };

      const historial = [newItem, ...existing].slice(0, 5);

      await chrome.storage.local.set({ historial });
      console.log('[MeLi Calc] Saved to history:', newItem);
    } catch (error) {
      console.log('[MeLi Calc] Error saving to history:', error);
    }
  }

  function isProductPage() {
    return !!(
      document.querySelector('.ui-pdp-container') ||
      document.querySelector('.ui-pdp-header') ||
      document.querySelector('[data-testid="price"]') ||
      window.location.pathname.includes('/MLA-')
    );
  }

  async function loadPreferences() {
    try {
      const result = await chrome.storage.local.get([
        STORAGE_KEYS.PROVINCIA,
        STORAGE_KEYS.TIPO_PUB,
        STORAGE_KEYS.COSTO_PRODUCTO,
        STORAGE_KEYS.MINIMIZED,
        'meli_calc_cuotas'
      ]);
      
      return {
        provincia: result[STORAGE_KEYS.PROVINCIA] || 'Buenos Aires',
        tipoPub: result[STORAGE_KEYS.TIPO_PUB] || 'clasica',
        costoProducto: result[STORAGE_KEYS.COSTO_PRODUCTO] || '',
        minimized: result[STORAGE_KEYS.MINIMIZED] || false,
        cuotas: result['meli_calc_cuotas'] || '6'
      };
    } catch (e) {
      return {
        provincia: 'Buenos Aires',
        tipoPub: 'clasica',
        costoProducto: '',
        minimized: false,
        cuotas: '6'
      };
    }
  }

  async function savePreference(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (e) {
      console.log('[MeLi Calc] Error saving preference:', e);
    }
  }

  function formatCurrency(amount) {
    if (amount === null || amount === undefined || isNaN(amount)) return '-';
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    return '$' + num.toLocaleString('es-AR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }

  /**
   * Update the prominent source banner based on data source
   * This creates a colored banner at the TOP of the results section
   * @param {string} source - Data source identifier
   */
  function updateSourceBanner(source) {
    const banner = panelElement?.querySelector('#meli-source-banner');
    if (!banner) {
      console.log('[MeLi Calc] Banner element not found!');
      return;
    }
    
    console.log('[MeLi Calc] Updating source banner to:', source);
    
    // Reset classes
    banner.className = 'meli-source-banner';
    
    switch (source) {
      case 'api_oficial':
        // Verde: Tenemos datos exactos de la API oficial
        banner.classList.add('official');
        banner.innerHTML = '✓ Datos oficiales MeLi';
        break;
      case 'api_publica_estimado':
        // Verde: Tenemos datos reales del producto (precio, tipo publicación)
        // Las comisiones son estimadas pero el precio es real
        banner.classList.add('official');
        banner.innerHTML = '✓ Precio real de MeLi';
        break;
      case 'dom':
      case 'dom_fallback':
      default:
        // Amarillo: Solo podemos detectar el precio del DOM
        banner.classList.add('estimated');
        banner.innerHTML = '⚠ Precio detectado en la página';
    }
  }

  // Legacy function kept for compatibility but now redirects to banner
  function updateSourceBadge(source) {
    updateSourceBanner(source);
  }

  function injectStyles() {
    if (document.getElementById('meli-calc-styles')) return;
    
    const styles = document.createElement('style');
    styles.id = 'meli-calc-styles';
    styles.textContent = `
      :root {
        --meli-calc-bg: #ffffff;
        --meli-calc-border: #e0e0e0;
        --meli-calc-shadow: 0 4px 20px rgba(0,0,0,0.15);
        --meli-calc-header-bg: #ffe600;
        --meli-calc-header-text: #333333;
        --meli-calc-input-border: #dddddd;
        --meli-calc-input-focus: #ffe600;
        --meli-calc-text: #333333;
        --meli-calc-text-secondary: #666666;
        --meli-calc-negative: #e74c3c;
        --meli-calc-positive: #27ae60;
        --meli-calc-button-bg: #3483fa;
        --meli-calc-button-hover: #2968c8;
        --meli-calc-radius: 12px;
        --meli-calc-radius-sm: 8px;
      }

      #meli-calc-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 320px;
        background: var(--meli-calc-bg);
        border: 1px solid var(--meli-calc-border);
        border-radius: var(--meli-calc-radius);
        box-shadow: var(--meli-calc-shadow);
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        font-size: 14px;
        line-height: 1.4;
        color: var(--meli-calc-text);
        overflow: hidden;
        transition: transform 0.2s ease, opacity 0.2s ease;
      }

      #meli-calc-panel.meli-calc-minimized {
        transform: translateY(calc(100% - 48px));
      }

      .meli-calc-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        background: var(--meli-calc-header-bg);
        color: var(--meli-calc-header-text);
        font-weight: 600;
        font-size: 15px;
        cursor: pointer;
        user-select: none;
      }

      .meli-calc-header:hover {
        background: #f5d800;
      }

      .meli-calc-toggle {
        background: none;
        border: none;
        font-size: 20px;
        color: var(--meli-calc-header-text);
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }

      .meli-calc-content {
        padding: 16px;
        max-height: calc(100vh - 100px);
        overflow-y: auto;
      }

      /* SOURCE BANNER - Prominent at top of results */
      .meli-source-banner {
        padding: 10px 12px;
        border-radius: 8px 8px 0 0;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        text-align: center;
        margin: -16px -16px 16px -16px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }

      .meli-source-banner.official {
        background: #1A9E66;
        color: white;
      }

      .meli-source-banner.estimated {
        background: #f39c12;
        color: white;
      }

      .meli-source-banner.dom {
        background: #95a5a6;
        color: white;
      }

      .meli-calc-inputs {
        margin-bottom: 16px;
      }

      .meli-calc-row-input,
      .meli-calc-row-select,
      .meli-calc-row-check {
        margin-bottom: 12px;
      }

      .meli-calc-row-input label,
      .meli-calc-row-select label,
      .meli-calc-row-check label {
        display: block;
        font-size: 12px;
        color: var(--meli-calc-text-secondary);
        margin-bottom: 4px;
        font-weight: 500;
      }

      .meli-calc-input-wrap {
        display: flex;
        align-items: center;
        border: 1px solid var(--meli-calc-input-border);
        border-radius: var(--meli-calc-radius-sm);
        overflow: hidden;
        transition: border-color 0.2s;
      }

      .meli-calc-input-wrap:focus-within {
        border-color: var(--meli-calc-input-focus);
        box-shadow: 0 0 0 2px rgba(255, 230, 0, 0.3);
      }

      .meli-calc-currency {
        padding: 8px 10px;
        background: #f5f5f5;
        color: var(--meli-calc-text-secondary);
        font-weight: 600;
        border-right: 1px solid var(--meli-calc-input-border);
      }

      .meli-calc-row-input input[type="number"] {
        flex: 1;
        border: none;
        padding: 8px 10px;
        font-size: 14px;
        outline: none;
        background: transparent;
        color: var(--meli-calc-text);
      }

      .meli-calc-row-input input[type="number"]::-webkit-inner-spin-button,
      .meli-calc-row-input input[type="number"]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }

      .meli-calc-row-select select {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid var(--meli-calc-input-border);
        border-radius: var(--meli-calc-radius-sm);
        font-size: 14px;
        background: #fff;
        cursor: pointer;
        outline: none;
      }

      .meli-calc-row-select select:focus {
        border-color: var(--meli-calc-input-focus);
        box-shadow: 0 0 0 2px rgba(255, 230, 0, 0.3);
      }

      .meli-calc-row-check label {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        font-size: 14px;
        color: var(--meli-calc-text);
      }

      .meli-calc-row-check input[type="checkbox"] {
        width: 18px;
        height: 18px;
        cursor: pointer;
        accent-color: var(--meli-calc-button-bg);
      }

      .meli-calc-hidden {
        display: none !important;
      }

      .meli-calc-button {
        width: 100%;
        padding: 12px;
        background: var(--meli-calc-button-bg);
        color: white;
        border: none;
        border-radius: var(--meli-calc-radius-sm);
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
        margin-bottom: 16px;
      }

      .meli-calc-button:hover {
        background: var(--meli-calc-button-hover);
      }

      .meli-calc-button:active {
        transform: translateY(1px);
      }

      .meli-calc-results {
        background: #f9f9f9;
        border-radius: var(--meli-calc-radius-sm);
        padding: 12px;
        margin-bottom: 12px;
      }

      .meli-calc-result-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 0;
        font-size: 13px;
      }

      .meli-calc-result-row span:first-child {
        color: var(--meli-calc-text-secondary);
      }

      .meli-calc-result-row span:last-child {
        font-weight: 600;
        font-family: 'SF Mono', Monaco, monospace;
      }

      .meli-calc-divider {
        height: 1px;
        background: var(--meli-calc-border);
        margin: 8px 0;
      }

      .meli-calc-total span:last-child {
        font-size: 14px;
      }

      .meli-calc-profit span:last-child {
        font-size: 16px;
      }

      .meli-calc-negative {
        color: var(--meli-calc-negative);
      }

      .meli-calc-positive {
        color: var(--meli-calc-positive);
      }

      .meli-calc-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-top: 8px;
        border-top: 1px solid var(--meli-calc-border);
        font-size: 11px;
        color: var(--meli-calc-text-secondary);
      }

      #meli-calc-source {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      #meli-calc-version {
        font-family: 'SF Mono', Monaco, monospace;
      }
    `;
    
    document.head.appendChild(styles);
  }

  function createPanelHTML(precioVenta, preferences) {
    const div = document.createElement('div');
    div.id = 'meli-calc-panel';
    if (preferences.minimized) {
      div.classList.add('meli-calc-minimized');
      isMinimized = true;
    }
    
    div.innerHTML = `
      <div class="meli-calc-header">
        <span>MeLi Calculadora</span>
        <button class="meli-calc-toggle">${preferences.minimized ? '+' : '−'}</button>
      </div>
      <div class="meli-calc-content">
        <!-- SOURCE BANNER - Prominent indicator at top -->
        <div class="meli-source-banner dom" id="meli-source-banner">
          ⚠ Cargando...
        </div>
        
        <!-- Inputs Section -->
        <div class="meli-calc-inputs">
          <div class="meli-calc-row-input">
            <label>Precio de venta:</label>
            <div class="meli-calc-input-wrap">
              <span class="meli-calc-currency">$</span>
              <input type="number" id="meli-precio-venta" value="${precioVenta || ''}" />
            </div>
          </div>
          <div class="meli-calc-row-input">
            <label>Mi costo:</label>
            <div class="meli-calc-input-wrap">
              <span class="meli-calc-currency">$</span>
              <input type="number" id="meli-costo-producto" value="${preferences.costoProducto}" placeholder="¿Cuánto te costó?" />
            </div>
          </div>
          <div class="meli-calc-row-select">
            <label>Tipo publicación:</label>
            <select id="meli-tipo-pub">
              <option value="clasica" ${preferences.tipoPub === 'clasica' ? 'selected' : ''}>Clásica</option>
              <option value="premium" ${preferences.tipoPub === 'premium' ? 'selected' : ''}>Premium (Cuotas al mismo precio)</option>
              <option value="interes_bajo" ${preferences.tipoPub === 'interes_bajo' ? 'selected' : ''}>Cuotas con interés bajo</option>
            </select>
          </div>
          <div class="meli-calc-row-select" id="meli-cuotas-group">
            <label>Cuotas:</label>
            <select id="meli-cuotas">
              <option value="3" ${preferences.cuotas === '3' ? 'selected' : ''}>3 cuotas</option>
              <option value="6" ${(!preferences.cuotas || preferences.cuotas === '6') ? 'selected' : ''}>6 cuotas</option>
              <option value="9" ${preferences.cuotas === '9' ? 'selected' : ''}>9 cuotas</option>
              <option value="12" ${preferences.cuotas === '12' ? 'selected' : ''}>12 cuotas</option>
            </select>
          </div>
          <div class="meli-calc-row-select">
            <label>Provincia:</label>
            <select id="meli-provincia">
              <option value="Buenos Aires" ${preferences.provincia === 'Buenos Aires' ? 'selected' : ''}>Buenos Aires</option>
              <option value="CABA" ${preferences.provincia === 'CABA' ? 'selected' : ''}>CABA</option>
              <option value="Córdoba" ${preferences.provincia === 'Córdoba' ? 'selected' : ''}>Córdoba</option>
              <option value="Santa Fe" ${preferences.provincia === 'Santa Fe' ? 'selected' : ''}>Santa Fe</option>
              <option value="Mendoza" ${preferences.provincia === 'Mendoza' ? 'selected' : ''}>Mendoza</option>
              <option value="Tucumán" ${preferences.provincia === 'Tucumán' ? 'selected' : ''}>Tucumán</option>
              <option value="Salta" ${preferences.provincia === 'Salta' ? 'selected' : ''}>Salta</option>
              <option value="Entre Ríos" ${preferences.provincia === 'Entre Ríos' ? 'selected' : ''}>Entre Ríos</option>
              <option value="Misiones" ${preferences.provincia === 'Misiones' ? 'selected' : ''}>Misiones</option>
              <option value="Chaco" ${preferences.provincia === 'Chaco' ? 'selected' : ''}>Chaco</option>
              <option value="Corrientes" ${preferences.provincia === 'Corrientes' ? 'selected' : ''}>Corrientes</option>
              <option value="Santiago del Estero" ${preferences.provincia === 'Santiago del Estero' ? 'selected' : ''}>Santiago del Estero</option>
              <option value="San Juan" ${preferences.provincia === 'San Juan' ? 'selected' : ''}>San Juan</option>
              <option value="Jujuy" ${preferences.provincia === 'Jujuy' ? 'selected' : ''}>Jujuy</option>
              <option value="Río Negro" ${preferences.provincia === 'Río Negro' ? 'selected' : ''}>Río Negro</option>
              <option value="Neuquén" ${preferences.provincia === 'Neuquén' ? 'selected' : ''}>Neuquén</option>
              <option value="Formosa" ${preferences.provincia === 'Formosa' ? 'selected' : ''}>Formosa</option>
              <option value="Chubut" ${preferences.provincia === 'Chubut' ? 'selected' : ''}>Chubut</option>
              <option value="San Luis" ${preferences.provincia === 'San Luis' ? 'selected' : ''}>San Luis</option>
              <option value="Catamarca" ${preferences.provincia === 'Catamarca' ? 'selected' : ''}>Catamarca</option>
              <option value="La Rioja" ${preferences.provincia === 'La Rioja' ? 'selected' : ''}>La Rioja</option>
              <option value="La Pampa" ${preferences.provincia === 'La Pampa' ? 'selected' : ''}>La Pampa</option>
              <option value="Santa Cruz" ${preferences.provincia === 'Santa Cruz' ? 'selected' : ''}>Santa Cruz</option>
              <option value="Tierra del Fuego" ${preferences.provincia === 'Tierra del Fuego' ? 'selected' : ''}>Tierra del Fuego</option>
            </select>
          </div>
          <div class="meli-calc-row-check">
            <label>
              <input type="checkbox" id="meli-envio-gratis" />
              Envío gratis
            </label>
          </div>
          <div class="meli-calc-row-input meli-calc-hidden" id="meli-costo-envio-wrap">
            <label>Costo envío:</label>
            <div class="meli-calc-input-wrap">
              <span class="meli-calc-currency">$</span>
              <input type="number" id="meli-costo-envio" placeholder="¿Cuánto te cuesta?" />
            </div>
          </div>
        </div>
        
        <!-- Results Section Header -->
        <div class="meli-calc-section-header">Cálculos:</div>
        
        <!-- Results Section -->
        <div class="meli-calc-results">
          <!-- Loss warning - shown when gananciaNeta < 0 -->
          <div class="meli-loss-alert" style="display: none;">
            ⚠️ ¡Estás vendiendo a pérdida!
          </div>
          <div class="meli-calc-result-row">
            <span>Comisión MeLi:</span>
            <span id="meli-res-comision" class="meli-calc-negative">-</span>
          </div>
          <div class="meli-calc-result-row meli-cost-fixed-row">
            <span>Costo fijo: <span class="meli-tooltip">Costo fijo de MeLi (cuota fija según rango de precio)</span></span>
            <span id="meli-res-costo-fijo" class="meli-calc-negative">-</span>
          </div>
          <div class="meli-calc-result-row">
            <span>IIBB:</span>
            <span id="meli-res-iibb" class="meli-calc-negative">-</span>
          </div>
          <div class="meli-calc-result-row">
            <span>Envío:</span>
            <span id="meli-res-envio" class="meli-calc-negative">-</span>
          </div>
          <div class="meli-calc-divider"></div>
          <div class="meli-calc-result-row meli-calc-total">
            <span>Total descuentos:</span>
            <span id="meli-res-total" class="meli-calc-negative">-</span>
          </div>
          <div class="meli-calc-result-row meli-calc-profit">
            <span>Ganancia neta:</span>
            <span id="meli-res-ganancia">-</span>
          </div>
          <div class="meli-calc-result-row">
            <span>Margen: <span class="meli-margin-badge" style="display: none;">⚠️ Margen muy bajo</span></span>
            <span id="meli-res-margen">-</span>
          </div>
        </div>
        
        <!-- Config Source - Footer (legacy, kept for version info) -->
        <div class="meli-calc-footer">
          <span id="meli-calc-source">~ Estimado</span>
          <span id="meli-calc-version">v${FALLBACK_CONFIG.version}</span>
        </div>
      </div>
    `;
    
    return div;
  }

  function attachEventListeners() {
    // Toggle minimize
    const header = panelElement.querySelector('.meli-calc-header');
    const toggleBtn = panelElement.querySelector('.meli-calc-toggle');
    
    const headerClickListener = (e) => {
      if (e.target === toggleBtn || e.target.closest('.meli-calc-toggle')) {
        e.stopPropagation();
      }
      isMinimized = !isMinimized;
      panelElement.classList.toggle('meli-calc-minimized', isMinimized);
      toggleBtn.textContent = isMinimized ? '+' : '−';
      savePreference(STORAGE_KEYS.MINIMIZED, isMinimized);
    };
    header.addEventListener('click', headerClickListener);
    currentListeners.push({ element: header, event: 'click', listener: headerClickListener });

    // Envío gratis checkbox
    const envioGratisCheckbox = panelElement.querySelector('#meli-envio-gratis');
    const costoEnvioWrap = panelElement.querySelector('#meli-costo-envio-wrap');
    
    const envioChangeListener = () => {
      costoEnvioWrap.classList.toggle('meli-calc-hidden', !envioGratisCheckbox.checked);
      debouncedCalculate();
    };
    envioGratisCheckbox.addEventListener('change', envioChangeListener);
    currentListeners.push({ element: envioGratisCheckbox, event: 'change', listener: envioChangeListener });

    // Save preferences on change
    const tipoPubSelect = panelElement.querySelector('#meli-tipo-pub');
    const cuotasSelect = panelElement.querySelector('#meli-cuotas');
    const cuotasGroup = panelElement.querySelector('#meli-cuotas-group');
    const provinciaSelect = panelElement.querySelector('#meli-provincia');
    const costoProductoInput = panelElement.querySelector('#meli-costo-producto');

    const updateCuotasVisibility = (tipoPub) => {
      if (cuotasGroup) {
        cuotasGroup.style.display = tipoPub === 'premium' ? 'block' : 'none';
      }
    };

    const tipoPubChangeListener = () => {
      savePreference(STORAGE_KEYS.TIPO_PUB, tipoPubSelect.value);
      updateCuotasVisibility(tipoPubSelect.value);
      debouncedCalculate();
    };
    tipoPubSelect.addEventListener('change', tipoPubChangeListener);
    currentListeners.push({ element: tipoPubSelect, event: 'change', listener: tipoPubChangeListener });

    // Initialize cuotas visibility based on current selection
    updateCuotasVisibility(tipoPubSelect.value);

    const cuotasChangeListener = () => {
      savePreference(STORAGE_KEYS.CUOTAS, cuotasSelect.value);
      debouncedCalculate();
    };
    cuotasSelect.addEventListener('change', cuotasChangeListener);
    currentListeners.push({ element: cuotasSelect, event: 'change', listener: cuotasChangeListener });

    const provinciaChangeListener = () => {
      savePreference(STORAGE_KEYS.PROVINCIA, provinciaSelect.value);
      debouncedCalculate();
    };
    provinciaSelect.addEventListener('change', provinciaChangeListener);
    currentListeners.push({ element: provinciaSelect, event: 'change', listener: provinciaChangeListener });

    const costoInputListener = () => {
      savePreference(STORAGE_KEYS.COSTO_PRODUCTO, costoProductoInput.value);
      debouncedCalculate();
    };
    costoProductoInput.addEventListener('input', costoInputListener);
    currentListeners.push({ element: costoProductoInput, event: 'input', listener: costoInputListener });

    // Real-time calculation on price/envío changes
    const precioVentaInput = panelElement.querySelector('#meli-precio-venta');
    const costoEnvioInput = panelElement.querySelector('#meli-costo-envio');

    const precioInputListener = () => debouncedCalculate();
    precioVentaInput.addEventListener('input', precioInputListener);
    currentListeners.push({ element: precioVentaInput, event: 'input', listener: precioInputListener });

    const costoEnvioInputListener = () => debouncedCalculate();
    costoEnvioInput.addEventListener('input', costoEnvioInputListener);
    currentListeners.push({ element: costoEnvioInput, event: 'input', listener: costoEnvioInputListener });

    // Calculate button
    const calcBtn = panelElement.querySelector('#meli-calc-btn');
    if (calcBtn) {
      const calcClickListener = () => calculateAndDisplay();
      calcBtn.addEventListener('click', calcClickListener);
      currentListeners.push({ element: calcBtn, event: 'click', listener: calcClickListener });
    }
  }

  function debouncedCalculate() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(calculateAndDisplay, 300);
  }

  function getInputValues() {
    const precioVenta = parseFloat(panelElement.querySelector('#meli-precio-venta').value) || 0;
    const costoProducto = parseFloat(panelElement.querySelector('#meli-costo-producto').value) || 0;
    const tipoPub = panelElement.querySelector('#meli-tipo-pub').value;
    const provincia = panelElement.querySelector('#meli-provincia').value;
    const envioGratis = panelElement.querySelector('#meli-envio-gratis').checked;
    const costoEnvio = envioGratis ? (parseFloat(panelElement.querySelector('#meli-costo-envio').value) || 0) : 0;
    const cuotas = parseInt(panelElement.querySelector('#meli-cuotas')?.value) || 6;

    return {
      precioVenta,
      costoProducto,
      tipoPub,
      provincia,
      envioGratis,
      costoEnvio,
      cuotas
    };
  }

  /**
   * Calculate and display results using hybrid 3-layer architecture
   */
  async function calculateAndDisplay() {
    const inputs = getInputValues();
    const calculationData = await obtenerDatosCalculo();
    
    // If user entered a manual price, override
    const price = inputs.precioVenta || calculationData.price || 0;
    
    if (price <= 0) return;

    // Load costoEnvio from sync storage
    let costoEnvioUsuario = 2800;
    try {
      const stored = await chrome.storage.sync.get(['costoEnvio']);
      if (stored.costoEnvio !== undefined) {
        costoEnvioUsuario = parseFloat(stored.costoEnvio) || 2800;
      }
    } catch (e) {
      console.log('[MeLi Calc] Could not load costoEnvio:', e.message);
    }

    const result = calcularRentabilidad(inputs, { ...calculationData, price }, costoEnvioUsuario);

    // Update display with result
    updateDisplay(result, inputs);
    
    // Update prominent source banner
    updateSourceBanner(result.source);
    
    // Also update legacy footer badge for compatibility
    updateSourceBadge(result.source);
  }

  /**
   * Update the display with calculation results
   * @param {Object} result - Calculation result from calcularRentabilidad
   * @param {Object} inputs - User input values
   */
  function updateDisplay(result, inputs) {
    const comisionEl = panelElement.querySelector('#meli-res-comision');
    const costoFijoEl = panelElement.querySelector('#meli-res-costo-fijo');
    const iibbEl = panelElement.querySelector('#meli-res-iibb');
    const envioEl = panelElement.querySelector('#meli-res-envio');
    const totalEl = panelElement.querySelector('#meli-res-total');
    const gananciaEl = panelElement.querySelector('#meli-res-ganancia');
    const margenEl = panelElement.querySelector('#meli-res-margen');
    const versionEl = panelElement.querySelector('#meli-calc-version');
    
    const lossAlertEl = panelElement.querySelector('.meli-loss-alert');
    const marginBadgeEl = panelElement.querySelector('.meli-margin-badge');

    comisionEl.textContent = formatCurrency(result.comisionMonto) + ` (${(result.comisionPorcentaje * 100).toFixed(1)}%)`;
    costoFijoEl.textContent = formatCurrency(result.costoFijoMonto);
    iibbEl.textContent = formatCurrency(result.iibbMonto) + ` (${(result.tasaIIBB * 100).toFixed(2)}%)`;
    envioEl.textContent = formatCurrency(result.envioEfectivo);
    totalEl.textContent = formatCurrency(result.totalDescuentos);
    
    gananciaEl.textContent = formatCurrency(result.gananciaNeta);
    gananciaEl.className = result.gananciaNeta >= 0 ? 'meli-calc-positive' : 'meli-calc-negative';
    
    margenEl.textContent = result.margen.toFixed(1) + '%';
    margenEl.className = result.gananciaNeta >= 0 ? 'meli-calc-positive' : 'meli-calc-negative';

    // Loss warning
    if (lossAlertEl) {
      lossAlertEl.style.display = result.gananciaNeta < 0 ? 'block' : 'none';
    }
    
    // Low margin badge
    if (marginBadgeEl) {
      marginBadgeEl.style.display = result.margen < 10 ? 'inline-block' : 'none';
    }

    // Update version
    versionEl.textContent = `v${result.configVersion}`;

    // Save to history
    saveToHistory({
      titulo: getProductTitle(),
      precio: result.price,
      gananciaNeta: result.gananciaNeta,
      margen: result.margen
    });

    // Save health report for telemetry
    saveHealthReport(lastSelectorUsado, result.configVersion, result.source);
  }

  async function initPanel() {
    // Prevent duplicate injection
    if (panelInjected && document.getElementById('meli-calc-panel')) {
      return;
    }

    // Check if we're on a product page
    if (!isProductPage()) {
      return;
    }

    // Mark as attempting injection
    panelInjected = true;

    console.log('[MeLi Calc] Initializing panel...');

    // Load config in background
    loadConfig().then(config => {
      currentConfig = config;
    }).catch(err => console.log('[MeLi Calc] Config preload failed:', err));

    // Try to detect price - if null initially, start observer with 3-second timeout
    let precioVenta;
    let selectorUsado = null;
    const resultadoInicial = detectarPrecio();
    
    if (resultadoInicial.price !== null) {
      precioVenta = resultadoInicial.price;
      selectorUsado = resultadoInicial.selector;
    } else {
      const resultadoObservado = await new Promise((resolve) => {
        priceObserver = new MutationObserver(() => {
          const nuevoResultado = detectarPrecio();
          if (nuevoResultado.price !== null) {
            priceObserver?.disconnect();
            resolve(nuevoResultado);
          }
        });
        
        priceObserver.observe(document.body, {
          childList: true,
          subtree: true
        });
        
        setTimeout(() => {
          priceObserver?.disconnect();
          resolve({ price: null, selector: null });
        }, 3000);
      });
      precioVenta = resultadoObservado.price;
      selectorUsado = resultadoObservado.selector;
    }
    
    lastSelectorUsado = selectorUsado;
    
    // Load saved preferences
    const preferences = await loadPreferences();
    
    // Inject styles
    injectStyles();
    
    // Create and inject panel (even with empty price - user can enter manually)
    panelElement = createPanelHTML(precioVenta, preferences);
    document.body.appendChild(panelElement);
    
    // Attach event listeners
    cleanupEventListeners();
    attachEventListeners();
    
    // Prefill from API data if available (async, non-blocking)
    prefetchAndPrefill();
    
    // Initial calculation only if we have a price
    if (precioVenta && precioVenta > 0) {
      calculateAndDisplay();
    } else {
      // Show default banner state for when no price
      updateSourceBanner('dom');
    }
    
    console.log('[MeLi Calc] Panel injected successfully' + (precioVenta ? '' : ' (sin precio detectado)'));
  }

  /**
   * Fetch item data from API and prefill panel fields
   * This runs async after panel is shown so it doesn't block initialization
   */
  async function prefetchAndPrefill() {
    try {
      const itemId = getItemId();
      if (!itemId) return;

      const itemData = await fetchItemData(itemId);
      if (!itemData) return;

      // Prefill price if not already set
      const precioInput = panelElement.querySelector('#meli-precio-venta');
      if (precioInput && !precioInput.value && itemData.price) {
        precioInput.value = itemData.price;
      }

      // Auto-check free shipping if item has it
      if (itemData.freeShipping) {
        const envioGratisCheckbox = panelElement.querySelector('#meli-envio-gratis');
        const costoEnvioWrap = panelElement.querySelector('#meli-costo-envio-wrap');
        if (envioGratisCheckbox) {
          envioGratisCheckbox.checked = true;
          costoEnvioWrap.classList.remove('meli-calc-hidden');
        }
      }

      // Set listing type if detected
      if (itemData.listingType) {
        const tipoPubSelect = panelElement.querySelector('#meli-tipo-pub');
        if (tipoPubSelect && itemData.listingType) {
          const tipoMap = {
            'special': 'clasica',
            'pro': 'premium',
            'premium': 'premium'
          };
          const tipoValue = tipoMap[itemData.listingType] || 'clasica';
          // Only set if the option exists
          const option = tipoPubSelect.querySelector(`option[value="${tipoValue}"]`);
          if (option) {
            tipoPubSelect.value = tipoValue;
            // Trigger visibility update for cuotas if premium
            tipoPubSelect.dispatchEvent(new Event('change'));
          }
        }
      }
    } catch (e) {
      console.warn('[MeLi Calc] prefetchAndPrefill failed:', e.message);
    }
  }

  function cleanupEventListeners() {
    currentListeners.forEach(({ element, event, listener }) => {
      element?.removeEventListener(event, listener);
    });
    currentListeners = [];
    
    if (priceObserver) {
      priceObserver.disconnect();
      priceObserver = null;
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPanel);
  } else {
    initPanel();
  }

  // Handle SPA navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      const existingPanel = document.getElementById('meli-calc-panel');
      if (existingPanel) {
        cleanupEventListeners();
        existingPanel.remove();
        panelElement = null;
      }
      panelInjected = false;
      setTimeout(initPanel, 500);
    }
  }).observe(document, { subtree: true, childList: true });

  // ═══ HEALTH CHECK REPORTING (UNCHANGED) ═══

  async function saveHealthReport(selectorUsado, configVersion, configFuente) {
    try {
      await chrome.storage.local.set({
        last_health_report: {
          timestamp: Date.now(),
          selector_usado: selectorUsado,
          config_version: configVersion,
          config_fuente: configFuente
        }
      });
    } catch (error) {
      console.log('[MeLi Calc] Health report failed:', error.message);
    }
  }

})();
