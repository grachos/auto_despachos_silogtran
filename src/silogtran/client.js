// HTTP client for Silogtran (PRADO/PHP, server-rendered; no JSON API).
// Ported from grachos/apis_legalizacion_silogtran: login postback (+ cost center panel) and AWS WAF
// challenge solved with a headless browser. Requests are serialized because PRADO keeps state per session.
// The cookie jar can be exported/imported so a serverless invocation can reuse a stored session.
import * as cheerio from 'cheerio';
import { launchBrowser } from './browser.js';

export const LOGIN_PAGE = 'index.php?page=LoginPage';
const HOME_CHECK_PAGE = 'index.php';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

export class SilogtranError extends Error {
  // code: fixed machine code surfaced by the API (see src/http/errors.js).
  constructor(msg, { sessionExpired = false, status = 502, code = 'SILOGTRAN_ERROR' } = {}) {
    super(msg);
    this.name = 'SilogtranError';
    this.code = code;
    this.sessionExpired = sessionExpired;
    this.status = status;
  }
}

export const isLoginPage = (html) => html.includes('ctl0$MainModule$BtnIngresar');

export function decode(buf, contentType = '') {
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  if (charset) {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      /* fall through */
    }
  }
  const utf8 = new TextDecoder('utf-8').decode(buf);
  // Silogtran often serves latin1 without declaring it.
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
}

// Fields a browser would send on a PRADO postback (buttons excluded).
export function formFields(html) {
  const $ = cheerio.load(html);
  const form = $('form').first();
  if (!form.length) throw new SilogtranError('Form not found on page.');
  const data = {};
  form.find('input, select, textarea').each((_, el) => {
    const $el = $(el);
    const name = $el.attr('name');
    if (!name || $el.is('[disabled]')) return;
    const type = ($el.attr('type') || '').toLowerCase();
    if (el.tagName === 'input' && ['submit', 'button', 'image', 'reset'].includes(type)) return;
    if (['checkbox', 'radio'].includes(type) && !$el.is('[checked]')) return;
    if (el.tagName === 'select') {
      const sel = $el.find('option[selected]').first();
      const op = sel.length ? sel : $el.find('option').first();
      data[name] = op.attr('value') ?? op.text();
    } else if (el.tagName === 'textarea') {
      data[name] = $el.text();
    } else {
      data[name] = $el.attr('value') ?? '';
    }
  });
  return { $, form, data };
}

