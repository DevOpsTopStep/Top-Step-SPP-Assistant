import test from 'node:test';
import assert from 'node:assert/strict';
import { el, fieldsXml, parseXml, recordToObject, find, esc } from '../src/xml.js';
import { checkEs5 } from '../src/es5check.js';

test('xml builder escapes values and rejects bad names', () => {
  assert.equal(el('Issue', {}, fieldsXml({ description: 'A & <B>', script_name__c: "x'y" })),
    '<Issue><description>A &amp; &lt;B&gt;</description><script_name__c>x&apos;y</script_name__c></Issue>');
  assert.throws(() => fieldsXml({ 'bad name': 1 }));
  assert.throws(() => el('Issue><evil', {}));
  assert.equal(esc('"'), '&quot;');
});

test('xml parser reads SPP-style responses incl. dates and status', () => {
  const xml = `<?xml version="1.0"?><response><Auth status="0"></Auth><Read status="0">
    <Issue><id>2646</id><prefix>SR-</prefix><number>2754</number><description>Auto &amp; Create</description>
    <script_name__c>create_onboard_bookings</script_name__c>
    <updated><Date><year>2026</year><month>10</month><day>27</day><hour>9</hour><minute>5</minute><second>0</second></Date></updated></Issue>
    <Issue><id>2633</id></Issue></Read></response>`;
  const doc = parseXml(xml);
  const read = find(doc, 'Read');
  assert.equal(read.attrs.status, '0');
  const rows = read.children.filter(c => c.name === 'Issue').map(recordToObject);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].description, 'Auto & Create');
  assert.equal(rows[0].updated, '2026-10-27 09:05:00');
  assert.throws(() => parseXml('<a><b></a>'));
});

test('ES5 checker accepts valid SPP script', () => {
  const code = `function main(type) {
    var p = NSOA.form.getNewRecord();
    NSOA.wsapi.disableFilterSet(true);
    var r = NSOA.wsapi.modify([], [p]);
    if (r[0].errors) { NSOA.meta.log('error', 'failed: ' + r[0].errors[0].text); }
    // const in a comment is fine; "let x" in a string is fine
    var s = "x => y";
  }`;
  const out = checkEs5(code);
  assert.equal(out.ok, true, JSON.stringify(out.errors));
});

test('ES5 checker flags ES2015+ features and syntax errors', () => {
  const bad = checkEs5('const a = [1].map(x => x * 2);\nvar s = `t${a}`;\nif (s.includes("1")) {}');
  assert.equal(bad.ok, false);
  const joined = bad.errors.join(' | ');
  for (const k of ['const', 'arrow', 'template', 'includes']) assert.match(joined, new RegExp(k));
  assert.equal(checkEs5('function (').ok, false);
  const warn = checkEs5('function main(){ for (var i=0;i<3;i++){ NSOA.wsapi.read([]); } }');
  assert.ok(warn.warnings.some(w => /inside a loop/.test(w)));
  assert.ok(warn.warnings.some(w => /disableFilterSet/.test(w)));
});
