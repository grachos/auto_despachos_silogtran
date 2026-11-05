// Stateful PRADO form: keeps the field map a browser would submit, runs CAutoComplete suggestions,
// event-triggered callbacks and postbacks, and applies X-PRADO-ACTIONS setValue/pagestate updates.
// Runs inside client.enqueue() callers; never enqueues itself.
import * as cheerio from 'cheerio';
import { formFields } from './client.js';

const ACTIONS_RE = /<!--X-PRADO-ACTIONS-->([\s\S]*?)<!--\/\/X-PRADO-ACTIONS-->/;
const PAGESTATE_RE = /<!--X-PRADO-PAGESTATE-->([\s\S]*?)<!--\/\/X-PRADO-PAGESTATE-->/;

export class PradoPage {
  constructor(client, page) {
    this.client = client;
    this.load(page);
  }

  load(page) {
    this.url = page.url;
    this.html = page.text;
    const { form, data } = formFields(page.text);
    this.action = new URL(form.attr('action') || page.url, page.url).href;
    this.fields = data; // enabled fields only, like a browser submit
    const $ = cheerio.load(page.text);
    this.ids = new Map(); // lowercase id -> field name
    $('[id][name]').each((_, el) => this.ids.set(el.attribs.id.toLowerCase(), el.attribs.name));
  }

  $() {
    return cheerio.load(this.html);
  }

  // Current rendered value of an input (also disabled ones).
  value(id) {
    return this.$()(`#${id}`).attr('value')?.trim() || '';
  }

  async postback(target, extra = {}) {
    const body = { ...this.fields, PRADO_POSTBACK_TARGET: target, ...extra };
    this.lastPostbackSent = body; // kept for the read-only diagnostic (what the last postback actually carried)
    const page = await this.client.request(this.action, { method: 'POST', form: body });
    this.load(page);
    return page;
  }

  // Generic callback (TEventTriggeredCallback etc.); returns the applied field names.
  async callback(target) {
    const res = await this.client.request(this.action, {
      method: 'POST',
      form: { ...this.fields, PRADO_CALLBACK_TARGET: target, PRADO_CALLBACK_PARAMETER: 'null' },
    });
    return this.applyCallback(res.text);
  }

  applyCallback(text) {
    const applied = [];
    const ps = PAGESTATE_RE.exec(text);
    if (ps) this.fields.PRADO_PAGESTATE = ps[1];
    const m = ACTIONS_RE.exec(text);
    if (!m) return applied;
    let actions = [];
    try {
      actions = JSON.parse(m[1]);
    } catch {
      return applied;
    }
    for (const action of actions) {
      const set = action?.['Prado.Element.setValue'];
      if (!set) continue;
      const name = this.ids.get(String(set[0]).toLowerCase());
      if (name && name in this.fields) {
        this.fields[name] = set[1];
        applied.push(name);
      }
    }
    return applied;
  }

  // CAutoComplete suggestions -> [{ attrs, cells }]; attrs are the values copied on selection.
  async suggest(name, text) {
    this.fields[name] = text;
    const res = await this.client.request(this.action, {
      method: 'POST',
      form: {
        ...this.fields,
        PRADO_CALLBACK_TARGET: name,
        PRADO_POSTBACK_TARGET: name,
        PRADO_CALLBACK_PARAMETER: JSON.stringify([text, 0, '__CAutoComplete_onSuggest__']),
      },
    });
    this.applyCallback(res.text);
    const $ = cheerio.load(res.text);
    return $('li[title="false"]')
      .toArray()
      .map((li) => {
        const { title, ...attrs } = li.attribs;
        const cells = $(li).find('td').toArray().map((td) => $(td).text().replace(/\s+/g, ' ').trim());
        return { attrs, cells };
      });
  }

  // Copies a suggestion's attributes into the fields the browser would have (enabled ones only).
  select(result) {
    for (const [attr, value] of Object.entries(result.attrs)) {
      const isHidden = attr.endsWith('_idhidden');
      const base = this.ids.get(isHidden ? attr.slice(0, -'_idhidden'.length) : attr);
      const name = isHidden && base ? `${base}$IDHidden` : base;
      if (name && name in this.fields) this.fields[name] = value;
    }
  }

  // EventTargets of TEventTriggeredCallback bound to `event` on control `controlId` (document order).
  triggers(controlId, event, fallback = []) {
    const found = [];
    for (const m of this.html.matchAll(/TEventTriggeredCallback\(\{([^;]*?)\}\);/g)) {
      const body = m[1];
      if (!body.includes(controlId) || !body.includes(`'${event}'`)) continue;
      const target = /'EventTarget':'([^']+)'/.exec(body)?.[1];
      if (target) found.push(target);
    }
    return found.length ? found : fallback;
  }

  // EventTarget of the TButton bound to a ValidationGroup (ctlN numbers can change between versions).
  buttonByGroup(group, fallback) {
    for (const m of this.html.matchAll(/TButton\(\{([^;]*?)\}\);/g)) {
      if (!m[1].includes(`'ValidationGroup':'${group}'`)) continue;
      const target = /'EventTarget':'([^']+)'/.exec(m[1])?.[1];
      if (target) return target;
    }
    return fallback;
  }
}
