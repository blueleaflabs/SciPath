/**
 * Which hostnames this deployment answers for (2.9). An unknown host
 * pointed at the Worker used to render the platform's front door under
 * that host's name; now it is refused before any tenant is resolved.
 *
 * Run: npm run test:hosts
 */
import assert from 'node:assert/strict';
import { hostIsKnown } from '../src/lib/hosts.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const ROOT = 'scipath.org';
const tenants = (h) => h.split('.')[0] === 'montavista';
const ours = (h, root = ROOT) => hostIsKnown(h, root, tenants);

test('the root, www and a tenant label are ours', () => {
  assert.ok(ours('scipath.org'));
  assert.ok(ours('www.scipath.org'));
  assert.ok(ours('montavista.scipath.org'));
  assert.ok(ours('Montavista.scipath.org:443'));
});

test('local names and platform previews are ours', () => {
  assert.ok(ours('localhost:4321'));
  assert.ok(ours('montavista.localhost:4321'));
  assert.ok(ours('scipath-abc.pages.dev'));
  assert.ok(ours('scipath.someone.workers.dev'));
});

test('a stranger pointed at the worker is not', () => {
  assert.equal(ours('evil.example.com'), false);
  assert.equal(ours('nobody.scipath.org'), false);
  assert.equal(ours('scipath.org.evil.example'), false);
});

test('a tenant label answers even when the root domain is unset', () => {
  assert.ok(ours('montavista.scipath.org', 'localhost:4321'));
});

if (process.exitCode) console.error(`\n${passed} passed, with failures.`);
else console.log(`${passed} host assertions passed.`);
