const fs = require('fs');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CONFIG_FILE = 'config.json';
const CANDIDATE_FILE = 'config.json.candidate';
const URL = 'https://www.mercadolibre.com.ar/ayuda/Costos-de-vender-un-producto_870';
const VARIATION_THRESHOLD = 5; // 5 percentage points

async function scrapeTarifas() {
  console.log('🔍 Scrapeando tarifas de MeLi...');
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
        clasica_default: 0.13,
        premium_recargos: { "3": 0.09, "6": 0.142, "9": 0.189, "12": 0.232 },
        interes_bajo_recargo: 0.05
      },
      costo_unidad: {},
      iibb: {}
    };
    if (fs.existsSync(CONFIG_FILE)) {
      currentConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log('📂 Config actual cargado');
    }

    const newConfig = JSON.parse(JSON.stringify(currentConfig));

    // Asegurar estructura de comisiones existe
    if (!newConfig.comisiones) {
      newConfig.comisiones = {};
    }

    // 1. Comisión Clásica (Rango)
    console.log('--- Procesando Comisión Clásica ---');
    let clasicaPercent = 0.13; // default

    // Buscar texto "Entre X% y Y%" cerca de "Cargo por vender"
    const clasicaRegex = /Entre\s+(\d+[.,]\d+)\%\s+y\s+(\d+[.,]\d+)\%/i;
    $('p, span, td').each((i, el) => {
      const text = $(el).text().trim();
      const match = text.match(clasicaRegex);
      if (match) {
        const minPct = parseFloat(match[1].replace(',', '.'));
        const maxPct = parseFloat(match[2].replace(',', '.'));
        // Usar el valor más frecuente (min) como default
        clasicaPercent = minPct / 100;
        console.log(`Found Clásica: ${minPct}% - ${maxPct}%, usando ${minPct}% como default`);
        return false; // break
      }
    });

    newConfig.comisiones.clasica_default = parseFloat(clasicaPercent.toFixed(4));

    // 2. Premium: Recargos por cuota
    console.log('--- Procesando Premium (recargos por cuota) ---');

    // Buscar patrones para cada cantidad de cuotas
    const cuotasPatterns = [
      { cuotas: '3', regex: /3\s+cuota[s]?\s*\|\s*Pagás\s*(\d+[.,]\d+)\%/i },
      { cuotas: '6', regex: /6\s+cuota[s]?\s*\|\s*Pagás\s*(\d+[.,]\d+)\%/i },
      { cuotas: '9', regex: /9\s+cuota[s]?\s*\|\s*Pagás\s*(\d+[.,]\d+)\%/i },
      { cuotas: '12', regex: /12\s+cuota[s]?\s*\|\s*Pagás\s*(\d+[.,]\d+)\%/i }
    ];

    if (!newConfig.comisiones.premium_recargos) {
      newConfig.comisiones.premium_recargos = {};
    }

    cuotasPatterns.forEach(({ cuotas, regex }) => {
      $('p, span, td').each((i, el) => {
        const text = $(el).text().trim();
        const match = text.match(regex);
        if (match) {
          const recargo = parseFloat(match[1].replace(',', '.')) / 100;
          newConfig.comisiones.premium_recargos[cuotas] = parseFloat(recargo.toFixed(4));
          console.log(`Found Recargo ${cuotas} cuotas: ${(recargo * 100).toFixed(1)}%`);
          return false;
        }
      });
    });

    // 3. Interés bajo recargo
    console.log('--- Procesando Interés Bajo ---');
    let interesBajoRecargo = 0.05;

    // Buscar "3 a 12 cuotas | Pagás 5%" (interés bajo)
    const interesRegex = /3\s+a\s+12\s+cuota[s]?\s*\|\s*Pagás\s*(\d+[.,]\d+)\%/i;
    $('p, span, td').each((i, el) => {
      const text = $(el).text().trim();
      const match = text.match(interesRegex);
      if (match) {
        interesBajoRecargo = parseFloat(match[1].replace(',', '.')) / 100;
        console.log(`Found Interés Bajo: ${(interesBajoRecargo * 100).toFixed(1)}%`);
        return false;
      }
    });

    newConfig.comisiones.interes_bajo_recargo = parseFloat(interesBajoRecargo.toFixed(4));

    // 4. Costos Fijos (solo si existe costo_unidad)
    if (newConfig.costo_unidad && newConfig.costo_unidad.fijo_escalonado) {
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

        // Normalizamos el "hasta"
        if (hasta === 15999) hasta = 16000;
        if (hasta === 23999) hasta = 24000;

        mapCostos.set(hasta, costo);
      }

      if (mapCostos.size > 0) {
        const sortedHastas = Array.from(mapCostos.keys()).sort((a, b) => a - b);
        const nuevosCostosFijos = sortedHastas.map(h => ({ max: h, fee: mapCostos.get(h) }));

        newConfig.costo_unidad.fijo_escalonado = nuevosCostosFijos;
        console.log('Nuevos costos fijos encontrados:', nuevosCostosFijos);
      } else {
        console.log('⚠️ No se encontraron costos fijos dinámicos. Manteniendo anteriores.');
      }
    }

    // Validar Variaciones (sobre clasica_default y premium_recargos[6])
    let maxVariation = 0;

    const oldClasica = (currentConfig.comisiones?.clasica_default || 0.13) * 100;
    const newClasica = newConfig.comisiones.clasica_default * 100;
    const diffClasica = Math.abs(newClasica - oldClasica);
    console.log(`Clásica: ${oldClasica.toFixed(2)}% -> ${newClasica.toFixed(2)}% (Diff: ${diffClasica.toFixed(2)}pp)`);
    maxVariation = Math.max(maxVariation, diffClasica);

    const oldPremium = ((currentConfig.comisiones?.clasica_default || 0.13) + (currentConfig.comisiones?.premium_recargos?.['6'] || 0.142)) * 100;
    const newPremium = (newConfig.comisiones.clasica_default + (newConfig.comisiones.premium_recargos?.['6'] || 0.142)) * 100;
    const diffPremium = Math.abs(newPremium - oldPremium);
    console.log(`Premium (6 cuotas): ${oldPremium.toFixed(2)}% -> ${newPremium.toFixed(2)}% (Diff: ${diffPremium.toFixed(2)}pp)`);
    maxVariation = Math.max(maxVariation, diffPremium);

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
