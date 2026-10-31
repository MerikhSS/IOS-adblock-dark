/* AdBlock Dark surrogate for analytics.js / gtm.js: keeps sites working when GA is blocked. */
(function () {
  'use strict';
  var noop = function () {};
  var w = window;
  var Tracker = function () {};
  Tracker.prototype.get = noop;
  Tracker.prototype.set = noop;
  Tracker.prototype.send = noop;
  var gaName = w.GoogleAnalyticsObject || 'ga';
  var queue = w[gaName] && w[gaName].q;
  var ga = function () {
    var len = arguments.length;
    if (len === 0) return;
    var args = Array.prototype.slice.call(arguments);
    var last = args[len - 1];
    var hit = last instanceof Object && last.hitCallback instanceof Function ? last.hitCallback : null;
    if (args[0] instanceof Function) { try { args[0](new Tracker()); } catch (e) {} return; }
    if (hit) { try { setTimeout(hit, 1); } catch (e) {} }
  };
  ga.create = function () { return new Tracker(); };
  ga.getByName = function () { return new Tracker(); };
  ga.getAll = function () { return [new Tracker()]; };
  ga.remove = noop;
  ga.loaded = true;
  w[gaName] = ga;
  if (Array.isArray(queue)) { for (var i = 0; i < queue.length; i++) { try { ga.apply(null, queue[i]); } catch (e) {} } }
  // gtag / dataLayer: fire eventCallback so pages waiting on it continue.
  var dl = w.dataLayer;
  if (dl && Array.isArray(dl)) {
    var push = function (o) { if (o && typeof o.eventCallback === 'function') { try { setTimeout(o.eventCallback, 1); } catch (e) {} } return 0; };
    dl.forEach(push);
    dl.push = push;
  }
  w.google_tag_manager = w.google_tag_manager || {};
})();
