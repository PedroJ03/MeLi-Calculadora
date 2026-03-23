/**
 * Health Check - Cloudflare Worker Proxy
 *
 * Este script prueba que el Cloudflare Worker proxy está funcionando.
 *
 * IMPORTANTE: MeLi API bloquea requests desde IPs de Cloudflare (403).
 * Esto afecta tanto a GitHub Actions como al Worker. El health check
 * verifica que el Worker esté vivo y procese respuestas correctamente,
 * sin esperar que MeLi devuelva datos reales.
 */

const WORKER_URL = "https://round-pond-5460.pedrojossi03.workers.dev";
const TEST_ITEM_ID = "MLA27977789"; // notebook lenovo ideapad

async function healthCheck() {
  console.log("🔍 Iniciando health check...");
  console.log(`🌐 Worker URL: ${WORKER_URL}`);
  console.log(`📦 Item ID de prueba: ${TEST_ITEM_ID}`);

  try {
    // Test 1: Worker /health está vivo
    console.log("\n⏳ Test 1: Health endpoint...");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const healthResponse = await fetch(`${WORKER_URL}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!healthResponse.ok) {
      console.error(`❌ Health endpoint falló: ${healthResponse.status}`);
      process.exit(1);
    }

    const healthData = await healthResponse.json();
    console.log(`✅ Worker vivo:`, JSON.stringify(healthData));

    // Test 2: Endpoint /item/{id} responde (aunque MeLi devuelva 403)
    console.log("\n⏳ Test 2: Item endpoint (proxy a MeLi)...");
    const itemController = new AbortController();
    const itemTimeout = setTimeout(() => itemController.abort(), 15000);

    const itemResponse = await fetch(`${WORKER_URL}/item/${TEST_ITEM_ID}`, {
      signal: itemController.signal,
    });

    clearTimeout(itemTimeout);

    // Aceptamos 403 de MeLi como respuesta válida (el Worker procesa bien el error)
    // Solo fallamos si el Worker no responde o devuelve algo inesperado
    if (!itemResponse.ok && itemResponse.status !== 403) {
      console.error(`❌ Item endpoint falló con status: ${itemResponse.status}`);
      process.exit(1);
    }

    const itemText = await itemResponse.text();
    let itemData;
    try {
      itemData = JSON.parse(itemText);
    } catch (e) {
      console.error("❌ Respuesta no es JSON válido");
      process.exit(1);
    }

    console.log(`✅ Item endpoint responde (status ${itemResponse.status})`);

    // Test 3: El Worker estructura bien las respuestas de error de MeLi
    console.log("\n⏳ Test 3: Estructura de respuesta del Worker...");
    if (itemData.error && itemData.status) {
      console.log("✅ Worker maneja errores de MeLi correctamente");
      console.log(`   Error: ${itemData.error}, Status: ${itemData.status}`);
    } else if (itemData.id) {
      console.log("✅ Worker devuelve datos de MeLi correctamente");
      console.log(`   Item ID: ${itemData.id}, Title: ${itemData.title?.substring(0, 50)}...`);
    } else {
      console.error("❌ Estructura de respuesta inesperada");
      console.error(JSON.stringify(itemData, null, 2).substring(0, 300));
      process.exit(1);
    }

    console.log("\n✅ Health check OK - Worker funcionando correctamente");

    process.exit(0);

  } catch (error) {
    if (error.name === "AbortError") {
      console.error("❌ Timeout: el Worker no respondió en 15s");
    } else {
      console.error("❌ Error en health check:", error.message);
    }
    process.exit(1);
  }
}

healthCheck();
