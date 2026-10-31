/* AdBlock Dark surrogate for Google Publisher Tag (gpt.js). */
(function () {
  'use strict';
  var noop = function () {};
  var noopThis = function () { return this; };
  var noopNull = function () { return null; };
  var noopArr = function () { return []; };
  var slot = { addService: noopThis, clearCategoryExclusions: noopThis, clearTargeting: noopThis, defineSizeMapping: noopThis,
    get: noopNull, getAdUnitPath: noopArr, getAttributeKeys: noopArr, getCategoryExclusions: noopArr, getDomId: noopNull,
    getSlotElementId: noopNull, getSlotId: noopThis, getTargeting: noopArr, getTargetingKeys: noopArr, set: noopThis,
    setCategoryExclusion: noopThis, setClickUrl: noopThis, setCollapseEmptyDiv: noopThis, setTargeting: noopThis, updateTargetingFromMap: noopThis };
  var pubads = { addEventListener: noopThis, removeEventListener: noopThis, clear: noop, clearCategoryExclusions: noopThis,
    clearTagForChildDirectedTreatment: noopThis, clearTargeting: noopThis, collapseEmptyDivs: noop, defineOutOfPagePassback: function () { return slot; },
    definePassback: function () { return slot; }, disableInitialLoad: noop, display: noop, enableAsyncRendering: noop,
    enableLazyLoad: noop, enableSingleRequest: noop, enableSyncRendering: noop, enableVideoAds: noop, get: noopNull,
    getAttributeKeys: noopArr, getTargeting: noopArr, getTargetingKeys: noopArr, getSlots: noopArr, isInitialLoadDisabled: function () { return true; },
    refresh: noop, set: noopThis, setCategoryExclusion: noopThis, setCentering: noop, setCookieOptions: noopThis,
    setForceSafeFrame: noopThis, setLocation: noopThis, setPrivacySettings: noopThis, setPublisherProvidedId: noopThis,
    setRequestNonPersonalizedAds: noopThis, setSafeFrameConfig: noopThis, setTagForChildDirectedTreatment: noopThis,
    setTargeting: noopThis, setVideoContent: noopThis, updateCorrelator: noop };
  var gt = window.googletag || {};
  var cmd = gt.cmd || [];
  gt.apiReady = true;
  gt.pubadsReady = true;
  gt.cmd = [];
  gt.cmd.push = function (a) { try { a(); } catch (e) {} return 1; };
  gt.companionAds = function () { return { addEventListener: noopThis, enableSyncLoading: noop, setRefreshUnfilledSlots: noop }; };
  gt.content = function () { return { addEventListener: noopThis, setContent: noop }; };
  gt.defineOutOfPageSlot = function () { return slot; };
  gt.defineSlot = function () { return slot; };
  gt.destroySlots = noop;
  gt.disablePublisherConsole = noop;
  gt.display = noop;
  gt.enableServices = noop;
  gt.getVersion = function () { return ''; };
  gt.pubads = function () { return pubads; };
  gt.setAdIframeTitle = noop;
  gt.sizeMapping = function () { return { addSize: noopThis, build: noopNull }; };
  window.googletag = gt;
  while (cmd.length) { try { cmd.shift()(); } catch (e) {} }
})();
