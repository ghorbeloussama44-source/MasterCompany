(() => {
  'use strict';
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;

  const smooth = $('#smooth');
  const S = { y: 0, target: 0, vel: 0, W: innerWidth, H: innerHeight, mx: .5, my: .5, sx: .5, sy: .5, docH: 0 };
  root.classList.add('is-loading');

  /* ---------- text splitting ---------- */
  $$('[data-split]').forEach(el => {
    const walk = node => {
      [...node.childNodes].forEach(n => {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach(t => {
            if (!t) return;
            if (/^\s+$/.test(t)) return frag.append(' ');
            const w = document.createElement('span'); w.className = 'w';
            const i = document.createElement('span'); i.textContent = t; w.append(i); frag.append(w);
          });
          n.replaceWith(frag);
        } else if (n.nodeType === 1 && n.tagName !== 'BR') walk(n);
      });
    };
    walk(el);
    $$('.w', el).forEach((w, i) => w.style.setProperty('--i', i));
  });
  $$('[data-chars]').forEach(el => {
    const t = el.textContent; el.setAttribute('aria-hidden', 'true'); el.textContent = '';
    [...t].forEach((c, i) => { const s = document.createElement('span'); s.className = 'ch'; s.style.setProperty('--i', i); s.textContent = c; el.append(s); });
  });
  const scrub = $('[data-scrub]');
  let scrubWords = [];
  if (scrub) {
    const t = scrub.textContent.trim(); scrub.textContent = '';
    t.split(/\s+/).forEach(w => { const s = document.createElement('span'); s.className = 'sw'; s.textContent = w + ' '; scrub.append(s); scrubWords.push(s); });
  }

  /* ---------- WebGL ---------- */
  let gl = null; // { renderer, scene, camera, bg, items }
  const items = [];
  const heroEl = $('.hero__media');

  const VERT = `
    varying vec2 vUv; uniform float uVel;
    void main(){
      vUv = uv; vec3 p = position;
      p.y -= sin(uv.x * 3.14159) * uVel * 0.06;
      p.z += sin(uv.y * 3.14159) * abs(uVel) * 0.0;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }`;
  const FRAG_IMG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTex; uniform vec2 uImg, uPlane, uMouse;
    uniform float uPar, uHover, uTime, uVel, uReveal, uDim;
    vec2 cover(vec2 uv){
      float ra = uPlane.x/uPlane.y, ri = uImg.x/uImg.y;
      vec2 s = ra > ri ? vec2(1., ri/ra) : vec2(ra/ri, 1.);
      return (uv - .5) * s + .5;
    }
    void main(){
      vec2 uv = vUv;
      vec2 asp = vec2(uPlane.x/uPlane.y, 1.);
      vec2 dv = (uv - uMouse) * asp;
      float d = length(dv);
      float ripple = sin(d * 28. - uTime * 3.) * smoothstep(.55, 0., d) * uHover;
      uv += normalize(dv + 1e-4) * ripple * .012;
      uv += vec2(sin(uv.y*6.+uTime*.6), cos(uv.x*6.+uTime*.5)) * .002;
      // reveal wipe from the bottom with wavy edge
      float edge = uReveal * 1.3 - .15 + sin(vUv.x * 6. + uTime) * .03;
      float a = smoothstep(vUv.y - .12, vUv.y, edge);
      float z = mix(1.35, 1.0, uReveal);
      vec2 c = cover(uv);
      c = (c - .5) / (1.14 * z) + .5;
      c.y += uPar * .06;
      float sp = abs(uVel) * .0009 + uHover * .004;
      vec3 col = vec3(
        texture2D(uTex, c + vec2(sp, 0.)).r,
        texture2D(uTex, c).g,
        texture2D(uTex, c - vec2(sp, 0.)).b);
      vec2 px = vec2(1.) / (uPlane * 2.0);
      vec3 blur = (texture2D(uTex, c + vec2(px.x, 0.)).rgb + texture2D(uTex, c - vec2(px.x, 0.)).rgb + texture2D(uTex, c + vec2(0., px.y)).rgb + texture2D(uTex, c - vec2(0., px.y)).rgb) * .25;
      col = clamp(col + (col - blur) * .55, 0., 1.);
      col *= uDim > 0. ? (1. - uDim) + .15 : 1.;
      col *= 1. + uHover * .08;
      gl_FragColor = vec4(col, a);
    }`;
  const FRAG_BG = `
    precision highp float;
    uniform float uTime, uScroll, uVel; uniform vec2 uRes, uMouse;
    float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
      return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p){ float v = 0., a = .5; for(int i=0;i<5;i++){ v += a*n(p); p = p*2.02 + 7.3; a *= .5; } return v; }
    void main(){
      vec2 uv = gl_FragCoord.xy / uRes;
      vec2 p = (uv - .5) * vec2(uRes.x/uRes.y, 1.);
      vec2 m = (uMouse - .5) * vec2(uRes.x/uRes.y, 1.);
      float t = uTime * .06;
      vec2 q = vec2(fbm(p*1.6 + t), fbm(p*1.6 + vec2(5.2, 1.3) - t));
      vec2 r = vec2(fbm(p*2. + 2.*q + vec2(1.7, 9.2) + t*1.5), fbm(p*2. + 2.*q + vec2(8.3, 2.8) - t*1.2));
      float f = fbm(p*1.8 + 2.4*r + uScroll*.00035);
      f += smoothstep(.55, 0., length(p - m)) * .28;
      f += abs(uVel) * .0012;
      vec3 ink = vec3(.016, .016, .022);
      vec3 hot = vec3(.95, .2, .1);
      vec3 cool = vec3(.1, .13, .62);
      vec3 col = mix(ink, cool, smoothstep(.28, .75, f) * .55);
      col = mix(col, hot, smoothstep(.55, 1.05, f + r.x*.25) * .5);
      col *= .62 + .38 * smoothstep(1.1, 0., length(p));
      col += (h(gl_FragCoord.xy + uTime) - .5) * .02;
      gl_FragColor = vec4(col, 1.);
    }`;

  function initGL() {
    if (!window.THREE) throw new Error('three missing');
    const canvas = $('#gl');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(S.W, S.H, false);
    renderer.setClearColor(0x050506, 1);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-S.W / 2, S.W / 2, S.H / 2, -S.H / 2, -1000, 1000);
    camera.position.z = 10;
    const bgMat = new THREE.ShaderMaterial({
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: FRAG_BG, depthTest: false, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uScroll: { value: 0 }, uVel: { value: 0 }, uRes: { value: new THREE.Vector2(S.W * renderer.getPixelRatio(), S.H * renderer.getPixelRatio()) }, uMouse: { value: new THREE.Vector2(.5, .5) } }
    });
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
    bg.frustumCulled = false; bg.renderOrder = -1;
    scene.add(bg);
    gl = { renderer, scene, camera, bg, bgMat, geo: new THREE.PlaneGeometry(1, 1, 24, 24), loader: new THREE.TextureLoader() };
    root.classList.add('gl-on');
  }

  function loadMedia() {
    if (!gl) return Promise.resolve();
    const jobs = $$('.media[data-gl]').map(el => new Promise(resolve => {
      const img = $('img', el);
      const url = img.currentSrc || img.src;
      gl.loader.load(url, tex => {
        tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = gl.renderer.capabilities.getMaxAnisotropy();
        const mat = new THREE.ShaderMaterial({
          vertexShader: VERT, fragmentShader: FRAG_IMG, transparent: true,
          uniforms: {
            uTex: { value: tex }, uImg: { value: new THREE.Vector2(tex.image.width, tex.image.height) },
            uPlane: { value: new THREE.Vector2(1, 1) }, uMouse: { value: new THREE.Vector2(.5, .5) },
            uPar: { value: 0 }, uHover: { value: 0 }, uTime: { value: 0 }, uVel: { value: 0 },
            uReveal: { value: el === heroEl ? 0 : 0 }, uDim: { value: parseFloat(el.dataset.dim || 0) }
          }
        });
        const mesh = new THREE.Mesh(gl.geo, mat);
        mesh.visible = false; gl.scene.add(mesh);
        items.push({ el, mesh, mat, top: 0, left: 0, w: 1, h: 1, hover: 0, hoverT: 0, reveal: 0, revealT: el === heroEl ? 0 : 0, mx: .5, my: .5, inView: false, isHero: el === heroEl });
        resolve();
      }, undefined, () => { el.removeAttribute('data-gl'); resolve(); });
    }));
    return Promise.all(jobs);
  }

  /* ---------- measuring ---------- */
  const speedEls = $$('[data-speed]').map(el => ({ el, speed: parseFloat(el.dataset.speed), top: 0, h: 0 }));
  const scrubBox = { top: 0, h: 0 };
  function measure() {
    S.W = innerWidth; S.H = innerHeight;
    smooth.style.transform = 'none';
    speedEls.forEach(o => o.el.style.transform = '');
    S.docH = smooth.getBoundingClientRect().height;
    document.body.style.height = S.docH + 'px';
    speedEls.forEach(o => { const r = o.el.getBoundingClientRect(); o.top = r.top; o.h = r.height; });
    items.forEach(it => { const r = it.el.getBoundingClientRect(); it.top = r.top; it.left = r.left; it.w = r.width; it.h = r.height; it.mat.uniforms.uPlane.value.set(r.width, r.height); });
    if (scrub) { const r = scrub.getBoundingClientRect(); scrubBox.top = r.top; scrubBox.h = r.height; }
    if (gl) {
      gl.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      gl.renderer.setSize(S.W, S.H, false);
      const c = gl.camera; c.left = -S.W / 2; c.right = S.W / 2; c.top = S.H / 2; c.bottom = -S.H / 2; c.updateProjectionMatrix();
      const pr = gl.renderer.getPixelRatio(); gl.bgMat.uniforms.uRes.value.set(S.W * pr, S.H * pr);
    }
  }
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(measure, 120); });
  if ('ResizeObserver' in window) new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(measure, 120); }).observe(smooth);

  /* ---------- input ---------- */
  addEventListener('mousemove', e => { S.mx = e.clientX / S.W; S.my = 1 - e.clientY / S.H; curX = e.clientX; curY = e.clientY; }, { passive: true });
  addEventListener('scroll', () => { S.target = scrollY; }, { passive: true });
  S.target = scrollY;

  const cursor = $('#cursor'), cursorLabel = $('#cursorLabel');
  let curX = S.W / 2, curY = S.H / 2, cx = curX, cy = curY;
  if (fine) root.classList.add('has-cursor');
  $$('[data-cursor="hover"]').forEach(a => {
    a.addEventListener('mouseenter', () => cursor.classList.add('is-hover'));
    a.addEventListener('mouseleave', () => cursor.classList.remove('is-hover'));
  });
  $$('.media').forEach(m => {
    m.addEventListener('mouseenter', () => { cursorLabel.textContent = 'Voir'; cursor.classList.add('is-media'); });
    m.addEventListener('mouseleave', () => cursor.classList.remove('is-media'));
  });
  // magnetic buttons
  const mags = $$('[data-magnetic]');
  mags.forEach(b => {
    b.addEventListener('mousemove', e => {
      const r = b.getBoundingClientRect();
      b.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * .3}px,${(e.clientY - r.top - r.height / 2) * .4}px)`;
    });
    b.addEventListener('mouseleave', () => { b.style.transition = 'transform .6s cubic-bezier(.19,1,.22,1), color .5s, border-color .5s'; b.style.transform = ''; setTimeout(() => b.style.transition = '', 600); });
  });
  // anchor links with smooth scroll
  $$('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
    const id = a.getAttribute('href'); if (id.length < 2) return;
    const t = $(id); if (!t) return;
    e.preventDefault();
    const top = id === '#top' ? 0 : t.getBoundingClientRect().top + S.y;
    scrollTo({ top, behavior: 'auto' });
  }));
  // form
  const form = $('#form');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const d = new FormData(form);
    const body = `Nom: ${d.get('name')}\nEmail: ${d.get('email')}\nTéléphone: ${d.get('phone') || '-'}\n\n${d.get('message') || ''}`;
    $('#formOk').hidden = false;
    location.href = 'mailto:direction@masters.tn?subject=' + encodeURIComponent('Contact depuis le site — ' + d.get('name')) + '&body=' + encodeURIComponent(body);
  });

  /* ---------- reveal observer ---------- */
  const io = new IntersectionObserver(es => es.forEach(en => {
    if (en.isIntersecting) { en.target.classList.add('is-in'); const it = items.find(i => i.el === en.target); if (it) it.revealT = 1; }
  }), { threshold: .15, rootMargin: '0px 0px -8% 0px' });
  const observeAll = () => {
    $$('[data-reveal],[data-split],[data-chars],.media').forEach(el => io.observe(el));
  };

  /* ---------- marquee ---------- */
  const marq = $('#marquee'); let mx = 0, marqHalf = 0;

  /* ---------- main loop ---------- */
  const nav = $('.nav'), prog = $('#progress');
  let last = performance.now(), time = 0, lastY = 0, started = false;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, .05); last = now; time += dt;
    const k = reduce ? 1 : 1 - Math.exp(-7 * dt);
    S.y = lerp(S.y, S.target, k);
    if (Math.abs(S.target - S.y) < .05) S.y = S.target;
    const rawVel = (S.y - lastY) / Math.max(dt, .001); lastY = S.y;
    S.vel = lerp(S.vel, clamp(rawVel, -3000, 3000) / 60, .1);
    S.sx = lerp(S.sx, S.mx, 1 - Math.exp(-6 * dt)); S.sy = lerp(S.sy, S.my, 1 - Math.exp(-6 * dt));

    smooth.style.transform = `translate3d(0,${-S.y}px,0)`;

    // parallax layers
    if (!reduce) speedEls.forEach(o => {
      const c = o.top + o.h / 2 - S.y - S.H / 2;
      if (Math.abs(c) > S.H * 1.5) return;
      o.el.style.transform = `translate3d(0,${-c * o.speed}px,0)`;
    });

    // manifesto scrub
    if (scrubWords.length) {
      const t = scrubBox.top - S.y;
      const p = clamp((S.H * .85 - t) / (S.H * .55 + scrubBox.h * .6), 0, 1) * scrubWords.length * 1.0;
      scrubWords.forEach((w, i) => { w.style.opacity = (.14 + clamp(p - i, 0, 1) * .86).toFixed(3); });
    }

    // marquee
    if (marq) {
      if (!marqHalf) marqHalf = marq.scrollWidth / 2;
      mx -= (1.2 + Math.abs(S.vel) * .35) * (S.vel < -.5 ? -1 : 1) * 60 * dt;
      if (marqHalf) mx = ((mx % marqHalf) - marqHalf) % marqHalf;
      marq.style.transform = `translate3d(${mx}px,0,0) skewX(${clamp(-S.vel * .12, -10, 10)}deg)`;
    }

    // nav + progress
    prog.style.transform = `scaleX(${S.docH > S.H ? clamp(S.y / (S.docH - S.H), 0, 1) : 0})`;
    nav.classList.toggle('is-hidden', S.y > S.H * .5 && rawVel > 40);
    if (rawVel < -40) nav.classList.remove('is-hidden');

    // cursor
    cx = lerp(cx, curX, 1 - Math.exp(-18 * dt)); cy = lerp(cy, curY, 1 - Math.exp(-18 * dt));
    cursor.style.transform = `translate3d(${cx}px,${cy}px,0)`;

    if (gl) {
      const u = gl.bgMat.uniforms;
      u.uTime.value = time; u.uScroll.value = S.y; u.uVel.value = S.vel; u.uMouse.value.set(S.sx, S.sy);
      const hx = curX, hy = curY;
      items.forEach(it => {
        const top = it.top - S.y;
        const vis = top < S.H + 120 && top + it.h > -120;
        it.mesh.visible = vis; if (!vis) return;
        const m = it.mesh, un = it.mat.uniforms;
        m.scale.set(it.w, it.h, 1);
        m.position.set(it.left + it.w / 2 - S.W / 2, S.H / 2 - (top + it.h / 2), 0);
        // parallax inside frame (accounts for the CSS data-speed offset applied to the wrapper)
        const rect = it.el.getBoundingClientRect();
        m.position.set(rect.left + rect.width / 2 - S.W / 2, S.H / 2 - (rect.top + rect.height / 2), 0);
        m.scale.set(rect.width, rect.height, 1);
        un.uPar.value = clamp((rect.top + rect.height / 2 - S.H / 2) / (S.H / 2 + rect.height / 2), -1, 1);
        const inside = hx >= rect.left && hx <= rect.right && hy >= rect.top && hy <= rect.bottom;
        it.hoverT = inside ? 1 : 0;
        it.hover = lerp(it.hover, it.hoverT, 1 - Math.exp(-6 * dt));
        if (inside) { it.mx = (hx - rect.left) / rect.width; it.my = 1 - (hy - rect.top) / rect.height; }
        un.uMouse.value.set(lerp(un.uMouse.value.x, it.mx, .2), lerp(un.uMouse.value.y, it.my, .2));
        un.uHover.value = it.hover; un.uTime.value = time; un.uVel.value = S.vel;
        it.reveal = lerp(it.reveal, it.revealT, 1 - Math.exp(-3.2 * dt));
        if (it.isHero && started) it.revealT = 1;
        un.uReveal.value = reduce ? it.revealT : it.reveal;
      });
      gl.renderer.render(gl.scene, gl.camera);
    }
  }

  /* ---------- boot ---------- */
  try { initGL(); } catch (err) { gl = null; root.classList.remove('gl-on'); }
  const fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  const countEl = $('#loaderCount'), loader = $('#loader');
  let shown = 0, targetPct = 8;
  const tick = setInterval(() => { shown = lerp(shown, targetPct, .12); countEl.textContent = Math.round(shown); }, 30);
  const minWait = new Promise(r => setTimeout(r, reduce ? 200 : 1300));

  const mediaP = loadMedia().then(() => { targetPct = 90; });
  Promise.all([mediaP, fontsReady.catch(() => 0), minWait]).then(() => {
    targetPct = 100;
    measure();
    return new Promise(r => setTimeout(r, 350));
  }).then(() => {
    clearInterval(tick); countEl.textContent = '100';
    loader.classList.add('is-done');
    root.classList.remove('is-loading');
    started = true;
    observeAll();
    measure();
    setTimeout(() => loader.remove(), 1400);
  });
  // hero reveal must wait until the curtain lifts: mark hero text on start
  document.addEventListener('DOMContentLoaded', () => {});
  requestAnimationFrame(frame);
})();
