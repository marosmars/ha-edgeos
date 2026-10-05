// EdgeRouter overview card, fed by the EdgeOS integration (elad-bar/ha-edgeos, entities <domain>.<prefix>_*).
// Same look as the EdgeSwitch card: header tiles, front panel with the physical ports, tunnel strip, side panel.
// Bundled with the edgeos integration (marosmars fork), served at /edgeos/edgerouter-card.js and loaded on every dashboard.
// Config (all optional):
//   type: custom:edgerouter-card
//   prefix: er_4_maros       entity id prefix after the domain; auto-detected when there is one router
//   wan: eth0                WAN interface (header rates)
//   sfp: [eth3]              interfaces drawn as SFP cages
//   protect: [eth0, eth1]    interfaces that can't be disabled from the card (WAN / path to HA)
// Rates need the interface's "monitored" switch on (switch.<prefix>_interface_<if>_monitored).
// Tap an interface for details and enable/disable (tunnels also restart); actions need a second tap within 4 s.
const STRINGS = {
  en: {
    clients: 'Clients', unknown: 'Unknown', links: 'Links', tunnels: 'Tunnels', up: 'up', fw: 'fw', fwNew: 'update',
    off: 'Disable', on: 'Enable', restart: 'Restart', confirm: 'Sure?', noLink: 'no link', disabled: 'disabled',
    unknownTitle: 'Unknown devices', none: 'No unknown devices', protected: 'Protected interface (WAN / path to HA)',
    noEntities: 'No EdgeOS entities found. Set prefix: in the card config.', iface: 'Interface',
  },
  sk: {
    clients: 'Klienti', unknown: 'Neznáme', links: 'Linky', tunnels: 'Tunely', up: 'beží', fw: 'fw', fwNew: 'aktualizácia',
    off: 'Vypnúť', on: 'Zapnúť', restart: 'Reštart', confirm: 'Naozaj?', noLink: 'bez linky', disabled: 'vypnuté',
    unknownTitle: 'Neznáme zariadenia', none: 'Žiadne neznáme zariadenia', protected: 'Chránené rozhranie (WAN / cesta k HA)',
    noEntities: 'Nenašli sa entity EdgeOS. Nastav prefix: v konfigurácii karty.', iface: 'Rozhranie',
  },
};
const UNIT_BPS = { 'bit/s': 1, 'kbit/s': 1e3, 'Mbit/s': 1e6, 'Gbit/s': 1e9, 'B/s': 8, 'kB/s': 8e3, 'MB/s': 8e6, 'GB/s': 8e9 };
const TUNNEL_TYPES = ['openvpn', 'wireguard', 'l2tp', 'pppoe', 'ipsec', 'vti', 'tunnel'];


// Patch the shadow DOM in place instead of replacing it: a fresh <ha-card> renders a moment later, so rebuilding it on
// every hass update briefly shrinks the page and the browser snaps the scroll position back to the top.
function paintCard(el, html) {
  const root = el.shadowRoot;
  const m = html.match(/^\s*<style>([\s\S]*?)<\/style>\s*<ha-card([^>]*)>([\s\S]*)<\/ha-card>\s*$/);
  if (!m) { root.innerHTML = html; root.__card = null; root.__html = null; return; }
  if (!root.__card) {
    root.innerHTML = '<style></style><ha-card><div class="paint-root" style="display:contents"></div></ha-card>';
    root.__style = root.querySelector('style');
    root.__card = root.querySelector('ha-card');
    root.__body = root.querySelector('.paint-root');
  }
  if (root.__style.textContent !== m[1]) root.__style.textContent = m[1];
  const attr = (n) => (m[2].match(new RegExp(`${n}="([^"]*)"`)) || [])[1] || '';
  if (root.__card.className !== attr('class')) root.__card.className = attr('class');
  if ((root.__card.getAttribute('style') || '') !== attr('style')) root.__card.setAttribute('style', attr('style'));
  if (root.__html !== m[3]) { root.__html = m[3]; root.__body.innerHTML = m[3]; }
}

