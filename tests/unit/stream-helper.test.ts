/**
 * 流式处理工具单元测试
 */

import { chunkArray, LruMap } from '../../src/utils/stream-helper';

describe('chunkArray', () => {
  it('应将数组按指定大小分片', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7];
    const chunks = chunkArray(arr, 3);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual([1, 2, 3]);
    expect(chunks[1]).toEqual([4, 5, 6]);
    expect(chunks[2]).toEqual([7]);
  });

  it('应处理空数组', () => {
    expect(chunkArray([], 3)).toEqual([]);
  });

  it('应处理size大于数组长度的情况', () => {
    const arr = [1, 2];
    expect(chunkArray(arr, 10)).toEqual([[1, 2]]);
  });
});

describe('LruMap', () => {
  it('应在超过容量时淘汰最早项', () => {
    const map = new LruMap<string, number>(3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    map.set('d', 4);

    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(true);
    expect(map.has('c')).toBe(true);
    expect(map.has('d')).toBe(true);
  });

  it('应更新已存在键的值而不淘汰', () => {
    const map = new LruMap<string, number>(2);
    map.set('a', 1);
    map.set('b', 2);
    map.set('a', 10);
    map.set('c', 3);

    expect(map.get('a')).toBe(10);
    expect(map.has('b')).toBe(false);
    expect(map.has('c')).toBe(true);
  });
});
