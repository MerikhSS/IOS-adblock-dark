/* AdBlock Dark surrogate for Amazon apstag.js. */
(function () {
  'use strict';
  var w = window;
  var noop = function () {};
  var q = (w.apstag && w.apstag._Q) || [];
  w.apstag = {
    _Q: q,
    fetchBids: function (cfg, cb) { if (typeof cb === 'function') setTimeout(function () { cb([]); }, 1); },
    init: noop, setDisplayBids: noop, targetingKeys: noop, renderImp: noop, punt: noop, dpa: noop, rpa: noop, upa: noop,
  };
})();
