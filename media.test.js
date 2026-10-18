const test = require('node:test');
const assert = require('node:assert/strict');
const { createMedia } = require('./media');

const MB = 1024 * 1024;
const silent = { log() {}, error() {} };
// in-memory storage: files = [{ name, size }] oldest first
function setup(files = [], quota = 100 * MB) {
  const store = { files: [...files], forgotten: [] };
  const media = createMedia({
    quota, log: silent,
    storage: {
      list: async () => store.files,
      remove: async paths => { store.files = store.files.filter(f => !paths.includes(`r1/${f.name}`)); },
      createUploadToken: async () => 'tok',
      signedUrls: async paths => Object.fromEntries(paths.map(p => [p, `https://x/${p}`]))
    },
    forgetPaths: async paths => { store.forgotten.push(...paths); }
  });
  return { store, media };
}
const good = { kind: 'image', mime: 'image/png', size: MB };

test('refuses unknown type, zero and oversized files', async () => {
  const { media } = setup();
  for (const bad of [{ ...good, mime: 'image/gif' }, { ...good, kind: 'text' }, { ...good, size: 0 }, { ...good, size: 26 * MB }, undefined])
    assert.equal((await media.authorizeUpload('r1', bad)).ok, false);
});

test('authorizes a good upload under the Room folder', async () => {
  const { media } = setup();
  const r = await media.authorizeUpload('r1', good);
  assert.ok(r.ok && r.token === 'tok' && /^r1\/[0-9a-f-]{36}\.png$/.test(r.path));
});

test('attach accepts only this Room\'s own uploads', async () => {
  const { media } = setup();
  const { path } = await media.authorizeUpload('r1', good);
  assert.deepEqual(media.attach('r1', { path, kind: 'image', mime: 'image/png', secs: 2.6 }), { path, kind: 'image', mime: 'image/png', secs: 3 });
  assert.equal(media.attach('r2', { path, kind: 'image', mime: 'image/png' }), null);          // another Room's path
  assert.equal(media.attach('r1', { path, kind: 'image', mime: 'image/gif' }), null);          // bad mime
  assert.equal(media.attach('r1', { path: 'r1/../x.png', kind: 'image', mime: 'image/png' }), null);
  assert.equal(media.attach('r1', null), null);
});

test('under 85% of quota deletes nothing', async () => {
  const { media, store } = setup([{ name: 'a.png', size: 50 * MB }]);
  await media.authorizeUpload('r1', good);
  assert.equal(store.files.length, 1);
  assert.deepEqual(store.forgotten, []);
});

test('past 85% deletes oldest first only until back under 70%, and forgets their rows', async () => {
  const files = ['a', 'b', 'c', 'd'].map(n => ({ name: `${n}.png`, size: 22 * MB }));   // 88 MB used
  const { media, store } = setup(files);
  await media.authorizeUpload('r1', good);                  // 88 + 1 > 85 -> drop oldest until 89 - n*22 <= 70: just a
  assert.deepEqual(store.forgotten, ['r1/a.png']);
  assert.deepEqual(store.files.map(f => f.name), ['b.png', 'c.png', 'd.png']);
});

test('sign maps paths to urls and skips the call for none', async () => {
  const { media } = setup();
  assert.deepEqual(await media.sign([]), {});
  assert.deepEqual(await media.sign(['r1/a.png']), { 'r1/a.png': 'https://x/r1/a.png' });
});
