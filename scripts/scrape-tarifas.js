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
    const response = await fetch(URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Buscar tablas con porcentajes
    const porcentajes = [];
    $('table td, table th').each((i, el) => {
      const text = $(el).text().trim();
      // Buscar patrones como "13%", "15,5%", "13.5%"
      const match = text.match(/(\d+[.,]?\d*)\s*%/);
      if (match) {
        const valor = parseFloat(match[1].replace(',', '.'));
        porcentajes.push(valor);
      }
    });
    
    console.log(`📊 Porcentajes encontrados: ${porcentajes.join(', ')}`);
    
    if (porcentajes.length === 0) {
      console.log('⚠️ No se encontraron porcentajes en la página');
      process.exit(0);
    }
    
    // Leer config actual
    let currentConfig = {};
    if (fs.existsSync(CONFIG_FILE)) {
      currentConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log('📂 Config actual cargado');
    } else {
      console.log('📂 No existe config.json, creando nuevo');
      currentConfig = {
        version: "2025-01",
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
          "Córdoba": 0.0475
          // ... resto de provincias
        }
      };
    }
    
    // Crear nuevo config con valores scrapeados
    const newConfig = JSON.parse(JSON.stringify(currentConfig));
    
    // Actualizar comisiones si encontramos valores razonables
    if (porcentajes.length >= 2) {
      // Ordenar y tomar valores únicos
      const valoresUnicos = [...new Set(porcentajes)].sort((a, b) => a - b);
      
      // Asignar a tipos de publicación (ejemplo: valores más bajos = clásica)
      if (valoresUnicos.length >= 1) {
        const tasa = valoresUnicos[0] / 100;
        newConfig.comisiones.clasica.default = tasa;
      }
      if (valoresUnicos.length >= 2) {
        const tasa = valoresUnicos[1] / 100;
        newConfig.comisiones.cuotas_precio.default = tasa;
      }
    }
    
    // Calcular variación máxima
    let maxVariation = 0;
    const comisionesActuales = [
      currentConfig.comisiones.clasica.default * 100,
      currentConfig.comisiones.cuotas_precio.default * 100,
      currentConfig.comisiones.cuotas_interes.default * 100
    ];
    const comisionesNuevas = [
      newConfig.comisiones.clasica.default * 100,
      newConfig.comisiones.cuotas_precio.default * 100,
      newConfig.comisiones.cuotas_interes.default * 100
    ];
    
    for (let i = 0; i < comisionesActuales.length; i++) {
      const variation = Math.abs(comisionesNuevas[i] - comisionesActuales[i]);
      if (variation > maxVariation) {
        maxVariation = variation;
      }
    }
    
    console.log(`📈 Variación máxima: ${maxVariation.toFixed(2)} puntos porcentuales`);
    
    // Decidir qué hacer
    if (maxVariation > VARIATION_THRESHOLD) {
      // Variación muy grande - probable error de parseo
      console.log(`⚠️ Variación muy grande (> ${VARIATION_THRESHOLD}pp). Creando archivo candidate.`);
      
      fs.writeFileSync(CANDIDATE_FILE, JSON.stringify(newConfig, null, 2));
      console.log(`📝 Archivo creado: ${CANDIDATE_FILE}`);
      
      // Crear issue en GitHub
      await createGitHubIssue(currentConfig, newConfig, maxVariation);
      
    } else {
      // Variación razonable - actualizar directamente
      console.log('✅ Variación razonable. Actualizando config.json...');
      
      // Actualizar versión con fecha actual (YYYY-MM)
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      newConfig.version = `${year}-${month}`;
      
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
      console.log(`📝 Archivo actualizado: ${CONFIG_FILE}`);
      console.log(`🏷️ Nueva versión: ${newConfig.version}`);
    }
    
  } catch (error) {
    console.error('❌ Error scrapeando:', error.message);
    process.exit(1);
  }
}

async function createGitHubIssue(currentConfig, newConfig, variation) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('⚠️ No hay GITHUB_TOKEN, no se puede crear issue');
    return;
  }
  
  const repo = process.env.GITHUB_REPOSITORY || 'owner/repo';
  const [owner, repoName] = repo.split('/');
  
  const diff = `
## Variación detectada: ${variation.toFixed(2)} puntos porcentuales

### Comisiones actuales:
- Clásica: ${(currentConfig.comisiones.clasica.default * 100).toFixed(1)}%
- Cuotas (precio): ${(currentConfig.comisiones.cuotas_precio.default * 100).toFixed(1)}%
- Cuotas (interés): ${(currentConfig.comisiones.cuotas_interes.default * 100).toFixed(1)}%

### Comisiones scrapeadas:
- Clásica: ${(newConfig.comisiones.clasica.default * 100).toFixed(1)}%
- Cuotas (precio): ${(newConfig.comisiones.cuotas_precio.default * 100).toFixed(1)}%
- Cuotas (interés): ${(newConfig.comisiones.cuotas_interes.default * 100).toFixed(1)}%

### Acción requerida:
Revisar si los valores scrapeados son correctos. Si es así, renombrar \`config.json.candidate\` a \`config.json\`.
  `;
  
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: '⚠️ Revisar tarifas scrapeadas',
        body: diff,
        labels: ['tarifas', 'revision-requerida']
      })
    });
    
    if (response.ok) {
      const issue = await response.json();
      console.log(`🎫 Issue creado: ${issue.html_url}`);
    } else {
      console.log('⚠️ No se pudo crear issue:', await response.text());
    }
  } catch (error) {
    console.log('⚠️ Error creando issue:', error.message);
  }
}

scrapeTarifas();
