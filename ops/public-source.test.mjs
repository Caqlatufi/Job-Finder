import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {audit, directoryFiles, projectRoot} from './public-source.mjs';

test('public source audit rejects contacts, keys and private paths without returning their values', async () => {
  const root = await mkdtemp(path.join(projectRoot, 'runtime/audit-fixture-'));
  const contact = ['138', '0013', '8000'].join('');
  const email = ['fixture', '@', 'private.invalid'].join('');
  const key = ['sk-', 'a'.repeat(32)].join('');
  await writeFile(path.join(root, 'sample.md'), [contact, email, key].join('\n'));
  await writeFile(path.join(root, '.env'), 'JD_FIXTURE=value');
  const findings = await audit(root, await directoryFiles(root));
  assert.deepEqual(new Set(findings.map(item => item.rule)), new Set(['phone-number', 'personal-email', 'api-key', 'private-file']));
  assert.equal(JSON.stringify(findings).includes(contact), false);
  assert.equal(JSON.stringify(findings).includes(email), false);
  assert.equal(JSON.stringify(findings).includes(key), false);
});

test('public criteria example rejects confirmed answers while allowing loopback service addresses', async () => {
  const root = await mkdtemp(path.join(projectRoot, 'runtime/audit-fixture-'));
  const {mkdir} = await import('node:fs/promises');
  await mkdir(path.join(root, 'config'));
  await writeFile(path.join(root, 'README.md'), 'http://127.0.0.1:7890/');
  await writeFile(path.join(root, 'config/criteria.example.json'), JSON.stringify({
    baselineRules: [], agentNotes: [], sections: [{fields: [{value: 'fixture', status: 'CONFIRMED'}]}],
  }));
  const findings = await audit(root, await directoryFiles(root));
  assert.deepEqual(findings, [{file: 'config/criteria.example.json', rule: 'personal-criteria-answer'}]);
});

test('invalid URL userinfo fixtures are not mistaken for personal email addresses', async () => {
  const root = await mkdtemp(path.join(projectRoot, 'runtime/audit-fixture-'));
  await writeFile(path.join(root, 'sample.mjs'),
    'https://user@www.zhipin.com/job_detail/a.html\nhttps://x@careers.example.com/jobs/42\n');
  assert.deepEqual(await audit(root, await directoryFiles(root)), []);
  const email = ['fixture', '@', 'private.invalid'].join('');
  await writeFile(path.join(root, 'sample.mjs'), `mailto:${email}\n${email}\n`);
  assert.deepEqual((await audit(root, await directoryFiles(root))).map(item => item.rule),
    ['personal-email', 'personal-email']);
});

test('map data, Python sources and TypeScript declarations are scanned as text', async () => {
  const root = await mkdtemp(path.join(projectRoot, 'runtime/audit-fixture-'));
  const files = ['map.geojson', 'generator.py', 'contract.d.mts'];
  const email = ['fixture', '@', 'private.invalid'].join('');
  for (const file of files) await writeFile(path.join(root, file), email);
  const findings = await audit(root, await directoryFiles(root));
  assert.equal(findings.length, files.length);
  assert.ok(findings.every(item => item.rule === 'personal-email'));
});

test('known metro OSM identifiers are allowed while contact values remain rejected', async () => {
  const root = await mkdtemp(path.join(projectRoot, 'runtime/audit-fixture-'));
  const {mkdir} = await import('node:fs/promises');
  const file = 'frontend/src/company/assets/shanghai-metro.geojson';
  await mkdir(path.dirname(path.join(root, file)), {recursive: true});
  const phone = ['138', '0013', '8000'].join('');
  await writeFile(path.join(root, file), JSON.stringify({nodes: [Number(phone)], relations: [Number(phone)]}));
  assert.deepEqual(await audit(root, await directoryFiles(root)), []);
  for (const properties of [{nodes: [phone]}, {phone: Number(phone)}]) {
    await writeFile(path.join(root, file), JSON.stringify(properties));
    assert.deepEqual((await audit(root, await directoryFiles(root))).map(item => item.rule), ['phone-number']);
  }
});
