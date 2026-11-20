const DEFAULT_API_URL = 'https://api.sposlearning.cz';
const PROBE_PATH = '/pages';
const PROBE_TIMEOUT_MS = 8000;
const PERIODIC_CHECK_INTERVAL_MS = 30000;
const VISIBILITY_STALE_MS = 15000;
const RETRY_COUNTDOWN_SECONDS = 15;

// HTTP statuses that definitively indicate Cloudflare / gateway / tunnel outages
// (530 = Cloudflare Tunnel Error 1033)
const OUTAGE_HTTP_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

const nativeFetch = window.fetch.bind(window);

let initialized = false;
let apiBaseUrl = DEFAULT_API_URL;
let apiOrigin = new URL(DEFAULT_API_URL).origin;
let apiHost = new URL(DEFAULT_API_URL).host;

let isUnloading = false;
let isMaintenanceActive = false;
let initialApiActivitySeen = false;
let lastHealthyAt = 0;
let headSupported = true;
let pendingVerificationPromise = null;
let countdownIntervalId = null;
let periodicCheckIntervalId = null;
let originalTitle = null;

function isStandaloneMaintenancePage() {
    const path = window.location.pathname.replace(/\/+$/, '');
    return path === '/maintenance' || path === '/maintenance.html';
}

function getRequestUrl(input) {
    try {
        if (typeof input === 'string') return input;
        if (input instanceof URL) return input.href;
        if (input && typeof input.url === 'string') return input.url;
    } catch {
        // ignore
    }
    return '';
}

