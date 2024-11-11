"use strict";
(() => {
  // clients/extension/scripts/settings-controller.js
  var BACKENDS = [{
    id: "psi",
    title: "PSI Frontend (pagespeed.web.dev)"
  }, {
    id: "viewer",
    title: "Lighthouse Viewer (googlechrome.github.io)"
  }];
  var DEFAULT_CATEGORIES = [{
    id: "performance",
    title: "Performance"
  }, {
    id: "accessibility",
    title: "Accessibility"
  }, {
    id: "best-practices",
    title: "Best Practices"
  }, {
    id: "seo",
    title: "SEO"
  }];
  var STORAGE_KEYS = {
    Categories: "lighthouse_audits",
    Settings: "lighthouse_settings"
  };
  function saveSettings(settings) {
    const storage = {
      /** @type {Record<string, boolean>} */
      [STORAGE_KEYS.Categories]: {},
      /** @type {Record<string, string>} */
      [STORAGE_KEYS.Settings]: {}
    };
    DEFAULT_CATEGORIES.forEach((category) => {
      const enabled = settings.selectedCategories.includes(category.id);
      storage[STORAGE_KEYS.Categories][category.id] = enabled;
    });
    storage[STORAGE_KEYS.Settings].device = settings.device;
    storage[STORAGE_KEYS.Settings].backend = settings.backend;
    storage[STORAGE_KEYS.Settings].locale = settings.locale;
    chrome.storage.local.set(storage);
  }
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEYS.Categories, STORAGE_KEYS.Settings], (result) => {
        const defaultCategories = {};
        DEFAULT_CATEGORIES.forEach((category) => {
          defaultCategories[category.id] = true;
        });
        const savedCategories = { ...defaultCategories, ...result[STORAGE_KEYS.Categories] };
        const defaultSettings = {
          device: "mobile"
        };
        const savedSettings = { ...defaultSettings, ...result[STORAGE_KEYS.Settings] };
        resolve({
          backend: savedSettings.backend ?? "psi",
          device: savedSettings.device,
          locale: savedSettings.locale ?? navigator.language,
          selectedCategories: Object.keys(savedCategories).filter((cat) => savedCategories[cat])
        });
      });
    });
  }

  // shared/statistics.js
  var MIN_PASSING_SCORE = 0.9;
  var MAX_AVERAGE_SCORE = 0.8999999999999999;
  var MIN_AVERAGE_SCORE = 0.5;
  var MAX_FAILING_SCORE = 0.49999999999999994;
  function erf(x) {
    const sign = Math.sign(x);
    x = Math.abs(x);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
    return sign * (1 - y * Math.exp(-x * x));
  }
  function getLogNormalScore({ median, p10 }, value) {
    if (median <= 0)
      throw new Error("median must be greater than zero");
    if (p10 <= 0)
      throw new Error("p10 must be greater than zero");
    if (p10 >= median)
      throw new Error("p10 must be less than the median");
    if (value <= 0)
      return 1;
    const INVERSE_ERFC_ONE_FIFTH = 0.9061938024368232;
    const xRatio = Math.max(Number.MIN_VALUE, value / median);
    const xLogRatio = Math.log(xRatio);
    const p10Ratio = Math.max(Number.MIN_VALUE, p10 / median);
    const p10LogRatio = -Math.log(p10Ratio);
    const standardizedX = xLogRatio * INVERSE_ERFC_ONE_FIFTH / p10LogRatio;
    const complementaryPercentile = (1 - erf(standardizedX)) / 2;
    let score;
    if (value <= p10) {
      score = Math.max(MIN_PASSING_SCORE, Math.min(1, complementaryPercentile));
    } else if (value <= median) {
      score = Math.max(MIN_AVERAGE_SCORE, Math.min(MAX_AVERAGE_SCORE, complementaryPercentile));
    } else {
      score = Math.max(0, Math.min(MAX_FAILING_SCORE, complementaryPercentile));
    }
    return score;
  }

  // shared/util.js
  var ELLIPSIS = "\u2026";
  var NBSP = "\xA0";
  var PASS_THRESHOLD = 0.9;
  var RATINGS = {
    PASS: { label: "pass", minScore: PASS_THRESHOLD },
    AVERAGE: { label: "average", minScore: 0.5 },
    FAIL: { label: "fail" },
    ERROR: { label: "error" }
  };
  var listOfTlds = [
    "com",
    "co",
    "gov",
    "edu",
    "ac",
    "org",
    "go",
    "gob",
    "or",
    "net",
    "in",
    "ne",
    "nic",
    "gouv",
    "web",
    "spb",
    "blog",
    "jus",
    "kiev",
    "mil",
    "wi",
    "qc",
    "ca",
    "bel",
    "on"
  ];
  var Util = class _Util {
    static get RATINGS() {
      return RATINGS;
    }
    static get PASS_THRESHOLD() {
      return PASS_THRESHOLD;
    }
    static get MS_DISPLAY_VALUE() {
      return `%10d${NBSP}ms`;
    }
    /**
     * If LHR is older than 10.0 it will not have the `finalDisplayedUrl` property.
     * Old LHRs should have the `finalUrl` property which will work fine for the report.
     *
     * @param {LH.Result} lhr
     */
    static getFinalDisplayedUrl(lhr) {
      if (lhr.finalDisplayedUrl)
        return lhr.finalDisplayedUrl;
      if (lhr.finalUrl)
        return lhr.finalUrl;
      throw new Error("Could not determine final displayed URL");
    }
    /**
     * If LHR is older than 10.0 it will not have the `mainDocumentUrl` property.
     * Old LHRs should have the `finalUrl` property which is the same as `mainDocumentUrl`.
     *
     * @param {LH.Result} lhr
     */
    static getMainDocumentUrl(lhr) {
      return lhr.mainDocumentUrl || lhr.finalUrl;
    }
    /**
     * @param {LH.Result} lhr
     * @return {LH.Result.FullPageScreenshot=}
     */
    static getFullPageScreenshot(lhr) {
      if (lhr.fullPageScreenshot) {
        return lhr.fullPageScreenshot;
      }
      const details = (
        /** @type {LH.Result.FullPageScreenshot=} */
        lhr.audits["full-page-screenshot"]?.details
      );
      return details;
    }
    /**
     * Given the entity classification dataset and a URL, identify the entity.
     * @param {string} url
     * @param {LH.Result.Entities=} entities
     * @return {LH.Result.LhrEntity|string}
     */
    static getEntityFromUrl(url, entities) {
      if (!entities) {
        return _Util.getPseudoRootDomain(url);
      }
      const entity = entities.find((e) => e.origins.find((origin) => url.startsWith(origin)));
      return entity || _Util.getPseudoRootDomain(url);
    }
    /**
     * Split a string by markdown code spans (enclosed in `backticks`), splitting
     * into segments that were enclosed in backticks (marked as `isCode === true`)
     * and those that outside the backticks (`isCode === false`).
     * @param {string} text
     * @return {Array<{isCode: true, text: string}|{isCode: false, text: string}>}
     */
    static splitMarkdownCodeSpans(text) {
      const segments = [];
      const parts = text.split(/`(.*?)`/g);
      for (let i = 0; i < parts.length; i++) {
        const text2 = parts[i];
        if (!text2)
          continue;
        const isCode = i % 2 !== 0;
        segments.push({
          isCode,
          text: text2
        });
      }
      return segments;
    }
    /**
     * Split a string on markdown links (e.g. [some link](https://...)) into
     * segments of plain text that weren't part of a link (marked as
     * `isLink === false`), and segments with text content and a URL that did make
     * up a link (marked as `isLink === true`).
     * @param {string} text
     * @return {Array<{isLink: true, text: string, linkHref: string}|{isLink: false, text: string}>}
     */
    static splitMarkdownLink(text) {
      const segments = [];
      const parts = text.split(/\[([^\]]+?)\]\((https?:\/\/.*?)\)/g);
      while (parts.length) {
        const [preambleText, linkText, linkHref] = parts.splice(0, 3);
        if (preambleText) {
          segments.push({
            isLink: false,
            text: preambleText
          });
        }
        if (linkText && linkHref) {
          segments.push({
            isLink: true,
            text: linkText,
            linkHref
          });
        }
      }
      return segments;
    }
    /**
     * @param {string} string
     * @param {number} characterLimit
     * @param {string} ellipseSuffix
     */
    static truncate(string, characterLimit, ellipseSuffix = "\u2026") {
      if (string.length <= characterLimit) {
        return string;
      }
      const segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
      const iterator = segmenter.segment(string)[Symbol.iterator]();
      let lastSegmentIndex = 0;
      for (let i = 0; i <= characterLimit - ellipseSuffix.length; i++) {
        const result = iterator.next();
        if (result.done) {
          return string;
        }
        lastSegmentIndex = result.value.index;
      }
      for (let i = 0; i < ellipseSuffix.length; i++) {
        if (iterator.next().done) {
          return string;
        }
      }
      return string.slice(0, lastSegmentIndex) + ellipseSuffix;
    }
    /**
     * @param {URL} parsedUrl
     * @param {{numPathParts?: number, preserveQuery?: boolean, preserveHost?: boolean}=} options
     * @return {string}
     */
    static getURLDisplayName(parsedUrl, options) {
      options = options || {
        numPathParts: void 0,
        preserveQuery: void 0,
        preserveHost: void 0
      };
      const numPathParts = options.numPathParts !== void 0 ? options.numPathParts : 2;
      const preserveQuery = options.preserveQuery !== void 0 ? options.preserveQuery : true;
      const preserveHost = options.preserveHost || false;
      let name;
      if (parsedUrl.protocol === "about:" || parsedUrl.protocol === "data:") {
        name = parsedUrl.href;
      } else {
        name = parsedUrl.pathname;
        const parts = name.split("/").filter((part) => part.length);
        if (numPathParts && parts.length > numPathParts) {
          name = ELLIPSIS + parts.slice(-1 * numPathParts).join("/");
        }
        if (preserveHost) {
          name = `${parsedUrl.host}/${name.replace(/^\//, "")}`;
        }
        if (preserveQuery) {
          name = `${name}${parsedUrl.search}`;
        }
      }
      const MAX_LENGTH = 64;
      if (parsedUrl.protocol !== "data:") {
        name = name.slice(0, 200);
        name = name.replace(/([a-f0-9]{7})[a-f0-9]{13}[a-f0-9]*/g, `$1${ELLIPSIS}`);
        name = name.replace(
          /([a-zA-Z0-9-_]{9})(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])[a-zA-Z0-9-_]{10,}/g,
          `$1${ELLIPSIS}`
        );
        name = name.replace(/(\d{3})\d{6,}/g, `$1${ELLIPSIS}`);
        name = name.replace(/\u2026+/g, ELLIPSIS);
        if (name.length > MAX_LENGTH && name.includes("?")) {
          name = name.replace(/\?([^=]*)(=)?.*/, `?$1$2${ELLIPSIS}`);
          if (name.length > MAX_LENGTH) {
            name = name.replace(/\?.*/, `?${ELLIPSIS}`);
          }
        }
      }
      if (name.length > MAX_LENGTH) {
        const dotIndex = name.lastIndexOf(".");
        if (dotIndex >= 0) {
          name = name.slice(0, MAX_LENGTH - 1 - (name.length - dotIndex)) + // Show file extension
          `${ELLIPSIS}${name.slice(dotIndex)}`;
        } else {
          name = name.slice(0, MAX_LENGTH - 1) + ELLIPSIS;
        }
      }
      return name;
    }
    /**
     * Returns the origin portion of a Chrome extension URL.
     * @param {string} url
     * @return {string}
     */
    static getChromeExtensionOrigin(url) {
      const parsedUrl = new URL(url);
      return parsedUrl.protocol + "//" + parsedUrl.host;
    }
    /**
     * Split a URL into a file, hostname and origin for easy display.
     * @param {string} url
     * @return {{file: string, hostname: string, origin: string}}
     */
    static parseURL(url) {
      const parsedUrl = new URL(url);
      return {
        file: _Util.getURLDisplayName(parsedUrl),
        hostname: parsedUrl.hostname,
        // Node's URL parsing behavior is different than Chrome and returns 'null'
        // for chrome-extension:// URLs. See https://github.com/nodejs/node/issues/21955.
        origin: parsedUrl.protocol === "chrome-extension:" ? _Util.getChromeExtensionOrigin(url) : parsedUrl.origin
      };
    }
    /**
     * @param {string|URL} value
     * @return {!URL}
     */
    static createOrReturnURL(value) {
      if (value instanceof URL) {
        return value;
      }
      return new URL(value);
    }
    /**
     * Gets the tld of a domain
     * This function is used only while rendering pre-10.0 LHRs.
     *
     * @param {string} hostname
     * @return {string} tld
     */
    static getPseudoTld(hostname) {
      const tlds = hostname.split(".").slice(-2);
      if (!listOfTlds.includes(tlds[0])) {
        return `.${tlds[tlds.length - 1]}`;
      }
      return `.${tlds.join(".")}`;
    }
    /**
     * Returns a primary domain for provided hostname (e.g. www.example.com -> example.com).
     * As it doesn't consult the Public Suffix List, it can sometimes lose detail.
     * See the `listOfTlds` comment above for more.
     * This function is used only while rendering pre-10.0 LHRs. See UrlUtils.getRootDomain
     * for the current method that makes use of PSL.
     * @param {string|URL} url hostname or URL object
     * @return {string}
     */
    static getPseudoRootDomain(url) {
      const hostname = _Util.createOrReturnURL(url).hostname;
      const tld = _Util.getPseudoTld(hostname);
      const splitTld = tld.split(".");
      return hostname.split(".").slice(-splitTld.length).join(".");
    }
    /**
     * Returns only lines that are near a message, or the first few lines if there are
     * no line messages.
     * @param {SnippetValue['lines']} lines
     * @param {SnippetValue['lineMessages']} lineMessages
     * @param {number} surroundingLineCount Number of lines to include before and after
     * the message. If this is e.g. 2 this function might return 5 lines.
     */
    static filterRelevantLines(lines, lineMessages, surroundingLineCount) {
      if (lineMessages.length === 0) {
        return lines.slice(0, surroundingLineCount * 2 + 1);
      }
      const minGapSize = 3;
      const lineNumbersToKeep = /* @__PURE__ */ new Set();
      lineMessages = lineMessages.sort((a, b) => (a.lineNumber || 0) - (b.lineNumber || 0));
      lineMessages.forEach(({ lineNumber }) => {
        let firstSurroundingLineNumber = lineNumber - surroundingLineCount;
        let lastSurroundingLineNumber = lineNumber + surroundingLineCount;
        while (firstSurroundingLineNumber < 1) {
          firstSurroundingLineNumber++;
          lastSurroundingLineNumber++;
        }
        if (lineNumbersToKeep.has(firstSurroundingLineNumber - minGapSize - 1)) {
          firstSurroundingLineNumber -= minGapSize;
        }
        for (let i = firstSurroundingLineNumber; i <= lastSurroundingLineNumber; i++) {
          const surroundingLineNumber = i;
          lineNumbersToKeep.add(surroundingLineNumber);
        }
      });
      return lines.filter((line) => lineNumbersToKeep.has(line.lineNumber));
    }
    /**
     * Computes a score between 0 and 1 based on the measured `value`. Score is determined by
     * considering a log-normal distribution governed by two control points (the 10th
     * percentile value and the median value) and represents the percentage of sites that are
     * greater than `value`.
     *
     * Score characteristics:
     * - within [0, 1]
     * - rounded to two digits
     * - value must meet or beat a controlPoint value to meet or exceed its percentile score:
     *   - value > median will give a score < 0.5; value ≤ median will give a score ≥ 0.5.
     *   - value > p10 will give a score < 0.9; value ≤ p10 will give a score ≥ 0.9.
     * - values < p10 will get a slight boost so a score of 1 is achievable by a
     *   `value` other than those close to 0. Scores of > ~0.99524 end up rounded to 1.
     * @param {{median: number, p10: number}} controlPoints
     * @param {number} value
     * @return {number}
     */
    static computeLogNormalScore(controlPoints, value) {
      let percentile = getLogNormalScore(controlPoints, value);
      if (percentile > 0.9) {
        percentile += 0.05 * (percentile - 0.9);
      }
      return Math.floor(percentile * 100) / 100;
    }
  };

  // report/renderer/components.js
  function create3pFilterComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("style");
    el1.append("\n    .lh-3p-filter {\n      color: var(--color-gray-600);\n      float: right;\n      padding: 6px var(--stackpack-padding-horizontal);\n    }\n    .lh-3p-filter-label, .lh-3p-filter-input {\n      vertical-align: middle;\n      user-select: none;\n    }\n    .lh-3p-filter-input:disabled + .lh-3p-ui-string {\n      text-decoration: line-through;\n    }\n  ");
    el0.append(el1);
    const el2 = dom2.createElement("div", "lh-3p-filter");
    const el3 = dom2.createElement("label", "lh-3p-filter-label");
    const el4 = dom2.createElement("input", "lh-3p-filter-input");
    el4.setAttribute("type", "checkbox");
    el4.setAttribute("checked", "");
    const el5 = dom2.createElement("span", "lh-3p-ui-string");
    el5.append("Show 3rd party resources");
    const el6 = dom2.createElement("span", "lh-3p-filter-count");
    el3.append(" ", el4, " ", el5, " (", el6, ") ");
    el2.append(" ", el3, " ");
    el0.append(el2);
    return el0;
  }
  function createAuditComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-audit");
    const el2 = dom2.createElement("details", "lh-expandable-details");
    const el3 = dom2.createElement("summary");
    const el4 = dom2.createElement("div", "lh-audit__header lh-expandable-details__summary");
    const el5 = dom2.createElement("span", "lh-audit__score-icon");
    const el6 = dom2.createElement("span", "lh-audit__title-and-text");
    const el7 = dom2.createElement("span", "lh-audit__title");
    const el8 = dom2.createElement("span", "lh-audit__display-text");
    el6.append(" ", el7, " ", el8, " ");
    const el9 = dom2.createElement("div", "lh-chevron-container");
    el4.append(" ", el5, " ", el6, " ", el9, " ");
    el3.append(" ", el4, " ");
    const el10 = dom2.createElement("div", "lh-audit__description");
    const el11 = dom2.createElement("div", "lh-audit__stackpacks");
    el2.append(" ", el3, " ", el10, " ", el11, " ");
    el1.append(" ", el2, " ");
    el0.append(el1);
    return el0;
  }
  function createCategoryHeaderComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-category-header");
    const el2 = dom2.createElement("div", "lh-score__gauge");
    el2.setAttribute("role", "heading");
    el2.setAttribute("aria-level", "2");
    const el3 = dom2.createElement("div", "lh-category-header__description");
    el1.append(" ", el2, " ", el3, " ");
    el0.append(el1);
    return el0;
  }
  function createChevronComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElementNS("http://www.w3.org/2000/svg", "svg", "lh-chevron");
    el1.setAttribute("viewBox", "0 0 100 100");
    const el2 = dom2.createElementNS("http://www.w3.org/2000/svg", "g", "lh-chevron__lines");
    const el3 = dom2.createElementNS("http://www.w3.org/2000/svg", "path", "lh-chevron__line lh-chevron__line-left");
    el3.setAttribute("d", "M10 50h40");
    const el4 = dom2.createElementNS("http://www.w3.org/2000/svg", "path", "lh-chevron__line lh-chevron__line-right");
    el4.setAttribute("d", "M90 50H50");
    el2.append(" ", el3, " ", el4, " ");
    el1.append(" ", el2, " ");
    el0.append(el1);
    return el0;
  }
  function createClumpComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-audit-group");
    const el2 = dom2.createElement("details", "lh-clump");
    const el3 = dom2.createElement("summary");
    const el4 = dom2.createElement("div", "lh-audit-group__summary");
    const el5 = dom2.createElement("div", "lh-audit-group__header");
    const el6 = dom2.createElement("span", "lh-audit-group__title");
    const el7 = dom2.createElement("span", "lh-audit-group__itemcount");
    el5.append(" ", el6, " ", el7, " ", " ", " ");
    const el8 = dom2.createElement("div", "lh-clump-toggle");
    const el9 = dom2.createElement("span", "lh-clump-toggletext--show");
    const el10 = dom2.createElement("span", "lh-clump-toggletext--hide");
    el8.append(" ", el9, " ", el10, " ");
    el4.append(" ", el5, " ", el8, " ");
    el3.append(" ", el4, " ");
    el2.append(" ", el3, " ");
    el1.append(" ", " ", el2, " ");
    el0.append(el1);
    return el0;
  }
  function createCrcComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-crc-container");
    const el2 = dom2.createElement("style");
    el2.append(`
      .lh-crc .lh-tree-marker {
        width: 12px;
        height: 26px;
        display: block;
        float: left;
        background-position: top left;
      }
      .lh-crc .lh-horiz-down {
        background: url('data:image/svg+xml;utf8,<svg width="16" height="26" viewBox="0 0 16 26" xmlns="http://www.w3.org/2000/svg"><g fill="%23D8D8D8" fill-rule="evenodd"><path d="M16 12v2H-2v-2z"/><path d="M9 12v14H7V12z"/></g></svg>');
      }
      .lh-crc .lh-right {
        background: url('data:image/svg+xml;utf8,<svg width="16" height="26" viewBox="0 0 16 26" xmlns="http://www.w3.org/2000/svg"><path d="M16 12v2H0v-2z" fill="%23D8D8D8" fill-rule="evenodd"/></svg>');
      }
      .lh-crc .lh-up-right {
        background: url('data:image/svg+xml;utf8,<svg width="16" height="26" viewBox="0 0 16 26" xmlns="http://www.w3.org/2000/svg"><path d="M7 0h2v14H7zm2 12h7v2H9z" fill="%23D8D8D8" fill-rule="evenodd"/></svg>');
      }
      .lh-crc .lh-vert-right {
        background: url('data:image/svg+xml;utf8,<svg width="16" height="26" viewBox="0 0 16 26" xmlns="http://www.w3.org/2000/svg"><path d="M7 0h2v27H7zm2 12h7v2H9z" fill="%23D8D8D8" fill-rule="evenodd"/></svg>');
      }
      .lh-crc .lh-vert {
        background: url('data:image/svg+xml;utf8,<svg width="16" height="26" viewBox="0 0 16 26" xmlns="http://www.w3.org/2000/svg"><path d="M7 0h2v26H7z" fill="%23D8D8D8" fill-rule="evenodd"/></svg>');
      }
      .lh-crc .lh-crc-tree {
        font-size: 14px;
        width: 100%;
        overflow-x: auto;
      }
      .lh-crc .lh-crc-node {
        height: 26px;
        line-height: 26px;
        white-space: nowrap;
      }
      .lh-crc .lh-crc-node__tree-value {
        margin-left: 10px;
      }
      .lh-crc .lh-crc-node__tree-value div {
        display: inline;
      }
      .lh-crc .lh-crc-node__chain-duration {
        font-weight: 700;
      }
      .lh-crc .lh-crc-initial-nav {
        color: #595959;
        font-style: italic;
      }
      .lh-crc__summary-value {
        margin-bottom: 10px;
      }
    `);
    const el3 = dom2.createElement("div");
    const el4 = dom2.createElement("div", "lh-crc__summary-value");
    const el5 = dom2.createElement("span", "lh-crc__longest_duration_label");
    const el6 = dom2.createElement("b", "lh-crc__longest_duration");
    el4.append(" ", el5, " ", el6, " ");
    el3.append(" ", el4, " ");
    const el7 = dom2.createElement("div", "lh-crc");
    const el8 = dom2.createElement("div", "lh-crc-initial-nav");
    el7.append(" ", el8, " ", " ");
    el1.append(" ", el2, " ", el3, " ", el7, " ");
    el0.append(el1);
    return el0;
  }
  function createCrcChainComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-crc-node");
    const el2 = dom2.createElement("span", "lh-crc-node__tree-marker");
    const el3 = dom2.createElement("span", "lh-crc-node__tree-value");
    el1.append(" ", el2, " ", el3, " ");
    el0.append(el1);
    return el0;
  }
  function createElementScreenshotComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-element-screenshot");
    const el2 = dom2.createElement("div", "lh-element-screenshot__content");
    const el3 = dom2.createElement("div", "lh-element-screenshot__image");
    const el4 = dom2.createElement("div", "lh-element-screenshot__mask");
    const el5 = dom2.createElementNS("http://www.w3.org/2000/svg", "svg");
    el5.setAttribute("height", "0");
    el5.setAttribute("width", "0");
    const el6 = dom2.createElementNS("http://www.w3.org/2000/svg", "defs");
    const el7 = dom2.createElementNS("http://www.w3.org/2000/svg", "clipPath");
    el7.setAttribute("clipPathUnits", "objectBoundingBox");
    el6.append(" ", el7, " ", " ");
    el5.append(" ", el6, " ");
    el4.append(" ", el5, " ");
    const el8 = dom2.createElement("div", "lh-element-screenshot__element-marker");
    el3.append(" ", el4, " ", el8, " ");
    el2.append(" ", el3, " ");
    el1.append(" ", el2, " ");
    el0.append(el1);
    return el0;
  }
  function createExplodeyGaugeComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-exp-gauge-component");
    const el2 = dom2.createElement("div", "lh-exp-gauge__wrapper");
    el2.setAttribute("target", "_blank");
    const el3 = dom2.createElement("div", "lh-exp-gauge__svg-wrapper");
    const el4 = dom2.createElementNS("http://www.w3.org/2000/svg", "svg", "lh-exp-gauge");
    const el5 = dom2.createElementNS("http://www.w3.org/2000/svg", "g", "lh-exp-gauge__inner");
    const el6 = dom2.createElementNS("http://www.w3.org/2000/svg", "circle", "lh-exp-gauge__bg");
    const el7 = dom2.createElementNS("http://www.w3.org/2000/svg", "circle", "lh-exp-gauge__base lh-exp-gauge--faded");
    const el8 = dom2.createElementNS("http://www.w3.org/2000/svg", "circle", "lh-exp-gauge__arc");
    const el9 = dom2.createElementNS("http://www.w3.org/2000/svg", "text", "lh-exp-gauge__percentage");
    el5.append(" ", el6, " ", el7, " ", el8, " ", el9, " ");
    const el10 = dom2.createElementNS("http://www.w3.org/2000/svg", "g", "lh-exp-gauge__outer");
    const el11 = dom2.createElementNS("http://www.w3.org/2000/svg", "circle", "lh-cover");
    el10.append(" ", el11, " ");
    const el12 = dom2.createElementNS("http://www.w3.org/2000/svg", "text", "lh-exp-gauge__label");
    el12.setAttribute("text-anchor", "middle");
    el12.setAttribute("x", "0");
    el12.setAttribute("y", "60");
    el4.append(" ", el5, " ", el10, " ", el12, " ");
    el3.append(" ", el4, " ");
    el2.append(" ", el3, " ");
    el1.append(" ", el2, " ");
    el0.append(el1);
    return el0;
  }
  function createFooterComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("style");
    el1.append("\n    .lh-footer {\n      padding: var(--footer-padding-vertical) calc(var(--default-padding) * 2);\n      max-width: var(--report-content-max-width);\n      margin: 0 auto;\n    }\n    .lh-footer .lh-generated {\n      text-align: center;\n    }\n  ");
    el0.append(el1);
    const el2 = dom2.createElement("footer", "lh-footer");
    const el3 = dom2.createElement("ul", "lh-meta__items");
    el3.append(" ");
    const el4 = dom2.createElement("div", "lh-generated");
    const el5 = dom2.createElement("b");
    el5.append("Lighthouse");
    const el6 = dom2.createElement("span", "lh-footer__version");
    const el7 = dom2.createElement("a", "lh-footer__version_issue");
    el7.setAttribute("href", "https://github.com/GoogleChrome/Lighthouse/issues");
    el7.setAttribute("target", "_blank");
    el7.setAttribute("rel", "noopener");
    el7.append("File an issue");
    el4.append(" ", " Generated by ", el5, " ", el6, " | ", el7, " ");
    el2.append(" ", el3, " ", el4, " ");
    el0.append(el2);
    return el0;
  }
  function createFractionComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("a", "lh-fraction__wrapper");
    const el2 = dom2.createElement("div", "lh-fraction__content-wrapper");
    const el3 = dom2.createElement("div", "lh-fraction__content");
    const el4 = dom2.createElement("div", "lh-fraction__background");
    el3.append(" ", el4, " ");
    el2.append(" ", el3, " ");
    const el5 = dom2.createElement("div", "lh-fraction__label");
    el1.append(" ", el2, " ", el5, " ");
    el0.append(el1);
    return el0;
  }
  function createGaugeComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("a", "lh-gauge__wrapper");
    const el2 = dom2.createElement("div", "lh-gauge__svg-wrapper");
    const el3 = dom2.createElementNS("http://www.w3.org/2000/svg", "svg", "lh-gauge");
    el3.setAttribute("viewBox", "0 0 120 120");
    const el4 = dom2.createElementNS("http://www.w3.org/2000/svg", "circle", "lh-gauge-base");
    el4.setAttribute("r", "56");
    el4.setAttribute("cx", "60");
    el4.setAttribute("cy", "60");
    el4.setAttribute("stroke-width", "8");
    const el5 = dom2.createElementNS("http://www.w3.org/2000/svg", "circle", "lh-gauge-arc");
    el5.setAttribute("r", "56");
    el5.setAttribute("cx", "60");
    el5.setAttribute("cy", "60");
    el5.setAttribute("stroke-width", "8");
    el3.append(" ", el4, " ", el5, " ");
    el2.append(" ", el3, " ");
    const el6 = dom2.createElement("div", "lh-gauge__percentage");
    const el7 = dom2.createElement("div", "lh-gauge__label");
    el1.append(" ", " ", el2, " ", el6, " ", " ", el7, " ");
    el0.append(el1);
    return el0;
  }
  function createHeadingComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("style");
    el1.append("\n    /* CSS Fireworks. Originally by Eddie Lin\n       https://codepen.io/paulirish/pen/yEVMbP\n    */\n    .lh-pyro {\n      display: none;\n      z-index: 1;\n      pointer-events: none;\n    }\n    .lh-score100 .lh-pyro {\n      display: block;\n    }\n    .lh-score100 .lh-lighthouse stop:first-child {\n      stop-color: hsla(200, 12%, 95%, 0);\n    }\n    .lh-score100 .lh-lighthouse stop:last-child {\n      stop-color: hsla(65, 81%, 76%, 1);\n    }\n\n    .lh-pyro > .lh-pyro-before, .lh-pyro > .lh-pyro-after {\n      position: absolute;\n      width: 5px;\n      height: 5px;\n      border-radius: 2.5px;\n      box-shadow: 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff, 0 0 #fff;\n      animation: 1s bang ease-out infinite backwards,  1s gravity ease-in infinite backwards,  5s position linear infinite backwards;\n      animation-delay: 1s, 1s, 1s;\n    }\n\n    .lh-pyro > .lh-pyro-after {\n      animation-delay: 2.25s, 2.25s, 2.25s;\n      animation-duration: 1.25s, 1.25s, 6.25s;\n    }\n\n    @keyframes bang {\n      to {\n        opacity: 1;\n        box-shadow: -70px -115.67px #47ebbc, -28px -99.67px #eb47a4, 58px -31.67px #7eeb47, 13px -141.67px #eb47c5, -19px 6.33px #7347eb, -2px -74.67px #ebd247, 24px -151.67px #eb47e0, 57px -138.67px #b4eb47, -51px -104.67px #479eeb, 62px 8.33px #ebcf47, -93px 0.33px #d547eb, -16px -118.67px #47bfeb, 53px -84.67px #47eb83, 66px -57.67px #eb47bf, -93px -65.67px #91eb47, 30px -13.67px #86eb47, -2px -59.67px #83eb47, -44px 1.33px #eb47eb, 61px -58.67px #47eb73, 5px -22.67px #47e8eb, -66px -28.67px #ebe247, 42px -123.67px #eb5547, -75px 26.33px #7beb47, 15px -52.67px #a147eb, 36px -51.67px #eb8347, -38px -12.67px #eb5547, -46px -59.67px #47eb81, 78px -114.67px #eb47ba, 15px -156.67px #eb47bf, -36px 1.33px #eb4783, -72px -86.67px #eba147, 31px -46.67px #ebe247, -68px 29.33px #47e2eb, -55px 19.33px #ebe047, -56px 27.33px #4776eb, -13px -91.67px #eb5547, -47px -138.67px #47ebc7, -18px -96.67px #eb47ac, 11px -88.67px #4783eb, -67px -28.67px #47baeb, 53px 10.33px #ba47eb, 11px 19.33px #5247eb, -5px -11.67px #eb4791, -68px -4.67px #47eba7, 95px -37.67px #eb478b, -67px -162.67px #eb5d47, -54px -120.67px #eb6847, 49px -12.67px #ebe047, 88px 8.33px #47ebda, 97px 33.33px #eb8147, 6px -71.67px #ebbc47;\n      }\n    }\n    @keyframes gravity {\n      from {\n        opacity: 1;\n      }\n      to {\n        transform: translateY(80px);\n        opacity: 0;\n      }\n    }\n    @keyframes position {\n      0%, 19.9% {\n        margin-top: 4%;\n        margin-left: 47%;\n      }\n      20%, 39.9% {\n        margin-top: 7%;\n        margin-left: 30%;\n      }\n      40%, 59.9% {\n        margin-top: 6%;\n        margin-left: 70%;\n      }\n      60%, 79.9% {\n        margin-top: 3%;\n        margin-left: 20%;\n      }\n      80%, 99.9% {\n        margin-top: 3%;\n        margin-left: 80%;\n      }\n    }\n  ");
    el0.append(el1);
    const el2 = dom2.createElement("div", "lh-header-container");
    const el3 = dom2.createElement("div", "lh-scores-wrapper-placeholder");
    el2.append(" ", el3, " ");
    el0.append(el2);
    return el0;
  }
  function createMetricComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-metric");
    const el2 = dom2.createElement("div", "lh-metric__innerwrap");
    const el3 = dom2.createElement("div", "lh-metric__icon");
    const el4 = dom2.createElement("span", "lh-metric__title");
    const el5 = dom2.createElement("div", "lh-metric__value");
    const el6 = dom2.createElement("div", "lh-metric__description");
    el2.append(" ", el3, " ", el4, " ", el5, " ", el6, " ");
    el1.append(" ", el2, " ");
    el0.append(el1);
    return el0;
  }
  function createScorescaleComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-scorescale");
    const el2 = dom2.createElement("span", "lh-scorescale-range lh-scorescale-range--fail");
    el2.append("0\u201349");
    const el3 = dom2.createElement("span", "lh-scorescale-range lh-scorescale-range--average");
    el3.append("50\u201389");
    const el4 = dom2.createElement("span", "lh-scorescale-range lh-scorescale-range--pass");
    el4.append("90\u2013100");
    el1.append(" ", el2, " ", el3, " ", el4, " ");
    el0.append(el1);
    return el0;
  }
  function createScoresWrapperComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("style");
    el1.append("\n    .lh-scores-container {\n      display: flex;\n      flex-direction: column;\n      padding: var(--default-padding) 0;\n      position: relative;\n      width: 100%;\n    }\n\n    .lh-sticky-header {\n      --gauge-circle-size: var(--gauge-circle-size-sm);\n      --plugin-badge-size: 16px;\n      --plugin-icon-size: 75%;\n      --gauge-wrapper-width: 60px;\n      --gauge-percentage-font-size: 13px;\n      position: fixed;\n      left: 0;\n      right: 0;\n      top: var(--topbar-height);\n      font-weight: 500;\n      display: none;\n      justify-content: center;\n      background-color: var(--sticky-header-background-color);\n      border-bottom: 1px solid var(--color-gray-200);\n      padding-top: var(--score-container-padding);\n      padding-bottom: 4px;\n      z-index: 2;\n      pointer-events: none;\n    }\n\n    .lh-devtools .lh-sticky-header {\n      /* The report within DevTools is placed in a container with overflow, which changes the placement of this header unless we change `position` to `sticky.` */\n      position: sticky;\n    }\n\n    .lh-sticky-header--visible {\n      display: grid;\n      grid-auto-flow: column;\n      pointer-events: auto;\n    }\n\n    /* Disable the gauge arc animation for the sticky header, so toggling display: none\n       does not play the animation. */\n    .lh-sticky-header .lh-gauge-arc {\n      animation: none;\n    }\n\n    .lh-sticky-header .lh-gauge__label,\n    .lh-sticky-header .lh-fraction__label {\n      display: none;\n    }\n\n    .lh-highlighter {\n      width: var(--gauge-wrapper-width);\n      height: 1px;\n      background-color: var(--highlighter-background-color);\n      /* Position at bottom of first gauge in sticky header. */\n      position: absolute;\n      grid-column: 1;\n      bottom: -1px;\n      left: 0px;\n      right: 0px;\n    }\n  ");
    el0.append(el1);
    const el2 = dom2.createElement("div", "lh-scores-wrapper");
    const el3 = dom2.createElement("div", "lh-scores-container");
    const el4 = dom2.createElement("div", "lh-pyro");
    const el5 = dom2.createElement("div", "lh-pyro-before");
    const el6 = dom2.createElement("div", "lh-pyro-after");
    el4.append(" ", el5, " ", el6, " ");
    el3.append(" ", el4, " ");
    el2.append(" ", el3, " ");
    el0.append(el2);
    return el0;
  }
  function createSnippetComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-snippet");
    const el2 = dom2.createElement("style");
    el2.append('\n          :root {\n            --snippet-highlight-light: #fbf1f2;\n            --snippet-highlight-dark: #ffd6d8;\n          }\n\n         .lh-snippet__header {\n          position: relative;\n          overflow: hidden;\n          padding: 10px;\n          border-bottom: none;\n          color: var(--snippet-color);\n          background-color: var(--snippet-background-color);\n          border: 1px solid var(--report-border-color-secondary);\n        }\n        .lh-snippet__title {\n          font-weight: bold;\n          float: left;\n        }\n        .lh-snippet__node {\n          float: left;\n          margin-left: 4px;\n        }\n        .lh-snippet__toggle-expand {\n          padding: 1px 7px;\n          margin-top: -1px;\n          margin-right: -7px;\n          float: right;\n          background: transparent;\n          border: none;\n          cursor: pointer;\n          font-size: 14px;\n          color: #0c50c7;\n        }\n\n        .lh-snippet__snippet {\n          overflow: auto;\n          border: 1px solid var(--report-border-color-secondary);\n        }\n        /* Container needed so that all children grow to the width of the scroll container */\n        .lh-snippet__snippet-inner {\n          display: inline-block;\n          min-width: 100%;\n        }\n\n        .lh-snippet:not(.lh-snippet--expanded) .lh-snippet__show-if-expanded {\n          display: none;\n        }\n        .lh-snippet.lh-snippet--expanded .lh-snippet__show-if-collapsed {\n          display: none;\n        }\n\n        .lh-snippet__line {\n          background: white;\n          white-space: pre;\n          display: flex;\n        }\n        .lh-snippet__line:not(.lh-snippet__line--message):first-child {\n          padding-top: 4px;\n        }\n        .lh-snippet__line:not(.lh-snippet__line--message):last-child {\n          padding-bottom: 4px;\n        }\n        .lh-snippet__line--content-highlighted {\n          background: var(--snippet-highlight-dark);\n        }\n        .lh-snippet__line--message {\n          background: var(--snippet-highlight-light);\n        }\n        .lh-snippet__line--message .lh-snippet__line-number {\n          padding-top: 10px;\n          padding-bottom: 10px;\n        }\n        .lh-snippet__line--message code {\n          padding: 10px;\n          padding-left: 5px;\n          color: var(--color-fail);\n          font-family: var(--report-font-family);\n        }\n        .lh-snippet__line--message code {\n          white-space: normal;\n        }\n        .lh-snippet__line-icon {\n          padding-top: 10px;\n          display: none;\n        }\n        .lh-snippet__line--message .lh-snippet__line-icon {\n          display: block;\n        }\n        .lh-snippet__line-icon:before {\n          content: "";\n          display: inline-block;\n          vertical-align: middle;\n          margin-right: 4px;\n          width: var(--score-icon-size);\n          height: var(--score-icon-size);\n          background-image: var(--fail-icon-url);\n        }\n        .lh-snippet__line-number {\n          flex-shrink: 0;\n          width: 40px;\n          text-align: right;\n          font-family: monospace;\n          padding-right: 5px;\n          margin-right: 5px;\n          color: var(--color-gray-600);\n          user-select: none;\n        }\n    ');
    el1.append(" ", el2, " ");
    el0.append(el1);
    return el0;
  }
  function createSnippetContentComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-snippet__snippet");
    const el2 = dom2.createElement("div", "lh-snippet__snippet-inner");
    el1.append(" ", el2, " ");
    el0.append(el1);
    return el0;
  }
  function createSnippetHeaderComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-snippet__header");
    const el2 = dom2.createElement("div", "lh-snippet__title");
    const el3 = dom2.createElement("div", "lh-snippet__node");
    const el4 = dom2.createElement("button", "lh-snippet__toggle-expand");
    const el5 = dom2.createElement("span", "lh-snippet__btn-label-collapse lh-snippet__show-if-expanded");
    const el6 = dom2.createElement("span", "lh-snippet__btn-label-expand lh-snippet__show-if-collapsed");
    el4.append(" ", el5, " ", el6, " ");
    el1.append(" ", el2, " ", el3, " ", el4, " ");
    el0.append(el1);
    return el0;
  }
  function createSnippetLineComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-snippet__line");
    const el2 = dom2.createElement("div", "lh-snippet__line-number");
    const el3 = dom2.createElement("div", "lh-snippet__line-icon");
    const el4 = dom2.createElement("code");
    el1.append(" ", el2, " ", el3, " ", el4, " ");
    el0.append(el1);
    return el0;
  }
  function createStylesComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("style");
    el1.append(`/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/*
  Naming convention:

  If a variable is used for a specific component: --{component}-{property name}-{modifier}

  Both {component} and {property name} should be kebab-case. If the target is the entire page,
  use 'report' for the component. The property name should not be abbreviated. Use the
  property name the variable is intended for - if it's used for multiple, a common descriptor
  is fine (ex: 'size' for a variable applied to 'width' and 'height'). If a variable is shared
  across multiple components, either create more variables or just drop the "{component}-"
  part of the name. Append any modifiers at the end (ex: 'big', 'dark').

  For colors: --color-{hue}-{intensity}

  {intensity} is the Material Design tag - 700, A700, etc.
*/
.lh-vars {
  /* Palette using Material Design Colors
   * https://www.materialui.co/colors */
  --color-amber-50: #FFF8E1;
  --color-blue-200: #90CAF9;
  --color-blue-900: #0D47A1;
  --color-blue-A700: #2962FF;
  --color-blue-primary: #06f;
  --color-cyan-500: #00BCD4;
  --color-gray-100: #F5F5F5;
  --color-gray-300: #CFCFCF;
  --color-gray-200: #E0E0E0;
  --color-gray-400: #BDBDBD;
  --color-gray-50: #FAFAFA;
  --color-gray-500: #9E9E9E;
  --color-gray-600: #757575;
  --color-gray-700: #616161;
  --color-gray-800: #424242;
  --color-gray-900: #212121;
  --color-gray: #000000;
  --color-green-700: #080;
  --color-green: #0c6;
  --color-lime-400: #D3E156;
  --color-orange-50: #FFF3E0;
  --color-orange-700: #C33300;
  --color-orange: #fa3;
  --color-red-700: #c00;
  --color-red: #f33;
  --color-teal-600: #00897B;
  --color-white: #FFFFFF;

  /* Context-specific colors */
  --color-average-secondary: var(--color-orange-700);
  --color-average: var(--color-orange);
  --color-fail-secondary: var(--color-red-700);
  --color-fail: var(--color-red);
  --color-hover: var(--color-gray-50);
  --color-informative: var(--color-blue-900);
  --color-pass-secondary: var(--color-green-700);
  --color-pass: var(--color-green);
  --color-not-applicable: var(--color-gray-600);

  /* Component variables */
  --audit-description-padding-left: calc(var(--score-icon-size) + var(--score-icon-margin-left) + var(--score-icon-margin-right));
  --audit-explanation-line-height: 16px;
  --audit-group-margin-bottom: calc(var(--default-padding) * 6);
  --audit-group-padding-vertical: 8px;
  --audit-margin-horizontal: 5px;
  --audit-padding-vertical: 8px;
  --category-padding: calc(var(--default-padding) * 6) var(--edge-gap-padding) calc(var(--default-padding) * 4);
  --chevron-line-stroke: var(--color-gray-600);
  --chevron-size: 12px;
  --default-padding: 8px;
  --edge-gap-padding: calc(var(--default-padding) * 4);
  --env-item-background-color: var(--color-gray-100);
  --env-item-font-size: 28px;
  --env-item-line-height: 36px;
  --env-item-padding: 10px 0px;
  --env-name-min-width: 220px;
  --footer-padding-vertical: 16px;
  --gauge-circle-size-big: 96px;
  --gauge-circle-size: 48px;
  --gauge-circle-size-sm: 32px;
  --gauge-label-font-size-big: 18px;
  --gauge-label-font-size: var(--report-font-size-secondary);
  --gauge-label-line-height-big: 24px;
  --gauge-label-line-height: var(--report-line-height-secondary);
  --gauge-percentage-font-size-big: 38px;
  --gauge-percentage-font-size: var(--report-font-size-secondary);
  --gauge-wrapper-width: 120px;
  --header-line-height: 24px;
  --highlighter-background-color: var(--report-text-color);
  --icon-square-size: calc(var(--score-icon-size) * 0.88);
  --image-preview-size: 48px;
  --link-color: var(--color-blue-primary);
  --locale-selector-background-color: var(--color-white);
  --metric-toggle-lines-fill: #7F7F7F;
  --metric-value-font-size: calc(var(--report-font-size) * 1.8);
  --metrics-toggle-background-color: var(--color-gray-200);
  --plugin-badge-background-color: var(--color-white);
  --plugin-badge-size-big: calc(var(--gauge-circle-size-big) / 2.7);
  --plugin-badge-size: calc(var(--gauge-circle-size) / 2.7);
  --plugin-icon-size: 65%;
  --report-background-color: #fff;
  --report-border-color-secondary: #ebebeb;
  --report-font-family-monospace: 'Roboto Mono', 'Menlo', 'dejavu sans mono', 'Consolas', 'Lucida Console', monospace;
  --report-font-family: Roboto, Helvetica, Arial, sans-serif;
  --report-font-size: 14px;
  --report-font-size-secondary: 12px;
  --report-icon-size: var(--score-icon-background-size);
  --report-line-height: 24px;
  --report-line-height-secondary: 20px;
  --report-monospace-font-size: calc(var(--report-font-size) * 0.85);
  --report-text-color-secondary: var(--color-gray-800);
  --report-text-color: var(--color-gray-900);
  --report-content-max-width: calc(60 * var(--report-font-size)); /* defaults to 840px */
  --report-content-min-width: 360px;
  --report-content-max-width-minus-edge-gap: calc(var(--report-content-max-width) - var(--edge-gap-padding) * 2);
  --score-container-padding: 8px;
  --score-icon-background-size: 24px;
  --score-icon-margin-left: 6px;
  --score-icon-margin-right: 14px;
  --score-icon-margin: 0 var(--score-icon-margin-right) 0 var(--score-icon-margin-left);
  --score-icon-size: 12px;
  --score-icon-size-big: 16px;
  --screenshot-overlay-background: rgba(0, 0, 0, 0.3);
  --section-padding-vertical: calc(var(--default-padding) * 6);
  --snippet-background-color: var(--color-gray-50);
  --snippet-color: #0938C2;
  --stackpack-padding-horizontal: 10px;
  --sticky-header-background-color: var(--report-background-color);
  --sticky-header-buffer: var(--topbar-height);
  --sticky-header-height: calc(var(--gauge-circle-size-sm) + var(--score-container-padding) * 2 + 1em);
  --table-group-header-background-color: #EEF1F4;
  --table-group-header-text-color: var(--color-gray-700);
  --table-higlight-background-color: #F5F7FA;
  --tools-icon-color: var(--color-gray-600);
  --topbar-background-color: var(--color-white);
  --topbar-height: 32px;
  --topbar-logo-size: 24px;
  --topbar-padding: 0 8px;
  --toplevel-warning-background-color: hsla(30, 100%, 75%, 10%);
  --toplevel-warning-message-text-color: var(--color-average-secondary);
  --toplevel-warning-padding: 18px;
  --toplevel-warning-text-color: var(--report-text-color);

  /* SVGs */
  --plugin-icon-url-dark: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24px" height="24px" viewBox="0 0 24 24" fill="%23FFFFFF"><path d="M0 0h24v24H0z" fill="none"/><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>');
  --plugin-icon-url: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24px" height="24px" viewBox="0 0 24 24" fill="%23757575"><path d="M0 0h24v24H0z" fill="none"/><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>');

  --pass-icon-url: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><title>check</title><path fill="%23178239" d="M24 4C12.95 4 4 12.95 4 24c0 11.04 8.95 20 20 20 11.04 0 20-8.96 20-20 0-11.05-8.96-20-20-20zm-4 30L10 24l2.83-2.83L20 28.34l15.17-15.17L38 16 20 34z"/></svg>');
  --average-icon-url: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><title>info</title><path fill="%23E67700" d="M24 4C12.95 4 4 12.95 4 24s8.95 20 20 20 20-8.95 20-20S35.05 4 24 4zm2 30h-4V22h4v12zm0-16h-4v-4h4v4z"/></svg>');
  --fail-icon-url: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><title>warn</title><path fill="%23C7221F" d="M2 42h44L24 4 2 42zm24-6h-4v-4h4v4zm0-8h-4v-8h4v8z"/></svg>');
  --error-icon-url: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 15"><title>error</title><path d="M0 15H 3V 12H 0V" fill="%23FF4E42"/><path d="M0 9H 3V 0H 0V" fill="%23FF4E42"/></svg>');

  --swap-locale-icon-url: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="#000000"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>');
}

@media not print {
  .lh-dark {
    /* Pallete */
    --color-gray-200: var(--color-gray-800);
    --color-gray-300: #616161;
    --color-gray-400: var(--color-gray-600);
    --color-gray-700: var(--color-gray-400);
    --color-gray-50: #757575;
    --color-gray-600: var(--color-gray-500);
    --color-green-700: var(--color-green);
    --color-orange-700: var(--color-orange);
    --color-red-700: var(--color-red);
    --color-teal-600: var(--color-cyan-500);

    /* Context-specific colors */
    --color-hover: rgba(0, 0, 0, 0.2);
    --color-informative: var(--color-blue-200);

    /* Component variables */
    --env-item-background-color: #393535;
    --link-color: var(--color-blue-200);
    --locale-selector-background-color: var(--color-gray-200);
    --plugin-badge-background-color: var(--color-gray-800);
    --report-background-color: var(--color-gray-900);
    --report-border-color-secondary: var(--color-gray-200);
    --report-text-color-secondary: var(--color-gray-400);
    --report-text-color: var(--color-gray-100);
    --snippet-color: var(--color-cyan-500);
    --topbar-background-color: var(--color-gray);
    --toplevel-warning-background-color: hsl(33deg 14% 18%);
    --toplevel-warning-message-text-color: var(--color-orange-700);
    --toplevel-warning-text-color: var(--color-gray-100);
    --table-group-header-background-color: rgba(186, 196, 206, 0.15);
    --table-group-header-text-color: var(--color-gray-100);
    --table-higlight-background-color: rgba(186, 196, 206, 0.09);

    /* SVGs */
    --plugin-icon-url: var(--plugin-icon-url-dark);
  }
}

@media only screen and (max-width: 480px) {
  .lh-vars {
    --audit-group-margin-bottom: 20px;
    --edge-gap-padding: var(--default-padding);
    --env-name-min-width: 120px;
    --gauge-circle-size-big: 96px;
    --gauge-circle-size: 72px;
    --gauge-label-font-size-big: 22px;
    --gauge-label-font-size: 14px;
    --gauge-label-line-height-big: 26px;
    --gauge-label-line-height: 20px;
    --gauge-percentage-font-size-big: 34px;
    --gauge-percentage-font-size: 26px;
    --gauge-wrapper-width: 112px;
    --header-padding: 16px 0 16px 0;
    --image-preview-size: 24px;
    --plugin-icon-size: 75%;
    --report-font-size: 14px;
    --report-line-height: 20px;
    --score-icon-margin-left: 2px;
    --score-icon-size: 10px;
    --topbar-height: 28px;
    --topbar-logo-size: 20px;
  }
}

.lh-vars.lh-devtools {
  --audit-explanation-line-height: 14px;
  --audit-group-margin-bottom: 20px;
  --audit-group-padding-vertical: 12px;
  --audit-padding-vertical: 4px;
  --category-padding: 12px;
  --default-padding: 12px;
  --env-name-min-width: 120px;
  --footer-padding-vertical: 8px;
  --gauge-circle-size-big: 72px;
  --gauge-circle-size: 64px;
  --gauge-label-font-size-big: 22px;
  --gauge-label-font-size: 14px;
  --gauge-label-line-height-big: 26px;
  --gauge-label-line-height: 20px;
  --gauge-percentage-font-size-big: 34px;
  --gauge-percentage-font-size: 26px;
  --gauge-wrapper-width: 97px;
  --header-line-height: 20px;
  --header-padding: 16px 0 16px 0;
  --screenshot-overlay-background: transparent;
  --plugin-icon-size: 75%;
  --report-font-family-monospace: 'Menlo', 'dejavu sans mono', 'Consolas', 'Lucida Console', monospace;
  --report-font-family: '.SFNSDisplay-Regular', 'Helvetica Neue', 'Lucida Grande', sans-serif;
  --report-font-size: 12px;
  --report-line-height: 20px;
  --score-icon-margin-left: 2px;
  --score-icon-size: 10px;
  --section-padding-vertical: 8px;
}

.lh-container:has(.lh-sticky-header) {
  --sticky-header-buffer: calc(var(--topbar-height) + var(--sticky-header-height));
}

.lh-container:not(.lh-topbar + .lh-container) {
  --topbar-height: 0;
  --sticky-header-height: 0;
  --sticky-header-buffer: 0;
}

.lh-max-viewport {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  width: 100%;
}

.lh-devtools.lh-root {
  height: 100%;
}
.lh-devtools.lh-root img {
  /* Override devtools default 'min-width: 0' so svg without size in a flexbox isn't collapsed. */
  min-width: auto;
}
.lh-devtools .lh-container {
  overflow-y: scroll;
  height: calc(100% - var(--topbar-height));
  /** The .lh-container is the scroll parent in DevTools so we exclude the topbar from the sticky header buffer. */
  --sticky-header-buffer: 0;
}
.lh-devtools .lh-container:has(.lh-sticky-header) {
  /** The .lh-container is the scroll parent in DevTools so we exclude the topbar from the sticky header buffer. */
  --sticky-header-buffer: var(--sticky-header-height);
}
@media print {
  .lh-devtools .lh-container {
    overflow: unset;
  }
}
.lh-devtools .lh-sticky-header {
  /* This is normally the height of the topbar, but we want it to stick to the top of our scroll container .lh-container\` */
  top: 0;
}
.lh-devtools .lh-element-screenshot__overlay {
  position: absolute;
}

@keyframes fadeIn {
  0% { opacity: 0;}
  100% { opacity: 0.6;}
}

.lh-root *, .lh-root *::before, .lh-root *::after {
  box-sizing: border-box;
}

.lh-root {
  font-family: var(--report-font-family);
  font-size: var(--report-font-size);
  margin: 0;
  line-height: var(--report-line-height);
  background: var(--report-background-color);
  color: var(--report-text-color);
}

.lh-root :focus-visible {
    outline: -webkit-focus-ring-color auto 3px;
}
.lh-root summary:focus {
    outline: none;
    box-shadow: 0 0 0 1px hsl(217, 89%, 61%);
}

.lh-root [hidden] {
  display: none !important;
}

.lh-root pre {
  margin: 0;
}

.lh-root pre,
.lh-root code {
  font-family: var(--report-font-family-monospace);
}

.lh-root details > summary {
  cursor: pointer;
}

.lh-hidden {
  display: none !important;
}

.lh-container {
  /*
  Text wrapping in the report is so much FUN!
  We have a \`word-break: break-word;\` globally here to prevent a few common scenarios, namely
  long non-breakable text (usually URLs) found in:
    1. The footer
    2. .lh-node (outerHTML)
    3. .lh-code

  With that sorted, the next challenge is appropriate column sizing and text wrapping inside our
  .lh-details tables. Even more fun.
    * We don't want table headers ("Potential Savings (ms)") to wrap or their column values, but
    we'd be happy for the URL column to wrap if the URLs are particularly long.
    * We want the narrow columns to remain narrow, providing the most column width for URL
    * We don't want the table to extend past 100% width.
    * Long URLs in the URL column can wrap. Util.getURLDisplayName maxes them out at 64 characters,
      but they do not get any overflow:ellipsis treatment.
  */
  word-break: break-word;
}

.lh-audit-group a,
.lh-category-header__description a,
.lh-audit__description a,
.lh-warnings a,
.lh-footer a,
.lh-table-column--link a {
  color: var(--link-color);
}

.lh-audit__description, .lh-audit__stackpack {
  --inner-audit-padding-right: var(--stackpack-padding-horizontal);
  padding-left: var(--audit-description-padding-left);
  padding-right: var(--inner-audit-padding-right);
  padding-top: 8px;
  padding-bottom: 8px;
}

.lh-details {
  margin-top: var(--default-padding);
  margin-bottom: var(--default-padding);
  margin-left: var(--audit-description-padding-left);
  /* whatever the .lh-details side margins are */
  width: 100%;
}

.lh-audit__stackpack {
  display: flex;
  align-items: center;
}

.lh-audit__stackpack__img {
  max-width: 30px;
  margin-right: var(--default-padding)
}

/* Report header */

.lh-report-icon {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  cursor: pointer;
}
.lh-report-icon[disabled] {
  opacity: 0.3;
  pointer-events: none;
}

.lh-report-icon::before {
  content: "";
  margin: 4px;
  background-repeat: no-repeat;
  width: var(--report-icon-size);
  height: var(--report-icon-size);
  opacity: 0.7;
  display: inline-block;
  vertical-align: middle;
}
.lh-report-icon:hover::before {
  opacity: 1;
}
.lh-dark .lh-report-icon::before {
  filter: invert(1);
}
.lh-report-icon--print::before {
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/><path fill="none" d="M0 0h24v24H0z"/></svg>');
}
.lh-report-icon--copy::before {
  background-image: url('data:image/svg+xml;utf8,<svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24v24H0z" fill="none"/><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>');
}
.lh-report-icon--open::before {
  background-image: url('data:image/svg+xml;utf8,<svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24v24H0z" fill="none"/><path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h4v-2H5V8h14v10h-4v2h4c1.1 0 2-.9 2-2V6c0-1.1-.89-2-2-2zm-7 6l-4 4h3v6h2v-6h3l-4-4z"/></svg>');
}
.lh-report-icon--download::before {
  background-image: url('data:image/svg+xml;utf8,<svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/><path d="M0 0h24v24H0z" fill="none"/></svg>');
}
.lh-report-icon--dark::before {
  background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 100 125"><path d="M50 23.587c-16.27 0-22.799 12.574-22.799 21.417 0 12.917 10.117 22.451 12.436 32.471h20.726c2.32-10.02 12.436-19.554 12.436-32.471 0-8.843-6.528-21.417-22.799-21.417zM39.637 87.161c0 3.001 1.18 4.181 4.181 4.181h.426l.41 1.231C45.278 94.449 46.042 95 48.019 95h3.963c1.978 0 2.74-.551 3.365-2.427l.409-1.231h.427c3.002 0 4.18-1.18 4.18-4.181V80.91H39.637v6.251zM50 18.265c1.26 0 2.072-.814 2.072-2.073v-9.12C52.072 5.813 51.26 5 50 5c-1.259 0-2.072.813-2.072 2.073v9.12c0 1.259.813 2.072 2.072 2.072zM68.313 23.727c.994.774 2.135.634 2.91-.357l5.614-7.187c.776-.992.636-2.135-.356-2.909-.992-.776-2.135-.636-2.91.357l-5.613 7.186c-.778.993-.636 2.135.355 2.91zM91.157 36.373c-.306-1.222-1.291-1.815-2.513-1.51l-8.85 2.207c-1.222.305-1.814 1.29-1.51 2.512.305 1.223 1.291 1.814 2.513 1.51l8.849-2.206c1.223-.305 1.816-1.291 1.511-2.513zM86.757 60.48l-8.331-3.709c-1.15-.512-2.225-.099-2.736 1.052-.512 1.151-.1 2.224 1.051 2.737l8.33 3.707c1.15.514 2.225.101 2.736-1.05.513-1.149.1-2.223-1.05-2.737zM28.779 23.37c.775.992 1.917 1.131 2.909.357.992-.776 1.132-1.917.357-2.91l-5.615-7.186c-.775-.992-1.917-1.132-2.909-.357s-1.131 1.917-.356 2.909l5.614 7.187zM21.715 39.583c.305-1.223-.288-2.208-1.51-2.513l-8.849-2.207c-1.222-.303-2.208.289-2.513 1.511-.303 1.222.288 2.207 1.511 2.512l8.848 2.206c1.222.304 2.208-.287 2.513-1.509zM21.575 56.771l-8.331 3.711c-1.151.511-1.563 1.586-1.05 2.735.511 1.151 1.586 1.563 2.736 1.052l8.331-3.711c1.151-.511 1.563-1.586 1.05-2.735-.512-1.15-1.585-1.562-2.736-1.052z"/></svg>');
}
.lh-report-icon--treemap::before {
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="black"><path d="M3 5v14h19V5H3zm2 2h15v4H5V7zm0 10v-4h4v4H5zm6 0v-4h9v4h-9z"/></svg>');
}
.lh-report-icon--date::before {
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7 11h2v2H7v-2zm14-5v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6c0-1.1.9-2 2-2h1V2h2v2h8V2h2v2h1a2 2 0 012 2zM5 8h14V6H5v2zm14 12V10H5v10h14zm-4-7h2v-2h-2v2zm-4 0h2v-2h-2v2z"/></svg>');
}
.lh-report-icon--devices::before {
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 6h18V4H4a2 2 0 00-2 2v11H0v3h14v-3H4V6zm19 2h-6a1 1 0 00-1 1v10c0 .6.5 1 1 1h6c.6 0 1-.5 1-1V9c0-.6-.5-1-1-1zm-1 9h-4v-7h4v7z"/></svg>');
}
.lh-report-icon--world::before {
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm7 6h-3c-.3-1.3-.8-2.5-1.4-3.6A8 8 0 0 1 18.9 8zm-7-4a14 14 0 0 1 2 4h-4a14 14 0 0 1 2-4zM4.3 14a8.2 8.2 0 0 1 0-4h3.3a16.5 16.5 0 0 0 0 4H4.3zm.8 2h3a14 14 0 0 0 1.3 3.6A8 8 0 0 1 5.1 16zm3-8H5a8 8 0 0 1 4.3-3.6L8 8zM12 20a14 14 0 0 1-2-4h4a14 14 0 0 1-2 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.6 14.6 0 0 1 0 4zm.3 5.6c.6-1.2 1-2.4 1.4-3.6h3a8 8 0 0 1-4.4 3.6zm1.8-5.6a16.5 16.5 0 0 0 0-4h3.3a8.2 8.2 0 0 1 0 4h-3.3z"/></svg>');
}
.lh-report-icon--stopwatch::before {
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M15 1H9v2h6V1zm-4 13h2V8h-2v6zm8.1-6.6L20.5 6l-1.4-1.4L17.7 6A9 9 0 0 0 3 13a9 9 0 1 0 16-5.6zm-7 12.6a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/></svg>');
}
.lh-report-icon--networkspeed::before {
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M15.9 5c-.2 0-.3 0-.4.2v.2L10.1 17a2 2 0 0 0-.2 1 2 2 0 0 0 4 .4l2.4-12.9c0-.3-.2-.5-.5-.5zM1 9l2 2c2.9-2.9 6.8-4 10.5-3.6l1.2-2.7C10 3.8 4.7 5.3 1 9zm20 2 2-2a15.4 15.4 0 0 0-5.6-3.6L17 8.2c1.5.7 2.9 1.6 4.1 2.8zm-4 4 2-2a9.9 9.9 0 0 0-2.7-1.9l-.5 3 1.2.9zM5 13l2 2a7.1 7.1 0 0 1 4-2l1.3-2.9C9.7 10.1 7 11 5 13z"/></svg>');
}
.lh-report-icon--samples-one::before {
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="7" cy="14" r="3"/><path d="M7 18a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm4-2a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm5.6 17.6a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>');
}
.lh-report-icon--samples-many::before {
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7 18a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm4-2a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm5.6 17.6a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/><circle cx="7" cy="14" r="3"/><circle cx="11" cy="6" r="3"/></svg>');
}
.lh-report-icon--chrome::before {
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 562 562"><path d="M256 25.6v25.6a204 204 0 0 1 144.8 60 204 204 0 0 1 60 144.8 204 204 0 0 1-60 144.8 204 204 0 0 1-144.8 60 204 204 0 0 1-144.8-60 204 204 0 0 1-60-144.8 204 204 0 0 1 60-144.8 204 204 0 0 1 144.8-60V0a256 256 0 1 0 0 512 256 256 0 0 0 0-512v25.6z"/><path d="M256 179.2v25.6a51.3 51.3 0 0 1 0 102.4 51.3 51.3 0 0 1 0-102.4v-51.2a102.3 102.3 0 1 0-.1 204.7 102.3 102.3 0 0 0 .1-204.7v25.6z"/><path d="M256 204.8h217.6a25.6 25.6 0 0 0 0-51.2H256a25.6 25.6 0 0 0 0 51.2m44.3 76.8L191.5 470.1a25.6 25.6 0 1 0 44.4 25.6l108.8-188.5a25.6 25.6 0 1 0-44.4-25.6m-88.6 0L102.9 93.2a25.7 25.7 0 0 0-35-9.4 25.7 25.7 0 0 0-9.4 35l108.8 188.5a25.7 25.7 0 0 0 35 9.4 25.9 25.9 0 0 0 9.4-35.1"/></svg>');
}
.lh-report-icon--external::before {
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><path d="M3.15 11.9a1.01 1.01 0 0 1-.743-.307 1.01 1.01 0 0 1-.306-.743v-7.7c0-.292.102-.54.306-.744a1.01 1.01 0 0 1 .744-.306H7v1.05H3.15v7.7h7.7V7h1.05v3.85c0 .291-.103.54-.307.743a1.01 1.01 0 0 1-.743.307h-7.7Zm2.494-2.8-.743-.744 5.206-5.206H8.401V2.1h3.5v3.5h-1.05V3.893L5.644 9.1Z"/></svg>');
}

.lh-buttons {
  display: flex;
  flex-wrap: wrap;
  margin: var(--default-padding) 0;
}
.lh-button {
  height: 32px;
  border: 1px solid var(--report-border-color-secondary);
  border-radius: 3px;
  color: var(--link-color);
  background-color: var(--report-background-color);
  margin: 5px;
}

.lh-button:first-of-type {
  margin-left: 0;
}

/* Node */
.lh-node__snippet {
  font-family: var(--report-font-family-monospace);
  color: var(--snippet-color);
  font-size: var(--report-monospace-font-size);
  line-height: 20px;
}

/* Score */

.lh-audit__score-icon {
  width: var(--score-icon-size);
  height: var(--score-icon-size);
  margin: var(--score-icon-margin);
}

.lh-audit--pass .lh-audit__display-text {
  color: var(--color-pass-secondary);
}
.lh-audit--pass .lh-audit__score-icon,
.lh-scorescale-range--pass::before {
  border-radius: 100%;
  background: var(--color-pass);
}

.lh-audit--average .lh-audit__display-text {
  color: var(--color-average-secondary);
}
.lh-audit--average .lh-audit__score-icon,
.lh-scorescale-range--average::before {
  background: var(--color-average);
  width: var(--icon-square-size);
  height: var(--icon-square-size);
}

.lh-audit--fail .lh-audit__display-text {
  color: var(--color-fail-secondary);
}
.lh-audit--fail .lh-audit__score-icon,
.lh-audit--error .lh-audit__score-icon,
.lh-scorescale-range--fail::before {
  border-left: calc(var(--score-icon-size) / 2) solid transparent;
  border-right: calc(var(--score-icon-size) / 2) solid transparent;
  border-bottom: var(--score-icon-size) solid var(--color-fail);
}

.lh-audit--error .lh-audit__score-icon,
.lh-metric--error .lh-metric__icon {
  background-image: var(--error-icon-url);
  background-repeat: no-repeat;
  background-position: center;
  border: none;
}

.lh-gauge__wrapper--fail .lh-gauge--error {
  background-image: var(--error-icon-url);
  background-repeat: no-repeat;
  background-position: center;
  transform: scale(0.5);
  top: var(--score-container-padding);
}

.lh-audit--manual .lh-audit__display-text,
.lh-audit--notapplicable .lh-audit__display-text {
  color: var(--color-gray-600);
}
.lh-audit--manual .lh-audit__score-icon,
.lh-audit--notapplicable .lh-audit__score-icon {
  border: calc(0.2 * var(--score-icon-size)) solid var(--color-gray-400);
  border-radius: 100%;
  background: none;
}

.lh-audit--informative .lh-audit__display-text {
  color: var(--color-gray-600);
}

.lh-audit--informative .lh-audit__score-icon {
  border: calc(0.2 * var(--score-icon-size)) solid var(--color-gray-400);
  border-radius: 100%;
}

.lh-audit__description,
.lh-audit__stackpack {
  color: var(--report-text-color-secondary);
}
.lh-audit__adorn {
  border: 1px solid var(--color-gray-500);
  border-radius: 3px;
  margin: 0 3px;
  padding: 0 2px;
  line-height: 1.1;
  display: inline-block;
  font-size: 90%;
  color: var(--report-text-color-secondary);
}

.lh-category-header__description  {
  text-align: center;
  color: var(--color-gray-700);
  margin: 0px auto;
  max-width: 400px;
}


.lh-audit__display-text,
.lh-chevron-container {
  margin: 0 var(--audit-margin-horizontal);
}
.lh-chevron-container {
  margin-right: 0;
}

.lh-audit__title-and-text {
  flex: 1;
}

.lh-audit__title-and-text code {
  color: var(--snippet-color);
  font-size: var(--report-monospace-font-size);
}

/* Prepend display text with em dash separator. */
.lh-audit__display-text:not(:empty):before {
  content: '\u2014';
  margin-right: var(--audit-margin-horizontal);
}

/* Expandable Details (Audit Groups, Audits) */
.lh-audit__header {
  display: flex;
  align-items: center;
  padding: var(--default-padding);
}


.lh-metricfilter {
  display: grid;
  justify-content: end;
  align-items: center;
  grid-auto-flow: column;
  gap: 4px;
  color: var(--color-gray-700);
}

.lh-metricfilter__radio {
  /*
   * Instead of hiding, position offscreen so it's still accessible to screen readers
   * https://bugs.chromium.org/p/chromium/issues/detail?id=1439785
   */
  position: fixed;
  left: -9999px;
}
.lh-metricfilter input[type='radio']:focus-visible + label {
  outline: -webkit-focus-ring-color auto 1px;
}

.lh-metricfilter__label {
  display: inline-flex;
  padding: 0 4px;
  height: 16px;
  text-decoration: underline;
  align-items: center;
  cursor: pointer;
  font-size: 90%;
}

.lh-metricfilter__label--active {
  background: var(--color-blue-primary);
  color: var(--color-white);
  border-radius: 3px;
  text-decoration: none;
}
/* Give the 'All' choice a more muted display */
.lh-metricfilter__label--active[for="metric-All"] {
  background-color: var(--color-blue-200) !important;
  color: black !important;
}

.lh-metricfilter__text {
  margin-right: 8px;
}

/* If audits are filtered, hide the itemcount for Passed Audits\u2026 */
.lh-category--filtered .lh-audit-group .lh-audit-group__itemcount {
  display: none;
}


.lh-audit__header:hover {
  background-color: var(--color-hover);
}

/* We want to hide the browser's default arrow marker on summary elements. Admittedly, it's complicated. */
.lh-root details > summary {
  /* Blink 89+ and Firefox will hide the arrow when display is changed from (new) default of \`list-item\` to block.  https://chromestatus.com/feature/6730096436051968*/
  display: block;
}
/* Safari and Blink <=88 require using the -webkit-details-marker selector */
.lh-root details > summary::-webkit-details-marker {
  display: none;
}

/* Perf Metric */

.lh-metrics-container {
  display: grid;
  grid-auto-rows: 1fr;
  grid-template-columns: 1fr 1fr;
  grid-column-gap: var(--report-line-height);
  margin-bottom: var(--default-padding);
}

.lh-metric {
  border-top: 1px solid var(--report-border-color-secondary);
}

.lh-category:not(.lh--hoisted-meta) .lh-metric:nth-last-child(-n+2) {
  border-bottom: 1px solid var(--report-border-color-secondary);
}

.lh-metric__innerwrap {
  display: grid;
  /**
   * Icon -- Metric Name
   *      -- Metric Value
   */
  grid-template-columns: calc(var(--score-icon-size) + var(--score-icon-margin-left) + var(--score-icon-margin-right)) 1fr;
  align-items: center;
  padding: var(--default-padding);
}

.lh-metric__details {
  order: -1;
}

.lh-metric__title {
  flex: 1;
}

.lh-calclink {
  padding-left: calc(1ex / 3);
}

.lh-metric__description {
  display: none;
  grid-column-start: 2;
  grid-column-end: 4;
  color: var(--report-text-color-secondary);
}

.lh-metric__value {
  font-size: var(--metric-value-font-size);
  margin: calc(var(--default-padding) / 2) 0;
  white-space: nowrap; /* No wrapping between metric value and the icon */
  grid-column-start: 2;
}


@media screen and (max-width: 535px) {
  .lh-metrics-container {
    display: block;
  }

  .lh-metric {
    border-bottom: none !important;
  }
  .lh-category:not(.lh--hoisted-meta) .lh-metric:nth-last-child(1) {
    border-bottom: 1px solid var(--report-border-color-secondary) !important;
  }

  /* Change the grid to 3 columns for narrow viewport. */
  .lh-metric__innerwrap {
  /**
   * Icon -- Metric Name -- Metric Value
   */
    grid-template-columns: calc(var(--score-icon-size) + var(--score-icon-margin-left) + var(--score-icon-margin-right)) 2fr 1fr;
  }
  .lh-metric__value {
    justify-self: end;
    grid-column-start: unset;
  }
}

/* No-JS toggle switch */
/* Keep this selector sync'd w/ \`magicSelector\` in report-ui-features-test.js */
 .lh-metrics-toggle__input:checked ~ .lh-metrics-container .lh-metric__description {
  display: block;
}

/* TODO get rid of the SVGS and clean up these some more */
.lh-metrics-toggle__input {
  opacity: 0;
  position: absolute;
  right: 0;
  top: 0px;
}

.lh-metrics-toggle__input + div > label > .lh-metrics-toggle__labeltext--hide,
.lh-metrics-toggle__input:checked + div > label > .lh-metrics-toggle__labeltext--show {
  display: none;
}
.lh-metrics-toggle__input:checked + div > label > .lh-metrics-toggle__labeltext--hide {
  display: inline;
}
.lh-metrics-toggle__input:focus + div > label {
  outline: -webkit-focus-ring-color auto 3px;
}

.lh-metrics-toggle__label {
  cursor: pointer;
  font-size: var(--report-font-size-secondary);
  line-height: var(--report-line-height-secondary);
  color: var(--color-gray-700);
}

/* Pushes the metric description toggle button to the right. */
.lh-audit-group--metrics .lh-audit-group__header {
  display: flex;
  justify-content: space-between;
}

.lh-metric__icon,
.lh-scorescale-range::before {
  content: '';
  width: var(--score-icon-size);
  height: var(--score-icon-size);
  display: inline-block;
  margin: var(--score-icon-margin);
}

.lh-metric--pass .lh-metric__value {
  color: var(--color-pass-secondary);
}
.lh-metric--pass .lh-metric__icon {
  border-radius: 100%;
  background: var(--color-pass);
}

.lh-metric--average .lh-metric__value {
  color: var(--color-average-secondary);
}
.lh-metric--average .lh-metric__icon {
  background: var(--color-average);
  width: var(--icon-square-size);
  height: var(--icon-square-size);
}

.lh-metric--fail .lh-metric__value {
  color: var(--color-fail-secondary);
}
.lh-metric--fail .lh-metric__icon {
  border-left: calc(var(--score-icon-size) / 2) solid transparent;
  border-right: calc(var(--score-icon-size) / 2) solid transparent;
  border-bottom: var(--score-icon-size) solid var(--color-fail);
}

.lh-metric--error .lh-metric__value,
.lh-metric--error .lh-metric__description {
  color: var(--color-fail-secondary);
}

/* Filmstrip */

.lh-filmstrip-container {
  /* smaller gap between metrics and filmstrip */
  margin: -8px auto 0 auto;
}

.lh-filmstrip {
  display: flex;
  justify-content: space-between;
  justify-items: center;
  margin-bottom: var(--default-padding);
  width: 100%;
}

.lh-filmstrip__frame {
  overflow: hidden;
  line-height: 0;
}

.lh-filmstrip__thumbnail {
  border: 1px solid var(--report-border-color-secondary);
  max-height: 150px;
  max-width: 120px;
}

/* Audit */

.lh-audit {
  border-bottom: 1px solid var(--report-border-color-secondary);
}

/* Apply border-top to just the first audit. */
.lh-audit {
  border-top: 1px solid var(--report-border-color-secondary);
}
.lh-audit ~ .lh-audit {
  border-top: none;
}


.lh-audit--error .lh-audit__display-text {
  color: var(--color-fail-secondary);
}

/* Audit Group */

.lh-audit-group {
  margin-bottom: var(--audit-group-margin-bottom);
  position: relative;
}
.lh-audit-group--metrics {
  margin-bottom: calc(var(--audit-group-margin-bottom) / 2);
}

.lh-audit-group--metrics .lh-audit-group__summary {
  margin-top: 0;
  margin-bottom: 0;
}

.lh-audit-group__summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.lh-audit-group__header .lh-chevron {
  margin-top: calc((var(--report-line-height) - 5px) / 2);
}

.lh-audit-group__header {
  letter-spacing: 0.8px;
  padding: var(--default-padding);
  padding-left: 0;
}

.lh-audit-group__header, .lh-audit-group__summary {
  font-size: var(--report-font-size-secondary);
  line-height: var(--report-line-height-secondary);
  color: var(--color-gray-700);
}

.lh-audit-group__title {
  text-transform: uppercase;
  font-weight: 500;
}

.lh-audit-group__itemcount {
  color: var(--color-gray-600);
}

.lh-audit-group__footer {
  color: var(--color-gray-600);
  display: block;
  margin-top: var(--default-padding);
}

.lh-details,
.lh-category-header__description,
.lh-audit-group__footer {
  font-size: var(--report-font-size-secondary);
  line-height: var(--report-line-height-secondary);
}

.lh-audit-explanation {
  margin: var(--audit-padding-vertical) 0 calc(var(--audit-padding-vertical) / 2) var(--audit-margin-horizontal);
  line-height: var(--audit-explanation-line-height);
  display: inline-block;
}

.lh-audit--fail .lh-audit-explanation {
  color: var(--color-fail-secondary);
}

/* Report */
.lh-list > :not(:last-child) {
  margin-bottom: calc(var(--default-padding) * 2);
}

.lh-header-container {
  display: block;
  margin: 0 auto;
  position: relative;
  word-wrap: break-word;
}

.lh-header-container .lh-scores-wrapper {
  border-bottom: 1px solid var(--color-gray-200);
}


.lh-report {
  min-width: var(--report-content-min-width);
}

.lh-exception {
  font-size: large;
}

.lh-code {
  white-space: normal;
  margin-top: 0;
  font-size: var(--report-monospace-font-size);
}

.lh-warnings {
  --item-margin: calc(var(--report-line-height) / 6);
  color: var(--color-average-secondary);
  margin: var(--audit-padding-vertical) 0;
  padding: var(--default-padding)
    var(--default-padding)
    var(--default-padding)
    calc(var(--audit-description-padding-left));
  background-color: var(--toplevel-warning-background-color);
}
.lh-warnings span {
  font-weight: bold;
}

.lh-warnings--toplevel {
  --item-margin: calc(var(--header-line-height) / 4);
  color: var(--toplevel-warning-text-color);
  margin-left: auto;
  margin-right: auto;
  max-width: var(--report-content-max-width-minus-edge-gap);
  padding: var(--toplevel-warning-padding);
  border-radius: 8px;
}

.lh-warnings__msg {
  color: var(--toplevel-warning-message-text-color);
  margin: 0;
}

.lh-warnings ul {
  margin: 0;
}
.lh-warnings li {
  margin: var(--item-margin) 0;
}
.lh-warnings li:last-of-type {
  margin-bottom: 0;
}

.lh-scores-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
}
.lh-scores-header__solo {
  padding: 0;
  border: 0;
}

/* Gauge */

.lh-gauge__wrapper--pass {
  color: var(--color-pass-secondary);
  fill: var(--color-pass);
  stroke: var(--color-pass);
}

.lh-gauge__wrapper--average {
  color: var(--color-average-secondary);
  fill: var(--color-average);
  stroke: var(--color-average);
}

.lh-gauge__wrapper--fail {
  color: var(--color-fail-secondary);
  fill: var(--color-fail);
  stroke: var(--color-fail);
}

.lh-gauge__wrapper--not-applicable {
  color: var(--color-not-applicable);
  fill: var(--color-not-applicable);
  stroke: var(--color-not-applicable);
}

.lh-fraction__wrapper .lh-fraction__content::before {
  content: '';
  height: var(--score-icon-size);
  width: var(--score-icon-size);
  margin: var(--score-icon-margin);
  display: inline-block;
}
.lh-fraction__wrapper--pass .lh-fraction__content {
  color: var(--color-pass-secondary);
}
.lh-fraction__wrapper--pass .lh-fraction__background {
  background-color: var(--color-pass);
}
.lh-fraction__wrapper--pass .lh-fraction__content::before {
  background-color: var(--color-pass);
  border-radius: 50%;
}
.lh-fraction__wrapper--average .lh-fraction__content {
  color: var(--color-average-secondary);
}
.lh-fraction__wrapper--average .lh-fraction__background,
.lh-fraction__wrapper--average .lh-fraction__content::before {
  background-color: var(--color-average);
}
.lh-fraction__wrapper--fail .lh-fraction__content {
  color: var(--color-fail);
}
.lh-fraction__wrapper--fail .lh-fraction__background {
  background-color: var(--color-fail);
}
.lh-fraction__wrapper--fail .lh-fraction__content::before {
  border-left: calc(var(--score-icon-size) / 2) solid transparent;
  border-right: calc(var(--score-icon-size) / 2) solid transparent;
  border-bottom: var(--score-icon-size) solid var(--color-fail);
}
.lh-fraction__wrapper--null .lh-fraction__content {
  color: var(--color-gray-700);
}
.lh-fraction__wrapper--null .lh-fraction__background {
  background-color: var(--color-gray-700);
}
.lh-fraction__wrapper--null .lh-fraction__content::before {
  border-radius: 50%;
  border: calc(0.2 * var(--score-icon-size)) solid var(--color-gray-700);
}

.lh-fraction__background {
  position: absolute;
  height: 100%;
  width: 100%;
  border-radius: calc(var(--gauge-circle-size) / 2);
  opacity: 0.1;
  z-index: -1;
}

.lh-fraction__content-wrapper {
  height: var(--gauge-circle-size);
  display: flex;
  align-items: center;
}

.lh-fraction__content {
  display: flex;
  position: relative;
  align-items: center;
  justify-content: center;
  font-size: calc(0.3 * var(--gauge-circle-size));
  line-height: calc(0.4 * var(--gauge-circle-size));
  width: max-content;
  min-width: calc(1.5 * var(--gauge-circle-size));
  padding: calc(0.1 * var(--gauge-circle-size)) calc(0.2 * var(--gauge-circle-size));
  --score-icon-size: calc(0.21 * var(--gauge-circle-size));
  --score-icon-margin: 0 calc(0.15 * var(--gauge-circle-size)) 0 0;
}

.lh-gauge {
  stroke-linecap: round;
  width: var(--gauge-circle-size);
  height: var(--gauge-circle-size);
}

.lh-category .lh-gauge {
  --gauge-circle-size: var(--gauge-circle-size-big);
}

.lh-gauge-base {
  opacity: 0.1;
}

.lh-gauge-arc {
  fill: none;
  transform-origin: 50% 50%;
  animation: load-gauge var(--transition-length) ease both;
  animation-delay: 250ms;
}

.lh-gauge__svg-wrapper {
  position: relative;
  height: var(--gauge-circle-size);
}
.lh-category .lh-gauge__svg-wrapper,
.lh-category .lh-fraction__wrapper {
  --gauge-circle-size: var(--gauge-circle-size-big);
}

/* The plugin badge overlay */
.lh-gauge__wrapper--plugin .lh-gauge__svg-wrapper::before {
  width: var(--plugin-badge-size);
  height: var(--plugin-badge-size);
  background-color: var(--plugin-badge-background-color);
  background-image: var(--plugin-icon-url);
  background-repeat: no-repeat;
  background-size: var(--plugin-icon-size);
  background-position: 58% 50%;
  content: "";
  position: absolute;
  right: -6px;
  bottom: 0px;
  display: block;
  z-index: 100;
  box-shadow: 0 0 4px rgba(0,0,0,.2);
  border-radius: 25%;
}
.lh-category .lh-gauge__wrapper--plugin .lh-gauge__svg-wrapper::before {
  width: var(--plugin-badge-size-big);
  height: var(--plugin-badge-size-big);
}

@keyframes load-gauge {
  from { stroke-dasharray: 0 352; }
}

.lh-gauge__percentage {
  width: 100%;
  height: var(--gauge-circle-size);
  line-height: var(--gauge-circle-size);
  position: absolute;
  font-family: var(--report-font-family-monospace);
  font-size: calc(var(--gauge-circle-size) * 0.34 + 1.3px);
  text-align: center;
  top: var(--score-container-padding);
}

.lh-category .lh-gauge__percentage {
  --gauge-circle-size: var(--gauge-circle-size-big);
  --gauge-percentage-font-size: var(--gauge-percentage-font-size-big);
}

.lh-gauge__wrapper,
.lh-fraction__wrapper {
  position: relative;
  display: flex;
  align-items: center;
  flex-direction: column;
  text-decoration: none;
  padding: var(--score-container-padding);

  --transition-length: 1s;

  /* Contain the layout style paint & layers during animation*/
  contain: content;
  will-change: opacity; /* Only using for layer promotion */
}

.lh-gauge__label,
.lh-fraction__label {
  font-size: var(--gauge-label-font-size);
  font-weight: 500;
  line-height: var(--gauge-label-line-height);
  margin-top: 10px;
  text-align: center;
  color: var(--report-text-color);
  word-break: keep-all;
}

/* TODO(#8185) use more BEM (.lh-gauge__label--big) instead of relying on descendant selector */
.lh-category .lh-gauge__label,
.lh-category .lh-fraction__label {
  --gauge-label-font-size: var(--gauge-label-font-size-big);
  --gauge-label-line-height: var(--gauge-label-line-height-big);
  margin-top: 14px;
}

.lh-scores-header .lh-gauge__wrapper,
.lh-scores-header .lh-fraction__wrapper,
.lh-sticky-header .lh-gauge__wrapper,
.lh-sticky-header .lh-fraction__wrapper {
  width: var(--gauge-wrapper-width);
}

.lh-scorescale {
  display: inline-flex;

  gap: calc(var(--default-padding) * 4);
  margin: 16px auto 0 auto;
  font-size: var(--report-font-size-secondary);
  color: var(--color-gray-700);

}

.lh-scorescale-range {
  display: flex;
  align-items: center;
  font-family: var(--report-font-family-monospace);
  white-space: nowrap;
}

.lh-category-header__finalscreenshot .lh-scorescale {
  border: 0;
  display: flex;
  justify-content: center;
}

.lh-category-header__finalscreenshot .lh-scorescale-range {
  font-family: unset;
  font-size: 12px;
}

.lh-scorescale-wrap {
  display: contents;
}

/* Hide category score gauages if it's a single category report */
.lh-header--solo-category .lh-scores-wrapper {
  display: none;
}


.lh-categories {
  width: 100%;
}

.lh-category {
  padding: var(--category-padding);
  max-width: var(--report-content-max-width);
  margin: 0 auto;

  scroll-margin-top: calc(var(--sticky-header-buffer) - 1em);
}

.lh-category-wrapper {
  border-bottom: 1px solid var(--color-gray-200);
}
.lh-category-wrapper:last-of-type {
  border-bottom: 0;
}

.lh-category-header {
  margin-bottom: var(--section-padding-vertical);
}

.lh-category-header .lh-score__gauge {
  max-width: 400px;
  width: auto;
  margin: 0px auto;
}

.lh-category-header__finalscreenshot {
  display: grid;
  grid-template: none / 1fr 1px 1fr;
  justify-items: center;
  align-items: center;
  gap: var(--report-line-height);
  min-height: 288px;
  margin-bottom: var(--default-padding);
}

.lh-final-ss-image {
  /* constrain the size of the image to not be too large */
  max-height: calc(var(--gauge-circle-size-big) * 2.8);
  max-width: calc(var(--gauge-circle-size-big) * 3.5);
  border: 1px solid var(--color-gray-200);
  padding: 4px;
  border-radius: 3px;
  display: block;
}

.lh-category-headercol--separator {
  background: var(--color-gray-200);
  width: 1px;
  height: var(--gauge-circle-size-big);
}

@media screen and (max-width: 780px) {
  .lh-category-header__finalscreenshot {
    grid-template: 1fr 1fr / none
  }
  .lh-category-headercol--separator {
    display: none;
  }
}


/* 964 fits the min-width of the filmstrip */
@media screen and (max-width: 964px) {
  .lh-report {
    margin-left: 0;
    width: 100%;
  }
}

@media print {
  body {
    -webkit-print-color-adjust: exact; /* print background colors */
  }
  .lh-container {
    display: block;
  }
  .lh-report {
    margin-left: 0;
    padding-top: 0;
  }
  .lh-categories {
    margin-top: 0;
  }
}

.lh-table {
  position: relative;
  border-collapse: separate;
  border-spacing: 0;
  /* Can't assign padding to table, so shorten the width instead. */
  width: calc(100% - var(--audit-description-padding-left) - var(--stackpack-padding-horizontal));
  border: 1px solid var(--report-border-color-secondary);
}

.lh-table thead th {
  position: sticky;
  top: var(--sticky-header-buffer);
  z-index: 1;
  background-color: var(--report-background-color);
  border-bottom: 1px solid var(--report-border-color-secondary);
  font-weight: normal;
  color: var(--color-gray-600);
  /* See text-wrapping comment on .lh-container. */
  word-break: normal;
}

.lh-row--group {
  background-color: var(--table-group-header-background-color);
}

.lh-row--group td {
  font-weight: bold;
  font-size: 1.05em;
  color: var(--table-group-header-text-color);
}

.lh-row--group td:first-child {
  display: block;
  min-width: max-content;
  font-weight: normal;
}

.lh-row--group .lh-text {
  color: inherit;
  text-decoration: none;
  display: inline-block;
}

.lh-row--group a.lh-link:hover {
  text-decoration: underline;
}

.lh-row--group .lh-audit__adorn {
  text-transform: capitalize;
  font-weight: normal;
  padding: 2px 3px 1px 3px;
}

.lh-row--group .lh-audit__adorn1p {
  color: var(--link-color);
  border-color: var(--link-color);
}

.lh-row--group .lh-report-icon--external::before {
  content: "";
  background-repeat: no-repeat;
  width: 14px;
  height: 16px;
  opacity: 0.7;
  display: inline-block;
  vertical-align: middle;
}

.lh-row--group .lh-report-icon--external {
  visibility: hidden;
}

.lh-row--group:hover .lh-report-icon--external {
  visibility: visible;
}

.lh-dark .lh-report-icon--external::before {
  filter: invert(1);
}

/** Manages indentation of two-level and three-level nested adjacent rows */

.lh-row--group ~ [data-entity]:not(.lh-row--group) td:first-child {
  padding-left: 20px;
}

.lh-row--group ~ [data-entity]:not(.lh-row--group) ~ .lh-sub-item-row td:first-child {
  padding-left: 40px;
}

.lh-row--even {
  background-color: var(--table-group-header-background-color);
}
.lh-row--hidden {
  display: none;
}

.lh-table th,
.lh-table td {
  padding: var(--default-padding);
}

.lh-table tr {
  vertical-align: middle;
}

.lh-table tr:hover {
  background-color: var(--table-higlight-background-color);
}

/* Looks unnecessary, but mostly for keeping the <th>s left-aligned */
.lh-table-column--text,
.lh-table-column--source-location,
.lh-table-column--url,
/* .lh-table-column--thumbnail, */
/* .lh-table-column--empty,*/
.lh-table-column--code,
.lh-table-column--node {
  text-align: left;
}

.lh-table-column--code {
  min-width: 100px;
}

.lh-table-column--bytes,
.lh-table-column--timespanMs,
.lh-table-column--ms,
.lh-table-column--numeric {
  text-align: right;
  word-break: normal;
}



.lh-table .lh-table-column--thumbnail {
  width: var(--image-preview-size);
}

.lh-table-column--url {
  min-width: 250px;
}

.lh-table-column--text {
  min-width: 80px;
}

/* Keep columns narrow if they follow the URL column */
/* 12% was determined to be a decent narrow width, but wide enough for column headings */
.lh-table-column--url + th.lh-table-column--bytes,
.lh-table-column--url + .lh-table-column--bytes + th.lh-table-column--bytes,
.lh-table-column--url + .lh-table-column--ms,
.lh-table-column--url + .lh-table-column--ms + th.lh-table-column--bytes,
.lh-table-column--url + .lh-table-column--bytes + th.lh-table-column--timespanMs {
  width: 12%;
}

.lh-text__url-host {
  display: inline;
}

.lh-text__url-host {
  margin-left: calc(var(--report-font-size) / 2);
  opacity: 0.6;
  font-size: 90%
}

.lh-thumbnail {
  object-fit: cover;
  width: var(--image-preview-size);
  height: var(--image-preview-size);
  display: block;
}

.lh-unknown pre {
  overflow: scroll;
  border: solid 1px var(--color-gray-200);
}

.lh-text__url > a {
  color: inherit;
  text-decoration: none;
}

.lh-text__url > a:hover {
  text-decoration: underline dotted #999;
}

.lh-sub-item-row {
  margin-left: 20px;
  margin-bottom: 0;
  color: var(--color-gray-700);
}

.lh-sub-item-row td {
  padding-top: 4px;
  padding-bottom: 4px;
  padding-left: 20px;
}

.lh-sub-item-row .lh-element-screenshot {
  zoom: 0.6;
}

/* Chevron
   https://codepen.io/paulirish/pen/LmzEmK
 */
.lh-chevron {
  --chevron-angle: 42deg;
  /* Edge doesn't support transform: rotate(calc(...)), so we define it here */
  --chevron-angle-right: -42deg;
  width: var(--chevron-size);
  height: var(--chevron-size);
  margin-top: calc((var(--report-line-height) - 12px) / 2);
}

.lh-chevron__lines {
  transition: transform 0.4s;
  transform: translateY(var(--report-line-height));
}
.lh-chevron__line {
 stroke: var(--chevron-line-stroke);
 stroke-width: var(--chevron-size);
 stroke-linecap: square;
 transform-origin: 50%;
 transform: rotate(var(--chevron-angle));
 transition: transform 300ms, stroke 300ms;
}

.lh-expandable-details .lh-chevron__line-right,
.lh-expandable-details[open] .lh-chevron__line-left {
 transform: rotate(var(--chevron-angle-right));
}

.lh-expandable-details[open] .lh-chevron__line-right {
  transform: rotate(var(--chevron-angle));
}


.lh-expandable-details[open]  .lh-chevron__lines {
 transform: translateY(calc(var(--chevron-size) * -1));
}

.lh-expandable-details[open] {
  animation: 300ms openDetails forwards;
  padding-bottom: var(--default-padding);
}

@keyframes openDetails {
  from {
    outline: 1px solid var(--report-background-color);
  }
  to {
   outline: 1px solid;
   box-shadow: 0 2px 4px rgba(0, 0, 0, .24);
  }
}

@media screen and (max-width: 780px) {
  /* no black outline if we're not confident the entire table can be displayed within bounds */
  .lh-expandable-details[open] {
    animation: none;
  }
}

.lh-expandable-details[open] summary, details.lh-clump > summary {
  border-bottom: 1px solid var(--report-border-color-secondary);
}
details.lh-clump[open] > summary {
  border-bottom-width: 0;
}



details .lh-clump-toggletext--hide,
details[open] .lh-clump-toggletext--show { display: none; }
details[open] .lh-clump-toggletext--hide { display: block;}


/* Tooltip */
.lh-tooltip-boundary {
  position: relative;
}

.lh-tooltip {
  position: absolute;
  display: none; /* Don't retain these layers when not needed */
  opacity: 0;
  background: #ffffff;
  white-space: pre-line; /* Render newlines in the text */
  min-width: 246px;
  max-width: 275px;
  padding: 15px;
  border-radius: 5px;
  text-align: initial;
  line-height: 1.4;
}
/* shrink tooltips to not be cutoff on left edge of narrow viewports
   45vw is chosen to be ~= width of the left column of metrics
*/
@media screen and (max-width: 535px) {
  .lh-tooltip {
    min-width: 45vw;
    padding: 3vw;
  }
}

.lh-tooltip-boundary:hover .lh-tooltip {
  display: block;
  animation: fadeInTooltip 250ms;
  animation-fill-mode: forwards;
  animation-delay: 850ms;
  bottom: 100%;
  z-index: 1;
  will-change: opacity;
  right: 0;
  pointer-events: none;
}

.lh-tooltip::before {
  content: "";
  border: solid transparent;
  border-bottom-color: #fff;
  border-width: 10px;
  position: absolute;
  bottom: -20px;
  right: 6px;
  transform: rotate(180deg);
  pointer-events: none;
}

@keyframes fadeInTooltip {
  0% { opacity: 0; }
  75% { opacity: 1; }
  100% { opacity: 1;  filter: drop-shadow(1px 0px 1px #aaa) drop-shadow(0px 2px 4px hsla(206, 6%, 25%, 0.15)); pointer-events: auto; }
}

/* Element screenshot */
.lh-element-screenshot {
  float: left;
  margin-right: 20px;
}
.lh-element-screenshot__content {
  overflow: hidden;
  min-width: 110px;
  display: flex;
  justify-content: center;
  background-color: var(--report-background-color);
}
.lh-element-screenshot__image {
  position: relative;
  /* Set by ElementScreenshotRenderer.installFullPageScreenshotCssVariable */
  background-image: var(--element-screenshot-url);
  outline: 2px solid #777;
  background-color: white;
  background-repeat: no-repeat;
}
.lh-element-screenshot__mask {
  position: absolute;
  background: #555;
  opacity: 0.8;
}
.lh-element-screenshot__element-marker {
  position: absolute;
  outline: 2px solid var(--color-lime-400);
}
.lh-element-screenshot__overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2000; /* .lh-topbar is 1000 */
  background: var(--screenshot-overlay-background);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: zoom-out;
}

.lh-element-screenshot__overlay .lh-element-screenshot {
  margin-right: 0; /* clearing margin used in thumbnail case */
  outline: 1px solid var(--color-gray-700);
}

.lh-screenshot-overlay--enabled .lh-element-screenshot {
  cursor: zoom-out;
}
.lh-screenshot-overlay--enabled .lh-node .lh-element-screenshot {
  cursor: zoom-in;
}


.lh-meta__items {
  --meta-icon-size: calc(var(--report-icon-size) * 0.667);
  padding: var(--default-padding);
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  background-color: var(--env-item-background-color);
  border-radius: 3px;
  margin: 0 0 var(--default-padding) 0;
  font-size: 12px;
  column-gap: var(--default-padding);
  color: var(--color-gray-700);
}

.lh-meta__item {
  display: block;
  list-style-type: none;
  position: relative;
  padding: 0 0 0 calc(var(--meta-icon-size) + var(--default-padding) * 2);
  cursor: unset; /* disable pointer cursor from report-icon */
}

.lh-meta__item.lh-tooltip-boundary {
  text-decoration: dotted underline var(--color-gray-500);
  cursor: help;
}

.lh-meta__item.lh-report-icon::before {
  position: absolute;
  left: var(--default-padding);
  width: var(--meta-icon-size);
  height: var(--meta-icon-size);
}

.lh-meta__item.lh-report-icon:hover::before {
  opacity: 0.7;
}

.lh-meta__item .lh-tooltip {
  color: var(--color-gray-800);
}

.lh-meta__item .lh-tooltip::before {
  right: auto; /* Set the tooltip arrow to the leftside */
  left: 6px;
}

/* Change the grid for narrow viewport. */
@media screen and (max-width: 640px) {
  .lh-meta__items {
    grid-template-columns: 1fr 1fr;
  }
}
@media screen and (max-width: 535px) {
  .lh-meta__items {
    display: block;
  }
}

/* Explodey gauge */

.lh-exp-gauge-component {
  margin-bottom: 10px;
}

.lh-exp-gauge-component circle {
  stroke: currentcolor;
  r: var(--radius);
}

.lh-exp-gauge-component text {
  font-size: calc(var(--radius) * 0.2);
}

.lh-exp-gauge-component .lh-exp-gauge {
  margin: 0 auto;
  width: 225px;
  stroke-width: var(--stroke-width);
  stroke-linecap: round;

  /* for better rendering perf */
  contain: strict;
  height: 225px;
  will-change: transform;
}
.lh-exp-gauge-component .lh-exp-gauge--faded {
  opacity: 0.1;
}
.lh-exp-gauge-component .lh-exp-gauge__wrapper {
  font-family: var(--report-font-family-monospace);
  text-align: center;
  text-decoration: none;
  transition: .3s;
}
.lh-exp-gauge-component .lh-exp-gauge__wrapper--pass {
  color: var(--color-pass);
}
.lh-exp-gauge-component .lh-exp-gauge__wrapper--average {
  color: var(--color-average);
}
.lh-exp-gauge-component .lh-exp-gauge__wrapper--fail {
  color: var(--color-fail);
}
.lh-exp-gauge-component .state--expanded {
  transition: color .3s;
}
.lh-exp-gauge-component .state--highlight {
  color: var(--color-highlight);
}
.lh-exp-gauge-component .lh-exp-gauge__svg-wrapper {
  display: flex;
  flex-direction: column-reverse;
}

.lh-exp-gauge-component .lh-exp-gauge__label {
  fill: var(--report-text-color);
  font-family: var(--report-font-family);
  font-size: 12px;
}

.lh-exp-gauge-component .lh-exp-gauge__cutout {
  opacity: .999;
  transition: opacity .3s;
}
.lh-exp-gauge-component .state--highlight .lh-exp-gauge__cutout {
  opacity: 0;
}

.lh-exp-gauge-component .lh-exp-gauge__inner {
  color: inherit;
}
.lh-exp-gauge-component .lh-exp-gauge__base {
  fill: currentcolor;
}


.lh-exp-gauge-component .lh-exp-gauge__arc {
  fill: none;
  transition: opacity .3s;
}
.lh-exp-gauge-component .lh-exp-gauge__arc--metric {
  color: var(--metric-color);
  stroke-dashoffset: var(--metric-offset);
  opacity: 0.3;
}
.lh-exp-gauge-component .lh-exp-gauge-hovertarget {
  color: currentcolor;
  opacity: 0.001;
  stroke-linecap: butt;
  stroke-width: 24;
  /* hack. move the hover target out of the center. ideally i tweak the r instead but that rquires considerably more math. */
  transform: scale(1.15);
}
.lh-exp-gauge-component .lh-exp-gauge__arc--metric.lh-exp-gauge--miniarc {
  opacity: 0;
  stroke-dasharray: 0 calc(var(--circle-meas) * var(--radius));
  transition: 0s .005s;
}
.lh-exp-gauge-component .state--expanded .lh-exp-gauge__arc--metric.lh-exp-gauge--miniarc {
  opacity: .999;
  stroke-dasharray: var(--metric-array);
  transition: 0.3s; /*  calc(.005s + var(--i)*.05s); entrace animation */
}
.lh-exp-gauge-component .state--expanded .lh-exp-gauge__inner .lh-exp-gauge__arc {
  opacity: 0;
}


.lh-exp-gauge-component .lh-exp-gauge__percentage {
  text-anchor: middle;
  dominant-baseline: middle;
  opacity: .999;
  font-size: calc(var(--radius) * 0.625);
  transition: opacity .3s ease-in;
}
.lh-exp-gauge-component .state--highlight .lh-exp-gauge__percentage {
  opacity: 0;
}

.lh-exp-gauge-component .lh-exp-gauge__wrapper--fail .lh-exp-gauge__percentage {
  fill: var(--color-fail);
}
.lh-exp-gauge-component .lh-exp-gauge__wrapper--average .lh-exp-gauge__percentage {
  fill: var(--color-average);
}
.lh-exp-gauge-component .lh-exp-gauge__wrapper--pass .lh-exp-gauge__percentage {
  fill: var(--color-pass);
}

.lh-exp-gauge-component .lh-cover {
  fill: none;
  opacity: .001;
  pointer-events: none;
}
.lh-exp-gauge-component .state--expanded .lh-cover {
  pointer-events: auto;
}

.lh-exp-gauge-component .metric {
  transform: scale(var(--scale-initial));
  opacity: 0;
  transition: transform .1s .2s ease-out,  opacity .3s ease-out;
  pointer-events: none;
}
.lh-exp-gauge-component .metric text {
  pointer-events: none;
}
.lh-exp-gauge-component .metric__value {
  fill: currentcolor;
  opacity: 0;
  transition: opacity 0.2s;
}
.lh-exp-gauge-component .state--expanded .metric {
  transform: scale(1);
  opacity: .999;
  transition: transform .3s ease-out,  opacity .3s ease-in,  stroke-width .1s ease-out;
  transition-delay: calc(var(--i)*.05s);
  pointer-events: auto;
}
.lh-exp-gauge-component .state--highlight .metric {
  opacity: .3;
}
.lh-exp-gauge-component .state--highlight .metric--highlight {
  opacity: .999;
  stroke-width: calc(1.5*var(--stroke-width));
}
.lh-exp-gauge-component .state--highlight .metric--highlight .metric__value {
  opacity: 0.999;
}


/*
 the initial first load peek
*/
.lh-exp-gauge-component .lh-exp-gauge__bg {  /* needed for the use zindex stacking w/ transparency */
  fill: var(--report-background-color);
  stroke: var(--report-background-color);
}
.lh-exp-gauge-component .state--peek .metric {
  transition-delay: 0ms;
  animation: peek var(--peek-dur) cubic-bezier(0.46, 0.03, 0.52, 0.96);
  animation-fill-mode: forwards;
}
.lh-exp-gauge-component .state--peek .lh-exp-gauge__inner .lh-exp-gauge__arc {
  opacity: 1;
}
.lh-exp-gauge-component .state--peek .lh-exp-gauge__arc.lh-exp-gauge--faded {
  opacity: 0.3; /* just a tad stronger cuz its fighting with a big solid arg */
}
/* do i need to set expanded and override this? */
.lh-exp-gauge-component .state--peek .lh-exp-gauge__arc--metric.lh-exp-gauge--miniarc {
  transition: opacity 0.3s;
}
.lh-exp-gauge-component .state--peek {
  color: unset;
}
.lh-exp-gauge-component .state--peek .metric__label {
  display: none;
}

.lh-exp-gauge-component .metric__label {
  fill: var(--report-text-color);
}

@keyframes peek {
  /* biggest it should go is 0.92. smallest is 0.8 */
  0% {
    transform: scale(0.8);
    opacity: 0.8;
  }

  50% {
    transform: scale(0.92);
    opacity: 1;
  }

  100% {
    transform: scale(0.8);
    opacity: 0.8;
  }
}

.lh-exp-gauge-component .wrapper {
  width: 620px;
}

/*# sourceURL=report-styles.css */
`);
    el0.append(el1);
    return el0;
  }
  function createTopbarComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("style");
    el1.append("\n    .lh-topbar {\n      position: sticky;\n      top: 0;\n      left: 0;\n      right: 0;\n      z-index: 1000;\n      display: flex;\n      align-items: center;\n      height: var(--topbar-height);\n      padding: var(--topbar-padding);\n      font-size: var(--report-font-size-secondary);\n      background-color: var(--topbar-background-color);\n      border-bottom: 1px solid var(--color-gray-200);\n    }\n\n    .lh-topbar__logo {\n      width: var(--topbar-logo-size);\n      height: var(--topbar-logo-size);\n      user-select: none;\n      flex: none;\n    }\n\n    .lh-topbar__url {\n      margin: var(--topbar-padding);\n      text-decoration: none;\n      color: var(--report-text-color);\n      text-overflow: ellipsis;\n      overflow: hidden;\n      white-space: nowrap;\n    }\n\n    .lh-tools {\n      display: flex;\n      align-items: center;\n      margin-left: auto;\n      will-change: transform;\n      min-width: var(--report-icon-size);\n    }\n    .lh-tools__button {\n      width: var(--report-icon-size);\n      min-width: 24px;\n      height: var(--report-icon-size);\n      cursor: pointer;\n      margin-right: 5px;\n      /* This is actually a button element, but we want to style it like a transparent div. */\n      display: flex;\n      background: none;\n      color: inherit;\n      border: none;\n      padding: 0;\n      font: inherit;\n      outline: inherit;\n    }\n    .lh-tools__button svg {\n      fill: var(--tools-icon-color);\n    }\n    .lh-dark .lh-tools__button svg {\n      filter: invert(1);\n    }\n    .lh-tools__button.lh-active + .lh-tools__dropdown {\n      opacity: 1;\n      clip: rect(-1px, 194px, 270px, -3px);\n      visibility: visible;\n    }\n    .lh-tools__dropdown {\n      position: absolute;\n      background-color: var(--report-background-color);\n      border: 1px solid var(--report-border-color);\n      border-radius: 3px;\n      padding: calc(var(--default-padding) / 2) 0;\n      cursor: pointer;\n      top: 36px;\n      right: 0;\n      box-shadow: 1px 1px 3px #ccc;\n      min-width: 125px;\n      clip: rect(0, 164px, 0, 0);\n      visibility: hidden;\n      opacity: 0;\n      transition: all 200ms cubic-bezier(0,0,0.2,1);\n    }\n    .lh-tools__dropdown a {\n      color: currentColor;\n      text-decoration: none;\n      white-space: nowrap;\n      padding: 0 6px;\n      line-height: 2;\n    }\n    .lh-tools__dropdown a:hover,\n    .lh-tools__dropdown a:focus {\n      background-color: var(--color-gray-200);\n      outline: none;\n    }\n    /* save-gist option hidden in report. */\n    .lh-tools__dropdown a[data-action='save-gist'] {\n      display: none;\n    }\n\n    .lh-locale-selector {\n      width: 100%;\n      color: var(--report-text-color);\n      background-color: var(--locale-selector-background-color);\n      padding: 2px;\n    }\n    .lh-tools-locale {\n      display: flex;\n      align-items: center;\n      flex-direction: row-reverse;\n    }\n    .lh-tools-locale__selector-wrapper {\n      transition: opacity 0.15s;\n      opacity: 0;\n      max-width: 200px;\n    }\n    .lh-button.lh-tool-locale__button {\n      height: var(--topbar-height);\n      color: var(--tools-icon-color);\n      padding: calc(var(--default-padding) / 2);\n    }\n    .lh-tool-locale__button.lh-active + .lh-tools-locale__selector-wrapper {\n      opacity: 1;\n      clip: rect(-1px, 194px, 242px, -3px);\n      visibility: visible;\n      margin: 0 4px;\n    }\n\n    @media screen and (max-width: 964px) {\n      .lh-tools__dropdown {\n        right: 0;\n        left: initial;\n      }\n    }\n    @media print {\n      .lh-topbar {\n        position: static;\n        margin-left: 0;\n      }\n\n      .lh-tools__dropdown {\n        display: none;\n      }\n    }\n  ");
    el0.append(el1);
    const el2 = dom2.createElement("div", "lh-topbar");
    const el3 = dom2.createElementNS("http://www.w3.org/2000/svg", "svg", "lh-topbar__logo");
    el3.setAttribute("role", "img");
    el3.setAttribute("title", "Lighthouse logo");
    el3.setAttribute("fill", "none");
    el3.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    el3.setAttribute("viewBox", "0 0 48 48");
    const el4 = dom2.createElementNS("http://www.w3.org/2000/svg", "path");
    el4.setAttribute("d", "m14 7 10-7 10 7v10h5v7h-5l5 24H9l5-24H9v-7h5V7Z");
    el4.setAttribute("fill", "#F63");
    const el5 = dom2.createElementNS("http://www.w3.org/2000/svg", "path");
    el5.setAttribute("d", "M31.561 24H14l-1.689 8.105L31.561 24ZM18.983 48H9l1.022-4.907L35.723 32.27l1.663 7.98L18.983 48Z");
    el5.setAttribute("fill", "#FFA385");
    const el6 = dom2.createElementNS("http://www.w3.org/2000/svg", "path");
    el6.setAttribute("fill", "#FF3");
    el6.setAttribute("d", "M20.5 10h7v7h-7z");
    el3.append(" ", el4, " ", el5, " ", el6, " ");
    const el7 = dom2.createElement("a", "lh-topbar__url");
    el7.setAttribute("href", "");
    el7.setAttribute("target", "_blank");
    el7.setAttribute("rel", "noopener");
    const el8 = dom2.createElement("div", "lh-tools");
    const el9 = dom2.createElement("div", "lh-tools-locale lh-hidden");
    const el10 = dom2.createElement("button", "lh-button lh-tool-locale__button");
    el10.setAttribute("id", "lh-button__swap-locales");
    el10.setAttribute("title", "Show Language Picker");
    el10.setAttribute("aria-label", "Toggle language picker");
    el10.setAttribute("aria-haspopup", "menu");
    el10.setAttribute("aria-expanded", "false");
    el10.setAttribute("aria-controls", "lh-tools-locale__selector-wrapper");
    const el11 = dom2.createElementNS("http://www.w3.org/2000/svg", "svg");
    el11.setAttribute("width", "20px");
    el11.setAttribute("height", "20px");
    el11.setAttribute("viewBox", "0 0 24 24");
    el11.setAttribute("fill", "currentColor");
    const el12 = dom2.createElementNS("http://www.w3.org/2000/svg", "path");
    el12.setAttribute("d", "M0 0h24v24H0V0z");
    el12.setAttribute("fill", "none");
    const el13 = dom2.createElementNS("http://www.w3.org/2000/svg", "path");
    el13.setAttribute("d", "M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z");
    el11.append(el12, el13);
    el10.append(" ", el11, " ");
    const el14 = dom2.createElement("div", "lh-tools-locale__selector-wrapper");
    el14.setAttribute("id", "lh-tools-locale__selector-wrapper");
    el14.setAttribute("role", "menu");
    el14.setAttribute("aria-labelledby", "lh-button__swap-locales");
    el14.setAttribute("aria-hidden", "true");
    el14.append(" ", " ");
    el9.append(" ", el10, " ", el14, " ");
    const el15 = dom2.createElement("button", "lh-tools__button");
    el15.setAttribute("id", "lh-tools-button");
    el15.setAttribute("title", "Tools menu");
    el15.setAttribute("aria-label", "Toggle report tools menu");
    el15.setAttribute("aria-haspopup", "menu");
    el15.setAttribute("aria-expanded", "false");
    el15.setAttribute("aria-controls", "lh-tools-dropdown");
    const el16 = dom2.createElementNS("http://www.w3.org/2000/svg", "svg");
    el16.setAttribute("width", "100%");
    el16.setAttribute("height", "100%");
    el16.setAttribute("viewBox", "0 0 24 24");
    const el17 = dom2.createElementNS("http://www.w3.org/2000/svg", "path");
    el17.setAttribute("d", "M0 0h24v24H0z");
    el17.setAttribute("fill", "none");
    const el18 = dom2.createElementNS("http://www.w3.org/2000/svg", "path");
    el18.setAttribute("d", "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z");
    el16.append(" ", el17, " ", el18, " ");
    el15.append(" ", el16, " ");
    const el19 = dom2.createElement("div", "lh-tools__dropdown");
    el19.setAttribute("id", "lh-tools-dropdown");
    el19.setAttribute("role", "menu");
    el19.setAttribute("aria-labelledby", "lh-tools-button");
    const el20 = dom2.createElement("a", "lh-report-icon lh-report-icon--print");
    el20.setAttribute("role", "menuitem");
    el20.setAttribute("tabindex", "-1");
    el20.setAttribute("href", "#");
    el20.setAttribute("data-i18n", "dropdownPrintSummary");
    el20.setAttribute("data-action", "print-summary");
    const el21 = dom2.createElement("a", "lh-report-icon lh-report-icon--print");
    el21.setAttribute("role", "menuitem");
    el21.setAttribute("tabindex", "-1");
    el21.setAttribute("href", "#");
    el21.setAttribute("data-i18n", "dropdownPrintExpanded");
    el21.setAttribute("data-action", "print-expanded");
    const el22 = dom2.createElement("a", "lh-report-icon lh-report-icon--copy");
    el22.setAttribute("role", "menuitem");
    el22.setAttribute("tabindex", "-1");
    el22.setAttribute("href", "#");
    el22.setAttribute("data-i18n", "dropdownCopyJSON");
    el22.setAttribute("data-action", "copy");
    const el23 = dom2.createElement("a", "lh-report-icon lh-report-icon--download lh-hidden");
    el23.setAttribute("role", "menuitem");
    el23.setAttribute("tabindex", "-1");
    el23.setAttribute("href", "#");
    el23.setAttribute("data-i18n", "dropdownSaveHTML");
    el23.setAttribute("data-action", "save-html");
    const el24 = dom2.createElement("a", "lh-report-icon lh-report-icon--download");
    el24.setAttribute("role", "menuitem");
    el24.setAttribute("tabindex", "-1");
    el24.setAttribute("href", "#");
    el24.setAttribute("data-i18n", "dropdownSaveJSON");
    el24.setAttribute("data-action", "save-json");
    const el25 = dom2.createElement("a", "lh-report-icon lh-report-icon--open");
    el25.setAttribute("role", "menuitem");
    el25.setAttribute("tabindex", "-1");
    el25.setAttribute("href", "#");
    el25.setAttribute("data-i18n", "dropdownViewer");
    el25.setAttribute("data-action", "open-viewer");
    const el26 = dom2.createElement("a", "lh-report-icon lh-report-icon--open");
    el26.setAttribute("role", "menuitem");
    el26.setAttribute("tabindex", "-1");
    el26.setAttribute("href", "#");
    el26.setAttribute("data-i18n", "dropdownSaveGist");
    el26.setAttribute("data-action", "save-gist");
    const el27 = dom2.createElement("a", "lh-report-icon lh-report-icon--open lh-hidden");
    el27.setAttribute("role", "menuitem");
    el27.setAttribute("tabindex", "-1");
    el27.setAttribute("href", "#");
    el27.setAttribute("data-i18n", "dropdownViewUnthrottledTrace");
    el27.setAttribute("data-action", "view-unthrottled-trace");
    const el28 = dom2.createElement("a", "lh-report-icon lh-report-icon--dark");
    el28.setAttribute("role", "menuitem");
    el28.setAttribute("tabindex", "-1");
    el28.setAttribute("href", "#");
    el28.setAttribute("data-i18n", "dropdownDarkTheme");
    el28.setAttribute("data-action", "toggle-dark");
    el19.append(" ", el20, " ", el21, " ", el22, " ", " ", el23, " ", el24, " ", el25, " ", el26, " ", " ", el27, " ", el28, " ");
    el8.append(" ", el9, " ", el15, " ", el19, " ");
    el2.append(" ", " ", el3, " ", el7, " ", el8, " ");
    el0.append(el2);
    return el0;
  }
  function createWarningsToplevelComponent(dom2) {
    const el0 = dom2.createFragment();
    const el1 = dom2.createElement("div", "lh-warnings lh-warnings--toplevel");
    const el2 = dom2.createElement("p", "lh-warnings__msg");
    const el3 = dom2.createElement("ul");
    el1.append(" ", el2, " ", el3, " ");
    el0.append(el1);
    return el0;
  }
  function createComponent(dom2, componentName) {
    switch (componentName) {
      case "3pFilter":
        return create3pFilterComponent(dom2);
      case "audit":
        return createAuditComponent(dom2);
      case "categoryHeader":
        return createCategoryHeaderComponent(dom2);
      case "chevron":
        return createChevronComponent(dom2);
      case "clump":
        return createClumpComponent(dom2);
      case "crc":
        return createCrcComponent(dom2);
      case "crcChain":
        return createCrcChainComponent(dom2);
      case "elementScreenshot":
        return createElementScreenshotComponent(dom2);
      case "explodeyGauge":
        return createExplodeyGaugeComponent(dom2);
      case "footer":
        return createFooterComponent(dom2);
      case "fraction":
        return createFractionComponent(dom2);
      case "gauge":
        return createGaugeComponent(dom2);
      case "heading":
        return createHeadingComponent(dom2);
      case "metric":
        return createMetricComponent(dom2);
      case "scorescale":
        return createScorescaleComponent(dom2);
      case "scoresWrapper":
        return createScoresWrapperComponent(dom2);
      case "snippet":
        return createSnippetComponent(dom2);
      case "snippetContent":
        return createSnippetContentComponent(dom2);
      case "snippetHeader":
        return createSnippetHeaderComponent(dom2);
      case "snippetLine":
        return createSnippetLineComponent(dom2);
      case "styles":
        return createStylesComponent(dom2);
      case "topbar":
        return createTopbarComponent(dom2);
      case "warningsToplevel":
        return createWarningsToplevelComponent(dom2);
    }
    throw new Error("unexpected component: " + componentName);
  }

  // report/renderer/dom.js
  var DOM = class {
    /**
     * @param {Document} document
     * @param {HTMLElement} rootEl
     */
    constructor(document2, rootEl) {
      this._document = document2;
      this._lighthouseChannel = "unknown";
      this._componentCache = /* @__PURE__ */ new Map();
      this.rootEl = rootEl;
    }
    /**
     * @template {string} T
     * @param {T} name
     * @param {string=} className
     * @return {HTMLElementByTagName[T]}
     */
    createElement(name, className) {
      const element = this._document.createElement(name);
      if (className) {
        for (const token of className.split(/\s+/)) {
          if (token)
            element.classList.add(token);
        }
      }
      return element;
    }
    /**
     * @param {string} namespaceURI
     * @param {string} name
     * @param {string=} className
     * @return {Element}
     */
    createElementNS(namespaceURI, name, className) {
      const element = this._document.createElementNS(namespaceURI, name);
      if (className) {
        for (const token of className.split(/\s+/)) {
          if (token)
            element.classList.add(token);
        }
      }
      return element;
    }
    /**
     * @template {string} T
     * @param {T} name
     * @param {string=} className
     * @return {SVGElementByTagName[T]}
     */
    createSVGElement(name, className) {
      return (
        /** @type {SVGElementByTagName[T]} */
        this._document.createElementNS("http://www.w3.org/2000/svg", name, className)
      );
    }
    /**
     * @return {!DocumentFragment}
     */
    createFragment() {
      return this._document.createDocumentFragment();
    }
    /**
     * @param {string} data
     * @return {!Node}
     */
    createTextNode(data) {
      return this._document.createTextNode(data);
    }
    /**
     * @template {string} T
     * @param {Element} parentElem
     * @param {T} elementName
     * @param {string=} className
     * @return {HTMLElementByTagName[T]}
     */
    createChildOf(parentElem, elementName, className) {
      const element = this.createElement(elementName, className);
      parentElem.append(element);
      return element;
    }
    /**
     * @param {import('./components.js').ComponentName} componentName
     * @return {!DocumentFragment} A clone of the cached component.
     */
    createComponent(componentName) {
      let component = this._componentCache.get(componentName);
      if (component) {
        const cloned2 = (
          /** @type {DocumentFragment} */
          component.cloneNode(true)
        );
        this.findAll("style", cloned2).forEach((style) => style.remove());
        return cloned2;
      }
      component = createComponent(this, componentName);
      this._componentCache.set(componentName, component);
      const cloned = (
        /** @type {DocumentFragment} */
        component.cloneNode(true)
      );
      return cloned;
    }
    clearComponentCache() {
      this._componentCache.clear();
    }
    /**
     * @param {string} text
     * @param {{alwaysAppendUtmSource?: boolean}} opts
     * @return {Element}
     */
    convertMarkdownLinkSnippets(text, opts = {}) {
      const element = this.createElement("span");
      for (const segment of Util.splitMarkdownLink(text)) {
        const processedSegment = segment.text.includes("`") ? this.convertMarkdownCodeSnippets(segment.text) : segment.text;
        if (!segment.isLink) {
          element.append(processedSegment);
          continue;
        }
        const url = new URL(segment.linkHref);
        const DOCS_ORIGINS = ["https://developers.google.com", "https://web.dev", "https://developer.chrome.com"];
        if (DOCS_ORIGINS.includes(url.origin) || opts.alwaysAppendUtmSource) {
          url.searchParams.set("utm_source", "lighthouse");
          url.searchParams.set("utm_medium", this._lighthouseChannel);
        }
        const a = this.createElement("a");
        a.rel = "noopener";
        a.target = "_blank";
        a.append(processedSegment);
        this.safelySetHref(a, url.href);
        element.append(a);
      }
      return element;
    }
    /**
     * Set link href, but safely, preventing `javascript:` protocol, etc.
     * @see https://github.com/google/safevalues/
     * @param {HTMLAnchorElement} elem
     * @param {string} url
     */
    safelySetHref(elem, url) {
      url = url || "";
      if (url.startsWith("#")) {
        elem.href = url;
        return;
      }
      const allowedProtocols = ["https:", "http:"];
      let parsed;
      try {
        parsed = new URL(url);
      } catch (_) {
      }
      if (parsed && allowedProtocols.includes(parsed.protocol)) {
        elem.href = parsed.href;
      }
    }
    /**
     * Only create blob URLs for JSON & HTML
     * @param {HTMLAnchorElement} elem
     * @param {Blob} blob
     */
    safelySetBlobHref(elem, blob) {
      if (blob.type !== "text/html" && blob.type !== "application/json") {
        throw new Error("Unsupported blob type");
      }
      const href = URL.createObjectURL(blob);
      elem.href = href;
    }
    /**
     * @param {string} markdownText
     * @return {Element}
     */
    convertMarkdownCodeSnippets(markdownText) {
      const element = this.createElement("span");
      for (const segment of Util.splitMarkdownCodeSpans(markdownText)) {
        if (segment.isCode) {
          const pre = this.createElement("code");
          pre.textContent = segment.text;
          element.append(pre);
        } else {
          element.append(this._document.createTextNode(segment.text));
        }
      }
      return element;
    }
    /**
     * The channel to use for UTM data when rendering links to the documentation.
     * @param {string} lighthouseChannel
     */
    setLighthouseChannel(lighthouseChannel) {
      this._lighthouseChannel = lighthouseChannel;
    }
    /**
     * ONLY use if `dom.rootEl` isn't sufficient for your needs. `dom.rootEl` is preferred
     * for all scoping, because a document can have multiple reports within it.
     * @return {Document}
     */
    document() {
      return this._document;
    }
    /**
     * TODO(paulirish): import and conditionally apply the DevTools frontend subclasses instead of this
     * @return {boolean}
     */
    isDevTools() {
      return !!this._document.querySelector(".lh-devtools");
    }
    /**
     * Typed and guaranteed context.querySelector. Always returns an element or throws if
     * nothing matches query.
     *
     * @template {string} T
     * @param {T} query
     * @param {ParentNode} context
     * @return {ParseSelector<T>}
     */
    find(query, context = this.rootEl ?? this._document) {
      const result = this.maybeFind(query, context);
      if (result === null) {
        throw new Error(`query ${query} not found`);
      }
      return result;
    }
    /**
     * Typed context.querySelector.
     *
     * @template {string} T
     * @param {T} query
     * @param {ParentNode} context
     * @return {ParseSelector<T> | null}
     */
    maybeFind(query, context) {
      const result = context.querySelector(query);
      return (
        /** @type {ParseSelector<T> | null} */
        result
      );
    }
    /**
     * Helper for context.querySelectorAll. Returns an Array instead of a NodeList.
     * @template {string} T
     * @param {T} query
     * @param {ParentNode} context
     */
    findAll(query, context) {
      const elements = Array.from(context.querySelectorAll(query));
      return elements;
    }
    /**
     * Fires a custom DOM event on target.
     * @param {string} name Name of the event.
     * @param {Node=} target DOM node to fire the event on.
     * @param {*=} detail Custom data to include.
     */
    fireEventOn(name, target = this._document, detail) {
      const event = new CustomEvent(name, detail ? { detail } : void 0);
      target.dispatchEvent(event);
    }
    /**
     * Downloads a file (blob) using a[download].
     * @param {Blob|File} blob The file to save.
     * @param {string} filename
     */
    saveFile(blob, filename) {
      const a = this.createElement("a");
      a.download = filename;
      this.safelySetBlobHref(a, blob);
      this._document.body.append(a);
      a.click();
      this._document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 500);
    }
  };

  // clients/extension/scripts/popup.js
  var dom = new DOM(document, document.documentElement);
  var BROWSER_BRAND = "chrome";
  var LOCALES = JSON.parse('["ar","bg","ca","cs","da","de","el","en-GB","en-US","es-419","es","fi","fil","fr","he","hi","hr","hu","id","it","ja","ko","lt","lv","nl","no","pl","pt-PT","pt","ro","ru","sk","sl","sr-Latn","sr","sv","ta","te","th","tr","uk","vi","zh-HK","zh-TW","zh"]');
  var CHROME_STRINGS = {
    localhostErrorMessage: "Use DevTools to audit pages on localhost."
  };
  var FIREFOX_STRINGS = {
    localhostErrorMessage: "Use the Lighthouse Node CLI to audit pages on localhost."
  };
  var STRINGS = BROWSER_BRAND === "chrome" ? CHROME_STRINGS : FIREFOX_STRINGS;
  function createOptionItem(text, id, isChecked) {
    const input = document.createElement("input");
    input.setAttribute("type", "checkbox");
    input.setAttribute("value", id);
    if (isChecked) {
      input.setAttribute("checked", "checked");
    }
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = text;
    label.append(input, span);
    const listItem = document.createElement("li");
    listItem.append(label);
    return listItem;
  }
  function createRadioItem(name, text, id, isChecked) {
    const input = document.createElement("input");
    input.setAttribute("type", "radio");
    input.setAttribute("value", id);
    input.setAttribute("name", name);
    if (isChecked) {
      input.setAttribute("checked", "checked");
    }
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = text;
    label.append(input, span);
    const listItem = document.createElement("li");
    listItem.append(label);
    return listItem;
  }
  function onGenerateReportButtonClick(backend, url, settings) {
    let apiUrl;
    if (backend === "psi") {
      apiUrl = new URL("https://pagespeed.web.dev/analysis");
      apiUrl.searchParams.append("url", url);
      apiUrl.searchParams.append("form_factor", settings.device);
      for (const category of settings.selectedCategories) {
        apiUrl.searchParams.append("category", category);
      }
      apiUrl.searchParams.append("hl", settings.locale);
    } else {
      apiUrl = new URL("https://googlechrome.github.io/lighthouse/viewer/");
      apiUrl.searchParams.append("psiurl", url);
      apiUrl.searchParams.append("strategy", settings.device);
      for (const category of settings.selectedCategories) {
        apiUrl.searchParams.append("category", category);
      }
      apiUrl.searchParams.append("locale", settings.locale);
    }
    apiUrl.searchParams.append("utm_source", "lh-chrome-ext");
    window.open(apiUrl.href);
  }
  function generateCategoryOptionsList(settings) {
    const frag = document.createDocumentFragment();
    DEFAULT_CATEGORIES.forEach((category) => {
      const isChecked = settings.selectedCategories.includes(category.id);
      frag.append(createOptionItem(category.title, category.id, isChecked));
    });
    const optionsCategoriesList = dom.find(".options__categories");
    optionsCategoriesList.append(frag);
  }
  function generateBackendOptionsList(settings) {
    const frag = document.createDocumentFragment();
    BACKENDS.forEach((backend) => {
      const isChecked = settings.backend === backend.id;
      frag.append(createRadioItem("backend", backend.title, backend.id, isChecked));
    });
    const optionsCategoriesList = dom.find(".options__backend");
    optionsCategoriesList.append(frag);
  }
  function getLocalizedLanguageRegion(localeString, currentLocale) {
    const locale = new Intl.Locale(localeString);
    const localLanguage = locale.language || "en";
    const localBaseName = locale.baseName || "en-US";
    const devtoolsLoc = new Intl.Locale(currentLocale);
    const targetLanguage = localLanguage === devtoolsLoc.language ? "en" : localBaseName;
    const languageInCurrentLocale = new Intl.DisplayNames([currentLocale], { type: "language" }).of(localLanguage);
    const languageInTargetLocale = new Intl.DisplayNames([targetLanguage], { type: "language" }).of(localLanguage);
    let wrappedRegionInCurrentLocale = "";
    let wrappedRegionInTargetLocale = "";
    if (locale.region) {
      const regionInCurrentLocale = new Intl.DisplayNames([currentLocale], { type: "region", style: "short" }).of(locale.region);
      const regionInTargetLocale = new Intl.DisplayNames([targetLanguage], { type: "region", style: "short" }).of(locale.region);
      wrappedRegionInCurrentLocale = ` (${regionInCurrentLocale})`;
      wrappedRegionInTargetLocale = ` (${regionInTargetLocale})`;
    }
    const lhs = languageInCurrentLocale + wrappedRegionInCurrentLocale;
    const rhs = languageInTargetLocale + wrappedRegionInTargetLocale;
    if (lhs === rhs) {
      return lhs;
    }
    return `${lhs} - ${rhs}`;
  }
  function generateLocaleOptionsList(settings) {
    const frag = document.createDocumentFragment();
    LOCALES.forEach((locale) => {
      const optionEl = document.createElement("option");
      optionEl.textContent = getLocalizedLanguageRegion(locale, navigator.language);
      optionEl.value = locale;
      if (settings.locale === locale) {
        optionEl.selected = true;
      }
      frag.append(optionEl);
    });
    const optionsLocalesList = dom.find(".options__locales");
    optionsLocalesList.append(frag);
  }
  function configureVisibleSettings(settings) {
    const optionsCategoriesList = dom.find(".options__categories");
    optionsCategoriesList.parentElement?.classList.toggle("hidden", settings.backend === "psi");
  }
  function fillDevToolsShortcut() {
    const el = dom.find(".devtools-shortcut");
    const isMac = /mac/i.test(navigator.platform);
    el.textContent = isMac ? "\u2318\u2325I (Cmd+Opt+I)" : "F12";
  }
  function readSettingsFromDomAndPersist() {
    const optionsEl = dom.find(".section--options");
    const backend = dom.find(".options__backend input:checked").value;
    const locale = dom.find("select.options__locales").value;
    const checkboxes = optionsEl.querySelectorAll(".options__categories input:checked");
    const selectedCategories = Array.from(checkboxes).map((input) => input.value);
    const device = dom.find('input[name="device"]:checked').value;
    const settings = {
      backend,
      locale,
      selectedCategories,
      device
    };
    saveSettings(settings);
    return settings;
  }
  function getSiteUrl() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, function(tabs) {
        if (tabs.length === 0 || !tabs[0].url) {
          return;
        }
        const url = new URL(tabs[0].url);
        if (url.hostname === "localhost") {
          reject(new Error(STRINGS.localhostErrorMessage));
        } else if (/^(chrome|about)/.test(url.protocol)) {
          reject(new Error(`Cannot audit ${url.protocol}// pages.`));
        } else {
          resolve(url);
        }
      });
    });
  }
  async function initPopup() {
    if (BROWSER_BRAND === "chrome") {
      fillDevToolsShortcut();
    }
    const browserBrandEl = dom.find(`.browser-brand--${BROWSER_BRAND}`);
    browserBrandEl.classList.remove("hidden");
    const generateReportButton = dom.find("button.button--generate");
    const psiDisclaimerEl = dom.find(".psi-disclaimer");
    const errorMessageEl = dom.find(".errormsg");
    const optionsFormEl = dom.find(".options__form");
    let siteUrl;
    let settings;
    try {
      siteUrl = await getSiteUrl();
      settings = await loadSettings();
    } catch (err) {
      generateReportButton.disabled = true;
      psiDisclaimerEl.remove();
      errorMessageEl.textContent = err.message;
      return;
    }
    generateBackendOptionsList(settings);
    generateCategoryOptionsList(settings);
    generateLocaleOptionsList(settings);
    configureVisibleSettings(settings);
    const selectedDeviceEl = dom.find(`.options__device input[value="${settings.device}"]`);
    selectedDeviceEl.checked = true;
    generateReportButton.addEventListener("click", () => {
      onGenerateReportButtonClick(settings.backend, siteUrl.href, settings);
    });
    optionsFormEl.addEventListener("change", () => {
      settings = readSettingsFromDomAndPersist();
      configureVisibleSettings(settings);
    });
  }
  initPopup();
})();
/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
