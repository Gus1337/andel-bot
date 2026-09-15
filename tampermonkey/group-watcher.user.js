// ==UserScript==
// @name         Andelsbolig Group Watcher (pilot)
// @namespace    andelsbolig-bot
// @version      0.3
// @description  Pilot: extract new posts from one Facebook group feed, log to console only (no backend yet)
// @match        https://www.facebook.com/groups/*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  // Pilot phase: conservative interval. Tighten later once we've validated
  // the extraction and seen how the account holds up.
  const REFRESH_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
  const MAX_SEEN = 500; // cap stored history so it doesn't grow forever

  function loadSeen() {
    try {
      return new Set(JSON.parse(GM_getValue('seen_keys', '[]')));
    } catch (e) {
      return new Set();
    }
  }

  function saveSeen(seenSet) {
    const arr = Array.from(seenSet).slice(-MAX_SEEN);
    GM_setValue('seen_keys', JSON.stringify(arr));
  }

  function expandSeeMore() {
    const buttons = document.querySelectorAll('div[role="button"]');
    buttons.forEach((btn) => {
      const text = (btn.innerText || '').trim().toLowerCase();
      if (text === 'se mere' || text === 'see more') {
        btn.click();
      }
    });
  }

  function extractPostText(article) {
    // Facebook Comet UI marks the post body with this attribute.
    // Using it avoids pulling in author name, timestamp, comments, and action buttons.
    const msgEl = article.querySelector('[data-ad-comet-preview="message"]');
    if (msgEl && msgEl.innerText.trim()) return msgEl.innerText.trim();
    // Fallback for older page variants
    const legacy = article.querySelector('[data-testid="post_message"]');
    if (legacy && legacy.innerText.trim()) return legacy.innerText.trim();
    return '';
  }

  function extractPermalink(article) {
    const links = article.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (href.includes('/posts/') || href.includes('permalink') || href.includes('multi_permalinks')) {
        const clean = href.split('?')[0];
        return clean.startsWith('http') ? clean : 'https://www.facebook.com' + clean;
      }
    }
    return null;
  }

  function scanFeed() {
    expandSeeMore();

    // Give expanded "see more" text a moment to render before reading it
    setTimeout(() => {
      const seen = loadSeen();
      const allArticles = document.querySelectorAll('div[role="article"]');
      // Comments carry the same role="article" attribute as top-level posts,
      // but live nested inside their parent post's subtree -- only keep
      // articles that are NOT nested inside another article.
      const articles = Array.from(allArticles).filter((el) => {
        return el.parentElement && !el.parentElement.closest('div[role="article"]');
      });
      let newCount = 0;

      articles.forEach((article) => {
        const permalink = extractPermalink(article);
        const text = extractPostText(article);
        if (!text && !permalink) return;

        const key = permalink || text.slice(0, 300);
        if (seen.has(key)) return;
        seen.add(key);
        newCount++;

        console.log('[andelsbolig-bot] NEW POST', {
          group: location.href,
          permalink,
          textPreview: text.slice(0, 300),
        });
      });

      saveSeen(seen);
      console.log(`[andelsbolig-bot] scan complete: ${allArticles.length} total article-elements (${articles.length} top-level posts) on page, ${newCount} new`);
    }, 1500);
  }

  window.addEventListener('load', () => setTimeout(scanFeed, 3000));

  // Re-navigate on a chronological sort so newest posts surface first,
  // rather than a plain reload (which would keep Facebook's relevance sort).
  setInterval(() => {
    const base = location.href.split('?')[0];
    location.href = base + '?sorting_setting=CHRONOLOGICAL';
  }, REFRESH_INTERVAL_MS);
})();
