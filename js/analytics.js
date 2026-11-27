/**
 * 온고원 ONGOWON — Shared Analytics Loader & Privacy-Safe First-Party Tracker
 *
 * - Automatically loads GA4 (G-...) & Microsoft Clarity when configured via
 *   window.ONGOWON_ANALYTICS_CONFIG (/js/analytics-config.js) or Vercel env vars.
 * - Sends cookieless, privacy-safe pageviews & conversion funnel events to /api/analytics/.
 * - Core conversion events:
 *     page_view, minhwa_generate, mockup_download, notify_signup, language_switch
 */
(function () {
  if (typeof window === 'undefined' || window.__ongowonAnalyticsLoaded) return;
  window.__ongowonAnalyticsLoaded = true;

  var cfg = Object.assign(
    { ga4Id: '', clarityId: '', endpoint: '/api/analytics/', debug: false },
    window.ONGOWON_ANALYTICS_CONFIG || {}
  );

  var pathname = String(location.pathname || '/');
  // Never track admin dashboard views or pollute metrics
  if (pathname.indexOf('/admin/') === 0 || pathname === '/admin') {
    window.ongowonTrack = function () {};
    return;
  }

  var state = {
    ga4Ready: false,
    clarityReady: false,
    ga4Queue: [],
  };

  function getLocale() {
    var htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
    if (htmlLang.indexOf('en') === 0) return 'en';
    if (htmlLang.indexOf('ja') === 0) return 'ja';
    if (pathname.indexOf('/en/') === 0) return 'en';
    if (pathname.indexOf('/ja/') === 0) return 'ja';
    return 'ko';
  }

  function getDevice() {
    var w = window.innerWidth || screen.width || 1280;
    if (w < 640) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  }

  function getSessionId() {
    try {
      var sid = sessionStorage.getItem('ogw_sid');
      if (sid && /^[a-z0-9]{8,16}$/i.test(sid)) return sid;
      var bytes = new Uint8Array(6);
      if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
      } else {
        for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      }
      sid = Array.prototype.map
        .call(bytes, function (b) {
          return b.toString(16).padStart(2, '0');
        })
        .join('')
        .slice(0, 10);
      sessionStorage.setItem('ogw_sid', sid);
      return sid;
    } catch (e) {
      return 'anon0001';
    }
  }

  function cleanReferrer(ref) {
    if (!ref) return '';
    try {
      var u = new URL(ref);
      // Ignore internal navigation between ongowon.com pages for external attribution
      if (/^(www\.)?ongowon\.com$/i.test(u.hostname) || u.hostname === location.hostname) {
        return '';
      }
      return u.origin + u.pathname.slice(0, 80);
    } catch (e) {
      return '';
    }
  }

  function getAttribution() {
    var params = new URLSearchParams(location.search || '');
    var fresh = {
      referrer: cleanReferrer(document.referrer || ''),
      utm_source: (params.get('utm_source') || '').trim().slice(0, 60),
      utm_medium: (params.get('utm_medium') || '').trim().slice(0, 60),
      utm_campaign: (params.get('utm_campaign') || '').trim().slice(0, 80),
      utm_content: (params.get('utm_content') || '').trim().slice(0, 80),
      utm_term: (params.get('utm_term') || '').trim().slice(0, 80),
    };

    var stored = null;
    try {
      var raw = sessionStorage.getItem('ogw_attr');
      if (raw) stored = JSON.parse(raw);
    } catch (e) {
      stored = null;
    }

    var hasFreshSignal = Boolean(fresh.utm_source || fresh.utm_campaign || fresh.referrer);
    var attr = hasFreshSignal ? fresh : stored || fresh;

    if (hasFreshSignal || !stored) {
      try {
        sessionStorage.setItem('ogw_attr', JSON.stringify(attr));
      } catch (e) {}
    }
    return attr;
  }

  function initGA4(id) {
    if (!id || state.ga4Ready) return;
    id = String(id).trim();
    if (!/^G-[A-Z0-9]{4,20}$/i.test(id)) return;
    state.ga4Ready = true;

    window.dataLayer = window.dataLayer || [];
    window.gtag =
      window.gtag ||
      function () {
        window.dataLayer.push(arguments);
      };
    window.gtag('js', new Date());
    window.gtag('config', id, {
      anonymize_ip: true,
      page_path: pathname,
      page_language: getLocale(),
    });

    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.appendChild(s);

    while (state.ga4Queue.length) {
      var item = state.ga4Queue.shift();
      try {
        window.gtag('event', item.name, item.props);
      } catch (e) {}
    }
  }

  function initClarity(id) {
    if (!id || state.clarityReady) return;
    id = String(id).trim();
    if (!/^[a-z0-9_-]{4,32}$/i.test(id)) return;
    state.clarityReady = true;

    (function (c, l, a, r, i, t, y) {
      c[a] =
        c[a] ||
        function () {
          (c[a].q = c[a].q || []).push(arguments);
        };
      t = l.createElement(r);
      t.async = 1;
      t.src = 'https://www.clarity.ms/tag/' + encodeURIComponent(i);
      y = l.getElementsByTagName(r)[0];
      if (y && y.parentNode) y.parentNode.insertBefore(t, y);
      else l.head.appendChild(t);
    })(window, document, 'clarity', 'script', id);
  }

  // Boot GA4 / Clarity immediately if present in static config
  if (cfg.ga4Id) initGA4(cfg.ga4Id);
  if (cfg.clarityId) initClarity(cfg.clarityId);

  var sid = getSessionId();
  var attr = getAttribution();

  function sendFirstParty(payload, preferFetch) {
    var body = JSON.stringify(payload);
    if (!preferFetch && navigator.sendBeacon) {
      try {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(cfg.endpoint, blob)) return;
      } catch (e) {}
    }
    try {
      fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        credentials: 'omit',
      })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (res) {
          if (res && res.config) {
            if (res.config.ga4Id) initGA4(res.config.ga4Id);
            if (res.config.clarityId) initClarity(res.config.clarityId);
          }
        })
        .catch(function () {});
    } catch (e) {}
  }

  function track(eventName, props) {
    if (!eventName || typeof eventName !== 'string') return;
    var cleanProps = props && typeof props === 'object' ? props : {};
    var locale = cleanProps.locale || getLocale();

    // Forward to GA4 (except duplicate page_view when GA4 handles it on config)
    if (eventName !== 'page_view') {
      if (state.ga4Ready && typeof window.gtag === 'function') {
        try {
          window.gtag('event', eventName, Object.assign({ page_path: pathname, locale: locale }, cleanProps));
        } catch (e) {}
      } else if (state.ga4Queue.length < 20) {
        state.ga4Queue.push({ name: eventName, props: cleanProps });
      }
      if (state.clarityReady && typeof window.clarity === 'function') {
        try {
          window.clarity('event', eventName);
        } catch (e) {}
      }
    }

    var payload = {
      event: eventName,
      path: pathname,
      locale: locale,
      sid: sid,
      device: getDevice(),
      referrer: attr.referrer || '',
      utm_source: attr.utm_source || '',
      utm_medium: attr.utm_medium || '',
      utm_campaign: attr.utm_campaign || '',
      utm_content: attr.utm_content || '',
      meta: cleanProps,
    };

    if (cfg.debug && window.console) {
      console.log('[ongowon-analytics]', payload);
    }

    sendFirstParty(payload, eventName === 'page_view');
  }

  window.ongowonTrack = track;

  // Auto-bind common conversion hooks across all Ongowon pages
  function bindAutoHooks() {
    // 1. Language switchers ([data-lang])
    document.querySelectorAll('[data-lang]').forEach(function (el) {
      if (el.dataset.ogwBound) return;
      el.dataset.ogwBound = '1';
      el.addEventListener('click', function () {
        var toLang = (el.getAttribute('data-lang') || '').toLowerCase();
        var fromLang = getLocale();
        if (toLang && toLang !== fromLang) {
          track('language_switch', {
            from_lang: fromLang,
            to_lang: toLang,
            target: el.getAttribute('href') || pathname,
          });
        }
      });
    });

    // 2. Korean homepage Google Form notify CTA (#nlm-go)
    var nlmGo = document.getElementById('nlm-go');
    if (nlmGo && !nlmGo.dataset.ogwBound) {
      nlmGo.dataset.ogwBound = '1';
      nlmGo.addEventListener('click', function () {
        track('notify_signup', { channel: 'survey', source: 'home_ko' });
      });
    }

    // 3. EN/JA homepage newsletter signup form (#nl)
    var nlForm = document.getElementById('nl');
    if (nlForm && !nlForm.dataset.ogwBound) {
      nlForm.dataset.ogwBound = '1';
      nlForm.addEventListener('submit', function () {
        track('notify_signup', { channel: 'email_form', source: 'home_' + getLocale() });
      });
    }
  }

  function onReady() {
    bindAutoHooks();
    // Initial page_view (uses fetch so server-side GA4/Clarity env config is returned)
    track('page_view', { title: (document.title || '').slice(0, 80) });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