export class Silogtran {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/?$/, '/');
    this.origin = new URL(this.base).origin;
    this.jar = new Map();
    this.queue = Promise.resolve();
    this.wafSolved = false; // true if this instance had to run the browser challenge
    this.costCenter = null; // cost center text chosen at login
  }

  exportCookies() {
    return Object.fromEntries(this.jar);
  }

  importCookies(cookies) {
    this.jar = new Map(Object.entries(cookies || {}));
  }

  // True if the stored cookies still hold a logged-in session.
  isLoggedIn() {
    return this.enqueue(async () => !isLoginPage((await this.request(HOME_CHECK_PAGE)).text));
  }

  _storeCookies(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const del = value === 'deleted' || attrs.some((a) => /max-age=0\b/i.test(a.trim()));
      if (del) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async request(path, { method = 'GET', form = null } = {}) {
    let url = new URL(path, this.base);
    let wafTries = 0;
    for (let hops = 0; hops < 10; hops++) {
      if (url.origin !== this.origin) throw new SilogtranError('Redirect outside Silogtran blocked.');
      const headers = { 'user-agent': UA, cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
      let res;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: form ? new URLSearchParams(form).toString() : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(Number(process.env.SILOG_TIMEOUT_SEC || 45) * 1000),
        });
      } catch (e) {
        throw new SilogtranError(`Silogtran unreachable: ${e?.cause?.code || e?.message || e}`, { code: 'SILOGTRAN_UNREACHABLE' });
      }
      this._storeCookies(res);
      if (res.headers.get('x-amzn-waf-action') === 'challenge') {
        if (wafTries >= 1) throw new SilogtranError('AWS WAF still blocking after browser challenge.', { code: 'WAF_FAILED' });
        wafTries += 1;
        await this._solveWaf();
        continue;
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        url = new URL(res.headers.get('location'), url);
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          form = null;
        }
        continue;
      }
      const body = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') || '';
      if (res.status >= 400) throw new SilogtranError(`Silogtran responded HTTP ${res.status}.`);
      return { status: res.status, url: url.href, body, type, headers: res.headers, text: decode(body, type) };
    }
    throw new SilogtranError('Too many redirects.');
  }

  async _solveWaf() {
    if (process.env.WAF_BROWSER === '0') throw new SilogtranError('AWS WAF challenge and WAF_BROWSER=0.', { code: 'WAF_FAILED' });
    const waitMs = (Number(process.env.WAF_WAIT_SEC) || 30) * 1000;
    let browser;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.setUserAgent(UA);
      await page.goto(new URL(LOGIN_PAGE, this.base).href, { waitUntil: 'domcontentloaded', timeout: waitMs }).catch(() => {});
      const limit = Date.now() + waitMs;
      let cookies = [];
      while (Date.now() < limit) {
        cookies = await page.cookies();
        if (cookies.some((c) => c.name === 'aws-waf-token')) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const waf = cookies.filter((c) => c.name.toLowerCase().startsWith('aws-waf'));
      if (!waf.length) throw new SilogtranError(`Browser did not get AWS WAF token in ${waitMs / 1000}s.`, { code: 'WAF_FAILED' });
      for (const c of waf) this.jar.set(c.name, c.value);
      this.wafSolved = true;
    } catch (e) {
      if (e instanceof SilogtranError) throw e;
      throw new SilogtranError(`Could not launch browser for AWS WAF: ${e?.message || e}`, { code: 'WAF_FAILED' });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  enqueue(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  // PRADO callback (TActiveButton) → follow X-PRADO-REDIRECT if present.
  async pradoCallback(url, data, target) {
    data.PRADO_CALLBACK_TARGET = target;
    data.PRADO_CALLBACK_PARAMETER = 'null';
    const cb = await this.request(url, { method: 'POST', form: data });
    const dest =
      cb.headers.get('x-prado-redirect') || /<!--X-PRADO-REDIRECT-->\s*"?([^"<]+)"?\s*<!--/.exec(cb.text)?.[1];
    return dest ? this.request(new URL(dest.replace(/\\\//g, '/'), url).href) : cb;
  }

  login(user, password) {
    return this.enqueue(async () => {
      this.jar = new Map([...this.jar].filter(([k]) => k.toLowerCase().startsWith('aws-waf')));
      const pg = await this.request(LOGIN_PAGE);
      const { form, data } = formFields(pg.text);
      Object.assign(data, {
        'ctl0$MainModule$Usuario': user,
        'ctl0$MainModule$Clave': password,
        PRADO_POSTBACK_TARGET: 'ctl0$MainModule$BtnIngresar',
        'ctl0$MainModule$BtnIngresar': 'Iniciar Sesion',
      });
      let r = await this.request(new URL(form.attr('action') || LOGIN_PAGE, pg.url).href, { method: 'POST', form: data });

      for (let step = 0; step < 3; step++) {
        if (r.text.includes('ctl0$MainModule$centrocosto')) {
          r = await this._costCenter(r);
          continue;
        }
        if (r.text.includes('ctl0$MainModule$verification_code')) throw new SilogtranError('User has 2FA enabled; not supported.', { status: 500, code: 'LOGIN_FAILED' });
        if (r.text.includes('ctl0$MainModule$NuevaClave')) throw new SilogtranError('Silogtran requires a password change.', { status: 500, code: 'LOGIN_FAILED' });
        if (isLoginPage(r.text)) {
          const $ = cheerio.load(r.text);
          const msg = $('#ctl0_MainModule_ErrorPanel').text().replace(/\s+/g, ' ').trim();
          throw new SilogtranError(`Login failed: ${msg || 'invalid credentials'}`, { status: 500, code: 'LOGIN_FAILED' });
        }
        break;
      }
      const check = await this.request(HOME_CHECK_PAGE);
      if (isLoginPage(check.text)) throw new SilogtranError('Silogtran rejected the login.', { status: 500, code: 'LOGIN_FAILED' });
    });
  }

  async _costCenter(r) {
    const { $, form, data } = formFields(r.text);
    const name = 'ctl0$MainModule$centrocosto';
    const field = $(`[name="${name}"]`).first();
    if (field.is('select')) {
      // Always the first real cost center offered to the user.
      const opt = field
        .find('option')
        .toArray()
        .map((o) => ({ value: $(o).attr('value') ?? $(o).text(), text: $(o).text().trim() }))
        .find((o) => o.value !== '' && !/seleccione/i.test(o.text));
      if (!opt) throw new SilogtranError('User has no cost centers available.', { status: 500, code: 'COST_CENTER_FAILED' });
      data[name] = opt.value;
      this.costCenter = opt.text;
    } else if (!data[name]) {
      throw new SilogtranError('Could not select cost center automatically.', { status: 500, code: 'COST_CENTER_FAILED' });
    } else {
      this.costCenter = data[name];
    }
    const btn = 'ctl0$MainModule$BtnContinuar';
    const url = new URL(form.attr('action') || LOGIN_PAGE, r.url).href;
    if (/TActive\w*Button\(\{'ID':'ctl0_MainModule_BtnContinuar'/.test(r.text)) {
      return this.pradoCallback(url, data, btn);
    }
    data.PRADO_POSTBACK_TARGET = btn;
    data[btn] = $('#ctl0_MainModule_BtnContinuar').attr('value') || 'Continuar';
    return this.request(url, { method: 'POST', form: data });
  }
}
