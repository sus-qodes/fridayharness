/*
 * Page wiring: the ducks, the two islands, the spring-driven reveals and the CTAs.
 * The hero island plays the app's launch sequence (hidden -> greeting 2.4 s -> compact pill, from
 * island-fsm.ts) and then walks its status tag through the loop a real project sees. The showcase
 * island in The Notch section waits pinned on an approval, and re-arms after each resolution.
 */
(function () {
  'use strict';

  var reducedMotion =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- the ducks (gaze tracking and click hops are set up by mascot.js) ------------------------- */

  FridayDuck.mountAll();

  /* ---- the hero island: launch sequence, then the live scenario cycle --------------------------- */

  var SCENARIOS = [
    { status: 'VERIFYING', label: 'VERIFYING', duck: 'thinking', pin: false },
    { status: 'RUNNING', label: '2 RUNNING', duck: 'tool_execution', pin: false },
    // The agents keep running; the chip carries the tray's own sentence while the tag yields.
    { status: 'RUNNING', label: '2 RUNNING', duck: 'idle', pin: true, chip: '2 running · 1 waiting' },
  ];

  var heroIslandEl = document.getElementById('island');
  if (heroIslandEl) {
    var hero = new FridayIsland.Island(heroIslandEl, {});
    hero.show('hidden');
    window.setTimeout(function () {
      hero.show('greeting');
    }, 600);
    window.setTimeout(function () {
      hero.show('compact');
      hero.startCycle(SCENARIOS);
    }, 600 + FridayIsland.TIMINGS.greetingS * 1000);
  }

  /* ---- the showcase island: pinned on an approval until you decide ------------------------------- */

  var demoIslandEl = document.getElementById('island-demo');
  if (demoIslandEl) {
    var demo = new FridayIsland.Island(demoIslandEl, {
      onResolved: function (island) {
        // Re-arm the demo a moment after the celebration, for the next visitor.
        window.setTimeout(function () {
          island.resetApproval();
        }, 3000);
      },
      onLater: function (island) {
        // "Later" keeps the pin; the demo quietly re-arms so the story can play again.
        window.setTimeout(function () {
          island.resetApproval();
        }, 6000);
      },
    });
    demo.pin();
  }

  /* ---- reveals: real springs lift each block into place (gentle 120/18) -------------------------- */

  var revealEls = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
  var activeSprings = [];
  var revealFrame = null;

  function revealTick(t) {
    revealFrame = null;
    var dt = 1 / 60;
    for (var i = activeSprings.length - 1; i >= 0; i -= 1) {
      var entry = activeSprings[i];
      if (!entry.spring.step(dt)) {
        entry.el.style.transform = '';
        activeSprings.splice(i, 1);
      } else {
        entry.el.style.transform = 'translateY(' + entry.spring.current.toFixed(2) + 'px)';
      }
    }
    if (activeSprings.length > 0) revealFrame = window.requestAnimationFrame(revealTick);
  }

  function reveal(el, delay) {
    var run = function () {
      el.classList.add('sd-revealed');
      if (reducedMotion) {
        el.style.transform = '';
        return;
      }
      var spring = new FridaySpring.Spring(24, FridaySpring.PRESETS.gentle);
      spring.setTarget(0);
      activeSprings.push({ el: el, spring: spring });
      if (revealFrame === null) revealFrame = window.requestAnimationFrame(revealTick);
    };
    if (delay > 0) window.setTimeout(run, delay);
    else run();
  }

  if ('IntersectionObserver' in window && !reducedMotion) {
    var observer = new IntersectionObserver(
      function (entries) {
        var shown = 0;
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          reveal(entry.target, shown * 70);
          shown += 1;
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    revealEls.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    revealEls.forEach(function (el) {
      el.classList.add('sd-revealed');
    });
  }

  /* ---- CTAs: download opens the latest GitHub release, GitHub the repository; a CTA left at "#" makes the ducks hop ---- */

  document.querySelectorAll('[data-cta]').forEach(function (link) {
    link.addEventListener('click', function (e) {
      if (link.getAttribute('href') === '#') {
        e.preventDefault();
        document.querySelectorAll('[data-mascot]').forEach(function (holder) {
          if (holder.__fridayDuck) holder.__fridayDuck.hop();
        });
      }
    });
  });
})();
