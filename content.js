/**
 * MeLi Calculadora - Content Script
 * Uses official MeLi API when available, falls back to hardcoded config
 */

(function() {
  'use strict';

  // ═══ CONSTANTS ═══

  const API_BASE = 'https://api.mercadolibre.com';
  const SESSION_CACHE_KEY = 'meli_session';

  // Keep FALLBACK_CONFIG for when API is not available
  const FALLBACK_CONFIG = {
    version: "2025-07",
    comisiones: {
      clasica: { min: 0.1162, max: 0.1714, default: 0.13 },
      cuotas_precio: { min: 0.15, max: 0.1775, default: 0.16 },
      cuotas_interes: { min: 0.1162, max: 0.1714, default: 0.13 }
    },
    costo_fijo: [
      { hasta: 15000, costo: 1095 },
      { hasta: 25000, costo: 2190 },
      { hasta: 33000, costo: 2628 },
      { hasta: 999999999, costo: 0 }
    ],
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
      const fetchPromise = fetch(CONFIG_URL);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('timeout')), 5000)
      );
      
      const response = await Promise.race([fetchPromise, timeoutPromise]);
      
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

  // ═══ PART 1: TOKEN EXTRACTION (Strategies A, B, C, D in cascade) ═══

  async function extractMelIToken() {
    // Check session cache first
    try {
      const cached = await chrome.storage.session.get([SESSION_CACHE_KEY]);
      if (cached[SESSION_CACHE_KEY] && 
          cached[SESSION_CACHE_KEY].expiry > Date.now()) {
        console.log('[MeLi Calc] Using cached session token');
        return cached[SESSION_CACHE_KEY].token;
      }
    } catch (e) {}

    let token = null;

    // Strategy A: Cookie
    try {
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name.includes('access_token') || name.includes('bearer') || name.includes('session')) {
          if (value && value.length > 20) {
            token = decodeURIComponent(value);
            console.log('[MeLi Calc] Token found in cookie:', name);
            break;
          }
        }
      }
    } catch (e) { console.log('[MeLi Calc] Cookie strategy failed:', e.message); }

    // Strategy B: localStorage/sessionStorage
    if (!token) {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          const value = localStorage.getItem(key);
          if (value && /APP_USR-\d+-\w+-\w+-\d+/.test(value)) {
            // Try to parse as JSON first
            try {
              const parsed = JSON.parse(value);
              if (parsed.access_token) {
                token = parsed.access_token;
                console.log('[MeLi Calc] Token found in localStorage:', key);
                break;
              }
            } catch {}
            // Try as raw token
            const match = value.match(/APP_USR-\d+-\w+-\w+-\d+/);
            if (match) {
              token = match[0];
              console.log('[MeLi Calc] Token found in localStorage:', key);
              break;
            }
          }
        }
      } catch (e) { console.log('[MeLi Calc] localStorage strategy failed:', e.message); }
    }

    // Strategy C: Check window globals (MeLi preload state)
    if (!token) {
      try {
        const globals = ['__PRELOADED_STATE__', '__STATE__', '__store__', 'MELI', 'ML'];
        for (const globalName of globals) {
          if (window[globalName]) {
            const globalVal = window[globalName];
            let found = null;
            if (typeof globalVal === 'object') {
              found = globalVal.access_token || globalVal.user?.id || 
                     globalVal.userId || globalVal.Usuario?.id;
            }
            if (found) {
              token = found;
              console.log('[MeLi Calc] Token found in window.' + globalName);
              break;
            }
          }
        }
      } catch (e) { console.log('[MeLi Calc] Global strategy failed:', e.message); }
    }

    // Strategy D: Look for JSON in script tags
    if (!token) {
      try {
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const content = script.textContent;
          if (content && content.includes('APP_USR')) {
            const match = content.match(/"access_token"\s*:\s*"([^"]+)"/);
            if (match) {
              token = match[1];
              console.log('[MeLi Calc] Token found in script tag');
              break;
            }
          }
        }
      } catch (e) { console.log('[MeLi Calc] Script strategy failed:', e.message); }
    }

    // Cache if found
    if (token) {
      try {
        await chrome.storage.session.set({
          [SESSION_CACHE_KEY]: {
            token: token,
            expiry: Date.now() + (6 * 60 * 60 * 1000) // 6 hours
          }
        });
      } catch (e) {}
    }

    return token;
  }

  // ═══ PART 2: GET ITEM DATA FROM API ═══

  async function getItemData(itemId, token) {
    const url = `${API_BASE}/items/${itemId}`;
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        console.warn('[MeLi Calc] Item API failed:', response.status);
        return null;
      }
      const data = await response.json();
      return {
        category_id: data.category_id,
        listing_type_id: data.listing_type_id,
        price: data.price,
        original_price: data.original_price
      };
    } catch (e) {
      console.warn('[MeLi Calc] Item fetch failed:', e.message);
      return null;
    }
  }

  // ═══ PART 3: GET LISTING PRICES FROM API ═══

  async function getListingPrices(price, listingTypeId, categoryId, token) {
    const url = `${API_BASE}/sites/MLA/listing_prices?` +
      `price=${price}&listing_type_id=${listingTypeId}&category_id=${categoryId}`;
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        console.warn('[MeLi Calc] Listing prices API failed:', response.status);
        return null;
      }
      const data = await response.json();
      if (data && data.costs) {
        return {
          sale_fee_amount: data.costs.sale_fee_amount,
          fixed_amount: data.costs.fixed_amount
        };
      }
      return null;
    } catch (e) {
      console.warn('[MeLi Calc] Listing prices fetch failed:', e.message);
      return null;
    }
  }

  // ═══ PART 4: GET ITEM ID FROM URL ═══

  function extractItemIdFromUrl() {
    // Match MLA followed by numbers, or any item ID pattern in URL path
    const urlMatch = window.location.pathname.match(/\/([A-Z]{3}\d+)(?:\/|$)/);
    if (urlMatch) {
      return urlMatch[1];
    }
    // Also try to match other patterns like /items/MLA123456789
    const itemMatch = window.location.pathname.match(/\/items\/([A-Z]{3}\d+)/i);
    if (itemMatch) {
      return itemMatch[1];
    }
    return null;
  }

  // ═══ PART 5: HYBRID CALCULATION WITH API ═══

  async function calculateWithAPI(precioVenta, params, config) {
    // Extract item_id from URL
    const itemId = extractItemIdFromUrl();
    if (!itemId) {
      console.log('[MeLi Calc] Could not extract item_id from URL');
      return null;
    }
    console.log('[MeLi Calc] Extracted item_id:', itemId);

    // Try to get token
    const token = await extractMelIToken();

    // Get item data
    const itemData = await getItemData(itemId, token);
    if (!itemData) {
      console.log('[MeLi Calc] Could not get item data, using fallback');
      return null;
    }
    console.log('[MeLi Calc] Item data:', itemData);

    // Get listing prices
    const prices = await getListingPrices(
      itemData.price || precioVenta,
      itemData.listing_type_id,
      itemData.category_id,
      token
    );

    if (!prices) {
      console.log('[MeLi Calc] Could not get listing prices, using fallback');
      return null;
    }
    console.log('[MeLi Calc] Listing prices:', prices);

    // Calculate using real API data
    const tipoPub = params.tipoPub || 'clasica';
    const provincia = params.provincia || 'Buenos Aires';
    const tasaIIBB = config.iibb?.[provincia] ?? 0.025;
    const envioEfectivo = params.envioGratis ? (params.costoEnvio || 0) : 0;

    const comisionExacta = prices.sale_fee_amount;
    const costoFijoExact = prices.fixed_amount;
    const iibb = precioVenta * tasaIIBB;

    const totalDesctos = comisionExacta + costoFijoExact + iibb + envioEfectivo;
    const gananciaNeta = precioVenta - totalDesctos - (params.costoProducto || 0);
    const margen = precioVenta > 0 ? (gananciaNeta / precioVenta) * 100 : 0;

    return {
      precioVenta,
      tasaComision: comisionExacta / precioVenta,
      comisionExacta,
      costoFijoExact,
      tasaIIBB,
      iibb,
      envioEfectivo,
      totalDesctos,
      costoProducto: params.costoProducto || 0,
      gananciaNeta,
      margen,
      configVersion: 'API',
      fuenteConfig: 'api',
      isApiData: true
    };
  }

  // ═══ PART 6: DETECCIÓN DE PRECIO RESILIENTE ═══

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

  // ═══ PART 7: FALLBACK CALCULATION (original logic) ═══

  function calcularRentabilidad(params, config) {
    const {
      precioVenta,
      costoProducto = 0,
      tipoPub = 'clasica',
      provincia = 'Buenos Aires',
      envioGratis = false,
      costoEnvio = 0,
      comisionCustom = null
    } = params;
    
    // Get commission rate
    const tasaComision = comisionCustom !== null 
      ? comisionCustom 
      : (config.comisiones[tipoPub]?.default ?? 0.13);
    
    // Get fixed cost based on price bracket
    const costoFijo = config.costo_fijo?.find(r => precioVenta <= r.hasta)?.costo ?? 0;
    
    // Get IIBB rate (default to 0.025 if province not found)
    const tasaIIBB = config.iibb?.[provincia] ?? 0.025;
    const iibb = precioVenta * tasaIIBB;
    
    // Calculate effective shipping cost
    const envioEfectivo = envioGratis ? (costoEnvio || 0) : 0;
    
    // Calculate total deductions
    const totalDesctos = (precioVenta * tasaComision) + costoFijo + iibb + envioEfectivo;
    
    // Calculate net profit
    const gananciaNeta = precioVenta - totalDesctos - costoProducto;
    
    // Calculate margin percentage
    const margen = precioVenta > 0 ? (gananciaNeta / precioVenta) * 100 : 0;
    
    return {
      precioVenta,
      tasaComision,
      comisionExacta: precioVenta * tasaComision,
      costoFijoExact: costoFijo,
      tasaIIBB,
      iibb,
      envioEfectivo,
      totalDesctos,
      costoProducto,
      gananciaNeta,
      margen,
      configVersion: config.version || 'unknown',
      fuenteConfig: config._fuente || 'unknown',
      isApiData: false
    };
  }

  // ═══ PART 8: PANEL UI Y LÓGICA ═══

  // State
  let panelElement = null;
  let isMinimized = false;
  let debounceTimer = null;
  let currentConfig = null;
  let panelInjected = false; // Track if panel is already injected
  let currentListeners = []; // Store event listener references for cleanup
  let priceObserver = null; // MutationObserver for async price loading
  let lastSelectorUsado = null; // Track which selector detected the price for health reporting

  // Storage keys
  const STORAGE_KEYS = {
    PROVINCIA: 'meli_calc_provincia',
    TIPO_PUB: 'meli_calc_tipo_pub',
    COSTO_PRODUCTO: 'meli_calc_costo_producto',
    MINIMIZED: 'meli_calc_minimized'
  };

  // ═══ PART 9: HISTORIAL DE CÁLCULOS ═══

  /**
   * Get product title from the page
   */
  function getProductTitle() {
    // Try multiple selectors for product title
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

    // Fallback to page title
    return document.title.split('|')[0].split('-')[0].trim() || 'Producto sin nombre';
  }

  /**
   * Save calculation to history
   */
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

      // Keep max 5 items, FIFO
      const historial = [newItem, ...existing].slice(0, 5);

      await chrome.storage.local.set({ historial });
      console.log('[MeLi Calc] Saved to history:', newItem);
    } catch (error) {
      console.log('[MeLi Calc] Error saving to history:', error);
    }
  }

  /**
   * Check if we're on a MercadoLibre product page
   */
  function isProductPage() {
    return !!(
      document.querySelector('.ui-pdp-container') ||
      document.querySelector('.ui-pdp-header') ||
      document.querySelector('[data-testid="price"]') ||
      window.location.pathname.includes('/MLA-')
    );
  }

  /**
   * Load saved preferences from storage
   */
  async function loadPreferences() {
    try {
      const result = await chrome.storage.local.get([
        STORAGE_KEYS.PROVINCIA,
        STORAGE_KEYS.TIPO_PUB,
        STORAGE_KEYS.COSTO_PRODUCTO,
        STORAGE_KEYS.MINIMIZED
      ]);
      
      return {
        provincia: result[STORAGE_KEYS.PROVINCIA] || 'Buenos Aires',
        tipoPub: result[STORAGE_KEYS.TIPO_PUB] || 'clasica',
        costoProducto: result[STORAGE_KEYS.COSTO_PRODUCTO] || '',
        minimized: result[STORAGE_KEYS.MINIMIZED] || false
      };
    } catch (e) {
      return {
        provincia: 'Buenos Aires',
        tipoPub: 'clasica',
        costoProducto: '',
        minimized: false
      };
    }
  }

  /**
   * Save preference to storage
   */
  async function savePreference(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (e) {
      console.log('[MeLi Calc] Error saving preference:', e);
    }
  }

  /**
   * Format currency with $ and thousands separators
   */
  function formatCurrency(amount) {
    if (amount === null || amount === undefined || isNaN(amount)) return '-';
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    return '$' + num.toLocaleString('es-AR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }

  /**
   * Get config source indicator and label (extended for API)
   */
  function getConfigSourceInfo(fuente, isApiData) {
    // API data gets priority display
    if (isApiData) {
      return {
        indicator: '🔵',
        label: 'API oficial'
      };
    }
    
    const indicators = {
      'remota': '🌐',
      'cache': '💾',
      'fallback': '⚙️'
    };
    const labels = {
      'remota': 'Remota',
      'cache': 'Caché',
      'fallback': 'estimado'
    };
    return {
      indicator: indicators[fuente] || '⚙️',
      label: labels[fuente] || 'Local'
    };
  }

  /**
   * Create and inject panel styles
   */
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

  /**
   * Create the panel HTML structure
   */
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
              <option value="cuotas_precio" ${preferences.tipoPub === 'cuotas_precio' ? 'selected' : ''}>Cuotas (precio)</option>
              <option value="cuotas_interes" ${preferences.tipoPub === 'cuotas_interes' ? 'selected' : ''}>Cuotas (interés)</option>
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
        
        <!-- Config Source -->
        <div class="meli-calc-footer">
          <span id="meli-calc-source">⚙️ estimado</span>
          <span id="meli-calc-version">v--</span>
        </div>
      </div>
    `;
    
    return div;
  }

  /**
   * Attach event listeners to panel elements
   */
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
    const provinciaSelect = panelElement.querySelector('#meli-provincia');
    const costoProductoInput = panelElement.querySelector('#meli-costo-producto');

    const tipoPubChangeListener = () => {
      savePreference(STORAGE_KEYS.TIPO_PUB, tipoPubSelect.value);
      debouncedCalculate();
    };
    tipoPubSelect.addEventListener('change', tipoPubChangeListener);
    currentListeners.push({ element: tipoPubSelect, event: 'change', listener: tipoPubChangeListener });

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
    const calcClickListener = () => calculateAndDisplay();
    calcBtn.addEventListener('click', calcClickListener);
    currentListeners.push({ element: calcBtn, event: 'click', listener: calcClickListener });
  }

  /**
   * Debounced calculation
   */
  function debouncedCalculate() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(calculateAndDisplay, 300);
  }

  /**
   * Get current input values
   */
  function getInputValues() {
    const precioVenta = parseFloat(panelElement.querySelector('#meli-precio-venta').value) || 0;
    const costoProducto = parseFloat(panelElement.querySelector('#meli-costo-producto').value) || 0;
    const tipoPub = panelElement.querySelector('#meli-tipo-pub').value;
    const provincia = panelElement.querySelector('#meli-provincia').value;
    const envioGratis = panelElement.querySelector('#meli-envio-gratis').checked;
    const costoEnvio = envioGratis ? (parseFloat(panelElement.querySelector('#meli-costo-envio').value) || 0) : 0;

    return {
      precioVenta,
      costoProducto,
      tipoPub,
      provincia,
      envioGratis,
      costoEnvio
    };
  }

  /**
   * Calculate and display results (HYBRID: API first, fallback to hardcoded)
   */
  async function calculateAndDisplay() {
    const inputs = getInputValues();
    
    if (!currentConfig) {
      currentConfig = await loadConfig();
    }

    let result = null;
    let isApiData = false;

    // Try API first (only if we have a valid item on the page)
    if (inputs.precioVenta > 0 && extractItemIdFromUrl()) {
      result = await calculateWithAPI(inputs.precioVenta, inputs, currentConfig);
      if (result) {
        isApiData = true;
        console.log('[MeLi Calc] Using API data for calculation');
      }
    }

    // Fallback to hardcoded if API failed or not attempted
    if (!result) {
      result = calcularRentabilidad(inputs, currentConfig);
      console.log('[MeLi Calc] Using fallback config for calculation');
    }

    // Update results in DOM
    const comisionEl = panelElement.querySelector('#meli-res-comision');
    const costoFijoEl = panelElement.querySelector('#meli-res-costo-fijo');
    const iibbEl = panelElement.querySelector('#meli-res-iibb');
    const envioEl = panelElement.querySelector('#meli-res-envio');
    const totalEl = panelElement.querySelector('#meli-res-total');
    const gananciaEl = panelElement.querySelector('#meli-res-ganancia');
    const margenEl = panelElement.querySelector('#meli-res-margen');
    const sourceEl = panelElement.querySelector('#meli-calc-source');
    const versionEl = panelElement.querySelector('#meli-calc-version');
    
    // Get warning/warning badge elements
    const lossAlertEl = panelElement.querySelector('.meli-loss-alert');
    const marginBadgeEl = panelElement.querySelector('.meli-margin-badge');

    const comisionAmount = inputs.precioVenta * result.tasaComision;
    
    comisionEl.textContent = formatCurrency(comisionAmount) + ` (${(result.tasaComision * 100).toFixed(1)}%)`;
    costoFijoEl.textContent = formatCurrency(result.costoFijoExact || result.costoFijo);
    iibbEl.textContent = formatCurrency(result.iibb) + ` (${(result.tasaIIBB * 100).toFixed(2)}%)`;
    envioEl.textContent = formatCurrency(result.envioEfectivo);
    totalEl.textContent = formatCurrency(result.totalDesctos);
    
    gananciaEl.textContent = formatCurrency(result.gananciaNeta);
    gananciaEl.className = result.gananciaNeta >= 0 ? 'meli-calc-positive' : 'meli-calc-negative';
    
    margenEl.textContent = result.margen.toFixed(1) + '%';
    margenEl.className = result.gananciaNeta >= 0 ? 'meli-calc-positive' : 'meli-calc-negative';

    // Loss warning - show red alert if gananciaNeta < 0
    if (lossAlertEl) {
      lossAlertEl.style.display = result.gananciaNeta < 0 ? 'block' : 'none';
    }
    
    // Low margin badge - show yellow badge if margin < 10%
    if (marginBadgeEl) {
      marginBadgeEl.style.display = result.margen < 10 ? 'inline-block' : 'none';
    }

    // Update config source (API data gets special badge)
    const sourceInfo = getConfigSourceInfo(result.fuenteConfig, isApiData);
    sourceEl.textContent = `${sourceInfo.indicator} ${sourceInfo.label}`;
    versionEl.textContent = `v${result.configVersion}`;

    // Save to history
    saveToHistory({
      titulo: getProductTitle(),
      precio: inputs.precioVenta,
      gananciaNeta: result.gananciaNeta,
      margen: result.margen
    });

    // Save health report for telemetry
    saveHealthReport(lastSelectorUsado, result.configVersion, result.fuenteConfig);
  }

  /**
   * Initialize the panel
   */
  async function initPanel() {
    // Prevent duplicate injection - check at start and on URL changes
    if (panelInjected && document.getElementById('meli-calc-panel')) {
      return;
    }

    // Check if we're on a product page
    if (!isProductPage()) {
      return;
    }

    // Mark as attempting injection
    panelInjected = true;

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
      // No price detected initially - use MutationObserver with 3s timeout
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
        
        // Timeout after 3 seconds
        setTimeout(() => {
          priceObserver?.disconnect();
          resolve({ price: null, selector: null });
        }, 3000);
      });
      precioVenta = resultadoObservado.price;
      selectorUsado = resultadoObservado.selector;
    }
    
    // Store the selector used for health reporting
    lastSelectorUsado = selectorUsado;
    
    // Load saved preferences
    const preferences = await loadPreferences();
    
    // Inject styles
    injectStyles();
    
    // Create and inject panel (even with empty price - user can enter manually)
    panelElement = createPanelHTML(precioVenta, preferences);
    document.body.appendChild(panelElement);
    
    // Attach event listeners (clean up old ones first)
    cleanupEventListeners();
    attachEventListeners();
    
    // Initial calculation only if we have a price
    if (precioVenta && precioVenta > 0) {
      calculateAndDisplay();
    }
    
    console.log('[MeLi Calc] Panel injected successfully' + (precioVenta ? '' : ' (sin precio detectado)'));
  }

  /**
   * Clean up event listeners before re-adding
   */
  function cleanupEventListeners() {
    currentListeners.forEach(({ element, event, listener }) => {
      element?.removeEventListener(event, listener);
    });
    currentListeners = [];
    
    // Also disconnect price observer if exists
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

  // Handle SPA navigation (MercadoLibre is a SPA)
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      // Remove existing panel if URL changed
      const existingPanel = document.getElementById('meli-calc-panel');
      if (existingPanel) {
        cleanupEventListeners();
        existingPanel.remove();
        panelElement = null;
      }
      // Reset injection flag for new page
      panelInjected = false;
      // Re-initialize after a short delay
      setTimeout(initPanel, 500);
    }
  }).observe(document, { subtree: true, childList: true });

  // ═══ PART 10: HEALTH CHECK REPORTING ═══

  /**
   * Save health check report after successful calculation
   * This data can be used for anonymous telemetry to detect failing selectors
   */
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
      // Silently fail - health reporting is non-critical
      console.log('[MeLi Calc] Health report failed:', error.message);
    }
  }

})();