function isApiRequest(input) {
    const rawUrl = getRequestUrl(input);
    if (!rawUrl) return false;
    try {
        const parsed = new URL(rawUrl, window.location.href);
        return parsed.origin === apiOrigin;
    } catch {
        return false;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function detectErrorDetailFromResponse(response) {
    const status = response.status;
    let is1033 = status === 530;

    if (!is1033 && status >= 500) {
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('text/html') || contentType.includes('text/plain')) {
            try {
                const bodyText = await response.clone().text();
                if (/\b1033\b|cloudflare\s+tunnel|argo\s+tunnel/i.test(bodyText)) {
                    is1033 = true;
                }
            } catch {
                // ignore unreadable body
            }
        }
    }

    if (is1033) {
        return {
            status,
            code: '1033',
            label: `Chyba 1033 (HTTP ${status})`,
            pill: 'API nedostupné · Chyba 1033'
        };
    }

    return {
        status,
        code: String(status),
        label: `HTTP ${status}`,
        pill: `API nedostupné · HTTP ${status}`
    };
}

async function probeOnce(method) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
        const res = await nativeFetch(`${apiBaseUrl}${PROBE_PATH}`, {
            method,
            cache: 'no-store',
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (res.status < 500) {
            // Release body stream immediately for GET probes
            if (method === 'GET' && res.body && typeof res.body.cancel === 'function') {
                res.body.cancel().catch(() => {});
            }
            return { ok: true, status: res.status };
        }

        const detail = await detectErrorDetailFromResponse(res);
        return { ok: false, ...detail };
    } catch (err) {
        clearTimeout(timeoutId);
        const isTimeout = err && err.name === 'AbortError';
        return {
            ok: false,
            networkError: true,
            timeout: isTimeout,
            status: null,
            code: isTimeout ? 'TIMEOUT' : '1033',
            label: isTimeout
                ? 'Časový limit vypršel'
                : 'Nelze se připojit (pravděpodobně chyba 1033)',
            pill: isTimeout
                ? 'API neodpovídá · Timeout'
                : 'API nedostupné · Chyba připojení'
        };
    }
}

export async function checkApiHealth() {
    if (navigator.onLine === false) {
        return {
            ok: false,
            offline: true,
            label: 'Zařízení je offline',
            pill: 'Bez připojení k internetu'
        };
    }

    if (headSupported) {
        const headResult = await probeOnce('HEAD');
        if (headResult.ok) {
            lastHealthyAt = Date.now();
            return headResult;
        }
        // If HEAD returned a definitive Cloudflare 530 / outage HTTP status, no need for GET
        if (headResult.status && OUTAGE_HTTP_STATUSES.has(headResult.status)) {
            return headResult;
        }
        // HEAD may be blocked by CORS or unsupported; verify with GET
        const getResult = await probeOnce('GET');
        if (getResult.ok) {
            headSupported = false;
            lastHealthyAt = Date.now();
        }
        return getResult;
    }

    const getResult = await probeOnce('GET');
    if (getResult.ok) {
        lastHealthyAt = Date.now();
    }
    return getResult;
}

function ensureMaintenanceStyles() {
    if (document.getElementById('spos-maintenance-css')) return;
    const link = document.createElement('link');
    link.id = 'spos-maintenance-css';
    link.rel = 'stylesheet';
    link.href = '/maintenance.css';
    document.head.appendChild(link);
}

function getSafeReturnUrl() {
    const params = new URLSearchParams(window.location.search);
    const from = params.get('from');
    if (from && from.startsWith('/') && !from.startsWith('//')) {
        return from;
    }
    return null;
}

function createMaintenanceMarkup(detail) {
    const pillText = detail?.pill || 'API nedostupné · Chyba 1033';
    const statusLabel = detail?.label || 'Nelze se připojit (pravděpodobně chyba 1033)';

    return `
        <div class="spos-maint-center">
            <div class="spos-maint-brand">
                <img src="/media/logo.svg" alt="SPOŠLearning" class="spos-maint-logo" />
                <span class="spos-maint-brand-name">SPOŠLearning</span>
            </div>

            <section class="spos-maint-card card" id="spos-maint-card" data-state="offline" role="alert" aria-live="polite">
                <div class="spos-maint-icon-badge" id="spos-maint-icon-badge" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                    </svg>
                </div>

                <div class="spos-maint-status-pill">
                    <span class="spos-maint-dot"></span>
                    <span id="spos-maint-pill-text">${escapeHtml(pillText)}</span>
                </div>

                <h1 class="spos-maint-title" id="spos-maint-title">Probíhá údržba</h1>

                <p class="spos-maint-desc" id="spos-maint-desc">
                    SPOŠLearning právě prochází údržbou nebo je náš API server dočasně nedostupný.
                    Pracujeme na tom, aby vše co nejdříve zase fungovalo normálně.
                </p>

                <div class="spos-maint-details">
                    <div class="spos-maint-detail-row">
                        <span class="spos-maint-detail-label">Endpoint</span>
                        <span class="spos-maint-detail-value"><code class="spos-maint-code">${escapeHtml(apiHost)}</code></span>
                    </div>
                    <div class="spos-maint-detail-row">
                        <span class="spos-maint-detail-label">Stav</span>
                        <span class="spos-maint-detail-value" id="spos-maint-status-detail">${escapeHtml(statusLabel)}</span>
                    </div>
                    <div class="spos-maint-detail-row">
                        <span class="spos-maint-detail-label">Další kontrola</span>
                        <span class="spos-maint-detail-value" id="spos-maint-countdown">za ${RETRY_COUNTDOWN_SECONDS} s</span>
                    </div>
                </div>

                <div class="spos-maint-actions">
                    <button type="button" class="spos-maint-btn spos-maint-btn-primary btn-primary" id="spos-maint-retry-btn">
                        <svg id="spos-maint-retry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M21 12a9 9 0 1 1-2.64-6.36"/>
                            <polyline points="21 3 21 9 15 9"/>
                        </svg>
                        <span id="spos-maint-retry-label">Zkusit znovu</span>
                    </button>
                </div>
            </section>
        </div>

        <footer class="spos-maint-footer">
            <span>SPOŠLearning by</span>
            <a href="https://github.com/OpenBluee" target="_blank" rel="noopener noreferrer">
                <img src="/media/openblue.png" alt="OpenBlue" class="spos-maint-openblue-logo" />
                <span>OpenBlue</span>
            </a>
        </footer>
    `;
}

function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[m]));
}

