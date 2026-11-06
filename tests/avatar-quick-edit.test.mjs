import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(
  new URL('../tavern-plugin/src/client/avatar-quick-edit.js', import.meta.url),
  'utf8'
);
const character = { alias: 'wang_tiqian', name: '王体乾',
  ref: { packId: 'real-pack', figureId: 'figure-1' } };
const calls = [];
const events = new Map();
const windowMock = {
  addEventListener(name, callback) { events.set(name, callback); },
  removeEventListener(name, callback) { if (events.get(name) === callback) events.delete(name); }
};
const store = { get: session => session === 'game-1'
  ? {cardPath: 'cards/example.json', config: {characters: [character]}} : null };
const nav = () => ({
  openLibrary: target => calls.push(['library', target]),
  openTab: target => calls.push(['tab', target])
});
const sandbox = { bubbleStore: store, stageNav: nav };
const handlers = runInNewContext(source + '\n; ({ lookup: bubbleAvatarEditorLookup, install: installBubbleAvatarQuickEdit });', sandbox);

test('valid character alias + exact figure reference resolve to its editor', () => {
  const data = store.get('game-1');
  assert.equal(handlers.lookup(data, 'wang_tiqian', {packId:'real-pack',figureId:'figure-1'}).figureId,'figure-1');
  assert.equal(handlers.lookup(data, '王体乾', {packId:'real-pack',figureId:'figure-1'}),null);
  assert.equal(handlers.lookup(data, 'wang_tiqian', {packId:'other-pack',figureId:'figure-1'}),null);
});

test('quick edit routes only recognized figures, unknown speakers go to stage setup', () => {
  const off = handlers.install(windowMock);
  const send = detail => events.get('dsh-tavern:edit-figure-avatar')({ detail });
  send({sessionId:'game-1',alias:'wang_tiqian',ref:{packId:'real-pack',figureId:'figure-1'}});
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'library');
  assert.equal(calls[0][1].figureId,'figure-1');
  send({sessionId:'game-1',alias:'wang_tiqian',ref:{packId:'malicious-pack',figureId:'figure-1'}});
  assert.equal(calls.length,1);
  send({sessionId:'game-1',alias:'unknown',ref:null});
  assert.equal(calls.length,2);
  assert.equal(calls[1][0],'tab');
  send({sessionId:'other-game',alias:'unknown',ref:null});
  assert.equal(calls.length,2);
  off();
  assert.equal(events.size,0);
});
