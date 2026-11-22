// Loads the game script from japa-or-stay.html into a Node sandbox with a stubbed browser,
// so the rules and the cinematic character system can be tested without a browser.
// Usage: const G = loadGame(); G.run('newState(...)')  (G.ctx holds the sandbox globals)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadGame({ store = {} } = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'japa-or-stay.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const code = scripts[scripts.length - 1];
  const el = () => ({ textContent: '', innerHTML: '', hidden: false, dataset: {}, style: {}, classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {}, querySelector() { return null }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, focus() {}, scrollIntoView() {}, remove() {} });
  const elements = {};
  const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const ctx = {
    console, Math, Date, JSON, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0,
    localStorage, location: { hash: '', protocol: 'file:', href: 'file:///game' }, navigator: { userAgent: 'node', onLine: true },
    matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, scrollTo() {}, scrollY: 0,
    document: { getElementById: id => (elements[id] = elements[id] || el()), querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: el, body: el(), documentElement: el(), hidden: false, activeElement: null }
  };
  ctx.window = ctx; ctx.self = ctx; ctx.top = ctx;
  vm.createContext(ctx);
  // top-level const/let are not properties of the sandbox, so expose the ones the tests need
  vm.runInContext(code + '\n;globalThis.__get = n => eval(n);', ctx, { filename: 'japa-or-stay.html' });
  return { ctx, store, elements, run: expr => ctx.__get(expr) };
}

module.exports = { loadGame };
