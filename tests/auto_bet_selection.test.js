import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Mock a lightweight browser DOM environment for testing the bridge automation suite
class MockElement {
  constructor(tagName = 'div', className = '', id = '') {
    this.tagName = tagName.toUpperCase();
    this.className = className;
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.innerText = '';
    this.textContent = '';
    this.style = {};
    this._value = '';
    this.checked = false;
    this.classList = {
      _set: new Set(className.split(' ').filter(Boolean)),
      contains: (c) => this.classList._set.has(c),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (this.classList._set.has(c)) this.classList._set.delete(c);
          else this.classList._set.add(c);
        } else if (force) this.classList._set.add(c);
        else this.classList._set.delete(c);
      }
    };
    this._listeners = {};
    this.offsetParent = {};
    this.offsetWidth = 50;
    this.offsetHeight = 50;
  }

  get value() { return this._value !== undefined ? this._value : ''; }
  set value(v) { this._value = String(v); }

  getAttribute(attr) { return this.attributes[attr] || null; }
  setAttribute(attr, val) { this.attributes[attr] = String(val); }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches && cur.matches(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  matches(sel) {
    if (!sel) return false;
    const parts = sel.split(',').map(s => s.trim());
    return parts.some(p => {
      if (p.includes('.')) {
        const [tag, ...classes] = p.split('.');
        if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
        return classes.every(c => this.classList.contains(c));
      }
      if (p.startsWith('#')) return this.id === p.slice(1);
      if (p.includes('[class*=')) {
        const clsPart = p.match(/\[class\*=["']?([^"']+)["']?\]/)?.[1];
        return clsPart && typeof this.className === 'string' && this.className.includes(clsPart);
      }
      if (p.includes('[data-type=')) {
        const dt = p.match(/\[data-type=["']?([^"']+)["']?\]/)?.[1];
        return dt && this.getAttribute('data-type') === dt;
      }
      return this.tagName.toLowerCase() === p.toLowerCase();
    });
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  querySelectorAll(sel) {
    const results = [];
    const traverse = (node) => {
      for (const child of node.children) {
        if (child.matches && child.matches(sel)) results.push(child);
        traverse(child);
      }
    };
    traverse(this);
    return results;
  }

  addEventListener(ev, fn) {
    if (!this._listeners[ev]) this._listeners[ev] = [];
    this._listeners[ev].push(fn);
  }

  dispatchEvent(ev) {
    const list = this._listeners[ev.type] || [];
    list.forEach(fn => fn.call(this, ev));
    if (this.parentNode && ev.bubbles) {
      this.parentNode.dispatchEvent(ev);
    }
    return true;
  }

  focus() {}
  click() {
    this.dispatchEvent({ type: 'click', bubbles: true, cancelable: true });
  }

  getBoundingClientRect() {
    return { left: 100, top: 200, width: 80, height: 40 };
  }
}

class MockDocument {
  constructor() {
    this.body = new MockElement('body');
    this.documentElement = this.body;
  }
  createElement(tag) { return new MockElement(tag); }
  getElementById(id) {
    if (this.body.id === id) return this.body;
    return this.body.querySelector(`#${id}`);
  }
  querySelector(sel) { return this.body.querySelector(sel); }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
}

describe('DhaniWin Auto Target & Stake Selection Engine', () => {
  let bridgeAutomation;
  const originalSetInterval = globalThis.setInterval;
  const originalSetTimeout = globalThis.setTimeout;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Disable background loops in test runner
    globalThis.setInterval = () => 99999;
    globalThis.setTimeout = (fn) => 99999;
    globalThis.clearInterval = () => {};
    globalThis.clearTimeout = () => {};

    // Setup global browser mock
    globalThis.window = {
      location: { href: 'https://dhaniwin44.com/WinGo/WinGo_30S', origin: 'https://dhaniwin44.com' },
      localStorage: { getItem: () => null, setItem: () => {} },
      HTMLInputElement: MockElement,
      PointerEvent: class { constructor(t, opts) { Object.assign(this, { type: t, ...opts }); } },
      MouseEvent: class { constructor(t, opts) { Object.assign(this, { type: t, ...opts }); } },
      Event: class { constructor(t, opts) { Object.assign(this, { type: t, ...opts }); } },
      BroadcastChannel: class { constructor() {} postMessage() {} addEventListener() {} },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      addEventListener: () => {},
      removeEventListener: () => {}
    };
    globalThis.document = new MockDocument();
    globalThis.fetch = () => Promise.resolve({ ok: false });

    // Evaluate bridge script in sandboxed context
    const code = fs.readFileSync(path.join(rootDir, 'dhaniwin-bridge.js'), 'utf-8');
    new Function(code)();
    bridgeAutomation = globalThis.window.__QuantBridgeAutomation;
  });

  afterEach(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
  });

  it('1. Correctly identifies betting container and avoids history table/hud', () => {
    // History table containing "BIG"
    const historyTable = new MockElement('table', 'record-box');
    const tr = new MockElement('tr');
    const tdHistory = new MockElement('td');
    tdHistory.innerText = 'BIG';
    tr.appendChild(tdHistory);
    historyTable.appendChild(tr);
    document.body.appendChild(historyTable);

    // Betting pad
    const betBox = new MockElement('div', 'game-bet-box');
    const bigBtn = new MockElement('button', 'van-button btn-big');
    bigBtn.innerText = 'BIG\n1.98';
    const smallBtn = new MockElement('button', 'van-button btn-small');
    smallBtn.innerText = 'SMALL\n1.98';

    betBox.appendChild(bigBtn);
    betBox.appendChild(smallBtn);
    document.body.appendChild(betBox);

    const foundBig = bridgeAutomation.findTargetButton('BIG');
    assert.ok(foundBig, 'Should find target BIG button');
    assert.strictEqual(foundBig, bigBtn, 'Should select betting button, not table cell');
  });

  it('2. Locates colored bets (GREEN, RED, VIOLET) and digits (0-9)', () => {
    const betBox = new MockElement('div', 'bet-con');
    const greenBtn = new MockElement('button', 'btn-green');
    greenBtn.innerText = 'Green 2';
    const num0Btn = new MockElement('div', 'bet-item');
    num0Btn.innerText = '0';
    const num7Btn = new MockElement('div', 'bet-item');
    num7Btn.innerText = '7';

    betBox.appendChild(greenBtn);
    betBox.appendChild(num0Btn);
    betBox.appendChild(num7Btn);
    document.body.appendChild(betBox);

    const foundGreen = bridgeAutomation.findTargetButton('GREEN');
    assert.strictEqual(foundGreen, greenBtn, 'Should locate GREEN button');

    const found0 = bridgeAutomation.findTargetButton('0');
    assert.strictEqual(found0, num0Btn, 'Should locate digit 0 button');

    const found7 = bridgeAutomation.findTargetButton('7');
    assert.strictEqual(found7, num7Btn, 'Should locate digit 7 button');
  });

  it('3. Selects base ₹1 chip unit first to avoid 10x or 100x stake distortion', () => {
    const popup = new MockElement('div', 'van-popup van-popup--bottom');
    let chip1Clicked = false;

    const chip1 = new MockElement('button', 'van-button');
    chip1.innerText = '1';
    chip1.addEventListener('click', () => { chip1Clicked = true; });

    const chip10 = new MockElement('button', 'van-button active');
    chip10.innerText = '10';

    const stepperInput = new MockElement('input', 'van-stepper__input');
    stepperInput.value = '1';

    popup.appendChild(chip1);
    popup.appendChild(chip10);
    popup.appendChild(stepperInput);

    bridgeAutomation.adjustStepperStake(popup, 8);
    assert.ok(chip1Clicked, 'Must click base chip ₹1 so 1 unit = ₹1');
  });

  it('4. Updates stepper input with native descriptor setter & dispatches input events', () => {
    const popup = new MockElement('div', 'van-popup');
    const stepperInput = new MockElement('input', 'van-stepper__input');
    stepperInput.value = '1';

    let inputDispatched = false;
    let changeDispatched = false;
    stepperInput.addEventListener('input', () => { inputDispatched = true; });
    stepperInput.addEventListener('change', () => { changeDispatched = true; });

    popup.appendChild(stepperInput);

    bridgeAutomation.adjustStepperStake(popup, 16);
    assert.strictEqual(stepperInput.value, '16', 'Input value must equal requested stake 16');
    assert.ok(inputDispatched, 'Must dispatch input event for Vue reactivity');
    assert.ok(changeDispatched, 'Must dispatch change event for form model sync');
  });

  it('5. Falls back to plus/minus button stepping if direct typing fails or is readonly', () => {
    const popup = new MockElement('div', 'van-popup');
    let plusClicks = 0;

    const stepperInput = new MockElement('input', 'van-stepper__input');
    stepperInput.value = '1';

    // Override setter on input instance to simulate locked/readonly field where direct setting is ignored
    Object.defineProperty(stepperInput, 'value', {
      get() { return String(1 + plusClicks); },
      set(v) { /* ignored, simulating locked input */ },
      configurable: true
    });

    const plusBtn = new MockElement('button', 'van-stepper__plus');
    plusBtn.addEventListener('click', () => {
      plusClicks++;
    });
    const minusBtn = new MockElement('button', 'van-stepper__minus');

    popup.appendChild(stepperInput);
    popup.appendChild(plusBtn);
    popup.appendChild(minusBtn);

    // Call stepper stake adjuster for 5 units
    bridgeAutomation.adjustStepperStake(popup, 5);
    assert.strictEqual(plusClicks, 4, 'Should click plus button 4 times to step from 1 to 5');
    assert.strictEqual(stepperInput.value, '5', 'Value should reach 5 via stepper clicks');
  });

  it('6. Automatically checks terms agreement checkbox if unchecked', () => {
    const popup = new MockElement('div', 'van-popup');
    const checkbox = new MockElement('div', 'van-checkbox');
    checkbox.checked = false;

    let checkedClicked = false;
    checkbox.addEventListener('click', () => {
      checkedClicked = true;
      checkbox.classList.add('van-checkbox--checked');
    });

    popup.appendChild(checkbox);

    bridgeAutomation.adjustStepperStake(popup, 2);
    assert.ok(checkedClicked, 'Terms checkbox must be automatically checked');
  });

  it('7. Guards against round lockout when timer has < 5s remaining', () => {
    const timeBox = new MockElement('div', 'time-box van-count-down');
    timeBox.innerText = '00:03';
    document.body.appendChild(timeBox);

    const isLocked = bridgeAutomation.isRoundLockingSoon();
    assert.strictEqual(isLocked, true, 'Round must be identified as locking soon when < 5s');

    timeBox.innerText = '00:24';
    const isOpen = bridgeAutomation.isRoundLockingSoon();
    assert.strictEqual(isOpen, false, 'Round is open when >= 5s');
  });

  after(() => {
    setTimeout(() => {
      process.exit(0);
    }, 50).unref();
  });
});
