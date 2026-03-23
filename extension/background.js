/**
 * MeLi Calculadora - Background Service Worker
 * Intercepts MeLi session token from API requests
 */

const TOKEN_TTL = 6 * 60 * 60 * 1000; // 6 hours
const TOKEN_EXPIRY_MARGIN = 5.5 * 60 * 60 * 1000; // 5.5 hours

console.log('[MeLi Calc BG] Service worker started at:', Date.now());

// API URLs to intercept for token capture
const TOKEN_CAPTURE_URLS = [
  'https://api.mercadolibre.com/*',
  'https://internal-api.mercadolibre.com/*',
  'https://*.mercadolibre.com/*/api/*'
];

// Listen for API requests to capture token
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    console.log('[MeLi Calc BG] Request intercepted:', details.url.substring(0, 100));
    
    const authHeader = details.requestHeaders?.find(
      h => h.name.toLowerCase() === 'authorization'
    );
    
    if (authHeader?.value?.startsWith('Bearer ')) {
      const token = authHeader.value.replace('Bearer ', '');
      
      // Save token with timestamp
      chrome.storage.session.set({
        meli_token: token,
        meli_token_ts: Date.now()
      });
      
      console.log('[MeLi Calc BG] Token captured! Length:', token.length, 'URL:', details.url.substring(0, 80));
    } else {
      console.log('[MeLi Calc BG] No Bearer token in headers for:', details.url.substring(0, 80));
    }
  },
  { urls: TOKEN_CAPTURE_URLS },
  ['requestHeaders']
);

// Also listen for headers received (response) to capture tokens from response
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // Check for token in response headers (sometimes returned there)
    const responseHeaders = details.responseHeaders || [];
    for (const header of responseHeaders) {
      if (header.name.toLowerCase() === 'x-authorization' || 
          header.name.toLowerCase() === 'authorization') {
        if (header.value?.startsWith('Bearer ')) {
          const token = header.value.replace('Bearer ', '');
          chrome.storage.session.set({
            meli_token: token,
            meli_token_ts: Date.now()
          });
          console.log('[MeLi Calc BG] Token captured from response headers, length:', token.length);
        }
      }
    }
  },
  { urls: TOKEN_CAPTURE_URLS },
  ['responseHeaders']
);

// Log when service worker wakes up
chrome.runtime.onInstalled.addListener(() => {
  console.log('[MeLi Calc BG] Extension installed/updated');
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[MeLi Calc BG] Service worker starting up');
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[MeLi Calc BG] Message received:', message.type);
  
  if (message.type === 'GET_TOKEN') {
    chrome.storage.session.get(['meli_token', 'meli_token_ts'], (result) => {
      const now = Date.now();
      const token = result.meli_token || null;
      const ts = result.meli_token_ts || 0;
      
      // Check if token exists and is not expired (with 30min margin)
      const isExpired = !token || (now - ts > TOKEN_EXPIRY_MARGIN);
      
      console.log('[MeLi Calc BG] Token request - exists:', !!token, 'expired:', isExpired, 'age:', Math.round((now - ts) / 1000 / 60), 'mins');
      
      sendResponse({ token, isExpired });
    });
    
    return true; // Keep channel open for async response
  }
  
  if (message.type === 'CLEAR_TOKEN') {
    chrome.storage.session.remove(['meli_token', 'meli_token_ts']);
    console.log('[MeLi Calc BG] Token cleared');
    sendResponse({ success: true });
    return true;
  }
  
  if (message.type === 'LOG') {
    console.log('[MeLi Calc BG] Content script log:', message.message);
    sendResponse({ received: true });
    return true;
  }
});

console.log('[MeLi Calc BG] Service worker initialized, listening on URLs:', TOKEN_CAPTURE_URLS);
