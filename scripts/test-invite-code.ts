import assert from 'node:assert/strict'
import { encode } from 'uqr'
import jsQR from 'jsqr'
import { roomCodeFromScan } from '../src/battle/inviteCode'

assert.equal(roomCodeFromScan('https://gto.example.workers.dev/?room=ABCD2345'), 'ABCD2345')
assert.equal(roomCodeFromScan('  https://example.com/path?x=1&room=abcd2345#top '), 'ABCD2345')
assert.equal(roomCodeFromScan('ABCD2345'), 'ABCD2345')
assert.equal(roomCodeFromScan('abcd2345'), 'ABCD2345')
assert.equal(roomCodeFromScan('https://example.com/?room=ABCD1234'), null, '1 is not in the room alphabet')
assert.equal(roomCodeFromScan('https://example.com/'), null)
assert.equal(roomCodeFromScan('javascript:alert(1)?room=ABCD2345'), null)
assert.equal(roomCodeFromScan('hello world'), null)

// Round trip: the invite QR we draw decodes back to the same link.
const link = 'https://gto-trainer.example.workers.dev/?room=K7MPQ2XZ'
const qr = encode(link, { ecc: 'M', border: 2 })
const scale = 6
const width = qr.size * scale
const pixels = new Uint8ClampedArray(width * width * 4)
for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
  const value = qr.data[Math.floor(y / scale)][Math.floor(x / scale)] ? 17 : 255
  pixels.set([value, value, value, 255], (y * width + x) * 4)
}
const decoded = jsQR(pixels, width, width)
assert.equal(decoded?.data, link)
assert.equal(roomCodeFromScan(decoded!.data), 'K7MPQ2XZ')
console.log('Invite QR passed: link and bare-code parsing, rejected payloads, and encode/decode round trip.')
