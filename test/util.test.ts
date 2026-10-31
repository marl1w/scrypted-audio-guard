import test from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets, maskUrls, stderrTail } from '../src/util';

test('maskUrls keeps scheme://host:port only', () => {
    assert.equal(maskUrls('open rtsp://admin:pw@10.0.0.9:554/h264?token=x failed'), 'open rtsp://10.0.0.9:554 failed');
});

test('a raw "/" in the password does not leak any part of it', () => {
    for (const f of [maskSecrets, maskUrls]) {
        const out = f('rtsp://admin:pa/ss@cam/x');
        assert.doesNotMatch(out, /pa|ss@|admin/, out);
    }
    assert.equal(maskUrls('rtsp://admin:pa/ss@cam/x'), 'rtsp://cam');
});

test('an extra "@" in the password does not leak any part of it', () => {
    for (const f of [maskSecrets, maskUrls]) {
        const out = f('rtsp://admin:p@ss@cam:554/x');
        assert.doesNotMatch(out, /admin|p@|ss@/, out);
    }
    assert.equal(maskUrls('rtsp://admin:p@ss@cam:554/x'), 'rtsp://cam:554');
    assert.equal(stderrTail('a\nrtsp://u:a/b@c@cam/x: refused'), 'a | rtsp://cam refused');
});

test('maskSecrets masks the whole user info up to the last "@"', () => {
    assert.equal(maskSecrets('rtsp://admin:pa/ss@cam/x'), 'rtsp://***@cam/x');
    assert.equal(maskSecrets('rtsp://admin:p@ss@cam:554/x'), 'rtsp://***@cam:554/x');
});
