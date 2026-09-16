// ==UserScript==
// @name         Andelsbolig Debug Dump (temporary)
// @namespace    andelsbolig-bot
// @version      0.1
// @description  One-off diagnostic: waits, then POSTs all role="article" outerHTML to the local bridge for inspection. Safe to remove once extraction is confirmed working.
// @match        https://www.facebook.com/groups/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @updateURL    https://raw.githubusercontent.com/Gus1337/andel-bot/main/tampermonkey/debug-dump.user.js
// @downloadURL  https://raw.githubusercontent.com/Gus1337/andel-bot/main/tampermonkey/debug-dump.user.js
// ==/UserScript==

(function () {
  'use strict';

  window.addEventListener('load', () => {
    // Generous fixed wait -- this is a one-off diagnostic, not the real
    // scanner, so simplicity beats being clever here.
    setTimeout(() => {
      const articles = document.querySelectorAll('div[role="article"]');
      const report = {
        url: location.href,
        capturedAt: new Date().toISOString(),
        articleCount: articles.length,
        articles: Array.from(articles).map((a, i) => ({
          index: i,
          outerHTMLLength: a.outerHTML.length,
          outerHTML: a.outerHTML,
        })),
      };
      console.log('[andelsbolig-debug] posting dump, articleCount =', articles.length);
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'http://127.0.0.1:5000/debug',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(report),
        onload: (r) => console.log('[andelsbolig-debug] saved →', r.status, r.responseText),
        onerror: (e) => console.warn('[andelsbolig-debug] failed to save', e),
      });
    }, 40000);
  });
})();
