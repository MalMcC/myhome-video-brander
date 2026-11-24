const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifyBranchContacts } = require('./branch-contacts');

const example = 'https://example.com';
const branch = { name: 'High Street', phone: '01632 960123', email: 'highstreet@example.com', source: example + '/contact#high-street' };
const html = `<main><article id="high-street"><h2>High Street</h2>
  <a href="tel:+441632960123">+44 (0)1632 960123</a>
  <a href="mailto:HighStreet@example.com?subject=Hello">High Street office email</a></article>
  <article id="market"><h2>Market Square</h2><a href="tel:01632960124">01632 960124</a><a href="mailto:market@example.com">Market Square office email</a></article></main>`;
const fetchPage = async () => html;

test('returns both verified branches and checks a shared official page once', async () => {
  let calls = 0;
  const rows = [branch, { name: 'Market Square', phone: '01632 960124', email: 'market@example.com', source: example + '/contact#market' }];
  const contacts = await verifyBranchContacts(example, rows, async () => { calls++; return html; });
  assert.equal(calls, 1);
  assert.deepEqual(contacts, rows.map(({ source, ...contact }) => contact));
});

test('accepts the classic form without changing the published display details', async () => {
  const row = Object.values(branch).join(' | ');
  assert.deepEqual(await verifyBranchContacts(example, row, fetchPage), [
    { name: branch.name, phone: branch.phone, email: branch.email }
  ]);
});

test('rejects a phone or email copied from a different branch', async () => {
  for (const change of [{ phone: '01632 960124' }, { email: 'market@example.com' }]) {
    await assert.rejects(verifyBranchContacts(example, [{ ...branch, ...change, source: example + '/contact' }], fetchPage), /couldn’t verify/);
  }
});

test('rejects missing, duplicate or off-domain sources before generating', async () => {
  await assert.rejects(verifyBranchContacts(example, [], fetchPage), /every branch/);
  await assert.rejects(verifyBranchContacts(example, [branch, branch], fetchPage), /once/);
  await assert.rejects(verifyBranchContacts(example, [{ ...branch, source: 'https://other.example/contact' }], async () => { assert.fail('Off-domain page fetched'); }), /official website/);
});

test('both bundled MyDomi films match the approved Marketing Hub masters', () => {
  const { createHash } = require('node:crypto');
  const { readFileSync } = require('node:fs');
  const path = require('node:path');
  const approved = {
    rural: '0a842528f255a9888b8bff1183fc364bf28160e32d118567a98b85f5758df8f9',
    urban: '77cb275cd5619f3a4908b773e9a9c0e367fc3543ec5cdf4104624b019b9995ba'
  };
  for (const [name, expected] of Object.entries(approved)) {
    const file = path.join(__dirname, 'master', `mydomi-${name}.mp4`);
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), expected);
  }
});
