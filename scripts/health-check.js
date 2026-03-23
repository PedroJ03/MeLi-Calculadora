const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');

const TEST_URL = "https://www.mercadolibre.com.ar/notebook-lenovo-ideapad/p/MLA27977789";
const SELECTORES_PRECIO = [
  'span.andes-money-amount__fraction',
  '.ui-pdp-price__second-line .andes-money-amount__fraction',
  'meta[itemprop="price"]'
];

async function healthCheck() {
  console.log('🔍 Iniciando health check...');
  console.log(`🌐 URL de prueba: ${TEST_URL}`);
  
  let browser = null;
  
  try {
    // Launch browser with realistic headers
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Set realistic user agent and headers
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-AR,es;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });

    // Set viewport
    await page.setViewport({ width: 1280, height: 720 });
    
    // Navigate to test URL
    console.log('⏳ Navegando...');
    await page.goto(TEST_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait up to 8 seconds for price to load
    console.log('⏳ Esperando carga de precio (max 8s)...');
    await new Promise(r => setTimeout(r, 2000)); // Initial wait
    
    let precioDetectado = null;
    let selectorUsado = null;
    
    // Try each selector
    for (const selector of SELECTORES_PRECIO) {
      console.log(`🎯 Probando selector: ${selector}`);
      
      const resultado = await page.evaluate((sel) => {
        const elements = document.querySelectorAll(sel);
        if (elements.length === 0) return null;
        
        // For multiple elements, take the last one (usually discounted price)
        const element = elements[elements.length - 1];
        
        let rawValue;
        if (element.tagName.toLowerCase() === 'meta') {
          rawValue = element.getAttribute('content');
        } else {
          rawValue = element.textContent;
        }
        
        if (!rawValue) return null;
        
        // Parse AR format
        const cleaned = rawValue.replace(/\./g, '').replace(',', '.').trim();
        const value = parseFloat(cleaned);
        
        return { value, raw: rawValue };
      }, selector);
      
      if (resultado && resultado.value > 0) {
        console.log(`✅ Selector funcionó: ${selector} => $${resultado.value}`);
        precioDetectado = resultado.value;
        selectorUsado = selector;
        break;
      } else {
        console.log(`❌ Selector falló: ${selector}`);
      }
    }
    
    // Check if any price was detected
    if (!precioDetectado) {
      console.error('❌ FALLA: Ningún selector detectó precio');
      
      // Take screenshot
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
      console.log('\n📸 Screenshot (base64):');
      console.log(screenshot.substring(0, 200) + '...');
      
      // Get HTML of price area
      const html = await page.evaluate(() => {
        const priceSection = document.querySelector('.ui-pdp-price, [data-testid="price"], .andes-money-amount');
        return priceSection ? priceSection.outerHTML : document.body.innerHTML.substring(0, 2000);
      });
      
      console.log('\n📝 HTML del área de precio:');
      console.log(html);
      
      process.exit(1);
    }
    
    // Validate price range
    if (precioDetectado < 100 || precioDetectado > 99999999) {
      console.error(`⚠️ Precio detectado fuera de rango: $${precioDetectado} - posible error de parseo`);
      process.exit(1);
    }
    
    console.log(`\n✅ Health check OK`);
    console.log(`   Precio detectado: $${precioDetectado}`);
    console.log(`   Selector usado: ${selectorUsado}`);
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error en health check:', error.message);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

healthCheck();
