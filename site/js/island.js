/*
 * The site's Notch island — ported from apps/ui/src/notch/island.ts and island-fsm.ts.
 * Three springs drive width, height and radius through --nt-w/--nt-h/--nt-r (the frame loop runs
 * only while a spring moves; reduced motion jumps). The FSM keeps the app's timings: greeting
 * 2.4 s, hover grace 0.6 s, collapse 15 s — and its pin invariant: while an approval waits for a
 * human, the island never hides and the card is only folded with "Later".
 */
(function (global) {
  'use strict';

  /** Part 01 §3.1 sizes. The expanded height follows its content. */
  var SIZES = {
    hidden: { width: 120, height: 4, radius: 2 },
    compact: { width: 200, height: 32, radius: 16 },
    greeting: { width: 320, height: 96, radius: 24 },
    expanded: { width: 400, radius: 24 },
  };
  var EXPANDED_MIN_HEIGHT = 120;
  var EXPANDED_MAX_HEIGHT = 272;
  var ISLAND_BORDER = 1;

  var TIMINGS = { collapseS: 15, hoverGraceS: 0.6, hideS: 60, greetingS: 2.4 };

  function reducedMotion() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function px(v) {
    return Math.round(v * 100) / 100 + 'px';
  }

  function Island(el, opts) {
    var self = this;
    this.el = el;
    this.opts = opts || {};
    this.springs = new global.FridaySpring.GeometrySprings(SIZES.compact);
    this.state = 'compact';
    this.openedBy = null;
    this.pinned = false;
    this.folded = false;
    this.frame = null;
    this.lastT = null;
    this.timers = {};
    this.cycleIndex = 0;
    this.destroyed = false;
    this.tick = this.tick.bind(this);

    this.views = {};
    el.querySelectorAll('[data-view]').forEach(function (view) {
      self.views[view.getAttribute('data-view')] = view;
    });

    this.ducks = [];
    el.querySelectorAll('[data-mascot]').forEach(function (holder) {
      if (holder.__fridayDuck) self.ducks.push(holder.__fridayDuck);
    });

    this.banner = el.querySelector('[data-banner]');
    this.tag = el.querySelector('[data-tag]');
    this.waitChip = el.querySelector('[data-wait-chip]');
    this.bannerSource = this.banner ? this.banner.innerHTML : null;

    this.wire();
    this.show('compact');
    this.apply();
  }

  /** The target geometry of a state; the expanded card's height follows its content. */
  Island.prototype.geometryFor = function (state, contentHeight) {
    if (state === 'hidden') return SIZES.hidden;
    if (state === 'compact') return SIZES.compact;
    if (state === 'greeting') return SIZES.greeting;
    var natural = Number.isFinite(contentHeight) ? Math.ceil(contentHeight) : 0;
    return {
      width: SIZES.expanded.width,
      height: Math.min(EXPANDED_MAX_HEIGHT, Math.max(EXPANDED_MIN_HEIGHT, natural)) + ISLAND_BORDER,
      radius: SIZES.expanded.radius,
    };
  };

  Island.prototype.show = function (state, contentHeight) {
    var self = this;
    this.state = state;
    this.el.setAttribute('data-state', state);
    Object.keys(this.views).forEach(function (name) {
      if (name === state) self.views[name].removeAttribute('hidden');
      else self.views[name].setAttribute('hidden', '');
    });
    var g = this.geometryFor(state, contentHeight);
    this.springs.setTarget(g, reducedMotion());
    if (!this.springs.moving) {
      this.stop();
      this.apply();
    } else {
      this.start();
    }
  };

  Island.prototype.start = function () {
    if (this.frame !== null) return;
    this.lastT = null;
    this.frame = window.requestAnimationFrame(this.tick);
  };

  Island.prototype.stop = function () {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.lastT = null;
  };

  Island.prototype.tick = function (t) {
    var self = this;
    this.frame = null;
    var dt = this.lastT === null || !Number.isFinite(t) ? 1 / 60 : (t - this.lastT) / 1000;
    this.lastT = Number.isFinite(t) ? t : null;
    var moving = this.springs.step(dt);
    this.apply();
    if (moving) this.frame = window.requestAnimationFrame(function (next) { self.tick(next); });
    else this.lastT = null;
  };

  Island.prototype.apply = function () {
    var g = this.springs.value;
    this.el.style.setProperty('--nt-w', px(g.width));
    this.el.style.setProperty('--nt-h', px(g.height));
    this.el.style.setProperty('--nt-r', px(g.radius));
  };

  Island.prototype.timer = function (name, fn, ms) {
    this.clearTimer(name);
    this.timers[name] = window.setTimeout(fn, ms);
  };

  Island.prototype.clearTimer = function (name) {
    if (this.timers[name]) {
      window.clearTimeout(this.timers[name]);
      delete this.timers[name];
    }
  };

  Island.prototype.wire = function () {
    var self = this;
    var el = this.el;

    el.addEventListener('pointerenter', function () {
      self.clearTimer('hover');
      if (self.state === 'compact' || self.state === 'hidden') self.open('hover');
    });

    el.addEventListener('pointerleave', function () {
      if (self.state !== 'expanded' || self.openedBy !== 'hover') return;
      self.timer('hover', function () {
        if (self.pinned && !self.folded) self.fold();
        else if (!self.pinned) self.close();
      }, TIMINGS.hoverGraceS * 1000);
    });

    var openButton = el.querySelector('.nt-compact-open');
    if (openButton) {
      openButton.addEventListener('click', function () {
        self.open('click');
      });
    }

    var strip = el.querySelector('.nt-strip');
    if (strip) {
      strip.addEventListener('click', function () {
        self.open('click');
      });
    }

    el.querySelectorAll('[data-allow]').forEach(function (button) {
      button.addEventListener('click', function () {
        self.resolve();
      });
    });
    el.querySelectorAll('[data-allow-run]').forEach(function (button) {
      button.addEventListener('click', function () {
        self.resolve();
      });
    });
    el.querySelectorAll('[data-later]').forEach(function (button) {
      button.addEventListener('click', function () {
        self.fold();
        self.opts.onLater && self.opts.onLater(self);
      });
    });
  };

  Island.prototype.open = function (by) {
    if (this.destroyed || this.state === 'expanded') return;
    this.openedBy = by;
    this.folded = false;
    this.el.classList.remove('nt-folded');
    var view = this.views.expanded;
    view.removeAttribute('hidden');
    var contentHeight = view.offsetHeight;
    view.setAttribute('hidden', '');
    this.show('expanded', contentHeight);
    // While the card is open the demo cycle holds still: the approval is the story.
    this.clearTimer('cycle');
    if (by === 'hover') this.el.setAttribute('data-opened-by', 'hover');
  };

  Island.prototype.close = function () {
    this.openedBy = null;
    this.el.removeAttribute('data-opened-by');
    this.show('compact');
  };

  /** The pin invariant: an approval waits; the card folds only by human decision. */
  Island.prototype.fold = function () {
    this.pinned = true;
    this.folded = true;
    this.el.classList.add('nt-pinned', 'nt-folded');
    if (this.waitChip) this.waitChip.removeAttribute('hidden');
    this.close();
  };

  Island.prototype.pin = function (chipText) {
    this.pinned = true;
    this.el.classList.add('nt-pinned');
    if (this.waitChip) {
      this.waitChip.removeAttribute('hidden');
      if (chipText) this.waitChip.textContent = chipText;
      // The chip carries the whole sentence, so the status tag yields (the pill is 200 px wide).
      if (this.tag) this.tag.setAttribute('hidden', '');
    }
    this.setBanner('wait', 'WAITING FOR YOU');
    this.setDucks('idle');
  };

  /** Allow once / Allow run: verify, celebrate, hand the story back to the cycle. */
  Island.prototype.resolve = function () {
    var self = this;
    this.pinned = false;
    this.folded = false;
    this.el.classList.remove('nt-pinned', 'nt-folded');
    if (this.waitChip) this.waitChip.setAttribute('hidden', '');
    if (this.tag) this.tag.removeAttribute('hidden');
    this.setBanner('ok', 'VERIFIED');
    this.el.classList.add('nt-celebrate');
    this.setDucks('success');
    this.ducks.forEach(function (duck) {
      duck.hop();
    });
    if (this.tag) {
      this.tag.setAttribute('data-status', 'RUNNING');
      this.tag.textContent = 'VERIFYING';
      this.tag.setAttribute('data-status', 'VERIFYING');
    }
    this.timer('celebrate', function () {
      self.el.classList.remove('nt-celebrate');
      if (self.state === 'expanded') self.close();
      self.setDucks('tool_execution');
      if (self.tag) {
        self.tag.textContent = '2 RUNNING';
        self.tag.setAttribute('data-status', 'RUNNING');
      }
      self.resumeCycle();
    }, TIMINGS.greetingS * 1000);
    this.opts.onResolved && this.opts.onResolved(this);
  };

  /** Re-arms the approval demo: original banner copy, pinned again, chip back on the pill. */
  Island.prototype.resetApproval = function () {
    if (this.bannerSource !== null && this.banner) this.banner.innerHTML = this.bannerSource;
    this.folded = false;
    this.el.classList.remove('nt-folded');
    this.pin();
  };

  Island.prototype.setBanner = function (tone, status) {
    if (!this.banner) return;
    this.banner.setAttribute('data-tone', tone);
    var statusEl = this.banner.querySelector('[data-banner-status]');
    if (statusEl) statusEl.textContent = status;
    var summary = this.banner.querySelector('[data-banner-summary]');
    var meta = this.banner.querySelector('[data-banner-meta]');
    if (tone === 'ok') {
      if (summary) summary.textContent = 'Friday verified the work — checks passed, diff staged.';
      if (meta) meta.innerHTML = '<span>verification passed</span><span>git authority</span>';
    }
  };

  Island.prototype.setDucks = function (state) {
    this.ducks.forEach(function (duck) {
      duck.setState(state);
    });
  };

  /** The hero demo: the status tag walks the loop a real project sees. */
  Island.prototype.startCycle = function (scenarios) {
    var self = this;
    this.scenarios = scenarios;
    var step = function () {
      if (self.destroyed || self.pinned || self.state === 'expanded') return;
      self.cycleIndex = (self.cycleIndex + 1) % self.scenarios.length;
      var scene = self.scenarios[self.cycleIndex];
      if (self.tag) {
        self.tag.textContent = scene.label;
        self.tag.setAttribute('data-status', scene.status);
      }
      self.setDucks(scene.duck);
      if (scene.pin) self.pin(scene.chip);
    };
    this.clearTimer('cycle');
    this.timers.cycle = window.setInterval(step, 5000);
  };

  Island.prototype.resumeCycle = function () {
    if (!this.scenarios) return;
    // The resolve already set the tag to its RUNNING scene; the cycle continues from the top.
    this.cycleIndex = 0;
  };

  Island.prototype.destroy = function () {
    this.destroyed = true;
    this.stop();
    Object.keys(this.timers).forEach(function (name) {
      if (name === 'cycle') window.clearInterval(this.timers[name]);
      else window.clearTimeout(this.timers[name]);
    }, this);
    this.el.remove();
  };

  global.FridayIsland = { Island: Island, SIZES: SIZES, TIMINGS: TIMINGS };
})(window);
