'use strict';
// Spell effects on a full-window canvas, plus the slow embers behind the interface.
// Everything respects prefers-reduced-motion: effects become a no-op and the actions still work.

const FX = (() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canvas = document.getElementById('fx');
  const ctx = canvas.getContext('2d');
  const COLORS = {
    gold: ['#fff1c4', '#f5d98b', '#d6a548'],
    heal: ['#d9ffd9', '#6dc77a', '#2f8a4a'],
    arcane: ['#e2eeff', '#72aaff', '#3a5ec2'],
    ember: ['#ffe3b5', '#e8742c', '#a12c10'],
    ruby: ['#ffc7c7', '#ee5a5a', '#8a1a1f'],
  };
  const RUNES = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ';

  const effects = [];
  let running = false;
  let dpr = 1;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
  }
  addEventListener('resize', resize);
  resize();

  function start() {
    if (running) return;
    running = true;
    requestAnimationFrame(frame);
  }

  function frame(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      const t = (now - e.start) / e.duration;
      if (t >= 1) {
        effects.splice(i, 1);
        if (e.done) e.done();
      } else if (t >= 0) {
        e.draw(ctx, t, now);
      }
    }
    if (effects.length) {
      requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      running = false;
    }
  }

  function add(duration, draw, delay = 0, done) {
    if (reduced) {
      if (done) done();
      return;
    }
    effects.push({ start: performance.now() + delay, duration, draw, done });
    start();
  }

  const easeOut = (t) => 1 - (1 - t) ** 3;

  function sparks(x, y, palette, count, spread, upward = 0) {
    const list = Array.from({ length: count }, () => {
      const a = Math.random() * Math.PI * 2;
      const v = spread * (0.35 + Math.random() * 0.65);
      return { dx: Math.cos(a) * v, dy: Math.sin(a) * v - upward * Math.random(), r: 1 + Math.random() * 2.4, c: palette[Math.floor(Math.random() * palette.length)] };
    });
    add(900, (c, t) => {
      const p = easeOut(t);
      c.globalCompositeOperation = 'lighter';
      for (const s of list) {
        c.globalAlpha = (1 - t) ** 1.5;
        c.fillStyle = s.c;
        c.beginPath();
        c.arc(x + s.dx * p, y + s.dy * p + 30 * t * t, s.r * (1 - t * 0.5), 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
    });
  }

  /** A rune circle that opens at x, y and spins out: the base of every spell. */
  function runeCircle(x, y, kind = 'gold', radius = 70) {
    const [light, mid] = COLORS[kind] || COLORS.gold;
    const glyphs = Array.from({ length: 12 }, () => RUNES[Math.floor(Math.random() * RUNES.length)]);
    add(1000, (c, t) => {
      const open = easeOut(Math.min(1, t * 2));
      const alpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      const r = radius * open;
      c.save();
      c.translate(x, y);
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha = alpha;
      c.shadowColor = mid;
      c.shadowBlur = 14;
      c.strokeStyle = light;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = mid;
      c.lineWidth = 1;
      c.beginPath();
      c.arc(0, 0, r * 0.72, 0, Math.PI * 2);
      c.stroke();
      c.rotate(t * 2.4);
      c.beginPath();
      for (let i = 0; i <= 3; i++) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r * 0.72, Math.sin(a) * r * 0.72);
      }
      c.stroke();
      c.rotate(-t * 4.2);
      c.fillStyle = light;
      c.font = `${Math.max(9, r * 0.2)}px serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      glyphs.forEach((g, i) => {
        const a = (i / glyphs.length) * Math.PI * 2;
        c.save();
        c.rotate(a);
        c.translate(0, -r * 0.86);
        c.fillText(g, 0, 0);
        c.restore();
      });
      c.restore();
    });
    sparks(x, y, COLORS[kind] || COLORS.gold, 26, radius * 1.4, 30);
  }

  /** Column of light, for healing and revival. */
  function pillar(x, y, kind = 'heal') {
    const [light, mid] = COLORS[kind] || COLORS.heal;
    runeCircle(x, y, kind, 56);
    add(1100, (c, t) => {
      const alpha = Math.sin(t * Math.PI);
      const w = 44 * alpha;
      const g = c.createLinearGradient(0, y - 220, 0, y + 30);
      g.addColorStop(0, 'transparent');
      g.addColorStop(0.6, mid);
      g.addColorStop(1, light);
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha = alpha * 0.6;
      c.fillStyle = g;
      c.fillRect(x - w / 2, y - 220, w, 250);
      c.restore();
    });
  }

  /** An icon flies along an arc with a trail of sparks, then lands in a burst. */
  function flyIcon(src, from, to, kind = 'gold') {
    const palette = COLORS[kind] || COLORS.gold;
    const img = new Image();
    img.src = src;
    const lift = Math.min(180, 60 + Math.hypot(to.x - from.x, to.y - from.y) * 0.25);
    const trail = [];
    add(760, (c, t) => {
      const p = easeOut(t) * 0.35 + t * t * 0.65;
      const x = from.x + (to.x - from.x) * p;
      const y = from.y + (to.y - from.y) * p - Math.sin(p * Math.PI) * lift;
      trail.push({ x, y, life: 1 });
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (const s of trail) {
        s.life -= 0.05;
        if (s.life <= 0) continue;
        c.globalAlpha = s.life * 0.6;
        c.fillStyle = palette[1];
        c.beginPath();
        c.arc(s.x, s.y, 7 * s.life, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
      const size = 56 * (1 - t * 0.45);
      c.save();
      c.shadowColor = palette[1];
      c.shadowBlur = 18;
      c.translate(x, y);
      c.rotate(t * 1.5);
      if (img.complete && img.naturalWidth) c.drawImage(img, -size / 2, -size / 2, size, size);
      c.restore();
    }, 0, () => runeCircle(to.x, to.y, kind, 42));
  }

  /** Summoning circle that glows red and throws the creature's emblem outward. */
  function summon(x, y) {
    runeCircle(x, y, 'ruby', 86);
    add(900, (c, t) => {
      const alpha = Math.sin(t * Math.PI);
      const g = c.createRadialGradient(x, y, 0, x, y, 120);
      g.addColorStop(0, '#ee5a5a');
      g.addColorStop(1, 'transparent');
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha = alpha * 0.55;
      c.fillStyle = g;
      c.fillRect(x - 120, y - 120, 240, 240);
      c.restore();
    });
  }

  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  return { reduced, runeCircle, pillar, flyIcon, summon, center, COLORS };
})();

/* Embers drifting up behind the interface. */
(() => {
  if (FX.reduced) return;
  const canvas = document.getElementById('embers');
  const ctx = canvas.getContext('2d');
  const COUNT = 34;
  let w = 0;
  let h = 0;
  const spawn = (anywhere) => ({
    x: Math.random() * w,
    y: anywhere ? Math.random() * h : h + 10,
    r: 0.6 + Math.random() * 1.6,
    v: 8 + Math.random() * 22,
    sway: Math.random() * 6.28,
    glow: 0.25 + Math.random() * 0.55,
  });
  function resize() {
    w = innerWidth;
    h = innerHeight;
    canvas.width = w;
    canvas.height = h;
  }
  addEventListener('resize', resize);
  resize();
  const list = Array.from({ length: COUNT }, () => spawn(true));
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!document.hidden) {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        e.y -= e.v * dt;
        e.sway += dt;
        e.x += Math.sin(e.sway) * 6 * dt;
        if (e.y < -10) {
          list[i] = spawn(false);
          continue;
        }
        ctx.globalAlpha = e.glow * Math.min(1, e.y / (h * 0.3) + 0.15);
        ctx.fillStyle = '#e8742c';
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
