/**
 * MeLi Calculadora - Popup Script
 * Handles settings management and history display
 */

(function() {
  'use strict';

  // ═══ STORAGE KEYS ═══
  const SYNC_KEYS = {
    PROVINCIA: 'provincia',
    TIPO_PUB: 'tipoPub',
    COMISION_CUSTOM: 'comisionCustom'
  };

  const LOCAL_KEYS = {
    HISTORIAL: 'historial',
    AVISO_PENDIENTE: 'aviso_pendiente'
  };

  // ═══ DOM ELEMENTS ═══
  let provinciaSelect;
  let tipoPubSelect;
  let comisionCustomInput;
  let historialContainer;
  let clearHistorialBtn;
  let saveStatus;
  let avisoSection;
  let avisoContent;

  // ═══ DEBOUNCE TIMER ═══
  let debounceTimer = null;
  const DEBOUNCE_DELAY = 500;

  /**
   * Initialize popup
   */
  async function init() {
    // Get DOM elements
    provinciaSelect = document.getElementById('provincia');
    tipoPubSelect = document.getElementById('tipo-pub');
    comisionCustomInput = document.getElementById('comision-custom');
    historialContainer = document.getElementById('historial-container');
    clearHistorialBtn = document.getElementById('clear-historial');
    saveStatus = document.getElementById('save-status');
    avisoSection = document.getElementById('aviso-section');
    avisoContent = document.getElementById('aviso-content');

    // Load settings from chrome.storage.sync
    await loadSettings();

    // Load and display history
    await loadHistorial();

    // Check for pending avisos
    await checkAviso();

    // Attach event listeners
    attachEventListeners();
  }

  /**
   * Load settings from chrome.storage.sync
   */
  async function loadSettings() {
    try {
      const result = await chrome.storage.sync.get([
        SYNC_KEYS.PROVINCIA,
        SYNC_KEYS.TIPO_PUB,
        SYNC_KEYS.COMISION_CUSTOM
      ]);

      // Set values in UI
      if (result[SYNC_KEYS.PROVINCIA]) {
        provinciaSelect.value = result[SYNC_KEYS.PROVINCIA];
      }

      if (result[SYNC_KEYS.TIPO_PUB]) {
        tipoPubSelect.value = result[SYNC_KEYS.TIPO_PUB];
      }

      if (result[SYNC_KEYS.COMISION_CUSTOM] !== undefined) {
        comisionCustomInput.value = result[SYNC_KEYS.COMISION_CUSTOM];
      }
    } catch (error) {
      console.log('[MeLi Calc Popup] Error loading settings:', error);
    }
  }

  /**
   * Save a setting with debounce
   */
  function saveSetting(key, value) {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(async () => {
      try {
        await chrome.storage.sync.set({ [key]: value });
        showSaveStatus();
      } catch (error) {
        console.log('[MeLi Calc Popup] Error saving setting:', error);
      }
    }, DEBOUNCE_DELAY);
  }

  /**
   * Show save status indicator
   */
  function showSaveStatus() {
    saveStatus.textContent = '✓ Guardado';
    saveStatus.classList.add('visible');

    setTimeout(() => {
      saveStatus.classList.remove('visible');
    }, 1500);
  }

  /**
   * Load and display history from chrome.storage.local
   */
  async function loadHistorial() {
    try {
      const result = await chrome.storage.local.get([LOCAL_KEYS.HISTORIAL]);
      const historial = result[LOCAL_KEYS.HISTORIAL] || [];

      if (historial.length === 0) {
        historialContainer.innerHTML = '<p class="meli-empty-state">Sin cálculos recientes</p>';
        return;
      }

      // Render history items
      historialContainer.innerHTML = historial.map(item => {
        const fecha = new Date(item.fecha);
        const fechaStr = formatDate(fecha);
        const profitClass = item.gananciaNeta >= 0 ? 'meli-historial-profit' : 'meli-historial-loss';
        const profitSign = item.gananciaNeta >= 0 ? '+' : '';

        return `
          <div class="meli-historial-item">
            <div class="meli-historial-title" title="${escapeHtml(item.titulo)}">${escapeHtml(item.titulo)}</div>
            <div class="meli-historial-details">
              <span class="meli-historial-price">${formatCurrency(item.precio)}</span>
              <span class="${profitClass}">${profitSign}${formatCurrency(item.gananciaNeta)}</span>
            </div>
            <div class="meli-historial-meta">
              <span class="meli-historial-margin">${item.margenPct.toFixed(1)}%</span>
              <span class="meli-historial-date">${fechaStr}</span>
            </div>
          </div>
        `;
      }).join('');
    } catch (error) {
      console.log('[MeLi Calc Popup] Error loading history:', error);
    }
  }

  /**
   * Clear history
   */
  async function clearHistorial() {
    try {
      await chrome.storage.local.remove(LOCAL_KEYS.HISTORIAL);
      historialContainer.innerHTML = '<p class="meli-empty-state">Sin cálculos recientes</p>';
    } catch (error) {
      console.log('[MeLi Calc Popup] Error clearing history:', error);
    }
  }

  /**
   * Check for pending avisos
   */
  async function checkAviso() {
    try {
      const result = await chrome.storage.local.get([LOCAL_KEYS.AVISO_PENDIENTE]);
      const aviso = result[LOCAL_KEYS.AVISO_PENDIENTE];

      if (aviso) {
        avisoSection.style.display = 'block';
        avisoContent.innerHTML = `
          <div class="meli-aviso-icon">📢</div>
          <div class="meli-aviso-text">${escapeHtml(aviso)}</div>
        `;
      }
    } catch (error) {
      console.log('[MeLi Calc Popup] Error checking aviso:', error);
    }
  }

  /**
   * Attach event listeners to form elements
   */
  function attachEventListeners() {
    // Provincia change
    provinciaSelect.addEventListener('change', () => {
      saveSetting(SYNC_KEYS.PROVINCIA, provinciaSelect.value);
    });

    // Tipo de publicación change
    tipoPubSelect.addEventListener('change', () => {
      saveSetting(SYNC_KEYS.TIPO_PUB, tipoPubSelect.value);
    });

    // Comisión personalizada change
    comisionCustomInput.addEventListener('input', () => {
      const value = comisionCustomInput.value;
      // Save empty string as empty, or parse as float
      const numValue = value === '' ? null : parseFloat(value);
      saveSetting(SYNC_KEYS.COMISION_CUSTOM, numValue);
    });

    // Clear history button
    clearHistorialBtn.addEventListener('click', () => {
      if (confirm('¿Querés borrar todo el historial?')) {
        clearHistorial();
      }
    });
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
   * Format date to short format
   */
  function formatDate(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'ahora';
    if (diffMins < 60) return `hace ${diffMins}m`;
    if (diffHours < 24) return `hace ${diffHours}h`;
    if (diffDays < 7) return `hace ${diffDays}d`;
    
    return date.toLocaleDateString('es-AR', {
      day: 'numeric',
      month: 'short'
    });
  }

  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Initialize when DOM is ready
  document.addEventListener('DOMContentLoaded', init);

})();