class EdgeRouterCard extends HTMLElement {
  setConfig(config) {
    this._config = { wan: 'eth0', sfp: ['eth3'], protect: ['eth0', 'eth1'], ...config };
    this._sel = null;
    this._armed = null;
    this._busy = {};
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._t = STRINGS[(hass.locale?.language || hass.language || 'en').split('-')[0]] || STRINGS.en;
    if (!this._prefix) {
      this._prefix = this._config.prefix
        || Object.keys(hass.states).map((id) => id.match(/^sensor\.(.+)_unknown_devices$/)?.[1]).filter(Boolean).sort()[0];
    }
    this._tick();
  }

  static getStubConfig() {
    return {};
  }

  getCardSize() {
    return 5;
  }

  getGridOptions() {
    return { columns: 'full', rows: 'auto' };
  }

  connectedCallback() {
    this._key = (ev) => ev.key === 'Escape' && this._sel !== null && this._close();
    document.addEventListener('keydown', this._key);
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this._key);
  }

  _st(id) {
    return this._hass.states[id];
  }

  _num(id) {
    const v = parseFloat(this._st(id)?.state);
    return Number.isFinite(v) ? v : null;
  }

  _bps(id) {
    const st = this._st(id);
    const v = parseFloat(st?.state);
    return Number.isFinite(v) ? v * (UNIT_BPS[st.attributes.unit_of_measurement] ?? 1) : null;
  }

  _fmtRate(bps, long = false) {
    if (bps === null) return '–';
    const [div, unit] = bps >= 1e9 ? [1e9, 'G'] : bps >= 1e6 ? [1e6, 'M'] : bps >= 1e3 ? [1e3, 'k'] : [1, ''];
    const v = bps / div;
    return `${v >= 100 || div === 1 ? Math.round(v) : v.toFixed(1)}${long ? ` ${unit}bit/s` : unit}`;
  }

  _ifaces() {
    const p = this._prefix;
    const re = new RegExp(`^switch\\.${p}_interface_(.+)_status$`);
    const list = [];
    for (const id of Object.keys(this._hass.states)) {
      const m = id.match(re);
      if (!m) continue;
      const name = m[1];
      const st = this._st(id);
      const a = st.attributes;
      const conn = this._st(`binary_sensor.${p}_interface_${name}_connected`)?.state;
      const tunnel = TUNNEL_TYPES.includes(a.type);
      // ↓ is traffic towards the home side: received on the WAN and on tunnels, sent on LAN interfaces.
      const inward = (a.name || name) === this._config.wan || tunnel;
      const rx = this._bps(`sensor.${p}_interface_${name}_received_rate`);
      const tx = this._bps(`sensor.${p}_interface_${name}_sent_rate`);
      // name = entity-id form (eth1_40), label = interface name as the router knows it (eth1.40)
      const label = a.name || name;
      list.push({
        name,
        label,
        desc: a.description || '',
        type: a.type || '',
        tunnel,
        vlan: /^\w+\d+\.\d+$/.test(label) ? +label.split('.')[1] : null,
        sfp: this._config.sfp.includes(label),
        address: (a.address || []).join(', '),
        enabled: st.state === 'on',
        unknown: st.state === 'unknown' || st.state === 'unavailable',
        up: conn === 'on',
        down: inward ? rx : tx,
        upl: inward ? tx : rx,
        monitored: this._st(`switch.${p}_interface_${name}_monitored`)?.state === 'on',
      });
    }
    const order = (x) => [x.tunnel ? 1 : 0, x.name.replace(/\d+$/, ''), +(x.name.match(/\d+$/)?.[0] ?? 0)];
    return list.sort((a, b) => {
      const [x, y] = [order(a), order(b)];
      return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2] - y[2];
    });
  }

  _tick() {
    const ifaces = this._ifaces();
    const now = Date.now();
    for (const [k, b] of Object.entries(this._busy)) {
      const x = ifaces.find((i) => i.name === b.name);
      if (now > b.until || (x && b.done(x))) delete this._busy[k];
    }
    this._render(ifaces);
  }

  _close() {
    this._sel = null;
    this._armed = null;
    this._tick();
  }

  _notify(message) {
    this.dispatchEvent(new CustomEvent('hass-notification', { bubbles: true, composed: true, detail: { message } }));
  }

  _onClick(ev) {
    const path = ev.composedPath();
    if (path.some((el) => el.dataset?.close)) return this._close();
    const cell = path.find((el) => el.dataset?.iface);
    if (cell) {
      this._sel = this._sel === cell.dataset.iface ? null : cell.dataset.iface;
      this._armed = null;
      return this._tick();
    }
    const btn = path.find((el) => el.dataset?.act);
    if (!btn || btn.disabled) return;
    const key = btn.dataset.act;
    if (this._busy[key]) return;
    if (btn.dataset.confirm && this._armed !== key) {
      this._armed = key;
      clearTimeout(this._armTimer);
      this._armTimer = setTimeout(() => { this._armed = null; this._tick(); }, 4000);
      return this._tick();
    }
    this._armed = null;
    const [act, name] = key.split(':');
    this._run(act, name, key);
  }

  async _run(act, name, key) {
    const entity_id = `switch.${this._prefix}_interface_${name}_status`;
    const call = (svc) => this._hass.callService('switch', svc, { entity_id });
    const done = { off: (x) => !x.enabled, on: (x) => x.enabled, cycle: () => false }[act];
    this._busy[key] = { name, done, until: Date.now() + (act === 'cycle' ? 20000 : 90000) };
    this._tick();
    try {
      if (act === 'off') await call('turn_off');
      else if (act === 'on') await call('turn_on');
      else {
        // Tunnels only: the dashboard never depends on a tunnel, so the turn_on always arrives.
        await call('turn_off');
        await new Promise((r) => setTimeout(r, 5000));
        await call('turn_on');
      }
    } catch (err) {
      delete this._busy[key];
      this._tick();
      this._notify(`${name}: ${err.message || err}`);
    }
  }

  _header(ifaces) {
    const p = this._prefix;
    const t = this._t;
    const host = this._st(`sensor.${p}_cpu_usage`)?.attributes.friendly_name?.replace(/\s*CPU.*$/i, '') || 'EdgeRouter';
    const restart = this._st(`sensor.${p}_last_restart`)?.state;
    let up = '';
    if (restart && !Number.isNaN(Date.parse(restart))) {
      const s = (Date.now() - Date.parse(restart)) / 1000;
      up = `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
    }
    const fw = this._st(`binary_sensor.${p}_firmware_upgrade`);
    const fwText = fw ? (fw.state === 'on' ? `<span class="badge">${t.fwNew} ${fw.attributes.version || ''}</span>` : `${t.fw} ${fw.attributes.version || ''}`) : '';
    const wan = ifaces.find((x) => x.label === this._config.wan);
    const clients = Object.entries(this._hass.states).filter(([id, s]) => id.startsWith(`switch.${p}_device_`) && id.endsWith('_monitored') && s.state !== 'unavailable').length;
    const unknown = this._num(`sensor.${p}_unknown_devices`);
    const tile = (label, v, unit, cls = '') => `<div class="stat ${cls}"><span class="v">${v}<small>${unit}</small></span><span class="l">${label}</span></div>`;
    const lvl = (v, warn, crit) => (v === null ? '' : v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok');
    const cpu = this._num(`sensor.${p}_cpu_usage`);
    const ram = this._num(`sensor.${p}_ram_usage`);
    return `
      <div class="top">
        <div class="id">
          <ha-icon icon="mdi:router-network"></ha-icon>
          <div><div class="host">${host}</div>
          <div class="meta">WAN ${wan?.address || '–'}${up ? ` · ${t.up} ${up}` : ''}${fwText ? ` · ${fwText}` : ''} · ${clients} ${t.clients.toLowerCase()}</div></div>
        </div>
        <div class="stats">
          ${tile('CPU', cpu === null ? '–' : Math.round(cpu), '%', lvl(cpu, 70, 90))}
          ${tile('RAM', ram === null ? '–' : Math.round(ram), '%', lvl(ram, 75, 90))}
          <div class="stat wan"><span class="v"><span class="dn-r">↓${this._fmtRate(wan?.down ?? null)}</span><span class="up-r">↑${this._fmtRate(wan?.upl ?? null)}</span></span><span class="l">WAN</span></div>
        </div>
      </div>`;
  }

  _rates(x) {
    if (!x.up || x.down === null) return '';
    return `<span class="dn-r${x.down ? '' : ' zero'}">↓${this._fmtRate(x.down)}</span><span class="up-r${x.upl ? '' : ' zero'}">↑${this._fmtRate(x.upl)}</span>`;
  }

  _cls(x, base) {
    const busy = Object.values(this._busy).some((b) => b.name === x.name);
    return [base, x.up ? 'up' : 'down', x.enabled || x.unknown ? '' : 'dis', x.unknown ? 'unk' : '', this._sel === x.name ? 'sel' : '', busy ? 'busy' : '']
      .filter(Boolean).join(' ');
  }

  _port(x) {
    const busy = Object.values(this._busy).some((b) => b.name === x.name);
    return `
      <div class="${this._cls(x, `cell ${x.sfp ? 'sfp' : 'rj'}`)}" data-iface="${x.name}" title="${x.label}: ${x.desc}">
        <div class="nm"><span>${x.desc || x.label}</span></div>
        <div class="rates">${this._rates(x)}</div>
        <div class="jackrow">
          <span class="no">${x.label}</span>
          <div class="jack">${busy ? '<ha-icon icon="mdi:loading" class="spin"></ha-icon>' : ''}</div>
          <span class="leds"><i class="l1"></i><i class="l2"></i></span>
        </div>
        <div class="addr">${x.address || '—'}</div>
      </div>`;
  }

  // Chip for a tunnel or VLAN subinterface; inactive ones collapse to icon + name.
  _chip(x) {
    const icon = x.vlan !== null ? 'mdi:lan' : x.type === 'wireguard' ? 'mdi:shield-key-outline' : 'mdi:vpn';
    const busy = Object.values(this._busy).some((b) => b.name === x.name);
    const active = x.up && x.enabled;
    const label = x.vlan !== null ? `<span class="vid">${x.vlan}</span>${x.desc || x.label}` : (x.desc || x.label);
    return `
      <div class="${this._cls(x, `chip${active ? ' act-on' : ''}`)}" data-iface="${x.name}" title="${x.label}: ${x.desc}${x.address ? ` · ${x.address}` : ''}">
        <i class="led"></i>
        <ha-icon class="ti${busy ? ' spin' : ''}" icon="${busy ? 'mdi:loading' : icon}"></ha-icon>
        <span class="tn">${label}</span>
        ${active && this._rates(x) ? `<span class="rates">${this._rates(x)}</span>` : ''}
      </div>`;
  }

  _btn(act, name, icon, text, { confirm = false, disabled = false, kind = '' } = {}) {
    const key = `${act}:${name}`;
    const busy = !!this._busy[key];
    const armed = this._armed === key;
    const cls = ['act', kind, armed ? 'armed' : '', busy ? 'busy' : ''].filter(Boolean).join(' ');
    return `<button class="${cls}" data-act="${key}"${confirm ? ' data-confirm="1"' : ''}${disabled ? ' disabled' : ''}>
      <ha-icon icon="${busy ? 'mdi:loading' : icon}"${busy ? ' class="spin"' : ''}></ha-icon><span>${armed ? this._t.confirm : text}</span></button>`;
  }

  _panel(x) {
    const t = this._t;
    if (!x) {
      const attrs = this._st(`sensor.${this._prefix}_unknown_devices`)?.attributes || {};
      const devs = Object.entries(attrs).filter(([k]) => /^\d+\.\d+\.\d+\.\d+$/.test(k));
      // One wrapping line of chips: name + last two IP octets (full IP and MAC on hover).
      return `
        <div class="unk">
          <span class="ul" title="${t.unknownTitle}"><ha-icon icon="mdi:help-network-outline"></ha-icon><b>${devs.length}</b></span>
          ${devs.length
            ? devs.map(([ip, v]) => {
              const m = String(v).match(/^(\S+)\s*\((.*)\)$/);
              return `<span class="uc" title="${ip} · ${m ? m[1] : ''}">${m ? m[2] : v}<i>.${ip.split('.').slice(2).join('.')}</i></span>`;
            }).join('')
            : `<span class="none">${t.none}</span>`}
        </div>`;
    }
    const prot = this._config.protect.includes(x.label);
    return `
      <div class="pinfo">
        <div class="ptitle"><span class="dn">${x.label}</span><span class="pname">${x.desc || x.label}</span>${prot ? `<ha-icon class="shield" icon="mdi:shield-lock" title="${t.protected}"></ha-icon>` : ''}
          <button class="x" data-close="1" title="Esc"><ha-icon icon="mdi:close"></ha-icon></button></div>
        <div class="pmeta">${x.type}${x.unknown ? '' : ` · ${x.enabled ? (x.up ? 'up' : t.noLink) : `<b class="bad">${t.disabled}</b>`}`}${x.up && x.down !== null ? ` <span class="dn-r">↓${this._fmtRate(x.down, true)}</span> <span class="up-r">↑${this._fmtRate(x.upl, true)}</span>` : ''}</div>
        ${x.address ? `<div class="pmeta one">${x.address}</div>` : ''}
      </div>
      <div class="pacts">
        <div class="prow">
          ${x.enabled
            ? this._btn('off', x.name, 'mdi:lan-disconnect', t.off, { confirm: true, kind: 'danger', disabled: prot })
            : this._btn('on', x.name, 'mdi:lan-connect', t.on, { kind: 'good' })}
          ${x.tunnel ? this._btn('cycle', x.name, 'mdi:restart', t.restart, { confirm: true, disabled: !x.enabled }) : ''}
        </div>
      </div>`;
  }

  _render(ifaces) {
    if (!this._hass) return;
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.addEventListener('click', (ev) => this._onClick(ev));
    }
    if (!ifaces.length) {
      this.shadowRoot.innerHTML = `<ha-card><div style="padding:16px">${this._t.noEntities}</div></ha-card>`;
      return;
    }
    const phys = ifaces.filter((x) => !x.tunnel && x.vlan === null);
    const active = (x) => (x.up && x.enabled ? 0 : 1);
    const chips = [...ifaces.filter((x) => x.vlan !== null), ...ifaces.filter((x) => x.tunnel)]
      .sort((a, b) => active(a) - active(b)); // stable: keeps VLANs before tunnels and name order within each group
    paintCard(this, `
      <style>
        ha-card { height: 100%; box-sizing: border-box; display: flex; flex-direction: column; padding: 10px 12px 12px; --accent: var(--card-accent, #5c6bc0); box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 4px 14px rgba(0,0,0,.07); --ok: #4caf50; --slow: #ffa000; --bad: var(--error-color, #db4437); }
        .top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px;
                margin: -10px -12px 0; padding: 8px 12px; border-radius: var(--ha-card-border-radius, 12px) var(--ha-card-border-radius, 12px) 0 0;
                background: color-mix(in srgb, var(--accent) 11%, transparent); border-bottom: 2px solid color-mix(in srgb, var(--accent) 45%, transparent); }
        .id { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
        .id > div { min-width: 0; }
        .top { flex-wrap: nowrap !important; }
        .id ha-icon { --mdc-icon-size: 34px; color: var(--accent); }
        .host { font-size: 18px; font-weight: 600; line-height: 1.2; }
        .meta { font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .badge { padding: 0 6px; border-radius: 8px; background: var(--slow); color: #000; font-weight: 600; }
        .stats { display: flex; gap: 6px; flex: none; }
        .stat { display: flex; flex-direction: column; align-items: center; min-width: 58px; padding: 6px 8px; border-radius: 10px;
                background: var(--secondary-background-color); transition: background .3s; }
        .stat .v { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; white-space: nowrap; }
        .stat small { font-size: 11px; font-weight: 400; color: var(--secondary-text-color); margin-left: 1px; }
        .stat .l { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--secondary-text-color); }
        .stat.ok { background: color-mix(in srgb, var(--ok) 14%, var(--secondary-background-color)); }
        .stat.ok .v { color: var(--ok); }
        .stat.warn { background: color-mix(in srgb, var(--slow) 22%, var(--secondary-background-color)); }
        .stat.warn .v, .stat.warn .l { color: var(--slow); }
        .stat.crit { background: var(--bad); }
        .stat.crit .v, .stat.crit .l, .stat.crit small { color: #fff; }
        .stat.wan { width: 124px; box-sizing: border-box; }
        .stat.wan .v { display: flex; justify-content: space-between; width: 100%; font-size: 15px; line-height: 20px; }

        ha-card { --fp-bg: linear-gradient(#f7f8fa, #e6e8ec); --fp-edge: inset 0 1px 0 #fff, inset 0 -2px 0 rgba(0,0,0,.08), 0 0 0 1px var(--divider-color);
                  --fp-text: #3c4043; --fp-name: #1f2124; --fp-dim: #9aa0a6; --fp-sep: #c9ccd1; --fp-hover: rgba(0,0,0,.04); --fp-sel: rgba(0,0,0,.05);
                  --fp-jack: #2b2d31; --fp-jack-edge: #8d9299; --fp-led-off: #c9ccd1; --fp-panel: rgba(255,255,255,.7);
                  --fp-up: #2e7d32; --fp-down: #1565c0; --fp-upl: #6a1b9a; }
        ha-card.dark { --fp-bg: linear-gradient(#45484e, #2c2e33 55%, #26282c); --fp-edge: inset 0 1px 0 rgba(255,255,255,.1), inset 0 -2px 0 rgba(0,0,0,.4);
                  --fp-text: #c9ccd1; --fp-name: #eceef1; --fp-dim: #6f737a; --fp-sep: #55585e; --fp-hover: rgba(255,255,255,.05); --fp-sel: rgba(255,255,255,.08);
                  --fp-jack: #101113; --fp-jack-edge: #5a5d63; --fp-led-off: #3a3c40; --fp-panel: rgba(0,0,0,.25);
                  --fp-up: #8fe08f; --fp-down: #64b5f6; --fp-upl: #ce93d8; }
        .dn-r { color: var(--fp-down); } .up-r { color: var(--fp-upl); }
        .chassis-wrap { flex: 1; display: flex; flex-direction: column; container-type: inline-size; margin-top: 10px; overflow-x: auto; border-radius: 12px; background: var(--fp-bg); box-shadow: var(--fp-edge); }
        .chassis { flex: 1; display: flex; align-items: stretch; gap: 14px; padding: 6px 10px; min-height: 112px; box-sizing: border-box; color: var(--fp-text); }
        .main { flex: 1; display: flex; align-items: center; gap: 14px; min-width: 0; }
        /* physical ports 2/3, tunnels + VLANs 1/3 */
        .ports { flex: 2 1 0; min-width: 0; display: flex; gap: 8px; align-items: flex-end; justify-content: space-around; }
        .cell { display: flex; flex-direction: column; gap: 2px; flex: 0 1 130px; min-width: 92px; padding: 5px 6px; border-radius: 8px; cursor: pointer;
                border: 1px solid transparent; box-sizing: border-box; transition: background .15s, border-color .15s; }
        .cell.sfp { flex: 0 1 90px; min-width: 70px; }
        .cell:hover, .chip:hover { background: var(--fp-hover); }
        .cell.sel, .chip.sel { border-color: var(--primary-color); background: var(--fp-sel); }
        .nm { height: 16px; min-width: 0; }
        .nm span { display: block; font-size: 12.5px; line-height: 16px; font-weight: 600; color: var(--fp-name); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .rates { display: flex; justify-content: space-between; gap: 8px; height: 17px; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .rates .zero { opacity: .45; }
        .jackrow { display: flex; align-items: center; gap: 5px; }
        .no { font-size: 11.5px; font-weight: 700; color: var(--fp-dim); font-variant-numeric: tabular-nums; }
        .cell .no { width: 30px; text-align: right; }
        .up .no { color: var(--fp-up); }
        .jack { position: relative; flex: 1; height: 28px; border-radius: 3px; background: var(--fp-jack); border: 1px solid var(--fp-jack-edge);
                box-shadow: inset 0 2px 4px rgba(0,0,0,.8); display: flex; align-items: center; justify-content: center; }
        .rj .jack::before { content: ''; position: absolute; left: 50%; bottom: -6px; width: 34%; height: 5px; transform: translateX(-50%);
                            background: var(--fp-jack); border: 1px solid var(--fp-jack-edge); border-top: none; border-radius: 0 0 2px 2px; }
        .sfp .jack { height: 16px; border-radius: 2px; }
        .dis .jack { background: repeating-linear-gradient(45deg, var(--fp-jack) 0 5px, #2a1414 5px 10px); border-color: #7a3a3a; }
        .down:not(.sel) .jack, .down:not(.sel) .nm { opacity: .65; }
        .leds { display: flex; flex-direction: column; gap: 4px; }
        .leds i, .led { display: block; width: 9px; height: 6px; border-radius: 1.5px; background: var(--fp-led-off); flex: none; }
        .up .l1, .chip.up .led { background: #5f5; box-shadow: 0 0 6px #5f5; }
        .dis .l1, .chip.dis .led { background: #f44; box-shadow: 0 0 6px #f44; }
        .addr { height: 15px; margin-top: 4px; font-size: 11px; color: var(--fp-text); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .chips { container-type: inline-size; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 6px; align-items: start; padding-left: 14px; border-left: 1px solid var(--fp-sep); flex: 1 1 0; min-width: 260px; }
        .ccol { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .ccol.off .chip { width: 104px; }
        /* tight column: inactive tunnels collapse to LED + icon (name in the tooltip) */
        @container (max-width: 330px) {
          .ccol.off .chip { width: 40px; padding: 0 6px; justify-content: center; }
          .ccol.off .tn { display: none; }
        }
        .chip { display: flex; align-items: center; gap: 5px; width: 100%; height: 24px; padding: 0 8px; border-radius: 13px; cursor: pointer;
                border: 1px solid transparent; box-sizing: border-box; background: rgba(127,127,127,.1); font-size: 12px; white-space: nowrap; }
        .chip.down:not(.sel), .chip.dis:not(.sel) { opacity: .6; }
        .chip .led { width: 6px; height: 6px; border-radius: 50%; }
        .ti { --mdc-icon-size: 15px; color: var(--fp-dim); flex: none; }
        .chip.up .ti { color: var(--fp-up); }
        .tn { flex: 1; min-width: 0; font-weight: 600; color: var(--fp-name); overflow: hidden; text-overflow: ellipsis; }
        .chip:not(.act-on) .tn { font-weight: 500; }
        .chip .rates { flex: none; width: auto; min-width: 74px; height: auto; gap: 6px; font-size: 12.5px; }
        .vid { margin-right: 4px; padding: 0 4px; border-radius: 4px; background: var(--fp-sep); font-size: 10.5px; font-weight: 700; }

        .side { position: relative; flex: 0 0 200px; border-radius: 10px; background: var(--fp-panel); box-shadow: inset 0 1px 3px rgba(0,0,0,.15); }
        .sidein { position: absolute; inset: 0; box-sizing: border-box; padding: 7px 12px; overflow: hidden; display: flex; flex-direction: column; gap: 3px; }
        .unk { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; align-content: flex-start; }
        .ul { display: inline-flex; align-items: center; gap: 3px; height: 20px; padding: 0 7px 0 4px; border-radius: 10px;
              background: var(--slow); color: #000; font-size: 11px; }
        .ul ha-icon { --mdc-icon-size: 14px; }
        .uc { display: inline-flex; align-items: baseline; gap: 3px; height: 20px; line-height: 20px; padding: 0 7px; border-radius: 10px;
              background: rgba(127,127,127,.14); font-size: 11.5px; font-weight: 600; color: var(--fp-name); white-space: nowrap; }
        .uc i { font-style: normal; font-weight: 400; font-size: 10.5px; color: var(--fp-dim); font-variant-numeric: tabular-nums; }
        .unk .none { font-size: 11.5px; color: var(--fp-dim); }
        .ph { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; font-weight: 600; color: var(--fp-name); }
        .ph ha-icon { --mdc-icon-size: 16px; color: var(--fp-dim); }
        .cnt { margin-left: auto; padding: 0 6px; line-height: 15px; border-radius: 8px; background: var(--slow); color: #000; font-size: 11px; }
        .devs { display: flex; flex-direction: column; gap: 1px; overflow-y: auto; margin-top: 1px; }
        .dev { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; line-height: 15px; }
        .dev b { font-weight: 600; color: var(--fp-name); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dev span { font-variant-numeric: tabular-nums; }
        .dev.none { color: var(--fp-dim); display: block; }
        .pinfo { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .ptitle { display: flex; align-items: center; gap: 8px; }
        .dn { flex: none; padding: 0 7px; height: 24px; border-radius: 7px; display: inline-flex; align-items: center;
              background: var(--primary-color); color: var(--text-primary-color, #fff); font-size: 13px; font-weight: 700; }
        .pname { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; color: var(--fp-name); overflow-wrap: anywhere; }
        .shield { --mdc-icon-size: 16px; color: var(--fp-dim); flex: none; }
        .x { flex: none; border: none; background: none; padding: 2px; cursor: pointer; color: var(--fp-dim); display: flex; }
        .x ha-icon { --mdc-icon-size: 18px; }
        .pmeta { font-size: 12px; color: var(--fp-text); }
        .pmeta.one { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bad { color: var(--bad); }
        .pacts { display: flex; flex-direction: column; gap: 5px; margin-top: auto; }
        .prow { display: flex; align-items: center; gap: 6px; }
        .act { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 10px;
               border-radius: 16px; border: 1px solid var(--divider-color); cursor: pointer; white-space: nowrap;
               background: var(--card-background-color); color: var(--primary-text-color); font: 600 12.5px/1 var(--ha-font-family-body, inherit); }
        .act ha-icon { --mdc-icon-size: 16px; }
        .act.danger { color: var(--bad); } .act.good { color: var(--ok); }
        .act.armed { color: #fff; background: var(--bad); border-color: var(--bad); }
        .act.busy { cursor: progress; }
        .act:disabled { opacity: .4; cursor: not-allowed; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @container (max-width: 1150px) {
          /* side panel (unknown devices / selected interface) moves under the ports + chips row */
          .chassis { flex-direction: column; gap: 8px; }
          .chips { min-width: 0; }
          /* fixed height: the unknown-devices line and a selected interface take the same space */
          .side { flex: 0 0 52px; }
          .sidein { padding: 5px 10px; flex-direction: row; align-items: center; gap: 14px; }
          .sidein:has(.unk) { align-items: center; }
          .unk { flex-wrap: nowrap; overflow: hidden; }
          .pinfo { flex: 1; min-width: 0; gap: 1px; }
          .ptitle .pname { font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .dn { height: 20px; font-size: 12px; }
          .pmeta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .pinfo .pmeta.one { display: none; }
          .pacts { margin-top: 0; flex: none; }
          .prow { gap: 5px; }
          .act { flex: none; width: 110px; height: 26px; }
        }
        @container (max-width: 760px) {
          .main { flex-direction: column; align-items: stretch; }
          .ports { flex: none; }
          .chips { padding: 8px 0 0; border-left: none; border-top: 1px solid var(--fp-sep); }
        }
        /* phones: title on its own line, stat tiles below it */
        @media (max-width: 600px) {
          /* never centre a row that may be wider than the screen: the overflow would go off the left edge */
          .chassis-wrap { overflow: hidden; }
          .ports { justify-content: flex-start; flex-wrap: wrap; gap: 4px; }
          .cell { flex: 1 1 72px; min-width: 0; padding: 4px 3px; }
          .cell.sfp { flex: 0 1 62px; }
          .unk { flex-wrap: wrap; }
          .side { flex: none; }
          .sidein { position: static; flex-wrap: wrap; }
          .cell .no { width: auto; }
          .addr { font-size: 10px; }
          .cell .rates { flex-direction: column; height: auto; gap: 0; font-size: 11.5px; line-height: 14px; }
          .top { flex-wrap: wrap !important; }
          .stats { width: 100%; flex-wrap: wrap; }
          .stat { flex: 1 1 56px; min-width: 0; }
          .stat.wan { width: auto; flex: 2 1 110px; }
        }
      </style>
      <ha-card class="${this._hass.themes?.darkMode ? 'dark' : ''}" style="${this._config.accent ? `--card-accent:${this._config.accent}` : ''}">
        ${this._header(ifaces)}
        <div class="chassis-wrap"><div class="chassis">
          <div class="main">
            <div class="ports">${phys.map((x) => this._port(x)).join('')}</div>
            ${chips.length ? `<div class="chips">
              <div class="ccol">${chips.filter((x) => x.up && x.enabled).map((x) => this._chip(x)).join('')}</div>
              <div class="ccol off">${chips.filter((x) => !(x.up && x.enabled)).map((x) => this._chip(x)).join('')}</div>
            </div>` : ''}
          </div>
          <div class="side"><div class="sidein">${this._panel(ifaces.find((x) => x.name === this._sel))}</div></div>
        </div></div>
      </ha-card>`);
  }
}

// Define once HA's scoped custom element registry is in place (see edgeswitch-card.js).
function defineEdgeRouterCard() {
  if (customElements.get('edgerouter-card')) return;
  customElements.define('edgerouter-card', EdgeRouterCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'edgerouter-card', name: 'EdgeRouter', description: 'EdgeRouter interfaces, tunnels and unknown devices', preview: true });
}
if (customElements.get('home-assistant')) defineEdgeRouterCard();
else customElements.whenDefined('home-assistant').then(defineEdgeRouterCard);
