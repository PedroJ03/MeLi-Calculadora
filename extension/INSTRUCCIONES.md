# MeLi Calculadora - Instrucciones

## 📦 Instalación

### Chrome (Modo Desarrollador)

1. Abrir Chrome y navegar a `chrome://extensions/`
2. Activar **"Modo desarrollador"** (toggle arriba a la derecha)
3. Clic en **"Cargar descomprimida"**
4. Seleccionar la carpeta `meli-calc/`
5. ¡Listo! La extensión aparece en la barra de herramientas

### Firefox (about:debugging)

1. Abrir Firefox y navegar a `about:debugging#/runtime/this-firefox`
2. Clic en **"Este Firefox"** (sidebar)
3. Clic en **"Cargar complemento temporal..."**
4. Seleccionar cualquier archivo de la carpeta `meli-calc/` (ej: manifest.json)
5. La extensión se carga temporalmente (se pierde al reiniciar Firefox)

## 🌐 Publicar en Chrome Web Store

1. **Preparar extensión**:
   - Verificar manifest.json con permisos mínimos
   - Crear íconos definitivos (16, 48, 128 px)
   - Crear screenshots del popup y panel

2. **Crear ZIP**:
   ```bash
   cd meli-calc
   zip -r meli-calculadora.zip manifest.json content.js popup.html popup.js styles.css icons/
   ```

3. **Subir a Chrome Web Store**:
   - Ir a [Chrome Developer Dashboard](https://chrome.google.com/webstore/developer)
   - Iniciar sesión con cuenta Google
   - Clic en "Nuevo elemento"
   - Subir el ZIP
   - Completar: descripción, screenshots, categoría
   - Enviar para revisión

4. **APROBACIÓN** (~1-3 días):
   - Review automático de Google
   - Si hay problemas, recibir mail con cambios requeridos

## 🔄 Actualizar Tarifas

Las tarifas de MercadoLibre están en `content.js`:

### Opción 1: Editar FALLBACK_CONFIG

Buscar en content.js líneas ~13-52:
```javascript
const FALLBACK_CONFIG = {
  version: "2025-07",
  comisiones: { ... },
  costo_fijo: [ ... ],
  iibb: { ... }
};
```

Modificar los valores según publicación oficial de MeLi.

### Opción 2: Configuración Remota (recomendado)

1. Crear archivo `config.json` en un repositorio GitHub:
   ```json
   {
     "version": "2025-07",
     "comisiones": { ... },
     "costo_fijo": [ ... ],
     "iibb": { ... }
   }
   ```

2. Actualizar CONFIG_URL en content.js línea ~11:
   ```javascript
   const CONFIG_URL = 'https://raw.githubusercontent.com/TU_USUARIO/TU_REPO/main/config.json';
   ```

3. La extensión cachea la config por 24hrs. Para forzar update, limpar cache en extensión.

## 📋 Historial

El historial se guarda en `chrome.storage.local` key `historial` (máx 5 items).
Para ver/limpiar: Extensions → MeLi Calculadora → Service Worker → Console

## 🐛 Troubleshooting

- **Panel no aparece**: Verificar que sea página de producto (contiene /MLA- en URL)
- **Precio no se detecta**: precio puede cargar lazy. Aguardar 3 segundos
- **Config no carga**: Verificar conexión a GitHub raw URL