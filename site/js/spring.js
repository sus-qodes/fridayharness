/*
 * Damped springs for the island's geometry — a faithful port of apps/ui/src/notch/spring.ts.
 * Pure, no DOM.
 *
 * Hooke's law with viscous damping, F = -k*(x - target) - c*v, integrated with semi-implicit Euler
 * in fixed sub-steps of 1/240 s. A call's left-over time is carried to the next call, so the motion
 * is the same at 30, 60 or 144 frames per second. A spring settles exactly: once it is within a
 * hundredth of a pixel and nearly still, it snaps to its target and stops. Growing and shrinking
 * use the same spring.
 */
(function (global) {
  'use strict';

  /** The pill -> card width. */
  var WIDTH_SPRING = Object.freeze({ stiffness: 260, damping: 24 });
  /** The spring's own values, used for the height (dynamic) and the corner radius. */
  var HEIGHT_SPRING = Object.freeze({ stiffness: 240, damping: 22 });
  var RADIUS_SPRING = Object.freeze({ stiffness: 240, damping: 22 });

  /** The integration step (seconds). */
  var SUBSTEP = 1 / 240;
  /** At most this much time is simulated per call: a tab coming back from the background resumes smoothly. */
  var MAX_DT = 0.1;
  /** At rest when this close (px) ... */
  var REST_DELTA = 0.01;
  /** ... and this slow (px/s). */
  var REST_SPEED = 0.1;

  /** Float slack when counting sub-steps (1/60 must be exactly four of them). */
  var EPS = 1e-9;

  function finite(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }

  function Spring(initial, config) {
    this.config = config || HEIGHT_SPRING;
    this.current = finite(initial, 0);
    this.target = this.current;
    this.velocity = 0;
    this.carry = 0;
  }

  Object.defineProperty(Spring.prototype, 'moving', {
    get: function () {
      return this.current !== this.target || this.velocity !== 0;
    },
  });

  /** A new target; the spring keeps its velocity. Non-finite targets are ignored. */
  Spring.prototype.setTarget = function (target) {
    if (Number.isFinite(target)) this.target = target;
  };

  /** Jumps to target (reduced motion): no motion, no velocity. */
  Spring.prototype.jump = function (target) {
    if (Number.isFinite(target)) this.target = target;
    this.current = this.target;
    this.velocity = 0;
    this.carry = 0;
  };

  /** Advances by dt seconds; returns true while it still moves. */
  Spring.prototype.step = function (dt) {
    if (!this.moving) return false;
    if (!Number.isFinite(dt) || dt <= 0) return true;
    var k = this.config.stiffness;
    var c = this.config.damping;
    var time = Math.min(dt, MAX_DT) + this.carry;
    while (time >= SUBSTEP - EPS) {
      time -= SUBSTEP;
      var force = -k * (this.current - this.target) - c * this.velocity;
      this.velocity += force * SUBSTEP;
      this.current += this.velocity * SUBSTEP;
      if (!Number.isFinite(this.current) || !Number.isFinite(this.velocity)) {
        this.jump();
        return false;
      }
      if (Math.abs(this.current - this.target) < REST_DELTA && Math.abs(this.velocity) < REST_SPEED) {
        this.jump();
        return false;
      }
    }
    this.carry = Math.max(0, time);
    return true;
  };

  /** The island's three springs, moved together. */
  function GeometrySprings(initial) {
    this.width = new Spring(initial.width, WIDTH_SPRING);
    this.height = new Spring(initial.height, HEIGHT_SPRING);
    this.radius = new Spring(initial.radius, RADIUS_SPRING);
  }

  Object.defineProperty(GeometrySprings.prototype, 'moving', {
    get: function () {
      return this.width.moving || this.height.moving || this.radius.moving;
    },
  });

  Object.defineProperty(GeometrySprings.prototype, 'value', {
    get: function () {
      return { width: this.width.current, height: this.height.current, radius: this.radius.current };
    },
  });

  /** New targets; instant (reduced motion) jumps there. */
  GeometrySprings.prototype.setTarget = function (g, instant) {
    if (instant) {
      this.width.jump(g.width);
      this.height.jump(g.height);
      this.radius.jump(g.radius);
    } else {
      this.width.setTarget(g.width);
      this.height.setTarget(g.height);
      this.radius.setTarget(g.radius);
    }
  };

  /** Advances all three; true while any still moves. */
  GeometrySprings.prototype.step = function (dt) {
    var w = this.width.step(dt);
    var h = this.height.step(dt);
    var r = this.radius.step(dt);
    return w || h || r;
  };

  /** The page-wide motion presets (docs/ui-redesign-changelog.md): snappy 340/28 and friends. */
  var PRESETS = Object.freeze({
    snappy: Object.freeze({ stiffness: 340, damping: 28 }),
    smooth: Object.freeze({ stiffness: 240, damping: 24 }),
    bouncy: Object.freeze({ stiffness: 180, damping: 14 }),
    gentle: Object.freeze({ stiffness: 120, damping: 18 }),
  });

  global.FridaySpring = {
    Spring: Spring,
    GeometrySprings: GeometrySprings,
    WIDTH_SPRING: WIDTH_SPRING,
    HEIGHT_SPRING: HEIGHT_SPRING,
    RADIUS_SPRING: RADIUS_SPRING,
    PRESETS: PRESETS,
  };
})(window);
