/**
 * MeLi Calculadora - Background Service Worker
 * Intercepts MeLi session token from API requests
 */

const TOKEN_TTL = 6 * 60 * 60 * 1000; // 6 hours
const TOKEN_EXPIRY_MARGIN = 5.5 * 60 * 60 * 1000; // 5.5 hours

// Listen for API requests to capture token
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
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
      
      console.log('[MeLi Calc BG] Token captured, length:', token.length);
    }
  },
  { urls: ['https://api.mercadolibre.com/*'] },
  ['requestHeaders']
);

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_TOKEN') {
    chrome.storage.session.get(['meli_token', 'meli_token_ts'], (result) => {
      const now = Date.now();
      const token = result.meli_token || null;
      const ts = result.meli_token_ts || 0;
      
      // Check if token exists and is not expired (with 30min margin)
      const isExpired = !token || (now - ts > TOKEN_EXPIRY_MARGIN);
      
      sendResponse({ token, isExpired });
    });
    
    return true; // Keep channel open for async response
  }
  
  if (message.type === 'CLEAR_TOKEN') {
    chrome.storage.session.remove(['meli_token', 'meli_token_ts']);
    sendResponse({ success: true });
    return true;
  }
});

console.log('[MeLi Calc BG] Service worker initialized');
