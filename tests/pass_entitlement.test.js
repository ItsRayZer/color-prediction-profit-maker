import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PassManager,
  SEVEN_DAYS_MS,
  PASS_STORAGE_KEY,
  isUserPaid,
  isUserLoggedIn,
  canAccessAllTabs,
  getPassDetails,
  activateSevenDayPass,
  restorePassByPaymentId,
  revokePass,
  parsePaymentUrlParams
} from '../src/auth/passManager.js';

function createMockStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get _data() { return Object.fromEntries(map); }
  };
}

test('7-Day Premium Pass & Tab Entitlement Suite', async (t) => {
  const BASE_TIME = 1728038400000; // Reference Epoch

  await t.test('1. Guest user (not logged in, no pass) is locked out of restricted tabs', () => {
    const storage = createMockStorage();
    assert.equal(isUserLoggedIn(storage), false);
    assert.equal(isUserPaid(storage, BASE_TIME), false);
    assert.equal(canAccessAllTabs(storage, BASE_TIME), false);

    const details = getPassDetails(storage, BASE_TIME);
    assert.equal(details.hasPass, false);
    assert.equal(details.isActive, false);
    assert.equal(details.canAccessAllTabs, false);
  });

  await t.test('2. Logged-in user has 100% free access to all tabs without pass', () => {
    const storage = createMockStorage({ dhaniwin_is_logged_in: 'true' });
    assert.equal(isUserLoggedIn(storage), true);
    assert.equal(isUserPaid(storage, BASE_TIME), false);
    assert.equal(canAccessAllTabs(storage, BASE_TIME), true);

    const details = getPassDetails(storage, BASE_TIME);
    assert.equal(details.isLoggedIn, true);
    assert.equal(details.canAccessAllTabs, true);
  });

  await t.test('3. Activating 7-day pass grants access and sets exact 7-day duration (604,800,000 ms)', () => {
    const storage = createMockStorage();
    const pass = activateSevenDayPass('pay_test123456', { amount: 9 }, storage, BASE_TIME);

    assert.equal(pass.paymentId, 'pay_test123456');
    assert.equal(pass.amount, 9);
    assert.equal(pass.activatedAt, BASE_TIME);
    assert.equal(pass.expiresAt, BASE_TIME + SEVEN_DAYS_MS);
    assert.equal(pass.status, 'active');

    assert.equal(isUserPaid(storage, BASE_TIME), true);
    assert.equal(canAccessAllTabs(storage, BASE_TIME), true);

    const details = getPassDetails(storage, BASE_TIME);
    assert.equal(details.hasPass, true);
    assert.equal(details.isActive, true);
    assert.equal(details.remainingDays, 7);
    assert.equal(details.canAccessAllTabs, true);
  });

  await t.test('4. Pass remains active at 6 days, 23 hours', () => {
    const storage = createMockStorage();
    activateSevenDayPass('pay_test123456', { amount: 9 }, storage, BASE_TIME);

    const sixDaysLater = BASE_TIME + (6 * 24 * 3600 * 1000);
    assert.equal(isUserPaid(storage, sixDaysLater), true);
    assert.equal(canAccessAllTabs(storage, sixDaysLater), true);

    const details = getPassDetails(storage, sixDaysLater);
    assert.equal(details.isActive, true);
    assert.equal(details.remainingDays, 1);
  });

  await t.test('5. Pass expires strictly after 7 days (7 days + 1ms) and revokes non-home access', () => {
    const storage = createMockStorage();
    activateSevenDayPass('pay_test123456', { amount: 9 }, storage, BASE_TIME);

    const sevenDaysAndOneMs = BASE_TIME + SEVEN_DAYS_MS + 1;
    assert.equal(isUserPaid(storage, sevenDaysAndOneMs), false, 'Pass should expire after 7 days');
    assert.equal(canAccessAllTabs(storage, sevenDaysAndOneMs), false, 'Access should be revoked');

    const details = getPassDetails(storage, sevenDaysAndOneMs);
    assert.equal(details.isActive, false);
    assert.equal(details.isExpired, true);
    assert.equal(details.countdownText, 'Expired');
  });

  await t.test('6. Renewing an active pass extends expiry from previous expiresAt by another 7 days', () => {
    const storage = createMockStorage();
    const pass1 = activateSevenDayPass('pay_initial', { amount: 9 }, storage, BASE_TIME);
    assert.equal(pass1.expiresAt, BASE_TIME + SEVEN_DAYS_MS);

    // Renew 2 days into the pass
    const twoDaysLater = BASE_TIME + (2 * 24 * 3600 * 1000);
    const pass2 = activateSevenDayPass('pay_renewal', { amount: 9 }, storage, twoDaysLater);

    // Expiry should now be BASE_TIME + 14 days (previous expiresAt + 7 days)
    assert.equal(pass2.expiresAt, BASE_TIME + (2 * SEVEN_DAYS_MS));
    assert.equal(isUserPaid(storage, twoDaysLater), true);
  });

  await t.test('7. Restoring pass by payment ID activates pass safely', () => {
    const storage = createMockStorage();
    const invalidResult = restorePassByPaymentId('pay', storage, BASE_TIME);
    assert.equal(invalidResult.success, false);

    const validResult = restorePassByPaymentId('pay_restore999', storage, BASE_TIME);
    assert.equal(validResult.success, true);
    assert.equal(isUserPaid(storage, BASE_TIME), true);
    assert.equal(validResult.pass.paymentId, 'pay_restore999');
  });

  await t.test('8. parsePaymentUrlParams extracts Razorpay redirect callback correctly', () => {
    const url1 = '?razorpay_payment_id=pay_PzX12345&razorpay_payment_link_status=paid';
    const parsed1 = parsePaymentUrlParams(url1);
    assert.notEqual(parsed1, null);
    assert.equal(parsed1.paymentId, 'pay_PzX12345');
    assert.equal(parsed1.paySuccess, true);

    const url2 = '?pay_success=true';
    const parsed2 = parsePaymentUrlParams(url2);
    assert.notEqual(parsed2, null);
    assert.equal(parsed2.paySuccess, true);

    const url3 = '?some_other_param=123';
    const parsed3 = parsePaymentUrlParams(url3);
    assert.equal(parsed3, null);
  });

  await t.test('9. Revoking pass clears storage cleanly', () => {
    const storage = createMockStorage();
    activateSevenDayPass('pay_temp', { amount: 9 }, storage, BASE_TIME);
    assert.equal(isUserPaid(storage, BASE_TIME), true);

    revokePass(storage);
    assert.equal(isUserPaid(storage, BASE_TIME), false);
    assert.equal(storage.getItem(PASS_STORAGE_KEY), null);
  });
});
