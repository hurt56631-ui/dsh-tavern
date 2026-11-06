import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// The browser fragment is bundled as part of the client factory, so evaluate
// the self-contained pure formatter rather than pretending it is an ES module.
const source = readFileSync(new URL('../tavern-plugin/src/client/features/theater-reading.js', import.meta.url), 'utf8');
const sandbox = {window: {localStorage: new Map()}};
sandbox.window.localStorage.getItem = k => sandbox.window.localStorage.get(k) || null;
sandbox.window.localStorage.setItem = (k,v) => Map.prototype.set.call(sandbox.window.localStorage,k,v);
sandbox.window.localStorage.removeItem = k => Map.prototype.delete.call(sandbox.window.localStorage,k);
const format = runInNewContext(source + '\n; tavernTheaterFormatText;',sandbox);
const parse = runInNewContext(source + '\n; tavernTheaterDialogueLine;',sandbox);
const settings = runInNewContext(source + '\n; tavernTheaterReading;',sandbox);

test('separate speaker dialogue becomes existing bubble format, narration is unchanged', () => {
    const original = '殿门紧闭。\n皇帝：朕再问一遍。\n王体乾：奴婢不敢。\n王体乾伏在地上。';
    assert.equal(format(original), '殿门紧闭。\n@bubble:皇帝|皇帝||[朕再问一遍。]\n@bubble:王体乾|王体乾||[奴婢不敢。]\n王体乾伏在地上。');
    assert.equal(original, '殿门紧闭。\n皇帝：朕再问一遍。\n王体乾：奴婢不敢。\n王体乾伏在地上。');
});

test('accept bold script headings but leave scene descriptions and existing bubble syntax', () => {
    assert.equal(format('**皇帝：** "你说吧。"\n**王体乾**：奴婢明白。\n地点：乾清宫\n@bubble:a|王体乾|joy|[好]'),
        '@bubble:皇帝|皇帝||["你说吧。"]\n@bubble:王体乾|王体乾||[奴婢明白。]\n地点：乾清宫\n@bubble:a|王体乾|joy|[好]');
});

test('preserve fenced code, indentation, title, and Markdown/list markup', () => {
    const text = '~~~js\n皇帝：不可改代码\n~~~\n    皇帝：代码缩进\n# 场景：皇宫\n> 皇帝：引用\n- 皇帝：列表';
    assert.equal(format(text),text);
    assert.equal(format('```\n皇帝：否\n```\n皇帝：是'),
        '```\n皇帝：否\n```\n@bubble:皇帝|皇帝||[是]');
});

test('reject protocol delimiters, unsupported markup, and suspicious labels', () => {
    assert.equal(parse('皇帝：一个[复杂]台词'),null);
    assert.equal(parse('魏忠贤：<img src=x>'),null);
    assert.equal(parse('时间：正午'),null);
    assert.equal(parse('NPC1：你好')?.name,'NPC1');
});

test('reading toggle stays isolated between games and can be reverted', () => {
    assert.equal(settings.get('game-a'),false);
    settings.set('game-a',true);
    assert.equal(settings.get('game-a'),true);
    assert.equal(settings.get('game-b'),false);
    assert.equal(sandbox.window.localStorage.getItem('dsh-tavern-theater-v1/game-a'),'screenplay');
    settings.set('game-a',false);
    assert.equal(settings.get('game-a'),false);
});
