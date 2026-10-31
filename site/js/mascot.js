/*
 * Friday the duck for the landing page — a faithful port of apps/ui/src/mascot/svg.ts and
 * apps/ui/src/mascot/accessories.ts (same paths, palette, six states, six accessories), built
 * with the same createElementNS builder that passes the desktop app's Trusted Types policy.
 * A light driver adds what the page needs: pointer gaze, a spring hop on click (the app's
 * triggerImpulse), and state changes with the app's status tints. Zero emojis.
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  var FRIDAY_PALETTE = {
    bodyTop: '#FFE766',
    bodyBase: '#FFDB3F',
    bodyBottom: '#F2B91A',
    beakTop: '#FFBE3A',
    beakBottom: '#F29A10',
    beakLine: '#B65E00',
    ink: '#0E2A68',
  };

  var STATE_TINTS = {
    idle: '#94A3B8',
    thinking: '#F59E0B',
    tool_execution: '#06B6D4',
    success: '#10B981',
    error: '#EF4444',
    sleep: '#64748B',
  };

  var FRIDAY_VIEWBOX = '0 0 120 120';
  var FRIDAY_PIVOT_BODY = { x: 60, y: 110 };
  var FRIDAY_PIVOT_SQUASH = { x: 64, y: 116 };

  /** Head and shoulders of the duck: one symmetric silhouette on the 120 x 120 grid. */
  var DUCK_BODY_PATH =
    'M 60 20 C 82 20 100 36 102 58 C 103 70 99 80 94 88 C 98 98 99 110 100 120 L 20 120 C 21 110 22 98 26 88 C 21 80 17 70 18 58 C 20 36 38 20 60 20 Z';

  /** The two soft bumps of the tuft, a bigger one and a smaller one beside it. */
  var DUCK_TUFT_PATH =
    'M 49 26 C 47 14 55 7 62 9 C 68 11 68 19 66 26 Z M 64 28 C 63 20 68 15 74 17 C 80 19 80 26 76 31 Z';

  function toCanonicalState(state) {
    if (!state) return 'idle';
    var normalized = String(state).toLowerCase().trim();
    switch (normalized) {
      case 'thinking':
      case 'question':
        return 'thinking';
      case 'tool_execution':
      case 'working':
      case 'searching':
        return 'tool_execution';
      case 'success':
      case 'approval':
      case 'finished':
        return 'success';
      case 'error':
      case 'alert':
      case 'failed':
        return 'error';
      case 'sleep':
      case 'sleeping':
      case 'halted':
      case 'paused':
        return 'sleep';
      default:
        return 'idle';
    }
  }

  /* ---- accessories (port of apps/ui/src/mascot/accessories.ts) --------------------------------- */

  function renderRearAccessories(accessories, ctx) {
    var parts = [];
    if (accessories.indexOf('headphones') !== -1) {
      parts.push(
        '<g id="' + ctx.idPrefix + 'headphones-rear">' +
          '<path d="M 16 64 C 14 6, 106 6, 104 64" stroke="#94A3B8" stroke-width="3.5" stroke-linecap="round" fill="none"/>' +
          '<path d="M 16 64 C 14 6, 106 6, 104 64" stroke="#475569" stroke-width="1.2" stroke-linecap="round" fill="none"/>' +
        '</g>'
      );
    }
    if (accessories.indexOf('hat') !== -1) {
      parts.push(
        '<g id="' + ctx.idPrefix + 'hat-rear">' +
          '<path d="M 28 36 C 28 16, 44 8, 60 8 C 76 8, 92 16, 92 36 Z" fill="#242831"/>' +
        '</g>'
      );
    }
    if (parts.length === 0) return '';
    return '<g id="' + ctx.idPrefix + 'accessories-rear">' + parts.join('') + '</g>';
  }

  function renderFrontAccessories(accessories, ctx) {
    var parts = [];
    if (accessories.indexOf('hat') !== -1) {
      parts.push(
        '<g id="' + ctx.idPrefix + 'accessory-hat">' +
          '<path d="M 30 34 C 30 18, 44 10, 60 10 C 76 10, 90 18, 90 34 C 80 31, 70 30, 60 30 C 50 30, 40 31, 30 34 Z" fill="#333A48"/>' +
          '<line x1="45" y1="15" x2="44" y2="30" stroke="#475569" stroke-width="0.8" stroke-linecap="round"/>' +
          '<line x1="53" y1="11" x2="53" y2="30" stroke="#475569" stroke-width="0.8" stroke-linecap="round"/>' +
          '<line x1="60" y1="10" x2="60" y2="30" stroke="#475569" stroke-width="0.8" stroke-linecap="round"/>' +
          '<line x1="67" y1="11" x2="67" y2="30" stroke="#475569" stroke-width="0.8" stroke-linecap="round"/>' +
          '<line x1="75" y1="15" x2="76" y2="30" stroke="#475569" stroke-width="0.8" stroke-linecap="round"/>' +
          '<path d="M 26 41 C 44 36, 76 36, 94 41 C 95 35, 94 32, 91 30 C 76 27, 44 27, 29 30 C 26 33, 25 37, 26 41 Z" fill="#242831" stroke="#475569" stroke-width="0.8"/>' +
          '<circle cx="60" cy="8" r="4" fill="#242831" stroke="#333A48" stroke-width="0.75"/>' +
        '</g>'
      );
    }
    if (accessories.indexOf('sunglasses') !== -1) {
      parts.push(
        '<g id="' + ctx.idPrefix + 'accessory-sunglasses">' +
          '<g opacity="0.25"><rect x="29" y="47" width="26" height="18" rx="5" fill="#000000"/><rect x="65" y="47" width="26" height="18" rx="5" fill="#000000"/></g>' +
          '<path d="M 54 53 Q 60 51, 66 53" stroke="#18181B" stroke-width="3" stroke-linecap="round" fill="none"/>' +
          '<rect x="28" y="45" width="27" height="18" rx="5" fill="#18181B"/>' +
          '<rect x="30" y="47" width="23" height="14" rx="3.2" fill="#27272A"/>' +
          '<line x1="46" y1="49" x2="37" y2="59" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" opacity="0.45"/>' +
          '<line x1="50" y1="50" x2="47" y2="54" stroke="#FFFFFF" stroke-width="1.2" stroke-linecap="round" opacity="0.3"/>' +
          '<rect x="65" y="45" width="27" height="18" rx="5" fill="#18181B"/>' +
          '<rect x="67" y="47" width="23" height="14" rx="3.2" fill="#27272A"/>' +
          '<line x1="83" y1="49" x2="74" y2="59" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" opacity="0.45"/>' +
          '<line x1="87" y1="50" x2="84" y2="54" stroke="#FFFFFF" stroke-width="1.2" stroke-linecap="round" opacity="0.3"/>' +
        '</g>'
      );
    }
    if (accessories.indexOf('headphones') !== -1) {
      var halo = ctx.tint || STATE_TINTS.idle;
      parts.push(
        '<g id="' + ctx.idPrefix + 'accessory-headphones-front">' +
          '<g id="' + ctx.idPrefix + 'headphone-cup-left">' +
            '<rect x="9" y="52" width="13" height="24" rx="6.5" fill="#1E222A" stroke="#475569" stroke-width="1"/>' +
            '<rect x="11.5" y="55" width="8" height="18" rx="4" fill="none" stroke="' + halo + '" stroke-width="1.5" opacity="0.85"/>' +
          '</g>' +
          '<g id="' + ctx.idPrefix + 'headphone-cup-right">' +
            '<rect x="98" y="52" width="13" height="24" rx="6.5" fill="#1E222A" stroke="#475569" stroke-width="1"/>' +
            '<rect x="100.5" y="55" width="8" height="18" rx="4" fill="none" stroke="' + halo + '" stroke-width="1.5" opacity="0.85"/>' +
          '</g>' +
        '</g>'
      );
    }
    if (accessories.indexOf('laptop') !== -1) {
      var glow = ctx.tint || STATE_TINTS.tool_execution;
      parts.push(
        '<g id="' + ctx.idPrefix + 'accessory-laptop" transform="translate(0 10)">' +
          '<g id="' + ctx.idPrefix + 'laptop-display">' +
            '<rect x="36" y="72" width="48" height="24" rx="2" fill="#1E2024" stroke="#4B5563" stroke-width="0.75"/>' +
            '<rect x="38" y="74" width="44" height="20" rx="1" fill="#0F1115"/>' +
            '<rect x="39" y="75" width="42" height="18" rx="0.5" fill="' + glow + '" opacity="0.12"/>' +
            '<rect x="42" y="78" width="14" height="1.8" rx="0.5" fill="' + glow + '" opacity="0.9"/>' +
            '<rect x="58" y="78" width="10" height="1.8" rx="0.5" fill="#94A3B8" opacity="0.6"/>' +
            '<rect x="44" y="82" width="22" height="1.8" rx="0.5" fill="#E2E8F0" opacity="0.75"/>' +
            '<rect x="44" y="86" width="16" height="1.8" rx="0.5" fill="' + glow + '" opacity="0.85"/>' +
            '<rect x="42" y="90" width="8" height="1.8" rx="0.5" fill="#10B981" opacity="0.8"/>' +
          '</g>' +
          '<g id="' + ctx.idPrefix + 'laptop-base">' +
            '<path d="M 32 96 L 88 96 L 85 104 L 35 104 Z" fill="#2E333D" stroke="#4B5563" stroke-width="0.75"/>' +
            '<rect x="54" y="99" width="12" height="3" rx="0.75" fill="#1E222A" opacity="0.8"/>' +
            '<ellipse cx="60" cy="104.5" rx="26" ry="1.5" fill="#000000" opacity="0.3"/>' +
          '</g>' +
        '</g>'
      );
    }
    if (parts.length === 0) return '';
    return '<g id="' + ctx.idPrefix + 'accessories-front">' + parts.join('') + '</g>';
  }

  function restingWing(ctx) {
    return (
      '<g id="' + ctx.idPrefix + 'paw-left">' +
        '<path d="M 14 120 C 12 104 21 91 38 88 C 51 88 55 100 49 110 C 46 115 45 118 45 120 Z" fill="' + FRIDAY_PALETTE.bodyBase + '" stroke="' + FRIDAY_PALETTE.bodyBottom + '" stroke-width="0.8" stroke-linejoin="round"/>' +
        '<path d="M 22 112 C 24 102 31 96 40 95" stroke="' + FRIDAY_PALETTE.bodyBottom + '" stroke-width="1.1" stroke-linecap="round" fill="none" opacity="0.55"/>' +
      '</g>'
    );
  }

  function wing(ctx, id, cx, cy, rx, ry, angle) {
    return (
      '<g id="' + ctx.idPrefix + id + '">' +
        '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + rx + '" ry="' + ry + '" fill="' + FRIDAY_PALETTE.bodyBase + '" stroke="' + FRIDAY_PALETTE.bodyBottom + '" stroke-width="0.8" transform="rotate(' + angle + ' ' + cx + ' ' + cy + ')"/>' +
      '</g>'
    );
  }

  function renderHands(accessories, ctx) {
    var hasLaptop = accessories.indexOf('laptop') !== -1 || ctx.state === 'tool_execution';
    if (ctx.state === 'success') {
      return wing(ctx, 'paw-left', 16, 76, 7.5, 7, -25) + wing(ctx, 'paw-right', 104, 76, 7.5, 7, 25);
    }
    if (ctx.state === 'thinking') {
      return restingWing(ctx) + wing(ctx, 'paw-right', 90, 80, 6.5, 6, -15);
    }
    if (hasLaptop) {
      return wing(ctx, 'paw-left', 44, 106, 7, 5.2, -10) + wing(ctx, 'paw-right', 76, 105, 7, 5.2, 10);
    }
    return restingWing(ctx);
  }

  function renderCloudThoughts(ctx) {
    return (
      '<g id="' + ctx.idPrefix + 'accessory-cloud-thoughts">' +
        '<circle cx="68" cy="38" r="2.5" fill="rgba(255, 255, 255, 0.85)" stroke="#94A3B8" stroke-width="0.6"/>' +
        '<circle cx="73" cy="31" r="3.5" fill="rgba(255, 255, 255, 0.9)" stroke="#94A3B8" stroke-width="0.6"/>' +
        '<path d="M 79 23 C 77 17, 83 12, 89 14 C 93 10, 101 11, 104 16 C 109 17, 111 23, 108 28 C 110 33, 105 38, 99 36 C 95 39, 87 38, 84 34 C 78 34, 76 28, 79 23 Z" fill="rgba(255, 255, 255, 0.92)" stroke="#94A3B8" stroke-width="0.8"/>' +
        '<circle cx="87" cy="25" r="2" fill="#475569"/>' +
        '<circle cx="94" cy="25" r="2" fill="#475569"/>' +
        '<circle cx="101" cy="25" r="2" fill="#475569"/>' +
      '</g>'
    );
  }

  function renderEffects(state, accessories, ctx) {
    var parts = [];
    if (accessories.indexOf('cloud_thoughts') !== -1 || state === 'thinking') {
      parts.push(renderCloudThoughts(ctx));
    }
    if (state === 'success') {
      parts.push(
        '<g id="' + ctx.idPrefix + 'effects-sparkles">' +
          '<path d="M 88 17 L 89.2 20.8 L 93 22 L 89.2 23.2 L 88 27 L 86.8 23.2 L 83 22 L 86.8 20.8 Z" fill="#10B981"/>' +
          '<path d="M 18 38 L 19 41 L 22 42 L 19 43 L 18 46 L 17 43 L 14 42 L 17 41 Z" fill="#34D399"/>' +
          '<path d="M 104 45 L 104.8 47.2 L 107 48 L 104.8 48.8 L 104 51 L 103.2 48.8 L 101 48 L 103.2 47.2 Z" fill="#6EE7B7"/>' +
        '</g>'
      );
    }
    if (state === 'error') {
      parts.push(
        '<g id="' + ctx.idPrefix + 'effects-sweat" transform="translate(66 -2)">' +
          '<path d="M 24 38 C 22 42, 21 46, 24 49 C 27 51, 30 48, 29 44 C 28 41, 25 39, 24 38 Z" fill="#38BDF8" stroke="#0284C7" stroke-width="0.6" opacity="0.9"/>' +
        '</g>'
      );
    }
    if (state === 'sleep') {
      parts.push(
        '<g id="' + ctx.idPrefix + 'effects-sleep-zzz">' +
          '<path d="M 80 34 L 88 34 L 81 42 L 89 42" stroke="#818CF8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
          '<path d="M 92 21 L 98 21 L 93 27 L 99 27" stroke="#A5B4FC" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
          '<path d="M 101 11 L 105 11 L 102 15 L 106 15" stroke="#C7D2FE" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
        '</g>'
      );
    }
    if (parts.length === 0) return '';
    return '<g id="' + ctx.idPrefix + 'effects">' + parts.join('') + '</g>';
  }

  /* ---- face (port of renderFace in apps/ui/src/mascot/svg.ts) ---------------------------------- */

  function renderFace(state, prefix, gazeYaw, gazePitch) {
    var gazeX = (gazeYaw * 4).toFixed(1);
    var gazeY = (gazePitch * 4).toFixed(1);
    var ink = FRIDAY_PALETTE.ink;
    var line = FRIDAY_PALETTE.beakLine;

    function oval(rx, ry, cy, extra) {
      cy = cy === undefined ? 55 : cy;
      extra = extra || '';
      return (
        '<ellipse id="' + prefix + 'eye-left" cx="42" cy="' + cy + '" rx="' + rx + '" ry="' + ry + '" fill="' + ink + '"' + extra + '/>' +
        '<ellipse id="' + prefix + 'eye-right" cx="78" cy="' + cy + '" rx="' + rx + '" ry="' + ry + '" fill="' + ink + '"' + extra + '/>' +
        '<circle cx="' + (42 - rx * 0.28).toFixed(1) + '" cy="' + (cy - ry * 0.34).toFixed(1) + '" r="' + (rx * 0.4).toFixed(1) + '" fill="#FFFFFF"/>' +
        '<circle cx="' + (78 - rx * 0.28).toFixed(1) + '" cy="' + (cy - ry * 0.34).toFixed(1) + '" r="' + (rx * 0.4).toFixed(1) + '" fill="#FFFFFF"/>'
      );
    }

    var beak =
      '<ellipse id="' + prefix + 'beak" cx="60" cy="70" rx="15" ry="9.5" fill="url(#' + prefix + 'beak-grad)"/>' +
      '<ellipse cx="55" cy="66" rx="6" ry="2.4" fill="#FFFFFF" opacity="0.28"/>';

    var eyesMarkup = '';
    var mouthMarkup = '';

    switch (state) {
      case 'thinking':
        eyesMarkup = oval(5.2, 6.6, 54);
        mouthMarkup = '<ellipse id="' + prefix + 'mouth" cx="60" cy="72" rx="2.6" ry="2.2" fill="' + line + '"/>';
        break;
      case 'tool_execution':
        eyesMarkup = oval(5.2, 6.4, 56);
        mouthMarkup =
          '<path id="' + prefix + 'mouth" d="M 54 72 Q 60 73.5 66 72" stroke="' + line + '" stroke-width="1.7" stroke-linecap="round" fill="none"/>';
        break;
      case 'success':
        eyesMarkup =
          '<path id="' + prefix + 'eye-left" d="M 36 58 Q 42 49 48 58" stroke="' + ink + '" stroke-width="3" stroke-linecap="round" fill="none"/>' +
          '<path id="' + prefix + 'eye-right" d="M 72 58 Q 78 49 84 58" stroke="' + ink + '" stroke-width="3" stroke-linecap="round" fill="none"/>';
        mouthMarkup =
          '<path id="' + prefix + 'mouth" d="M 51 69 Q 60 82 69 69 Z" fill="' + line + '"/>' +
          '<path d="M 55 74 Q 60 78 65 74 Z" fill="#F43F5E"/>';
        break;
      case 'error':
        eyesMarkup = oval(6.6, 8.6, 54);
        mouthMarkup =
          '<path id="' + prefix + 'mouth" d="M 52 72 Q 55.5 69.5 60 72 Q 64.5 74.5 68 72" stroke="' + line + '" stroke-width="1.7" stroke-linecap="round" fill="none"/>';
        break;
      case 'sleep':
        eyesMarkup =
          '<path id="' + prefix + 'eye-left" d="M 36 56 Q 42 62 48 56" stroke="' + ink + '" stroke-width="2.8" stroke-linecap="round" fill="none"/>' +
          '<path id="' + prefix + 'eye-right" d="M 72 56 Q 78 62 84 56" stroke="' + ink + '" stroke-width="2.8" stroke-linecap="round" fill="none"/>';
        mouthMarkup =
          '<path id="' + prefix + 'mouth" d="M 56 72 Q 60 73.6 64 72" stroke="' + line + '" stroke-width="1.5" stroke-linecap="round" fill="none"/>';
        break;
      default:
        eyesMarkup = oval(5.6, 7.4);
        mouthMarkup =
          '<path id="' + prefix + 'mouth" d="M 53.5 71.5 Q 60 76 66.5 71.5" stroke="' + line + '" stroke-width="1.7" stroke-linecap="round" fill="none"/>';
        break;
    }

    return (
      '<g id="' + prefix + 'face" transform="translate(' + gazeX + ', ' + gazeY + ')">' +
        '<g id="' + prefix + 'eyes">' + eyesMarkup + '</g>' +
        beak +
        mouthMarkup +
      '</g>'
    );
  }

  function escapeXml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unescapeXml(t) {
    return t.replace(/&(amp|lt|gt|quot|apos);/g, function (_, n) {
      return ENTITIES[n];
    });
  }

  /* ---- the renderer (port of renderFridaySvgString in apps/ui/src/mascot/svg.ts) ---------------- */

  function renderFridaySvgString(options) {
    options = options || {};
    var state = toCanonicalState(options.state);
    var requested = options.accessories || [];
    var accessories = state === 'tool_execution' && requested.indexOf('laptop') === -1 ? requested.concat(['laptop']) : requested;
    var tint = options.tint || STATE_TINTS[state];
    var prefix = options.idPrefix || 'friday-';
    var pose = options.pose || {};

    var bodyX = pose.bodyX || 0;
    var bodyY = pose.bodyY || 0;
    var scaleX = pose.scaleX || 1.0;
    var scaleY = pose.scaleY || 1.0;
    var tilt = pose.tilt || 0;
    var gazeYaw = pose.gazeYaw !== undefined ? pose.gazeYaw : state === 'thinking' ? 0.35 : 0;
    var gazePitch =
      pose.gazePitch !== undefined ? pose.gazePitch : state === 'tool_execution' ? 0.4 : state === 'thinking' ? -0.3 : 0;
    var shadowScale = pose.shadowScale || 1.0;

    var titleText = options.title || 'Friday Mascot - ' + state;
    var descText = options.description || 'Yellow duck companion mascot, head and shoulders, standing straight';
    var titleId = prefix + 'title';
    var descId = prefix + 'desc';
    var dimAttrs = options.size !== undefined ? 'width="' + options.size + '" height="' + options.size + '"' : 'width="100%" height="100%"';
    var classAttr = options.className
      ? 'class="friday-mascot friday-state-' + state + ' ' + options.className + '"'
      : 'class="friday-mascot friday-state-' + state + '"';

    var accessoryCtx = {
      idPrefix: prefix,
      tint: tint,
      state: state,
      hasLaptop: accessories.indexOf('laptop') !== -1 || state === 'tool_execution',
    };

    var rearAccessoriesMarkup = renderRearAccessories(accessories, accessoryCtx);
    var frontAccessoriesMarkup = renderFrontAccessories(accessories, accessoryCtx);
    var handsMarkup = renderHands(accessories, accessoryCtx);
    var effectsMarkup = renderEffects(state, accessories, accessoryCtx);
    var faceMarkup = renderFace(state, prefix, gazeYaw, gazePitch);

    return (
      '<svg xmlns="http://www.w3.org/2000/svg"\n' +
      '   viewBox="' + FRIDAY_VIEWBOX + '"\n' +
      '   ' + dimAttrs + '\n' +
      '   ' + classAttr + '\n' +
      '   role="img"\n' +
      '   aria-labelledby="' + titleId + ' ' + descId + '"\n' +
      '   id="' + prefix + 'root"\n' +
      '   style="--friday-status-tint: ' + tint + '; overflow: visible;">\n' +
      '<title id="' + titleId + '">' + escapeXml(titleText) + '</title>\n' +
      '<desc id="' + descId + '">' + escapeXml(descText) + '</desc>\n' +
      '\n' +
      '<defs>\n' +
      '  <linearGradient id="' + prefix + 'body-grad" gradientUnits="userSpaceOnUse" x1="44" y1="8" x2="76" y2="120">\n' +
      '    <stop offset="0%" stop-color="' + FRIDAY_PALETTE.bodyTop + '"/>\n' +
      '    <stop offset="55%" stop-color="' + FRIDAY_PALETTE.bodyBase + '"/>\n' +
      '    <stop offset="100%" stop-color="' + FRIDAY_PALETTE.bodyBottom + '"/>\n' +
      '  </linearGradient>\n' +
      '\n' +
      '  <linearGradient id="' + prefix + 'beak-grad" x1="0%" y1="0%" x2="0%" y2="100%">\n' +
      '    <stop offset="0%" stop-color="' + FRIDAY_PALETTE.beakTop + '"/>\n' +
      '    <stop offset="100%" stop-color="' + FRIDAY_PALETTE.beakBottom + '"/>\n' +
      '  </linearGradient>\n' +
      '\n' +
      '  <radialGradient id="' + prefix + 'halo-grad" cx="50%" cy="50%" r="50%">\n' +
      '    <stop offset="0%" stop-color="' + tint + '" stop-opacity="0.25"/>\n' +
      '    <stop offset="100%" stop-color="' + tint + '" stop-opacity="0"/>\n' +
      '  </radialGradient>\n' +
      '\n' +
      '  <clipPath id="' + prefix + 'body-clip">\n' +
      '    <path d="' + DUCK_BODY_PATH + '"/>\n' +
      '  </clipPath>\n' +
      '\n' +
      '</defs>\n' +
      '\n' +
      '<g id="' + prefix + 'layer-ambient">\n' +
      '  <ellipse id="' + prefix + 'shadow" cx="60" cy="116" rx="' + (36 * shadowScale).toFixed(1) + '" ry="' + (4.5 * shadowScale).toFixed(1) + '" fill="#000000" opacity="' + (0.25 * shadowScale).toFixed(2) + '"/>\n' +
      '  <circle id="' + prefix + 'mood-halo" cx="60" cy="60" r="54" fill="url(#' + prefix + 'halo-grad)"/>\n' +
      '</g>\n' +
      '\n' +
      '<g id="' + prefix + 'pos" transform="translate(' + bodyX + ', ' + bodyY + ')">\n' +
      '  <g id="' + prefix + 'rot" transform="rotate(' + tilt + ' ' + FRIDAY_PIVOT_BODY.x + ' ' + FRIDAY_PIVOT_BODY.y + ')">\n' +
      '    <g id="' + prefix + 'squash" transform="translate(' + FRIDAY_PIVOT_SQUASH.x + ', ' + FRIDAY_PIVOT_SQUASH.y + ') scale(' + scaleX + ', ' + scaleY + ') translate(-' + FRIDAY_PIVOT_SQUASH.x + ', -' + FRIDAY_PIVOT_SQUASH.y + ')">\n' +
      '\n' +
      '      ' + rearAccessoriesMarkup + '\n' +
      '\n' +
      '      <g id="' + prefix + 'body">\n' +
      '        <path id="' + prefix + 'tuft-back" d="' + DUCK_TUFT_PATH + '" fill="url(#' + prefix + 'body-grad)"/>\n' +
      '        <path id="' + prefix + 'body-silhouette" d="' + DUCK_BODY_PATH + '" fill="url(#' + prefix + 'body-grad)"/>\n' +
      '\n' +
      '        <g clip-path="url(#' + prefix + 'body-clip)">\n' +
      '          <ellipse cx="42" cy="38" rx="26" ry="14" fill="#FFFFFF" opacity="0.2" transform="rotate(-18 42 38)"/>\n' +
      '        </g>\n' +
      '      </g>\n' +
      '\n' +
      '      ' + faceMarkup + '\n' +
      '\n' +
      '      ' + handsMarkup + '\n' +
      '\n' +
      '      ' + frontAccessoriesMarkup + '\n' +
      '\n' +
      '    </g>\n' +
      '  </g>\n' +
      '</g>\n' +
      '\n' +
      '  ' + effectsMarkup + '\n' +
      '</svg>'
    );
  }

  /* ---- the builder (port of svgFromMarkup: createElementNS only, styles through the CSSOM) ------ */

  function svgFromMarkup(xml) {
    var token =
      /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:\s+[^\s=/>]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
    var attr = /([^\s=/>]+)\s*=\s*"([^"]*)"/g;
    var root = null;
    var stack = [];
    for (var m = token.exec(xml); m !== null; m = token.exec(xml)) {
      var close = m[1];
      var open = m[2];
      var attrs = m[3];
      var selfClose = m[4];
      var text = m[5];
      if (close) {
        stack.pop();
      } else if (open) {
        var el = document.createElementNS(SVG_NS, open);
        for (var a = attr.exec(attrs || ''); a !== null; a = attr.exec(attrs || '')) {
          var value = unescapeXml(a[2]);
          if (a[1] === 'style') {
            // Through the CSS object model, exactly as in the app's Trusted-Types-safe builder.
            var decls = value.split(';');
            for (var i = 0; i < decls.length; i += 1) {
              var at = decls[i].indexOf(':');
              if (at > 0) el.style.setProperty(decls[i].slice(0, at).trim(), decls[i].slice(at + 1).trim());
            }
          } else {
            el.setAttribute(a[1], value);
          }
        }
        var parent = stack[stack.length - 1];
        if (parent) parent.appendChild(el);
        else if (!root && open === 'svg') root = el;
        if (!selfClose) stack.push(el);
      } else if (text && stack.length > 0 && text.trim() !== '') {
        stack[stack.length - 1].appendChild(document.createTextNode(unescapeXml(text.trim())));
      }
    }
    if (!root) throw new Error('The markup holds no svg element.');
    return root;
  }

  function renderFridaySvg(options) {
    return svgFromMarkup(renderFridaySvgString(options));
  }

  /* ---- the driver: mounting, gaze, hop ----------------------------------------------------------- */

  var mounted = [];
  var reducedMotion =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function mount(holder, options) {
    options = options || {};
    var size = options.size !== undefined ? options.size : holder ? Number(holder.getAttribute('data-size')) : undefined;
    var prefix = 'fd-' + (mounted.length + 1) + '-';
    var svg = renderFridaySvg({
      size: Number.isFinite(size) && size > 0 ? size : 36,
      state: options.state,
      accessories: options.accessories,
      idPrefix: prefix,
      title: options.title,
      className: options.className,
    });
    svg.style.transformOrigin = '50% 92%';
    (holder || document.body).appendChild(svg);

    var state = toCanonicalState(options.state);
    var accessories = (options.accessories || []).slice();
    var gazeYaw = 0;
    var gazePitch = 0;

    /** One hop impulse: the same (0, -18) kick the app's triggerImpulse gives the rig. */
    var hopSpring = new global.FridaySpring.Spring(0, global.FridaySpring.PRESETS.bouncy);
    var hopFrame = null;
    var hopLastT = null;

    function hopTick(t) {
      hopFrame = null;
      var dt = hopLastT === null ? 1 / 60 : (t - hopLastT) / 1000;
      hopLastT = t;
      var moving = hopSpring.step(dt);
      var y = hopSpring.current;
      // Squash and stretch with area preserved, as the rig does: rise stretches, landing squashes.
      var sy = 1 - y * 0.0035;
      var sx = 1 / sy;
      svg.style.transform = 'translateY(' + y.toFixed(2) + 'px) scale(' + sx.toFixed(4) + ', ' + sy.toFixed(4) + ')';
      if (moving) hopFrame = window.requestAnimationFrame(hopTick);
      else {
        hopLastT = null;
        svg.style.transform = '';
      }
    }

    function hop(kick) {
      if (reducedMotion) return;
      if (hopSpring.moving && hopFrame === null) return;
      hopSpring.velocity = kick || -240;
      if (hopFrame === null) {
        hopLastT = null;
        hopFrame = window.requestAnimationFrame(hopTick);
      }
    }

    function applyGaze() {
      var face = svg.querySelector('#' + prefix + 'face');
      if (face) face.setAttribute('transform', 'translate(' + (gazeYaw * 4).toFixed(2) + ', ' + (gazePitch * 4).toFixed(2) + ')');
    }

    function applyState() {
      var fresh = renderFridaySvg({
        size: Number.isFinite(size) && size > 0 ? size : 36,
        state: state,
        accessories: accessories,
        idPrefix: prefix,
        title: options.title,
        className: options.className,
      });
      fresh.style.transformOrigin = '50% 92%';
      fresh.style.transform = svg.style.transform;
      svg.replaceWith(fresh);
      svg = fresh;
      applyGaze();
    }

    var handle = {
      get el() {
        return svg;
      },
      get state() {
        return state;
      },
      setState: function (next) {
        var canonical = toCanonicalState(next);
        if (canonical === state) return;
        state = canonical;
        applyState();
      },
      setAccessories: function (next) {
        accessories = (next || []).slice();
        applyState();
      },
      setGaze: function (yaw, pitch) {
        gazeYaw = Math.max(-1, Math.min(1, yaw));
        gazePitch = Math.max(-1, Math.min(1, pitch));
        applyGaze();
      },
      hop: hop,
      destroy: function () {
        svg.remove();
        var at = mounted.indexOf(handle);
        if (at !== -1) mounted.splice(at, 1);
      },
    };

    mounted.push(handle);
    return handle;
  }

  /** One shared pointer listener: every mounted duck's eyes follow the pointer. */
  function trackPointer() {
    if (reducedMotion) return;
    document.addEventListener(
      'pointermove',
      function (e) {
        for (var i = 0; i < mounted.length; i += 1) {
          var rect = mounted[i].el.getBoundingClientRect();
          if (rect.width === 0) continue;
          var cx = rect.left + rect.width / 2;
          var cy = rect.top + rect.height / 2;
          var yaw = (e.clientX - cx) / Math.max(window.innerWidth, 480);
          var pitch = (e.clientY - cy) / Math.max(window.innerHeight, 480);
          mounted[i].setGaze(yaw * 2.2, pitch * 2.2);
        }
      },
      { passive: true },
    );
  }

  /** Mounts every holder marked data-mascot; reads data-size from the attribute. */
  function mountAll() {
    var holders = document.querySelectorAll('[data-mascot]');
    for (var i = 0; i < holders.length; i += 1) {
      var holder = holders[i];
      holder.__fridayDuck = mount(holder, { size: Number(holder.getAttribute('data-size')) || undefined });
      holder.addEventListener('click', function (e) {
        var duck = e.currentTarget.__fridayDuck;
        if (duck) duck.hop();
      });
    }
    trackPointer();
  }

  global.FridayDuck = {
    mount: mount,
    mountAll: mountAll,
    renderFridaySvg: renderFridaySvg,
    toCanonicalState: toCanonicalState,
    STATE_TINTS: STATE_TINTS,
  };
})(window);
