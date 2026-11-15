// GhostPad on-screen controller (multi-touch), drawn from a layout the PC sends.
// Layout format: see pc/layouts/README.md. Output is XInput-style state:
// buttons bitmask, sticks -32767..32767 (up = +), triggers 0..255.
// The same file draws the live preview in the PC's Control Creator.
'use strict';

(function () {
  const BTN = {
    UP: 0x0001, DOWN: 0x0002, LEFT: 0x0004, RIGHT: 0x0008, START: 0x0010, BACK: 0x0020,
    L3: 0x0040, R3: 0x0080, LB: 0x0100, RB: 0x0200, GUIDE: 0x0400, A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000,
  };
  const TRIG = { LT: 1, RT: 2 }; // trigger bits, kept apart from the button mask

  // Built-in fallback — identical to pc/layouts/default.json.
  const DEFAULT_LAYOUT = {
    id: 'default',
    name: 'Xbox controller (all buttons)',
    controls: [
      { type: 'button', label: 'LT', press: ['LT'], x: 8.5, y: 10, shape: 'pill', w: 13, h: 6.4 },
      { type: 'button', label: 'LB', press: ['LB'], x: 8.5, y: 22, shape: 'pill', w: 13, h: 6.4 },
      { type: 'button', label: 'RT', press: ['RT'], x: 91.5, y: 10, shape: 'pill', w: 13, h: 6.4 },
      { type: 'button', label: 'RB', press: ['RB'], x: 91.5, y: 22, shape: 'pill', w: 13, h: 6.4 },
      { type: 'button', label: '⧉', press: ['BACK'], x: 42, y: 20, size: 6.4 },
      { type: 'button', label: '≡', press: ['START'], x: 58, y: 20, size: 6.4 },
      { type: 'button', label: 'L3', press: ['L3'], x: 4.5, y: 88, size: 6 },
      { type: 'button', label: 'R3', press: ['R3'], x: 77, y: 90, size: 6 },
      { type: 'button', label: 'Y', press: ['Y'], x: 86, y: 44, size: 9.5 },
      { type: 'button', label: 'X', press: ['X'], x: 79, y: 58, size: 9.5 },
      { type: 'button', label: 'B', press: ['B'], x: 93, y: 58, size: 9.5 },
      { type: 'button', label: 'A', press: ['A'], x: 86, y: 72, size: 9.5 },
      { type: 'stick', stick: 'L', x: 16, y: 63, size: 26 },
      { type: 'stick', stick: 'R', x: 64, y: 82, size: 26 },
      { type: 'dpad', x: 34, y: 80, size: 23 },
    ],
  };

  const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '');
  const strList = (v, max) => (Array.isArray(v) ? v.map((s) => String(s).slice(0, 24)).filter(Boolean).slice(0, max) : []);
  const safeUrl = (u) => (typeof u === 'string' && /^(data:image\/(png|jpeg|webp|gif);base64,|blob:)/.test(u) ? u : '');

  // Layouts arrive over the network: keep only known fields with sane values.
  // `resolve(ref)` turns an image reference into a displayable URL (data:/blob: only).
  function normalize(raw, resolve) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.controls)) return null;
    const img = (ref) => (typeof ref === 'string' && ref && resolve ? safeUrl(resolve(ref)) : '');
    const modes = strList(raw.modes, 6);
    const vr = raw.variants && typeof raw.variants === 'object' ? raw.variants : null;
    const variants = vr ? { label: String(vr.label || 'Character').slice(0, 24), options: strList(vr.options, 6) } : null;
    const controls = [];
    raw.controls.slice(0, 48).forEach((c, idx) => {
      if (!c || typeof c !== 'object') return;
      const base = {
        idx, x: num(c.x, 0, 100, 50), y: num(c.y, 0, 100, 50), color: safeColor(c.color),
        modes: strList(c.modes, 6).filter((m) => modes.includes(m)),
        // only shown while this game value is "1" (e.g. "pbomb": the plane Mini-Bomb is unlocked)
        showWhen: /^[a-z0-9]{1,12}$/i.test(c.showWhen || '') ? c.showWhen : '',
        // only shown for these characters (e.g. ["Chalice"]); empty = everyone
        only: variants ? strList(c.only, 6).filter((v) => variants.options.includes(v)) : [],
      };
      if (c.type === 'button') {
        let mask = 0; let trig = 0;
        for (const p of Array.isArray(c.press) ? c.press : []) {
          const k = String(p).toUpperCase();
          if (k in BTN) mask |= BTN[k]; else if (k in TRIG) trig |= TRIG[k];
        }
        // a second press that joins shortly after the first, e.g. DOWN, then DASH (Chalice's dodge roll)
        let thenMask = 0;
        for (const p of Array.isArray(c.then) ? c.then : []) { const k = String(p).toUpperCase(); if (k in BTN) thenMask |= BTN[k]; }
        const vImages = {};
        if (variants && c.variantImages && typeof c.variantImages === 'object') {
          for (const v of variants.options) { const u = img(c.variantImages[v]); if (u) vImages[v] = u; }
        }
        const bg = img(c.bg);
        let stateImage = null; // icon that follows a live game value, e.g. the weapon in use
        if (c.stateImage && typeof c.stateImage === 'object' && /^[a-z0-9]{1,12}$/i.test(c.stateImage.key || '') && c.stateImage.map) {
          const map = {};
          for (const [k, v] of Object.entries(c.stateImage.map).slice(0, 40)) { const url = img(v); if (url) map[String(k).slice(0, 64)] = url; }
          stateImage = { key: c.stateImage.key, map };
        }
        const meter = /^[a-z0-9]{1,12}$/i.test(c.meter || '') ? c.meter : '';
        const mVar = {}; // per-character meter pictures: {"Mugman": {"base": ..., "image": ...}}
        if (variants && c.meterVariantImages && typeof c.meterVariantImages === 'object') {
          for (const v of variants.options) {
            const e = c.meterVariantImages[v];
            if (e && typeof e === 'object') mVar[v] = { base: img(e.base), image: img(e.image) };
          }
        }
        controls.push({
          ...base, type: 'button', label: String(c.label ?? '').slice(0, 12), mask, trig,
          thenMask, thenMs: num(c.thenMs, 20, 500, 70),
          textColor: safeColor(c.textColor), // colour of the text on a picture badge (for dark badges)
          shape: ['circle', 'square', 'pill'].includes(c.shape) ? c.shape : 'circle',
          size: num(c.size, 3, 40, 9.5), w: num(c.w, 3, 60, 13), h: num(c.h, 3, 40, 6.4),
          mode: ['hold', 'toggle', 'turbo'].includes(c.mode) ? c.mode : 'hold',
          bg, image: img(c.image), vImages,
          imageShape: c.imageShape === 'round' ? 'round' : 'original',
          imageScale: num(c.imageScale, 0.2, 1.6, bg ? 0.72 : 0.95),
          altImage: img(c.altImage), altMs: num(c.altMs, 100, 5000, 650),
          stateImage,
          meter, meterAt: num(c.meterAt, 0.05, 1, 0.8), meterBase: img(c.meterBase), meterImage: img(c.meterImage),
          meterNeeds: /^[a-z0-9]{1,12}$/i.test(c.meterNeeds || '') ? c.meterNeeds : '', meterLabel: String(c.meterLabel ?? '').slice(0, 12),
          meterVariants: mVar,
          // meter pictures that follow a game value, e.g. the Super Art in use:
          // {"key": "sa", "map": {"level_super_ghost|Cuphead": {"base": ..., "image": ...}}}
          meterMap: (() => {
            const mm = c.meterMap;
            if (!mm || typeof mm !== 'object' || !/^[a-z0-9]{1,12}$/i.test(mm.key || '') || !mm.map || typeof mm.map !== 'object') return null;
            const map = {};
            for (const [k, e] of Object.entries(mm.map).slice(0, 40)) {
              if (e && typeof e === 'object') map[String(k).slice(0, 64)] = { base: img(e.base), image: img(e.image) };
            }
            return { key: mm.key, map };
          })(),
          altV: (() => { // per-character after-press picture, e.g. Chalice's double jump
            const o = {};
            if (variants && c.altVariantImages && typeof c.altVariantImages === 'object') {
              for (const v of variants.options) { const url = img(c.altVariantImages[v]); if (url) o[v] = url; }
            }
            return o;
          })(),
          vLabels: (() => { // per-character caption, e.g. "PARRY DASH" for Chalice
            const o = {};
            if (variants && c.variantLabels && typeof c.variantLabels === 'object') {
              for (const v of variants.options) if (typeof c.variantLabels[v] === 'string') o[v] = c.variantLabels[v].slice(0, 12);
            }
            return o;
          })(),
          // little "x2" badge showing a game number, e.g. "exn" = EX shots available
          countKey: /^[a-z0-9]{1,12}$/i.test(c.countKey || '') ? c.countKey : '',
          countPrefix: String(c.countPrefix ?? 'x').slice(0, 4),
        });
      } else if (c.type === 'stick') {
        const which = String(c.stick || 'L').toUpperCase();
        controls.push({
          ...base, type: 'stick', stick: ['L', 'R', 'DPAD'].includes(which) ? which : 'L',
          size: num(c.size, 10, 60, 26), deadzone: num(c.deadzone, 0, 0.5, 0.1), label: String(c.label ?? '').slice(0, 12),
        });
      } else if (c.type === 'dpad') {
        controls.push({ ...base, type: 'dpad', size: num(c.size, 10, 50, 23) });
      }
    });
    const mapTo = (obj, allowed) => {
      const out = {};
      if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) if (allowed.includes(v)) out[String(k).slice(0, 24)] = v;
      return out;
    };
    const vOpts = variants ? variants.options : [];
    return {
      id: String(raw.id || 'custom').slice(0, 40), name: String(raw.name || raw.id || 'Custom').slice(0, 60),
      modes, variants: vOpts.length ? variants : null, controls,
      gameModes: mapTo(raw.gameModes, modes),          // game scene -> mode, e.g. {"isle": "Isle"}
      gameVariants: mapTo(raw.gameVariants, vOpts),    // game character -> variant, e.g. {"mugman": "Mugman"}
    };
  }

  const visibleIn = (c, mode, gs, variant) => (!c.modes.length || !mode || c.modes.includes(mode))
    && (!c.showWhen || !gs || gs[c.showWhen] === '1')
    && (!c.only || !c.only.length || !variant || c.only.includes(variant));
  // Signature of every "show only when" value, so a change triggers a redraw.
  const showKey = (l, gs) => (gs ? l.controls.filter((c) => c.showWhen).map((c) => gs[c.showWhen]).join(',') : '');

  // Picture a button shows right now: game value > character > plain icon.
  function iconFor(c, variant, gs) {
    if (c.stateImage && gs && gs[c.stateImage.key] !== undefined) {
      const val = gs[c.stateImage.key];
      const u = c.stateImage.map[val + '|' + variant] || c.stateImage.map[val];
      if (u) return u;
    }
    return c.vImages[variant] || c.image;
  }

  // Apply live game values (super meter, weapon in use...) to drawn buttons without redrawing.
  function applyState(rootEl, l, variant, gs) {
    for (const c of l.controls) {
      if (c.type !== 'button' || !(c.meter || c.stateImage || c.countKey)) continue;
      const el = rootEl.querySelector('[data-i="' + c.idx + '"]');
      if (!el) continue;
      const main = el.querySelector('img.main');
      if (main && !main.dataset.alt) {
        const want = iconFor(c, variant, gs);
        if (want && main.getAttribute('src') !== want) main.setAttribute('src', want);
      }
      const count = c.countKey ? el.querySelector('.count') : null;
      if (count) {
        const n = gs ? gs[c.countKey] : undefined;
        count.textContent = n === undefined ? '' : c.countPrefix + n;
        count.hidden = n === undefined;
        el.classList.toggle('count-zero', n === '0');
      }
      const mp = c.meter ? meterPics(c, variant, gs) : null;
      if (!mp || !mp.image) continue;
      for (const [cls, url] of [['mbase', mp.base], ['mfill', mp.image]]) {
        const im = el.querySelector('img.' + cls);
        if (im && url && im.getAttribute('src') !== url) im.setAttribute('src', url);
      }
      const f = gs && gs[c.meter] !== undefined ? Number(gs[c.meter]) : NaN;
      const allowed = !c.meterNeeds || (gs && gs[c.meterNeeds] === '1');
      const on = allowed && f >= c.meterAt;
      const ready = on && f >= 0.999;
      el.classList.toggle('meter-on', on);
      el.classList.toggle('meter-ready', ready);
      const fill = el.querySelector('img.mfill');
      if (fill) {
        const part = on ? Math.min(1, (f - c.meterAt) / Math.max(0.001, 1 - c.meterAt)) : 0;
        fill.style.setProperty('--fill-top', ((1 - part) * 100).toFixed(1) + '%');
      }
      const cap = el.querySelector('.caption');
      if (cap) cap.textContent = ready && c.meterLabel ? c.meterLabel : labelFor(c, variant);
      if (count && ready) count.hidden = true; // a full meter fires the super, not an EX
    }
  }
  const meterPics = (c, variant, gs) => {
    if (c.meterMap && gs && gs[c.meterMap.key] !== undefined) {
      const val = gs[c.meterMap.key];
      const e = c.meterMap.map[val + '|' + variant] || c.meterMap.map[val];
      if (e && e.image) return e;
    }
    const v = c.meterVariants[variant] || {};
    return { base: v.base || c.meterBase, image: v.image || c.meterImage };
  };
  const labelFor = (c, variant) => (variant && c.vLabels[variant] !== undefined ? c.vLabels[variant] : c.label);
  const u = (v) => `calc(${v} * var(--u, 1vh) * var(--pad-scale, 1))`;

  // HTML for every control visible in `mode` (shared by the iPad and the PC preview).
  function buildHtml(layout, mode, variant, gs, everyCharacter) {
    let html = '';
    for (const c of layout.controls) {
      if (!visibleIn(c, mode, gs, everyCharacter ? '' : variant)) continue;
      const pos = `left:${c.x}%;top:${c.y}%;${c.color ? `--c:${c.color};` : ''}${c.textColor ? `--txt:${c.textColor};--txt-on:${c.textColor};` : ''}`;
      if (c.type === 'button') {
        const w = c.shape === 'pill' ? c.w : c.size;
        const h = c.shape === 'pill' ? c.h : c.size;
        const pic = iconFor(c, variant, gs);
        const hasArt = !!(pic || c.bg);
        const label = labelFor(c, variant);
        const font = Math.min(h * 0.42, (w * 1.05) / Math.max(1, label.length));
        let inner = '';
        if (c.bg) inner += `<img class="bg" src="${c.bg}" alt="" draggable="false">`;
        const sz = `width:${c.imageScale * 100}%;height:${c.imageScale * 100}%`;
        if (pic) inner += `<img class="icon main ${c.imageShape}" src="${pic}" alt="" draggable="false" style="${sz}">`;
        const mp = meterPics(c, variant, gs);
        if (c.meter && mp.image) {
          if (mp.base) inner += `<img class="icon mbase" src="${mp.base}" alt="" draggable="false" style="${sz}">`;
          inner += `<img class="icon mfill" src="${mp.image}" alt="" draggable="false" style="${sz}">`;
        }
        if (c.countKey) inner += '<span class="count" hidden></span>';
        if (!hasArt) inner += esc(label);
        else if (!pic && label) { // text on the badge, sized to stay inside its inner circle
          inner += `<span class="txt" style="font-size:${u(Math.min(h * 0.3, (w * 0.7) / Math.max(2, label.length)))}">${esc(label)}</span>`;
        }
        else if (label) inner += `<span class="caption" style="font-size:${u(Math.max(1.4, Math.min(2.2, h * 0.16)))}">${esc(label)}</span>`;
        const notMine = everyCharacter && c.only && c.only.length && variant && !c.only.includes(variant); // creator: another character's button
        html += `<div class="b ${c.shape}${hasArt ? ' art' : ''}${c.mode !== 'hold' ? ' ' + c.mode : ''}${notMine ? ' other-char' : ''}" data-i="${c.idx}"
          style="${pos}width:${u(w)};height:${u(h)};font-size:${u(font)}">${inner}</div>`;
      } else if (c.type === 'stick') {
        html += `<div class="stick-base" data-i="${c.idx}" style="${pos}width:${u(c.size)};height:${u(c.size)}">
          <div class="stick-knob"></div>${c.label ? `<span class="stick-label">${esc(c.label)}</span>` : ''}</div>`;
      } else {
        html += `<div class="dpad" data-i="${c.idx}" style="${pos}width:${u(c.size)};height:${u(c.size)}">
          <div class="d u"></div><div class="d dn"></div><div class="d l"></div><div class="d r"></div></div>`;
      }
    }
    return html;
  }

  const state = { b: 0, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };
  let root = null;
  let onChange = () => {};
  let layout = normalize(DEFAULT_LAYOUT);
  let mode = '';
  let variant = '';
  let gameState = null;          // latest values from the game mod, or null
  let lastScene = '';
  let lastP2 = '';
  let lastShow = '';
  let onAuto = () => {};         // told when the game switches mode/character by itself
  let items = [];                // visible controls: {c, el, ...geometry cached by measure()}
  const owners = new Map();      // touch id -> stick item | 'btn'
  const btnTouches = new Map();  // touch id -> {x, y}
  let keyMask = 0;
  const keyStick = { x: 0, y: 0 };
  const keysDown = new Set();
  let turboTimer = 0;

  function render() {
    if (!root) return;
    owners.clear(); btnTouches.clear();
    if (layout.modes.length && !layout.modes.includes(mode)) mode = layout.modes[0];
    if (layout.variants && !layout.variants.options.includes(variant)) variant = layout.variants.options[0];
    root.innerHTML = buildHtml(layout, mode, variant, gameState);
    lastShow = showKey(layout, gameState);
    items = [];
    for (const c of layout.controls) {
      if (!visibleIn(c, mode, gameState, variant)) continue;
      const el = root.querySelector(`[data-i="${c.idx}"]`);
      const it = { c, el, on: false, latched: false, touch: null, vx: 0, vy: 0, dShown: 0, altTimer: 0 };
      if (c.type === 'stick') it.knob = el.firstElementChild;
      if (c.type === 'dpad') it.d = { [BTN.UP]: el.querySelector('.u'), [BTN.DOWN]: el.querySelector('.dn'), [BTN.LEFT]: el.querySelector('.l'), [BTN.RIGHT]: el.querySelector('.r') };
      if (c.type === 'button') it.icon = el.querySelector('img.main');
      items.push(it);
    }
    applyState(root, layout, variant, gameState);
    measure();
    recompute();
  }

  // Read geometry once per layout/resize; touch handling only uses this cache.
  function measure() {
    if (!root || root.offsetParent === null) return;
    for (const it of items) {
      const r = it.el.getBoundingClientRect();
      it.cx = r.left + r.width / 2;
      it.cy = r.top + r.height / 2;
      it.hw = r.width / 2;
      it.hh = r.height / 2;
      it.r = r.width / 2;
    }
  }

  function hitButton(it, x, y) {
    if (it.c.shape === 'circle') return (x - it.cx) ** 2 + (y - it.cy) ** 2 <= (it.r * 1.18) ** 2;
    return Math.abs(x - it.cx) <= it.hw * 1.12 && Math.abs(y - it.cy) <= it.hh * 1.12;
  }

  // "After-press" picture, e.g. Cuphead's jump turns into parry while in the air.
  function showAlt(it) {
    const alt = it.c.altV[variant] || it.c.altImage;
    if (!alt || !it.icon) return;
    const already = !!it.altTimer;
    clearTimeout(it.altTimer);
    it.icon.src = alt;
    it.icon.dataset.alt = '1';
    it.altTimer = setTimeout(() => {
      it.altTimer = 0;
      delete it.icon.dataset.alt;
      it.icon.src = iconFor(it.c, variant, gameState);
    }, already ? it.c.altMs * 0.6 : it.c.altMs);
  }

  function stickAt(x, y) {
    for (const it of items) {
      if (it.c.type !== 'stick' || it.touch !== null) continue;
      if ((x - it.cx) ** 2 + (y - it.cy) ** 2 <= (it.r * 1.3) ** 2) return it;
    }
    return null;
  }

  function moveStick(it, x, y) {
    let dx = x - it.cx; let dy = y - it.cy;
    const travel = it.r * 0.72;
    const mag = Math.hypot(dx, dy);
    if (mag > travel) { dx = dx / mag * travel; dy = dy / mag * travel; }
    it.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    let nx = dx / travel; let ny = -dy / travel;
    const n = Math.hypot(nx, ny);
    const dz = it.c.deadzone;
    if (n < dz) { nx = 0; ny = 0; } else { const k = (n - dz) / (1 - dz) / n; nx *= k; ny *= k; }
    it.vx = nx; it.vy = ny;
  }

  function releaseStick(it) {
    it.touch = null; it.vx = 0; it.vy = 0;
    it.knob.style.transform = 'translate(-50%, -50%)';
    it.el.classList.remove('on');
  }

  function onTouch(e) {
    e.preventDefault();
    const type = e.type;
    for (const t of e.changedTouches) {
      const id = t.identifier;
      if (type === 'touchstart') {
        const s = stickAt(t.clientX, t.clientY);
        if (s) { s.touch = id; owners.set(id, s); s.el.classList.add('on'); moveStick(s, t.clientX, t.clientY); continue; }
        owners.set(id, 'btn');
        btnTouches.set(id, { x: t.clientX, y: t.clientY });
        for (const it of items) { // edge-triggered effects happen on touch-down only
          if (it.c.type !== 'button' || !hitButton(it, t.clientX, t.clientY)) continue;
          if (it.c.mode === 'toggle') it.latched = !it.latched;
          showAlt(it);
        }
      } else {
        const o = owners.get(id);
        if (o === undefined) continue;
        if (type === 'touchmove') {
          if (o === 'btn') { const p = btnTouches.get(id); p.x = t.clientX; p.y = t.clientY; } else moveStick(o, t.clientX, t.clientY);
        } else {
          if (o === 'btn') btnTouches.delete(id); else releaseStick(o);
          owners.delete(id);
        }
      }
    }
    recompute();
  }

  let mouseDown = false;
  function onMouse(e) {
    if (e.pointerType !== 'mouse') return;
    const fake = (type) => onTouch({ type, preventDefault() {}, changedTouches: [{ identifier: 'm', clientX: e.clientX, clientY: e.clientY }] });
    if (e.type === 'pointerdown') { mouseDown = true; fake('touchstart'); } else if (mouseDown) {
      if (e.type === 'pointerup') { mouseDown = false; fake('touchend'); } else fake('touchmove');
    }
  }

  function dirMask(x, y, threshold) { // vector (up = +y) -> d-pad bits, 8-way
    if (Math.hypot(x, y) < threshold) return 0;
    const a = Math.atan2(y, x) * 180 / Math.PI;
    let m = 0;
    if (a > 22.5 && a < 157.5) m |= BTN.UP;
    if (a < -22.5 && a > -157.5) m |= BTN.DOWN;
    if (a > 112.5 || a < -112.5) m |= BTN.LEFT;
    if (a < 67.5 && a > -67.5) m |= BTN.RIGHT;
    return m;
  }

  function recompute() {
    let mask = 0; let trig = 0; let turboHeld = false;
    const phase = Math.floor(performance.now() / 50) % 2 === 0; // turbo: 10 presses/second
    let lx = 0; let ly = 0; let rx = 0; let ry = 0;
    let forceDown = false; // a two-step press that needs "down": the move stick must not cancel it
    let forceUp = false;   // same for "up" (the Noise's super jump)

    for (const it of items) {
      const c = it.c;
      if (c.type === 'button') {
        let touched = false;
        for (const p of btnTouches.values()) if (hitButton(it, p.x, p.y)) { touched = true; break; }
        let active = c.mode === 'toggle' ? it.latched : touched;
        if (c.mode === 'turbo' && touched) { turboHeld = true; active = phase; }
        if (c.thenMask) {
          // Two-step press: the first buttons go down at once, the second joins after thenMs. A quick
          // tap still plays the whole thing, so the game never sees only half of it.
          const t = performance.now();
          if (active && !it.seqOn) {
            it.seqOn = true; it.seqAt = t; it.seqEnd = t + c.thenMs + 110;
            setTimeout(recompute, c.thenMs + 2); setTimeout(recompute, c.thenMs + 114);
          }
          if (!active) it.seqOn = false;
          if (!active && t < (it.seqEnd || 0)) active = true;
          if (active) {
            if (t - it.seqAt >= c.thenMs) mask |= c.thenMask;
            if (c.mask & BTN.DOWN) forceDown = true;
            if (c.mask & BTN.UP) forceUp = true;
          }
        }
        if (active) { mask |= c.mask; trig |= c.trig; }
        const lit = c.mode === 'turbo' ? touched : active;
        if (lit !== it.on) { it.on = lit; it.el.classList.toggle('on', lit); }
      } else if (c.type === 'dpad') {
        let m = 0;
        for (const p of btnTouches.values()) {
          const dx = p.x - it.cx; const dy = it.cy - p.y;
          if (Math.hypot(dx, dy) <= it.r * 1.1) m |= dirMask(dx / it.r, dy / it.r, 0.12);
        }
        mask |= m;
        if (m !== it.dShown) {
          for (const bit of [BTN.UP, BTN.DOWN, BTN.LEFT, BTN.RIGHT]) it.d[bit].classList.toggle('on', !!(m & bit));
          it.dShown = m;
        }
      } else if (c.type === 'stick' && it.touch !== null) {
        if (c.stick === 'DPAD') mask |= dirMask(it.vx, it.vy, 0.35);
        else if (c.stick === 'L') { if (Math.hypot(it.vx, it.vy) > Math.hypot(lx, ly)) { lx = it.vx; ly = it.vy; } }
        else if (Math.hypot(it.vx, it.vy) > Math.hypot(rx, ry)) { rx = it.vx; ry = it.vy; }
      }
    }

    mask |= keyMask & 0xffff;
    trig |= keyMask >>> 16;
    if (!lx && !ly) { lx = keyStick.x; ly = keyStick.y; }
    if (forceDown) { ly = -1; lx *= 0.3; }
    else if (forceUp) { ly = 1; lx *= 0.3; }
    state.b = mask;
    state.lt = trig & 1 ? 255 : 0;
    state.rt = trig & 2 ? 255 : 0;
    state.lx = Math.round(lx * 32767); state.ly = Math.round(ly * 32767);
    state.rx = Math.round(rx * 32767); state.ry = Math.round(ry * 32767);

    if (turboHeld && !turboTimer) turboTimer = setInterval(recompute, 25);
    else if (!turboHeld && turboTimer) { clearInterval(turboTimer); turboTimer = 0; }
    onChange(state);
  }

  // Keyboard (iPad keyboard / testing): WASD stick, arrows d-pad, Space/K=A, L=B, J=X, I=Y, Q/E bumpers, 1/3 triggers, Enter start, Tab back.
  const KEYMAP = {
    ArrowUp: BTN.UP, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT, ArrowRight: BTN.RIGHT,
    Space: BTN.A, KeyK: BTN.A, KeyL: BTN.B, KeyJ: BTN.X, KeyI: BTN.Y, KeyQ: BTN.LB, KeyE: BTN.RB,
    Enter: BTN.START, Tab: BTN.BACK, Digit1: TRIG.LT << 16, Digit3: TRIG.RT << 16,
  };
  const STICKKEYS = { KeyW: [0, 1], KeyS: [0, -1], KeyA: [-1, 0], KeyD: [1, 0] };
  function onKey(e) {
    if (!root || root.offsetParent === null) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.isContentEditable)) return;
    if (!(e.code in KEYMAP) && !(e.code in STICKKEYS)) return;
    e.preventDefault();
    if (e.type === 'keydown') keysDown.add(e.code); else keysDown.delete(e.code);
    recomputeKeys();
  }
  function recomputeKeys() {
    keyMask = 0; let x = 0; let y = 0;
    for (const k of keysDown) {
      if (k in KEYMAP) keyMask |= KEYMAP[k];
      else { x += STICKKEYS[k][0]; y += STICKKEYS[k][1]; }
    }
    const n = Math.hypot(x, y) || 1;
    keyStick.x = x / n; keyStick.y = y / n;
    if (root) recompute();
  }

  window.GhostControls = {
    BTN,
    state,
    normalize,
    get layout() { return layout; },
    get mode() { return mode; },
    get variant() { return variant; },
    mount(el, cb) {
      root = el;
      onChange = cb;
      root.addEventListener('touchstart', onTouch, { passive: false });
      root.addEventListener('touchmove', onTouch, { passive: false });
      root.addEventListener('touchend', onTouch, { passive: false });
      root.addEventListener('touchcancel', onTouch, { passive: false });
      root.addEventListener('pointerdown', onMouse);
      window.addEventListener('pointermove', onMouse);
      window.addEventListener('pointerup', onMouse);
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKey);
      window.addEventListener('blur', () => { keysDown.clear(); recomputeKeys(); });
      window.addEventListener('resize', measure);
      render();
    },
    // Swap to a layout sent by the PC (falls back to the full Xbox layout).
    load(raw, opts = {}) {
      layout = normalize(raw, opts.resolve) || normalize(DEFAULT_LAYOUT);
      lastScene = ''; lastP2 = '';
      if (opts.mode !== undefined) mode = opts.mode;
      if (opts.variant !== undefined) variant = opts.variant;
      render();
      if (gameState) this.setGameState(gameState);
      return layout;
    },
    setMode(m) { mode = m; render(); },
    setVariant(v) { variant = v; render(); },
    set onAuto(fn) { onAuto = fn; },
    // Live values from the game mod. Follows the game's scene and character when the layout maps them.
    setGameState(gs) {
      gameState = gs && Object.keys(gs).length ? gs : null;
      let redraw = false;
      if (gameState && gameState.scene && gameState.scene !== lastScene) {
        lastScene = gameState.scene;
        const m = layout.gameModes[lastScene];
        if (m && m !== mode) { mode = m; redraw = true; onAuto('mode', m); }
      }
      if (gameState && gameState.p2 && gameState.p2 !== lastP2) {
        lastP2 = gameState.p2;
        const v = layout.gameVariants[lastP2];
        if (v && v !== variant) { variant = v; redraw = true; onAuto('variant', v); }
      }
      if (showKey(layout, gameState) !== lastShow) redraw = true; // e.g. the bomb just got unlocked
      if (redraw) render(); else if (root) applyState(root, layout, variant, gameState);
    },
    get gameState() { return gameState; },
    // Static drawing for the PC Control Creator: no touch handling.
    preview(el, raw, opts = {}) {
      const l = normalize(raw, opts.resolve) || normalize(DEFAULT_LAYOUT);
      let m = opts.mode || '';
      if (m && !l.modes.includes(m)) m = '';
      const v = opts.variant || (l.variants ? l.variants.options[0] : '');
      el.innerHTML = buildHtml(l, m, v, opts.state || null, !!opts.everyCharacter); // the creator shows one-character buttons too
      if (opts.state) applyState(el, l, v, opts.state);
      return l;
    },
    measure,
    reset() {
      for (const it of items) { if (it.c.type === 'stick') releaseStick(it); it.latched = false; }
      owners.clear(); btnTouches.clear(); keysDown.clear(); keyMask = 0; keyStick.x = 0; keyStick.y = 0;
      if (root) recompute();
    },
  };
})();
