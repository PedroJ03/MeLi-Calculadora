const fs = require('fs');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CONFIG_FILE = 'config.json';
const CANDIDATE_FILE = 'config.json.candidate';
const URL = 'https://www.mercadolibre.com.ar/ayuda/Costos-de-vender-un-producto_870';
const VARIATION_THRESHOLD = 5; // 5 percentage points

async function scrapeTarifas() {
  console.log('🔍 Scrapeando tarifas de MeLi (Modo Inteligente)...');
  console.log(`URL: ${URL}`);
  
  try {
    const response = await fetch(URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8'
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Leer config actual
    let currentConfig = {
        comisiones: {
            clasica: { min: 0.1162, max: 0.1714, default: 0.13 },
            cuotas_precio: { min: 0.15, max: 0.1775, default: 0.16 },
            cuotas_interes: { min: 0.1162, max: 0.1714, default: 0.13 }
        },
        costo_fijo: [],
        iibb: {}
    };
    if (fs.existsSync(CONFIG_FILE)) {
      currentConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log('📂 Config actual cargado');
    }

    const newConfig = JSON.parse(JSON.stringify(currentConfig));

    // 1. Comisión Clásica (Rango)
    console.log('--- Procesando Comisión Clásica ---');
    let clasicaMin = 0.1162;
    let clasicaMax = 0.1775;
    
    // Buscamos el texto "Entre X% y Y%" cerca de "Cargo por vender"
    const clasicaRegex = /Entre\s+(\d+[.,]\d+)\%\s+y\s+(\d+[.,]\d+)\%/i;
    $('p, span, td').each((i, el) => {
        const text = $(el).text().trim();
        const match = text.match(clasicaRegex);
        if (match) {
            clasicaMin = parseFloat(match[1].replace(',', '.')) / 100;
            clasicaMax = parseFloat(match[2].replace(',', '.')) / 100;
            return false; // break
        }
    });
    
    newConfig.comisiones.clasica.min = clasicaMin;
    newConfig.comisiones.clasica.max = clasicaMax;
    // El default lo mantenemos si está en rango
    if (newConfig.comisiones.clasica.default < clasicaMin || newConfig.comisiones.clasica.default > clasicaMax) {
        newConfig.comisiones.clasica.default = 0.13; // Valor histórico común
    }
    console.log(`Found Clásica: Min ${clasicaMin * 100}%, Max ${clasicaMax * 100}%`);

    // 2. Comisión Premium (Cuotas al mismo precio)
    console.log('--- Procesando Comisión Premium (6 cuotas) ---');
    let costo6Cuotas = 0;
    
    // Buscamos específicamente en la tabla de cuotas
    const cuotas6Regex = /6\s+cuotas\s*\|\s*Pagás\s*(\d+[.,]\d+)\%/i;
    $('p, span, td').each((i, el) => {
        const text = $(el).text().trim();
        const match = text.match(cuotas6Regex);
        if (match) {
            costo6Cuotas = parseFloat(match[1].replace(',', '.')) / 100;
            console.log(`Found Costo 6 Cuotas: ${costo6Cuotas * 100}%`);
            return false;
        }
    });

    if (costo6Cuotas > 0) {
        newConfig.comisiones.cuotas_precio.default = parseFloat((newConfig.comisiones.clasica.default + costo6Cuotas).toFixed(4));
        newConfig.comisiones.cuotas_precio.min = parseFloat((newConfig.comisiones.clasica.min + costo6Cuotas).toFixed(4));
        newConfig.comisiones.cuotas_precio.max = parseFloat((newConfig.comisiones.clasica.max + costo6Cuotas).toFixed(4));
    }

    // 3. Costos Fijos
    console.log('--- Procesando Costos Fijos ---');
    const mapCostos = new Map();
    const costoFijoRegex = /(?:hasta|Entre)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:y\s*\$?\s*(\d+(?:\.\d+)?))?,\s*pagás\s*\$\s*(\d+(?:\.\d+)?)/gi;
    
    const fullText = $('body').text();
    let match;
    while ((match = costoFijoRegex.exec(fullText)) !== null) {
        let hasta;
        if (match[2]) {
            hasta = parseFloat(match[2].replace('.', ''));
        } else {
            hasta = parseFloat(match[1].replace('.', ''));
        }
        const costo = parseFloat(match[3].replace('.', ''));
        
        // Normalizamos el "hasta" (ej: 15.999 -> 16000)
        if (hasta === 15999) hasta = 16000;
        if (hasta === 23999) hasta = 24000;
        
        mapCostos.set(hasta, costo);
    }

    if (mapCostos.size > 0) {
        const sortedHastas = Array.from(mapCostos.keys()).sort((a, b) => a - b);
        const nuevosCostosFijos = sortedHastas.map(h => ({ hasta: h, costo: mapCostos.get(h) }));
        
        // Agregar el infinito
        nuevosCostosFijos.push({ hasta: 999999999, costo: 0 });
        
        newConfig.costo_fijo = nuevosCostosFijos;
        console.log('Nuevos costos fijos encontrados:', nuevosCostosFijos);
    } else {
        console.log('⚠️ No se encontraron costos fijos dinámicos. Manteniendo anteriores.');
    }

    // 4. Lógica de Cuotas Interés (Igual a clásica según requerimiento de contexto)
    newConfig.comisiones.cuotas_interes = JSON.parse(JSON.stringify(newConfig.comisiones.clasica));

    // Validar Variaciones
    let maxVariation = 0;
    const targets = [
        { key: 'clasica', name: 'Clásica' },
        { key: 'cuotas_precio', name: 'Premium' }
    ];

    targets.forEach(t => {
        const oldVal = currentConfig.comisiones[t.key].default * 100;
        const newVal = newConfig.comisiones[t.key].default * 100;
        const diff = Math.abs(newVal - oldVal);
        console.log(`${t.name}: ${oldVal.toFixed(2)}% -> ${newVal.toFixed(2)}% (Diff: ${diff.toFixed(2)}pp)`);
        if (diff > maxVariation) maxVariation = diff;
    });

    // Actualizar versión
    const now = new Date();
    newConfig.version = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    if (maxVariation > VARIATION_THRESHOLD) {
        console.log(`\n⚠️ VARIACIÓN EXCEDIDA (${maxVariation.toFixed(2)}pp > ${VARIATION_THRESHOLD}pp)`);
        console.log(`Escribiendo en ${CANDIDATE_FILE}`);
        fs.writeFileSync(CANDIDATE_FILE, JSON.stringify(newConfig, null, 2));
    } else {
        console.log(`\n✅ Variación aceptable (${maxVariation.toFixed(2)}pp). Actualizando ${CONFIG_FILE}`);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
    }

  } catch (error) {
    console.error('❌ Error crítico en scraper:', error.message);
    process.exit(1);
  }
}

scrapeTarifas();
