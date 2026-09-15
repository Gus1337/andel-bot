// ==UserScript==
// @name         Andelsbolig Group Watcher (pilot)
// @namespace    andelsbolig-bot
// @version      0.7
// @description  Pilot: extract new posts from one Facebook group feed, log to console only (no backend yet)
// @match        https://www.facebook.com/groups/*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  // Pilot phase: conservative interval. Tighten later once we've validated
  // the extraction and seen how the account holds up.
  const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 2 minutes
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

  function extractPostText(article, debug) {
    // Skip loading placeholders — article not yet rendered
    if (article.querySelector('[data-visualcompletion="loading-state"]')) return '';

    const selectors = [
      '[data-ad-comet-preview="message"]',
      '[data-testid="post_message"]',
      '[data-ad-preview="message"]',
    ];
    for (const sel of selectors) {
      const el = article.querySelector(sel);
      if (el && el.innerText.trim()) {
        if (debug) console.log('[andelsbolig-bot] text via selector:', sel);
        return el.innerText.trim();
      }
    }

    // Fallback: div[dir="auto"] elements that are NOT inside a nested article
    // (comments use nested role="article"). We walk up from each candidate to
    // the top-level article; if we pass through another role="article" node it's
    // inside a comment and gets excluded.
    const nestedArticles = new Set(article.querySelectorAll('div[role="article"]'));
    const dirAutos = Array.from(article.querySelectorAll('div[dir="auto"]')).filter(el => {
      let node = el.parentElement;
      while (node && node !== article) {
        if (nestedArticles.has(node)) return false;
        node = node.parentElement;
      }
      return true;
    });

    // DEBUG v0.7: log every candidate so we can see what's competing
    if (debug) {
      dirAutos.forEach((el, i) => {
        const roles = [];
        let node = el.parentElement;
        while (node && node !== article) {
          const r = node.getAttribute('role');
          const al = node.getAttribute('aria-label');
          if (r) roles.push(`role=${r}`);
          if (al) roles.push(`aria-label="${al.slice(0,30)}"`);
          node = node.parentElement;
        }
        console.log(`[andelsbolig-bot] dir=auto[${i}] depth=${roles.length} text="${el.innerText.trim().slice(0,80)}" parents=[${roles.slice(0,5).join(', ')}]`);
      });
    }

    // Pick the FIRST in DOM order with meaningful length — post body always
    // appears above comments in the article, so first beats longest.
    const best = dirAutos
      .map(el => ({ el, text: el.innerText.trim() }))
      .find(({ text }) => text.length > 10);

    if (best) {
      if (debug) console.log('[andelsbolig-bot] text via dir=auto fallback');
      return best.text;
    }

    console.warn('[andelsbolig-bot] extractPostText: no text found. Article HTML sample:',
      article.innerHTML.slice(0, 800));
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
        if (article.querySelector('[data-visualcompletion="loading-state"]')) return;
        const permalink = extractPermalink(article);
        const text = extractPostText(article, true);
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
