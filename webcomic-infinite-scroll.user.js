// ==UserScript==
// @name         WebComic Infinite Scroll
// @namespace    local.webcomic.infinite
// @version      3.1
// @description  Scroll infinito no leitor single-page e cache de N páginas à frente
// @match        https://e-example.com/s/*
// @match        http*://exexample.com/s/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const BUFFER_AHEAD = 10;            // quantas páginas manter carregadas à frente da atual
  const SIMPLE_RETRIES = 2;
  const SIMPLE_RETRY_DELAY = 1500;
  const REAL_RETRIES = 3;
  const REAL_RETRY_DELAY = 2000;
  const IFRAME_TIMEOUT = 15000;
  const SCROLL_PIN_TIMEOUT = 8000;    // por quanto tempo bloqueamos restauração de scroll do browser

  let fillingBuffer = false;
  let noMoreNext = false;
  let currentIndex = 0;
  let lastKnownPageUrl = location.href;

  const pages = []; // { wrapper, nextUrl, pageUrl }

  const NEXT_LINK_XPATH = "//table[@class='ptt']//a[string()='>'] | id('next') | id('unext')";
  const REMOVE_SELECTOR = '.ptt,.ptb,.sn,.searchnav';

  /*
   * Impede o salto de scroll depois de um "unload tab" do Firefox.
   *
   * O browser guarda o offset de scroll da entrada de histórico e tenta
   * restaurá-lo quando a aba é recarregada. Como este script reconstrói a
   * página e vai aumentando a altura do documento conforme carrega as páginas
   * seguintes, o browser reaplica aquele offset assim que o documento fica
   * alto o bastante — o que dá a impressão de que a tela "avança sozinha"
   * até onde a página estava antes do unload.
   *
   * Duas defesas:
   *  1) scrollRestoration = 'manual', para pedir ao browser que não restaure;
   *  2) um "pin" no topo durante os primeiros segundos, que desfaz qualquer
   *     scroll que não tenha vindo do usuário (o Firefox pode restaurar mesmo
   *     assim numa restauração de sessão, e tenta de novo a cada mudança de
   *     altura do documento).
   */
  function pinScrollToTop() {
    try {
      if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    } catch (e) {
      /* ignora */
    }

    let userScrolled = false;
    let done = false;

    const release = () => {
      if (done) return;
      done = true;
      userScrolled = true;
      window.removeEventListener('scroll', onScroll, true);
      intentEvents.forEach((type) => window.removeEventListener(type, onUserIntent, true));
    };

    const onUserIntent = () => release();

    const onScroll = () => {
      if (userScrolled) return;
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };

    const intentEvents = ['wheel', 'touchstart', 'keydown', 'pointerdown', 'mousedown'];
    intentEvents.forEach((type) => window.addEventListener(type, onUserIntent, true));
    window.addEventListener('scroll', onScroll, true);

    window.scrollTo(0, 0);
    setTimeout(release, SCROLL_PIN_TIMEOUT);

    return release;
  }

  function xpathFirst(doc, expr) {
    const result = doc.evaluate(expr, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue;
  }

  function getImgElement(doc) {
    const el = doc.getElementById('img');
    if (!el) return null;
    if (el.tagName === 'IMG') return el;
    return el.querySelector('img');
  }

  function stripNav(doc) {
    doc.querySelectorAll(REMOVE_SELECTOR).forEach((n) => n.remove());
  }

  function buildContainer() {
    const originalImgEl = document.getElementById('img');
    if (!originalImgEl) return null;

    const container = document.createElement('div');
    container.id = 'infinite-scroll-container';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.alignItems = 'center';

    stripNav(document);

    const anchorParent = originalImgEl.parentElement;
    anchorParent.insertBefore(container, originalImgEl);
    originalImgEl.remove();

    return container;
  }

  function makePageBlock(pageUrl, index) {
    const wrapper = document.createElement('div');
    wrapper.className = 'infinite-page';
    wrapper.dataset.pageUrl = pageUrl;
    wrapper.dataset.index = String(index);
    wrapper.style.width = '100%';
    wrapper.style.position = 'relative';
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.alignItems = 'center';
    wrapper.style.minHeight = '400px';

    const img = document.createElement('img');
    img.id = 'img';
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.minHeight = '400px';
    img.dataset.simpleRetries = '0';
    img.dataset.realRetries = '0';

    const statusBox = document.createElement('div');
    statusBox.className = 'infinite-status';
    statusBox.style.display = 'none';
    statusBox.style.flexDirection = 'column';
    statusBox.style.alignItems = 'center';
    statusBox.style.gap = '8px';
    statusBox.style.padding = '20px';
    statusBox.style.color = '#ccc';

    const statusText = document.createElement('div');
    statusText.textContent = 'Falha ao carregar esta imagem.';

    const retryBtn = document.createElement('button');
    retryBtn.textContent = '🔄 Recarregar imagem';
    retryBtn.style.cursor = 'pointer';
    retryBtn.style.padding = '8px 16px';
    retryBtn.style.fontSize = '14px';

    statusBox.appendChild(statusText);
    statusBox.appendChild(retryBtn);

    wrapper.appendChild(img);
    wrapper.appendChild(statusBox);

    return { wrapper, img, statusBox, statusText, retryBtn };
  }

  function forceRealReload(pageUrl) {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);

      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        iframe.remove();
        reject(new Error('timeout no iframe de recuperação: ' + pageUrl));
      }, IFRAME_TIMEOUT);

      iframe.addEventListener('load', () => {
        try {
          const idoc = iframe.contentDocument;
          const iframeImgEl = getImgElement(idoc);
          if (!iframeImgEl) throw new Error('iframe sem #img');

          const originalSrc = iframeImgEl.src;
          const loadfailLink = idoc.getElementById('loadfail');

          if (!loadfailLink) {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            iframe.remove();
            resolve(originalSrc);
            return;
          }

          const observer = new MutationObserver(() => {
            if (settled) return;
            if (iframeImgEl.src && iframeImgEl.src !== originalSrc) {
              settled = true;
              clearTimeout(timeoutId);
              observer.disconnect();
              const newSrc = iframeImgEl.src;
              iframe.remove();
              resolve(newSrc);
            }
          });
          observer.observe(iframeImgEl, { attributes: true, attributeFilter: ['src'] });

          if (typeof loadfailLink.onclick === 'function') {
            loadfailLink.onclick.call(loadfailLink, new MouseEvent('click'));
          } else {
            loadfailLink.click();
          }
        } catch (e) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          iframe.remove();
          reject(e);
        }
      });

      iframe.src = pageUrl;
    });
  }

  function showManualRetry(parts, pageUrl) {
    const { img, statusBox, statusText, retryBtn } = parts;
    img.style.display = 'none';
    statusBox.style.display = 'flex';
    statusText.textContent = 'Falha ao carregar esta imagem.';

    retryBtn.onclick = async () => {
      retryBtn.disabled = true;
      statusText.textContent = 'Tentando recarregar...';
      try {
        const newSrc = await forceRealReload(pageUrl);
        img.src = newSrc;
        img.style.display = '';
        statusBox.style.display = 'none';
      } catch (e) {
        console.warn('[infinite-scroll] retry manual falhou:', e);
        statusText.textContent = 'Ainda falhou. Tentar de novo?';
      } finally {
        retryBtn.disabled = false;
      }
    };
  }

  function attachRetryHandler(parts, pageUrl) {
    const { img } = parts;

    img.addEventListener('error', async function onError() {
      const simpleRetries = parseInt(img.dataset.simpleRetries || '0', 10);

      if (simpleRetries < SIMPLE_RETRIES) {
        img.dataset.simpleRetries = String(simpleRetries + 1);
        setTimeout(() => {
          const sep = img.src.includes('?') ? '&' : '?';
          img.src = img.src.split('&retry=')[0].split('?retry=')[0] + sep + 'retry=' + Date.now();
        }, SIMPLE_RETRY_DELAY);
        return;
      }

      const realRetries = parseInt(img.dataset.realRetries || '0', 10);
      if (realRetries < REAL_RETRIES) {
        img.dataset.realRetries = String(realRetries + 1);
        setTimeout(async () => {
          try {
            const newSrc = await forceRealReload(pageUrl);
            img.dataset.simpleRetries = '0';
            img.src = newSrc;
          } catch (e) {
            console.warn('[infinite-scroll] tentativa real automática falhou:', e);
            img.dispatchEvent(new Event('error'));
          }
        }, REAL_RETRY_DELAY);
        return;
      }

      showManualRetry(parts, pageUrl);
    });
  }

  async function fetchDoc(url) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ao buscar ' + url);
    const text = await resp.text();
    const parser = new DOMParser();
    return parser.parseFromString(text, 'text/html');
  }

  // Carrega UMA página e a adiciona ao array `pages` + DOM. Não decide loop.
  async function loadOnePage(url, container, urlObserver) {
    let doc;
    try {
      doc = await fetchDoc(url);
    } catch (e) {
      console.warn('[infinite-scroll] falha ao buscar página, tentando de novo em breve:', url, e);
      await new Promise((r) => setTimeout(r, 3000));
      return loadOnePage(url, container, urlObserver);
    }

    const imgSrcEl = getImgElement(doc);
    if (!imgSrcEl || !imgSrcEl.src) {
      console.warn('[infinite-scroll] não achei imagem na página', url);
      noMoreNext = true;
      return null;
    }

    const index = pages.length;
    const parts = makePageBlock(url, index);
    const { wrapper, img } = parts;
    attachRetryHandler(parts, url);
    img.src = imgSrcEl.src;

    container.appendChild(wrapper);
    urlObserver.observe(wrapper);

    const nextEl = xpathFirst(doc, NEXT_LINK_XPATH);
    const nextHref = nextEl && nextEl.href ? nextEl.href : null;

    const record = { wrapper, pageUrl: url, nextUrl: nextHref && nextHref !== url ? nextHref : null };
    pages.push(record);

    if (!record.nextUrl) {
      noMoreNext = true;
    }

    return record;
  }

  // Garante que existam BUFFER_AHEAD páginas carregadas depois da currentIndex
  async function fillBuffer(container, urlObserver) {
    if (fillingBuffer) return;
    fillingBuffer = true;
    try {
      while (!noMoreNext && (pages.length - currentIndex - 1) < BUFFER_AHEAD) {
        const last = pages[pages.length - 1];
        const nextUrl = last ? last.nextUrl : null;
        if (!nextUrl) {
          if (pages.length === 0) break; // ainda carregando a primeira página
          noMoreNext = true;
          break;
        }
        await loadOnePage(nextUrl, container, urlObserver);
      }
    } finally {
      fillingBuffer = false;
    }
  }

  function init() {
    const container = buildContainer();
    if (!container) return;

    const currentUrl = location.href;

    const urlObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const url = entry.target.dataset.pageUrl;
            const idx = parseInt(entry.target.dataset.index || '0', 10);
            currentIndex = idx;
            if (url && url !== lastKnownPageUrl) {
              lastKnownPageUrl = url;
              history.replaceState(null, '', url);
              // replaceState não deve reativar a restauração automática de scroll
              try {
                if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
              } catch (e) {
                /* ignora */
              }
            }
            // Ao mudar a página visível, garante que o buffer à frente continue cheio
            fillBuffer(container, urlObserver);
          }
        });
      },
      { threshold: 0.5 }
    );

    // Carrega a página atual e então preenche o buffer inicial
    loadOnePage(currentUrl, container, urlObserver).then(() => {
      lastKnownPageUrl = currentUrl;
      fillBuffer(container, urlObserver);
    });
  }

  // Precisa rodar o quanto antes (document-start), antes do browser tentar
  // restaurar o scroll da entrada de histórico.
  pinScrollToTop();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