function updateMaintenanceUI({ state, pill, title, desc, detail, countdownText, buttonLabel, isSpinning }) {
    const card = document.getElementById('spos-maint-card');
    if (card && state) card.setAttribute('data-state', state);

    const pillEl = document.getElementById('spos-maint-pill-text');
    if (pillEl && pill !== undefined) pillEl.textContent = pill;

    const titleEl = document.getElementById('spos-maint-title');
    if (titleEl && title !== undefined) titleEl.textContent = title;

    const descEl = document.getElementById('spos-maint-desc');
    if (descEl && desc !== undefined) descEl.textContent = desc;

    const detailEl = document.getElementById('spos-maint-status-detail');
    if (detailEl && detail !== undefined) detailEl.textContent = detail;

    const countdownEl = document.getElementById('spos-maint-countdown');
    if (countdownEl && countdownText !== undefined) countdownEl.textContent = countdownText;

    const retryBtn = document.getElementById('spos-maint-retry-btn');
    const retryIcon = document.getElementById('spos-maint-retry-icon');
    const retryLabel = document.getElementById('spos-maint-retry-label');

    if (retryBtn && isSpinning !== undefined) retryBtn.disabled = isSpinning;
    if (retryIcon && isSpinning !== undefined) retryIcon.classList.toggle('spos-maint-spin', isSpinning);
    if (retryLabel && buttonLabel !== undefined) retryLabel.textContent = buttonLabel;

    const iconBadge = document.getElementById('spos-maint-icon-badge');
    if (iconBadge && state === 'online') {
        iconBadge.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
        `;
    } else if (iconBadge && state === 'offline') {
        iconBadge.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
        `;
    }
}

function stopRetryCountdown() {
    if (countdownIntervalId) {
        clearInterval(countdownIntervalId);
        countdownIntervalId = null;
    }
}

function startRetryCountdown(onTrigger) {
    stopRetryCountdown();
    let remaining = RETRY_COUNTDOWN_SECONDS;

    updateMaintenanceUI({ countdownText: `za ${remaining} s` });

    countdownIntervalId = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
            stopRetryCountdown();
            onTrigger();
        } else {
            updateMaintenanceUI({ countdownText: `za ${remaining} s` });
        }
    }, 1000);
}

async function runMaintenanceRecheck(standalone = false) {
    stopRetryCountdown();
    updateMaintenanceUI({
        state: 'checking',
        pill: 'Ověřuji dostupnost API...',
        countdownText: 'Právě kontroluji...',
        buttonLabel: 'Kontroluji...',
        isSpinning: true
    });

    const result = await checkApiHealth();

    if (result.ok) {
        const returnUrl = getSafeReturnUrl();

        if (standalone && !returnUrl) {
            updateMaintenanceUI({
                state: 'online',
                pill: 'API server je online',
                title: 'Vše je zpět v provozu',
                desc: 'API server SPOŠLearningu je dostupný a platforma funguje normálně.',
                detail: `Online (HTTP ${result.status})`,
                countdownText: 'Služba je dostupná',
                buttonLabel: 'Přejít na SPOŠLearning',
                isSpinning: false
            });
            return;
        }

        updateMaintenanceUI({
            state: 'online',
            pill: 'API server je zpět online',
            title: 'Obnovuji stránku...',
            desc: 'Spojení s API serverem bylo obnoveno. Za okamžik tě vrátíme zpět na SPOŠLearning.',
            detail: `Online (HTTP ${result.status})`,
            countdownText: 'Přesměrovávám...',
            buttonLabel: 'Obnovuji...',
            isSpinning: true
        });

        setTimeout(() => {
            if (returnUrl) {
                window.location.replace(returnUrl);
            } else {
                window.location.reload();
            }
        }, 700);
        return;
    }

    updateMaintenanceUI({
        state: 'offline',
        pill: result.pill || 'API nedostupné · Chyba 1033',
        detail: result.label || 'Nelze se připojit (pravděpodobně chyba 1033)',
        buttonLabel: 'Zkusit znovu',
        isSpinning: false
    });

    startRetryCountdown(() => runMaintenanceRecheck(standalone));
}

