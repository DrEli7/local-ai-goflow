/**
 * 输出字符统计（纯函数，零依赖，无 I/O）。
 *
 * measureOutput(output) 接收本插件已验证的 JSON 候选 object，
 * 递归收集所有 string 叶子并返回确定性元数据：
 * 不修改输入、不回传正文、不生成 candidateHash。
 */

const COUNTING_METHOD = 'unicode-code-points-including-whitespace-and-punctuation';

/** 允许的最大嵌套层数，根值算第 1 层。 */
const MAX_DEPTH = 32;

/** 允许访问的最大节点数，含基本类型叶子与容器。 */
const MAX_NODE_COUNT = 10000;

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

/**
 * RFC 6901 JSON Pointer 转义：先转义波浪号，再转义斜杠。
 * @param {string} token
 * @returns {string}
 */
function escapePointerToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * 统计 Unicode 码点数量（等价于展开运算符取 length，但不构造中间数组）。
 * 注意：码点不等于可视字形，组合字符与 ZWJ 序列会被逐个码点计数。
 * @param {string} text
 * @returns {number}
 */
function countUnicodeCodePoints(text) {
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    const isHighSurrogate = unit >= HIGH_SURROGATE_MIN && unit <= HIGH_SURROGATE_MAX;
    if (isHighSurrogate && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= LOW_SURROGATE_MIN && next <= LOW_SURROGATE_MAX) {
        index += 1;
      }
    }
    total += 1;
  }
  return total;
}

/**
 * 判断一个对象是否为可接受的 JSON 容器：普通数组，
 * 或原型为 Object.prototype / null 的普通记录。
 * 拒绝 Date、Map、Set、String 包装对象、类实例等非 JSON 值。
 *
 * @param {object} value
 * @returns {boolean}
 */
function isJsonContainer(value) {
  if (Array.isArray(value)) {
    return true;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 递归统计 JSON 候选值中的全部字符串叶子。
 *
 * @param {unknown} output 已验证的 JSON 候选值。
 * @returns {{countingMethod: string, strings: Array<{path: string, unicodeCodePoints: number, utf16CodeUnits: number}>, totals: {unicodeCodePoints: number, utf16CodeUnits: number}}}
 * @throws {TypeError} 输入含非 JSON 值、非有限数、循环引用，或超过深度/节点上限。
 */
export function measureOutput(output) {
  const strings = [];
  const ancestors = new Set();
  let nodeCount = 0;
  let totalCodePoints = 0;
  let totalCodeUnits = 0;

  const visit = (value, path, depth) => {
    nodeCount += 1;
    if (nodeCount > MAX_NODE_COUNT) {
      throw new TypeError(
        `measureOutput: input exceeds the maximum of ${MAX_NODE_COUNT} nodes`,
      );
    }
    if (depth > MAX_DEPTH) {
      throw new TypeError(
        `measureOutput: input exceeds the maximum depth of ${MAX_DEPTH}`,
      );
    }

    if (typeof value === 'string') {
      const unicodeCodePoints = countUnicodeCodePoints(value);
      const utf16CodeUnits = value.length;
      strings.push({ path, unicodeCodePoints, utf16CodeUnits });
      totalCodePoints += unicodeCodePoints;
      totalCodeUnits += utf16CodeUnits;
      return;
    }

    if (value === null || typeof value === 'boolean') {
      return;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new TypeError('measureOutput: input contains a non-finite number');
      }
      return;
    }

    if (typeof value !== 'object') {
      throw new TypeError(
        `measureOutput: input contains a non-JSON value of type ${typeof value}`,
      );
    }

    if (!isJsonContainer(value)) {
      throw new TypeError('measureOutput: input contains a non-JSON object');
    }

    if (ancestors.has(value)) {
      throw new TypeError('measureOutput: input contains a circular reference');
    }

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          visit(value[index], `${path}/${index}`, depth + 1);
        }
      } else {
        const keys = Object.keys(value).sort();
        for (const key of keys) {
          visit(value[key], `${path}/${escapePointerToken(key)}`, depth + 1);
        }
      }
    } finally {
      ancestors.delete(value);
    }
  };

  visit(output, '', 1);

  return {
    countingMethod: COUNTING_METHOD,
    strings,
    totals: {
      unicodeCodePoints: totalCodePoints,
      utf16CodeUnits: totalCodeUnits,
    },
  };
}
