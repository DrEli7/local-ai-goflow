import test from 'node:test';
import assert from 'node:assert/strict';

import { measureOutput } from '../src/output-metrics.mjs';

const COUNTING_METHOD = 'unicode-code-points-including-whitespace-and-punctuation';

// 实际提供的纪要正文，精确 50 个 Unicode 码点（全为 BMP，UTF-16 单元数同为 50）。
const SUMMARY_BODY =
  '小林周三18:00前完成接口文档，小周周五10:00演示功能，小陈周四16:00前完成演示数据检查。';

const countCodePoints = (text) => Array.from(text).length;

const nestArrays = (levels, inner) => {
  let value = inner;
  for (let index = 0; index < levels; index += 1) {
    value = [value];
  }
  return value;
};

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
};

test('导出 measureOutput 函数', () => {
  assert.equal(typeof measureOutput, 'function');
});

test('精确统计本次 50 个码点的纪要正文', () => {
  assert.equal(countCodePoints(SUMMARY_BODY), 50);
  assert.equal(SUMMARY_BODY.length, 50);

  const result = measureOutput({ body: SUMMARY_BODY });

  assert.equal(result.countingMethod, COUNTING_METHOD);
  assert.deepEqual(result.strings, [
    { path: '/body', unicodeCodePoints: 50, utf16CodeUnits: 50 },
  ]);
  assert.deepEqual(result.totals, { unicodeCodePoints: 50, utf16CodeUnits: 50 });
});

test('返回结构只包含确定性元数据', () => {
  const result = measureOutput({ a: 'x' });

  assert.deepEqual(Object.keys(result).sort(), ['countingMethod', 'strings', 'totals']);
  assert.deepEqual(
    Object.keys(result.strings[0]).sort(),
    ['path', 'unicodeCodePoints', 'utf16CodeUnits'],
  );
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'candidateHash'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.strings[0], 'text'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.strings[0], 'value'), false);
});

test('字符串叶子按确定性顺序收集，totals 为各叶子之和', () => {
  const result = measureOutput({ b: 'yy', a: ['x', { c: 'zzz' }] });

  assert.deepEqual(result.strings, [
    { path: '/a/0', unicodeCodePoints: 1, utf16CodeUnits: 1 },
    { path: '/a/1/c', unicodeCodePoints: 3, utf16CodeUnits: 3 },
    { path: '/b', unicodeCodePoints: 2, utf16CodeUnits: 2 },
  ]);
  assert.deepEqual(result.totals, { unicodeCodePoints: 6, utf16CodeUnits: 6 });
});

test('中文、空白、标点与换行都逐码点计数', () => {
  const value = '中文 空格\t制表\n换行，。！？';
  const result = measureOutput({ text: value });

  assert.equal(result.strings[0].unicodeCodePoints, 15);
  assert.equal(result.strings[0].utf16CodeUnits, 15);
  assert.deepEqual(result.totals, {
    unicodeCodePoints: countCodePoints(value),
    utf16CodeUnits: value.length,
  });
});

test('代理对 emoji：码点数小于 UTF-16 单元数', () => {
  const result = measureOutput(['😀']);

  assert.deepEqual(result.strings, [
    { path: '/0', unicodeCodePoints: 1, utf16CodeUnits: 2 },
  ]);
  assert.deepEqual(result.totals, { unicodeCodePoints: 1, utf16CodeUnits: 2 });
});

test('ZWJ 家庭 emoji：码点数与可视字形数不同', () => {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  const result = measureOutput({ emoji: family });

  assert.equal(result.strings[0].unicodeCodePoints, 5);
  assert.equal(result.strings[0].utf16CodeUnits, 8);
  assert.notEqual(result.strings[0].unicodeCodePoints, 1);
});

test('肤色修饰 emoji 逐码点计数', () => {
  const result = measureOutput({ emoji: '👍🏽' });

  assert.equal(result.strings[0].unicodeCodePoints, 2);
  assert.equal(result.strings[0].utf16CodeUnits, 4);
});

test('组合字符：分解形式与预组合形式计数不同', () => {
  const result = measureOutput(['e\u0301', '\u00e9']);

  assert.deepEqual(result.strings, [
    { path: '/0', unicodeCodePoints: 2, utf16CodeUnits: 2 },
    { path: '/1', unicodeCodePoints: 1, utf16CodeUnits: 1 },
  ]);
  assert.deepEqual(result.totals, { unicodeCodePoints: 3, utf16CodeUnits: 3 });
});

test('嵌套数组与对象的 JSON Pointer 及 ~ / 转义', () => {
  const input = {
    'a/b': 'slash',
    'a~b': 'tilde',
    'a~1b': 'literal',
    nested: [{ 'x/y~z': '' }],
    list: ['one', ['two']],
  };

  const result = measureOutput(input);

  assert.deepEqual(result.strings.map((entry) => entry.path), [
    '/a~1b',
    '/a~01b',
    '/a~0b',
    '/list/0',
    '/list/1/0',
    '/nested/0/x~1y~0z',
  ]);
  assert.deepEqual(
    result.strings.map((entry) => entry.unicodeCodePoints),
    [5, 7, 5, 3, 3, 0],
  );
  assert.deepEqual(result.totals, { unicodeCodePoints: 23, utf16CodeUnits: 23 });
});

test('对象键顺序与插入顺序无关', () => {
  const first = measureOutput({ b: 'B', a: 'A', 10: 'ten', 2: 'two' });
  const second = measureOutput({ 2: 'two', 10: 'ten', a: 'A', b: 'B' });

  assert.deepEqual(first, second);
  assert.deepEqual(first.strings.map((entry) => entry.path), ['/10', '/2', '/a', '/b']);
});