export function showMaintenanceOverlay(detail = null) {
    if (isMaintenanceActive || isStandaloneMaintenancePage()) return;
    isMaintenanceActive = true;

    ensureMaintenanceStyles();

    const mount = () => {
        if (document.getElementById('spos-maintenance-overlay')) return;

        originalTitle = document.title;
        document.title = 'Probíhá údržba – SPOŠLearning';

        document.documentElement.classList.add('spos-maint-locked');
        document.body.classList.add('spos-maint-locked');

        const overlay = document.createElement('div');
        overlay.id = 'spos-maintenance-overlay';
        overlay.className = 'spos-maint-root';
        overlay.innerHTML = createMaintenanceMarkup(detail);

        document.body.appendChild(overlay);

        const retryBtn = document.getElementById('spos-maint-retry-btn');
        if (retryBtn) {
            retryBtn.addEventListener('click', () => runMaintenanceRecheck(false));
        }

        startRetryCountdown(() => runMaintenanceRecheck(false));
    };

    if (document.body) {
        mount();
    } else {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    }
}

export function hideMaintenanceOverlay() {
    stopRetryCountdown();
    isMaintenanceActive = false;

    const overlay = document.getElementById('spos-maintenance-overlay');
    if (overlay) overlay.remove();

    document.documentElement.classList.remove('spos-maint-locked');
    if (document.body) document.body.classList.remove('spos-maint-locked');

    if (originalTitle !== null) {
        document.title = originalTitle;
        originalTitle = null;
    }
}

async function confirmOutageAndShowMaintenance(initialDetail = null, delayMs = 0) {
    if (isMaintenanceActive || isUnloading || isStandaloneMaintenancePage()) return false;
    if (navigator.onLine === false) return false;

    if (pendingVerificationPromise) {
        return pendingVerificationPromise;
    }

    pendingVerificationPromise = (async () => {
        try {
            if (delayMs > 0) {
                await sleep(delayMs);
            }
            if (isUnloading || isMaintenanceActive || navigator.onLine === false) {
                return false;
            }

            const probeResult = await checkApiHealth();
            if (isUnloading || isMaintenanceActive) return false;

            if (!probeResult.ok && !probeResult.offline) {
                showMaintenanceOverlay(initialDetail?.code === '1033' ? initialDetail : probeResult);
                return true;
            }
            return false;
        } finally {
            pendingVerificationPromise = null;
        }
    })();

    return pendingVerificationPromise;
}

function patchGlobalFetch() {
    if (window.fetch.__sposMaintenancePatched) return;

    const wrappedFetch = async function (input, init) {
        if (!isApiRequest(input)) {
            return nativeFetch(input, init);
        }

        initialApiActivitySeen = true;

        try {
            const response = await nativeFetch(input, init);

            if (response.status < 500) {
                lastHealthyAt = Date.now();
                return response;
            }

            const detail = await detectErrorDetailFromResponse(response);

            if (OUTAGE_HTTP_STATUSES.has(response.status) || detail.code === '1033') {
                // Definitive Cloudflare / gateway outage (e.g. Error 1033 / HTTP 530)
                if (!isUnloading) {
                    showMaintenanceOverlay(detail);
                }
            } else {
                // Generic 500 on a specific route: verify whether the API itself is down
                confirmOutageAndShowMaintenance(detail, 0);
            }

            return response;
        } catch (err) {
            const callerAborted = Boolean(
                (init && init.signal && init.signal.aborted) ||
                (err && err.name === 'AbortError')
            );

            if (!callerAborted && !isUnloading && navigator.onLine !== false) {
                // Cloudflare 1033 (HTTP 530) omits CORS headers, causing browser fetch() to reject with TypeError.
                // Confirm quickly before surfacing the error so pages don't flash false 404/error messages.
                await confirmOutageAndShowMaintenance(null, 150);
            }

            throw err;
        }
    };

    wrappedFetch.__sposMaintenancePatched = true;
    window.fetch = wrappedFetch;
}