test('根为字符串时 path 为空串', () => {
  const result = measureOutput('root');

  assert.deepEqual(result.strings, [
    { path: '', unicodeCodePoints: 4, utf16CodeUnits: 4 },
  ]);
  assert.deepEqual(result.totals, { unicodeCodePoints: 4, utf16CodeUnits: 4 });
});

test('无字符串时 strings 为空且 totals 为 0', () => {
  const inputs = [
    null,
    true,
    false,
    42,
    {},
    [],
    { a: 1, b: 2.5, c: null, d: true, e: false, f: [], g: {} },
  ];

  for (const input of inputs) {
    const result = measureOutput(input);
    assert.deepEqual(result.strings, []);
    assert.deepEqual(result.totals, { unicodeCodePoints: 0, utf16CodeUnits: 0 });
  }
});

test('接受 null 原型记录与普通数组', () => {
  const record = Object.create(null);
  record.a = 'x';

  const recordResult = measureOutput(record);
  assert.deepEqual(recordResult.strings, [
    { path: '/a', unicodeCodePoints: 1, utf16CodeUnits: 1 },
  ]);

  const arrayResult = measureOutput(['x']);
  assert.deepEqual(arrayResult.strings, [
    { path: '/0', unicodeCodePoints: 1, utf16CodeUnits: 1 },
  ]);
});

test('不修改输入', () => {
  const input = { z: 'last', a: { b: ['x', { c: 'y' }] }, n: 3 };
  const snapshot = JSON.parse(JSON.stringify(input));
  const before = JSON.stringify(input);

  measureOutput(input);

  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(input, snapshot);
});

test('冻结的输入仍可统计', () => {
  const input = deepFreeze({ a: ['x'], b: 'yz' });
  const result = measureOutput(input);

  assert.deepEqual(result.totals, { unicodeCodePoints: 3, utf16CodeUnits: 3 });
});

test('结果不泄漏正文，也不含 candidateHash', () => {
  const secret = 'SECRET-正文明文-😀';
  const result = measureOutput({ 'k/1': secret, nested: [secret] });
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes('SECRET'), false);
  assert.equal(serialized.includes('正文'), false);
  assert.equal(serialized.includes('😀'), false);
  assert.equal(serialized.includes('candidateHash'), false);
  assert.equal(result.strings.length, 2);
  for (const entry of result.strings) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'path',
      'unicodeCodePoints',
      'utf16CodeUnits',
    ]);
  }
});

test('非 JSON 值抛出 TypeError', () => {
  const nonJsonValues = [undefined, Symbol('s'), 10n, () => {}];

  for (const value of nonJsonValues) {
    assert.throws(() => measureOutput(value), TypeError);
    assert.throws(() => measureOutput({ a: value }), TypeError);
    assert.throws(() => measureOutput([value]), TypeError);
  }
});

test('非 JSON 对象（Date/Map/Set/包装对象/类实例）抛出 TypeError', () => {
  class Custom {
    constructor() {
      this.a = 'x';
    }
  }

  const nonJsonObjects = [
    new Date(0),
    new Map([['a', 'x']]),
    new Set(['x']),
    new String('x'),
    new Custom(),
    Object.create({ inherited: true }),
  ];

  for (const value of nonJsonObjects) {
    assert.throws(() => measureOutput(value), TypeError);
    assert.throws(() => measureOutput({ a: value }), TypeError);
    assert.throws(() => measureOutput([value]), TypeError);
    assert.throws(() => measureOutput({ nested: { deep: value } }), TypeError);
  }
});

test('非有限数抛出 TypeError', () => {
  const nonFinite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  for (const value of nonFinite) {
    assert.throws(() => measureOutput(value), TypeError);
    assert.throws(() => measureOutput({ n: value }), TypeError);
    assert.throws(() => measureOutput([value]), TypeError);
  }
});

test('循环引用抛出 TypeError', () => {
  const object = { a: 'x' };
  object.self = object;
  assert.throws(() => measureOutput(object), TypeError);

  const array = ['x'];
  array.push(array);
  assert.throws(() => measureOutput(array), TypeError);

  const deep = { a: { b: {} } };
  deep.a.b.back = deep;
  assert.throws(() => measureOutput(deep), TypeError);
});

test('超过 32 层嵌套抛出 TypeError', () => {
  const allowed = measureOutput(nestArrays(31, 'x'));
  let expectedPath = '';
  for (let index = 0; index < 31; index += 1) {
    expectedPath += '/0';
  }
  assert.deepEqual(allowed.strings, [
    { path: expectedPath, unicodeCodePoints: 1, utf16CodeUnits: 1 },
  ]);

  assert.throws(() => measureOutput(nestArrays(32, 'x')), TypeError);
  assert.throws(() => measureOutput(nestArrays(64, 'x')), TypeError);
});

test('超过 10000 个节点抛出 TypeError', () => {
  const exactlyAtLimit = measureOutput(Array.from({ length: 9999 }, (_, index) => index));
  assert.deepEqual(exactlyAtLimit.strings, []);
  assert.deepEqual(exactlyAtLimit.totals, { unicodeCodePoints: 0, utf16CodeUnits: 0 });

  const overLimit = Array.from({ length: 10000 }, (_, index) => index);
  assert.throws(() => measureOutput(overLimit), TypeError);
});