function initStandaloneMaintenancePage() {
    const start = () => {
        const retryBtn = document.getElementById('spos-maint-retry-btn');
        if (retryBtn) {
            retryBtn.addEventListener('click', () => {
                const card = document.getElementById('spos-maint-card');
                if (card && card.getAttribute('data-state') === 'online') {
                    window.location.href = getSafeReturnUrl() || '/';
                    return;
                }
                runMaintenanceRecheck(true);
            });
        }
        runMaintenanceRecheck(true);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
}

export function initMaintenanceMonitor(apiUrl = DEFAULT_API_URL) {
    if (initialized) return;
    initialized = true;

    try {
        const parsed = new URL(apiUrl);
        apiBaseUrl = apiUrl.replace(/\/+$/, '');
        apiOrigin = parsed.origin;
        apiHost = parsed.host;
    } catch {
        apiBaseUrl = DEFAULT_API_URL;
        apiOrigin = new URL(DEFAULT_API_URL).origin;
        apiHost = new URL(DEFAULT_API_URL).host;
    }

    window.addEventListener('beforeunload', () => {
        isUnloading = true;
    });
    window.addEventListener('pagehide', () => {
        isUnloading = true;
    });
    window.addEventListener('pageshow', () => {
        isUnloading = false;
    });

    if (isStandaloneMaintenancePage()) {
        initStandaloneMaintenancePage();
        return;
    }

    patchGlobalFetch();

    // Ensure pages that don't make an immediate API call on load (e.g. login, signup, send-feedback)
    // still check API availability right away.
    setTimeout(() => {
        if (!initialApiActivitySeen && !isMaintenanceActive && !isUnloading) {
            confirmOutageAndShowMaintenance(null, 0);
        }
    }, 150);

    // Periodic background check while tab is visible ("kdykoliv")
    periodicCheckIntervalId = setInterval(() => {
        if (
            document.visibilityState === 'visible' &&
            !isMaintenanceActive &&
            !isUnloading &&
            navigator.onLine !== false &&
            Date.now() - lastHealthyAt >= PERIODIC_CHECK_INTERVAL_MS - 5000
        ) {
            confirmOutageAndShowMaintenance(null, 0);
        }
    }, PERIODIC_CHECK_INTERVAL_MS);

    // Re-check when returning to the tab after being away
    document.addEventListener('visibilitychange', () => {
        if (
            document.visibilityState === 'visible' &&
            !isMaintenanceActive &&
            !isUnloading &&
            navigator.onLine !== false &&
            Date.now() - lastHealthyAt >= VISIBILITY_STALE_MS
        ) {
            confirmOutageAndShowMaintenance(null, 0);
        }
    });

    // Re-check immediately when browser regains network connectivity
    window.addEventListener('online', () => {
        if (isMaintenanceActive) {
            runMaintenanceRecheck(false);
        } else if (!isUnloading) {
            confirmOutageAndShowMaintenance(null, 0);
        }
    });

    // Expose lightweight debug helpers for local testing in DevTools
    window.__sposMaintenance = {
        show: (code = '1033') => showMaintenanceOverlay({
            code: String(code),
            label: code === '1033' ? 'Chyba 1033 (HTTP 530)' : `HTTP ${code}`,
            pill: `API nedostupné · Chyba ${code}`
        }),
        hide: hideMaintenanceOverlay,
        check: checkApiHealth
    };
}
